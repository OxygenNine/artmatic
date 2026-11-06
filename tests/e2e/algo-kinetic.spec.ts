import { expect, test } from '@playwright/test';
import { gridL1, sampleL1, shootAlgo as shoot } from './_stage';

/**
 * 「跃动几何」（`kinetic-shapes`）的 E2E。
 *
 * ## 判据为什么是分块 L1 + `lit`，而不是逐点比色
 *
 * 这是一张**黑底 + 若干实心形状**的图，但形状会进出场、位置可随机 ——
 * 16 个采样点有一半会落在空处（`sampleL1` 在那里恒为 0）。所以：
 *
 * - 「有没有东西」用 `lit`（黑底的图里它**精确**等于形状覆盖的像素数）
 *   与 `spread`（16 点里至少一点落在形状上时非零）。
 * - 「参数有没有接上」用 `gridL1`（4×4 分块均值）。形状横跨整幅，
 *   换形状 / 换动画改的是块内占比，分块均值对它敏感、对那点读回竞态不敏感。
 *
 * ## 为什么要有一组「静止构图」
 *
 * `rate = 0` + `spin = 0` + 硬切进出，画面就与 `t` 完全无关。这一组既是
 * **比形状的基准**（把动画变量全部按死，差异只可能来自形状），也是
 * 「全闭式、无逐帧状态」的判据：同一组参数在 t=0 与 t=4 必须逐点相同。
 */

/** 黑底：`lit` 才等于形状覆盖率（默认底色是近黑，不为 0）。 */
const BLACK = { bg: '#000000' } as const;

/** 静止构图：全部在场、不旋转、硬切进出。用来比对形状本身。 */
const STILL = {
  ...BLACK,
  intRes: '480',
  density: 4,
  size: 0.9,
  sizeVar: 0,
  inMode: 'cut',
  outMode: 'cut',
  duty: 1,
  rate: 0,
  spin: 0,
  rotVar: 0,
} as const;

test('出厂参数在黑底上画得出形状', async ({ page }) => {
  test.setTimeout(180_000);
  const shot = await shoot(page, 'kinetic-shapes', { ...BLACK, intRes: '480' }, 4);
  /*
   * `lit` 是判据，`spread` **不是**：形状只占一成多，而采样点是 4×4 的块中心
   * （与 6×3 的格子错开），实测有 18% 的概率一个都没落在形状上 —— 拿它当
   * 「有没有东西」的判据会偶发失败。黑底上的 `lit` 是精确的覆盖率。
   */
  expect(shot.lit / shot.total, '一整屏一个形状都没有 → 相位或循环算错了').toBeGreaterThan(0.02);
  expect(shot.mean, '画面几乎是纯黑').toBeGreaterThan(0.5);
});

test('形状选项真的换形状（圆 / 方 / 线 / 环互不相同）', async ({ page }) => {
  test.setTimeout(300_000);
  const circle = await shoot(page, 'kinetic-shapes', { ...STILL, shape: 'circle' }, 0);
  expect(circle.lit / circle.total, '圆没画出来').toBeGreaterThan(0.005);

  // 每一对都必须给出两张图；阈值取「块均值的量级」（0–255），远高于噪声底 0。
  for (const [name, value] of [
    ['square', 'square'],
    ['line', 'line'],
    ['ring', 'ring'],
  ] as const) {
    const other = await shoot(page, 'kinetic-shapes', { ...STILL, shape: value }, 0);
    expect(other.lit, `${name} 没画出来`).toBeGreaterThan(0);
    expect(gridL1(circle.grid, other.grid), `shape=${name} 与圆的画面几乎一致 → 分支没接上`).toBeGreaterThan(20);
  }
});

test('进出场：rate=0 与 t 无关，rate>0 逐帧在变', async ({ page }) => {
  test.setTimeout(240_000);
  /*
   * `rate = 0` ⇒ 每个形状的生存进度冻结在它的相位上，画面与 t 逐点相同。
   * 这条钉住两件事：动画确实只来自 `u_time × rate`（没有别处偷偷读 t），
   * 以及整条路径是闭式的（没有逐帧累积量）—— 写成「大于某个阈值」就测不到后者。
   */
  const still0 = await shoot(page, 'kinetic-shapes', { ...BLACK, intRes: '480', rate: 0 }, 0);
  const still4 = await shoot(page, 'kinetic-shapes', { ...BLACK, intRes: '480', rate: 0 }, 4);
  expect(sampleL1(still0, still4), 'rate=0 时画面对 t 必须完全无感').toBeLessThan(1);

  const live0 = await shoot(page, 'kinetic-shapes', { ...BLACK, intRes: '480', rate: 0.8, duty: 1 }, 0);
  const live1 = await shoot(page, 'kinetic-shapes', { ...BLACK, intRes: '480', rate: 0.8, duty: 1 }, 0.35);
  expect(live0.lit, 'rate>0 的基准帧也该有形状').toBeGreaterThan(0);
  expect(gridL1(live0.grid, live1.grid), 'rate>0 时两个时刻必须给出不同的画面').toBeGreaterThan(10);
});

test('进入方式真的接上了（硬切 vs 淡入）', async ({ page }) => {
  test.setTimeout(240_000);
  /*
   * 进出各占半个生存期、没有保持段 ⇒ 任一时刻都有一批形状处在过渡里。
   * 硬切与淡入在这一帧上的覆盖率必然不同（淡入的那批还半透明）。
   */
  const common = {
    ...BLACK,
    intRes: '480',
    density: 5,
    size: 0.9,
    duty: 1,
    rate: 0.9,
    inTime: 0.5,
    outTime: 0.5,
    outMode: 'cut',
  } as const;
  const cut = await shoot(page, 'kinetic-shapes', { ...common, inMode: 'cut' }, 0.3);
  const fade = await shoot(page, 'kinetic-shapes', { ...common, inMode: 'fade' }, 0.3);
  expect(cut.lit, '基准帧要有形状').toBeGreaterThan(0);
  expect(gridL1(cut.grid, fade.grid), 'inMode 换了但画面没变 → 动画表没派发到着色器').toBeGreaterThan(10);

  // 缩放同样：从零开始的那批应当比硬切小（覆盖更少）
  const zoom = await shoot(page, 'kinetic-shapes', { ...common, inMode: 'zoomIn' }, 0.3);
  expect(zoom.lit, '由小放大的帧覆盖率不该超过硬切').toBeLessThan(cut.lit);
});

test('同参数两次独立加载逐点一致（闭式 + 固定种子）', async ({ page }) => {
  test.setTimeout(240_000);
  for (const params of [
    { intRes: '480', layout: 'grid' },
    { intRes: '480', layout: 'random', density: 8 },
    { intRes: '480', shape: 'triangle', phase: 'order', rate: 0.7 },
  ] as Record<string, number | string>[]) {
    const a = await shoot(page, 'kinetic-shapes', { ...BLACK, ...params }, 2.5);
    const b = await shoot(page, 'kinetic-shapes', { ...BLACK, ...params }, 2.5);
    expect(sampleL1(a, b), `${JSON.stringify(params)} 两次独立加载应当一致`).toBeLessThan(1);
    expect(a.lit, `${JSON.stringify(params)} 两次加载都该有形状`).toBe(b.lit);
  }
});
