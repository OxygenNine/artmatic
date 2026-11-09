/**
 * protocol/anthropic-stream.ts — Messages 流式事件归约。
 *
 * 事件流与 OpenAI 完全不同：有 `event:` 名字、有 `index` 的块生命周期、
 * 没有 `[DONE]`（结束是 `message_stop`）。三个只有实测才会注意的点：
 *
 * 1. **`signature` 是单独一帧**（`signature_delta`），必须**追加**到 thinking 块上，
 *    不是当正文拼进 `thinking` 文本。丢了它下一轮 400，而且第一轮完全正常。
 * 2. **`tool_use` 的 `input` 是分片 JSON**（`input_json_delta.partial_json`），
 *    拼完才有完整对象；块结束时才开始解析。
 * 3. **`redacted_thinking` 没有 signature**，只有 `data`，同样必须原样回传。
 */

import { classifyStreamError } from '../providers/errors';
import type { ProviderDef } from '../providers/types';
import type { AnthropicBlock, ChatResult, LlmUsage, ToolCallResult } from '../types';
import type { StreamHandlers, StreamReducer } from './types';

interface BlockState {
  kind: 'text' | 'thinking' | 'redacted_thinking' | 'tool_use' | 'other';
  text: string;
  signature: string;
  data: string;
  id: string;
  name: string;
  json: string;
}

interface StreamEvent {
  type?: string;
  index?: number;
  message?: { usage?: Record<string, number> };
  content_block?: { type?: string; id?: string; name?: string; data?: string; text?: string };
  delta?: {
    type?: string;
    text?: string;
    thinking?: string;
    signature?: string;
    partial_json?: string;
    stop_reason?: string | null;
  };
  usage?: Record<string, number>;
  error?: { type?: string; message?: string };
}

function blank(kind: BlockState['kind']): BlockState {
  return { kind, text: '', signature: '', data: '', id: '', name: '', json: '' };
}

function kindOf(type: string | undefined): BlockState['kind'] {
  switch (type) {
    case 'text':
      return 'text';
    case 'thinking':
      return 'thinking';
    case 'redacted_thinking':
      return 'redacted_thinking';
    case 'tool_use':
      return 'tool_use';
    default:
      return 'other';
  }
}

export function createAnthropicReducer(
  _def: ProviderDef,
  handlers: StreamHandlers,
  _model = '',
): StreamReducer {
  const blocks = new Map<number, BlockState>();
  let inputTokens = 0;
  let cacheRead = 0;
  let cacheCreate = 0;
  let outputTokens = 0;
  let finishReason: string | null = null;

  const at = (index: number): BlockState => {
    const existing = blocks.get(index);
    if (existing) return existing;
    const created = blank('other');
    blocks.set(index, created);
    return created;
  };

  const push = (data: string): boolean => {
    let event: StreamEvent;
    try {
      event = JSON.parse(data) as StreamEvent;
    } catch {
      return false; // 坏帧跳过，别毁整段回答
    }

    switch (event.type) {
      case 'message_start':
        inputTokens = event.message?.usage?.input_tokens ?? 0;
        cacheRead = event.message?.usage?.cache_read_input_tokens ?? 0;
        cacheCreate = event.message?.usage?.cache_creation_input_tokens ?? 0;
        return false;

      case 'content_block_start': {
        const index = event.index ?? 0;
        const state = blank(kindOf(event.content_block?.type));
        state.id = event.content_block?.id ?? '';
        state.name = event.content_block?.name ?? '';
        state.data = event.content_block?.data ?? '';
        state.text = event.content_block?.text ?? '';
        blocks.set(index, state);
        if (state.kind === 'tool_use' && state.name) {
          handlers.onToolStart?.({ index, id: state.id || `tool-${index}`, name: state.name });
        }
        return false;
      }

      case 'content_block_delta': {
        const state = at(event.index ?? 0);
        const delta = event.delta;
        if (!delta) return false;
        if (delta.type === 'text_delta' && delta.text) {
          state.text += delta.text;
          handlers.onText?.(delta.text);
        } else if (delta.type === 'thinking_delta' && delta.thinking) {
          state.text += delta.thinking;
          handlers.onReasoning?.(delta.thinking);
        } else if (delta.type === 'signature_delta' && delta.signature) {
          // 关键：签名是**追加**到块上的，不是正文。丢了它第二轮就 400。
          state.signature += delta.signature;
        } else if (delta.type === 'input_json_delta' && delta.partial_json) {
          state.json += delta.partial_json;
        }
        return false;
      }

      case 'message_delta':
        if (event.delta?.stop_reason) finishReason = event.delta.stop_reason;
        if (typeof event.usage?.output_tokens === 'number') outputTokens = event.usage.output_tokens;
        return false;

      case 'message_stop':
        return true;

      case 'ping':
        return false;

      case 'error':
        throw classifyStreamError(event.error?.type ?? '', event.error?.message ?? 'stream error');

      default:
        return false;
    }
  };

  return {
    push,

    finish(): ChatResult {
      const ordered = [...blocks.entries()].sort((a, b) => a[0] - b[0]).map(([, s]) => s);

      const content = ordered.filter((b) => b.kind === 'text').map((b) => b.text).join('');
      const reasoning = ordered.filter((b) => b.kind === 'thinking').map((b) => b.text).join('');

      const raw: AnthropicBlock[] = [];
      for (const block of ordered) {
        if (block.kind === 'text') {
          if (block.text) raw.push({ type: 'text', text: block.text });
        } else if (block.kind === 'thinking') {
          raw.push({ type: 'thinking', thinking: block.text, signature: block.signature });
        } else if (block.kind === 'redacted_thinking') {
          raw.push({ type: 'redacted_thinking', data: block.data });
        } else if (block.kind === 'tool_use') {
          raw.push({ type: 'tool_use', id: block.id, name: block.name, input: parseJson(block.json) });
        }
      }

      const toolCalls: ToolCallResult[] = [...blocks.entries()]
        .sort((a, b) => a[0] - b[0])
        .filter(([, s]) => s.kind === 'tool_use' && s.name)
        .map(([index, s]) => ({ id: s.id || `tool-${index}`, name: s.name, arguments: s.json || '{}' }));

      const prompt = inputTokens + cacheRead + cacheCreate;
      /*
       * 三个缓存字段**无条件写**（含 0）：`usage.ts` 靠「这个字段存在」判断
       * 这家会汇报缓存。只写非零值的话，命中率为 0 的第一轮会被当成
       * 「这家不支持缓存」，面板上什么都不显示。
       */
      const usage: LlmUsage | null =
        prompt || outputTokens
          ? {
              prompt_tokens: prompt,
              completion_tokens: outputTokens,
              total_tokens: prompt + outputTokens,
              input_tokens: inputTokens,
              cache_read_input_tokens: cacheRead,
              cache_creation_input_tokens: cacheCreate,
            }
          : null;

      return {
        content,
        reasoning,
        toolCalls,
        usage,
        finishReason,
        reasoningRaw: { kind: 'anthropic-blocks', blocks: raw },
      };
    },
  };
}

function parseJson(raw: string): unknown {
  if (!raw.trim()) return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    return typeof parsed === 'object' && parsed !== null ? parsed : {};
  } catch {
    return {};
  }
}
