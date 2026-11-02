<script lang="ts">
  /**
   * GradeRail — 调色页自己的窄侧栏（贴在大 rail 右边）。
   *
   * 五颗图标 = 调色页的五件事：对照原片、一级校色轮、曲线、示波器、查找表。
   * 后四个是**面板开关**，第一颗是渲染旁路（看原片 / 看调色）。
   *
   * 为什么不做成顶栏的按钮组：调色是一个「一直在调、一直在看」的界面，
   * 开关随手可及比视觉整齐重要；而且面板关掉之后，那一片就该让给画面 ——
   * 顶栏的位置与画面无关，放那里会让人以为按钮和面板没有关系。
   *
   * 底部是「退出调色」：页面不再是 modal，没有右上角的 × 可点，必须有一个
   * 明确出口（Esc 是同一个动作，见 App.svelte）。
   */
  import IconButton from '../controls/IconButton.svelte';
  import type { IconName } from '../icons';
  import { appState } from '../app-state.svelte';
  import { tr } from '../../i18n/index.svelte';
  import { gradePanels, type GradePanelId } from './grade-panels.svelte';

  /** 四个面板开关（顺序 = 从「整体」到「局部」：色轮 → 曲线 → 示波器 → 查找表）。 */
  const PANELS: { id: GradePanelId; icon: IconName; nameKey: Parameters<typeof tr>[0] }[] = [
    { id: 'wheels', icon: 'palette', nameKey: 'grade.colWheels' },
    { id: 'curves', icon: 'chart-line', nameKey: 'grade.colCurves' },
    { id: 'scopes', icon: 'chart-column-increasing', nameKey: 'grade.colScopes' },
    { id: 'lut', icon: 'file-video-camera', nameKey: 'grade.colLut' },
  ];
</script>

<aside class="grade-rail" data-testid="grade-rail" aria-label={tr('grade.title')}>
  <div class="gr-block">
    <IconButton
      icon={appState.gradeBypass ? 'eye-off' : 'eye'}
      label={tr(appState.gradeBypass ? 'grade.showGraded' : 'grade.showOriginal')}
      tipText={tr('grade.compareTip')}
      active={!appState.gradeBypass}
      testid="grade-ab"
      onclick={() => appState.setGradeBypass(!appState.gradeBypass)}
    />
    <div class="gr-sep" aria-hidden="true"></div>
    {#each PANELS as p (p.id)}
      <IconButton
        icon={p.icon}
        label={tr(p.nameKey)}
        tipText={tr(gradePanels.isOpen(p.id) ? 'grade.panelHide' : 'grade.panelShow')}
          active={gradePanels.isOpen(p.id)}
        testid={`grade-panel-${p.id}`}
        onclick={() => gradePanels.toggle(p.id)}
      />
    {/each}
  </div>

  <div class="gr-spacer"></div>

  <div class="gr-block">
    <IconButton
      icon="arrow-left"
      label={tr('app.backToTimeline')}
      tipText={tr('grade.exitTip')}
      testid="grade-exit"
      onclick={() => appState.closeGradeEditor()}
    />
  </div>
</aside>

<style>
  /*
   * 比主 rail 窄 4px：它不是「应用级导航」，而是这一页的工具条。
   * 底色用 surface-2（比 rail 的 surface-1 深一档），于是两块窄栏并排时
   * 读得出「左边是全局、右边是这一页」。
   */
  .grade-rail {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: var(--sp-2);
    width: var(--grade-rail-w, 40px);
    padding: var(--sp-3) 0;
    background: var(--surface-2);
    border-right: 1px solid var(--border);
    overflow: hidden;
  }
  .gr-block {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: var(--sp-1);
  }
  .gr-spacer {
    flex: 1;
  }
  .gr-sep {
    width: 16px;
    height: 1px;
    margin: 2px 0;
    background: var(--border);
  }
</style>
