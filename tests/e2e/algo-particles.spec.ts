import { expect, test, type Page } from '@playwright/test';
import { buildStage, gridStats, openDemo, sampleL1, settle, shootAlgo } from './_stage';

/**
 * 粒子（`gpu-sim`）的渲染 E2E。
 *
 * 与 `sim` 型那条同族：不断言「同一 t 逐像素相等」。根 `AGENTS.md` 写了两只
 * 已知的 GPU 鬼（非整数倍缩放采样、大参数 sin hash），逐字节相等在 GPU 上是
 * **偶发**失败。测量前用 `settle()` 渲到收敛，等于把那帧丢掉；判据用
 * `sampleL1` 的逐通道小容差，而不是 `hashAt` 的严格相等。
 *
 * 「参数生效」用 `sampleL1` / `spread`：粒子是黑底 + 一群亮点，分块均值对
 * 大面积渐变不敏感，但换形状 / 配色 / 投影会挪动采样点，够用。
 */

const BASE = { intRes: '480' } as const;

/** 有结构的前置判据：纯色或空帧时 spread = 0，后面的 L1 全是假通过。 */
async function expectStructure(page: Page, t: number, label: string): Promise<void> {
  await settle(page, t);
  const s = await gridStats(page, t);
  expect(s.spread, `${label} 要有粒子（纯色时 spread = 0）`).toBeGreaterThan(12);
}

test('默认画面有粒子；换形状、配色、投影真的换图', async ({ page }) => {
  test.setTimeout(240_000);

  const base = await shootAlgo(page, 'particles', { ...BASE }, 3);
  expect(base.spread, '默认画面要有结构').toBeGreaterThan(12);

  const shape = await shootAlgo(page, 'particles', { ...BASE, shape: 'box' }, 3);
  expect(shape.spread, '盒形发射器也要有结构').toBeGreaterThan(12);
  expect(sampleL1(base, shape), '换发射器形状必须换图').toBeGreaterThan(30);

  const colored = await shootAlgo(
    page, 'particles',
    { ...BASE, colorStart: '#00ff00', colorEnd: '#0000ff' }, 3,
  );
  expect(sampleL1(base, colored), '换出生/消失配色必须换图').toBeGreaterThan(30);

  const threeD = await shootAlgo(page, 'particles', { ...BASE, dimension: '3d' }, 3);
  expect(threeD.spread, '三维投影也要有结构').toBeGreaterThan(12);
  expect(sampleL1(base, threeD), '2D / 3D 共用状态但投影不同').toBeGreaterThan(20);
});

test('seek 精确：从 t=4 回跳到 t=2 与顺序走到 t=2 是同一帧', async ({ page }) => {
  test.setTimeout(240_000);
  await page.goto('/');
  await page.waitForFunction(() => (window as never as { __artmatic?: unknown }).__artmatic);
  await openDemo(page);
  await buildStage(page, {
    id: 'p-seek',
    source: { type: 'algo', generator: 'particles', params: { ...BASE } },
    end: 8,
  });

  // 先顺序走到 2，测量（settle 把启动窗口那一帧丢掉）。
  await settle(page, 2);
  const atTwo = await gridStats(page, 2);
  expect(atTwo.spread).toBeGreaterThan(12);

  // 往前走到 4，再回跳到 2。seek 必须从最近快照恢复 + 顺序补步，
  // 结果与第一次逐点相同（硬约束 1.3）。
  await settle(page, 4);
  await settle(page, 2);
  const backAtTwo = await gridStats(page, 2);
  expect(sampleL1(atTwo, backAtTwo), '回跳后的状态必须等价于顺序推进').toBeLessThan(24);
});

test('同一 t 连渲稳定（收敛后差异落在 GPU 读回噪声量级）', async ({ page }) => {
  test.setTimeout(240_000);
  await page.goto('/');
  await page.waitForFunction(() => (window as never as { __artmatic?: unknown }).__artmatic);
  await openDemo(page);
  await buildStage(page, {
    id: 'p-stable',
    source: { type: 'algo', generator: 'particles', params: { ...BASE } },
    end: 8,
  });
  await expectStructure(page, 3, '基准帧');
  const a = await gridStats(page, 3);
  const b = await gridStats(page, 3);
  expect(sampleL1(a, b), '收敛后连渲两次应当一致').toBeLessThan(16);
});

test('素材精灵 / 发射密度图：控制平面拒未知 id，接受真实图片', async ({ page }) => {
  test.setTimeout(240_000);
  await page.goto('/');
  await page.waitForFunction(() => (window as never as { __artmatic?: unknown }).__artmatic);
  await openDemo(page);
  await buildStage(page, {
    id: 'p-asset',
    source: { type: 'algo', generator: 'particles', params: { ...BASE } },
    end: 8,
  });
  await expectStructure(page, 2, '基准帧');

  const bad = await page.evaluate(() => {
    const C = (window as never as {
      __artmatic: { control: { setClipSourceParams: (id: string, p: object) => Promise<{ ok: boolean; error?: { code?: string } }> } };
    }).__artmatic.control;
    return C.setClipSourceParams('p-asset', { spriteAsset: 'nope-not-in-project' });
  });
  expect(bad.ok, '凭空编的 assetId 必须被写入前置挡住').toBe(false);

  // 空串是合法值（解绑），不报错也不改画面。
  const cleared = await page.evaluate(() => {
    const C = (window as never as {
      __artmatic: { control: { setClipSourceParams: (id: string, p: object) => Promise<{ ok: boolean; data?: { values?: Record<string, unknown> } }> } };
    }).__artmatic.control;
    return C.setClipSourceParams('p-asset', { spriteAsset: '' });
  });
  expect(cleared.ok).toBe(true);
  expect(cleared.data?.values?.spriteAsset).toBe('');
});
