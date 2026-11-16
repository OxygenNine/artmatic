/**
 * chroma.ts — 12 维音级剖面（**离线**，与频谱共用一趟 FFT）。
 *
 * 存在的理由只有一个：**段落归组**。文献的结论很明确 —— 边界检测用音色/能量
 * 特征最准，而「这两段是不是同一个段落」要看音高内容（chroma / PCP）。
 * 拿音色去聚类会把「换了鼓但和弦一样」的两段判成不同段落。
 *
 * ## 为什么不做 HPSS
 *
 * 教科书做法是先做谐波/打击乐分离再取 chroma。这里没有做：percussive 是宽带，
 * 它在 12 个音级上叠加的是一个**近似常数地板**，而 `structure.ts` 在聚合到小节时
 * 用的是**逐音级中位数**而不是均值 —— 中位数天然把短的冲击滤掉、留下持续音。
 * 把这件事放在聚合侧做，比逐帧滚动中位数快两个数量级，而且口径更好解释。
 *
 * ## 为什么下限是 C3
 *
 * bin 宽 = nyquist/(bins-1)。44.1 kHz / 1025 bin 下是 21.5 Hz，而 C3 处一个半音
 * 只有 7.8 Hz —— 三角滤波器会退化成一个 bin。再往下「分辨音级」是自欺，不如
 * 直接从 C3 起算，把低频留给 `bass` / `sub` 特征。
 */

/** 音级数。C = 0，与 MIDI 的 `note % 12` 同一口径。 */
export const CHROMA_DIM = 12;

/** 最低音 C3。再低半音间距就小于一个 bin。 */
const LOWEST_HZ = 130.81;
/** 最高音的硬上限（Hz）。44.1 kHz 下 B7 约 3951，留出谐波余量。 */
const HIGH_CAP_HZ = 8000;
/** 三角半宽的下限（bin）—— 低频段一个滤波器不能窄过一个 bin，否则能量落空。 */
const MIN_HALF_BINS = 1.5;

/** 稀疏三角滤波器组：`(bin 下标, 权重, 音级)` 三元组。 */
export interface ChromaFilterbank {
  idx: Int32Array;
  wt: Float32Array;
  pc: Uint8Array;
  count: number;
}

const EMPTY_BANK: ChromaFilterbank = {
  idx: new Int32Array(0),
  wt: new Float32Array(0),
  pc: new Uint8Array(0),
  count: 0,
};

/**
 * 造滤波器组。`bins` / `sampleRate` 必须与 `planSpectrum` 的口径一致
 * （见 `spectrum.ts`：bin 数只有一个真源）。
 */
export function buildChromaFilterbank(bins: number, sampleRate: number): ChromaFilterbank {
  const nyquist = sampleRate / 2;
  const binHz = bins > 1 ? nyquist / (bins - 1) : 0;
  if (!(binHz > 0)) return EMPTY_BANK;

  const top = Math.min(HIGH_CAP_HZ, nyquist * 0.45);
  if (!(top > LOWEST_HZ)) return EMPTY_BANK;

  const semis = Math.floor(12 * Math.log2(top / LOWEST_HZ)) + 1;
  const idx: number[] = [];
  const wt: number[] = [];
  const pc: number[] = [];

  for (let s = 0; s < semis; s += 1) {
    const centre = (LOWEST_HZ * Math.pow(2, s / 12)) / binHz;
    if (centre >= bins - 1) break;
    // 半宽取相邻半音间距的一半（Hz）换算成 bin，但不小于 1.5 bin。
    const prev = (LOWEST_HZ * Math.pow(2, (s - 1) / 12)) / binHz;
    const next = (LOWEST_HZ * Math.pow(2, (s + 1) / 12)) / binHz;
    const half = Math.max(MIN_HALF_BINS, (next - prev) / 2);
    const lo = Math.max(0, Math.ceil(centre - half));
    const hi = Math.min(bins - 1, Math.floor(centre + half));
    const pitchClass = s % CHROMA_DIM;
    for (let k = lo; k <= hi; k += 1) {
      const w = 1 - Math.abs(k - centre) / half;
      if (w <= 0) continue;
      idx.push(k);
      wt.push(w);
      pc.push(pitchClass);
    }
  }

  if (idx.length === 0) return EMPTY_BANK;
  return {
    idx: Int32Array.from(idx),
    wt: Float32Array.from(wt),
    pc: Uint8Array.from(pc),
    count: idx.length,
  };
}

export interface ChromaAccumulator {
  /** 每帧调用一次。`mag` 是**复用缓冲**，必须当场取走。 */
  push(mag: Float32Array): void;
  /** `frames * CHROMA_DIM`，行优先。逐帧已 L2 归一。 */
  finish(): Float32Array;
}

/**
 * 逐帧 chroma 累加器。挂在 `computeSpectrum` 的 `onFrame` 钩子上，
 * 与线性幅度谱共用同一趟走查。
 *
 * 每帧只做「能量加权到 12 个音级 + L2 归一」：归一化掉的是响度，留下的是音级
 * 分布 —— 一段安静的和弦与一段响亮的同一个和弦应该给出同一个 chroma。
 */
export function createChromaAccumulator(opts: {
  bins: number;
  sampleRate: number;
  frames: number;
}): ChromaAccumulator {
  const { bins, sampleRate, frames } = opts;
  const bank = buildChromaFilterbank(bins, sampleRate);
  const data = new Float32Array(Math.max(0, frames) * CHROMA_DIM);
  const acc = new Float64Array(CHROMA_DIM);
  let cursor = 0;

  return {
    push(mag: Float32Array): void {
      if (cursor >= frames) return;
      acc.fill(0);
      for (let e = 0; e < bank.count; e += 1) {
        const m = mag[bank.idx[e]!]!;
        acc[bank.pc[e]!] += bank.wt[e]! * m * m;
      }
      let norm = 0;
      for (let p = 0; p < CHROMA_DIM; p += 1) norm += acc[p]! * acc[p]!;
      norm = Math.sqrt(norm);
      const base = cursor * CHROMA_DIM;
      if (norm > 1e-12) {
        for (let p = 0; p < CHROMA_DIM; p += 1) data[base + p] = acc[p]! / norm;
      }
      cursor += 1;
    },
    finish(): Float32Array {
      return data;
    },
  };
}
