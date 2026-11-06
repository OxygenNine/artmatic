import type { ParamDef } from '../types';

export const id = 'tile-shuffle';
export const nameKey = 'fx.tileShuffle';
export const params: ParamDef[] = [
  // 格子边长按**输出像素**给。用户看到的是「格子多大」，不是「切了几列」——
  // 后者会随预览/导出分辨率变，同一 t 出两套画面。
  { key: 'cellPx', labelKey: 'fx.tileShuffle.cellPx', type: 'range', min: 8, max: 200, step: 1, defaultValue: 48 },
  { key: 'density', labelKey: 'fx.tileShuffle.density', type: 'range', min: 0, max: 1, step: 0.01, defaultValue: 0.5 },
  // 0 = 定格（图案不随时间变），其余 = 每秒重洗几次。
  { key: 'rate', labelKey: 'fx.tileShuffle.rate', type: 'range', min: 0, max: 24, step: 1, defaultValue: 6 },
];
