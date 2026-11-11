/**
 * session.ts — 工程目录里的**会话状态**（`session.json`）。
 *
 * ## 它是什么
 *
 * 「上次停在哪」：播放头位置、选中的片段、停在哪个视图（时间轴 / 排版 / 调色 /
 * 粒子）。下次打开同一份工程时直接回到那里，而不必从头把界面摆一遍。
 *
 * ## 它不是什么（这条最要紧）
 *
 * **它不是工程内容**：没有它，`project.json` 渲染出来的每一个像素都不变。
 * 所以它：
 *  - 不进 `project.json`（否则每次拖播放头都会重写工程本体）；
 *  - 不参与「有没有未保存改动」的判定（`ProjectStore.docVersion` 只在内容真的
 *    变了时前进，见那里的注释）；
 *  - 不进 `.artmatic` 工程包、不打 `.bak`、不轮转（`package.ts` 只收
 *    `project.json` 与素材）。
 *
 * 代价是它**可以丢**：写失败、文件被手删、换一台机器，最坏只是回到默认的
 * 时间轴第 0 秒。所以这里的读写一律降级，绝不因为会话状态挡住打开或保存。
 *
 * ## 为什么写进工程目录而不是 IndexedDB
 *
 * 它**跟工程走**才有意义：同一个目录在另一台机器 / 另一个浏览器配置里打开，
 * 也应该回到上次的位置。IndexedDB 那份（`project/handles.ts`）是句柄与封面的
 * 缓存，只服务首页，清一次站点数据就没了。
 *
 * ## 写入时机
 *
 * 播放头每帧都在变，所以写入必须防抖（`ui/project-session.ts`）。本文件只负责
 * 「这一份状态怎么落盘」，不判断什么时候该落。
 */

import { readTextIfExists, writeBytesAtomic, type FsDirHandle } from './fs';
import { SESSION_FILE } from './layout';
import type { Project } from '../core/schema';

/** 信封版本。字段只增不改；读不出来就整份丢掉（比迁移一个可丢的东西划算）。 */
export const SESSION_FORMAT = 1;

export type SessionViewKind = 'timeline' | 'typography' | 'grade' | 'particles';

export interface SessionView {
  kind: SessionViewKind;
  /** 非时间轴视图才有：停在哪个片段上。 */
  clipId?: string;
}

/** 浮窗几何（px，视口坐标）。只在面板 kind 为 `float` 时有意义。 */
export interface SessionPanelBox {
  x: number;
  y: number;
  w: number;
  h: number;
}

/**
 * 插件面板的界面状态。
 *
 * 与 `view` 同一定位：**可以丢**，丢了只是面板关着 / 浮窗回到默认位置。
 * 插件本身仍在（文件在工程目录里），面板随时能再打开。
 */
export interface SessionPanels {
  /** 打开着的面板键（`${pluginId}/${panelId}`）。 */
  open: string[];
  /** 浮窗位置与尺寸，键同上。 */
  boxes: Record<string, SessionPanelBox>;
  /**
   * **折叠成标题栏**的停靠面板键（仍是「开着」）。
   *
   * 与 `open` 分开记：折叠不是关闭 —— 关掉会把面板从 Rail 的激活态一起摘掉，
   * 而折叠只是把内容收起来，用户下次点标题栏就展开，不需要重新找入口。
   * 检查器自己的折叠状态不在这里（它跟着 UI 偏好走，见 `appState.inspectorCollapsed`）。
   */
  collapsed: string[];
  /**
   * 每侧分节的上下顺序（面板键）。`'@inspector'` 代表检查器那一节。
   *
   * 存在这里而不是全局偏好里：分节的集合本身是跟工程走的（插件按工程装），
   * 顺序跟着它走才不会出现「这份工程里没有的面板占着一个位置」。
   */
  order: { left: string[]; right: string[] };
}

export function defaultSessionPanels(): SessionPanels {
  return { open: [], boxes: {}, collapsed: [], order: { left: [], right: [] } };
}

export interface ProjectSession {
  /** 播放头（秒）。 */
  playT: number;
  /** 选中的片段 id（顺序 = 加入顺序，与 `OpenProject.selectedClipIds` 一致）。 */
  selectedClipIds: string[];
  view: SessionView;
  /**
   * 插件面板状态。**可选**：老工程的 `session.json` 里没有这一项，
   * 那种情况下它就是「没开面板」，不需要迁移。
   */
  panels?: SessionPanels;
}

/** 没有任何会话状态时的默认值：时间轴第 0 秒、什么都不选。 */
export function defaultSession(): ProjectSession {
  return { playT: 0, selectedClipIds: [], view: { kind: 'timeline' } };
}

/** 播放头精度：毫秒。不截的话音频时钟的浮点尾巴会让「内容没变」的比对永远不等。 */
function roundPlayT(v: number): number {
  return Math.round(v * 1000) / 1000;
}

function finite(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

/** 浮窗尺寸的下限。比 CSS 里的最小值宽松：界面上会再 clamp 一次。 */
const MIN_BOX = 120;

function parseBox(raw: unknown): SessionPanelBox | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const o = raw as Record<string, unknown>;
  const x = finite(o.x);
  const y = finite(o.y);
  const w = finite(o.w);
  const h = finite(o.h);
  if (x === null || y === null || w === null || h === null) return null;
  if (w < MIN_BOX || h < MIN_BOX) return null;
  return { x: Math.round(x), y: Math.round(y), w: Math.round(w), h: Math.round(h) };
}

/**
 * 面板状态。**缺失时返回 undefined**（老会话文件），坏值时逐项降级 ——
 * 一个手改过的 `boxes` 不该把打开着的面板一起丢掉。
 */
function parsePanels(raw: unknown): SessionPanels | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const o = raw as { open?: unknown; boxes?: unknown; collapsed?: unknown; order?: unknown };
  const open = Array.isArray(o.open)
    ? [...new Set(o.open.filter((x): x is string => typeof x === 'string' && x.length > 0))]
    : [];
  const boxes: Record<string, SessionPanelBox> = {};
  if (o.boxes && typeof o.boxes === 'object' && !Array.isArray(o.boxes)) {
    for (const [key, value] of Object.entries(o.boxes as Record<string, unknown>)) {
      const box = parseBox(value);
      if (box) boxes[key] = box;
    }
  }
  const collapsed = Array.isArray(o.collapsed)
    ? [...new Set(o.collapsed.filter((x): x is string => typeof x === 'string' && x.length > 0))]
    : [];
  return { open, boxes, collapsed, order: parseOrder((o as { order?: unknown }).order) };
}

/** 每侧的顺序表。坏值逐侧降级（一侧手改坏了不该把另一侧也清空）。 */
function parseOrder(raw: unknown): { left: string[]; right: string[] } {
  const side = (v: unknown): string[] =>
    Array.isArray(v) ? [...new Set(v.filter((x): x is string => typeof x === 'string' && x.length > 0))] : [];
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { left: [], right: [] };
  const o = raw as { left?: unknown; right?: unknown };
  return { left: side(o.left), right: side(o.right) };
}

function parseView(raw: unknown): SessionView {
  const o = raw as { kind?: unknown; clipId?: unknown } | null;
  const kind = o?.kind;
  if (kind === 'timeline') return { kind };
  if (kind === 'typography' || kind === 'grade' || kind === 'particles') {
    // clipId 的**存在性**在这里不校验（要读工程）；调用方 `applySession` 会再查一次。
    return typeof o?.clipId === 'string' && o.clipId ? { kind, clipId: o.clipId } : { kind: 'timeline' };
  }
  return { kind: 'timeline' };
}

/**
 * 解析一份会话状态。**永不抛**：坏文件（手改过 / 旧版本 / 半截）整份当成没有。
 *
 * 每一项都单独降级，而不是「一处坏就全丢」：播放头读不出来不该把选中集也一起
 * 扔掉 —— 那两件事互不依赖。
 */
export function parseSession(raw: unknown): ProjectSession | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const o = raw as {
    playT?: unknown;
    selectedClipIds?: unknown;
    view?: unknown;
    panels?: unknown;
  };
  const playT = finite(o.playT);
  const ids = Array.isArray(o.selectedClipIds)
    ? o.selectedClipIds.filter((x): x is string => typeof x === 'string' && x.length > 0)
    : [];
  const panels = parsePanels(o.panels);
  return {
    playT: roundPlayT(Math.max(0, playT ?? 0)),
    selectedClipIds: [...new Set(ids)],
    view: parseView(o.view),
    ...(panels ? { panels } : {}),
  };
}

/**
 * 面板状态写盘前的归一：`boxes` 的键排序、几何取整、去掉坏盒子。
 *
 * 排序是必须的：浮窗拖一下就会改几何，而对象键顺序取决于「哪个先被打开」——
 * 不排序时同样两个面板会写出两种字节，`lastWritten` 的相等判断就失效了。
 */
function normalizePanels(p: SessionPanels): SessionPanels {
  const boxes: Record<string, SessionPanelBox> = {};
  for (const key of Object.keys(p.boxes).sort()) {
    const box = parseBox(p.boxes[key]);
    if (box) boxes[key] = box;
  }
  return {
    open: [...new Set(p.open.filter((x) => typeof x === 'string' && x.length > 0))],
    boxes,
    collapsed: [...new Set((p.collapsed ?? []).filter((x) => typeof x === 'string' && x.length > 0))].sort(),
    // 顺序**不排序**：排序就把它抹掉了。去重只按「先出现者优先」。
    order: {
      left: [...new Set((p.order?.left ?? []).filter((x) => typeof x === 'string' && x))],
      right: [...new Set((p.order?.right ?? []).filter((x) => typeof x === 'string' && x))],
    },
  };
}

/** 序列化成落盘文本。键顺序固定（内容没变 → 字节没变，写入端才敢跳过重复写）。 */
export function serializeSession(s: ProjectSession): string {
  return `${JSON.stringify(
    {
      format: SESSION_FORMAT,
      playT: roundPlayT(Math.max(0, finite(s.playT) ?? 0)),
      selectedClipIds: s.selectedClipIds,
      view: s.view,
      ...(s.panels ? { panels: normalizePanels(s.panels) } : {}),
    },
    null,
    2,
  )}\n`;
}

/**
 * 把会话状态对齐到**这一份工程**：播放头钳进时长、选中集只留还存在的片段、
 * 引用已删除片段的视图退回时间轴。
 *
 * 纯函数（单测在 `tests/unit/session.test.ts`）—— 打开工程与草稿恢复共用同一条。
 */
export function applySession(project: Project, session: ProjectSession | null): ProjectSession {
  const base = session ?? defaultSession();
  const ids = new Set<string>();
  for (const track of project.tracks) for (const clip of track.clips) ids.add(clip.id);

  const selected = base.selectedClipIds.filter((id) => ids.has(id));
  const view: SessionView =
    base.view.kind !== 'timeline' && base.view.clipId && !ids.has(base.view.clipId)
      ? { kind: 'timeline' }
      : base.view;

  const duration = finite(project.duration) ?? 0;
  return {
    playT: roundPlayT(Math.min(Math.max(0, base.playT), Math.max(0, duration))),
    selectedClipIds: selected,
    view,
    // 面板与工程内容无关（插件是否还在由宿主判），这里原样带过去。
    ...(base.panels ? { panels: base.panels } : {}),
  };
}

/** 读会话状态。没有文件 / 坏 JSON / 读不动一律 null。 */
export async function readSessionFile(dir: FsDirHandle): Promise<ProjectSession | null> {
  try {
    const text = await readTextIfExists(dir, SESSION_FILE);
    if (!text) return null;
    return parseSession(JSON.parse(text) as unknown);
  } catch {
    return null;
  }
}

/**
 * 写会话状态。失败返回 false（**不抛**：见文件头「可以丢」）。
 *
 * `verify: false`：它是可丢弃状态，读回校验的收益抵不上每次拖动播放头多一次读盘。
 */
export async function writeSessionFile(dir: FsDirHandle, session: ProjectSession): Promise<boolean> {
  try {
    await writeBytesAtomic(dir, SESSION_FILE, serializeSession(session), { verify: false });
    return true;
  } catch {
    return false;
  }
}
