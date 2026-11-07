/**
 * param-scale.ts — `RangeParam` 的展示刻度 → 滑杆的 `SliderScale`。
 *
 * 参数表里有两个字段表达「这条滑杆怎么走」：`curve`（幂律指数）与
 * `scale: 'log'`（对数）。换算只在这一处，于是加 / 改刻度时不用去四个
 * 渲染点（检查器、粒子面板、lab 源 / 特效）各改一遍。
 *
 * 缺省返回 `undefined`（= 线性），让 `Slider` 走最省的那条分支：绝大多数
 * 参数是线性，没必要每次拖拽都算 `Math.pow`。
 */

import type { RangeParam } from '../../effects/types';
import type { SliderScale } from './slider-math';

export function sliderScaleOf(
  p: Pick<RangeParam, 'curve' | 'scale'>,
): SliderScale | undefined {
  // 两个都给了以 `log` 为准：它的语义更强（「倍频程等宽」），
  // 而参数表里同时给多半是改刻度时漏删了旧字段。
  if (p.scale === 'log') return { log: true };
  if (p.curve !== undefined && p.curve > 0 && p.curve !== 1) return { curve: p.curve };
  return undefined;
}
