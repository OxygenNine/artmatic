import { describe, expect, it } from 'vitest';
import { threeParamDefs, defineThreeGenerator } from '../../src/algos/three-generator';
import { isAnimatableParam } from '../../src/algos/types';
import { getGenerator, listGenerators } from '../../src/algos/registry';
import { blackHoleThreeDef } from '../../src/algos/black-hole-three';
import { blackHoleDef } from '../../src/algos/black-hole';
import { extrudeThreeDef } from '../../src/algos/extrude-three';
import { extrudeMaterialDef } from '../../src/algos/extrude-material';
import { compileThreeCode, readThreeParams } from '../../src/three/code';
import { getCapabilities } from '../../src/agent/capabilities';

/** 覆盖四种参数类型的一段最小代码。 */
const CODE = `
function params() {
  return [
    { key: 'gain', type: 'range', label: 'Gain', min: 0, max: 2, step: 0.1, defaultValue: 1 },
    { key: 'mode', type: 'select', label: 'Mode', options: [{ value: 'a', label: 'A' }, { value: 'b', label: 'B' }], defaultValue: 'b' },
    { key: 'on', type: 'checkbox', label: 'On', defaultValue: 1 },
    { key: 'tint', type: 'color', label: 'Tint', defaultValue: '#ff8800' },
    { key: 'segs', type: 'range', label: 'Segs', min: 3, max: 64, step: 1, defaultValue: 16, rebuild: true },
  ];
}
function create(THREE, ctx) { return { scene: null, camera: null }; }
`;

describe('threeParamDefs：代码里的 params() → 注册表协议', () => {
  it('四种类型逐字段搬运（标签保留字面量文本）', () => {
    const defs = threeParamDefs(CODE);
    expect(defs.map((d) => `${d.key}:${d.type}`)).toEqual([
      'gain:range',
      'mode:select',
      'on:checkbox',
      'tint:color',
      'segs:range',
    ]);

    const gain = defs[0]!;
    expect(gain).toMatchObject({ type: 'range', min: 0, max: 2, step: 0.1, defaultValue: 1 });
    expect(gain.labelKey).toEqual({ text: 'Gain' });

    const mode = defs[1]!;
    expect(mode).toMatchObject({ type: 'select', defaultValue: 'b' });
    expect(mode.type === 'select' && mode.options.map((o) => o.value)).toEqual(['a', 'b']);

    const on = defs[2]!;
    expect(on).toMatchObject({ type: 'checkbox', defaultValue: 1 });

    const tint = defs[3]!;
    expect(tint).toMatchObject({ type: 'color', defaultValue: '#ff8800' });
  });

  it('rebuild 一路带到 ParamDef（面板据此不提供关键帧）', () => {
    const defs = threeParamDefs(CODE);
    expect(defs.filter((d) => d.rebuild).map((d) => d.key)).toEqual(['segs']);
  });

  it('代码里没有 params() 时给空表（不是抛错）', () => {
    expect(threeParamDefs('function create(THREE) { return { scene: null, camera: null }; }')).toEqual([]);
  });
});

describe('defineThreeGenerator', () => {
  it('params 由代码派生 —— 同一个键集合、同一份默认值', () => {
    const def = defineThreeGenerator({ id: 'x', nameKey: 'algo.blackHole', code: CODE });
    expect(def.kind).toBe('three');
    const fromCode = readThreeParams(CODE);
    const def2 = def as Extract<typeof def, { kind: 'three' }>;
    expect(def2.code).toBe(CODE);
    expect(def.params.map((p) => p.key)).toEqual(fromCode.map((p) => p.key));
    expect(def.params.map((p) => p.defaultValue)).toEqual(fromCode.map((p) => p.defaultValue));
  });
});

describe('isAnimatableParam：一份判据，四个 kind', () => {
  const three = defineThreeGenerator({ id: 'x', nameKey: 'algo.blackHole', code: CODE });
  const gain = three.params[0]!;
  const segs = three.params[4]!;

  it('three：普通 range 可以打关键帧，rebuild 的不行', () => {
    expect(isAnimatableParam(three, gain)).toBe(true);
    expect(isAnimatableParam(three, segs)).toBe(false);
  });

  it('非 range 一律不行（select / checkbox / color 没有曲线）', () => {
    for (const p of three.params.filter((x) => x.type !== 'range')) {
      expect(isAnimatableParam(three, p)).toBe(false);
    }
  });

  it('bake 只有 speed；sim 一个都没有', () => {
    const bake = getGenerator('rule110')!;
    const speed = bake.params.find((p) => p.key === 'speed')!;
    const other = bake.params.find((p) => p.key !== 'speed' && p.type === 'range')!;
    expect(isAnimatableParam(bake, speed)).toBe(true);
    expect(isAnimatableParam(bake, other)).toBe(false);

    const sim = getGenerator('game-of-life')!;
    for (const p of sim.params.filter((x) => x.type === 'range')) {
      expect(isAnimatableParam(sim, p)).toBe(false);
    }
  });
});

describe('黑洞：新实现接管，旧实现归档', () => {
  it('两个 id 都还在注册表里（老工程必须还能播）', () => {
    expect(getGenerator('black-hole')).not.toBeNull();
    expect(getGenerator('black-hole-three')).not.toBeNull();
  });

  it('只有 SDF 那版带 archived，且它的展示名说清了是哪一版', () => {
    const old = getGenerator('black-hole')!;
    const now = getGenerator('black-hole-three')!;
    expect(old.archived).toBe(true);
    expect(now.archived).toBeUndefined();
    expect(old.nameKey).not.toBe(now.nameKey);
  });

  it('three 版：代码编得过，参数表与代码一致（17 个，含一个颜色）', () => {
    const def = blackHoleThreeDef;
    if (def.kind !== 'three') throw new Error('black-hole-three 必须是 three 型');
    expect(compileThreeCode(def.code).ok).toBe(true);
    expect(def.params).toHaveLength(17);
    expect(def.params.filter((p) => p.type === 'color').map((p) => p.key)).toEqual(['diskCol']);
    expect(def.params.map((p) => p.key)).toEqual(readThreeParams(def.code).map((p) => p.key));
  });

  it('旧版仍然是 realtime def（归档不等于停用）', () => {
    expect(blackHoleDef.kind).toBe('realtime');
    expect(blackHoleDef.params.length).toBeGreaterThan(0);
  });
});

describe('能力清单：归档默认不列，但按 id 问得到', () => {
  it('全量清单里没有 black-hole，只有 black-hole-three', () => {
    const ids = getCapabilities().generators.map((g) => g.id);
    expect(ids).toContain('black-hole-three');
    expect(ids).not.toContain('black-hole');
  });

  it('按 id 显式查询仍然给得出来（get_scene 里看到旧 id 时还能查它）', () => {
    const one = getCapabilities({ ids: ['black-hole'], detail: 'params' }).generators;
    expect(one).toHaveLength(1);
    expect(one[0]!.id).toBe('black-hole');
    expect(one[0]!.params?.length).toBeGreaterThan(0);
  });

  it('three 生成器的能力项里 kind 是 three（模型据此知道它没有 intRes 这类参数）', () => {
    const one = getCapabilities({ ids: ['black-hole-three'] }).generators;
    expect(one[0]!.kind).toBe('three');
  });
});

describe('3D 格式化：three 版接管，SDF 版归档', () => {
  it('两个 id 都还在注册表里（老工程必须还能播）', () => {
    expect(getGenerator('extrude-material')).not.toBeNull();
    expect(getGenerator('extrude-material-three')).not.toBeNull();
  });

  it('只有 SDF 版带 archived，且它的展示名说清了是哪一版', () => {
    const old = getGenerator('extrude-material')!;
    const now = getGenerator('extrude-material-three')!;
    expect(old.archived).toBe(true);
    expect(now.archived).toBeUndefined();
    expect(old.nameKey).not.toBe(now.nameKey);
  });

  it('three 版：代码编得过，参数与代码一致，且带一个图片素材参数', () => {
    const def = extrudeThreeDef;
    if (def.kind !== 'three') throw new Error('extrude-material-three 必须是 three 型');
    expect(compileThreeCode(def.code).ok).toBe(true);
    expect(def.params.map((p) => p.key)).toEqual(readThreeParams(def.code).map((p) => p.key));
    const asset = def.params.find((p) => p.type === 'asset');
    expect(asset).toMatchObject({ key: 'logoAsset', accept: 'image', defaultValue: '' });
  });

  it('旧版仍然是 realtime def（归档不等于停用），且它的 asset 参数还在', () => {
    expect(extrudeMaterialDef.kind).toBe('realtime');
    expect(extrudeMaterialDef.params.some((p) => p.type === 'asset')).toBe(true);
  });

  it('能力清单里只有新 id（旧 id 按 id 显式查询仍给得出）', () => {
    const ids = getCapabilities().generators.map((g) => g.id);
    expect(ids).toContain('extrude-material-three');
    expect(ids).not.toContain('extrude-material');
    expect(getCapabilities({ ids: ['extrude-material'] }).generators).toHaveLength(1);
  });
});

describe('注册表顺序：新实现紧挨着旧实现，且归档的不被当成插件', () => {
  it('两个都在内置层', () => {
    const list = listGenerators();
    const old = list.find((g) => g.id === 'black-hole')!;
    const now = list.find((g) => g.id === 'black-hole-three')!;
    expect(old.pluginId).toBeNull();
    expect(now.pluginId).toBeNull();
    expect(old.archived).toBe(true);
    expect(now.archived).toBe(false);
  });
});
