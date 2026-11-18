/**
 * preview-cache.ts — 预览渲染缓存的**纯计算层**（不碰 DOM / GL / 文件系统）。
 *
 * 缓存粒度是**缓段**：把 `[from, to)` 这段工程按预览尺寸渲成一段 MP4，播放时直接
 * 解码。任何让帧变慢的东西（排版捕获、SDF 场景、粒子、长特效链）都被同一条路径
 * 覆盖，而且**没有 alpha 问题** —— 预览底色是不透明的，整帧就是屏幕上的最终画面。
 * 设计见 `docs/preview-cache.md`。
 *
 * 代价写在这里，免得后来人以为是 bug：**缓段内的内容一变，只有那一段作废**。
 * 它不是「边调边看」的加速器，是「调完反复审阅」的加速器。
 */

import { fnv1a, stableStringify } from './stable-json';

/**
 * 缓存格式版本：编码参数 / 目录布局 / 解码口径 / 签名口径一变就抬它。
 *
 * 读到版本不符的条目当孤儿删掉（`project/preview-cache-store.ts::scan`），
 * **不做迁移** —— 它是派生物，重烘一次比写迁移便宜。
 */
export const PREVIEW_CACHE_VER = 1;

/** 一片的时长（秒）。10 s ≈ 2.5–5 MB，也正是「一次空闲能烘完」的量级。 */
export const PREVIEW_SLICE_SEC = 10;

/**
 * 烘焙的**帧率上限**。它和下面的空闲系数一起决定「烘焙占多少前台」。
 *
 * 24 是实测的折中：一帧主线程成本 2–4 ms，24 fps ⇒ 占空比 ≈ 1/4，240 Hz 屏上
 * 仍然没有一个长任务。想烘得更快就抬它，代价是前台开始掉合成帧。
 */
export const PREVIEW_BAKE_MAX_FPS = 24;

/**
 * 单帧成本 → 让速间隔的倍数：间隔 = `max(1000/MAX_FPS, 成本 × 3)`。
 *
 * 3 的含义是「烘一帧、歇三帧」；内容特别贵（排版每帧 30 ms）时它自动退化成
 * 「烘一帧歇 90 ms」，而不是把前台拖下去。
 */
export const PREVIEW_BAKE_IDLE_FACTOR = 3;

/**
 * 签名窗口两侧的余量（秒）。
 *
 * 缓段边界上的像素不只由「压线的那一帧」决定：转场窗口会伸到剪辑点前后，
 * 而片段恰好从边界外一点点开始时也可能参与那一帧。3 s 把转场上限与半个
 * 短镜头都盖住了 —— 多算只会「多作废一次」，少算会**放出旧画面**。
 */
const SIG_PAD_SEC = 3;

/**
 * 一段的**内容签名**：只包含「会决定 `[from, to)` 这段像素」的东西。
 *
 * 为什么要它（而不是整份工程的哈希）：用户在 50 s 处改一个片段，0–20 s 那段的
 * 画面**一个像素都没变**，没有理由把它的缓存也扔掉。签名的口径是：
 *
 * - 全局且**真的影响像素**的：`seed`（随机）、`fps`、`resolution`、`beatGrid`
 *   （算法可以吃拍）、排版默认主题 / 自定义方案、`assetsRev`（素材字节换了）。
 * - **轨道序与 `enabled`**：整条轨道都在算（哪怕这一帧它上面没有片段）——
 *   `affectDepth` 数的是「下方最近的 N 条**启用**视觉轨」，空轨也占位。
 * - 每条轨道上**落在窗口内**的片段（窗口 = 段两端各放 `SIG_PAD_SEC`）：
 *   整段对象原样进哈希（含曲线 / 特效链 / 绑定 / 转场引用）。
 * - **不进**签名的：`name` / `sections` / `beatMarks` / `issues` / 选中 / 播放头 /
 *   视图状态 —— 它们不决定任何像素（这是旧的「整份工程哈希」最冤的地方）。
 */
export function rangeSignature(input: {
  project: {
    seed: number;
    fps: number;
    resolution: { w: number; h: number };
    beatGrid: unknown;
    typographyTheme?: string;
    customThemes?: unknown;
    tracks: readonly {
      kind: string;
      enabled: boolean;
      clips: readonly { kind: string; start: number; end: number }[];
    }[];
  };
  assetsRev: string;
  /** 输出尺寸（已取偶）。 */
  w: number;
  h: number;
  /** 帧号（左闭右开）。 */
  from: number;
  to: number;
}): string {
  const p = input.project;
  const fps = Math.max(1, p.fps);
  const winFrom = input.from / fps - SIG_PAD_SEC;
  const winTo = input.to / fps + SIG_PAD_SEC;
  const body = stableStringify({
    v: PREVIEW_CACHE_VER,
    from: Math.round(input.from),
    to: Math.round(input.to),
    w: Math.round(input.w),
    h: Math.round(input.h),
    assets: input.assetsRev,
    seed: p.seed,
    fps: p.fps,
    res: p.resolution,
    beat: p.beatGrid,
    theme: p.typographyTheme ?? null,
    themes: p.customThemes ?? null,
    tracks: p.tracks.map((t) => ({
      k: t.kind,
      e: t.enabled,
      c: t.clips.filter((c) => c.end > winFrom && c.start < winTo),
    })),
  });
  return fnv1a(body);
}

/** 预览缓存的码率（bps）。文字多的画面宁可大一点也不掉清晰度。 */
export function previewBitrate(w: number, h: number): number {
  // 与导出同一个口径的粗估（`exporters/mp4-sink.ts::defaultBitrate` 的 1/3）：
  // 预览是过程量，2–4 Mbps 在这类内容上已经看不出差别。
  const px = Math.max(1, w) * Math.max(1, h);
  return Math.round(Math.min(4_000_000, Math.max(1_500_000, px * 3.2)));
}

/** `t` 落在第几片（从 0 起）。 */
export function sliceIndexAt(t: number, sliceSec = PREVIEW_SLICE_SEC): number {
  if (!Number.isFinite(t) || t <= 0) return 0;
  return Math.max(0, Math.floor(t / sliceSec));
}

/** 第 `index` 片的帧区间（左闭右开，已按总帧数夹过）。 */
export function sliceFrameRange(
  index: number,
  fps: number,
  totalFrames: number,
  sliceSec = PREVIEW_SLICE_SEC,
): { from: number; to: number } {
  const per = Math.max(1, Math.round(Math.max(1, fps) * sliceSec));
  const from = Math.max(0, Math.min(totalFrames, Math.floor(index) * per));
  const to = Math.max(from, Math.min(totalFrames, from + per));
  return { from, to };
}

/** 这一片是不是短的（工程末尾那一片）—— 短片的收益面照旧，只是更快烘完。 */
export function isLastSlice(index: number, fps: number, totalFrames: number, sliceSec = PREVIEW_SLICE_SEC): boolean {
  return sliceFrameRange(index + 1, fps, totalFrames, sliceSec).from >= totalFrames;
}

/**
 * 视频文件名。`sig` 是我们自己的十六进制串、`from` 是段首帧号，都不含
 * 路径分隔符。**用段首帧号而不是片序号**：片段级手工烘焙的范围是任意区间，
 * 没有「第几片」这个概念，而段首帧号永远唯一。
 */
export function previewVideoName(sig: string, from: number): string {
  return `${sig}-${String(Math.max(0, Math.round(from))).padStart(6, '0')}.mp4`;
}

/** 元数据文件名（与视频同名，`.json` 结尾）。 */
export function previewMetaName(sig: string, from: number): string {
  return `${sig}-${String(Math.max(0, Math.round(from))).padStart(6, '0')}.json`;
}

/** 索引条目（落盘的元数据 + 目录扫描时补齐的字段）。 */
export interface PreviewCacheEntry {
  ver: number;
  /**
   * **这一段自己的内容签名**（`rangeSignature` 算出来的）。
   *
   * 命中判据就是它 + 帧率 + 尺寸：别的段落改了什么与它无关。
   */
  sig: string;
  /** 帧区间（左闭右开）。**`from` 是这一条的标识**（同段内不重叠）。 */
  from: number;
  to: number;
  fps: number;
  w: number;
  h: number;
  bytes: number;
  /** 写入时刻（ms）。GC 的 LRU 判据。 */
  at: number;
}

/** 这一条现在还能不能用（版本、签名、尺寸、帧区间都对得上）。 */
export function usableEntry(
  e: PreviewCacheEntry | null | undefined,
  want: { sig: string; fps: number; w: number; h: number; from: number; to: number },
): boolean {
  if (!e) return false;
  return (
    e.ver === PREVIEW_CACHE_VER &&
    e.sig === want.sig &&
    e.fps === want.fps &&
    e.w === want.w &&
    e.h === want.h &&
    e.from === want.from &&
    e.to === want.to &&
    e.bytes > 0
  );
}

/**
 * `[from, to)` 是否被这些条目**完整覆盖**（合起来不留缝）。
 *
 * 时间轴用它判「这一段烘完了没有」。`usableEntry` 判的是另一件事 ——
 * 「某一条是不是正好就是我要的那一条」（签名 / 尺寸 / 帧率全对），
 * 而手工烘的片段范围与自动切片可以互相拼接，所以要按覆盖算。
 */
export function coversRange(
  entries: readonly { from: number; to: number }[],
  from: number,
  to: number,
): boolean {
  if (to <= from) return false;
  const sorted = entries.filter((e) => e.to > from && e.from < to).sort((a, b) => a.from - b.from);
  let cursor = from;
  for (const e of sorted) {
    if (e.from > cursor) return false;
    if (e.to > cursor) cursor = e.to;
    if (cursor >= to) return true;
  }
  return cursor >= to;
}

/** 时间轴上那一段缓存的状态。 */
export type CachePieceState = 'ready' | 'encoding' | 'missing';

/** 一段缓存条（帧区间 + 状态）。 */
export interface CachePiece {
  from: number;
  to: number;
  state: CachePieceState;
}

/**
 * 把一个计划区间切成三种状态：（已烘好可预览）/（正在烘，还没好）/（没有缓存）。
 *
 * 时间轴只吃这个结果，**不再自己判**「全烘完了没有」—— 判据就在切片里：
 * 一段全是 `ready` 就是烘完了。这样「正在烘到哪」和「烘完」用的是同一份数据，
 * 不会出现两条线互相打架（曾经出现过：实线画了、虚线还留着）。
 *
 * `encoding` 覆盖处优先于 `ready`（正在写的那一小段显示成虚线）。
 */
export function cachePieces(
  range: { from: number; to: number },
  ready: readonly { from: number; to: number }[],
  encoding: { from: number; to: number } | null,
): CachePiece[] {
  const from = Math.round(range.from);
  const to = Math.round(range.to);
  if (to <= from) return [];
  const marks: CachePiece[] = [];
  const push = (a0: number, b0: number, state: CachePieceState): void => {
    const a = Math.max(from, Math.round(a0));
    const b = Math.min(to, Math.round(b0));
    if (b > a) marks.push({ from: a, to: b, state });
  };
  for (const r of ready) push(r.from, r.to, 'ready');
  if (encoding) push(encoding.from, encoding.to, 'encoding');

  // 边界扫描：每一小段取「最后覆盖它的那条」，没人覆盖就是 missing。
  const cuts = new Set<number>([from, to]);
  for (const m of marks) {
    cuts.add(m.from);
    cuts.add(m.to);
  }
  const xs = [...cuts].sort((p, q) => p - q);
  const out: CachePiece[] = [];
  for (let i = 0; i + 1 < xs.length; i += 1) {
    const a = xs[i]!;
    const b = xs[i + 1]!;
    let state: CachePieceState = 'missing';
    for (const m of marks) if (m.from <= a && m.to >= b) state = m.state;
    const last = out[out.length - 1];
    if (last && last.state === state && last.to === a) last.to = b;
    else out.push({ from: a, to: b, state });
  }
  return out;
}

/**
 * 该删哪些文件（名字数组）。两条规则，顺序即优先级：
 *
 * 1. **落在计划区间之外的直接删**：那些时间已经被剪掉了，永远不会再播。
 *    判据是**几何包含**（不看内容）—— 手工烘的片段范围是计划区间的子区间，
 *    要留着；而「内容变了」不在这里判（那条由访问时按签名判，见
 *    `ui/preview-cache.ts::entryAtFrame`）：GC 不该为每个条目算一次签名。
 * 2. 其余超出预算时按 `at` 从旧到新删，删到预算的 80% 为止。
 *
 * 孤儿（只有 `.mp4` 没有 `.json`，上次崩在中途）由调用方单独删 —— 它们不在
 * 索引里，这里看不见。
 */
export function pickEvictions(
  entries: readonly PreviewCacheEntry[],
  budgetBytes: number,
  planned: readonly { from: number; to: number }[],
): { byName: string[]; freedBytes: number } {
  const byName: string[] = [];
  let freed = 0;
  let keptBytes = 0;
  const kept: PreviewCacheEntry[] = [];
  const inPlan = (e: PreviewCacheEntry): boolean =>
    planned.some((p) => e.from >= p.from && e.to <= p.to);
  for (const e of entries) {
    if (!inPlan(e)) {
      byName.push(previewVideoName(e.sig, e.from), previewMetaName(e.sig, e.from));
      freed += e.bytes;
    } else {
      keptBytes += e.bytes;
      kept.push(e);
    }
  }
  const target = Math.max(0, Math.round(budgetBytes * 0.8));
  if (keptBytes > target) {
    kept.sort((a, b) => a.at - b.at);
    let total = keptBytes;
    for (const e of kept) {
      if (total <= target) break;
      byName.push(previewVideoName(e.sig, e.from), previewMetaName(e.sig, e.from));
      total -= e.bytes;
      freed += e.bytes;
    }
  }
  return { byName, freedBytes: freed };
}

/** 单段上限（秒）。超过就切开 —— 一段三分钟的镜头烘起来没人愿意等。 */
export const PREVIEW_MAX_RANGE_SEC = 20;

/** 相邻片段之间小于这个间隔（秒）就合并，免得为半秒空隙各烘一份。 */
const MERGE_GAP_SEC = 0.5;

/**
 * 该烘哪些区间：**按片段起止点**，不是固定 10 s 切片。
 *
 * 固定切片的两个毛病都来自「切点与内容无关」：一片里混着两三个镜头（其中一半
 * 是静态的，本来就不慢），而一个长镜头又被切在中间 —— 时间轴上的缓存条于是
 * 看起来和片段对不上，用户没法判断「这个镜头烘了没有」。
 *
 * 相邻或重叠的片段合并（间隔 ≤ 0.5 s）：转场两侧、紧挨着的剪辑点本来就是
 * 一口气看完的。超过 `PREVIEW_MAX_RANGE_SEC` 的长段再切开。
 */
export function cacheRanges(
  project: { fps: number; duration: number; tracks: readonly { kind: string; enabled: boolean; clips: readonly { kind: string; start: number; end: number }[] }[] },
): { from: number; to: number }[] {
  const fps = Math.max(1, project.fps);
  const total = Math.max(1, Math.ceil(project.duration * fps));
  const spans: { from: number; to: number }[] = [];
  for (const track of project.tracks) {
    if (track.kind !== 'visual' || !track.enabled) continue;
    for (const clip of track.clips) {
      if (clip.kind !== 'source') continue;
      const from = Math.max(0, Math.floor(clip.start * fps));
      const to = Math.min(total, Math.ceil(clip.end * fps));
      if (to > from) spans.push({ from, to });
    }
  }
  spans.sort((a, b) => a.from - b.from);
  const merged: { from: number; to: number }[] = [];
  const gap = Math.round(MERGE_GAP_SEC * fps);
  for (const s of spans) {
    const last = merged[merged.length - 1];
    if (last && s.from <= last.to + gap) last.to = Math.max(last.to, s.to);
    else merged.push({ ...s });
  }
  const cap = Math.max(1, Math.round(PREVIEW_MAX_RANGE_SEC * fps));
  const out: { from: number; to: number }[] = [];
  for (const r of merged) {
    for (let from = r.from; from < r.to; from += cap) out.push({ from, to: Math.min(r.to, from + cap) });
  }
  return out;
}
