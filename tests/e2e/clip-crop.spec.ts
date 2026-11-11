import { expect, test, type Page } from '@playwright/test';
import {
  buildImageStage,
  openDemo,
  readClipImageState,
  rgbaAtTopLeft,
  setClipCrop,
} from './_stage';

/**
 * 画面裁剪（`SourceClip.crop`，v10 引入）的 E2E 守卫。
 *
 * 素材是页面内现画的 640×360 PNG，下面垫一条纯蓝 solid 背景轨。判据分两组：
 *
 * 1. **只收窗口、不缩放**（数据侧）。横向三段白 / 灰 / 红，裁掉左半边之后：
 *    左 1/6 应当是**背景蓝**（裁掉就是透明，透出下层）。
 *    ⚠️ 这一条正是与「源窗铺满元素框」那套语义的分水岭：铺满的实现在左 1/6
 *    采样到源 uv≈0.58（灰），只有「只收窗口」才会是蓝。抄错实现时两条都会「画面变了」，
 *    只有颜色类别能分开。
 * 2. **方向**（数据侧）。上下两半红 / 绿，裁掉上 40%：上探针变蓝、下探针仍是绿。
 *    v 轴翻错的表现是两者互换 —— 而「画面变了」这条断言在翻错时同样成立。
 * 3. **UI 接线**（检查器的四个百分比框 + 取消裁剪）。
 *
 * 每条都从**空舞台**起步（`buildImageStage` 关掉 demo 全部轨道），并先量基线再 A/B。
 */

const WHITE = '#ffffff';
const GREY = '#e0e0e0';
const RED = '#ff0000';
const GREEN = '#00ff00';
const BLUE = '#0000ff';

type Rgba = [number, number, number, number];

/** 探针时间点：图片片段是 [0,8)，1s 处稳稳在画面里。 */
const T = 1;

const fmt = (c: Rgba): string => `rgba(${c.join(', ')})`;

async function boot(page: Page): Promise<void> {
  await page.goto('/');
  await page.waitForFunction(() => (window as never as { __artmatic?: unknown }).__artmatic);
  await openDemo(page);
}

/* 颜色类别判据（不钉死 255：GPU 采样会差 1~2，钉死会在换机器时假失败）。 */

function expectBlue(c: Rgba, where: string): void {
  expect(c[2], `${where}：应为背景蓝（B>200），实测 ${fmt(c)}`).toBeGreaterThan(200);
  expect(c[0], `${where}：应为背景蓝（R<60），实测 ${fmt(c)}`).toBeLessThan(60);
}

function expectRed(c: Rgba, where: string): void {
  expect(c[0], `${where}：应为红（R>200），实测 ${fmt(c)}`).toBeGreaterThan(200);
  expect(c[1], `${where}：应为红（G<60），实测 ${fmt(c)}`).toBeLessThan(60);
}

function expectGreen(c: Rgba, where: string): void {
  expect(c[1], `${where}：应为绿（G>200），实测 ${fmt(c)}`).toBeGreaterThan(200);
  expect(c[0], `${where}：应为绿（R<60），实测 ${fmt(c)}`).toBeLessThan(60);
}

test('裁掉左半边：左探针透出下层，右探针原样（只收窗口，不缩放）', async ({ page }) => {
  await boot(page);
  const stage = await buildImageStage(page, {
    pattern: { kind: 'thirds', left: WHITE, middle: GREY, right: RED },
    background: BLUE,
  });

  // 基线：三段各就各位（没有基线的话，「变蓝」在三张黑图上也会通过）
  expectRed(await rgbaAtTopLeft(page, T, 5 / 6, 0.5), '基线右 1/6');

  await setClipCrop(page, stage.imageClipId, { left: 0.5, top: 0, right: 0, bottom: 0 });

  expectBlue(await rgbaAtTopLeft(page, T, 1 / 6, 0.5), '裁掉之后左 1/6');
  expectRed(await rgbaAtTopLeft(page, T, 5 / 6, 0.5), '裁掉之后右 1/6');
});

test('裁掉上 40%：上探针透出下层、下探针不动（方向不能反）', async ({ page }) => {
  await boot(page);
  const stage = await buildImageStage(page, {
    pattern: { kind: 'halves', top: RED, bottom: GREEN },
    background: BLUE,
  });

  expectRed(await rgbaAtTopLeft(page, T, 0.5, 0.2), '基线上半');
  expectGreen(await rgbaAtTopLeft(page, T, 0.5, 0.8), '基线下半');

  await setClipCrop(page, stage.imageClipId, { left: 0, top: 0.4, right: 0, bottom: 0 });

  expectBlue(await rgbaAtTopLeft(page, T, 0.5, 0.2), '裁掉之后上半');
  expectGreen(await rgbaAtTopLeft(page, T, 0.5, 0.8), '裁掉之后下半');
});

test('检查器：四个百分比框写入 crop，取消裁剪把字段删掉', async ({ page }) => {
  await boot(page);
  const stage = await buildImageStage(page, {
    pattern: { kind: 'solid', color: WHITE },
    background: BLUE,
  });

  // 选中片段 → 检查器显示它的属性
  await page.locator(`[data-testid=clip][data-clip-id="${stage.imageClipId}"]`).click();
  await expect(page.getByTestId('crop-section')).toBeVisible();

  await page.getByTestId('clip-crop-left').fill('30');
  await page.getByTestId('clip-crop-left').press('Enter');
  await page.getByTestId('clip-crop-top').fill('10');
  await page.getByTestId('clip-crop-top').press('Enter');

  await expect
    .poll(async () => (await readClipImageState(page, stage.imageClipId)).crop)
    .toEqual({ left: 0.3, top: 0.1, right: 0, bottom: 0 });

  // 同一对边不能重复吃：右边填 80 → 被钳到 1 - 0.3 - MIN_CROP_KEEP(0.02)
  await page.getByTestId('clip-crop-right').fill('80');
  await page.getByTestId('clip-crop-right').press('Enter');
  await expect
    .poll(async () => (await readClipImageState(page, stage.imageClipId)).crop?.right)
    .toBeCloseTo(0.68, 5);

  await page.getByTestId('clip-crop-reset').click();
  await expect
    .poll(async () => (await readClipImageState(page, stage.imageClipId)).crop)
    .toBeNull();
});
