/**
 * plugin-panels.spec.ts — manifest v3 的面板 / 动作 / 生命周期。
 *
 * 与 `plugins.spec.ts` 同一条分工：`import(blob:)`、Shadow DOM、真 GL、
 * 「关掉工程后面板真的没了」这些只能在这里测 —— vitest 里既没有 blob 加载器，
 * 也没有真实的布局与 DOM。
 *
 * 这一组刻意**不测画面**（着色器那条链路已由 `plugins.spec.ts` 覆盖），
 * 只测插件系统新增的那一层：挂载 → 面板 → 动作 → 停用 / 重开。
 */

import { expect, test, type Page } from '@playwright/test';
import { buildStage, openDemo } from './_stage';

const DIR = 'e2e-panel-plugins';

type PluginInfo = {
  id: string;
  name: string | null;
  status: 'ok' | 'partial' | 'failed' | 'disabled';
  enabled: boolean;
  panels: { id: string; name: string; icon: string | null; kind: string }[];
  actions: { id: string; name: string; params: { key: string }[] }[];
  activated: boolean;
  issues: { code: string; path?: string; detail?: string }[];
};

type ControlResult<T> = { ok: true; data: T } | { ok: false; error: { code: string; message: string } };

type PageApi = {
  __artmatic: {
    project: {
      useOpfs(name?: string): Promise<string>;
      save(): Promise<boolean>;
      open(name?: string): Promise<boolean>;
      write(path: string, bytes: number[]): Promise<void>;
      wipe(name?: string): Promise<void>;
      /** 立刻写 `session.json`（跳过 0.9 s 防抖）。 */
      sessionNow: () => Promise<void>;
    };
    plugins: { list(): PluginInfo[] };
    store: { project: { tracks: { clips: { id: string; opacity?: number }[] }[] } };
    control: {
      undo(): Promise<ControlResult<{ changed: boolean }>>;
      listPluginUi(): Promise<ControlResult<{ plugins: PluginInfo[] }>>;
      invokePluginAction(
        pluginId: string,
        actionId: string,
        args?: Record<string, unknown>,
      ): Promise<ControlResult<{ value: unknown; truncated: boolean }>>;
      getCapabilities(): Promise<ControlResult<{ plugins?: PluginInfo[] }>>;
    };
  };
};

/* ------------------------------------------------------------------ 夹具 */

/**
 * 一个带两种面板、两个动作的插件。
 *
 * - `floater` 有 icon ⇒ Rail 上出现一颗按钮；
 * - `dialog` **没有** icon ⇒ 只能从插件管理器 / `plugin_ui` 打开；
 * - `echo` 用来验证「默认值补齐」与「未知键拒绝」；
 * - `boom` 用来验证「插件抛错不会炸宿主」。
 */
function panelPlugin(): string {
  return `
export const plugin = {
  format: 'artmatic-plugin',
  apiVersion: 3,
  id: 'e2e-panel',
  name: 'Panel E2E',
  panels: [
    {
      id: 'floater',
      name: 'Floater',
      icon: 'type',
      kind: 'float',
      width: 320,
      height: 240,
      render(el, api) {
        api.log('floater mounted');
        const b = document.createElement('button');
        b.textContent = 'PLUGIN-UI';
        el.appendChild(b);
        // 这条样式只该留在 shadow 里；主界面的按钮样式不该跟着变。
        const s = document.createElement('style');
        s.textContent = 'button { color: rgb(1, 2, 3); }';
        el.appendChild(s);
        return () => { el.dataset.disposed = 'yes'; };
      },
    },
    {
      id: 'dialog',
      name: 'Dialog',
      icon: null,
      kind: 'modal',
      render(el) { el.textContent = 'DIALOG-UI'; },
    },
    {
      id: 'inspector',
      name: 'Inspector',
      icon: null,
      kind: 'dock',
      render(el) { el.textContent = 'DOCK-UI'; },
    },
  ],
  actions: [
    {
      id: 'echo',
      name: 'Echo',
      params: [
        { key: 'n', labelKey: 'N', type: 'range', min: 0, max: 10, step: 1, defaultValue: 3 },
        { key: 'b', labelKey: 'B', type: 'checkbox', defaultValue: 1 },
      ],
      run: (api, args) => ({ got: args }),
    },
    {
      id: 'boom',
      name: 'Boom',
      params: [],
      run: () => { throw new Error('boom-from-plugin'); },
    },
    {
      id: 'set-opacity',
      name: 'Set opacity',
      params: [{ key: 'clipId', labelKey: 'Clip', type: 'text', defaultValue: '' }],
      run: (api, args) => api.timeline.command('set_clip_props', {
        clipId: args.clipId,
        patch: { opacity: 0.42 },
      }),
    },
  ],
};
`;
}

async function boot(page: Page): Promise<void> {
  await page.goto('/');
  await page.waitForFunction(() => (window as never as PageApi).__artmatic);
  await openDemo(page);
  await page.evaluate((d) => (window as never as PageApi).__artmatic.project.wipe(d), DIR);
}

async function plant(page: Page): Promise<void> {
  await page.evaluate((d) => (window as never as PageApi).__artmatic.project.useOpfs(d), DIR);
  const source = panelPlugin();
  await page.evaluate(
    ({ path, bytes }) => (window as never as PageApi).__artmatic.project.write(path, bytes),
    { path: `${DIR}/plugins/e2e-panel.js`, bytes: Array.from(new TextEncoder().encode(source)) },
  );
  await page.evaluate(() => (window as never as PageApi).__artmatic.project.save());
  await reopen(page);
}

async function reopen(page: Page): Promise<void> {
  const ok = await page.evaluate((d) => (window as never as PageApi).__artmatic.project.open(d), DIR);
  expect(ok).toBe(true);
}

function pluginInfo(page: Page): Promise<PluginInfo | undefined> {
  return page
    .evaluate(() => (window as never as PageApi).__artmatic.plugins.list())
    .then((list) => list.find((p) => p.id === 'e2e-panel'));
}

/* ------------------------------------------------------------------ 用例 */

test.describe('manifest v3：面板', () => {
  test.beforeEach(async ({ page }) => boot(page));

  test('清单里的面板与动作被识别，Rail 图标开浮窗，无 icon 面板从管理器打开', async ({ page }) => {
    /*
     * 捕获运行期错误。`effect_update_depth_exceeded` 是 Svelte 的 `$effect`
     * 读写同一块 state 时抛的 —— 它**不影响功能**，只是每次打开面板报一次，
     * 所以只能靠这条断言守住（画面断言全绿也照样会漏）。
     */
    const errors: string[] = [];
    page.on('console', (m) => {
      if (m.type() === 'error') errors.push(m.text());
    });
    page.on('pageerror', (e) => errors.push(e.message));

    await plant(page);

    const info = await pluginInfo(page);
    expect(info?.status, JSON.stringify(info?.issues)).toBe('ok');
    expect(info?.panels.map((p) => p.id)).toEqual(['floater', 'dialog', 'inspector']);
    expect(info?.panels[0]!.icon).toBe('type');
    expect(info?.panels[1]!.icon).toBeNull();
    expect(info?.panels[2]!.kind).toBe('dock');
    expect(info?.actions.map((a) => a.id)).toEqual(['echo', 'boom', 'set-opacity']);
    expect(info?.activated).toBe(true);

    // ① Rail 上只有「有 icon」的那一个。
    const railButtons = page.locator('[data-testid="rail-plugin-panel"]');
    await expect(railButtons).toHaveCount(1);

    await railButtons.first().click();
    const panel = page.locator('[data-testid="plugin-panel"]');
    await expect(panel).toBeVisible();
    // Shadow DOM 里的内容对 Playwright 是可见的（open shadow root）。
    await expect(panel.getByText('PLUGIN-UI')).toBeVisible();

    // 再点一次 = 关掉（同一个按钮是两态）。
    await railButtons.first().click();
    await expect(panel).toHaveCount(0);

    // ② 无 icon 面板：插件管理器里的「打开」。
    await page.getByTestId('rail-plugins').click();
    const openDialog = page.locator('[data-plugin-panel="e2e-panel/dialog"]');
    await expect(openDialog).toBeVisible();
    await page.locator('[data-testid="plugin-panel-open"][data-plugin-panel="e2e-panel/dialog"]').click();
    await expect(page.getByTestId('plugin-panel-modal')).toBeVisible();
    await expect(page.getByText('DIALOG-UI')).toBeVisible();

    // 三条面板各开过一次之后仍然没有 effect 深度错误。
    expect(errors.filter((t) => t.includes('effect_update_depth_exceeded'))).toEqual([]);
  });

  test('打开状态跟工程走：写好 session 后重开，浮窗回到原处', async ({ page }) => {
    await plant(page);
    await page.locator('[data-testid="rail-plugin-panel"]').first().click();
    await expect(page.locator('[data-testid="plugin-panel"]')).toBeVisible();

    // 会话落盘是 0.9s 防抖：不等它就把工程关掉，面板状态根本没写进去。
    await page.evaluate(() => (window as never as PageApi).__artmatic.project.sessionNow());
    await reopen(page);

    await expect(page.locator('[data-testid="plugin-panel"]')).toBeVisible();
    await expect(page.getByText('PLUGIN-UI')).toBeVisible();
  });

  test('停靠面板占 .body 的第四列；关掉后列宽回到 0', async ({ page }) => {
    await plant(page);

    await page.getByTestId('rail-plugins').click();
    await page
      .locator('[data-testid="plugin-panel-open"][data-plugin-panel="e2e-panel/inspector"]')
      .click();

    await expect(page.getByTestId('plugin-dock')).toBeVisible();
    await expect(page.getByText('DOCK-UI')).toBeVisible();
    const openW = await page.evaluate(() =>
      getComputedStyle(document.querySelector('.body')!).getPropertyValue('--plugin-dock-w').trim(),
    );
    expect(openW).toBe('280px');

    await page.getByTestId('plugin-dock-close').click();
    await expect(page.getByTestId('plugin-dock')).toHaveCount(0);
    const closedW = await page.evaluate(() =>
      getComputedStyle(document.querySelector('.body')!).getPropertyValue('--plugin-dock-w').trim(),
    );
    expect(closedW).toBe('0px');
  });

  test('停用插件：面板与 Rail 图标一起消失（不留孤儿窗口）', async ({ page }) => {
    await plant(page);
    await page.locator('[data-testid="rail-plugin-panel"]').first().click();
    await expect(page.locator('[data-testid="plugin-panel"]')).toBeVisible();

    await page.getByTestId('rail-plugins').click();
    await page.getByTestId('plugin-toggle-e2e-panel').click();

    await expect(page.locator('[data-testid="plugin-panel"]')).toHaveCount(0);
    expect((await pluginInfo(page))?.status).toBe('disabled');
    await page.getByTestId('plugins-close').click();
    await expect(page.locator('[data-testid="rail-plugin-panel"]')).toHaveCount(0);
  });
});

test.describe('manifest v3：动作对 Agent 可达', () => {
  test.beforeEach(async ({ page }) => boot(page));

  test('plugin_invoke 的默认值补齐、未知键拒绝、插件抛错不炸宿主', async ({ page }) => {
    await plant(page);

    const ok = await page.evaluate(() =>
      (window as never as PageApi).__artmatic.control.invokePluginAction('e2e-panel', 'echo', {}),
    );
    expect(ok.ok).toBe(true);
    if (ok.ok) expect(ok.data.value).toEqual({ got: { n: 3, b: 1 } });

    const unknown = await page.evaluate(() =>
      (window as never as PageApi).__artmatic.control.invokePluginAction('e2e-panel', 'echo', { nope: 1 }),
    );
    expect(unknown.ok).toBe(false);

    const boom = await page.evaluate(() =>
      (window as never as PageApi).__artmatic.control.invokePluginAction('e2e-panel', 'boom', {}),
    );
    expect(boom.ok).toBe(false);
    if (!boom.ok) expect(boom.error.message).toContain('boom-from-plugin');

    // 抛错只记一条 issue，插件本身仍然可用（下一句动作照常跑）。
    const info = await pluginInfo(page);
    expect(info?.issues.some((i) => i.code === 'action-failed')).toBe(true);
    expect(info?.status).toBe('partial');
  });

  test('动作可以改时间轴片段属性，且是一笔撤销', async ({ page }) => {
    await plant(page);
    await buildStage(page, { id: 'param-src', source: { type: 'solid', color: '#0000ff' } });

    const opacityOf = () =>
      page.evaluate(() => {
        for (const t of (window as never as PageApi).__artmatic.store.project.tracks) {
          for (const c of t.clips) if (c.id === 'param-src') return c.opacity ?? 1;
        }
        return null;
      });

    expect(await opacityOf()).toBe(1);

    const r = await page.evaluate(() =>
      (window as never as PageApi).__artmatic.control.invokePluginAction(
        'e2e-panel',
        'set-opacity',
        { clipId: 'param-src' },
      ),
    );
    expect(r.ok, r.ok ? '' : r.error.message).toBe(true);
    expect(await opacityOf()).toBe(0.42);

    // 走的是控制平面 ⇒ 用户按 Ctrl+Z 能撤回插件写的那一笔。
    await page.evaluate(() => (window as never as PageApi).__artmatic.control.undo());
    expect(await opacityOf()).toBe(1);
  });

  test('能力清单里能看到插件的面板与动作（模型靠它选 id）', async ({ page }) => {
    await plant(page);
    const caps = await page.evaluate(() =>
      (window as never as PageApi).__artmatic.control.getCapabilities(),
    );
    expect(caps.ok).toBe(true);
    if (!caps.ok) return;
    const entry = caps.data.plugins?.find((p) => p.id === 'e2e-panel');
    expect(entry?.panels.map((p) => p.id)).toEqual(['floater', 'dialog', 'inspector']);
    expect(entry?.actions.map((a) => a.id)).toEqual(['echo', 'boom', 'set-opacity']);

    const ui = await page.evaluate(() => (window as never as PageApi).__artmatic.control.listPluginUi());
    expect(ui.ok && ui.data.plugins.some((p) => p.id === 'e2e-panel')).toBe(true);
  });
});
