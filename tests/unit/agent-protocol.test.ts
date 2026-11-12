/**
 * agent-protocol.test.ts — 两个协议的**纯函数**部分：请求体、消息序列化、流式归约。
 *
 * 三条最值钱的断言：
 *
 *  1. **DeepSeek 请求体逐字节不变**（`deepseek-request.golden.json`）。加 provider
 *     的时候最容易悄悄多一个键或少一个键，而那种错首轮通常还能跑，**第二轮带
 *     tools 才 400**，然后 `session` 的 400 自愈清空历史 —— 用户只觉得「聊着聊着失忆了」。
 *  2. **Anthropic 的 thinking 块保住 signature 和块序**。丢了第一轮完全正常，
 *     用工具的第二轮才 400。
 *  3. **`providerMeta` 绝不上线**。它是内部字段，漏出去就是给服务端送一个不认识的键。
 */

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { anthropicAdapter, markCacheBreakpoint, normalizeSchemaForAnthropic, serializeAnthropicMessages, validateAnthropicMessages, anthropicTools } from '../../src/agent/llm/protocol/anthropic';
import { createAnthropicReducer } from '../../src/agent/llm/protocol/anthropic-stream';
import { buildOpenAiBody, serializeOpenAiMessages } from '../../src/agent/llm/protocol/openai';
import { createOpenAiReducer } from '../../src/agent/llm/protocol/openai-stream';
import { providerOf } from '../../src/agent/llm/providers/registry';
import { DEFAULT_LLM_CONFIG, type WireMessage } from '../../src/agent/llm/types';
import { AGENT_TOOLS, type ToolSpec } from '../../src/agent/tools';

const deepseek = providerOf('deepseek');
const anthropic = providerOf('anthropic');
const openrouter = providerOf('openrouter');

const config = { ...DEFAULT_LLM_CONFIG, providerId: 'deepseek', apiKey: 'sk-test', maxTokens: 8192 };

function fixture(): WireMessage[] {
  return [
    { role: 'system', content: 'SYSTEM PROMPT' },
    {
      role: 'user',
      content: [
        { type: 'text', text: '把标题放大一点' },
        { type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA', detail: 'low' } },
      ],
    },
    {
      role: 'assistant',
      content: null,
      reasoning_content: '先读场景。',
      tool_calls: [{ id: 'call_0', type: 'function', function: { name: 'get_scene', arguments: '{}' } }],
    },
    { role: 'tool', tool_call_id: 'call_0', content: '{"ok":true,"data":{}}' },
  ];
}

/**
 * golden 里那份最小工具表（不是 `openAiTools()` 的六十多条 —— 把整套描述冻进
 * golden，等于以后每改一句工具说明都要更新这个文件）。
 */
const TOOLS: readonly ToolSpec[] = [
  { name: 'get_scene', description: 'Read the scene.', params: [], writes: false },
];

/* ------------------------------------------------------- DeepSeek 字节基线 */

describe('OpenAI 请求体', () => {
  it('DeepSeek 的请求体逐字节等于 golden', () => {
    const body = buildOpenAiBody({
      config,
      provider: deepseek,
      messages: fixture(),
      tools: TOOLS,
    });
    const golden = readFileSync('tests/unit/fixtures/deepseek-request.golden.json', 'utf8');
    expect(`${JSON.stringify(body, null, 2)}\n`).toBe(golden);
  });

  it('挂上 providerMeta 之后仍然逐字节相同（内部字段必须被剥掉）', () => {
    const withMeta = fixture().map((m) =>
      m.role === 'assistant' ? { ...m, providerMeta: { providerId: 'deepseek' } } : m,
    );
    const plain = buildOpenAiBody({ config, provider: deepseek, messages: fixture(), tools: TOOLS });
    const meta = buildOpenAiBody({ config, provider: deepseek, messages: withMeta, tools: TOOLS });
    expect(JSON.stringify(meta)).toBe(JSON.stringify(plain));
    expect(JSON.stringify(meta)).not.toContain('providerMeta');
  });

  it('键序是契约：model / messages / stream / … / thinking / reasoning_effort', () => {
    const body = buildOpenAiBody({ config, provider: deepseek, messages: fixture(), tools: TOOLS });
    expect(Object.keys(body)).toEqual([
      'model',
      'messages',
      'stream',
      'stream_options',
      'temperature',
      'max_tokens',
      'tools',
      'tool_choice',
      'thinking',
      'reasoning_effort',
    ]);
  });

  it('关闭思考时不再出现 reasoning_effort', () => {
    const body = buildOpenAiBody({
      config: { ...config, effort: 'off' },
      provider: deepseek,
      messages: [{ role: 'user', content: 'hi' }],
    });
    expect(body.thinking).toEqual({ type: 'disabled' });
    expect(body).not.toHaveProperty('reasoning_effort');
  });
});

/* ------------------------------------------------------------ 回传策略 */

describe('思维链回传策略', () => {
  const assistant: WireMessage = {
    role: 'assistant',
    content: '好',
    reasoning_content: '想了想',
    providerMeta: { providerId: 'deepseek' },
  };

  it('DeepSeek（required）始终带 reasoning_content', () => {
    const [out] = serializeOpenAiMessages([assistant], deepseek);
    expect(out!.reasoning_content).toBe('想了想');
  });

  it('required 且换了家：字段仍在，但内容清空（不能把别家的推理发过去）', () => {
    const [out] = serializeOpenAiMessages([{ ...assistant, providerMeta: { providerId: 'openai' } }], deepseek);
    expect(out!.reasoning_content).toBe('');
  });

  it('智谱（never）完全删掉这个键', () => {
    const [out] = serializeOpenAiMessages([assistant], providerOf('zhipu'));
    expect(out).not.toHaveProperty('reasoning_content');
  });

  it('OpenRouter 原样回传 reasoning_details 数组', () => {
    const details = [{ type: 'reasoning.text', text: 'x', signature: 'sig' }];
    const [out] = serializeOpenAiMessages(
      [{ ...assistant, providerMeta: { providerId: 'openrouter', reasoning: { kind: 'openrouter-details', details } } }],
      openrouter,
    );
    expect(out!.reasoning_details).toEqual(details);
  });

  /**
   * Files API 的 `file` 块只发给声明了 `apis.files` 的那一家。
   *
   * 发给别家是 400（OpenAI 兼容层不认识这个 part），而**静默删掉**更糟：
   * 模型会顺着「我截图看过了」的记忆继续编。所以降级成一行 `[image]` 文字。
   */
  it('file 块：DeepSeek 原样上线，别家降级成占位文字', () => {
    const messages: WireMessage[] = [
      { role: 'user', content: [{ type: 'text', text: 'look' }, { type: 'file', file_id: 'file-api-abc' }] },
    ];
    expect(serializeOpenAiMessages(messages, deepseek)[0]!.content).toEqual([
      { type: 'text', text: 'look' },
      { type: 'file', file_id: 'file-api-abc' },
    ]);
    expect(serializeOpenAiMessages(messages, providerOf('zhipu'))[0]!.content).toEqual([
      { type: 'text', text: 'look' },
      { type: 'text', text: '[image]' },
    ]);
  });

  it('file 块不污染历史：序列化不改入参（只另造一份）', () => {
    const messages: WireMessage[] = [
      { role: 'user', content: [{ type: 'file', file_id: 'file-api-abc' }] },
    ];
    serializeOpenAiMessages(messages, providerOf('zhipu'));
    expect(messages[0]!.content).toEqual([{ type: 'file', file_id: 'file-api-abc' }]);
  });
});

/* -------------------------------------------------------- Anthropic 序列化 */

describe('Anthropic 消息序列化', () => {
  it('system 提到顶层，图片转 base64 块', () => {
    const payload = serializeAnthropicMessages(fixture(), anthropic);
    expect(payload.system).toBe('SYSTEM PROMPT');
    const user = payload.messages[0]!;
    expect(user.role).toBe('user');
    expect(user.content[1]).toEqual({
      type: 'image',
      source: { type: 'base64', media_type: 'image/png', data: 'AAAA' },
    });
  });

  it('tool 结果折进 user 消息的 tool_result 块，且排在 content 最前', () => {
    const messages: WireMessage[] = [
      { role: 'user', content: '看看场景' },
      {
        role: 'assistant',
        content: null,
        tool_calls: [{ id: 'tu_1', type: 'function', function: { name: 'get_scene', arguments: '{}' } }],
      },
      { role: 'tool', tool_call_id: 'tu_1', content: '{"ok":true}' },
      { role: 'user', content: '继续' },
    ];
    const payload = serializeAnthropicMessages(messages, anthropic);
    const last = payload.messages[payload.messages.length - 1]!;
    expect(last.role).toBe('user');
    expect(last.content[0]).toEqual({ type: 'tool_result', tool_use_id: 'tu_1', content: '{"ok":true}' });
    expect(last.content[last.content.length - 1]).toEqual({ type: 'text', text: '继续' });
  });

  it('thinking / redacted_thinking 原样保序（signature 与 data 都不能丢）', () => {
    const blocks = [
      { type: 'thinking' as const, thinking: '推理', signature: 'SIG-1' },
      { type: 'redacted_thinking' as const, data: 'ENC' },
      { type: 'text' as const, text: '答案' },
      { type: 'tool_use' as const, id: 'tu_9', name: 'get_scene', input: {} },
    ];
    const payload = serializeAnthropicMessages(
      [
        { role: 'user', content: '来' },
        { role: 'assistant', content: '答案', providerMeta: { providerId: 'anthropic', reasoning: { kind: 'anthropic-blocks', blocks } } },
      ],
      anthropic,
    );
    expect(payload.messages[1]!.content).toEqual([
      { type: 'thinking', thinking: '推理', signature: 'SIG-1' },
      { type: 'redacted_thinking', data: 'ENC' },
      { type: 'text', text: '答案' },
      { type: 'tool_use', id: 'tu_9', name: 'get_scene', input: {} },
    ]);
  });

  it('缓存断点只打在最后一个 user 回合：历史字节不因此改变', () => {
    const messages: WireMessage[] = [
      { role: 'user', content: '第一句' },
      { role: 'assistant', content: '第一句的回答' },
      { role: 'user', content: '第二句' },
    ];
    const payload = serializeAnthropicMessages(messages, anthropic);
    markCacheBreakpoint(payload.messages);

    // 只有尾部的块带标记 —— 断点每轮往后移，旧消息的字节保持不变（前缀缓存的前提）
    expect(payload.messages[0]!.content[0]).toEqual({ type: 'text', text: '第一句' });
    expect(payload.messages[2]!.content[0]).toEqual({
      type: 'text',
      text: '第二句',
      cache_control: { type: 'ephemeral' },
    });
  });

  it('工具轮的缓存断点落在 tool_result 上（thinking 块不能承载它）', () => {
    const payload = serializeAnthropicMessages(
      [
        { role: 'user', content: '看看场景' },
        {
          role: 'assistant',
          content: null,
          tool_calls: [{ id: 'tu_1', type: 'function', function: { name: 'get_scene', arguments: '{}' } }],
        },
        { role: 'tool', tool_call_id: 'tu_1', content: '{"ok":true}' },
      ],
      anthropic,
    );
    markCacheBreakpoint(payload.messages);
    const last = payload.messages[payload.messages.length - 1]!;
    expect(last.content[0]).toMatchObject({
      type: 'tool_result',
      tool_use_id: 'tu_1',
      cache_control: { type: 'ephemeral' },
    });
  });

  it('空 assistant 被丢弃，孤立 tool_use 自动补一条 is_error 结果', () => {
    const payload = serializeAnthropicMessages(
      [
        { role: 'user', content: '来' },
        { role: 'assistant', content: '' },
        {
          role: 'assistant',
          content: null,
          tool_calls: [{ id: 'tu_2', type: 'function', function: { name: 'get_scene', arguments: '{}' } }],
        },
      ],
      anthropic,
    );
    const assistantTurns = payload.messages.filter((m) => m.role === 'assistant');
    expect(assistantTurns).toHaveLength(1);
    const tail = payload.messages[payload.messages.length - 1]!;
    expect(tail.content[0]).toMatchObject({ type: 'tool_result', tool_use_id: 'tu_2', is_error: true });
    expect(validateAnthropicMessages(payload.messages)).toEqual([]);
  });

  it('坏的工具参数退回空对象而不是抛（历史展示不能因此 400）', () => {
    const payload = serializeAnthropicMessages(
      [
        { role: 'user', content: '来' },
        {
          role: 'assistant',
          content: null,
          tool_calls: [{ id: 'tu_3', type: 'function', function: { name: 'get_scene', arguments: '{坏的' } }],
        },
        { role: 'tool', tool_call_id: 'tu_3', content: '{}' },
      ],
      anthropic,
    );
    const use = payload.messages[1]!.content.find((b) => b.type === 'tool_use');
    expect(use).toMatchObject({ input: {} });
  });

  it('schema 里的数组 type 被拍平（Anthropic 不接受）', () => {
    const tools = anthropicTools(AGENT_TOOLS);
    expect(tools.length).toBe(AGENT_TOOLS.length);
    for (const tool of tools) {
      expect(JSON.stringify(tool.input_schema)).not.toMatch(/"type":\[/);
    }
    expect(normalizeSchemaForAnthropic({ type: ['object', 'null'] })).toEqual({ type: 'object' });
    expect(normalizeSchemaForAnthropic({ type: ['object', 'array', 'null'] })).toEqual({});
  });

  it('max_tokens 必须大于 thinking 预算（否则 400 且错误信息用户看不懂）', () => {
    const body = anthropicAdapter.buildBody({
      config: { ...config, providerId: 'anthropic', effort: 'max', maxTokens: 1024 },
      provider: anthropic,
      messages: [{ role: 'user', content: 'hi' }],
      tools: TOOLS,
    });
    const budget = (body.thinking as { budget_tokens: number }).budget_tokens;
    expect(body.max_tokens as number).toBeGreaterThan(budget);
    // 开思考时不能带 temperature
    expect(body).not.toHaveProperty('temperature');
    expect(body.system).toBeUndefined();
  });
});

/* ------------------------------------------------------------ 流式归约 */

describe('OpenAI 流归约', () => {
  it('工具参数按 index 分片累积', () => {
    const r = createOpenAiReducer(deepseek, {});
    r.push(JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'c1', function: { name: 'add_clip', arguments: '{"na' } }] } }] }));
    r.push(JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: 'me":"x"}' } }] } }] }));
    r.push(JSON.stringify({ choices: [{ delta: { content: 'ok' }, finish_reason: 'stop' }] }));
    r.push('[DONE]');
    const out = r.finish();
    expect(out.toolCalls[0]).toEqual({ id: 'c1', name: 'add_clip', arguments: '{"name":"x"}' });
    expect(out.content).toBe('ok');
    expect(out.reasoningRaw).toBeUndefined();
  });

  it('坏帧跳过，usage 单独一帧也能收到', () => {
    const r = createOpenAiReducer(deepseek, {});
    r.push('{不是 JSON');
    r.push(JSON.stringify({ choices: [], usage: { prompt_tokens: 10, completion_tokens: 2 } }));
    expect(r.finish().usage).toEqual({ prompt_tokens: 10, completion_tokens: 2 });
  });

  it('OpenRouter 的 reasoning_details 累加并保留原始数组', () => {
    const r = createOpenAiReducer(openrouter, {});
    r.push(JSON.stringify({ choices: [{ delta: { reasoning_details: [{ type: 'reasoning.text', text: 'A', signature: 's1' }] } }] }));
    r.push(JSON.stringify({ choices: [{ delta: { reasoning_details: [{ type: 'reasoning.text', text: 'B', signature: 's2' }] } }] }));
    const out = r.finish();
    expect(out.reasoning).toBe('AB');
    expect(out.reasoningRaw).toEqual({
      kind: 'openrouter-details',
      details: [
        { type: 'reasoning.text', text: 'A', signature: 's1' },
        { type: 'reasoning.text', text: 'B', signature: 's2' },
      ],
    });
  });
});

describe('Anthropic 流归约', () => {
  const ev = (o: unknown) => JSON.stringify(o);

  it('signature 分两帧到达也必须拼完整', () => {
    const r = createAnthropicReducer(anthropic, {});
    r.push(ev({ type: 'message_start', message: { usage: { input_tokens: 7 } } }));
    r.push(ev({ type: 'content_block_start', index: 0, content_block: { type: 'thinking' } }));
    r.push(ev({ type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: '想' } }));
    r.push(ev({ type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature: 'AB' } }));
    r.push(ev({ type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature: 'CD' } }));
    r.push(ev({ type: 'content_block_stop', index: 0 }));
    r.push(ev({ type: 'message_stop' }));
    const out = r.finish();
    expect(out.reasoning).toBe('想');
    expect(out.reasoningRaw).toEqual({
      kind: 'anthropic-blocks',
      blocks: [{ type: 'thinking', thinking: '想', signature: 'ABCD' }],
    });
  });

  it('tool_use 的 partial_json 拼完才解析，usage 来自 message_delta', () => {
    const r = createAnthropicReducer(anthropic, {});
    const started: string[] = [];
    r.push(ev({ type: 'message_start', message: { usage: { input_tokens: 11, cache_read_input_tokens: 3 } } }));
    r.push(ev({ type: 'content_block_start', index: 1, content_block: { type: 'tool_use', id: 'tu_1', name: 'add_clip' } }));
    r.push(ev({ type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '{"na' } }));
    r.push(ev({ type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: 'me":"x"}' } }));
    r.push(ev({ type: 'content_block_stop', index: 1 }));
    r.push(ev({ type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 5 } }));
    const out = r.finish();
    expect(out.toolCalls[0]).toEqual({ id: 'tu_1', name: 'add_clip', arguments: '{"name":"x"}' });
    /*
     * 缓存字段**无条件写**（含 0）：`usage.ts` 靠「字段存在」判断这家会汇报缓存，
     * 只写非零值会把「命中 0% 的第一轮」误判成「不支持缓存」。
     */
    expect(out.usage).toEqual({
      prompt_tokens: 14,
      completion_tokens: 5,
      total_tokens: 19,
      input_tokens: 11,
      cache_read_input_tokens: 3,
      cache_creation_input_tokens: 0,
    });
    expect(out.finishReason).toBe('tool_use');
    expect(started).toEqual([]);
  });

  it('content_block_start 就通知工具开始（面板要立刻插卡）', () => {
    const seen: string[] = [];
    const r = createAnthropicReducer(anthropic, { onToolStart: (c) => seen.push(c.name) });
    r.push(ev({ type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'tu_2', name: 'get_scene' } }));
    expect(seen).toEqual(['get_scene']);
  });

  it('error 事件按 type 归类', () => {
    const r = createAnthropicReducer(anthropic, {});
    expect(() => r.push(ev({ type: 'error', error: { type: 'overloaded_error', message: 'busy' } }))).toThrow(/busy/);
  });
});
