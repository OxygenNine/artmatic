import { floats, MATH_GLSL, type EffectShaderDef } from '../shader-def';

/**
 * 万花筒：极坐标扇区折叠后按 `bounce` 折回画面。
 * 移植自 openmosh `gl/effect-shaders.ts` 的 `kaleido`（MIT，见 CREDITS.md）。
 * 是**静态**特效（不读 u_time）。
 *
 * ## `circle`（圆形对称）
 *
 * 极坐标的度量决定折叠出来的对称是什么形状：直接按 `vUv` 取 `length` / `atan`，
 * 等半径在屏幕上是**随画幅拉长的椭圆**（16:9 下横向是纵向的 1.78 倍），
 * 宽画面上一眼就能看出「歪的万花筒」。
 *
 * 所以把 `vUv - 0.5` 的 x 乘上画幅比、在**等比空间**里算 `r` / 角度，折完再除
 * 回去 —— 等半径于是是正圆、扇区边界是真角度。半径本身没被改，`sides` 取大
 * 仍然退化成原图（恒等）。除回去是必须的：不除的话取景会被拉伸两次，
 * `amount = 0` 附近的边缘也会和 `vUv` 对不上。
 */
export const shader: EffectShaderDef = {
  fragment: `
uniform float u_amount;
uniform float u_sides;
uniform float u_angle;
uniform float u_circle;
${MATH_GLSL}
void main() {
  // 画幅比只作用在 x 上：1 单位 = 半个画面高
  float aspect = u_resolution.x / max(u_resolution.y, 1.0);
  vec2 asp = vec2(mix(1.0, aspect, u_circle), 1.0);
  vec2 p = (vUv - 0.5) * asp;
  float r = length(p);
  float a = atan(p.y, p.x) + u_angle * 0.01745329;
  float seg = 6.28318530 / u_sides;
  a = mod(a, seg);
  a = abs(a - seg * 0.5);
  vec2 kUV = vec2(cos(a), sin(a)) * (r / asp) + 0.5;
  kUV = vec2(bounce(kUV.x), bounce(kUV.y));
  outColor = mix(texture(u_texture, vUv), texture(u_texture, kUV), u_amount);
}`,
  setUniforms: floats('amount', 'sides', 'angle', 'circle'),
};
