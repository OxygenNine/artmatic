/**
 * export-frame.ts — **钉尺寸取材的唯一序列**（预览帧截图 / 体积采样共用）。
 *
 * ## 为什么要有这个文件
 *
 * 「把某一帧渲到工程分辨率再拿走」这件事有三处调用点（截图、PNG 体积采样、
 * 以及导出循环自己的第一帧），它们的纪律完全一样，而抄三份的下场已经出现过：
 * 截图那条漏了 `enterExportMode()` 与 `prewarmFonts()`，于是**排版在导出模式下的
 * 文字表现与预览不同**、首帧用回落字体量度 —— 画面确实不一样，但没有任何报错。
 *
 * 序列固定为（与 `exporters/export-runner.ts` 逐条对齐）：
 *
 *   setExportSize → onSeek → enterExportMode → prewarmFonts
 *     →（可选）按帧顺序重放 / 单帧取材
 *     → fn(canvas)
 *   finally: clearExportSize → onSeek → exitExportMode
 *
 * 三件不能省的事（AGENTS §5.9）：
 *  - **钉尺寸必须还原**：`setExportSize` 之后 `syncSize` 会直接 return，
 *    不还原预览会**停在工程分辨率**上且不报错。调用方在 `finally` 里
 *    还要 `refreshPreview()`（那属于 UI 层的活，这里不 import appState）。
 *  - **必须在钉尺寸的内层取材**：`refreshPreview` 的 `syncSize` 会改画布尺寸，
 *    而改尺寸会清空帧缓冲 —— 先还原再截只会拿到黑图。
 *  - **`onSeek()` 之后必须成对还原**：清反馈 + `alignSims` 是 seek 的语义，
 *    拆开一半就会出现「同一 t 两渲画面不同」。
 *
 * ## 反馈类特效：为什么有时必须重放
 *
 * 反馈历史存在 `Compositor` 的池子里，**按尺寸键控**（改尺寸即失效），
 * 而且被 `onSeek()` 清空。所以「钉尺寸 + seek + 渲一帧」在数学上不可能复现
 * 「顺序播放到该帧」的结果 —— 正是用户报的「截图和预览帧不完全一致」。
 *
 * 判据是 `stackNeedsReplay`（只读注册表里的声明，不猜特效名字）。需要重放时，
 * 在同一个钉尺寸窗口内从第 0 帧顺序走到目标帧：与导出循环的帧序列**逐帧等价**。
 * 重放受 `capacity.snapshotReplayMaxFrames` 约束 —— 超了就退回单帧并把
 * `truncated` 交给调用方去提示，绝不允许一次点击卡上一分钟。
 */

import { getLimits } from '../core/capacity';
import type { Project } from '../core/schema';
import { frameAtTime } from '../core/time';
import { timeOf } from '../engine/clock';
import type { Renderer } from '../engine/renderer';
import { stackNeedsReplay } from '../effects/feedback-detect';

/** 这次取材实际是怎么得到的。调用方用它决定提示语。 */
export interface ExportFrameInfo {
  /** 按帧顺序重放的帧数（0 = 单帧取材）。 */
  replayed: number;
  /** 需要重放但超过上限，已退回单帧 —— 跨帧历史没有还原。 */
  truncated: boolean;
}

export interface ExportFrameOptions {
  /** 只渲这条视觉轨（与导出同参数）；省略 = 全部视觉轨。 */
  onlyTrackId?: string;
  /**
   * 反馈类特效是否走顺序重放（默认 true）。
   *
   * 体积采样传 false：为一次「大约多少 MB」的估算重放上千帧不值，而单帧字节数
   * 与重放后的字节数只差一点内容，估算精度足够。
   */
  replay?: boolean;
}

/** 重放时每多少帧让渡一次给 UI（进度条的取消按钮要能点）。 */
const REPLAY_YIELD = 8;

/** 截图与 PNG 体积采样都会钉尺寸；同一时刻只允许一条在跑。 */
let pinnedTail: Promise<void> = Promise.resolve();

/**
 * 在「钉死工程分辨率 + 导出模式」的窗口里取材，返回 `fn` 的结果。
 *
 * @param t 取材时刻。内部会吸附到帧栅格（`frameAtTime`）—— 文件名里的帧号与
 *          画面严格对应，重放的步长也才有唯一定义。
 */
export function withExportFrame<T>(
  renderer: Renderer,
  project: Project,
  t: number,
  fn: (canvas: HTMLCanvasElement, info: ExportFrameInfo) => T | Promise<T>,
  opts: ExportFrameOptions = {},
): Promise<T> {
  const prev = pinnedTail;
  let release!: () => void;
  pinnedTail = new Promise<void>((resolve) => {
    release = resolve;
  });
  return prev
    .then(() => withExportFrameNow(renderer, project, t, fn, opts))
    .finally(release);
}

async function withExportFrameNow<T>(
  renderer: Renderer,
  project: Project,
  t: number,
  fn: (canvas: HTMLCanvasElement, info: ExportFrameInfo) => T | Promise<T>,
  opts: ExportFrameOptions,
): Promise<T> {
  const { w, h } = project.resolution;
  const fps = project.fps;
  const target = frameAtTime(t, fps);
  const renderOpts = opts.onlyTrackId !== undefined ? { onlyTrackId: opts.onlyTrackId } : undefined;
  const info: ExportFrameInfo = { replayed: 0, truncated: false };

  renderer.setExportSize(w, h);
  renderer.onSeek();
  renderer.enterExportMode();
  try {
    // ADR-003 规则 ③：字体没就绪就开渲，首帧会用回落字体量度 ——
    // 那一帧看起来「也正常」，但和预览不是同一张图。
    await renderer.prewarmFonts(project);

    const replay = opts.replay !== false && stackNeedsReplay(project, t, opts.onlyTrackId);
    if (replay && target + 1 <= getLimits().snapshotReplayMaxFrames) {
      for (let i = 0; i <= target; i++) {
        const ti = timeOf(i, fps);
        // 逐帧 prepareFrame 与导出循环一致：文字位图是异步光栅化的，
        // 而重放的意义就在于「每一帧都与导出时那一帧走同一条路」。
        await renderer.prepareFrame(project, ti);
        renderer.renderFrame(project, ti, renderOpts);
        if (i % REPLAY_YIELD === REPLAY_YIELD - 1) await new Promise((r) => setTimeout(r, 0));
      }
      info.replayed = target + 1;
    } else {
      info.truncated = replay;
      /*
       * 单帧取材：**渲两帧、取第二帧**。
       *
       * 第一次求值落在「启动窗口」里（AGENTS §1.3：非整数倍缩放采样时同一帧会出现
       * 两个稳定态，预热几十帧后消失），多渲一帧就能跨过它。代价是一帧 ——
       * 与「截图偶尔和预览差一点点」相比完全划得来。
       * 无跨帧历史时两次渲染在数学上等价，所以这一步是纯收益。
       */
      await renderer.prepareFrame(project, t);
      renderer.renderFrame(project, t, renderOpts);
      await renderer.prepareFrame(project, t);
      renderer.renderFrame(project, t, renderOpts);
    }

    return await fn(renderer.kit.canvas, info);
  } finally {
    renderer.clearExportSize();
    renderer.onSeek();
    renderer.exitExportMode();
  }
}
