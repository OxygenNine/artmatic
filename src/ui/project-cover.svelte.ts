/**
 * project-cover.svelte.ts — 工程封面（首页「最近的工程」那张缩略图）。
 *
 * ## 为什么不是另渲一帧
 *
 * 封面要的是「这份工程现在长什么样」，而预览画布上**就是**那一帧
 * （`Kit` 的上下文带 `preserveDrawingBuffer`，`toBlob` 读到的不是空缓冲）。
 * 为了它去走 `withExportFrame` 会让每次保存都钉一次工程分辨率、进一次导出模式、
 * 预热一遍字体 —— 那是几百毫秒到几秒的事，而缩略图只是首页上 200px 宽的一格。
 * 所以这里只做：取预览画布 → 缩到长边 640 → WebP。
 *
 * ## 两份落点，用途不同
 *
 * | 落点 | 谁在什么时候读 | 为什么需要 |
 * |---|---|---|
 * | `<工程>/thumbs/cover.webp` | 下次打开工程时补缓存 | 跟工程目录走：拷到另一台机器也还在 |
 * | IndexedDB `covers`（`project/handles.ts`） | 首页 | 首页**不能**碰目录句柄：新会话权限是 `prompt`，读一张图不该弹系统授权框 |
 *
 * 磁盘那份只在**手动保存**时写；自动保存只刷缓存（每两秒往工程目录写一遍图
 * 是没必要的磁盘抖动）。两处都失败也只是「没有封面」，回落到纯色 + logo，
 * 绝不挡住保存 —— 与 `handles.ts` 的「存储层问题一律降级」同一条口径。
 */

import { appState, type OpenProject } from './app-state.svelte';
import {
  coverThumbSegments,
  THUMBS_DIR,
} from '../project/layout';
import { resolveDir, writeBytesAtomic, type FsDirHandle } from '../project/fs';
import { getCover, putCover } from '../project/handles';

/** 封面长边。卡片显示宽 ~200 CSS px，2× 屏上有 640 已经过剩。 */
const COVER_LONG_EDGE = 640;

/** 自动保存的抓帧节流：它每两秒触发一次，没必要每次重编码一张图。 */
export const AUTOSAVE_GAP_MS = 2500;

/** key → objectURL。Svelte 的 `$state` 对象，首页读它就自动重建。 */
export const covers = $state<Record<string, string>>({});

/** 上一次真正抓帧的时刻（模块级即可：这是节流，不是工程状态）。 */
let lastCaptureAt = 0;

/* ------------------------------------------------------------ 读取 */

/** 某个工程现有的封面 URL（没有则 null）。 */
export function coverOf(key: string | null | undefined): string | null {
  if (!key) return null;
  return covers[key] ?? null;
}

/**
 * 把一批最近工程的封面读进内存。
 *
 * 幂等：已经有了的跳过（否则每次列表变化都会重新 createObjectURL，
 * `<img>` 随之闪一下）。读不到就是没有 —— 调用方回落到纯色底。
 */
export async function loadCovers(keys: readonly string[]): Promise<void> {
  const missing = keys.filter((k) => !!k && !covers[k]);
  if (!missing.length) return;
  const found = await Promise.all(
    missing.map(async (key) => ({ key, blob: await getCover(key) })),
  );
  for (const { key, blob } of found) {
    if (blob) setCover(key, blob);
  }
}

/* ------------------------------------------------------------ 写入 */

/**
 * 保存之后刷新封面。**调用方不需要 await** —— 它不影响保存结果。
 *
 * @param p 刚保存完的那份工程（必须是前台那份，否则画布上是别人的画面）。
 * @param dir 有目录就顺手写一份进 `thumbs/`。
 * @param opts.writeFile 手动保存传 true（自动保存只刷缓存，不碰磁盘）。
 * @param opts.throttleMs 两次抓帧的最小间隔。手动保存传 0 ——「我现在按了保存」
 *        就应该真的更新，被上一次自动保存节流掉是最难解释的一类行为。
 */
export async function refreshProjectCover(
  p: OpenProject,
  dir: FsDirHandle | null,
  opts: { writeFile?: boolean; throttleMs?: number } = {},
): Promise<void> {
  const key = p.key;
  if (!key) return;
  // 后台工程保存完成时，画布上是**当前前台那份**的画面 —— 抓下来会张冠李戴。
  if (p.id !== appState.activeProjectId) return;

  const now = Date.now();
  if (now - lastCaptureAt < (opts.throttleMs ?? 0)) return;

  const canvas = appState.renderer?.kit.canvas;
  const blob = canvas ? await capture(canvas) : null;
  if (!blob) return;
  lastCaptureAt = now;

  // 缓存先写：首页能不能看见封面只取决于它。
  if (await putCover(key, blob)) setCover(key, blob);

  /*
   * 写盘前**再确认这份工程还在**：抓帧到编码之间隔着几十毫秒，用户完全可能在这段
   * 时间里把它关掉甚至删掉（右键菜单的「删除工程」）。不查的话，一次已经没人要的
   * 封面写入会把刚删干净的目录重新建出一个 `thumbs/` —— 目录删不掉、还留下垃圾。
   */
  if (!opts.writeFile || !dir) return;
  if (!appState.projects.some((x) => x.id === p.id)) return;
  await writeCoverFile(dir, blob);
}

/**
 * 工程刚打开时，磁盘上可能有一张上次保存留下的封面，而 IndexedDB 里没有
 * （新机器 / 换了浏览器配置 / 清了站点数据）。这时顺手补一次缓存。
 *
 * 只在 `openAt` 里调用：那一刻刚申请过 readwrite 权限，读文件不会再弹框。
 */
export async function adoptCoverFromDir(dir: FsDirHandle, key: string): Promise<void> {
  if (covers[key]) return;
  try {
    const segs = coverThumbSegments();
    const name = segs.pop();
    if (!name) return;
    const thumbs = await resolveDir(dir, segs, false);
    const fh = await thumbs.openFile(name, { create: false });
    const bytes = await (await fh.get()).readBytes();
    if (!bytes.byteLength) return;
    // 复制一份自己的 ArrayBuffer：`readBytes()` 给的视图可能是 SharedArrayBuffer 底层，
    // 直接当 `BlobPart` 在类型上就不成立。
    const buf = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
    const blob = new Blob([buf], { type: 'image/webp' });
    if (await putCover(key, blob)) setCover(key, blob);
  } catch {
    /* 没有封面是常态（首次打开、旧版本保存的工程）。静默跳过。 */
  }
}

/* ------------------------------------------------------------ 内部 */

function setCover(key: string, blob: Blob): void {
  const prev = covers[key];
  const url = URL.createObjectURL(blob);
  covers[key] = url;
  // 旧 URL 必须回收：一次会话里同一份工程会被保存很多次。
  if (prev) URL.revokeObjectURL(prev);
}

/**
 * 预览画布 → 缩略图 Blob。
 *
 * 保留源宽高比：9:16 的工程存成竖图，卡片那边靠 `object-fit: cover` 裁 ——
 * 硬拉成 16:9 会把竖屏画面压扁，而改工程比例之后封面又会「变形得莫名其妙」。
 */
async function capture(source: HTMLCanvasElement): Promise<Blob | null> {
  const sw = source.width;
  const sh = source.height;
  // 窗口最小化 / 还没排过版时画布是 0×0：抓下来是一张空图，宁可没有封面。
  if (sw < 8 || sh < 8) return null;

  const scale = Math.min(1, COVER_LONG_EDGE / Math.max(sw, sh));
  const w = Math.max(2, Math.round(sw * scale));
  const h = Math.max(2, Math.round(sh * scale));

  const out = document.createElement('canvas');
  out.width = w;
  out.height = h;
  const ctx = out.getContext('2d');
  if (!ctx) return null;
  // WebGL 画布直接 drawImage 即可：翻转由浏览器按 canvas 语义处理。
  ctx.drawImage(source, 0, 0, w, h);
  return await new Promise<Blob | null>((resolve) => out.toBlob(resolve, 'image/webp', 0.86));
}

async function writeCoverFile(dir: FsDirHandle, blob: Blob): Promise<void> {
  try {
    const segs = coverThumbSegments();
    const name = segs.pop();
    if (!name) return;
    const thumbs = await resolveDir(dir, [THUMBS_DIR], true);
    const bytes = new Uint8Array(await blob.arrayBuffer());
    await writeBytesAtomic(thumbs, name, bytes, { verify: false });
  } catch {
    /* 磁盘写失败只意味着「搬到别的机器上没有封面」，不影响本次保存 */
  }
}
