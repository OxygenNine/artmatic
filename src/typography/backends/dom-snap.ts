/**
 * backends/dom-snap.ts — snapDOM 后端。
 *
 * 与 ADR-003 的关系：
 *  - 规则 ① 字体子集化：不在这里做，由 FontProvider 在 ensure() 阶段把
 *    （子集化后的）字体字节备成 data URL，这里只负责交给 snapDOM。
 *  - 规则 ② 不用 embedFonts:false 换性能：恒为 true / 'auto'。
 *  - 规则 ③ 导出前 await document.fonts.ready：FontProvider.ensure() 内部做。
 *  - 规则 ④ 动画状态要烘焙：bakeAnimations()。
 *
 * snapDOM 3.x 的真实 API（不是文档里那版）：
 *  - `embedFonts` 是 `boolean | 'auto'`，**不是 CSS 字符串**；
 *  - 字体素材走 `localFonts: {family, src}[]`（官方注释：
 *    「Provide fonts explicitly to avoid remote discovery」）；
 *  - 输出尺寸走 `width` / `height`（绝对尺寸），`scale` 只在二者都没给时生效；
 *  - `dpr` 默认是 `devicePixelRatio` —— **不显式给 1 的话，同样的代码在
 *    2K 屏上产出两倍像素**，预览与导出对不上，而且换台机器才复现。
 */

import { snapdom } from '@zumer/snapdom';
import { animationSpecs, bakeAnimations } from '../bake-animation';
import type { FontProvider } from '../font-provider';
import { runTypoHooks } from '../hook-registry';
import { ensureDocImagesFx } from '../image-fx';
import { buildDocDom } from '../render-dom';
import { runScripts } from '../script/run';
import type { RasterRequest, TextRasterizer } from '../rasterizer';

export class DomSnapRasterizer implements TextRasterizer {
  readonly id = 'dom-snap' as const;

  /**
   * 光栅化**串行链**。
   *
   * 后端在逻辑上是无状态的（不持有缓存），但它有一份**共享可变状态：`host`**——
   * 每次 `rasterize` 都把新文档 `replaceChildren` 进去，截完再清空。而
   * `snapdom()` + `toCanvas()` 是异步的，于是**两次并发调用会互相把对方的
   * root 从文档里摘掉**：脱离文档的元素既拿不到 CSSAnimation（`bakeAnimations`
   * 失效），`getComputedStyle` 也回落到空值 —— 截出来是一张**全透明或全不透明黑**
   * 的废图，而且**不报错**。
   *
   * 后果不是「这一帧糊一下」：`TypographyRuntime` 会把废图**按正确的键**缓存下来，
   * 静态文档的键不含帧号 ⇒ 这条坏图会一直生效到被淘汰，表现成「某一层排版把
   * 下面整幅画面涂黑 / 凭空消失」，重启预览服务器只是重跑一次同样的竞态。
   *
   * 谁会并发：`rasterize` 的调用方有三处 —— rAF 预览的 `schedule`、
   * 导出的 `prewarmFrame`（`Promise.all`，天然并发）、编辑器的 `rasterizeOnce`。
   * 它们互相之间没有任何串行化，所以这条链必须放在**拥有 host 的这一层**：
   * 谁持有共享状态，谁负责保证「同一时刻只有一次截图」。
   */
  private chain: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly host: HTMLElement,
    private readonly fonts: FontProvider,
  ) {}

  isAvailable(): boolean {
    return true;
  }

  rasterize(req: RasterRequest): Promise<HTMLCanvasElement> {
    const run = this.chain.then(() => this.rasterizeOne(req));
    // 链上只关心「上一单结束了」：一单失败不能把后续全部拖死。
    this.chain = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  private async rasterizeOne(req: RasterRequest): Promise<HTMLCanvasElement> {
    /*
     * 插件渲染钩子：**只作用于本次出图**，不写 store、不进缓存键的文档哈希
     * （缓存键用源文档 + 帧号 + 模式盐，钩子是确定性的，所以同一键必然
     * 产出同一张图）。
     *
     * 必须在 buildDocDom 之前 —— 钩子返回的是一份文档，不是 DOM 补丁。
     * 失败时 `runTypoHooks` 保留原文档（见 hook-registry.ts 第 1 条纪律）。
     */
    const hooked = runTypoHooks('render', req.doc, {
      t: req.localSec,
      frame: Math.round(req.localSec * req.fps),
      fps: req.fps,
      duration: req.duration,
      seed: req.seed,
    });
    const doc = hooked.doc;

    // ADR-003 规则 ③：字体没就绪就截图，首帧会用回落字体量度。
    await this.fonts.ensure(doc);

    /*
     * 图片的抠图 / 四角是 CPU 处理的（见 typography/image-fx.ts），必须先等完。
     * 不等的话截图拿到的是**原图**，而这条产物会按正确的缓存键存下来 ——
     * 表现是「导出没抠图，而且刷新也不恢复」。
     */
    await ensureDocImagesFx(doc, req.resolveImage);

    const root = buildDocDom(doc, {
      forRaster: true,
      scriptsActive: req.scriptsActive,
      resolveImage: req.resolveImage,
      isImageOffline: req.isImageOffline,
      offlineLabel: req.offlineLabel,
      customThemes: req.customThemes,
    });
    this.host.replaceChildren(root);
    try {
      // 必须挂进文档之后才能 seek（脱离文档的元素拿不到 CSSAnimation）。
      bakeAnimations(root, animationSpecs(doc), req.localSec);
      /*
       * 脚本在烘焙之后跑：它写的是**脚本层**（动画层之内），所以能读到
       * 动画之后的最终布局，又不会把动画的 transform 顶掉。
       * 同一个函数也用于舞台 —— 两条路径的求值顺序因此不可能分家。
       */
      runScripts({
        doc,
        root,
        localSec: req.localSec,
        fps: req.fps,
        duration: req.duration,
        seed: req.seed,
        active: req.scriptsActive,
      });

      /*
       * 超采样：镜头把某一层放大 k 倍时，就按 k 倍密度截图再缩回目标尺寸
       * （`RasterRequest.density`，上限 2 由 runtime 夹好）。
       *
       * 缩放必须在这里用 canvas 做，**不能留给合成器的 LINEAR 采样**：本项目
       * 的位图是直通 alpha，透明像素的 rgb 是 0，GPU 的双线性降采样会把那些
       * 0 混进字形边缘 —— 整幅文字描一圈暗边，而画面别处都正常。
       * canvas 的 drawImage 在预乘空间做重采样，边缘是干净的。
       */
      const density = Math.max(1, Math.min(2, Number(req.density) || 1));
      const capW = Math.max(1, Math.round(req.width * density));
      const capH = Math.max(1, Math.round(req.height * density));

      // 与上面 ensure 一样，用钩子之后的文档。
      const localFonts = this.fonts.localFonts(doc);
      const result = await snapdom(root, {
        width: capW,
        height: capH,
        dpr: 1,
        // 透明底。PNG 的默认值本来就是 null，写出来是为了钉死这条约定：
        // 排版层要叠到画面上，自带不透明底会把下面的东西整个盖掉。
        backgroundColor: null,
        embedFonts: localFonts ? true : 'auto',
        localFonts,
        // 本项目零阴影；显式关掉，免得 root 的 outline / drop-shadow
        // 把捕获框撑大，导致输出尺寸与请求的 width/height 不一致。
        outerShadows: false,
        /*
         * `'soft'`（v3 的默认值）= 复用 snapDOM 的**持久 style / resource 缓存**。
         * 实测 **snap 段**减半（1920×1080：空文档 12→7.8ms、1 文本 18.2→7.3ms、
         * 3 文本 + 3 图形 29.4→17.0ms，见 `docs/typography-perf.md` §3.2），
         * 整条 `rasterize` 因此快 24–33%（同文件 §6.2）。
         *
         * 当初选 `'disabled'` 是为了躲「拿到上一帧的样式」，而这两类缓存的键
         * 决定了它们**不可能**串帧：
         *  - style（`computedStyle` / `measureHints`）是 WeakMap，键是本次
         *    `buildDocDom` 新建的元素 —— 每次捕获都是新节点，天然不命中旧值；
         *  - image / resource / background / compress 按 **URL 字符串**做键，
         *    而排版图片的 URL 由 `image-assets.ts::putImageAsset` 在换字节时
         *    `revoke` 旧的、新建一条 ⇒ 换图必然换键。
         *
         * 也就是说「换图后拿到旧图」的**前提是 URL 不变而字节变了**。今天这条
         * 不成立（图片全部是内存 objectURL），而 `tests/e2e/typography-image-fx.spec.ts`
         * 的「同一 assetId 换字节 → 必须重烘出新图」钉住了它：谁哪天把图片换成
         * 稳定的 `artmatic-asset://` URL，那条用例会红。
         *
         * 代价是缓存常驻内存（snapDOM 各表上限 50–150 条，图片表存的是 dataURL）。
         * 素材多到几百张时它会占住一份，但那是「多占内存」而不是「画错」。
         */
        cache: 'soft',
      });

      const shot = await result.toCanvas({ width: capW, height: capH, dpr: 1 });
      return density > 1 ? shrinkCanvas(shot, req.width, req.height) : shot;
    } finally {
      this.host.replaceChildren();
    }
  }

  dispose(): void {
    this.host.replaceChildren();
  }
}

/**
 * 超采样截图 → 目标尺寸（浏览器在预乘空间重采样，透明处的 rgb 不会渗到边缘）。
 *
 * `imageSmoothingQuality = 'high'` 是必要的：'low' 在 Chrome 上就是一次
 * 双线性（2× 时恰好等于 2×2 平均，勉强够用），但密度是 1.37 这种非整数时
 * 会走样 —— 而镜头缩放几乎总是非整数。
 *
 * 这张 canvas 只在这一次 `rasterize` 里活着，调用方上传完就没有引用了。
 */
function shrinkCanvas(src: HTMLCanvasElement, w: number, h: number): HTMLCanvasElement {
  const out = document.createElement('canvas');
  out.width = Math.max(1, Math.round(w));
  out.height = Math.max(1, Math.round(h));
  const ctx = out.getContext('2d');
  if (!ctx) return src;
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(src, 0, 0, out.width, out.height);
  return out;
}
