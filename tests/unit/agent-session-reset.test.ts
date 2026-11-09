import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChatResult, ToolOutcome } from '../../src/agent/llm/types';
import { deferred } from './_deferred';

const streamChatMock = vi.hoisted(() => vi.fn());

vi.mock('../../src/agent/llm/transport', () => ({
  LLM_TIMEOUT_MS: 1,
  streamChat: streamChatMock,
}));

import { AgentSession } from '../../src/agent/llm/session';

const CONFIG = {
  providerId: 'deepseek',
  baseUrl: 'https://api.deepseek.com',
  apiKey: 'test-key',
  model: 'deepseek-chat',
  temperature: 0,
  effort: 'off' as const,
  proxyPath: null,
};

function toolCallResult(): ChatResult {
  return {
    content: '',
    reasoning: '',
    toolCalls: [{ id: 'c1', name: 'list_modulators', arguments: '{}' }],
    usage: null,
    finishReason: 'tool_calls',
  };
}

describe('AgentSession 的新会话竞态', () => {
  beforeEach(() => {
    streamChatMock.mockReset();
    streamChatMock.mockResolvedValue(toolCallResult());
  });

  it('clear() 发生时，在飞的工具结果不得写进新历史', async () => {
    const executed = deferred<void>();
    const gate = deferred<ToolOutcome>();
    const events: string[] = [];
    const session = new AgentSession({
      config: CONFIG,
      control: {
        beginTx: async () => ({ ok: true, data: { open: true } }),
        endTx: async () => ({ ok: true, data: { changed: true } }),
      } as never,
      execute: () => {
        executed.resolve();
        return gate.promise;
      },
      onEvent: (e) => events.push(e.kind),
      onStatus: () => {},
    });

    const send = session.send('hi');
    await executed.promise;

    session.clear();
    expect(session.isBusy).toBe(false);
    gate.resolve({ ok: true, text: JSON.stringify({ ok: true, data: [] }) });
    await send;

    const messages = session.snapshot().messages;
    expect(messages).toHaveLength(1);
    expect(messages[0]!.role).toBe('system');
    expect(session.lastError).toBeNull();
    expect(events).not.toContain('error');
  });

  it('beginTx 失败时退回逐笔撤销，不会卡在 busy', async () => {
    streamChatMock.mockResolvedValueOnce({
      content: 'ok',
      reasoning: '',
      toolCalls: [],
      usage: null,
      finishReason: 'stop',
    } satisfies ChatResult);
    const session = new AgentSession({
      config: CONFIG,
      control: {
        beginTx: async () => {
          throw new Error('already open');
        },
        endTx: async () => {
          throw new Error('none');
        },
      } as never,
      execute: async () => ({ ok: true, text: '{}' }),
      onEvent: () => {},
      onStatus: () => {},
    });
    await session.send('hi');
    expect(session.isBusy).toBe(false);
    expect(session.snapshot().messages.map((m) => m.role)).toEqual(['system', 'user', 'assistant']);
  });

  it('clear 后可以立刻开新一轮，旧轮收尾不覆盖它', async () => {
    const executed = deferred<void>();
    const gate = deferred<ToolOutcome>();
    const events: string[] = [];
    streamChatMock
      .mockResolvedValueOnce(toolCallResult())
      .mockResolvedValueOnce({
        content: 'ok',
        reasoning: '',
        toolCalls: [],
        usage: null,
        finishReason: 'stop',
      } satisfies ChatResult);

    const session = new AgentSession({
      config: CONFIG,
      control: {
        beginTx: async () => ({ ok: true, data: { open: true } }),
        endTx: async () => ({ ok: true, data: { changed: true } }),
      } as never,
      execute: () => {
        executed.resolve();
        return gate.promise;
      },
      onEvent: (e) => events.push(e.kind),
      onStatus: () => {},
    });

    const first = session.send('hi');
    await executed.promise;
    session.clear();
    await session.send('second');

    gate.resolve({ ok: true, text: JSON.stringify({ ok: true, data: [] }) });
    await first;

    const messages = session.snapshot().messages;
    expect(messages.map((m) => m.role)).toEqual(['system', 'user', 'assistant']);
    expect(messages[1]!.content).toContain('second');
    expect(events.filter((k) => k === 'turn-end')).toHaveLength(1);
    expect(session.isBusy).toBe(false);
  });
});
