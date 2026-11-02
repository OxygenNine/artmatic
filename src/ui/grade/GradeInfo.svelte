<script lang="ts">
  /**
   * GradeInfo — 调色页工具条里的「读数」：作用范围 + 降级提示 + 对照状态。
   *
   * 三件事都放在画面上方、同一行，理由相同：**它们改变你对画面的解读**。
   * 正在看的这一帧是「整条时间线」还是「只作用于某层」、是不是按 8 位在算、
   * 现在是原片还是调色 —— 任何一项搞错，前面调出来的判断都是错的。
   *
   * 分级判据与检查器同一份（`affectedVisualIndices`），不在这里另算：
   * 两处各算一次，漂了不报错，只会在你最不需要的时候给出相反答案。
   */
  import { affectedVisualIndices, visualTracks } from '../../engine/stack';
  import { tr } from '../../i18n/index.svelte';
  import { appState } from '../app-state.svelte';
  import { gradeClip } from './grade-session';

  const clip = $derived.by(() => {
    void appState.version;
    return gradeClip();
  });

  const scope = $derived.by(() => {
    void appState.version;
    const c = clip;
    if (!c) return { text: '', empty: false };
    const bound = c.boundClipId ? appState.store.findClip(c.boundClipId) : null;
    if (bound) return { text: tr('grade.infoBound', { name: bound.clip.label }), empty: false };
    const depth = c.affectDepth ?? 0;
    if (depth <= 0) return { text: tr('grade.infoAll'), empty: false };
    const visuals = visualTracks(appState.project);
    const self = visuals.findIndex((t) => t.clips.some((x) => x.id === c.id));
    const names = affectedVisualIndices(visuals, self, depth).map((i) => visuals[i]!.name);
    if (names.length === 0) return { text: tr('grade.infoEmpty'), empty: true };
    return { text: tr('grade.infoTracks', { names: names.join(tr('common.listSep')) }), empty: false };
  });

  /** 降级原因（16F 拿不到时说清为什么）。 */
  const precision = $derived.by(() => {
    void appState.version;
    const s = appState.renderer.gradeStats();
    if (!s.floatSupported) return tr('insp.gradeNoFloat');
    if (s.reason === 'over-budget') return tr('insp.gradeBudget');
    return null;
  });
</script>

<div class="gi" data-testid="grade-info">
  {#if appState.gradeBypass}
    <span class="gi-chip" data-testid="grade-bypass-chip">{tr('grade.before')}</span>
  {/if}
  <span class="gi-scope" class:warn={scope.empty} data-testid="grade-scope">{scope.text}</span>
  {#if precision}
    <span class="gi-precision" data-testid="grade-precision">{precision}</span>
  {/if}
</div>

<style>
  .gi {
    display: flex;
    align-items: center;
    gap: var(--sp-2);
    min-width: 0;
    overflow: hidden;
  }
  .gi-chip {
    flex: none;
    height: 18px;
    padding: 0 var(--sp-2);
    display: inline-flex;
    align-items: center;
    border: 1px solid var(--accent-border);
    border-radius: var(--radius-sm);
    color: var(--accent);
    font-size: var(--fs-xs);
  }
  .gi-scope {
    font-size: var(--fs-xs);
    color: var(--text-secondary);
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .gi-scope.warn {
    color: var(--warning);
  }
  .gi-precision {
    flex: none;
    font-size: var(--fs-xs);
    color: var(--warning);
  }
</style>
