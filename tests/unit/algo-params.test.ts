import { describe, expect, it } from 'vitest';
import { getGenerator, listGenerators } from '../../src/algos/registry';
import { getEffect, listEffects } from '../../src/effects/registry';
import { visibleParams, type ParamDef } from '../../src/effects/types';
import { decodePattern } from '../../src/algos/pattern-codec';
import { LOCALES } from '../../src/i18n/locales';
import type { Label } from '../../src/i18n/label';

/**
 * 参数表的静态守卫 —— 补上算法/特效两侧一直缺的那一条。
 *
 * 为什么需要它：新增一种 `ParamDef` 变体时，**编译期什么都拦不住**。
 * `Inspector.svelte` 的 `{#if}` 链没有 `else`（未知类型静默不渲染），
 * lab 的 `{:else}` 更糟（把未知类型渲染成一个颜色选择器）。而 `labelKey`
 * 拼错、`visibleWhen` 引用一个不存在的键、`select` 的 `defaultValue`
 * 不在 `options` 里 —— 这三类同样不会报错，只是「那一项永远不显示」
 * 或者「显示成空白」。
 *
 * 这条测试遍历**所有注册的生成器与特效**逐个检查，于是「加了一个新参数
 * 但忘了加文案 / 忘了接 UI」会在这里变成一条明确的失败。
 */

const zh = LOCALES['zh-CN'] as Record<string, string>;

const KNOWN_TYPES = new Set([
  'range', 'select', 'checkbox', 'color', 'bitmask', 'pattern', 'text', 'asset',
]);

/**
 * 把 `Label` 解析成展示文本：文案键查表、字面量原样。
 *
 * **解析不了时返回 `undefined`**（而不是回落到键名本身）—— 这正是下面那些
 * 断言的判据。`tr()` 的「键不存在就返回键」是给**运行期**兜底的，在这里会把
 * 一个拼错的键伪装成合法文本，守卫就失效了。
 */
function textOf(label: Label): string | undefined {
  if (typeof label === 'string') return zh[label];
  return label.text.length > 0 ? label.text : undefined;
}

/** 从 `visibleWhen` 的函数源码里抠出它引用的参数键（`v.xxx`）。 */
function referencedKeys(fn: (v: Record<string, number | string>) => boolean): string[] {
  const src = fn.toString();
  const out = new Set<string>();
  for (const m of src.matchAll(/\bv\.([A-Za-z0-9_]+)/g)) out.add(m[1]!);
  return [...out];
}

function checkParams(where: string, params: ParamDef[]): void {
  const keys = new Set<string>();
  for (const p of params) {
    expect(keys.has(p.key), `${where}: 参数键 ${p.key} 重复`).toBe(false);
    keys.add(p.key);
  }

  for (const p of params) {
    const id = `${where}.${p.key}`;

    // 1. 类型必须是某个 UI 认得的类型，否则这一项会静默消失
    expect(KNOWN_TYPES.has(p.type), `${id}: 未知参数类型 ${p.type}（UI 不会渲染它）`).toBe(true);

    // 2. 文案必须能解析（内置是文案键、插件是字面量，两者都要非空）
    expect(typeof textOf(p.labelKey), `${id}: labelKey 解析不出文本`).toBe('string');

    // 3. 逐类型的结构不变量
    if (p.type === 'range') {
      expect(p.max, `${id}: max ≤ min`).toBeGreaterThan(p.min);
      expect(p.defaultValue, `${id}: 默认值越界`).toBeGreaterThanOrEqual(p.min);
      expect(p.defaultValue, `${id}: 默认值越界`).toBeLessThanOrEqual(p.max);
    } else if (p.type === 'select') {
      expect(p.options.length, `${id}: 选项为空`).toBeGreaterThan(0);
      for (const o of p.options) {
        expect(typeof textOf(o.labelKey), `${id}: 选项文案 ${JSON.stringify(o.labelKey)} 解析不出文本`).toBe(
          'string',
        );
      }
      expect(
        p.options.some((o) => o.value === p.defaultValue),
        `${id}: 默认值 ${p.defaultValue} 不在选项里`,
      ).toBe(true);
    } else if (p.type === 'bitmask') {
      const total = p.groups.reduce((n, g) => n + g.bits, 0);
      expect(total, `${id}: 分组位数之和 ≠ bits`).toBe(p.bits);
      expect(p.bits, `${id}: bits 必须为正`).toBeGreaterThan(0);
      expect(p.defaultValue, `${id}: 默认值越界`).toBeGreaterThanOrEqual(0);
      expect(p.defaultValue, `${id}: 默认值越界（应 < 2^bits）`).toBeLessThan(2 ** p.bits);
      for (const g of p.groups) {
        expect(['eca', 'count'], `${id}: 分组画法非法`).toContain(g.style);
        expect(typeof textOf(g.labelKey), `${id}: 分组文案解析不出文本`).toBe('string');
      }
      for (const o of p.presets ?? []) {
        expect(typeof textOf(o.labelKey), `${id}: 预设文案解析不出文本`).toBe('string');
        expect(o.value, `${id}: 预设值越界`).toBeGreaterThanOrEqual(0);
        expect(o.value, `${id}: 预设值越界`).toBeLessThan(2 ** p.bits);
      }
    } else if (p.type === 'pattern') {
      expect(typeof p.defaultValue, `${id}: pattern 的默认值必须是字符串`).toBe('string');
      if (p.defaultValue !== '') {
        expect(decodePattern(p.defaultValue), `${id}: 默认图案串解不出来`).not.toBeNull();
      }
    } else if (p.type === 'text') {
      expect(typeof p.defaultValue, `${id}: text 的默认值必须是字符串`).toBe('string');
      if (p.placeholderKey) {
        expect(typeof textOf(p.placeholderKey), `${id}: placeholderKey 解析不出文本`).toBe('string');
      }
    } else if (p.type === 'asset') {
      expect(typeof p.defaultValue, `${id}: asset 的默认值必须是字符串`).toBe('string');
      // 只收静态图片：视频会让任意 seek 上出现异步取帧，破坏确定性。
      expect(['image', undefined], `${id}: asset 只接受 image`).toContain(p.accept);
    }

    // 5. 分组是展示元数据，必须是非空键；拼错不会报错，只会让全屏编辑器
    //    把这一项悄悄塞进「其它」组。
    if (p.group !== undefined) {
      expect(typeof p.group, `${id}: group 必须是字符串`).toBe('string');
      expect(p.group.length, `${id}: group 不能为空`).toBeGreaterThan(0);
    }

    // 4. `visibleWhen` 引用的键必须真的存在。
    //    引用一个拼错的键 ⇒ 谓词恒为 false ⇒ 那一项永远不显示，且毫无提示。
    if (p.visibleWhen) {
      for (const ref of referencedKeys(p.visibleWhen)) {
        expect(keys.has(ref), `${id}: visibleWhen 引用了不存在的参数键 ${ref}`).toBe(true);
      }
    }
  }
}

describe('参数表守卫：所有生成器', () => {
  it('每个生成器的名字键都能解析', () => {
    const list = listGenerators();
    expect(list.length, '生成器注册表为空，守卫没有覆盖面').toBeGreaterThan(5);
    for (const g of list) {
      expect(typeof textOf(g.nameKey), `${g.id}: nameKey 解析不出文本`).toBe('string');
    }
  });

  it('每个生成器的参数表结构合法（类型 / 文案 / 默认值 / visibleWhen 引用）', () => {
    for (const g of listGenerators()) {
      const def = getGenerator(g.id);
      expect(def, g.id).not.toBeNull();
      checkParams(g.id, def!.params);
    }
  });

  it('每个生成器至少有一个参数以外的稳定标识（id 与展示名都非空）', () => {
    for (const g of listGenerators()) {
      expect(g.id.length, 'id 为空').toBeGreaterThan(0);
      expect((textOf(g.nameKey) ?? '').length, `${g.id}: 展示名为空`).toBeGreaterThan(0);
    }
  });
});

describe('参数表守卫：所有特效', () => {
  it('每个特效的参数表结构合法', () => {
    const list = listEffects();
    expect(list.length, '特效注册表为空').toBeGreaterThan(10);
    for (const e of list) {
      const entry = getEffect(e.id);
      expect(entry, e.id).not.toBeNull();
      expect(typeof textOf(e.nameKey), `${e.id}: nameKey 解析不出文本`).toBe('string');
      checkParams(e.id, entry!.params);
    }
  });
});

describe('参数表守卫：visibleParams 在默认值下可用', () => {
  it('每个生成器都能用「全默认值」过一遍可见性过滤', () => {
    for (const g of listGenerators()) {
      const def = getGenerator(g.id)!;
      expect(() => visibleParams(def.params, {}), g.id).not.toThrow();
    }
  });

  it('每个生成器至少有一项在默认参数下可见（否则检查器是一片空白）', () => {
    for (const g of listGenerators()) {
      const def = getGenerator(g.id)!;
      expect(visibleParams(def.params, {}).length, `${g.id}: 默认状态下没有任何可见参数`).toBeGreaterThan(0);
    }
  });
});
