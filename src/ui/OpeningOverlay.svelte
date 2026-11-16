<script lang="ts">
  /**
   * OpeningOverlay — 「正在打开工程」的进度浮条。
   *
   * 它存在的原因很具体：打开一个大工程（一百多个片段、九十多条素材、五个插件）
   * 期间界面会**静止几秒**，而这段时间里点任何东西都没有反馈 —— 用户会以为点空了，
   * 然后再点一次。
   *
   * 数据只有一个来源（`appState.openProgress`），写入点也只有一个
   * （`ui/project-actions.ts::openAt`）：那里每一步都知道自己走到哪了，
   * 所以这里不做任何估算；百分比算法在 `open-progress.ts`（有单测）。
   *
   * **不拦点击**（`pointer-events: none`）：打开是「再开一份」，原来那份还开着，
   * 拦下来只会让「点了一下没反应」这件事更严重。`index.html` 的启动遮罩是
   * 同一条理由。
   */
  import { appState, type OpenProgress } from './app-state.svelte';
  import { openProgressPercent } from './open-progress';
  import { tr } from '../i18n/index.svelte';

  const p = $derived(appState.openProgress);
  const pct = $derived(openProgressPercent(p));

  function label(cur: OpenProgress): string {
    switch (cur.step) {
      case 'read':
        return tr('proj.openingRead');
      case 'plugins':
        return tr('proj.openingPlugins');
      case 'assets':
        return cur.total > 0
          ? tr('proj.openingAssets', { done: cur.done, total: cur.total })
          : tr('proj.openingAssetsEmpty');
      default:
        return tr('proj.openingFinalize');
    }
  }
</script>

{#if p}
  <div class="open-toast" role="status" aria-live="polite" data-testid="open-progress">
    <div class="open-name" title={p.name}>{p.name}</div>
    <div class="open-phase">{label(p)}</div>
    <div class="open-bar" aria-hidden="true"><i style:width={`${pct}%`}></i></div>
  </div>
{/if}

<style>
  .open-toast {
    position: fixed;
    left: 50%;
    bottom: calc(var(--statusbar-h) + var(--sp-6));
    transform: translateX(-50%);
    z-index: var(--z-modal);
    width: 300px;
    max-width: 60vw;
    display: flex;
    flex-direction: column;
    gap: var(--sp-2);
    padding: var(--sp-4) var(--sp-5);
    background: var(--surface-2);
    border: 1px solid var(--border);
    border-radius: var(--radius-md);
    box-shadow: var(--shadow-float);
    /* 见文件头：遮罩不拦点击。 */
    pointer-events: none;
  }
  .open-name {
    color: var(--text-primary);
    font-size: var(--fs-sm);
    font-weight: 600;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .open-phase {
    color: var(--text-muted);
    font-size: var(--fs-xs);
    font-variant-numeric: tabular-nums;
  }
  .open-bar {
    height: 2px;
    margin-top: var(--sp-1);
    background: var(--surface-3);
    border-radius: 1px;
    overflow: hidden;
  }
  .open-bar > i {
    display: block;
    height: 100%;
    background: var(--accent);
  }
</style>
