/**
 * audio-plan.ts — 工程在时刻无关意义上的「声音事件表」：**唯一入口**。
 *
 * 为什么要有这一层：预览（`audio/player.ts`）与导出混流（`exporters/mixdown.ts`）
 * 本来各遍历一遍 `AudioClip`。v13 起视频片段的内嵌音轨也要出声，如果两边各自再
 * 加一段「顺便看看视频片段」，第三处（比如将来的 waveform 绘制）就会漏掉 ——
 * 表现是「预览有声音、导出没有」，而没人会逐帧比对两边的混音。
 *
 * 所以两个消费方都只认 `AudioSpan[]`：
 * - 独立的 `AudioClip`（含从视频分离出来的那条）；
 * - 启用视觉轨上、未静音的 video `SourceClip`（`assetId` 就是视频素材 id，
 *   解码侧按「这个素材的音轨」取 buffer）。
 *
 * 分离音频时 store 会把视频的 `audio.muted` 置 true，所以同一段声音不会既走
 * 内嵌音轨又走独立音频片段。
 *
 * 纯函数，可单测（`tests/unit/audio-plan.test.ts`）。
 */

import type { Curve } from './curve';
import { SPEED_CURVE_KEY, minSpeedOf, sourceRangeOf } from './speed';
import type { BeatGrid } from './time';
import type { AudioClip, Project, SourceClip } from './schema';

/** 一条要混进最终波形的事件。时间一律是工程秒。 */
export interface AudioSpan {
  /** 唯一 id：独立音频片段用 clip.id，内嵌音轨用 `${clipId}:embedded`。 */
  id: string;
  assetId: string;
  start: number;
  end: number;
  /** 源内偏移（秒）= 片段起点处的素材时间。 */
  srcIn: number;
  /**
   * **基值**播放速率（1 = 原速）。有 `speedCurve` 时它只是曲线缺省值的来源；
   * 实际速度按曲线求值（变调是已知近似，见 `exporters/mixdown.ts` 的注释）。
   */
  speed: number;
  /**
   * 速度曲线（视频内嵌音轨）。缺省 = 常速 `speed`。
   * 与 `clip.curves.speed` 是同一份数据，`clipStart` 用 `start`。
   */
  speedCurve?: Curve;
  /**
   * 片段区间内出现过 ≤ 0 的速度（倒放）。
   *
   * WebAudio 的 `playbackRate` 必须为正，**预览与导出统一把这类内嵌音轨静音**
   * —— 两条路走同一条规则，才不会出现「预览没声、导出有倒放声」。
   * 要倒放声音请用独立的音频素材（未来）。
   */
  reversed?: boolean;
  /** 这条 span 会读到的素材区间（`from ≤ to`）。负速时 `from` 可能小于 `srcIn`。 */
  srcRange?: { from: number; to: number };
  /** 静态增益（dB）。0 = 原音量。 */
  gainDb: number;
  /** 头尾各淡多少秒（剪辑点防爆音，`ClipBase.fadeSec`）。 */
  fadeSec: number;
  /** 编排用的淡入 / 淡出（秒）。 */
  fadeIn: number;
  fadeOut: number;
  /** 增益关键帧曲线（只有独立音频片段有）。 */
  curves: Record<string, Curve>;
  /** 视频内嵌音轨的宿主片段 id；独立音频片段没有这个字段。 */
  videoClipId?: string;
}

/** 独立音频片段 → span。 */
export function spanFromAudioClip(clip: AudioClip): AudioSpan {
  return {
    id: clip.id,
    assetId: clip.assetId,
    start: clip.start,
    end: clip.end,
    srcIn: clip.srcIn,
    speed: 1,
    gainDb: clip.gainDb ?? 0,
    fadeSec: clip.fadeSec,
    fadeIn: clip.fadeIn ?? 0,
    fadeOut: clip.fadeOut ?? 0,
    curves: clip.curves,
  };
}

/**
 * 视频片段 → span。返回 null = 这条片段这一帧不出声（非 video / 已静音 / 素材
 * 明确没有音轨）。`asset` 可以缺失（工程里的悬空 assetId）：那种情况下仍给
 * span，播放侧解析不到 buffer 就跳过 —— 与音频片段缺素材同一条路。
 *
 * `grid` 只为速度曲线服务（它可以锚到拍）；缺省时锚定曲线会按非锚定解释。
 */
export function spanFromVideoClip(
  clip: SourceClip,
  hasAudio: boolean | undefined,
  grid?: BeatGrid,
): AudioSpan | null {
  if (clip.source.type !== 'video' || !clip.source.assetId) return null;
  // 片段被关掉（`ClipBase.hidden`）= 画面与内嵌音轨一起不参与这一帧。
  // 放在这里而不是两个消费方各判一次：`videoAudioAssetIds` 也过这个函数，
  // 漏了它只是「多解一段没人听的音轨」，漏在 audioSpans 那边就是「静音了导出还有声」。
  if (clip.hidden) return null;
  if (clip.audio?.muted) return null;
  if (hasAudio === false) return null;
  const curve = clip.curves[SPEED_CURVE_KEY];
  return {
    id: `${clip.id}:embedded`,
    assetId: clip.source.assetId,
    start: clip.start,
    end: clip.end,
    srcIn: clip.source.srcIn ?? 0,
    speed: clip.source.speed ?? 1,
    ...(curve ? { speedCurve: curve } : {}),
    reversed: minSpeedOf(clip, grid) <= 0,
    srcRange: sourceRangeOf(clip, grid),
    gainDb: clip.audio?.gainDb ?? 0,
    fadeSec: clip.fadeSec,
    fadeIn: clip.audio?.fadeIn ?? 0,
    fadeOut: clip.audio?.fadeOut ?? 0,
    curves: {},
    videoClipId: clip.id,
  };
}

/**
 * 工程 → 全部声音事件（按轨道顺序；混流本身与顺序无关）。
 *
 * 四种「不发声」在这里收口，**不要**让消费方各判一次：
 *   - `track.enabled === false`：这一层整个不在画面里，声音也不在；
 *   - `track.muted === true`（仅视觉轨，v15）：画面留着、内嵌音轨不要；
 *   - `clip.hidden === true`（片段级开关）：这一段整段不出声；
 *   - `clip.audio.muted`（仅视频内嵌音轨，v13）：在 `spanFromVideoClip` 里判。
 */
export function audioSpans(project: Project): AudioSpan[] {
  const spans: AudioSpan[] = [];
  for (const track of project.tracks) {
    if (!track.enabled) continue;
    if (track.kind === 'audio') {
      for (const clip of track.clips) {
        if (clip.hidden) continue;
        spans.push(spanFromAudioClip(clip));
      }
      continue;
    }
    if (track.muted) continue;
    for (const clip of track.clips) {
      if (clip.kind !== 'source' || clip.source.type !== 'video') continue;
      const span = spanFromVideoClip(clip, project.assets[clip.source.assetId]?.hasAudio, project.beatGrid);
      if (span) spans.push(span);
    }
  }
  return spans;
}

/**
 * 需要**解码音轨**的视频素材 id（去重）。导出 / 播放前按这张表预热。
 *
 * 只收视频：独立音频素材本来就有 `AudioBuffer`（导入时 `decodeAudio` 过），
 * 把它们也塞进来只会让预热多等一次无意义的缓存查询。
 */
export function videoAudioAssetIds(project: Project): string[] {
  const ids = new Set<string>();
  for (const track of project.tracks) {
    if (!track.enabled || track.kind !== 'visual' || track.muted) continue;
    for (const clip of track.clips) {
      if (clip.kind !== 'source' || clip.source.type !== 'video') continue;
      if (spanFromVideoClip(clip, project.assets[clip.source.assetId]?.hasAudio)) ids.add(clip.source.assetId);
    }
  }
  return [...ids];
}
