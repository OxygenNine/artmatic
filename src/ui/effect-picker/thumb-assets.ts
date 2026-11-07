/**
 * thumb-assets.ts — **预先导出**的特效缩略图（静态资源）。
 *
 * ## 为什么不再现渲
 *
 * 第一版是开选择器时用离屏 render-core 现渲七十多张：要临时编七十多个着色器，
 * 实测会让帧数从 240 掉到 190。而且有些底图自动选得不够准，现渲也没法人工过一遍。
 * 现在改成预先导出的静态图 —— 选择器只是贴 `<img>`，**零渲染开销**。
 *
 * ## 资源从哪来
 *
 * 试炼场的「批量导出缩略图」按目录底图逐个渲好、打成 zip（`lab/export-thumbs.ts`），
 * 解压进 `src/assets/effect-thumbnails/`。文件名就是特效 id。
 * 重做一遍的完整流程见 AGENTS §5.5。
 *
 * ## 为什么用 `import.meta.glob` 而不是手写 73 行 import
 *
 * `{ eager: true, query: '?url' }` 拿到的是**静态的 URL 表**：URL 同步可得
 * （组件里不需要「加载中」这个状态），而图片字节由浏览器按 `<img loading="lazy">`
 * 自己懒加载 —— 比手写 IntersectionObserver 更好，还少一层代码。
 *
 * ⚠️ 这条 glob 与 `effect-thumb-assets.test.ts` 里的覆盖断言是**一对**：
 * 那个测试读的是同一个目录。改目录名要同时改两处。
 */

const FILES = import.meta.glob<string>('../../assets/effect-thumbnails/*.webp', {
  eager: true,
  query: '?url',
  import: 'default',
});

/** 特效 id → 资源 URL。id 就是文件名（去掉扩展名）。 */
const BY_ID: Readonly<Record<string, string>> = (() => {
  const out: Record<string, string> = {};
  for (const [path, url] of Object.entries(FILES)) {
    out[path.replace(/^.*\//, '').replace(/\.webp$/, '')] = url;
  }
  return out;
})();

/** 该特效的缩略图 URL；没有资源时返回 null（卡片显示品牌占位图）。 */
export function thumbUrl(defId: string): string | null {
  return BY_ID[defId] ?? null;
}

/** 有缩略图的特效 id（测试与调试用）。 */
export function thumbAssetIds(): string[] {
  return Object.keys(BY_ID);
}
