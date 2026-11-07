/**
 * horizon.ts — 地平线，realtime 型。
 *
 * 镜头贴着随机地形掠飞：地形是 2D fbm 高度场，水面是一张带细波的平面，
 * 两者取 min 后交给材质型 3D 内核步进（相机 / 步进 / 法线 / 射线全部走
 * sdf-lib.ts 的 sdfKernelMaterial，不另写一套）。
 *
 * ## 风格是参数组合，不是 shader 分支
 *
 * 五种风格（硬表面科幻 / 蒸汽波 / 体素 / 示波器 / PS1）在 JS 侧是一张表：
 * 六个颜色 + 十二个连续量。shader 只有一套着色公式，风格差异全部来自这些
 * 系数的值。加一种风格 = HORIZON_STYLES 加一行 + i18n 加一个选项，
 * GLSL 一个字都不用改；反过来写五个分支，每加一个风格就要动五处混合逻辑。
 *
 * 表里的量分成三组 vec4，与 shader 的 u_fx / u_retro / u_look 一一对应。
 * lines / retroAmt / relief 是用户对预设的三个倍率，1 = 完全跟随预设。
 *
 * ## 时间与确定性
 *
 * 相机恒在局部原点，世界靠 horizonTravel() 沿 -z 流过它 —— 飞多久都不会
 * 把相机坐标推到大数上（float32 精度），而且 u_time 在整个 fragment 里
 * 只出现一次：speed = 0 时画面与 t 逐点无关。噪声只用无 sin 的 hash，
 * 抖动 / 扫描线是 gl_FragCoord 的纯函数，同一 t 两渲逐像素相同。
 *
 * ## 高度场步进
 *
 * p.y - h(p.xz) 不是欧氏距离（|∇h| > 1 时会过估），所以 SDF 返回值乘了
 * 一个保守系数，stepScale 再压一道。台地化用的是连续阶梯函数而不是 floor，
 * 免得距离场在台阶边缘撕裂。网格线宽按「命中距离 × 每像素角尺寸」解析给出，
 * 不用 fwidth —— 命中判定是非一致控制流，那里的导数没有定义。
 */

import { intResParam } from './shader-lib';
import { NOISE_GLSL } from './noise-lib';
import {
  composeUniforms,
  sdfKernelMaterial,
  sdfQualityParams,
  sdfQualityUniforms,
  set1i,
  set3,
} from './sdf-lib';
import type { MessageKey } from '../i18n/locales';
import type { ParamDef, SelectParam } from '../effects/types';
import type { GeneratorDef } from './types';

/* ---------------------------------------------------------------- 风格表（纯） */

/**
 * 一组风格系数。三个 vec4 的通道顺序与 shader 里的 u_fx / u_retro / u_look 严格对应，
 * 改顺序等于把「网格强度」接到「抖动」上，而且不报错。
 */
export interface HorizonStyle {
  skyTop: string;
  skyLow: string;
  groundLow: string;
  groundHigh: string;
  accent: string;
  water: string;
  /** x 网格 · y 等高线 · z 辉光 · w 色阶 */
  fx: readonly [number, number, number, number];
  /** x 抖动 · y 扫描 · z 太阳条纹 · w 台地 */
  retro: readonly [number, number, number, number];
  /** x 平面着色 · y 雾 · z 水面反射 · w 太阳尺寸 */
  look: readonly [number, number, number, number];
}

export const HORIZON_STYLES: Record<string, HorizonStyle> = {
  scifi: {
    skyTop: '#0a1730', skyLow: '#31577a',
    groundLow: '#1c3040', groundHigh: '#8fb6c6',
    accent: '#7de3ff', water: '#163b52',
    fx: [0.55, 0.55, 0.35, 0.12],
    retro: [0.04, 0.05, 0.0, 0.12],
    look: [0.15, 0.55, 0.55, 0.005],
  },
  vapor: {
    skyTop: '#1b0b3b', skyLow: '#ff4d8d',
    groundLow: '#2a0f4c', groundHigh: '#ff8fd0',
    accent: '#ffe15a', water: '#5b2a86',
    fx: [1.0, 0.15, 0.60, 0.45],
    retro: [0.15, 0.25, 1.0, 0.10],
    look: [0.25, 0.30, 0.90, 0.050],
  },
  voxel: {
    skyTop: '#4aa8f0', skyLow: '#c8ecff',
    groundLow: '#356e3c', groundHigh: '#cfe46a',
    accent: '#ffffff', water: '#2d78c8',
    fx: [0.0, 0.0, 0.05, 0.80],
    retro: [0.10, 0.0, 0.0, 1.0],
    look: [1.0, 0.35, 0.20, 0.007],
  },
  scope: {
    skyTop: '#010904', skyLow: '#04180c',
    groundLow: '#021209', groundHigh: '#0b5627',
    accent: '#69ff9c', water: '#032012',
    fx: [0.90, 1.0, 1.0, 0.25],
    retro: [0.05, 0.90, 0.0, 0.10],
    look: [0.10, 0.20, 0.15, 0.0],
  },
  ps1: {
    skyTop: '#20243c', skyLow: '#8d6b7a',
    groundLow: '#464638', groundHigh: '#9e9a72',
    accent: '#d8c8a0', water: '#3b4055',
    fx: [0.0, 0.10, 0.10, 0.90],
    retro: [1.0, 0.70, 0.0, 0.55],
    look: [0.70, 0.85, 0.30, 0.008],
  },
};

/** 认不出的键（老工程 / 手改过的 JSON）落到硬表面科幻，而不是渲一张空图。 */
export const HORIZON_STYLE_FALLBACK = 'scifi';

export const HORIZON_STYLE_OPTIONS: SelectParam['options'] = [
  { labelKey: 'algo.horizon.styleScifi', value: 'scifi' },
  { labelKey: 'algo.horizon.styleVapor', value: 'vapor' },
  { labelKey: 'algo.horizon.styleVoxel', value: 'voxel' },
  { labelKey: 'algo.horizon.styleScope', value: 'scope' },
  { labelKey: 'algo.horizon.stylePs1', value: 'ps1' },
];

/** octaves 的取值 → u_octaves。少一项 = 那个选项静默退化成 1 阶。 */
export const HORIZON_OCTAVES: Record<string, number> = { '2': 2, '3': 3, '4': 4 };

/* ------------------------------------------------------------------ 着色器 */

const DECL = `
uniform vec4  u_fx;          // x 网格 · y 等高线 · z 辉光 · w 色阶
uniform vec4  u_retro;       // x 抖动 · y 扫描 · z 太阳条纹 · w 台地
uniform vec4  u_look;        // x 平面着色 · y 雾 · z 水面反射 · w 太阳尺寸
uniform vec3  u_skyTop;
uniform vec3  u_skyLow;
uniform vec3  u_groundLow;
uniform vec3  u_groundHigh;
uniform vec3  u_accent;
uniform vec3  u_water;
uniform float u_lines;       // 预设的网格 / 等高线倍率
uniform float u_retroAmt;    // 预设的复古倍率
uniform float u_relief;      // 预设的台地倍率

uniform float u_rough;
uniform float u_terrScale;
uniform int   u_octaves;
uniform float u_ridge;
uniform float u_patternSeed;
uniform float u_gridFreq;
uniform float u_seaLevel;
uniform float u_wave;

uniform float u_speed;
uniform float u_altitude;
uniform float u_yaw;
uniform float u_pitch;
uniform float u_roll;
uniform float u_sunAz;
uniform float u_sunEl;

/* 时钟在这段 fragment 里只出现一次：世界沿 -z 流过恒在原点的相机，
   所以 speed = 0 时没有任何一处会把 t 直接接进画面。 */
float horizonTravel() {
  return u_time * u_speed;
}

vec2 horizonWorld(vec3 p) {
  return vec2(p.x, p.z + horizonTravel());
}

float horizonHeight(vec2 w) {
  vec2 q = w * u_terrScale
         + vec2(u_seed * 53.0 + u_patternSeed * 97.0, u_patternSeed * 41.0);
  float n = nzFbm2(q, 0, 0, clamp(u_octaves, 1, NZ_MAX_OCTAVES), 0.5, 2.0);
  /* 高度是位移，必须先把 fbm 的窄动态范围拉开：归一化 fbm 的标准差只有
     0.1，直接拿它当高度，画面会退化成一张带等高线的平板。 */
  float cn = nzCentered(n);
  /* 山脊化：峰值落在场的均值上，脊线因此是连通的。 */
  float r = 1.0 - abs(cn);
  float shaped = mix(cn * 0.5 + 0.5, r, u_ridge);
  float h = (shaped - 0.45) * u_rough * 2.2;
  /* 台地：连续阶梯。用 floor 会在台阶边撕开距离场，步进直接穿过去。
     带宽 0.28..0.72 让每一级的两端都有一段平顶， slope 有界。 */
  float bands = 7.0;
  float s = h * bands;
  float terr = (floor(s) + smoothstep(0.28, 0.72, fract(s))) / bands;
  h = mix(h, terr, clamp(u_retro.w * u_relief, 0.0, 1.0));

  /* 远处的高度场必须压平。近水平的射线往前走时 p.y - h 不一定单调：
     h 突然抬得比射线快，步进就在天空里判成命中，画面上出现一排漂浮的
     薄片，而雾救不了它们（命中距离根本不远）。按局部 z 渐隐到水面，
     地平线因此是一条干净的线，远山由雾接管。 */
  float dist = w.y - horizonTravel();
  float near = 1.0 - smoothstep(u_maxDist * 0.30, u_maxDist * 0.75, dist);
  return mix(u_seaLevel - 0.15, h, near);
}

float horizonWater(vec2 w) {
  float ph = horizonTravel();
  return u_seaLevel + u_wave * 0.022
       * (sin(w.x * 1.7 + ph * 1.7) * sin(w.y * 1.3 - ph * 1.1));
}
`;

const SDF = `
/* 材质号 0 = 陆地 · 1 = 水面。.z 是沿射线积分的空气辉光场。 */
vec3 sdHorizon(vec3 p) {
  vec2 w = horizonWorld(p);
  /* p.y - h 不是欧氏距离：|∇h| > 1 时会过估，步进直接跨过山顶。
     系数压到 0.42（再叠 stepScale），高度场拉大起伏后仍然保守。 */
  float land = (p.y - horizonHeight(w)) * 0.42;
  float sea = (p.y - horizonWater(w)) * 0.70;
  float matId = 0.0;
  float d = land;
  if (sea < d) {
    d = sea;
    matId = 1.0;
  }
  /* 只在地形表面附近给一点辉光；除法的分母不为零，远处自然衰减。 */
  float glow = u_fx.z * 0.004 / (1.0 + abs(d) * 8.0);
  return vec3(d, matId, glow);
}
`;

const CAM = `
/* 掠飞镜头：眼恒在局部原点，高度跟着脚下地形抬，保证不会钻进山里。
   上向量显式构造再绕视线滚转 —— 用世界 +Y 直接 cross 在俯仰接近竖直时会退化。 */
void horizonCam(out vec3 eye, out mat3 cam) {
  vec2 w0 = horizonWorld(vec3(0.0));
  float ground = horizonHeight(w0);
  eye = vec3(0.0, max(u_altitude, ground + 0.75), 0.0);

  float yaw = u_yaw + 0.035 * sin(horizonTravel() * 0.09 + u_seed * 6.0);
  float cp = cos(u_pitch);
  vec3 fwd = vec3(sin(yaw) * cp, sin(u_pitch), cos(yaw) * cp);
  vec3 right = normalize(cross(vec3(0.0, 1.0, 0.0), fwd));
  vec3 up = cross(fwd, right);
  float c = cos(u_roll);
  float s = sin(u_roll);
  /* mat3 的构造是列优先：三列正好是右 / 上 / 前。 */
  cam = mat3(right * c + up * s, -right * s + up * c, fwd);
}

vec3 horizonSun() {
  float ce = cos(u_sunEl);
  return normalize(vec3(sin(u_sunAz) * ce, sin(u_sunEl), cos(u_sunAz) * ce));
}

vec3 horizonSky(vec3 rd, vec3 sunDir) {
  vec3 col = mix(u_skyLow, u_skyTop, smoothstep(-0.02, 0.65, rd.y));
  float mu = max(dot(rd, sunDir), 0.0);
  float size = u_look.w;
  if (size > 0.0) {
    float disc = smoothstep(1.0 - size, 1.0 - size * 0.35, mu);
    /* 条纹是连续系数，不是风格分支：只要 u_retro.z = 0 它就被 mix 掉。 */
    float bars = mix(1.0, step(0.12, sin(rd.y * 240.0 + u_seed * 3.0)),
                     clamp(u_retro.z, 0.0, 1.0));
    bars = mix(1.0, bars, 1.0 - smoothstep(-0.03, 0.03, rd.y - sunDir.y));
    col = mix(col, u_accent * 1.25, disc * bars);
  }
  float halo = exp(-abs(rd.y - sunDir.y) * 9.0) * pow(mu, 8.0);
  return col + u_accent * halo * u_fx.z * 0.5;
}
`;

const MAIN = `
void main() {
  vec3 eye;
  mat3 cam;
  horizonCam(eye, cam);
  vec3 rd = sdfRay(vUv, u_aspect, cam);
  vec3 sunDir = horizonSun();
  vec3 sky = horizonSky(rd, sunDir);
  vec3 col = sky;

  float matId = 0.0;
  float glow = 0.0;
  /* 相机恒在地形上界之上，朝上的射线不可能命中这张高度场。 */
  float hit = -1.0;
  if (rd.y < 0.0) hit = sdfMarchMat(eye, rd, matId, glow);
  /* 掠射射线在 72 步里走不完视距，会在「命中 / 未命中」之间逐像素跳，
     于是天空里长出一排悬浮的薄板。远处地形已经压平到水面高度，所以给
     未命中的向下射线补一次解析求交：它必然落在那张水面上。 */
  if (hit < 0.0 && rd.y < 0.0) {
    float tPlane = (u_seaLevel - eye.y) / min(rd.y, -1e-3);
    if (tPlane > 0.0 && tPlane < u_maxDist) {
      hit = tPlane;
      matId = 1.0;
    }
  }
  if (hit >= 0.0) {
    vec3 q = eye + rd * hit;
    vec3 n = sdfNormalMat(q, max(0.006, sdfNormalEps(hit) * 0.35));
    /* 平面着色：法线量化成三档，体素与 PS1 靠它读出色块。 */
    vec3 nq = normalize(floor(n * 3.0 + 0.5) / 3.0);
    n = normalize(mix(n, nq, clamp(u_look.x, 0.0, 1.0)));

    vec2 w = horizonWorld(q);
    float h = horizonHeight(w);
    float hm = clamp(h / max(u_rough, 0.1) * 0.5 + 0.5, 0.0, 1.0);
    vec3 base = mix(u_groundLow, u_groundHigh, hm);
    /* 太阳盘贴着地平线时，方向光几乎打不到朝上的地面，整幅地形会读成一张
       平板。光方向单独抬高，太阳盘仍在原处（蒸汽波要的就是低垂的落日）。 */
    float NoL = max(dot(n, normalize(sunDir + vec3(0.0, 0.65, 0.0))), 0.0);
    vec3 c = base * (0.28 + 0.90 * NoL) * (0.75 + 0.25 * max(n.y, 0.0));

    if (matId > 0.5) {
      float fres = pow(1.0 - max(dot(n, -rd), 0.0), 3.0);
      vec3 rr = reflect(rd, n);
      vec3 refl = horizonSky(rr, sunDir);
      /* 反射不能吃满：掠射角下水面若与天空同色，露出水面的岛屿就像一排
         悬浮的薄板。始终留一层固有色当「底座」。 */
      c = mix(u_water * (0.55 + 0.45 * NoL), refl,
              clamp(u_look.z * (0.20 + 0.55 * fres), 0.0, 0.72));
      /* 水面的太阳反光带：没有它，镜面水面与天空同色，地平线读不出来。 */
      c += u_accent * pow(max(dot(rr, sunDir), 0.0), 60.0) * u_look.z * 0.8;
    }

    /* 网格线宽按「命中距离 × 每像素角尺寸」解析给出：不用 fwidth，
       命中判定是非一致控制流，那里的导数没有定义。宽到一格只剩几个像素
       时按同一条量淡出，掠射角下才不会把地面糊成一块发光的糖。 */
    float px = hit * u_fov / max(u_resolution.y, 1.0);
    /* 线宽封顶 0.12 格并按同一条量早早淡出：掠射角下一格只占几个像素，
       网格与等高线会挤成一片百叶窗状的密集横纹。 */
    float lineW = clamp(px * u_gridFreq * 1.2, 0.002, 0.12);
    vec2 gc = w * u_gridFreq;
    vec2 gd = abs(fract(gc - 0.5) - 0.5);
    float grid = 1.0 - smoothstep(0.0, lineW, min(gd.x, gd.y));
    float fade = 1.0 - smoothstep(0.035, 0.13, lineW);
    fade *= 1.0 - smoothstep(u_maxDist * 0.20, u_maxDist * 0.55, hit);
    grid *= fade;

    /* 陡坡上一条像素跨过好几层高度，固定带宽会把等高线混叠成密集条纹。
       频率降到 8 层，带宽跟着像素尺度放宽，陡坡再按法线淡出。 */
    float slope = smoothstep(0.30, 0.85, n.y);
    float hb = abs(fract(h * 8.0) - 0.5);
    float cb = clamp(0.09 + lineW * 2.0, 0.09, 0.40);
    float contour = (1.0 - smoothstep(0.0, cb, hb)) * fade
                  * (1.0 - smoothstep(0.02, 0.10, lineW))
                  * mix(0.25, 1.0, slope);
    float lines = clamp(grid * u_fx.x + contour * u_fx.y, 0.0, 1.5) * u_lines;
    c = mix(c, u_accent, clamp(lines * 0.75, 0.0, 0.9));
    c += u_accent * lines * u_fx.z * 0.35;

    /* 基础雾与风格雾叠在一起：再淡的风格，远处也要沉进天空。否则远山被
       水面切成一串漂浮的小碎片，看起来像渲染坏了。 */
    float fogA = 1.0 - exp(-hit * (0.05 + 0.18 * clamp(u_look.y, 0.0, 1.0)));
    col = mix(c, sky, clamp(fogA, 0.0, 1.0));
  }

  col += u_accent * glow;

  /* 扫描线 / 色阶 / 抖动是同一组连续量，风格只改它们的权重。
     抖动取 gl_FragCoord 的 hash：像素的纯函数，同一 t 两渲逐字节相同。 */
  float scan = 1.0 - clamp(u_retro.y * u_retroAmt, 0.0, 1.0) * 0.22
             * (0.5 + 0.5 * sin(gl_FragCoord.y * 1.7));
  col *= scan;
  float levels = mix(256.0, 5.0, clamp(u_fx.w * u_retroAmt, 0.0, 1.0));
  float dith = (hash21(gl_FragCoord.xy) - 0.5) * clamp(u_retro.x * u_retroAmt, 0.0, 1.0);
  col = floor(clamp(col, 0.0, 1.0) * levels + 0.5 + dith) / levels;

  outColor = vec4(col, 1.0);
}`;

export const HORIZON_FRAG = NOISE_GLSL + sdfKernelMaterial('sdHorizon') + DECL + SDF + CAM + MAIN;

/* ------------------------------------------------------------------ 参数表 */

function qualityParams(): ParamDef[] {
  return sdfQualityParams(72).map((p) => {
    if (p.type !== 'range') return p;
    if (p.key === 'stepScale') return { ...p, defaultValue: 0.5 };
    if (p.key === 'maxDist') return { ...p, max: 80, defaultValue: 46 };
    if (p.key === 'eps') return { ...p, defaultValue: 0.0025 };
    if (p.key === 'fov') return { ...p, defaultValue: 1.0 };
    return p;
  });
}

/** labelKey 显式给：拼模板串会退化成 string，文案键的编译期检查就没了。 */
function range(
  key: string,
  labelKey: MessageKey,
  min: number,
  max: number,
  step: number,
  defaultValue: number,
): ParamDef {
  return { key, labelKey, type: 'range', min, max, step, defaultValue };
}

export const horizonDef: GeneratorDef = {
  id: 'horizon',
  nameKey: 'algo.horizon',
  kind: 'realtime',
  fragment: HORIZON_FRAG,
  params: [
    {
      key: 'style',
      labelKey: 'algo.horizon.style',
      type: 'select',
      defaultValue: HORIZON_STYLE_FALLBACK,
      options: HORIZON_STYLE_OPTIONS,
    } satisfies SelectParam,
    range('lines', 'algo.horizon.lines', 0, 2, 0.01, 1),
    range('retroAmt', 'algo.horizon.retroAmt', 0, 2, 0.01, 1),
    range('relief', 'algo.horizon.relief', 0, 2, 0.01, 1),

    range('rough', 'algo.horizon.rough', 0.1, 2, 0.01, 1.0),
    range('terrainScale', 'algo.horizon.terrainScale', 0.2, 3, 0.01, 0.75),
    {
      key: 'octaves',
      labelKey: 'algo.horizon.octaves',
      type: 'select',
      defaultValue: '3',
      options: [
        { labelKey: 'algo.horizon.octaves2', value: '2' },
        { labelKey: 'algo.horizon.octaves3', value: '3' },
        { labelKey: 'algo.horizon.octaves4', value: '4' },
      ],
    } satisfies SelectParam,
    range('ridge', 'algo.horizon.ridge', 0, 1, 0.01, 0.35),
    range('patternSeed', 'algo.horizon.patternSeed', 0, 1, 0.001, 0.2),
    range('seaLevel', 'algo.horizon.seaLevel', -1, 1, 0.01, 0.0),
    range('wave', 'algo.horizon.wave', 0, 1, 0.01, 0.3),
    range('gridFreq', 'algo.horizon.gridFreq', 0.2, 4, 0.01, 1.0),

    range('speed', 'algo.horizon.speed', 0, 8, 0.01, 2.4),
    range('altitude', 'algo.horizon.altitude', 0.4, 6, 0.01, 1.35),
    range('yaw', 'algo.horizon.yaw', -45, 45, 0.1, 0),
    range('pitch', 'algo.horizon.pitch', -30, 10, 0.1, -9),
    range('roll', 'algo.horizon.roll', -30, 30, 0.1, 0),
    range('sunAz', 'algo.horizon.sunAz', -180, 180, 1, 0),
    range('sunEl', 'algo.horizon.sunEl', -10, 60, 1, 6),

    ...qualityParams(),
    { ...intResParam(), defaultValue: '720' },
  ],
  setUniforms: composeUniforms(sdfQualityUniforms(), (gl, l, v) => {
    const num = (k: string, d: number): number => {
      const x = Number(v[k]);
      return Number.isFinite(x) ? x : d;
    };
    const angle = (k: string, d: number): number => (num(k, d) * Math.PI) / 180;
    const u1 = (name: string, x: number): void => {
      const p = l[name];
      if (p) gl.uniform1f(p, x);
    };
    const u4 = (name: string, x: readonly number[]): void => {
      const p = l[name];
      if (p) gl.uniform4f(p, x[0]!, x[1]!, x[2]!, x[3]!);
    };

    const style = HORIZON_STYLES[String(v.style)] ?? HORIZON_STYLES[HORIZON_STYLE_FALLBACK]!;
    u4('u_fx', style.fx);
    u4('u_retro', style.retro);
    u4('u_look', style.look);
    set3(gl, l, 'u_skyTop', style.skyTop);
    set3(gl, l, 'u_skyLow', style.skyLow);
    set3(gl, l, 'u_groundLow', style.groundLow);
    set3(gl, l, 'u_groundHigh', style.groundHigh);
    set3(gl, l, 'u_accent', style.accent);
    set3(gl, l, 'u_water', style.water);

    u1('u_lines', num('lines', 1));
    u1('u_retroAmt', num('retroAmt', 1));
    u1('u_relief', num('relief', 1));

    u1('u_rough', Math.max(0.01, num('rough', 1)));
    u1('u_terrScale', Math.max(0.01, num('terrainScale', 0.75)));
    set1i(gl, l, 'u_octaves', HORIZON_OCTAVES[String(v.octaves ?? '3')] ?? 3);
    u1('u_ridge', num('ridge', 0.35));
    u1('u_patternSeed', num('patternSeed', 0.2));
    u1('u_gridFreq', Math.max(0.01, num('gridFreq', 1)));
    u1('u_seaLevel', num('seaLevel', 0));
    u1('u_wave', num('wave', 0.3));

    u1('u_speed', num('speed', 2.4));
    u1('u_altitude', num('altitude', 1.35));
    u1('u_yaw', angle('yaw', 0));
    u1('u_pitch', angle('pitch', -9));
    u1('u_roll', angle('roll', 0));
    u1('u_sunAz', angle('sunAz', 0));
    u1('u_sunEl', angle('sunEl', 6));
  }),
};
