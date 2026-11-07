import { describe, expect, it } from 'vitest';
import { METRONOME_MARK_MERGE_SEC, metronomeClicks } from '../../src/audio/metronome';
import type { BeatGrid } from '../../src/core/time';

const GRID: BeatGrid = { bpm: 120, offset: 0, beatsPerBar: 4 };

describe('metronomeClicks：窗口内的拍与节奏点', () => {
  it('按 BPM / offset 排拍，左开右闭', () => {
    // 120 BPM → 0.5 s 一拍。from=0 的那一拍不重复，to=2 的那一拍要响。
    const out = metronomeClicks(0, 2, GRID, []);
    expect(out.map((c) => c.t)).toEqual([0.5, 1, 1.5, 2]);
    expect(out.every((c) => c.kind === 'beat')).toBe(true);
  });

  it('offset 平移整条网格；offset < 0 时负拍不响', () => {
    expect(metronomeClicks(0, 1.2, { ...GRID, offset: 0.1 }, []).map((c) => c.t)).toEqual([
      0.1, 0.6, 1.1,
    ]);
    // offset=-1 → 拍在 -1, -0.5, 0, 0.5 …，只有 ≥ 0 的响。
    expect(metronomeClicks(-0.1, 1, { ...GRID, offset: -1 }, []).map((c) => c.t)).toEqual([
      0, 0.5, 1,
    ]);
  });

  it('手动节奏点按升序插入，窗口边界同样左开右闭', () => {
    const out = metronomeClicks(0.25, 1.2, GRID, [0.25, 0.8, 1.2, 2]);
    expect(out).toEqual([
      { t: 0.5, kind: 'beat' },
      { t: 0.8, kind: 'mark' },
      { t: 1, kind: 'beat' },
      { t: 1.2, kind: 'mark' },
    ]);
  });

  it('拍与节奏点撞车（<20 ms）时只留节奏点的音', () => {
    const out = metronomeClicks(0, 1.1, GRID, [1.01]);
    expect(out).toEqual([
      { t: 0.5, kind: 'beat' },
      { t: 1, kind: 'mark' },
    ]);
    expect(METRONOME_MARK_MERGE_SEC).toBe(0.02);
  });

  it('相距超过合并窗口时两个都响', () => {
    const out = metronomeClicks(0.9, 1.1, GRID, [1.04]);
    expect(out.map((c) => [c.t, c.kind])).toEqual([
      [1, 'beat'],
      [1.04, 'mark'],
    ]);
  });

  it('BPM 非法 / 空窗口 → 空数组', () => {
    expect(metronomeClicks(0, 1, { ...GRID, bpm: 0 }, [0.5])).toEqual([]);
    expect(metronomeClicks(0, 1, { ...GRID, bpm: Number.NaN }, [0.5])).toEqual([]);
    expect(metronomeClicks(1, 1, GRID, [1])).toEqual([]);
  });
});
