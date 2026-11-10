import { floats, HASH_FAST_GLSL, type EffectShaderDef } from '../shader-def';

/**
 * 苏联画质：把画面**真的**重采样到几十行的分辨率，按低色阶重新量化，
 * 再用双线性插值放回屏幕 —— 也就是「低分辨率素材被强行拉大」的整条链路。
 *
 * 与 `pixelate` 的差别是「同一种手段的两个终点」：`pixelate` 只挪采样点，
 * 网格是正方形的，颜色一点不动；这里是**降分辨率 + 减位深 + 减色度带宽**
 * 三件事一起做，读出「信号本身只剩这么多信息」而不是「画面被打成马赛克」。
 *
 * 四条口径：
 *
 * 1. **格子不是正方形。** 垂直方向就是扫描行数，水平方向按模拟带宽更低
 *    （约 0.62×）—— 所以格子横宽竖窄，「糊在横向」才是信号不够的样子。
 * 2. **量化在亮度 / 色度上分别做，色度台阶只有亮度的一半。** 直接按 RGB 取整
 *    （`posterize` 那样）只会得到色带，色度仍然是满带宽的 —— 那是「调色」的观感，
 *    不是「压缩」的观感。
 * 3. **边界是插值出来的，不是台阶。** 一格的全部处理（格内均值、色度宽域、
 *    位深取整）都在**低分辨率这一步**做完，再用周围四格的双线性插值放回屏幕：
 *    格心之间是直线过渡，边界因此是软的。直接输出格值会得到一圈硬边，读起来
 *    像贴纸贴上去的，而不是一张小图被拉大。**顺序不能反过来** —— 先放大再取整，
 *    色带会重新长出硬轮廓，那正是「看起来刻意」的来源。
 * 4. **噪声按格取、按 24Hz 台阶走**，不是逐像素逐帧的白噪点：压缩块噪声本来就
 *    长在块上，而逐帧变化要跟着信号的刷新节奏，否则像一层贴上去的胶片颗粒。
 *    台阶用 `floor(u_time * 24.0)` 而不是掺 `u_seed` —— 后者每次求值都换图案。
 *    它在插值之前进格值，所以边界处也跟着变软。
 */
export const shader: EffectShaderDef = {
  fragment: `
uniform float u_lines;
uniform float u_levels;
uniform float u_chroma;
uniform float u_noise;
uniform float u_tint;
uniform float u_dither;
${HASH_FAST_GLSL}
const vec3 LUMA = vec3(0.2126, 0.7152, 0.0722);

/* 格内 box 采样：4 个 tap 落在格子的 1/4 与 3/4 处，等价于把这一块揉成一个像素。 */
vec3 boxAvg(vec2 c, vec2 h) {
  vec3 s = texture(u_texture, c + vec2(-h.x, -h.y)).rgb;
  s += texture(u_texture, c + vec2(h.x, -h.y)).rgb;
  s += texture(u_texture, c + vec2(-h.x, h.y)).rgb;
  s += texture(u_texture, c + vec2(h.x, h.y)).rgb;
  return s * 0.25;
}

/*
 * 一格在**编码端**的值：格内均值取亮度、横向宽域取色度，两者各自按位深取整，
 * 再加偏色与块噪点。抖动也按格取（位深压缩本来就发生在低分辨率这一步，
 * 不是在放大后的屏幕上），于是同一格永远得到同一个值，插值出来才是稳定的软边。
 */
vec3 cellValue(vec2 id, vec2 cell, float lv, float cl, float t) {
  vec2 center = (id + 0.5) * cell;
  vec3 s = boxAvg(center, cell * 0.375);
  // 色度往右渗：一块横向更宽的宽域均值只贡献色度，亮度仍用上面那份。
  vec3 wide = boxAvg(center - vec2(cell.x * 1.1, 0.0), vec2(cell.x * 1.6, cell.y * 0.375));

  float y = dot(s, LUMA);
  vec3 chroma = mix(s - y, wide - dot(wide, LUMA), u_chroma);
  float d = mix(0.5, hash21(id * 1.7 + vec2(t * 5.3, t * 1.7)), u_dither);

  vec3 q = floor(y * lv + d) / lv + floor(chroma * cl + 0.5) / cl;
  // 老磁带的黄绿偏色（蓝通道先垮）。
  q *= mix(vec3(1.0), vec3(1.08, 1.0, 0.62), u_tint);
  q += (hash21(id + vec2(t * 3.7, t * 1.3)) - 0.5) * u_noise * 0.3;
  return q;
}

void main() {
  vec2 res = vec2(textureSize(u_texture, 0));
  float aspect = res.x / res.y;

  // 垂直 = 扫描行数；水平按带宽比打折，所以格子是扁宽的。
  float rows = floor(max(u_lines, 8.0));
  vec2 grid = vec2(max(floor(rows * aspect * 0.62), 8.0), rows);
  vec2 cell = 1.0 / grid;

  // 信号刷新台阶：24Hz 是这套噪声的时间粒度，与渲染帧率无关。
  float t = floor(u_time * 24.0);

  float lv = max(u_levels, 2.0);
  // 色度台阶只有亮度的一半 —— 模拟信号里色度带宽本来就差一截。
  float cl = max(lv * 0.5, 2.0);

  /*
   * 双线性放大：在「格心坐标系」里取周围四格，按小数部分插值。
   * 格心处等于该格自己的值，往边界走线性过渡到邻格 —— 边界因此是软的。
   */
  vec2 p = vUv * grid - 0.5;
  vec2 i0 = floor(p);
  vec2 f = p - i0;
  vec3 c00 = cellValue(i0, cell, lv, cl, t);
  vec3 c10 = cellValue(i0 + vec2(1.0, 0.0), cell, lv, cl, t);
  vec3 c01 = cellValue(i0 + vec2(0.0, 1.0), cell, lv, cl, t);
  vec3 c11 = cellValue(i0 + vec2(1.0, 1.0), cell, lv, cl, t);
  vec3 rgb = mix(mix(c00, c10, f.x), mix(c01, c11, f.x), f.y);

  // 不透明度取原分辨率那一份：块状的 alpha 边会在抠像素材上变成一圈阶梯。
  outColor = vec4(clamp(rgb, 0.0, 1.0), texture(u_texture, vUv).a);
}`,
  setUniforms: floats('lines', 'levels', 'chroma', 'noise', 'tint', 'dither'),
};
