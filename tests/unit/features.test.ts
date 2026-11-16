import { describe, expect, it } from 'vitest';
import { createFeatureAccumulator, frameRms } from '../../src/audio/features';
import { emptyFeatures } from '../../src/algos/feature-source';
import { planSpectrum } from '../../src/audio/spectrum';

/**
 * 音频特征层。判据集中在三件**架构上必须成立**的事：
 *
 * 1. `at(t)` 是 **t 的纯函数** —— 硬约束 1.1。逐帧累加器（上游的
 *    `Impulse.step(dt)`）做不到这一点，而整个「场景 = 生成器」的模型
 *    建立在它之上（曲线求值、seek、导出必须走同一条路径）。
 * 2. **频段真的分开** —— 否则场景里的 `u_sub` / `u_high` 只是同一个数的两份拷贝，
 *    画面看着有反应但反应是错的。
 * 3. onset 检测找得到鼓点 —— 它驱动 `u_ages` → `u_hit`，是「按音符脉动」的全部来源。
 */

const SAMPLE_RATE = 44100;
const BINS = 1025;
const HOP_SEC = 0.02; // 50 fps，与 SPECTRUM_FPS 一致
const FRAMES = 200; // 4 秒

/** 造一帧幅度谱：只有指定 bin 有能量。 */
function magWith(energies: Record<number, number>): Float32Array {
  const m = new Float32Array(BINS);
  for (const [k, v] of Object.entries(energies)) m[Number(k)] = v;
  return m;
}

function build(
  frames: (i: number) => { mag: Float32Array; rms: number },
): ReturnType<typeof createFeatureAccumulator> {
  const acc = createFeatureAccumulator({
    bins: BINS,
    hopSec: HOP_SEC,
    sampleRate: SAMPLE_RATE,
    frames: FRAMES,
  });
  for (let i = 0; i < FRAMES; i += 1) {
    const f = frames(i);
    acc.push(f.mag, f.rms);
  }
  return acc;
}

describe('音频特征：at(t) 是 t 的纯函数（硬约束 1.1）', () => {
  const acc = build((i) => ({ mag: magWith({ 4: i > 100 ? 1 : 0.2 }), rms: i > 100 ? 0.8 : 0.2 }));
  const track = acc.finish();

  it('乱序取值的顺序不影响结果（没有隐藏游标）', () => {
    const out = emptyFeatures();
    track.at(0.5, out);
    const a = { rms: out.rms, sub: out.sub, travel: out.travel, age: out.ages[0] };
    track.at(3.9, out);
    track.at(1.2, out);
    track.at(0.5, out);
    expect({ rms: out.rms, sub: out.sub, travel: out.travel, age: out.ages[0] }).toEqual(a);
  });


  it('超出范围给静音（曲线归零、年龄给哨兵）', () => {
    const out = emptyFeatures();
    track.at(-1, out);
    expect(out.rms).toBe(0);
    expect(out.ages[0]).toBeGreaterThan(1);
    track.at(999, out);
    expect(out.rms).toBe(0);
  });

  it('确定性：同一份输入两次累加得到同一条轨', () => {
    const mk = (): number[] => {
      const a = build((i) => ({ mag: magWith({ 7: Math.sin(i) * 0.5 + 0.5 }), rms: 0.5 }));
      const t = a.finish();
      const out = emptyFeatures();
      const acc2: number[] = [];
      for (let k = 0; k < 20; k += 1) {
        t.at(k * 0.1, out);
        acc2.push(out.rms, out.travel, out.ages[0]!);
      }
      return acc2;
    };
    expect(mk()).toEqual(mk());
  });
});

describe('音频特征：频段真的分开', () => {
  it('低频段的能量不会被算进高频段（反之亦然）', () => {
    // binHz = 22050 / 1024 ≈ 21.5 → bin 2 ≈ 43 Hz（sub），bin 200 ≈ 4.3 kHz（high）
    const low = build(() => ({ mag: magWith({ 2: 1 }), rms: 0.5 })).finish();
    const high = build(() => ({ mag: magWith({ 200: 1 }), rms: 0.5 })).finish();
    const out = emptyFeatures();

    low.at(1, out);
    expect(out.sub).toBeGreaterThan(0);
    expect(out.high).toBe(0);

    high.at(1, out);
    expect(out.high).toBeGreaterThan(0);
    expect(out.sub).toBe(0);
  });

  it('rms 按整轨峰值归一到 0..1', () => {
    const track = build((i) => ({ mag: magWith({ 5: 0.5 }), rms: i === 50 ? 0.9 : 0.1 })).finish();
    const out = emptyFeatures();
    track.at(1, out); // 第 50 帧 = 1.0 s
    expect(out.rms).toBeCloseTo(1, 5);
    track.at(0.2, out);
    expect(out.rms).toBeCloseTo(0.1 / 0.9, 4);
  });

  it('谱重心随能量向高频迁移而升高', () => {
    const low = build(() => ({ mag: magWith({ 10: 1 }), rms: 0.5 })).finish();
    const high = build(() => ({ mag: magWith({ 400: 1 }), rms: 0.5 })).finish();
    const out = emptyFeatures();
    low.at(1, out);
    const a = out.centroid;
    high.at(1, out);
    expect(out.centroid).toBeGreaterThan(a);
  });
});

describe('音频特征：onset 检测与年龄', () => {
  // 第 50 帧（1.0 s）与第 150 帧（3.0 s）各来一记「鼓」：幅度谱从零跳起来
  const track = build((i) => ({
    mag: magWith({ 1: i === 50 || i === 150 ? 1 : 0, 300: i === 50 || i === 150 ? 1 : 0 }),
    rms: i === 50 || i === 150 ? 0.9 : 0.05,
  })).finish();

  it('找得到两记 onset 的时刻', () => {
    expect(track.onsets.length).toBe(2);
    expect(track.onsets[0]).toBeCloseTo(1.0, 6);
    expect(track.onsets[1]).toBeCloseTo(3.0, 6);
  });

  it('ages[0] 是「距最近一记 onset 过了多久」，且按新旧排序', () => {
    const out = emptyFeatures();
    track.at(1.1, out);
    expect(out.ages[0]).toBeCloseTo(0.1, 5);
    expect(out.ages[1]).toBeCloseTo(9, 5); // 1.0 之前没有 onset → 哨兵

    track.at(3.2, out);
    expect(out.ages[0]).toBeCloseTo(0.2, 5);
    expect(out.ages[1]).toBeCloseTo(2.2, 5); // 3.0 往回数：1.0
  });

  it('很久没有 onset 时年龄给哨兵（于是 exp(-age/decay) 自然归零）', () => {
    const out = emptyFeatures();
    track.at(3.99, out);
    expect(out.ages[0]).toBeCloseTo(0.99, 5);
    // 哨兵值必须大到让冲量归零
    expect(Math.exp(-out.ages[1]! / 0.075)).toBeLessThan(1e-6);
  });

  /**
   * 绝对下限那条判据。Hann 窗每跳 882 个样本（不是周期的整数倍），一个稳态音的
   * 泄漏谱每帧都在轻微变化，通量于是有周期性小峰 —— 只靠「超过局部均值 1.55 倍」
   * 会把这些小峰全放行，实测一个 110 Hz 长音被判出每秒 10 个 onset。
   */
  it('稳态音的泄漏抖动不算 onset（要被全曲峰值的绝对下限挡住）', () => {
    const track2 = build((i) => {
      const steady = 0.2 + 0.001 * Math.sin(i * 7);
      return { mag: magWith({ 4: i === 100 ? 1 : steady }), rms: i === 100 ? 0.9 : 0.5 };
    }).finish();
    expect(track2.onsets.length).toBe(1);
    expect(track2.onsets[0]).toBeCloseTo(2.0, 6);
  });
});

describe('音频特征：累积行程', () => {
  // 前 2 秒静音、之后有声 —— 只有当 rms 真的积进去，行程才会在这条界线上开动
  const track = build((i) => ({ mag: magWith({ 5: 0.3 }), rms: i < 100 ? 0 : 0.7 })).finish();

  it('单调不减', () => {
    const out = emptyFeatures();
    let prev = -1;
    for (let k = 0; k < 20; k += 1) {
      track.at(k * 0.2, out);
      expect(out.travel).toBeGreaterThanOrEqual(prev);
      prev = out.travel;
    }
  });

  it('静音段不走、有声之后才累积', () => {
    const out = emptyFeatures();
    track.at(0.1, out);
    expect(out.travel).toBe(0);
    track.at(1.9, out);
    expect(out.travel).toBe(0);
    track.at(3.5, out);
    expect(out.travel).toBeGreaterThan(0);
  });
});

describe('planSpectrum 与累加器的帧数一致', () => {
  it('计划的 bins / hop 与 spectrum.ts 的口径一致', () => {
    const plan = planSpectrum(SAMPLE_RATE, SAMPLE_RATE * 4);
    expect(plan.bins).toBe(BINS);
    expect(plan.hopSec).toBeCloseTo(HOP_SEC, 9);
    // 帧数就是 1 + floor((len - N_FFT) / hop)，由 planSpectrum 唯一定义
    expect(plan.frames).toBeGreaterThan(0);
    expect(plan.frames).toBeLessThan(SAMPLE_RATE * 4 * 50);
  });

  it('按 planSpectrum 开出来的累加器正好吃下 plan.frames 帧', () => {
    const plan = planSpectrum(SAMPLE_RATE, SAMPLE_RATE * 4);
    const acc = createFeatureAccumulator({
      bins: plan.bins,
      hopSec: plan.hopSec,
      sampleRate: plan.sampleRate,
      frames: plan.frames,
    });
    for (let i = 0; i < plan.frames; i += 1) acc.push(magWith({ 3: 1 }), 0.5);
    expect(acc.finish().frames).toBe(plan.frames);
  });

  it('多 push 的帧不会越界（累加器自己截断）', () => {
    const acc = createFeatureAccumulator({ bins: BINS, hopSec: HOP_SEC, sampleRate: SAMPLE_RATE, frames: 4 });
    for (let i = 0; i < 10; i += 1) acc.push(magWith({ 3: 1 }), 0.5);
    expect(acc.finish().frames).toBe(4);
  });
});

describe('frameRms', () => {
  it('满量程方波 ≈ 1，静音 = 0，且只看给的那一段', () => {
    const s = new Float32Array(8);
    expect(frameRms(s, 0, 8)).toBe(0);
    for (let i = 0; i < 8; i += 1) s[i] = i < 4 ? 1 : -1;
    expect(frameRms(s, 0, 4)).toBeCloseTo(1, 6);
    expect(frameRms(s, 4, 4)).toBeCloseTo(1, 6);
  });
});
