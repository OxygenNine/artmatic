import { compose, floats, HSV_GLSL, HUE_ROTATE_GLSL, type EffectShaderDef } from '../shader-def';

/**
 * `grade-qualifier` — 按色相 / 饱和度 / 亮度选一块区域，只在这块上做校正。
 *
 * ## 键算在**编码域**，校正算在**线性域**
 *
 * 这是这个模块唯一容易写反的地方。键（`rgb2hsv` + 亮度）读的是 `texel.rgb`，
 * 也就是用户屏幕上看到的那个颜色 —— 用户是从画面上挑一个色相的，键就必须在
 * 同一个空间里判。校正走 `toLinear` → 运算 → `toSrgb` 的线性岛（与
 * `grade-basic` 同一条规则，`tests/unit/grade-island.test.ts` 守着「一个出口」）。
 *
 * 反过来（键算在线性域）的症状很隐蔽：暗部的色相整体偏移，用户会觉得「选红色
 * 结果连橙色也一起动了」，而两边的参数都是对的。
 *
 * ## 外部蒙版是**收窄**，不是替代
 *
 * `u_maskOn = 1` 时选区的权重是 `键 × 蒙版`，所以它只能让范围更小 ——
 * 「用另一层的亮度把这段局部调色限制在光斑里」。想要「只用外部蒙版」就把
 * 键开到最宽（`hueRange = 180`、`satMin = 0`、`lumaMin = 0`、`lumaMax = 1`）。
 *
 * 这比给一个 `maskSource` 下拉好在：组合是连续的（乘积），不用新增参数类型，
 * 也不用在 shader 里写两条路径。
 *
 * ## 没有 `u_mask` 时的行为
 *
 * 协议保证 `u_maskOn = 0` 时绑的是一张全白（`compositor.whiteMask`），所以这里
 * 用 `u_maskOn` 判断而不是猜贴图内容 —— 全白与「没有蒙版」在数值上一样，
 * 但显式判断能省一次纹理采样。
 */
export const shader: EffectShaderDef = {
  fragment: `${HSV_GLSL}
${HUE_ROTATE_GLSL}
uniform float u_hue;
uniform float u_hueRange;
uniform float u_satMin;
uniform float u_lumaMin;
uniform float u_lumaMax;
uniform float u_softness;
uniform float u_invert;
uniform float u_exposure;
uniform float u_saturation;
uniform float u_hueShift;
uniform float u_amount;

const vec3 LUMA709 = vec3(0.2126, 0.7152, 0.0722);

void main() {
  vec4 texel = texture(u_texture, vUv);

  /*
   * 1) 键。三个判据相乘，每一项都在 [0,1]。
   *
   * 色相差取环形距离（0..180）：直接相减会把 350° 与 10° 判成相差 340。
   * softness 换算：色相那支 ×180 换成度，另两支本来就是 0..1。
   */
  vec3 hsv = rgb2hsv(texel.rgb);
  float dh = abs(fract(hsv.x - u_hue / 360.0 + 0.5) - 0.5) * 360.0;
  float softDeg = max(u_softness * 180.0, 0.001);
  float softUnit = max(u_softness, 0.001);
  float hueSel = 1.0 - smoothstep(max(u_hueRange, 0.0), u_hueRange + softDeg, dh);
  float satSel = smoothstep(u_satMin - softUnit, u_satMin + softUnit, hsv.y);
  float luma = dot(texel.rgb, LUMA709);
  float lumaSel = smoothstep(u_lumaMin - softUnit, u_lumaMin + softUnit, luma)
                * (1.0 - smoothstep(u_lumaMax - softUnit, u_lumaMax + softUnit, luma));
  float keySel = clamp(hueSel * satSel * lumaSel, 0.0, 1.0);
  if (u_invert > 0.5) keySel = 1.0 - keySel;

  // 2) 外部蒙版收窄（没接时恒为 1，见文件头）。
  float outer = u_maskOn > 0.5 ? texture(u_mask, vUv).r : 1.0;
  float w = clamp(keySel * outer * u_amount, 0.0, 1.0);

  /*
   * 3) 校正。三步都是闭式：曝光（EV）→ 饱和（709 亮度）→ 色相旋转。
   * 顺序与 grade-basic 的对应关系一致：先动整体亮度，再动浓度，最后动色相。
   */
  vec3 lin = toLinear(texel.rgb);
  vec3 x = lin * exp2(u_exposure);
  x = mix(vec3(dot(x, LUMA709)), x, u_saturation);
  x = hueRotate(x, u_hueShift);

  // 4) 按权重混回原值。w = 0 时逐个像素回到 lin（只有一次往返误差）。
  outColor = vec4(toSrgb(mix(lin, x, w)), texel.a);
}`,
  /**
   * 吃外部蒙版：这条声明会让 runner 去要 `EffectInstance.inputs.mask` 指向的
   * 那张贴图，并把被引用片段拉进这一帧的渲染序（见 `core/mask.ts` 的依赖边）。
   */
  mask: true,
  setUniforms: compose(
    floats(
      'hue',
      'hueRange',
      'satMin',
      'lumaMin',
      'lumaMax',
      'softness',
      'invert',
      'exposure',
      'saturation',
      'hueShift',
      'amount',
    ),
  ),
};
