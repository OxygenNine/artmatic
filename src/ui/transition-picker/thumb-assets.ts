/**
 * thumb-assets.ts — **预先导出**的转场缩略图（静态资源）。
 *
 * 与 `ui/effect-picker/thumb-assets.ts` 是同一套机制、同一份理由（见那边头注）：
 * 选择器只贴 `<img loading="lazy">`，**零渲染开销**。图由
 * `scripts/gen-transition-thumbs.mjs` 一条命令落盘。
 *
 * 文件名 = **转场 id**（gl-transitions 的 `name`，也是工程里的 `defId`）。
 *
 * ⚠️ 这条 glob 与 `tests/unit/transition-thumb-assets.test.ts` 里的覆盖断言是**一对**：
 * 那个测试读的是同一个目录。改目录名要同时改两处。
 */

const FILES = import.meta.glob<string>('../../assets/transition-thumbnails/*.webp', {
  eager: true,
  query: '?url',
  import: 'default',
});

/** 转场 id → 资源 URL。id 就是文件名（去掉扩展名）。 */
const BY_ID: Readonly<Record<string, string>> = (() => {
  const out: Record<string, string> = {};
  for (const [path, url] of Object.entries(FILES)) {
    out[path.replace(/^.*\//, '').replace(/\.webp$/, '')] = url;
  }
  return out;
})();

/** 该转场的缩略图 URL；没有资源时返回 null（卡片显示品牌占位图）。 */
export function transitionThumbUrl(defId: string): string | null {
  return BY_ID[defId] ?? null;
}

/** 有缩略图的转场 id（测试与调试用）。 */
export function transitionThumbAssetIds(): string[] {
  return Object.keys(BY_ID);
}
