/**
 * recent-menu.spec.ts — 首页「最近的工程」显示什么名字、右键能做什么。
 *
 * 三条断言各自对着一个会**静默**坏掉的地方：
 *  - 名字来自 `project.json` 的 `name` 而不是目录名（否则用户看到一串 `untitled-3`）；
 *  - 「从最近工程列表移除」不碰磁盘（移错了再打开一次就回来了，所以不需要确认）；
 *  - 「删除工程」必须过二次确认，确认后目录被清空（目录本身删不掉 —— FSA 不提供
 *    父句柄，见 `project-actions.ts::deleteProjectFromDisk`）。
 *
 * 用 OPFS 起真工程目录：`showDirectoryPicker` 是系统对话框，自动化驱动不了。
 */

import { expect, test, type Page } from '@playwright/test';

const DIR = 'e2e-recent-menu';
/** 刻意与目录名不同：这条用例要证明显示的是工程名。 */
const NAME = '黑洞视界 v2';

type W = {
  __artmatic: {
    project: {
      useOpfs(name?: string): Promise<string>;
      save(): Promise<boolean>;
      wipe(name?: string): Promise<void>;
      list(path?: string): Promise<{ name: string; kind: string }[]>;
      read(path: string): Promise<string | null>;
    };
  };
};

/** 造一份「名字 ≠ 目录名」的工程，保存后关掉它回到首页。 */
async function saveNamedProject(page: Page): Promise<void> {
  await page.goto('/');
  await page.waitForFunction(() => (window as never as W).__artmatic);

  await page.getByTestId('empty-new').click();
  await page.getByTestId('new-project-name').fill(NAME);
  await page.getByTestId('new-project-create').click();

  await page.evaluate((d) => (window as never as W).__artmatic.project.wipe(d), DIR);
  await page.evaluate((d) => (window as never as W).__artmatic.project.useOpfs(d), DIR);
  await page.evaluate(() => (window as never as W).__artmatic.project.save());

  // 刚保存过所以不脏，关选项卡不会弹确认；关掉就回到首页。
  await page.getByTestId('project-tab-close-0').click();
  // 刷新一次：最近工程是启动时从 localStorage 读的，顺带验它真的落盘了。
  await page.reload();
  await page.waitForFunction(() => (window as never as W).__artmatic);
  await expect(page.getByTestId('empty-state')).toBeVisible();
}

const readProjectJson = (page: Page): Promise<string | null> =>
  page.evaluate(
    (d) => (window as never as W).__artmatic.project.read(`${d}/project.json`),
    DIR,
  );

test('最近工程显示 project.json 的名字，而不是目录名', async ({ page }) => {
  await saveNamedProject(page);

  expect(NAME, '目录名与工程名必须不同，否则这条断言会碰巧通过').not.toBe(DIR);
  await expect(page.getByTestId('recent-tile')).toHaveCount(1);
  await expect(page.locator('.cap .nm').first()).toHaveText(NAME);
});

test('右键菜单三条动作；「移除」只动列表、不碰磁盘', async ({ page }) => {
  await saveNamedProject(page);

  await page.getByTestId('recent-tile').first().click({ button: 'right' });
  await expect(page.getByTestId('recent-menu')).toBeVisible();
  await expect(page.getByTestId('recent-menu-open')).toHaveText('打开文件夹');
  await expect(page.getByTestId('recent-menu-forget')).toHaveText('从最近工程列表移除');
  await expect(page.getByTestId('recent-menu-delete')).toHaveText('删除工程');

  await page.getByTestId('recent-menu-forget').click();
  await expect(page.getByTestId('recent-tile')).toHaveCount(0);
  // 磁盘上的那份一个字节都没动
  expect(await readProjectJson(page)).not.toBeNull();
  expect((await page.evaluate((d) => (window as never as W).__artmatic.project.list(d), DIR)).length)
    .toBeGreaterThan(0);
});

test('工程面板的「最近」页共用同一份菜单，显示的也是工程名', async ({ page }) => {
  await saveNamedProject(page);

  await page.getByTestId('rail-project').click();
  await page.getByTestId('project-nav-recent').click();

  const row = page.getByTestId('project-recent').first();
  await expect(row).toContainText(NAME);

  await row.click({ button: 'right' });
  await expect(page.getByTestId('recent-menu')).toBeVisible();
  await page.getByTestId('recent-menu-forget').click();
  await expect(page.getByTestId('project-recent')).toHaveCount(0);
});

test('「删除工程」要二次确认，确认后目录被清空', async ({ page }) => {
  await saveNamedProject(page);

  // 取消 = 什么都不变
  await page.getByTestId('recent-tile').first().click({ button: 'right' });
  await page.getByTestId('recent-menu-delete').click();
  await expect(page.getByTestId('confirm-delete-project')).toBeVisible();
  await page.getByTestId('confirm-delete-project-cancel').click();
  await expect(page.getByTestId('recent-tile')).toHaveCount(1);
  expect(await readProjectJson(page)).not.toBeNull();

  // 确认 = 清空目录 + 移出列表
  await page.getByTestId('recent-tile').first().click({ button: 'right' });
  await page.getByTestId('recent-menu-delete').click();
  await page.getByTestId('confirm-delete-project-ok').click();

  await expect(page.getByTestId('recent-tile')).toHaveCount(0);
  await expect
    .poll(() => page.evaluate((d) => (window as never as W).__artmatic.project.list(d), DIR))
    .toEqual([]);
  expect(await readProjectJson(page)).toBeNull();
});
