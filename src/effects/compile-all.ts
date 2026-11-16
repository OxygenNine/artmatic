/**
 * compile-all.ts — 把一个渲染上下文里**所有特效与实时算法**的着色器预先编译一遍。
 *
 * 试炼场的「全部编译」按钮用它：artmatic 的着色器是**惰性编译**的
 * （`effects/runner.ts` 首次用到某个 defId 才 `kit.quad(...)`），所以一个
 * 语法错误的 GLSL 在你点到它之前不会报错。批量编译把这类错误提前成一张清单。
 *
 * 为什么不用改 runner / kit 就能做到：`Kit.quad(fs, name)` **按名字缓存**
 * （engine/kit.ts 的 `programs` Map），而 runner 用的名字是 `fx-${defId}`、
 * 实时算法用的是 `algo-${defId}`。这里用**同名**调一次，命中的就是运行期
 * 那一个 program —— 预编译不是"另编一份"，是真的把运行期要用的那份编好。
 *
 * 因此本文件是**纯新增**：生产代码零调用，不引入钩子，回退成本为零。
 * 编译失败时 `new Program` 抛错且不写缓存，所以失败项下次仍会重编，
 * 不存在"坏 program 被缓存住"的污染。
 *
 * 覆盖面：所有特效的主 pass **与 pre-pass** + 所有 `realtime` 算法 + 所有转场
 * + `sim` 型生成器的**自定义着色**（`def.tintFragment`）。
 *
 * 仍未覆盖 —— `bake` / `sim` 共用的 reveal / 默认 tint program。它们在
 * `algos/runtime.ts` 里是常量（`REVEAL_FRAG` / `TINT_FRAG`），与任何 def 无关，
 * 是同一个 program 反复用；自定义 tint 则**每个 def 一份**，所以那一批必须编。
 *
 * ## 转场这一批为什么非编不可
 *
 * 122 条第三方 GLSL，混着按 GLSL ES 1.00 写的、以及声明了规范之外 uniform 的。
 * 我们只做了两条最小改写（见 transitions/glsl.ts），够不够**只能靠编译回答**。
 * 目录层（transitions/catalog.ts）已经把结构性不可能的条目拒掉了，但
 * 「拒得掉的结构问题和编不过的语法问题」是两回事。
 *
 * 代价要知道：122 次编译，本机量级是秒级（重的几条有 voronoi / fbm 循环）。
 * 所以它是按钮与 E2E 的动作，**不在启动路径上**。
 */

import { getEffect, listEffects } from './registry';
import { getGenerator, listGenerators } from '../algos/registry';
import {
  ALGO_HEAD,
  TINT_HEAD,
  algoProgramName,
  algoTintProgramName,
  declaredUniforms,
} from '../algos/shader-lib';
import { listTransitions } from './transitions/registry';
import { defaultValues } from './types';
import { EFFECT_HEAD, effectProgramName } from './shader-def';
import { compileTrackerPrograms } from '../engine/box-tracker';
import { VERT_QUAD, type Kit, type Program } from '../engine/kit';

export interface CompileResult {
  id: string;
  ok: boolean;
  error?: string;
  /**
   * 编译成功时：**声明了但被链接器丢掉**的 uniform 名 —— 也就是 shader
   * 从来没读过它们。非空即「这个参数拨了没反应」。见下面 realtime 分支的注释。
   */
  dropped?: string[];
}

function message(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/**
 * 一个 def 要编的**全部** program。
 *
 * 同步（按钮 / 缩略图 / E2E，一次调用里必须给出结果）与异步（插件后台校验）
 * 两条路共用这一份描述 —— 分开写就会出现「按钮说没问题、挂载时说编不过」。
 */
interface ProgramSpec {
  name: string;
  fragment: string;
  vertex?: string;
}

/** 特效的全部 program（主 pass + 每一环 pre-pass）。`null` = 注册表里没有。 */
function effectSpecs(id: string): ProgramSpec[] | null {
  const entry = getEffect(id);
  if (!entry) return null;
  const specs: ProgramSpec[] = [
    { name: effectProgramName(id), fragment: EFFECT_HEAD + entry.shader.fragment },
  ];
  const pre = entry.shader.prePasses ?? [];
  for (let i = 0; i < pre.length; i++) {
    specs.push({ name: effectProgramName(id, i), fragment: EFFECT_HEAD + pre[i]!.fragment });
  }
  return specs;
}

/**
 * 算法的着色器。`realtimeSrc` 是「算 dropped-uniform 用的那份源码」——
 * 只有 realtime 型有这个判据（见下面 realtime 分支）。
 */
function algoSpecs(id: string): { specs: ProgramSpec[]; realtimeSrc: string | null } | null {
  const def = getGenerator(id);
  if (!def) return null;
  // bake 与 recall 都没有自己的着色器（前者共用常量 reveal program，后者根本不算像素）。
  if (def.kind === 'bake' || def.kind === 'recall') return { specs: [], realtimeSrc: null };
  if (def.kind === 'gpu-sim') {
    /*
     * `gpu-sim` 的 program 由 def 自己给出（`def.programs()`）—— 粒子是四段、
     * 流体是九段，硬编码某一型就等于「另一种 gpu-sim 完全没有语法守卫」。
     * 名字与引擎同源，所以这里编中的就是运行期那一份。
     * 不做 dropped-uniform 判据：状态纹理的 uniform 由引擎在 step 时派发，
     * 与「参数表 → u_<key>」不是同一条链，套 realtime 的判据会误报。
     */
    const specs = (def.programs?.() ?? []).map((p) => ({
      name: p.name,
      fragment: p.fragment,
      vertex: p.vertex,
    }));
    return { specs, realtimeSrc: null };
  }
  if (def.kind === 'realtime') {
    // 结构由参数决定的 def（`scene-3d`）按**出厂参数**编一份：那是默认画面，
    // 也是 `fragment` 自带的形态。别的槽组合要等到被用到才编。
    const built = def.build?.(defaultValues(def.params));
    const src = ALGO_HEAD + (built?.fragment ?? def.fragment);
    return {
      specs: [{ name: built?.name ?? algoProgramName(id), fragment: src }],
      realtimeSrc: src,
    };
  }
  if (def.kind === 'sim' && def.tintFragment !== undefined) {
    // ⚠️ 漏掉这一支的后果不是「少编一个 program」，而是**新写的 tint shader
    // 完全没有语法守卫** —— 它在预览里被点到之前不会报任何错。
    return {
      specs: [{ name: algoTintProgramName(id), fragment: TINT_HEAD + def.tintFragment }],
      realtimeSrc: null,
    };
  }
  return { specs: [], realtimeSrc: null };
}

/** 「声明了但被链接器丢掉」= shader 从来没读过它。只有 realtime 型用它。 */
function droppedUniforms(src: string, prog: Program): string[] {
  const declared = declaredUniforms(src);
  return [...declared.keys()].filter((n) => !(n in prog.uniforms));
}

/** 把失败收成一条结果：异步路径没有构造期异常，错误只能从 program 上读回来。 */
function failure(id: string, prog: Program | undefined): CompileResult {
  if (!prog) return { id, ok: false, error: 'link failed' };
  return { id, ok: false, error: prog.linkError || `link ${prog.name}` };
}

/**
 * 编译**一个**特效的全部 program（主 pass + 每一环 pre-pass）。
 * 名字走 `effectProgramName`，与 effects/runner.ts 同源。
 *
 * 拆出单条版本是为了插件：挂载时只该编译**这个插件带来的那几个** def，
 * 而不是把七十多个内置特效再编一遍（重编命中缓存、不重复花钱，但插件加载
 * 会因此多出一次全量遍历的延迟，而它发生在「打开工程」这条路上）。
 */
export function compileEffect(kit: Kit, id: string): CompileResult {
  const specs = effectSpecs(id);
  if (!specs) return { id, ok: false, error: `注册表里没有 ${id}` };
  try {
    for (const s of specs) {
      const p = kit.quad(s.fragment, s.name, s.vertex ?? VERT_QUAD);
      /*
       * 缓存里可能躺着一份**异步路径编坏的** program（`quad` 按名字缓存，
       * 异步那边是先入缓存再链接的）。不查 `failed` 的话，按钮会对一条坏
       * shader 报「通过」，而挂载时又把它剔掉 —— 正是「两处各说一套」。
       */
      if (p.failed) return failure(id, p);
    }
    return { id, ok: true };
  } catch (e) {
    return { id, ok: false, error: message(e) };
  }
}

/**
 * `compileEffect` 的**异步**版本：链接交给驱动线程，主线程只轮询。
 *
 * 为什么非要有它：一个插件里的 SDF 生成器在 D3D11 上同步链接实测 4–7 s，
 * 五个插件就是三十秒 —— 而那条路原来整段压在「打开工程」的同步栈上，
 * 表现是整个浏览器冻住、和「无响应」分不出来。异步之后这三十秒还在
 * （编译是必须做的），但不再挡任何人。
 *
 * 命中的仍是运行期那一份 program（同名 ⇒ `Kit.quad` 的同一份缓存），
 * 所以校验完就等于把它预热好了，不是「另编一份看看」。
 */
export async function compileEffectAsync(kit: Kit, id: string): Promise<CompileResult> {
  const specs = effectSpecs(id);
  if (!specs) return { id, ok: false, error: `注册表里没有 ${id}` };
  let progs: Program[];
  try {
    progs = specs.map((s) => kit.quad(s.fragment, s.name, s.vertex ?? VERT_QUAD, { async: true }));
  } catch (e) {
    /*
     * **语法错误在这里抛**（`kit.ts::compile` 查完 COMPILE_STATUS 就 throw），
     * 而不是在链接完成时。异步路径的调用方（后台校验）不接这一手的话，
     * 异常会穿到队列的 catch 里，那条记录永远停在「待校验」。
     */
    return { id, ok: false, error: message(e) };
  }
  await kit.whenReady(progs);
  const bad = progs.find((p) => p.failed);
  return bad ? failure(id, bad) : { id, ok: true };
}

/** 全部已注册特效（含插件）。试炼场的「全部编译」用它。 */
export function compileAllEffects(kit: Kit): CompileResult[] {
  return listEffects().map(({ id }) => compileEffect(kit, id));
}

/**
 * 编译**一个**算法的着色器：`realtime` 的主 fragment / `sim` 的自定义着色。
 * 名字与 `algos/runtime.ts` 同源（同一个 `Kit.quad` 具名缓存）。
 *
 * `bake` 型直接返回成功 —— 它没有着色器（共用常量的 reveal program）。
 */
export function compileAlgoShader(kit: Kit, id: string): CompileResult {
  const plan = algoSpecs(id);
  if (!plan) return { id, ok: false, error: `注册表里没有 ${id}` };
  try {
    const progs = plan.specs.map((s) => kit.quad(s.fragment, s.name, s.vertex ?? VERT_QUAD));
    // 同 `compileEffect`：缓存里可能是异步路径编坏的那一份。
    const bad = progs.find((p) => p.failed);
    if (bad) return failure(id, bad);
    /*
     * 「声明了但**链接器丢掉了**」= shader 从来没读过它。
     *
     * 这是**唯一**能自动抓到「参数拨了没反应」的口子：`Program.uniforms` 是
     * 按 `ACTIVE_UNIFORMS` 建的，没被读的 uniform 会被优化掉、`getUniformLocation`
     * 返回 null、`Program.u()` 静默跳过。伪 GL 的单测看不见（那边的 location
     * 永远是有效的），而它**不报错、不崩、只是滑杆动画面不动** —— 重构
     * `menger` 时 `u_twist` 就这么丢过一次。
     */
    const dropped = plan.realtimeSrc ? droppedUniforms(plan.realtimeSrc, progs[0]!) : null;
    return dropped ? { id, ok: true, dropped } : { id, ok: true };
  } catch (e) {
    return { id, ok: false, error: message(e) };
  }
}

/** `compileAlgoShader` 的异步版本（理由同 `compileEffectAsync`）。 */
export async function compileAlgoShaderAsync(kit: Kit, id: string): Promise<CompileResult> {
  const plan = algoSpecs(id);
  if (!plan) return { id, ok: false, error: `注册表里没有 ${id}` };
  if (plan.specs.length === 0) return { id, ok: true };
  let progs: Program[];
  try {
    progs = plan.specs.map((s) => kit.quad(s.fragment, s.name, s.vertex ?? VERT_QUAD, { async: true }));
  } catch (e) {
    // 同 `compileEffectAsync`：语法错误是**抛**出来的，不是链接完成时才失败。
    return { id, ok: false, error: message(e) };
  }
  await kit.whenReady(progs);
  const bad = progs.find((p) => p.failed);
  if (bad) return failure(id, bad);
  const dropped = plan.realtimeSrc ? droppedUniforms(plan.realtimeSrc, progs[0]!) : null;
  return dropped ? { id, ok: true, dropped } : { id, ok: true };
}

/** 全部已注册算法（含插件）的着色器。 */
export function compileAllAlgoShaders(kit: Kit): CompileResult[] {
  return listGenerators()
    .filter((g) => g.kind === 'realtime' || g.kind === 'sim' || g.kind === 'gpu-sim')
    .map((g) => compileAlgoShader(kit, g.id));
}

export interface CompileAllOutcome {
  results: CompileResult[];
  okCount: number;
  total: number;
}

/**
 * 编译全部转场。名字与 `transitions/runner.ts` 的 `tr-${id}` 一致，
 * 所以命中的就是运行期那一份 program（预编译不是"另编一份"）。
 */
export function compileAllTransitions(kit: Kit): CompileResult[] {
  return listTransitions().map((entry) => {
    try {
      kit.quad(entry.fragment, `tr-${entry.id}`);
      return { id: entry.id, ok: true };
    } catch (e) {
      return { id: entry.id, ok: false, error: message(e) };
    }
  });
}

export function compileAll(kit: Kit): CompileAllOutcome {
  const results = [
    ...compileAllEffects(kit),
    ...compileAllAlgoShaders(kit),
    ...compileAllTransitions(kit),
    /*
     * 追踪服务自己的探针 program。它不在任何 def 的 fragment / prePasses 里
     * （由 runner 之外的服务编译），所以不显式加进来就完全没有语法守卫 ——
     * 而它的失败形态是「方框不动 / 画面不叠」，不报错。
     */
    compileTrackerPrograms(kit),
  ];
  return {
    results,
    okCount: results.filter((r) => r.ok).length,
    total: results.length,
  };
}
