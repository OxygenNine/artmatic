/**
 * export.ts — 导出动作。从 Transport 抽出来，因为触发入口搬进了窄侧栏。
 *
 * 保留原有的全部语义：导出期间禁二次触发、进度写 appState（底栏与侧栏面板
 * 都读它）、可取消。导出本身走 exporters/ 的紧循环，这里只管编排与下载。
 *
 * 三种格式（ADR-001）：
 *   mp4   WebCodecs 编码 + mediabunny 封装，含音轨。**主路径**。
 *   png   PNG 序列 zip。永远可用的逃生舱 —— 浏览器不支持 H.264 时它仍在，
 *         而且「帧要一张张交给达芬奇 / Cavalry」本身就是正当用途。
 *   gif   GIF89a，纯 CPU 软编（gifenc）。**分享格式**：256 色、无音轨，
 *         但哪里都能直接播。它也是唯一会**主动降分辨率与降帧率**的格式。 
 *
 * ## 关于磁盘占用（重要）
 *
 * MP4 是有损压缩，体积比 PNG 序列小一到两个数量级，但**仍然是几十 MB 级**：
 * 一段 16s / 1080p / 16 Mbps 的导出约 32 MB。反复导出不做清理，
 * 一下午就能在下载目录堆掉几个 GB。
 *
 * 三条防线：
 * 1. **导出前估算体积并显示**，让用户在点之前就知道要花多少磁盘（见 estimateMp4Bytes）。
 * 2. **下载用完立刻 revoke**，不留 objectURL（`platform.download` 已有 10s 延迟，
 *    这里不重复造）。
 * 3. **E2E 一律短时长 + 小分辨率，且产物落临时目录、断言后立刻删**。
 *    测试绝不能靠「导一次看看」—— 一次全量 E2E 有 13 个 spec。
 */

import { appState } from './app-state.svelte';
import { ExportCancelled, runExport } from '../exporters/export-runner';
import { tryAcquireExport } from '../exporters/export-gate';
import { Mp4Sink, probeMp4Codec } from '../exporters/mp4-sink';
import { PngSequenceSink } from '../exporters/png-sequence';
import { GifSink, GIF_SINK_CODEC } from '../exporters/gif-sink';
import { planGif, type GifPlan } from '../exporters/gif-plan';
import { mixdown } from '../exporters/mixdown';
import { prepareProjectVideoAudio } from '../engine/video-audio';
import { platform } from '../platform/index';
import { withExportFrame } from '../render/export-frame';
import { saveProjectNow } from './project-actions';
import { getLimits, mbToBytes } from '../core/capacity';
import { formatBytes } from '../core/format';
import type { SaveStream } from '../platform/types';
import { tr } from '../i18n/index.svelte';

export type ExportFormat = 'mp4' | 'png' | 'gif';

/** 本次导出会产出多少帧。帧率来自工程（renderer 与导出共用同一个值）。 */
export function totalFrames(): number {
  const p = appState.store.project;
  return Math.max(1, Math.ceil(p.duration * p.fps));
}

/**
 * 工程里有没有**会跑**的排版脚本（单条启用 + 有代码）。
 *
 * 导出前拿它和总开关比一次：开关关着时导出的是「没有脚本的静态版」，
 * 而用户点的是「导出这段片子」—— 那是**静默改变产物**，必须挡下来并说明。
 */
export function hasRunnableTypoScripts(): boolean {
  const p = appState.store.project;
  for (const track of p.tracks) {
    if (track.kind !== 'visual') continue;
    for (const clip of track.clips) {
      if (clip.kind !== 'source' || clip.source.type !== 'text') continue;
      if ((clip.source.doc.scripts ?? []).some((s) => s.enabled && s.code.trim())) return true;
    }
  }
  return false;
}

/**
 * 脚本开关的导出闸门。返回 true = 挡下了这一单。
 *
 * 不在这里「自动帮用户打开」：跑别人的代码必须是一次显式选择
 * （面板上有「开启并继续」按钮，见 `ExportModal`）。
 */
function blockedByTypoScripts(): boolean {
  if (!hasRunnableTypoScripts() || appState.runTypoScripts) return false;
  appState.flash(tr('typo.scriptExportWarn'), 'error');
  return true;
}

/**
 * 本机是否**存在** WebCodecs。
 *
 * 这只是第一层：真正能不能编 H.264 还要看 profile / level（无硬编的机器只有
 * Constrained Baseline）。第二层是 `probeMp4Availability()`。
 */
export function mp4Supported(): boolean {
  return typeof VideoEncoder !== 'undefined' && typeof VideoFrame !== 'undefined';
}

/** MP4 三态：可用（硬件 / 软件路径）/ 没有 WebCodecs / 没有可用 H.264 profile。 */
export type Mp4Availability =
  | { kind: 'ok'; codec: string; software: boolean }
  | { kind: 'no-webcodecs' }
  | { kind: 'no-h264' };

/**
 * 按当前工程尺寸探测 MP4 能力。
 *
 * 为什么必须按尺寸探测：H.264 的 level 限制的是 **coded area**，
 * baseline 3.1（`avc1.42001e`）在 1080p 下会被直接拒绝。所以「MP4 可不可用」
 * 不是一个与工程无关的常量。
 *
 * 面板与导出入口共用这一条 —— 两处各探一次会出现「面板说能导，点了报不支持」。
 */
export async function probeMp4Availability(): Promise<Mp4Availability> {
  if (!mp4Supported()) return { kind: 'no-webcodecs' };
  const p = appState.store.project;
  const choice = await probeMp4Codec({ w: p.resolution.w, h: p.resolution.h, fps: p.fps });
  if (!choice) return { kind: 'no-h264' };
  return { kind: 'ok', codec: choice.codec, software: choice.software };
}

/**
 * 导出前的强制保存。
 *
 * 目的只有一个：**别让「导出 OOM 崩标签页」顺手带走未保存的编辑**。
 * 所以它的语义是「尽力保存」，不是闸门 —— 保存失败、用户取消、工程还没有
 * 目录，导出都继续。
 *
 * 三条纪律：
 *  1. **不主动弹目录选择器。** 没有目录时只提示一句；真去弹的话，
 *     导出面板后面紧跟着的「选保存位置」（流式路）会变成第二个对话框，
 *     而且 `showDirectoryPicker` 在几次 await 之后可能已经失去用户手势。
 *  2. **先保存再置 `exportProgress`。** 两把锁互不相干：`projectBusy` 是保存的，
 *     `exportProgress` 是导出的。反过来会让 `saveProjectNow()` 里的
 *     `if (appState.projectBusy) return false` 直接短路。
 *  3. **await 之后调用方要复查 `exportProgress`**：两次快速点击会都穿过
 *     函数开头的互斥判断，而保存是异步的。
 */
async function saveBeforeExport(): Promise<void> {
  if (appState.projectBusy) return;
  if (!appState.projectDir || !appState.projectKey) {
    appState.flash(tr('err.export.saveFirstHint'), 'info');
    return;
  }
  // 失败也不拦：保存是保护，不是前置条件。
  await saveProjectNow();
}

/**
 * 估算 MP4 产物体积（字节）。
 *
 * **只是估算**，UI 用来在点之前给个心理预期，不做额度管控。
 * 算法：视频码率（与 `Mp4Sink` 的分档一致）× 时长 + 音频码率 × 时长 + 1 MB 容器余量。
 * 真实体积受内容复杂度影响很大 —— 全屏噪声比静态平色高得多。
 */
export function estimateMp4Bytes(): number {
  const p = appState.store.project;
  const px = p.resolution.w * p.resolution.h;
  const videoBitrate = px <= 1280 * 720 ? 8_000_000 : px <= 1920 * 1080 ? 16_000_000 : 32_000_000;
  const audioBitrate = hasAudioClips() ? 192_000 : 0;
  const seconds = Math.max(1 / p.fps, p.duration);
  return Math.round(((videoBitrate + audioBitrate) * seconds) / 8) + 1_000_000;
}

function hasAudioClips(): boolean {
  return appState.store.project.tracks.some((t) => t.enabled && t.kind === 'audio' && t.clips.length > 0);
}

/**
 * 体积的可读文本。UI 与提示共用，避免两处格式不一致。
 *
 * 实现在 `core/format.ts`：`project/io.ts` 也要报孤儿素材的占用，
 * 而 `project/` 不能 import `ui/`。这里保留原名导出，调用点不动。
 */
export const fmtSize = formatBytes;

function baseName(): string {
  return appState.store.project.name || 'artmatic';
}

/* --------------------------------------------------------- 落盘方式的选择 */

/**
 * 这次导出该走「内存里产完再下载」还是「边编边写盘」。
 *
 * ## 判据只有一条：预估体积 vs `limits.exportMemoryMB`
 *
 * 内存那条路的收场是**崩**（标签页 OOM，没保存的编辑一起没），所以它是唯一
 * 必须按容量裁的导出路径。判据用**预估**而不是实际：等发现超了，字节已经在内存里了。
 * 预估取保守值（宁可多算），最坏后果只是多弹一次保存对话框。
 *
 * ## 为什么先弹保存对话框
 *
 * `showSaveFilePicker` 要求**瞬时激活**（用户手势），而导出循环一跑就是几十秒 ——
 * 只能在开始之前要。所以顺序是「点导出 → 保存位置 → 逐帧渲染」，
 * 而不是「渲染完 → 再问存哪」。缺点是流式路必须由用户选位置；
 * 好处是**中途取消时目标文件保持原样**（FSA 的 siloed 写入只在 close 时落盘）。
 *
 * 拿不到流式出口（Firefox/Safari）时**明确告诉用户风险并继续**，而不是拒绝导出：
 * 短片段在那些浏览器上一直是好的，一刀切禁用反而更糟。
 */
async function pickOutput(
  format: 'mp4' | 'png',
  name: string,
  estimateBytes: number,
): Promise<SaveStream | null> {
  const budgetBytes = mbToBytes(getLimits().exportMemoryMB);
  if (estimateBytes <= budgetBytes) return null;

  const stream = await platform.saveStream({
    suggestedName: format === 'mp4' ? `${name}.mp4` : `${name}-png.zip`,
    description: format === 'mp4' ? tr('err.export.fileTypeMp4') : tr('err.export.fileTypeZip'),
    mime: format === 'mp4' ? 'video/mp4' : 'application/zip',
    ext: format === 'mp4' ? '.mp4' : '.zip',
  });
  if (stream) {
    appState.flash(
      tr('err.export.streamingSave', {
        size: fmtSize(estimateBytes),
        budget: fmtSize(budgetBytes),
      }),
      'info',
    );
    return stream;
  }
  appState.flash(
    tr('err.export.overBudget', {
      size: fmtSize(estimateBytes),
      budget: fmtSize(budgetBytes),
    }),
    'info',
  );
  return null;
}

/** PNG 序列的峰值倍数：帧 + zip + Blob 拷贝（见 `estimatePngBytes`）。 */
const PNG_PEAK_FACTOR = 3;

/**
 * PNG 序列的**峰值内存**预估（字节）—— 注意不是成品体积。
 *
 * 判「会不会 OOM」要看峰值，而内存那条路的峰值是成品的好几倍：
 * `this.files` 里全部帧（1×）+ `zipSync` 产出的整包（1×）+ 为 `Blob` 复制的那一份（1×）。
 * 按成品算会**放过本该走流式的导出**：400 MB 的包在 833 MB 预算内放行，实际峰值 1.2 GB。
 * 所以这里乘 3（`PNG_PEAK_FACTOR`），这是本文件唯一一处「故意悲观」的系数。
 *
 * 优先**实测一帧**（`samplePngFrameBytes`，与面板上的磁盘提示同源）；量不到就退回
 * 「每帧 0.5 字节/像素」—— PNG 对平坦画面能压到百分之几，对噪声则可能到 3 B/px，
 * 0.5 是按「偏小」取的保守值（宁多弹一次保存对话框，也不要撞 OOM）。
 */
async function estimatePngBytes(totalFrames_: number, onlyTrackId?: string): Promise<number> {
  const p = appState.store.project;
  const sampled = await samplePngFrameBytes(appState.playT, onlyTrackId);
  const perFrame = sampled ?? Math.round(p.resolution.w * p.resolution.h * 0.5);
  return perFrame * totalFrames_ * PNG_PEAK_FACTOR;
}

/**
 * MP4 的峰值内存预估（字节）。
 *
 * 比 PNG 那条简单：`BufferTarget` 里就是整份文件，多出来的只是编码器的在位缓冲，
 * 取 1.2 倍。不乘更多是因为 MP4 是压缩流式写入的，没有「再复制一份」那一步。
 */
function estimateMp4PeakBytes(): number {
  return Math.round(estimateMp4Bytes() * 1.2);
}

/**
 * 本次导出的文件名（不含扩展名）。
 *
 * 由导出面板传入：面板里有一个可编辑的「文件名」输入框，默认取工程名。
 * 传空串/全是空白时回落到工程名 —— 一个只剩扩展名的下载文件（`.mp4`）
 * 是纯粹的困惑来源。
 */
function safeBase(name?: string): string {
  const n = (name ?? '').trim();
  return n || baseName();
}

/* ----------------------------------------------------------- PNG 体积采样 */

/**
 * 采样一帧的**真实 PNG 字节数**，供 PNG 序列的体积估算用。
 *
 * 旧口径（每帧 RGBA 原始大小 × 帧数）是**未压缩上界**，常比真实产物大 1~2 个
 * 数量级（PNG 对纯色 / 平坦画面能压到百分之几）。这里把当前帧渲到工程分辨率、
 * 用 `canvas.toBlob('image/png')` 量出真实字节，调用方再乘帧数 —— 是**按当前帧
 * 采样**的估计值，会随画面内容波动，不是承诺。
 *
 * 取材序列整个交给 `render/export-frame.ts::withExportFrame`（钉尺寸 → 导出模式 →
 * 字体预热 → 取材 → 对称还原），与截图、导出循环共用一份纪律。
 * **这里显式关掉重放**（`replay: false`）：一次「大约多少 MB」的估算不值得为
 * 反馈类特效从上一次 seek 起重放上千帧，而重放与否对字节数的差异远小于估算误差。
 *
 * @param t 采样时刻（通常传当前播放头 `appState.playT`）。
 * @param onlyTrackId 只采样该视觉轨（与导出同参数）；省略 = 全部视觉轨。
 * @returns 单帧 PNG 字节数；无 renderer 或 `toBlob` 失败时返回 `null`（调用方
 *          回退到未压缩上界）。
 */
export async function samplePngFrameBytes(t: number, onlyTrackId?: string): Promise<number | null> {
  // 导出进行中绝不能动 renderer：导出循环正用它渲权威帧，采样插进去会
  // 在某一帧的 submit 之前多渲一帧、污染产物。面板此时本来就隐藏了提示。
  if (appState.exportProgress !== null) return null;
  const renderer = appState.renderer;
  if (!renderer) return null;
  const project = appState.store.project;
  try {
    return await withExportFrame(
      renderer,
      project,
      t,
      async (canvas) => {
        const blob = await new Promise<Blob | null>((resolve) =>
          canvas.toBlob(resolve, 'image/png'),
        );
        return blob ? blob.size : null;
      },
      { onlyTrackId, replay: false },
    );
  } catch {
    return null;
  } finally {
    // 尺寸还原与画面重画在 `refreshPreview` 里（它会 `onSeek` + `syncSize` +
    // 重画一帧）。**必须在 withExportFrame 之外**：它内部的 syncSize 会改画布
    // 尺寸并清空帧缓冲，先还原再截只会拿到黑图。
    appState.refreshPreview();
  }
}

/**
 * 导出 MP4（含音轨）。
 *
 * 混流在开跑之前做完，这样渲染循环里一次 `await` 都不用为音频分心，
 * 而且混流出的 PCM 长度与工程时长对齐，音视频时间戳共用一个 fps。
 */
export async function exportMp4(name?: string, onlyTrackId?: string): Promise<void> {
  // 必须在第一个 await 之前拿：后面的保存 / 探测 / 音频预热都可能让连点穿过去。
  const release = tryAcquireExport('ui');
  if (!release) return;
  try {
    await exportMp4Inner(name, onlyTrackId);
  } finally {
    release();
  }
}

async function exportMp4Inner(name?: string, onlyTrackId?: string): Promise<void> {
  if (appState.exportProgress !== null) return;
  if (blockedByTypoScripts()) return;
  if (!mp4Supported()) {
    appState.flash(tr('err.export.noWebCodecs'), 'error');
    return;
  }
  await saveBeforeExport();
  // 保存是异步的：两次快速点击都能穿过上面的判断，所以这里要复查。
  if (appState.exportProgress !== null) return;

  // 阶梯探测在开跑之前做。全不支持时说的是「没有可用 H.264」，
  // 不是「不支持 WebCodecs」—— 后者是误诊。
  const choice = await probeMp4Codec({
    w: appState.store.project.resolution.w,
    h: appState.store.project.resolution.h,
    fps: appState.store.project.fps,
  });
  if (!choice) {
    appState.flash(tr('err.export.noH264'), 'error');
    return;
  }

  const project = appState.store.project;
  /*
   * 视频内嵌音轨是**异步**解码的，而 `mixdown` 是同步的：先把用到的视频音轨
   * 全部解出来并注册进 player，混流的 resolver 才有东西可取。失败 → 静音，
   * 不影响导出（与预览同一条降级路径）。
   */
  await prepareProjectVideoAudio(project, (id, buf) => appState.player.register(id, buf));
  const audio = mixdown(project, (id) => appState.player.buffer(id));
  if (audio && audio.peak < 1e-4) {
    // 全静音还给用户一个带音轨的 MP4，会让人以为混流坏了。
    appState.flash(tr('err.export.silentAudio'), 'info');
  }

  const ctrl = new AbortController();
  appState.exportAbort = ctrl;
  appState.exportProgress = 0;

  try {
    // 落盘方式在开跑之前定：估算体积超内存预算就先要一个写入位置（见 pickOutput）。
    const stream = await pickOutput('mp4', safeBase(name), estimateMp4PeakBytes());
    if (ctrl.signal.aborted) {
      await stream?.abort();
      return;
    }
    const sink = new Mp4Sink({ audio, stream });
    // 只导某视觉轨时音轨照常混入（音频不属视觉轨，见 onlyTrackId 语义）。
    const result = await runExport(appState.renderer, project, {
      sink,
      codec: choice.codec,
      onlyTrackId,
      onProgress: (f) => {
        appState.exportProgress = f;
      },
      signal: ctrl.signal,
    });
    if (typeof result === 'string') {
      // 流式：字节已经在用户选的那个文件里了，报尺寸与文件名即可。
      appState.flash(
        tr('err.export.streamDone', { name: result, size: fmtSize(sink.byteLength()) }),
        'success',
      );
    } else {
      const size = fmtSize(result.size);
      appState.flash(tr('err.export.mp4Done', { size }), 'success');
      await platform.download(result, `${safeBase(name)}.mp4`);
    }
  } catch (e) {
    if (!(e instanceof ExportCancelled)) {
      appState.flash(tr('err.export.failed', { detail: e instanceof Error ? e.message : String(e) }), 'error');
    }
  } finally {
    appState.exportProgress = null;
    appState.exportAbort = null;
  }
}

/** 导出 PNG 序列（zip）。重复调用是空操作。 */
export async function exportPngSequence(name?: string, onlyTrackId?: string): Promise<void> {
  const release = tryAcquireExport('ui');
  if (!release) return;
  try {
    await exportPngSequenceInner(name, onlyTrackId);
  } finally {
    release();
  }
}

async function exportPngSequenceInner(name?: string, onlyTrackId?: string): Promise<void> {
  if (appState.exportProgress !== null) return;
  if (blockedByTypoScripts()) return;
  await saveBeforeExport();
  if (appState.exportProgress !== null) return;

  const ctrl = new AbortController();
  appState.exportAbort = ctrl;
  appState.exportProgress = 0;

  try {
    const stream = await pickOutput('png', safeBase(name), await estimatePngBytes(totalFrames(), onlyTrackId));
    if (ctrl.signal.aborted) {
      await stream?.abort();
      return;
    }
    const result = await runExport(appState.renderer, appState.store.project, {
      sink: new PngSequenceSink({ stream }),
      onlyTrackId,
      onProgress: (f) => {
        appState.exportProgress = f;
      },
      signal: ctrl.signal,
    });
    if (typeof result === 'string') {
      appState.flash(tr('err.export.streamDone', { name: result, size: '' }), 'success');
    } else {
      await platform.download(result, `${safeBase(name)}-png.zip`);
    }
  } catch (e) {
    if (!(e instanceof ExportCancelled)) {
      appState.flash(tr('err.export.failed', { detail: e instanceof Error ? e.message : String(e) }), 'error');
    }
  } finally {
    appState.exportProgress = null;
    appState.exportAbort = null;
  }
}

/* ------------------------------------------------------------------- GIF */

/**
 * GIF 帧率档位。
 *
 * **全都能整除 100**，这是刻意的：GIF 的显示时长单位是厘秒，只有 `100 / n`
 * 是整数时逐帧时长才落得下。15fps 这种「整数、但不整除 100」的值每帧是 6.67cs，
 * 无论怎么取整都会漂（见 `gif-plan.ts::gifFrameDelays`）。
 */
export const GIF_FPS_CHOICES = [10, 12.5, 20, 25] as const;

/**
 * GIF 宽度档位（像素）。
 *
 * 上限只到 640：GIF 体积随像素数线性涨，而它是**发出去给人看**的格式，
 * 再宽就该用 MP4 了。高度按工程宽高比换算 —— 竖屏工程选 480 得到的是
 * 480×853，不是 480×270。
 */
export const GIF_WIDTH_CHOICES = [240, 360, 480, 640] as const;

/** 默认档位：480px 宽 @ 12.5fps。480 在聊天窗口里够看，12.5 恰好是 8cs/帧。 */
export const GIF_DEFAULT_FPS = 12.5;
export const GIF_DEFAULT_WIDTH = 480;

/** 调色板上限。GIF 的格式上限就是 256；给个常量只是为了让调用点能读懂。 */
export const GIF_MAX_COLORS = 256;

/** GIF 导出的参数。三项都能在导出面板上改。 */
export interface GifOptions {
  /** 目标帧率。应当取 `GIF_FPS_CHOICES` 里的值（理由见那个常量）。 */
  fps: number;
  /** 目标宽度（像素）。高度按工程宽高比换算。 */
  width: number;
  /**
   * 只导出工程时间轴上的这一段（秒）。省略 = 整段。
   *
   * 这是 GIF 最实用的一个旋钮：体积与「时长 × 面积」成正比，而一段 24 秒的
   * 片子往往只有几秒值得发出去。**不用自己 clamp** —— `gifPlan` 会夹。
   */
  range?: { start: number; end: number };
}

/**
 * 按当前工程算一份 GIF 导出计划。
 *
 * 面板上的尺寸 / 帧数 / 体积提示，与导出本身，共用这一个入口 ——
 * 两边各算一遍的 bug 形态是「提示说 12.5fps 300 帧，导出来是别的数」。
 */
export function gifPlan(opts: GifOptions): GifPlan {
  const p = appState.store.project;
  return planGif({
    srcSize: p.resolution,
    srcFps: p.fps,
    duration: p.duration,
    range: opts.range,
    width: opts.width,
    fps: opts.fps,
  });
}

/**
 * 跑完一条真实的 GIF 导出，回传产物。
 *
 * 只做编码：不写 appState 的进度、不触发下载 —— 这样 `exportGif` 那边只剩编排
 * （进度 / 取消 / 下载），而 page 内的 E2E 探针也能直接拿到字节，不必再走一遍
 * 「算 plan → 建 sink → runExport」那套（那样测的就不是面板走的那条路了）。
 */
export async function gifBlob(
  opts: GifOptions,
  hooks: { onProgress?: (frac: number) => void; signal?: AbortSignal } = {},
  onlyTrackId?: string,
): Promise<Blob> {
  const plan = gifPlan(opts);
  return (await runExport(appState.renderer, appState.store.project, {
    sink: new GifSink({
      width: plan.size.w,
      height: plan.size.h,
      maxColors: GIF_MAX_COLORS,
      delaysMs: plan.delaysMs,
      loop: 0, // 无限循环：GIF 的默认预期，也是各平台上的实际行为
    }),
    codec: GIF_SINK_CODEC,
    size: plan.size,
    frameStep: plan.frameStep,
    // 区间用帧号传：秒 → 帧号的换算只有 gif-plan 那一处，面板的帧数与
    // 真正渲的帧数因此不可能各算一套。
    frameRange: plan.frameRange,
    onlyTrackId,
    // 量化是纯 CPU 的（每帧几十毫秒），默认的「10 帧让渡一次」会让取消按钮
    // 半秒才响应。理由见 ExportOptions.yieldEvery。
    yieldEvery: 1,
    onProgress: hooks.onProgress,
    signal: hooks.signal,
  })) as Blob;
}

/** 导出 GIF。重复调用是空操作。 */
export async function exportGif(
  name: string | undefined,
  opts: GifOptions,
  onlyTrackId?: string,
): Promise<void> {
  const release = tryAcquireExport('ui');
  if (!release) return;
  try {
    await exportGifInner(name, opts, onlyTrackId);
  } finally {
    release();
  }
}

async function exportGifInner(
  name: string | undefined,
  opts: GifOptions,
  onlyTrackId?: string,
): Promise<void> {
  if (blockedByTypoScripts()) return;
  if (appState.exportProgress !== null) return;
  await saveBeforeExport();
  if (appState.exportProgress !== null) return;

  const ctrl = new AbortController();
  appState.exportAbort = ctrl;
  appState.exportProgress = 0;

  try {
    const blob = await gifBlob(
      opts,
      {
        onProgress: (f) => {
          appState.exportProgress = f;
        },
        signal: ctrl.signal,
      },
      onlyTrackId,
    );
    appState.flash(tr('err.export.gifDone', { size: fmtSize(blob.size) }), 'success');
    await platform.download(blob, `${safeBase(name)}.gif`);
  } catch (e) {
    if (!(e instanceof ExportCancelled)) {
      appState.flash(tr('err.export.failed', { detail: e instanceof Error ? e.message : String(e) }), 'error');
    }
  } finally {
    appState.exportProgress = null;
    appState.exportAbort = null;
  }
}

export function cancelExport(): void {
  appState.exportAbort?.abort();
}
