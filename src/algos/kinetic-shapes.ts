/**
 * kinetic-shapes.ts — 跃动几何，`realtime` 型。
 *
 * ## 在画什么
 *
 * 满屏几何形（圆 / 方 / 三角 / 线 / 环）**各自按自己的节奏出现又消失**：
 * 每个形状有独立的相位、尺寸、角度与颜色，进出场动画可选（硬切 / 淡入淡出 /
 * 缩放 / 滑动以及它们的组合）。这是 MG（motion graphics）背景的主力 ——
 * 用排版编辑器也能拼出来，但那里每换一次构图都要重排一遍元素。
 *
 * ## 全部闭式，没有逐帧状态
 *
 * 每个形状的状态只由 `t` 决定：`fract(t·rate + 相位)` 给出它这一轮的生存进度。
 * 于是 seek 与顺序播放逐像素相同（硬约束 1.1），不需要快照，也不需要
 * 「先出现再消失」的累积量。`rate = 0` 时画面与 `t` 完全无关。
 *
 * ## 为什么是「逐形状循环 + 包围圆剔除」
 *
 * 形状会滑进滑出、位置可随机，所以「按像素所在的格子只算邻格」不成立
 * （一个形状可能从屏幕外滑到任何一个格子）。这里与 `streamlines` /
 * `polyhedron` 同一手法：循环 `u_count` 个形状，先算中心与半径，用一次
 * 距离比较把绝大多数形状剔掉，剩下的才算 SDF。因为位置/相位/角度全都
 * **与像素无关**，驱动通常能把它们提到循环外，真正付钱的是被剔掉的那些比较。
 *
 * ## 进/出场方式：`select` 在 JS 侧译成 `vec3`
 *
 * `realtime` 的 `floats()` 把字符串派发成 0（见 `src/algos/AGENTS.md`），
 * 而十个动画方式的差别是**三个通道的开关**（缩放档 / 滑动 / 淡入），
 * 不是十个分支。所以表在 JS（`ANIM_TABLE`），shader 只读
 * `vec3 u_inAnim`：`x` = 缩放档（0 无 / 1 从零开始 / 2 从「大」开始）、
 * `y` = 滑动、`z` = 淡入淡出。出场用同一张表，语义镜像（进入是
 * 「极端值 → 1」，离开是「1 → 极端值」）。
 *
 * 缩放档的两个极端值共用 `zoom` 参数，所以「由大缩小」在进场与出场里读的是
 * 同一个数 —— 用户的直觉就是「这个形状的缩放幅度」。
 *
 * ## 尺寸与分辨率解耦
 *
 * 尺寸的单位是**画面高的比例**，格子尺寸由 `layoutOf()` 按「每轴密度 × 宽高比」
 * 算好再传来（`u_cell`）。不用设备像素：`intRes` 是纯性能档位，改它不该改变
 * 构图（与 `grid` / `noise-field` 同一条纪律）。抗锯齿带宽取 `fwidth` 与
 * 一个像素的较大者 —— 低内部分辨率下不至于碎成点。
 *
 * ## 成本（实测，1280×720 视口、10 帧取 5 轮最小值、含一次读回摊薄）
 *
 * | 配置 | ms/帧 |
 * |---|---|
 * | 480p · 默认（6×3 = 18 个） | 1.25 |
 * | 480p · 密度 12（12×7 = 84 个） | 1.87 |
 * | 720p · 默认（18 个） | 1.46 |
 * | 720p · 密度 16（128 个，上限） | 4.08 |
 *
 * 每像素 `u_count` 次「3 个无 sin hash + 一次距离比较」，命中包围圆的才算
 * SDF（5 种形状都是十几条指令）。要盯的是 `density`，不是 `intRes`。
 */

import { HASH_FAST_GLSL, colors, floats, selectInt } from '../effects/shader-def';
import { bgColorVisible, bgModeParam, intResParam, type AlgoUniformCtx } from './shader-lib';
import type { SelectParam } from '../effects/types';
import type { GeneratorDef } from './types';

/**
 * 同时在场的形状上限：`layoutOf()` 的封顶与着色器里的循环上界都从这里来。
 *
 * 循环界必须是编译期常量（GLSL ES 的规矩），所以它是 `#define` 而不是 uniform；
 * 两边同源，于是「密度拉满」不会算出一堆永远渲不出来的形状。
 */
export const KS_MAX_SHAPES = 128;

/* ------------------------------------------------------------- 布局（纯） */

export interface KineticLayout {
  /** 网格列数（随机布局下是 1，不参与计算）。 */
  cols: number;
  /** 网格行数。 */
  rows: number;
  /** 实际在场的形状数（`u_count`）。 */
  count: number;
  /** 基准格边长（画面高的比例）：形状尺寸以它为参照。 */
  cell: number;
}

/**
 * 布局 → (列 × 行 · 数量 · 格边长)。
 *
 * **不是随手取整**，三处都有理由：
 *
 * 1. **格子尽量方**：行数按 `cols / aspect` 取，否则 16:9 里 6×6 的格子是扁的，
 *    `size` 一视同仁就会得到「横向挤在一起、纵向空一半」。
 * 2. **行列都从密度来**：网格的「密度」是每轴数量；`random` 的是**每轴**的
 *    空间密度，所以数量 = 密度²（一个 6×6 的空间里有 36 个点）。两者都不需要
 *    用户换算，切换布局时视觉密度是连续的。
 * 3. **数量封顶 `KS_MAX_SHAPES`**：超出的形状渲不出来（循环上界），留着会让
 *    「拖密度滑杆，前面几个格子先消失」这种半截行为出现。行数先收口，于是
 *    网格永远是完整的矩形。
 *
 * 纯函数、不碰 GL，单测直接打（`tests/unit/kinetic-shapes.test.ts`）。
 */
export function layoutOf(layout: string, density: number, aspect: number): KineticLayout {
  const d = Math.max(1, Math.min(16, Math.round(Number(density) || 6)));
  const a = Number.isFinite(aspect) && aspect > 0 ? aspect : 16 / 9;

  if (layout === 'random') {
    const count = Math.max(1, Math.min(KS_MAX_SHAPES, d * d));
    // 一个形状摊到的面积 = 整幅面积 / 数量；开方即「边长」。
    return { cols: 1, rows: 1, count, cell: Math.sqrt(a / count) };
  }

  const cols = d;
  const maxRows = Math.max(1, Math.floor(KS_MAX_SHAPES / cols));
  const rows = Math.max(1, Math.min(maxRows, Math.round(cols / a)));
  return { cols, rows, count: cols * rows, cell: Math.min(a / cols, 1 / rows) };
}

/* --------------------------------------------------- 进/出场动画（纯） */

/**
 * 动画方式 → `vec3`（x 缩放档 · y 滑动 · z 淡入淡出）。
 *
 * 缩放档：0 = 不缩放 · 1 = 从零（进）/ 到零（出）· 2 = 从「大」/ 到「大」
 * （倍数由 `zoom` 给）。十个选项只差这三个开关的组合，所以表只有一张；
 * 进场与出场共用它，语义分别是「极端 → 1」与「1 → 极端」。
 */
export const ANIM_TABLE: Record<string, readonly [number, number, number]> = {
  cut: [0, 0, 0],
  fade: [0, 0, 1],
  zoomIn: [1, 0, 0],
  zoomOut: [2, 0, 0],
  slide: [0, 1, 0],
  slideZoomIn: [1, 1, 0],
  slideZoomOut: [2, 1, 0],
  fadeZoomIn: [1, 0, 1],
  fadeZoomOut: [2, 0, 1],
  slideFade: [0, 1, 1],
};

/** 认不出的键（老工程 / 手改过的 JSON）落到硬切，而不是渲一片空白。 */
export const ANIM_FALLBACK = 'cut';

/** 带滑动的档位：`slideDir` / `slideDist` 只在这一档下可见。 */
const SLIDE_ANIMS = new Set(['slide', 'slideZoomIn', 'slideZoomOut', 'slideFade']);
/** 带「大」端的档位：`zoom` 只在这一档下可见。 */
const BIG_ANIMS = new Set(['zoomOut', 'slideZoomOut', 'fadeZoomOut']);

/**
 * 进场 / 出场的选项表。**值相同、文案镜像**（「由小放大」对「缩小消失」是
 * 同一个 `zoomIn`：进是 0 → 1，出是 1 → 0）。两张表分开写而不是拼前缀：
 * 文案键必须是字面量，否则 `MessageKey` 的类型检查在拼接后失效。
 */
const IN_OPTIONS: SelectParam['options'] = [
  { labelKey: 'algo.kinetic.inCut', value: 'cut' },
  { labelKey: 'algo.kinetic.inFade', value: 'fade' },
  { labelKey: 'algo.kinetic.inZoomIn', value: 'zoomIn' },
  { labelKey: 'algo.kinetic.inZoomOut', value: 'zoomOut' },
  { labelKey: 'algo.kinetic.inSlide', value: 'slide' },
  { labelKey: 'algo.kinetic.inSlideZoomIn', value: 'slideZoomIn' },
  { labelKey: 'algo.kinetic.inSlideZoomOut', value: 'slideZoomOut' },
  { labelKey: 'algo.kinetic.inFadeZoomIn', value: 'fadeZoomIn' },
  { labelKey: 'algo.kinetic.inFadeZoomOut', value: 'fadeZoomOut' },
  { labelKey: 'algo.kinetic.inSlideFade', value: 'slideFade' },
];

const OUT_OPTIONS: SelectParam['options'] = [
  { labelKey: 'algo.kinetic.outCut', value: 'cut' },
  { labelKey: 'algo.kinetic.outFade', value: 'fade' },
  { labelKey: 'algo.kinetic.outZoomIn', value: 'zoomIn' },
  { labelKey: 'algo.kinetic.outZoomOut', value: 'zoomOut' },
  { labelKey: 'algo.kinetic.outSlide', value: 'slide' },
  { labelKey: 'algo.kinetic.outSlideZoomIn', value: 'slideZoomIn' },
  { labelKey: 'algo.kinetic.outSlideZoomOut', value: 'slideZoomOut' },
  { labelKey: 'algo.kinetic.outFadeZoomIn', value: 'fadeZoomIn' },
  { labelKey: 'algo.kinetic.outFadeZoomOut', value: 'fadeZoomOut' },
  { labelKey: 'algo.kinetic.outSlideFade', value: 'slideFade' },
];

/* ---------------------------------------------------------------- 着色器 */

const BODY = `
#define KS_MAX ${KS_MAX_SHAPES}
#define KS_TAU 6.28318530718

uniform int   u_shape;      // 0 圆 · 1 方 · 2 三角 · 3 线 · 4 环 · 5 混合
uniform int   u_layout;     // 0 网格 · 1 错落 · 2 随机
uniform int   u_count;      // 在场形状数（由 layoutOf 算好）
uniform float u_cols;
uniform float u_rows;
uniform float u_cell;       // 基准格边长（画面高的比例）
uniform float u_jitter;     // 错落幅度（占格宽的比例）
uniform float u_size;       // 形状半径占格边长的比例
uniform float u_sizeVar;    // 逐形状大小差
uniform float u_rotation;   // 基础旋转（弧度）
uniform float u_spin;       // 自转（圈/秒）
uniform float u_rotVar;     // 逐形状初相（圈）
uniform float u_rate;       // 出现频率（次/秒）
uniform float u_duty;       // 一次循环里存在的时间占比
uniform float u_inTime;     // 进入时长（占存在时间的比例）
uniform float u_outTime;    // 离开时长（占存在时间的比例）
uniform vec3  u_inAnim;     // x 缩放档（0 无 / 1 从零 / 2 从大）· y 滑动 · z 淡入
uniform vec3  u_outAnim;
uniform int   u_ease;       // 0 线性 · 1 平滑 · 2 缓入 · 3 缓出 · 4 回弹
uniform int   u_slideDir;   // 0 上 · 1 下 · 2 左 · 3 右 · 4 向外 · 5 向内 · 6 随机
uniform float u_slideDist;  // 滑动距离（画面高的比例）
uniform float u_zoom;       // 「大」端的倍数
uniform float u_lineW;      // 线 / 环的粗细（占半径）
uniform int   u_phase;      // 0 随机 · 1 按序 · 2 径向
uniform int   u_audio;      // 0 关 · 1 响度 · 2 低频 · 3 高频 · 4 起音
uniform float u_audioAmt;
uniform float u_rms;
uniform float u_bass;
uniform float u_high;
uniform float u_hit;        // 每拍 / 每次起音的闭式衰减冲量
uniform vec3  u_colorA;
uniform vec3  u_colorB;
uniform float u_colorVar;   // 逐形状混色（0 = 全用 A）
uniform vec2  u_off;        // 整体平移（画面宽 / 高的比例）
uniform float u_variation;  // 版式种子（可打关键帧 ⇒ 构图可以渐变）
uniform vec3  u_bg;
uniform int   u_bgMode;

vec2 rot2(vec2 p, float a) {
  float c = cos(a);
  float s = sin(a);
  return vec2(p.x * c - p.y * s, p.x * s + p.y * c);
}

float sdBox2(vec2 p, vec2 b) {
  vec2 d = abs(p) - b;
  return length(max(d, 0.0)) + min(max(d.x, d.y), 0.0);
}

/* 等边三角形（顶点朝上），r 是外接半径 —— iq 的 sdEquilateralTriangle 同形。 */
float sdTri(vec2 p, float r) {
  p.x = abs(p.x) - r;
  p.y = p.y + r * 0.57735027;
  if (p.x + 1.7320508 * p.y > 0.0) p = vec2(p.x - 1.7320508 * p.y, -1.7320508 * p.x - p.y) * 0.5;
  p.x -= clamp(p.x, -2.0 * r, 0.0);
  return -length(p) * sign(p.y);
}

/* 五种形状都装在外接半径 r 里，于是包围圆剔除只需一个 r（见 main）。
   三角形的「r」在 iq 的式子里是**半宽**（三个角离中心 1.155r），所以这里
   先按 1/1.155 收一下，让它的外接圆正好是 r —— 与其它四种同一个口径。 */
float sdShape(vec2 p, int kind, float r) {
  float w = max(r * u_lineW, 1e-5);
  if (kind == 0) return length(p) - r;
  if (kind == 1) return sdBox2(p, vec2(r));
  if (kind == 2) return sdTri(p, r * 0.8660254);
  if (kind == 3) return sdBox2(p, vec2(r, w * 0.5));
  return abs(length(p) - r + w * 0.5) - w * 0.5;   /* 环：外缘正好落在 r 上 */
}

float ease01(float x) {
  x = clamp(x, 0.0, 1.0);
  if (u_ease == 0) return x;
  if (u_ease == 1) return x * x * (3.0 - 2.0 * x);
  if (u_ease == 2) return x * x;
  if (u_ease == 3) return 1.0 - (1.0 - x) * (1.0 - x);
  /* 回弹：末段略微冲过头再回来（1.70158 / 2.70158 是标准 back-out 常数）。 */
  float y = x - 1.0;
  return 1.0 + 2.70158 * y * y * y + 1.70158 * y * y;
}

void main() {
  vec2 p = (vUv - 0.5) * vec2(u_aspect, 1.0) - u_off * vec2(u_aspect, 1.0);
  float px = 1.0 / max(u_resolution.y, 1.0);

  /* 音频只调「尺寸 + 亮度」，两条都是可见的单向增量，不做节奏重排 ——
     重排会让画面随音频抖动而失去 MG 的编排感。 */
  float feat = 0.0;
  if (u_audio == 1) feat = u_rms;
  else if (u_audio == 2) feat = u_bass;
  else if (u_audio == 3) feat = u_high;
  else if (u_audio == 4) feat = u_hit;
  float boost = 1.0 + u_audioAmt * feat * 1.5;

  float inF = clamp(u_inTime, 0.0, 0.5);
  float outF = min(clamp(u_outTime, 0.0, 0.5), 1.0 - inF);
  float duty = clamp(u_duty, 0.05, 1.0);
  float slideLen = u_slideDist;

  /* 预乘累积：直通 alpha 下不能先把底色混进来（见 bgModeParam 的说明）。 */
  vec3 pm = vec3(0.0);
  float cover = 0.0;

  for (int i = 0; i < KS_MAX; i++) {
    if (i >= u_count) break;
    float fi = float(i);

    /* 三个 hash 派生全部随机量。它们**与像素无关**，所以整段循环的条件
       在同一个 quad 内一致 —— 后面的 fwidth 因此是安全的。 */
    float ha = hash11(fi * 1.37 + u_variation * 137.0 + u_seed * 61.0);
    float hb = hash11(fi * 4.11 + 17.0 + u_variation * 211.0 + u_seed * 23.0);
    float hc = hash11(fi * 7.77 + 41.0 + u_variation * 97.0 + u_seed * 7.0);

    vec2 c;
    if (u_layout == 2) {
      c = (vec2(ha, hb) - 0.5) * vec2(u_aspect, 1.0);
    } else {
      vec2 grid = vec2(mod(fi, u_cols), floor(fi / u_cols));
      c = (grid + 0.5) / vec2(u_cols, u_rows) - 0.5;
      c *= vec2(u_aspect, 1.0);
      if (u_layout == 1) {
        c += (vec2(ha, hb) - 0.5) * vec2(u_aspect / u_cols, 1.0 / u_rows) * u_jitter;
      }
    }

    float rad = u_size * u_cell * 0.5 * mix(1.0, 0.4 + hc * 1.2, u_sizeVar) * boost;
    if (rad < px) continue;

    /* 生存进度：一轮 1/rate 秒，其中 duty 的部分在场。 */
    float ph;
    if (u_phase == 1) ph = fi / max(float(u_count) - 1.0, 1.0);
    else if (u_phase == 2) {
      float rmax = max(length(vec2(u_aspect, 1.0)) * 0.5, 1e-4);
      ph = clamp(length(c) / rmax, 0.0, 1.0);
    } else ph = fract(ha * 13.7 + hb * 7.3);

    float cyc = fract(u_time * u_rate + ph);
    if (cyc >= duty) continue;
    float s = cyc / duty;

    /* 进场 / 出场进度。时长为 0 时直接取端点（等价于「没有这一段」）。 */
    float pe = inF > 0.0 ? ease01(clamp(s / inF, 0.0, 1.0)) : 1.0;
    float pxx = outF > 0.0 ? ease01(clamp((s - (1.0 - outF)) / outF, 0.0, 1.0)) : 0.0;

    float sc = 1.0;
    if (u_inAnim.x > 0.5) sc *= u_inAnim.x < 1.5 ? max(pe, 0.0) : mix(u_zoom, 1.0, pe);
    if (u_outAnim.x > 0.5) sc *= u_outAnim.x < 1.5 ? max(1.0 - pxx, 0.0) : mix(1.0, u_zoom, pxx);
    if (sc <= 0.001) continue;

    vec2 dir;
    if (u_slideDir == 0) dir = vec2(0.0, 1.0);
    else if (u_slideDir == 1) dir = vec2(0.0, -1.0);
    else if (u_slideDir == 2) dir = vec2(-1.0, 0.0);
    else if (u_slideDir == 3) dir = vec2(1.0, 0.0);
    else if (u_slideDir == 4) dir = normalize(c + vec2(1e-5));
    else if (u_slideDir == 5) dir = -normalize(c + vec2(1e-5));
    else dir = normalize(vec2(ha - 0.5, hb - 0.5) + vec2(1e-4));

    vec2 off = vec2(0.0);
    if (u_inAnim.y > 0.5) off -= dir * slideLen * (1.0 - pe);
    if (u_outAnim.y > 0.5) off += dir * slideLen * pxx;

    float ang = u_rotation + u_spin * u_time * KS_TAU + (hc * 2.0 - 1.0) * u_rotVar * KS_TAU;
    int kind = u_shape;
    if (kind == 5) kind = int(floor(fract(hb * 7.13 + ha * 3.7) * 5.0));

    /* 先包围圆剔除再算 SDF：绝大多数形状在这里就被否掉。
       ⚠️ 半径必须取 **1.5r**，不是 r —— 方的角在 r√2、三角的角在 1.155r，
       按 r 剔除会把它们的角切掉：方的四个角被切圆的判据恰好是「方形内接圆」，
       于是「方」直接画成一个圆，而且**全程不报错**（实测踩过）。 */
    vec2 q = rot2(p - c - off, -ang);
    float bound = rad * 1.5 * sc + px * 4.0;
    if (dot(q, q) > bound * bound) continue;

    /* 缩放 = 距离场除以 sc 再乘回来（等距变换比例），形状不会变形。 */
    float d = sdShape(q / sc, kind, rad) * sc;
    float fw = max(fwidth(d), px * 0.75);
    float m = 1.0 - smoothstep(-fw, fw, d);

    if (u_inAnim.z > 0.5) m *= clamp(pe, 0.0, 1.0);
    if (u_outAnim.z > 0.5) m *= clamp(1.0 - pxx, 0.0, 1.0);
    if (m <= 0.0) continue;

    vec3 col = mix(u_colorA, u_colorB, clamp(u_colorVar * fract(hc * 5.31 + ha * 2.17), 0.0, 1.0));
    col *= 1.0 + u_audioAmt * feat * 0.6;

    pm = col * m + pm * (1.0 - m);
    cover = m + cover * (1.0 - m);
  }

  float a = clamp(cover, 0.0, 1.0);
  vec3 lit = pm / max(cover, 1e-4);
  /* 透明底吐「墨色 + 覆盖度」（直通 alpha），与 TINT_FRAG 同一约定。 */
  outColor = u_bgMode == 1 ? vec4(lit, a) : vec4(mix(u_bg, lit, a), 1.0);
}`;

/* ------------------------------------------------------------------ 参数 */

const SHAPES: Record<string, number> = {
  circle: 0,
  square: 1,
  triangle: 2,
  line: 3,
  ring: 4,
  mix: 5,
};

const LAYOUTS: Record<string, number> = { grid: 0, scatter: 1, random: 2 };
const EASES: Record<string, number> = { linear: 0, smooth: 1, in: 2, out: 3, back: 4 };
const SLIDE_DIRS: Record<string, number> = {
  up: 0,
  down: 1,
  left: 2,
  right: 3,
  outward: 4,
  inward: 5,
  random: 6,
};
const PHASES: Record<string, number> = { random: 0, order: 1, radial: 2 };
const AUDIOS: Record<string, number> = { off: 0, rms: 1, bass: 2, high: 3, onset: 4 };

/** `slideDir` / `slideDist` 的可见性：只有某一侧真的滑才给。 */
const usesSlide = (v: Record<string, number | string>): boolean =>
  SLIDE_ANIMS.has(String(v.inMode)) || SLIDE_ANIMS.has(String(v.outMode));

/** `zoom` 的可见性：只有某一侧真的用「大」端才给。 */
const usesBig = (v: Record<string, number | string>): boolean =>
  BIG_ANIMS.has(String(v.inMode)) || BIG_ANIMS.has(String(v.outMode));

/** `lineW` 的可见性：线与环才有粗细。混合形态里也有它们，所以一并算上。 */
const usesLineW = (v: Record<string, number | string>): boolean =>
  v.shape === 'line' || v.shape === 'ring' || v.shape === 'mix';

export const kineticShapesDef: GeneratorDef = {
  id: 'kinetic-shapes',
  nameKey: 'algo.kineticShapes',
  kind: 'realtime',
  fragment: HASH_FAST_GLSL + BODY,
  params: [
    {
      key: 'shape',
      labelKey: 'algo.kinetic.shape',
      type: 'select',
      defaultValue: 'mix',
      options: [
        { labelKey: 'algo.kinetic.shapeCircle', value: 'circle' },
        { labelKey: 'algo.kinetic.shapeSquare', value: 'square' },
        { labelKey: 'algo.kinetic.shapeTriangle', value: 'triangle' },
        { labelKey: 'algo.kinetic.shapeLine', value: 'line' },
        { labelKey: 'algo.kinetic.shapeRing', value: 'ring' },
        { labelKey: 'algo.kinetic.shapeMix', value: 'mix' },
      ],
    },
    {
      key: 'layout',
      labelKey: 'algo.kinetic.layout',
      type: 'select',
      defaultValue: 'grid',
      options: [
        { labelKey: 'algo.kinetic.layoutGrid', value: 'grid' },
        { labelKey: 'algo.kinetic.layoutScatter', value: 'scatter' },
        { labelKey: 'algo.kinetic.layoutRandom', value: 'random' },
      ],
    },
    { key: 'density', labelKey: 'algo.kinetic.density', type: 'range', min: 1, max: 16, step: 1, defaultValue: 6 },
    {
      key: 'jitter',
      labelKey: 'algo.kinetic.jitter',
      type: 'range',
      min: 0,
      max: 1,
      step: 0.01,
      defaultValue: 0.35,
      visibleWhen: (v) => v.layout !== 'random',
    },
    { key: 'size', labelKey: 'algo.kinetic.size', type: 'range', min: 0.05, max: 1.2, step: 0.01, defaultValue: 0.5 },
    {
      key: 'sizeVar',
      labelKey: 'algo.kinetic.sizeVar',
      type: 'range',
      min: 0,
      max: 1,
      step: 0.01,
      defaultValue: 0.25,
    },
    {
      key: 'rotation',
      labelKey: 'algo.kinetic.rotation',
      type: 'range',
      min: -180,
      max: 180,
      step: 1,
      defaultValue: 0,
    },
    { key: 'spin', labelKey: 'algo.kinetic.spin', type: 'range', min: -2, max: 2, step: 0.01, defaultValue: 0.06 },
    {
      key: 'rotVar',
      labelKey: 'algo.kinetic.rotVar',
      type: 'range',
      min: 0,
      max: 1,
      step: 0.01,
      defaultValue: 0.15,
    },
    { key: 'rate', labelKey: 'algo.kinetic.rate', type: 'range', min: 0, max: 3, step: 0.01, defaultValue: 0.45 },
    { key: 'duty', labelKey: 'algo.kinetic.duty', type: 'range', min: 0.05, max: 1, step: 0.01, defaultValue: 0.6 },
    {
      key: 'inTime',
      labelKey: 'algo.kinetic.inTime',
      type: 'range',
      min: 0,
      max: 0.5,
      step: 0.01,
      defaultValue: 0.28,
    },
    {
      key: 'outTime',
      labelKey: 'algo.kinetic.outTime',
      type: 'range',
      min: 0,
      max: 0.5,
      step: 0.01,
      defaultValue: 0.3,
    },
    {
      key: 'inMode',
      labelKey: 'algo.kinetic.inMode',
      type: 'select',
      defaultValue: 'zoomIn',
      options: IN_OPTIONS,
    },
    {
      key: 'outMode',
      labelKey: 'algo.kinetic.outMode',
      type: 'select',
      defaultValue: 'zoomIn',
      options: OUT_OPTIONS,
    },
    {
      key: 'ease',
      labelKey: 'algo.kinetic.ease',
      type: 'select',
      defaultValue: 'smooth',
      options: [
        { labelKey: 'algo.kinetic.easeLinear', value: 'linear' },
        { labelKey: 'algo.kinetic.easeSmooth', value: 'smooth' },
        { labelKey: 'algo.kinetic.easeIn', value: 'in' },
        { labelKey: 'algo.kinetic.easeOut', value: 'out' },
        { labelKey: 'algo.kinetic.easeBack', value: 'back' },
      ],
    },
    {
      key: 'slideDir',
      labelKey: 'algo.kinetic.slideDir',
      type: 'select',
      defaultValue: 'up',
      visibleWhen: usesSlide,
      options: [
        { labelKey: 'algo.kinetic.dirUp', value: 'up' },
        { labelKey: 'algo.kinetic.dirDown', value: 'down' },
        { labelKey: 'algo.kinetic.dirLeft', value: 'left' },
        { labelKey: 'algo.kinetic.dirRight', value: 'right' },
        { labelKey: 'algo.kinetic.dirOutward', value: 'outward' },
        { labelKey: 'algo.kinetic.dirInward', value: 'inward' },
        { labelKey: 'algo.kinetic.dirRandom', value: 'random' },
      ],
    },
    {
      key: 'slideDist',
      labelKey: 'algo.kinetic.slideDist',
      type: 'range',
      min: 0,
      max: 1.2,
      step: 0.01,
      /* 0.4 ≈ 一格多一点（出厂 6×3 的格高是 0.33）：短于此读起来像「抖了一下」，
         再长就与相邻形状的进场交叠成一片，看不出「一个接一个」。 */
      defaultValue: 0.4,
      visibleWhen: usesSlide,
    },
    {
      key: 'zoom',
      labelKey: 'algo.kinetic.zoom',
      type: 'range',
      min: 1.2,
      max: 3,
      step: 0.01,
      defaultValue: 1.8,
      visibleWhen: usesBig,
    },
    {
      key: 'lineW',
      labelKey: 'algo.kinetic.lineW',
      type: 'range',
      min: 0.02,
      max: 0.6,
      step: 0.01,
      defaultValue: 0.18,
      visibleWhen: usesLineW,
    },
    {
      key: 'phase',
      labelKey: 'algo.kinetic.phase',
      type: 'select',
      defaultValue: 'random',
      options: [
        { labelKey: 'algo.kinetic.phaseRandom', value: 'random' },
        { labelKey: 'algo.kinetic.phaseOrder', value: 'order' },
        { labelKey: 'algo.kinetic.phaseRadial', value: 'radial' },
      ],
    },
    {
      key: 'audio',
      labelKey: 'algo.kinetic.audio',
      type: 'select',
      defaultValue: 'off',
      options: [
        { labelKey: 'algo.kinetic.audioOff', value: 'off' },
        { labelKey: 'algo.kinetic.audioRms', value: 'rms' },
        { labelKey: 'algo.kinetic.audioBass', value: 'bass' },
        { labelKey: 'algo.kinetic.audioHigh', value: 'high' },
        { labelKey: 'algo.kinetic.audioOnset', value: 'onset' },
      ],
    },
    {
      key: 'audioAmt',
      labelKey: 'algo.kinetic.audioAmt',
      type: 'range',
      min: 0,
      max: 1,
      step: 0.01,
      defaultValue: 0.5,
      visibleWhen: (v) => v.audio !== 'off',
    },
    { key: 'colorA', labelKey: 'algo.kinetic.colorA', type: 'color', defaultValue: '#ffd166' },
    { key: 'colorB', labelKey: 'algo.kinetic.colorB', type: 'color', defaultValue: '#ef476f' },
    {
      key: 'colorVar',
      labelKey: 'algo.kinetic.colorVar',
      type: 'range',
      min: 0,
      max: 1,
      step: 0.01,
      defaultValue: 0.6,
    },
    { key: 'offX', labelKey: 'algo.kinetic.offX', type: 'range', min: -1, max: 1, step: 0.01, defaultValue: 0 },
    { key: 'offY', labelKey: 'algo.kinetic.offY', type: 'range', min: -1, max: 1, step: 0.01, defaultValue: 0 },
    {
      key: 'variation',
      labelKey: 'algo.kinetic.variation',
      type: 'range',
      min: 0,
      max: 1,
      step: 0.01,
      defaultValue: 0,
    },
    { key: 'bg', labelKey: 'algo.kinetic.bg', type: 'color', defaultValue: '#0a0a0f', visibleWhen: bgColorVisible },
    bgModeParam(),
    intResParam(),
  ],
  setUniforms: (gl, l, v, ctx) => {
    const set1f = (name: string, value: number): void => {
      const loc = l[name];
      if (loc) gl.uniform1f(loc, value);
    };
    const set1i = (name: string, value: number): void => {
      const loc = l[name];
      if (loc) gl.uniform1i(loc, Math.round(value));
    };

    /* 布局是「密度 × 宽高比」的产物，不是参数本身 —— 与着色器里的
       u_cell 同源，所以预览与导出的构图一致（intRes 只改分辨率）。 */
    const lay = layoutOf(String(v.layout ?? 'grid'), Number(v.density ?? 6), ctx.w / Math.max(ctx.h, 1));
    set1i('u_count', lay.count);
    set1f('u_cols', lay.cols);
    set1f('u_rows', lay.rows);
    set1f('u_cell', lay.cell);

    /* 六个 select：字符串取值必须走显式映射，过 floats() 会静默变成 0。 */
    selectInt<AlgoUniformCtx>('shape', SHAPES)(gl, l, v, ctx);
    selectInt<AlgoUniformCtx>('layout', LAYOUTS)(gl, l, v, ctx);
    selectInt<AlgoUniformCtx>('ease', EASES)(gl, l, v, ctx);
    selectInt<AlgoUniformCtx>('slideDir', SLIDE_DIRS)(gl, l, v, ctx);
    selectInt<AlgoUniformCtx>('phase', PHASES)(gl, l, v, ctx);
    selectInt<AlgoUniformCtx>('audio', AUDIOS)(gl, l, v, ctx);

    floats<AlgoUniformCtx>(
      'jitter',
      'size',
      'sizeVar',
      'spin',
      'rotVar',
      'rate',
      'duty',
      'inTime',
      'outTime',
      'slideDist',
      'zoom',
      'lineW',
      'audioAmt',
      'colorVar',
      'variation',
    )(gl, l, v, ctx);

    /* 旋转是角度参数，shader 要弧度。 */
    set1f('u_rotation', (Number(v.rotation ?? 0) * Math.PI) / 180);

    const off = l['u_off'];
    if (off) gl.uniform2f(off, Number(v.offX ?? 0), Number(v.offY ?? 0));

    /* 进出场动画表在 JS：三个通道的开关，而不是十个 shader 分支。 */
    const inAnim = ANIM_TABLE[String(v.inMode ?? ANIM_FALLBACK)] ?? ANIM_TABLE[ANIM_FALLBACK]!;
    const outAnim = ANIM_TABLE[String(v.outMode ?? ANIM_FALLBACK)] ?? ANIM_TABLE[ANIM_FALLBACK]!;
    const inLoc = l['u_inAnim'];
    if (inLoc) gl.uniform3f(inLoc, inAnim[0], inAnim[1], inAnim[2]);
    const outLoc = l['u_outAnim'];
    if (outLoc) gl.uniform3f(outLoc, outAnim[0], outAnim[1], outAnim[2]);

    /* 音频特征：同样是闭式冲量（与 sceneUniforms 同一口径），
       `ages[0]` 是最近一次 onset 的年龄。 */
    const f = ctx.features;
    set1f('u_rms', f.rms);
    set1f('u_bass', f.bass);
    set1f('u_high', f.high);
    set1f('u_hit', Math.exp(-f.ages[0]! / 0.09));

    colors<AlgoUniformCtx>('colorA', 'colorB', 'bg')(gl, l, v, ctx);
  },
};

/** 供单测断言「每个选项都在表里」。 */
export const KS_ANIM_KEYS: readonly string[] = Object.keys(ANIM_TABLE);
