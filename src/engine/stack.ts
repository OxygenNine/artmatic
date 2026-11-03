/**
 * stack.ts — buildStack(project, t)：把工程在时刻 t 的渲染操作排成 z 序。
 *
 * AGENTS.md §5 合成求值：
 *   1. 收集所有命中 t 的 SourceClip，轨道序 → 轨道内序决定 z
 *   2. 按 z 序合成（blend / opacity / transform / 曲线求值）
 *   3. 命中的 EffectClip 的 chain 依 z 序插入（adjustment layer 语义：
 *      它只消费「z 序在它之下所有 source 的合成结果」——ping-pong
 *      调度的天然产物，不需要额外机制）
 *
 * 曲线求值集中在这里做（每个 op 附求值好的值），GLSL 只收标量 uniform；
 * fadeSec 在这里折算进 opacity——GLSL 不需要知道 fade 的存在。
 *
 * ## 影响深度：作用域组（2026-10-11）
 *
 * `EffectClip.affectDepth = N > 0` 时，那个 op 带上 `scope`（一段 op 列表）：
 *
 *   - 作用域 = z 序上一段**连续**的 op 段：从「下方第 N 条**启用**视觉轨的最深一条」
 *     起，到它自己为止。同轨更早的片段也在里面 —— 它们在画面上本来就在它之下。
 *   - 这些 op 会被**从顶层移走**折进 `scope`，所以顶层序列里不会重复出现它们。
 *   - 渲染色器时作用域从**透明**起独立合成，特效链作用在它上面，再以 normal 贴回
 *     下层（见 `compositor.ts::runOps`）。于是「作用域 = 只留下这几条轨道时的那幅
 *     画面」，它看不到作用域之外的轨道 —— 这正是这个功能要的语义。
 *   - `N = 0` / 缺省**不分组**（`scope === undefined`）：与 v4 逐字节相同。
 *
 * 两条边界规则，都是为「不出现静默失效」而设：
 *
 *   1. **吸收**：作用域内的其它特效片段（更低、自己也带影响深度）需要的轨道会并入
 *      外层作用域 —— 它能把更深的内容带进来，于是外层看到的是「这些轨道组成的那幅
 *      画面」，而内层特效是那幅画面的一部分。反过来做（截断内层的作用域）会让内层
 *      特效变成一个静默的空操作，那是更坏的表现。
 *   2. **下方没有启用的轨道**（或那些轨此刻没有片段）→ 作用域为空（`scope: []`），
 *      特效作用在**空画面**上。多数特效因此看不出变化，检查器里有提示。
 *
 * 区间算在 **op 下标**上（不按轨号），于是「禁用轨不占深度」「同轨更早的片段在作用域
 * 内」这两件事都是它的推论。区间族因此天然是**层叠的**（laminar：任意两个区间要么
 * 不相交、要么一个包含另一个），`groupOps` 才能用一个栈一趟折成树。
 *
 * ## 转场：一个 op 顶两个 op
 *
 * 窗口命中的时候（见 core/transitions.ts）**不产出两个 source op，只产出一个
 * transition op**——转场着色器要同时看两张贴图，拆成两个 op 就凑不到一起了。
 * op 里两个 ResolvedSource 都是**超范围求值**的：入画片段在 `t < its.start`
 * 时被求值（`algos/runtime.ts` 的 `Math.max(0, …)` 让它停在首帧），出画片段在
 * `t >= its.end` 时继续走。
 *
 * ⚠️ **转场判断必须在 span 过滤之前**：窗口后半段的 t 已经越过出画片段的
 * `end`，先过滤就会整段漏掉，表现是「转场只在前半段生效」。
 */

import { fadeWeight } from '../core/clips';
import { isIdentityQuad, quadInverseMatrix } from '../core/quad';
import { isIdentityCrop } from '../core/image-fx';
import { modTable, resolveParam, type ResolveCtx } from '../core/modulation';
import { transitionAt, type TransitionWindow } from '../core/transitions';
import type {
  BlendMode,
  CropSettings,
  EffectClip,
  KeySettings,
  Project,
  SourceClip,
  VisualTrack,
} from '../core/schema';

export interface ResolvedSource {
  clip: SourceClip;
  /** 已含 fadeSec 斜坡与 opacity 曲线。 */
  opacity: number;
  transform: { x: number; y: number; sx: number; sy: number; rot: number };
  blend: BlendMode;
  /**
   * 简易抠图设置（`SourceClip.key` 的**原样引用**）。缺省 = 不抠。
   *
   * 抠图参数不支持关键帧，所以这里原样带过去、每帧重建对象只是给 GC 添活；
   * 真正消费它的是 `compositor.placeLayer`（一次 placement pass，见
   * `placement.frag.ts` 文件头）。
   */
  key?: KeySettings;
  /**
   * 四角调整的**逆单应**（行主序 3×3，`core/quad.ts`）。缺省 = 不调整。
   *
   * - identity / 缺省 → **不带**这个字段：compositor 传 `u_quadOn = 0`，走与
   *   改动前完全相同的算式（关闭状态逐位一致是全项目回归的前提）。
   * - 非 identity 可逆 → 9 个数（CPU 算一次，着色器只做齐次除法）。
   * - 非 identity 但退化（三点共线 / 面积 0）→ `null`：同样按「不调整」渲染，
   *   **不丢层**。用户把四角拖成一条线时不该让图层整个消失。
   */
  quadInverse?: number[] | null;
  /**
   * 画面裁剪（`SourceClip.crop` 的**原样引用**）。缺省 = 不裁。
   *
   * 与 `quadInverse` 同一条纪律：全零裁剪**不带**这个字段，`u_cropOn = 0`，
   * 走与改动前逐位相同的算式。
   */
  crop?: CropSettings;
  /**
   * **绑定在这层上的特效链**（`EffectClip.boundClipId === clip.id`，v11）。
   *
   * 与 `EffectOp` 的区别：它们不作用于 acc，而是在 placement 之后、blend 之前
   * 直接跑在**这一层**上（见 `compositor.placeLayer`）。缺省不带这个字段 ——
   * 「没有绑定」必须与改动前的路径逐字节相同。
   */
  bound?: EffectClip[];
}

/**
 * 转场 op。
 *
 * `from` / `to` **可以为 null**（v13）：那一侧没有片段（轨道首尾、缝隙、邻居是
 * 特效片段）时，转场着色器拿到的是一张全透明贴图 —— 也就是用户说的「把空白当成
 * 一个全透明的纯色片段」。`null` 与「源这帧没准备好」是两件事：后者仍然是
 * `ResolvedSource`，由 compositor 的 `placeLayer` 返回 false 处理。
 *
 * `blend` 取**入画片段**的混合模式：窗口结束后的下一帧画的就是入画片段，
 * 用它的 blend 才不会有跳变；没有入画片段（淡出到透明）时取出画片段的。
 */
export interface TransitionOp {
  type: 'transition';
  z: number;
  from: ResolvedSource | null;
  to: ResolvedSource | null;
  /**
   * 单侧（另一侧是透明）时非 null。compositor 据此走 premultiplied 补偿：
   * 转场着色器对透明侧输出 `mix(vec4(0), c, f)`，颜色其实已经乘过 alpha 了。
   */
  single: 'from' | 'to' | null;
  defId: string;
  values: Record<string, number>;
  /** 窗口内进度 ∈ [0,1)。 */
  progress: number;
  blend: BlendMode;
}

/** 转场 op 里真实存在的两侧（null 侧被跳过）。所有旁路消费方都该用它。 */
export function transitionSources(op: TransitionOp): ResolvedSource[] {
  const out: ResolvedSource[] = [];
  if (op.from) out.push(op.from);
  if (op.to) out.push(op.to);
  return out;
}

/** 特效 op。`scope` 有值 = 这个片段设了影响深度（见文件头），那一段要从透明独立合成。 */
export interface EffectOp {
  type: 'effect';
  z: number;
  clip: EffectClip;
  /** 影响深度 > 0 时的作用域内容；`undefined` = 不分组（作用于下方全部）。 */
  scope?: RenderOp[];
}

export type RenderOp =
  | { type: 'source'; z: number; source: ResolvedSource }
  | EffectOp
  | TransitionOp;

/**
 * `buildStack` 的可选参数。
 *
 * `onlyTrackId` 指定后**只保留那条视觉轨产出的 op**：其它视觉轨视为禁用
 * （`track.enabled = false` 的等价），不参与合成。语义是「只渲染该轨道本身」，
 * **不是**「只静音其它轨」—— 该轨自己的滤镜 / 混合 / 特效照常生效，只是画面里
 * 看不到别的轨。
 *
 * 两条边界（都不改既有行为）：
 *  - **z 编号仍按完整 `visualTracks(project)` 计算**。z 只用于排序，被跳过的轨
 *    留下空洞无害，也保证「同一轨同一帧的 z」与全量渲染逐字节一致。
 *  - 音频轨不属视觉轨，**不受此参数影响**（导出 MP4 时音频照常混入）。
 */
export interface BuildStackOptions {
  onlyTrackId?: string;
}

/**
 * 深度优先遍历 op（作用域组里的 op 也是 op）。
 *
 * 需要它的地方是「按 op 找片段」这类**旁路**消费方（`video-source.ts` 的预取）：
 * 只看顶层会漏掉作用域里的源，而漏掉的表现是「有深度的特效下面那几条轨不预解码」——
 * 不报错、只是卡顿与缺帧。
 */
export function walkOps(ops: readonly RenderOp[], fn: (op: RenderOp) => void): void {
  for (const op of ops) {
    fn(op);
    if (op.type === 'effect' && op.scope) walkOps(op.scope, fn);
  }
}

/**
 * 参数求值的**唯一入口**（`core/modulation.ts::resolveParam`）在这一层的调用形态。
 *
 * `clipStart` 由所属片段决定（曲线的 t=0 相对片段起点），其余字段整帧不变，
 * 所以按帧建一份、按片段补一个 `clipStart`。`mods` 不是可选参数：漏传的表现是
 * 「绑了调制器但参数不动」，而那种失效没有任何报错。
 */
export function resolveBase(project: Project): Omit<ResolveCtx, 'clipStart'> {
  return {
    grid: project.beatGrid,
    fps: project.fps,
    seed: project.seed,
    mods: modTable(project.modulators),
  };
}

/** 片段参数：曲线 + 调制槽，两者可叠加。 */
export function paramWithCurve(
  clip: SourceClip,
  name: string,
  base: number,
  t: number,
  rctx: Omit<ResolveCtx, 'clipStart'>,
): number {
  return resolveParam(clip, name, base, t, { ...rctx, clipStart: clip.start });
}

/**
 * 把一个 SourceClip 在 t 求值成 ResolvedSource。
 *
 * 转场两侧都用它——注意**两侧各自的 fadeSec 斜坡照常生效**（窗口内也一样）。
 * 出画片段的 fade-out 恰好在剪切点归零，再叠上转场就是「二次淡出」，
 * 检查器对同时设了两者的情况给提示，机制上不做特判。
 *
 * `key` / `quad` 也在这一步解析，于是转场窗口里 from / to 各自带着自己的抠图与
 * 四角 —— 转场通路对两侧各调一次 placement，它们天然相互独立。
 */
export function resolveSource(
  clip: SourceClip,
  t: number,
  rctx: Omit<ResolveCtx, 'clipStart'>,
  bound?: EffectClip[],
): ResolvedSource {
  const opacity =
    paramWithCurve(clip, 'opacity', clip.opacity, t, rctx) * fadeWeight(clip, clip.fadeSec, t);
  const out: ResolvedSource = {
    clip,
    opacity,
    transform: {
      x: paramWithCurve(clip, 'transform.x', clip.transform.x, t, rctx),
      y: paramWithCurve(clip, 'transform.y', clip.transform.y, t, rctx),
      sx: paramWithCurve(clip, 'transform.sx', clip.transform.sx, t, rctx),
      sy: paramWithCurve(clip, 'transform.sy', clip.transform.sy, t, rctx),
      rot: paramWithCurve(clip, 'transform.rot', clip.transform.rot, t, rctx),
    },
    blend: clip.blend,
  };
  // 只在真的有的时候才挂字段：identity / 缺省必须与旧路径**逐字节相同**
  // （多带一个 `quadInverse: undefined` 对渲染没影响，但守卫与快照会看到差别）。
  if (clip.key) out.key = clip.key;
  if (clip.quad && !isIdentityQuad(clip.quad)) out.quadInverse = quadInverseMatrix(clip.quad);
  if (clip.crop && !isIdentityCrop(clip.crop)) out.crop = clip.crop;
  if (bound && bound.length > 0) out.bound = bound;
  return out;
}

/**
 * 这一帧生效的绑定链：目标片段 id → 以 z 升序排好的 `EffectClip[]`。
 *
 * 抽出成独立函数是因为**蒙版求值也要它**（`compositor` 渲染被引用片段那一层时
 * 必须带上它的绑定链，否则「模糊后的亮度当蒙版」做不到），而两处各扫一遍
 * 迟早会漂 —— 漂的表现是「蒙版里少了那层滤镜」，不报错。
 *
 * z 升序（下方轨道那条先跑）让链的先后由轨道序决定，而不是由 `tracks[]` 的
 * 迭代顺序偷偷决定。
 */
export function boundChainMap(project: Project, t: number): Map<string, EffectClip[]> {
  const visuals = visualTracks(project);
  const visualIndex = new Map<string, number>();
  visuals.forEach((track, i) => visualIndex.set(track.id, i));
  const last = visuals.length - 1;

  const byTarget = new Map<string, { z: number; clip: EffectClip }[]>();
  for (const track of project.tracks) {
    if (!track.enabled || track.kind !== 'visual') continue;
    const z = last - visualIndex.get(track.id)!;
    for (const clip of track.clips) {
      if (clip.kind !== 'effect' || !clip.boundClipId) continue;
      if (t < clip.start || t >= clip.end) continue;
      // 整条链都没启用 = 这条片段什么也不做，连挂都不挂。
      if (!clip.chain.some((inst) => inst.enabled)) continue;
      const list = byTarget.get(clip.boundClipId);
      if (list) list.push({ z, clip });
      else byTarget.set(clip.boundClipId, [{ z, clip }]);
    }
  }
  const out = new Map<string, EffectClip[]>();
  for (const [id, list] of byTarget) {
    list.sort((a, b) => a.z - b.z);
    out.set(
      id,
      list.map((x) => x.clip),
    );
  }
  return out;
}

export function buildStack(project: Project, t: number, opts?: BuildStackOptions): RenderOp[] {
  const ops: RenderOp[] = [];
  const rctx = resolveBase(project);

  /**
   * 轨道序 → z 序。
   *
   * `tracks[0]` 渲染在**轨道列表最顶部**，而列表顶部按 NLE 惯例就是「最前景」，
   * 所以它的 z 必须最大：`z = last - 视觉轨下标`。
   *
   * 这里曾经是 `z = index`（z 直接等于数组下标），后果是「列表越靠下的轨道
   * 画面越靠上」——与 Premiere / AE / DaVinci 的直觉完全相反，用户实测报上来
   * 说「z 轴好像是轨道越往下越大，不符合直觉」。
   *
   * 编号只数**视觉轨**：音频轨不参与合成，若把它们也算进下标，z 就会出现
   * 空洞（4 条视觉轨 + 1 条音频会得到 1..4 而不是 0..3）。现在 op.z 只用于排序，
   * 空洞不会出错，但让「z 就是栈的层号」这件事成立，后来人才不会误解。
   * 改这里时必须同步把 demo 工程的 tracks 顺序一起倒过来，否则原本的叠加关系
   * 会被整个翻掉。
   */
  const visuals = visualTracks(project);
  const visualIndex = new Map<string, number>();
  visuals.forEach((track, i) => visualIndex.set(track.id, i));
  const last = visuals.length - 1;

  /** 扁平 op + 它来自哪条视觉轨（影响深度的边界按视觉轨算）。 */
  const flat: FlatOp[] = [];

  // 只导某轨时其余视觉轨一律跳过（z 编号不受影响，见 BuildStackOptions）。
  const onlyTrackId = opts?.onlyTrackId;

  /*
   * 绑定片段（v11）的预处理：先把「这一帧生效的、绑在某片段上的链」收成一张表，
   * 推 source op 时再挂上去。
   *
   * **不受 `onlyTrackId` 影响**：绑定链属于目标片段自己的样子（它就是那一段的
   * 滤镜），隔离观察这一层时它必须一起出现 —— 否则 `only` 看到的是一张「少了
   * 滤镜」的图，而 agent 会把它当成「参数没生效」。
   *
   * 同一个目标被多条绑定时按 z **升序**（下方轨道那条先跑），这样链的先后由
   * 轨道序决定、而不是由 `tracks[]` 的迭代顺序偷偷决定。
   */
  const boundChains = boundChainMap(project, t);

  project.tracks.forEach((track) => {
    if (!track.enabled || track.kind !== 'visual') return;
    if (onlyTrackId !== undefined && track.id !== onlyTrackId) return;
    const vis = visualIndex.get(track.id)!;
    const z = last - vis;
    // 带下标的 for：转场要跳过一个片段，forEach 做不到。
    const clips: VisualTrack['clips'] = track.clips;

    /**
     * 一个窗口 → 一个 transition op。两侧各带自己的绑定链（贴在 from 上的滤镜
     * 不该跑到 to 上）；`null` 侧不解析、由 compositor 用透明贴图。
     */
    const pushTransition = (win: TransitionWindow): void => {
      const ref = win.side === 'out' ? win.from!.transitionOut! : win.to!.transitionIn!;
      const from = win.from ? resolveSource(win.from, t, rctx, boundChains.get(win.from.id)) : null;
      const to = win.to ? resolveSource(win.to, t, rctx, boundChains.get(win.to.id)) : null;
      const single = from && !to ? 'from' : !from && to ? 'to' : null;
      flat.push({
        vis,
        op: {
          type: 'transition',
          z,
          from,
          to,
          single,
          defId: ref.defId,
          values: ref.values,
          progress: win.progress,
          // 窗口结束后的下一帧画的是入画片段；没有入画片段时用出画的。
          blend: (to ?? from)!.blend,
        },
      });
    };

    for (let i = 0; i < clips.length; i += 1) {
      const clip = clips[i]!;

      /*
       * ⚠️ 顺序要紧：转场判断放在 span 过滤**之前**。
       * 窗口里的 t 可能已经越过了某一侧的 `start` / `end`，先过滤掉就永远出不了
       * transition op。
       *
       * v13 起每个边界只产出一个 op，且**在左侧参与者那一轮产出**：
       *   1. 本片段的出场窗口（右半段吃下一片段的头）；
       *   2. 下一片段的入场窗口且它有 from（左半段吃本片段的尾）；
       *   3. 本片段的入场窗口且 from 为 null（轨道开头 / 缝隙 / 特效片段隔开）。
       * 第 2 条是「不把 from 再单独画一遍」的关键：若等走到下一片段再判定，
       * 本片段已经作为普通 source 推进去了。
       */
      if (clip.kind === 'source') {
        const outWin = transitionAt(track, i, 'out', t);
        if (outWin) {
          pushTransition(outWin);
          // 入画片段这一帧由转场全权负责；不跳就会把它再单独画一遍。
          if (outWin.to) i += 1;
          continue;
        }

        const next = clips[i + 1];
        if (next?.kind === 'source' && next.transitionIn) {
          const nextIn = transitionAt(track, i + 1, 'in', t);
          if (nextIn?.from) {
            pushTransition(nextIn);
            i += 1;
            continue;
          }
        }

        const inWin = clip.transitionIn ? transitionAt(track, i, 'in', t) : null;
        if (inWin && !inWin.from) {
          pushTransition(inWin);
          continue;
        }
      }

      if (t < clip.start || t >= clip.end) continue;

      if (clip.kind === 'effect') {
        // 绑定的片段已经在 boundChains 里，绝不作为 adjustment layer 再推一次
        // —— 推了就是「同一道特效既作用在这一层又作用在下面所有层」。
        if (clip.boundClipId) continue;
        if (clip.chain.some((i2) => i2.enabled)) flat.push({ vis, op: { type: 'effect', z, clip } });
        continue;
      }
      flat.push({
        vis,
        op: { type: 'source', z, source: resolveSource(clip, t, rctx, boundChains.get(clip.id)) },
      });
    }
  });

  // z 升序，compositor 顺序合成 → z 大者盖在上，与「列表顶部 = 前景」一致。
  // 同轨不重叠，轨道内相对顺序无所谓，保持稳定即可（sort 稳定：同 z 保留推入顺序）。
  flat.sort((a, b) => a.op.z - b.op.z);

  // 作用域只在有影响深度的特效上存在；其余情况原样返回（逐字节等于 v4 的行为）。
  return groupOps(flat, scopeStarts(flat, visuals, last));
}

/* ------------------------------------------------- 影响深度：作用域分组 */

/** 扁平 op + 它来自哪条视觉轨下标（区间按 op 下标算，轨号只用来定边界）。 */
interface FlatOp {
  op: RenderOp;
  vis: number;
}

/** 视觉轨（按列表序，**含禁用**的）—— z 编号与影响深度的轨号口径都由它定义。 */
export function visualTracks(project: Project): VisualTrack[] {
  return project.tracks.filter((t): t is VisualTrack => t.kind === 'visual');
}

/**
 * 影响深度覆盖的视觉轨下标：`vis` 下方最近的 N 条**启用**轨（不足 N 条 → 就这些）。
 *
 * 只数启用轨：禁用轨不参与合成，谈不上被影响，也不该占掉一格深度 —— 否则关掉一条轨
 * 会让上方特效突然作用不到任何东西（看起来就是「特效没了」）。
 *
 * 展示侧（检查器的「影响：…」提示）与渲染侧（`scopeStarts` 定区间起点）**共用这一份**
 * —— 各写一遍的话，「深度 2 影响了哪两条轨」迟早会对不上，而且不会报错。
 */
export function affectedVisualIndices(
  visuals: readonly VisualTrack[],
  vis: number,
  depth: number,
): number[] {
  const out: number[] = [];
  // vis < 0 = 轨道不在这个工程里（调用方拿了个陈旧的 id）。**必须挡住**：不挡的话
  // 循环会从 0 起数，于是检查器给出一条「影响：V1、V2」—— 一条彻头彻尾的假提示。
  if (depth <= 0 || vis < 0) return out;
  for (let i = vis + 1; i < visuals.length && out.length < depth; i += 1) {
    if (visuals[i]!.enabled) out.push(i);
  }
  return out;
}

/**
 * 第一个 `z >= zMin` 的 op 下标（flat 已按 z 升序）。
 *
 * 特效自己那个 op 的 z 必定 ≥ zMin（zMin 来自它下方的轨道），所以扫描必定在它之前停住。
 */
function firstIndexAtOrBelowZ(flat: readonly FlatOp[], zMin: number): number {
  let i = 0;
  while (i < flat.length && flat[i]!.op.z < zMin) i += 1;
  return i;
}

/**
 * 每个设了影响深度的特效 op → 作用域起点（终点是它自己的下标）。见文件头的两条边界规则。
 *
 * **自下而上**算（op 下标升序）：内层特效先定下来，外层再把自己的起点往低处拉到包含它
 * （吸收）。拉低之后可能与更多区间相交，所以那一步迭代到不动点。
 */
function scopeStarts(
  flat: readonly FlatOp[],
  visuals: readonly VisualTrack[],
  last: number,
): Map<number, number> {
  const starts = new Map<number, number>();
  for (let k = 0; k < flat.length; k += 1) {
    const { op, vis } = flat[k]!;
    if (op.type !== 'effect') continue;
    const depth = op.clip.affectDepth ?? 0;
    if (depth <= 0) continue;

    const affected = affectedVisualIndices(visuals, vis, depth);
    // 下方没有启用的轨道 → 空作用域（起点 = 终点 = 自己）
    const zMin = affected.length === 0 ? null : last - affected[affected.length - 1]!;
    let start = zMin === null ? k : firstIndexAtOrBelowZ(flat, zMin);
    for (let changed = true; changed; ) {
      changed = false;
      for (const [end, s] of starts) {
        // 已算好的区间都在更低的 z 上（end < k）。相交 ⇒ 起点拉到它的起点。
        if (end > start && s < start) {
          start = s;
          changed = true;
        }
      }
    }
    starts.set(k, start);
  }
  return starts;
}

/**
 * 把作用域区间折成嵌套的 op 列表。
 *
 * 区间族是**层叠的**（见文件头），所以一个栈就够：`end` 是那个特效自己的 op 下标，
 * 到它时收帧、把攒下的内容挂到它身上。空作用域（start === end）开完立刻收。
 */
function groupOps(flat: readonly FlatOp[], starts: Map<number, number>): RenderOp[] {
  const byStart = new Map<number, number[]>();
  for (const [end, start] of starts) {
    const list = byStart.get(start);
    if (list) list.push(end);
    else byStart.set(start, [end]);
  }
  // 同一个起点上先开外层（end 大）——后进先出，于是内层落在栈顶。
  for (const list of byStart.values()) list.sort((a, b) => b - a);

  const root: RenderOp[] = [];
  const stack: { end: number; children: RenderOp[] }[] = [];
  const append = (op: RenderOp) => {
    const top = stack[stack.length - 1];
    (top ? top.children : root).push(op);
  };

  for (let i = 0; i < flat.length; i += 1) {
    // 1) 收帧：这个 op 就是那个特效自己，作用域内容已经攒好了
    const closed = stack[stack.length - 1]?.end === i ? stack.pop()! : null;
    // 2) 开帧：作用域从这个 op 起（空作用域的 start === end === i，开完立刻收）
    for (const end of byStart.get(i) ?? []) stack.push({ end, children: [] });
    const empty = !closed && stack[stack.length - 1]?.end === i ? stack.pop()! : null;

    const frame = closed ?? empty;
    const op = flat[i]!.op;
    if (!frame) {
      append(op);
      continue;
    }
    // `starts` 只在 effect op 上建区间，所以这里必然对上；对不上就是这段逻辑坏了。
    if (op.type !== 'effect') throw new Error('stack: 作用域区间没有对上特效 op');
    append({ ...op, scope: frame.children });
  }
  return root;
}
