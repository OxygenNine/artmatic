import { describe, expect, it } from 'vitest';
import { ProjectStore } from '../../src/core/project-store';
import { createBlankProject } from '../../src/core/demo-project';
import { sanitizeSections } from '../../src/core/sections';
import { SCHEMA_VERSION, type Section } from '../../src/core/schema';

/**
 * 自动段落的安全规则。判据全部围绕一句话：**自动写入不许毁掉用户手标的东西**。
 *
 * 1. 只替换 `source === 'auto'` 的段落。
 * 2. 用户动过（移动 / 改名 / 切分）就摘掉标记，从此不再被覆盖。
 * 3. 重跑同一份分析是幂等的（id 由 `auto:<assetId>:<startBar>` 决定）。
 * 4. 内容没变时不产生撤销记录 —— 否则「播放头没动就重跑分析」会留一堆空撤销。
 */

function store(): ProjectStore {
  return new ProjectStore(createBlankProject('t'));
}

function auto(id: string, start: number, name = id): Section {
  return { id, name, start, source: 'auto' };
}

function manual(id: string, start: number, name = id): Section {
  return { id, name, start };
}

describe('Section.source：清洗', () => {
  it('只认 auto 字面量，其它值当作手标丢掉标记', () => {
    const out = sanitizeSections([
      { id: 'a', name: 'a', start: 0, source: 'auto' },
      { id: 'b', name: 'b', start: 1, source: 'user' },
      { id: 'c', name: 'c', start: 2 },
    ]);
    expect(out.find((s) => s.id === 'a')!.source).toBe('auto');
    expect(out.find((s) => s.id === 'b')!.source).toBeUndefined();
    expect(out.find((s) => s.id === 'c')!.source).toBeUndefined();
  });

  it('缺省（无标记）等于手标，且不因为清洗而丢掉段落本身', () => {
    const out = sanitizeSections([{ id: 'c', name: 'c', start: 2 }]);
    expect(out).toHaveLength(1);
    expect(out[0]!.source).toBeUndefined();
  });
});

describe('replaceAutoSections', () => {
  it('首次写入全部是新增', () => {
    const s = store();
    const r = s.replaceAutoSections([auto('auto:a:1', 0), auto('auto:a:9', 16)]);
    expect(r).toEqual({ added: 2, replaced: 0, removed: 0, kept: 0 });
    expect(s.project.sections.map((x) => x.start)).toEqual([0, 16]);
  });

  it('重跑同一份分析是幂等的（不重复、不产生撤销）', () => {
    const s = store();
    const sections = [auto('auto:a:1', 0), auto('auto:a:9', 16)];
    s.replaceAutoSections(sections);
    const before = s.project.sections.length;
    const r = s.replaceAutoSections(sections);
    expect(r).toEqual({ added: 0, replaced: 0, removed: 0, kept: 0 });
    expect(s.project.sections.length).toBe(before);
  });

  it('手标段落永不删除，也不被搬走', () => {
    const s = store();
    s.addSection(20, '我的段落'); // 手标
    s.replaceAutoSections([auto('auto:a:1', 0), auto('auto:a:9', 16)]);
    const names = s.project.sections.map((x) => x.name);
    expect(names).toContain('我的段落');
    expect(s.project.sections.length).toBe(3);
  });

  it('段落分段变了：只替换 auto 的那些', () => {
    const s = store();
    s.replaceAutoSections([auto('auto:a:1', 0), auto('auto:a:9', 16)]);
    s.addSection(40, '手标');
    // 新分析给出三条不同的边界
    const r = s.replaceAutoSections([
      auto('auto:a:1', 0),
      auto('auto:a:5', 8),
      auto('auto:a:13', 24),
    ]);
    expect(r.added).toBe(2);
    expect(r.replaced).toBe(1);
    expect(r.removed).toBe(1);
    expect(r.kept).toBe(1);
    expect(s.project.sections.map((x) => x.start)).toEqual([0, 8, 24, 40]);
  });

  it('写入的段落恒带 source:auto，且按 start 排序', () => {
    const s = store();
    s.replaceAutoSections([auto('auto:a:9', 16), auto('auto:a:1', 0)]);
    expect(s.project.sections.every((x) => x.source === 'auto')).toBe(true);
    expect(s.project.sections.map((x) => x.start)).toEqual([0, 16]);
  });

  it('负起点被丢弃（不给时间轴塞进看不见的段落）', () => {
    const s = store();
    s.replaceAutoSections([auto('auto:a:-1', -4), auto('auto:a:1', 0)]);
    expect(s.project.sections.map((x) => x.start)).toEqual([0]);
  });

  it('与手标段落同秒的自动边界被丢掉（不在同一个 x 上叠两个标记）', () => {
    const s = store();
    s.addSection(8, '手标');
    const r = s.replaceAutoSections([auto('auto:a:1', 0), auto('auto:a:5', 8), auto('auto:a:9', 14)]);
    expect(r.added).toBe(2);
    expect(r.kept).toBe(1);
    expect(s.project.sections.map((x) => x.start)).toEqual([0, 8, 14]);
    expect(s.project.sections.filter((x) => x.source === 'auto')).toHaveLength(2);
  });
});

describe('用户一改就转正', () => {
  function seeded(): { s: ProjectStore; id: string } {
    const s = store();
    // 空白工程的时长是 16 秒，段落必须落在里面才切得动。
    s.replaceAutoSections([auto('auto:a:1', 0), auto('auto:a:9', 8)]);
    return { s, id: 'auto:a:9' };
  }

  it('移动之后 source 消失，下次分析不再覆盖', () => {
    const { s, id } = seeded();
    s.moveSection(id, 18);
    const moved = s.project.sections.find((x) => x.id === id)!;
    expect(moved.source).toBeUndefined();
    s.replaceAutoSections([auto('auto:a:1', 0)]);
    expect(s.project.sections.find((x) => x.id === id)).toBeDefined();
  });

  it('改名之后 source 消失', () => {
    const { s, id } = seeded();
    s.renameSection(id, '副歌');
    const renamed = s.project.sections.find((x) => x.id === id)!;
    expect(renamed.source).toBeUndefined();
    expect(renamed.name).toBe('副歌');
    s.replaceAutoSections([auto('auto:a:1', 0)]);
    expect(s.project.sections.find((x) => x.id === id)).toBeDefined();
  });

  it('切分之后被切的那一段也转正', () => {
    const { s, id } = seeded();
    const created = s.splitSection(id, 12);
    expect(created).not.toBeNull();
    expect(s.project.sections.find((x) => x.id === id)!.source).toBeUndefined();
  });

  it('拖动中的实时移动同样转正', () => {
    const { s, id } = seeded();
    s.liveMoveSection(id, 17);
    expect(s.project.sections.find((x) => x.id === id)!.source).toBeUndefined();
  });
});

describe('get_scene 暴露 source', () => {
  it('手标段落不带 source，自动段落带 source:auto', () => {
    const s = store();
    s.addSection(0, 'intro');
    s.replaceAutoSections([auto('auto:a:9', 16)]);
    // 场景快照的映射在 scene.ts；这里只验数据层已经能区分两者。
    expect(s.project.sections.map((x) => x.source ?? 'manual')).toEqual(['manual', 'auto']);
  });
});
