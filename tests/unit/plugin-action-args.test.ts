import { describe, expect, it } from 'vitest';
import { formatActionResult, resolveActionArgs, ACTION_RESULT_MAX_BYTES } from '../../src/plugins/action-args';
import type { PluginActionDef } from '../../src/plugins/api-types';

/**
 * 插件动作的参数解析。
 *
 * 判据只有一条：**拼错一个字母不能静默取默认值**。面板与 Agent 都走这里，
 * 而 Agent 拿到的是工具 schema、面板拿到的是插件自己写的按钮 —— 两条路的
 * 输入质量差很多，所以「未知键 / 类型不对 / 越界」都必须在调用 `run` 之前拒绝。
 */

function action(overrides: Partial<PluginActionDef> = {}): PluginActionDef {
  return {
    id: 'apply',
    name: { text: '应用' },
    desc: null,
    params: [
      { key: 'size', labelKey: { text: '大小' }, type: 'range', defaultValue: 4, min: 0, max: 10, step: 1 },
      { key: 'mode', labelKey: { text: '模式' }, type: 'select', defaultValue: 'a', options: [{ value: 'a', labelKey: { text: 'A' } }, { value: 'b', labelKey: { text: 'B' } }] },
      { key: 'on', labelKey: { text: '开关' }, type: 'checkbox', defaultValue: 1 },
      { key: 'color', labelKey: { text: '颜色' }, type: 'color', defaultValue: '#fff' },
      { key: 'text', labelKey: { text: '文本' }, type: 'text', defaultValue: '', maxLength: 3 },
    ],
    run: () => undefined,
    ...overrides,
  };
}

function resolve(raw: unknown, def = action()) {
  return resolveActionArgs(def, raw);
}

describe('缺省补齐', () => {
  it('不传参数时拿到全部默认值（调用方不必再写 ?? 默认值）', () => {
    const r = resolve(undefined);
    expect(r).toEqual({ ok: true, args: { size: 4, mode: 'a', on: 1, color: '#fff', text: '' } });
  });

  it('只传一部分：其余照旧补默认值', () => {
    const r = resolve({ size: 7 });
    expect(r.ok && r.args.size).toBe(7);
    expect(r.ok && r.args.mode).toBe('a');
  });

  it('没有参数的动作接受空对象', () => {
    expect(resolve({}, action({ params: [] }))).toEqual({ ok: true, args: {} });
  });
});

describe('未知键：拒绝而不是丢掉', () => {
  it('拼错一个字母', () => {
    expect(resolve({ sise: 3 })).toEqual({ ok: false, detail: 'unknown-key:sise' });
  });

  it('非对象输入', () => {
    for (const bad of ['x', 42, [1, 2]]) {
      expect(resolve(bad).ok, JSON.stringify(bad)).toBe(false);
    }
  });
});

describe('类型与范围：拒绝而不是转换 / clamp', () => {
  it('range 收字符串数字？不收', () => {
    expect(resolve({ size: '5' })).toEqual({ ok: false, detail: 'size:range' });
  });

  it('range 越界不 clamp', () => {
    expect(resolve({ size: 11 })).toEqual({ ok: false, detail: 'size:range' });
    expect(resolve({ size: -1 })).toEqual({ ok: false, detail: 'size:range' });
    expect(resolve({ size: Number.NaN })).toEqual({ ok: false, detail: 'size:range' });
  });

  it('select 只收 options 里的值', () => {
    expect(resolve({ mode: 'c' })).toEqual({ ok: false, detail: 'mode:select' });
    expect(resolve({ mode: 1 })).toEqual({ ok: false, detail: 'mode:select' });
    expect(resolve({ mode: 'b' })).toEqual({ ok: true, args: expect.objectContaining({ mode: 'b' }) });
  });

  it('checkbox 收 0/1 与 true/false，统一成 0/1', () => {
    expect(resolve({ on: false })).toEqual({ ok: true, args: expect.objectContaining({ on: 0 }) });
    expect(resolve({ on: true })).toEqual({ ok: true, args: expect.objectContaining({ on: 1 }) });
    expect(resolve({ on: 2 })).toEqual({ ok: false, detail: 'on:checkbox' });
  });

  it('color 必须是非空字符串', () => {
    expect(resolve({ color: '  ' })).toEqual({ ok: false, detail: 'color:color' });
  });

  it('text 受 maxLength 约束', () => {
    expect(resolve({ text: 'abcd' })).toEqual({ ok: false, detail: 'text:text' });
    expect(resolve({ text: 'abc' }).ok).toBe(true);
  });
});

describe('返回值整理', () => {
  it('小对象原样返回', () => {
    const value = { changed: true };
    expect(formatActionResult(value)).toEqual({ value, truncated: false });
  });

  it('超过上限时换成截断的字符串并带标记', () => {
    const big = 'x'.repeat(ACTION_RESULT_MAX_BYTES + 10);
    const r = formatActionResult(big);
    expect(r.truncated).toBe(true);
    expect(typeof r.value).toBe('string');
    expect((r.value as string).length).toBe(ACTION_RESULT_MAX_BYTES);
  });

  it('循环引用不抛', () => {
    const a: Record<string, unknown> = {};
    a.self = a;
    const r = formatActionResult(a);
    expect(typeof r.value).toBe('string');
    expect(r.truncated).toBe(false);
  });

  it('undefined 退化成字符串而不是 "undefined" 之外的意外值', () => {
    expect(formatActionResult(undefined).value).toBe(undefined);
  });
});
