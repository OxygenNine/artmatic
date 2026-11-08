/**
 * autosave.spec.ts — 自动保存与崩溃恢复。
 *
 * 两条路都要走真实路径：
 *  - **有目录**：写正式 `project.json`，但**不轮转 `.bak`**，也不把工程标记成已保存；
 *  - **没有目录**：落 OPFS 草稿，刷新之后能从横幅恢复出一份「未保存」的工程。
 *
 * 为什么不直接用真时钟等 2 s：`project.autosaveNow()` 走的是同一个调度器
 * （`flushNow` = 跳过防抖），判据仍然是「脏不脏、内容变没变」。
 * 用真时间只会让用例在慢机器上偶发。
 */

import { expect, test, type Page } from '@playwright/test';
import { openDemo } from './_stage';

type W = {
  __artmatic: {
    project: {
      useOpfs(name?: string): Promise<string>;
      save(): Promise<boolean>;
      read(path: string): Promise<string | null>;
      write(path: string, bytes: number[]): Promise<void>;
      wipe(name?: string): Promise<void>;
      autosaveNow(): Promise<void>;
      autosaveState(): { status: string; detail: string | null; failure: string | null };
      drafts(): Promise<{ key: string; name: string; savedAt: number }[]>;
      wipeDrafts(): Promise<void>;
      draftKey(): string | null;
    };
    store: {
      project: { name: string };
      commit(label: string, fn: (p: { name: string }) => void): boolean;
      /** 只 bump version、不改内容（视频解码出一帧时的形态）。 */
      invalidate(): void;
    };
    appState: { projectDirty: boolean; autosaveFailure: string | null };
  };
};

const DIR = 'e2e-autosave';

async function boot(page: Page): Promise<void> {
  await page.goto('/');
  await page.waitForFunction(() => (window as never as W).__artmatic);
  // 上一轮残留的草稿会让「恢复横幅出现了」这类断言在错误的前提下通过。
  await page.evaluate(() => (window as never as W).__artmatic.project.wipeDrafts());
  await openDemo(page);
}

function rename(page: Page, name: string): Promise<void> {
  return page.evaluate((n) => {
    (window as never as W).__artmatic.store.commit('e2e: 改名', (p) => {
      p.name = n;
    });
  }, name);
}

test('没有目录：自动保存落成本地草稿，刷新后能恢复（且仍是未保存状态）', async ({ page }) => {
  await boot(page);

  await rename(page, '崩溃前的名字');
  await page.evaluate(() => (window as never as W).__artmatic.project.autosaveNow());

  const drafts = await page.evaluate(() => (window as never as W).__artmatic.project.drafts());
  expect(drafts.some((d) => d.name === '崩溃前的名字')).toBe(true);
  // 自动保存是磁盘行为，不是「已保存」：工程必须继续显示有未保存改动。
  expect(await page.evaluate(() => (window as never as W).__artmatic.appState.projectDirty)).toBe(true);

  await page.reload();
  await page.waitForFunction(() => (window as never as W).__artmatic);
  // 横幅挂在主界面里；先把一份工程打开，shell 才不是 inert（与 restore.spec 同一手法）。
  await openDemo(page);

  const banner = page.getByTestId('restore-draft');
  await expect(banner).toBeVisible();
  await expect(banner).toContainText('崩溃前的名字');

  await page.getByTestId('restore-draft-do').click();
  await expect(page.getByTestId('statusbar-project')).toContainText('崩溃前的名字');
  expect(await page.evaluate(() => (window as never as W).__artmatic.appState.projectDirty)).toBe(true);
  await expect(page.getByTestId('restore-draft')).toHaveCount(0);
});

test('有目录：自动保存写 project.json，但不轮转 .bak', async ({ page }) => {
  await boot(page);
  await page.evaluate((d) => (window as never as W).__artmatic.project.wipe(d), DIR);
  await page.evaluate((d) => (window as never as W).__artmatic.project.useOpfs(d), DIR);
  await page.evaluate(() => (window as never as W).__artmatic.project.save());

  // 第一次手动保存没有上一版可备份。
  expect(await page.evaluate((d) => (window as never as W).__artmatic.project.read(`${d}/project.json.bak`), DIR)).toBeNull();

  await rename(page, '自动保存的名字');
  await page.evaluate(() => (window as never as W).__artmatic.project.autosaveNow());

  const afterAutosave = await page.evaluate((d) => (window as never as W).__artmatic.project.read(`${d}/project.json`), DIR);
  expect(JSON.parse(afterAutosave!).name).toBe('自动保存的名字');
  expect(
    await page.evaluate((d) => (window as never as W).__artmatic.project.read(`${d}/project.json.bak`), DIR),
    '自动保存不许碰 .bak —— 它必须停在「上一次手动保存」',
  ).toBeNull();
  expect(await page.evaluate(() => (window as never as W).__artmatic.appState.projectDirty)).toBe(true);

  // 手动保存才轮转 .bak：那一刻的 .bak 是自动保存写下的那一版。
  await page.evaluate(() => (window as never as W).__artmatic.project.save());
  const bak = await page.evaluate((d) => (window as never as W).__artmatic.project.read(`${d}/project.json.bak`), DIR);
  expect(bak).not.toBeNull();
  expect(JSON.parse(bak!).name).toBe('自动保存的名字');
  expect(await page.evaluate(() => (window as never as W).__artmatic.appState.projectDirty)).toBe(false);
});

test('内容没变就不重写：播放期的 invalidate 不该每两秒重刷一遍磁盘', async ({ page }) => {
  await boot(page);
  await page.evaluate((d) => (window as never as W).__artmatic.project.wipe(d), DIR);
  await page.evaluate((d) => (window as never as W).__artmatic.project.useOpfs(d), DIR);
  await page.evaluate(() => (window as never as W).__artmatic.project.save());

  // 「解码出一帧 → store.invalidate()」：version 前进，内容一个字节都没变，工程也不脏。
  const touch = (): Promise<void> =>
    page.evaluate(() => (window as never as W).__artmatic.store.invalidate());

  // 第一次自动保存把「当前内容」记进 lastWritten。
  await touch();
  await page.evaluate(() => (window as never as W).__artmatic.project.autosaveNow());

  /*
   * 往 project.json 里塞一个哨兵：如果下一次自动保存**重写**了文件，
   * 哨兵会被真实内容覆盖。内容没变时它必须原样留着 —— 这就是「不写」的判据，
   * 比「值对不对」强：重写一遍文件在这个断言下会被抓个正着。
   */
  const sentinel = '{"sentinel":true}';
  await page.evaluate(
    (args) => (window as never as W).__artmatic.project.write(`${args.dir}/project.json`, args.bytes),
    { dir: DIR, bytes: Array.from(new TextEncoder().encode(sentinel)) },
  );

  await touch();
  await page.evaluate(() => (window as never as W).__artmatic.project.autosaveNow());

  const after = await page.evaluate((d) => (window as never as W).__artmatic.project.read(`${d}/project.json`), DIR);
  expect(after).toBe(sentinel);
});
