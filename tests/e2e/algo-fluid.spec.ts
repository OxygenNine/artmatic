import { expect, test, type Page } from '@playwright/test';
import { buildStage, gridStats, openDemo, sampleL1, settle, shootAlgo } from './_stage';

/**
 * 流体（`gpu-sim`）的渲染 E2E。
 *
 * 与粒子同族：**不断言「同一 t 逐像素相等」**（根 `AGENTS.md` 的两只 GPU 鬼
 * 会让它偶发），测量前用 `settle()` 渲到收敛，判据用 `sampleL1` 的逐通道小容差。
 *
 * 三条判据各自的理由：
 *  - `spread > 12`：黑底 + 墨流，纯色或空帧时 spread = 0，后面的 L1 全是假通过。
 *  - 换 `hue` / `motion` / `curl` 要换图：这三个都是**写进状态**的参数，改它们会
 *    从第 0 步重放 —— 如果重放路径坏了（比如快照恢复不精确），画面会「看起来
 *    没变」，而参数、派发、编译全都正常。
 *  - 回跳等价于顺序推进：硬约束 1.3。流体是这一族里**唯一需要显式 GPU 栅栏**
 *    的（见 `src/algos/AGENTS.md`），删掉 `engine.ts::fence()` 这条就会红。
 */

const BASE = { intRes: '480', simRes: '192' } as const;

/** 有结构的前置判据。 */
async function expectStructure(page: Page, t: number, label: string): Promise<void> {
  await settle(page, t);
  const s = await gridStats(page, t);
  expect(s.spread, `${label} 要有墨流（纯色时 spread = 0）`).toBeGreaterThan(12);
}

test('默认画面有墨流；色相 / 轨迹 / 涡量真的换图', async ({ page }) => {
  test.setTimeout(240_000);

  const base = await shootAlgo(page, 'fluid', { ...BASE }, 2);
  expect(base.spread, '默认画面要有结构').toBeGreaterThan(12);

  const hue = await shootAlgo(page, 'fluid', { ...BASE, hue: 0.05 }, 2);
  expect(sampleL1(base, hue), '换注入色相必须换图').toBeGreaterThan(30);

  const still = await shootAlgo(page, 'fluid', { ...BASE, motion: 'still' }, 2);
  expect(sampleL1(base, still), '换喷嘴轨迹必须换图').toBeGreaterThan(30);

  const calm = await shootAlgo(page, 'fluid', { ...BASE, curl: 0 }, 2);
  expect(sampleL1(base, calm), '关掉涡量约束后细丝应当明显不同').toBeGreaterThan(20);
});

test('seek 精确：从 t=4 回跳到 t=2 与顺序走到 t=2 是同一帧', async ({ page }) => {
  test.setTimeout(240_000);
  await page.goto('/');
  await page.waitForFunction(() => (window as never as { __artmatic?: unknown }).__artmatic);
  await openDemo(page);
  await buildStage(page, {
    id: 'f-seek',
    source: { type: 'algo', generator: 'fluid', params: { ...BASE } },
    end: 8,
  });

  await settle(page, 2);
  const atTwo = await gridStats(page, 2);
  expect(atTwo.spread).toBeGreaterThan(12);

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
    id: 'f-stable',
    source: { type: 'algo', generator: 'fluid', params: { ...BASE } },
    end: 8,
  });
  await expectStructure(page, 3, '基准帧');
  const a = await gridStats(page, 3);
  const b = await gridStats(page, 3);
  expect(sampleL1(a, b), '收敛后连渲两次应当一致').toBeLessThan(16);
});
