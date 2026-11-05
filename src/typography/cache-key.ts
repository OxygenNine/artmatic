/**
 * cache-key.ts — 光栅化缓存的键（纯函数，不碰 DOM）。
 *
 * 三条设计约束：
 *  1. **只哈希文档本身**，不掺 store 的全局 version。否则改一下无关片段的名字
 *     就会把所有排版层的缓存全部击穿，等于没有缓存。
 *  2. **静态文档不带帧号**。绝大多数标题卡没有动画，整个片段生命期只该光栅化
 *     一次；带上帧号会让它每帧重做一遍。
 *  3. **只哈希「决定像素」的东西**。`doc.camera` 与元素的 `depth` 因此不进
 *     `docHash`，它们的**生效结果**由 `parallaxSignature` 表达（见下）——
 *     否则「镜头开着但没有一个元素吃它」也会把每一层都重烘一遍。
 */

import type { TypographyDocument } from './document';
import { docIsAnimated } from './animation';
import { parallaxSignature } from './camera';

/**
 * 稳定 JSON：对象键排序后再序列化。
 *
 * 为什么要自己写：`JSON.stringify` 按插入顺序输出键，而 `{a:1,b:2}` 与
 * `{b:2,a:1}` 是同一个文档但会产出不同的字符串 —— 缓存会莫名其妙地不命中。
 */
export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;

  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  const parts: string[] = [];
  for (const k of keys) {
    const v = obj[k];
    if (v === undefined) continue;
    parts.push(`${JSON.stringify(k)}:${stableStringify(v)}`);
  }
  return `{${parts.join(',')}}`;
}

/** FNV-1a 32 位。够用：这里的碰撞后果只是缓存错命中，不是安全问题。 */
export function fnv1a(s: string, seed = 0x811c9dc5): string {
  let h = seed;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}

/**
 * 哈希输入：去掉 `camera` 与每个元素的 `depth`。
 *
 * 这两项不直接决定像素 —— 决定像素的是「元素实际吃到的视差变换」，那就是
 * `parallaxSignature`。分开的收益是可观的：镜头开着而所有 depth 都是 0 时，
 * 拖 zoom 滑杆不会击穿任何一层的缓存（画面本来就一像素不变）。
 *
 * 没有镜头时走快路径直接返回原对象：那是绝大多数文档，不该为这条优化
 * 每帧复制一遍文档。
 */
function hashableDoc(doc: TypographyDocument): unknown {
  const hasCamera = doc.camera !== undefined;
  const hasDepth = doc.elements.some((e) => e.depth !== undefined);
  /*
   * 空轨道也不进哈希。面板上镜头的四条属性**常驻**显示，删光关键帧之后会留下
   * 一条空轨道 —— 它不影响任何像素，不该让缓存键与「从来没建过这条轨道」分家。
   * 有帧的轨道反过来必须进哈希：它决定每一帧画什么。
   */
  const tracks = (doc.animations ?? []).filter((a) => a.keys.length > 0);
  const tracksDiffer = tracks.length !== (doc.animations ?? []).length;
  if (!hasCamera && !hasDepth && !tracksDiffer) return doc;
  const { camera, animations, ...rest } = doc;
  return {
    ...rest,
    ...(tracks.length ? { animations: tracks } : {}),
    elements: doc.elements.map(({ depth, ...el }) => el),
  };
}

/** 文档内容哈希（见 `hashableDoc`：不含相机 / 深度）。 */
export function docHash(doc: TypographyDocument): string {
  return fnv1a(stableStringify(hashableDoc(doc)));
}

export interface RasterKeyInput {
  docHash: string;
  /** 目标位图像素宽（已含 previewScale）。 */
  w: number;
  /** 目标位图像素高。 */
  h: number;
  /** 静态文档传 null；动画文档传片段内帧号。 */
  frame: number | null;
  /**
   * 模式盐：脚本总开关 / 插件渲染钩子是否参与。
   *
   * 同一份文档在「脚本关」下烘出来的图与「脚本开」下完全不同，而两者的
   * `docHash` 一模一样 —— 没有盐的话切换开关会直接命中旧图（表现是
   * 「打开了脚本，画面没有任何变化」）。`latest` 回退按最后一个 `|`
   * 之前的片段分组，盐放在最后不影响它。
   */
  scriptsActive?: boolean;
  hooksActive?: boolean;
  /**
   * 生效后的镜头变换摘要（`camera.ts::parallaxSignature` 的哈希）。
   *
   * 为空 = **没有任何元素吃到镜头** ⇒ 键与「没有镜头」逐字相同。
   * `docHash` 刻意不含 camera / depth，所以这一段是它们唯一的像素依据。
   */
  parallax?: string;
  /** 超采样密度（1 = 不超采样）。> 1 时同一片内容有不同的像素结果。 */
  density?: number;
}

/**
 * 模式盐：**跨帧恒定**的那部分（脚本 / 插件钩子开关）。
 *
 * 它留在键的第 4 段，因为 `runtime.ts::sizeKeyOf` 拿 `docHash|WxH|frame|盐`
 * 的前四段当「缺帧回退」的桶 —— 开关变了就不能拿另一个模式的图顶上。
 */
function modeSalt(i: RasterKeyInput): string {
  return `${i.scriptsActive ? 's1' : 's0'}${i.hooksActive ? 'h1' : 'h0'}`;
}

/**
 * 逐帧盐：镜头视差 + 超采样密度。**单独成段，绝不并进模式盐。**
 *
 * 这两个量在镜头有动画时**每帧都不同**。并进第 4 段就等于每帧一个新桶：
 * `latest` 里永远没有「同一桶的上一帧」，`resolve` 的回退失效 ⇒ 播放时每帧
 * 都 miss、异步光栅化又赶不上，于是整层消失、偶尔赶上就闪一下；暂停后帧不再
 * 变化，光栅化落地，画面又正常。这正是「有镜头关键帧的排版播放时消失」的成因。
 */
function frameSalt(i: RasterKeyInput): string {
  const parallax = i.parallax ? `p${i.parallax}` : '';
  const density = i.density && i.density > 1 ? `d${Math.round(i.density * 100) / 100}` : '';
  return parallax + density;
}

export function rasterKey(i: RasterKeyInput): string {
  const base = `${i.docHash}|${i.w}x${i.h}|${i.frame ?? '-'}|${modeSalt(i)}`;
  const extra = frameSalt(i);
  return extra ? `${base}|${extra}` : base;
}

/** 由文档直接算键。 */
export function rasterKeyForDoc(
  doc: TypographyDocument,
  w: number,
  h: number,
  frame: number | null,
  mode: {
    scriptsActive?: boolean;
    hooksActive?: boolean;
    /**
     * 镜头：传 `false` 表示「这次烘的是舞台预览，不应用镜头」。
     * 缺省 / `true` = 按文档里的 camera 算（预览与导出必须同源）。
     */
    camera?: boolean;
    /** 超采样密度（`runtime.ts` 按机器上限夹过）。 */
    density?: number;
  } = {},
): string {
  const signature = mode.camera === false ? '' : parallaxSignature(doc);
  return rasterKey({
    docHash: docHash(doc),
    w,
    h,
    frame,
    scriptsActive: mode.scriptsActive,
    hooksActive: mode.hooksActive,
    ...(signature ? { parallax: fnv1a(signature) } : {}),
    ...(mode.density && mode.density > 1 ? { density: mode.density } : {}),
  });
}

/**
 * 该文档此刻应当用哪个帧号进缓存键。
 * 静态文档返回 null → 尺寸相同就永远命中同一条缓存。
 *
 * 插件渲染钩子会让**每一帧的文档都可能不同**，所以它同样按动画文档处理
 * （否则逐帧改写的文档会被静态键缓存住，画面停在第一次烘出来的那张）。
 *
 * 镜头**不**让静态文档变成动画：镜头是静态构图参数（今天只能整体设一次），
 * 同一 t 永远得到同一张图；把它算成逐帧会让一张标题卡白白每帧重烘。
 */
export function frameKeyFor(
  doc: TypographyDocument,
  frame: number,
  scriptsActive = false,
  hooksActive = false,
): number | null {
  return docIsAnimated(doc, scriptsActive) || hooksActive ? frame : null;
}
