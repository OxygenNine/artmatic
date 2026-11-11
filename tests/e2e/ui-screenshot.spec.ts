/**
 * ui-screenshot.spec.ts — `ui_screenshot` 的端到端验证。
 *
 * 只能在这里测：snapDOM 需要真实 DOM / CSS / 字体，而「截出来的不是白板」
 * 还要解码 PNG 逐像素看。伪环境里这两条都是恒真。
 */

import { expect, test, type Page } from '@playwright/test';
import { openDemo } from './_stage';

type Shot =
  | { ok: true; sig: number[]; bytes: number; w: number; h: number; warnings: string[]; lumRange: number }
  | { ok: false; error: { code: string; message: string } };

type RawShot =
  | { ok: true; data: { bytes: Uint8Array; w: number; h: number; warnings: string[] } }
  | { ok: false; error: { code: string; message: string } };

type PageApi = {
  __artmatic: {
    control: { screenshotUi(opt?: { scale?: number }): Promise<RawShot> };
  };
};

/** 页面内解码 PNG，量一下亮度范围（全白 / 全黑的图会得到 0）。 */
async function shot(page: Page, scale?: number): Promise<Shot> {
  return page.evaluate(async (s) => {
    const r = await (window as never as PageApi).__artmatic.control.screenshotUi(
      s === undefined ? {} : { scale: s },
    );
    if (!r.ok) return r;
    const u8: Uint8Array = r.data.bytes;
    const bitmap = await createImageBitmap(new Blob([u8.slice().buffer], { type: 'image/png' }));
    const c = document.createElement('canvas');
    c.width = bitmap.width;
    c.height = bitmap.height;
    const ctx = c.getContext('2d')!;
    ctx.drawImage(bitmap, 0, 0);
    const px = ctx.getImageData(0, 0, c.width, c.height).data;
    let min = 255;
    let max = 0;
    // 逐 4 像素采样：只关心「有没有内容」，不需要精确统计。
    for (let i = 0; i < px.length; i += 16) {
      const l = 0.2126 * px[i]! + 0.7152 * px[i + 1]! + 0.0722 * px[i + 2]!;
      if (l < min) min = l;
      if (l > max) max = l;
    }
    return {
      ok: true as const,
      sig: Array.from(u8.slice(0, 8)),
      bytes: u8.length,
      w: r.data.w,
      h: r.data.h,
      warnings: r.data.warnings,
      lumRange: Math.round(max - min),
    };
  }, scale);
}

test.beforeEach(async ({ page }) => {
  await page.goto('/');
  await page.waitForFunction(() => (window as never as PageApi).__artmatic);
  await openDemo(page);
});

test('默认截整界面：PNG 签名、尺寸对得上、且不是一张白板', async ({ page }) => {
  const viewport = page.viewportSize()!;
  const r = await shot(page);
  expect(r.ok, r.ok ? '' : r.error.message).toBe(true);
  if (!r.ok) return;

  // PNG 魔数。字节数为 0 或不是 PNG 说明 snapDOM 走了空路径。
  expect(r.sig).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  expect(r.bytes).toBeGreaterThan(5_000);

  // 长边上限 1600（默认视口比它小，所以这里应当等于视口）。
  const long = Math.max(viewport.width, viewport.height);
  const expectScale = Math.min(1, 1600 / long);
  expect(Math.abs(r.w - Math.round(viewport.width * expectScale))).toBeLessThanOrEqual(2);
  expect(Math.abs(r.h - Math.round(viewport.height * expectScale))).toBeLessThanOrEqual(2);

  // 界面有深色底 + 亮色文字/画面，亮度跨度不可能接近 0。
  expect(r.lumRange, '截图是一张纯色图，说明 DOM 没被真正捕获').toBeGreaterThan(30);
});

test('scale 只会往下缩，不会把长边撑过 1600', async ({ page }) => {
  const small = await shot(page, 0.5);
  expect(small.ok).toBe(true);
  if (!small.ok) return;
  const viewport = page.viewportSize()!;
  expect(Math.abs(small.w - Math.round(viewport.width * 0.5))).toBeLessThanOrEqual(2);
  expect(Math.max(small.w, small.h)).toBeLessThanOrEqual(1600);

  // 超范围的倍率被夹住，而不是抛错。
  const huge = await shot(page, 8);
  expect(huge.ok).toBe(true);
  if (huge.ok) expect(Math.max(huge.w, huge.h)).toBeLessThanOrEqual(1600);
});
