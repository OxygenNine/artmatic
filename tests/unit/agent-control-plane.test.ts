/**
 * 控制平面的 M1 守卫（方案 §8）：**写进去、能撤销、错误码可判别**。
 *
 * 用得是**真的 `ProjectStore`**（不是替身）：这一层要守的恰恰是「写操作等值」——
 * 每个方法都落到 `ProjectStore` 的既有方法上，撤销栈的完整性是它的直接后果。
 * 拿替身测等于把被测对象换掉。
 *
 * 渲染 / 导出那两条（M2 / M4）在这里测不了：WebGL 与 WebCodecs 在 Node 里不存在，
 * 它们由 `tests/e2e/agent.spec.ts` 守。
 */

import { describe, expect, it } from 'vitest';
import { createControlPlane, type AgentControlPlane } from '../../src/agent/control-plane';
import { CONTROL_API_VERSION } from '../../src/agent/types';
import type { ControlContext, ControlResult } from '../../src/agent/types';
import { ProjectStore } from '../../src/core/project-store';
import { createBlankProject } from '../../src/core/demo-project';
import { createTypographyDocument } from '../../src/typography/document';
import { SCHEMA_VERSION, type Project } from '../../src/core/schema';

/* --------------------------------------------------------------- 测试台 */

interface Harness {
  store: ProjectStore;
  cp: AgentControlPlane;
  ctx: ControlContext;
}

function harness(
  project: Project = createBlankProject('agent-test'),
  extra: Partial<ControlContext> = {},
): Harness {
  const store = new ProjectStore(project);
  const ctx: ControlContext = {
    getStore: () => store,
    // 渲染 / 素材 / 音频在纯 Node 单测里都不存在 —— 这条测试只覆盖读与写。
    getRenderer: () => null,
    getAssets: () => null,
    getPlayT: () => 0,
    setPlayT: () => {},
    getAudioBuffer: () => null,
    listProjects: () => [],
    saveProject: async () => false,
    openProject: async () => false,
    cancelPendingGesture: () => {},
    refreshPreview: () => {},
    ...extra,
  };
  return { store, ctx, cp: createControlPlane(ctx) };
}

async function ok<T>(p: Promise<ControlResult<T>>): Promise<T> {
  const r = await p;
  if (!r.ok) throw new Error(`期望成功，实际失败：${r.error.code} / ${r.error.message}`);
  return r.data;
}

async function code<T>(p: Promise<ControlResult<T>>): Promise<string> {
  const r = await p;
  if (r.ok) throw new Error(`期望失败，实际成功：${JSON.stringify(r.data)}`);
  return r.error.code;
}

function visualTrackId(h: Harness): string {
  const t = h.store.project.tracks.find((x) => x.kind === 'visual');
  if (!t) throw new Error('空白工程应当有一条视觉轨');
  return t.id;
}

/* ------------------------------------------------------------ 读接口 */

describe('读接口', () => {
  it('describe 给出握手需要的全部字段', async () => {
    const h = harness();
    const d = await ok(h.cp.describe());
    expect(d.apiVersion).toBe(CONTROL_API_VERSION);
    // 不写死数字：这里守的是「握手报的是本构建支持的 schema 版本」，
    // 写死的话每次抬版本都要来改这条守卫，而不是它挡住了什么。
    expect(d.schemaVersion).toBe(SCHEMA_VERSION);
    expect(d.fps).toBe(h.store.project.fps);
    expect(d.resolution).toEqual(h.store.project.resolution);
  });

  it('clearThenDescribe：一份工程都没打开时，写操作给 no-project（而不是抛异常）', async () => {
    const h = harness();
    const bare: ControlContext = { ...h.ctx, getStore: () => null };
    const cp = createControlPlane(bare);
    expect(await code(cp.addTrack('visual'))).toBe('no-project');
    // 读接口也必须是同一个口径
    expect(await code(cp.getScene())).toBe('no-project');
    // 但「有没有工程」这类元信息不能因为没工程就报错
    const d = await ok(cp.describe());
    expect(d.fps).toBe(0);
  });

  it('getCapabilities 给出的是合法 id 的**唯一**来源', async () => {
    const h = harness();
    const caps = await ok(h.cp.getCapabilities());
    expect(caps.generators.length).toBeGreaterThan(10);
    expect(caps.effects.map((e) => e.id)).toContain('echo');
    expect(caps.transitions.length).toBeGreaterThan(100);
    expect(caps.blendModes).toContain('normal');
    expect(caps.curveModes).toEqual(['keyframe', 'impulse', 'follower']);
  });

  it('读接口不动 version、不动工程（纯读无副作用）', async () => {
    const h = harness();
    const v0 = h.store.version;
    const before = JSON.stringify(h.store.project);
    await h.cp.getScene();
    await h.cp.getCapabilities();
    await h.cp.undoState();
    await h.cp.exportState();
    expect(h.store.version).toBe(v0);
    expect(JSON.stringify(h.store.project)).toBe(before);
  });
});

/* ------------------------------------------------------------ 写 + 撤销 */

describe('写 → undo 回原状（M1 的核心验收）', () => {
  it('addClip 能被用户 Ctrl+Z 掉', async () => {
    const h = harness();
    const track = visualTrackId(h);
    const before = await ok(h.cp.getScene({ t: 0, detail: 'ids' }));

    const added = await ok(
      h.cp.addClip(track, { kind: 'algo', generator: 'mandelbrot', start: 0, end: 2, id: 'c1' }),
    );
    expect(added.clipId).toBe('c1');
    expect(await ok(h.cp.undoState())).toEqual({ canUndo: true, canRedo: false });

    const during = await ok(h.cp.getScene({ t: 0.5, detail: 'ids' }));
    expect(during.tracks[0]!.clips.map((c) => c.id)).toEqual(['c1']);

    expect(await ok(h.cp.undo())).toEqual({ changed: true });
    const after = await ok(h.cp.getScene({ t: 0, detail: 'ids' }));
    expect(JSON.stringify(after)).toBe(JSON.stringify(before));
  });

  it('redo 把它放回来', async () => {
    const h = harness();
    const track = visualTrackId(h);
    await h.cp.addClip(track, { kind: 'solid', color: '#123456', start: 0, end: 1, id: 'c1' });
    await h.cp.undo();
    expect(await ok(h.cp.redo())).toEqual({ changed: true });
    expect(h.store.findClip('c1')).not.toBeNull();
  });

  it('moveClip 是一笔撤销（live + settle 都在同一条记录里）', async () => {
    const h = harness();
    const track = visualTrackId(h);
    await h.cp.addClip(track, { kind: 'solid', color: '#111111', start: 0, end: 1, id: 'c1' });
    const recordsAfterAdd = h.store.canUndo();

    await ok(h.cp.moveClip('c1', track, 5));
    expect(h.store.findClip('c1')!.clip.start).toBeCloseTo(5, 9);
    // 只多了一条记录 —— 内部跑了 live + settle 两次直改，但它们不入栈
    expect(h.store.canUndo()).toBe(recordsAfterAdd);
    await ok(h.cp.undo());
    expect(h.store.findClip('c1')!.clip.start).toBeCloseTo(0, 9);
  });

  it('setCurve / setClipProps / 特效链 都入栈', async () => {
    const h = harness();
    const track = visualTrackId(h);
    await h.cp.addClip(track, { kind: 'algo', generator: 'mandelbrot', start: 0, end: 2, id: 'c1' });

    await ok(h.cp.setClipProps('c1', { label: '底图', opacity: 0.4 }));
    expect(h.store.findClip('c1')!.clip.label).toBe('底图');

    await ok(h.cp.setCurve('c1', 'opacity', { keys: [{ t: 0, v: 0, interp: 'linear' }, { t: 1, v: 1, interp: 'linear' }] }));
    expect(h.store.findClip('c1')!.clip.curves.opacity!.keys).toHaveLength(2);
    await ok(h.cp.setCurve('c1', 'opacity', null));
    expect(h.store.findClip('c1')!.clip.curves.opacity).toBeUndefined();

    await ok(h.cp.addEffectClip(track, { start: 0, end: 2, id: 'fx', chain: [{ defId: 'echo' }] }));
    const added = await ok(h.cp.addEffect('fx', 'slices', { count: 4 }));
    const fxClip = h.store.findClip('fx')!.clip;
    if (fxClip.kind !== 'effect') throw new Error('应为特效片段');
    expect(fxClip.chain.map((c) => c.defId)).toEqual(['echo', 'slices']);
    expect(fxClip.chain[1]!.instanceId).toBe(added.instanceId);
    // 默认值补齐了：agent 只给 count，其余参数也在
    expect(Object.keys(fxClip.chain[1]!.values).length).toBeGreaterThan(1);

    await ok(h.cp.reorderEffect('fx', 0, 1));
    const reordered = h.store.findClip('fx')!.clip;
    if (reordered.kind !== 'effect') throw new Error('应为特效片段');
    expect(reordered.chain.map((c) => c.defId)).toEqual(['slices', 'echo']);

    await ok(h.cp.removeEffect('fx', 0));
    const removed = h.store.findClip('fx')!.clip;
    if (removed.kind !== 'effect') throw new Error('应为特效片段');
    expect(removed.chain.map((c) => c.defId)).toEqual(['echo']);
  });

  it('beginTx / endTx 把整段包成**一笔**撤销', async () => {
    const h = harness();
    const track = visualTrackId(h);
    await ok(h.cp.beginTx());
    await ok(h.cp.addClip(track, { kind: 'solid', color: '#111111', start: 0, end: 1, id: 'a' }));
    await ok(h.cp.addClip(track, { kind: 'solid', color: '#222222', start: 1, end: 2, id: 'b' }));
    h.store.touch();
    expect(await ok(h.cp.endTx('agent: 两段'))).toEqual({ changed: true });
    await ok(h.cp.undo());
    expect(h.store.findClip('a')).toBeNull();
    expect(h.store.findClip('b')).toBeNull();
  });

  it('cancelTx 回滚到事务起点', async () => {
    const h = harness();
    const track = visualTrackId(h);
    await ok(h.cp.beginTx());
    await ok(h.cp.addClip(track, { kind: 'solid', color: '#111111', start: 0, end: 1, id: 'a' }));
    await ok(h.cp.cancelTx());
    expect(h.store.findClip('a')).toBeNull();
    expect(await code(h.cp.endTx('x'))).toBe('conflict');
  });

  it('事务没开时 endTx / 重复 beginTx 都是 conflict（不是崩）', async () => {
    const h = harness();
    expect(await code(h.cp.endTx('x'))).toBe('conflict');
    await ok(h.cp.beginTx());
    expect(await code(h.cp.beginTx())).toBe('conflict');
    await ok(h.cp.cancelTx());
  });

  it('loadScene 走 loadFrom（可撤销），不是 replaceProject（清栈）', async () => {
    const h = harness();
    const track = visualTrackId(h);
    await h.cp.addClip(track, { kind: 'solid', color: '#111111', start: 0, end: 1, id: 'c1' });

    const draft = createBlankProject('整体改写');
    draft.duration = 6;
    const dt = draft.tracks.find((t) => t.kind === 'visual')!;
    (dt.clips as unknown[]).push({
      kind: 'source',
      id: 'z1',
      start: 0,
      end: 3,
      label: 'z',
      fadeSec: 0,
      curves: {},
      source: { type: 'solid', color: '#00ff00' },
      blend: 'normal',
      opacity: 1,
      transform: { x: 0.5, y: 0.5, sx: 1, sy: 1, rot: 0 },
      fit: 'stretch',
    });
    await ok(h.cp.loadScene(draft));
    expect(h.store.project.name).toBe('整体改写');
    expect(h.store.findClip('z1')).not.toBeNull();
    expect(h.store.canUndo()).toBe(true);
    await ok(h.cp.undo());
    expect(h.store.project.name).toBe('agent-test');
    expect(h.store.findClip('c1')).not.toBeNull();
  });
});

/* ------------------------------------------------------------ 错误码 */

describe('错误码（agent 靠它决定下一步，不许只有一句字符串）', () => {
  it('找不到的 id 是 not-found，并带上合法值清单', async () => {
    const h = harness();
    const r = await h.cp.addClip(visualTrackId(h), {
      kind: 'algo',
      generator: '不存在的生成器',
      start: 0,
      end: 1,
    });
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error('应当失败');
    expect(r.error.code).toBe('not-found');
    expect((r.error.detail as { validIds: string[] }).validIds).toContain('mandelbrot');
  });

  it('未知参数键是 invalid-argument，并列出已知键', async () => {
    const h = harness();
    const track = visualTrackId(h);
    await h.cp.addClip(track, { kind: 'algo', generator: 'mandelbrot', start: 0, end: 2, id: 'c1' });
    const r = await h.cp.setClipSourceParams('c1', { 不存在的参数: 1 });
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error('应当失败');
    expect(r.error.code).toBe('invalid-argument');
    expect((r.error.detail as { known: string[] }).known.length).toBeGreaterThan(0);
  });

  it('reject 策略下非法落点整次不动（conflict），且不留下半成品', async () => {
    const h = harness();
    const track = visualTrackId(h);
    await h.cp.addClip(track, { kind: 'solid', color: '#111111', start: 0, end: 1, id: 'a' });
    await h.cp.addClip(track, { kind: 'solid', color: '#222222', start: 1, end: 2, id: 'b' });

    expect(await code(h.cp.moveClip('b', track, 0.5))).toBe('conflict');
    // 一动没动：几何、时长、撤销栈都不许被这次失败的移动改掉
    expect(h.store.findClip('b')!.clip.start).toBeCloseTo(1, 9);
    await h.cp.undo();
    expect(h.store.findClip('b')).toBeNull();
    expect(h.store.findClip('a')).not.toBeNull();
  });

  it('音频轨只装 audio 片段（判据只有 canHost 一条，拖拽与 Alt+↑↓ 共用）', async () => {
    const h = harness();
    const audio = h.store.project.tracks.find((t) => t.kind === 'audio')!.id;
    expect(
      await code(h.cp.addClip(audio, { kind: 'solid', color: '#111111', start: 0, end: 1, id: 's1' })),
    ).toBe('invalid-argument');
    // 视觉片段也跨不过去
    const visual = visualTrackId(h);
    await ok(h.cp.addClip(visual, { kind: 'solid', color: '#111111', start: 0, end: 1, id: 's2' }));
    expect(await code(h.cp.moveClip('s2', audio, 0))).toBe('invalid-argument');
  });

  it('image / video 的 assetId 必须在台账里（否则就是一张黑屏 + 零报错）', async () => {
    const h = harness();
    const track = visualTrackId(h);
    expect(
      await code(h.cp.addClip(track, { kind: 'image', assetId: '不存在', start: 0, end: 1 })),
    ).toBe('not-found');
    // 登记进 project.assets 之后就能加
    h.store.commit('登记素材', (p) => {
      p.assets['img1'] = { id: 'img1', kind: 'image', name: 'test' };
    });
    expect((await ok(h.cp.addClip(track, { kind: 'image', assetId: 'img1', start: 0, end: 1 }))).clipId).toBeTruthy();
  });

  it('落不了的转场是 unsupported，并给出原因（不是静默什么都不发生）', async () => {
    const h = harness();
    const track = visualTrackId(h);
    await h.cp.addClip(track, { kind: 'solid', color: '#111111', start: 0, end: 1, id: 'a' });
    // t=0 的入场转场：窗口左半没有地方可放 → too-short。
    const r = await h.cp.setTransition('a', 'fade', 0.5, undefined, 'in');
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error('应当失败');
    expect(r.error.code).toBe('unsupported');
    expect(r.error.detail).toEqual({ reason: 'too-short', side: 'in' });
  });

  it('没有邻片段也能设出场转场（另一侧视为全透明）', async () => {
    const h = harness();
    const track = visualTrackId(h);
    await h.cp.addClip(track, { kind: 'solid', color: '#111111', start: 0, end: 1, id: 'a' });
    expect(await ok(h.cp.setTransition('a', 'fade', 0.5))).toEqual({ changed: true, side: 'out' });
    const clip = h.store.findClip('a')!.clip;
    if (clip.kind !== 'source') throw new Error('应为 source');
    expect(clip.transitionOut?.defId).toBe('fade');
    expect(await ok(h.cp.clearTransition('a'))).toEqual({ changed: true });
  });

  it('相邻的两个 source 片段上转场能落地', async () => {
    const h = harness();
    const track = visualTrackId(h);
    await h.cp.addClip(track, { kind: 'solid', color: '#111111', start: 0, end: 2, id: 'a' });
    await h.cp.addClip(track, { kind: 'solid', color: '#222222', start: 2, end: 4, id: 'b' });
    expect(await ok(h.cp.setTransition('a', 'fade', 1))).toEqual({ changed: true, side: 'out' });
    const clip = h.store.findClip('a')!.clip;
    if (clip.kind !== 'source') throw new Error('应为 source');
    expect(clip.transitionOut!.defId).toBe('fade');
    // 场景里两侧都 active —— 与 core/transitions 的窗口一致
    const snap = await ok(h.cp.getScene({ t: 2.2, detail: 'full' }));
    // 快照的片段类型是 ids / full 两档的联合，`active` 只有 full 那档才有。
    const flags = Object.fromEntries(
      snap.tracks.flatMap((t) => t.clips.map((c) => [c.id, 'active' in c ? c.active : undefined])),
    );
    expect(flags).toEqual({ a: true, b: true });
    expect(await ok(h.cp.clearTransition('a'))).toEqual({ changed: true });
  });

  it('曲线形状不对是 invalid-argument（形状错会一路穿透到渲染期）', async () => {
    const h = harness();
    const track = visualTrackId(h);
    await h.cp.addClip(track, { kind: 'solid', color: '#111111', start: 0, end: 2, id: 'c1' });
    expect(
      await code(h.cp.setCurve('c1', 'opacity', { keys: [{ t: 1, v: 0, interp: 'linear' }, { t: 0, v: 1, interp: 'linear' }] })),
    ).toBe('invalid-argument');
    expect(await code(h.cp.setCurve('c1', 'nope', { keys: [] }))).toBe('invalid-argument');
  });

  it('不可写的字段被挡在 setClipProps 之外', async () => {
    const h = harness();
    const track = visualTrackId(h);
    await h.cp.addClip(track, { kind: 'solid', color: '#111111', start: 0, end: 2, id: 'c1' });
    expect(await code(h.cp.setClipProps('c1', { kind: 'effect' }))).toBe('invalid-argument');
    expect(await code(h.cp.setClipProps('c1', { id: 'other' }))).toBe('invalid-argument');
  });

  it('loadScene 收一份坏工程时给 invalid-argument（不把库改坏）', async () => {
    const h = harness();
    const before = JSON.stringify(h.store.project);
    expect(await code(h.cp.loadScene({ name: '没版本号' }))).toBe('invalid-argument');
    expect(await code(h.cp.loadScene({ schemaVersion: 999 }))).toBe('invalid-argument');
    expect(JSON.stringify(h.store.project)).toBe(before);
  });

  it('渲染类方法在渲染服务缺席时给 not-ready（不是 undefined 崩）', async () => {
    const h = harness();
    expect(await code(h.cp.renderFrame({ t: 0 }))).toBe('not-ready');
    expect(await code(h.cp.frameSignature({ t: 0 }))).toBe('not-ready');
    expect(await code(h.cp.snapshotPng({ t: 0 }))).toBe('not-ready');
    expect(await code(h.cp.export({ format: 'png' }))).toBe('not-ready');
  });

  it('保存不成时给 unsupported（而不是假装成功）', async () => {
    const h = harness();
    expect(await code(h.cp.saveProject())).toBe('unsupported');
  });
});

/* ---------------------------------------------------------- 结构不变量 */

describe('结构与不变量', () => {
  it('addClip 回传的是**落点之后**的几何（`addClip` 会把起点顺延到下一个空档）', async () => {
    const h = harness();
    const track = visualTrackId(h);
    await ok(h.cp.addClip(track, { kind: 'solid', color: '#111111', start: 0, end: 10, id: 'big' }));
    const shifted = await ok(
      h.cp.addClip(track, { kind: 'solid', color: '#222222', start: 0, end: 1, id: 'small' }),
    );
    // 起点被占 ⇒ 顺延到 big 的末尾（`addClip` 会加一个 1e-6 的避碰余量）。
    // 回传原始入参（0）就是撒谎。
    expect(shifted.start).toBeGreaterThan(9.999);
    expect(shifted.start).toBeLessThan(10.001);
    expect(h.store.findClip('small')!.clip.start).toBe(shifted.start);
  });

  it('splitClip 返回左右两段的 id，右半段按几何认回来', async () => {
    const h = harness();
    const track = visualTrackId(h);
    await h.cp.addClip(track, { kind: 'solid', color: '#111111', start: 0, end: 4, id: 'c1' });
    const split = await ok(h.cp.splitClip('c1', 2));
    expect(split.leftId).toBe('c1');
    expect(split.rightId).toBeTruthy();
    const placed = h.store.findClip(split.rightId!)!;
    expect(placed.clip.start).toBeCloseTo(2, 9);
    expect(placed.clip.end).toBeCloseTo(4, 9);
    expect(await code(h.cp.splitClip('c1', 99))).toBe('invalid-argument');
  });

  it('resizeClip 的 start 边会推进 srcIn（trim-in 的语义不许被绕过）', async () => {
    const h = harness();
    const track = visualTrackId(h);
    h.store.commit('登记视频', (p) => {
      p.assets['a'] = { id: 'a', kind: 'video', name: 'v' };
    });
    await ok(
      h.cp.addClip(track, {
        kind: 'video',
        assetId: 'a',
        srcIn: 0,
        speed: 2,
        start: 0,
        end: 4,
        id: 'v1',
      }),
    );
    await ok(h.cp.resizeClip('v1', 'start', 1));
    const clip = h.store.findClip('v1')!.clip;
    if (clip.kind !== 'source' || clip.source.type !== 'video') throw new Error('应为 video source');
    expect(clip.source.srcIn).toBeCloseTo(2, 9);
    expect(clip.end).toBeCloseTo(4, 9);
  });

  it('setProject 的每个字段都是独立的一笔（想一键撤销就用事务）', async () => {
    const h = harness();
    const changed = await ok(h.cp.setProject({ fps: 24, duration: 5 }));
    expect(changed.changed.sort()).toEqual(['duration', 'fps']);
    expect(h.store.project.fps).toBe(24);
    expect(h.store.project.duration).toBe(5);
    await ok(h.cp.undo());
    expect(h.store.project.duration).not.toBe(5);
  });

  it('moveTrack 改的是合成顺序（不是纯展示排序）', async () => {
    const h = harness();
    await h.cp.addTrack('visual', 'V2');
    expect(h.store.project.tracks.filter((t) => t.kind === 'visual')).toHaveLength(2);
    await ok(h.cp.moveTrack(0, 1));
    const snap = await ok(h.cp.getScene({ t: 0, detail: 'ids' }));
    expect(snap.tracks.map((t) => t.z)).toEqual([null, 1, 0]);
  });
});

/* ------------------------------------------ 曲线寻址 / 绑定片段（Agent 反馈 1、3） */

describe('曲线参数寻址', () => {
  /** 一个只含单个 blur 实例的特效片段。 */
  async function blurClip(h: Harness, start = 0, end = 2): Promise<string> {
    const r = await ok(h.cp.addEffectClip(visualTrackId(h), { start, end, chain: [{ defId: 'blur' }] }));
    return r.clipId;
  }

  it('唯一实例时可以用 defId 可读名，返回值回显规范键', async () => {
    const h = harness();
    const clipId = await blurClip(h);
    const r = await ok(
      h.cp.setCurve(clipId, 'blur.radius', { keys: [{ t: 0, v: 0 }, { t: 1, v: 12 }] } as never),
    );
    expect(r.changed).toBe(true);
    // 规范键 = `<instanceId>.radius`，而且回显出来（agent 不必再猜写成了什么）。
    expect(r.param.endsWith('.radius')).toBe(true);
    const { clip } = h.store.findClip(clipId)!;
    if (clip.kind !== 'effect') throw new Error('应为特效片段');
    expect(clip.curves[r.param]).toBeTruthy();
  });

  it('缺 interp 时按 smooth 落库（不再靠报错学这个字段）', async () => {
    const h = harness();
    const clipId = await blurClip(h);
    const r = await ok(h.cp.setCurve(clipId, 'blur.radius', { keys: [{ t: 0, v: 1 }, { t: 0.5, v: 9 }] } as never));
    const { clip } = h.store.findClip(clipId)!;
    if (clip.kind !== 'effect') throw new Error('应为特效片段');
    expect(clip.curves[r.param]!.keys.map((k) => k.interp)).toEqual(['smooth', 'smooth']);
  });

  it('同一 defId 有两个实例时报歧义，并列出候选（chainIndex + 完整 id）', async () => {
    const h = harness();
    const r = await ok(
      h.cp.addEffectClip(visualTrackId(h), {
        start: 0,
        end: 2,
        chain: [{ defId: 'blur' }, { defId: 'blur' }],
      }),
    );
    const res = await h.cp.setCurve(r.clipId, 'blur.radius', { keys: [{ t: 0, v: 1 }] } as never);
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error.code).toBe('invalid-argument');
    const candidates = (res.error.detail as { candidates: { chainIndex: number; instanceId: string }[] })
      .candidates;
    expect(candidates).toHaveLength(2);
    expect(candidates.map((c) => c.chainIndex)).toEqual([0, 1]);
    expect(candidates.every((c) => c.instanceId.length > 20)).toBe(true);
  });

  it('add_effect 返回完整 instanceId 与可直接用的 keyPrefix', async () => {
    const h = harness();
    const clipId = await blurClip(h);
    const added = await ok(h.cp.addEffect(clipId, 'blur'));
    // 完整 uuid（而不是截短的 fx-xxxxxxxx）：曲线键要原样拼得出来。
    expect(added.instanceId.length).toBeGreaterThan(20);
    expect(added.keyPrefix).toBe(`${added.instanceId}.`);
    expect(added.chainIndex).toBe(1);
    const r = await ok(h.cp.setCurve(clipId, `${added.keyPrefix}radius`, { keys: [{ t: 0, v: 3 }] } as never));
    expect(r.param).toBe(`${added.instanceId}.radius`);
  });
});

describe('绑定片段（boundClipId）', () => {
  it('可以绑到一个 source 片段，写进工程里', async () => {
    const h = harness();
    const track = visualTrackId(h);
    const src = await ok(h.cp.addClip(track, { kind: 'solid', start: 0, end: 2 }));
    const fx = await ok(
      h.cp.addEffectClip(track, { start: 0, end: 1, chain: [{ defId: 'blur' }], boundClipId: src.clipId }),
    );
    const { clip } = h.store.findClip(fx.clipId)!;
    if (clip.kind !== 'effect') throw new Error('应为特效片段');
    expect(clip.boundClipId).toBe(src.clipId);
  });

  it('与影响深度互斥；目标必须是存在的 source 片段', async () => {
    const h = harness();
    const track = visualTrackId(h);
    const src = await ok(h.cp.addClip(track, { kind: 'solid', start: 0, end: 2 }));
    expect(
      await code(
        h.cp.addEffectClip(track, {
          start: 3,
          end: 4,
          chain: [{ defId: 'blur' }],
          boundClipId: src.clipId,
          affectDepth: 1,
        }),
      ),
    ).toBe('invalid-argument');
    expect(await code(h.cp.addEffectClip(track, { start: 3, end: 4, chain: [], boundClipId: 'nope' }))).toBe(
      'not-found',
    );
    // 绑到另一条特效片段上不算「一层」—— 只接受 source。
    const fx = await ok(h.cp.addEffectClip(track, { start: 5, end: 6, chain: [{ defId: 'blur' }] }));
    expect(await code(h.cp.addEffectClip(track, { start: 7, end: 8, chain: [], boundClipId: fx.clipId }))).toBe(
      'invalid-argument',
    );
  });

  it('set_clip_props 可以解绑（null），解绑后 affectDepth 不再残留', async () => {
    const h = harness();
    const track = visualTrackId(h);
    const src = await ok(h.cp.addClip(track, { kind: 'solid', start: 0, end: 2 }));
    const fx = await ok(
      h.cp.addEffectClip(track, { start: 0, end: 1, chain: [{ defId: 'blur' }], boundClipId: src.clipId }),
    );
    const applied = await ok(h.cp.setClipProps(fx.clipId, { boundClipId: null }));
    expect(applied.applied.boundClipId).toBeNull();
    const { clip } = h.store.findClip(fx.clipId)!;
    if (clip.kind !== 'effect') throw new Error('应为特效片段');
    expect(clip.boundClipId).toBeUndefined();
    expect(clip.affectDepth).toBeUndefined();
  });
});

/* ------------------------------------- P1：段落 / 视觉字段 / 特效开关 / 换生成器 */

describe('段落标记（edit_sections）', () => {
  it('add / split / rename / move / remove，每一步一笔撤销', async () => {
    const h = harness();
    await ok(h.cp.setProject({ duration: 8 }));
    const added = await ok(h.cp.editSections({ op: 'add', start: 2, name: '副歌' }));
    expect(added.sections.map((s) => s.name)).toEqual(['副歌']);
    const id = added.sections[0]!.id;

    // 只有一段时，它的结尾 = 工程末尾（8s）；在 4s 处切 → 两段
    const split = await ok(h.cp.editSections({ op: 'split', sectionId: id, at: 4 }));
    expect(split.sections.map((s) => s.start)).toEqual([2, 4]);

    const renamed = await ok(h.cp.editSections({ op: 'rename', sectionId: id, name: '主歌' }));
    expect(renamed.sections[0]!.name).toBe('主歌');

    const moved = await ok(h.cp.editSections({ op: 'move', sectionId: id, start: 0 }));
    expect(moved.sections.map((s) => s.start)).toEqual([0, 4]);

    const removed = await ok(h.cp.editSections({ op: 'remove', sectionId: id }));
    expect(removed.sections).toHaveLength(1);

    // 每一步都是一笔：撤销一次回到「两段」。
    expect(h.store.undo()).toBe(true);
    expect(h.store.project.sections).toHaveLength(2);
  });

  it('切不动 / 段落不存在都是可判别错误，且不改工程', async () => {
    const h = harness();
    await ok(h.cp.setProject({ duration: 4 }));
    const added = await ok(h.cp.editSections({ op: 'add', start: 0 }));
    const id = added.sections[0]!.id;
    const before = JSON.stringify(h.store.project.sections);

    expect(await code(h.cp.editSections({ op: 'split', sectionId: id, at: 0.001 }))).toBe('invalid-argument');
    expect(await code(h.cp.editSections({ op: 'rename', sectionId: 'nope', name: 'x' }))).toBe('not-found');
    expect(await code(h.cp.editSections({ op: 'add', start: Number.NaN }))).toBe('invalid-argument');
    expect(JSON.stringify(h.store.project.sections)).toBe(before);
  });
});

/**
 * 轨道静音（v15）。语义与 UI 的喇叭按钮完全一致：**只关内嵌音轨，画面照常**。
 * 音频轨不接受 muted —— 它的 `enabled` 已经是喇叭，两套开关只会让人误判。
 */
describe('轨道静音（set_track.muted）', () => {
  it('视觉轨可静音：回显 true，enabled 与名字都不动', async () => {
    const h = harness();
    const track = visualTrackId(h);
    const r = await ok(h.cp.setTrack(track, { muted: true }));
    expect(r.muted).toBe(true);
    expect(r.enabled).toBe(true);
    const t = h.store.track(track)!;
    expect(t.kind === 'visual' && t.muted).toBe(true);
    // 回到有声
    const back = await ok(h.cp.setTrack(track, { muted: false }));
    expect(back.muted).toBe(false);
    expect('muted' in h.store.track(track)!).toBe(false);
  });

  it('音频轨拒绝 muted（两个开关描述同一件事会更糟）', async () => {
    const h = harness();
    const audio = h.store.addTrack('audio');
    expect(await code(h.cp.setTrack(audio, { muted: true }))).toBe('invalid-argument');
    // 音频轨关声音走 enabled，回显里 muted 明确是 null（这条轨没有这个概念）
    const r = await ok(h.cp.setTrack(audio, { enabled: false }));
    expect(r.enabled).toBe(false);
    expect(r.muted).toBeNull();
  });
});

describe('片段视觉字段（set_clip_props 补齐）', () => {
  /** 造一条音频片段：`add_clip` 不支持 audio（素材导入不在 Agent 职责内）。 */
  function audioClip(h: Harness, end = 4): string {
    const trackId = h.store.addTrack('audio');
    const clipId = `aud-${end}`;
    h.store.addClip(trackId, {
      kind: 'audio',
      id: clipId,
      assetId: 'a1',
      srcIn: 0,
      start: 0,
      end,
      label: 'a',
      fadeSec: 0,
      curves: {},
    });
    return clipId;
  }

  it('音频 fadeIn / fadeOut 一次写入、互相钳制、只留一笔撤销', async () => {
    const h = harness();
    const clipId = audioClip(h, 4);
    const r = await ok(h.cp.setClipProps(clipId, { fadeIn: 3, fadeOut: 3 }));
    // 4 秒的片段：先写 in=3（out 还是 0），再写 out 只剩 1 秒。
    expect(r.applied.fadeIn).toBe(3);
    expect(r.applied.fadeOut).toBe(1);

    expect(h.store.undo()).toBe(true);
    const { clip } = h.store.findClip(clipId)!;
    if (clip.kind !== 'audio') throw new Error('应为音频片段');
    expect(clip.fadeIn ?? 0).toBe(0);
    expect(clip.fadeOut ?? 0).toBe(0);
  });

  it('fadeIn 写在画面片段上是可判别的错误（不是静默忽略）', async () => {
    const h = harness();
    const solid = await ok(h.cp.addClip(visualTrackId(h), { kind: 'solid', color: '#000000', start: 0, end: 1 }));
    expect(await code(h.cp.setClipProps(solid.clipId, { fadeIn: 1 }))).toBe('invalid-argument');
  });

  it('crop / quad 可写可清；退化的四角被拒绝', async () => {
    const h = harness();
    const solid = await ok(h.cp.addClip(visualTrackId(h), { kind: 'solid', color: '#000000', start: 0, end: 1 }));
    const r = await ok(
      h.cp.setClipProps(solid.clipId, {
        crop: { left: 0.2, right: 0.2 },
        quad: { tl: [0.1, 0], tr: [1, 0], br: [1, 1], bl: [0, 1] },
      }),
    );
    expect((r.applied.crop as { left: number }).left).toBeCloseTo(0.2, 6);
    expect((r.applied.quad as { tl: number[] }).tl).toEqual([0.1, 0]);

    const cleared = await ok(h.cp.setClipProps(solid.clipId, { crop: null, quad: null }));
    expect(cleared.applied.crop).toBeNull();
    expect(cleared.applied.quad).toBeNull();

    // 四点共线 = 退化：透视矩阵无解，画面上是「整层消失」。
    expect(
      await code(h.cp.setClipProps(solid.clipId, { quad: { tl: [0, 0], tr: [1, 1], br: [0, 0], bl: [1, 1] } })),
    ).toBe('invalid-argument');
  });

  it('视频片段能改 srcIn（源内偏移），音频也能', async () => {
    const h = harness();
    h.store.commit('登记视频', (p) => {
      p.assets['v1'] = { id: 'v1', kind: 'video', name: 'v' };
    });
    const video = await ok(
      h.cp.addClip(visualTrackId(h), { kind: 'video', assetId: 'v1', srcIn: 0, start: 0, end: 2 }),
    );
    const r = await ok(h.cp.setClipProps(video.clipId, { srcIn: 1.5 }));
    expect(r.applied.srcIn).toBe(1.5);

    const audioId = audioClip(h, 2);
    expect((await ok(h.cp.setClipProps(audioId, { srcIn: 0.5 }))).applied.srcIn).toBe(0.5);
  });

  it('speed：只用于视频、保持片段长度；倒放只能走曲线', async () => {
    const h = harness();
    h.store.commit('登记视频', (p) => {
      p.assets['v1'] = { id: 'v1', kind: 'video', name: 'v', durationSec: 60 };
    });
    const video = await ok(
      h.cp.addClip(visualTrackId(h), { kind: 'video', assetId: 'v1', srcIn: 0, start: 1, end: 5 }),
    );
    const r = await ok(h.cp.setClipProps(video.clipId, { speed: 2 }));
    expect(r.applied.speed).toBe(2);
    // 保持长度：回执里带着（可能被素材不足缩短的）终点
    expect(r.applied.end).toBe(5);

    // 静态速度必须为正 —— 倒放走 set_curve 的 speed
    expect(await code(h.cp.setClipProps(video.clipId, { speed: -1 }))).toBe('invalid-argument');

    await ok(
      h.cp.setCurve(video.clipId, 'speed', {
        keys: [
          { t: 0, v: 2, interp: 'linear' },
          { t: 2, v: -1, interp: 'linear' },
        ],
      }),
    );
    const curved = h.store.findClip(video.clipId)!.clip;
    expect(curved.curves.speed?.keys[1]?.v).toBe(-1);

    // 写常速会清掉曲线（否则「改了速度但画面没变」——静默无效）
    await ok(h.cp.setClipProps(video.clipId, { speed: 1 }));
    expect(h.store.findClip(video.clipId)!.clip.curves.speed).toBeUndefined();
  });

  it('speed 只用于视频：纯色片段报 invalid-argument', async () => {
    const h = harness();
    const solid = await ok(h.cp.addClip(visualTrackId(h), { kind: 'solid', color: '#111111', start: 0, end: 1 }));
    expect(await code(h.cp.setClipProps(solid.clipId, { speed: 2 }))).toBe('invalid-argument');
  });

  it('key 只用于图片 / 视频，且能局部改参数、能关掉', async () => {
    const h = harness();
    h.store.commit('登记图片', (p) => {
      p.assets['img1'] = { id: 'img1', kind: 'image', name: 'i' };
    });
    const img = await ok(h.cp.addClip(visualTrackId(h), { kind: 'image', assetId: 'img1', start: 0, end: 1 }));
    const r = await ok(h.cp.setClipProps(img.clipId, { key: { color: '#00ff00', tolerance: 0.3 } }));
    expect((r.applied.key as { color: string }).color).toBe('#00ff00');
    // 局部改：只给 spill，颜色 / 容差沿用
    const partial = await ok(h.cp.setClipProps(img.clipId, { key: { spill: 0.9 } }));
    expect((partial.applied.key as { color: string; spill: number }).color).toBe('#00ff00');
    expect((partial.applied.key as { spill: number }).spill).toBeCloseTo(0.9, 6);
    expect((await ok(h.cp.setClipProps(img.clipId, { key: null }))).applied.key).toBeNull();

    const algo = await ok(
      h.cp.addClip(visualTrackId(h), { kind: 'algo', generator: 'mandelbrot', start: 2, end: 3 }),
    );
    expect(await code(h.cp.setClipProps(algo.clipId, { key: { color: '#00ff00' } }))).toBe('invalid-argument');
  });
});

describe('特效实例开关（enabled）', () => {
  it('set_params 可以只开关；只给参数时开关不变；都不给是错误', async () => {
    const h = harness();
    const track = visualTrackId(h);
    const fx = await ok(h.cp.addEffectClip(track, { start: 0, end: 1, chain: [{ defId: 'blur' }] }));

    const off = await ok(h.cp.setEffectParams(fx.clipId, 0, undefined, false));
    expect(off.enabled).toBe(false);

    const caps = await ok(h.cp.getCapabilities({ detail: 'params', ids: ['blur'] }));
    const paramKey = caps.effects[0]!.params![0]!.key;
    const tuned = await ok(h.cp.setEffectParams(fx.clipId, 0, { [paramKey]: 1 } as never, undefined));
    expect(tuned.enabled).toBe(false);
    expect(tuned.values[paramKey]).toBe(1);

    expect(await code(h.cp.setEffectParams(fx.clipId, 0))).toBe('invalid-argument');
  });

  it('add_effect 可以直接建成停用', async () => {
    const h = harness();
    const fx = await ok(h.cp.addEffectClip(visualTrackId(h), { start: 0, end: 1, chain: [] }));
    const added = await ok(h.cp.addEffect(fx.clipId, 'blur', {}, undefined, false));
    expect(added.enabled).toBe(false);
    const { clip } = h.store.findClip(fx.clipId)!;
    if (clip.kind !== 'effect') throw new Error('应为特效片段');
    expect(clip.chain[added.chainIndex]!.enabled).toBe(false);
  });
});

describe('外部蒙版（set_params 的 mask）', () => {
  it('接上 / 摘掉 / 读回形状一致', async () => {
    const h = harness();
    const track = visualTrackId(h);
    const src = await ok(h.cp.addClip(track, { kind: 'solid', start: 0, end: 2 }));
    const fx = await ok(
      h.cp.addEffectClip(track, { start: 0, end: 2, chain: [{ defId: 'grade-qualifier' }] }),
    );

    const bound = await ok(
      h.cp.setEffectParams(fx.clipId, 0, undefined, undefined, {
        kind: 'clip',
        clipId: src.clipId,
        channel: 'alpha',
      }),
    );
    expect(bound.mask).toEqual({ kind: 'clip', clipId: src.clipId, channel: 'alpha' });

    // 读回：片段详情里必须能原样看到它（写入端与读出端同构）。
    const view = await ok(h.cp.getClip(fx.clipId));
    const inst = (view as { chain?: { mask?: unknown }[] }).chain?.[0];
    expect(inst?.mask).toEqual({ kind: 'clip', clipId: src.clipId, channel: 'alpha' });

    const cleared = await ok(h.cp.setEffectParams(fx.clipId, 0, undefined, undefined, null));
    expect(cleared.mask).toBeNull();
  });

  it('没声明 mask 的特效也接受（缺省 composite 模式在链上混回）', async () => {
    const h = harness();
    const track = visualTrackId(h);
    const src = await ok(h.cp.addClip(track, { kind: 'solid', start: 0, end: 2 }));
    const fx = await ok(h.cp.addEffectClip(track, { start: 0, end: 2, chain: [{ defId: 'blur' }] }));
    const bound = await ok(
      h.cp.setEffectParams(fx.clipId, 0, undefined, undefined, {
        kind: 'clip',
        clipId: src.clipId,
        channel: 'luma',
      }),
    );
    expect(bound.mask).toEqual({ kind: 'clip', clipId: src.clipId, channel: 'luma' });
    const caps = await ok(h.cp.getCapabilities({ detail: 'params', ids: ['blur'] }));
    expect(caps.effects[0]!.flags?.mask).toBe('composite');
  });

  it('成环的引用返回 conflict，工程不变', async () => {
    const h = harness();
    const track = visualTrackId(h);
    const src = await ok(h.cp.addClip(track, { kind: 'solid', start: 0, end: 2 }));
    const fx = await ok(
      h.cp.addEffectClip(track, {
        start: 0,
        end: 2,
        chain: [{ defId: 'grade-qualifier' }],
        boundClipId: src.clipId,
      }),
    );
    const version = h.store.version;
    expect(
      await code(
        h.cp.setEffectParams(fx.clipId, 0, undefined, undefined, {
          kind: 'clip',
          clipId: src.clipId,
          channel: 'luma',
        }),
      ),
    ).toBe('conflict');
    expect(h.store.version).toBe(version);
  });

  it('能力清单把「吃不吃蒙版」说出口', async () => {
    const h = harness();
    const caps = await ok(h.cp.getCapabilities({ detail: 'params', ids: ['grade-qualifier'] }));
    // 它把蒙版当自己的输入（键 × 蒙版），不是链上混回。
    expect(caps.effects[0]!.flags?.mask).toBe('input');
    expect(caps.features.mask.channels).toEqual(['luma', 'alpha', 'r', 'g', 'b']);
  });
});

describe('换算法生成器（set_generator）', () => {
  it('参数重置为新生成器的默认值，旧参数曲线被删、其它曲线保留', async () => {
    const h = harness();
    const caps = await ok(h.cp.getCapabilities({ detail: 'params' }));
    const a = caps.generators[0]!;
    const b = caps.generators[1]!;
    const oldKey = a.params![0]!.key;
    expect(a.id).not.toBe(b.id);

    const clip = await ok(
      h.cp.addClip(visualTrackId(h), { kind: 'algo', generator: a.id, start: 0, end: 2 }),
    );
    // 手动种两条曲线：旧生成器的参数 + 通用 opacity
    h.store.updateClip(clip.clipId, 'test', (c) => {
      if (c.kind !== 'source' || c.source.type !== 'algo') return;
      c.curves[oldKey] = { mode: 'keyframe', keys: [{ t: 0, v: 0 }] } as never;
      c.curves.opacity = { mode: 'keyframe', keys: [{ t: 0, v: 1 }] } as never;
    });

    const next = await ok(h.cp.setGenerator(clip.clipId, b.id, {}));
    expect(next.generator).toBe(b.id);
    // 新生成器的默认值全部落库（不是只留给定的那几个）
    expect(Object.keys(next.params).sort()).toEqual(b.params!.map((p) => p.key).sort());

    const after = h.store.findClip(clip.clipId)!;
    if (after.clip.kind !== 'source' || after.clip.source.type !== 'algo') throw new Error('应为算法片段');
    expect(after.clip.source.generator).toBe(b.id);
    expect(after.clip.curves[oldKey]).toBeUndefined();
    expect(after.clip.curves.opacity).toBeDefined();
  });

  it('非算法片段 / 不存在的生成器都是可判别错误', async () => {
    const h = harness();
    const track = visualTrackId(h);
    const solid = await ok(h.cp.addClip(track, { kind: 'solid', start: 0, end: 1 }));
    expect(await code(h.cp.setGenerator(solid.clipId, 'mandelbrot'))).toBe('unsupported');
    const algo = await ok(h.cp.addClip(track, { kind: 'algo', generator: 'mandelbrot', start: 1, end: 2 }));
    expect(await code(h.cp.setGenerator(algo.clipId, 'definitely-not-a-generator'))).toBe('not-found');
  });
});

/* ------------------------------------------------ P2：画幅 / 组框 / 主题 / 排序 */

/** 造一个带一份 800×600 空文档的文本片段。 */
async function textClip(h: Harness): Promise<string> {
  const clip = await ok(
    h.cp.addClip(visualTrackId(h), {
      kind: 'text',
      start: 0,
      end: 2,
      doc: createTypographyDocument({ w: 800, h: 600 }),
    }),
  );
  return clip.clipId;
}

describe('画幅（typo_set_canvas_size）', () => {
  it('不缩放 = 只改画布；缩放 = 元素框跟着比例走', async () => {
    const h = harness();
    const clipId = await textClip(h);
    const added = await ok(
      h.cp.addTypographyElements(clipId, [
        { kind: 'shape', shape: 'rect', frame: { x: 100, y: 50, w: 200, h: 100 } },
      ]),
    );
    const elementId = added.elementIds[0]!;

    // 只改画布：元素留在原像素位置
    const plain = await ok(h.cp.setTypographyCanvasSize(clipId, { w: 400, h: 300 }, false));
    expect(plain.size).toEqual({ w: 400, h: 300 });
    let frame = (await ok(h.cp.getTypographyDoc(clipId, 'full')) as unknown as {
      elements: { frame: { x: number; w: number } }[];
    }).elements[0]!.frame;
    expect(frame).toMatchObject({ x: 100, y: 50, w: 200, h: 100 });
    void elementId;

    // 4:3 → 8:6：宽高各 ×2，元素一起放大（这才叫换画幅）
    const scaled = await ok(h.cp.setTypographyCanvasSize(clipId, { w: 800, h: 600 }, true));
    expect(scaled.size).toEqual({ w: 800, h: 600 });
    frame = (await ok(h.cp.getTypographyDoc(clipId, 'full')) as unknown as {
      elements: { frame: { x: number; w: number } }[];
    }).elements[0]!.frame;
    expect(frame).toMatchObject({ x: 200, y: 100, w: 400, h: 200 });
  });

  it('非法尺寸在改动之前报错', async () => {
    const h = harness();
    const clipId = await textClip(h);
    const before = JSON.stringify(h.store.project);
    expect(await code(h.cp.setTypographyCanvasSize(clipId, { w: 1, h: 300 }, false))).toBe('invalid-argument');
    expect(await code(h.cp.setTypographyCanvasSize(clipId, { w: Number.NaN, h: 300 }, false))).toBe(
      'invalid-argument',
    );
    expect(JSON.stringify(h.store.project)).toBe(before);
  });
});

describe('分组底板（typo_update_group）', () => {
  it('成组后能改名字 / 填充 / 边框 / 圆角 / 内边距，并读得回来', async () => {
    const h = harness();
    const clipId = await textClip(h);
    const added = await ok(
      h.cp.addTypographyElements(clipId, [
        { kind: 'shape', shape: 'rect', frame: { x: 10, y: 10, w: 100, h: 50 } },
        { kind: 'shape', shape: 'rect', frame: { x: 130, y: 10, w: 100, h: 50 } },
      ]),
    );
    const grouped = await ok(h.cp.groupTypographyElements(clipId, added.elementIds, 'G'));
    const groupId = grouped.groupId!;

    const r = await ok(
      h.cp.updateTypographyGroup(clipId, groupId, {
        name: '卡片',
        fill: { kind: 'solid', color: '#123456' },
        stroke: { color: '#ffffff', width: 2, style: 'solid' },
        radius: 8,
        padding: 12,
      }),
    );
    expect(r.changed).toBe(true);
    expect(r.group).toMatchObject({ name: '卡片', radius: 8, padding: 12 });

    const view = (await ok(h.cp.getTypographyDoc(clipId, 'full')) as unknown as {
      groups: { id: string; name: string; fill: { kind: string; color?: string }; stroke: unknown }[];
    }).groups;
    const g = view.find((x) => x.id === groupId)!;
    expect(g.name).toBe('卡片');
    expect(g.fill).toMatchObject({ kind: 'solid', color: '#123456' });
    expect(g.stroke).toMatchObject({ color: '#ffffff', width: 2 });

    // null = 去掉边框
    const cleared = await ok(h.cp.updateTypographyGroup(clipId, groupId, { stroke: null }));
    expect(cleared.group.stroke).toBeNull();
  });

  it('坏填充 / 不存在的组合都是可判别错误，且不改工程', async () => {
    const h = harness();
    const clipId = await textClip(h);
    const added = await ok(
      h.cp.addTypographyElements(clipId, [
        { kind: 'shape', shape: 'rect', frame: { x: 10, y: 10, w: 50, h: 50 } },
        { kind: 'shape', shape: 'rect', frame: { x: 80, y: 10, w: 50, h: 50 } },
      ]),
    );
    const grouped = await ok(h.cp.groupTypographyElements(clipId, added.elementIds, 'G'));
    const before = JSON.stringify(h.store.project);
    expect(
      await code(h.cp.updateTypographyGroup(clipId, grouped.groupId!, { fill: { kind: 'wat' } })),
    ).toBe('invalid-argument');
    expect(await code(h.cp.updateTypographyGroup(clipId, 'nope', { radius: 4 }))).toBe('not-found');
    expect(JSON.stringify(h.store.project)).toBe(before);
  });
});

describe('自定义配色方案（typo_save_theme / remove / set scope）', () => {
  it('以 base 为底局部改槽 → 新方案立即生效；可再按 id 更新', async () => {
    const h = harness();
    const clipId = await textClip(h);
    const saved = await ok(
      h.cp.saveTypographyTheme(clipId, {
        base: 'office',
        name: '暗色',
        colors: { dk1: '#0b0b0f', accent1: '#ff8a00' },
      }),
    );
    expect(saved.theme.name).toBe('暗色');
    expect(saved.theme.colors.dk1).toBe('#0b0b0f');
    expect(saved.theme.colors.accent1).toBe('#ff8a00');
    // 没给的槽沿用 base
    expect(saved.theme.colors.accent2).toBeTruthy();
    expect(h.store.project.customThemes?.length).toBe(1);
    expect((h.store.project.tracks[0]!.clips[0] as never as { source: { doc: { theme?: string } } }).source.doc.theme).toBe(
      saved.theme.id,
    );

    // 按 id 再改一个槽：其余槽保留
    const updated = await ok(
      h.cp.saveTypographyTheme(clipId, { id: saved.theme.id, colors: { accent1: '#00ff00' } }),
    );
    expect(updated.theme.id).toBe(saved.theme.id);
    expect(updated.theme.name).toBe('暗色');
    expect(updated.theme.colors.accent1).toBe('#00ff00');
    expect(updated.theme.colors.dk1).toBe('#0b0b0f');
    expect(h.store.project.customThemes?.length).toBe(1);
  });

  it('scope:project 一次写到全工程；删除方案会抹掉所有引用', async () => {
    const h = harness();
    const clipA = await textClip(h);
    // 第二条文本文档（同一轨，时间上不重叠）
    const clipB = await ok(
      h.cp.addClip(visualTrackId(h), {
        kind: 'text',
        start: 3,
        end: 5,
        doc: createTypographyDocument({ w: 800, h: 600 }),
      }),
    );
    const saved = await ok(h.cp.saveTypographyTheme(clipA, { base: 'office', name: 'X', colors: {} }));
    const applied = await ok(h.cp.setTypographyTheme(clipA, saved.theme.id, 'project'));
    expect(applied.scope).toBe('project');
    expect(h.store.project.typographyTheme).toBe(saved.theme.id);

    const docs = (): (string | undefined)[] => {
      const out: (string | undefined)[] = [];
      for (const track of h.store.project.tracks) {
        for (const c of track.clips) {
          if (c.kind === 'source' && c.source.type === 'text') out.push(c.source.doc.theme);
        }
      }
      return out;
    };
    expect(docs()).toEqual([saved.theme.id, saved.theme.id]);
    void clipB;

    const removed = await ok(h.cp.removeTypographyTheme(saved.theme.id));
    expect(removed.clearedDocs).toBe(2);
    expect(h.store.project.customThemes ?? []).toEqual([]);
    expect(h.store.project.typographyTheme).toBeUndefined();
    expect(docs()).toEqual([undefined, undefined]);
  });

  it('未知方案 / 非法色值 / 删内置方案都是可判别错误', async () => {
    const h = harness();
    const clipId = await textClip(h);
    expect(await code(h.cp.setTypographyTheme(clipId, 'nope'))).toBe('not-found');
    expect(
      await code(h.cp.saveTypographyTheme(clipId, { base: 'office', colors: { accent1: 'red-ish' } })),
    ).toBe('invalid-argument');
    expect(
      await code(h.cp.saveTypographyTheme(clipId, { base: 'office', colors: { primary: '#ff0000' } })),
    ).toBe('invalid-argument');
    expect(await code(h.cp.removeTypographyTheme('office'))).toBe('not-found');
  });
});

describe('排版图片的抠图 / 四角', () => {
  it('key / quad 可写可清，整份替换也能搬过去', async () => {
    const h = harness();
    h.store.commit('登记图片', (p) => {
      p.assets['img1'] = { id: 'img1', kind: 'image', name: 'i' };
    });
    const clipId = await textClip(h);
    const added = await ok(
      h.cp.addTypographyElements(clipId, [
        { kind: 'image', assetId: 'img1', frame: { x: 10, y: 10, w: 200, h: 100 } },
      ]),
    );
    const elementId = added.elementIds[0]!;

    const r = await ok(
      h.cp.updateTypographyElement(clipId, elementId, {
        key: { color: '#00ff00', tolerance: 0.3 },
        quad: { tl: [0, 0], tr: [1, 0], br: [1, 1], bl: [0, 1] },
      }),
    );
    expect(r.element.key).toMatchObject({ color: '#00ff00' });
    expect(r.element.quad).toMatchObject({ tl: [0, 0] });

    // 读回来的文档整份写回：key / quad 不能丢（droppedKeys 也不该报它们）
    const before = (await ok(h.cp.getTypographyDoc(clipId, 'full'))) as never as Record<string, unknown>;
    const replaced = await ok(h.cp.replaceTypographyDoc(clipId, before));
    expect(replaced.droppedKeys).toEqual([]);
    const after = (await ok(h.cp.getTypographyDoc(clipId, 'full'))) as unknown as {
      elements: { key?: { color: string }; quad?: unknown }[];
    };
    expect(after.elements[0]!.key?.color).toBe('#00ff00');
    expect(after.elements[0]!.quad).toBeTruthy();

    const cleared = await ok(h.cp.updateTypographyElement(clipId, elementId, { key: null, quad: null }));
    expect(cleared.element.key).toBeUndefined();
    expect(cleared.element.quad).toBeUndefined();
  });

  it('退化四角被拒绝（渲染出来什么都没有）', async () => {
    const h = harness();
    h.store.commit('登记图片', (p) => {
      p.assets['img1'] = { id: 'img1', kind: 'image', name: 'i' };
    });
    const clipId = await textClip(h);
    const added = await ok(
      h.cp.addTypographyElements(clipId, [
        { kind: 'image', assetId: 'img1', frame: { x: 10, y: 10, w: 200, h: 100 } },
      ]),
    );
    expect(
      await code(
        h.cp.updateTypographyElement(clipId, added.elementIds[0]!, {
          quad: { tl: [0, 0], tr: [1, 1], br: [0, 0], bl: [1, 1] },
        }),
      ),
    ).toBe('invalid-argument');
  });
});

describe('图层移到指定下标 / 工程名 / 估 BPM', () => {
  it('op:"index" 精确插队，越界夹到两端', async () => {
    const h = harness();
    const clipId = await textClip(h);
    const added = await ok(
      h.cp.addTypographyElements(clipId, [
        { kind: 'shape', shape: 'rect', frame: { x: 0, y: 0, w: 10, h: 10 }, name: 'a' },
        { kind: 'shape', shape: 'rect', frame: { x: 20, y: 0, w: 10, h: 10 }, name: 'b' },
        { kind: 'shape', shape: 'rect', frame: { x: 40, y: 0, w: 10, h: 10 }, name: 'c' },
      ]),
    );
    const [a, b, c] = added.elementIds as [string, string, string];
    await ok(h.cp.reorderTypographyElement(clipId, a, 'index', 2));
    const order = (): string[] =>
      (h.store.project.tracks[0]!.clips[0] as never as { source: { doc: { elements: { id: string }[] } } }).source.doc.elements.map(
        (el) => el.id,
      );
    expect(order()).toEqual([b, c, a]);
    // 越界 = 夹到最前
    await ok(h.cp.reorderTypographyElement(clipId, b, 'index', 99));
    expect(order()).toEqual([c, a, b]);
    expect(await code(h.cp.reorderTypographyElement(clipId, a, 'index', undefined as never))).toBe(
      'invalid-argument',
    );
  });

  it('set_project 能改工程名', async () => {
    const h = harness();
    const r = await ok(h.cp.setProject({ name: '新名字' }));
    expect(r.changed).toContain('name');
    expect(h.store.project.name).toBe('新名字');
    expect(await code(h.cp.setProject({ name: '   ' }))).toBe('invalid-argument');
  });

  it('没有音频时估 BPM 是 unsupported（不静默写默认值）', async () => {
    const h = harness();
    expect(await code(h.cp.estimateBeatGrid())).toBe('unsupported');
  });
});

/* ------------------------------------------- P3：路径族 / 富文本 / 媒体池 */

describe('路径族（布尔 / 拆分 / 转路径）', () => {
  async function clipWithShapes(h: Harness, n = 2): Promise<{ clipId: string; ids: string[] }> {
    const clipId = await textClip(h);
    const elements = Array.from({ length: n }, (_, i) => ({
      kind: 'shape' as const,
      shape: 'rect',
      frame: { x: i * 60, y: 0, w: 100, h: 100 },
    }));
    const added = await ok(h.cp.addTypographyElements(clipId, elements));
    return { clipId, ids: added.elementIds };
  }

  it('布尔：产出一个新图形，操作数消失；交集为空报错且不改文档', async () => {
    const h = harness();
    const { clipId, ids } = await clipWithShapes(h);
    const r = await ok(h.cp.booleanTypographyShapes(clipId, ids, 'union'));
    expect(r.elementId).toBeTruthy();
    const doc = (await ok(h.cp.getTypographyDoc(clipId, 'full'))) as unknown as {
      elements: { id: string; kind: string; shape?: string }[];
    };
    expect(doc.elements).toHaveLength(1);
    expect(doc.elements[0]!.shape).toBe('svg');

    const h2 = harness();
    const two = await clipWithShapes(h2);
    // 把第二个挪到远处：交集为空。
    await ok(
      h2.cp.updateTypographyElement(two.clipId, two.ids[1]!, { frame: { x: 600, y: 400 }  }),
    );
    const before = JSON.stringify(h2.store.project);
    expect(await code(h2.cp.booleanTypographyShapes(two.clipId, two.ids, 'intersection'))).toBe(
      'unsupported',
    );
    expect(JSON.stringify(h2.store.project)).toBe(before);
  });

  it('拆分：每个区域一片；少于两个图形是 invalid-argument', async () => {
    const h = harness();
    const { clipId, ids } = await clipWithShapes(h, 3);
    const r = await ok(h.cp.divideTypographyShapes(clipId, ids));
    expect(r.elementIds.length).toBeGreaterThanOrEqual(3);
    expect(await code(h.cp.divideTypographyShapes(clipId, [ids[0]!]))).toBe('invalid-argument');
  });

  it('转路径：参数化图形就地转；宿主没有轮廓能力时文本转路径是 unsupported', async () => {
    const h = harness();
    const { clipId, ids } = await clipWithShapes(h, 1);
    const r = await ok(h.cp.convertTypographyToPath(clipId, ids));
    expect(r.converted).toBe(1);
    expect(r.elementIds).toEqual(ids);
    const doc = (await ok(h.cp.getTypographyDoc(clipId, 'full'))) as unknown as {
      elements: { shape?: string; path?: string; radius?: number }[];
    };
    expect(doc.elements[0]!.shape).toBe('svg');
    expect(doc.elements[0]!.path).toBeTruthy();
    expect(doc.elements[0]!.radius).toBeUndefined();

    // 空列表是前置错误（不做任何事，也不问宿主要大纲）。
    expect(await code(h.cp.convertTypographyToPath(clipId, []))).toBe('invalid-argument');
  });

  it('文本转路径：轮廓由宿主注入，落成多个图形并包进组（整批原子）', async () => {
    const h = harness(undefined, {
      outlineText: async () => ({
        ok: true,
        items: [
          { role: 'glyph', paint: { kind: 'solid', color: '#fff' }, d: 'M0 0L10 0L10 10Z' },
          { role: 'glyph', paint: { kind: 'solid', color: '#f00' }, d: 'M20 0L30 0L30 10Z' },
        ],
        shadows: [],
      }),
    });
    const clipId = await textClip(h);
    const added = await ok(h.cp.addTypographyElements(clipId, [{ kind: 'text', text: 'AB' }]));
    const r = await ok(h.cp.convertTypographyToPath(clipId, [added.elementIds[0]!]));
    expect(r.elementIds).toHaveLength(2);
    const doc = (await ok(h.cp.getTypographyDoc(clipId, 'full'))) as unknown as {
      elements: { kind: string; groupId?: string }[];
      groups: { id: string }[];
    };
    expect(doc.elements.every((e) => e.kind === 'shape')).toBe(true);
    expect(doc.groups).toHaveLength(1);
    expect(doc.elements[0]!.groupId).toBe(doc.groups[0]!.id);
  });

  it('文本转路径失败时整批不改文档，并把原因带回来', async () => {
    const h = harness(undefined, {
      outlineText: async () => ({ ok: false, code: 'no-font', detail: { families: ['Inter'] } }),
    });
    const clipId = await textClip(h);
    const added = await ok(h.cp.addTypographyElements(clipId, [{ kind: 'text', text: 'AB' }]));
    const before = JSON.stringify(h.store.project);
    const res = await h.cp.convertTypographyToPath(clipId, [added.elementIds[0]!]);
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error.code).toBe('unsupported');
      expect(res.error.message).toContain('Inter');
    }
    expect(JSON.stringify(h.store.project)).toBe(before);
  });
});

describe('行内富文本（runs）', () => {
  it('可写可读，整份往返不丢；非法 style 键被拒绝', async () => {
    const h = harness();
    const clipId = await textClip(h);
    const added = await ok(h.cp.addTypographyElements(clipId, [{ kind: 'text', text: 'AB' }]));
    const elementId = added.elementIds[0]!;

    const r = await ok(
      h.cp.updateTypographyElement(clipId, elementId, {
        runs: [{ text: 'A', style: { fontWeight: 700, color: '#ff0000' } }, { text: 'B' }],
      }),
    );
    // 有行内覆盖时视图必须给 runs（否则读一次再写回就抹掉了）。
    expect(Array.isArray(r.element.runs)).toBe(true);
    expect((r.element.runs as { style?: { fontWeight?: number } }[])[0]!.style?.fontWeight).toBe(700);

    // 整份往返：detail:full → replace_doc → 再读回。
    const full = (await ok(h.cp.getTypographyDoc(clipId, 'full'))) as never as Record<string, unknown>;
    const replaced = await ok(h.cp.replaceTypographyDoc(clipId, full));
    expect(replaced.droppedKeys).toEqual([]);
    const after = (await ok(h.cp.getTypographyDoc(clipId, 'full'))) as unknown as {
      elements: { runs?: { text: string; style?: { color?: string } }[] }[];
    };
    expect(after.elements[0]!.runs?.[0]?.style?.color).toBe('#ff0000');

    // 新建时也能直接带 runs（不是只能事后 patch）。
    const fresh = await ok(
      h.cp.addTypographyElements(clipId, [
        { kind: 'text', text: '', runs: [{ text: '粗', style: { fontWeight: 900 } }] },
      ]),
    );
    expect(
      (fresh.elements[0] as { runs?: { text: string; style?: { fontWeight?: number } }[] }).runs?.[0]
        ?.style?.fontWeight,
    ).toBe(900);

    // 拼错的键必须报错（normalizeRuns 会原样放过，渲染静默忽略）。
    expect(
      await code(
        h.cp.updateTypographyElement(clipId, elementId, {
          runs: [{ text: 'A', style: { fontWight: 700 } } as never],
        }),
      ),
    ).toBe('invalid-argument');
  });

  it('给图形写 runs 是 invalid-argument', async () => {
    const h = harness();
    const clipId = await textClip(h);
    const added = await ok(
      h.cp.addTypographyElements(clipId, [{ kind: 'shape', shape: 'rect' }]),
    );
    expect(
      await code(
        h.cp.updateTypographyElement(clipId, added.elementIds[0]!, { runs: [{ text: 'x' }] }),
      ),
    ).toBe('invalid-argument');
  });
});

describe('媒体池（media_list / media_op + 默认需确认）', () => {
  function mediaHarness(confirm: boolean, calls: { op: string; assetId?: string }[]) {
    return harness(undefined, {
      mediaPool: {
        list: async () => ({
          assets: [
            {
              id: 'a1',
              name: '掌声.wav',
              kind: 'audio',
              inProject: true,
              retained: false,
              linked: false,
              stale: false,
              missing: false,
              bytes: 1024,
              uses: 1,
            },
          ],
          usage: null,
        }),
        run: async (op, assetId) => {
          calls.push({ op, ...(assetId ? { assetId } : {}) });
          return { changed: 1, bytes: 4096 };
        },
      },
      getMediaPoolConfirm: () => confirm,
    });
  }

  it('media_list 给出归属 / 字节 / 引用次数', async () => {
    const calls: { op: string; assetId?: string }[] = [];
    const h = mediaHarness(true, calls);
    const snap = await ok(h.cp.listMediaPool());
    expect(snap.assets[0]).toMatchObject({ id: 'a1', uses: 1, bytes: 1024 });
  });

  it('默认要确认：未确认时 needs-approval 且不执行；confirm:true 才真的动', async () => {
    const calls: { op: string; assetId?: string }[] = [];
    const h = mediaHarness(true, calls);
    const denied = await h.cp.mediaPoolOp({ op: 'delete', assetId: 'a1' });
    expect(denied.ok).toBe(false);
    if (!denied.ok) {
      expect(denied.error.code).toBe('needs-approval');
      expect((denied.error.detail as { kind?: string }).kind).toBe('media');
    }
    expect(calls).toEqual([]);

    const confirmed = await ok(h.cp.mediaPoolOp({ op: 'delete', assetId: 'a1', confirm: true }));
    expect(confirmed).toMatchObject({ op: 'delete', changed: 1, bytes: 4096 });
    expect(calls).toEqual([{ op: 'delete', assetId: 'a1' }]);
  });

  it('偏好关掉时直接执行（不再弹确认）', async () => {
    const calls: { op: string; assetId?: string }[] = [];
    const h = mediaHarness(false, calls);
    expect((await ok(h.cp.mediaPoolOp({ op: 'trash', assetId: 'a1' }))).changed).toBe(1);
    expect(calls).toEqual([{ op: 'trash', assetId: 'a1' }]);
  });

  it('未知动作 / 单条动作缺 assetId 都是 invalid-argument（前置校验，不问确认）', async () => {
    const calls: { op: string; assetId?: string }[] = [];
    const h = mediaHarness(true, calls);
    expect(await code(h.cp.mediaPoolOp({ op: 'nope' as never }))).toBe('invalid-argument');
    expect(await code(h.cp.mediaPoolOp({ op: 'trash' }))).toBe('invalid-argument');
    // 批量动作不需要 assetId。
    expect((await ok(h.cp.mediaPoolOp({ op: 'clear_trash', confirm: true }))).changed).toBe(1);
    expect(calls).toEqual([{ op: 'clear_trash' }]);
  });

  it('宿主没接媒体池时是 unsupported', async () => {
    const h = harness();
    expect(await code(h.cp.listMediaPool())).toBe('unsupported');
    expect(await code(h.cp.mediaPoolOp({ op: 'clear_trash', confirm: true }))).toBe('unsupported');
  });

  it('rename_asset 只改显示名：未知素材 / 空名不动工程，正常路径走注入的桥', async () => {
    const p = createBlankProject('agent-test');
    p.assets.a1 = { id: 'a1', kind: 'audio', name: '旧名.wav' };
    const renamed: { assetId: string; name: string }[] = [];
    const h = harness(p, {
      mediaPool: {
        list: async () => ({ assets: [], usage: null }),
        run: async () => ({ changed: 0 }),
        rename: (assetId, name) => {
          renamed.push({ assetId, name });
          return true;
        },
      },
    });

    expect(await code(h.cp.renameAsset('nope', 'x'))).toBe('not-found');
    expect(await code(h.cp.renameAsset('a1', '   '))).toBe('invalid-argument');
    // 前置校验失败时工程一个字都没动
    expect(h.store.project.assets.a1!.name).toBe('旧名.wav');

    expect(await ok(h.cp.renameAsset('a1', '  掌声  '))).toEqual({ assetId: 'a1', name: '掌声' });
    expect(renamed).toEqual([{ assetId: 'a1', name: '掌声' }]);
  });

  it('rename_asset 没有桥时退回到工程表（headless / CLI 也有这个能力）', async () => {
    const p = createBlankProject('agent-test');
    p.assets.a1 = { id: 'a1', kind: 'image', name: 'old.png' };
    const h = harness(p);

    expect(await ok(h.cp.renameAsset('a1', '主图'))).toEqual({ assetId: 'a1', name: '主图' });
    expect(h.store.project.assets.a1!.name).toBe('主图');
    // 一笔撤销能回来
    h.store.undo();
    expect(h.store.project.assets.a1!.name).toBe('old.png');
  });
});

/**
 * 格式刷 / 动画刷（`typo_copy_style`）。
 *
 * 编辑器里那两个按钮走的是**同一条纯函数路径**（`typography/format-painter.ts`），
 * 所以这里守的是「控制平面也能做到」+「一次调用一笔撤销」+「前置校验不动工程」。
 */
describe('格式刷 / 动画刷（typo_copy_style）', () => {
  async function twoShapes(h: Harness): Promise<{ clipId: string; src: string; tgt: string }> {
    const clipId = await textClip(h);
    const added = await ok(
      h.cp.addTypographyElements(clipId, [
        {
          kind: 'shape',
          shape: 'rect',
          frame: { x: 10, y: 10, w: 100, h: 100 },
          fill: { kind: 'solid', color: '#ff0000' },
          stroke: { color: '#00ff00', width: 6, style: 'dashed' },
          radius: 12,
        },
        {
          kind: 'shape',
          shape: 'rect',
          frame: { x: 200, y: 10, w: 100, h: 100 },
          fill: { kind: 'solid', color: '#0000ff' },
        },
      ]),
    );
    return { clipId, src: added.elementIds[0]!, tgt: added.elementIds[1]! };
  }

  it('format：填充 / 描边 / 圆角刷过去，且只有一笔撤销', async () => {
    const h = harness();
    const { clipId, src, tgt } = await twoShapes(h);

    const r = await ok(h.cp.copyTypographyStyle(clipId, src, [tgt]));
    expect(r.changed).toBe(1);
    const painted = r.elements[0] as unknown as {
      fill: { kind: string; color?: string };
      stroke: { color?: string; width?: number } | null;
      radius?: number;
    };
    expect(painted.fill).toMatchObject({ kind: 'solid', color: '#ff0000' });
    expect(painted.stroke).toMatchObject({ color: '#00ff00', width: 6 });
    expect(painted.radius).toBe(12);

    expect(h.store.undo()).toBe(true);
    const back = (await ok(h.cp.getTypographyDoc(clipId, 'full')) as unknown as {
      elements: { fill: { color?: string } }[];
    }).elements;
    expect(back[1]!.fill.color).toBe('#0000ff');
  });

  it('animation：整份替换目标的动画（id 重新发号）', async () => {
    const h = harness();
    const { clipId, src, tgt } = await twoShapes(h);
    await ok(
      h.cp.setTypographyAnimation(clipId, src, {
        prop: 'opacity',
        keys: [
          { t: 0, v: 0 },
          { t: 0.6, v: 1 },
        ],
      }),
    );
    const r = await ok(h.cp.copyTypographyStyle(clipId, src, [tgt], 'animation'));
    expect(r.changed).toBe(1);

    const els = (await ok(h.cp.getTypographyDoc(clipId, 'full')) as unknown as {
      elements: { id: string; animations: { id: string; prop?: string }[] }[];
    }).elements;
    const a = els.find((e) => e.id === src)!.animations;
    const b = els.find((e) => e.id === tgt)!.animations;
    expect(a).toHaveLength(1);
    expect(b).toHaveLength(1);
    expect(b[0]!.prop).toBe('opacity');
    expect(b[0]!.id).not.toBe(a[0]!.id);
  });

  it('空目标 / 不存在的元素都是可判别错误，且不改工程', async () => {
    const h = harness();
    const { clipId, src } = await twoShapes(h);
    const before = JSON.stringify(h.store.project);
    expect(await code(h.cp.copyTypographyStyle(clipId, src, []))).toBe('invalid-argument');
    // 只有源自己 = 没有目标
    expect(await code(h.cp.copyTypographyStyle(clipId, src, [src]))).toBe('invalid-argument');
    expect(await code(h.cp.copyTypographyStyle(clipId, src, ['nope']))).toBe('not-found');
    expect(await code(h.cp.copyTypographyStyle(clipId, 'nope', ['x']))).toBe('not-found');
    expect(JSON.stringify(h.store.project)).toBe(before);
  });
});
