import { expect, test, type Page } from '@playwright/test';
import { openDemo } from './_stage';

/**
 * 转场选择器（`TransitionPickerModal`）的端到端验证。
 *
 * 它换掉的是一个 `<select>`：转场到一百二十多条之后，下拉既不能搜、也看不见
 * 每条转场把两张图切成了什么样。这里钉住的是**新加的那几件事真的能用**：
 * 搜索收敛、当前项回填、应用真的落到工程上、缩略图真的显示出来了。
 *
 * 缩略图那条是重点，因为「底图选错 / 忘了导出」的失败形态是**缩略图看不出变化或
 * 是一张空占位**—— 那种问题不会报错、也不会让别的用例挂，只能靠这里的断言挡。
 * （资源侧的同一件事由 `tests/unit/transition-thumb-assets.test.ts` 守。）
 */

interface AnyA {
  store: {
    project: {
      tracks: {
        clips: {
          id: string;
          kind: string;
          transitionOut?: { defId: string } | null;
        }[];
      }[];
    };
  };
}

async function boot(page: Page): Promise<void> {
  await page.goto('/');
  await page.waitForFunction(() => (window as never as { __artmatic?: unknown }).__artmatic);
  await openDemo(page);
}

/** demo 工程里第一条挂了转场的源片段 id（V3 的蚂蚁那一段）。 */
function firstTransitionClipId(page: Page): Promise<string | null> {
  return page.evaluate(() => {
    const a = (window as never as { __artmatic: AnyA }).__artmatic;
    for (const t of a.store.project.tracks) {
      for (const c of t.clips) if (c.kind === 'source' && c.transitionOut) return c.id;
    }
    return null;
  });
}

/** 打开选择器（选中带转场的片段 → 点「更换转场」）。返回该片段 id。 */
async function openPicker(page: Page): Promise<string> {
  const id = await firstTransitionClipId(page);
  expect(id, 'demo 工程里应当有一条挂了转场的源片段').not.toBeNull();
  await page.locator(`[data-clip-id="${id}"]`).click();
  await page.getByTestId('open-transition-picker').click();
  await expect(page.getByTestId('modal-transition-picker')).toBeVisible();
  return id!;
}

/** 读某片段当前的 transitionOut.defId（没有转场时返回 null）。 */
async function transitionOf(page: Page, clipId: string): Promise<string | null> {
  return page.evaluate((id) => {
    const a = (window as never as { __artmatic: AnyA }).__artmatic;
    for (const t of a.store.project.tracks) {
      for (const c of t.clips) if (c.id === id) return c.transitionOut?.defId ?? null;
    }
    return null;
  }, clipId);
}

const items = (page: Page) => page.locator('[data-testid=transition-picker-item]');

async function hitCount(page: Page): Promise<number> {
  const text = await page.getByTestId('transition-picker-hit').innerText();
  return Number(text.replace(/[^\d]/g, ''));
}

test('转场选择器：搜索收敛、当前项回填、应用真的落到工程上', async ({ page }) => {
  await boot(page);
  const clipId = await openPicker(page);

  const all = await hitCount(page);
  expect(all).toBeGreaterThan(100);
  await expect(items(page)).toHaveCount(all);

  // 当前生效的那条被回填为「已选」。判据用 `data-selected-id`（工程里真正落库的
  // 那个值）而不是可见文本 —— 文本是中文名，会随文案与语言变。
  const before = await transitionOf(page, clipId);
  expect(before).not.toBeNull();
  await expect(page.getByTestId('transition-picker-selected')).toHaveAttribute(
    'data-selected-id',
    before!,
  );

  // 名称已本地化：卡片上的名字是中文，不是英文 id；说明也非空。
  const currentCard = page.locator(`[data-transition-id="${before}"]`);
  const name = await currentCard.locator('.trp-name').innerText();
  expect(name.length, '转场名不能是空的').toBeGreaterThan(0);
  expect(name, `转场名还是英文 id（本地化没生效）：${name}`).not.toBe(before!);
  expect((await currentCard.locator('.trp-desc').innerText()).length).toBeGreaterThan(0);

  // 按上游 id 搜
  await page.getByTestId('transition-picker-search').fill('wipe');
  const hit = await hitCount(page);
  expect(hit).toBeGreaterThan(0);
  expect(hit).toBeLessThan(all);
  await expect(page.locator('[data-transition-id="wipeLeft"]')).toBeVisible();
  await expect(page.locator('[data-transition-id="CrossZoom"]')).toHaveCount(0);

  // 按**中文名**搜（这是本地化的直接收益：不用记英文）
  await page.getByTestId('transition-picker-search').fill('擦除');
  expect(await hitCount(page)).toBeGreaterThan(0);
  await expect(page.locator('[data-transition-id="wipeLeft"]')).toBeVisible();

  // 搜不到 → 空态，而不是悄悄退回全部
  await page.getByTestId('transition-picker-search').fill('zzzz-no-such-transition');
  await expect(page.getByTestId('transition-picker-empty')).toBeVisible();
  await expect(items(page)).toHaveCount(0);

  // 选一条不同的并应用
  await page.getByTestId('transition-picker-search').fill('wipeLeft');
  await items(page).first().click();
  await page.getByTestId('transition-picker-confirm').click();
  await expect(page.getByTestId('modal-transition-picker')).toHaveCount(0);

  expect(await transitionOf(page, clipId)).toBe('wipeLeft');
  // 检查器里的当前转场读数与缩略图跟着换：中文名 + 上游 id 两行都在
  await expect(page.getByTestId('transition-current-id')).toHaveText('wipeLeft');
  await expect(page.getByTestId('transition-current-name')).toHaveText('向左擦除');
  await expect(page.getByTestId('transition-preview')).toBeVisible();
});

test('转场选择器：每张卡片都有缩略图，且真的显示出来了', async ({ page }) => {
  await boot(page);
  await openPicker(page);

  const total = await hitCount(page);

  // 判据不是「某一张渲出来了」，而是「**每条**转场都有 `<img>` 而不是占位图」——
  // 那正是「加了转场但忘了跑导出脚本」在界面上的表现。
  await expect(page.locator('[data-testid=transition-picker-item] img')).toHaveCount(total);
  await expect(
    page.locator('[data-testid=transition-picker-item] [data-testid=thumb-placeholder]'),
  ).toHaveCount(0);

  // 等目标那张解码完（`<img loading="lazy">`：不可见的还没解码）。
  // `wipeLeft` 排在 id 序靠后，在首屏之外 —— 先滚到它才谈得上解码。
  await page.locator('[data-transition-id="wipeLeft"]').scrollIntoViewIfNeeded();
  await page.waitForFunction(
    () => {
      const img = document.querySelector('[data-transition-id="wipeLeft"] img') as HTMLImageElement | null;
      return !!img && img.complete && img.naturalWidth > 0;
    },
    undefined,
    { timeout: 20_000 },
  );

  // 缩略图真的把**两张不同的底图**放进去了：wipeLeft 在 50% 时左半是暖色出画图、
  // 右半是冷色入画图，所以「左半的 R−B」与「右半的 R−B」应当差得很开。
  //
  // 用 R−B 而不是平均亮度：两张底图的**亮度和**恰好接近（暖色靠 R+G，冷色靠 G+B），
  // 拿亮度比会得到一个接近 1 的比值 —— 那会让这条断言看起来「没坏」，其实测不出东西。
  // 色相才是这两张底图真正的判据（见 thumbnails.ts 头注）。
  const skew = await page.evaluate(() => {
    const img = document.querySelector('[data-transition-id="wipeLeft"] img') as HTMLImageElement;
    const c = document.createElement('canvas');
    c.width = img.naturalWidth;
    c.height = img.naturalHeight;
    const ctx = c.getContext('2d')!;
    ctx.drawImage(img, 0, 0);
    const d = ctx.getImageData(0, 0, c.width, c.height).data;
    let left = 0;
    let right = 0;
    let n = 0;
    for (let y = 0; y < c.height; y += 1) {
      for (let x = 0; x < c.width; x += 1) {
        const i = (y * c.width + x) * 4;
        const rb = d[i]! - d[i + 2]!;
        if (x < c.width / 2) left += rb;
        else right += rb;
        n += 1;
      }
    }
    return { left: left / n, right: right / n };
  });
  expect(
    Math.abs(skew.left - skew.right),
    `wipeLeft 的缩略图左右两半色相几乎一样（R−B：左 ${skew.left.toFixed(1)}，右 ${skew.right.toFixed(1)}），可能两张底图没进去`,
  ).toBeGreaterThan(30);
});

test('转场选择器：列表视图在宽屏下并两列，且带上游 id', async ({ page }) => {
  await boot(page);
  await openPicker(page);

  // 网格形态没有 id 那一行
  await expect(page.locator('[data-testid=transition-picker-id]')).toHaveCount(0);

  await page.getByTestId('transition-picker-view').click();

  // 列表形态补上「上游 id」（中文名之外保留回上游查的路）
  await expect(
    page.locator('[data-transition-id="wipeLeft"] [data-testid=transition-picker-id]'),
  ).toHaveCount(1);

  // 网格的第一格是「无转场」磁贴，所以拿它当第一列的锚点：
  // 「磁贴 + 第一条转场」应当同一行、左右并排。
  const noneBox = await page.getByTestId('transition-picker-none').boundingBox();
  expect(noneBox, '「无转场」磁贴不见了').not.toBeNull();
  const boxes = await items(page).evaluateAll((els) =>
    els.slice(0, 2).map((el) => {
      const r = el.getBoundingClientRect();
      return { x: Math.round(r.x), y: Math.round(r.y) };
    }),
  );
  expect(boxes.length).toBe(2);
  expect(boxes[0]!.y, '第一条转场没排到第二列 → 列表退回了一列到底').toBe(Math.round(noneBox!.y));
  expect(boxes[0]!.x).toBeGreaterThan(Math.round(noneBox!.x));
  // 第二条落到下一行（也就是说列数就是 2，不是 3+）
  expect(boxes[1]!.y).toBeGreaterThan(boxes[0]!.y);
});

test('转场选择器：「无转场」磁贴能清掉转场，检查器区块分隔存在', async ({ page }) => {
  await boot(page);
  const clipId = await openPicker(page);

  await expect(page.getByTestId('transition-picker-none')).toBeVisible();
  await page.getByTestId('transition-picker-none').click();
  await expect(page.getByTestId('transition-picker-selected')).toContainText('无转场');
  await expect(page.getByTestId('transition-picker-selected')).toHaveAttribute('data-selected-id', '');
  await page.getByTestId('transition-picker-confirm').click();

  expect(await transitionOf(page, clipId)).toBeNull();
  // 清掉之后检查器里不再有「当前转场」读数与预览图
  await expect(page.getByTestId('transition-current-id')).toHaveCount(0);
  await expect(page.getByTestId('transition-preview')).toHaveCount(0);

  // 转场区块与前面的片段属性之间有分隔（section 容器存在）
  await expect(page.getByTestId('transition-section')).toBeVisible();
});
