/**
 * protocol/openai.ts — OpenAI Chat Completions 适配器。
 *
 * 覆盖注册表里所有走 Chat Completions 的提供商（国内 11 家 + OpenAI / Gemini
 * 兼容层 / OpenRouter / xAI / Azure / Cloudflare 网关）。差异全部来自
 * `providers/` 的数据与 `compat.ts` 的方言解析，这里只有**一份**序列化逻辑。
 *
 * ## 键序是契约
 *
 * `tests/unit/fixtures/deepseek-request.golden.json` 钉住 DeepSeek 的请求体**逐字节**。
 * 所以要新增可选字段就往 `buildBody` 里按顺序追加，不要重排现有字段 ——
 * 重排本身不改语义，但会让 golden 失效，而失效的 golden 通常被「更新一下就好」
 * 地处理掉，那这个守卫就白设了。新增的 `body` / `extraBody` 只在**有值时**追加。
 */

import { openAiTools } from '../../tools';
import { resolveCompat } from '../providers/compat';
import { authHeaders, endpointFor, mergeHeaders } from '../providers/endpoint';
import { classifyHttpError } from '../providers/errors';
import {
  maxTokensFieldFor,
  outputTokensFor,
  temperatureFor,
  thinkingParamsFor,
} from '../providers/reasoning';
import { ruleFor, thinkingPolicyFor } from '../providers/routing';
import type { Compat, ProviderDef, ThinkingPolicy } from '../providers/types';
import type { LlmConfig, LlmError, WireMessage } from '../types';
import { createOpenAiReducer } from './openai-stream';
import type { BuildBodyArgs, ProtocolAdapter, StreamHandlers, StreamReducer } from './types';

/* --------------------------------------------------------------- 消息序列化 */

/** 去掉内部字段。没有 `providerMeta` 时**返回同一引用**（DeepSeek 的字节基线靠这个）。 */
export function stripProviderMeta(m: WireMessage): WireMessage {
  if (!m.providerMeta) return m;
  const { providerMeta: _drop, ...rest } = m;
  return rest;
}

/**
 * assistant 消息 → 该 provider 能接受的形状。
 *
 * `echo` 决定思维链是否出现：
 *   required  字段**必须在**（DeepSeek 带 tools 时漏传 = 400），缺了写空串；
 *             换过 provider 的话旧文本也不该带（那是别家的推理）
 *   optional  有才带（OpenRouter 的 `reasoning_details` 原数组回传）
 *   never     一律删（智谱明确不回传；OpenAI 不认这个字段）
 */
function assistantOut(
  m: WireMessage,
  def: ProviderDef,
  policy: ThinkingPolicy,
): Record<string, unknown> {
  const echo = policy.echo;
  const field = policy.field;
  const meta = m.providerMeta;
  const sameProvider = !meta || meta.providerId === def.id;

  const out: Record<string, unknown> = { role: 'assistant', content: m.content ?? null };

  if (echo !== 'never' && sameProvider) {
    if (field === 'reasoning_content' || field === 'reasoning') {
      const text = m.reasoning_content ?? '';
      if (echo === 'required' || text) out[field] = text;
    } else if (field === 'reasoning_details' && meta?.reasoning?.kind === 'openrouter-details') {
      out.reasoning_details = meta.reasoning.details;
    }
  } else if (echo === 'required') {
    // 字段必须存在，内容为空。写 `''` 是官方接受的形状（「没有思维链」）。
    out[field === 'reasoning' ? 'reasoning' : 'reasoning_content'] = '';
  }

  if (m.tool_calls?.length) out.tool_calls = m.tool_calls;
  return out;
}

/**
 * 有些兼容实现要求 `role:'tool'` 带函数名，否则 400 或直接忽略结果。
 * 名字只能从**前一条 assistant 的 tool_calls** 里找回来 —— 历史里没存。
 */
function toolNamesById(messages: readonly WireMessage[]): Map<string, string> {
  const names = new Map<string, string>();
  for (const m of messages) {
    for (const call of m.tool_calls ?? []) names.set(call.id, call.function.name);
  }
  return names;
}

export function serializeOpenAiMessages(
  messages: readonly WireMessage[],
  def: ProviderDef,
  model = '',
  compat?: Partial<Compat>,
): Record<string, unknown>[] {
  const policy = thinkingPolicyFor(def, model);
  const needsName = compat?.requiresToolResultName === true;
  const needsAssistantGap = compat?.requiresAssistantAfterToolResult === true;
  const names = needsName ? toolNamesById(messages) : null;

  const out: Record<string, unknown>[] = [];
  let previousWasTool = false;

  for (const m of messages) {
    if (m.role !== 'assistant') {
      if (m.role === 'user' && needsAssistantGap && previousWasTool) {
        // 少数兼容层要求 tool 回合之后先有一条 assistant 才能接 user。
        out.push({ role: 'assistant', content: '' });
      }
      const plain = stripProviderMeta(m) as unknown as Record<string, unknown>;
      if (m.role === 'tool' && names && !plain.name) {
        const name = names.get(m.tool_call_id ?? '');
        out.push(name ? { ...plain, name } : plain);
      } else {
        out.push(plain);
      }
      previousWasTool = m.role === 'tool';
      continue;
    }

    out.push(assistantOut(m, def, policy));
    previousWasTool = false;
  }
  return out;
}

/* ---------------------------------------------------------------- 请求组装 */

export function buildOpenAiBody({ config, provider, messages, tools }: BuildBodyArgs): Record<string, unknown> {
  const compat = resolveCompat(provider, config.model, config.baseUrl, ruleFor(provider, config.model)?.compat);
  const rule = ruleFor(provider, config.model);

  const body: Record<string, unknown> = {
    model: config.model,
    messages: serializeOpenAiMessages(messages, provider, config.model, compat),
    stream: true,
  };

  if (compat.streamUsage) body.stream_options = { include_usage: true };

  const temperature = temperatureFor(provider, config.effort, config.model, config.temperature, config.baseUrl);
  if (temperature !== undefined) body.temperature = temperature;

  const maxTokens = outputTokensFor(provider, config);
  if (maxTokens) body[maxTokensFieldFor(provider, config.model, config.baseUrl)] = maxTokens;

  if (tools?.length) {
    body.tools = openAiTools(tools);
    body.tool_choice = 'auto';
  }

  // 思考参数永远先于厂商自定义参数：后者要能覆盖它（例如带 `thinking` 的网关）。
  Object.assign(body, thinkingParamsFor(provider, config.effort, config.model, config.baseUrl));

  /*
   * 厂商独有参数的数据化出口。顺序固定为 provider → model → 请求级，
   * 后者覆盖前者；三者都为空时**一个键都不加**（golden 基线靠这个）。
   */
  Object.assign(body, provider.body, rule?.body, config.extraBody);
  return body;
}

/* ------------------------------------------------------------------ 适配器 */

export const openAiAdapter: ProtocolAdapter = {
  id: 'openai',

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

  buildBody: buildOpenAiBody,

  createReducer(def: ProviderDef, handlers: StreamHandlers, model: string): StreamReducer {
    return createOpenAiReducer(def, handlers, model);
  },

  classify(status: number, bodyText: string): LlmError {
    return classifyHttpError(status, bodyText);
  },
};
