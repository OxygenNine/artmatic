/**
 * gradients.ts — 调色面板里「渐变色轨道」的配色（纯函数，可单测）。
 *
 * 这些颜色是**内容**而不是 chrome：轨道的渐变在告诉用户「往这边推会发生什么」，
 * 跟随主题变会让「红 vs 青」这类信息丢失。与 `ring-math.ts` 的色相环同一取向，
 * 所以这里写死色相而不是用 token。
 *
 * 两种轨道：
 *  - **主量**（每个色轮下面那条）：一条中性灰阶，亮暗区间对应该轮盘影响的
 *    影调范围 —— 暗部轮盘只有暗段、亮部轮盘只有亮段。这不是装饰，是「这个
 *    轮子管哪一段」的唯一提示。
 *  - **参数**（对比 / 饱和 / 色相 / 色温 …）：渐变本身就是要调到的东西
 *    （中性灰 ↔ 高对比、灰 ↔ 高饱和、色相一周、冷 ↔ 暖）。
 *
 * 参数键在 `grade-basic` 里是固定的（见 `effects/defs/grade-basic.ts`），
 * 所以用表而不是解析 —— 拼不出来的键返回 `null`，调用方退回无渐变滑杆。
 */

/**
 * 灰阶取样：`p`（0..1）→ sRGB 灰。
 *
 * 用 8 位等值灰，不按「六档色板」取整 —— 取整过的那一版里
 * `gamma`(0.15→0.85) 与 `offset`(0→1) 落到同一串 hex 上，于是「中间调」与
 * 「偏移」两条轨道长得一模一样，「这轮子管哪一段」这条信息就丢了。
 */
function greyAt(p: number): string {
  const v = Math.round(Math.max(0, Math.min(1, p)) * 255);
  const hex = v.toString(16).padStart(2, '0');
  return `#${hex}${hex}${hex}`;
}

/** 取灰阶的一段（`from`/`to` 是 0..1 的位置）。主量轨道用它划分影调范围。 */
function greyBand(from: number, to: number): string {
  const stops = [0, 1 / 3, 2 / 3, 1].map((t) => greyAt(from + (to - from) * t));
  return `linear-gradient(90deg, ${stops.join(', ')})`;
}

/** 主量轨道的渐变。`group` 与 `WHEEL` 的组名一致。 */
export function masterGradient(group: 'lift' | 'gamma' | 'gain' | 'offset'): string {
  switch (group) {
    // 暗部：只在阴影段变化
    case 'lift':
      return greyBand(0, 0.45);
    // 中间调：两头都留一点，中间最亮的部分是「真正被改的地方」
    case 'gamma':
      return greyBand(0.15, 0.85);
    // 亮部：只有高光段
    case 'gain':
      return greyBand(0.55, 1);
    // 偏移：整段一起走
    case 'offset':
      return greyBand(0, 1);
  }
}

/**
 * 参数轨道的渐变。键不在表里 → `null`（调用方用普通滑杆）。
 *
 * 色相那一条是「一周」而不是两头同色：0° 与 360° 都是红，但这里画的是一段
 * 从红到品红再回到红的**单向**取样（`-180..180`），取中点 0°，两头 ±180°
 * 分别是青与青 —— 与参数值域对应，不能画成 `red→red` 的循环。
 */
const PARAMS: Record<string, string> = {
  contrast: greyBand(0, 1),
  saturation: 'linear-gradient(90deg, #808080, #b06a6a, #b04a4a)',
  hue:
    'linear-gradient(90deg, #3ad0d0, #3a7ad0, #b04ad0, #d04a6a, #d0a03a, #6ad04a, #3ad0d0)',
  temp: 'linear-gradient(90deg, #4a86ff, #9fc2ff, #e8e8e8, #ffd08a, #ff9a3c)',
  tint: 'linear-gradient(90deg, #4ad07a, #b8e8c8, #e8e8e8, #eec0e6, #d05ad0)',
};

export function paramGradient(key: string): string | null {
  return PARAMS[key] ?? null;
}

/** 面板里所有带渐变的参数键（单测用：防止表与参数表漂掉）。 */
export const GRADIENT_PARAM_KEYS: readonly string[] = Object.keys(PARAMS);
