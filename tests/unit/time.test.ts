import { describe, expect, it } from 'vitest';
import {
  KEY_SNAP_UNITS,
  beatAtTime,
  beatDur,
  frameAtTime,
  magnetToleranceSec,
  snapBeat,
  snapKeyTime,
  snapStepBeats,
  snapToleranceSec,
  snapTime,
  timeAtBeat,
  timeAtFrame,
  type BeatGrid,
} from '../../src/core/time';

const grid: BeatGrid = { bpm: 120, offset: 1.5, beatsPerBar: 4 };

describe('拍网格换算（ADR-002：offset 是独立参数）', () => {
  it('timeAtBeat / beatAtTime 互逆', () => {
    expect(beatDur(grid)).toBeCloseTo(0.5);
    for (const b of [0, 1, 4, 7.25, 32]) {
      expect(beatAtTime(timeAtBeat(b, grid), grid)).toBeCloseTo(b, 10);
    }
  });

  it('offset 被尊重：第 0 拍在 offset 秒', () => {
    expect(timeAtBeat(0, grid)).toBeCloseTo(1.5);
    expect(timeAtBeat(4, grid)).toBeCloseTo(3.5);
    expect(beatAtTime(1.5, grid)).toBeCloseTo(0);
  });

  it('负拍（音乐还没开始）也能换算', () => {
    expect(timeAtBeat(-4, grid)).toBeCloseTo(-0.5);
    expect(beatAtTime(-0.5, grid)).toBeCloseTo(-4);
  });
});

describe('吸附（唯一一张 SNAP_MODES 表）', () => {
  it('四档步长：小节 / 拍 / 半拍 / 自由', () => {
    expect(snapStepBeats('bar', 4)).toBe(4);
    expect(snapStepBeats('beat', 4)).toBe(1);
    expect(snapStepBeats('half', 4)).toBe(0.5);
    expect(snapStepBeats('free', 4)).toBe(0.01);
  });

  it('snapBeat 对齐到步长', () => {
    expect(snapBeat(3.3, 'bar', 4)).toBe(4);
    expect(snapBeat(3.3, 'beat', 4)).toBe(3);
    expect(snapBeat(3.3, 'half', 4)).toBe(3.5);
    expect(snapBeat(3.337, 'free', 4)).toBeCloseTo(3.34);
  });

  it('snapTime 与 snapBeat 一致（网格与吸附同源，防 splitter 双表债）', () => {
    const t = 4.26;
    for (const mode of ['bar', 'beat', 'half', 'free'] as const) {
      expect(snapTime(t, mode, grid)).toBeCloseTo(
        timeAtBeat(snapBeat(beatAtTime(t, grid), mode, grid.beatsPerBar), grid),
        10,
      );
    }
  });

  it('帧吸附：步长是 1/fps 秒，与 BPM 无关（标准模式）', () => {
    // 0.51s @ 30fps → 第 15 帧（0.5s）；@ 25fps → 第 13 帧（0.52s）。
    expect(snapTime(0.51, 'frame', grid, 30)).toBeCloseTo(0.5, 10);
    expect(snapTime(0.51, 'frame', grid, 25)).toBeCloseTo(13 / 25, 10);
    // 改拍网格不该挪动帧吸附
    expect(snapTime(0.51, 'frame', { ...grid, bpm: 90, offset: 1.5 }, 30)).toBeCloseTo(0.5, 10);
  });

  it('吸附容差 = 半个步长（段落吸附与网格吸附同源）', () => {
    expect(snapToleranceSec('bar', grid)).toBeCloseTo(1, 10); // 4 拍 × 0.5s / 2
    expect(snapToleranceSec('beat', grid)).toBeCloseTo(0.25, 10);
    expect(snapToleranceSec('frame', grid, 30)).toBeCloseTo(1 / 60, 10);
  });

  it('磁吸：不吸网格，原样返回（候选点由 sections.ts 补齐）', () => {
    // 2.01 在 bar 档会落回 2；磁吸没有网格，原样。
    expect(snapTime(2.01, 'magnet', grid)).toBe(2.01);
    expect(snapTime(3.3, 'magnet', grid)).toBe(3.3);
  });

  it('磁吸容差按屏幕像素换算（与缩放无关），拿不到缩放时退回 1/4 拍', () => {
    // 10px @ 100px/s = 0.1s；@ 400px/s = 0.025s。
    expect(magnetToleranceSec(grid, 100)).toBeCloseTo(0.1, 10);
    expect(magnetToleranceSec(grid, 400)).toBeCloseTo(0.025, 10);
    expect(magnetToleranceSec(grid)).toBeCloseTo(beatDur(grid) / 4, 10);
    expect(snapToleranceSec('magnet', grid)).toBeCloseTo(beatDur(grid) / 4, 10);
  });
});

describe('关键帧吸附单位（与时间轴网格吸附分表）', () => {
  it('四档都在表里，且各自带标签键', () => {
    expect(Object.keys(KEY_SNAP_UNITS).sort()).toEqual(['beat', 'frame', 'sec', 'tenth']);
    for (const u of Object.values(KEY_SNAP_UNITS)) {
      expect(u.labelKey).toMatch(/^typo\.kfSnap/);
      expect(u.hintKey).toMatch(/^typo\.kfSnapTo/);
    }
  });

  it('拍 = 吸到拍网格（offset 被尊重）', () => {
    // offset = 1.5s、120BPM ⇒ 0.5s 一拍：第 0 拍在 1.5s、第 2 拍在 2.5s。
    expect(snapKeyTime(1.7, 'beat', grid)).toBeCloseTo(1.5, 10);
    expect(snapKeyTime(2.3, 'beat', grid)).toBeCloseTo(2.5, 10);
  });

  it('秒 / 0.1 秒：与 BPM 无关', () => {
    expect(snapKeyTime(2.26, 'sec', grid)).toBe(2);
    expect(snapKeyTime(2.74, 'sec', grid)).toBe(3);
    expect(snapKeyTime(2.26, 'tenth', grid)).toBeCloseTo(2.3, 10);
    expect(snapKeyTime(2.74, 'tenth', grid)).toBeCloseTo(2.7, 10);
  });

  it('帧：步长 1/fps，与拍网格无关', () => {
    // 0.51s @ 30fps → 第 15 帧（0.5s）；@ 25fps → 第 13 帧（0.52s）。
    expect(snapKeyTime(0.51, 'frame', grid, 30)).toBeCloseTo(0.5, 10);
    expect(snapKeyTime(0.51, 'frame', { ...grid, bpm: 90 }, 25)).toBeCloseTo(13 / 25, 10);
  });

  it('吸附结果落在刻度上（幂等）', () => {
    for (const unit of ['beat', 'sec', 'tenth', 'frame'] as const) {
      const once = snapKeyTime(3.317, unit, grid, 30);
      expect(snapKeyTime(once, unit, grid, 30)).toBeCloseTo(once, 10);
    }
  });
});

describe('帧换算', () => {
  it('timeAtFrame / frameAtTime', () => {
    expect(timeAtFrame(30, 30)).toBe(1);
    expect(frameAtTime(1, 30)).toBe(30);
    expect(frameAtTime(0.999, 30)).toBe(29);
  });
});
