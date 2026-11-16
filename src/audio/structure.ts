/**
 * structure.ts — 小节级「音乐地图」（**离线、确定性、纯函数**）。
 *
 * 做三件 agent 无法自己完成的事：
 * 1. 自动找出段落边界，并**对齐到小节线**（文献：边界落在 downbeat 上能把
 *    F_0.5s 从 ≈54% 提到 ≈80%；小节级特征 + 16 小节核与拍级 + 66 拍核效果相当）。
 * 2. 给每段一个字母（A/B/A…），凭**音高内容**而不是音色 —— 「换了鼓但和弦一样」
 *    必须仍是同一段。
 * 3. 给每段客观量（energy 0..3 / 频段占比 / onset 密度 / 亮度 / 噪度 / 边界新奇度），
 *    外加一个**标注为推断**的 roleHint。
 *
 * ## 为什么没有相似度矩阵
 *
 * 教科书写法是先算 `B×B` 的 SSM 再拿棋盘核卷积。但高斯锥棋盘核是**可分离**的：
 *
 *   K(i,j) = sign(i)·sign(j)·g(i)·g(j) = c(i)·c(j)，  c(i) = sign(i)·g(i)
 *
 * 于是 `nov[n] = ΣΣ c(i)c(j)·(x_{n+i}·x_{n+j}) = ‖Σ c(i)·x_{n+i}‖²`。
 *
 * 结果与二维卷积**逐位等价**，代价从 `O(B²·D)` + `B²` 内存降到 `O(B·L·D)`。
 * 十分钟的曲子（300 小节）因此不需要 90k 个 float 的矩阵，也不需要为长曲设上限。
 *
 * ## 特征分工（这是自研相对现成库的唯一实质优势）
 *
 * 边界用**音色/能量**（rms / flux / centroid / flat / 五段占比 / onset 密度）；
 * 归组用**chroma**。两者混用会同时变差 —— 文献里这条结论很稳定。
 *
 * ## 确定性的来源
 *
 * 数值只从数组来，不经过 `Map`/`Set` 的迭代序；一律升序累加；聚类平局取簇号小者；
 * 百分位取 `round(p·(n-1))`。边界只取整数小节，不做亚小节精修 —— 也就不会因为
 * 浮点抖动在一个 bin 内改变段落划分。
 */

import { barDur, type BeatGrid } from '../core/time';
import { emptyFeatures } from '../algos/feature-source';
import { CHROMA_DIM } from './chroma';
import type { FeatureTrack } from './features';

export const STRUCTURE_VERSION = 1 as const;

/** 段落角色的**推断**。`'section'` = 没有更强的假设。 */
export type MusicRole = 'intro' | 'build' | 'drop' | 'breakdown' | 'outro' | 'section';

/** 音色向量的维数：rms / flux / centroid / flat / 五段占比 / onset 密度。 */
const TIMBRE_DIM = 10;
/** 多尺度 Foote 核的半宽（小节）。2 = 短 drop，8 = 整乐句。 */
const NOV_SCALES: readonly number[] = [2, 4, 8];
/**
 * 峰值判据：多尺度 z 达到这个值才算边界。
 *
 * **刻意偏召回**：0.5 而不是 1。漏掉一条边界，agent 会把两段当成一段、画面于是是
 * 平的 —— 那正是「没有耳朵」的原症状；多出一条边界，最坏是剪多一刀。实测同一条
 * 曲子上 0.5 能捞回「前奏 → 主歌」这种小变化（z≈0.54），而 1.0 会漏掉它。
 * 精度由三条兜住：必须是局部极大、与已接受边界至少隔 `minSectionBars`、
 * 段数上限 24。**每条边界的强度还会随段落一起返回**（`novelty`），
 * 所以「弱边界」在 agent 眼里仍然是弱边界，不是二值化的噪音。
 */
const NOV_Z = 0.5;
/** `novelty` 字段的满量程：z = 3 映射到 1。于是判据线画在 1/3 处。 */
const NOV_FULL_Z = 3;
/** 默认最短段落（小节）。4 小节 = 一个最短乐句。 */
export const DEFAULT_MIN_SECTION_BARS = 4;
/** 段落数上限。超限时保留 novelty 最高的那些边界。 */
const MAX_SECTIONS = 24;
/** chroma 聚类的余弦阈值（移调不变）。 */
const CLUSTER_SIM_CHROMA = 0.8;
/** 没有 chroma 时退回音色向量，阈值要更严（同曲音色本来就接近）。 */
const CLUSTER_SIM_TIMBRE = 0.9;
/**
 * 归组向量的两块权重。
 *
 * **只靠 chroma 会错**：EDM 里主歌与副歌常共用同一组和弦，差别全在配器。
 * 只靠音色也会错：副歌升 key 在中国流行里很常见，那仍是同一段。
 * 两块各占一半（0.7² + 0.7² ≈ 1），相似度的满分因此是 ≈0.98。
 */
const CHROMA_WEIGHT = 0.7;
const TIMBRE_WEIGHT = 0.7;
/** 混合归组向量的维数。 */
const MIXED_DIM = CHROMA_DIM + TIMBRE_DIM;
/** 字母数上限；超了就把最像的两簇合并。 */
const MAX_CLUSTERS = 8;
/** 每小节最多取这么多帧做 chroma 中位数 —— 中位数只需要分布，不需要全部样本。 */
const CHROMA_SAMPLES = 64;
/** 判定「静音小节」的 rms 下限（整轨峰值归一后的口径）。 */
const SILENT_RMS = 0.02;
/** onset 密度到 1.0 的参考值（每秒 8 个 = 密集）。 */
const ONSET_FULL = 8;
/** energy 的分位映射。p10/p90 而不是 min/max：一个爆音不该压扁整首曲子的动态。 */
const ENERGY_P10 = 0.1;
const ENERGY_P90 = 0.9;

/** 小节级客观量。时间一律**工程秒**。 */
export interface BarRow {
  /** 0 基，数组下标。 */
  index: number;
  /** 1 基绝对小节号，与 `core/time.ts::barBeatAt` 同一读数。 */
  bar: number;
  /** 工程秒。首小节可能被 `windowStart` 截断。 */
  start: number;
  duration: number;
  /** 0..1，整轨峰值归一（沿用 `FeatureTrack` 的口径）。 */
  rms: number;
  flux: number;
  centroid: number;
  flat: number;
  /** 每秒 onset 数。 */
  onsetDensity: number;
  /** 五段**占比**，和恒为 1（静音小节全 0，由 `silent` 标记）。 */
  band: { sub: number; bass: number; mid: number; high: number; air: number };
  /** 0..3，相对本曲（p10/p90 映射）。 */
  energy: number;
  /** 0..1，多尺度 novelty（判据线在 1/3）。 */
  novelty: number;
  /** 12 维，逐帧已归一后取中位数再归一。没有 chroma 时全 0。 */
  chroma: readonly number[];
  silent: boolean;
}

export interface MusicSection {
  index: number;
  /** 稳定 id：`auto:<assetId>:<startBar>` —— 同一音频同一网格重跑得到同一批。 */
  id: string;
  /** 'A'..'Z'。 */
  letter: string;
  /** 工程秒，`[start, end)`。 */
  start: number;
  end: number;
  /** 1 基绝对小节号。 */
  startBar: number;
  bars: number;
  /** 0..3（本段均值）。 */
  energy: number;
  /** 相对上一段的能量差（首段为 0）。 */
  dEnergy: number;
  rms: number;
  onsetDensity: number;
  band: { sub: number; bass: number; mid: number; high: number; air: number };
  /** 谱重心段均值，0..1。 */
  brightness: number;
  /** 谱平坦度段均值，0..1。越高越噪。 */
  noisiness: number;
  /** 入口小节的多尺度 novelty，0..1。 */
  novelty: number;
  /** **推断**，不是事实。 */
  roleHint: MusicRole;
  /** 0..0.9；`roleHint === 'section'` 时为 0。 */
  roleConfidence: number;
  /** 聚类簇号（决定字母与颜色）。 */
  cluster: number;
}

export interface DropRow {
  sectionIndex: number;
  letter: string;
  /** 工程秒。 */
  start: number;
  startBar: number;
  energy: number;
  /** 该段能量最高的小节号（1 基）。 */
  peakBar: number;
}

export interface MusicMap {
  version: typeof STRUCTURE_VERSION;
  /** 分析窗口（工程秒）。 */
  windowStart: number;
  windowEnd: number;
  bpm: number;
  offset: number;
  beatsPerBar: number;
  /** 一小节的秒数。 */
  barDur: number;
  bars: BarRow[];
  sections: MusicSection[];
  drops: DropRow[];
  /** 多尺度 novelty 的最大 z（调试 / 归一化依据）。 */
  noveltyPeak: number;
}

export interface StructureInput {
  features: FeatureTrack;
  /** `frames * 12`，行优先；没有就传 null。 */
  chroma: Float32Array | null;
  grid: BeatGrid;
  /** `projectT = assetT + timeOffset`，即 `clip.start - clip.srcIn`。 */
  timeOffset: number;
  /** 分析窗口（工程秒），通常是 `[clip.start, clip.end]`。 */
  windowStart: number;
  windowEnd: number;
  /** 最短段落（小节）。缺省 4。 */
  minSectionBars?: number;
  /** 段落 id 的前缀来源（素材 id）。缺省空串。 */
  assetId?: string;
}

export function buildMusicMap(input: StructureInput): MusicMap {
  const { features, chroma, grid, timeOffset, windowStart, windowEnd } = input;
  const bpb = Math.max(1, grid.beatsPerBar);
  const barSec = barDur(grid);
  const minBars = Math.max(1, Math.round(input.minSectionBars ?? DEFAULT_MIN_SECTION_BARS));
  const assetId = input.assetId ?? '';

  const empty: MusicMap = {
    version: STRUCTURE_VERSION,
    windowStart,
    windowEnd,
    bpm: grid.bpm,
    offset: grid.offset,
    beatsPerBar: bpb,
    barDur: barSec,
    bars: [],
    sections: [],
    drops: [],
    noveltyPeak: 0,
  };

  if (!Number.isFinite(barSec) || barSec <= 0) return empty;
  if (!Number.isFinite(windowStart) || !Number.isFinite(windowEnd)) return empty;
  if (windowEnd - windowStart < barSec * 0.5) return empty;
  if (features.frames === 0) return empty;

  /* ---- 1. 小节网格：从含 windowStart 的那一小节起，到 windowEnd 之前 ---- */

  const firstBar = Math.floor((windowStart - grid.offset) / barSec + 1e-9);
  // `lastBar` 是**最后一个被包含**的小节下标（它的起点 < windowEnd）。
  const lastBar = Math.floor((windowEnd - grid.offset) / barSec - 1e-9);
  const count = lastBar - firstBar + 1;
  if (count <= 0) return empty;

  /* ---- 2. 逐小节聚合 ---- */

  const fps = features.fps;
  const fMax = features.frames - 1;
  const out = emptyFeatures();
  const bars: BarRow[] = new Array(count);
  /** 10 维音色向量，稍后 z-score + L2。 */
  const vecs = new Float64Array(count * TIMBRE_DIM);

  for (let n = 0; n < count; n += 1) {
    const absBar = firstBar + n;
    const barStart = Math.max(windowStart, grid.offset + absBar * barSec);
    const barEnd = Math.min(windowEnd, grid.offset + (absBar + 1) * barSec);
    const dur = Math.max(0, barEnd - barStart);

    // 工程秒 → 素材秒。特征轨只认素材时间。
    const a0 = barStart - timeOffset;
    const a1 = barEnd - timeOffset;

    let f0 = clampInt(Math.ceil(a0 * fps - 1e-9), 0, fMax);
    let f1 = clampInt(Math.ceil(a1 * fps - 1e-9) - 1, 0, fMax);
    if (f1 < f0) f1 = f0;

    let sumRms = 0;
    let sumFlux = 0;
    let sumCentroid = 0;
    let sumFlat = 0;
    let sumSub = 0;
    let sumBass = 0;
    let sumMid = 0;
    let sumHigh = 0;
    let sumAir = 0;
    let frames = 0;
    for (let f = f0; f <= f1; f += 1) {
      features.at(f / fps, out);
      sumRms += out.rms;
      sumFlux += out.flux;
      sumCentroid += out.centroid;
      sumFlat += out.flat;
      sumSub += out.sub;
      sumBass += out.bass;
      sumMid += out.mid;
      sumHigh += out.high;
      sumAir += out.air;
      frames += 1;
    }
    const inv = frames > 0 ? 1 / frames : 0;
    const meanRms = sumRms * inv;
    const meanFlux = sumFlux * inv;
    const meanCentroid = sumCentroid * inv;
    const meanFlat = sumFlat * inv;

    // 占比而不是绝对值：音色身份要的是「低频多还是高频多」，响度已经由 rms 承担。
    const bandSum = (sumSub + sumBass + sumMid + sumHigh + sumAir) * inv;
    const ratio = bandSum > 1e-9 ? 1 / (bandSum * frames) : 0;
    const band = {
      sub: sumSub * ratio,
      bass: sumBass * ratio,
      mid: sumMid * ratio,
      high: sumHigh * ratio,
      air: sumAir * ratio,
    };

    // onset 密度：数窗口内的 onset 个数，除以真实时长。
    const onsetDensity = dur > 1e-9 ? onsetsIn(features.onsets, a0, a1) / dur : 0;

    const vecBase = n * TIMBRE_DIM;
    vecs[vecBase] = meanRms;
    vecs[vecBase + 1] = meanFlux;
    vecs[vecBase + 2] = meanCentroid;
    vecs[vecBase + 3] = meanFlat;
    vecs[vecBase + 4] = band.sub;
    vecs[vecBase + 5] = band.bass;
    vecs[vecBase + 6] = band.mid;
    vecs[vecBase + 7] = band.high;
    vecs[vecBase + 8] = band.air;
    vecs[vecBase + 9] = onsetDensity;

    bars[n] = {
      index: n,
      bar: absBar + 1,
      start: barStart,
      duration: dur,
      rms: meanRms,
      flux: meanFlux,
      centroid: meanCentroid,
      flat: meanFlat,
      onsetDensity,
      band,
      energy: 0,
      novelty: 0,
      chroma: chroma ? barChroma(chroma, f0, f1) : ZERO_CHROMA,
      silent: meanRms < SILENT_RMS,
    };
  }

  /* ---- 3. 音色向量：逐维 z-score → 整向量 L2 ---- */

  for (let d = 0; d < TIMBRE_DIM; d += 1) {
    let mean = 0;
    for (let n = 0; n < count; n += 1) mean += vecs[n * TIMBRE_DIM + d]!;
    mean /= count;
    let varSum = 0;
    for (let n = 0; n < count; n += 1) {
      const dev = vecs[n * TIMBRE_DIM + d]! - mean;
      varSum += dev * dev;
    }
    const std = Math.sqrt(varSum / count);
    if (std > 1e-9) {
      for (let n = 0; n < count; n += 1) {
        vecs[n * TIMBRE_DIM + d] = (vecs[n * TIMBRE_DIM + d]! - mean) / std;
      }
    } else {
      // 这一维在整首曲子里是常数：它对区分段落没有任何信息，置 0。
      for (let n = 0; n < count; n += 1) vecs[n * TIMBRE_DIM + d] = 0;
    }
  }
  for (let n = 0; n < count; n += 1) {
    const base = n * TIMBRE_DIM;
    let norm = 0;
    for (let d = 0; d < TIMBRE_DIM; d += 1) norm += vecs[base + d]! * vecs[base + d]!;
    norm = Math.sqrt(norm);
    if (norm > 1e-9) for (let d = 0; d < TIMBRE_DIM; d += 1) vecs[base + d] = vecs[base + d]! / norm;
  }

  /* ---- 4. 多尺度 novelty ---- */

  const z = new Float64Array(count);
  for (const half of NOV_SCALES) {
    const curve = noveltyCurve(vecs, count, TIMBRE_DIM, half);
    const zc = zNormalize(curve);
    for (let n = 0; n < count; n += 1) {
      const v = zc[n]!;
      if (v > z[n]!) z[n] = v;
    }
  }
  let peak = 0;
  for (let n = 0; n < count; n += 1) if (z[n]! > peak) peak = z[n]!;
  for (let n = 0; n < count; n += 1) {
    bars[n]!.novelty = clamp01(z[n]! / NOV_FULL_Z);
  }

  /* ---- 5. 挑边界：局部极大 + 阈值 + 贪心最小间隔 ---- */

  const candidates: number[] = [];
  for (let n = 1; n < count - 1; n += 1) {
    if (z[n]! < NOV_Z) continue;
    if (z[n]! < z[n - 1]! || z[n]! < z[n + 1]!) continue;
    // 平台只取最左的一个，避免同一个坡顶出两条边界。
    if (z[n]! === z[n - 1]!) continue;
    candidates.push(n);
  }
  // 按 novelty 降序，平局按下标升序（确定性）。
  candidates.sort((a, b) => (z[b]! - z[a]! !== 0 ? z[b]! - z[a]! : a - b));

  const accepted: number[] = [];
  for (const n of candidates) {
    if (accepted.length >= MAX_SECTIONS - 1) break;
    let ok = n >= minBars;
    if (ok) {
      for (const a of accepted) {
        if (Math.abs(a - n) < minBars) {
          ok = false;
          break;
        }
      }
    }
    if (ok) accepted.push(n);
  }
  accepted.sort((a, b) => a - b);

  const bounds = [0, ...accepted, count];

  /* ---- 6. energy 0..3（全曲 p10/p90 映射） ---- */

  const raws = new Float64Array(count);
  for (let n = 0; n < count; n += 1) {
    const b = bars[n]!;
    raws[n] =
      0.6 * b.rms + 0.25 * Math.min(1, b.onsetDensity / ONSET_FULL) + 0.15 * (b.band.high + b.band.air);
  }
  const p10 = percentile(raws, ENERGY_P10);
  const p90 = percentile(raws, ENERGY_P90);
  const span = p90 - p10;
  for (let n = 0; n < count; n += 1) {
    bars[n]!.energy = span > 1e-6 ? 3 * clamp01((raws[n]! - p10) / span) : 1.5;
  }

  /* ---- 7. 段落聚合 + 聚类 ---- */

  const seeds: SectionSeed[] = [];
  for (let i = 0; i < bounds.length - 1; i += 1) {
    seeds.push(aggregateSection(bars, bounds[i]!, bounds[i + 1]!, vecs));
  }
  const assign = clusterByContent(seeds);
  const letters = lettersFor(assign);

  const sections: MusicSection[] = seeds.map((s, i) => {
    const first = bounds[i]!;
    const last = bounds[i + 1]! - 1;
    const base: MusicSection = {
      index: i,
      id: `auto:${assetId}:${bars[first]!.bar}`,
      letter: letters[assign[i]!]!,
      start: bars[first]!.start,
      end: bars[last]!.start + bars[last]!.duration,
      startBar: bars[first]!.bar,
      bars: last - first + 1,
      energy: s.energy,
      dEnergy: 0,
      rms: s.rms,
      onsetDensity: s.onsetDensity,
      band: s.band,
      brightness: s.brightness,
      noisiness: s.noisiness,
      novelty: bars[first]!.novelty,
      roleHint: 'section',
      roleConfidence: 0,
      cluster: assign[i]!,
    };
    return base;
  });

  for (let i = 0; i < sections.length; i += 1) {
    const s = sections[i]!;
    const prev = i > 0 ? sections[i - 1]! : null;
    const next = i + 1 < sections.length ? sections[i + 1]! : null;
    s.dEnergy = prev ? s.energy - prev.energy : 0;
    const role = classifyRole(s, prev, next, i, sections.length);
    s.roleHint = role.role;
    s.roleConfidence = role.confidence;
  }

  /* ---- 8. drop 时刻表 ---- */

  const drops: DropRow[] = [];
  for (const s of sections) {
    if (s.roleHint !== 'drop') continue;
    let peakBar = s.startBar;
    let peak = -1;
    for (let n = 0; n < count; n += 1) {
      const b = bars[n]!;
      if (b.bar < s.startBar || b.bar >= s.startBar + s.bars) continue;
      if (b.energy > peak) {
        peak = b.energy;
        peakBar = b.bar;
      }
    }
    drops.push({
      sectionIndex: s.index,
      letter: s.letter,
      start: s.start,
      startBar: s.startBar,
      energy: s.energy,
      peakBar,
    });
  }

  return {
    version: STRUCTURE_VERSION,
    windowStart,
    windowEnd,
    bpm: grid.bpm,
    offset: grid.offset,
    beatsPerBar: bpb,
    barDur: barSec,
    bars,
    sections,
    drops,
    noveltyPeak: peak,
  };
}

/* ------------------------------------------------------------ 段落中间态 */

interface SectionSeed {
  energy: number;
  rms: number;
  onsetDensity: number;
  band: { sub: number; bass: number; mid: number; high: number; air: number };
  brightness: number;
  noisiness: number;
  /** 归组用的向量：有 chroma 就是 12 维音高，否则 10 维音色。 */
  clusterVec: Float64Array;
  /** 该向量是否来自 chroma（决定用哪种相似度）。 */
  fromChroma: boolean;
}

const ZERO_CHROMA: readonly number[] = Object.freeze(new Array<number>(CHROMA_DIM).fill(0));

function aggregateSection(
  bars: readonly BarRow[],
  lo: number,
  hi: number,
  vecs: Float64Array,
): SectionSeed {
  let wSum = 0;
  let energy = 0;
  let rms = 0;
  let onsets = 0;
  let brightness = 0;
  let noisiness = 0;
  const band = { sub: 0, bass: 0, mid: 0, high: 0, air: 0 };
  for (let n = lo; n < hi; n += 1) {
    const b = bars[n]!;
    const w = Math.max(1e-6, b.duration);
    wSum += w;
    energy += b.energy * w;
    rms += b.rms * w;
    onsets += b.onsetDensity * w;
    brightness += b.centroid * w;
    noisiness += b.flat * w;
    band.sub += b.band.sub * w;
    band.bass += b.band.bass * w;
    band.mid += b.band.mid * w;
    band.high += b.band.high * w;
    band.air += b.band.air * w;
  }
  const k = wSum > 1e-9 ? 1 / wSum : 0;

  // 归组向量：chroma 块 + 音色块。没有 chroma 时只剩音色。
  const fromChroma = bars[lo]!.chroma.some((v) => v > 0);
  const timbre = new Float64Array(TIMBRE_DIM);
  for (let n = lo; n < hi; n += 1) {
    const base = n * TIMBRE_DIM;
    for (let d = 0; d < TIMBRE_DIM; d += 1) timbre[d] += vecs[base + d]!;
  }
  l2Normalize(timbre);

  let clusterVec: Float64Array;
  if (fromChroma) {
    const pitch = new Float64Array(CHROMA_DIM);
    let used = 0;
    for (let n = lo; n < hi; n += 1) {
      const c = bars[n]!.chroma;
      if (!c.some((v) => v > 0)) continue;
      for (let p = 0; p < CHROMA_DIM; p += 1) pitch[p] += c[p]!;
      used += 1;
    }
    if (used > 0) for (let p = 0; p < CHROMA_DIM; p += 1) pitch[p] = pitch[p]! / used;
    l2Normalize(pitch);
    clusterVec = new Float64Array(MIXED_DIM);
    for (let p = 0; p < CHROMA_DIM; p += 1) clusterVec[p] = pitch[p]! * CHROMA_WEIGHT;
    for (let d = 0; d < TIMBRE_DIM; d += 1) {
      clusterVec[CHROMA_DIM + d] = timbre[d]! * TIMBRE_WEIGHT;
    }
  } else {
    // 整段静音时 timbre 是零向量，自成一簇 —— 这是对的。
    clusterVec = timbre;
  }

  return {
    energy: energy * k,
    rms: rms * k,
    onsetDensity: onsets * k,
    band: {
      sub: band.sub * k,
      bass: band.bass * k,
      mid: band.mid * k,
      high: band.high * k,
      air: band.air * k,
    },
    brightness: brightness * k,
    noisiness: noisiness * k,
    clusterVec,
    fromChroma,
  };
}

/**
 * 按时间顺序贪心聚类：与现有簇最像就并入，否则开新簇。
 *
 * 有 chroma 时用**移调不变**相似度（12 个循环移位取最大）—— 副歌升一个全音
 * 仍是同一段，这是功能性段落的常见写法。超 `MAX_CLUSTERS` 就把最像的两簇合并。
 */
function clusterByContent(seeds: SectionSeed[]): number[] {
  const clusters: { members: number[]; centroid: Float64Array }[] = [];

  for (let i = 0; i < seeds.length; i += 1) {
    const seed = seeds[i]!;
    const sim = seed.fromChroma ? CLUSTER_SIM_CHROMA : CLUSTER_SIM_TIMBRE;
    let best = -Infinity;
    let bestC = -1;
    for (let c = 0; c < clusters.length; c += 1) {
      const cl = clusters[c]!;
      const v = similarity(seed.clusterVec, cl.centroid);
      // 严格大于：平局取簇号小者。
      if (v > best + 1e-9) {
        best = v;
        bestC = c;
      }
    }
    if (bestC >= 0 && best >= sim) {
      clusters[bestC]!.members.push(i);
      recomputeCentroid(clusters[bestC]!, seeds);
    } else {
      clusters.push({ members: [i], centroid: seed.clusterVec.slice() });
    }
  }

  // 簇太多就并到 MAX_CLUSTERS：每次并最像的一对。合并会改变下标，
  // 所以 assign 在合并**之后**从 members 重建，而不是在此之前记死。
  while (clusters.length > MAX_CLUSTERS) {
    let bestA = 0;
    let bestB = 1;
    let best = -Infinity;
    for (let a = 0; a < clusters.length; a += 1) {
      for (let b = a + 1; b < clusters.length; b += 1) {
        const v = similarity(clusters[a]!.centroid, clusters[b]!.centroid);
        if (v > best + 1e-9) {
          best = v;
          bestA = a;
          bestB = b;
        }
      }
    }
    const merged = clusters[bestA]!;
    merged.members.push(...clusters[bestB]!.members);
    merged.members.sort((x, y) => x - y);
    recomputeCentroid(merged, seeds);
    clusters.splice(bestB, 1);
  }

  const rebuilt = new Array<number>(seeds.length).fill(0);
  for (let c = 0; c < clusters.length; c += 1) {
    for (const m of clusters[c]!.members) rebuilt[m] = c;
  }
  // 簇号按首次出现重排，字母才是「时间顺序」。合并不改变首次出现的相对次序。
  const order: number[] = [];
  const out: number[] = [];
  for (let i = 0; i < rebuilt.length; i += 1) {
    const c = rebuilt[i]!;
    let slot = order.indexOf(c);
    if (slot < 0) {
      slot = order.length;
      order.push(c);
    }
    out.push(slot);
  }
  return out;
}

function recomputeCentroid(target: { members: number[]; centroid: Float64Array }, seeds: SectionSeed[]): void {
  const dim = target.centroid.length;
  const next = new Float64Array(dim);
  for (const m of target.members) {
    const v = seeds[m]!.clusterVec;
    for (let d = 0; d < dim; d += 1) next[d] += v[d]!;
  }
  l2Normalize(next);
  target.centroid = next;
}

/**
 * 归组相似度。混合向量时**只旋转 chroma 块**（移调不变），音色块逐维点乘；
 * 纯音色向量没有移调语义，直接点乘。
 *
 * 输入都已 L2 归一，输出 ∈ [-1, 1]（混合向量的满分 ≈ 0.98，见两个权重常量）。
 */
function similarity(a: Float64Array, b: Float64Array): number {
  const n = Math.min(a.length, b.length);
  if (n === 0) return -Infinity;
  const hasPitch = n === MIXED_DIM || n === CHROMA_DIM;
  if (!hasPitch) return dot(a, b);
  let best = -Infinity;
  for (let s = 0; s < CHROMA_DIM; s += 1) {
    let acc = 0;
    for (let p = 0; p < CHROMA_DIM; p += 1) acc += a[p]! * b[(p + s) % CHROMA_DIM]!;
    for (let d = CHROMA_DIM; d < n; d += 1) acc += a[d]! * b[d]!;
    if (acc > best) best = acc;
  }
  return best;
}

function lettersFor(assign: readonly number[]): string[] {
  let max = 0;
  for (const c of assign) if (c > max) max = c;
  const out: string[] = [];
  for (let i = 0; i <= max; i += 1) out.push(String.fromCharCode(65 + Math.min(25, i)));
  return out;
}

/* ------------------------------------------------------------ 角色推断 */

function classifyRole(
  s: MusicSection,
  prev: MusicSection | null,
  next: MusicSection | null,
  index: number,
  total: number,
): { role: MusicRole; confidence: number } {
  const e = s.energy;
  const ePrev = prev ? prev.energy : e;
  const strongEntry = s.novelty >= 0.25; // ≈ z >= 0.75
  const bump = (base: number): number => Math.min(0.9, strongEntry ? base + 0.15 : base);

  if (e >= 2.4 && e - ePrev >= 0.8) return { role: 'drop', confidence: bump(0.75) };
  /*
   * 首段与末段先按**位置**认：它们更可能是「intro 之后接 build」「outro 之前先掉一次」，
   * 而不是整段都叫 build / breakdown。位置是这里最强的一个先验。
   */
  if (index === 0 && e <= 1.5) return { role: 'intro', confidence: bump(0.6) };
  if (index === total - 1 && e <= 1.5 && ePrev - e >= 0.3) {
    return { role: 'outro', confidence: bump(0.65) };
  }
  /*
   * **breakdown 必须先于 build 判**：一段从 2.9 掉到 0.2 的段落，它的「下一段更响」
   * 也成立 —— 先判 build 会把整段 breakdown 叫成 build，语义正好反了。
   */
  if (e <= 1.2 && ePrev >= 2 && s.bars <= 32) return { role: 'breakdown', confidence: bump(0.6) };
  // build 要求「自己没有刚掉下来」，否则回升段（breakdown 的后一段）也会中招。
  if (next && next.energy - e >= 0.7 && s.bars <= 16 && e >= ePrev - 0.4) {
    return { role: 'build', confidence: bump(0.6) };
  }
  return { role: 'section', confidence: 0 };
}

/* ------------------------------------------------------------ 数学小工具 */

/**
 * 可分离 Foote 核的 novelty。返回未归一化的值，长度 = 小节数。
 *
 * 核取 **2L 项**（不是 2L+1）：象限在 `i = -1` 与 `i = 0` 之间切开，于是
 * `nov[n]` 比较的是 `[n-L, n-1]` 与 `[n, n+L-1]` —— **边界正好落在第 n 小节
 * 之前**。写成 2L+1 项（`i=0` 处为零）会让中心小节被两边都跳过，峰值于是落在
 * 边界两侧各半小节处的巧合点上，症状是「段落边界比耳朵听到的早一小节」。
 *
 * `Σ|c|` 归一化让不同尺度的幅度可比。
 */
function noveltyCurve(
  vecs: Float64Array,
  count: number,
  dim: number,
  half: number,
): Float64Array {
  const sigma = Math.max(0.5, half / 2);
  const c = new Float64Array(2 * half);
  let absSum = 0;
  for (let i = -half; i < half; i += 1) {
    // 高斯中心在 -0.5（象限缝里），所以窗函数按 i+0.5 取。
    const g = Math.exp(-((i + 0.5) * (i + 0.5)) / (2 * sigma * sigma));
    const v = (i < 0 ? 1 : -1) * g;
    c[i + half] = v;
    absSum += Math.abs(v);
  }
  const denom = absSum > 1e-12 ? absSum * absSum : 1;

  const out = new Float64Array(count);
  const acc = new Float64Array(dim);
  for (let n = 0; n < count; n += 1) {
    acc.fill(0);
    for (let i = -half; i < half; i += 1) {
      const w = c[i + half]!;
      if (w === 0) continue;
      const base = reflect(n + i, count) * dim;
      for (let d = 0; d < dim; d += 1) acc[d] += w * vecs[base + d]!;
    }
    let sum = 0;
    for (let d = 0; d < dim; d += 1) sum += acc[d]! * acc[d]!;
    out[n] = sum / denom;
  }
  return out;
}

/** 反射钳位。核比整段还宽时也不会越界，且不会在两端造假边界。 */
function reflect(i: number, n: number): number {
  if (n <= 1) return 0;
  const period = 2 * (n - 1);
  let x = ((i % period) + period) % period;
  if (x >= n) x = period - x;
  return x;
}

/** 逐值 z-score，并把负值压到 0 —— 只有「变化」才算 novelty。 */
function zNormalize(a: Float64Array): Float64Array {
  const n = a.length;
  const out = new Float64Array(n);
  if (n === 0) return out;
  let mean = 0;
  for (let i = 0; i < n; i += 1) mean += a[i]!;
  mean /= n;
  let varSum = 0;
  for (let i = 0; i < n; i += 1) {
    const d = a[i]! - mean;
    varSum += d * d;
  }
  const std = Math.sqrt(varSum / n);
  if (std <= 1e-9) return out;
  for (let i = 0; i < n; i += 1) out[i] = Math.max(0, (a[i]! - mean) / std);
  return out;
}

/** 逐维点乘。输入已 L2 归一，输出 ∈ [-1, 1]。 */
function dot(a: Float64Array, b: Float64Array): number {
  let s = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i += 1) s += a[i]! * b[i]!;
  return s;
}

function l2Normalize(v: Float64Array): void {
  let s = 0;
  for (let i = 0; i < v.length; i += 1) s += v[i]! * v[i]!;
  s = Math.sqrt(s);
  if (s <= 1e-12) return;
  for (let i = 0; i < v.length; i += 1) v[i] = v[i]! / s;
}

/**
 * 逐音级取**中位数**而不是均值：打击乐是宽带，它在 12 个音级上加的是常数地板，
 * 而持续的和声在时间上是稳定的 —— 中位数把前者滤掉、留下后者。这就是不做 HPSS
 * 的全部理由，代价是两个数量级的计算量。
 */
function barChroma(chroma: Float32Array, f0: number, f1: number): readonly number[] {
  const span = f1 - f0 + 1;
  if (span <= 0) return ZERO_CHROMA;
  const stride = Math.max(1, Math.ceil(span / CHROMA_SAMPLES));
  const picked: number[] = [];
  for (let f = f0; f <= f1; f += stride) picked.push(f);
  if (picked.length === 0) return ZERO_CHROMA;

  const out = new Array<number>(CHROMA_DIM);
  const buf = new Float64Array(picked.length);
  for (let p = 0; p < CHROMA_DIM; p += 1) {
    for (let k = 0; k < picked.length; k += 1) buf[k] = chroma[picked[k]! * CHROMA_DIM + p]!;
    buf.sort();
    out[p] = buf[buf.length >> 1]!;
  }
  let norm = 0;
  for (let p = 0; p < CHROMA_DIM; p += 1) norm += out[p]! * out[p]!;
  norm = Math.sqrt(norm);
  if (norm <= 1e-9) return ZERO_CHROMA;
  for (let p = 0; p < CHROMA_DIM; p += 1) out[p] = out[p]! / norm;
  return Object.freeze(out);
}

/** `[a0, a1)` 内的 onset 个数。`onsets` 升序。 */
function onsetsIn(onsets: Float32Array, a0: number, a1: number): number {
  if (a1 <= a0) return 0;
  return lowerBound(onsets, a1) - lowerBound(onsets, a0);
}

/** 第一个 `>= t` 的下标。 */
function lowerBound(sorted: Float32Array, t: number): number {
  let lo = 0;
  let hi = sorted.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (sorted[mid]! < t) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/** 分位数，`p ∈ [0,1]`，取 `round(p·(n-1))` 处的值（不改动入参）。 */
function percentile(a: Float64Array, p: number): number {
  const n = a.length;
  if (n === 0) return 0;
  const copy = Float64Array.from(a);
  copy.sort();
  return copy[Math.min(n - 1, Math.max(0, Math.round(p * (n - 1))))]!;
}

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

function clampInt(v: number, lo: number, hi: number): number {
  if (!Number.isFinite(v)) return lo;
  return v < lo ? lo : v > hi ? hi : v;
}
