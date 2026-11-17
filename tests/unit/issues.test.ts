import { describe, expect, it } from 'vitest';
import {
  DEFAULT_ISSUE_COLOR,
  ISSUE_MIN_SIZE,
  issueAt,
  issueCovers,
  issueRectOf,
  normalizeIssueRect,
  normalizeIssueSpan,
  sanitizeIssues,
  squareSize,
} from '../../src/core/issues';
import { createBlankProject } from '../../src/core/demo-project';
import { migrateProject, SCHEMA_VERSION, validateProject } from '../../src/core/schema';
import { ProjectStore } from '../../src/core/project-store';
import { buildSceneSnapshot } from '../../src/agent/scene';

/**
 * 批注标记（Issues）的三层：
 *  1. 纯函数（钳制 / 清洗 / 命中）—— 坏数据不能让工程打不开；
 *  2. store 写入 —— 一笔撤销、按时间排序；
 *  3. scene 快照 —— agent 读得到、读到的形状能原样写回。
 */

describe('normalizeIssueRect', () => {
  it('钳制尺寸下限，并把中心收进画面', () => {
    const r = normalizeIssueRect({ x: 2, y: -1, w: 0, h: 10 });
    expect(r.w).toBeGreaterThanOrEqual(ISSUE_MIN_SIZE);
    expect(r.h).toBe(1);
    // 中心不能越界：矩形必须整块落在 0..1 内
    expect(r.x).toBeLessThanOrEqual(1 - r.w / 2);
    expect(r.y).toBeGreaterThanOrEqual(r.h / 2);
  });

  it('缺省 / NaN 用默认值而不是让它穿透', () => {
    const r = normalizeIssueRect({ x: Number.NaN, y: undefined });
    expect(Number.isFinite(r.x)).toBe(true);
    expect(Number.isFinite(r.y)).toBe(true);
    expect(r.w).toBeGreaterThan(0);
  });

  it('正方形按画面宽高比折算', () => {
    const s = squareSize({ w: 1920, h: 1080 });
    expect(s.h / s.w).toBeCloseTo(1920 / 1080, 6);
    const rect = issueRectOf({ x: 0.5, y: 0.5, ...s });
    expect(rect.left).toBeCloseTo(0.475, 6);
  });
});

describe('sanitizeIssues', () => {
  it('坏条目逐条丢弃，颜色回落默认，按时间排序', () => {
    const out = sanitizeIssues([
      { id: 'b', time: 5, x: 0.5, y: 0.5 },
      null,
      { id: 'b', time: 1, x: 0.5, y: 0.5 }, // 重复 id
      { id: 'bad-time', time: 'no', x: 0.5, y: 0.5 },
      { id: 'a', time: 2, x: 2, y: -2, w: 0.2, h: 0.2, color: 'red', note: 'x' },
    ]);
    expect(out.map((i) => i.id)).toEqual(['a', 'b']);
    expect(out[0]!.color).toBe(DEFAULT_ISSUE_COLOR);
    expect(out[1]!.w).toBeGreaterThan(0);
  });

  it('缺字段（v22 工程）补成空数组', () => {
    const p = createBlankProject('old') as unknown as Record<string, unknown>;
    delete p.issues;
    p.schemaVersion = 22;
    const out = migrateProject(p);
    expect(out.schemaVersion).toBe(SCHEMA_VERSION);
    expect(out.issues).toEqual([]);
  });
});

describe('normalizeIssueSpan', () => {
  it('结尾至少比起点长一帧，并夹进工程时长', () => {
    const s = normalizeIssueSpan({ start: 1, end: 0 }, 30);
    expect(s.end - s.start).toBeCloseTo(1 / 30, 9);
    const clamped = normalizeIssueSpan({ start: 999, end: 1000 }, 30, 10);
    expect(clamped.start).toBe(10);
    expect(clamped.end).toBeCloseTo(10 + 1 / 30, 9);
  });

  it('只给起点时用一帧补齐', () => {
    const s = normalizeIssueSpan({ start: 2 }, 25);
    expect(s).toEqual({ start: 2, end: 2 + 1 / 25 });
  });
});

describe('issueCovers', () => {
  it('开区间：起点显示、结尾不显示', () => {
    const it = { start: 2, end: 3 };
    expect(issueCovers(it, 2)).toBe(true);
    expect(issueCovers(it, 2.99)).toBe(true);
    expect(issueCovers(it, 3)).toBe(false);
    expect(issueCovers(it, 1.9)).toBe(false);
  });
});

describe('issueAt', () => {
  it('命中中心矩形，未命中返回 null', () => {
    const list = sanitizeIssues([{ id: 'i', time: 0, x: 0.5, y: 0.5, w: 0.2, h: 0.2 }]);
    expect(issueAt(list, 0.5, 0.5)?.id).toBe('i');
    expect(issueAt(list, 0.9, 0.9)).toBeNull();
  });
});

describe('ProjectStore：批注写入', () => {
  function store(): ProjectStore {
    return new ProjectStore(createBlankProject('t'));
  }

  it('add 排序、update 改字段、remove / clear 各一笔撤销', () => {
    const s = store();
    const b = s.addIssue({ start: 6, x: 0.5, y: 0.5, note: '后半段' });
    const a = s.addIssue({ start: 2, x: 0.2, y: 0.2, note: '开头' });
    expect(s.project.issues.map((i) => i.id)).toEqual([a, b]);

    expect(s.updateIssue(b, { note: '改过' })).toBe(true);
    expect(s.project.issues.find((i) => i.id === b)?.note).toBe('改过');
    // 同值再写一次不算改动（不产生空撤销）
    expect(s.updateIssue(b, { note: '改过' })).toBe(false);
    // 改时间段：结尾跟着起点走，不会被拖成反向区间
    expect(s.updateIssue(b, { end: 7 })).toBe(true);
    expect(s.project.issues.find((i) => i.id === b)?.end).toBe(7);
    expect(s.updateIssue(b, { start: 10 })).toBe(true);
    expect(s.project.issues.find((i) => i.id === b)?.end).toBeGreaterThan(10);

    s.removeIssue(a);
    expect(s.project.issues.map((i) => i.id)).toEqual([b]);
    s.undo();
    expect(s.project.issues.map((i) => i.id)).toEqual([a, b]);

    expect(s.clearIssues()).toBe(2);
    expect(s.project.issues).toEqual([]);
    s.undo();
    expect(s.project.issues).toHaveLength(2);
  });

  it('拒绝不存在 id 的 update（返回 false，不写库）', () => {
    const s = store();
    expect(s.updateIssue('nope', { note: 'x' })).toBe(false);
  });
});

describe('scene 快照', () => {
  it('两份快照都带批注，并给像素矩形', () => {
    const s = new ProjectStore(createBlankProject('t'));
    s.addIssue({ start: 1, end: 1.5, x: 0.5, y: 0.5, w: 0.1, h: 0.1, note: '渲染有问题' });
    const full = buildSceneSnapshot(s.project, 0, 'full');
    const ids = buildSceneSnapshot(s.project, 0, 'ids');
    expect(full.issues).toHaveLength(1);
    expect(ids.issues[0]!.note).toBe('渲染有问题');
    expect(full.issues[0]!.rect.w).toBe(Math.round(0.1 * s.project.resolution.w));
    expect(full.issues[0]!.index).toBe(1);
    expect(full.issues[0]!.start).toBe(1);
    expect(full.issues[0]!.duration).toBeCloseTo(0.5, 9);
    expect(full.issues[0]!.frames).toBe(15);
  });

  it('validateProject 清掉手改 JSON 里的坏批注而不是拒绝打开', () => {
    const p = createBlankProject('t');
    (p as unknown as Record<string, unknown>).issues = [{ id: 'x', time: 'bad' }];
    const out = validateProject(structuredClone(p));
    expect(out.issues).toEqual([]);
  });
});
