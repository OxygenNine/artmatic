import { expect, test, type Page } from '@playwright/test';
import { quadSourceUv } from '../../src/core/quad';
import {
  buildImageStage,
  openDemo,
  readClipImageState,
  rgbaAtTopLeft,
  setClipQuad,
  settle,
  type ClipQuadCorners,
} from './_stage';

/**
 * 「图片四角调整」（`SourceClip.quad`，v7 引入）的 E2E 守卫。
 *
 * 素材是页面内现画的 640×360 PNG，**上半纯红 / 下半纯蓝**；没有背景轨
 * （透明处读回黑）。上下两半的布局是刻意的：基线里「上红下蓝」，一旦渲染
 * 上下翻转（这是这条链路最容易犯的错），基线断言先红。
 *
 * ## 坐标空间（与 `src/core/quad.ts` 一致）
 *
 * **全部用左上原点**：`QuadCorners` 的 `(0,0)` = 默认图层矩形左上；`quadSourceUv`
 * 的入参是左上原点的层空间坐标、返回值是左上原点的源 uv。所以本文件里：
 *
 * - 屏幕探针 `(x, y)`（左上原点）在默认 `fit:'stretch'` + 默认 transform 下
 *   就等于层空间 `(x, y)`，可以直接喂 `quadSourceUv` 算期望值；
 * - 源图上半红 = 源 `v < 0.5`，下半蓝 = 源 `v > 0.5`，`v ∉ [0,1]` = 层外（黑）。
 *
 * `readPixels` 是 GL 行序（原点左下），探针统一走 `_stage.ts::rgbaAtTopLeft`
 * （内部翻行），所以本文件所有坐标都是「人看到的方向」。
 */

const RED = '#ff0000';
const BLUE = '#0000ff';

type Rgba = [number, number, number, number];

const T = 1;
const fmt = (c: Rgba): string => `rgba(${c.join(', ')})`;

/** task-4 契约里的示例 quad：**上边下压**成窄上宽下的梯形。 */
const TRAPEZOID: ClipQuadCorners = {
  tl: [0.25, 0.25],
  tr: [0.75, 0.25],
  br: [1, 1],
  bl: [0, 1],
};

const IDENTITY: ClipQuadCorners = {
  tl: [0, 0],
  tr: [1, 0],
  br: [1, 1],
  bl: [0, 1],
};

/** 三点共线（tl/tr/bl 都在 y=0.5）→ 单应不可逆 → 引擎契约要求「按不调整渲染」。 */
const DEGENERATE: ClipQuadCorners = {
  tl: [0, 0.5],
  tr: [0.5, 0.5],
  bl: [1, 0.5],
  br: [1, 1],
};

async function boot(page: Page): Promise<void> {
  await page.goto('/');
  await page.waitForFunction(() => (window as never as { __artmatic?: unknown }).__artmatic);
  await openDemo(page);
}

/* ------------------------------------------------------------ 像素判据 */

function expectRed(c: Rgba, where: string): void {
  expect(c[0], `${where}：应为红（R>180），实测 ${fmt(c)}`).toBeGreaterThan(180);
  expect(c[1], `${where}：应为红（G<100），实测 ${fmt(c)}`).toBeLessThan(100);
  expect(c[2], `${where}：应为红（B<100），实测 ${fmt(c)}`).toBeLessThan(100);
}

function expectBlue(c: Rgba, where: string): void {
  expect(c[2], `${where}：应为蓝（B>180），实测 ${fmt(c)}`).toBeGreaterThan(180);
  expect(c[0], `${where}：应为蓝（R<60），实测 ${fmt(c)}`).toBeLessThan(60);
  expect(c[1], `${where}：应为蓝（G<60），实测 ${fmt(c)}`).toBeLessThan(60);
}

/** 层外 = 透明（透明黑；合成到屏幕后 rgb 也近 0）。 */
function expectBlack(c: Rgba, where: string): void {
  expect(c[0], `${where}：quad 之外应为黑（R<40），实测 ${fmt(c)}`).toBeLessThan(40);
  expect(c[1], `${where}：quad 之外应为黑（G<40），实测 ${fmt(c)}`).toBeLessThan(40);
  expect(c[2], `${where}：quad 之外应为黑（B<40），实测 ${fmt(c)}`).toBeLessThan(40);
}

/** 源 uv → 期望颜色：上半红 / 下半蓝 / 层外黑。 */
function expectSourceColor(src: [number, number] | null, c: Rgba, where: string): void {
  expect(src, `${where}：quadSourceUv 不应返回 null`).not.toBeNull();
  const [u, v] = src!;
  if (u < 0 || u > 1 || v < 0 || v > 1) {
    expectBlack(c, `${where}（源 uv=(${u.toFixed(3)}, ${v.toFixed(3)}) → 层外）`);
    return;
  }
  if (v < 0.5) expectRed(c, `${where}（源 v=${v.toFixed(3)} < 0.5 → 上半红）`);
  else expectBlue(c, `${where}（源 v=${v.toFixed(3)} > 0.5 → 下半蓝）`);
}

/**
 * 在层空间 `x` 这条竖线上，二分找「源图水平中线（源 v=0.5）」落在哪一层 y。
 *
 * 这条线的位置本身是一个**透视非线性**判据：梯形上边 y=0.25、下边 y=1，
 * 若实现是「双线性拉伸」，红蓝分界会落在 (0.25+1)/2 = 0.625；真正的单应
 * 会把它拉到别的 y（本 quad 是 0.5）。所以下面除了在两侧各取一个探针，
 * 还显式断言它离 0.625 足够远。
 */
function findSourceMidlineY(q: ClipQuadCorners, x: number): number {
  const vAt = (y: number): number => {
    const s = quadSourceUv(q, x, y);
    if (!s) throw new Error(`quadSourceUv(${x}, ${y}) 返回 null —— 这个 quad 不该退化`);
    return s[1];
  };
  // 上边（源 v≈0，层 y=0.25）与下边（源 v≈1，层 y=1）之间二分。
  let lo = 0.25;
  let hi = 1;
  expect(vAt(lo), '上边中点处源 v 应 ≈0').toBeLessThan(0.5);
  expect(vAt(hi), '下边中点处源 v 应 ≈1').toBeGreaterThan(0.5);
  for (let i = 0; i < 60; i += 1) {
    const mid = (lo + hi) / 2;
    if (vAt(mid) < 0.5) lo = mid;
    else hi = mid;
  }
  return (lo + hi) / 2;
}

/* ============================================ 场景 A：透视渲染 + 数学预期 */

test('四角透视：上边下压真正改变几何、红蓝分界符合单应（不是线性拉伸）、退化回退', async ({
  page,
}) => {
  await boot(page);
  const stage = await buildImageStage(page, {
    pattern: { kind: 'halves', top: RED, bottom: BLUE },
  });
  await settle(page, T);

  /* ---- 1) 基线：上半红、下半蓝；四角也分别是红/蓝 ---- */
  expectRed(await rgbaAtTopLeft(page, T, 0.5, 0.1), '基线·顶部中点');
  expectBlue(await rgbaAtTopLeft(page, T, 0.5, 0.9), '基线·底部中点');
  expectRed(await rgbaAtTopLeft(page, T, 0.05, 0.05), '基线·左上角');

  /* ---- 2) 上边下压：上边之外的区域必须变黑 ---- */
  await setClipQuad(page, stage.imageClipId, TRAPEZOID);
  expect((await readClipImageState(page, stage.imageClipId)).quad).toEqual(TRAPEZOID);
  await settle(page, T);

  // 三个「在上边之外」的探针：梯形上边 y=0.25，顶部这一条都该透明
  expectBlack(await rgbaAtTopLeft(page, T, 0.1, 0.1), '梯形·左上（上边之外）');
  expectBlack(await rgbaAtTopLeft(page, T, 0.5, 0.1), '梯形·顶部中点（上边之外）');
  expectBlack(await rgbaAtTopLeft(page, T, 0.9, 0.1), '梯形·右上（上边之外）');
  // 底部仍在：下边覆盖整幅宽度
  expectBlue(await rgbaAtTopLeft(page, T, 0.5, 0.9), '梯形·底部中点');
  expectBlue(await rgbaAtTopLeft(page, T, 0.1, 0.9), '梯形·左下（仍在四边形内）');

  // GPU 采样必须与 CPU 参考实现（quadSourceUv）逐点一致：单应的行列/转置写反时
  // 画面会沿对角线翻折，而在「上边之外变黑」这类少数探针上可能仍然通过。
  //
  // 探针的挑选纪律（这组点用 `quadSourceUv` 逐点核过）：
  //   - 离源 v=0.5 的**红蓝分界**至少 5%：边界上 GPU LINEAR 采样会插出红蓝各半，
  //     任何「红/蓝」二选一断言在那里都是假失败；
  //   - 离四边形的边也至少 2%：`insideLayer` 在边上是硬 step，探针压在边上
  //     会读到「图 / 透明黑」的边界结果。
  // 因此不取 y=0.5（源中线恰好整条落在层 y=0.5），也不取左边界的 (0.2,0.4)。
  for (const [px, py] of [
    [0.4, 0.4], // 源 (0.3333, 0.3333) → 红
    [0.35, 0.3], // 源 (0.2187, 0.1250) → 红
    [0.5, 0.4], // 源 (0.5000, 0.3333) → 红
    [0.2, 0.6], // 源 (0.0909, 0.6364) → 蓝
    [0.8, 0.8], // 源 (0.8462, 0.8462) → 蓝
    [0.65, 0.95], // 源 (0.6552, 0.9655) → 蓝
  ] as [number, number][]) {
    expectSourceColor(
      quadSourceUv(TRAPEZOID, px, py),
      await rgbaAtTopLeft(page, T, px, py),
      `梯形·CPU 期望 vs GPU 采样 (${px}, ${py})`,
    );
  }

  /* ---- 3) 真透视：红蓝分界不是双线性中点 ----
   *
   * 判据不是「两个探针颜色不同」——双线性拉伸也能让颜色不同。这里用
   * `quadSourceUv` 把「源图水平中线」反算到层空间：
   *   - 真正的单应：y* ≈ 0.5（上边 0.25、下边 1 的投影变换）；
   *   - 双线性拉伸：y* = (0.25+1)/2 = 0.625。
   * 于是 y*=0.5 附近的边界探针，以及「y=0.6 处是蓝不是红」都能区分两者。
   */
  const x = 0.5;
  const yMid = findSourceMidlineY(TRAPEZOID, x);
  expect(Math.abs(yMid - 0.625), `红蓝分界 y*=${yMid.toFixed(3)} 离双线性中点 0.625 太近`).toBeGreaterThan(
    0.05,
  );
  const above = await rgbaAtTopLeft(page, T, x, yMid - 0.03);
  const below = await rgbaAtTopLeft(page, T, x, yMid + 0.03);
  expectRed(above, `分界上方 y=${(yMid - 0.03).toFixed(3)}`);
  expectBlue(below, `分界下方 y=${(yMid + 0.03).toFixed(3)}`);
  // 双线性的决定性探针：y=0.6 在线性拉伸下仍属上半（红），真透视已到下半（蓝）
  expectBlue(await rgbaAtTopLeft(page, T, 0.5, 0.6), '透视非线性·y=0.6 应为下半蓝');

  /* ---- 4) 恒等 quad → 基线恢复（identity 走关闭路径） ---- */
  await setClipQuad(page, stage.imageClipId, IDENTITY);
  await settle(page, T);
  expectRed(await rgbaAtTopLeft(page, T, 0.5, 0.1), '恒等 quad 后·顶部中点应恢复红');
  expectBlue(await rgbaAtTopLeft(page, T, 0.5, 0.9), '恒等 quad 后·底部中点应恢复蓝');

  /* ---- 5) 退化 quad（三点共线）→ 按「不调整」渲染，不崩、不丢层 ---- */
  await setClipQuad(page, stage.imageClipId, DEGENERATE);
  expect(
    (await readClipImageState(page, stage.imageClipId)).quad,
    '退化 quad 的数据要保留（引擎回退，不静默删用户数据）',
  ).toEqual(DEGENERATE);
  await settle(page, T);
  expectRed(await rgbaAtTopLeft(page, T, 0.5, 0.1), '退化 quad·顶部仍应是红（回退到基线）');
  expectBlue(await rgbaAtTopLeft(page, T, 0.5, 0.9), '退化 quad·底部仍应是蓝（回退到基线）');
});

/* ======================================= 场景 B：预览画面上的四角手柄交互 */

test('四角手柄：开关出覆盖层、拖动改 store + 真改画面、一笔撤销、重置、关闭消失', async ({
  page,
}) => {
  await boot(page);
  const stage = await buildImageStage(page, {
    pattern: { kind: 'halves', top: RED, bottom: BLUE },
  });
  await settle(page, T);

  await page.evaluate((id) => {
    const A = (window as never as { __artmatic: { appState: { selectClip: (x: string) => void } } })
      .__artmatic;
    A.appState.selectClip(id);
  }, stage.imageClipId);
  await expect(page.getByTestId('quad-section')).toBeVisible();

  /* ---- 5) 开启四角：store 写入恒等值；覆盖层与四个角手柄出现 ---- */
  await page.getByTestId('clip-quad-enable').click();
  await expect
    .poll(async () => (await readClipImageState(page, stage.imageClipId)).quad)
    .toEqual(IDENTITY);
  await expect(page.getByTestId('quad-overlay')).toBeVisible();
  await expect(page.getByTestId('quad-handle-tl')).toBeVisible();

  const canvas = (await page.locator('#gl').boundingBox())!;
  const boxOf = async (id: string) => (await page.getByTestId(id).boundingBox())!;
  const centerOf = (b: { x: number; y: number; width: number; height: number }): [number, number] => [
    b.x + b.width / 2,
    b.y + b.height / 2,
  ];

  /*
   * 手柄位置 = 层空间角点经 `layerUvToFrameUv` 映射到画面。恒等 quad 下四个角
   * 必须贴在画面四角 —— 这条同时钉住「坐标是左上原点」这个约定：写反的实现
   * 会把 tl 手柄画到左下（m6 踩过一次同类坐标翻转）。
   */
  const tlBox = await boxOf('quad-handle-tl');
  const [tlX, tlY] = centerOf(tlBox);
  expect(
    Math.hypot(tlX - canvas.x, tlY - canvas.y),
    `quad-handle-tl 应贴在画面左上角（手柄中心 ${tlX.toFixed(1)},${tlY.toFixed(1)}；画布 ${canvas.x},${canvas.y}）`,
  ).toBeLessThan(24);
  const brCenter = centerOf(await boxOf('quad-handle-br'));
  expect(
    Math.hypot(brCenter[0] - (canvas.x + canvas.width), brCenter[1] - (canvas.y + canvas.height)),
    'quad-handle-br 应贴在画面右下角',
  ).toBeLessThan(24);

  // 基线像素：拖之前左上角是红的
  expectRed(await rgbaAtTopLeft(page, T, 0.05, 0.05), '拖角前·左上角');

  /* ---- 6) 拖 tl 手柄 +Δ：store 的四角跟着动，且是**一笔撤销** ---- */
  const dx = 64;
  const dy = 48;
  /*
   * 起手点从手柄中心往画面内缩 2px：手柄中心正好在 canvas 角上（SVG 边界），
   * 缩一点可避开「角落像素是否在 SVG 视口内」这种命中测试边缘情况。
   * 这不影响期望值 —— 拖动是**相对起点**的（`startLayer` 取按下点的层坐标），
   * 所以四角增量永远等于 (Δx/画布宽, Δy/画布高)。
   */
  await page.mouse.move(tlX + 2, tlY + 2);
  await page.mouse.down();
  await page.mouse.move(tlX + 2 + dx, tlY + 2 + dy, { steps: 10 });
  await page.mouse.up();

  const afterDrag = (await readClipImageState(page, stage.imageClipId)).quad!;
  const wantX = dx / canvas.width;
  const wantY = dy / canvas.height;
  expect(
    Math.abs(afterDrag.tl[0] - wantX),
    `拖动后 quad.tl[0] 应 ≈ Δx/画布宽 = ${wantX.toFixed(3)}（实测 ${JSON.stringify(afterDrag.tl)}）`,
  ).toBeLessThan(0.05);
  expect(
    Math.abs(afterDrag.tl[1] - wantY),
    `拖动后 quad.tl[1] 应 ≈ Δy/画布高 = ${wantY.toFixed(3)}（实测 ${JSON.stringify(afterDrag.tl)}）`,
  ).toBeLessThan(0.05);
  // 只动被拖的那个角，其余三个角必须原样
  expect(afterDrag.tr, '拖动 tl 不应改 tr').toEqual(IDENTITY.tr);
  expect(afterDrag.br, '拖动 tl 不应改 br').toEqual(IDENTITY.br);
  expect(afterDrag.bl, '拖动 tl 不应改 bl').toEqual(IDENTITY.bl);

  // 一笔撤销：undo 一次回到恒等（不是每帧一条记录）
  const canUndo = await page.evaluate(
    () => (window as never as { __artmatic: { store: { canUndo: () => boolean } } }).__artmatic.store.canUndo(),
  );
  expect(canUndo, '拖动之后应当有可撤销记录').toBe(true);
  await page.evaluate(() => {
    (window as never as { __artmatic: { store: { undo: () => void } } }).__artmatic.store.undo();
  });
  expect(
    (await readClipImageState(page, stage.imageClipId)).quad,
    '一次 undo 应把整个拖动回退到恒等（说明拖动是一笔事务）',
  ).toEqual(IDENTITY);
  // redo 回来，后面的像素断言测的才是「拖动后的几何」
  await page.evaluate(() => {
    (window as never as { __artmatic: { store: { redo: () => boolean } } }).__artmatic.store.redo();
  });
  expect((await readClipImageState(page, stage.imageClipId)).quad, 'redo 应恢复拖动后的四角').toEqual(
    afterDrag,
  );

  /* ---- 7) 几何真的动了：原左上角像素变黑（不是只改 store） ---- */
  await settle(page, T);
  expectBlack(await rgbaAtTopLeft(page, T, 0.05, 0.05), '拖角后·原左上角应被裁掉（变黑）');
  // 画面中心仍在（防止「整层消失」被误判成「几何动了」）
  const centerPixel = await rgbaAtTopLeft(page, T, 0.5, 0.5);
  expect(
    Math.max(centerPixel[0], centerPixel[1], centerPixel[2]),
    `拖角后画面中心仍应有内容，实测 ${fmt(centerPixel)}`,
  ).toBeGreaterThan(60);

  /* ---- 8) 重置：quad 回恒等，原左上角像素恢复 ---- */
  await page.getByTestId('clip-quad-reset').click();
  await expect
    .poll(async () => (await readClipImageState(page, stage.imageClipId)).quad)
    .toEqual(IDENTITY);
  await settle(page, T);
  expectRed(await rgbaAtTopLeft(page, T, 0.05, 0.05), '重置后·左上角应恢复红');

  /* ---- 9) 关闭四角：store 字段删除，覆盖层消失 ---- */
  await page.getByTestId('clip-quad-enable').click();
  await expect.poll(async () => (await readClipImageState(page, stage.imageClipId)).quad).toBeNull();
  await expect(page.getByTestId('quad-overlay')).toHaveCount(0);
  await expect(page.getByTestId('quad-handle-tl')).toHaveCount(0);
});
