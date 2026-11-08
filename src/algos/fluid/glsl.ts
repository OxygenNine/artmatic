/**
 * glsl.ts — 流体内核的着色器。
 *
 * 移植的是 **PavelDoGreat/WebGL-Fluid-Simulation 的那套 pass 链**
 * （advection / divergence / pressure Jacobi / gradient subtract / curl /
 * vorticity），但**不是逐字抄的**：上游是 demo 形态（自带 rAF、鼠标事件、
 * 画布尺寸即模拟域），这里全部重写成「按步推进、由参数与 mask 注入、
 * 域是固定 16:9」的形态。做法参照登记在 `CREDITS.md` §2。
 *
 * ## 状态布局
 *
 * 全部是 RGBA16F（`Target` 的 `float: true`，带 LINEAR 过滤）：
 *   velocity  = (vx, vy, 0, 1)  单位 **texel/秒**（域内 texel 是正方形）
 *   dye       = (r, g, b, 1)
 *   pressure  = (p, 0, 0, 1)
 *   divergence= (d, 0, 0, 1)
 *   curl      = (c, 0, 0, 1)
 *
 * ⚠️ **不能用 RGBA32F**：`engine/kit.ts` 对 32F 强制 NEAREST（32F 的线性
 * 过滤要 `OES_texture_float_linear`），而 advection 必须线性采样 ——
 * 用 NEAREST 时整幅会碎成 texel 方块，看起来像分辨率掉了一半。
 *
 * ## 确定性
 *
 * 所有 pass 只读上一次的纹理、不读刚写好的那份（ping-pong 严格交替），
 * 且没有任何随机源（喷嘴轨迹由 JS 侧按步号算出）。于是
 * `seek(f) ≡ 从 0 顺序 step f 次`（硬约束 1.3）。
 */

/** pass 清单。名字是 `Kit.quad` 的缓存键，`compile-all` 与引擎必须同源。 */
export type FluidProgramPart =
  | 'advect'
  | 'curl'
  | 'vorticity'
  | 'divergence'
  | 'pressure'
  | 'gradient'
  | 'splat-velocity'
  | 'splat-dye'
  | 'display';

export function fluidProgramName(id: string, part: FluidProgramPart): string {
  return `fluid-${id}-${part}`;
}

/** 模拟 pass 的公共头。`u_texelSize` 一律是**模拟纹理**的 1/w、1/h。 */
const SIM_HEAD = `#version 300 es
precision highp float;
precision highp int;
in vec2 vUv;
out vec4 outColor;
uniform vec2 u_texelSize;
uniform float u_dt;
`;

/**
 * 半拉格朗日平流。`u_velocity` 与 `u_tex` 可以是同一张（速度场自平流）
 * 也可以是两张（染料被速度场带走）—— 调用方保证写的是另一侧。
 */
export const ADVECT_FRAG = SIM_HEAD + `
uniform sampler2D u_tex;
uniform sampler2D u_velocity;
uniform float u_dissipation;
void main() {
  vec2 coord = vUv - u_dt * texture(u_velocity, vUv).xy * u_texelSize;
  outColor = u_dissipation * texture(u_tex, coord);
}`;

/** 涡量（标量，z 分量）。边界用 CLAMP_TO_EDGE，与流体边界条件一致。 */
export const CURL_FRAG = SIM_HEAD + `
uniform sampler2D u_velocity;
void main() {
  float L = texture(u_velocity, vUv - vec2(u_texelSize.x, 0.0)).y;
  float R = texture(u_velocity, vUv + vec2(u_texelSize.x, 0.0)).y;
  float B = texture(u_velocity, vUv - vec2(0.0, u_texelSize.y)).x;
  float T = texture(u_velocity, vUv + vec2(0.0, u_texelSize.y)).x;
  outColor = vec4(0.5 * (R - L - T + B), 0.0, 0.0, 1.0);
}`;

/**
 * 涡量约束：沿涡量的梯度把能量补回小尺度，抵消数值耗散。
 *
 * `force.y *= -1.0` 不是笔误 —— 它是上游把「屏幕 y 向下」翻成
 * 「纹理 y 向上」的那一处。去掉之后涡旋会朝反方向拧，细丝会散成棉花。
 */
export const VORTICITY_FRAG = SIM_HEAD + `
uniform sampler2D u_velocity;
uniform sampler2D u_curl;
uniform float u_curlStrength;
void main() {
  float L = texture(u_curl, vUv - vec2(u_texelSize.x, 0.0)).x;
  float R = texture(u_curl, vUv + vec2(u_texelSize.x, 0.0)).x;
  float B = texture(u_curl, vUv - vec2(0.0, u_texelSize.y)).x;
  float T = texture(u_curl, vUv + vec2(0.0, u_texelSize.y)).x;
  float C = texture(u_curl, vUv).x;
  vec2 force = 0.5 * vec2(abs(T) - abs(B), abs(R) - abs(L));
  force /= length(force) + 0.0001;
  force *= u_curlStrength * C;
  force.y *= -1.0;
  vec2 vel = texture(u_velocity, vUv).xy + force * u_dt;
  outColor = vec4(vel, 0.0, 1.0);
}`;

/**
 * 散度。**边界那一圈要把外侧速度取反**（`L = -C.x` 等）：不这么做时
 * 域边界上会算出一个虚假的散度，压力解把它推成一股贴着边框的回流 ——
 * 画面四周出现一圈永远在转的细边，而中间完全正常。
 */
export const DIVERGENCE_FRAG = SIM_HEAD + `
uniform sampler2D u_velocity;
void main() {
  float L = texture(u_velocity, vUv - vec2(u_texelSize.x, 0.0)).x;
  float R = texture(u_velocity, vUv + vec2(u_texelSize.x, 0.0)).x;
  float B = texture(u_velocity, vUv - vec2(0.0, u_texelSize.y)).y;
  float T = texture(u_velocity, vUv + vec2(0.0, u_texelSize.y)).y;
  vec2 C = texture(u_velocity, vUv).xy;
  if (vUv.x - u_texelSize.x < 0.0) { L = -C.x; }
  if (vUv.x + u_texelSize.x > 1.0) { R = -C.x; }
  if (vUv.y - u_texelSize.y < 0.0) { B = -C.y; }
  if (vUv.y + u_texelSize.y > 1.0) { T = -C.y; }
  outColor = vec4(0.5 * (R - L + T - B), 0.0, 0.0, 1.0);
}`;

/** Jacobi 迭代一步。迭代次数是参数（`pressureIter`），**不是**常数。 */
export const PRESSURE_FRAG = SIM_HEAD + `
uniform sampler2D u_pressure;
uniform sampler2D u_divergence;
void main() {
  float L = texture(u_pressure, vUv - vec2(u_texelSize.x, 0.0)).x;
  float R = texture(u_pressure, vUv + vec2(u_texelSize.x, 0.0)).x;
  float B = texture(u_pressure, vUv - vec2(0.0, u_texelSize.y)).x;
  float T = texture(u_pressure, vUv + vec2(0.0, u_texelSize.y)).x;
  float div = texture(u_divergence, vUv).x;
  outColor = vec4((L + R + B + T - div) * 0.25, 0.0, 0.0, 1.0);
}`;

/** 减去压力梯度 ⇒ 无散度速度场。 */
export const GRADIENT_FRAG = SIM_HEAD + `
uniform sampler2D u_pressure;
uniform sampler2D u_velocity;
void main() {
  float L = texture(u_pressure, vUv - vec2(u_texelSize.x, 0.0)).x;
  float R = texture(u_pressure, vUv + vec2(u_texelSize.x, 0.0)).x;
  float B = texture(u_pressure, vUv - vec2(0.0, u_texelSize.y)).x;
  float T = texture(u_pressure, vUv + vec2(0.0, u_texelSize.y)).x;
  vec2 vel = texture(u_velocity, vUv).xy - vec2(R - L, T - B);
  outColor = vec4(vel, 0.0, 1.0);
}`;

/* --------------------------------------------------------------- 注入 */

/**
 * 喷嘴参数。**四个具名 `vec4` + if 链**，不是数组：
 * GLSL ES 3.00 的实践里对 uniform 数组做**动态下标**在部分驱动上会被拒，
 * 而这条链是「一个喷嘴一次采样」，写成循环也省不下什么。
 *
 * `u_jetP{n}` = (x, y, 色相, 染料量)；`u_jetV{n}` = (vx, vy, 0, 0)，texel/秒。
 * `u_jetCount` 之外的槽位必须由 JS 侧**填 0**（位置无关，量 0 就没有贡献）。
 */
const JET_GLSL = `
uniform vec4 u_jetP0;
uniform vec4 u_jetP1;
uniform vec4 u_jetP2;
uniform vec4 u_jetP3;
uniform vec4 u_jetV0;
uniform vec4 u_jetV1;
uniform vec4 u_jetV2;
uniform vec4 u_jetV3;
uniform int u_jetCount;
uniform float u_jetRadius;
uniform float u_domainAspect;
uniform sampler2D u_mask;
uniform int u_maskOn;
uniform int u_maskChannel;
uniform float u_maskThreshold;

/** 屏幕等距的高斯权重：x 先乘域宽高比，注入点在屏上是圆的而不是椭圆。 */
float jetMask(vec2 uv, vec4 j) {
  vec2 p = uv - j.xy;
  p.x *= u_domainAspect;
  return exp(-dot(p, p) / max(1e-6, u_jetRadius * u_jetRadius));
}

/** 素材蒙版。未绑定时恒 1（不改变行为），阈值以下完全挡住。 */
float jetMaskAsset(vec2 uv) {
  if (u_maskOn == 0) return 1.0;
  vec4 c = texture(u_mask, clamp(uv, 0.0, 1.0));
  float d = u_maskChannel == 0 ? dot(c.rgb, vec3(0.2126, 0.7152, 0.0722)) : c.a;
  return smoothstep(u_maskThreshold, min(1.0, u_maskThreshold + 0.08), d);
}
`;

/** 注速度：把 `u_jetV*` 按高斯权重叠到速度场上。 */
export const SPLAT_VELOCITY_FRAG = `#version 300 es
precision highp float;
precision highp int;
in vec2 vUv;
out vec4 outColor;
uniform sampler2D u_tex;
${JET_GLSL}
void main() {
  vec2 v = texture(u_tex, vUv).xy;
  float m = jetMaskAsset(vUv);
  if (u_jetCount > 0) { v += u_jetV0.xy * (jetMask(vUv, u_jetP0) * m); }
  if (u_jetCount > 1) { v += u_jetV1.xy * (jetMask(vUv, u_jetP1) * m); }
  if (u_jetCount > 2) { v += u_jetV2.xy * (jetMask(vUv, u_jetP2) * m); }
  if (u_jetCount > 3) { v += u_jetV3.xy * (jetMask(vUv, u_jetP3) * m); }
  outColor = vec4(v, 0.0, 1.0);
}`;

/** 注染料：按喷嘴色相加色叠加。色相 → RGB 在 shader 里算（`hue` 是 uniform）。 */
export const SPLAT_DYE_FRAG = `#version 300 es
precision highp float;
precision highp int;
in vec2 vUv;
out vec4 outColor;
uniform sampler2D u_tex;
uniform float u_jetSaturation;
uniform float u_jetBrightness;
${JET_GLSL}

vec3 hsv2rgb(float h, float s) {
  vec3 k = clamp(abs(mod(h * 6.0 + vec3(0.0, 4.0, 2.0), 6.0) - 3.0) - 1.0, 0.0, 1.0);
  return mix(vec3(1.0), k, s);
}

vec3 jetDye(vec2 uv, vec4 p) {
  float w = jetMask(uv, p) * p.w;
  return hsv2rgb(fract(p.z), u_jetSaturation) * w;
}

void main() {
  vec3 c = texture(u_tex, vUv).rgb;
  float m = jetMaskAsset(vUv) * u_jetBrightness;
  if (u_jetCount > 0) { c += jetDye(vUv, u_jetP0) * m; }
  if (u_jetCount > 1) { c += jetDye(vUv, u_jetP1) * m; }
  if (u_jetCount > 2) { c += jetDye(vUv, u_jetP2) * m; }
  if (u_jetCount > 3) { c += jetDye(vUv, u_jetP3) * m; }
  outColor = vec4(c, 1.0);
}`;

/* --------------------------------------------------------------- 显示 */

/**
 * 出图。
 *
 * 三件事：
 *   1. **cover 映射**（`u_outAspect` vs `u_domainAspect`）：铺满输出、裁切、
 *      **不拉伸**。模拟域恒 16:9，输出是竖屏时横向裁掉两侧 —— 比留黑边或
 *      把涡旋压扁都好。
 *   2. **伪 3D 明暗**（`u_shading`）：用 dye 亮度的横向/纵向差分当法线，
 *      `dot(n, +z)` 当漫反射。这正是上游那条 SHADING 分支，视觉上是
 *      「墨流有厚度」的唯一来源。
 *   3. **色调修饰**：`u_glow`（自发光抬亮部）、`u_hueShift`（整体转色相）、
 *      `u_contrast`。它们都不进模拟，所以改它们不重放。
 *
 * 透明底吐「墨色 + 覆盖度」（直通 alpha），纯色底混 `u_colorBg` ——
 * 与 `algos/AGENTS.md` 的「透明背景」一节同一口径。
 */
export const DISPLAY_FRAG = `#version 300 es
precision highp float;
precision highp int;
in vec2 vUv;
out vec4 outColor;
uniform sampler2D u_dye;
uniform vec2 u_dyeTexel;
uniform float u_domainAspect;
uniform float u_outAspect;
uniform float u_shading;
uniform float u_glow;
uniform float u_hueShift;
uniform float u_contrast;
uniform int u_bgMode;
uniform vec3 u_colorBg;

vec3 hueRotate(vec3 c, float a) {
  // 绕亮度轴的旋转（YIQ 空间），比 RGB↔HSV 往返便宜且不会在灰处跳变。
  const vec3 k = vec3(0.57735);
  float ca = cos(a);
  return c * ca + cross(k, c) * sin(a) + k * dot(k, c) * (1.0 - ca);
}

void main() {
  vec2 uv = vUv - 0.5;
  if (u_outAspect > u_domainAspect) uv.y *= u_domainAspect / u_outAspect;
  else uv.x *= u_outAspect / u_domainAspect;
  uv += 0.5;

  vec3 c = texture(u_dye, uv).rgb;
  if (u_shading > 0.0) {
    vec3 lc = texture(u_dye, uv - vec2(u_dyeTexel.x, 0.0)).rgb;
    vec3 rc = texture(u_dye, uv + vec2(u_dyeTexel.x, 0.0)).rgb;
    vec3 bc = texture(u_dye, uv - vec2(0.0, u_dyeTexel.y)).rgb;
    vec3 tc = texture(u_dye, uv + vec2(0.0, u_dyeTexel.y)).rgb;
    float dx = length(rc) - length(lc);
    float dy = length(tc) - length(bc);
    vec3 n = normalize(vec3(dx, dy, length(u_dyeTexel)));
    float diffuse = clamp(dot(n, vec3(0.0, 0.0, 1.0)) + 0.7, 0.7, 1.0);
    c *= mix(1.0, diffuse, u_shading);
  }

  c = max(c, 0.0) * u_contrast;
  // 自发光：只抬亮部，暗部保持干净 —— 全幅一起乘会得到一层洗不掉的灰雾。
  float luma = dot(c, vec3(0.2126, 0.7152, 0.0722));
  c += c * (u_glow * smoothstep(0.15, 0.85, luma));
  if (abs(u_hueShift) > 1e-4) c = max(hueRotate(c, u_hueShift * 6.2831853), 0.0);

  float a = clamp(max(c.r, max(c.g, c.b)), 0.0, 1.0);
  if (u_bgMode == 1) outColor = vec4(min(c, vec3(1.0)), a);
  else outColor = vec4(mix(u_colorBg, min(c, vec3(1.0)), a), 1.0);
}`;

/** 出厂的那一套（`compile-all` 与引擎共用，不各写一份清单）。 */
export const FLUID_SHADERS: Record<FluidProgramPart, string> = {
  advect: ADVECT_FRAG,
  curl: CURL_FRAG,
  vorticity: VORTICITY_FRAG,
  divergence: DIVERGENCE_FRAG,
  pressure: PRESSURE_FRAG,
  gradient: GRADIENT_FRAG,
  'splat-velocity': SPLAT_VELOCITY_FRAG,
  'splat-dye': SPLAT_DYE_FRAG,
  display: DISPLAY_FRAG,
};
