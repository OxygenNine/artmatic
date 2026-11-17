import { expect, test, type Page } from '@playwright/test';
import { openDemo } from './_stage';

/**
 * 画面批注（Issues）。
 *
 * 这一页同时钉住四条**曾经坏过**的东西：
 *  1. 面板条目被全局 `.sel` 类命中（`flex: 1` + 固定高度）而撑满整列；
 *  2. 时间轴那条线被同一个 `.sel` 压成一条轨道高、还带着下拉框的边框；
 *  3. 标记没有时间段：拖不动、时长不可改、预览里永远显示；
 *  4. 取色卡写回主题色引用（`@accent1`）被写入端当坏颜色丢掉 —— 颜色「点不动」。
 */

interface Api {
  store: {
    project: {
      issues: { id: string; start: number; end: number; color: string; note: string }[];
      duration: number;
      fps: number;
    };
    updateIssue: (id: string, patch: Record<string, unknown>) => boolean;
  };
  appState: { playT: number; selectedIssueId: string | null };
}

async function boot(page: Page): Promise<void> {
  await page.goto('/');
  await page.waitForFunction(() => Boolean((window as never as { __artmatic?: unknown }).__artmatic));
  await openDemo(page);
}

const issuesOf = (page: Page) =>
  page.evaluate(() =>
    (window as never as { __artmatic: Api }).__artmatic.store.project.issues.map((i) => ({ ...i })),
  );

test('右键建标记：面板不撑高、颜色可改、时间轴可拖、预览只在时间段内显示', async ({ page }) => {
  await boot(page);

  /* ---------------------------------------------------------- 建一条标记 */
  const gl = page.locator('#gl');
  const gb = await gl.boundingBox();
  expect(gb, '预览画布必须已经在屏上').not.toBeNull();
  await page.mouse.click(gb!.x + gb!.width / 2, gb!.y + gb!.height / 2, { button: 'right' });
  await page.getByTestId('ctx-issue-add').click();

  // 建完立刻弹注释框（焦点在输入框里，直接打字）。
  await page.getByTestId('issue-note-input').fill('这个位置渲染有问题');
  await page.getByTestId('issue-note-done').click();
  await expect(page.getByTestId('pv-issue')).toHaveCount(1);
  expect((await issuesOf(page))[0]!.note).toBe('这个位置渲染有问题');

  /* -------------------------------------------------------------- 面板 */
  await page.getByTestId('rail-issues').click();
  await expect(page.getByTestId('issues-drawer')).toBeVisible();
  await expect(page.getByTestId('issue-item')).toHaveCount(1);

  // 回归：条目曾经被全局 `.sel` 拉成 flex:1，单条就撑满整列。
  const itemBox = await page.getByTestId('issue-item').boundingBox();
  expect(itemBox!.height, '面板条目不该撑满容器').toBeLessThan(180);

  /* -------------------------------------------------------------- 颜色 */
  await page.getByTestId('issue-item-color').click();
  await page.getByTestId('issue-item-color-palette-theme-@accent1').click();
  const afterColor = (await issuesOf(page))[0]!;
  // 「Office」主题的 accent1。关键是**不是 `@accent1`**：主题引用在批注里是坏值。
  expect(afterColor.color, '主题色引用必须解析成裸 hex 才能落库').toBe('#156082');

  /* -------------------------------------------------------- 时间轴拖位置 */
  const before = (await issuesOf(page))[0]!;
  const line = page.getByTestId('tl-issue-move');
  const lb = await line.boundingBox();
  expect(lb, '时间轴上必须有可拖的起点线').not.toBeNull();
  // 回归：线曾经被 `.sel` 压成一条轨道高。整块行区远高于一条轨。
  const issueBox = await page.getByTestId('tl-issue').boundingBox();
  expect(issueBox!.height, '批注线应当横跨整个轨道区').toBeGreaterThan(120);

  await page.mouse.move(lb!.x + lb!.width / 2, lb!.y + 60);
  await page.mouse.down();
  await page.mouse.move(lb!.x + lb!.width / 2 + 72, lb!.y + 60, { steps: 6 });
  await page.mouse.up();
  const moved = (await issuesOf(page))[0]!;
  expect(moved.start, '拖动起点线应当改变开始时间').not.toBeCloseTo(before.start, 4);
  // 平移保持时长（默认一帧），不该被顺手拉长。
  expect(moved.end - moved.start).toBeCloseTo(before.end - before.start, 4);

  /* ---------------------------------------------------------- 改时长 */
  const frame = 1 / (await page.evaluate(() => (window as never as { __artmatic: Api }).__artmatic.store.project.fps));
  const endGrip = page.getByTestId('tl-issue-grip-end');
  const eb = await endGrip.boundingBox();
  expect(eb, '选中 / 悬停时结尾手柄必须出现').not.toBeNull();
  await page.mouse.move(eb!.x + eb!.width / 2, eb!.y + 4);
  await page.mouse.down();
  await page.mouse.move(eb!.x + eb!.width / 2 + 90, eb!.y + 4, { steps: 6 });
  await page.mouse.up();
  const longer = (await issuesOf(page))[0]!;
  expect(longer.end - longer.start, '拖结尾应当拉长时间段').toBeGreaterThan(frame * 2);

  /* -------------------------------------------------- 预览只显示在时间段内 */
  const visibleAt = await page.evaluate(() => {
    const A = (window as never as { __artmatic: Api }).__artmatic;
    A.appState.playT = A.store.project.issues[0]!.start;
    return A.store.project.issues[0]!.start;
  });
  await expect(page.getByTestId('pv-issue'), `标记应在起点 ${visibleAt}s 显示`).toHaveCount(1);

  await page.evaluate(() => {
    const A = (window as never as { __artmatic: Api }).__artmatic;
    A.appState.playT = A.store.project.issues[0]!.end + 1;
  });
  await expect(page.getByTestId('pv-issue'), '离开时间段后预览里不该还有标记').toHaveCount(0);
});
