import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChatResult } from '../../src/agent/llm/types';

const streamChatMock = vi.hoisted(() => vi.fn());

vi.mock('../../src/agent/llm/transport', () => ({
  LLM_TIMEOUT_MS: 1,
  streamChat: streamChatMock,
}));

import { AgentSession } from '../../src/agent/llm/session';
import { AGENT_TOOLS } from '../../src/agent/tools';
import {
  WRITE_TARGETS,
  checkWrite,
  claimDomains,
  createWriteFence,
  domainsOverlap,
  parseSubagentResult,
  presetTools,
  presetWritable,
  writeTargetsOf,
  type WriteClaim,
} from '../../src/agent/llm/subagents';

// 每个用例都从干净的 mock 出发：`mockResolvedValueOnce` 留在队列里会悄悄顶掉
// 下一个用例的 `mockImplementation`（表现是「断言里拿到 undefined」）。
beforeEach(() => {
  streamChatMock.mockReset();
});

const CONFIG = {
  providerId: 'deepseek',
  baseUrl: 'https://api.deepseek.com',
  apiKey: 'test-key',
  model: 'deepseek-chat',
  temperature: 0,
  effort: 'off' as const,
  proxyPath: null,
};

/* ------------------------------------------------------------ 域键登记 */

/**
 * 有副作用但 `writes: false` 的工具。它们同样要过栅栏（试挂会执行源码、
 * 安装写盘、导出落盘、开事务改全局状态）。
 */
const SIDE_EFFECT_TOOLS = [
  'plugin_edit',
  'plugin_try',
  'plugin_install',
  'plugin_discard',
  'plugin_remove',
  'export',
  'begin_transaction',
];

describe('写栅栏的域键登记', () => {
  it('每一个会写工程的工具都在 WRITE_TARGETS 里有显式条目', () => {
    const must = [...AGENT_TOOLS.filter((t) => t.writes).map((t) => t.name), ...SIDE_EFFECT_TOOLS];
    const missing = must.filter((n) => !(n in WRITE_TARGETS));
    // 漏一个 = 走 fail-closed 兜底 global；父代理单干时 global 是放行的，
    // 于是「两个代理同时改同一个片段」不会有任何报错。这条断言就是那道闸。
    expect(missing, 'these write tools are missing from WRITE_TARGETS').toEqual([]);
  });

  it('未知工具 fail-closed 到 global', () => {
    expect(writeTargetsOf('some_future_tool', {})).toEqual(['global']);
  });

  it('跨对象的一笔写返回多个域', () => {
    expect(writeTargetsOf('move_clip', { clipId: 'c1', targetTrackId: 't2' })).toEqual([
      'clip:c1',
      'track:t2',
    ]);
  });

  it('typo_* 缺 clipId 时返回空数组（不是 global）', () => {
    // 空数组 =「解析不出目标」：父代理单干时合法（= 当前打开的那份文档），
    // 有子代理在跑时会被拒。global 会把它变成「和所有人都冲突」。
    expect(writeTargetsOf('typo_set_text', { elementId: 'e1' })).toEqual([]);
    expect(writeTargetsOf('typo_set_text', { clipId: 'c9', elementId: 'e1' })).toEqual(['typo:c9']);
  });

  it('工程级主题写的是 project，不是 clip', () => {
    expect(writeTargetsOf('typo_set_theme', { clipId: 'c1', scope: 'project' })).toEqual(['project']);
    expect(writeTargetsOf('typo_save_theme', { clipId: 'c1' })).toEqual(['project']);
    expect(writeTargetsOf('typo_remove_theme', {})).toEqual(['project']);
  });

  it('整工程替换与撤销是 global', () => {
    for (const name of ['load_scene', 'undo', 'redo', 'commit_transaction']) {
      expect(writeTargetsOf(name, {}), name).toEqual(['global']);
    }
  });
});

/* --------------------------------------------------------------- 冲突判定 */

function claim(ownerId: string, domains: string[]): WriteClaim {
  return { ownerId, domains: new Set(domains) };
}

describe('checkWrite', () => {
  const tx = { txOpen: true };

  it('自己域内的写放行', () => {
    const verdict = checkWrite([claim('a1', ['clip:c1'])], 'a1', ['clip:c1'], tx);
    expect(verdict.ok).toBe(true);
  });

  it('写到自己的 scope 之外被拒', () => {
    const verdict = checkWrite([claim('a1', ['clip:c1'])], 'a1', ['clip:c2'], tx);
    expect(verdict).toMatchObject({ ok: false, reason: 'scope', target: 'clip:c2' });
  });

  it('父代理撞子代理的 reservation（父的 claim 是全域）', () => {
    const verdict = checkWrite([claim('a1', ['clip:c1'])], 'parent', ['clip:c1'], tx);
    expect(verdict).toMatchObject({ ok: false, reason: 'reserved', owner: 'a1' });
  });

  it('父代理写别处不受影响', () => {
    expect(checkWrite([claim('a1', ['clip:c1'])], 'parent', ['clip:c2'], tx).ok).toBe(true);
  });

  it('两个子代理 scope 相交 → 互相 conflict', () => {
    const claims = [claim('a1', ['plugin:p']), claim('a2', ['plugin:p'])];
    expect(checkWrite(claims, 'a2', ['plugin:p'], tx)).toMatchObject({ ok: false, reason: 'reserved' });
  });

  it('父轮不在事务里时子代理不能写（撤销语义会断裂）', () => {
    const verdict = checkWrite([claim('a1', ['clip:c1'])], 'a1', ['clip:c1'], { txOpen: false });
    expect(verdict).toMatchObject({ ok: false, reason: 'tx-closed' });
  });

  it('解析不出目标：父单干放行，有 reservation 时拒绝', () => {
    expect(checkWrite([], 'parent', [], tx).ok).toBe(true);
    expect(checkWrite([claim('a1', ['clip:c1'])], 'parent', [], tx)).toMatchObject({
      ok: false,
      reason: 'unresolved',
    });
    expect(checkWrite([], 'a1', [], tx)).toMatchObject({ ok: false, reason: 'unresolved' });
  });
});

describe('createWriteFence', () => {
  it('只读的 reservation 不占位（并发上限才有意义）', () => {
    let open = true;
    const fence = createWriteFence({ txOpen: () => open });
    fence.reserve('a1', []);
    expect(fence.active()).toBe(false);
    expect(fence.claims()).toEqual([]);
    open = false;
  });

  it('reserve / release 成对生效', () => {
    const fence = createWriteFence({ txOpen: () => true });
    fence.reserve('a1', ['clip:c1']);
    expect(fence.check('parent', ['clip:c1']).ok).toBe(false);
    fence.release('a1');
    expect(fence.check('parent', ['clip:c1']).ok).toBe(true);
  });
});

describe('claimDomains', () => {
  it('片段同时授予 clip 与 typo（文本片段的文档挂在片段上）', () => {
    const domains = claimDomains({ clips: ['c1'] });
    expect(domains).toContain('clip:c1');
    expect(domains).toContain('typo:c1');
  });

  it('空 scope → 空集（纯只读）', () => {
    expect(claimDomains(null)).toEqual([]);
    expect(claimDomains({})).toEqual([]);
  });

  it('overlap 判据只看交集', () => {
    expect(domainsOverlap(['clip:c1'], [])).toBe(false);
    expect(domainsOverlap(['clip:c1'], ['clip:c2'])).toBe(false);
    expect(domainsOverlap(['clip:c1', 'media'], ['media'])).toBe(true);
  });
});

/* ----------------------------------------------------------------- 预设 */

describe('子代理预设', () => {
  const FORBIDDEN = [
    'spawn_agent',
    'wait_for_agent',
    'cancel_agent',
    'ask_user',
    'plugin_try',
    'plugin_install',
    'plugin_invoke',
    'media_op',
    'load_scene',
    'undo',
    'redo',
    'set_project',
    'begin_transaction',
    'web_search',
    'web_fetch',
  ];

  it('三个预设都不含越权工具', () => {
    for (const preset of ['explore', 'review', 'code'] as const) {
      for (const canWrite of [false, true]) {
        const names = presetTools(preset, canWrite).map((t) => t.name);
        for (const bad of FORBIDDEN) {
          expect(names, `${preset} canWrite=${canWrite} must not expose ${bad}`).not.toContain(bad);
        }
      }
    }
  });

  it('canWrite=false 时任何写工具都不出现', () => {
    for (const preset of ['explore', 'review', 'code'] as const) {
      expect(presetTools(preset, false).filter((t) => t.writes)).toEqual([]);
    }
  });

  it('只有 code 预设支持写', () => {
    expect(presetWritable('code')).toBe(true);
    expect(presetWritable('explore')).toBe(false);
    expect(presetWritable('review')).toBe(false);
    expect(presetTools('code', true).some((t) => t.name === 'plugin_edit')).toBe(true);
  });

  it('review 预设需要模型能读图，且确实带着渲染工具', () => {
    const names = presetTools('review', false).map((t) => t.name);
    expect(names).toContain('render_frame');
    expect(names).toContain('render_sequence');
  });
});

/* ------------------------------------------------------------- 结果契约 */

describe('parseSubagentResult', () => {
  it('裸 JSON', () => {
    const r = parseSubagentResult('{"summary":"ok","evidence":["c1"],"gaps":[],"needsDecision":null}');
    expect(r).toMatchObject({ summary: 'ok', evidence: ['c1'], gaps: [], needsDecision: null, unstructured: false });
  });

  it('包在 markdown fence 里也能取到', () => {
    const r = parseSubagentResult('Here you go:\n```json\n{"summary":"s","evidence":[]}\n```\n');
    expect(r.summary).toBe('s');
    expect(r.unstructured).toBe(false);
  });

  it('前后有废话时取第一个对象', () => {
    const r = parseSubagentResult('I looked at it. {"summary":"found 3","evidence":["t:1"]} done.');
    expect(r.summary).toBe('found 3');
  });

  it('不是 JSON 时不抛，原文当 summary 并记一条 gap', () => {
    const r = parseSubagentResult('the frame is too dark');
    expect(r.unstructured).toBe(true);
    expect(r.summary).toBe('the frame is too dark');
    expect(r.gaps.length).toBe(1);
  });

  it('空输出不抛', () => {
    const r = parseSubagentResult('   ');
    expect(r.summary).toBe('');
    expect(r.unstructured).toBe(true);
  });

  it('超长 summary 被截断', () => {
    const long = 'x'.repeat(5000);
    const r = parseSubagentResult(JSON.stringify({ summary: long }));
    expect(r.summary.length).toBeLessThan(5000);
  });
});

/* ------------------------------------------------------- 会话层的闸门 */

function stopResult(content = 'done'): ChatResult {
  return { content, reasoning: '', toolCalls: [], usage: null, finishReason: 'stop' };
}

function oneToolCall(name: string, args: Record<string, unknown> = {}): ChatResult {
  return {
    content: '',
    reasoning: '',
    toolCalls: [{ id: 'c1', name, arguments: JSON.stringify(args) }],
    usage: null,
    finishReason: 'tool_calls',
  };
}

describe('AgentSession 的子代理形态', () => {
  it('白名单外的工具不会被执行（幻觉调用也不行）', async () => {
    const execute = vi.fn(async () => ({ ok: true, text: '{}' }));
    streamChatMock.mockResolvedValueOnce(oneToolCall('set_params', { clipId: 'c1' })).mockResolvedValueOnce(stopResult());

    const allowed = AGENT_TOOLS.filter((t) => t.name === 'get_scene');
    const session = new AgentSession({
      config: CONFIG,
      control: {
        beginTx: async () => ({ ok: true, data: { open: true } }),
        endTx: async () => ({ ok: true, data: { changed: true } }),
        sceneVersion: async () => ({ ok: false, error: { code: 'x', message: '' } }),
      } as never,
      execute,
      tools: allowed,
      onEvent: () => {},
      onStatus: () => {},
    });

    await session.send('hi');
    expect(execute).not.toHaveBeenCalled();
    const toolMsg = session.snapshot().messages.find((m) => m.role === 'tool');
    expect(toolMsg?.content).toContain('not-available');
  });

  it('tx:false 时不开也不关事务（父轮已经持着一笔）', async () => {
    const beginTx = vi.fn(async () => ({ ok: true as const, data: { open: true } }));
    const endTx = vi.fn(async () => ({ ok: true as const, data: { changed: true } }));
    streamChatMock.mockResolvedValueOnce(stopResult());

    const session = new AgentSession({
      config: CONFIG,
      control: { beginTx, endTx } as never,
      execute: async () => ({ ok: true, text: '{}' }),
      tx: false,
      onEvent: () => {},
      onStatus: () => {},
    });

    await session.send('hi');
    expect(beginTx).not.toHaveBeenCalled();
    expect(endTx).not.toHaveBeenCalled();
  });

  it('systemPrompt / contextLimit 生效，且 400 自愈之后仍然是子代理的人格', async () => {
    const { LlmError } = await import('../../src/agent/llm/types');
    streamChatMock.mockRejectedValueOnce(new LlmError('bad-response', 'bad')).mockResolvedValueOnce(stopResult());

    const session = new AgentSession({
      config: CONFIG,
      control: {
        beginTx: async () => ({ ok: true, data: { open: true } }),
        endTx: async () => ({ ok: true, data: { changed: true } }),
      } as never,
      execute: async () => ({ ok: true, text: '{}' }),
      systemPrompt: 'SUBAGENT PERSONA',
      contextLimit: 1234,
      onEvent: () => {},
      onStatus: () => {},
    });

    expect(session.context.limit).toBe(1234);
    await session.send('hi');
    expect(session.snapshot().messages[0]?.content).toBe('SUBAGENT PERSONA');
  });
});

/* ------------------------------------------------------------ 收件箱 */

describe('子代理结果的投递', () => {
  it('父轮开始时把排队的结论拼进这条消息', async () => {
    const sent: string[] = [];
    streamChatMock.mockImplementation((_cfg, messages: { role: string; content: unknown }[]) => {
      const last = messages[messages.length - 1];
      sent.push(typeof last?.content === 'string' ? last.content : '');
      return Promise.resolve(stopResult());
    });

    let queued = ['[subagent explore a1] tracks 3-5 are empty'];
    const session = new AgentSession({
      config: CONFIG,
      control: {
        beginTx: async () => ({ ok: true, data: { open: true } }),
        endTx: async () => ({ ok: true, data: { changed: true } }),
      } as never,
      execute: async () => ({ ok: true, text: '{}' }),
      subagents: {
        takeResults: () => {
          const out = queued;
          queued = [];
          return out;
        },
        cancelAll: () => {},
        available: () => true,
        usage: () => ({ hit: 0, miss: 0, out: 0 }),
        resetUsage: () => {},
      },
      onEvent: () => {},
      onStatus: () => {},
    });

    await session.send('continue');
    expect(sent[0]).toContain('tracks 3-5 are empty');
    expect(sent[0]).toContain('continue');
    // 只投递一次。
    expect(queued).toEqual([]);
  });
});
