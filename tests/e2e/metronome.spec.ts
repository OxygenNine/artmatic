import { expect, test, type Page } from '@playwright/test';
import { openDemo } from './_stage';

/**
 * 节拍器（工具条两态按钮）。
 *
 * 声音本身没法直接断言，这里拦 **OscillatorNode.prototype.start**：节拍器用
 * `triangle` 打响拍、`sine` 打手动节奏点（见 `src/audio/metronome.ts`），
 * 于是「播放 1 秒后确实排了两种音」是可验证的。demo 音频走 BufferSource，
 * 不会混进计数。
 */

type W = {
  __artmatic: {
    store: { setBeatMarks: (marks: number[]) => void };
  };
  __clicks?: string[];
};

async function boot(page: Page): Promise<void> {
  await page.goto('/');
  await page.waitForFunction(() => Boolean((window as never as W).__artmatic));
  await openDemo(page);
}

async function spyOscillators(page: Page): Promise<void> {
  await page.evaluate(() => {
    const w = window as never as W;
    w.__clicks = [];
    const proto = OscillatorNode.prototype as unknown as { start: (when?: number) => void };
    const orig = proto.start;
    proto.start = function (this: OscillatorNode, when?: number) {
      w.__clicks!.push(this.type);
      orig.call(this, when);
    };
  });
}

test('节拍器：按 BPM 打 triangle，经过节奏点打 sine，开关状态落盘', async ({ page }) => {
  await boot(page);
  await spyOscillators(page);

  // 一个落在第一秒内的手动节奏点（不是拍的整数倍）。
  await page.evaluate(() => (window as never as W).__artmatic.store.setBeatMarks([0.2]));

  const toggle = page.getByTestId('metronome-toggle');
  await expect(toggle).toHaveAttribute('aria-pressed', 'false');
  await toggle.click();
  await expect(toggle).toHaveAttribute('aria-pressed', 'true');

  const saved = await page.evaluate(() => {
    const raw = localStorage.getItem('artmatic.ui');
    return raw ? (JSON.parse(raw) as { metronome?: boolean }) : null;
  });
  expect(saved?.metronome).toBe(true);

  await page.getByTestId('play-toggle').click();
  await page.waitForTimeout(1100);

  const clicks = await page.evaluate(() => (window as never as W).__clicks ?? []);
  expect(clicks).toContain('triangle'); // BPM 拍
  expect(clicks).toContain('sine'); // 0.2s 的手动节奏点
  expect(clicks.length).toBeGreaterThanOrEqual(3); // 0 / 0.5 / 1.0 三拍上下
});

test('标准模式没有节拍器按钮（那里没有 BPM / offset）', async ({ page }) => {
  await boot(page);
  await expect(page.getByTestId('metronome-toggle')).toBeVisible();
  await page.getByTestId('timeline-mode').click();
  await expect(page.getByTestId('metronome-toggle')).toHaveCount(0);
});
