import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  defaultEffectValues,
  effectRegistryRevision,
  getEffect,
  listEffects,
  onEffectRegistryChange,
  registerPluginEffects,
  unregisterPlugin,
  type PluginEffectInput,
} from '../../src/effects/registry';
import {
  algoRegistryRevision,
  defaultParams,
  getGenerator,
  listAssetParamKeys,
  listGenerators,
  registerPluginGenerators,
  unregisterPluginGenerators,
} from '../../src/algos/registry';
import {
  isPluginDefId,
  isValidPluginSegment,
  localDefIdOf,
  pluginDefId,
  pluginIdOf,
} from '../../src/core/plugin-id';

/**
 * 插件层的运行期注册。这是整个插件系统里**唯一会改全局状态**的地方，
 * 所以每条不变量都要钉死 —— 出问题的形态是「卸载插件时连带毁掉内置特效」，
 * 那会毁掉一切却毫无报错。
 */

const PLUGIN = 'demo-plugin';

function effect(id: string, overrides: Partial<PluginEffectInput> = {}): PluginEffectInput {
  return {
    id,
    name: { text: id.toUpperCase() },
    params: [{ key: 'amount', labelKey: { text: 'Amount' }, type: 'range', min: 0, max: 1, step: 0.01, defaultValue: 0.5 }],
    shader: { fragment: 'void main() { outColor = vec4(1.0); }', setUniforms: () => {} },
    ...overrides,
  };
}

afterEach(() => {
  unregisterPlugin(PLUGIN);
  unregisterPlugin('other-plugin');
  unregisterPluginGenerators(PLUGIN);
  unregisterPluginGenerators('other-plugin');
});

describe('id 命名空间', () => {
  it('拼出来的 id 能被反解回原样', () => {
    const id = pluginDefId('my-plugin', 'my-fx');
    expect(id).toBe('my-plugin/my-fx');
    expect(pluginIdOf(id)).toBe('my-plugin');
    expect(localDefIdOf(id)).toBe('my-fx');
  });

  it('内置 id 不含分隔符，所以反解一律 null', () => {
    expect(pluginIdOf('blur')).toBeNull();
    expect(localDefIdOf('blur')).toBeNull();
    expect(isPluginDefId('blur')).toBe(false);
    expect(isPluginDefId('my-plugin/my-fx')).toBe(true);
  });

  it('拒绝会破坏路径或命名空间的分段', () => {
    for (const bad of ['', '.', '..', 'A', 'a/b', 'a b', '-x', '.hidden', 'x'.repeat(65)]) {
      expect(isValidPluginSegment(bad), JSON.stringify(bad)).toBe(false);
    }
    for (const ok of ['a', 'my-plugin', 'a.b_c-1', 'x'.repeat(64)]) {
      expect(isValidPluginSegment(ok), ok).toBe(true);
    }
  });
});

describe('特效：注册与卸载', () => {
  it('注册后能被查到，且 id 带命名空间', () => {
    const { added, issues } = registerPluginEffects(PLUGIN, [effect('glow2')]);
    expect(issues).toEqual([]);
    expect(added).toEqual(['demo-plugin/glow2']);

    const entry = getEffect('demo-plugin/glow2');
    expect(entry).not.toBeNull();
    expect(entry!.pluginId).toBe(PLUGIN);
    expect(entry!.meta?.desc).toBeNull();
  });

  it('内置特效不受影响（注册前后拿到的是同一个）', () => {
    const before = getEffect('blur');
    registerPluginEffects(PLUGIN, [effect('glow2')]);
    expect(getEffect('blur')).toBe(before);
  });

  it('卸载只删自己的条目', () => {
    registerPluginEffects(PLUGIN, [effect('a')]);
    registerPluginEffects('other-plugin', [effect('b')]);

    unregisterPlugin(PLUGIN);

    expect(getEffect('demo-plugin/a')).toBeNull();
    expect(getEffect('other-plugin/b')).not.toBeNull();
    expect(getEffect('blur')).not.toBeNull();
  });

  it('同一个插件重复注册是**替换**（用户在改插件源码时反复导入）', () => {
    registerPluginEffects(PLUGIN, [effect('a'), effect('b')]);
    registerPluginEffects(PLUGIN, [effect('a')]);

    expect(getEffect('demo-plugin/a')).not.toBeNull();
    expect(getEffect('demo-plugin/b'), '旧版本的 def 应当被清掉').toBeNull();
  });

  it('未注册过的插件 id 卸载是空操作，不抛', () => {
    expect(() => unregisterPlugin('never-loaded')).not.toThrow();
  });


});

describe('特效：坏条目不拖垮整批', () => {
  it('缺 id 的条目被跳过并记一条 issue', () => {
    const { added, issues } = registerPluginEffects(PLUGIN, [
      { ...effect('ok'), id: '' },
      effect('good'),
    ]);
    expect(added).toEqual(['demo-plugin/good']);
    expect(issues).toEqual([{ code: 'missing-id', id: '' }]);
  });

  it('同一个插件里局部 id 重复：只保留第一条', () => {
    const { added, issues } = registerPluginEffects(PLUGIN, [effect('dup'), effect('dup')]);
    expect(added).toEqual(['demo-plugin/dup']);
    expect(issues).toEqual([{ code: 'duplicate-id', id: 'dup' }]);
  });
});

describe('特效：参数默认值', () => {
  it('插件特效的默认值从它自己的 params 里取', () => {
    registerPluginEffects(PLUGIN, [effect('a')]);
    expect(defaultEffectValues('demo-plugin/a')).toEqual({ amount: 0.5 });
  });

  it('未知 id 返回空对象（不是抛错、不是 null）', () => {
    expect(defaultEffectValues('demo-plugin/nope')).toEqual({});
  });
});

describe('变更通知', () => {
  it('注册与卸载都会增长 revision', () => {
    const before = effectRegistryRevision();
    registerPluginEffects(PLUGIN, [effect('a')]);
    const mid = effectRegistryRevision();
    unregisterPlugin(PLUGIN);
    expect(mid).toBeGreaterThan(before);
    expect(effectRegistryRevision()).toBeGreaterThan(mid);
  });

  it('订阅者被通知；退订后不再被通知', () => {
    const fn = vi.fn();
    const off = onEffectRegistryChange(fn);
    registerPluginEffects(PLUGIN, [effect('a')]);
    expect(fn).toHaveBeenCalledTimes(1);
    off();
    unregisterPlugin(PLUGIN);
    expect(fn, '退订之后不该再收到通知').toHaveBeenCalledTimes(1);
  });

  it('回调里退订不会跳过后面的监听者', () => {
    const first = vi.fn();
    const second = vi.fn();
    const off = onEffectRegistryChange(() => {
      first();
      off();
    });
    const off2 = onEffectRegistryChange(second);
    registerPluginEffects(PLUGIN, [effect('a')]);
    off2();
    expect(first).toHaveBeenCalledTimes(1);
    expect(second).toHaveBeenCalledTimes(1);
  });
});

describe('列表：内置在前、插件在后', () => {
  it('插件条目带 pluginId，内置条目为 null', () => {
    registerPluginEffects(PLUGIN, [effect('a')]);
    const list = listEffects();
    const plugin = list.filter((e) => e.pluginId !== null);
    const builtin = list.filter((e) => e.pluginId === null);
    expect(plugin.map((e) => e.id)).toEqual(['demo-plugin/a']);
    expect(builtin.length).toBeGreaterThan(50);
    // 内置必须排在前面：选择器的「默认顺序」就是这个顺序。
    expect(list.findIndex((e) => e.pluginId !== null)).toBeGreaterThan(builtin.length - 1);
  });


});

describe('生成器：只支持 realtime', () => {
  it('注册后 kind 恒为 realtime，且能取到 def', () => {
    registerPluginGenerators(PLUGIN, [
      {
        id: 'waves',
        name: { text: 'Waves' },
        params: [],
        fragment: 'void main() { outColor = vec4(vUv, 0.0, 1.0); }',
        setUniforms: () => {},
      },
    ]);
    const def = getGenerator('demo-plugin/waves');
    expect(def).not.toBeNull();
    expect(def!.kind).toBe('realtime');
  });

  it('列表里的插件条目带 pluginId 与 kind', () => {
    registerPluginGenerators(PLUGIN, [
      { id: 'waves', name: { text: 'Waves' }, params: [], fragment: 'x', setUniforms: () => {} },
    ]);
    const row = listGenerators().find((g) => g.id === 'demo-plugin/waves');
    expect(row).toMatchObject({ kind: 'realtime', pluginId: PLUGIN });
  });

  it('卸载只删自己的，内置生成器照旧', () => {
    registerPluginGenerators(PLUGIN, [
      { id: 'waves', name: { text: 'Waves' }, params: [], fragment: 'x', setUniforms: () => {} },
    ]);
    unregisterPluginGenerators(PLUGIN);
    expect(getGenerator('demo-plugin/waves')).toBeNull();
    expect(getGenerator('mandelbrot')).not.toBeNull();
  });

  it('默认参数从插件自己的 params 取', () => {
    registerPluginGenerators(PLUGIN, [
      {
        id: 'waves',
        name: { text: 'Waves' },
        params: [{ key: 'freq', labelKey: { text: 'Freq' }, type: 'range', min: 0, max: 10, step: 0.1, defaultValue: 3 }],
        fragment: 'x',
        setUniforms: () => {},
      },
    ]);
    expect(defaultParams('demo-plugin/waves')).toEqual({ freq: 3 });
  });

  it('auxTextures 原样带进 def（插件拿素材纹理的唯一通路）', () => {
    registerPluginGenerators(PLUGIN, [
      {
        id: 'wall',
        name: { text: 'Wall' },
        params: [{ key: 'srcAsset', labelKey: { text: 'Image' }, type: 'asset', defaultValue: '' }],
        fragment: 'x',
        setUniforms: () => {},
        auxTextures: [{ uniform: 'u_tex', kind: 'asset-image', assetParam: 'srcAsset' }],
      },
    ]);
    const def = getGenerator('demo-plugin/wall');
    expect(def).not.toBeNull();
    if (!def || def.kind !== 'realtime') throw new Error('expected a realtime def');
    expect(def.auxTextures).toEqual([{ uniform: 'u_tex', kind: 'asset-image', assetParam: 'srcAsset' }]);
    // 没声明 aux 的 def 不应该留下一个空数组（运行期按 `def.auxTextures` 的真假分支）
    registerPluginGenerators('other-plugin', [
      { id: 'plain', name: { text: 'P' }, params: [], fragment: 'x', setUniforms: () => {} },
    ]);
    expect((getGenerator('other-plugin/plain') as { auxTextures?: unknown }).auxTextures).toBeUndefined();
  });

  it('listAssetParamKeys 含插件的 asset 参数键，卸载后消失', () => {
    expect(listAssetParamKeys()).not.toContain('srcAsset');
    registerPluginGenerators(PLUGIN, [
      {
        id: 'wall',
        name: { text: 'Wall' },
        params: [{ key: 'srcAsset', labelKey: { text: 'Image' }, type: 'asset', defaultValue: '' }],
        fragment: 'x',
        setUniforms: () => {},
      },
    ]);
    expect(listAssetParamKeys()).toContain('srcAsset');
    unregisterPluginGenerators(PLUGIN);
    expect(listAssetParamKeys()).not.toContain('srcAsset');
  });

  it('revision 只在插件层变动时增长', () => {
    const before = algoRegistryRevision();
    expect(getGenerator('mandelbrot')).not.toBeNull();
    registerPluginGenerators(PLUGIN, [
      { id: 'waves', name: { text: 'Waves' }, params: [], fragment: 'x', setUniforms: () => {} },
    ]);
    expect(algoRegistryRevision()).toBeGreaterThan(before);
  });
});
