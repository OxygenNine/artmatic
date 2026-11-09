/**
 * protocol/openai-stream.ts — Chat Completions 的流式归约。
 *
 * 从 `once()` 里搬出来，逻辑**一行没改**（DeepSeek 的行为靠
 * `deepseek-request.golden.json` 与现有 E2E 双重钉住）。搬家的唯一目的是让它
 * 能被 vitest 直接喂字符串 —— 本项目的纪律是「不 mock fetch」。
 *
 * ## 两条只有实测才会发现的事
 *
 * 1. **`tool_calls` 是分片到达的**：`delta.tool_calls[i].function.arguments` 是
 *    JSON 字符串的**片段**，要按 `index` 累积再拼。按到达顺序当完整 JSON 解析
 *    会在长参数上随机失败（而且只在参数跨 chunk 时）。
 * 2. **思维链字段名不统一**：`reasoning_content`（多数国产）/ `reasoning`
 *    （Groq、OpenRouter 旧字段）/ `reasoning_details[]`（OpenRouter 新格式）。
 */

import { classifyStreamError } from '../providers/errors';
import { thinkingPolicyFor } from '../providers/routing';
import type { ProviderDef } from '../providers/types';
import type { ChatResult, LlmUsage, ReasoningRaw, ToolCallResult } from '../types';
import type { StreamHandlers, StreamReducer } from './types';

interface DeltaToolCall {
  index?: number;
  id?: string;
  type?: string;
  function?: { name?: string; arguments?: string };
}

interface StreamChunk {
  choices?: {
    delta?: {
      content?: string | null;
      reasoning_content?: string | null;
      reasoning?: string | null;
      reasoning_details?: unknown[] | null;
      tool_calls?: DeltaToolCall[];
    };
    finish_reason?: string | null;
  }[];
  usage?: LlmUsage | null;
  error?: { message?: string; type?: string; code?: string };
}

/** OpenRouter 的 `reasoning_details[]` 里能当正文显示的字段。 */
function detailText(items: unknown[]): string {
  const parts: string[] = [];
  for (const item of items) {
    if (typeof item !== 'object' || item === null) continue;
    const rec = item as Record<string, unknown>;
    if (typeof rec.text === 'string') parts.push(rec.text);
    else if (typeof rec.summary === 'string') parts.push(rec.summary);
  }
  return parts.join('');
}

export function createOpenAiReducer(
  def: ProviderDef,
  handlers: StreamHandlers,
  model = '',
): StreamReducer {
  // 网关下不同模型读不同字段（Claude 回 thinking 块，GPT 回 reasoning_content）。
  const field = thinkingPolicyFor(def, model).field;
  let content = '';
  let reasoning = '';
  let usage: LlmUsage | null = null;
  let finishReason: string | null = null;

  const calls = new Map<number, ToolCallResult>();
  const started = new Set<number>();
  /** OpenRouter 的原始 details（必须原样回传，重组会丢 signature 与 format）。 */
  let details: unknown[] | null = null;

  const push = (data: string): boolean => {
    if (data === '[DONE]') return true;

    let chunk: StreamChunk;
    try {
      chunk = JSON.parse(data) as StreamChunk;
    } catch {
      // 单个坏帧不该毁掉整段回答：跳过它。
      return false;
    }

    if (chunk.error) {
      throw classifyStreamError(
        chunk.error.type ?? chunk.error.code ?? '',
        chunk.error.message ?? 'stream error',
      );
    }
    if (chunk.usage) usage = chunk.usage;

    const choice = chunk.choices?.[0];
    if (!choice) return false;
    if (choice.finish_reason) finishReason = choice.finish_reason;

    const delta = choice.delta;
    if (!delta) return false;

    if (typeof delta.content === 'string' && delta.content) {
      content += delta.content;
      handlers.onText?.(delta.content);
    }

    // 思维链：按注册表声明的位置读，别的位置一律忽略（写了也没人消费）。
    if (field === 'reasoning_details') {
      if (Array.isArray(delta.reasoning_details) && delta.reasoning_details.length) {
        details = [...(details ?? []), ...delta.reasoning_details];
        const text = detailText(delta.reasoning_details);
        if (text) {
          reasoning += text;
          handlers.onReasoning?.(text);
        }
      }
      // 旧字段仍然要读：OpenRouter 对部分上游只回 `reasoning`。
      if (typeof delta.reasoning === 'string' && delta.reasoning) {
        reasoning += delta.reasoning;
        handlers.onReasoning?.(delta.reasoning);
      }
    } else if (field === 'reasoning') {
      if (typeof delta.reasoning === 'string' && delta.reasoning) {
        reasoning += delta.reasoning;
        handlers.onReasoning?.(delta.reasoning);
      }
    } else if (field === 'reasoning_content') {
      if (typeof delta.reasoning_content === 'string' && delta.reasoning_content) {
        reasoning += delta.reasoning_content;
        handlers.onReasoning?.(delta.reasoning_content);
      }
    }

    for (const [i, tc] of (delta.tool_calls ?? []).entries()) {
      const index = typeof tc.index === 'number' ? tc.index : i;
      const entry = calls.get(index) ?? { id: '', name: '', arguments: '' };
      if (tc.id) entry.id = tc.id;
      if (tc.function?.name) entry.name = tc.function.name;
      if (typeof tc.function?.arguments === 'string') entry.arguments += tc.function.arguments;
      calls.set(index, entry);
      if (!started.has(index) && entry.name) {
        started.add(index);
        handlers.onToolStart?.({ index, id: entry.id || `call-${index}`, name: entry.name });
      }
    }
    return false;
  };

  return {
    push,

    finish(): ChatResult {
      const toolCalls: ToolCallResult[] = [...calls.entries()]
        .sort((a, b) => a[0] - b[0])
        .map(([index, c]) => ({ id: c.id || `call-${index}`, name: c.name, arguments: c.arguments }))
        .filter((c) => c.name);

      const reasoningRaw: ReasoningRaw | undefined =
        details && details.length ? { kind: 'openrouter-details', details } : undefined;

      return {
        content,
        reasoning,
        toolCalls,
        usage,
        finishReason,
        ...(reasoningRaw ? { reasoningRaw } : {}),
      };
    },
  };
}
