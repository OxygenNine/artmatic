import { describe, expect, it } from 'vitest';
import {
  applyUniqueEdit,
  grepSource,
  sourceLines,
  VIEW_MAX_LIMIT,
  viewSource,
} from '../../src/agent/plugin-text';

/**
 * Agent 编辑插件源码的三件文本原语。
 *
 * 这三条错了都不会报错、只会「改错地方」或「翻页翻丢」——所以边界要在这里钉死：
 * 唯一匹配的三种失败、行号从 1 开始、末页之后没有下一页。
 */

const SRC = [
  'export const plugin = {',
  "  id: 'demo',",
  '  effects: [],',
  '};',
].join('\n');

describe('sourceLines', () => {
  it('空文件算一行空行（编辑器里也有一行光标位）', () => {
    expect(sourceLines('')).toEqual(['']);
  });

  it('末尾换行不额外产生空行，连续两个换行才产生', () => {
    expect(sourceLines('a\n')).toEqual(['a']);
    expect(sourceLines('a\n\n')).toEqual(['a', '']);
  });

  it('CRLF 归一：行尾不留 \\r（模型要能直接复制出去当 old_string）', () => {
    expect(sourceLines('a\r\nb\r\n')).toEqual(['a', 'b']);
  });
});

describe('viewSource', () => {
  it('带行号，行号从 1 开始且右对齐', () => {
    const v = viewSource(SRC);
    expect(v.text).toContain('  1 | export const plugin = {');
    expect(v.text).toContain("  2 |   id: 'demo',");
    expect(v.from).toBe(1);
    expect(v.to).toBe(4);
    expect(v.total).toBe(4);
    expect(v.hasMore).toBe(false);
    expect(v.nextOffset).toBeNull();
    expect(v.text).toContain('[end of file (4 lines)]');
  });

  it('分页：第二页从 offset 起，并给出 nextOffset 与剩余行数', () => {
    const v = viewSource(SRC, 3, 1);
    expect(v.from).toBe(3);
    expect(v.to).toBe(3);
    expect(v.text).toContain('  3 |   effects: [],');
    expect(v.hasMore).toBe(true);
    expect(v.nextOffset).toBe(4);
    expect(v.text).toContain('[1 more lines; continue with offset=4]');
  });

  it('offset 越界返回空页而不是报错（文件可能在上次读之后被改短）', () => {
    const v = viewSource(SRC, 99);
    expect(v.from).toBe(5);
    expect(v.to).toBe(4);
    expect(v.text).toBe('[end of file (4 lines)]');
    expect(v.hasMore).toBe(false);
  });

  it('limit 被夹在上限内', () => {
    const v = viewSource(SRC, 1, 10_000);
    expect(v.to).toBe(4);
    expect(VIEW_MAX_LIMIT).toBeGreaterThan(0);
  });
});

describe('grepSource', () => {
  it('返回 1-based 行号与整行', () => {
    const r = grepSource(SRC, /id:/);
    expect(r.total).toBe(1);
    expect(r.matches).toEqual([{ line: 2, text: "  id: 'demo'," }]);
    expect(r.truncated).toBe(false);
  });

  it('context 给出前后行，但不越过文件边界', () => {
    const r = grepSource(SRC, /effects/, { context: 1 });
    expect(r.matches[0]!.before).toEqual(["  id: 'demo',"]);
    expect(r.matches[0]!.after).toEqual(['};']);
  });

  it('max 截断列表但 total 仍然是完整命中数', () => {
    const r = grepSource('a\na\na\n', /a/, { max: 2 });
    expect(r.matches).toHaveLength(2);
    expect(r.total).toBe(3);
    expect(r.truncated).toBe(true);
  });
});

describe('applyUniqueEdit', () => {
  it('唯一匹配：替换并给出行号', () => {
    const r = applyUniqueEdit(SRC, "id: 'demo',", "id: 'better',");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.line).toBe(2);
    expect(r.source).toContain("id: 'better',");
    expect(r.source.split('\n')).toHaveLength(4);
  });

  it('没有匹配 → not-found（不改任何东西）', () => {
    expect(applyUniqueEdit(SRC, 'id: "nope"', 'x')).toEqual({ ok: false, code: 'not-found' });
  });

  it('命中多处 → ambiguous，并报出全部行号', () => {
    const r = applyUniqueEdit('a\na\n', 'a', 'b');
    expect(r).toEqual({ ok: false, code: 'ambiguous', lines: [1, 2] });
  });

  it('空 old_string 与「替换成自己」都被拒绝', () => {
    expect(applyUniqueEdit(SRC, '', 'x')).toEqual({ ok: false, code: 'empty-old' });
    expect(applyUniqueEdit(SRC, 'id:', 'id:')).toEqual({ ok: false, code: 'same' });
  });

  it('CRLF 文件：模型复制的 LF old_string 也能命中，写回保持 CRLF', () => {
    const crlf = SRC.replace(/\n/g, '\r\n');
    const r = applyUniqueEdit(crlf, "id: 'demo',\n  effects", "id: 'crlf',\n  effects");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.source).toContain("id: 'crlf',\r\n  effects");
    expect(r.source).not.toContain("id: 'crlf',\n  effects");
  });
});
