import { describe, expect, it } from 'vitest';
import {
  PARTICLE_PRESETS,
  PARTICLE_STATE_KEYS,
  PARTICLE_VOLATILE_KEYS,
  applyParticlePreset,
  clampNum,
  expandParticlePreset,
  hexRgb,
  isParticlePresetId,
  normalizeParticleConfig,
  particleParamKeys,
  particleTexSize,
} from '../../src/algos/particles/config';
import { particleParams } from '../../src/algos/particles/params';
import {
  clearAssetRefsInProject,
  sanitizeAssetParams,
  ASSET_PARAM_KEYS,
} from '../../src/core/asset-params';
import {
  DEFAULT_LIMITS,
  PARTICLE_HARD_CAP,
  PARTICLE_SNAPSHOT_BYTES,
  PARTICLE_STATE_BYTES,
  mbToBytes,
  particleCapacity,
} from '../../src/core/capacity';

/**
 * 粒子内核的纯函数守卫：归一化、容量换算、预设、素材引用修复。
 *
 * 这些函数能在 Node 里跑，是「参数夹取 / 哈希分界 / 悬空引用」三条静默失效
 * 唯一能自动挡住的地方。GL 侧的行为由 E2E 守。
 */
describe('参数归一化', () => {
  it('缺省值落在每个参数自己的区间里', () => {
    const cfg = normalizeParticleConfig({});
    for (const p of particleParams()) {
      if (p.type !== 'range') continue;
      const v = Number(p.defaultValue);
      expect(v, `${p.key} 的出厂值越界`).toBeGreaterThanOrEqual(p.min);
      expect(v, `${p.key} 的出厂值越界`).toBeLessThanOrEqual(p.max);
    }
    expect(cfg.count).toBeGreaterThan(0);
    expect(cfg.count).toBeLessThanOrEqual(cfg.capacity.maxParticles);
  });

  it('坏值 / 越界值一律夹紧，不产生 NaN', () => {
    const cfg = normalizeParticleConfig({
      count: Number.NaN,
      life: -99,
      speed: 1e9,
      bgMode: 'wat',
      shape: '不存在',
      spriteAsset: 42,
    });
    expect(Number.isFinite(cfg.count)).toBe(true);
    expect(cfg.lifeSteps).toBeGreaterThan(0);
    expect(cfg.speed).toBeLessThanOrEqual(4);
    expect(cfg.bgMode).toBe(0);
    expect(cfg.shape).toBe(0);
    // 非字符串素材引用当未绑定处理
    expect(cfg.spriteOn).toBe(0);
  });

  it('dt 与 fps 解耦：rate 变了步长跟着变，life 的步数也跟着变', () => {
    const a = normalizeParticleConfig({ rate: 30, life: 2 });
    const b = normalizeParticleConfig({ rate: 60, life: 2 });
    expect(a.dt).toBeCloseTo(1 / 30);
    expect(b.dt).toBeCloseTo(1 / 60);
    expect(a.lifeSteps).toBe(60);
    expect(b.lifeSteps).toBe(120);
  });

  it('状态纹理宽度固定，count 变化不改每个槽的坐标口径', () => {
    expect(particleTexSize(1000).texW).toBe(particleTexSize(200000).texW);
    expect(particleTexSize(1000).texH).toBe(2);
    expect(particleTexSize(512).texH).toBe(1);
    expect(particleTexSize(0).texH).toBe(1);
  });

  it('颜色解析：坏值回落，#rrggbb 归一到 0..1', () => {
    expect(hexRgb('#ff8000')).toEqual([1, 128 / 255, 0]);
    expect(hexRgb('nope')).toEqual([0, 0, 0]);
    expect(clampNum(undefined, 0, 1, 0.5)).toBe(0.5);
    expect(clampNum(99, 0, 1, 0.5)).toBe(1);
  });

  it('参数表覆盖了归一化读到的每个键', () => {
    const keys = particleParamKeys(particleParams());
    // 归一化读的键里，除了共用参数的键，都要在参数表里
    for (const k of [
      'count', 'shape', 'emitterSize', 'life', 'lifeVar', 'speed', 'speedVar',
      'spread', 'direction', 'gravityX', 'gravityY', 'gravityZ', 'drag',
      'turbulence', 'turbScale', 'vortex', 'attract', 'pointSize', 'sizeVar',
      'colorStart', 'colorEnd', 'opacity', 'blend', 'spriteAsset',
      'spriteRotate', 'spriteChannel', 'emitAsset', 'emitChannel',
      'emitThreshold', 'dimension', 'perspective', 'camYaw', 'camPitch',
      'camDist', 'depthSize', 'rate', 'bgMode', 'colorBg', 'intRes',
    ]) {
      expect(keys.has(k), `参数表缺 ${k}`).toBe(true);
    }
  });

  it('volatile 与状态键不重叠（改配色绝不重建模拟）', () => {
    for (const k of PARTICLE_VOLATILE_KEYS) {
      expect(PARTICLE_STATE_KEYS, `${k} 同时进了两张表`).not.toContain(k);
    }
    // 发射密度图影响出生位置，必须在状态侧
    expect(PARTICLE_STATE_KEYS).toContain('emitAsset');
    // 精灵贴图只影响渲染，必须在 volatile 侧
    expect(PARTICLE_VOLATILE_KEYS).toContain('spriteAsset');
  });
});

describe('容量派生', () => {
  it('宽裕机器给到设计上界，小机器按预算下调并报降级', () => {
    const wide = particleCapacity({ ...DEFAULT_LIMITS, simStateMB: 8192 });
    expect(wide.maxParticles).toBe(PARTICLE_HARD_CAP);
    expect(wide.degraded).toBe(false);

    const small = particleCapacity({ ...DEFAULT_LIMITS, simStateMB: 8 });
    expect(small.maxParticles).toBeGreaterThanOrEqual(1024);
    expect(small.maxParticles).toBeLessThan(PARTICLE_HARD_CAP);
    expect(small.maxParticles % 64).toBe(0);
    expect(small.degraded).toBe(true);
  });

  it('常驻状态 + 快照环的字节数不超过分到的预算', () => {
    const limits = { ...DEFAULT_LIMITS, simStateMB: 128 };
    const cap = particleCapacity(limits);
    const perParticle = PARTICLE_STATE_BYTES + cap.snapshotCap * PARTICLE_SNAPSHOT_BYTES;
    expect(cap.maxParticles * perParticle).toBeLessThanOrEqual(
      Math.floor(mbToBytes(limits.simStateMB) * 0.5),
    );
  });
});

describe('预设', () => {
  it('每个预设的键都真的存在，且类型对得上', () => {
    const byKey = new Map(particleParams().map((p) => [p.key, p.type]));
    for (const preset of PARTICLE_PRESETS) {
      for (const [k, v] of Object.entries(preset.values)) {
        expect(byKey.has(k), `${preset.id} 写了不存在的键 ${k}`).toBe(true);
        const type = byKey.get(k);
        if (type === 'range') expect(typeof v, `${preset.id}.${k}`).toBe('number');
        else expect(typeof v, `${preset.id}.${k}`).toBe('string');
      }
    }
  });

  it('展开 = 缺省值 + 覆盖；叠加只改预设声明过的键', () => {
    const expanded = expandParticlePreset('snow', { count: 12345, shape: 'ring' });
    expect(expanded.count).toBe(6000);
    expect(expanded.shape).toBe('box');

    const current = { shape: 'ring', spriteAsset: 'a1', count: 999 };
    const merged = applyParticlePreset('snow', current);
    expect(merged.spriteAsset).toBe('a1'); // 预设没提到，留着
    expect(merged.life).toBe(PARTICLE_PRESETS.find((p) => p.id === 'snow')!.values.life);
    expect(current.spriteAsset).toBe('a1'); // 不改入参
  });

  it('未知预设名不生效，也不抛', () => {
    expect(isParticlePresetId('wat')).toBe(false);
    expect(applyParticlePreset('wat', { count: 1 })).toEqual({ count: 1 });
    expect(expandParticlePreset('wat', { count: 1 })).toEqual({ count: 1 });
  });
});

describe('素材引用修复', () => {
  const project = () => ({
    assets: { a1: { kind: 'image' }, v1: { kind: 'video' } },
    tracks: [
      {
        clips: [
          {
            kind: 'source',
            source: { type: 'algo', generator: 'particles', params: { spriteAsset: 'a1', emitAsset: 'gone', count: 100 } },
          },
          { kind: 'effect', chain: [{ values: { spriteAsset: 'a1' } }] },
        ],
      },
    ],
  });

  it('打开工程时把悬空 / 非图片 / 非字符串的引用置空串', () => {
    const p = project();
    expect(sanitizeAssetParams(p)).toBe(1);
    expect(p.tracks[0]!.clips[0]!.source!.params!.emitAsset).toBe('');
    expect(p.tracks[0]!.clips[0]!.source!.params!.spriteAsset).toBe('a1');
    expect(p.tracks[0]!.clips[0]!.source!.params!.count).toBe(100);
  });

  it('删素材时置空而不是删键，返回真的改了几处', () => {
    const p = project();
    expect(clearAssetRefsInProject(p, 'a1')).toBe(2);
    expect(p.tracks[0]!.clips[0]!.source!.params!.spriteAsset).toBe('');
    expect(p.tracks[0]!.clips[1]!.chain![0]!.values.spriteAsset).toBe('');
    expect(clearAssetRefsInProject(p, 'nobody')).toBe(0);
  });

  it('键清单与粒子参数表的 asset 参数一一对应', () => {
    const assetKeys = particleParams().filter((p) => p.type === 'asset').map((p) => p.key);
    expect([...ASSET_PARAM_KEYS].sort()).toEqual(assetKeys.sort());
  });
});
