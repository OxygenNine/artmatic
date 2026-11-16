import { describe, expect, it } from 'vitest';
import { buildChromaFilterbank, CHROMA_DIM, createChromaAccumulator } from '../../src/audio/chroma';

/**
 * chroma 层。判据只有三条，但每条都关系到「段落字母对不对」：
 *
 * 1. **音级映射正确** —— 440 Hz 必须落在 A（下标 9）。映射错了，所有段落都会
 *    被正确但无意义地分组，而且完全看不出来。
 * 2. **逐帧 L2 归一** —— 归一化掉的是响度。不归一的话，副歌比主歌响，聚类会
 *    按响度分而不是按和声分。
 * 3. **帧数严格等于预算** —— 少一帧，后面按 `f * 12` 取值就整体错位，
 *    症状是「边界正常但字母乱跳」。
 */

const SR = 44100;
const BINS = 1025;
/** bin 宽 ≈ 21.53 Hz。440 Hz ≈ bin 20.43。 */
const BIN_HZ = SR / 2 / (BINS - 1);

function magWith(energies: Record<number, number>): Float32Array {
  const m = new Float32Array(BINS);
  for (const [k, v] of Object.entries(energies)) m[Number(k)] = v;
  return m;
}

function chromaOf(mag: Float32Array): number[] {
  const acc = createChromaAccumulator({ bins: BINS, sampleRate: SR, frames: 1 });
  acc.push(mag);
  const data = acc.finish();
  return Array.from(data.subarray(0, CHROMA_DIM));
}

describe('chroma：音级映射', () => {
  it('440 Hz 落在 A（下标 9）', () => {
    const c = chromaOf(magWith({ [Math.round(440 / BIN_HZ)]: 1 }));
    expect(c.indexOf(Math.max(...c))).toBe(9);
  });

  it('261.63 Hz（C4）落在 C（下标 0）', () => {
    const c = chromaOf(magWith({ [Math.round(261.63 / BIN_HZ)]: 1 }));
    expect(c.indexOf(Math.max(...c))).toBe(0);
  });

  it('宽带能量让 12 个音级都非零', () => {
    const m = new Float32Array(BINS).fill(0.2);
    const c = chromaOf(m);
    expect(c.every((v) => v > 0)).toBe(true);
  });
});

describe('chroma：归一化与静音', () => {
  it('逐帧 L2 归一（平方和 = 1）', () => {
    const c = chromaOf(magWith({ 3: 0.9, 40: 0.4, 120: 0.1 }));
    const sum = c.reduce((s, v) => s + v * v, 0);
    expect(sum).toBeCloseTo(1, 5);
  });

  it('同样的和声、不同的响度 → 同一个 chroma', () => {
    const a = chromaOf(magWith({ 3: 0.9, 40: 0.4 }));
    const b = chromaOf(magWith({ 3: 0.09, 40: 0.04 }));
    for (let p = 0; p < CHROMA_DIM; p += 1) expect(b[p]).toBeCloseTo(a[p]!, 5);
  });

  it('全零输入 → 全零 chroma（不是 NaN）', () => {
    const c = chromaOf(new Float32Array(BINS));
    expect(c.every((v) => v === 0)).toBe(true);
  });
});

describe('chroma：累加器边界', () => {
  it('帧数严格等于预算，多推的帧被忽略', () => {
    const acc = createChromaAccumulator({ bins: BINS, sampleRate: SR, frames: 4 });
    const m = magWith({ 10: 1 });
    for (let i = 0; i < 10; i += 1) acc.push(m);
    expect(acc.finish().length).toBe(4 * CHROMA_DIM);
  });

  it('采样率低到最高音低于 C3 时滤波器组为空，且不炸', () => {
    // nyquist 200 Hz，0.45 × nyquist = 90 Hz < C3，一个半音都放不下。
    const bank = buildChromaFilterbank(2, 400);
    expect(bank.count).toBe(0);
    const acc = createChromaAccumulator({ bins: 2, sampleRate: 400, frames: 2 });
    acc.push(new Float32Array(2).fill(1));
    expect(acc.finish().every((v) => v === 0)).toBe(true);
  });

  it('确定性：同一份输入两次结果逐位相同', () => {
    const m = magWith({ 7: 0.5, 33: 0.8, 210: 0.3 });
    expect(chromaOf(m)).toEqual(chromaOf(m));
  });
});
