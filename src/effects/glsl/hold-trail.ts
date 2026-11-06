import { floats, selectInt, compose, type EffectShaderDef } from '../shader-def';

/**
 * 定帧拖尾：每 N 帧把**整帧**盖到历史上，中间那些帧保持不动。
 *
 * 这是那个经典的系统级 bug 的模拟：窗口收不到重绘消息时，拖动它会在桌面
 * 上留下一条由自己上一帧副本组成的尾迹 —— 副本是**不透明的**，而且**永不
 * 淡出**（没人去重画那块桌面）。所以这里：
 *
 * - **不做任何权重混合**。旧实现用 `mix(cur, prev, w)`，那是多次曝光：
 *   每张副本按几何级数变淡，与「副本」不是一个东西。
 * - **不做逐帧位移**。位移是「内容自己在动」，不是特效给每层加偏移 ——
 *   加了偏移就会把这件事变成「每渲一次尾巴就长一节」，而暂停时预览每个
 *   rAF 都会重渲（`app-state` 的「暂停时永远渲」），尾巴会自己长到失控。
 *
 * 三种叠法（`mode`）：
 * - `stamp`（缺省）：`cur over prev`，用素材自己的 alpha。带透明通道的素材
 *   （排版 / 透明背景的生成器 / 抠好的素材）得到的就是真正的副本链条。
 * - `lighten` / `darken`：不透明素材没有 alpha 可用，整帧 over 等于原图。
 *   这两条按亮度取一侧 —— 亮底留暗尾、暗底留亮尾，同样是「取一次就不再变」，
 *   所以副本永不衰减。它们**不可逆**：一旦某像素被点亮/压暗，只能靠 seek 复原。
 *
 * 换图时刻是闭式的（与 `stutter` 同一手法）：`floor(t·fps/hold)` 给出第几个
 * 间隔，`n = 帧号 − 间隔起点` 是「离这次盖印过了几帧」。记状态会变成 dt 驱动
 * 的量，seek 不可复现 —— 硬约束 1.1。
 */
export const shader: EffectShaderDef = {
  feedback: true,
  fragment: `
uniform float u_hold;
// 声明成 int 是因为它由 selectInt() 用 uniform1i 写 —— 声明成 float 再喂
// uniform1i 会触发 INVALID_OPERATION 且**静默不写**（值恒为 0，永远走叠印）。
uniform int u_mode;
void main() {
  vec4 cur = texture(u_texture, vUv);
  vec4 prev = texture(u_feedback, vUv);

  float fps = 1.0 / max(u_delta, 1e-5);
  float hold = max(u_hold, 1.0);
  /*
   * 第几个间隔 + 间隔内第几帧，都从帧号算（u_time × fps 就是工程帧号）。
   * 不用「先还原 t0 再相减」那种写法：多一次除法就多一次浮点边界事故，
   * 表现是某个守时的帧被算到上一格里 —— 那一下会连冻两个间隔。
   * +0.001 是浮点余量，与 stutter 的 n 计算同源。
   */
  float frame = u_time * fps;
  float n = frame - floor(frame / hold + 0.001) * hold;

  vec4 stamped;
  if (u_mode < 1) {
    // 叠印：新帧盖在历史上（straight alpha 的 over）。alpha 本身就记着
    // 「这块被盖过」，所以副本是实心的，不需要额外的混合权重。
    float a = cur.a + prev.a * (1.0 - cur.a);
    vec3 col = a > 0.0001
      ? (cur.rgb * cur.a + prev.rgb * prev.a * (1.0 - cur.a)) / a
      : cur.rgb;
    stamped = vec4(col, a);
  } else {
    /*
     * 按亮度取一侧。历史被清空时是全黑（alpha = 0），此时取 min 会把第一帧
     * 压成一整幅黑 —— 所以先用 alpha 判一次「有没有历史」，没有就退回本帧。
     */
    float has = step(0.004, prev.a);
    vec3 seen = mix(cur.rgb, prev.rgb, has);
    vec3 picked = u_mode == 1 ? max(cur.rgb, seen) : min(cur.rgb, seen);
    stamped = vec4(picked, cur.a);
  }

  // 不在盖印帧：原样输出历史（这才是「定帧」）。
  outColor = n < 0.5 ? stamped : prev;
}`,
  setUniforms: compose(
    floats('hold'),
    selectInt('mode', { stamp: 0, lighten: 1, darken: 2 }),
  ),
};
