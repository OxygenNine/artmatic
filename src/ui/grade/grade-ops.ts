/**
 * grade-ops.ts — 调色面板读写 `EffectInstance.values` 的纯函数。
 *
 * 组件只负责 DOM；「轮盘位置 ↔ 三个扁平标量」的换算全在这里，可以单测。
 * 与 `wheel-model.ts` 的分工：那边是几何（角度/半径 ↔ 方向向量），这里是
 * 存储（方向向量 ↔ `values['lift#r']` 等等）。
 */

import type { EffectInstance } from '../../core/schema';
import { isGradeDef } from '../../core/grade';
import { params as basicParams } from '../../effects/defs/grade-basic';
import type { WheelGroup } from '../../effects/defs/grade-basic';
import type { MessageKey } from '../../i18n/locales';
import { rgbToWheel, wheelToRgb, type Rgb3 } from './wheel-model';

export type { WheelGroup };

/** 四个轮盘的静态描述。`group` 就是参数键的前缀。 */
export interface WheelSpec {
  group: WheelGroup;
  labelKey: MessageKey;
  masterKey: MessageKey;
  min: number;
  max: number;
  step: number;
  /** 主量为 0 表示「不动」。lift / gain / offset 是 0，gamma 是 1。 */
  neutral: number;
  /**
   * 主量的单位（`EV`）。数值与存储值一致（存的就是 EV），只是标注一下 ——
   * 显示成 `2^EV` 的倍数会让人以为「拉到 +1 才翻倍」，与滑杆刻度对不上。
   * 界面上它进无障碍名：`EV` 两个字塞进 46px 的数字框里会被截断（实测）。
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
  {
    // 偏移：整体曝光 / 色偏。值域比 gain 窄（它连黑位一起动，同样量级更"重"）。
    group: 'offset',
    labelKey: 'fx.gradeBasic.offset',
    masterKey: 'fx.gradeBasic.offsetM',
    min: -2,
    max: 2,
    step: 0.05,
    neutral: 0,
    unit: 'EV',
  },
];

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

/** 这个实例是不是 `grade-basic`（面板按 defId 决定画什么）。 */
export function isBasic(inst: EffectInstance): boolean {
  return inst.defId === 'grade-basic';
}

/**
 * 「全部复位」：四个轮盘**和**下面五个滑杆一起回默认值。
 *
 * 一开始只复位了轮盘，结果按下去之后画面还偏着（对比 / 饱和度还在）——
 * 那个按钮写着「全部」，它就得复位这一整块。判据从参数表取（`defaultValue`），
 * 不另写一份默认值：改了 def 却忘了这里，症状是「复位之后有个值不回零」。
 */
export function resetBasic(inst: EffectInstance): void {
  for (const p of basicParams) {
    if (p.defaultValue !== undefined) inst.values[p.key] = p.defaultValue;
  }
}

/** 链里的调色模块（顺序即合成顺序）。 */
export function gradeInstances(chain: readonly EffectInstance[]): EffectInstance[] {
  return chain.filter((i) => isGradeDef(i.defId));
}
