/**
 * agent-models-dev.test.ts — models.dev 目录的解析与合并守卫。
 *
 * 这个文件的用例钉的都是「不报错但列表不对」的形态：
 *   · 目录里混进图片模型 → 用户选中得到一个不能调工具的模型 → 一轮空转
 *   · 没按发布日排序 → 最新的一代排在第 13 位，被 `LIVE_MODEL_LIMIT` 截掉
 *   · 目录挂了就把静态预设也一起清了 → 下拉空、默认模型变空串
 *   · 新加一家忘了映射 → 那一家永远显示三年前的模型，零报错
 */

import { describe, expect, it } from 'vitest';
import {
  LIVE_MODEL_LIMIT,
  MAX_PRESETS,
  MODELS_DEV_SOURCE,
  MODELS_DEV_UNMAPPED,
  mergeModelPresets,
  parseModelsDev,
} from '../../src/agent/llm/providers/models-dev';
import { PROVIDERS } from '../../src/agent/llm/providers/registry';
import type { ProviderId } from '../../src/agent/llm/providers/ids';

/** 一条像样的目录条目。 */
const entry = (over: Record<string, unknown> = {}) => ({
  id: 'x',
  type: 'chat',
  tool_call: true,
  release_date: '2026-01-01',
  limit: { context: 1_000_000 },
  ...over,
});

describe('parseModelsDev', () => {
  it('只留能接工具的对话模型', () => {
    const payload = {
      deepseek: {
        models: {
          good: entry({ id: 'good' }),
          'no-tools': entry({ id: 'no-tools', tool_call: false }),
          image: entry({ id: 'image', type: 'image' }),
          gone: entry({ id: 'gone', status: 'deprecated' }),
          // `:free` 是同一模型的限流变体，不是另一代
          'good:free': entry({ id: 'good:free', release_date: '2026-12-01' }),
        },
      },
    };
    expect([...(parseModelsDev(payload, { deepseek: 'deepseek' }).get('deepseek') ?? [])]).toEqual([
      'good',
    ]);
  });

  it('按发布日倒序；没有日期的排最后', () => {
    const payload = {
      deepseek: {
        models: {
          old: entry({ id: 'old', release_date: '2026-01-01' }),
          newest: entry({ id: 'newest', release_date: '2026-11-09' }),
          mid: entry({ id: 'mid', release_date: '2026-06-01' }),
          undated: entry({ id: 'undated', release_date: undefined }),
        },
      },
    };
    expect(parseModelsDev(payload, { deepseek: 'deepseek' }).get('deepseek')).toEqual([
      'newest',
      'mid',
      'old',
      'undated',
    ]);
  });

  it('截断留的是最新的那几条，不是目录里的前几条', () => {
    const models: Record<string, unknown> = {};
    // 目录本身是乱序的（按 key 排，不是按时间）：i 越大越新。
    for (let i = 0; i < 20; i++) {
      models[`m${String(i).padStart(2, '0')}`] = entry({
        id: `m${String(i).padStart(2, '0')}`,
        release_date: `2026-01-${String(i + 1).padStart(2, '0')}`,
      });
    }
    const list = parseModelsDev({ p: { models } }, { deepseek: 'p' }).get('deepseek') ?? [];
    expect(list).toHaveLength(LIVE_MODEL_LIMIT);
    expect(list[0]).toBe('m19');
    expect(list).not.toContain('m00');
  });

  it('条目没写 id 时用字典的键', () => {
    const payload = { p: { models: { 'alias-name': entry({ id: undefined }) } } };
    expect(parseModelsDev(payload, { deepseek: 'p' }).get('deepseek')).toEqual(['alias-name']);
  });

  it('坏数据一律跳过，不抛', () => {
    for (const payload of [null, undefined, 'nope', 42, [], {}, { p: null }, { p: { models: 5 } }]) {
      expect(() => parseModelsDev(payload, { deepseek: 'p' })).not.toThrow();
      expect(parseModelsDev(payload, { deepseek: 'p' }).size).toBe(0);
    }
    // 单条坏掉不影响同桶里好的那条
    const mixed = { p: { models: { a: 'x', b: entry({ id: 'b' }), c: null } } };
    expect(parseModelsDev(mixed, { deepseek: 'p' }).get('deepseek')).toEqual(['b']);
  });

  it('目录里没有这一家时，桶不出现（而不是空数组）', () => {
    expect(parseModelsDev({}, { deepseek: 'missing' }).has('deepseek')).toBe(false);
  });
});

describe('mergeModelPresets', () => {
  it('目录在前、静态垫后、按序去重', () => {
    expect(mergeModelPresets(['static-a', 'shared'], ['new-1', 'shared', 'new-2'])).toEqual([
      'new-1',
      'shared',
      'new-2',
      'static-a',
    ]);
  });

  it('目录为空时原样返回静态预设（离线兜底）', () => {
    expect(mergeModelPresets(['a', 'b'], [])).toEqual(['a', 'b']);
    expect(mergeModelPresets(['a', 'b'], undefined)).toEqual(['a', 'b']);
  });

  it('总长有上限，且空的 id 不会占位', () => {
    const live = Array.from({ length: MAX_PRESETS + 5 }, (_, i) => `l${i}`);
    const merged = mergeModelPresets(['s'], live);
    expect(merged).toHaveLength(MAX_PRESETS);
    // 被截掉的是尾巴（静态预设与目录里更旧的那些），不是新模型
    expect(merged[MAX_PRESETS - 1]).toBe(`l${MAX_PRESETS - 1}`);
    expect(merged).not.toContain('s');
    expect(mergeModelPresets(['a'], ['', 'b'])).toEqual(['b', 'a']);
  });
});

describe('目录映射表', () => {
  /**
   * 三个集合必须严丝合缝：映射 ∪ 豁免 = 注册表全集。
   * 漏掉一家的表现是「这一家永远只显示注册表里的快照」，而快照会腐烂 ——
   * 那正是这次要修的问题本身，所以它必须是红测。
   */
  it('映射 ∪ 豁免 恰好等于注册表的全部 provider', () => {
    const all = PROVIDERS.map((p) => p.id).sort();
    const mapped = Object.keys(MODELS_DEV_SOURCE) as ProviderId[];
    const covered = [...mapped, ...MODELS_DEV_UNMAPPED].sort();
    expect(covered).toEqual(all);
    expect(new Set(covered).size, '映射与豁免重叠').toBe(covered.length);
    for (const id of mapped) expect(PROVIDERS.some((p) => p.id === id), `孤儿映射：${id}`).toBe(true);
  });

  it('映射值非空、无重复（同一个上游不该被两家抢）', () => {
    const upstream = Object.values(MODELS_DEV_SOURCE);
    for (const v of upstream) expect(String(v)).toMatch(/^[a-z0-9-]+$/);
    expect(new Set(upstream).size).toBe(upstream.length);
  });
});
