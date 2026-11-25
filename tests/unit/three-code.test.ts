/**
 * three-code.test.ts — 代码契约里那些**纯函数**：参数表归一化与合并。
 *
 * 这一层值得单测的理由：它跑的是**模型写的代码**。`params()` 返回什么形状都有
 * 可能（少 key、type 打错、min > max、选项空、默认值不在选项里），而一个坏参数
 * 不该让整个片段变成空白 —— 归一化的职责就是「逐条丢弃或夹取，剩下的照用」。
 */

import { describe, expect, it } from 'vitest';
import {
  coerceThreeValue,
  compileThreeCode,
  mergeThreeParams,
  normalizeThreeParams,
  readThreeParams,
  threeRebuildSignature,
} from '../../src/three/code';

describe('compileThreeCode', () => {
  it('把 create 与 params 分别摘出来，互不触发', () => {
    const code = `
      function params() { return [{ key: 'a', type: 'range', min: 0, max: 1 }]; }
      function create(THREE, ctx) { return { scene: {}, camera: {}, touched: ctx.width }; }
    `;
    const c = compileThreeCode(code);
    expect(c.ok).toBe(true);
    if (!c.ok) return;
    // readParams 不该执行 create（create 里读 ctx.width 会炸，如果它被调了）
    expect(c.readParams()).toEqual([{ key: 'a', type: 'range', min: 0, max: 1 }]);
    expect(c.run({}, { width: 42 } as never)).toEqual({ scene: {}, camera: {}, touched: 42 });
  });

  it('语法错误给出引擎消息，空代码直接拒', () => {
    const bad = compileThreeCode('function create( {');
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.error).toContain('SyntaxError');
    expect(compileThreeCode('   ').ok).toBe(false);
  });
});

describe('normalizeThreeParams', () => {
  it('区间反了就换过来，默认值夹进区间，缺 step 时按区间给', () => {
    const [d] = normalizeThreeParams([
      { key: 'x', type: 'range', min: 10, max: 0, defaultValue: 99 },
    ]);
    expect(d).toMatchObject({ key: 'x', type: 'range', min: 0, max: 10, defaultValue: 10 });
    expect(d!.step).toBeGreaterThan(0);
  });

  it('select：默认值不在选项里就取第一个；空选项整条丢弃', () => {
    const [a] = normalizeThreeParams([
      { key: 'm', type: 'select', defaultValue: 'nope', options: [{ value: 'u' }, { value: 'v' }] },
      { key: 'empty', type: 'select', options: [] },
    ]);
    expect(a).toMatchObject({ key: 'm', defaultValue: 'u' });
    expect(normalizeThreeParams([
      { key: 'm', type: 'select', options: [] },
    ])).toHaveLength(0);
  });

  it('color 只收 #rrggbb，其余退回白', () => {
    const defs = normalizeThreeParams([
      { key: 'a', type: 'color', defaultValue: '#FF8800' },
      { key: 'b', type: 'color', defaultValue: 'red' },
    ]);
    expect(defs[0]!.defaultValue).toBe('#ff8800');
    expect(defs[1]!.defaultValue).toBe('#ffffff');
  });

  it('重复键只留第一个，坏条目跳过，条数不设上限', () => {
    const many = Array.from({ length: 50 }, (_, i) => ({
      key: `k${i}`,
      type: 'checkbox',
    }));
    const defs = normalizeThreeParams([
      { key: 'a', type: 'checkbox' },
      { key: 'a', type: 'color' },
      { type: 'checkbox' },
      null,
      ...many,
    ]);
    expect(defs.filter((d) => d.key === 'a')).toHaveLength(1);
    // 复杂生成器（多发射点 / 接受点各带参数）本来就会超过 24 条。
    expect(defs.filter((d) => d.key.startsWith('k'))).toHaveLength(50);
  });

  it('非数组 / undefined 给空表，不抛', () => {
    expect(normalizeThreeParams(undefined)).toEqual([]);
    expect(normalizeThreeParams({ key: 'a' })).toEqual([]);
  });

  it('asset：值是不透明字符串，非字符串退成空串（解绑）而不是抛', () => {
    const [d] = normalizeThreeParams([{ key: 'img', type: 'asset', defaultValue: 'asset-7' }]);
    expect(d).toMatchObject({ key: 'img', type: 'asset', defaultValue: 'asset-7', accept: 'image' });
    // 素材 id 不校验存在性（那要问工程），只要求是字符串
    expect(coerceThreeValue(d!, 'whatever')).toBe('whatever');
    expect(coerceThreeValue(d!, 42)).toBe('');
    expect(coerceThreeValue(d!, null)).toBe('');
    expect(normalizeThreeParams([{ key: 'img', type: 'asset' }])[0]!.defaultValue).toBe('');
  });
});

describe('coerceThreeValue / mergeThreeParams', () => {
  const defs = normalizeThreeParams([
    { key: 'r', type: 'range', min: 0, max: 2, defaultValue: 1 },
    { key: 's', type: 'select', options: [{ value: 'a' }, { value: 'b' }], defaultValue: 'a' },
    { key: 'c', type: 'checkbox', defaultValue: 0 },
    { key: 'col', type: 'color', defaultValue: '#112233' },
  ]);

  it('越界夹取、非法值退回默认、字符串脏值不当数字用', () => {
    expect(coerceThreeValue(defs[0]!, 5)).toBe(2);
    expect(coerceThreeValue(defs[0]!, -3)).toBe(0);
    expect(coerceThreeValue(defs[1]!, 'zzz')).toBe('a');
    // 布尔直接认；认不出的字符串退回默认（checkbox 的默认是 0）
    expect(coerceThreeValue(defs[2]!, true)).toBe(1);
    expect(coerceThreeValue(defs[2]!, 'yes')).toBe(0);
    expect(coerceThreeValue(defs[3]!, '#ABCDEF')).toBe('#abcdef');
    expect(coerceThreeValue(defs[3]!, 'rgb(1,2,3)')).toBe('#112233');
  });

  it('合并只含定义表里的键（代码删掉的参数不会变成幽灵键）', () => {
    const merged = mergeThreeParams(defs, { r: 1.5, gone: 7 });
    expect(Object.keys(merged).sort()).toEqual(['c', 'col', 'r', 's']);
    expect(merged.r).toBe(1.5);
  });

  it('重建签名只扫 rebuild 键', () => {
    const withRebuild = normalizeThreeParams([
      { key: 'segs', type: 'range', min: 1, max: 64, defaultValue: 16, rebuild: true },
      { key: 'hue', type: 'range', min: 0, max: 1, defaultValue: 0.5 },
    ]);
    const sig = threeRebuildSignature(withRebuild, { segs: 32, hue: 0.9 });
    expect(sig).toBe('segs=32;');
    expect(threeRebuildSignature(withRebuild, { segs: 32, hue: 0.1 })).toBe(sig);
  });
});

describe('readThreeParams', () => {
  it('从代码里读表；params() 抛错或没有 params 都是空表', () => {
    expect(readThreeParams(`function params(){ return [{key:'a',type:'checkbox'}]; }`)).toHaveLength(1);
    expect(readThreeParams('function params(){ throw new Error("x"); }')).toEqual([]);
    expect(readThreeParams('function create(){}')).toEqual([]);
    expect(readThreeParams('function create( {')).toEqual([]);
  });

  it('同一份代码返回同一个数组引用（Svelte 的依赖比较要稳定）', () => {
    const code = `function params(){ return [{key:'a',type:'checkbox'}]; }`;
    expect(readThreeParams(code)).toBe(readThreeParams(code));
  });
});
