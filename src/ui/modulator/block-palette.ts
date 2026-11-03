/**
 * block-palette.ts — 积木词汇表：能插进表达式树里的形状清单（纯数据）。
 *
 * 每条模板只负责「造一个节点」，不关心它被放在哪儿 —— 落点在调用方
 * （`BlockNode` 把当前子树整个换掉）。
 *
 * 函数名**原样显示、不翻译**：它是用户在文本模式里亲手打的标识符。给 `fract`
 * 配一句中文注释听起来友好，但那会让积木与文本变成两套词汇，切回来要么对不上、
 * 要么两边各维护一份说法。需要解释时切到文本，那里本来自带语法。
 *
 * 分组不是装饰：一组就是「这一类东西在哪」。数学组按字母序，别按使用频率排 ——
 * 位置固定的清单才能被记住。
 */
import type { MessageKey } from '../../i18n/locales';
import type { BinOp, ExprNode } from '../../core/expr';

export interface BlockTemplate {
  id: string;
  /** 组内显示文本。函数名与运算符是原样的 ASCII，不用文案键。 */
  label?: string;
  /** 没有 `label` 时用它。 */
  labelKey?: MessageKey;
  /** 造节点。`modId` 只给 `mod` 模板用（引用第一个调制器）。 */
  make(modId?: string): ExprNode;
}

export interface BlockGroup {
  id: string;
  labelKey: MessageKey;
  items: BlockTemplate[];
}

const num = (v = 0): ExprNode => ({ k: 'num', v });

const BIN_OPS: { op: BinOp; label: string }[] = [
  { op: '+', label: '+' },
  { op: '-', label: '-' },
  { op: '*', label: '×' },
  { op: '/', label: '÷' },
  { op: '%', label: 'mod' },
];

/** 一元的函数（只有一个参数）。 */
const UNARY = ['abs', 'floor', 'ceil', 'round', 'fract', 'sign', 'sqrt', 'exp', 'log'] as const;
/** 二元的函数。 */
const BINARY = ['min', 'max', 'pow', 'mod', 'step', 'atan2'] as const;
/** 波形 / 噪声。参数个数与 `core/expr.ts` 的 `EXPR_FUNCS` 必须一致。 */
const WAVES: { fn: string; arity: number }[] = [
  { fn: 'sin', arity: 1 },
  { fn: 'cos', arity: 1 },
  { fn: 'tan', arity: 1 },
  { fn: 'smooth', arity: 1 },
  { fn: 'rand', arity: 1 },
  { fn: 'noise', arity: 3 },
  { fn: 'fbm', arity: 3 },
  { fn: 'lfo', arity: 3 },
];

const call = (fn: string, arity: number): ExprNode => ({
  k: 'call',
  fn,
  args: Array.from({ length: arity }, () => num()),
});

export function blockGroups(): BlockGroup[] {
  return [
    {
      id: 'value',
      labelKey: 'mod.blk.group.value',
      items: [
        { id: 'num', labelKey: 'mod.blk.num', make: () => num() },
        { id: 'unary-neg', labelKey: 'mod.blk.unary', make: () => ({ k: 'un', op: '-', a: num() }) },
        ...BIN_OPS.map((o) => ({
          id: `bin-${o.op}`,
          label: o.label,
          make: (): ExprNode => ({ k: 'bin', op: o.op, a: num(), b: num(1) }),
        })),
      ],
    },
    {
      id: 'time',
      labelKey: 'mod.blk.group.time',
      items: [
        { id: 'time', labelKey: 'mod.blk.time', make: () => ({ k: 'time' }) },
        { id: 'beat', labelKey: 'mod.blk.beat', make: () => ({ k: 'beat' }) },
      ],
    },
    {
      id: 'ref',
      labelKey: 'mod.blk.group.ref',
      items: [
        {
          id: 'mod',
          labelKey: 'mod.blk.mod',
          make: (modId) => (modId ? { k: 'mod', id: modId } : num()),
        },
      ],
    },
    {
      id: 'math',
      labelKey: 'mod.blk.group.math',
      items: [
        ...UNARY.map((fn) => ({ id: `fn-${fn}`, label: fn, make: () => call(fn, 1) })),
        ...BINARY.map((fn) => ({ id: `fn-${fn}`, label: fn, make: () => call(fn, 2) })),
        { id: 'fn-clamp', label: 'clamp', make: () => call('clamp', 3) },
        { id: 'fn-map', label: 'map', make: () => call('map', 5) },
      ],
    },
    {
      id: 'wave',
      labelKey: 'mod.blk.group.wave',
      items: WAVES.map(({ fn, arity }) => ({
        id: `fn-${fn}`,
        label: fn,
        make: () => call(fn, arity),
      })),
    },
  ];
}
