import { describe, expect, it } from 'vitest';
import { memoryRoot, writeBytesAtomic } from '../../src/project/fs';
import {
  PLUGIN_STATE_MAX_BYTES,
  pluginStateFileName,
  readPluginState,
  removePluginState,
  writePluginState,
} from '../../src/project/plugin-state';

/**
 * 插件私有状态（`plugins/<id>.state.json`）。
 *
 * 它是**可丢弃**的旁路：读丢了插件重新算一遍，不能挡住打开工程。
 * 所以守卫的重点是「坏输入不抛 / 超限不写 / 移除时连带删」。
 */

async function projectDir(name = 'p') {
  const root = memoryRoot();
  const dir = await root.openDir(name, { create: true });
  return { root, dir };
}

describe('往返', () => {
  it('写进去什么读出来什么', async () => {
    const { dir } = await projectDir();
    expect(await writePluginState(dir, 'demo', { tab: 'a', zoom: 3, list: [1, 2] })).toBe(true);
    expect(await readPluginState(dir, 'demo')).toEqual({ tab: 'a', zoom: 3, list: [1, 2] });
  });

  it('文件名是 `<id>.state.json`，不会被当成插件挂载', () => {
    expect(pluginStateFileName('demo')).toBe('demo.state.json');
    expect(pluginStateFileName('demo')).not.toMatch(/\.js$/);
  });

  it('不同插件互不影响', async () => {
    const { dir } = await projectDir();
    await writePluginState(dir, 'a', { v: 1 });
    await writePluginState(dir, 'b', { v: 2 });
    expect(await readPluginState(dir, 'a')).toEqual({ v: 1 });
    expect(await readPluginState(dir, 'b')).toEqual({ v: 2 });
  });
});

describe('降级', () => {
  it('没有文件 → 空对象（不是 null，调用方不必判空）', async () => {
    const { dir } = await projectDir();
    expect(await readPluginState(dir, 'ghost')).toEqual({});
  });

  it('坏 JSON → 空对象，不抛', async () => {
    const { dir } = await projectDir();
    const plugins = await dir.openDir('plugins', { create: true });
    await writeBytesAtomic(plugins, pluginStateFileName('demo'), '{ oops');
    expect(await readPluginState(dir, 'demo')).toEqual({});
  });

  it('没有信封的旧文件整份当 data', async () => {
    const { dir } = await projectDir();
    const plugins = await dir.openDir('plugins', { create: true });
    await writeBytesAtomic(plugins, pluginStateFileName('demo'), JSON.stringify({ a: 1 }));
    expect(await readPluginState(dir, 'demo')).toEqual({ a: 1 });
  });

  it('信封里的 data 不是对象 → 空对象', async () => {
    const { dir } = await projectDir();
    const plugins = await dir.openDir('plugins', { create: true });
    await writeBytesAtomic(plugins, pluginStateFileName('demo'), JSON.stringify({ format: 1, data: [1] }));
    expect(await readPluginState(dir, 'demo')).toEqual({});
  });
});

describe('写入的边界', () => {
  it('超过上限不写（返回 false，磁盘保持原样）', async () => {
    const { dir } = await projectDir();
    await writePluginState(dir, 'demo', { keep: true });
    const huge = 'x'.repeat(PLUGIN_STATE_MAX_BYTES);
    expect(await writePluginState(dir, 'demo', { huge })).toBe(false);
    expect(await readPluginState(dir, 'demo')).toEqual({ keep: true });
  });

  it('不能 JSON 化的值被丢掉，其余照写', async () => {
    const { dir } = await projectDir();
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(await writePluginState(dir, 'demo', { ok: 1, fn: () => 1, cyclic })).toBe(true);
    expect(await readPluginState(dir, 'demo')).toEqual({ ok: 1 });
  });

  it('写失败返回 false，不抛', async () => {
    const { root, dir } = await projectDir();
    root.setFault((op) => (op === 'write' ? new Error('denied') : null));
    expect(await writePluginState(dir, 'demo', { a: 1 })).toBe(false);
  });
});

describe('移除', () => {
  it('删掉状态文件；删不存在的也算成功', async () => {
    const { dir } = await projectDir();
    await writePluginState(dir, 'demo', { a: 1 });
    await removePluginState(dir, 'demo');
    expect(await readPluginState(dir, 'demo')).toEqual({});
    await expect(removePluginState(dir, 'demo')).resolves.toBeUndefined();
  });
});
