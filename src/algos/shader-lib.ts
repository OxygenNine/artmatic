/**
 * shader-lib.ts — 算法生成器的着色器协议（与 `effects/shader-def.ts` 同构）。
 *
 * 为什么要单独一份头而不是复用 `EFFECT_HEAD`：算法生成器是**画面来源**，
 * 没有输入纹理（`u_texture`）、没有反馈历史（`u_feedback`）、也没有
 * 「未处理的源」（`u_original`）。共用一份会让每个生成的 shader 都声明
 * 三个永远拿不到东西的 sampler。
 *
 * `realtime` 型的 fragment 因此**不写头** —— 它由 `ALGO_HEAD` 拼在前面，
 * 与特效的「两文件纪律」同理。`bake` / `sim` 型不产 shader（走 Worker /
 * R8 纹理），只共用 `u_<key>` 的参数派发约定。
 */

import { beatAtTime, type BeatGrid } from '../core/time';
import { FBM6_GLSL, MATH_GLSL, floats } from '../effects/shader-def';
import type { SourceClip } from '../core/schema';
import type { SelectParam, RangeParam } from '../effects/types';
import type { MessageKey } from '../i18n/locales';
import type { AudioFeatures } from './feature-source';

/**
 * 运行时创建的内部纹理绑好之后的样子。生成器可以读它的**度量**
 * （如字形图集的列数/格宽），避免把布局硬编码进 shader。
 */
export interface AlgoAuxTexture {
  readonly tex: WebGLTexture;
  readonly w: number;
  readonly h: number;
  /** 图集的分格信息；非图集类纹理可缺省。 */
  readonly cols?: number;
  readonly rows?: number;
  readonly cell?: number;
  /**
   * 有符号距离场类纹理四周的留白（texel），`kind: 'logo-sdf'` 用。
   *
   * 与 `cols/rows/cell` 同一性质：**生成器要知道这张纹理的度量**，否则只能
   * 把留白 / 内容区尺寸硬编码进 shader，而它一变轮廓就整体涨缩（不报错）。
   * 内容区 = `w/h` 各减去两端留白，其余由消费方按「长边 = 2 世界单位」推。
   */
  readonly pad?: number;
}

export interface AlgoUniformCtx {
  t: number;
  frame: number;
  /** hashSeed(project.seed, clipId) —— 算法是整段恒定种子，不逐帧变。 */
  seed: number;
  /** 算法的**内部**渲染分辨率（不是输出帧尺寸）。 */
  w: number;
  h: number;
  fps: number;
  grid: BeatGrid;
  clip: SourceClip;
  /**
   * 音频特征（见 feature-source.ts）。**没有音频时是全 0 的静音特征**，
   * 不是 null —— 场景照常派发，只是画面偏暗，而不是「参数缺失」。
   *
   * 这个对象是**复用**的，只在本次 `setUniforms` 调用内有效。
   */
  features: AudioFeatures;
  /**
   * `def.auxTextures` 声明的内部纹理，按 uniform 名索引。
   *
   * **必须是可选字段** —— `tests/unit/algo-uniforms.test.ts` 用
   * `satisfies AlgoUniformCtx` 构造 ctx，加必填字段会让那份测试直接编译失败。
   */
  aux?: ReadonlyMap<string, AlgoAuxTexture>;
}

export type AlgoSetUniforms = (
  gl: WebGL2RenderingContext,
  locs: Record<string, WebGLUniformLocation | null>,
  values: Record<string, number | string>,
  ctx: AlgoUniformCtx,
) => void;

/**
 * 所有 `realtime` 生成器共享的头部。
 *
 * `u_time` **是秒**（与特效同一条口径：相位要闭式，见 shader-def.ts 的说明）。
 * `u_resolution` 是内部渲染尺寸，`u_aspect` = w/h —— 分形那类要看宽高比。
 */
export const ALGO_HEAD = `#version 300 es
precision highp float;
uniform float u_time;
uniform float u_delta;
uniform float u_seed;
uniform vec2 u_resolution;
uniform float u_aspect;
in vec2 vUv;
out vec4 outColor;
`;

/**
 * 所有 `realtime` 生成器共用的「内部渲染高度」参数。
 *
 * 单个真源：以前每个 def 各写一份 select，键名与选项会漂。内部低分辨率
 * 再放大是性能手段（AGENTS 明说不是跳帧缓存 —— 那会破坏确定性）。
 * 文案键也共用一套 `algo.intRes*`，不再一个生成器一份。
 */
export function intResParam(): SelectParam {
  return {
    key: 'intRes',
    labelKey: 'algo.intRes',
    type: 'select',
    defaultValue: '480',
    options: [
      { labelKey: 'algo.intRes.auto', value: 'auto' },
      { labelKey: 'algo.intRes.240', value: '240' },
      { labelKey: 'algo.intRes.480', value: '480' },
      { labelKey: 'algo.intRes.720', value: '720' },
      { labelKey: 'algo.intRes.1080', value: '1080' },
    ],
  };
}

/* ---------------------------------------------- 背景 / 透明度（全家族共用） */

/**
 * `bgMode` 的取值 → `u_bgMode`。
 *
 * ## 为什么是 select 而不是 checkbox
 *
 * 工程 JSON 里存的是字符串（`'solid'` / `'transparent'`），与 `smoke` 早已发布的
 * 参数同形 —— 那边已经是这套取值，另造一个布尔会让「同一个概念两种写法」。
 * 而且 select 的**选项名会进能力清单**（`serializeParam`），模型因此读得到
 * 「有透明这一档」；布尔只能告诉它「有个开关」。
 *
 * ## 缺省是 `solid`（不是透明）
 *
 * 这一族生成器的出厂画面是「墨色 + 底色」两件套，`colorBg` 是其中一个正常参数。
 * 缺省透明会让那个参数**默认失效**（拖它什么也不动），而缩略图在浅色菜单底板上
 * 会糊成一片脏灰（`smoke` 就是这样，所以它在 `catalog.ts` 里必须强制 `solid`）。
 * 所以透明是**显式选择**，不是缺省 —— 与「透明度通道存在」这件事不冲突。
 */
export const BG_MODES: Record<string, number> = { solid: 0, transparent: 1 };

/**
 * 背景开关参数。**唯一真源** —— 二十来个生成器共用一套文案键与取值。
 *
 * 读值一律走 `bgModeOf()`（缺键 → solid），不要自己写 `v.bgMode === 'transparent'`：
 * 手改过的老工程里根本没有这个键。
 */
export function bgModeParam(): SelectParam {
  return {
    key: 'bgMode',
    labelKey: 'algo.bg.mode',
    type: 'select',
    defaultValue: 'solid',
    options: [
      { labelKey: 'algo.bg.solid', value: 'solid' },
      { labelKey: 'algo.bg.transparent', value: 'transparent' },
    ],
  };
}

/** 参数表 → `u_bgMode` 的整数。**缺键 / 未知值一律 solid**（= 历史行为）。 */
export function bgModeOf(values: Record<string, number | string>): number {
  return BG_MODES[String(values['bgMode'] ?? 'solid')] ?? 0;
}

/**
 * 背景色参数的 `visibleWhen`：透明模式下底色不参与任何运算，**必须藏起来**。
 *
 * 留着它的代价不是多一个控件，而是「拖它画面不动」—— 那是本项目最不能接受
 * 的失效形态（见根 AGENTS §1.6 与各处的「静默无效」条目）。
 */
export function bgColorVisible(values: Record<string, number | string>): boolean {
  return values['bgMode'] !== 'transparent';
}

/**
 * 解析 `uniform <type> u_<name>;`（一行一个）。返回名字 → 类型。
 *
 * 放在这里而不是测试里：它有两个消费方 —— 接线守卫
 * （`tests/unit/algo-uniforms.test.ts`）与 `effects/compile-all.ts` 的
 * 「声明了但链接器丢掉了」检查。各写一份正则，迟早有一边漂。
 */
export function declaredUniforms(src: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const m of src.matchAll(
    /uniform\s+(float|int|bool|vec2|vec3|vec4|mat3|mat4|sampler2D)\s+(u_\w+)\s*;/g,
  )) {
    out.set(m[2]!, m[1]!);
  }
  return out;
}

/**
 * `realtime` 生成器的 program 名 —— 预编译与运行期必须同名（同
 * `effectProgramName` 的理由：`Kit.quad` 按名缓存，不同名就会「另编一份」）。
 */
export function algoProgramName(id: string): string {
  return `algo-${id}`;
}

/**
 * `sim` 型自定义着色（`def.tintFragment`）的 program 名。
 *
 * 与 `algoProgramName` 分开命名（`algo-tint-*` vs `algo-*`）是必须的：
 * 同一个 `Kit.quad` 按名缓存 program，撞名就意味着「另编一份」或者
 * 「拿错的那份」—— 前者白做预编译，后者是画面直接错。
 */
export function algoTintProgramName(id: string): string {
  return `algo-tint-${id}`;
}

/* ------------------------------------------------------------ 程序化场景 */

/**
 * 场景生成器共享的 GLSL 前缀：噪声库 + 音频特征 uniform 块 + 边界衰减。
 *
 * 噪声库**不抄第二份** —— `FBM6_GLSL`（含 Dave Hoskins 的 `hash11/21/31`、
 * 6 阶 `vnoise2`/`fbm6`、`ridge`）与 `MATH_GLSL`（`bounce`/`rot`）就是
 * angel-echo `scenes.js` 的 `LIB`，早已按同一来源登记在 CREDITS.md 里。
 * 因此**场景体里要写 `fbm6(...)` 而不是上游的 `fbm(...)`**：同一个函数，
 * 换了名字以便与 `shader-def.ts` 的既有定义共用一份。
 *
 * uniform 块**一次声明全套音频调色板**（哪怕某个场景只用其中几个）：
 * 派发是共用的一份（`sceneUniforms`），逐场景裁剪声明就得让派发知道
 * 「这个场景声明了什么」，那才是真的复杂。用不到的 uniform 会被链接器
 * 优化掉，`Program.u()` 对 null location 静默跳过 —— 零成本。
 *
 * `edge()` 是上游的软边框衰减：让画面永远不落在硬边上。
 */
export const SCENE_GLSL =
  FBM6_GLSL +
  MATH_GLSL +
  `
uniform float u_rms;
uniform float u_flux;
uniform float u_sub;
uniform float u_bass;
uniform float u_mid;
uniform float u_high;
uniform float u_air;
uniform float u_centroid;
uniform float u_flat;
uniform float u_travel;
uniform vec4  u_ages;      // 最近四个 onset 的年龄（秒），[0] 最新
uniform float u_kick;      // 每拍的闭式衰减冲量
uniform float u_hit;       // 每个 onset 的闭式衰减冲量
uniform float u_bar;       // 每小节的闭式衰减冲量

uniform float u_density;   // 编排量：画多少东西
uniform float u_warp;      // 编排量：场被推多远
uniform float u_tone;      // 编排量：0 暗 .. 1 亮
uniform float u_cut;       // 编排量：切段冲量（手动打，不再是段落表）
uniform float u_lift;      // 编排量：升八度冲量（手动打）
uniform float u_prog;      // 编排量：段内进度 0..1

float edge(vec2 uv, float k) {
  vec2 d = abs(uv - 0.5) * 2.0;
  return smoothstep(1.0, 1.0 - k, max(d.x, d.y));
}
`;

/**
 * 冲量的衰减时间常数（秒）—— 与 angel-echo 的 `Impulse(decay)` 一致。
 *
 * 上游是 `v *= exp(-dt/decay)` 的**逐帧累加器**；这里是同一根曲线的**闭式**：
 * `exp(-距今多久 / decay)`。数值等价，但 seek 可复现（硬约束 1.1）。
 */
const KICK_DECAY = 0.085;
const HIT_DECAY = 0.075;
const BAR_DECAY = 0.3;

/** 编排量的参数键。它们的**取值与语义**由用户定，不再是硬编码的段落表。 */
export type ArrangementKey = 'density' | 'warp' | 'tone' | 'cut' | 'lift' | 'prog';

const ARRANGEMENT_LABELS: Record<ArrangementKey, MessageKey> = {
  density: 'algo.arr.density',
  warp: 'algo.arr.warp',
  tone: 'algo.arr.tone',
  cut: 'algo.arr.cut',
  lift: 'algo.arr.lift',
  prog: 'algo.arr.prog',
};

/**
 * 造一个编排参数（0..1 range，文案键共用的 `algo.arr.*`）。
 *
 * 上游这些量来自 `plan.js` 的段落表（硬编码的一部片）。artmatic 的模型是
 * **用户自己编排**，所以它们是普通参数 —— 能打关键帧，也能手动扫。
 */
export function arrangementParam(key: ArrangementKey, defaultValue: number): RangeParam {
  return {
    key,
    labelKey: ARRANGEMENT_LABELS[key],
    type: 'range',
    min: 0,
    max: 1,
    step: 0.01,
    defaultValue,
  };
}

/**
 * 派发场景共享的那一套 uniform：音频特征 + 闭式冲量 + 编排参数。
 *
 * 每个场景的 `setUniforms` 都用它（再拼自己的私有个性化参数）。
 * **参数名 → `u_<key>`** 的约定与特效一致，所以编排参数不需要额外代码。
 *
 * `extra` 是**该场景私有的 range 参数键**。走这里而不是各自再写一遍
 * `floats(...)`：共享的那一套必须**每个场景都派发全**（spectrum 那类
 * uniform 漏一个是静默失效），把共用的与私有的分开列，就不会出现
 * 「某个场景自己重写了一遍共享段、却漏了 `u_flux`」。
 */
export function sceneUniforms(extra: readonly string[] = []): AlgoSetUniforms {
  return (gl, l, v, ctx) => {
    const f = ctx.features;
    const set1f = (name: string, value: number): void => {
      const loc = l[name];
      if (loc) gl.uniform1f(loc, value);
    };

    set1f('u_rms', f.rms);
    set1f('u_flux', f.flux);
    set1f('u_sub', f.sub);
    set1f('u_bass', f.bass);
    set1f('u_mid', f.mid);
    set1f('u_high', f.high);
    set1f('u_air', f.air);
    set1f('u_centroid', f.centroid);
    set1f('u_flat', f.flat);
    set1f('u_travel', f.travel);
    const ages = l['u_ages'];
    if (ages) gl.uniform4f(ages, f.ages[0]!, f.ages[1]!, f.ages[2]!, f.ages[3]!);

    // 闭式冲量。kick / bar 由**拍网格**给（JS 侧唯一拿得到 BeatGrid 的地方），
    // hit 由**onset 年龄**给。
    const bpm = ctx.grid.bpm > 0 ? ctx.grid.bpm : 120;
    const secPerBeat = 60 / bpm;
    const beat = beatAtTime(ctx.t, ctx.grid);
    const beatFrac = beat - Math.floor(beat);
    set1f('u_kick', Math.exp((-beatFrac * secPerBeat) / KICK_DECAY));
    const barBeats = Math.max(1, ctx.grid.beatsPerBar);
    const barFrac = ((beat / barBeats) % 1 + 1) % 1;
    set1f('u_bar', Math.exp((-barFrac * barBeats * secPerBeat) / BAR_DECAY));
    set1f('u_hit', Math.exp(-f.ages[0]! / HIT_DECAY));

    floats<AlgoUniformCtx>('density', 'warp', 'tone', 'cut', 'lift', 'prog', ...extra)(gl, l, v, ctx);
  };
}

/* ------------------------------------------------- sim 的状态着色协议 */

/**
 * contain 适配：把输出 UV 映射回源图的 UV。
 *
 * `bake` 的 reveal 与 `sim` 的 tint 都要把「源的比例」放进「整帧的比例」里
 * 居中留边，两处共用同一段 —— 各写一份的话，改了一处另一处会静默错位。
 */
export const FIT_GLSL = `
uniform float u_srcAspect;
uniform float u_outAspect;
vec2 containUv(vec2 uv) {
  vec2 p = uv - 0.5;
  if (u_outAspect > u_srcAspect) p.x *= u_outAspect / u_srcAspect;
  else p.y *= u_srcAspect / u_outAspect;
  return p + 0.5;
}
float insideUv(vec2 uv) {
  vec2 e = step(vec2(0.0), uv) * step(uv, vec2(1.0));
  return e.x * e.y;
}
`;

/**
 * `sim` 型着色的共享头。
 *
 * 默认着色器直接用它的全部内容（下面的 `TINT_FRAG`）；`def.tintFragment`
 * 的自定义着色**只写 `main`**，头由运行时拼在前面 —— 于是多通道模拟
 * （Gray-Scott 的 u/v）不必各自再声明一遍 `u_tex` / contain 适配 / 输出。
 *
 * 放在 `shader-lib.ts` 而不是 `runtime.ts`：它是**协议**（和 `ALGO_HEAD` 同层），
 * 而且 `effects/compile-all.ts` 要靠它预编译每个自定义 tint program ——
 * 放在 runtime 里就得让 compile-all 去 import 整个运行时（拖进 bake-client /
 * glyph-atlas 一大串），而 compile-all 本来就只该认识协议。
 */
export const TINT_HEAD = `#version 300 es
precision highp float;
in vec2 vUv;
out vec4 outColor;
uniform sampler2D u_tex;
uniform vec3 u_colorBg;
uniform vec3 u_colorLive;
/* 由 AlgoRuntime 统一派发（不经 def 的 setTintUniforms）—— 见 bgModeParam()。
   0 = 纯色底 · 1 = 透明底。自定义 tint 直接用这个名字，不要再声明一次。 */
uniform int u_bgMode;
${FIT_GLSL}
`;

/**
 * `sim` 型的默认着色：单通道 R8 状态 + 双色调。
 *
 * **透明底时必须吐「墨色 + 覆盖度」**，不能吐 `mix(底色, 墨色, ink)`：合成链是
 * 直通（非预乘）alpha（`engine/placement.frag.ts`），半覆盖的像素再乘一次 alpha
 * 就等于把底色又画了一遍 —— 边界上会出现一圈深色轮廓。
 */
export const TINT_FRAG = `${TINT_HEAD}
void main() {
  vec2 uv = containUv(vUv);
  float cell = texture(u_tex, clamp(uv, 0.0, 1.0)).r;
  float ink = cell * insideUv(uv);
  if (u_bgMode == 1) outColor = vec4(u_colorLive, ink);
  else outColor = vec4(mix(u_colorBg, u_colorLive, ink), 1.0);
}`;
