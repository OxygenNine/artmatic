/**
 * grade.ts — 调色（`grade-*`）的**判定逻辑**：要不要 16F 中间缓冲、要不要降级提示。
 *
 * 纯函数，不碰 GL：`engine/compositor.ts` 每帧调一次，UI 用同一份结论决定
 * 提示条的文案。分成两层是因为「有没有调色」和「16F 到底给不给」是两件事，
 * 而后者有三个原因（没调色 / 没浮点渲染目标 / 预算不够），三种都要能单独显示。
 *
 * ## 16F 只提高位深，不改变编码
 *
 * 中间缓冲变成 RGBA16F 之后，**混合仍然作用在 sRGB 编码值上**。只有调色 pass
 * 自己的 `main` 内部临时解码到线性、算完再编码回去（见 `TRANSFER_GLSL`）。
 * 写成「升 16F 就线性了」会让每次插入调色模块都变成一次隐式色彩空间转换，
 * 而混合模式那一套（`multiply` / `screen` / `overlay`…）全都按编码域定义 ——
 * 那会把 8 种混合模式的观感一起改掉。
 *
 * ## 为什么按 op 列表扫前缀而不是问工程
 *
 * 「工程里有调色片段」与「这一帧的链里真的有调色」不是一回事：调色片段可能
 * 不在时间范围内、可能被禁用、可能绑在一个这一帧没出现的片段上。判据取
 * **这一帧实际要跑的 op 列表**，所以它跟着 seek 自动正确。
 */

/** 调色模块的 defId 前缀。四个模块（basic / curves / lut / qualifier）共用它。 */
export const GRADE_DEF_PREFIX = 'grade-';

export function isGradeDef(defId: string): boolean {
  return defId.startsWith(GRADE_DEF_PREFIX);
}

/* ------------------------------------------------------------- 结构扫描 */

/** 扫描用的最小形状。`RenderOp[]` 结构上可赋值给它，于是不需要 core → engine 的依赖。 */
export interface GradeChainItem {
  readonly defId: string;
  /** `false` = 禁用，不占浮点预算也不产生调色。 */
  readonly enabled?: boolean;
}

export interface GradeChain {
  readonly chain?: readonly GradeChainItem[];
}

export interface GradeScanSource {
  /** 绑定在这一层上的特效链（`EffectClip.boundClipId`）。 */
  readonly bound?: readonly GradeChain[];
}

export interface GradeScanEffect extends GradeChain {
  readonly scope?: readonly GradeScanOp[];
}

export interface GradeScanOp {
  readonly type: string;
  /** `type === 'effect'` 时是特效片段。 */
  readonly clip?: GradeScanEffect;
  /** `type === 'source'`。 */
  readonly source?: GradeScanSource;
  /** `type === 'transition'` 的两侧。 */
  readonly from?: GradeScanSource | null;
  readonly to?: GradeScanSource | null;
}

export interface GradePlan {
  /** 这一帧有没有调色模块。false 时其余字段无意义。 */
  requested: boolean;
  /** 主链（含作用域）里有调色 ⇒ ping/pong 与作用域组目标要浮点。 */
  chain: boolean;
  /** 绑定在某个片段上的链里有调色 ⇒ placement 层与绑定链草稿要浮点。 */
  bound: boolean;
  /** 作用域嵌套的最大深度（每一层占一对额外的目标）。 */
  depth: number;
}

const EMPTY_PLAN: GradePlan = { requested: false, chain: false, bound: false, depth: 0 };

function chainHasGrade(items: readonly GradeChainItem[] | undefined): boolean {
  if (!items) return false;
  for (const it of items) if (it.enabled !== false && isGradeDef(it.defId)) return true;
  return false;
}

/** 累加 `out`；返回是否命中（`depth` 由调用方在同一趟里更新）。 */
function scanOps(ops: readonly GradeScanOp[], level: number, out: { plan: GradePlan }): void {
  const p = out.plan;
  for (const op of ops) {
    if (op.type === 'effect') {
      const clip = op.clip;
      if (clip && chainHasGrade(clip.chain)) {
        p.requested = true;
        p.chain = true;
      }
      if (clip?.scope && clip.scope.length > 0) {
        // 有作用域就一定会分配组目标，不论里面有没有调色 —— 深度按这个算。
        p.depth = Math.max(p.depth, level + 1);
        scanOps(clip.scope, level + 1, out);
      }
      continue;
    }
    const sides: (GradeScanSource | null | undefined)[] =
      op.type === 'source' ? [op.source] : [op.from, op.to];
    for (const side of sides) {
      for (const bound of side?.bound ?? []) {
        if (chainHasGrade(bound.chain)) {
          p.requested = true;
          p.bound = true;
        }
      }
    }
  }
}

/**
 * 扫一遍这一帧的 op 列表。
 *
 * 转场两侧的绑定链也算（转场窗口里两层各自跑自己的链）。
 */
export function gradePlan(ops: readonly GradeScanOp[]): GradePlan {
  const out = { plan: { ...EMPTY_PLAN } };
  scanOps(ops, 0, out);
  return out.plan;
}

/* --------------------------------------------------------------- 预算 */

/** RGBA16F 每像素 8 字节（RGBA8 是 4）。 */
export const HALF_FLOAT_BPP = 8;

/**
 * 提升成浮点的中间目标**个数**。
 *
 * 6 个是主链的固定开销：ping/pong 两个，每层作用域一对；绑定链再加 3 个
 * （`placedA`/`placedB` 与绑定链草稿 `layerScratch`）。转场输出层与反馈池
 * 不在此列 —— 它们不承载调色的输入输出，8 位量化在那里是既有行为。
 */
export function gradeTargetCount(plan: GradePlan): number {
  if (!plan.requested) return 0;
  let n = 0;
  if (plan.chain) n += 2 + 2 * plan.depth;
  if (plan.bound) n += 3;
  return n;
}

export function gradeTargetBytes(plan: GradePlan, w: number, h: number): number {
  return gradeTargetCount(plan) * Math.max(1, Math.floor(w) * Math.floor(h)) * HALF_FLOAT_BPP;
}

export type GradeReason = 'idle' | 'ok' | 'no-float' | 'over-budget';

export interface GradePrecision {
  /** 这一帧的中间缓冲**实际**是浮点吗。 */
  float: boolean;
  reason: GradeReason;
}

/**
 * 这张牌怎么打。
 *
 * `over-budget` 是**全有或全无**：不做「主链浮点、绑定链 8 位」那种分级，
 * 因为同一帧里两条路径的精度不一致会让「同一组参数绑在不同片段上」出现
 * 不同结果，而那是查不出来的那种 bug。宁可整帧退回 8 位并明说。
 */
export function gradePrecision(
  plan: GradePlan,
  w: number,
  h: number,
  budgetBytes: number,
  floatSupported: boolean,
): GradePrecision {
  if (!plan.requested) return { float: false, reason: 'idle' };
  if (!floatSupported) return { float: false, reason: 'no-float' };
  if (gradeTargetBytes(plan, w, h) > budgetBytes) return { float: false, reason: 'over-budget' };
  return { float: true, reason: 'ok' };
}
