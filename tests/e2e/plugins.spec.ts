/**
 * plugins.spec.ts — 插件系统的端到端验证。
 *
 * ## 为什么这几条只能在这里测
 *
 * 插件链路上有三件事在 vitest 里**做不到**，而它们恰好是最容易坏的三件：
 *
 *   1. `import(blob:…)` —— Node 的 ESM 加载器不支持 blob 协议，
 *      动态导入那一行在 node 环境里必然抛 `ERR_UNSUPPORTED_ESM_URL_SCHEME`。
 *   2. 着色器**编译校验** —— 伪 GL 永远编得过（`effect-uniforms.test.ts`
 *      的注释里写着这条），只有真 `WebGL2RenderingContext` 能回答「这段 GLSL
 *      到底能不能用」。
 *   3. 「插件特效真的出现在画面上」—— 那是 `Renderer` 的整条合成链。
 *
 * 所以这里跑的是**真实浏览器 + 真实 OPFS 工程目录**（与 `project.spec.ts`
 * 同一条理由：`navigator.storage.getDirectory()` 给的就是生产用的那种
 * `FileSystemDirectoryHandle`，不是桩）。
 */

import { expect, test, type Page } from '@playwright/test';
import { openDemo, buildStage } from './_stage';

const DIR = 'e2e-plugins';

type PluginInfo = {
  id: string;
  name: string | null;
  status: 'ok' | 'partial' | 'failed' | 'disabled';
  enabled: boolean;
  effectCount: number;
  generatorCount: number;
  hookCount?: number;
  issues: { code: string; path?: string; detail?: string }[];
  failure: { code: string; detail: string } | null;
};

type PageApi = {
  __artmatic: {
    project: {
      useOpfs(name?: string): Promise<string>;
      save(): Promise<boolean>;
      open(name?: string): Promise<boolean>;
      write(path: string, bytes: number[]): Promise<void>;
      list(path?: string): Promise<{ name: string; kind: string }[]>;
      wipe(name?: string): Promise<void>;
    };
    plugins: {
      list(): PluginInfo[];
      installed(): string[];
      missing(): { pluginId: string; count: number; defIds: string[] }[];
      revision(): number;
    };
    renderer: { onSeek: () => void };
    renderFrame: (t: number) => void;
    readPixels: () => { data: number[]; w: number; h: number };
    store: {
      project: { tracks: { kind: string; clips: unknown[] }[] };
      commit: (label: string, fn: (p: { tracks: { kind: string; clips: unknown[] }[] }) => void) => void;
    };
    typoRasterize: (
      doc: unknown,
      w: number,
      h: number,
      t: number,
    ) => Promise<{ w: number; h: number; ink: number; sum: number; hash: string }>;
  };
};

/* ------------------------------------------------------------------ 夹具 */

/** 一个「画成纯色」的特效 + 生成器。纯色最容易断言：整帧只有一个值。 */
function paintPlugin(id: string, name = 'E2E Plugin'): string {
  const red = JSON.stringify('void main() { outColor = vec4(1.0, 0.0, 0.0, 1.0); }');
  const green = JSON.stringify('void main() { outColor = vec4(0.0, 1.0, 0.0, 1.0); }');
  return `
export const plugin = {
  format: 'artmatic-plugin',
  apiVersion: 1,
  id: ${JSON.stringify(id)},
  name: ${JSON.stringify(name)},
  version: '1.0.0',
  license: 'MIT',
  effects: [
    {
      id: 'paint-red',
      name: 'Paint Red',
      desc: '把整幅画面涂成红色。',
      category: 'color',
      tags: ['overlay'],
      params: [],
      shader: { fragment: ${red}, setUniforms: () => {} },
    },
  ],
  generators: [
    {
      id: 'paint-green',
      name: 'Paint Green',
      params: [],
      fragment: ${green},
      setUniforms: () => {},
    },
  ],
};
`;
}

/** 一个着色器编不过的插件（真的语法错误，不是「能编过但画不出来」）。 */
function brokenShaderPlugin(id: string): string {
  const bad = JSON.stringify('void main() { outColor = vec4(1.0 ; }');
  return `
export const plugin = {
  format: 'artmatic-plugin',
  apiVersion: 1,
  id: ${JSON.stringify(id)},
  name: 'Broken Shader',
  effects: [
    { id: 'broken', name: 'Broken', params: [], shader: { fragment: ${bad}, setUniforms: () => {} } },
  ],
};
`;
}

async function boot(page: Page): Promise<void> {
  await page.goto('/');
  await page.waitForFunction(() => (window as never as PageApi).__artmatic);
  await openDemo(page);
  // 上一轮的残留会让「文件存在」这类断言假绿。
  await page.evaluate((d) => (window as never as PageApi).__artmatic.project.wipe(d), DIR);
}

/** 接上 OPFS 目录（之后 `save()` 就写到这里）。 */
function attach(page: Page): Promise<void> {
  return page.evaluate((d) => (window as never as PageApi).__artmatic.project.useOpfs(d), DIR).then(() => {});
}

function save(page: Page): Promise<boolean> {
  return page.evaluate(() => (window as never as PageApi).__artmatic.project.save());
}

/** 打开工程目录里的那份（走真实的「打开 → 读盘 → 挂插件」链路）。 */
async function reopen(page: Page): Promise<void> {
  const ok = await page.evaluate((d) => (window as never as PageApi).__artmatic.project.open(d), DIR);
  expect(ok).toBe(true);
}

/** 往工程目录里塞一个插件文件（`project.write` 会自动建出 plugins/）。 */
async function plantPlugin(page: Page, fileName: string, source: string): Promise<void> {
  await page.evaluate(({ path, bytes }) => (window as never as PageApi).__artmatic.project.write(path, bytes), {
    path: `${DIR}/plugins/${fileName}`,
    bytes: Array.from(new TextEncoder().encode(source)),
  });
}

function pluginList(page: Page): Promise<PluginInfo[]> {
  return page.evaluate(() => (window as never as PageApi).__artmatic.plugins.list());
}

function pluginFileNames(page: Page): Promise<string[]> {
  return page
    .evaluate((d) => (window as never as PageApi).__artmatic.project.list(`${d}/plugins`), DIR)
    .then((items) => items.map((i) => i.name).sort());
}

/**
 * 渲一帧并量出三个通道的平均值。
 *
 * **渲染与读像素必须在同一次 `evaluate` 里**：应用的 rAF 循环会按
 * `playT` 持续重画，两次 evaluate 之间插进来的那一帧会把我们刚渲的画面覆盖掉
 * （而它渲的是另一个时刻，颜色完全不同）。这条踩过 —— 表现是「偶尔读到源色」。
 */
function renderAndMeasure(page: Page, t = 1): Promise<{ r: number; g: number; b: number }> {
  return page.evaluate((time) => {
    const A = (window as never as PageApi).__artmatic;
    A.renderer.onSeek();
    A.renderFrame(time);
    const d = A.readPixels().data;
    let r = 0;
    let g = 0;
    let b = 0;
    const n = d.length / 4;
    for (let i = 0; i < d.length; i += 4) {
      r += d[i]!;
      g += d[i + 1]!;
      b += d[i + 2]!;
    }
    return { r: r / n, g: g / n, b: b / n };
  }, t);
}

/* ------------------------------------------------------------------ 用例 */

test.describe('插件：保存进工程目录、重开自动挂载', () => {
  test.beforeEach(async ({ page }) => boot(page));

  test('插件文件落在 plugins/ 下，重开被挂载，且特效与生成器真的生效', async ({ page }) => {
    await attach(page);
    await plantPlugin(page, 'e2e.js', paintPlugin('e2e-paint'));
    await save(page);

    expect(await pluginFileNames(page)).toEqual(['e2e.js']);

    await reopen(page);

    const list = await pluginList(page);
    expect(list.map((p) => p.id)).toEqual(['e2e-paint']);
    expect(list[0]!.status).toBe('ok');
    expect(list[0]!.name).toBe('E2E Plugin');
    expect(list[0]!.effectCount).toBe(1);
    expect(list[0]!.generatorCount).toBe(1);
    expect(list[0]!.issues).toEqual([]);

    // ★ 最关键的一条：插件的着色器**真的跑起来了**。
    // 用纯蓝 solid 当源，套上插件特效，整帧应当是红的。
    await buildStage(
      page,
      { id: 'e2e-src', source: { type: 'solid', color: '#0000ff' } },
      { id: 'e2e-fx', defId: 'e2e-paint/paint-red', values: {} },
    );
    const red = await renderAndMeasure(page);
    expect(red.r, '插件特效没有生效（画面不是红的）').toBeGreaterThan(200);
    expect(red.b, '源色还在，说明特效被透传了').toBeLessThan(50);

    // 插件生成器同样生效。
    await buildStage(page, {
      id: 'e2e-gen',
      source: { type: 'algo', generator: 'e2e-paint/paint-green', params: {} },
    });
    const green = await renderAndMeasure(page);
    expect(green.g, '插件生成器没有生效').toBeGreaterThan(200);
    expect(green.r).toBeLessThan(50);
  });

  test('插件没有静态缩略图：选择器里显示品牌占位图，且与有图的卡片等高', async ({ page }) => {
    await attach(page);
    await plantPlugin(page, 'e2e.js', paintPlugin('e2e-paint'));
    await save(page);
    await reopen(page);

    // 搭一条引用插件生成器的片段并选中它 —— 检查器的「更换算法艺术」才会出现。
    await buildStage(page, {
      id: 'e2e-ph-algo',
      source: { type: 'algo', generator: 'e2e-paint/paint-green', params: {} },
    });
    await page.evaluate(() => {
      (window as never as { __artmatic: { appState: { selectedClipId: string | null } } })
        .__artmatic.appState.selectedClipId = 'e2e-ph-algo';
    });
    await page.getByTestId('insp-change-algo').click();
    await expect(page.getByTestId('modal-algo-picker')).toBeVisible();

    // 插件生成器没有随应用发出的 WebP ⇒ 走品牌占位图，而不是一个空框。
    const pluginCard = page.locator('[data-testid="algo-picker-item"][data-algo-id="e2e-paint/paint-green"]');
    await expect(pluginCard).toBeVisible();
    await expect(pluginCard.locator('[data-testid=thumb-placeholder]')).toBeVisible();
    await expect(pluginCard.locator('img')).toHaveCount(0);

    /*
     * 等高判据用几何而不是「有没有那个元素」：缩略图块缺席时元素断言照样过，
     * 卡片却比同排矮一截（这正是本功能的由来）。16:9 的框常驻 ⇒ 两者只差
     * 亚像素；给 1px 容差是因为网格列宽有小数。
     * 用 poll：modal 有进场动画，动画中途量到的 y/高度都在变换中。
     */
    const builtIn = page.locator('[data-testid="algo-picker-item"][data-algo-id="rule110"]');
    await expect(builtIn.locator('img')).toHaveCount(1);
    await expect
      .poll(async () => {
        const a = await pluginCard.locator('.ap-thumb').boundingBox();
        const b = await builtIn.locator('.ap-thumb').boundingBox();
        return a && b ? Math.abs(a.height - b.height) : 999;
      })
      .toBeLessThanOrEqual(1);
  });

  test('插件出现在管理面板里（Rail → 插件）', async ({ page }) => {
    await attach(page);
    await plantPlugin(page, 'e2e.js', paintPlugin('e2e-paint', '面板里的名字'));
    await save(page);
    await reopen(page);

    await page.getByTestId('rail-plugins').click();
    const row = page.locator('[data-plugin-id="e2e-paint"]');
    await expect(row).toBeVisible();
    await expect(row.getByTestId('plugin-name')).toHaveText('面板里的名字');
    await expect(row.getByTestId('plugin-status')).toHaveText('正常');
    await expect(page.getByTestId('plugins-summary')).toContainText('1');
  });

  test('停用：文件改成 .disabled，重开不再加载', async ({ page }) => {
    await attach(page);
    // 文件名与插件 id 一致 —— 我们自己导入的插件都是这种形态
    // （写盘用的是 `<清单 id>.js`），而停用要按**磁盘名**改名。
    await plantPlugin(page, 'e2e-paint.js', paintPlugin('e2e-paint'));
    await save(page);
    await reopen(page);

    await page.getByTestId('rail-plugins').click();
    await page.getByTestId('plugin-toggle-e2e-paint').click();
    await expect(page.locator('[data-plugin-id="e2e-paint"] [data-testid="plugin-status"]')).toHaveText('已停用');

    expect(await pluginFileNames(page)).toEqual(['e2e-paint.js.disabled']);

    // 重开：文件还在，但**不导入**它 —— 连名字都读不到，状态是「已停用」。
    // 这一条是「停用不该执行插件代码」的可见后果（面板上要为此写一句解释）。
    await reopen(page);
    const list = await pluginList(page);
    expect(list.map((p) => [p.id, p.status, p.name])).toEqual([['e2e-paint', 'disabled', null]]);
  });

  test('移除：文件从工程目录里消失', async ({ page }) => {
    await attach(page);
    await plantPlugin(page, 'e2e.js', paintPlugin('e2e-paint'));
    await save(page);
    await reopen(page);

    await page.getByTestId('rail-plugins').click();
    await page.getByTestId('plugin-remove-e2e-paint').click();
    await page.getByTestId('plugin-remove-confirm-ok').click();

    await expect(page.getByTestId('plugin-row')).toHaveCount(0);
    expect(await pluginFileNames(page)).toEqual([]);
    expect(await pluginList(page)).toEqual([]);
  });
});

test.describe('插件：Agent 读已安装的源码', () => {
  test.beforeEach(async ({ page }) => boot(page));

  test('plugin_view 按行读回磁盘上的文件，并说明还有多少行', async ({ page }) => {
    await attach(page);
    await plantPlugin(page, 'e2e-read.js', paintPlugin('e2e-read'));
    await save(page);
    await reopen(page);

    const r = await page.evaluate(async () => {
      const C = (
        window as never as {
          __artmatic: {
            control: {
              pluginView(input: Record<string, unknown>): Promise<{
                ok: boolean;
                data?: {
                  origin: string;
                  from: number;
                  to: number;
                  total: number;
                  hasMore: boolean;
                  nextOffset: number | null;
                  text: string;
                };
                error?: { code: string };
              }>;
              pluginSource(pluginId: string): Promise<{
                ok: boolean;
                data?: { source: string | null };
              }>;
            };
          };
        }
      ).__artmatic.control;
      const view = await C.pluginView({ pluginId: 'e2e-read', offset: 1, limit: 3 });
      // 审批卡走这条：`plugin_try` 省略 source 重挂已安装插件时，用户必须能
      // 看到即将执行的那份源码（不能因为是磁盘上的就空着）。
      const approval = await C.pluginSource('e2e-read');
      return { view, approval };
    });

    expect(r.view.ok, r.view.error?.code).toBe(true);
    expect(r.approval.data?.source ?? '').toContain('artmatic-plugin');
    const data = r.view.data!;
    // 这条覆盖的是「读磁盘」那条接缝：草稿区里没有它，只能走 host.readSource。
    expect(data.origin).toBe('file');
    expect(data.from).toBe(1);
    expect(data.to).toBe(3);
    expect(data.total).toBeGreaterThan(3);
    expect(data.hasMore).toBe(true);
    expect(data.nextOffset).toBe(4);
    expect(data.text).toContain('  1 | ');
    expect(data.text).toContain('more lines; continue with offset=4');
  });
});

test.describe('插件：坏插件不许拖垮任何东西', () => {
  test.beforeEach(async ({ page }) => boot(page));

  test('着色器编不过：条目被剔除并记下原因，画面照常', async ({ page }) => {
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(String(e)));

    await attach(page);
    await plantPlugin(page, 'broken.js', brokenShaderPlugin('e2e-broken'));
    await save(page);
    await reopen(page);

    const list = await pluginList(page);
    expect(list).toHaveLength(1);
    expect(list[0]!.id).toBe('e2e-broken');
    expect(list[0]!.status, '编不过的插件不该是「正常」').toBe('failed');
    expect(list[0]!.effectCount).toBe(0);
    expect(list[0]!.issues.some((i) => i.code === 'compile-failed')).toBe(true);

    // 应用没崩，而且能照常渲染（引用了这个坏 def 的片段按「缺失」透传）。
    await buildStage(
      page,
      { id: 'e2e-src', source: { type: 'solid', color: '#0000ff' } },
      { id: 'e2e-fx', defId: 'e2e-broken/broken', values: {} },
    );
    const px = await renderAndMeasure(page);
    expect(px.b, '未知特效应当原样透传（蓝色还在）').toBeGreaterThan(200);
    expect(errors, `不该有未捕获异常：${errors.join(' | ')}`).toEqual([]);

    // 面板上读得到原因（编译失败是**用户唯一能看到**的线索）。
    await page.getByTestId('rail-plugins').click();
    await expect(page.locator('[data-plugin-id="e2e-broken"] [data-testid="plugin-issues"]')).toContainText('编不过');
  });

  test('不是插件（没有导出 plugin 对象）：记一条失败，不崩', async ({ page }) => {
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(String(e)));

    await attach(page);
    await plantPlugin(page, 'notplugin.js', 'export const something = 1;\n');
    await save(page);
    await reopen(page);

    const list = await pluginList(page);
    expect(list).toHaveLength(1);
    expect(list[0]!.failure?.code).toBe('not-a-plugin');
    expect(list[0]!.status).toBe('failed');
    expect(errors).toEqual([]);
  });

  test('语法错误的文件：import 失败，只记在自己头上', async ({ page }) => {
    await attach(page);
    await plantPlugin(page, 'good.js', paintPlugin('e2e-good'));
    await plantPlugin(page, 'syntax.js', 'export const plugin = { this is not js };\n');
    await save(page);
    await reopen(page);

    const byId = new Map((await pluginList(page)).map((p) => [p.id, p]));
    expect(byId.get('e2e-good')!.status, '好插件不该被坏邻居连累').toBe('ok');
    expect(byId.get('syntax')!.failure?.code).toBe('import-failed');
  });
});

test.describe('插件：缺失降级', () => {
  test.beforeEach(async ({ page }) => boot(page));

  test('引用未加载的插件：提示条出现、数据不丢、其它图层照常；补载后恢复', async ({ page }) => {
    await attach(page);
    await save(page);
    await reopen(page);

    /*
     * 搭一个「纯蓝底 + 一个引用幽灵插件的特效」的舞台。
     *
     * **必须走 `buildStage` 的 effect 参数**，不能自己往 `tracks[0]` 上挂片段：
     * `buildStage` 没有特效时 `tracks[0]` 是某条**被关掉的 demo 轨**，
     * 挂上去的片段永不参与渲染 —— 那样这个用例会「通过」，但它测的是
     * 「关掉的轨上的缺失引用」，与本意无关。
     */
    await buildStage(
      page,
      { id: 'e2e-src', source: { type: 'solid', color: '#0000ff' } },
      { id: 'e2e-ghost', defId: 'ghost-plugin/paint-red', values: {} },
    );

    const missing = await page.evaluate(() => (window as never as PageApi).__artmatic.plugins.missing());
    expect(missing.map((m) => m.pluginId)).toEqual(['ghost-plugin']);
    expect(missing[0]!.count).toBe(1);

    await expect(page.getByTestId('plugin-missing-banner')).toBeVisible();
    await expect(page.getByTestId('plugin-missing-banner')).toContainText('ghost-plugin');

    // 画面照常（缺的特效被透传，源色还在）。
    const px = await renderAndMeasure(page);
    expect(px.b).toBeGreaterThan(200);

    // 片段与参数**一个字都没丢** —— 补上插件就该恢复。
    const kept = await page.evaluate(() => {
      const A = (window as never as PageApi).__artmatic as unknown as {
        store: { project: { tracks: { clips: { chain?: { defId: string }[] }[] }[] } };
      };
      for (const t of A.store.project.tracks) {
        for (const c of t.clips) {
          if (c.chain?.[0]?.defId === 'ghost-plugin/paint-red') return true;
        }
      }
      return false;
    });
    expect(kept, '缺失插件引用的片段必须原样保留').toBe(true);

    /*
     * 补载。
     *
     * 这里没有现成的「导入」入口可点（文件选择器 Playwright 驱动不了，
     * 与 `showDirectoryPicker` 同一条理由），所以走的是**用户真实会走的另一条路**：
     * 把插件放进工程目录，再打开这个工程。两条路最终都汇到
     * `PluginHost` 的同一段注册逻辑上。
     *
     * `save()` 会把当前这份（含幽灵片段的）工程写回目录，所以重开之后
     * 工程里**仍然有那条引用** —— 而插件已经在目录里了。
     */
    await plantPlugin(page, 'ghost.js', paintPlugin('ghost-plugin'));
    await save(page);
    await reopen(page);

    const after = await page.evaluate(() => (window as never as PageApi).__artmatic.plugins.missing());
    expect(after, '装了插件之后就不该再报缺失').toEqual([]);
    await expect(page.getByTestId('plugin-missing-banner')).toBeHidden();

    // 而且那条引用现在**真的生效**了（幽灵片段套的是 paint-red）。
    const red = await renderAndMeasure(page);
    expect(red.r, '补载之后特效应当立即恢复').toBeGreaterThan(200);
  });
});

/* ------------------------------------------------ 排版文档钩子（apiVersion 2） */

/** 一个只带排版钩子的插件：open 把背景改成绿色，render 改成蓝色。 */
function typoHookPlugin(id: string): string {
  return `
export const plugin = {
  format: 'artmatic-plugin',
  apiVersion: 2,
  id: ${JSON.stringify(id)},
  name: 'Typo Hooks',
  license: 'MIT',
  typography: {
    hooks: [
      {
        id: 'open-bg',
        name: 'Open: green background',
        phase: 'open',
        run(doc) {
          return { ...doc, background: { kind: 'solid', color: '#00ff00' } };
        },
      },
      {
        id: 'render-hide',
        name: 'Render: hide every element',
        phase: 'render',
        run(doc) {
          return { ...doc, elements: doc.elements.map((e) => ({ ...e, visible: false })) };
        },
      },
    ],
  },
};
`;
}

/** 一条白色矩形 —— render 钩子会把它藏起来（墨迹从有到 0，方向明确）。 */
function hookDoc() {
  return {
    size: { w: 640, h: 360 },
    background: { kind: 'none' },
    elements: [
      {
        kind: 'shape',
        id: 'band',
        name: 'band',
        frame: { x: 0, y: 12, w: 640, h: 48, rot: 0 },
        blend: 'normal',
        opacity: 1,
        visible: true,
        locked: false,
        animations: [],
        shape: 'rect',
        fill: { kind: 'solid', color: '#ffffff' },
        stroke: null,
      },
    ],
    fonts: [],
  };
}

test.describe('插件：排版文档钩子', () => {
  test.beforeEach(async ({ page }) => boot(page));

  test('render 钩子影响出图；open 钩子在打开工程时改写文档', async ({ page }) => {
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(String(e)));

    await attach(page);
    await plantPlugin(page, 'hooks.js', typoHookPlugin('e2e-hooks'));

    // 工程里放一条文本片段：open 钩子要有东西可改。
    await page.evaluate(({ doc }) => {
      const A = (window as never as PageApi).__artmatic;
      A.store.commit('e2e: add text clip', (p) => {
        const track = p.tracks.find((t) => t.kind === 'visual');
        if (!track) return;
        track.clips.push({
          kind: 'source',
          id: 'hook-txt',
          start: 0,
          end: 1,
          label: 'hooks',
          fadeSec: 0,
          curves: {},
          source: { type: 'text', doc },
          blend: 'normal',
          opacity: 1,
          transform: { x: 0.5, y: 0.5, sx: 1, sy: 1, rot: 0 },
          fit: 'contain',
        });
      });
    }, { doc: hookDoc() });
    /*
     * 控制组：插件还没被挂载（只有文件躺在目录里），光栅化应当画得出那条白带。
     * 少了这一步，下面的「ink = 0」可能只是「文档本来就是空的」。
     */
    const before = await page.evaluate(async (doc) => {
      const A = (window as never as PageApi).__artmatic;
      return A.typoRasterize(doc, 640, 360, 0);
    }, hookDoc());
    expect(before.ink).toBeGreaterThan(0);

    await save(page);
    await reopen(page);

    const info = (await pluginList(page))[0]!;
    expect(info.status, '钩子只在合成文档上跑不通才会失败').toBe('ok');
    expect(info.hookCount).toBe(2);
    expect(info.issues).toEqual([]);

    // ① render 钩子：光栅化前把所有元素藏掉 ⇒ 白带消失。
    const shot = await page.evaluate(async (doc) => {
      const A = (window as never as PageApi).__artmatic;
      return A.typoRasterize(doc, 640, 360, 0);
    }, hookDoc());
    expect(shot.ink).toBe(0);

    // ② open 钩子：重开后的文档背景已经是绿的（且没有静默丢掉元素）。
    const bg = await page.evaluate(() => {
      type ClipLike = { source?: { type?: string; doc?: { background?: { color?: string } } } };
      const A = (window as never as PageApi).__artmatic as unknown as {
        store: { project: { tracks: { clips: ClipLike[] }[] } };
      };
      for (const t of A.store.project.tracks) {
        for (const c of t.clips) {
          if (c.source?.type === 'text') return c.source.doc?.background?.color ?? null;
        }
      }
      return null;
    });
    expect(bg).toBe('#00ff00');
    expect(errors, `不该有未捕获异常：${errors.join(' | ')}`).toEqual([]);
  });
});
