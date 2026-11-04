/**
 * 3D 场景（`scene3d.ts` + `sdf-compose.ts`）的契约守卫。
 *
 * 场景的片段是**运行期拼的**，两个最贵的失效都在字符串层，而且都不报错：
 *
 * 1. **uniform 没有改名** —— 两个槽都放 menger 时共享 `u_depth`，于是拖一个
 *    槽的深度另一个跟着变。画面看起来「参数联动」，没有任何报错。
 * 2. **函数没有改名** —— 同名函数定义两遍，`redefinition` 只在真 GL 里出现；
 *    单测看 false green。
 *
 * 所以这里的判据是**逐槽的期望集合做差集**（与 `lab.spec` 里 `ACTIVE_UNIFORMS`
 * 那条同一个手法，只是这里不需要真 GL）。
 */

import { describe, expect, it } from 'vitest';
import { getGenerator } from '../../src/algos/registry';
import { declaredUniforms } from '../../src/algos/shader-lib';
import { SDF_GEOMS, getSdfGeom } from '../../src/algos/sdf-geoms';
import { geomFunctions, namespaceGeom, slotValues } from '../../src/algos/sdf-compose';
import { activeSlots, buildScene, sceneDefaults, SCENE_SLOTS } from '../../src/algos/scene3d';
import { visibleParams } from '../../src/effects/types';

const DEF = getGenerator('scene-3d')!;

/** 以出厂参数为底，覆盖几个槽的 def。 */
function withSlots(defs: (string | null)[]): Record<string, number | string> {
  const v = { ...sceneDefaults };
  for (let i = 0; i < SCENE_SLOTS; i++) {
    v[`s${i + 1}.def`] = defs[i] ?? 'none';
  }
  // 至少留一个槽，否则测的不是拼装而是空场那条分支
  if (defs.every((d) => d === null)) v['s1.def'] = 'menger';
  return v;
}

describe('GEOM 命名空间重写', () => {
  it('几何体源码里的顶层函数都被认出来（含辅助函数）', () => {
    expect(geomFunctions(SDF_GEOMS['menger']!.src).sort()).toEqual(['sdMenger', 'twistY']);
    expect(geomFunctions(SDF_GEOMS['apollonian']!.src).sort()).toEqual([
      'apollFold',
      'sdApollonian',
    ]);
  });

  it('改名之后没有漏网的名字', () => {
    for (const [id, geom] of Object.entries(SDF_GEOMS)) {
      const { src, fn, uniforms } = namespaceGeom(geom, 's1_');
      expect(fn, `${id}: SDF 函数名没加前缀`).toBe(`s1_${geom.name}`);
      for (const f of geomFunctions(geom.src)) {
        // 原名作为独立标识符必须一个都不剩（前缀版里含它，但那是另一个词）
        expect(src, `${id}: 函数 ${f} 被引用时没改名`).not.toMatch(new RegExp(`\\b${f}\\b`));
        expect(src, `${id}: 函数 ${f} 的前缀版不见了`).toMatch(new RegExp(`\\bs1_${f}\\b`));
      }
      for (const u of uniforms) {
        expect(src, `${id}: uniform ${u} 没改名`).not.toMatch(new RegExp(`\\b${u}\\b`));
        const renamed = `u_s1_${u.slice(2)}`;
        expect(declaredUniforms(src).has(renamed), `${id}: ${renamed} 没有声明`).toBe(true);
        // 声明之外还必须**被读到**：只改声明不改使用点 = 静默读到另一个槽的值
        expect(src.split(renamed).length - 1, `${id}: ${renamed} 只有声明、没有被读`).toBeGreaterThan(1);
      }
    }
  });

  it('同一几何体放两个槽：两套函数名、两套 uniform', () => {
    const v = withSlots(['menger', 'menger', null, null]);
    const frag = buildScene(v).fragment;
    expect(frag).toMatch(/float s1_sdMenger\(vec3 p\)/);
    expect(frag).toMatch(/float s2_sdMenger\(vec3 p\)/);
    expect(frag).toMatch(/u_s1_depth/);
    expect(frag).toMatch(/u_s2_depth/);
    // 裸名不能再出现：`u_depth` 一旦还在，两个槽就共享同一个值
    expect(frag).not.toMatch(/\bu_depth\b/);
    expect(frag).not.toMatch(/\bsdMenger\b/);
  });
});

describe('场景拼装：uniform 覆盖面', () => {
  const combos: (string | null)[][] = [
    ['menger'],
    ['menger', 'mandelbulb'],
    ['mandelbulb', 'apollonian', 'menger'],
    ['apollonian', 'apollonian', 'mandelbulb', 'menger'],
    ['menger', null, 'apollonian'],
  ];

  it.each(combos.map((c) => [c.join('+') || 'empty', c] as const))(
    '%s：每个槽的几何 uniform 都在，且都带自己的前缀',
    (_label, combo) => {
      const v = withSlots(combo as (string | null)[]);
      const frag = buildScene(v).fragment;
      const declared = declaredUniforms(frag);
      const slots = activeSlots(v);
      expect(slots.length).toBe(combo.filter(Boolean).length);

      for (const s of slots) {
        for (const key of s.geom.keys) {
          // `extent` 由槽的 `fold` 驱动（几何体不暴露它），所以它不在 keys 里
          expect(
            declared.has(`u_s${s.n}_${key}`),
            `槽 ${s.n}（${s.id}）缺 u_s${s.n}_${key}`,
          ).toBe(true);
        }
        // 框架量
        for (const k of ['pos', 'rot', 'zoom', 'fold', 'mat']) {
          const ty = k === 'mat' ? 'int' : k === 'pos' ? 'vec3' : 'float';
          expect(declared.get(`u_s${s.n}_${k}`), `槽 ${s.n} 缺 u_s${s.n}_${k}`).toBe(ty);
        }
        /*
         * `op` 只有「前面还有槽」的那些才有：首槽没人和它组合，声明了也没人读，
         * 而「声明了没被读」会被链接器丢掉（`lab.spec` 的 dropped 判据直接红）。
         */
        if (s === slots[0]) {
          expect(declared.has(`u_s${s.n}_op`), `首槽不该声明 u_s${s.n}_op`).toBe(false);
        } else {
          expect(declared.get(`u_s${s.n}_op`), `槽 ${s.n} 缺 u_s${s.n}_op`).toBe('int');
        }
      }

      // 场景级：内核 5 + 光照 4 + 材质 3 + 背景 + 输出 / 天空 + 相机 3 + 着色 9
      for (const n of [
        'u_steps',
        'u_maxDist',
        'u_stepScale',
        'u_eps',
        'u_fov',
        'u_light',
        'u_gain',
        'u_fog',
        'u_ao',
        'u_color',
        'u_colorB',
        'u_colorC',
        'u_bg',
        'u_bgMode',
        'u_outDepth',
        'u_sky',
        'u_skyTop',
        'u_skyLow',
        'u_dist',
        'u_push',
        'u_rate',
        'u_shadow',
        'u_shadowSteps',
        'u_gloss',
        'u_ambient',
        'u_pointPos',
        'u_pointPow',
        'u_pointCol',
        'u_fogCol',
        'u_tonemap',
      ]) {
        expect(declared.has(n), `场景缺 ${n}`).toBe(true);
      }

      // 不该出现的：场景没有「按高度双色」的调色板
      expect(declared.has('u_palette')).toBe(false);
    },
  );

  it('def.fragment 就是出厂参数那一份（预编译与运行期必须是同一个结构）', () => {
    expect(DEF.kind).toBe('realtime');
    if (DEF.kind !== 'realtime') return;
    expect(DEF.fragment).toBe(buildScene(sceneDefaults).fragment);
    expect(DEF.build?.(sceneDefaults).name).toBe(DEF.build?.(sceneDefaults).name);
  });

  it('换槽 = 换 program 名（否则会复用上一组几何的 program）', () => {
    if (DEF.kind !== 'realtime') return;
    const a = DEF.build!(withSlots(['menger'])).name;
    const b = DEF.build!(withSlots(['menger', 'mandelbulb'])).name;
    const c = DEF.build!(withSlots(['apollonian'])).name;
    expect(new Set([a, b, c]).size).toBe(3);
    // 同一组合必须稳定（否则每帧重编）
    expect(DEF.build!(withSlots(['menger'])).name).toBe(a);
  });

  it('空槽不占代码：全 none 时仍能拼出一份合法的空场', () => {
    const v = { ...sceneDefaults };
    for (let i = 1; i <= SCENE_SLOTS; i++) v[`s${i}.def`] = 'none';
    const frag = buildScene(v).fragment;
    expect(activeSlots(v)).toEqual([]);
    expect(frag).toMatch(/vec3 sdScene\(vec3 p\) \{ return vec3\(1\.0e6, 0\.0, 0\.0\); \}/);
    expect(frag).not.toMatch(/sdSlot/);
    // 主流程还在（否则画面是黑的而不是底色）
    expect(frag).toContain('sdfMarchMat(');
    /*
     * `main` 无条件调用 `sceneMat` 与 `sceneBackground`，而空场景不生成任何槽代码
     * —— 这两段必须与槽无关地拼进去。漏了就是编译失败，**而单测只看字符串时
     * 完全看不出来**（踩过一次：把最后一个槽设成空，画面直接黑掉）。
     */
    expect(frag).toMatch(/vec3 sceneMat\(float m\)/);
    expect(frag).toMatch(/vec4 sceneBackground\(vec3 rd\)/);
  });

  it('每种槽组合都拼得出 sceneMat / sceneBackground（main 会无条件调它们）', () => {
    for (const combo of [['menger'], ['menger', 'mandelbulb'], ['apollonian', 'apollonian']]) {
      const frag = buildScene(withSlots(combo)).fragment;
      expect(frag, `${combo.join('+')} 缺 sceneMat`).toMatch(/vec3 sceneMat\(float m\)/);
      expect(frag, `${combo.join('+')} 缺 sceneBackground`).toMatch(/vec4 sceneBackground\(vec3 rd\)/);
    }
  });
});

describe('槽的参数表', () => {
  const keys = DEF.params.map((p) => p.key);

  it('槽的选项与 SDF_GEOMS 对齐（少一个就是「选不到」）', () => {
    const def = DEF.params.find((p) => p.key === 's1.def');
    expect(def?.type).toBe('select');
    if (def?.type !== 'select') return;
    expect(def.options.map((o) => o.value).sort()).toEqual(['none', ...Object.keys(SDF_GEOMS)].sort());
  });

  it('每个几何体的键都在对应槽的表里（`s1.power` 这种）', () => {
    for (let n = 1; n <= SCENE_SLOTS; n++) {
      for (const geom of Object.values(SDF_GEOMS)) {
        for (const k of geom.keys) {
          expect(keys, `槽 ${n} 缺 s${n}.${k}（${geom.name}）`).toContain(`s${n}.${k}`);
        }
      }
    }
  });

  it('出厂状态下槽 1 露出 menger 的参数、不露出 mandelbulb 的', () => {
    const shown = visibleParams(DEF.params, sceneDefaults).map((p) => p.key);
    expect(shown).toContain('s1.depth');
    expect(shown).toContain('s1.twist');
    expect(shown).not.toContain('s1.power');
    // 槽 2 出厂是 mandelbulb
    expect(shown).toContain('s2.power');
    expect(shown).not.toContain('s2.depth');
  });

  it('把槽 1 换成 mandelbulb：menger 的参数消失、power 出现', () => {
    const v = { ...sceneDefaults, 's1.def': 'mandelbulb' };
    const shown = visibleParams(DEF.params, v).map((p) => p.key);
    expect(shown).toContain('s1.power');
    expect(shown).not.toContain('s1.depth');
  });

  it('无限延伸打开时藏掉扭转（折叠域里扭转会让 cell 边界撕开）', () => {
    const v = { ...sceneDefaults, 's1.fold': 'on' };
    const shown = visibleParams(DEF.params, v).map((p) => p.key);
    expect(shown).toContain('s1.depth');
    expect(shown).not.toContain('s1.twist');
  });

  it('槽值能还原成几何体认识的样子（去掉前缀）', () => {
    const v = { 's1.power': 5, 's2.power': 9, power: 1 };
    expect(slotValues(v, 's1.')).toEqual({ power: 5 });
  });
});

describe('拆分本身：单生成器与场景共用同一份几何', () => {
  it('三个分形的 fragment 里，几何体内核来自同一个真源', () => {
    for (const id of Object.keys(SDF_GEOMS)) {
      const geom = getSdfGeom(id)!;
      const frag = (getGenerator(id) as { fragment: string }).fragment;
      // 逐字包含（不是「长得像」）：几何改动只可能来自 sdf-geoms.ts
      for (const line of geom.src.split('\n').filter((l) => l.trim().startsWith('float '))) {
        expect(frag, `${id} 的 fragment 与 SDF_GEOMS 不一致`).toContain(line.trim());
      }
      expect(frag).toContain(`float ${geom.name}(vec3 p)`);
    }
  });

  it('深度输出读的是 u_outDepth（P2 的蒙版源）', () => {
    const frag = buildScene(sceneDefaults).fragment;
    expect(frag).toMatch(/if \(u_outDepth == 1\)/);
    /*
     * 背景在深度模式下必须是 0，**且 alpha 必须是 1**。
     * 吐 alpha 0 的话当蒙版时背景读到的是层残留（实测是 0.8 均匀灰），
     * 而直接看画面完全正常 —— 这个坑踩过。
     */
    expect(frag).toMatch(/if \(u_outDepth == 1\) return vec4\(0\.0, 0\.0, 0\.0, 1\.0\);/);
    expect(frag).toMatch(/vec4\(vec3\(1\.0 - clamp\(hit \/ max\(u_maxDist, 1e-3\), 0\.0, 1\.0\)\), 1\.0\)/);
  });
});
