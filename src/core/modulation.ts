/**
 * modulation.ts — 调制器数据模型 + `resolveParam`（**参数求值的唯一入口**）。
 *
 * 关键帧曲线（`core/curve.ts`）只回答「时间 → 标量」。调制器是**叠加在它之上**的
 * 第二层：同一个参数可以既有曲线又有若干调制槽，二者不互斥 ——
 * 「水平运动 + 随机抖动」就是 `curves['transform.x']` 负责走位、
 * `mods['transform.x'] = [{ ref: 'jitter', gain: 40, mode: 'add' }]` 负责抖。
 *
 * ## 为什么必须只有一个入口
 *
 * 曲线原先在四个地方各自求值（`engine/stack.ts`、`algos/runtime.ts`、
 * `effects/runner.ts`、`core/audio-envelope.ts`）。调制如果做成第二套系统，
 * 这四个地方各要多一个分支，而漏掉任意一个的表现都是「某个参数在某个片段上
 * 不动」—— 不报错、只能靠猜。所以所有调用点一律改调 `resolveParam`。
 *
 * ## 槽的语义
 *
 *   add：`v += gain · m`
 *   mul：`v *= mix(1, m, gain)` = `1 + gain·(m - 1)`
 *
 * `mul` 用 mix 而不是直接相乘，是为了让 `gain = 0` 严格等于「不生效」、
 * `gain = 1` 严格等于「全乘」。直接乘的话 gain=0 会把参数压成 1，那是一个
 * 看起来像 bug 的「拖到 0 反而画面变了」。
 *
 * 求值顺序按数组序（先 add 后 mul 与反过来结果不同）。数组序就是用户在
 * 检查器里看到的顺序，不做归一化。
 */

import { evalCurve, type Curve } from './curve';
import { beatAtTime, type BeatGrid } from './time';
import { defaultModulatorExpr, evalExpr, parseCached, type ExprCtx } from './expr';

/* ---------------------------------------------------------------- 数据 */

/**
 * 一个调制器。**工程级独立实体**（`Project.modulators`），不是片段的属性 ——
 * 「抖动」这种东西一旦被复用到十几条片段上，就必须只有一份定义，否则改一次
 * 要改十几处。
 */
export interface Modulator {
  id: string;
  name: string;
  /** 表达式源码（AST 的真源，求值时解析并缓存）。 */
  expr: string;
  /**
   * 显示范围，**只给 UI 用**（画曲线、标刻度）。求值不钳制 ——
   * 钳制是参数自己 min/max 的事，调制器不该替它决定。
   */
  unit: { min: number; max: number };
}

export type ModMode = 'add' | 'mul';

/** 一个参数上的一个调制槽。 */
export interface ModSlot {
  /** `Modulator.id`。悬空引用由 `validateProject` 清掉。 */
  ref: string;
  /** 0 = 不生效。`add` 时是绝对量，`mul` 时是 0..1 的混合系数。 */
  gain: number;
  mode: ModMode;
}

/** 片段级：与 `curves` **共用键空间**（同一个键既能有关键帧也能有调制）。 */
export type ClipMods = Record<string, ModSlot[]>;

/** 拖动绑定时新槽的默认增益 —— 半量，第一眼就能看出差异又不会把参数顶到边界。 */
export const MOD_DEFAULT_GAIN = 0.5;

export interface ModTable {
  list(): readonly Modulator[];
  get(id: string): Modulator | undefined;
  has(id: string): boolean;
}

const EMPTY_LIST: readonly Modulator[] = Object.freeze([]);
const EMPTY_TABLE: ModTable = {
  list: () => EMPTY_LIST,
  get: () => undefined,
  has: () => false,
};

/**
 * 调制器表。
 *
 * `Project.modulators` 在 store 里**整体替换**（每次改动都给新数组），所以按
 * 数组引用缓存是安全的；这里不缓存 —— 建表的代价是一次 Map 构造（十几个条目），
 * 而每帧每片段建一次也就是几十次 Map，比缓存失效的推理成本便宜。
 */
export function modTable(list: readonly Modulator[] | undefined | null): ModTable {
  if (!list || list.length === 0) return EMPTY_TABLE;
  const map = new Map<string, Modulator>();
  for (const m of list) map.set(m.id, m);
  return {
    list: () => list,
    get: (id) => map.get(id),
    has: (id) => map.has(id),
  };
}

/** 空表（没有工程上下文的调用点用，如离线音频包络求值）。 */
export function emptyModTable(): ModTable {
  return EMPTY_TABLE;
}

/* -------------------------------------------------------------- 求值 */

export interface ResolveCtx {
  grid: BeatGrid;
  fps: number;
  /** 工程种子：`rand` / `noise` 的根。 */
  seed: number;
  /**
   * 曲线的 `clipStart`（`core/curve.ts::EvalCtx`）。
   *
   * 绝大多数调用点是 `clip.start`；**音频 gain 曲线是 0**（那条约定的键是绝对
   * 时间，历史如此）。所以它不是「顺便传一下」，而是调用点各自的定义。
   */
  clipStart: number;
  mods: ModTable;
  /** `param(key)` 的取值表；目前没有消费方，留作「引用参数」的接口位。 */
  params?: Record<string, number>;
}

/** 递归深度上限：超过就当环处理（与 `core/mask.ts` 的深度上限同一口径）。 */
const MAX_DEPTH = 8;

/** 把 (t, grid, seed) 折成表达式上下文；`mod` 回调由调用方接上递归。 */
function exprCtx(t: number, ctx: ResolveCtx, visiting: ReadonlySet<string>): ExprCtx {
  return {
    t,
    beat: beatAtTime(t, ctx.grid),
    fps: ctx.fps,
    seed: ctx.seed,
    params: ctx.params,
    mod: (id) => modulatorValue(id, t, ctx, visiting),
  };
}

/**
 * 一个调制器在 t 秒的值。
 *
 * 环与超深一律返回 0（=「这一刻不调制」），不抛错：环是在写入口就该被拒的
 * 数据，渲染路径上再抛只会让整帧挂掉。`visiting` 是这一趟求值的路径集合，
 * 不是全局缓存 —— 两个互不相干的槽引用同一个调制器时本该各算一次。
 */
export function modulatorValue(
  id: string,
  t: number,
  ctx: ResolveCtx,
  visiting: ReadonlySet<string> = new Set(),
): number {
  if (visiting.has(id) || visiting.size >= MAX_DEPTH) return 0;
  const mod = ctx.mods.get(id);
  if (!mod) return 0;
  const parsed = parseCached(mod.expr);
  if (!parsed.ok) return 0;
  const next = new Set(visiting);
  next.add(id);
  const v = evalExpr(parsed.ast, exprCtx(t, ctx, next));
  return Number.isFinite(v) ? v : 0;
}

/** 调制器在 t 秒的值（外部入口，方便 UI 预览与单测）。 */
export function modulatorSample(id: string, t: number, ctx: ResolveCtx): number {
  return modulatorValue(id, t, ctx, new Set());
}

export interface ParamHost {
  curves: Record<string, Curve>;
  mods?: ClipMods;
}

/**
 * **唯一的参数求值入口。**
 *
 * `base` 是静态值（`clip.opacity` / `inst.values[key]` / `p.defaultValue`）。
 * 有曲线时曲线**覆盖**静态值（与既有语义相同，不是相加），然后逐个调制槽作用。
 *
 * 结果非有限时退回 `base`：一个算坏了的表达式不该把整帧变成 NaN（NaN 进 uniform
 * 之后画面是黑的，而没有任何报错指向那个表达式）。UI 侧会把非有限值标出来。
 */
export function resolveParam(
  clip: ParamHost,
  key: string,
  base: number,
  t: number,
  ctx: ResolveCtx,
): number {
  const curve = clip.curves[key];
  let v = curve ? evalCurve(curve, t, { grid: ctx.grid, clipStart: ctx.clipStart }) : base;
  const slots = clip.mods?.[key];
  if (slots && slots.length > 0) {
    for (const slot of slots) {
      const m = modulatorValue(slot.ref, t, ctx, new Set());
      if (!Number.isFinite(m)) continue;
      v = slot.mode === 'mul' ? v * (1 + slot.gain * (m - 1)) : v + slot.gain * m;
    }
  }
  return Number.isFinite(v) ? v : base;
}

export type ParamLayer = 'none' | 'kc' | 'mod' | 'both';

/**
 * 参数被哪几层控制（检查器徽标三态的唯一判据）。
 *
 * 收两个布尔而不是整个片段：调用方手里常常只有「有没有曲线」「有几个槽」
 * （`KeyableField` 拿的是拆开的 props），而再拼一个假片段去调它只会让两边
 * 各自维护一份拼法。
 */
export function paramLayer(hasKc: boolean, hasMod: boolean): ParamLayer {
  if (hasKc && hasMod) return 'both';
  if (hasKc) return 'kc';
  if (hasMod) return 'mod';
  return 'none';
}

/* ------------------------------------------------------------ 引用扫描 */

export interface ModRef {
  clipId: string;
  clipLabel: string;
  /** 参数键（`transform.x` / `<instanceId>.amount` / `gain` …）。 */
  key: string;
  slots: number;
}

/**
 * 哪些参数引用了这个调制器。
 *
 * 删除调制器**必须**先跑这一趟：直接删掉的话，`mods[key]` 里留下悬空 ref，
 * 求值静默返回 0（「这个参数突然不动了」），而界面上看不出任何原因。
 */
export function modulatorRefs(
  modulators: readonly Modulator[],
  clips: readonly { id: string; label: string; mods?: ClipMods }[],
  modulatorId: string,
): ModRef[] {
  void modulators;
  const out: ModRef[] = [];
  for (const clip of clips) {
    if (!clip.mods) continue;
    for (const [key, slots] of Object.entries(clip.mods)) {
      const n = slots.filter((s) => s.ref === modulatorId).length;
      if (n > 0) out.push({ clipId: clip.id, clipLabel: clip.label, key, slots: n });
    }
  }
  return out;
}

/** 从一个片段的 `mods` 里抹掉某个调制器的全部槽（删除调制器时调用）。 */
export function dropModRefs(mods: ClipMods | undefined, modulatorId: string): ClipMods | undefined {
  if (!mods) return undefined;
  let touched = false;
  const next: ClipMods = {};
  for (const [key, slots] of Object.entries(mods)) {
    const kept = slots.filter((s) => s.ref !== modulatorId);
    if (kept.length !== slots.length) touched = true;
    if (kept.length > 0) next[key] = kept;
  }
  return touched ? next : mods;
}

/* -------------------------------------------------------------- 清洗 */

/** 名字长度上限（面板一行放得下，也防止把一段话塞进列表）。 */
const MAX_NAME = 40;
const MAX_EXPR = 400;
export const MAX_MODULATORS = 64;

/**
 * 打开工程时的调制器清洗：**坏条目整条丢弃，工程必须打得开**。
 *
 * 与段落 / 配色同一条纪律。id 缺失或重复的一律丢（重复 id 会让
 * 「拖到参数上」绑到哪一个变成未定义行为）。
 */
export function sanitizeModulators(raw: unknown): Modulator[] {
  if (!Array.isArray(raw)) return [];
  const out: Modulator[] = [];
  const seen = new Set<string>();
  for (const item of raw) {
    if (out.length >= MAX_MODULATORS) break;
    if (!item || typeof item !== 'object') continue;
    const m = item as Partial<Modulator>;
    if (typeof m.id !== 'string' || !m.id || seen.has(m.id)) continue;
    const expr = typeof m.expr === 'string' ? m.expr.slice(0, MAX_EXPR) : defaultModulatorExpr();
    const unitRaw = (m.unit ?? {}) as Partial<{ min: number; max: number }>;
    const min = Number(unitRaw.min);
    const max = Number(unitRaw.max);
    // 单位区间只影响显示：坏值回落 0..1，而不是拒绝整个调制器。
    const lo = Number.isFinite(min) ? min : 0;
    const hi = Number.isFinite(max) ? max : 1;
    seen.add(m.id);
    out.push({
      id: m.id,
      name: typeof m.name === 'string' && m.name ? m.name.slice(0, MAX_NAME) : m.id.slice(0, 8),
      expr,
      unit: lo === hi ? { min: lo, max: lo + 1 } : { min: Math.min(lo, hi), max: Math.max(lo, hi) },
    });
  }
  return out;
}

/**
 * 片段级 `mods` 的清洗：**悬空引用与坏形状逐槽丢弃**。
 *
 * 一次没清干净就会在求值处静默返回 0；而「参数不动」是最难归因的一类现象。
 * 空数组留下的键也一并删掉 —— 留着它会让检查器画出「有调制」的徽标。
 */
export function sanitizeClipMods(raw: unknown, table: ModTable): ClipMods | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const out: ClipMods = {};
  for (const [key, slotsRaw] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof key !== 'string' || !key) continue;
    if (!Array.isArray(slotsRaw)) continue;
    const slots: ModSlot[] = [];
    for (const item of slotsRaw) {
      if (!item || typeof item !== 'object') continue;
      const s = item as Partial<ModSlot>;
      if (typeof s.ref !== 'string' || !s.ref) continue;
      if (!table.has(s.ref)) continue;
      const gain = Number(s.gain);
      slots.push({
        ref: s.ref,
        /*
         * 增益范围要容得下「绝对量」：`add` 模式的 gain 是**被加上的值**，
         * 位移类参数上 40（像素）是正常取值。钳到 ±4 那种「归一化思维」会让
         * 用户拖不出想要的抖动幅度，而界面上没有任何报错。
         */
        gain: Number.isFinite(gain) ? Math.min(1000, Math.max(-1000, gain)) : MOD_DEFAULT_GAIN,
        mode: s.mode === 'mul' ? 'mul' : 'add',
      });
    }
    if (slots.length > 0) out[key] = slots;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}
