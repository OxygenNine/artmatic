import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { isPathDir, pathDir, pathFromHandle, pathHandleMarker } from '../../src/project/path-dir';
import {
  readTextIfExists,
  writeBytesAtomic,
  writeStreamAtomic,
  NotFoundError,
} from '../../src/project/fs';
import type { NodeFs } from '../../src/platform/types';

/**
 * `pathDir` 是桌面版的**工程目录**。它要顶替 FSA 的那套语义（原子写 / 读流 /
 * 删除 / 不存在时抛 `NotFoundError`），所以这里拿**真的 Node 文件系统**当桥 ——
 * 它跟主进程实现的东西是同一组 API（`desktop/host.mjs` 的 `artmatic:fs*`），
 * 只是把 IPC 换成了直接调用。
 */
function nodeBridge(): NodeFs {
  const writes = new Map<number, { fh: fsp.FileHandle; tmp: string; file: string; size: number }>();
  let seq = 0;
  return {
    sep: path.sep,
    async pickProjectDir() {
      return null;
    },
    async list(dir) {
      const entries = await fsp.readdir(dir, { withFileTypes: true });
      return entries.map((e) => ({ name: e.name, kind: e.isDirectory() ? 'directory' : 'file' }));
    },
    async read(file, start, end) {
      try {
        const fh = await fsp.open(file, 'r');
        try {
          const len = Math.max(0, end - start);
          const buf = Buffer.alloc(len);
          const { bytesRead } = await fh.read(buf, 0, len, start);
          return new Uint8Array(buf.subarray(0, bytesRead));
        } finally {
          await fh.close();
        }
      } catch {
        return null;
      }
    },
    async stat(p) {
      const st = await fsp.stat(p).catch(() => null);
      if (!st) return null;
      return { size: st.size, mtime: st.mtimeMs, kind: st.isDirectory() ? 'directory' : 'file' };
    },
    async mkdir(dir) {
      await fsp.mkdir(dir, { recursive: true });
    },
    async remove(p, recursive) {
      await fsp.rm(p, { recursive, force: false });
    },
    async writeBegin(file) {
      await fsp.mkdir(path.dirname(file), { recursive: true });
      const id = ++seq;
      const tmp = `${file}.${id}.tmp`;
      writes.set(id, { fh: await fsp.open(tmp, 'w'), tmp, file, size: 0 });
      return id;
    },
    async writeChunk(id, bytes) {
      const w = writes.get(id);
      if (!w) throw new Error('no such writer');
      await w.fh.write(Buffer.from(bytes), 0, bytes.byteLength, w.size);
      w.size += bytes.byteLength;
    },
    async writeEnd(id) {
      const w = writes.get(id)!;
      writes.delete(id);
      await w.fh.sync();
      await w.fh.close();
      await fsp.rename(w.tmp, w.file);
    },
    async writeAbort(id) {
      const w = writes.get(id)!;
      writes.delete(id);
      await w.fh.close();
      await fsp.rm(w.tmp, { force: true });
    },
    async reveal() {},
  };
}

let root: string;
let fsImpl: NodeFs;

beforeAll(async () => {
  root = await fsp.mkdtemp(path.join(os.tmpdir(), 'artmatic-pathdir-'));
  fsImpl = nodeBridge();
});

afterAll(async () => {
  await fsp.rm(root, { recursive: true, force: true });
});

describe('pathDir：目录契约', () => {
  it('名字取末段，带 kind 标记，且与 index 里的标记一一对应', () => {
    const dir = pathDir(path.join(root, 'proj'), fsImpl);
    expect(dir.name).toBe('proj');
    expect(isPathDir(dir)).toBe(true);
    expect(isPathDir(null)).toBe(false);
    expect(pathFromHandle(pathHandleMarker(dir.path))).toBe(dir.path);
    expect(pathFromHandle({ kind: 'path' })).toBeNull();
    expect(pathFromHandle('an-fsa-handle')).toBeNull();
  });

  it('openDir(create) 建目录；list 给出子项', async () => {
    const dir = pathDir(path.join(root, 'a'), fsImpl);
    const sub = await dir.openDir('assets', { create: true });
    await sub.openFile('x.bin', { create: true }).then((h) => h.openWrite()).then((w) => w.close());

    const entries = await dir.list();
    expect(entries).toEqual([{ name: 'assets', kind: 'directory' }]);
  });

  it('openDir 不存在又不 create → NotFoundError', async () => {
    const dir = pathDir(path.join(root, 'a'), fsImpl);
    await expect(dir.openDir('nope')).rejects.toBeInstanceOf(NotFoundError);
  });
});

describe('pathDir：文件语义', () => {
  it('原子里写 + 读回校验，且不留临时文件', async () => {
    const dir = pathDir(path.join(root, 'b'), fsImpl);
    const report = await writeBytesAtomic(dir, 'project.json', '{"name":"x"}');

    expect(report.verified).toBe('hash');
    expect(await readTextIfExists(dir, 'project.json')).toBe('{"name":"x"}');
    // 临时文件必须已经 rename 掉：留在盘上就是每次保存多一份垃圾。
    const left = (await fsp.readdir(dir.path)).filter((n) => n.endsWith('.tmp'));
    expect(left).toEqual([]);
  });

  it('流式写把分块按序拼起来', async () => {
    const dir = pathDir(path.join(root, 'c'), fsImpl);
    // 生产里喂进来的就是 `asset-store` 的 `streamChunks()`，即一个异步可迭代。
    async function* chunks(): AsyncIterable<Uint8Array> {
      for (const s of ['hello ', 'world', '!']) yield new TextEncoder().encode(s);
    }
    await writeStreamAtomic(dir, 'note.txt', chunks());
    expect(await readTextIfExists(dir, 'note.txt')).toBe('hello world!');
  });

  it('readStream 分块读回同一份内容', async () => {
    const dir = pathDir(path.join(root, 'd'), fsImpl);
    const payload = 'x'.repeat(9_000);
    await writeBytesAtomic(dir, 'big.txt', payload);

    const file = await (await dir.openFile('big.txt')).get();
    const reader = file.readStream!().getReader();
    let text = '';
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      text += new TextDecoder().decode(value);
    }
    expect(text).toBe(payload);
    expect(file.path).toBe(path.join(root, 'd', 'big.txt'));
  });

  it('读不存在的文件 → NotFoundError（不是空串，也不是崩）', async () => {
    const dir = pathDir(path.join(root, 'e'), fsImpl);
    await expect((await dir.openFile('missing.json')).get()).rejects.toBeInstanceOf(NotFoundError);
    await expect(readTextIfExists(dir, 'missing.json')).resolves.toBeNull();
  });
});

describe('pathDir：删除', () => {
  it('recursive 删掉整棵子树（与 FSA 的 remove 同一语义）', async () => {
    const dir = pathDir(path.join(root, 'f'), fsImpl);
    const assets = await dir.openDir('assets', { create: true });
    await writeBytesAtomic(assets, 'a.bin', 'aaaa');

    await expect(dir.remove('assets')).rejects.toThrow();
    await dir.remove('assets', { recursive: true });
    expect(await dir.list()).toEqual([]);
  });
});
