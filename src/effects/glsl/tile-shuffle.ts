import { floats, HASH_FAST_GLSL, type EffectShaderDef } from '../shader-def';

/**
 * 碎片位移：把画面切成方块，每格按自己那份 hash 旋转 90° 的整数倍 / 镜像 /
 * 搬到相邻格，发生概率由**外部蒙版 × 密度**给。
 *
 * 三条口径，改之前必须知道：
 *
 * 1. **网格按输出像素算**（`u_cellPx`），不是归一化 uv。按 uv 算的话格子数由
 *    分辨率决定，于是同一 t 在 640×360 预览与 1920×1080 导出里是两套不同的
 *    图案 —— 而这类特效「对不上」只在导出后才看得出。
 * 2. **hash 是坐标的纯函数 + 量化时刻**，不掺 `u_seed`：掺了就是逐帧换一套
 *    图案，读作噪点而不是「碎一下」。`u_rate` 把时间量化成 1/rate 秒的台阶，
 *    `rate = 0` 时完全静止。
 * 3. **蒙版取格心**，整格同进同出。逐像素取会让格子内部撕裂成渐变，
 *    那是另一种特效（`slices` 才是按行连续位移）。
 *
 * 「搬到邻格」是**逆映射**：每格独立去邻居那里取样。所以不是真正的置换 ——
 * 有的格被复制、有的格被覆盖丢掉。做成真置换要按校验和配对，成本与收益
 * 不成比例（观感上没区别，都是「碎块错位」）。
 *
 * hash 用 `HASH_FAST_GLSL` 而不是 `HASH_GLSL`：格子坐标在 1080p 下能到几百，
 * 而 `fract(sin(x) * 43758.5)` 在自变量过百之后低位不稳，位移图案会在帧间跳
 * （`slices` 踩过这一枪，见那里的注释）。
 */
export const shader: EffectShaderDef = {
  /*
   * 蒙版是**这个特效的输入**（概率场），不是「作用范围」。
   * 缺省的 `'composite'` 模式会变成 `mix(原图, 结果, 蒙版)` —— 那与「蒙版亮的地方
   * 更容易被洗」看着相似但完全不是一回事：暗部的碎块会被整块抹回原样。
   */
  mask: 'input',
  fragment: `
uniform float u_cellPx;
uniform float u_density;
uniform float u_rate;
${HASH_FAST_GLSL}

/*
 * 格子上限。1px 的格子在导出分辨率下会得到一整幅噪点，而 90° 旋转与镜像在
 * 1px 上没有意义 —— 所以格子边长有个下限：总格数不超过 MAX_CELLS。
 * 这是**确定性钳制**（同一个分辨率永远得到同一套格子），不是随机降级。
 */
const float MAX_CELLS = 4096.0;

/* 绕格心转 90°·k。格子取的是**像素正方形**，所以转完仍落在格内，不串邻居。 */
vec2 spinCell(vec2 p, float k) {
  p -= 0.5;
  for (int i = 0; i < 3; i++) {
    if (float(i) >= k) break;
    p = vec2(-p.y, p.x);
  }
  return p + 0.5;
}

void main() {
  float cellPx = max(u_cellPx, sqrt(u_resolution.x * u_resolution.y / MAX_CELLS));
  vec2 p = vUv * u_resolution;
  vec2 cell = floor(p / cellPx);
  vec2 local = fract(p / cellPx);

  /*
   * 换图时刻：量化到 1/rate 秒，并**折回 1024 以内**。
   *
   * 折回是精度而不是节省：hash21 的自变量是 stamp × 91，长工程里 stamp 能到
   * 几万，乘完再取 fract 就只剩两三位有效数字 —— 图案会「冻住」不再变。
   * 1024 次换图（6 次/秒时约 3 分钟）重复一次，看不出来。
   */
  float stamp = u_rate > 0.0 ? mod(floor(u_time * u_rate), 1024.0) : 0.0;

  // 概率 = 蒙版采样 × 密度，按格心取一次（见文件头第 3 条）。
  float prob = u_maskOn > 0.5
    ? texture(u_mask, (cell + 0.5) * cellPx / u_resolution).r
    : 1.0;
  prob = clamp(prob * u_density, 0.0, 1.0);

  // 采样源：默认是本格原样，命中后由各自的 hash 改写成别的取样位置。
  vec2 srcCell = cell;
  vec2 src = local;
  if (hash21(cell + vec2(stamp * 37.0, stamp * 91.0)) < prob) {
    /*
     * 三路处置各用**独立的** hash。共用一个的话「动不动」与「怎么动」会相关 ——
     * 表现是「概率调低时只剩旋转，看不到搬运」（阈值把区间切歪了）。
     */
    float sel = hash21(cell + vec2(stamp * 13.0, 71.0));
    if (sel < 0.45) {
      // 旋转 90° 的整数倍（含 0°）：画面本身是方的，转 180° 与 90° 都读得出
      src = spinCell(local, floor(hash21(cell + vec2(5.0, stamp * 23.0)) * 4.0));
    } else if (sel < 0.6) {
      src = vec2(1.0 - local.x, local.y);
    } else if (sel < 0.75) {
      src = vec2(local.x, 1.0 - local.y);
    } else {
      // 搬到四邻域之一：取分量更大的那个方向，避免四角斜向搬运（那会露缝）
      vec2 d = vec2(
        hash21(cell + vec2(stamp * 7.0, 3.0)),
        hash21(cell + vec2(11.0, stamp * 17.0))
      ) - 0.5;
      srcCell = cell + (abs(d.x) > abs(d.y) ? vec2(sign(d.x), 0.0) : vec2(0.0, sign(d.y)));
    }
  }

  // clamp 而不是环绕：环绕会把画面另一侧的碎块搬进来（读作「镜像」而不是「错位」）。
  vec2 uv = clamp((srcCell + src) * cellPx / u_resolution, 0.0, 1.0);
  outColor = texture(u_texture, uv);
}`,
  setUniforms: floats('cellPx', 'density', 'rate'),
};
