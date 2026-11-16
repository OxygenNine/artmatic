/**
 * features.ts — 音频特征轨（**离线、确定性**）。
 *
 * 存在的理由：angel-echo 的场景靠一整套音频特征驱动（rms / 分频 / 谱重心 /
 * 谱平坦度 / onset 年龄 / 累积行程）。artmatic 此前只有「逐帧频谱纹理」
 * （给律动条读当前帧的 bin），没有这些**标量曲线**。见
 * `algos/feature-source.ts` 的说明：它们必须是离线曲线，不能是逐帧累加器。
 *
 * ## 与 `computeSpectrum` 共用一趟走查
 *
 * 二者都要逐帧做同一个 FFT（同一个窗、同一个 hop）。再走一趟就是把这件
 * 机械劳动抄两遍，所以 `computeSpectrum` 接受一个 `onFrame` 钩子，把这个
 * 累加器挂上去 —— **一趟得到两样东西**。累加器本身不碰 FFT，只吃
 * `(mag, rms)`，所以单测可以直接喂合成的幅度谱。
 *
 * ## 归一化在 `finish()` 里做，不在 `push()` 里
 *
 * 所有曲线按**整首轨**的相对峰值归一（0..1）。逐帧归一不可能做到：
 * 那需要知道全曲的峰值，而那正是 finish 才有的信息。这也让 `at(t)` 可以
 * 保持纯函数 —— 归一化系数是常量，不是滚动状态。
 */

import { AGE_SENTINEL, zeroFeatures, type AudioFeatureSource, type AudioFeatures } from '../algos/feature-source';
import { createChromaAccumulator, type ChromaAccumulator } from './chroma';

/** 五个频段的边界（Hz）。air 的上界取 16 kHz，再往上在 44.1 kHz 采样下已接近 Nyquist。 */
const BANDS = [
  { key: 'sub', lo: 20, hi: 60 },
  { key: 'bass', lo: 60, hi: 250 },
  { key: 'mid', lo: 250, hi: 2000 },
  { key: 'high', lo: 2000, hi: 6000 },
  { key: 'air', lo: 6000, hi: 16000 },
] as const;

type BandKey = (typeof BANDS)[number]['key'];

/** onset 检测：超过局部均值这么多倍才算一个峰。 */
const ONSET_RATIO = 1.55;
/** 两个 onset 的最小间隔（秒）—— 防止一个起音被拆成好几个。 */
const ONSET_MIN_GAP = 0.09;
/** onset 局部均值的半窗（秒）。 */
const ONSET_WIN = 0.25;
/**
 * onset 的**绝对下限**：至少要达到全曲 flux 峰值的这个比例。
 *
 * 只靠「超过局部均值 1.55 倍」是不够的：Hann 窗每跳 882 个样本（不是周期的整数倍），
 * 一个**稳态**正弦的泄漏谱每帧都在轻微变化，通量于是有周期性小峰。局部均值判据
 * 在整段都这么抖的时候照样会放行 —— 实测一个 110 Hz 长音被判出每秒 10 个 onset。
 *
 * 后果有两处，都不报错：`u_hit` 让长音 pad 以 10 Hz 闪（视觉上的假鼓点）；
 * 新的 `energy` 把小节密度算高，安静的 pad 段被当成高潮。
 *
 * 5% 是安全的：真实鼓点的通量是泄漏地板的几十倍。
 */
const ONSET_FLOOR = 0.05;
/** 累积行程的增益（rms 满值时约每秒走多少单位）。**调过的观感常数**。 */
const TRAVEL_GAIN = 8;

export interface FeatureTrack extends AudioFeatureSource {
  readonly fps: number;
  readonly frames: number;
  /** onset 时刻（秒，与 `at(t)` 同一时间轴），升序。**只读用途**（调试 / 波形）。 */
  readonly onsets: Float32Array;
  /**
   * 逐帧音级剖面，`frames * 12`，行优先，逐帧已 L2 归一。只有
   * `FeatureOptions.chroma` 打开时才有。
   *
   * **不进 `AudioFeatures`**：它是给 `structure.ts` 做段落聚类用的，shader 不需要，
   * 所以 `sceneUniforms` / 纹理绑定零改动、零成本。
   */
  readonly chroma?: Float32Array;
}

export interface FeatureAccumulator {
  /** 每帧调用一次。`mag` 是**复用缓冲**，累加器必须当场取走要用的东西。 */
  push(mag: Float32Array, rms: number): void;
  finish(): FeatureTrack;
}

export interface FeatureOptions {
  bins: number;
  hopSec: number;
  sampleRate: number;
  /** 即将 push 的次数（预分配）。必须与实际 push 次数一致。 */
  frames: number;
  /** 同时算 chroma（段落聚类用）。缺省不算 —— 那是 ≈ 帧数 × 48 字节。 */
  chroma?: boolean;
}

export function createFeatureAccumulator(opts: FeatureOptions): FeatureAccumulator {
  const { bins, hopSec, sampleRate, frames } = opts;
  const nyquist = sampleRate / 2;
  const binHz = bins > 1 ? nyquist / (bins - 1) : 0;
  const chromaAcc: ChromaAccumulator | null = opts.chroma
    ? createChromaAccumulator({ bins, sampleRate, frames })
    : null;

  // 每条曲线先存原始值，归一化留给 finish()
  const rmsRaw = new Float32Array(frames);
  const fluxRaw = new Float32Array(frames);
  const centroid = new Float32Array(frames);
  const flat = new Float32Array(frames);
  const band: Record<BandKey, Float32Array> = {
    sub: new Float32Array(frames),
    bass: new Float32Array(frames),
    mid: new Float32Array(frames),
    high: new Float32Array(frames),
    air: new Float32Array(frames),
  };

  // 每个频段覆盖的 bin 闭区间。预先算好，push 里不再做浮点比较。
  const ranges = BANDS.map((b) => {
    const lo = Math.max(0, Math.ceil(b.lo / (binHz || 1)));
    const hi = Math.min(bins - 1, Math.floor(b.hi / (binHz || 1)));
    return { key: b.key, lo, hi: Math.max(lo, hi) };
  });

  const prevMag = new Float32Array(bins);
  let havePrev = false;
  let i = 0;

  return {
    push(mag: Float32Array, rms: number): void {
      if (i >= frames) return;
      rmsRaw[i] = rms;
      // chroma 必须在同一帧上算：mag 是复用缓冲，出了 push 就变了。
      chromaAcc?.push(mag);

      // flux：正向前半差分和
      let flux = 0;
      if (havePrev) {
        for (let k = 0; k < bins; k += 1) {
          const d = mag[k]! - prevMag[k]!;
          if (d > 0) flux += d;
        }
      }
      fluxRaw[i] = flux;

      // 谱重心 + 平坦度（一趟扫完）
      let sumMag = 0;
      let sumFreqMag = 0;
      let sumLog = 0;
      let nonzero = 0;
      for (let k = 0; k < bins; k += 1) {
        const m = mag[k]!;
        sumMag += m;
        sumFreqMag += m * k * binHz;
        if (m > 1e-9) {
          sumLog += Math.log(m);
          nonzero += 1;
        }
      }
      centroid[i] = sumMag > 1e-12 ? Math.min(1, sumFreqMag / sumMag / nyquist) : 0;
      // 几何均值在对数域算（直接连乘会下溢）。
      const geo = nonzero > 0 ? Math.exp(sumLog / bins) : 0;
      const arith = sumMag / bins;
      flat[i] = arith > 1e-12 ? Math.min(1, geo / arith) : 0;

      // 分频能量：均方根，再按区间宽度归一 —— 宽的频段不该因为 bin 多就更亮
      for (const r of ranges) {
        let e = 0;
        for (let k = r.lo; k <= r.hi; k += 1) {
          const m = mag[k]!;
          e += m * m;
        }
        band[r.key][i] = Math.sqrt(e / (r.hi - r.lo + 1));
      }

      prevMag.set(mag);
      havePrev = true;
      i += 1;
    },

    finish(): FeatureTrack {
      const rms = norm(rmsRaw);
      const flux = norm(fluxRaw);
      const bands: { key: BandKey; data: Float32Array }[] = BANDS.map((b) => ({
        key: b.key,
        data: norm(band[b.key]),
      }));

      // 累积行程：rms 的确定性前缀积分
      const travel = new Float32Array(frames);
      let acc = 0;
      for (let k = 0; k < frames; k += 1) {
        acc += rms[k]! * hopSec * TRAVEL_GAIN;
        travel[k] = acc;
      }

      // onset 在**原始** flux 上挑：归一化是线性缩放，峰位置不变，但用原始值
      // 免得将来有人改了归一化方式而悄悄改变 onset 集合。
      const onsets = detectOnsets(fluxRaw, hopSec, frames);

      return makeTrack({
        fps: 1 / hopSec,
        frames,
        hopSec,
        rms,
        flux,
        centroid,
        flat,
        band: bands,
        travel,
        onsets,
        ...(chromaAcc ? { chroma: chromaAcc.finish() } : {}),
      });
    },
  };
}

/** 按峰值归一到 0..1。峰值太小时原样留下（静音段不该被放大成噪声）。 */
function norm(a: Float32Array): Float32Array {
  let peak = 0;
  for (let i = 0; i < a.length; i += 1) if (a[i]! > peak) peak = a[i]!;
  if (peak > 1e-12) for (let i = 0; i < a.length; i += 1) a[i] = a[i]! / peak;
  return a;
}

/**
 * flux 上的自适应峰值挑选。
 *
 * 判据是「超过局部均值的 `ONSET_RATIO` 倍，且是局部极大」，再加上最小间隔。
 * 不做全局 z-score：一段安静的前奏会把整首曲子的阈值拉到 onsets 全灭。
 */
function detectOnsets(flux: Float32Array, hopSec: number, frames: number): Float32Array {
  const out: number[] = [];
  if (frames < 3) return Float32Array.from(out);
  const win = Math.max(1, Math.round(ONSET_WIN / hopSec));
  const gapFrames = Math.max(1, Math.round(ONSET_MIN_GAP / hopSec));

  // 局部均值走前缀和，O(1) 取窗
  const prefix = new Float64Array(frames + 1);
  let peak = 0;
  for (let i = 0; i < frames; i += 1) {
    prefix[i + 1] = prefix[i]! + flux[i]!;
    if (flux[i]! > peak) peak = flux[i]!;
  }
  const floor = peak * ONSET_FLOOR;

  let lastFrame = -gapFrames * 2;
  for (let i = 1; i < frames - 1; i += 1) {
    const v = flux[i]!;
    // 绝对下限先挡掉稳态音的泄漏抖动，再谈局部峰值与相对高度。
    if (v < floor) continue;
    const lo = Math.max(0, i - win);
    const hi = Math.min(frames, i + win + 1);
    const mean = (prefix[hi]! - prefix[lo]!) / (hi - lo);
    if (v <= mean * ONSET_RATIO || v <= flux[i - 1]! || v < flux[i + 1]!) continue;
    if (i - lastFrame < gapFrames) continue;
    lastFrame = i;
    out.push(i * hopSec);
  }
  return Float32Array.from(out);
}

interface TrackData {
  fps: number;
  frames: number;
  hopSec: number;
  rms: Float32Array;
  flux: Float32Array;
  centroid: Float32Array;
  flat: Float32Array;
  band: { key: BandKey; data: Float32Array }[];
  travel: Float32Array;
  onsets: Float32Array;
  chroma?: Float32Array;
}

function makeTrack(d: TrackData): FeatureTrack {
  const { frames, hopSec } = d;
  const lastTime = (frames - 1) * hopSec;

  const sample = (a: Float32Array, t: number): number => {
    if (frames === 0) return 0;
    const x = t / hopSec;
    if (x <= 0) return a[0]!;
    if (x >= frames - 1) return a[frames - 1]!;
    const i = x | 0;
    const f = x - i;
    return a[i]! + (a[i + 1]! - a[i]!) * f;
  };

  const silence = (out: AudioFeatures): void => {
    zeroFeatures(out);
  };

  return {
    fps: d.fps,
    frames,
    onsets: d.onsets,
    ...(d.chroma ? { chroma: d.chroma } : {}),
    at(t: number, out: AudioFeatures): void {
      if (frames === 0 || t < 0 || t > lastTime + hopSec) {
        silence(out);
        return;
      }
      out.rms = sample(d.rms, t);
      out.flux = sample(d.flux, t);
      out.centroid = sample(d.centroid, t);
      out.flat = sample(d.flat, t);
      out.travel = sample(d.travel, t);
      for (const b of d.band) out[b.key] = sample(b.data, t);
      fillAges(d.onsets, t, out.ages);
    },
  };
}

/** 最近四个 onset 的年龄（秒）。二分找 ≤ t 的最后一个，然后往回数四个。 */
function fillAges(onsets: Float32Array, t: number, out: Float32Array): void {
  let lo = 0;
  let hi = onsets.length; // 第一个 > t 的位置
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (onsets[mid]! <= t) lo = mid + 1;
    else hi = mid;
  }
  for (let k = 0; k < 4; k += 1) {
    const idx = lo - 1 - k;
    out[k] = idx >= 0 ? Math.max(0, t - onsets[idx]!) : AGE_SENTINEL;
  }
}

/** 采样率相关的便利：从 `numberOfChannels` 无关的缓冲算 rms。供 `computeSpectrum` 的钩子用。 */
export function frameRms(samples: Float32Array, from: number, n: number): number {
  let s = 0;
  for (let i = 0; i < n; i += 1) {
    const v = samples[from + i] ?? 0;
    s += v * v;
  }
  return Math.sqrt(s / Math.max(1, n));
}
