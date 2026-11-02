import { expect, test, type Page } from '@playwright/test';
import { buildStage, openDemo, rgbaAt, settle } from './_stage';

/**
 * 调色面板（P1）的 E2E。
 *
 * 判据全部落在**像素**上，而不是「面板出现了」：
 *  - 拖色轮必须让画面变色（不是只有数字动了）；
 *  - 前 / 后对比必须回到基线（旁路真的生效，而不是按钮亮了）；
 *  - 曲线拖上去必须变亮；
 *  - 示波器只在面板可见时才有探针数据（`readPixels` 是同步 stall，不能白花）。
 */

const GREY = '#808080';

async function openEditor(page: Page): Promise<void> {
  // 双击 = 打开片段自己的编辑器（与排版编辑器同一手势）。
  await page.locator('[data-clip-id="fx"]').dblclick();
  await expect(page.getByTestId('grade-editor')).toBeVisible();
  /*
   * 打开面板会触发一次整体重排，排版光栅化（异步）可能在这一刻才落地 ——
   * 只 `settle` 会读到中间态（实测差 20 多个色阶）。所以先给异步的那一套
   * 一点时间，再等画面稳定。
   */
  await page.waitForTimeout(400);
}

async function stats(page: Page): Promise<{ floatSupported: boolean; allocFloat: boolean }> {
  return page.evaluate(
    () =>
      (window as never as { __artmatic: { gradeStats: () => { floatSupported: boolean; allocFloat: boolean } } })
        .__artmatic.gradeStats(),
  );
}

test('双击调色片段打开面板；拖色轮改画面，前 / 后对比回到基线', async ({ page }) => {
  await page.goto('/');
  await page.waitForFunction(() => (window as never as { __artmatic?: unknown }).__artmatic);
  await openDemo(page);
  await buildStage(
    page,
    { id: 'src', source: { type: 'solid', color: GREY } },
    { id: 'fx', defId: 'grade-basic', values: {} },
  );
  await settle(page, 1);
  await openEditor(page);
  await settle(page, 1);

  // 有调色 ⇒ 这一帧的中间缓冲应当是 16F（P0 的判定在面板打开后也成立）。
  const s = await stats(page);
  test.skip(!s.floatSupported, '这台机器没有 EXT_color_buffer_float');
  expect(s.allocFloat).toBe(true);

  /*
   * 基线取「同一场景、调色旁路」的那一帧，而不是打开面板之前的：
   * 打开面板要等排版/字体那一套稳定下来，早取会读到中间态（实测差 20+ 个色阶）。
   */
  await page.getByTestId('grade-ab').click();
  await settle(page, 1);
  const base = await rgbaAt(page, 1, 0.5, 0.5);
  await page.getByTestId('grade-ab').click();
  await settle(page, 1);
  // 恒等参数的 grade-basic 必须与原片逐通道一致。
  const identity = await rgbaAt(page, 1, 0.5, 0.5);
  for (let i = 0; i < 3; i += 1) {
    expect(Math.abs(identity[i]! - base[i]!), `恒等调色不该改画面：${identity.join(',')} vs ${base.join(',')}`).toBeLessThanOrEqual(2);
  }

  // 把暗部轮盘往红推：拖动落在盘内，半径 > 0。
  const ring = page.getByTestId('grade-wheel-ring-lift');
  const box = (await ring.boundingBox())!;
  await page.mouse.move(box.x + box.width * 0.78, box.y + box.height * 0.5);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * 0.8, box.y + box.height * 0.52, { steps: 3 });
  await page.mouse.up();
  await settle(page, 1);

  const graded = await rgbaAt(page, 1, 0.5, 0.5);
  expect(graded[0]!, `暗部往红推之后 R 应当上升：${base.join(',')} → ${graded.join(',')}`).toBeGreaterThan(
    base[0]! + 8,
  );


  // 前 / 后：旁路整条链，画面必须回到基线（±2 是 8 位落盘的余量）。
  await page.getByTestId('grade-ab').click();
  await settle(page, 1);
  const bypassed = await rgbaAt(page, 1, 0.5, 0.5);
  for (let i = 0; i < 3; i += 1) {
    expect(
      Math.abs(bypassed[i]! - base[i]!),
      `第 ${i} 通道：对比原片 ${bypassed.join(',')} vs 基线 ${base.join(',')}`,
    ).toBeLessThanOrEqual(2);
  }

  // 切回「看调色」，画面回到调过的样子（不是卡在原片）。
  await page.getByTestId('grade-ab').click();
  await settle(page, 1);
  const back = await rgbaAt(page, 1, 0.5, 0.5);
  expect(Math.abs(back[0]! - graded[0]!)).toBeLessThanOrEqual(2);
});

test('曲线：加一个模块、拖控制点上去，画面变亮', async ({ page }) => {
  await page.goto('/');
  await page.waitForFunction(() => (window as never as { __artmatic?: unknown }).__artmatic);
  await openDemo(page);
  await buildStage(
    page,
    { id: 'src', source: { type: 'solid', color: GREY } },
    { id: 'fx', defId: 'grade-basic', values: {} },
  );
  await settle(page, 1);

  await openEditor(page);
  // 基线同样取「面板已打开、曲线还没加」的那一帧。
  const base = await rgbaAt(page, 1, 0.5, 0.5);
  await page.getByTestId('grade-add-curves').click();
  await expect(page.getByTestId('grade-curve-canvas')).toBeVisible();

  // 双击空白处加一个中点，然后把它往上拖 —— 中灰提亮。
  const cv = page.getByTestId('grade-curve-canvas');
  const b = (await cv.boundingBox())!;
  await page.mouse.dblclick(b.x + b.width * 0.5, b.y + b.height * 0.5);
  await expect(page.getByTestId('grade-curve-point')).toHaveCount(3);

  await page.mouse.move(b.x + b.width * 0.5, b.y + b.height * 0.5);
  await page.mouse.down();
  await page.mouse.move(b.x + b.width * 0.5, b.y + b.height * 0.28, { steps: 4 });
  await page.mouse.up();
  await settle(page, 1);

  const brighter = await rgbaAt(page, 1, 0.5, 0.5);
  expect(
    brighter[0]!,
    `曲线往上拉之后应当更亮：${base.join(',')} → ${brighter.join(',')}`,
  ).toBeGreaterThan(base[0]! + 10);
});

test('示波器：面板在时才有探针数据，关掉就停', async ({ page }) => {
  await page.goto('/');
  await page.waitForFunction(() => (window as never as { __artmatic?: unknown }).__artmatic);
  await openDemo(page);
  await buildStage(
    page,
    { id: 'src', source: { type: 'solid', color: GREY } },
    { id: 'fx', defId: 'grade-basic', values: {} },
  );

  const frameNow = () =>
    page.evaluate(
      () => (window as never as { __artmatic: { renderer: { scopeFrame: () => unknown } } }).__artmatic.renderer.scopeFrame() !== null,
    );

  await settle(page, 1);
  expect(await frameNow(), '面板没开时不该有探针数据').toBe(false);

  await openEditor(page);
  await settle(page, 1);
  // 探针每 6 帧采一次，`settle` 已经渲染了足够多帧。
  expect(await frameNow(), '面板打开后应当采到一帧').toBe(true);

  await page.getByTestId('grade-editor').press('Escape');
  await expect(page.getByTestId('grade-editor')).toHaveCount(0);
  expect(await frameNow(), '关掉面板必须停掉探针（readPixels 是同步 stall）').toBe(false);
});

test('查找表：导入 .cube 后画面真的按表变，名字也显示出来', async ({ page }) => {
  await page.goto('/');
  await page.waitForFunction(() => (window as never as { __artmatic?: unknown }).__artmatic);
  await openDemo(page);
  await buildStage(
    page,
    { id: 'src', source: { type: 'solid', color: GREY } },
    { id: 'fx', defId: 'grade-basic', values: {} },
  );
  await settle(page, 1);
  await openEditor(page);
  const base = await rgbaAt(page, 1, 0.5, 0.5);

  /*
   * 2×2×2 的**反相** LUT：每个节点 = 1 - 输入。中灰 128 → 约 127（仍在中灰附近），
   * 所以判据取「与原片不同」而不是「变亮/变暗」—— 反相在中灰上最不明显，
   * 这正好说明判据不能依靠方向。
   */
  const inv = `LUT_3D_SIZE 2
${[0, 1]
  .map((b) => [0, 1].map((g) => [0, 1].map((r) => `${1 - r} ${1 - g} ${1 - b}`).join('\n')).join('\n'))
  .join('\n')}
`;
  await page.getByTestId('grade-lut-input').setInputFiles({
    name: 'invert.cube',
    mimeType: 'text/plain',
    buffer: Buffer.from(inv, 'utf8'),
  });
  await expect(page.getByTestId('grade-lut-name')).toHaveText('invert');

  // 纹理是异步载入的（读盘 / 解析），给它一拍再取像素。
  await page.waitForTimeout(300);
  await settle(page, 1);
  const after = await rgbaAt(page, 1, 0.5, 0.5);
  expect(after.join(','), `反相 LUT 应当改变画面：${base.join(',')} → ${after.join(',')}`).not.toBe(base.join(','));
});
