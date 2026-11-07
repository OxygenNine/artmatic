import { describe, expect, it } from 'vitest';
import {
  HORIZON_FRAG,
  HORIZON_OCTAVES,
  HORIZON_STYLES,
  HORIZON_STYLE_FALLBACK,
  HORIZON_STYLE_OPTIONS,
  horizonDef,
} from '../../src/algos/horizon';
import { NOISE_GLSL, NZ_MAX_OCTAVES } from '../../src/algos/noise-lib';
import { ALGO_CATALOG } from '../../src/algos/catalog';
import { LOCALES } from '../../src/i18n/locales';

/**
 * 「地平线」的结构守卫。像素级判据在 tests/e2e/algo-horizon.spec.ts。
 *
 * 这里能纯测的只有三件会**静默失效**的形状：
 * 1. 风格选项与预设表脱节（选项还在，拖过去画面不变）；
 * 2. 预设的十二个通道没有全部接进 shader（漏一个 = 那一个风格维度永远不动）；
 * 3. 时间被接进画面两次（speed = 0 不再静止）。
 */

const FRAG = HORIZON_FRAG;
const param = (key: string) => {
  const p = horizonDef.params.find((q) => q.key === key);
  expect(p, `缺参数 ${key}`).toBeDefined();
  return p!;
};

describe('地平线：风格是参数组合，不是 shader 分支', () => {
  it('select 的每一项都有一组预设，缺省与回退都在表里', () => {
    const options = param('style');
    expect(options.type).toBe('select');
    if (options.type !== 'select') throw new Error('unreachable');
    expect(options.options.map((o) => o.value).sort()).toEqual(Object.keys(HORIZON_STYLES).sort());
    expect(HORIZON_STYLES[options.defaultValue]).toBeDefined();
    expect(HORIZON_STYLES[HORIZON_STYLE_FALLBACK]).toBeDefined();
    expect(options.options).toBe(HORIZON_STYLE_OPTIONS);
  });

  it('五个风格两两可分，且没有一组是空预设', () => {
    const entries = Object.entries(HORIZON_STYLES);
    expect(entries).toHaveLength(5);
    const signatures = entries.map(([, s]) => JSON.stringify([
      s.skyTop, s.skyLow, s.groundLow, s.groundHigh, s.accent, s.water,
      s.fx, s.retro, s.look,
    ]));
    expect(new Set(signatures).size, '有两种风格给了一模一样的参数').toBe(entries.length);

    for (const [id, s] of entries) {
      const all = [...s.fx, ...s.retro, ...s.look];
      expect(Math.max(...all), `${id} 整组都是 0，等于没有风格`).toBeGreaterThan(0.5);
      for (const v of all) expect(Number.isFinite(v), `${id} 有非数系数`).toBe(true);
    }
  });

  it('任意两种风格至少在一个系数上真的分得开', () => {
    const entries = Object.entries(HORIZON_STYLES);
    for (let i = 0; i < entries.length; i++) {
      for (let j = i + 1; j < entries.length; j++) {
        const a = [...entries[i]![1].fx, ...entries[i]![1].retro, ...entries[i]![1].look];
        const b = [...entries[j]![1].fx, ...entries[j]![1].retro, ...entries[j]![1].look];
        const diff = a.filter((x, k) => Math.abs(x - b[k]!) >= 0.3).length;
        expect(diff, `${entries[i]![0]} 与 ${entries[j]![0]} 只差一点，肉眼分不出`).toBeGreaterThan(0);
      }
    }
  });

  it('shader 里没有风格 id，十二个系数全部被读到', () => {
    expect(FRAG.includes('u_style'), '出现风格 id 的 uniform = 走回了 shader 分支').toBe(false);
    expect(FRAG).not.toMatch(/if\s*\(\s*u_\w+\s*==\s*\d/);
    for (const name of ['u_fx', 'u_retro', 'u_look']) {
      expect(FRAG, `少了 ${name} 的声明`).toMatch(new RegExp(`uniform\\s+vec4\\s+${name};`));
      for (const c of ['x', 'y', 'z', 'w']) {
        expect(FRAG, `${name}.${c} 没被读 → 这个风格维度拨了没反应`).toContain(`${name}.${c}`);
      }
    }
    for (const name of ['u_skyTop', 'u_skyLow', 'u_groundLow', 'u_groundHigh', 'u_accent', 'u_water']) {
      expect(FRAG, `${name} 没被声明`).toMatch(new RegExp(`uniform\\s+vec3\\s+${name};`));
    }
  });

  it('三个预设倍率都接到了对应的一组系数上', () => {
    expect(FRAG).toMatch(/u_fx\.x\s*\+\s*contour \* u_fx\.y/);
    expect(FRAG).toContain('* u_lines');
    expect(FRAG).toContain('* u_retroAmt');
    expect(FRAG).toContain('* u_relief');
  });
});

describe('地平线：内核复用与确定性', () => {
  it('复用材质型 3D 内核与共用噪声库，不自带第二份 hash', () => {
    expect(FRAG.startsWith(NOISE_GLSL)).toBe(true);
    expect(FRAG).toContain('sdfMarchMat(');
    expect(FRAG).toContain('sdfRay(');
    expect(FRAG).toContain('sdfNormalMat(');
    expect(FRAG).toContain('vec3 sdHorizon(vec3 p)');
    expect(FRAG.includes('float vnoise2('), '又贴了一份私有噪声').toBe(false);
    expect(FRAG.includes('43758.5453'), '用了带 sin 的 hash').toBe(false);
  });

  it('octaves 的选项与映射表对齐，且不超过噪声库的循环上界', () => {
    const p = param('octaves');
    expect(p.type).toBe('select');
    if (p.type !== 'select') throw new Error('unreachable');
    expect(p.options.map((o) => o.value).sort()).toEqual(Object.keys(HORIZON_OCTAVES).sort());
    expect(HORIZON_OCTAVES[p.defaultValue]).toBe(Number(p.defaultValue));
    for (const value of p.options.map((o) => o.value)) {
      expect(HORIZON_OCTAVES[value]).toBeLessThanOrEqual(NZ_MAX_OCTAVES);
    }
  });

  it('时钟只从 horizonTravel() 进画面：speed = 0 时与 t 逐点无关', () => {
    const uses = FRAG.match(/\bu_time\b/g) ?? [];
    expect(uses, '第二处直接读时钟会让 speed = 0 失效').toHaveLength(1);
    expect(FRAG).toContain('return u_time * u_speed;');
  });

  it('网格线宽不用 fwidth（命中判定是非一致控制流）', () => {
    expect(FRAG.includes('fwidth(')).toBe(false);
    expect(FRAG).toContain('u_resolution.y');
  });
});

describe('地平线：目录与文案', () => {
  it('每个参数与风格选项的文案键都解析得出来', () => {
    const zh = LOCALES['zh-CN'] as Record<string, string>;
    for (const p of horizonDef.params) {
      expect(zh[String(p.labelKey)], `${p.key} 的文案键解析不出来`).toBeTruthy();
      if (p.type === 'select') {
        for (const o of p.options) expect(zh[String(o.labelKey)], `${p.key}/${o.value} 的选项文案缺失`).toBeTruthy();
      }
    }
    expect(zh[ALGO_CATALOG['horizon']!.descKey]).toBeTruthy();
  });
});
