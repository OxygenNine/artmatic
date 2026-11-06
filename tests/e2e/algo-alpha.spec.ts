/**
 * algo-alpha.spec.ts — 算法生成器的**透明背景**到底有没有让下层透出来。
 *
 * ## 为什么不能直接读 alpha
 *
 * 渲染上下文的属性是 `alpha: false`（`engine/kit.ts`，为了导出走
 * `canvas.toBlob` 那一路稳定），所以 `readPixels` 的 A 通道**恒为 255**。
 * 于是这里改测**产品级事实**：透明区域下面压一层纯红，红色必须原样透出来；
 * 切回纯色底，红色必须一个像素都不剩。这条链上有三处会静默失效，都会被它抓住：
 *
 * 1. 生成器吐了 `a < 1`，但颜色是**预乘的**（直通 alpha 下再乘一次 → 边界发暗）；
 * 2. 生成器吐对了，但合成 pass 把 alpha 拍平了（`blend.frag` 的 `outA`）；
 * 3. `bgMode` 的取值映射反了（`smoke` 历史上是 `0 = 透明`，全家族统一时最容易翻车）。
 *
 * 三处的表现都一样：**看起来没错，只是下层永远出不来**。
 *
 * 断言写成不变量（`tests/e2e/AGENTS.md`）：不逐点比色 —— 预览尺寸随窗口变，
 * 启动窗口内 GPU 还有两个稳定态（AGENTS §1.3），计数对那点噪声免疫。
 */

import { expect, test } from '@playwright/test';
import { buildStage, openDemo } from './_stage';

/**
 * 一条一个**实现路径**，不是越多越好：
 *   sim 默认着色 / bake 的 reveal / realtime 的线条 / realtime 3D / 自定义 tint 的
 *   sim（RD 走 `tintFragment`）/ realtime 的覆盖率（Kleinian）/ 全家族的第一个
 *   （`smoke`，它的 `u_bgMode` 取值曾经是反的，并入共用口径时最该被钉住）。
 */
const CASES = [
  { gen: 'game-of-life', t: 1 },
  { gen: 'rule110', t: 1 },
  { gen: 'grid', t: 0 },
  { gen: 'menger', t: 1 },
  // 早一点截：40 秒（`catalog.ts` 的预览时刻）时珊瑚已经铺满整格，
  // 「数得到纯红」的前提（真实存在的空白区）就没了 —— 那是**用例的错**，不是实现的。
  { gen: 'reaction-diffusion', t: 6 },
  { gen: 'kleinian', t: 0 },
  // 二维码：静区 + 留白是天然的「大量空白像素」，最能暴露直通 alpha 写错的那类 bug
  { gen: 'qr-code', t: 1 },
  // 跃动几何：「黑底 + 少量墨」的另一极（覆盖率低、形状有抗锯齿边），
  // 半覆盖的像素最多 —— 预乘/直通写反时这一条最先出深色描边
  { gen: 'kinetic-shapes', t: 1 },
  { gen: 'smoke', t: 1 },
] as const;

/** 底层色：任何被测生成器都不会自己画出来的纯红。 */
const UNDER = '#ff0000';

interface Shot {
  /** 纯红像素数（= 下层真的透出来了）。 */
  red: number;
  total: number;
}

interface StageIds {
  clipId: string;
  underTrackId: string;
}

interface StageApi {
  store: {
    addTrack: (kind: 'visual', name?: string) => string;
    addClip: (trackId: string, clip: unknown) => void;
    commit: (
      label: string,
      fn: (p: {
        tracks: {
          id: string;
          enabled: boolean;
          clips: { id: string; source?: { params?: Record<string, number | string> } }[];
        }[];
      }) => void,
    ) => void;
  };
  renderer: { onSeek: () => void };
  renderFrame: (t: number) => void;
  readPixels: () => { data: number[]; w: number; h: number };
}

/** 搭一条「算法源（上）+ 纯红（下，先启用）」的舞台。 */
async function buildAlphaStage(
  page: import('@playwright/test').Page,
  gen: string,
  params: Record<string, number | string>,
): Promise<StageIds> {
  const clipId = `alpha-${gen}`;
  await buildStage(page, {
    id: clipId,
    source: { type: 'algo', generator: gen, params },
    end: 8,
  });
  const underTrackId = await page.evaluate(
    ({ clipId, under }) => {
      const A = (window as never as { __artmatic: StageApi }).__artmatic;
      // `addTrack` 是 push ⇒ 新轨落在数组末尾 = z 最低 = 在被测源**下面**。
      const t = A.store.addTrack('visual', 'UNDER');
      A.store.addClip(t, {
        fadeSec: 0,
        curves: {},
        transform: { x: 0.5, y: 0.5, sx: 1, sy: 1, rot: 0 },
        fit: 'stretch',
        kind: 'source',
        id: `${clipId}-under`,
        start: 0,
        end: 8,
        label: 'under',
        source: { type: 'solid', color: under },
        blend: 'normal',
        opacity: 1,
      });
      A.store.commit('e2e: 启用底层', (p) => {
        for (const tr of p.tracks) if (tr.id === t) tr.enabled = true;
      });
      return t;
    },
    { clipId, under: UNDER },
  );
  return { clipId, underTrackId };
}

/**
 * 改 `bgMode` → 渲一帧 → 数红色像素。
 *
 * 渲之前先 `onSeek()` + 预热几帧：跨过启动窗口的双稳定态（AGENTS §1.3）。
 */
async function shoot(
  page: import('@playwright/test').Page,
  ids: StageIds,
  cfg: { bgMode: string; t: number },
): Promise<Shot> {
  return page.evaluate(
    ({ ids, cfg }) => {
      const A = (window as never as { __artmatic: StageApi }).__artmatic;
      A.store.commit('e2e: 切背景', (p) => {
        for (const tr of p.tracks) {
          for (const c of tr.clips) {
            if (c.id === ids.clipId && c.source?.params) c.source.params['bgMode'] = cfg.bgMode;
          }
        }
      });
      A.renderer.onSeek();
      for (let k = 0; k < 4; k++) A.renderFrame(cfg.t);
      const { data } = A.readPixels();
      let red = 0;
      for (let i = 0; i < data.length; i += 4) {
        if (data[i]! > 240 && data[i + 1]! < 15 && data[i + 2]! < 15) red += 1;
      }
      return { red, total: data.length / 4 };
    },
    { ids, cfg },
  );
}

test.describe('算法生成器的透明背景', () => {
  for (const c of CASES) {
    test(`${c.gen}：透明底让下层透出来，纯色底完全盖住`, async ({ page }) => {
      await page.goto('/');
      await page.waitForFunction(() =>
        Boolean((window as never as { __artmatic?: unknown }).__artmatic),
      );
      await openDemo(page);

      // 参数从**默认值**出发再只改 bgMode —— 与用户点开选择器的那条路一致。
      const defaults = await page.evaluate(
        (gen) =>
          (
            window as never as {
              __artmatic: { algo: { defaultParams: (id: string) => Record<string, number | string> } };
            }
          ).__artmatic.algo.defaultParams(gen),
        c.gen,
      );
      const ids = await buildAlphaStage(page, c.gen, { ...defaults, bgMode: 'transparent' });

      // 1) 纯色底：算法的底色铺满整帧，红色一个像素都不该剩
      const solid = await shoot(page, ids, { bgMode: 'solid', t: c.t });
      expect(
        solid.red,
        `${c.gen}：纯色底还透出了下层 → bgMode 没生效（取值映射反了？）或者底色没铺满`,
      ).toBe(0);

      // 2) 透明底：红色必须真的透出来（而且必须是**红**，不是被填成黑）
      const trans = await shoot(page, ids, { bgMode: 'transparent', t: c.t });
      expect(
        trans.red,
        `${c.gen}：透明底没让下层透出来 → 生成器没吐 a < 1，或者合成时 alpha 被拍平`,
      ).toBeGreaterThan(trans.total * 0.01);
    });
  }
});

/**
 * 检查器里真的能点到它。
 *
 * 只测渲染的话，一个「参数存在但界面不渲染」的 def 会全绿 —— 而那就是
 * 「功能在 Agent 眼里存在、在用户眼里不存在」。顺带钉住 `visibleWhen`：
 * 透明模式下底色参数必须消失，否则留着的是一个拖了没反应的滑杆。
 */
test('检查器：背景开关可达，选透明后底色参数消失', async ({ page }) => {
  await page.goto('/');
  await page.waitForFunction(() => Boolean((window as never as { __artmatic?: unknown }).__artmatic));
  await openDemo(page);
  const ids = await buildAlphaStage(page, 'game-of-life', { bgMode: 'solid' });
  await page.evaluate((id) => {
    (window as never as { __artmatic: { appState: { selectedClipId: string | null } } }).__artmatic.appState.selectedClipId = id;
  }, ids.clipId);

  await expect(page.getByTestId('algo-param-bgMode')).toBeVisible();
  await expect(page.getByTestId('algo-param-colorBg')).toBeVisible();

  await shoot(page, ids, { bgMode: 'transparent', t: 1 });
  await expect(page.getByTestId('algo-param-colorBg')).toHaveCount(0);
  await expect(page.getByTestId('algo-param-bgMode')).toBeVisible();

  await shoot(page, ids, { bgMode: 'solid', t: 1 });
  await expect(page.getByTestId('algo-param-colorBg')).toBeVisible();
});
