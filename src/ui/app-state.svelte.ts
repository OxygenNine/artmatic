/**
 * app-state.svelte.ts — 全局 UI 状态（Svelte 5 runes）。
 *
 * 响应式只挂这些东西：store 的 version 镜像、播放头、播放态、吸附、
 * 缩放、选中、波形。Project 本体不放进 runes——每次 commit 后
 * store.subscribe 推 version++，组件靠读 version 建立依赖。
 *
 * 服务（renderer / sources / player）由 main.ts 装配后经 init 注入，
 * 不参与响应式。
 */

import { ProjectStore } from '../core/project-store';
import { defaultKeySettings, newId, type AnyClip, type AudioClip } from '../core/schema';
import { createBlankProject } from '../core/demo-project';
import { isGradeDef } from '../core/grade';
import type { Renderer } from '../engine/renderer';
import {
  type AlgoRuntime,
  SCRUB_CATCHUP_BUDGET_MS,
  SCRUB_STEP_BUDGET_MS,
} from '../algos/runtime';
import type { SourceManager } from '../engine/sources';
import { AudioPlayer } from '../audio/player';
import { Metronome } from '../audio/metronome';
import { ProjectAudio } from './project-audio';
// 源/算法/特效的装配收口在 render-core（与 lab 试炼场同一份实现）。
import { createRenderCore } from '../render/render-core';
import type { RecallService } from '../render/recall';
// 钉尺寸取材的唯一序列（截图 / 体积采样 / 导出循环共用），见该文件头。
import { withExportFrame } from '../render/export-frame';
import { FontRegistry } from '../typography/font-registry';
import { PluginHost } from '../plugins/host';
import { localFontSource, queryLocalFontFamilies } from '../typography/local-fonts';
import { TypographyRuntime } from '../typography/runtime';
import {
  createOffscreenHost,
  createTextBackendRegistry,
  type TextBackendRegistry,
} from '../typography/rasterizer';
import { forgetImageAsset, resolveImageAsset } from '../typography/image-assets';
import {
  forgetMedia,
  imageSourceFor,
  setMediaAssetsListener,
  videoMediaFor,
} from '../engine/media-assets';
import type { VideoSourceManager } from '../engine/video-source';
import { forgetVideoAudio, prepareProjectVideoAudio } from '../engine/video-audio';
import { estimateTempo } from '../audio/tempo';
import type { WaveformData } from '../audio/decode';
import { platform } from '../platform/index';
import { SNAP_MODES, timeAtFrame, frameAtTime, type SnapMode } from '../core/time';
import { snapTimeWithSections } from '../core/sections';
import {
  parseClipboard,
  planPaste,
  serializeClips,
  type ClipboardEntry,
  type ClipboardPayload,
  type PastePlanItem,
} from '../core/clipboard';
import type { ShortcutScheme } from './shortcuts';
import type { FsDirHandle } from '../project/fs';
import type { AssetIssue } from '../project/ledger';
import type { ProjectRef } from '../project/handles';
import { rgbToHex } from '../core/color';
import { createAssetStore, type AssetStore } from '../project/asset-store';
import { loadOpenTabs, saveOpenTabs } from '../project/open-tabs';
import {
  clearAgentHistory as clearAgentHistoryOnDisk,
  readAgentHistory,
  removeAgentSession,
  writeAgentSession,
} from '../project/agent-history';
import { upsertAgentSession, type AgentSessionRecord } from '../agent/history';
import { DENSITY } from './tokens';
import { POOL_SORTS, type PoolSort, type PoolView } from './media-pool';
// `TimelineMode` 的概念属于时间轴（标尺怎么读），值与「每个形态有哪些吸附档位」
// 都在那边 —— 这里只保管用户选了哪个，不在 UI 层再抄一份表。
import { defaultSnapForMode, snapFitsMode, type TimelineMode } from '../timeline/view-model';
import { DEFAULT_TYPO_GRID, normalizeTypoGrid, type TypoGridPrefs } from '../typography/grid';
import { tr } from '../i18n/index.svelte';

/* ------------------------------------------------------------ UI 偏好持久化
 *
 * 只存「跟内容无关、丢了只是回到默认值」的东西。工程真相永远只在磁盘
 * （AGENTS §1.7），所以这里绝不能放工程数据。
 */
const UI_KEY = 'artmatic.ui';

interface UiPrefs {
  drawerOpen: boolean;
  drawerWidth: number;
  /**
   * 媒体池（左侧抽屉）。与检查器分开记：两者的开关意图互不相干，
   * 一个值管两个抽屉会出现「关掉检查器顺手把媒体池也关了」。
   */
  mediaPoolOpen: boolean;
  mediaPoolWidth: number;
  /**
   * Agent 抽屉（与媒体池**同一列、互斥**）。
   *
   * 分开记开关意图（与 `mediaPoolOpen` 的理由相同：一个值管两个抽屉会出现
   * 「关掉媒体池顺手把 Agent 也关了」），但两者打开时会互相收起 ——
   * 左列只有一个位置，宽度也共用一份（`mediaPoolWidth`）。
   */
  agentOpen: boolean;
  /** 预览帧率分母：1 = 全速、2 = 半速、3 = 三分之一。 */
  previewFpsDiv: number;
  /** 预览分辨率缩放：1 / 0.75 / 0.5 / 0.25。 */
  previewScale: number;
  /** 暂停时回全质（停住时看到的必须是准的）。 */
  previewRestoreOnPause: boolean;
  /** 预览工具条收成一个悬浮球（画面小时很挡视线）。 */
  previewBarCollapsed: boolean;
  /**
   * 吸附档位。存 UI 偏好而不是工程：它描述的是**这次剪辑的工作习惯**
   * （对手感而言「吸附到拍」还是「自由」是跨工程都一致的），与内容无关。
   */
  snap: SnapMode;
  /**
   * 时间轴形态（节奏 / 标准）。与吸附同理：描述「怎么读这条轴」，不进工程。
   * 只影响三处：标尺文案、工具条显示哪组参数、吸附默认值。
   */
  timelineMode: TimelineMode;
  /**
   * 快捷键方案（「操作习惯」）。只影响切分键，见 ui/shortcuts.ts。
   * 存 UI 偏好而不是工程：它描述的是**用的人**，不是这份工程。
   */
  shortcutScheme: ShortcutScheme;
  /**
   * 左下角的看板娘（彩蛋，默认关）。纯观感，与工程内容无关 —— 所以进
   * localStorage 而不是 project.json，也不会让工程变脏。
   */
  mascotEnabled: boolean;
  /**
   * 排版编辑器的网格 / 画幅线框。
   * 整块存一项而不是拆成 6 个平铺字段：加一个开关只需改 `TypoGridPrefs`，
   * 不必再回到这里补三处（fallback / normalize / persist）。
   */
  typoGrid: TypoGridPrefs;
  /** 右侧「图层 / 元素属性」面板宽度。 */
  typoPanelWidth: number;
  /** 预览下方关键帧面板的高度（可上下拖）与展开状态。 */
  typoKfHeight: number;
  typoKfOpen: boolean;
  /**
   * **运行排版文档里的脚本**（默认关）。
   *
   * 这是排版脚本唯一的信任边界：工程是内容，脚本是随内容带来的任意代码。
   * 关着时脚本一条都不执行、画面按文档原样渲染（面板会标「脚本未运行」），
   * 导出也不会偷偷带上脚本效果。
   *
   * 存 UI 偏好而不是工程：换台机器 / 换个人打开同一份工程时，**跑不跑代码
   * 应该由这台机器上的人决定**，不该跟着工程文件走。
   */
  runTypoScripts: boolean;
  /**
   * 检查器里的「缩放 X / Y」是否联动。默认**联动**（true），勾「分离 XY」后
   * 变成两个独立轴。存 UI 偏好而不是工程：它描述的是「怎么调参数」的习惯，
   * 与这一份工程的内容无关（同吸附档位）。
   */
  scaleLinked: boolean;
  /**
   * 时间轴（轨道区）高度。可拖（工具条下缘 + 与抽屉的夹角），存 UI 偏好：
   * 它描述的是「这次剪辑想给预览留多大地方」，与工程内容无关。
   */
  timelineHeight: number;
  /**
   * **波纹删除**（默认关）。开着时删片段会把同轨后面的片段前移补位
   * （见 `core/ripple.ts`）。存 UI 偏好而不是工程：它是「这一轮怎么剪」的
   * 习惯，同一份工程换个人打开不该被别人的开关带走。
   */
  rippleEdit: boolean;
  /**
   * 节拍器（默认关）。跟着 BPM / offset 打拍、经过手动节奏点时换一个音。
   * 存 UI 偏好：它是「我这一阵在对拍子」的习惯，且**不进导出**。
   */
  metronome: boolean;
  /** 媒体池的列表形态（缩略图 / 紧凑）。两个视图共用一份偏好。 */
  poolView: PoolView;
  /** 媒体池排序档位。 */
  poolSort: PoolSort;
}

/** 排版右栏宽度档位。与检查器抽屉同一套上下限口径。 */
export const TYPO_PANEL_W = { min: 140, max: 420, default: 208 } as const;

export function clampTypoPanelWidth(w: number): number {
  if (!Number.isFinite(w)) return TYPO_PANEL_W.default;
  return Math.min(TYPO_PANEL_W.max, Math.max(TYPO_PANEL_W.min, Math.round(w)));
}

/**
 * 关键帧面板高度档位（px）。
 *
 * 下限 96 = 顶栏 + 标尺 + 两条轨道（再矮就只剩标题，拖它没有意义）；
 * 上限 360 = 面板再高就会把画布压到看不清字 —— 而看字是排版编辑器的本职。
 */
export const TYPO_KF_H = { min: 96, max: 360, default: 168 } as const;

export function clampTypoKfHeight(h: number): number {
  if (!Number.isFinite(h)) return TYPO_KF_H.default;
  return Math.min(TYPO_KF_H.max, Math.max(TYPO_KF_H.min, Math.round(h)));
}

/** 轨道区高度档位（px）。下限保证轨道头与片段仍可读，上限给预览留活路。 */
export const TRACKS_H = { min: 120, max: 560, default: 320 } as const;

export function clampTimelineHeight(h: number): number {
  if (!Number.isFinite(h)) return TRACKS_H.default;
  return Math.min(TRACKS_H.max, Math.max(TRACKS_H.min, Math.round(h)));
}

/** 预览帧率档位（分母）。 */
export const PREVIEW_FPS_DIVS = [1, 2, 3] as const;
/** 预览分辨率档位。 */
export const PREVIEW_SCALES = [1, 0.75, 0.5, 0.25] as const;

/**
 * 快捷键方案的合法值。归一化时用它，避免 localStorage 里一个手改的字符串
 * 让整个判定分支落空。
 */
const SCHEME_IDS: ShortcutScheme[] = ['artmatic', 'premiere', 'aftereffects', 'davinci'];

function normalizeScheme(v: unknown): ShortcutScheme {
  return SCHEME_IDS.includes(v as ShortcutScheme) ? (v as ShortcutScheme) : 'artmatic';
}

/** 合法的吸附档位。`SNAP_MODES` 是全仓库唯一那张表，直接取它的键。 */
const SNAP_IDS = Object.keys(SNAP_MODES) as SnapMode[];

/**
 * 偏好里的吸附档位。**这里只管「是不是一个存在过的值」**；
 * 「它配不配当前形态」由构造函数按形态再筛一次（老偏好里可能存着
 * 标准模式才有的 `frame`，而当时存的时候还没有形态这个概念）。
 */
function normalizeSnap(v: unknown): SnapMode {
  return SNAP_IDS.includes(v as SnapMode) ? (v as SnapMode) : 'bar';
}

function normalizeTimelineMode(v: unknown): TimelineMode {
  return v === 'standard' || v === 'beat' ? v : 'beat';
}

function normalizeDiv(v: unknown): number {
  const n = Number(v);
  return (PREVIEW_FPS_DIVS as readonly number[]).includes(n) ? n : 1;
}

function normalizeScale(v: unknown): number {
  const n = Number(v);
  return (PREVIEW_SCALES as readonly number[]).includes(n) ? n : 1;
}

function loadUiPrefs(): UiPrefs {
  const fallback: UiPrefs = {
    drawerOpen: true,
    drawerWidth: DENSITY.drawerW,
    // 默认收起：它是「要用时才拉开看一眼」的辅助面板，不该开局就吃掉画面宽度。
    mediaPoolOpen: false,
    mediaPoolWidth: DENSITY.poolW,
    agentOpen: false,
    previewFpsDiv: 1,
    previewScale: 1,
    previewRestoreOnPause: true,
    previewBarCollapsed: false,
    /*
     * 吸附只存**当前形态**那一份（`snap`），重启后另一份回到该形态的默认值。
     * 存一份而不是两份是刻意的：两份要在切形态时同时写，任何一条路径漏写
     * 都会出现「切回来档位变了」，而它只在重启后才看得出来。
     */
    snap: 'bar',
    timelineMode: 'beat',
    shortcutScheme: 'artmatic',
    mascotEnabled: false,
    typoGrid: { ...DEFAULT_TYPO_GRID },
    typoPanelWidth: TYPO_PANEL_W.default,
    typoKfHeight: TYPO_KF_H.default,
    typoKfOpen: true,
    timelineHeight: TRACKS_H.default,
    scaleLinked: true,
    // **默认关**：脚本是工程带进来的任意代码，不能「打开即执行」。
    runTypoScripts: false,
    // **默认关**：波纹删除会静默挪动别的片段，属于「明确想要才开」的行为。
    rippleEdit: false,
    // 默认关：节拍器是「在对拍子时才开」的监听，不该开局就跟着播放响。
    metronome: false,
    poolView: 'thumbs',
    poolSort: 'added',
  };
  try {
    const raw = localStorage.getItem(UI_KEY);
    if (!raw) return fallback;
    const p = JSON.parse(raw) as Partial<UiPrefs>;
    const timelineMode = normalizeTimelineMode(p.timelineMode);
    const savedSnap = normalizeSnap(p.snap);
    return {
      drawerOpen: typeof p.drawerOpen === 'boolean' ? p.drawerOpen : fallback.drawerOpen,
      drawerWidth: clampDrawerWidth(Number(p.drawerWidth) || fallback.drawerWidth),
      mediaPoolOpen:
        typeof p.mediaPoolOpen === 'boolean' ? p.mediaPoolOpen : fallback.mediaPoolOpen,
      mediaPoolWidth: clampPoolWidth(Number(p.mediaPoolWidth) || fallback.mediaPoolWidth),
      agentOpen: typeof p.agentOpen === 'boolean' ? p.agentOpen : fallback.agentOpen,
      previewFpsDiv: normalizeDiv(p.previewFpsDiv),
      previewScale: normalizeScale(p.previewScale),
      previewRestoreOnPause:
        typeof p.previewRestoreOnPause === 'boolean'
          ? p.previewRestoreOnPause
          : fallback.previewRestoreOnPause,
      previewBarCollapsed:
        typeof p.previewBarCollapsed === 'boolean'
          ? p.previewBarCollapsed
          : fallback.previewBarCollapsed,
      // 档位必须是这个形态真有的（老偏好里可能存着 `frame` 而形态是节奏）。
      snap: snapFitsMode(savedSnap, timelineMode) ? savedSnap : defaultSnapForMode(timelineMode),
      timelineMode,
      shortcutScheme: normalizeScheme(p.shortcutScheme),
      mascotEnabled:
        typeof p.mascotEnabled === 'boolean' ? p.mascotEnabled : fallback.mascotEnabled,
      typoGrid: normalizeTypoGrid(p.typoGrid, fallback.typoGrid),
      typoPanelWidth: clampTypoPanelWidth(Number(p.typoPanelWidth) || fallback.typoPanelWidth),
      typoKfHeight: clampTypoKfHeight(Number(p.typoKfHeight) || fallback.typoKfHeight),
      typoKfOpen: typeof p.typoKfOpen === 'boolean' ? p.typoKfOpen : fallback.typoKfOpen,
      timelineHeight: clampTimelineHeight(Number(p.timelineHeight) || fallback.timelineHeight),
      scaleLinked: typeof p.scaleLinked === 'boolean' ? p.scaleLinked : fallback.scaleLinked,
      runTypoScripts:
        typeof p.runTypoScripts === 'boolean' ? p.runTypoScripts : fallback.runTypoScripts,
      rippleEdit: typeof p.rippleEdit === 'boolean' ? p.rippleEdit : fallback.rippleEdit,
      metronome: typeof p.metronome === 'boolean' ? p.metronome : fallback.metronome,
      poolView: p.poolView === 'compact' ? 'compact' : 'thumbs',
      poolSort: POOL_SORTS.includes(p.poolSort as PoolSort) ? (p.poolSort as PoolSort) : fallback.poolSort,
    };
  } catch {
    return fallback;
  }
}

function clampDrawerWidth(w: number): number {
  if (!Number.isFinite(w)) return DENSITY.drawerW;
  return Math.min(DENSITY.drawerMaxW, Math.max(DENSITY.drawerMinW, Math.round(w)));
}

function clampPoolWidth(w: number): number {
  if (!Number.isFinite(w)) return DENSITY.poolW;
  return Math.min(DENSITY.poolMaxW, Math.max(DENSITY.poolMinW, Math.round(w)));
}

function saveUiPrefs(p: UiPrefs): void {
  try {
    localStorage.setItem(UI_KEY, JSON.stringify(p));
  } catch {
    /* 存不下不中断操作 */
  }
}

/* ------------------------------------------------------------ 打开的工程
 *
 * 顶栏的选项卡 = **工程**，不是一个网页里的「页面」。
 * 一个网页里同时开多份工程是这类工具的常态（比对两版剪辑、把 A 的片段搬到 B），
 * 而「时间轴 / 排版编辑」是**工程内部**的视图，跟着工程走 —— 切回某个工程时，
 * 它上次停在哪个视图就回到哪里，像浏览器标签页记住自己的位置。
 *
 * 所有「跟这一份工程走」的东西都挂在 `OpenProject` 上。这样切换工程 =
 * 换一个 `activeProjectId`，而不是把一堆散落的状态逐个同步一遍 ——
 * 后者的 bug 形态是「切过去以后播放头还停在上一个工程的位置」，
 * 而且每加一个工程级状态就多一个漏同步的机会。
 */

/**
 * 工程内部视图。排版编辑页与调色页都不是顶栏的一级页面，而是**工程视图** ——
 * 于是「切走再切回来还停在那一页」与「一个网页里同时开几份工程」都不需要额外代码。
 */
export type ProjectView =
  | { kind: 'timeline' }
  | { kind: 'typography'; clipId: string }
  | { kind: 'grade'; clipId: string };


/**
 * 一次当前帧截图的产物。
 *
 * `replayed / truncated` 来自 `render/export-frame.ts`：截图在栈里有反馈类特效时
 * 会**按帧顺序从第 0 帧重放**（否则单帧取材拿不到跨帧历史，画面与预览不一致），
 * 超过上限则退回单帧并把 `truncated` 置真 —— 提示语要说清这一点，
 * 否则「截图和历史对不上」会变成一个哑谜。
 */
export interface SnapshotResult {
  blob: Blob;
  filename: string;
  frame: number;
  /** 实际重放的帧数（0 = 单帧取材）。 */
  replayed: number;
  /** 需要重放但超出上限，历史没有还原。 */
  truncated: boolean;
}

export interface OpenProject {
  readonly id: string;
  /** 文档真相。 */
  store: ProjectStore;
  /**
   * 每个工程自己的素材仓。
   * **共用一份会让保存 A 时把 B 导入的素材一起写进 A 的 `assets/`。**
   */
  assets: AssetStore;
  view: ProjectView;
  /** 盘上位置。null = 还没选过目录。 */
  dir: FsDirHandle | null;
  /** IndexedDB 里的句柄键。 */
  key: string | null;
  /** 上次保存时的 `store.version`；-1 = 从未保存过。 */
  savedVersion: number;
  savedAt: number;
  /**
   * 本地草稿的文件键。每份工程一个，跨「保存到目录」不变。
   *
   * 不用 `id`：`id` 是会话内 uuid，草稿要跨会话被找到，所以两者都稳定；
   * 分开是为了让「同一个会话里恢复一份草稿」不会与工程身份纠缠 ——
   * 恢复出来的是**新工程**，但草稿要接着写回同一格。
   */
  draftKey: string;
  issues: AssetIssue[];
  /** 播放头（秒）。**工程级**：切回来时停在离开的位置。 */
  playT: number;
  /**
   * 选中的片段 id 集合（顺序 = 加入顺序；单选时长度为 1）。
   *
   * 真相是**集合**而不是「一个 id」：时间轴上可以拖出矩形一次框住好几个片段。
   * `selectedClipId` 只是它的第一个元素（主选中）的视图 —— 两份真相会让
   * 「点一个片段」只清掉其中一个，另一个残留着，而且没有任何地方会报错。
   */
  selectedClipIds: string[];
  /**
   * Agent 对话历史的内存副本（磁盘真源在 `agent/sessions/<id>.json`）。
   *
   * 为什么放在 `OpenProject` 上：历史**跟工程走**（切选项卡要看到各自那份），
   * 而它又不在 `Project` 里（见 `agent/history.ts` 的注释）。打开工程时由
   * `loadAgentHistory` 填，之后每次轮末写回磁盘并就地更新这一份。
   */
  agentSessions: AgentSessionRecord[];
  /**
   * 历史最近一次**整份**写到哪个目录（`flushAgentHistory` / `loadAgentHistory` 记账）。
   *
   * 自动保存会频繁调 `writeTo`，每次都把 30 个会话重写一遍是白费 IO。只有
   * 「第一次保存 / 另存为换了目录」才需要整份刷 —— 判据就是目录句柄变了。
   * 不放进 `Project`，也不需要有响应性（纯记账）。
   */
  agentHistoryDir: FsDirHandle | null;
}

/**
 * 没有打开任何工程时 `activeProject` 的回落值。
 *
 * ## 为什么不是「干脆让 projects 为空、让调用方自己处理空集」
 *
 * 因为主界面里读 `appState.store` / `appState.project` 的地方太多了，
 * 而**主界面不能卸载**：Studio 的 `<canvas>` 一旦离开 DOM，WebGL 上下文连同
 * kit 里所有 Program / Target / 纹理一起失效，而且不是重新 mount 能恢复的
 * （见 App.svelte 的注释）。让空集把整棵树炸掉，或者把树卸载掉，两条路都是
 * 「为了一个空状态弄坏渲染器」。
 *
 * 所以空状态是**表现层**的事：工程列表可以是空的（`hasProject === false`），
 * 界面盖上「新建 / 导入 / 最近」的空界面，而底下的读取者拿到一份丢弃用的
 * 空白工程，照常求值。它永远不进 `projects`，也永远不会被保存。
 */
function createPlaceholder(): OpenProject {
  return {
    id: '__placeholder__',
    store: new ProjectStore(createBlankProject()),
    assets: createAssetStore(),
    view: { kind: 'timeline' },
    dir: null,
    key: null,
    // 与 store.version 相等 ⇒ 不算「有未保存改动」，否则关页面时会弹出
    // 一个毫无来由的「要保存吗」。
    savedVersion: 0,
    savedAt: 0,
    draftKey: '__placeholder__',
    issues: [],
    playT: 0,
    selectedClipIds: [],
    agentSessions: [],
    agentHistoryDir: null,
  };
}

class AppState {
  /* 响应式 —— 这里只放**全局**（不跟工程走）的 UI 状态。
     跟工程走的东西在 `OpenProject` 上，由 getter/setter 转发（见「打开的工程」段）。
     `playT` 与 `selectedClipId` 就属于后者：它们是工程状态，不是界面状态。 */
  version = $state(0);
  playing = $state(false);
  /** 当前生效的吸附档位（永远属于 `timelineMode` 的那一档表）。 */
  snap = $state<SnapMode>('bar');
  /** 时间轴形态（标尺文案 / 工具条 / 吸附档位三处分支的唯一开关）。 */
  timelineMode = $state<TimelineMode>('beat');
  /**
   * 每个形态各记一份吸附档位（非响应式：它只在切换形态那一下被读，
   * 界面上没有任何东西直接读它）。
   *
   * 为什么不是「改过就不覆盖」的布尔标记：那样在两态之间来回切一次，
   * 用户为节奏模式选的「拍」就永久丢了 —— 表现是「切回来吸附变了」。
   */
  private snapByMode: Record<TimelineMode, SnapMode> = { beat: 'bar', standard: 'free' };
  pxPerBeat = $state(28);
  /**
   * 拖拽中的落点是否会被 reject 策略拒收（给被拖片段加「不可落」样式）。
   * 只读，由 timeline/drag.ts 的 onHint 写入——拖动结束时必须归 false。
   */
  dragIllegal = $state(false);
  /**
   * 当前打开的 Modal 数量（由 `controls/Modal.svelte` 自己增减）。
   *
   * 全局快捷键（App.svelte 的 onKey）在 > 0 时整段让路：modal 是真正的模态，
   * 否则「在预剪辑弹窗里按空格」会同时把主时间线也播起来 —— 两个 onKey 都挂在
   * window 上，`preventDefault()` 挡不住另一个监听器。
   *
   * **刻意不是 `$state`**：它只在事件回调里被读，没有任何视图依赖它。写成
   * `$state` 并在 `Modal` 的 `$effect` 里 `+=` 会自我追踪（`+=` 同时读与写），
   * 直接触发 Svelte 的 `effect_update_depth_exceeded` —— 表现是弹窗一打开
   * 整个响应式系统就崩，播放画面停在某一帧。
   */
  modalDepth = 0;
  waveforms = $state<Record<string, WaveformData>>({});
  /** 新关键帧默认锚到拍（Inspector 的 ◆ 按钮读这个）。 */
  beatAnchorNewKeys = $state(true);
  /** 导出进行中的进度（null = 没在导出）。 */
  exportProgress = $state<number | null>(null);
  /**
   * 自动保存降级到本地草稿的原因（null = 一切正常）。
   *
   * 与 `notice` 分开：`notice` 是一次性的（几秒后消失），这条是**常驻**的 ——
   * 只要磁盘上的工程不是最新的，用户就该一直看得到。
   */
  autosaveFailure = $state<string | null>(null);
  /** 降级（草稿写成功了）还是彻底失败（草稿也没写进去）。文案不同。 */
  autosaveFatal = $state(false);
  /**
   * 「激活工程的 store 变了」的唯一钩子（自动保存订阅它）。
   *
   * 为什么放在 `subscribeActive` 里而不是组件里：那里是**所有**工程切换与
   * 后台改动的必经之路。组件里监听会漏掉脚本/agent 路径，而漏掉的表现
   * 正是「自动保存时好时坏」。
   */
  onStoreChange: (() => void) | null = null;
  /**
   * 「马上要离开当前工程了」的钩子（自动保存用它把这一份冲掉）。
   *
   * 在改 `activeProjectId` **之前**调用：快照在同步阶段就把当前工程固定住，
   * 之后的异步写入按 `draftKey` 找回那一份 —— 所以不会把 A 写进 B。
   */
  onProjectSwitch: (() => void) | null = null;
  /**
   * 「一份工程被关掉了」（参数是它的草稿键）。
   *
   * 关闭是**用户确认过的丢弃**（`closeProject` 的 `'dirty'` 分支），所以这里
   * 要做的是取消并删掉那份草稿 —— 否则「确认丢弃」之后下次启动还会问一遍。
   */
  onProjectClosed: ((draftKey: string) => void) | null = null;
  /** 导出的取消器（非响应式）。 */
  exportAbort: AbortController | null = null;
  /**
   * 一次性操作提示（Alt+↑↓ 被策略挡住、保存结果等）。
   *
   * `noticeLevel` 决定底栏那段的颜色 —— 保存成功再用红色报，
   * 用户第一眼会以为失败了。
   */
  notice = $state<string | null>(null);
  noticeLevel = $state<'info' | 'success' | 'error'>('info');
  private noticeTimer: ReturnType<typeof setTimeout> | null = null;

  /**
   * 预览帧率。**只用于 UI 展示**，不参与任何渲染求值——AGENTS §1.1 规定渲染
   * 时间的唯一来源是 t，这里读 performance.now() 仅仅是统计显示，不喂给 renderFrame。
   */
  fps = $state(0);
  private fpsFrames = 0;
  private fpsAt = 0;

  /**
   * 时间轴 ruler 的拖动手势是否在进行中。见 `beginScrub`。
   */
  scrubActive = $state(false);
  /**
   * 还有多少模拟帧没追上播放头（0 = 已经落在精确帧上）。
   *
   * 拖动时画面会比播放头**早**（见 `syncSimBudget`），不提示的话用户会以为
   * 预览坏了。底栏拿它显示「计算中」。非响应式的 `simBudgetMs` 是去重用的。
   */
  simLag = $state(0);
  private simBudgetMs = 0;

  /** 右侧检查器抽屉。默认展开，宽度可拖，两者都持久化。 */
  drawerOpen = $state(true);
  // 显式标注 number：DENSITY 是 as const，不标注会推成字面量类型 300。
  drawerWidth = $state<number>(DENSITY.drawerW);

  /** 左侧媒体池抽屉。默认收起（要用时才拉开），宽度可拖，两者都持久化。 */
  mediaPoolOpen = $state(false);
  mediaPoolWidth = $state<number>(DENSITY.poolW);

  /**
   * 左侧 Agent 抽屉。与媒体池**共用同一列与同一份宽度**，所以绝不能同时开
   * （同时开会让 `.body` 的网格多出一列，画面被挤两次）。
   */
  agentOpen = $state(false);

  /**
   * 左侧调制器抽屉。与媒体池 / Agent **共用左列**，所以三者互斥。
   *
   * 不落盘（`UiPrefs` 里没有它）：这是「这一次在调什么」的临时状态，而
   * 媒体池开不开属于工程级的浏览习惯。下次打开应用时不该自动弹出一个参数面板。
   */
  modulatorOpen = $state(false);

  /**
   * 正在全屏编辑的调制器 id（`null` = 没打开编辑器）。
   *
   * 编辑器是 modal 而列表是抽屉：列表要能被拖到右侧检查器的参数行上，
   * 而 modal 会把整屏盖住 —— 两件事不能是同一个浮层。
   */
  modulatorEditId = $state<string | null>(null);

  /* ---- 调色页（`grade-*` 片段的全屏子界面） ----
   *
   * 打开状态跟着**工程视图**走（`view.kind === 'grade'`），与排版编辑页同一套：
   * 切到别的工程再切回来，还停在调色页；关掉工程页也就没了。
   *
   * 目标是**效果片段**（不是实例）：调色的四个模块同属一条链，页面一次展示
   * 整条链，实例用面板内的分段按钮切换。
   */
  /** 页面里选中的实例（`null` = 自动取链上第一个调色模块）。 */
  gradeInstanceId = $state<string | null>(null);
  /**
   * 「前 / 后对比」：为真时整条调色链旁路。
   *
   * 它是**渲染层**的开关（`renderer.setBypassEffect`），不是工程数据 ——
   * 离开调色页 / 松手都必须复位，否则用户下次进来会以为调色没生效。
   */
  gradeBypass = $state(false);


  /* ---- 预览质量（只影响预览；导出永远全帧全质） ----
   *
   * 这三项是「怎么看」，所以跟界面偏好走（localStorage），**不进 project.json**：
   * 它们不该让工程变脏，也不该随工程共享给别的机器。
   */
  previewFpsDiv = $state<number>(1);
  previewScale = $state<number>(1);
  previewRestoreOnPause = $state(true);
  previewBarCollapsed = $state(false);
  /** 正在把当前帧导出成 PNG（挡住连点、禁用按钮；见 `snapshotFrame`）。 */
  snapshotting = $state(false);
  shortcutScheme = $state<ShortcutScheme>('artmatic');
  /** 左下角的看板娘（设置 → 外观）。默认关。 */
  mascotEnabled = $state(false);
  /**
   * 检查器「缩放 X / Y」联动。默认开 —— 绝大多数素材是等比缩放的，
   * 而两个分开的滑杆会让「只想放大一点点」变成两次拖动。
   */
  scaleLinked = $state(true);

  /* ---- 跨剪切点两帧预览（达芬奇式交互） ----
   *
   * 命中判据是**左闭右开**（`engine/stack.ts`：`t >= clip.end` 的片段不参与合成），
   * 所以播放头停在剪切点（= 上游片段的 `end`）时，预览显示的是**下游片段的开头**
   * —— 在末尾帧打关键帧就成了盲操。这里补两条入口把「前一帧」也摆到画面上。
   *
   * 三个信号：
   *  - `editingKey`：检查器里某个 `KeyableField` 正在被设置值（拖动滑杆/数字框、
   *    方向键）。由 `KeyableField` 写入，**自动模式**靠它判断「正在设哪条片段的关键帧」。
   *    不用 DOM 查询判「谁被聚焦」——那在组件重排/结构化克隆下很脆。
   *  - `splitDrag`：预览画面上横向拖动越过了阈值（`Preview.svelte` 写）。**临时**出现。
   *  - `splitVisible`：当前是否正在显示两帧并排（渲染侧写，模板读）。 */
  editingKey = $state<{ clipId: string; curveKey: string } | null>(null);
  splitDrag = $state(false);
  splitVisible = $state(false);
  private splitLeftEl: HTMLCanvasElement | null = null;
  private splitRightEl: HTMLCanvasElement | null = null;
  /** 用来量可用区域（`.preview` 容器；**不是**浮层本身 —— 浮层在首帧还是 display:none，量到 0）。 */
  private splitHostEl: Element | null = null;
  /** 翻行用的临时画布，惰性建、复用。 */
  private splitScratch: HTMLCanvasElement | null = null;

  /* ---- 抠图吸管（片段级取色）
   *
   * 吸管取的是**这一层自己的颜色**，所以取色时必须只渲染这一层所在的那条视觉轨
   * （见 `pickKeyColorAt`）。它是「下一帧别再走普通合成」的一次性模式，不是
   * 跟工程走的文档状态，所以放在全局 $state 段。
   *
   * `null` = 不在取色模式；非 null = 正在为哪个片段的键色取色。 */
  keyPickClipId = $state<string | null>(null);

  /* ---- 排版编辑器（全局，不跟工程走：这是「怎么看」，不是「看什么」） ---- */

  /** 预览光栅化倍率（1 = 跟随渲染尺寸，0.5 / 0.25 = 低画质）。 */
  typoPreviewScale = $state<number>(1);
  /** 对齐目标：「画布」= 相对幻灯片（PPT 叫法），「选区」= 相对选中集外接框。 */
  typoAlignTarget = $state<'canvas' | 'selection'>('canvas');
  /** 网格 / 画幅线框。整块作为一个偏好项存，避免每加一个开关就改四处持久化代码。 */
  typoGrid = $state<TypoGridPrefs>({ ...DEFAULT_TYPO_GRID });
  /** 右侧「图层 / 元素属性」面板宽度（可拖）。 */
  typoPanelWidth = $state<number>(TYPO_PANEL_W.default);
  /** 关键帧面板高度（可上下拖）与展开状态。 */
  typoKfHeight = $state<number>(TYPO_KF_H.default);
  typoKfOpen = $state<boolean>(true);
  /** 运行排版文档里的脚本（默认关，见 `UiPrefs.runTypoScripts`）。 */
  runTypoScripts = $state<boolean>(false);
  /** 轨道区高度（可拖；与两个抽屉宽度同一套「实例值 + setter」纪律）。 */
  timelineHeight = $state<number>(TRACKS_H.default);
  /** 波纹删除（删片段后同轨后面的片段前移补位）。默认关，见 `UiPrefs.rippleEdit`。 */
  rippleEdit = $state<boolean>(false);
  /** 节拍器开关（工具条的两态按钮）。默认关，见 `UiPrefs.metronome`。 */
  metronomeOn = $state<boolean>(false);
  /** 媒体池列表形态（缩略图 / 紧凑），两个视图共用。 */
  poolView = $state<PoolView>('thumbs');
  /** 媒体池排序档位（组内顺序）。 */
  poolSort = $state<PoolSort>('added');
  /**
   * 媒体池的拼音转换器是否已就绪（`ui/pool-pinyin.ts` 按需加载）。
   *
   * 它**不是偏好**（不落盘）：只是一个「列表该重算一次」的信号 —— 用户点进搜索框
   * 之后库才开始下载，下载完必须让已经打出的那串查询重新过滤一遍，否则拼音命中
   * 的条目要等到下一次敲键才出现。
   */
  poolPinyinReady = $state(false);

  markPoolPinyinReady(): void {
    if (!this.poolPinyinReady) this.poolPinyinReady = true;
  }
  /**
   * 已注册的字体族（Ribbon 的字体下拉读它）。
   * 做成响应式而不是每次读 registry：注册发生在异步导入之后，
   * 不触发重算的话「导入成功了但下拉里没有」。
   */
  fontFamilies = $state<string[]>([]);

  /* ---------------------------------------------------------------- 插件 */

  /**
   * 插件宿主。**进程级单例，但按工程记账** —— 哪份工程挂了哪些插件由
   * `holder` 引用计数管（见 `plugins/host.ts` 的文件头）。
   *
   * 名字不叫 `host`：`attachPreview(canvas, host)` 的第二个参数是**显示容器**，
   * 同名会让人以为两者有关系。
   */
  plugins = new PluginHost();

  /**
   * 插件集合的版本号（`PluginHost.revision()` 的响应式镜像）。
   *
   * 选择器 / 时间轴菜单读它建立依赖：没有这一层的话，插件挂载后那些
   * 「模块级算一次」的清单不会重算，表现是「装了插件但菜单里没有」。
   * 与 `fontFamilies` 同一个套路（那边是 `FontRegistry.revision`）。
   */
  pluginRevision = $state(0);

  /**
   * 从**本机**枚举来的字体族（只在这台机器上有）。
   *
   * 与 `fontFamilies` 分开存是必须的：那个是 `FontRegistry` 的镜像 —— 有 FontFace、
   * 有字节、导出时能子集化嵌入；这个是系统字体 —— **不可嵌入**，换台机器就没了。
   * 混成一份的话，「导出时这个字体该不该嵌进去」就失去了判据。
   */
  localFontFamilies = $state<string[]>([]);

  /** 字体表变更后调一次（注册内置字体、用户导入之后）。 */
  refreshFontFamilies(): void {
    this.fontFamilies = this.fonts.families();
  }

  /** 当前环境能不能读本机字体（入口按钮据此置灰）。只在 Chromium 桌面版有。 */
  get supportsLocalFonts(): boolean {
    return localFontSource() !== null;
  }

  /**
   * 读本机字体。
   *
   * **必须由用户点击触发** —— 这个 API 要求用户手势，启动时自动调会直接 reject。
   * 三种失败要分开说：合成一句「读取失败」会让用户不知道该去浏览器设置里授权，
   * 还是该换个浏览器。
   */
  async loadLocalFonts(): Promise<void> {
    const r = await queryLocalFontFamilies();
    switch (r.kind) {
      case 'ok':
        this.localFontFamilies = r.families;
        this.flash(tr('typo.localFontsLoaded', { n: r.families.length }), 'success');
        return;
      case 'denied':
        this.flash(tr('typo.localFontsDenied'), 'error');
        return;
      case 'unsupported':
        this.flash(tr('typo.localFontsUnsupported'), 'error');
        return;
      default:
        this.flash(tr('typo.localFontsFailed', { msg: r.message }), 'error');
    }
  }

  /** 局部更新网格设置（只写要覆盖的键，与工程的参数覆盖同一套思路）。 */
  setTypoGrid(patch: Partial<TypoGridPrefs>): void {
    this.typoGrid = normalizeTypoGrid({ ...this.typoGrid, ...patch });
    this.persistUi();
  }

  setTypoPanelWidth(w: number): void {
    const next = clampTypoPanelWidth(w);
    if (this.typoPanelWidth === next) return;
    this.typoPanelWidth = next;
    this.persistUi();
  }

  setTypoKfHeight(h: number): void {
    const next = clampTypoKfHeight(h);
    if (this.typoKfHeight === next) return;
    this.typoKfHeight = next;
    this.persistUi();
  }

  setTypoKfOpen(open: boolean): void {
    if (this.typoKfOpen === open) return;
    this.typoKfOpen = open;
    this.persistUi();
  }

  /**
   * 开关排版脚本。
   *
   * `store.touch()` 不能省：光栅化缓存键里的模式盐跟着变，但**已经烘好的
   * 纹理还在缓存里**，不 bump version 的话预览与舞台都不会重画 ——
   * 表现是「打开了脚本开关，画面没有任何变化」。
   */
  setRunTypoScripts(on: boolean): void {
    if (this.runTypoScripts === on) return;
    this.runTypoScripts = on;
    this.persistUi();
    if (this.projects.length) this.store.touch();
  }

  /* ---------------------------------------------------------- 打开的工程 */

  /** 至少一个，顺序即选项卡顺序。**允许为空**（空 = 显示空界面）。 */
  projects = $state<OpenProject[]>([]);
  activeProjectId = $state<string>('');

  private readonly placeholder = createPlaceholder();

  /** 有没有打开任何工程。界面据此决定是渲染主界面还是空界面。 */
  get hasProject(): boolean {
    return this.projects.length > 0;
  }

  get activeProject(): OpenProject {
    return (
      this.projects.find((p) => p.id === this.activeProjectId) ??
      this.projects[0] ??
      this.placeholder
    );
  }

  /**
   * 当前工程的文档真相。**所有写库都走它**，所以它必须是动态的 ——
   * 任何 `const store = appState.store` 之后跨越工程切换的代码，
   * 都会写到已经不在前台的那份工程上。
   */
  get store(): ProjectStore {
    return this.activeProject.store;
  }

  /**
   * 当前工程的素材仓。
   *
   * ⚠️ **不要 import 模块级的素材仓**（那是个跨工程单例）：
   * 共用它会让保存 A 时把 B 导入的素材一起写进 A 的 `assets/`。
   */
  get assets(): AssetStore {
    return this.activeProject.assets;
  }

  /* 播放头与选中态是**工程级**的：切回来时停在离开的位置，
     而不是被另一份工程的进度带走。 */
  get playT(): number {
    return this.activeProject.playT;
  }
  set playT(v: number) {
    this.activeProject.playT = v;
  }

  /**
   * 选中集。写它必须是**新数组**（原地 push 不会让 $state 的深代理换引用，
   * 但为了「同一个值不重复触发」的判重方便，统一走 setClipSelection / 赋值）。
   */
  get selectedClipIds(): string[] {
    return this.activeProject.selectedClipIds;
  }
  set selectedClipIds(v: string[]) {
    this.activeProject.selectedClipIds = [...v];
  }

  /**
   * 主选中片段 —— 检查器、S 键切分、Alt+↑↓ 作用的对象。
   *
   * 它是 `selectedClipIds` 的**视图**（第一个元素），写它等价于单选。
   * 取第一个而不是最后一个：框选出来的一整片没有「最近点的那个」可言，
   * 第一个在拖动过程中是稳定的。
   */
  get selectedClipId(): string | null {
    return this.activeProject.selectedClipIds[0] ?? null;
  }
  set selectedClipId(v: string | null) {
    this.activeProject.selectedClipIds = v === null ? [] : [v];
  }

  isClipSelected(id: string): boolean {
    return this.activeProject.selectedClipIds.includes(id);
  }

  /** 单选：清空其余（点一个片段的标准语义）。 */
  selectClip(id: string): void {
    this.activeProject.selectedClipIds = [id];
  }

  /** Shift / Ctrl + 单击：在集合里增删一个。减到空是合法的（= 取消选择）。 */
  toggleClipSelection(id: string): void {
    const ids = this.activeProject.selectedClipIds;
    this.activeProject.selectedClipIds = ids.includes(id)
      ? ids.filter((x) => x !== id)
      : [...ids, id];
  }

  /**
   * 整体替换选中集（框选的实时结果）。
   *
   * 判重是必要的：框选每帧都会算一次命中集，不判重的话每个 pointermove
   * 都换一个新数组，整条时间轴的片段都跟着重渲染一次。
   */
  setClipSelection(ids: readonly string[]): void {
    const cur = this.activeProject.selectedClipIds;
    if (cur.length === ids.length && ids.every((id, i) => cur[i] === id)) return;
    this.activeProject.selectedClipIds = [...ids];
  }

  /**
   * 删除全部选中片段（Delete）。
   *
   * 走 `store.removeClips` 的**一笔撤销**：逐个 removeClip 会让「框选 5 个
   * 按 Delete」在撤销栈里留下 5 条记录 —— 用户按一次 Ctrl+Z 只回来一个，
   * 看起来就是「撤销坏了」。
   */
  removeSelectedClips(): void {
    this.removeClips([...this.activeProject.selectedClipIds]);
  }

  /**
   * 删除若干片段（一笔撤销）。`rippleEdit` 开着时同时把同轨后面的片段前移补位
   * —— 屏幕上的删除按钮、Delete 键、检查器的删除按钮都走这里，否则「开着波纹
   * 但在某个入口点删除却没补位」会让人以为是偶发 bug。
   */
  removeClips(clipIds: readonly string[]): void {
    if (!clipIds.length) return;
    this.store.removeClips(clipIds, { ripple: this.rippleEdit });
    const gone = new Set(clipIds);
    this.activeProject.selectedClipIds = this.activeProject.selectedClipIds.filter(
      (id) => !gone.has(id),
    );
  }

  /**
   * 改素材的展示名（媒体池右键 → 重命名素材）。文件名与路径一个字都不动。
   *
   * 工程表那一份是真相（随工程保存），素材仓里的镜像跟着改，否则「未使用素材」
   * 与源变化提示会继续报旧名字。
   */
  renameAsset(id: string, name: string): void {
    const next = name.trim();
    const asset = this.store.project.assets[id];
    if (!asset || !next || asset.name === next) return;
    this.store.renameAsset(id, next);
    this.assets.setInputName(id, next);
  }

  /* -------------------------------------------------- 片段剪贴板（复制 / 剪切 / 粘贴）
   *
   * 写系统剪贴板（keydown 手势里，`clipboard.writeText` 要瞬时激活）**之外**
   * 还留一份内存副本：权限被拒 / 非安全上下文时本应用内照样能粘贴。
   * 内存副本是模块私有字段而不是 $state —— 没有任何 UI 读它（ Ctrl+V 的
   * 兜底分支读的是 `clipClipboardFallbackActive()`，那是个方法）。
   */
  private clipClipboard: ClipboardPayload | null = null;
  /** 上次复制/剪切有没有写进系统剪贴板（决定 Ctrl+V 走哪条路）。 */
  private clipClipboardSystemOk = false;

  /** 复制选中片段。没有选中片段时什么都不做（快捷键不该弹一句错）。 */
  copySelectedClips(): void {
    const entries = this.selectedClipEntries();
    if (!entries.length) return;
    const text = serializeClips(entries, this.store.project.name);
    this.clipClipboard = parseClipboard(text);
    void platform.writeTextToClipboard(text).then((res) => {
      this.clipClipboardSystemOk = res === 'ok';
      this.flash(
        res === 'ok' ? tr('tl.copied', { n: entries.length }) : tr('tl.copyLocalOnly'),
        res === 'ok' ? 'success' : 'info',
      );
    });
  }

  /** 剪切 = 复制 + 删除（删除本身是一笔撤销，见 removeSelectedClips）。 */
  cutSelectedClips(): void {
    const entries = this.selectedClipEntries();
    if (!entries.length) return;
    const text = serializeClips(entries, this.store.project.name);
    this.clipClipboard = parseClipboard(text);
    this.removeSelectedClips();
    void platform.writeTextToClipboard(text).then((res) => {
      this.clipClipboardSystemOk = res === 'ok';
      this.flash(
        tr(res === 'ok' ? 'tl.cut' : 'tl.cutLocalOnly', { n: entries.length }),
        res === 'ok' ? 'success' : 'info',
      );
    });
  }

  /**
   * Ctrl+V 的兜底激活判据：内存里有片段、且**上次没写进去**系统剪贴板。
   *
   * 写得进去时返回 false —— 那时 Ctrl+V 不拦截，让 `paste` 事件读系统剪贴板
   * （最新内容，包括从别的窗口复制进来的片段 JSON）。不这么分的话，应用内
   * 的旧副本会一直盖住系统剪贴板里的新内容。
   */
  clipClipboardFallbackActive(): boolean {
    return this.clipClipboard !== null && !this.clipClipboardSystemOk;
  }

  /** 选中片段 + 它们所在的轨（剪贴板载荷的一半）。 */
  private selectedClipEntries(): ClipboardEntry[] {
    const ids = new Set(this.activeProject.selectedClipIds);
    if (!ids.size) return [];
    const out: ClipboardEntry[] = [];
    for (const t of this.store.project.tracks) {
      for (const c of t.clips) {
        if (ids.has(c.id)) out.push({ trackId: t.id, clip: c });
      }
    }
    return out;
  }

  /**
   * 粘贴片段。两条入口共用：`onPaste` 从系统剪贴板解析出载荷时传进来，
   * Ctrl+V 兜底分支不传（用内存副本）。
   *
   * 落点：吸附后的播放头 + 各片段相对偏移；轨道优先级见 `planPaste`
   * （原轨位 → 选中轨 → 第一条能装的轨）。片段一律换**新 id** ——
   * 同工程粘贴留下原 id 会让 `findClip` 找到源片段。
   *
   * 跨工程 / 素材被删时 assetId 在目标工程里不存在：照常粘贴，画面按
   * 「脱机媒体」占位符表现（`core/offline-media.ts`），并提示一句。
   */
  pasteClipsFromClipboard(payload?: ClipboardPayload | null): void {
    const p = payload ?? this.clipClipboard;
    if (!p) {
      this.flash(tr('tl.pasteEmpty'), 'info');
      return;
    }
    const grid = this.store.project.beatGrid;
    const anchor = snapTimeWithSections(
      this.playT,
      this.snap,
      grid,
      this.store.project.sections,
      this.store.project.fps,
      this.store.project.beatMarks,
    );
    const plans = planPaste(p, {
      tracks: this.store.project.tracks.map((t) => ({ id: t.id, kind: t.kind })),
      preferredTrackId: this.selectedClipId
        ? (this.store.findClip(this.selectedClipId)?.track.id ?? null)
        : null,
      knownAssetIds: new Set(Object.keys(this.store.project.assets)),
      grid,
    });
    const items = plans
      .filter((pl): pl is PastePlanItem & { trackId: string } => pl.trackId !== null)
      .map((pl) => ({
        trackId: pl.trackId,
        clip: { ...pl.clip, id: newId(), start: pl.clip.start + anchor, end: pl.clip.end + anchor },
      }));
    if (!items.length) {
      this.flash(tr('tl.pasteNoTrack'), 'error');
      return;
    }
    const placed = this.store.pasteClips(items, tr('tl.pasteClips', { n: items.length }));
    this.setClipSelection(items.slice(0, placed).map((i) => i.clip.id));
    const missing = plans.some((pl) => pl.assetMissing);
    this.flash(
      missing ? tr('tl.pasteMissingMedia') : tr('tl.pasted', { n: placed }),
      missing ? 'info' : 'success',
    );
  }

  /* ---- 会话属性：原来是单例上的字段，现在转发到激活工程 ---- */

  get projectDir(): FsDirHandle | null {
    return this.activeProject.dir;
  }
  set projectDir(v: FsDirHandle | null) {
    this.activeProject.dir = v;
  }

  get projectKey(): string | null {
    return this.activeProject.key;
  }
  set projectKey(v: string | null) {
    this.activeProject.key = v;
    // 带上句柄 key 就意味着「这份工程在磁盘上、可以恢复」——同步给离开后
    // 回来时的恢复提示（`useOpfs` / 另存到此处都只经过这一个 setter）。
    this.syncOpenTabs();
  }

  /**
   * 展示名。**只读** —— 它直接来自 `Project.name`。改名要写库
   * （`store.commit`），不另存一份，否则「面板显示的名字」与
   * 「磁盘上 `project.json` 里的名字」会漂移。
   */
  get projectName(): string {
    return this.activeProject.store.project.name || tr('proj.unnamed');
  }

  /** 上次保存时的 `store.version`；-1 = 从未保存过。 */
  get savedVersion(): number {
    return this.activeProject.savedVersion;
  }
  set savedVersion(v: number) {
    this.activeProject.savedVersion = v;
  }

  get savedAt(): number {
    return this.activeProject.savedAt;
  }
  set savedAt(v: number) {
    this.activeProject.savedAt = v;
  }

  get projectIssues(): AssetIssue[] {
    return this.activeProject.issues;
  }
  set projectIssues(v: AssetIssue[]) {
    this.activeProject.issues = v;
  }

  /**
   * 有未保存改动。
   *
   * `savedVersion !== version` 是个**近似**（改完再撤销回原样仍然算脏），
   * 但方向是安全的那一边：假阳性只是多问一句「要保存吗」，
   * 假阴性才是丢工作。
   */
  get projectDirty(): boolean {
    return this.activeProject.savedVersion !== this.activeProject.store.version;
  }

  /* ------------------------------------------------------ 工程的增删切换 */

  /**
   * 把一个**已经装配好**的工程挂到选项卡上并激活它。
   *
   * 装配（建空白 / 读盘 / 装素材）在 `ui/project-actions.ts` ——
   * 这里只管登记与切换，不碰文件系统。分开是为了让「新开一份」与
   * 「从磁盘打开」共用同一条登记路径。
   */
  adoptProject(init: {
    store: ProjectStore;
    assets?: AssetStore;
    dir?: FsDirHandle | null;
    key?: string | null;
    savedVersion?: number;
    savedAt?: number;
    issues?: AssetIssue[];
    agentSessions?: AgentSessionRecord[];
    /** 立刻激活。默认 true。 */
    activate?: boolean;
  }): OpenProject {
    const p: OpenProject = {
      id: newId(),
      store: init.store,
      assets: init.assets ?? createAssetStore(),
      view: { kind: 'timeline' },
      dir: init.dir ?? null,
      key: init.key ?? null,
      savedVersion: init.savedVersion ?? -1,
      savedAt: init.savedAt ?? 0,
      draftKey: newId(),
      issues: init.issues ?? [],
      playT: 0,
      selectedClipIds: [],
      agentSessions: init.agentSessions ?? [],
      agentHistoryDir: null,
    };
    this.projects.push(p);
    if (init.activate !== false) this.activateProject(p.id);
    this.syncOpenTabs();
    return p;
  }

  /**
   * 把「当前打开着哪几份工程」同步到 localStorage。
   *
   * 供离开页面（`/lab` 是另一个 HTML 入口）后回到主应用时提示恢复用。
   * 只记带句柄 key 的工程 —— 内存里没保存过的无从恢复。
   */
  private syncOpenTabs(): void {
    saveOpenTabs(
      this.projects
        .filter((p): p is OpenProject & { key: string } => !!p.key)
        // 名字取工程的（`Project.name`），不是目录名 —— 恢复提示上写的是给用户的
        // 那份标识。改名之后 `syncOpenTabs` 也会跟着更新（`store.touch` 不触发它，
        // 但关/开/切都会，而提示只在「回来时」读一次）。
        .map((p) => ({ key: p.key, name: p.store.project.name || p.dir?.name || p.key })),
    );
  }

  /**
   * 后台完成的保存（用户在中途切走了）要更新「打开着的工程」记录。
   *
   * 正常路径走 `projectKey` setter 就够了；但保存现在可能写几 GB 素材，
   * 期间切选项卡不是边缘情况 —— 直接写 `p.key` 就得手动补这一步。
   */
  refreshOpenTabs(): void {
    this.syncOpenTabs();
  }

  /**
   * 拖曳调整选项卡顺序。
   *
   * 只动 `projects` 数组本身：`activeProjectId` 是 id，不随位置变 ——
   * 所以「拖动选项卡」不会顺带切换当前工程（那会是最难解释的一种行为）。
   */
  moveProject(from: number, to: number): void {
    const n = this.projects.length;
    if (from === to || from < 0 || to < 0 || from >= n || to >= n) return;
    const [moved] = this.projects.splice(from, 1);
    if (moved) this.projects.splice(to, 0, moved);
  }

  /**
   * 切到另一份工程。
   *
   * 顺序有讲究：**先 `pause()` 再改 `activeProjectId`** —— `pause` 会把
   * 播放位置写回「当前工程」，而 getter 在改完 id 之后就指向新工程了，
   * 那样会把 A 的播放头写进 B。
   */
  activateProject(id: string): void {
    if (this.activeProjectId === id) return;
    if (!this.projects.some((p) => p.id === id)) return;

    if (this.playing) this.pause();
    // 离开前取消未结算的手势：绝不能让 beginTx 悬空，否则撤销栈会错乱。
    this.pendingGestureCancel?.();
    this.pendingGestureCancel = null;
    /*
     * 调色旁路是**渲染器**的状态，不跟工程走：留着它会让「切到 B 却还在看 A
     * 的原片」。必须在切换前清掉（此时 `gradeClipId` 还指向 A）。
     */
    if (this.gradeBypass) this.setGradeBypass(false);
    // 同一时刻：把即将离开那一份的自动保存冲掉（此时快照还指向它）。
    this.onProjectSwitch?.();

    this.activeProjectId = id;
    this.subscribeActive();
    // 两份工程的分辨率可能不同，必须重新同步显示尺寸。
    this.refreshPreview();
    // 音频位置属于上一份工程，停掉。素材仓各自独立，不用动。
    this.player?.stop();
    this.syncOpenTabs();
  }

  /**
   * 关闭一份工程。
   *
   * - **脏的返回 `'dirty'`，由调用方弹确认**（`force: true` 才真关）。
   *   这里刻意不「直接拒绝」：拒绝之后用户既关不掉、也不知道下一步该干什么。
   *   改动只活在内存里，所以确认框必须说清后果是**丢失**。
   * - **关掉最后一份就真的空了**：界面切到空界面（新建 / 导入 / 最近），
   *   而不是悄悄补一份空白工程。原先是补一份的 —— 后果是「关掉空工程」
   *   看起来毫无反应（关了又冒出来一个一模一样的），那正是用户报的现象。
   *   所有读取者拿到的回落值见 `placeholder`。
   */
  closeProject(id: string, opts: { force?: boolean } = {}): 'ok' | 'dirty' | 'missing' {
    const i = this.projects.findIndex((p) => p.id === id);
    if (i < 0) return 'missing';
    const p = this.projects[i]!;
    if (!opts.force && p.savedVersion !== p.store.version) return 'dirty';

    const wasActive = p.id === this.activeProjectId;
    if (wasActive) {
      if (this.playing) this.pause();
      this.pendingGestureCancel?.();
      this.pendingGestureCancel = null;
      // 关掉 = 用户确认丢弃；取消排队中的自动保存并清掉这份草稿。
      this.onProjectClosed?.(p.draftKey);
    }

    this.projects.splice(i, 1);
    this.syncOpenTabs();

    /*
     * 释放这份工程持有的插件。现在才做（而不是在 splice 之前）是为了让
     * `refreshPreview` 里的渲染读到的仍是**关闭前**的工程 —— 顺序反了的话，
     * 卸载插件会让当前画面短暂地「缺一半特效」再被下一次渲染修正。
     *
     * 只有**没有其它打开工程引用同一个 pluginId** 时才真的卸载（引用计数）。
     */
    this.plugins.release(p.id);

    // 素材资源跟着工程一起放掉（纹理 / 解码器 / 解码位图 / 频谱分析）。
    this.releaseProjectAssets(p);

    if (this.projects.length === 0) {
      this.activeProjectId = '';
      // 回落值不是一个真的工程，没有版本可订阅；退订并把 version 归零，
      // 否则界面还会挂在最后一份工程的计数上。
      this.unsubActive?.();
      this.unsubActive = null;
      this.version = 0;
      this.player?.stop();
      return 'ok';
    }

    if (wasActive) {
      // 落在原来那个位置（删掉末尾就往前退一个）。
      this.activeProjectId = this.projects[Math.min(i, this.projects.length - 1)]!.id;
      this.subscribeActive();
      this.refreshPreview();
      this.player?.stop();
    }
    return 'ok';
  }

  /**
   * 把一份工程占的**素材级**资源还回去。
   *
   * ## 为什么必须有这一条
   *
   * 这些资源都是「按 assetId 记账、进程级存活」的：视频的顺序解码器 + 帧缓存
   * 纹理、解码后的图片 canvas 与它的 GL 纹理、AudioBuffer、频谱分析、波形。
   * 它们**不会**因为工程从选项卡里消失而消失 —— 关闭一份 2 GB 素材的工程再开
   * 下一份，两份的显存叠在一起，而用户看不到任何提示（表现是「用得越久越卡、
   * 偶发 context lost」）。这正是「有 `forget()` 但零调用方」的那种漏洞：
   * 接口在，生命周期钩子没接。
   *
   * 判据取「工程声明的素材」∪「素材仓里的素材」：前者是真相，后者兜住
   * 「导入了但还没 commit 进工程」的中间态。
   *
   * 素材级之外的东西（排版位图按文档哈希记账、特效反馈池按实例记账）不在这里
   * 回收，它们由各自的**在屏集合**决定（见 typography/runtime.ts 与
   * engine/compositor.ts）：没有工程再用它们，下一次淘汰自然放掉。
   */
  private releaseProjectAssets(p: OpenProject): void {
    // ① 片段级的资源：模拟状态纹理（装的是状态，只能显式回收）与音频包络。
    for (const track of p.store.project.tracks) {
      for (const clip of track.clips) {
        if (clip.kind === 'source' && clip.source.type === 'algo') {
          this.algos?.forget(clip.id);
          // 同一片段在**回放侧**还有一份独立的模拟状态（闪回的过去帧用它重渲）
          this.recall?.forget(clip.id);
        }
        if (clip.kind === 'effect') {
          for (const inst of clip.chain) {
            this.audio?.drop(inst.instanceId);
            // 追踪服务按实例持有探针目标与叠层纹理 —— 同样是「不显式回收就
            // 跟着进程一直长」的那一类（见 core/AGENTS.md 的生命周期一条）。
            this.renderer?.dropTrackerInstance(inst.instanceId);
          }
        }
      }
    }

    // ② 素材级的资源：视频（解码器 + 帧缓存纹理）、图片（canvas + 纹理）、
    //    解码后的 AudioBuffer、频谱分析、波形。判据取「工程声明」∪「素材仓」，
    //    后者兜住「导入了但还没 commit 进工程」的中间态。
    const ids = new Set<string>([...Object.keys(p.store.project.assets), ...p.assets.ids()]);
    if (ids.size === 0) return;

    const wave = { ...this.waveforms };
    for (const id of ids) {
      delete wave[id];
      this.releaseAsset(id);
    }
    this.waveforms = wave;
  }

  /**
   * 把**一条**素材占的运行期资源还回去：视频解码器 + 帧缓存、图片的 canvas 与
   * GL 纹理、objectURL、AudioBuffer、频谱分析、波形。
   *
   * 关工程（`releaseProjectAssets`）与媒体池删素材（`removeAsset`）共用这一条 ——
   * 两边各写一份的形态是「删素材时漏了 revoke 图片 URL」，而它只在长会话里表现为
   * 内存慢慢涨。
   */
  private releaseAsset(id: string): void {
    this.video?.forget(id);
    this.sources?.invalidateImage(id);
    forgetMedia(id);
    forgetImageAsset(id);
    this.audio?.forget(id);
    this.player?.forget(id);
    forgetVideoAudio(id);
    const wave = { ...this.waveforms };
    delete wave[id];
    this.waveforms = wave;
  }

  /**
   * 从**媒体池**里移除一条素材（不可撤销，见下）。
   *
   * 两件事必须一起做，少一件都会留下不一致：
   *  - `Project.assets` 里删掉 → 台账下次保存时不再记录它；
   *  - 运行期的仓与缓存放掉（`releaseAsset`）。
   *
   * **字节文件不删**：素材在台账里变成 `retained: true`，
   * 文件留在 `assets/`，工程面板的「未使用素材」能把它恢复回来 ——
   * 所以「移除」是可反悔的。真正的销毁是那边两个动作（进回收站 / 彻底删除），
   * 各自带一次确认。
   *
   * **刻意不入撤销栈**：撤销栈存的是 `Project` 快照，而素材**字节**不在里面 ——
   * 补不回字节的撤销比不能撤销更坏（画面上会变成「缺失素材」）。所以这里弹确认框
   * 说清楚，而不是给一个假的「可撤销」。
   */
  removeAsset(assetId: string): void {
    if (!this.hasProject) return;
    this.store.commit(tr('pool.deleteConfirm'), (p) => {
      delete p.assets[assetId];
    });
    /*
     * **解除关联**，不是销毁。字节来源与台账条目一起转到「保留」区
     * （`retained: true`），保存时照旧写进 `assets/` —— 于是「移除 → 保存 →
     * 重开」之后素材仍然可以被找回。真正的销毁只有「未使用素材」里的
     * 「移到回收站 / 彻底删除」两个动作，各带一次确认。
     */
    this.assets.retire(assetId);
    this.releaseAsset(assetId);
    /*
     * 台账也变了（多了一条 retained），但 `commit` 在「工程里本来就没这条」
     * 时是空操作、不会 bump version。显式通知一次，否则自动保存不会把它写下去。
     */
    this.onStoreChange?.();
  }

  /**
   * 有没有**任何**一份工程带未保存改动。
   *
   * 给 `beforeunload` 用：关整个页面会把所有工程一起丢掉，
   * 而且浏览器不会给我们第二次机会。这里不做响应式（一次性求值），
   * 所以直接读 `store.version` 也拿得到当前值。
   */
  get anyDirty(): boolean {
    return this.projects.some((p) => p.savedVersion !== p.store.version);
  }

  /**
   * 把 `version` 绑到**当前激活工程**的 store 上。
   *
   * 每份工程有自己的 version 计数，所以切换时必须换订阅 —— 否则后台工程的
   * 改动会去刷新前台界面，而前台自己的改动反而看不见。
   */
  private subscribeActive(): void {
    this.unsubActive?.();
    this.version = this.store.version;
    this.unsubActive = this.store.subscribe(() => {
      this.version = this.store.version;
      // 自动保存只关心「有变更」；是否真的该写由它自己的 dirty() 判定。
      this.onStoreChange?.();
    });
  }

  private unsubActive: (() => void) | null = null;

  /* ------------------------------------------------------------ 工程视图 */

  get editorOpen(): boolean {
    return this.activeProject.view.kind === 'typography';
  }

  /** 当前工程停在调色页。与 `editorOpen` 互斥（同一个 `view` 槽）。 */
  get gradeOpen(): boolean {
    return this.activeProject.view.kind === 'grade';
  }

  /** 调色页正在编辑的片段 id（`null` = 不在调色页）。 */
  get gradeClipId(): string | null {
    const v = this.activeProject.view;
    return v.kind === 'grade' ? v.clipId : null;
  }

  get activeTypoClipId(): string | null {
    const v = this.activeProject.view;
    return v.kind === 'typography' ? v.clipId : null;
  }

  /**
   * 打开某个排版片段的编辑页。双击片段、检查器按钮都走这里。
   *
   * 视图是**工程级**的：切到别的工程再切回来，还停在排版页。
   * tab 里**只存 clipId，不复制文档** —— 文档真相始终在 `store.project`，
   * 这是「关掉编辑器再打开，内容还在」的结构保证，不靠「记得保存」。
   */
  openTypographyTab(clipId: string): void {
    this.activeProject.view = { kind: 'typography', clipId };
    if (this.playing) this.pause();
    this.renderer?.onSeek();
  }

  /** 回到某份工程的时间轴视图。默认当前那份。 */
  closeTypographyView(projectId: string = this.activeProjectId): void {
    const p = this.projects.find((x) => x.id === projectId);
    if (!p || p.view.kind !== 'typography') return;
    if (projectId === this.activeProjectId) {
      this.pendingGestureCancel?.();
      this.pendingGestureCancel = null;
    }
    p.view = { kind: 'timeline' };
    if (projectId === this.activeProjectId) this.refreshPreview();
  }

  /**
   * 正在就地改名的片段 id（`ClipView` 据此把那块标签换成输入框）。
   *
   * 放在 appState 而不是 ClipView 内部，是因为**触发点有两个且都在组件外**：
   * 双击标签（那次双击由 ClipView 处理，但它要能设置状态）与 F2（在 App 的
   * 全局快捷键里）。做成组件内部状态的话 F2 就没法让某一行进入编辑态。
   */
  renamingClipId = $state<string | null>(null);

  /** 进入就地改名（双击片段名 / F2）。 */
  beginClipRename(clipId: string): void {
    this.renamingClipId = clipId;
    this.selectedClipId = clipId;
  }

  /** 退出就地改名（提交或取消都走它）。 */
  endClipRename(): void {
    if (this.renamingClipId !== null) this.renamingClipId = null;
  }

  /**
   * 双击片段 = 打开它自己的编辑器。**一律不切分** ——
   * 破坏性操作不该绑在高误触手势上，切分保留 S 键与检查器按钮两个入口。
   *
   * 目前只有 text 源有独立页面；其余类型聚焦检查器（接各自的页面时，
   * 只需要在这里加分支，ClipView 不用动）。
   */
  openClipEditor(clip: AnyClip): void {
    if (clip.kind === 'source' && clip.source.type === 'text') {
      this.openTypographyTab(clip.id);
      return;
    }
    // 特效片段：链里有调色模块就进调色编辑器（双击手势与排版一致），
    // 否则仍然只是打开抽屉。判据是**链上真有 grade-***，不是看片段名字。
    if (clip.kind === 'effect' && clip.chain.some((i) => isGradeDef(i.defId))) {
      this.openGradeEditor(clip.id);
      return;
    }
    this.drawerOpen = true;
    if (clip.kind === 'source') {
      this.flash(tr('proj.noEditorYet'));
    }
  }

  /**
   * 进调色页。判据是**链上真有 `grade-*`**，不是片段名字。
   *
   * 与排版页同一形状：视图存在工程上，页面本身不持有「哪个片段」这份状态。
   * 播放会被暂停 —— 调色要盯着一个稳定的帧，边播边调没有意义。
   */
  openGradeEditor(clipId: string): void {
    const found = this.store.findClip(clipId);
    if (!found || found.clip.kind !== 'effect') return;
    const first = found.clip.chain.find((i) => isGradeDef(i.defId));
    if (!first) return;
    this.selectedClipId = clipId;
    this.gradeInstanceId = first.instanceId;
    this.activeProject.view = { kind: 'grade', clipId };
    // 左列要改成调色侧栏：两个抽屉先收起来，否则它们的图标亮着却不显示。
    if (this.mediaPoolOpen) this.mediaPoolOpen = false;
    if (this.agentOpen) this.agentOpen = false;
    if (this.playing) this.pause();
    this.setGradeBypass(false);
    this.renderer?.onSeek();
  }

  closeGradeEditor(projectId: string = this.activeProjectId): void {
    const p = this.projects.find((x) => x.id === projectId);
    if (!p || p.view.kind !== 'grade') return;
    if (projectId === this.activeProjectId) {
      this.pendingGestureCancel?.();
      this.pendingGestureCancel = null;
      // 离开必须把旁路复位：用户按着「看原片」离开，画面上却还是原片，
      // 会以为调色丢了。
      this.setGradeBypass(false);
      this.gradeInstanceId = null;
    }
    p.view = { kind: 'timeline' };
    if (projectId === this.activeProjectId) this.refreshPreview();
  }

  /**
   * 前 / 后对比。只改渲染层的旁路，**不改工程**，所以不产生撤销记录。
   * 预览要立刻重画一帧，否则「按下去没反应」。
   */
  setGradeBypass(on: boolean): void {
    this.gradeBypass = on;
    this.renderer?.setBypassEffect(on ? this.gradeClipId : null);
    if (on || this.gradeClipId) this.refreshPreview();
  }


  /**
   * 切回时间轴后重同步预览。
   *
   * 隐藏期间显示区域尺寸是 0，不重算的话预览会糊或尺寸不对；
   * `onSeek()` 清反馈历史，免得 echo 的拖尾错乱（与 seek 同语义）。
   */
  refreshPreview(): void {
    this.renderer?.onSeek();
    this.renderer?.syncSize(this.store.project.resolution);
    this.renderer?.renderFrame(this.store.project, this.playT);
  }

  /* ------------------------------------------- 跨剪切点两帧预览（见字段注释） */

  /** 检查器里某个可关键帧字段开始被设置值（`KeyableField` 写）。幂等。 */
  beginEditKey(clipId: string, curveKey: string): void {
    const cur = this.editingKey;
    if (cur && cur.clipId === clipId && cur.curveKey === curveKey) return;
    this.editingKey = { clipId, curveKey };
  }

  /** 停止设置关键帧值。整块信号只有一个槽位，直接清空即可。 */
  endEditKey(): void {
    if (this.editingKey !== null) this.editingKey = null;
  }

  /** 预览画面上的横向拖动是否越过阈值（`Preview.svelte` 写）。 */
  setSplitDrag(active: boolean): void {
    if (this.splitDrag !== active) this.splitDrag = active;
  }

  /** 把两帧展示用的画布与量尺寸的容器交给渲染侧（`Preview.svelte` 在 onMount 调）。 */
  attachSplit(left: HTMLCanvasElement, right: HTMLCanvasElement, measureHost: Element): void {
    this.splitLeftEl = left;
    this.splitRightEl = right;
    this.splitHostEl = measureHost;
  }

  /**
   * 播放头是否正卡在某个**视觉片段的出点**上（`clip.end`，左闭右开的右端）。
   *
   * 容差取**半个帧长**：`seek({snap})` 吸的是拍、片段几何也吸拍，但拍长未必是帧长
   * 的整数倍，用浮点直等会漏；半帧又天然把「停在切点」与「停在切点前一帧」
   * （相距一整帧）分开，不会误触发。
   *
   * 返回命中的上游片段 id（出点 = t）与下游片段 id（覆盖 t，判据同样是左闭右开）
   * —— 自动模式要用它判断「正在设值的这条片段是否就在这个切点上」。`null` = 不在剪切点。
   */
  cutAt(t: number): { upstreamIds: string[]; downstreamIds: string[] } | null {
    const p = this.store.project;
    const eps = 0.5 / Math.max(1, p.fps);
    const upstreamIds: string[] = [];
    const downstreamIds: string[] = [];
    for (const track of p.tracks) {
      // 只有启用的视觉轨才参与合成，才算得上「画面在这里换了一幅」。
      if (track.kind !== 'visual' || !track.enabled) continue;
      for (const clip of track.clips) {
        if (Math.abs(clip.end - t) <= eps) upstreamIds.push(clip.id);
        // 下游 = 覆盖 t 的片段。判据与 `buildStack` 一致：`start <= t < end`
        // （`end` 加 eps 会把上游片段本身也算进来，所以要加就加在 start 那一侧）。
        if (clip.start <= t + eps && t < clip.end) downstreamIds.push(clip.id);
      }
    }
    return upstreamIds.length ? { upstreamIds, downstreamIds } : null;
  }

  /**
   * 「跨剪切点两帧预览」的规格。`null` = 正常单幅显示。
   *
   * 显示内容恒为 **左 = t − 1/fps、右 = t**（帧长取自 `project.fps`，不硬编码）：
   *  - `t − 1/fps` = 上游片段在时间轴上的**最后一帧**（end 左闭右开，end 本身不参与
   *    合成，所以最后一帧是 end 减一帧）。上游不存在（切点前有缝）时该块自动为黑。
   *  - `t` = 下游片段的**首帧**；下游不存在（切点是最后一段的结尾）时该块为黑。
   *
   * 两种自动模式的诉求都落在这同一对上：
   *  - **上游在设末尾关键帧** → 左 = 上游末帧、右 = 下游首帧 / 黑（用户原话的场景）。
   *  - **下游在设起始关键帧** → 左 = 上游末帧 / 黑、右 = 下游首帧。
   *
   * 触发条件（满足其一）：
   *  - `splitDrag`：预览上横向拖动越过阈值（临时出现，松手收起）。
   *  - `editingKey` 且**被编辑的片段正是这个切点的上游或下游**（自动出现，停止设值收起）。
   */
  private splitSpec(): { leftT: number; rightT: number } | null {
    // 导出/截图期间渲染器被钉在工程分辨率上，额外取帧会按那个尺寸再来两遍 —— 停手。
    if (this.playing || !this.hasProject || this.exportProgress !== null || this.snapshotting) {
      return null;
    }
    const p = this.store.project;
    const t = this.playT;
    const cut = this.cutAt(t);
    if (!cut) return null;
    if (!this.splitDrag) {
      const editing = this.editingKey;
      if (!editing) return null;
      const involved =
        cut.upstreamIds.includes(editing.clipId) || cut.downstreamIds.includes(editing.clipId);
      if (!involved) return null;
    }
    const step = 1 / Math.max(1, p.fps);
    return { leftT: Math.max(0, t - step), rightT: t };
  }

  /**
   * 渲染两帧并排到浮层画布上，**然后把预览恢复成正常播放头那一帧**。
   *
   * 取帧只走 `renderer.renderFrame` + `readPixels`（硬约束 1.1：预览与导出同一条
   * 求值路径，读数只是再读一次它的输出）。`readPixels` 是**自下而上**的，翻行
   * 交给 `paintSplitPanel`。最后那次 `renderFrame(playT)` 不能省 —— 否则 GL 画布
   * 停在左侧那一帧上（浮层收起时会露出来）。
   */
  private renderSplit(spec: { leftT: number; rightT: number }): void {
    const renderer = this.renderer;
    const left = this.splitLeftEl;
    const right = this.splitRightEl;
    const host = this.splitHostEl;
    if (!renderer || !left || !right || !host) {
      renderer?.renderFrame(this.store.project, this.playT);
      this.setSplitVisible(false);
      return;
    }
    const project = this.store.project;
    renderer.renderFrame(project, spec.leftT);
    const L = renderer.readPixels();
    renderer.renderFrame(project, spec.rightT);
    const R = renderer.readPixels();

    const rect = host.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    const availW = Math.max(1, rect.width * dpr);
    const availH = Math.max(1, rect.height * dpr);
    const aspect = project.resolution.w / project.resolution.h;
    // 两块等宽并排、各自等比：整体宽高比 = 2·aspect，先按高度铺满，横向放不下再按宽度收。
    let panelH = availH;
    let panelW = panelH * aspect;
    if (panelW * 2 > availW) {
      panelW = availW / 2;
      panelH = panelW / aspect;
    }
    this.paintSplitPanel(left, L, panelW, panelH, dpr);
    this.paintSplitPanel(right, R, panelW, panelH, dpr);

    // 还原预览到正常播放头那一帧。
    renderer.renderFrame(project, this.playT);
    this.setSplitVisible(true);
  }

  /** 把一帧读回的像素（翻行后）画进一块并排面板画布。先铺不透明黑 —— 空处要的正是黑，不是透明。 */
  private paintSplitPanel(
    target: HTMLCanvasElement,
    src: { data: Uint8Array; w: number; h: number },
    panelW: number,
    panelH: number,
    dpr: number,
  ): void {
    const { data, w, h } = src;
    const scratch = (this.splitScratch ??= document.createElement('canvas'));
    if (scratch.width !== w || scratch.height !== h) {
      scratch.width = w;
      scratch.height = h;
    }
    const sctx = scratch.getContext('2d');
    if (!sctx) return;
    const img = sctx.createImageData(w, h);
    const row = w * 4;
    for (let y = 0; y < h; y++) {
      const from = (h - 1 - y) * row; // GL 自下而上 → 翻行
      img.data.set(data.subarray(from, from + row), y * row);
    }
    sctx.putImageData(img, 0, 0);

    const bw = Math.max(1, Math.round(panelW));
    const bh = Math.max(1, Math.round(panelH));
    if (target.width !== bw || target.height !== bh) {
      target.width = bw;
      target.height = bh;
    }
    target.style.width = `${panelW / dpr}px`;
    target.style.height = `${panelH / dpr}px`;
    const ctx = target.getContext('2d');
    if (!ctx) return;
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, bw, bh);
    ctx.imageSmoothingEnabled = true;
    ctx.drawImage(scratch, 0, 0, w, h, 0, 0, bw, bh);
  }

  private setSplitVisible(v: boolean): void {
    if (this.splitVisible !== v) this.splitVisible = v;
  }

  /* ------------------------------------------------------ 抠图吸管（见字段注释） */

  /** 进入取色模式（检查器的吸管按钮调）。 */
  beginKeyPick(clipId: string): void {
    this.keyPickClipId = clipId;
    this.flash(tr('insp.keyPickHint'));
  }

  /** 退出取色模式（取到色 / Esc / 换选中片段）。幂等。 */
  cancelKeyPick(): void {
    if (this.keyPickClipId !== null) this.keyPickClipId = null;
  }

  /**
   * 取色吸管的落点处理（`Preview` 的 pointerdown 调，clientX/Y 是视口坐标）。
   *
   * ## 为什么是「只渲染这一轨」的一帧
   *
   * 用户点的是「这一层的颜色」。普通合成里这一层可能被上层盖住、或者被自己的
   * 混合模式与背景混过色（`add` 模式下取到的就是加过背景的值）—— 都不是要抠的
   * 那个颜色。只渲染它所在的视觉轨，拿到的才是这一层的原色。
   *
   * ## 为什么屏幕上不会闪
   *
   * `renderFrame(onlyTrackId)` → `readPixels` → `renderFrame` 还原，三件事在
   * **同一个同步任务**里做完：中间没有 rAF、没有把控制权交回浏览器，所以那张
   * 「只有这一轨」的画面永远不会被合成上屏。
   *
   * 失败一律退出取色模式 —— 留在模式里点第二次也没意义（renderer 没起 / 片段
   * 已经不在），用户会以为按钮坏了。
   */
  pickKeyColorAt(clientX: number, clientY: number): void {
    const clipId = this.keyPickClipId;
    if (clipId === null) return;
    const fail = (): void => {
      this.cancelKeyPick();
      this.flash(tr('insp.keyPickFailed'), 'error');
    };

    const renderer = this.servicesReady ? this.renderer : null;
    const found = this.store.findClip(clipId);
    if (!renderer || !found || found.clip.kind !== 'source') {
      fail();
      return;
    }

    /*
     * client → canvas uv。用 canvas 的**显示盒**（getBoundingClientRect）而不是
     * kit.w/h：显示尺寸是 CSS 钉住的适配尺寸，与后备缓冲像素数不是一回事
     * （预览降质时两者相差 1/0.25…）。
     */
    const rect = renderer.kit.canvas.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) {
      fail();
      return;
    }
    const u = (clientX - rect.left) / rect.width;
    const v = (clientY - rect.top) / rect.height;
    if (!(u >= 0 && u <= 1 && v >= 0 && v <= 1)) {
      // 点在画面之外（信箱边 / 画面旁的空白）：重渲一帧正常画面把可能的残留盖掉。
      try {
        renderer.renderFrame(this.store.project, this.playT);
      } catch {
        /* 下一帧 rAF 会重试；这里只是「尽量还原」，失败不阻断提示 */
      }
      fail();
      return;
    }

    const project = this.store.project;
    let px: { data: Uint8Array; w: number; h: number } | null = null;
    try {
      renderer.renderFrame(project, this.playT, { onlyTrackId: found.track.id });
      px = renderer.readPixels();
    } catch {
      px = null;
    } finally {
      // 同一同步任务内还原（见上面的注释：屏幕上不会出现「只有这一轨」的那一帧）。
      try {
        renderer.renderFrame(project, this.playT);
      } catch {
        /* 渲染失败由 Preview 的 rAF 循环兜底，这里不重复抛 */
      }
    }
    if (!px || px.w <= 0 || px.h <= 0) {
      fail();
      return;
    }

    // readPixels 原点在**左下**，屏幕 uv 原点在左上 ⇒ 行号要翻。
    const x = Math.min(px.w - 1, Math.max(0, Math.floor(u * px.w)));
    const y = Math.min(px.h - 1, Math.max(0, Math.floor((1 - v) * px.h)));
    const i = (y * px.w + x) * 4;
    const color = rgbToHex({
      r: px.data[i] ?? 0,
      g: px.data[i + 1] ?? 0,
      b: px.data[i + 2] ?? 0,
    });

    // 一笔撤销：改了键色（必要时先补默认参数）就是一条记录。
    this.store.updateClip(clipId, tr('insp.keyPick'), (c) => {
      if (c.kind !== 'source') return;
      if (!c.key) c.key = defaultKeySettings();
      c.key.color = color;
    });
    this.cancelKeyPick();
    this.flash(tr('insp.keyPickDone', { color }), 'success');
  }

  /**
   * 把**当前预览帧**取成一张 PNG（工程分辨率），返回 Blob 与文件名。
   *
   * 渲染那段整个交给 `render/export-frame.ts::withExportFrame` —— 那是预览截图、
   * 体积采样与导出循环共用的一条取材序列（钉尺寸 → 导出模式 → 字体预热 → 取材 →
   * 对称还原）。**不要再在这里现写一遍**：抄一份的下场已经出现过（漏掉导出模式与
   * 字体预热，画面与预览不同且不报错）。
   *
   * 本方法只管三件属于状态层的事：
   *  - 帧栅格吸附：`t = timeAtFrame(frameAtTime(playT, fps), fps)`，
   *    文件名里的帧号与画面严格对应；
   *  - 连点保护（`snapshotting`）与 `finally` 里的 `refreshPreview()`
   *    （尺寸还原 + 画面重画；它必须在取材窗口之外）；
   *  - 把 `replayed / truncated` 透出去给提示语用（反馈类特效的顺序重放）。
   *
   * 取向直接用 `canvas.toBlob`（与 PNG 序列导出 `PngSequenceSink` 同一路径）：
   * canvas 是左上原点，**不需要**像 `readPixels` 那样翻行 —— 翻行是 GL 读回的
   * 专利，多翻一次反而把图倒过来。
   *
   * @returns 无 renderer / 编码失败 / 连点时为 null。
   */
  async snapshotFrame(): Promise<SnapshotResult | null> {
    if (this.snapshotting) return null;
    const renderer = this.renderer;
    if (!renderer) return null;
    this.snapshotting = true;
    try {
      const project = this.store.project;
      const frame = frameAtTime(this.playT, project.fps);
      const t = timeAtFrame(frame, project.fps);
      const base = project.name.trim() || 'artmatic';
      const filename = `${base}-frame-${String(frame).padStart(5, '0')}.png`;
      const out = await withExportFrame(renderer, project, t, async (canvas, info) => {
        const blob = await new Promise<Blob | null>((resolve) =>
          canvas.toBlob(resolve, 'image/png'),
        );
        return blob
          ? { blob, filename, frame, replayed: info.replayed, truncated: info.truncated }
          : null;
      });
      return out;
    } catch {
      return null;
    } finally {
      this.refreshPreview();
      this.snapshotting = false;
    }
  }

  /** 编辑器注册「取消当前手势」的钩子（切工程 / 关排版页时调用）。 */
  registerGestureCancel(fn: (() => void) | null): void {
    this.pendingGestureCancel = fn;
  }

  /**
   * 取消悬空的手势事务。
   *
   * 与切工程 / 关排版页里那两处是同一件事（`pendingGestureCancel?.()` 之后
   * 立刻置 null）：**绝不能让 `beginTx` 悬空**，否则撤销栈整个错乱 ——
   * 手势的 `cancelTx` 会把事务起点之后的一切改动（包括别人的）一起回滚。
   * 这次多出来的调用方是 agent 控制平面：它的每一次写都必须先让用户的手势
   * 落地，不然两笔改动会混成一条撤销记录。
   */
  cancelGesture(): void {
    this.pendingGestureCancel?.();
    this.pendingGestureCancel = null;
  }

  private pendingGestureCancel: (() => void) | null = null;

  constructor() {
    const prefs = loadUiPrefs();
    this.drawerOpen = prefs.drawerOpen;
    this.drawerWidth = prefs.drawerWidth;
    this.mediaPoolOpen = prefs.mediaPoolOpen;
    this.mediaPoolWidth = prefs.mediaPoolWidth;
    this.agentOpen = prefs.agentOpen;
    // 老偏好里可能两份都开着（这个字段是后加的）：左列只有一个位置。
    if (this.agentOpen) this.mediaPoolOpen = false;
    this.previewFpsDiv = prefs.previewFpsDiv;
    this.previewScale = prefs.previewScale;
    this.previewRestoreOnPause = prefs.previewRestoreOnPause;
    this.previewBarCollapsed = prefs.previewBarCollapsed;
    this.timelineMode = prefs.timelineMode;
    /*
     * 只持久化了「当前形态」那一份档位；另一份回到该形态的默认值
     * （节奏「小节」/ 标准「自由」）。见 `UiPrefs.snap` 的注释。
     */
    this.snapByMode = {
      beat: snapFitsMode(prefs.snap, 'beat') ? prefs.snap : defaultSnapForMode('beat'),
      standard: snapFitsMode(prefs.snap, 'standard') ? prefs.snap : defaultSnapForMode('standard'),
    };
    this.snap = this.snapByMode[this.timelineMode];
    this.shortcutScheme = prefs.shortcutScheme;
    this.mascotEnabled = prefs.mascotEnabled;
    this.typoGrid = prefs.typoGrid;
    this.typoPanelWidth = prefs.typoPanelWidth;
    this.typoKfHeight = prefs.typoKfHeight;
    this.typoKfOpen = prefs.typoKfOpen;
    this.timelineHeight = prefs.timelineHeight;
    this.scaleLinked = prefs.scaleLinked;
    this.runTypoScripts = prefs.runTypoScripts;
    this.metronomeOn = prefs.metronome;
  }

  /**
   * 实际生效的预览缩放。
   *
   * 「暂停时回全质」（默认开）就是在这里生效的：播放中按档位降，一停下来
   * 立刻用全质重画一次 —— 停住时看到的画面必须是准的，否则调参数是在
   * 对着一个糊的参考做决定。
   */
  get effectivePreviewScale(): number {
    if (this.previewRestoreOnPause && !this.playing) return 1;
    return this.previewScale;
  }

  setPreviewFpsDiv(v: number): void {
    const next = normalizeDiv(v);
    if (this.previewFpsDiv === next) return;
    this.previewFpsDiv = next;
    this.persistUi();
  }

  setPreviewScale(v: number): void {
    const next = normalizeScale(v);
    if (this.previewScale === next) return;
    this.previewScale = next;
    this.persistUi();
  }

  setPreviewRestoreOnPause(v: boolean): void {
    if (this.previewRestoreOnPause === v) return;
    this.previewRestoreOnPause = v;
    this.persistUi();
  }

  setPreviewBarCollapsed(v: boolean): void {
    if (this.previewBarCollapsed === v) return;
    this.previewBarCollapsed = v;
    this.persistUi();
  }

  /** 缩放 X / Y 联动开关（检查器的「分离 XY」）。 */
  setScaleLinked(v: boolean): void {
    if (this.scaleLinked === v) return;
    this.scaleLinked = v;
    this.persistUi();
  }

  /**
   * 吸附档位。走 setter 而不是让调用点直接赋 `appState.snap = v` ——
   * 只有一处写才能保证「改了就落盘」（直赋会绕过 persistUi，重启后回到默认）。
   */
  setSnap(v: SnapMode): void {
    // 不属于当前形态的档位（老偏好 / 别处传错）落到该形态的默认值，
    // 绝不把「小节」写进标准模式的下拉里 —— 那会显示成空白。
    const next = snapFitsMode(v, this.timelineMode) ? v : defaultSnapForMode(this.timelineMode);
    this.snapByMode[this.timelineMode] = next;
    if (this.snap === next) return;
    this.snap = next;
    this.persistUi();
  }

  /**
   * 切换时间轴形态。**只在这三处分支**：标尺文案、工具条显示哪组参数、
   * 吸附档位；不改数据、不改渲染管线、不给片段重排。
   *
   * 吸附档位按形态各记一份：切回来是上次在这个形态下用的那一档，
   * 而不是「切过去时被顺手改掉的那个值」。
   */
  setTimelineMode(v: TimelineMode): void {
    const next = normalizeTimelineMode(v);
    if (this.timelineMode === next) return;
    this.timelineMode = next;
    this.snap = this.snapByMode[next] ?? defaultSnapForMode(next);
    this.persistUi();
  }

  setShortcutScheme(v: ShortcutScheme): void {
    const next = normalizeScheme(v);
    if (this.shortcutScheme === next) return;
    this.shortcutScheme = next;
    this.persistUi();
  }

  /** 设置面板「保存并应用」调它（草稿模型：只有点 Apply 才落到这里）。 */
  setMascotEnabled(v: boolean): void {
    if (this.mascotEnabled === v) return;
    this.mascotEnabled = v;
    this.persistUi();
  }

  setDrawerOpen(open: boolean): void {
    if (this.drawerOpen === open) return;
    this.drawerOpen = open;
    this.persistUi();
  }

  toggleDrawer(): void {
    this.setDrawerOpen(!this.drawerOpen);
  }

  setDrawerWidth(w: number): void {
    const next = clampDrawerWidth(w);
    if (this.drawerWidth === next) return;
    this.drawerWidth = next;
    this.persistUi();
  }

  setMediaPoolOpen(open: boolean): void {
    if (this.mediaPoolOpen === open) return;
    /*
     * 调色页的左列被它自己的窄侧栏占着（那是四个面板的开关）—— 媒体池在那里
     * 没有位置。点它 = 「我要看素材清单」，那就先回时间轴再开，而不是让按钮
     * 亮起来却什么都不出现。
     */
    if (open) this.closeGradeEditor();
    this.mediaPoolOpen = open;
    // 左列只有一个位置：打开媒体池就收起 Agent 与调制器面板。
    if (open) {
      this.agentOpen = false;
      this.modulatorOpen = false;
    }
    this.persistUi();
  }

  toggleMediaPool(): void {
    this.setMediaPoolOpen(!this.mediaPoolOpen);
  }

  setModulatorOpen(open: boolean): void {
    if (this.modulatorOpen === open) return;
    if (open) this.closeGradeEditor();
    this.modulatorOpen = open;
    // 左列只有一个位置：开它就收起另外两个。
    if (open) {
      this.mediaPoolOpen = false;
      this.agentOpen = false;
    }
    this.persistUi();
  }

  toggleModulatorPanel(): void {
    this.setModulatorOpen(!this.modulatorOpen);
  }

  openModulatorEditor(id: string): void {
    this.modulatorEditId = id;
  }

  closeModulatorEditor(): void {
    this.modulatorEditId = null;
  }

  setAgentOpen(open: boolean): void {
    if (this.agentOpen === open) return;
    if (open) this.closeGradeEditor();
    this.agentOpen = open;
    if (open) {
      this.mediaPoolOpen = false;
      this.modulatorOpen = false;
    }
    this.persistUi();
  }

  toggleAgent(): void {
    this.setAgentOpen(!this.agentOpen);
  }

  setMediaPoolWidth(w: number): void {
    const next = clampPoolWidth(w);
    if (this.mediaPoolWidth === next) return;
    this.mediaPoolWidth = next;
    this.persistUi();
  }

  /**
   * 轨道区高度。走 setter 而不是直赋 —— 与 `setDrawerWidth` 同口径：
   * 只有一处写才能保证「拖完就落盘」，且钳制不会出现两套上下限。
   */
  setTimelineHeight(h: number): void {
    const next = clampTimelineHeight(h);
    if (this.timelineHeight === next) return;
    this.timelineHeight = next;
    this.persistUi();
  }

  /** 波纹删除开关（工具条的两态按钮）。 */
  setRippleEdit(on: boolean): void {
    if (this.rippleEdit === on) return;
    this.rippleEdit = on;
    this.persistUi();
  }

  /**
   * 节拍器开关（工具条的两态按钮）。
   *
   * 播放中切换立即生效（开 = 从当前时刻开始排，关 = 取消还没响的点击）；
   * 暂停时开只是记住状态，下次播放才响 —— 不在这里单独试音，避免点一下按钮
   * 就突然出一声。
   */
  setMetronome(on: boolean): void {
    if (this.metronomeOn === on) return;
    this.metronomeOn = on;
    this.metronome?.setEnabled(on);
    this.persistUi();
  }

  /** 媒体池列表形态。缩略图是默认，紧凑是「一屏装更多」。 */
  setPoolView(view: PoolView): void {
    if (this.poolView === view) return;
    this.poolView = view;
    this.persistUi();
  }

  setPoolSort(sort: PoolSort): void {
    if (this.poolSort === sort) return;
    this.poolSort = sort;
    this.persistUi();
  }

  /**
   * 全屏预览时允许预览缓冲**放大**到显示尺寸（默认只缩不放，见
   * `preview-size.ts` 的 `k = Math.min(1, scale)`）。
   *
   * 只被全屏那条路打开：1080p 的工程在全屏铺满一块 1440p 的屏幕时，
   * 不放大就是「拿 1080 个像素去填 1440 个格子」，画面是糊的。
   * **绝不能**走 `setExportSize` —— 那会让 `syncSize` 永久短路，
   * 退出全屏后再也不会重新适配（AGENTS §5.9 那条纪律）。
   */
  setPreviewUpscale(on: boolean): void {
    if (!this.servicesReady) return;
    this.renderer.setAllowUpscale(on);
    this.renderer.syncSize(this.store.project.resolution);
  }

  private persistUi(): void {
    saveUiPrefs({
      drawerOpen: this.drawerOpen,
      drawerWidth: this.drawerWidth,
      mediaPoolOpen: this.mediaPoolOpen,
      mediaPoolWidth: this.mediaPoolWidth,
      agentOpen: this.agentOpen,
      previewFpsDiv: this.previewFpsDiv,
      previewScale: this.previewScale,
      previewRestoreOnPause: this.previewRestoreOnPause,
      previewBarCollapsed: this.previewBarCollapsed,
      snap: this.snap,
      timelineMode: this.timelineMode,
      shortcutScheme: this.shortcutScheme,
      mascotEnabled: this.mascotEnabled,
      typoGrid: this.typoGrid,
      typoPanelWidth: this.typoPanelWidth,
      typoKfHeight: this.typoKfHeight,
      typoKfOpen: this.typoKfOpen,
      timelineHeight: this.timelineHeight,
      scaleLinked: this.scaleLinked,
      runTypoScripts: this.runTypoScripts,
      rippleEdit: this.rippleEdit,
      metronome: this.metronomeOn,
      poolView: this.poolView,
      poolSort: this.poolSort,
    });
  }

  /* ---------------------------------------------------- 工程面板的全局状态 */

  /** 保存 / 打开进行中。挡住连点两次弹出两个目录选择器。 */
  projectBusy = $state(false);
  recentProjects = $state<ProjectRef[]>([]);

  /* 服务（非响应式，装配见 init / attachPreview）。
     ⚠️ 这里**没有** `store` —— 它是 getter，指向当前激活工程的那一份。
     服务本身（renderer / player / fonts / 排版运行时）是进程级的：
     它们渲染「当前工程」，不持有任何工程数据。 */
  renderer!: Renderer;
  /**
   * 算法运行时（`render-core` 装配的那一份）。
   *
   * 暴露出来只为一件事：拖动播放头时给它设**步进预算**。模拟是主线程同步的，
   * 「向前跳 N 帧」必须真把中间 N 步算完（见 `AlgoRuntime.planSimStep` 的长注释），
   * 不设预算就会在拖动时冰住几秒。lab 用同一份运行时，所以两边行为一致。
   */
  algos!: AlgoRuntime;
  sources!: SourceManager;
  /**
   * 回放服务（闪回）。导出预热里调 `prepare`，关工程时逐片段 `forget` ——
   * 它自带一台独立的 `AlgoRuntime`，模拟状态纹理不显式回收就会跟着进程一直长。
   */
  recall!: RecallService;
  /** 视频取帧器（`engine/video-source.ts`）。导出前逐帧 prepare、关工程时 forget。 */
  video!: VideoSourceManager;
  player!: AudioPlayer;
  /** 预览节拍器：与 `player` 共用同一个 AudioContext 和时钟。 */
  metronome!: Metronome;
  /** 工程音频的离线分析来源（频谱 `u_spectrum` + 特征）。数据以接口注入 render-core。 */
  audio!: ProjectAudio;
  fonts!: FontRegistry;
  textBackends!: TextBackendRegistry;
  textRaster!: TypographyRuntime;
  private servicesReady = false;

  /**
   * main.ts 在 mount 之前调。
   *
   * `store` 可以不给：**首屏是零选项卡的欢迎界面**（不再自动开一份 demo ——
   * 那份工程每次都要用户手动关掉）。不给的时候 `store` 这个 getter 会回落到
   * `placeholder`（一份丢弃用的空白工程），所有「读当前工程」的代码照常工作，
   * 只是 `hasProject` 为假、`tick()` 直接返回。
   */
  init(store?: ProjectStore): void {
    // 启动时那份 demo 工程没有句柄 key，`adoptProject` 的同步会把它写成
    // 「打开的工程 = 空」，从而冲掉「上次离开时打开着哪些工程」——
    // 那正是回来时恢复提示要用的记录。先读、adopt 之后再写回。
    const remembered = loadOpenTabs();
    if (store) this.adoptProject({ store });
    // `keepDismiss`：这是把记录写回，不是「用户开了工程」，不该把「已忽略」抹掉。
    if (remembered.length) saveOpenTabs(remembered, { keepDismiss: true });
    this.subscribePlugins();
  }

  /**
   * 插件集合变化 → 界面重算 + 重画一帧。
   *
   * 订阅在 `init` 里建一次、永不解绑：宿主是进程级单例，活到页面结束。
   * 与 `FontRegistry.onReady → store.touch()` 同一个套路，区别是这里直接
   * `refreshPreview()`（它本来就是「重新同步尺寸 + 重画一帧」那个入口）。
   */
  private subscribePlugins(): void {
    this.plugins.subscribe(() => {
      this.pluginRevision = this.plugins.revision();
      this.refreshPreview();
    });
  }

  /**
   * 把工程目录里的插件挂到这份工程上。
   *
   * 在「素材读进来之后、`adoptProject` 之后」调用（见 `project-actions.ts`）：
   * 需要工程 id 当引用计数的键，而 id 是 `adoptProject` 才产生的。
   * 没有目录（还没保存过）时什么都不做 —— 那是正常的空状态。
   */
  async mountPlugins(projectId: string, dir: FsDirHandle | null): Promise<void> {
    if (!dir) return;
    await this.plugins.mountFromDirectory(dir, projectId);
  }

  /* ------------------------------------------------ Agent 对话历史（agent/） */

  /**
   * 历史写入的串行队列。
   *
   * `createWritable({mode:'exclusive'})` 撞上同一个文件时后到者会拿到
   * `NoModificationAllowedError`。轮末保存是串行的，但「清空历史」可能正好落在
   * 一次保存之后 —— 排队比让调用方各自加锁便宜。
   */
  private historyQueue: Promise<void> = Promise.resolve();

  private enqueueHistory(job: () => Promise<void>): void {
    this.historyQueue = this.historyQueue.then(job).catch((e) => {
      // 历史是日志，不是工程真相：写不进去不该打断任何操作，但必须留痕。
      console.error('[agent-history] 写入失败：', e);
    });
  }

  /** 按 id 取工程（异步回调里不能用「当前」——用户可能已经切了选项卡）。 */
  private projectById(projectId: string): OpenProject | null {
    return this.projects.find((p) => p.id === projectId) ?? null;
  }

  /**
   * 打开工程后读历史。
   *
   * 目录不存在 = 还没聊过（正常状态）。读失败的文件只记一条警告 ——
   * 一个坏文件不该让工程打不开，也不该让其它会话消失。
   */
  async loadAgentHistory(projectId: string, dir: FsDirHandle | null): Promise<void> {
    if (!dir) return;
    const p = this.projectById(projectId);
    if (!p) return;
    const { sessions, failed } = await readAgentHistory(dir);
    p.agentSessions = sessions;
    // 磁盘已经是这个目录的真源了 ⇒ 下一次保存不需要再整份刷一遍。
    p.agentHistoryDir = dir;
    if (failed.length > 0) {
      console.warn(`[agent-history] ${failed.length} 个会话文件读不出来`, failed);
    }
  }

  /**
   * 记录一条会话（轮末调用）。内存立即更新，磁盘排队写。
   *
   * 没有目录（工程还没保存过）时**只留在内存**：与「工程没保存，内容也只活在内存」
   * 同一条约定，不在 localStorage 里偷偷存一份（AGENTS §1.7）。
   */
  saveAgentSession(projectId: string, record: AgentSessionRecord): void {
    const p = this.projectById(projectId);
    if (!p) return;
    const { sessions, evicted } = upsertAgentSession(p.agentSessions, record);
    p.agentSessions = sessions;
    const dir = p.dir;
    if (!dir) return;
    this.enqueueHistory(async () => {
      await writeAgentSession(dir, record);
      // 超出上限被挤出去的那几条，文件也要删 —— 否则下次打开它们又回来了。
      for (const id of evicted) await removeAgentSession(dir, id);
    });
  }

  deleteAgentSession(projectId: string, sessionId: string): void {
    const p = this.projectById(projectId);
    if (!p) return;
    p.agentSessions = p.agentSessions.filter((s) => s.id !== sessionId);
    const dir = p.dir;
    if (!dir) return;
    this.enqueueHistory(() => removeAgentSession(dir, sessionId));
  }

  clearAgentSessions(projectId: string): void {
    const p = this.projectById(projectId);
    if (!p) return;
    p.agentSessions = [];
    const dir = p.dir;
    if (!dir) return;
    this.enqueueHistory(async () => {
      await clearAgentHistoryOnDisk(dir);
    });
  }

  /**
   * 把内存里的历史整份刷到目录。
   *
   * 首次保存 / 另存为时用：那之前 `p.dir` 是 null，所有会话只在内存里；
   * 接上目录之后必须补写，否则「先聊了十轮、再保存工程」会丢掉前九轮。
   */
  flushAgentHistory(projectId: string, dir: FsDirHandle): void {
    const p = this.projectById(projectId);
    if (!p) return;
    // 目录没变 = 会话早就按条写过盘了（自动保存会频繁走到这里，别整份重写）。
    if (p.agentHistoryDir === dir) return;
    p.agentHistoryDir = dir;
    const snapshot = [...p.agentSessions];
    this.enqueueHistory(async () => {
      for (const record of snapshot) await writeAgentSession(dir, record);
    });
  }

  /**
   * Preview.onMount 调：canvas 此刻才存在，渲染服务在这里惰性创建。
   * 挂载顺序由此单一化——不存在「renderer 还没建组件就先渲染」的窗口。
   *
   * ## 画布身份是会变的（这一段是踩过的坑，别按「canvas 只有一个」来读）
   *
   * `Kit` 在构造时把 canvas 存死（`engine/kit.ts`），整套服务**没有改绑 canvas 的
   * 办法**。而 Preview 组件被卸载再挂载（dev 的组件级 hot-update 就是这条路，
   * 将来任何「把 `<Preview />` 放进 `{#if}`」也是）会带来一块**新的** canvas：
   * 不重建的话渲染会一直落在**已经脱离 DOM**的那块上 —— GL 不报错、rAF 照跑、
   * 屏幕上永久空白。表现就是「偶发黑屏，刷新一下才好」。
   * 所以这里显式比对身份，不同就整块重建（插件宿主支持换 Kit，见 `attachKit`）。
   */
  attachPreview(canvas: HTMLCanvasElement, host: Element): void {
    this.previewHost = host;
    if (this.servicesReady && this.renderer.kit.canvas !== canvas) this.resetRenderServices();
    if (!this.servicesReady) this.createRenderServices(canvas);
    this.renderer.attachDisplay(host);
    this.renderer.syncSize(this.store.project.resolution);
    this.renderer.renderFrame(this.store.project, this.playT);
  }

  /**
   * 上一次 `attachPreview` 给的显示容器。
   *
   * 上下文**恢复**那条路要用它：`webglcontextrestored` 事件里只有 canvas，
   * 没有 host，而重建之后必须把 display 重新接回去。
   */
  private previewHost: Element | null = null;

  /**
   * 与 GL 无关的那一半服务（解码好的音频、用户导入的字体、离屏 2D 光栅化）。
   *
   * **只在第一次建**：重建渲染服务时若把它们一起换掉，表现是「黑屏修好了，
   * 但音频没了、字体回落成默认」—— 这两个状态都活在浏览器里，重建不出来。
   */
  private createHostServices(): void {
    if (this.hostServicesReady) return;
    this.player = new AudioPlayer();
    /*
     * 节拍器与播放器同时建：它必须与音乐共用同一个 AudioContext，否则两条
     * 时钟会随设备 / 负载慢慢漂开（节拍器越听越偏）。
     */
    this.metronome = new Metronome(this.player, () => this.store.project);
    this.metronome.setEnabled(this.metronomeOn);
    // 音频来源先建：两次回调都是**惰性**的（`player` 上面那行才创建），
    // 所以这里的顺序不影响正确性。频谱与特征由它一次走查产出。
    this.audio = new ProjectAudio(
      () => this.store.project,
      (assetId) => this.player?.buffer(assetId) ?? null,
    );
    // 排版层与 algo 烘焙同构：异步光栅化 → 结果就绪时 touch() → 下一帧重绘。
    // 光栅化本身必须在主线程做（要走 DOM 与 document.fonts），
    // 所以只有「异步结果 → 缓存 → bump version」这一层是复用的。
    this.fonts = new FontRegistry();
    // 随软件分发的 OFL 西文（Inter / JetBrains Mono / Lora / Outfit，各 400+700）。
    // 只登记 URL，第一次用才 fetch。
    this.fonts.registerBundled();
    this.fontFamilies = this.fonts.families();
    this.textBackends = createTextBackendRegistry(createOffscreenHost(), this.fonts);
    this.hostServicesReady = true;
  }

  /** 与 GL 绑定的那一半服务。**可重复调用**（换 canvas / 上下文恢复后重建）。 */
  private createRenderServices(canvas: HTMLCanvasElement): void {
    this.createHostServices();
    // 源解析 / 算法运行时 / 特效执行器的装配在 render-core —— 与 lab 试炼场
    // 共用同一份真源。这里只做「主应用特有的追加装配」（排版、字体、音频）。
    const core = createRenderCore(canvas, {
      getProject: () => this.store.project,
      onAlgoReady: () => this.store.touch(),
      // 频谱 + 特征来源：读当前工程的音频片段。`player.buffer()` 解码好之前返回 null，
      // 那时是静音的，解码完成后的首次请求会触发一次离线分析（之后按 t 查表）。
      spectrum: this.audio,
      features: this.audio,
      /*
       * 「脱机媒体」判据：仓里没有这个素材的字节、运行期也没登记过。
       * （两个都查 —— 只查仓子会把「导入中」误判成不存在，只查登记表会把
       * 「打开工程时文件读不到」漏掉。）片段引用这种 assetId 时画面给
       * 暗红占位符，而不是静默跳过（那一层什么都不画）。
       * 判据的唯一实现是 `isAssetOffline`（排版编辑器共用同一份）。
       */
      isAssetOffline: (id) => this.isAssetOffline(id),
    });
    this.renderer = core.renderer;
    /*
     * LUT 字节来源：读**当前工程**的素材仓。`bytesOf` 命中就是同步的（刚导入），
     * 否则走 `readAll` 读盘 —— 载入完成前绑恒等表，所以这里返回 Promise 不会
     * 阻塞任何一帧（见 `engine/lut-texture.ts`）。
     */
    core.luts.setLoader((id) => this.assets.bytesOf(id) ?? this.assets.readAll(id));
    this.algos = core.algos;
    this.sources = core.sources;
    this.video = core.video;
    this.recall = core.recall;
    // 占位图上的文字走 i18n（engine 不 import i18n，由宿主注入）。
    core.sources.setOfflineLabel(tr('pool.offline'));

    /*
     * 插件着色器的编译校验需要真 GL，而 Kit 是这一刻才有的。
     * 在此之前挂载的插件（打开工程时还没有预览的场景）在这里补做校验 ——
     * 漏掉这一步的表现是「坏插件的着色器直到被点到才报错」，
     * 那正是这条校验要消灭的东西（见 plugins/host.ts 的文件头）。
     * 换 Kit 时 `attachKit` 会把已校验状态复位重编（它有自己的 swapped 分支）。
     */
    this.plugins.attachKit(core.kit);

    this.textRaster = new TypographyRuntime(core.kit, this.textBackends, this.fonts, {
      onReady: () => this.store.touch(),
      fps: () => this.store.project.fps,
      projectSeed: () => this.store.project.seed,
      scriptsEnabled: () => this.runTypoScripts,
      // 超采样只在暂停时用（播放中密度恒为 1，与「暂停回全质」同一取舍）。
      isPlaying: () => this.playing,
    });
    this.sources.setTextResolver(this.textRaster.resolve);
    // 图片素材的 URL 解析（排版文档里的 image 元素要用它）。
    this.textRaster.resolveImage = resolveImageAsset;
    // 「脱机媒体」判据与占位文字：与合成路径（sources 的探针）同一口径。
    // 文案从 i18n 取（typography 不 import i18n）。
    this.textRaster.isImageOffline = (id) => this.isAssetOffline(id);
    this.textRaster.offlineLabel = tr('pool.offline');
    // 自定义配色方案同理（函数式：切工程后读到的是新工程那份）
    this.textRaster.customThemes = () => this.project.customThemes ?? [];

    /*
     * 导出预热是**三个来源共用同一个槽位**（`Renderer.setPrewarm` 只有一个）。
     * 三者都是「异步就绪」的：排版等光栅化缓存，视频等解码到精确帧，闪回等
     * **它要回放的那个过去帧**里的视频也解到精确帧（见 `render/recall.ts`）。
     * 必须都 await —— 排版缺席只是少几个字，视频缺席就是一帧错画面。
     */
    this.renderer.setPrewarm(async (p, t) => {
      await this.textRaster.prewarmFrame(p, t);
      await this.video.prepareProject(p, t, this.renderer.kit.w);
      await core.recall.prepare(p, t, this.renderer.kit.w);
    });
    this.renderer.setFontPrewarm((p) => this.textRaster.prewarmFonts(p));
    this.renderer.setExportLifecycle(
      () => this.textRaster.enterExportMode(),
      () => this.textRaster.exitExportMode(),
    );

    // 素材登记处就绪/变化 → 下一帧重绘（视频新帧解出来就靠这条推画面）。
    setMediaAssetsListener(() => this.store.touch());

    /*
     * 上下文丢失 / 恢复。
     *
     * 丢失（显存不足、驱动重置、标签页被系统回收 GPU）之后，program / 纹理 / 缓冲
     * 一个都不剩，每一帧的 GL 调用都会抛。**不 `preventDefault` 的话浏览器根本不会
     * 尝试恢复** —— 那才是「黑屏之后再也不会好」。丢失期间靠 Preview 的 rAF 兜底
     * （tick 的异常不再打死循环），恢复后在这里整块重建。
     */
    canvas.addEventListener('webglcontextlost', (e) => {
      e.preventDefault();
      console.warn('[preview] WebGL 上下文丢失（多为显存不足 / 驱动重置），等待浏览器恢复');
    });
    canvas.addEventListener('webglcontextrestored', () => {
      // 恢复的上下文里旧的 GL 对象全部无效，只能整块重建。
      // `loseContext: false` —— 否则会把这口刚恢复的上下文立刻再丢一次。
      this.resetRenderServices(false);
      const host = this.previewHost;
      if (host) this.attachPreview(canvas, host);
    });

    this.servicesReady = true;
  }

  /**
   * 丢掉 GL 侧服务，准备重建（见 `createRenderServices`）。
   *
   * `loseContext`：把旧上下文显式还给 GPU。**换 canvas 那条路必须做** ——
   * 旧 canvas 已经脱离 DOM，不主动释放就一直占着显存；**恢复那条路不能做**，
   * 那会把刚恢复的上下文立刻再丢一次。
   */
  private resetRenderServices(loseContext = true): void {
    if (!this.servicesReady) return;
    this.servicesReady = false;
    this.plugins.attachKit(null);
    if (loseContext) this.renderer.kit.gl.getExtension('WEBGL_lose_context')?.loseContext();
  }

  /** 非 GL 服务是否已建（见 `createHostServices`）。 */
  private hostServicesReady = false;

  get project() {
    return this.store.project;
  }

  /**
   * 这个 assetId 引用的媒体是不是**不存在**（「脱机媒体」判据的唯一实现）。
   *
   * 仓里没有字节、运行期也没登记过 —— **两个都查**：只查仓子会把「导入中」
   * （字节已进仓、还没解码完）误判成不存在，只查登记表会把「打开工程时
   * 文件在磁盘上读不到」漏掉（那种素材永远登记不上）。
   *
   * 三个消费方共用它：合成路径的占位图（render-core 的探针）、排版光栅化
   * （textRaster）、排版编辑器舞台（TypographyEditor）。各判一次的形态是
   * 「时间轴上显示脱机、画布上却空白」。
   */
  isAssetOffline(assetId: string): boolean {
    if (!this.hasProject) return false;
    // linked 条目在仓里、但本地句柄没接上：同样算脱机，只是原因不同。
    const linkedUnavailable =
      this.assets.isUnavailable(assetId) &&
      imageSourceFor(assetId) === null &&
      videoMediaFor(assetId) === null;
    return (
      linkedUnavailable ||
      (!this.assets.has(assetId) &&
        imageSourceFor(assetId) === null &&
        videoMediaFor(assetId) === null)
    );
  }

  /** 显示一条短提示（自动消失）。 */
  flash(text: string, level: 'info' | 'success' | 'error' = 'info'): void {
    this.notice = text;
    this.noticeLevel = level;
    if (this.noticeTimer) clearTimeout(this.noticeTimer);
    this.noticeTimer = setTimeout(() => {
      this.notice = null;
      this.noticeTimer = null;
    }, 2600);
  }

  /* ------------------------------------------------------------ 拍网格估计 */

  /** 估计进行中（按钮据此禁用并显示「估计中…」）。 */
  beatBusy = $state(false);

  /**
   * 从工程里的音频估计 BPM / offset 并写进拍网格（ADR-002）。
   *
   * 取**最早开始的那段音频**当节拍参考：工程里通常只有一首曲子，
   * 而「最早开始」比「第一条音频轨的第一段」更符合直觉（片段可以挪）。
   *
   * 估计不出来时**什么都不写**并说明原因 —— 拍网格是卡点的基准，
   * 塞一个看起来像模像样的错值比留空更坏。
   */
  async estimateBeatGrid(opts: { announce?: boolean } = {}): Promise<boolean> {
    const announce = opts.announce ?? true;
    if (this.beatBusy) return false;

    let best: { clip: AudioClip; buffer: AudioBuffer } | null = null;
    for (const track of this.store.project.tracks) {
      if (track.kind !== 'audio') continue;
      for (const clip of track.clips) {
        if (clip.kind !== 'audio') continue;
        const buffer = this.player.buffer(clip.assetId);
        if (!buffer) continue;
        if (!best || clip.start < best.clip.start) best = { clip, buffer };
      }
    }
    if (!best) {
      if (announce) this.flash(tr('tp.estimateNoAudio'), 'error');
      return false;
    }

    this.beatBusy = true;
    try {
      const r = await estimateTempo(best.buffer);
      if (!r || r.silent || !(r.confidence > 0)) {
        if (announce) this.flash(tr('tp.estimateSilent'), 'error');
        return false;
      }
      const bpm = Math.max(20, Math.min(300, Math.round(r.bpm * 100) / 100));
      if (!Number.isFinite(bpm) || bpm <= 0) {
        if (announce) this.flash(tr('tp.estimateFailed'), 'error');
        return false;
      }
      // offset 是「第 0 拍的秒数」：估计给的是相对音频起点的相位，
      // 而片段可能被挪过（srcIn 也是偏移），所以要加上片段自己的时间基准。
      const offset = r.offset + best.clip.start - best.clip.srcIn;
      this.store.setBeatGrid({ bpm, offset: Math.round(offset * 10000) / 10000 });
      if (announce) {
        this.flash(tr('tp.estimateOk', { bpm, offset: offset.toFixed(3) }), 'success');
      }
      return true;
    } catch (e) {
      if (announce) this.flash(tr('tp.estimateFailed'), 'error');
      console.error('[tempo] 估计失败：', e);
      return false;
    } finally {
      this.beatBusy = false;
    }
  }

  /**
   * 导入音频之后**只在拍网格还是默认值**时自动估一次。
   *
   * 判据是「bpm 还是 120 且 offset 还是 0」—— 那说明用户没有动过拍网格。
   * 动过就绝不覆盖：他手调过的卡点比他刚导入的一首歌的自动估计更值钱。
   */
  async autoEstimateIfDefault(): Promise<void> {
    const g = this.store.project.beatGrid;
    if (g.bpm !== 120 || g.offset !== 0) return;
    await this.estimateBeatGrid({ announce: true });
  }

  /**
   * 时间轴 ruler 按下 / 松开。
   *
   * 拖动期间把模拟步进的预算压到 `SCRUB_STEP_BUDGET_MS`：模拟是主线程同步的，
   * 向前跳 N 帧必须真把中间 N 步算完（迭代系统没有闭式解），不设预算就会在
   * 拖动时冰住 —— 实测出厂默认的沙堆把整条 24 秒轴走完要 5.3 秒（优化后 0.53 秒），
   * Lenia 1.04 秒。设了预算之后每帧最多花掉那些毫秒，画面显示的是模拟**真实
   * 经过**的某一帧（只是比播放头早），松手后由 `tick()` 切到追赶档，
   * 追上（`simLag === 0`）再回到精确。
   *
   * `SimHandle.seek` 的精确语义一个字都没改（硬约束 1.3）—— 变的只是
   * 「这一帧渲哪一帧」，而落后状态永远不会被当成最终结果（导出前必然追平）。
   */
  beginScrub(): void {
    this.scrubActive = true;
  }

  endScrub(): void {
    this.scrubActive = false;
  }

  /**
   * 每帧算一次模拟步进的预算。**必须放在 `tick()` 所有提前返回之前** ——
   * 导出期间 `tick()` 会立刻返回，而那时预算必须已经是 0。
   *
   * 三档：
   * - 导出中 / 播放中 → **0（精确）**。导出是逐帧权威输出，渲一张落后于
   *   播放头的帧就是错的；播放是顺序推进，本来就用不上预算。
   * - 拖动中 → 小预算。
   * - 其余情况且还没追上 → 追赶档（大一点，用户已停手在等）。
   */
  private syncSimBudget(): void {
    if (!this.servicesReady) return;
    const lag = this.algos.takeSimLag();
    if (lag !== this.simLag) this.simLag = lag;
    const ms =
      this.exportProgress !== null || this.playing
        ? 0
        : this.scrubActive
          ? SCRUB_STEP_BUDGET_MS
          : lag > 0
            ? SCRUB_CATCHUP_BUDGET_MS
            : 0;
    if (ms !== this.simBudgetMs) {
      this.simBudgetMs = ms;
      this.algos.setStepBudget(ms);
    }
  }

  seek(t: number, opts: { snap?: boolean } = {}): void {
    const p = this.store.project;
    let nt = Math.max(0, Math.min(t, p.duration));
    if (opts.snap) {
      nt = snapTimeWithSections(nt, this.snap, p.beatGrid, p.sections, p.fps, p.beatMarks);
    }
    this.playT = nt;
    this.renderer.onSeek();
    if (this.playing) void this.playAudio(nt);
  }

  /**
   * 播放（含 seek 后的重排）：先把视频内嵌音轨解出来再排 WebAudio 时间线。
   *
   * 预热是**幂等且按区间缓存**的，重复调用几乎零成本；失败只记一次 warn，
   * 于是「视频没有音轨 / 编码解不动」表现为静音而不是播放中断。
   */
  private async playAudio(fromT: number): Promise<void> {
    const project = this.store.project;
    await prepareProjectVideoAudio(project, (id, buf) => this.player.register(id, buf));
    // 等待解码期间用户可能已经暂停 / seek 到别处。
    if (!this.playing) return;
    await this.player.play(project, fromT);
    // 播放器可能刚刚重建了时钟（seek 也会走到这里）—— 节拍器从新位置重排。
    this.metronome?.onPlay();
  }

  async play(): Promise<void> {
    this.playing = true;
    await this.playAudio(this.playT);
  }

  pause(): void {
    this.metronome?.onPause();
    const t = this.player.currentT();
    this.player.stop();
    this.playing = false;
    if (t !== null) this.playT = Math.max(0, Math.min(t, this.store.project.duration));
  }

  stop(): void {
    this.metronome?.onPause();
    this.player.stop();
    this.playing = false;
    this.seek(0);
  }

  togglePlay(): void {
    if (this.playing) this.pause();
    else void this.play();
  }

  /** Preview 的 rAF 每帧调一次：播放中推进播放头，然后渲染当前帧。 */
  tick(): void {
    this.syncSimBudget();

    // 导出期间预览循环停手：rAF 在预览尺寸下渲染会重排反馈历史
    // （feedbackFor 按尺寸重建目标），污染正在进行的顺序导出。
    if (this.exportProgress !== null) {
      this.setSplitVisible(false);
      return;
    }

    /*
     * 没有工程时不渲染。
     *
     * 空界面是**盖在**主界面之上的一层（见 placeholder 的注释：主界面不能卸载），
     * 所以这里必须显式停手 —— 否则背后那台渲染器会一直按占位工程出帧，
     * 白烧 GPU 还让「没有工程」这件事在性能上看不出来。
     */
    if (!this.hasProject) {
      this.setSplitVisible(false);
      return;
    }

    // 排版编辑页激活时**不渲染 WebGL**：.body 已被 display:none 隐藏，
    // measureDisplaySize() 会量到 0 并触发 UNMEASURED_MAX_PIXELS 兜底分配，
    // 既浪费显存又会让预览尺寸无谓变形。
    // 但播放头照常推进 —— 排版页的 CSS 动画就是靠 playT 驱动 seek 的。
    if (this.editorOpen) {
      this.setSplitVisible(false);
      if (this.playing) this.advancePlayhead();
      return;
    }

    if (this.playing) this.advancePlayhead();

    // 预览画质档位推给 renderer（它只在真的变化时才动尺寸）
    this.renderer.setPreviewScale(this.effectivePreviewScale);

    /*
     * 帧率档位**只在播放中**节流。
     *
     * 暂停时永远渲：那是「改一个参数立刻看到结果」的路径，任何节流都会让
     * 编辑手感变钝，而预览尺寸下这点开销不值得省。
     *
     * 播放中省的才是 GPU（分形/模拟类来源在降分辨率下本来就快，降帧率
     * 进一步把每秒的工作量按比例砍掉）。**播放头的推进从不节流** ——
     * playT 来自音频时钟，所以降帧率只影响画面刷新率，不影响时间与声音对齐。
     *
     * `performance.now()` 在这里只做**节流**，不参与内容求值：渲染函数收到的
     * 仍然只有 t（硬约束 1.1 管的是后者，这个节流属于预览传输层）。
     */
    if (this.playing) {
      const effFps = Math.max(1, this.store.project.fps / this.previewFpsDiv);
      const minGap = 1000 / effFps;
      const now = performance.now();
      if (now - this.lastPreviewRender < minGap - 1) return;
      this.lastPreviewRender = now;
    }

    /*
     * 播放时把渲染时间**吸附到帧栅格**。
     *
     * 反馈类特效（echo / tunnel / melt / feedback / liquid-light / flow-contours /
     * fast-mosh / motion-mask / petri）**按渲染帧累积状态**，而导出是逐帧
     * `frame/fps` 渲染的。预览的 t 来自音频时钟（连续值），吸附之后
     * **每一个预览帧就是一个导出帧** —— 预览与导出逐帧同源。
     *
     * 暂停时不吸附：拖动播放头是「看这一瞬间」，量化它只会让编辑手感变钝。
     */
    const fps = Math.max(1, this.store.project.fps);
    const renderT = this.playing ? Math.round(this.playT * fps) / fps : this.playT;

    /*
     * 剪切点两帧并排优先：它自己会把预览恢复成 `playT` 那一帧（见 `renderSplit`），
     * 所以走这条分支时不要再渲一遍单幅。触发条件与显示内容见 `splitSpec`。
     */
    const split = this.splitSpec();
    if (split) {
      this.renderSplit(split);
    } else {
      this.setSplitVisible(false);
      this.renderer.renderFrame(this.store.project, renderT);
    }
    this.countFrame();
  }

  /** 上一次预览渲染的墙钟时刻（只用于降帧率节流）。 */
  private lastPreviewRender = 0;

  /** 播放头推进。抽出来给「渲染 WebGL」与「只推进不渲染」两条路共用。 */
  private advancePlayhead(): void {
    const t = this.player.currentT();
    if (t === null) return;
    if (t >= this.store.project.duration) {
      this.pause();
      this.playT = this.store.project.duration;
    } else {
      this.playT = t;
    }
  }

  /** FPS 统计。用 performance.now() 只是为了算频率，不进渲染求值路径。 */
  private countFrame(): void {
    this.fpsFrames += 1;
    const now = performance.now();
    if (this.fpsAt === 0) {
      this.fpsAt = now;
      return;
    }
    const dt = now - this.fpsAt;
    if (dt >= 500) {
      const next = Math.round((this.fpsFrames * 1000) / dt);
      if (next !== this.fps) this.fps = next;
      this.fpsFrames = 0;
      this.fpsAt = now;
    }
  }
}

export const appState = new AppState();
