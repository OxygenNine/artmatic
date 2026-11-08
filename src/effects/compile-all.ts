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
import type { Kit } from '../engine/kit';

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
 * 编译**一个**特效的全部 program（主 pass + 每一环 pre-pass）。
 * 名字走 `effectProgramName`，与 effects/runner.ts 同源。
 *
 * 拆出单条版本是为了插件：挂载时只该编译**这个插件带来的那几个** def，
 * 而不是把七十多个内置特效再编一遍（重编命中缓存、不重复花钱，但插件加载
 * 会因此多出一次全量遍历的延迟，而它发生在「打开工程」这条路上）。
 */
export function compileEffect(kit: Kit, id: string): CompileResult {
  const entry = getEffect(id);
  if (!entry) return { id, ok: false, error: `注册表里没有 ${id}` };
  try {
    kit.quad(EFFECT_HEAD + entry.shader.fragment, effectProgramName(id));
    const pre = entry.shader.prePasses ?? [];
    for (let i = 0; i < pre.length; i++) {
      kit.quad(EFFECT_HEAD + pre[i]!.fragment, effectProgramName(id, i));
    }
    return { id, ok: true };
  } catch (e) {
    return { id, ok: false, error: message(e) };
  }
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
  const def = getGenerator(id);
  if (!def) return { id, ok: false, error: `注册表里没有 ${id}` };
  // bake 与 recall 都没有自己的着色器（前者共用常量 reveal program，后者根本不算像素）。
  if (def.kind === 'bake' || def.kind === 'recall') return { id, ok: true };
  try {
    if (def.kind === 'gpu-sim') {
      /*
       * `gpu-sim` 的 program 由 def 自己给出（`def.programs()`）—— 粒子是四段、
       * 流体是九段，硬编码某一型就等于「另一种 gpu-sim 完全没有语法守卫」。
       * 名字与引擎同源，所以这里编中的就是运行期那一份。
       * 不做 dropped-uniform 判据：状态纹理的 uniform 由引擎在 step 时派发，
       * 与「参数表 → u_<key>」不是同一条链，套 realtime 的判据会误报。
       */
      for (const p of def.programs?.() ?? []) kit.quad(p.fragment, p.name, p.vertex);
      return { id, ok: true };
    }
    if (def.kind === 'realtime') {
      // 结构由参数决定的 def（`scene-3d`）按**出厂参数**编一份：那是默认画面，
      // 也是 `fragment` 自带的形态。别的槽组合要等到被用到才编。
      const built = def.build?.(defaultValues(def.params));
      const src = ALGO_HEAD + (built?.fragment ?? def.fragment);
      const prog = kit.quad(src, built?.name ?? algoProgramName(id));
      /*
       * 「声明了但**链接器丢掉了**」= shader 从来没读过它。
       *
       * 这是**唯一**能自动抓到「参数拨了没反应」的口子：`Program.uniforms` 是
       * 按 `ACTIVE_UNIFORMS` 建的，没被读的 uniform 会被优化掉、`getUniformLocation`
       * 返回 null、`Program.u()` 静默跳过。伪 GL 的单测看不见（那边的 location
       * 永远是有效的），而它**不报错、不崩、只是滑杆动画面不动** —— 重构
       * `menger` 时 `u_twist` 就这么丢过一次。
       */
      const declared = declaredUniforms(src);
      const dropped = [...declared.keys()].filter((n) => !(n in prog.uniforms));
      return { id, ok: true, dropped };
    }
    if (def.kind === 'sim' && def.tintFragment !== undefined) {
      // ⚠️ 漏掉这一支的后果不是「少编一个 program」，而是**新写的 tint shader
      // 完全没有语法守卫** —— 它在预览里被点到之前不会报任何错。
      kit.quad(TINT_HEAD + def.tintFragment, algoTintProgramName(id));
    }
    return { id, ok: true };
  } catch (e) {
    return { id, ok: false, error: message(e) };
  }
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
