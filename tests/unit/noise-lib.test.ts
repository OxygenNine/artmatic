import { describe, expect, it } from 'vitest';
import {
  NOISE_BODY_GLSL,
  NOISE_FAMILIES,
  NOISE_GLSL,
  NOISE_SPACES,
  NOISE_VORONOI,
  NZ_MAX_OCTAVES,
} from '../../src/algos/noise-lib';
import { noiseFieldDef } from '../../src/algos/noise-field';
import { smokeDef } from '../../src/algos/smoke';
import { getGenerator, listGenerators } from '../../src/algos/registry';
import type { GeneratorDef } from '../../src/algos/types';

/**
 * 噪声库与「噪声」生成器的结构守卫。
 *
 * 这一层能纯测的只有**形状**：噪声本身在 GPU 上，像素级判据在
 * `tests/e2e/algo-noise.spec.ts`。但形状错了全是静默失效 ——
 * 少一个族的 3D 入口、hash 库重复拼接、select 的值没进映射表，
 * 表现出来都只是「某个选项不好看」，而不是报错。
 */

/** 某个字符串里 `name(` 作为**函数定义**出现了几次（返回类型 float / vec2 / vec3 都算）。 */
function definitionCount(src: string, name: string): number {
  return [...src.matchAll(new RegExp(`(?:float|vec[234])\\s+${name}\\s*\\(`, 'g'))].length;
}

/** `GeneratorDef` 是联合类型，`fragment` 只在 realtime 那一支上。 */
function fragmentOf(def: GeneratorDef): string {
  if (def.kind !== 'realtime') throw new Error(`${def.id} 不是 realtime`);
  return def.fragment;
}

describe('噪声库：三族 × 两个维度都真的有入口', () => {
  const fns = [
    'nzValue2',
    'nzValue3',
    'nzGrad2',
    'nzGrad3',
    'nzVoronoi2',
    'nzVoronoi3',
    'nzSample2',
    'nzSample3',
    'nzFbm2',
    'nzFbm3',
    'nzWarp2',
    'nzWarp3',
  ];

  it.each(fns)('%s 有且只有一个定义', (name) => {
    // 定义数量为 0 = 某个族/维度根本没写；>1 = 两个库拼在一起了（编译失败）
    expect(definitionCount(NOISE_BODY_GLSL, name), name).toBe(1);
  });

  it('库是「hash + 函数体」两层，且 body 自己不重复拼 hash', () => {
    // hash 只在组合结果里出现一次
    expect(definitionCount(NOISE_GLSL, 'hash21')).toBe(1);
    expect(definitionCount(NOISE_GLSL, 'hash31')).toBe(1);
    // body 单独拿出来时必须**没有** hash 定义（否则拼进 NOISE_GLSL 就是两份）
    expect(definitionCount(NOISE_BODY_GLSL, 'hash21')).toBe(0);
    expect(definitionCount(NOISE_BODY_GLSL, 'hash31')).toBe(0);
  });

  it('不用 sin 族 hash（大坐标下低位不稳 ⇒ 帧间闪烁）', () => {
    // HASH_GLSL / HASH_PLAIN_GLSL 的签名是 fract(sin(dot(...)) * 43758.5453)。
    // 这条挡的是「有人图省事换成掺 seed 的那一支」。
    expect(NOISE_GLSL.includes('43758.5453')).toBe(false);
    expect(NOISE_GLSL.includes('12.9898')).toBe(false);
  });

  it('库是纯函数：不读 u_time / u_seed / u_octaves 之外的任何运行时状态', () => {
    // 噪声库只收函数参数。读 uniform 会让「同参数同图」这件事依赖外部状态，
    // 而且 `noise-lib.ts` 就不再有单一签名 —— 复用方没法预测它读什么。
    expect(/uniform\s/.test(NOISE_BODY_GLSL), '噪声库里不该有 uniform 声明').toBe(false);
    expect(NOISE_BODY_GLSL.includes('u_'), '噪声库里不该出现 uniform 名字').toBe(false);
  });
});

describe('噪声场：参数表与映射表必须同源', () => {
  const selectOf = (key: string) => {
    const p = noiseFieldDef.params.find((q) => q.key === key);
    expect(p, `缺参数 ${key}`).toBeDefined();
    expect(p!.type, `${key} 必须是 select`).toBe('select');
    if (p!.type !== 'select') throw new Error('unreachable');
    return p!;
  };

  it.each([
    ['family', NOISE_FAMILIES],
    ['space', NOISE_SPACES],
    ['voronoi', NOISE_VORONOI],
  ])('%s 的选项与映射表逐项对齐（缺一项 = 那个选项静默变成族 0）', (key, map) => {
    const p = selectOf(key);
    expect(p.options.map((o) => o.value).sort()).toEqual(Object.keys(map).sort());
    // 缺省值必须落在映射表里，且映射到 0（selectInt 的 fallback 与它同值，
    // 于是「缺键的老工程」与「出厂默认」是同一张图）
    expect(map[p.defaultValue], `${key} 的缺省值不在映射表里`).toBe(0);
  });

  it('voronoi 的形态只在 voronoi 族下可见（visibleWhen 真的引用了 family）', () => {
    const p = selectOf('voronoi');
    expect(p.visibleWhen, '没有 visibleWhen ⇒ 选 value 时也显示形态').toBeDefined();
    expect(p.visibleWhen!({ family: 'voronoi' })).toBe(true);
    expect(p.visibleWhen!({ family: 'value' })).toBe(false);
  });

  it('阶数的上限不超过 shader 的编译期上界（超了就是「拖到底也没变化」）', () => {
    const p = noiseFieldDef.params.find((q) => q.key === 'octaves')!;
    expect(p.type).toBe('range');
    if (p.type !== 'range') throw new Error('unreachable');
    expect(p.max).toBeLessThanOrEqual(NZ_MAX_OCTAVES);
    // 循环必须是常量界 + break（动态界的循环在部分驱动上会退化）
    expect(NOISE_BODY_GLSL).toContain('i < NZ_MAX_OCTAVES');
    expect(NOISE_BODY_GLSL).toContain('if (i >= octaves) break;');
  });

  it('fbm 是归一化的（阶数只改细节，不改整体亮度）', () => {
    // 少了 sum / norm，「细节层次」会顺手把画面改亮 —— 最难查的一类参数串扰
    expect(NOISE_BODY_GLSL).toContain('return norm > 0.0 ? sum / norm : 0.5;');
    expect(NOISE_BODY_GLSL.split('return norm > 0.0 ? sum / norm : 0.5;').length - 1).toBe(2);
  });

  it('生成器真的用上了 fbm 与域扭曲，并且量都是参数派发的', () => {
    const frag = fragmentOf(noiseFieldDef);
    for (const token of ['nzFbm3(', 'nzWarp2(', 'u_warp', 'u_scale', 'u_evolve']) {
      expect(frag, token).toContain(token);
    }
  });

  it('二维模式也走三维采样 —— 演化靠深度，二维噪声没有这个自由度', () => {
    /*
     * 有人会想「2D 就该用便宜的 nzFbm2」。那样「演化」只能变成平移，而且
     * `u_evolve` 一动整幅画面会换一套噪点（同样的参数突然不是同一张图）。
     * 这条同时守着 E2E 里「t=0 时 2D 与 3D 逐点相同」的判据。
     */
    // 只看**生成器自己那段**：`fragment` 前面拼着整个噪声库，库里当然有 nzFbm2 的定义
    const own = fragmentOf(noiseFieldDef).slice(NOISE_GLSL.length);
    expect(own.includes('nzFbm2('), '二维模式退回二维采样 ⇒ 演化只能是平移').toBe(false);
  });
});

describe('噪声库的复用：不允许再长出第二份私有实现', () => {
  it('smoke 用的是共用库，且不再自带 vnoise3 / fbmS', () => {
    // 这条守的是「提取」这件事本身：把库建好之后又把私有的贴回去，
    // 两边会各自漂（烟雾的 p99.9 阈值就是按这份 fbm 的归一化实测出来的）。
    const frag = fragmentOf(smokeDef);
    expect(frag).toContain('nzFbm3(');
    expect(frag.includes('float vnoise3('), 'smoke 又自带了 vnoise3').toBe(false);
    expect(frag.includes('float fbmS('), 'smoke 又自带了 fbmS').toBe(false);
  });

  it('每个 realtime 生成器最多定义一次 hash11/21/31（重复定义 = 编译失败）', () => {
    // `NOISE_GLSL` 自带 `HASH_FAST_GLSL`。谁把两个常量一起拼进 fragment，
    // 得到的是 `function already has a body`，而着色器是惰性编译的 ——
    // 在有人点到它之前完全不报。
    for (const g of listGenerators()) {
      const def = getGenerator(g.id);
      if (!def || def.kind !== 'realtime') continue;
      for (const name of ['hash11', 'hash21', 'hash31']) {
        expect(definitionCount(def.fragment, name), `${g.id} 重复定义了 ${name}`).toBeLessThanOrEqual(1);
      }
    }
  });
});
