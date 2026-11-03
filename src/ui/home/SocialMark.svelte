<script lang="ts">
  /**
   * SocialMark — 首页底部那两个外链的品牌标记（GitHub 的章 / B 站的小电视）。
   *
   * ## 为什么是内联 SVG 而不是 `<img src>`
   *
   * 两个标记都只有一个颜色，而且必须**跟着链接色走**（常态 muted、hover 变成
   * primary）。`<img>` 是独立文档，`currentColor` 进不去，只能做两张图或加滤镜。
   * 内联之后上面那条 `path { fill: currentColor }` 就够了 —— GitHub 那份把颜色
   * 写在 `<g fill="#161614">` 上，B 站那份没写（默认黑），CSS 都会盖掉。
   *
   * ## 为什么不进 `icons.ts`
   *
   * 那张表只收 Lucide（ISC、统一描边语言、可 tree-shaking）。品牌标记各有各的
   * 画法，混进去会让「图标」这个概念失焦 —— 与 `assets/providers/` 里那批
   * 提供商 logo 是同一条界线。
   *
   * 版权属于各自的品牌方；这里只作为**指向其站点的链接图标**使用。
   */
  import github from '../../assets/brand/github.svg?raw';
  import bilibili from '../../assets/brand/bilibili.svg?raw';

  type SocialName = 'github' | 'bilibili';

  interface Props {
    name: SocialName;
    /** 高度（px）。宽度按原标记的比例走（GitHub 略宽于正方，B 站是正方）。 */
    size?: number;
  }
  const { name, size = 13 }: Props = $props();

  const RAW: Record<SocialName, string> = { github, bilibili };
  /*
   * 去掉 `<title>`：它会被算进链接的可见文本（无障碍名变成「Bilibili Bilibili」），
   * 鼠标悬停时还会冒出一个和旁边文字重复的原生 tooltip。标记本身有 `aria-hidden`，
   * 名字由链接里的文字给。
   */
  const markup = $derived(
    RAW[name].replace(/^<\?xml[^>]*\?>\s*/, '').replace(/<title>[\s\S]*?<\/title>/g, ''),
  );
</script>

<span class="mark" aria-hidden="true" style:height={`${size}px`}>{@html markup}</span>

<style>
  .mark {
    display: inline-flex;
    align-items: center;
    flex-shrink: 0;
  }
  /* 资源里 svg 带着 2500px 的宽高属性，这里用外层定高、宽度按比例走。 */
  .mark :global(svg) {
    display: block;
    width: auto;
    height: 100%;
  }
  .mark :global(path) {
    fill: currentColor;
  }
</style>
