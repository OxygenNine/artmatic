import { describe, expect, it } from 'vitest';
import { createBlankProject } from '../../src/core/demo-project';
import { memoryRoot, writeBytesAtomic } from '../../src/project/fs';
import { SESSION_FILE } from '../../src/project/layout';
import {
  applySession,
  defaultSession,
  parseSession,
  readSessionFile,
  serializeSession,
  writeSessionFile,
} from '../../src/project/session';
import type { Project } from '../../src/core/schema';

/**
 * `session.json`（会话状态）的守卫。
 *
 * 它是一条**可丢弃**的旁路：读坏了最多回到时间轴第 0 秒，绝不能挡住打开工程。
 * 所以这里的重点是「坏输入怎么降级」与「对齐到工程之后还剩什么」，
 * 而不是格式本身。
 */

/** 一条带片段（id = `c1`）的工程。时长 8 s，便于验证播放头钳制。 */
function project(): Project {
  const p = createBlankProject('session-test');
  p.duration = 8;
  const track = p.tracks.find((t) => t.kind === 'visual');
  if (!track) throw new Error('空白工程应当有一条视觉轨');
  track.clips.push({
    kind: 'source',
    id: 'c1',
    start: 0,
    end: 2,
    label: 'solid',
    fadeSec: 0,
    curves: {},
    source: { type: 'solid', color: '#ffffff' },
    blend: 'normal',
    opacity: 1,
    fit: 'contain',
  } as never);
  return p;
}

describe('parseSession：坏输入逐项降级', () => {
  it('正常一份：播放头按毫秒取整、选中集去重、视图原样', () => {
    const s = parseSession({
      format: 1,
      playT: 3.45678,
      selectedClipIds: ['a', 'a', 'b', ''],
      view: { kind: 'grade', clipId: 'x' },
    });
    expect(s).toEqual({
      playT: 3.457,
      selectedClipIds: ['a', 'b'],
      view: { kind: 'grade', clipId: 'x' },
    });
  });

  it('不是对象 / 是数组：整份当成没有', () => {
    expect(parseSession(null)).toBeNull();
    expect(parseSession('nope')).toBeNull();
    expect(parseSession([])).toBeNull();
    expect(parseSession(42)).toBeNull();
  });

  it('字段各坏各的：播放头坏了不带走选中集', () => {
    const s = parseSession({ playT: 'later', selectedClipIds: ['a', 3, null], view: 7 });
    expect(s).toEqual({ playT: 0, selectedClipIds: ['a'], view: { kind: 'timeline' } });
  });

  it('负播放头归 0；未知视图 / 缺 clipId 退回时间轴', () => {
    expect(parseSession({ playT: -5 })?.playT).toBe(0);
    expect(parseSession({ view: { kind: 'nowhere' } })?.view).toEqual({ kind: 'timeline' });
    expect(parseSession({ view: { kind: 'typography' } })?.view).toEqual({ kind: 'timeline' });
    expect(parseSession({ view: { kind: 'timeline' } })?.view).toEqual({ kind: 'timeline' });
  });
});

describe('serializeSession：内容没变 → 字节没变', () => {
  it('键顺序固定、带 format、以换行结尾', () => {
    const text = serializeSession({ playT: 1, selectedClipIds: ['a'], view: { kind: 'timeline' } });
    expect(text).toBe(
      `${JSON.stringify(
        { format: 1, playT: 1, selectedClipIds: ['a'], view: { kind: 'timeline' } },
        null,
        2,
      )}\n`,
    );
  });

  it('同样的状态两次序列化逐字节相同', () => {
    const s = defaultSession();
    expect(serializeSession(s)).toBe(serializeSession({ ...s }));
  });
});

describe('applySession：对齐到当前工程', () => {
  it('没有会话状态时就是默认值', () => {
    expect(applySession(project(), null)).toEqual(defaultSession());
  });

  it('播放头钳进工程时长；负值归 0', () => {
    expect(applySession(project(), { playT: 99, selectedClipIds: [], view: { kind: 'timeline' } }).playT).toBe(8);
    expect(applySession(project(), { playT: -1, selectedClipIds: [], view: { kind: 'timeline' } }).playT).toBe(0);
  });

  it('选中集只留还存在的片段', () => {
    const s = applySession(project(), {
      playT: 1,
      selectedClipIds: ['c1', 'ghost'],
      view: { kind: 'timeline' },
    });
    expect(s.selectedClipIds).toEqual(['c1']);
  });

  it('视图指向的片段没了 → 退回时间轴', () => {
    const s = applySession(project(), {
      playT: 1,
      selectedClipIds: [],
      view: { kind: 'typography', clipId: 'ghost' },
    });
    expect(s.view).toEqual({ kind: 'timeline' });
  });

  it('视图指向一个仍然存在的片段 → 原样保留（页面对不对由 app-state 判）', () => {
    const s = applySession(project(), {
      playT: 1,
      selectedClipIds: [],
      view: { kind: 'grade', clipId: 'c1' },
    });
    expect(s.view).toEqual({ kind: 'grade', clipId: 'c1' });
  });
});

describe('插件面板状态（可选字段）', () => {
  it('老文件没有 panels：解析结果里也没有这一项（不需要迁移）', () => {
    expect(parseSession({ playT: 1 })).not.toHaveProperty('panels');
  });

  it('合法的 panels 原样带出', () => {
    const s = parseSession({
      panels: {
        open: ['demo/browser', 'demo/browser', ''],
        dock: 'demo/inspector',
        boxes: { 'demo/browser': { x: 12.4, y: 20, w: 360, h: 420 } },
      },
    });
    expect(s?.panels).toEqual({
      open: ['demo/browser'],
      dock: 'demo/inspector',
      boxes: { 'demo/browser': { x: 12, y: 20, w: 360, h: 420 } },
    });
  });

  it('坏盒子逐项丢：不因为一个手改过的几何丢掉打开着的面板', () => {
    const s = parseSession({
      panels: {
        open: ['a/p'],
        boxes: { good: { x: 0, y: 0, w: 300, h: 200 }, tiny: { x: 0, y: 0, w: 10, h: 10 }, bad: 'nope' },
      },
    });
    expect(s?.panels?.open).toEqual(['a/p']);
    expect(Object.keys(s?.panels?.boxes ?? {})).toEqual(['good']);
  });

  it('panels 整个不是对象：当成没有，其余字段照常', () => {
    const s = parseSession({ playT: 2, panels: 'x' });
    expect(s?.playT).toBe(2);
    expect(s).not.toHaveProperty('panels');
  });

  it('序列化：没有 panels 时字节与旧版一致；有则键排序（同样内容 → 同样字节）', () => {
    const plain = serializeSession({ playT: 1, selectedClipIds: [], view: { kind: 'timeline' } });
    expect(plain).not.toContain('panels');

    const a = serializeSession({
      playT: 1,
      selectedClipIds: [],
      view: { kind: 'timeline' },
      panels: { open: ['b/p', 'a/p'], dock: null, boxes: { 'b/p': { x: 1, y: 2, w: 300, h: 200 } } },
    });
    const b = serializeSession({
      playT: 1,
      selectedClipIds: [],
      view: { kind: 'timeline' },
      panels: { open: ['b/p', 'a/p'], dock: null, boxes: { 'b/p': { x: 1, y: 2, w: 300, h: 200 } } },
    });
    expect(a).toBe(b);
    expect(a.indexOf('"panels"')).toBeLessThan(a.indexOf('"b/p"'));
  });

  it('applySession 把面板状态原样带过去（它与工程内容无关）', () => {
    const panels = { open: ['demo/p'], boxes: {}, dock: null };
    const s = applySession(project(), { playT: 99, selectedClipIds: [], view: { kind: 'timeline' }, panels });
    expect(s.panels).toEqual(panels);
  });
});

describe('session.json 的读写：一律降级', () => {
  it('往返：写进去什么读出来什么', async () => {
    const root = memoryRoot();
    const dir = await root.openDir('p', { create: true });
    const s = { playT: 2.5, selectedClipIds: ['c1'], view: { kind: 'typography' as const, clipId: 'c1' } };
    expect(await writeSessionFile(dir, s)).toBe(true);
    expect(await readSessionFile(dir)).toEqual(s);
  });

  it('没有文件 → null（旧工程 / 第一次打开）', async () => {
    const root = memoryRoot();
    const dir = await root.openDir('empty', { create: true });
    expect(await readSessionFile(dir)).toBeNull();
  });

  it('坏 JSON / 坏结构 → null 或默认值，不抛', async () => {
    const root = memoryRoot();
    const bad = await root.openDir('bad', { create: true });
    await writeBytesAtomic(bad, SESSION_FILE, '{ oops');
    expect(await readSessionFile(bad)).toBeNull();

    const odd = await root.openDir('odd', { create: true });
    await writeBytesAtomic(odd, SESSION_FILE, JSON.stringify({ playT: 'x' }));
    expect(await readSessionFile(odd)).toEqual({
      playT: 0,
      selectedClipIds: [],
      view: { kind: 'timeline' },
    });
  });

  it('写入失败返回 false，不抛（会话状态可以丢）', async () => {
    const root = memoryRoot();
    const dir = await root.openDir('ro', { create: true });
    root.setFault((op) => (op === 'write' ? new Error('permission denied') : null));
    expect(await writeSessionFile(dir, defaultSession())).toBe(false);
  });
});
