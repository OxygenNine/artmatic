import { describe, expect, it } from 'vitest';
import {
  MAX_BEAT_MARKS,
  insertBeatMark,
  mergeRecordedMarks,
  moveBeatMark,
  removeBeatMark,
  sanitizeBeatMarks,
} from '../../src/core/beat-marks';
import { snapTimeWithSections } from '../../src/core/sections';
import { defaultProject, migrateProject, SCHEMA_VERSION } from '../../src/core/schema';
import { ProjectStore } from '../../src/core/project-store';
import type { BeatGrid } from '../../src/core/time';

const GRID: BeatGrid = { bpm: 120, offset: 0, beatsPerBar: 4 };

describe('sanitizeBeatMarks：永不抛，坏值逐条丢弃', () => {
  it('排序、去重、拒绝非有限 / 负数 / 坏类型', () => {
    const out = sanitizeBeatMarks([
      3,
      1,
      '2.5',
      Number.NaN,
      Number.POSITIVE_INFINITY,
      -1,
      null,
      {},
      [1],
      1.0004, // 量化后也是 1 s → 与 1 重复，丢掉
    ]);
    expect(out).toEqual([1, 2.5, 3]);
  });

  it('量化到 1 ms：音频时钟的浮点尾巴不会落库', () => {
    expect(sanitizeBeatMarks([12.345670000000001, 0.0004])).toEqual([0, 12.346]);
  });

  it('不是数组 → 空数组（老工程 / 手改 JSON）', () => {
    expect(sanitizeBeatMarks(undefined)).toEqual([]);
    expect(sanitizeBeatMarks({ 0: 1 })).toEqual([]);
  });

  it('有上限，防止病态数据把工程撑爆', () => {
    const raw = Array.from({ length: MAX_BEAT_MARKS + 10 }, (_, i) => i * 0.01);
    const out = sanitizeBeatMarks(raw);
    expect(out.length).toBe(MAX_BEAT_MARKS);
    expect(out[0]).toBe(0);
  });
});

describe('编辑原语', () => {
  it('insertBeatMark 在去抖窗口内不新增', () => {
    expect(insertBeatMark([1], 1.01)).toEqual([1]);
    expect(insertBeatMark([1], 1.2)).toEqual([1, 1.2]);
  });

  it('removeBeatMark 越界时原样返回（快捷键不该抛错）', () => {
    expect(removeBeatMark([1, 2], 5)).toEqual([1, 2]);
    expect(removeBeatMark([1, 2], 0)).toEqual([2]);
  });

  it('moveBeatMark 钳到 ≥ 0 并重新排序', () => {
    expect(moveBeatMark([1, 2, 3], 0, 2.5)).toEqual([2, 2.5, 3]);
    expect(moveBeatMark([1, 2], 1, -5)).toEqual([0, 1]);
  });

  it('mergeRecordedMarks 合并后仍升序去重', () => {
    expect(mergeRecordedMarks([0.5], [3, 4], [2, 1.2])).toEqual([0.5, 1.2, 2, 3, 4]);
  });
});

describe('snapTimeWithSections + beatMarks', () => {
  it('比网格线更近的节奏点赢（不需要正好落在拍上）', () => {
    // 拍档：步长 1 拍 = 0.5 s。t=1.48 离网格 1.5 差 0.02，离节奏点 1.4 差 0.08
    // → 网格赢；换成 1.42 则节奏点赢。
    expect(snapTimeWithSections(1.48, 'beat', GRID, [], 30, [1.4])).toBe(1.5);
    expect(snapTimeWithSections(1.42, 'beat', GRID, [], 30, [1.4])).toBe(1.4);
  });

  it('节奏点的吸附容差有 100 ms 上限：bar 档下不会盖满整条轴', () => {
    // bar 档的容差是 1 s（步长 2 s），但节奏点只认 0.1 s。t=1.3 离网格 2.0
    // 差 0.7，离点 1.19 差 0.11 → 网格赢；点 1.21 差 0.09 → 点赢。
    expect(snapTimeWithSections(1.3, 'bar', GRID, [], 30, [1.19])).toBe(2);
    expect(snapTimeWithSections(1.3, 'bar', GRID, [], 30, [1.21])).toBe(1.21);
  });

  it('节奏点与段落起点按距离竞争，段落同距离时优先', () => {
    const sections = [{ id: 's', name: 's', start: 1.45 }];
    expect(snapTimeWithSections(1.44, 'beat', GRID, sections, 30, [1.4])).toBe(1.45);
  });

  it('没有节奏点时行为不变（旧调用点传不传第六个参数都一样）', () => {
    expect(snapTimeWithSections(1.42, 'beat', GRID, [])).toBe(
      snapTimeWithSections(1.42, 'beat', GRID, [], 30, []),
    );
  });
});

describe('schema v21 与 store 写入', () => {
  it('v20 工程迁移后 beatMarks 补成空数组', () => {
    const raw = { ...defaultProject(), schemaVersion: 20 } as Record<string, unknown>;
    delete raw.beatMarks;
    const out = migrateProject(raw);
    expect(out.schemaVersion).toBe(SCHEMA_VERSION);
    expect(out.beatMarks).toEqual([]);
  });

  it('validateProject 清洗坏节奏点，工程仍然打得开', () => {
    const p = defaultProject();
    (p as { beatMarks: unknown }).beatMarks = [2, -1, Number.NaN, '1.5', null];
    const out = migrateProject(p as unknown as Record<string, unknown>);
    expect(out.beatMarks).toEqual([1.5, 2]);
  });

  it('setBeatMarks 一笔撤销，且无变化时不 bump version', () => {
    const store = new ProjectStore(defaultProject());
    const v0 = store.version;
    store.setBeatMarks([2, 1]);
    expect(store.project.beatMarks).toEqual([1, 2]);
    expect(store.version).toBe(v0 + 1);

    const v1 = store.version;
    store.setBeatMarks([1, 2]);
    expect(store.version).toBe(v1);

    store.undo();
    expect(store.project.beatMarks).toEqual([]);
  });
});
