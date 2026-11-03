import { describe, expect, it } from 'vitest';
import {
  defaultChild,
  evalExpr,
  exprAtPath,
  fitsBlocks,
  parseCached,
  printExpr,
  replaceAtPath,
  slotAt,
  slotCount,
  type ExprNode,
  type ExprCtx,
} from '../../src/core/expr';

const ctx = (over: Partial<ExprCtx> = {}): ExprCtx => ({
  t: 1,
  beat: 2,
  fps: 30,
  seed: 7,
  ...over,
});

/** 解析并求值；解析失败时直接让测试炸在断言处而不是 undefined。 */
function ev(src: string, over: Partial<ExprCtx> = {}): number {
  const r = parseCached(src);
  if (!r.ok) throw new Error(`parse failed: ${src} (${r.error.code})`);
  return evalExpr(r.ast, ctx(over));
}

function ast(src: string): ExprNode {
  const r = parseCached(src);
  if (!r.ok) throw new Error(`parse failed: ${src} (${r.error.code})`);
  return r.ast;
}

describe('expr：解析', () => {
  it('优先级：乘除先于加减，括号覆盖', () => {
    expect(ev('1 + 2 * 3')).toBe(7);
    expect(ev('(1 + 2) * 3')).toBe(9);
    expect(ev('2 - 3 - 4')).toBe(-5);
    expect(ev('12 / 3 / 2')).toBe(2);
  });

  it('一元负号比乘号紧、比幂松：-2^2 = -4', () => {
    expect(ev('-2 * 3')).toBe(-6);
    expect(ev('-2 ^ 2')).toBe(-4);
    expect(ev('2 ^ 3 ^ 2')).toBe(512);
  });

  it('取余跟浮点除的语义（不是 JS 的 %）', () => {
    expect(ev('-1 % 4')).toBe(3);
    expect(ev('7 % 4')).toBe(3);
    // 除零不返回 NaN（那会让整帧变黑），给 0。
    expect(ev('1 % 0')).toBe(0);
    expect(ev('1 / 0')).toBe(0);
  });

  it('t / beat / 常量', () => {
    expect(ev('t', { t: 2.5 })).toBe(2.5);
    expect(ev('beat', { beat: 3 })).toBe(3);
    expect(ev('pi')).toBeCloseTo(Math.PI, 12);
    expect(ev('tau')).toBeCloseTo(Math.PI * 2, 12);
  });

  it('未知标识符 / 未知函数 / 参数个数不对都报错而不是求 0', () => {
    for (const src of ['foo', 'nope(1)', 'clamp(1, 2)', 'sin()']) {
      const r = parseCached(src);
      expect(r.ok, src).toBe(false);
    }
  });

  it('报错位置落在源串的可索引范围内', () => {
    const r = parseCached('1 + $');
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.code).toBe('unexpectedChar');
      expect(r.error.at).toBe(4);
    }
  });

  it('空表达式与未闭合括号', () => {
    expect(parseCached('').ok).toBe(false);
    expect(parseCached('   ').ok).toBe(false);
    expect(parseCached('(1 + 2').ok).toBe(false);
  });
});

describe('expr：打印往返', () => {
  const cases = [
    't',
    'beat',
    '1 + 2 * 3',
    '(1 + 2) * 3',
    'sin(t * 2 * pi)',
    '-abs(t)',
    'clamp(t, 0, 1)',
    'map(t, 0, 1, -1, 1)',
    'noise(t, 3, 1)',
    't > 1 ? 1 : 0',
    'modulator("m1") + 1',
    '2 ^ 3 ^ 2',
  ];

  it('print → parse 得到同一棵树', () => {
    for (const src of cases) {
      const once = printExpr(ast(src));
      const twice = printExpr(ast(once));
      expect(twice, src).toBe(once);
      expect(evalExpr(ast(once), ctx()), src).toBeCloseTo(evalExpr(ast(src), ctx()), 12);
    }
  });
});

describe('expr：求值', () => {
  it('内建函数对手算', () => {
    expect(ev('abs(-3)')).toBe(3);
    expect(ev('floor(2.7)')).toBe(2);
    expect(ev('ceil(2.1)')).toBe(3);
    expect(ev('fract(2.25)')).toBeCloseTo(0.25, 12);
    expect(ev('sign(-3)')).toBe(-1);
    expect(ev('clamp(5, 0, 1)')).toBe(1);
    expect(ev('map(0.5, 0, 1, 0, 100)')).toBeCloseTo(50, 12);
    expect(ev('step(0.5, 0.4)')).toBe(0);
    expect(ev('step(0.5, 0.6)')).toBe(1);
    expect(ev('smooth(0.5)')).toBeCloseTo(0.5, 12);
    expect(ev('mod(7, 3)')).toBeCloseTo(1, 12);
  });

  it('map 的输入区间退化时不返回 Infinity', () => {
    expect(ev('map(1, 2, 2, 5, 9)')).toBe(5);
  });

  it('三元：条件非 0 取前者', () => {
    expect(ev('1 > 0 ? 10 : 20')).toBe(10);
    expect(ev('1 < 0 ? 10 : 20')).toBe(20);
  });

  it('lfo 是闭式的：同一 t 恒同值，且落在 -1..1', () => {
    for (let t = 0; t < 4; t += 0.37) {
      const a = ev('lfo(t, 2, 0)', { t });
      const b = ev('lfo(t, 2, 0)', { t });
      expect(a).toBe(b);
      expect(Math.abs(a)).toBeLessThanOrEqual(1.0000001);
    }
    // 正弦形态：四分之一周期处应为 +1。
    expect(ev('lfo(t, 1, 0)', { t: 0.25 })).toBeCloseTo(1, 9);
  });

  it('noise / fbm 有界且同参同值（无 sin，大参数不漂）', () => {
    for (const t of [0, 1.5, 1000.5, 98765.25]) {
      const n = ev('noise(t, 4, 3)', { t });
      expect(n).toBe(ev('noise(t, 4, 3)', { t }));
      expect(Math.abs(n)).toBeLessThanOrEqual(1.0000001);
      const f = ev('fbm(t, 4, 3)', { t });
      expect(Math.abs(f)).toBeLessThanOrEqual(1.0000001);
    }
  });

  it('rand 只依赖种子，不是序列', () => {
    expect(ev('rand(1)')).toBe(ev('rand(1)'));
    expect(ev('rand(1)')).not.toBe(ev('rand(2)'));
  });

  it('modulator(...) 交给回调；没有回调时是 0（不是自引用）', () => {
    const a = ast('modulator("m1") * 2');
    expect(evalExpr(a, ctx())).toBe(0);
    expect(evalExpr(a, ctx({ mod: (id) => (id === 'm1' ? 3 : 0) }))).toBe(6);
  });

  it('param(...) 读 ctx.params，缺省 0', () => {
    expect(ev('param("transform.x")')).toBe(0);
    expect(evalExpr(ast('param("a")'), ctx({ params: { a: 4 } }))).toBe(4);
  });
});

describe('expr：积木视图的编辑原语', () => {
  it('slotCount / slotAt 与节点形状一致', () => {
    const node = ast('clamp(t, 0, 1)');
    expect(slotCount(node)).toBe(3);
    expect(slotAt(node, 0)?.k).toBe('time');
    expect(slotAt(node, 3)).toBeNull();
  });

  it('replaceAtPath 换掉深层子树且不动兄弟', () => {
    const root = ast('sin(t) + clamp(t, 0, 1)');
    const next = replaceAtPath(root, [1, 1], { k: 'num', v: 9 });
    expect(printExpr(next)).toBe('sin(t) + clamp(t, 9, 1)');
    expect(exprAtPath(next, [1, 1])).toEqual({ k: 'num', v: 9 });
    // 原树不变（不可变更新）
    expect(printExpr(root)).toBe('sin(t) + clamp(t, 0, 1)');
  });

  it('空路径 = 换根', () => {
    expect(printExpr(replaceAtPath(ast('1 + 2'), [], defaultChild()))).toBe('0');
  });

  it('fitsBlocks：条件 / 比较 / 参数引用不在词汇表里', () => {
    expect(fitsBlocks(ast('sin(t) + 1'))).toBe(true);
    expect(fitsBlocks(ast('t > 1 ? 1 : 0'))).toBe(false);
    expect(fitsBlocks(ast('param("a")'))).toBe(false);
    expect(fitsBlocks(ast('t < 1'))).toBe(false);
  });

  it('解析缓存返回同一棵树对象（每帧多次求值不重复解析）', () => {
    const a = parseCached('sin(t)');
    const b = parseCached('sin(t)');
    expect(a.ok && b.ok && a.ast === b.ast).toBe(true);
  });
});
