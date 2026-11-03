import type { ParamDef } from '../types';
import type { MessageKey } from '../../i18n/locales';

/**
 * `grade-qualifier` 的参数表 —— **按色相 / 饱和度 / 亮度选一块区域，只改这块**。
 *
 * 与 `SourceClip.key`（抠图）不是一回事：抠图改的是**图层 alpha**（背景被抠掉，
 * 露出下方轨道）；这里是**选出颜色相近的区域做局部校正**，alpha 一点没动。
 * 两者最终都进「蒙版」这条消费路径（见 `core/mask.ts`），但一个是图层属性、
 * 一个是调色模块，别混。
 *
 * ## 键的分工
 *
 * 前七个描述**选什么**（键），后四个描述**选中之后怎么改**，最后一个是混合量。
 * `invert` 在两者之间：它改变的是「选中」还是「选中之外」，不是选区的形状。
 *
 * ## 为什么 `softness` 只有一个
 *
 * 色相、饱和度、亮度三个判据各有一套单位（度 / 0..1 / 0..1）。给三个柔化滑杆
 * 会让面板变成六行，而用户真正想调的是「边缘软不软」。所以一个 0..0.5 的量，
 * 色相那一支乘 180 换成度，另两支直接当 0..1 用（见 shader 里的换算）。
 */
export const id = 'grade-qualifier';
export const nameKey: MessageKey = 'fx.gradeQualifier';
export const params: ParamDef[] = [
  /* ---------------------------------------------------------------- 键 */
  {
    key: 'hue',
    labelKey: 'fx.gradeQualifier.hue',
    type: 'range',
    min: 0,
    max: 360,
    step: 1,
    defaultValue: 30,
  },
  {
    key: 'hueRange',
    labelKey: 'fx.gradeQualifier.hueRange',
    type: 'range',
    min: 0,
    max: 180,
    step: 1,
    defaultValue: 40,
  },
  {
    key: 'satMin',
    labelKey: 'fx.gradeQualifier.satMin',
    type: 'range',
    min: 0,
    max: 1,
    step: 0.01,
    defaultValue: 0.2,
  },
  {
    key: 'lumaMin',
    labelKey: 'fx.gradeQualifier.lumaMin',
    type: 'range',
    min: 0,
    max: 1,
    step: 0.01,
    defaultValue: 0,
  },
  {
    key: 'lumaMax',
    labelKey: 'fx.gradeQualifier.lumaMax',
    type: 'range',
    min: 0,
    max: 1,
    step: 0.01,
    defaultValue: 1,
  },
  {
    key: 'softness',
    labelKey: 'fx.gradeQualifier.softness',
    type: 'range',
    min: 0,
    max: 0.5,
    step: 0.01,
    defaultValue: 0.08,
  },
  {
    key: 'invert',
    labelKey: 'fx.gradeQualifier.invert',
    type: 'checkbox',
    defaultValue: 0,
  },

  /* -------------------------------------------------------------- 校正 */
  {
    key: 'exposure',
    labelKey: 'fx.gradeQualifier.exposure',
    type: 'range',
    min: -3,
    max: 3,
    step: 0.05,
    defaultValue: 0.6,
  },
  {
    key: 'saturation',
    labelKey: 'fx.gradeQualifier.saturation',
    type: 'range',
    min: 0,
    max: 2,
    step: 0.01,
    defaultValue: 1,
  },
  {
    key: 'hueShift',
    labelKey: 'fx.gradeQualifier.hueShift',
    type: 'range',
    min: -180,
    max: 180,
    step: 1,
    defaultValue: 0,
  },
  {
    key: 'amount',
    labelKey: 'fx.gradeQualifier.amount',
    type: 'range',
    min: 0,
    max: 1,
    step: 0.01,
    defaultValue: 1,
  },
];
