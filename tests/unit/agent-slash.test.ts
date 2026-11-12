import { describe, expect, it } from 'vitest';
import {
  filterSlash,
  removeSlashToken,
  slashItems,
  slashToken,
  type SlashItem,
} from '../../src/ui/agent/slash';
import { SKILLS, renderAttachedSkills } from '../../src/agent/skills/registry';

/**
 * 输入框里的斜杠菜单 + 「用户点名技能」的注入文本。
 *
 * 两条判据：菜单**不误解正文**（URL、分数、路径里的斜杠），以及菜单里的
 * 每个技能都能真的变成一段提示词 —— 前者是弹不弹的问题，后者是弹了有没有用。
 */

describe('slashToken', () => {
  it('词首的 / 才认', () => {
    expect(slashToken('/', 1)).toEqual({ query: '', start: 0, end: 1 });
    expect(slashToken('/be', 3)).toEqual({ query: 'be', start: 0, end: 3 });
    expect(slashToken('帮我 /be', 6)).toEqual({ query: 'be', start: 3, end: 6 });
  });

  it('正文里的斜杠不弹菜单', () => {
    expect(slashToken('a/b', 3)).toBeNull();
    expect(slashToken('https://example.com', 19)).toBeNull();
    expect(slashToken('3/4 拍', 3)).toBeNull();
  });

  it('词里一出现空白就让位（那已经在说需求了）', () => {
    expect(slashToken('/compact 帮我压缩', 15)).toBeNull();
    // 光标停在词尾时仍然有效：后面的话不吃掉
    expect(slashToken('/compact 帮我压缩', 8)).toEqual({ query: 'compact', start: 0, end: 8 });
  });

  it('光标在词中间时按光标切，不按整行', () => {
    // `/be|at-sync` 这种位置：查询是 `be`，词尾到 `at-sync` 结束
    expect(slashToken('/beat-sync', 3)).toEqual({ query: 'be', start: 0, end: 10 });
  });
});

describe('removeSlashToken', () => {
  it('整条只有命令时清空，并去掉残留的空白', () => {
    expect(removeSlashToken('/compact', { query: 'compact', start: 0, end: 8 })).toEqual({ text: '', caret: 0 });
    expect(removeSlashToken('/compact  ', { query: 'compact', start: 0, end: 10 })).toEqual({ text: '', caret: 0 });
  });

  it('只摘掉那个词，其余文字原样保留', () => {
    // 词在开头：后面的前导空格一起去掉
    expect(removeSlashToken('/beat 帮我卡点', { query: 'beat', start: 0, end: 5 })).toEqual({
      text: '帮我卡点',
      caret: 0,
    });
    // 词在中间：前后都不动，光标落回词首
    expect(removeSlashToken('帮我 /beat 卡点', { query: 'beat', start: 3, end: 8 })).toEqual({
      text: '帮我  卡点',
      caret: 3,
    });
  });
});

describe('filterSlash', () => {
  const items = slashItems();

  it('空查询给出全表，命令在前', () => {
    expect(filterSlash(items, '')).toEqual(items);
    expect(items[0]?.kind).toBe('command');
  });

  it('前缀优先于包含，包含优先于描述命中', () => {
    const r = filterSlash(items, 'be').map((i) => i.id);
    expect(r[0]).toBe('beat-sync-edit');
  });

  it('中文查询能命中描述（技能描述里写了 卡点 / 海报）', () => {
    expect(filterSlash(items, '卡点').map((i) => i.id)).toContain('beat-sync-edit');
    expect(filterSlash(items, '海报').map((i) => i.id)).toContain('poster-layout');
  });

  it('命令的显示名参与匹配（/压缩 要能找到 /compact）', () => {
    const labelOf = (i: SlashItem): string => (i.kind === 'command' ? '压缩上下文' : '');
    expect(filterSlash(items, '压缩', labelOf).map((i) => i.id)).toEqual(['compact']);
  });

  it('没有命中时返回空数组（调用方据此关掉菜单）', () => {
    expect(filterSlash(items, 'zzzz')).toEqual([]);
  });

  it('每一份内置技能都在菜单里（新加技能不能变成「只能靠模型自己读」）', () => {
    const ids = new Set(items.filter((i) => i.kind === 'skill').map((i) => i.id));
    expect([...SKILLS.map((s) => s.name)].filter((n) => !ids.has(n))).toEqual([]);
  });
});

describe('renderAttachedSkills', () => {
  it('正文进提示词，并说明不必再调 read_skill', () => {
    const text = renderAttachedSkills(['beat-sync-edit']);
    expect(text).toContain('Skills the user attached to this message');
    expect(text).toContain('## beat-sync-edit');
    expect(text).toContain('No need to call read_skill');
    // 正文本身在里面（抽一行只有正文才有的句子）
    expect(text).toContain('Rhythm is arithmetic, not taste');
  });

  it('带上 references 的读法，名字缺一不可', () => {
    expect(renderAttachedSkills(['beat-sync-edit'])).toContain("file: 'beat-tables.md'");
  });

  it('多份按给定顺序拼接；未知名字跳过；空输入给空串', () => {
    const text = renderAttachedSkills(['poster-layout', 'no-such-skill', 'frame-diagnosis']);
    expect(text.indexOf('## poster-layout')).toBeLessThan(text.indexOf('## frame-diagnosis'));
    expect(text).not.toContain('no-such-skill');
    expect(renderAttachedSkills([])).toBe('');
  });

  it('重复点名只算一次', () => {
    const text = renderAttachedSkills(['poster-layout', 'poster-layout']);
    expect(text.match(/## poster-layout/g)).toHaveLength(1);
  });
});
