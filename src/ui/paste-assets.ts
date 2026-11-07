/**
 * paste-assets.ts — 剪贴板素材的三个落点。
 *
 * | 落点 | 什么时候 | 做什么 |
 * |---|---|---|
 * | 播放头 | 时间轴视图弹的 modal 里选「放到播放头」 | 导入 + 建片段 + 选中 |
 * | 媒体池 | 「仅加入媒体池」，以及排版页里的视频/音频 | 只登记素材 |
 * | 画布 | 排版视图里粘贴图片 | 置入画布中心 |
 *
 * 素材登记那一半全在 `media-import.ts`，建片段那一半全在
 * `media-pool.ts::insertAssetClip` —— 这里只做「去哪」的决策，一行登记逻辑都不重写。
 *
 * 提取（剪贴板 → `File[]`）在 `clipboard-assets.ts`（纯函数，有单测）；
 * 这里之所以能 import `appState`，是因为它只在真正的用户动作里被调用。
 */

import { snapTimeWithSections } from '../core/sections';
import { appState } from './app-state.svelte';
import { clipboardAssetName, type ClipboardAsset } from './clipboard-assets';
import { importFiles } from './media-import';
import { createTypographyActions } from './typography/actions';
import { editorState } from './typography/editor-state.svelte';
import { tr } from '../i18n/index.svelte';

/**
 * 新片段的落轨偏好：与媒体池的「插入」同一条 —— 用户此刻在编辑哪条轨，
 * 素材就落在哪条轨上。没有主选中片段时给 `null`（`insertAssetClip` 自己
 * 找一条装得下的，一条都没有时会补一条 —— 与「插入」共用同一处兜底）。
 */
function preferredTrackId(): string | null {
  const id = appState.selectedClipId;
  return id ? (appState.store.findClip(id)?.track.id ?? null) : null;
}

/** 落点一：放到播放头。返回成功导入的条数。 */
export function placeAssetsAtPlayhead(assets: readonly ClipboardAsset[]): Promise<number> {
  const grid = appState.store.project.beatGrid;
  return importFiles(
    assets.map((a) => a.file),
    // 落点吸附与媒体池双击插入同源：看见的位置就是会落下的位置。
    {
      start: snapTimeWithSections(
        appState.playT,
        appState.snap,
        grid,
        appState.store.project.sections,
        appState.store.project.fps,
        appState.store.project.beatMarks,
      ),
      trackId: preferredTrackId(),
    },
  );
}

/**
 * 落点二：只登记素材（与「从系统拖文件到媒体池」同一条路）。
 *
 * 收尾时**报一句**：抽屉此刻多半没开着，不 flash 的话「仅加入媒体池」
 * 看起来像是什么都没发生。
 */
export async function addAssetsToPool(assets: readonly ClipboardAsset[]): Promise<number> {
  const n = await importFiles(assets.map((a) => a.file));
  if (n) appState.flash(tr('pool.pastedToPool', { n }), 'info');
  return n;
}

/**
 * 落点三：排版编辑器。
 *
 * 图片直接置入画布中心；多张按**阶梯错开**一点 —— 全都叠在正中心的话
 * 画面上只看得到最后一张，用户会以为只粘进来一张。
 * 视频 / 音频进媒体池并说一声：排版文档里没有它们的表达形式。
 */
export async function pasteAssetsIntoTypography(assets: readonly ClipboardAsset[]): Promise<void> {
  /*
   * 文档解不出来（编辑器正在被关掉之类）时**整批进池子**：半登记
   * （素材进了册、元素没建成）比「什么都没发生」更坏 —— 用户会看见池子里
   * 多了一条，却找不到它出现在画布上。
   */
  const size = editorState.doc?.size ?? null;
  if (!size) {
    await addAssetsToPool(assets);
    return;
  }

  const images = assets.filter((a) => a.kind === 'image');
  const others = assets.filter((a) => a.kind !== 'image');

  if (images.length) {
    const actions = createTypographyActions();
    // 阶梯步长取文档短边的 2%：分辨率无关，且大图小图都看得出是「错开的」。
    const step = Math.max(12, Math.round(Math.min(size.w, size.h) * 0.02));
    let i = 0;
    for (const a of images) {
      const center = { x: size.w / 2 + i * step, y: size.h / 2 + i * step };
      const id = await actions.placeImageBytes(
        clipboardAssetName(a),
        await a.file.arrayBuffer(),
        center,
      );
      if (id) i += 1;
    }
  }

  // 视频 / 音频进池子（回执由 addAssetsToPool 给）。
  if (others.length) await addAssetsToPool(others);
}
