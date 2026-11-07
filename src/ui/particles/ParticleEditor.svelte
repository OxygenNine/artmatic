<script lang="ts">
  /**
   * ParticleEditor — 粒子全屏工程视图的根。
   *
   * ⚠️ **这里不渲染 `<Preview />`**。预览是 `App.svelte` 的 `.stage` 里那一块，
   * 三个工程视图共用；粒子页只是给 `.body` 换一个 `is-particles` 的网格，
   * 把左右两列换成本组件。卸载 `<Preview>` 会丢 WebGL 上下文，
   * 而上下文丢了不是重新 mount 能恢复的。
   *
   * 本组件输出**两个根 aside**（左列参数 / 右栏预设与状态），它们是 `.body`
   * 网格的直接子项；中列留给 `.stage`（画面常驻 + 工具条里的 `Scrubber`）。
   *
   * ⚠️ `.body.is-particles` 必须显式给行 + 三个子项都 `grid-row: 1`：这两个
   * aside 在 DOM 里排在 `.stage` 之前，自动排布会把舞台推到第二行（见 App.svelte）。
   */
  import ParticlePanels from './ParticlePanels.svelte';
  import ParticlePresets from './ParticlePresets.svelte';
  import ParticleStats from './ParticleStats.svelte';

  interface Props {
    clipId: string;
  }
  const { clipId }: Props = $props();

  /** 宽窗口常驻、窄窗口折成抽屉。缺省关着，画面优先。 */
  let dockOpen = $state(false);
</script>

<ParticlePanels {clipId} onToggleDock={() => (dockOpen = !dockOpen)} />

<aside class="pe-dock" class:narrow-open={dockOpen} data-testid="particle-dock">
  <ParticlePresets {clipId} />
  <ParticleStats />
</aside>

<style>
  .pe-dock {
    grid-column: 3;
    display: flex;
    flex-direction: column;
    min-height: 0;
    min-width: 0;
    background: var(--surface-1);
    border-left: 1px solid var(--border);
    overflow-y: auto;
  }
  /* 窄窗口：右栏折进抽屉，浮在左栏之上；中列始终保持最小预览高度。 */
  @media (max-width: 1100px) {
    .pe-dock {
      display: none;
    }
    .pe-dock.narrow-open {
      display: flex;
      position: absolute;
      top: 0;
      right: 0;
      bottom: 0;
      width: 260px;
      z-index: 20;
      box-shadow: -8px 0 24px rgb(0 0 0 / 0.35);
    }
  }
</style>
