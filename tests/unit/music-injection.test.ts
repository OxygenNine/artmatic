import { beforeEach, describe, expect, it } from 'vitest';
import { defaultProject } from '../../src/core/schema';
import type { AudioClip, Project, SourceClip } from '../../src/core/schema';
import { resolveBase, paramWithCurve } from '../../src/engine/stack';
import { audioClipGainAt } from '../../src/core/audio-envelope';
import { modTable, type MusicSampler } from '../../src/core/modulation';
import { ZERO_MUSIC, type MusicAudioSample } from '../../src/core/expr';
import { analyzeAsset, clearAnalyses, type AnalysisBuffer } from '../../src/audio/analysis';
import { clearMusicMaps, momentAt, musicMapFor, pickAnalysisClip } from '../../src/audio/music-store';
import { ProjectAudio } from '../../src/ui/project-audio';

/**
 * 注入面。判据是「四条互不相干的求值路径都得读到同一个采样」：
 *
 * 1. 片段参数（`engine/stack.ts::paramWithCurve` —— transform / opacity / 生成器参数）
 * 2. 特效参数（`effects/runner.ts`，同一套 `resolveParam`，只是 ctx 来源不同）
 * 3. 声音增益（`core/audio-envelope.ts`，导出混流与预览共用）
 * 4. 渲染期的主应用来源（`ProjectAudio.musicAt`）
 *
 * 只接上一两条的表现是「生成器随音乐动、transform 不动」，不报错，只能靠肉眼。
 */

const SR = 44100;
const BPM = 120;
const BPB = 4;
/** 120 BPM / 4 拍 → 一小节 2 秒。 */
const BAR_SEC = 2;

function fakeBuffer(seconds: number): AnalysisBuffer {
  const length = Math.round(seconds * SR);
  const data = new Float32Array(length);
  for (let i = 0; i < length; i += 1) {
    // 440 Hz 正弦：特征非零，chroma 落在 A。
    data[i] = Math.sin((i / SR) * 2 * Math.PI * 440) * 0.6;
  }
  return { length, numberOfChannels: 1, sampleRate: SR, getChannelData: () => data };
}

function sampler(sample: Partial<MusicAudioSample> = {}): MusicSampler {
  const full = { ...ZERO_MUSIC, ...sample };
  return () => ({
    rms: full.rms,
    sub: full.sub,
    bass: full.bass,
    mid: full.mid,
    high: full.high,
    air: full.air,
    flux: full.flux,
    centroid: full.centroid,
    flat: full.flat,
    energy: full.energy,
    section: full.section,
    sectionU: full.sectionU,
    novelty: full.novelty,
  });
}

function projectWithAudio(seconds = 4): { project: Project; clip: AudioClip } {
  const project = defaultProject('t');
  project.fps = 30;
  project.duration = seconds;
  project.beatGrid = { bpm: BPM, offset: 0, beatsPerBar: BPB };
  const clip: AudioClip = {
    id: 'a1',
    kind: 'audio',
    start: 0,
    end: seconds,
    label: 'song',
    fadeSec: 0,
    curves: {},
    assetId: 'asset-a',
    srcIn: 0,
  };
  project.tracks.push({ id: 't1', kind: 'audio', name: 'A1', enabled: true, clips: [clip], bus: 'master' });
  return { project, clip };
}

beforeEach(() => {
  clearAnalyses();
  clearMusicMaps();
});

describe('注入面：片段参数', () => {
  it('paramWithCurve 读得到 rms', () => {
    const project = defaultProject('t');
    project.beatGrid = { bpm: BPM, offset: 0, beatsPerBar: BPB };
    const clip: SourceClip = {
      id: 'c1',
      kind: 'source',
      start: 0,
      end: 4,
      label: 'c',
      fadeSec: 0,
      curves: {},
      mods: { opacity: [{ ref: 'm', gain: 1, mode: 'add' }] },
      source: { type: 'solid', color: '#000000' },
      blend: 'normal',
      opacity: 0,
      transform: { x: 0, y: 0, sx: 1, sy: 1, rot: 0 },
      fit: 'contain',
    };
    project.modulators = [{ id: 'm', name: 'm', expr: 'rms', unit: { min: 0, max: 1 } }];
    const base = resolveBase(project, sampler({ rms: 0.75 }));
    expect(paramWithCurve(clip, 'opacity', 0, 1, base)).toBeCloseTo(0.75, 9);
  });

  it('resolveBase 不传采样器时结果是静态基值', () => {
    const project = defaultProject('t');
    const clip: SourceClip = {
      id: 'c1',
      kind: 'source',
      start: 0,
      end: 4,
      label: 'c',
      fadeSec: 0,
      curves: {},
      mods: { opacity: [{ ref: 'm', gain: 1, mode: 'add' }] },
      source: { type: 'solid', color: '#000000' },
      blend: 'normal',
      opacity: 0.4,
      transform: { x: 0, y: 0, sx: 1, sy: 1, rot: 0 },
      fit: 'contain',
    };
    project.modulators = [{ id: 'm', name: 'm', expr: 'energy', unit: { min: 0, max: 3 } }];
    expect(paramWithCurve(clip, 'opacity', 0.4, 1, resolveBase(project))).toBeCloseTo(0.4, 9);
  });
});

describe('注入面：声音增益', () => {
  const grid = { bpm: BPM, offset: 0, beatsPerBar: BPB };

  it('gain 曲线被 energy 调制（导出混流那条路径）', () => {
    const clip = {
      start: 0,
      end: 8,
      curves: {},
      mods: { gain: [{ ref: 'm', gain: 1, mode: 'add' as const }] },
    };
    const ctx = { mods: modTable([{ id: 'm', name: 'm', expr: 'energy / 10', unit: { min: 0, max: 1 } }]), music: sampler({ energy: 2 }) };
    expect(audioClipGainAt(clip, grid, 1, ctx)).toBeCloseTo(1.2, 9);
  });

  it('不注入采样器时增益就是 1（静音工程不会突然变响或变哑）', () => {
    const clip = {
      start: 0,
      end: 8,
      curves: {},
      mods: { gain: [{ ref: 'm', gain: 1, mode: 'add' as const }] },
    };
    const ctx = { mods: modTable([{ id: 'm', name: 'm', expr: 'energy', unit: { min: 0, max: 3 } }]) };
    expect(audioClipGainAt(clip, grid, 1, ctx)).toBeCloseTo(1, 9);
  });
});

describe('分析片段的选择', () => {
  it('取最长的那条（过场音效不该抢走 master）', () => {
    const project = defaultProject('t');
    project.tracks.push({
      id: 't1',
      kind: 'audio',
      name: 'A1',
      enabled: true,
      bus: 'master',
      clips: [
        { id: 'short', kind: 'audio', start: 0, end: 2, label: 'sfx', fadeSec: 0, curves: {}, assetId: 'sfx', srcIn: 0 },
        { id: 'long', kind: 'audio', start: 2, end: 40, label: 'master', fadeSec: 0, curves: {}, assetId: 'master', srcIn: 0 },
      ],
    });
    expect(pickAnalysisClip(project)?.clip.id).toBe('long');
    expect(pickAnalysisClip(project, 'short')?.clip.id).toBe('short');
    expect(pickAnalysisClip(project, 'nope')).toBeNull();
  });

  it('timeOffset = clip.start - clip.srcIn（素材时间 → 工程时间）', () => {
    const project = defaultProject('t');
    project.tracks.push({
      id: 't1',
      kind: 'audio',
      name: 'A1',
      enabled: true,
      bus: 'master',
      clips: [
        { id: 'c', kind: 'audio', start: 5, end: 15, label: 'm', fadeSec: 0, curves: {}, assetId: 'a', srcIn: 3 },
      ],
    });
    expect(pickAnalysisClip(project)?.timeOffset).toBe(2);
  });
});

describe('音乐地图缓存', () => {
  it('分析没算好时返回 null（渲染路径不能等）', () => {
    const { project } = projectWithAudio();
    expect(musicMapFor(project, () => fakeBuffer(4))).toBeNull();
  });

  it('分析就绪后给出地图，且同一输入返回同一个对象', async () => {
    const { project } = projectWithAudio(4);
    const buf = fakeBuffer(4);
    await analyzeAsset('asset-a', buf);
    const a = musicMapFor(project, () => buf);
    const b = musicMapFor(project, () => buf);
    expect(a).not.toBeNull();
    expect(b).toBe(a);
    expect(a!.sections.length).toBeGreaterThanOrEqual(1);
  });

  it('改拍网格后必须重算（setBeatGrid 是原地改写，不能按 project 引用判失效）', async () => {
    const { project } = projectWithAudio(4);
    const buf = fakeBuffer(4);
    await analyzeAsset('asset-a', buf);
    const a = musicMapFor(project, () => buf);
    project.beatGrid.bpm = 90;
    const b = musicMapFor(project, () => buf);
    expect(b).not.toBe(a);
    expect(b!.bpm).toBe(90);
  });

  it('momentAt 给出段内进度，且落在 0..1', async () => {
    const { project } = projectWithAudio(4);
    const buf = fakeBuffer(4);
    await analyzeAsset('asset-a', buf);
    const map = musicMapFor(project, () => buf)!;
    const m = momentAt(map, 1);
    expect(m.section).toBe(0);
    expect(m.sectionU).toBeGreaterThanOrEqual(0);
    expect(m.sectionU).toBeLessThanOrEqual(1);
    expect(m.energy).toBeGreaterThanOrEqual(0);
  });
});

describe('ProjectAudio.musicAt（主应用来源）', () => {
  it('有音频时给非零特征与段落位置', async () => {
    const { project } = projectWithAudio(4);
    const buf = fakeBuffer(4);
    await analyzeAsset('asset-a', buf);
    const audio = new ProjectAudio(() => project, () => buf);
    const m = audio.musicAt(1);
    expect(m.rms).toBeGreaterThan(0);
    expect(m.section).toBe(0);
    expect(Number.isFinite(m.energy)).toBe(true);
  });

  it('片段之外全 0，且不返回 NaN', () => {
    const { project } = projectWithAudio(4);
    const buf = fakeBuffer(4);
    const audio = new ProjectAudio(() => project, () => buf);
    const m = audio.musicAt(99);
    expect(m.rms).toBe(0);
    expect(m.energy).toBe(0);
    expect(m.sectionU).toBe(0);
  });

  it('同一 t 重复调用返回同一个对象（每帧每参数都读，不能分配）', async () => {
    const { project } = projectWithAudio(4);
    const buf = fakeBuffer(4);
    await analyzeAsset('asset-a', buf);
    const audio = new ProjectAudio(() => project, () => buf);
    expect(audio.musicAt(1.5)).toBe(audio.musicAt(1.5));
  });
});
