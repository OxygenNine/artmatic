import type { EffectShaderDef } from '../shader-def';

/**
 * `grade-lut` — 3D 查找表（`.cube`）。
 *
 * ## 输入空间是这个模块唯一容易做错的地方
 *
 * 免费 LUT 绝大多数是按 **sRGB 或 Log-C 素材**调的（作者在达芬奇里挂上去看效果
 * 调），而不是按线性光。把线性值直接塞进这样的表，结果就是「整体发灰或压死」——
 * 这是「LUT 看着不对」的第一原因，而它看起来像 LUT 本身坏了。
 *
 * 所以 `space` 是**必填**的语义：先把岛的线性值编到 LUT 期望的空间，查表，
 * 再把结果解回线性。默认 sRGB（占比最高）。
 *
 * ## 没有 LUT / 读取失败 → `u_lutOn = 0`
 *
 * 此时整段跳过，画面原样通过。绑一张恒等表也能得到同样结果，但那样
 * 「没载入」和「载入了」在画面上分不出来；显式的开关让面板能说清状态。
 *
 * ## 输出不夹上界
 *
 * LUT 表里的值可能到 1.0，转回线性后就是 1.0；再往后的模块（曲线、模糊）
 * 还能用 >1 的高光。夹上界由最后写 8 位目标时硬件负责。
 */
export const shader: EffectShaderDef = {
  fragment: `
// GLSL ES 3.00 里 sampler3D **没有默认精度**（sampler2D 有 lowp 默认值），
// 不写 highp 就是编译期硬失败：'sampler3D' : No precision specified。
uniform highp sampler3D u_lut;
uniform float u_lutOn;
uniform float u_lutSize;
uniform float u_space;

/* ARRI LogC3 (EI800)。常数来自官方曲线，与 ACES 的 IDT 一致。 */
vec3 logCEncode(vec3 x) {
  x = max(x, vec3(0.0));
  vec3 hi = log(x * 5.555556 + 0.052272) / log(10.0) * 0.247190 + 0.385537;
  vec3 lo = x * 5.367655 + 0.092809;
  return mix(lo, hi, step(vec3(0.010591), x));
}
vec3 logCDecode(vec3 v) {
  v = max(v, vec3(0.0));
  vec3 hi = (pow(vec3(10.0), (v - 0.385537) / 0.247190) - 0.052272) / 5.555556;
  vec3 lo = (v - 0.092809) / 5.367655;
  return mix(lo, hi, step(vec3(0.1496582), v));
}

vec3 toLutSpace(vec3 lin) {
  if (u_space < 0.5) return toSrgb(lin);
  if (u_space < 1.5) return lin;
  return logCEncode(lin);
}
vec3 fromLutSpace(vec3 v) {
  if (u_space < 0.5) return toLinear(v);
  if (u_space < 1.5) return v;
  return logCDecode(v);
}

void main() {
  vec4 texel = texture(u_texture, vUv);
  vec3 x = toLinear(texel.rgb);

  if (u_lutOn > 0.5) {
    vec3 q = clamp(toLutSpace(x), 0.0, 1.0);
    x = fromLutSpace(texture(u_lut, q).rgb);
  }

  outColor = vec4(toSrgb(x), texel.a);
}`,
  /**
   * 与其它调色模块同一形态：`u_lut` 由 `ctx.luts` 绑（声明了就绑）。
   * 素材 id 存在 `values['lutAssetId']`，没有对应的 `ParamDef`（那一行要选文件，
   * 不是滑杆）。
   */
  lut: (values) => {
    const id = values['lutAssetId'];
    return typeof id === 'string' && id ? id : null;
  },
  setUniforms: (gl, locs, values) => {
    const on = locs['u_lutOn'];
    // `u_lutOn` / `u_space` 的**实际值**由 lut 服务与参数共同决定：
    // 这里只派发 space（0 sRGB / 1 线性 / 2 Log-C），`u_lutOn` 留给 bindTo。
    if (on) gl.uniform1f(on, 0);
    const space = locs['u_space'];
    if (space) {
      const v = String(values.space ?? 'srgb');
      gl.uniform1f(space, v === 'linear' ? 1 : v === 'logc' ? 2 : 0);
    }
  },
};
