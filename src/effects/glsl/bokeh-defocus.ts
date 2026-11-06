import { BLUR_H_PASS, BLUR_V_PASS, compose, floats, type EffectShaderDef } from '../shader-def';

/**
 * 失焦散光：整幅去细节 → 孤立亮部**摊成圆盘**（不是糊成光晕）。
 *
 * 与 `glow` 的区别有三条，缺一条就不像散景：
 * 1. **圆盘权重是平的**。辉光按高斯加权，亮部泛出一圈渐隐的光晕；焦外光斑是
 *    「一个点光源被镜头摊成一个同亮的圆盘」，边缘几乎是硬的。所以这里对每个
 *    输出像素取圆盘内**最亮**的那个抽样，而不是取平均 —— 平均会把能量摊成
 *    渐变，那正是「看起来像辉光」的原因。
 * 2. **只认孤立亮部**（top-hat）。只按「比阈值亮」筛的话，大片亮区（天空、
 *    白底、亮色块）会整块参与，取最大就把整幅画铺成白 —— 而真实焦外的圆盘
 *    来自**比周围亮**的小光源。所以权重再乘一项「比同一位置的模糊值亮多少」：
 *    大片亮区 `峰值 ≈ 局部峰值 ⇒ 权重 0`，小光源 `峰值 ≫ 局部峰值 ⇒ 权重 1`。
 * 3. **光斑顶掉失焦底，不叠加**。散景是把光源的能量重新分配到圆盘上，不是往
 *    画面里再灌一份；相加会在密集亮部上直接冲成白屏。
 *
 * 三联 pass 的理由：
 * - 前两级高斯（横 / 纵）既是「景深之外」的那一层，也正好是 top-hat 需要的
 *   **局部均值**。它的半径由 `bokeh` 派生（见 `setUniforms`）。
 * - 圆盘 pass 从**未糊的链输入**（`u_original`）取颜色：糊过的图上亮部峰值已被
 *   摊平，光斑会整批变暗。
 *
 * 两条口径：
 * - **阈值与 top-hat 都按「最大通道」判**（不是 luma）：饱和光源（红 / 蓝）
 *   luma 很低，按 luma 判会被整体漏掉，而那些恰恰是散景里最显眼的圆盘。
 * - **pre-pass 跑在半分辨率浮点草稿上，`u_resolution` 仍传全分辨率**：所以
 *   `bokeh`（像素）在预览与导出里是同一个空间半径，降采样只降低 tap 密度。
 */
export const shader: EffectShaderDef = {
  prePasses: [
    { fragment: BLUR_H_PASS, linearFilter: true },
    { fragment: BLUR_V_PASS, linearFilter: true },
    {
      fragment: `
uniform float u_threshold;
uniform float u_bokeh;
uniform float u_gain;
float peak(vec3 c) { return max(c.r, max(c.g, c.b)); }
void main() {
  vec4 base = texture(u_texture, vUv);
  vec2 px = 1.0 / u_resolution;

  // 圆盘内取最亮的一个抽样（不是平均）。颜色取锐利的那份，光斑才带着光源的色。
  vec3 best = vec3(0.0);
  float bestW = 0.0;
  for (int i = 0; i < 40; i++) {
    float a = float(i) * 2.399963;
    float rr = u_bokeh * sqrt((float(i) + 0.5) / 40.0);
    vec2 at = clamp(vUv + vec2(cos(a), sin(a)) * rr * px, 0.0, 1.0);
    vec3 sharp = texture(u_original, at).rgb;
    vec3 soft = texture(u_texture, at).rgb;
    float hi = peak(sharp);
    float lo = peak(soft);
    /*
     * 形状取**糊过的那份**，隔离性取**锐利的那份**，两者分工是刻意的：
     * - 锐利样本的边缘是硬的，40 个硬圆盘取并集会在边上咬出一圈花瓣；
     *   糊过的那份边缘有 ~10px 的过渡，并集才是圆的。
     * - 但糊会让亮部峰值掉下来（小光源尤其），若直接拿用户阈值去卡它，
     *   中等大小的光源会整批消失 —— 所以这里的门槛压到 0.55 倍。
     * - 「是不是孤立亮部」必须看锐利减模糊：大片亮区两者相等 ⇒ 权重 0。
     */
    float shape = clamp((lo - u_threshold * 0.55) * 3.0, 0.0, 1.0);
    float isolated = clamp((hi - lo) * 4.0, 0.0, 1.0);
    float w = shape * isolated;
    if (w > bestW) {
      bestW = w;
      best = sharp;
    }
  }

  // 0.25 的软门限：权重很低的抽样（大片亮区的边缘）不参与，免得叠出一层灰雾。
  vec3 discs = best * smoothstep(0.0, 0.25, bestW) * u_gain;
  vec3 col = peak(discs) > peak(base.rgb) ? discs : base.rgb;
  outColor = vec4(col, base.a);
}`,
      linearFilter: true,
    },
    {
      /*
       * 圆盘边缘的软化（横 / 纵两环，可分离）。
       *
       * 「取最大」是在 40 个固定抽样上做的，圆盘边界因此是这些抽样位置的外包络 ——
       * 逐像素看是一圈花瓣而不是圆。这是 max 的固有形状，只能靠磨边。
       * **必须可分离**：用 8 个环形抽样做一次平均反而会自己长出 8 瓣
       * （那正是第一版磨完还像齿轮的原因）。
       * 半径取 `bokeh` 的 0.3 倍 —— 与抽样间距同量级，正好把波峰抹平。
       * 它顺带把失焦底再糊一点，无害（那一层本来就是糊的）。
       */
      fragment: `
uniform float u_bokeh;
void main() {
  vec2 px = 1.0 / u_resolution;
  float r = max(u_bokeh * 0.3, 1.0);
  vec4 c = texture(u_texture, vUv);
  vec3 sum = c.rgb;
  float wsum = 1.0;
  for (int i = 1; i <= 6; i++) {
    float o = r * float(i) / 6.0;
    float w = 1.0 - float(i) / 7.0;
    sum += texture(u_texture, clamp(vUv + vec2(o * px.x, 0.0), 0.0, 1.0)).rgb * w;
    sum += texture(u_texture, clamp(vUv - vec2(o * px.x, 0.0), 0.0, 1.0)).rgb * w;
    wsum += 2.0 * w;
  }
  outColor = vec4(sum / wsum, c.a);
}`,
      linearFilter: true,
    },
    {
      fragment: `
uniform float u_bokeh;
void main() {
  vec2 px = 1.0 / u_resolution;
  float r = max(u_bokeh * 0.3, 1.0);
  vec4 c = texture(u_texture, vUv);
  vec3 sum = c.rgb;
  float wsum = 1.0;
  for (int i = 1; i <= 6; i++) {
    float o = r * float(i) / 6.0;
    float w = 1.0 - float(i) / 7.0;
    sum += texture(u_texture, clamp(vUv + vec2(0.0, o * px.y), 0.0, 1.0)).rgb * w;
    sum += texture(u_texture, clamp(vUv - vec2(0.0, o * px.y), 0.0, 1.0)).rgb * w;
    wsum += 2.0 * w;
  }
  outColor = vec4(sum / wsum, c.a);
}`,
      linearFilter: true,
    },
  ],
  fragment: `
uniform float u_amount;
void main() {
  vec4 src = texture(u_original, vUv);
  vec3 defocus = texture(u_texture, vUv).rgb;
  outColor = vec4(mix(src.rgb, defocus, clamp(u_amount, 0.0, 1.0)), src.a);
}`,
  setUniforms: compose(floats('threshold', 'bokeh', 'gain', 'amount'), (gl, l, v) => {
    /*
     * 去细节半径由光斑半径派生（0.3 倍）：两者脱钩时，光斑大而图没糊会显得
     * 光斑「浮在清晰的画面上」，糊得过头又会把亮部峰值摊到阈值以下、光斑消失。
     * 这个 0.3 是「让 40 tap 铺得满」与「别把光源摊没」之间的折中。
     */
    const loc = l['u_radius'];
    if (loc) gl.uniform1f(loc, Math.max(0.5, (Number(v.bokeh) || 0) * 0.3));
  }),
};
