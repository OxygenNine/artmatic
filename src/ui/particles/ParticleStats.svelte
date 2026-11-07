<script lang="ts">
  /**
   * ParticleStats — 粒子编辑器右栏的状态读数。
   *
   * 只读，不写工程。数据来自 `AlgoRuntime.stats()`（同一个 `__artmatic.algoStats`
   * 出口），所以「粒子数 / 步数 / 精度降级」与运行时是同一份真源，不是估计值。
   *
   * 降级 / 素材缺席用**状态条**（不是弹窗）：调参时画面必须一直在屏上，
   * 弹窗会盖住预览，等于闭着眼调。
   */
  import { appState } from '../app-state.svelte';
  import { tr } from '../../i18n/index.svelte';
  import type { MessageKey } from '../../i18n/locales';
  import type { AlgoRuntimeStats, ParticleRuntimeDiagnostics } from '../../algos/runtime';

  const REASON_KEYS: Record<string, MessageKey> = {
    floatTargetsUnavailable: 'algo.particles.notice.floatTargetsUnavailable',
    particleBudget: 'algo.particles.notice.particleBudget',
    stateReadbackUnavailable: 'algo.particles.notice.stateReadbackUnavailable',
    assetNotReady: 'algo.particles.notice.assetNotReady',
  };

  /**
   * 轮询而不是订阅：这些是渲染期的瞬时读数，不进工程、不进 `version`。
   * 500ms 足够看清追赶过程，又不会给每帧加同步 `readPixels`。
   */
  let stats = $state<AlgoRuntimeStats | null>(null);
  let timer: ReturnType<typeof setInterval> | null = null;

  $effect(() => {
    const read = () => {
      try {
        stats = appState.algos?.stats() ?? null;
      } catch {
        stats = null;
      }
    };
    read();
    timer = setInterval(read, 500);
    return () => {
      if (timer) clearInterval(timer);
      timer = null;
    };
  });

  const diag = $derived.by<ParticleRuntimeDiagnostics | null>(() =>
    stats?.particleDiagnostics?.[0] ?? null,
  );
  const notices = $derived.by<MessageKey[]>(() => {
    const out: MessageKey[] = [];
    if (diag?.reason && REASON_KEYS[diag.reason]) out.push(REASON_KEYS[diag.reason]!);
    for (const n of stats?.assetNotices ?? []) {
      if (REASON_KEYS[n]) out.push(REASON_KEYS[n]!);
    }
    return out;
  });
</script>

<section class="pe-stats" data-testid="particle-stats">
  <h3 class="pe-h">{tr('algo.particles.editor.stats')}</h3>
  <dl class="pe-grid">
    <div>
      <dt>{tr('algo.particles.stat.count')}</dt>
      <dd data-testid="particle-stat-count">{diag?.count ?? '—'}</dd>
    </div>
    <div>
      <dt>{tr('algo.particles.stat.max')}</dt>
      <dd data-testid="particle-stat-max">{diag?.maxParticles ?? '—'}</dd>
    </div>
    <div>
      <dt>{tr('algo.particles.stat.frame')}</dt>
      <dd data-testid="particle-stat-frame">{diag?.simFrame ?? '—'}</dd>
    </div>
    <div>
      <dt>{tr('algo.particles.stat.snapshots')}</dt>
      <dd data-testid="particle-stat-snapshots">{diag?.snapshots ?? '—'}</dd>
    </div>
    <div class="wide">
      <dt>{tr('algo.particles.stat.precision')}</dt>
      <dd data-testid="particle-stat-precision">
        {tr(diag?.precision === '8'
          ? 'algo.particles.stat.precision8'
          : 'algo.particles.stat.precision32f')}
      </dd>
    </div>
  </dl>

  {#if notices.length > 0}
    <div class="pe-notices" data-testid="particle-notices">
      {#each notices as key (key)}
        <p class="pe-notice">{tr(key)}</p>
      {/each}
    </div>
  {/if}
</section>

<style>
  .pe-stats {
    display: flex;
    flex-direction: column;
    border-top: 1px solid var(--border);
    min-height: 0;
  }
  .pe-h {
    margin: 0;
    padding: var(--sp-2) var(--sp-3);
    font-size: var(--fs-sm);
    font-weight: 600;
    color: var(--text);
    border-bottom: 1px solid var(--border);
  }
  .pe-grid {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: var(--sp-2) var(--sp-3);
    margin: 0;
    padding: var(--sp-3);
  }
  .pe-grid .wide {
    grid-column: 1 / -1;
  }
  dt {
    font-size: var(--fs-xs);
    color: var(--text-dim);
  }
  dd {
    margin: 0;
    font-size: var(--fs-md);
    font-variant-numeric: tabular-nums;
    color: var(--text);
  }
  .pe-notices {
    padding: 0 var(--sp-3) var(--sp-3);
    display: flex;
    flex-direction: column;
    gap: var(--sp-1);
  }
  .pe-notice {
    margin: 0;
    padding: var(--sp-2);
    border-left: 2px solid var(--warn, #fbbf24);
    background: var(--surface-2);
    font-size: var(--fs-xs);
    color: var(--text);
  }
</style>
