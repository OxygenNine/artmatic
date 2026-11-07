import { expect, test } from '@playwright/test';
import { sampleL1, shootAlgo as shoot } from './_stage';

/**
 * 「体积云」生成器（`volumetric-cloud`）的 E2E。
 *
 * ## 判据为什么是 spread + 采样 L1 + 亮度
 *
 * 这张图是「大片天空 + 云团」，`lit / total` 没有意义（天空本来就非零），
 * 分块均值又对「铺满整幅的软渐变」不敏感。有区分度的只有三个：
 *
 * 1. `spread`（采样点单通道最大跨度）—— 这一帧真的有「云 vs 天空」的结构。
 *    整幅纯色（阈值把云切没了 / 着色器退化成常量）时它必然是 0。
 * 2. `sampleL1`（逐通道）—— 换参数真的换图。
 * 3. `mean` 的单调性 —— 云量推上去画面必须更亮（云比天空亮）。
 *
 * ⚠️ 每条换参数的断言都要**先各自断一次 spread**，否则「两张纯色不同」
 * 会假通过（`algo-noise.spec.ts` 的 Kleinian 那一枪）。
 *
 * 实测（1280×720 视口、`intRes: 480`、t = 4）：默认 spread **110**、mean 148.8；
 * 云量 0 / 0.55 / 1 的 mean 是 132.1 / 148.8 / 151.6（L1 1050）；换种子
 * （0.1 vs 0.6）L1 **999**、spread 86；`speed = 0` 时 t = 0 与 t = 4 的
 * L1 **0**，默认流速下同样是这两帧 L1 **921**；同配置两次独立加载 L1 **0**。
 * 阈值因此取 spread 40 / L1 200 / L1 50（流速那条）—— 比实测低一档，
 * 又高于噪声底（0）一个量级。
 */

const BASE = { intRes: '480' } as const;

test('默认画面有云与天的结构，云量 / 种子都是真的参数', async ({ page }) => {
  test.setTimeout(180_000);

  const base = await shoot(page, 'volumetric-cloud', { ...BASE }, 4);
  expect(base.spread, '默认画面应当有「云 + 天空」的结构（纯色时 spread = 0）').toBeGreaterThan(40);

  /*
   * 云量走的是**阈值**：0 → 几乎无云（切点抬到 fbm 的 p99 之上），1 → 大半是云。
   * 两端都必须在读数范围内 —— 这是那个「按实测分位数定阈值」的判据。
   */
  const empty = await shoot(page, 'volumetric-cloud', { ...BASE, cover: 0 }, 4);
  const full = await shoot(page, 'volumetric-cloud', { ...BASE, cover: 1 }, 4);
  expect(full.mean, '云量拉满必须更亮（云比天空亮）').toBeGreaterThan(base.mean);
  expect(base.mean, '云量中间档必须比 0 亮').toBeGreaterThan(empty.mean);
  expect(sampleL1(empty, full), '云量两端必须是两张不同的图').toBeGreaterThan(200);

  // 种子只挪采样坐标：换了它必须是另一套云。
  const seedA = await shoot(page, 'volumetric-cloud', { ...BASE, patternSeed: 0.1 }, 4);
  const seedB = await shoot(page, 'volumetric-cloud', { ...BASE, patternSeed: 0.6 }, 4);
  expect(seedA.spread, '换种子后仍要有结构').toBeGreaterThan(40);
  expect(sampleL1(seedA, seedB), '换种子必须换一套云').toBeGreaterThan(200);
});

test('speed = 0 时画面对 t 完全无感（全闭式，没有逐帧状态）', async ({ page }) => {
  test.setTimeout(180_000);
  const still0 = await shoot(page, 'volumetric-cloud', { ...BASE, speed: 0 }, 0);
  const still4 = await shoot(page, 'volumetric-cloud', { ...BASE, speed: 0 }, 4);
  expect(still0.spread, '基准配置要有结构').toBeGreaterThan(40);
  expect(sampleL1(still0, still4), 'speed = 0 时画面必须与 t 逐点无关').toBeLessThan(1);

  // 反过来：默认流速下 4 秒必须流走（否则 u_time 根本没接上）。
  const moving4 = await shoot(page, 'volumetric-cloud', { ...BASE }, 4);
  expect(sampleL1(still0, moving4), '默认流速下云必须在漂').toBeGreaterThan(50);
});

/**
 * 跨两次独立加载的确定性 —— 也是上面那些 L1 阈值的**噪声底**。
 *
 * 抖动取自 `gl_FragCoord` 的 hash（像素的纯函数），噪声只做平移；
 * 同一份工程的同一个片段 id ⇒ 同一个 `u_seed` ⇒ 同一张图。
 */
test('同参数两次独立加载逐点一致', async ({ page }) => {
  test.setTimeout(180_000);
  for (const params of [
    { ...BASE },
    { ...BASE, cover: 0.8, sunEl: 45, yaw: 65 },
  ] as Record<string, number | string>[]) {
    const a = await shoot(page, 'volumetric-cloud', params, 3);
    const b = await shoot(page, 'volumetric-cloud', params, 3);
    expect(sampleL1(a, b), `${JSON.stringify(params)} 同参数两次加载应当一致`).toBeLessThan(1);
    expect(a.spread, `${JSON.stringify(params)} 两次加载都该有结构`).toBe(b.spread);
  }
});
