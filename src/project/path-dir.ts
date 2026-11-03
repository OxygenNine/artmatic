/**
 * path-dir.ts — 用**本机绝对路径**实现的 `FsDirHandle`（桌面壳专用）。
 *
 * ## 为什么需要第二条根
 *
 * `fs.ts` 的三条根（fsaRoot / opfsRoot / memoryRoot）里，生产用的那条是 FSA：
 * 句柄能跨会话存活、权限由系统管。但它是**不透明引用** —— 拿不到绝对路径，于是
 * 有两件事永远做不到：
 *
 *   · 在资源管理器里打开工程目录；
 *   · 真的把工程目录删掉（`remove()` 只能删子项，删自己需要父句柄）。
 *
 * 桌面壳有 Node，这两件事都是一行。缺的只是路径，所以桌面版的工程目录直接用
 * **路径**表示，读写走 `platform.fs` 那组 IPC（主进程侧只认用户亲手选过的根）。
 *
 * ## 与 FSA 的语义对齐
 *
 * 逐条对上，否则同一条保存逻辑在两个宿主里会有两种行为：
 *
 * | 能力 | FSA | 这里 |
 * |---|---|---|
 * | 原子写 | `createWritable` 的 siloed 模式 | 同目录临时文件 + `rename`（主进程侧） |
 * | 独占写 | `mode:'exclusive'` 抛 `NoModificationAllowedError` | 不实现（见下） |
 * | 读流 | `File.stream()` | 按 4 MiB 分块 `read` |
 * | `readBlob()` | 原生 `File`（零拷贝） | **不提供**，改用 `path`（视频直接走 PathVideoMedia） |
 *
 * 独占写不实现是有意的：单机桌面壳里同一个工程被两个窗口同时写，比浏览器里少见
 * 得多，而且真要挡，靠的是「同一份工程只在一个窗口打开」这条更高层的约定。
 */

import type { NodeFs, NodeFsEntry } from '../platform/types';
import {
  NotFoundError,
  type FsDirHandle,
  type FsEntryInfo,
  type FsFile,
  type FsFileHandle,
  type FsWritable,
  type FsWriteOptions,
} from './fs';

/** 分块读数。与 `asset-store` 的 `CHUNK` 同量级：再大就是白占内存，再小是白跑 IPC。 */
const CHUNK = 4 * 1024 * 1024;

export interface PathDirHandle extends FsDirHandle {
  readonly kind: 'path';
  readonly path: string;
}

/** 句柄类型判据（`attachProjectDirectory` / 菜单动作用它决定走 Node 还是 FSA）。 */
export function isPathDir(dir: FsDirHandle | null | undefined): dir is PathDirHandle {
  return (dir as Partial<PathDirHandle> | null | undefined)?.kind === 'path';
}

/**
 * IndexedDB 里存的「路径句柄」。
 *
 * 存的是这一个小对象而不是字符串：`dirHandles` 那个 store 里同时躺着 FSA 的原生
 * 句柄（structured clone 的对象），两者必须一眼可分。
 */
export interface PathHandleMarker {
  kind: 'path';
  path: string;
}

export function pathHandleMarker(path: string): PathHandleMarker {
  return { kind: 'path', path };
}

export function pathFromHandle(raw: unknown): string | null {
  const m = raw as Partial<PathHandleMarker> | null;
  if (!m || m.kind !== 'path' || typeof m.path !== 'string' || !m.path) return null;
  return m.path;
}

const baseName = (p: string): string => {
  const noTail = p.replace(/[\\/]+$/, '');
  const i = Math.max(noTail.lastIndexOf('/'), noTail.lastIndexOf('\\'));
  return i >= 0 ? noTail.slice(i + 1) : noTail;
};

const join = (sep: string, base: string, name: string): string =>
  `${base.replace(/[\\/]+$/, '')}${sep}${name}`;

export function pathDir(dirPath: string, nodeFs: NodeFs): PathDirHandle {
  const sep = nodeFs.sep;

  const dir: PathDirHandle = {
    kind: 'path',
    path: dirPath,
    name: baseName(dirPath),

    async openFile(name, opts): Promise<FsFileHandle> {
      const abs = join(sep, dirPath, name);
      return {
        name,
        // 惰性：不存在时不在这里抛（`create:false` 的调用方期待 `get()` 抛
        // `NotFoundError`，见 `readTextIfExists`）。`create:true` 由写入时建。
        async get(): Promise<FsFile> {
          const st = await nodeFs.stat(abs);
          if (!st || st.kind !== 'file') throw new NotFoundError(name);
          return {
            // 视频解码要靠它走 PathVideoMedia —— 这是「工程目录里的视频」零拷贝的唯一办法。
            path: abs,
            size: st.size,
            lastModified: st.mtime,
            async readBytes() {
              const bytes = await nodeFs.read(abs, 0, st.size);
              return bytes ?? new Uint8Array(0);
            },
            readText() {
              return nodeFs.read(abs, 0, st.size).then((b) => new TextDecoder().decode(b ?? new Uint8Array(0)));
            },
            readStream() {
              let offset = 0;
              return new ReadableStream<Uint8Array>({
                async pull(controller) {
                  if (offset >= st.size) {
                    controller.close();
                    return;
                  }
                  const end = Math.min(offset + CHUNK, st.size);
                  const chunk = await nodeFs.read(abs, offset, end);
                  if (!chunk || chunk.byteLength === 0) {
                    controller.close();
                    return;
                  }
                  offset += chunk.byteLength;
                  controller.enqueue(chunk);
                },
              });
            },
          };
        },
        async openWrite(_opts?: FsWriteOptions): Promise<FsWritable> {
          const id = await nodeFs.writeBegin(abs);
          let done = false;
          return {
            async write(data) {
              const bytes =
                typeof data === 'string' ? new TextEncoder().encode(data) : data;
              if (bytes.byteLength) await nodeFs.writeChunk(id, bytes);
            },
            async close() {
              if (done) return;
              done = true;
              await nodeFs.writeEnd(id);
            },
            async abort() {
              if (done) return;
              done = true;
              await nodeFs.writeAbort(id);
            },
          };
        },
      };
    },

    async openDir(name, opts): Promise<PathDirHandle> {
      const abs = join(sep, dirPath, name);
      if (opts?.create) await nodeFs.mkdir(abs);
      else {
        const st = await nodeFs.stat(abs);
        if (!st || st.kind !== 'directory') throw new NotFoundError(name);
      }
      return pathDir(abs, nodeFs);
    },

    remove(name, opts) {
      return nodeFs.remove(join(sep, dirPath, name), Boolean(opts?.recursive));
    },

    async list(): Promise<FsEntryInfo[]> {
      const entries: NodeFsEntry[] = await nodeFs.list(dirPath);
      return entries.map((e) => ({ name: e.name, kind: e.kind }));
    },
  };

  return dir;
}
