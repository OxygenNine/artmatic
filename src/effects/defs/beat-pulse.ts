import { clockParams } from '../shader-def';
import type { ParamDef } from '../types';

export const id = 'beat-pulse';
export const nameKey = 'fx.beatPulse';
export const params: ParamDef[] = [
  ...clockParams({ labelKey: 'fx.beatPulse.speed', min: 0.25, max: 8, step: 0.05, defaultValue: 2 }),
  { key: 'amount', labelKey: 'fx.beatPulse.amount', type: 'range', min: 0, max: 1, step: 0.01, defaultValue: 0.35 },
  // 衰减指数：1 = 线性拖到下一拍，越大收得越干脆（闪白与抖动用同一份）。
  { key: 'decay', labelKey: 'fx.beatPulse.decay', type: 'range', min: 0.5, max: 8, step: 0.1, defaultValue: 2.5 },
  { key: 'shake', labelKey: 'fx.beatPulse.shake', type: 'range', min: 0, max: 60, step: 1, defaultValue: 12 },
  // 相位偏移：对齐音频之外的用途是对拍（同一拍上叠几个错开的脉冲）。
  { key: 'offset', labelKey: 'fx.beatPulse.offset', type: 'range', min: 0, max: 1, step: 0.01, defaultValue: 0 },
];
