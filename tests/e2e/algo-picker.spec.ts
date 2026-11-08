/**
 * algo-picker.spec.ts — 检查器里「更换算法艺术」的端到端验证。
 *
 * 断言分两层（AGENTS §6.3）：**DOM**（按钮点得动、弹层开合、警告条在）+
 * **store**（源被整体替换、旧参数没被带过去）。少任何一层都可能是「界面对了但没改数据」
 * 或「数据改了但用户看不见」。
 */

import { expect, test, type Page } from '@playwright/test';
import { openDemo, buildStage } from './_stage';

async function boot(page: Page): Promise<void> {
  await page.goto('/');
  await page.waitForFunction(() => (window as never as { __artmatic?: unknown }).__artmatic);
  await openDemo(page);
}

/** 选中某个片段，让检查器渲染出它的参数。 */
async function selectClip(page: Page, clipId: string): Promise<void> {
  await page.evaluate((id) => {
    (window as never as { __artmatic: { appState: { selectedClipId: string | null } } }).__artmatic.appState.selectedClipId = id;
  }, clipId);
}

type Api = {
  __artmatic: {
    appState: { selectedClipId: string | null };
    store: {
      /** ⚠️ `findClip` 返回 `{ track, clip }` 包，不是 clip 本身。 */
      findClip: (id: string) => {
        clip: { label?: string; source: { generator?: string; params?: Record<string, unknown> } };
      } | null;
      updateClip: (id: string, label: string, fn: (c: { label?: string }) => void) => void;
    };
  };
};

function sourceOf(page: Page, clipId: string): Promise<{ generator?: string; params?: Record<string, unknown> } | null> {
  return page.evaluate((id) => {
    const found = (window as never as Api).__artmatic.store.findClip(id);
    return found ? found.clip.source : null;
  }, clipId);
}

test('更换算法艺术：按钮开选择器，选中后整体替换源且不保留旧参数', async ({ page }) => {
  await boot(page);
  await buildStage(page, {
    id: 'algo-swap',
    source: { type: 'algo', generator: 'rule110', params: { width: 128, height: 64, rule: 30 } },
    end: 8,
  });
  await selectClip(page, 'algo-swap');

  // rule110 有自己的 rule 参数；换掉之后这个键必须消失（「不保留参数」的判据）。
  expect((await sourceOf(page, 'algo-swap'))?.params?.rule).toBe(30);

  await expect(page.getByTestId('insp-change-algo')).toBeVisible();
  await page.getByTestId('insp-change-algo').click();

  const modal = page.getByTestId('modal-algo-picker');
  await expect(modal).toBeVisible();
  await expect(page.getByTestId('algo-picker-warn'), '弹层里必须提示旧参数不保留').toBeVisible();

  // 搜索按 id / 名字模糊过滤
  await page.getByTestId('algo-picker-search').fill('mandel');
  const item = page.locator('[data-testid="algo-picker-item"][data-algo-id="mandelbrot"]');
  await expect(item).toBeVisible();
  await item.click();
  await page.getByTestId('algo-picker-confirm').click();
  await expect(modal).toHaveCount(0);

  const after = await sourceOf(page, 'algo-swap');
  expect(after?.generator, '源被换成新生成器').toBe('mandelbrot');
  expect(after?.params?.rule, '旧生成器的参数不该被带过来').toBeUndefined();
});

test('弹层把当前生成器标成 current，且选它时确认按钮不可用', async ({ page }) => {
  await boot(page);
  await buildStage(page, {
    id: 'algo-cur',
    source: { type: 'algo', generator: 'rule110', params: { width: 128, height: 64 } },
    end: 8,
  });
  await selectClip(page, 'algo-cur');

  await page.getByTestId('insp-change-algo').click();
  const modal = page.getByTestId('modal-algo-picker');
  await expect(modal).toBeVisible();

  const current = page.locator('[data-testid="algo-picker-item"][data-algo-id="rule110"]');
  await expect(current.locator('[data-testid="algo-picker-current"]')).toHaveCount(1);

  // 回归：「当前」标记与名称必须在**同一行**。曾把名称写成 `display: block`，
  // 于是标记独占一行、名字另起一行 —— 卡片高度还随有没有标记跳一格。
  // 判据用几何：标记的垂直中线落在名称的高度带内，且水平上在名称左侧。
  const badge = (await current.locator('[data-testid="algo-picker-current"]').boundingBox())!;
  const name = (await current.locator('.ap-name').boundingBox())!;
  const badgeMid = badge.y + badge.height / 2;
  expect(badgeMid, '标记的中线不在名称的行内 → 被换了行').toBeGreaterThan(name.y);
  expect(badgeMid).toBeLessThan(name.y + name.height);
  expect(badge.x + badge.width).toBeLessThanOrEqual(name.x + 1);

  // 选中当前那份 ⇒ 确认按钮禁用（「已是当前生成器」）
  await current.click();
  await expect(page.getByTestId('algo-picker-confirm')).toBeDisabled();

  await page.getByTestId('algo-picker-cancel').click();
  await expect(modal).toHaveCount(0);
});

/* ------------------------------------------------------------ 自动改名 */

/** 片段的 `label`（store 层）。 */
function labelOf(page: Page, clipId: string): Promise<string> {
  return page.evaluate((id) => {
    const found = (window as never as Api).__artmatic.store.findClip(id);
    return found ? String((found.clip as { label?: string }).label ?? '') : '';
  }, clipId);
}

/** 时间轴上那个片段显示的名字（DOM 层）。 */
function clipName(page: Page, clipId: string) {
  return page.locator(`[data-testid=clip][data-clip-id="${clipId}"] [data-testid=clip-name]`);
}

/** 走选择器换算法（与用户点的是同一条路）。 */
async function swapTo(page: Page, genId: string): Promise<void> {
  await page.getByTestId('insp-change-algo').click();
  const modal = page.getByTestId('modal-algo-picker');
  await expect(modal).toBeVisible();
  await page.getByTestId('algo-picker-search').fill(genId);
  await page.locator(`[data-testid="algo-picker-item"][data-algo-id="${genId}"]`).click();
  await page.getByTestId('algo-picker-confirm').click();
  await expect(modal).toHaveCount(0);
}

/**
 * 更换算法时自动重命名：**只在名字还是旧生成器的默认名时**才跟着换。
 *
 * 「默认名」直接取自选择器里那张卡片的文字 —— 它与新建片段时写进 `label` 的
 * 是同一个 `resolveLabel(nameKey)`。两处一旦分家，这条用例会立刻红。
 */
test('更换算法时自动重命名：默认名跟着换，改过名的保留', async ({ page }) => {
  await boot(page);
  await buildStage(page, {
    id: 'algo-rename',
    source: { type: 'algo', generator: 'rule110', params: { width: 128, height: 64 } },
    end: 8,
  });
  await selectClip(page, 'algo-rename');

  // 先从选择器读出两个生成器的显示名（不写死中文：文案会改、语言会变）
  await page.getByTestId('insp-change-algo').click();
  await expect(page.getByTestId('modal-algo-picker')).toBeVisible();
  const nameOf = async (id: string): Promise<string> =>
    (
      await page
        .locator(`[data-testid="algo-picker-item"][data-algo-id="${id}"] [data-testid="algo-picker-name"]`)
        .innerText()
    ).trim();
  const oldName = await nameOf('rule110');
  const nextName = await nameOf('mandelbrot');
  expect(oldName, '两个生成器的默认名必须不同，否则这条用例什么都没测到').not.toBe(nextName);
  await page.getByTestId('algo-picker-cancel').click();

  // 起手：名字 = 旧生成器的默认名（= 用户没改过名）
  await page.evaluate((name) => {
    const A = (window as never as Api).__artmatic;
    A.store.updateClip('algo-rename', 'e2e: 设默认名', (c) => {
      c.label = name;
    });
  }, oldName);
  await expect(clipName(page, 'algo-rename')).toHaveText(oldName);

  // 换算法 → 名字跟着换（store 与 DOM 两层都要变）
  await swapTo(page, 'mandelbrot');
  expect(await labelOf(page, 'algo-rename')).toBe(nextName);
  await expect(clipName(page, 'algo-rename')).toHaveText(nextName);

  // 用户改过名 → 再换算法不许动它
  await page.evaluate(() => {
    const A = (window as never as Api).__artmatic;
    A.store.updateClip('algo-rename', 'e2e: 改名', (c) => {
      c.label = '我的片头';
    });
  });
  await swapTo(page, 'rule110');
  expect(await labelOf(page, 'algo-rename')).toBe('我的片头');
  await expect(clipName(page, 'algo-rename')).toHaveText('我的片头');
});

test('小标题按浏览分组切：四个分组、顺序固定、卡片一张不少', async ({ page }) => {
  await boot(page);
  await buildStage(page, {
    id: 'algo-groups',
    source: { type: 'algo', generator: 'rule110', params: { width: 128, height: 64 } },
    end: 8,
  });
  await selectClip(page, 'algo-groups');
  await page.getByTestId('insp-change-algo').click();
  await expect(page.getByTestId('modal-algo-picker')).toBeVisible();

  const heads = page.locator('[data-testid^="algo-picker-group-"] .ap-group-name');
  expect(await heads.allInnerTexts()).toEqual(['数学模拟', '几何图形', '物理模拟', '特殊']);
  // 分组只是切小标题，不筛东西：卡片总数仍等于命中数
  const total = Number((await page.getByTestId('algo-picker-hit').innerText()).replace(/[^\d]/g, ''));
  await expect(page.locator('[data-testid="algo-picker-item"]')).toHaveCount(total);

  // 空组不出现：搜到只剩一条分形时，不该留下另外三个空标题占位置
  await page.getByTestId('algo-picker-search').fill('mandelbrot');
  await expect(page.locator('[data-testid^="algo-picker-group-"]')).toHaveCount(1);
  await expect(page.getByTestId('algo-picker-group-math')).toBeVisible();
});
