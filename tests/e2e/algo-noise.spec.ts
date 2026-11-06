import { expect, test } from '@playwright/test';
import { sampleL1, shootAlgo as shoot } from './_stage';

/**
 * 「噪声」生成器（`noise-field`）的 E2E。
 *
 * ## 判据为什么是 `spread` + 采样 L1
 *
 * 这张图**铺满整幅**（每一族都没有「背景」），所以 `lit / total` 恒为 ≈ 100%
 * —— 拿它判「有没有东西」等于什么都没测（`algos2d.spec` 的 Kleinian 踩过同一枪）。
 * 有区分度的只有两个：
 *
 * 1. `spread`（采样点单通道最大跨度）> 阈值 —— 这一帧真的有结构。整幅纯色
 *    （着色器退化成常量、或某个族根本没接上）时它必然是 0。
 * 2. 换参数 → `sampleL1`（逐通道）足够大。**每个配置都先各自断一次 `spread`**，
 *    否则「两张纯色不同」会假通过。
 *
 * 实测（1280×720 视口、480p 内部渲染、默认参数）：spread 101~255；
 * 换族 2523~4824、2D 漂移 4 秒 3150、3D 穿行 4 秒 3330、关域扭曲 1044、
 * 改对比 1401、开色阶（4 级）852、演化 0.02 格 126 / 1 格 1653、
 * 同配置两次加载 **0**。
 * 阈值因此取 spread 60 / L1 400 —— 比噪声底高三个数量级，比实测最小值低一个数量级。
 *
 * ⚠️ **采样 L1 只数 16 个点，读数会随视口尺寸差一个量级**：同一条「色阶 8 级」
 * 在 1280×800 的探测里是 4371，在 1280×720（E2E 的窗口）里只剩 **345**。
 * 所以参数的强度别贴着阈值挑 —— 色阶用例因此用 4 级（量化步长翻倍）而不是 8 级。
 */

const BASE = { intRes: '480' } as const;

test('三族都画得出结构，而且互不相同（value / gradient / voronoi）', async ({ page }) => {
  test.setTimeout(180_000);

  const value = await shoot(page, 'noise-field', { ...BASE, family: 'value', space: '2d' }, 0);
  expect(value.spread, 'value 应当有结构（纯色时 spread = 0）').toBeGreaterThan(60);

  const gradient = await shoot(page, 'noise-field', { ...BASE, family: 'gradient', space: '2d' }, 0);
  expect(gradient.spread, 'gradient 应当有结构').toBeGreaterThan(60);
  expect(sampleL1(value, gradient), '换族必须换图 —— 否则 select 的派发是死的').toBeGreaterThan(400);

  const cells = await shoot(page, 'noise-field', { ...BASE, family: 'voronoi', voronoi: 'cells' }, 0);
  expect(cells.spread, 'voronoi 细胞应当有结构').toBeGreaterThan(60);
  expect(sampleL1(value, cells), 'voronoi 与 value 必须不同').toBeGreaterThan(400);

  /*
   * 形态参数是 `visibleWhen: family === 'voronoi'` 下的一档 —— 它最容易出的错是
   * 「选项在，但派发还是 family 那一路」，表现是拖了形态画面不动。
   */
  const edges = await shoot(page, 'noise-field', { ...BASE, family: 'voronoi', voronoi: 'edges' }, 0);
  expect(edges.spread, 'voronoi 边界应当有结构').toBeGreaterThan(60);
  expect(sampleL1(cells, edges), '细胞与边界必须是两张图').toBeGreaterThan(400);
});

test('流水线：2D 平移 / 3D 穿行 / 演化原地换形', async ({ page }) => {
  test.setTimeout(240_000);

  const flat0 = await shoot(page, 'noise-field', { ...BASE, family: 'value', space: '2d' }, 0);
  const flat4 = await shoot(page, 'noise-field', { ...BASE, family: 'value', space: '2d' }, 4);
  expect(sampleL1(flat0, flat4), '2D 场应当在平面上漂移').toBeGreaterThan(400);

  /*
   * 两种模式**都在三维里采样**，差别只在流速怎么用。所以 t=0 且 speed 用不上时
   * 它们必须是**同一张切片** —— 这条同时钉住「2D 不是另一套 2D 噪声」：
   * 谁哪天为了省性能把 2D 退回二维采样，这里立刻红（那样画面会换一套噪点）。
   */
  const deep0 = await shoot(page, 'noise-field', { ...BASE, family: 'value', space: '3d' }, 0);
  expect(sampleL1(flat0, deep0), 't=0 时 2D 与 3D 是同一条 z=0 切片').toBeLessThan(1);

  const deep4 = await shoot(page, 'noise-field', { ...BASE, family: 'value', space: '3d' }, 4);
  expect(deep0.spread, '3D 也要有结构').toBeGreaterThan(60);
  expect(sampleL1(deep0, deep4), '3D 切片应当沿 z 穿行').toBeGreaterThan(400);
  expect(sampleL1(flat4, deep4), '流速的两种用法必须给出两张图').toBeGreaterThan(400);

  /*
   * 演化是**进度**：小步长 → 小变化，大步长 → 大变化。这条挡的是「演化其实
   * 被取整 / 被当成开关」——那样 0 → 0.02 要么毫无变化（= 0），要么和小步长
   * 无关地整幅换掉。实测（720p、16 个采样点）0.02 → 126、0.2 → 1134、1 → 1653。
   */
  const ev002 = await shoot(page, 'noise-field', { ...BASE, family: 'value', space: '2d', evolve: 0.02 }, 0);
  const ev1 = await shoot(page, 'noise-field', { ...BASE, family: 'value', space: '2d', evolve: 1 }, 0);
  const small = sampleL1(flat0, ev002);
  const big = sampleL1(flat0, ev1);
  expect(small, '演化 0.02 格应当有细微变化（取整实现会给 0）').toBeGreaterThan(20);
  expect(small, '演化 0.02 格不该整幅换掉').toBeLessThan(400);
  expect(big, '演化 1 格应当明显换形').toBeGreaterThan(400);
  expect(big, '变化应当随进度增长，而不是一步跳到底').toBeGreaterThan(small * 2);

  /*
   * speed=0 ⇒ 画面与 t **逐点相同**。这条同时钉两件事：
   *   ① 动画确实只来自流速（没有别处偷偷读 u_time / frame）；
   *   ② 它是闭式的（同一 t 两渲一样，硬约束 1.1）。
   * 写成「大于某个阈值」就测不到 ② 了。
   */
  const still0 = await shoot(page, 'noise-field', { ...BASE, family: 'value', space: '2d', speed: 0 }, 0);
  const still4 = await shoot(page, 'noise-field', { ...BASE, family: 'value', space: '2d', speed: 0 }, 4);
  expect(sampleL1(still0, still4), 'speed=0 时画面对 t 必须完全无感').toBeLessThan(1);
});

test('域扭曲 / 对比 / 色阶都是真的参数', async ({ page }) => {
  test.setTimeout(180_000);

  const base = await shoot(page, 'noise-field', { ...BASE, family: 'value', space: '2d' }, 0);
  expect(base.spread, '基准配置要有结构').toBeGreaterThan(60);

  const noWarp = await shoot(page, 'noise-field', { ...BASE, family: 'value', space: '2d', warp: 0 }, 0);
  expect(sampleL1(base, noWarp), '关掉域扭曲必须改变图案').toBeGreaterThan(400);

  const hard = await shoot(page, 'noise-field', { ...BASE, family: 'value', space: '2d', contrast: 0.5 }, 0);
  expect(sampleL1(base, hard), '对比必须改变画面').toBeGreaterThan(400);

  /*
   * 色阶用 4 级而不是 8 级：8 级的量化步长只有 32/255，采样 L1 实测 345
   * （阈值要压到 200 才过）—— 那已经接近「判据在测噪声」了。4 级步长翻倍，
   * 信号与阈值之间才留得住余量。
   */
  const stepped = await shoot(page, 'noise-field', { ...BASE, family: 'value', space: '2d', levels: 4 }, 0);
  expect(sampleL1(base, stepped), '色阶必须改变画面').toBeGreaterThan(400);
});

/**
 * 跨两次独立加载的确定性 —— 也是上面那些 L1 阈值的**噪声底**。
 *
 * 噪声全建在无 sin 的 hash 族上、坐标只做平移（`u_seed` 的来源是
 * `hashSeed(project.seed, clipId)`，同一份工程的同一个片段 id 恒定），
 * 所以同参数同 t 在两次加载里必须给出同一张图。
 */
test('同参数两次独立加载逐点一致（采样 L1 的噪声底）', async ({ page }) => {
  test.setTimeout(180_000);
  for (const params of [
    { family: 'value', space: '2d' },
    { family: 'gradient', space: '2d' },
    { family: 'voronoi', voronoi: 'edges', space: '3d' },
  ] as Record<string, number | string>[]) {
    const a = await shoot(page, 'noise-field', { ...BASE, ...params }, 3);
    const b = await shoot(page, 'noise-field', { ...BASE, ...params }, 3);
    expect(sampleL1(a, b), `${JSON.stringify(params)} 同参数两次加载应当一致`).toBeLessThan(1);
    expect(a.spread, `${JSON.stringify(params)} 两次加载都该有结构`).toBe(b.spread);
  }
});
