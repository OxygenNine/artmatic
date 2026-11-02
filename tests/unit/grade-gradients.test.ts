import { describe, expect, it } from 'vitest';
import { GRADIENT_PARAM_KEYS, masterGradient, paramGradient } from '../../src/ui/grade/gradients';
import { WHEELS, resetBasic } from '../../src/ui/grade/grade-ops';
import { params as basicParams } from '../../src/effects/defs/grade-basic';
import type { EffectInstance } from '../../src/core/schema';

/**
 * 调色面板的「轨道渐变」守卫。
 *
 * 渐变是**内容**（它说明往哪边推会发生什么），但它按参数键查表 —— 参数改名
 * 或删掉时表里会留一条死键，而症状只是「这条滑杆没有渐变」，不报错。所以
 * 用两条测试把两边钉在一起：色的表 ⊆ 参数的键，轮盘组 ⊆ 参数前缀。
 */
describe('主量渐变：四个轮盘都有', () => {
  it('每个轮盘组都给出 linear-gradient', () => {
    for (const spec of WHEELS) {
      expect(masterGradient(spec.group), spec.group).toMatch(/^linear-gradient\(/);
    }
    expect(WHEELS.map((w) => w.group)).toEqual(['lift', 'gamma', 'gain', 'offset']);
  });

  it('影调范围不同 ⇒ 渐变不同（否则「这轮子管哪一段」就丢了）', () => {
    const all = WHEELS.map((w) => masterGradient(w.group));
    expect(new Set(all).size).toBe(all.length);
  });
});

describe('参数渐变：表与参数表对齐', () => {
  const keys = new Set(basicParams.map((p) => p.key));

  it('渐变表里的每个键都真的存在于 grade-basic 的参数里', () => {
    const dead = GRADIENT_PARAM_KEYS.filter((k) => !keys.has(k));
    expect(dead, '参数改名后渐变表会留下死键（症状：那条滑杆没有渐变）').toEqual([]);
  });

  it('不在表里的键返回 null（调用方退回普通滑杆）', () => {
    expect(paramGradient('lift#m')).toBeNull();
    expect(paramGradient('not-a-param')).toBeNull();
  });
});

describe('全部复位（轮盘 + 五条滑杆）', () => {
  const inst = (): EffectInstance => ({
    instanceId: 'i',
    defId: 'grade-basic',
    enabled: true,
    values: {
      'lift#m': 0.2,
      'lift#r': 0.3,
      'gamma#m': 1.4,
      'gamma#g': -0.2,
      'gain#m': -1.5,
      'offset#b': 0.4,
      'contrast': 1.3,
    },
  });

  it('四个轮盘的主量与分量回中性', () => {
    const it = inst();
    resetBasic(it);
    for (const spec of WHEELS) {
      expect(it.values[`${spec.group}#m`]).toBe(spec.neutral);
      expect(it.values[`${spec.group}#r`]).toBe(0);
      expect(it.values[`${spec.group}#g`]).toBe(0);
      expect(it.values[`${spec.group}#b`]).toBe(0);
    }
  });

  it('对比 / 饱和 / 色相 / 色温 / 色调也一起回默认值', () => {
    /*
     * 这条一开始反过来写过（「只复位轮盘」），结果按下去画面还偏着 ——
     * 按钮写着「全部」，它就得复位这一整块。
     */
    const it = inst();
    it.values['saturation'] = 1.6;
    it.values['hue'] = 40;
    resetBasic(it);
    for (const key of ['contrast', 'saturation', 'hue', 'temp', 'tint']) {
      const def = basicParams.find((p) => p.key === key)!;
      expect(it.values[key], key).toBe(def.defaultValue);
    }
  });
});
