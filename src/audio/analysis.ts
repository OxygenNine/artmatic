/**
 * analysis.ts — 单个素材的离线分析结果（频谱 + 特征 + chroma），**进程级共享**。
 *
 * 为什么必须共享：渲染路径（`SpectrumSource` / `AudioFeatureSource`）和 agent 的
 * `analyze_music` 要的是同一份东西。各建一个 `ProjectAudio` 各算一遍的代价不是
 * 「多花点 CPU」—— 一首 5 分钟的歌是一趟 1.5 万帧的 STFT，两遍就是两倍等待，
 * 而且两份结果一旦因为解码时机不同而略有差异，画面与 agent 的判断就会对不上。
 *
 * ## 单飞与去重
 *
 * - 同一个 `(assetId, buffer)` 并发调用 → 同一个 Promise。
 * - 换了 `buffer` 对象（重新导入同名素材）→ 重算。
 * - 失败**不缓存**：解码与素材就绪是异步的，早先的失败不代表之后还会失败。
 * - `forget` 之后在途的那次结果**不再写回缓存**（用 token 比对），否则删掉的
 *   素材会在几百毫秒后悄悄复活。
 */

import { computeSpectrum, planSpectrum, type SpectrumTrack } from './spectrum';
import { createFeatureAccumulator, type FeatureTrack } from './features';

export interface AssetAnalysis {
  spectrum: SpectrumTrack;
  features: FeatureTrack;
}

/** `computeSpectrum` 吃的最小形状。`AudioBuffer` 天然满足；单测可以喂假对象。 */
export interface AnalysisBuffer {
  length: number;
  numberOfChannels: number;
  sampleRate: number;
  getChannelData(channel: number): Float32Array;
}

interface Entry {
  buffer: object;
  analysis: AssetAnalysis;
}

interface Run {
  buffer: object;
  promise: Promise<AssetAnalysis>;
  token: object;
}

const cache = new Map<string, Entry>();
const inflight = new Map<string, Run>();

/**
 * 取（必要时算）某个素材的分析结果。
 *
 * `buffer` 只用来判断「是不是同一份素材」——换了对象就重算，因为采样率或长度
 * 可能已经变了，旧的帧数索引会整体错位。
 */
export function analyzeAsset(assetId: string, buffer: AnalysisBuffer): Promise<AssetAnalysis> {
  const hit = cache.get(assetId);
  if (hit && hit.buffer === buffer) return Promise.resolve(hit.analysis);

  const run = inflight.get(assetId);
  if (run && run.buffer === buffer) return run.promise;

  const token = {};
  const promise = runAnalysis(buffer).then(
    (analysis) => {
      // 只有这次请求仍然是最新的那一次才写缓存。`forget` 之后 token 已被换掉，
      // 在途结果丢弃 —— 否则删掉的素材会复活。
      if (inflight.get(assetId)?.token === token) {
        inflight.delete(assetId);
        cache.set(assetId, { buffer, analysis });
      }
      return analysis;
    },
    (err: unknown) => {
      if (inflight.get(assetId)?.token === token) inflight.delete(assetId);
      throw err;
    },
  );

  inflight.set(assetId, { buffer, promise, token });
  return promise;
}

/** 只看缓存，不触发计算。渲染路径用它：算没算好是它自己的事。 */
export function peekAnalysis(assetId: string, buffer: AnalysisBuffer): AssetAnalysis | null {
  const hit = cache.get(assetId);
  return hit && hit.buffer === buffer ? hit.analysis : null;
}

/** 素材消失时丢掉它的分析结果。在途的那次也不会再写回。 */
export function forgetAnalysis(assetId: string): void {
  cache.delete(assetId);
  inflight.delete(assetId);
}

/** 全部清空（换工程 / E2E 重置）。 */
export function clearAnalyses(): void {
  cache.clear();
  inflight.clear();
}

/** 已在缓存里的素材数量（调试与内存观察用）。 */
export function analysisCount(): number {
  return cache.size;
}

async function runAnalysis(buffer: AnalysisBuffer): Promise<AssetAnalysis> {
  // 帧数 / hop 只有 `planSpectrum` 一个真源 —— 抄一套算术迟早会漂，
  // 而漂的表现是「特征曲线尾部静默变成 0」。
  const plan = planSpectrum(buffer.sampleRate, buffer.length);
  const acc = createFeatureAccumulator({
    bins: plan.bins,
    hopSec: plan.hopSec,
    sampleRate: plan.sampleRate,
    frames: plan.frames,
    // 段落聚类要用 chroma；比特征本身多 ≈ 帧数 × 48 字节（5 分钟 ≈ 0.7 MB）。
    chroma: true,
  });
  const spectrum = await computeSpectrum(buffer, undefined, (mag, rms) => acc.push(mag, rms));
  return { spectrum, features: acc.finish() };
}
