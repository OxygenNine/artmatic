/**
 * black-hole.ts — 引力透镜黑洞（realtime，物理模拟）。
 *
 * ## 画面由三件事组成
 *
 * 1. **光子的弯曲路径**：每像素一条射线，在施瓦西时空中按测地线积分，
 *    所以黑洞后面那半个吸积盘会被「翻」到上方，连成电影里那一圈光环。
 * 2. **有厚度的体积盘**：沿射线在盘体积里累积辐射（Beer–Lambert），不是
 *    「在 y = 0 上打一次点」。视线与盘面接近共面时，盘的正面被压成一条横线、
 *    背面被透镜弯成一圈 ⇒ 黑洞那个经典的「空集符号」。
 * 3. **有视角背景**：多层星点 + 一条银河带，全部走同一个透镜 —— 背景的畸变
 *    是「这张图真的是黑洞」的唯一凭据，比盘本身更重要。
 *
 * ## 积分器：笛卡尔近似的测地线
 *
 * 施瓦西时空中光子的轨道方程是 `d²u/dφ² + u = 1.5·rs·u²`（u = 1/r）。
 * 把它展开回笛卡尔坐标，就是一个「向心加速度」：
 *
 * ```
 * h² = |p × d|²            （守恒，只需算一次）
 * a  = −1.5 · h² · p / r⁵
 * ```
 *
 * 这条式子在 `rs = 1` 的单位下**精确给出光子球 r = 1.5**（圆轨道处
 * `|a| = v²/r` 两边相等），也正是事件视界 `r = 1` 与「掠射光线绕行多圈」
 * 的来源。不用 Schwarzschild 的极坐标形式是因为那里要对每条射线解
 * 一维轨道并把结果转回世界坐标，而这里还要在三维里做盘的体积累积 —— 笛卡尔
 * 形式只在 `r` 大时有累积误差，而那时偏折本来就趋于 0。
 *
 * ## 为什么是体积盘而不是薄盘
 *
 * 第一版按「射线穿过 y = 0 就采一次面」写，物理上干净、成本也低，但侧视时
 * 盘永远是一张纸：既出不来参考图那种「云一样有厚度的盘」，也做不出视线与
 * 盘面共面时的「空集符号」（那个形态依赖盘的上下表面在透镜里都可见）。
 * 体积盘每步都要采噪声，所以噪声降到 2 阶 + 1 阶单层；光学厚度与发射来自
 * 同一个密度，掠射时自然更亮更不透明。
 *
 * ## 为什么参考了 Gargantua 却不能照抄
 *
 * 视觉目标是 Haskely 的 [Gargantua](https://github.com/Haskely/Gargantua)
 * （源自 sonicether 的 Shadertoy 作品 `lstSRS`）：厚盘 + 引力透镜后的多重
 * 成像 + 低饱和的高对比调色。它把着色器内联在 `index.html` 里、没有许可声明，
 * 所以本项目**只借用这些公开的物理做法**，代码与噪声 / 配色全部重写
 * （登记在 `CREDITS.md` §2）。
 *
 * ## 步长
 *
 * 固定步长在 r = 20 处要走两百步才到黑洞；纯自适应又会把盘跨过去（体积盘
 * 的表现是横条纹）。所以按两件事夹：
 *
 * - 基线 `0.055·(r − 1)`：远离时接近直线，步长跟着距离长；
 * - **盘半径以内收紧到 `0.09 + 0.18·|y|`**：保证盘内的每一步都短于盘厚度。
 *
 * ⚠️ 收紧**必须同时限定半径**：只按 `|y|` 收紧时，贴着盘面方向飞出去的光线
 * 会在那一薄层里走完全程（每步 0.05），160 步只走 8 个单位，画面右侧就出现
 * 一整块没有星空的黑色楔形 —— 那些射线步数耗尽、被当成「被吞」。
 *
 * 缺省 `steps = 160` 在 480p 下够用（相机距离 20，光子球附近的绕行约
 * 用掉一半预算）。
 *
 * ## 相机：球坐标 + 滚转 + 移轴，不用裸 XYZ
 *
 * 位置由 `yaw / pitch / dist` 决定，**永远以黑洞为原点**。裸 XYZ 允许把相机
 * 放进视界里，那时整幅画面只有一个「全黑」，也没有任何提示；球坐标天然避开
 * 这件事，而「黑洞不在画面正中」由 `shiftX / shiftY`（移轴）解决 —— 平移
 * 投影中心，盘的透视关系不变，这才是构图要的东西。`roll` 绕视线轴转。
 *
 * `orbit` 是 yaw 上的时间项，**出厂为 0**：先定好构图再决定要不要它转。
 *
 * 缺省 `pitch = 2°` 贴着黄道面 —— 这个角度才看得到盘的**实际厚度**
 * （俯视时看到的「厚」是引力透镜把盘的背面放大出来的），也是「空集符号」
 * 出现的角度。想看盘面就把 pitch 抬到 20°–35°。
 */

import { HASH_FAST_GLSL } from '../effects/shader-def';
import { intResParam } from './shader-lib';
import type { GeneratorDef } from './types';

/**
 * 盘面纹理与星空用的 3D 值噪声。
 *
 * 不用 `FBM6_GLSL` 的两条理由：它是 2D 的（盘面要做差动旋转后的三维采样，
 * 否则内外圈会读到同一条纹），而且 6 阶在「每像素沿盘累积几十次」的调用密度下
 * 太贵。这里最高 2 阶、名字带 `bh` 前缀，避免与将来 import 的库撞名。
 */
const NOISE_GLSL = `
float bhNoise3(vec3 p) {
  vec3 i = floor(p);
  vec3 f = fract(p);
  vec3 u = f * f * (3.0 - 2.0 * f);
  float n000 = hash31(i);
  float n100 = hash31(i + vec3(1.0, 0.0, 0.0));
  float n010 = hash31(i + vec3(0.0, 1.0, 0.0));
  float n110 = hash31(i + vec3(1.0, 1.0, 0.0));
  float n001 = hash31(i + vec3(0.0, 0.0, 1.0));
  float n101 = hash31(i + vec3(1.0, 0.0, 1.0));
  float n011 = hash31(i + vec3(0.0, 1.0, 1.0));
  float n111 = hash31(i + vec3(1.0, 1.0, 1.0));
  return mix(
    mix(mix(n000, n100, u.x), mix(n010, n110, u.x), u.y),
    mix(mix(n001, n101, u.x), mix(n011, n111, u.x), u.y),
    u.z);
}

/** 4 阶 fbm，归一化到 0..1（权重和 0.9375）。只给背景的银河用。 */
float bhFbm4(vec3 p) {
  float s = 0.0;
  float a = 0.5;
  for (int i = 0; i < 4; i++) {
    s += a * bhNoise3(p);
    p = p * 2.03 + vec3(11.3, 7.1, 5.7);
    a *= 0.5;
  }
  return s / 0.9375;
}

vec2 bhRot(vec2 p, float a) {
  float c = cos(a);
  float s = sin(a);
  return vec2(c * p.x - s * p.y, s * p.x + c * p.y);
}`;

const BODY = `
uniform float u_diskIn;    // 盘内缘（rs 为单位）
uniform float u_diskOut;   // 盘外缘
uniform float u_thick;     // 盘半厚度（rs）
uniform float u_temp;      // 色温：0 冷白 .. 1 暖金
uniform float u_bright;    // 盘面亮度
uniform float u_turb;      // 湍流强度
uniform float u_spin;      // 差动旋转速度
uniform float u_doppler;   // 多普勒 beaming 强度（0 = 关）
uniform float u_arms;      // 旋臂数（< 0.5 = 无）
uniform float u_star;      // 星空亮度
uniform float u_glow;      // 盘外溢的柔光
uniform float u_pitch;     // 相机倾角（弧度）
uniform float u_yaw;       // 相机方位角（弧度）
uniform float u_roll;      // 相机滚转（弧度）
uniform vec2  u_shift;     // 画面偏移（投影中心，uv 单位）
uniform float u_dist;      // 相机距离
uniform float u_orbit;     // 环绕角速度（弧度/秒；0 = 不环绕）
uniform float u_fov;       // 视场
uniform float u_exposure;  // 曝光
uniform int   u_steps;     // 积分步数上限

/** 编译期上界（GLSL ES 的循环偏好常量界；运行期由 u_steps 提前 break）。 */
const int BH_MAX_STEPS = 240;

/**
 * 星点：两层 3D 网格，每格一颗。
 *
 * 尺寸必须**跟着像素角尺寸走**：方向空间里的星点若小于一个像素就会逐帧闪，
 * 而 intRes 是性能档位、不该改变画面 —— 所以星点半径按 u_fov / 高度
 * 换算成方向空间的角度，再乘格子密度。换分辨率时视觉大小不变。
 */
vec3 bhStars(vec3 d) {
  vec3 col = vec3(0.0);
  float pxAng = u_fov / max(u_resolution.y, 1.0);
  for (int k = 0; k < 2; k++) {
    float sc = k == 0 ? 170.0 : 66.0;
    vec3 q = d * sc;
    vec3 id = floor(q);
    vec3 f = fract(q) - 0.5;
    float h = hash31(id + vec3(float(k) * 17.0));
    vec3 off = vec3(hash31(id + vec3(3.3)), hash31(id + vec3(7.7)), hash31(id + vec3(11.1))) - 0.5;
    float dd = length(f - off * 0.72);
    float sz = clamp(pxAng * sc * 1.35, 0.05, 0.42);
    float br = smoothstep(sz, 0.0, dd) * step(0.87, h);
    float warm = hash31(id + vec3(23.9));
    vec3 tint = mix(vec3(0.70, 0.82, 1.0), vec3(1.0, 0.86, 0.68), warm);
    col += tint * br * (0.45 + 1.7 * hash31(id + vec3(31.7)));
  }
  return col;
}

/** 银河带：一个平面附近的 fbm 云。透镜会把它拉成弧 —— 背景畸变的主要来源。 */
vec3 bhNebula(vec3 d) {
  vec3 axis = normalize(vec3(0.42, 0.80, -0.43));
  float band = exp(-pow(abs(dot(d, axis)) * 7.0, 1.5));
  float n = bhFbm4(d * 4.0 + vec3(3.0));
  float n2 = bhFbm4(d * 9.0 - vec3(7.0));
  float clouds = band * smoothstep(0.18, 0.74, n * 0.7 + n2 * 0.45);
  vec3 tint = mix(vec3(0.10, 0.14, 0.26), vec3(0.32, 0.13, 0.24), n2);
  return tint * clouds;
}

/**
 * 体积盘的一个采样点。返回 vec4(每单位长度的辐射, 每单位长度的消光系数)。
 *
 * x 是相对外缘的位置（0 = 内缘，1 = 外缘），vert 是已算好的垂直高斯衰减
 * （这一项在最贵的那几行之前就该被剪掉）。
 */
vec4 bhDiskVol(vec3 p, float r, float x, float vert, vec3 rd) {
  /*
   * 差动旋转：内圈角速度大，噪声被剪切成螺旋。
   *
   * 用「按 ω(r)·t 旋转采样坐标」而不是「按角度坐标平移」：后者在 atan 的
   * ±π 分支切割处会撕开一道接缝，前者是旋转矩阵、处处连续。
   *
   * ⚠️ 指数从 1.5 降到 1.1：1.5 是开普勒的真实标度，但**纹理不是流体**，
   * 长时间的强剪切会把所有细节拉成同心细线（看起来像木纹），颗粒感全失。
   * 视觉上要的是「缓慢的差动 + 大量局部湍流」。
   */
  float omega = 1.8 / pow(max(r, 1.1), 0.8);
  vec2 q = bhRot(p.xz, -omega * u_time * u_spin * 2.0);

  /*
   * 星云纹理 = **域扭曲 + 三层错频噪声 + 一层刚体颗粒**。
   *
   * 单层 fbm 的团块尺度是均匀的，放大看是一片「豹纹」；参考图的絮状感来自
   * 「大团块里套着细丝」。所以先用一层低频噪声把采样坐标推开（warp），
   * 再叠三个频率比约 1 : 2.7 : 6.8 的层 —— 细丝因此长在大结构的边缘上。
   *
   * 最后一层是**刚体旋转的高频颗粒**（角速度与半径无关）：差动层负责螺旋
   * 结构，而它负责「盘在动但看得见颗粒」。没有这一层时，u_spin 一拉高
   * 整张盘就变成一圈圈光滑的丝。
   */
  float wRigid = 1.8 / pow(max(u_diskOut, 1.1), 0.8);
  vec2 qg = bhRot(p.xz, -wRigid * u_time * u_spin * 2.0);

  vec3 sp = vec3(q * 5.0, p.y * 8.0 + r * 0.6);
  vec2 warp = vec2(bhNoise3(sp * 0.55), bhNoise3(sp * 0.55 + vec3(7.3))) - 0.5;
  vec3 spw = sp + vec3(warp * 1.4, 0.0);
  float n1 = bhNoise3(spw);
  float n2 = bhNoise3(spw * 2.7 + vec3(3.1));
  float n3 = bhNoise3(spw * 6.8 + vec3(9.7));
  float grain = bhNoise3(vec3(qg * 11.0, p.y * 14.0) + vec3(17.0));
  float shape = n1 * 0.40 + n2 * 0.26 + n3 * 0.16 + grain * 0.18;

  /*
   * 外缘用噪声撕开（xw），否则体积积分会给出一个边缘光滑的椭圆 —— 那是
   * 「飞碟」而不是吸积盘。内缘不动：ISCO 处的亮环必须干净。
   */
  float xw = x + (shape - 0.5) * 0.28;
  float edge = smoothstep(0.0, 0.06, xw) * (1.0 - smoothstep(0.42, 0.95, xw));

  float turb = mix(1.0, smoothstep(0.34, 0.66, shape), clamp(u_turb, 0.0, 1.0));

  // 旋臂：对数螺旋，与差动旋转同向（否则两条运动互相打架）
  float arms = 1.0;
  if (u_arms > 0.5) {
    float ang = atan(p.z, p.x);
    float ph = u_arms * (ang - 2.2 * log(max(r, 1.0))) + omega * u_time * u_spin * 3.0;
    arms = mix(1.0, 0.5 + 0.8 * (0.5 + 0.5 * sin(ph)), 0.55);
  }

  /*
   * 同心环：真实盘里「亮环 / 暗隙」是磁流体不稳定的产物，视觉上也是它把
   * 一团云读成「一张盘」。用 log 间距（外圈渐宽）+ 噪声调相，免得像靶纸。
   */
  float rings = 0.88 + 0.12 * sin(log(max(r, 1.2)) * 7.0 + shape * 6.0 - u_time * 0.35 * u_spin);

  /*
   * ⚠️ **密度不许掉到 0**。
   *
   * 孔隙在侧视时是「好看的絮状」：视线在盘里走很长一段，空洞会被前后重叠的
   * 云填掉。但俯视时视线垂直穿过一张薄盘，路径只有盘厚那么多 —— 密度为 0
   * 的格子会直接变成**纯透明的黑斑**，整张盘被啃得七零八落，巨物感全无（实测
   * 图）。所以云团之外留一层稀薄的底：它几乎不发光，但仍然吸收、仍然算作
   * 「有物质」，俯视时读成暗褐色的薄雾而不是洞。
   */
  float dens = edge * vert * (0.16 + 0.84 * turb) * arms * rings;
  if (dens < 0.002) return vec4(0.0);

  /* 温度 T ∝ r^(-3/4)；t = 1 在内缘，往外降到 0.3 上下。 */
  float t = pow(u_diskIn / max(r, u_diskIn), 0.75);

  /*
   * 颜色**不是**一条从内到外的渐变：参考图里同一半径上就有淡金与淡紫交错，
   * 那是「高温星际物质」的色相抖动。所以色相由一个独立的低频场给（hueN），
   * 径向只决定「白热 / 半透明微光 / 暗紫」三个阶段与亮度。
   */
  float hueN = bhNoise3(vec3(q * 1.1, p.y * 1.4 + r * 0.2) + vec3(31.0));
  vec3 c = mix(vec3(0.56, 0.44, 0.72), vec3(1.00, 0.82, 0.52), smoothstep(0.34, 0.70, hueN));
  // 内区：强烈的辉光，几乎纯白
  c = mix(c, vec3(1.00, 0.97, 0.94), smoothstep(0.52, 0.92, t));
  // 外区：暗紫，基本不发光
  c = mix(vec3(0.24, 0.15, 0.32), c, smoothstep(0.20, 0.62, t));
  // 色温滑杆：0 = 更冷（推蓝），1 = 更暖（推金）
  c = mix(c * vec3(0.94, 0.98, 1.06), c * vec3(1.08, 0.97, 0.84), clamp(u_temp, 0.0, 1.0));
  /* 只混掉 18%：再低就成灰阶照片了（实测被当成「黑白渲染」）。 */
  float luma = dot(c, vec3(0.299, 0.587, 0.114));
  c = mix(vec3(luma), c, 0.82);

  /*
   * 相对论：多普勒 beaming + 引力红移。
   *
   * 光子从盘面射向相机，传播方向是 −rd（rd 是积分方向）。观测因子
   * D = 1 / (1 − β·n)，n = −rd ⇒ 1 / (1 + β·dot(vdir, rd))。
   * 亮度按 D³（bolometric），色温按 D 的高/低偏移。
   */
  vec3 vdir = normalize(vec3(-p.z, 0.0, p.x));
  float beta = min(0.75, sqrt(0.5 / max(r, 1.05)));
  float dop = 1.0 / max(0.25, 1.0 + beta * dot(vdir, rd));
  float grav = sqrt(max(1.0 - 1.0 / max(r, 1.02), 0.0));
  float shift = mix(1.0, grav * dop, clamp(u_doppler, 0.0, 1.0));
  float beam = pow(clamp(shift, 0.2, 2.5), 3.0);
  c = mix(c, c * vec3(0.85, 0.94, 1.12), clamp(shift - 1.0, 0.0, 1.0) * 0.5);

  /*
   * 三段亮度：内缘白热、中带微微发光、外缘基本不发光。
   * 消光也随半径降：内盘光学厚（挡得住后面的像），外盘稀薄半透明。
   */
  float lum = pow(t, 2.4) * 9.0 * (1.0 + 3.0 * exp(-x * 10.0));
  float absorb = 2.6 * (0.35 + 0.65 * smoothstep(0.18, 0.75, t));
  return vec4(c * lum * beam * dens * u_bright, dens * absorb);
}

/** 软肩：暗部近似线性（不压黑），高光滚成肩。 */
vec3 bhTone(vec3 x) {
  return 1.0 - exp(-max(x, 0.0));
}

void main() {
  /*
   * 相机是球坐标 + 滚转 + 画面偏移，而不是裸的 XYZ 位置：
   *
   * - 位置由 yaw / pitch / dist 决定，**永远以黑洞为原点** —— 裸 XYZ 允许把
   *   相机放进视界里，那时整幅画面只有一个「全黑」，也没有任何提示。
   * - roll 绕视线轴转，right / up 一起转（等价于转动画面）。
   * - shift 是投影中心的平移（移轴镜头），黑洞因此离开画面正中，而盘与背景
   *   的透视关系不变 —— 这一项才是「构图」真正要的东西。
   * - orbit 是 yaw 上的时间项；给 0 就完全不环绕（默认），方便先定好构图。
   */
  float yaw = u_yaw + u_orbit * u_time;
  float pit = clamp(u_pitch, -1.45, 1.45);
  vec3 eye = vec3(sin(yaw) * cos(pit), sin(pit), cos(yaw) * cos(pit)) * u_dist;
  vec3 fwd = normalize(-eye);
  vec3 right0 = normalize(cross(vec3(0.0, 1.0, 0.0), fwd));
  vec3 up0 = cross(fwd, right0);
  float cr = cos(u_roll);
  float sr = sin(u_roll);
  vec3 right = right0 * cr + up0 * sr;
  vec3 up = -right0 * sr + up0 * cr;

  vec2 sc = (vUv - 0.5 - u_shift) * vec2(u_aspect, 1.0);
  vec3 rd = normalize(fwd + (right * sc.x + up * sc.y) * u_fov);

  /* h² = |p × d|² 沿测地线守恒 —— 只算一次。 */
  vec3 hvec = cross(eye, rd);
  float h2 = dot(hvec, hvec);

  vec3 p = eye;
  vec3 d = rd;
  vec3 col = vec3(0.0);
  float trans = 1.0;
  bool captured = false;
  bool escaped = false;

  for (int i = 0; i < BH_MAX_STEPS; i++) {
    if (i >= u_steps) break;
    float r = length(p);
    if (r < 1.0) { captured = true; break; }
    if (trans < 0.01) break;

    float r2 = r * r;
    float dt = 0.055 * (r - 0.9) + 0.012;
    if (length(p.xz) < u_diskOut * 1.1) dt = min(dt, 0.09 + 0.18 * abs(p.y));

    vec3 prev = p;
    d += (-1.5 * h2 * p / (r2 * r2 * r)) * dt;
    p += d * dt;

    /*
     * 体积累积：取这一段的**中点**，段长当积分步长。
     * 盘的竖直厚度随半径张开（flared），侧视时才有「有厚度的云」而不是一张纸。
     */
    vec3 mid = 0.5 * (prev + p);
    float mr = length(mid.xz);
    if (mr > u_diskIn * 0.85 && mr < u_diskOut * 1.05) {
      float x = (mr - u_diskIn) / max(u_diskOut - u_diskIn, 0.001);
      float hgt = u_thick * (0.7 + 1.3 * clamp(x, 0.0, 1.0));
      float vy = mid.y / max(hgt, 0.002);
      float vert = exp(-vy * vy * 2.0);
      if (vert > 0.02) {
        vec4 dk = bhDiskVol(mid, mr, x, vert, normalize(d));
        col += trans * dk.rgb * length(p - prev);
        trans *= exp(-dk.a * length(p - prev));
      }
    }

    // 逃逸：r > 32 且正在向外（向内的大步子表示还在往里掉）
    if (dot(p, p) > 1024.0 && dot(p, d) > 0.0) { escaped = true; break; }
  }

  /*
   * ⚠️ **步数耗尽、而且停在黑洞附近 ⇒ 算「被吞」**。光子球周围绕圈的光线
   * 一步能吃掉上百步，低步数档下它们会在 r ≈ 1.5 处停住；把这些射线当逃逸
   * 去采样星空，黑洞影子里就会浮出一层星点（720p 下一眼可见，360p 缩略图
   * 看不出来）。
   *
   * 判据必须是「**离得近**」而不是「没 escaped」：后者会把「步长没走完、
   * 其实已经该逃逸」的射线一起涂黑（表现是一块没有星空的黑色楔形）。
   */
  if (!captured && !escaped && dot(p, p) < 36.0) captured = true;

  /* 背景：被吞掉的射线什么都不返回（视界是纯黑）。 */
  if (!captured) {
    vec3 dir = normalize(d);
    vec3 bg = bhStars(dir) + bhNebula(dir) * 0.95;
    bg = bg * u_star + vec3(0.0035, 0.0042, 0.0085);
    col += trans * bg;
  }

  /*
   * 盘外溢的柔光。单 pass 没有邻域，真正的 bloom 做不了；这里叠一层
   * 「以画面中心为圆心、压扁 2.4 倍」的解析辉光，把已经累积到的能量涂在
   * 黑洞周围 —— 视觉上等价于厚盘上方那层被照亮的尘埃。中心留出影子的暗区。
   */
  vec2 sp = (vUv - 0.5 - u_shift) * vec2(u_aspect, 1.0);
  /* 辉光跟着 roll 转：压扁的方向 = 盘在画面上的方向 */
  vec2 hv = bhRot(sp, -u_roll);
  vec2 hs = vec2(hv.x, hv.y * 2.4);
  float halo = exp(-length(hs) * 8.5) * smoothstep(0.04, 0.20, length(hv));
  col += vec3(1.0, 0.58, 0.34) * dot(col, vec3(0.3, 0.5, 0.2)) * halo * u_glow * 0.06;

  outColor = vec4(bhTone(col * u_exposure), 1.0);
}`;

export const BLACK_HOLE_FRAG = HASH_FAST_GLSL + NOISE_GLSL + BODY;

export const blackHoleDef: GeneratorDef = {
  id: 'black-hole',
  nameKey: 'algo.blackHole',
  kind: 'realtime',
  fragment: BLACK_HOLE_FRAG,
  params: [
    { key: 'diskIn', labelKey: 'algo.blackHole.diskIn', type: 'range', min: 1.6, max: 6, step: 0.05, defaultValue: 3 },
    { key: 'diskOut', labelKey: 'algo.blackHole.diskOut', type: 'range', min: 6, max: 32, step: 0.5, defaultValue: 12 },
    { key: 'thick', labelKey: 'algo.blackHole.thick', type: 'range', min: 0.05, max: 1.5, step: 0.01, defaultValue: 0.16 },
    { key: 'temp', labelKey: 'algo.blackHole.temp', type: 'range', min: 0, max: 1, step: 0.01, defaultValue: 0.35 },
    { key: 'bright', labelKey: 'algo.blackHole.bright', type: 'range', min: 0.2, max: 3, step: 0.01, defaultValue: 2 },
    { key: 'turb', labelKey: 'algo.blackHole.turb', type: 'range', min: 0, max: 1, step: 0.01, defaultValue: 1 },
    { key: 'spin', labelKey: 'algo.blackHole.spin', type: 'range', min: 0, max: 3, step: 0.01, defaultValue: 1 },
    { key: 'doppler', labelKey: 'algo.blackHole.doppler', type: 'range', min: 0, max: 1, step: 0.01, defaultValue: 0.6 },
    { key: 'arms', labelKey: 'algo.blackHole.arms', type: 'range', min: 0, max: 6, step: 1, defaultValue: 2 },
    { key: 'star', labelKey: 'algo.blackHole.star', type: 'range', min: 0, max: 2, step: 0.01, defaultValue: 0.8 },
    { key: 'glow', labelKey: 'algo.blackHole.glow', type: 'range', min: 0, max: 1, step: 0.01, defaultValue: 0.1 },
    /* 相机六件套：三个角度 + 两个画面偏移 + 距离。pitch / yaw / roll 是姿态，
       shift 是移轴（把黑洞挪出画面中心），orbit 是 yaw 上的速度项（0 = 不环绕）。 */
    { key: 'pitch', labelKey: 'algo.blackHole.pitch', type: 'range', min: -85, max: 85, step: 1, defaultValue: 2 },
    { key: 'yaw', labelKey: 'algo.blackHole.yaw', type: 'range', min: -180, max: 180, step: 1, defaultValue: 20 },
    { key: 'roll', labelKey: 'algo.blackHole.roll', type: 'range', min: -180, max: 180, step: 1, defaultValue: 0 },
    { key: 'shiftX', labelKey: 'algo.blackHole.shiftX', type: 'range', min: -0.6, max: 0.6, step: 0.005, defaultValue: 0 },
    { key: 'shiftY', labelKey: 'algo.blackHole.shiftY', type: 'range', min: -0.6, max: 0.6, step: 0.005, defaultValue: 0 },
    { key: 'dist', labelKey: 'algo.blackHole.dist', type: 'range', min: 4, max: 60, step: 0.1, defaultValue: 20 },
    { key: 'orbit', labelKey: 'algo.blackHole.orbit', type: 'range', min: -0.4, max: 0.4, step: 0.005, defaultValue: 0 },
    { key: 'fov', labelKey: 'algo.blackHole.fov', type: 'range', min: 0.5, max: 2.5, step: 0.01, defaultValue: 1.15 },
    { key: 'exposure', labelKey: 'algo.blackHole.exposure', type: 'range', min: 0.3, max: 3, step: 0.01, defaultValue: 1.25 },
    { key: 'steps', labelKey: 'algo.blackHole.steps', type: 'range', min: 48, max: 240, step: 8, defaultValue: 160 },
    intResParam(),
  ],
  setUniforms: (gl, l, v, _ctx) => {
    /* `Number(undefined)` 是 NaN，而 `uniform1f(NaN)` 会把整幅画变成 NaN 而不是报错。 */
    const num = (k: string, d: number): number => {
      const x = Number(v[k]);
      return Number.isFinite(x) ? x : d;
    };
    const u1 = (name: string, x: number): void => {
      const p = l[name];
      if (p) gl.uniform1f(p, x);
    };
    /* int uniform 必须走 uniform1i —— 用 uniform1f 写它是 INVALID_OPERATION 且静默不写。 */
    const i1 = (name: string, x: number): void => {
      const p = l[name];
      if (p) gl.uniform1i(p, Math.round(x));
    };

    const diskIn = num('diskIn', 3);
    u1('u_diskIn', diskIn);
    /* 外缘必须在参数合法的前提下大于内缘：两个滑杆互不约束，拖出「外 < 内」
       会让 x 的除数成为负数，整张盘消失且不报错。这里收口，不动参数表。 */
    u1('u_diskOut', Math.max(diskIn + 0.5, num('diskOut', 12)));
    u1('u_thick', Math.max(0.01, num('thick', 0.16)));
    u1('u_temp', num('temp', 0.35));
    u1('u_bright', num('bright', 2));
    u1('u_turb', num('turb', 1));
    u1('u_spin', num('spin', 1));
    u1('u_doppler', num('doppler', 0.6));
    u1('u_arms', Math.round(num('arms', 2)));
    u1('u_star', num('star', 0.8));
    u1('u_glow', num('glow', 0.1));
    u1('u_pitch', (num('pitch', 2) * Math.PI) / 180);
    u1('u_yaw', (num('yaw', 20) * Math.PI) / 180);
    u1('u_roll', (num('roll', 0) * Math.PI) / 180);
    const sx = num('shiftX', 0);
    const sy = num('shiftY', 0);
    const sp = l.u_shift;
    if (sp) gl.uniform2f(sp, sx, sy);
    /* 相机不许进视界：距离下限按 rs = 1 的物理尺度给。 */
    u1('u_dist', Math.max(2, num('dist', 20)));
    u1('u_orbit', num('orbit', 0));
    u1('u_fov', num('fov', 1.15));
    u1('u_exposure', num('exposure', 1.25));
    i1('u_steps', Math.min(240, Math.max(16, num('steps', 160))));
  },
};
