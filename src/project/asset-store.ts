/**
 * asset-store.ts — 运行期素材仓（句柄化）。
 *
 * 存的是**素材的来源**，不是「一律摊开的字节」。对象 URL 那边是
 * `typography/image-assets.ts` 的事，两者职责不同：
 *
 * ```
 * 导入 ──┬─→ assetStore.put(id, bytes)     ← 图片 / 音频（本来就小）
 *        ├─→ assetStore.putFile(id, file)   ← 视频（磁盘背书，一个字节都不读）
 *        └─→ putImageBytes(id, url)         ← 渲染用（snapDOM 要能取到 <img>）
 * ```
 *
 * ## 为什么必须区分来源
 *
 * `platform/types.ts::PickedVideo` 的注释早就写明「只给 `File` 句柄，10 GB 素材
 * 也不会把堆撑爆」。视频解码（mediabunny）本来就是从 `Blob` seek 读的，所以
 * 把整份字节读进 `Uint8Array` **没有任何一处消费方需要**，唯一的作用是
 * 「打开 2 GB 视频工程 = 2 GB JS 堆」。
 *
 * ```
 * type AssetSource =
 *   | { kind: 'file';   file: File }            // 本地导入，磁盘背书
 *   | { kind: 'handle'; handle: FsFileHandle }  // 从工程目录读回（视频）
 *   | { kind: 'bytes';  bytes: Uint8Array }     // 图片 / 音频（保存时要写出）
 *   | { kind: 'none' }                          // generated（程序生成，不落盘）
 * ```
 *
 * ## 两条纪律
 *
 * 1. **`bytesOf()` 只返回「已经在内存里」的字节**，绝不为了它去读盘 ——
 *    调用方（排版置图）本来就是同步 API，异步那条路走 `readAll()`。
 * 2. **字节是只读的**：`put()` 整体替换而不是原地改。哈希缓存的键就是那个
 *    source 对象引用，原地改会算出旧哈希。这条不是洁癖 —— 它是增量哈希能
 *    成立的前提。
 *
 * ## 视频不算哈希（刻意的降级）
 *
 * `crypto.subtle.digest` **不能流式**（见 `hash.ts` 的 `MAX_HASH_BYTES`），
 * 所以给 200 MB 视频算哈希的唯一办法是先把它整份读进堆 —— 那正是这一轮要
 * 消灭的动作。于是 video 的 `hash` 恒为 `null`，台账退化成「大小」弱指纹；
 * 而代价换来的是一条硬保证：**没变的视频素材，打开与保存都零读取**。
 * 外部改过的视频只能靠大小发现（`auditLedger` 会把它标成 `unhashed`）。
 */
import {
  contentOfBlob,
  contentOfBytes,
  contentOfHandle,
  isStrongFp,
  type AssetContent,
} from './fingerprint';
import { assetRelPath } from './layout';
import {
  createLedger,
  localPath,
  projectPath,
  type AssetEntry,
  type AssetLedger,
  type AssetLocation,
  type AssetMode,
} from './ledger';
import { openAssetFile } from './io';
import { contentOfPath } from './fingerprint';
import type { FsDirHandle, FsFileHandle } from './fs';
import type { Project } from '../core/schema';

/**
 * 桌面版 linked 的按范围读取。由 `main.ts` 在装配时注入（`platform.readPath`）。
 *
 * 注入而不是直接 import platform：`project/` 不该知道宿主是谁；单测也不需要
 * 一个 Electron 才能测保存路径。
 */
export type AssetPathReader = (path: string, start: number, end: number) => Promise<Uint8Array>;

let pathReader: AssetPathReader | null = null;

export function setAssetPathReader(reader: AssetPathReader | null): void {
  pathReader = reader;
}

/** 视频解码器要的「路径来源」载体（结构上与 `engine/media-assets.ts` 的同名类型一致）。 */
export interface PathVideoMedia {
  kind: 'path';
  path: string;
  size: number;
  read(start: number, end: number): Promise<Uint8Array>;
}

export interface AssetInput {
  kind: 'audio' | 'image' | 'video' | 'lut';
  /** 展示名，会写进 `Project.assets[id].name`。 */
  name: string;
  /** 原始文件名。**决定落盘的扩展名**，所以别拿展示名代替它。 */
  originName: string;
  mode?: AssetMode;
}

/** 素材来源。见文件头。 */
export type AssetSource =
  | { kind: 'file'; file: File }
  | { kind: 'handle'; handle: FsFileHandle; size: number }
  | { kind: 'bytes'; bytes: Uint8Array }
  /** 桌面版 linked：本机绝对路径（读取走 platform 的 readRange）。 */
  | { kind: 'path'; path: string; size: number }
  | { kind: 'none' };

interface Item {
  input: AssetInput;
  source: AssetSource;
  addedAt: number;
  /**
   * 来源文件的修改时间（毫秒）；未知 = null。
   *
   * 只有「手上本来就有 `File`」的那条路（浏览器导入）知道它 —— 视频打开工程后
   * 走句柄，取 mtime 要异步 `get()`，为了一份排序去 stat 每个素材不值。
   * 消费方（媒体池排序）在 null 时回退到 `addedAt`。
   */
  mtime: number | null;
  /**
   * 从台账读回来的原始条目。视频/保留项的 `hash` 与 `bytes` 靠它保留 ——
   * 否则一次保存就会把历史上算好的哈希抹成 null，`diffLedger` 会误判成 changed。
   */
  entry: AssetEntry | null;
  /** 内容身份（sampling fingerprint）。null = 还没算（旧台账 / 从未落盘）。 */
  content: AssetContent | null;
  /** 本机原文件位置（桌面版 linked）。浏览器 linked 用句柄，这里是句柄键。 */
  local: string | null;
}

/** 「已从工程移除、但字节文件还在」的条目。 */
interface RetainedItem {
  input: AssetInput;
  source: AssetSource;
  addedAt: number;
  mtime: number | null;
  entry: AssetEntry | null;
  content: AssetContent | null;
  local: string | null;
}

/** 台账里有、仓里没有（打开工程时文件读不出来）。 */
export interface LoadReport {
  loaded: number;
  missing: string[];
}

export class AssetStore {
  private items = new Map<string, Item>();
  /**
   * 已移除但保留字节文件的素材。**不在 `items` 里** —— 它们不参与渲染、
   * 不进口媒体池，只在台账里以 `retained: true` 存在，并出现在「未使用素材」里。
   */
  private retained = new Map<string, RetainedItem>();
  /**
   * 曾经真正写进工程目录 `assets/` 的 id。
   *
   * 存在的唯一理由：**「移除」只在有文件可保留时才保留**。刚导入、还没保存过的
   * 素材如果也进保留区，下一次保存会把它凭空写进 `assets/` —— 用户明明删掉了它，
   * 磁盘上却多出一份（正是「反复换素材来源制造垃圾」的一半来源）。
   */
  private persisted = new Set<string>();
  /** 源文件在本次会话里被改过（只标 stale，不自动换内容）。 */
  private stale = new Set<string>();

  /* ------------------------------------------------------------ 登记 */

  /** 登记一份**已在内存里**的字节（图片 / 音频）。 */
  put(id: string, bytes: Uint8Array, input: AssetInput, content?: AssetContent | null): void {
    const prev = this.items.get(id);
    this.items.set(id, {
      input: { ...input, mode: input.mode ?? 'bundled' },
      source: { kind: 'bytes', bytes },
      addedAt: prev?.addedAt ?? Date.now(),
      mtime: prev?.mtime ?? null,
      entry: prev?.entry ?? null,
      content: content ?? prev?.content ?? null,
      local: prev?.local ?? null,
    });
    this.retained.delete(id);
  }

  /**
   * 登记一份**本地文件**（视频）：一个字节都不读。
   *
   * `File` 是磁盘背书的句柄，保存时按块流式写、解码时按 seek 读。
   */
  putFile(id: string, file: File, input: AssetInput, content?: AssetContent | null): void {
    const prev = this.items.get(id);
    this.items.set(id, {
      input: { ...input, mode: input.mode ?? 'bundled' },
      source: { kind: 'file', file },
      addedAt: prev?.addedAt ?? Date.now(),
      mtime: file.lastModified || (prev?.mtime ?? null),
      entry: prev?.entry ?? null,
      content: content ?? prev?.content ?? null,
      local: prev?.local ?? null,
    });
    this.retained.delete(id);
  }

  /**
   * 登记一份**本机绝对路径**（桌面版 linked）：一个字节都不读。
   *
   * 浏览器没有真实路径，这条只给 `platform/electron.ts` 用；图片/音频的
   * 字节由 platform 的 `readRange` 按需取。
   */
  putPath(id: string, path: string, size: number, input: AssetInput, content?: AssetContent | null): void {
    const prev = this.items.get(id);
    this.items.set(id, {
      input: { ...input, mode: input.mode ?? 'linked' },
      source: { kind: 'path', path, size },
      addedAt: prev?.addedAt ?? Date.now(),
      mtime: prev?.mtime ?? null,
      entry: prev?.entry ?? null,
      content: content ?? prev?.content ?? null,
      local: path,
    });
    this.retained.delete(id);
  }

  /**
   * 登记一份**浏览器 linked 素材**（视频）：来源是文件句柄，零读取。
   *
   * `local` 记成 `fsa:<assetId>` —— 浏览器不暴露真实路径，句柄本体存在
   * IndexedDB（`asset-handles.ts`），台账里这个键只是「这条素材有一份本地引用」。
   */
  putLinkedHandle(
    id: string,
    handle: FsFileHandle,
    size: number,
    input: AssetInput,
    content?: AssetContent | null,
  ): void {
    const prev = this.items.get(id);
    this.items.set(id, {
      input: { ...input, mode: 'linked' },
      source: { kind: 'handle', handle, size },
      addedAt: prev?.addedAt ?? Date.now(),
      mtime: prev?.mtime ?? null,
      entry: prev?.entry ?? null,
      content: content ?? prev?.content ?? null,
      local: `fsa:${id}`,
    });
    this.retained.delete(id);
  }

  /** 桌面版 linked 图片 / 音频：字节在内存里（要喂解码器），本地位置是绝对路径。 */
  putLinkedBytesAt(
    id: string,
    bytes: Uint8Array,
    path: string,
    input: AssetInput,
    content?: AssetContent | null,
  ): void {
    const prev = this.items.get(id);
    this.items.set(id, {
      input: { ...input, mode: 'linked' },
      source: { kind: 'bytes', bytes },
      addedAt: prev?.addedAt ?? Date.now(),
      mtime: prev?.mtime ?? null,
      entry: prev?.entry ?? null,
      content: content ?? prev?.content ?? null,
      local: path,
    });
    this.retained.delete(id);
  }

  /** 登记一份浏览器 linked 素材（图片 / 音频）：字节在内存里，本地位置另有句柄。 */
  putLinkedBytes(id: string, bytes: Uint8Array, input: AssetInput, content?: AssetContent | null): void {
    const prev = this.items.get(id);
    this.items.set(id, {
      input: { ...input, mode: 'linked' },
      source: { kind: 'bytes', bytes },
      addedAt: prev?.addedAt ?? Date.now(),
      mtime: prev?.mtime ?? null,
      entry: prev?.entry ?? null,
      content: content ?? prev?.content ?? null,
      local: `fsa:${id}`,
    });
    this.retained.delete(id);
  }

  /** 打开工程时把 IndexedDB 里的句柄接回素材（不读字节；图片/音频由 hydrate 读）。 */
  attachLocalHandle(id: string, handle: FsFileHandle, size: number): void {
    const item = this.items.get(id);
    if (!item) return;
    item.source = item.input.kind === 'video' ? { kind: 'handle', handle, size } : item.source;
  }

  /** 打开工程时把本机绝对路径接回素材（桌面版 linked，不读字节）。 */
  attachLocalPath(id: string, path: string, size: number): void {
    const item = this.items.get(id);
    if (!item) return;
    item.source = { kind: 'path', path, size };
    item.local = path;
  }

  /** linked 条目但本地来源没接上（句柄丢了 / 没授权）—— 不等于「工程里没有这条」。 */
  isUnavailable(id: string): boolean {
    const it = this.items.get(id);
    return !!it && it.input.mode === 'linked' && it.source.kind === 'none';
  }

  localOf(id: string): string | null {
    return this.items.get(id)?.local ?? this.retained.get(id)?.local ?? null;
  }

  modeOf(id: string): AssetMode | null {
    const it = this.items.get(id) ?? this.retained.get(id);
    return it ? (it.input.mode ?? (it.local ? 'linked' : 'bundled')) : null;
  }

  /** 收集到工程：下一次保存写一份工程副本（本地位置保留）。 */
  markBundled(id: string): boolean {
    const item = this.items.get(id);
    if (!item) return false;
    item.input = { ...item.input, mode: 'bundled' };
    return true;
  }

  /** 登记一份**工程目录里的文件句柄**（打开工程时用，同样不读字节）。 */
  putHandle(
    id: string,
    handle: FsFileHandle,
    size: number,
    input: AssetInput,
    entry?: AssetEntry,
    content?: AssetContent | null,
  ): void {
    const prev = this.items.get(id);
    this.items.set(id, {
      input: { ...input, mode: input.mode ?? 'bundled' },
      source: { kind: 'handle', handle, size },
      addedAt: prev?.addedAt ?? entry?.addedAt ?? Date.now(),
      mtime: prev?.mtime ?? null,
      entry: entry ?? prev?.entry ?? null,
      content: content ?? prev?.content ?? null,
      local: prev?.local ?? (entry ? localPath(entry) : null),
    });
    this.retained.delete(id);
  }

  /**
   * 登记一份「由代码确定性生成、无需落盘」的素材。
   * 演示工程的节拍音频走这条：它是几行代码算出来的，存进 `assets/` 反而
   * 让工程目录带着一份可以随时重建的字节。
   */
  putGenerated(id: string, input: AssetInput): void {
    const prev = this.items.get(id);
    this.items.set(id, {
      input: { ...input, mode: 'generated' },
      source: { kind: 'none' },
      addedAt: prev?.addedAt ?? Date.now(),
      mtime: prev?.mtime ?? null,
      entry: prev?.entry ?? null,
      content: null,
      local: null,
    });
    this.retained.delete(id);
  }

  /* ------------------------------------------------------------ 查询 */

  has(id: string): boolean {
    return this.items.has(id);
  }

  input(id: string): AssetInput | null {
    return this.items.get(id)?.input ?? null;
  }

  /**
   * 改**展示名**（只动仓里的镜像）。
   *
   * 工程表那一份由 `ProjectStore.renameAsset` 写；这里跟着改一份是为了让
   * 「未使用素材」列表与「源已变化」提示不出现旧名字。`originName` 一个字都不动
   * —— 它决定落盘文件名与扩展名。
   */
  setInputName(id: string, name: string): boolean {
    const item = this.items.get(id) ?? this.retained.get(id);
    if (!item || !name) return false;
    item.input = { ...item.input, name };
    return true;
  }

  /** 导入时的原始文件名（媒体池搜索要匹配它，展示名可能已被改过）。 */
  originName(id: string): string | null {
    return (this.items.get(id) ?? this.retained.get(id))?.input.originName ?? null;
  }

  /** 首次导入时间（毫秒）；没有这条记录时 null。 */
  addedAt(id: string): number | null {
    const it = this.items.get(id) ?? this.retained.get(id);
    return it ? it.addedAt : null;
  }

  /** 来源文件修改时间（毫秒）；未知 = null（打开工程后走句柄的那一类）。 */
  modifiedAt(id: string): number | null {
    return (this.items.get(id) ?? this.retained.get(id))?.mtime ?? null;
  }

  /** 素材的字节数。none / 未知返回 null。**不读盘**。 */
  size(id: string): number | null {
    return sizeOf(this.items.get(id)?.source ?? null);
  }

  /**
   * **已经在内存里**的字节；没有就返回 null。
   *
   * 刻意不读盘：图片/音频从工程打开时本来就是 bytes 来源，而视频的字节
   * 不该为了同步 API 被整份读回来（`readAll` / `open` 才是异步那条路）。
   */
  bytesOf(id: string): Uint8Array | null {
    const src = this.items.get(id)?.source;
    return src?.kind === 'bytes' ? src.bytes : null;
  }

  /** 内容身份（可能为 null：还没算 / generated）。 */
  contentOf(id: string): AssetContent | null {
    return this.items.get(id)?.content ?? this.retained.get(id)?.content ?? null;
  }

  /**
   * 按内容指纹找同一条素材（去重）。只认 `fp1:` —— `fp0:` 是弱指纹，
   * 拿它去重会把两个同大小的不同文件合并成一条。
   *
   * 同时搜活动素材与「未使用素材」：后者被重新导入时应当**复活**而不是
   * 再存一份。
   */
  findByFp(fp: string | null | undefined): string | null {
    if (!isStrongFp(fp)) return null;
    for (const [id, it] of this.items) if (it.content?.fp === fp) return id;
    for (const [id, it] of this.retained) if (it.content?.fp === fp) return id;
    return null;
  }

  isRetained(id: string): boolean {
    return this.retained.has(id);
  }

  /** 把「未使用素材」放回活动素材（不读盘、不重建来源）。 */
  activate(id: string): boolean {
    const r = this.retained.get(id);
    if (!r) return false;
    this.retained.delete(id);
    this.items.set(id, {
      input: r.input,
      source: r.source,
      addedAt: r.addedAt,
      mtime: r.mtime,
      entry: r.entry,
      content: r.content,
      local: r.local,
    });
    return true;
  }

  /**
   * 记录「这些 id 的字节确实在工程目录里」。
   *
   * 由保存成功之后调用（`SaveReport.persistedAssets`），不是由 `buildLedger`
   * 顺手标记 —— 台账里有一条不代表文件写成功了（`openFor` 可能返回 null）。
   */
  markPersisted(ids: readonly string[]): void {
    for (const id of ids) this.persisted.add(id);
  }

  isPersisted(id: string): boolean {
    return this.persisted.has(id);
  }

  /** 源文件变了：只记一个标记，**不**自动重新读内容（确定性优先）。 */
  markStale(id: string): void {
    this.stale.add(id);
  }

  clearStale(id: string): void {
    this.stale.delete(id);
  }

  isStale(id: string): boolean {
    return this.stale.has(id);
  }

  remove(id: string): void {
    this.items.delete(id);
    this.retained.delete(id);
    this.persisted.delete(id);
  }

  clear(): void {
    this.items.clear();
    this.retained.clear();
    this.persisted.clear();
  }

  ids(): string[] {
    return [...this.items.keys()];
  }

  /** 磁盘占用估算（generated 不计；已移除的保留项不计）。 */
  totalBytes(): number {
    let n = 0;
    for (const it of this.items.values()) n += sizeOf(it.source) ?? 0;
    return n;
  }

  /* ------------------------------------------------------------ 读 */

  /**
   * 分块读。保存时全程走这条 —— 2 GB 素材的内存峰值只有一块的大小。
   *
   * 返回 null = 没有可用来源（generated / 已丢失）。
   */
  open(id: string): AsyncIterable<Uint8Array> | null {
    const src = this.items.get(id)?.source;
    if (!src || src.kind === 'none') return null;
    // path 依赖注入的 readRange；注入之前返回 null（保存会记警告，而不是写 0 字节）。
    if (src.kind === 'path') return pathReader ? chunksOfPath(src.path, src.size, pathReader) : null;
    return chunksOf(src);
  }

  /** 一次性读全（只给已知小体量用：图片喂 `createImageBitmap`、音频喂 `decodeAudioData`）。 */
  async readAll(id: string): Promise<Uint8Array | null> {
    const item = this.items.get(id);
    if (!item) return null;
    if (item.source.kind === 'bytes') return item.source.bytes;
    if (item.source.kind === 'path') {
      if (!pathReader) return null;
      return readAllOfPath(item.source.path, item.source.size, pathReader);
    }
    return readAllOf(item.source);
  }

  /**
   * 视频解码器要的载体：`Blob`（本地文件 / 工程目录里的文件）或内存字节。
   *
   * 原生 `File` 本身就是 `Blob`，所以本地导入这条路零拷贝。
   */
  async openVideo(id: string): Promise<Blob | Uint8Array | PathVideoMedia | null> {
    const src = this.items.get(id)?.source;
    if (!src || src.kind === 'none') return null;
    if (src.kind === 'path') {
      if (!pathReader) return null;
      const reader = pathReader;
      return {
        kind: 'path',
        path: src.path,
        size: src.size,
        read: (start, end) => reader(src.path, start, end),
      };
    }
    if (src.kind === 'bytes') return src.bytes;
    if (src.kind === 'file') return src.file;
    const file = await src.handle.get();
    if (file.readBlob) return file.readBlob();
    return file.readBytes();
  }

  /* -------------------------------------------------------- 移除 / 保留 */

  /**
   * 解除关联：从活动素材里挪到「保留」区。
   *
   * 字节来源与哈希缓存都留着 —— 同一会话里「恢复」不需要重新读盘，
   * 保存时也不会因为重新构造条目而丢掉哈希。
   */
  retire(id: string): boolean {
    const item = this.items.get(id);
    if (!item) return false;
    /*
     * 从未落盘 = `assets/` 里没有可恢复的文件。这时「保留」只会让下一次保存
     * 把它凭空写出来（用户已经删了它）。直接丢弃，返回 false 让 UI 知道
     * 「没有进未使用素材」。
     */
    if (!this.persisted.has(id)) {
      this.remove(id);
      return false;
    }
    this.items.delete(id);
    this.retained.set(id, {
      input: item.input,
      source: item.source,
      addedAt: item.addedAt,
      mtime: item.mtime,
      entry: item.entry,
      content: item.content,
      local: item.local,
    });
    return true;
  }

  /**
   * 把保留项恢复成活动素材。
   *
   * 图片/音频若是从台账读回的 `handle` 来源，这里**把它重新读成 bytes** ——
   * 排版置图走的是同步的 `bytesOf()`，恢复之后那条路必须立刻可用。
   * 视频保持句柄（一个字节都不读）。
   */
  async restore(id: string): Promise<boolean> {
    const r = this.retained.get(id);
    if (!r) return false;
    let source = r.source;
    if (source.kind === 'handle' && r.input.kind !== 'video') {
      // 读不出来就保留句柄来源：条目仍然恢复，只是画面会走「脱机媒体」，
      // 比「什么都没恢复、还把保留项弄丢了」好。
      const bytes = await readAllOf(source).catch(() => null);
      if (bytes) source = { kind: 'bytes', bytes };
    }
    this.retained.delete(id);
    this.items.set(id, {
      input: r.input,
      source,
      addedAt: r.addedAt,
      mtime: r.mtime,
      entry: r.entry,
      content: r.content,
      local: r.local,
    });
    return true;
  }

  retainedIds(): string[] {
    return [...this.retained.keys()];
  }

  retainedInput(id: string): AssetInput | null {
    return this.retained.get(id)?.input ?? null;
  }

  retainedSize(id: string): number | null {
    const r = this.retained.get(id);
    if (!r) return null;
    const seen = r.entry?.content?.size ?? null;
    return sizeOf(r.source) ?? seen;
  }

  /* ------------------------------------------------------------ 台账 */

  /**
   * 构建完整台账（v3：content + locations）。
   *
   * 身份是**增量的**：来源对象没换就复用 `item.content`。首次给一个素材算
   * 身份只读 128 KiB（采样指纹），不是旧版那种整份 sha256 —— 视频也不会因此
   * 变成「保存前先读一遍」。
   */
  async buildLedger(): Promise<AssetLedger> {
    const ledger = createLedger();
    for (const [id, item] of this.items) {
      // 旧台账 / 直接 `put()` 进来的字节可能还没有身份：保存前补一次（读 128 KiB）。
      if (!item.content) item.content = await this.contentFor(item.source);
      ledger.entries[id] = this.entryFor(id, item, false);
    }
    for (const [id, r] of this.retained) {
      if (!r.content) r.content = await this.contentFor(r.source);
      ledger.entries[id] = this.entryFor(id, r, true);
    }
    return ledger;
  }

  /** 按来源算内容身份；generated / 丢失返回 null。 */
  private async contentFor(source: AssetSource): Promise<AssetContent | null> {
    if (source.kind === 'bytes') return contentOfBytes(source.bytes);
    if (source.kind === 'file') return contentOfBlob(source.file);
    if (source.kind === 'handle') return contentOfHandle(source.handle);
    if (source.kind === 'path' && pathReader) {
      const reader = pathReader;
      return contentOfPath(source.size, (start, end) => reader(source.path, start, end));
    }
    return null;
  }

  private entryFor(id: string, item: Item | RetainedItem, retained: boolean): AssetEntry {
    const mode = item.input.mode ?? (item.local ? 'linked' : 'bundled');
    const prevProject = item.entry ? projectPath(item.entry) : null;
    const prevLocal = item.entry ? localPath(item.entry) : null;
    const local = item.local ?? prevLocal;

    const locations: AssetLocation[] = [];
    if (mode !== 'generated') {
      if (local) {
        locations.push({
          kind: 'local',
          path: local,
          seen: { size: item.content?.size ?? null, fp: item.content?.fp ?? null, mtime: null },
        });
      }
      /*
       * 工程副本只在两种情况下存在：
       *  - bundled（默认就要有一份）；
       *  - 之前 collect 过（`prevProject`），即使现在 mode 是 linked。
       * linked-only 的素材不凭空造一条 project 位置 —— 那会让保存去写文件。
       */
      if (mode === 'bundled' || prevProject) {
        locations.push({
          kind: 'project',
          path: prevProject ?? assetRelPath(id, item.input.originName),
          seen: { size: item.content?.size ?? null, fp: item.content?.fp ?? null, mtime: null },
        });
      }
    }

    const entry: AssetEntry = {
      id,
      kind: item.input.kind,
      originName: item.input.originName,
      mode,
      addedAt: item.addedAt,
      content: item.content,
      locations,
    };
    if (retained) entry.retained = true;
    return entry;
  }

  /**
   * 从磁盘台账把素材登记回来（打开工程时调）。
   *
   * **视频与保留项只开句柄、不读字节**；图片/音频整份读回（它们本来就是
   * 喂 `createImageBitmap` / `decodeAudioData` 的，且没有第二种消费方式）。
   *
   * 磁盘上的哈希直接灌进缓存，省掉一次「读一遍再算一遍」——
   * 打开工程时 `auditLedger` 刚刚算过同一个哈希（若它真的算过）。
   */
  async loadFrom(dir: FsDirHandle, ledger: AssetLedger, project?: Project): Promise<LoadReport> {
    const missing: string[] = [];
    let loaded = 0;
    for (const entry of Object.values(ledger.entries)) {
      const declared = project?.assets[entry.id];
      const input: AssetInput = {
        kind: entry.kind,
        name: declared?.name ?? entry.originName,
        originName: entry.originName,
        mode: entry.mode,
      };
      if (entry.mode === 'generated') {
        this.putGenerated(entry.id, input);
        loaded++;
        continue;
      }

      const local = localPath(entry);
      const handle = await openAssetFile(dir, entry).catch(() => null);
      // v3 台账里的身份直接可用；v2 迁移过来的为 null，下面按需补算。
      const known = entry.content;

      if (entry.retained) {
        // 保留项：文件不在也不报错（它本来就不再被工程引用）。
        const source: AssetSource = handle
          ? { kind: 'handle', handle, size: known?.size ?? 0 }
          : { kind: 'none' };
        // 文件在 = 曾经落过盘，可以进「未使用素材」；文件不在的保留项只是台账残留。
        if (handle) this.persisted.add(entry.id);
        const content = known ?? (handle ? await contentOfHandle(handle).catch(() => null) : null);
        this.retained.set(entry.id, {
          input,
          source,
          addedAt: entry.addedAt,
          // 句柄的 lastModified 是异步的；排序回退到 addedAt（见 Item.mtime）。
          mtime: null,
          entry,
          content,
          local,
        });
        loaded++;
        continue;
      }

      if (!handle) {
        /*
         * 没有工程副本不一定等于「素材丢了」：linked-only 的条目本来就只有
         * 本地位置（由 platform 接上）。只有**一个位置都没有**才算 missing。
         */
        if (local) {
          this.items.set(entry.id, {
            input,
            source: { kind: 'none' },
            addedAt: entry.addedAt,
            mtime: null,
            entry,
            content: known,
            local,
          });
          loaded++;
        } else {
          missing.push(entry.id);
        }
        continue;
      }

      if (entry.kind === 'video') {
        /*
         * `content.size` 缺失（旧台账 / 重建出来的）时补一次元数据 ——
         * `getFile()` 只读 stat，不是 `readBytes()`。否则素材池会显示「0 字节」。
         */
        let size = known?.size ?? 0;
        if (!size) {
          try {
            size = (await handle.get()).size;
          } catch {
            size = 0;
          }
        }
        const content = known ?? (await contentOfHandle(handle).catch(() => null));
        this.persisted.add(entry.id);
        this.putHandle(entry.id, handle, size, input, entry, content);
      } else {
        const bytes = await (await handle.get()).readBytes();
        const source: AssetSource = { kind: 'bytes', bytes };
        const content = known ?? (await contentOfBytes(bytes));
        this.persisted.add(entry.id);
        this.items.set(entry.id, {
          input,
          source,
          addedAt: entry.addedAt,
          mtime: null,
          entry,
          content,
          local,
        });
      }
      loaded++;
    }
    return { loaded, missing };
  }

  /** 台账里有、仓里没有的 id（保存前提示用，正常情况下应为空）。 */
  missingFromMemory(ledger: AssetLedger): string[] {
    const out: string[] = [];
    for (const [id, e] of Object.entries(ledger.entries)) {
      if (e.mode === 'generated' || e.retained) continue;
      const it = this.items.get(id);
      if (!it || it.source.kind === 'none') out.push(id);
    }
    return out;
  }
}

/* ------------------------------------------------------------ 来源工具 */

function sizeOf(src: AssetSource | null): number | null {
  if (!src) return null;
  if (src.kind === 'bytes') return src.bytes.byteLength;
  if (src.kind === 'file') return src.file.size;
  if (src.kind === 'handle') return src.size || null;
  if (src.kind === 'path') return src.size || null;
  return null;
}

async function* chunksOf(src: AssetSource): AsyncGenerator<Uint8Array> {
  if (src.kind === 'bytes') {
    if (src.bytes.byteLength) yield src.bytes;
    return;
  }
  if (src.kind === 'file') {
    yield* streamChunks(src.file.stream());
    return;
  }
  if (src.kind === 'handle') {
    const file = await src.handle.get();
    if (file.readStream) {
      yield* streamChunks(file.readStream());
      return;
    }
    const bytes = await file.readBytes();
    if (bytes.byteLength) yield bytes;
    return;
  }
  /*
   * `path` 来源由 platform 的 `readRange` 提供字节。
   * 在内核还拿不到那条能力时**什么都不产出** —— 绝不能返回空字节让
   * `writeStreamAtomic` 把工程副本写成 0 字节（那会静默毁掉一份素材）。
   */
  if (src.kind === 'path') return;
}

/** 4 MiB：一块的大小，也是保存时峰值内存的上限（与 `writeStreamAtomic` 的缓冲同一量级）。 */
const PATH_CHUNK = 4 * 1024 * 1024;

async function* chunksOfPath(
  path: string,
  size: number,
  read: AssetPathReader,
): AsyncGenerator<Uint8Array> {
  for (let offset = 0; offset < size; offset += PATH_CHUNK) {
    const end = Math.min(offset + PATH_CHUNK, size);
    const chunk = await read(path, offset, end);
    if (chunk.byteLength) yield chunk;
  }
}

async function readAllOfPath(
  path: string,
  size: number,
  read: AssetPathReader,
): Promise<Uint8Array> {
  const out = new Uint8Array(size);
  let offset = 0;
  for await (const chunk of chunksOfPath(path, size, read)) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return offset === size ? out : out.subarray(0, offset);
}

/** `ReadableStream` → 异步迭代。不依赖 `DOM.AsyncIterable` 的 lib 版本。 */
async function* streamChunks(stream: ReadableStream<Uint8Array>): AsyncGenerator<Uint8Array> {
  const reader = stream.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return;
      if (value?.byteLength) yield value;
    }
  } finally {
    reader.releaseLock();
  }
}

async function readAllOf(src: AssetSource): Promise<Uint8Array | null> {
  if (src.kind === 'bytes') return src.bytes;
  if (src.kind === 'file') return new Uint8Array(await src.file.arrayBuffer());
  if (src.kind === 'handle') {
    const file = await src.handle.get();
    return file.readBytes();
  }
  // 同 `chunksOf`：path 的读取在 platform，这里不假装读到了空字节。
  return null;
}

/** 仅供测试与诊断：这条来源是不是「不读字节」的那一类。 */
export function isLazySource(src: AssetSource): boolean {
  return src.kind === 'file' || src.kind === 'handle' || src.kind === 'path';
}

/**
 * 造一个素材仓。
 *
 * **不是单例。** 一个网页里可以同时打开多个工程，每个工程有自己的素材表 ——
 * 共用一份的话，保存 A 工程会把 B 工程导入的素材一起写进 A 的 `assets/`，
 * 而台账里会凭空多出几条不属于它的记录。所以按工程实例化。
 *
 * 取当前激活那个的入口是 `appState.assets`。
 */
export function createAssetStore(): AssetStore {
  return new AssetStore();
}
