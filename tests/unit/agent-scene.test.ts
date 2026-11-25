/**
 * agent 控制平面 M0 的守卫（方案 `docs/agent-control-plane.md` §8 的 M0 行）：
 * 纯函数构造 `SceneSnapshot`，断言 **z 序**、**转场窗口内的 `active`**、
 * **`detail:'ids'` 的裁剪**。
 *
 * 这三条都是「控制平面算好、不让 agent 自己推」的东西，推错的代价是**静默**的：
 * z 写反 = 特效完全无效且不报错（AGENTS §4.1）；`active` 漏掉转场窗口后半段
 * = agent 以为那个片段已经出画了（`engine/stack.ts` 有专条）；ids 没裁剪
 * = 长工程里一次把上下文烧光。
 */

import { describe, expect, it } from 'vitest';
import { buildClipView, buildSceneSnapshot, snapToFrame, visualZ } from '../../src/agent/scene';
import { THREE_CODE_SCENE_INLINE_MAX } from '../../src/three/code';
import { defaultProject, newId, type Project, type SourceClip, type VisualTrack } from '../../src/core/schema';

/* ------------------------------------------------------------------ 造工程 */

function solidClip(id: string, start: number, end: number, label: string): SourceClip {
  return {
    kind: 'source',
    id,
    start,
    end,
    label,
    fadeSec: 0,
    curves: {},
    source: { type: 'solid', color: '#ff0000' },
    blend: 'normal',
    opacity: 1,
    transform: { x: 0.5, y: 0.5, sx: 1, sy: 1, rot: 0 },
    fit: 'stretch',
  };
}

function visualTrack(name: string, clips: SourceClip[]): VisualTrack {
  return { kind: 'visual', id: `t-${name}`, name, enabled: true, clips };
}

/** 一视觉轨（from[0,2] + to[2,4]，from 带 d=1 的出画转场 → 窗口 [1.5, 2.5)）+ 一音频轨。 */
function transitionProject(): Project {
  const p = defaultProject('agent-scene');
  p.duration = 10;
  const from = solidClip('from', 0, 2, 'from');
  from.transitionOut = { defId: 'fade', duration: 1, values: {} };
  const to = solidClip('to', 2, 4, 'to');
  p.tracks = [
    visualTrack('V1', [from, to]),
    { kind: 'audio', id: 't-A1', name: 'A1', enabled: true, bus: 'master', clips: [] },
  ];
  return p;
}

function idsOf(snap: { tracks: { clips: { id: string }[] }[] }, trackIndex = 0): string[] {
  return snap.tracks[trackIndex]!.clips.map((c) => c.id);
}

function fullActive(snap: { tracks: { clips: { id: string; active: boolean }[] }[] }): Record<string, boolean> {
  const out: Record<string, boolean> = {};
  for (const t of snap.tracks) for (const c of t.clips) out[c.id] = c.active;
  return out;
}

/* -------------------------------------------------------------------- z 序 */

describe('visualZ —— z 序 = 视觉轨数 − 1 − 视觉轨下标，只数视觉轨', () => {
  it('轨道列表顶部拿到最大 z（前景）', () => {
    const p = defaultProject('z');
    p.tracks = [visualTrack('V1', []), visualTrack('V2', []), visualTrack('V3', [])];
    expect(visualZ(p.tracks)).toEqual([2, 1, 0]);
  });

  it('音频轨是 null，且**不占**编号（不会把视觉轨的 z 顶出空洞）', () => {
    const p = defaultProject('z');
    p.tracks = [
      visualTrack('V1', []),
      { kind: 'audio', id: 'a', name: 'A1', enabled: true, bus: 'master', clips: [] },
      visualTrack('V2', []),
    ];
    expect(visualZ(p.tracks)).toEqual([1, null, 0]);
  });

  it('与 engine/stack.ts 的 z 是同一个数（两处口径不许各写一套）', () => {
    const p = transitionProject();
    const snap = buildSceneSnapshot(p, 0.5);
    // 只有一条视觉轨 → z 恒为 0；音频轨 null。
    expect(snap.tracks[0]!.z).toBe(0);
    expect(snap.tracks[1]!.z).toBeNull();
  });
});

/* ------------------------------------------------------------------ active */

describe('active —— t 时刻是否命中（含出画转场窗口的两侧）', () => {
  it('窗口外：只有自己 span 内的片段命中', () => {
    const p = transitionProject();
    expect(fullActive(buildSceneSnapshot(p, 1))).toEqual({ from: true, to: false });
    expect(fullActive(buildSceneSnapshot(p, 3))).toEqual({ from: false, to: true });
    expect(fullActive(buildSceneSnapshot(p, 5))).toEqual({ from: false, to: false });
  });

  it('窗口内两侧**都是** active（那一帧的画面由两张贴图共同决定）', () => {
    const p = transitionProject();
    // 窗口 [1.5, 2.5)
    expect(fullActive(buildSceneSnapshot(p, 1.6))).toEqual({ from: true, to: true });
    // 后半段 t=2.2 已越过 from.end —— 先做 span 过滤就会把它判成 false
    expect(fullActive(buildSceneSnapshot(p, 2.2))).toEqual({ from: true, to: true });
    // ⚠️ t 会被吸附到帧栅格（30fps ⇒ 1/30 秒）：2.49 吸附成 2.5，那是窗口末端。
    // 想落在窗口里有数据的那一格，就得给一个真的落得下的值。
    expect(fullActive(buildSceneSnapshot(p, 2.4))).toEqual({ from: true, to: true });
    // 半开：窗口末端回到「只有入画片段」
    expect(fullActive(buildSceneSnapshot(p, 2.5))).toEqual({ from: false, to: true });
  });

  it('留缝时转场退化为「淡到透明」：出画片段仍在窗口里（另一侧不 active）', () => {
    const p = transitionProject();
    (p.tracks[0] as VisualTrack).clips[1]!.start = 2.5;
    (p.tracks[0] as VisualTrack).clips[1]!.end = 4.5;
    expect(fullActive(buildSceneSnapshot(p, 2.2))).toEqual({ from: true, to: false });
  });

  it('音频片段按 span 命中（没有转场）', () => {
    const p = transitionProject();
    const a = p.tracks[1]!;
    if (a.kind !== 'audio') throw new Error('应为音频轨');
    a.clips.push({ kind: 'audio', id: 'a1', start: 1, end: 2, label: 'a', fadeSec: 0, curves: {}, assetId: 'x', srcIn: 0 });
    expect(fullActive(buildSceneSnapshot(p, 1.5))).toEqual({ from: true, to: true, a1: true });
    expect(fullActive(buildSceneSnapshot(p, 2.5))).toEqual({ from: false, to: true, a1: false });
  });
});

/* --------------------------------------------------------------- ids 裁剪 */

describe("detail: 'ids' —— 只给 id / kind / label / start / end", () => {
  it('片段上不多一个字段（长工程里先探路再细读）', () => {
    const p = transitionProject();
    const snap = buildSceneSnapshot(p, 1.6, 'ids');
    const clip = snap.tracks[0]!.clips[0]!;
    expect(Object.keys(clip).sort()).toEqual(['end', 'id', 'kind', 'label', 'start']);
    expect(idsOf(snap)).toEqual(['from', 'to']);
  });

  it('轨道上仍然给 z（那是探路时最需要的一条）', () => {
    const snap = buildSceneSnapshot(transitionProject(), 0, 'ids');
    expect(snap.tracks[0]!.z).toBe(0);
    expect(snap.tracks[1]!.z).toBeNull();
  });

  it('full 才有 active / 源 / 曲线', () => {
    const snap = buildSceneSnapshot(transitionProject(), 1.6, 'full');
    expect(snap.tracks[0]!.clips[0]!.active).toBe(true);
    expect(snap.tracks[0]!.clips[0]!.source).toEqual({ type: 'solid', color: '#ff0000' });
  });
});

/* ------------------------------------------------------- 形状与帧栅格吸附 */

describe('快照的形状', () => {
  it('只给「有键」的曲线（空曲线是常态，铺开它只烧上下文）', () => {
    const p = transitionProject();
    const clip = (p.tracks[0] as VisualTrack).clips[0]!;
    clip.curves.opacity = { keys: [{ t: 0, v: 1, interp: 'linear' }] };
    clip.curves['transform.x'] = { keys: [] };
    const snap = buildSceneSnapshot(p, 1, 'full');
    expect(Object.keys(snap.tracks[0]!.clips[0]!.curves ?? {})).toEqual(['opacity']);
  });

  it('t 吸附到帧栅格（反馈帧与导出帧必须是同一帧）', () => {
    const p = transitionProject();
    p.fps = 30;
    expect(snapToFrame(0.51, 30)).toBeCloseTo(15 / 30, 12);
    expect(buildSceneSnapshot(p, 0.51).t).toBeCloseTo(15 / 30, 12);
  });

  it('不动工程、不动 version（纯读接口无副作用）', () => {
    const p = transitionProject();
    const before = JSON.stringify(p);
    buildSceneSnapshot(p, 1.6);
    expect(JSON.stringify(p)).toBe(before);
  });
});

/* --------------------------------------------------------------- getClip */

describe('buildClipView', () => {
  it('按 id 取单个片段，带同一个 active 口径', () => {
    const p = transitionProject();
    expect(buildClipView(p, 'to', 2.2)?.active).toBe(true);
    expect(buildClipView(p, 'to', 1.0)?.active).toBe(false);
  });

  it('找不到时返回 null（探路时的正常结果，不是异常）', () => {
    expect(buildClipView(transitionProject(), 'nope', 1)).toBeNull();
  });
});

/* ------------------------------------------------------------- 键约定守卫 */

describe('快照不引入随机或环境依赖', () => {
  it('同一工程同一 t 两次构造逐字节相同', () => {
    const p = defaultProject('确定');
    p.tracks = [visualTrack('V1', [solidClip(newId(), 0, 2, 'a')])];
    const a = JSON.stringify(buildSceneSnapshot(p, 0.5));
    const b = JSON.stringify(buildSceneSnapshot(p, 0.5));
    expect(a).toBe(b);
  });
});

/* ----------------------------------------------------------- three 代码读回 */

describe('three 代码的读回', () => {
  function threeProject(code: string): Project {
    const p = defaultProject('three');
    p.tracks = [
      visualTrack('V1', [{ ...solidClip('t1', 0, 2, 'three'), source: { type: 'three', code } }]),
    ];
    return p;
  }

  it('不超过内联阈值时原样给 code', () => {
    const code = 'function create(THREE, ctx) { return {}; }';
    const src = buildSceneSnapshot(threeProject(code), 0).tracks[0]!.clips[0]!.source;
    if (src?.type !== 'three') throw new Error('应为 three 源');
    expect(src).toEqual({ type: 'three', code });
  });

  it('超过阈值只给 codeChars / codeLines（正文走 three_view）', () => {
    const code = 'x'.repeat(THREE_CODE_SCENE_INLINE_MAX + 1);
    const src = buildSceneSnapshot(threeProject(code), 0).tracks[0]!.clips[0]!.source;
    if (src?.type !== 'three') throw new Error('应为 three 源');
    expect(src).toMatchObject({ type: 'three', codeChars: code.length, codeLines: 1 });
    expect('code' in src).toBe(false);
  });
});
