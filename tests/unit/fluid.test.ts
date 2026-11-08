import { describe, expect, it } from 'vitest';
import {
  FLUID_DEFAULTS,
  FLUID_DOMAIN_ASPECT,
  FLUID_MOTIONS,
  FLUID_SIM_RES_OPTIONS,
  FLUID_VOLATILE_KEYS,
  dissipationPerStep,
  fluidParamKeys,
  jetAt,
  jetColor,
  jetHue,
  normalizeFluidConfig,
} from '../../src/algos/fluid/config';
import { fluidParams } from '../../src/algos/fluid/params';
import { FLUID_SHADERS } from '../../src/algos/fluid/glsl';
import { fluidDef } from '../../src/algos/fluid';
import { DEFAULT_LIMITS, FLUID_SIM_STEPS, fluidCapacity } from '../../src/core/capacity';

/**
 * 流体的**纯函数守卫**。
 *
 * GL 那一侧只能靠 E2E（`tests/e2e/algo-fluid.spec.ts`）与「全部编译」看见；
 * 这里钉住的是三件**静默失效**的事：
 *
 * 1. 参数表与归一化读的键漂了 —— 多一个参数拖了没反应、少一个永远用缺省值；
 * 2. 状态键被列进了 `volatile` —— 改注入量 / 色相不重放，于是「同一 t 两渲
 *    不同」（硬约束 1.3 的直接违反，而且只在回溯时才看得出）；
 * 3. 喷嘴轨迹跳变 —— 差分方向爆掉，那一帧朝随机方向喷一股，看起来像偶发尖刺。
 */

const cfgOf = (over: Record<string, number | string> = {}) =>
  normalizeFluidConfig({ ...over }, DEFAULT_LIMITS);

describe('流体：配置归一化', () => {
  it('缺键时全部回落到出厂的可用值', () => {
    const c = cfgOf();
    expect(c.texH).toBe(Number(FLUID_DEFAULTS.simRes));
    expect(c.texW).toBe(Math.round(c.texH * FLUID_DOMAIN_ASPECT));
    expect(c.stepsPerSec).toBe(FLUID_DEFAULTS.rate);
    expect(c.dt).toBeCloseTo(1 / FLUID_DEFAULTS.rate, 10);
    expect(c.nozzles).toBe(FLUID_DEFAULTS.nozzles);
    expect(c.pressureIter).toBe(FLUID_DEFAULTS.pressureIter);
    expect(c.bgMode).toBe(0);
  });

  it('非有限 / 越界值被夹取，而不是变成 NaN 传进 shader', () => {
    const c = normalizeFluidConfig(
      {
        nozzles: 99, inject: -1, radius: 0, force: 'oops',
        pressureIter: 999, curl: NaN, contrast: 0.001,
      },
      DEFAULT_LIMITS,
    );
    for (const v of Object.values(c)) {
      if (typeof v === 'number') expect(Number.isFinite(v), `归一化漏了一个 NaN：${v}`).toBe(true);
    }
    expect(c.nozzles).toBe(4);
    expect(c.inject).toBe(0);
    expect(c.radius).toBe(0.01);
    expect(c.pressureIter).toBe(32);
  });

  it('simRes 落在档位表里，且不超过本机预算派生出的上限', () => {
    const cap = fluidCapacity(DEFAULT_LIMITS);
    for (const v of FLUID_SIM_RES_OPTIONS) {
      const c = cfgOf({ simRes: v });
      expect(FLUID_SIM_STEPS as readonly number[]).toContain(c.texH);
      expect(c.texH, `simRes=${v} 超过了本机上限 ${cap.maxSimH}`).toBeLessThanOrEqual(cap.maxSimH);
    }
    // 缺省档与「乱填一个」都落在合法档位上；201 会落到 ≤ 201 的最大档
    expect(cfgOf({ simRes: 'nonsense' }).texH).toBe(Number(FLUID_DEFAULTS.simRes));
    expect(cfgOf({ simRes: '201' }).texH).toBe(192);
  });

  it('参数表的默认值与归一化的兜底同源（各写一份会只在手改工程上分叉）', () => {
    const defs = new Map(fluidParams().map((p) => [p.key, p]));
    for (const [k, v] of Object.entries(FLUID_DEFAULTS)) {
      const p = defs.get(k);
      expect(p, `FLUID_DEFAULTS 里的 ${k} 在参数表里不存在`).toBeDefined();
      expect(p!.defaultValue, `${k} 的默认值两边不一致`).toEqual(v);
    }
  });

  it('域是 16:9：改 simRes 只改分辨率，不改构图比例', () => {
    for (const v of FLUID_SIM_RES_OPTIONS) {
      const c = cfgOf({ simRes: v });
      expect(c.domainAspect).toBeCloseTo(FLUID_DOMAIN_ASPECT, 10);
      expect(Math.abs(c.texW / c.texH - FLUID_DOMAIN_ASPECT)).toBeLessThan(0.02);
    }
  });

  it('透明底由 bgMode 单一开关决定', () => {
    expect(cfgOf({ bgMode: 'transparent' }).bgMode).toBe(1);
    expect(cfgOf({ bgMode: 'solid' }).bgMode).toBe(0);
    expect(cfgOf({ bgMode: 'garbage' }).bgMode).toBe(0);
  });

  it('maskAsset 只有非空字符串才算绑定', () => {
    expect(cfgOf({ maskAsset: '' }).maskOn).toBe(0);
    expect(cfgOf({ maskAsset: 42 }).maskOn).toBe(0);
    expect(cfgOf({ maskAsset: 'a1' }).maskOn).toBe(1);
  });
});

describe('流体：参数表与归一化的键空间对齐', () => {
  it('参数表覆盖归一化读到的每个键（多 / 少都会静默失效）', () => {
    const keys = fluidParamKeys(fluidParams());
    const required = [
      'nozzles', 'inject', 'radius', 'force', 'motion', 'pathScale', 'pathSpeed',
      'curl', 'pressureIter', 'velDissipation', 'dyeDissipation',
      'hue', 'hueSpread', 'saturation', 'brightness',
      'shading', 'glow', 'hueShift', 'contrast',
      'bgMode', 'colorBg', 'maskAsset', 'maskChannel', 'maskThreshold',
      'simRes', 'rate', 'intRes',
    ];
    expect(required.filter((k) => !keys.has(k))).toEqual([]);
  });

  it('simRes 的选项值与档位表同源', () => {
    const def = fluidParams().find((p) => p.key === 'simRes')!;
    expect(def.type).toBe('select');
    if (def.type !== 'select') return;
    expect(def.options.map((o) => o.value)).toEqual([...FLUID_SIM_RES_OPTIONS]);
  });

  it('motion 的选项值与 FLUID_MOTIONS 同源', () => {
    const def = fluidParams().find((p) => p.key === 'motion')!;
    expect(def.type).toBe('select');
    if (def.type !== 'select') return;
    expect(def.options.map((o) => o.value)).toEqual([...FLUID_MOTIONS]);
  });
});

describe('流体：volatile 只列渲染量', () => {
  /*
   * 判据是「这些键写进了状态」：注入量 / 力 / 耗散 / 色相都进 dye 与 velocity，
   * 不重放就会得到「改了色相但墨流还是旧颜色」—— 而它**不报错**，只是
   * `seek(f) ≠ 顺序 step f 次`。
   */
  const STATE_KEYS = [
    'nozzles', 'inject', 'radius', 'force', 'motion', 'pathScale', 'pathSpeed',
    'curl', 'pressureIter', 'velDissipation', 'dyeDissipation',
    'hue', 'hueSpread', 'saturation', 'brightness',
    'simRes', 'maskAsset', 'maskChannel', 'maskThreshold',
  ];

  it('没有任何状态键被列进 volatile', () => {
    const vol = new Set(FLUID_VOLATILE_KEYS);
    expect(STATE_KEYS.filter((k) => vol.has(k)), '这些键改了不会重放，seek 会与顺序播放分叉').toEqual([]);
  });

  it('渲染量确实被排除（否则拉一下亮度就重放整段）', () => {
    const vol = new Set(FLUID_VOLATILE_KEYS);
    for (const k of ['shading', 'glow', 'hueShift', 'contrast', 'bgMode', 'colorBg', 'rate', 'intRes']) {
      expect(vol.has(k), `${k} 应当排除在构造哈希之外`).toBe(true);
    }
  });

  it('def 的 volatile 与 config 的清单一致', () => {
    expect(new Set(fluidDef.volatile)).toEqual(new Set(FLUID_VOLATILE_KEYS));
  });
});

describe('流体：gen 器形态', () => {
  it('是 gpu-sim，且给出了预编译清单', () => {
    expect(fluidDef.kind).toBe('gpu-sim');
    const list = fluidDef.kind === 'gpu-sim' ? fluidDef.programs?.() ?? [] : [];
    expect(list.length).toBe(Object.keys(FLUID_SHADERS).length);
    // 名字必须唯一：`Kit.quad` 按名缓存，撞名意味着「拿错的那份 program」
    const names = list.map((p) => p.name);
    expect(new Set(names).size).toBe(names.length);
    // 每段都必须自带 `#version`（它们不走 ALGO_HEAD 拼接）
    for (const p of list) expect(p.fragment.startsWith('#version 300 es'), `${p.name} 缺 #version`).toBe(true);
  });

  it('声明了蒙版 aux，且指向一个真实存在的 asset 参数', () => {
    const refs = fluidDef.kind === 'gpu-sim' ? fluidDef.auxTextures ?? [] : [];
    expect(refs.length).toBe(1);
    const keys = fluidParamKeys(fluidParams());
    expect(keys.has(refs[0]!.assetParam ?? '')).toBe(true);
  });
});

describe('流体：喷嘴轨迹', () => {
  const cfg = cfgOf();

  it('是 (i, 步号) 的纯函数 —— seek 重放才会逐位相同', () => {
    for (const step of [0, 1, 37, 480]) {
      for (let i = 0; i < 4; i++) {
        expect(jetAt(i, step, cfg)).toEqual(jetAt(i, step, cfg));
      }
    }
  });

  it('轨迹恒在域内', () => {
    for (let step = 0; step < 900; step += 7) {
      for (let i = 0; i < 4; i++) {
        const j = jetAt(i, step, cfg);
        expect(j.x).toBeGreaterThanOrEqual(0);
        expect(j.x).toBeLessThanOrEqual(1);
        expect(j.y).toBeGreaterThanOrEqual(0);
        expect(j.y).toBeLessThanOrEqual(1);
      }
    }
  });

  /**
   * 跳变会让数值差分的方向爆掉：位置一夜跳 0.3 而方向仍然是「一步的差」，
   * 于是那一帧朝某个随机方向喷出一股。判据取「相邻两步位移 < 0.02」
   * （最急的默认轨迹每步约 0.004）。
   */
  it('相邻两步位移足够小（数值差分方向不会爆）', () => {
    for (const motion of FLUID_MOTIONS) {
      const c = cfgOf({ motion, pathSpeed: 2, pathScale: 1 });
      for (let step = 0; step < 300; step++) {
        for (let i = 0; i < 4; i++) {
          const a = jetAt(i, step, c);
          const b = jetAt(i, step + 1, c);
          const d = Math.hypot(a.x - b.x, a.y - b.y);
          expect(d, `motion=${motion} step=${step} 跳了 ${d.toFixed(4)}`).toBeLessThan(0.06);
        }
      }
    }
  });

  it('still 模式只染色不推流（方向恒 0）', () => {
    const c = cfgOf({ motion: 'still' });
    for (let i = 0; i < 4; i++) {
      const j = jetAt(i, 12, c);
      expect(j.dx).toBe(0);
      expect(j.dy).toBe(0);
    }
  });

  it('不同模式给出不同位置（否则 motion 是个拖了没反应的控件）', () => {
    const at = (m: string) => jetAt(0, 40, cfgOf({ motion: m }));
    const pts = FLUID_MOTIONS.map(at);
    for (let a = 0; a < pts.length; a++) {
      for (let b = a + 1; b < pts.length; b++) {
        const d = Math.hypot(pts[a]!.x - pts[b]!.x, pts[a]!.y - pts[b]!.y);
        expect(d, `${FLUID_MOTIONS[a]} 与 ${FLUID_MOTIONS[b]} 的位置重合`).toBeGreaterThan(1e-3);
      }
    }
  });
});

describe('流体：颜色与耗散', () => {
  it('每步衰减在 (0,1] 内，且 d=0 时恒 1', () => {
    expect(dissipationPerStep(0, 1 / 60)).toBe(1);
    const v = dissipationPerStep(0.6, 1 / 60);
    expect(v).toBeGreaterThan(0.99);
    expect(v).toBeLessThan(1);
    // 每秒总衰减 = (1/(1+d·dt))^(1/dt) → e^{-d}（d=0.6 ⇒ 0.549）。
    // **不是** 1/(1+d)：那个数只在连续极限下成立，离散成 60 步后差 12%。
    expect(Math.pow(v, 60)).toBeCloseTo(Math.exp(-0.6), 2);
  });

  it('色相展开均匀落在 [hue, hue+hueSpread) 里', () => {
    const c = cfgOf({ hue: 0.2, hueSpread: 0.4, nozzles: 4 });
    const hs = [0, 1, 2, 3].map((i) => jetHue(i, c));
    expect(hs[0]).toBeCloseTo(0.2, 10);
    expect(hs[3]).toBeCloseTo(0.5, 10);
  });

  it('RGB 三通道都在 0..brightness 内，且不同色相给出不同颜色', () => {
    const c = cfgOf({ brightness: 0.5, saturation: 1 });
    for (const h of [0, 0.17, 0.5, 0.83, 1.4, -0.3]) {
      for (const v of jetColor(h, c)) {
        expect(v).toBeGreaterThanOrEqual(-1e-9);
        expect(v).toBeLessThanOrEqual(0.5 + 1e-9);
      }
    }
    const a = jetColor(0, c);
    const b = jetColor(1 / 3, c);
    expect(Math.abs(a[0] - b[0]) + Math.abs(a[2] - b[2])).toBeGreaterThan(0.1);
  });

  it('饱和度 0 时是灰（不给「拖到 0 反而更艳」的机会）', () => {
    const g = jetColor(0.3, cfgOf({ brightness: 0.4, saturation: 0 }));
    expect(g[0]).toBeCloseTo(g[1], 6);
    expect(g[1]).toBeCloseTo(g[2], 6);
  });
});
