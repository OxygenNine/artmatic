import { expect, test } from '@playwright/test';
import { gridL1, shootAlgo as shoot } from './_stage';

/**
 * 黑洞（`algos/black-hole.ts`）的 E2E。
 *
 * 它是全家族唯一**不做 SDF 步进**的 3D 生成器：每像素沿测地线积分光子路径。
 * 判据不能照抄 `algos3d.spec` ——
 *
 * ⚠️ **不能用 `lit / total` 判「有没有东西」**：这张图的背景是星空 + 银河，
 * 几乎每个像素都非零（`lit` 的定义是 `v > 0`），实测占比 ≈ 1.0。第一版就是
 * 这么写的，两条断言全红，看上去像「渲染坏了」。
 *
 * 改用三个标量：`mean`（整幅亮度，不能全黑）、`spread`（单通道跨度，不能是
 * 纯色）、以及**与「盘压成一条细缝」的对照**（证明盘真的在贡献亮度）。
 */

const CFG = { intRes: '480' };

test('黑洞：画出盘面与星空，不是一张黑图', async ({ page }) => {
  test.setTimeout(180_000);
  const s = await shoot(page, 'black-hole', CFG, 5);
  expect(s.mean, '整体不能是一片黑').toBeGreaterThan(2);
  expect(s.spread, '必须有结构（纯色画面的单通道跨度为 0）').toBeGreaterThan(30);

  /*
   * 两个单向对照，各自证明「这一半真的在画」：
   *
   * - 关星空（`star: 0`）：剩下的只有盘与它的光晕；
   * - 压暗盘（`bright: 0.2`）：剩下的基本是星空。
   *
   * ⚠️ **不能用比值**。实测 mean 默认 17.1、暗盘 11.7 —— 比值只有 1.46，而星空
   * 本身就贡献 11.7。用绝对差（> 3）读的是「盘加了多少」，那才是想断言的量。
   * ⚠️ **也不靠「缩小盘」做对照**：温度按 `r / diskIn` 归一，内缘恒为白热 ——
   * 把盘压成 5.5..6 的细环之后它反而更亮（实测 mean 不降）。
   */
  const noStars = await shoot(page, 'black-hole', { ...CFG, star: 0 }, 5);
  expect(s.mean - noStars.mean, '星空必须贡献亮度（否则它根本没画）').toBeGreaterThan(3);

  const dim = await shoot(page, 'black-hole', { ...CFG, bright: 0.2 }, 5);
  expect(s.mean - dim.mean, '盘必须贡献亮度（否则它根本没画）').toBeGreaterThan(3);
  expect(gridL1(s.grid, dim.grid), '亮盘与暗盘必须改变画面（分块 L1）').toBeGreaterThan(10);
});

test('黑洞：打开环绕后时间真的在推进', async ({ page }) => {
  test.setTimeout(180_000);
  /*
   * ⚠️ 采样时刻必须落在片段内（`shootAlgo` 把 end 定在 8 秒）。第一版取了
   * t = 9 —— 那已经过了片段尾，画面是黑的，于是「必须有盘」那条以最令人
   * 困惑的方式失败。
   *
   * ⚠️ **必须显式给 `orbit`**。它出厂为 0（构图不被时间带着走），那时 4 秒里
   * 只有盘面的差动旋转在变；侧视时盘被压成一条细带，分块均值几乎不动 ——
   * 实测 L1 < 4，这条断言会以「时间没在走」的假象失败。
   */
  const cfg = { ...CFG, orbit: 0.2 };
  const a = await shoot(page, 'black-hole', cfg, 2);
  const b = await shoot(page, 'black-hole', cfg, 6);
  expect(a.mean, 't=2 必须有盘（否则下面的「不同」是空转）').toBeGreaterThan(2);
  expect(b.mean, 't=6 必须有盘').toBeGreaterThan(2);
  expect(gridL1(a.grid, b.grid), '环绕 4 秒后画面必须明显不同（分块 L1）').toBeGreaterThan(10);
});

test('黑洞：同 t 两次加载逐块一致（积分器没有随机源）', async ({ page }) => {
  test.setTimeout(180_000);
  const a = await shoot(page, 'black-hole', CFG, 5);
  const b = await shoot(page, 'black-hole', CFG, 5);
  expect(gridL1(a.grid, b.grid), '同 t 两次加载必须一致').toBeLessThan(1);
});

test('黑洞：盘外缘真的改变盘的大小', async ({ page }) => {
  test.setTimeout(180_000);
  const small = await shoot(page, 'black-hole', { ...CFG, diskIn: 3, diskOut: 6 }, 5);
  const big = await shoot(page, 'black-hole', { ...CFG, diskIn: 3, diskOut: 26 }, 5);
  expect(small.mean, '小盘也得有盘').toBeGreaterThan(2);
  expect(big.mean, '大盘也得有盘').toBeGreaterThan(2);
  expect(
    big.mean,
    '外缘拉到 26 时整幅必须更亮（否则 diskOut 根本没接上）',
  ).toBeGreaterThan(small.mean * 1.2);
  expect(gridL1(small.grid, big.grid), '两档画面必须不同').toBeGreaterThan(4);
});
