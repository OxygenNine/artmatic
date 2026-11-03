/**
 * mixdown.ts — 离线音频混流：把工程里所有启用的音频片段混成一条整段 PCM。
 *
 * 为什么必须有这一步（而不是把 AudioBuffer 直接塞给编码器）：
 * `AudioClip` 有 `start` / `end` / `srcIn` / `fadeSec` / `fadeIn` / `fadeOut` /
 * `gain` 曲线，一次导出要求的是**一条从 0 开始、长度 = 工程时长的连续波形**。
 * 编码器只认连续 PCM，多片段的定位、裁剪、淡入淡出、增益包络全得先算完。
 *
 * 包络求值**不在本文件**：唯一真源是 `core/audio-envelope.ts`，预览播放
 * （`audio/player.ts`）对着同一份 —— 两边各写一份的形态是「预览听着对、
 * 导出多了一段渐入」，而那种偏差只会被当成「玄学」。
 *
 * 纯函数、无 Web Audio 依赖（除了要读的 AudioBuffer），所以可单测。
 * 混流本身是 O(duration × sampleRate) 的循环，16s 立体声 48kHz 约 150 万次，
 * 毫秒级，不需要进 Worker。
 */

import type { Project } from '../core/schema';
import { audioClipGainAt, type AudioModCtx } from '../core/audio-envelope';
import { modTable } from '../core/modulation';
import { audioSpans } from '../core/audio-plan';
import { evalCurve, integralCurve } from '../core/curve';

/** 导出音频的统一采样率。48 kHz 是影视与 AAC 的通用值，浏览器也都支持。 */
export const EXPORT_SAMPLE_RATE = 48000;
/** 统一声道数。立体声是默认期望；单声道素材会被复制到双声道。 */
export const EXPORT_CHANNELS = 2;

/** 混流结果。取样数据与 `Web Audio` 的 `AudioBuffer.getChannelData` 同构。 */
export interface MixedAudio {
  sampleRate: number;
  channels: Float32Array[];
  /** 实际时长（秒）。工程被拖长而音频没跟上时，这里短于工程时长。 */
  duration: number;
  /** 峰值绝对值。用于 UI 提示与「是不是导出静音」的断言。 */
  peak: number;
}

/**
 * 把工程混成一条整段波形。`resolve` 按 assetId 给出原始 AudioBuffer。
 *
 * 没有音频片段 / 全部 `track.enabled === false` 时返回 null（导出就不带音轨，
 * 而不是带一条全零的音轨——那会让播放器显示「有声音」但听不见）。
 */
export function mixdown(
  project: Project,
  resolve: (assetId: string) => AudioBuffer | null,
): MixedAudio | null {
  /*
   * 声音事件表由 `core/audio-plan.ts` 给出：独立音频片段 + 视频片段的内嵌音轨
   * （未静音的那些）。混流本身不该再知道「哪些片段算声音」—— 预览播放对着
   * 同一张表，两处各写一份的结果是「预览有、导出没有」。
   */
  const spans = audioSpans(project);
  if (!spans.length) return null;

  const sampleRate = EXPORT_SAMPLE_RATE;
  const total = Math.max(1, Math.ceil(project.duration * sampleRate));
  const out: Float32Array[] = [];
  for (let c = 0; c < EXPORT_CHANNELS; c++) out.push(new Float32Array(total));

  /*
   * 调制上下文建**一次**。放进样本循环里的话每 1/44100 秒构造一个 Map ——
   * 导出两分钟音频就是五百多万次分配，而结果每次都一样。
   */
  const audioCtx: AudioModCtx = {
    fps: project.fps,
    seed: project.seed,
    mods: modTable(project.modulators),
  };

  let peak = 0;
  for (const span of spans) {
    const buf = resolve(span.assetId);
    if (!buf) continue; // 素材缺失 / 视频音轨没解出来：跳过，不中断整条混流
    /*
     * 倒放区间（速度 ≤ 0）：静音。WebAudio 的 `playbackRate` 必须为正，而
     * 预览与导出**必须同一条规则**（否则「预览没声、导出有倒放声」）。
     * 见 `core/audio-plan.ts` 的 `reversed`。
     */
    if (span.reversed) continue;
    const clipDur = span.end - span.start;
    if (clipDur <= 0) continue;

    // 片段在工程时间轴上的起点换算成样本下标。
    const startSample = Math.round(span.start * sampleRate);
    const len = Math.round(clipDur * sampleRate);
    const srcRate = buf.sampleRate;
    const speed = Math.max(0.01, span.speed || 1);
    const channels = Math.max(1, buf.numberOfChannels);
    /*
     * 变速（速度曲线）的源位置 = `srcIn + ∫速度`（`core/speed.ts`）。
     *
     * 每 256 个样本用解析积分重新对齐一次，块内按块首速度推进：误差 < 0.1 ms，
     * 而且是**块下标的函数**（不是「上次算到哪」的跨帧状态），所以同一份工程
     * 导出两次逐样本相同。
     */
    const curve = span.speedCurve;
    const block = 256;
    let mediaSec = span.srcIn;
    let blockSpeed = speed;

    for (let i = 0; i < len; i++) {
      const dst = startSample + i;
      const tAbs = span.start + i / sampleRate;

      let srcPos: number;
      if (curve) {
        if (i % block === 0) {
          mediaSec =
            span.srcIn +
            integralCurve(curve, span.start, tAbs, { grid: project.beatGrid, clipStart: span.start });
          blockSpeed = evalCurve(curve, tAbs, { grid: project.beatGrid, clipStart: span.start });
        }
        srcPos = mediaSec * srcRate;
        mediaSec += blockSpeed / sampleRate;
      } else {
        /*
         * 常速：`srcIn + 片内秒数 × speed`，再乘**素材自己的采样率**。
         *
         * 这一处曾经写死用 `EXPORT_SAMPLE_RATE` 索引源 buffer，而 `decodeAudio`
         * 产出的是 44.1 kHz 的 AudioBuffer —— 导出会比预览快 8.8%。视频音轨
         * 还可能来自任意采样率，所以统一按 buf.sampleRate 映射、线性插值。
         */
        srcPos = (span.srcIn + (i / sampleRate) * speed) * srcRate;
      }
      const i0 = Math.floor(srcPos);
      if (dst < 0 || dst >= total) continue; // 超出工程时长的部分不写
      if (i0 < 0 || i0 >= buf.length) continue;
      const frac = srcPos - i0;

      // 曲线 × 淡变（fadeSec + fadeIn/fadeOut）× 静态增益，只有一份实现。
      const g = audioClipGainAt(span, project.beatGrid, tAbs, audioCtx);
      if (g === 0) continue;

      for (let c = 0; c < EXPORT_CHANNELS; c++) {
        // 单声道素材复制到双声道。
        const src = buf.getChannelData(Math.min(c, channels - 1));
        const s0 = src[i0] ?? 0;
        const s1 = frac > 0 ? (src[i0 + 1] ?? s0) : s0;
        const v = (s0 + (s1 - s0) * frac) * g;
        out[c]![dst] += v;
        const a = Math.abs(v);
        if (a > peak) peak = a;
      }
    }
  }
  return { sampleRate, channels: out, duration: project.duration, peak };
}

/**
 * 混流结果 → `AudioBuffer`，交给 `mediabunny` 的 `AudioBufferSource`。
 *
 * 不手工切 `AudioData` 分块：mediabunny 的 `add(AudioBuffer)` 自己管分块与
 * 背压（内部逐块 encode 并 await）。手工造 `AudioData` 只会多一层
 * interleaved/planar 的转换与一个「切多大块」的伪参数。
 *
 * `new AudioBuffer(...)` 在旧 Safari 上不存在，用标准 constructor 兜底。
 */
export function toAudioBuffer(mixed: MixedAudio, ctx: BaseAudioContext): AudioBuffer {
  const buf = ctx.createBuffer(
    EXPORT_CHANNELS,
    Math.max(1, mixed.channels[0]!.length),
    mixed.sampleRate,
  );
  for (let c = 0; c < EXPORT_CHANNELS; c++) {
    // 重建一次以抹掉 TS 5.7+ 的 `Float32Array<ArrayBufferLike>` 泛型差异
    // （`copyToChannel` 只收 `Float32Array<ArrayBuffer>`）。与 project-io 那次
    // 遇到的 SharedArrayBuffer assignable 问题同族。
    buf.copyToChannel(new Float32Array(mixed.channels[c]!), c);
  }
  return buf;
}
