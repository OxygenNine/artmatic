/**
 * noise-lib.ts — 生成器侧共用的 2D / 3D 噪声库（value / gradient / voronoi 三族）。
 *
 * 在此之前 3D 噪声只有 `smoke.ts` 里私有的 `vnoise3` / `fbmS` / `fbmC` 一份，
 * 而 `black-hole.ts` 又抄了一份带 `bh` 前缀的（它只要 2 阶，另起一份是有理由的，
 * 见那边的文件头）。这个文件是**新代码的唯一入口**：以后再要 3D 噪声就 import 它，
 * 不要再往生成器里贴一份。
 *
 * ## 三族 × 两个维度，形状全部一致
 *
 * | 族 | 2D | 3D | 值域 |
 * |---|---|---|---|
 * | value（值噪声） | `nzValue2` | `nzValue3` | 0..1 |
 * | gradient（梯度噪声） | `nzGrad2` | `nzGrad3` | 0..1（已居中缩放） |
 * | voronoi（沃罗诺伊） | `nzVoronoi2` | `nzVoronoi3` | `vec2(F1, F2−F1)`，单位是格 |
 *
 * 三族的输出**统一成 0..1**（voronoi 由调用方决定 Cells / Edges 怎么读，见
 * `nzSample2/3`）—— 不统一的话 fbm 会把某几族平均成一条平带，而画面看起来
 * 只是「这个族不好看」，查起来毫无线索。
 *
 * ## 要「原地演化」就得升维
 *
 * 二维基元在同一个点上没有自由度：任何一个「演化进度」到了二维噪声上都只能
 * 表现成**平移**，也就是第二个流速。所以想让噪声原地平滑换形，就把 z（或 w）
 * 当时间轴用 —— `nzFbm3` 的 z 一推进，图案就换形而不漂走。`noise-field.ts`
 * 的二维模式就是这么做的（深度冻结在 `u_evolve`）。
 *
 * ## 为什么带 `nz` 前缀
 *
 * `vnoise2` / `fbm6` 已经在 `effects/shader-def.ts` 的 `FBM6_GLSL` 里，
 * `vnoise3` 是 smoke 的旧名。同一个 fragment 里两个库同时出现时，
 * **同名函数是 redefinition 直接编译失败**；前缀让两个库可以并存。
 *
 * ## hash：只用无 sin 族
 *
 * 全部建在 `HASH_FAST_GLSL`（Dave Hoskins）上。`fract(sin(x) * 43758.5453)`
 * 那一族在自变量上百之后低位不稳 —— 而这里的采样坐标乘上 `scale` 之后很容易
 * 上百，表现是**帧间闪烁**（根 AGENTS 硬约束 1.3 记过这条）。
 *
 * ⚠️ **`NOISE_GLSL` 自带 `HASH_FAST_GLSL`**，所以同一份 fragment 里
 * **不要再拼 `FBM6_GLSL` / `HASH_FAST_GLSL`** —— 重复定义同样编译失败。
 * 已经拼了那两个常量的 fragment 用 `NOISE_BODY_GLSL`（只有函数体、不含 hash）。
 *
 * ## fbm 的两条口径
 *
 * 1. **归一化**（`sum / norm`）：阶数一变整体亮度不变。不归一的话「细节层次」
 *    会顺手改掉亮暗，是最难查的参数串扰。
 * 2. **`nzCentered` 只给「当位移用」的地方**：归一化 fbm 的标准差只有 0.1 左右，
 *    直接拿它当扰动幅度等于没有扰动（而且不报错、看着像参数失灵）。
 *    当密度/阈值切的地方直接用 fbm 原值。
 */

import { HASH_FAST_GLSL } from '../effects/shader-def';

/**
 * 噪声族的编号。**唯一定义** —— 生成器的 `select` 选项、`selectInt` 映射与
 * shader 里的 `family == 2` 都对着这张表读。拼一个不存在的名字会静默落回 0
 * （= value），画面「看起来正常」只是换了族。
 */
export const NOISE_FAMILIES: Record<string, number> = { value: 0, gradient: 1, voronoi: 2 };

/** 维数编号。3D = 流速沿 z 穿行；2D = 深度冻结（要换形就动演化进度）。 */
export const NOISE_SPACES: Record<string, number> = { '2d': 0, '3d': 1 };

/** voronoi 的两种读法：细胞本身 / 细胞边界。只对 `voronoi` 族有效。 */
export const NOISE_VORONOI: Record<string, number> = { cells: 0, edges: 1 };

/** 阶数的编译期上界。GLSL 的循环用常量界 + `break`，与动态界等价且更稳。 */
export const NZ_MAX_OCTAVES = 6;

/**
 * 不含 hash 的函数体。`NOISE_GLSL` = `HASH_FAST_GLSL` + 本常量。
 *
 * 单独导出是为了「已经拼了别的 hash 库」的 fragment —— 见文件头那条警告。
 */
export const NOISE_BODY_GLSL = `
const int NZ_MAX_OCTAVES = ${NZ_MAX_OCTAVES};

float nzValue2(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash21(i), hash21(i + vec2(1.0, 0.0)), u.x),
             mix(hash21(i + vec2(0.0, 1.0)), hash21(i + vec2(1.0, 1.0)), u.x), u.y);
}

float nzValue3(vec3 p) {
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
  return mix(mix(mix(n000, n100, u.x), mix(n010, n110, u.x), u.y),
             mix(mix(n001, n101, u.x), mix(n011, n111, u.x), u.y), u.z);
}

/* 梯度方向由 hash 取一个角度再取 cos/sin。**这里的 sin 不是 hash**：
   角度只在 0..2π 内，不存在「大参数低位不稳」那件事。 */
vec2 nzGradDir2(vec2 i) {
  float a = hash21(i + vec2(31.7, 11.3)) * 6.28318530718;
  return vec2(cos(a), sin(a));
}

float nzGrad2(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  float d00 = dot(nzGradDir2(i), f);
  float d10 = dot(nzGradDir2(i + vec2(1.0, 0.0)), f - vec2(1.0, 0.0));
  float d01 = dot(nzGradDir2(i + vec2(0.0, 1.0)), f - vec2(0.0, 1.0));
  float d11 = dot(nzGradDir2(i + vec2(1.0, 1.0)), f - vec2(1.0, 1.0));
  float n = mix(mix(d00, d10, u.x), mix(d01, d11, u.x), u.y);
  /* 单位梯度下坐标噪声的幅度约 ±0.5。
   *
   * 缩放取 0.9 而不是 1.5：这里**刻意不做拉伸**。每阶都往两端夹一次，fbm
   * 平均出来的是一块块**平台**——实测 ×1.5（= ±0.75）时 gradient 的画面
   * 接近二值图，白区里连细节都没有，而且加大「细节层次」也救不回来
   * （平台是逐阶产生的，不是最后那一刀造成的）。要硬要软交给生成器的
   * contrast 一处去截，噪声基元本身保持连续。 */
  return clamp(n * 0.9 + 0.5, 0.0, 1.0);
}

/* 3D 梯度：三条 hash 组成一个向量再归一化。
   退化（长度恰好 0）时给一个固定方向 —— 不这么写的话 normalize(0) 是 NaN，
   而 NaN 会在整个步进/累积里扩散成一块黑。 */
vec3 nzGradDir3(vec3 i) {
  vec3 g = vec3(hash31(i + vec3(17.3, 5.1, 11.7)),
                hash31(i + vec3(41.9, 23.3, 7.7)),
                hash31(i + vec3(73.1, 31.7, 59.3))) * 2.0 - 1.0;
  float l = length(g);
  return l > 1e-4 ? g / l : vec3(0.0, 0.0, 1.0);
}

float nzGrad3(vec3 p) {
  vec3 i = floor(p);
  vec3 f = fract(p);
  vec3 u = f * f * (3.0 - 2.0 * f);
  float d000 = dot(nzGradDir3(i), f);
  float d100 = dot(nzGradDir3(i + vec3(1.0, 0.0, 0.0)), f - vec3(1.0, 0.0, 0.0));
  float d010 = dot(nzGradDir3(i + vec3(0.0, 1.0, 0.0)), f - vec3(0.0, 1.0, 0.0));
  float d110 = dot(nzGradDir3(i + vec3(1.0, 1.0, 0.0)), f - vec3(1.0, 1.0, 0.0));
  float d001 = dot(nzGradDir3(i + vec3(0.0, 0.0, 1.0)), f - vec3(0.0, 0.0, 1.0));
  float d101 = dot(nzGradDir3(i + vec3(1.0, 0.0, 1.0)), f - vec3(1.0, 0.0, 1.0));
  float d011 = dot(nzGradDir3(i + vec3(0.0, 1.0, 1.0)), f - vec3(0.0, 1.0, 1.0));
  float d111 = dot(nzGradDir3(i + vec3(1.0, 1.0, 1.0)), f - vec3(1.0, 1.0, 1.0));
  float n = mix(mix(mix(d000, d100, u.x), mix(d010, d110, u.x), u.y),
                mix(mix(d001, d101, u.x), mix(d011, d111, u.x), u.y), u.z);
  // 缩放口径与 nzGrad2 同一条（0.9）：逐阶夹出平台比「不够硬」贵得多。
  return clamp(n * 0.9 + 0.5, 0.0, 1.0);
}

/* 沃罗诺伊：3x3（3D 是 3x3x3）邻域内的最近两个特征点。
   返回 (F1, F2 − F1)：F1 是「到最近特征点的距离」，差值在细胞边界上趋近 0
   —— 后者就是「边界」那种读法的来源，不必再算一遍。

   距离的单位是**格**（不是像素），所以它随 scale 缩放，与分辨率无关。 */
vec2 nzVoronoi2(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  float f1 = 4.0;
  float f2 = 4.0;
  for (int y = -1; y <= 1; y++) {
    for (int x = -1; x <= 1; x++) {
      vec2 o = vec2(float(x), float(y));
      vec2 c = vec2(hash21(i + o + vec2(0.13, 0.71)),
                    hash21(i + o + vec2(19.7, 7.3)));
      float d = length(o + c - f);
      if (d < f1) {
        f2 = f1;
        f1 = d;
      } else if (d < f2) {
        f2 = d;
      }
    }
  }
  return vec2(f1, f2 - f1);
}

vec2 nzVoronoi3(vec3 p) {
  vec3 i = floor(p);
  vec3 f = fract(p);
  float f1 = 6.0;
  float f2 = 6.0;
  for (int z = -1; z <= 1; z++) {
    for (int y = -1; y <= 1; y++) {
      for (int x = -1; x <= 1; x++) {
        vec3 o = vec3(float(x), float(y), float(z));
        vec3 c = vec3(hash31(i + o + vec3(0.13, 0.71, 0.37)),
                      hash31(i + o + vec3(19.7, 7.3, 3.1)),
                      hash31(i + o + vec3(41.3, 29.1, 13.7)));
        float d = length(o + c - f);
        if (d < f1) {
          f2 = f1;
          f1 = d;
        } else if (d < f2) {
          f2 = d;
        }
      }
    }
  }
  return vec2(f1, f2 - f1);
}

/* 三族 → 0..1。variant 只服务 voronoi（0 = 细胞 · 1 = 边界），
   另外两族忽略它 —— 于是调用方不必为了「某个族没有 variant」写分支。 */
float nzSample2(vec2 p, int family, int variant) {
  if (family == 2) {
    vec2 v = nzVoronoi2(p);
    return variant == 1 ? 1.0 - clamp(v.y * 2.5, 0.0, 1.0) : 1.0 - clamp(v.x, 0.0, 1.0);
  }
  return family == 1 ? nzGrad2(p) : nzValue2(p);
}

float nzSample3(vec3 p, int family, int variant) {
  if (family == 2) {
    vec2 v = nzVoronoi3(p);
    return variant == 1 ? 1.0 - clamp(v.y * 2.5, 0.0, 1.0) : 1.0 - clamp(v.x, 0.0, 1.0);
  }
  return family == 1 ? nzGrad3(p) : nzValue3(p);
}

/* 归一化 fbm。octaves 逐次加频（lacunarity）并逐次减幅（gain），
   最后除以幅度和 —— 于是「阶数」只改细节，不改整体亮度。 */
float nzFbm2(vec2 p, int family, int variant, int octaves, float gain, float lacunarity) {
  float sum = 0.0;
  float amp = 1.0;
  float norm = 0.0;
  for (int i = 0; i < NZ_MAX_OCTAVES; i++) {
    if (i >= octaves) break;
    sum += amp * nzSample2(p, family, variant);
    norm += amp;
    p = p * lacunarity + vec2(11.3, 7.7);
    amp *= gain;
  }
  return norm > 0.0 ? sum / norm : 0.5;
}

float nzFbm3(vec3 p, int family, int variant, int octaves, float gain, float lacunarity) {
  float sum = 0.0;
  float amp = 1.0;
  float norm = 0.0;
  for (int i = 0; i < NZ_MAX_OCTAVES; i++) {
    if (i >= octaves) break;
    sum += amp * nzSample3(p, family, variant);
    norm += amp;
    p = p * lacunarity + vec3(11.3, 7.7, 5.1);
    amp *= gain;
  }
  return norm > 0.0 ? sum / norm : 0.5;
}

/* 0..1 → ±1 并把标准差拉到可用量级。**只给「当位移 / 权重」用**，
   当密度阈值切的地方直接用 fbm 原值（见文件头）。 */
float nzCentered(float v) {
  return clamp((v - 0.5) * 3.2, -1.0, 1.0);
}

/* 域扭曲：两路低频 fbm 各给一个方向，返回 ±1 的偏移（**不含幅度** ——
   幅度由调用方乘，因为「多少个格」是调用方的坐标系说了算）。 */
vec2 nzWarp2(vec2 p, float freq, int family, int variant, int octaves, float gain, float lacunarity) {
  vec2 q = p * freq;
  return vec2(
    nzCentered(nzFbm2(q + vec2(17.3, 9.1), family, variant, octaves, gain, lacunarity)),
    nzCentered(nzFbm2(q + vec2(-11.7, 23.9), family, variant, octaves, gain, lacunarity)));
}

vec3 nzWarp3(vec3 p, float freq, int family, int variant, int octaves, float gain, float lacunarity) {
  vec3 q = p * freq;
  return vec3(
    nzCentered(nzFbm3(q + vec3(17.3, 9.1, 4.7), family, variant, octaves, gain, lacunarity)),
    nzCentered(nzFbm3(q + vec3(-11.7, 23.9, 8.1), family, variant, octaves, gain, lacunarity)),
    nzCentered(nzFbm3(q + vec3(5.3, -7.9, 13.1), family, variant, octaves, gain, lacunarity)));
}
`;

/**
 * 自包含的噪声库：hash + 函数体。**同一份 fragment 里不要再拼别的 hash 库**
 * （见文件头的警告）。
 */
export const NOISE_GLSL = HASH_FAST_GLSL + NOISE_BODY_GLSL;
