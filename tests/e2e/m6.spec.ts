import { expect, test, type Page } from '@playwright/test';
import { openDemo, buildStage, meanAt, renderTwiceDiff, setTrackEnabled, settle } from './_stage';

/**
 * 收尾这批功能的 E2E：视频素材、image 片段、工程设置、预览降质、rail 一致性。
 *
 * 视频素材**现场编**（`__artmatic.makeTestVideo`）：不往仓库塞二进制，而且这条
 * 路顺带证明了「导出的 MP4 能被自己的解码链路读回来」。
 *
 * 素材内容刻意做成**上下两半不同色、颜色还随时间变**：
 *
 * | 时间 | 上半 | 下半 |
 * |---|---|---|
 * | `[0,1)` | 红 | 蓝 |
 * | `[1,2)` | 绿 | 蓝 |
 *
 * 于是同一份素材能同时验两件容易互相掩盖的事：**取帧跟着 t 走**（红→绿；
 * 纯色视频就算解码器卡在第一帧也照样"通过"）与**上下方向正确**（上下颠倒
 * 会立刻被抓到）。image 那条用同一套「上红下蓝」判据。
 */

async function boot(page: Page): Promise<void> {
  await page.goto('/');
  await page.waitForFunction(() => (window as never as { __artmatic?: unknown }).__artmatic);
  await openDemo(page);
}

/** 清空舞台并建一条空的视觉轨，返回 trackId。 */
async function cleanStage(page: Page): Promise<string> {
  return page.evaluate(() => {
    const A = (window as never as {
      __artmatic: {
        store: {
          addTrack: (kind: 'visual', name?: string) => string;
          commit: (label: string, fn: (p: { tracks: { id: string; enabled: boolean }[] }) => void) => void;
        };
      };
    }).__artmatic;
    A.store.commit('e2e: 清空舞台', (p) => {
      for (const t of p.tracks) t.enabled = false;
    });
    const track = A.store.addTrack('visual', 'E2E');
    A.store.commit('e2e: 只启用新轨', (p) => {
      for (const t of p.tracks) t.enabled = t.id === track;
    });
    return track;
  });
}

/** 等启用轨上出现片段。 */
async function waitForClip(page: Page, timeout = 60_000): Promise<void> {
  await page.waitForFunction(
    () => {
      const A = (window as never as {
        __artmatic: { store: { project: { tracks: { clips: unknown[]; enabled: boolean }[] } } };
      }).__artmatic;
      return A.store.project.tracks.some((t) => t.enabled && t.clips.length > 0);
    },
    undefined,
    { timeout },
  );
  await openDemo(page);
}

type Rgb = [number, number, number];

/** 整帧 + 上下半的三通道均值。`readPixels` 原点在左下 → rows[0..h/2) 是画面**下**半。 */
async function halvesAt(page: Page, t: number): Promise<{ all: Rgb; bottom: Rgb; top: Rgb }> {
  return page.evaluate((tt) => {
    const A = (window as never as {
      __artmatic: {
        renderer: { onSeek: () => void };
        renderFrame: (t: number) => void;
        readPixels: () => { data: number[]; w: number; h: number };
      };
    }).__artmatic;
    A.renderer.onSeek();
    A.renderFrame(tt);
    const { data, w, h } = A.readPixels();
    const region = (y0: number, y1: number): [number, number, number] => {
      const s = [0, 0, 0];
      let n = 0;
      for (let y = y0; y < y1; y += 1) {
        for (let x = 0; x < w; x += 1) {
          const i = (y * w + x) * 4;
          s[0]! += data[i]!;
          s[1]! += data[i + 1]!;
          s[2]! += data[i + 2]!;
          n += 1;
        }
      }
      return [s[0]! / n, s[1]! / n, s[2]! / n] as [number, number, number];
    };
    const mid = Math.floor(h / 2);
    return { all: region(0, h), bottom: region(0, mid), top: region(mid, h) };
  }, t);
}

/**
 * 等到 t 处的帧**真的解出来**为止。
 *
 * 视频是异步就绪的：缺帧时预览会拿「最近的已解码帧」顶上（视频播放器的
 * 常规做法，见 engine/video-source.ts）。所以只渲一次就断言会读到上一帧 ——
 * 那不是 bug，是设计，测试必须等。
 *
 * 判据数据化（`want` 是 'topRed' / 'topGreen'），不在 page 里 eval 字符串。
 */
async function waitFrameAt(page: Page, t: number, want: 'topRed' | 'topGreen'): Promise<boolean> {
  return page
    .waitForFunction(
      ({ t, want }) => {
        const A = (window as never as {
          __artmatic: {
            renderer: { onSeek: () => void };
            renderFrame: (t: number) => void;
            readPixels: () => { data: number[]; w: number; h: number };
          };
        }).__artmatic;
        A.renderer.onSeek();
        A.renderFrame(t);
        const { data, w, h } = A.readPixels();
        const mid = Math.floor(h / 2);
        let tr = 0;
        let tg = 0;
        let tb = 0;
        let br = 0;
        let bb = 0;
        let n = 0;
        for (let y = 0; y < h; y += 1) {
          for (let x = 0; x < w; x += 1) {
            const i = (y * w + x) * 4;
            if (y < mid) {
              br += data[i]!;
              bb += data[i + 2]!;
            } else {
              tr += data[i]!;
              tg += data[i + 1]!;
              tb += data[i + 2]!;
            }
            n += 1;
          }
        }
        const half = n / 2;
        const bottomBlue = bb / half > br / half + 40;
        const topOk = want === 'topRed' ? tr / half > tb / half + 40 : tg / half > tr / half + 40;
        return bottomBlue && topOk;
      },
      { t, want },
      { timeout: 20_000, polling: 250 },
    )
    .then(() => true)
    .catch(() => false);
}

test('视频素材：导入 → 解码 → 取帧跟着 t 走 + 方向正确', async ({ page }) => {
  const errors: string[] = [];
  await boot(page);
  page.on('pageerror', (e) => errors.push(String(e)));

  await cleanStage(page);

  // 1) 现场编一段测试视频
  const bytes = await page.evaluate(async () => {
    const A = (window as never as { __artmatic: { makeTestVideo: () => Promise<number[]> } }).__artmatic;
    return A.makeTestVideo();
  });
  expect(bytes.length).toBeGreaterThan(1000);

  // 2) 走**真实的导入路径**：文件选择器 → 轨道菜单「导入视频」
  const [chooser] = await Promise.all([
    page.waitForEvent('filechooser', { timeout: 15_000 }),
    (async () => {
      await page.locator('[data-testid=track-menu]').last().click();
      await page.getByTestId('import-video').click();
    })(),
  ]);
  await chooser.setFiles({
    name: 'e2e-test.mp4',
    mimeType: 'video/mp4',
    buffer: Buffer.from(bytes),
  });

  await waitForClip(page);
  const clip = await page.evaluate(() => {
    const A = (window as never as {
      __artmatic: {
        store: {
          project: {
            tracks: {
              clips: { id: string; start: number; end: number; source?: { type: string } }[];
              enabled: boolean;
            }[];
            assets: Record<string, { kind: string; durationSec?: number; size?: { w: number; h: number } }>;
          };
        };
      };
    }).__artmatic;
    const c = A.store.project.tracks.flatMap((t) => (t.enabled ? t.clips : []))[0]!;
    const asset = Object.values(A.store.project.assets).find((a) => a.kind === 'video');
    return { start: c.start, end: c.end, src: c.source, asset };
  });

  expect(clip.src?.type).toBe('video');
  expect(clip.asset?.durationSec).toBeGreaterThan(1.5);
  expect(clip.asset?.size).toEqual({ w: 160, h: 90 });
  // 片段默认长度 = 素材时长
  expect(clip.end - clip.start).toBeGreaterThan(1.5);

  // 3) 取帧跟着 t 走 + 方向正确（两者共用一个判据，见文件头）
  expect(await waitFrameAt(page, 0.3, 'topRed'), 't=0.3 应当解出「上红下蓝」').toBe(true);
  expect(await waitFrameAt(page, 1.7, 'topGreen'), 't=1.7 应当解出「上绿下蓝」').toBe(true);

  const early = await halvesAt(page, 0.3);
  const late = await halvesAt(page, 1.7);
  expect(early.top[0], `上半应为红，实测 ${JSON.stringify(early.top)}`).toBeGreaterThan(early.top[2] + 40);
  expect(early.bottom[2], `下半应为蓝，实测 ${JSON.stringify(early.bottom)}`).toBeGreaterThan(
    early.bottom[0] + 40,
  );
  expect(late.top[1], `t=1.7 上半应为绿，实测 ${JSON.stringify(late.top)}`).toBeGreaterThan(late.top[0] + 40);
  expect(late.bottom[2], `t=1.7 下半应为蓝，实测 ${JSON.stringify(late.bottom)}`).toBeGreaterThan(
    late.bottom[0] + 40,
  );

  // 4) 解码真的发生，缓存有界（不是把整段摊开）
  const stats = await page.evaluate(() => {
    const A = (window as never as {
      __artmatic: {
        videoStats: () => {
          decodes: number;
          cachedFrames: number;
          cachedBytes: number;
          failures: { reason: string }[];
        };
      };
    }).__artmatic;
    return A.videoStats();
  });
  expect(stats.decodes).toBeGreaterThan(0);
  expect(stats.failures).toEqual([]);
  expect(stats.cachedFrames).toBeLessThan(60);

  // 5) 同一 t 渲两次逐像素一致（视频帧命中缓存里的同一张纹理）
  expect(await renderTwiceDiff(page, 0.6)).toBe(0);

  // 6) 覆盖率断言：关掉视频轨画面必须变（否则上面测的可能根本不是它）
  await settle(page, 0.3);
  const withVideo = await meanAt(page, 0.3);
  const trackId = await page.evaluate(() => {
    const A = (window as never as {
      __artmatic: { store: { project: { tracks: { id: string; enabled: boolean; clips: unknown[] }[] } } };
    }).__artmatic;
    return A.store.project.tracks.find((t) => t.enabled && t.clips.length > 0)?.id ?? '';
  });
  await setTrackEnabled(page, trackId, false);
  const withoutVideo = await meanAt(page, 0.3);
  expect(Math.abs(withVideo - withoutVideo)).toBeGreaterThan(5);
  await setTrackEnabled(page, trackId, true);

  // 7) 合成方式（blend）作用在视频上：垫一层纯色在**下面**，
  //    换混合模式必须改变画面 —— 视频与纯色走的是同一个 blend pass。
  const blendDiff = await page.evaluate(() => {
    const A = (window as never as {
      __artmatic: {
        store: {
          addTrack: (k: 'visual', n?: string) => string;
          addClip: (trackId: string, clip: unknown) => void;
          commit: (
            l: string,
            f: (p: {
              tracks: { id: string; clips: { id: string; blend?: string; source?: unknown }[] }[];
            }) => void,
          ) => void;
        };
        renderer: { onSeek: () => void };
        renderFrame: (t: number) => void;
        readPixels: () => { data: number[] };
      };
    }).__artmatic;
    // 新轨 push 到数组末尾 = z 最低 = 垫在视频下面
    const host = A.store.addTrack('visual', 'UNDER');
    A.store.addClip(host, {
      kind: 'source',
      id: 'under-solid',
      start: 0,
      end: 60,
      label: 'under',
      fadeSec: 0,
      curves: {},
      source: { type: 'solid', color: '#3366ff' },
      blend: 'normal',
      opacity: 1,
      transform: { x: 0.5, y: 0.5, sx: 1, sy: 1, rot: 0 },
      fit: 'stretch',
    });
    const hashAt = (): number => {
      A.renderer.onSeek();
      A.renderFrame(0.3);
      const d = A.readPixels().data;
      let h = 0;
      for (let i = 0; i < d.length; i += 887) h = (h * 31 + d[i]!) | 0;
      return h;
    };
    const setBlend = (mode: string): void => {
      A.store.commit('e2e: 改混合模式', (p) => {
        for (const t of p.tracks) for (const c of t.clips) if (c.source && c.id !== 'under-solid') c.blend = mode;
      });
    };
    const normal = hashAt();
    setBlend('difference');
    const difference = hashAt();
    setBlend('normal');
    return { normal, difference };
  });
  expect(blendDiff.difference, '换混合模式必须改变画面').not.toBe(blendDiff.normal);

  expect(errors).toEqual([]);
});


const readProject = (page: import('@playwright/test').Page) =>
  page.evaluate(() => {
    const A = (window as never as {
      __artmatic: { store: { project: { resolution: { w: number; h: number }; fps: number } } };
    }).__artmatic;
    return { resolution: A.store.project.resolution, fps: A.store.project.fps };
  });

/**
 * 工程设置已经搬进「设置 → 当前工程」，而且改成**草稿 + 保存并应用**：
 * 面板里改的是草稿，点「保存并应用」才落库。所以这条测试的形态跟着变 ——
 * 它现在同时钉住「草稿阶段不落库」与「应用后落库」两件事。
 */
test('工程设置：草稿阶段不落库，保存并应用后生效', async ({ page }) => {
  await boot(page);
  await page.getByTestId('rail-settings').click();
  await expect(page.getByTestId('modal-settings')).toBeVisible();
  // 默认落在「当前工程」分页
  await expect(page.getByTestId('settings-pane-project')).toBeVisible();

  // 分辨率：从预设选 720p
  await page.getByTestId('project-res-preset').click();
  await page.getByTestId('project-res-opt-hd720').click();

  // 帧率：预设 60
  await page.getByTestId('project-fps-preset').click();
  await page.getByTestId('project-fps-opt-60').click();

  // 草稿阶段：工程里还是原值（这是「取消」能真的取消的前提）
  expect(await readProject(page)).toEqual({ resolution: { w: 1920, h: 1080 }, fps: 30 });

  // 改过帧率 → 出现「随机数会受影响」的说明（文案在 `app.fpsChangeHint`）
  await expect(page.getByText('更改帧率会影响依赖随机数的特效', { exact: false })).toBeVisible();

  // 自定义分辨率：写进工程的值必须是**偶数**（H.264 的 4:2:0 要求宽高为偶数）。
  // 输入框 step=2，所以键入 1001 可能被吸附到 1000 或 1002 —— 两者都对，
  // 这里断言的是不变量（偶数 + 接近键入值），不是某一个具体吸附结果。
  await page.getByTestId('project-res-w').fill('1001');
  await page.getByTestId('project-res-w').press('Enter');
  // 改分辨率后有一句小字警告（「不会缩放已有排版」）
  await expect(page.getByTestId('settings-resolution-warn')).toBeVisible();

  await page.getByTestId('settings-apply').click();
  await expect(page.getByTestId('modal-settings')).toHaveCount(0);

  const after = await readProject(page);
  expect(after.fps).toBe(60);
  expect(after.resolution.h).toBe(720);
  const w = after.resolution.w;
  expect(w % 2, `写进工程的宽度必须是偶数，实测 ${w}`).toBe(0);
  expect(Math.abs(w - 1001)).toBeLessThanOrEqual(2);
});

test('工程设置：取消丢弃草稿', async ({ page }) => {
  await boot(page);
  await page.getByTestId('rail-settings').click();
  await page.getByTestId('project-fps-preset').click();
  await page.getByTestId('project-fps-opt-60').click();
  await page.getByTestId('settings-cancel').click();
  await expect(page.getByTestId('modal-settings')).toHaveCount(0);
  expect((await readProject(page)).fps).toBe(30);
});


test('预览降质：档位生效但不影响导出尺寸，且画面显示尺寸不变', async ({ page }) => {
  await boot(page);
  await buildStage(page, { id: 'pv', source: { type: 'solid', color: '#336699' } });

  const sizeOf = (): Promise<{ w: number; h: number }> =>
    page.evaluate(() => {
      const A = (window as never as { __artmatic: { renderer: { kit: { w: number; h: number } } } }).__artmatic;
      return { w: A.renderer.kit.w, h: A.renderer.kit.h };
    });
  /** canvas 的**显示**尺寸（CSS 盒）—— 降质不该动它。 */
  const boxOf = (): Promise<{ w: number; h: number }> =>
    page.evaluate(() => {
      const el = document.getElementById('gl')!;
      const r = el.getBoundingClientRect();
      return { w: Math.round(r.width), h: Math.round(r.height) };
    });

  const full = await sizeOf();
  const fullBox = await boxOf();

  // 默认「暂停回全质」开着：暂停时选 25% 也不该变小（缓冲与显示都不变）
  await page.getByTestId('preview-scale').click();
  await page.getByTestId('preview-scale-opt-0.25').click();
  expect((await sizeOf()).w).toBe(full.w);

  // 关掉它 → 缓冲降到 1/4，但**显示尺寸必须不变**（放大到 100%、有点糊）
  await page.getByTestId('preview-restore-on-pause').click();
  await expect.poll(async () => (await sizeOf()).w, { timeout: 5000 }).toBeLessThan(full.w);
  const degraded = await sizeOf();
  expect(Math.abs(degraded.w - Math.round(full.w * 0.25))).toBeLessThanOrEqual(2);
  const degradedBox = await boxOf();
  expect(
    Math.abs(degradedBox.w - fullBox.w),
    `降质后显示宽度应保持不变：降质前 ${fullBox.w}，降质后 ${degradedBox.w}`,
  ).toBeLessThanOrEqual(1);
  expect(Math.abs(degradedBox.h - fullBox.h)).toBeLessThanOrEqual(1);

  // 帧率档位有且只有三档（全速 / 1-2 / 1-3）
  await page.getByTestId('preview-fps').click();
  expect(await page.locator('[data-testid^=preview-fps-opt-]').count()).toBe(3);
  await page.keyboard.press('Escape');

  // 导出走 setExportSize，与预览档位无关
  const exportSize = await page.evaluate(() => {
    const A = (window as never as {
      __artmatic: {
        renderer: {
          setExportSize: (w: number, h: number) => void;
          clearExportSize: () => void;
          kit: { w: number; h: number };
        };
      };
    }).__artmatic;
    A.renderer.setExportSize(640, 360);
    const s = { w: A.renderer.kit.w, h: A.renderer.kit.h };
    A.renderer.clearExportSize();
    return s;
  });
  expect(exportSize).toEqual({ w: 640, h: 360 });
});

test('预览工具栏的下拉贴着它自己的触发器，不会偏到一边', async ({ page }) => {
  await boot(page);
  await buildStage(page, { id: 'pv2', source: { type: 'solid', color: '#336699' } });

  /*
   * 这条钉的是一个很容易复发的坑：`Select` 的弹层是 `position: fixed` +
   * `getBoundingClientRect()` 算出来的**视口**坐标。只要工具栏（或它的任何
   * 祖先）带了 `transform` / `filter` / `backdrop-filter`，它就成了 fixed
   * 后代的**包含块**，那些视口坐标会被当成「相对工具栏」解释 ——
   * 表现是弹层整体偏到右边、和触发器错开一整个工具栏的宽度。
   */
  for (const id of ['preview-fps', 'preview-scale']) {
    const trigger = (await page.getByTestId(id).boundingBox())!;
    await page.getByTestId(id).click();
    const pop = (await page.getByTestId(`${id}-pop`).boundingBox())!;
    expect(
      Math.abs(pop.x - trigger.x),
      `${id} 的弹层左边缘应与触发器对齐（触发器 ${trigger.x}，弹层 ${pop.x}）`,
    ).toBeLessThanOrEqual(2);
    expect(pop.y, `${id} 的弹层应在触发器下方`).toBeGreaterThanOrEqual(trigger.y + trigger.height - 1);
    await page.keyboard.press('Escape');
  }
});

test('rail 的图标颜色一致：主题切换与 /lab 入口都不抢色', async ({ page }) => {
  await boot(page);

  // 切到暗色 —— 主题图标那个 bug 只在暗色下看得出来（亮色下 active 没被置上）
  const mode = await page.evaluate(
    () => (window as never as { __artmatic: { theme: { mode: string } } }).__artmatic.theme.mode,
  );
  if (mode !== 'dark') await page.getByTestId('theme-toggle').click();
  await expect
    .poll(
      async () =>
        page.evaluate(
          () => (window as never as { __artmatic: { theme: { mode: string } } }).__artmatic.theme.mode,
        ),
      { timeout: 5000 },
    )
    .toBe('dark');

  // 指针移开：.ic-btn:hover 会变成 text-primary（近白），
  // 不挪走量到的就是 hover 色而不是静止态
  await page.mouse.move(0, 0);
  await page.waitForTimeout(120);

  const probe = await page.evaluate(() => {
    const ids = [
      'rail-shortcuts',
      'rail-project',
      'rail-save',
      'rail-export',
      'rail-settings',
      'rail-lab',
      'theme-toggle',
    ];
    const out: Record<string, string | null> = {};
    for (const id of ids) {
      const el = document.querySelector(`[data-testid="${id}"]`);
      out[id] = el ? getComputedStyle(el).color : null;
    }
    const toggle = document.querySelector('[data-testid="theme-toggle"]');
    out.__pressed = toggle?.getAttribute('aria-pressed') ?? null;
    return out;
  });

  /*
   * 这一条同时钉两件事，都是**实测踩过**的：
   *   1. 主题切换曾经带 `active`，于是 `.ic-btn[aria-pressed=true]` 把它染成
   *      主题色 —— 在一排灰色图标里只有它是紫的；
   *   2. /lab 入口是 `<a>`，不给它复用 `.ic-btn` 的话会用**浏览器默认的链接蓝**
   *      （实测 rgb(158,158,255)），又蓝又大。
   *
   * 判据是「所有 rail 图标同一个颜色」，而不是「等于某个具体值」——
   * 后者会在换主题/改 token 时假失败。
   */
  expect(probe.__pressed, '主题切换不该带激活态').not.toBe('true');
  const colors = Object.entries(probe)
    .filter(([k]) => !k.startsWith('__'))
    .map(([, v]) => v);
  expect(new Set(colors).size, `rail 图标颜色应当只有一个，实测 ${JSON.stringify(probe)}`).toBe(1);
});

test('rail 在每个界面都一致：主应用有 /lab 入口，lab 里也有同一套 rail', async ({ page }) => {
  await boot(page);

  const rail = page.getByTestId('rail');
  await expect(rail).toBeVisible();
  const appBox = (await rail.boundingBox())!;

  // 入口存在且指向 /lab/
  const lab = page.getByTestId('rail-lab');
  await expect(lab).toBeVisible();
  expect(await lab.getAttribute('href')).toBe('/lab/');

  // 点进去 → lab 页面
  await lab.click();
  await page.waitForURL('**/lab/');
  await page.waitForFunction(() => (window as never as { __lab?: unknown }).__lab);

  // lab 侧栏：与主应用同一套骨架（同一个组件、同样的宽度）
  const labRail = page.getByTestId('lab-rail');
  await expect(labRail).toBeVisible();
  const labBox = (await labRail.boundingBox())!;
  expect(Math.abs(labBox.width - appBox.width)).toBeLessThanOrEqual(1);

  // lab 仍然**不引主应用**：没有 __artmatic
  const hasApp = await page.evaluate(
    () => typeof (window as never as { __artmatic?: unknown }).__artmatic !== 'undefined',
  );
  expect(hasApp, 'lab 里不该有 __artmatic（它不能引主应用的图）').toBe(false);

  // lab 的 rail 上有它自己的动作与返回入口
  await expect(page.getByTestId('lab-home')).toBeVisible();
  await expect(page.getByTestId('lab-rail-compile')).toBeVisible();
});

/**
 * 视频取帧的两面：**突发请求要合并**、**顺序播放要复用同一个迭代器**。
 *
 * 两条以前各写一个用例，prologue 逐字相同且极贵 —— `makeTestVideo()` 现场编
 * 2 秒 MP4 + 真 filechooser 导入 + `waitForClip`。测的却是同一条解码管线的两面，
 * 判据互不冲突，所以合成一趟：编一次、导一次，两个阶段分开量增量。
 */
test('视频取帧：突发请求被合并，顺序播放复用同一个解码迭代器', async ({ page }) => {
  await boot(page);
  await cleanStage(page);

  // 现场编一段小素材（不往仓库塞二进制），走真实导入路径
  const bytes = await page.evaluate(() => {
    const A = (window as never as { __artmatic: { makeTestVideo: () => Promise<number[]> } }).__artmatic;
    return A.makeTestVideo();
  });
  const [chooser] = await Promise.all([
    page.waitForEvent('filechooser', { timeout: 30_000 }),
    (async () => {
      await page.locator('[data-testid=track-menu]').last().click();
      await page.getByTestId('import-video').click();
    })(),
  ]);
  await chooser.setFiles({ name: 'e2e-fetch.mp4', mimeType: 'video/mp4', buffer: Buffer.from(bytes) });
  await waitForClip(page);

  /* ------------------------------------------------ ① 突发：请求被合并 */

  const burst = await page.evaluate(async () => {
    const A = (window as never as { __artmatic: any }).__artmatic;
    const stats = () => A.appState.video.stats();

    // **同步**跑 60 帧：JS 不让出事件循环，所以这 60 个请求会全部堆在队列里，
    // 一个都来不及执行。这正是「拖动播放头快速扫」与「解码跟不上时」的形状。
    const before = stats();
    const clip = A.store.project.tracks.flatMap((t: any) => t.clips)[0];
    for (let i = 0; i < 60; i += 1) {
      A.renderer.renderFrame(A.store.project, clip.start + i / 60);
    }
    // 让出事件循环，给队列排空的机会（给足时间，让「会排队」的那种实现
    // 把差距拉大：合并后只会有 1 个，不合并会是几十个）
    await new Promise((res) => setTimeout(res, 2000));
    const after = stats();
    return { queuedDecodes: after.decodes - before.decodes, dropped: after.dropped - before.dropped };
  });

  // 合并之后：这 60 个请求里**只有最后一个**会真正去解，其余全部作废。
  // 不做合并的话，每个请求都会排进队列 —— 那正是「解不完的废帧把主线程饿死」
  // 的来源（4K 素材上实测会让整页失去响应）。
  //
  // 两条一起看：
  // - `dropped > 0` 是**机制判据**：合并发生了（不移除合并逻辑就是 0）。它不受
  //   素材长度影响 —— 素材只有 10 个不同帧时，靠区间去重也能把解码数压下来，
  //   所以单看解码数是分不出来的（这一点是实测出来的，不是推的）。
  // - `queuedDecodes` 是**代价上界**：本素材最多只该解出个位数。
  expect(burst.dropped).toBeGreaterThan(0);
  expect(burst.queuedDecodes).toBeLessThanOrEqual(6);

  /* -------------------------------------- ② 顺序：复用常驻迭代器 */

  const seq = await page.evaluate(async () => {
    const A = (window as never as { __artmatic: any }).__artmatic;
    const clip = A.store.project.tracks.flatMap((t: any) => t.clips)[0];
    const before = A.appState.video.stats();
    // 顺序往前渲染 20 帧（素材 2s / 10fps），每帧之间让出事件循环
    for (let i = 0; i < 20; i += 1) {
      A.renderer.renderFrame(A.store.project, clip.start + 0.05 + i / 10);
      await new Promise((res) => setTimeout(res, 40));
    }
    const after = A.appState.video.stats();
    return { decodes: after.decodes - before.decodes, streams: after.streams };
  });

  // `sink.getSample(t)` 的实现是「为单个时间戳新建一个迭代器」—— 也就是**每帧都把
  // 解码管线重建一遍**（从最近关键帧重新解起）。顺序访问必须走常驻的 `samples()`。
  //
  // 判据取两头的界：
  // - `≥ 15`：这 20 帧确实解出来了
  // - `≤ 3`（streams）：没有逐帧重建
  //
  // 注意 `streams` 取的是**绝对值**而不是增量：导入后的第一次渲染就会开流，
  // 所以增量天然是 0（这一条是第一次写下时搞错的判据 —— 增量 0 被误读成
  // 「顺序路径没走到」，实际是「早就开好了」）。
  expect(seq.decodes).toBeGreaterThanOrEqual(15);
  expect(seq.streams).toBeGreaterThanOrEqual(1);
  expect(seq.streams).toBeLessThanOrEqual(3);
});
