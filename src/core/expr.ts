/**
 * expr.ts — 调制器表达式：AST、解析、打印、求值（纯函数，可单测）。
 *
 * **AST 是唯一真源**，积木是它的编辑视图，文本是逃生舱；两者双向同步，
 * 不存在「文本模式另存一份字符串然后在别处重新解析」的第二条路径。
 *
 * ## 全部闭式（硬约束 1.3）
 *
 * 求值只依赖 `t` / `beat` / 种子，**不许有跨帧递推**。`rand(seed)` 是
 * 「种子 → 值」的一次映射而不是序列；要随机游走写 `noise(t, freq, seed)` 或
 * `fbm`。这条不做的话 seek 会与顺序播放算出两条不同的曲线，而画面不会报错。
 *
 * ## 为什么自己写解析器而不是引表达式库
 *
 * 需要的语法必须能**打印回同一棵 AST**（积木与文本双向），通用库给的 AST
 * 形态各异且会在不认识的地方静默丢弃。这里不到 250 行的递归下降换来的是
 * 一条确定规则：解析失败就给位置，不猜。
 *
 * ## 数值口径
 *
 * `t` 是**绝对秒**（与 `evalCurve` 同一口径），`beat` 是绝对拍（可为小数、可为负），
 * `fps` 只给需要帧的量用。求值**不钳制** —— 钳制交给参数自己的 min/max，
 * 表达式里想要越界是用户的权利。
 */

/* ---------------------------------------------------------------- 节点 */

export type BinOp =
  | '+'
  | '-'
  | '*'
  | '/'
  | '%'
  | '^'
  | '<'
  | '<='
  | '>'
  | '>='
  | '=='
  | '!=';

export type ExprNode =
  /** 字面量。 */
  | { k: 'num'; v: number }
  /** 绝对秒。 */
  | { k: 'time' }
  /** 绝对拍（`beatAtTime` 的结果，可为小数）。 */
  | { k: 'beat' }
  /** 引用被调制片段自己的某个参数（文本模式专用，求值取 `ctx.params`）。 */
  | { k: 'param'; key: string }
  /** 引用另一个调制器。 */
  | { k: 'mod'; id: string }
  | { k: 'un'; op: '-' | '+'; a: ExprNode }
  | { k: 'bin'; op: BinOp; a: ExprNode; b: ExprNode }
  | { k: 'cond'; c: ExprNode; a: ExprNode; b: ExprNode }
  | { k: 'call'; fn: string; args: ExprNode[] };

/**
 * 内建函数表：名字 → 参数个数。
 *
 * 参数个数**写死**而不是可变参数：积木视图要按个数画出固定数量的插槽，
 * 而「多一个少一个也能算」会让文本与积木对不上（文本里 `clamp(x)` 缺参时
 * 积木画不出那块）。
 */
export const EXPR_FUNCS = {
  sin: 1,
  cos: 1,
  tan: 1,
  abs: 1,
  floor: 1,
  ceil: 1,
  round: 1,
  fract: 1,
  sign: 1,
  sqrt: 1,
  exp: 1,
  log: 1,
  smooth: 1,
  rand: 1,
  mod: 2,
  pow: 2,
  min: 2,
  max: 2,
  step: 2,
  atan2: 2,
  clamp: 3,
  map: 5,
  noise: 3,
  fbm: 3,
  lfo: 3,
} as const;

export type ExprFn = keyof typeof EXPR_FUNCS;

export function isExprFn(name: string): name is ExprFn {
  return Object.prototype.hasOwnProperty.call(EXPR_FUNCS, name);
}

/* -------------------------------------------------------------- 词法 */

/** `p` = 这个 token 在源串里的起始下标，只用于把报错指到具体字符。 */
type Token =
  | { t: 'num'; v: number; p: number }
  | { t: 'id'; v: string; p: number }
  | { t: 'str'; v: string; p: number }
  | { t: 'op'; v: string; p: number }
  | { t: 'end'; p: number };

export type ExprErrorCode =
  | 'unexpectedChar'
  | 'badNumber'
  | 'unclosedString'
  | 'unexpectedToken'
  | 'unexpectedEnd'
  | 'unknownIdent'
  | 'unknownFunc'
  | 'badArity'
  | 'empty'
  | 'tooDeep';

export interface ExprError {
  code: ExprErrorCode;
  /** 出错位置在源串里的下标（UI 用 `^` 指着它）。 */
  at: number;
}

export type ParseResult = { ok: true; ast: ExprNode } | { ok: false; error: ExprError };

/** 解析深度上限：挡住 `((((…))))` 这种让递归下降爆栈的输入。 */
const MAX_DEPTH = 32;

const OPS = ['<=', '>=', '==', '!=', '+', '-', '*', '/', '%', '^', '<', '>', '(', ')', ',', '?', ':'];

function tokenize(src: string): Token[] | ExprError {
  const out: Token[] = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i]!;
    if (c === ' ' || c === '\t' || c === '\n' || c === '\r') {
      i += 1;
      continue;
    }
    if (c === '"' || c === "'") {
      const quote = c;
      const start = i;
      let j = i + 1;
      let text = '';
      while (j < src.length && src[j] !== quote) {
        text += src[j];
        j += 1;
      }
      if (j >= src.length) return { code: 'unclosedString', at: start };
      out.push({ t: 'str', v: text, p: start });
      i = j + 1;
      continue;
    }
    if (c >= '0' && c <= '9') {
      const start = i;
      while (i < src.length && src[i]! >= '0' && src[i]! <= '9') i += 1;
      if (src[i] === '.') {
        i += 1;
        while (i < src.length && src[i]! >= '0' && src[i]! <= '9') i += 1;
      }
      if (src[i] === 'e' || src[i] === 'E') {
        const save = i;
        i += 1;
        if (src[i] === '+' || src[i] === '-') i += 1;
        if (src[i]! >= '0' && src[i]! <= '9') {
          while (i < src.length && src[i]! >= '0' && src[i]! <= '9') i += 1;
        } else {
          i = save;
        }
      }
      const v = Number(src.slice(start, i));
      if (!Number.isFinite(v)) return { code: 'badNumber', at: start };
      out.push({ t: 'num', v, p: start });
      continue;
    }
    // 小数以点开头（`.5`）也收 —— 手写文本里很常见，拒绝它只会换来一堆困惑。
    if (c === '.' && src[i + 1]! >= '0' && src[i + 1]! <= '9') {
      const start = i;
      i += 1;
      while (i < src.length && src[i]! >= '0' && src[i]! <= '9') i += 1;
      out.push({ t: 'num', v: Number(src.slice(start, i)), p: start });
      continue;
    }
    if (/[a-zA-Z_]/.test(c)) {
      const start = i;
      while (i < src.length && /[a-zA-Z0-9_]/.test(src[i]!)) i += 1;
      out.push({ t: 'id', v: src.slice(start, i), p: start });
      continue;
    }
    const op = OPS.find((o) => src.startsWith(o, i));
    if (op) {
      out.push({ t: 'op', v: op, p: i });
      i += op.length;
      continue;
    }
    return { code: 'unexpectedChar', at: i };
  }
  out.push({ t: 'end', p: src.length });
  return out;
}

/* -------------------------------------------------------------- 语法 */

const CONSTS: Record<string, number> = {
  pi: Math.PI,
  tau: Math.PI * 2,
  e: Math.E,
};

const CMP: ReadonlySet<string> = new Set(['<', '<=', '>', '>=', '==', '!=']);

class ParseFail {
  constructor(readonly error: ExprError) {}
}

function parseExpr(src: string): ParseResult {
  const toks = tokenize(src);
  if (!Array.isArray(toks)) return { ok: false, error: toks };
  if (toks.length <= 1) return { ok: false, error: { code: 'empty', at: 0 } };

  let pos = 0;
  const peek = (): Token => toks[pos]!;
  const at = (): number => peek().p;
  const isOp = (v: string): boolean => {
    const tk = peek();
    return tk.t === 'op' && tk.v === v;
  };

  function parseTernary(depth: number): ExprNode {
    const c = parseCompare(depth);
    if (!isOp('?')) return c;
    pos += 1;
    const a = parseTernary(depth);
    if (!isOp(':')) throw new ParseFail({ code: 'unexpectedToken', at: at() });
    pos += 1;
    const b = parseTernary(depth);
    return { k: 'cond', c, a, b };
  }

  function parseCompare(depth: number): ExprNode {
    let left = parseAdditive(depth);
    for (;;) {
      const tk = peek();
      if (tk.t !== 'op' || !CMP.has(tk.v)) break;
      pos += 1;
      left = { k: 'bin', op: tk.v as BinOp, a: left, b: parseAdditive(depth) };
    }
    return left;
  }

  function parseAdditive(depth: number): ExprNode {
    let left = parseMultiplicative(depth);
    for (;;) {
      const tk = peek();
      if (tk.t !== 'op' || (tk.v !== '+' && tk.v !== '-')) break;
      pos += 1;
      left = { k: 'bin', op: tk.v, a: left, b: parseMultiplicative(depth) };
    }
    return left;
  }

  function parseMultiplicative(depth: number): ExprNode {
    let left = parseUnary(depth);
    for (;;) {
      const tk = peek();
      if (tk.t !== 'op' || (tk.v !== '*' && tk.v !== '/' && tk.v !== '%')) break;
      pos += 1;
      left = { k: 'bin', op: tk.v, a: left, b: parseUnary(depth) };
    }
    return left;
  }

  function parseUnary(depth: number): ExprNode {
    if (isOp('-') || isOp('+')) {
      const op = (peek() as { v: '-' | '+' }).v;
      pos += 1;
      return { k: 'un', op, a: parseUnary(depth) };
    }
    return parsePower(depth);
  }

  /** `^` 右结合，并且比一元负号紧：`-2^2` = `-(2^2)`。 */
  function parsePower(depth: number): ExprNode {
    const base = parsePrimary(depth);
    if (!isOp('^')) return base;
    pos += 1;
    return { k: 'bin', op: '^', a: base, b: parseUnary(depth) };
  }

  function parseArgs(depth: number, arity: number): ExprNode[] {
    pos += 1; // (
    const args: ExprNode[] = [];
    if (isOp(')')) {
      pos += 1;
    } else {
      for (;;) {
        args.push(parseTernary(depth + 1));
        if (isOp(',')) {
          pos += 1;
          continue;
        }
        break;
      }
      if (!isOp(')')) throw new ParseFail({ code: 'unexpectedToken', at: at() });
      pos += 1;
    }
    if (args.length !== arity) throw new ParseFail({ code: 'badArity', at: at() });
    return args;
  }

  function parsePrimary(depth: number): ExprNode {
    if (depth > MAX_DEPTH) throw new ParseFail({ code: 'tooDeep', at: at() });
    const tk = peek();
    if (tk.t === 'num') {
      pos += 1;
      return { k: 'num', v: tk.v };
    }
    if (tk.t === 'op' && tk.v === '(') {
      pos += 1;
      const inner = parseTernary(depth + 1);
      if (!isOp(')')) throw new ParseFail({ code: 'unexpectedToken', at: at() });
      pos += 1;
      return inner;
    }
    if (tk.t === 'id') {
      pos += 1;
      const name = tk.v;
      if (isOp('(')) {
        /*
         * 引用类只接受**字符串字面量**。`param(transform.x)` 里的 `transform.x`
         * 会被词法切成 `transform` `.` `x` —— 那不是任何一种合法的键，
         * 早报错比猜一个空串好（空串会让这个参数静默读成 0）。
         */
        if (name === 'param' || name === 'modulator') {
          pos += 1; // (
          const arg = peek();
          if (arg.t !== 'str') throw new ParseFail({ code: 'unexpectedToken', at: arg.p });
          pos += 1;
          if (!isOp(')')) throw new ParseFail({ code: 'unexpectedToken', at: at() });
          pos += 1;
          return name === 'param' ? { k: 'param', key: arg.v } : { k: 'mod', id: arg.v };
        }
        if (!isExprFn(name)) throw new ParseFail({ code: 'unknownFunc', at: tk.p });
        return { k: 'call', fn: name, args: parseArgs(depth, EXPR_FUNCS[name]) };
      }
      if (name === 't') return { k: 'time' };
      if (name === 'beat') return { k: 'beat' };
      if (name in CONSTS) return { k: 'num', v: CONSTS[name]! };
      throw new ParseFail({ code: 'unknownIdent', at: tk.p });
    }
    throw new ParseFail({ code: 'unexpectedToken', at: tk.p });
  }

  try {
    const ast = parseTernary(0);
    if (peek().t !== 'end') throw new ParseFail({ code: 'unexpectedToken', at: at() });
    return { ok: true, ast };
  } catch (e) {
    if (e instanceof ParseFail) return { ok: false, error: e.error };
    throw e;
  }
}

/**
 * 解析缓存：同一个表达式串在一帧里会被求值几十次（每个绑定了它的参数各一次）。
 */
const CACHE_LIMIT = 256;
const cache = new Map<string, ParseResult>();

export function parseCached(src: string): ParseResult {
  const hit = cache.get(src);
  if (hit) return hit;
  const res = parseExpr(src);
  if (cache.size >= CACHE_LIMIT) {
    // 淘汰最老的一条（Map 保持插入序）。不需要 LRU 精度：表达式数量是十几个量级。
    const first = cache.keys().next();
    if (!first.done) cache.delete(first.value);
  }
  cache.set(src, res);
  return res;
}

/* -------------------------------------------------------------- 打印 */

const PREC: Record<BinOp, number> = {
  '<': 2,
  '<=': 2,
  '>': 2,
  '>=': 2,
  '==': 2,
  '!=': 2,
  '+': 3,
  '-': 3,
  '*': 4,
  '/': 4,
  '%': 4,
  '^': 6,
};

function numText(v: number): string {
  if (!Number.isFinite(v)) return '0';
  /*
   * 三个常数打回符号形式。不这么做的话 `sin(t * 2 * pi)` 打印成
   * `sin(t * 2 * 3.141593)` —— 六位小数截断会让往返后的值差 1e-6，
   * 而这个差值恰好落在「同一 t 两渲要逐像素相同」会用的量级上。
   */
  if (v === Math.PI) return 'pi';
  if (v === Math.PI * 2) return 'tau';
  if (v === Math.E) return 'e';
  if (Number.isInteger(v)) return String(v);
  const abs = Math.abs(v);
  // 极小 / 极大值走指数写法：`toFixed(6)` 会把 1e-7 抹成 0（静默改成另一个表达式）。
  if (abs < 1e-4 || abs >= 1e9) return String(v);
  // 其余 6 位小数足够表达任何 UI 输入；再长只是浮点噪声（0.30000000000000004）。
  return String(Number(v.toFixed(6)));
}

/** AST → 文本。打印结果再解析回来必须得到同一棵 AST（往返守卫在单测里）。 */
export function printExpr(node: ExprNode): string {
  switch (node.k) {
    case 'num':
      return numText(node.v);
    case 'time':
      return 't';
    case 'beat':
      return 'beat';
    case 'param':
      return `param(${JSON.stringify(node.key)})`;
    case 'mod':
      return `modulator(${JSON.stringify(node.id)})`;
    case 'un':
      return `${node.op}${wrap(node.a, 5)}`;
    case 'bin':
      return `${wrap(node.a, PREC[node.op])} ${node.op} ${wrap(node.b, PREC[node.op] + (node.op === '^' ? -1 : 1))}`;
    case 'cond':
      return `${wrap(node.c, 2)} ? ${wrap(node.a, 1)} : ${wrap(node.b, 1)}`;
    case 'call':
      return `${node.fn}(${node.args.map((a) => printExpr(a)).join(', ')})`;
  }
}

function wrap(node: ExprNode, minPrec: number): string {
  const own = precedence(node);
  const text = printExpr(node);
  return own < minPrec ? `(${text})` : text;
}

function precedence(node: ExprNode): number {
  switch (node.k) {
    case 'cond':
      return 1;
    case 'bin':
      return PREC[node.op];
    case 'un':
      return 5;
    default:
      return 7;
  }
}

/* -------------------------------------------------------------- 求值 */

export interface ExprCtx {
  /** 绝对秒。 */
  t: number;
  /** 绝对拍。 */
  beat: number;
  fps: number;
  /** 随机源的根：同一工程同一 id 恒得同一个值。 */
  seed: number;
  /** `param(key)` 的取值表；缺省一律 0。 */
  params?: Record<string, number>;
  /** `modulator(id)` 的递归求值入口。缺省 = 0（不是自引用）。 */
  mod?(id: string): number;
}

/** 32 位整数混合（无 `sin`：大参数下的 `fract(sin(x))` 低位不稳，会帧间闪烁）。 */
function hashU32(x: number): number {
  let h = x | 0;
  h ^= h >>> 16;
  h = Math.imul(h, 0x7feb352d);
  h ^= h >>> 15;
  h = Math.imul(h, 0x846ca68b);
  h ^= h >>> 16;
  return h >>> 0;
}

/** `[i, i+1]` 两点的值噪声，返回 -1..1。 */
function valueNoise(x: number, seed: number): number {
  const i = Math.floor(x);
  const f = x - i;
  const u = f * f * (3 - 2 * f);
  const a = hashU32(Math.imul(i, 0x9e3779b1) ^ (seed | 0)) / 0xffffffff;
  const b = hashU32(Math.imul(i + 1, 0x9e3779b1) ^ (seed | 0)) / 0xffffffff;
  return (a + (b - a) * u) * 2 - 1;
}

const SHAPES = 5;

/**
 * LFO 波形（0..1 相位 → -1..1）。
 *
 * `shape` 是数值而不是枚举：表达式里不该出现字符串枚举（它没有类型检查，
 * 拼错就是静默 0）。越界按 `SHAPES` 取模，0 = 正弦。
 */
function lfoShape(phase: number, shape: number): number {
  const p = phase - Math.floor(phase);
  switch (((Math.round(shape) % SHAPES) + SHAPES) % SHAPES) {
    case 1: // 三角
      return p < 0.5 ? p * 4 - 1 : 3 - p * 4;
    case 2: // 锯齿
      return p * 2 - 1;
    case 3: // 方波
      return p < 0.5 ? -1 : 1;
    case 4: // 随机保持（每周期换一个值，周期内恒定）
      return valueNoise(Math.floor(phase), 0x5a17) * 2;
    default:
      return Math.sin(p * Math.PI * 2);
  }
}

function callFn(fn: string, args: number[], ctx: ExprCtx): number {
  switch (fn) {
    case 'sin':
      return Math.sin(args[0]!);
    case 'cos':
      return Math.cos(args[0]!);
    case 'tan':
      return Math.tan(args[0]!);
    case 'abs':
      return Math.abs(args[0]!);
    case 'floor':
      return Math.floor(args[0]!);
    case 'ceil':
      return Math.ceil(args[0]!);
    case 'round':
      return Math.round(args[0]!);
    case 'fract':
      return args[0]! - Math.floor(args[0]!);
    case 'sign':
      return Math.sign(args[0]!);
    case 'sqrt':
      return Math.sqrt(args[0]!);
    case 'exp':
      return Math.exp(args[0]!);
    case 'log':
      return Math.log(args[0]!);
    /** smoothstep(0,1,x)：积木里最常用的缓动，单独给一个参数的位置。 */
    case 'smooth': {
      const x = Math.min(1, Math.max(0, args[0]!));
      return x * x * (3 - 2 * x);
    }
    case 'rand': {
      /*
       * 参数先归到 1/1024 的格点上再与种子混合：直接把 `x * 2^32` 转 int32 会让
       * 任何 `< 2^-32` 的差异落到同一个 0（`rand(1)` 与 `rand(2)` 得到同一个值，
       * 而用户以为它们不同）。
       */
      const k = Math.floor(args[0]! * 1024) | 0;
      return hashU32(k ^ Math.imul(ctx.seed | 0, 0x9e3779b1)) / 0xffffffff;
    }
    case 'mod': {
      const b = args[1]!;
      if (b === 0) return 0;
      return args[0]! - b * Math.floor(args[0]! / b);
    }
    case 'pow':
      return Math.pow(args[0]!, args[1]!);
    case 'min':
      return Math.min(args[0]!, args[1]!);
    case 'max':
      return Math.max(args[0]!, args[1]!);
    case 'step':
      return args[1]! < args[0]! ? 0 : 1;
    case 'atan2':
      return Math.atan2(args[0]!, args[1]!);
    case 'clamp':
      return Math.min(Math.max(args[0]!, args[1]!), args[2]!);
    case 'map': {
      // map(x, inMin, inMax, outMin, outMax)
      const [x, a, b, c, d] = args as [number, number, number, number, number];
      const span = b - a;
      // 除零退化成「输出下限」，而不是 Infinity（后者会让整条链变成 NaN 或黑帧）。
      if (Math.abs(span) < 1e-12) return c;
      return c + ((x - a) / span) * (d - c);
    }
    case 'noise':
      return valueNoise(args[0]! * args[1]!, Math.floor(args[2]!) ^ (ctx.seed | 0));
    case 'fbm': {
      const x = args[0]!;
      const octaves = Math.max(1, Math.min(8, Math.floor(args[1]!)));
      const seed = Math.floor(args[2]!) ^ (ctx.seed | 0);
      let sum = 0;
      let amp = 0.5;
      let norm = 0;
      let freq = 1;
      for (let o = 0; o < octaves; o += 1) {
        sum += amp * valueNoise(x * freq, seed + o * 101);
        norm += amp;
        amp *= 0.5;
        freq *= 2;
      }
      return norm > 0 ? sum / norm : 0;
    }
    case 'lfo':
      return lfoShape(args[0]! * args[1]!, args[2]!);
    default:
      return 0;
  }
}

/**
 * 求值。同一 AST、同一 ctx ⇒ 同一结果（确定性的根基之一）。
 *
 * 深度由解析阶段限死（`MAX_DEPTH`），这里不再设防 —— 递归只跟着 AST 走，
 * 而 AST 不是用户能构造出无界的形状（字符串解析是唯一入口）。
 */
export function evalExpr(node: ExprNode, ctx: ExprCtx): number {
  switch (node.k) {
    case 'num':
      return node.v;
    case 'time':
      return ctx.t;
    case 'beat':
      return ctx.beat;
    case 'param':
      return ctx.params?.[node.key] ?? 0;
    case 'mod':
      return ctx.mod ? ctx.mod(node.id) : 0;
    case 'un': {
      const a = evalExpr(node.a, ctx);
      return node.op === '-' ? -a : a;
    }
    case 'bin': {
      const a = evalExpr(node.a, ctx);
      const b = evalExpr(node.b, ctx);
      switch (node.op) {
        case '+':
          return a + b;
        case '-':
          return a - b;
        case '*':
          return a * b;
        case '/':
          // 除零给 0 而不是 Infinity：`0/0` 的 Infinity/NaN 会整帧变黑，
          // 而「这个调制器这一刻没有值」在画面上本来就该等于「不变」。
          return b === 0 ? 0 : a / b;
        case '%':
          return b === 0 ? 0 : a - b * Math.floor(a / b);
        case '^':
          return Math.pow(a, b);
        case '<':
          return a < b ? 1 : 0;
        case '<=':
          return a <= b ? 1 : 0;
        case '>':
          return a > b ? 1 : 0;
        case '>=':
          return a >= b ? 1 : 0;
        case '==':
          return a === b ? 1 : 0;
        case '!=':
          return a !== b ? 1 : 0;
      }
      return 0;
    }
    case 'cond':
      return evalExpr(node.c, ctx) !== 0 ? evalExpr(node.a, ctx) : evalExpr(node.b, ctx);
    case 'call':
      return callFn(
        node.fn,
        node.args.map((a) => evalExpr(a, ctx)),
        ctx,
      );
  }
}

/* ------------------------------------------------- 积木视图的编辑原语 */

/** 节点有几个子表达式插槽（积木按它画固定数量的洞）。 */
export function slotCount(node: ExprNode): number {
  switch (node.k) {
    case 'un':
      return 1;
    case 'bin':
      return 2;
    case 'cond':
      return 3;
    case 'call':
      return node.args.length;
    default:
      return 0;
  }
}

export function slotAt(node: ExprNode, i: number): ExprNode | null {
  switch (node.k) {
    case 'un':
      return i === 0 ? node.a : null;
    case 'bin':
      return i === 0 ? node.a : i === 1 ? node.b : null;
    case 'cond':
      return i === 0 ? node.c : i === 1 ? node.a : i === 2 ? node.b : null;
    case 'call':
      return node.args[i] ?? null;
    default:
      return null;
  }
}

/** 换掉第 i 个插槽（返回新节点，不改入参）。越界原样返回。 */
export function withSlot(node: ExprNode, i: number, child: ExprNode): ExprNode {
  switch (node.k) {
    case 'un':
      return i === 0 ? { ...node, a: child } : node;
    case 'bin':
      if (i === 0) return { ...node, a: child };
      if (i === 1) return { ...node, b: child };
      return node;
    case 'cond':
      if (i === 0) return { ...node, c: child };
      if (i === 1) return { ...node, a: child };
      if (i === 2) return { ...node, b: child };
      return node;
    case 'call': {
      if (i < 0 || i >= node.args.length) return node;
      const args = node.args.slice();
      args[i] = child;
      return { ...node, args };
    }
    default:
      return node;
  }
}

export function exprAtPath(root: ExprNode, path: readonly number[]): ExprNode | null {
  let cur: ExprNode | null = root;
  for (const i of path) {
    if (!cur) return null;
    cur = slotAt(cur, i);
  }
  return cur;
}

/** 把 `path` 处的子树换成 `next`。空路径 = 换根。 */
export function replaceAtPath(root: ExprNode, path: readonly number[], next: ExprNode): ExprNode {
  if (path.length === 0) return next;
  const [i, ...rest] = path as [number, ...number[]];
  const child = slotAt(root, i);
  if (!child) return root;
  return withSlot(root, i, replaceAtPath(child, rest, next));
}

/* -------------------------------------------------- 积木词汇表边界 */

/**
 * 积木能表达的操作符。
 *
 * 比较与三元**不在内**：它们的结果是 0/1 或分支，积木里没有对应的形状
 * （画出来会是一个「条件块」，而那等于把文本语法硬塞进积木）。所以
 * 文本里写了条件的表达式在积木视图里会显示成一块只读的「文本」块 ——
 * 用户能看见它在算什么，改它就切回文本。
 */
const BLOCK_OPS: ReadonlySet<BinOp> = new Set<BinOp>(['+', '-', '*', '/', '%']);

/** 这个子树能不能用积木画出来（不能就整块降级成只读文本）。 */
export function fitsBlocks(node: ExprNode): boolean {
  switch (node.k) {
    case 'num':
    case 'time':
    case 'beat':
    case 'mod':
      return true;
    case 'param':
    case 'cond':
      return false;
    case 'un':
      return fitsBlocks(node.a);
    case 'bin':
      return BLOCK_OPS.has(node.op) && fitsBlocks(node.a) && fitsBlocks(node.b);
    case 'call':
      return isExprFn(node.fn) && node.args.every(fitsBlocks);
  }
}

/** 整棵树能不能用积木画出来。 */
export function isBlockEditable(ast: ExprNode): boolean {
  return fitsBlocks(ast);
}

/* ---------------------------------------------------------- 默认值 */

/** 新插槽里装的默认子树（数字 0）—— 空洞不允许存在，AST 里没有 null。 */
export function defaultChild(): ExprNode {
  return { k: 'num', v: 0 };
}

/** 新建调制器的默认表达式：一个能立刻看出效果的正弦。 */
export function defaultModulatorExpr(): string {
  return 'sin(t * 2 * pi)';
}
