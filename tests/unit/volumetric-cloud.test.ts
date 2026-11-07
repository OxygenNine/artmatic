import { describe, expect, it } from 'vitest';
import { CLOUD_MAX_STEPS, CLOUD_OCTAVES, volumetricCloudDef } from '../../src/algos/volumetric-cloud';
import { NOISE_GLSL } from '../../src/algos/noise-lib';

/**
 * 「体积云」的结构守卫。
 *
 * 这一层能纯测的只有形状：云本身在 GPU 上，像素级判据在
 * `tests/e2e/algo-cloud.spec.ts`。但下面这几类形状错了全是**静默失效** ——
 * 选项还在、滑杆还能拖，画面只是不跟着变。
 */

/** `GeneratorDef` 是联合类型，`fragment` 只在 realtime 那一支上。 */
const FRAG = volumetricCloudDef.kind === 'realtime' ? volumetricCloudDef.fragment : '';

const param = (key: string) => {
  const p = volumetricCloudDef.params.find((q) => q.key === key);
  expect(p, `缺参数 ${key}`).toBeDefined();
  return p!;
};

describe('体积云：参数表与 shader 的编译期上界同源', () => {
  it('steps 的上限等于 shader 的循环上界（超了 = 拖到底也不再变）', () => {
    const p = param('steps');
    expect(p.type).toBe('range');
    if (p.type !== 'range') throw new Error('unreachable');
    expect(p.max).toBe(CLOUD_MAX_STEPS);
    // 循环必须是常量界 + break（动态界的循环在部分驱动上会退化，见 noise-lib）
    expect(FRAG).toContain(`const int VC_MAX_STEPS = ${CLOUD_MAX_STEPS};`);
    expect(FRAG).toContain('i < VC_MAX_STEPS');
    expect(FRAG).toContain('if (i >= u_steps) break;');
  });

  it('octaves 的选项与映射表逐项对齐（缺一项 = 那个选项静默退化成 1 阶）', () => {
    const p = param('octaves');
    expect(p.type).toBe('select');
    if (p.type !== 'select') throw new Error('unreachable');
    expect(p.options.map((o) => o.value).sort()).toEqual(Object.keys(CLOUD_OCTAVES).sort());
    // 缺省值必须落在映射表里，否则出厂就是「选项在、值不在」
    expect(CLOUD_OCTAVES[p.defaultValue]).toBe(Number(p.defaultValue));
  });

  it('阶数上限不超过噪声库的编译期上界', () => {
    const p = param('octaves');
    if (p.type !== 'select') throw new Error('unreachable');
    for (const value of p.options.map((o) => o.value)) {
      expect(CLOUD_OCTAVES[value]).toBeLessThanOrEqual(6);
    }
  });
});

describe('体积云：噪声与透明底的写法', () => {
  it('用共用噪声库，不自带第二份 hash / 噪声实现', () => {
    // 私有实现会长出第二套口径，而「同一份 fragment 里拼两份 hash」是直接编译失败
    expect(FRAG.startsWith(NOISE_GLSL)).toBe(true);
    expect(FRAG).toContain('nzFbm3(');
    expect(FRAG.includes('float vnoise3('), '又贴了一份私有噪声').toBe(false);
    expect(FRAG.includes('43758.5453'), '用了带 sin 的 hash（大坐标下帧间闪烁）').toBe(false);
  });

  it('透明底吐的是直通 alpha（acc / alpha），不是预乘色', () => {
    /*
     * 合成链是直通（非预乘）alpha。累积出来的 acc 是**预乘**的，直接吐出去
     * 等于半覆盖的像素把云色又乘了一遍 alpha —— 边界上一圈深色轮廓，
     * 而且 "切透明" 之后才看得出来。判据就是那一步除法。
     */
    expect(FRAG).toMatch(/acc\s*\/\s*alpha/);
    expect(FRAG).toContain('vec4(cloud, alpha)');
    expect(FRAG).toMatch(/u_bgMode\s*==\s*0/);
  });

  it('高度包络只移动阈值，不乘密度', () => {
    // 乘上去边界永远勾着解析平面（烟雾那条教训）。判据：密度是 smoothstep(阈值, …, 噪声)
    expect(FRAG).toMatch(/smoothstep\(thr[^)]*,\s*n\)/);
    expect(FRAG.includes('* env;'), '包络被乘进密度了').toBe(false);
  });
});
