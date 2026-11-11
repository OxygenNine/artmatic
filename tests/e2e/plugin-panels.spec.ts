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
  panels: { id: string; name: string; icon: string | null; kind: string; side: string }[];
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
    {
      // 不写 side ⇒ 归一成 right；下面那个 edge 面板显式要求左侧（紧贴图标栏）。
      id: 'edge',
      name: 'Edge',
      icon: null,
      kind: 'dock',
      side: 'left',
      render(el) { el.textContent = 'LEFT-DOCK-UI'; },
    },
    {
      // 与 edge 同一侧：验证「打开同侧第二个面板会把 tab 切过去」。
      id: 'edge2',
      name: 'Edge 2',
      icon: null,
      kind: 'dock',
      side: 'left',
      render(el) { el.textContent = 'LEFT-DOCK-2-UI'; },
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
    expect(info?.panels.map((p) => p.id)).toEqual(['floater', 'dialog', 'inspector', 'edge', 'edge2']);
    expect(info?.panels[0]!.icon).toBe('type');
    expect(info?.panels[1]!.icon).toBeNull();
    expect(info?.panels[2]!.kind).toBe('dock');
    // 停靠侧：缺省 right，显式 left 如实带出（Agent 面按这张表选 id）。
    expect(info?.panels[2]!.side).toBe('right');
    expect(info?.panels[3]!.side).toBe('left');
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

  test('dock 面板是右列里的一节；关掉检查器之后这一列仍然在', async ({ page }) => {
    await plant(page);

    await page.getByTestId('rail-plugins').click();
    await page
      .locator('[data-testid="plugin-panel-open"][data-plugin-panel="e2e-panel/inspector"]')
      .click();

    const drawer = page.getByTestId('drawer');
    const section = drawer.locator('[data-section="e2e-panel/inspector"]');
    await expect(section).toBeVisible();
    await expect(page.getByText('DOCK-UI')).toBeVisible();
    // 与检查器同一条列：两个分节都在同一个容器里。
    await expect(drawer.locator('[data-section="@inspector"]')).toBeVisible();

    /*
     * 共用容器最实际的那一条：关掉检查器不等于关掉这一列。
     * 混成一个开关的表现是「为了看插件面板，被迫一直开着检查器」。
     */
    await drawer.locator('[data-section="@inspector"] [data-testid="dock-section-close"]').click();
    await expect(drawer.locator('[data-section="@inspector"]')).toHaveCount(0);
    await expect(section).toBeVisible();
    const stageW = (await page.locator('.body > .stage').boundingBox())!.width;
    const colW = (await drawer.boundingBox())!.width;
    expect(colW).toBeGreaterThan(200);

    // 关掉最后一块 → 这一列整个让出宽度（与改造前「关抽屉」同样的结果）。
    await section.locator('[data-testid="dock-section-close"]').click();
    await expect(drawer).toHaveCount(0);
    const stageW2 = (await page.locator('.body > .stage').boundingBox())!.width;
    expect(stageW2).toBeGreaterThan(stageW);
  });

  test('同一列里堆两节：宽度相同、上下相邻，折叠只剩标题栏', async ({ page }) => {
    await plant(page);

    if ((await page.getByTestId('drawer').count()) === 0) await page.getByTestId('drawer-open').click();
    const drawer = page.getByTestId('drawer');
    await expect(drawer).toBeVisible();

    await page.getByTestId('rail-plugins').click();
    await page
      .locator('[data-testid="plugin-panel-open"][data-plugin-panel="e2e-panel/inspector"]')
      .click();

    const insp = drawer.locator('[data-section="@inspector"]');
    const dock = drawer.locator('[data-section="e2e-panel/inspector"]');
    const a = (await insp.boundingBox())!;
    const b = (await dock.boundingBox())!;

    // 同一列：左右沿对齐；检查器在上，插件分节在它下面（不是并排）。
    expect(Math.abs(a.x - b.x)).toBeLessThanOrEqual(1);
    expect(Math.abs(a.width - b.width)).toBeLessThanOrEqual(1);
    expect(b.y).toBeGreaterThanOrEqual(a.y + a.height - 1);

    /*
     * 折叠 = 只剩标题栏：内容卸载、分节本身还在（Rail 图标的激活态也不该掉）。
     */
    const headH = a.height > 0 ? (await insp.locator('.head').boundingBox())!.height : 0;
    await insp.locator('[data-testid="dock-section-toggle"]').click();
    await expect(insp.locator('[data-testid="dock-section-body"]')).toHaveCount(0);
    const collapsed = (await insp.boundingBox())!;
    expect(collapsed.height).toBeLessThanOrEqual(headH + 1);

    // 插件分节吃到省下来的高度。
    const b2 = (await dock.boundingBox())!;
    expect(b2.height).toBeGreaterThan(b.height);

    // 再点一次 = 展开回来。
    await insp.locator('[data-testid="dock-section-toggle"]').click();
    await expect(insp.locator('[data-testid="dock-section-body"]')).toBeVisible();
    await expect(insp).toHaveAttribute('data-section', '@inspector');
  });

  test('左侧：插件分节与原生媒体池住在同一个容器里，同侧多个面板各占一节', async ({ page }) => {
    await plant(page);

    // 原生面板先开（媒体池），再开一个左侧插件面板。
    await page.getByTestId('rail-media').click();
    const pool = page.getByTestId('media-drawer');
    await expect(pool).toBeVisible();

    await page.getByTestId('rail-plugins').click();
    await page.locator('[data-testid="plugin-panel-open"][data-plugin-panel="e2e-panel/edge"]').click();

    const left = page.getByTestId('plugin-dock-left');
    await expect(left).toBeVisible();
    await expect(page.getByText('LEFT-DOCK-UI')).toBeVisible();

    const rail = (await page.locator('aside.rail').boundingBox())!;
    const poolBox = (await pool.boundingBox())!;
    const dockBox = (await left.boundingBox())!;
    const stage = (await page.locator('.body > .stage').boundingBox())!;

    // 紧贴图标栏（rail 的右沿），整列都在舞台左边。
    expect(Math.abs(poolBox.x - (rail.x + rail.width))).toBeLessThanOrEqual(1);
    expect(dockBox.x + dockBox.width).toBeLessThanOrEqual(stage.x + 1);

    /*
     * **同一个容器**：左右沿与媒体池对齐、排在它下面。
     * 各占一条轨道时这里会差出几百像素 —— 那正是「看着还是两块」的判据。
     */
    expect(Math.abs(dockBox.x - poolBox.x)).toBeLessThanOrEqual(1);
    expect(Math.abs(dockBox.width - poolBox.width)).toBeLessThanOrEqual(1);
    expect(dockBox.y).toBeGreaterThanOrEqual(poolBox.y + poolBox.height - 1);

    /*
     * 同侧第二个面板 = 第二**节**（不是切 tab）：两块同时可见，各自能折。
     */
    await page.getByTestId('rail-plugins').click();
    await page
      .locator('[data-testid="plugin-panel-open"][data-plugin-panel="e2e-panel/edge2"]')
      .click();
    await expect(page.getByText('LEFT-DOCK-2-UI')).toBeVisible();
    await expect(page.getByText('LEFT-DOCK-UI')).toBeVisible();

    const edge2 = left.locator('[data-section="e2e-panel/edge2"]');
    await edge2.locator('[data-testid="dock-section-toggle"]').click();
    await expect(edge2.locator('[data-testid="dock-section-body"]')).toHaveCount(0);
    await expect(page.getByText('LEFT-DOCK-2-UI')).toHaveCount(0);
    // 折叠 ≠ 关闭：分节还在，另一个分节也没被动过。
    await expect(edge2).toBeVisible();
    await expect(page.getByText('LEFT-DOCK-UI')).toBeVisible();

    // 关掉 edge2 → 只剩 edge；再关 edge → 插件分节全没了，媒体池还在。
    await edge2.locator('[data-testid="dock-section-close"]').click();
    await expect(edge2).toHaveCount(0);
    await expect(page.getByText('LEFT-DOCK-UI')).toBeVisible();

    await left
      .locator('[data-section="e2e-panel/edge"] [data-testid="dock-section-close"]')
      .click();
    await expect(left).toHaveCount(0);
    await expect(pool).toBeVisible();
  });

  test('折叠的分节可以拖动换位置，顺序跟着工程走', async ({ page }) => {
    await plant(page);

    for (const id of ['edge', 'edge2']) {
      await page.getByTestId('rail-plugins').click();
      await page.locator(`[data-testid="plugin-panel-open"][data-plugin-panel="e2e-panel/${id}"]`).click();
    }
    const left = page.getByTestId('plugin-dock-left');
    const edge = left.locator('[data-section="e2e-panel/edge"]');
    const edge2 = left.locator('[data-section="e2e-panel/edge2"]');
    await expect(edge).toBeVisible();
    await expect(edge2).toBeVisible();

    // 先把两节都折起来（一行标题栏，拖动时不会被内容高度干扰）。
    await edge.locator('[data-testid="dock-section-toggle"]').click();
    await edge2.locator('[data-testid="dock-section-toggle"]').click();

    const before = (await edge.boundingBox())!;
    const target = (await edge2.boundingBox())!;
    // 抓 edge 的标题栏往下拖过 edge2 的中线：两节换位。
    const head = (await edge.locator('[data-testid="dock-section-toggle"]').boundingBox())!;
    await page.mouse.move(head.x + head.width / 2, head.y + head.height / 2);
    await page.mouse.down();
    await page.mouse.move(head.x + head.width / 2, target.y + target.height / 2 + 4, { steps: 6 });
    await page.mouse.up();

    const after = (await edge.boundingBox())!;
    const after2 = (await edge2.boundingBox())!;
    expect(after.y).toBeGreaterThan(before.y);
    expect(after2.y).toBeLessThan(after.y);
    // 拖完不该顺手把那一节折起来（click 被吃掉），两节仍然都是收起的。
    await expect(edge.locator('[data-testid="dock-section-body"]')).toHaveCount(0);

    // 顺序进会话：重开工程后还是这个次序。
    await page.evaluate(() => (window as never as PageApi).__artmatic.project.sessionNow());
    await reopen(page);
    const edge3 = page
      .getByTestId('plugin-dock-left')
      .locator('[data-section="e2e-panel/edge"]');
    const edge4 = page
      .getByTestId('plugin-dock-left')
      .locator('[data-section="e2e-panel/edge2"]');
    const b1 = (await edge3.boundingBox())!;
    const b2 = (await edge4.boundingBox())!;
    expect(b2.y).toBeLessThan(b1.y);
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
    expect(entry?.panels.map((p) => p.id)).toEqual(['floater', 'dialog', 'inspector', 'edge', 'edge2']);
    expect(entry?.panels.map((p) => p.side)).toEqual(['right', 'right', 'right', 'left', 'left']);
    expect(entry?.actions.map((a) => a.id)).toEqual(['echo', 'boom', 'set-opacity']);

    const ui = await page.evaluate(() => (window as never as PageApi).__artmatic.control.listPluginUi());
    expect(ui.ok && ui.data.plugins.some((p) => p.id === 'e2e-panel')).toBe(true);
  });
});
