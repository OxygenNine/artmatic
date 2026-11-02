import type { EffectShaderDef } from '../shader-def';

/**
 * `grade-basic` — 一级校色：暗部 / 中间调 / 高光 / 偏移四组色轮 + 对比 / 饱和 / 色相 / 色温色调。
 *
 * ## 单岛
 *
 * 整段运算在一个**线性岛**内：`toLinear` → 全部闭式运算 → `toSrgb`。
 * 中间缓冲是 sRGB 编码值，解码只发生在这里（见 `core/grade.ts` 的说明）。
 * 相邻的调色模块之间会有一次 encode/decode 往返 —— 那是刻意的，代价换的是
 * 「任何调色模块都能单独插进既有链」。
 *
 * ## 顺序是 偏移 → LGG → 对比 → 饱和 → 色相
 *
 * 与调色台的直觉一致：先做整体（offset）与**分段色平衡**（lift/gamma/gain），
 * 再动整体的对比与色彩浓度，最后才是色相旋转。反过来做（先对比再 LGG）会让
 * 「拉对比之后暗部轮盘的效果被放大」，用户调两次才能到位。
 *
 * ## 偏移与 gain 的差别在于「动不动黑位」
 *
 * 两者都是乘，但偏移先给一点底再乘、再把底减回去：
 *
 *     x' = (x + F) · k - F
 *
 * 于是 k≠1 时 x=0 会变成 `F(k-1)`（黑位跟着抬 / 压），而纯乘（gain）永远把
 * 黑留在黑。这正是「打印光」的意思 —— 整段一起动，包括黑场。k=1 时逐位恒等，
 * 所以中性不会因为多了一个节点而漂。
 *
 * ## 三个数字是写死的，不是参数
 *
 * - `PIVOT = 0.18`：**线性**域的中灰。编码域的 0.5 在线性域是 73% 白，
 *   拿它当对比支点会把整幅画面往下压。这个数字写死，参数表里不暴露。
 * - lift 的 `0.25`、gain 的 `2.0`（EV）、gamma 的 `0.6`：三个轮盘的**量纲**。
 *   存进去的是零亮度方向向量（`ui/grade/wheel-model.ts`），缩放只在这里做，
 *   于是 UI 不需要知道「一格是多少」。
 *
 * ## 色相旋转走 YIQ
 *
 * 便宜且够用（TODO 的取舍：不上 OkLab）。矩阵在**线性**域作用，因为这时
 * 整段仍是线性的 —— 在线性域做色相旋转与在编码域做，观感差别只在暗部，
 * 而暗部的色相旋转本来就不可靠。
 */

/** `lift#r` → `u_liftR` 这种映射：参数键里的 `#` 不能直接进 uniform 名。 */
const KEYS: [param: string, uniform: string][] = [
  ['offset#r', 'offsetR'],
  ['offset#g', 'offsetG'],
  ['offset#b', 'offsetB'],
  ['offset#m', 'offsetM'],
  ['lift#r', 'liftR'],
  ['lift#g', 'liftG'],
  ['lift#b', 'liftB'],
  ['lift#m', 'liftM'],
  ['gamma#r', 'gammaR'],
  ['gamma#g', 'gammaG'],
  ['gamma#b', 'gammaB'],
  ['gamma#m', 'gammaM'],
  ['gain#r', 'gainR'],
  ['gain#g', 'gainG'],
  ['gain#b', 'gainB'],
  ['gain#m', 'gainM'],
  ['contrast', 'contrast'],
  ['saturation', 'saturation'],
  ['hue', 'hue'],
  ['temp', 'temp'],
  ['tint', 'tint'],
];

export const shader: EffectShaderDef = {
  fragment: `
uniform float u_offsetR;
uniform float u_offsetG;
uniform float u_offsetB;
uniform float u_offsetM;
uniform float u_liftR;
uniform float u_liftG;
uniform float u_liftB;
uniform float u_liftM;
uniform float u_gammaR;
uniform float u_gammaG;
uniform float u_gammaB;
uniform float u_gammaM;
uniform float u_gainR;
uniform float u_gainG;
uniform float u_gainB;
uniform float u_gainM;
uniform float u_contrast;
uniform float u_saturation;
uniform float u_hue;
uniform float u_temp;
uniform float u_tint;

const vec3 LUMA709 = vec3(0.2126, 0.7152, 0.0722);
const float PIVOT = 0.18;
/*
 * 偏移的「底」：线性域 1/1024（约 8 位最低一档）。再小就抬不动黑，
 * 再大则中性以外的最小动作会先把黑场糊掉。
 */
const float OFFSET_FLOOR = 0.0009765625;

/*
 * YIQ 矩阵。**GLSL 的 mat3 构造器是列优先**：每三个数是一列，不是一行。
 * 照着教科书上的行式表抄进来会得到**转置矩阵** —— 而这个错的形态极其隐蔽：
 * 灰色输入经 transpose(M) 之后 I/Q 不再为 0，转回来就是一整幅偏色。
 * 实测（中灰 #808080）：按行写 → (126,133,155)，按列写 → 128。
 *
 *   Y = 0.299R + 0.587G + 0.114B      R = Y + 0.956I + 0.621Q
 *   I = 0.596R - 0.274G - 0.322B      G = Y - 0.272I - 0.647Q
 *   Q = 0.211R - 0.523G + 0.312B      B = Y - 1.106I + 1.703Q
 */
const mat3 RGB2YIQ = mat3(0.299, 0.596, 0.211,
                          0.587, -0.274, -0.523,
                          0.114, -0.322, 0.312);
const mat3 YIQ2RGB = mat3(1.0, 1.0, 1.0,
                          0.956, -0.272, -1.106,
                          0.621, -0.647, 1.703);

vec3 hueYIQ(vec3 c, float deg) {
  float a = radians(deg);
  float cs = cos(a);
  float sn = sin(a);
  vec3 yiq = RGB2YIQ * c;
  // IQ 平面里的旋转（显式写分量，避免 mat2 的列序歧义）
  yiq.yz = vec2(cs * yiq.y - sn * yiq.z, sn * yiq.y + cs * yiq.z);
  return YIQ2RGB * yiq;
}

void main() {
  vec4 texel = texture(u_texture, vUv);
  vec3 x = toLinear(texel.rgb);

  // 1) 偏移：整体曝光 + 色偏（连黑位一起动，见文件头）
  x = (x + OFFSET_FLOOR) * exp2(vec3(u_offsetR, u_offsetG, u_offsetB) * 1.2 + u_offsetM) - OFFSET_FLOOR;

  // 2) 色温 / 色调：沿普朗克轨迹的两条基向量（R↑B↓ / G↑M↓）。
  //    tint 的系数减半：绿色在 709 亮度里权重最大，同量纲会让它压倒色温。
  x *= exp2(vec3(u_temp, u_tint * 0.5, -u_temp));

  // 3) 暗部：零亮度偏移 + 主量（加性，允许负值压黑）
  x += vec3(u_liftR, u_liftG, u_liftB) * 0.25 + u_liftM;

  // 4) 亮部：EV
  x *= exp2(vec3(u_gainR, u_gainG, u_gainB) * 2.0 + u_gainM);

  // 5) 中间调：gamma。下限 0.05 是防 0 与负数（pow 的底为 0 会得到整块黑）；
  //    主量乘在 gamma 上而不是除，所以「往右拉 = 变亮」与其它工具一致。
  vec3 ge = max(vec3(1.0) + vec3(u_gammaR, u_gammaG, u_gammaB) * 0.6, vec3(0.05))
          * max(u_gammaM, 0.05);
  x = pow(max(x, vec3(0.0)), 1.0 / ge);

  // 6) 对比（支点在线性 0.18）
  x = (x - PIVOT) * u_contrast + PIVOT;

  // 7) 饱和（709 亮度）
  x = mix(vec3(dot(x, LUMA709)), x, u_saturation);

  // 8) 色相
  x = hueYIQ(x, u_hue);

  // 上界不夹：16F 中间缓冲把高光留给后面的模块（写 8 位目标时由硬件夹）。
  outColor = vec4(toSrgb(x), texel.a);
}`,
  setUniforms: (gl, locs, values) => {
    for (const [key, name] of KEYS) {
      const loc = locs[`u_${name}`];
      if (loc) gl.uniform1f(loc, Number(values[key]) || 0);
    }
  },
};
