import { expect, test, type Page } from '@playwright/test';
import { openDemo } from './_stage';

/**
 * 特效选择器（`EffectPickerModal`）的端到端验证。
 *
 * 它换掉的是一个 `<select>`：七十多个特效之后，下拉既不能搜、不能筛，
 * 也看不见每个特效长什么样。这里钉住的是**新加的那几件事真的能用**：
 * 搜索收敛、筛选是真的在过滤、两种视图、多选与顺序、以及缩略图。
 *
 * 缩略图那两条是重点，因为「底图选错」的失败形态是**缩略图看不出变化** ——
 * 那种问题不会报错、也不会让别的用例挂，只能靠这里的像素断言挡。
 */

interface AnyA {
  store: {
    project: {
      tracks: { clips: { id: string; kind: string; chain?: { defId: string }[] }[] }[];
    };
  };
}

async function boot(page: Page): Promise<void> {
  await page.goto('/');
  await page.waitForFunction(() => (window as never as { __artmatic?: unknown }).__artmatic);
  await openDemo(page);
}

/** 打开选择器（点检查器里的「添加特效」）。 */
async function openPicker(page: Page): Promise<void> {
  const fxId = await page.evaluate(() => {
    const a = (window as never as { __artmatic: AnyA }).__artmatic;
    for (const t of a.store.project.tracks) {
      for (const c of t.clips) if (c.kind === 'effect' && (c.chain?.length ?? 0) > 0) return c.id;
    }
    return null;
  });
  await page.locator(`[data-clip-id="${fxId}"]`).click();
  await page.getByTestId('add-effect-instance').click();
  await expect(page.getByTestId('modal-effect-picker')).toBeVisible();
}

const items = (page: Page) => page.locator('[data-testid=effect-picker-item]');

/** 面板里的命中数读数。 */
async function hitCount(page: Page): Promise<number> {
  const text = await page.getByTestId('effect-picker-hit').innerText();
  return Number(text.replace(/[^\d]/g, ''));
}

test('选择器：搜索收敛、搜不到给空态、清空后复原', async ({ page }) => {
  await boot(page);
  await openPicker(page);

  const all = await hitCount(page);
  expect(all).toBeGreaterThan(50);
  await expect(items(page)).toHaveCount(all);

  // 按中文名搜
  await page.getByTestId('effect-picker-search').fill('霓虹');
  const hit = await hitCount(page);
  expect(hit).toBeGreaterThan(0);
  expect(hit).toBeLessThan(all);
  await expect(page.locator('[data-effect-id="neon-edges"]')).toBeVisible();
  await expect(page.locator('[data-effect-id="bleach"]')).toHaveCount(0);

  // 按 id 搜（知道上游名字的人直接打 id）
  await page.getByTestId('effect-picker-search').fill('kino');
  expect(await hitCount(page)).toBe(2);

  // 搜不到 → 空态，而不是悄悄退回全部
  await page.getByTestId('effect-picker-search').fill('zzzz-no-such-effect');
  await expect(page.getByTestId('effect-picker-none')).toBeVisible();
  await expect(items(page)).toHaveCount(0);

  await page.getByTestId('effect-picker-search').fill('');
  expect(await hitCount(page)).toBe(all);
});

test('选择器：分类与标签筛选真的在过滤', async ({ page }) => {
  await boot(page);
  await openPicker(page);

  await page.getByTestId('effect-picker-filter-toggle').click();
  await expect(page.getByTestId('effect-picker-filters')).toBeVisible();

  // 分类是单选语义内的 OR：勾「故障」之后彩色类的不该在
  await page.getByTestId('effect-picker-cat-glitch').click();
  await expect(page.locator('[data-effect-id="channel-split"]')).toBeVisible();
  await expect(page.locator('[data-effect-id="bleach"]')).toHaveCount(0);

  // 标签是「全部命中」：勾「吃音频」后「故障」里只剩音频那一条
  const glitchOnly = await hitCount(page);
  await page.getByTestId('effect-picker-tag-audio').click();
  const narrowed = await hitCount(page);
  expect(narrowed).toBeLessThanOrEqual(glitchOnly);
  await expect(page.locator('[data-effect-id="audio-bars"]')).toHaveCount(0); // 它不是故障类

  // 清除条件回到全部
  await page.getByTestId('effect-picker-clear').click();
  expect(await hitCount(page)).toBeGreaterThan(50);
});

test('选择器：网格与列表两种视图，缩略图尺寸真的不同', async ({ page }) => {
  await boot(page);
  await openPicker(page);

  const thumbWidth = async (): Promise<number> =>
    page.locator('[data-effect-id="bleach"] .fxp-thumb').evaluate((el) => el.getBoundingClientRect().width);

  /**
   * 量宽度**先等它连续两次相同**：modal 有 ≤150ms 的缩放入场动画，动画中途
   * `getBoundingClientRect()` 给的是缩放后的值（实测差 5–8px）。直接量会以
   * 「切回网格后宽度变了」的样子失败，而布局根本没错（见 tests/e2e/AGENTS.md）。
   */
  const settledThumbWidth = async (): Promise<number> => {
    let prev = -1;
    await expect
      .poll(async () => {
        const w = await thumbWidth();
        const stable = Math.abs(w - prev) < 0.5;
        prev = w;
        return stable;
      })
      .toBe(true);
    return prev;
  };

  const grid = await settledThumbWidth();
  expect(grid).toBeGreaterThan(150);

  await page.getByTestId('effect-picker-view').click();
  const list = await settledThumbWidth();
  expect(list).toBeLessThan(110);
  expect(list).toBeLessThan(grid);

  // 宽屏下列表**并两列**：一排到底在一张 920px 的模态里只用掉左半幅。
  // 判据取「前两张同一行、左右并排，第三张才落下一行」。
  const boxes = await items(page).evaluateAll((els) =>
    els.slice(0, 4).map((el) => {
      const r = el.getBoundingClientRect();
      return { x: Math.round(r.x), y: Math.round(r.y) };
    }),
  );
  expect(boxes.length).toBe(4);
  expect(boxes[1]!.y, '特效列表退回了一列到底').toBe(boxes[0]!.y);
  expect(boxes[1]!.x).toBeGreaterThan(boxes[0]!.x);

  // 分类/标签 chip 只在列表形态出现（网格里塞它们会把名称挤成两行）。
  // 注意用 `.fxp-cat`（分类，每条都有）而不是 `.fxp-tag`：`bleach` 只读
  // `u_amount`、不读时间也不带反馈，它的**结构标签是空的** —— 拿它验标签会永远失败。
  await expect(page.locator('[data-effect-id="bleach"] .fxp-cat').first()).toBeVisible();

  await page.getByTestId('effect-picker-view').click();
  await expect(page.locator('[data-effect-id="bleach"] .fxp-cat')).toHaveCount(0);
  expect(await settledThumbWidth()).toBeCloseTo(grid, 0);
});

test('选择器：多选按点击顺序追加，且只算一笔撤销', async ({ page }) => {
  await boot(page);
  await openPicker(page);

  const chain = async (): Promise<string[]> =>
    page.evaluate(() => {
      const a = (window as never as { __artmatic: AnyA }).__artmatic;
      for (const t of a.store.project.tracks) {
        for (const c of t.clips) if (c.kind === 'effect') return (c.chain ?? []).map((i) => i.defId);
      }
      return [];
    });
  const before = await chain();

  // 故意不按目录顺序点，验证「按点击顺序」而不是「按列表顺序」
  for (const id of ['mirror', 'bleach', 'glow']) {
    await page.locator(`[data-testid=effect-picker-item][data-effect-id="${id}"]`).click();
  }
  await expect(page.getByTestId('effect-picker-count')).toContainText('3');

  await page.getByTestId('effect-picker-confirm').click();
  await expect(page.getByTestId('modal-effect-picker')).toHaveCount(0);

  const after = await chain();
  expect(after.length).toBe(before.length + 3);
  expect(after.slice(-3)).toEqual(['mirror', 'bleach', 'glow']);

  // 一次选择 = 一笔撤销（逐个 push 各自成一笔的话，这里会退不干净）
  await page.keyboard.press('Control+z');
  expect(await chain()).toEqual(before);
});

test('选择器：每张卡片都有缩略图，且真的显示出来了', async ({ page }) => {
  await boot(page);
  await openPicker(page);

  const total = await hitCount(page);

  // 判据不是「某一张渲出来了」，而是「**每个**特效都有 `<img>` 而不是占位图」——
  // 那正是「加了特效但忘了导出缩略图」在界面上的表现（`effect-thumb-assets`
  // 的单测从资源侧守同一件事，这里从界面侧守）。
  await expect(page.locator('[data-testid=effect-picker-item] img')).toHaveCount(total);
  await expect(
    page.locator('[data-testid=effect-picker-item] [data-testid=thumb-placeholder]'),
  ).toHaveCount(0);

  // 首屏那张等解码完（`<img loading="lazy">`：浏览器懒加载，不可见的那些还没解码，
  // 所以只等可见区里的这一张，而不是断言全部）。
  await page.waitForFunction(
    () => {
      const img = document.querySelector('[data-effect-id="bleach"] img') as HTMLImageElement | null;
      return !!img && img.complete && img.naturalWidth > 0;
    },
    undefined,
    { timeout: 20_000 },
  );

  const mean = await page.evaluate(() => {
    const img = document.querySelector('[data-effect-id="bleach"] img') as HTMLImageElement;
    const c = document.createElement('canvas');
    c.width = img.naturalWidth;
    c.height = img.naturalHeight;
    const ctx = c.getContext('2d')!;
    ctx.drawImage(img, 0, 0);
    const d = ctx.getImageData(0, 0, c.width, c.height).data;
    let s2 = 0;
    for (let i = 0; i < d.length; i += 4) s2 += d[i]! + d[i + 1]! + d[i + 2]!;
    return s2 / (d.length / 4) / 3;
  });
  expect(mean, '缩略图是空白的（资源在但内容为黑）').toBeGreaterThan(10);
});


test('选择器：分类变成小标题 + 分隔线，六个分组按分类表顺序', async ({ page }) => {
  await boot(page);
  await openPicker(page);

  const heads = page.locator('[data-testid^="effect-picker-group-"] .fxp-group-name');
  await expect(heads).toHaveCount(6);
  expect(await heads.allInnerTexts()).toEqual(['调色', '几何', '故障', '风格化', '模糊与光', '信号']);
  // 分组只切小标题、不筛东西：卡片总数仍等于命中数读数
  await expect(items(page)).toHaveCount(await hitCount(page));

  // 空组不出现（筛到只剩调色时不留五个空标题占位置）
  await page.getByTestId('effect-picker-search').fill('qu bao he du');
  await expect(page.locator('[data-testid^="effect-picker-group-"]')).toHaveCount(1);
  await expect(page.getByTestId('effect-picker-group-color')).toBeVisible();
});
