/**
 * lab-state.svelte.ts — 试炼场的状态与渲染循环（Svelte 5 runes）。
 *
 * 与主应用 `ui/app-state.svelte.ts` 的关系：**只共享装配**（都走
 * `render-core`），不共享任何状态。试炼场没有工程、没有时间轴、没有撤销栈，
 * 它每帧现造一棵最小 `Project` 喂给 `Renderer.renderFrame`。
 *
 * 时间纪律（硬约束 1.1）：`t` 是唯一的渲染时间来源。rAF 回调用真实时间推进
 * 播放头，但**只把 `t` 传进 `renderFrame`** —— 渲染路径里没有任何时钟读取。
 * 暂停 / 拖动 / 帧步进时 `t` 完全由输入决定，所以同 t 的渲染是可复现的
 * （E2E 的确定性断言依赖这一点）。
 */

import { createRenderCore, type RenderCore } from '../src/render/render-core';
import { SCRUB_CATCHUP_BUDGET_MS, SCRUB_STEP_BUDGET_MS } from '../src/algos/runtime';
import { PatternRenderer, PATTERNS, isPatternId } from './patterns';
import { createLabSpectrum } from './spectrum';
import { createLabFeatures } from './features';
import {
  buildLabProject,
  LAB_BASE_H,
  LAB_BASE_W,
  LAB_BEAT_GRID,
  LAB_DURATION,
  LAB_FPS,
  LAB_RECALL_START,
  LAB_SEED,
  type LabSelection,
} from './build-project';
import { defaultEffectValues, getEffect, listEffects } from '../src/effects/registry';
import { defaultParams, getGenerator, listGenerators } from '../src/algos/registry';
import { compileAll, type CompileResult } from '../src/effects/compile-all';
import {
  DEFAULT_SHOT_HEIGHT,
  exportAllThumbnails,
  exportCanvas,
  shotFilename,
  type ShotHeight,
} from './export-thumbs';
import { hashSeed, mulberry32 } from '../src/core/prng';
import { tr } from '../src/i18n/index.svelte';
import type { ParamDef } from '../src/effects/types';
import type { Project } from '../src/core/schema';
import type { MessageKey } from '../src/i18n/locales';
import { resolveLabel, type Label } from '../src/i18n/label';

export interface LabItem {
  id: string;
  /** 内置存文案键、插件存字面量 —— 与注册表同源，读取点走 `resolveLabel()`。 */
  nameKey: Label;
  /** 种类徽标（烘焙 / 模拟 / 实时 / 内置）。特效没有徽标。 */
  badgeKey?: MessageKey;
  params: ParamDef[];
}

const KIND_BADGE: Record<string, MessageKey> = {
  bake: 'lab.kindBake',
  sim: 'lab.kindSim',
  realtime: 'lab.kindRealtime',
};

/**
 * 「源」= 内置测试图 + 算法生成器。
 *
 * 两者走**同一条** `type:'algo'` 通道（测试图靠 `lab:` 前缀在 resolver 里被
 * 拦截），所以列表里可以并列，不需要给 schema 加第五种 source 类型。
 */
const SOURCE_ITEMS: LabItem[] = [
  ...PATTERNS.map((p) => ({ id: p.id, nameKey: p.nameKey, badgeKey: 'lab.kindLab' as const, params: [] })),
  ...listGenerators().map((g) => ({
    id: g.id,
    nameKey: g.nameKey,
    badgeKey: KIND_BADGE[g.kind] ?? 'lab.kindRealtime',
    params: getGenerator(g.id)?.params ?? [],
  })),
];

/**
 * 「无特效」那一行。存成哨兵 id 而不是 `null`，是为了让左栏分组、键盘导航
 * 与「当前选中哪一行」三处共用同一条数据 —— 给 null 单独开一个分支的话，
 * 每次加导航逻辑都要记得处理它一次。
 */
export const NO_EFFECT_ID = 'lab:none';

const EFFECT_ITEMS: LabItem[] = [
  { id: NO_EFFECT_ID, nameKey: 'lab.none', params: [] },
  ...listEffects().map((e) => ({
    id: e.id,
    nameKey: e.nameKey,
    params: getEffect(e.id)?.params ?? [],
  })),
];

export interface LabGroup {
  id: 'source' | 'effect';
  labelKey: MessageKey;
  items: LabItem[];
}

export const LAB_GROUPS: LabGroup[] = [
  { id: 'source', labelKey: 'lab.groupSource', items: SOURCE_ITEMS },
  { id: 'effect', labelKey: 'lab.groupEffect', items: EFFECT_ITEMS },
];

export const LAB_SOURCE_ITEMS = SOURCE_ITEMS;
export const LAB_EFFECT_ITEMS = EFFECT_ITEMS;

/**
 * 取某一条条目（左栏列表与右栏标题共用同一份数据）。
 *
 * 单一真源：`paramsFor` 也从这里取 —— 否则「按 id 找条目」会有两份 `find`，
 * 迟早一份改了一份没改。
 */
export function itemFor(scope: 'source' | 'effect', id: string | null): LabItem | undefined {
  if (!id) return undefined;
  const items = scope === 'source' ? SOURCE_ITEMS : EFFECT_ITEMS;
  return items.find((i) => i.id === id);
}

export function paramsFor(scope: 'source' | 'effect', id: string | null): ParamDef[] {
  return itemFor(scope, id)?.params ?? [];
}

/** 分辨率档位。0.5 是默认：1280×720 的一半，够看清结构又不会让分形掉帧。 */
export const LAB_SCALES = [1, 0.5, 0.25] as const;
export type LabScale = (typeof LAB_SCALES)[number];

function defaultsFor(scope: 'source' | 'effect', id: string | null): Record<string, number | string> {
  if (!id || id === NO_EFFECT_ID) return {};
  return scope === 'source' ? defaultParams(id) : defaultEffectValues(id);
}

const DEFAULT_SOURCE = SOURCE_ITEMS[0]!.id;
/**
 * 出厂**不挂任何特效**。
 *
 * 这里原来是 `'slices'`。代价不是「多一层」，而是**每一个「这个生成器长什么样」
 * 的判断都得先在心里减掉一层副作用** —— 而 `slices` 的横条错位看起来极像
 * 「SDF 的距离场碎了」（边缘成排方块、纯 x 的函数出现 y 方向台阶），实测让
 * 一次 3D 隧道的排查白跑了两个小时，最后是关掉特效链才看出画面本来就是干净的。
 *
 * 默认值应当让被观察的对象保持原样；要看特效自己选。
 */
const DEFAULT_EFFECT: string | null = null;

class LabState {
  readonly groups = LAB_GROUPS;

  /** 左栏搜索词。 */
  search = $state('');

  /* ---------------------------------------------------------------- 选择 */

  sourceId = $state<string>(DEFAULT_SOURCE);
  sourceParams = $state<Record<string, number | string>>(defaultsFor('source', DEFAULT_SOURCE));
  effectId = $state<string | null>(DEFAULT_EFFECT);
  effectParams = $state<Record<string, number | string>>(defaultsFor('effect', DEFAULT_EFFECT));

  /* ---------------------------------------------------------------- 播放 */

  playing = $state(false);
  /** 播放头（秒）。渲染的唯一时间来源。 */
  t = $state(0);
  scale = $state<LabScale>(0.5);
  bypass = $state(false);

  /* ---------------------------------------------------------------- 读数 */

  fps = $state(0);
  frameMs = $state(0);
  /**
   * 还在异步链接的着色器数。
   *
   * 试炼场是排查「某个生成器加载卡死」的第一现场，所以这里也必须看得见 ——
   * 否则「画面空着」与「在编译」长得一模一样（这一层的空白帧是 resolver 返回
   * null 造成的，不是错误）。
   */
  compilePending = $state(0);
  /** 源这一帧有没有出图（烘焙型算法首次会缺席）。 */
  srcPending = $state(false);

  /* ------------------------------------------------------------ 编译结果 */

  compileResults = $state<CompileResult[] | null>(null);

  /* ---------------------------------------------------------------- 内部 */

  private core: RenderCore | null = null;
  private patterns: PatternRenderer | null = null;
  /**
   * 试炼场的合成特征源。做成字段（而不是在装配处现造）是为了
   * `setAudioFeatures(false)` 之后还能还原 —— 那条开关是 E2E 判定
   * 「场景真的被音频特征驱动」的唯一办法：同一 t、同一参数，只有特征不同。
   */
  private readonly labFeatures = createLabFeatures();
  private raf = 0;
  private lastNow = 0;
  /** 上一次**渲染**的墙钟时刻（只用于把渲染节流到 LAB_FPS，不参与求值）。 */
  private lastRender = 0;
  private frames = 0;
  private fpsAt = 0;
  private smoothMs = 0;
  /** 源 resolver 本帧有没有返回 null（写完立刻同步到 srcPending）。 */
  private srcMissing = false;
  /** 合成工程缓存：只在选择/尺寸/旁路变化时重建。 */
  private cached: Project | null = null;
  private dirty = true;
  /** 「随机」按钮的序号。用它当种子的一部分，于是每次点击的结果可复现。 */
  private rndSeq = 0;

  get ready(): boolean {
    return this.core !== null;
  }

  /** 左栏要显示的分组（按搜索词过滤；空组丢掉）。 */
  visibleGroups(): LabGroup[] {
    const q = this.search.trim().toLowerCase();
    if (!q) return this.groups;
    return this.groups
      .map((g) => ({
        ...g,
        items: g.items.filter(
          (i) => resolveLabel(i.nameKey, tr).toLowerCase().includes(q) || i.id.toLowerCase().includes(q),
        ),
      }))
      .filter((g) => g.items.length > 0);
  }

  /** 键盘导航用的扁平顺序 —— 必须与左栏显示顺序逐项一致。 */
  private flatItems(): { scope: 'source' | 'effect'; id: string }[] {
    const out: { scope: 'source' | 'effect'; id: string }[] = [];
    for (const g of this.visibleGroups()) for (const i of g.items) out.push({ scope: g.id, id: i.id });
    return out;
  }

  /** ↑↓ 在可见列表里挪一格。源与特效共用一条扁平序，符合"看到一个列表"的直觉。 */
  moveSelection(delta: number): void {
    const items = this.flatItems();
    if (!items.length) return;
    const effectRow = this.effectRowId();
    const cur = items.findIndex((i) =>
      i.scope === 'source' ? i.id === this.sourceId : i.id === effectRow,
    );
    const next = items[Math.max(0, Math.min(items.length - 1, (cur < 0 ? -1 : cur) + delta))];
    if (!next) return;
    if (next.scope === 'source') this.selectSource(next.id);
    else this.selectEffect(next.id);
  }

  resolution(): { w: number; h: number } {
    return {
      w: Math.max(2, Math.round(LAB_BASE_W * this.scale)),
      h: Math.max(2, Math.round(LAB_BASE_H * this.scale)),
    };
  }

  /* ---------------------------------------------------------------- 装配 */

  attach(canvas: HTMLCanvasElement): void {
    if (this.core) return;

    const core = createRenderCore(canvas, {
      // 试炼场的工程是每帧现造的常量，这里只需要拍网格与种子。
      getProject: () => ({ beatGrid: LAB_BEAT_GRID, seed: LAB_SEED, fps: LAB_FPS }),
      // rAF 循环一直在跑，不需要"叫醒"，留着是为了 render-core 的接口完整。
      onAlgoReady: () => {},
      // 试炼场没有工程音频，给合成频谱 —— 否则 audio-bars 在 lab 里恒为静音、
      // 根本没法目视验收（与 patterns.ts 给合成测试图同一个思路）。
      // 合成特征同理：场景生成器要靠它才动起来。
      spectrum: createLabSpectrum(),
      features: this.labFeatures,
    });
    this.core = core;
    this.patterns = new PatternRenderer(core.kit);

    /*
     * 包一层 resolver：`lab:` 前缀的 id 交给测试图渲染器，其余原样转回
     * SourceManager（solid / 算法 / 排版）。这是测试图接入的**唯一**落点 ——
     * 生产注册表与 schema 都不需要知道它存在。
     */
    const inner = core.sources.resolve;
    core.renderer.setResolver((clip, t, frame) => {
      const s = clip.source;
      if (s.type === 'algo' && isPatternId(s.generator)) {
        this.srcMissing = false;
        return this.patterns!.render(s.generator, t);
      }
      const tex = inner(clip, t, frame);
      this.srcMissing = tex === null;
      return tex;
    });

    this.applySize();
    this.renderNow();
    this.raf = requestAnimationFrame(this.loop);
  }

  /** 把分辨率档位钉到后备缓冲上。 */
  private applySize(): void {
    if (!this.core) return;
    const { w, h } = this.resolution();
    /*
     * 用 setExportSize 而不是 attachDisplay + syncSize：`syncSize` 走
     * `fitPreviewSize`，而那里的 `k = Math.min(1, scale)` **只缩不放** ——
     * 中间舞台列在 1280 视口下只有约 640px 宽，100% 档会被悄悄缩成一半，
     * 档位语义整个失效。setExportSize 直接定住后备缓冲尺寸（CSS 负责
     * 把 canvas 缩放进舞台显示），三档才是真的三档。
     */
    this.core.renderer.setExportSize(w, h);
    this.dirty = true;
  }

  /* ------------------------------------------------------------ 渲染循环 */

  private loop = (now: number): void => {
    this.raf = requestAnimationFrame(this.loop);
    const dt = this.lastNow ? (now - this.lastNow) / 1000 : 0;
    this.lastNow = now;

    if (this.playing) {
      this.t = (this.t + dt) % LAB_DURATION;
      this.dirty = true;
    }

    /*
     * 播放时把渲染节流到 `LAB_FPS`。
     *
     * **反馈类特效按「渲染帧」累积状态**（每个 pass 只在渲染时步进一次），
     * 而 `u_delta` 是名义 `1/fps`。循环跑满 rAF（约 60）而 LAB_FPS = 30 时，
     * 仿真每秒会走 60 步 × 1/30 秒 = **比时间轴快一倍** —— 对不稳定的模拟
     * （petri）尤其明显，直接表现成「狂闪」。
     *
     * 主应用的 `tick()` 早就有这条节流；试炼场漏了。
     * 暂停时永远渲：那是「改参数立刻看到结果」的路径。
     */
    if (this.playing) {
      // 播放中一律精确：顺序推进本来就用不上预算，而落后于播放头的画面
      // 在播放语境下是错的。放在节流 `return` **之前**，否则被节流掉的那些
      // 帧会把上一轮拖动设的预算留在原地。
      this.core?.algos.setStepBudget(0);
      const minGap = 1000 / Math.max(1, LAB_FPS);
      if (now - this.lastRender < minGap - 1) return;
      this.lastRender = now;
    }

    const t0 = performance.now();
    this.renderNow();
    /*
     * 步进预算的**收回**（设置那侧见 `setT`）。播放中一律 0：顺序推进本来
     * 就用不上预算，而落后于播放头的画面在播放语境下是错的。静止且已追上
     * （`simLag === 0`）也回到 0 —— 此时任何一次 seek 都精确，于是
     * 「批量导缩略图」那种非交互路径不会渲出落后帧。
     */
    this.core?.algos.setStepBudget(
      !this.playing && this.core.algos.takeSimLag() > 0 ? SCRUB_CATCHUP_BUDGET_MS : 0,
    );
    // 帧耗时与 fps **只用于读数**，不参与任何渲染求值（硬约束 1.1）。
    this.smoothMs = this.smoothMs * 0.9 + (performance.now() - t0) * 0.1;
    // 异步链接中的着色器数（转圈用）。纯内存读，`renderNow` 已经推进过链接。
    this.compilePending = this.core?.kit.pendingCompiles ?? 0;
    this.frames++;
    if (now - this.fpsAt > 500) {
      this.fps = Math.round((this.frames * 1000) / (now - this.fpsAt));
      this.frameMs = this.smoothMs;
      this.frames = 0;
      this.fpsAt = now;
    }
  };

  private project(): Project {
    if (!this.cached || this.dirty) {
      const sel: LabSelection = {
        sourceId: this.sourceId,
        sourceParams: { ...this.sourceParams },
        effect: this.effectId ? { id: this.effectId, params: { ...this.effectParams } } : null,
      };
      this.cached = buildLabProject(sel, this.resolution(), { bypass: this.bypass });
      this.dirty = false;
    }
    return this.cached;
  }

  private renderNow(): void {
    if (!this.core) return;
    this.core.renderer.renderFrame(this.project(), this.t);
    const pending = this.srcMissing;
    if (pending !== this.srcPending) this.srcPending = pending;
  }

  /* ---------------------------------------------------------------- 动作 */

  selectSource(id: string): void {
    this.sourceId = id;
    this.sourceParams = defaultsFor('source', id);
    /*
     * 回放型（闪回）的片段头在 `LAB_RECALL_START` 之后（见 build-project.ts），
     * 播放头停在它前面时整屏是空的 —— 那不是「坏了」，但看起来一模一样。
     * 只在还没走进片段时推一把；用户自己停在哪儿不会被抢回来。
     */
    if (getGenerator(id)?.kind === 'recall' && this.t < LAB_RECALL_START + 1) {
      this.t = LAB_RECALL_START + 2;
    }
    this.afterSelectionChange();
  }

  selectEffect(id: string | null): void {
    this.effectId = id === NO_EFFECT_ID ? null : id;
    this.effectParams = defaultsFor('effect', this.effectId);
    this.afterSelectionChange();
  }

  /** 当前选中的特效在左栏对应哪一行（无特效时是哨兵行）。 */
  effectRowId(): string {
    return this.effectId ?? NO_EFFECT_ID;
  }

  private afterSelectionChange(): void {
    /*
     * 刻意**不把 t 归零**。
     *
     * 试炼场的核心动作是「同一个时刻换一个源/特效来对比」——把播放头踹回 0
     * 会让每次对比都从头再来，而且生长型的算法（Rule 110 的生长前沿、
     * 生命游戏的演化）在 t=0 本来就是全黑的，一归零等于什么都没看到。
     *
     * 但**反馈历史必须清**：那是 echo 这类特效的跨帧状态，换了源还留着
     * 上一个源的拖尾就是纯粹的误导。
     */
    this.core?.renderer.onSeek();
    this.dirty = true;
  }

  setParam(scope: 'source' | 'effect', key: string, value: number | string): void {
    if (scope === 'source') this.sourceParams[key] = value;
    else this.effectParams[key] = value;
    this.dirty = true;
    // 不清反馈：拖 echo 的滑杆要看拖尾跟着变，清掉反而看不到。
  }

  setT(t: number): void {
    this.t = Math.max(0, Math.min(t, LAB_DURATION));
    this.core?.renderer.onSeek();
    /*
     * 时间滑杆的每次 pointermove 都会走到这里 —— 于是「有没有在拖」不用额外
     * 手势协议，这个 setter 本身就是手势信号。给模拟压一个步进预算：
     * 向前跳必须真把中间每一步算完（迭代系统没有闭式解），不压就会在拖动时
     * 冰住（实测 Lenia 一整条 24 秒轴 1.04 秒、沙堆 0.53 秒）。
     *
     * 收敛之后由 `loop` 的末尾把预算收回 0（精确）——放在 setter 里设、
     * 放在渲染之后收，是因为「设置的那一帧就得生效」而「收的时候要看真实滞后」。
     */
    this.core?.algos.setStepBudget(SCRUB_STEP_BUDGET_MS);
    this.dirty = true;
  }

  stepFrames(n: number): void {
    this.setT(this.t + n / LAB_FPS);
  }

  togglePlay(): void {
    this.playing = !this.playing;
    if (!this.playing) this.lastNow = 0;
  }

  setScale(s: LabScale): void {
    this.scale = s;
    this.applySize();
    this.core?.renderer.onSeek();
    this.renderNow();
  }

  setBypass(on: boolean): void {
    if (this.bypass === on) return;
    this.bypass = on;
    this.dirty = true;
  }

  /**
   * 摘掉 / 装上音频特征源。**给 E2E 用的**：同一 `t`、同一参数下，
   * 「有特征」与「没特征」必须是两张不同的图 —— 否则说明特征没接上
   * （漏传 `features`、`sceneUniforms` 没写、`AlgoRuntime` 没读，
   * 三者都会静默降级成「画面偏暗」，不报错）。
   */
  setAudioFeatures(on: boolean): void {
    if (!this.core) return;
    this.core.algos.setFeatureSource(on ? this.labFeatures : null);
    this.renderNow();
  }

  /* ------------------------------------------------------------ 参数工具 */

  resetParams(scope: 'source' | 'effect'): void {
    const id = scope === 'source' ? this.sourceId : this.effectId;
    const next = defaultsFor(scope, id);
    if (scope === 'source') this.sourceParams = next;
    else this.effectParams = next;
    this.dirty = true;
  }

  /**
   * 种子化随机（硬约束 1.2：禁止裸 `Math.random()`）。
   * 序列由 `rndSeq` 决定，所以「第 1 次点随机」在任何机器、任何时刻
   * 都得到同一组参数 —— 试炼场里看到一个好组合，别人能复现。
   */
  randomizeParams(scope: 'source' | 'effect'): void {
    const id = scope === 'source' ? this.sourceId : this.effectId;
    const params = paramsFor(scope, id);
    if (!params.length) return;
    const rng = mulberry32(hashSeed(LAB_SEED, 'rnd', scope, this.rndSeq++));
    const values: Record<string, number | string> = {};
    for (const p of params) {
      if (p.type === 'range') values[p.key] = p.min + rng() * (p.max - p.min);
      else if (p.type === 'select') values[p.key] = p.options[Math.floor(rng() * p.options.length)]!.value;
      else if (p.type === 'checkbox') values[p.key] = rng() < 0.5 ? 0 : 1;
      else if (p.type === 'bitmask') values[p.key] = Math.floor(rng() * 2 ** p.bits);
      // pattern 保持默认值：随机位图是一团噪声，既没有「图案」可言，
      // 也会把「随机出一组好看的参数」这件事直接毁掉。
      // text 同理：随机字符串既不可读，也会让「随机出一组好看的参数」失效。
      else values[p.key] = p.defaultValue;
    }
    if (scope === 'source') this.sourceParams = values;
    else this.effectParams = values;
    this.dirty = true;
  }

  /* ---------------------------------------------------------------- 编译 */

  runCompile(): CompileResult[] {
    if (!this.core) return [];
    const results = compileAll(this.core.kit).results;
    this.compileResults = results;
    return results;
  }

  failedIds(): Set<string> {
    const out = new Set<string>();
    for (const r of this.compileResults ?? []) if (!r.ok) out.add(r.id);
    return out;
  }

  compiledOkCount(): number {
    return (this.compileResults ?? []).filter((r) => r.ok).length;
  }

  /* ------------------------------------------------------------ 导出截图
   *
   * 目的：把缩略图变成**预先准备好的静态图**。理由有两条 ——
   *   1. 每次开选择器现渲七十多张，会短暂压帧（实测 240 → 190）；
   *   2. 有些底图自动选得不够准，需要人工过一遍。
   * 所以这里给两个动作：单张（当前画面）与批量（按目录底图整套）。
   */

  /** 批量导出的高度档位。 */
  shotHeight = $state<ShotHeight>(DEFAULT_SHOT_HEIGHT);
  /** 批量导出进行中。 */
  shotBusy = $state(false);
  /** 批量导出进度 `{done, total}`，未在跑时为 null。 */
  shotProgress = $state<{ done: number; total: number } | null>(null);
  /** 上一次导出的结果读数（成功或失败），null = 还没有过。 */
  shotMessage = $state<string | null>(null);

  /**
   * 把**当前画面**存成 PNG。文件名取特效 id（没选特效就回退源 id）。
   *
   * 暂停播放再存：`toBlob` 是异步的，而播放中的 rAF 循环会在它读画布之前
   * 再渲一帧 —— 存下来的就不是用户看到的那一帧了。
   */
  async exportShot(): Promise<void> {
    const core = this.core;
    if (!core) return;
    const wasPlaying = this.playing;
    if (wasPlaying) this.togglePlay();
    try {
      this.renderNow();
      const name = shotFilename(this.effectId, this.sourceId);
      await exportCanvas(core.kit.canvas, name);
      this.shotMessage = tr('lab.shotOneDone', { name });
    } catch (err) {
      this.shotMessage = tr('lab.shotFailed', { msg: String(err) });
    } finally {
      if (wasPlaying) this.togglePlay();
    }
  }

  /**
   * 按目录底图逐个特效渲一张，打成一个 zip 下载。
   *
   * 与选择器共用 `EffectThumbRenderer`，所以导出的就是选择器里会显示的东西。
   * 跑的时候暂停播放：批量渲染本身要占满主线程的分片，再叠一个 rAF 循环
   * 会让进度读数卡顿（画面也看不出变化，没有意义）。
   */
  async exportShots(): Promise<void> {
    if (this.shotBusy) return;
    const wasPlaying = this.playing;
    if (wasPlaying) this.togglePlay();
    this.shotBusy = true;
    this.shotProgress = { done: 0, total: listEffects().length };
    this.shotMessage = null;
    try {
      const res = await exportAllThumbnails(this.shotHeight, (done, total) => {
        this.shotProgress = { done, total };
      });
      this.shotMessage = tr('lab.shotAllDone', {
        n: res.count,
        size: `${(res.bytes / 1048576).toFixed(1)} MB`,
      });
    } catch (err) {
      this.shotMessage = tr('lab.shotFailed', { msg: String(err) });
    } finally {
      this.shotBusy = false;
      this.shotProgress = null;
      if (wasPlaying) this.togglePlay();
    }
  }

  /* ------------------------------------------------------------------ E2E
   *
   * 下面几个是给 `window.__lab` 用的。约定与 `window.__artmatic` 一致：
   * 像素在 page 内 reduce，只把标量/数组回传，避免几 MB 的 JSON 过界。
   */

  /** 在指定 t 渲一帧。`clearFeedback` 默认开——同 t 可复现的前提。 */
  renderAt(t: number, clearFeedback = true): void {
    if (clearFeedback) this.core?.renderer.onSeek();
    this.t = t;
    this.dirty = true;
    this.renderNow();
    /*
     * 这一次渲染可能才**触发**某个 program 的编译（program 是惰性创建的，
     * 进函数时队列还是空的）。等它链接完再渲一次：E2E 在同一个
     * `page.evaluate` 里「渲一帧 + 读像素」，缺帧就是一张黑图。
     */
    if (this.core && this.core.kit.pendingCompiles > 0) {
      this.core.kit.waitProgramsSync();
      this.renderNow();
    }
  }

  readPixels(): { data: number[]; w: number; h: number } {
    if (!this.core) return { data: [], w: 0, h: 0 };
    const { data, w, h } = this.core.renderer.readPixels();
    return { data: Array.from(data), w, h };
  }

  /** 后备缓冲尺寸（不是 canvas 的显示尺寸——那个被 CSS 缩过）。 */
  renderSize(): { w: number; h: number } {
    return this.core ? { w: this.core.kit.w, h: this.core.kit.h } : { w: 0, h: 0 };
  }

  /**
   * 斑点追踪的读数。没有它的时候「方框没出现」只能靠猜：是检测没找到斑、
   * 还是叠层没画、还是上传把链输入顶掉了。E2E 与手工调试都用它。
   */
  trackerStats(): ReturnType<RenderCore['tracker']['stats']> | null {
    return this.core ? this.core.tracker.stats() : null;
  }

  listIds(): { sources: string[]; effects: string[] } {
    return {
      sources: SOURCE_ITEMS.map((i) => i.id),
      effects: EFFECT_ITEMS.map((i) => i.id).filter((id) => id !== NO_EFFECT_ID),
    };
  }
}

export const labState = new LabState();
