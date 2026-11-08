/**
 * media-assets.ts — 运行期的「素材 → 可上传的图源」登记处。
 *
 * ## 为什么需要单独一层
 *
 * 持久化层存的是**字节**（`project/asset-store.ts`），渲染层要的是
 * **TexImageSource**。中间那次转换过去没有落点：`SourceManager.setImage`
 * 早就写好了，但**全仓库零调用方** —— 后果是排版「转为图片」产出的
 * `{type:'image'}` 片段、以及导入图片后建的同类型片段，**画面上都是空白**。
 *
 * 这里放的是「已经解码好、等着被上传」的东西，**不碰 GL**：
 *
 * ```
 * 字节 ──registerImageBytes──→ ImageBitmap ──→ SourceManager 首次用到时上传成纹理
 * 字节 ──registerVideoBlob ──→ Blob（不解码）──→ video-source 按需取帧
 * ```
 *
 * 关键设计：**视频只存 Blob/File 引用，绝不在内存里摊开字节**。
 * 浏览器给的文件句柄是磁盘背书的，mediabunny 从它 seek 读；10 MB 的素材
 * 占 10 MB 磁盘缓存而不是 10 MB 堆内存，几 GB 的素材也不会把页面撑爆。
 * 这一点是硬要求，而且**全链路**都是：`AssetStore.loadFrom` 对视频
 * 只开 `File` / 句柄，保存走 `writeStreamAtomic` —— 打开与保存都不再把
 * 几 GB 素材摊进堆。
 *
 * ## 生命周期
 *
 * `assetId` 是 uuid，一次导入一个，不会复用。所以「同一 id 换内容」在
 * 实践中不会发生；但 `registerImageBytes` 仍然按**对象身份**判断是否需要
 * 重传（`SourceManager` 拿登记项本身当版本号），这样万一发生了也不会画旧图。
 */

/**
 * 已解码、待上传的图片。
 *
 * `w/h` 给 placement 算 fit 用（contain/cover 要长宽比）。
 * `source` 刻意是 **canvas 而不是 ImageBitmap**，理由见 `registerImageBytes`。
 */
export interface ImageEntry {
  source: TexImageSource;
  w: number;
  h: number;
}

/**
 * 视频素材的载体。**优先 `Blob`**：本地导入时 `File` 是磁盘背书的句柄，
 * mediabunny 从它 seek 读，几 GB 素材也不会把页面撑爆。
 *
 * `Uint8Array` 是为**打开工程**那条路准备的降级：`AssetStore.loadFrom` 会把
 * 素材读回内存（AGENTS §8 第 12 条的已知问题），此时再包一层 `Blob` 会多一份
 * 拷贝，所以原样收下、用 mediabunny 的 `BufferSource` 零拷贝包住。
 */
export interface VideoPathMedia {
  kind: 'path';
  /** 本机绝对路径（桌面版 linked）。 */
  path: string;
  size: number;
  read(start: number, end: number): Promise<Uint8Array>;
}

/**
 * 桌面版 linked 视频：**按范围读**，不整份进堆。`read` 由平台层注入
 * （Electron 主进程的 `fs.read`，见 `platform/electron.ts`）。
 */
export type VideoMedia = Blob | Uint8Array | VideoPathMedia;

const images = new Map<string, ImageEntry>();
const videoMedia = new Map<string, VideoMedia>();

let listener: (() => void) | null = null;
/** 素材就绪/变化时的通知（主应用 → `store.invalidate()`，让下一帧重绘）。 */
export function setMediaAssetsListener(cb: (() => void) | null): void {
  listener = cb;
}

function notify(): void {
  listener?.();
}

/* ------------------------------------------------------------------ 图片 */

/**
 * 由字节解码出一张**可直接上传**的图源。
 *
 * ## 为什么先解成 ImageBitmap、再画进 canvas（而不是直接上传 ImageBitmap）
 *
 * 这是**实测**逼出来的：Chromium 上传 `ImageBitmap` 时**忽略
 * `UNPACK_FLIP_Y_WEBGL`**，于是图片上下颠倒，而且把那个标志从 true 改成 false
 * 结果逐像素完全一样（`tests/e2e/m6.spec.ts` 抓到的）。canvas 源则正常受那个
 * 标志控制。
 *
 * 所以这里统一成 canvas：**上传源只有一种类型（canvas）**，翻转就在
 * `SourceManager.uploadImage` 一处定义、对图片与视频同时生效 ——
 * 两条路各写一套翻转逻辑是最容易悄悄错一半的做法。
 *
 * 代价是内存里多一份 RGBA（4K 图约 33 MB），可接受：纹理上传后它只用于
 * 重传，不再参与逐帧路径。
 */
export async function registerImageBytes(assetId: string, blob: Blob): Promise<void> {
  const decoded = await decodeToCanvas(blob);
  if (!decoded) throw new Error('image decode failed');
  images.set(assetId, { source: decoded.canvas as unknown as TexImageSource, w: decoded.w, h: decoded.h });
  notify();
}

/**
 * 字节 → canvas。
 *
 * **两条解码路径不是冗余**：Chromium 的 `createImageBitmap` 不接受 SVG blob
 * （直接 reject），而 SVG 是本项目支持的素材类型（媒体池的扩展名表里有它）。
 * 于是位图走快路，SVG 走 `<img>` + `drawImage` —— `<img>` 里的 SVG 是隔离文档，
 * 外部引用与脚本都不会执行，作为素材解码是安全的。
 *
 * SVG 没有固有尺寸时 `naturalWidth` 是 0：此时按 1024² 的默认视口画，
 * 至少让「一个没有 width/height 的图标」能显示出来，而不是一条画不出来的素材。
 */
async function decodeToCanvas(blob: Blob): Promise<{ canvas: CanvasImageSource; w: number; h: number } | null> {
  let bitmap: ImageBitmap | null = null;
  try {
    bitmap = await createImageBitmap(blob);
  } catch {
    bitmap = null;
  }
  if (bitmap) {
    const out = drawInto(bitmap, bitmap.width, bitmap.height);
    bitmap.close();
    return out;
  }

  const url = URL.createObjectURL(blob);
  try {
    const img = new Image();
    img.src = url;
    await img.decode();
    const w = img.naturalWidth || 1024;
    const h = img.naturalHeight || 1024;
    return drawInto(img, w, h);
  } catch {
    return null;
  } finally {
    URL.revokeObjectURL(url);
  }
}

/** 把任意图源画进一张 canvas（统一成 canvas 的理由见 `registerImageBytes` 的注释）。 */
function drawInto(source: CanvasImageSource, w: number, h: number): { canvas: CanvasImageSource; w: number; h: number } | null {
  const canvas =
    typeof OffscreenCanvas !== 'undefined'
      ? new OffscreenCanvas(w, h)
      : document.createElement('canvas');
  if (canvas instanceof HTMLCanvasElement) {
    canvas.width = w;
    canvas.height = h;
  }
  const ctx = canvas.getContext('2d') as
    | OffscreenCanvasRenderingContext2D
    | CanvasRenderingContext2D
    | null;
  if (!ctx) return null;
  ctx.drawImage(source, 0, 0, w, h);
  return { canvas: canvas as unknown as CanvasImageSource, w, h };
}

export function imageSourceFor(assetId: string): ImageEntry | null {
  return images.get(assetId) ?? null;
}

/**
 * 已解码图片的 RGBA。给**必须在 CPU 上算**的消费方用（目前只有
 * `algos/logo-sdf.ts` 的有符号距离场）。
 *
 * 取不到就返回 null，而不是抛：画布被跨源污染（tisd 隔离失败）、上下文
 * 被别处换成 webgl、或者宿主根本没有 2D 上下文，都属于「这张图算不了」，
 * 由调用方退回占位轮廓 —— 那比让一帧渲不出来强。
 *
 * ⚠️ 每次调用都是一次全图拷贝（4K 图 33 MB）。调用方必须自己缓存。
 */
export function imagePixels(entry: ImageEntry): Uint8ClampedArray | null {
  const src = entry.source as unknown as { getContext?: (id: string) => unknown };
  try {
    const ctx = src.getContext?.('2d') as
      | OffscreenCanvasRenderingContext2D
      | CanvasRenderingContext2D
      | null
      | undefined;
    if (!ctx) return null;
    const data = ctx.getImageData(0, 0, entry.w, entry.h);
    return data.data;
  } catch {
    return null;
  }
}

export function forgetImage(assetId: string): void {
  images.delete(assetId);
}

/* ------------------------------------------------------------------ 视频 */

/**
 * 登记一份视频素材的**载体**。不解码、不读字节 —— 见文件头。
 *
 * 本地导入请传 `File`（磁盘背书，零内存）；只有从工程目录读回来的字节
 * 才传 `Uint8Array`。
 */
export function registerVideoMedia(assetId: string, media: VideoMedia): void {
  videoMedia.set(assetId, media);
  notify();
}

export function videoMediaFor(assetId: string): VideoMedia | null {
  return videoMedia.get(assetId) ?? null;
}

export function forgetVideo(assetId: string): void {
  videoMedia.delete(assetId);
}

/* ------------------------------------------------------------------ 通用 */

export function forgetMedia(assetId: string): void {
  forgetImage(assetId);
  forgetVideo(assetId);
}

/** 测试用：清空全部登记（避免用例之间互相污染）。 */
export function clearMediaAssets(): void {
  for (const id of [...images.keys()]) forgetImage(id);
  videoMedia.clear();
}
