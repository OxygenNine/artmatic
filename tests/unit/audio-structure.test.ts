import { describe, expect, it } from 'vitest';
import { createFeatureAccumulator, type FeatureTrack } from '../../src/audio/features';
import { buildMusicMap } from '../../src/audio/structure';

/**
 * 结构分析。判据针对的是「Agent 拿到这张地图会不会做错决定」，不是数值本身：
 *
 * 1. **边界落在小节线上**，且四段 A/B/A/B 的重复结构必须被认出来 —— 这是
 *    「副歌复用同一套视觉语法」的全部依据。
 * 2. **同和弦不同配器要分开**：EDM 的主歌与副歌常共用同一组和弦，只靠 chroma
 *    聚类会把它们并成一段，Agent 于是又回到「一段到底」。
 * 3. **移调后仍是同一段**：副歌升 key 在中国流行里很常见，靠音色聚类会判成新段。
 * 4. 确定性：同一份输入两次得到逐字节相同的 JSON（地图会被缓存、会被对比 diff）。
 */

const SR = 44100;
const BINS = 1025;
const FPS = 50;
const BPM = 120;
const BPB = 4;
/** 120 BPM / 4 拍 → 一小节 2 秒。 */
const BAR_SEC = (60 / BPM) * BPB;

/** ~43 Hz（sub 段）。 */
const SUB_BIN = 2;
/** ~6.5 kHz（high 段）。 */
const HIGH_BIN = 300;
/** C4 / E4 / G4 —— 三个 bin 都落在对应半音中心附近。 */
const C_MAJOR = [12, 15, 18];
/** D4 / F#4 / A4 —— C 大三和弦整体升两个半音。 */
const D_MAJOR = [14, 17, 20];

/**
 * 16 小节 = 4 段 × 4 小节：
 *   0-3   sub  + C  → A
 *   4-7   high + C  → B（同和弦、不同配器）
 *   8-11  sub  + D  → 应仍是 A（移调）
 *   12-15 high + D  → 应仍是 B
 */
function buildSong(withChroma = true): FeatureTrack {
  const bars = 16;
  const frames = Math.round(bars * BAR_SEC * FPS);
  const acc = createFeatureAccumulator({
    bins: BINS,
    hopSec: 1 / FPS,
    sampleRate: SR,
    frames,
    ...(withChroma ? { chroma: true } : {}),
  });
  const mag = new Float32Array(BINS);
  for (let i = 0; i < frames; i += 1) {
    const bar = Math.floor(i / FPS / BAR_SEC);
    const block = Math.floor(bar / 4);
    mag.fill(0);
    if (block === 0 || block === 2) mag[SUB_BIN] = 1;
    else mag[HIGH_BIN] = 1;
    for (const b of block < 2 ? C_MAJOR : D_MAJOR) mag[b] = 0.8;
    acc.push(mag, block === 1 || block === 3 ? 0.8 : 0.3);
  }
  return acc.finish();
}

const GRID = { bpm: BPM, offset: 0, beatsPerBar: BPB };

function mapOf(track: FeatureTrack, over: Partial<Parameters<typeof buildMusicMap>[0]> = {}) {
  return buildMusicMap({
    features: track,
    chroma: track.chroma ?? null,
    grid: GRID,
    timeOffset: 0,
    windowStart: 0,
    windowEnd: 16 * BAR_SEC,
    assetId: 'songA',
    ...over,
  });
}

describe('结构分析：小节网格', () => {
  const map = mapOf(buildSong());

  it('小节数与编号对齐 core/time.ts 的读数', () => {
    expect(map.bars.length).toBe(16);
    expect(map.bars[0]!.bar).toBe(1);
    expect(map.bars[15]!.bar).toBe(16);
    expect(map.barDur).toBeCloseTo(BAR_SEC, 6);
    expect(map.bars[4]!.start).toBeCloseTo(8, 6);
  });

  it('整轨时间被小节铺满，没有缝', () => {
    for (let i = 1; i < map.bars.length; i += 1) {
      const prev = map.bars[i - 1]!;
      expect(map.bars[i]!.start).toBeCloseTo(prev.start + prev.duration, 6);
    }
  });

  it('窗口切在小节中间时，首小节被截断但仍然覆盖到窗口起点', () => {
    const m = mapOf(buildSong(), { windowStart: 1, windowEnd: 8 * BAR_SEC });
    expect(m.bars[0]!.start).toBe(1);
    expect(m.bars[0]!.duration).toBeCloseTo(1, 6);
    expect(m.bars[m.bars.length - 1]!.bar).toBe(8);
  });
});

describe('结构分析：段落切分', () => {
  const map = mapOf(buildSong());

  it('四段，边界落在第 5 / 9 / 13 小节', () => {
    expect(map.sections.length).toBe(4);
    expect(map.sections.map((s) => s.startBar)).toEqual([1, 5, 9, 13]);
  });

  it('重复结构 A/B/A/B —— 移调不算新段，换配器才算', () => {
    expect(map.sections.map((s) => s.letter)).toEqual(['A', 'B', 'A', 'B']);
  });

  it('段落首尾相接，覆盖整个窗口', () => {
    expect(map.sections[0]!.start).toBe(0);
    for (let i = 1; i < map.sections.length; i += 1) {
      expect(map.sections[i]!.start).toBeCloseTo(map.sections[i - 1]!.end, 6);
    }
    expect(map.sections[map.sections.length - 1]!.end).toBeCloseTo(16 * BAR_SEC, 6);
  });

  it('能量随配器变化：高频段比低频段更「满」', () => {
    expect(map.sections[1]!.energy).toBeGreaterThan(map.sections[0]!.energy);
    expect(map.sections[0]!.dEnergy).toBe(0);
    expect(map.sections[1]!.dEnergy).toBeGreaterThan(0);
  });

  it('边界小节的 novelty 高于段内小节', () => {
    const boundary = map.bars[4]!.novelty;
    const inside = map.bars[6]!.novelty;
    expect(boundary).toBeGreaterThan(inside);
    // 判据线在 1/3；边界必须过线，段内必须远低于它
    expect(boundary).toBeGreaterThan(1 / 3);
  });

  it('id 稳定且可重现（同一素材、同一网格 → 同一批 id）', () => {
    const again = mapOf(buildSong());
    expect(again.sections.map((s) => s.id)).toEqual(map.sections.map((s) => s.id));
    expect(map.sections[0]!.id).toBe('auto:songA:1');
  });

  it('确定性：两次分析得到逐字节相同的 JSON', () => {
    expect(JSON.stringify(mapOf(buildSong()))).toBe(JSON.stringify(mapOf(buildSong())));
  });
});

describe('结构分析：没有 chroma 时退化为音色聚类', () => {
  const track = buildSong(false);

  it('chroma 缺席（长度 0 或 undefined）不影响边界', () => {
    expect(track.chroma).toBeUndefined();
    const map = mapOf(track);
    expect(map.sections.length).toBe(4);
    expect(map.bars[0]!.chroma.every((v) => v === 0)).toBe(true);
  });
});

describe('结构分析：退化输入', () => {
  it('窗口短于半小节 → 空地图，不抛错', () => {
    const m = mapOf(buildSong(), { windowStart: 0, windowEnd: 0.5 });
    expect(m.bars).toEqual([]);
    expect(m.sections).toEqual([]);
  });

  it('无帧的特征轨 → 空地图', () => {
    const empty = createFeatureAccumulator({
      bins: BINS,
      hopSec: 1 / FPS,
      sampleRate: SR,
      frames: 0,
    }).finish();
    const m = mapOf(empty);
    expect(m.sections).toEqual([]);
  });

  it('bpm 非法 → 空地图，不产生 NaN', () => {
    const m = mapOf(buildSong(), { grid: { bpm: 0, offset: 0, beatsPerBar: 4 } });
    expect(m.sections).toEqual([]);
    expect(Number.isFinite(m.barDur)).toBe(false);
  });
});
