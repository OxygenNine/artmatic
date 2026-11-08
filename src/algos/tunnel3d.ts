/**
 * tunnel3d.ts — 无限延伸的程序化 3D 隧道，realtime 型。
 *
 * ## 它为什么不是「一根弯管子」
 *
 * 参考画面（舞台背景素材）里那种隧道，靠的**不是**管道本身，而是四层叠加的
 * 结构性细节：壁面的板块划分、沿 z 重复的拱架、单元之间的装饰构件、以及
 * 窗外能看到的东西。所以这里的 SDF 不是「一个形状」，而是
 * 「一条连续的壁 + 一组按单元哈希布置的构件」，逐层并进同一个距离场：
 *
 * | 层 | 几何 | 作用 |
 * |---|---|---|
 * | 壁 | 薄壳 `abs(r − R) − t` | 隧道主体。**壳**而不是实心，于是窗外的空间存在 |
 * | 拱架 | (半径, z) 空间里的矩形环 | 沿 z 重复的框架，是最主要的「纵深尺」 |
 * | 鳍片 | 径向薄板，每格两根、角度随哈希 | 打破圆柱的旋转对称，给剪影 |
 * | 外部 | 环带上的方碑 | 透过开口能看见的东西；没有它「空心」是看不出来的 |
 *
 * 壁面上的板块缝、刻符、导轨**不是几何**，是着色期按 (极角, 单元) 算出来的 ——
 * 它们要的是「细节」而不是「体积」，做成几何会让步进成本翻三倍。
 *
 * ## 相机与曲线的三个约定
 *
 * 1. **中心线是 z 的函数**（两条正弦叠加），不是一条自由曲线。这是刻意的：
 *    自由曲线要「求最近点」才能算截面距离，那是个迭代问题，进不了 SDF。
 *    以 z 为参数时，横截面偏移只需把切向分量剪掉（见 `tunCoord` 的
 *    `perp`），一次叉积就够，而且在强弯下仍然正确。
 * 2. **世界坐标不进 uniform**。相机恒在局部原点，SDF 内部把局部坐标加上
 *    `u_travel` 还原成世界 z —— 于是 `p` 的量级永远是「镜头前方几十个单位」，
 *    不会出现「飞到第 300 单位时 float32 精度把细节磨平」。
 * 3. **视线顺着切线**（`look`），**侧倾顺着横向斜率**（`bank`）。俯仰角因此
 *    完全由曲线给出，用户不需要第二个控制器。
 *
 * ## 前进距离为什么是 `t × speed`
 *
 * 硬约束 1.1：**不许累积状态**。逐帧 `travel += speed * dt` 在 seek 时不可复现。
 * 代价是「拖动 speed 关键帧时镜头会跳一下」—— 这是可以接受的，因为它就写在
 * 参数上、用户看得见；而不可复现是看不见的。
 *
 * 该文件与 `sdf-lib.ts` 的 `sdfKernelMaterial` 配套：那个内核负责步进 /
 * 法线 / 遮蔽与「沿射线积分的光晕」，这里只有 SDF 与着色。
 */

import { bgModeParam, intResParam } from './shader-lib';
import { FBM6_GLSL } from '../effects/shader-def';
import {
  SDF_AA_MAIN,
  sdfKernelMaterial,
  sdfLightParams,
  sdfQualityParams,
  sdfUniforms,
} from './sdf-lib';
import { beatAtTime } from '../core/time';
import type { ParamDef } from '../effects/types';
import type { GeneratorDef } from './types';

const SD = 'sdTunnel';

/**
 * 风格 → 着色分支号。**取值进工程 JSON**（存的是字符串），所以这张表是
 * 协议的一部分：改名等于让老工程的风格静默退回霓虹。
 */
export const TUNNEL_STYLES: Record<string, number> = {
  neon: 0,
  ruins: 1,
  wire: 2,
  scope: 3,
};

/**
 * 管壁形态 → 分支号。同 `TUNNEL_STYLES`：取值进工程 JSON，改名等于让老工程静默退回
 * 「连续」。
 */
export const TUNNEL_WALLS: Record<string, number> = {
  solid: 0,
  rift: 1,
  none: 2,
};

/** 天空 → 分支号。同上。 */
export const TUNNEL_SKIES: Record<string, number> = {
  void: 0,
  stars: 1,
  grid: 2,
  aurora: 3,
};

/** 外景（隧道之外的几何）→ 分支号。同上。 */
export const TUNNEL_SCENES: Record<string, number> = {
  none: 0,
  monolith: 1,
  city: 2,
  pipes: 3,
};

/** 截面 → 分支号。同上。 */
export const TUNNEL_SECTIONS: Record<string, number> = {
  round: 0,
  polygon: 1,
  star: 2,
  gear: 3,
  wave: 4,
  cross: 5,
  petal: 6,
};

const BODY = `
const float TAU = 6.28318531;
const float PI  = 3.14159265;

/*
 * 光照与配色（与 sdfKernel 同名同义，由 sdfUniforms() 一次派发）。
 * 不声明它们就没法复用它那份派发，而「隧道再写一套 lightAz/lightEl」
 * 会让同一个概念在界面上出现两种叫法。
 */
uniform vec3  u_light;
uniform float u_gain;
uniform float u_fog;
uniform float u_ao;
uniform int   u_palette;
uniform vec3  u_color;
uniform vec3  u_colorB;
uniform vec3  u_bg;
/* 0 = 纯色底 · 1 = 透明底（运行期统一派发，不在这里写）。 */
uniform int   u_bgMode;
/*
 * 软阴影强度。**不能并进 sdfUniforms()** —— 那是两个内核共用的基础批，
 * 加进去就要求材质型内核也声明它，而 algo-uniforms 测试的「摸到未声明的
 * uniform」会立刻红。名字与 sdfKernel 那套同名同义，由隧道自己派发。
 */
uniform float u_shadow;

uniform int   u_style;     // 0 霓虹 · 1 废墟 · 2 线框 · 3 示波仪
uniform int   u_section;   // 截面分支
uniform float u_sides;     // 截面的边数 / 齿数 / 花瓣数
uniform float u_radius;    // 隧道半径
uniform float u_cell;      // 单元长度（世界的 z 单位）
uniform float u_vary;      // 单元之间的半径起伏
uniform float u_twist;     // 每单位 z 的截面扭转（弧度）
uniform float u_sway;      // 中心线的横向摆幅
uniform float u_rough;     // 壁面的凹凸（低频、各向异性）
uniform float u_rib;       // 单元边界的收腰强度
uniform float u_open;      // 开口的概率与大小
uniform int   u_wall;      // 管壁 0 连续 · 1 分段 · 2 关闭
uniform float u_riftEvery; // 分段：每几节
uniform float u_riftGap;   // 分段：其中空几节
uniform float u_panels;    // 板块 / 鳍片的密度
uniform float u_glyph;     // 壁面刻符
uniform float u_outside;   // 外景强度（尺寸 / 密度）
uniform int   u_sky;       // 天空 0 空白 · 1 星空 · 2 网格 · 3 极光
uniform int   u_scene;     // 外景 0 无 · 1 巨碑 · 2 城市 · 3 管网
uniform float u_sceneScale; // 外景尺度（街区间距 / 管径 / 巨环半径）
uniform float u_styleTint; // 风格染色：0 完全用配色参数，1 完全用风格的材质色
uniform float u_haze;      // 体积光 / 光晕强度
uniform float u_travel;    // 已经走了多远（= t × speed，JS 侧闭式算好）
uniform float u_look;      // 视线跟随切线的程度
uniform float u_bank;      // 侧倾跟随横向斜率的程度
uniform float u_pulse;     // 灯光随节拍起伏的强度
uniform float u_beat;      // 节拍冲量（0..1，闭式衰减）

/**
 * 眼位在**世界 xy** 上的偏移。
 *
 * 它只由 u_travel 决定，而 u_travel 在一次绘制里是常量 —— 所以算一次放在
 * 全局，别让步进循环里的每一次 SDF 求值都重算两条正弦。
 */
vec2 g_eye;

/**
 * 截面形状造成的**距离场高估**的全局修正（每次绘制算一次，见 main）。
 *
 * length(perp) − R(θ) 只在 R 不随 θ 变化时才是真距离。星形 / 齿轮 / 多边形
 * 在角上的 dR/dθ 可以到 1.5 以上，此时距离场按 1.4 倍高估，步进就会跨过薄构件。
 * 理论修正是除以 |∇d| = sqrt(1 + (R′/r)² + (R′·twist)²)；逐点算要两次额外的
 * secR，所以改成「按当前截面与边数取一次最坏值」。它偏保守（整幅都变小一步），
 * 但步进本来就是这个场景的成本大头，多点余量比多点噪点便宜。
 */
float g_lip;

/** 相机基与光轴（同样每次绘制一份）；g_camReady 是它们的惰性标志。 */
mat3 g_cam;
vec3 g_axis;
bool g_camReady;

float wrapAng(float a) {
  return mod(a + PI, TAU) - PI;
}

/** 中心线：z → xy 偏移。两条不同周期的正弦，避免出现「同一个弯」的观感。 */
vec2 pathAt(float z) {
  float k1 = TAU / (u_cell * 7.0);
  float k2 = TAU / (u_cell * 11.0);
  return vec2(sin(z * k1), sin(z * k2 + 1.7) * 0.72) * u_sway;
}

/** 中心线的一阶导。截面投影与视线方向都读它。 */
vec2 pathDer(float z) {
  float k1 = TAU / (u_cell * 7.0);
  float k2 = TAU / (u_cell * 11.0);
  return vec2(cos(z * k1) * k1, cos(z * k2 + 1.7) * 0.72 * k2) * u_sway;
}

/**
 * 截面半径的**角度调制**：极角 → 半径倍率。返回值以 1 为基准。
 *
 * 全部用极坐标写（而不是真正的多边形距离公式）：截面只用来造形，不要求
 * 距离精确，而极坐标写法的成本是一个 cos。误差由步进系数吸收。
 */
float secR(float a) {
  float n = max(u_sides, 3.0);
  if (u_section == 1) {
    float seg = TAU / n;
    float t = mod(a, seg) - seg * 0.5;
    return cos(seg * 0.5) / max(cos(t), 0.12);
  }
  if (u_section == 2) return mix(0.52, 1.0, 0.5 + 0.5 * cos(a * n));
  if (u_section == 3) return mix(0.70, 1.0, smoothstep(0.28, 0.72, 0.5 + 0.5 * cos(a * n)));
  if (u_section == 4) return 0.70 + 0.30 * abs(sin(a * n * 0.5));
  if (u_section == 5) {
    float s = 0.5 + 0.5 * cos(a * 4.0);
    return mix(0.38, 1.0, s * s * s);
  }
  if (u_section == 6) return 0.84 + 0.16 * cos(a * n);
  return 1.0;
}

/** (径向, 纵向) 平面里的矩形距离。2D 版本与 sdBox 同一条公式。 */
float box2(vec2 q, vec2 b) {
  vec2 d = abs(q) - b;
  return length(max(d, 0.0)) + min(max(d.x, d.y), 0.0);
}

float sdBox(vec3 p, vec3 b) {
  vec3 q = abs(p) - b;
  return length(max(q, 0.0)) + min(max(q.x, max(q.y, q.z)), 0.0);
}

/** 点到线段的距离（壁面刻符用）。 */
float seg2(vec2 p, vec2 a, vec2 b) {
  vec2 pa = p - a;
  vec2 ba = b - a;
  float h = clamp(dot(pa, ba) / max(dot(ba, ba), 1e-6), 0.0, 1.0);
  return length(pa - ba * h);
}

/**
 * 局部坐标 → 隧道坐标。
 *
 * 返回 (极角, 半径, 单元内比例 zc, 该处的壁半径 R)。着色期要用同一套量算
 * 板块缝与刻符，所以抽成函数 —— 几何与着色各写一遍的话，板块缝会与实际的
 * 板块错位，而那看起来像「贴图没对齐」，不像 bug。
 *
 * perp 是关键一步：把「到中心线的偏移」里**沿切线的分量**剪掉，剩下的才是
 * 真正的横截面偏移。不做这一步（直接 length(p.xy - c)）在强弯下截面会被
 * 拉成斜椭圆，弯得越狠隧道越像被压扁的喇叭。
 */
vec4 tunCoord(vec3 pc) {
  vec3 pw = vec3(pc.xy + g_eye, pc.z + u_travel);
  float z = pw.z;
  float zl = z / u_cell;
  float ci = floor(zl);
  float zc = zl - ci;

  vec2 c = pathAt(z);
  vec2 c1 = pathDer(z);
  vec2 off = pw.xy - c;
  float inv = 1.0 / (1.0 + dot(c1, c1));
  vec2 perp = off - c1 * dot(off, c1) * inv;

  float rr = max(length(perp), 1e-3);
  float ang = atan(perp.y, perp.x) - u_twist * z;

  /*
   * 单元之间用**平滑插值**的半径，不是每格一个常数：常数会在单元边界上
   * 留下一个宽度为 0 的环形缝（壁被掐断），而缝在画面里表现为一道能看穿的
   * 亮环 —— 那不是「装饰」，是破洞。
   */
  float sA = hash11(ci * 1.37 + u_seed * 31.0);
  float sB = hash11((ci + 1.0) * 1.37 + u_seed * 31.0);
  float cellScale = 1.0 + u_vary * 0.55 * (mix(sA, sB, smoothstep(0.0, 1.0, zc)) - 0.5);

  float nearEdge = min(zc, 1.0 - zc) * 2.0;
  float pinch = 1.0 - u_rib * 0.16 * (1.0 - smoothstep(0.0, 0.5, nearEdge));
  float base = u_radius * cellScale * pinch * secR(ang);
  /* 凹凸：两条斜交的低频正弦。用正弦而不是 fbm —— 这是每步都要求的量。 */
  base *= 1.0 + u_rough * 0.09 * sin(ang * 4.0 + z * 1.9) * sin(ang * 3.0 - z * 1.1);
  float R = base * (1.0 + 0.02 * u_panels * cos(zc * TAU * 3.0));

  return vec4(ang, rr, zc, R);
}

/**
 * 外景：隧道**之外**的几何。返回 (距离, 材质号)，材质 3 巨碑 · 4 楼群 · 5 地面 · 6 管网。
 *
 * 一律用**世界坐标**（pw 里已含眼位与 travel）算。只按 (极角, 单元) 算的话，
 * 楼群与管网会跟着镜头走 —— 看上去像贴在窗玻璃上的贴纸，而不是外面真的有东西。
 *
 * 只在 rr > R * 0.96 时被调用（见 sdTunnel）。管内的射线一定先撞到壁或拱架，
 * 跳过外景省掉的是**每一次步进**的九次盒求值，而不会漏掉任何更近的东西：
 * 管内任一点到外景物体的距离都大于它到壁的距离。
 */
vec2 sdScenery(vec3 pw, float ang, float rr, float R) {
  vec2 acc = vec2(1.0e6, 0.0);

  if (u_scene == 1) {
    /*
     * 两排巨柱：隧道左右各一排，每单元一根。
     *
     * 第一版想做成「绕隧道一圈的巨板」，用横截面的极角分方位 —— 那是错的：
     * 横截面的极角在 (x, y) 平面上，而竖立的柱子排在世界的 (x, z) 平面上，
     * 两个坐标系毫无关系。结果方位索引随求值点的位置乱跳 ⇒ 距离场处处不连续
     * ⇒ 画面碎成一片抖动的纸片。
     *
     * 沿 z 的轴线做「一圈柱子」在几何上本来就不成立（柱子只能分左右）。
     * 左右两侧都求值、z 方向取相邻两格的最小值，场就是连续的。
     */
    float zu = pw.z / u_cell;
    for (int k = 0; k < 2; k++) {
      float bi = floor(zu + float(k));
      float zObj = bi * u_cell;
      float cx = pathAt(zObj).x;
      for (int s2 = 0; s2 < 2; s2++) {
        float side = float(s2) * 2.0 - 1.0;
        float oh = hash21(vec2(bi * 1.7 + 0.31, side * 5.3 + u_seed * 13.0));
        if (oh < 0.10) continue;
        float rad = R * (1.45 + 1.75 * fract(oh * 7.3)) * mix(1.0, u_sceneScale, 0.7);
        float wR = R * (0.16 + 0.22 * fract(oh * 17.9));
        float wT = u_cell * (0.20 + 0.22 * fract(oh * 11.1));
        float hh = R * (1.4 + 3.2 * u_outside) * (0.45 + 0.75 * fract(oh * 3.7));
        float cy = R * 0.5 * (fract(oh * 23.1) - 0.4);
        vec3 oc = vec3(cx + side * rad, cy, zObj);
        float d = sdBox(pw - oc, vec3(wR, hh, wT));
        if (d < acc.x) acc = vec2(d, 3.0);
        /* 一部分柱顶再压一块窄的：单根是柱，叠起来才像建筑 */
        if (fract(oh * 19.7) > 0.45) {
          float h2b = hh * (0.30 + 0.40 * fract(oh * 29.3));
          float d2 = sdBox(pw - (oc + vec3(0.0, hh + h2b, 0.0)), vec3(wR * 0.65, h2b, wT * 0.7));
          if (d2 < acc.x) acc = vec2(d2, 3.0);
        }
      }
    }
  } else if (u_scene == 2) {
    /* --- 城市：一块地面 + 网格里的楼群 --- */
    /*
     * 地面压到 3R 之下：镜头在管轴上（y≈0），楼顶要是只低一两个单位，
     * 近处那几栋的**顶面**就会糊住整个画面下半部分 —— 看起来是一块发亮的板。
     */
    float gy = -(u_radius * 3.2 + 3.0);
    acc = vec2(pw.y - gy, 5.0);

    float cs = max(2.0, u_sceneScale * 5.5);
    vec2 g = pw.xz / cs;
    /*
     * 3×3 邻域。2×2 也「基本够用」，但相邻格里那一栋若恰好更近，距离会高估
     * 半条街 —— 步长按高估的距离迈，就会从楼里穿过去，表现为「某些角度下
     * 楼是透明的」。外景只在一部分射线上求值，九次盒求值买得下这个正确性。
     */
    vec2 c0 = floor(g + 0.5) - 1.0;
    for (int j = 0; j < 3; j++) {
      for (int i = 0; i < 3; i++) {
        vec2 cid = c0 + vec2(float(i), float(j));
        float oh = hash21(cid + u_seed * 7.0);
        if (oh < 0.12) continue;
        vec2 cc = (cid + 0.16 + 0.68 * fract(oh * 9.1)) * cs;
        /*
         * 楼高随「离中轴多远」增长：近处的压矮。否则高塔会从管壁里穿出来，
         * 那读起来不是「城市」，是「模型穿模」。
         */
        float tall = smoothstep(R * 2.0, R * 6.0, length(cc));
        float hgt = cs * (0.18 + 0.85 * tall) * (0.35 + 0.85 * fract(oh * 5.3));
        float w = cs * (0.16 + 0.12 * fract(oh * 13.7));
        /* hgt 是**总高**：盒心抬半个高度，楼顶才落在 gy + hgt */
        vec3 bc = vec3(cc.x, gy + hgt * 0.5, cc.y);
        float d = sdBox(pw - bc, vec3(w, hgt * 0.5, w));
        if (d < acc.x) acc = vec2(d, 4.0);
        /* 顶上的天线：远景里那一堆细竖线全靠它，少了就只剩一排方盒子 */
        if (fract(oh * 23.3) > 0.55) {
          float aa = hgt * 0.22 * fract(oh * 31.1);
          float da = sdBox(pw - (bc + vec3(0.0, hgt * 0.5 + aa, 0.0)), vec3(w * 0.07, aa, w * 0.07));
          if (da < acc.x) acc = vec2(da, 4.0);
        }
      }
    }
  } else if (u_scene == 3) {
    /*
     * 管网：几条与隧道同向的粗管，加几道套住整条隧道的巨环。
     * 管子按 (极角, 半径) 参数化、角度随 z 缓慢旋转 ⇒ 是**螺旋**，
     * 与 z 连续，既不需要哈希也不会在格边界上跳变。
     */
    float n = 2.0 + floor(u_sceneScale * 2.0);
    for (int k = 0; k < 6; k++) {
      if (float(k) >= n) break;
      float fk = float(k);
      float h1 = hash11(fk * 7.13 + u_seed * 3.0);
      float h2 = hash11(fk * 3.37 + 0.7 + u_seed * 5.0);
      float a0 = h1 * TAU;
      /*
       * 管子必须**贴着**隧道外层（1.2R 附近）才有存在感：一个半径 2 的隧道、
       * 0.85 的视场，能看见的横向范围在近处只有三四个单位 —— 放到 3R 之外
       * 就只剩远处几根细线，看起来像画面上的污渍。
       */
      float rp = R * (1.25 + 1.05 * h2) * mix(1.0, u_sceneScale, 0.4);
      float rad = R * (0.09 + 0.11 * fract(h1 * 5.7)) * (0.65 + 0.6 * u_outside);
      /* 近乎平行：慢速的螺旋才有「一束导管沿走廊走」的意思，快螺旋会让它们
         在画面上来回穿插，读成一片乱线 */
      float da = wrapAng(ang - (a0 + pw.z * (0.004 + 0.008 * h2))) * rr;
      float d = length(vec2(da, rr - rp)) - rad;
      if (d < acc.x) acc = vec2(d, 6.0);
    }
    /* 巨环：每三节套一道，半径大于隧道 —— 纵深与尺度全靠它 */
    float per = u_cell * 2.0;
    float bl = pw.z / per;
    float bbi = floor(bl + 0.5);
    float bzb = abs(bl - bbi) * per;
    float bigR = R * (1.30 + 1.10 * hash11(bbi * 3.1 + u_seed * 7.0)) * u_sceneScale;
    /* 圆截面（环管）而不是扁带：扁带在掠射角下是一条暗板，环管有一圈高光 */
    float dRing = length(vec2(rr - bigR, bzb)) - R * (0.05 + 0.06 * u_outside);
    /* 环用管网的材质（6）而不是碑的：金属高光才让它读成「环箍」，
       用混凝土色在暗场里就是一串黑色的链节 */
    if (dRing < acc.x) acc = vec2(dRing, 6.0);
  }

  return acc;
}

vec3 sdTunnel(vec3 pc) {
  vec3 pw = vec3(pc.xy + g_eye, pc.z + u_travel);
  float z = pw.z;
  float zl = z / u_cell;
  /*
   * 一切装饰都挂在**单元边界**上（而不是单元中心），并且哈希取自边界序号。
   *
   * 这不是风格选择，是距离场的正确性要求：按 cell 序号取哈希时，同一个边界
   * 在两侧属于不同的 cell、得到不同的半径与角度 ⇒ 几何在边界上跳变 ⇒
   * 实测 Lipschitz 比 8.1（>1）⇒ 步进按「距离」迈步会直接跨过拱架与鳍片，
   * 表现为「环被切成一段段的方块」。按边界序号取哈希之后，两侧算出的是
   * 同一个构件，zb 连续，距离场重新满足 Lipschitz ≤ 1。
   */
  float bi = floor(zl + 0.5);
  float zb = abs(zl - bi) * u_cell;

  vec4 tc = tunCoord(pc);
  float ang = tc.x;
  float rr = tc.y;
  float R = tc.w;

  float hb = hash11(bi * 1.37 + u_seed * 31.0);
  float hb2 = hash11(bi * 3.71 + 5.3 + u_seed * 31.0);

  vec2 c1 = pathDer(z);
  /* 斜切修正：距离沿真法线量，比沿 z 量的短一个 cos */
  float corr = inversesqrt(1.0 + dot(c1, c1));
  /* 扭转是**旋转**截面，距离场里没有它的导数 —— 转得快时把步长压一压 */
  float guard = g_lip / (1.0 + abs(u_twist) * 0.8);

  /*
   * 管壁三态：0 连续 / 1 分段（每 riftEvery 节里前 riftGap 节没有壁）/ 2 关闭。
   *
   * 去掉**整节**是「只减材料」，和窗口一样，所以按 cell 序号取模是安全的：
   * 算不出邻节的洞只会让距离偏小（保守），不会让射线穿过实体。
   * 拱架与灯带不受影响 —— 关掉管壁之后它们仍然勾出隧道的走向。
   */
  bool wallOn = true;
  if (u_wall == 2) {
    wallOn = false;
  } else if (u_wall == 1) {
    wallOn = mod(floor(zl), max(u_riftEvery, 1.0)) >= u_riftGap;
  }
  float d = wallOn ? (abs(rr - R) - 0.055) * corr * guard : 1.0e6;
  float mat = 0.0;
  float em = 0.0;

  /* 拱架：边界上一圈矩形截面的环，略微内凸。盒距离必须用 box2，
     写成 max(两个绝对值) 在角上会把距离高估到 1.41 倍。 */
  /*
   * 环的**径向必须厚**。从管内往外看，一个薄环（宽度远小于半径）在屏幕上只是
   * 一条「掠射带」：只有 tanθ 落在极窄一段里的射线才打得到它，其余要么从洞里穿过去、
   * 要么先撞上后面的壁 —— 于是环在画面上退化成一条颤抖的细线。
   * 环越厚，能打到它的角度范围越宽，才读得出「一道门框」。
   */
  float fR = R * (0.80 - 0.03 * hb2);
  float fw = R * (0.045 + 0.03 * u_rib);
  float fh = 0.05 + 0.04 * u_rib;
  float dFrame = box2(vec2(rr - fR, zb), vec2(fw, fh)) * corr * guard;
  if (dFrame < d) {
    d = dFrame;
    mat = 1.0;
  }
  /* 拱架周围的光晕场：步进沿射线把它积分成体积光 */
  em += 1.2 / (1.0 + 3.0 * max(dFrame, 0.0) * max(dFrame, 0.0));
  /* 导轨（4 条，沿 z 通长）也发光，但它没有几何 */
  float dRail = abs(mod(ang - 0.37, TAU * 0.25) - TAU * 0.125) * rr;
  em += 0.5 / (1.0 + 7.0 * dRail * dRail);

  /*
   * 螺旋条：沿隧道绕行的细管（霓虹里的灯带、废墟里的管线）。
   *
   * 它与 z **连续**（角度是 z 的一次函数），所以既不需要哈希也不会在边界上跳变。
   * 早先这一层是「每格两根径向鳍片」，按 cell 哈希取角度 —— 那等于让几何在
   * 边界上瞬移，距离场因此不满足 Lipschitz，步进跨过构件，画面表现为拱架被
   * 切成一排方块。连续参数化是这里唯一便宜的解法。
   */
  if (u_panels > 0.05) {
    float nPipe = floor(1.0 + u_panels * 3.9);
    float kp = 0.06 + 0.14 * u_panels;
    float rp = R * 0.93;
    for (int k = 0; k < 4; k++) {
      if (float(k) >= nPipe) break;
      float da = wrapAng(ang - (z * kp + float(k) * TAU / nPipe));
      float dPipe = length(vec2(da * rr, rr - rp)) - (0.018 + 0.016 * u_panels);
      if (dPipe < d) {
        d = dPipe;
        mat = 2.0;
      }
    }
  }

  /*
   * 开口：**单元中段**一扇，不碰拱架。
   *
   * 位置刻意放在 zc ≈ 0.5 而不是贴着边界：拱架就在边界上，贴着边界的开口会把
   * 霓虹环切成一排方块 —— 那不是「空心」，是「模型缺面」。中段开口与图三那种
   * 「环完整、墙上有洞」的观感一致。
   *
   * 哈希取自 cell 序号（而不是边界序号）在这里是安全的：开口**只减材料**，
   * 边界另一侧算不出这个洞只会让距离偏小（保守），不会让射线穿过实体。
   */
  if (u_open > 0.02 && wallOn) {
    float ci2 = floor(zl);
    float wh = hash11(ci2 * 7.77 + 11.0 + u_seed * 31.0);
    if (wh < u_open * 0.9) {
      vec4 tcm = tunCoord(pc);
      float angC = fract(wh * 13.7) * TAU;
      float halfW = (0.50 + 0.75 * fract(wh * 31.1)) * u_open * R;
      float halfZ = (0.16 + 0.30 * fract(wh * 47.3)) * u_open * u_cell;
      float da = abs(wrapAng(ang - angC)) * rr;
      float dz = abs(tcm.z - 0.5) * u_cell;
      d = max(d, -box2(vec2(da, dz), vec2(halfW, halfZ)) + 0.008);
    }
  }

  /*
   * 外景。门限取 R * 0.96 而不是「管外」：管内的射线一定先撞到壁或拱架，
   * 而外景物体全在 r > R 的地方，所以跳过它既安全又省掉绝大多数求值。
   */
  if (u_scene > 0 && u_outside > 0.02 && rr > R * 0.96) {
    vec2 sc = sdScenery(pw, ang, rr, R);
    if (sc.x < d) {
      d = sc.x;
      mat = sc.y;
    }
  }

  return vec3(d, mat, em);
}

/**
 * 命中点**到拱架的有符号距离**。着色期用它把拱架画成光带而不是掩码（见 main 里
 * frameMat 的说明）。
 */
vec2 frameInfo(vec3 pc) {
  vec4 tc = tunCoord(pc);
  float zl = (pc.z + u_travel) / u_cell;
  float bi = floor(zl + 0.5);
  float zb = abs(zl - bi) * u_cell;
  float hb2 = hash11(bi * 3.71 + 5.3 + u_seed * 31.0);
  float fR = tc.w * (0.80 - 0.03 * hb2);
  float fw = tc.w * (0.045 + 0.03 * u_rib);
  float fh = 0.05 + 0.04 * u_rib;
  /* .x 有符号距离；.y = 在环截面径向里的位置（0 内缘 .. 1 外缘）*/
  return vec2(box2(vec2(tc.y - fR, zb), vec2(fw, fh)), clamp((tc.y - fR + fw) / (2.0 * fw), 0.0, 1.0));
}

/** 调色板：单色 / 按上下 / 按法线。共用 algo.sdf.palette* 的文案。 */
vec3 paletteBase(float ang, vec3 n) {
  if (u_palette == 1) return mix(u_color, u_colorB, clamp(0.5 + 0.5 * sin(ang), 0.0, 1.0));
  if (u_palette == 2) return mix(u_color, u_colorB, clamp(n.y * 0.5 + 0.5, 0.0, 1.0));
  return u_color;
}

/**
 * 壁面的「印」：板块缝、刻符、导轨。返回 (明暗系数, 刻符, 导轨)。
 *
 * 三样都在 (极角 / 单元) 参数空间里算，不碰几何 —— 它们要的是细节量，
 * 做成 SDF 会让每一步都多几次求值，而画面上看不出体积差别。
 */
vec3 faceInk(float ang, float rr, float zc, float ci) {
  float nA = 8.0 + floor(u_panels * 10.0);
  float uu = ang / TAU * nA;
  float vv = zc * 3.0;
  float du = abs(fract(uu) - 0.5);
  float dv = abs(fract(vv) - 0.5);
  float seam = 1.0 - smoothstep(0.0, 0.06, min(du, dv));
  float ph = hash21(vec2(floor(uu), floor(vv) + ci * 2.7));
  float ink = (0.72 + 0.28 * ph) * (1.0 - 0.5 * seam);

  /*
   * 刻符：**稀疏**。每一格都刻就成了噪点墙 —— 参考画面里那些符号是零星出现的，
   * 而且只在几处面板上。所以先按格哈希决定「这一格刻不刻」，再在里面画笔画。
   */
  float glyph = 0.0;
  if (u_glyph > 0.01) {
    vec2 gg = vec2(uu * 5.0, vv * 3.5 + ci * 0.53);
    vec2 gid = floor(gg);
    vec2 gf = fract(gg) - 0.5;
    float gh = hash21(gid + 3.7);
    if (gh > 0.66) {
      float g = seg2(gf, vec2(-0.30, -0.28), vec2(0.30, -0.28));
      if (fract(gh * 7.3) > 0.42) g = min(g, seg2(gf, vec2(-0.28, -0.30), vec2(-0.28, 0.30)));
      if (fract(gh * 13.7) > 0.52) g = min(g, seg2(gf, vec2(-0.28, 0.28), vec2(0.28, 0.28)));
      if (fract(gh * 23.1) > 0.48) g = min(g, seg2(gf, vec2(0.28, -0.28), vec2(0.28, 0.06)));
      if (fract(gh * 31.7) > 0.44) g = min(g, seg2(gf, vec2(-0.28, 0.02), vec2(0.10, 0.02)));
      if (fract(gh * 43.3) > 0.56) g = min(g, seg2(gf, vec2(-0.02, -0.28), vec2(-0.02, 0.28)));
      glyph = (1.0 - smoothstep(0.02, 0.06, g)) * u_glyph;
    }
  }

  float rail = 1.0 - smoothstep(0.006, 0.05, abs(mod(ang - 0.37, TAU * 0.25) - TAU * 0.125) * rr);
  return vec3(ink, glyph, rail);
}

/**
 * 天空。四种可混搭：空白 / 星空 / 网格天空 / 极光。
 *
 * 与风格（u_style）**解耦**：风格管隧道本身怎么画，天空与外景各自选。
 * 之前天空写死在 u_outside 里、只认星点，于是四种风格共用同一片天 ——
 * 废墟看着像霓虹隧道开在宇宙里。天空读 tint（已含风格染色），
 * 所以「废墟 + 网格天空」会是沙色的网格而不是青色的。
 */
vec3 skyColor(vec3 rd, vec3 axis, float glow, vec3 base, vec3 tint) {
  vec3 col = u_bg;
  /*
   * 消失点辉光：指数要够高，否则宽视场下它会把整幅背景铺成一片渐变 ——
   * 管壁关掉之后这层是满屏可见的，不是「远处一点点亮」。
   */
  float ag = pow(max(dot(rd, axis), 0.0), 48.0);
  /* 用 tint 而不是 base：废墟/示波仪下隧道是棕的/绿的，尽头却还是洋红 ——
     两套配色在同一个画面里对不上 */
  col += tint * ag * (0.35 + 1.1 * u_haze) * (0.4 + glow * 0.05);

  /* 地平线附近压一层色调：天空有「地面那头」才不会像一块纯色板 */
  float hz = 1.0 - smoothstep(-0.10, 0.42, abs(rd.y));
  col += tint * hz * hz * 0.10 * (0.3 + u_haze);

  vec2 sph = vec2(atan(rd.x, rd.z), asin(clamp(rd.y, -1.0, 1.0)));

  if (u_sky == 1) {
    /* 星空：稀疏亮星 + 一条斜向的银河带 */
    vec2 gp = sph * vec2(150.0, 100.0);
    vec2 f = fract(gp) - 0.5;
    float h = hash21(floor(gp));
    float br = pow(h, 26.0) * 2.4;
    col += mix(tint, u_colorB, fract(h * 17.3)) * br * (1.0 - smoothstep(0.04, 0.30, length(f)));
    float band = exp(-pow(sph.y * 2.1 + 0.55, 2.0));
    col += mix(tint, u_colorB, 0.5) * band * vnoise2(sph * vec2(4.0, 9.0)) * 0.16;
  } else if (u_sky == 2) {
    /*
     * 网格天空：一张包住整个场景的经纬网。线宽用 fwidth 保证远处也是一像素，
     * 否则往上收束的那一半会碎成噪点。
     */
    vec2 gq = vec2(sph.x / TAU + 0.5, sph.y / PI + 0.5) * vec2(72.0, 40.0);
    vec2 gg = abs(fract(gq) - 0.5);
    float fwg = fwidth(gq.x);
    float w = clamp(fwg * 1.1, 0.02, 0.10);
    /* 同一个上限问题：靠近天顶时经线会收束成一片，必须按 fwidth 淡出 */
    float grid = (1.0 - smoothstep(w, w * 2.6, min(gg.x, gg.y))) * (1.0 - smoothstep(0.05, 0.16, fwg));
    /* 越靠地平线越亮：一张均匀的笼子读不出「天穹」 */
    float hw = pow(hz, 1.6);
    col += mix(tint, u_colorB, 0.45) * grid * (0.14 + 1.15 * hw);
    col += mix(tint, u_colorB, 0.75) * pow(hz, 4.0) * 0.26;
  } else if (u_sky == 3) {
    /*
     * 极光：**横向高频、纵向低频**的 fbm —— 极光是竖丝，不是云。
     * 用各向同性的 fbm 只会得到一层脏云（第一版就是这样）。
     */
    float tt = u_time * 0.04 + u_travel * 0.008;
    vec2 sp = vec2(sph.x * 5.5, sph.y * 0.8 - tt * 0.3);
    float n = fbm6(sp + vec2(tt, 0.0));
    float curtain = smoothstep(0.34, 0.88, n);
    /* 只挂在天空的中段：贴地的一半给城市，贴顶的一半给星 */
    curtain *= smoothstep(-0.30, 0.20, rd.y) * (1.0 - smoothstep(0.45, 0.95, rd.y));
    vec3 ac = mix(vec3(0.26, 1.0, 0.58), u_colorB, 0.35);
    col += ac * curtain * 0.55;
    col += tint * curtain * 0.18;
  }
  return col;
}

/**
 * 外景物体的着色（材质号见 sdScenery）。
 *
 * 三条约定，都是被画面逼出来的：
 *
 * 1. **体色是「被染色的混凝土」而不是纯配色**（mix(灰, tint, 0.3)）。直接用
 *    tint 乘一个小系数，整座城在暗场里就是一片和隧道同色的黑块，看不出是楼。
 * 2. **必须有半球光**。走廊场景的主光是沿视线的（斜向前下方），城市/碑体的
 *    侧面几乎拿不到 lam，只靠方向光的话它们全是黑的 —— 外面看起来像贴纸。
 * 3. **发光是「窗、棱、缝」，不是整体加亮**。远景里能读出尺度的是那些
 *    一格格亮起来的窗户与棱线，整体提亮只会得到一堆灰盒子。
 */
vec3 shadeScenery(float mat, vec3 pw, vec3 n, vec3 rd, vec3 tint) {
  float lam = max(dot(n, u_light), 0.0);
  float hemi = 0.5 + 0.5 * n.y;
  float fres = pow(1.0 - abs(dot(n, rd)), 2.5);
  vec3 body = mix(vec3(0.26, 0.27, 0.33), tint, 0.34);
  vec3 col;

  if (mat < 3.5) {
    /*
     * 巨碑：暗体 + 横向层线 + 顶面冷光。
     * 层线用世界 y 的周期，所以一栋碑上的层线是**水平**的 —— 之前那版用
     * (x+z) 的周期，斜纹在平壁上看起来像贴图的噪点。
     */
    /* 石材比别的材质更中性：染色太重就变成「粉色的板」，读不出体量 */
    vec3 b3 = mix(vec3(0.30, 0.29, 0.33), tint, 0.22);
    col = b3 * (0.34 + 0.72 * lam) + b3 * hemi * 0.34;
    /*
     * 层线要**软**：硬边的水平条纹在远处会打出一层摩尔纹，整块碑看起来像
     * 揉皱的纸。阈值放宽到 0.03..0.16 之后远处自然糊掉。
     */
    float course = abs(fract(pw.y * 0.55) - 0.5);
    col *= 1.0 - 0.15 * (1.0 - smoothstep(0.03, 0.16, course));
    col += mix(tint, u_colorB, 0.35) * smoothstep(0.84, 0.99, n.y) * 0.50;
    col += mix(tint, vec3(1.0), 0.25) * fres * 0.55;
  } else if (mat < 4.5) {
    /*
     * 楼群：暗体 + 亮窗。窗格用**世界坐标**画，所以楼体自己带着格子 ——
     * 贴图做不到这一点（楼是 SDF 里的盒子，没有 UV）。
     */
    float cs = max(2.0, u_sceneScale * 5.5);
    vec2 fuv = abs(n.x) > abs(n.z) ? pw.zy : pw.xy;
    vec2 wq = vec2(fuv.x * 1.05, fuv.y / 0.50);
    vec2 wf = abs(fract(wq) - 0.5);
    float pane = (1.0 - smoothstep(0.10, 0.26, wf.x)) * (1.0 - smoothstep(0.14, 0.34, wf.y));
    /*
     * 窗**只画在侧墙**上。顶面（n.y≈1）如果也吃到这个格子，楼顶就会长出一片
     * 发亮的窗纹 —— 从这个俯视角度看，那是画面里最抢眼的一块错误。
     */
    pane *= 1.0 - smoothstep(0.45, 0.85, abs(n.y));
    float lit = step(0.50, hash21(floor(wq) + floor(pw.xz / cs) * 3.7));
    /* 每栋楼的混凝土深浅略有不同，一整片同色会像塑料模型 */
    float tone = 0.75 + 0.5 * hash21(floor(pw.xz / cs) + 2.3);
    col = body * tone * (0.22 + 1.20 * lam) * 0.55 + body * hemi * 0.45;
    float warm = step(0.55, hash21(floor(wq) + 11.3));
    vec3 wc = mix(mix(tint, u_colorB, 0.55), vec3(1.0, 0.86, 0.62), warm * 0.75);
    col += wc * pane * lit * (0.85 + 0.9 * u_beat * u_pulse) * 1.15;
    /* 楼顶：一条亮边，远景点阵就是靠它连成天际线的 */
    col += mix(tint, vec3(1.0), 0.35) * smoothstep(0.90, 0.99, n.y) * 0.22;
    col += tint * fres * 0.16;
  } else if (mat < 5.5) {
    /* 地面：街网 + 贴地的雾光 */
    vec2 gq = pw.xz / max(2.0, u_sceneScale * 3.0);
    vec2 gf = abs(fract(gq) - 0.5);
    /*
     * 线宽的 AA 有一段**必须淡出**的上限。掠射角下 fwidth 会变得和一个格子
     * 一样宽，此时「线」覆盖了整块地面 —— 于是一整片地面被染成线色，看起来
     * 像一块发光的糖。上限只压到 0.06，再按 fwidth 淡出。
     */
    float fwq = fwidth(gq.x);
    float w = clamp(fwq * 1.1, 0.008, 0.06);
    float line = 1.0 - smoothstep(w, w * 2.4, min(gf.x, gf.y));
    line *= 1.0 - smoothstep(0.02, 0.07, fwq);
    col = body * 0.055 * (0.4 + 0.8 * lam);
    col += mix(tint, u_colorB, 0.5) * line * 0.42;
    /* 湿地面：一层低频噪声当反光斑，纯平的地面在这个视角下是一块死板 */
    col += mix(tint, u_colorB, 0.35) * pow(vnoise2(pw.xz * 0.35), 3.0) * 0.10;
    col += tint * 0.015;
  } else {
    /* 管网：金属感 —— 长高光 + 菲涅尔 + 每几米一圈发光的接头 */
    col = body * (0.45 + 1.10 * lam) + body * hemi * 0.55;
    float seam = abs(fract(pw.z * 0.20) - 0.5);
    col *= 1.0 - 0.30 * (1.0 - smoothstep(0.02, 0.06, seam));
    col += mix(tint, u_colorB, 0.4) * (1.0 - smoothstep(0.005, 0.03, seam)) * 0.8;
    col += mix(tint, vec3(1.0), 0.3) * fres * 0.38;
    /*
     * 朝向镜头的管面**拿不到菲涅尔**（dot(n, rd)≈1 ⇒ fres≈0）。细长的管与
     * 巨环在远处几乎全是这种朝向，只靠 lam/fres 就是一条黑线 —— 补一层常量
     * 底色，让它们在最不利的角度下也还剩个轮廓亮度。
     */
    col += mix(tint, u_colorB, 0.30) * 0.22;
    /* 管顶的灯带：远处那一圈圈暗管子靠它才串成结构 */
    col += mix(tint, vec3(1.0), 0.35) * pow(max(n.y, 0.0), 5.0) * 0.45;
  }
  return col;
}

/** 线框 / 示波仪共用的线网：环向、纵向、斜向三族。 */
float lineNet(float ang, float zc, float w) {
  float nA = 8.0 + floor(u_panels * 10.0);
  float uu = ang / TAU * nA;
  float vv = zc * 3.0;
  float l = min(abs(fract(uu) - 0.5), abs(fract(vv) - 0.5));
  /*
   * 线宽**至少一个像素**。固定宽度在远处会碎成白噪点 —— 那不是「线框」，
   * 是抗锯齿没做。上界 0.25 是因为 fwidth 在深度跳变处会炸（相邻像素落在
   * 完全不同的面上），不夹住的话整条线会在轮廓附近消失。
   */
  float aw = clamp(fwidth(uu) * 0.85, w, 0.25);
  return 1.0 - smoothstep(aw, aw * 2.0, l);
}

/**
 * 与射线**无关**的相机量：眼位、截面斜率修正、相机基、光轴。
 *
 * 它们只读 u_travel 与参数。留在 sdfSample() 里的话，抗锯齿每多一个子采样
 * 就重算一遍 —— 4×4 是 17 遍，而 msv 那一圈就是 32 次 secR。惰性标志而不是
 * 让共享 main 先调一次：sdfSample() 是 7 个生成器各自实现的，只有隧道需要
 * 这一步，为此改签名会把其余 6 个一起拖下水。
 */
void tunnelSetup() {
  if (g_camReady) return;
  g_camReady = true;

  g_eye = pathAt(u_travel);
  /* 截面在角度上的最大斜率（见 g_lip 的说明）。16 个采样点，成本可忽略。 */
  float msv = 0.0;
  for (int i = 0; i < 16; i++) {
    float a = float(i) * 0.3927;
    msv = max(msv, abs(secR(a + 0.05) - secR(a - 0.05)));
  }
  msv *= 10.0;
  g_lip = inversesqrt(1.0 + msv * msv + (msv * u_twist * u_radius) * (msv * u_twist * u_radius));
  vec2 td = pathDer(u_travel);
  g_axis = normalize(vec3(td * u_look, 1.0));
  /* 侧倾：横向斜率越大，画面越像在压弯 */
  float roll = clamp(-td.x * u_bank * 2.4, -0.6, 0.6);
  float cr = cos(roll);
  float sr = sin(roll);
  g_cam = sdfCam(vec3(0.0), g_axis) * mat3(vec3(cr, sr, 0.0), vec3(-sr, cr, 0.0), vec3(0.0, 0.0, 1.0));
}

vec4 sdfSample() {
  tunnelSetup();
  vec3 axis = g_axis;
  vec3 rd = sdfRay(sdfUv, u_aspect, g_cam);

  float mat = 0.0;
  float glow = 0.0;
  float hit = sdfMarchMat(vec3(0.0), rd, mat, glow);

  vec3 base = paletteBase(0.0, vec3(0.0, 1.0, 0.0));
  /*
   * 风格调色。放在命中判定**之前**算：天空与雾也读它，否则会出现
   * 「隧道是绿的、天空是洋红的」这种两套配色的画面。
   *
   * u_styleTint 是这件事的权重 —— 之前它是写死的系数（废墟 0.78 / 示波仪 0.65），
   * 于是那两种风格下配色参数基本不起作用，滑杆拖到底也只是「绿得不一样」。
   */
  vec3 tint = base;
  float st = clamp(u_styleTint, 0.0, 1.0);
  if (u_style == 1) tint = mix(base, vec3(0.58, 0.50, 0.42), st);
  else if (u_style == 3) tint = mix(base, vec3(0.34, 0.95, 0.44), st);

  if (hit <= 0.0) {
    vec3 bgc = skyColor(rd, axis, glow, base, tint);
    return u_bgMode == 1 ? vec4(0.0) : vec4(bgc, 1.0);
  }

  vec3 q = rd * hit;
  vec3 n = sdfNormalMat(q, 0.0022);
  /* 世界坐标（外景着色要用：楼群窗格、地面街网都是世界尺度的） */
  vec3 pw = vec3(q.xy + g_eye, q.z + u_travel);
  vec4 tc = tunCoord(q);
  float ang = tc.x;
  float rr = tc.y;
  float zc = tc.z;
  float z = q.z + u_travel;
  float ci = floor(z / u_cell);

  base = paletteBase(ang, n);
  vec3 fi = faceInk(ang, rr, zc, ci);
  float ink = fi.x;
  float glyph = fi.y;
  float rail = fi.z;
  float ao = mix(1.0, sdfAOMat(q, n), clamp(u_ao, 0.0, 1.0));
  /* 废墟的主光偏向「隧道尽头」：走廊的墙都朝内，纯方向光几乎不产生明暗 */
  vec3 keyDir = u_style == 1 ? normalize(u_light + vec3(0.15, 0.35, -1.1)) : u_light;
  /*
   * 软阴影只管主光，不乘 AO 也不乘自发光。
   *
   * 起点抬到 4e-3：刻符宽 6e-3 的一半，比 sdfNormalMat 的差分步长 2.2e-3
   * 大一档 —— 再小就是整片表面的自阴影痤疮。
   * maxt 只给 3.0（不是 u_maxDist）：隧道深景本来就是雾的活，阴影只需要管
   * 近处拱架与壁面之间的遮挡，给远了是白烧步数。
   */
  float sh = u_shadow > 0.0
    ? mix(1.0, sdfShadowMat(q + n * 0.004, keyDir, 0.004, 3.0, 10.0, 10), clamp(u_shadow, 0.0, 1.0))
    : 1.0;
  float lam = max(dot(n, keyDir), 0.0) * sh;
  float bak = max(dot(n, -u_light), 0.0) * 0.35;
  float rim = pow(1.0 - max(dot(n, -rd), 0.0), 2.4);
  /*
   * 拱架画成一条**有宽度的光带**，而不是二值材质掩码。
   *
   * mat 在拱架边界上跳变，而边界在缩小显示（预览 640x360 对内部 1280x720
   * 的 2:1 降采样）下会被采样成一块块硬边。用连续量混合，边界就成了坡。
   */
  vec2 fi2 = frameInfo(q);
  float frameMat = 1.0 - smoothstep(0.0, 0.08, fi2.x);
  /*
   * 环面**不能是纯色**：镜头贴着门框内侧时，环会占住画面的角，一整片平涂会被读成
   * 「渲染坏了」。内缘亮、外缘暗的渐变让它重新读成一条有厚度的光带。
   */
  float frameGrad = 1.0 - 0.55 * fi2.y;
  /*
   * 环有**两个面**：朝向镜头的环面（法线沿隧道轴）和朝轴心的内圆柱面。
   * 贴着门框时看到的是后者 —— 如果两个面一样亮，内圆柱面就是一整片平涂，
   * 读起来像「渲染坏了」。内圆柱压暗到 40%，环面保持满亮度，厚度才读得出来。
   */
  float faceOn = smoothstep(0.30, 0.85, abs(n.z));
  frameGrad *= mix(0.45, 1.0, faceOn);
  /* 环的**内外两条棱**给一条亮线：侧着看时它才像一根管，而不是一块板 */
  float frameEdge = smoothstep(0.16, 0.0, min(fi2.y, 1.0 - fi2.y));
  /* 极近的环要压暗：镜头穿过它时截面会糊满画面，压下去才是个过渡而不是一片白 */
  frameMat *= smoothstep(0.30, 1.9, hit);
  float pipeMat = step(1.5, mat) * step(mat, 2.5);
  float pulse = 1.0 + u_pulse * u_beat * 1.1;

  vec3 col;
  if (mat >= 2.5) {
    /*
     * 外景物体（楼群 / 地面 / 巨碑 / 管网）。它们离得远，雾要按距离压得更狠，
     * 否则远处的楼是一排硬边的黑块。
     */
    col = shadeScenery(mat, pw, n, rd, tint);
    /*
     * 外景的雾要**亮**一点：往 u_bg（近黑）沉的话，远处的管网会变成一圈黑链，
     * 在一片洋红辉光里格外扎眼。往「被照亮的雾」沉，远方才真的退到后面去。
     */
    float fadeS = 1.0 - exp(-hit * 0.030 * (0.3 + u_fog));
    col = mix(col, mix(u_bg, tint * 0.55, 0.55), clamp(fadeS, 0.0, 0.90));
    /* 体积辉光：外景表面在几十个单位外，中间那层雾光只该剩一点点 */
    col += mix(base, u_colorB, 0.5) * (1.0 - exp(-glow * 0.006)) * u_haze * 0.12 * exp(-hit * 0.02);
    col = 1.0 - exp(-col * u_gain * 1.15);
    return vec4(col, 1.0);
  }

  if (u_style == 2) {
    /* 线框：面只剩线，其余全是底 */
    float line = lineNet(ang, zc, 0.012);
    col = mix(base, u_colorB, 0.3) * line * (1.0 + 0.7 * pulse) * (0.4 + 0.6 * ao);
    col += base * frameMat * frameGrad * (0.35 + 1.1 * frameEdge) * 0.62;
  } else if (u_style == 3) {
    /* 示波仪：荧光绿色的线 + 扫描线 + 一条移动的扫描带 */
    float line = lineNet(ang, zc, 0.020);
    /* 扫描线 / 扫描带是屏幕空间效果：留在 vUv，不跟子采样移动。 */
    float scan = 0.35 + 0.65 * smoothstep(0.0, 1.0, 0.5 + 0.5 * sin(vUv.y * u_resolution.y * 2.1));
    float beam = exp(-pow((vUv.y - fract(u_time * 0.09)) * 5.0, 2.0));
    col = tint * line * (1.4 * scan + 2.2 * beam) * (0.55 + 0.45 * pulse);
    col += tint * frameMat * frameGrad * (0.45 + 0.9 * pulse) * scan;
    col += tint * rail * 0.5 * scan;
    col += tint * glyph * 0.10 * scan;
  } else if (u_style == 0) {
    /* 霓虹：壁压到近黑，光全在构件上 */
    col = tint * (0.006 + 0.105 * ink) * (0.5 + 0.9 * lam * ao);
    col += mix(base, vec3(1.0), 0.18) * frameMat * frameGrad * (0.55 + 1.7 * frameEdge) * (1.15 + 0.9 * pulse) * mix(0.55, 1.0, ao);
    col += u_colorB * pipeMat * (0.65 + 0.55 * pulse) * mix(0.4, 1.0, ao);
    col += mix(base, u_colorB, 0.5) * glyph * 0.28 * pulse;
    col += base * rail * 0.7 * pulse * mix(0.3, 1.0, ao);
    col += base * rim * 0.07 * ao;
  } else {
    /* 废墟：方向光 + 遮蔽读形体。刻符是**凿进去的**，吃不到主光，只在缝里留反光 */
    float dirt = vnoise2(vec2(ang * 2.6, z * 1.7));
    vec3 alb = tint * (0.50 + 0.70 * dirt) * (0.62 + 0.38 * ink);
    alb *= 1.0 - 0.40 * glyph;
    col = alb * (0.05 + 1.35 * lam * ao);
    col += alb * bak * 0.30 * ao;
    col += mix(tint, vec3(1.0), 0.6) * glyph * 0.22 * ao;
    col += tint * frameMat * frameGrad * (0.08 + 0.32 * lam) * ao;
    col += tint * pipeMat * 0.18 * ao;
    col += tint * rim * 0.25 * ao;
  }

  /* 深处的雾：往底色沉。任何风格都需要它，否则远端是一堆硬边 */
  float fade = 1.0 - exp(-hit * 0.03 * (0.3 + u_fog));
  vec3 fogCol = mix(u_bg, tint * 0.18, 0.45);
  col = mix(col, fogCol, clamp(fade, 0.0, 0.88));
  /* 沿射线累积的辉光：单镜头做不了真 bloom，这一层就是它 */
  col += mix(base, u_colorB, 0.5) * (1.0 - exp(-glow * 0.014)) * u_haze * 0.55;
  /* 软肩：直接把 3.0 截成白色会让霓虹管变成一块块硬白 */
  col = 1.0 - exp(-col * u_gain * 1.15);
  return vec4(col, 1.0);
}`;

export const TUNNEL3D_FRAG = FBM6_GLSL + sdfKernelMaterial(SD) + BODY + SDF_AA_MAIN;

/**
 * 本生成器的质量参数。
 *
 * 不复用 `sdfQualityParams()` 的**量程**：那套是给直径两三个单位的分形写的
 * （最远距离 4..32）。隧道要的是「看进去十来个单元」，同一条滑杆在 32 上就
 * 顶死了 —— 而最深处的拱架正是整个画面里最重要的一层。文案键仍然共用
 * `algo.sdf.*`，同一个概念不许有两种叫法。
 */
function qualityParams(): ParamDef[] {
  return sdfQualityParams(120).map((p): ParamDef => {
    if (p.key === 'stepScale') return { ...p, defaultValue: 0.8 } as ParamDef;
    if (p.key === 'maxDist') return { ...p, min: 6, max: 120, step: 1, defaultValue: 72 } as ParamDef;
    if (p.key === 'eps') return { ...p, min: 0.0008, max: 0.01, step: 0.0001, defaultValue: 0.0025 } as ParamDef;
    if (p.key === 'fov') return { ...p, min: 0.35, max: 2.2, step: 0.01, defaultValue: 0.85 } as ParamDef;
    return p;
  });
}

export const tunnel3dDef: GeneratorDef = {
  id: 'tunnel-3d',
  nameKey: 'algo.tunnel3d',
  kind: 'realtime',
  fragment: TUNNEL3D_FRAG,
  params: [
    {
      key: 'style',
      labelKey: 'algo.tunnel3d.style',
      type: 'select',
      defaultValue: 'neon',
      options: [
        { labelKey: 'algo.tunnel3d.styleNeon', value: 'neon' },
        { labelKey: 'algo.tunnel3d.styleRuins', value: 'ruins' },
        { labelKey: 'algo.tunnel3d.styleWire', value: 'wire' },
        { labelKey: 'algo.tunnel3d.styleScope', value: 'scope' },
      ],
    },
    /*
     * 天空与外景**与风格解耦**。风格管隧道本身怎么画；外面是什么由这两个滑杆决定，
     * 于是「废墟 + 网格天空 + 管网」这种组合不需要新增第四个风格 —— 风格 ×
     * 天空 × 外景是 4 × 4 × 4，逐个写成预设等于把组合爆炸塞进一个下拉框。
     */
    {
      key: 'sky',
      labelKey: 'algo.tunnel3d.sky',
      type: 'select',
      defaultValue: 'stars',
      options: [
        { labelKey: 'algo.tunnel3d.skyVoid', value: 'void' },
        { labelKey: 'algo.tunnel3d.skyStars', value: 'stars' },
        { labelKey: 'algo.tunnel3d.skyGrid', value: 'grid' },
        { labelKey: 'algo.tunnel3d.skyAurora', value: 'aurora' },
      ],
    },
    {
      key: 'scene',
      labelKey: 'algo.tunnel3d.scene',
      type: 'select',
      defaultValue: 'city',
      options: [
        { labelKey: 'algo.tunnel3d.sceneNone', value: 'none' },
        { labelKey: 'algo.tunnel3d.sceneMonolith', value: 'monolith' },
        { labelKey: 'algo.tunnel3d.sceneCity', value: 'city' },
        { labelKey: 'algo.tunnel3d.scenePipes', value: 'pipes' },
      ],
    },
    {
      key: 'sceneScale',
      labelKey: 'algo.tunnel3d.sceneScale',
      type: 'range',
      min: 0.4,
      max: 3,
      step: 0.01,
      defaultValue: 1.3,
      visibleWhen: (v) => v.scene !== 'none',
    },
    {
      key: 'styleTint',
      labelKey: 'algo.tunnel3d.styleTint',
      type: 'range',
      min: 0,
      max: 1,
      step: 0.01,
      defaultValue: 0.7,
      /* 霓虹 / 线框的材质底就是配色本身，这一项在那儿是恒等的 */
      visibleWhen: (v) => v.style === 'ruins' || v.style === 'scope',
    },
    {
      key: 'section',
      labelKey: 'algo.tunnel3d.section',
      type: 'select',
      defaultValue: 'polygon',
      options: [
        { labelKey: 'algo.tunnel3d.secRound', value: 'round' },
        { labelKey: 'algo.tunnel3d.secPolygon', value: 'polygon' },
        { labelKey: 'algo.tunnel3d.secStar', value: 'star' },
        { labelKey: 'algo.tunnel3d.secGear', value: 'gear' },
        { labelKey: 'algo.tunnel3d.secWave', value: 'wave' },
        { labelKey: 'algo.tunnel3d.secCross', value: 'cross' },
        { labelKey: 'algo.tunnel3d.secPetal', value: 'petal' },
      ],
    },
    {
      key: 'sides',
      labelKey: 'algo.tunnel3d.sides',
      type: 'range',
      min: 3,
      max: 12,
      step: 1,
      defaultValue: 5,
      visibleWhen: (v) => v.section !== 'round',
    },
    { key: 'radius', labelKey: 'algo.tunnel3d.radius', type: 'range', min: 0.9, max: 3.4, step: 0.01, defaultValue: 2.0 },
    { key: 'cell', labelKey: 'algo.tunnel3d.cell', type: 'range', min: 1.5, max: 16, step: 0.1, defaultValue: 4.2 },
    { key: 'vary', labelKey: 'algo.tunnel3d.vary', type: 'range', min: 0, max: 1, step: 0.01, defaultValue: 0.5 },
    { key: 'twist', labelKey: 'algo.tunnel3d.twist', type: 'range', min: -1.2, max: 1.2, step: 0.01, defaultValue: 0.12 },
    { key: 'sway', labelKey: 'algo.tunnel3d.sway', type: 'range', min: 0, max: 2.4, step: 0.01, defaultValue: 1.0 },
    { key: 'rough', labelKey: 'algo.tunnel3d.rough', type: 'range', min: 0, max: 1, step: 0.01, defaultValue: 0.25 },
    { key: 'rib', labelKey: 'algo.tunnel3d.rib', type: 'range', min: 0, max: 1, step: 0.01, defaultValue: 0.7 },
    {
      key: 'wall',
      labelKey: 'algo.tunnel3d.wall',
      type: 'select',
      /* 默认分段：连续管壁会把外面的城市完全挡住，而这个生成器的半条命在外景上 */
      defaultValue: 'rift',
      options: [
        { labelKey: 'algo.tunnel3d.wallSolid', value: 'solid' },
        { labelKey: 'algo.tunnel3d.wallRift', value: 'rift' },
        { labelKey: 'algo.tunnel3d.wallNone', value: 'none' },
      ],
    },
    {
      key: 'riftEvery',
      labelKey: 'algo.tunnel3d.riftEvery',
      type: 'range',
      min: 2,
      max: 12,
      step: 1,
      defaultValue: 5,
      visibleWhen: (v) => v.wall === 'rift',
    },
    {
      key: 'riftGap',
      labelKey: 'algo.tunnel3d.riftGap',
      type: 'range',
      min: 1,
      max: 6,
      step: 1,
      defaultValue: 1,
      visibleWhen: (v) => v.wall === 'rift',
    },
    {
      key: 'open',
      labelKey: 'algo.tunnel3d.open',
      type: 'range',
      min: 0,
      max: 1,
      step: 0.01,
      defaultValue: 0.55,
      /* 没有壁的时候，这个滑杆什么也切不到 —— 藏起来 */
      visibleWhen: (v) => v.wall !== 'none',
    },
    { key: 'panels', labelKey: 'algo.tunnel3d.panels', type: 'range', min: 0, max: 1, step: 0.01, defaultValue: 0.45 },
    {
      key: 'glyph',
      labelKey: 'algo.tunnel3d.glyph',
      type: 'range',
      min: 0,
      max: 1,
      step: 0.01,
      defaultValue: 0.3,
      /* 线框风格没有面可刻 —— 留着这个滑杆就是「拖了画面不动」 */
      visibleWhen: (v) => v.style !== 'wire',
    },
    {
      key: 'outside',
      labelKey: 'algo.tunnel3d.outside',
      type: 'range',
      min: 0,
      max: 1,
      step: 0.01,
      defaultValue: 0.6,
      visibleWhen: (v) => v.scene !== 'none',
    },
    { key: 'speed', labelKey: 'algo.tunnel3d.speed', type: 'range', min: 0, max: 8, step: 0.01, defaultValue: 2.6 },
    { key: 'look', labelKey: 'algo.tunnel3d.look', type: 'range', min: 0, max: 1, step: 0.01, defaultValue: 0.85 },
    {
      key: 'bank',
      labelKey: 'algo.tunnel3d.bank',
      type: 'range',
      min: 0,
      max: 1,
      step: 0.01,
      defaultValue: 0.5,
      visibleWhen: (v) => Number(v.look ?? 0) > 0,
    },
    { key: 'pulse', labelKey: 'algo.tunnel3d.pulse', type: 'range', min: 0, max: 1, step: 0.01, defaultValue: 0.6 },
    { key: 'haze', labelKey: 'algo.tunnel3d.haze', type: 'range', min: 0, max: 2, step: 0.01, defaultValue: 0.8 },
    ...qualityParams(),
    /* 配色只覆盖**默认值** —— 文案键与取值的口径仍然共用 sdfLightParams。 */
    ...sdfLightParams({ fog: 0.35, ao: 0.6 }).map((p): ParamDef => {
      if (p.key === 'color') return { ...p, defaultValue: '#ff3ec8' } as ParamDef;
      if (p.key === 'colorB') return { ...p, defaultValue: '#38d8ff' } as ParamDef;
      return p;
    }),
    /* 软阴影。文案键借用 `algo.sdf.shadow`（同一个概念），但**取值与实现是隧道自己的**：
       它的 eps 与刻符尺度是另一套，复用那 9 个着色参数只会把两套尺度混成一个。 */
    { key: 'shadow', labelKey: 'algo.sdf.shadow', type: 'range', min: 0, max: 1, step: 0.01, defaultValue: 0.6 },
    bgModeParam(),
    intResParam(),
  ],
  setUniforms: (gl, l, v, ctx) => {
    sdfUniforms()(gl, l, v, ctx);
    const set1f = (name: string, value: number): void => {
      const loc = l[name];
      if (loc) gl.uniform1f(loc, value);
    };
    const set1i = (name: string, value: number): void => {
      const loc = l[name];
      if (loc) gl.uniform1i(loc, Math.round(value));
    };

    set1i('u_style', TUNNEL_STYLES[String(v.style)] ?? 0);
    set1i('u_section', TUNNEL_SECTIONS[String(v.section)] ?? 0);
    set1i('u_wall', TUNNEL_WALLS[String(v.wall)] ?? 0);
    const every = Math.max(2, Math.round(Number(v.riftEvery ?? 4)));
    /* 空节数必须小于每几节，否则整条隧道都没有壁 —— 那是另一种形态（wall=none） */
    const gap = Math.min(Math.max(1, Math.round(Number(v.riftGap ?? 1))), every - 1);
    set1f('u_riftEvery', every);
    set1f('u_riftGap', gap);
    set1f('u_sides', Number(v.sides ?? 5));
    set1f('u_radius', Number(v.radius ?? 2));
    set1f('u_cell', Number(v.cell ?? 7));
    set1f('u_vary', Number(v.vary ?? 0.5));
    set1f('u_twist', Number(v.twist ?? 0.12));
    set1f('u_sway', Number(v.sway ?? 1));
    set1f('u_rough', Number(v.rough ?? 0.25));
    set1f('u_rib', Number(v.rib ?? 0.7));
    set1f('u_open', Number(v.open ?? 0.35));
    set1f('u_panels', Number(v.panels ?? 0.6));
    set1f('u_glyph', Number(v.glyph ?? 0.5));
    set1f('u_outside', Number(v.outside ?? 0.6));
    set1i('u_sky', TUNNEL_SKIES[String(v.sky)] ?? 1);
    set1i('u_scene', TUNNEL_SCENES[String(v.scene)] ?? 2);
    set1f('u_sceneScale', Number(v.sceneScale ?? 1.3));
    set1f('u_styleTint', Number(v.styleTint ?? 0.7));
    set1f('u_look', Number(v.look ?? 0.85));
    set1f('u_bank', Number(v.bank ?? 0.5));
    set1f('u_pulse', Number(v.pulse ?? 0.6));
    set1f('u_haze', Number(v.haze ?? 0.8));
    set1f('u_shadow', Number(v.shadow ?? 0.6));

    /*
     * 前进距离：**闭式**，不累积（硬约束 1.1）。`t` 是片段内的秒数。
     */
    const speed = Number(v.speed ?? 2.6);
    set1f('u_travel', ctx.t * speed);

    /*
     * 节拍冲量：与 `sceneUniforms` 同一口径（拍边界处 exp 衰减），
     * 所以「灯光跟着节拍闪」在没有音频的工程里也成立 —— 它读的是拍网格。
     * 再叠一点低频能量：有音乐时明暗对比更大，没音乐时是 0。
     */
    const bpm = ctx.grid.bpm > 0 ? ctx.grid.bpm : 120;
    const secPerBeat = 60 / bpm;
    const beat = beatAtTime(ctx.t, ctx.grid);
    const frac = beat - Math.floor(beat);
    const kick = Math.exp((-frac * secPerBeat) / 0.10);
    const bass = Number(ctx.features.bass) || 0;
    set1f('u_beat', Math.max(0, Math.min(1, 0.85 * kick + 0.55 * bass)));
  },
};
