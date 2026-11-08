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

export interface ProjectSession {
  /** 播放头（秒）。 */
  playT: number;
  /** 选中的片段 id（顺序 = 加入顺序，与 `OpenProject.selectedClipIds` 一致）。 */
  selectedClipIds: string[];
  view: SessionView;
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
  };
  const playT = finite(o.playT);
  const ids = Array.isArray(o.selectedClipIds)
    ? o.selectedClipIds.filter((x): x is string => typeof x === 'string' && x.length > 0)
    : [];
  return {
    playT: roundPlayT(Math.max(0, playT ?? 0)),
    selectedClipIds: [...new Set(ids)],
    view: parseView(o.view),
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
