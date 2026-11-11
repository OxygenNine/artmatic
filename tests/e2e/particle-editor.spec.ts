import { expect, test, type Page } from '@playwright/test';
import { buildStage, openDemo, settle } from './_stage';

/**
 * 粒子全屏编辑器的 E2E。
 *
 * 判据落在「画面常驻」这条架构约束上：进页前后必须是同一个 `<canvas>` 元素。
 * 卸载 Preview 会丢 WebGL 上下文，重新挂载也恢复不了，而且不报错。
 * 所以这里用 DOM 节点身份断言，而不是「面板出现了」。
 */

async function boot(page: Page): Promise<void> {
  await page.goto('/');
  await page.waitForFunction(() => (window as never as { __artmatic?: unknown }).__artmatic);
  await openDemo(page);
  await buildStage(page, {
    id: 'p-edit',
    source: { type: 'algo', generator: 'particles', params: { intRes: '480' } },
    end: 8,
  });
  await settle(page, 2);
}

/** 预览 canvas 的 DOM 身份。用一个稳定的标记挂在元素上，进出页面后读回来。 */
async function markPreview(page: Page): Promise<void> {
  await page.evaluate(() => {
    const c = document.querySelector('.preview canvas');
    if (!c) throw new Error('找不到 Preview canvas');
    c.setAttribute('data-e2e-mark', 'kept');
  });
}

async function previewKept(page: Page): Promise<boolean> {
  return page.evaluate(() => {
    const c = document.querySelector('.preview canvas');
    return c?.getAttribute('data-e2e-mark') === 'kept' && c.isConnected;
  });
}

test('双击粒子片段进全屏编辑器；画面常驻；Esc 回时间轴', async ({ page }) => {
  test.setTimeout(180_000);
  await boot(page);
  await markPreview(page);

  await page.locator('[data-clip-id="p-edit"]').dblclick();
  await expect(page.getByTestId('particle-panels')).toBeVisible();
  await expect(page.getByTestId('particle-dock')).toBeVisible();
  await expect(page.getByTestId('project-tab-particles-0')).toBeVisible();

  // 同一个 canvas 元素，没被卸载重建。
  expect(await previewKept(page), 'Preview 必须常驻，卸载会丢 WebGL 上下文').toBe(true);
  // 时间轴只是隐藏，不是卸载。
  await expect(page.getByTestId('tl-scroll')).toBeHidden();

  await page.keyboard.press('Escape');
  await expect(page.getByTestId('particle-panels')).toHaveCount(0);
  await expect(page.getByTestId('tl-scroll')).toBeVisible();
  expect(await previewKept(page), '退出后仍是同一个 canvas').toBe(true);
});

test('分组折叠、预设应用与参数回显', async ({ page }) => {
  test.setTimeout(180_000);
  await boot(page);
  await page.locator('[data-clip-id="p-edit"]').dblclick();
  await expect(page.getByTestId('particle-panels')).toBeVisible();

  // 力场组出厂折叠；点开后能看见里面的参数行。
  const forces = page.getByTestId('particle-group-forces');
  await expect(forces).toBeVisible();
  await expect(page.getByTestId('particle-param-gravityY')).toHaveCount(0);
  await page.getByTestId('particle-group-toggle-forces').click();
  await expect(page.getByTestId('particle-param-gravityY')).toBeVisible();

  // 应用「落雪」预设：只改预设声明过的键，一笔提交。
  await page.getByTestId('particle-preset-snow').click();
  const stored = await page.evaluate(() => {
    const A = (window as never as {
      __artmatic: { store: { findClip: (id: string) => { clip: { source: { params: Record<string, unknown> } } } | null } };
    }).__artmatic;
    return A.store.findClip('p-edit')?.clip.source.params ?? {};
  });
  expect(stored.shape).toBe('box');
  expect(stored.count).toBe(6000);
});

/**
 * 三列同高、画面居中。
 *
 * 这条盯的是**自动排布的行**：`.stage` 在 DOM 里排在两个 aside 之后，而栅格的
 * 列游标只往前走 —— 一旦 `.body > * { grid-row: 1 }` 那条基础规则少了，舞台就落到
 * 第二行、两行各占半高。表现是「左侧参数面板只有半屏、下面空一大块，画面贴到
 * 窗口下沿」，而所有功能用例都照常绿。
 */
test('布局：左右两栏与画面同高，画面在自己的格子里居中', async ({ page }) => {
  test.setTimeout(180_000);
  await boot(page);
  await page.locator('[data-clip-id="p-edit"]').dblclick();
  await expect(page.getByTestId('particle-panels')).toBeVisible();

  const geo = await page.evaluate(() => {
    const box = (sel: string) => {
      const el = document.querySelector(sel);
      if (!el) return null;
      const b = el.getBoundingClientRect();
      return { x: b.x, y: b.y, w: b.width, h: b.height };
    };
    return {
      body: box('.body'),
      panels: box('[data-testid=particle-panels]'),
      dock: box('[data-testid=particle-dock]'),
      preview: box('.preview'),
      canvas: box('.preview canvas'),
    };
  });
  const body = geo.body!;
  const panels = geo.panels!;
  const dock = geo.dock!;
  const preview = geo.preview!;
  const canvas = geo.canvas!;

  expect(panels.h, '左栏被挤成半高').toBeGreaterThan(body.h - 2);
  expect(dock.h, '右栏被挤成半高').toBeGreaterThan(body.h - 2);
  expect(preview.y, '画面被挤到第二行').toBeCloseTo(body.y, 0);
  expect(preview.h, '画面没吃到剩余高度').toBeGreaterThan(body.h * 0.8);
  // 信箱边上下对称 = 画面在自己格子里居中。
  const top = canvas.y - preview.y;
  const bottom = preview.y + preview.h - (canvas.y + canvas.h);
  expect(Math.abs(top - bottom), `上下留白不对称（上 ${top} / 下 ${bottom}）`).toBeLessThanOrEqual(2);
});

/**
 * 拖滑杆时面板必须实时跟随。
 *
 * 「能实时响应」有两个方向，缺一个就是「画面在动、控件不动」：**预览**读的是
 * store，所以它总会动；而面板读的是派生出来的片段对象，store 原地改 ⇒ 引用不变
 * ⇒ Svelte 5 判定派生「没变」⇒ 数字框与把手静默断更（`ui/AGENTS.md` 根因一）。
 * 所以这里在**松手前**同时读三样：数字框、把手位置、store 落库值。
 */
test('拖参数滑杆时数字框与把手实时跟随', async ({ page }) => {
  test.setTimeout(180_000);
  await boot(page);
  await page.locator('[data-clip-id="p-edit"]').dblclick();
  await expect(page.getByTestId('particle-panels')).toBeVisible();

  const row = page.getByTestId('particle-param-pointSize');
  const slider = row.getByTestId('param-slider');
  const num = row.locator('input');
  const b = (await slider.boundingBox())!;

  await page.mouse.move(b.x + b.width * 0.5, b.y + b.height / 2);
  await page.mouse.down();
  // 70% 行程：pointSize 是 1…96 的线性量，预期 ≈ 67.5（step 0.5）。
  await page.mouse.move(b.x + b.width * 0.7, b.y + b.height / 2);
  await page.waitForTimeout(120);

  const shown = Number(await num.inputValue());
  const thumb = await slider.evaluate(
    (el) => Number.parseFloat((el.querySelector('.sld-thumb') as HTMLElement).style.left),
  );
  const stored = await page.evaluate(() => {
    const A = (window as never as {
      __artmatic: { store: { findClip: (id: string) => { clip: { source: { params: Record<string, number> } } } | null } };
    }).__artmatic;
    return A.store.findClip('p-edit')!.clip.source.params.pointSize!;
  });
  await page.mouse.up();

  expect(shown, '数字框没跟上 store').toBeCloseTo(stored, 6);
  expect(shown, '滑杆没真正改到参数').toBeGreaterThan(40);
  // 把手位置 = 同一个值的线性映射（1…96）。两边用不同刻度时症状就是「把手在左、数字在右」。
  expect(thumb, `把手位置与落库值不一致（thumb ${thumb}% / value ${stored}）`).toBeCloseTo(
    ((stored - 1) / 95) * 100,
    0,
  );
});

/**
 * 工具条是进度条，不是时间轴那一排编辑控件；粒子数是对数刻度。
 *
 * 两条都是「操作能不能做到」级别的：没有进度条就**无法**换一帧看；
 * 线性刻度的 `count`（256…262144）在 25% 处给的是 65k，而对数刻度给 ~1.4k ——
 * 那正是用户九成时间待着的量级。
 */
test('工具条能拖播放头；粒子数是几百到几十万的跨度，按对数走', async ({ page }) => {
  test.setTimeout(180_000);
  await boot(page);
  await page.locator('[data-clip-id="p-edit"]').dblclick();
  await expect(page.getByTestId('particle-panels')).toBeVisible();

  // 时间轴的编辑控件不在这一页。
  await expect(page.getByTestId('play-toggle'), 'Transport 还在粒子页工具条里').toHaveCount(0);

  const before = await page.evaluate(
    () => (window as never as { __artmatic: { appState: { playT: number } } }).__artmatic.appState.playT,
  );
  const bar = page.getByTestId('particle-scrub');
  const bb = (await bar.boundingBox())!;
  await page.mouse.move(bb.x + bb.width * 0.7, bb.y + bb.height / 2);
  await page.mouse.down();
  await page.mouse.up();
  const after = await page.evaluate(
    () => (window as never as { __artmatic: { appState: { playT: number } } }).__artmatic.appState.playT,
  );
  expect(after, '拖进度条没有移动播放头').toBeGreaterThan(Math.max(before + 1, 2));

  // 对数刻度：25% 行程 ≈ sqrt(min·max)/… 附近，绝不能是线性的 65k。
  const countRow = page.getByTestId('particle-param-count');
  const countSlider = countRow.getByTestId('param-slider');
  const cb = (await countSlider.boundingBox())!;
  await page.mouse.click(cb.x + cb.width * 0.25, cb.y + cb.height / 2);
  await page.waitForTimeout(200);
  const count = await page.evaluate(() => {
    const A = (window as never as {
      __artmatic: { store: { findClip: (id: string) => { clip: { source: { params: Record<string, number> } } } | null } };
    }).__artmatic;
    return A.store.findClip('p-edit')!.clip.source.params.count!;
  });
  // 256 * 1024^0.25 = 1448。给一个宽区间：这里守的是「不是 65k」，不是精确值。
  expect(count, `25% 处给了 ${count}，不像对数刻度`).toBeGreaterThan(500);
  expect(count).toBeLessThan(6000);
});

test('Agent 写后读回：asset 参数与预设值同形', async ({ page }) => {
  test.setTimeout(180_000);
  await boot(page);

  const result = await page.evaluate(async () => {
    const C = (window as never as {
      __artmatic: {
        control: {
          setClipSourceParams: (id: string, p: object) => Promise<{
            ok: boolean;
            data?: { values: Record<string, number | string> };
            error?: { code: string };
          }>;
          getCapabilities: (opt: object) => Promise<{
            ok: boolean;
            data?: { features: { particles: { presets: string[]; assetParams: string[] } } };
          }>;
        };
      };
    }).__artmatic.control;

    const caps = await C.getCapabilities({ detail: 'params', ids: ['particles'] });
    const write = await C.setClipSourceParams('p-edit', { life: 4.5, spriteAsset: '' });
    const bad = await C.setClipSourceParams('p-edit', { spriteAsset: 'no-such-asset' });
    const after = await C.setClipSourceParams('p-edit', { life: 4.5 });
    return {
      presets: caps.data?.features.particles.presets ?? [],
      assetParams: caps.data?.features.particles.assetParams ?? [],
      writeOk: write.ok,
      badOk: bad.ok,
      badCode: bad.error?.code ?? null,
      afterValues: after.data?.values ?? {},
    };
  });

  expect(result.presets).toContain('snow');
  expect(result.assetParams).toContain('emitAsset');
  expect(result.writeOk).toBe(true);
  expect(result.badOk, '未知 assetId 必须在写库前被拒').toBe(false);
  expect(result.badCode).toBe('invalid-argument');
  // 回显的是落库后的值，模型能原样读回。
  expect(result.afterValues.life).toBe(4.5);
});

/**
 * 反向断言：**共内核不等于共界面**。
 *
 * 流体与粒子共用 `gpu-sim` 内核。判据若按 `kind` 走，双击流体就会进到这一页 ——
 * 左列全是预设 / 发射器形状 / 素材精灵，与它无关；不报错，只是看起来像
 * 「复用粒子的东西忘了删」。判据必须是生成器自报的 `fullscreenEditor`。
 */
test('双击流体片段不进粒子编辑器，只开检查器', async ({ page }) => {
  test.setTimeout(180_000);
  await page.goto('/');
  await page.waitForFunction(() => (window as never as { __artmatic?: unknown }).__artmatic);
  await openDemo(page);
  await buildStage(page, {
    id: 'f-edit',
    source: { type: 'algo', generator: 'fluid', params: { intRes: '480', simRes: '192' } },
    end: 8,
  });

  const clip = page.locator('[data-clip-id="f-edit"]');
  await expect(clip).toBeVisible();
  await clip.dblclick();

  // 三处「进页面了」的迹象一个都不该出现。
  await expect(page.getByTestId('particle-panels')).toHaveCount(0);
  await expect(page.getByTestId('particle-dock')).toHaveCount(0);
  await expect(page.getByTestId('project-tab-particles-0')).toHaveCount(0);
  await expect(page.getByTestId('tl-scroll'), '时间轴不该被隐藏').toBeVisible();

  // 检查器里也没有「编辑粒子」入口（那是 `clipEditorOf === 'particles'` 才有的）。
  await expect(page.getByTestId('edit-particles')).toHaveCount(0);
});
