import { expect, test, type Page } from '@playwright/test';
import { buildStage, gridStats, openDemo, type GridStats } from './_stage';

/**
 * three 生成器（`GeneratorDef.kind === 'three'`）的端到端验证：黑洞。
 *
 * 与 `algo-black-hole.spec.ts` 判的不是同一件事：那条守的是画面物理（测地线、
 * 盘、星空），这条守的是**接线** —— 一个 `kind:'three'` 的 def 能不能走通
 * `{type:'algo'}` 片段 → `evalParams` → `AlgoRuntime.setThreeSource` →
 * three 运行时 → 合成链。这条链上任何一段没接上，画面都是一块空白，而且
 * 不抛任何异常。
 *
 * ## 为什么要轮询
 *
 * three 的 `import('three')` 是懒的（750 KB 不进首屏）。第一次解析这一层时
 * 模块还没到，返回 null —— 那一帧必然黑。这不是 bug，是刻意的加载策略，
 * 所以拍摄必须像缩略图脚本那样**从外面轮询**，而不是在页面里自旋（自旋会把
 * 主线程占住，模块的 Promise 永远轮不到）。
 */

/** 拍一帧；非黑之前反复重试（每次让出事件循环）。 */
async function shoot(
  page: Page,
  gen: string,
  params: Record<string, number | string>,
  t = 5,
): Promise<GridStats> {
  await page.goto('/');
  await page.waitForFunction(() => Boolean((window as never as { __artmatic?: unknown }).__artmatic));
  await openDemo(page);
  await buildStage(page, { id: `m-${gen}`, source: { type: 'algo', generator: gen, params }, end: 8 });
  let s = await gridStats(page, t);
  for (let i = 0; i < 60 && s.mean < 0.5; i++) {
    await page.waitForTimeout(100);
    s = await gridStats(page, t);
  }
  return s;
}

/** 亮像素的平均 RGB（判「盘主色真的进了着色器」用；整幅均值会被星空稀释）。 */
async function brightRgb(page: Page, t: number): Promise<[number, number, number]> {
  return page.evaluate((tt) => {
    const A = (window as never as {
      __artmatic: { renderFrame: (t: number) => void; readPixels: () => { data: number[] } };
    }).__artmatic;
    A.renderFrame(tt);
    const { data } = A.readPixels();
    let r = 0;
    let g = 0;
    let b = 0;
    let n = 0;
    for (let i = 0; i < data.length; i += 4) {
      if (Math.max(data[i]!, data[i + 1]!, data[i + 2]!) > 60) {
        r += data[i]!;
        g += data[i + 1]!;
        b += data[i + 2]!;
        n += 1;
      }
    }
    return (n ? [r / n, g / n, b / n] : [0, 0, 0]) as [number, number, number];
  }, t);
}

test('three 生成器：走真实合成链出图，不是一块空白', async ({ page }) => {
  test.setTimeout(180_000);
  const s = await shoot(page, 'black-hole-three', {});
  // 星空 + 盘几乎铺满整幅，所以不能用 lit 判「有没有东西」（SDF 版同一理由）
  expect(s.mean, '整体不能是一片黑 —— 黑就是「three 那一层没接上」').toBeGreaterThan(2);
  expect(s.spread, '必须有结构（纯色画面的单通道跨度为 0）').toBeGreaterThan(30);
});

test('three 生成器：参数走 algo 那条路（evalParams → ctx.params）', async ({ page }) => {
  test.setTimeout(180_000);
  const full = await shoot(page, 'black-hole-three', {});
  const dark = await shoot(page, 'black-hole-three', { bright: 0 });
  // 亮度归零后只剩星空：绝对差读的是「盘贡献了多少」
  expect(full.mean - dark.mean, '盘亮度必须真的进画面').toBeGreaterThan(20);

  // 盘主色换绿：亮像素里绿色分量必须压过另外两个（白热的内缘会被拉高 R/B）
  await shoot(page, 'black-hole-three', { diskCol: '#00ff00' });
  const [r, g, b] = await brightRgb(page, 5);
  expect(g, `亮像素应当偏绿，实测 rgb=${r.toFixed(0)},${g.toFixed(0)},${b.toFixed(0)}`).toBeGreaterThan(r + 10);
  expect(g).toBeGreaterThan(b);
});

test('选择器：归档组默认折叠，展开后能选回 SDF 版', async ({ page }) => {
  await page.goto('/');
  await page.waitForFunction(() => Boolean((window as never as { __artmatic?: unknown }).__artmatic));
  await openDemo(page);
  await buildStage(page, {
    id: 'algo-archive',
    source: { type: 'algo', generator: 'black-hole-three' },
    end: 8,
  });
  await page.evaluate(() => {
    (window as never as { __artmatic: { appState: { selectedClipId: string | null } } }).__artmatic.appState.selectedClipId =
      'algo-archive';
  });
  await page.getByTestId('insp-change-algo').click();
  await expect(page.getByTestId('modal-algo-picker')).toBeVisible();

  const archive = page.getByTestId('algo-picker-group-archive');
  await expect(archive).toBeVisible();
  // 默认折叠：`<details>` 没有 open，卡片在 DOM 里但不可见
  await expect(archive).not.toHaveAttribute('open', '');
  await expect(archive.getByTestId('algo-picker-item').first()).toBeHidden();
  await expect(archive.locator('.ap-archive-hint')).toBeHidden();

  // 点标题展开：SDF 版那张卡出来了
  await archive.locator('summary').click();
  await expect(archive).toHaveAttribute('open', '');
  await expect(archive.getByTestId('algo-picker-item').first()).toBeVisible();

  // 归档的仍然可选（老工程要能换回去），确认后源真的换成 SDF 版
  await archive.getByTestId('algo-picker-item').first().click();
  await page.getByTestId('algo-picker-confirm').click();
  const gen = await page.evaluate(() => {
    const A = (window as never as {
      __artmatic: {
        store: { findClip: (id: string) => { clip: { source: { generator?: string } } } | null };
      };
    }).__artmatic;
    return A.store.findClip('algo-archive')?.clip.source.generator ?? null;
  });
  expect(gen).toBe('black-hole');
});

test('选择器：已经在归档里的片段，打开面板时该组自动展开', async ({ page }) => {
  await page.goto('/');
  await page.waitForFunction(() => Boolean((window as never as { __artmatic?: unknown }).__artmatic));
  await openDemo(page);
  // 老工程：片段用的是归档的 SDF 版
  await buildStage(page, {
    id: 'algo-old',
    source: { type: 'algo', generator: 'black-hole', params: { intRes: '480' } },
    end: 8,
  });
  await page.evaluate(() => {
    (window as never as { __artmatic: { appState: { selectedClipId: string | null } } }).__artmatic.appState.selectedClipId =
      'algo-old';
  });
  // 检查器自己也要说明这一条已归档（否则「选择器里找不到它」无法解释）
  await expect(page.getByText('已归档', { exact: true })).toBeVisible();

  await page.getByTestId('insp-change-algo').click();
  await expect(page.getByTestId('algo-picker-group-archive')).toHaveAttribute('open', '');
});
