/**
 * modulator.spec.ts — 调制器（P3）：表达式真的改了画面，且 UI 能建 / 能绑。
 *
 * 两条判据，各钉一件事：
 *
 *   1. **数据路径**（逐像素）：把一个纯色小方块绑到 `transform.x` 上，表达式
 *      `t`（绝对秒）。t=0 时它在中线上，t=1 时它按增益右移 —— 两处的像素颜色
 *      正好互换。这一条同时覆盖 schema 的新字段、`resolveParam` 的唯一入口、
 *      以及 compositor 拿到的已经是求值后的数。
 *
 *   2. **界面路径**：从侧栏新建 → 列表里出现条目 → 拖到检查器的参数行上 →
 *      徽标变成 `M`。拖放是唯一的手势，所以必须按真实手势测（`dispatchEvent`
 *      会绕过 `dragover` 与 `dataTransfer`，正好跳过最容易坏的那一段）。
 *
 * 舞台用 `_stage.ts` 的空舞台：demo 的轨道全关，画面里只有方块，于是
 * 「哪块像素是红的」就是全部信息。
 */

import { expect, test, type Page } from '@playwright/test';
import { buildStage, openDemo, rgbaAt } from './_stage';

type Api = {
  __artmatic: {
    store: {
      addModulator: (name?: string) => string | null;
      bindModulator: (clipId: string, key: string, ref: string, gain?: number) => void;
      updateClip: (
        clipId: string,
        label: string,
        fn: (c: {
          transform: { x: number; y: number; sx: number; sy: number; rot: number };
          mods?: Record<string, { ref: string; gain: number; mode: string }[]>;
        }) => void,
      ) => void;
      setModulatorExpr: (id: string, expr: string) => void;
      findClip: (clipId: string) => { clip: { mods?: Record<string, unknown[]> } } | null;
    };
    appState: { selectedClipId: string | null };
    renderFrame: (t: number) => void;
  };
};

/** 小方块：占画面中间那一小块，四角与边缘都是透明的。 */
const BOX = { id: 'mod-src', source: { type: 'solid' as const, color: '#ff0000' }, start: 0, end: 8 };

async function shrinkToBox(page: Page): Promise<void> {
  await page.evaluate(() => {
    const A = (window as never as Api).__artmatic;
    A.store.updateClip('mod-src', 'e2e: 缩小', (c) => {
      c.transform.sx = 0.2;
      c.transform.sy = 0.2;
    });
  });
}

test('调制器：表达式驱动 transform.x（逐像素）', async ({ page }) => {
  await page.goto('/');
  await page.waitForFunction(() => (window as never as { __artmatic?: unknown }).__artmatic);
  await openDemo(page);
  await buildStage(page, BOX);
  await shrinkToBox(page);

  /*
   * 判据只看 R 通道：`readPixels` 的 alpha 在默认帧缓冲上不可靠（见 lab.spec
   * 里那条注释），而「空」在这里就是黑（0,0,0），红就是 (255,0,0) —— R 通道
   * 一个数就分得开这两种情况。
   */
  const center0 = await rgbaAt(page, 0, 0.5, 0.5);
  expect(center0[0]).toBeGreaterThan(200);
  const right0 = await rgbaAt(page, 0, 0.9, 0.5);
  expect(right0[0]).toBeLessThan(40);

  // 建调制器 + 绑到 transform.x：x = 0.5 + 0.25 * t（modulator 的 base 仍是 0.5）
  const modId = await page.evaluate(() => {
    const A = (window as never as Api).__artmatic;
    const id = A.store.addModulator('e2e-move');
    if (!id) throw new Error('addModulator returned null');
    return id;
  });
  await page.evaluate((id) => {
    const A = (window as never as Api).__artmatic;
    A.store.bindModulator('mod-src', 'transform.x', id, 0.25);
  }, modId);
  // 表达式默认是 sin(t*2*pi)；换成线性的 t，判据才好手算。
  await page.evaluate((id) => {
    const A = (window as never as Api).__artmatic;
    A.store.setModulatorExpr(id, 't');
  }, modId);

  // t=1：x = 0.5 + 0.25 = 0.75，方块（宽 20%）盖住 0.65..0.85 ⇒ 中线空出来。
  const center1 = await rgbaAt(page, 1, 0.5, 0.5);
  expect(center1[0]).toBeLessThan(40);
  const moved1 = await rgbaAt(page, 1, 0.75, 0.5);
  expect(moved1[0]).toBeGreaterThan(200);
});

test('调制器：新建 + 拖到参数行上（真实拖放手势）', async ({ page }) => {
  await page.goto('/');
  await page.waitForFunction(() => (window as never as { __artmatic?: unknown }).__artmatic);
  await openDemo(page);
  await buildStage(page, BOX);

  // 选中舞台片段，检查器才会有可绑的参数行。
  await page.evaluate(() => {
    const A = (window as never as Api).__artmatic;
    A.appState.selectedClipId = 'mod-src';
  });

  await page.getByTestId('rail-modulators').click();
  await expect(page.getByTestId('mod-drawer')).toBeVisible();
  await expect(page.getByTestId('mod-list')).toBeVisible();

  // 新建：会直接打开编辑器（新调制器没有表达式就什么都看不见，先让人看一眼）。
  await page.getByTestId('mod-new').click();
  const modal = page.getByTestId('modal-modulator');
  await expect(modal).toBeVisible();
  // 积木树画出来了（默认表达式 sin(t * 2 * pi) 全在词汇表内）。
  await expect(page.getByTestId('mod-blocks')).toBeVisible();
  await expect(page.getByTestId('mod-block').first()).toBeVisible();

  /*
   * 换积木：根块的 ⋯ → 「时间」组 → 「时间 t」。
   * 这一步是积木视图的**核心动作**（AST 被整块替换后文本要跟着变），
   * 所以断言落在根块的种类标签上，而不是「点了没报错」。
   */
  await page.getByTestId('mod-block-menu').first().click();
  const palette = page.getByTestId('mod-block-palette');
  await expect(palette).toBeVisible();
  await palette.getByTestId('mod-pal-group-time').click();
  // 二级菜单是**兄弟节点**（每层一个 `div.menu`），不能在一级菜单里找它。
  await page.getByTestId('mod-pal-time').click();
  await expect(page.getByTestId('mod-block-kind').first()).toHaveText('时间 t');

  await modal.getByTestId('modal-modulator-close').click();
  await expect(modal).toHaveCount(0);

  const row = page.getByTestId('param-row').filter({ hasText: '不透明度' }).first();
  await expect(row).toBeVisible();
  await page.getByTestId('mod-item').first().dragTo(row);

  // 绑定成功 ⇒ 该行出现 M 徽标，且 store 里真的多了一个槽。
  const badge = row.getByTestId('mod-badge');
  await expect(badge).toHaveText('M');
  const slots = await page.evaluate(() => {
    const A = (window as never as Api).__artmatic;
    return A.store.findClip('mod-src')?.clip.mods?.['opacity']?.length ?? 0;
  });
  expect(slots).toBe(1);

  /*
   * 落点之后槽面板**自动打开**（刚绑上就要能调增益，否则用户得先猜徽标能点）。
   * 所以这里先断言它开着，再点徽标确认能收起 —— 两个方向都走一遍。
   */
  await expect(page.getByTestId('mod-slots')).toBeVisible();
  await badge.click();
  await expect(page.getByTestId('mod-slots')).toHaveCount(0);
});
