import { describe, expect, it } from 'vitest';
import {
  clamp,
  fractionOf,
  keyDelta,
  precisionOf,
  quantize,
  roundTo,
  valueAtX,
} from '../../src/ui/controls/slider-math';
import { sliderScaleOf } from '../../src/ui/controls/param-scale';

describe('clamp / roundTo / precisionOf', () => {
  it('clamp 常规与退化区间', () => {
    expect(clamp(5, 0, 10)).toBe(5);
    expect(clamp(-1, 0, 10)).toBe(0);
    expect(clamp(11, 0, 10)).toBe(10);
    // max < min 的退化区间不返回 NaN
    expect(clamp(5, 10, 0)).toBe(10);
  });

  it('roundTo 消掉浮点噪声', () => {
    expect(roundTo(0.1 + 0.2, 2)).toBe(0.3);
    expect(roundTo(1.005, 2)).toBe(1.0);
    expect(roundTo(1.2345, 3)).toBe(1.235);
  });

  it('precisionOf 认小数位与科学计数法', () => {
    expect(precisionOf(1)).toBe(0);
    expect(precisionOf(0.5)).toBe(1);
    expect(precisionOf(0.01)).toBe(2);
    expect(precisionOf(0.005)).toBe(3);
    expect(precisionOf(2e-7)).toBe(7);
    expect(precisionOf(0)).toBe(0);
    expect(precisionOf(-1)).toBe(0);
  });

  it('quantize 以 min 为原点（不是绝对 0）', () => {
    expect(quantize(0.37, 0, 0.1)).toBeCloseTo(0.4, 6);
    // min=0.5 step=0.5 时合法值是 0.5/1.0/1.5，不该吸附到 0
    expect(quantize(0.8, 0.5, 0.5)).toBe(1.0);
    expect(quantize(5, 0, 0)).toBe(5); // step 退化时原样返回
  });
});

describe('valueAtX — 滑杆的唯一映射（E2E 同步契约的几何前提）', () => {
  it('线性映射：左端 min，右端 max，中点中值', () => {
    expect(valueAtX(0, 0, 100, 0, 1)).toBeCloseTo(0, 6);
    expect(valueAtX(100, 0, 100, 0, 1)).toBeCloseTo(1, 6);
    expect(valueAtX(50, 0, 100, 0, 1)).toBeCloseTo(0.5, 6);
    expect(valueAtX(75, 0, 200, 0, 1)).toBeCloseTo(0.375, 6);
  });

  it('尊重 left 偏移（轨道不在视口 0 位置）', () => {
    expect(valueAtX(150, 100, 100, 0, 1)).toBeCloseTo(0.5, 6);
  });

  it('越界钳到两端，不外推', () => {
    expect(valueAtX(-999, 0, 100, 0, 1)).toBe(0);
    expect(valueAtX(999, 0, 100, 0, 1)).toBe(1);
  });

  it('宽度为 0 / 负 / NaN 时返回 min，绝不返回 NaN', () => {
    for (const w of [0, -5, Number.NaN]) {
      const v = valueAtX(50, 0, w, 0.25, 1);
      expect(Number.isNaN(v)).toBe(false);
      expect(v).toBe(0.25);
    }
  });

  it('有 step 时结果落在 step 网格上', () => {
    const v = valueAtX(37, 0, 100, 0, 10, 1);
    expect(v).toBe(4);
    expect(Number.isInteger(v)).toBe(true);
  });

  it('量化后仍不越界（右端 + step 的经典 bug）', () => {
    for (const x of [0, 1, 33, 67, 99, 100, 101]) {
      const v = valueAtX(x, 0, 100, 0, 1, 0.1);
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThanOrEqual(1);
    }
  });

  it('负区间也能用（如旋转的 -π..π）', () => {
    expect(valueAtX(50, 0, 100, -3.1416, 3.1416)).toBeCloseTo(0, 4);
  });
});

describe('fractionOf — 值 → thumb 位置', () => {
  it('端点与中值', () => {
    expect(fractionOf(0, 0, 10)).toBe(0);
    expect(fractionOf(10, 0, 10)).toBe(1);
    expect(fractionOf(5, 0, 10)).toBe(0.5);
  });

  it('退化区间返回 0 而不是 Infinity/NaN', () => {
    expect(fractionOf(5, 5, 5)).toBe(0);
  });

  it('与 valueAtX 互为逆（同一线性尺度）', () => {
    for (const v of [0, 0.13, 0.5, 0.77, 1]) {
      const x = fractionOf(v, 0, 1) * 100;
      expect(valueAtX(x, 0, 100, 0, 1)).toBeCloseTo(v, 6);
    }
  });
});

/**
 * 非线性刻度（粒子数的对数滑杆就是这条的唯一用户）。
 *
 * 两条硬要求：端点精确、`valueAtX` 与 `fractionOf` 互为逆 —— 后者是
 * 「拖滑杆时数字框与 store 逐帧一致」那条 E2E 契约的几何前提，
 * 两个方向用了不同刻度时症状是把手在左、数字在右。
 */
describe('SliderScale — 对数 / 幂律刻度', () => {
  const LOG = { log: true } as const;
  const EXP2 = { curve: 2 } as const;

  it('对数：端点精确，中点取几何平均（不是算术平均）', () => {
    expect(valueAtX(0, 0, 100, 256, 262144, 1, LOG)).toBe(256);
    expect(valueAtX(100, 0, 100, 256, 262144, 1, LOG)).toBe(262144);
    // 中点是 sqrt(256 * 262144) = 8192，而线性中点会是 131200。
    expect(valueAtX(50, 0, 100, 256, 262144, 1, LOG)).toBeCloseTo(8192, 0);
  });

  it('对数：低段被拉开（256→2000 占 ~29% 行程，线性只有 0.7%）', () => {
    const fracOf2000 = fractionOf(2000, 256, 262144, LOG);
    expect(fracOf2000).toBeGreaterThan(0.25);
    expect(fractionOf(2000, 256, 262144)).toBeLessThan(0.01);
  });

  it('对数：两个方向互为逆', () => {
    for (const v of [256, 700, 2000, 16384, 90000, 262144]) {
      const x = fractionOf(v, 256, 262144, LOG) * 1000;
      expect(valueAtX(x, 0, 1000, 256, 262144, 1, LOG) / v).toBeCloseTo(1, 4);
    }
  });

  it('对数：min <= 0 时退回线性，绝不产生 NaN', () => {
    for (const v of [-10, 0, 5, 10]) {
      const got = valueAtX(50, 0, 100, -10, 10, 0, LOG);
      expect(Number.isNaN(got)).toBe(false);
      expect(got).toBeCloseTo(0, 6);
    }
  });

  it('幂律：指数 2 时低段占更多行程，端点仍精确', () => {
    expect(valueAtX(0, 0, 100, 0, 4, 0, EXP2)).toBe(0);
    expect(valueAtX(100, 0, 100, 0, 4, 0, EXP2)).toBe(4);
    // frac 0.5 → 0.25 * 4 = 1
    expect(valueAtX(50, 0, 100, 0, 4, 0, EXP2)).toBeCloseTo(1, 6);
    expect(fractionOf(1, 0, 4, EXP2)).toBeCloseTo(0.5, 6);
  });

  it('刻度退化（curve=1 / 0 / 负数）等价于线性', () => {
    for (const curve of [1, 0, -2]) {
      expect(valueAtX(50, 0, 100, 0, 10, 0, { curve })).toBeCloseTo(5, 6);
    }
  });
});

/** 参数表 → 滑杆刻度：唯一换算处，两个字段的优先级钉在这里。 */
describe('sliderScaleOf', () => {
  it('线性参数返回 undefined（走最省的那条分支）', () => {
    expect(sliderScaleOf({})).toBeUndefined();
    expect(sliderScaleOf({ curve: 1 })).toBeUndefined();
  });

  it('curve / log 各自成立', () => {
    expect(sliderScaleOf({ curve: 5 })).toEqual({ curve: 5 });
    expect(sliderScaleOf({ scale: 'log' })).toEqual({ log: true });
  });

  it('两个都给时以 log 为准（改刻度漏删旧字段不该反被 curve 抢）', () => {
    expect(sliderScaleOf({ curve: 2, scale: 'log' })).toEqual({ log: true });
  });
});

describe('keyDelta', () => {
  it('方向键 ±step，Shift 加速 ×10', () => {
    expect(keyDelta('ArrowRight', 0.1, false)).toBeCloseTo(0.1, 6);
    expect(keyDelta('ArrowLeft', 0.1, false)).toBeCloseTo(-0.1, 6);
    expect(keyDelta('ArrowUp', 0.1, true)).toBeCloseTo(1, 6);
    expect(keyDelta('ArrowDown', 0.1, true)).toBeCloseTo(-1, 6);
  });

  it('PageUp/PageDown 是 10 步（与原生 range 一致）', () => {
    expect(keyDelta('PageUp', 1, false)).toBe(10);
    expect(keyDelta('PageDown', 1, false)).toBe(-10);
  });

  it('无关键返回 null（放行给页面）', () => {
    expect(keyDelta('a', 1, false)).toBeNull();
    expect(keyDelta('Home', 1, false)).toBeNull();
    expect(keyDelta('Escape', 1, false)).toBeNull();
  });
});
