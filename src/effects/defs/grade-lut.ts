import type { ParamDef } from '../types';
import type { MessageKey } from '../../i18n/locales';

/**
 * `grade-lut`。
 *
 * 参数只有**输入空间**一条；LUT 本身是「工程素材 id」，存在保留键
 * `values['lutAssetId']` 里，由调色面板的导入按钮写入 —— 它不是滑杆，
 * 也不该被关键帧化（换 LUT 是一个决定，不是一条曲线）。
 *
 * 许可上的取舍（见 TODO P1）：**不打包任何第三方 LUT 集合**，只接受用户自己
 * 导入的 `.cube`。预设改为「参数化的 grade 预设」（一组 basic + curves 的值），
 * 那样没有许可问题，用户改完还能继续调。
 */
export const id = 'grade-lut';
export const nameKey: MessageKey = 'fx.gradeLut';
export const params: ParamDef[] = [
  {
    key: 'space',
    labelKey: 'fx.gradeLut.space',
    type: 'select',
    defaultValue: 'srgb',
    options: [
      { labelKey: 'fx.gradeLut.spaceSrgb', value: 'srgb' },
      { labelKey: 'fx.gradeLut.spaceLinear', value: 'linear' },
      { labelKey: 'fx.gradeLut.spaceLogC', value: 'logc' },
    ],
  },
];
