/**
 * build-project.ts — 把"试炼场的当前选择"合成为一棵可渲染的 `Project`。
 *
 * 试炼场不复用时间轴上的任何工程：它每帧现造一棵最小工程喂给
 * `Renderer.renderFrame`，于是**整条合成管线（placement / blend / ping-pong
 * 反馈池 / 源解析）原样复现**——试炼场里看到的就是时间轴上会得到的，
 * 差别只在没有时间轴 UI。
 *
 * ⚠️ 轨道顺序（最容易写错的一处）：
 * `buildStack` 把 `tracks[0]` 映射成**最大 z**，即列表顶部 = 最前景
 * （stack.ts 里有这段注释与它的历史教训）。特效片段是 adjustment layer，
 * 必须**盖在源之上**，所以数组顺序是 `[特效轨, 源轨]`。
 * 写反了的表现是「特效完全无效、画面毫无变化」——不报错、不警告。
 */

import {
  SCHEMA_VERSION,
  type EffectClip,
  type Project,
  type SourceClip,
  type Track,
  type VisualTrack,
} from '../src/core/schema';
import { getGenerator } from '../src/algos/registry';

/** 试炼场不参与导出，fps 只用来把 scrubber 的秒数换成帧号（u_seed 派生用）。 */
export const LAB_FPS = 30;
/**
 * 时间轴长度（秒）。取 30 而不是很大：slider 的行程是像素级的，
 * 时间轴越长每像素跨的秒数越多，拖动就越难停在想看的那个瞬间。
 * 30 秒足够看清 Rule 110 的生长前沿、echo 的拖尾收敛与 Mandelbrot 的推拉。
 */
export const LAB_DURATION = 30;
/**
 * 固定种子。硬约束 1.2：任何随机都要可复现。
 * 「随机参数」按钮只改参数值、不改种子，所以同一次随机出来的结果永远相同。
 */
export const LAB_SEED = 0xa27a11c;
/**
 * 固定的 instanceId。`Compositor.feedbackFor` 按 instanceId 池化反馈目标
 * （compositor.ts），id 一变历史就断——echo 这类反馈特效会看不到拖尾。
 */
export const LAB_INSTANCE_ID = 'lab-fx';

/** 试炼场基准分辨率（100% 档）。0.5 / 0.25 档按它等比缩。 */
export const LAB_BASE_W = 1280;
export const LAB_BASE_H = 720;

/**
 * 试炼场不做按拍吸附，但曲线求值需要一个合法网格来算拍长。
 * 导出给 `createRenderCore` 的 `getProject` 用——两处必须一致，
 * 否则「曲线上下文的拍长」会跟工程里的对不上。
 */
export const LAB_BEAT_GRID = { bpm: 120, offset: 0, beatsPerBar: 4 };

export interface LabSelection {
  /** 生成器 id，或 `lab:` 前缀的测试图 id。 */
  sourceId: string;
  sourceParams: Record<string, number | string>;
  /** null = 只看源。 */
  effect: { id: string; params: Record<string, number | string> } | null;
}

export interface BuildLabOpts {
  /** 按住 B 时旁路：只留源轨。 */
  bypass?: boolean;
}

/**
 * 回放型生成器（闪回）在试炼场里的片段头。
 *
 * 它放的是「片段**之前**的画面」，所以在 0 处开场等于没有内容可放。给它一个
 * 靠后的片段头，再在下面垫一条彩条轨当「之前的素材」，才看得见它在做什么。
 * `lab-state.selectSource` 选中它时会把播放头推到这之后（同一个常量）。
 */
export const LAB_RECALL_START = 6;

function baseClip(id: string, label: string) {
  return {
    id,
    start: 0,
    end: LAB_DURATION,
    label,
    fadeSec: 0,
    // 曲线全空 → 参数完全由 values 驱动（stack.ts 的 paramWithCurve 走基值分支）。
    curves: {},
  };
}

export function buildLabProject(
  sel: LabSelection,
  resolution: { w: number; h: number },
  opts: BuildLabOpts = {},
): Project {
  /*
   * 回放型（闪回）：内容来自「片段之前」，所以片段头靠后、下面再垫一条彩条轨。
   * 彩条必须用**已注册的**生成器而不是 `lab:` 测试图 —— 回放帧由
   * `render/recall.ts` 自己那台合成器重渲，它不认识 lab 的伪 id。
   */
  const isRecall = getGenerator(sel.sourceId)?.kind === 'recall';
  const start = isRecall ? LAB_RECALL_START : 0;

  const src: SourceClip = {
    ...baseClip('lab-src', 'src'),
    start,
    kind: 'source',
    source: { type: 'algo', generator: sel.sourceId, params: sel.sourceParams },
    blend: 'normal',
    opacity: 1,
    transform: { x: 0.5, y: 0.5, sx: 1, sy: 1, rot: 0 },
    // stretch：测试图与生成器都按整帧出图，contain 会留黑边干扰对像素的判断。
    fit: 'stretch',
  };
  const srcTrack: VisualTrack = {
    kind: 'visual',
    id: 'lab-track-src',
    name: 'SRC',
    enabled: true,
    clips: [src],
  };

  const tracks: Track[] = [];

  // —— 特效轨排在源轨**之前**（= z 更大 = 盖在上面）。见文件头注释。
  if (sel.effect && !opts.bypass) {
    const fx: EffectClip = {
      ...baseClip('lab-fxclip', 'fx'),
      kind: 'effect',
      chain: [
        {
          instanceId: LAB_INSTANCE_ID,
          defId: sel.effect.id,
          enabled: true,
          values: sel.effect.params,
        },
      ],
    };
    tracks.push({
      kind: 'visual',
      id: 'lab-track-fx',
      name: 'FX',
      enabled: true,
      clips: [fx],
    });
  }

  tracks.push(srcTrack);

  // 垫在源轨**下面**（列表越靠后 z 越小）：闪回盖在它上面，回放的正是它。
  if (isRecall) {
    const feed: SourceClip = {
      ...baseClip('lab-feed', 'feed'),
      kind: 'source',
      source: { type: 'algo', generator: 'bars', params: { scroll: 1 } },
      blend: 'normal',
      opacity: 1,
      transform: { x: 0.5, y: 0.5, sx: 1, sy: 1, rot: 0 },
      fit: 'stretch',
    };
    tracks.push({ kind: 'visual', id: 'lab-track-feed', name: 'FEED', enabled: true, clips: [feed] });
  }

  return {
    schemaVersion: SCHEMA_VERSION,
    name: 'lab',
    seed: LAB_SEED,
    fps: LAB_FPS,
    resolution,
    duration: LAB_DURATION,
    beatGrid: LAB_BEAT_GRID,
    overlapBehavior: 'reject',
    assets: {},
    tracks,
    // 试炼场不出段落带（`Project.sections` / `beatMarks` 是必填字段，空数组即可）。
    sections: [],
    beatMarks: [],
  };
}
