/**
 * grade-ops.ts — 调色面板读写 `EffectInstance.values` 的纯函数。
 *
 * 组件只负责 DOM；「轮盘位置 ↔ 三个扁平标量」的换算全在这里，可以单测。
 * 与 `wheel-model.ts` 的分工：那边是几何（角度/半径 ↔ 方向向量），这里是
 * 存储（方向向量 ↔ `values['lift#r']` 等等）。
 */

import type { EffectInstance } from '../../core/schema';
import { isGradeDef } from '../../core/grade';
import type { MessageKey } from '../../i18n/locales';
import { rgbToWheel, wheelToRgb, type Rgb3 } from './wheel-model';

/** 三个轮盘的静态描述。`group` 就是参数键的前缀。 */
export interface WheelSpec {
  group: 'lift' | 'gamma' | 'gain';
  labelKey: MessageKey;
  masterKey: MessageKey;
  min: number;
  max: number;
  step: number;
  /** 主量为 0 表示「不动」。lift / gain 是 0，gamma 是 1。 */
  neutral: number;
  /**
   * 主量的显示单位。`'ev'` 的数值与存储值一致（存的就是 EV），
   * 只是标注一下 —— TODO 里「用 EV 显示」指的是不要显示成裸倍数。
   */
  unit?: string;
}

export const WHEELS: readonly WheelSpec[] = [
  {
    group: 'lift',
    labelKey: 'fx.gradeBasic.lift',
    masterKey: 'fx.gradeBasic.liftM',
    min: -0.5,
    max: 0.5,
    step: 0.01,
    neutral: 0,
  },
  {
    group: 'gamma',
    labelKey: 'fx.gradeBasic.gamma',
    masterKey: 'fx.gradeBasic.gammaM',
    min: 0.2,
    max: 3,
    step: 0.01,
    neutral: 1,
  },
  {
    group: 'gain',
    labelKey: 'fx.gradeBasic.gain',
    masterKey: 'fx.gradeBasic.gainM',
    min: -3,
    max: 3,
    step: 0.05,
    neutral: 0,
    unit: 'EV',
  },
];

/** 参数键 → 轮盘组。`lift#r` → `lift`。 */
export function wheelGroupOf(key: string): 'lift' | 'gamma' | 'gain' | null {
  const head = key.split('#')[0];
  return head === 'lift' || head === 'gamma' || head === 'gain' ? head : null;
}

const num = (v: number | string | undefined): number => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};

/** 读一个轮盘的方向分量。 */
export function readDirection(inst: EffectInstance, group: WheelSpec['group']): Rgb3 {
  return [num(inst.values[`${group}#r`]), num(inst.values[`${group}#g`]), num(inst.values[`${group}#b`])];
}

/** 读轮盘位置（角度 0..1、半径 0..1）。全中性时是圆心。 */
export function readWheel(inst: EffectInstance, group: WheelSpec['group']): { angle: number; radius: number } {
  const [r, g, b] = readDirection(inst, group);
  const w = rgbToWheel(r, g, b);
  // 手改过滑杆（分量 > 1）时半径会 > 1，轮盘上夹回外圈，但值不丢。
  return { angle: w.angle, radius: Math.min(1, w.radius) };
}

/** 写轮盘位置：三分量一起写，一个动作 = 一次撤销。 */
export function writeWheel(
  inst: EffectInstance,
  group: WheelSpec['group'],
  pos: { angle: number; radius: number },
): void {
  const [r, g, b] = wheelToRgb(pos.angle, pos.radius);
  inst.values[`${group}#r`] = round4(r);
  inst.values[`${group}#g`] = round4(g);
  inst.values[`${group}#b`] = round4(b);
}

/** 四位小数：与参数步长 0.01 同量级，再细只是给快照加字节。 */
function round4(v: number): number {
  return Math.round(v * 1e4) / 1e4;
}

/** 轮盘是否在中性位置（半径 0 且主量在默认值）。用于「双击复位」与徽标。 */
export function isNeutral(inst: EffectInstance, spec: WheelSpec): boolean {
  return readWheel(inst, spec.group).radius < 1e-4 && Math.abs(num(inst.values[`${spec.group}#m`]) - spec.neutral) < 1e-6;
}

/** 这个实例是不是 `grade-basic`（面板按 defId 决定画什么）。 */
export function isBasic(inst: EffectInstance): boolean {
  return inst.defId === 'grade-basic';
}

/**
 * 主量的显示文本。
 *
 * gain 存的就是 EV，所以直接标 `EV`（不显示 `2^EV` 的倍数：那会让人以为
 * 滑杆上拉一倍才是「+1」，而实际 +1 EV 是 2 倍 —— 显示 EV 才与滑杆刻度一致）。
 * gamma 是乘数，两位小数；lift 是加性偏移，带符号。
 */
export function formatMaster(spec: WheelSpec, v: number): string {
  const dec = spec.step >= 0.05 ? 2 : Math.min(3, Math.max(2, Math.ceil(-Math.log10(spec.step))));
  const text = v.toFixed(dec);
  if (spec.unit) return `${text.startsWith('-') ? text : `+${text}`} ${spec.unit}`;
  return v > 0 ? `+${text}` : text;
}

/** 链里的调色模块（顺序即合成顺序）。 */
export function gradeInstances(chain: readonly EffectInstance[]): EffectInstance[] {
  return chain.filter((i) => isGradeDef(i.defId));
}
