/**
 * 预览渲染缓存的纯计算层（`core/preview-cache.ts`）。
 *
 * 这一层决定**什么时候该命中、什么时候该删**，而两者的失效都不报错：
 * 命中判错 = 放出一张旧画面；删错 = 正在用的缓存被回收（表现是「播到一半突然卡」）。
 * 所以这里只测机制量，不测形状。
 */

import { describe, expect, it } from 'vitest';
import {
  cachePieces,
  cacheRanges,
  coversRange,
  isLastSlice,
  pickEvictions,
  previewBitrate,
  previewMetaName,
  previewVideoName,
  rangeSignature,
  sliceFrameRange,
  sliceIndexAt,
  usableEntry,
  PREVIEW_CACHE_VER,
  type PreviewCacheEntry,
} from '../../src/core/preview-cache';
import type { Project } from '../../src/core/schema';

const SIZE = { w: 1280, h: 720 };

function entry(over: Partial<PreviewCacheEntry> = {}): PreviewCacheEntry {
  return {
    ver: PREVIEW_CACHE_VER,
    sig: 'aaaa',
    from: 0,
    to: 300,
    fps: 30,
    w: SIZE.w,
    h: SIZE.h,
    bytes: 1_000_000,
    at: 1,
    ...over,
  };
}

/* ------------------------------------------------ 内容签名（按段失效的核心） */

/** 30 fps、24 s、两条视觉轨的最小工程：V1 在 [0,8)，V2 在 [16,24)。 */
function makeProject(over: { v1End?: number; v2Label?: string } = {}): Project {
  const base = {
    fadeSec: 0,
    curves: {},
    transform: { x: 0.5, y: 0.5, sx: 1, sy: 1, rot: 0 },
    fit: 'stretch' as const,
    blend: 'normal' as const,
    opacity: 1,
  };
  const clip = (id: string, start: number, end: number, label: string) => ({
    ...base,
    kind: 'source' as const,
    id,
    start,
    end,
    label,
    source: { type: 'solid' as const, color: '#123456' },
  });
  return {
    schemaVersion: 23,
    name: 'sig-test',
    seed: 7,
    fps: 30,
    resolution: { w: 1920, h: 1080 },
    duration: 24,
    beatGrid: { bpm: 120, offset: 0, beatsPerBar: 4 },
    overlapBehavior: 'reject',
    assets: {},
    tracks: [
      {
        kind: 'visual',
        id: 't1',
        name: 'V2',
        enabled: true,
        clips: [clip('c1', 0, over.v1End ?? 8, 'V2 片段')],
      } as never,
      {
        kind: 'visual',
        id: 't2',
        name: 'V1',
        enabled: true,
        clips: [clip('c2', 16, 24, over.v2Label ?? 'V1 片段')],
      } as never,
    ],
    sections: [],
    beatMarks: [],
    issues: [],
  } as unknown as Project;
}

const SIG_ARGS = { assetsRev: '', w: 1280, h: 720 };

describe('段签名（rangeSignature）', () => {
  it('同一段、同一内容 ⇒ 同一签名（两次算必须相等，否则永远不命中）', () => {
    const p = makeProject();
    expect(rangeSignature({ project: p, ...SIG_ARGS, from: 0, to: 240 })).toBe(
      rangeSignature({ project: p, ...SIG_ARGS, from: 0, to: 240 }),
    );
  });

  it('**改远处的片段不影响这一段的签名**（这就是按段失效的全部意义）', () => {
    const before = rangeSignature({ project: makeProject(), ...SIG_ARGS, from: 0, to: 240 });
    // 改 16–24 s 那段的标签：两段相隔 8 s，远超 3 s 的签名余量
    const after = rangeSignature({ project: makeProject({ v2Label: '改过了' }), ...SIG_ARGS, from: 0, to: 240 });
    expect(after).toBe(before);
  });

  it('改段内（或边界余量内）的片段 ⇒ 签名必须变', () => {
    const before = rangeSignature({ project: makeProject(), ...SIG_ARGS, from: 0, to: 240 });
    // V2 片段从 8 s 延到 9 s：它落在 [0,8] 段的 3 s 余量里
    const after = rangeSignature({ project: makeProject({ v1End: 9 }), ...SIG_ARGS, from: 0, to: 240 });
    expect(after).not.toBe(before);
  });

  it('全局但影响像素的东西变了 ⇒ 所有段都换签名', () => {
    const base = makeProject();
    const sig = rangeSignature({ project: base, ...SIG_ARGS, from: 0, to: 240 });
    const seedChanged = { ...base, seed: 8 } as Project;
    const fpsChanged = { ...base, fps: 25 } as Project;
    expect(rangeSignature({ project: seedChanged, ...SIG_ARGS, from: 0, to: 240 })).not.toBe(sig);
    expect(rangeSignature({ project: fpsChanged, ...SIG_ARGS, from: 0, to: 240 })).not.toBe(sig);
  });

  it('不决定像素的字段改了 ⇒ 签名不变（工程名 / 段落 / 节奏点）', () => {
    const base = makeProject();
    const sig = rangeSignature({ project: base, ...SIG_ARGS, from: 0, to: 240 });
    const renamed = { ...base, name: '换个名字', sections: [{ id: 's', start: 0, name: 'A', color: '#fff' }] } as Project;
    expect(rangeSignature({ project: renamed, ...SIG_ARGS, from: 0, to: 240 })).toBe(sig);
  });

  it('尺寸 / 素材指纹 / 段边界进签名', () => {
    const p = makeProject();
    const sig = rangeSignature({ project: p, ...SIG_ARGS, from: 0, to: 240 });
    expect(rangeSignature({ project: p, ...SIG_ARGS, w: 1282, from: 0, to: 240 })).not.toBe(sig);
    expect(rangeSignature({ project: p, ...SIG_ARGS, assetsRev: 'x', from: 0, to: 240 })).not.toBe(sig);
    expect(rangeSignature({ project: p, ...SIG_ARGS, from: 0, to: 300 })).not.toBe(sig);
  });
});

describe('分片', () => {
  it('10 s 一片：第 0 片是 [0, fps*10)', () => {
    expect(sliceIndexAt(0)).toBe(0);
    expect(sliceIndexAt(9.99)).toBe(0);
    expect(sliceIndexAt(10)).toBe(1);
    expect(sliceFrameRange(0, 30, 900)).toEqual({ from: 0, to: 300 });
    expect(sliceFrameRange(1, 30, 900)).toEqual({ from: 300, to: 600 });
  });

  it('末片被总帧数夹住', () => {
    expect(sliceFrameRange(2, 30, 700)).toEqual({ from: 600, to: 700 });
    expect(isLastSlice(2, 30, 700)).toBe(true);
    expect(isLastSlice(1, 30, 700)).toBe(false);
  });

  it('文件名带补零的片号，且不含路径分隔符', () => {
    expect(previewVideoName('ab12', 300)).toBe('ab12-000300.mp4');
    expect(previewMetaName('ab12', 300)).toBe('ab12-000300.json');
  });
});

describe('命中判定', () => {
  const want = { sig: 'aaaa', fps: 30, w: SIZE.w, h: SIZE.h, from: 0, to: 300 };

  it('全对才命中', () => {
    expect(usableEntry(entry(), want)).toBe(true);
    expect(usableEntry(entry({ sig: 'bbbb' }), want)).toBe(false);
    expect(usableEntry(entry({ from: 10 }), want)).toBe(false);
    expect(usableEntry(entry({ to: 299 }), want)).toBe(false);
    expect(usableEntry(entry({ w: 640 }), want)).toBe(false);
    expect(usableEntry(entry({ ver: PREVIEW_CACHE_VER + 1 }), want)).toBe(false);
    expect(usableEntry(entry({ bytes: 0 }), want)).toBe(false);
    expect(usableEntry(null, want)).toBe(false);
  });
});

describe('缓存条切片（三态互斥、铺满计划区间）', () => {
  it('没有缓存 ⇒ 整段 missing', () => {
    expect(cachePieces({ from: 0, to: 120 }, [], null)).toEqual([{ from: 0, to: 120, state: 'missing' }]);
  });

  it('已烘好 ⇒ ready；正在烘到第 n 帧 ⇒ 那一小段变 encoding（虚线随进度长）', () => {
    expect(cachePieces({ from: 0, to: 120 }, [{ from: 0, to: 120 }], null)).toEqual([
      { from: 0, to: 120, state: 'ready' },
    ]);
    expect(cachePieces({ from: 0, to: 120 }, [], { from: 0, to: 40 })).toEqual([
      { from: 0, to: 40, state: 'encoding' },
      { from: 40, to: 120, state: 'missing' },
    ]);
  });

  it('手工烘的子区间：那一段 ready，其余 missing', () => {
    const r = cachePieces({ from: 0, to: 600 }, [{ from: 30, to: 90 }], null);
    expect(r).toEqual([
      { from: 0, to: 30, state: 'missing' },
      { from: 30, to: 90, state: 'ready' },
      { from: 90, to: 600, state: 'missing' },
    ]);
  });

  it('相邻同态合并（否则一段缓存要画几十条线）', () => {
    const r = cachePieces({ from: 0, to: 300 }, [{ from: 0, to: 100 }, { from: 100, to: 300 }], null);
    expect(r).toEqual([{ from: 0, to: 300, state: 'ready' }]);
  });

  it('区间被夹在计划段内，且空段不产出', () => {
    expect(cachePieces({ from: 100, to: 200 }, [{ from: 0, to: 50 }], null)).toEqual([
      { from: 100, to: 200, state: 'missing' },
    ]);
    expect(cachePieces({ from: 5, to: 5 }, [], null)).toEqual([]);
  });
});

describe('覆盖判定（时间轴「这一段烘完没有」）', () => {
  it('一条罩住就算；两条接起来也算（手工烘的片段与自动切片会拼接）', () => {
    expect(coversRange([{ from: 0, to: 300 }], 0, 300)).toBe(true);
    expect(coversRange([{ from: 0, to: 120 }, { from: 120, to: 300 }], 0, 300)).toBe(true);
    // 顺序颠倒不影响（内部会排序）
    expect(coversRange([{ from: 120, to: 300 }, { from: 0, to: 120 }], 0, 300)).toBe(true);
  });

  it('中间有缝 / 两头不够 / 空区间都不算', () => {
    expect(coversRange([{ from: 0, to: 100 }, { from: 140, to: 300 }], 0, 300)).toBe(false);
    expect(coversRange([{ from: 10, to: 300 }], 0, 300)).toBe(false);
    expect(coversRange([{ from: 0, to: 290 }], 0, 300)).toBe(false);
    expect(coversRange([], 0, 300)).toBe(false);
    expect(coversRange([{ from: 0, to: 300 }], 300, 300)).toBe(false);
  });

  it('越过窗口范围的条目不会「多算出」覆盖', () => {
    // 只有 [0,50) 落在 [100,300) 之外的条目
    expect(coversRange([{ from: 0, to: 50 }, { from: 250, to: 400 }], 100, 300)).toBe(false);
  });
});

describe('回收', () => {
  const PLAN = [{ from: 0, to: 600 }];

  it('计划区间之外的直接删；区间内的保留（含手工烘的子区间）', () => {
    const list = [
      entry({ sig: 'cur', from: 0, to: 600, bytes: 100 }),
      entry({ sig: 'hand', from: 30, to: 90, bytes: 200 }),
      entry({ sig: 'gone', from: 900, to: 1200, bytes: 300 }),
    ];
    const { byName, freedBytes } = pickEvictions(list, 10_000, PLAN);
    expect(byName).toContain(previewVideoName('gone', 900));
    expect(byName).not.toContain(previewVideoName('cur', 0));
    expect(byName).not.toContain(previewVideoName('hand', 30));
    expect(freedBytes).toBe(300);
  });

  it('超出预算时按写入时刻从旧到新删，删到预算的 80%', () => {
    const list = [
      entry({ sig: 'a', from: 0, to: 300, bytes: 400, at: 1 }),
      entry({ sig: 'b', from: 300, to: 600, bytes: 400, at: 2 }),
      entry({ sig: 'c', from: 600, to: 900, bytes: 400, at: 3 }),
    ];
    // 1200 > 1000 ⇒ 目标 800 ⇒ 删最旧的一条刚好到 800。
    const { byName } = pickEvictions(list, 1000, [{ from: 0, to: 900 }]);
    expect(byName).toEqual([previewVideoName('a', 0), previewMetaName('a', 0)]);
  });

  it('预算够就什么都不删', () => {
    const list = [entry({ sig: 'cur', from: 0, to: 300, bytes: 100 })];
    expect(pickEvictions(list, 10_000, PLAN).byName).toEqual([]);
  });
});

describe('码率', () => {
  it('夹在 1.5–4 Mbps，且随像素数增长', () => {
    expect(previewBitrate(320, 180)).toBe(1_500_000);
    expect(previewBitrate(1920, 1080)).toBe(4_000_000);
    expect(previewBitrate(960, 540)).toBeGreaterThan(previewBitrate(480, 270));
  });
});

describe('烘焙区间（按片段起止点，不是固定切片）', () => {
  const track = (clips: { start: number; end: number }[], kind = 'visual', enabled = true) => ({
    kind,
    enabled,
    clips: clips.map((c) => ({ kind: 'source', ...c })),
  });

  it('相邻片段合并，间隔大于 0.5 s 不合并', () => {
    const r = cacheRanges({
      fps: 30,
      duration: 20,
      tracks: [track([{ start: 0, end: 2 }, { start: 2, end: 4 }, { start: 6, end: 8 }])],
    });
    expect(r).toEqual([
      { from: 0, to: 120 },
      { from: 180, to: 240 },
    ]);
  });

  it('长段按 20 s 切开', () => {
    const r = cacheRanges({ fps: 30, duration: 100, tracks: [track([{ start: 0, end: 50 }])] });
    expect(r.map((x) => x.to - x.from)).toEqual([600, 600, 300]);
  });

  it('音频轨与禁用轨不产生区间', () => {
    const r = cacheRanges({
      fps: 30,
      duration: 10,
      tracks: [track([{ start: 0, end: 3 }], 'audio'), track([{ start: 4, end: 6 }], 'visual', false)],
    });
    expect(r).toEqual([]);
  });
});
