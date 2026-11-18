import { expect, test, type Page } from '@playwright/test';
import { addTextClip, openDemo } from './_stage';

/**
 * 预览渲染缓存：右键片段手工烘一段 + 时间轴的缓存条读数。
 *
 * 判据用 `appState.cacheStrip()` 而不是截图：那条 3px 的线段**颜色**不是可靠
 * 断言（主题、dpr、抗锯齿都在动它），而「有没有一段被标成 cached、范围对不对」
 * 是机制量 —— 画错颜色是渲染层的事，画错范围是这个功能的事。
 */

/**
 * OPFS 子目录名：**每个用例一份，互不污染**。
 *
 * 同一个 origin 下的 OPFS 是共享的（Playwright 的 context 隔离不到它）：所有用例
 * 共用一个目录时，前一个用例烘出来的条目会出现在后一个用例的索引里 —— 而两个
 * 用例的工程内容不同，签名的语义就变成「到底该删还是该信」，失败信息还完全
 * 指不到这里（实测就是这条 spec 的偶发红）。
 */
let dirSeq = 0;
const RUN = Date.now().toString(36);
function freshDir(): string {
  dirSeq += 1;
  return `e2e-preview-cache-${RUN}-${dirSeq}`;
}

async function boot(page: Page): Promise<void> {
  await page.setViewportSize({ width: 1600, height: 900 });
  await page.goto('/');
  await page.waitForFunction(() => (window as never as { __artmatic?: unknown }).__artmatic);
  await openDemo(page);
  /*
   * **必须接一个真目录**：缓存的语义是「烘成文件落在工程目录里」，没有目录就
   * 什么都不写。少了这一步，本 spec 的三条用例全都会落在
   * `test.skip('没有磁盘目录')` 上——绿得毫无信息（踩过）。
   */
  await page.evaluate(
    (d) => (window as never as { __artmatic: Hooks }).__artmatic.project.useOpfs(d),
    freshDir(),
  );
}

interface Hooks {
  project: { useOpfs: (name: string) => Promise<string> };
  appState: {
    projectDir: unknown;
    previewCache: boolean;
    previewRestoreOnPause: boolean;
    /** 播放头（秒）。缓存的前瞻队列按它定起点，直接调 `draw` 前要先设。 */
    playT: number;
    playing: boolean;
    play: () => void;
    pause: () => void;
    seek: (t: number) => void;
    setPreviewScale: (v: number) => void;
    setPreviewCache: (on: boolean) => void;
    /** 三态互斥：`ready`（可预览）/ `encoding`（正在烘）/ `missing`（没缓存）。 */
    cacheStrip: () => { from: number; to: number; state: 'ready' | 'encoding' | 'missing' }[];
    encodeClipCache: (id: string) => Promise<void>;
    previewCacheCtl: {
      prime: (t: number) => Promise<void>;
      draw: (renderer: unknown, t: number) => boolean;
      /** 拖动时的那条路（随机访问解码 + 铺上一帧）。 */
      scrubbing: (renderer: unknown, t: number) => boolean;
      coverage: () => { from: number; to: number; bytes: number }[];
      encodeRange: (from: number, to: number) => Promise<void>;
      /** 只给用例读：随机访问取一帧（`decodeAt`）。 */
      player: { decodeAt: (t: number) => Promise<{ tex: WebGLTexture } | null> } | null;
    };
  };
  renderer: { kit: { w: number; h: number } };
  store: { project: { fps: number; tracks: { clips: { id: string; start: number; end: number }[] }[] } };
}

/** 读画布（= 预览缓冲）尺寸。 */
async function canvasSize(page: Page): Promise<{ w: number; h: number }> {
  return page.evaluate(() => {
    const k = (window as never as { __artmatic: Hooks }).__artmatic.renderer.kit;
    return { w: k.w, h: k.h };
  });
}

/** 等画布尺寸稳定到「不再是刚才那个」为止（档位是 tick 里推给 renderer 的）。 */
async function waitCanvasChanged(page: Page, from: { w: number; h: number }): Promise<{ w: number; h: number }> {
  await page.waitForFunction(
    (prev) => {
      const k = (window as never as { __artmatic: Hooks }).__artmatic.renderer.kit;
      return k.w !== prev.w || k.h !== prev.h;
    },
    from,
    { timeout: 5000 },
  );
  return canvasSize(page);
}

/**
 * 把片段拉长到至少 `sec` 秒。
 *
 * 短片段的烘焙不到一秒就结束，而「烘焙期间预览是否还在画」「缓存帧与精确帧的
 * 差」这两条都要在**烘焙进行中**取样 —— 不拉长的话采样窗口常常落在烘焙结束之后，
 * 用例变成空转（第一版就这么写坏过）。
 */
async function extendClip(page: Page, clipId: string, sec: number): Promise<void> {
  await page.evaluate(
    ({ id, sec }) => {
      const A = (window as never as {
        __artmatic: { store: { commit: (l: string, fn: (p: unknown) => void) => void } };
      }).__artmatic;
      A.store.commit('e2e: 拉长片段', (p) => {
        const proj = p as { tracks: { clips: { id: string; start: number; end: number }[] }[] };
        for (const t of proj.tracks) {
          for (const c of t.clips) if (c.id === id) c.end = Math.max(c.end, c.start + sec);
        }
      });
    },
    { id: clipId, sec },
  );
}

/**
 * 已**落盘**的缓存区间。
 *
 * 不要拿 `cacheStrip()` 里 state==='cached' 的段当「烘完了」的判据：那条线上还
 * 叠着**正在烘的进度**（用户要看虚线实时变长），所以它比落盘早出现。
 */
async function storedCoverage(page: Page): Promise<{ from: number; to: number; bytes: number }[]> {
  return page.evaluate(
    () => (window as never as { __artmatic: Hooks }).__artmatic.appState.previewCacheCtl.coverage(),
  );
}

/** 「这个尺寸问 H.264 编码器，四档里有没有一档能用」。 */
async function h264Accepts(page: Page, w: number, h: number): Promise<boolean> {
  return page.evaluate(
    async ({ w, h }) => {
      for (const codec of ['avc1.4d0028', 'avc1.4d401f', 'avc1.42e028', 'avc1.42e01e']) {
        const res = await VideoEncoder.isConfigSupported({
          codec,
          width: w,
          height: h,
          framerate: 60,
          bitrate: 2_000_000,
          avc: { format: 'avc' },
        } as VideoEncoderConfig);
        if (res.supported) return true;
      }
      return false;
    },
    { w, h },
  );
}

test('右键片段 → 渲染缓存：跑完出现一段覆盖该片段的绿色区间', async ({ page }) => {
  await boot(page);
  const clipId = await addTextClip(page);

  // 没有工程目录就没有地方落盘。`boot` 一定接上了 OPFS，所以这里**断言**而不是 skip。
  const hasDir = await page.evaluate(
    () => (window as never as { __artmatic: Hooks }).__artmatic.appState.projectDir !== null,
  );
  expect(hasDir, '工程没有磁盘目录：缓存无处可放').toBe(true);

  const clip = await page.evaluate((id) => {
    const A = (window as never as { __artmatic: Hooks }).__artmatic;
    const c = A.store.project.tracks.flatMap((t) => t.clips).find((x) => x.id === id)!;
    return { start: c.start, end: c.end, fps: A.store.project.fps };
  }, clipId);

  await page.locator(`[data-testid=clip][data-clip-id="${clipId}"]`).click({ button: 'right' });
  await expect(page.getByTestId('ctx-render-cache')).toBeVisible();
  await page.getByTestId('ctx-render-cache').click();

  // 编码一段几秒的片段要几秒（预览尺寸下 ≈0.7–1× 实时）。
  await expect.poll(() => storedCoverage(page), { timeout: 90_000 }).not.toEqual([]);

  const segs = await page.evaluate(() => {
    const A = (window as never as { __artmatic: Hooks }).__artmatic;
    return A.appState.cacheStrip();
  });
  const ready = segs.filter((s) => s.state === 'ready');
  const from = Math.floor(clip.start * clip.fps);
  const to = Math.ceil(clip.end * clip.fps);
  // 范围必须罩住整个片段（允许比片段宽：自动烘焙是按整段镜头切的）。
  expect(ready.some((s) => s.from <= from && s.to >= to)).toBe(true);
  // 三态互斥且铺满：这一段之外必然还有 `missing`（demo 里别的镜头没烘）。
  expect(segs.some((s) => s.state === 'missing')).toBe(true);
  expect(segs.every((s) => s.state === 'ready' || s.state === 'encoding' || s.state === 'missing')).toBe(true);
});

/*
 * 这只 bug 的形态：**预览缓冲是奇数宽高时，四档 H.264 全部 `isConfigSupported: false`**，
 * 于是整台机器上都被报成「no usable H.264 encoder」（而导出用工程分辨率，通常偶数，
 * 照样能导 —— 因果完全对不上）。
 *
 * 修法是**缓冲尺寸取偶**（`core/dims.ts`）：离屏烘焙按 `kit.w/h` 建目标，
 * 所以只要缓冲是偶数，编码器就一定问得到能用的档位。这条用例守两件事：
 *   1. 降质档位（×0.75 时 `round()` 往往落成奇数）取偶之后仍是偶数；
 *   2. 这个尺寸问编码器确实能用 —— 奇数尺寸不能（机理自证）；
 *   3. 在这个非全质的尺寸下真能烘出一段缓存。
 */
test('预览缓冲恒为偶数宽高（H.264 只吃偶数），降质档位下照样能烘', async ({ page }) => {
  await boot(page);
  const clipId = await addTextClip(page);

  const hasDir = await page.evaluate(
    () => (window as never as { __artmatic: Hooks }).__artmatic.appState.projectDir !== null,
  );
  expect(hasDir, '工程没有磁盘目录：缓存无处可放').toBe(true);

  const base = await canvasSize(page);
  expect(base.w % 2, `全质缓冲也必须是偶数：${base.w}×${base.h}`).toBe(0);
  expect(base.h % 2).toBe(0);

  // 「暂停时回全质」会把档位收回到 1，所以先关掉它，否则档位根本不生效。
  await page.evaluate(() => {
    (window as never as { __artmatic: Hooks }).__artmatic.appState.previewRestoreOnPause = false;
  });
  // 0.75 档：`round(878 × 0.75) = 659`，正是原来那个 bug 的触发条件。
  const rawW = Math.round(base.w * 0.75);
  const rawH = Math.round(base.h * 0.75);
  await page.evaluate(() => {
    (window as never as { __artmatic: Hooks }).__artmatic.appState.setPreviewScale(0.75);
  });
  const scaled = await waitCanvasChanged(page, base);
  expect(scaled.w % 2, `降质档位的缓冲必须取偶：${scaled.w}×${scaled.h}`).toBe(0);
  expect(scaled.h % 2).toBe(0);
  expect(scaled.w).toBeLessThanOrEqual(rawW);

  // 机理自证：**奇数**尺寸问编码器一档都不支持（缓存必须自己避开它）。
  if (rawW % 2 === 1 || rawH % 2 === 1) {
    expect(
      await h264Accepts(page, rawW, rawH),
      `H.264 开始接受奇数宽高了（${rawW}×${rawH}）：这条守卫的前提变了`,
    ).toBe(false);
  }
  expect(await h264Accepts(page, scaled.w, scaled.h), '取偶后的尺寸必须至少有一档可用').toBe(true);

  const clip = await page.evaluate((id) => {
    const A = (window as never as { __artmatic: Hooks }).__artmatic;
    const c = A.store.project.tracks.flatMap((t) => t.clips).find((x) => x.id === id)!;
    return { start: c.start, end: c.end, fps: A.store.project.fps };
  }, clipId);

  await page.evaluate(
    (id) => (window as never as { __artmatic: Hooks }).__artmatic.appState.encodeClipCache(id),
    clipId,
  );

  await expect.poll(() => storedCoverage(page), { timeout: 90_000 }).not.toEqual([]);

  const segs = await page.evaluate(() =>
    (window as never as { __artmatic: Hooks }).__artmatic.appState.cacheStrip(),
  );
  const from = Math.floor(clip.start * clip.fps);
  const to = Math.ceil(clip.end * clip.fps);
  expect(segs.filter((s) => s.state === 'ready').some((s) => s.from <= from && s.to >= to)).toBe(true);
});

/*
 * 缓存播放**必须真的跳过合成**。
 *
 * 这只 bug 的形态：命中判定按「时间戳精确等于本帧」写，而播放头按音频钟走、
 * 每 tick 前进 1–2 帧，于是队列经常整体偏一帧 → 大量帧掉回 `renderFrame`，
 * 缓存开了等于没开（用户体感：「帧率提升微乎其微」）。
 *
 * 判据是**比例**而不是绝对帧数：一段烘好的区间里播放 1.5 s，`draw` 命中率
 * 应 ≥ 85%（第一帧要填队列，允许漏）。
 */
test('播放缓存区间时合成被跳过（命中率 ≥ 85%）', async ({ page }) => {
  await boot(page);
  const clipId = await addTextClip(page);
  await extendClip(page, clipId, 2);

  const clip = await page.evaluate((id) => {
    const A = (window as never as { __artmatic: Hooks }).__artmatic;
    const c = A.store.project.tracks.flatMap((t) => t.clips).find((x) => x.id === id)!;
    return { start: c.start, end: c.end, fps: A.store.project.fps };
  }, clipId);

  await page.evaluate((id) => (window as never as { __artmatic: Hooks }).__artmatic.appState.encodeClipCache(id), clipId);
  await expect.poll(() => storedCoverage(page), { timeout: 90_000 }).not.toEqual([]);

  await page.evaluate(() => {
    const A = (window as never as { __artmatic: Hooks & { renderer: { renderFrame: (...a: unknown[]) => void } } })
      .__artmatic;
    const w = window as never as { __pm: { draws: number; hits: number; renders: number } };
    w.__pm = { draws: 0, hits: 0, renders: 0 };
    const ctl = A.appState.previewCacheCtl;
    const origDraw = ctl.draw.bind(ctl);
    ctl.draw = (r, t) => {
      const hit = origDraw(r, t);
      if (A.appState.playing) {
        w.__pm.draws += 1;
        if (hit) w.__pm.hits += 1;
      }
      return hit;
    };
    const origRender = A.renderer.renderFrame.bind(A.renderer);
    A.renderer.renderFrame = (...a: unknown[]) => {
      if (A.appState.playing) w.__pm.renders += 1;
      return origRender(...a);
    };
  });

  // 落在缓存区间正中，避开两端与切片边界。
  const t = (clip.start + clip.end) / 2;
  await page.evaluate((tt) => (window as never as { __artmatic: Hooks }).__artmatic.appState.seek(tt), t);
  await page.waitForTimeout(400);
  await page.evaluate(() => {
    (window as never as { __pm: unknown }).__pm = { draws: 0, hits: 0, renders: 0 };
    void (window as never as { __artmatic: Hooks }).__artmatic.appState.play();
  });
  await page.waitForTimeout(1500);
  const m = await page.evaluate(() => {
    const A = (window as never as { __artmatic: Hooks }).__artmatic;
    A.appState.pause();
    return (window as never as { __pm: { draws: number; hits: number; renders: number } }).__pm;
  });

  expect(m.draws, '播放期间一次命中判定都没发生').toBeGreaterThan(10);
  const rate = m.hits / m.draws;
  expect(rate, `命中率 ${(rate * 100).toFixed(0)}%（${m.hits}/${m.draws}），合成没被跳过`).toBeGreaterThanOrEqual(0.85);
  /*
   * **一次都不该回精确合成**：队列一时没货时控制器会重复上一帧（见文件头第 3 条）。
   * 只允许开头那 1–2 帧（播放器还没打开，没有可重复的帧）。
   */
  expect(m.renders, `播放期间仍然走了 ${m.renders} 次精确渲染`).toBeLessThanOrEqual(2);
});

/*
 * 烘焙**不许占用预览**：它渲进离屏目标（`render/bake-surface.ts`），所以
 * 烘焙期间预览循环照常每帧渲染。
 *
 * 判据用「`renderFrame` 的调用次数」而不是截图：截图会被编码器正在写的东西干扰，
 * 而「预览这一帧到底有没有被画」就是这个功能要守的东西。
 */
test('烘焙期间预览仍在逐帧渲染（不许冻结画面）', async ({ page }) => {
  await boot(page);
  const clipId = await addTextClip(page);

  await extendClip(page, clipId, 2);

  await page.evaluate(() => {
    const A = (window as never as { __artmatic: Hooks & { renderer: { renderFrame: (...a: unknown[]) => void } } })
      .__artmatic;
    const w = window as never as { __frames: number };
    w.__frames = 0;
    const orig = A.renderer.renderFrame.bind(A.renderer);
    A.renderer.renderFrame = (...a: unknown[]) => {
      w.__frames += 1;
      orig(...a);
    };
  });

  // 不 await：要**在烘焙进行中**采样。
  await page.evaluate((id) => {
    void (window as never as { __artmatic: Hooks }).__artmatic.appState.encodeClipCache(id);
  }, clipId);

  await expect
    .poll(
      () =>
        page.evaluate(() =>
          (window as never as { __artmatic: Hooks }).__artmatic.appState
            .cacheStrip()
            .some((s) => s.state === 'encoding'),
        ),
      { timeout: 20_000 },
    )
    .toBe(true);

  const sample = await page.evaluate(async () => {
    const A = (window as never as { __artmatic: Hooks }).__artmatic;
    const w = window as never as { __frames: number };
    const start = w.__frames;
    let sawEncoding = false;
    const t0 = performance.now();
    while (performance.now() - t0 < 500) {
      await new Promise((r) => setTimeout(r, 40));
      if (A.appState.cacheStrip().some((s) => s.state === 'encoding')) sawEncoding = true;
    }
    return { grew: w.__frames - start, sawEncoding };
  });

  // 采样期间必须真的在烘 —— 否则这条用例什么都没测到。
  expect(sample.sawEncoding, '采样期间烘焙已经结束了：把片段再拉长一点').toBe(true);
  // 500 ms 里 240 Hz 屏约 120 帧、60 Hz 约 30 帧；冻结时是 0。
  expect(sample.grew, '烘焙期间预览一帧都没画：又变回「占着渲染器」了').toBeGreaterThan(15);
});

/*
 * 烘焙产物必须是**同一张画面**：离屏目标 + 回读 + 内存样本这条路最容易出的两种
 * 静默错误是「上下颠倒」（`readPixels` 是自下而上）与「尺寸/通道错位」——
 * 两者都能编码成功、都能正常播放，只有逐帧比色才看得出来。
 *
 * 判据用**整帧均值 + 上下两半均值**，不用逐像素相等：H.264 有损，像素级必然有差。
 */
test('缓存帧与精确渲染同源：颜色对得上、上下没翻', async ({ page }) => {
  await boot(page);
  const clipId = await addTextClip(page);
  await extendClip(page, clipId, 2);

  const hasDir = await page.evaluate(
    () => (window as never as { __artmatic: Hooks }).__artmatic.appState.projectDir !== null,
  );
  expect(hasDir, '工程没有磁盘目录：缓存无处可放').toBe(true);

  const clip = await page.evaluate((id) => {
    const A = (window as never as { __artmatic: Hooks }).__artmatic;
    const c = A.store.project.tracks.flatMap((t) => t.clips).find((x) => x.id === id)!;
    return { start: c.start, end: c.end, fps: A.store.project.fps };
  }, clipId);

  await page.evaluate((id) => (window as never as { __artmatic: Hooks }).__artmatic.appState.encodeClipCache(id), clipId);

  const mid = (clip.start + clip.end) / 2;
  const t = Math.round(mid * clip.fps) / clip.fps;

  const res = await page.evaluate(async (tt) => {
    const A = (window as never as {
      __artmatic: Hooks & {
        renderer: {
          onSeek: () => void;
          renderFrame: (p: unknown, t: number) => void;
          blitTexture: (tex: WebGLTexture) => void;
        };
        readPixels: () => { data: number[]; w: number; h: number };
      };
    }).__artmatic;
    const project = (A as never as { store: { project: unknown } }).store.project;

    const stats = (): { mean: number; upper: number; lower: number } => {
      const { data, w, h } = A.readPixels();
      let sum = 0;
      let upper = 0;
      let upperN = 0;
      let lower = 0;
      let lowerN = 0;
      for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
          const i = (y * w + x) * 4;
          const v = (data[i]! + data[i + 1]! + data[i + 2]!) / 3;
          sum += v;
          // 行序是 GL 的（自下而上），但两边同一口径，翻没翻看的是**差的方向**。
          if (y > h * 0.66) {
            upper += v;
            upperN += 1;
          } else if (y < h * 0.33) {
            lower += v;
            lowerN += 1;
          }
        }
      }
      return { mean: sum / (w * h), upper: upper / Math.max(1, upperN), lower: lower / Math.max(1, lowerN) };
    };

    A.renderer.onSeek();
    // 反馈类特效要几帧才稳定（与 `_stage.ts::settle` 同一条理由）。
    for (let k = 0; k < 6; k++) A.renderer.renderFrame(project, tt);
    const exact = stats();

    /*
     * 走缓存：**随机访问**取「正好这一帧」（`decodeAt` = 拖动用的那条路）。
     *
     * 不用 `draw()` + 轮询队列：那会连带测到「播放器开得够不够快」，跑整套 spec
     * 时偶发红，而这条用例要问的是「烘出来的画面和精确渲染是不是同一张」。
     */
    A.appState.playT = tt;
    const ctl = A.appState.previewCacheCtl;
    await ctl.prime(tt);
    let tex = null;
    for (let k = 0; k < 100 && !tex; k++) {
      tex = (await ctl.player?.decodeAt(tt)) ?? null;
      if (!tex) await new Promise((r) => setTimeout(r, 50));
    }
    if (tex) A.renderer.blitTexture(tex.tex);
    const hit = Boolean(tex);
    const cached = stats();
    return { exact, cached, hit };
  }, t);

  expect(res.hit, '缓存没有命中：先确认这一片真的烘好了').toBe(true);
  expect(Math.abs(res.cached.mean - res.exact.mean), `整帧均值 ${res.exact.mean} vs ${res.cached.mean}`).toBeLessThan(3);
  const dExact = res.exact.upper - res.exact.lower;
  const dCached = res.cached.upper - res.cached.lower;
  if (Math.abs(dExact) > 5) {
    expect(Math.sign(dCached), `上下两半的亮度关系反了：${dExact} vs ${dCached}（画面翻转过？）`).toBe(
      Math.sign(dExact),
    );
  }
});

/**
 * 在**空舞台**上摆两段纯色片段：`[0, atA)` 与 `[far, far + farLen)`。
 *
 * 关掉 demo 的全部轨道（它的片段铺满整条时间轴，会把我摆的两段并进同一个
 * 计划区间里，让「远处」不复存在）。
 */
async function twoIslands(page: Page, atA: number, far: number, farLen: number): Promise<void> {
  await page.evaluate(
    ({ atA, far, farLen }) => {
      const A = (window as never as {
        __artmatic: {
          store: {
            commit: (l: string, fn: (p: unknown) => void) => void;
            addTrack: (kind: 'visual', name?: string) => string;
            addClip: (trackId: string, clip: unknown) => void;
          };
        };
      }).__artmatic;
      A.store.commit('e2e: 清空舞台', (p) => {
        const proj = p as { tracks: { enabled: boolean }[] };
        for (const t of proj.tracks) t.enabled = false;
      });
      const base = {
        fadeSec: 0,
        curves: {},
        transform: { x: 0.5, y: 0.5, sx: 1, sy: 1, rot: 0 },
        fit: 'stretch',
        blend: 'normal',
        opacity: 1,
      };
      for (const [id, start, end, color] of [
        ['e2e-a', 0, atA, '#ff0000'],
        ['e2e-far', far, far + farLen, '#0000ff'],
      ] as const) {
        const track = A.store.addTrack('visual', id);
        A.store.addClip(track, {
          ...base,
          kind: 'source',
          id,
          start,
          end,
          label: id,
          source: { type: 'solid', color },
        });
      }
    },
    { atA, far, farLen },
  );
}

/** 改某个片段的 `label`（一个只在**那一段**的签名里出现的字段）。 */
async function relabel(page: Page, clipId: string, label: string): Promise<void> {
  await page.evaluate(
    ({ clipId, label }) => {
      const A = (window as never as {
        __artmatic: {
          store: {
            commit: (l: string, fn: (p: unknown) => void) => void;
          };
        };
      }).__artmatic;
      A.store.commit('e2e: 改标签', (p) => {
        const proj = p as { tracks: { clips: { id: string; label: string }[] }[] };
        for (const t of proj.tracks) for (const c of t.clips) if (c.id === clipId) c.label = label;
      });
    },
    { clipId, label },
  );
}

/*
 * 用户报的那个「开玩笑吧」的形态：在 50 s 处改一个片段，0–20 s 那一段的缓存
 * 也被整个扔掉。修法是**每段各自的内容签名**（`core/preview-cache.ts::rangeSignature`）。
 * 这条用例同时守两边：远处改不动、段内改必须动。
 */
test('改远处的片段不作废这一段的缓存；改段内必须作废', async ({ page }) => {
  await boot(page);
  await twoIslands(page, 4, 16, 4);

  // 只烘 0–4 s 那一段（[0,120)）。
  await page.evaluate(() =>
    (window as never as { __artmatic: Hooks }).__artmatic.appState.previewCacheCtl.encodeRange(0, 120),
  );
  expect(await storedCoverage(page)).toHaveLength(1);

  // 远处（16 s 起）改一个片段：这一段一个像素都没变，缓存必须留着。
  await relabel(page, 'e2e-far', '改过了');
  await page.waitForTimeout(300);
  const afterFar = await storedCoverage(page);
  expect(afterFar.map((c) => `${c.from}-${c.to}`)).toEqual(['0-120']);

  // 段内改：这一次必须作废（`coverage()` 只吐**仍然有效**的条目）。
  await relabel(page, 'e2e-a', '段内改过');
  await page.waitForTimeout(300);
  expect(await storedCoverage(page)).toEqual([]);
});

/*
 * 拖动播放头也要走缓存（用户明确要求：拖动是定位，不是审片）。
 * 判据：`seek()` 之后 250 ms 内**一次精确渲染都不该发生**，停手之后恰好一次。
 */
test('拖动播放头时用缓存画，停手后才精确渲染一次', async ({ page }) => {
  await boot(page);
  await twoIslands(page, 4, 16, 4);
  await page.evaluate(() =>
    (window as never as { __artmatic: Hooks }).__artmatic.appState.previewCacheCtl.encodeRange(0, 120),
  );
  expect(await storedCoverage(page)).toHaveLength(1);

  /*
   * 先热身：反复调一次 `scrubbing()` 直到它能给出画面（它自己会开播放器、排解码）。
   * 判定要测的是「拖动时用缓存」，不是「第一次拖动时还没解码」。
   */
  await page.evaluate(() => (window as never as { __artmatic: Hooks }).__artmatic.appState.previewCacheCtl.prime(2));
  await expect
    .poll(
      () =>
        page.evaluate(() =>
          (window as never as { __artmatic: Hooks }).__artmatic.appState.previewCacheCtl.scrubbing(
            (window as never as { __artmatic: Hooks }).__artmatic.renderer,
            2,
          ),
        ),
      { timeout: 15_000 },
    )
    .toBe(true);

  await page.evaluate(() => {
    const A = (window as never as { __artmatic: Hooks & { renderer: { renderFrame: (...a: unknown[]) => void } } })
      .__artmatic;
    const w = window as never as { __renders: number };
    w.__renders = 0;
    const orig = A.renderer.renderFrame.bind(A.renderer);
    A.renderer.renderFrame = (...a: unknown[]) => {
      w.__renders += 1;
      orig(...a);
    };
    // 复位与拖动必须在**同一个任务**里：中间插一帧 rAF 的话，那一帧是正常的
    // 「暂停精确渲染」，会被算进拖动窗口（实测就是那 1 次）。
    (window as never as { __artmatic: Hooks }).__artmatic.appState.seek(2);
  });
  await page.waitForTimeout(150);
  const during = await page.evaluate(() => (window as never as { __renders: number }).__renders);
  expect(during, '拖动窗口内走了精确合成（应该用缓存）').toBe(0);

  // 停手：拖动窗口结束后必须补一次锐利的定格。
  await page.waitForTimeout(400);
  const after = await page.evaluate(() => (window as never as { __renders: number }).__renders);
  expect(after, '停手后没有精确渲染，画面会一直留着缓存那帧').toBeGreaterThan(0);
});

test('关掉缓存后时间轴不再有缓存条', async ({ page }) => {
  await boot(page);
  await page.evaluate(() => {
    (window as never as { __artmatic: Hooks }).__artmatic.appState.setPreviewCache(false);
  });
  const segs = await page.evaluate(() =>
    (window as never as { __artmatic: Hooks }).__artmatic.appState.cacheStrip(),
  );
  expect(segs).toEqual([]);
});
