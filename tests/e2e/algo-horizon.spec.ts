import { expect, test } from '@playwright/test';
import { sampleL1, shootAlgo as shoot } from './_stage';

/**
 * 「地平线」生成器（horizon）的 E2E。
 *
 * 判据与体积云同族：这张图是「天空 + 地形」铺满整幅，lit / total 没有意义，
 * 分块均值对大面积渐变也不敏感。有区分度的是 spread（有没有结构）与
 * 逐通道的 sampleL1（换参数真的换图）。每次换参数都先各自断一次 spread，
 * 否则「两张纯色不同」会假通过。
 *
 * 五种风格由一组参数组合给出，所以「风格可分」是这一条最该守的东西：
 * 表里的某一行被写错、或某个 vec4 通道没接进 shader，都会表现为
 * 「选项能切、画面几乎不变」。
 *
 * 实测（1280×720 视口、`intRes: 480`、t = 6）：默认 spread **70**，五种风格
 * 最小 spread **46**、两两 L1 最小 **1346**（最大 7557）；`speed = 0` 时
 * t = 0 与 t = 4 的 L1 **0**，默认流速下 **743**；起伏 / 种子 / 水位三处
 * 换参数的 L1 是 **746 / 900 / 871**；同参数两次加载 L1 **0**。
 * 阈值因此取 spread 40（默认）/ 25（风格）、L1 200、L1 100（水位）——
 * 比实测低一档，又高于噪声底一个量级。
 */

const BASE = { intRes: '480' } as const;
const STYLES = ['scifi', 'vapor', 'voxel', 'scope', 'ps1'] as const;

test('默认画面有天空与地形，五种风格是五张不同的图', async ({ page }) => {
  test.setTimeout(240_000);

  const base = await shoot(page, 'horizon', { ...BASE }, 6);
  expect(base.spread, '默认画面要有天空 / 地形结构（纯色时 spread = 0）').toBeGreaterThan(40);

  const shots = [];
  for (const style of STYLES) {
    const s = await shoot(page, 'horizon', { ...BASE, style }, 6);
    expect(s.spread, `${style} 要有结构，不能是一片纯色`).toBeGreaterThan(25);
    shots.push(s);
  }

  for (let i = 0; i < STYLES.length; i++) {
    for (let j = i + 1; j < STYLES.length; j++) {
      const l1 = sampleL1(shots[i]!, shots[j]!);
      expect(l1, `${STYLES[i]} 与 ${STYLES[j]} 不能是同一张图`).toBeGreaterThan(200);
    }
  }
});

test('speed = 0 时画面与 t 逐点无关（全闭式，没有逐帧状态）', async ({ page }) => {
  test.setTimeout(180_000);
  const still0 = await shoot(page, 'horizon', { ...BASE, speed: 0 }, 0);
  const still4 = await shoot(page, 'horizon', { ...BASE, speed: 0 }, 4);
  expect(still0.spread, '基准配置要有结构').toBeGreaterThan(40);
  expect(sampleL1(still0, still4), 'speed = 0 时画面必须与 t 无关').toBeLessThan(1);

  const moving4 = await shoot(page, 'horizon', { ...BASE }, 4);
  expect(sampleL1(still0, moving4), '默认速度下镜头必须真的在飞').toBeGreaterThan(200);
});

test('地形起伏 / 种子 / 水位都是真的参数', async ({ page }) => {
  test.setTimeout(240_000);
  const flat = await shoot(page, 'horizon', { ...BASE, rough: 0.15 }, 6);
  const steep = await shoot(page, 'horizon', { ...BASE, rough: 1.6 }, 6);
  expect(flat.spread).toBeGreaterThan(25);
  expect(steep.spread).toBeGreaterThan(25);
  expect(sampleL1(flat, steep), '起伏必须改变地形轮廓').toBeGreaterThan(200);

  const seedA = await shoot(page, 'horizon', { ...BASE, patternSeed: 0.1 }, 6);
  const seedB = await shoot(page, 'horizon', { ...BASE, patternSeed: 0.8 }, 6);
  expect(sampleL1(seedA, seedB), '换种子必须换一套地形').toBeGreaterThan(200);

  const dry = await shoot(page, 'horizon', { ...BASE, seaLevel: -1 }, 6);
  const flooded = await shoot(page, 'horizon', { ...BASE, seaLevel: 0.6 }, 6);
  expect(sampleL1(dry, flooded), '水位必须改变水面覆盖范围').toBeGreaterThan(100);
});

test('同参数两次独立加载逐点一致', async ({ page }) => {
  test.setTimeout(180_000);
  for (const params of [
    { ...BASE },
    { ...BASE, style: 'vapor', rough: 1.3, sunEl: 18 },
  ] as Record<string, number | string>[]) {
    const a = await shoot(page, 'horizon', params, 5);
    const b = await shoot(page, 'horizon', params, 5);
    expect(sampleL1(a, b), `${JSON.stringify(params)} 同参数两次加载应当一致`).toBeLessThan(1);
    expect(a.spread).toBe(b.spread);
  }
});
