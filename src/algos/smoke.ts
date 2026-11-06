/**
 * smoke.ts — 体积烟雾，realtime 型。
 *
 * **解析包络只移动噪声的阈值**（不乘密度），三维 fbm 过阈值给出形状；
 * 然后沿一条固定步长的射线在体积里前向累积（单次散射 + Beer–Lambert 吸收）。
 * `浓度` 是真正的光学厚度，`采样精度` 是采样步数，自阴影是沿光方向的三步 march。
 *
 * ## 三条不这么写就出不来烟的约束
 *
 * 1. **包络只移动阈值。** 写成「密度 = 噪声 × 包络」，边界永远勾着那个解析锥，
 *    怎么调都是一根几何柱；写成阈值随包络移动，边界由噪声自己切，轮廓才是碎的。
 * 2. **阈值必须按实测分位数定。** `nzFbm3` 归一化后 p99.9 只有 0.81、包络的 p90 只有
 *    0.41 —— 凭直觉取 0~1 会得到「整屏灰雾」或「什么都没有」，而且不报错。
 * 3. **体积在 z 上只占半个噪声 cell。** 全 3D 的话 40 次采样把密度积分成常数
 *    （CLT），画面被抹平；压成 2.5D 之后 alpha 还留着横向结构，
 *    立体感改由光照提供。
 *
 * ## 性能（854×480 → 1280×720 → 1920×1080，40 步 / 3 阶 / 自阴影开）
 *
 * 0.88 ms · 1.48 ms · 3.32 ms。`shadow = 0` 在 720p 省到 1.13 ms（多出的三次
 * 采样全部省掉）；720p 拉到 96 步是 2.82 ms。
 * 能省的地方全在这里，别再添第二处：域扭曲**每像素一次**（不是每步）、
 * 旋流只在 `u_swirl > 0` 才做三角函数、包络外的射线靠 `e < 0.01` 直接跳过。
 *
 * ## 输出 alpha：全家族第一个支持透明底的生成器
 *
 * 协议见 `shader-lib.ts` 的 `bgModeParam()` 与 `AGENTS.md` 的「透明背景」一节。
 * 烟雾要能压到别的轨道上，就必须自己给覆盖度：
 * 累积完是**预乘**颜色（`acc` 已经乘过穿透率），而合成链的 render target 是
 * **直通 alpha**（见 `engine/placement.frag.ts`），所以最后一步要**除掉 alpha**
 * 才输出。`bgMode` 两档：`transparent` 直接吐 `vec4(smoke, a)`；
 * `solid` 在层内就合到底色上、并把 a 钉回 1（= 老生成器的行为）。
 *
 * ## 确定性
 *
 * 全部是 `u_time` 的闭式函数：没有逐帧累加、没有 `performance.now()`。
 * 采样位置沿 `-wind * t` 平移，于是「烟在流动」与「同一 t 两次渲一样」不冲突。
 */

import { selectInt } from '../effects/shader-def';
import { colorVec3 } from '../core/color';
import { bgColorVisible, bgModeParam, intResParam, type AlgoUniformCtx } from './shader-lib';
import { NOISE_GLSL } from './noise-lib';
import type { GeneratorDef } from './types';

/* ------------------------------------------------------------------ 着色器 */

/**
 * `u_lightAng` 由 JS 侧换成弧度（GLSL 里直接 cos/sin）。
 *
 * 采样循环的形状值得说明：`e < 0.01` 与 `d < 0.002` 两处提前 `continue`
 * 是**主要的省时手段** —— 包络外的射线根本不进 fbm。它们不影响确定性
 * （同一输入必得同一分支）。
 */
const SMOKE_FRAG = `
uniform int   u_mode;        // 0 = 从一点上升 · 1 = 从某一边涌入
uniform vec2  u_emit;        // 喷口位置（世界坐标，屏幕高 = 1）
uniform float u_emitWidth;   // 喷口半宽
uniform float u_rise;        // 上升高度（= 包络从喷口到顶端的世界距离）
uniform float u_spread;      // 锥形张开量
uniform int   u_edge;        // 0 下 · 1 上 · 2 左 · 3 右
uniform float u_density;     // 浓度（光学厚度）
uniform float u_scale;       // 噪声频率：越大烟团越碎
uniform int   u_octaves;     // fbm 阶数（1..4）
uniform float u_turb;        // 湍流（域扭曲幅度）
uniform float u_swirl;       // 绕轴旋流
uniform float u_dissip;      // 消散
uniform float u_contrast;    // 边缘碎化（阈值切得多硬）
uniform vec2  u_wind;        // 风（世界单位/秒），同时也是流向
uniform float u_speed;       // 速度倍率
uniform int   u_steps;       // 采样精度（沿射线的步数）
uniform float u_lightAng;    // 光方位角（弧度）
uniform float u_light;       // 受光强度
uniform float u_shadow;      // 自阴影强度（0 = 关掉第二次采样）
uniform vec3  u_colorDark;   // 阴影里的颜色
uniform vec3  u_colorLit;    // 受光面的颜色
uniform int   u_bgMode;      // 0 = 纯色 · 1 = 透明（全家族统一口径，见 bgModeParam）
uniform vec3  u_bg;          // 纯色底色

/* 三维 value noise / fbm 全部来自 noise-lib.ts（nzValue3 / nzFbm3）——
   这里是**唯一**的调用口径，不要再往本文件里贴一份私有实现。
   2.03 的 lacunarity 与 0.5 的 gain 是烟雾的既有观感，收在这个包装里；
   nzFbm3 的归一化与旧 fbmS 逐位等价（幅度和相除，起点 0.5 vs 1.0 无关）。 */
float smokeFbm(vec3 p) {
  return nzFbm3(p, 0, 0, u_octaves, 0.5, 2.03);
}

/* 喷口包络：一束往上张开、越往上越淡的锥。h < 0 处留一点余量，喷口不会是一条硬边。 */
float plumeEnv(vec2 p) {
  vec2 d = p - u_emit;
  float h = d.y / max(u_rise, 1e-3);
  float hh = clamp(h, 0.0, 1.0);
  float width = max(u_emitWidth + u_spread * u_rise * hh, 1e-3);
  /* 烟柱会摆。纯锥体一眼就是几何体，摆动是「不像程序生成」最便宜的那一步。 */
  float wob = sin(hh * 3.1 + u_time * 0.35 * u_speed) * u_turb * 0.20 * hh;
  float across = abs(d.x - wob) / width;
  float radial = 1.0 - smoothstep(0.0, 1.0, across);
  float vert = smoothstep(-0.04, 0.05, h) * (1.0 - smoothstep(0.55, 1.0, hh));
  vert *= exp(-hh * mix(0.15, 2.4, u_dissip));
  return radial * vert;
}

/* 边缘包络：源边最浓、往对侧指数衰减；贴边的地方再柔一下，不然会看到一条直线。 */
float edgeEnv(vec2 p) {
  float halfX = 0.5 * u_aspect;
  float d;
  if (u_edge == 1) d = 0.5 - p.y;
  else if (u_edge == 2) d = p.x + halfX;
  else if (u_edge == 3) d = halfX - p.x;
  else d = p.y + 0.5;
  float soft = smoothstep(0.0, 0.07, d);
  return soft * exp(-max(d, 0.0) * mix(0.8, 5.0, u_dissip));
}

void main() {
  vec2 p = (vUv - 0.5) * vec2(u_aspect, 1.0);
  /* 粗门：包络之外整条射线根本不进 fbm。这个 gate 用**未扰动**的坐标算，
     它是「这块像素有没有可能有烟」的必要条件，扰动只会让可能区变大不变小。 */
  float gate = (u_mode == 0 ? plumeEnv(p) : edgeEnv(p)) * 3.0;

  float alpha = 0.0;
  vec3 acc = vec3(0.0);

  if (gate > 0.004 && u_steps > 0) {
    float t = u_time * u_speed;
    /* 采样坐标沿 -wind*t 平移 = 噪声朝 +wind 方向流。种子只平移不旋转，
       否则同一工程的两次渲染会因为种子不同而根本不像。 */
    vec2 base = p - u_wind * t + vec2(u_seed * 53.0, u_seed * 91.0);

    /* 沿流向拉长。各向同性的噪声读成「云」，被流扯成丝才读成「烟」。
       拉伸量跟着风速走：风停了就没有理由继续拉。 */
    float wl = length(u_wind);
    vec2 fdir = wl > 1e-4 ? u_wind / wl : vec2(0.0, 1.0);
    float stretch = 1.0 + clamp(wl * 4.0, 0.0, 2.0);
    float along = dot(base, fdir);
    vec2 shaped = fdir * (along / stretch) + (base - fdir * along);

    /* 域扭曲：**每像素一次**。挪进循环里的话成本直接乘采样精度，
       而它本来就该是大尺度的缓慢场。它同时喂给噪声与包络（下面那个
       0.7 的系数）—— 包络不吃扰动的话轮廓永远是几何体。 */
    vec3 wp = vec3(shaped * 2.2, t * 0.06);
    /* warp 是**世界单位**（±0.5 + turb 缩放 ≈ 屏高的百分之几到十几）：
       它同时挪噪声和包络。坐标频率取 2.2 —— 早些时候取 0.8 时整块屏幕
       落在同一个噪声 cell 里，warp 变成常数，等于没有扭曲。 */
    vec2 warp = vec2(nzCentered(smokeFbm(wp)), nzCentered(smokeFbm(wp + vec3(4.7, 2.3, 1.9))));
    vec2 woff = warp * u_turb * 0.18;
    vec2 q2 = shaped + woff;
    vec2 pw = p + woff * 0.7;

    vec3 lightDir = normalize(vec3(cos(u_lightAng), sin(u_lightAng), 0.5));
    float dz = 1.0 / float(u_steps);
    float trans = 1.0;
    /* 采样平面固定在步中点（0.5），**不做逐像素抖动**。
       抖动原本是用来摊开 z 量化的，但这里的噪声在 z 上只占半个 cell，
       量化误差本来就看不见；而抖动会让最前面那个采样在像素之间挪位置，
       采样点上的包络跟着变，屏幕上就浮出一层洗不掉的细颗粒。 */
    float jitter = 0.5;

    /* ===== 密度 =====
       包络**只移动噪声的阈值**，既不乘密度也不单独做遮罩。轮廓能不能碎全看这一条：
       阈值在 0.42~0.56（包络中心）到 0.92（包络外）之间移动，而 smokeFbm 归一化后的
       p99.9 只有 0.81 —— 到不了 0.92，所以外面一粒沙都没有，边界却是由噪声自己
       切出来的。换成「密度 = 噪声 × 包络」，边界就永远勾着那个解析锥，
       怎么调参数都是一根几何柱。
       实测分布（各阶归一化、屏上的实际读数）：p50 0.51 · p90 0.66 · p99 0.76 ·
       p99.9 0.81。改 nzFbm3 的归一化方式或阶数都要重测这一组。 */
    float cutInner = mix(0.42, 0.56, u_contrast);

    for (int i = 0; i < u_steps; i++) {
      float z = (float(i) + jitter) * dz;
      /* 端面淡出：不然射线进出体积时是一条直边。只在两端 20% 处起作用。 */
      float zFade = smoothstep(0.0, 0.2, z) * smoothstep(1.0, 0.8, z);
      if (zFade < 0.01) continue;

      /* 旋流：绕喷口轴扭，扭量随深度变 —— 每个深度切出的横截面都不一样，
         叠起来才是「一边上升一边打卷」的柱体，而不是一根被拉长的直筒。
         包络只吃到 1/3 的角：plumeEnv 量的是**水平距离**，在屏幕平面里转它不是
         对称操作，转满会让轮廓随 z 扫出一片扇形 —— 于是把「旋流」拧到 0
         覆盖度就掉到三分之一（实测 8.9% → 3.1%），一个美学参数顺手改了体积。 */
      vec2 qq = q2;
      vec2 pp = pw;
      if (u_swirl > 0.001) {
        float ang = u_swirl * ((z - 0.5) * 3.0 + t * 0.15);
        float c = cos(ang);
        float s = sin(ang);
        qq = mat2(c, -s, s, c) * (q2 - u_emit) + u_emit;
        float c2 = cos(ang * 0.33);
        float s2 = sin(ang * 0.33);
        pp = mat2(c2, -s2, s2, c2) * (pw - u_emit) + u_emit;
      }

      /* 包络在**每个深度**重算（旋流转过之后），但不吃 zFade —— zFade 只乘密度，
         它是深度方向的淡出，不该参与「这里算不算烟」的判定。 */
      float env0 = (u_mode == 0 ? plumeEnv(pp) : edgeEnv(pp));
      /* 先把包络归一化到它**实际能到**的量级。plumeEnv 是锥形 × 竖直衰减 × 耗散
         三个因子的乘积，实测在屏上的 p90 只有 0.41，远不是 0..1 铺满的。
         直接拿它插值阈值等于把切点抬到噪声 p99 之上：整个体积几乎没烟
         （swirl = 0 时屏幕上只剩一个点）。0.85 是量出来的上限区间。 */
      float e = smoothstep(0.0, 0.85, env0);
      if (e < 0.01) continue;

      vec3 q = vec3(qq * u_scale, (z - 0.5) * u_scale * 0.15);
      /* 阈值再叠一层**沿 z 相干**的扰动。轮廓的定义是「整条射线都空」，
         阈值若在 z 上不变，那条边界就是一条解析等值线 —— 旋流拧到 0 时
         整根烟会变成两片饼干模压的平面剪影。两层正弦在 z 上的周期分别是
         ~2.6 和 ~1.2，相当于沿深度取了 2~3 个不同的轮廓再取并集：
         边界碎了，积分也还剩一点方差（不是完全平均掉）。 */
      float thrZ = 0.09 * (sin(z * 2.4 + shaped.x * 1.7) + sin(z * 5.1 + shaped.y * 2.3));
      float d = clamp((smokeFbm(q) - (mix(0.92, cutInner, e) + thrZ)) * 4.0, 0.0, 1.0) * zFade;
      if (d < 0.002) continue;

      /* 朝光源走三步，每一步都用**同一套阈值**估一次密度，累加成光学厚度。
         这是体积感的来源：只做一次邻居采样时，40 次积分把它平均成常数
         （实测亮度范围从 28..161 塌成 28..86），画面又变回一片平。
         走的方向是 lightDir，含 z 分量，所以明暗也随深度变。 */
      float lit = 1.0;
      if (u_shadow > 0.001) {
        float od = 0.0;
        for (int k = 1; k <= 3; k++) {
          od += clamp((smokeFbm(q + lightDir * (float(k) * 0.5)) - cutInner + 0.10) * 4.0, 0.0, 1.0);
        }
        lit = exp(-od * 1.5 * u_shadow);
      }

      /* 26 是把 0..1 的密度折成「每单位长度的消光系数」的常数。
         d 的量级很小（阈值切出来的那段尾巴，典型 0.05~0.2），
         所以这个系数必须大一个数量级 —— 否则浓度滑杆推到 1 也只积出 alpha 0.1，
         用户会以为滑杆坏了。 */
      float tau = d * u_density * dz * 26.0;
      float aStep = 1.0 - exp(-tau);
      vec3 c = mix(u_colorDark, u_colorLit, clamp(u_light * lit, 0.0, 1.0));
      acc += trans * aStep * c;
      trans *= 1.0 - aStep;
      if (trans < 0.015) break;
    }
    alpha = clamp(1.0 - trans, 0.0, 1.0);
  }

  /* acc 是预乘的，合成链要直通 alpha（见文件头）。 */
  vec3 smoke = alpha > 1e-3 ? acc / alpha : vec3(0.0);
  if (u_bgMode == 0) {
    outColor = vec4(mix(u_bg, smoke, alpha), 1.0);
  } else {
    outColor = vec4(smoke, alpha);
  }
}`;

/* -------------------------------------------------------------------- 参数 */

const MODES: Record<string, number> = { plume: 0, edge: 1 };
const EDGES: Record<string, number> = { bottom: 0, top: 1, left: 2, right: 3 };
const OCTAVES: Record<string, number> = { '2': 2, '3': 3, '4': 4 };

const isPlume = (v: Record<string, number | string>): boolean => v.mode === 'plume';
const isEdge = (v: Record<string, number | string>): boolean => v.mode === 'edge';

export const smokeDef: GeneratorDef = {
  id: 'smoke',
  nameKey: 'algo.smoke',
  kind: 'realtime',
  fragment: NOISE_GLSL + SMOKE_FRAG,
  params: [
    {
      key: 'mode',
      labelKey: 'algo.smoke.mode',
      type: 'select',
      defaultValue: 'plume',
      options: [
        { labelKey: 'algo.smoke.modePlume', value: 'plume' },
        { labelKey: 'algo.smoke.modeEdge', value: 'edge' },
      ],
    },
    {
      key: 'emitX',
      labelKey: 'algo.smoke.emitX',
      type: 'range',
      min: -1,
      max: 1,
      step: 0.005,
      defaultValue: 0,
      visibleWhen: isPlume,
    },
    {
      key: 'emitY',
      labelKey: 'algo.smoke.emitY',
      type: 'range',
      min: -0.6,
      max: 0.6,
      step: 0.005,
      defaultValue: -0.45,
      visibleWhen: isPlume,
    },
    {
      key: 'emitWidth',
      labelKey: 'algo.smoke.emitWidth',
      type: 'range',
      min: 0.01,
      max: 0.4,
      step: 0.005,
      defaultValue: 0.13,
      visibleWhen: isPlume,
    },
    {
      key: 'rise',
      labelKey: 'algo.smoke.rise',
      type: 'range',
      min: 0.2,
      max: 2,
      step: 0.01,
      defaultValue: 1.15,
      visibleWhen: isPlume,
    },
    {
      key: 'spread',
      labelKey: 'algo.smoke.spread',
      type: 'range',
      min: 0,
      max: 1.2,
      step: 0.01,
      defaultValue: 0.18,
      visibleWhen: isPlume,
    },
    {
      key: 'edge',
      labelKey: 'algo.smoke.edge',
      type: 'select',
      defaultValue: 'bottom',
      visibleWhen: isEdge,
      options: [
        { labelKey: 'algo.smoke.edgeBottom', value: 'bottom' },
        { labelKey: 'algo.smoke.edgeTop', value: 'top' },
        { labelKey: 'algo.smoke.edgeLeft', value: 'left' },
        { labelKey: 'algo.smoke.edgeRight', value: 'right' },
      ],
    },

    { key: 'density', labelKey: 'algo.smoke.density', type: 'range', min: 0, max: 1.5, step: 0.01, defaultValue: 1 },
    { key: 'scale', labelKey: 'algo.smoke.scale', type: 'range', min: 1, max: 16, step: 0.1, defaultValue: 10 },
    {
      key: 'octaves',
      labelKey: 'algo.smoke.octaves',
      type: 'select',
      defaultValue: '3',
      options: [
        { labelKey: 'algo.smoke.octaves2', value: '2' },
        { labelKey: 'algo.smoke.octaves3', value: '3' },
        { labelKey: 'algo.smoke.octaves4', value: '4' },
      ],
    },
    { key: 'turb', labelKey: 'algo.smoke.turb', type: 'range', min: 0, max: 1, step: 0.01, defaultValue: 0.32 },
    { key: 'swirl', labelKey: 'algo.smoke.swirl', type: 'range', min: 0, max: 1, step: 0.01, defaultValue: 0.14 },
    { key: 'dissip', labelKey: 'algo.smoke.dissip', type: 'range', min: 0, max: 1, step: 0.01, defaultValue: 0.35 },
    { key: 'contrast', labelKey: 'algo.smoke.contrast', type: 'range', min: 0, max: 1, step: 0.01, defaultValue: 0.55 },

    { key: 'speed', labelKey: 'algo.smoke.speed', type: 'range', min: 0, max: 3, step: 0.01, defaultValue: 1 },
    { key: 'windX', labelKey: 'algo.smoke.windX', type: 'range', min: -0.5, max: 0.5, step: 0.005, defaultValue: 0.04 },
    { key: 'windY', labelKey: 'algo.smoke.windY', type: 'range', min: -0.5, max: 0.5, step: 0.005, defaultValue: 0.18 },

    {
      key: 'steps',
      labelKey: 'algo.smoke.steps',
      type: 'range',
      min: 8,
      max: 96,
      step: 4,
      defaultValue: 40,
    },

    { key: 'lightAng', labelKey: 'algo.smoke.lightAng', type: 'range', min: 0, max: 360, step: 1, defaultValue: 35 },
    { key: 'light', labelKey: 'algo.smoke.light', type: 'range', min: 0, max: 1, step: 0.01, defaultValue: 0.85 },
    { key: 'shadow', labelKey: 'algo.smoke.shadow', type: 'range', min: 0, max: 1, step: 0.01, defaultValue: 0.5 },
    { key: 'colorDark', labelKey: 'algo.smoke.colorDark', type: 'color', defaultValue: '#20232b' },
    { key: 'colorLit', labelKey: 'algo.smoke.colorLit', type: 'color', defaultValue: '#e2e8f2' },

    /* 出厂透明（烟雾的本性就是压在别的东西上）—— 它是全家族第一个有这个东西的，
       所以缺省与别人相反；缩略图因此必须强制 solid，见 catalog.ts。 */
    { ...bgModeParam(), defaultValue: 'transparent' },
    {
      key: 'bg',
      labelKey: 'algo.smoke.bg',
      type: 'color',
      defaultValue: '#000000',
      visibleWhen: bgColorVisible,
    },
    intResParam(),
  ],
  setUniforms: (gl, l, v, ctx) => {
    /* `Number(undefined)` 是 NaN，而 `uniform2f(NaN)` 会把整幅画变成 NaN 而不是报错 ——
       手改过的工程文件少一个键就会走到这条路，所以统一收口到 0。 */
    const num = (k: string): number => {
      const x = Number(v[k]);
      return Number.isFinite(x) ? x : 0;
    };
    const angle = (k: string): number => (num(k) * Math.PI) / 180;
    const u1 = (name: string, x: number): void => {
      const p = l[name];
      if (p) gl.uniform1f(p, x);
    };
    const u2 = (name: string, x: number, y: number): void => {
      const p = l[name];
      if (p) gl.uniform2f(p, x, y);
    };
    const u3 = (name: string, hex: string): void => {
      const p = l[name];
      if (!p) return;
      const [r, g, b] = colorVec3(hex);
      gl.uniform3f(p, r, g, b);
    };
    /** int uniform 必须走 uniform1i —— 用 uniform1f 写它是 INVALID_OPERATION 且**静默不写**。 */
    const i1 = (name: string, x: number): void => {
      const p = l[name];
      if (p) gl.uniform1i(p, Math.round(x));
    };

    /* select 一律走 `selectInt`：它与 mandelbrot 的 variant 同一条路 ——
       `floats()` 的 `Number(v[key]) || 0` 会把字符串派发成 0。 */
    /* `u_bgMode` 由 AlgoRuntime 统一派发（全家族一套口径），这里不重复写。 */
    selectInt<AlgoUniformCtx>('mode', MODES)(gl, l, v, ctx);
    selectInt<AlgoUniformCtx>('edge', EDGES)(gl, l, v, ctx);
    selectInt<AlgoUniformCtx>('octaves', OCTAVES)(gl, l, v, ctx);

    u2('u_emit', num('emitX'), num('emitY'));
    u2('u_wind', num('windX'), num('windY'));
    u1('u_emitWidth', num('emitWidth'));
    u1('u_rise', num('rise'));
    u1('u_spread', num('spread'));
    u1('u_density', num('density'));
    u1('u_scale', num('scale'));
    u1('u_turb', num('turb'));
    u1('u_swirl', num('swirl'));
    u1('u_dissip', num('dissip'));
    u1('u_contrast', num('contrast'));
    u1('u_speed', num('speed'));
    i1('u_steps', num('steps'));
    u1('u_lightAng', angle('lightAng'));
    u1('u_light', num('light'));
    u1('u_shadow', num('shadow'));
    u3('u_colorDark', String(v.colorDark ?? '#20232b'));
    u3('u_colorLit', String(v.colorLit ?? '#e8eef8'));
    u3('u_bg', String(v.bg ?? '#000000'));
  },
};
