import { expect, test, type Page } from '@playwright/test';
import { openDemo } from './_stage';
import { zhCN } from '../../src/i18n/locales/zh-CN';

/**
 * 时间轴双形态。
 *
 * 判据刻意**不读像素**：标尺是 canvas，读文字只能靠 OCR；而这一波真正会坏的地方
 * 是「切了模式但工具条 / 吸附没跟上」。所以断言落在三处可读状态上：
 *   1. 两态按钮的图标与文字（当前形态）；
 *   2. 工具条显示哪一组参数（节奏：BPM+offset+拍/小节；标准：帧率）；
 *   3. 吸附档位表是否按形态收窄、以及**每个形态各记一份**。
 * 标尺文案的格式本身由 `tests/unit/ruler-label.test.ts` 钉（纯函数）。
 */

async function boot(page: Page): Promise<void> {
  await page.goto('/');
  await page.waitForFunction(() => Boolean((window as never as { __artmatic?: unknown }).__artmatic));
  await openDemo(page);
}

const modeBtn = (page: Page) => page.getByTestId('timeline-mode');

async function toggleMode(page: Page): Promise<void> {
  await modeBtn(page).click();
}

test('默认节奏模式：按钮就是「节奏」，工具条显示 BPM/offset/拍每小节', async ({ page }) => {
  await boot(page);
  await expect(modeBtn(page)).toHaveAttribute('data-mode', 'beat');
  await expect(modeBtn(page)).toContainText(zhCN['tp.modeBeat']);
  await expect(page.getByTestId('bpm-input')).toBeVisible();
  await expect(page.getByTestId('offset-input')).toBeVisible();
  await expect(page.getByTestId('beats-per-bar')).toBeVisible();
  await expect(page.getByTestId('fps-input')).toHaveCount(0);
  await expect(page.getByTestId('snap-mode')).toContainText(zhCN['tl.snapBar']);
});

test('点一下切到标准：BPM 组换成帧率，吸附只剩「磁吸 / 自由 / 帧」', async ({ page }) => {
  await boot(page);
  await toggleMode(page);

  await expect(modeBtn(page)).toHaveAttribute('data-mode', 'standard');
  await expect(modeBtn(page)).toContainText(zhCN['tp.modeStandard']);
  await expect(page.getByTestId('fps-input')).toBeVisible();
  await expect(page.getByTestId('bpm-input')).toHaveCount(0);
  await expect(page.getByTestId('beats-per-bar')).toHaveCount(0);
  await expect(page.getByTestId('snap-mode')).toContainText(zhCN['tl.snapFree']);

  // 下拉里不该再有拍单位（那是节奏模式的刻度，标准模式的标尺上没有拍）；
  // 磁吸两个形态都有 —— 它吸的是元素，不是刻度。
  await page.getByTestId('snap-mode').click();
  await expect(page.getByTestId('snap-mode-opt-frame')).toHaveCount(1);
  await expect(page.getByTestId('snap-mode-opt-magnet')).toHaveCount(1);
  await expect(page.getByTestId('snap-mode-opt-beat')).toHaveCount(0);
  await expect(page.getByTestId('snap-mode-opt-bar')).toHaveCount(0);
  await expect(page.getByTestId('snap-mode-opt-half')).toHaveCount(0);
  await page.keyboard.press('Escape');
});

test('吸附档位按形态各记一份：切回来是上次在这个形态下用的那一档', async ({ page }) => {
  await boot(page);

  // 节奏模式下改成「拍」
  await page.getByTestId('snap-mode').click();
  await page.getByTestId('snap-mode-opt-beat').click();
  await expect(page.getByTestId('snap-mode')).toContainText(zhCN['tl.snapBeat']);

  // 切到标准：它有自己的初值（自由），不继承「拍」
  await toggleMode(page);
  await expect(page.getByTestId('snap-mode')).toContainText(zhCN['tl.snapFree']);

  // 标准模式下选「帧」
  await page.getByTestId('snap-mode').click();
  await page.getByTestId('snap-mode-opt-frame').click();
  await expect(page.getByTestId('snap-mode')).toContainText(zhCN['tl.snapFrame']);

  // 切回节奏：还是「拍」，不是被标准模式覆盖掉的自由
  await toggleMode(page);
  await expect(page.getByTestId('snap-mode')).toContainText(zhCN['tl.snapBeat']);

  // 再切回标准：还是「帧」
  await toggleMode(page);
  await expect(page.getByTestId('snap-mode')).toContainText(zhCN['tl.snapFrame']);
});

test('形态与吸附都进 UI 偏好：刷新后原样恢复', async ({ page }) => {
  await boot(page);
  await toggleMode(page); // → 标准
  await page.getByTestId('snap-mode').click();
  await page.getByTestId('snap-mode-opt-frame').click();

  await page.reload();
  await page.waitForFunction(() => Boolean((window as never as { __artmatic?: unknown }).__artmatic));
  await openDemo(page);
  await expect(modeBtn(page)).toHaveAttribute('data-mode', 'standard');
  await expect(page.getByTestId('snap-mode')).toContainText(zhCN['tl.snapFrame']);

  await toggleMode(page); // → 节奏
  await expect(page.getByTestId('snap-mode')).toContainText(zhCN['tl.snapBar']);
});

test('标准模式下帧率输入写回工程（帧率也是帧吸附与时间码小数位的来源）', async ({ page }) => {
  await boot(page);
  await toggleMode(page);
  const fps = page.getByTestId('fps-input');
  await fps.fill('25');
  await fps.press('Enter');
  const value = await page.evaluate(
    () =>
      (window as never as { __artmatic: { store: { project: { fps: number } } } }).__artmatic.store
        .project.fps,
  );
  expect(value).toBe(25);
});


