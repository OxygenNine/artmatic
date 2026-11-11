import { describe, expect, it } from 'vitest';
import {
  MAX_MASK_DEPTH,
  clipMaskUses,
  dropMaskCycles,
  maskEdges,
  maskPathExists,
  maskRefCreatesCycle,
  maskRefOf,
  maskRefTarget,
  sanitizeMaskInputs,
  sanitizeMaskRef,
  type MaskRef,
} from '../../src/core/mask';
import { ProjectStore } from '../../src/core/project-store';
import {
  SCHEMA_VERSION,
  defaultProject,
  migrateProject,
  newId,
  validateProject,
  type EffectClip,
  type EffectInstance,
  type Project,
  type SourceClip,
  type VisualTrack,
} from '../../src/core/schema';

/**
 * 蒙版依赖图的守卫。
 *
 * 环在这里不是「几何不好看」的问题：渲染侧遇到环只有两种结局 —— 一张白蒙版
 * （画面里那块局部调色悄悄消失）或者无穷递归（标签页卡死）。所以环必须在
 * **写入口**被拒，而写入口有两个（store setter / `validateProject`），
 * 它们共用 `core/mask.ts` 这一份判据 —— 这份测试守的就是那一份。
 */

function sourceClip(label: string): SourceClip {
  return {
    kind: 'source',
    id: newId(),
    start: 0,
    end: 10,
    label,
    fadeSec: 0,
    curves: {},
    source: { type: 'solid', color: '#000000' },
    blend: 'normal',
    opacity: 1,
    transform: { x: 0.5, y: 0.5, sx: 1, sy: 1, rot: 0 },
    fit: 'stretch',
  };
}

function effectClip(instanceIds?: string[], boundClipId?: string): EffectClip {
  const ids = instanceIds ?? [newId()];
  return {
    kind: 'effect',
    id: newId(),
    start: 0,
    end: 10,
    label: 'fx',
    fadeSec: 0,
    curves: {},
    chain: ids.map(
      (instanceId): EffectInstance => ({
        instanceId,
        defId: 'grade-qualifier',
        enabled: true,
        values: {},
      }),
    ),
    ...(boundClipId ? { boundClipId } : {}),
  };
}

function track(name: string, clips: (SourceClip | EffectClip)[]): VisualTrack {
  return { kind: 'visual', id: newId(), name, enabled: true, clips };
}

function projectWith(tracks: VisualTrack[]): Project {
  const p = defaultProject('蒙版测试');
  p.duration = 10;
  p.tracks = tracks;
  return p;
}

/** 给某条链上的第 index 个实例接一条 clip 引用。 */
function bindMask(clip: EffectClip, index: number, targetClipId: string, channel: 'luma' | 'alpha' = 'luma'): void {
  const inst = clip.chain[index]!;
  inst.inputs = { mask: { kind: 'clip', clipId: targetClipId, channel } };
}

describe('MaskRef 的形状', () => {
  it('只接受三种 kind，通道必须在枚举里', () => {
    expect(sanitizeMaskRef({ kind: 'none' })).toEqual({ kind: 'none' });
    expect(sanitizeMaskRef({ kind: 'clip', clipId: 'c1', channel: 'luma' })).toEqual({
      kind: 'clip',
      clipId: 'c1',
      channel: 'luma',
    });
    expect(sanitizeMaskRef({ kind: 'asset', assetId: 'a1', channel: 'alpha' })).toEqual({
      kind: 'asset',
      assetId: 'a1',
      channel: 'alpha',
    });
    // 坏值一律 null（调用方据此删键），不抛：手改 JSON 不该让工程打不开。
    expect(sanitizeMaskRef({ kind: 'clip', clipId: 'c1', channel: 'luminance' })).toBeNull();
    expect(sanitizeMaskRef({ kind: 'clip', channel: 'luma' })).toBeNull();
    expect(sanitizeMaskRef({ kind: 'video', id: 'x' })).toBeNull();
    expect(sanitizeMaskRef(null)).toBeNull();
    expect(sanitizeMaskRef('mask')).toBeNull();
  });

  it('`none` 与缺省在渲染侧等价，但读回形状不同', () => {
    expect(maskRefTarget({ kind: 'none' })).toBeNull();
    expect(maskRefTarget(null)).toBeNull();
    expect(maskRefTarget({ kind: 'clip', clipId: 'c', channel: 'r' })).toEqual({
      kind: 'clip',
      id: 'c',
      channel: 'r',
    });
    expect(maskRefOf({ inputs: { mask: { kind: 'none' } } })).toEqual({ kind: 'none' });
    expect(maskRefOf({})).toBeNull();
  });
});

describe('依赖边：引用边 + 绑定边', () => {
  it('引用边来自链上的实例，绑定边来自 boundClipId', () => {
    const a = sourceClip('A');
    const b = sourceClip('B');
    const fx = effectClip([newId()], b.id);
    bindMask(fx, 0, a.id);
    const p = projectWith([track('V1', [a]), track('V2', [b, fx])]);

    const edges = maskEdges(p);
    // fx 要渲 A 才能拿到蒙版；B 那一层要先跑 fx 的链。
    expect(edges.get(fx.id)).toEqual([a.id]);
    expect(edges.get(b.id)).toEqual([fx.id]);
  });

  it('没有蒙版引用时图是空的（未声明的特效不占拓扑）', () => {
    const a = sourceClip('A');
    const fx = effectClip();
    const p = projectWith([track('V1', [a, fx])]);
    expect(clipMaskUses(p)).toEqual([]);
    expect(maskEdges(p).size).toBe(0);
  });
});

describe('环检测', () => {
  it('指向自己是环', () => {
    const a = sourceClip('A');
    const fx = effectClip([newId()], a.id);
    bindMask(fx, 0, a.id);
    const p = projectWith([track('V1', [a, fx])]);
    expect(maskRefCreatesCycle(p, fx.id, a.id)).toBe(true);
  });

  it('A→B→A 在两笔写入的**最后一笔**上被拒', () => {
    const a = sourceClip('A');
    const b = sourceClip('B');
    const fx1 = effectClip([newId()], a.id);
    const fx2 = effectClip([newId()], b.id);
    bindMask(fx1, 0, b.id);
    const p = projectWith([track('V1', [a, fx1]), track('V2', [b, fx2])]);
    // 现在补 fx2 → A：A 的层要跑 fx1，fx1 要 B，B 的层要跑 fx2 ⇒ 成环。
    expect(maskRefCreatesCycle(p, fx2.id, a.id)).toBe(true);
    // 反过来 fx2 → 别的画面片段是安全的。
    const c = sourceClip('C');
    p.tracks.push(track('V3', [c]));
    expect(maskRefCreatesCycle(p, fx2.id, c.id)).toBe(false);
  });

  it('超过 8 层也按环处理（链太长同样是渲染事故）', () => {
    const clips: SourceClip[] = [];
    const fxs: EffectClip[] = [];
    for (let i = 0; i <= MAX_MASK_DEPTH + 1; i += 1) clips.push(sourceClip(`S${i}`));
    // 第 i 条链引用第 i+1 个片段，串成一条长链。
    for (let i = 0; i < clips.length - 1; i += 1) {
      const fx = effectClip([newId()], clips[i]!.id);
      bindMask(fx, 0, clips[i + 1]!.id);
      fxs.push(fx);
    }
    const tracks = clips.map((c, i) => track(`V${i}`, [c, ...(fxs[i] ? [fxs[i]!] : [])]));
    const p = projectWith(tracks);
    expect(clipMaskUses(p).length).toBe(clips.length - 1);
    // 从最上面那条往下数已经超过 MAX_MASK_DEPTH 步 ⇒ 判为成环。
    expect(maskRefCreatesCycle(p, fxs[0]!.id, clips[1]!.id)).toBe(true);
    expect(dropMaskCycles(p)).toBeGreaterThan(0);
  });
});

describe('界面用的判据与写入侧等价', () => {
  /*
   * 检查器的候选下拉不能对每个候选各调一次 `maskRefCreatesCycle`（每次都要重建
   * 边表），所以它走 `maskPathExists(已有边表, target, owner)`。两条路径必须给出
   * 同一个结论 —— 否则「面板里能选、点了没反应」，或者反过来漏掉一个真环。
   */
  it('逐个 (owner, target) 组合两边结论一致', () => {
    const a = sourceClip('A');
    const b = sourceClip('B');
    const c = sourceClip('C');
    const fx1 = effectClip([newId()], a.id);
    const fx2 = effectClip([newId()], b.id);
    bindMask(fx1, 0, b.id);
    const p = projectWith([track('V1', [a, fx1]), track('V2', [b, fx2]), track('V3', [c])]);
    const edges = maskEdges(p);

    const owners = [a.id, b.id, c.id, fx1.id, fx2.id];
    const targets = [a.id, b.id, c.id, fx1.id, fx2.id];
    for (const owner of owners) {
      for (const target of targets) {
        // 自引用一律成环；`maskPathExists` 问的是「目标能不能绕回所有者」。
        const viaGraph = owner !== target && maskPathExists(edges, target, owner);
        expect(viaGraph, `owner=${owner} target=${target}`).toBe(
          maskRefCreatesCycle(p, owner, target) && owner !== target,
        );
      }
    }
    // 至少有一条真的成环，否则这条等价性是空转的。
    expect(maskRefCreatesCycle(p, fx2.id, a.id)).toBe(true);
  });
});

describe('validateProject 的那一趟：形状 → 悬空 → 环', () => {
  it('悬空引用置成 none（不删键，撤销回来还能看到「它有过」）', () => {
    const a = sourceClip('A');
    const fx = effectClip([newId()], a.id);
    bindMask(fx, 0, 'gone-clip');
    const p = projectWith([track('V1', [a, fx])]);
    sanitizeMaskInputs(p);
    expect(fx.chain[0]!.inputs?.mask).toEqual({ kind: 'none' });
  });

  it('坏形状删键，未知输入键也删（只有一种输入）', () => {
    const a = sourceClip('A');
    const fx = effectClip([newId()], a.id);
    const inst = fx.chain[0]!;
    inst.inputs = {
      mask: { kind: 'clip', clipId: a.id, channel: 'nope' } as unknown as MaskRef,
      depth: { kind: 'none' },
    };
    const p = projectWith([track('V1', [a, fx])]);
    sanitizeMaskInputs(p);
    expect(inst.inputs).toBeUndefined();
  });

  it('成环的引用被清掉，工程仍然打得开', () => {
    const a = sourceClip('A');
    const fx = effectClip([newId()], a.id);
    bindMask(fx, 0, a.id);
    const p = projectWith([track('V1', [a, fx])]);
    const validated = validateProject(p);
    expect(validated.tracks.length).toBe(1);
    const out = (validated.tracks[0]!.clips[1] as EffectClip).chain[0]!;
    expect(out.inputs?.mask).toEqual({ kind: 'none' });
  });

  it('合法的引用原样保留（validate 不会"顺手"改掉它）', () => {
    const a = sourceClip('A');
    const b = sourceClip('B');
    const fx = effectClip([newId()], b.id);
    bindMask(fx, 0, a.id, 'alpha');
    const p = projectWith([track('V1', [a]), track('V2', [b, fx])]);
    const validated = validateProject(p);
    const kept = (validated.tracks[1]!.clips[1] as EffectClip).chain[0]!;
    expect(kept.inputs?.mask).toEqual({ kind: 'clip', clipId: a.id, channel: 'alpha' });
  });

  it('v18 → v19 是恒等迁移（旧工程读进来合法，只是版本号抬高）', () => {
    const a = sourceClip('A');
    const p = projectWith([track('V1', [a])]);
    const raw = { ...p, schemaVersion: 18, tracks: p.tracks.map((t) => ({ ...t, clips: t.clips.map((c) => ({ ...c })) })) };
    // 去掉 v19 之后才有的字段，模拟真实的 v18 工程。
    for (const t of raw.tracks) for (const c of t.clips) if (c.kind === 'effect') for (const i of c.chain) delete i.inputs;
    const migrated = migrateProject(raw as unknown as Record<string, unknown>);
    expect(migrated.schemaVersion).toBe(SCHEMA_VERSION);
    expect(migrated.tracks.length).toBe(1);
  });
});

describe('store 的写入口', () => {
  it('成环的写入被拒，且工程一个字没动', () => {
    const a = sourceClip('A');
    const fx = effectClip([newId()], a.id);
    const p = projectWith([track('V1', [a, fx])]);
    const store = new ProjectStore(p);
    const version = store.version;
    const ok = store.setEffectMaskRef(fx.id, fx.chain[0]!.instanceId, {
      kind: 'clip',
      clipId: a.id,
      channel: 'luma',
    });
    expect(ok).toBe(false);
    expect(store.version).toBe(version);
    expect(fx.chain[0]!.inputs).toBeUndefined();
  });

  it('接上 → 摘掉 → 撤销，三步都回到该在的状态', () => {
    const a = sourceClip('A');
    const b = sourceClip('B');
    const fx = effectClip([newId()], b.id);
    const p = projectWith([track('V1', [a]), track('V2', [b, fx])]);
    const store = new ProjectStore(p);
    const inst = fx.chain[0]!.instanceId;

    expect(store.setEffectMaskRef(fx.id, inst, { kind: 'clip', clipId: a.id, channel: 'g' })).toBe(true);
    const chainOf = (): EffectInstance => (store.findClip(fx.id)!.clip as EffectClip).chain[0]!;

    expect(maskRefOf(chainOf())).toEqual({ kind: 'clip', clipId: a.id, channel: 'g' });

    expect(store.setEffectMaskRef(fx.id, inst, null)).toBe(true);
    expect(chainOf().inputs).toBeUndefined();

    expect(store.undo()).toBe(true);
    expect(maskRefOf(chainOf())).toEqual({ kind: 'clip', clipId: a.id, channel: 'g' });
  });

  it('删掉被引用片段：引用置 none 而不是留着悬空', () => {
    const a = sourceClip('A');
    const b = sourceClip('B');
    const fx = effectClip([newId()], b.id);
    bindMask(fx, 0, a.id);
    const p = projectWith([track('V1', [a]), track('V2', [b, fx])]);
    const store = new ProjectStore(p);

    store.removeClip(a.id);
    const after = store.findClip(fx.id)!.clip as EffectClip;
    expect(after.chain[0]!.inputs?.mask).toEqual({ kind: 'none' });

    // 撤销之后引用回来 —— 这就是「置 none 而不是删键」买到的东西。
    store.undo();
    const restored = store.findClip(fx.id)!.clip as EffectClip;
    expect(restored.chain[0]!.inputs?.mask).toEqual({ kind: 'clip', clipId: a.id, channel: 'luma' });
  });

  it('删掉整条轨同样会清引用', () => {
    const a = sourceClip('A');
    const b = sourceClip('B');
    const fx = effectClip([newId()], b.id);
    bindMask(fx, 0, a.id);
    const v1 = track('V1', [a]);
    const p = projectWith([v1, track('V2', [b, fx])]);
    const store = new ProjectStore(p);
    store.removeTrack(v1.id);
    expect((store.findClip(fx.id)!.clip as EffectClip).chain[0]!.inputs?.mask).toEqual({ kind: 'none' });
  });
});
