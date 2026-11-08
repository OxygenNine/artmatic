/**
 * io.ts — 保存 / 打开编排。
 *
 * ## 写入顺序是安全性的全部
 *
 * 两个文件（`project.json` / `assets.json`）加一个目录（`assets/`）没法做成
 * 一次原子提交 —— 没有事务。所以只能选「崩在哪一步损失最小」：
 *
 * ```
 * ① 新增/变化的素材字节 → assets/
 * ② assets.json
 * ③ project.json（原子 + .bak）
 * ```
 *
 * 逐步崩的后果：
 *
 * | 崩在 | 磁盘状态 | 后果 |
 * |---|---|---|
 * | ① 后 ② 前 | assets/ 里多几个文件 | **无害**（台账没记，下次当成孤儿素材报告） |
 * | ② 后 ③ 前 | 台账新、工程旧 | **无害**（旧工程引用的素材都还在） |
 *
 * ## 保存**不删**素材文件
 *
 * 早期版本在 ③ 之后还有一段「删掉台账里消失的素材」（原 ④）。它消灭了
 * 「点保存顺手销毁源文件」的下半段风险，却引入了更坏的形态：一次误删 +
 * 一次保存 = **素材永久消失**，而且磁盘上没有第二个副本。
 *
 * 现在删除只剩「从 `Project.assets` 里移除」这一层语义：文件留在 `assets/`，
 * 变成孤儿。打开工程时它们会被聚合成一条提示（见 `openProject`），
 * 清理入口留给后续版本（进回收站目录，而不是直接 `remove`）。
 *
 * 代价是工程目录会攒孤儿文件 —— 这是**预期状态**，不是残留。
 *
 * ## project.json 里不写 savedAt
 *
 * 写进去会让「内容没变 → 字节没变」失效：每次保存都生成不同的文件，
 * git diff 永远有噪声，也没法用「序列化结果相同就跳过写入」来省一次磁盘操作。
 * 保存时间属于会话状态（在 `session.ts` 里），不属于工程内容。
 */

import {
  ensureDirs,
  exists,
  isNotFound,
  readTextIfExists,
  resolveDir,
  writeBytesAtomic,
  writeStreamAtomic,
  type FsDirHandle,
  type FsFileHandle,
} from './fs';
import { contentOfBlob } from './fingerprint';
import { tr } from '../i18n/index.svelte';
import {
  ASSET_LEDGER_FILE,
  ASSET_TRASH_DIR,
  PROJECT_BACKUP,
  PROJECT_DIRS,
  PROJECT_FILE,
  ASSETS_DIR,
  assetRelPath,
  isTrashPath,
  splitRelPath,
  trashPathSegments,
} from './layout';
import {
  auditLedger,
  createLedger,
  detectPathConflicts,
  diffLedger,
  parseLedger,
  projectPath,
  relinkPaths,
  serializeLedger,
  type AssetEntry,
  type AssetIssue,
  type AssetLedger,
} from './ledger';
import { migrateProject, type Project } from '../core/schema';
import { readSessionFile, type ProjectSession } from './session';
import { formatBytes } from '../core/format';

/** 目录里没有 `project.json` —— 打开时用它给用户一句能看懂的话。 */
export class NotAProjectError extends Error {
  constructor(name: string) {
    super(tr('err.io.notAProject', { name, file: PROJECT_FILE }));
    this.name = 'NotAProjectError';
  }
}

export async function isProjectDir(dir: FsDirHandle): Promise<boolean> {
  return exists(dir, PROJECT_FILE, 'file');
}

/* ------------------------------------------------------------ 保存 */

export interface SaveInput {
  dir: FsDirHandle;
  project: Project;
  ledger: AssetLedger;
  /**
   * 分块读素材；null = 没有可用来源（generated，或素材已丢失）。
   *
   * 素材仓把视频存成 `File` / 句柄，所以这里必须是**流**而不是
   * 整份 `Uint8Array` —— 2 GB 视频的保存峰值从此只有一块的大小。
   */
  openFor: (assetId: string) => AsyncIterable<Uint8Array> | null;
  /**
   * 是否轮转 `project.json.bak`。默认 true。
   *
   * 自动保存传 false：`.bak` 只在手动保存时写，否则它变成「两秒前」，
   * 失去「上一版手动保存」的兜底意义（三条硬约定之一）。
   */
  backup?: boolean;
}

export interface SaveReport {
  project: { bytes: number; verified: 'hash' | 'size' | 'none'; backup: string | null };
  ledgerBytes: number;
  assetsWritten: number;
  /**
   * 语义已废（保存不再删素材），恒为 0。
   * 保留字段只为不破坏既有调用方与测试的读法。
   */
  assetsRemoved: number;
  assetBytes: number;
  /**
   * 保存后**确实在工程目录 `assets/` 里**的素材 id（含早就存在、这次没重写的）。
   *
   * 素材仓用它回答「这条素材有没有文件可保留」：从未落盘的素材被移除时
   * 应当直接丢弃，而不是下一次保存又把它写出来。
   */
  persistedAssets: string[];
  /**
   * 实际写进 `project.json` 的文本。
   *
   * 自动保存靠它做「内容没变就不写」的比对：写入期间用户可能又改了一笔，
   * 拿**调用前**的快照去记「上次写了什么」会记错，下一次就会误判为「没变」
   * 而把磁盘停在中间版本上。
   */
  projectText: string;
  warnings: string[];
  durationMs: number;
}

export async function saveProject(input: SaveInput): Promise<SaveReport> {
  const t0 = Date.now();
  const { dir, project, ledger, openFor } = input;
  const warnings: string[] = [];

  // 两个素材撞同一个文件名会静默互相覆盖（症状：「换了素材但画面没变」）。
  // 这属于调用方构造出的非法台账，宁可不保存。
  const conflicts = detectPathConflicts(ledger);
  if (conflicts.length) {
    const detail = conflicts.map((c) => `${c.path} ← ${c.ids.join(', ')}`).join('；');
    throw new Error(tr('err.io.pathConflict', { detail }));
  }

  await ensureDirs(dir, PROJECT_DIRS);

  const prev = await readLedgerOrDefault(dir);
  const diff = diffLedger(prev.ledger, ledger);

  let assetsWritten = 0;
  let assetBytes = 0;
  const writtenIds: string[] = [];
  const toWrite = [...diff.added, ...diff.changed];
  for (const id of toWrite) {
    const entry = ledger.entries[id]!;
    const rel = projectPath(entry);
    // linked-only 没有工程副本：保存不写任何字节（它是刻意的，不是缺数据）。
    if (entry.mode === 'generated' || !rel) continue;
    const stream = openFor(id);
    if (!stream) {
      warnings.push(tr('err.io.assetBytesMissing', { name: entry.originName, id }));
      continue;
    }
    const segs = splitRelPath(rel);
    const name = segs.pop();
    if (!name) continue;
    const parent = await resolveDir(dir, segs, true);
    // 流式写：视频素材的内存峰值 = 一块 buffer，与文件大小无关。
    const report = await writeStreamAtomic(parent, name, stream, { verify: false });
    writtenIds.push(id);
    assetsWritten++;
    assetBytes += report.bytes;
  }

  // ② 台账。放在工程之前：若之后写工程失败，磁盘上是「新台账 + 旧工程」，
  //    而旧工程引用的素材一个都没被删（保存从不删文件），仍然自洽。
  const ledgerText = serializeLedger(ledger);
  await writeBytesAtomic(dir, ASSET_LEDGER_FILE, ledgerText, { verify: true });

  // ③ 工程本体。
  const projectJson = `${JSON.stringify(project, null, 2)}\n`;
  const pr = await writeBytesAtomic(dir, PROJECT_FILE, projectJson, {
    // 自动保存不轮转 .bak（见 SaveInput.backup）。
    backup: input.backup === false ? null : PROJECT_BACKUP,
    verify: true,
  });
  warnings.push(...pr.warnings);

  // 用户主动移除的素材**不删文件**（理由见文件头）。它们留在 assets/ 里，
  // 下次打开工程时被聚合成一条「不再被引用」的提示。
  // `assetsRemoved` 保留在 SaveReport 里是为了不破坏既有调用方，语义已废：
  // 恒为 0，且**不要**再拿它判断磁盘上发生了什么。

  return {
    project: { bytes: pr.bytes, verified: pr.verified, backup: pr.backup?.name ?? null },
    ledgerBytes: new TextEncoder().encode(ledgerText).byteLength,
    assetsWritten,
    assetsRemoved: 0,
    assetBytes,
    // 未变的条目按定义就已经在磁盘上；这次写成功的也在。`changed` 但流为 null 的
    // 不在其中 —— 那种情况下用户移除它时不该假装「有文件可保留」。
    persistedAssets: [...new Set([...diff.unchanged, ...writtenIds])].filter((id) => {
      const e = ledger.entries[id];
      return !!e && !!projectPath(e) && e.mode !== 'generated';
    }),
    projectText: projectJson,
    warnings,
    durationMs: Date.now() - t0,
  };
}

/* ------------------------------------------------------------ 打开 */

export interface OpenResult {
  project: Project;
  ledger: AssetLedger;
  issues: AssetIssue[];
  warnings: string[];
  /**
   * 上次离开时的播放头 / 选中 / 视图（`session.json`）。没有或读不动 = null。
   *
   * **不是工程内容**：它不参与脏标记，也不影响渲染求值；调用方拿它铺一次
   * 初始界面状态即可（`adoptProject` 的 `session`）。
   */
  session: ProjectSession | null;
}

export async function openProject(dir: FsDirHandle): Promise<OpenResult> {
  const warnings: string[] = [];

  const rawText = await readTextIfExists(dir, PROJECT_FILE);
  if (rawText === null) throw new NotAProjectError(dir.name);

  let raw: Record<string, unknown>;
  try {
    raw = JSON.parse(rawText) as Record<string, unknown>;
  } catch (e) {
    throw new Error(
      tr('err.io.badJson', { file: PROJECT_FILE, detail: e instanceof Error ? e.message : String(e) }),
    );
  }
  // 迁移 + 校验都在这里发生（schema.ts 的 MIGRATIONS 是那张表）。
  const project = migrateProject(raw);

  const parsed = parseLedger(await readTextIfExists(dir, ASSET_LEDGER_FILE));
  warnings.push(...parsed.warnings);

  let ledger = parsed.ledger;
  const diskPaths = await listAssetPaths(dir);
  if (Object.keys(ledger.entries).length === 0 && diskPaths.length > 0) {
    // 台账丢了不算灾难：文件名就是 `<assetId>.<ext>`，从目录本身重建。
    const rebuilt = await rebuildLedgerFromDir(dir, project, diskPaths);
    ledger = rebuilt.ledger;
    warnings.push(...rebuilt.warnings);
  } else {
    // 台账里的 path 可能因 assetId 或原始文件名变化而过期，落盘前重算一遍。
    ledger = relinkPaths(ledger);
  }

  const issues = await auditLedger(
    ledger,
    (path, needFp) => probe(dir, path, needFp),
    diskPaths,
  );

  // `auditLedger` 对每个未跟踪文件各发一条 issue。保存不再删素材之后，
  // 这里会有成批的孤儿 —— 逐条铺在面板上会把真正该看的 missing 淹掉。
  // 所以只在打开工程时收成**一条**聚合提示，`auditLedger` 本身不动
  // （它的逐文件行为有单测与别的调用方依赖）。
  const orphaned = await summarizeOrphans(dir, ledger, diskPaths);
  const merged = issues.filter((i) => i.kind !== 'untracked');
  if (orphaned) merged.push(orphaned);

  /*
   * 会话状态最后读、且**不参与任何判定**：它决定的是「打开后停在哪」，
   * 与工程能不能打开无关（见 `session.ts` 文件头）。
   */
  const session = await readSessionFile(dir);

  return { project, ledger, issues: merged, warnings, session };
}

/**
 * 把「磁盘上有、台账里没有」的文件收成一条 issue。
 *
 * 体积只读 `FsFile.size`，**绝不 `readBytes()`**：孤儿里可能有几 GB 的视频，
 * 为了显示一句提示把它整份读进堆，等于把这份安全性又赔回去。
 */
async function summarizeOrphans(
  dir: FsDirHandle,
  ledger: AssetLedger,
  diskPaths: string[],
): Promise<AssetIssue | null> {
  const tracked = new Set<string>();
  for (const e of Object.values(ledger.entries)) {
    const p = projectPath(e);
    if (p) tracked.add(p);
  }
  const orphans = diskPaths.filter((p) => !tracked.has(p));
  if (!orphans.length) return null;

  let bytes = 0;
  for (const path of orphans) bytes += await sizeOf(dir, path);
  return {
    assetId: '',
    kind: 'untracked',
    severity: 'info',
    path: null,
    message: tr('err.ledger.orphans', { n: orphans.length, size: formatBytes(bytes) }),
  };
}

/** 一个文件在磁盘上的字节数（只 stat）。读不到按 0 计。 */
export function assetPathBytes(dir: FsDirHandle, relPath: string): Promise<number> {
  return sizeOf(dir, relPath);
}

/** 一个文件在磁盘上的字节数。读不到（被移走 / 权限失效）按 0 计，不挡打开工程。 */
async function sizeOf(dir: FsDirHandle, relPath: string): Promise<number> {
  const segs = splitRelPath(relPath);
  const name = segs.pop();
  if (!name) return 0;
  try {
    const parent = await resolveDir(dir, segs, false);
    const fh = await parent.openFile(name, { create: false });
    return (await fh.get()).size;
  } catch {
    return 0;
  }
}

/**
 * 打开工程里的某个素材文件句柄。**不读字节** —— 视频只留句柄。
 * 文件不在时返回 null（`issues` 里已经有记录）。
 */
export async function openAssetFile(dir: FsDirHandle, entry: AssetEntry): Promise<FsFileHandle | null> {
  const rel = projectPath(entry);
  if (entry.mode === 'generated' || !rel) return null;
  const segs = splitRelPath(rel);
  const name = segs.pop();
  if (!name) return null;
  try {
    const parent = await resolveDir(dir, segs, false);
    return await parent.openFile(name, { create: false });
  } catch (e) {
    if (isNotFound(e)) return null;
    throw e;
  }
}

/* ------------------------------------------------------------ 辅助 */

async function readLedgerOrDefault(dir: FsDirHandle): Promise<{ ledger: AssetLedger; warnings: string[] }> {
  return parseLedger(await readTextIfExists(dir, ASSET_LEDGER_FILE));
}

/** `assets/` 下所有文件的相对路径（`assets/xxx.png`）。目录不存在返回 []。 */
export async function listAssetPaths(dir: FsDirHandle): Promise<string[]> {
  try {
    const assetsDir = await resolveDir(dir, [ASSETS_DIR], false);
    const items = await assetsDir.list();
    // 回收站是子目录、本来就不在这一层；`isTrashPath` 是第二道判定（见 layout.ts）。
    return items
      .filter((i) => i.kind === 'file')
      .map((i) => `${ASSETS_DIR}/${i.name}`)
      .filter((rel) => !isTrashPath(rel));
  } catch (e) {
    if (isNotFound(e)) return [];
    throw e;
  }
}

/**
 * 磁盘探测：只返回「在不在、多大、指纹」。
 *
 * `needFp === false` 时连首尾 128 KiB 都不读（`File.size` 是元数据）。
 * `needFp === true` 走**采样指纹**，不是旧版那种整份 sha256 —— 2 GB 视频
 * 也只读 128 KiB（见 `fingerprint.ts`）。
 */
async function probe(
  dir: FsDirHandle,
  relPath: string,
  needFp: boolean,
): Promise<{ bytes: number; fp: string | null } | null> {
  const segs = splitRelPath(relPath);
  const name = segs.pop();
  if (!name) return null;
  try {
    const parent = await resolveDir(dir, segs, false);
    const fh = await parent.openFile(name, { create: false });
    const file = await fh.get();
    if (!needFp) return { bytes: file.size, fp: null };
    const content = await contentOfBlob(file.readBlob ? await file.readBlob() : new Blob([(await file.readBytes()) as unknown as BlobPart]));
    return { bytes: file.size, fp: content.fp };
  } catch (e) {
    if (isNotFound(e)) return null;
    throw e;
  }
}

/**
 * 从 `assets/` 目录重建台账。
 *
 * 这是「台账可丢」的实现：文件名是 `<assetId>.<ext>`，assetId 直接读出来；
 * kind / name 从 `Project.assets` 取（工程本身还活着，它是真相）；
 * 哈希现场算。
 *
 * 认不出的文件（assetId 不在工程里）**照样列进 diskPaths**，
 * 于是会被 `auditLedger` 标成 untracked 提示用户，而不是被静默忽略或删掉。
 */
async function rebuildLedgerFromDir(
  dir: FsDirHandle,
  project: Project,
  diskPaths: string[],
): Promise<{ ledger: AssetLedger; warnings: string[] }> {
  const warnings = [tr('err.io.ledgerRebuilt')];
  const ledger = createLedger();
  for (const rel of diskPaths) {
    const name = rel.slice(rel.lastIndexOf('/') + 1);
    const dot = name.lastIndexOf('.');
    const id = dot > 0 ? name.slice(0, dot) : name;
    const known = project.assets[id];
    const kind = known?.kind ?? 'image';
    // 采样指纹只读 128 KiB，视频也负担得起（这就是不用全量 sha256 的意义）。
    const found = await probe(dir, rel, true);
    const content = found?.fp ? { size: found.bytes, fp: found.fp } : null;
    const entry: AssetEntry = {
      id,
      kind,
      // 原始文件名无从得知（台账才是记它的地方），先用重建出来的名字。
      originName: name,
      mode: 'bundled',
      addedAt: 0,
      content,
      locations: [
        {
          kind: 'project',
          path: rel,
          seen: { size: found?.bytes ?? null, fp: found?.fp ?? null, mtime: null },
        },
      ],
    };
    ledger.entries[id] = entry;
    if (!known) warnings.push(tr('err.io.untrackedFile', { name }));
  }
  return { ledger, warnings };
}

/* ------------------------------------------------------------ 删除语义 */

/** 把文件句柄变成分块流（大素材不整份进堆）。 */
async function* chunksOfHandle(fh: FsFileHandle): AsyncGenerator<Uint8Array> {
  const file = await fh.get();
  if (!file.readStream) {
    const bytes = await file.readBytes();
    if (bytes.byteLength) yield bytes;
    return;
  }
  const reader = file.readStream().getReader();
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

/**
 * 把一份素材移进 `assets/.trash/`。返回回收站相对路径。
 *
 * 三件事的顺序是刻意的：**先写回收站、再删原文件**。反过来的话，
 * 写回收站失败就等于直接销毁了源文件 —— 而那正是这套删除语义要消灭的形态。
 *
 * 回收站文件名带时间戳（`<assetId>-<stamp><ext>`）：同一素材清理两次时
 * 不能互相覆盖，第一次进回收站的那份才是用户可能想找回的。
 */
export async function moveAssetToTrash(
  dir: FsDirHandle,
  entry: AssetEntry,
  stamp = Date.now(),
): Promise<string | null> {
  const rel = projectPath(entry);
  if (!rel) return null;
  const segs = splitRelPath(rel);
  const name = segs.pop();
  if (!name) return null;

  let parent: FsDirHandle;
  let fh: FsFileHandle | null;
  try {
    parent = await resolveDir(dir, segs, false);
    fh = await parent.openFile(name, { create: false });
  } catch (e) {
    if (isNotFound(e)) return null;
    throw e;
  }

  const trashSegs = trashPathSegments(entry.id, entry.originName, stamp);
  const trashName = trashSegs.pop()!;
  const trashDir = await resolveDir(dir, trashSegs, true);
  await writeStreamAtomic(trashDir, trashName, chunksOfHandle(fh), { verify: false });
  await parent.remove(name);
  return [...trashSegs, trashName].join('/');
}

/** 真正删掉素材文件（只该对「已从工程移除」的保留项用）。文件不在 = 已达成目的。 */
export async function deleteAssetFile(dir: FsDirHandle, entry: AssetEntry): Promise<boolean> {
  const rel = projectPath(entry);
  if (!rel) return false;
  const segs = splitRelPath(rel);
  const name = segs.pop();
  if (!name) return false;
  try {
    const parent = await resolveDir(dir, segs, false);
    await parent.remove(name);
    return true;
  } catch (e) {
    if (isNotFound(e)) return true;
    throw e;
  }
}

/** 回收站里的一个文件。 */
export interface TrashFile {
  /** 工程根相对路径（`assets/.trash/xxx.png`）。 */
  path: string;
  bytes: number;
}

/** 列出回收站文件（只 stat，不读字节）。目录不存在返回 []。 */
export async function listTrashFiles(dir: FsDirHandle): Promise<TrashFile[]> {
  let trash: FsDirHandle;
  try {
    trash = await resolveDir(dir, [ASSETS_DIR, ASSET_TRASH_DIR], false);
  } catch (e) {
    if (isNotFound(e)) return [];
    throw e;
  }
  const items = await trash.list();
  const out: TrashFile[] = [];
  for (const it of items) {
    if (it.kind !== 'file') continue;
    let bytes = 0;
    try {
      bytes = (await (await trash.openFile(it.name, { create: false })).get()).size;
    } catch {
      bytes = 0;
    }
    out.push({ path: `${ASSETS_DIR}/${ASSET_TRASH_DIR}/${it.name}`, bytes });
  }
  return out;
}

/** 清空回收站。**只删 `.trash/` 里的文件**，不碰 `assets/` 与本地原文件。 */
export async function clearTrash(dir: FsDirHandle): Promise<{ removed: number; bytes: number }> {
  const files = await listTrashFiles(dir);
  if (!files.length) return { removed: 0, bytes: 0 };
  const trash = await resolveDir(dir, [ASSETS_DIR, ASSET_TRASH_DIR], false);
  let removed = 0;
  let bytes = 0;
  for (const f of files) {
    const name = splitRelPath(f.path).pop();
    if (!name) continue;
    try {
      await trash.remove(name);
      removed += 1;
      bytes += f.bytes;
    } catch {
      /* 单个删不掉不挡其余（权限 / 正被占用） */
    }
  }
  return { removed, bytes };
}

/** 删除一个 `assets/` 下的文件（孤儿清理用）。不在 = 已达成目的。 */
export async function deleteAssetPath(dir: FsDirHandle, relPath: string): Promise<boolean> {
  const segs = splitRelPath(relPath);
  const name = segs.pop();
  if (!name) return false;
  try {
    const parent = await resolveDir(dir, segs, false);
    await parent.remove(name);
    return true;
  } catch (e) {
    if (isNotFound(e)) return true;
    throw e;
  }
}

/**
 * `assets/` 里台账不知道的文件。
 *
 * **只列直接子文件**（`.trash/` 是目录，天然不在内）；旧版本留下的孤儿就靠它
 * 让用户确认清理 —— 永远不自动删。
 */
export async function listOrphanPaths(dir: FsDirHandle, ledger: AssetLedger): Promise<string[]> {
  const tracked = new Set(
    Object.values(ledger.entries)
      .map((e) => projectPath(e))
      .filter((p): p is string => !!p),
  );
  return (await listAssetPaths(dir)).filter((p) => !tracked.has(p));
}

/** 素材在磁盘上的相对路径（写台账时用，保证 path 与 layout 规则一致）。 */
export function relPathFor(id: string, originName: string): string {
  return assetRelPath(id, originName);
}

export { createLedger };
