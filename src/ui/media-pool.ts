/**
 * media-pool.ts — 媒体池的逻辑：列表模型 + 从素材建片段。
 *
 * ## 为什么列表要把两处真相「合成」一遍
 *
 * 一条素材的信息分散在两个地方，各说各的一半：
 *
 * | 出处 | 有什么 | 没有什么 |
 * |---|---|---|
 * | `Project.assets`（工程文件里那张逻辑表） | kind / 名字 / 时长 / 尺寸 | 字节 |
 * | `AssetStore`（运行期素材仓） | 字节来源与字节数、原始文件名 | 时长 / 尺寸 |
 *
 * 面板以**工程文件为准**（它才是保存、打开之后一定还在的那一份），仓里有而
 * 工程里还没登记的也一并列出 —— 导入是「先 put 字节、再 commit」，中间态不该
 * 让用户刚导进来的素材在池子里看不见。
 *
 * ## 这里刻意不 import appState
 *
 * 合成与建片段都是纯的：吃参数、吐数据。`appState` 只在
 * `MediaPool.svelte`（读）与 `insertAssetClip` 的调用点（拿 playT / 拍网格）出现。
 * 于是这两件事都能直接喂假数据单测，不需要 DOM。
 */

import { beatDur, type BeatGrid } from '../core/time';
import {
  newId,
  type AnyClip,
  type Asset,
  type AssetTrimRange,
  type AudioClip,
  type Project,
  type SourceClip,
  type Track,
  type MediaKind,
} from '../core/schema';
import { activeRangeOf, rangeDurationSec } from '../core/preclip';
import type { ProjectStore } from '../core/project-store';
import type { AssetStore } from '../project/asset-store';
import { pinyinHaystack } from '../i18n/pinyin';

/* ------------------------------------------------------------------ 列表 */

/** 面板里的一行。字段就是「显示一条素材需要知道的一切」。 */
export interface PoolItem {
  id: string;
  kind: PoolKind;
  /** 展示名（可被「重命名素材」改过，随工程保存）。 */
  name: string;
  /**
   * 导入时的原始文件名（台账 `originName`）。展示名改过之后它仍是磁盘上的
   * 那个名字，所以搜索要一起匹配 —— 用户经常记得的是文件名而不是自己起的别名。
   */
  fileName: string | null;
  /** 秒。图片没有时长（它是静止的），视频/音频打开工程后从工程文件读回来。 */
  durationSec: number | null;
  /** 像素。音频没有尺寸。 */
  size: { w: number; h: number } | null;
  /**
   * 仓里的字节数（字节为 null 的 generated 素材记 null）。
   * 与 `missing` 一起构成「这条素材还在不在」的判据。
   */
  bytes: number | null;
  /** 首次导入时间（毫秒）；仓里没有这条记录时 null。 */
  addedAt: number | null;
  /** 来源文件修改时间（毫秒）；未知时 null（排序回退到 `addedAt`）。 */
  modifiedAt: number | null;
  /** 工程登记了它、但仓里没有字节 —— 打开工程时那个文件读不出来。 */
  missing: boolean;
  /** 引用式素材：字节不在工程目录里，指向本机原文件。 */
  linked?: boolean;
  /** linked 的原文件在本次会话里变过（只提示，不自动换内容）。 */
  stale?: boolean;
  /** 预剪辑范围（v13，只有视频有）。插入时用当前激活的那一个。 */
  ranges?: AssetTrimRange[];
  activeRange?: AssetTrimRange | null;
}

/**
 * 只是声明我们用到素材仓的哪几个方法（传真仓或假的都行）。
 *
 * 读的是 `size()` 而不是 `get()`：视频的字节根本不在内存里，
 * 而「这一行显示多大」只需要字节数。
 */
type PoolSource = Pick<AssetStore, 'ids' | 'input' | 'size'> &
  Partial<Pick<AssetStore, 'modeOf' | 'isStale' | 'originName' | 'addedAt' | 'modifiedAt'>>;

export function buildPoolItems(
  declared: Readonly<Record<string, Asset>>,
  store: PoolSource,
): PoolItem[] {
  const out: PoolItem[] = [];
  const seen = new Set<string>();

  for (const [id, a] of Object.entries(declared)) {
    seen.add(id);
    // LUT 是调色素材：进台账、跟着工程走，但**不是画面**，媒体池不列它。
    if (!isPoolKind(a.kind)) continue;
    const input = store.input(id);
    out.push({
      id,
      kind: a.kind,
      name: a.name,
      fileName: store.originName?.(id) ?? input?.originName ?? null,
      durationSec: a.durationSec ?? null,
      size: a.size ?? null,
      bytes: store.size(id),
      addedAt: store.addedAt?.(id) ?? null,
      modifiedAt: store.modifiedAt?.(id) ?? null,
      /*
       * 判据是「仓里有没有这条记录」，**不是**「字节数是不是 0」：generated
       * 素材（演示工程的节拍音频）本来就没有字节，但它随时可重建，不算缺失。
       */
      missing: !input,
      linked: store.modeOf?.(id) === 'linked',
      stale: store.isStale?.(id) === true,
      ...(a.kind === 'video' && a.ranges?.length
        ? { ranges: a.ranges, activeRange: activeRangeOf(a) }
        : {}),
    });
  }

  for (const id of store.ids()) {
    if (seen.has(id)) continue;
    const input = store.input(id);
    if (!input || !isPoolKind(input.kind)) continue;
    out.push({
      id,
      kind: input.kind,
      name: input.name,
      fileName: store.originName?.(id) ?? input.originName,
      durationSec: null,
      size: null,
      bytes: store.size(id),
      addedAt: store.addedAt?.(id) ?? null,
      modifiedAt: store.modifiedAt?.(id) ?? null,
      missing: false,
    });
  }

  return out;
}

/** 媒体池只认这三类：`lut` 是调色素材，没有画面也没有时长，不该出现在这里。 */
export type PoolKind = MediaKind;
/** 这三类之外的东西（当前只有 `lut`）不该出现在媒体池视图里。 */
export function isPoolKind(kind: string): kind is PoolKind {
  return kind === 'image' || kind === 'video' || kind === 'audio';
}

/**
 * 「媒体池里的那一条素材」在 HTML5 拖拽里用的自定义类型。
 *
 * 用它而不是塞 `text/plain`，有两个实在的好处：
 *  · 落点能**在 dragover 期间**就认出这是我们自己的东西（拖动中
 *    `dataTransfer.types` 可读，`getData` 不可读），于是落点竖线只会在
 *    拖素材时出现，拖个网页链接过来不会；
 *  · 拖到别的应用里不会变成一段莫名其妙的文本。
 */
export const ASSET_DRAG_MIME = 'application/x-artmatic-asset';

/** 分组的固定顺序：画面在前、声音在后（与时间轴上「视觉轨在上面」同一取向）。 */
export const POOL_KINDS = ['video', 'image', 'audio'] as const satisfies readonly PoolKind[];

export interface PoolGroup {
  kind: PoolKind;
  items: PoolItem[];
}

/** 按类型分组。**空组不返回** —— 面板里三行空标题没有信息量，只有空状态的提示有用。 */
export function groupPool(items: readonly PoolItem[]): PoolGroup[] {
  return POOL_KINDS.map((kind) => ({
    kind,
    items: items.filter((i) => i.kind === kind),
  })).filter((g) => g.items.length > 0);
}

/* ------------------------------------------------------------ 搜索 / 排序 */

export type PoolView = 'thumbs' | 'compact';

/**
 * 排序档位。
 *
 * 没有「按类型 / 分组」这一档：列表本来就按视频 → 图片 → 音频分组了，
 * 再加一个「按类型排」只是把同一件事说两遍（与特效选择器删掉分类排序同一条理由）。
 * 所有档位都只决定**组内**顺序。
 */
export type PoolSort = 'added' | 'name' | 'size' | 'modified' | 'duration';

export const POOL_SORTS: readonly PoolSort[] = ['added', 'name', 'size', 'modified', 'duration'];

/**
 * 搜索：匹配展示名、原始文件名、id 三个字段，三种形态。
 *
 * - **包含**（大小写不敏感）：最常用，`take1` 命中 `take1.mp4`；
 * - **拼音**：`pinyinOf` 由调用方注入。默认走 `pinyinHaystack`（手写表，见
 *   `i18n/locales/zh-CN/pinyin.ts`），媒体池传的是**按需加载**的拼音库
 *   （`ui/pool-pinyin.ts`）—— 素材名是用户数据，手写表覆盖不到，
 *   而库的体积只该在「用户真的来搜索」时才付。
 * - **子序列**：`vlog01` 命中 `my-vlog-01.mp4`（打漏了分隔符是常态）。
 *
 * 子序列只对长度 ≥ 2 的查询启用：单个字符用包含就够，否则「搜 a」会把
 * 所有名字里出现过 a 的条目全部算命中（含子序列会命中得更多）。
 */
export function filterPoolItems(
  items: readonly PoolItem[],
  query: string,
  pinyinOf: (text: string) => string = pinyinHaystack,
): PoolItem[] {
  const q = query.trim().toLowerCase();
  if (!q) return [...items];
  return items.filter((it) => {
    const hay = [it.name, it.fileName ?? '', it.id, pinyinOf(it.name), pinyinOf(it.fileName ?? '')]
      .filter(Boolean)
      .join(' ')
      .toLowerCase();
    if (hay.includes(q)) return true;
    if (q.length < 2) return false;
    return subsequence(it.name, q) || subsequence(it.fileName ?? '', q);
  });
}

/** `q` 是否是 `text` 的子序列（字符按顺序出现，允许中间隔东西）。 */
function subsequence(text: string, q: string): boolean {
  const hay = text.toLowerCase();
  let i = 0;
  for (let j = 0; j < hay.length && i < q.length; j += 1) {
    if (hay[j] === q[i]) i += 1;
  }
  return i >= q.length;
}

/**
 * 排序。**稳定排序**（V8 保证），所以同值时保留导入顺序。
 *
 * 方向是刻意的：体积 / 日期 / 时长都是「大 / 新 / 长」在上 —— 这三个档位的
 * 用途是「找出最占地方的 / 最近改过的 / 用得最多的那一条」，倒序看是浪费一步。
 * 未知值（null）一律排在已知值之后。
 */
export function sortPoolItems(
  items: readonly PoolItem[],
  sort: PoolSort,
  usedSec: ReadonlyMap<string, number> = new Map(),
): PoolItem[] {
  const out = items.slice();
  const byName = (a: PoolItem, b: PoolItem): number =>
    a.name.localeCompare(b.name, 'zh-Hans-CN');
  switch (sort) {
    case 'name':
      out.sort(byName);
      break;
    case 'size':
      out.sort((a, b) => descNullable(a.bytes, b.bytes));
      break;
    case 'modified':
      out.sort((a, b) => descNullable(modifiedOf(a), modifiedOf(b)));
      break;
    case 'duration':
      out.sort((a, b) => (usedSec.get(b.id) ?? 0) - (usedSec.get(a.id) ?? 0));
      break;
    default:
      // 'added' = 列表合成出来的顺序（导入顺序），一个都不动。
      break;
  }
  return out;
}

/** 修改时间：文件 mtime 优先，未知时退回导入时间（见 `PoolItem.modifiedAt`）。 */
function modifiedOf(it: PoolItem): number | null {
  return it.modifiedAt ?? it.addedAt;
}

/** 降序比较（大的在前），null 永远排在最后。 */
function descNullable(a: number | null, b: number | null): number {
  if (a === null && b === null) return 0;
  if (a === null) return 1;
  if (b === null) return -1;
  return b - a;
}

/**
 * 按 id 取一条（拖拽落点用：`DataTransfer` 里只有 id）。
 *
 * 走 `buildPoolItems` 而不是自己拼：那样「一条素材由哪两处合成」就只有一处实现，
 * 拖到时间轴上的那条与列表里显示的那条不可能对不上。
 */
export function poolItemById(
  declared: Readonly<Record<string, Asset>>,
  store: PoolSource,
  id: string,
): PoolItem | null {
  return buildPoolItems(declared, store).find((i) => i.id === id) ?? null;
}

/* -------------------------------------------------------------- 引用检查 */

/** 一条素材被哪几个片段引用。 */
export interface AssetUsage {
  trackId: string;
  trackName: string;
  clipId: string;
  label: string;
}

/**
 * 这条素材被哪些片段引用（媒体池删除前的那次询问要用的计数与文案）。
 *
 * **必须是唯一的判据**：UI 里另算一遍（比如只扫 `source.type === 'image'`）
 * 的 bug 形态是「提示说没人用，删掉之后画面空了」—— 音频片段（`AudioClip.assetId`）
 * 与视频片段用的是同一个台账，漏掉哪一类都不会报错。
 */
export function clipsUsingAsset(project: Project, assetId: string): AssetUsage[] {
  const out: AssetUsage[] = [];
  for (const track of project.tracks) {
    for (const clip of track.clips) {
      if (clipAssetId(clip) === assetId) {
        out.push({ trackId: track.id, trackName: track.name, clipId: clip.id, label: clip.label });
      }
    }
  }
  return out;
}

/**
 * 片段引用的素材 id；不引用素材（特效片段、纯色源）返回 null。
 *
 * 「哪些片段用了这条素材」只有一个判据：`clipsUsingAsset` 与时间轴时长排序
 * 都读它。各写一遍的 bug 形态是「提示说没人用，删掉之后画面空了」。
 */
export function clipAssetId(clip: AnyClip): string | null {
  if (clip.kind === 'audio') return clip.assetId;
  if (clip.kind === 'source' && (clip.source.type === 'image' || clip.source.type === 'video')) {
    return clip.source.assetId;
  }
  return null;
}

/** 每条素材在时间轴上的**片段总时长**（秒，多个片段累加）。排序用。 */
export function assetUsageSeconds(project: Project): Map<string, number> {
  const out = new Map<string, number>();
  for (const track of project.tracks) {
    for (const clip of track.clips) {
      const id = clipAssetId(clip);
      if (!id) continue;
      out.set(id, (out.get(id) ?? 0) + Math.max(0, clip.end - clip.start));
    }
  }
  return out;
}

/* --------------------------------------------------- 认文件（拖进来的） */

/**
 * 扩展名 → 类型。**先信 MIME**，不可信时看扩展名 —— 从系统拖进来的文件
 * （尤其来自压缩包或某些 Linux 桌面）经常带着空 `type`，只认 MIME 会让它
 * 变成一句「不是能读的素材」。
 *
 * 只列本机解码链路真的认得的：视频走 mediabunny，图片走 `createImageBitmap`，
 * 音频走 `decodeAudioData`。列得比解码能力宽，只会把失败往后推一步。
 */
const BY_EXT: Record<string, PoolKind> = {
  mp4: 'video',
  m4v: 'video',
  mov: 'video',
  webm: 'video',
  mkv: 'video',
  png: 'image',
  jpg: 'image',
  jpeg: 'image',
  gif: 'image',
  webp: 'image',
  bmp: 'image',
  avif: 'image',
  svg: 'image',
  wav: 'audio',
  mp3: 'audio',
  m4a: 'audio',
  aac: 'audio',
  flac: 'audio',
  ogg: 'audio',
  oga: 'audio',
  opus: 'audio',
};

/** 这个文件是哪类素材？认不出返回 null（调用方负责提示，不是静默丢弃）。 */
export function kindOfFile(name: string, mime: string): PoolKind | null {
  const m = (mime || '').toLowerCase();
  if (m.startsWith('video/')) return 'video';
  if (m.startsWith('image/')) return 'image';
  if (m.startsWith('audio/')) return 'audio';
  const ext = name.toLowerCase().split('.').pop() ?? '';
  return BY_EXT[ext] ?? null;
}

/* ------------------------------------------------------------------ 建片段 */

/**
 * 图片片段的默认长度：4 拍（下限 0.5s）。
 *
 * 与「导入图片」共用**同一处实现** —— 两个入口（时间轴菜单 / 媒体池）各写一份
 * 的话，同一个文件从两条路进来会得到两个长度，而这种偏差没人会去查。
 */
export function stillLength(grid: BeatGrid): number {
  return Math.max(0.5, beatDur(grid) * 4);
}

/**
 * 视频/音频按素材自身时长，图片按 4 拍。都是**默认值**，插进去之后随拖随改。
 *
 * 视频带预剪辑范围时按范围的帧数算（v13）：显示的帧数与实际落下的长度
 * 必须是同一个数，否则「插入 3 秒的范围得到 3.03 秒」会在时间轴上错半帧。
 */
function clipLength(
  item: PoolItem,
  grid: BeatGrid,
  range: AssetTrimRange | null,
  fps: number,
): number {
  if (range && item.kind === 'video') {
    return Math.max(1 / Math.max(1, fps), rangeDurationSec(range, fps));
  }
  if (item.kind === 'image') return stillLength(grid);
  return Math.max(0.1, item.durationSec ?? stillLength(grid));
}

/**
 * 素材 → 片段。`missing` 的素材返回 null（没有字节，插进去也画不出来）。
 *
 * `fit` 按类型分：视频 `cover`（空镜头是底图，铺满才符合预期），
 * 图片 `contain`（一张照片不该被默认裁掉一部分）。这两条与时间轴菜单里的
 * 「导入视频 / 导入图片」是同一套默认值。
 */
export function clipForAsset(
  item: PoolItem,
  at: number,
  grid: BeatGrid,
  range: AssetTrimRange | null = null,
  fps = 30,
): AnyClip | null {
  if (item.missing) return null;
  const start = Math.max(0, at);
  const end = start + clipLength(item, grid, range, fps);

  if (item.kind === 'audio') {
    const clip: AudioClip = {
      kind: 'audio',
      id: newId(),
      start,
      end,
      label: item.name,
      fadeSec: 0,
      curves: {},
      assetId: item.id,
      srcIn: 0,
    };
    return clip;
  }

  const base = {
    id: newId(),
    start,
    end,
    label: item.name,
    fadeSec: 0,
    curves: {},
    blend: 'normal' as const,
    opacity: 1,
    transform: { x: 0.5, y: 0.5, sx: 1, sy: 1, rot: 0 },
  };
  const clip: SourceClip =
    item.kind === 'image'
      ? { ...base, kind: 'source', source: { type: 'image', assetId: item.id }, fit: 'contain' }
      : {
          ...base,
          kind: 'source',
          // 预剪辑范围决定 srcIn 与长度（v13）：插入的就是已经剪好的片段。
          source: { type: 'video', assetId: item.id, srcIn: range?.inSec ?? 0, speed: 1 },
          fit: 'cover',
        };
  return clip;
}

export interface InsertOptions {
  /** 插入点（秒）。调用方负责吸附 —— 这里只管建片段。 */
  at: number;
  grid: BeatGrid;
  /** 主选中片段所在轨道。能装就优先用它（「插到我正在编辑的那条轨上」）。 */
  preferredTrackId?: string | null;
  /**
   * 用哪个预剪辑范围。**缺省 = 用条目当前激活的那个**；显式 `null` = 整段素材。
   * 两种语义必须区分：双击 / 「+」要复用激活范围，而「素材 → 片段」的其它
   * 调用点（排版、粘贴重建）不该被一个界面状态偷偷改长度。
   */
  range?: AssetTrimRange | null;
}

/**
 * 把一条素材插进时间轴。成功返回新片段 id；素材不可用（缺字节）返回 null。
 *
 * 落点被别的片段占着时由 `addClip` 负责顺延 —— 它本来就是「新建片段」那条路，
 * 这里不重算一遍（两边各写一套的 bug 形态是「从池里插进来会压住邻居、从菜单
 * 里建却不会」）。
 */
export function insertAssetClip(
  store: ProjectStore,
  item: PoolItem,
  opts: InsertOptions,
): string | null {
  const range = opts.range === undefined ? (item.activeRange ?? null) : opts.range;
  const clip = clipForAsset(item, opts.at, opts.grid, range, store.project.fps);
  if (!clip) return null;

  const preferred: Track | null = opts.preferredTrackId ? store.track(opts.preferredTrackId) : null;
  const fits = (t: Track | null): t is Track => t !== null && store.canHost(t, clip);
  const track = fits(preferred) ? preferred : (store.project.tracks.find(fits) ?? null);
  if (track) {
    store.addClip(track.id, clip);
    return clip.id;
  }

  /*
   * 一条装得下的轨都没有（用户把那一类轨删光了）：补一条。
   *
   * ⚠️ 这是**两笔撤销**（建轨 + 放片段），只有这个角落会这样。刻意不去复刻
   * `addClip` 的空档裁剪来凑成一笔 —— 落点规则只有一处实现，比撤销栈好看
   * 一节值钱（与 `ProjectStore.removeClips` 那条注释是同一个取舍方向）。
   * 补轨而不是「拒绝插入」：空的时间轴不是空白，是坏的（见 createBlankProject）。
   */
  const id = store.addTrack(clip.kind === 'audio' ? 'audio' : 'visual');
  store.addClip(id, clip);
  return clip.id;
}
