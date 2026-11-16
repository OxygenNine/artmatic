/**
 * music-store.ts — 「此刻的音乐地图」的唯一入口（**进程级共享**）。
 *
 * 三条消费方读的是同一份：
 * - 预览 / 导出：`ProjectAudio.musicAt(t)`（调制器表达式里的 `energy` / `sectionU`）
 * - agent：`analyze_music`（段落表 + drop 时刻表）
 * - 音乐地图渲染：`render_music_map`
 *
 * 各算一份的后果不是「多花点 CPU」：网格或窗口有一处不同，agent 排的镜头与画面
 * 上实际发生的段落就会错位，而且**没有任何报错**。
 *
 * 缓存键把**影响结果的每个输入**都算进去（素材 / 拍网格 / 窗口 / 最短段落长度）。
 * 拍网格被 `setBeatGrid` 原地改写（`Object.assign`），所以不能按 project 引用判失效。
 */

import type { AudioClip, Project } from '../core/schema';
import type { BeatGrid } from '../core/time';
import { peekAnalysis, type AnalysisBuffer } from './analysis';
import { buildMusicMap, DEFAULT_MIN_SECTION_BARS, type MusicMap } from './structure';

/** 一次分析的范围：哪条片段、工程时间怎么折算、窗口到哪。 */
export interface AnalysisClip {
  clip: AudioClip;
  /** `projectT = assetT + timeOffset`，即 `clip.start - clip.srcIn`。 */
  timeOffset: number;
  windowStart: number;
  windowEnd: number;
}

/**
 * 挑要分析的那条音频片段。
 *
 * 缺省取**最长**的那条：一张工程里常有一条正式 master 加几条音效，
 * 「最早开始」会被一段 2 秒的过场抢走。平局依次比 `start`（小的优先）与 `id`
 * （字典序小的优先），保证同一工程每次挑到同一条。
 */
export function pickAnalysisClip(project: Project, clipId?: string): AnalysisClip | null {
  let best: AudioClip | null = null;
  for (const track of project.tracks) {
    if (track.kind !== 'audio') continue;
    for (const clip of track.clips) {
      if (clip.kind !== 'audio') continue;
      if (clipId !== undefined) {
        if (clip.id === clipId) best = clip;
        continue;
      }
      if (!best) {
        best = clip;
        continue;
      }
      const d = clip.end - clip.start;
      const bd = best.end - best.start;
      if (d > bd + 1e-9) best = clip;
      else if (Math.abs(d - bd) <= 1e-9) {
        if (clip.start < best.start - 1e-9) best = clip;
        else if (Math.abs(clip.start - best.start) <= 1e-9 && clip.id < best.id) best = clip;
      }
    }
  }
  // 显式给了 clipId 却没找到 / 不是音频：交给调用方报 not-found。
  if (clipId !== undefined && !best) return null;
  if (!best) return null;
  return {
    clip: best,
    timeOffset: best.start - best.srcIn,
    windowStart: best.start,
    windowEnd: best.end,
  };
}

/** 缓存里同时留几份地图。窗口拖动、改网格会各产生一份，留几份够周转。 */
const MAX_CACHED_MAPS = 6;
const maps = new Map<string, MusicMap>();

function mapKey(clip: AudioClip, grid: BeatGrid, win: AnalysisClip, minBars: number): string {
  return [
    clip.assetId,
    clip.start,
    clip.end,
    clip.srcIn,
    grid.bpm,
    grid.offset,
    grid.beatsPerBar,
    win.windowStart,
    win.windowEnd,
    minBars,
  ].join('|');
}

/**
 * 取（必要时算）当前工程的分析地图。**同步**：分析没算好时返回 null，
 * 而不是挂一个 Promise —— 渲染路径每帧都调它，等不起。
 */
export function musicMapFor(
  project: Project,
  bufferFor: (assetId: string) => AnalysisBuffer | null,
  opt?: { clipId?: string; minSectionBars?: number },
): MusicMap | null {
  const win = pickAnalysisClip(project, opt?.clipId);
  if (!win) return null;
  const minBars = Math.max(1, Math.round(opt?.minSectionBars ?? DEFAULT_MIN_SECTION_BARS));
  const key = mapKey(win.clip, project.beatGrid, win, minBars);
  const hit = maps.get(key);
  if (hit) return hit;

  const buffer = bufferFor(win.clip.assetId);
  if (!buffer) return null;
  const analysis = peekAnalysis(win.clip.assetId, buffer);
  if (!analysis) return null;

  const map = buildMusicMap({
    features: analysis.features,
    chroma: analysis.features.chroma ?? null,
    grid: project.beatGrid,
    timeOffset: win.timeOffset,
    windowStart: win.windowStart,
    windowEnd: win.windowEnd,
    minSectionBars: minBars,
    assetId: win.clip.assetId,
  });

  if (maps.size >= MAX_CACHED_MAPS) {
    // 插入序最早的先走（Map 保证插入序）。不追求 LRU：命中率本来就不是瓶颈。
    const oldest = maps.keys().next().value;
    if (oldest !== undefined) maps.delete(oldest);
  }
  maps.set(key, map);
  return map;
}

/** 丢掉全部分析地图（换工程 / 素材被删 / 网格重估之后）。 */
export function clearMusicMaps(): void {
  maps.clear();
}

/** 某一时刻在音乐地图上的位置。没有段落时全部给 0，不抛错。 */
export interface MusicMoment {
  /** 段落序号（0 基）。 */
  section: number;
  /** 该处的小节能量，0..3（小节中心之间线性插值 —— 阶跃会让慢参数一卡一卡）。 */
  energy: number;
  /** 段内进度 0..1。 */
  sectionU: number;
  /** 入口边界强度 0..1。 */
  novelty: number;
}

export function momentAt(map: MusicMap, t: number): MusicMoment {
  const secs = map.sections;
  if (secs.length === 0) return { section: 0, energy: 0, sectionU: 0, novelty: 0 };
  const s = secs[lastStartingAt(secs, t)]!;
  const span = Math.max(1e-6, s.end - s.start);
  return {
    section: s.index,
    energy: energyAt(map, t),
    sectionU: Math.min(1, Math.max(0, (t - s.start) / span)),
    novelty: s.novelty,
  };
}

/** 最后一个 `start <= t` 的下标；都晚于 t 时给 0。 */
function lastStartingAt(rows: readonly { start: number }[], t: number): number {
  let lo = 0;
  let hi = rows.length - 1;
  let idx = 0;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (rows[mid]!.start <= t) {
      idx = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return idx;
}

function energyAt(map: MusicMap, t: number): number {
  const bars = map.bars;
  if (bars.length === 0) return 0;
  const i = lastStartingAt(bars, t);
  const a = bars[i]!;
  const b = bars[Math.min(bars.length - 1, i + 1)]!;
  if (b === a) return a.energy;
  const ca = a.start + a.duration / 2;
  const cb = b.start + b.duration / 2;
  if (!(cb > ca)) return a.energy;
  const u = Math.min(1, Math.max(0, (t - ca) / (cb - ca)));
  return a.energy + (b.energy - a.energy) * u;
}
