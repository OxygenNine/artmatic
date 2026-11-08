/**
 * sources.ts — SourceClip → 纹理的解析器。
 *
 * solid → 1×1 色纹理（按颜色缓存）
 * image → 已解码的 ImageBitmap（`engine/media-assets.ts`），首次用到时上传成纹理；
 *         素材**不存在**（不是没解码好）时给「脱机媒体」占位图
 * algo  → 委托给注入的 algo 运行时；未装配或没烘好返回 null
 * text  → 委托给注入的排版运行时；缓存未命中时返回 null，
 *         由它异步光栅化后经 onReady → store.invalidate() → 下一帧重绘
 * video → 委托给注入的视频运行时；帧没解码好返回 null，同上；
 *         素材**不存在**时同 image 给占位图
 *
 * ## 为什么 image / video 都走「注入 resolver」而不是直连
 *
 * 两条路都是**异步就绪**的（图片要 `createImageBitmap`，视频要解到目标帧），
 * 而 `resolve` 必须是同步的 —— 它跑在每帧的合成路径上。所以约定与 algo 烘焙
 * 完全一致：**这一帧缺席，就返回 null**，由注入方在就绪后通知重绘。
 *
 * 图片这一层过去是缺的：`setImage` 早就写好了却**零调用方**，于是
 * 排版「转为图片」产出的片段画面上是空白。现在改成「注册解码结果 + 懒上传」，
 * 顺带解决了「注册时渲染器还没建好」的时序问题 —— 登记项活在模块里，
 * 纹理等第一次真正用到时才建。
 */

import type { SourceClip } from '../core/schema';
import type { Kit } from './kit';
import type { SourceResolver, SourceTexture } from './compositor';
import { imageSourceFor, imagePixels, type ImageEntry } from './media-assets';
import {
  OFFLINE_PLACEHOLDER_SIZE,
  drawOfflinePlaceholder,
} from './offline-placeholder';

export type AlgoResolver = (clip: SourceClip, t: number, frame: number) => SourceTexture | null;

/**
 * 视频解析器。与 AlgoResolver 同形（同步、未就绪给 null），
 * 差别是它背后有解码队列 —— 实现见 `engine/video-source.ts`。
 */
export type VideoResolver = (clip: SourceClip, t: number, frame: number) => SourceTexture | null;

/** 图片解析器：assetId → 已解码的图源。未解码好就返回 null。 */
export type ImageResolver = (assetId: string) => ImageEntry | null;

/**
 * `resolveAssetPixels` 的返回形状。
 *
 * 与 `algos/types.ts::AssetPixels` **结构性兼容**，但不 import 它 —— `engine/`
 * 不能反向依赖 `algos/`（见文件头的分层）。两边各写一次的风险由
 * `svelte-check` 兜住：注入点在 `render/render-core.ts`，类型对不上就编译失败。
 */
export interface AssetPixelsRecord {
  data: Uint8ClampedArray;
  w: number;
  h: number;
  /** 登记项身份。换了图它就换，上游缓存据此失效。 */
  rev: object;
}

/**
 * 排版解析器。比 AlgoResolver 多两个参数：当前渲染尺寸。
 * 光栅化必须照着「这一层会被画多大」出图（预览 ≈960、导出 1920），
 * 而渲染尺寸是 renderer 的状态（kit.w / kit.h），不是片段自己的属性。
 */
export type TextResolver = (
  clip: SourceClip,
  t: number,
  renderW: number,
  renderH: number,
) => SourceTexture | null;

import { hexToRgba } from '../core/color';

/** 兼容旧路径：实现已提到 `core/color.ts`（纯函数，可单测）。 */
export { hexToRgba };

export class SourceManager {
  private readonly solidCache = new Map<string, SourceTexture>();
  /**
   * 图片纹理缓存。`rev` 是**登记项对象本身**：同一个 assetId 换了内容
   * （登记处新建了 entry）身份就变，缓存自然失效 —— 不需要任何显式的
   * invalidate 调用，那种调用迟早有人忘记加。
   */
  private readonly imageCache = new Map<string, { st: SourceTexture; rev: object }>();
  /** CPU 侧的像素缓存（`resolveAssetPixels`）。与纹理缓存分开：用途不同、寿命不同。 */
  private readonly pixelsCache = new Map<string, AssetPixelsRecord>();
  private algoResolver: AlgoResolver | null = null;
  private textResolver: TextResolver | null = null;
  private videoResolver: VideoResolver | null = null;
  private imageResolver: ImageResolver | null = imageSourceFor;
  /**
   * 「这个 assetId 是不是**真的不存在**」的探针（由装配层注入）。
   *
   * 与「还没加载好」是两件事：图片 / 视频都是异步就绪的，加载窗口里
   * resolver 同样返回 null。占位符只画给**不存在**的素材 —— 否则正常加载
   * 会满屏闪暗红（那是比空白更糟的形态）。
   */
  private assetOffline: ((assetId: string) => boolean) | null = null;
  /** 占位图上的文字（宿主从 i18n 注入；空 = 只画图标）。 */
  private offlineLabel = '';
  /** 占位图纹理（全进程共用一张；文字变了才重画）。 */
  private offlineTex: SourceTexture | null = null;

  constructor(private readonly kit: Kit) {}

  /** 注入「素材是否不存在」的判据。不注入 = 从不画占位符（lab 等无素材场景）。 */
  setAssetOfflineProbe(fn: ((assetId: string) => boolean) | null): void {
    this.assetOffline = fn;
  }

  /** 占位图文字。变化时丢掉旧纹理重画（语言切换的唯一致效路径）。 */
  setOfflineLabel(label: string): void {
    if (this.offlineLabel === label) return;
    this.offlineLabel = label;
    if (this.offlineTex) {
      this.kit.gl.deleteTexture(this.offlineTex.tex);
      this.offlineTex = null;
    }
  }

  /**
   * 「脱机媒体」占位图（Canvas2D → 纹理，懒建 + 缓存）。
   *
   * 走 `uploadImage` 而不是自己建纹理：`UNPACK_FLIP_Y_WEBGL` 的翻转纪律
   * 只有那一处实现（canvas 源 + 翻一次 = 正确朝向，见那里的两轮实测注释）。
   */
  private offlineTexture(): SourceTexture | null {
    if (this.offlineTex) return this.offlineTex;
    const { w, h } = OFFLINE_PLACEHOLDER_SIZE;
    const canvas =
      typeof OffscreenCanvas !== 'undefined'
        ? new OffscreenCanvas(w, h)
        : document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d');
    if (!ctx) return null;
    drawOfflinePlaceholder(ctx, w, h, this.offlineLabel);
    this.offlineTex = this.uploadImage(canvas, w, h);
    return this.offlineTex;
  }

  setAlgoResolver(r: AlgoResolver | null): void {
    this.algoResolver = r;
  }

  setTextResolver(r: TextResolver | null): void {
    this.textResolver = r;
  }

  setVideoResolver(r: VideoResolver | null): void {
    this.videoResolver = r;
  }

  /** 默认实现直接读 `media-assets` 的登记表；注入只是为了测试可替换。 */
  setImageResolver(r: ImageResolver | null): void {
    this.imageResolver = r;
  }

  readonly resolve: SourceResolver = (clip, t, frame) => {
    switch (clip.source.type) {
      case 'solid':
        return this.solid(clip.source.color);
      case 'image': {
        const entry = this.imageResolver?.(clip.source.assetId);
        if (entry) return this.imageTexture(clip.source.assetId, entry);
        // 素材不存在（不是「还没解码好」）→ 脱机媒体占位图。
        return this.assetOffline?.(clip.source.assetId) ? this.offlineTexture() : null;
      }
      case 'algo':
        return this.algoResolver?.(clip, t, frame) ?? null;
      case 'video': {
        const st = this.videoResolver?.(clip, t, frame);
        if (st) return st;
        return this.assetOffline?.(clip.source.assetId) ? this.offlineTexture() : null;
      }
      case 'text':
        // 多传 kit.w / kit.h：光栅化要照着「这一层会被画多大」出图，
        // 而渲染尺寸是 renderer 的状态（预览 ≈960、导出 1920）。
        return this.textResolver?.(clip, t, this.kit.w, this.kit.h) ?? null;
      default:
        return null;
    }
  };

  private solid(color: string): SourceTexture {
    const hit = this.solidCache.get(color);
    if (hit) return hit;
    const gl = this.kit.gl;
    const tex = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texImage2D(
      gl.TEXTURE_2D, 0, gl.RGBA8, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE,
      new Uint8Array(hexToRgba(color)),
    );
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    const st: SourceTexture = { tex, w: 1, h: 1 };
    this.solidCache.set(color, st);
    return st;
  }

  /**
   * 图片纹理：按 assetId 缓存，用**登记项对象身份**当版本号。
   *
   * 同一个 assetId 换了内容（登记处新建了 entry）身份就变，缓存自然失效 ——
   * 不需要任何显式的 invalidate 调用，那种调用迟早有人忘记加。
   */
  private imageTexture(assetId: string, entry: ImageEntry): SourceTexture {
    const hit = this.imageCache.get(assetId);
    if (hit && hit.rev === entry) return hit.st;
    if (hit) this.kit.gl.deleteTexture(hit.st.tex);

    const st = this.uploadImage(entry.source, entry.w, entry.h);
    this.imageCache.set(assetId, { st, rev: entry });
    return st;
  }

  /**
   * 把一个 **canvas 源**上传成纹理。
   *
   * ## `UNPACK_FLIP_Y_WEBGL = true` —— 这是实测结论，而且是两轮实测
   *
   * 第一轮：按「DOM 行序自上而下、纹理 v=0 是第一行，所以要翻」的推断写 true，
   * E2E 抓到画面整体上下颠倒。第二轮：改成 false，**结果逐像素完全一样** ——
   * 于是真相清楚了：第一轮的颠倒不是这个标志造成的，而是
   * **Chromium 上传 `ImageBitmap` 时忽略这个标志**。
   *
   * 对策是把上传源统一成 canvas（见 `media-assets.registerImageBytes`）：
   * canvas 源正常受标志控制，所以这里翻一次就够，图片与视频同时正确。
   *
   * 与**排版那条路无关**：排版的纹理在自己的运行时里上传（ADR-003 规则②
   * 也需要 FLIP_Y），两条路各管各的，不要互相照搬。
   * 这一切由 `tests/e2e/m6.spec.ts` 的「上红下蓝」断言钉死。
   */
  uploadImage(source: TexImageSource, w: number, h: number): SourceTexture {
    const gl = this.kit.gl;
    const tex = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, source);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    return { tex, w, h };
  }

  /**
   * 素材 id → 已解码的图片纹理。**给蒙版引用用**（`MaskRef.kind === 'asset'`）：
   * 蒙版素材就是一张普通 image，没必要再走「造一个虚拟片段」那条路。
   *
   * 未解码好返回 null（与 `resolve` 同一条同步约定：这一帧缺席，就绪后重绘）。
   */
  resolveAssetImage(assetId: string): SourceTexture | null {
    const entry = this.imageResolver?.(assetId);
    return entry ? this.imageTexture(assetId, entry) : null;
  }

  /** 素材被替换/移除时丢掉对应的纹理（登记处没有失效通知时才需要显式调）。 */
  invalidateImage(assetId: string): void {
    const hit = this.imageCache.get(assetId);
    if (!hit) return;
    this.kit.gl.deleteTexture(hit.st.tex);
    this.imageCache.delete(assetId);
  }

  /**
   * 素材 id → **RGBA 像素**。给 CPU 侧的图分析用（`logo-sdf` 的距离场）。
   *
   * `rev` 是登记项对象本身（与 `imageCache` 同一条身份判据）：素材被重新
   * 导入时 `media-assets` 会换一个新 entry，缓存自然失效。
   *
   * 只缓存一份，没有淘汰 —— 它只服务一个消费者（距离场），而那个消费者
   * 自己按 assetId 缓存得更久。这里留着是为了「同一帧内被问两次不重复拷贝」。
   */
  resolveAssetPixels(assetId: string): AssetPixelsRecord | null {
    const entry = this.imageResolver?.(assetId);
    if (!entry) return null;
    const hit = this.pixelsCache.get(assetId);
    if (hit && hit.rev === entry) return hit;
    const data = imagePixels(entry);
    if (!data) return null;
    const rec: AssetPixelsRecord = { data, w: entry.w, h: entry.h, rev: entry };
    this.pixelsCache.set(assetId, rec);
    return rec;
  }
}
