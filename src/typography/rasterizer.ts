/**
 * rasterizer.ts — 光栅化后端的契约与注册表（ADR-003 的落地）。
 *
 * 后端是**无状态**的：它只管「文档 + 尺寸 + 时刻 → 一张位图」，不持有缓存。
 * 缓存（LRU、内存预算、并发去重）统一放在 runtime.ts，理由只有一个：
 * 内存上限必须由单一处说了算，否则「谁该淘汰」会变成两个模块的猜谜游戏。
 *
 * 后端优先级（ADR-003）：hic → dom-snap → canvas2d → png-import。
 * 只实现 dom-snap；其余留 stub（isAvailable() 返回 false）。
 * hic 的位置尤其要留：snapDOM 3.x 自己就有 `engine: 'html-in-canvas'`，
 * 等它的上传路径在这个 Electron 版本上通了，dom-snap 后端内部换一行即可。
 */

import type { TypographyDocument } from './document';
import type { TypographyTheme } from './theme';
import { DomSnapRasterizer } from './backends/dom-snap';
import type { FontProvider } from './font-provider';

export type RasterBackendId = 'hic' | 'dom-snap' | 'canvas2d' | 'png-import';

export interface RasterRequest {
  doc: TypographyDocument;
  /** 输出位图的像素尺寸（**最终尺寸**，密度已经烘进后端内部）。 */
  width: number;
  height: number;
  /**
   * 超采样密度（1..2，见 `runtime.ts::densityFor`）。
   *
   * 后端按 `width × density` 截图，再用 canvas 缩回 `width × height`：
   * 镜头把某层放大时，这一层才拿得到超过输出分辨率的细节。
   * **不能用 GPU 的双线性采样来代替这一次缩放** —— 直通 alpha 的位图被
   * 降采样时，透明像素的 rgb 是 0，会在字形边缘糊出一圈暗边。
   */
  density?: number;
  /** 片段内本地时间（秒）。静态文档传 0。 */
  localSec: number;
  /**
   * 工程 fps / 片段时长 / 工程种子 —— 脚本的 `ctx.frame`、`ctx.duration`、
   * `ctx.rand` 全部由它们派生。**必须与预览同源**：`TypographyRuntime`
   * 从 store 读，光栅化后端不自己猜。
   */
  fps: number;
  duration: number;
  seed: number;
  /**
   * 脚本总开关。false = 一条脚本都不执行（画面按文档原样渲染），
   * 并且缓存键走静态模式（见 `cache-key.ts` 的模式盐）。
   */
  scriptsActive: boolean;
  /** 图片素材 → URL。 */
  resolveImage?: (assetId: string) => string | null;
  /** 图片素材是不是「脱机」的（引用不存在）→ 画面给占位符。 */
  isImageOffline?: (assetId: string) => boolean;
  /** 占位符文字（「脱机媒体」）。空 = 只画图标。 */
  offlineLabel?: string;
  /** 工程自定义配色方案（`@slot` 引用可能指向它们）。 */
  customThemes?: readonly TypographyTheme[];
}

export interface TextRasterizer {
  readonly id: RasterBackendId;
  isAvailable(): boolean;
  /** **必须确定**：同参数同结果。预览与导出都走它。 */
  rasterize(req: RasterRequest): Promise<HTMLCanvasElement>;
  dispose(): void;
}

export interface TextBackendRegistry {
  /** 按优先级取第一个可用的后端。 */
  pick(): TextRasterizer;
  byId(id: RasterBackendId): TextRasterizer | null;
  dispose(): void;
}

/**
 * 离屏挂载容器。
 *
 * **不能用 visibility:hidden / display:none / opacity:0** —— 它们会被
 * getComputedStyle 继承下去，光栅化出来的是一张空图（而且不报任何错）。
 * 挪到视口外就够：布局与计算样式全部照常，只是不会被用户看到。
 */
export function createOffscreenHost(): HTMLElement {
  const host = document.createElement('div');
  host.setAttribute('data-typo-host', '1');
  host.style.cssText = [
    'position:fixed',
    'left:-200000px',
    'top:0',
    'width:0',
    'height:0',
    'overflow:visible',
    'pointer-events:none',
    'z-index:-1',
  ].join(';');
  document.body.appendChild(host);
  return host;
}

export function createTextBackendRegistry(
  host: HTMLElement,
  fonts: FontProvider,
): TextBackendRegistry {
  const domSnap = new DomSnapRasterizer(host, fonts);
  const backends: TextRasterizer[] = [domSnap];

  return {
    pick(): TextRasterizer {
      const found = backends.find((b) => b.isAvailable());
      if (!found) throw new Error('没有可用的排版光栅化后端');
      return found;
    },
    byId(id: RasterBackendId): TextRasterizer | null {
      return backends.find((b) => b.id === id) ?? null;
    },
    dispose(): void {
      for (const b of backends) b.dispose();
      host.remove();
    },
  };
}
