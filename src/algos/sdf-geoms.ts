/**
 * sdf-geoms.ts — 三个可复用的 SDF 几何体（`SdfGeom`）。
 *
 * 这里是**几何的唯一真源**：`menger.ts` / `mandelbulb.ts` / `apollonian.ts`
 * 把它们拼上运镜与着色当成普通生成器，`scene3d.ts` 把它们拼进多物体场景。
 * 几何写两份的失效形态是「单独看正常、进场景变形」—— 因为它会立刻长出两个
 * 版本，而只有一个会被继续维护。
 *
 * 每个 `src` 只做三件事：声明自己的 uniform、辅助函数、`float sdX(vec3 p)`。
 * **不含相机、不含着色、不含 `main`**（见 `sdf-lib.ts` 的 `SdfGeom`）。
 */

import { set1i, type SdfGeom } from './sdf-lib';

/* ------------------------------------------------------------------ Menger */

/**
 * Menger 海绵 / 地毯。
 *
 * - 递归深度是**渲染档位**，不是着色参数：3 层是「一个带洞的方块」，4 层自
 *   相似才开始读得出来，5 层在 640 像素宽下是白费功夫。
 * - ⚠️ 扭转**写在 SDF 内部**，不是包在调用点上：内核里的步进 / 法线 / 遮蔽会
 *   调它 5 次以上，包在调用点就得改 5 处，而漏掉的表现是「滑杆能动画面不动」。
 * - ⚠️ 无限延伸下**不做扭转**：折叠把坐标压回一个 cell，扭转随高度转，相邻
 *   cell 的扭角差整整一档 ⇒ 距离场在 cell 边界上断裂（表面撕开一道缝）。
 * - ⚠️ 无限模式**必须去掉外框约束**：`max(|p|) - 1` 在折叠坐标里恒 ≤ 0，看着
 *   无害，但它在 `|p| = 1` 那一圈恰好是 0 ⇒ 整张 cell 边界都满足 `d < eps` ⇒
 *   步进在任意位置立刻判成命中（画面变纯色）；镜头正落在边界上时命中距离为 0。
 */
export const MENGER_GEOM: SdfGeom = {
  name: 'sdMenger',
  keys: ['variant', 'depth', 'twist'],
  foldable: true,
  src: `
uniform int   u_depth;    // 递归深度 2..5
uniform float u_twist;    // 沿 y 轴每单位高度的扭转角（弧度）
uniform int   u_variant;  // 0 = 海绵（三维挖）· 1 = 地毯（只挖 xz 平面后挤出）
uniform int   u_extent;   // 0 = 单体 · 1 = 无限延伸（只在海绵下成立）

/** 绕 y 轴按高度扭转 —— 让方块从「古典几何体」变成「藤蔓」。 */
vec3 twistY(vec3 p, float k) {
  float a = k * p.y;
  float c = cos(a), s = sin(a);
  return vec3(c * p.x - s * p.z, p.y, s * p.x + c * p.z);
}

float sdMenger(vec3 p) {
  bool inf = u_extent == 1 && u_variant == 0;
  if (inf) {
    /*
     * 折叠到 [-1,1]³：海绵的八度图案本来就以 2 为周期（每个八度的孔洞由
     * mod(p * 3^i, 2) 挖出来），所以把这个 cell 复制出去就是同一套生成逻辑
     * —— 不是另一种几何，是同一个海绵铺满整个空间。
     *
     * 折叠的代价：cell 边界附近的距离是**低估**（最近的构件可能在隔壁 cell），
     * 步进因此偏保守、多走几步。安全方向，不会穿面。
     */
    p = mod(p + 1.0, 2.0) - 1.0;
  } else {
    p = twistY(p, u_twist);
  }
  float d = -1.0e6;
  if (!inf) {
    d = u_variant == 1
      ? max(abs(p.x), abs(p.z)) - 1.0
      : max(abs(p.x), max(abs(p.y), abs(p.z))) - 1.0;
  }
  float s = 1.0;
  for (int m = 0; m < 5; m++) {
    if (m >= u_depth) break;
    vec3 a = mod(p * s, 2.0) - 1.0;
    s *= 3.0;
    vec3 r = abs(1.0 - 3.0 * abs(a));
    float c = u_variant == 1
      ? (max(r.x, r.z) - 1.0) / s
      : (min(max(r.x, r.y), min(max(r.y, r.z), max(r.z, r.x))) - 1.0) / s;
    d = max(d, c);
  }
  return d;
}
`,
  set: (gl, l, v, _ctx, opt) => {
    const twist = l['u_twist'];
    if (twist) gl.uniform1f(twist, Number(v.twist ?? 0));
    set1i(gl, l, 'u_depth', Number(v.depth ?? 4));
    set1i(gl, l, 'u_variant', v.variant === 'carpet' ? 1 : 0);
    set1i(gl, l, 'u_extent', opt.infinite ? 1 : 0);
  },
};

/* -------------------------------------------------------------- Mandelbulb */

/**
 * White & Nylander 2009 那套：把复平面的 `z ← z^p + c` 用**球坐标**推广到
 * 三维（`(r, θ, φ) → (r^p, p·θ, p·φ)`）。`p = 8` 是论文里那个最出名的形状。
 *
 * 距离估计器用标准的导数形式（每次迭代同时更新 `dr`）：
 *
 *     dr ← p · r^(p−1) · dr + 1        DE = ½ · log(r) · r / dr
 *
 * | 参数 | 作用 |
 * |---|---|
 * | `power` | 2 是「球面上的凸起」，8 是经典的那个多刺球，>8 越来越像海胆 |
 * | `iter`  | 迭代次数上限。**它决定细节层级**，7 与 10 是两个不同的物体 |
 * | `bail`  | 逃逸半径。取 2 是惯例；调大只是把远处那些小凸起算得更准，更贵 |
 */
export const MANDELBULB_GEOM: SdfGeom = {
  name: 'sdMandelbulb',
  keys: ['power', 'iter', 'bail'],
  src: `
uniform float u_power;   // z 的幂次（8 = 经典）
uniform int   u_iter;    // 迭代次数上限
uniform float u_bail;    // 逃逸半径

float sdMandelbulb(vec3 p) {
  vec3 z = p;
  float dr = 1.0;
  float r = 0.0;
  for (int i = 0; i < 16; i++) {
    if (i >= u_iter) break;
    r = length(z);
    if (r > u_bail) break;
    // 球坐标幂：θ 是极角、φ 是方位角，两者都乘幂次
    float theta = acos(clamp(z.z / r, -1.0, 1.0)) * u_power;
    float phi = atan(z.y, z.x) * u_power;
    float zr = pow(r, u_power);
    // 导数：链式法则的一项，配合下面的 DE 用
    dr = pow(r, u_power - 1.0) * u_power * dr + 1.0;
    float st = sin(theta);
    z = zr * vec3(st * cos(phi), st * sin(phi), cos(theta)) + p;
  }
  // 逃逸越晚（r 越小）越靠近集合边界 → DE 越小
  return 0.5 * log(max(r, 1e-9)) * r / dr;
}
`,
  set: (gl, l, v) => {
    const set1f = (name: string, value: number): void => {
      const loc = l[name];
      if (loc) gl.uniform1f(loc, value);
    };
    set1f('u_power', Number(v.power ?? 8));
    set1f('u_bail', Number(v.bail ?? 2));
    set1i(gl, l, 'u_iter', Number(v.iter ?? 8));
  },
};

/* ------------------------------------------------------------- Apollonian */

/**
 * 阿波罗尼奥斯球堆叠（球反演 IFS）：**折叠 + 反演**迭代十几次，极限集就是那个
 * 所有球两两相切的球堆。
 *
 *     p ← fold(p)                // 折回 [-1,1]³
 *     k ← scale₀ / |p|²           // 反演倍率
 *     p ← p · k,  s ← s · k       // s 累积雅可比
 *     DE = ¼ · |p.y| / s
 *
 * ⚠️ DE 出自 Íñigo Quílez 的 Apollonian 光线步进（ShaderToy `4ds3zn`），本项目
 * 照同一份数学重写（见 CREDITS.md）。**`k` 的分子是固定参数，不是累积量** ——
 * 写成「累积的 s 除以 r²」会让 DE 一路趋零、整片空间判定为命中（画面外围出现
 * 一块平坦的灰「墙」）。所以 `scale` 现在是个参数，扫它就能看出 DE 是否健康。
 *
 * 整个距离场以 2 为周期（`fract` 折叠），所以穿梭镜头是免费的：只需要移动镜头。
 */
export const APOLLONIAN_GEOM: SdfGeom = {
  name: 'sdApollonian',
  keys: ['iter', 'scale'],
  foldable: true,
  src: `
uniform int   u_iter;    // 折叠-反演的迭代次数
uniform float u_scale;   // 反演的基本缩放（1.0 = 参考实现）

/** 折回 [-1,1]³：\`fract\` 把小数部分映射到 [0,1)，再线性拉回来。 */
vec3 apollFold(vec3 p) {
  return -1.0 + 2.0 * fract(0.5 * p + 0.5);
}

float sdApollonian(vec3 p) {
  float s = 1.0;
  for (int i = 0; i < 16; i++) {
    if (i >= u_iter) break;
    p = apollFold(p);
    float r2 = dot(p, p);
    // ⚠️ 分子是**固定参数** u_scale，不是累积的 s（见文件头那次错误）
    float k = u_scale / max(r2, 1e-6);
    p *= k;
    s *= k;
  }
  // 折叠把 y=0 平面卷成密集的层 —— 它的零集就是那个球堆，不是一块平面
  return 0.25 * abs(p.y) / max(s, 1e-6);
}
`,
  set: (gl, l, v) => {
    const set1f = (name: string, value: number): void => {
      const loc = l[name];
      if (loc) gl.uniform1f(loc, value);
    };
    set1f('u_scale', Number(v.scale ?? 1));
    set1i(gl, l, 'u_iter', Number(v.iter ?? 8));
  },
};

/** 场景槽里可选的几何体。键就是 `s1.def` 的选项值。 */
export const SDF_GEOMS: Record<string, SdfGeom> = {
  menger: MENGER_GEOM,
  mandelbulb: MANDELBULB_GEOM,
  apollonian: APOLLONIAN_GEOM,
};

export function getSdfGeom(id: string): SdfGeom | null {
  return SDF_GEOMS[id] ?? null;
}
