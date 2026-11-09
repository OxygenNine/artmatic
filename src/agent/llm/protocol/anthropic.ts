/**
 * protocol/anthropic.ts — Anthropic Messages 适配器（唯一需要真写的第二套协议）。
 *
 * Anthropic 是唯一没有 OpenAI 兼容层的头部厂商，所以必须自己转消息形状。
 * 四个不能省的差异：
 *
 * 1. `system` 是**顶层参数**，不是一条消息。
 * 2. 工具结果不是 `role:'tool'`，而是 **user 消息里的 `tool_result` 块**，
 *    并且必须排在 content 数组**最前面**。
 * 3. 开思考后，assistant 回合的 `thinking` / `redacted_thinking` 块
 *    **必须原样回传（含 signature、含块序）**，否则第二轮直接 400：
 *    `messages.1.content.0.type: expected thinking or redacted_thinking`。
 *    `redacted_thinking` 连 signature 都没有，只有 `data` —— 别按 thinking 处理。
 * 4. `max_tokens` 是必填项，且必须**大于** `thinking.budget_tokens`。
 *
 * 另外 `anthropic-version` 与 `anthropic-dangerous-direct-browser-access`
 * 两个头是直连的准入条件（见注册表的 `headers`）。
 */

import { toolParameters, type ToolSpec } from '../../tools';
import { authHeaders, endpointFor, mergeHeaders } from '../providers/endpoint';
import { classifyHttpError } from '../providers/errors';
import { outputTokensFor, temperatureFor, thinkingParamsFor } from '../providers/reasoning';
import { ruleFor, thinkingPolicyFor } from '../providers/routing';
import type { ThinkingPolicy, ProviderDef } from '../providers/types';
import type { LlmConfig, LlmError, WireMessage } from '../types';
import { createAnthropicReducer } from './anthropic-stream';
import type { BuildBodyArgs, ProtocolAdapter, StreamHandlers, StreamReducer } from './types';

/* ------------------------------------------------------------------ 形状 */

/** 缓存断点标记。Anthropic 的提示词缓存是**显式**的：没有它一个字节都不会被缓存。 */
export interface CacheControl {
  cache_control?: { type: 'ephemeral' };
}

export type OutBlock = CacheControl &
  (
    | { type: 'text'; text: string }
    | { type: 'image'; source: { type: 'base64'; media_type: string; data: string } | { type: 'url'; url: string } }
    | { type: 'tool_use'; id: string; name: string; input: unknown }
    | { type: 'tool_result'; tool_use_id: string; content: string; is_error?: boolean }
    | { type: 'thinking'; thinking: string; signature: string }
    | { type: 'redacted_thinking'; data: string }
  );

export interface AnthropicMessage {
  role: 'user' | 'assistant';
  content: OutBlock[];
}

export interface AnthropicPayload {
  system: string;
  messages: AnthropicMessage[];
}

/* ---------------------------------------------------------------- 小工具 */

function textOf(content: WireMessage['content']): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.map((p) => (p.type === 'text' ? p.text : '')).join('');
}

/** `data:image/png;base64,xxx` → `{media_type, data}`。认不出返回 null。 */
export function splitDataUrl(url: string): { media_type: string; data: string } | null {
  const m = /^data:([^;,]+);base64,(.*)$/s.exec(url);
  if (!m?.[1] || m[2] === undefined) return null;
  return { media_type: m[1], data: m[2] };
}

/** 工具参数是模型生成的字符串，可能是坏 JSON —— 这里**绝不能抛**（历史展示不能 400）。 */
function parseInput(raw: string): unknown {
  if (!raw?.trim()) return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    return typeof parsed === 'object' && parsed !== null ? parsed : {};
  } catch {
    return {};
  }
}

/* ------------------------------------------------------------- 消息序列化 */

function userBlocks(content: WireMessage['content']): OutBlock[] {
  if (typeof content === 'string') return content ? [{ type: 'text', text: content }] : [];
  if (!Array.isArray(content)) return [];
  const out: OutBlock[] = [];
  for (const part of content) {
    if (part.type === 'text') {
      if (part.text) out.push({ type: 'text', text: part.text });
      continue;
    }
    const inline = splitDataUrl(part.image_url.url);
    out.push({
      type: 'image',
      source: inline
        ? { type: 'base64', media_type: inline.media_type, data: inline.data }
        : { type: 'url', url: part.image_url.url },
    });
  }
  return out;
}

/**
 * assistant → content blocks。
 *
 * 有原始块（`providerMeta.reasoning.kind === 'anthropic-blocks'`）时**整段复用**：
 * 重建会把 thinking 块排到 text 后面、把 signature 丢掉，两种都是 400。
 */
function assistantBlocks(m: WireMessage, def: ProviderDef, policy: ThinkingPolicy): OutBlock[] {
  const meta = m.providerMeta;
  const sameProvider = !meta || meta.providerId === def.id;

  if (policy.echo !== 'never' && sameProvider && meta?.reasoning?.kind === 'anthropic-blocks') {
    return meta.reasoning.blocks.map((b) => ({ ...b }) as OutBlock);
  }

  /*
   * 没有原始块（例如从别家切过来）。这时**不能伪造** thinking 块 ——
   * 假 signature 必然被拒；只能丢掉推理，宁可少一点连续性也不要 400。
   */
  const out: OutBlock[] = [];
  const text = textOf(m.content);
  if (text) out.push({ type: 'text', text });
  for (const call of m.tool_calls ?? []) {
    out.push({ type: 'tool_use', id: call.id, name: call.function.name, input: parseInput(call.function.arguments) });
  }
  return out;
}

const isToolResult = (b: OutBlock): boolean => b.type === 'tool_result';

function pushUser(messages: AnthropicMessage[], blocks: OutBlock[]): void {
  if (!blocks.length) return;
  const last = messages[messages.length - 1];
  if (last?.role === 'user') {
    // 合并：两边的 tool_result 都排在前面（规格要求），其余保持原有先后。
    last.content = [
      ...last.content.filter(isToolResult),
      ...blocks.filter(isToolResult),
      ...last.content.filter((b) => !isToolResult(b)),
      ...blocks.filter((b) => !isToolResult(b)),
    ];
    return;
  }
  messages.push({ role: 'user', content: blocks });
}

/**
 * 给每个 `tool_use` 补齐 `tool_result`。
 *
 * 用户中途点「停止」时，assistant 可能已经发出 3 个工具调用但只执行了 2 个；
 * 这段历史直接发给 Anthropic 会 400，而且**之后每一轮都 400**（历史被污染）。
 * 补一条 `is_error` 的结果比让整段会话作废好。
 */
function pairToolResults(messages: AnthropicMessage[]): void {
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i]!;
    if (m.role !== 'assistant') continue;
    const uses = m.content.filter((b): b is Extract<OutBlock, { type: 'tool_use' }> => b.type === 'tool_use');
    if (!uses.length) continue;
    const next = messages[i + 1];
    const results = next?.role === 'user' ? next.content.filter(isToolResult) : [];
    const missing = uses
      .filter((u) => !results.some((r) => r.type === 'tool_result' && r.tool_use_id === u.id))
      .map<OutBlock>((u) => ({
        type: 'tool_result',
        tool_use_id: u.id,
        content: '{"ok":false,"error":{"code":"cancelled","message":"the turn was interrupted"}}',
        is_error: true,
      }));
    if (!missing.length) continue;
    if (next?.role === 'user') {
      next.content = [...missing, ...next.content];
    } else {
      messages.splice(i + 1, 0, { role: 'user', content: missing });
    }
  }
}

export function serializeAnthropicMessages(
  input: readonly WireMessage[],
  def: ProviderDef,
  model = '',
): AnthropicPayload {
  const policy = thinkingPolicyFor(def, model);
  const system: string[] = [];
  const messages: AnthropicMessage[] = [];

  for (const m of input) {
    if (m.role === 'system') {
      const text = textOf(m.content);
      if (text) system.push(text);
      continue;
    }
    if (m.role === 'user') {
      pushUser(messages, userBlocks(m.content));
      continue;
    }
    if (m.role === 'assistant') {
      const blocks = assistantBlocks(m, def, policy);
      // Anthropic 拒绝空 content 的 assistant 消息。
      if (blocks.length) messages.push({ role: 'assistant', content: blocks });
      continue;
    }
    pushUser(messages, [{ type: 'tool_result', tool_use_id: m.tool_call_id ?? '', content: textOf(m.content) }]);
  }

  pairToolResults(messages);
  return { system: system.join('\n\n'), messages };
}

/** 能承载 `cache_control` 的块（thinking 系列不行，规格明确排除）。 */
const CACHEABLE = new Set<OutBlock['type']>(['text', 'image', 'tool_result', 'tool_use']);

/**
 * 把缓存断点打在**最后一个 user 回合的最后一个可缓存块**上。
 *
 * 为什么必须有这一步：Anthropic 的提示词缓存**不开就不会发生**（与 DeepSeek /
 * 智谱 / Kimi / 阿里的隐式缓存相反 —— 那几家什么都不用做）。不打断点的话
 * `usage` 里永远是 `cache_read_input_tokens: 0`，用户看到「命中率 0%」而以为是 bug。
 *
 * 为什么只打一个、且每轮往后移：官方推荐「断点跟着对话尾部走」。命中判定是
 * 「每个断点向前找最长匹配前缀」，所以上一轮写在旧位置的缓存**仍然**会被新断点
 * 覆盖到；而历史消息的字节保持不变（断点只加在最后一条），前缀缓存不会被打断。
 */
export function markCacheBreakpoint(messages: AnthropicMessage[]): void {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]!;
    if (m.role !== 'user') continue;
    for (let j = m.content.length - 1; j >= 0; j--) {
      const block = m.content[j]!;
      if (!CACHEABLE.has(block.type)) continue;
      m.content[j] = { ...block, cache_control: { type: 'ephemeral' } };
      return;
    }
    return;
  }
}

/**
 * 出站前的结构自检（**纯函数**，单测断言无违规；生产路径只 console.warn）。
 *
 * Anthropic 对历史形状比 OpenAI 严格得多，而这些违规全部表现为「某几轮才 400」，
 * 靠 E2E 复现极其费时。
 */
export function validateAnthropicMessages(messages: readonly AnthropicMessage[]): string[] {
  const problems: string[] = [];
  let lastRole = '';
  for (const [i, m] of messages.entries()) {
    if (!m.content.length) problems.push(`messages[${i}] (${m.role}) content is empty`);
    if (m.role === lastRole) problems.push(`messages[${i}] repeats role ${m.role}`);
    lastRole = m.role;
  }

  const seenUses = new Set<string>();
  for (const [i, m] of messages.entries()) {
    if (m.role === 'assistant') {
      for (const b of m.content) if (b.type === 'tool_use') seenUses.add(b.id);
      continue;
    }
    for (const b of m.content) {
      if (b.type !== 'tool_result') continue;
      const prev = messages[i - 1];
      const hasUse =
        prev?.role === 'assistant' &&
        prev.content.some((x) => x.type === 'tool_use' && x.id === b.tool_use_id);
      if (!hasUse) problems.push(`tool_result ${b.tool_use_id} has no tool_use in the previous turn`);
      seenUses.delete(b.tool_use_id);
    }
  }
  for (const id of seenUses) problems.push(`tool_use ${id} has no tool_result`);

  return problems;
}

/* ------------------------------------------------------------------- 工具 */

/**
 * JSON Schema 里 `type: ['object','null']` 这种数组形式 Anthropic 不接受。
 * `tools.ts` 的 `curve` / `json` 参数正好会产生它，所以每个 schema 都过一遍。
 */
export function normalizeSchemaForAnthropic(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(normalizeSchemaForAnthropic);
  if (typeof node !== 'object' || node === null) return node;

  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
    if (key === 'type' && Array.isArray(value)) {
      const concrete = value.filter((t) => t !== 'null');
      // 恰好一个具体类型才敢写；多类型（json 参数）就整个省略 = 任意类型。
      if (concrete.length === 1) out.type = concrete[0];
      continue;
    }
    out[key] = normalizeSchemaForAnthropic(value);
  }
  return out;
}

export function anthropicTools(tools: readonly ToolSpec[]): Record<string, unknown>[] {
  return tools.map((t) => ({
    name: t.name,
    description: t.description,
    input_schema: normalizeSchemaForAnthropic(toolParameters(t)),
  }));
}

/* ----------------------------------------------------------------- 适配器 */

export function buildAnthropicBody({ config, provider, messages, tools }: BuildBodyArgs): Record<string, unknown> {
  const payload = serializeAnthropicMessages(messages, provider, config.model);
  // 显式缓存：断点打在尾部（见 `markCacheBreakpoint` 的注释）。
  markCacheBreakpoint(payload.messages);

  const body: Record<string, unknown> = { model: config.model };
  if (payload.system) body.system = payload.system;
  body.max_tokens = outputTokensFor(provider, config) ?? 8_192;
  body.messages = payload.messages;
  body.stream = true;

  if (tools?.length) {
    body.tools = anthropicTools(tools);
    body.tool_choice = { type: 'auto' };
  }

  const temperature = temperatureFor(provider, config.effort, config.model, config.temperature, config.baseUrl);
  if (temperature !== undefined) body.temperature = temperature;

  Object.assign(body, thinkingParamsFor(provider, config.effort, config.model, config.baseUrl));
  // 厂商独有参数：provider → model → 请求级。全空时不加任何键。
  Object.assign(body, provider.body, ruleFor(provider, config.model)?.body, config.extraBody);
  return body;
}

export const anthropicAdapter: ProtocolAdapter = {
  id: 'anthropic',

  endpoint(baseUrl: string, def: ProviderDef, model: string): string {
    return endpointFor(baseUrl, def, model, ruleFor(def, model));
  },

  headers(config: LlmConfig, def: ProviderDef, model: string): Record<string, string> {
    return mergeHeaders(
      { 'Content-Type': 'application/json' },
      authHeaders(def.auth, config.apiKey),
      def.headers,
      ruleFor(def, model)?.headers,
    );
  },

  buildBody: buildAnthropicBody,

  createReducer(def: ProviderDef, handlers: StreamHandlers, model = ''): StreamReducer {
    return createAnthropicReducer(def, handlers, model);
  },

  classify(status: number, bodyText: string): LlmError {
    return classifyHttpError(status, bodyText);
  },
};
