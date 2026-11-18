/**
 * `core/dims.ts` —— H.264 只吃偶数宽高。
 *
 * 这条是实测的坑：预览缓冲尺寸由布局决定（1183×665、853×480 都很正常），
 * 而 H.264 编码器对奇数宽高直接 `isConfigSupported: false` —— 四档阶梯同时落空，
 * 报出来的却是「本机没有可用 H.264」，而导出（工程分辨率是偶数）照样能导。
 */

import { describe, expect, it } from 'vitest';
import { evenDims } from '../../src/core/dims';

describe('evenDims', () => {
  it('奇数宽高取到最近的偶数，偶数原样返回', () => {
    expect(evenDims(1183, 665)).toEqual({ w: 1182, h: 664 });
    expect(evenDims(1280, 720)).toEqual({ w: 1280, h: 720 });
  });

  it('幂等（渲染尺寸与编码尺寸会各取一次）', () => {
    const once = evenDims(853, 480);
    expect(evenDims(once.w, once.h)).toEqual(once);
  });

  it('退化输入也给出 ≥2 的偶数（0×0 会把「不支持」写进探测缓存）', () => {
    expect(evenDims(1, 1)).toEqual({ w: 2, h: 2 });
    expect(evenDims(Number.NaN, 0)).toEqual({ w: 2, h: 2 });
    expect(evenDims(3, 5)).toEqual({ w: 2, h: 4 });
  });
});
