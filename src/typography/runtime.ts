/**
 * runtime.ts — 排版层的运行时：文档 → 位图 → GL 纹理 → 合成链。
 *
 * 与已有 BakeClient 完全同构的桥接（同步 resolver ↔ 异步光栅化）：
 *   缓存命中 → 同步返回纹理
 *   未命中   → 返回 null（这一层这帧缺席）+ 异步光栅化 → onReady() →
 *              store.touch() → 下一帧 rAF 重绘
 *
 * 唯一超出 BakeClient 的地方是导出：导出的紧循环没有「缺席一帧」的余地，
 * 所以 renderer.prepareFrame / prewarmFonts 暴露了可 await 的预热入口。
 *
 * 缓存键 = (docHash, 输出尺寸, 本地帧号)。静态文档的帧号是 null ——
 * 一张标题卡整个片段生命期只光栅化一次。
 *
 * ## 淘汰的两条不变量（2026-10-12）
 *
 * 1. **预算按机器派生**（`limits.textRasterMB`，见 `core/capacity.ts`），
 *    不再是写死的 48 MB。
 * 2. **不许淘汰「这一帧在屏的层」**（`protectedKeys`）。上限与「这一帧要画什么」
 *    冲突时保画面，并把超支报进 `stats().overBudget`。
 *
 * 第 2 条是踩出来的：导出期条目上限写死 2，而一帧有 3 层排版时每帧必有一层被
 * 淘汰，导出态又没有「缺帧顶上」的回退 ⇒ 那一层这帧真的没有，表现是逐帧闪烁。
 * **上限必须罩得住当前实际要画的东西** —— 换成字节预算也一样，所以两条都要在。
 */

import { drawSizeFor } from '../engine/placement.frag';
import { buildStack, transitionSources, walkOps } from '../engine/stack';
import { getLimits, mbToBytes } from '../core/capacity';
import type { SourceTexture } from '../engine/compositor';
import type { Kit } from '../engine/kit';
import type { TextResolver } from '../engine/sources';
import type { Project, SourceClip } from '../core/schema';
import { frameKeyFor, rasterKeyForDoc } from './cache-key';
import { cameraDensity } from './camera';
import { withCameraAt } from './camera-tracks';
import type { TypographyDocument } from './document';
import type { TypographyTheme } from './theme';
import type { FontProvider } from './font-provider';
import type { RasterRequest, TextBackendRegistry } from './rasterizer';
import { hasRenderTypoHooks } from './hook-registry';

/**
 * 条目数的**次级**上限：只防「一帧一个新键」那种抖动，容量主要由字节预算管
 * （`limits.textRasterMB`，按机器派生）与「不许淘汰在屏层」那条不变量管。
 */
export const MAX_RASTER_ENTRIES = 32;
/**
 * 导出期条目数的**下限**（真正的上限是 `exportKeep`，见 `prewarmFrame`）。
 *
 * 原意是「导出是顺序的，留着历史纯属浪费显存」，所以压到 2。但**上限必须罩得住
 * 这一帧真的会被画到的排版层个数**：一帧有 3 层排版（本项目就是「字幕 + 上下黑边 +
 * 标题卡」，黑边与字幕是静态文档、标题卡是动画文档）时，写死 2 会让三层每帧互相
 * 淘汰 —— 每帧必有一层被淘汰，而导出态**没有**「缺帧用最近一帧顶上」那条回退
 * （见 `resolve`），于是那一层这帧真的没有。表现是逐帧闪烁，且哪一层缺是竞态决定的。
 */
export const EXPORT_ENTRIES = 2;

export type { TextResolver };

interface CacheEntry {
  tex: WebGLTexture;
  w: number;
  h: number;
  bytes: number;
  used: number;
}

export interface TypographyRuntimeOptions {
  /** 新的位图就绪时调用 —— 与 BakeClient 一样接到 store.touch()。 */
  onReady: () => void;
  /** 取当前工程 fps。用回调而不是字段，避免「忘了同步」这一类 bug。 */
  fps: () => number;
  /**
   * 工程种子（`Project.seed`）。脚本的 `ctx.rand(i)` 由它派生。
   * 函数而不是数字：切工程后这里必须读到新工程的那份。
   */
  projectSeed: () => number;
  /**
   * 脚本总开关（UiPrefs.runTypoScripts）。**函数**：偏好改了立刻生效，
   * 不需要重建 runtime；键里的模式盐也跟着变（见 `keyFor`）。
   */
  scriptsEnabled: () => boolean;
}

export class TypographyRuntime {
  /** 0.25 / 0.5 / 1 = 低画质预览档。默认 1（跟随渲染尺寸）。 */
  previewScale = 1;

  private readonly entries = new Map<string, CacheEntry>();
  private readonly inflight = new Set<string>();
  /**
   * `docHash|WxH` → 该文档在该尺寸下**最近一次**已烘焙好的条目键。
   *
   * 动画文档的缓存键含帧号 ⇒ 播放头每前进一帧就是一次 miss，而光栅化是异步的，
   * 等它完成时播放头往往已经走到下一帧 —— 于是每一帧都错过、偶尔命中上一帧的产物，
   * 表现成「隔一帧消失一帧」的频闪。这里保留最近一帧，缺帧时**用它顶上**（与视频
   * 取帧「缺帧用最近的帧顶上」同构）：只落后一帧，不闪。导出走 `prewarmFrame`
   * 逐帧 await，永远是命中，不会用到这条回退。
   */
  private readonly latest = new Map<string, string>();
  private clock = 0;
  private exportMode = false;
  /**
   * 导出期允许常驻的条目数。由 `prewarmFrame` 按「这一帧会被画到的排版层」抬高
   * （见 EXPORT_ENTRIES 的注释）：写死数字会在层数多于一帧的上限时每帧互相淘汰。
   */
  private exportKeep = EXPORT_ENTRIES;

  /*
   * 「这一帧在屏的层」—— 淘汰时**必须保住**的那些键。
   *
   * 这是本模块的第二条不变量（第一条是「预算按机器派生」）：**上限必须罩得住
   * 当前实际要画的东西**。只要它俩冲突，正确的做法是保住画面对不对，而不是
   * 让上限赢 —— 上限赢的表现是「某一层隔帧消失」，用户看到的是闪烁，
   * 而我们是**静默**地少画了一层。
   *
   * 判据是「当前帧 ∪ 上一帧」：`resolve` 是在渲染中被逐个调用的，淘汰却可能发生在
   * 两帧之间（异步光栅化落地时 upload → evict）。此刻屏幕上还是上一帧的画面，
   * 所以上一帧的集合同样不许动 —— 这正是老注释里「保留当前帧 ±1」想表达的意思。
   */
  private live = new Set<string>();
  private livePrev = new Set<string>();
  private liveT = Number.NaN;
  /** 预算罩不住在屏层时置位（保画面优先）；读数在 `stats()` 里，别静默。 */
  private overBudget = false;

  private markLive(key: string, t: number): void {
    if (t !== this.liveT) {
      this.liveT = t;
      this.livePrev = this.live;
      this.live = new Set();
    }
    this.live.add(key);
  }

  /** 不许被淘汰的键集合（当前帧 ∪ 上一帧）。 */
  private protectedKeys(): Set<string> {
    if (this.livePrev.size === 0) return this.live;
    if (this.live.size === 0) return this.livePrev;
    return new Set([...this.live, ...this.livePrev]);
  }

  constructor(
    private readonly kit: Kit,
    private readonly backends: TextBackendRegistry,
    private readonly fonts: FontProvider,
    private readonly opts: TypographyRuntimeOptions,
  ) {}

  /* ------------------------------------------------------------ 同步解析 */

  readonly resolve: TextResolver = (clip, t, renderW, renderH) => {
    if (clip.source.type !== 'text') return null;
    const localSec = t - clip.start;
    // 镜头动画在这一帧的值（没有轨道时原样返回，零成本）。
    const doc = withCameraAt(clip.source.doc, localSec);
    const size = this.rasterSizeFor(clip, doc.size.w, doc.size.h, renderW, renderH);
    const key = this.keyFor(doc, localSec, size.w, size.h);
    // 先记「这一帧要它」再判命中：**没命中也是要**（下一帧就会命中），
    // 而淘汰正好可能落在这两帧之间。
    this.markLive(key, t);

    const hit = this.entries.get(key);
    if (hit) {
      hit.used = ++this.clock;
      return { tex: hit.tex, w: hit.w, h: hit.h };
    }

    this.schedule(key, doc, size.w, size.h, localSec, clip.end - clip.start);

    // 预览缺帧时用同一个文档+尺寸下最近烘焙好的那一帧顶上，避免「隔一帧消失一帧」。
    // 导出不走这条（prewarmFrame 已逐帧 await，必命中）。
    if (!this.exportMode) {
      const sizeKey = sizeKeyOf(key);
      const fb = this.latest.get(sizeKey);
      if (fb) {
        const e = this.entries.get(fb);
        if (e) {
          e.used = ++this.clock;
          return { tex: e.tex, w: e.w, h: e.h };
        }
        this.latest.delete(sizeKey);
      }
    }
    return null; // 这一层这帧缺席；准备好后 onReady 会触发下一帧重绘
  };

  private keyFor(doc: TypographyDocument, localSec: number, w: number, h: number): string {
    const localFrame = Math.round(localSec * this.opts.fps());
    const scripts = this.opts.scriptsEnabled();
    const hooks = hasRenderTypoHooks();
    return rasterKeyForDoc(doc, w, h, frameKeyFor(doc, localFrame, scripts, hooks), {
      scriptsActive: scripts,
      hooksActive: hooks,
      density: this.densityFor(doc, w, h),
    });
  }

  /**
   * 光栅化的**超采样密度**（1..2）。
   *
   * 镜头放大 k 倍时，元素在屏幕上就占 k 倍的像素：位图仍按目标尺寸烘的话，
   * 40× 的镜头只会得到一张糊图。所以按「最大生效缩放」提高光栅密度 ——
   * 上限 2（`camera.ts::cameraDensity`），再往上交给显卡放大：
   * 40× 若按 40× 密度烘，1080p 一帧是几十亿像素。
   *
   * 这里再夹一次机器上限：`rasterEdge` 是**位图边长**的硬上限，
   * 超采样是清晰度旋钮，不值得为它去申请一张 8192 宽的纹理。
   *
   * 全 depth = 0（没人吃镜头）时恒为 1 ⇒ 位图尺寸与缓存键都逐字不变。
   */
  private densityFor(doc: TypographyDocument, w: number, h: number): number {
    const want = cameraDensity(doc);
    if (want <= 1) return 1;
    const edge = getLimits().rasterEdge;
    const room = edge / Math.max(1, w, h);
    return Math.max(1, Math.min(want, room));
  }

  /**
   * 光栅化的目标像素尺寸。
   *
   * 关键点：**不需要任何 `if (isExport)` 分支**。`renderW/renderH` 就是
   * kit.w/kit.h —— 预览时它已经是适配后的小尺寸，导出时它就是输出分辨率
   * （renderer.setExportSize）。所以「0.25x 预览 / 1.00x 导出」是这条式子的
   * 自然结果，而不是一个要维护的开关。
   *
   * 尺寸按文档宽高比推导：纹理的宽高比与文档一致时，compositor 的
   * drawSizeFor 算出来的摆放尺寸与光栅分辨率无关 —— 也就是说调 previewScale
   * 只影响清晰度，不影响版式。
   */
  private rasterSizeFor(
    clip: SourceClip,
    docW: number,
    docH: number,
    renderW: number,
    renderH: number,
  ): { w: number; h: number } {
    const [dW, dH] = drawSizeFor(clip.fit, renderW, renderH, docW, docH, 1, 1);
    const kW = dW / docW;
    const kH = dH / docH;
    const s = this.previewScale;
    // 边长上限来自机器能力（`limits.rasterEdge`）：8K 工程在大显存机器上放宽，
    // 小机器上维持 4096 别把一张位图做成几百 MB。
    const edge = getLimits().rasterEdge;
    return {
      w: clampInt(docW * kW * s, edge),
      h: clampInt(docH * kH * s, edge),
    };
  }

  /* ------------------------------------------------------------ 异步烘焙 */

  /**
   * 一份光栅化请求。三处调用（异步 / 导出预热 / 单帧烘焙）共用它 ——
   * 每处各拼一份的形态是「预览跑脚本、导出不跑」这类最难发现的差异。
   */
  private requestFor(
    doc: TypographyDocument,
    w: number,
    h: number,
    localSec: number,
    duration: number,
  ): RasterRequest {
    return {
      doc,
      width: w,
      height: h,
      // 密度只影响清晰度、不影响版式：后端按它提高截图分辨率再缩回目标尺寸。
      density: this.densityFor(doc, w, h),
      localSec,
      fps: this.opts.fps(),
      duration,
      seed: this.opts.projectSeed(),
      scriptsActive: this.opts.scriptsEnabled(),
      resolveImage: this.resolveImage,
      isImageOffline: this.isImageOffline,
      offlineLabel: this.offlineLabel,
      customThemes: this.customThemes(),
    };
  }

  private schedule(
    key: string,
    doc: TypographyDocument,
    w: number,
    h: number,
    localSec: number,
    duration: number,
  ): void {
    if (this.inflight.has(key)) return;
    this.inflight.add(key);
    const backend = this.backends.pick();
    void backend
      .rasterize(this.requestFor(doc, w, h, localSec, duration))
      .then((canvas) => {
        this.upload(key, canvas, w, h);
        this.inflight.delete(key);
        this.opts.onReady();
      })
      .catch((err) => {
        this.inflight.delete(key);
        console.error('[typo] 光栅化失败', err);
      });
  }

  /** 图片素材的 URL 解析。由编辑器注册；未注册时该元素这帧缺席。 */
  resolveImage: (assetId: string) => string | null = () => null;
  /**
   * 图片素材「脱机」判据（引用不存在 → 画面给暗红占位符）。
   * 与 `resolveImage` 返回 null 是两件事，见 `BuildDocOptions.isImageOffline`。
   */
  isImageOffline: (assetId: string) => boolean = () => false;
  /** 占位符文字（「脱机媒体」，宿主从 i18n 注入；空 = 只画图标）。 */
  offlineLabel = '';
  /**
   * 工程自定义配色方案。**函数而不是数组**：宿主会在切换工程后换掉返回内容
   * （数组是值，切了工程这里还留着上一份 —— 「A 工程的自定义配色跑进 B 工程」）。
   * 每次光栅化请求时才读，见 `RasterRequest.customThemes`。
   */
  customThemes: () => TypographyTheme[] = () => [];

  /* ------------------------------------------------------------ 导出预热 */

  /**
   * 把命中 t 的所有排版层预烘到当前渲染尺寸。
   *
   * 这是本模块对既有结构唯一的侵入（导出循环里多一次 await）。
   * 它与 `await sink.submit` 同类：是渲染前准备 + 协作式背压，
   * 不是第二个时钟 —— 硬约束 1.1 禁止的是「用 rAF 驱动导出」。
   *
   * 走 `buildStack` 而不是自己遍历 tracks，与 `video-source.ts::prepareProject`
   * 是同一条纪律：**要烘的是这一帧真的会被画到的那些层**，而转场会在片段自己的
   * span 之外求值（窗口前半段的入画片段 `localSec < 0`）—— 自己按
   * `t ∈ [clip.start, clip.end)` 筛会漏掉它，而导出态没有「缺帧顶上」那条回退，
   * 漏掉就是那一侧真的没有（动画文档每帧都是新键，等异步光栅化回来时这一帧早过去了）。
   */
  async prewarmFrame(project: Project, t: number): Promise<void> {
    const jobs: Promise<void>[] = [];
    const keys = new Set<string>();
    const bake = (clip: SourceClip): void => {
      if (clip.source.type !== 'text') return;
      const localSec = t - clip.start;
      const doc = withCameraAt(clip.source.doc, localSec);
      const size = this.rasterSizeFor(clip, doc.size.w, doc.size.h, this.kit.w, this.kit.h);
      const key = this.keyFor(doc, localSec, size.w, size.h);
      if (keys.has(key)) return;
      keys.add(key);
      const hit = this.entries.get(key);
      if (hit) {
        // 命中也要**刷新使用时刻**：否则「静态文档这一帧要用」不会体现在 LRU 顺序里，
        // 它会被下一次 upload 当成最旧的一条淘汰掉（正是逐帧闪烁的另一半）。
        hit.used = ++this.clock;
        return;
      }
      jobs.push(this.bakeNow(key, doc, size.w, size.h, localSec, clip.end - clip.start));
    };
    walkOps(buildStack(project, t), (op) => {
      if (op.type === 'source') bake(op.source.clip);
      else if (op.type === 'transition') {
        for (const side of transitionSources(op)) bake(side.clip);
      }
    });
    // 上限必须罩得住这一帧的全部排版层（见 EXPORT_ENTRIES 的注释）。
    this.exportKeep = Math.max(EXPORT_ENTRIES, keys.size);
    await Promise.all(jobs);
  }

  private async bakeNow(
    key: string,
    doc: TypographyDocument,
    w: number,
    h: number,
    localSec: number,
    duration: number,
  ): Promise<void> {
    if (this.inflight.has(key)) return;
    this.inflight.add(key);
    try {
      const canvas = await this.backends
        .pick()
        .rasterize(this.requestFor(doc, w, h, localSec, duration));
      this.upload(key, canvas, w, h);
    } catch (err) {
      console.error('[typo] 预热失败', err);
    } finally {
      this.inflight.delete(key);
    }
  }

  /** ADR-003 规则 ③：导出前必须等字体就绪。 */
  async prewarmFonts(project: Project): Promise<void> {
    for (const track of project.tracks) {
      if (track.kind !== 'visual') continue;
      for (const clip of track.clips) {
        if (clip.kind === 'source' && clip.source.type === 'text') {
          await this.fonts.ensure(clip.source.doc);
        }
      }
    }
  }

  /**
   * 强制光栅化一张（「烘焙为 PNG 素材」/ 舞台的实时预览用），不经过缓存。
   *
   * `duration` 缺省按 `localSec` 兜底：调用方（测试钩子 / 烘焙）不一定知道
   * 片段长度，而脚本的 `ctx.duration` 不能是 0（模板会拿它做归一化）。
   */
  async rasterizeOnce(
    doc: TypographyDocument,
    width: number,
    height: number,
    localSec: number,
    duration = Math.max(1, localSec),
  ): Promise<HTMLCanvasElement> {
    return this.backends
      .pick()
      .rasterize(this.requestFor(withCameraAt(doc, localSec), width, height, localSec, duration));
  }

  enterExportMode(): void {
    this.exportMode = true;
    // 从这里到第一帧 `prewarmFrame` 之间没有「本帧要画的层」这个概念，
    // 先用下限清一遍历史；真正的上限由 prewarmFrame 按帧抬高。
    this.exportKeep = EXPORT_ENTRIES;
    this.evict(EXPORT_ENTRIES, 0);
  }

  exitExportMode(): void {
    this.exportMode = false;
    this.evict(MAX_RASTER_ENTRIES, mbToBytes(getLimits().textRasterMB));
  }

  dispose(): void {
    for (const e of this.entries.values()) this.kit.gl.deleteTexture(e.tex);
    this.entries.clear();
    this.latest.clear();
    this.inflight.clear();
    this.live.clear();
    this.livePrev.clear();
    this.backends.dispose();
  }

  /** 测试钩子（`overBudget` / `live` 让「预算不够」这件事可见，而不是静默缺层）。 */
  stats(): { entries: number; bytes: number; budgetMB: number; live: number; overBudget: boolean } {
    let bytes = 0;
    for (const e of this.entries.values()) bytes += e.bytes;
    return {
      entries: this.entries.size,
      bytes,
      budgetMB: this.exportMode ? 0 : getLimits().textRasterMB,
      live: this.protectedKeys().size,
      overBudget: this.overBudget,
    };
  }

  /* ------------------------------------------------------------ 纹理上传 */

  private upload(key: string, canvas: HTMLCanvasElement, w: number, h: number): void {
    const gl = this.kit.gl;
    const old = this.entries.get(key);
    if (old) gl.deleteTexture(old.tex);

    const tex = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, tex);
    // **必须翻转**：纹理坐标 v=0 对应层的底部（VERT_QUAD 里 vUv = aPos*0.5+0.5），
    // 而 texImage2D 默认把图像的第一行放到 v=0。不翻的话文字和图形全上下颠倒。
    // 注意这把整个 GL 上传状态改了，用完立刻还原，免得影响别处的上传路径。
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, canvas);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);

    // 线性过滤：光栅化尺寸是照着显示尺寸算的，通常是 1:1 或略微缩小，
    // 用 NEAREST 会在 previewScale < 1 时把笔画打碎。
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);

    const bytes = w * h * 4;
    const entry: CacheEntry = { tex, w: canvas.width, h: canvas.height, bytes, used: ++this.clock };
    this.entries.set(key, entry);
    // 记成该「文档+尺寸」的最近一帧，供 resolve 在缺帧时回退（见 latest 的说明）。
    this.latest.set(sizeKeyOf(key), key);

    // 预算：导出期只限条目数（历史对顺序导出没用），预览期按机器的 `textRasterMB`。
    // 两边的条目上限都由「这一帧要画的层数」兜底 —— 见 `exportKeep` 与 `protectedKeys`。
    this.evict(
      this.exportMode ? this.exportKeep : MAX_RASTER_ENTRIES,
      this.exportMode ? 0 : mbToBytes(getLimits().textRasterMB),
      key,
    );
  }

  /**
   * 淘汰超出预算的条目（按最近使用时间）。`maxBytes` 为 0 表示只限条目数。
   *
   * **在屏的层不参与淘汰**（见 `protectedKeys`）：预算与「这一帧要画什么」冲突时
   * 保画面。若因此仍然超额，就把 `overBudget` 置位并**停手** —— 让它在 `stats()`
   * 里可见，而不是继续删到画面缺层。走到这一步表示机器能力与工程规模不匹配，
   * 该调 `textRasterMB` 或降排版层数，不该由淘汰逻辑替用户决定「哪一层可以消失」。
   *
   * `justUploaded` 必须保住：光栅化是**先落地、后渲染**，`resolve` 要到
   * `renderFrame` 里才 `markLive`。导出时 `live` / `livePrev` 还停在前两帧上，
   * 于是「刚落地的那一帧」成了唯一可淘汰的条目 —— 被删掉之后 `resolve` 必然
   * miss，这一帧的排版层整层缺席（导出成片纯黑）；而且 resolve 还会再排一次
   * 光栅化，串行链上白白多烘一张。
   */
  private evict(maxEntries: number, maxBytes: number, justUploaded?: string): void {
    let keep: Set<string>;
    if (this.exportMode && justUploaded) {
      /*
       * 导出**上传**时：屏幕上看的是前两帧，`live` / `livePrev` 保护不到
       * 刚落地的这一帧 —— 只剩它可淘汰，就是黑帧的成因。此刻唯一必须
       * 保住的就是它（导出是顺序的，历史没有保留价值）。
       */
      keep = new Set([justUploaded]);
    } else {
      /*
       * 其余时机（预览上传 / 进退出导出态）仍然按「在屏层不参与淘汰」：
       * `enterExportMode` 会先做一次清历史，但**不许删到在屏层**——那时
       * `prewarmFrame` 还没跑，删掉就只能等下一帧重新烘。
       */
      keep = new Set(this.protectedKeys());
      if (justUploaded) keep.add(justUploaded);
    }
    this.overBudget = false;
    while (this.entries.size > maxEntries || (maxBytes > 0 && this.totalBytes() > maxBytes)) {
      let victimKey: string | null = null;
      let oldest = Infinity;
      for (const [k, e] of this.entries) {
        if (keep.has(k)) continue;
        if (e.used < oldest) {
          oldest = e.used;
          victimKey = k;
        }
      }
      if (!victimKey) {
        this.overBudget = true;
        return;
      }
      const victim = this.entries.get(victimKey)!;
      this.kit.gl.deleteTexture(victim.tex);
      this.entries.delete(victimKey);
    }
  }

  private totalBytes(): number {
    let sum = 0;
    for (const e of this.entries.values()) sum += e.bytes;
    return sum;
  }
}

function clampInt(v: number, max: number): number {
  const n = Math.round(v);
  if (!Number.isFinite(n) || n < 1) return 1;
  return Math.min(n, max);
}

/**
 * 缓存键里的「文档 + 尺寸 + 模式」桶键（`docHash|WxH|模式盐`）。
 *
 * **不能再用 `lastIndexOf('|')` 切**：键现在是
 * `docHash|WxH|frame|模式盐|逐帧盐`，切最后一个分隔符得到的是「某一帧」，
 * `latest` 会退化成每帧一条记录 —— 缺帧回退失效（隔帧闪烁）且 Map 无限涨。
 *
 * 第 3 段（帧号）**跳过**：它就是我们要跨过去找上一帧的那个维度。
 * 第 5 段（`cache-key.ts::frameSalt`：镜头视差 + 超采样密度）也**不进桶** ——
 * 那两个量在镜头有关键帧时每帧都不同，进桶就等于每帧一个新桶，回退永远落空：
 * 播放时排版整层消失、偶尔赶上就闪一下，暂停又正常（2026-11-05 修的就是这个）。
 */
function sizeKeyOf(key: string): string {
  const parts = key.split('|');
  // 文档 + 尺寸 + 模式盐：切开关之后不能拿上一个模式的图顶上。
  return `${parts[0] ?? ''}|${parts[1] ?? ''}|${parts[3] ?? ''}`;
}
