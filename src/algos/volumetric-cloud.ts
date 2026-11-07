/**
 * volumetric-cloud.ts — 体积云，`realtime` 型。
 *
 * 一条射线从镜头出发，与**一层无限大的水平云板**解析求交，然后在板内按固定
 * 步长前向累积（单次散射 + Beer–Lambert）；每一步朝太阳再走四步估一次光学
 * 厚度，那就是云的立体感来源。噪声全部走 `noise-lib.ts` 的 `nzFbm3`。
 *
 * ## 相机为什么不给位置
 *
 * 眼恒在世界原点，姿态由 `yaw / pitch / roll` 定。**「镜头在云上还是云下」
 * 由 `u_altitude`（云层底的高度）表达**，正数 = 云在头顶（仰望），负数 =
 * 云在脚下（俯视云海）。给裸位置的话，用户很容易把镜头挪进云里 —— 那时整幅
 * 画面只剩一片白，而且没有任何提示。云层是水平的，这个自由度本来就该归云层。
 *
 * ## 六条不这么写就出不来云的约束（全部是实测踩出来的）
 *
 * 1. **高度包络只移动阈值，不乘密度。** 写成「密度 = 噪声 × 包络」的话，
 *    云顶永远勾着那个解析平面，怎么调都是一块板（`smoke.ts` 踩过同一条）。
 * 2. **阈值必须按实测分位数定。** `nzFbm3` 归一化后 p50 0.51 / p90 0.66 /
 *    p99.9 0.81。凭直觉取 0~1 只会得到「整屏白」或「什么都没有」，且不报错。
 *    这里的两端 0.80（≈ 无云）与 0.46（≈ 七成是云）都落在读数范围内。
 * 3. **`soft` 必须按 fbm 的标准差换算。** 它是个 0..1 的滑杆，直接拿 0.3 当
 *    smoothstep 的带宽（= 3 个标准差）等于把每朵云糊成半透明的雾 —— 实测整幅
 *    是一层脏灰。带宽口径收在 `0.004 + 0.06·soft` 里。
 * 4. **自阴影要用一条更松的阈值。** 拿云体那条硬阈值去采光线上的点，四处
 *    全是 0 ⇒ `od = 0` ⇒ `lit ≡ 1`，也就是「自阴影看起来根本没开」，而参数、
 *    派发、编译全都正常。
 * 5. **明暗不能直接拿相位当亮度。** 相位只在朝太阳时接近 1，背光那一侧整幅
 *    会压在混色区间的中段：实测每朵云都是同一种浅灰（像石膏）。相位只做窄
 *    倍率（`0.55 + 0.45·phase`），明暗由 `lit` 走满 colorDark → colorLit。
 * 6. **视距要淡出。** 接近地平线的射线在云板里的跨度可以到视距那么长，按它
 *    均分步长会把云积分成一条灰带；淡出把它连同粗步长的痕迹一起收掉，顺便
 *    给了「云海在地平线没入天空」的那个形态。起点取 0.25·视距 —— 那一段的
 *    采样间隔最大、颗粒最明显，让它们早早沉进天空比加步数便宜。
 *
 * ## 逐像素抖动是必需的，不是可选的美化
 *
 * 步长均分 ⇒ 采样点落在**固定的几层壳**上。掠射角下云体边界与这些壳相交，
 * 画面就出现一圈圈同心的细横纹（第一版就是这个样子，而且不容易认出是采样
 * 问题）。抖动把壳打散成噪声，代价是边缘上有一点细颗粒 —— 它与「横纹」是
 * 同一件事的两面，别只为颗粒把抖动关掉。抖动取自 `gl_FragCoord` 的 hash，
 * 是像素的纯函数：同一 t 两渲仍然逐字节相同，不违反确定性。
 *
 * ## 成本与步数
 *
 * 每步一次 `nzFbm3`（默认 3 阶 = 24 次 hash），入云之后再加四次（自阴影）。
 * 实测（48 步、默认参数、连渲 8 帧 + 一次读回摊薄、5 轮取最小值；含合成与
 * 读回那部分固定开销）：内部 480 → **4.3 ms**、720 → **5.0 ms**、1080 →
 * **7.6 ms**。按像素数推 1440p 约 11 ms —— 这是这台机器（4070 laptop）的读数，
 * 换机器要重测。
 *
 * **超了就降步数、不要降分辨率**（`intRes` 默认 `auto`）：分辨率降下去云边
 * 糊成一片，而步数降下去只是层次变软。要画质优先就往上推步数（上限 64）。
 *
 * ## 透明底
 *
 * `bgMode` 走全家族共用那一份（`shader-lib.ts` 的 `bgModeParam()`），缺省
 * `solid`（云要有天空）。透明时吐直通 alpha（`vec4(云色, 覆盖度)`），不掺
 * 底色 —— 掺了的话半覆盖的像素会把天空又画一遍，边界上一圈脏边。
 */

import { colorVec3 } from '../core/color';
import { selectInt } from '../effects/shader-def';
import { bgColorVisible, bgModeParam, intResParam, type AlgoUniformCtx } from './shader-lib';
import { NOISE_GLSL } from './noise-lib';
import type { GeneratorDef } from './types';

/** 步数的编译期上界。参数表的 `max` 必须等于它（超了 = 拖到底也不再变）。 */
export const CLOUD_MAX_STEPS = 64;

/** `octaves` 的取值 → `u_octaves`。少一项 = 那个选项静默退化成 1 阶。 */
export const CLOUD_OCTAVES: Record<string, number> = { '2': 2, '3': 3, '4': 4 };

const FRAG = `
uniform float u_altitude;    // 云层底的高度（世界单位；>0 = 云在头顶）
uniform float u_thick;       // 云层厚度
uniform float u_cover;       // 云量
uniform float u_density;     // 密度（每世界单位的消光）
uniform float u_scale;       // 团块尺度（每个世界单位几个噪声格）
uniform int   u_octaves;     // fbm 阶数
uniform float u_soft;        // 边缘柔和（阈值的过渡带宽）
uniform float u_speed;       // 流速（世界单位/秒）
uniform float u_flowDir;     // 流向（弧度）
uniform float u_patternSeed; // 图案种子（只挪采样坐标，不掺 hash）
uniform float u_yaw;         // 相机方位角（弧度）
uniform float u_pitch;       // 相机俯仰（弧度）
uniform float u_roll;        // 相机滚转（弧度）
uniform float u_fov;         // 视场
uniform float u_orbit;       // 环绕角速度（弧度/秒；0 = 不环绕）
uniform vec2  u_shift;       // 画面偏移（投影中心）
uniform float u_sunAz;       // 太阳方位角（弧度）
uniform float u_sunEl;       // 太阳仰角（弧度）
uniform float u_bright;      // 阳光强度
uniform float u_ambient;     // 环境光
uniform float u_shade;       // 自阴影强度（0 = 省掉第三次采样）
uniform float u_viewDist;    // 视距（超出这个距离的云淡出到天空）
uniform int   u_steps;       // 采样步数
uniform vec3  u_colorLit;    // 受光色
uniform vec3  u_colorDark;   // 暗部色
uniform int   u_bgMode;      // 0 = 纯色 · 1 = 透明（全家族统一口径，见 bgModeParam）
uniform vec3  u_bg;          // 天空色

/** GLSL ES 的循环偏好常量界，运行期由 u_steps 提前 break。 */
const int VC_MAX_STEPS = ${CLOUD_MAX_STEPS};

/* 云层在竖直方向的包络：底略收、顶渐消。
   **它只移动密度阈值，不乘密度** —— 见文件头第 1 条。 */
float cloudLayerShape(float hy) {
  float base = smoothstep(0.0, 0.16, hy);
  float top = 1.0 - smoothstep(0.5, 1.0, hy);
  return base * top;
}

/* 世界坐标 → 噪声坐标。漂移沿 -wind 走 = 图案朝 +wind 流（与 smoke 同口径）。
   种子只做平移、不旋转也不掺 hash：同一工程的两次渲染必须落到同一张图上。 */
vec3 cloudNoisePos(vec3 p, vec3 drift) {
  return (p - drift) * u_scale
       + vec3(u_patternSeed * 53.0, u_patternSeed * 91.0, u_patternSeed * 37.0);
}

/* 噪声值 + 该点的高度阈值。两者一起返回是因为**光照 march 要用更松的阈值**：
   云体的实体按 thr 硬切，而「这一带有没有料」要用一条宽的过渡带 —— 拿同一条
   硬阈值去采光线上的四个点，四处全是 0，自阴影就恒等于「没有阴影」，且不报错。 */
float cloudField(vec3 p, vec3 drift, out float thr) {
  float hy = (p.y - u_altitude) / max(u_thick, 1e-3);
  float env = cloudLayerShape(hy);
  float cov = clamp(u_cover * (0.30 + 0.70 * env), 0.0, 1.0);
  /* 阈值区间按 nzFbm3 的实测分位数定（见文件头第 2 条）。 */
  thr = mix(0.80, 0.46, cov);
  return nzFbm3(cloudNoisePos(p, drift), 0, 0, clamp(u_octaves, 1, NZ_MAX_OCTAVES), 0.5, 2.0);
}

/* 云体密度（0..1）。层外直接 0：那是整条 march 里最省的一刀。
   u_soft 是 0..1 的滑杆，**过渡带宽度要按 fbm 的标准差换算**（约 0.1）：
   直接拿 0.3 当带宽等于把每个云团都糊成半透明的雾（实测：画面像一层脏灰，
   而不是一朵朵云）。 */
float cloudDensity(vec3 p, vec3 drift) {
  float hy = (p.y - u_altitude) / max(u_thick, 1e-3);
  if (cloudLayerShape(hy) < 0.004) return 0.0;
  float thr;
  float n = cloudField(p, drift, thr);
  return smoothstep(thr, thr + 0.004 + 0.060 * u_soft, n);
}

void main() {
  /* 相机：眼恒在原点，姿态由三个角度定（见文件头「相机为什么不给位置」）。 */
  float yaw = u_yaw + u_orbit * u_time;
  float pit = clamp(u_pitch, -1.45, 1.45);
  vec3 fwd = vec3(sin(yaw) * cos(pit), sin(pit), cos(yaw) * cos(pit));
  /* 上向量必须显式给：视线竖直时 cross(+Y, fwd) 趋近零向量，右向量的方向
     由浮点噪声决定（表现是「抬头时猛地转 180°」）。pitch 已夹到 ±83°。 */
  vec3 right0 = normalize(cross(vec3(0.0, 1.0, 0.0), fwd));
  vec3 up0 = cross(fwd, right0);
  float cr = cos(u_roll);
  float sr = sin(u_roll);
  vec3 right = right0 * cr + up0 * sr;
  vec3 up = -right0 * sr + up0 * cr;

  vec2 sc = (vUv - 0.5 - u_shift) * vec2(u_aspect, 1.0);
  vec3 rd = normalize(fwd + (right * sc.x + up * sc.y) * u_fov);

  vec3 sunDir = normalize(vec3(cos(u_sunAz) * cos(u_sunEl), sin(u_sunEl), sin(u_sunAz) * cos(u_sunEl)));

  /* 漂移提到循环外：它是 u_time 的闭式函数，逐样本算 cos/sin 是白花钱。 */
  vec3 drift = vec3(cos(u_flowDir), 0.0, sin(u_flowDir)) * (u_time * u_speed);

  /* 无限水平云板：解析求交。|rd.y| 极小时不去除 —— 那种射线要么整条在板里，
     要么根本不相交（镜头在 y = 0，所以只有板跨过 0 时才算在板里）。 */
  float y0 = u_altitude;
  float y1 = u_altitude + u_thick;
  float tA = 0.0;
  float tB = 0.0;
  bool hit = true;
  if (abs(rd.y) < 1e-4) {
    hit = y0 <= 0.0 && y1 >= 0.0;
    tA = 0.0;
    tB = u_viewDist;
  } else {
    tA = y0 / rd.y;
    tB = y1 / rd.y;
    if (tA > tB) { float tmp = tA; tA = tB; tB = tmp; }
    tA = max(tA, 0.0);
    tB = min(tB, u_viewDist);
    hit = tB > tA;
  }

  float alpha = 0.0;
  vec3 acc = vec3(0.0);

  if (hit && u_steps > 0) {
    float ds = (tB - tA) / float(u_steps);
    float trans = 1.0;
    vec3 lightStep = sunDir * (u_thick * 0.45);
    float mu = max(dot(rd, sunDir), 0.0);
    /* 相位：逆光时云边更亮（银边）。没有真正的散射积分，这是它最便宜的替身。 */
    float phase = 0.35 + 1.6 * pow(mu, 5.0);
    /* 逐像素抖动入口。步长是均分的，采样点因此落在**固定的几层壳**上 ——
       掠射角下云体边界与这些壳相交，画面出现一圈圈同心的细横纹（实测）。
       抖动把壳打散成噪声。hash21 不带 sin（大像素坐标下稳定），且它是
       gl_FragCoord 的纯函数：同一 t 两渲仍然逐字节相同。 */
    float jitter = hash21(gl_FragCoord.xy + vec2(u_patternSeed * 91.0));

    for (int i = 0; i < VC_MAX_STEPS; i++) {
      if (i >= u_steps) break;
      float t = tA + (float(i) + jitter) * ds;
      /* 远处淡出：既是「视距」的语义，也把近地平线那一带的粗步长积分藏起来。
         起点取 0.25 而不是 0.5：掠射角的跨度能到视距那么长，那一段的采样
         间隔最大，颗粒也最明显 —— 让它们早早沉进天空，比加步数便宜得多。 */
      float haze = 1.0 - smoothstep(u_viewDist * 0.25, u_viewDist * 0.9, t);
      if (haze < 0.002) break;

      vec3 p = rd * t;
      float d = cloudDensity(p, drift) * haze;
      if (d < 0.004) continue;

      float lit = 1.0;
      if (u_shade > 0.001) {
        /* 朝太阳走四步，并用**更松的阈值**累加光学厚度（见 cloudField 的说明）。 */
        vec3 lp = p;
        float od = 0.0;
        for (int k = 1; k <= 4; k++) {
          lp += lightStep;
          float lthr;
          float ln = cloudField(lp, drift, lthr);
          od += smoothstep(lthr - 0.22, lthr + 0.06, ln);
        }
        lit = exp(-od * u_shade * 2.2);
      }

      /* 明暗 = 直射光的可见度，**不能直接拿 phase 当亮度**：phase 只在朝向
         太阳时才接近 1，背光那一侧整幅会被压在混色区间的中段 —— 实测所有云
         都是同一种浅灰，看起来像石膏。这里把 phase 折成一个窄的倍率，
         明暗由 lit 走满 colorDark → colorLit 的全程。 */
      float scatter = 0.55 + 0.45 * phase;
      vec3 c = mix(u_colorDark, u_colorLit, clamp(u_ambient + u_bright * lit * scatter, 0.0, 1.0));

      /* 7.0 把 [0..1] 的密度折成「每世界单位的消光」。云体要挡得住背后的天空，
         否则整幅读成一层薄雾 —— 所以这个系数比烟雾那只大一号。 */
      float tau = d * u_density * ds * 7.0;
      float aStep = 1.0 - exp(-tau);
      acc += trans * aStep * c;
      trans *= 1.0 - aStep;
      /* 累积到最后 1% 就停（早退要求，也是低步数档下省一半钱的来源）。 */
      if (trans < 0.01) break;
    }
    alpha = clamp(1.0 - trans, 0.0, 1.0);
  }

  /* acc 是预乘的，合成链要直通 alpha（见文件头「透明底」）。 */
  vec3 cloud = alpha > 1e-3 ? acc / alpha : vec3(0.0);
  if (u_bgMode == 0) {
    outColor = vec4(mix(u_bg, cloud, alpha), 1.0);
  } else {
    outColor = vec4(cloud, alpha);
  }
}`;

export const volumetricCloudDef: GeneratorDef = {
  id: 'volumetric-cloud',
  nameKey: 'algo.volumetricCloud',
  kind: 'realtime',
  fragment: NOISE_GLSL + FRAG,
  params: [
    /* ---- 云层 ---- */
    {
      key: 'altitude',
      labelKey: 'algo.volumetricCloud.altitude',
      type: 'range',
      min: -3,
      max: 3,
      step: 0.01,
      defaultValue: -2.2,
    },
    {
      key: 'thick',
      labelKey: 'algo.volumetricCloud.thick',
      type: 'range',
      min: 0.2,
      max: 3,
      step: 0.01,
      defaultValue: 1.5,
    },
    { key: 'cover', labelKey: 'algo.volumetricCloud.cover', type: 'range', min: 0, max: 1, step: 0.01, defaultValue: 0.55 },
    {
      key: 'density',
      labelKey: 'algo.volumetricCloud.density',
      type: 'range',
      min: 0.05,
      max: 3,
      step: 0.01,
      defaultValue: 1.6,
    },
    {
      key: 'scale',
      labelKey: 'algo.volumetricCloud.scale',
      type: 'range',
      min: 0.4,
      max: 6,
      step: 0.05,
      defaultValue: 1.6,
    },
    {
      key: 'octaves',
      labelKey: 'algo.volumetricCloud.octaves',
      type: 'select',
      defaultValue: '3',
      options: [
        { labelKey: 'algo.volumetricCloud.octaves2', value: '2' },
        { labelKey: 'algo.volumetricCloud.octaves3', value: '3' },
        { labelKey: 'algo.volumetricCloud.octaves4', value: '4' },
      ],
    },
    { key: 'soft', labelKey: 'algo.volumetricCloud.soft', type: 'range', min: 0, max: 1, step: 0.01, defaultValue: 0.6 },
    {
      key: 'viewDist',
      labelKey: 'algo.volumetricCloud.viewDist',
      type: 'range',
      min: 4,
      max: 60,
      step: 0.5,
      defaultValue: 16,
    },

    /* ---- 流动 ---- */
    { key: 'speed', labelKey: 'algo.volumetricCloud.speed', type: 'range', min: 0, max: 3, step: 0.01, defaultValue: 0.3 },
    {
      key: 'flowDir',
      labelKey: 'algo.volumetricCloud.flowDir',
      type: 'range',
      min: -180,
      max: 180,
      step: 1,
      defaultValue: 35,
    },
    {
      key: 'patternSeed',
      labelKey: 'algo.volumetricCloud.patternSeed',
      type: 'range',
      min: 0,
      max: 1,
      step: 0.001,
      defaultValue: 0.25,
    },

    /* ---- 相机（与 black-hole 同一套说法：三个角度 + 移轴 + 环绕 + 视场） ---- */
    { key: 'yaw', labelKey: 'algo.volumetricCloud.yaw', type: 'range', min: -180, max: 180, step: 1, defaultValue: 20 },
    { key: 'pitch', labelKey: 'algo.volumetricCloud.pitch', type: 'range', min: -80, max: 80, step: 1, defaultValue: -12 },
    { key: 'roll', labelKey: 'algo.volumetricCloud.roll', type: 'range', min: -180, max: 180, step: 1, defaultValue: 0 },
    { key: 'fov', labelKey: 'algo.volumetricCloud.fov', type: 'range', min: 0.5, max: 2.5, step: 0.01, defaultValue: 1 },
    {
      key: 'orbit',
      labelKey: 'algo.volumetricCloud.orbit',
      type: 'range',
      min: -0.3,
      max: 0.3,
      step: 0.005,
      defaultValue: 0,
    },
    {
      key: 'shiftX',
      labelKey: 'algo.volumetricCloud.shiftX',
      type: 'range',
      min: -0.5,
      max: 0.5,
      step: 0.005,
      defaultValue: 0,
    },
    {
      key: 'shiftY',
      labelKey: 'algo.volumetricCloud.shiftY',
      type: 'range',
      min: -0.5,
      max: 0.5,
      step: 0.005,
      defaultValue: 0,
    },

    /* ---- 阳光 ---- */
    {
      key: 'sunAz',
      labelKey: 'algo.volumetricCloud.sunAz',
      type: 'range',
      min: -180,
      max: 180,
      step: 1,
      defaultValue: -40,
    },
    { key: 'sunEl', labelKey: 'algo.volumetricCloud.sunEl', type: 'range', min: -15, max: 90, step: 1, defaultValue: 12 },
    { key: 'bright', labelKey: 'algo.volumetricCloud.bright', type: 'range', min: 0, max: 2, step: 0.01, defaultValue: 0.95 },
    { key: 'ambient', labelKey: 'algo.volumetricCloud.ambient', type: 'range', min: 0, max: 1, step: 0.01, defaultValue: 0.22 },
    { key: 'shade', labelKey: 'algo.volumetricCloud.shade', type: 'range', min: 0, max: 1, step: 0.01, defaultValue: 0.6 },
    { key: 'colorLit', labelKey: 'algo.volumetricCloud.colorLit', type: 'color', defaultValue: '#fff3e2' },
    { key: 'colorDark', labelKey: 'algo.volumetricCloud.colorDark', type: 'color', defaultValue: '#59657a' },

    /* ---- 质量 ---- */
    {
      key: 'steps',
      labelKey: 'algo.volumetricCloud.steps',
      type: 'range',
      min: 16,
      max: CLOUD_MAX_STEPS,
      step: 4,
      defaultValue: 48,
    },

    bgModeParam(),
    {
      key: 'bg',
      labelKey: 'algo.volumetricCloud.bg',
      type: 'color',
      defaultValue: '#4f7fb8',
      visibleWhen: bgColorVisible,
    },
    /* 3D 的缺省内部尺寸是 auto（与 `sdfParams()` 同一条理由：光线步进的钱
       全花在像素上），只覆盖缺省值、不动共用的选项表。 */
    { ...intResParam(), defaultValue: 'auto' },
  ],
  setUniforms: (gl, l, v, ctx) => {
    /* `Number(undefined)` 是 NaN，而 `uniform1f(NaN)` 会把整幅画变成 NaN 而不是报错 ——
       手改过的工程文件少一个键就会走到这条路，所以统一收口到默认值。 */
    const num = (k: string, d: number): number => {
      const x = Number(v[k]);
      return Number.isFinite(x) ? x : d;
    };
    const angle = (k: string, deg: number): number => (num(k, deg) * Math.PI) / 180;
    const u1 = (name: string, x: number): void => {
      const p = l[name];
      if (p) gl.uniform1f(p, x);
    };
    const i1 = (name: string, x: number): void => {
      const p = l[name];
      if (p) gl.uniform1i(p, Math.round(x));
    };
    const u3 = (name: string, hex: string): void => {
      const p = l[name];
      if (!p) return;
      const [r, g, b] = colorVec3(hex);
      gl.uniform3f(p, r, g, b);
    };

    /* `u_bgMode` 由 AlgoRuntime 统一派发（全家族一套口径），这里不重复写。 */
    selectInt<AlgoUniformCtx>('octaves', CLOUD_OCTAVES)(gl, l, v, ctx);

    u1('u_altitude', num('altitude', -2.2));
    /* 厚度 / 尺度 / 视距是除数与循环边界，手改过的文件给 0 会得到 NaN 或空画面。 */
    u1('u_thick', Math.max(0.02, num('thick', 1.5)));
    u1('u_cover', num('cover', 0.55));
    u1('u_density', num('density', 1.6));
    u1('u_scale', Math.max(0.05, num('scale', 1.6)));
    u1('u_soft', num('soft', 0.6));
    u1('u_viewDist', Math.max(1, num('viewDist', 16)));

    u1('u_speed', num('speed', 0.3));
    u1('u_flowDir', angle('flowDir', 35));
    u1('u_patternSeed', num('patternSeed', 0.25));

    u1('u_yaw', angle('yaw', 20));
    u1('u_pitch', angle('pitch', -12));
    u1('u_roll', angle('roll', 0));
    u1('u_fov', num('fov', 1));
    u1('u_orbit', num('orbit', 0));
    const shift = l['u_shift'];
    if (shift) gl.uniform2f(shift, num('shiftX', 0), num('shiftY', 0));

    u1('u_sunAz', angle('sunAz', -40));
    u1('u_sunEl', angle('sunEl', 12));
    u1('u_bright', num('bright', 0.95));
    u1('u_ambient', num('ambient', 0.22));
    u1('u_shade', num('shade', 0.6));
    u3('u_colorLit', String(v.colorLit ?? '#fff3e2'));
    u3('u_colorDark', String(v.colorDark ?? '#59657a'));

    i1('u_steps', Math.min(CLOUD_MAX_STEPS, Math.max(1, num('steps', 48))));
    u3('u_bg', String(v.bg ?? '#4f7fb8'));
  },
};
