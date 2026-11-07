<script lang="ts">
  /**
   * ThumbPlaceholder — 卡片没有缩略图时的默认占位图（品牌标记 + 主题色淡底）。
   *
   * 为什么不是灰色骨架条：特效 / 生成器的缩略图**大量是暗色画面**，灰条与
   * 「渲出来一张黑图」在界面上分不开 —— 用户会以为图坏了。品牌标记能直接
   * 说明「这里没有图，不是画面长这样」。
   *
   * 单色（`mono`）：占位是水印，不是第二次品牌露出 —— 与首页工程封面
   * （`ui/home/RecentTile.svelte`）同一判断。要换颜色只改 `--accent-weak`。
   *
   * **高度由容器决定**（`height: 100%`）：调用方必须给它一个 16:9 的框，
   * 否则「没有缩略图的卡片矮一截」会从占位图这里重新长出来。
   */
  import Brand from './Brand.svelte';

  interface Props {
    /** 标记高度（px）。网格卡片用 34，列表小图用 20。 */
    size?: number;
  }
  const { size = 34 }: Props = $props();
</script>

<span class="thumb-ph" data-testid="thumb-placeholder" aria-hidden="true">
  <span class="mark"><Brand variant="mark" {size} mono /></span>
</span>

<style>
  .thumb-ph {
    display: grid;
    place-items: center;
    width: 100%;
    height: 100%;
    /*
     * 品牌色的极淡填充，不是 surface 档位：surface-2 在亮色下几乎与卡片同色
     * （占位块会「消失」），而主题淡阶在四套模式里都自然带一点色相。
     */
    background: var(--accent-weak);
  }
  /* 水印强度：再亮就变成第二个 logo，再淡则读不出这里有东西。 */
  .mark {
    display: grid;
    place-items: center;
    opacity: 0.34;
  }
</style>
