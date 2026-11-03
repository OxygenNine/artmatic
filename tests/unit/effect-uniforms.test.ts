import { describe, expect, test } from 'vitest';
import { getEffect, listEffects } from '../../src/effects/registry';
import { EFFECT_HEAD } from '../../src/effects/shader-def';
import { makeStubGl, parseUniforms, typeMismatches } from './_uniform-probe';
import type { EffectClip } from '../../src/core/schema';
import type { EffectUniformCtx } from '../../src/effects/shader-def';

/**
 * 特效接线自检：每个 pass（主 pass + 每一环 pre-pass）的 uniform，**名字与类型**
 * 都要与它实际编译出来的源码对上。
 *
 * 起因是一次真实的静默失效（2026-10-03）：
 * `clockUniforms()` 用 `gl.uniform1i` 去写 `u_sync`，而 8 个 clock 特效的 fragment
 * 都声明成 `uniform float u_sync;`。对 float uniform 调 `uniform1i` 会触发 GL
 * `INVALID_OPERATION` 并且**不写入** —— uniform 保持 0，于是「按拍对齐」永远退回
 * `t * speed`，**没有任何报错**，看起来像功能没做。
 *
 * `compileAll`（lab.spec）只证明 shader **编得过**，这类「写 uniform 的类型不匹配」
 * 它看不见。这份测试用伪 gl 跑一遍 `setUniforms`，纯静态、不需要 GL 上下文。
 *
 * 它守的是**协议层**（`shader-def.ts` 那套 setter 助手 + runner 的派发约定），
 * 不是「某个特效好不好看」。
 */

/**
 * head 自己提供的 uniform：runner 负责写、`setUniforms` 不该碰。
 *
 * 其中 `u_feedback` 是**条件提供**的（要 `feedback: true`），`u_original` 在
 * pre-pass 里指向**链输入**而不是上一环的输出 —— 见 runner.ts。
 */
const HEAD_OWNED = new Set([
  'u_texture',
  'u_feedback',
  'u_original',
  // 外部蒙版：sampler 与开关都由 runner 绑（`shader.mask` 决定绑真图还是 1×1 全白）。
  'u_mask',
  'u_maskOn',
  'u_time',
  'u_delta',
  'u_seed',
  'u_resolution',
]);

/**
 * runner 在 head 之外**还**负责绑定的 sampler：`setUniforms` 不碰它们。
 *
 * `u_spectrum` 由 `engine/spectrum-texture.ts` 的 `bindTo` 每帧绑上
 * （每实例一张纹理），所以「声明了就必须被 setUniforms 写到」这条对它不适用。
 */
const RUNNER_BOUND = new Set(['u_spectrum']);

/**
 * 追踪服务（`engine/box-tracker.ts::bind`）负责写的 uniform。
 *
 * 与 `RUNNER_BOUND` 分开列：那边是 runner 在**同一处**绑的，这边是另一个服务
 * 在 `bind()` 里写的（叠层纹理 + 方框数组）。混在一起会让「谁负责派发」变得
 * 不可读。`u_boxA[12]` 是数组声明，`declaredUniforms` 的正则不匹配数组，
 * 列在这里是为了「将来正则改了也不会误报」。
 */
const TRACKER_BOUND = new Set(['u_overlay', 'u_boxCount', 'u_boxA']);

/**
 * 字形图集服务（`engine/glyph-atlas.ts::bindTo`）负责写的 uniform。
 *
 * 与 `TRACKER_BOUND` 同样单列：字形数是**图集的属性**（图集按覆盖率排过序），
 * `setUniforms` 拿不到它，所以不能要求它被 setUniforms 写到。
 */
const GLYPH_BOUND = new Set(['u_atlas', 'u_glyphCount', 'u_glyphCols']);

/**
 * 调色服务负责的 sampler（`engine/curve-texture.ts` / `engine/lut-texture.ts`）。
 *
 * 与 `GLYPH_BOUND` 同样单列：表的内容由服务按参数算出来，`setUniforms` 拿不到
 * （它只收标量）。`u_lutOn` / `u_lutSize` 也归服务 —— 「有没有表」是服务的状态，
 * 不是参数。
 */
const CURVE_BOUND = new Set(['u_curve']);
const LUT_BOUND = new Set(['u_lut', 'u_lutOn', 'u_lutSize']);

/**
 * runner **能**绑定的 sampler。声明了别的就没人给它绑 —— 采样会读回未绑定纹理
 * （黑/垃圾），而 GL 自己不会说话。
 */
const BINDABLE_SAMPLERS = new Set([
  'u_texture',
  'u_original',
  'u_feedback',
  'u_mask',
  ...RUNNER_BOUND,
  ...GLYPH_BOUND,
  ...CURVE_BOUND,
  ...LUT_BOUND,
  'u_overlay',
  'u_atlas',
]);

interface PassProbe {
  /** `main` 或 `pre0` / `pre1` … */
  kind: string;
  /** 这一 pass 的 fragment **自己**声明的 uniform（不含 head）。 */
  own: Map<string, string>;
  /** 自己声明了、但 head 里已经有了的名字 → 重复声明，直接编译失败。 */
  headClashes: string[];
}

interface Probe {
  passes: PassProbe[];
  /** 实际被写过的 uniform → 写入函数名（同一份 setUniforms 会跑在每个 pass 上）。 */
  written: Map<string, string>;
  /** 被 setUniforms 摸到、但既没声明也不是 head 提供的名字（拼错就是这样）。 */
  undeclared: Set<string>;
  /** fragment 有没有**用到** `u_feedback`（决定 runner 要不要绑它）。 */
  usesFeedback: boolean;
  /** 有没有声明 `feedback: true`。 */
  declaresFeedback: boolean;
}

function probeEffect(defId: string): Probe {
  const entry = getEffect(defId);
  if (!entry) throw new Error(`注册表里没有 ${defId}`);

  // 每个 pass 单独看。**必须按「fragment 单独」解析一次**：head 里已经声明过的
  // 名字若在 fragment 里再写一遍就是重复声明（编译失败），只解析 head+fragment
  // 会把这个信号吞掉。
  const passFragments: { kind: string; src: string }[] = [
    { kind: 'main', src: entry.shader.fragment },
    ...(entry.shader.prePasses ?? []).map((pp, i) => ({ kind: `pre${i}`, src: pp.fragment })),
  ];
  const passes: PassProbe[] = passFragments.map(({ kind, src }) => {
    const own = parseUniforms(src);
    return { kind, own, headClashes: [...own.keys()].filter((n) => HEAD_OWNED.has(n)) };
  });

  // 供 setter 查找名字用的「全部声明过的东西」= head + 所有 pass 自己声明的。
  const declared = new Map<string, string>([...parseUniforms(EFFECT_HEAD)]);
  for (const p of passes) for (const [n, t] of p.own) declared.set(n, t);

  const { gl, locs, written, undeclared } = makeStubGl(declared, HEAD_OWNED);

  const values: Record<string, number | string> = {};
  for (const p of entry.params) values[p.key] = p.defaultValue;

  const ctx = {
    t: 1,
    frame: 30,
    seed: 0.5,
    w: 960,
    h: 540,
    fps: 30,
    grid: { bpm: 120, offset: 0, beatsPerBar: 4 },
    clip: {} as EffectClip,
  } satisfies EffectUniformCtx;

  entry.shader.setUniforms(gl, locs, values, ctx);

  return {
    passes,
    written,
    undeclared,
    usesFeedback: /\bu_feedback\b/.test(entry.shader.fragment),
    declaresFeedback: entry.shader.feedback === true,
  };
}

const EFFECTS = listEffects().map((e) => e.id);
/** 展开成「特效 × pass」的用例表。 */
const PASS_CASES = EFFECTS.flatMap((id) =>
  probeEffect(id).passes.map((p) => [`${id}/${p.kind}`, id, p.kind] as const),
);

describe('特效接线自检', () => {
  test('注册表非空（自检本身要有覆盖面）', () => {
    expect(EFFECTS.length).toBeGreaterThan(20);
  });

  test.each(EFFECTS)('%s：runner 该跑 setUniforms 的每个 pass 都被检查到', (id) => {
    const { passes } = probeEffect(id);
    expect(passes.length).toBeGreaterThanOrEqual(1);
  });

  // 上游 shader 常在自己的 fragment 里再写一遍 u_texture / u_time / u_resolution，
  // 而 Artmatic 的 EFFECT_HEAD 已经声明过 —— 照抄就是重复声明，**直接编译失败**。
  // 移植 51 个特效时这条重复声明出现了 8 次，所以固化成断言。
  test.each(EFFECTS)('%s：没有 pass 重复声明 head 里的 uniform', (id) => {
    const { passes } = probeEffect(id);
    const bad = passes.flatMap((p) => p.headClashes.map((n) => `${p.kind} 里又声明了 ${n}`));
    expect(bad, `${id} 与 EFFECT_HEAD 重复声明 → 编译失败`).toEqual([]);
  });

  // runner 对**每个 pass** 都调用 setUniforms（pre-pass 里用特效参数是上游的用法：
  // glow 的 u_cutoff/u_radius、blur 的 u_radius、ghosting 的 u_bias/u_scale、
  // fast-mosh 的 u_hold、motion-mask 的 u_persistence/u_erode/u_blur）。
  // 因此每个 pass 自己声明的参数都应当被写到。
  test.each(PASS_CASES)('%s：这一 pass 声明的参数都被 setUniforms 写到', (_label, id, kind) => {
    const { passes, written } = probeEffect(id);
    const p = passes.find((x) => x.kind === kind)!;
    const missed = [...p.own.keys()].filter(
      (n) =>
        !HEAD_OWNED.has(n) &&
        !RUNNER_BOUND.has(n) &&
        !TRACKER_BOUND.has(n) &&
        !GLYPH_BOUND.has(n) &&
        !CURVE_BOUND.has(n) &&
        !LUT_BOUND.has(n) &&
        !written.has(n),
    );
    expect(missed, `${id} 的 ${kind} 声明了却没写 → 这些 uniform 恒为默认值且不报错`).toEqual([]);
  });

  test.each(EFFECTS)('%s：写 uniform 的类型与声明一致', (id) => {
    const { passes, written } = probeEffect(id);
    const typeOf = new Map<string, string>();
    for (const p of passes) for (const [n, t] of p.own) typeOf.set(n, t);
    expect(
      typeMismatches(written, typeOf),
      `${id} 的写入类型与声明不匹配 → GL INVALID_OPERATION 且静默不写`,
    ).toEqual([]);
  });

  test.each(EFFECTS)('%s：没有摸到未声明的 uniform', (id) => {
    const { undeclared } = probeEffect(id);
    expect([...undeclared], `${id} 摸了不存在的 uniform → 名字拼错了`).toEqual([]);
  });

  // openmosh 是「fragment 里用了 u_feedback 就自动分配历史」，Artmatic 要**显式**
  // `feedback: true`。漏写的表现是：sampler 没人绑，`texture(u_feedback, ...)`
  // 读回未绑定纹理 —— 画面看着像「没有拖尾」，不报错。
  //
  // 判据必须是「fragment **用到**了 u_feedback」而不是「声明了」：head 无条件声明
  // 它，按声明判定会变成一条永远为真的假断言（初版就是这么错的）。
  test.each(EFFECTS)('%s：用到 u_feedback 就必须带 feedback: true', (id) => {
    const { usesFeedback, declaresFeedback } = probeEffect(id);
    if (!usesFeedback) return;
    expect(declaresFeedback, `${id} 用了 u_feedback 但没写 feedback: true → sampler 不会绑定`).toBe(
      true,
    );
  });

  test.each(EFFECTS)('%s：声明的 sampler 都是 runner 能绑的', (id) => {
    const { passes } = probeEffect(id);
    const samplers = passes.flatMap((p) =>
      [...p.own.entries()].filter(([, t]) => t === 'sampler2D').map(([n]) => n),
    );
    expect(
      samplers.filter((n) => !BINDABLE_SAMPLERS.has(n)),
      `${id} 声明了 runner 绑不了的 sampler → 采样会读回未绑定纹理`,
    ).toEqual([]);
  });
});
