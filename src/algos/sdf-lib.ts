/**
 * sdf-lib.ts — 3D 光线步进内核：相机 + 步进 + 法线 + 光照 + 软阴影 + 雾。
 *
 * 与 `shader-lib.ts` 的 `SCENE_GLSL` 同构：**一段共享 GLSL + 一份共用的
 * uniform 派发 + 一组共用参数**。各 3D 生成器只写自己的 SDF 与 `main`，
 * 其余全部复用 —— 四个 3D 物体各写一遍相机与光照，迟早会漂。
 *
 * ## 为什么是模板函数而不是 `#define ART_SD`
 *
 * GLSL 里没法把函数当参数传，所以「共享的步进循环」必然要知道该调哪个 SDF。
 * 两条路：文本宏（`#define ART_SD(p) sdX(p)`）或**字符串模板**（`sdfKernel('sdX')`
 * 直接把名字代进去）。选后者：宏还要配一句前向声明（`float sdX(vec3);` 必须
 * 出现在宏的**使用点**之前），两处得同步；模板只有一个真源，且拼错名字
 * 是编译期错误（函数没有声明）。
 *
 * ## 与 `sim` / `bake` 的关系
 *
 * 这个内核只管 `realtime`。3D 分形**必须是 realtime**：它们的成本全在 GPU 上，
 * 逐帧实时算与「跳帧缓存」的差别只是画质 —— 而跳帧缓存会破坏确定性（硬约束 1.1）。
 *
 * ## 性能口径（实测，见 AGENTS §5.6）
 *
 * 720p、70 步、5 级递归的 Menger 海绵测出来比纯色只贵 **约 3 ms/帧**
 * —— 3D 光线步进在这个尺度上是便宜的，**不需要为它降 intRes 默认**。
 * 真正要盯的是 `depth`/`iterations`（每步的 SDF 成本）而不是像素数。
 */

import { colorVec3 } from '../core/color';
import {
  bgColorVisible,
  bgModeParam,
  intResParam,
  type AlgoSetUniforms,
  type AlgoUniformCtx,
} from './shader-lib';
import type { SelectParam, RangeParam, ParamDef } from '../effects/types';

/**
 * 步进循环的**编译期**上界。
 *
 * GLSL ES 的循环在不少实现上仍偏好常量界（动态界要靠驱动支持得很好），
 * 而且常量界 + `break` 与动态界的行为完全一致。`u_steps` 是运行期参数，
 * 超不过这个数（`sdfQualityParams` 的 `max` 与它对齐）。
 */
const MAX_MARCH_STEPS = 160;

/**
 * 软阴影的**编译期**步数上界（运行期 `u_shadowSteps` 超不过它）。
 *
 * 比步进小一个量级：阴影射线只需要判断「这段距离内有没有东西」，而且
 * `res < 0.004` 会提前返回，实测平均只走 6~8 步。
 */
const MAX_SHADOW_STEPS = 24;

/** 抗锯齿每边子采样数的编译期上界（共享 main 的循环界与 clamp 都用它）。 */
export const MAX_AA_SAMPLES = 4;

/**
 * aa 的选项值 → 每边子采样数（**唯一定义**：`sdfQualityUniforms` 与单测都读它）。
 *
 * `off` 是 1 而不是 0：循环与除法都按「每边采几个」写，1×1 就是关闭。
 */
export const SDF_AA_LEVELS: Record<string, number> = {
  off: 1,
  x2: 2,
  x3: 3,
  x4: 4,
};

/**
 * 抗锯齿的共用声明。**两个内核模板各插一份**，所以 7 个 3D 生成器的 fragment
 * 都有 `u_aa` 与 `sdfUv`，位置在几何 / 相机 / `sdfSample` 之前。
 *
 * `sdfUv` 是可写全局：共享 main 在每次子采样前写它，`sdfSample()` 与相机函数
 * 读它。相机函数因此不用改签名 —— 三个分形的 `cam.call` 与场景的运镜保持原样。
 */
export const SDF_AA_DECL = `
uniform int u_aa;   // 每边子采样数 1..4（1 = 关）
vec2 sdfUv;         // 本次子采样的 uv
`;

/**
 * 7 个 3D 生成器共用的 `main`。**拼在 `sdfSample()` 定义之后** —— GLSL 要求
 * 先声明后使用，拼反了是编译错误且报错行指向这里的调用。
 *
 * ## 为什么是「无判据的均匀 n² 超采样」（2026-11-08 定）
 *
 * 试过自适应（只在边缘像素上补采样），三条路都走死了：
 *
 * 1. **判据要导数，而导数不能在循环里取。** 把判据塞进采样循环的第一次迭代
 *    （那样只有一个调用点）时，`dFdx` 在这台机器上取不到值 ⇒ 判据永远判「不是
 *    边缘」⇒ AA **静默失效**：实测 x2 / x4 的耗时与 off 完全相同，画面只差半分
 *    像素的位移。导数只能取在循环**外**。
 * 2. **导数取在外面 = 多一个 `sdfSample()` 调用点，而调用点数直接决定编译时间**
 *    （D3D 把每个调用点各内联一遍整份 SDF）。隧道首帧（含编译）实测：
 *    1 个调用点 4.7 s、2 个直写调用点 26.6 s、先算 center 再进 4×4 循环 **44.7 s**。
 *    用户侧的表现就是「隧道一加载页面卡死」，而且 `aa=off` 也躲不掉（uniform
 *    关不掉已编译的代码）。
 * 3. **自适应省下的运行时不值这个价**：成本按 warp 付（一个 tile 里有 1 个边缘
 *    像素，整 tile 都走子采样），实测只比均匀超采样快 1.1~2.0×，却要付 5.6×
 *    的编译时间。
 *
 * 所以：均匀 n²、单一调用点、没有任何分支。首帧隧道 8.0 s（对照：HEAD 无 AA
 * 4.7 s、带判据的旧写法 44.7 s）。
 *
 * **守卫**：整份 fragment 里 `sdfSample()` 只能出现两次（一次定义 + 一次调用），
 * 见 `tests/unit/sdf-aa.test.ts`。想加第二个调用点之前先量首帧。
 *
 * ## 运行时代价（实测：headless Chrome / 4070 laptop / 1280×720）
 *
 * | 生成器 | off | 2×2 | 4×4 |
 * |---|---|---|---|
 * | tunnel-3d | 3.9 ms | 13.0 ms | 49.3 ms |
 * | menger | 0.9 | 2.4 | 8.3 |
 * | extrude-material | 0.8 | 2.0 | 7.1 |
 *
 * 2×2 约 4×、4×4 约 16×（含固定的合成开销，所以倍数略低）。**4×4 是静帧/导出档，
 * 预览上限是 2×2**。同机重复测量有 ±10% 抖动，只看倍数与量级。
 *
 * ## 偏移与确定性
 *
 * 偏移是**固定网格**（((i,j)+0.5)/n - 0.5 个 texel），不是抖动：不读 gl_FragCoord、
 * 不读帧号、不读 u_time，同 t 两渲逐像素相同。n = 1 时偏移恰好是 0（落在像素
 * 中心），所以 `aa=off` 与历史画面逐像素一致。
 */
export const SDF_AA_MAIN = `
void main() {
  int n = clamp(u_aa, 1, ${MAX_AA_SAMPLES});
  vec2 texel = 1.0 / max(u_resolution, vec2(1.0));
  int total = n * n;
  float fn = float(n);

  vec4 sum = vec4(0.0);
  for (int k = 0; k < total; k++) {
    vec2 off = (vec2(float(k % n), float(k / n)) + 0.5) / fn - 0.5;
    sdfUv = vUv + off * texel;
    sum += sdfSample();
  }
  /*
   * 先按预乘求平均再解回来。透明底时未命中的样本是 vec4(0)（rgb 也是 0），
   * 直接平均直通 alpha 会让轮廓灰一圈 —— 合成时 alpha 又乘一次。
   */
  outColor = vec4(sum.rgb / max(sum.a, 1e-4), sum.a / float(total));
}`;

/**
 * tonemap 的取值映射（**唯一定义**：`sdfShadeUniforms` 与单测都读它）。
 *
 * 与 `SDF_PALETTES` 同一套约定：参数值以字符串存进工程 JSON，拼错的名字
 * 必须能在映射表里查不到时有一个明确的缺省，而不是静默变成 0（= 关闭）。
 */
export const SDF_TONEMAPS: Record<string, number> = {
  none: 0,
  aces: 1,
};

/**
 * 镜头模式的取值映射（**唯一定义**：两个生成器的派发与单测都读它）。
 *
 * `orbit` 是历史行为（绕原点公转），必须留在缺省位 —— 新加的参数没有键时
 * `raw[key] ?? defaultValue` 会取它，老工程的取景因此不变。
 */
export const SDF_CAMERAS: Record<string, number> = { orbit: 0, fly: 1 };

/**
 * 穿梭相机的路径。两个生成器共用（menger / apollonian）。
 *
 * ## 为什么是「沿轴直飞 + 段尾换轴」而不是一条连续曲线
 *
 * 正弦叠加那种连续曲线在周期结构里就是没头苍蝇：它不知道走廊在哪，一半时间
 * 贴着墙、一半时间对着虚空。而这两个分形的可行空间是**沿坐标轴**的：
 *
 * - Menger 的八度 1 十字孔就是三条互相垂直的贯通隧道，走廊中心在
 *   `p ≡ 0 (mod 2)`、半宽 1/3，深层的八度只会往里加材料，所以这条隧道
 *   永远存在、永远畅通。沿着它直飞不需要任何避障。
 * - Apollonian 的距离场以 2 为周期，所以「飞整整 2 个单位」就是飞过一个
 *   完整的球堆周期。
 *
 * ## 周期带来的那个免费的便宜
 *
 * 每段飞 **正好 2 个单位**（一个周期）⇒ 段末的位置与段首**模格同余**
 * ⇒ 下一段直接从段首重新开始，画面完全连续（分形的距离场自己被折叠过，
 * 同余的点渲染结果逐像素相同）。于是整个路径不需要累加状态，O(1) 就能算，
 * 也就天然满足「同一个 t 必须给出同一帧」（硬约束 1.1）。
 *
 * 代价：段末不折返的前提是「位置真的只差格向量」。所以 `head` 必须对**所有
 * 六个方向**都落在可行空间里 —— Menger 的 (0,0,0) 是三条隧道的交点，
 * 正好满足。
 *
 * ## 换轴不折返
 *
 * 第 n 段的轴向由哈希定（`seed` 参与相位，所以同一个工程里两条轨道不撞线）。
 * 与上一段反向时改到另一个轴上 —— 折返等于原路退回，观众一眼看出来。
 */
const SDF_FLY_GLSL = `
/** 一段的长度 = 分形的一个周期。 */
const float SDF_FLY_LEG = 2.0;

/**
 * Dave Hoskins 的 hash21（无 sin 族）。**必须无 sin**：leg 序号乘以常数之后
 * 自变量很快就上百，而 fract(sin(x) * 43758.5453) 在大参数下低位不稳，
 * 表现是「某些 leg 的轴向逐帧跳」。仓库里另有一份同源的 HASH_FAST_GLSL，
 * 这里单独起名是为了不与生成器自己 import 的那份重复定义。
 */
float sdfFlyHash(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}

/**
 * 轴向索引 → 世界方向。低半位是符号（0 正 · 1 负），高位是轴序号。
 *
 * axes = 3 时是三根轴全用（menger）。axes = 2 时**只在 XZ 平面里走** ——
 * 球堆的结构沿第三轴同样以 2 为周期，但头上脚下是一整片纯色，竖直飞过去
 * 整屏什么都没有。这是球堆自己的几何决定的，不是相机的事。
 */
vec3 sdfFlyAxis(int i, int axes) {
  int a = i / 2;
  int sig = i - a * 2;
  if (axes < 3) a = a * 2;
  float sg = sig == 0 ? 1.0 : -1.0;
  if (a == 0) return vec3(sg, 0.0, 0.0);
  if (a == 1) return vec3(0.0, sg, 0.0);
  return vec3(0.0, 0.0, sg);
}

/**
 * 第 n 段的轴向索引（0/1、2/3、4/5 是同一根轴的两个方向）。
 *
 * ⚠️ **不许折返**（等于原路退回，观众一眼看出来）。而「上一段实际是什么方向」
 * 在闭式函数里拿不到 —— 上一段自己也依赖再上一段，那是一条递推链。
 *
 * 第一版就是这里出的错：拿 hash(n-1) 的**原始值**当「上一段方向」去排除，
 * 而上一段的值其实已被修正过一次，两者不一致时排除失效 ⇒ 段边界上出现
 * 一次 90° 硬切（实测 400 段里有 1 段）。数值上看就是相邻两段方向恰好反向。
 *
 * 现在改成**按 n 循环**：轴 = (起点 + 步长 × n) % count。相邻两段必然换轴，
 * 所以**不可能折返**，而且完全不需要查上一段。符号由哈希给，每个轴两个方向都能出现。
 *
 * 代价：不会出现「直着继续飞」的段。要允许直飞就得知道上一段的符号，
 * 那就回到递推上去了（硬约束 1.1 不许存状态）。
 */
int sdfFlyDir(float n, float seed, int axes) {
  int count = max(axes, 2);
  int base = min(int(floor(sdfFlyHash(vec2(seed, 13.0)) * float(count))), count - 1);
  int step = 1 + min(int(floor(sdfFlyHash(vec2(seed, 71.0)) * float(count - 1))), count - 2);
  int a = (base + step * int(n)) % count;
  a = a < 0 ? a + count : a;
  int sig = sdfFlyHash(vec2(n, seed * 97.0)) < 0.5 ? 0 : 1;
  return a * 2 + sig;
}

/**
 * 球面插值。这里两个方向只差 90°（正交），**不能用 normalize(mix())**：
 * 那是弦插值，角度按 atan2(k, 1-k) 走，中段的角速度是两端的 2 倍 ——
 * 曲线看上去就是「转起来突然加速再突然停」，也就是「不丝滑」。
 */
vec3 sdfFlySlerp(vec3 a, vec3 b, float k) {
  float c = clamp(dot(a, b), -1.0, 1.0);
  float s = sqrt(max(1.0 - c * c, 1e-8));
  vec3 r = (sin((1.0 - k) * acos(c)) * a + sin(k * acos(c)) * b) / s;
  return s > 1e-4 ? r : normalize(mix(a, b, k));
}

/** 6t⁵-15t⁴+10t³：两端的一阶、二阶导都为 0，所以转向前后都没有「顿一下」。 */
float sdfFlyEase(float x) {
  float k = clamp(x, 0.0, 1.0);
  return k * k * k * (k * (k * 6.0 - 15.0) + 10.0);
}

/**
 * 穿梭相机。eye 沿当前轴从 head 直飞一个周期。
 *
 * ## 转弯窗口**跨过段边界**
 *
 * 转向从前一段的 70% 开始、到下一段的 10% 结束（总共 0.4 段）。压在段尾的写法
 * 会把 90° 的转动挤在很短的行程里，角速度必然陡；跨过边界之后，转弯的后半段
 * 发生在「已经沿新轴飞」的时候 —— 这正是真实运镜的样子：先看进弯里，飞过去，
 * 再收尾。
 *
 * 相位走 smootherstep，角速度是两端为 0 的钟形，**不是线性**，也不是匀速转。
 *
 * ## 摇晃
 *
 * shake 是三轴小幅高频抖动，tilt 是绕视线的固定滚转角（可打关键帧做荷兰角）。
 * 两者都读 t 的闭式正弦 / 常量，所以拖时间轴能拿到同一帧。
 *
 * ## 确定性
 *
 * 全程只读 t 和 seed。转弯相位是段相位的闭式函数，不累加任何状态 ——
 * 拖时间轴到同一个 t 会拿到逐像素相同的一帧。
 */
/**
 * 上向量。**不能用世界 +Y 直接投影**：cross(+Y, f) 在 f 竖直时长度趋 0，
 * 右向量的方向就由浮点噪声决定 —— 画面猛地转 180°，也就是「看天花板时
 * 镜头随机转一圈」。
 *
 * 这里用两条投影按「离竖直多远」加权：
 *
 * - raw：以 (1,1,1) 方向为参考。它离**所有**飞行方向都远（六个轴方向差 54.7°，
 *   转弯途中的对角方向也在 35° 以外），所以这条投影永不退化。代价是它自带
 *   约 45° 的滚转。
 * - level：世界 +Y 投影，地平线是平的，但竖直处退化。
 *
 * 权重按 |fwd.y| 线性过渡（试过 smoothstep 与按角度线性，峰值滚转都比它高）。
 * 水平时完全用 level，竖直时完全用 raw，中间是连续的滚转 —— 看起来是
 * 「飞进竖井时镜头顺势侧过去」，不是突跳。
 */
vec3 sdfFlyUp(vec3 fwd) {
  const vec3 REF = vec3(0.57735027);
  vec3 raw = REF - dot(REF, fwd) * fwd;
  vec3 level = vec3(0.0, 1.0, 0.0) - fwd * fwd.y;
  float w = 1.0 - clamp(abs(fwd.y), 0.0, 1.0);
  return normalize(raw * (1.0 - w) + level * w);
}

/** 绕单位轴旋转（Rodrigues）。用来把倾角滚到 up 上。 */
vec3 sdfFlyRot(vec3 v, vec3 axis, float a) {
  float c = cos(a);
  float s = sin(a);
  return v * c + cross(axis, v) * s + axis * (dot(axis, v) * (1.0 - c));
}

void sdfFlyCam(
  float t, float seed, float speed, float shake, float tilt, int axes, vec3 head,
  out vec3 eye, out mat3 cam
) {
  float legT = SDF_FLY_LEG / max(speed, 0.01);
  float u = t / legT;
  float n = floor(u);
  float f = u - n;

  vec3 d0 = sdfFlyAxis(sdfFlyDir(n, seed, axes), axes);
  vec3 d1 = sdfFlyAxis(sdfFlyDir(n + 1.0, seed, axes), axes);
  vec3 dm = sdfFlyAxis(sdfFlyDir(n - 1.0, seed, axes), axes);

  eye = head + d0 * (f * SDF_FLY_LEG);

  /* 转弯窗口 = [0.70, 1.10]（按段相位计） */
  const float A = 0.70;
  const float B = 0.10;
  const float W = 1.0 + B - A;
  vec3 fwd;
  if (n >= 1.0 && f < B) {
    // 收上一段留下的尾：从 d(m-1) 转到 d0
    fwd = sdfFlySlerp(dm, d0, sdfFlyEase((f + 1.0 - A) / W));
  } else if (f > A) {
    fwd = sdfFlySlerp(d0, d1, sdfFlyEase((f - A) / W));
  } else {
    // 第一段的开头没有「上一段」，直接朝当前轴，不进入转弯
    fwd = d0;
  }

  /* 摇晃：绕当前 up 的两个正交方向各加一条高频正弦。必须在算 up 之前作用到
     fwd 上 —— 否则 up 与 fwd 会不同步，画面在抖的同时还会自转。 */
  vec3 up = sdfFlyUp(fwd);
  if (shake > 0.0) {
    vec3 rt = normalize(cross(up, fwd));
    vec3 upn = cross(fwd, rt);
    float a = shake * 0.085;
    float s1 = sin(t * 7.31 + seed * 31.0) + 0.55 * sin(t * 13.7 + seed * 11.0);
    float s2 = sin(t * 5.93 + seed * 17.0) + 0.55 * sin(t * 11.3 + seed * 5.0);
    fwd = normalize(fwd + rt * (a * s1) + upn * (a * s2));
    up = sdfFlyUp(fwd);
  }

  /* 固定倾角：绕视线滚 up。可打关键帧，用来做荷兰角一类的运镜。 */
  if (tilt != 0.0) up = sdfFlyRot(up, fwd, tilt);

  cam = sdfCamWithUp(eye, eye + fwd, up);
}
`;

/**
 * 调色板值的映射（**唯一定义**：`sdfUniforms` 与单测都读它）。
 *
 * ⚠️ **`dual` 是一个不在选项里的别名**，指向 `height`。它曾是
 * `menger` 的选项名（`single` / `dual`），而参数值是按字符串存进工程 JSON 的：
 * 不留这个别名，老工程里的 `palette: 'dual'` 会落到 `?? 0` —— **静默退回单色**，
 * 不报错、只是画面变了。
 */
export const SDF_PALETTES: Record<string, number> = {
  single: 0,
  height: 1,
  normal: 2,
  dual: 1, // 旧工程别名，不是选项
};

/**
 * 相机 / 射线这一段在**两个**内核里都要用（普通 SDF 与材质型 SDF）。
 *
 * 单独抽出来是因为「各写一份」在这里的失效形态特别难看：视场角的口径
 * 或右向量的兜底一旦有一边漂了，同一个参数在两个生成器里给出不同的取景，
 * 而两边都编译得过、都看起来正常。
 */
const SDF_CAM_GLSL = `
/** 相机基。列 = 右 / 上 / 前，所以 \`cam * vec3(x, y, 1)\` 就是视线方向。 */
mat3 sdfCam(vec3 eye, vec3 target) {
  vec3 f = normalize(target - eye);
  // 上去向量固定用 +Y；视线与 Y 平行时右手系退化，给一个任意但合法的右向量
  // （不处理的话 \`normalize\` 传入零向量，驱动会告警说结果未定义）
  vec3 r = cross(vec3(0.0, 1.0, 0.0), f);
  r = dot(r, r) > 1e-8 ? normalize(r) : vec3(1.0, 0.0, 0.0);
  return mat3(r, cross(f, r), f);
}

/** 由 uv 与相机基造世界方向。fov 越小视野越窄。 */
vec3 sdfRay(vec2 uv, float aspect, mat3 cam) {
  vec2 sc = (uv - 0.5) * vec2(aspect, 1.0);
  return normalize(cam * vec3(sc * u_fov, 1.0));
}

/**
 * 轨道相机：绕原点公转 + 推近，看向原点。三个 3D 分形要的就是这个，
 * 所以连「eye 怎么摆」也共用一份 —— 各写一遍的话，某个分形的 pitch 符号
 * 反了就是「相机从地底下往上看」，不报错也不好查。
 */
mat3 sdfOrbitCam(float yaw, float pitch, float dist, out vec3 eye) {
  float cp = cos(pitch);
  eye = vec3(sin(yaw) * cp, sin(pitch), cos(yaw) * cp) * dist;
  return sdfCam(eye, vec3(0.0));
}

/**
 * 相机基（**显式给上向量**）。
 *
 * sdfCam 把上向量固定成世界 +Y。视线一旦接近竖直，右向量 cross(Y, f) 的长度
 * 就趋 0，接着 normalize 出来的方向由浮点噪声决定 —— 表现出「镜头看天花板时
 * 猛地转 180°」。公转相机不会竖直看，所以一直没暴露；穿梭会。
 *
 * 有 up 之后，竖直飞行也能给出稳定的滚转角。
 */
mat3 sdfCamWithUp(vec3 eye, vec3 target, vec3 up) {
  vec3 f = normalize(target - eye);
  vec3 r = cross(up, f);
  r = dot(r, r) > 1e-8 ? normalize(r) : vec3(1.0, 0.0, 0.0);
  return mat3(r, cross(f, r), f);
}
`;

/**
 * 法线差分步长。两个内核共享。
 *
 * 固定 eps 的问题是两边都错：**低于命中容差**时四个差分点落在判据带内部，
 * 法线逐像素翻向（高光闪烁、暗部发麻）；**远大于容差**时又开始抹掉真实细节。
 * 只有跟着行进距离走才和命中精度同口径 —— 容差本身就是 `u_eps * (1 + t * 0.5)`。
 *
 * 取 2 倍而不是 1 倍：1 倍时差分点仍在容差带内，法线会跟着容差抖。
 *
 * 注意 `sdfNormal` / `sdfNormalMat` 的签名**没有**改成吃距离 —— 隧道那边
 * 的 eps（0.0022）是按壁面刻符 6e-3 宽调出来的，换成自适应会直接抹平刻符。
 */
const SDF_EPS_GLSL = `
float sdfNormalEps(float dist) {
  return u_eps * (1.0 + dist * 0.5) * 2.0;
}
`;

/**
 * 着色模型那 9 个 uniform 的声明。
 *
 * 抽出来是因为**两个内核都要用**：`sdfKernel` 自己声明（三个分形），材质型内核
 * 打开 `shade` 选项时（场景）由调用方在模板**之前**声明 —— 模板里再写一份就是
 * 重复声明，直接编译失败；而模板之后再声明，函数体里的引用就成了「未声明的
 * 标识符」，同样编译失败。
 */
export const SDF_SHADE_UNIFORMS_GLSL = `
/* ---- 着色模型（由 sdfShadeUniforms() 派发，**不在 sdfUniforms 里**） ---- */
uniform int   u_shadowSteps; // 主光阴影的采样上限（0 = 关）
uniform float u_shadow;      // 阴影强度 0..1，同时是唯一开关
uniform float u_gloss;       // 高光锐度（0 哑光 · 1 近镜面）
uniform vec3  u_ambient;     // 半球天光的天顶色（地面取它的 30%）
uniform vec3  u_pointPos;    // 点光世界位置
uniform float u_pointPow;    // 点光强度（0 = 关）
uniform vec3  u_pointCol;    // 点光颜色
uniform vec3  u_fogCol;      // 雾色（显示空间，见 sdfShade 的注释）
uniform int   u_tonemap;     // 0 线性 · 1 ACES 近似
`;

/**
 * BRDF 原语：ACES 近似 + GGX 三项（D / G / F）+ 直接光高光。
 *
 * 单独抽出来是因为它**不读任何 uniform** —— 于是「不想用 `sdfShade` 那一套
 * 固定光照、但还想要正确的 GGX」的生成器（`extrude-material` 的金属 / 玻璃）
 * 可以只拿这一段。不抽的话，那种生成器只有两条路：把 `sdfShade` 连同九个
 * `u_shadow / u_gloss / …` 一起拖进来（声明了不读 ⇒ 链接器丢掉 ⇒ `lab.spec`
 * 的 dropped 判据红），或者自己再写一份 GGX（两份实现迟早漂）。
 *
 * ⚠️ 整条链是 **gamma 空间**（`colorVec3` 只除 255，主链是 RGBA8），所以这些
 * 函数**不是**物理正确的 —— 参数靠肉眼定。真做线性工作流要连主链一起换。
 */
export function sdfBRDFGLSL(): string {
  return `
/* ---------------------------------------------------------------- 着色原语 */

/**
 * ACES 近似（Narkowicz 2015 的拟合）：把 >1 的高光滚成一个肩，而不是削成一块白。
 */
vec3 sdfACES(vec3 x) {
  return clamp((x * (2.51 * x + 0.03)) / (x * (2.43 * x + 0.59) + 0.14), 0.0, 1.0);
}

/** GGX 法线分布。a = 粗糙度（0.02 近镜面 · 0.35 哑光）。 */
float sdfD_GGX(float NoH, float a) {
  float a2 = a * a;
  float d = NoH * NoH * (a2 - 1.0) + 1.0;
  return a2 / max(3.14159265 * d * d, 1e-6);
}

/** Smith-Schlick 几何项。直接光用 k = a/2（IBL 才是 a 的平方除以 2）。 */
float sdfG_Smith(float NoV, float NoL, float a) {
  float k = a * 0.5;
  return (NoV / (NoV * (1.0 - k) + k)) * (NoL / (NoL * (1.0 - k) + k));
}

/** Schlick 菲涅尔，f0 = 0.04（电介质：石、塑料、氧化金属都够用）。 */
vec3 sdfF_Schlick(float VoH) {
  return vec3(0.04 + 0.96 * pow(1.0 - VoH, 5.0));
}

/**
 * GGX 直接光高光（白光源）。返回值已含 NoL —— 辐射方程里
 * \`F*D*G/(4*NoV*NoL) * NoL\` 约掉之后就是 \`F*D*G/(4*NoV)\`，调用方只乘光的颜色与强度。
 */
vec3 sdfSpec(vec3 n, vec3 V, vec3 L, float NoV, float NoL, float a) {
  if (NoL <= 0.0) return vec3(0.0);
  vec3 H = normalize(L + V);
  float NoH = max(dot(n, H), 0.0);
  return sdfF_Schlick(max(dot(V, H), 0.0))
       * (sdfD_GGX(NoH, a) * sdfG_Smith(NoV, NoL, a) / max(4.0 * NoV, 1e-4));
}
`;
}

/**
 * 着色原语 + `sdfShade`。`ao` / `shadow` 是调用方的两个函数名 ——
 * 普通内核用 `sdfAO` / `sdfShadow`（距离取标量），材质型内核用
 * `sdfAOMat` / `sdfShadowMat`（距离取 `.x`）。**函数体本身两边逐字相同**，
 * 所以只能有一份：各写一份的话，某一侧的雾/半球光漏了改动不会有人发现。
 *
 * 要求调用方**已经**声明了 `SDF_SHADE_UNIFORMS_GLSL` 与光/曝光那批
 * （`u_light` / `u_gain` / `u_fog` / `u_ao`）+ 内核的 `u_eps` / `u_stepScale` /
 * `u_maxDist`。
 */
export function sdfShadeGLSL(ao: string, shadow: string): string {
  return (
    sdfBRDFGLSL() +
    `
/**
 * 着色。与上一版（三项假光照 + 乘性黑雾）的六处取舍：
 *
 * 1. **环境光是半球色，不是常量 0.06。** 褶皱里朝下的面拿不到天光，「朝向」
 *    因此自己读得出来 —— 这是任何固定三项光都给不了的东西。
 * 2. **只有环境光吃 AO。** 主光也乘 AO 会把整个物体压成一块，褶皱反而分不开：
 *    AO 的物理含义是「缝里没有环境光」，不是「缝里没有太阳光」。
 * 3. **有镜面项。** 上一版只有 Lambert + 假边缘光，所有表面都像石膏。
 * 4. **雾往「雾色」沉，不往黑沉**，且 \`u_fog = 0\` 时严格为 0（menger 依赖这一点）。
 * 5. **tonemap 先于雾**，于是雾色是**显示空间**的颜色：把 fogColor 设成与 bg
 *    相同，远景就真的融进背景，而不是留一圈轮廓。
 * 6. 旧的按距离压暗保留，但**只压环境光**（当纵深用）—— 主光的衰减是雾的活，
 *    两边都压会让远处黑成一团。
 */
vec3 sdfShade(vec3 p, vec3 n, vec3 rd, float dist, vec3 albedo) {
  vec3 V = -rd;
  float NoV = max(dot(n, V), 1e-3);
  float e = sdfNormalEps(dist);
  float a = mix(0.35, 0.02, clamp(u_gloss, 0.0, 1.0));

  /* 环境：半球天光 × AO × 纵深 */
  float ao = mix(1.0, ${ao}(p, n), clamp(u_ao, 0.0, 1.0));
  vec3 amb = u_ambient * mix(0.30, 1.0, 0.5 + 0.5 * n.y) * ao
           * mix(0.75, 1.0, clamp(1.0 - dist * 0.08, 0.0, 1.0));

  /* 主光 + 软阴影。起点抬离表面 = 一个法线差分步长，否则整片表面自阴影痤疮。 */
  vec3 L = u_light;
  float NoL = max(dot(n, L), 0.0);
  float sh = 1.0;
  if (u_shadow > 0.0 && u_shadowSteps > 0) {
    sh = mix(1.0, ${shadow}(p + n * e, L, e, u_maxDist, 12.0, u_shadowSteps),
             clamp(u_shadow, 0.0, 1.0));
  }
  vec3 col = albedo * (amb + NoL * sh) + sdfSpec(n, V, L, NoV, NoL, a) * sh;

  /* 点光。预算减半 —— 它是补光，双份阴影是双份成本换一点边角收益。 */
  if (u_pointPow > 0.0) {
    vec3 Lp = u_pointPos - p;
    float d2 = max(dot(Lp, Lp), 1e-4);
    vec3 Ln = Lp * inversesqrt(d2);
    float NdL = max(dot(n, Ln), 0.0);
    /*
     * \`3.0 / (1 + d²)\` 而不是 \`1 / d²\`：后者在 d 趋 0 时炸成 NaN，而「把灯拖到
     * 贴着物体」正是用户第一下会做的事。渐近行为仍是平方反比；3.0 是量纲校准
     * （场景直径约两个单位），没有它那个系数毫无意义。
     */
    float att = u_pointPow * 3.0 / (1.0 + d2);
    float shp = 1.0;
    if (u_shadow > 0.0 && u_shadowSteps > 1) {
      shp = mix(1.0, ${shadow}(p + n * e, Ln, e, min(u_maxDist, 6.0), 8.0, u_shadowSteps / 2),
                clamp(u_shadow, 0.0, 1.0));
    }
    col += u_pointCol * (att * shp) * (albedo * NdL + sdfSpec(n, V, Ln, NoV, NdL, a));
  }

  vec3 c = u_tonemap == 1 ? sdfACES(col * u_gain) : clamp(col * u_gain, 0.0, 1.0);
  float fogA = clamp(u_fog, 0.0, 1.0) * (1.0 - exp(-dist * 0.30));
  return mix(c, u_fogCol, clamp(fogA, 0.0, 0.92));
}
`
  );
}

/**
 * 造共享内核的 GLSL 代码块。`sd` 是这个生成器的 SDF 函数名。
 *
 * 提供（全部读下面的共用 uniform，生成器不必传参）：
 *   `sdfCam(eye, target)`  → mat3 相机基
 *   `sdfRay(uv, aspect, cam)` → 归一化的世界方向
 *   `sdfMarch(ro, rd)`     → 命中距离；**没命中返回负值**
 *   `sdfNormal(p, e)`      → 法线（四面体差分，4 次 SDF）
 *   `sdfNormalEps(dist)`   → 该距离上合适的差分步长（别再用硬编码常数）
 *   `sdfAO(p, n)`          → 采样式环境遮蔽
 *   `sdfShadow(ro, rd, mint, maxt, k, steps)` → 软阴影（1 = 全亮 · 0 = 全遮）
 *   `sdfTint(p, n)`        → 调色板
 *   `sdfShade(p, n, rd, dist, albedo)` → 最终颜色（半球环境光 + GGX + 点光 + 雾）
 */
export function sdfKernel(sd: string): string {
  return `
/*
 * **前向声明**。内核里的步进 / 法线 / 遮蔽都要调这个 SDF，而它的定义在
 * 生成器自己的那一半（拼在后面）—— GLSL 要求「先声明后使用」，少了这一行
 * 就是 \`no matching overloaded function found\`，而报错行号指向内核里那句调用，
 * 看起来像内核写错了。
 *
 * 这也是模板方案唯一的坑：名字代进去了，但**函数体还没见过**。
 */
float ${sd}(vec3 p);

uniform int   u_steps;     // 步进上限（编译期上界 ${MAX_MARCH_STEPS} 之内的运行期值）
uniform float u_maxDist;   // 步进的最远距离
uniform float u_stepScale; // 每步走多长（DE 的折扣系数）
uniform float u_eps;       // 命中判据的基准（随行进距离放宽，见 sdfMarch）
uniform float u_fov;       // 视场：越小越像长焦
uniform vec3  u_light;     // 主光方向（单位向量，由 az/el 两个角度换算）
uniform float u_gain;      // 总曝光
uniform float u_fog;       // 雾浓度（0 = 关）
uniform float u_ao;        // 采样式环境遮蔽的强度（0 = 关）
uniform int   u_palette;   // 0 单色 · 1 按高度双色 · 2 按法线双色
uniform vec3  u_color;
uniform vec3  u_colorB;
uniform vec3  u_bg;
/* 0 = 纯色底 · 1 = 透明底（AlgoRuntime 统一派发，见 bgModeParam()）。 */
uniform int   u_bgMode;

${SDF_AA_DECL}
${SDF_SHADE_UNIFORMS_GLSL}

/**
 * 射线没命中时写什么：纯色底 / 全透明。
 *
 * 抽成函数而不是让三个 3D 生成器各写一遍 hit 判定分支：透明底这件事的
 * 「未命中 = alpha 0」语义只该有一处定义，各写一遍必然有一处漏掉
 * （漏掉的表现是「透明模式下背景是一块实心色」—— 看起来像 blend 坏了）。
 */
vec4 sdfBackground() {
  return u_bgMode == 1 ? vec4(0.0) : vec4(u_bg, 1.0);
}
${SDF_CAM_GLSL}
${SDF_EPS_GLSL}
${SDF_FLY_GLSL}

/**
 * 光线步进。**命中返回行进距离，没命中返回负值**（哨兵值而不是 out 参数：
 * 调用点 \`if (hit > 0.0)\` 比 \`if (ok > 0.5)\` 好读）。
 *
 * 判据随行进距离放宽（\`u_eps * (1 + t * 0.5)\`）：远处一个像素覆盖的
 * 物体尺度本来就大，固定阈值要么近处过松（噪点）要么远处过紧（穿透）。
 */
float sdfMarch(vec3 ro, vec3 rd) {
  float tt = 0.0;
  for (int i = 0; i < ${MAX_MARCH_STEPS}; i++) {
    if (i >= u_steps) break;
    float d = ${sd}(ro + rd * tt);
    if (d < u_eps * (1.0 + tt * 0.5)) return tt;
    // ⚠️ 折扣系数不是「1 最好」：分形的 DE 多是**过估**（Mandelbox 尤其明显），
    // 按 1.0 走会在结构内部直接穿过表面，表现为一片噪点。0.9 对 Menger 够用，
    // 而 Mandelbox 要 0.6~0.7 才读得出形体。
    tt += d * u_stepScale;
    if (tt > u_maxDist) break;
  }
  return -1.0;
}

/**
 * 法线：**四面体差分**（4 次 SDF）而不是六面（6 次）。
 *
 * 分形 SDF 的每次求值都贵（Mandelbulb 一次要迭代 8 回），法线从 6 次降到
 * 4 次是每像素实打实的 1/3。精度足够 —— 这个技巧是 Íñigo Quílez 的。
 */
vec3 sdfNormal(vec3 p, float e) {
  const vec2 k = vec2(1.0, -1.0);
  return normalize(
    k.xyy * ${sd}(p + k.xyy * e) +
    k.yyx * ${sd}(p + k.yyx * e) +
    k.yxy * ${sd}(p + k.yxy * e) +
    k.xxx * ${sd}(p + k.xxx * e));
}

/**
 * 采样式环境遮蔽：沿法线走几步，看 SDF 比「空场」低多少。
 *
 * 这是 3D 分形**读得出体积**的关键：只靠 Lambert，Mandelbulb 的千层褶皱
 * 会糊成一片；有了遮蔽，凹处自然变暗，结构就分开了。
 */
float sdfAO(vec3 p, vec3 n) {
  float occ = 0.0;
  float sca = 1.0;
  for (int i = 0; i < 5; i++) {
    float h = 0.012 + 0.16 * (float(i) + 1.0) / 5.0;
    float d = ${sd}(p + n * h);
    occ += (h - d) * sca;
    sca *= 0.90;
  }
  return clamp(1.0 - 1.6 * occ, 0.0, 1.0);
}

/**
 * 软阴影（penumbra 估计）。**没有抖动、没有帧号、没有 gl_FragCoord**。
 *
 * 确定性不是可选项：同一个 t 的两次渲染必须逐像素相同（硬约束 1.1），
 * 而分形着色里任何与像素位置无关的随机都是可见的闪烁。抖动换来的那点
 * 平滑在这里没有对应收益 —— 这个估计本身是解析的。
 *
 * - \`y = h*h/(2*ph)\`：把「离表面多近」折算成「离遮挡物多远」。少了这一项，
 *   阴影带会在遮挡物逼近时分层（一圈圈同心环，而不是连续的半影）。
 * - 步长乘 \`u_stepScale\`：分形 DE 是**过估**，按 h 直走会跨过薄构件
 *   （menger 的壁厚只有 1/27）。
 * - 步长**上界按 maxt 的 10%** 夹，不按 mint 夹。别用 \`mint * 8\` 那种相对写法：
 *   mint 在近景只有几毫（它是命中容差的 2 倍），乘 8 之后 12 步总共只走 0.7 个
 *   单位 —— 阴影射线还没走到遮挡物就用完了步数，表现是「开了阴影画面几乎不变」。
 *   这条踩过：\`shadow 0.65 → 0\` 只让均值差 7%，不是阴影弱，是它根本没走出去。
 * - \`res < 0.004\` 提前返回：已全遮，再采也不会更黑。这是主要的省步数处。
 * - 下界 \`mint * 0.5\`：h 接近 0 时不推进就是白烧 steps 次循环。
 *
 * \`k\` 越大阴影越硬。12 是中等柔（分形褶皱多，硬阴影会碎成噪点）。
 * \`steps\` 做成入参而不是读 \`u_shadowSteps\`：点光要用一半预算，而材质型内核
 * 一个 uniform 都不想多声明。
 */
float sdfShadow(vec3 ro, vec3 rd, float mint, float maxt, float k, int steps) {
  float res = 1.0;
  float t = mint;
  float ph = 1e10;
  for (int i = 0; i < ${MAX_SHADOW_STEPS}; i++) {
    if (i >= steps) break;
    float h = ${sd}(ro + rd * t);
    float y = h * h / (2.0 * ph);
    float d = sqrt(max(h * h - y * y, 0.0));
    res = min(res, k * d / max(t - y, mint * 0.5));
    if (res < 0.004) return 0.0;
    ph = h;
    t += clamp(h * u_stepScale, mint * 0.5, maxt * 0.1);
    if (t > maxt) break;
  }
  return clamp(res, 0.0, 1.0);
}

/**
 * 把镜头推出实体：沿距离场梯度推到离表面至少 margin。
 *
 * 穿梭时这是**唯一**防止「镜头卡在墙里」的手段。卡进去的表现不是崩溃，而是
 * 整幅画面变成一块纯色 —— 第一段步进立刻以 d 接近 0 判成命中，于是整屏都是
 * 同一个表面点的颜色。不报错，看起来像「这个生成器坏了」。
 *
 * 三处防御：
 * - 梯度用 6 点差分而不是四面体：四面体在退化点（深处 / 对称中心）会
 *   normalize 零向量 → NaN → 相机坐标全 NaN → 画面整个消失。
 *   6 点差分能自己判长度，退化时退回沿 +y 推。
 * - 单步位移封顶（0.5）：深处 d 可能是个大负数，不封顶会把镜头弹到场景外。
 * - 最多 5 轮：折叠型距离场在深处会低估（真实距离比返回值大），一轮推不出去，
 *   而推不出去的表现就是整屏纯色 —— 多花几次求值换「不出现坏帧」是划算的。
 */
vec3 sdfCameraClear(vec3 p, float margin) {
  for (int i = 0; i < 5; i++) {
    float d = ${sd}(p);
    if (d >= margin) break;
    float h = max(u_eps, 0.002);
    vec3 g = vec3(
      ${sd}(p + vec3(h, 0.0, 0.0)) - ${sd}(p - vec3(h, 0.0, 0.0)),
      ${sd}(p + vec3(0.0, h, 0.0)) - ${sd}(p - vec3(0.0, h, 0.0)),
      ${sd}(p + vec3(0.0, 0.0, h)) - ${sd}(p - vec3(0.0, 0.0, h)));
    float gl2 = dot(g, g);
    vec3 dir = gl2 > 1e-14 ? g * inversesqrt(gl2) : vec3(0.0, 1.0, 0.0);
    p += dir * min(margin - d, 0.5);
  }
  return p;
}

/** 调色板。按高度/按法线两种双色 —— 分形的高度分布差异很大，够用。 */
vec3 sdfTint(vec3 p, vec3 n) {
  if (u_palette == 1) return mix(u_color, u_colorB, clamp(p.y * 0.5 + 0.5, 0.0, 1.0));
  if (u_palette == 2) return mix(u_color, u_colorB, clamp(n.y * 0.5 + 0.5, 0.0, 1.0));
  return u_color;
}

${sdfShadeGLSL('sdfAO', 'sdfShadow')}`;
}

/**
 * 材质型内核：SDF 返回 `vec3(距离, 材质号, 自发光场)`，步进时顺带把
 * 「自发光结构的光晕」沿射线积分出来。
 *
 * ## 什么时候用它而不是 `sdfKernel`
 *
 * `sdfKernel` 假设画面上只有一个物体（一颗星球、一块海绵）：命中了就
 * `sdfShade` 一次，颜色由一个调色板决定。**走廊 / 隧道 / 任何「多个构件
 * 拼起来的场景」都不成立** —— 壁、拱架、支架、窗外的东西要用不同的材质与
 * 不同的自发光规则着色，而 `sdfMarch` 只回传距离。
 *
 * 三条协议差异，都很小：
 *
 * - SDF 返回 `vec3` 而不是 `float`。`.y` 是材质号（生成器自己定义语义），
 *   `.z` 是**该点的自发光场强度**（0..1 量级），只有「光晕」用它。
 * - 步进返回命中距离，`out` 回传材质号与累积光晕。
 * - 法线 / 遮蔽走 `.x`（`sdfNormalMat` / `sdfAOMat`），签名与 `sdfKernel`
 *   的对应物一致。
 *
 * `.z` 之所以是「场」而不是「这个最近物体的自发光」：光晕是**沿射线**积分的，
 * 而射线离某个发光构件最近的那一点，通常不是全局最近的物体（壁把拱架挡住了）。
 * 让 SDF 顺带算出「我在发光结构附近有多近」，步进只做一次乘加，就不必有第二趟。
 *
 * 只声明**步进自己**要用的五个 uniform（`u_steps` / `u_maxDist` /
 * `u_stepScale` / `u_eps` / `u_fov`）加上抗锯齿那一份 `SDF_AA_DECL`；
 * 光照与配色由生成器自己声明与使用 ——
 * 场景型生成器几乎不会照搬 `sdfShade` 那一套三项光照。
 *
 * ## `shade: true`
 *
 * 把 `sdfShade`（走 `sdfAOMat` / `sdfShadowMat`）也一并拼上 —— 于是多物体
 * 场景可以用**和三个分形同一套**着色，不必各写一份。代价是调用方必须先声明
 * `SDF_SHADE_UNIFORMS_GLSL` 与 `u_light / u_gain / u_fog / u_ao`：这些声明
 * **不能**放进模板 —— 模板里声明了、调用方又声明一次就是重复声明；而模板里
 * 声明、调用方不声明又做不到（场景要往里面塞自己的色调）。
 *
 * `tunnel3d` 不走这一档：它有自己逐材质的着色，而多声明九个 uniform 会让它
 * 全部变成「声明了没被读过」（`compile-all` 的 `dropped` 判据直接红）。
 */
export function sdfKernelMaterial(sd: string, opts: { shade?: boolean } = {}): string {
  return `
/* 前向声明（理由同 \`sdfKernel\`）：.x 距离 · .y 材质 · .z 自发光场 */
vec3 ${sd}(vec3 p);

uniform int   u_steps;
uniform float u_maxDist;
uniform float u_stepScale;
uniform float u_eps;
uniform float u_fov;
${SDF_AA_DECL}
${SDF_CAM_GLSL}
${SDF_EPS_GLSL}

/**
 * 步进。命中返回行进距离并写出 \`mat\`，未命中返回负值；\`glow\` 两条路径都有效
 * （没打中东西时它就是背景里那层雾的光源）。
 *
 * 光晕按**线段长度**加权累积，而不是每步加一个常量：步长在物体附近本来就小，
 * 按步计会让「离得近但走得慢」的区域过亮，形成一圈假的亮带。
 */
float sdfMarchMat(vec3 ro, vec3 rd, out float mat, out float glow) {
  float tt = 0.0;
  float prev = 0.0;
  mat = 0.0;
  glow = 0.0;
  for (int i = 0; i < ${MAX_MARCH_STEPS}; i++) {
    if (i >= u_steps) break;
    vec3 r = ${sd}(ro + rd * tt);
    glow += r.z * (tt - prev);
    prev = tt;
    if (r.x < u_eps * (1.0 + tt * 0.5)) {
      /*
       * **命中后精修**。少了这一段，掠射轮廓会碎成阶梯状方块 —— 这不是几何
       * 问题，是球体步进的固有精度：判据是「距离 < eps」，而一条掠过表面的射线
       * 在 eps 带上要走 sqrt(2R·eps) 那么长（R=2、eps=0.004 时是 0.13 个单位），
       * 于是「第一次满足判据的位置」在带内跳动，命中点连同材质号一起跳。
       *
       * 补几步 0.9·d 的推进就够：每步把剩余距离缩到 1/10，5 步之后误差已经
       * 在浮点噪声里。**不会穿过表面**（球体步进的性质），也不会误判「擦过但
       * 没打到」的射线 —— 距离一旦开始变大就停手，返回上一次的位置。
       */
      float prevD = r.x;
      for (int k = 0; k < 5; k++) {
        float nt = tt + r.x * 0.9;
        vec3 nr = ${sd}(ro + rd * nt);
        if (nr.x > prevD * 0.92) break;
        prevD = nr.x;
        tt = nt;
        r = nr;
      }
      mat = r.y;
      return tt;
    }
    tt += r.x * u_stepScale;
    if (tt > u_maxDist) break;
  }
  return -1.0;
}

/** 法线（四面体差分，取 .x）。 */
vec3 sdfNormalMat(vec3 p, float e) {
  const vec2 k = vec2(1.0, -1.0);
  return normalize(
    k.xyy * ${sd}(p + k.xyy * e).x +
    k.yyx * ${sd}(p + k.yyx * e).x +
    k.yxy * ${sd}(p + k.yxy * e).x +
    k.xxx * ${sd}(p + k.xxx * e).x);
}

/**
 * 采样式环境遮蔽（4 步）。走廊场景里 AO 是「拱架与壁之间的缝」唯一的来源 ——
 * 只靠 Lambert 时内凹的肋与窗框会糊成一片。
 */
float sdfAOMat(vec3 p, vec3 n) {
  float occ = 0.0;
  float sca = 1.0;
  for (int i = 0; i < 4; i++) {
    float h = 0.02 + 0.22 * (float(i) + 1.0) / 4.0;
    float d = ${sd}(p + n * h).x;
    occ += (h - d) * sca;
    sca *= 0.85;
  }
  return clamp(1.0 - 1.5 * occ, 0.0, 1.0);
}

/**
 * 软阴影（材质型内核）。与 \`sdfKernel\` 里那个逐字同构，只差**距离取 .x**。
 *
 * 走廊几何有一条那个内核不会遇到的路径：\`sdfMarchMat\` 的**命中后精修**可能
 * 把一个点留在距离为负的一侧（贴墙的掠射光）。那里 h < 0 ⇒ 第一轮 res 就低于
 * 0.004 ⇒ 提前返回 0，即判成「在阴影里」—— 这正是想要的。
 * 让 \`clamp(h * u_stepScale, ...)\` 去处理负数则是灾难：它会把射线往回推。
 */
float sdfShadowMat(vec3 ro, vec3 rd, float mint, float maxt, float k, int steps) {
  float res = 1.0;
  float t = mint;
  float ph = 1e10;
  for (int i = 0; i < ${MAX_SHADOW_STEPS}; i++) {
    if (i >= steps) break;
    float h = ${sd}(ro + rd * t).x;
    float y = h * h / (2.0 * ph);
    float d = sqrt(max(h * h - y * y, 0.0));
    res = min(res, k * d / max(t - y, mint * 0.5));
    if (res < 0.004) return 0.0;
    ph = h;
    t += clamp(h * u_stepScale, mint * 0.5, maxt * 0.1);
    if (t > maxt) break;
  }
  return clamp(res, 0.0, 1.0);
}
${opts.shade ? sdfShadeGLSL('sdfAOMat', 'sdfShadowMat') : ''}`;
}

/* --------------------------------------------------------- GEOM / CAM 拆分 */

/**
 * 一个可复用的 **SDF 几何体**：uniform 声明 + 辅助函数 + `float sdX(vec3 p)`。
 *
 * ## 为什么要有这一层
 *
 * 拆开之前每个 3D 生成器把「几何 + 运镜 + 局部光照」写在同一段 `BODY` 里，
 * 于是**两个几何体没法出现在同一帧里**：步进循环只认一个函数名。拆成三块之后
 * 单生成器模式（`sdfFrag`）与场景模式（`scene3d.ts`）用同一份 `src` ——
 * 两处不一致会立刻表现为「单独看是对的，进场景就变形」。
 *
 * 三条约定（都是为了让 `src` 能被字符串重写）：
 *
 * - **`src` 里只出现 `u_<geomKey>` 形式的 uniform**，不引用内核 / 着色 / 相机
 *   的任何一个 —— 场景会把这些名字整体改写成 `u_s1_<name>`。
 * - **顶层函数名互不冲突**：场景给每个槽的函数名加 `s1_` / `s2_` 前缀（见
 *   `sdf-compose.ts`），所以重名不会撞车，但**函数内部别用函数名当局部变量**。
 * - **不碰 `main`**：几何体不知道相机，也不知道怎么着色。
 */
export interface SdfGeom {
  /** `float sdX(vec3 p)` 的函数名。 */
  name: string;
  /** uniform 声明 + 辅助函数 + SDF 定义。局部坐标系，距离单位 1。 */
  src: string;
  /** 它自己的参数键（= `u_<key>`）。场景按这个表把子参数派发给它。 */
  keys: readonly string[];
  /** 只写自己那几个 uniform。内核与着色那两批不归它管。 */
  set: SdfGeomSet;
  /**
   * 支持「无限延伸」：折叠之后必须清掉外框约束（见 menger 的注释）。
   *
   * 由调用方通过 `infinite` 传进来，而不是自己去读 `v.extent` ——
   * 场景里这个量叫 `s1.fold`，几何体不该知道槽的命名。
   */
  foldable?: boolean;
}

/** `SdfGeom.set` 的额外上下文。 */
export interface SdfGeomCtx {
  /** 这一份几何要不要按「无限延伸」渲染（折叠 + 清外框）。 */
  infinite: boolean;
}

/**
 * 几何体自己的 uniform 派发。比 `AlgoSetUniforms` 多一个 `opt`：那个量在单
 * 生成器里叫 `extent`、在场景里叫 `s1.fold`，几何体不该认识这两种命名。
 */
export type SdfGeomSet = (
  gl: WebGL2RenderingContext,
  locs: Record<string, WebGLUniformLocation | null>,
  values: Record<string, number | string>,
  ctx: AlgoUniformCtx,
  opt: SdfGeomCtx,
) => void;

/**
 * 单几何体的完整 fragment：内核 + 几何 + 相机 + **共用的 main**。
 *
 * `cam.src` 是相机那一段（uniform 声明 + 一个 `void xxxCam(out vec3 eye, out vec3 rd)`），
 * `cam.call` 是 main 里那一句调用。拆成 src / call 两截是必须的：GLSL 要求
 * 先声明后使用，把整个相机块拼在 main **后面**就是 `no matching function`，
 * 而报错行指向 main 里那句调用。
 *
 * 三个分形的采样因此只剩一份 —— 命中判定（`hit < 0.0`）、背景、法线、
 * 着色四步在它们之间从来没有过差别，各写一遍只会让某一处漏掉修复。
 * `main` 是 `SDF_AA_MAIN`，由全部 7 个 3D 生成器共用。
 */
export function sdfFrag(geom: SdfGeom, cam: { src: string; call: string }): string {
  return (
    sdfKernel(geom.name) +
    geom.src +
    cam.src +
    `
vec4 sdfSample() {
  vec3 eye;
  vec3 rd;
  ${cam.call}
  /*
   * hit < 0.0 而不是 hit <= 0.0：sdfMarch 的**未命中哨兵是 -1**，而 0 是一个
   * 合法命中（镜头正好贴在表面上）。写成小于等于会把这种命中当成没打中，整幅
   * 画面退回底色 —— 表现是「镜头贴到墙上的那几帧全黑」。
   */
  float hit = sdfMarch(eye, rd);
  if (hit < 0.0) {
    return sdfBackground();
  }
  vec3 q = eye + rd * hit;
  vec3 n = sdfNormal(q, sdfNormalEps(hit));
  return vec4(sdfShade(q, n, rd, hit, sdfTint(q, n)), 1.0);
}` +
    SDF_AA_MAIN
  );
}

/**
 * 3D 生成器共用的**质量**参数。
 *
 * 文案键共用一套 `algo.sdf.*`（与 `intResParam()` 同理）：四个 3D 物体各写一份
 * 「步数 / 最远距离 / 命中阈值 / 视场 / 抗锯齿」就会出现名字与口径的漂移。
 *
 * `aa` 放在这里而不是新建一份参数表：`sdfQualityParams()` / `sdfQualityUniforms()`
 * 正好是 7 个用内核的生成器**唯一共同**调用的一对函数。
 */
export function sdfQualityParams(steps = 72): ParamDef[] {
  return [
    {
      key: 'steps',
      labelKey: 'algo.sdf.steps',
      type: 'range',
      min: 32,
      max: MAX_MARCH_STEPS,
      step: 8,
      defaultValue: steps,
    } satisfies RangeParam,
    {
      key: 'stepScale',
      labelKey: 'algo.sdf.stepScale',
      type: 'range',
      min: 0.25,
      max: 1,
      step: 0.01,
      defaultValue: 0.9,
    } satisfies RangeParam,
    {
      key: 'maxDist',
      labelKey: 'algo.sdf.maxDist',
      type: 'range',
      min: 4,
      max: 32,
      step: 0.5,
      defaultValue: 9,
    } satisfies RangeParam,
    {
      key: 'eps',
      labelKey: 'algo.sdf.eps',
      type: 'range',
      min: 0.0005,
      max: 0.008,
      step: 0.0001,
      defaultValue: 0.0018,
    } satisfies RangeParam,
    {
      key: 'fov',
      labelKey: 'algo.sdf.fov',
      type: 'range',
      min: 0.4,
      max: 3,
      step: 0.01,
      defaultValue: 1.3,
    } satisfies RangeParam,
    {
      key: 'aa',
      labelKey: 'algo.sdf.aa',
      type: 'select',
      defaultValue: 'x2',
      options: [
        { labelKey: 'algo.sdf.aaOff', value: 'off' },
        { labelKey: 'algo.sdf.aa2', value: 'x2' },
        { labelKey: 'algo.sdf.aa3', value: 'x3' },
        { labelKey: 'algo.sdf.aa4', value: 'x4' },
      ],
    } satisfies SelectParam,
  ];
}

/**
 * 3D 生成器共用的**光照 / 配色**参数。
 *
 * 光方向用**两个角度**而不是向量：`ParamDef` 没有 vec3 这一档，而
 * 「方位角 + 仰角」两个滑杆比三个数字框好用得多（`sdfUniforms` 里换算）。
 */
export function sdfLightParams(opts: { fog?: number; ao?: number } = {}): ParamDef[] {
  return [
    {
      key: 'lightAz',
      labelKey: 'algo.sdf.lightAz',
      type: 'range',
      min: -180,
      max: 180,
      step: 1,
      // 默认复现 menger 上游那个固定光向 normalize(-0.55, 0.75, 0.55)
      defaultValue: -45,
    } satisfies RangeParam,
    {
      key: 'lightEl',
      labelKey: 'algo.sdf.lightEl',
      type: 'range',
      min: -90,
      max: 90,
      step: 1,
      defaultValue: 44,
    } satisfies RangeParam,
    {
      key: 'ao',
      labelKey: 'algo.sdf.ao',
      type: 'range',
      min: 0,
      max: 1,
      step: 0.01,
      defaultValue: opts.ao ?? 0.6,
    } satisfies RangeParam,
    {
      key: 'fog',
      labelKey: 'algo.sdf.fog',
      type: 'range',
      min: 0,
      max: 1,
      step: 0.01,
      defaultValue: opts.fog ?? 0.3,
    } satisfies RangeParam,
    {
      key: 'gain',
      labelKey: 'algo.sdf.gain',
      type: 'range',
      min: 0.2,
      max: 2,
      step: 0.01,
      defaultValue: 1.0,
    } satisfies RangeParam,
    {
      key: 'palette',
      labelKey: 'algo.sdf.palette',
      type: 'select',
      defaultValue: 'single',
      options: [
        { labelKey: 'algo.sdf.paletteSingle', value: 'single' },
        { labelKey: 'algo.sdf.paletteHeight', value: 'height' },
        { labelKey: 'algo.sdf.paletteNormal', value: 'normal' },
      ],
    } satisfies SelectParam,
    { key: 'color', labelKey: 'algo.sdf.color', type: 'color', defaultValue: '#dfe9ff' },
    {
      key: 'colorB',
      labelKey: 'algo.sdf.colorB',
      type: 'color',
      defaultValue: '#3a6ea5',
      visibleWhen: (v) => v.palette !== 'single',
    },
    { key: 'bg', labelKey: 'algo.sdf.bg', type: 'color', defaultValue: '#000000', visibleWhen: bgColorVisible },
  ];
}

/**
 * 3D 生成器共用的**着色模型**参数（阴影 / 高光 / 环境光 / 点光 / 雾色 / tonemap）。
 *
 * 与 `sdfLightParams` 分成两个函数是**必须的**，不是洁癖：`sdfLightParams` 被
 * `tunnel3d` 也引用了，而隧道自己有另一套着色（`shadeScenery` 逐材质分支），
 * 它不认识这些参数。并成一个函数就会往它的参数表里塞九个无效滑杆。
 *
 * 键名注意：**高光叫 `gloss` 不叫 `rough`** —— `tunnel3d` 已经用 `rough` 表示
 * 壁面粗糙度，同名会让两个概念在工程 JSON 里混成一个。
 */
export function sdfShadeParams(
  opts: {
    shadow?: number;
    shadowSteps?: number;
    gloss?: number;
    ambient?: string;
    pointPow?: number;
    pointDist?: number;
    pointColor?: string;
    fogColor?: string;
    tonemap?: string;
  } = {},
): ParamDef[] {
  const shadow = opts.shadow ?? 0.6;
  const pointPow = opts.pointPow ?? 0.3;
  return [
    {
      key: 'shadow',
      labelKey: 'algo.sdf.shadow',
      type: 'range',
      min: 0,
      max: 1,
      step: 0.01,
      defaultValue: shadow,
    } satisfies RangeParam,
    {
      key: 'shadowSteps',
      labelKey: 'algo.sdf.shadowSteps',
      type: 'range',
      min: 4,
      max: MAX_SHADOW_STEPS,
      step: 4,
      defaultValue: opts.shadowSteps ?? 12,
      // 阴影关了还留着「阴影步数」滑杆，拖动它什么也不动 —— 那是纯噪音。
      visibleWhen: (v) => Number(v.shadow ?? 0.6) > 0,
    } satisfies RangeParam,
    {
      key: 'gloss',
      labelKey: 'algo.sdf.gloss',
      type: 'range',
      min: 0,
      max: 1,
      step: 0.01,
      defaultValue: opts.gloss ?? 0.45,
    } satisfies RangeParam,
    { key: 'ambient', labelKey: 'algo.sdf.ambient', type: 'color', defaultValue: opts.ambient ?? '#18233a' },
    {
      key: 'pointPow',
      labelKey: 'algo.sdf.pointPow',
      type: 'range',
      min: 0,
      max: 1,
      step: 0.01,
      defaultValue: pointPow,
    } satisfies RangeParam,
    {
      key: 'pointDist',
      labelKey: 'algo.sdf.pointDist',
      type: 'range',
      min: 0.5,
      max: 6,
      step: 0.05,
      defaultValue: opts.pointDist ?? 2.8,
      visibleWhen: (v) => Number(v.pointPow ?? 0) > 0,
    } satisfies RangeParam,
    {
      key: 'pointColor',
      labelKey: 'algo.sdf.pointColor',
      type: 'color',
      defaultValue: opts.pointColor ?? '#ffd2a1',
      visibleWhen: (v) => Number(v.pointPow ?? 0) > 0,
    },
    {
      key: 'fogColor',
      labelKey: 'algo.sdf.fogColor',
      type: 'color',
      defaultValue: opts.fogColor ?? '#121a2a',
      visibleWhen: (v) => Number(v.fog ?? 0.3) > 0,
    },
    {
      key: 'tonemap',
      labelKey: 'algo.sdf.tonemap',
      type: 'select',
      defaultValue: opts.tonemap ?? 'none',
      options: [
        { labelKey: 'algo.sdf.tonemapNone', value: 'none' },
        { labelKey: 'algo.sdf.tonemapAces', value: 'aces' },
      ],
    } satisfies SelectParam,
  ];
}

/**
 * 镜头模式 + 穿梭的两个量。**只给需要穿梭的生成器**（menger / apollonian）——
 * 放进 `sdfParams()` 会给 mandelbulb 也塞三个它不认识的滑杆。
 *
 * `camera` 的缺省必须是 `orbit`：新参数在老工程里没有键，
 * `raw[key] ?? defaultValue` 会取它，取景因此不变。
 */
export function sdfCameraParams(): ParamDef[] {
  return [
    {
      key: 'camera',
      labelKey: 'algo.sdf.camera',
      type: 'select',
      defaultValue: 'orbit',
      options: [
        { labelKey: 'algo.sdf.cameraOrbit', value: 'orbit' },
        { labelKey: 'algo.sdf.cameraFly', value: 'fly' },
      ],
    } satisfies SelectParam,
    {
      key: 'flySpeed',
      labelKey: 'algo.sdf.flySpeed',
      type: 'range',
      min: 0.1,
      max: 3,
      step: 0.05,
      defaultValue: 0.8,
      visibleWhen: (v) => v.camera === 'fly',
    } satisfies RangeParam,
    {
      key: 'flyShake',
      labelKey: 'algo.sdf.flyShake',
      type: 'range',
      min: 0,
      max: 1,
      step: 0.01,
      defaultValue: 0.3,
      visibleWhen: (v) => v.camera === 'fly',
    } satisfies RangeParam,
    {
      /** 绕视线的固定滚转。**可打关键帧** —— 荷兰角（地平线倾斜）就是它。 */
      key: 'flyTilt',
      labelKey: 'algo.sdf.flyTilt',
      type: 'range',
      min: -180,
      max: 180,
      step: 1,
      defaultValue: 0,
      visibleWhen: (v) => v.camera === 'fly',
    } satisfies RangeParam,
  ];
}

/** 3D 生成器共用的参数尾巴：质量 + 光照 + 着色 + 背景开关 + 内部分辨率。 */
export function sdfParams(
  opts: {
    steps?: number;
    stepScale?: number;
    fog?: number;
    ao?: number;
    shadow?: number;
    shadowSteps?: number;
    gloss?: number;
    ambient?: string;
    pointPow?: number;
    pointDist?: number;
    pointColor?: string;
  } = {},
): ParamDef[] {
  const quality = sdfQualityParams(opts.steps).map((p) =>
    p.key === 'stepScale' && opts.stepScale !== undefined
      ? ({ ...p, defaultValue: opts.stepScale } as ParamDef)
      : p,
  );
  return [
    ...quality,
    ...sdfLightParams(opts),
    ...sdfShadeParams(opts),
    bgModeParam(),
    /*
     * 3D 的默认内部尺寸是 `auto`（跟渲染目标一样大）。**只覆盖缺省值，不动共用选项表** ——
     * `intRes` 是全 realtime 家族共用的键，把 `intResParam()` 的缺省改成 `auto`
     * 会让二十来个 2D 分形也按全分辨率渲染，并让全部缩略图重烘。
     *
     * 为什么只有 3D 配得上：光线步进的成本全在像素上，而 480 行放大到 1080p 是
     * 2.25 倍线性放大 —— 阴影与高光都在这步被抹掉。2D 分形放大只是变糊，
     * 而且它们的默认 `intRes` 调高会让一批 sim/bake 图元的边变硬，收益小得多。
     */
    { ...intResParam(), defaultValue: 'auto' } as ParamDef,
  ];
}

/**
 * 内核那批 **base** uniform 的派发。生成器的 `setUniforms` 先调它，再调
 * `sdfShadeUniforms()`，最后派自己的。
 *
 * ⚠️ **必须写满自己声明的那 15 个** —— `algo-uniforms.test.ts` 的判据是
 * 「fragment 里声明了的都被写到」，而内核的声明就在每个 3D def 的 fragment 里
 * （拼在前面的）。漏一个的表现是那个 uniform 恒为默认值且不报错。
 *
 * ⚠️ **不要往这里加着色模型的 uniform。** 这个函数 `tunnel3d` 也调，而它不声明
 * `u_shadow` / `u_gloss` / `u_ambient` 这些 —— 写了就是「摸到未声明的 uniform」，
 * `algo-uniforms.test.ts` 直接红。着色那批走 `sdfShadeUniforms()`。
 *
 * 三批拆开（质量 / 光照 / 调色板）的唯一理由是**场景要用其中两批**：它有三个
 * 材质色、没有「按高度双色」的调色板，整批调进来就是「摸到未声明的 `u_palette`」。
 */
export function sdfUniforms(): AlgoSetUniforms {
  return composeUniforms(sdfQualityUniforms(), sdfLightUniforms(), sdfPaletteUniforms());
}

/** 三个派发器合成一个（顺序执行）。 */
export function composeUniforms(...fns: AlgoSetUniforms[]): AlgoSetUniforms {
  return (gl, l, v, ctx) => {
    for (const fn of fns) fn(gl, l, v, ctx);
  };
}

/** `u_steps` / `u_maxDist` / `u_stepScale` / `u_eps` / `u_fov` / `u_aa`。 */
export function sdfQualityUniforms(): AlgoSetUniforms {
  return (gl, l, v, _ctx: AlgoUniformCtx) => {
    const set1f = (name: string, value: number): void => {
      const loc = l[name];
      if (loc) gl.uniform1f(loc, value);
    };
    set1i(gl, l, 'u_steps', Number(v.steps ?? 72));
    set1f('u_maxDist', Number(v.maxDist ?? 9));
    set1f('u_stepScale', Number(v.stepScale ?? 0.9));
    set1f('u_eps', Number(v.eps ?? 0.0018));
    set1f('u_fov', Number(v.fov ?? 1.3));
    set1i(gl, l, 'u_aa', SDF_AA_LEVELS[String(v.aa ?? 'x2')] ?? SDF_AA_LEVELS.x2!);
  };
}

/** `u_light`（由 az/el 换算）+ 曝光 / 雾 / 遮蔽三个标量。 */
export function sdfLightUniforms(): AlgoSetUniforms {
  return (gl, l, v, _ctx: AlgoUniformCtx) => {
    const set1f = (name: string, value: number): void => {
      const loc = l[name];
      if (loc) gl.uniform1f(loc, value);
    };
    set1f('u_gain', Number(v.gain ?? 1));
    set1f('u_fog', Number(v.fog ?? 0.3));
    set1f('u_ao', Number(v.ao ?? 0.6));

    // 光方向：方位角 + 仰角 → 单位向量。与「先绕 y 转方位、再抬仰角」同口径。
    const az = (Number(v.lightAz ?? -45) * Math.PI) / 180;
    const el = (Number(v.lightEl ?? 44) * Math.PI) / 180;
    const ce = Math.cos(el);
    const light = l['u_light'];
    if (light) gl.uniform3f(light, Math.sin(az) * ce, Math.sin(el), Math.cos(az) * ce);
  };
}

/** `u_palette` / `u_color` / `u_colorB` / `u_bg`。 */
export function sdfPaletteUniforms(): AlgoSetUniforms {
  return (gl, l, v, _ctx: AlgoUniformCtx) => {
    set1i(gl, l, 'u_palette', SDF_PALETTES[String(v.palette)] ?? 0);
    set3(gl, l, 'u_color', String(v.color ?? '#dfe9ff'));
    set3(gl, l, 'u_colorB', String(v.colorB ?? '#3a6ea5'));
    set3(gl, l, 'u_bg', String(v.bg ?? '#000000'));
  };
}

/** 三个小助手：`u_*` 派发里最常写的三行。 */
export function set1i(
  gl: WebGL2RenderingContext,
  l: Record<string, WebGLUniformLocation | null>,
  name: string,
  value: number,
): void {
  const loc = l[name];
  if (loc) gl.uniform1i(loc, Math.round(value));
}

export function set3(
  gl: WebGL2RenderingContext,
  l: Record<string, WebGLUniformLocation | null>,
  name: string,
  hex: string,
): void {
  const loc = l[name];
  if (!loc) return;
  const [r, g, b] = colorVec3(hex);
  gl.uniform3f(loc, r, g, b);
}


/**
 * 着色模型那 9 个 uniform 的派发。
 *
 * **只能被 `sdfKernel` 的消费方调用**（menger / mandelbulb / apollonian）。
 * 材质型内核不声明这批名字，接进来就是「摸到未声明的 uniform」。
 */
export function sdfShadeUniforms(): AlgoSetUniforms {
  return (gl, l, v, _ctx: AlgoUniformCtx) => {
    const set1f = (name: string, value: number): void => {
      const loc = l[name];
      if (loc) gl.uniform1f(loc, value);
    };
    const set1i = (name: string, value: number): void => {
      const loc = l[name];
      if (loc) gl.uniform1i(loc, Math.round(value));
    };
    const set3 = (name: string, hex: string): void => {
      const loc = l[name];
      if (!loc) return;
      const [r, g, b] = colorVec3(hex);
      gl.uniform3f(loc, r, g, b);
    };

    set1i('u_shadowSteps', Number(v.shadowSteps ?? 12));
    set1f('u_shadow', Number(v.shadow ?? 0.6));
    set1f('u_gloss', Number(v.gloss ?? 0.45));
    set3('u_ambient', String(v.ambient ?? '#18233a'));
    set1f('u_pointPow', Number(v.pointPow ?? 0.3));
    set3('u_pointCol', String(v.pointColor ?? '#ffd2a1'));
    set3('u_fogCol', String(v.fogColor ?? '#121a2a'));
    // 拼错的名字与缺省都落到「线性」：ACES 是**压缩高光**的档，它会把暗部一起抬起来
    // （ACES(0.1) ≈ 0.13），默认开着就是一层灰雾 —— 分形的褶皱会被糊平。
    set1i('u_tonemap', SDF_TONEMAPS[String(v.tonemap ?? 'none')] ?? 0);

    /*
     * 点光位置：`ParamDef` 没有 vec3 这一档，所以用「主光方向 + 一个距离」——
     * 点光天然跟着主光转，不会出现两盏灯互相对打的组合，也少两个滑杆。
     * 真要独立摆放时再加 pointAz / pointEl（与 lightAz/lightEl 同口径）。
     */
    const az = (Number(v.lightAz ?? -45) * Math.PI) / 180;
    const el = (Number(v.lightEl ?? 44) * Math.PI) / 180;
    const ce = Math.cos(el);
    const pd = Math.max(0.2, Number(v.pointDist ?? 2.8));
    const pos = l['u_pointPos'];
    if (pos) gl.uniform3f(pos, Math.sin(az) * ce * pd, Math.sin(el) * pd, Math.cos(az) * ce * pd);
  };
}
