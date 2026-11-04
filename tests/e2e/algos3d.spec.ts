import { expect, test, type Page } from '@playwright/test';
import { gridL1, shootAlgo as shoot } from './_stage';

/**
 * 3D 光线步进生成器的 E2E。
 *
 * 这几个是**最贵**的生成器（每像素跑几十次 SDF，Mandelbulb 每次 SDF 又要迭代
 * 8 回），所以只断两件事，都是标量：
 *   1. 真的画出了实体（**覆盖像素数**，不是「均值 > 0」—— 均值会被几个亮像素
 *      抬起来，只画一条线的画面在它下面也会「通过」）；
 *   2. 换参数真的换画面（**先证明两边都不空**再比不同，否则「两张黑图不同」
 *      会假通过）。
 *
 * 「换了画面」的判据是**分块均值的 L1 距离**（实现在 `_stage.ts::gridStats`
 * / `gridL1`，那里写了为什么不可以用覆盖像素数之差、为什么不可以逐像素比）。
 * 阈值（4 / 10 / 20）离噪声底（0.000）有四个数量级的余量。
 *
 * ⚠️ **每个配置都要重载页面。** `buildStage` 是「加一条新轨」，而 `addTrack`
 * 是 push（新轨 z 更低）—— 连着调两次，第一条轨一直盖在上面，后面的测量全是
 * 在量第一个源。量帧成本时被骗过一次（10 个配置量出来一模一样）。
 *
 * 也**不做逐像素相等**：headless 里有一条已知的 GPU 读回竞态
 * （见 algo-sim.spec 头注）。
 */

test('Mandelbulb：画出实体、幂次真的改变形体', async ({ page }) => {
  test.setTimeout(120_000);

  const p8 = await shoot(page, 'mandelbulb', { intRes: '480', power: 8, iter: 8 });
  expect(p8.lit / p8.total, 'power=8 应当是一团实心结构').toBeGreaterThan(0.02);

  const p3 = await shoot(page, 'mandelbulb', { intRes: '480', power: 3, iter: 8 });
  expect(p3.lit / p3.total, 'power=3 也必须有实体，否则下面的「不同」是空转').toBeGreaterThan(
    0.005,
  );
  /*
   * 均值差的阈值从 0.2 降到 0.1：**着色模型换过一次**（三项假光照 → 半球环境光
   * + GGX + 软阴影），旧模型的明暗由 `lam * 0.6` 主导，而 `lam` 与形体高度相关；
   * 新模型里环境光与阴影都在归一化整体亮度，实测 power 3 与 8 的均值差只剩 0.16。
   * 形体确实变了 —— 那是下面那条 L1 在守的事，这条只负责挡「两张一样亮的图」。
   */
  expect(Math.abs(p3.mean - p8.mean), 'power 应当改变画面').toBeGreaterThan(0.1);
  expect(gridL1(p3.grid, p8.grid), '两个幂次的画面应当处处不同（分块 L1）').toBeGreaterThan(20);
});

/*
 * 光照模型本身的守卫。三条判据各自对应一种真实的坏法，**都不是「像素变了」**：
 *
 * | 判据 | 抓什么 |
 * |---|---|
 * | `L1 > 4` | 阴影根本没接上（恒返 1 / uniform 没派发）—— 两张图一模一样 |
 * | `mean 比 > 0.5` | 全自阴影：起点没抬离表面，或 mint 太小 |
 * | `mean 比 < 0.97` | 阴影过弱：只压了几个像素，等于没做 |
 *
 * 顺带钉住一条踩过的坑：软阴影的步长上界如果按 `mint * 8` 夹（而不是按 `maxt`
 * 的比例），12 步总共只走不到一个单位，射线还没到遮挡物就用完了步数 ——
 * 那时的表现正是「mean 比 ≈ 0.93，看起来像阴影很弱」。
 */
test('Mandelbulb：阴影真的在遮挡，而且没有吃掉整个物体', async ({ page }) => {
  test.setTimeout(180_000);
  const off = await shoot(page, 'mandelbulb', { intRes: '480', power: 8, iter: 8, shadow: 0 });
  const on = await shoot(page, 'mandelbulb', { intRes: '480', power: 8, iter: 8, shadow: 0.9 });
  expect(on.lit / on.total, '开阴影后必须有实体').toBeGreaterThan(0.02);
  expect(gridL1(on.grid, off.grid), '阴影必须改变画面').toBeGreaterThan(4);
  const ratio = on.mean / off.mean;
  expect(ratio, '阴影不能把整个物体吃掉').toBeGreaterThan(0.5);
  expect(ratio, '阴影必须真的压暗，而不是只动几个像素').toBeLessThan(0.97);
});

test('Mandelbulb：阴影跟着光走，不是一张画死的图', async ({ page }) => {
  test.setTimeout(180_000);
  const a = await shoot(page, 'mandelbulb', { intRes: '480', power: 8, iter: 8, lightAz: -45, shadow: 0.9 });
  const b = await shoot(page, 'mandelbulb', { intRes: '480', power: 8, iter: 8, lightAz: 135, shadow: 0.9 });
  expect(a.lit / a.total).toBeGreaterThan(0.02);
  expect(b.lit / b.total).toBeGreaterThan(0.02);
  expect(gridL1(a.grid, b.grid), '换光向 ⇒ 阴影必须换边').toBeGreaterThan(10);
});

test('Mandelbulb：迭代次数决定细节层级（同幂次下画面不同）', async ({ page }) => {
  test.setTimeout(120_000);
  const a = await shoot(page, 'mandelbulb', { intRes: '480', power: 8, iter: 4 });
  const b = await shoot(page, 'mandelbulb', { intRes: '480', power: 8, iter: 12 });
  expect(a.lit / a.total, 'iter=4 也要有实体').toBeGreaterThan(0.02);
  expect(b.lit / b.total, 'iter=12 也要有实体').toBeGreaterThan(0.02);
  // 细节层级变了 ⇒ 分块亮度分布必然不同（面积可以几乎不变，见文件头）
  expect(gridL1(b.grid, a.grid), '迭代次数应当改变画面（分块 L1）').toBeGreaterThan(10);
});

test('Apollonian：画出球堆（不是一块平面 / 一条线），迭代次数改变层数', async ({ page }) => {
  test.setTimeout(120_000);

  const i8 = await shoot(page, 'apollonian', { intRes: '480', iter: 8, dist: 6 });
  expect(i8.lit / i8.total, '应当有实心球体').toBeGreaterThan(0.02);
  // DE 退化成 y=0 平面时（第一版那个 bug）画面会被一整块平面铺满
  expect(i8.lit / i8.total, '不该铺满整幅 —— 那是 DE 退化成平面的形态').toBeLessThan(0.9);

  const i4 = await shoot(page, 'apollonian', { intRes: '480', iter: 4, dist: 6 });
  expect(i4.lit / i4.total, 'iter=4 也要有实体').toBeGreaterThan(0.005);
  expect(Math.abs(i4.mean - i8.mean), '迭代次数应当改变球堆的层数').toBeGreaterThan(0.2);
  expect(gridL1(i4.grid, i8.grid), '迭代次数应当改变画面（分块 L1）').toBeGreaterThan(4);
});

/**
 * 跨页面加载的确定性 —— 也是上面那些 L1 阈值的**噪声底**。
 *
 * 分形的着色里没有时钟、没有随机：同参数同 t 在两次独立加载里必须给出同一
 * 张图（`u_seed` 走的也是 `hashSeed`，见硬约束 1.2）。用分块 L1 而不是逐像素
 * 相等，是因为 headless 有一条已知的 GPU 读回竞态（单帧 ±15 字节）。
 *
 * 这条同时把「L1 > N 才算画面变了」这个判据钉在地上：噪声底必须远小于 N，
 * 否则上面三条只是在量噪声。
 */
/*
 * ---- 无限延伸 + 穿梭镜头 ----
 *
 * 两条判据都选**结构性**的量，不是「像素变了」：
 * - 无限延伸的形态特征是「画面里没有背景」——单体档有 60% 的天空，铺满空间的
 *   阵列不可能有。用**亮像素占比**（lit）比，阈值给的是数量级差。
 * - 穿梭是「镜头在移动」，与环绕的区别在于视点位置完全不同。用分块 L1 比，
 *   同时先证明两边都有实体（否则「两张黑图不同」会假通过）。
 */
test('Menger：无限延伸真的铺满画面，不只是换了张图', async ({ page }) => {
  test.setTimeout(180_000);
  const bounded = await shoot(page, 'menger', { intRes: '480', extent: 'bounded' });
  const infinite = await shoot(page, 'menger', { intRes: '480', extent: 'infinite' });
  expect(bounded.lit / bounded.total, '单体档必须有实体').toBeGreaterThan(0.02);
  expect(infinite.lit / infinite.total, '无限档必须有实体').toBeGreaterThan(0.02);
  expect(
    infinite.lit / infinite.total,
    '无限延伸应当几乎没有背景（单体档有大片天空）',
  ).toBeGreaterThan(bounded.lit / bounded.total + 0.3);
  expect(gridL1(infinite.grid, bounded.grid), '两档画面必须不同').toBeGreaterThan(10);
});

test('Menger：穿梭镜头走的是另一条路径，而不是绕原点公转', async ({ page }) => {
  test.setTimeout(180_000);
  const cfg = { intRes: '480', extent: 'infinite' };
  const orbit = await shoot(page, 'menger', cfg);
  const fly = await shoot(page, 'menger', { ...cfg, camera: 'fly' });
  expect(orbit.lit / orbit.total, '环绕档必须有实体（否则下面的「不同」是空转）').toBeGreaterThan(
    0.02,
  );
  expect(fly.lit / fly.total, '穿梭档必须有实体').toBeGreaterThan(0.02);
  expect(gridL1(fly.grid, orbit.grid), '换镜头必须换视点（分块 L1）').toBeGreaterThan(10);
});

test('Menger：穿梭镜头也是确定的（路径是 t 的闭式函数，不许有随机源）', async ({ page }) => {
  test.setTimeout(180_000);
  const cfg = { intRes: '480', extent: 'infinite', camera: 'fly' };
  const a = await shoot(page, 'menger', cfg);
  const b = await shoot(page, 'menger', cfg);
  expect(gridL1(a.grid, b.grid), '同 t 两次加载必须一致').toBeLessThan(1);
});

test('Apollonian：穿梭镜头与环绕给出不同的视点', async ({ page }) => {
  test.setTimeout(180_000);
  const orbit = await shoot(page, 'apollonian', { intRes: '480', iter: 8 });
  const fly = await shoot(page, 'apollonian', { intRes: '480', iter: 8, camera: 'fly' });
  expect(orbit.lit / orbit.total, '环绕档必须有实体').toBeGreaterThan(0.02);
  expect(fly.lit / fly.total, '穿梭档必须有实体').toBeGreaterThan(0.02);
  expect(gridL1(fly.grid, orbit.grid), '换镜头必须换视点（分块 L1）').toBeGreaterThan(10);
});

test('同参数跨两次加载逐块一致（分块 L1 的噪声底）', async ({ page }) => {
  test.setTimeout(120_000);
  /* 带上阴影：软阴影是唯一可能被写成「每帧抖一下」的东西（抖动换平滑是常规做法，
     而这里不许）。开了阴影仍然逐块一致 ⇒ 阴影路径里没有随机源。 */
  const cfg = { intRes: '480', power: 8, iter: 8, shadow: 0.9, shadowSteps: 16 };
  const a = await shoot(page, 'mandelbulb', cfg);
  const b = await shoot(page, 'mandelbulb', cfg);
  const noise = gridL1(a.grid, b.grid);
  expect(noise, '同参数两次加载应当逐块一致（只允许读回竞态那点噪声）').toBeLessThan(1);
  expect(Math.abs(a.mean - b.mean)).toBeLessThan(0.05);
});

/* ------------------------------------------------------------ 3D 场景（P4） */

/*
 * 场景是**唯一**把多个几何体放进同一个距离场的生成器，所以这里的判据只能是
 * 「组合真的发生了」——而它有一个特别好用的形态：**减**。
 *
 * `max(d1, -d2)` 只有在两个 SDF 都被求值、并且步进走的是合并后的场时才可能
 * 挖出洞。如果实现退化成「渲两次再 blend」（或者第二槽根本没进距离场），减法
 * 会什么也不做 —— 而这正是最可能出现的退化形态（也是 P4 之前唯一做得到的形态）。
 */
test('3D 场景：两个几何体都进了同一份距离场（减法真的挖出东西）', async ({ page }) => {
  test.setTimeout(180_000);

  const two = await shoot(page, 'scene-3d', { intRes: '480' });
  expect(two.lit / two.total, '出厂的两个物体都要看得见').toBeGreaterThan(0.01);

  // 只留第一槽：第二槽的 `none` 不该留下任何东西
  const one = await shoot(page, 'scene-3d', { intRes: '480', 's2.def': 'none' });
  expect(one.lit / one.total, '单槽也必须有实体').toBeGreaterThan(0.01);
  expect(gridL1(one.grid, two.grid), '去掉第二槽必须改变画面').toBeGreaterThan(4);

  /*
   * 「挖掉」的判据要挑**能被证伪**的那一种。
   *
   * 第一版在右脸上挖一个半径 0.5 的球，`lit` 一动不动 —— 不是减法没接上，而是
   * **海绵是格架**：挖掉一块，后面还是料，轮廓一个像素都不变。而挖在正中心更
   * 糟：只会掏出一个封闭空腔，外面完全看不出。
   *
   * 所以让第二槽**大到能盖住整个海绵**（zoom 1.8 → 世界半径约 2.2，海绵外框
   * 只有 0.72）：减法把整块料去掉，画面上一个实体像素都不该剩。第二槽没进
   * 距离场的话，这里会原封不动地等于 `one`。
   */
  const minus = await shoot(page, 'scene-3d', {
    intRes: '480',
    's2.op': 'subtract',
    's2.x': 0,
    's2.z': 0,
    's2.zoom': 1.8,
  });
  expect(minus.lit / minus.total, '整个海绵都被挖掉了').toBeLessThan(0.005);
  expect(gridL1(one.grid, minus.grid), '减法必须改变画面（分块 L1）').toBeGreaterThan(20);
});

test('3D 场景：两个槽可以无限延伸，互不影响（折叠在各自的局部坐标里）', async ({ page }) => {
  test.setTimeout(180_000);
  const both = await shoot(page, 'scene-3d', {
    intRes: '480',
    's1.fold': 'on',
    's1.zoom': 1.6,
    dist: 2.2,
    's2.def': 'none',
  });
  expect(both.lit / both.total, '无限延伸下必须有结构').toBeGreaterThan(0.05);

  // 扭转在折叠域里会让 cell 边界撕开，所以打开无限延伸时它必须被藏起来
  // （这条由 `sdf-scene.test.ts` 的 visibleParams 断言钉住，这里只确认画面成立）。
  const orb = await shoot(page, 'scene-3d', { intRes: '480', 's2.def': 'none' });
  expect(gridL1(orb.grid, both.grid), '无限延伸必须改变画面').toBeGreaterThan(10);
});

test('3D 场景：深度输出（P2 蒙版源）与画面是两个不同的东西', async ({ page }) => {
  test.setTimeout(180_000);
  /*
   * 拉近到物体占满画幅再量：`samples` 是 4×4 个**点**采样，远景下那几个点
   * 全落在黑底上，深度图的最大值会是 0（而画面明明有东西）。
   */
  const cfg = { intRes: '480', dist: 2.4, 's1.zoom': 1.2, 's2.def': 'none' };
  const color = await shoot(page, 'scene-3d', cfg);
  const depth = await shoot(page, 'scene-3d', { ...cfg, outDepth: 'depth' });

  expect(color.lit / color.total).toBeGreaterThan(0.2);
  expect(depth.lit / depth.total, '深度模式下实体区域同样要非零').toBeGreaterThan(0.2);
  expect(gridL1(depth.grid, color.grid), '深度不是画面').toBeGreaterThan(20);
  // 近 = 亮：贴着镜头的表面应当接近纯白（`maxDist` 默认 9，命中距离约 1~2）
  expect(Math.max(...depth.samples), '最近的表面应当接近纯白').toBeGreaterThan(150);
});
