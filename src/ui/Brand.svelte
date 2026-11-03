<script lang="ts">
  /**
   * Brand — logo 的唯一入口。
   *
   * `Brand.svelte` 按当前主题选一个：
   *
   *   artmatic-small-*      2×2 标记（viewBox 163×163，内容 143×163 居中）
   *   artmatic-main-*       3×3 标记（viewBox 1280×1251）
   *   artmatic-fonttype-*   字标（viewBox 1218×260）
   *
   * ⚠️ **文件名说的是「墨色」，不是「目标模式」**——这里很容易搞反：
   *   `-dark`  里的墨是 rgb(47,47,47) 深灰 → 用在**亮背景**上，即亮色主题
   *   `-light` 里的墨是 rgb(248,248,248) 近白 → 用在**暗背景**上，即暗色主题
   * 也就是 `mode === 'light'` 要取 `-dark` 文件，反之亦然。搞反的后果是 logo 整块
   * 隐形（只有那点紫色还看得见），而不是「颜色不太对」，所以别靠肉眼验收——这条
   * 有 E2E 断言兜着（tests/e2e/brand.spec.ts）。
   *
   * 为什么必须内联而不是 `<img src>`：`<img>` 是独立文档，页面 CSS 进不去，主题切换
   * 只能靠换文件；内联后品牌紫还能跟着 `--accent` 走（见下面 prepare 里的替换）。
   */
  import smallLight from '../assets/brand/artmatic-small-light.svg?raw';
  import smallDark from '../assets/brand/artmatic-small-dark.svg?raw';
  import mainLight from '../assets/brand/artmatic-main-light.svg?raw';
  import mainDark from '../assets/brand/artmatic-main-dark.svg?raw';
  import wordLight from '../assets/brand/artmatic-fonttype-light.svg?raw';
  import wordDark from '../assets/brand/artmatic-fonttype-dark.svg?raw';
  import { theme } from './theme.svelte';

  type Variant = 'mark' | 'word';

  interface Props {
    variant?: Variant;
    /** 高度（px）。宽度按 viewBox 比例走。 */
    size?: number;
    /** mark 变体在多高以上用 3×3 的大标记。20px 的位子放 3×3 会糊成一团。 */
    largeFrom?: number;
    /**
     * 单色：品牌紫也换成同一份资源里的墨色，整枚标记只剩一种颜色。
     *
     * 用在哪：工程封面**没有缩略图**时的占位图（`ui/home/RecentTile.svelte`）。
     * 那里旁边就是首页的大 logo，同尺寸下那颗紫三角会把视线拽过去 ——
     * 占位图应该是一枚水印，不是第二个品牌露出。
     */
    mono?: boolean;
  }
  const { variant = 'mark', size = 20, largeFrom = 44, mono = false }: Props = $props();

  const SOURCES = {
    mark: { small: { light: smallDark, dark: smallLight }, large: { light: mainDark, dark: mainLight } },
    word: { light: wordDark, dark: wordLight },
  } as const;

  /** 两份资源各自的墨色（`fill:rgb(47,47,47)` / `fill:rgb(248,248,248)`）。 */
  const INK = { light: 'rgb(47, 47, 47)', dark: 'rgb(248, 248, 248)' } as const;

  /**
   * 把品牌紫换成目标色：默认 `var(--accent)`，好让标记跟着主题色走；
   * `mono` 时换成墨色（单一颜色）。墨色本身（rgb(47,47,47) / rgb(248,248,248)）
   * **保持资源里的原值** —— 那正是成对导出的意义所在，不用 currentColor 覆盖。
   */
  const prepare = (raw: string, accent: string): string =>
    raw
      .replace(/^<\?xml[^>]*\?>\s*/, '')
      .replace(/^<!DOCTYPE[^>]*>\s*/i, '')
      .replace(/fill:rgb\(111,\s*100,\s*239\)/g, `fill:${accent}`);

  /**
   * 取哪份资源按**族**判（`theme.family`），不是按 mode：灰色模式与高对比度
   * 都是深底，一样要 `-light`（近白墨）那份。加模式时这里不需要改。
   */
  const src = $derived(
    variant === 'word'
      ? SOURCES.word[theme.family]
      : size >= largeFrom
        ? SOURCES.mark.large[theme.family]
        : SOURCES.mark.small[theme.family],
  );
  const markup = $derived(prepare(src, mono ? INK[theme.family] : 'var(--accent)'));
</script>

<span class="brand" data-variant={variant} role="img" aria-label="Artmatic" style:height={`${size}px`}>
  <!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
  {@html markup}
</span>

<style>
  .brand {
    display: inline-flex;
    align-items: center;
    flex-shrink: 0;
  }
  /* 资源里 svg 是 width/height=100%，这里用外层定高、宽度按 viewBox 比例走 */
  .brand :global(svg) {
    height: 100%;
    width: auto;
    display: block;
  }
</style>
