import { describe, expect, it } from 'vitest';
import { SRGB_TRANSFER, linearToSrgb, srgbToLinear } from '../../src/core/color';
import { EFFECT_HEAD, TRANSFER_GLSL } from '../../src/effects/shader-def';

/**
 * sRGB 传输函数的守卫。
 *
 * 判据都取「能被常数本身满足就不算」的量：
 *  - `toLinear(0.5) = 0.2140` 钉住**分段式**（2.2 幂给的是 0.2176，差得出来）；
 *  - 往返误差按 1/1024 定量 —— 这个数字来自 16F 的尾数（half 在 [0.5,1) 里的
 *    步长正好是 1/2048），不是拍的；
 *  - GLSL 与 TS 的常数一致性由**拼字符串**保证，这里只断言拼进去的确实是那些数。
 */

describe('sRGB 传输函数：数值', () => {
  it('toLinear(0.5) ≈ 0.2140（分段式，不是 2.2 幂）', () => {
    expect(srgbToLinear(0.5)).toBeCloseTo(0.214, 4);
  });

  it('两个端点是 0 与 1', () => {
    expect(srgbToLinear(0)).toBe(0);
    expect(srgbToLinear(1)).toBeCloseTo(1, 12);
    expect(linearToSrgb(0)).toBe(0);
    expect(linearToSrgb(1)).toBeCloseTo(1, 12);
  });

  it('单调递增（调色的曲线求值依赖这一条）', () => {
    let prev = -1;
    for (let i = 0; i <= 1024; i += 1) {
      const v = srgbToLinear(i / 1024);
      expect(v, `toLinear 在 ${i / 1024} 处回头了`).toBeGreaterThan(prev);
      prev = v;
    }
  });

  it('编码 → 解码 → 编码的往返误差 < 1/1024（0..1 全量）', () => {
    let worst = 0;
    let at = 0;
    for (let i = 0; i <= 1024; i += 1) {
      const v = i / 1024;
      const back = linearToSrgb(srgbToLinear(v));
      const err = Math.abs(back - v);
      if (err > worst) {
        worst = err;
        at = v;
      }
    }
    expect(worst, `最大误差在 ${at.toFixed(4)}，实测 ${worst.toExponential(2)}`).toBeLessThan(1 / 1024);
  });

  it('负值不产生 NaN（lift 会给出负数，pow 吃到负数就是 NaN）', () => {
    for (const v of [-1, -0.001, -1e-9]) {
      expect(Number.isFinite(srgbToLinear(v))).toBe(true);
      expect(Number.isFinite(linearToSrgb(v))).toBe(true);
      expect(srgbToLinear(v)).toBe(0);
      expect(linearToSrgb(v)).toBe(0);
    }
  });

  it('线性域允许 >1（16F 的高光要留给后面的模块）', () => {
    expect(linearToSrgb(4)).toBeGreaterThan(1);
  });
});

describe('sRGB 传输函数：GLSL 与 TS 同一套常数', () => {
  it('GLSL 里出现的每个常数都来自 `SRGB_TRANSFER`', () => {
    const literals = [
      SRGB_TRANSFER.slope,
      SRGB_TRANSFER.offset,
      SRGB_TRANSFER.scale,
      SRGB_TRANSFER.gamma,
      SRGB_TRANSFER.encodeBreak,
      SRGB_TRANSFER.linearBreak,
      1 / SRGB_TRANSFER.gamma,
    ];
    const missing = literals.filter((n) => !TRANSFER_GLSL.includes(String(n)));
    expect(missing, '这些常数没有被拼进 GLSL —— TS 与 GLSL 已经漂了').toEqual([]);
  });

  it('拼出来的 GLSL 里没有 NaN / Infinity（除零或常数写错时会漏进去）', () => {
    for (const bad of ['NaN', 'Infinity', 'undefined']) {
      expect(TRANSFER_GLSL, `GLSL 里出现了 ${bad}`).not.toContain(bad);
    }
  });

  it('共享头带着这两个函数（不然调色 def 会各自 import 一份）', () => {
    expect(EFFECT_HEAD).toContain('vec3 toLinear(vec3 c)');
    expect(EFFECT_HEAD).toContain('vec3 toSrgb(vec3 c)');
  });
});
