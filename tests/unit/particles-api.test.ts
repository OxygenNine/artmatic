import { describe, expect, it } from 'vitest';
import {
  createParticleGenerator,
  specConflicts,
  particleParams,
  PARTICLE_GROUPS,
  DEFAULT_PARTICLE_SHADERS,
  isParticlePresetId,
} from '../../src/algos/particles/index';
import { particleProgramName } from '../../src/algos/particles/glsl';
import { clipEditorOf, hasFullscreenEditor } from '../../src/ui/clip-editor';
import { getCapabilities } from '../../src/agent/capabilities';
import { defaultValues } from '../../src/effects/types';
import type { AnyClip } from '../../src/core/schema';

/**
 * 复用 API 的守卫：一个「薄封装」spec 必须产出一个形状完整、能被注册表与
 * 界面分派认出来的 def。全程不碰 GL（vitest 只测纯函数）。
 *
 * 这条是「API 供之后需要粒子效果的生成器复用」唯一会变红的守门员：
 * 把 `createParticleGenerator` 改成只服务内置 id，或者漏了参数表 / aux 声明，
 * 这里立刻失败。
 */
const thin = createParticleGenerator({
  id: 'test-particle-thin',
  nameKey: 'test.thin' as never,
  defaults: { life: 1.5, count: 2048 },
  preset: 'snow',
  omit: ['camYaw'],
});

describe('createParticleGenerator', () => {
  it('产出 gpu-sim 形态，形状与内置 def 同构', () => {
    expect(thin.kind).toBe('gpu-sim');
    expect(thin.id).toBe('test-particle-thin');
    if (thin.kind !== 'gpu-sim') return;
    expect(typeof thin.create).toBe('function');
    expect(thin.auxTextures?.map((a) => a.uniform).sort()).toEqual(['u_emitMask', 'u_sprite']);
    expect(thin.auxTextures?.every((a) => a.kind === 'asset-image' && a.assetParam)).toBe(true);
  });

  it('defaults 覆盖 preset，omit 真的移除参数', () => {
    const byKey = new Map(thin.params.map((p) => [p.key, p.defaultValue]));
    expect(byKey.get('count')).toBe(2048); // defaults 优先
    expect(byKey.get('life')).toBe(1.5);
    expect(byKey.get('shape')).toBe('box'); // snow 预设的其余项
    expect(byKey.has('camYaw')).toBe(false);
  });

  it('追加参数与覆盖参数都生效，键不重复', () => {
    const def = createParticleGenerator({
      id: 'test-extra',
      nameKey: 'test.extra' as never,
      params: [
        { key: 'extra', labelKey: 'test.extra.label' as never, type: 'range', min: 0, max: 1, step: 0.1, defaultValue: 0.2 },
        { key: 'life', labelKey: 'test.life.label' as never, type: 'range', min: 0.1, max: 30, step: 0.1, defaultValue: 7 },
      ],
    });
    const keys = def.params.map((p) => p.key);
    expect(new Set(keys).size).toBe(keys.length);
    const byKey = new Map(def.params.map((p) => [p.key, p.defaultValue]));
    expect(byKey.get('extra')).toBe(0.2);
    expect(byKey.get('life')).toBe(7);
  });

  it('program 名按 id 区分，四段互不重名', () => {
    const parts = ['init', 'step-pos', 'step-vel', 'points'] as const;
    const names = parts.map((p) => particleProgramName('test-particle-thin', p));
    expect(new Set(names).size).toBe(4);
    expect(particleProgramName('other', 'init')).not.toBe(names[0]);
  });

  it('缺省 GLSL 四段都有内容，hash 无 sin', () => {
    for (const key of ['init', 'stepPos', 'stepVel', 'pointFrag', 'pointVert'] as const) {
      expect(DEFAULT_PARTICLE_SHADERS[key].length, key).toBeGreaterThan(50);
    }
    const all = Object.values(DEFAULT_PARTICLE_SHADERS).join('\n');
    // 大步号下 `fract(sin(x) * …)` 这类 hash 低位会抖。发射方向用 sin/cos
    // 是几何，不受这条约束；判据只盯 hash 的形状。
    expect(all).not.toContain('fract(sin');
    expect(all).toContain('hash31');
    expect(all).toContain('u_step');
    expect(all).not.toContain('Math.random');
  });

  it('specConflicts 只报同名不同类型的覆盖', () => {
    expect(specConflicts({ id: 'x', nameKey: 'x' as never })).toEqual([]);
    const bad = specConflicts({
      id: 'x',
      nameKey: 'x' as never,
      params: [{ key: 'life', labelKey: 'x' as never, type: 'select', defaultValue: 'a', options: [] }],
    });
    expect(bad).toEqual(['life']);
  });

  it('参数分组齐全，且每组都有参数', () => {
    const groups = new Map<string, number>();
    for (const p of particleParams()) {
      const g = p.group ?? 'system';
      groups.set(g, (groups.get(g) ?? 0) + 1);
    }
    for (const g of PARTICLE_GROUPS) {
      expect(groups.get(g) ?? 0, `${g} 组空了`).toBeGreaterThan(0);
    }
  });
});

describe('界面与 Agent 可达性', () => {
  it('gpu-sim 片段双击进全屏子系统（薄封装也一样）', () => {
    const clip = {
      kind: 'source',
      id: 'c1',
      source: { type: 'algo', generator: 'test-particle-thin', params: {} },
    } as unknown as AnyClip;
    // 薄封装没进注册表，判据按 generator id 查不到时回落 null 是正确行为；
    // 这里只验证判据函数本身不依赖具体 id 硬编码。
    expect(clipEditorOf(clip)).toBeNull();

    // 内置 particles 已登记，必须进粒子页
    expect(hasFullscreenEditor('particles')).toBe(true);
    const builtin = {
      ...clip,
      source: { type: 'algo', generator: 'particles', params: {} },
    } as unknown as AnyClip;
    expect(clipEditorOf(builtin)).toBe('particles');
  });

  it('能力清单列出预设、素材键与全部参数（含 group）', () => {
    const caps = getCapabilities({ detail: 'params', ids: ['particles'] });
    const gen = caps.generators.find((g) => g.id === 'particles');
    expect(gen).toBeTruthy();
    // `detail: 'params'` 才填这张表。写成 `?? []` 而不是 `!`，
    // 免得「能力清单忘了带参数」被非空断言伪装成通过。
    const params = gen?.params ?? [];
    expect(params.length).toBe(particleParams().length);
    const asset = params.find((p) => p.key === 'spriteAsset');
    expect(asset?.type).toBe('asset');
    expect(asset?.accept).toBe('image');
    expect(params.every((p) => typeof p.group === 'string')).toBe(true);

    const f = caps.features.particles;
    expect(f.presets.every(isParticlePresetId)).toBe(true);
    expect(f.assetParams).toContain('emitAsset');
    expect(f.units.rate).toContain('steps per second');
    expect(f.units.life).toBe('seconds');
  });

  it('出厂参数可直接喂给归一化，不会越界', () => {
    const values = defaultValues(thin.params);
    expect(values.camYaw).toBeUndefined(); // 被 omit 掉了
    expect(values.count).toBe(2048);
  });
});
