/**
 * algo-thumb-assets.ts — **预先导出**的算法生成器预览缩略图（静态资源）。
 *
 * ## 资源从哪来
 *
 * `node scripts/gen-algo-thumbs.mjs`：build → preview → 逐个生成器渲一张
 * 640×360 的 WebP 写进 `src/assets/algo-thumbnails/`。文件名就是生成器 id。
 * 采样时刻由 `algos/catalog.ts` 的配方给（元胞自动机之类在第 0 秒是空屏）。
 *
 * ## 为什么不现场渲
 *
 * 与特效缩略图同一条理由：现渲要给每个生成器起一次离屏合成，菜单一打开
 * 就是一次几百毫秒的卡顿。静态图是贴一个 `<img>`，零开销。
 *
 * ⚠️ 这条 glob 与 `tests/unit/algo-thumb-assets.test.ts` 里的覆盖断言是**一对**：
 * 那个测试读的是同一个目录。改目录名要同时改两处。
 */

const FILES = import.meta.glob<string>('../assets/algo-thumbnails/*.webp', {
  eager: true,
  query: '?url',
  import: 'default',
});

/** 生成器 id → 资源 URL。id 就是文件名（去掉扩展名）。 */
const BY_ID: Readonly<Record<string, string>> = (() => {
  const out: Record<string, string> = {};
  for (const [path, url] of Object.entries(FILES)) {
    out[path.replace(/^.*\//, '').replace(/\.webp$/, '')] = url;
  }
  return out;
})();

/**
 * 该生成器的预览图 URL；没有资源时返回 `null`。
 *
 * 两处调用方的退化行为不同：选择器卡片显示**品牌占位图**（`ui/ThumbPlaceholder.svelte`），
 * 时间轴菜单则是**不显示悬停浮层**（浮层里只有一张图 + 一句话，占位图在那里没有信息量）。
 */
export function algoThumbUrl(defId: string): string | null {
  return BY_ID[defId] ?? null;
}

/** 有预览图的生成器 id（测试与调试用）。 */
export function algoThumbAssetIds(): string[] {
  return Object.keys(BY_ID);
}
