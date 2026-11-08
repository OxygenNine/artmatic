import { describe, expect, test } from 'vitest';
import { getGenerator, listGenerators } from '../../src/algos/registry';
import { ALGO_HEAD, BG_MODES } from '../../src/algos/shader-lib';
import { emptyFeatures } from '../../src/algos/feature-source';
import { makeStubGl, parseUniforms, typeMismatches } from './_uniform-probe';
import type { AlgoUniformCtx } from '../../src/algos/shader-lib';
import type { BakeReveal } from '../../src/algos/types';
import type { SourceClip } from '../../src/core/schema';

/**
 * 生成器接线自检 —— `effect-uniforms.test.ts` 的对应物。
 *
 * 特效那一侧有这份守卫，生成器一侧此前**没有**。而算法生成器同样靠
 * `setUniforms` 手工派发 uniform：把 `u_aspect` 拼成 `u_aspects`、对
 * `uniform int u_variant` 调 `uniform1f`，都会**静默不写**、功能像没做，
 * `compileAll`（lab.spec）只证明编得过，看不见这一类。
 *
 * 两份守卫共用一个伪 GL 骨架（`_uniform-probe.ts`），判据各自不同：
 * 生成器的 head 是 `ALGO_HEAD`，且只有 `realtime` 型有 fragment。
 */

/** `ALGO_HEAD` 自己提供、由 `AlgoRuntime.resolve` 负责写的 uniform。 */
const HEAD_OWNED = new Set(['u_time', 'u_delta', 'u_seed', 'u_resolution', 'u_aspect']);

/**
 * 由 `def.auxTextures` 声明、**运行时绑定**的 sampler。
 *
 * 这些名字在 fragment 里声明，但从来不由 `setUniforms` 写 —— 绑定走
 * `AlgoRuntime.bindAux`（`prog.tex`），所以「声明了却没写」的判据必须放行它们。
 * 漏登记的症状就是这条守卫报错，而它是**对的**：说明要么名字拼错了，
 * 要么 `auxTextures` 里那条声明已经不存在。
 */
const AUX_OWNED = new Set(['u_logo', 'u_logoArt']);

/**
 * **运行期**统一派发、但不属于 `ALGO_HEAD` 的 uniform。
 *
 * `u_bgMode`（透明背景开关）就是这一档：派发点在 `AlgoRuntime.resolve`，全家族
 * 一套口径。它**不能**放进 `ALGO_HEAD` —— 那样二十来个不支持透明的 fragment
 * 也会声明它，而它们从不读 ⇒ 链接器丢掉 ⇒ `compile-all` 的 `dropped` 判据
 * （`lab.spec` 里那条「声明了但没被读过」）会整体变红。
 *
 * 所以各 def 自己声明、运行期统一写，这里也不能算作「漏写」。
 */
const RUNTIME_OWNED = new Set([...HEAD_OWNED, 'u_bgMode', ...AUX_OWNED]);

interface Probe {
  /** fragment **自己**声明的 uniform（不含 head）。 */
  own: Map<string, string>;
  /** 自己声明了、但 head 里已经有了的名字 → 重复声明，直接编译失败。 */
  headClashes: string[];
  written: Map<string, string>;
  undeclared: Set<string>;
}

function probeGenerator(id: string): Probe | null {
  const def = getGenerator(id);
  if (!def || def.kind !== 'realtime') return null;

  const own = parseUniforms(def.fragment);
  const declared = new Map<string, string>([...parseUniforms(ALGO_HEAD), ...own]);
  const { gl, locs, written, undeclared } = makeStubGl(declared, HEAD_OWNED);

  const values: Record<string, number | string> = {};
  for (const p of def.params) values[p.key] = p.defaultValue;

  const ctx = {
    t: 1,
    frame: 30,
    seed: 12345,
    w: 854,
    h: 480,
    fps: 30,
    grid: { bpm: 120, offset: 0, beatsPerBar: 4 },
    clip: {} as SourceClip,
    features: emptyFeatures(),
  } satisfies AlgoUniformCtx;

  def.setUniforms(gl, locs, values, ctx);

  return {
    own,
    headClashes: [...own.keys()].filter((n) => HEAD_OWNED.has(n)),
    written,
    undeclared,
  };
}

const ALL = listGenerators().map((g) => g.id);
const REALTIME = ALL.filter((id) => getGenerator(id)?.kind === 'realtime');

describe('生成器接线自检', () => {
  test('注册表非空（自检本身要有覆盖面）', () => {
    expect(ALL.length).toBeGreaterThan(5);
    expect(REALTIME.length).toBeGreaterThanOrEqual(2);
  });

  // 上游 shader 常在自己的 fragment 里再写一遍 u_time / u_resolution，
  // 而 ALGO_HEAD 已经声明过 —— 照抄就是重复声明，**直接编译失败**。
  test.each(REALTIME)('%s：fragment 没有重复声明 head 里的 uniform', (id) => {
    const probe = probeGenerator(id)!;
    expect(
      probe.headClashes,
      `${id} 与 ALGO_HEAD 重复声明 → 编译失败`,
    ).toEqual([]);
  });

  test.each(REALTIME)('%s：fragment 声明的参数都被 setUniforms 写到', (id) => {
    const probe = probeGenerator(id)!;
    const missed = [...probe.own.keys()].filter(
      (n) => !RUNTIME_OWNED.has(n) && !probe.written.has(n),
    );
    expect(
      missed,
      `${id} 声明了却没写 → 这些 uniform 恒为默认值且不报错`,
    ).toEqual([]);
  });

  test.each(REALTIME)('%s：写 uniform 的类型与声明一致', (id) => {
    const probe = probeGenerator(id)!;
    expect(
      typeMismatches(probe.written, probe.own),
      `${id} 的写入类型与声明不匹配 → GL INVALID_OPERATION 且静默不写`,
    ).toEqual([]);
  });

  test.each(REALTIME)('%s：没有摸到未声明的 uniform', (id) => {
    const probe = probeGenerator(id)!;
    expect([...probe.undeclared], `${id} 摸了不存在的 uniform → 名字拼错了`).toEqual([]);
  });

  test('bgMode 的取值只有 solid / transparent', () => {
    expect(Object.keys(BG_MODES).sort()).toEqual(['solid', 'transparent']);
  });

  // `bgMode` 是**参数**，透明是**着色器里的分支**。两边脱节的形态是
  // 「选了透明，画面一点没变」—— 不报错、也不崩，所以必须有一条结构守卫。
  //
  // 覆盖面分三层：`realtime` 看自己的 fragment；`sim` 的自定义着色看
  // `tintFragment`（`u_bgMode` 的声明在 `TINT_HEAD` 里，但**读不读**在各家）；
  // `bake` 与默认着色的 `sim` 走 `runtime.ts` 里那两份共用 shader（同一段代码
  // 服务十几个生成器，改坏了会一起坏，由 E2E 的像素断言兜住）。
  const withBgMode = ALL.filter((id) =>
    getGenerator(id)!.params.some((p) => p.key === 'bgMode'),
  );

  test('大多数生成器都能透明（覆盖面本身是需求）', () => {
    expect(withBgMode.length).toBeGreaterThanOrEqual(15);
  });

  test.each(withBgMode)('%s：有 bgMode 参数，着色器就必须真的读 u_bgMode', (id) => {
    const def = getGenerator(id)!;
    const src = def.kind === 'realtime' ? def.fragment : def.kind === 'sim' ? def.tintFragment : undefined;
    // bake 与默认着色的 sim 没有自己的 shader：共用 runtime.ts 的 reveal / tint。
    if (src === undefined) return;
    expect(/\bu_bgMode\b/.test(src), `${id} 有 bgMode 参数但 shader 不读它 → 选透明什么都不发生`).toBe(true);
  });

  test.each(withBgMode)('%s：bgMode 的缺省与取值都在共用那一份里', (id) => {
    const p = getGenerator(id)!.params.find((q) => q.key === 'bgMode')!;
    expect(p.type).toBe('select');
    if (p.type !== 'select') return;
    expect(p.options.map((o) => o.value).sort()).toEqual(['solid', 'transparent']);
    // 出厂纯色是这一族的常态；`smoke` 是唯一例外（它的本性就是压在别的东西上）。
    expect(p.defaultValue).toBe(id === 'smoke' ? 'transparent' : 'solid');
  });

  // 每种 reveal 方式都要有人用 —— 否则它没被实战验证过。
  //
  // 注意这条**不是**在查「reveal 值拼错」：`reveal?: BakeReveal` 是类型化的，
  // 拼错在 `svelte-check` 就报了，写一条永远绿的断言反而更坏。它守的是
  // 「三种模式都真的被某个生成器用到」—— 删掉 lsystem 就会红。
  test('三种 reveal 方式都至少被一个生成器用到', () => {
    const effective = ALL.map((id) => {
      const def = getGenerator(id)!;
      return def.kind === 'bake' ? (def.reveal ?? 'front-y') : null;
    }).filter((v): v is BakeReveal => v !== null);
    expect([...new Set(effective)].sort()).toEqual(['front-x', 'front-y', 'value']);
  });
});
