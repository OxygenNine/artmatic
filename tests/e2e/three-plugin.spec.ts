/**
 * three-plugin.spec.ts — 插件提供 three 程序，片段只存**引用**。
 *
 * 这条用例守的是引用语义本身：**改插件 = 改所有引用它的片段**。断了的表现有两条，
 * 都不报错：
 *   - 片段里悄悄存了一份代码副本 → 改插件之后这条片段还是旧画面；
 *   - 解析器缓存住了第一次的结果 → 同上，但要重启才能发现。
 * 所以判据是「不改片段，只改插件文件，重开工程，画面换色」。
 */

import { expect, test, type Page } from '@playwright/test';
import { openDemo } from './_stage';

const DIR = 'e2e-three-plugin';

type Api = {
  __artmatic: {
    project: {
      useOpfs(name?: string): Promise<string>;
      save(): Promise<boolean>;
      open(name?: string): Promise<boolean>;
      write(path: string, bytes: number[]): Promise<void>;
      wipe(name?: string): Promise<void>;
    };
    store: {
      addTrack: (k: 'visual') => string;
      commit: (l: string, f: (p: { tracks: { enabled: boolean }[] }) => void) => void;
    };
    control: {
      addClip: (t: string, i: unknown) => Promise<{ ok: boolean; data?: { clipId: string }; error?: { code: string; message: string } }>;
      setThreeCode: (id: string, code: string) => Promise<{ ok: boolean; error?: { code: string } }>;
      threeStatus: (id: string) => Promise<{ ok: boolean; data?: { ok: boolean; error: string | null; filled: number }; error?: { code: string } }>;
      getScene: () => Promise<{ data?: { tracks: { clips: { source?: { type?: string; code?: string; ref?: { plugin: string; name: string } } }[] }[] } }>;
    };
    renderFrame: (t: number) => void;
    readPixels: () => { data: number[]; w: number; h: number };
  };
};

/** 一个只装 three 代码池的插件；`hex` 决定它画什么颜色，`name` 是程序名。 */
function poolPlugin(hex: string, name = 'tint'): string {
  return [
    'export const plugin = {',
    "  format: 'artmatic-plugin',",
    '  apiVersion: 4,',
    "  id: 'e2e-pool',",
    "  name: 'e2e pool',",
    '  three: [{',
    "    name: '" + name + "',",
    "    label: 'Tint',",
    '    code: [',
    '      "function params() {",',
    '      "  return [{ key: \\"k\\", type: \\"range\\", min: 0, max: 1, defaultValue: 0.5 }];",',
    '      "}",',
    '      "function create(THREE, ctx) {",',
    '      "  const scene = new THREE.Scene();",',
    '      "  const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, 10);",',
    '      "  camera.position.z = 1;",',
    `      "  const q = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), new THREE.MeshBasicMaterial({ color: 0x${hex} }));",`,
    '      "  q.frustumCulled = false;",',
    '      "  scene.add(q);",',
    '      "  return { scene, camera };",',
    '      "}",',
    "    ].join('\\n'),",
    '  }],',
    '};',
    '',
  ].join('\n');
}

async function boot(page: Page): Promise<void> {
  await page.goto('/');
  await page.waitForFunction(() => Boolean((window as never as Api).__artmatic));
  await openDemo(page);
  await page.evaluate((d) => (window as never as Api).__artmatic.project.wipe(d), DIR);
  await page.evaluate((d) => (window as never as Api).__artmatic.project.useOpfs(d), DIR);
}

async function plant(page: Page, source: string): Promise<void> {
  await page.evaluate(
    ({ path, bytes }) => (window as never as Api).__artmatic.project.write(path, bytes),
    { path: `${DIR}/plugins/pool.js`, bytes: Array.from(new TextEncoder().encode(source)) },
  );
  await page.evaluate(() => (window as never as Api).__artmatic.project.save());
}

async function reopen(page: Page): Promise<void> {
  const ok = await page.evaluate((d) => (window as never as Api).__artmatic.project.open(d), DIR);
  expect(ok).toBe(true);
}

/** 渲一帧取中心像素（渲染与读像素必须在同一个 evaluate 里，见 plugins.spec.ts）。 */
async function center(page: Page, t = 1): Promise<[number, number, number]> {
  return page.evaluate((time) => {
    const A = (window as never as Api).__artmatic;
    A.renderFrame(time);
    const { data, w, h } = A.readPixels();
    const i = ((h >> 1) * w + (w >> 1)) * 4;
    return [data[i]!, data[i + 1]!, data[i + 2]!] as [number, number, number];
  }, t);
}

/** 等到中心像素满足判据（three 的模块载入与编译都是异步的）。 */
async function waitColor(page: Page, want: (c: [number, number, number]) => boolean): Promise<[number, number, number]> {
  let last: [number, number, number] = [0, 0, 0];
  for (let i = 0; i < 60; i++) {
    last = await center(page);
    if (want(last)) return last;
    await page.waitForTimeout(40);
  }
  throw new Error(`画面没有变成期望的颜色，最后一次取样 ${JSON.stringify(last)}`);
}

const isRed = (c: [number, number, number]) => c[0] > 180 && c[1] < 80 && c[2] < 80;
const isGreen = (c: [number, number, number]) => c[1] > 180 && c[0] < 80 && c[2] < 80;

test('插件提供 three 程序：片段只存引用，改插件画面跟着变', async ({ page }) => {
  await boot(page);
  await plant(page, poolPlugin('ff0000'));
  await reopen(page);

  const added = await page.evaluate(async () => {
    const A = (window as never as Api).__artmatic;
    A.store.commit('e2e: 清空', (p) => {
      for (const t of p.tracks) t.enabled = false;
    });
    const track = A.store.addTrack('visual');
    const r = await A.control.addClip(track, {
      kind: 'three',
      start: 0,
      end: 8,
      ref: { plugin: 'e2e-pool', name: 'tint' },
      params: { k: 0.5 },
    });
    return r;
  });
  expect(added.ok).toBe(true);

  expect(isRed(await waitColor(page, isRed))).toBe(true);

  // 留在工程里的东西必须是**引用**，不是代码副本
  const scene = await page.evaluate(() => (window as never as Api).__artmatic.control.getScene());
  const src = scene.data?.tracks.flatMap((t) => t.clips).find((c) => c.source?.type === 'three')?.source;
  expect(src?.ref).toEqual({ plugin: 'e2e-pool', name: 'tint' });
  expect(src?.code).toBeUndefined();

  // 只改插件文件，片段一个字都不动
  await page.evaluate(() => (window as never as Api).__artmatic.project.save());
  await plant(page, poolPlugin('00ff00'));
  await reopen(page);

  expect(isGreen(await waitColor(page, isGreen))).toBe(true);
});

test('引用型片段没有自己的代码：set_three_code 被拒，缺失插件时说得清原因', async ({ page }) => {
  await boot(page);
  await plant(page, poolPlugin('ff0000'));
  await reopen(page);

  const clipId = await page.evaluate(async () => {
    const A = (window as never as Api).__artmatic;
    A.store.commit('e2e: 清空', (p) => {
      for (const t of p.tracks) t.enabled = false;
    });
    const track = A.store.addTrack('visual');
    const r = await A.control.addClip(track, {
      kind: 'three',
      start: 0,
      end: 8,
      ref: { plugin: 'e2e-pool', name: 'tint' },
    });
    return r.data?.clipId ?? '';
  });
  expect(clipId).not.toBe('');

  const wrote = await page.evaluate(
    (id) => (window as never as Api).__artmatic.control.setThreeCode(id, 'function create() { return {}; }'),
    clipId,
  );
  // `unsupported`：这条片段的内容属于插件，改它要走 plugin_edit
  expect(wrote.ok).toBe(false);
  expect(wrote.error?.code).toBe('unsupported');

  /*
   * 程序被改名之后（插件还在、只是没这个名字）：片段还在，但这一层不出图，
   * 试跑说清是哪一段引用找不到。用「改名」而不是「删插件」—— 后者会连
   * project.json 一起删掉（同一个目录），工程都打不开了。
   */
  await plant(page, poolPlugin('ff0000', 'renamed'));
  await reopen(page);
  const status = await page.evaluate(
    (id) => (window as never as Api).__artmatic.control.threeStatus(id),
    clipId,
  );
  expect(status.ok).toBe(true);
  expect(status.data?.ok).toBe(false);
  expect(status.data?.error ?? '').toContain('e2e-pool');
});
