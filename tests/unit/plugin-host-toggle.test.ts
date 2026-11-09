import { describe, expect, it } from 'vitest';
import { PluginHost, DISABLED_EXT } from '../../src/plugins/host';
import { NotFoundError, type FsDirHandle, type FsEntryInfo } from '../../src/project/fs';

class FakeFile {
  bytes: Uint8Array;
  /** 模拟权限 / 占用导致的写入失败。 */
  failWrite = false;

  constructor(
    readonly name: string,
    bytes = new Uint8Array(),
  ) {
    this.bytes = bytes;
  }

  get(): Promise<{
    readBytes(): Promise<Uint8Array>;
    readText(): Promise<string>;
    size: number;
    lastModified: number;
  }> {
    return Promise.resolve({
      readBytes: async () => this.bytes,
      readText: async () => new TextDecoder().decode(this.bytes),
      size: this.bytes.byteLength,
      lastModified: 0,
    });
  }

  openWrite(): Promise<{
    write(data: Uint8Array | string): Promise<void>;
    close(): Promise<void>;
    abort(): Promise<void>;
  }> {
    if (this.failWrite) throw new Error('denied');
    return Promise.resolve({
      write: async (data) => {
        this.bytes = typeof data === 'string' ? new TextEncoder().encode(data) : data;
      },
      close: async () => {},
      abort: async () => {},
    });
  }
}

class FakeDir implements FsDirHandle {
  readonly children = new Map<string, FakeDir | FakeFile>();
  failAllWrites = false;

  constructor(readonly name: string) {}

  openFile(name: string, opts?: { create?: boolean }): Promise<FakeFile> {
    const hit = this.children.get(name);
    if (hit instanceof FakeFile) return Promise.resolve(hit);
    if (hit) throw new NotFoundError(name);
    if (!opts?.create) throw new NotFoundError(name);
    const file = new FakeFile(name);
    file.failWrite = this.failAllWrites;
    this.children.set(name, file);
    return Promise.resolve(file);
  }

  openDir(name: string, opts?: { create?: boolean }): Promise<FakeDir> {
    const hit = this.children.get(name);
    if (hit instanceof FakeDir) return Promise.resolve(hit);
    if (hit) throw new NotFoundError(name);
    if (!opts?.create) throw new NotFoundError(name);
    const dir = new FakeDir(name);
    dir.failAllWrites = this.failAllWrites;
    this.children.set(name, dir);
    return Promise.resolve(dir);
  }

  remove(name: string): Promise<void> {
    if (!this.children.delete(name)) throw new NotFoundError(name);
    return Promise.resolve();
  }

  list(): Promise<FsEntryInfo[]> {
    const out: FsEntryInfo[] = [];
    for (const [name, child] of this.children) {
      out.push({ name, kind: child instanceof FakeDir ? 'directory' : 'file' } as FsEntryInfo);
    }
    return Promise.resolve(out);
  }
}

async function mounted(): Promise<{ root: FakeDir; plugins: FakeDir; host: PluginHost }> {
  const root = new FakeDir('project');
  const plugins = new FakeDir('plugins');
  plugins.children.set(
    'demo.js' + DISABLED_EXT,
    new FakeFile('demo.js' + DISABLED_EXT, new TextEncoder().encode('export default {};')),
  );
  root.children.set('plugins', plugins);
  const host = new PluginHost();
  await host.mountFromDirectory(root, 'project-key');
  return { root, plugins, host };
}

describe('PluginHost 启停的磁盘 / 内存一致性', () => {
  it('改名失败时保持「停用」状态，不谎报已启用', async () => {
    const { root, plugins, host } = await mounted();
    const before = host.get('demo');
    expect(before?.enabled).toBe(false);
    expect(before?.fileName).toBe(`demo.js${DISABLED_EXT}`);

    root.failAllWrites = true;
    plugins.failAllWrites = true;

    await expect(host.enable('demo', root)).rejects.toThrow('denied');

    const after = host.get('demo');
    expect(after?.enabled).toBe(false);
    expect(after?.status).toBe('disabled');
    expect(after?.fileName).toBe(`demo.js${DISABLED_EXT}`);
  });
});
