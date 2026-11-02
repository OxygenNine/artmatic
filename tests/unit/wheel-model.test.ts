import { describe, expect, it } from 'vitest';
import { directionSwatch, hueDirection, rgbToWheel, wheelToRgb } from '../../src/ui/grade/wheel-model';

/**
 * 色轮 ↔ 三分量的换算。
 *
 * 两条判据都是「被报过 bug」的那种：角度错 180°（R=1 的把手顶在青色上）、
 * 半径与数值对不上（写 1.00 把手却停在 82%）。
 */
describe('色轮映射', () => {
  it('红 / 绿 / 蓝落在 0° / 120° / 240°（把手方向与环上的色相同一套）', () => {
    const red = rgbToWheel(1, 0, 0);
    expect(red.angle).toBeCloseTo(0, 9);
    expect(red.radius).toBeGreaterThan(0.8);

    const green = rgbToWheel(0, 1, 0);
    expect(green.angle).toBeCloseTo(1 / 3, 9);
    expect(green.radius).toBeGreaterThan(0.8);

    const blue = rgbToWheel(0, 0, 1);
    expect(blue.angle).toBeCloseTo(2 / 3, 9);
    expect(blue.radius).toBeGreaterThan(0.8);
  });

  it('最外圈 = 零亮度方向（三分量之和为 0）', () => {
    for (const [a, expected] of [
      [0, [0.816, -0.408, -0.408]],
      [1 / 3, [-0.408, 0.816, -0.408]],
      [2 / 3, [-0.408, -0.408, 0.816]],
    ] as const) {
      const v = wheelToRgb(a, 1);
      expect(v.reduce((s, x) => s + x, 0)).toBeCloseTo(0, 9);
      v.forEach((x, i) => expect(x).toBeCloseTo(expected[i]!, 3));
    }
  });

  it('中性落在圆心（半径 0，角度无意义）', () => {
    expect(rgbToWheel(0, 0, 0).radius).toBe(0);
    expect(rgbToWheel(0.4, 0.4, 0.4).radius).toBeCloseTo(0, 9);
  });

  it('往返：角度 + 半径 → 三分量 → 角度 + 半径', () => {
    for (const a of [0, 0.08, 0.25, 0.4, 0.62, 0.9]) {
      for (const r of [0.2, 0.6, 1]) {
        const [x, y, z] = wheelToRgb(a, r);
        const back = rgbToWheel(x, y, z);
        expect(back.angle).toBeCloseTo(a, 6);
        expect(back.radius).toBeCloseTo(r, 6);
      }
    }
  });

  it('色相方向向量是零亮度的（推色相不改整体亮度）', () => {
    for (const a of [0, 0.13, 0.37, 0.72]) {
      const [x, y, z] = hueDirection(a);
      expect(x + y + z).toBeCloseTo(0, 9);
    }
  });

  it('指示色块把 [-1,1] 映射到 0..255', () => {
    expect(directionSwatch([1, -1, 0])).toBe('rgb(255 0 128)');
  });
});
