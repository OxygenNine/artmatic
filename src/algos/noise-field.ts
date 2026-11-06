/**
 * noise-field.ts — 噪声场，`realtime` 型。
 *
 * 三族（value / gradient / voronoi）× 两个维数（2D / 3D）+ fbm + 域扭曲，
 * 输出**灰度**：它同时是「底纹」和「现成的蒙版源」—— 蒙版引用取 luma 通道，
 * 所以这张图不需要任何额外处置就能当遮罩用。
 *
 * ## 两种模式都在三维里采样，演化靠深度
 *
 * 2D / 3D 的差别**只在流速怎么用**：二维是流速在平面上吹（深度冻结在
 * `u_evolve`），三维是流速往深度里穿（平面静止）。不做等轴测 / 三平面投影：
 * 那种做法会把地形感混进来，而这条生成器的身份是**场本身**（能当蒙版）。
 *
 * 「演化」(`u_evolve`) 是**进度**而不是速度，单位是格：把采样点推进到场里更深的
 * z，图案原地平滑换形。它必须升维 —— 二维噪声在同一个点上没有自由度，任何
 * 「进度」都只能表现成平移，那样它就只是第二个流速。
 *
 * 代价是二维模式也付三维采样的钱（value 4→8 次 hash/格，voronoi 9→27 格）。
 * 这是刻意的：`u_evolve == 0` 时退回二维采样能省 30%，但一打关键帧整幅画面
 * 会**换一套噪点**（同样的参数突然不是同一张图），那种跳变比省下的毫秒贵。
 *
 * ## 与内部分辨率解耦
 *
 * 频率一律走 `u_scale`（「画面高 = scale 个噪声格」），绝不按设备像素算 ——
 * 否则调 `intRes`（纯性能档位）会改变图案，缩略图与导出也就对不上。
 *
 * ## 成本（实测，480p、默认参数、10 帧取 5 轮最小值、含一次读回摊薄）
 *
 * value ≈1.2 · gradient ≈1.3 · voronoi ≈1.8 ms。**二维与三维同价** —— 两者只差
 * 「流速加到哪个坐标上」，采样路径是同一条。单次读数会抖 ±0.4 ms。
 * 要盯的是**族与阶数**（voronoi 三维是 27 格 × 3 hash/阶），不是像素数 ——
 * `intRes` 是最后一张牌，先动 `octaves`。
 *
 * ## 参数纪律
 *
 * 三个 `select` 都走 `selectInt` 的显式映射（`NOISE_FAMILIES` / `NOISE_SPACES` /
 * `NOISE_VORONOI`）：`floats()` 的 `Number(v[key]) || 0` 会把字符串派发成 0，
 * 也就是「拖了形态没反应」且不报错。`octaves` / `invert` 是整数，走 `ints()`；
 * 写成 `floats()` 对 `uniform int` 是 INVALID_OPERATION + 静默不写。
 *
 * fragment **不含头**（`ALGO_HEAD` 由运行时拼），并且自带整套噪声库
 * （`NOISE_GLSL`，见那个文件头的命名与 hash 约定）。
 */

import { floats, ints, selectInt } from '../effects/shader-def';
import { intResParam, type AlgoUniformCtx } from './shader-lib';
import { NOISE_FAMILIES, NOISE_GLSL, NOISE_SPACES, NOISE_VORONOI } from './noise-lib';
import type { GeneratorDef } from './types';

const FRAG = `
uniform int   u_family;     // 0 value · 1 gradient · 2 voronoi
uniform int   u_space;      // 0 = 2D · 1 = 3D
uniform int   u_voronoi;    // 0 细胞 · 1 边界（只对 voronoi 族有效）
uniform int   u_octaves;    // fbm 阶数
uniform int   u_invert;
uniform float u_scale;      // 画面高 = scale 个噪声格
uniform float u_gain;       // 每阶的幅度衰减
uniform float u_lacunarity; // 每阶的频率倍数
uniform float u_warp;       // 域扭曲幅度（格）
uniform float u_warpScale;  // 扭曲场的频率
uniform float u_evolve;     // 演化进度（格）：推进采样深度，噪声原地换形
uniform float u_speed;      // 流速（格/秒）：平面平移或纵深穿行
uniform float u_contrast;
uniform float u_levels;     // 量化级数（0/1 = 连续）

void main() {
  // 与分辨率无关的坐标系：纵向 0..u_scale 个格，横向按宽高比展开
  vec2 plane = (vUv - 0.5) * vec2(u_aspect, 1.0) * u_scale;

  /* 种子只做平移，不旋转、不掺进 hash —— 于是同一工程里两条噪声轨道图案不同，
     同一条轨道在任何机器上都逐像素相同（硬约束 1.2 / 1.3）。 */
  plane += vec2(u_seed * 53.0, u_seed * 91.0);

  /* 漂移量在**格**的单位里算：speed 指「每秒穿过几个噪声格」，
     所以放大 scale 会同时放大流动速度 —— 与「凑近看一个场」的直觉一致。 */
  float travel = u_time * u_speed * u_scale;

  /* 两种模式**都在三维里采样**，区别只在流速怎么用：
       二维 —— 流速在平面上吹，深度冻结在 u_evolve；
       三维 —— 流速往深度里穿，平面静止。
     演化必须升维：二维噪声在同一个点上没有自由度，「进度」只可能表现为平移，
     那样它就成了第二个流速。 */
  float depth = u_evolve + u_seed * 37.0;
  if (u_space == 1) depth += travel;
  else plane += vec2(travel * 0.8, travel * 0.6);

  vec3 q = vec3(plane, depth);
  int oct = clamp(u_octaves, 1, NZ_MAX_OCTAVES);

  if (u_warp > 0.001) {
    /* 扭曲场**两种模式都走二维**（只挪平面坐标），两个理由：
       一是成本 —— 三维扭曲要采样三次而不是两次，而它本来只是「把空间揉一下」；
       二是模型 —— 这样 t=0、流速为 0 时二维与三维给出**同一张图**，
       两者就只差「流速往哪儿走」，不是两套不同的场。
       阶数另取小值：扭曲只需要低频大团块，跟着主噪声的阶数走会把成本乘上去。 */
    int wOct = min(oct, 3);
    vec2 w = nzWarp2(q.xy, u_warpScale, u_family, u_voronoi, wOct, u_gain, u_lacunarity);
    q.xy += w * (u_warp * 1.2);
  }

  // 主噪声永远走三维采样（二维模式只是 depth 冻结）—— 见上面那段注释。
  float n = nzFbm3(q, u_family, u_voronoi, oct, u_gain, u_lacunarity);

  /* 对比：绕 0.5 缩放。归一化 fbm 的分布挤在中灰附近，没有这一项
     「对比」和「色阶」都看不出差别（实测：不缩放时整幅只有 0.35..0.65）。 */
  n = clamp((n - 0.5) * (1.0 + u_contrast * 5.0) + 0.5, 0.0, 1.0);

  // 色阶：0/1 视为连续。至少两级才有「阶」的意义（同 gradient.ts 的口径）。
  float lv = floor(u_levels + 0.5);
  if (lv >= 2.0) n = clamp(floor(n * lv + 0.5) / lv, 0.0, 1.0);

  if (u_invert == 1) n = 1.0 - n;

  outColor = vec4(vec3(n), 1.0);
}`;

/**
 * voronoi 的「形态」参数只在 voronoi 族下可见。
 *
 * 判据是 `v.family`：`algo-params.test.ts` 从函数源码里抠 `v.xxx` 去比对参数表，
 * 拼错会直接变红。
 */
const isVoronoi = (v: Record<string, number | string>): boolean => v.family === 'voronoi';

export const noiseFieldDef: GeneratorDef = {
  id: 'noise-field',
  nameKey: 'algo.noiseField',
  kind: 'realtime',
  fragment: NOISE_GLSL + FRAG,
  params: [
    {
      key: 'family',
      labelKey: 'algo.noiseField.family',
      type: 'select',
      defaultValue: 'value',
      options: [
        { labelKey: 'algo.noiseField.familyValue', value: 'value' },
        { labelKey: 'algo.noiseField.familyGradient', value: 'gradient' },
        { labelKey: 'algo.noiseField.familyVoronoi', value: 'voronoi' },
      ],
    },
    {
      key: 'space',
      labelKey: 'algo.noiseField.space',
      type: 'select',
      defaultValue: '2d',
      options: [
        { labelKey: 'algo.noiseField.space2d', value: '2d' },
        { labelKey: 'algo.noiseField.space3d', value: '3d' },
      ],
    },
    {
      key: 'voronoi',
      labelKey: 'algo.noiseField.voronoi',
      type: 'select',
      defaultValue: 'cells',
      visibleWhen: isVoronoi,
      options: [
        { labelKey: 'algo.noiseField.voronoiCells', value: 'cells' },
        { labelKey: 'algo.noiseField.voronoiEdges', value: 'edges' },
      ],
    },
    { key: 'scale', labelKey: 'algo.noiseField.scale', type: 'range', min: 0.5, max: 24, step: 0.1, defaultValue: 4 },
    { key: 'octaves', labelKey: 'algo.noiseField.octaves', type: 'range', min: 1, max: 6, step: 1, defaultValue: 4 },
    { key: 'gain', labelKey: 'algo.noiseField.gain', type: 'range', min: 0.2, max: 0.85, step: 0.01, defaultValue: 0.5 },
    {
      key: 'lacunarity',
      labelKey: 'algo.noiseField.lacunarity',
      type: 'range',
      min: 1.4,
      max: 3.2,
      step: 0.01,
      defaultValue: 2,
    },
    { key: 'warp', labelKey: 'algo.noiseField.warp', type: 'range', min: 0, max: 1, step: 0.01, defaultValue: 0.25 },
    {
      key: 'warpScale',
      labelKey: 'algo.noiseField.warpScale',
      type: 'range',
      min: 0.5,
      max: 8,
      step: 0.1,
      defaultValue: 1.5,
    },
    /*
     * 演化 = **进度**而不是速度：单位是格（0 → 1 走过一整个噪声 cell，
     * 图案明显换形但仍是同一种场）。做成进度是为了能打关键帧 / 挂调制器 ——
     * 想让噪声跟着节拍换形就这么用；速度只表达「恒速」一种语义。
     * 缺省 0 = 冻结在初始深度（要动画请动这个参数，或改用流速）。
     */
    { key: 'evolve', labelKey: 'algo.noiseField.evolve', type: 'range', min: 0, max: 8, step: 0.01, defaultValue: 0 },
    { key: 'speed', labelKey: 'algo.noiseField.speed', type: 'range', min: -1, max: 1, step: 0.01, defaultValue: 0.15 },
    {
      key: 'contrast',
      labelKey: 'algo.noiseField.contrast',
      type: 'range',
      min: 0,
      max: 1,
      step: 0.01,
      /*
       * 缺省 0.15（= ×1.75）。
       *
       * 这个值是**实测挑出来的**：归一化 fbm 的分布已经很宽，×2.5（0.3）时
       * value 与 gradient 都出现大片纯白（gradient 尤其严重，接近二值图），
       * 当蒙版用时等于丢掉中间调；×1.75 才在铺满动态范围的同时保住层次。
       * 想更硬就往上推——但先看一眼 voronoi 的边界，那个最先被截平。
       */
      defaultValue: 0.15,
    },
    { key: 'levels', labelKey: 'algo.noiseField.levels', type: 'range', min: 0, max: 16, step: 1, defaultValue: 0 },
    { key: 'invert', labelKey: 'algo.noiseField.invert', type: 'checkbox', defaultValue: 0 },
    intResParam(),
  ],
  setUniforms: (gl, l, v, ctx) => {
    // 三个 select 都是字符串取值，必须走显式映射（见文件头）
    selectInt<AlgoUniformCtx>('family', NOISE_FAMILIES)(gl, l, v, ctx);
    selectInt<AlgoUniformCtx>('space', NOISE_SPACES)(gl, l, v, ctx);
    selectInt<AlgoUniformCtx>('voronoi', NOISE_VORONOI)(gl, l, v, ctx);
    ints<AlgoUniformCtx>('octaves', 'invert')(gl, l, v, ctx);
    floats<AlgoUniformCtx>(
      'scale',
      'gain',
      'lacunarity',
      'warp',
      'warpScale',
      'evolve',
      'speed',
      'contrast',
      'levels',
    )(gl, l, v, ctx);
  },
};
