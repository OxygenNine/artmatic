import { describe, expect, it } from 'vitest';
import {
  BG_DEFAULT_OPACITY,
  BG_FRAME_WIDTH,
  advancePreviewTime,
  backgroundProject,
  bgFrameSize,
  clampBgOpacity,
} from '../../src/ui/typography/background-preview';
import type { Project, SourceClip, VisualTrack } from '../../src/core/schema';

/* --------------------------------------------------------------- 构造工具 */

function clip(id: string, patch: Partial<SourceClip> = {}): SourceClip {
  return {
    kind: 'source',
    id,
    start: 0,
    end: 2,
    label: id,
    fadeSec: 0,
    curves: {},
    source: { type: 'solid', color: '#000' },
    blend: 'normal',
    opacity: 1,
    transform: { x: 0.5, y: 0.5, sx: 1, sy: 1, rot: 0 },
    fit: 'stretch',
    ...patch,
  };
}

function visual(id: string, clips: SourceClip[]): VisualTrack {
  return { id, name: id, enabled: true, kind: 'visual', clips };
}

function project(tracks: Project['tracks']): Project {
  return {
    schemaVersion: 5,
    name: 'p',
    seed: 1,
    fps: 30,
    resolution: { w: 1920, h: 1080 },
    duration: 10,
    beatGrid: { bpm: 120, offset: 0, beatsPerBar: 4 },
    overlapBehavior: 'reject',
    assets: {},
    tracks,
    sections: [],
    beatMarks: [],
  };
}

/** 视觉轨里按 id 取片段，并断言它是 source（opacity 只存在于 SourceClip 上）。 */
function sourceOf(p: Project, trackIndex: number, id: string): SourceClip {
  const found = (p.tracks[trackIndex] as VisualTrack).clips.find((c) => c.id === id);
  if (!found || found.kind !== 'source') throw new Error(`没有 source 片段 ${id}`);
  return found;
}

/* --------------------------------------------------------------- 尺寸 */

describe('bgFrameSize', () => {
  it('按工程宽高比换算高度，宽度固定', () => {
    expect(bgFrameSize({ w: 1920, h: 1080 })).toEqual({ w: BG_FRAME_WIDTH, h: 270 });
    expect(bgFrameSize({ w: 1080, h: 1920 })).toEqual({ w: BG_FRAME_WIDTH, h: 853 });
  });

  it('自定义最大宽度（导出 / 调试用）', () => {
    expect(bgFrameSize({ w: 100, h: 100 }, 64)).toEqual({ w: 64, h: 64 });
  });

  it('非法分辨率回落到 16:9 且不为 0 高', () => {
    expect(bgFrameSize({ w: 0, h: 0 })).toEqual({ w: BG_FRAME_WIDTH, h: 270 });
  });
});

/* --------------------------------------------------------------- 不透明度 */

describe('clampBgOpacity', () => {
  it('夹进 [0,1]', () => {
    expect(clampBgOpacity(-1)).toBe(0);
    expect(clampBgOpacity(2)).toBe(1);
    expect(clampBgOpacity(0.42)).toBeCloseTo(0.42);
  });

  it('NaN / 非有限值回落到默认值（滑杆清空会给 NaN）', () => {
    expect(clampBgOpacity(Number.NaN)).toBe(BG_DEFAULT_OPACITY);
    expect(clampBgOpacity(Number.POSITIVE_INFINITY)).toBe(BG_DEFAULT_OPACITY);
  });
});

/* --------------------------------------------------------------- 底图工程 */

describe('backgroundProject', () => {
  it('只把被编辑的片段置为不可见，其余原样', () => {
    const edited = clip('edited');
    const other = clip('other', { opacity: 0.5 });
    const p = project([visual('V1', [other, edited])]);

    const bg = backgroundProject(p, 'edited');
    expect(sourceOf(bg, 0, 'edited').opacity).toBe(0);
    // 其它片段逐字段不变（同一个对象引用即可证明没被改动）。
    expect(sourceOf(bg, 0, 'other')).toBe(other);
    // 原工程一个字节不动。
    expect(sourceOf(p, 0, 'edited').opacity).toBe(1);
  });

  it('同时删掉 opacity 曲线 —— 否则曲线会盖过 opacity=0 把文字又画出来', () => {
    const edited = clip('edited', {
      curves: { opacity: { keys: [{ t: 0, v: 0, interp: 'linear' }, { t: 1, v: 1, interp: 'linear' }] } },
    });
    const bg = backgroundProject(project([visual('V1', [edited])]), 'edited');
    const out = sourceOf(bg, 0, 'edited');
    expect(out.opacity).toBe(0);
    expect(out.curves.opacity).toBeUndefined();
  });

  it('找不到该片段时返回同一个对象（不产生垃圾副本）', () => {
    const p = project([visual('V1', [clip('a')])]);
    expect(backgroundProject(p, 'nope')).toBe(p);
  });

  it('音频轨不受影响', () => {
    const p = project([
      { id: 'A1', name: 'A1', enabled: true, kind: 'audio', bus: 'master', clips: [] },
    ]);
    expect(backgroundProject(p, 'edited')).toBe(p);
  });
});

/* --------------------------------------------------------------- 播放推进 */

describe('advancePreviewTime', () => {
  const c = { start: 1, end: 3 };

  it('未到尾部时照常推进', () => {
    const r = advancePreviewTime(1.5, 0.25, c);
    expect(r.at).toBeCloseTo(1.75);
    expect(r.playing).toBe(true);
    expect(r.ended).toBe(false);
  });

  it('到片段尾就停（不回环）并标记 ended', () => {
    const r = advancePreviewTime(2.9, 0.5, c);
    expect(r.at).toBe(3);
    expect(r.playing).toBe(false);
    expect(r.ended).toBe(true);
  });

  it('单步夹在 0.25s 内（标签页切回来的大 dt 不跳段）', () => {
    const r = advancePreviewTime(1, 5, c);
    expect(r.at).toBeCloseTo(1.25);
  });

  it('负 dt（时钟回退）不倒退', () => {
    const r = advancePreviewTime(1.5, -1, c);
    expect(r.at).toBeCloseTo(1.5);
  });
});
