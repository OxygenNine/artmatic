import { expect, test, type Page } from '@playwright/test';
import { addTextClip, openDemo } from './_stage';

/**
 * 镜头关键帧：面板常驻 + 真的跟着时间动。
 *
 * 四层判据，各钉一个会被写错的语义：
 *
 * 1. **「镜头」行常驻**：没打过任何关键帧时，元素列里也有它，属性列有全部四条
 *    通道（空轨道桩，不落库）。少了这条，用户永远找不到「怎么给镜头上关键帧」。
 * 2. **加帧落库**：双击轨道空白 → 文档里出现一条 `camera.zoom` 轨道。
 * 3. **求值吃到时间**：同一份文档在两个时刻光栅化出不同墨迹（镜头是 JS 采样，
 *    不是 CSS 动画，这条是它唯一的像素证据）。
 * 4. **舞台跟着动 + 自动关键帧**：调浮层时，有关键帧的通道写的是**播放头那一帧**，
 *    于是两个时刻的画面不同 —— 只改基准值的话浮层会「改了没反应」。
 */

interface Hooks {
  store: {
    project: { tracks: { clips: { id: string; source?: { type?: string; doc?: Record<string, unknown> } }[] }[] };
  };
  typoRasterize: (
    doc: unknown,
    w: number,
    h: number,
    localSec: number,
  ) => Promise<{ ink: number; hash: string }>;
}

async function boot(page: Page): Promise<void> {
  await page.setViewportSize({ width: 1920, height: 900 });
  await page.goto('/');
  await page.waitForFunction(() => (window as never as { __artmatic?: unknown }).__artmatic);
  await openDemo(page);
}

async function openEditor(page: Page, clipId: string): Promise<void> {
  await page.locator(`[data-testid=clip][data-clip-id="${clipId}"]`).dblclick();
  await expect(page.getByTestId('typo-editor')).toBeVisible();
}

function readDoc(page: Page, clipId: string) {
  return page.evaluate((id) => {
    const A = (window as never as { __artmatic: Hooks }).__artmatic;
    for (const t of A.store.project.tracks) {
      for (const c of t.clips) if (c.id === id) return c.source?.doc ?? null;
    }
    return null;
  }, clipId);
}

/** 元素外壳（第一个）的屏幕宽高。 */
async function shellWidth(page: Page): Promise<number> {
  return page.evaluate(() => {
    const el = document.querySelector<HTMLElement>('.paper [data-el-id]');
    return el ? el.getBoundingClientRect().width : 0;
  });
}

/** 点关键帧面板的「镜头」行，返回四条通道的标签。 */
async function selectCameraRow(page: Page): Promise<string[]> {
  await page.locator('[data-testid=typo-kf-el][data-el=camera]').click();
  const rows = page.getByTestId('typo-kf-track');
  await expect(rows).toHaveCount(4);
  return rows.locator('.nm').allInnerTexts();
}

/** 点标尺把播放头拖到片段的 `frac` 处（0..1）。 */
async function seekTo(page: Page, frac: number): Promise<void> {
  const box = (await page.getByTestId('typo-kf-ruler').boundingBox())!;
  await page.mouse.click(box.x + box.width * frac, box.y + box.height / 2);
}

test('「镜头」行常驻：没打过关键帧也有它和四条通道', async ({ page }) => {
  await boot(page);
  const clipId = await addTextClip(page);
  await openEditor(page, clipId);

  const labels = await selectCameraRow(page);
  expect(labels).toEqual(['平移 X', '平移 Y', '缩放', '旋转']);

  // 常驻 ≠ 落库：一条关键帧都没有时文档里不该多出轨道。
  const doc = (await readDoc(page, clipId)) as { animations?: unknown };
  expect(doc.animations).toBeUndefined();
});

test('双击轨道空白 = 加一帧，写进 camera.zoom', async ({ page }) => {
  await boot(page);
  const clipId = await addTextClip(page);
  await openEditor(page, clipId);
  await selectCameraRow(page);

  // 第三条轨道是「缩放」。
  const lane = (await page.getByTestId('typo-kf-lane').nth(2).boundingBox())!;
  await page.mouse.dblclick(lane.x + lane.width * 0.4, lane.y + lane.height / 2);

  await expect
    .poll(async () => {
      const doc = (await readDoc(page, clipId)) as { animations?: { prop: string; keys: { v: number }[] }[] };
      return doc?.animations?.map((a) => `${a.prop}:${a.keys.length}`);
    })
    .toEqual(['camera.zoom:1']);
});

test('求值吃到时间：同一文档两个时刻的光栅化不同', async ({ page }) => {
  await boot(page);

  const r = await page.evaluate(async () => {
    const A = (window as never as { __artmatic: Hooks }).__artmatic;
    const doc = {
      size: { w: 640, h: 360 },
      background: { kind: 'none' },
      elements: [
        {
          kind: 'shape',
          id: 'sq',
          name: 'sq',
          frame: { x: 220, y: 80, w: 200, h: 200, rot: 0 },
          blend: 'normal',
          opacity: 1,
          visible: true,
          locked: false,
          animations: [],
          shape: 'rect',
          fill: { kind: 'solid', color: '#ffffff' },
          stroke: null,
          depth: 1,
        },
      ],
      fonts: [],
      animations: [
        {
          id: 'cam:zoom',
          kind: 'tracks',
          prop: 'camera.zoom',
          keys: [
            { t: 0, v: 1 },
            { t: 2, v: 2 },
          ],
          delay: 0,
          duration: 2,
          iterations: 1,
          easing: 'linear',
          direction: 'normal',
          fill: 'both',
        },
      ],
    };
    return {
      t0: await A.typoRasterize(doc, 640, 360, 0),
      t1: await A.typoRasterize(doc, 640, 360, 2),
      t2: await A.typoRasterize(doc, 640, 360, 9), // 末帧之后保持
    };
  });

  // 2× 放大后墨迹面积约 3.6 倍（上下被画布裁掉）。
  expect(r.t1.ink).toBeGreaterThan(r.t0.ink * 2);
  // 末帧之后保持不变（不外插）。
  expect(r.t2.hash).toBe(r.t1.hash);
});

/**
 * 回归：**播放时整层消失 / 偶发频闪**。
 *
 * 光栅化是异步的，播放时每一帧都是新键（动画文档的帧号 + 镜头视差），
 * `resolve` 靠 `runtime.latest` 里「同一个桶的上一帧」顶上。桶键是
 * `docHash|WxH|模式盐`（`sizeKeyOf` 跳过帧号）—— 镜头视差若被并进模式盐，
 * 每帧就是一个新桶：回退永远没有可用的上一帧，于是**整层消失**，偶尔异步
 * 赶上了就闪一下；暂停后帧不再变，图落地，画面又正常。
 *
 * 这里直接调 `textRaster.resolve` 断言「换一帧能拿到上一次的图」，
 * 不依赖播放时序（那正是它在真机上偶发的原因）。
 */
test('播放不消失：镜头关键帧换帧时用上一帧顶上（缓存桶跨帧一致）', async ({ page }) => {
  await boot(page);
  const clipId = await addTextClip(page);

  // 用控制平面造「镜头 0→2 + 元素吃满镜头」。面板那条路径由上一个用例覆盖。
  const setup = await page.evaluate(async (id) => {
    const C = (window as never as {
      __artmatic: {
        control: {
          getTypographyDoc: (i: string, d: string) => Promise<{ ok: boolean; data: { elements: { id: string }[] } }>;
          updateTypographyElement: (i: string, e: string, p: unknown) => Promise<{ ok: boolean }>;
          setTypographyCameraAnimation: (i: string, c: string, k: unknown) => Promise<{ ok: boolean }>;
        };
      };
    }).__artmatic.control;
    const view = await C.getTypographyDoc(id, 'ids');
    const el = view.data.elements[0]!;
    const a = await C.updateTypographyElement(id, el.id, { depth: 1 });
    const b = await C.setTypographyCameraAnimation(id, 'zoom', [
      { t: 0, v: 1 },
      { t: 2, v: 2 },
    ]);
    return a.ok && b.ok;
  }, clipId);
  expect(setup).toBe(true);

  const r = await page.evaluate(async (id) => {
    const A = (window as never as {
      __artmatic: {
        store: { project: { fps: number; tracks: { clips: { id: string; start: number }[] }[] } };
        appState: { textRaster: { resolve: (c: unknown, t: number, w: number, h: number) => unknown } };
        typoStats: () => { entries: number };
      };
    }).__artmatic;
    const clip = A.store.project.tracks.flatMap((t) => t.clips).find((c) => c.id === id)!;
    const rt = A.appState.textRaster;
    const t0 = clip.start + 0.2;

    const first = rt.resolve(clip, t0, 800, 450);
    // 等第一张落地（异步光栅化）。
    for (let i = 0; i < 80 && A.typoStats().entries === 0; i++) {
      await new Promise((res) => setTimeout(res, 25));
    }
    const entries = A.typoStats().entries;
    // 下一帧 / 再下一帧：键必然 miss（视差变了），但必须能拿到上一帧的图。
    const second = rt.resolve(clip, t0 + 1 / A.store.project.fps, 800, 450);
    const third = rt.resolve(clip, t0 + 2 / A.store.project.fps, 800, 450);
    return { first: !!first, entries, second: !!second, third: !!third };
  }, clipId);

  expect(r.entries).toBeGreaterThan(0);
  // 第一帧缺席是正常的（还没烘过），重点是**后续帧不许缺席**。
  expect(r.second).toBe(true);
  expect(r.third).toBe(true);
});

test('舞台：有关键帧的通道按播放头求值，浮层改动写的是当前那一帧', async ({ page }) => {
  await boot(page);
  const clipId = await addTextClip(page);
  await openEditor(page, clipId);

  // 元素吃满镜头（深度 100%）。
  await page.getByTestId('typo-layer-row').first().click();
  await page.getByTestId('typo-tab-props').click();
  await page.getByTestId('prop-depth-num').fill('100');
  await page.getByTestId('prop-depth-num').press('Enter');
  await expect
    .poll(async () => ((await readDoc(page, clipId)) as { elements: { depth?: number }[] }).elements[0]?.depth)
    .toBe(1);

  // 基准镜头：2×（此时还没有任何轨道）。
  await page.getByTestId('ribbon-tab-design').click();
  await page.getByTestId('ribbon-camera').click();
  await page.getByTestId('typo-camera-zoom-num').fill('200');
  await page.getByTestId('typo-camera-zoom-num').press('Enter');
  await page.getByTestId('ribbon-camera').click(); // 关浮层
  const zoomed = await shellWidth(page);

  // 在 50% 处给「缩放」打一帧（值 = 当前取景 = 2×）。
  await seekTo(page, 0.5);
  await selectCameraRow(page);
  const lane = (await page.getByTestId('typo-kf-lane').nth(2).boundingBox())!;
  await page.mouse.dblclick(lane.x + (lane.width * 0.5), lane.y + lane.height / 2);
  await expect
    .poll(async () => {
      const doc = (await readDoc(page, clipId)) as { animations?: { keys: unknown[] }[] };
      return doc?.animations?.[0]?.keys.length;
    })
    .toBe(1);

  /*
   * 回到片段起点再把缩放调回 100%：`zoom` 已经有关键帧，所以这一步必须**写成
   * 播放头那一帧**（自动关键帧）。只改基准值时这里什么都看不出来 —— 而用户
   * 会以为浮层坏了。
   */
  await seekTo(page, 0.02);
  await page.getByTestId('ribbon-tab-design').click();
  await page.getByTestId('ribbon-camera').click();
  await page.getByTestId('typo-camera-zoom-num').fill('100');
  await page.getByTestId('typo-camera-zoom-num').press('Enter');
  await page.getByTestId('ribbon-camera').click();

  await expect
    .poll(async () => {
      const doc = (await readDoc(page, clipId)) as { animations?: { keys: { t: number; v: number }[] }[] };
      return doc?.animations?.[0]?.keys.length;
    })
    .toBe(2);
  const near = await shellWidth(page);
  expect(near).toBeLessThan(zoomed * 0.75);

  // 再回到中段：又是 2×（两帧之间有插值）。
  await seekTo(page, 0.5);
  await expect.poll(() => shellWidth(page)).toBeGreaterThan(near * 1.5);
});

/**
 * B2：镜头改在合成器里施加之后，**同一批位图服务整段镜头动画**
 * （`docs/typography-perf.md` §B2）。
 *
 * 判据是机制量，不是帧率：走「烘进位图」那条路时每一帧都是新键 ⇒ 每帧一次捕获；
 * 走合成器那条路位图按景深段烘一次，之后镜头怎么动都不再捕获。
 *
 * 最后一相是**对照**：同一条片段、同一批 t，只把 `playing` 关掉 ⇒ 必须数到捕获。
 * 否则这条用例无法区分「合成器生效」与「查询根本没走到光栅化」。
 */
test('播放时镜头不再逐帧捕获：分段位图烘一次，之后换 t 也不再捕获', async ({ page }) => {
  await boot(page);
  const clipId = await addTextClip(page);

  // 两段景深：原来的文字吃满镜头，新加的底板留在无穷远。
  const setup = await page.evaluate(async (id) => {
    const C = (window as never as {
      __artmatic: {
        control: {
          getTypographyDoc: (i: string, d: string) => Promise<{ ok: boolean; data: { elements: { id: string }[] } }>;
          addTypographyElement: (i: string, e: unknown) => Promise<{ ok: boolean }>;
          updateTypographyElement: (i: string, e: string, p: unknown) => Promise<{ ok: boolean }>;
          setTypographyCameraAnimation: (i: string, c: string, k: unknown) => Promise<{ ok: boolean }>;
        };
      };
    }).__artmatic.control;
    const before = await C.getTypographyDoc(id, 'ids');
    const first = before.data.elements[0]!;
    const added = await C.addTypographyElement(id, { kind: 'text', text: 'BACK' });
    const after = await C.getTypographyDoc(id, 'ids');
    const back = after.data.elements.find((e) => !before.data.elements.some((x) => x.id === e.id))!;
    const a = await C.updateTypographyElement(id, back.id, { depth: 0 });
    const b = await C.updateTypographyElement(id, first.id, { depth: 1 });
    // 拉远 + 摇：这两样才需要画布外留边（推近时放大的内容本来就盖住画面）。
    const c = await C.setTypographyCameraAnimation(id, 'zoom', [
      { t: 0, v: 1 },
      { t: 2, v: 0.85 },
    ]);
    const d = await C.setTypographyCameraAnimation(id, 'x', [
      { t: 0, v: 0 },
      { t: 2, v: 90 },
    ]);
    return a.ok && b.ok && c.ok && d.ok && added.ok;
  }, clipId);
  expect(setup).toBe(true);

  const r = await page.evaluate(async (id) => {
    const A = (window as never as {
      __artmatic: {
        store: { project: { fps: number; tracks: { clips: { id: string; start: number }[] }[] } };
        appState: {
          textRaster: { resolve: (c: unknown, t: number, w: number, h: number) => unknown };
          playing: boolean;
        };
        typoStats: () => { rasters: number; pending: number };
      };
    }).__artmatic;
    const clip = A.store.project.tracks.flatMap((t) => t.clips).find((c) => c.id === id)!;
    const rt = A.appState.textRaster;
    const sleep = (ms: number) => new Promise((res) => setTimeout(res, ms));
    const step = 1 / A.store.project.fps;
    const t0 = clip.start + 0.2;
    type Tex = { layers?: { coverW: number }[]; docW?: number } | null;

    /*
     * 捕获是**串行**的（后端一条链），几张 × 15–30 ms 约 0.5 s；
     * 用「连续两次读数相同」判稳会立刻返回（第一次读发生在任何上传之前）。
     */
    const settle = async () => {
      await sleep(300);
      let prev = -1;
      let stable = 0;
      for (let i = 0; i < 40; i += 1) {
        const now = A.typoStats().rasters;
        if (now === prev) {
          stable += 1;
          if (stable >= 3) return now;
        } else {
          stable = 0;
          prev = now;
        }
        await sleep(150);
      }
      return A.typoStats().rasters;
    };

    A.appState.playing = true;
    try {
      // 第一问：走合成器那条路，两段各排一单（另有 exact 兜底一单）。
      const first = rt.resolve(clip, t0, 800, 450) as Tex;
      const pending = A.typoStats().pending;
      const warm = await settle();
      // 段位图就位之后：换一个时刻仍然返回同一批分段位图。
      const probe = rt.resolve(clip, t0 + step * 5, 800, 450) as Tex;
      const shape = {
        layers: probe?.layers?.length ?? 0,
        overscan: (probe?.layers ?? []).every((l) => l.coverW > (probe?.docW ?? 0)),
        firstWasAbsent: first === null,
      };
      // 播放相：镜头一直在动（每个 t 的视差都不同），但位图已经就位 ⇒ 零捕获。
      for (let i = 0; i < 20; i += 1) rt.resolve(clip, t0 + i * step, 800, 450);
      const live = await settle();

      // 对照相：同一条片段、同一批 t，只把 playing 关掉 ⇒ 必须逐帧捕获。
      A.appState.playing = false;
      for (let i = 0; i < 20; i += 1) {
        rt.resolve(clip, t0 + i * step, 800, 450);
        await sleep(70);
      }
      const exact = await settle();
      return { pending, warm, live, exact, shape };
    } finally {
      A.appState.playing = false;
    }
  }, clipId);

  // 两段各一单 ⇒ 第一次问的时候不该只有一单（只有一单说明还在走烘进位图那条路）。
  expect(r.pending).toBeGreaterThanOrEqual(2);
  // 第一帧缺席是正常的（段位图还没落地），重要的是之后拿到的是**多段**位图。
  expect(r.shape.firstWasAbsent).toBe(true);
  expect(r.shape.layers).toBe(2);
  expect(r.shape.overscan).toBe(true);
  expect(r.warm).toBeGreaterThan(0);
  expect(r.live - r.warm).toBe(0);
  // exact 每帧一个新键（镜头视差 + 帧号），20 帧里至少能烘出十几张。
  expect(r.exact - r.live).toBeGreaterThan(5);
});
