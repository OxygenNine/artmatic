import { describe, expect, it } from 'vitest';
import {
  evaluateToneCurve,
  identityPoints,
  isIdentity,
  parseToneCurve,
  pointFromDisplay,
  pointToDisplay,
  sampleToneCurve,
  stringifyToneCurve,
  TONE_CURVE_WIDTH,
  type CurvePoint,
} from '../../src/core/tone-curve';
import { linearToSrgb, srgbToLinear } from '../../src/core/color';

/**
 * 色调曲线的守卫。
 *
 * 判据全取「能被平凡实现满足就不算」的量：
 *  - 恒等曲线采样后必须**逐点等于 y = x**（不是「看起来像直线」）；
 *  - 单调性：控制点单调时整张表也不许回头（Fritsch–Carlson 的全部意义）；
 *  - 不过冲：S 曲线的值必须落在相邻控制点之间（普通三次样条会越界）；
 *  - 解析永不抛异常（`values` 可以被插件 / 手改 JSON 写入垃圾）。
 */

const pts = (raw: [number, number][]): CurvePoint[] => raw.map(([x, y]) => ({ x, y }));

describe('解析与序列化', () => {
  it('恒等存成空串，读回来是恒等', () => {
    expect(stringifyToneCurve(identityPoints())).toBe('');
    expect(isIdentity(parseToneCurve(''))).toBe(true);
  });

  it('往返一致（四位小数）', () => {
    const p = pts([
      [0, 0],
      [0.25, 0.19],
      [1, 1],
    ]);
    const back = parseToneCurve(stringifyToneCurve(p));
    expect(back.map((q) => [Math.round(q.x * 1e4), Math.round(q.y * 1e4)])).toEqual(
      p.map((q) => [Math.round(q.x * 1e4), Math.round(q.y * 1e4)]),
    );
  });

  it('乱序输入自动排序', () => {
    const back = parseToneCurve('1,1;0,0;0.5,0.6');
    expect(back.map((q) => q.x)).toEqual([0, 0.5, 1]);
  });

  it('垃圾输入回落到恒等，不抛', () => {
    for (const bad of ['garbage', '0,0', ';;;', 'a,b;c,d', '0,0;1', 'NaN,0.5;1,1']) {
      const back = parseToneCurve(bad);
      expect(back.length, bad).toBeGreaterThanOrEqual(2);
      expect(back.every((p) => Number.isFinite(p.x) && Number.isFinite(p.y))).toBe(true);
    }
  });

  it('x 重复时去重（分母为 0 会让插值出 NaN）', () => {
    const back = parseToneCurve('0,0;0.5,0.2;0.5,0.8;1,1');
    expect(back.length).toBe(3);
  });

  it('越界值被钳到 0..1', () => {
    const back = parseToneCurve('-1,-1;2,2');
    expect(back[0]).toEqual({ x: 0, y: 0 });
    expect(back[1]).toEqual({ x: 1, y: 1 });
  });
});

describe('采样：单调三次', () => {
  it('恒等曲线的表逐点等于 y = x', () => {
    const table = sampleToneCurve(identityPoints());
    expect(table.length).toBe(TONE_CURVE_WIDTH);
    for (const i of [0, 1, 100, 511, 1023]) {
      expect(table[i]!).toBeCloseTo(i / (TONE_CURVE_WIDTH - 1), 5);
    }
  });

  it('单调控制点 → 整张表单调（不许回头）', () => {
    const table = sampleToneCurve(
      pts([
        [0, 0],
        [0.2, 0.05],
        [0.5, 0.5],
        [0.8, 0.95],
        [1, 1],
      ]),
    );
    let prev = -1;
    for (let i = 0; i < table.length; i += 1) {
      expect(table[i]!, `第 ${i} 个采样点回头了`).toBeGreaterThanOrEqual(prev - 1e-6);
      prev = table[i]!;
    }
  });

  it('S 曲线不过冲：采样值落在 0..1 且不越过相邻控制点之外', () => {
    const table = sampleToneCurve(
      pts([
        [0, 0],
        [0.3, 0.15],
        [0.7, 0.85],
        [1, 1],
      ]),
    );
    for (const v of table) {
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThanOrEqual(1);
    }
    // 中间段不许超过 0.85（普通三次样条在这里会冲到 0.9+）
    const mid = table[Math.floor(TONE_CURVE_WIDTH * 0.7)]!;
    expect(mid).toBeLessThanOrEqual(0.85 + 1e-6);
  });

  it('曲线之外被钳制（不外推）', () => {
    const table = sampleToneCurve(
      pts([
        [0.25, 0.2],
        [0.75, 0.8],
      ]),
    );
    expect(table[0]!).toBeCloseTo(0.2, 6);
    expect(table[TONE_CURVE_WIDTH - 1]!).toBeCloseTo(0.8, 6);
  });

  it('所有值都在 0..1（负 lift 之类不许漏出去）', () => {
    const table = sampleToneCurve(
      pts([
        [0, 0],
        [0.5, 0],
        [1, 1],
      ]),
    );
    expect(Math.min(...table)).toBeGreaterThanOrEqual(0);
    expect(Math.max(...table)).toBeLessThanOrEqual(1);
  });

  it('evaluateToneCurve 与表一致', () => {
    const p = pts([
      [0, 0],
      [0.5, 0.4],
      [1, 1],
    ]);
    const table = sampleToneCurve(p);
    for (const x of [0, 0.25, 0.5, 0.75, 1]) {
      const idx = Math.round(x * (TONE_CURVE_WIDTH - 1));
      expect(evaluateToneCurve(p, x)).toBeCloseTo(table[idx]!, 2);
    }
  });
});

describe('显示坐标（编码）↔ 存储坐标（线性）', () => {
  it('端点不动', () => {
    expect(pointToDisplay({ x: 0, y: 0 })).toEqual({ x: 0, y: 0 });
    expect(pointToDisplay({ x: 1, y: 1 }).x).toBeCloseTo(1, 12);
    expect(pointToDisplay({ x: 1, y: 1 }).y).toBeCloseTo(1, 12);
  });

  it('中灰在线性里是 0.2140（与 toLinear(0.5) 同源）', () => {
    const p = pointFromDisplay(0.5, 0.5);
    expect(p.x).toBeCloseTo(srgbToLinear(0.5), 12);
    expect(pointToDisplay(p).x).toBeCloseTo(0.5, 9);
  });

  it('往返一致', () => {
    for (const v of [0, 0.1, 0.35, 0.6, 0.9, 1]) {
      const p = pointFromDisplay(v, v);
      expect(pointToDisplay(p).x).toBeCloseTo(v, 9);
      expect(linearToSrgb(p.x)).toBeCloseTo(v, 9);
    }
  });
});
