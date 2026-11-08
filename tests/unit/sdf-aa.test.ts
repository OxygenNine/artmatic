/**
 * 3D 抗锯齿的接线守卫。
 *
 * 三种静默失效都在这里挡：
 * - 某个生成器忘了拼 `SDF_AA_MAIN` ⇒ 它还是原来的 main，aa 拨了没反应；
 * - `sdfSample` 里读 `vUv` 而不是 `sdfUv` ⇒ 所有子采样渲染同一个点，画面完全不变；
 * - `u_aa` 声明了但 main 没读 ⇒ 链接器丢掉（真 GL 那条在 `lab.spec`，这里用
 *   「出现次数 > 1」做毫秒级前置）。
 */

import { describe, expect, it } from 'vitest';
import { getGenerator, listGenerators } from '../../src/algos/registry';
import { ALGO_HEAD, declaredUniforms, type AlgoUniformCtx } from '../../src/algos/shader-lib';
import {
  MAX_AA_SAMPLES,
  SDF_AA_LEVELS,
  SDF_AA_MAIN,
  sdfQualityParams,
  sdfQualityUniforms,
} from '../../src/algos/sdf-lib';
import { previewRecipe } from '../../src/algos/catalog';

/** 判据从源码推：`sdfMarch` / `sdfMarchMat` 是共享内核给全族的唯一步进函数。 */
const SDF = listGenerators()
  .map((g) => getGenerator(g.id)!)
  .filter(
    (d) =>
      d.kind === 'realtime' &&
      /sdfMarch\(|sdfMarchMat\(/.test((d as { fragment: string }).fragment),
  );

/** 新增用内核的生成器会自动进下面每一条 `it.each`，不用在这里登记。 */
const IDS = SDF.map((d) => d.id).sort();

/** 但已接入的那批不许被悄悄摘掉 —— 否则覆盖面会一边缩小一边全绿。 */
const REQUIRED = [
  'apollonian',
  'extrude-material',
  'horizon',
  'mandelbulb',
  'menger',
  'scene-3d',
  'tunnel-3d',
];

const fragOf = (id: string): string => (getGenerator(id) as { fragment: string }).fragment;

/** 去掉注释再数 `sdfSample()`：注释里提到它不算调用点。 */
const callsOf = (src: string): string[] =>
  (src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '').match(/sdfSample\s*\(\s*\)/g) ??
    []);

/** 只跑 `sdfQualityUniforms`，记下它写到 `u_aa` 的整数值。 */
function writeAA(aa: string): number | undefined {
  let got: number | undefined;
  const locs = new Proxy({} as Record<string, WebGLUniformLocation | null>, {
    get: (_t, p) =>
      typeof p === 'string' ? ({ name: p } as unknown as WebGLUniformLocation) : null,
  });
  const gl = {
    uniform1i: (loc: unknown, v: number) => {
      if ((loc as { name?: string })?.name === 'u_aa') got = v;
    },
    uniform1f: () => {},
  } as unknown as WebGL2RenderingContext;
  sdfQualityUniforms()(gl, locs, { aa }, {} as AlgoUniformCtx);
  return got;
}

describe('3D 抗锯齿', () => {
  it('覆盖面从源码推，已接入的 7 个一个都没丢', () => {
    expect(REQUIRED.filter((id) => !IDS.includes(id))).toEqual([]);
    expect(IDS.length).toBeGreaterThanOrEqual(REQUIRED.length);
  });

  it.each(IDS)('%s：aa 参数与 sdfQualityParams 那一份完全同源', (id) => {
    const p = getGenerator(id)!.params.find((q) => q.key === 'aa');
    expect(p, `${id} 没有 aa 参数`).toBeDefined();
    expect(p).toEqual(sdfQualityParams().find((q) => q.key === 'aa'));
  });

  it.each(IDS)('%s：共享 main 只拼一次，且在 sdfSample 定义之后', (id) => {
    const frag = fragOf(id);
    const sample = frag.indexOf('vec4 sdfSample()');
    const main = frag.indexOf(SDF_AA_MAIN);
    expect(sample, `${id} 没有定义 sdfSample`).toBeGreaterThan(-1);
    expect(main, `${id} 没有拼 SDF_AA_MAIN`).toBeGreaterThan(sample);
    expect(frag.indexOf(SDF_AA_MAIN)).toBe(frag.lastIndexOf(SDF_AA_MAIN));
    expect(frag.match(/void main\(\)/g) ?? []).toHaveLength(1);
  });

  it.each(IDS)('%s：射线读 sdfUv，不读 vUv', (id) => {
    // 共享 main 之前是内核 + 几何 + 相机 + sdfSample；屏幕空间效果留在 vUv 是
    // 允许的（扫描线），但射线与相机基绝不能落在 vUv 上。
    const body = fragOf(id).slice(0, fragOf(id).indexOf(SDF_AA_MAIN));
    expect(body).toContain('sdfUv');
    expect(body, `${id} 的射线还在读 vUv → 所有子采样会渲染同一个点`).not.toMatch(
      /sdfRay\(vUv|\(vUv\s*-\s*0\.5\)/,
    );
  });

  it.each(IDS)('%s：u_aa 声明为 int 且被 main 真的读到', (id) => {
    const frag = fragOf(id);
    expect(declaredUniforms(ALGO_HEAD + frag).get('u_aa')).toBe('int');
    expect((frag.match(/\bu_aa\b/g) ?? []).length, `${id}: u_aa 只被声明，没被读`).toBeGreaterThan(1);
  });

  it('选项值、映射表、编译期上界三者一致，关闭档是 1', () => {
    const p = sdfQualityParams().find((q) => q.key === 'aa')!;
    if (p.type !== 'select') throw new Error('aa 不是 select');
    expect(p.options.map((o) => o.value).sort()).toEqual(Object.keys(SDF_AA_LEVELS).sort());
    for (const v of Object.values(SDF_AA_LEVELS)) {
      expect(v).toBeGreaterThanOrEqual(1);
      expect(v).toBeLessThanOrEqual(MAX_AA_SAMPLES);
    }
    expect(SDF_AA_LEVELS.off).toBe(1);
    expect(p.defaultValue).toBe('x2');
    // 上界是运行期值（n*n）：循环因此不被展开，编译时间不随 n 翻倍。
    expect(SDF_AA_MAIN).toContain('int total = n * n');
    expect(SDF_AA_MAIN).toContain('k < total');
  });

  it('共享 main 里 sdfSample 只有一个调用点', () => {
    // 编译时间 ≈ SDF 体积 × 调用点数：隧道 1 个点 4.7 s、2 个点 44.7 s。
    // 这条是「加载时卡死」唯一的回归守卫。
    expect(callsOf(SDF_AA_MAIN)).toHaveLength(1);
  });

  it.each(IDS)('%s：整份 fragment 里 sdfSample 只有一个调用点', (id) => {
    // 定义 1 次 + 调用 1 次。多出来的每一次都会让编译器再内联一遍整份 SDF。
    expect(callsOf(fragOf(id))).toHaveLength(2);
  });

  it.each(Object.entries(SDF_AA_LEVELS))('aa=%s 派发出 u_aa=%i', (key, want) => {
    expect(writeAA(key)).toBe(want);
  });

  it('未知取值退回缺省档，不是静默变 0（关闭）', () => {
    expect(writeAA('bogus')).toBe(SDF_AA_LEVELS.x2);
    expect(writeAA('')).toBe(SDF_AA_LEVELS.x2);
  });

  it('共享 main 不含抖动源，也不含任何导数', () => {
    expect(SDF_AA_MAIN).not.toMatch(/gl_FragCoord|u_time|u_seed|fract\(sin/);
    // 导数在采样循环里取不到值（ANGLE/D3D 实测恒为 0），取到循环外又必须多一个
    // `sdfSample()` 调用点（编译时间 ×5.6）。所以这一份 main 里一个都没有。
    expect(SDF_AA_MAIN).not.toMatch(/dFdx|dFdy|fwidth/);
    expect(SDF_AA_MAIN).toMatch(/clamp\(u_aa/);
  });

  it.each(IDS)('%s：缩略图显式关掉子采样', (id) => {
    expect(
      previewRecipe(id)!.params.aa,
      `${id} 的目录条目必须用 rt3d()（或显式写 aa: 'off'），新增 3D 生成器别漏`,
    ).toBe('off');
  });
});
