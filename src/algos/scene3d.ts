/**
 * scene3d.ts — 多物体 3D 场景（`scene-3d`），realtime 型。
 *
 * ## 它存在的理由
 *
 * 一个 3D 生成器只能有一份几何：步进循环里只认一个 SDF 函数名。于是「海绵
 * 旁边放一颗曼德球、共享同一个镜头、互相遮挡」在旧结构下**做不出来** ——
 * 只能渲两层再 blend，而 blend 出来的东西没有遮挡关系（后面的物体不会被前面
 * 的挡住，观众一眼看出来）。
 *
 * 拆出 `SdfGeom`（`sdf-geoms.ts`）之后，这里把 2..4 个几何体拼进**同一个**
 * 距离场：
 *
 *     并集：`min(d1, d2)` —— 近者胜出，材质跟它
 *     减：  `max(d1, -d2)` —— 从首槽里挖掉后面的槽
 *     交：  `max(d1, d2)` —— 两块都占的地方
 *
 * 三者都作用在**同一个** `sdScene` 上，所以遮挡、软阴影、AO 全是真的。
 *
 * ## 槽的变换顺序
 *
 * `p → 平移 → 绕 Y 反转 → 除以 zoom →（可选）折叠 → 几何 → 距离乘回 zoom`
 *
 * 折叠在**槽的局部坐标**里做，所以两个槽可以一个无限延伸、一个单体 ——
 * 跨槽折叠是错的（那等于让两个几何体共享一个周期格）。
 *
 * ## 为什么片段是运行期拼的
 *
 * 槽里放哪几个几何体是**参数**，不是编译期常量。程序按「槽的 defId 序列」
 * 缓存（`kit.quad` 按名字缓存），换几何 = 重编一次 shader，换别的参数不重编。
 *
 * ## 深度输出（P2 的第一批真实消费者）
 *
 * `outDepth = depth` 时 fragment 直接输出 `1 - hit / maxDist`（近 = 亮），
 * 不跨着色 —— 于是它能当 `MaskRef { kind: 'clip', channel: 'r' }` 的源：
 * 同一个场景的亮度、颜色、其他特效都能按「离镜头多近」分区。
 */

import { HASH_FAST_GLSL } from '../effects/shader-def';
import { bgModeParam, intResParam } from './shader-lib';
import { getSdfGeom, SDF_GEOMS } from './sdf-geoms';
/*
 * 直接 import 三个 def，**不经过注册表**：`registry.ts` 反过来要 import 本文件，
 * 而在模块顶层调 `getGenerator()` 会撞上「注册表还没初始化」—— 表现为
 * `Cannot access 'PLUGIN' before initialization`，整个注册表连同二十几个
 * 无关测试一起红。
 */
import { mengerDef } from './menger';
import { mandelbulbDef } from './mandelbulb';
import { apollonianDef } from './apollonian';
import {
  SDF_AA_MAIN,
  SDF_SHADE_UNIFORMS_GLSL,
  sdfKernelMaterial,
  sdfLightParams,
  sdfLightUniforms,
  sdfQualityParams,
  sdfQualityUniforms,
  sdfShadeParams,
  sdfShadeUniforms,
  set1i,
  set3,
  type SdfGeom,
} from './sdf-lib';
import { namespaceGeom, prefixedLocs, slotValues } from './sdf-compose';
import { defaultValues, type ParamDef, type RangeParam, type SelectParam } from '../effects/types';
import type { GeneratorDef } from './types';
import type { AlgoSetUniforms } from './shader-lib';

/** 槽数上限。再多的话参数表与每像素的 SDF 成本都不划算。 */
export const SCENE_SLOTS = 4;

/** `u_sky` 的取值映射（拼错的名字落到「背景色」而不是「渐变」）。 */
export const SCENE_SKIES: Record<string, number> = { none: 0, gradient: 1, stars: 2 };

/** `outDepth` 的取值。 */
export const SCENE_OUTPUTS: Record<string, number> = { color: 0, depth: 1 };

/* --------------------------------------------------------------- 参数表 */

/**
 * 槽里可选的几何体。`none` = 空槽（不参与距离场，也不占 shader 里的任何代码）。
 *
 * 选项文案直接复用生成器自己的名字键 —— 同一个东西在「新建片段」和「塞进
 * 场景」两处必须叫同一个名字。键必须与 `SDF_GEOMS` 完全对齐（有单测钉着）。
 */
const GEOM_DEFS: Record<string, GeneratorDef> = {
  menger: mengerDef,
  mandelbulb: mandelbulbDef,
  apollonian: apollonianDef,
};

const GEOM_OPTIONS = [
  { labelKey: 'algo.scene3d.none' as const, value: 'none' },
  ...Object.keys(SDF_GEOMS).map((id) => ({
    labelKey: GEOM_DEFS[id]!.nameKey,
    value: id,
  })),
];

/** 每个槽各自的默认摆放 —— 出厂画面要能一眼看出「这是两个物体」。 */
const SLOT_DEFAULTS: Record<number, { zoom: number; x: number; mat: number }> = {
  1: { zoom: 0.72, x: 0, mat: 1 },
  2: { zoom: 0.46, x: 1.3, mat: 2 },
  3: { zoom: 0.3, x: -1.35, mat: 3 },
  4: { zoom: 0.24, x: 0, mat: 2 },
};

function slotParams(n: number): ParamDef[] {
  const pre = `s${n}.`;
  const defKey = `${pre}def`;
  const foldKey = `${pre}fold`;
  const d = SLOT_DEFAULTS[n] ?? SLOT_DEFAULTS[1]!;

  const on = (v: Record<string, number | string>): boolean => String(v[defKey] ?? 'none') !== 'none';

  const params: ParamDef[] = [
    {
      key: defKey,
      labelKey: 'algo.scene3d.slot',
      type: 'select',
      defaultValue: n === 1 ? 'menger' : n === 2 ? 'mandelbulb' : 'none',
      options: GEOM_OPTIONS,
    },
    {
      /*
       * 组合方式**只对「前面还有槽」的那些槽有意义**：首槽没有「和谁」可组合，
       * 而它前面全是空槽时也一样（那时它是首槽）。做成 uniform 分支而不是代码
       * 生成 —— 换 op 只是拖一个下拉，不该重编 shader。
       */
      key: `${pre}op`,
      labelKey: 'algo.scene3d.op',
      type: 'select',
      defaultValue: 'union',
      options: [
        { labelKey: 'algo.scene3d.opUnion', value: 'union' },
        { labelKey: 'algo.scene3d.opSubtract', value: 'subtract' },
        { labelKey: 'algo.scene3d.opIntersect', value: 'intersect' },
      ],
      visibleWhen: (v) => {
        if (!on(v)) return false;
        for (let k = 1; k < n; k++) {
          if (String(v[`s${k}.def`] ?? 'none') !== 'none') return true;
        }
        return false;
      },
    },
    { key: `${pre}x`, labelKey: 'algo.scene3d.posX', type: 'range', min: -3, max: 3, step: 0.01, defaultValue: d.x, visibleWhen: on },
    { key: `${pre}y`, labelKey: 'algo.scene3d.posY', type: 'range', min: -3, max: 3, step: 0.01, defaultValue: 0, visibleWhen: on },
    { key: `${pre}z`, labelKey: 'algo.scene3d.posZ', type: 'range', min: -3, max: 3, step: 0.01, defaultValue: 0, visibleWhen: on },
    {
      key: `${pre}zoom`,
      labelKey: 'algo.scene3d.zoom',
      type: 'range',
      min: 0.15,
      max: 2,
      step: 0.01,
      defaultValue: d.zoom,
      visibleWhen: on,
    } satisfies RangeParam,
    {
      key: `${pre}rotY`,
      labelKey: 'algo.scene3d.rotY',
      type: 'range',
      min: -180,
      max: 180,
      step: 1,
      defaultValue: 0,
      visibleWhen: on,
    } satisfies RangeParam,
    {
      key: `${pre}mat`,
      labelKey: 'algo.scene3d.mat',
      type: 'select',
      defaultValue: `mat${d.mat}`,
      options: [
        { labelKey: 'algo.scene3d.mat1', value: 'mat1' },
        { labelKey: 'algo.scene3d.mat2', value: 'mat2' },
        { labelKey: 'algo.scene3d.mat3', value: 'mat3' },
      ],
      visibleWhen: on,
    } satisfies SelectParam,
    {
      /*
       * 无限延伸。**逐槽套用**：折叠在这个槽的局部坐标里做，跨槽共享一个周期格
       * 是错的。只在本身以 2 为周期的几何体上露出来（menger / apollonian）。
       */
      key: foldKey,
      labelKey: 'algo.scene3d.fold',
      type: 'select',
      defaultValue: 'off',
      options: [
        { labelKey: 'algo.scene3d.foldOff', value: 'off' },
        { labelKey: 'algo.scene3d.foldOn', value: 'on' },
      ],
      visibleWhen: (v) => {
        if (!on(v)) return false;
        const id = String(v[defKey] ?? '');
        return getSdfGeom(id)?.foldable === true;
      },
    } satisfies SelectParam,
  ];

  /*
   * 几何体自己的参数，按 `s1.<key>` 生成。
   *
   * 定义**从生成器 def 里借**（标签 / 区间 / 默认值 única 真源），只换键名与
   * 可见性 —— 手抄一份的话，改了 menger 的 `depth` 上限这里会静默不跟。
   * 同一个键被两个几何体用时（`iter`）只留第一份，见文件头的取舍说明。
   */
  const seen = new Set<string>();
  for (const geomId of Object.keys(SDF_GEOMS)) {
    const geom = getSdfGeom(geomId)!;
    const def = GEOM_DEFS[geomId];
    if (!def) continue;
    for (const key of geom.keys) {
      if (seen.has(key)) continue;
      const src = def.params.find((p) => p.key === key);
      if (!src) continue;
      seen.add(key);
      params.push({
        ...src,
        key: `${pre}${key}`,
        // 槽的值在 `values` 里带前缀，几何体自己的 `visibleWhen` 读的是裸键
        visibleWhen: (v) => {
          if (String(v[defKey] ?? 'none') !== geomId) return false;
          if (key === 'twist' && v[foldKey] === 'on') return false;
          const local = slotValues(v, pre);
          return src.visibleWhen ? src.visibleWhen(local) : true;
        },
      } as ParamDef);
    }
  }

  return params;
}

/** 光照那批（去掉调色板选择：场景有三个明确的材质色，没有「按高度双色」）。 */
function sceneLightParams(): ParamDef[] {
  return sdfLightParams({ ao: 0.55, fog: 0.22 })
    .filter((p) => p.key !== 'palette')
    // `colorB` 原本靠 `palette !== 'single'` 判定可见，这里没有 palette 了
    .map((p) => (p.key === 'colorB' ? { ...p, visibleWhen: undefined } : p));
}

const PARAMS: ParamDef[] = [
  ...sdfQualityParams(64),
  {
    key: 'dist',
    labelKey: 'algo.sdf.dist',
    type: 'range',
    min: 2,
    max: 12,
    step: 0.02,
    defaultValue: 3.9,
  } satisfies RangeParam,
  { key: 'push', labelKey: 'algo.sdf.push', type: 'range', min: 0, max: 1, step: 0.01, defaultValue: 0 } satisfies RangeParam,
  { key: 'rate', labelKey: 'algo.sdf.rate', type: 'range', min: 0, max: 6, step: 0.05, defaultValue: 0.6 } satisfies RangeParam,
  ...sceneLightParams(),
  { key: 'colorC', labelKey: 'algo.scene3d.colorC', type: 'color', defaultValue: '#c9a26b' },
  ...sdfShadeParams({ shadow: 0.6, shadowSteps: 12, gloss: 0.5, ambient: '#161d2e', pointPow: 0.3, pointDist: 3 }),
  {
    key: 'sky',
    labelKey: 'algo.scene3d.sky',
    type: 'select',
    defaultValue: 'none',
    options: [
      { labelKey: 'algo.scene3d.skyNone', value: 'none' },
      { labelKey: 'algo.scene3d.skyGradient', value: 'gradient' },
      { labelKey: 'algo.scene3d.skyStars', value: 'stars' },
    ],
  } satisfies SelectParam,
  {
    key: 'skyTop',
    labelKey: 'algo.scene3d.skyTop',
    type: 'color',
    defaultValue: '#0a1024',
    visibleWhen: (v) => v.sky !== 'none',
  },
  {
    key: 'skyLow',
    labelKey: 'algo.scene3d.skyLow',
    type: 'color',
    defaultValue: '#2b3350',
    visibleWhen: (v) => v.sky !== 'none',
  },
  {
    key: 'outDepth',
    labelKey: 'algo.scene3d.out',
    type: 'select',
    defaultValue: 'color',
    options: [
      { labelKey: 'algo.scene3d.outColor', value: 'color' },
      { labelKey: 'algo.scene3d.outDepth', value: 'depth' },
    ],
  } satisfies SelectParam,
  /*
   * 背景开关。`bg` 本身在 `sdfLightParams()` 里（带 `bgColorVisible`）——
   * 这里只补开关，别再加一个 `bg`（同名键会让 UI 上两个控件绑同一个值）。
   */
  bgModeParam(),
  ...Array.from({ length: SCENE_SLOTS }, (_, i) => slotParams(i + 1)).flat(),
  { ...intResParam(), defaultValue: 'auto' } as ParamDef,
];

/* --------------------------------------------------------- 片段拼装 */

interface Slot {
  /** 槽号（1..4），决定 `u_sN_*` 前缀。 */
  n: number;
  geom: SdfGeom;
  id: string;
}

/** 当前参数下真正参与距离场的槽（`none` 不占代码，也不占 SDF 求值）。 */
export function activeSlots(values: Record<string, number | string>): Slot[] {
  const out: Slot[] = [];
  for (let n = 1; n <= SCENE_SLOTS; n++) {
    const id = String(values[`s${n}.def`] ?? 'none');
    const geom = getSdfGeom(id);
    if (geom) out.push({ n, geom, id });
  }
  return out;
}

/** 场景级 uniform。着色那 9 个走 `SDF_SHADE_UNIFORMS_GLSL`，不在这里。 */
const SCENE_UNIFORMS = `
uniform vec3  u_light;
uniform float u_gain;
uniform float u_fog;
uniform float u_ao;
uniform vec3  u_color;
uniform vec3  u_colorB;
uniform vec3  u_colorC;
uniform vec3  u_bg;
uniform int   u_bgMode;
uniform int   u_outDepth;   // 1 = 输出深度（当蒙版用）
uniform int   u_sky;        // 0 = 背景色 · 1 = 渐变 · 2 = 星空
uniform vec3  u_skyTop;
uniform vec3  u_skyLow;
uniform float u_dist;
uniform float u_push;
uniform float u_rate;
`;

/**
 * 场景的距离场与配套函数。
 *
 * ⚠️ **名字是 `sdScene` 不是 `sdMarch`**：内核按模板参数拼函数名，而
 * `fractals3d.test.ts` 的「3D 内核家族」覆盖面对着 `sdfMarch(` 认人 ——
 * 场景不进那一批（它没有单个 SDF，也不该被当成第四个分形）。
 */
function sceneBody(slots: Slot[]): string {
  const parts: string[] = [];

  slots.forEach((s, i) => {
    const pre = `s${s.n}_`;
    const { src, fn } = namespaceGeom(s.geom, pre);
    /*
     * **首个活跃槽不声明 `op`**：它没有「和谁组合」，`sdScene` 也不会读它。
     * 声明了但不读的 uniform 会被链接器丢掉，而 `compile-all` 的 dropped 判据
     * 会把它报成「声明了没被读过」（`lab.spec` 直接红）—— 那正是这条守卫要抓的
     * 东西，别把它当成误报。
     */
    const opDecl = i === 0 ? '' : `uniform int   u_s${s.n}_op;     // 0 并 · 1 减 · 2 交\n`;
    parts.push(`
/* ---- 槽 ${s.n}：${s.id} ---- */
uniform vec3  u_s${s.n}_pos;
uniform float u_s${s.n}_rot;    // 弧度
uniform float u_s${s.n}_zoom;
uniform float u_s${s.n}_fold;   // 0/1
uniform int   u_s${s.n}_mat;    // 0/1/2 → u_color / u_colorB / u_colorC
${opDecl}${src}

vec3 sdSlot${s.n}(vec3 p) {
  vec3 q = p - u_s${s.n}_pos;
  /* 槽的 rotY 是「这个物体怎么转」，所以世界 → 局部要反着转 */
  float a = -u_s${s.n}_rot;
  float c = cos(a), sn = sin(a);
  q.xz = mat2(c, -sn, sn, c) * q.xz;
  q /= max(u_s${s.n}_zoom, 1e-3);
  /* 折叠在槽的局部坐标里做（周期 2 = 几何体自己的周期）；跨槽折叠是错的 */
  if (u_s${s.n}_fold > 0.5) q = mod(q + 1.0, 2.0) - 1.0;
  return vec3(${fn}(q) * u_s${s.n}_zoom, float(u_s${s.n}_mat), 0.0);
}`);
  });

  const chain = slots
    .slice(1)
    .map((s) => `  acc = sceneCombine(acc, sdSlot${s.n}(p), u_s${s.n}_op);`)
    .join('\n');

  return `${parts.join('\n')}

/**
 * 两个槽的组合。材质只在「并」与「交」里被挑；「减」保留首槽的材质 ——
 * 挖出来的内壁与外壳是同一块材料。
 */
vec3 sceneCombine(vec3 a, vec3 b, int op) {
  if (op == 1) return vec3(max(a.x, -b.x), a.y, 0.0);
  if (op == 2) return vec3(max(a.x, b.x), a.x > b.x ? a.y : b.y, 0.0);
  return a.x <= b.x ? vec3(a.x, a.y, 0.0) : vec3(b.x, b.y, 0.0);
}

vec3 sdScene(vec3 p) {
  vec3 acc = sdSlot${slots[0]!.n}(p);
${chain}
  return acc;
}`;
}

/**
 * 材质号 → 颜色。三个槽色是**明确的三档**而不是调色板：场景由人摆位置，
 * 「按高度双色」那类自动配色会让两个物体在同一高度上撞成一个色。
 *
 * 它**与槽无关**，所以放在 `sceneBody` 外面：空场景（全 `none`）也要它，而那条
 * 分支不生成任何槽代码。第一版把它塞在槽代码里，于是「把最后一个槽设成空」
 * 直接编译失败（`sceneMat : no matching overloaded function`），而单测只检查了
 * 「占位 SDF 在不在」—— 拼出来的东西**必须真编一遍**才看得见这类错。
 */
const SCENE_MAT_GLSL = `
vec3 sceneMat(float m) {
  if (m < 0.5) return u_color;
  if (m < 1.5) return u_colorB;
  return u_colorC;
}`;

/** 天空。命中失败时用它，而不是一块平底色。 */
const SKY_GLSL = `
vec3 sceneSky(vec3 rd) {
  vec3 d = normalize(rd);
  float h = clamp(d.y * 0.5 + 0.5, 0.0, 1.0);
  vec3 col = mix(u_skyLow, u_skyTop, pow(h, 1.5));
  /* 太阳摆在主光方向上（迎着光看才有亮斑），与光照方向同一份数据 */
  float sun = pow(max(dot(d, u_light), 0.0), 64.0);
  col += vec3(1.0, 0.94, 0.82) * sun * 0.9;
  if (u_sky == 2) {
    /*
     * 星星：方向 → 格子 → 哈希。**不用 sin**：fract(sin(x)*43758.5) 在自变量
     * 上百之后低位不稳，方向坐标乘以格子尺度正好落在那一段，表现是星空逐帧
     * 闪烁。两层不同尺度是为了破掉单层网格感。
     */
    for (int i = 0; i < 2; i++) {
      float scale = i == 0 ? 90.0 : 190.0;
      vec3 g = floor(d * scale);
      float h1 = hash31(g + float(i) * 31.0);
      if (h1 > 0.986) {
        vec3 c = normalize(g + 0.5);
        float dist = length(d - c);
        col += vec3(step(dist, 0.012) * (0.5 + 0.5 * h1)) * smoothstep(0.0, 0.2, d.y);
      }
    }
  }
  return col;
}

vec4 sceneBackground(vec3 rd) {
  /*
   * 深度模式下「没有东西」= 最远，不是天空的亮度。
   *
   * ⚠️ **alpha 必须是 1，不能是 0。** 这是**数据**不是覆盖度：吐 alpha 0 的话，
   * 把这段当蒙版时背景读到的是层目标的残留 / 清屏色（实测是一层 0.8 左右的均匀
   * 灰），于是「只在物体上调色」变成「整幅都调了八成」—— 而直接看画面完全正常，
   * 只有拿它当蒙版才露馅。
   */
  if (u_outDepth == 1) return vec4(0.0, 0.0, 0.0, 1.0);
  if (u_sky != 0) return vec4(sceneSky(rd), 1.0);
  return u_bgMode == 1 ? vec4(0.0) : vec4(u_bg, 1.0);
}`;

const SCENE_MAIN = `
vec4 sdfSample() {
  float yaw = u_time * 0.06 * u_rate + u_push * 1.6;
  float pitch = 0.26 + 0.10 * sin(u_time * 0.045 * u_rate);
  vec3 eye;
  mat3 cam = sdfOrbitCam(yaw, pitch, u_dist * (1.0 - 0.22 * u_push), eye);
  vec3 rd = sdfRay(sdfUv, u_aspect, cam);

  float mat;
  float glow;
  float hit = sdfMarchMat(eye, rd, mat, glow);
  if (hit < 0.0) {
    return sceneBackground(rd);
  }
  if (u_outDepth == 1) {
    /* 近 = 亮。背景已经在上面返回 0，所以「离镜头多近」是这张图唯一的语义。 */
    return vec4(vec3(1.0 - clamp(hit / max(u_maxDist, 1e-3), 0.0, 1.0)), 1.0);
  }
  vec3 q = eye + rd * hit;
  vec3 n = sdfNormalMat(q, sdfNormalEps(hit));
  return vec4(sdfShade(q, n, rd, hit, sceneMat(mat)), 1.0);
}`;

interface BuiltScene {
  fragment: string;
  name: string;
}

/**
 * 拼好的片段缓存。键是**槽的 defId 序列** —— 只有它会改变 shader 的结构；
 * 位置 / 缩放 / 材质 / 组合方式全是 uniform。
 */
const CACHE = new Map<string, BuiltScene>();
const CACHE_MAX = 16;

function buildKey(slots: Slot[]): string {
  return slots.map((s) => `s${s.n}=${s.id}`).join(',');
}

/**
 * 由参数拼出完整 fragment。
 *
 * 没有槽时（全 `none`）退回「一块空场」而不是抛错：用户在界面上把最后一个
 * 槽设成空是合法动作，此时画面应该是一块背景色。
 */
export function buildScene(values: Record<string, number | string>): BuiltScene {
  const slots = activeSlots(values);
  const key = buildKey(slots);
  const hit = CACHE.get(key);
  if (hit) return hit;

  /*
   * 一个槽都没有时给一个恒远的占位 SDF。不能返回空字符串 —— `sdfKernelMaterial`
   * 里 `sdScene` 是前向声明的，没有定义就是链接错误。
   */
  const body = slots.length
    ? sceneBody(slots)
    : `vec3 sdScene(vec3 p) { return vec3(1.0e6, 0.0, 0.0); }`;

  const fragment =
    SCENE_UNIFORMS +
    SDF_SHADE_UNIFORMS_GLSL +
    sdfKernelMaterial('sdScene', { shade: true }) +
    HASH_FAST_GLSL +
    // 与槽无关的两段：材质取色 + 天空/背景（空场景也需要它们）
    SCENE_MAT_GLSL +
    SKY_GLSL +
    body +
    SCENE_MAIN +
    SDF_AA_MAIN;

  const built: BuiltScene = { fragment, name: `algo-scene-3d-${hash(key)}` };
  if (CACHE.size >= CACHE_MAX) CACHE.delete(CACHE.keys().next().value as string);
  CACHE.set(key, built);
  return built;
}

/** 短的稳定哈希（只用来给 program 起名，不做任何碰撞保证）。 */
function hash(s: string): string {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h * 33) ^ s.charCodeAt(i)) >>> 0;
  return h.toString(36);
}

/* ------------------------------------------------------------- 派发 */

/**
 * 场景自己的 uniform 派发。
 *
 * 槽的部分靠 `prefixedLocs` 把 `u_power` 映射到 `u_s1_power`，于是几何体
 * 的 `set` 一个字都不用改 —— 这也是「同一份几何既能单独用、也能进场景」的
 * 实现方式。`slotValues` 同理把 `s1.power` 还原成 `power`。
 */
function sceneUniforms(): AlgoSetUniforms {
  return (gl, l, v, ctx) => {
    sdfQualityUniforms()(gl, l, v, ctx);
    sdfLightUniforms()(gl, l, v, ctx);
    sdfShadeUniforms()(gl, l, v, ctx);

    set3(gl, l, 'u_color', String(v.color ?? '#dfe9ff'));
    set3(gl, l, 'u_colorB', String(v.colorB ?? '#3a6ea5'));
    set3(gl, l, 'u_colorC', String(v.colorC ?? '#c9a26b'));
    set3(gl, l, 'u_bg', String(v.bg ?? '#000000'));
    set1i(gl, l, 'u_outDepth', SCENE_OUTPUTS[String(v.outDepth ?? 'color')] ?? 0);
    set1i(gl, l, 'u_sky', SCENE_SKIES[String(v.sky ?? 'none')] ?? 0);
    set3(gl, l, 'u_skyTop', String(v.skyTop ?? '#0a1024'));
    set3(gl, l, 'u_skyLow', String(v.skyLow ?? '#2b3350'));

    const set1f = (name: string, value: number): void => {
      const loc = l[name];
      if (loc) gl.uniform1f(loc, value);
    };
    set1f('u_dist', Number(v.dist ?? 3.9));
    set1f('u_push', Number(v.push ?? 0));
    set1f('u_rate', Number(v.rate ?? 0.6));

    const slots = activeSlots(v);
    slots.forEach((s, i) => {
      const pre = `s${s.n}`;
      const slotLocs = prefixedLocs(l, `s${s.n}_`);
      // 先摆好槽的框架量，再让几何体派发自己的参数（两者名字不重叠）
      const pos = l[`u_${pre}_pos`];
      if (pos) {
        gl.uniform3f(
          pos,
          Number(v[`${pre}.x`] ?? 0),
          Number(v[`${pre}.y`] ?? 0),
          Number(v[`${pre}.z`] ?? 0),
        );
      }
      set1f(`u_${pre}_rot`, (Number(v[`${pre}.rotY`] ?? 0) * Math.PI) / 180);
      set1f(`u_${pre}_zoom`, Number(v[`${pre}.zoom`] ?? 1));
      const fold = v[`${pre}.fold`] === 'on' ? 1 : 0;
      set1f(`u_${pre}_fold`, fold);
      const matName = String(v[`${pre}.mat`] ?? 'mat1');
      set1i(gl, l, `u_${pre}_mat`, matName === 'mat3' ? 2 : matName === 'mat2' ? 1 : 0);
      /*
       * 首槽没有 `u_s<N>_op`（见 `sceneBody`）—— 写它会变成「摸到未声明的
       * uniform」，`algo-uniforms` 的单测直接红。
       */
      if (i > 0) {
        const op = String(v[`${pre}.op`] ?? 'union');
        set1i(gl, l, `u_${pre}_op`, op === 'subtract' ? 1 : op === 'intersect' ? 2 : 0);
      }

      s.geom.set(gl, slotLocs, slotValues(v, `${pre}.`), ctx, { infinite: fold === 1 });
    });
  };
}

/* --------------------------------------------------------------- def */

const DEFAULTS = defaultValues(PARAMS);
const DEFAULT_BUILD = buildScene(DEFAULTS);

export const scene3dDef: GeneratorDef = {
  id: 'scene-3d',
  nameKey: 'algo.scene3d',
  kind: 'realtime',
  // 单槽（= 出厂参数）的那一份。运行期走 `build`，这一份只给
  // 「预编译 / 接线自检 / 缩略图」这些拿不到参数表的场合一个确定的形态。
  fragment: DEFAULT_BUILD.fragment,
  params: PARAMS,
  build: (values) => buildScene(values),
  setUniforms: sceneUniforms(),
};

/** 供 UI / 测试读的默认值（`build` 的首次输入就是它）。 */
export const sceneDefaults = DEFAULTS;
