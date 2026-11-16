import { describe, expect, it } from 'vitest';
import { buildStack, walkOps, type RenderOp, type ResolvedSource } from '../../src/engine/stack';
import { createDemoProject } from '../../src/core/demo-project';
import { quadInverseMatrix } from '../../src/core/quad';
import {
  defaultProject,
  identityQuad,
  newId,
  type EffectClip,
  type Project,
  type SourceClip,
  type Track,
  type VisualTrack,
} from '../../src/core/schema';

/** 造一个「一轨一个纯色片段」的工程，用于只观察 z 映射。 */
function projectWithTracks(names: string[]): Project {
  const p = defaultProject('测试');
  p.duration = 10;
  for (const name of names) {
    const clip: SourceClip = {
      kind: 'source',
      id: newId(),
      start: 0,
      end: 10,
      label: name,
      fadeSec: 0,
      curves: {},
      source: { type: 'solid', color: '#000000' },
      blend: 'normal',
      opacity: 1,
      transform: { x: 0.5, y: 0.5, sx: 1, sy: 1, rot: 0 },
      fit: 'stretch',
    };
    const track: VisualTrack = {
      kind: 'visual',
      id: newId(),
      name,
      enabled: true,
      clips: [clip],
    };
    p.tracks.push(track);
  }
  return p;
}

describe('buildStack 的 z 序 = 列表顶部在前景', () => {
  it('列表第一轨的 z 最大（last），最后一轨 z 最小（0）', () => {
    const p = projectWithTracks(['顶', '中', '底']);
    const ops = buildStack(p, 1);
    const byLabel = Object.fromEntries(
      ops.filter((o) => o.type === 'source').map((o) => [(o as { source: { clip: SourceClip } }).source.clip.label, o.z]),
    );
    expect(byLabel['顶']).toBe(2);
    expect(byLabel['中']).toBe(1);
    expect(byLabel['底']).toBe(0);
  });

  it('z 严格随列表下标递减', () => {
    const p = projectWithTracks(['a', 'b', 'c', 'd']);
    const zs = buildStack(p, 1).map((o) => o.z);
    expect(zs).toEqual([...zs].sort((x, y) => x - y)); // 升序输出（合成顺序）
    expect(zs).toEqual([0, 1, 2, 3]);
  });

  it('输出按 z 升序 —— compositor 顺序消费，后画者盖在上', () => {
    const ops = buildStack(projectWithTracks(['x', 'y']), 1);
    for (let i = 1; i < ops.length; i += 1) {
      expect(ops[i]!.z).toBeGreaterThanOrEqual(ops[i - 1]!.z);
    }
  });

  it('禁用的轨道整条不参与（引擎侧确实消费 enabled）', () => {
    const p = projectWithTracks(['顶', '底']);
    (p.tracks[0] as VisualTrack).enabled = false;
    const ops = buildStack(p, 1);
    expect(ops).toHaveLength(1);
    // 禁用后索引不变，所以「底」仍是 z=0（z 由数组下标决定，不因过滤而重排）
    expect(ops[0]!.z).toBe(0);
  });

  it('音频轨不产生渲染 op（视觉栈只含 visual 轨）', () => {
    const p = projectWithTracks(['v']);
    p.tracks.push({
      kind: 'audio',
      id: newId(),
      name: 'a',
      enabled: true,
      bus: 'master',
      clips: [],
    });
    expect(buildStack(p, 1)).toHaveLength(1);
  });

  it('demo 工程：每个 op 的 z 都等于「轨道下标取反」', () => {
    const p = createDemoProject();
    const visual = p.tracks.filter((t) => t.kind === 'visual');
    /*
     * 轨名约定是 `V{n}`，列表自上而下 = 前景→背景 ⇒ 编号必须**降序**，
     * 且最大编号等于视觉轨数。
     *
     * 这里刻意不写死 `'V4'` / 条数：被守的是「轨道列表顺序 ↔ z 的映射」，
     * 不是「demo 恰好有几条轨」。写死之后每次调整 demo 的层数都要来改守卫，
     * 而改守卫的时候很容易顺手把要守的东西也改掉 —— 那时它就只是个装饰。
     */
    const nums = visual.map((t) => {
      const m = /^V(\d+)/.exec(t.name);
      expect(m, `轨名 ${t.name} 不符合 V{n} 约定`).not.toBeNull();
      return Number(m![1]);
    });
    expect(nums).toEqual([...nums].sort((a, b) => b - a));
    expect(nums[0]).toBe(visual.length);

    const ops = buildStack(p, 0.5);
    expect(ops.length).toBeGreaterThan(0);
    for (const op of ops) {
      // 转场 op 也是「挂在某条轨道上」的，归属按出画片段算
      const clipId =
        op.type === 'effect'
          ? op.clip.id
          : op.type === 'transition'
            ? op.from!.clip.id
            : op.source.clip.id;
      const trackIdx = visual.findIndex((t) => t.clips.some((c) => c.id === clipId));
      expect(trackIdx, `找不到 ${clipId} 所属轨道`).toBeGreaterThanOrEqual(0);
      expect(op.z, `z 与轨道 ${visual[trackIdx]!.name} 的顺序不符`).toBe(
        visual.length - 1 - trackIdx,
      );
    }
  });


  it('demo 工程最后一轨是音频（与视觉栈的 z 无关）', () => {
    const p = createDemoProject();
    expect(p.tracks[p.tracks.length - 1]!.kind).toBe('audio');
  });
});

/* ------------------------------------------------------------------ 转场 */

/** from[0,2] + to[2,4]，from 带 d=1 的出画转场 → 窗口 [1.5, 2.5)。 */
function transitionProject(opts: { fromBlend?: SourceClip['blend']; toBlend?: SourceClip['blend'] } = {}) {
  const mk = (start: number, end: number, color: string, blend: SourceClip['blend']): SourceClip => ({
    kind: 'source',
    id: newId(),
    start,
    end,
    label: color,
    fadeSec: 0,
    curves: {},
    source: { type: 'solid', color },
    blend,
    opacity: 1,
    transform: { x: 0.5, y: 0.5, sx: 1, sy: 1, rot: 0 },
    fit: 'stretch',
  });
  const from = mk(0, 2, '#ff0000', opts.fromBlend ?? 'normal');
  const to = mk(2, 4, '#0000ff', opts.toBlend ?? 'normal');
  from.transitionOut = { defId: 'fade', duration: 1, values: { foo: 3 } };
  const p = defaultProject('测试');
  p.duration = 10;
  p.tracks.push({ kind: 'visual', id: 'v1', name: 'V1', enabled: true, clips: [from, to] });
  return { p, from, to };
}

describe('buildStack：转场 op', () => {
  it('窗口外仍是两个独立 source op（行为没变）', () => {
    const { p } = transitionProject();
    expect(buildStack(p, 1).map((o) => o.type)).toEqual(['source']);
    expect(buildStack(p, 3).map((o) => o.type)).toEqual(['source']);
  });

  it('窗口前半段（t < cut）：一个 transition op，没有多余的 source op', () => {
    const { p } = transitionProject();
    const ops = buildStack(p, 1.6);
    expect(ops.map((o) => o.type)).toEqual(['transition']);
    const op = ops[0]!;
    if (op.type !== 'transition') throw new Error('应为 transition');
    expect(op.defId).toBe('fade');
    expect(op.values).toEqual({ foo: 3 });
    expect(op.progress).toBeCloseTo(0.1, 9);
    expect(op.from!.clip.label).toBe('#ff0000');
    expect(op.to!.clip.label).toBe('#0000ff');
  });

  it('窗口后半段（t ≥ from.end）照样命中 —— 这是「转场判断必须在 span 过滤之前」的守卫', () => {
    const { p } = transitionProject();
    // t=2.2 已越过 from.end(2)；若先做 span 过滤就会退化成单个 to 的 source op
    const ops = buildStack(p, 2.2);
    expect(ops.map((o) => o.type)).toEqual(['transition']);
    const op = ops[0]!;
    if (op.type !== 'transition') throw new Error('应为 transition');
    expect(op.progress).toBeCloseTo(0.7, 9);
  });

  it('入画片段不会被重复画（窗口后半段的 t 落在它自己的区间里）', () => {
    const { p } = transitionProject();
    // to 的区间是 [2,4)，窗口是 [1.5,2.5)：整段窗口内都只应有 1 个 op
    for (const t of [1.5, 1.9, 2.0, 2.4, 2.49]) {
      expect(buildStack(p, t).filter((o) => o.type !== 'effect')).toHaveLength(1);
    }
  });

  it('t = 窗口末端（半开）回到单 source op：入画片段自己出场', () => {
    const { p } = transitionProject();
    const ops = buildStack(p, 2.5);
    expect(ops.map((o) => o.type)).toEqual(['source']);
    expect((ops[0] as { source: { clip: SourceClip } }).source.clip.label).toBe('#0000ff');
  });

  it('两侧各自的 transform / opacity 都在 op 里求值好（不是共用一个）', () => {
    const { p, from } = transitionProject();
    from.opacity = 0.5;
    const op = buildStack(p, 1.6)[0]!;
    if (op.type !== 'transition') throw new Error('应为 transition');
    expect(op.from!.opacity).toBeCloseTo(0.5, 9);
    expect(op.to!.opacity).toBeCloseTo(1, 9);
    expect(op.from!.transform.x).toBe(0.5);
  });

  it('合成用的 blend 取入画片段的（窗口结束后下一帧就是它）', () => {
    const { p } = transitionProject({ fromBlend: 'screen', toBlend: 'multiply' });
    const op = buildStack(p, 1.6)[0]!;
    if (op.type !== 'transition') throw new Error('应为 transition');
    expect(op.blend).toBe('multiply');
  });

  it('转场 op 的 z 与所在轨道一致（其他轨道照常叠）', () => {
    const { p } = transitionProject();
    // 再加一条视觉轨：列表顶部 = 前景
    p.tracks.unshift({
      kind: 'visual',
      id: 'v0',
      name: 'V0',
      enabled: true,
      clips: [
        {
          kind: 'source',
          id: newId(),
          start: 0,
          end: 10,
          label: 'under',
          fadeSec: 0,
          curves: {},
          source: { type: 'solid', color: '#00ff00' },
          blend: 'normal',
          opacity: 1,
          transform: { x: 0.5, y: 0.5, sx: 1, sy: 1, rot: 0 },
          fit: 'stretch',
        },
      ],
    });
    const ops = buildStack(p, 1.6);
    // 输出按 z 升序：v1（数组下标 1 → z=0）在前，v0（z=1）在后 = 前景后画
    expect(ops.map((o) => o.type)).toEqual(['transition', 'source']);
    expect(ops[0]!.z).toBe(0);
    expect(ops[1]!.z).toBe(1);
  });

  it('轨道被禁用时整个转场也不产出', () => {
    const { p } = transitionProject();
    (p.tracks[0] as VisualTrack).enabled = false;
    expect(buildStack(p, 1.6)).toEqual([]);
  });

  it('留缝时另一侧按全透明处理（v13）：仍产出一个单侧 transition op', () => {
    const { p, to } = transitionProject();
    to.start = 2.5;
    to.end = 4.5;
    const op = buildStack(p, 1.6)[0]!;
    expect(op.type).toBe('transition');
    if (op.type !== 'transition') return;
    expect(op.to).toBeNull();
    expect(op.single).toBe('from');
    expect(op.from!.clip.label).toBe('#ff0000');
    // 窗口后半段（已越过 from.end）照样在画：那一侧是透明的。
    expect(buildStack(p, 2.2).map((o) => o.type)).toEqual(['transition']);
  });
});

/* ----------------------------------------------------------- 影响深度 */

function srcClip(label: string): SourceClip {
  return {
    kind: 'source',
    id: label,
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

function fxClip(label: string, affectDepth?: number): EffectClip {
  return {
    kind: 'effect',
    id: label,
    start: 0,
    end: 10,
    label,
    fadeSec: 0,
    curves: {},
    chain: [{ instanceId: `${label}-i`, defId: 'bleach', enabled: true, values: {} }],
    ...(affectDepth === undefined ? {} : { affectDepth }),
  };
}

/** 自顶向下造视觉轨（顺序就是 z 顺序：第一条是最前景）。 */
function depthProject(spec: { name: string; clips: (SourceClip | EffectClip)[]; enabled?: boolean }[]): Project {
  const p = defaultProject('深度');
  p.duration = 10;
  p.tracks = spec.map((s) => ({
    kind: 'visual',
    id: s.name,
    name: s.name,
    enabled: s.enabled ?? true,
    clips: s.clips,
  })) as Track[];
  return p;
}

/** op 的身份：片段 label（特效加 `fx:` 前缀，便于和源区分）。 */
function opLabel(op: RenderOp): string {
  if (op.type === 'effect') return `fx:${op.clip.label}`;
  if (op.type === 'transition') return `tr:${op.from!.clip.label}`;
  return op.source.clip.label;
}

/** 某个 op 的作用域内容（非特效 / 没设深度 → 抛错，别让断言悄悄拿到空数组）。 */
function scopeOf(op: RenderOp | undefined): string[] {
  if (!op || op.type !== 'effect' || !op.scope) throw new Error('这个 op 上没有作用域');
  return op.scope.map(opLabel);
}

describe('buildStack：影响深度（作用域组）', () => {
  const three = (depth?: number) =>
    depthProject([
      { name: 'V1', clips: [fxClip('fx', depth)] },
      { name: 'V2', clips: [srcClip('b')] },
      { name: 'V3', clips: [srcClip('c')] },
    ]);

  it('0 / 缺省都不分组：顶层就是全部 op，逐个 op 的 z 仍然升序', () => {
    for (const p of [three(0), three(undefined)]) {
      const ops = buildStack(p, 1);
      expect(ops.map(opLabel)).toEqual(['c', 'b', 'fx:fx']);
      expect(ops.map((o) => o.z)).toEqual([0, 1, 2]);
      expect(ops.some((o) => o.type === 'effect' && o.scope !== undefined)).toBe(false);
    }
  });

  it('深度 1：只有最近的下方轨道进作用域，更深的留在底层', () => {
    const ops = buildStack(three(1), 1);
    // 顶层按 z 升序：底层的 c 仍在原位，被折进作用域的 b 不再单独出现
    expect(ops.map(opLabel)).toEqual(['c', 'fx:fx']);
    expect(scopeOf(ops[1])).toEqual(['b']);
    // 每个 op 恰好出现一次（作用域是「移走」而不是「复制」）
    const seen: string[] = [];
    walkOps(ops, (op) => seen.push(opLabel(op)));
    expect(seen).toEqual(['c', 'fx:fx', 'b']);
  });

  it('深度 2 / 超过下方轨道数：下方全部进作用域，底层不再单独出现', () => {
    for (const d of [2, 9]) {
      const ops = buildStack(three(d), 1);
      expect(ops.map(opLabel)).toEqual(['fx:fx']);
      expect(scopeOf(ops[0])).toEqual(['c', 'b']);
    }
  });

  it('只数启用的轨道：关掉中间那条，深度 1 落到再下面一条', () => {
    const p = depthProject([
      { name: 'V1', clips: [fxClip('fx', 1)] },
      { name: 'V2', clips: [srcClip('b')], enabled: false },
      { name: 'V3', clips: [srcClip('c')] },
    ]);
    const ops = buildStack(p, 1);
    expect(ops.map(opLabel)).toEqual(['fx:fx']);
    expect(scopeOf(ops[0])).toEqual(['c']);
  });

  it('同轨更早的片段也在作用域里（画面上它本来就在特效之下）', () => {
    const p = depthProject([
      { name: 'V1', clips: [srcClip('s'), fxClip('fx', 1)] },
      { name: 'V2', clips: [srcClip('b')] },
    ]);
    const ops = buildStack(p, 1);
    expect(ops.map(opLabel)).toEqual(['fx:fx']);
    expect(scopeOf(ops[0])).toEqual(['b', 's']);
  });

  it('下方没有启用的轨道 → 空作用域（作用在空画面上）', () => {
    const p = depthProject([
      { name: 'V1', clips: [fxClip('fx', 1)] },
      { name: 'V2', clips: [srcClip('b')], enabled: false },
    ]);
    const ops = buildStack(p, 1);
    expect(ops.map(opLabel)).toEqual(['fx:fx']);
    expect(scopeOf(ops[0])).toEqual([]);
  });

  it('吸收：内层特效需要的更深轨道会并进外层作用域（外层不会变成静默空操作）', () => {
    const p = depthProject([
      // 外层只声明 V2、V3；内层（在 V2 上）声明 V3、V4、V5 ⇒ 外层跟着扩到 V5
      { name: 'V1', clips: [fxClip('fx1', 2)] },
      { name: 'V2', clips: [fxClip('fx2', 3)] },
      { name: 'V3', clips: [srcClip('c')] },
      { name: 'V4', clips: [srcClip('d')] },
      { name: 'V5', clips: [srcClip('e')] },
    ]);
    const ops = buildStack(p, 1);
    expect(ops.map(opLabel)).toEqual(['fx:fx1']);
    const fx1 = ops[0]!;
    expect(scopeOf(fx1)).toEqual(['fx:fx2']);
    if (fx1.type !== 'effect') throw new Error('应为 effect');
    expect(scopeOf(fx1.scope![0])).toEqual(['e', 'd', 'c']);
  });

  it('作用域里的 op 保留自己的 z（组内也按 z 升序合成）', () => {
    const ops = buildStack(three(2), 1);
    const inner = ops[0]!;
    if (inner.type !== 'effect') throw new Error('应为 effect');
    expect(inner.scope!.map((o) => [opLabel(o), o.z])).toEqual([
      ['c', 0],
      ['b', 1],
    ]);
  });
});

/* ------------------------------------------- 片段级图像处理：key / quad（v7） */

/**
 * 单个 source 片段 → 它在 t=1 求值出的 `op.source`。
 *
 * 这两个字段的解析只在 `resolveSource` 里做一次（不做曲线），所以单测直接看
 * ResolvedSource 就够 —— compositor 只是把字段原样上传成 uniform。
 */
function sourceOf(clip: SourceClip): ResolvedSource {
  const p = defaultProject('片段级图像处理');
  p.duration = 10;
  p.tracks.push({ kind: 'visual', id: 'v', name: 'V1', enabled: true, clips: [clip] });
  const op = buildStack(p, 1)[0]!;
  if (!op || op.type !== 'source') throw new Error('应为 source op');
  return op.source;
}

describe('buildStack：key / quad 求值', () => {
  it('clip.key 原样带到 op.source.key（同一引用，UI 改参数下一帧即生效）', () => {
    const clip = srcClip('keyed');
    clip.key = { color: '#00ff00', tolerance: 0.25, softness: 0.12, spill: 0.5 };
    const source = sourceOf(clip);
    expect(source.key).toBe(clip.key);
    expect(source.key).toEqual({ color: '#00ff00', tolerance: 0.25, softness: 0.12, spill: 0.5 });
  });

  it('没有 key 时不带该字段（缺省 = 不抠）', () => {
    expect(sourceOf(srcClip('plain')).key).toBeUndefined();
  });

  it('非恒等 quad → quadInverse = quadInverseMatrix(quad)（逐元素）', () => {
    const clip = srcClip('warped');
    // 梯形：上边下压。刻意选非对称的四边形，单应不是仿射。
    clip.quad = { tl: [0.25, 0.25], tr: [0.75, 0.25], br: [1, 1], bl: [0, 1] };
    const expected = quadInverseMatrix(clip.quad)!;
    const got = sourceOf(clip).quadInverse;
    expect(expected).toHaveLength(9);
    expect(got).toHaveLength(9);
    for (let i = 0; i < 9; i += 1) expect(got![i]!).toBeCloseTo(expected[i]!, 12);
  });

  it('identity quad → 不带 quadInverse（compositor 走 u_quadOn=0 的旧算式）', () => {
    const clip = srcClip('identity');
    clip.quad = identityQuad();
    expect(sourceOf(clip).quadInverse).toBeUndefined();
  });

  it('退化 quad（三点共线）→ quadInverse 为 null（按「不调整」渲染，不丢层）', () => {
    const clip = srcClip('degenerate');
    // tl / tr / bl 都在 y=0.5 上 → 单应不可逆
    clip.quad = { tl: [0, 0.5], tr: [0.5, 0.5], br: [1, 1], bl: [1, 0.5] };
    expect(sourceOf(clip).quadInverse).toBeNull();
  });

  it('转场两侧各自带自己的 key / quad（placement 对两侧各做一次，互不串）', () => {
    const { p, from, to } = transitionProject();
    from.key = { color: '#00ff00', tolerance: 0.3, softness: 0.1, spill: 0.4 };
    to.quad = { tl: [0.1, 0], tr: [0.9, 0], br: [1, 1], bl: [0, 1] };
    const op = buildStack(p, 1.6)[0]!;
    if (op.type !== 'transition') throw new Error('应为 transition');
    expect(op.from!.key).toBe(from.key);
    expect(op.from!.quadInverse).toBeUndefined();
    expect(op.to!.key).toBeUndefined();
    expect(op.to!.quadInverse).toHaveLength(9);
  });
});

/* ------------------------------------------------------- 片段级开关 */

/**
 * `ClipBase.hidden` = 这一段不产出任何东西，但**仍占着时间轴位置**。
 *
 * 钉死四件事：源片段不产出 op、特效片段不产出 op、绑定链不生效、
 * 转场的邻接按「看不见的片段不存在」算（否则隐藏的邻居会从转场里漏回来）。
 */
describe('buildStack：片段级开关（hidden）', () => {
  it('隐藏的 source 片段不产出 op，其它片段照常（z 不变）', () => {
    const p = projectWithTracks(['顶', '底']);
    (p.tracks[0] as VisualTrack).clips[0]!.hidden = true;
    const ops = buildStack(p, 1);
    expect(ops).toHaveLength(1);
    const only = ops[0]!;
    if (only.type !== 'source') throw new Error('应为 source');
    expect(only.source.clip.label).toBe('底');
    // z 由轨道下标决定，过滤片段不影响它（与禁用轨同一条边界）。
    expect(only.z).toBe(0);
  });

  it('隐藏的 effect 片段不产出 op（adjustment layer 整段失效）', () => {
    const p = defaultProject('测试');
    p.duration = 10;
    const fx = fxClip('fx');
    fx.hidden = true;
    p.tracks.push({ kind: 'visual', id: 'v1', name: 'V1', enabled: true, clips: [srcClip('src'), fx] });
    expect(buildStack(p, 1).map((o) => o.type)).toEqual(['source']);
  });

  it('挂在隐藏特效片段上的链不生效（那一层保持原样）', () => {
    const p = defaultProject('测试');
    p.duration = 10;
    const src = srcClip('src');
    const fx = fxClip('bind');
    fx.boundClipId = src.id;
    fx.hidden = true;
    p.tracks.push({ kind: 'visual', id: 'v1', name: 'V1', enabled: true, clips: [src] });
    p.tracks.push({ kind: 'visual', id: 'v2', name: 'V2', enabled: true, clips: [fx] });
    const op = buildStack(p, 1)[0]!;
    if (op.type !== 'source') throw new Error('应为 source');
    expect(op.source.bound).toBeUndefined();
  });

  it('转场另一侧的片段被隐藏 ⇒ 那一侧按透明（不会从转场里漏回来）', () => {
    const { p, to } = transitionProject();
    to.hidden = true;
    const op = buildStack(p, 1.6)[0]!;
    if (op.type !== 'transition') throw new Error('应为 transition');
    expect(op.to).toBeNull();
    expect(op.single).toBe('from');
    // 窗口后半段（越过 from.end）也只画透明那一半，仍然只有一个 op。
    expect(buildStack(p, 2.2).map((o) => o.type)).toEqual(['transition']);
  });

  it('隐藏的片段仍在片段表里（几何没变，只是不产出）', () => {
    const p = projectWithTracks(['唯一']);
    const track = p.tracks[0] as VisualTrack;
    track.clips[0]!.hidden = true;
    expect(buildStack(p, 1)).toHaveLength(0);
    // 时间跨度、转场、拖拽全部照旧 —— 隐藏不是删除。
    expect(track.clips).toHaveLength(1);
    expect(track.clips[0]!.start).toBe(0);
    expect(track.clips[0]!.end).toBe(10);
  });
});
