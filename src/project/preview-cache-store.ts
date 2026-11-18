/**
 * preview-cache-store.ts — 预览渲染缓存的磁盘部分（工程目录里 `cache/preview/`）。
 *
 * 一条铁律：**它是派生物**。打开 / 保存 / 自动保存都不碰它；删掉它只意味着
 * 「下次播放要重新烘」。所以这里的所有失败都必须**静默降级**（返回 null / 0），
 * 不许把「缓存写不进去」升级成「工程打不开」。
 *
 * 索引就是目录本身：每段视频边上一个同名 `.json`。不做单一 `index.json` ——
 * 那个文件损坏 / 落后于真实文件时，表现是「缓存文件在、但永远不命中」，
 * 而且要靠代码去修，而目录扫描永远是对的。
 *
 * 崩溃中途留下的半个文件没有 `.json`，扫描时按孤儿删掉。
 */

import {
  pickEvictions,
  previewMetaName,
  previewVideoName,
  PREVIEW_CACHE_VER,
  type PreviewCacheEntry,
} from '../core/preview-cache';
import { CACHE_DIR, PREVIEW_CACHE_DIR } from '../project/layout';
import { resolveDir, writeBytesAtomic, type FsDirHandle } from '../project/fs';

export class PreviewCacheStore {
  private index = new Map<string, PreviewCacheEntry>();

  private constructor(private readonly dir: FsDirHandle) {}

  /**
   * 打开（不创建）。目录不存在 → `null`，那是最常见的情况（这个工程还没烘过）。
   * 扫描时顺手删孤儿与坏索引 —— 上次崩在中途的产物不该留到下一次。
   */
  static async open(root: FsDirHandle): Promise<PreviewCacheStore | null> {
    let dir: FsDirHandle;
    try {
      dir = await resolveDir(root, [CACHE_DIR, PREVIEW_CACHE_DIR], false);
    } catch {
      return null;
    }
    const store = new PreviewCacheStore(dir);
    await store.scan();
    return store;
  }

  /** 第一次写入时才建目录（打开工程不该因为「开了缓存」就多一个空目录）。 */
  static async ensure(root: FsDirHandle): Promise<PreviewCacheStore> {
    const dir = await resolveDir(root, [CACHE_DIR, PREVIEW_CACHE_DIR], true);
    const store = new PreviewCacheStore(dir);
    await store.scan();
    return store;
  }

  entries(): PreviewCacheEntry[] {
    return [...this.index.values()];
  }

  totalBytes(): number {
    let sum = 0;
    for (const e of this.index.values()) sum += e.bytes;
    return sum;
  }

  get(sig: string, from: number): PreviewCacheEntry | null {
    return this.index.get(keyOf(sig, from)) ?? null;
  }

  async scan(): Promise<void> {
    this.index.clear();
    let names: string[];
    try {
      const list = await this.dir.list();
      names = list.filter((e) => e.kind === 'file').map((e) => e.name);
    } catch {
      return;
    }
    const set = new Set(names);
    const orphans: string[] = [];
    for (const name of names) {
      if (!name.endsWith('.json')) continue;
      const video = name.replace(/\.json$/, '.mp4');
      const entry = await this.readMeta(name);
      if (!entry || entry.ver !== PREVIEW_CACHE_VER || !set.has(video)) {
        orphans.push(name);
        continue;
      }
      this.index.set(keyOf(entry.sig, entry.from), entry);
    }
    // 没有索引条目的视频 = 上次崩在「写完 mp4、还没写 json」之间。
    for (const name of names) {
      if (!name.endsWith('.mp4')) continue;
      const meta = name.replace(/\.mp4$/, '.json');
      if (!set.has(meta)) orphans.push(name);
    }
    for (const name of orphans) {
      try {
        await this.dir.remove(name);
      } catch {
        /* 删不掉就留着，下次再删 */
      }
    }
  }

  private async readMeta(name: string): Promise<PreviewCacheEntry | null> {
    try {
      const file = await this.dir.openFile(name);
      const bytes = await file.get();
      const text = new TextDecoder().decode(await bytes.readBytes());
      const raw = JSON.parse(text) as Partial<PreviewCacheEntry>;
      if (typeof raw.sig !== 'string' || !Number.isFinite(raw.from)) return null;
      return {
        ver: Number(raw.ver ?? 0),
        sig: raw.sig,
        from: Number(raw.from),
        to: Number(raw.to ?? 0),
        fps: Number(raw.fps ?? 0),
        w: Number(raw.w ?? 0),
        h: Number(raw.h ?? 0),
        bytes: Number(raw.bytes ?? 0),
        at: Number(raw.at ?? 0),
      };
    } catch {
      return null;
    }
  }

  /**
   * 写一段。**先写 json 再写 mp4**：反过来的话中途崩掉会留下「索引在、视频是半截」，
   * 那是唯一会让播放吃到坏数据的顺序。这里的顺序保证「索引可见 ⇒ 视频完整」，
   * 代价是崩在两步之间会留下孤儿 mp4 —— 扫描时删掉，没有第二种损失。
   */
  async write(entry: PreviewCacheEntry, bytes: Uint8Array): Promise<void> {
    const video = previewVideoName(entry.sig, entry.from);
    await writeBytesAtomic(this.dir, video, bytes, { verify: false });
    await writeBytesAtomic(this.dir, previewMetaName(entry.sig, entry.from), JSON.stringify(entry), {
      verify: false,
    });
    this.index.set(keyOf(entry.sig, entry.from), { ...entry, bytes: bytes.byteLength });
  }

  /** 读一段视频。`null` = 读不出来（文件被外部删了 / 权限没了）⇒ 当作未命中。 */
  async readBlob(entry: PreviewCacheEntry): Promise<Blob | null> {
    try {
      const file = await this.dir.openFile(previewVideoName(entry.sig, entry.from));
      const f = await file.get();
      if (f.readBlob) return await f.readBlob();
      const raw = await f.readBytes();
      // `Uint8Array<ArrayBufferLike>` 与 `BlobPart` 的 `ArrayBuffer` 不兼容（SharedArrayBuffer），
      // 拷贝到自己的 buffer 里最省事：这一条只在播放前发生一次。
      return new Blob([new Uint8Array(raw).slice().buffer], { type: 'video/mp4' });
    } catch {
      this.index.delete(keyOf(entry.sig, entry.from));
      return null;
    }
  }

  /**
   * 删一条（内容过期时由访问方调用，见 `ui/preview-cache.ts::entryAtFrame`）。
   *
   * 内容是否过期只能按条目各自算签名，太贵，所以 GC 只按几何回收；真正被读到的
   * 时候顺手把过期的那条删掉 —— 代价是一段文件在磁盘上多留一会儿。
   */
  async remove(entry: PreviewCacheEntry): Promise<void> {
    this.index.delete(keyOf(entry.sig, entry.from));
    try {
      await this.dir.remove(previewVideoName(entry.sig, entry.from));
      await this.dir.remove(previewMetaName(entry.sig, entry.from));
    } catch {
      /* 删不掉就留着，下次再删 */
    }
  }

  /**
   * 按预算回收（`core/preview-cache.ts::pickEvictions` 决定删谁）。返回删掉的字节数。
   *
   * `planned` 是当前工程**打算要的**区间：落在它之外的缓存（时间被剪掉了、
   * 或者片段的起止点变了）直接删。内容是否过期**不在这里判** —— 那要按条目
   * 各自算签名，代价太高；过期条目的文件由访问时删、或预算压力淘汰。
   */
  async gc(budgetBytes: number, planned: readonly { from: number; to: number }[]): Promise<number> {
    const { byName } = pickEvictions(this.entries(), budgetBytes, planned);
    let freed = 0;
    for (const name of byName) {
      const entry = [...this.index.values()].find(
        (e) => previewVideoName(e.sig, e.from) === name || previewMetaName(e.sig, e.from) === name,
      );
      try {
        await this.dir.remove(name);
        if (entry && name === previewVideoName(entry.sig, entry.from)) freed += entry.bytes;
      } catch {
        /* 删不掉不算错 */
      }
    }
    if (byName.length) await this.scan();
    return freed;
  }

  /** 一键清空（设置页）。失败静默 —— 用户的下一步是「再点一次」。 */
  async clear(): Promise<void> {
    for (const e of this.entries()) {
      try {
        await this.dir.remove(previewVideoName(e.sig, e.from));
        await this.dir.remove(previewMetaName(e.sig, e.from));
      } catch {
        /* 同上 */
      }
    }
    this.index.clear();
    await this.scan();
  }
}

function keyOf(sig: string, from: number): string {
  return `${sig}-${from}`;
}
