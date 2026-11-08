/**
 * extrude-material.ts — 位图 → SDF → 挤出成体，配五种材质（realtime）。
 *
 * 输入是一张图，输出是把它**当成金属招牌**的那一帧：轮廓取自图的掩码，
 * 距离场在 CPU 上算（`logo-sdf.ts`），挤出 / 倒角 / 材质全部落在 SDF 上，
 * 光线步进与相机走 `sdf-lib.ts` 的材质型内核。
 *
 * ## 为什么不是「贴图 + 视差」而是真挤出
 *
 * 这个生成器要回答的是「这枚标做成立体件长什么样」：厚度、倒角的高光、
 * 侧壁的暗面、玻璃里的折射。四者都要求**轮廓之外的像素知道自己在哪一侧**，
 * 也就是距离场。贴图类做法给不了倒角 —— 那是几何，不是着色。
 *
 * ## 素材是外部输入，所以有占位轮廓
 *
 * `logoAsset` 是 `asset` 型参数（工程里一张静态图）。它可能没绑、可能还没
 * 解码完、也可能刚被删掉；三种情况都会让这一帧没有距离场。这里的选择是
 * **退回占位轮廓**（`placeholderBitmap`：一枚「图片」图标），而不是画一片
 * 空白 —— 空画面在选择器缩略图、Agent 首次插入、以及用户还没选图的那几秒里
 * 都会被读成「这个生成器坏了」。
 *
 * ## 材质是参数组合，不是 shader 分支
 *
 * 与 `horizon.ts` 同一条思路：`EXTRUDE_MATERIALS` 是一张系数表（金属度、
 * 基准粗糙度、折射量、IOR、色散、虹彩、法线扰动、磨砂、环境倍率），GLSL
 * 只有**一套**着色公式。加一种材质 = 表里加一行 + i18n 加一个选项，shader
 * 一个字都不用改；反过来写四个分支，每加一种就要在四处混合逻辑里都改一遍。
 *
 * ## 着色没有走 `sdfShade`
 *
 * `sdfShade` 是「一盏主光 + 半球天光 + 点光」，而这一族的形体靠的是**环境
 * 反射**：金属没有漫反射，它的形体是环境在它身上的倒影；玻璃要把环境折进去。
 * 所以这里自带一套金属度/粗糙度着色，只从 `sdf-lib` 复用 BRDF 原语
 * （`sdfBRDFGLSL`：ACES + GGX 三项 + 直接光高光）—— 不复用 `sdfShade` 是因为
 * 它连同九个只服务于自己的 uniform 一起进来，而本生成器一个都不声明，
 * 那些 uniform 会被链接器丢掉（`lab.spec` 的 dropped 判据直接红）。
 *
 * 环境也是**程序化**的（竖直渐变 + 主光方向的柔光箱 + 反方向补光），不加载
 * HDR：一个解析函数就能让金属读出「studio」的质感，而且零加载时间。
 */

import { HASH_FAST_GLSL } from '../effects/shader-def';
import { intResParam } from './shader-lib';
import { alphaFromRgba, buildLogoField, placeholderBitmap } from './logo-sdf';
import {
  composeUniforms,
  sdfBRDFGLSL,
  sdfKernelMaterial,
  sdfQualityParams,
  sdfQualityUniforms,
  set1i,
  set3,
} from './sdf-lib';
import type { AssetParam, ParamDef, RangeParam, SelectParam } from '../effects/types';
import type { MessageKey } from '../i18n/locales';
import type { GeneratorDef } from './types';

/* ------------------------------------------------------------ 材质表（纯） */

export interface ExtrudeMaterial {
  /** 金属度。1 = 没有漫反射，形体全靠环境倒影。 */
  metal: number;
  /** 基准粗糙度（滑杆 `gloss` 在它上面乘）。 */
  rough: number;
  /** 折射混合量（只有玻璃非零）。 */
  refract: number;
  /** 折射率。 */
  ior: number;
  /** 色散：三个通道用不同的 IOR。 */
  disp: number;
  /** 虹彩：在菲涅耳上做色相摆动（**全表面**，靠法线陡度调制）。 */
  irid: number;
  /** 边缘色散：只在轮廓/倒角（法线转过去的地方）才有，内部保持低饱和金属色。 */
  iridEdge: number;
  /** 液态扰动：法线随时间的噪声梯度。 */
  liquid: number;
  /** 磨砂：法线的高频抖动。 */
  frost: number;
  /** 环境反射的基准倍率（用户滑杆 `reflect` 在它上面乘）。 */
  env: number;
}

/**
 * 五种材质。
 *
 * ⚠️ 液金与玻璃的差别**不在颜色**，在 `metal / refract / liquid` 这三个通道上：
 * 一个把环境整块映出来还带波纹，另一个把环境折进来并按 IOR 分成三束。
 * 换色不该换材质 —— 所以面色是参数，不在这张表里。
 *
 * 液态金属有两档，差别只在**色散铺在哪**：`liquid` 整面虹彩（油膜感），
 * `liquidSoft` 内部是低饱和的金属明暗，只有最外一圈（倒角与波纹最陡处）
 * 才散色。前者靠 `irid`，后者靠 `iridEdge`。
 */
export const EXTRUDE_MATERIALS: Record<string, ExtrudeMaterial> = {
  metal: { metal: 1.0, rough: 0.22, refract: 0, ior: 1.5, disp: 0, irid: 0.06, iridEdge: 0, liquid: 0.06, frost: 0, env: 1.0 },
  liquid: { metal: 1.0, rough: 0.06, refract: 0, ior: 1.5, disp: 0, irid: 0.45, iridEdge: 0, liquid: 1.0, frost: 0, env: 1.45 },
  liquidSoft: { metal: 1.0, rough: 0.10, refract: 0, ior: 1.5, disp: 0, irid: 0.0, iridEdge: 1.0, liquid: 1.0, frost: 0, env: 1.5 },
  glass: { metal: 0.0, rough: 0.06, refract: 0.8, ior: 1.48, disp: 0.12, irid: 0, iridEdge: 0, liquid: 0, frost: 0.06, env: 1.0 },
  matte: { metal: 0.0, rough: 0.85, refract: 0, ior: 1.5, disp: 0, irid: 0, iridEdge: 0, liquid: 0, frost: 0, env: 0.35 },
  holo: { metal: 0.85, rough: 0.12, refract: 0, ior: 1.5, disp: 0, irid: 1.0, iridEdge: 0.35, liquid: 0.12, frost: 0, env: 1.1 },
};

/** 认不出的键（老工程 / 手改过的 JSON）落到金属，而不是渲一张黑图。 */
export const EXTRUDE_MATERIAL_FALLBACK = 'metal';

export const EXTRUDE_MATERIAL_OPTIONS: SelectParam['options'] = [
  { labelKey: 'algo.extrude.materialMetal', value: 'metal' },
  { labelKey: 'algo.extrude.materialLiquid', value: 'liquid' },
  { labelKey: 'algo.extrude.materialLiquidSoft', value: 'liquidSoft' },
  { labelKey: 'algo.extrude.materialGlass', value: 'glass' },
  { labelKey: 'algo.extrude.materialMatte', value: 'matte' },
  { labelKey: 'algo.extrude.materialHolo', value: 'holo' },
];

/**
 * 滑杆 `gloss` → 粗糙度。`gloss = 1` 时把基准压在 0.38 倍（**不归零**：
 * 完全镜面在程序化环境下会读成「塑料」，一点粗糙度才有金属的重量感）。
 */
export function extrudeRoughness(base: number, gloss: number): number {
  const g = Math.min(1, Math.max(0, gloss));
  return Math.min(1, Math.max(0.02, base * (1.9 - 1.52 * g)));
}

/* ------------------------------------------------------------------ 着色器 */

/**
 * 3D 值噪声。只为液态金属 / 磨砂的法线扰动服务 —— `noise-lib.ts` 那套
 * （value / gradient / voronoi × 2D/3D + fbm）在这里是杀鸡用牛刀，而它会把
 * 两百多行 GLSL 一起拉进这段 fragment。用 `HASH_FAST_GLSL`（无 sin）保证
 * 大坐标下不抖。
 */
const NOISE = `
float extrudeNoise(vec3 p) {
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
`;

const DECL = `
/* ---- 距离场（由 AlgoRuntime 的 aux 绑定，不经 setUniforms） ---- */
uniform sampler2D u_logo;      // R16F 有符号距离，单位 texel，内部为负
uniform sampler2D u_logoArt;   // 原图（面色贴图）；未绑素材时不在 aux 里

uniform vec2  u_logoRect;      // 距离场纹理覆盖的世界尺寸（含四周留白）
uniform vec2  u_logoContent;   // 内容区的世界尺寸（原图的 UV 只映射到这里）
uniform float u_logoTexel;     // 1 texel 的世界长度
uniform int   u_artOn;
uniform float u_artMix;

/* ---- 形体 ---- */
uniform float u_depth;         // 挤出厚度（世界单位）
uniform float u_bevel;         // 倒角半径

/* ---- 材质（表给基准，滑杆是倍率） ---- */
uniform float u_metal;
uniform float u_rough;
uniform float u_refract;
uniform float u_ior;
uniform float u_disp;
uniform float u_irid;
uniform float u_iridEdge;
uniform float u_liquid;
uniform float u_frost;
uniform float u_envAmt;

/* ---- 配色 ---- */
uniform vec3  u_face;
uniform vec3  u_side;
uniform vec3  u_envTop;
uniform vec3  u_envLow;
uniform vec3  u_rimCol;
uniform vec3  u_light;
uniform vec3  u_bg;
uniform float u_envBg;
uniform float u_rim;
uniform int   u_bgMode;

/* ---- 光照 ---- */
uniform float u_shadow;
uniform int   u_shadowSteps;

/* ---- 运镜 ---- */
uniform float u_spin;
uniform float u_bob;
uniform float u_yaw;
uniform float u_tilt;
uniform float u_dist;
`;

/**
 * 平面距离。
 *
 * 纹理只覆盖「内容区 + 四周留白」，留白之外没有信息 —— 那里的距离改用
 * **到内容框的距离**：内容框包含全部墨迹，所以它是一个真实下界（步进安全），
 * 而且比返回常数更紧（远处的射线几步就跨过来）。
 */
const SDF = `
float extrudePlane(vec2 q) {
  vec2 d = abs(q) - u_logoContent * 0.5;
  float outside = length(max(d, 0.0));
  vec2 uv = q / u_logoRect + 0.5;
  if (any(lessThan(uv, vec2(0.0))) || any(greaterThan(uv, vec2(1.0)))) return outside;
  return texture(u_logo, uv).r * u_logoTexel;
}

/**
 * 挤出体。圆角版：把二维距离与「到前后面的距离」当成两个约束，
 * 先在各自方向内缩 r 再统一外扩 r。
 *
 * 材质号（.y）用**两个约束谁的约束力更大**来分：表面上恰好有一项是 +r
 * （另一项 ≤ 0），所以这个比较在命中点上是稳定的 —— 正面 / 背面得 0，
 * 侧壁得 1，倒角上是两者的交界。它比「按法线判」准：倒角上的法线是斜的，
 * 用 n.z 会在同一条棱上逐像素翻。
 */
vec3 sdExtrude(vec3 p) {
  float d2 = extrudePlane(p.xy);
  float halfD = max(u_depth, 0.004) * 0.5;
  float r = clamp(u_bevel, 0.0, halfD);
  vec2 w = vec2(d2 + r, abs(p.z) - halfD + r);
  float d = min(max(w.x, w.y), 0.0) + length(max(w, 0.0)) - r;
  return vec3(d, step(w.y, w.x), 0.0);
}

/**
 * 法线（解析）。
 *
 * 为什么不用四面体差分：**距离场的梯度只在轮廓附近有意义**。EDT 给出的是
 * 「到最近边界的距离」，于是深处的梯度指向最近的边界点（那是中轴，不是曲面
 * 法线），而且它在 texel 之间是分片线性的 —— 差分跨过 texel 边界就抖。表现
 * 是平面上出现随内部分辨率变化的一圈圈条纹（实测 720p 特别明显）。
 *
 * 挤出的法线本来就能写出来：把两个约束的剩余量 (d2 + r, |z| - h + r) 当成
 * 局部坐标，轮廓的二维梯度当切向，三者归一化就是法线。表面上恰好有一项是
 * +r（另一项 ≤ 0）：
 *
 * - z 项为正 → 正面 / 背面，法线是 ±z；
 * - 平面项为正 → 侧壁，法线是轮廓的二维梯度；
 * - 两项都为正 → 倒角，法线随两个剩余量连续转过去。
 *
 * 只有倒角区要读二维梯度，而那里 |∇d2| ≈ 1、方向是连续的，本来就好。
 */
vec3 extrudeNormal(vec3 p, float d2, float e) {
  /* **中心**差分，不是单边。单边差分（只取正向）在一个 texel 的尺度上是偏的：
     采样点跨过 texel 边界时斜率整体跳一下，倒角的高光就跟着一节一节地跳。
     对称取样把这一步的偏差抵掉，剩下的误差是二阶的。 */
  float gy = extrudePlane(p.xy + vec2(0.0, e)) - extrudePlane(p.xy - vec2(0.0, e));
  float gx = extrudePlane(p.xy + vec2(e, 0.0)) - extrudePlane(p.xy - vec2(e, 0.0));
  vec2 g = vec2(gx, gy);
  float gl = length(g);
  // 退化（深处 / 数值噪声）时给一个朝外的任意方向，别让 normalize 出 NaN
  g = gl > 1e-6 ? g / gl : vec2(1.0, 0.0);

  float halfD = max(u_depth, 0.004) * 0.5;
  float r = clamp(u_bevel, 0.0, halfD);
  float wx = d2 + r;
  float wy = abs(p.z) - halfD + r;
  float sz = p.z >= 0.0 ? 1.0 : -1.0;

  if (wy <= 0.0) return normalize(vec3(g, 0.0));
  if (wx <= 0.0) return vec3(0.0, 0.0, sz);
  return normalize(vec3(g * wx, sz * wy));
}
`;

const CAM = `
/**
 * 运镜：绕原点公转 + 俯仰浮动。
 *
 * ⚠️ 这里**没有用** sdfOrbitCam / sdfCam：它们的右向量是 cross(up, f)，
 * 对 f = -z 给出 -x，于是画面是**左右镜像**的。分形左右对称，镜像看不出来；
 * 而这个生成器展示的是**文字与标志**，镜像是一眼可见的错（实测第一版把
 * A9X 画成了 X9A）。正确的那一条是 cross(f, up)。
 *
 * 不动 sdfCam 的理由：三个分形与 scene-3d 的既有效果都建立在那份取景上，
 * 改它等于重拍所有 3D 工程的画面。
 */
void extrudeCam(out vec3 eye, out vec3 rd) {
  float yaw = u_yaw + u_time * u_spin * 6.28318531;
  /* 浮动 = 俯仰角上一条慢正弦。它比上下平移更像「手持转台」，
     而且不改变到物体的距离（平移会让构图自己缩放）。 */
  float pitch = u_tilt + u_bob * 0.20 * sin(u_time * 0.85 + 1.7);
  float cp = cos(pitch);
  eye = vec3(sin(yaw) * cp, sin(pitch), cos(yaw) * cp) * u_dist;

  vec3 f = normalize(-eye);
  vec3 r = normalize(cross(f, vec3(0.0, 1.0, 0.0)));
  vec3 u = cross(r, f);
  // 列 = 右 / 上 / 前（mat3 的构造是列优先）
  rd = sdfRay(vUv, u_aspect, mat3(r, u, f));
}
`;

const LIGHT = `
/**
 * 程序化环境（影棚）。三个成分：天际线在**地平线稍下**的天地渐变、主光方向的
 * 柔光箱（宽底 + 亮核）、反方向的补光。
 *
 * 地平线的位置是调过的，不是随手写：默认机位在物体上方 16°，所以**正面**的
 * 反射方向指向斜下方（镜子里照到的是地面）。地平线放在 y ≈ 0 时正面会照到
 * 一片近黑的地面，整个标牌读成「一块黑塑料」；放在 -0.6 附近，正面照到的是
 * 地面与天光的过渡，倒角从朝上转到朝下时亮度整段翻转 —— 曲面因此读得出来。
 */
vec3 extrudeEnv(vec3 d) {
  vec3 col = mix(u_envLow, u_envTop, smoothstep(-0.62, 0.18, d.y));
  float key = max(dot(d, u_light), 0.0);
  col += u_envTop * 1.30 * pow(key, 7.0);
  /* 中等宽度的一档：液金靠它出「一片一片的亮面」（只有宽档是灰雾、只有窄档
     是点）。**按 u_liquid 缩放** —— 纯金属加满这一档会变成一层奶白，倒角的
     反差被糊掉。 */
  col += u_envTop * (0.18 + 0.5 * clamp(u_liquid, 0.0, 1.0)) * pow(key, 26.0);
  col += u_envTop * 0.85 * pow(key, 140.0);
  col += u_envLow * 1.10 * pow(max(dot(d, -u_light), 0.0), 2.5);
  return col;
}

/**
 * 背景 = 底色与环境的混合，**背景与折射共用这一个函数**。
 *
 * 共用的理由是玻璃：透射光必须采到「背景真的长什么样」，否则镜头里看到的
 * 背景与穿过去的背景是两个不同的东西，接缝处会亮出一圈「奶白」—— 那不是
 * 玻璃，是一块半透明的塑料。共用之后透视偏移会带动背景的明暗界线，玻璃才
 * 读得穿。
 */
vec3 extrudeSky(vec3 d) {
  return mix(u_bg, extrudeEnv(d) * 0.55, clamp(u_envBg, 0.0, 1.0));
}

/**
 * 折射（只在玻璃下跑）。
 *
 * ## 为什么要走第二次表面
 *
 * 只做法线处的折射，从射线里取到的环境方向与直接反射差不了几度，画面就是
 * 一整块均匀的灰白 —— 读成「磨砂塑料」而不是玻璃。玻璃之所以像玻璃，靠的是
 * **穿过厚度**：入射点与出射点错开，边缘因为路径长而沉色、掠射角发生全反射
 * （TIR）翻成银亮。这三件事都必须知道出射面在哪，所以这里沿折射方向在**实体
 * 内部**行进到出射点。
 *
 * 内部行进与外部步进的规则相反：内部距离是负的，所以每步走 -d（到最近表面
 * 的距离），而且**不会穿出去**（那正是 SDF 的性质）。24 步够穿过一枚标牌的
 * 最厚处；走不完（薄壁 + 掠射）就退回单面折射，不要让画面出现黑块。
 *
 * 出射时 refract 的 N 要取反：那个函数的约定是「N 逆着入射方向」，而内部
 * 射线的入射方向与外法线同侧。
 */
vec4 extrudeRefract(vec3 q, vec3 rd, vec3 n, float e, vec3 base, out float thick) {
  thick = 0.0;
  float ior = max(1.01, u_ior);
  vec3 rin = refract(rd, n, 1.0 / ior);
  // 全反射（从光密到光疏、掠射）在入射面就发生：退回反射，不留黑边
  if (dot(rin, rin) <= 0.0) return vec4(extrudeEnv(reflect(rd, n)), 0.0);

  /* 起点先跨过命中容差带：命中点上的 d 本来就 ≈ 0，从 0 开始判会立刻
     「到达出射面」，于是这一整段退化成「入射面折一次再原路折出来」。 */
  float t = max(u_eps, u_logoTexel) * 2.0;
  bool exited = false;
  for (int i = 0; i < 24; i++) {
    float d = sdExtrude(q + rin * t).x;
    if (d > -u_eps * 1.5) {
      exited = true;
      break;
    }
    t += max(-d, u_logoTexel * 0.5);
  }

  // 出射点与出射法线。没走到就按「无穷厚」处理（只做吸收）
  vec3 p2 = q + rin * t;
  vec3 outDir = rin;
  vec3 n2 = -n;
  if (exited) {
    n2 = extrudeNormal(p2, extrudePlane(p2.xy), e);
    outDir = refract(rin, -n2, ior);
    // 出射面全反射：光在内部折回来，读成一片银亮 —— 玻璃边缘的亮边就是它
    if (dot(outDir, outDir) <= 0.0) outDir = reflect(rin, n2);
  }

  /* 色散：三个通道用略微不同的出射角。只插值一次环境，不跑三趟几何。 */
  vec3 spread = normalize(outDir + n2 * u_disp);
  vec3 tint = vec3(
    extrudeSky(normalize(outDir - n2 * u_disp)).r,
    extrudeSky(outDir).g,
    extrudeSky(spread).b);

  /* 吸收按**走过的实际厚度**衰减（Beer-Lambert 的味道，系数靠肉眼定）。 */
  thick = t;
  float absorb = exp(-t * 2.4);
  return vec4(tint * mix(vec3(1.0), base * 1.5, 1.0 - absorb), exited ? 1.0 : 0.0);
}

/**
 * 液金扰动：返回**加到法线上的偏移向量**（未归一化）。
 *
 * 两层叠加，缺一层都不像液金：
 *
 * 1. **沿轮廓的正弦波**  sin(d2 * k)。等相线就是「离轮廓等距」的线，于是
 *    波纹顺着形状往外推 —— 这正是「从边缘扩散」的字面实现，不需要任何
 *    屏幕空间的流动图。振幅按 exp(-|d2|) 衰减，离轮廓越远越淡，否则整个
 *    面都是同心环（那读成等高线，不是液金）。
 * 2. **低频噪声团块**。只有第 1 层时波纹太规整；加上它才有「熔融的板」那种
 *    大块起伏，两者叠加出参差的边界 —— 参考图里那些逗号形的亮斑就是它。
 *
 * steep 回传「法线被扰动得有多厉害」，色散强度按它走：折射率差只有在**陡**
 * 的地方才分得开彩色，平缓处看不出虹彩。这一条是「边缘带一层色散」的由来。
 */
vec3 extrudeRipple(vec3 q, float d2, out float steep, out float ring) {
  float t = u_time;
  float amp = clamp(u_liquid, 0.0, 1.0);

  /* ① 熔融团块：**唯一**进入法线的项。
     它是连续的 —— 噪声场本身光滑，梯度用中心差分也不会在形体内部折线。 */
  float e2 = 0.12;
  vec3 np = q * 1.1 + vec3(0.0, -t * 0.22, t * 0.16);
  float n0 = extrudeNoise(np);
  float nx = extrudeNoise(np + vec3(e2, 0.0, 0.0));
  float ny = extrudeNoise(np + vec3(0.0, e2, 0.0));
  vec3 tilt = vec3((nx - n0) / e2, (ny - n0) / e2, 0.0) * amp * 1.05;

  /* ② 「顺着轮廓扩散」的波纹**不进法线，进明度**。
     为什么：距离场的梯度在中轴（三角形就是内心与三条角平分线）上不连续 ——
     它指向最近的边界，跨过中轴时方向整个翻掉。拿它当倾斜方向，形体内芯就会
     浮出一条 Y 形接缝（实测就是这样）。
     而 d2 本身是连续的，sin(d2·k) 的等相带是干净的同心带：改成调制亮度之后，
     波纹仍然沿着形状扩散，接缝消失。 */
  float k = 15.0;
  float ph = d2 * k - t * 1.8 + extrudeNoise(q * 0.7) * 5.0;
  ring = 0.5 + 0.5 * sin(ph);

  steep = length(tilt);
  return tilt;
}
`;

const MAIN = `
void main() {
  vec3 eye;
  vec3 rd;
  extrudeCam(eye, rd);

  /* glow 是材质型内核沿射线累积的**自发光场**，本生成器没有发光构件
     （SDF 的 .z 恒为 0），所以只当占位参数用。matId 是真用的：见下面 side。 */
  float matId = 0.0;
  float glow = 0.0;
  float hit = sdfMarchMat(eye, rd, matId, glow);
  if (hit < 0.0) {
    /* 背景 = 底色与「环境本身」的混合。为什么不是纯底色：玻璃要折射，
       金属要反射，而**平底**把两者都变成同一个常数 —— 材质选择在画面上
       什么也看不出来。envBg = 0 时退回纯底色（要精确控色的场合）。 */
    outColor = u_bgMode == 1 ? vec4(0.0) : vec4(extrudeSky(rd), 1.0);
    return;
  }

  vec3 q = eye + rd * hit;
  /* 法线走解析式（见 extrudeNormal）。梯度差分步长取 1.5 texel：轮廓附近的
     二维梯度方向在 texel 尺度上是连续的，跨几个 texel 平均一下就够平滑；
     取到 0.7 texel 反而落在栅格内部，倒角上会露出 texel 的折角。 */
  float e = max(u_logoTexel * 1.5, 1e-4);
  float d2q = extrudePlane(q.xy);
  /* nGeo 是**没被扰动**的几何法线。边缘色散要按它算：扰动的法线在波纹棱上
     也会变陡，拿它当「曲率大」的判据会让整面都亮起彩色。 */
  vec3 nGeo = extrudeNormal(q, d2q, e);
  vec3 n = nGeo;

  /* 材质扰动：液金是「熔融团块（法线）+ 沿轮廓扩散的明暗带（亮度）」，
     磨砂是高频抖动。steep 是扰动的陡度，色散强度按它走。 */
  float steep = 0.0;
  float ring = 0.5;
  if (u_liquid > 0.0) n = normalize(n + extrudeRipple(q, d2q, steep, ring));
  if (u_frost > 0.0) {
    vec3 np = q * 14.0;
    vec3 jit = vec3(extrudeNoise(np), extrudeNoise(np + 19.3), extrudeNoise(np + 47.1)) - 0.5;
    n = normalize(n + jit * (u_frost * 0.55));
  }

  vec3 V = -rd;
  float NoV = max(dot(n, V), 1e-3);
  float NoL = max(dot(n, u_light), 0.0);
  float ao = mix(1.0, sdfAOMat(q, n), 0.85);
  float sh = 1.0;
  if (u_shadow > 0.0 && u_shadowSteps > 0) {
    sh = mix(1.0, sdfShadowMat(q + n * e, u_light, e, u_maxDist, 12.0, u_shadowSteps),
             clamp(u_shadow, 0.0, 1.0));
  }

  /* 面色：正面 / 背面取面色，侧壁取侧面色。原图只贴在**正面**上 ——
     贴在侧壁等于把画面沿着棱折了九十度，没有对应的物理。 */
  float side = clamp(matId, 0.0, 1.0);
  vec3 base = mix(u_face, u_side, side);
  if (u_artOn == 1 && side < 0.5 && n.z > 0.0) {
    vec2 auv = clamp(q.xy / u_logoContent + 0.5, 0.001, 0.999);
    base = mix(base, texture(u_logoArt, auv).rgb, clamp(u_artMix, 0.0, 1.0));
  }

  float a = clamp(u_rough, 0.02, 1.0);
  vec3 F0 = mix(vec3(0.04), base, clamp(u_metal, 0.0, 1.0));
  float fres = pow(1.0 - NoV, 5.0);
  vec3 F = F0 + (1.0 - F0) * fres;
  if (u_irid > 0.0) {
    /* 薄膜干涉的廉价版：相位随视角与对象空间位置走，三通道错开三分之一圈。 */
    vec3 irid = 0.5 + 0.5 * cos(6.28318531 * (vec3(0.0, 0.33, 0.67) + NoV * 1.6 + q.z * 0.6));
    F *= mix(vec3(1.0), 0.6 + 0.9 * irid, clamp(u_irid, 0.0, 1.0));
  }

  /* 反射方向按粗糙度往法线收 —— 程序化环境没有 mip 可采，用方向模糊代替
     预过滤。收得太狠（> 0.9）会让哑光材质反射成一片死平的环境色。 */
  vec3 reflDir = normalize(mix(reflect(rd, n), n, a * 0.85));
  vec3 refl = extrudeEnv(reflDir);

  /* 波纹的**明暗带**。乘在反射上：它变的是「这块金属反射到多亮」，不是给表面
     刷一层颜色。振幅按离轮廓的距离淡出，离开轮廓就回到平金属 —— 否则整块板
     都是同心环，读成等高线。 */
  /* 环带的**屏幕带宽**：一个像素跨过多少世界单位（按掠射角修正），再换成
     「一个环占几个像素」。掠射面上环距会被压到一两个像素，那时它就是莫尔纹
     —— 按下限淡出，而不是让它糊成一片细横纹（实测近看侧壁就是这样）。 */
  float pxWorld = hit * u_fov / max(u_resolution.y, 1.0)
                / max(abs(dot(nGeo, rd)), 0.18);
  float bandPx = (6.28318531 / 15.0) / max(pxWorld, 1e-5);
  float ringAmt = clamp(u_liquid, 0.0, 1.0) * exp(-abs(d2q) * 1.6)
                * smoothstep(4.0, 14.0, bandPx);
  refl *= 1.0 + (ring - 0.5) * 1.5 * ringAmt;

  /* 色散：R / B 两个通道沿**视线的切向**各偏一点，G 不偏。偏移量按扰动陡度
     缩放 —— 平处法线几乎不动，偏一点也看不出；陡处三种折射率分得开，于是亮斑
     边缘浮出一圈彩虹。这不是贴图，是「同一个环境被三个方向读到」。
     轴向取 cross(n, V) 而不是轮廓梯度：后者在中轴上翻转（同 extrudeRipple 那条），
     会把彩虹也画出一条接缝。 */
  float edgeMask = smoothstep(0.10, 0.70, 1.0 - abs(nGeo.z));
  float chroma = clamp(
    u_irid * (0.25 + steep * 1.9) + u_iridEdge * edgeMask * (0.55 + steep * 1.1), 0.0, 1.0);
  if (chroma > 0.001) {
    vec3 axis = normalize(cross(n, V) + vec3(1e-5, 0.0, 0.0));
    float s = chroma * 0.11;
    refl = vec3(
      extrudeEnv(normalize(reflDir + axis * s)).r,
      refl.g,
      extrudeEnv(normalize(reflDir - axis * s)).b);
  }
  /* 反射吃 AO。金属的 kd 是 0，漫反射项整个消失 —— 如果 AO 只乘漫反射，
     金属就完全没有遮蔽，凹角与内壁跟正面一样亮，形体塌成一张贴纸。
     （sdfShade 里 AO 只压环境光，但它那套是给有漫反射的物体写的。） */
  refl *= mix(1.0, ao, 0.75);

  /* 漫反射的权重：金属没有漫反射；**玻璃也没有** —— 透射与漫反射是同一份
     入射能量的两种去向，两者都算上会得到一块奶白的板子（实测第一版就是）。
     留一点点（1 - refract 的残余）当厚度感。 */
  vec3 kd = base * (1.0 - clamp(u_metal, 0.0, 1.0)) * (1.0 - clamp(u_refract, 0.0, 1.0) * 0.8);
  vec3 amb = u_envLow * mix(0.30, 1.0, 0.5 + 0.5 * n.y) * ao;
  vec3 col = kd * (amb + NoL * sh * 0.9)
           + F * refl * u_envAmt
           + sdfSpec(n, V, u_light, NoV, NoL, a) * sh;

  /* 玻璃的「看见后面」由 **alpha** 承担，不是由颜色假装。
     一个生成器拿不到它下面的图层，所以只能交出不透明度：正向几乎全透、
     掠射全反射变实、厚处按路径长度补一点吸收。合成器会用这个 alpha 去和
     下层做 source-over —— 于是透明底时能真的看穿到下面的图层。 */
  float alpha = 1.0;
  if (u_refract > 0.0) {
    float thick = 0.0;
    vec4 refr = extrudeRefract(q, rd, n, e, base, thick);
    float tr = clamp(u_refract, 0.0, 1.0);
    /* 透射色只留一层薄雾（真正的透视在 alpha 里），否则玻璃会读成一块灰塑料 */
    col = mix(col, refr.rgb, 0.16 * tr * mix(0.55, 1.0, refr.a));
    float cover = pow(1.0 - NoV, 2.2);
    float solid = mix(0.05, 1.0, cover) + (1.0 - exp(-thick * 1.6)) * 0.30;
    alpha = mix(1.0, clamp(solid, 0.0, 1.0), tr);
  }

  /* 边缘光：倒角与外框是这枚标的「形体线」，不给它一点自发光，深色底上
     整个侧面会塌成一块黑。1-|n.z| 在正面为 0、侧壁为 1，倒角上是连续过渡。 */
  float edge = 1.0 - abs(n.z);
  col += u_rimCol * u_rim * pow(edge, 2.2) * (0.35 + 0.75 * NoL) * ao;

  /* 纯色底时「后面」就是这块底色本身，于是自己把自己压成不透明 —— 否则
     玻璃会在**自己的底**上开一个洞（透明底才是「交给下层」）。 */
  if (u_bgMode != 1) {
    col = mix(u_bg, col, alpha);
    alpha = 1.0;
  }
  outColor = vec4(clamp(col, 0.0, 1.0), alpha);
}
`;

export const EXTRUDE_FRAG =
  sdfKernelMaterial('sdExtrude') +
  sdfBRDFGLSL() +
  HASH_FAST_GLSL +
  DECL +
  NOISE +
  SDF +
  CAM +
  LIGHT +
  MAIN;

/* ------------------------------------------------------------------ 参数表 */

/** labelKey 显式给：拼模板串会退化成 string，文案键的编译期检查就没了。 */
function range(
  key: string,
  labelKey: MessageKey,
  min: number,
  max: number,
  step: number,
  defaultValue: number,
  visibleWhen?: (v: Record<string, number | string>) => boolean,
): ParamDef {
  const p: RangeParam = { key, labelKey, type: 'range', min, max, step, defaultValue };
  return visibleWhen ? { ...p, visibleWhen } : p;
}

/**
 * 质量参数：与 3D 家族同一套键与文案，四个值按本生成器的量级调过。
 *
 * `maxDist` 抬到 40 的依据是 `dist` 能拖到 6 —— 最远距离必须覆盖
 * 「相机在 6 个单位的球面上、物体半径约 1.4」，否则远景会被裁掉一块。
 */
function qualityParams(): ParamDef[] {
  return sdfQualityParams(88).map((p) => {
    if (p.type !== 'range') return p;
    if (p.key === 'stepScale') return { ...p, defaultValue: 0.85 };
    if (p.key === 'maxDist') return { ...p, min: 6, max: 40, defaultValue: 14 };
    if (p.key === 'eps') return { ...p, defaultValue: 0.0015 };
    if (p.key === 'fov') return { ...p, defaultValue: 1.0 };
    return p;
  });
}

export const extrudeMaterialDef: GeneratorDef = {
  id: 'extrude-material',
  nameKey: 'algo.extrude',
  kind: 'realtime',
  fragment: EXTRUDE_FRAG,
  auxTextures: [
    { uniform: 'u_logo', kind: 'logo-sdf', assetParam: 'logoAsset' },
    { uniform: 'u_logoArt', kind: 'asset-image', assetParam: 'logoAsset' },
  ],
  params: [
    {
      key: 'logoAsset',
      labelKey: 'algo.extrude.logoAsset',
      type: 'asset',
      defaultValue: '',
      accept: 'image',
    } satisfies AssetParam,
    {
      key: 'material',
      labelKey: 'algo.extrude.material',
      type: 'select',
      defaultValue: EXTRUDE_MATERIAL_FALLBACK,
      options: EXTRUDE_MATERIAL_OPTIONS,
    } satisfies SelectParam,
    range('depth', 'algo.extrude.depth', 0.02, 0.6, 0.01, 0.12),
    range('bevel', 'algo.extrude.bevel', 0, 0.3, 0.005, 0.03),

    { key: 'colorFace', labelKey: 'algo.extrude.face', type: 'color', defaultValue: '#d6dbe4' },
    { key: 'colorSide', labelKey: 'algo.extrude.side', type: 'color', defaultValue: '#8b93a1' },
    {
      key: 'artMix',
      labelKey: 'algo.extrude.artMix',
      type: 'range',
      min: 0,
      max: 1,
      step: 0.01,
      defaultValue: 0.9,
      // 没绑素材时这一项调什么都不会变（没有贴图可贴）—— 那是纯噪音。
      visibleWhen: (v) => String(v.logoAsset ?? '') !== '',
    } satisfies RangeParam,

    { key: 'colorEnvTop', labelKey: 'algo.extrude.envTop', type: 'color', defaultValue: '#e8eeff' },
    { key: 'colorEnvLow', labelKey: 'algo.extrude.envLow', type: 'color', defaultValue: '#2b3344' },
    { key: 'colorRim', labelKey: 'algo.extrude.rimCol', type: 'color', defaultValue: '#8fd9ff' },
    range('rim', 'algo.extrude.rim', 0, 1, 0.01, 0.45),
    range('reflect', 'algo.extrude.reflect', 0, 2, 0.01, 1),
    range('gloss', 'algo.sdf.gloss', 0, 1, 0.01, 0.6),

    range('lightAz', 'algo.sdf.lightAz', -180, 180, 1, -38),
    range('lightEl', 'algo.sdf.lightEl', -90, 90, 1, 42),
    range('shadow', 'algo.sdf.shadow', 0, 1, 0.01, 0.5),
    range('shadowSteps', 'algo.sdf.shadowSteps', 4, 24, 4, 12, (v) => Number(v.shadow ?? 0.5) > 0),

    range('spin', 'algo.extrude.spin', -1, 1, 0.01, 0.12),
    range('bob', 'algo.extrude.bob', 0, 1, 0.01, 0.3),
    range('yaw', 'algo.extrude.yaw', -180, 180, 1, 24),
    range('tilt', 'algo.extrude.tilt', -60, 60, 1, 16),
    range('dist', 'algo.sdf.dist', 1.6, 6, 0.05, 2.9),

    ...qualityParams(),
    {
      key: 'bgMode',
      labelKey: 'algo.bg.mode',
      type: 'select',
      defaultValue: 'solid',
      options: [
        { labelKey: 'algo.bg.solid', value: 'solid' },
        { labelKey: 'algo.bg.transparent', value: 'transparent' },
      ],
    } satisfies SelectParam,
    {
      key: 'bg',
      labelKey: 'algo.sdf.bg',
      type: 'color',
      defaultValue: '#0b0d12',
      visibleWhen: (v) => v.bgMode !== 'transparent',
    },
    range('envBg', 'algo.extrude.envBg', 0, 1, 0.01, 0.5, (v) => v.bgMode !== 'transparent'),
    { ...intResParam(), defaultValue: '720' },
  ],
  setUniforms: composeUniforms(sdfQualityUniforms(), (gl, l, v, ctx) => {
    const num = (k: string, d: number): number => {
      const x = Number(v[k]);
      return Number.isFinite(x) ? x : d;
    };
    const u1 = (name: string, x: number): void => {
      const p = l[name];
      if (p) gl.uniform1f(p, x);
    };
    const u2 = (name: string, x: number, y: number): void => {
      const p = l[name];
      if (p) gl.uniform2f(p, x, y);
    };

    const mat = EXTRUDE_MATERIALS[String(v.material)] ?? EXTRUDE_MATERIALS[EXTRUDE_MATERIAL_FALLBACK]!;

    /* 距离场的度量。真源是 `logo-sdf.ts` 的 `buildLogoField`：纹理里
       内容区居中、四周留白 `FIELD_PAD`，所以只要拿到 `w/h` 与 `pad` 就能
       反推出内容区与 texel 长度（长边固定 2 世界单位）。**不在这里重新
       定义口径** —— 三处各算一遍的话，某个数一漂轮廓就会整体涨缩。 */
    const field = ctx.aux?.get('u_logo');
    const pad = field?.pad ?? 0;
    const tw = field?.w ?? 1;
    const th = field?.h ?? 1;
    const cw = Math.max(1, tw - pad * 2);
    const ch = Math.max(1, th - pad * 2);
    const texel = 2 / Math.max(cw, ch);
    u2('u_logoRect', tw * texel, th * texel);
    u2('u_logoContent', cw * texel, ch * texel);
    u1('u_logoTexel', texel);

    const art = ctx.aux?.get('u_logoArt');
    set1i(gl, l, 'u_artOn', art ? 1 : 0);
    u1('u_artMix', num('artMix', 0.9));

    u1('u_depth', num('depth', 0.12));
    u1('u_bevel', num('bevel', 0.03));

    u1('u_metal', mat.metal);
    u1('u_rough', extrudeRoughness(mat.rough, num('gloss', 0.6)));
    u1('u_refract', mat.refract);
    u1('u_ior', mat.ior);
    u1('u_disp', mat.disp);
    u1('u_irid', mat.irid);
    u1('u_iridEdge', mat.iridEdge);
    u1('u_liquid', mat.liquid);
    u1('u_frost', mat.frost);
    u1('u_envAmt', mat.env * num('reflect', 1));

    set3(gl, l, 'u_face', String(v.colorFace ?? '#d6dbe4'));
    set3(gl, l, 'u_side', String(v.colorSide ?? '#8b93a1'));
    set3(gl, l, 'u_envTop', String(v.colorEnvTop ?? '#e8eeff'));
    set3(gl, l, 'u_envLow', String(v.colorEnvLow ?? '#2b3344'));
    set3(gl, l, 'u_rimCol', String(v.colorRim ?? '#8fd9ff'));
    set3(gl, l, 'u_bg', String(v.bg ?? '#0b0d12'));
    u1('u_envBg', num('envBg', 0.5));
    u1('u_rim', num('rim', 0.45));

    u1('u_shadow', num('shadow', 0.5));
    set1i(gl, l, 'u_shadowSteps', num('shadowSteps', 12));

    // 光方向：与 `sdfLightUniforms` 同口径（先绕 y 转方位、再抬仰角）。
    const az = (num('lightAz', -38) * Math.PI) / 180;
    const el = (num('lightEl', 42) * Math.PI) / 180;
    const ce = Math.cos(el);
    const light = l['u_light'];
    if (light) gl.uniform3f(light, Math.sin(az) * ce, Math.sin(el), Math.cos(az) * ce);

    u1('u_spin', num('spin', 0.12));
    u1('u_bob', num('bob', 0.3));
    u1('u_yaw', (num('yaw', 24) * Math.PI) / 180);
    u1('u_tilt', (num('tilt', 16) * Math.PI) / 180);
    u1('u_dist', Math.max(0.5, num('dist', 2.9)));
  }),
};
