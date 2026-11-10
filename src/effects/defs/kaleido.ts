import type { ParamDef } from '../types';

export const id = 'kaleido';
export const nameKey = 'fx.kaleido';
export const params: ParamDef[] = [
  { key: 'amount', labelKey: 'fx.kaleido.amount', type: 'range', min: 0, max: 1, step: 0.01, defaultValue: 1 },
  { key: 'sides', labelKey: 'fx.kaleido.sides', type: 'range', min: 2, max: 12, step: 1, defaultValue: 6 },
  { key: 'angle', labelKey: 'fx.kaleido.angle', type: 'range', min: 0, max: 360, step: 1, defaultValue: 0 },
  /**
   * 圆形对称：极坐标改在**等比空间**里算。缺省开 —— 按 `vUv` 折叠时「等半径」
   * 在屏幕上是一条随画幅拉长的椭圆，宽画面下一眼就看得出歪；等比空间里是正圆。
   * v21 及以前的工程由 schema v22 迁移显式写 `0`，观感不变。
   */
  { key: 'circle', labelKey: 'fx.kaleido.circle', type: 'checkbox', defaultValue: 1 },
];
