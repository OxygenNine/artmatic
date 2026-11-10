import { describe, expect, it } from 'vitest';
import { createSseParser } from '../../src/agent/llm/transport';
import {
  advanceStreak,
  estimateMessagesTokens,
  NO_STREAK,
  recentTail,
  repeatAction,
  repeatKeyOf,
  shouldCompact,
  trimMessages,
} from '../../src/agent/llm/session';
import { thinkingParamsFor } from '../../src/agent/llm/providers/reasoning';
import { providerOf } from '../../src/agent/llm/providers/registry';
import type { WireMessage } from '../../src/agent/llm/types';
import { EFFECT_HEAD } from '../../src/effects/shader-def';
import { ALGO_HEAD } from '../../src/algos/shader-lib';
import { pluginReference, helpText, HELP_TOPICS } from '../../src/agent/plugin-spec';

/* ------------------------------------------------------------------ SSE */

describe('SSE 解析', () => {
  it('一个事件跨多个 chunk 也能拼回来', () => {
    const p = createSseParser();
    expect(p.push('data: {"a":')).toEqual([]);
    expect(p.push('1}\n\n')).toEqual(['{"a":1}']);
  });

  it('一个 chunk 里多个事件', () => {
    const p = createSseParser();
    expect(p.push('data: 1\n\ndata: 2\n\n')).toEqual(['1', '2']);
  });

  it('CRLF 与注释行', () => {
    const p = createSseParser();
    expect(p.push(': keep-alive\r\ndata: hello\r\n\r\n')).toEqual(['hello']);
  });

  it('多行 data 用换行拼接（规范语义）', () => {
    const p = createSseParser();
    expect(p.push('data: a\ndata: b\n\n')).toEqual(['a\nb']);
  });

  it('flush 吐出没有空行结尾的最后一帧', () => {
    const p = createSseParser();
    expect(p.push('data: tail')).toEqual([]);
    expect(p.flush()).toEqual(['tail']);
  });

  it('[DONE] 原样返回（由上层判断结束）', () => {
    const p = createSseParser();
    expect(p.push('data: [DONE]\n\n')).toEqual(['[DONE]']);
  });
});

/* ------------------------------------------------------------ 上下文裁剪 */

describe('trimMessages', () => {
  const sys: WireMessage = { role: 'system', content: 'SYS' };
  const user = (t: string): WireMessage => ({ role: 'user', content: t });
  const assistant = (t: string): WireMessage => ({ role: 'assistant', content: t });

  it('预算充足时原样返回', () => {
    const m = [sys, user('a'), assistant('b')];
    expect(trimMessages(m, 1000)).toBe(m);
  });

  it('超预算时保留 system，并从 user 边界切开（不留孤立 tool 消息）', () => {
    const m: WireMessage[] = [
      sys,
      user('old-1'),
      assistant('old-2'),
      user('new-1'),
      {
        role: 'assistant',
        content: null,
        tool_calls: [{ id: 'c1', type: 'function', function: { name: 'x', arguments: '{}' } }],
      },
      { role: 'tool', tool_call_id: 'c1', content: 'result' },
    ];
    const out = trimMessages(m, 10);
    expect(out[0]).toBe(sys);
    expect(out.some((x) => x.role === 'tool')).toBe(true);
    // 第一条非 system 必须不是 tool（否则服务端会 400）
    expect(out[1]!.role).not.toBe('tool');
    // 被裁掉的是最老的那组
    expect(JSON.stringify(out)).not.toContain('old-1');
  });
});

describe('上下文压缩的原语', () => {
  const sys: WireMessage = { role: 'system', content: 'SYS' };
  const user = (t: string): WireMessage => ({ role: 'user', content: t });
  const assistant = (t: string): WireMessage => ({ role: 'assistant', content: t });
  const toolCall = (id: string): WireMessage => ({
    role: 'assistant',
    content: null,
    tool_calls: [{ id, type: 'function', function: { name: 'x', arguments: '{}' } }],
  });
  const tool = (id: string): WireMessage => ({ role: 'tool', tool_call_id: id, content: 'r' });

  it('75% 才触发压缩', () => {
    expect(shouldCompact(749_999, 1_000_000)).toBe(false);
    expect(shouldCompact(750_000, 1_000_000)).toBe(true);
  });

  it('裁剪永远不会从 tool / assistant 中间开始', () => {
    const m = [sys, user('u1'), toolCall('c1'), tool('c1'), user('u2'), assistant('a2')];
    const out = trimMessages(m, 1);
    expect(out[0]).toBe(sys);
    expect(out[1]!.role).toBe('user');
    expect(out.some((x) => x.role === 'tool' && !out.some((y) => y.tool_calls?.some((c) => c.id === x.tool_call_id)))).toBe(false);
  });

  it('recentTail 从 user 边界切，不拆开工具对', () => {
    const m = [sys, user('u1'), assistant('a1'), user('u2'), toolCall('c2'), tool('c2')];
    const tail = recentTail(m, 3);
    expect(tail[0]!.role).toBe('user');
    expect(tail[0]!.content).toBe('u2');
    expect(tail.map((x) => x.role)).toEqual(['user', 'assistant', 'tool']);
  });

  it('估算把 reasoning / tool 参数算进去', () => {
    const a = estimateMessagesTokens([{ role: 'assistant', content: 'x', reasoning_content: 'y'.repeat(25) }]);
    expect(a).toBeGreaterThanOrEqual(10);
  });
});

/* --------------------------------------------------------- 重复调用阶梯 */

describe('repeatAction', () => {
  it('前两次不管，第 3 / 6 次提示，12 次才停', () => {
    expect([1, 2, 4, 5, 7, 11].map(repeatAction)).toEqual(Array(6).fill('none'));
    expect(repeatAction(3)).toBe('hint');
    expect(repeatAction(6)).toBe('hint');
    expect(repeatAction(12)).toBe('stop');
    expect(repeatAction(99)).toBe('stop');
  });
});

describe('advanceStreak（只数连续）', () => {
  it('同一键连在一起才累加', () => {
    let s = NO_STREAK;
    for (let i = 0; i < 3; i++) s = advanceStreak(s, 'plugin_try:{}');
    expect(s.count).toBe(3);
  });

  it('中间插进别的工具就清零重数', () => {
    let s = NO_STREAK;
    s = advanceStreak(s, 'plugin_try:{"id":"a"}');
    s = advanceStreak(s, 'plugin_try:{"id":"b"}');
    s = advanceStreak(s, 'render_frame:{"t":0}');
    expect(s.count).toBe(1);
    // 回到原来的键也算新的连续段：累计式计数会在这里数到 2。
    s = advanceStreak(s, 'plugin_try:{"id":"a"}');
    expect(s.count).toBe(1);
  });

  it('同工具不同参数互不累加', () => {
    let s = advanceStreak(NO_STREAK, 'plugin_try:{"v":1}');
    s = advanceStreak(s, 'plugin_try:{"v":2}');
    s = advanceStreak(s, 'plugin_try:{"v":3}');
    expect(s.count).toBe(1);
    expect(repeatAction(s.count)).toBe('none');
  });
});

describe('repeatKeyOf（场景版本参与判据）', () => {
  it('render_frame 在工程变化后是新问题，播放头也是判据的一部分', () => {
    const args = '{"t":0.5,"size":{"w":320,"h":180}}';
    const a = repeatKeyOf('render_frame', args, { version: 5, playT: 0.5 });
    const b = repeatKeyOf('render_frame', args, { version: 6, playT: 0.5 });
    const c = repeatKeyOf('render_frame', args, { version: 6, playT: 1 });
    expect(new Set([a, b, c]).size).toBe(3);
    expect(repeatKeyOf('render_frame', args, { version: 6, playT: 0.5 })).toBe(b);
  });

  it('其它工具不受场景版本影响；没有版本时退回纯参数', () => {
    const args = '{"clipId":"c1"}';
    expect(repeatKeyOf('get_clip', args, { version: 5, playT: 0 })).toBe(repeatKeyOf('get_clip', args, { version: 9, playT: 3 }));
    expect(repeatKeyOf('render_frame', args, null)).toBe(`render_frame:${args}`);
  });
});

/* ------------------------------------------------------------ 思考强度 */

describe('thinkingParams（DeepSeek 原生 reasoning_effort）', () => {
  const deepseek = providerOf('deepseek');

  it('off 只发 thinking.disabled，不带强度', () => {
    expect(thinkingParamsFor(deepseek, 'off', 'deepseek-flash')).toEqual({
      thinking: { type: 'disabled' },
    });
  });

  it('low / high / max 原样作为 reasoning_effort，并显式开启思考', () => {
    for (const effort of ['low', 'high', 'max'] as const) {
      expect(thinkingParamsFor(deepseek, effort, 'deepseek-flash')).toEqual({
        thinking: { type: 'enabled' },
        reasoning_effort: effort,
      });
    }
  });
});

/* ------------------------------------------------------------ 插件说明书 */

function uniformsOf(head: string): string[] {
  return [...head.matchAll(/uniform\s+\w+\s+(u_\w+)\s*;/g)].map((m) => m[1]!);
}

describe('插件协议说明书', () => {
  const ref = pluginReference();

  it('包含两份共享头的**全部** uniform（防止文档与代码漂移）', () => {
    for (const name of [...uniformsOf(EFFECT_HEAD), ...uniformsOf(ALGO_HEAD)]) {
      expect(ref, `缺少 ${name}`).toContain(name);
    }
  });

  it('包含工作流与关键约定', () => {
    for (const needle of ['artmatic-plugin', 'setUniforms', 'plugin_try', 'plugin_install', 'u_time']) {
      expect(ref).toContain(needle);
    }
  });

  it('成本纪律一节在：intRes 由宿主读、aa 是默认关掉的选项', () => {
    // 模型看不见 sdf-lib：这两条必须写在说明书里，否则它要么不声明 intRes，
    // 要么声明一个没人读的 u_aa（AA 静默失效成"off 也不对、x4 也不对"）。
    for (const needle of [
      'Cost discipline',
      'intRes',
      'u_aa',
      "defaultValue: 'off'",
      'n = 1',
    ]) {
      expect(ref, `缺少 ${needle}`).toContain(needle);
    }
  });

  it('help 的主题都可取且非空；未知主题返回可用清单', () => {
    for (const topic of HELP_TOPICS) {
      expect(helpText(topic).length).toBeGreaterThan(100);
    }
    const unknown = helpText('nope');
    for (const topic of HELP_TOPICS) expect(unknown).toContain(topic);
  });
});
