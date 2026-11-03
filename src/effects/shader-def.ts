/**
 * shader-def.ts — 特效着色器协议（移植 openmosh EffectShaderDef，MIT，见 CREDITS.md）。
 *
 * 全部字段都已实现：fragment / prePasses / linearFilter / hdrFeedback /
 * opaqueOutput / feedback。
 * 不移植：animated 标志（我们由 t 驱动）、mosh/volumeLink、文字 uniform 族。
 *
 * 「新增一个特效 = 两个文件」：defs/<id>.ts（参数面板定义）+
 * glsl/<id>.ts（本协议实现），registry 按文件名自动配对。
 */

import type { EffectClip } from '../core/schema';
import { beatAtTime, type BeatGrid } from '../core/time';
import { colorVec3, SRGB_TRANSFER } from '../core/color';
import type { GlyphAtlasSpec } from '../engine/glyph-atlas';
import type { ToneCurveSet } from '../engine/curve-texture';
import type { MessageKey } from '../i18n/locales';
import type { ParamDef } from './types';

/** hex 颜色 → [0..1] 的三分量，供 `setUniforms` 里给 vec3 uniform 用。 */
export { colorVec3 };

type Setter<Ctx> = (
  gl: WebGL2RenderingContext,
  locs: Record<string, WebGLUniformLocation | null>,
  values: Record<string, number | string>,
  ctx: Ctx,
) => void;

/** 把若干 setter 依次调用。参数同时含 float / int / color 时用它拼。 */
export function compose<Ctx = EffectUniformCtx>(...fns: Setter<Ctx>[]): Setter<Ctx> {
  return (gl, l, v, ctx) => {
    for (const fn of fns) fn(gl, l, v, ctx);
  };
}

/** 数值参数 → `uniform int`（四舍五入）。checkbox 参数也走这个。 */
export function ints<Ctx = EffectUniformCtx>(...keys: string[]): Setter<Ctx> {
  return (gl, l, v) => {
    for (const key of keys) {
      const loc = l[`u_${key}`];
      if (loc) gl.uniform1i(loc, Math.round(Number(v[key]) || 0));
    }
  };
}

/** 颜色参数 → `uniform vec3`（hex → 0..1）。 */
export function colors<Ctx = EffectUniformCtx>(...keys: string[]): Setter<Ctx> {
  return (gl, l, v) => {
    for (const key of keys) {
      const loc = l[`u_${key}`];
      if (!loc) continue;
      const [r, g, b] = colorVec3(String(v[key] ?? '#000000'));
      gl.uniform3f(loc, r, g, b);
    }
  };
}

/**
 * select 参数 → `uniform int`：`map` 把选项的 `value` 映射成序号。
 *
 * 未知值用 `fallback`（默认 0）而**不报错**是刻意的：工程向前/向后兼容，
 * 「选项退化成第一种模式」比「整帧拒渲」好。
 */
export function selectInt<Ctx = EffectUniformCtx>(
  key: string,
  map: Record<string, number>,
  fallback = 0,
): Setter<Ctx> {
  return (gl, l, v) => {
    const loc = l[`u_${key}`];
    if (!loc) return;
    const n = map[String(v[key])];
    gl.uniform1i(loc, n === undefined ? fallback : n);
  };
}

/* ------------------------------------------------- pre-pass 片段库 */

/**
 * 横向 / 纵向高斯模糊 pre-pass（半径由 `u_radius` 给，R = 16 tap）。
 *
 * 放在这里而不是 `glsl/` 下：那个目录是**按文件名与 `defs/` 一一配对**的，
 * 多一个不对应的文件会让注册表启动报错。`glow` 与 `blur` 共用这两个 pass，
 * 所以是共享常量而不是各抄一份。
 *
 * `u_resolution` 用**全分辨率**（`EFFECT_HEAD` 提供）而不是 pre-pass 缓冲尺寸 ——
 * pre-pass 跑在半分辨率上，但屏幕空间的模糊宽度不该因此变窄。
 */
export const BLUR_H_PASS = `uniform float u_radius;
void main() {
  vec2 px = 1.0 / u_resolution;
  float spread = u_radius * 3.0;
  float sigma = spread * 0.4;
  float invSigma2 = 1.0 / max(sigma * sigma, 0.001);
  vec4 sum = vec4(0.0);
  float totalW = 0.0;
  const int R = 16;
  float step = spread / float(R);
  for (int i = -R; i <= R; i++) {
    float fi = float(i) * step;
    float w = exp(-fi * fi * invSigma2);
    sum += texture(u_texture, vUv + vec2(fi * px.x, 0.0)) * w;
    totalW += w;
  }
  outColor = sum / totalW;
}`;

export const BLUR_V_PASS = `uniform float u_radius;
void main() {
  vec2 px = 1.0 / u_resolution;
  float spread = u_radius * 3.0;
  float sigma = spread * 0.4;
  float invSigma2 = 1.0 / max(sigma * sigma, 0.001);
  vec4 bloom = vec4(0.0);
  float totalW = 0.0;
  const int R = 16;
  float step = spread / float(R);
  for (int i = -R; i <= R; i++) {
    float fi = float(i) * step;
    float w = exp(-fi * fi * invSigma2);
    vec2 off = vec2(0.0, fi * px.y);
    bloom += texture(u_texture, vUv + off) * w;
    totalW += w;
  }
  outColor = bloom / totalW;
}`;

/* --------------------------------------------------------------- 时钟 */

/**
 * 时钟驱动的特效共用的相位函数。
 *
 * openmosh 给这些特效的 `u_time` 是**累积相位**（它引擎侧做 `phase += dt * speed`），
 * 所以它的 fragment 直接写 `fract(u_time)` / `floor(u_time)`。
 * 那是 dt 驱动的有状态量 —— 违反硬约束 1.1、seek 不可复现，**不能照搬**：
 * 直接传 `u_time = t` 的话，`speed` 参数会**完全失效且不报错**。
 *
 * 这里把相位算成**闭式**：自由模式是 `t * speed`，按拍模式是 `拍相位 * division`。
 * `u_beat` 由 `clockUniforms()` 在 JS 侧算好传进来（`BeatGrid` 只有 JS 侧有）。
 */
export const CLOCK_GLSL = `float clockPhase(float t, float sync, float speed, float div, float beat) {
  return sync > 0.5 ? beat * div : t * speed;
}
`;

/** 一拍里跑几个循环。`0.25` = 4 拍一个循环。 */
const CLOCK_DIVISIONS: { value: string; labelKey: MessageKey }[] = [
  { value: '0.25', labelKey: 'fx.clock.div025' },
  { value: '0.5', labelKey: 'fx.clock.div05' },
  { value: '1', labelKey: 'fx.clock.div1' },
  { value: '2', labelKey: 'fx.clock.div2' },
  { value: '3', labelKey: 'fx.clock.div3' },
  { value: '4', labelKey: 'fx.clock.div4' },
  { value: '8', labelKey: 'fx.clock.div8' },
];

/**
 * 时钟三件套：`sync` + `speed` + `division`。
 *
 * `speed` 只在自由模式显示、`division` 只在按拍模式显示 —— 这是
 * `ParamDef.visibleWhen` 的首次实战（在此之前没有任何特效用过它）。
 * 文案键是**共用的** `fx.clock.*`，不给每个特效各写一套。
 */
export function clockParams(speed: {
  labelKey: MessageKey;
  min: number;
  max: number;
  step: number;
  defaultValue: number;
  curve?: number;
}): ParamDef[] {
  return [
    {
      key: 'sync',
      labelKey: 'fx.clock.sync',
      type: 'select',
      defaultValue: 'free',
      options: [
        { labelKey: 'fx.clock.syncFree', value: 'free' },
        { labelKey: 'fx.clock.syncBeat', value: 'beat' },
      ],
    },
    {
      key: 'speed',
      labelKey: speed.labelKey,
      type: 'range',
      min: speed.min,
      max: speed.max,
      step: speed.step,
      defaultValue: speed.defaultValue,
      ...(speed.curve === undefined ? {} : { curve: speed.curve }),
      // 按拍模式下速度由拍网格决定，这个滑杆没有意义。
      visibleWhen: (v) => v.sync !== 'beat',
    },
    {
      key: 'division',
      labelKey: 'fx.clock.division',
      type: 'select',
      defaultValue: '1',
      options: CLOCK_DIVISIONS,
      visibleWhen: (v) => v.sync === 'beat',
    },
  ];
}

/**
 * 派发时钟三件套，并把 `u_beat`（当前拍相位，可带小数）算好传进去。
 *
 * `u_beat` 必须在 JS 侧算：`BeatGrid` 是 `bpm / offset / beatsPerBar` 三件套，
 * GLSL 侧拿不到。用了 `clockPhase()` 的 fragment 都要配上这个 setter。
 *
 * **`u_sync` 这里必须用 `uniform1f`**：fragment 里它声明成 `uniform float u_sync`，
 * 而对 float uniform 调 `uniform1i` 会触发 GL `INVALID_OPERATION` 并且**静默不写**
 * —— uniform 保持 0，于是「按拍」永远退回 `t * speed`，看起来像功能没做。
 * 8 个 clock 特效一起中过这一枪。**写 uniform 的类型必须与声明逐字对应。**
 */
export function clockUniforms<Ctx extends { t: number; grid: BeatGrid; fps: number }>(): Setter<Ctx> {
  return (gl, l, v, ctx) => {
    const sync = l['u_sync'];
    if (sync) gl.uniform1f(sync, v.sync === 'beat' ? 1 : 0);
    const speed = l['u_speed'];
    if (speed) gl.uniform1f(speed, Number(v.speed) || 0);
    const div = l['u_division'];
    if (div) gl.uniform1f(div, Number(v.division) || 1);
    const beat = l['u_beat'];
    if (beat) gl.uniform1f(beat, beatAtTime(ctx.t, ctx.grid));

    // `u_delta` 的口径是「**本特效用于动画的那个量**的每帧增量」，不是固定的秒/帧。
    // 对 clock 特效那个量是**相位**（自由模式是 `t·speed`，按拍是 `beat·division`），
    // 所以这里要按各自的关系换算。上游正是这么给的
    // （`out.delta = dt * perBeat * beatsPerSecond`）。
    // 目前 8 个 clock 特效都没读 `u_delta` —— 给对是为了不留地雷：
    // 若照旧传秒，将来某个 clock 特效读它就会得到差一个 `speed`/`division` 的量。
    const delta = l['u_delta'];
    if (delta) {
      const perFrame = ctx.fps > 0 ? 1 / ctx.fps : 0;
      gl.uniform1f(
        delta,
        v.sync === 'beat'
          ? perFrame * (ctx.grid.bpm / 60) * (Number(v.division) || 1)
          : perFrame * (Number(v.speed) || 0),
      );
    }
  };
}

export interface PrePassDef {
  fragment: string;
  /** 这一 pass 采样输入时临时切成 LINEAR（smooth warps 需要）。 */
  linearFilter?: boolean;
  /**
   * 这一 pass 的输出作为**私有全分辨率浮点历史**保留，下一帧以
   * `u_feedback` 交回；同时它的输出也是下一环的输入。用于「与主 pass
   * 自己的反馈分离」的状态，例如背景估计、被保持的关键帧。
   */
  feedback?: boolean;
  /**
   * 这一环的 `u_texture` 换成**上一帧的链输入**（而不是上一环的输出）。
   *
   * 给「要拿当前帧和上一帧输入做帧间差分」的特效用（`kino-datamosh` 的运动估计）。
   * 链里本来拿不到它：`u_texture` 是上一环的输出、`u_feedback` 是**自身上一帧的输出**、
   * `u_original` 是当前帧的链输入。而这一环自己用 `feedback` 存一帧输入也不行 ——
   * 那存下来的是「上一帧它自己的输出」，永远差一帧。
   *
   * 只改**输入**，不改输出：这一环的结果照常成为下一环的输入。
   * `linearFilter` 作用在它上面（过滤的是这一环实际读的那张贴图）。
   * 存储由 runner 在整条链跑完后写入本帧的链输入（`compositor.delayedInputFor`）。
   */
  delayedInput?: boolean;
}

export interface EffectShaderDef {
  /** 主 fragment（EFFECT_HEAD 之后的部分）。 */
  fragment: string;
  /**
   * 主 pass 之前的全屏 pass 链。第一环读本特效的输入，最后一环的输出
   * 就是主 pass 的 `u_texture`。非 feedback 的 pre-pass 渲染在**半分辨率
   * 浮点草稿**上，且 `u_resolution` 仍传全分辨率（降采样只改 tap 密度，
   * 不改模糊半径）。
   */
  prePasses?: PrePassDef[];
  /** 主 pass 采样输入时临时切成 LINEAR（smooth warps 需要）。 */
  linearFilter?: boolean;
  /**
   * 把本实例的 `u_feedback` 历史分配成 RGBA16F 而不是 RGBA8。
   * 有状态模拟的逐帧增量会低于 8bit 量化步长，用 8bit 会 stall 成色块。
   * 设备不支持 `EXT_color_buffer_float` 时安静回落 RGBA8。
   */
  hdrFeedback?: boolean;
  /** 本着色器自己铺整帧背景（不保留输入 alpha）。协议语义，runner 无需特殊处理。 */
  opaqueOutput?: boolean;
  /** 主 pass 需要 u_feedback（实例的跨帧历史，ping-pong）。 */
  feedback?: boolean;
  /**
   * 这个特效**吃一张外部蒙版**（fragment 声明了 `u_mask`，见 `EFFECT_HEAD`）。
   *
   * 判据只有一条：写了 `mask: true`，runner 就去问 compositor 要这个实例的
   * 蒙版贴图并绑上（`EffectInstance.inputs.mask` 指向哪个片段 / 素材）。
   * 没接引用的实例拿到一张 1×1 全白 + `u_maskOn = 0` —— 于是「没接蒙版」与
   * 「接了但关掉」在着色器里可以走同一条快路，不需要在 GLSL 里判空。
   *
   * 未声明的特效不占 sampler 单元、也不进拓扑：蒙版是一条**依赖边**，
   * 声明它的特效才会把被引用片段拉进这一帧的渲染序。
   */
  mask?: boolean;
  /**
   * 需要**字形图集**（fragment 声明了 `u_atlas`）时：从参数算出要栅格化的
   * 字符序列与字体。返回 null = 这一帧不用图集（runner 绑一张全白占位图）。
   *
   * 图集由 `engine/glyph-atlas.ts` 建与绑定，与 `u_spectrum` / `u_overlay`
   * 同一形态：协议只有「声明了这个 sampler，服务就会绑」，runner 里没有
   * defId 分支，所以主应用与 `/lab/`、离屏缩略图渲染器自动都有。
   *
   * 服务同时派发 `u_glyphCount`（字形数）与 `u_glyphCols`（图集每行几格）：
   * 着色器要按它们算索引与 UV，声明成 `uniform float`。
   */
  glyphs?: (values: Record<string, number | string>) => GlyphAtlasSpec | null;
  /**
   * 需要**调色曲线表**（fragment 声明了 `u_curve`）时：从参数取出四条曲线串。
   *
   * 与 `glyphs` 同一形态：协议只有「声明了这个 sampler，服务就会绑」，
   * runner 里没有 defId 分支。键名是各模块自己的约定（`grade-curves` 用
   * `curve#master` 等），所以这里只传形状，不传语义。
   */
  curveTable?: (values: Record<string, number | string>) => ToneCurveSet | null;
  /**
   * 需要 **`.cube` 查找表**（fragment 声明了 `u_lut`）时：返回工程素材 id。
   *
   * 返回 `null` = 这一帧不查表（用户还没导入 / 素材被删）—— 服务会绑恒等表并
   * 置 `u_lutOn = 0`，画面原样通过。
   */
  lut?: (values: Record<string, number | string>) => string | null;
  /**
   * **跨帧状态**（帧间累积的东西，不是每帧独立求值）。
   *
   * 目前只被缩略图渲染器用：`EffectThumbRenderer` 对这类特效连渲若干帧，
   * 因为「只渲一帧」得到的是状态的第一帧（对 `feedback` 是黑，对追踪叠加层
   * 是「还没跟稳的框」）。`feedback` / `prePasses[].feedback` 已经隐含这一条，
   * 这个字段是给**不用 `u_feedback` 但同样有状态**的特效（如 `box-tracker`
   * 的追踪器）留的。
   */
  stateful?: boolean;
  setUniforms: (
    gl: WebGL2RenderingContext,
    locs: Record<string, WebGLUniformLocation | null>,
    values: Record<string, number | string>,
    ctx: EffectUniformCtx,
  ) => void;
}

export interface EffectUniformCtx {
  t: number;
  frame: number;
  /** hashSeed(project.seed, instanceId, frame) / 2^32 ∈ [0,1)。 */
  seed: number;
  w: number;
  h: number;
  /** 名义帧间隔的倒数来源：`u_delta` = 1/fps。 */
  fps: number;
  grid: BeatGrid;
  clip: EffectClip;
}

/**
 * sRGB 传输函数（分段式），**从 `core/color.ts` 的常数拼出来**。
 *
 * 拼而不是抄：TS 侧（示波器、LUT 解析、UI 刻度）与 GLSL 侧必须逐位同一套常数，
 * 两处各写一份的漂移不会报错，只会让「编辑器里的曲线」和「画面上的结果」对不上。
 *
 * 两条写法上的坑：
 *
 * 1. **`mix` 会在两支上同时求值**，所以 `pow()` 的参数必须先 `max(…, 0)`。
 *    调色的 lift 允许负值，负数的 `pow` 是 NaN，而 `mix(valid, NaN, 0)` 在很多
 *    驱动上仍然是 NaN —— 表现是「压黑的那一小块变成彩点/黑块」。
 * 2. 编码方向**不夹上界**：16F 中间缓冲允许 >1 的高光留着，让后面的模块（降采样
 *    模糊、bloom）还能用到。夹上界是最后写 8 位目标时硬件自己的事。
 *
 * 只在**调色 pass 的 main 内部**使用（见 `core/grade.ts` 的「线性岛」）。
 * 定义必须排在 `EFFECT_HEAD` **之前** —— 后者在模块求值时就把它拼进去了。
 */
export const TRANSFER_GLSL = `vec3 toLinear(vec3 c) {
  c = max(c, vec3(0.0));
  vec3 lo = c / ${SRGB_TRANSFER.slope};
  vec3 hi = pow((c + ${SRGB_TRANSFER.offset}) / ${SRGB_TRANSFER.scale}, vec3(${SRGB_TRANSFER.gamma}));
  return mix(lo, hi, step(vec3(${SRGB_TRANSFER.encodeBreak}), c));
}
vec3 toSrgb(vec3 c) {
  c = max(c, vec3(0.0));
  vec3 lo = c * ${SRGB_TRANSFER.slope};
  vec3 hi = ${SRGB_TRANSFER.scale} * pow(c, vec3(${1 / SRGB_TRANSFER.gamma})) - ${SRGB_TRANSFER.offset};
  return mix(lo, hi, step(vec3(${SRGB_TRANSFER.linearBreak}), c));
}
`;

/**
 * 所有特效 fragment 共享的头部（uniform 约定都在这里）。
 *
 * 尾部拼的是 `TRANSFER_GLSL`（`toLinear` / `toSrgb`）：81 个特效里没人用它也不会
 * 多花时间 —— 没被调用的函数在链接期就被丢掉了。放在共享头而不是让调色 def
 * 各自 import，是因为「线性岛」的边界只该有一份写法。
 *
 * ## 时间与「累积相位」的移植约定
 *
 * `u_time` 是**秒**。openmosh 里带 `speed` 参数的特效拿到的是「累积相位」
 * （`phase += dt * speed`，有状态）。那是 dt 驱动的累加器，与硬约束 1.1
 * （唯一时钟是 t）冲突，而且 seek 不可复现 —— **不要照搬**。
 *
 * Artmatic 的等价写法是**把相位算成闭式**：常速时 `float phase = u_time * u_speed;`
 * 就在 fragment 里。需要按拍同步（openmosh 的 `sync === 'beat'`）时，在
 * `setUniforms` 里用 `beatAtTime(ctx.t, ctx.grid) * division` 算好，当普通
 * uniform 传进去 —— 那里拿得到 `BeatGrid`。
 *
 * 因此**不存在逐实例相位表**：相位是 t 的函数，不是历史。
 */
export const EFFECT_HEAD = `#version 300 es
precision highp float;
uniform sampler2D u_texture;
uniform sampler2D u_feedback;
uniform sampler2D u_original;
/*
 * 外部蒙版（EffectShaderDef.mask，R8 单通道）。
 *
 * 无条件声明在这里而不是让 def 自己加：协议里「声明了 sampler 服务就会绑」
 * 这条要成立，名字必须只有一处。没声明 mask: true 的特效链接期就把它们丢掉。
 * u_maskOn = 0 时绑的是 1x1 全白，所以「没接蒙版」与「接了全白」在数值上
 * 一致 —— 着色器不需要为此写两条路径。
 */
uniform sampler2D u_mask;
uniform float u_maskOn;
uniform float u_time;
uniform float u_delta;
uniform float u_seed;
uniform vec2 u_resolution;
in vec2 vUv;
out vec4 outColor;
${TRANSFER_GLSL}`;

/**
 * openmosh 的 hash 噪声（移植）。随机必须掺 `u_seed`——见 slices。
 *
 * **三个 hash 变体的选择**（移植时别拿错）：
 * - 本常量（**带 seed**）：用于「每次求值都该换个图案」的随机处置，如 slices 的行位移。
 * - `HASH_PLAIN_GLSL`（**不带 seed**）：坐标的纯函数。用于「图案要稳定、只随时间平滑
 *   演化」的场合（pixel-shifter、grain、composite 这类）。
 *   openmosh 的同名常量就是这一支 —— **移植时不要直接换成本常量**，否则图案会从
 *   「随时间爬行」变成「逐帧闪烁」。
 * - `HASH_FAST_GLSL`（Dave Hoskins 无 sin 族）：大像素坐标下更稳定。
 */
export const HASH_GLSL = `float hash(vec2 p) {
  return fract(sin(dot(p, vec2(12.9898, 78.233)) + u_seed * 937.0) * 43758.5453);
}
`;

/**
 * openmosh `HASH_GLSL` 的**原样**版本：同样的常数，但不掺 `u_seed`。
 *
 * 分成两支是因为用途不同：掺 seed 的那支让图案逐帧变，不掺的这支是坐标的纯函数。
 * 见 `HASH_GLSL` 的说明。
 */
export const HASH_PLAIN_GLSL = `float hash(vec2 p) {
  return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453);
}
`;

/**
 * Dave Hoskins 的无 sin hash（angel-echo 的 LIB，公有领域惯例，见 CREDITS.md）。
 * 与上者的差别：不用 sin，**在很大的像素坐标下依然稳定**（grain / composite 需要）。
 * 不带 u_seed —— 它是坐标的纯函数；需要逐帧变化时配合 tick 量化
 * （`floor(u_time * N)`）而不是掺种子。
 */
export const HASH_FAST_GLSL = `float hash11(float p) {
  p = fract(p * 0.1031);
  p *= p + 33.33;
  p *= p + p;
  return fract(p);
}
float hash21(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}
float hash31(vec3 p3) {
  p3 = fract(p3 * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}
`;

/**
 * openmosh 的 value noise + fbm（3 阶）。
 *
 * 建在 `HASH_PLAIN_GLSL`（**不掺 seed**）上 —— 这与 openmosh 的 `NOISE_GLSL`
 * 逐字等价。它服务的是**空间图案**（织纹、位移场），图案必须稳定；
 * 接了掺 seed 的那支就会逐帧沸腾。（初版建在 `HASH_GLSL` 上，是错的；
 * 在它被第一个消费者用上之前改掉了。）
 */
export const NOISE_GLSL =
  HASH_PLAIN_GLSL +
  `float vnoise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash(i), hash(i + vec2(1.0, 0.0)), u.x),
             mix(hash(i + vec2(0.0, 1.0)), hash(i + vec2(1.0, 1.0)), u.x), u.y);
}
float fbm(vec2 p) {
  return vnoise(p) * 0.55 + vnoise(p * 2.13 + 5.0) * 0.3
       + vnoise(p * 4.41 + 9.0) * 0.15;
}
`;

/**
 * angel-echo 的 6 阶 fbm + ridge + rot。基于 HASH_FAST_GLSL（无 sin）。
 * 比 NOISE_GLSL 贵，但层次更细；`ridge` 是「离零距离」的脊线函数，
 * `rot` 是标准 2D 旋转矩阵。
 */
export const FBM6_GLSL =
  HASH_FAST_GLSL +
  `float vnoise2(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash21(i), hash21(i + vec2(1.0, 0.0)), u.x),
             mix(hash21(i + vec2(0.0, 1.0)), hash21(i + vec2(1.0, 1.0)), u.x), u.y);
}
float fbm6(vec2 p) {
  float s = 0.0;
  float a = 0.5;
  mat2 m = mat2(1.6, 1.2, -1.2, 1.6);
  for (int i = 0; i < 6; i++) {
    s += a * vnoise2(p);
    p = m * p;
    a *= 0.5;
  }
  return s;
}
float ridge(float v, float w) {
  return 1.0 - smoothstep(0.0, w, abs(v));
}
`;

/** 小几何工具：三角波与 2D 旋转。 */
export const MATH_GLSL = `float bounce(float v) {
  v = mod(abs(v), 2.0);
  return v > 1.0 ? 2.0 - v : v;
}
vec2 rot(vec2 p, float a) {
  float c = cos(a);
  float s = sin(a);
  return mat2(c, -s, s, c) * p;
}
`;

/** HSV 互转（openmosh / angel-echo 同源写法）。 */
export const HSV_GLSL = `vec3 rgb2hsv(vec3 c) {
  vec4 K = vec4(0.0, -1.0 / 3.0, 2.0 / 3.0, -1.0);
  vec4 p = mix(vec4(c.bg, K.wz), vec4(c.gb, K.xy), step(c.b, c.g));
  vec4 q = mix(vec4(p.xyw, c.r), vec4(c.r, p.yzx), step(p.x, c.r));
  float d = q.x - min(q.w, q.y);
  return vec3(abs(q.z + (q.w - q.y) / (6.0 * d + 1e-10)), d / (q.x + 1e-10), q.x);
}
vec3 hsv2rgb(vec3 c) {
  vec4 K = vec4(1.0, 2.0 / 3.0, 1.0 / 3.0, 3.0);
  vec3 p = abs(fract(c.xxx + K.xyz) * 6.0 - K.www);
  return c.z * mix(K.xxx, clamp(p - K.xxx, 0.0, 1.0), c.y);
}
`;

/** 罗德里格色相旋转，angle 单位是**度**。 */
export const HUE_ROTATE_GLSL = `vec3 hueRotate(vec3 c, float angle) {
  float rad = angle * 3.14159265 / 180.0;
  float cosA = cos(rad);
  float sinA = sin(rad);
  vec3 k = vec3(0.57735026919);
  return c * cosA + cross(k, c) * sinA + k * dot(k, c) * (1.0 - cosA);
}
`;

/**
 * 黄金角 8 tap 圆盘采样（angel-echo 的 `disc()`）。r 以**像素**为单位。
 * 读 u_texture、用 u_resolution —— 两者都由 EFFECT_HEAD 提供。
 */
export const DISC_GLSL = `vec3 disc(vec2 uv, float r) {
  vec3 sum = vec3(0.0);
  for (int i = 0; i < 8; i++) {
    float a = float(i) * 2.399963;
    float rr = r * sqrt((float(i) + 0.5) / 8.0);
    sum += texture(u_texture, clamp(uv + vec2(cos(a), sin(a)) * rr / u_resolution, 0.0, 1.0)).rgb;
  }
  return sum * 0.125;
}
`;

/** 紧凑有序抖动（Bayer 2/4/8）。Bayer8 配 N 级量化做单色印刷质感。 */
export const BAYER_GLSL = `float bayer2(vec2 a) {
  a = floor(a);
  return fract(a.x * 0.5 + a.y * a.y * 0.75);
}
float bayer4(vec2 a) {
  return bayer2(0.5 * a) * 0.25 + bayer2(a);
}
float bayer8(vec2 a) {
  return bayer4(0.5 * a) * 0.25 + bayer2(a);
}
`;

/**
 * 便捷 setUniforms：把 values 里的数值参数映射到 u_<key>。
 *
 * ctx 是泛型：特效与算法生成器共用同一份实现（两者的 ctx 形状不同但
 * 这里用不到），避免各抄一遍。
 */
export function floats<Ctx = EffectUniformCtx>(
  ...keys: string[]
): (
  gl: WebGL2RenderingContext,
  locs: Record<string, WebGLUniformLocation | null>,
  values: Record<string, number | string>,
  ctx: Ctx,
) => void {
  return (gl, l, v) => {
    for (const key of keys) {
      const loc = l[`u_${key}`];
      if (loc) gl.uniform1f(loc, Number(v[key]) || 0);
    }
  };
}

/**
 * 特效 program 的命名 —— **预编译与运行期必须同名**，否则 `Kit.quad` 的
 * 按名缓存会「另编一份」，预编译就白做了（`compile-all.ts` 的整个机制
 * 建立在这条约定上）。所以名字只有一个来源，这里是它。
 */
export function effectProgramName(defId: string, preIndex?: number): string {
  return preIndex === undefined ? `fx-${defId}` : `fx-${defId}:pre${preIndex}`;
}
