import { describe, expect, it } from 'vitest';
import {
  MOD_DEFAULT_GAIN,
  dropModRefs,
  emptyModTable,
  modTable,
  modulatorRefs,
  modulatorValue,
  paramLayer,
  resolveParam,
  sanitizeClipMods,
  sanitizeModulators,
  type ClipMods,
  type ModSlot,
  type Modulator,
  type ResolveCtx,
} from '../../src/core/modulation';
import type { Curve } from '../../src/core/curve';

const GRID = { bpm: 120, offset: 0, beatsPerBar: 4 };

const MODS: Modulator[] = [
  { id: 'a', name: 'A', expr: 't', unit: { min: -1, max: 1 } },
  { id: 'b', name: 'B', expr: '1', unit: { min: -1, max: 1 } },
  { id: 'two', name: 'Two', expr: '2', unit: { min: -1, max: 1 } },
];

function ctx(over: Partial<ResolveCtx> = {}): ResolveCtx {
  return {
    grid: GRID,
    fps: 30,
    seed: 1,
    clipStart: 0,
    mods: modTable(MODS),
    ...over,
  };
}

const clip = (mods?: Record<string, ModSlot[]>, curves: Record<string, Curve> = {}) => ({
  curves,
  mods,
});

describe('resolveParam：唯一入口', () => {
  it('没有曲线也没有调制：原样返回基值', () => {
    expect(resolveParam(clip(), 'x', 0.25, 3, ctx())).toBe(0.25);
  });

  it('有曲线时曲线覆盖基值（不是相加）', () => {
    const c = clip(undefined, { x: { keys: [{ t: 0, v: 0, interp: 'linear' }, { t: 10, v: 1, interp: 'linear' }] } });
    expect(resolveParam(c, 'x', 0.9, 5, ctx())).toBeCloseTo(0.5, 9);
  });

  it('add：v + gain·m', () => {
    const c = clip({ x: [{ ref: 'two', gain: 3, mode: 'add' }] });
    expect(resolveParam(c, 'x', 1, 0, ctx())).toBe(7);
  });

  it('mul：v · mix(1, m, gain)', () => {
    const c = clip({ x: [{ ref: 'two', gain: 1, mode: 'mul' }] });
    expect(resolveParam(c, 'x', 5, 0, ctx())).toBe(10);
    const half = clip({ x: [{ ref: 'two', gain: 0.5, mode: 'mul' }] });
    // mix(1, 2, 0.5) = 1.5
    expect(resolveParam(half, 'x', 5, 0, ctx())).toBeCloseTo(7.5, 9);
  });

  it('gain = 0 严格等于「不生效」（两种模式都成立）', () => {
    for (const mode of ['add', 'mul'] as const) {
      const c = clip({ x: [{ ref: 'two', gain: 0, mode }] });
      expect(resolveParam(c, 'x', 5, 0, ctx())).toBe(5);
    }
  });

  it('曲线 + 调制叠加（两者不互斥）', () => {
    const c = clip(
      { x: [{ ref: 'two', gain: 1, mode: 'add' }] },
      { x: { keys: [{ t: 0, v: 0, interp: 'linear' }, { t: 10, v: 10, interp: 'linear' }] } },
    );
    expect(resolveParam(c, 'x', 999, 5, ctx())).toBeCloseTo(7, 9);
  });

  it('多个 add 槽的顺序无关', () => {
    const one = clip({ x: [{ ref: 'two', gain: 1, mode: 'add' }, { ref: 'b', gain: 2, mode: 'add' }] });
    const other = clip({ x: [{ ref: 'b', gain: 2, mode: 'add' }, { ref: 'two', gain: 1, mode: 'add' }] });
    expect(resolveParam(one, 'x', 0, 0, ctx())).toBe(resolveParam(other, 'x', 0, 0, ctx()));
  });

  it('悬空调制器引用：跳过（= 不生效），不是 NaN', () => {
    const c = clip({ x: [{ ref: 'gone', gain: 1, mode: 'add' }] });
    expect(resolveParam(c, 'x', 3, 0, ctx())).toBe(3);
  });

  it('表达式算成非有限值时退回基值', () => {
    const broken: Modulator[] = [{ id: 'bad', name: 'bad', expr: 'log(-1)', unit: { min: 0, max: 1 } }];
    const c = clip({ x: [{ ref: 'bad', gain: 1, mode: 'add' }] });
    expect(resolveParam(c, 'x', 2, 0, ctx({ mods: modTable(broken) }))).toBe(2);
  });

  it('同一 t 同值（与调用顺序无关）', () => {
    const c = clip({ x: [{ ref: 'a', gain: 2, mode: 'add' }] });
    const first = resolveParam(c, 'x', 0, 1.25, ctx());
    expect(resolveParam(c, 'x', 0, 1.25, ctx())).toBe(first);
    expect(first).toBeCloseTo(2.5, 9);
  });
});

describe('modulatorValue：环与深度', () => {
  it('自引用返回 0 而不是栈溢出', () => {
    const self: Modulator[] = [{ id: 's', name: 's', expr: 'modulator("s")', unit: { min: 0, max: 1 } }];
    expect(modulatorValue('s', 1, ctx({ mods: modTable(self) }))).toBe(0);
  });

  it('A → B → A 的两环也返回 0', () => {
    const cyc: Modulator[] = [
      { id: 'a', name: 'a', expr: 'modulator("b")', unit: { min: 0, max: 1 } },
      { id: 'b', name: 'b', expr: 'modulator("a")', unit: { min: 0, max: 1 } },
    ];
    expect(modulatorValue('a', 1, ctx({ mods: modTable(cyc) }))).toBe(0);
  });

  it('正常引用串联算得出来', () => {
    const chain: Modulator[] = [
      { id: 'outer', name: 'o', expr: 'modulator("inner") * 2', unit: { min: 0, max: 1 } },
      { id: 'inner', name: 'i', expr: '3', unit: { min: 0, max: 1 } },
    ];
    expect(modulatorValue('outer', 0, ctx({ mods: modTable(chain) }))).toBe(6);
  });

  it('beat 走工程网格（改 BPM 后同一秒的拍号变了）', () => {
    const m: Modulator[] = [{ id: 'bt', name: 'bt', expr: 'beat', unit: { min: 0, max: 8 } }];
    const slow = modulatorValue('bt', 1, ctx({ mods: modTable(m), grid: { bpm: 60, offset: 0, beatsPerBar: 4 } }));
    const fast = modulatorValue('bt', 1, ctx({ mods: modTable(m), grid: { bpm: 120, offset: 0, beatsPerBar: 4 } }));
    expect(slow).toBe(1);
    expect(fast).toBe(2);
  });
});

describe('paramLayer：三态判据', () => {
  it('none / kc / mod / both', () => {
    expect(paramLayer(false, false)).toBe('none');
    expect(paramLayer(true, false)).toBe('kc');
    expect(paramLayer(false, true)).toBe('mod');
    expect(paramLayer(true, true)).toBe('both');
  });
});

describe('清洗：坏数据不能让工程打不开', () => {
  it('重复 id / 缺 id 整条丢弃，名字与区间回落', () => {
    const list = sanitizeModulators([
      { id: 'a', name: 'A', expr: 't' },
      { id: 'a', name: 'dup', expr: 't' },
      { name: 'no id' },
      { id: 'b', expr: 't', unit: { min: 5, max: 5 } },
    ]);
    expect(list.map((m) => m.id)).toEqual(['a', 'b']);
    expect(list[1]!.unit).toEqual({ min: 5, max: 6 });
  });

  it('非数组输入得到空表（旧工程没有这个字段）', () => {
    expect(sanitizeModulators(undefined)).toEqual([]);
    expect(sanitizeModulators({})).toEqual([]);
  });

  it('片段的 mods：悬空 ref 与坏形状逐槽丢弃，空键删除', () => {
    const table = modTable(MODS);
    const out = sanitizeClipMods(
      {
        x: [{ ref: 'gone', gain: 1, mode: 'add' }, { ref: 'two', gain: Number.NaN, mode: 'weird' }],
        y: [{ ref: 'gone', gain: 1, mode: 'add' }],
      },
      table,
    );
    expect(Object.keys(out ?? {})).toEqual(['x']);
    expect(out!.x).toHaveLength(1);
    expect(out!.x[0]).toEqual({ ref: 'two', gain: MOD_DEFAULT_GAIN, mode: 'add' });
    expect(sanitizeClipMods({ y: [] }, table)).toBeUndefined();
  });

  it('空表 + 空输入：不产生新对象', () => {
    expect(sanitizeClipMods(undefined, emptyModTable())).toBeUndefined();
  });
});

describe('引用扫描：删除调制器前要能列出受影响参数', () => {
  const clips: { id: string; label: string; mods?: ClipMods }[] = [
    { id: 'c1', label: '片段 1', mods: { 'transform.x': [{ ref: 'a', gain: 1, mode: 'add' }] } },
    {
      id: 'c2',
      label: '片段 2',
      mods: {
        'transform.x': [{ ref: 'a', gain: 1, mode: 'add' }],
        opacity: [{ ref: 'b', gain: 1, mode: 'mul' }],
      },
    },
  ];

  it('按片段 × 参数列出，只算真的引用了的', () => {
    const refs = modulatorRefs(MODS, clips, 'a');
    expect(refs).toEqual([
      { clipId: 'c1', clipLabel: '片段 1', key: 'transform.x', slots: 1 },
      { clipId: 'c2', clipLabel: '片段 2', key: 'transform.x', slots: 1 },
    ]);
    expect(modulatorRefs(MODS, clips, 'two')).toEqual([]);
  });

  it('dropModRefs 摘干净，没引用时返回原引用（不产生无谓的新对象）', () => {
    const next = dropModRefs(clips[1]!.mods, 'a');
    expect(next).toEqual({ opacity: [{ ref: 'b', gain: 1, mode: 'mul' }] });
    expect(dropModRefs(clips[0]!.mods, 'b')).toBe(clips[0]!.mods);
    // 全空时返回空对象 → 调用方据此 delete clip.mods
    expect(dropModRefs({ x: [{ ref: 'a', gain: 1, mode: 'add' }] }, 'a')).toEqual({});
  });
});
