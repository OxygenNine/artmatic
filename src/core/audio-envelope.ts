/**
 * audio-envelope.ts — 音频片段的增益包络：**唯一真源**。
 *
 * 三件事叠在一起决定「这一秒响多少」：
 *
 * 1. `curves.gain` —— 关键帧曲线（编排用的自动化）。
 * 2. `ClipBase.fadeSec` —— 头尾各淡这么多秒（剪辑点的防爆音，v1 起就有）。
 * 3. `AudioClip.fadeIn` / `fadeOut` —— 用户拖片段两端三角手柄设的淡变（v8）。
 *
 * 预览播放（`audio/player.ts`）与导出混流（`exporters/mixdown.ts`）都必须对着
 * **同一份求值**：两边各写一份三角函数的形态是「预览听着对、导出多了一段渐入」，
 * 而那种偏差没有人会去逐帧比对，只会被当成「玄学」。
 *
 * 纯函数、无 WebAudio 依赖 ⇒ 可单测（`tests/unit/audio-envelope.test.ts`）。
 */

import { emptyModTable, resolveParam, type ModTable } from './modulation';
import type { AudioClip } from './schema';
import type { BeatGrid } from './time';

/**
 * 一个声音事件上决定响度的所有字段（导出/播放共用）。
 *
 * v13 起也覆盖视频片段的内嵌音轨（`core/audio-plan.ts::AudioSpan` 结构兼容），
 * 所以这里不绑定 `AudioClip` 的具体形状。
 */
export type AudioGainSource = Pick<AudioClip, 'start' | 'end' | 'curves'> &
  Partial<Pick<AudioClip, 'fadeSec' | 'fadeIn' | 'fadeOut' | 'gainDb'>>;

const clamp01 = (v: number): number => (v < 0 ? 0 : v > 1 ? 1 : v);

/** dB → 线性倍数。-60 dB 及以下直接归 0（滑杆底 = 静音，而不是「很轻」）。 */
export function dbToLinear(db: number): number {
  if (!Number.isFinite(db) || db <= -60) return 0;
  return 10 ** (db / 20);
}

/**
 * 片内位置 `posSec` 处的淡变包络（0..1）。
 *
 * 三条斜坡**相乘**（各自独立钳制，最后一起生效）：
 *   - `fadeSec`：头尾各 `f = min(fadeSec, dur/2)`，保证两个淡区不相交 ———
 *     相交的话中段会被压到 `fade/fade`，听感上是一个喘不上气的小坑。
 *   - `fadeIn + fadeOut` 超出片段长度时**按比例收缩**两边，而不是让后写的赢：
 *     「拖得太长」的预期是「整段都在淡」，不是「一半突然变成硬的」。
 *
 * `posSec` 超出 `[0, dur]` 时按端点算（片段外没有声音，由调用方负责不播放）。
 */
export function audioEnvelopeAt(posSec: number, clipDur: number, env: AudioGainSource): number {
  const dur = Math.max(0, clipDur);
  if (dur <= 0) return 0;
  const pos = posSec < 0 ? 0 : posSec > dur ? dur : posSec;

  let v = 1;

  const f0 = Math.min(Math.max(0, env.fadeSec ?? 0), dur / 2);
  if (f0 > 0) {
    if (pos < f0) v *= pos / f0;
    else if (dur - pos < f0) v *= (dur - pos) / f0;
  }

  const rawIn = Math.max(0, env.fadeIn ?? 0);
  const rawOut = Math.max(0, env.fadeOut ?? 0);
  const sum = rawIn + rawOut;
  const k = sum > dur ? dur / sum : 1;
  const fi = rawIn * k;
  const fo = rawOut * k;
  if (fi > 0 && pos < fi) v *= pos / fi;
  if (fo > 0 && dur - pos < fo) v *= (dur - pos) / fo;

  return clamp01(v);
}

/**
 * 声音侧求值的调制上下文（可选）。
 *
 * 为什么是可选的：`audio-envelope` 也被离线路径调用（单测、没有工程的探针），
 * 而那些调用点本来就没有调制器。缺省表是空表 ⇒ 行为与加调制之前逐位相同。
 */
export interface AudioModCtx {
  fps?: number;
  seed?: number;
  mods?: ModTable;
}

/**
 * 片段 `tAbs`（工程绝对秒）处的 gain 曲线值；没有曲线约定为 1（不是 0）。
 *
 * `clipStart` 传 0 是既有的约定：`curves.gain` 的键是**绝对时间**（历史上就
 * 这么写），所以它的 t=0 是工程起点而不是片段起点。改这条会让所有已存工程的
 * 音量自动化整体平移。
 */
export function audioGainAt(
  source: Pick<AudioClip, 'curves' | 'mods'>,
  grid: BeatGrid,
  tAbs: number,
  ctx?: AudioModCtx,
): number {
  const curve = source.curves.gain;
  const slots = source.mods?.gain;
  if (!curve && !slots?.length) return 1;
  const g = resolveParam(source, 'gain', 1, tAbs, {
    grid,
    fps: ctx?.fps ?? 30,
    seed: ctx?.seed ?? 0,
    clipStart: 0,
    mods: ctx?.mods ?? emptyModTable(),
  });
  return Number.isFinite(g) ? Math.max(0, g) : 1;
}

/**
 * 导出混流与预览播放共用的**唯一**增益表达式：曲线 × 淡变。
 *
 * `tAbs` 是工程时间（秒）。片外返回 0 —— 调用方仍要先判 `tAbs` 是否落在
 * `[clip.start, clip.end)`，这里只是不让它算出「负数位置」的怪值。
 */
export function audioClipGainAt(
  clip: AudioGainSource,
  grid: BeatGrid,
  tAbs: number,
  ctx?: AudioModCtx,
): number {
  const pos = tAbs - clip.start;
  const dur = clip.end - clip.start;
  if (pos < 0 || pos > dur) return 0;
  /* 静态增益（v13）在这里乘一次；曲线与淡变仍是各自相乘。 */
  return (
    audioGainAt(clip, grid, tAbs, ctx) *
    audioEnvelopeAt(pos, dur, clip) *
    dbToLinear(clip.gainDb ?? 0)
  );
}

/**
 * 把包络采样成 `[fromSec, toSec]`（片内时间）上的一条曲线，供 WebAudio 的
 * `GainNode.setValueCurveAtTime` 用。
 *
 * `count` 个点均匀覆盖闭区间（首尾都取到）。点数不是越多越好：这条曲线只是
 * 「让播放听起来对」，真正的逐样本求值在导出那条路上；128 点对秒级的线性斜坡
 * 已经远超耳朵的分辨率，而 `setValueCurveAtTime` 的实现是线性插值。
 */
export function sampleAudioEnvelope(
  clip: AudioGainSource,
  grid: BeatGrid,
  fromSec: number,
  toSec: number,
  count = 128,
  ctx?: AudioModCtx,
): Float32Array {
  const n = Math.max(2, Math.floor(count));
  const out = new Float32Array(n);
  const span = toSec - fromSec;
  for (let i = 0; i < n; i += 1) {
    const pos = fromSec + (span * i) / (n - 1);
    out[i] = audioClipGainAt(clip, grid, clip.start + pos, ctx);
  }
  return out;
}
