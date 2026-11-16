import { describe, expect, it } from 'vitest';
import { layoutMusicMap, NOVELTY_THRESHOLD } from '../../src/agent/music-map-draw';
import type { BarRow, MusicMap, MusicSection } from '../../src/audio/structure';

/**
 * 音乐地图的**布局算术**。这一层能单测，绘制那一层不能（要 canvas）。
 *
 * 判据只挑「画出来会明显错」的几条：色带是否首尾相接铺满、泳道是否互不重叠、
 * 标签是否落在画布内、小节列是否等宽铺满。这些错了以后图还是能出来，
 * 只是读者（模型）会得出错误结论。
 */

function bar(index: number, barNo: number, start: number, dur = 2): BarRow {
  return {
    index,
    bar: barNo,
    start,
    duration: dur,
    rms: 0.5,
    flux: 0.1,
    centroid: 0.4,
    flat: 0.2,
    onsetDensity: 4,
    band: { sub: 0.2, bass: 0.2, mid: 0.2, high: 0.2, air: 0.2 },
    energy: 1.5,
    novelty: 0.1,
    chroma: new Array(12).fill(0),
    silent: false,
  };
}

function section(index: number, letter: string, start: number, end: number, cluster = 0): MusicSection {
  return {
    index,
    id: `auto:a:${index}`,
    letter,
    start,
    end,
    startBar: index * 4 + 1,
    bars: 4,
    energy: 1.5,
    dEnergy: 0,
    rms: 0.5,
    onsetDensity: 4,
    band: { sub: 0.2, bass: 0.2, mid: 0.2, high: 0.2, air: 0.2 },
    brightness: 0.4,
    noisiness: 0.2,
    novelty: 0.1,
    roleHint: 'section',
    roleConfidence: 0,
    cluster,
  };
}

function map(bars: number, sections: MusicSection[]): MusicMap {
  const rows: BarRow[] = [];
  for (let i = 0; i < bars; i += 1) rows.push(bar(i, i + 1, i * 2));
  return {
    version: 1,
    windowStart: 0,
    windowEnd: bars * 2,
    bpm: 120,
    offset: 0,
    beatsPerBar: 4,
    barDur: 2,
    bars: rows,
    sections,
    drops: [],
    noveltyPeak: 2,
  };
}

describe('布局：段落色带', () => {
  it('首尾相接铺满绘图区（没有缝，也没有重叠）', () => {
    const m = map(16, [section(0, 'A', 0, 16), section(1, 'B', 16, 32)]);
    const l = layoutMusicMap(m, { w: 1600, h: 520 });
    expect(l.sections[0]!.x).toBeCloseTo(l.x0, 6);
    expect(l.sections[0]!.x + l.sections[0]!.w).toBeCloseTo(l.sections[1]!.x, 6);
    expect(l.sections[1]!.x + l.sections[1]!.w).toBeCloseTo(l.x1, 6);
  });

  it('极窄的段落至少给 1px（否则它整段消失）', () => {
    const m = map(16, [section(0, 'A', 0, 30), section(1, 'B', 30, 32)]);
    const l = layoutMusicMap(m, { w: 640, h: 360 });
    expect(l.sections[1]!.w).toBeGreaterThanOrEqual(1);
  });
});

describe('布局：泳道', () => {
  it('四条泳道自上而下、互不重叠、都在画布内', () => {
    const l = layoutMusicMap(map(16, [section(0, 'A', 0, 32)]), { w: 1600, h: 520 });
    const lanes = [l.lanes.rms, l.lanes.bands, l.lanes.onset, l.lanes.novelty];
    for (const lane of lanes) {
      expect(lane.y).toBeGreaterThanOrEqual(0);
      expect(lane.y + lane.h).toBeLessThanOrEqual(l.h);
      expect(lane.x).toBe(l.x0);
      expect(lane.x + lane.w).toBe(l.x1);
    }
    for (let i = 1; i < lanes.length; i += 1) {
      expect(lanes[i]!.y).toBeGreaterThanOrEqual(lanes[i - 1]!.y + lanes[i - 1]!.h - 1e-6);
    }
  });

  it('色带、标尺、泳道按纵向顺序排开，不互相压', () => {
    const l = layoutMusicMap(map(16, [section(0, 'A', 0, 32)]), { w: 1600, h: 520 });
    expect(l.ribbon.y + l.ribbon.h).toBeLessThanOrEqual(l.ruler.y + 1e-6);
    expect(l.ruler.y + l.ruler.h).toBeLessThanOrEqual(l.lanes.rms.y + 1e-6);
  });

  it('判据线落在 novelty 泳道内，且与常量一致', () => {
    const l = layoutMusicMap(map(16, [section(0, 'A', 0, 32)]), { w: 1600, h: 520 });
    const lane = l.lanes.novelty;
    expect(l.noveltyThresholdY).toBeGreaterThan(lane.y);
    expect(l.noveltyThresholdY).toBeLessThan(lane.y + lane.h);
    const expected = lane.y + lane.h * (1 - NOVELTY_THRESHOLD);
    expect(l.noveltyThresholdY).toBeCloseTo(expected, 6);
  });
});

describe('布局：小节列', () => {
  it('每小节一列，等宽且铺满', () => {
    const m = map(16, [section(0, 'A', 0, 32)]);
    const l = layoutMusicMap(m, { w: 1600, h: 520 });
    expect(l.barX.length).toBe(16);
    expect(l.barW.length).toBe(16);
    expect(l.barX[0]).toBeCloseTo(l.x0, 6);
    expect(l.barX[15]! + l.barW[15]!).toBeCloseTo(l.x1, 6);
    for (let i = 1; i < 16; i += 1) {
      expect(l.barX[i]!).toBeCloseTo(l.barX[i - 1]! + l.barW[i - 1]!, 6);
    }
  });

  it('首小节被截断时按真实时长分宽度（不是按序号等分）', () => {
    const m = map(16, [section(0, 'A', 0, 32)]);
    m.bars[0] = bar(0, 1, 0, 1); // 只有半小节
    const l = layoutMusicMap(m, { w: 1600, h: 520 });
    expect(l.barW[0]!).toBeCloseTo(l.barW[1]! / 2, 6);
  });

  it('没有小节时不给 NaN（空地图也要能布局）', () => {
    const m: MusicMap = { ...map(1, []), bars: [], windowStart: 0, windowEnd: 0 };
    const l = layoutMusicMap(m, { w: 800, h: 400 });
    expect(l.barX).toEqual([]);
    expect(Number.isFinite(l.x1)).toBe(true);
  });
});

describe('布局：播放头与尺寸', () => {
  it('播放头按时间线性映射', () => {
    const m = map(16, [section(0, 'A', 0, 32)]);
    const l = layoutMusicMap(m, { w: 1600, h: 520, t: 16 });
    const mid = (l.x0 + l.x1) / 2;
    expect(l.playheadX).toBeCloseTo(mid, 6);
  });

  it('没有播放头时是 null', () => {
    expect(layoutMusicMap(map(4, []), { w: 800, h: 400 }).playheadX).toBeNull();
  });

  it('过小的尺寸被夹到可用下限（标签不会全叠在一起）', () => {
    const l = layoutMusicMap(map(4, [section(0, 'A', 0, 8)]), { w: 10, h: 10 });
    expect(l.w).toBeGreaterThanOrEqual(320);
    expect(l.h).toBeGreaterThanOrEqual(240);
  });
});
