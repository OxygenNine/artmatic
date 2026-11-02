/**
 * ledger.ts — 素材台账（`assets.json`），v3：内容身份 + 多位置副本。
 *
 * ## 为什么不是「一条素材两个 path」
 *
 * 路径只是**位置**，不是身份。同一份内容可以在工程目录里、也可以在本机任意
 * 目录里；两处都在时谁说了算不能靠「哪条路径先存在」——那样一台机器上
 * 好好的工程，换台机器就静默换了画面。v3 的判据是：
 *
 * ```
 * content   = { size, fp }        ← 「这是哪份内容」（采样指纹，见 fingerprint.ts）
 * locations = [project | local]   ← 「哪里有一份」（0..N）
 * ```
 *
 * 解析策略在 `asset-resolve.ts`（纯函数）：优先 `mode` 指定的那一路，
 * 但每一份都必须与 `content` 对得上；对不上是 `stale` / `conflict`，
 * 绝不静默改用另一份内容。
 *
 * ## 台账是可以丢的
 *
 * 素材文件名就是 `<assetId>.<ext>`，所以**从 `assets/` 目录本身就能重建台账**
 * （指纹现场算）。因此 `parseLedger` 对损坏输入一律降级成空台账 + 警告，
 * 而不是抛错 —— 为一份可重建的派生数据挡住用户打开工程，是错的取舍。
 * 重建逻辑在 `io.ts`（它需要文件系统，本文件保持纯函数）。
 *
 * ## v2 → v3
 *
 * 旧台账的 `path` 变成一条 `project` 位置；`hash`（全量 sha256）**不能**换算成
 * 采样指纹，置 `content: null`，打开工程时补算。旧字段 `bytes` 用来填
 * `seen.size`。`normalizeEntry` 永不抛。
 */

import { tr } from '../i18n/index.svelte';
import type { AssetContent } from './fingerprint';
import { LAYOUT_VERSION, assetRelPath } from './layout';

export type AssetMode = 'linked' | 'bundled' | 'generated';
export type LocationKind = 'project' | 'local';

export interface LocationSeen {
  size: number | null;
  /** 采样指纹；null = 没算过（旧台账 / 环境不支持）。 */
  fp: string | null;
  mtime: number | null;
}

/**
 * 一份副本。
 *
 * - `project`：工程根相对 POSIX 路径（`assets/ab12.png`），可随目录搬走；
 * - `local`：本机绝对路径（桌面版 linked 模式），换机器后只作提示，不自动读。
 */
export interface AssetLocation {
  kind: LocationKind;
  path: string;
  /** 上次看到的状态。只用于提示「源文件变过」，不是身份。 */
  seen: LocationSeen | null;
}

export interface AssetEntry {
  id: string;
  kind: 'audio' | 'image' | 'video' | 'lut';
  /** 导入时的原始文件名。重定位对话框里要拿它提示用户「找的是这个」。 */
  originName: string;
  mode: AssetMode;
  /** 首次导入时间（毫秒）。只用于展示排序。 */
  addedAt: number;
  /**
   * 已从 `Project.assets` 移除、但**字节文件仍保留**。
   *
   * 缺省 `false`（旧台账没有这个字段，语义就是旧行为）。
   */
  retained?: boolean;
  /** 内容身份；`generated` 与「还没补算的旧条目」为 null。 */
  content: AssetContent | null;
  locations: AssetLocation[];
}

export interface AssetLedger {
  layoutVersion: number;
  entries: Record<string, AssetEntry>;
}

export function createLedger(): AssetLedger {
  return { layoutVersion: LAYOUT_VERSION, entries: {} };
}

/* ------------------------------------------------------------ 位置 */

/** 取某一类位置（每类最多一条）。 */
export function locationOf(entry: AssetEntry, kind: LocationKind): AssetLocation | null {
  return entry.locations.find((l) => l.kind === kind) ?? null;
}

/** 工程目录里的那一份（`assets/xxx`）；没有返回 null。 */
export function projectPath(entry: AssetEntry): string | null {
  return locationOf(entry, 'project')?.path ?? null;
}

/** 本机原文件路径（桌面版 linked）；没有返回 null。 */
export function localPath(entry: AssetEntry): string | null {
  return locationOf(entry, 'local')?.path ?? null;
}

/* ------------------------------------------------------------ 解析 / 序列化 */

/**
 * 解析台账。**永不抛**：
 *  - 不是对象 / 缺 entries → 空台账
 *  - 单条 entry 形状不对 → 丢掉那一条（其余保留，尽量少损失）
 *  - layoutVersion 高于本应用 → 报 warning 但照常读（字段是增量的，多余字段无害）
 */
export function parseLedger(json: string | null | undefined): { ledger: AssetLedger; warnings: string[] } {
  const warnings: string[] = [];
  const empty = createLedger();
  if (!json) return { ledger: empty, warnings };
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch {
    warnings.push(tr('err.ledger.badJson'));
    return { ledger: empty, warnings };
  }
  if (!raw || typeof raw !== 'object') {
    warnings.push(tr('err.ledger.notObject'));
    return { ledger: empty, warnings };
  }
  const obj = raw as { layoutVersion?: unknown; entries?: unknown };
  const lv = typeof obj.layoutVersion === 'number' ? obj.layoutVersion : 0;
  if (lv > LAYOUT_VERSION) {
    warnings.push(tr('err.ledger.versionTooNew', { found: lv, supported: LAYOUT_VERSION }));
  }
  const entries: Record<string, AssetEntry> = {};
  const src = obj.entries && typeof obj.entries === 'object' ? (obj.entries as Record<string, unknown>) : {};
  for (const [id, v] of Object.entries(src)) {
    const e = normalizeEntry(id, v);
    if (e) entries[id] = e;
    else warnings.push(tr('err.ledger.badEntry', { id }));
  }
  return { ledger: { layoutVersion: LAYOUT_VERSION, entries }, warnings };
}

function normalizeEntry(id: string, v: unknown): AssetEntry | null {
  if (!v || typeof v !== 'object') return null;
  const o = v as Partial<AssetEntry> & { path?: unknown; hash?: unknown; bytes?: unknown };
  const kind = o.kind === 'audio' || o.kind === 'image' || o.kind === 'video' ? o.kind : null;
  if (!kind) return null;
  const mode: AssetMode =
    o.mode === 'generated' ? 'generated' : o.mode === 'linked' ? 'linked' : 'bundled';
  const originName = typeof o.originName === 'string' ? o.originName : id;
  const addedAt = typeof o.addedAt === 'number' ? o.addedAt : 0;

  const content = normalizeContent(o.content);
  const locations = normalizeLocations(o);

  return {
    id: typeof o.id === 'string' && o.id ? o.id : id,
    kind,
    originName,
    mode,
    addedAt,
    // 缺字段 = 旧台账 = 未保留。只在为真时写回（见 serializeLedger）。
    ...(o.retained === true ? { retained: true } : {}),
    content,
    locations,
  };
}

function normalizeContent(v: unknown): AssetContent | null {
  if (!v || typeof v !== 'object') return null;
  const o = v as { size?: unknown; fp?: unknown };
  if (typeof o.size !== 'number' || typeof o.fp !== 'string' || !o.fp) return null;
  return { size: o.size, fp: o.fp };
}

function normalizeLocations(o: {
  locations?: unknown;
  path?: unknown;
  bytes?: unknown;
}): AssetLocation[] {
  const out: AssetLocation[] = [];
  const seen = new Set<LocationKind>();
  const push = (kind: LocationKind, path: unknown, seenRaw: unknown): void => {
    if (typeof path !== 'string' || !path || seen.has(kind)) return;
    seen.add(kind);
    out.push({ kind, path, seen: normalizeSeen(seenRaw) });
  };

  if (Array.isArray(o.locations)) {
    for (const l of o.locations) {
      if (!l || typeof l !== 'object') continue;
      const loc = l as { kind?: unknown; path?: unknown; seen?: unknown };
      if (loc.kind !== 'project' && loc.kind !== 'local') continue;
      push(loc.kind, loc.path, loc.seen);
    }
  }
  // v2：单条 project 路径。
  if (typeof o.path === 'string' && o.path) {
    push('project', o.path, {
      size: typeof o.bytes === 'number' ? o.bytes : null,
      fp: null,
      mtime: null,
    });
  }
  return out;
}

function normalizeSeen(v: unknown): LocationSeen | null {
  if (!v || typeof v !== 'object') return null;
  const o = v as { size?: unknown; fp?: unknown; mtime?: unknown };
  return {
    size: typeof o.size === 'number' ? o.size : null,
    fp: typeof o.fp === 'string' ? o.fp : null,
    mtime: typeof o.mtime === 'number' ? o.mtime : null,
  };
}

/**
 * 序列化。**按 id 排序**，位置也按 `local` → `project` 排。
 * 「台账逻辑内容没变 → 字节完全一致」，否则 git 里全是噪声 diff。
 */
export function serializeLedger(ledger: AssetLedger): string {
  const sorted: Record<string, AssetEntry> = {};
  for (const id of Object.keys(ledger.entries).sort()) {
    sorted[id] = canonical(ledger.entries[id]!);
  }
  return `${JSON.stringify({ layoutVersion: LAYOUT_VERSION, entries: sorted }, null, 2)}\n`;
}

function canonical(e: AssetEntry): AssetEntry {
  const order: Record<LocationKind, number> = { local: 0, project: 1 };
  return {
    id: e.id,
    kind: e.kind,
    originName: e.originName,
    mode: e.mode,
    addedAt: e.addedAt,
    ...(e.retained ? { retained: true } : {}),
    content: e.content,
    locations: [...e.locations].sort((a, b) => order[a.kind] - order[b.kind]),
  };
}

/* ------------------------------------------------------------ 变更 */

export interface LedgerDiff {
  /** 新增的素材 id（要写字节）。 */
  added: string[];
  /**
   * 消失的素材 id。**保存不会因此删文件**：清理只走
   * `moveAssetToTrash` / `deleteAssetFile` 两条显式路径。
   */
  removed: string[];
  /** 内容或位置变了的素材 id（可能重写字节）。 */
  changed: string[];
  /** 逻辑内容没变。 */
  unchanged: string[];
}

/**
 * 比较两份台账。判据是 `content.fp` 优先、退化到 `content.size`。
 *
 * `fp === null`（旧台账 / 环境不支持）只能靠大小 —— 那是弱指纹，会让
 * 「换了个同尺寸的文件」漏过去。`auditLedger` 会把它标成 `unhashed` 提醒用户。
 */
export function diffLedger(prev: AssetLedger, next: AssetLedger): LedgerDiff {
  const added: string[] = [];
  const removed: string[] = [];
  const changed: string[] = [];
  const unchanged: string[] = [];
  for (const [id, n] of Object.entries(next.entries)) {
    const p = prev.entries[id];
    if (!p) {
      added.push(id);
      continue;
    }
    if (sameAsset(p, n)) unchanged.push(id);
    else changed.push(id);
  }
  for (const id of Object.keys(prev.entries)) if (!next.entries[id]) removed.push(id);
  return { added, removed, changed, unchanged };
}

function sameAsset(a: AssetEntry, b: AssetEntry): boolean {
  if (a.mode !== b.mode) return false;
  /*
   * `retained` 刻意不参与比较：它只决定这条记录要不要出现在「未使用素材」里，
   * 不改变任何字节。翻转它去重写素材文件是纯粹的浪费。
   */
  if (!sameContent(a.content, b.content)) return false;
  if (a.locations.length !== b.locations.length) return false;
  const byKind = new Map(b.locations.map((l) => [l.kind, l]));
  for (const l of a.locations) {
    const other = byKind.get(l.kind);
    if (!other || other.path !== l.path) return false;
  }
  return true;
}

function sameContent(a: AssetContent | null, b: AssetContent | null): boolean {
  if (!a || !b) return a === b;
  if (a.fp && b.fp) return a.fp === b.fp;
  return a.size === b.size;
}

/**
 * 台账里有没有两条记录指向工程目录里的同一个文件。
 *
 * `safeAssetId` 会清洗掉非法字符，清洗**可能让两个不同 id 撞成同一个文件名**
 * （`a/b` 与 `a:b` 都变成 `ab`）。撞了必须报错而不是静默去重 ——
 * 去重的后果是两份素材共用一个文件，症状是「换了素材但画面没变」。
 */
export function detectPathConflicts(ledger: AssetLedger): { path: string; ids: string[] }[] {
  const byPath = new Map<string, string[]>();
  for (const e of Object.values(ledger.entries)) {
    const p = projectPath(e);
    if (!p) continue;
    const list = byPath.get(p) ?? [];
    list.push(e.id);
    byPath.set(p, list);
  }
  return [...byPath.entries()].filter(([, ids]) => ids.length > 1).map(([path, ids]) => ({ path, ids }));
}

/** 重算工程内副本的路径（改了 assetId 或原始文件名之后调）。本地位置不动。 */
export function relinkPaths(ledger: AssetLedger): AssetLedger {
  const entries: Record<string, AssetEntry> = {};
  for (const [id, e] of Object.entries(ledger.entries)) {
    if (e.mode === 'generated' || !locationOf(e, 'project')) {
      entries[id] = e;
      continue;
    }
    entries[id] = {
      ...e,
      locations: e.locations.map((l) =>
        l.kind === 'project' ? { ...l, path: assetRelPath(id, e.originName) } : l,
      ),
    };
  }
  return { layoutVersion: LAYOUT_VERSION, entries };
}

/* ------------------------------------------------------------ 磁盘审计 */

export interface DiskProbe {
  bytes: number;
  /** 采样指纹；null = 环境不支持 / 没法算。 */
  fp: string | null;
}

export type IssueKind = 'missing' | 'changed' | 'unhashed' | 'untracked';
export type IssueSeverity = 'error' | 'warning' | 'info';

export interface AssetIssue {
  assetId: string;
  kind: IssueKind;
  severity: IssueSeverity;
  path: string | null;
  message: string;
}

/**
 * 拿台账与磁盘实际状态对一遍。`probe` 由调用方提供（它需要文件系统）。
 *
 * `probe` 返回 null = 文件不在。
 *
 * `needFp` 是**性能开关**：只有台账记了 `content` 时才需要采样指纹。
 * 但采样只读 128 KiB，比旧版的全量 sha256 便宜得多 —— 视频也能验。
 *
 * 只审计**工程目录里的副本**：`local` 位置属于当前机器的外部文件，
 * 由打开工程时的 resolve 流程处理（换机器后它本来就不该存在）。
 *
 * `untracked` 是反向检查：`assets/` 里有台账不知道的文件（用户手动放进去的，
 * 或上次保存中途崩了留下的）—— 只提示不处理，绝不自动删用户的东西。
 */
export async function auditLedger(
  ledger: AssetLedger,
  probe: (path: string, needFp: boolean) => Promise<DiskProbe | null>,
  diskPaths: string[] = [],
): Promise<AssetIssue[]> {
  const issues: AssetIssue[] = [];
  const tracked = new Set<string>();

  for (const e of Object.values(ledger.entries)) {
    if (e.mode === 'generated') continue;
    const p = projectPath(e);
    // linked-only：工程目录里本来就没有副本，不属于这里的问题。
    if (!p) continue;
    tracked.add(p);
    /*
     * 保留项（retained）已经不再被工程引用，文件丢了也不是错误 ——
     * 把它报成 `missing`（error 级）会让「打开工程有 N 个问题」变成噪声。
     * 它仍然算 tracked：否则同一批文件会反过来被报成 untracked 孤儿。
     */
    if (e.retained) continue;
    const found = await probe(p, !!e.content);
    if (!found) {
      issues.push({
        assetId: e.id,
        kind: 'missing',
        severity: e.mode === 'bundled' ? 'error' : 'warning',
        path: p,
        message: tr('err.ledger.missing', { path: p }),
      });
      continue;
    }
    if (e.content && found.fp) {
      if (e.content.fp !== found.fp) {
        issues.push({
          assetId: e.id,
          kind: 'changed',
          severity: 'warning',
          path: p,
          message: tr('err.ledger.changed', { path: p }),
        });
      }
      continue;
    }
    /*
     * 没有 `content` 的旧条目只能靠大小。期望值优先取 content，其次取
     * 位置上的 `seen.size`（v2 迁移时从 `bytes` 带过来的）。
     */
    const expectedSize = e.content?.size ?? locationOf(e, 'project')?.seen?.size ?? null;
    if (expectedSize !== null && found.bytes !== expectedSize) {
      issues.push({
        assetId: e.id,
        kind: 'changed',
        severity: 'warning',
        path: p,
        message: tr('err.ledger.sizeChanged', {
          path: p,
          from: expectedSize,
          to: found.bytes,
        }),
      });
      continue;
    }
    if (!e.content) {
      issues.push({
        assetId: e.id,
        kind: 'unhashed',
        severity: 'info',
        path: p,
        message: tr('err.ledger.unhashed', { path: p }),
      });
    }
  }

  for (const p of diskPaths) {
    if (tracked.has(p)) continue;
    issues.push({
      assetId: '',
      kind: 'untracked',
      severity: 'info',
      path: p,
      message: tr('err.ledger.untracked', { path: p }),
    });
  }

  return issues;
}
