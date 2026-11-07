import { expect, test, type Page } from '@playwright/test';
import { openDemo } from './_stage';

/**
 * 打点计时（v21）。
 *
 * 录制依赖真实音频时钟与输出延迟，断言「第几个点落在几秒」会被环境噪声打成
 * 偶发失败（见 `tests/e2e/AGENTS.md` 对时间的纪律）。录制语义的纯逻辑在
 * `tests/unit/beat-marks.test.ts` 里钉；这里守的是**界面读写同一份字段**：
 * 右键新增 / 拖动 / 框选 / 删除 → `Project.beatMarks`，以及缩放真的改了内容宽度。
 *
 * 非录制模式左键**不再直接加点**（用户绝大多数时候在录制，手动新增是查漏补缺）：
 * 右键菜单才是新增入口，左键空白拖动是框选。
 */

type W = {
  __artmatic: {
    store: {
      project: { duration: number; beatMarks: number[] };
    };
    appState: { playing: boolean; playT: number };
  };
};

const marks = (page: Page) =>
  page.evaluate(() => [...(window as never as W).__artmatic.store.project.beatMarks]);

/** 右键空白 → 「在此新增节奏点」。 */
async function addAt(page: Page, x: number, y: number): Promise<void> {
  await page.mouse.click(x, y, { button: 'right' });
  await expect(page.getByTestId('beat-tap-menu')).toBeVisible();
  await page.getByTestId('beat-tap-menu-add').click();
  await expect(page.getByTestId('beat-tap-menu')).toBeHidden();
}

async function bootBeatTap(page: Page): Promise<void> {
  await page.goto('/');
  await page.waitForFunction(() => Boolean((window as never as W).__artmatic));
  await openDemo(page);
  await page.getByTestId('beat-tap-open').click();
  await expect(page.getByTestId('beat-tap-modal')).toBeVisible();
}

test('手动编辑：右键新增 / 拖动 / 删除，关闭后段落带出现刻度', async ({ page }) => {
  await bootBeatTap(page);
  const box = (await page.getByTestId('beat-tap-lane').boundingBox())!;
  const y = box.y + box.height / 2;

  await addAt(page, box.x + box.width * 0.25, y);
  await expect(page.getByTestId('beat-tap-mark')).toHaveCount(1);
  const [t0] = await marks(page);
  expect(t0).toBeGreaterThan(0.5);

  // 拖圆点 = 改位置（8px 抓手，从中心按下）。
  const mark = page.getByTestId('beat-tap-mark').first();
  const mb = (await mark.boundingBox())!;
  await page.mouse.move(mb.x + mb.width / 2, mb.y + 2);
  await page.mouse.down();
  await page.mouse.move(mb.x + mb.width / 2 + 60, mb.y + 2, { steps: 6 });
  await page.mouse.up();
  const [t1] = await marks(page);
  expect(t1).toBeGreaterThan(t0);

  // 选中态 + Delete = 删除。
  await page.keyboard.press('Delete');
  await expect(page.getByTestId('beat-tap-mark')).toHaveCount(0);
  expect(await marks(page)).toEqual([]);

  // 再新增一个，关闭弹窗后主时间轴必须看得见（数据变了 ≠ 用户看得见）。
  await addAt(page, box.x + box.width * 0.4, y);
  await page.getByTestId('beat-tap-done').click();
  await expect(page.getByTestId('beat-tap-modal')).toBeHidden();
  await expect(page.getByTestId('tl-beat-mark')).toHaveCount(1);
  expect((await marks(page)).length).toBe(1);
});

test('缩放与框选：内容宽度跟着缩放，框选后 Delete 一次删掉一组', async ({ page }) => {
  await bootBeatTap(page);
  const box = (await page.getByTestId('beat-tap-lane').boundingBox())!;
  const y = box.y + box.height / 2;

  await addAt(page, box.x + box.width * 0.2, y);
  await addAt(page, box.x + box.width * 0.6, y);
  await expect(page.getByTestId('beat-tap-mark')).toHaveCount(2);

  const scroll = page.getByTestId('beat-tap-scroll');
  const before = await scroll.evaluate((el) => el.scrollWidth);
  await page.getByTestId('beat-tap-zoom-in').click();
  const after = await scroll.evaluate((el) => el.scrollWidth);
  expect(after).toBeGreaterThan(before);
  await page.getByTestId('beat-tap-fit').click();
  await page.waitForTimeout(50);
  const fit = await scroll.evaluate((el) => el.scrollWidth);
  expect(fit).toBeLessThanOrEqual((await scroll.boundingBox())!.width + 2);

  // 左键从空白拖到 70%：两个点都落在框里。
  await page.mouse.move(box.x + box.width * 0.1, y);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * 0.7, y, { steps: 8 });
  await page.mouse.up();
  await expect(page.getByTestId('beat-tap-selected')).toContainText('2');

  await page.keyboard.press('Delete');
  await expect(page.getByTestId('beat-tap-mark')).toHaveCount(0);
  expect(await marks(page)).toEqual([]);
});

test('录制：空格打点不打断播放，停止后整轮落库', async ({ page }) => {
  await bootBeatTap(page);
  await page.getByTestId('beat-tap-record').click();
  // 让音频时钟真的走起来（不是等某个固定秒数落点：只要求两个点有先后）。
  await page.waitForTimeout(400);
  await page.keyboard.press('Space');
  await page.waitForTimeout(300);
  await page.keyboard.press('Space');

  expect(
    await page.evaluate(() => (window as never as W).__artmatic.appState.playing),
  ).toBe(true);
  await expect(page.getByTestId('beat-tap-mark')).toHaveCount(2);

  await page.getByTestId('beat-tap-record').click();
  const ms = await marks(page);
  expect(ms.length).toBe(2);
  expect(ms[1]).toBeGreaterThan(ms[0]);

  // 一轮录制 = 一笔撤销（不是每个点一笔）。先关弹窗 —— modal 期间全局快捷键让路。
  await page.getByTestId('beat-tap-done').click();
  await page.keyboard.press('Control+z');
  expect(await marks(page)).toEqual([]);
});
