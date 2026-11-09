/**
 * Agent 会话历史的不变量（v5 起历史住在 `agent/sessions/`，不再进 project.json）：
 *
 *  1. **坏数据不能把工程弄成打不开的**：清洗函数永不抛，坏条目逐条丢弃。
 *  2. **上限仍然生效**：30 会话 / 400 条 / 20k 字 —— 换存储位置不改变这条。
 *  3. **被挤出去的会话要能被删掉**（`upsertAgentSession` 回传 `evicted`），
 *     否则下次打开工程它们又会出现在历史里。
 *  4. **工程里不再有历史**：v11 → v12 迁移把它删掉，撤销快照也不再需要特例。
 */

import { describe, expect, it } from 'vitest';
import {
  MAX_MESSAGES,
  MAX_SESSIONS,
  MAX_TEXT,
  resumedMessages,
  sanitizeAgentSession,
  sanitizeAgentSessions,
  upsertAgentSession,
  type AgentSessionRecord,
} from '../../src/agent/history';
import { migrateProject, SCHEMA_VERSION, validateProject } from '../../src/core/schema';
import { ProjectStore } from '../../src/core/project-store';
import { createBlankProject } from '../../src/core/demo-project';

function session(id: string, updatedAt = 1): AgentSessionRecord {
  return {
    id,
    title: `会话 ${id}`,
    createdAt: 1,
    updatedAt,
    messages: [{ role: 'user', text: '你好' }],
  };
}

describe('sanitizeAgentSession / sanitizeAgentSessions', () => {
  it('非数组 / 坏条目直接丢弃，不抛', () => {
    expect(sanitizeAgentSessions(null)).toEqual([]);
    expect(sanitizeAgentSessions('x')).toEqual([]);
    expect(
      sanitizeAgentSessions([
        { id: '', messages: [] },
        { id: 'a', messages: 'nope' },
        { id: 'b', messages: [{ role: 'wat', text: 'x' }, { role: 'user', text: 'ok' }] },
      ]).map((s) => s.id),
    ).toEqual(['b']);
  });

  it('单条会话：没有 id / 没有可用消息 = null（不产出一条空会话）', () => {
    expect(sanitizeAgentSession(null)).toBeNull();
    expect(sanitizeAgentSession({ id: 'x', messages: [] })).toBeNull();
    expect(sanitizeAgentSession({ id: 'x', messages: [{ role: 'user', text: 'hi' }] })?.id).toBe('x');
  });

  it('按 updatedAt 保留最近的 30 个', () => {
    const many = Array.from({ length: 40 }, (_, i) => session(`s${i}`, i));
    const out = sanitizeAgentSessions(many);
    expect(out).toHaveLength(MAX_SESSIONS);
    expect(out[0]!.id).toBe('s39');
    expect(out.at(-1)!.id).toBe(`s${40 - MAX_SESSIONS}`);
  });

  it('同一 id 只留一条；单条文本与消息数有上限', () => {
    const out = sanitizeAgentSessions([
      { ...session('dup', 1) },
      { ...session('dup', 2) },
      {
        id: 'long',
        title: 't',
        createdAt: 0,
        updatedAt: 3,
        messages: Array.from({ length: 500 }, () => ({ role: 'assistant', text: 'x'.repeat(30_000) })),
      },
    ]);
    expect(out.map((s) => s.id)).toEqual(['long', 'dup']);
    expect(out[0]!.messages).toHaveLength(MAX_MESSAGES);
    expect(out[0]!.messages[0]!.text).toHaveLength(MAX_TEXT);
  });
});

describe('upsertAgentSession', () => {
  it('覆盖同 id、按 updatedAt 排序、超出上限时回传被挤掉的 id', () => {
    const list = Array.from({ length: MAX_SESSIONS }, (_, i) => session(`s${i}`, i));
    const { sessions, evicted } = upsertAgentSession(list, session('new', 999));
    expect(sessions).toHaveLength(MAX_SESSIONS);
    expect(sessions[0]!.id).toBe('new');
    // 最旧的那条被挤出去，并且**必须**由调用方删文件（否则下次打开它又回来了）
    expect(evicted).toEqual(['s0']);
  });

  it('同 id 覆盖不改变条数，也不算挤掉别人', () => {
    const list = [session('a', 1), session('b', 2)];
    const { sessions, evicted } = upsertAgentSession(list, { ...session('a', 3), title: '新标题' });
    expect(sessions.map((s) => s.id)).toEqual(['a', 'b']);
    expect(sessions[0]!.title).toBe('新标题');
    expect(evicted).toEqual([]);
  });
});

describe('resumedMessages（从历史恢复会话）', () => {
  const record: AgentSessionRecord = {
    id: 'r1',
    title: '恢复',
    createdAt: 1,
    updatedAt: 2,
    messages: [
      { role: 'user', text: '把背景调蓝' },
      { role: 'reasoning', text: '想一想' },
      { role: 'assistant', text: '先看看场景' },
      { role: 'tool', text: '{"ok":true}', toolName: 'get_scene', toolStatus: 'ok' },
      { role: 'assistant', text: '改好了' },
      { role: 'image', text: 'Rendered frame', caption: 'Rendered frame' },
      { role: 'error', text: '网络错误' },
      { role: 'user', text: '再亮一点' },
    ],
  };

  it('只接 user / assistant 的文本，工具与截图不进上下文', () => {
    expect(resumedMessages(record)).toEqual([
      { role: 'user', content: '把背景调蓝' },
      // 丢掉中间的工具卡之后，两条 assistant 是相邻的 ⇒ 合并成一条
      { role: 'assistant', content: '先看看场景\n\n改好了' },
      { role: 'user', content: '再亮一点' },
    ]);
  });

  it('空白消息与只有工具调用的会话不产生空消息', () => {
    expect(resumedMessages({ ...record, messages: [{ role: 'assistant', text: '   ' }] })).toEqual([]);
    expect(
      resumedMessages({
        ...record,
        messages: [{ role: 'tool', text: 'x', toolName: 'get_scene', toolStatus: 'ok' }],
      }),
    ).toEqual([]);
  });

  it('不改动传入的记录（恢复是只读投影）', () => {
    const copy = structuredClone(record);
    resumedMessages(record);
    expect(record).toEqual(copy);
  });
});

describe('历史不在工程里（v12）', () => {
  it('v11 工程带着 agentSessions 也能打开：字段被迁移掉，内容一字不差', () => {
    const p = createBlankProject('legacy') as unknown as Record<string, unknown>;
    p.schemaVersion = 11;
    p.agentSessions = [session('keep')];
    const out = migrateProject(JSON.parse(JSON.stringify(p)));
    expect(out.schemaVersion).toBe(SCHEMA_VERSION);
    expect(out.name).toBe('legacy');
    expect('agentSessions' in out).toBe(false);
  });

  it('手改 JSON 留下 agentSessions 也不会被当成工程字段保留', () => {
    const p = createBlankProject('stray') as unknown as Record<string, unknown>;
    p.agentSessions = [session('x')];
    const out = validateProject(structuredClone(p));
    expect('agentSessions' in out).toBe(false);
  });


});
