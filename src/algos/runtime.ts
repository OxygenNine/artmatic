/**
 * runtime.ts — 算法生成器的渲染期运行时。
 *
 * 三型各自的每帧行为：
 *   bake    缓存命中 → reveal pass（生长前沿 u_front 由 t 驱动）
 *   sim     seek 到当前步 → 状态上传 R8（NEAREST）→ tint pass
 *   realtime 参数（含关键帧求值）→ 内部分辨率 shader pass
 *
 * 输出目标按尺寸入池复用：compositor 对每个源「resolve → placement
 * → blend」是顺序消费，同一个输出目标不会同时被两帧/两层引用。
 * shader 内部做 contain 适配（u_srcAspect / u_outAspect），
 * placement 层看到的是已经适配好的整帧画面。
 */

import { resolveParam, type ModTable, type ResolveCtx } from '../core/modulation';
import { getLimits, mbToBytes } from '../core/capacity';
import { hashSeed } from '../core/prng';
import { colorVec3 } from '../core/color';
import type { BeatGrid } from '../core/time';
import type { SourceClip } from '../core/schema';
import type { Kit, Program, Target } from '../engine/kit';
import type { SourceTexture } from '../engine/compositor';
import {
  ALGO_HEAD,
  FIT_GLSL,
  TINT_FRAG,
  TINT_HEAD,
  algoProgramName,
  algoTintProgramName,
  bgModeOf,
  type AlgoAuxTexture,
  type AlgoUniformCtx,
} from './shader-lib';
import { getGenerator } from './registry';
import { intResSize } from './int-res';
import { BakeClient } from './bake-client';
import {
  REVEAL_MODE,
  type AlgoAuxRef,
  type AssetResolver,
  type GpuSimHandle,
  type SimHandle,
} from './types';
import { emptyFeatures, zeroFeatures, type AudioFeatureSource } from './feature-source';
import { buildGlyphAtlas } from './glyph-atlas';
import { glyphLayout } from './glyph-layout';
import type { ParamDef } from '../effects/types';


/**
 * bake 型：R8 图 + 生长前沿揭示。
 *
 * `u_reveal` 决定前沿沿哪个量推进（见 types.ts 的 `BakeReveal`）：
 *   0 = 输出纵坐标（v=0 是第 0 代，在屏幕底部，向上长）
 *   1 = 输出横坐标（从左往右，分岔图逐列算出来）
 *   2 = 像素值本身（离根距离场：值小的先长出来）
 * 三者都乘 `cell`，所以值为 0 的背景在任何模式下都不会被点亮。
 */
const REVEAL_FRAG = `#version 300 es
precision highp float;
in vec2 vUv;
out vec4 outColor;
uniform sampler2D u_tex;
uniform float u_front;
uniform int u_reveal;
uniform vec3 u_colorBg;
uniform vec3 u_colorLive;
/* 由 AlgoRuntime 统一派发（不经 def）—— 见 shader-lib.ts 的 bgModeParam()。 */
uniform int u_bgMode;
${FIT_GLSL}
void main() {
  vec2 uv = containUv(vUv);
  float cell = texture(u_tex, clamp(uv, 0.0, 1.0)).r;
  float revealed;
  if (u_reveal == 2) revealed = step(cell, u_front);
  else if (u_reveal == 1) revealed = step(uv.x, u_front);
  else revealed = step(uv.y, u_front);
  float ink = cell * revealed * insideUv(uv);
  // 透明底：墨色 + 覆盖度（直通 alpha，理由见 shader-lib.ts 的 TINT_FRAG）。
  if (u_bgMode == 1) outColor = vec4(u_colorLive, ink);
  else outColor = vec4(mix(u_colorBg, u_colorLive, ink), 1.0);
}`;

interface SimEntry {
  handle: SimHandle;
  hash: string;
  tex: WebGLTexture;
  /** 创建时定下，不可变 —— 换通道数意味着换纹理，走的是「hash 变了重建」那条路。 */
  channels: 1 | 2 | 4;
  /**
   * 句柄**精确**所在的那一帧（本模块的记账）。
   *
   * ⚠️ **这不是"句柄的真实帧"，而是"我们相信句柄所在的帧"。** 平时两者一致，
   * 但 `Renderer.onSeek()`（跳帧 / 清反馈）之后就不一定了 —— 于是有了
   * `needsAlign`。别再把「没变就不调 seek」当成无条件安全的优化。
   */
  frame: number;
  /** 最近一次**请求**的帧（用来报滞后，`frame` 是实际渲染的帧）。 */
  target: number;
  /** 实测的每步成本（ms，指数滑动平均）。预算按它换算成步数。 */
  msPerStep: number;
  /** 令牌桶余额（ms）。见 `planSimStep`。 */
  tokens: number;
  /**
   * 下一次 `resolve` 先做一次**对齐**（`handle.seek(frame)`），再走常规路径。
   *
   * 由 `alignSims()`（= `Renderer.onSeek()` 的钩子）置位。见那个方法的注释：
   * 没有它，「同一 t 连渲两次」在跳帧之后可能给出两张不同的画面。
   */
  needsAlign: boolean;
}

/**
 * `gpu-sim` 的记账条目。除了句柄形状不同，其余字段**逐字复用** `SimEntry`：
 * `frame` / `target` / `tokens` / `msPerStep` / `needsAlign` 的语义与陷阱
 * 见上面那份定义，这里不复制第二遍。`tex` / `channels` 不需要 —— 状态纹理
 * 由句柄自己持有并 ping-pong，运行时只按 `hash` 决定何时重建。
 */
type GpuSimEntry = Omit<SimEntry, 'handle' | 'tex' | 'channels'> & {
  handle: GpuSimHandle;
};

/** `stats()` 里单个 GPU 模拟的诊断读数（结构化类型，不与内核实现耦合）。 */
export interface ParticleRuntimeDiagnostics {
  precision: '32f' | '8';
  degraded: boolean;
  reason: string;
  count: number;
  maxParticles: number;
  simFrame: number;
  snapshots: number;
}

export interface AlgoRuntimeStats {
  sims: number;
  simBytes: number;
  gpuSims: number;
  gpuSimBytes: number;
  particleDiagnostics: ParticleRuntimeDiagnostics[];
  assetNotices: string[];
  outTargets: number;
  outBytes: number;
  budgetMB: number;
}

/**
 * `advanceBudgeted` 只依赖这三样 —— `SimEntry` 与 `GpuSimEntry` 都满足，
 * 于是拖动 / 追赶的分块执行只有一份实现（硬约束 1.3 的预算纪律不许分叉）。
 */
interface BudgetedSim {
  frame: number;
  target: number;
  msPerStep: number;
  tokens: number;
  handle: { seek(f: number): void };
}

/**
 * 令牌桶的余额上限，按「几帧的预算」计。见 `planSimStep`。
 *
 * 上限是为了「不会攒出一个大跳」：攒下的额度一次性放出来的话，那一帧就会
 * 花掉好几帧的预算 —— 抖动又回来了。
 */
export const SIM_TOKEN_FRAMES = 3;

/**
 * 分块执行时的**块大小上限**。
 *
 * 为什么需要分块：`planSimStep` 的整数是按**估出来的**每步成本算的，而有些
 * 生成器的单步成本会突变两个数量级（沙堆塌一次可能是 0.1 ms，也可能是 10 ms）。
 * 一口气推完估出来的步数，就可能撞上那一下突变、做出一个几百毫秒的毛刺。
 * 所以真正的执行是「推一小块 → 看表 → 再决定」。
 *
 * 为什么 `max` 而不是固定块：便宜生成器（兰顿蚂蚁实测 0.000 ms/步）一帧要推
 * 上千步，固定小块会让它每帧循环上千次。块大小取「剩余预算 ÷ 估算成本」，
 * 用一份便宜的估算换掉绝大多数循环迭代。
 */
export const SIM_CHUNK_STEPS = 8;

/**
 * 拖动 / 追赶时，一帧该把模拟推到哪一帧。
 *
 * ## 为什么需要它
 *
 * `SimHandle.seek(f)` 的语义是**精确**的：`seek(f) ≡ 从 0 顺序 step f 次`
 * （硬约束 1.3）。于是向前拖播放头时，「从当前帧跳到目标帧」必须**真的把
 * 中间那些步全部算完** —— 这是迭代系统绕不开的（Lenia / Gray-Scott 没有
 * 闭式解，也没有能跳到 t(n) 的算法）。实测一条 24 秒的时间轴从头走到尾要
 * 沙堆 0.53 s、Lenia 1.04 s、反应扩散 0.51 s。整段同步算完 = 主线程冰住。
 *
 * 所以要做的**不是**改 `seek` 的语义（那会破坏确定性），而是**换一个帧渲染**：
 * 拖动期间这一帧只推进「付得起」的步数，画面显示的是模拟真实经过的某一帧
 * （只是比播放头早），松手之后继续按预算追赶，追上了就恢复精确。
 *
 * ## 令牌桶而不是「预算 ÷ 每步成本」
 *
 * 直接取整会在成本接近预算时掉到每帧 1 步，把预算白白浪费掉：Lenia 3.6 ms/步
 * + 6 ms 预算 → 每帧只花 3.6 ms，追赶时间多出 70%。攒够再花就没有这个损失。
 * 余额有上限（`SIM_TOKEN_FRAMES` 帧的量），所以不会攒出一个大跳。
 *
 * ## 确定性与 1.1
 *
 * 这个函数只决定**渲哪一帧**，不改任何一帧的状态；`budgetMs = 0` 时调用方
 * 根本不进这条路（精确行为），`lab` / 导出 / 单测都走那一侧。
 * 用到的 `performance.now()` 与 `app-state.tick()` 里那个降帧率节流同类 ——
 * 是**传输层的节流**，不参与内容求值。
 */
export function planSimStep(
  frame: number,
  target: number,
  budgetMs: number,
  msPerStep: number,
  tokens: number,
): { show: number; tokens: number } {
  if (target <= frame) {
    // 向后（或原地）：快照环保证回退代价有上界，不必也不该被预算限制。
    // 余额清零，免得向前拖时攒下的额度在回退之后突然放量。
    return { show: target, tokens: 0 };
  }
  const cap = budgetMs * SIM_TOKEN_FRAMES;
  const pool = Math.min(tokens + budgetMs, cap);
  const cost = planCost(msPerStep);
  const afford = Math.max(1, Math.floor(pool / cost));
  const steps = Math.min(target - frame, afford);
  return { show: frame + steps, tokens: Math.max(0, pool - steps * cost) };
}

/** 每步成本的下限。兼作 `msPerStep` 还没学出来 / 学成 NaN 时的兜底。 */
function planCost(msPerStep: number): number {
  return Number.isFinite(msPerStep) && msPerStep > 0.01 ? msPerStep : 0.01;
}

/**
 * 宿主设置步进预算时共用的两个档位（毫秒/渲染帧）。放在这里而不是 UI 里：
 * 主应用与 lab 各写一个数就会出现「试炼场里手感不一样」这种查不出的差异。
 *
 * - 拖动中：小一点，60 fps 下给渲染留出余量。
 * - 松手追赶：大一点 —— 用户已经停手在等结果，宁可每帧多花些也要尽快收敛。
 */
export const SCRUB_STEP_BUDGET_MS = 6;
export const SCRUB_CATCHUP_BUDGET_MS = 12;

/**
 * `recall` 型生成器的求值出口 —— 由宿主（`render/recall.ts`）注入。
 *
 * 返回 `null` 的语义与 bake 未就绪一致：**这一层这帧缺席**。它有三个来源：
 * 片段之前没有内容、回放嵌套已达上限、宿主还没装（单测 / 离屏小工具）。
 *
 * 入参是**求值好的**参数（与 `setUniforms` 同一条纪律）：本模块不认识
 * `ParamDef` 的语义，窗口怎么算是 `flashback.ts` 的事。
 */
export type RecallProvider = (
  clip: SourceClip,
  t: number,
  params: Record<string, number | string>,
  frame: number,
) => SourceTexture | null;

export class AlgoRuntime {
  private readonly revealProg: Program;
  private readonly tintProg: Program;
  private readonly outPool = new Map<string, Target>();
  /** `outPool` 每张的取用顺序（淘汰排序用），与 `outPool` 同生命周期。 */
  private readonly outUsed = new Map<string, number>();
  private outClock = 0;
  private readonly sims = new Map<string, SimEntry>();
  /** `gpu-sim` 的记账与 `sims` 分开：句柄形状不同，但共用预算 / 对齐设施。 */
  private readonly gpuSims = new Map<string, GpuSimEntry>();
  /**
   * 素材 id → 纹理。注入式（`render-core` 装），与 `setMaskAssetResolver` 同一条路径。
   * 没装时 `asset-image` 型 aux 一律缺席，回退到无贴图的均匀发射。
   */
  private assetResolver: AssetResolver | null = null;
  /**
   * 上传 / 创建纹理前的安全纹理单元。
   *
   * `bindTexture` / `texImage2D` / `texSubImage2D` 都作用在**当前激活单元**上，
   * 而 `Program.tex()` 会把采样本依次绑到 0..n 并留下最后一个为激活态；
   * 采样器没被编译器保留时 `tex()` 还会提前返回**且不递增单元号**。
   * 于是任何不经切换的创建/上传都可能把某个 sampler 指到错的纹理上
   * （事故形态：整片发红 / 采到上一层的图，见 AGENTS §5.5）。
   * 取 `MAX_COMBINED_TEXTURE_IMAGE_UNITS - 1` 而不是写死 31：WebGL2 只保证 ≥32。
   */
  private readonly scratchUnit: number;
  /** 运行时创建的内部纹理（字形图集等），按 kind 缓存。 */
  private readonly aux = new Map<string, AlgoAuxTexture>();
  /**
   * 音频特征来源（`render-core` 注入）。**没有源时读静音特征**而不是跳过 ——
   * 场景的 uniform 照常派发，只是值全 0，画面偏暗，而不是 sampler / 参数缺失。
   */
  private featureSource: AudioFeatureSource | null = null;
  /** `recall` 型（闪回）的求值出口。没装时那类生成器恒缺席。 */
  private recall: RecallProvider | null = null;
  /** `at()` 的复用出参（每帧每源都读，不能分配）。 */
  private readonly features = emptyFeatures();
  /** 模拟步进的每帧预算（ms）。0 = 精确。见 `setStepBudget` / `planSimStep`。 */
  private stepBudgetMs = 0;

  constructor(
    private readonly kit: Kit,
    private readonly bake: BakeClient,
  ) {
    const gl = kit.gl;
    const maxUnits = (gl.getParameter(gl.MAX_COMBINED_TEXTURE_IMAGE_UNITS) as number) || 16;
    this.scratchUnit = Math.max(0, maxUnits - 1);
    this.revealProg = kit.quad(REVEAL_FRAG, 'algo-reveal');
    this.tintProg = kit.quad(TINT_FRAG, 'algo-tint');
  }

  setFeatureSource(source: AudioFeatureSource | null): void {
    this.featureSource = source;
  }

  /**
   * 注入 `asset` 型参数的纹理解析出口。
   *
   * 素材台账在 `project/`，解码在 `engine/sources.ts`，都不属于 `algos/`。
   * 主 runtime 与 `render/recall.ts` 那台**都要装** —— 漏了回放侧的表现是
   * 「闪回里的粒子精灵贴图不见了」，而主画面完全正常。
   */
  setAssetResolver(fn: AssetResolver | null): void {
    this.assetResolver = fn;
  }

  /**
   * 注入 `recall` 型生成器的求值出口（见 `RecallProvider`）。
   *
   * 由 `render/render-core.ts` 装 —— 它要整帧重渲工程，属于**宿主能力**，
   * 本模块（`algos/`）不认识工程树。
   */
  setRecallProvider(fn: RecallProvider | null): void {
    this.recall = fn;
  }

  /**
   * 模拟步进的每帧预算（毫秒）。**0 = 不限制**（默认，= 精确行为）。
   *
   * 由宿主按交互状态设置：拖动播放头时给小值，松手后追赶时给大一点，
   * 导出 / 播放 / lab 时给 0。见 `planSimStep` 的长注释。
   */
  setStepBudget(ms: number): void {
    this.stepBudgetMs = Math.max(0, ms);
  }

  /**
   * 让每个模拟在**下一次求值前**与 `entry.frame` 对齐一次。
   *
   * ## 为什么必须有它
   *
   * `resolve` 里有一条优化：`show === entry.frame` 时不调 `seek`，直接复用句柄
   * 当前状态（见 `SimEntry.frame` 的注释）。它成立的前提是**记账与句柄一致**，
   * 而跳帧 / 清反馈之后这个前提会破 —— 表现是「同一 t 连渲两次得到两张不同的
   * 画面」：
   *
   * ```text
   * onSeek → renderFrame(0) → 画面 A
   * onSeek → renderFrame(0) → 画面 B   ← 309 个像素差，此后一直稳定在 B
   * ```
   *
   * 排查记录（2026-10-10，e2e 生命游戏用例）：期间 `entry.frame/target` 全程都是
   * 0、`handle.seek` 一次都没被调用（打补丁记录），只有**手动把记账的 `frame`
   * 置 -1 逼出一次 seek**，第一帧才会直接落到 B。即句柄实际所在的帧与记账脱节，
   * 而「跳过 seek」把它藏住了。
   *
   * ## 为什么不是「把 frame 置 -1」
   *
   * 那会让 `planSimStep` 从一个不存在的帧起步（`target - frame` 被凭空 +1，
   * `afford` 至少算出 1 步）。这里只**对齐**、不移动目标帧：预算路径（拖动 /
   * 追赶）的语义一个字都没变。
   *
   * ## 代价
   *
   * 每个 sim 一次 `handle.seek(它自称所在的帧)`。同帧上各生成器的 seek 都是
   * no-op（`target < frame` 不成立、`stepTo` 不推进），所以正常路径几乎免费；
   * 真脱节时这一次 seek 会把状态拉回精确帧 —— 这正是要的。
   */
  alignSims(): void {
    for (const e of this.sims.values()) e.needsAlign = true;
    for (const e of this.gpuSims.values()) e.needsAlign = true;
  }

  /**
   * 「上一帧渲染过」的 sim 源（`resolve` 里记，`takeSimLag` 里清）。
   * 见 `takeSimLag` 的注释：滞后的判据必须是**这一帧真的会渲的源**。
   */
  private readonly liveSims = new Set<string>();

  /**
   * 取「上一帧渲染过的 sim 里最大的滞后」，然后**翻帧标记**。
   *
   * 语义是**消费型**的：读一次就清空，下次只看新一帧解析过的条目。这不是
   * 洁癖，是必需的 —— 播放头停在片段末尾（`t >= clip.end`）时那个源根本不会
   * 被解析，它的滞后就会永远停在上次的值上。于是底栏永久显示「模拟追赶中」，
   * 而且预算永久停在追赶档、再也回不到精确路径。（E2E 实测到过：拖到 t = 24
   * 之后 `simLag` 恒为 259。）
   *
   * 宿主每帧读一次（`app-state.tick()` / lab 的 loop），且每个页面只有一个宿主。
   */
  takeSimLag(): number {
    let worst = 0;
    for (const id of this.liveSims) {
      const e = this.sims.get(id) ?? this.gpuSims.get(id);
      if (e && e.target > e.frame) worst = Math.max(worst, e.target - e.frame);
    }
    this.liveSims.clear();
    return worst;
  }

  /**
   * 按预算分块推进到 `want`。
   *
   * 两件事让「预算」真的成立：
   *   - 块大小取 `剩余预算 ÷ 估算成本`（有上限 `SIM_CHUNK_STEPS`），
   *   - **每块之后看表**，超时就停手。
   *
   * 只看估算是不够的：沙堆的单步成本能在一帧内从 0.1 ms 跳到 10 ms（一次
   * 大崩塌），按估算一口气推完就可能做出几百毫秒的毛刺。看表把这种突变的
   * 影响限制在一块之内。
   *
   * `performance.now()` 在这里只用来**量成本 / 判超时**，不参与内容求值 ——
   * 与 `app-state.tick()` 里那个降帧率节流同类（硬约束 1.1 管的是内容）。
   */
  /**
   * 把「请求帧 → 实际推进帧」这一段的记账与预算集中在一处。
   * `sim` 与 `gpu-sim` **共用**，于是拖动 / 追赶 / 导出的精确性不可能分叉
   * （硬约束 1.3：导出期间预算必须是 0）。
   */
  private stepTo(entry: BudgetedSim, simFrame: number, clipId: string): void {
    entry.target = simFrame;
    this.liveSims.add(clipId); // 见 takeSimLag

    let show = simFrame;
    let chunked = false;
    if (this.stepBudgetMs > 0 && simFrame > entry.frame) {
      const plan = planSimStep(entry.frame, simFrame, this.stepBudgetMs, entry.msPerStep, entry.tokens);
      entry.tokens = plan.tokens;
      show = plan.show;
      chunked = true;
    }
    if (show !== entry.frame) {
      if (chunked) this.advanceBudgeted(entry, show);
      else {
        // 精确路径（预算 0）：**原样**一次 seek。导出、播放、lab 的静止态
        // 与全部单测都走这里，语义必须与加预算之前逐字相同。
        entry.handle.seek(show);
        entry.frame = show;
      }
    }
  }

  private advanceBudgeted(entry: BudgetedSim, want: number): void {
    const budget = this.stepBudgetMs;
    const deadline = performance.now() + budget;
    const from = entry.frame;
    let cur = from;
    while (cur < want) {
      const left = deadline - performance.now();
      // 至少走一块：一块都不走的话 `msPerStep` 永远学不出来，会死锁在 0 步
      if (cur !== from && left <= 0) break;
      const chunk = Math.max(
        1,
        Math.min(want - cur, Math.floor(Math.max(left, 0.5) / planCost(entry.msPerStep)), SIM_CHUNK_STEPS),
      );
      const t0 = performance.now();
      entry.handle.seek(cur + chunk);
      const dt = performance.now() - t0;
      // 滑动平均而不是取上一次的值：单帧的抖动（GC / JIT）不该让预算放量或收紧
      entry.msPerStep = entry.msPerStep * 0.6 + (dt / chunk) * 0.4;
      cur += chunk;
    }
    entry.frame = cur;
  }

  readonly resolve = (
    clip: SourceClip,
    t: number,
    frame: number,
    grid: BeatGrid,
    projectSeed: number,
    fps: number,
    renderW: number,
    renderH: number,
    mods: ModTable,
  ): SourceTexture | null => {
    const rbase = { grid, fps, seed: projectSeed, mods };
    if (clip.source.type !== 'algo') return null;
    const def = getGenerator(clip.source.generator);
    if (!def) return null;
    const params = this.evalParams(clip, def.params, t, rbase);
    const seed = hashSeed(projectSeed, clip.id);

    if (def.kind === 'recall') {
      /*
       * 回放：内容不在这个模块里，整帧要由宿主重渲。`t` 传原始时间而不是
       * `max(0, t - clip.start)` —— 窗口是**绝对**时间轴上的过去，不是片段的
       * 局部时间（见 flashback.ts）。
       */
      return this.recall?.(clip, t, params, frame) ?? null;
    }

    if (def.kind === 'bake') {
      // 烘焙入参只求 clip.start 处的值——烘焙参数打关键帧 = 每帧重烘，禁止。
      // `volatile` 里的键（配色 / 揭示速度）不进哈希：它们只在 reveal pass 里读，
      // 改它们不该把一张 1024×512 的 L-system 重烘一遍。
      const bakeParams = this.evalParams(clip, def.params, clip.start, rbase);
      const hash = cacheHash(def.id, bakeParams, def.volatile, seed);
      const baked = this.bake.request(hash, def.id, bakeParams, seed);
      if (!baked) return null; // 烘焙中：这层这帧缺席
      const front =
        (Math.max(0, t - clip.start) * Number(params.speed ?? 96)) / Math.max(1, baked.frontMax);
      const out = this.outFor(renderW, renderH);
      this.revealProg.use();
      this.revealProg
        .tex('u_tex', baked.tex)
        .u('u_front', Math.min(1, front))
        .u1i('u_reveal', REVEAL_MODE[def.reveal ?? 'front-y'] ?? 0)
        .u('u_colorBg', colorVec3(String(params.colorBg ?? '#000000')))
        .u('u_colorLive', colorVec3(String(params.colorLive ?? '#ffffff')))
        .u('u_srcAspect', baked.w / baked.h)
        .u('u_outAspect', renderW / renderH)
        .u1i('u_bgMode', bgModeOf(params));
      this.kit.pass(this.revealProg, out);
      return { tex: out.tex, w: renderW, h: renderH };
    }

    if (def.kind === 'sim') {
      const createParams = this.evalParams(clip, def.params, clip.start, rbase);
      // 构造哈希**排除 volatile 键**：配色/调色板/显示开关改了不重建模拟。
      // JSON.stringify 保持插入顺序（= def.params 顺序），所以哈希仍然稳定。
      //
      // 通道数**刻意不进哈希**：`handle.channels` 是 def 级常量；万一将来某个
      // def 让通道数随参数变，那个参数本身就在哈希里 —— 于是自动覆盖，加个
      // 后缀只是多余的字符串拼接。
      const hash = cacheHash(def.id, createParams, def.volatile, seed);
      let entry = this.sims.get(clip.id);
      if (!entry || entry.hash !== hash) {
        // 换了构造参数（拖滑杆最常见）= 重建这个模拟：**旧的参数纹理必须先还回去**，
        // 否则每拖一格就漏一张（512² R8 = 256 KB，RGBA = 1 MB；拖一次滑杆几十格）。
        if (entry) this.kit.gl.deleteTexture(entry.tex);
        const handle = def.create(createParams, seed);
        const channels = normalizeChannels(handle.channels);
        entry = {
          handle,
          hash,
          tex: this.createSimTex(handle.gridW, handle.gridH, channels),
          channels,
          // `create()` 一律把状态造在「第 0 帧」
          frame: 0,
          target: 0,
          // 乐观起步：宁可第一帧多算一点（有 MAX_SIM_STEPS_PER_FRAME 兜着），
          // 悲观起步会让前几帧每帧只走 1 步、把追赶拖长。
          msPerStep: 1,
          tokens: 0,
          // `create()` 一律把状态造在第 0 帧，与 `frame: 0` 一致，不必对齐。
          needsAlign: false,
        };
        this.sims.set(clip.id, entry);
      }
      /*
       * `onSeek()` 之后先对齐一次（见 `alignSims`）：把句柄拉回我们记账的那一帧。
       * 幂等 —— 两边本来就一致时 `handle.seek` 什么都不做，所以正常路径零代价。
       * 必须在读 `stepsPerSec` / 算 `simFrame` **之前**：对齐之后这条 entry 的
       * `frame` 才是可信的，后面的预算判断全部建立在它上面。
       */
      if (entry.needsAlign) {
        entry.needsAlign = false;
        entry.handle.seek(entry.frame);
      }

      // 速度每帧从**当前**参数读（不是 handle 上创建时那份快照）——
      // 这正是 `rate` 能被排除出构造哈希的前提。
      const stepsPerSec = liveRate(params, entry.handle.stepsPerSec);
      const simFrame = Math.floor(Math.max(0, t - clip.start) * stepsPerSec);
      this.stepTo(entry, simFrame, clip.id);
      this.uploadSim(entry.tex, entry.handle.gridW, entry.handle.gridH, entry.channels, entry.handle.current());
      const out = this.outFor(renderW, renderH);
      // 自定义着色按 def.id 走 `kit.quad` 的具名缓存 —— 每帧重新拼串会让它
      // 每帧都按新名字查一次缓存（名字一样，所以是命中，但拼串本身是浪费）；
      // 更要紧的是名字必须与预编译一致，所以统一由 algoTintProgramName 生成。
      const prog =
        def.tintFragment !== undefined
          ? this.kit.quad(TINT_HEAD + def.tintFragment, algoTintProgramName(def.id))
          : this.tintProg;
      prog.use();
      prog
        .tex('u_tex', entry.tex)
        .u('u_colorBg', colorVec3(String(params.colorBg ?? '#000000')))
        .u('u_colorLive', colorVec3(String(params.colorLive ?? '#ffffff')))
        .u('u_srcAspect', entry.handle.gridW / entry.handle.gridH)
        .u('u_outAspect', renderW / renderH)
        .u1i('u_bgMode', bgModeOf(params));
      if (def.setTintUniforms) {
        def.setTintUniforms(
          this.kit.gl,
          prog.uniforms,
          params,
          this.makeCtx(t, frame, seed, entry.handle.gridW, entry.handle.gridH, fps, grid, clip),
        );
      }
      this.kit.pass(prog, out);
      return { tex: out.tex, w: renderW, h: renderH };
    }

    if (def.kind === 'gpu-sim') {
      /*
       * GPU 状态纹理：与 sim 同一套记账 / 预算 / 对齐，差别只在
       * 「状态上传」换成「句柄自己 step pass + 直接出图」。
       */
      const createParams = this.evalParams(clip, def.params, clip.start, rbase);
      const hash = cacheHash(def.id, createParams, def.volatile, seed);
      let entry = this.gpuSims.get(clip.id);
      if (!entry || entry.hash !== hash) {
        // 换构造参数 = 重建状态。**先 dispose 旧的四张状态纹理**，
        // 否则每拖一格滑杆就漏一组 RGBA32F（512×32 一张 1 MB）。
        entry?.handle.dispose();
        entry = {
          handle: def.create(createParams, seed, this.kit),
          hash,
          frame: 0,
          target: 0,
          msPerStep: 1,
          tokens: 0,
          needsAlign: false,
        };
        this.gpuSims.set(clip.id, entry);
      }
      if (entry.needsAlign) {
        entry.needsAlign = false;
        entry.handle.align();
      }

      const size = intResSize(String(params.intRes ?? '480'), renderW, renderH);
      const out = this.outFor(size.w, size.h);
      const uctx = this.makeCtx(t, frame, seed, size.w, size.h, fps, grid, clip);
      // aux 必须在 seek 之前注入：step pass 要用发射密度图决定出生位置。
      const auxMap = def.auxTextures ? this.bindAux(def.auxTextures, params) : undefined;
      entry.handle.setAux(auxMap, uctx);

      const stepsPerSec = liveRate(params, entry.handle.stepsPerSec);
      const simFrame = Math.floor(Math.max(0, t - clip.start) * stepsPerSec);
      this.stepTo(entry, simFrame, clip.id);
      entry.handle.render(out, params, uctx, auxMap);
      return { tex: out.tex, w: size.w, h: size.h };
    }

    // realtime：逐帧实时 shader（不做跳帧缓存——那是对确定性的破坏）
    /*
     * 内部尺寸来自 `intRes`，**宽高比取自渲染目标**（见 `int-res.ts`）。
     * `auto` 就是「跟渲染目标一样大」：预览跟画布，导出跟导出尺寸。
     */
    const size = intResSize(String(params.intRes ?? '480'), renderW, renderH);
    const w = size.w;
    const h = size.h;
    const out = this.outFor(w, h);
    /*
     * 片段与 program 名**成对**来自 def：结构由参数决定时（`scene-3d` 的槽）
     * `build` 会按「槽的 defId 序列」给出另一份 —— 名字不同 = 另一份 program，
     * 名字相同 = 换回来的槽复用了旧 program（画面还停在上一组几何）。
     */
    const built = def.build?.(params);
    const prog = this.kit.quad(
      ALGO_HEAD + (built?.fragment ?? def.fragment),
      built?.name ?? algoProgramName(def.id),
    );
    // aux 纹理必须在 `prog.use()` **之前**建好：创建纹理要 bindTexture，
    // 而它作用在当前激活单元上（见 scratchUnit 的注释）。
    const auxMap = def.auxTextures ? this.bindAux(def.auxTextures, params) : undefined;
    prog.use();
    prog
      .u('u_time', t)
      .u('u_delta', fps > 0 ? 1 / fps : 0)
      .u('u_seed', seed / 4294967296)
      .u('u_resolution', [w, h])
      .u('u_aspect', w / h)
      .u1i('u_bgMode', bgModeOf(params));
    if (auxMap) {
      for (const a of def.auxTextures!) {
        const tex = auxMap.get(a.uniform);
        if (tex) prog.tex(a.uniform, tex.tex);
      }
    }
    // 参数派发交给 def —— 通用化了才可能「场景 = realtime 生成器」。
    // 写死 uniform 名的年代，新 shader 拿不到参数**且不报错**，只是恒用默认值。
    //
    // 音频特征在同一处读：`at(t)` 是纯函数（离线轨查表），所以 seek 得到的
    // 特征与顺序播放一致 —— 这正是硬约束 1.1 要的（逐帧累加器做不到）。
    const uctx = this.makeCtx(t, frame, seed, w, h, fps, grid, clip, auxMap);
    def.setUniforms(this.kit.gl, prog.uniforms, params, uctx);
    this.kit.pass(prog, out);
    return { tex: out.tex, w, h };
  };

  /** 组装 uniform 上下文；特征对象在这里填充（它是复用的，不能分配）。 */
  private makeCtx(
    t: number,
    frame: number,
    seed: number,
    w: number,
    h: number,
    fps: number,
    grid: BeatGrid,
    clip: SourceClip,
    aux?: ReadonlyMap<string, AlgoAuxTexture>,
  ): AlgoUniformCtx {
    if (this.featureSource) this.featureSource.at(t, this.features);
    else zeroFeatures(this.features);
    return { t, frame, seed, w, h, fps, grid, clip, features: this.features, aux };
  }

  /**
   * 取（必要时创建）`def.auxTextures` 声明的纹理。
   *
   * 每帧都返回**新** map —— 它只在本次 resolve 内被读。字形图集按 kind
   * 长期缓存；素材纹理**不在这里缓存**：`SourceManager.resolveAssetImage`
   * 自己按 `(assetId, 尺寸)` 管缓存与淘汰，runtime 再持有一份引用就会在素材
   * 被淘汰后指向失效纹理（画面静默变黑）。
   *
   * **素材缺席时不放进 map**：消费方按「map 里有没有这一项」回退，
   * 不需要额外的 `On` 开关。
   */
  private bindAux(
    refs: readonly AlgoAuxRef[],
    params: Record<string, number | string>,
  ): Map<string, AlgoAuxTexture> {
    const map = new Map<string, AlgoAuxTexture>();
    let missing = false;
    for (const ref of refs) {
      if (ref.kind === 'glyph-atlas') {
        map.set(ref.uniform, this.auxFor());
        continue;
      }
      const assetId = String(params[ref.assetParam ?? ''] ?? '');
      if (!assetId) continue; // 未绑定 = 正常缺省，不是错误
      const resolved = this.assetResolver?.(assetId) ?? null;
      if (!resolved) {
        missing = true;
        continue;
      }
      map.set(ref.uniform, resolved);
    }
    this.noteAssetMissing(missing);
    return map;
  }

  /** 缺席状态变化时报一次（不逐帧刷、不打印 assetId）。 */
  private lastAssetNotice = false;

  private noteAssetMissing(missing: boolean): void {
    if (missing === this.lastAssetNotice) return;
    this.lastAssetNotice = missing;
    if (missing) console.warn('[algos] asset texture not ready; falling back to no-texture rendering');
  }

  /** 诊断读数：给状态栏显示「素材未就绪」。 */
  assetNotices(): string[] {
    return this.lastAssetNotice ? ['assetNotReady'] : [];
  }

  /** 运行时生成的纹理只有字形图集；asset-image 全部由注入的解析器给。 */
  private auxFor(): AlgoAuxTexture {
    const cached = this.aux.get('glyph-atlas');
    if (cached) return cached;
    const gl = this.kit.gl;
    // 创建纹理要 bindTexture —— 先切到 scratch，别踩采样器正在用的单元。
    gl.activeTexture(gl.TEXTURE0 + this.scratchUnit);
    const layout = glyphLayout();
    const atlas = buildGlyphAtlas(gl, layout);
    const built: AlgoAuxTexture = {
      tex: atlas.tex, w: atlas.w, h: atlas.h,
      cols: atlas.cols, rows: atlas.rows, cell: atlas.cell,
    };
    this.aux.set('glyph-atlas', built);
    return built;
  }

  /**
   * 参数求值：range 型参数走 `resolveParam`（曲线 + 调制槽，唯一入口）。
   *
   * 只有 `range` 型才求值 —— 枚举 / 颜色 / 位掩码参数上打的关键帧没有意义，
   * 而「调制一个枚举」更是无从定义。曲线键与参数键同名，所以判定只需要类型。
   */
  private evalParams(
    clip: SourceClip,
    defs: ParamDef[],
    t: number,
    rbase: Omit<ResolveCtx, 'clipStart'>,
  ): Record<string, number | string> {
    const raw = clip.source.type === 'algo' ? clip.source.params : {};
    const rctx: ResolveCtx = { ...rbase, clipStart: clip.start };
    const out: Record<string, number | string> = {};
    for (const p of defs) {
      const staticValue = raw[p.key] ?? p.defaultValue;
      if (p.type === 'range') {
        out[p.key] = resolveParam(clip, p.key, Number(staticValue), t, rctx);
      } else {
        out[p.key] = staticValue;
      }
    }
    return out;
  }

  /**
   * 按尺寸复用一张输出目标。
   *
   * 尺寸来自 `intRes` 之类的**可调参数**，所以「拖一次滑杆扫过几十个分辨率」
   * 就会攒下几十张全尺寸目标（1080p 一张 8.3 MB）—— 这条池子因此也要有预算。
   * 目标是**逐帧中间结果**（`resolve` 里立刻被画进合成链），所以淘汰是安全的：
   * 下一帧按同一尺寸再取时会重建。淘汰时**排除本次请求的这张**，否则刚建好就
   * 被自己丢掉。
   */
  private outFor(w: number, h: number): Target {
    const key = `${w}x${h}`;
    let target = this.outPool.get(key);
    if (!target) {
      target = this.kit.target(w, h);
      this.outPool.set(key, target);
      this.evictOutPool(key);
    }
    this.outUsed.set(key, ++this.outClock);
    return target;
  }

  /** 按 `simStateMB` 淘汰输出池里最久没用的那张（不动 `keepKey`）。 */
  private evictOutPool(keepKey: string): void {
    const budget = mbToBytes(getLimits().simStateMB);
    const bytesOf = (t: Target): number => t.w * t.h * t.bytesPerPixel;
    let total = 0;
    for (const t of this.outPool.values()) total += bytesOf(t);
    while (total > budget) {
      let victim: string | null = null;
      let oldest = Infinity;
      for (const [k, t] of this.outPool) {
        if (k === keepKey) continue;
        const used = this.outUsed.get(k) ?? 0;
        if (used < oldest) {
          oldest = used;
          victim = k;
        }
      }
      if (!victim) return; // 只剩刚请求的这张：停手（读数在 stats() 里）
      const t = this.outPool.get(victim)!;
      total -= bytesOf(t);
      t.dispose();
      this.outPool.delete(victim);
      this.outUsed.delete(victim);
    }
  }

  /**
   * 放掉一个模拟状态（片段被删 / 工程关闭时调）。
   *
   * 状态纹理**不能靠预算淘汰**：它装的是模拟的当前状态，删掉就必须从第 0 帧
   * 重推（硬约束 1.3 的 `seek(f) ≡ 顺序 step f 次` 那条会在时间上炸掉）。
   * 所以它的回收只能是**显式**的：谁不再需要这个片段，谁来调这里。
   */
  forget(clipId: string): void {
    const e = this.sims.get(clipId);
    if (e) {
      this.kit.gl.deleteTexture(e.tex);
      this.sims.delete(clipId);
    }
    const g = this.gpuSims.get(clipId);
    if (g) {
      // 状态纹理在句柄里，必须显式 dispose —— 靠 GC 或预算淘汰都会
      // 让「不再需要的片段」占着四张 RGBA32F。
      g.handle.dispose();
      this.gpuSims.delete(clipId);
    }
    this.liveSims.delete(clipId);
  }

  /** 诊断读数（`__artmatic.algoStats`）。粒子降级信息供状态栏显示。 */
  stats(): AlgoRuntimeStats {
    const bytesOf = (t: Target): number => t.w * t.h * t.bytesPerPixel;
    let simBytes = 0;
    for (const e of this.sims.values()) {
      simBytes += e.handle.gridW * e.handle.gridH * e.channels;
    }
    let gpuSimBytes = 0;
    const particleDiagnostics: ParticleRuntimeDiagnostics[] = [];
    for (const g of this.gpuSims.values()) {
      gpuSimBytes += g.handle.stateBytes;
      // 结构化类型：`ParticleEngine.diagnostics()` 满足它，runtime 不需要
      // import 内核（那会让 algos/runtime 依赖 algos/particles 的具体实现）。
      const h = g.handle as GpuSimHandle & { diagnostics?: () => ParticleRuntimeDiagnostics };
      if (h.diagnostics) particleDiagnostics.push(h.diagnostics());
    }
    let outBytes = 0;
    for (const t of this.outPool.values()) outBytes += bytesOf(t);
    return {
      sims: this.sims.size,
      simBytes,
      gpuSims: this.gpuSims.size,
      gpuSimBytes,
      particleDiagnostics,
      assetNotices: this.assetNotices(),
      outTargets: this.outPool.size,
      outBytes,
      budgetMB: getLimits().simStateMB,
    };
  }

  /**
   * 按通道数造状态纹理。`channels` 为 1 时与改动前**逐字节相同**
   * （R8 / NEAREST / CLAMP）—— 这是 `algos.spec.ts` 的 seek 确定性用例
   * 继续成立的前提，也是「生命游戏逐像素不变」的前提。
   */
  private createSimTex(w: number, h: number, channels: 1 | 2 | 4): WebGLTexture {
    const gl = this.kit.gl;
    const tex = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, tex);
    if (channels === 2) {
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RG8, w, h, 0, gl.RG, gl.UNSIGNED_BYTE, null);
    } else if (channels === 4) {
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    } else {
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.R8, w, h, 0, gl.RED, gl.UNSIGNED_BYTE, null);
    }
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    return tex;
  }

  private uploadSim(
    tex: WebGLTexture,
    w: number,
    h: number,
    channels: 1 | 2 | 4,
    data: Uint8Array,
  ): void {
    const gl = this.kit.gl;
    const fmt = channels === 2 ? gl.RG : channels === 4 ? gl.RGBA : gl.RED;
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, w, h, fmt, gl.UNSIGNED_BYTE, data);
  }
}

/**
 * 「算一次、缓存起来」那段的哈希（`bake` 的烘焙入参 / `sim` 的构造参数）。
 *
 * 抽成纯函数是为了**它能被单测钉住**：`stripVolatile` 本身好测，但真正要守的是
 * 「运行期确实用了它」。只测 helper 的话，把调用点改回 `JSON.stringify(params)`
 * 不会有任何测试变红 —— 而那正是这个机制唯一会坏的方式。
 */
export function cacheHash(
  id: string,
  params: Record<string, number | string>,
  volatileKeys: readonly string[] | undefined,
  seed: number,
): string {
  return `${id}|${JSON.stringify(stripVolatile(params, volatileKeys))}|${seed}`;
}

/** 把句柄上的 `channels` 收敛到支持的取值（缺省 = 单通道 = 旧行为）。 */
function normalizeChannels(ch: SimHandle['channels']): 1 | 2 | 4 {
  return ch === 2 || ch === 4 ? ch : 1;
}

/**
 * sim 的速度参数键 —— 家族约定，一律叫 `rate`。
 *
 * 它从构造哈希里排除（见 `SimDef.volatile`），所以必须每帧从**当前**参数读。
 * 非有限值（缺键 / 手改坏的工程文件）时退回句柄上那份，不退回 0 ——
 * 退成 0 会让模拟永远停在第一帧，看起来像「生成器坏了」。
 */
export function liveRate(params: Record<string, number | string>, fallback: number): number {
  const v = Number(params['rate']);
  return Number.isFinite(v) && v > 0 ? v : fallback;
}

/** 从构造参数里剔掉 `volatile` 列出的键（用于构造哈希）。 */
export function stripVolatile(
  params: Record<string, number | string>,
  volatileKeys: readonly string[] | undefined,
): Record<string, number | string> {
  if (!volatileKeys || volatileKeys.length === 0) return params;
  const out: Record<string, number | string> = {};
  for (const k of Object.keys(params)) {
    if (!volatileKeys.includes(k)) out[k] = params[k]!;
  }
  return out;
}
