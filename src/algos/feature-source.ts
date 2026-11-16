/**
 * feature-source.ts — 音频特征来源的**接口**（`SpectrumSource` 的姊妹）。
 *
 * 为什么接口在这里而不在 `audio/`：`render-core` 刻意不 import `audio/`
 * （否则整棵音频子树会被拖进 lab 的 bundle 图）。数据以接口注入，
 * **GL 侧与渲染期只认这个形状**，「谁供数」是宿主的事：
 * 主应用给工程音频离线算出来的特征轨，lab 给合成特征。
 *
 * ## 为什么必须是**离线预计算**的
 *
 * angel-echo 的包络（`Impulse.step(dt)`、`approach`）是逐帧按 `dt` 推进的
 * 有状态量。artmatic 的硬约束 1.1 是「唯一时钟是 `t`」——那种写法 seek 不可
 * 复现（同一 t 两次渲染得到不同的包络值）。所以这里给的是**曲线的查表**：
 * `at(t)` 是 t 的纯函数，帧间插值，没有历史。
 *
 * 冲量（kick / hit / bar）因此不能作为累积状态存在：它们是**闭式**的 ——
 * 由「距上一次触发过了多久」算 `exp(-age/decay)`。见 `shader-lib.ts` 的
 * `sceneUniforms()`。所以这张表里没有 kick/hit/bar 字段，只有:
 * - 连续的频谱特征（rms / 分频 / 谱重心 / 谱平坦度 / 累积行程）
 * - 离散事件的**时刻**（onset 年龄），由消费方换算成冲量
 */

import type { MusicAudioSample } from '../core/expr';

/**
 * 一帧的音频特征。**这个对象是被复用的**（每帧每源都会读，不能分配）——
 * 拿到就用，不要留着跨帧比对。
 */
export interface AudioFeatures {
  /** 整帧响度，0..1（按整首轨归一）。 */
  rms: number;
  /** 谱通量（正向前半差分和），0..1。 */
  flux: number;
  /** 五个频段的能量，0..1。sub 20–60 · bass 60–250 · mid 250–2000 · high 2000–6000 · air 6000–16000 Hz。 */
  sub: number;
  bass: number;
  mid: number;
  high: number;
  air: number;
  /** 谱重心 / Nyquist，0..1。 */
  centroid: number;
  /** 谱平坦度（几何均值 / 算术均值），0..1。噪声接近 1，纯音接近 0。 */
  flat: number;
  /**
   * **累积行程** —— rms 的确定性前缀积分（固定步长）。
   * 供「速度可以变但图案不跳」的滚动用（隧道 / 墨迹 / 竖线束都靠它）。
   */
  travel: number;
  /**
   * 最近四个 onset 的**年龄**（秒），`[0]` 最新。长度恒为 4。
   * 很久没有 onset 时给一个大值（9），于是 `exp(-age/decay)` 自然归零。
   */
  readonly ages: Float32Array;
}

/** 特征来源：工程时间 `t`（秒）→ 特征。**纯函数，可 seek。** */
export interface AudioFeatureSource {
  at(t: number, out: AudioFeatures): void;
  /**
   * 音频 / 段落量的采样（调制器表达式用）。可选 —— lab 的合成源、`recall` 的
   * 空源都不实现，此时表达式里的 `rms` / `energy` 等恒为 0。
   *
   * **必须复用同一个对象**（每帧每参数都会读，不能每次分配）。
   * 不返回 `bar` / `beatInBar`：那两个由拍网格算，见 `core/expr.ts`。
   */
  musicAt?(t: number): MusicAudioSample;
}

/** 把 `out` 写成「静音」：曲线归零，`ages` 给大值（冲量自然为 0）。**不分配。** */
export function zeroFeatures(out: AudioFeatures): void {
  out.rms = 0;
  out.flux = 0;
  out.sub = 0;
  out.bass = 0;
  out.mid = 0;
  out.high = 0;
  out.air = 0;
  out.centroid = 0;
  out.flat = 0;
  out.travel = 0;
  for (let k = 0; k < 4; k += 1) out.ages[k] = AGE_SENTINEL;
}

/** 没有 onset 时的年龄哨兵（秒）：`exp(-9/0.075)` 早已归零。 */
export const AGE_SENTINEL = 9;

/** 造一个新的「静音」特征对象（`at(t)` 的出参模板）。 */
export function emptyFeatures(): AudioFeatures {
  const out: AudioFeatures = {
    rms: 0,
    flux: 0,
    sub: 0,
    bass: 0,
    mid: 0,
    high: 0,
    air: 0,
    centroid: 0,
    flat: 0,
    travel: 0,
    ages: new Float32Array(4),
  };
  zeroFeatures(out);
  return out;
}
