/**
 * fs.ts — 工程目录的读写能力。
 *
 * ## 为什么自己定义接口，而不是直接用 `FileSystemDirectoryHandle`
 *
 * 因为**同一套接口有三个根来源**，而且其中一个不带文件系统：
 *
 * | 根来源     | 用途            | 授权             |
 * |-----------|----------------|-----------------|
 * | `fsaRoot` (用户选的目录) | 生产          | 首次需点一次     |
 * | `opfsRoot` (OPFS)       | E2E + dev      | 无，自动         |
 * | `memoryRoot`            | 单测           | 无              |
 *
 * OPFS 的 `navigator.storage.getDirectory()` 返回的**就是**一个
 * `FileSystemDirectoryHandle`，与用户选的目录同类 —— 所以 E2E 跑在 OPFS 上
 * 是**真文件系统**，不是 mock。生产代码路径与 E2E 完全同一条，只有「根从哪来」
 * 不同。这正是硬约束 1.5 想要的形状：不存在「只能在 Electron 里跑起来才能测」
 * 的东西。
 *
 * `memoryRoot` 存在的理由不同：单测跑在 Node 里，没有文件系统，但
 * **保存/打开编排逻辑**（原子写、.bak、迁移、素材同步）必须能测，
 * 而且要比 E2E 快得多。memory 实现**模拟了 swap 语义**（写入进临时缓冲，
 * `close()` 才提交），所以「写到一半失败不损坏原文件」这条能被真实测到。
 *
 * ## 关于原子写
 *
 * 本文件**没有** `tmp → fsync → rename` 那套。原因是 Chromium 的
 * `createWritable()` 默认就是 siloed 模式：先在同目录写一个 `.crswap` 临时文件，
 * `close()` 时才把它 rename 到目标（Chromium 官方说明这是为了给系统安全扫描
 * 留出窗口）。也就是说**原子性由浏览器直接提供**，不需要我们手写，
 * 而且写 `.tmp` 再 `move()` 反而要赌 `FileSystemHandle.move()` 的可用性。
 *
 * 我们能自己做的只有两件：
 *  1. `.bak` —— 写入前把旧内容另存一份，因为浏览器不提供历史版本。
 *  2. **写回校验** —— `close()` 之后读回来比一遍。它抓不到断电（没有 fsync API），
 *     但能抓到「磁盘满但 close 没报错」这类静默损坏，代价是几毫秒。
 */

import { tr } from '../i18n/index.svelte';
import { hashIfReasonable } from './hash';

/* ------------------------------------------------------------ 接口 */

export interface FsEntryInfo {
  name: string;
  kind: 'file' | 'directory';
}

export interface FsFile {
  /**
   * 本机绝对路径。**只有路径句柄给得出**（`project/path-dir.ts`）——
   * FSA 的句柄是不透明引用。视频解码用它走 `PathVideoMedia`（按范围读，
   * 一个字节都不进堆），这是「工程目录里的视频」不变成 Blob 的唯一办法。
   */
  readonly path?: string;
  readBytes(): Promise<Uint8Array>;
  readText(): Promise<string>;
  /**
   * 流式读。大文件（视频）用它，**不要**先 `readBytes()` ——
   * 那是把整份素材摊进堆的那一步。
   *
   * 可选：不实现时上层退回 `readBytes()`（memory 与旧实现）。
   */
  readStream?(): ReadableStream<Uint8Array>;
  /**
   * 当 Blob 用。视频交给解码器（mediabunny）时需要的正是它 ——
   * `File` 本身就是 Blob，原生实现零拷贝。
   */
  readBlob?(): Promise<Blob>;
  readonly size: number;
  /** 毫秒时间戳；memory 与部分实现可能给 0（说明它不参与任何判据）。 */
  readonly lastModified: number;
}

export interface FsWritable {
  write(data: Uint8Array | string): Promise<void>;
  /** 提交。siloed 模式下这一刻才 rename 到目标。 */
  close(): Promise<void>;
  /** 丢弃：目标文件保持写入前的样子。 */
  abort(reason?: unknown): Promise<void>;
}

export interface FsWriteOptions {
  /**
   * `exclusive`（默认）只允许一个 writer 同时存在，第二个会抛
   * `NoModificationAllowedError` —— 多标签页同时开一个工程时，靠它把第二个挡掉。
   * `siloed` 是浏览器默认，各自有独立 swap 文件，后 close 的赢（静默互相覆盖）。
   */
  mode?: 'siloed' | 'exclusive';
  /** 保留原内容作为写入起点（片段式覆盖时用）。我们总是整体重写，所以从不传。 */
  keepExistingData?: boolean;
}

export interface FsFileHandle {
  readonly name: string;
  get(): Promise<FsFile>;
  openWrite(opts?: FsWriteOptions): Promise<FsWritable>;
}

export interface FsDirHandle {
  readonly name: string;
  openFile(name: string, opts?: { create?: boolean }): Promise<FsFileHandle>;
  openDir(name: string, opts?: { create?: boolean }): Promise<FsDirHandle>;
  remove(name: string, opts?: { recursive?: boolean }): Promise<void>;
  /** 仅直接子项。 */
  list(): Promise<FsEntryInfo[]>;
}

/** 背后是真实文件系统的目录（可以申请权限、可以存进 IndexedDB）。 */
export interface NativeBackedDir extends FsDirHandle {
  readonly native: true;
  /** 原生 `FileSystemDirectoryHandle`。只有句柄持久化与权限查询用得到。 */
  readonly raw: unknown;
}

export function isNativeBacked(dir: FsDirHandle): dir is NativeBackedDir {
  return (dir as Partial<NativeBackedDir>).native === true;
}

/** 目录不存在时的错误类型。用类型而不是字符串判据，免得本地化文案一改就失效。 */
export class NotFoundError extends Error {
  constructor(what: string) {
    super(`找不到 ${what}`);
    this.name = 'NotFoundError';
  }
}

/* ------------------------------------------------------- 原生句柄访问
 *
 * 底层直接用 `lib.dom` 的 `FileSystemDirectoryHandle` / `FileSystemFileHandle`，
 * **不自己造一套平行类型** —— 造过一版，结果是 `createWritable` 的
 * 参数与返回类型和 DOM 定义对不上，报一串
 * `SharedArrayBuffer is not assignable to ArrayBuffer` 的噪声
 * （TS 5.7 起 TypedArray 带了 ArrayBufferLike 泛型参数，而 `BufferSource`
 * 只收 ArrayBuffer 那一支）。用官方类型就没这个问题。
 *
 * 真正需要绕开的只有两件事，都在 `extras()` 里一次性断言：
 *  1. `queryPermission` / `requestPermission` / `values` 不在 lib.dom 的定义里，
 *     但 Chromium 运行时都有；
 *  2. `createWritable()` 的 `mode: 'exclusive'` 是 Chrome 121 新增项，
 *     定义还没跟上。
 */

interface DirExtras {
  values?(): AsyncIterableIterator<FileSystemFileHandle | FileSystemDirectoryHandle>;
  entries?(): AsyncIterableIterator<[string, FileSystemFileHandle | FileSystemDirectoryHandle]>;
  queryPermission?(d?: { mode?: 'read' | 'readwrite' }): Promise<PermissionState>;
  requestPermission?(d?: { mode?: 'read' | 'readwrite' }): Promise<PermissionState>;
}

function extras(dir: FileSystemDirectoryHandle): DirExtras {
  return dir as unknown as DirExtras;
}

/* ------------------------------------------------------------ 目录操作 */

/** 逐级走（或创建）目录，返回最末一级。段数组，不拼路径串。 */
export async function resolveDir(root: FsDirHandle, segments: string[], create = true): Promise<FsDirHandle> {
  let cur = root;
  for (const seg of segments) cur = await cur.openDir(seg, { create });
  return cur;
}

/** 按 `PROJECT_DIRS` 那样的段数组列表建好整棵目录树。 */
export async function ensureDirs(root: FsDirHandle, dirs: readonly (readonly string[])[]): Promise<void> {
  for (const segs of dirs) await resolveDir(root, [...segs], true);
}

export async function exists(dir: FsDirHandle, name: string, kind?: 'file' | 'directory'): Promise<boolean> {
  const items = await dir.list();
  return items.some((i) => i.name === name && (!kind || i.kind === kind));
}

export async function readBytesIfExists(dir: FsDirHandle, name: string): Promise<Uint8Array | null> {
  try {
    const fh = await dir.openFile(name, { create: false });
    return await (await fh.get()).readBytes();
  } catch (e) {
    if (isNotFound(e)) return null;
    throw e;
  }
}

export async function readTextIfExists(dir: FsDirHandle, name: string): Promise<string | null> {
  const bytes = await readBytesIfExists(dir, name);
  return bytes ? new TextDecoder().decode(bytes) : null;
}

/**
 * 原生实现在文件不存在时抛的 `NotFoundError` 是 DOMException，
 * 名字与我们自己的类同名但不是同一个东西 —— 两个都要认。
 */
export function isNotFound(e: unknown): boolean {
  if (e instanceof NotFoundError) return true;
  return (e as { name?: string } | null)?.name === 'NotFoundError';
}

/* ------------------------------------------------------------ 原子写 */

export interface WriteReport {
  name: string;
  bytes: number;
  hash: string | null;
  /** 校验强度：hash = 逐字节可信；size = 只比了长度；none = 未校验。 */
  verified: 'hash' | 'size' | 'none';
  backup: { name: string; bytes: number } | null;
  warnings: string[];
}

/** 超过这个大小就不做逐字节校验（再读一遍 + 哈希，对几百 MB 是纯浪费）。 */
const VERIFY_HASH_MAX = 4 * 1024 * 1024;

/** 超过这个大小就完全不做读回校验，只信 close() 的返回值。 */
const VERIFY_ANY_MAX = 64 * 1024 * 1024;

export interface WriteBytesOptions {
  /** 传了就在写入前把旧内容另存到这个文件名。只有工程 json 需要。 */
  backup?: string | null;
  /** 默认 true。素材写入可以关掉（我们本来就持有原始字节，且从不覆盖已有素材）。 */
  verify?: boolean;
}

/**
 * 原子写一个文件，可选维护 `.bak`。
 *
 * 顺序是刻意的：
 *   ① 读旧内容 → 写 `.bak`（失败只记 warning，不中断保存）
 *   ② 打开 writable（exclusive）→ 写 → close（这一刻才提交）
 *   ③ 读回校验
 *
 * `.bak` 在 ② 之前完成，所以「② 炸了」时磁盘上留下的仍然是**上一次成功保存**
 * 的内容加一份同内容的 .bak —— 而不是半新半旧的组合。
 */
export async function writeBytesAtomic(
  dir: FsDirHandle,
  name: string,
  data: Uint8Array | string,
  opts: WriteBytesOptions = {},
): Promise<WriteReport> {
  const bytes = typeof data === 'string' ? new TextEncoder().encode(data) : data;
  const warnings: string[] = [];
  let backup: WriteReport['backup'] = null;

  if (opts.backup) {
    try {
      const old = await readBytesIfExists(dir, name);
      if (old) {
        await writeBytesAtomic(dir, opts.backup, old, { verify: false });
        backup = { name: opts.backup, bytes: old.byteLength };
      }
    } catch (e) {
      warnings.push(tr('err.fs.backupFailed', { detail: errText(e) }));
    }
  }

  const fh = await dir.openFile(name, { create: true });
  let w: FsWritable | null = null;
  try {
    w = await fh.openWrite({ mode: 'exclusive' });
    await w.write(bytes);
    await w.close();
    w = null;
  } catch (e) {
    // abort() 让目标文件保持原样；失败就失败，不能盖掉真正的错误。
    if (w) await w.abort(e).catch(() => {});
    throw e;
  }

  let verified: WriteReport['verified'] = 'none';
  if (opts.verify !== false && bytes.byteLength <= VERIFY_ANY_MAX) {
    const back = await (await fh.get()).readBytes();
    if (back.byteLength !== bytes.byteLength) {
      throw new Error(
        tr('err.fs.writeMismatch', { name, want: bytes.byteLength, got: back.byteLength }),
      );
    }
    if (bytes.byteLength > VERIFY_HASH_MAX) {
      verified = 'size';
    } else if (sameBytes(back, bytes)) {
      verified = 'hash';
    } else {
      throw new Error(tr('err.fs.writeCorrupt', { name }));
    }
  }

  return {
    name,
    bytes: bytes.byteLength,
    hash: verified === 'hash' ? await hashIfReasonable(bytes) : null,
    verified,
    backup,
    warnings,
  };
}

/** 流式写入的选项。比 `WriteBytesOptions` 少了逐字节校验（没有整份字节可比）。 */
export interface WriteStreamOptions {
  /** 传了就在写入前把旧内容另存到这个文件名。 */
  backup?: string | null;
  /** 读回校验（只比大小）。默认 true —— 磁盘满而 close 没报错时靠它抓。 */
  verify?: boolean;
}

/**
 * 流式原子写：边读边 `write()`，**整份素材从不进堆**。
 *
 * 与 `writeBytesAtomic` 的关系：
 *  - 原子性同源（`createWritable` 的 siloed 语义 + `close()` 才提交）；
 *  - `.bak` 逻辑同源（素材从不传 backup，只有工程 json 需要）；
 *  - **校验只比大小**：流式写入没有一份完整字节可以逐字节比对。
 *    这也正是大素材该有的代价 —— 读回一遍 2 GB 去比对，比不校验更糟。
 */
export async function writeStreamAtomic(
  dir: FsDirHandle,
  name: string,
  source: AsyncIterable<Uint8Array> | Uint8Array | string,
  opts: WriteStreamOptions = {},
): Promise<WriteReport> {
  const warnings: string[] = [];
  let backup: WriteReport['backup'] = null;

  if (opts.backup) {
    try {
      const old = await readBytesIfExists(dir, name);
      if (old) {
        await writeBytesAtomic(dir, opts.backup, old, { verify: false });
        backup = { name: opts.backup, bytes: old.byteLength };
      }
    } catch (e) {
      warnings.push(tr('err.fs.backupFailed', { detail: errText(e) }));
    }
  }

  const fh = await dir.openFile(name, { create: true });
  let total = 0;
  let w: FsWritable | null = null;
  try {
    w = await fh.openWrite({ mode: 'exclusive' });
    const put = async (chunk: Uint8Array): Promise<void> => {
      if (!chunk.byteLength) return;
      await w!.write(chunk);
      total += chunk.byteLength;
    };
    if (typeof source === 'string') {
      await put(new TextEncoder().encode(source));
    } else if (source instanceof Uint8Array) {
      await put(source);
    } else {
      for await (const chunk of source) await put(chunk);
    }
    await w.close();
    w = null;
  } catch (e) {
    if (w) await w.abort(e).catch(() => {});
    throw e;
  }

  let verified: WriteReport['verified'] = 'none';
  if (opts.verify !== false && total <= VERIFY_ANY_MAX) {
    const size = (await fh.get()).size;
    if (size !== total) {
      throw new Error(tr('err.fs.writeMismatch', { name, want: total, got: size }));
    }
    verified = 'size';
  }

  return { name, bytes: total, hash: null, verified, backup, warnings };
}

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.byteLength !== b.byteLength) return false;
  for (let i = 0; i < a.byteLength; i++) if (a[i] !== b[i]) return false;
  return true;
}

function errText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/* ------------------------------------------------------------ memory 根 */

/**
 * 内存根。**模拟了原生 writable 的 swap 语义**：
 * `write()` 只往临时缓冲里攒，`close()` 才替换目标条目。
 * 所以 abort / 抛错之后目标文件一个字节都没变 —— 「写到一半失败
 * 不损坏原工程」这条因此可以在单测里被测到，而不是只能靠祈祷。
 */
export interface MemoryRoot extends FsDirHandle {
  /** 注入故障：返回 Error 就让它在该操作上抛。用于测失败路径。 */
  setFault(fn: ((op: MemoryOp) => Error | null) | null): void;
  /** 直接塞一个文件（造测试夹具用）。 */
  seed(path: string, content: string | Uint8Array): void;
  /** 直接读一个文件（断言磁盘状态用），不存在的层返回 null。 */
  inspect(path: string): Uint8Array | null;
  /** 当前打开中的 writer 数量（测 exclusive 用）。 */
  openWriters(): number;
}

export type MemoryOp = 'write' | 'read' | 'list' | 'remove';

interface MemFile {
  kind: 'file';
  bytes: Uint8Array;
  mtime: number;
}
interface MemDirNode {
  kind: 'directory';
  children: Map<string, MemFile | MemDirNode>;
}
type MemNode = MemFile | MemDirNode;

export function memoryRoot(): MemoryRoot {
  const root: MemDirNode = { kind: 'directory', children: new Map() };
  let fault: ((op: MemoryOp) => Error | null) | null = null;
  let writers = 0;
  let clock = 1_700_000_000_000;

  function maybeFault(op: MemoryOp): void {
    const e = fault?.(op);
    if (e) throw e;
  }

  function walk(path: string, create: boolean): MemNode | null {
    const segs = path.split('/').filter(Boolean);
    let cur: MemNode = root;
    for (let i = 0; i < segs.length; i++) {
      if (cur.kind !== 'directory') return null;
      const name = segs[i]!;
      const last = i === segs.length - 1;
      let next = cur.children.get(name);
      if (!next) {
        if (!create) return null;
        next = last ? { kind: 'file', bytes: new Uint8Array(), mtime: clock++ } : { kind: 'directory', children: new Map() };
        cur.children.set(name, next);
      }
      cur = next;
    }
    return cur;
  }

  function asDir(node: MemNode | null): MemDirNode | null {
    return node && node.kind === 'directory' ? node : null;
  }

  function makeFileHandle(name: string, parent: MemDirNode): FsFileHandle {
    return {
      name,
      async get() {
        maybeFault('read');
        const node = parent.children.get(name);
        const bytes = node && node.kind === 'file' ? node.bytes : new Uint8Array();
        return {
          readBytes: async () => bytes.slice(),
          readText: async () => new TextDecoder().decode(bytes),
          // Blob 会自己拷一份内部副本；不要再 slice() 一次。
          readStream: () => new Blob([bytes as unknown as BlobPart]).stream(),
          readBlob: async () => new Blob([bytes as unknown as BlobPart]),
          size: bytes.byteLength,
          lastModified: node && node.kind === 'file' ? node.mtime : 0,
        };
      },
      async openWrite(opts) {
        if (opts?.mode !== 'siloed' && writers > 0) {
          throw Object.assign(new Error('已有写入者'), { name: 'NoModificationAllowedError' });
        }
        writers++;
        const buf: Uint8Array[] = [];
        let len = 0;
        let done = false;
        return {
          async write(data) {
            const b = typeof data === 'string' ? new TextEncoder().encode(data) : data;
            buf.push(b.slice());
            len += b.byteLength;
          },
          async close() {
            if (done) return;
            done = true;
            writers--;
            maybeFault('write');
            const all = new Uint8Array(len);
            let off = 0;
            for (const b of buf) {
              all.set(b, off);
              off += b.byteLength;
            }
            parent.children.set(name, { kind: 'file', bytes: all, mtime: clock++ });
          },
          async abort() {
            if (done) return;
            done = true;
            writers--;
          },
        };
      },
    };
  }

  function makeDirHandle(name: string, node: MemDirNode): FsDirHandle {
    return {
      name,
      async openFile(fname, opts) {
        maybeFault('read');
        const child = node.children.get(fname);
        if (child && child.kind !== 'file') throw new Error(`${fname} 是目录`);
        if (!child && !opts?.create) throw new NotFoundError(fname);
        if (!child) node.children.set(fname, { kind: 'file', bytes: new Uint8Array(), mtime: clock++ });
        return makeFileHandle(fname, node);
      },
      async openDir(dname, opts) {
        let child = node.children.get(dname);
        if (child && child.kind !== 'directory') throw new Error(`${dname} 是文件`);
        if (!child) {
          if (!opts?.create) throw new NotFoundError(dname);
          child = { kind: 'directory', children: new Map() };
          node.children.set(dname, child);
        }
        return makeDirHandle(dname, child);
      },
      async remove(rname, opts) {
        maybeFault('remove');
        const child = node.children.get(rname);
        if (!child) throw new NotFoundError(rname);
        if (child.kind === 'directory' && child.children.size > 0 && !opts?.recursive) {
          throw Object.assign(new Error('目录非空'), { name: 'InvalidModificationError' });
        }
        node.children.delete(rname);
      },
      async list() {
        maybeFault('list');
        return [...node.children.entries()].map(([n, c]) => ({ name: n, kind: c.kind }));
      },
    };
  }

  const base = makeDirHandle('root', root);
  return {
    ...base,
    setFault: (fn) => {
      fault = fn;
    },
    seed: (path, content) => {
      /*
       * 逐级建出父目录。**不能复用 `walk(…, true)`**：那个函数的最后一段是
       * 按**文件**建的（它的用途是 walk 到一个路径），于是 `seed('a/b/c.js')`
       * 会把 `a/b` 里的 `b` 建成文件，再 `asDir` 就拿到 null 并抛「seed 路径
       * 不是目录」。只有父目录**恰好已经存在**时它才工作 —— 也就是说这个坑
       * 只在「先 seed 一个深层文件」时才现形。
       */
      const segs = path.split('/').filter(Boolean);
      const fname = segs.pop()!;
      let cur = root;
      for (const seg of segs) {
        const next = cur.children.get(seg);
        if (next) {
          if (next.kind !== 'directory') throw new Error(`seed 路径不是目录：${path}`);
          cur = next;
          continue;
        }
        const dir: MemDirNode = { kind: 'directory', children: new Map() };
        cur.children.set(seg, dir);
        cur = dir;
      }
      const bytes = typeof content === 'string' ? new TextEncoder().encode(content) : content.slice();
      cur.children.set(fname, { kind: 'file', bytes, mtime: clock++ });
    },
    inspect: (path) => {
      const node = walk(path, false);
      return node && node.kind === 'file' ? node.bytes.slice() : null;
    },
    openWriters: () => writers,
  };
}

/* ------------------------------------------------------------ 原生适配 */

/**
 * 把一个**原生文件句柄**接入 `FsFileHandle`（浏览器 linked 素材用）。
 *
 * 与目录句柄里的 `openFile()` 返回的是同一个包装 —— 两条路必须给出一模一样的
 * 语义（`readBlob()` 零拷贝返回 File），否则「从工程打开的视频」与「引用本地
 * 的视频」在解码器眼里会是两种东西。
 */
export function adoptFileHandle(fh: FileSystemFileHandle): FsFileHandle {
  return wrapNativeFile(fh);
}

function wrapNativeFile(fh: FileSystemFileHandle): FsFileHandle {
  return {
    name: fh.name,
    async get() {
      const f = await fh.getFile();
      return {
        readBytes: async () => new Uint8Array(await f.arrayBuffer()),
        readText: async () => f.text(),
        // 原生 File 是磁盘背书的：stream() 只在小块之间持有字节，
        // readBlob() 直接返回 File 本身（零拷贝，正是视频解码要的形态）。
        readStream: () => f.stream(),
        readBlob: async () => f,
        size: f.size,
        lastModified: f.lastModified,
      };
    },
    async openWrite(opts) {
      const want = { keepExistingData: opts?.keepExistingData ?? false, mode: opts?.mode ?? 'exclusive' };
      try {
        const w = await fh.createWritable(want as never);
        return {
          write: (d) => w.write(d as never),
          close: () => w.close(),
          abort: (r) => w.abort(r),
        };
      } catch (e) {
        // WebIDL 字典的未知成员本应被忽略，但旧版实现有抛 TypeError 的先例。
        // **只认 TypeError 降级**：把「已经有 writer」这类真错误一起吞掉的话，
        // 多标签页并发写就会退化成静默互相覆盖。
        if (!(e instanceof TypeError)) throw e;
        const w = await fh.createWritable({ keepExistingData: want.keepExistingData } as never);
        return {
          write: (d) => w.write(d as never),
          close: () => w.close(),
          abort: (r) => w.abort(r),
        };
      }
    },
  };
}

function wrapNativeDir(dir: FileSystemDirectoryHandle): NativeBackedDir {
  return {
    name: dir.name,
    native: true,
    raw: dir,
    openFile: async (name, opts) => wrapNativeFile(await dir.getFileHandle(name, opts)),
    openDir: async (name, opts) => wrapNativeDir(await dir.getDirectoryHandle(name, opts)),
    remove: (name, opts) => dir.removeEntry(name, opts),
    list: async () => {
      const out: FsEntryInfo[] = [];
      const ex = extras(dir);
      // 优先 values()（少一层数组解构），退化到 entries()。
      // 两个都没有的环境目前不存在，但真遇上时给一句能读的错，
      // 而不是抛「undefined is not a function」。
      if (ex.values) {
        for await (const child of ex.values()) out.push({ name: child.name, kind: child.kind });
        return out;
      }
      if (ex.entries) {
        for await (const [, child] of ex.entries()) out.push({ name: child.name, kind: child.kind });
        return out;
      }
      throw new Error(tr('err.fs.dirNoIterator'));
    },
  };
}

/** OPFS 根。无需授权、无需用户手势 —— E2E 与 dev 用它当真实文件系统。 */
export async function opfsRoot(): Promise<NativeBackedDir> {
  const storage = (navigator as Navigator & {
    storage?: { getDirectory?: () => Promise<FileSystemDirectoryHandle> };
  }).storage;
  if (!storage?.getDirectory) throw new Error('此环境不支持 OPFS（navigator.storage.getDirectory）');
  return wrapNativeDir(await storage.getDirectory());
}

/** 是否具备 FSA 目录选择器（Chrome/Edge 有，Firefox/Safari 没有）。 */
export function hasDirectoryPicker(): boolean {
  return typeof (globalThis as { showDirectoryPicker?: unknown }).showDirectoryPicker === 'function';
}

export interface PickedDir {
  dir: NativeBackedDir;
  /** 原生句柄，交给 `session.ts` 存进 IndexedDB。 */
  raw: FileSystemDirectoryHandle;
}

export interface PickDirOptions {
  mode?: 'read' | 'readwrite';
  /** 同名 id 会让选择器记住上次用的目录，重开时停在原地而不是回到主目录。 */
  id?: string;
  startIn?: unknown;
}

/**
 * 弹系统目录选择器。**必须由用户手势触发**，否则抛 SecurityError。
 *
 * 用户取消时返回 null（`AbortError`），不当异常处理 —— 取消是正常操作，
 * 让它冒到上层会变成一个红框错误提示。
 */
export async function pickDirectory(opts: PickDirOptions = {}): Promise<PickedDir | null> {
  const picker = (globalThis as {
    showDirectoryPicker?: (o?: unknown) => Promise<FileSystemDirectoryHandle>;
  }).showDirectoryPicker;
  if (!picker) throw new Error(tr('err.fs.noDirPicker'));
  try {
    const raw = await picker({ mode: opts.mode ?? 'readwrite', id: opts.id ?? 'artmatic-project', startIn: opts.startIn });
    return { dir: wrapNativeDir(raw), raw };
  } catch (e) {
    if ((e as { name?: string } | null)?.name === 'AbortError') return null;
    throw e;
  }
}

/** 用 IndexedDB 里取回的原生句柄重新包一层。 */
export function adoptNativeDir(raw: unknown): NativeBackedDir {
  return wrapNativeDir(raw as FileSystemDirectoryHandle);
}

export type PermissionStateName = 'granted' | 'denied' | 'prompt';

/** 查权限，不弹窗。非原生目录（memory）一律 granted。 */
export async function queryPermission(dir: FsDirHandle, mode: 'read' | 'readwrite' = 'readwrite'): Promise<PermissionStateName> {
  if (!isNativeBacked(dir)) return 'granted';
  const q = extras(dir.raw as FileSystemDirectoryHandle).queryPermission;
  if (!q) return 'granted';
  return (await q.call(dir.raw, { mode })) as PermissionStateName;
}

/**
 * 申请权限。**只在当前状态是 `prompt` 时才需要用户手势** ——
 * 已经是 granted / denied 时它直接返回，不弹任何东西。
 */
export async function requestPermission(dir: FsDirHandle, mode: 'read' | 'readwrite' = 'readwrite'): Promise<PermissionStateName> {
  if (!isNativeBacked(dir)) return 'granted';
  const r = extras(dir.raw as FileSystemDirectoryHandle).requestPermission;
  if (!r) return 'granted';
  return (await r.call(dir.raw, { mode })) as PermissionStateName;
}
