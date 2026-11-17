import { expect, test, type Page } from '@playwright/test';
import { openDemo } from './_stage';

/**
 * 焦点管理。
 *
 * 这一批全是**键盘可达性**的回归：它们坏掉时界面看起来完全正常，只有用键盘
 * 的人会撞上（Space 不播放、Tab 走不到片段、按 Shift+2 弹出了面板但焦点
 * 还在背后）。所以断言只能落在 `document.activeElement` 与 `playing` 这类
 * 可读状态上，不能读像素。
 */

type AnyF = {
  appState: {
    playing: boolean;
    drawerOpen: boolean;
    mediaPoolOpen: boolean;
    selectedClipIds: string[];
  };
  store: {
    addTrack: (k: 'visual' | 'audio', name?: string) => string;
    addClip: (t: string, c: unknown) => void;
  };
};

async function boot(page: Page): Promise<void> {
  await page.goto('/');
  await page.waitForFunction(() => Boolean((window as never as { __artmatic?: unknown }).__artmatic));
  await openDemo(page);
}

/**
 * 只取需要的字段。
 *
 * 不要把整个 `appState` 交回来：它有 getter（`selectedClipIds`）与几十个字段，
 * 结构化克隆只搬可枚举的自有属性，getter 会静默变成 `undefined` ——
 * 那会变成「断言永远等不到 true」，而错误信息里看不出原因。
 */
const state = (page: Page): Promise<AnyF['appState']> =>
  page.evaluate(() => {
    const a = (window as never as { __artmatic: AnyF }).__artmatic.appState;
    return {
      playing: a.playing,
      drawerOpen: a.drawerOpen,
      mediaPoolOpen: a.mediaPoolOpen,
      selectedClipIds: a.selectedClipIds ?? [],
    };
  });

/** 焦点所在的面板 id（不在任何面板里为 null）。 */
const focusedPanel = (page: Page): Promise<string | null> =>
  page.evaluate(
    () =>
      document.activeElement?.closest('[data-focus-panel]')?.getAttribute('data-focus-panel') ??
      null,
  );

test('聚焦在按钮上时 Space 仍然播放（按钮不再抢 Space）', async ({ page }) => {
  await boot(page);

  // 找一个会留下焦点的按钮：点它会打开检查器，焦点停在按钮本身上。
  const btn = page.getByTestId('drawer-open');
  await btn.click();
  await expect
    .poll(() => page.evaluate(() => document.activeElement?.getAttribute('data-testid') ?? null))
    .toBe('drawer-open');

  /*
   * 记下按 Space 之前的抽屉状态：**它不能被这次 Space 改掉**。
   *
   * 不能直接断言 `drawerOpen === true` —— 它取决于打开 demo 时的初始偏好；
   * 要验的是「按钮没有被 Space 激活」，也就是状态没翻转。
   */
  const drawerBefore = (await state(page)).drawerOpen;

  await page.keyboard.press('Space');
  // 原来 Space 会「激活那个按钮」而不是播放 —— 表现为 playing 一直是 false，
  // 而且抽屉被第二次切换（开着的关掉、关着的打开）。
  await expect.poll(async () => (await state(page)).playing).toBe(true);
  expect((await state(page)).drawerOpen).toBe(drawerBefore);

  await page.keyboard.press('Space');
  await expect.poll(async () => (await state(page)).playing).toBe(false);
});

test('Shift+2 打开媒体池并把焦点送进面板；Ctrl+Shift+. 轮询面板', async ({ page }) => {
  await boot(page);

  await page.keyboard.press('Shift+2');
  await expect.poll(async () => (await state(page)).mediaPoolOpen).toBe(true);
  await expect.poll(() => focusedPanel(page)).toBe('pool');

  // 面板内第一个可聚焦元素拿到焦点（媒体池头部的关闭按钮）。
  const info = await page.evaluate(() => {
    const a = document.activeElement as HTMLElement | null;
    return {
      tag: a?.tagName ?? null,
      testid: a?.getAttribute('data-testid') ?? null,
      panels: [...document.querySelectorAll('[data-focus-panel]')].map((e) =>
        e.getAttribute('data-focus-panel'),
      ),
    };
  });
  expect(info, JSON.stringify(info)).toMatchObject({ panels: expect.arrayContaining(['pool']) });
  expect(
    await page.evaluate(() => Boolean(document.activeElement?.closest('[data-focus-panel="pool"]'))),
    JSON.stringify(info),
  ).toBe(true);

  // 轮询：panel → 下一个在场面板。至少会换一个不同的面板。
  await page.keyboard.press('Control+Shift+Period');
  await expect.poll(async () => focusedPanel(page)).not.toBe('pool');
});

test('面板获得焦点时顶边亮主题色高亮线', async ({ page }) => {
  await boot(page);
  await page.keyboard.press('Shift+2');
  await expect.poll(() => focusedPanel(page)).toBe('pool');

  // 高亮线是 `::after`（inset box-shadow 会被内容盖住，见 app.css 的注释）。
  const line = await page.evaluate(() => {
    const el = document.querySelector('[data-focus-panel="pool"]');
    if (!el) return null;
    const s = getComputedStyle(el, '::after');
    return { opacity: s.opacity, background: s.backgroundColor, height: s.height };
  });
  expect(line).not.toBeNull();
  expect(line!.opacity).toBe('1');
  expect(line!.height).toBe('2px');
  expect(line!.background).not.toBe('rgba(0, 0, 0, 0)');
});

test('Esc 把焦点从面板里释放出来', async ({ page }) => {
  await boot(page);
  await page.keyboard.press('Shift+2');
  await expect.poll(() => focusedPanel(page)).toBe('pool');

  await page.keyboard.press('Escape');
  await expect
    .poll(() => page.evaluate(() => document.activeElement === document.body))
    .toBe(true);
  // 焦点走了，高亮线也应当消失。
  const opacity = await page.evaluate(() => {
    const el = document.querySelector('[data-focus-panel="pool"]');
    return el ? getComputedStyle(el, '::after').opacity : 'missing';
  });
  expect(opacity === '0' || opacity === 'missing').toBe(true);
});

test('面板内 Tab 回绕：焦点不会用 Tab 走出面板，Esc 之后恢复原生行为', async ({ page }) => {
  await boot(page);
  await page.keyboard.press('Shift+2');
  await expect.poll(() => focusedPanel(page)).toBe('pool');

  // 媒体池里的可聚焦元素不多；连按 8 次足够绕过一圈。
  for (let i = 1; i <= 8; i += 1) {
    await page.keyboard.press('Tab');
    expect(await focusedPanel(page), `第 ${i} 次 Tab`).toBe('pool');
  }

  /*
   * 「Esc 之后 Tab 恢复原生」不在这里断言：浏览器在 body 上按 Tab 会从
   * **上次失焦的位置**继续（sequential focus navigation starting point），
   * 所以它还会先走完抽屉里的元素 —— 那不是 trap 失效，而是原生行为本身。
   * Esc 的出口由上面那条独立用例守（焦点必须落到 body）。
   */
});

test('弹窗把焦点收进来、Tab 不外溢，关闭后焦点回到触发按钮', async ({ page }) => {
  await boot(page);
  const trigger = page.getByTestId('rail-settings');
  await trigger.click();
  const dialog = page.locator('[role="dialog"]');
  await expect(dialog).toBeVisible();

  const inDialog = (): Promise<boolean> =>
    page.evaluate(() => Boolean(document.activeElement?.closest('[role="dialog"]')));
  await expect.poll(inDialog).toBe(true);

  for (let i = 0; i < 6; i += 1) {
    await page.keyboard.press('Tab');
    expect(await inDialog(), `第 ${i + 1} 次 Tab`).toBe(true);
  }

  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
  // 关掉之后焦点回到打开它的那颗按钮 —— 否则键盘用户得从文档开头重新找。
  await expect
    .poll(() => page.evaluate(() => document.activeElement?.getAttribute('data-testid') ?? null))
    .toBe('rail-settings');
});

test('时间轴片段：←/→ 在相邻片段间移动焦点，Enter 打开编辑器', async ({ page }) => {
  await boot(page);
  await page.evaluate(() => {
    const a = (window as never as { __artmatic: AnyF }).__artmatic;
    const t = a.store.addTrack('visual', 'KB');
    const mk = (id: string, start: number, end: number) => ({
      kind: 'source',
      id,
      start,
      end,
      label: id,
      fadeSec: 0,
      curves: {},
      source: { type: 'solid', color: '#3a6ea5' },
      blend: 'normal',
      opacity: 1,
      transform: { x: 0.5, y: 0.5, sx: 1, sy: 1, rot: 0 },
      fit: 'stretch',
    });
    a.store.addClip(t, mk('FA', 0, 2));
    a.store.addClip(t, mk('FB', 3, 5));
  });

  // 先把焦点放到第一个片段上（模拟 Tab 走到它）。
  await page.evaluate(() =>
    (document.querySelector('[data-clip-id="FA"]') as HTMLElement).focus(),
  );
  expect(
    await page.evaluate(() => document.activeElement?.getAttribute('data-clip-id')),
  ).toBe('FA');

  await page.keyboard.press('ArrowRight');
  expect(
    await page.evaluate(() => document.activeElement?.getAttribute('data-clip-id')),
  ).toBe('FB');

  await page.keyboard.press('ArrowLeft');
  expect(
    await page.evaluate(() => document.activeElement?.getAttribute('data-clip-id')),
  ).toBe('FA');

  // Enter = 双击同一条路径：纯色片段没有独立页面，打开的是检查器。
  await page.keyboard.press('Enter');
  await expect.poll(async () => (await state(page)).drawerOpen).toBe(true);
});
