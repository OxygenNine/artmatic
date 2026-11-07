<script lang="ts">
  /**
   * ParticlePresets — 粒子编辑器右栏的预设列表。
   *
   * 预设 = **一组参数值**（`PARTICLE_PRESETS`），不是 shader 分支，所以点一下
   * 只写 `clip.source.params`，一次 `updateClip` = 一笔撤销。
   * 刻意用「叠加」而不是整表替换：用户调过而预设没提到的量要留着。
   */
  import { appState } from '../app-state.svelte';
  import { PARTICLE_PRESETS, applyParticlePreset } from '../../algos/particles/config';
  import { tr } from '../../i18n/index.svelte';
  import type { MessageKey } from '../../i18n/locales';
  import type { AnyClip } from '../../core/schema';

  interface Props {
    clipId: string;
  }
  const { clipId }: Props = $props();

  const presetLabel = (id: string): MessageKey => `algo.particles.preset.${id}` as MessageKey;

  function apply(id: string): void {
    void appState.version;
    const found = appState.store.findClip(clipId);
    if (!found || found.clip.kind !== 'source' || found.clip.source.type !== 'algo') return;
    const current = { ...found.clip.source.params };
    const next = applyParticlePreset(id, current);
    appState.store.updateClip(clipId, tr('algo.particles.editor.apply'), (draft: AnyClip) => {
      if (draft.kind === 'source' && draft.source.type === 'algo') draft.source.params = next;
    });
    appState.refreshPreview();
  }
</script>

<section class="pe-presets" data-testid="particle-presets">
  <h3 class="pe-h">{tr('algo.particles.editor.presets')}</h3>
  <div class="pe-list">
    {#each PARTICLE_PRESETS as preset (preset.id)}
      <button
        type="button"
        class="pe-card"
        data-testid={`particle-preset-${preset.id}`}
        onclick={() => apply(preset.id)}
      >
        <span class="pe-card-name">{tr(presetLabel(preset.id))}</span>
        <span class="pe-card-apply">{tr('algo.particles.editor.apply')}</span>
      </button>
    {/each}
  </div>
</section>

<style>
  .pe-presets {
    display: flex;
    flex-direction: column;
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
  .pe-list {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(96px, 1fr));
    gap: var(--sp-2);
    padding: var(--sp-3);
    overflow-y: auto;
  }
  .pe-card {
    display: flex;
    flex-direction: column;
    align-items: flex-start;
    gap: 2px;
    padding: var(--sp-2);
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    background: var(--surface-2);
    color: var(--text);
    cursor: pointer;
    text-align: left;
    transition: border-color 120ms, transform 120ms;
  }
  .pe-card:hover {
    border-color: var(--accent);
    transform: translateY(-1px);
  }
  .pe-card-name {
    font-size: var(--fs-sm);
    font-weight: 500;
  }
  .pe-card-apply {
    font-size: var(--fs-xs);
    color: var(--text-dim);
  }
</style>
