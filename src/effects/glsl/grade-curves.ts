import { TONE_CURVE_WIDTH } from '../../core/tone-curve';
import type { EffectShaderDef } from '../shader-def';

/**
 * `grade-curves` — 色调曲线：主 / R / G / B 四张表，线性域。
 *
 * ## 表不是参数
 *
 * 四条曲线存在 `values['curve#master' | 'curve#r' | 'curve#g' | 'curve#b']` 里
 * （紧凑串，见 `core/tone-curve.ts`），**没有**对应的 `ParamDef` —— 检查器里
 * 一行一个滑杆表达不了曲线，而它们也不该被当成「参数」逐个打关键帧。
 * 协议这边只声明「我要一张曲线表」，由 `ctx.curves` 绑（与 `u_atlas` 同一形态）。
 *
 * ## 采样方式：无过滤的精确取值
 *
 * 表是 1024×4 的 R16F，x 用 `(x·(W-1) + 0.5)/W` 映射到纹素中心。少这一半
 * 纹素会在两端各欠半个采样 —— 「最黑那一点压不到 0」就是这么来的。
 *
 * ## 顺序：先通道曲线，再主曲线
 *
 * 与调色台一致：R/G/B 修正偏色，主曲线做整体反差。反过来（先主后通道）
 * 会让「先拉整体对比再修偏色」的两次操作互相影响，用户得来回调。
 */
export const shader: EffectShaderDef = {
  fragment: `
uniform sampler2D u_curve;

const float CURVE_W = ${TONE_CURVE_WIDTH}.0;
const float CURVE_ROWS = 4.0;

/* row: 0 = 主, 1 = R, 2 = G, 3 = B（与 engine/curve-texture.ts 的行序一致） */
float curveAt(float v, float row) {
  float u = (clamp(v, 0.0, 1.0) * (CURVE_W - 1.0) + 0.5) / CURVE_W;
  return texture(u_curve, vec2(u, (row + 0.5) / CURVE_ROWS)).r;
}

void main() {
  vec4 texel = texture(u_texture, vUv);
  vec3 x = toLinear(texel.rgb);

  // 通道曲线
  x = vec3(curveAt(x.r, 1.0), curveAt(x.g, 2.0), curveAt(x.b, 3.0));
  // 主曲线
  x = vec3(curveAt(x.r, 0.0), curveAt(x.g, 0.0), curveAt(x.b, 0.0));

  outColor = vec4(toSrgb(x), texel.a);
}`,
  curveTable: (values) => ({
    master: String(values['curve#master'] ?? ''),
    r: String(values['curve#r'] ?? ''),
    g: String(values['curve#g'] ?? ''),
    b: String(values['curve#b'] ?? ''),
  }),
  setUniforms: () => {
    /* 没有标量参数：四条表由 u_curve 承载。 */
  },
};
