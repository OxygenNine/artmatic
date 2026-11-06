import {
  clockUniforms,
  CLOCK_GLSL,
  compose,
  floats,
  HASH_FAST_GLSL,
  type EffectShaderDef,
} from '../shader-def';

/**
 * 节奏律动：每拍闪白 + 抖一下，衰减到下一拍前归零。
 *
 * 两条不能破的口径：
 *
 * 1. **相位是闭式的**（`clockPhase`），不累加。openmosh 里这类特效的 `u_time`
 *    是 `phase += dt * speed` 攒出来的，那是 dt 驱动的有状态量 —— 与硬约束 1.1
 *    冲突，seek 不可复现。这里相位 = `t × speed` 或 `拍相位 × division`。
 * 2. **震动走 uv 偏移，不走层 transform**。层 transform 会把层的边缘挪出去
 *    （透明素材上直接露底），uv 偏移是在画面内部取，边界用镜像折回来。
 *
 * 抖动方向按**拍号**取（`floor(phase)`），不掺 `u_seed`：逐帧换方向是噪声，
 * 逐拍换方向才是节奏，而且同一拍在预览与导出里必须是同一个方向。
 */
export const shader: EffectShaderDef = {
  fragment: `
uniform float u_amount;
uniform float u_decay;
uniform float u_shake;
uniform float u_offset;
uniform float u_sync;
uniform float u_speed;
uniform float u_division;
uniform float u_beat;
${CLOCK_GLSL}
${HASH_FAST_GLSL}

/*
 * 镜像折返。用镜像而不是 clamp：clamp 会在边上把一行像素拉成整幅宽
 * （看起来像画框坏了）；镜像只是把挪出去的部分折回来，与画面自身对称。
 */
vec2 mirrorUV(vec2 uv) {
  return 1.0 - abs(1.0 - mod(uv, 2.0));
}

void main() {
  float phase = clockPhase(u_time, u_sync, u_speed, u_division, u_beat) + u_offset;
  // 一拍的开头是 1，线性（或按 decay 加速）衰减到 0 —— 下一拍自然接上。
  float pulse = pow(1.0 - fract(phase), max(u_decay, 0.05));

  // 拍号折回 4096（120 BPM 约 34 分钟）：让它始终落在 hash 的有效精度里，
  // 否则长工程的抖动方向会退化成常数。
  float beat = mod(floor(phase), 4096.0);
  vec2 dir = vec2(hash11(beat * 1.7 + 3.1), hash11(beat * 5.3 + 7.7)) * 2.0 - 1.0;
  // 位移用 pulse² —— 抖动要比闪白收得更快，否则整拍都在晃，读不出「打击」。
  vec2 off = dir * u_shake * pulse * pulse / u_resolution;

  vec4 c = texture(u_texture, mirrorUV(vUv + off));
  outColor = vec4(mix(c.rgb, vec3(1.0), clamp(u_amount * pulse, 0.0, 1.0)), c.a);
}`,
  setUniforms: compose(floats('amount', 'decay', 'shake', 'offset'), clockUniforms()),
};
