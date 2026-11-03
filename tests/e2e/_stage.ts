/**
 * _stage.ts — 渲染类用例的共用脚手架（**不是** spec，不会被 playwright 收集）。
 *
 * 为什么需要它：2026-10-03 查清那批「已知 flaky」时发现，凡是直接往
 * **demo 工程**上叠加片段的用例，都会踩同样两个坑：
 *
 *   1. `ProjectStore.addTrack` 是 `p.tracks.push(...)` —— 新轨落在**数组末尾 =
 *      z 最低 = 最底层**。用例全都按「新轨在最上面」写，于是被测对象被 demo 的
 *      轨道整个遮住。实测：把画面隔离到只剩用例自己那两条轨后，
 *      **开关 slices 轨对画面的影响是 0 个像素** —— 那两条用例其实在测 demo 工程。
 *
 *   2. demo 的 `echo` 是**反馈型**特效（跨帧历史）。连渲同一 t 而中间不清历史，
 *      第二次读到的是第一次写进去的历史 —— 这本来就不该一致。
 *      `determinism.spec.ts` 的注释早就写明了这条契约（「连渲同一 t 不清历史是
 *      在泵历史，本身就不该一致」），并且它每次渲前都 `onSeek()`；
 *      而其它几条既不清历史、栈里又留着 echo。
 *
 * 所以渲染类用例统一从**空舞台**起步，并由这里保证「特效在源之上」。
 *
 * > 约定说明：本目录原先每个 spec 自带 `boot()`、不共享文件。这里破例开一个
 * > 共用模块，是因为上面两条坑已经在三个 spec 里各踩一遍 —— 同一段
 * > 「关 demo 轨 + 把特效置顶 + 清反馈」的代码抄三份，下次还会漏掉其中一份。
 */

import type { Page } from '@playwright/test';

/* ------------------------------------------------------------------ 类型 */

/** `window.__artmatic` 里本模块用到的部分。 */
interface StageApi {
  store: {
    addTrack: (kind: 'visual', name?: string) => string;
    addClip: (trackId: string, clip: unknown) => void;
    setTransitionOut: (
      clipId: string,
      defId: string,
      duration: number,
      values: Record<string, number>,
    ) => void;
    clearTransitionOut: (clipId: string) => void;
    setEffectAffectDepth: (clipId: string, depth: number) => void;
    findClip: (clipId: string) => { clip: { affectDepth?: number } } | null;
    commit: (
      label: string,
      fn: (p: { tracks: { id: string; enabled: boolean; clips: unknown[] }[] }) => void,
    ) => void;
  };
  renderer: { onSeek: () => void };
  renderFrame: (t: number) => void;
  readPixels: () => { data: number[]; w: number; h: number };
  algo: { defaultParams: (id: string) => Record<string, number | string> };
}

export type StageSource =
  | { type: 'algo'; generator: string; params?: Record<string, number | string> }
  | { type: 'solid'; color: string };

export interface SourceSpec {
  id: string;
  source: StageSource;
  start?: number;
  end?: number;
  blend?: string;
  opacity?: number;
  curves?: Record<string, unknown>;
}

export interface EffectSpec {
  id: string;
  defId: string;
  values: Record<string, number | string>;
  start?: number;
  end?: number;
}

export interface Stage {
  sourceTrack: string;
  /** 传了 effect 才有。 */
  effectTrack: string | null;
}

/* ------------------------------------------------------------ 页面内工具 */

/*
 * ⚠️ `page.evaluate` 的回调会被**序列化后送进页面**，所以它**读不到本模块
 * 作用域里的任何东西**（函数、常量都不行）。每个回调里必须就地写
 * `(window as never as { __artmatic: StageApi }).__artmatic`。
 * 这个坑踩过一次：抽出去一个 `api()` 助手，运行期报 `api is not defined`。
 */

/* ------------------------------------------------------------ 启动 / 打开示例 */

/**
 * 首屏是**零选项卡的首页**（`main.ts` 不再自动开 demo），而几乎所有用例
 * 都要求「有一份工程在上面」。这个助手就是那一步：停在首页时开一份示例工程，
 * 否则什么都不做。
 *
 * 为什么走 `__artmatic.newProject(true)` 而不是点按钮：首页已经没有「载入演示」
 * 入口（它搬进了 rail 的工程面板，而首页上的 rail 是 `inert` 的）。这条通道就是
 * UI 那个函数本身，与「新建弹窗」提交后走的是同一条路。
 *
 * 为什么要做成一个**每个等待点都要调**的助手，而不是塞进某个 `boot()`：
 * 各 spec 的启动形态不统一（有的在 `boot()` 里、有的在用例中途、有的在
 * `page.reload()` 之后），而 `waitForFunction(__artmatic)` 是它们唯一的公共点。
 *
 * 幂等：已经有工程时首页不在 DOM 里（`{#if !hasProject}`）。
 */
export async function openDemo(page: Page): Promise<void> {
  const home = page.getByTestId('empty-state');
  if ((await home.count()) === 0) return;
  await page.evaluate(() => {
    const api = (window as never as { __artmatic?: { newProject?: (demo?: boolean) => unknown } })
      .__artmatic;
    void api?.newProject?.(true);
  });
  // 打开是异步的（生成音频 + 解码 + 波形）。等到工程真的在上面再放手，
  // 否则调用方的第一个断言会撞上首页 —— 那种失败看起来像「界面坏了」。
  await page.waitForFunction(
    () => Boolean((window as never as { __artmatic?: { appState?: { hasProject: boolean } } }).__artmatic?.appState?.hasProject),
  );
}

/**
 * 工程里全部排版片段的 id（按轨道顺序）。
 *
 * 别用「工程里第一个 text 片段」代替差集：开箱 demo 自带一个标题排版片段，
 * 「第一个」永远是它，新加的那个读不到 —— 表现是「新建之后拖动纹丝不动」，
 * 而真因完全指不到这里。
 */
export async function textClipIds(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const A = (window as never as {
      __artmatic: { store: { project: { tracks: { clips: { id: string; source?: { type?: string } }[] }[] } } };
    }).__artmatic;
    const out: string[] = [];
    for (const t of A.store.project.tracks) {
      for (const c of t.clips) if (c.source?.type === 'text') out.push(c.id);
    }
    return out;
  });
}

/**
 * 轨道 ⋯ 菜单 → 新建排版片段，返回新建的那一个（差集里多出来的）。
 *
 * 抛普通 Error 而不是 `expect`：本文件只 import 类型，不把断言库拖进来；
 * 调用点在测试里，异常照样会把用例判红并带上这句话。
 */
export async function addTextClip(page: Page): Promise<string> {
  const before = await textClipIds(page);
  await page.locator('[data-testid=track-side-row]').nth(0).getByTestId('track-menu').click();
  await page.getByTestId('add-text').click();
  const added = (await textClipIds(page)).filter((id) => !before.includes(id));
  if (added.length !== 1) {
    throw new Error(`「+ 排版片段」没有新增片段（落点可能被重叠策略挡了）：实测新增 ${added.length} 条`);
  }
  return added[0]!;
}

/* ------------------------------------------------------------------ API */

/**
 * 关掉 demo 全部轨道，搭一条属于自己的「源 →（可选）特效」干净栈。
 *
 * 保证：特效轨**在源轨之上**（adjustment layer 语义 —— 这是 `buildStack`
 * 把 `tracks[0]` 映射成最大 z 的直接后果）。
 */
export async function buildStage(
  page: Page,
  source: SourceSpec,
  effect?: EffectSpec,
): Promise<Stage> {
  return page.evaluate(
    ({ source, effect }) => {
      const A = (window as never as { __artmatic: StageApi }).__artmatic;
      const base = { fadeSec: 0, curves: {}, transform: { x: 0.5, y: 0.5, sx: 1, sy: 1, rot: 0 }, fit: 'stretch' };

      // 1) 先把 demo 的轨道全关掉：否则被测对象会被它们遮住（而且 demo 的
      //    echo 是反馈型，会给「同帧一致」类断言带来跨帧历史）。
      A.store.commit('e2e: 清空舞台', (p) => {
        for (const t of p.tracks) t.enabled = false;
      });

      // 2) 源轨先加（先加 = 数组更靠前 = z 更高）
      const sourceTrack = A.store.addTrack('visual');
      A.store.addClip(sourceTrack, {
        ...base,
        curves: source.curves ?? {},
        kind: 'source',
        id: source.id,
        start: source.start ?? 0,
        end: source.end ?? 8,
        label: source.id,
        source:
          source.source.type === 'algo'
            ? {
                type: 'algo',
                generator: source.source.generator,
                params: source.source.params ?? A.algo.defaultParams(source.source.generator),
              }
            : { type: 'solid', color: source.source.color },
        blend: source.blend ?? 'normal',
        opacity: source.opacity ?? 1,
      });

      // 3) 特效轨后加（= 数组更靠后 = z 更低），再把它提到数组最前，
      //    让它在源**之上**。addTrack 的 push 语义见文件头注释。
      let effectTrack: string | null = null;
      if (effect) {
        effectTrack = A.store.addTrack('visual');
        A.store.addClip(effectTrack, {
          ...base,
          kind: 'effect',
          id: effect.id,
          start: effect.start ?? 0,
          end: effect.end ?? 8,
          label: effect.id,
          chain: [{ instanceId: `${effect.id}-i`, defId: effect.defId, enabled: true, values: effect.values }],
        });
        const fx = effectTrack;
        A.store.commit('e2e: 特效置顶', (p) => {
          const i = p.tracks.findIndex((t) => t.id === fx);
          const [moved] = p.tracks.splice(i, 1);
          p.tracks.unshift(moved!);
        });
      }

      // 4) 只启用我们自己的轨
      A.store.commit('e2e: 启用舞台', (p) => {
        for (const t of p.tracks) t.enabled = t.id === sourceTrack || t.id === effectTrack;
      });

      return { sourceTrack, effectTrack };
    },
    { source, effect },
  );
}

/** 开/关一条轨（用来断言「被测特效真的出现在画面上」）。 */
export async function setTrackEnabled(page: Page, trackId: string, enabled: boolean): Promise<void> {  await page.evaluate(
    ({ trackId, enabled }) => {
      const A = (window as never as { __artmatic: StageApi }).__artmatic;
      A.store.commit('e2e: 开关轨', (p) => {
        for (const t of p.tracks) if (t.id === trackId) t.enabled = enabled;
      });
    },
    { trackId, enabled },
  );
}

/**
 * 走「添加特效」选择器加一个特效。
 *
 * 选择器换掉了原来那个 `<select>` 下拉：现在要**点开 modal → 选中卡片 → 确认**
 * 三步。三处用例都要这个动作，所以收在这里 —— 抄三份的话，下次选择器再改一次
 * 就要改三个地方。
 *
 * 卡片用 `data-effect-id` 定位（不是显示名）：名字会随文案变，id 不会。
 * Playwright 的 `.click()` 会自动把滚出视口的卡片滚进来，所以不必先滚动。
 */
export async function addEffectViaPicker(page: Page, defId: string): Promise<void> {
  await page.getByTestId('add-effect-instance').click();
  await page.locator(`[data-testid=effect-picker-item][data-effect-id="${defId}"]`).click();
  await page.getByTestId('effect-picker-confirm').click();
}

/**
 * warm-up 的收敛判据：连续这么多帧完全一致就认为「稳定了」。
 *
 * 起因是一个**一次性过渡**（刻画与结论见 AGENTS §7）：页面加载后的头几次求值
 * 之内，画面水平正中的一个像素会翻到
 * 另一个值（量级 110），然后彻底稳定。它触发在**第 2–3 次求值之间**，
 * 时机随机器负载浮动。
 *
 * **不能用固定帧数**：实测「空渲 2 帧」仍会挂。必须用收敛判据。
 * `determinism.spec.ts` 里有一份同规则的实现（它必须在单个 `page.evaluate`
 * 内完成，用不了 Node 侧助手），改这里时那份要一起改。
 */
export const SETTLE_FRAMES = 6;

/** 渲到稳定为止（最多 SETTLE_CAP 帧），保证之后任何两次比较都不受那个过渡影响。 */
export async function settle(page: Page, t: number, settleFrames = SETTLE_FRAMES): Promise<void> {
  await page.evaluate(
    ({ t, settleFrames }) => {
      const A = (window as never as { __artmatic: StageApi }).__artmatic;
      const frame = (): number[] => {
        A.renderer.onSeek();
        A.renderFrame(t);
        return A.readPixels().data;
      };
      const same = (a: number[], b: number[]): boolean => {
        if (a.length !== b.length) return false;
        for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
        return true;
      };
      let prev = frame();
      let run = 0;
      let n = 1;
      while (n < 80) {
        const cur = frame();
        n++;
        run = same(prev, cur) ? run + 1 : 0;
        prev = cur;
        if (run >= settleFrames - 1) break;
      }
    },
    { t, settleFrames },
  );
}

/**
 * 同一 t 渲两次，返回逐通道差异计数。
 *
 * `clearFeedback`（默认 true）**每次渲前都清一次历史** —— 这正是
 * `determinism.spec.ts` 写明的契约：
 * 「同一历史状态下，同一 t 必须同帧」。
 * 传 false 是在泵历史，那种情况下**不一致是正确行为**，不要拿它当断言。
 *
 * 两次测量之前先 `settle()` —— 否则会被那个一次性过渡打到（实测挂过）。
 */
export async function renderTwiceDiff(page: Page, t: number, clearFeedback = true): Promise<number> {
  return (await renderTwiceStats(page, t, clearFeedback)).bytes;
}

/** 同帧两渲的差异统计。见 `renderTwiceStats`。 */
export interface TwiceStats {
  /** 逐字节不同的计数。 */
  bytes: number;
  /** 参与比较的字节总数（**比例判据的分母**）。 */
  total: number;
  /** 逐通道最大差值（0–255）。**只用于诊断，不要拿它当判据** —— 理由见下。 */
  maxDelta: number;
}

/**
 * 同一 t 渲两次的差异统计。
 *
 * ## 判据用**差异比例**（`bytes / total < 1%`），不要用「逐字节相等」，也不要用 `maxDelta`
 *
 * 逐字节相等在 GPU 上做不到。已知的那只鬼见 AGENTS §1.3 与
 * `compositor.ts::placeLayer`：源尺寸 → 帧尺寸**不是整数比**时（生命游戏 64×64 →
 * 558×314、lab 的 853×480 → 640×360），同一 t 会间歇地给出两个稳定态 ——
 * mandelbrot 在临界点上差一次逃逸、生命游戏在格子边界差一次量化。
 *
 * ⚠️ **`maxDelta` 派不上用场**：实测那条差异的单通道差可到 **158**（内容级），
 * 与「真的有东西变了」幅度相同 —— 想靠幅度区分噪声与回归是行不通的（试过）。
 * 有区分度的是**面积**：
 *
 * | 情形 | 字节占比（实测） |
 * |---|---|
 * | 上述两个稳定态之间的跳 | 0.04% ~ 0.06%（309 / 700848、531 / 921600） |
 * | 真实回归（跨帧状态残留、模拟多推进一步） | % 级起步 |
 *
 * 所以阈值定在 1%：容得下已知的闪烁，抓得住真正的回归。
 * 老的「=== 0」在 `algo-sim.spec.ts` 头注里被否过一次（当时定性为"固定的渲染层竞态"），
 * 这里是同一个结论的收敛版。
 */
export async function renderTwiceStats(page: Page, t: number, clearFeedback = true): Promise<TwiceStats> {
  await settle(page, t);
  return page.evaluate(
    ({ t, clearFeedback }) => {
      const A = (window as never as { __artmatic: StageApi }).__artmatic;
      const stats = (a: number[], b: number[]): { bytes: number; total: number; maxDelta: number } => {
        let bytes = 0;
        let maxDelta = 0;
        const len = Math.min(a.length, b.length);
        for (let i = 0; i < len; i++) {
          const dd = Math.abs((a[i] ?? 0) - (b[i] ?? 0));
          if (dd) bytes++;
          if (dd > maxDelta) maxDelta = dd;
        }
        return { bytes, total: len, maxDelta };
      };
      /*
       * 预热，跨过**启动窗口**。
       *
       * 页面刚加载后的头几十次求值里 GPU 会给出两个稳定态（实测：差异 177~531 个
       * 字节、单通道差可到 158 —— 是 mandelbrot 迭代在临界点上差一次逃逸，
       * 不是"噪声"，所以调阈值救不了），而它与「有没有跨帧状态残留」**无关**，
       * 后者才是这条断言要守的东西。多渲十几帧就跨过去了；真有残留的话，
       * 预热之后照样有残留。细节见 AGENTS §1.3 与 `compositor.ts::placeLayer`。
       */
      if (clearFeedback) A.renderer.onSeek();
      for (let k = 0; k < 16; k++) A.renderFrame(t);

      if (clearFeedback) A.renderer.onSeek();
      A.renderFrame(t);
      const a = A.readPixels().data;
      if (clearFeedback) A.renderer.onSeek();
      A.renderFrame(t);
      const b = A.readPixels().data;
      return stats(a, b);
    },
    { t, clearFeedback },
  );
}

/** 在指定 t 渲一帧并取像素均值（0–255）。 */
export async function meanAt(page: Page, t: number, clearFeedback = true): Promise<number> {
  return page.evaluate(
    ({ t, clearFeedback }) => {
      const A = (window as never as { __artmatic: StageApi }).__artmatic;
      if (clearFeedback) A.renderer.onSeek();
      A.renderFrame(t);
      const d = A.readPixels().data;
      let s = 0;
      for (let i = 0; i < d.length; i += 4) s += d[i]! + d[i + 1]! + d[i + 2]!;
      return s / (d.length / 4) / 3;
    },
    { t, clearFeedback },
  );
}

/** 在指定 t 渲一帧并取采样哈希（用来断言两个 t 的画面不同）。 */
export async function hashAt(page: Page, t: number, clearFeedback = true): Promise<number> {
  return page.evaluate(
    ({ t, clearFeedback }) => {
      const A = (window as never as { __artmatic: StageApi }).__artmatic;
      if (clearFeedback) A.renderer.onSeek();
      A.renderFrame(t);
      const d = A.readPixels().data;
      let h = 0;
      for (let i = 0; i < d.length; i += 887) h = (h * 31 + d[i]!) | 0;
      return h;
    },
    { t, clearFeedback },
  );
}

/**
 * 等**异步烘焙落地**。
 *
 * 固定 `waitForTimeout(2500)` 在负载下可能不够 —— 这正是 `algos.spec.ts`
 * 生命游戏那条偶发失败的原因：烘焙在断言中途落地，「缺席 → 在场」被误判成非确定。
 *
 * 从 **Node 侧**轮询（每次之间给 worker 喘息时间）。**不要**在 page 里写忙轮询：
 * 持续的 rAF + readPixels 长任务会把 worker 回包饿死在队列里（实测踩过）。
 */
export async function waitForSourceReady(
  page: Page,
  t: number,
  opts: { minMean?: number; timeoutMs?: number } = {},
): Promise<number> {
  const minMean = opts.minMean ?? 1;
  const deadline = Date.now() + (opts.timeoutMs ?? 20_000);
  let last = 0;
  let stableHits = 0;
  while (Date.now() < deadline) {
    last = await meanAt(page, t);
    stableHits = last > minMean ? stableHits + 1 : 0;
    // 连续两次非空才算就绪：单次命中可能是烘焙落地前后的一帧过渡。
    if (stableHits >= 2) return last;
    await page.waitForTimeout(200);
  }
  return last;
}

/* ------------------------------------------------- 影响深度（作用域组） */

export interface DepthTrackSpec {
  id: string;
  source: StageSource;
  opacity?: number;
  /** 只给想改的那几项（默认铺满整帧）。 */
  transform?: Partial<{ x: number; y: number; sx: number; sy: number; rot: number }>;
}

export interface DepthStageSpec {
  /** 顶部的特效片段：defId、参数、影响深度。 */
  effect: { id: string; defId: string; values: Record<string, number | string>; depth: number };
  /** 自顶向下第 2 条轨 —— 影响深度 1 时它在作用域里。 */
  scope: DepthTrackSpec;
  /** 再下面那条轨 —— 影响深度 1 时它**不该**被碰到。 */
  below: DepthTrackSpec;
}

export interface DepthStage {
  fxTrack: string;
  scopeTrack: string;
  belowTrack: string;
  fxClipId: string;
}

/**
 * 搭一条「特效（带影响深度）/ 作用域内源 / 更深一层源」的三轨舞台。
 *
 * 与 `buildStage` 同一套纪律（关掉 demo 全部轨道、只启用自己这三条），另外**显式
 * 排轨**：`addTrack` 是 push（新轨 z 最低），三轨的顺序必须自己钉死，否则特效会
 * 落到源下面 —— 那种错的画面「看起来也对」，只是什么都测不到（见文件头）。
 */
export async function buildDepthStage(page: Page, spec: DepthStageSpec): Promise<DepthStage> {
  return page.evaluate(
    ({ s }) => {
      const A = (window as never as { __artmatic: StageApi }).__artmatic;
      const base = { fadeSec: 0, curves: {}, transform: { x: 0.5, y: 0.5, sx: 1, sy: 1, rot: 0 }, fit: 'stretch' };
      const sourceOf = (src: StageSource) =>
        src.type === 'algo'
          ? { type: 'algo' as const, generator: src.generator, params: src.params ?? A.algo.defaultParams(src.generator) }
          : { type: 'solid' as const, color: src.color };

      A.store.commit('e2e: 清空舞台', (p) => {
        for (const t of p.tracks) t.enabled = false;
      });

      const fxTrack = A.store.addTrack('visual', 'FX');
      const scopeTrack = A.store.addTrack('visual', 'SCOPE');
      const belowTrack = A.store.addTrack('visual', 'BELOW');

      for (const [track, src] of [
        [scopeTrack, s.scope],
        [belowTrack, s.below],
      ] as const) {
        A.store.addClip(track, {
          ...base,
          transform: { ...base.transform, ...(src.transform ?? {}) },
          kind: 'source',
          id: src.id,
          start: 0,
          end: 8,
          label: src.id,
          source: sourceOf(src.source),
          blend: 'normal',
          opacity: src.opacity ?? 1,
        });
      }

      A.store.addClip(fxTrack, {
        ...base,
        kind: 'effect',
        id: s.effect.id,
        start: 0,
        end: 8,
        label: s.effect.id,
        chain: [{ instanceId: `${s.effect.id}-i`, defId: s.effect.defId, enabled: true, values: s.effect.values }],
        affectDepth: s.effect.depth,
      });

      // 轨道顺序 = 前景到背景：FX → SCOPE → BELOW
      A.store.commit('e2e: 排轨', (p) => {
        const pick = (id: string) => p.tracks.find((t) => t.id === id)!;
        const rest = p.tracks.filter((t) => t.id !== fxTrack && t.id !== scopeTrack && t.id !== belowTrack);
        p.tracks = [pick(fxTrack), pick(scopeTrack), pick(belowTrack), ...rest];
      });
      A.store.commit('e2e: 启用舞台', (p) => {
        for (const t of p.tracks) t.enabled = t.id === fxTrack || t.id === scopeTrack || t.id === belowTrack;
      });

      return { fxTrack, scopeTrack, belowTrack, fxClipId: s.effect.id };
    },
    { s: spec },
  );
}

/** 改影响深度（走 store 的正规入口，钳制与撤销都在那一处）。 */
export async function setEffectDepth(page: Page, clipId: string, depth: number): Promise<void> {
  await page.evaluate(
    ({ clipId, depth }) => {
      const A = (window as never as { __artmatic: StageApi }).__artmatic;
      A.store.setEffectAffectDepth(clipId, depth);
    },
    { clipId, depth },
  );
}

/**
 * 取一个像素（**归一化坐标**，`0..1`，**GL 行序：`fy = 0` 是画面底部**）。
 *
 * 用归一化坐标而不是像素下标：预览尺寸随窗口变，写死下标会在别的机器上量错位置。
 * 返回 `[r, g, b, a]`（0–255）。
 *
 * ⚠️ 想按「人眼的左上角」取点请用 `rgbaAtTopLeft`。这一版直接按行取，不做翻转，
 * 所以上下两半不同色的判据会读反 —— 那是历史接口，别再往新用例里用。
 */
export async function rgbaAt(
  page: Page,
  t: number,
  fx: number,
  fy: number,
  clearFeedback = true,
): Promise<[number, number, number, number]> {
  return page.evaluate(
    ({ t, fx, fy, clear }) => {
      const A = (window as never as { __artmatic: StageApi }).__artmatic;
      if (clear) A.renderer.onSeek();
      A.renderFrame(t);
      const { data, w, h } = A.readPixels();
      const x = Math.min(w - 1, Math.max(0, Math.floor(fx * w)));
      const y = Math.min(h - 1, Math.max(0, Math.floor(fy * h)));
      const i = (y * w + x) * 4;
      return [data[i]!, data[i + 1]!, data[i + 2]!, data[i + 3]!] as [number, number, number, number];
    },
    { t, fx, fy, clear: clearFeedback },
  );
}

/* ------------------------------------------------------------------ 转场 */

export interface TransitionStageSpec {
  /** 出画片段：`[0, cut)`，纯色。 */
  fromColor: string;
  /** 入画片段：`[cut, cut + toDuration)`，紧邻出画片段。 */
  toColor: string;
  /** 剪切点（也是出画片段的 end）。 */
  cut: number;
  toDuration: number;
  /** 转场 id（gl-transitions 的 name）。 */
  defId: string;
  /** 窗口总长。会被 `transitionMaxDuration` 钳制。 */
  duration: number;
  values?: Record<string, number>;
}

export interface TransitionStage {
  track: string;
  fromId: string;
  toId: string;
}

/**
 * 搭一条「两个紧邻纯色片段 + 出画转场」的轨道（关掉 demo 全部轨道）。
 *
 * 转场必须走 `store.setTransitionOut` 而不是直接写工程对象：钳制只有那一处实现，
 * 绕过去测的就是一个用户碰不到的路径。
 *
 * ⚠️ 片段 id **每次调用都不同**。原来写死 `tr-from` 导致同一个页面里调两次时，
 * `ProjectStore.findClip` 返回的是**第一次**那条（已禁用的）轨道上的片段，
 * `setTransitionOut` 就设到了看不见的那一条上 —— 画面里根本没有转场。
 */
let transitionStageSeq = 0;

export async function buildTransitionStage(
  page: Page,
  spec: TransitionStageSpec,
): Promise<TransitionStage> {
  transitionStageSeq += 1;
  const suffix = `-${transitionStageSeq}`;
  return page.evaluate(
    ({ s, suffix }) => {
      const A = (window as never as { __artmatic: StageApi }).__artmatic;
      const base = {
        fadeSec: 0,
        curves: {},
        transform: { x: 0.5, y: 0.5, sx: 1, sy: 1, rot: 0 },
        fit: 'stretch',
      };
      const fromId = `tr-from${suffix}`;
      const toId = `tr-to${suffix}`;

      A.store.commit('e2e: 清空舞台', (p) => {
        for (const t of p.tracks) t.enabled = false;
      });

      const track = A.store.addTrack('visual', `TR${suffix}`);
      A.store.addClip(track, {
        ...base,
        kind: 'source',
        id: fromId,
        start: 0,
        end: s.cut,
        label: 'from',
        source: { type: 'solid', color: s.fromColor },
        blend: 'normal',
        opacity: 1,
      });
      A.store.addClip(track, {
        ...base,
        kind: 'source',
        id: toId,
        start: s.cut,
        end: s.cut + s.toDuration,
        label: 'to',
        source: { type: 'solid', color: s.toColor },
        blend: 'normal',
        opacity: 1,
      });

      A.store.commit('e2e: 启用舞台', (p) => {
        for (const t of p.tracks) t.enabled = t.id === track;
      });

      // 两个片段都在场之后再设转场（它要解析相邻的入画片段）
      A.store.setTransitionOut(fromId, s.defId, s.duration, s.values ?? {});
      return { track, fromId, toId };
    },
    { s: spec, suffix },
  );
}

/** 删掉出画转场（用来断言「转场真的在影响画面」）。 */
export async function clearTransition(page: Page, clipId: string): Promise<void> {
  await page.evaluate((id) => {
    const A = (window as never as { __artmatic: StageApi }).__artmatic;
    A.store.clearTransitionOut(id);
  }, clipId);
}

/**
 * 三通道各自的均值（0–255）。
 *
 * 为什么不能直接用 `meanAt`：把两个**不同颜色**的帧混合时，整帧均值会把
 * 通道差异平均掉 —— 红→蓝在 progress=0.5 处的均值是 (127.5+0+127.5)/3 = 85，
 * 而单通道各自应当是 127.5 / 0 / 127.5。转场断言必须看通道。
 */
export async function rgbMeanAt(
  page: Page,
  t: number,
  clearFeedback = true,
): Promise<[number, number, number]> {
  return page.evaluate(
    ({ t, clearFeedback }) => {
      const A = (window as never as { __artmatic: StageApi }).__artmatic;
      if (clearFeedback) A.renderer.onSeek();
      A.renderFrame(t);
      const d = A.readPixels().data;
      const sum = [0, 0, 0];
      const n = d.length / 4;
      for (let i = 0; i < d.length; i += 4) {
        sum[0]! += d[i]!;
        sum[1]! += d[i + 1]!;
        sum[2]! += d[i + 2]!;
      }
      return [sum[0]! / n, sum[1]! / n, sum[2]! / n] as [number, number, number];
    },
    { t, clearFeedback },
  );
}

/* -------------------------------------------- 分块统计：「画面变了吗」的判据 */

export interface GridStats {
  /** 非零像素数。背景纯黑 + 无抗锯齿 ⇒ **非零即几何**，所以它是精确的。 */
  lit: number;
  total: number;
  /** 整幅均值（0–255）。 */
  mean: number;
  /** `g×g` 分块均值，行优先。 */
  grid: number[];
  /**
   * `g×g` 个**点采样**，每点 **RGB 三个分量**（长度 = `g*g*3`），行优先。
   *
   * ⚠️ **不能把颜色压成一个标量再用它比。** 这是实测踩到的坑：余弦调色板
   * `0.5 + 0.5·cos(ph + (0, 2π/3, 4π/3))` 的三个通道**恒差 2π/3**，于是
   * `(R+G+B)/3` 对**任何** `t` 都恰好是 127.5 —— Lyapunov 换成「AB」序列
   * 明明换了一张图，用亮度比出来的 L1 只有 0.086（= 读回竞态的量级），
   * 整个判据形同虚设。同理 `mean` 对这类调色板也是常量，别拿它判「有没有东西」。
   * 要看「有没有结构」用 `spread`。
   *
   * 点采样而不是分块均值：分块均值对「铺满整幅的彩色渐变」同样不敏感
   * （3D 分形是「黑底 + 一块亮形体」，分块均值在那里才有效）。而竞态只翻转
   * 十来个字节、几乎不可能正好落在你采样的那十几个点上，所以点采样抗噪。
   */
  samples: number[];
  /**
   * 采样点里**单通道的最大跨度**（`max(R)−min(R)` 等三者取最大，0–255）。
   *
   * 「这一帧有没有结构」的判据：整幅纯色（判据退化成恒真、或调色板塌成常量）
   * 时它必然是 0。**不能用 `mean`** —— 见 `samples` 那条。
   */
  spread: number;
}

/**
 * 一帧的分块统计量。**「换了参数画面变了吗」的判据就用它算的分块 L1。**
 *
 * 为什么不是「覆盖像素数之差」，也不是逐像素哈希（`algos3d.spec` 里踩过）：
 *
 * - **覆盖数是个很弱的形状代理。** 幂次 3 与幂次 8 的 Mandelbulb **面积接近
 *   而形态完全不同** —— 拿覆盖数之差当判据，会把一个完全正确的实现判死。
 * - **逐像素哈希会撞上那条已知的 GPU 读回竞态**（同帧两渲恒差一个小数，
 *   见 `algo-sim.spec` 头注）。
 *
 * 分块均值对那点噪声不敏感、对形状变化很敏感：实测**同配置两次独立加载的
 * L1 = 0.000**（噪声底是零），而换幂次是 80.8、换迭代次数是 14.2。
 */
export async function gridStats(
  page: Page,
  t: number,
  g = 4,
  clearFeedback = true,
): Promise<GridStats> {
  return page.evaluate(
    ({ tt, gg, clear }) => {
      const A = (window as never as { __artmatic: StageApi }).__artmatic;
      if (clear) A.renderer.onSeek();
      A.renderFrame(tt);
      const { data, w, h } = A.readPixels();
      let lit = 0;
      let sum = 0;
      const grid = new Array(gg * gg).fill(0) as number[];
      const cell = new Array(gg * gg).fill(0) as number[];
      const samples = new Array(gg * gg * 3).fill(0) as number[];
      for (let y = 0; y < h; y++) {
        const by = Math.min(gg - 1, Math.floor((y / h) * gg));
        for (let x = 0; x < w; x++) {
          const i = (y * w + x) * 4;
          const v = data[i]! + data[i + 1]! + data[i + 2]!;
          sum += v;
          if (v > 0) lit += 1;
          const b = by * gg + Math.min(gg - 1, Math.floor((x / w) * gg));
          grid[b]! += v / 3;
          cell[b]! += 1;
        }
      }
      for (let i = 0; i < grid.length; i++) grid[i] = grid[i]! / (cell[i] || 1);
      // 点采样取每块中心那一个像素，**三个通道都留着** —— 见 GridStats.samples
      const lo = [255, 255, 255];
      const hi = [0, 0, 0];
      for (let by = 0; by < gg; by++) {
        const sy = Math.min(h - 1, Math.floor(((by + 0.5) * h) / gg));
        for (let bx = 0; bx < gg; bx++) {
          const sx = Math.min(w - 1, Math.floor(((bx + 0.5) * w) / gg));
          const i = (sy * w + sx) * 4;
          const b = (by * gg + bx) * 3;
          for (let ch = 0; ch < 3; ch++) {
            const v = data[i + ch]!;
            samples[b + ch] = v;
            if (v < lo[ch]!) lo[ch] = v;
            if (v > hi[ch]!) hi[ch] = v;
          }
        }
      }
      const spread = Math.max(hi[0]! - lo[0]!, hi[1]! - lo[1]!, hi[2]! - lo[2]!);
      return { lit, total: w * h, mean: sum / (data.length / 4) / 3, grid, samples, spread };
    },
    { tt: t, gg: g, clear: clearFeedback },
  );
}

/** 两个分块均值之间的 L1 距离（0 = 逐块相同）。适合「黑底 + 形体」的图。 */
export function gridL1(a: number[], b: number[]): number {
  let d = 0;
  for (let i = 0; i < a.length; i++) d += Math.abs(a[i]! - b[i]!);
  return d;
}

/**
 * 两个点采样之间的 L1 距离（**逐通道**，所以对任何调色板都有效）。
 *
 * 「两张都铺满整幅彩色渐变」的图必须用这个：分块均值在那里分不开，而把它压成
 * 亮度之后连余弦调色板本身都成了常量（见 `GridStats.samples`）。
 */
export function sampleL1(a: GridStats, b: GridStats): number {
  let d = 0;
  for (let i = 0; i < a.samples.length; i++) d += Math.abs(a.samples[i]! - b.samples[i]!);
  return d;
}

/**
 * **重载页面**、搭一条只有这个源的舞台，量 `t` 处的分块统计量。
 *
 * ⚠️ 内部必须先 `goto('/')`：`buildStage` 是「加一条新轨」，而 `addTrack` 是
 * push（新轨 z 更低）—— 连着量两个配置而不重载，第一条轨会一直盖在上面，
 * 于是**每个配置量到的都是第一个源**。量 3D 帧成本时被骗过一次
 * （10 个配置量出来一模一样）。
 */
export async function shootAlgo(
  page: Page,
  gen: string,
  params: Record<string, number | string>,
  t = 4,
): Promise<GridStats> {
  await page.goto('/');
  await page.waitForFunction(() => (window as never as { __artmatic?: unknown }).__artmatic);
  await openDemo(page);
  await buildStage(page, { id: `m-${gen}`, source: { type: 'algo', generator: gen, params }, end: 8 });
  return gridStats(page, t);
}

/* -------------------------------------- 图片素材舞台（抠图 / 四角调整用例） */

/**
 * 抠图（`ClipKey`）与四角调整（`ClipQuad`）用例的共用舞台助手。
 *
 * 这三个字段与 `src/core/schema.ts` 的 `KeySettings` / `QuadCorners` 同形。这里
 * 用**结构化类型**而不是 import：`_stage.ts` 刻意保持「只依赖 Playwright 类型」
 * 的零运行期依赖，而类型在这里只是给 spec 作者看的文档（真正的契约由
 * `tests/unit/schema.test.ts` 与 E2E 的渲染读回守）。
 */
export interface ClipKeySettings {
  color: string;
  tolerance: number;
  softness: number;
  spill: number;
}

export interface ClipQuadCorners {
  tl: [number, number];
  tr: [number, number];
  br: [number, number];
  bl: [number, number];
}

/** 画面裁剪（`SourceClip.crop`）：四条边各被裁掉的源比例。 */
export interface ClipCropSettings {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

/** 页内 canvas 画什么。坐标/朝向都以**画面**为准（图像行序自上而下）。 */
export type TestImagePattern =
  | { kind: 'solid'; color: string }
  /** 横向三段（左 1/3 → 右 1/3）；keying 用例用。 */
  | { kind: 'thirds'; left: string; middle: string; right: string }
  /** 上下两半（上 / 下）；quad 用例用。 */
  | { kind: 'halves'; top: string; bottom: string };

export interface ImageStageSpec {
  pattern: TestImagePattern;
  /** 素材像素尺寸（默认 640×360）。 */
  width?: number;
  height?: number;
  /** 底层背景纯色。给了就多一条全幅 solid 轨（z 在图片**之下**）。 */
  background?: string;
  /** 初始抠图 / 四角 / 裁剪。直接写进片段，不经 UI（UI 接线由各自的用例单独测）。 */
  key?: ClipKeySettings;
  quad?: ClipQuadCorners;
  crop?: ClipCropSettings;
  /** 片段在时间轴上的区间（默认 [0, 8)，与 buildStage 一致）。 */
  start?: number;
  end?: number;
}

export interface ImageStage {
  imageTrack: string;
  backgroundTrack: string | null;
  imageClipId: string;
  assetId: string;
}

interface ImageStageApi {
  store: {
    addTrack: (kind: 'visual', name?: string) => string;
    addClip: (trackId: string, clip: unknown) => void;
    commit: (
      label: string,
      fn: (p: {
        tracks: { id: string; enabled: boolean; clips: { id: string }[] }[];
        assets: Record<string, unknown>;
      }) => void,
    ) => void;
  };
  registerImageAsset: (assetId: string, blob: Blob) => Promise<void>;
}

/** 每次调用加序号：片段 id / 素材 id 在同一个页面里不能撞（见 buildTransitionStage）。 */
let imageStageSeq = 0;

/**
 * 搭一个「图片素材（+ 可选纯色背景）」的干净舞台。
 *
 * 三个必须做对、且错了都不报错的点：
 *
 * 1. **`registerImageAsset` 是异步的，必须 await**。它先 `createImageBitmap`、
 *    再画进 canvas 才登记 —— 不等的话第一帧读回的是「脱机媒体」占位符（暗红），
 *    断言会随负载在不同帧上时对时错（与 sim 烘焙同一种 flake 形态）。
 * 2. **素材台账（`p.assets[assetId]`）要手工记**：`registerImageAsset` 只登记
 *    运行期字节，不写工程台账；而四角手柄是拿 `Asset.size` 算图层矩形尺寸的
 *    —— 漏了这条会变成「画面全对、手柄位置错」，只测像素的用例发现不了。
 * 3. **图片必须在背景之上**：`addTrack` 是 push（新轨 = 数组末尾 = z 最低）。
 *    keying 要「透出下层」看背景，所以图片轨先建、背景轨后建，最后再显式排一次
 *    轨把顺序钉死（与 `buildDepthStage` 同一条纪律）。
 *
 * 图片内容在 **page 内**用 canvas 画再 `toBlob`：不往仓库塞 PNG fixture，而且走的是
 * 真实 PNG 字节 → `registerImageBytes` → SourceManager 上传这条链路。
 */
export async function buildImageStage(page: Page, spec: ImageStageSpec): Promise<ImageStage> {
  imageStageSeq += 1;
  const suffix = `-${imageStageSeq}`;
  return page.evaluate(
    async ({ s, suffix }) => {
      const A = (window as never as { __artmatic: ImageStageApi }).__artmatic;
      const w = s.width ?? 640;
      const h = s.height ?? 360;
      const assetId = `e2e-image${suffix}`;
      const imageClipId = `e2e-image-clip${suffix}`;

      // 1) 页面内画一张真 PNG
      const canvas = document.createElement('canvas');
      canvas.width = w;
      canvas.height = h;
      const ctx = canvas.getContext('2d')!;
      const pat = s.pattern;
      if (pat.kind === 'solid') {
        ctx.fillStyle = pat.color;
        ctx.fillRect(0, 0, w, h);
      } else if (pat.kind === 'thirds') {
        const cuts = [0, Math.round(w / 3), Math.round((2 * w) / 3), w];
        for (const [i, color] of [pat.left, pat.middle, pat.right].entries()) {
          ctx.fillStyle = color;
          ctx.fillRect(cuts[i]!, 0, cuts[i + 1]! - cuts[i]!, h);
        }
      } else {
        ctx.fillStyle = pat.top;
        ctx.fillRect(0, 0, w, Math.round(h / 2));
        ctx.fillStyle = pat.bottom;
        ctx.fillRect(0, Math.round(h / 2), w, h - Math.round(h / 2));
      }
      const blob = await new Promise<Blob>((resolve, reject) =>
        canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('canvas.toBlob 返回 null'))), 'image/png'),
      );
      // 2) 登记运行期字节（**必须 await**，见函数头）
      await A.registerImageAsset(assetId, blob);

      // 3) 关掉 demo 全部轨道，只启用自己这两条
      A.store.commit('e2e: 清空舞台', (p) => {
        for (const t of p.tracks) t.enabled = false;
      });

      const base = {
        fadeSec: 0,
        curves: {},
        transform: { x: 0.5, y: 0.5, sx: 1, sy: 1, rot: 0 },
        fit: 'stretch' as const,
      };
      const imageTrack = A.store.addTrack('visual', `IMG${suffix}`);
      const backgroundTrack = s.background ? A.store.addTrack('visual', `BG${suffix}`) : null;

      // 4) 台账（UI 手柄靠 Asset.size；见函数头第 2 点）
      A.store.commit('e2e: 记素材', (p) => {
        p.assets[assetId] = { id: assetId, kind: 'image', name: `e2e-image${suffix}.png`, size: { w, h } };
      });

      // 5) 片段。key / quad 直接写进数据（A/B 的渲染判据不依赖 UI）
      A.store.addClip(imageTrack, {
        ...base,
        kind: 'source',
        id: imageClipId,
        start: s.start ?? 0,
        end: s.end ?? 8,
        label: `image${suffix}`,
        source: { type: 'image', assetId },
        blend: 'normal',
        opacity: 1,
        ...(s.key ? { key: s.key } : {}),
        ...(s.quad ? { quad: s.quad } : {}),
        ...(s.crop ? { crop: s.crop } : {}),
      });
      if (backgroundTrack && s.background) {
        A.store.addClip(backgroundTrack, {
          ...base,
          kind: 'source',
          id: `e2e-bg-clip${suffix}`,
          start: s.start ?? 0,
          end: s.end ?? 8,
          label: `bg${suffix}`,
          source: { type: 'solid', color: s.background },
          blend: 'normal',
          opacity: 1,
        });
      }

      // 6) 显式排轨（图片 → 背景 → 其余被禁用的 demo 轨）并只启用自己这两条
      A.store.commit('e2e: 排轨', (p) => {
        const pick = (id: string) => p.tracks.find((t) => t.id === id)!;
        const mine = backgroundTrack ? [imageTrack, backgroundTrack] : [imageTrack];
        const rest = p.tracks.filter((t) => !mine.includes(t.id));
        p.tracks = [...mine.map(pick), ...rest];
      });
      A.store.commit('e2e: 启用舞台', (p) => {
        for (const t of p.tracks) {
          t.enabled = t.id === imageTrack || t.id === backgroundTrack;
        }
      });

      return { imageTrack, backgroundTrack, imageClipId, assetId };
    },
    { s: spec, suffix },
  );
}

/** 读一个图片片段上的 `key` / `quad` 原值（缺省一律是 null，方便断言「已删除」）。 */
export async function readClipImageState(
  page: Page,
  clipId: string,
): Promise<{ key: ClipKeySettings | null; quad: ClipQuadCorners | null; crop: ClipCropSettings | null }> {
  return page.evaluate((id) => {
    const A = (window as never as {
      __artmatic: {
        store: {
          project: {
            tracks: {
              clips: {
                id: string;
                key?: ClipKeySettings;
                quad?: ClipQuadCorners;
                crop?: ClipCropSettings;
              }[];
            }[];
          };
        };
      };
    }).__artmatic;
    const clip = A.store.project.tracks.flatMap((t) => t.clips).find((c) => c.id === id);
    return { key: clip?.key ?? null, quad: clip?.quad ?? null, crop: clip?.crop ?? null };
  }, clipId);
}

/** 直接改片段的 `key`（null = 删除）。走 commit = 一笔撤销，和检查器的写入等价。 */
export async function setClipKey(
  page: Page,
  clipId: string,
  key: ClipKeySettings | null,
): Promise<void> {
  await page.evaluate(
    ({ id, next }) => {
      const A = (window as never as {
        __artmatic: {
          store: {
            commit: (
              label: string,
              fn: (p: {
                tracks: { clips: { id: string; kind?: string; key?: unknown }[] }[];
              }) => void,
            ) => void;
          };
        };
      }).__artmatic;
      A.store.commit(next ? 'e2e: 设抠图' : 'e2e: 删抠图', (p) => {
        for (const t of p.tracks) {
          for (const c of t.clips) {
            if (c.id !== id) continue;
            if (next) c.key = next;
            else delete c.key;
          }
        }
      });
    },
    { id: clipId, next: key },
  );
}

/** 直接改片段的 `quad`（null = 删除）。 */
export async function setClipQuad(
  page: Page,
  clipId: string,
  quad: ClipQuadCorners | null,
): Promise<void> {
  await page.evaluate(
    ({ id, next }) => {
      const A = (window as never as {
        __artmatic: {
          store: {
            commit: (
              label: string,
              fn: (p: {
                tracks: { clips: { id: string; kind?: string; quad?: unknown }[] }[];
              }) => void,
            ) => void;
          };
        };
      }).__artmatic;
      A.store.commit(next ? 'e2e: 设四角' : 'e2e: 删四角', (p) => {
        for (const t of p.tracks) {
          for (const c of t.clips) {
            if (c.id !== id) continue;
            if (next) c.quad = next;
            else delete c.quad;
          }
        }
      });
    },
    { id: clipId, next: quad },
  );
}

/** 直接改片段的 `crop`（null = 删除）。走 commit = 一笔撤销，和检查器的写入等价。 */
export async function setClipCrop(
  page: Page,
  clipId: string,
  crop: ClipCropSettings | null,
): Promise<void> {
  await page.evaluate(
    ({ id, next }) => {
      const A = (window as never as {
        __artmatic: {
          store: {
            commit: (
              label: string,
              fn: (p: {
                tracks: { clips: { id: string; kind?: string; crop?: unknown }[] }[];
              }) => void,
            ) => void;
          };
        };
      }).__artmatic;
      A.store.commit(next ? 'e2e: 设裁剪' : 'e2e: 删裁剪', (p) => {
        for (const t of p.tracks) {
          for (const c of t.clips) {
            if (c.id !== id) continue;
            if (next) c.crop = next;
            else delete c.crop;
          }
        }
      });
    },
    { id: clipId, next: crop },
  );
}

/**
 * 取一个像素，坐标用**画面坐标**（左上角为原点，归一化 0..1）。
 *
 * ⚠️ 与 `rgbaAt` 的区别：`readPixels` 是 GL 行序（原点在**左下**），`rgbaAt` 的
 * 文档写着「左上」但实现是直接按行取 —— 对「上下两半不同色」这类判据会读反。
 * 这里替调用方翻行，让 keying / quad 用例的 **(0.5, 0.1) = 画面靠上** 这类坐标
 * 与人的直觉一致。
 *
 * 返回 `[r, g, b, a]`（0–255）。
 */
export async function rgbaAtTopLeft(
  page: Page,
  t: number,
  fx: number,
  fy: number,
  clearFeedback = true,
): Promise<[number, number, number, number]> {
  return page.evaluate(
    ({ t, fx, fy, clear }) => {
      const A = (window as never as { __artmatic: StageApi }).__artmatic;
      if (clear) A.renderer.onSeek();
      A.renderFrame(t);
      const { data, w, h } = A.readPixels();
      const x = Math.min(w - 1, Math.max(0, Math.floor(fx * w)));
      const y = Math.min(h - 1, Math.max(0, Math.floor((1 - fy) * h)));
      const i = (y * w + x) * 4;
      return [data[i]!, data[i + 1]!, data[i + 2]!, data[i + 3]!] as [number, number, number, number];
    },
    { t, fx, fy, clear: clearFeedback },
  );
}
