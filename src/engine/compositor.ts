/**
 * compositor.ts — ping-pong 合成调度。
 *
 *   acc（透明黑起步）
 *     → 每个 SourceOp：placement（源 → placed）→ blend（placed over acc）
 *     → 每个 TransitionOp：两侧各 placement（→ placedA / placedB）→
 *       transition（两张贴图 + progress → trTmp）→ blend（trTmp over acc）
 *     → 每个 EffectOp：chain 逐个 effect runEffect(acc → buf)，swap
 *     → 最后 passthrough 到屏幕
 *
 * acc 在 ping/pong 两个 Target 之间倒手，所以 EffectClip 拿到的永远是
 * 「z 序在它之下所有 source 的合成结果」——adjustment layer 语义是
 * 调度的天然产物。
 *
 * ## 影响深度的特效：作用域先单独合成，再贴回
 *
 * 设了影响深度的特效（`EffectOp.scope`，见 `stack.ts` 文件头）不是「作用于 acc
 * 目前的样子」，而是作用于**只留下那几条轨道时的那幅画面**：`runOps` 递归跑一遍
 * 作用域、从透明起合成，特效链作用在它上面，最后贴回 acc。嵌套的组各用
 * 一对自己的目标（`groupTargets(depth)`）。没设深度时走的还是老路 —— 逐字节没变。
 *
 * ⚠️ **贴回用的不是写死的 normal，而是作用域最底层那个 op 自己的混合模式**：
 * 组是从透明起合成的，组内最底层没有背景板，对着透明黑做 `add`/`multiply` 只会
 * 得到黑（alpha 却照常累积）。所以组内那一层按 normal 收进来，混合模式留到贴回
 * 那一步、对着真正的背景板执行。细节与已知近似见 `runOps` 与 `bottomScopeBlend`。
 *
 * 反馈池：feedback 类特效（echo）需要跨帧历史，每个特效实例一对 Target，
 * seek 时由 Renderer 调 clearFeedback() 清空（预览 seek 后的暖帧差异是
 * 可接受瞬态；导出是顺序渲染，天然确定）。
 *
 * ## 转场为什么走「两张全帧层 + 一个混合 pass」
 *
 * `buildStack` 在窗口内只产出一个 transition op（而不是两个 source op），
 * 因为 gl-transitions 的着色器签名是 `vec4 transition(vec2 uv)`，它同时要
 * 两张贴图。两侧各自先做自己的 placement（各自的 transform / fit / opacity
 * 烘进各自的 alpha），再交给转场着色器混合，最后**作为一整层**用入画片段的
 * 混合模式贴到 acc 上。这样每侧的 transform 都不会被另一侧影响。
 */

import { frameOf } from './clock';
import { getLimits, mbToBytes } from '../core/capacity';
import { hexToRgba } from '../core/color';
import { gradePlan, gradePrecision, gradeTargetBytes, gradeTargetCount, type GradePlan, type GradePrecision, type GradeReason, type GradeScanOp } from '../core/grade';
import { BLEND_FRAG, BLEND_MODE_INDEX } from './blend.frag';
import { drawSizeFor, PLACEMENT_FRAG } from './placement.frag';
import { buildStack, type BuildStackOptions, type RenderOp, type ResolvedSource, type TransitionOp } from './stack';
import { bottomScopeBlend, neutralizeBottomBlend } from './scope-blend';
import type { Kit, Program, Target } from './kit';
import type { SpectrumTextures } from './spectrum-texture';
import type { BoxTracker } from './box-tracker';
import type { GlyphAtlases } from './glyph-atlas';
import type { CurveTextures } from './curve-texture';
import type { LutTextures } from './lut-texture';
import type { BeatGrid } from '../core/time';
import type { EffectClip, EffectInstance, Project, SourceClip } from '../core/schema';

export interface SourceTexture {
  tex: WebGLTexture;
  w: number;
  h: number;
}

/** 源解析器：由 renderer 装配（solid / image / algo 各自一路）。null = 这帧没准备好，跳过。 */
export type SourceResolver = (clip: SourceClip, t: number, frame: number) => SourceTexture | null;

export interface EffectCtx {
  t: number;
  frame: number;
  w: number;
  h: number;
  /** 工程帧率：`u_delta` = 1/fps（名义帧间隔）。 */
  fps: number;
  compositor: Compositor;
  /** 特效片段本体（曲线的宿主）：曲线键 `${instanceId}.${paramKey}`。 */
  clip: EffectClip;
  grid: BeatGrid;
  /**
   * 频谱纹理（`u_spectrum`）。由 `render-core` 装配。
   * `null` = 没有音频来源 —— 那时声明了 `u_spectrum` 的特效会读到一张零纹理
   * （静音），而不是未绑定的 sampler。
   */
  spectrum: SpectrumTextures | null;
  /**
   * 斑点追踪服务（`u_overlay` / `u_box*`）。由 `render-core` 装配。
   * `null` = 没有装配（离屏缩略图渲染之类）—— 那时声明了 `u_overlay` 的特效
   * 拿不到方框，效果退化成「原样输出」，而不是崩溃。
   */
  tracker: BoxTracker | null;
  /**
   * 字形图集（`u_atlas` / `u_glyphCount` / `u_glyphCols`）。由 `render-core` 装配。
   * `null` = 没有装配 —— 那时声明了 `u_atlas` 的特效读到未绑定 sampler，
   * 所以正常装配路径上它**恒非空**（`createRenderCore` 无条件创建）。
   */
  glyphs: GlyphAtlases | null;
  /**
   * 调色曲线表（`u_curve`）。由 `render-core` 装配。
   * `null` = 没有装配 —— 声明了 `u_curve` 的模块会读到未绑定 sampler，
   * 所以正常装配路径上它**恒非空**。
   */
  curves: CurveTextures | null;
  /** `.cube` 查找表（`u_lut`）。由 `render-core` 装配。 */
  luts: LutTextures | null;
}

/** 一帧求值的上下文（`runOps` 的递归参数包）：整帧不变，要原样穿过嵌套的作用域组。 */
interface FrameCtx {
  project: Project;
  t: number;
  frame: number;
  w: number;
  h: number;
}

/** 特效执行器：由 effects/registry 装配；之前特效片段是 no-op。 */
export type EffectRunner = (
  inst: EffectInstance,
  src: Target,
  dst: Target,
  ctx: EffectCtx,
) => void;

/**
 * 转场执行器：由 `effects/transitions/runner.ts` 装配。
 * `from` / `to` 是已经 placement 过的**全帧层**（透明度已烘进 alpha），
 * `ratio` 是 GL Transition Spec 的 `ratio = width / height`（float）。
 */
export type TransitionRunner = (
  defId: string,
  values: Record<string, number>,
  from: Target,
  to: Target,
  progress: number,
  ratio: number,
  dst: Target,
) => void;

/** 示波器探针尺寸。固定值：读数要能在预览与导出之间可比。 */
const SCOPE_W = 256;
const SCOPE_H = 144;
/** 每 N 帧采一次（60fps 下 ≈ 10Hz）。 */
const SCOPE_STRIDE = 6;

/** 一帧探针数据（已翻成上往下）。 */
export interface ScopeFrame {
  data: Uint8ClampedArray;
  w: number;
  h: number;
}

const PASSTHROUGH = `#version 300 es
precision highp float;
uniform sampler2D u_texture;
in vec2 vUv;
out vec4 outColor;
void main() { outColor = texture(u_texture, vUv); }`;

export class Compositor {
  private ping: Target | null = null;
  private pong: Target | null = null;
  /** 普通通路的 layer；转场通路的出画层。 */
  private placedA: Target | null = null;
  /** 转场通路的入画层。 */
  private placedB: Target | null = null;
  /** 转场着色器的输出，随后作为一整层 blend 到 acc 上。 */
  private trTmp: Target | null = null;
  /** 绑定链（`EffectClip.boundClipId`）链内 ping-pong 的草稿，见 `applyBoundChain`。 */
  private layerScratch: Target | null = null;
  /**
   * 中间目标当前的浮点分配方案（`null` = 还没分配）。
   *
   * 存的是**打算要什么**而不是 `Target.float` —— 后者在缺 `EXT_color_buffer_float`
   * 时静默是 false，拿它比较会让「想升但升不了」每帧都触发一次重建。
   */
  private alloc: { chain: boolean; bound: boolean } | null = null;
  /** 上一帧的调色判定（`gradeStats` 的读数）。 */
  private grade: { plan: GradePlan; precision: GradePrecision } = {
    plan: { requested: false, chain: false, bound: false, depth: 0 },
    precision: { float: false, reason: 'idle' },
  };
  /** 上一次播报过的降级原因：只在原因变化时 console 一次，不逐帧刷。 */
  private gradeWarned: GradeReason = 'idle';
  private readonly blendProg: Program;
  private readonly placeProg: Program;
  private readonly passProg: Program;
  private readonly feedback = new Map<
    string,
    { a: Target; b: Target; flip: boolean; hdr: boolean; used: number }
  >();
  /** 非 feedback 的 pre-pass 草稿（半分辨率 HDR，按尺寸复用一对）。 */
  private preScratch: { w: number; h: number; a: Target; b: Target } | null = null;
  /** 带 feedback 的 pre-pass 的全分辨率历史，键 `${instanceId}:${index}`。 */
  private readonly preFeedback = new Map<string, { a: Target; b: Target; flip: boolean; used: number }>();
  /** 逐实例的「上一帧链输入」（见 `delayedInputFor`）。 */
  private readonly delayedInput = new Map<string, { t: Target; used: number }>();
  /**
   * 影响深度（作用域组）的中间目标，**按下标 = 嵌套深度**。
   *
   * 用 `Map` 而不是数组：每帧结束会把「这一帧没用到的更深层级」放掉
   * （见 `trimPools`），数组上删元素会让下表整体前移、把还在用的那层挪走。
   */
  private readonly groups = new Map<number, { a: Target; b: Target }>();

  /*
   * 池子的**在帧记账**（与 `typography/runtime.ts` 的 `protectedKeys` 同构）。
   *
   * 这些池子是按实例键（`instanceId` / `instanceId:index`）常驻的，**从不释放**：
   * 反复改特效链、拖参数、删片段会让条目只增不减，每一条都是 1~2 张全分辨率
   * （可能是浮点）目标 —— 4K 下一条就是 132 MB。表现同样是静默的：显存耗尽 →
   * 上下文丢失 → 画面停更。
   *
   * 所以每帧记下「这一帧真的用到了哪些键」，池子按字节预算淘汰**不在这个集合里**
   * 的条目（`effectPoolMB`，按机器派生）。正在用的绝不淘汰：那些是**状态**
   * （反馈历史 / 上一帧输入），删了画面就错，而不是「变慢」。
   */
  private nowT = Number.NaN;
  private liveFx = new Set<string>();
  private liveFxPrev = new Set<string>();
  private liveFxT = Number.NaN;
  private poolOverBudget = false;
  private poolWarned = false;
  /** 池子条目的取用顺序（`used`），只用于「谁最久没被用到」的淘汰排序。 */
  private fxClock = 0;
  /** 本帧用到的最大作用域嵌套深度：比它更深的组目标可以放掉。 */
  private depthUsed = 0;

  /* ---------------------------------------------------- 示波器探针
   *
   * 示波器的数据源：合成之后插一张小目标 + `readPixels` 回 CPU。
   * 形状照抄 `box-tracker` 的探针（那条路已经证明可行），但**只在面板可见时**
   * 才跑，并且**限帧**（`SCOPE_STRIDE`）—— `readPixels` 是同步 stall，
   * 每帧读一次会把帧率砍掉三成。
   *
   * 探针尺寸固定，不跟渲染尺寸变：示波器的读数是给眼睛看的统计，
   * 分辨率变化只会让读数在预览 / 导出之间不可比。
   */
  private scopeOn = false;
  private scopeTarget: Target | null = null;
  private scopeRaw: Uint8Array | null = null;
  private scopeData: ScopeFrame | null = null;
  private scopeFlipped: Uint8ClampedArray | null = null;

  /**
   * 转场执行器。默认实现只把入画层搬过去（不混合）——真正的实现在
   * `render-core.ts` 里由 `effects/transitions/runner.ts` 装进来。
   * 赋值在构造函数体内，因为默认实现要用到 `passProg`。
   */
  public runTransition: TransitionRunner;

  /**
   * 频谱纹理（`u_spectrum`）。**可变字段而不是构造参数**：它由 `render-core`
   * 在装配后注入，而 lab 给的是合成频谱、主应用给的是工程音频 —— 构造签名
   * 不该为「谁来供数」而变。
   */
  public spectrum: SpectrumTextures | null = null;

  /**
   * 斑点追踪服务（`u_overlay`）。同样由 `render-core` 在装配后注入 ——
   * 它需要回读链输入并持有跨帧状态，属于「谁来供数」，不该进构造签名。
   */
  public tracker: BoxTracker | null = null;

  /**
   * 字形图集（`u_atlas`）。同样由 `render-core` 注入：它要读 Canvas2D 与
   * GL 纹理，属于「谁来供数」，不进构造签名。
   */
  public glyphs: GlyphAtlases | null = null;

  /** 调色曲线表（`u_curve`）。同样由 `render-core` 注入。 */
  public curves: CurveTextures | null = null;

  /** `.cube` 查找表（`u_lut`）。同样由 `render-core` 注入。 */
  public luts: LutTextures | null = null;

  /**
   * 「前 / 后对比」用的旁路：这个 id 的特效片段**整条链不参与渲染**。
   *
   * 为什么不改工程数据（把实例 `enabled = false`）：那是一笔撤销记录，
   * 而且用户按着「看原片」的时候工程其实被改了 —— 关掉面板忘恢复就变成
   * 静默的数据损坏。这里只影响渲染，`t` 与工程都不动。
   *
   * 语义是「跳过整条链」而不是「跳过某一个实例」：调色的四个模块是同一条链上
   * 的四个环，逐环旁路没有意义。
   */
  public bypassEffectClip: string | null = null;

  constructor(
    private readonly kit: Kit,
    public resolve: SourceResolver,
    public runEffect: EffectRunner,
    runTransition?: TransitionRunner,
  ) {
    this.blendProg = kit.quad(BLEND_FRAG, 'blend');
    this.placeProg = kit.quad(PLACEMENT_FRAG, 'placement');
    this.passProg = kit.quad(PASSTHROUGH, 'passthrough');
    this.runTransition =
      runTransition ??
      ((_defId, _values, _from, to, _progress, _ratio, dst) => {
        this.passProg.use();
        this.passProg.tex('u_texture', to.tex);
        this.kit.pass(this.passProg, dst);
      });
  }

  /**
   * 中间目标的**按需分配**：有调色模块的那一帧，ping/pong（与作用域组）走
   * RGBA16F，其余一律 RGBA8。
   *
   * 浮点承诺是**整帧**的：一旦 `promote.chain` 为真，`acc` 在两个浮点目标之间
   * 倒手，所以「调色 pass 的输入输出是浮点」这件事由调度保证，不需要特效自己
   * 判断。方案变了（工程里加了/删了调色片段）就整体重建 —— 6 张全分辨率目标
   * 换一次精度，比在两种精度之间搬内容便宜也更不容易错。
   *
   * `trTmp`（转场输出）**始终 8 位**：它从不承载调色的输入或输出，而在转场
   * 窗口里给它升精度是纯开销。转场两侧的 `placedA/B` 跟随 `bound`（绑定链跑在
   * 它们上面）。
   */
  private ensure(w: number, h: number, promote: { chain: boolean; bound: boolean }): void {
    if (!this.alloc || this.alloc.chain !== promote.chain || this.alloc.bound !== promote.bound) {
      for (const t of [this.ping, this.pong, this.placedA, this.placedB, this.trTmp, this.layerScratch]) {
        t?.dispose();
      }
      this.ping = null;
      this.pong = null;
      this.placedA = null;
      this.placedB = null;
      this.trTmp = null;
      this.layerScratch = null;
      // 作用域组目标也带精度标志：留着旧的会在同一帧里混用两种精度。
      for (const g of this.groups.values()) {
        g.a.dispose();
        g.b.dispose();
      }
      this.groups.clear();
      this.alloc = { ...promote };
    }
    const chainFloat = this.alloc.chain;
    const boundFloat = this.alloc.bound;
    if (!this.ping) this.ping = this.kit.target(w, h, { float: chainFloat });
    if (!this.pong) this.pong = this.kit.target(w, h, { float: chainFloat });
    if (!this.placedA) this.placedA = this.kit.target(w, h, { float: boundFloat });
    if (!this.placedB) this.placedB = this.kit.target(w, h, { float: boundFloat });
    if (!this.trTmp) this.trTmp = this.kit.target(w, h);
    this.ping.resize(w, h);
    this.pong.resize(w, h);
    this.placedA.resize(w, h);
    this.placedB.resize(w, h);
    this.trTmp.resize(w, h);
  }

  /**
   * 渲染一帧到屏幕（默认帧缓冲）。预览与导出都走这一个入口。
   *
   * `dst` 非空时最后一步画进那张目标而不是屏幕 —— **闪回**（`render/recall.ts`）
   * 用它把「过去的整帧」渲成一张纹理，再当作某一层的源。除此之外没有第二个
   * 调用方：预览与导出永远传默认值。
   */
  render(project: Project, t: number, opts?: BuildStackOptions, dst: Target | null = null): void {
    const w = this.kit.w;
    const h = this.kit.h;
    const frame = frameOf(t, project.fps);
    const ops = buildStack(project, t, opts);

    // 必须**先**建 op 列表再分配目标：16F 是按「这一帧真的有调色」决定的，
    // 而不是按工程里有没有调色片段（见 core/grade.ts）。
    const plan = gradePlan(ops as readonly GradeScanOp[]);
    const precision = gradePrecision(plan, w, h, mbToBytes(getLimits().gradeTargetMB), this.kit.floatTargets);
    this.noteGrade(plan, precision);
    this.ensure(w, h, {
      chain: precision.float && plan.chain,
      bound: precision.float && plan.bound,
    });

    this.nowT = t;
    this.depthUsed = 0;
    const acc = this.ping!;
    acc.bind();
    this.kit.clear();
    const out = this.runOps(ops, acc, this.pong!, 0, { project, t, frame, w, h });

    // 呈现到屏幕（或 `dst`：闪回的回放帧）。ops 为空时 acc 是刚清过的透明黑。
    this.passProg.use();
    this.passProg.tex('u_texture', out.tex);
    this.kit.pass(this.passProg, dst);

    // 示波器探针：必须在呈现之后、收池之前 —— 它读的是 `out`，与屏幕同源。
    if (this.scopeOn) this.captureScope(out, frame);

    // 帧末收池：把这一帧没用到的实例历史按预算放掉（见 trimPools）。
    this.trimPools();
  }

  /**
   * 跑一段 op 把它合成进 `acc`，返回**结果所在的**那个 Target。
   *
   * 递归的唯一原因是有影响深度的特效（`op.scope`，见 `stack.ts` 文件头）：作用域要
   * 从透明起独立合成，特效链作用在它上面，再以 normal 贴回下层。嵌套的组各用一对
   * 自己的目标（`groupTargets(depth)`），外层的中间结果因此不会被内层覆盖。
   * 没有 `scope` 时走的就是原来那条直路 —— 逐字节没变。
   */
  private runOps(
    ops: readonly RenderOp[],
    acc0: Target,
    buf0: Target,
    depth: number,
    c: FrameCtx,
  ): Target {
    let acc = acc0;
    let buf = buf0;
    for (const op of ops) {
      if (op.type === 'source') {
        this.drawSource(op.source, acc, buf, c);
        // 每个 op 都把结果写进了 buf：交换，让 buf 成为新的 acc。
        const tmp = acc;
        acc = buf;
        buf = tmp;
        continue;
      }
      if (op.type === 'transition') {
        this.drawTransition(op, acc, buf, c);
        const tmp = acc;
        acc = buf;
        buf = tmp;
        continue;
      }

      if (op.clip.id === this.bypassEffectClip) continue;

      const ctx: EffectCtx = {
        t: c.t,
        frame: c.frame,
        w: c.w,
        h: c.h,
        fps: c.project.fps,
        compositor: this,
        clip: op.clip,
        grid: c.project.beatGrid,
        spectrum: this.spectrum,
        tracker: this.tracker,
        glyphs: this.glyphs,
        curves: this.curves,
        luts: this.luts,
      };
      let src = acc;
      let dst = buf;
      if (op.scope) {
        // 作用域：从透明起独立合成一整段，再把特效链作用在它上面。
        const g = this.groupTargets(depth, c.w, c.h);
        g.a.bind();
        this.kit.clear();
        src = this.runOps(neutralizeBottomBlend(op.scope), g.a, g.b, depth + 1, c);
        dst = src === g.a ? g.b : g.a;
      }
      for (const inst of op.clip.chain) {
        if (!inst.enabled) continue;
        this.runEffect(inst, src, dst, ctx);
        // 链内每个特效都要交换——下一个特效读的是上一个的输出。
        const tmp = src;
        src = dst;
        dst = tmp;
      }

      if (!op.scope) {
        // 无作用域：链的输入输出本来就是 acc/buf，交换回来接着走。
        acc = src;
        buf = dst;
        continue;
      }
      // 有作用域：特效的输出是「只留下这些轨道」的一整层，贴回下层。
      //
      // 用**作用域最底下那个 op 自己的混合模式**贴回，而不是写死 normal ——
      // 组是从透明起合成的，最底层那个源在组内没有背景板可混（组内已按 normal
      // 收进来，见 neutralizeBottomBlend），它的混合模式必须留到这一步、对着
      // 真正的背景板（acc）做。否则 `add` / `multiply` / `screen` 这类依赖背景的
      // 模式会对着透明黑算：实测「黑填充 + 线性加深(add)」的圆形在作用域里变成
      // 不透明黑块，把下方的画面盖住。
      //
      // 已知近似：组内的 rgb 是**预乘 alpha** 的（normal 混合的结果），而混合公式
      // 又乘一次本层 alpha，所以**半透明边缘**会被多压一次（完全不透明的实心区域
      // 逐位一致）。要精确就得让组内保留直通色，代价是改动整条混合通路，暂不做。
      this.blendProg.use();
      this.blendProg
        .tex('u_texture', acc.tex)
        .tex('u_texture2', src.tex)
        .u1i('u_blendMode', BLEND_MODE_INDEX[bottomScopeBlend(op.scope)])
        .u('u_opacity', 1)
        .u1i('u_unpremult', 0);
      this.kit.pass(this.blendProg, buf);
      const tmp = acc;
      acc = buf;
      buf = tmp;
    }
    return acc;
  }

  /**
   * 作用域组的中间目标，**按嵌套深度取**：外层的组还在攒内容时内层的组也要一对，
   * 共用一对会让内层把外层的中间结果覆盖掉（表现是「嵌套一次，画面就少一层」）。
   *
   * 深度上界 = **这一帧**实际发生的嵌套层数：帧末 `trimPools` 会把更深的层级放掉，
   * 所以「删掉几层嵌套特效」之后那几张全分辨率目标不会一直留着。
   */
  private groupTargets(depth: number, w: number, h: number): { a: Target; b: Target } {
    this.depthUsed = Math.max(this.depthUsed, depth);
    let g = this.groups.get(depth);
    if (!g) {
      const float = this.alloc?.chain ?? false;
      g = { a: this.kit.target(w, h, { float }), b: this.kit.target(w, h, { float }) };
      this.groups.set(depth, g);
    }
    g.a.resize(w, h);
    g.b.resize(w, h);
    return g;
  }

  /**
   * 把一个超范围求值的片段画成**全帧层**：清成透明 → placement。
   *
   * `opacityForLayer` 只有转场通路才非 1（理由见 placement.frag.ts）。
   * 返回 false 表示源这帧没准备好（algo 烘焙中 / 图片未登记）——
   * 调用方决定这一层怎么缺席，这里不替它决定。
   *
   * **四角调整、抠图与裁剪都在 placement 里做**（见 `placement.frag.ts` 文件头），
   * 所以转场两侧各自独立生效 —— `drawTransition` 对 from / to 各调一次本函数，
   * 两边的 key / quad / crop 不会串。反过来，特效片段（adjustment layer）碰不到
   * 它们：抠图的透明区这时候已经烘进 alpha 了。
   *
   * ## ⚠️ 源尺寸与帧尺寸成**非整数比**时，采样结果会有一对稳定态（2026-10-10）
   *
   * 这里的缩放采样（`u_drawSize` ≠ `u_frameSize`）在**非整数倍**下会读到纹素之间，
   * 而 GPU 的过滤采样在启动窗口内会给出两个不同的稳定结果。实测（lab，t 与参数
   * 全固定，逐帧读回哈希）：
   *
   * | 源尺寸 → 帧尺寸 | 倍数 | 结果 |
   * |---|---|---|
   * | 853×480 → 640×360（mandelbrot 默认 intRes） | 1.333… | 两个状态来回跳 |
   * | 640×360 → 640×360 | 1 | 跳一次后稳定 |
   * | 1280×720 → 640×360 | 2（精确） | 稳定 |
   *
   * 差异很小（177 个像素、单通道差 ≤5）且预热几十帧后消失，**视觉上不可见**，
   * 但「同一 t 两渲逐像素相等」这类断言会被它打成偶发失败（`lab.spec.ts` 的
   * 「非反馈特效同帧可复现」就是这么翻的）。换 `NEAREST` 采样、改 `sin` 相位
   * 都试过，无效 —— 这不是应用层能根治的（GPU 采样的低位行为），
   * 别在这里加补救代码。要断言确定性，就在测量前多渲一帧丢弃。
   */
  private placeLayer(source: ResolvedSource, dst: Target, c: FrameCtx, opacityForLayer: number): boolean {
    const src = this.resolve(source.clip, c.t, c.frame);
    dst.bind();
    this.kit.clear(); // 层外必须是透明，否则 blender 会以为整帧都被覆盖
    if (!src) return false;

    const { x, y, sx, sy, rot } = source.transform;
    const frameW = c.w;
    const frameH = c.h;
    const [dw, dh] = drawSizeFor(source.clip.fit, frameW, frameH, src.w, src.h, sx, sy);
    this.placeProg.use();
    this.placeProg
      .tex('u_texture', src.tex)
      .u('u_frameSize', [frameW, frameH])
      .u('u_drawSize', [dw, dh])
      .u('u_center', [x, y])
      .u('u_rot', rot)
      .u('u_opacity', opacityForLayer);

    // 四角透视：逆单应的三行（行主序）。没有（undefined / null = 不调整 / 退化）
    // 时传单位矩阵并把开关关掉 —— 着色器走原算式，与历史逐位一致。
    const inv = source.quadInverse;
    this.placeProg
      .u('u_quadOn', inv ? 1 : 0)
      .u('u_quadR0', inv ? [inv[0]!, inv[1]!, inv[2]!] : [1, 0, 0])
      .u('u_quadR1', inv ? [inv[3]!, inv[4]!, inv[5]!] : [0, 1, 0])
      .u('u_quadR2', inv ? [inv[6]!, inv[7]!, inv[8]!] : [0, 0, 1]);

    // 简易抠图：键色归一化到 0..1（hexToRgba 给的是 0..255）；关闭时 alpha 位 = 0。
    // 每次 place 都全量设置这五个 uniform：placeProg 是复用的 program，漏设一次
    // 就会把上一层的四角/键色泄漏到下一层 —— 只在特定图层顺序下出现、不报错。
    const key = source.key;
    if (key) {
      const [kr, kg, kb] = hexToRgba(key.color);
      this.placeProg
        .u('u_key', [kr / 255, kg / 255, kb / 255, 1])
        .u('u_keyParams', [key.tolerance, key.softness, key.spill]);
    } else {
      this.placeProg.u('u_key', [0, 0, 0, 0]).u('u_keyParams', [0, 0, 0]);
    }

    // 裁剪同理：必须每次全量设置（复用 program），否则上一层裁掉的边会漏到下一层。
    const crop = source.crop;
    if (crop) {
      this.placeProg
        .u('u_cropOn', 1)
        .u('u_crop', [crop.left, crop.top, crop.right, crop.bottom]);
    } else {
      this.placeProg.u('u_cropOn', 0).u('u_crop', [0, 0, 0, 0]);
    }

    this.kit.pass(this.placeProg, dst);

    /*
     * 绑定链（v11）：在这一层上就地跑，输出仍是 `dst`。
     *
     * 放在 placement **之后**、blend **之前**是全部要点：特效看到的是「这一层
     * 自己的像素」，看不到下方任何轨道；结果照常按目标片段自己的 blend /
     * opacity 混进 acc。转场通路两侧各跑一次，互不串。
     */
    if (source.bound) this.applyBoundChain(source.bound, dst, c);
    return true;
  }

  /**
   * 把一组绑定链按顺序跑在 `layer` 上，结果留在 `layer`（调用方只认这一张）。
   *
   * 链内 ping-pong 用一张常驻草稿（`layerScratch`）；偶数条特效时结果落在草稿里，
   * 搬回来一次。没有草稿的话两条特效就会「写入自己正在读的纹理」—— GL 上那是
   * 未定义行为，表现为同一帧的两次渲染不同。
   */
  private applyBoundChain(clips: readonly EffectClip[], layer: Target, c: FrameCtx): void {
    if (!this.layerScratch) {
      this.layerScratch = this.kit.target(c.w, c.h, { float: this.alloc?.bound ?? false });
    }
    this.layerScratch.resize(c.w, c.h);
    for (const clip of clips) {
      if (clip.id === this.bypassEffectClip) continue;
      const ctx: EffectCtx = {
        t: c.t,
        frame: c.frame,
        w: c.w,
        h: c.h,
        fps: c.project.fps,
        compositor: this,
        clip,
        grid: c.project.beatGrid,
        spectrum: this.spectrum,
        tracker: this.tracker,
        glyphs: this.glyphs,
        curves: this.curves,
        luts: this.luts,
      };
      let src = layer;
      let dst = this.layerScratch;
      for (const inst of clip.chain) {
        if (!inst.enabled) continue;
        this.runEffect(inst, src, dst, ctx);
        const tmp = src;
        src = dst;
        dst = tmp;
      }
      if (src !== layer) this.copyAcc(src, layer);
    }
  }

  /** `acc` 原样搬进 `dst`：某一层这帧缺席时保持 ping-pong 流水不中断。 */
  private copyAcc(acc: Target, dst: Target): void {
    this.passProg.use();
    this.passProg.tex('u_texture', acc.tex);
    this.kit.pass(this.passProg, dst);
  }

  private drawSource(source: ResolvedSource, acc: Target, buf: Target, c: FrameCtx): void {
    // 普通通路：opacity 交给 blend pass（u_opacity = 1 → 与历史逐位相同）
    const ok = this.placeLayer(source, this.placedA!, c, 1);
    if (!ok) {
      this.copyAcc(acc, buf);
      return;
    }
    this.blendProg.use();
    this.blendProg
      .tex('u_texture', acc.tex)
      .tex('u_texture2', this.placedA!.tex)
      .u1i('u_blendMode', BLEND_MODE_INDEX[source.blend])
      .u('u_opacity', source.opacity)
      .u1i('u_unpremult', 0);
    this.kit.pass(this.blendProg, buf);
  }

  /**
   * 转场通路。
   *
   * 两侧各自烘 opacity 进 alpha → 转场着色器混合 → 结果作为一整层用
   * **入画片段**的混合模式贴到 acc 上（窗口结束后的下一帧就是入画片段，
   * 用它的 blend 才不会有跳变；已知代价见 AGENTS 的转场一节）。
   *
   * 单侧缺席（algo 烘焙未就绪）时退化成该侧单独一层，而不是整层消失 ——
   * 预览允许「这一帧少一半」，但不该变成整帧黑。
   */
  private drawTransition(op: TransitionOp, acc: Target, buf: Target, c: FrameCtx): void {
    const placedA = this.placedA!;
    const placedB = this.placedB!;
    /*
     * `null` 侧 = 工程里那一侧本来就没有画面（不是「这一帧没准备好」）：
     * 清成透明后**照常跑转场着色器**，于是 slide / zoom 这类效果作用在
     * 「透明的一侧」上，而不是退化成一次淡出。
     */
    const hasFrom = op.from
      ? this.placeLayer(op.from, placedA, c, op.from.opacity)
      : this.clearLayer(placedA);
    const hasTo = op.to
      ? this.placeLayer(op.to, placedB, c, op.to.opacity)
      : this.clearLayer(placedB);

    let layer: Target;
    /** 走透明侧时着色器输出已经乘过 alpha，blend 前要除回去（见 BLEND_FRAG）。 */
    let unpremult = 0;
    if (hasFrom && hasTo) {
      this.runTransition(op.defId, op.values, placedA, placedB, op.progress, c.w / c.h, this.trTmp!);
      layer = this.trTmp!;
      if (op.single) unpremult = 1;
    } else if (hasFrom) {
      // 「有 from、to 这帧没准备好」与「to 本来就是透明」是两回事：前者是直通色。
      layer = placedA;
    } else if (hasTo) {
      layer = placedB;
    } else {
      this.copyAcc(acc, buf);
      return;
    }

    this.blendProg.use();
    this.blendProg
      .tex('u_texture', acc.tex)
      .tex('u_texture2', layer.tex)
      .u1i('u_blendMode', BLEND_MODE_INDEX[op.blend])
      // 两侧的 opacity 已经烘进各自 alpha（转场通路），这里不能再乘一次。
      .u('u_opacity', 1)
      // 这是 **int** uniform：用 `u()` 会走 uniform1f，在 int location 上是
      // INVALID_OPERATION（值保持 0，画面偏黑且不报错）。E2E 用 63 vs 127 抓到的。
      .u1i('u_unpremult', unpremult);
    this.kit.pass(this.blendProg, buf);
  }

  /** 把目标清成透明，并当作「这一层可用」。单侧转场的透明侧用它。 */
  private clearLayer(dst: Target): true {
    dst.bind();
    this.kit.clear();
    return true;
  }

  /* ------------------------------------------------------- 反馈池 */

  /**
   * 取特效实例的反馈对（尺寸跟随渲染尺寸，变了就重建——历史随之失效）。
   *
   * `hdr` 对应协议里的 `hdrFeedback`：有状态模拟的逐帧增量会低于 RGBA8 的
   * 量化步长，用 8bit 历史会 stall 成色块。标志变化时重建目标（旧历史的
   * 精度不够，留着不如丢掉）。
   */
  feedbackFor(
    instanceId: string,
    w: number,
    h: number,
    hdr = false,
  ): { read: Target; write: Target } {
    let e = this.feedback.get(instanceId);
    if (e && e.hdr !== hdr) {
      e.a.dispose();
      e.b.dispose();
      this.feedback.delete(instanceId);
      e = undefined;
    }
    if (!e) {
      e = {
        a: this.kit.target(w, h, { float: hdr }),
        b: this.kit.target(w, h, { float: hdr }),
        flip: false,
        hdr,
        used: 0,
      };
      this.feedback.set(instanceId, e);
    }
    e.a.resize(w, h);
    e.b.resize(w, h);
    e.used = ++this.fxClock;
    this.markFx('fx', instanceId);
    return e.flip ? { read: e.b, write: e.a } : { read: e.a, write: e.b };
  }

  /** 本帧的 write 成为下一帧的 read。 */
  feedbackCommit(instanceId: string): void {
    const e = this.feedback.get(instanceId);
    if (e) e.flip = !e.flip;
  }

  /* ------------------------------------------------- 特效的 pre-pass 池 */

  /**
   * 非 feedback 的 pre-pass 草稿对，**半分辨率 HDR**。
   *
   * 降采样只改 tap 密度、不改模糊半径 —— `u_resolution` 仍由 runner 传
   * 全分辨率尺寸，所以 `1/u_resolution` 算出来的偏移不会被减半。
   * 结果随后被主 pass 线性采样放大，视觉上等价。
   */
  preScratchFor(w: number, h: number): { a: Target; b: Target } {
    const hw = Math.max(1, Math.round(w / 2));
    const hh = Math.max(1, Math.round(h / 2));
    let s = this.preScratch;
    if (!s) {
      s = {
        w: hw,
        h: hh,
        a: this.kit.target(hw, hh, { float: true }),
        b: this.kit.target(hw, hh, { float: true }),
      };
      this.preScratch = s;
    } else if (s.w !== hw || s.h !== hh) {
      s.w = hw;
      s.h = hh;
      s.a.resize(hw, hh);
      s.b.resize(hw, hh);
    }
    return s;
  }

  /**
   * 带 `feedback` 的 pre-pass 的持久历史，键 `${instanceId}:${index}`。
   *
   * **全分辨率、浮点** —— 它是状态而不是中间结果：8bit 会把逐帧低于
   * 量化步长的增量抹平（背景估计、保持的关键帧都会因此冻结）。
   */
  preFeedbackFor(key: string, w: number, h: number): { read: Target; write: Target } {
    let e = this.preFeedback.get(key);
    if (!e) {
      e = {
        a: this.kit.target(w, h, { float: true }),
        b: this.kit.target(w, h, { float: true }),
        flip: false,
        used: 0,
      };
      this.preFeedback.set(key, e);
    }
    e.a.resize(w, h);
    e.b.resize(w, h);
    e.used = ++this.fxClock;
    this.markFx('pre', key);
    return e.flip ? { read: e.b, write: e.a } : { read: e.a, write: e.b };
  }

  preFeedbackCommit(key: string): void {
    const e = this.preFeedback.get(key);
    if (e) e.flip = !e.flip;
  }

  /**
   * **上一帧的链输入**，逐实例一张，供声明了 `delayedInput` 的 pre-pass 读。
   *
   * 存在的理由：有些原作（KinoDatamosh 的运动估计）要做「当前帧 vs 上一帧输入」
   * 的帧间差分，而链里拿不到它 —— `u_texture` 是上一环的输出、`u_feedback` 是
   * 自身上一帧的输出、`u_original` 是当前帧的链输入。让 pre-pass 自己用
   * `feedback` 存一帧输入也不行：那存的会是「上一帧它自己的输出」，永远差一帧。
   *
   * 由 runner 在整条链跑完之后写入本帧的链输入（见 `effects/runner.ts`）。
   */
  delayedInputFor(instanceId: string, w: number, h: number): Target {
    let e = this.delayedInput.get(instanceId);
    if (!e) {
      e = { t: this.kit.target(w, h), used: 0 };
      this.delayedInput.set(instanceId, e);
    }
    e.t.resize(w, h);
    e.used = ++this.fxClock;
    this.markFx('in', instanceId);
    return e.t;
  }

  /* ------------------------------------------------------- 池子的在帧记账 */

  /** 记下「这一帧用到了这个键」（与本帧 t 绑定，翻帧时把上一帧的集合并进来）。 */
  private markFx(tag: 'fx' | 'pre' | 'in', key: string): void {
    if (this.nowT !== this.liveFxT) {
      this.liveFxT = this.nowT;
      this.liveFxPrev = this.liveFx;
      this.liveFx = new Set();
    }
    this.liveFx.add(`${tag}:${key}`);
  }

  /** 不许淘汰的键（当前帧 ∪ 上一帧：淘汰可能落在两帧之间，屏幕上还是上一帧）。 */
  private protectedFx(): Set<string> {
    if (this.liveFxPrev.size === 0) return this.liveFx;
    if (this.liveFx.size === 0) return this.liveFxPrev;
    return new Set([...this.liveFx, ...this.liveFxPrev]);
  }

  /** 池子当前占的显存字节数（浮点目标按 RGBA16F 算 8 字节/像素）。 */
  private poolBytes(): number {
    const targetBytes = (t: Target): number => t.w * t.h * (t.float ? 8 : 4);
    let n = 0;
    for (const e of this.feedback.values()) n += targetBytes(e.a) + targetBytes(e.b);
    for (const e of this.preFeedback.values()) n += targetBytes(e.a) + targetBytes(e.b);
    for (const e of this.delayedInput.values()) n += targetBytes(e.t);
    for (const g of this.groups.values()) n += targetBytes(g.a) + targetBytes(g.b);
    return n;
  }

  /**
   * 帧末收池（`render()` 最后一步）。只做两件事：
   *
   * 1. **更深的组目标直接放掉**（这一帧没用到那么深）。
   * 2. 池子按 `effectPoolMB` 淘汰**不在在帧集合里**的条目，从最久没取用的开始，
   *    直到回到预算内。全都在用就停手并置 `poolOverBudget` ——
   *    反馈历史是**状态**，删掉画面就错（不是「变慢」），所以宁可显式超支。
   *
   * 这一条补的是「有池子没回收」：反复改特效链 / 拖参数 / 删片段会让条目只增不减，
   * 每一条 1~2 张全分辨率目标（4K 下一条 132 MB），而症状是静默的显存耗尽。
   */
  private trimPools(): void {
    for (const [d, g] of [...this.groups]) {
      if (d > this.depthUsed) {
        g.a.dispose();
        g.b.dispose();
        this.groups.delete(d);
      }
    }

    const budget = mbToBytes(getLimits().effectPoolMB);
    let bytes = this.poolBytes();
    this.poolOverBudget = false;
    if (bytes <= budget) return;

    const keep = this.protectedFx();
    const targetBytes = (t: Target): number => t.w * t.h * (t.float ? 8 : 4);
    type Candidate = { used: number; free: () => number };
    const cands: Candidate[] = [];
    for (const [k, e] of this.feedback) {
      if (!keep.has(`fx:${k}`)) {
        cands.push({ used: e.used, free: () => { const n = targetBytes(e.a) + targetBytes(e.b); e.a.dispose(); e.b.dispose(); this.feedback.delete(k); return n; } });
      }
    }
    for (const [k, e] of this.preFeedback) {
      if (!keep.has(`pre:${k}`)) {
        cands.push({ used: e.used, free: () => { const n = targetBytes(e.a) + targetBytes(e.b); e.a.dispose(); e.b.dispose(); this.preFeedback.delete(k); return n; } });
      }
    }
    for (const [k, e] of this.delayedInput) {
      if (!keep.has(`in:${k}`)) {
        cands.push({ used: e.used, free: () => { const n = targetBytes(e.t); e.t.dispose(); this.delayedInput.delete(k); return n; } });
      }
    }
    cands.sort((a, b) => a.used - b.used);
    for (const c of cands) {
      if (bytes <= budget) return;
      bytes -= c.free();
    }
    this.poolOverBudget = bytes > budget;
    if (this.poolOverBudget && !this.poolWarned) {
      this.poolWarned = true;
      console.warn(
        `[fx] 特效池在用的历史已超过预算 ${getLimits().effectPoolMB} MB，` +
          '这些是状态，不能淘汰；' +
          '可在 artmatic.capacity.json 里调大 effectPoolMB。',
      );
    }
  }

  /* ------------------------------------------------------- 示波器探针 */

  /** 面板可见性驱动：关掉之后不再花一次 pass + 一次 stall。 */
  setScopeProbe(on: boolean): void {
    this.scopeOn = on;
    if (!on) this.scopeData = null;
  }

  /** 最近一次回读的帧（`null` = 还没采到）。UI 按自己的节奏取，不要逐帧拉。 */
  scopeFrame(): ScopeFrame | null {
    return this.scopeData;
  }

  private captureScope(out: Target, frame: number): void {
    // 6 帧一次 ≈ 60fps 下 10Hz。示波器的意义是「和画面一致」，不是「逐帧」。
    if (frame % SCOPE_STRIDE !== 0) return;
    const w = SCOPE_W;
    const h = SCOPE_H;
    if (!this.scopeTarget) this.scopeTarget = this.kit.target(w, h);
    this.scopeTarget.bind();
    this.kit.clear();
    this.passProg.use();
    this.passProg.tex('u_texture', out.tex);
    this.kit.pass(this.passProg, this.scopeTarget);

    const gl = this.kit.gl;
    if (!this.scopeRaw) this.scopeRaw = new Uint8Array(w * h * 4);
    // 探针目标是 RGBA8、非 MSAA、非浮点 —— 这是 `readPixels` 唯一能直接读的组合。
    gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, this.scopeRaw);

    /*
     * GL 的行序是**下往上**，而 Canvas2D / ImageData 是上往下。不翻的话
     * 波形图会上下颠倒 —— 看起来像「暗部跑到上面」，但那不是数据错了。
     */
    if (!this.scopeFlipped) this.scopeFlipped = new Uint8ClampedArray(w * h * 4);
    const rowBytes = w * 4;
    for (let y = 0; y < h; y += 1) {
      const src = (h - 1 - y) * rowBytes;
      this.scopeFlipped.set(this.scopeRaw.subarray(src, src + rowBytes), y * rowBytes);
    }
    this.scopeData = { data: this.scopeFlipped, w, h };
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  }

  /* ------------------------------------------------------- 调色的精度判定 */

  /**
   * 记下这一帧的判定，并在**原因变化**时播报一次。
   *
   * 播报的门槛是「原因变了」而不是「这一帧降级了」：逐帧 warn 会把控制台刷爆，
   * 而用户真正的出口在调色面板上那条提示（`insp.gradeNoFloat` / `insp.gradeBudget`）。
   */
  private noteGrade(plan: GradePlan, precision: GradePrecision): void {
    this.grade = { plan, precision };
    if (precision.reason === this.gradeWarned) return;
    this.gradeWarned = precision.reason;
    if (precision.reason === 'no-float') {
      console.warn(
        '[grade] 本机没有 EXT_color_buffer_float，调色的中间缓冲退回 RGBA8（按 8 位精度执行）',
      );
    } else if (precision.reason === 'over-budget') {
      console.warn(
        `[grade] 16F 中间缓冲需要 ${Math.round(gradeTargetBytes(plan, this.kit.w, this.kit.h) / (1024 * 1024))} MB，` +
          `超过预算 ${getLimits().gradeTargetMB} MB，本帧按 8 位精度执行；` +
          '可在 artmatic.capacity.json 里调大 gradeTargetMB。',
      );
    }
  }

  /**
   * 调色精度的读数（`__artmatic.gradeStats`）。
   *
   * `floatSupported` 是**设备能力**（与工程无关），`float` 是**上一帧实际给的**。
   * UI 用前者做即时提示（能力是静态的），用后者确认预算那条路径。
   */
  gradeStats(): {
    requested: boolean;
    float: boolean;
    /** 中间目标**实际**拿到的格式（`Target.float`）；上面那个是判定，这个是事实。 */
    allocFloat: boolean;
    reason: GradeReason;
    targets: number;
    floatSupported: boolean;
  } {
    const { plan, precision } = this.grade;
    return {
      requested: plan.requested,
      float: precision.float,
      allocFloat: this.ping?.float ?? false,
      reason: precision.reason,
      targets: precision.float ? gradeTargetCount(plan) : 0,
      floatSupported: this.kit.floatTargets,
    };
  }

  /** 诊断读数（`__artmatic.poolStats`）：预算、占用、在帧条目数与超支标志。 */
  poolStats(): { bytes: number; budgetMB: number; feedback: number; preFeedback: number; delayed: number; groups: number; live: number; overBudget: boolean } {
    return {
      bytes: this.poolBytes(),
      budgetMB: getLimits().effectPoolMB,
      feedback: this.feedback.size,
      preFeedback: this.preFeedback.size,
      delayed: this.delayedInput.size,
      groups: this.groups.size,
      live: this.protectedFx().size,
      overBudget: this.poolOverBudget,
    };
  }

  /** seek / 跳帧后清掉所有历史。 */
  clearFeedback(): void {
    for (const e of this.feedback.values()) {
      e.a.bind();
      this.kit.clear();
      e.b.bind();
      this.kit.clear();
    }
    for (const e of this.preFeedback.values()) {
      e.a.bind();
      this.kit.clear();
      e.b.bind();
      this.kit.clear();
    }
    // 延迟输入也是跨帧状态：不清的话 seek 之后第一帧会拿跳变前的画面做差分。
    for (const e of this.delayedInput.values()) {
      e.t.bind();
      this.kit.clear();
    }
  }
}
