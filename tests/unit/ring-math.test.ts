import { describe, expect, it } from 'vitest';
import {
  angleOf,
  clampRadius,
  hueRingGradient,
  neutralRingGradient,
  nudgeAngle,
  polarToXY,
  snapAngle,
  wrap01,
  xyToPolar,
} from '../../src/ui/controls/ring-math';

/**
 * 环形滚动条的数学。
 *
 * 判据都取「写反了会怎样」的那一面：角度方向反了 → 色轮上下镜像（截图才看得出）；
 * 半径用容器半径而不是把手活动半径 → 永远拖不到 1.0；环绕不归零 → 拖过一圈后
 * 值与位置脱节。
 */

describe('wrap01', () => {
  it('负数绕回正区间', () => {
    expect(wrap01(-0.25)).toBeCloseTo(0.75, 12);
    expect(wrap01(-1.25)).toBeCloseTo(0.75, 12);
  });

  it('整数边界归零（1 与 0 是同一点）', () => {
    expect(wrap01(1)).toBe(0);
    expect(wrap01(2)).toBe(0);
    expect(wrap01(0)).toBe(0);
  });

  it('非有限值归零而不是 NaN', () => {
    expect(wrap01(Number.NaN)).toBe(0);
    expect(wrap01(Infinity)).toBe(0);
  });
});

describe('xyToPolar：屏幕坐标 → 逆时针角度', () => {
  it('右 = 0，上 = 0.25，左 = 0.5，下 = 0.75', () => {
    expect(xyToPolar(1, 0).angle).toBeCloseTo(0, 12);
    expect(xyToPolar(0, -1).angle).toBeCloseTo(0.25, 12);
    expect(xyToPolar(-1, 0).angle).toBeCloseTo(0.5, 12);
    expect(xyToPolar(0, 1).angle).toBeCloseTo(0.75, 12);
  });

  it('45° 落在 1/8 与 7/8（屏幕 y 向下，所以右上更小）', () => {
    expect(xyToPolar(1, -1).angle).toBeCloseTo(0.125, 12);
    expect(xyToPolar(1, 1).angle).toBeCloseTo(0.875, 12);
  });

  it('半径是距离本身（归一化交给 angleOf）', () => {
    expect(xyToPolar(3, 4).radius).toBeCloseTo(5, 12);
  });
});

describe('polarToXY', () => {
  it('与 xyToPolar 往返一致', () => {
    for (const a of [0, 0.1, 0.33, 0.5, 0.77, 0.99]) {
      const p = polarToXY(a, 0.6);
      const back = xyToPolar(p.x, p.y);
      expect(back.angle).toBeCloseTo(a, 12);
      expect(back.radius).toBeCloseTo(0.6, 12);
    }
  });
});

describe('angleOf：指针 → 值', () => {
  const R = 50;

  it('拖到活动半径上恰好是 1.0（不是容器半径）', () => {
    expect(angleOf(R, 0, R, false, 0).radius).toBeCloseTo(1, 12);
  });

  it('半程是 0.5，超出被钳到 1', () => {
    expect(angleOf(R / 2, 0, R, false, 0).radius).toBeCloseTo(0.5, 12);
    expect(angleOf(R * 3, 0, R, false, 0).radius).toBe(1);
  });

  it('圆心半径是 0（色轮的中性位置）', () => {
    expect(angleOf(0, 0, R, false, 0)).toEqual({ angle: 0, radius: 0 });
  });

  it('吸附只在要求时生效', () => {
    const raw = angleOf(R, -1, R, false, 1 / 24).angle;
    const snapped = angleOf(R, -1, R, true, 1 / 24).angle;
    expect(snapped).toBe(0);
    expect(raw).toBeGreaterThan(0);
  });

  it('rPx 为 0 时不产生 Infinity', () => {
    expect(Number.isFinite(angleOf(4, 4, 0, false, 0).radius)).toBe(true);
  });
});

describe('snapAngle / nudgeAngle', () => {
  it('吸附到 15° 格点', () => {
    expect(snapAngle(0.02, 1 / 24)).toBe(0);
    expect(snapAngle(0.06, 1 / 24)).toBeCloseTo(1 / 24, 12);
  });

  it('step 为 0 时不吸附', () => {
    expect(snapAngle(0.043, 0)).toBeCloseTo(0.043, 12);
  });
  it('微调是相对增量，跨过 0 会绕回去', () => {
    expect(nudgeAngle(0.5, 1, 0.25)).toBeCloseTo(0.75, 12);
    expect(nudgeAngle(0, -1, 0.1)).toBeCloseTo(0.9, 12);
  });
});

describe('clampRadius', () => {
  it('钳到 0..1，NaN 归 0', () => {
    expect(clampRadius(-1)).toBe(0);
    expect(clampRadius(2)).toBe(1);
    expect(clampRadius(Number.NaN)).toBe(0);
  });
});

describe('渐变串', () => {
  it('色相环从 -90° 起，首尾都是红（十二点方向是红）', () => {
    const g = hueRingGradient();
    expect(g.startsWith('conic-gradient(from -90deg,')).toBe(true);
    expect(g).toContain('hsl(0 100% 50%) 0.00deg');
    expect(g).toContain('hsl(360 100% 50%) 360.00deg');
  });

  it('中性轮走 token，不写死颜色（它只是 chrome）', () => {
    const g = neutralRingGradient();
    expect(g).toContain('var(--surface-3)');
    expect(g).not.toContain('hsl(');
  });
});
