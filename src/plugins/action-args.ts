/**
 * action-args.ts — 插件动作的**参数解析**（纯函数，可单测）。
 *
 * 为什么需要它：面板与 Agent 两条路都会调 `actions[].run(api, args)`，
 * 而两边的输入质量完全不同 —— 面板是插件自己写的按钮（值通常是对的），
 * Agent 是模型按工具 schema 拼出来的（拼错一个字母、把 0.5 写成 "0.5"
 * 都很常见）。**静默取默认值**是最坏的结果：回执说成功了，画面没变。
 *
 * 所以这里的判据与 Agent 工具那条纪律一致：
 *   - 未知键 **拒绝**，不静默丢；
 *   - 类型不对 **拒绝**，不做隐式转换（`"0.5"` 不是 0.5）；
 *   - 越界值 **拒绝**，不 clamp（clamp 之后作者以为自己写的是另一个数）。
 */

import type { PluginActionArgs, PluginActionDef, PluginActionParam, PluginActionParamType } from './api-types';

export type ResolveActionResult = { ok: true; args: PluginActionArgs } | { ok: false; detail: string };

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/**
 * 把 `defaultValue` 取出来。清单校验已经保证它与类型匹配，这里只做转写。
 * `checkbox` 用 0 / 1（与 `ParamDef` 的既有口径一致，不引入第二种布尔表示）。
 */
function defaultValueOf(p: PluginActionParam): PluginActionArgs[string] {
  if (p.type === 'checkbox') return p.defaultValue ? 1 : 0;
  if (p.type === 'range') return typeof p.defaultValue === 'number' ? p.defaultValue : 0;
  if (p.type === 'select' || p.type === 'color' || p.type === 'text') {
    return typeof p.defaultValue === 'string' ? p.defaultValue : '';
  }
  return '';
}

function coerce(p: PluginActionParam, raw: unknown): { ok: true; value: PluginActionArgs[string] } | { ok: false } {
  switch (p.type as PluginActionParamType) {
    case 'range': {
      if (typeof raw !== 'number' || !Number.isFinite(raw)) return { ok: false };
      const min = p.min ?? 0;
      const max = p.max ?? 1;
      if (raw < min || raw > max) return { ok: false };
      return { ok: true, value: raw };
    }
    case 'select': {
      if (typeof raw !== 'string') return { ok: false };
      const allowed = new Set((p.options ?? []).map((o) => o.value));
      return allowed.has(raw) ? { ok: true, value: raw } : { ok: false };
    }
    case 'checkbox': {
      if (raw === true) return { ok: true, value: 1 };
      if (raw === false) return { ok: true, value: 0 };
      if (raw === 0 || raw === 1) return { ok: true, value: raw };
      return { ok: false };
    }
    case 'color': {
      return typeof raw === 'string' && raw.trim().length > 0 ? { ok: true, value: raw } : { ok: false };
    }
    case 'text': {
      if (typeof raw !== 'string') return { ok: false };
      if (p.maxLength !== undefined && raw.length > p.maxLength) return { ok: false };
      return { ok: true, value: raw };
    }
    default:
      return { ok: false };
  }
}

/**
 * 解析一次动作调用的参数。
 *
 * 结果里**一定包含全部参数键**（缺省补 `defaultValue`），调用方不需要再写
 * `args.x ?? 默认值` —— 那种写法在插件里散开之后，「默认值到底是谁的」
 * 就成了两个真相。
 */
export function resolveActionArgs(def: PluginActionDef, raw: unknown): ResolveActionResult {
  if (raw !== undefined && raw !== null && !isPlainObject(raw)) {
    return { ok: false, detail: 'not-object' };
  }
  const input = (raw ?? {}) as Record<string, unknown>;
  const known = new Set(def.params.map((p) => p.key));
  for (const key of Object.keys(input)) {
    if (!known.has(key)) return { ok: false, detail: `unknown-key:${key}` };
  }
  const out: PluginActionArgs = {};
  for (const p of def.params) {
    if (!(p.key in input)) {
      out[p.key] = defaultValueOf(p);
      continue;
    }
    const coerced = coerce(p, input[p.key]);
    if (!coerced.ok) return { ok: false, detail: `${p.key}:${p.type}` };
    out[p.key] = coerced.value;
  }
  return { ok: true, args: out };
}

/** 结果体积上限。一次动作能把整份文档吐回来，Agent 的上下文装不下。 */
export const ACTION_RESULT_MAX_BYTES = 16 * 1024;

export interface ActionResult {
  value: unknown;
  /** 原值的 JSON 超过上限时的标记（`value` 已被换成截断后的字符串）。 */
  truncated: boolean;
}

/**
 * 把动作返回值整理成可以直接回给 Agent 的形状。
 *
 * 循环引用 / `BigInt` / 函数都会让 `JSON.stringify` 抛 —— 插件返回值是
 * 不可信输入，这里**不抛**，退化成 `String(value)`。
 */
export function formatActionResult(value: unknown, maxBytes = ACTION_RESULT_MAX_BYTES): ActionResult {
  // `undefined` 是「动作没有返回值」的正常情况，不该变成字符串 "undefined"。
  if (value === undefined) return { value: undefined, truncated: false };
  let text: string;
  /** JSON 化失败（循环引用 / BigInt / 函数）时为 true：`text` 是退化后的字符串。 */
  let lossy = false;
  try {
    const json = JSON.stringify(value);
    if (json === undefined) {
      lossy = true;
      text = String(value);
    } else {
      text = json;
    }
  } catch {
    lossy = true;
    text = String(value);
  }
  if (text.length > maxBytes) return { value: text.slice(0, maxBytes), truncated: true };
  return lossy ? { value: text, truncated: false } : { value, truncated: false };
}
