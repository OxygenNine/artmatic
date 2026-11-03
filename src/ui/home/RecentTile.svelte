<script lang="ts">
  /**
   * RecentTile — 首页「最近的工程」里的一张封面卡。
   *
   * ## 3D 倾斜为什么在这里是合规的
   *
   * `ui/AGENTS.md` 的动效纪律只允许 opacity / 颜色 / ≤2px 位移，那是给**编辑器面板**
   * 定的：每帧都在出画面，界面再动一下就是干扰。首页没有画面要出，它是「东西摆在哪」
   * 的那张桌子，所以这里刻意做得有手感 —— 指针位置驱动一点透视旋转 + 一层跟着走的
   * 高光，离开时回正。
   *
   * 三条边界照旧：关掉动效偏好（`theme.motionEnabled`）或系统 `prefers-reduced-motion`
   * 时**完全不动**；旋转只作用在封面上（标题文字跟着转会糊）；位移量小到不改变命中区。
   *
   * ## 没有封面时
   *
   * 纯色底 + 品牌标记。**不要**去猜「随机色」或放一张生成图：投影里那张工程可能
   * 是一份空白工程，一张假画面会让人以为打开就能看到它。
   */
  import Brand from '../Brand.svelte';
  import { theme } from '../theme.svelte';

  interface Props {
    name: string;
    /** 已经本地化好的「3 天前」。 */
    time: string;
    /** objectURL；null = 还没有封面。 */
    cover: string | null;
    /** 入场动画的错峰序号。 */
    index: number;
    disabled: boolean;
    onopen: () => void;
    /** 右键：调用方负责弹菜单（位置取事件坐标）。 */
    onmenu: (e: MouseEvent) => void;
  }
  const { name, time, cover, index, disabled, onopen, onmenu }: Props = $props();

  /** 倾斜角（度）与高光位置（%）。 */
  let rx = $state(0);
  let ry = $state(0);
  let glowX = $state(50);
  let glowY = $state(40);
  let hovered = $state(false);

  /** 偏好关掉动效时连 hover 的位移也不做（不是「慢一点」，是「不动」）。 */
  const canTilt = $derived(theme.motionEnabled);

  function move(e: PointerEvent): void {
    hovered = true;
    if (!canTilt) return;
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
    if (!r.width || !r.height) return;
    // -0.5..0.5。旋转量取 7°/6°：再大就不是「微弱」，而像在翻卡片。
    const nx = (e.clientX - r.left) / r.width - 0.5;
    const ny = (e.clientY - r.top) / r.height - 0.5;
    ry = nx * 14;
    rx = -ny * 11;
    glowX = (nx + 0.5) * 100;
    glowY = (ny + 0.5) * 100;
  }

  function reset(): void {
    hovered = false;
    rx = 0;
    ry = 0;
    glowX = 50;
    glowY = 40;
  }

  const shotTransform = $derived(
    canTilt && hovered
      ? `perspective(820px) rotateX(${rx.toFixed(2)}deg) rotateY(${ry.toFixed(2)}deg) scale(1.015)`
      : 'perspective(820px)',
  );
</script>

<button
  type="button"
  class="tile"
  class:hovered
  data-testid="recent-tile"
  {disabled}
  style:--tile-delay={`${index * 70}ms`}
  onclick={onopen}
  oncontextmenu={onmenu}
  onpointermove={move}
  onpointerleave={reset}
  onpointerenter={() => (hovered = true)}
  onblur={reset}
>
  <span
    class="shot"
    data-empty={cover ? undefined : 'true'}
    style:transform={shotTransform}
    style:background-image={cover ? `url("${cover}")` : null}
  >
    {#if !cover}
      <!-- 单色：旁边就是首页那颗大 logo，占位图里再出一块品牌紫会跟它抢视线。 -->
      <span class="fallback"><Brand variant="mark" size={40} mono /></span>
    {/if}
    <span
      class="glow"
      aria-hidden="true"
      style:--glow-x={`${glowX}%`}
      style:--glow-y={`${glowY}%`}
    ></span>
  </span>

  <span class="cap">
    <span class="nm">{name}</span>
    <span class="tm">{time}</span>
  </span>
</button>

<style>
  .tile {
    display: flex;
    flex-direction: column;
    gap: var(--sp-4);
    min-width: 0;
    padding: 0;
    background: none;
    border: none;
    border-radius: var(--radius-md);
    text-align: left;
    cursor: pointer;
    animation: tile-in 420ms var(--motion-ease) backwards;
    animation-delay: var(--tile-delay);
  }
  .tile:hover {
    background-color: transparent;
  }
  .tile:disabled {
    opacity: 0.55;
    cursor: default;
  }

  .shot {
    position: relative;
    display: grid;
    place-items: center;
    width: 100%;
    aspect-ratio: 16 / 9;
    overflow: hidden;
    background-color: var(--surface-2);
    background-position: center;
    background-size: cover;
    border: 1px solid var(--border);
    border-radius: var(--radius-md);
    /* 只过渡 transform 与描边：换背景图时不该有淡入（那会让「刚保存」看起来慢半拍）。 */
    transition:
      transform 220ms var(--motion-ease),
      border-color var(--motion-duration-hover) var(--motion-ease);
    will-change: transform;
  }
  .shot[data-empty] {
    /*
     * 空封面用**品牌色的极淡填充**而不是 surface 的某一档：
     * surface-2 在亮色下几乎与页面同色（卡片会「消失」），而主题色的淡阶
     * 在四套模式里都自然带一点色相 —— 一眼能读出「这格还没有画面」，
     * 又不会像一块黑方块那样在浅色首页上抢注意力。
     */
    background-color: var(--accent-weak);
  }
  .hovered .shot {
    border-color: var(--border-strong);
  }
  /*
   * 水印强度：0.3 左右。再亮就变成「第二个 logo」，再淡则读不出这里有东西。
   * 单色（`mono`）之后整枚标记只剩下墨色，透明度是它唯一的层次。
   */
  .fallback {
    display: grid;
    place-items: center;
    opacity: 0.34;
  }
  /* 高光：只在 hover 时出现，位置跟着指针。 */
  .glow {
    position: absolute;
    inset: 0;
    opacity: 0;
    background: radial-gradient(
      150px 150px at var(--glow-x) var(--glow-y),
      color-mix(in srgb, var(--text-primary) 14%, transparent),
      transparent 70%
    );
    transition: opacity 200ms var(--motion-ease);
    pointer-events: none;
  }
  .hovered .glow {
    opacity: 1;
  }

  .cap {
    display: flex;
    align-items: baseline;
    gap: var(--sp-3);
    min-width: 0;
  }
  .nm {
    overflow: hidden;
    color: var(--text-primary);
    font-size: var(--fs-md);
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .tm {
    flex-shrink: 0;
    color: var(--text-muted);
    font-size: var(--fs-sm);
  }

  @keyframes tile-in {
    from {
      opacity: 0;
      transform: translateY(10px);
    }
    to {
      opacity: 1;
      transform: none;
    }
  }

  /* 系统偏好永远优先于应用内开关。 */
  @media (prefers-reduced-motion: reduce) {
    .tile {
      animation: none;
    }
    .shot,
    .glow {
      transition: none;
    }
  }
</style>
