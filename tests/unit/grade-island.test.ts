import { describe, expect, it } from 'vitest';
import { getEffect, listBuiltinEffects } from '../../src/effects/registry';
import { isGradeDef } from '../../src/core/grade';

/**
 * 「线性岛」的守卫：解码与编码必须成对，且只出现在调色 pass 里。
 *
 * 规则（`core/grade.ts` 文件头）：16F 只提高位深、不改变编码，所以中间缓冲里
 * 装的仍是 sRGB 编码值；只有**调色 pass 自己的 main 内部**临时 `toLinear()`，
 * 算完 `toSrgb()` 写回。一次 pass 里解码两次、或者某个非调色特效顺手解码，
 * 都会让「同一组参数在任何位置插入都得到同一个结果」这条不成立 —— 而且不报错，
 * 只是观感不同，所以只能靠守卫。
 *
 * 现在没有 `grade-*` 模块，前两条是空的；它们是为 P1 那四个模块准备的，
 * 落地时不需要再想起这里。
 */

const EFFECTS = listBuiltinEffects().map((e) => e.id);
const fragmentOf = (id: string): string => {
  const entry = getEffect(id);
  if (!entry) throw new Error(`registry 里没有 ${id}`);
  return entry.shader.fragment;
};

const countOf = (haystack: string, needle: string): number => haystack.split(needle).length - 1;

describe('线性岛：边界只有一处', () => {
  it('守卫有覆盖面（注册表非空）', () => {
    expect(EFFECTS.length).toBeGreaterThan(50);
  });

  it('每个调色模块只有一个出口：`outColor = vec4(toSrgb(` 恰好一次', () => {
    /*
     * 判据放在**出口**而不是「调用总次数」：模块内部可以有自己的子岛
     * （`grade-lut` 要先把线性值编到 LUT 的空间、查表之后再解回线性，
     * 那是它自己的两对 decode/encode）。真正不能有的是**第二个出口** ——
     * 那意味着画面有两条写回路径，其中一条一定绕过了编码。
     */
    const grade = EFFECTS.filter(isGradeDef);
    const bad: string[] = [];
    for (const id of grade) {
      const f = fragmentOf(id);
      const exits = countOf(f, 'outColor = vec4(toSrgb(');
      const decodes = countOf(f, 'toLinear(');
      if (exits !== 1 || decodes < 1) bad.push(`${id}: 出口×${exits} decode×${decodes}`);
    }
    expect(bad, '调色 pass 必须只有一个编码出口，且至少解码一次').toEqual([]);
  });

  it('非调色模块不碰传输函数', () => {
    const bad = EFFECTS.filter((id) => !isGradeDef(id)).filter((id) => {
      const f = fragmentOf(id);
      return f.includes('toLinear(') || f.includes('toSrgb(');
    });
    expect(
      bad,
      '这些特效在调色之外解码了。要么它其实是调色模块（改名为 grade-*），' +
        '要么这条规则要扩写 —— 不要绕过去',
    ).toEqual([]);
  });
});
