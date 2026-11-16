import { beforeEach, describe, expect, it } from 'vitest';
import { createControlPlane, type AgentControlPlane } from '../../src/agent/control-plane';
import type { ControlContext, ControlResult, AnalyzeMusicView } from '../../src/agent/types';
import { ProjectStore } from '../../src/core/project-store';
import { createBlankProject } from '../../src/core/demo-project';
import type { Project } from '../../src/core/schema';
import { clearAnalyses } from '../../src/audio/analysis';
import { clearMusicMaps } from '../../src/audio/music-store';

/**
 * `analyze_music` 的控制平面行为。渲染成图那一步在 Node 里跑不了（要 canvas），
 * 由 `music-map-layout.test.ts` 守布局、由人工看图守可读性。
 *
 * 判据是「agent 会不会因此做错决定」：
 * 1. 段落真的写进了工程，且带 `source:'auto'`。
 * 2. 重跑是幂等的（不给用户堆重复段落、不留空撤销）。
 * 3. 用户手标的一条都不能少。
 * 4. 没有音频时报 `unsupported` 而不是给一张空地图。
 */

const SR = 44100;

/** 前 8 秒低频、后 8 秒高频：一个干净的段落边界。 */
function twoToneBuffer(seconds = 16): AudioBufferLike {
  const length = Math.round(seconds * SR);
  const data = new Float32Array(length);
  const half = length / 2;
  for (let i = 0; i < length; i += 1) {
    const hz = i < half ? 110 : 4000;
    data[i] = Math.sin((i / SR) * 2 * Math.PI * hz) * 0.5;
  }
  return { length, numberOfChannels: 1, sampleRate: SR, getChannelData: () => data };
}

interface AudioBufferLike {
  length: number;
  numberOfChannels: number;
  sampleRate: number;
  getChannelData(channel: number): Float32Array;
}

interface Harness {
  store: ProjectStore;
  cp: AgentControlPlane;
}

function projectWithSong(seconds = 16): Project {
  const project = createBlankProject('music-test');
  project.duration = seconds;
  project.fps = 30;
  // 刻意留一个手动节奏点：`analyze_music` 只在「完全没被碰过」时才重估网格，
  // 这样测试里的小节坐标是确定的，不会随估拍结果漂。
  project.beatGrid = { bpm: 120, offset: 0, beatsPerBar: 4 };
  project.beatMarks = [3];
  project.tracks.push({
    id: 'tr-a',
    kind: 'audio',
    name: 'A1',
    enabled: true,
    bus: 'master',
    clips: [
      {
        id: 'song',
        kind: 'audio',
        start: 0,
        end: seconds,
        label: 'song.wav',
        fadeSec: 0,
        curves: {},
        assetId: 'asset-song',
        srcIn: 0,
      },
    ],
  });
  return project;
}

function harness(buffer: AudioBufferLike | null = twoToneBuffer()): Harness {
  const store = new ProjectStore(projectWithSong());
  const ctx: ControlContext = {
    getStore: () => store,
    getRenderer: () => null,
    getAssets: () => null,
    getPlayT: () => 0,
    setPlayT: () => {},
    getAudioBuffer: () => buffer as unknown as AudioBuffer | null,
    listProjects: () => [],
    saveProject: async () => false,
    openProject: async () => false,
    cancelPendingGesture: () => {},
    refreshPreview: () => {},
  };
  return { store, cp: createControlPlane(ctx) };
}

async function ok<T>(p: Promise<ControlResult<T>>): Promise<T> {
  const r = await p;
  if (!r.ok) throw new Error(`期望成功，实际失败：${r.error.code} / ${r.error.message}`);
  return r.data;
}

beforeEach(() => {
  clearAnalyses();
  clearMusicMaps();
});

describe('analyze_music：写段落', () => {
  it('把边界写进工程，且带 source:auto', async () => {
    const { store, cp } = harness();
    const view = await ok<AnalyzeMusicView>(cp.analyzeMusic());
    expect(view.sections.length).toBe(2);
    expect(view.written.added).toBe(2);
    expect(store.project.sections.length).toBe(2);
    expect(store.project.sections.every((s) => s.source === 'auto')).toBe(true);
  });

  it('段落首尾相接、覆盖整首歌，名字是字母', async () => {
    const { cp } = harness();
    const view = await ok<AnalyzeMusicView>(cp.analyzeMusic());
    expect(view.sections[0]!.start).toBe(0);
    expect(view.sections[view.sections.length - 1]!.end).toBeCloseTo(16, 3);
    for (let i = 1; i < view.sections.length; i += 1) {
      expect(view.sections[i]!.start).toBeCloseTo(view.sections[i - 1]!.end, 3);
    }
    expect(view.sections.every((s) => /^[A-Z]$/.test(s.letter))).toBe(true);
  });

  it('重跑是幂等的：不给重复段落，也不产生改动', async () => {
    const { store, cp } = harness();
    await ok(cp.analyzeMusic());
    const ids = store.project.sections.map((s) => s.id);
    const again = await ok<AnalyzeMusicView>(cp.analyzeMusic());
    expect(again.written).toEqual({ added: 0, replaced: 0, removed: 0, kept: 0 });
    expect(store.project.sections.map((s) => s.id)).toEqual(ids);
  });

  it('用户手标的段落一条都不少', async () => {
    const { store, cp } = harness();
    store.addSection(4, '我的段落');
    const view = await ok<AnalyzeMusicView>(cp.analyzeMusic());
    expect(view.written.kept).toBe(1);
    expect(store.project.sections.map((s) => s.name)).toContain('我的段落');
    expect(store.project.sections.length).toBe(3);
  });

  it('markSections:false 时只读不写', async () => {
    const { store, cp } = harness();
    const view = await ok<AnalyzeMusicView>(cp.analyzeMusic({ markSections: false }));
    expect(view.sections.length).toBe(2);
    expect(view.written).toEqual({ added: 0, replaced: 0, removed: 0, kept: 0 });
    expect(store.project.sections.length).toBe(0);
  });
});

describe('analyze_music：地图内容', () => {
  it('给出网格、段落字母与客观量', async () => {
    const { cp } = harness();
    const view = await ok<AnalyzeMusicView>(cp.analyzeMusic());
    expect(view.grid.source).toBe('existing');
    expect(view.grid.bpm).toBe(120);
    expect(view.grid.barSec).toBeCloseTo(2, 6);
    expect(view.song.bars).toBe(8);
    const [a, b] = view.sections;
    // 后半段是高频，频段占比与亮度必须真的分开 —— 这是「分析有没有在做事」的判据。
    expect(b!.band.high + b!.band.air).toBeGreaterThan(a!.band.high + a!.band.air);
    expect(b!.brightness).toBeGreaterThan(a!.brightness);
    expect(b!.dEnergy).toBeGreaterThan(0);
  });

  it('includeBars 给逐小节表，行数等于小节数', async () => {
    const { cp } = harness();
    const view = await ok<AnalyzeMusicView>(cp.analyzeMusic({ includeBars: true }));
    expect(view.bars).toBeDefined();
    expect(view.bars!.length).toBe(view.song.bars);
    expect(view.bars![0]!.bar).toBe(view.song.startBar);
  });

  it('不带 includeBars 时不塞逐小节表（省上下文）', async () => {
    const { cp } = harness();
    const view = await ok<AnalyzeMusicView>(cp.analyzeMusic());
    expect(view.bars).toBeUndefined();
  });

  it('minSectionBars 收紧后段落数不增加', async () => {
    const loose = await ok<AnalyzeMusicView>(harness().cp.analyzeMusic({ minSectionBars: 2 }));
    const tight = await ok<AnalyzeMusicView>(harness().cp.analyzeMusic({ minSectionBars: 8 }));
    expect(tight.sections.length).toBeLessThanOrEqual(loose.sections.length);
  });
});

describe('analyze_music：错误路径', () => {
  it('没有可解码音频 → unsupported', async () => {
    const { cp } = harness(null);
    const r = await cp.analyzeMusic();
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('unsupported');
  });

  it('clipId 不存在 → not-found', async () => {
    const { cp } = harness();
    const r = await cp.analyzeMusic({ clipId: 'nope' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('not-found');
  });
});
