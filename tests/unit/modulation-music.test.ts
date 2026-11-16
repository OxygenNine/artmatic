import { describe, expect, it } from 'vitest';
import {
  MUSIC_VARS,
  ZERO_MUSIC,
  evalExpr,
  fitsBlocks,
  isMusicVar,
  parseCached,
  printExpr,
  type ExprCtx,
  type MusicSample,
} from '../../src/core/expr';
import { modTable, resolveParam, type ModTable, type ResolveCtx } from '../../src/core/modulation';
import type { BeatGrid } from '../../src/core/time';

/**
 * 调制器里的音频 / 段落变量。
 *
 * 判据是三条「错了就会静默」的事：
 *
 * 1. **没有音频时全部是有限数**。NaN 进 uniform 之后画面全黑，而没有任何报错
 *    指向那个表达式。
 * 2. **`bar` / `beatInBar` 不依赖音频**。它们由拍网格算；否则同一段表达式在
 *    静音工程里会退化成 0，而用户看不出原因。
 * 3. **文本 ↔ AST 往返不变形**，且能进积木视图。
 */

const GRID: BeatGrid = { bpm: 120, offset: 0, beatsPerBar: 4 };

function sample(over: Partial<MusicSample> = {}): MusicSample {
  return { ...ZERO_MUSIC, ...over };
}

function parse(src: string) {
  const r = parseCached(src);
  if (!r.ok) throw new Error(`parse failed: ${src} → ${r.error.code}`);
  return r.ast;
}

function evalWith(src: string, music?: MusicSample, beat = 0): number {
  const ctx: ExprCtx = { t: 0, beat, fps: 30, seed: 0, ...(music ? { music } : {}) };
  return evalExpr(parse(src), ctx);
}

/**
 * 经 `resolveParam` 求值 —— **这是 `bar` / `beatInBar` 的唯一验证路径**，
 * 因为折叠发生在 `exprCtx` 里，`evalExpr` 只负责读 `ctx.music`。
 */
function resolveExpr(src: string, opts: { t: number; grid?: BeatGrid; music?: MusicSample }): number {
  const mods: ModTable = modTable([
    { id: 'm', name: 'm', expr: src, unit: { min: 0, max: 1 } },
  ]);
  const clip = { curves: {}, mods: { p: [{ ref: 'm', gain: 1, mode: 'add' as const }] } };
  const ctx: ResolveCtx = {
    grid: opts.grid ?? GRID,
    fps: 30,
    seed: 0,
    clipStart: 0,
    mods,
    ...(opts.music ? { music: () => opts.music! } : {}),
  };
  return resolveParam(clip, 'p', 0, opts.t, ctx);
}

describe('音乐变量：解析与打印', () => {
  it('15 个变量全部可解析，print 回同一个标识符，且能进积木', () => {
    for (const name of MUSIC_VARS) {
      const ast = parse(name);
      expect(printExpr(ast)).toBe(name);
      expect(fitsBlocks(ast)).toBe(true);
    }
  });

  it('isMusicVar 只认表里的名字（beat / t / pi 不算）', () => {
    expect(isMusicVar('rms')).toBe(true);
    expect(isMusicVar('beat')).toBe(false);
    expect(isMusicVar('t')).toBe(false);
    expect(isMusicVar('pi')).toBe(false);
  });

  it('拼错的名字仍然报 unknownIdent（不静默变 0）', () => {
    expect(parseCached('rmss').ok).toBe(false);
  });
});

describe('音乐变量：求值', () => {
  it('直接读采样值', () => {
    expect(evalWith('rms * 10', sample({ rms: 0.5 }))).toBeCloseTo(5, 9);
    expect(evalWith('energy', sample({ energy: 2.4 }))).toBeCloseTo(2.4, 9);
    expect(evalWith('sectionU', sample({ sectionU: 0.25 }))).toBeCloseTo(0.25, 9);
    expect(evalWith('section', sample({ section: 3 }))).toBeCloseTo(3, 9);
  });

  it('没有 music 上下文时一律 0，且是有限数', () => {
    const out = evalWith('rms + energy + section + novelty');
    expect(out).toBe(0);
    expect(Number.isFinite(out)).toBe(true);
  });

  it('采样器给出 NaN / Infinity 时兜底成 0', () => {
    expect(evalWith('rms', sample({ rms: NaN }))).toBe(0);
    expect(evalWith('energy', sample({ energy: Infinity }))).toBe(0);
  });
});

describe('音乐变量：bar / beatInBar 走拍网格（无音频也有值）', () => {
  it('120 BPM / 4 拍：2.5 秒 = 第 5 拍 → bar 1.25、beatInBar 1', () => {
    expect(resolveExpr('bar', { t: 2.5 })).toBeCloseTo(1.25, 9);
    expect(resolveExpr('beatInBar', { t: 2.5 })).toBeCloseTo(1, 9);
  });

  it('小节起点处 bar 是整数、beatInBar 是 0', () => {
    // 一跳 2 秒（120 BPM / 4 拍），t=4s 正好是第 2 小节的第一拍
    expect(resolveExpr('bar', { t: 4 })).toBeCloseTo(2, 9);
    expect(resolveExpr('beatInBar', { t: 4 })).toBeCloseTo(0, 9);
  });

  it('负拍（offset 落在 0 秒之后）时 beatInBar 仍落在 0..bpb', () => {
    const grid: BeatGrid = { bpm: 120, offset: 1, beatsPerBar: 4 };
    const v = resolveExpr('beatInBar', { t: 0.2, grid });
    expect(v).toBeGreaterThanOrEqual(0);
    expect(v).toBeLessThan(4);
    // offset=1s、t=0.2s → beat = -1.6 → bar = -0.4
    expect(resolveExpr('bar', { t: 0.2, grid })).toBeCloseTo(-0.4, 9);
  });
});

describe('音乐变量：经调制槽生效', () => {
  it('add 槽把能量加到参数上', () => {
    const mods = modTable([{ id: 'e', name: 'e', expr: 'energy * 10', unit: { min: 0, max: 30 } }]);
    const clip = { curves: {}, mods: { zoom: [{ ref: 'e', gain: 1, mode: 'add' as const }] } };
    const ctx: ResolveCtx = {
      grid: GRID,
      fps: 30,
      seed: 1,
      clipStart: 0,
      mods,
      music: () => sample({ energy: 2.5 }),
    };
    expect(resolveParam(clip, 'zoom', 1, 0, ctx)).toBeCloseTo(26, 9);
  });

  it('add 槽在没有音乐时是空操作（画面不变）', () => {
    const mods = modTable([{ id: 'e', name: 'e', expr: 'energy', unit: { min: 0, max: 3 } }]);
    const clip = { curves: {}, mods: { zoom: [{ ref: 'e', gain: 1, mode: 'add' as const }] } };
    const ctx: ResolveCtx = { grid: GRID, fps: 30, seed: 1, clipStart: 0, mods };
    expect(resolveParam(clip, 'zoom', 3, 0, ctx)).toBeCloseTo(3, 9);
  });

  it('mul 槽 gain=0 是空操作；gain=1 严格等于全乘（无音乐时乘 0）', () => {
    const mods = modTable([{ id: 'e', name: 'e', expr: 'energy', unit: { min: 0, max: 3 } }]);
    const clip = (gain: number) => ({
      curves: {},
      mods: { zoom: [{ ref: 'e', gain, mode: 'mul' as const }] },
    });
    const ctx: ResolveCtx = { grid: GRID, fps: 30, seed: 1, clipStart: 0, mods };
    expect(resolveParam(clip(0), 'zoom', 3, 0, ctx)).toBeCloseTo(3, 9);
    expect(resolveParam(clip(1), 'zoom', 3, 0, ctx)).toBeCloseTo(0, 9);
  });
});
