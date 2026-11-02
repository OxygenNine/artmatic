<script lang="ts">
  /**
   * GradeDock — 调色页右栏码头：示波器（上）+ 查找表（下）。
   *
   * 为什么在右边而不是底部：示波器要**跟画面一样大**才有用（波形是按列统计的），
   * 底部一横条只能放进 16:9 的一小块；而右栏是竖向的，高度可以吃满。
   *
   * 两块都能单独关（标题栏的 ×，与侧栏图标同一份状态）：关掉之后画面变宽，
   * 这是「不需要读波形，只想看画面」时的常态。
   */
  import type { EffectInstance } from '../../core/schema';
  import { tr } from '../../i18n/index.svelte';
  import { resolveLabel } from '../../i18n/label';
  import { visibleParams } from '../../effects/types';
  import { getEffect } from '../../effects/registry';
  import IconButton from '../controls/IconButton.svelte';
  import Select from '../controls/Select.svelte';
  import { appState } from '../app-state.svelte';
  import Scopes from './Scopes.svelte';
  import { gradePanels } from './grade-panels.svelte';
  import { addModule, commit, gradeClip, writeOn } from './grade-session';
  import { importLutFile, lutAssets } from './lut-import';

  const lutInst = $derived.by<EffectInstance | undefined>(() => {
    void appState.version;
    return gradeClip()?.chain.find((i) => i.defId === 'grade-lut');
  });

  /** 当前 LUT 的名字（素材被删 / 从没选过 → null）。 */
  const lutName = $derived.by(() => {
    void appState.version;
    const id = lutInst?.values['lutAssetId'];
    if (typeof id !== 'string' || !id) return null;
    return appState.store.project.assets[id]?.name ?? null;
  });

  const lutOptions = $derived.by(() => {
    void appState.version;
    return lutAssets().map((a) => ({ value: a.id, label: a.name }));
  });

  /** 输入空间（`grade-lut` 自己的参数，只有这一个 select）。 */
  const spaceParam = $derived.by(() => {
    void appState.version;
    if (!lutInst) return undefined;
    const entry = getEffect(lutInst.defId);
    if (!entry) return undefined;
    return visibleParams(entry.params, lutInst.values).find((p) => p.type === 'select');
  });

  const spaceValue = $derived.by(() => {
    void appState.version;
    if (!lutInst || !spaceParam) return '';
    return String(lutInst.values[spaceParam.key] ?? spaceParam.defaultValue);
  });

  /** 导入 .cube 并挂到查找表模块上（模块不在就先加一个）。 */
  async function pickLut(e: Event): Promise<void> {
    const input = e.currentTarget as HTMLInputElement;
    const file = input.files?.[0];
    input.value = '';
    if (!file) return;
    const res = await importLutFile(file);
    if (!res.ok) {
      appState.flash(tr('grade.lutError', { reason: res.reason }), 'error');
      return;
    }
    const target = lutInst?.instanceId ?? addModule('grade-lut');
    writeOn(target, (it) => {
      it.values['lutAssetId'] = res.assetId;
    });
    commit();
  }

  function setAsset(id: string): void {
    const target = lutInst?.instanceId ?? addModule('grade-lut');
    writeOn(target, (it) => {
      it.values['lutAssetId'] = id;
    });
    commit();
  }
</script>

<aside class="gd" data-testid="grade-dock">
  {#if gradePanels.scopes}
    <section class="gd-panel gd-scopes" data-testid="grade-scopes-panel" aria-label={tr('grade.colScopes')}>
      <header class="gd-head">
        <h4 class="gd-h">{tr('grade.colScopes')}</h4>
        <IconButton
          icon="x"
          label={tr('grade.panelHide')}
          size="sm"
          testid="grade-close-scopes"
          onclick={() => gradePanels.set('scopes', false)}
        />
      </header>
      <div class="gd-body">
        <Scopes fill />
      </div>
    </section>
  {/if}

  {#if gradePanels.lut}
    <section class="gd-panel" data-testid="grade-lut-panel" aria-label={tr('grade.colLut')}>
      <header class="gd-head">
        <h4 class="gd-h">{tr('grade.colLut')}</h4>
        <IconButton
          icon="x"
          label={tr('grade.panelHide')}
          size="sm"
          testid="grade-close-lut"
          onclick={() => gradePanels.set('lut', false)}
        />
      </header>
      <div class="gd-body gd-lut-body" data-testid="grade-lut-block">
        <div class="gd-lut-line">
          <span class="gd-lut-name" data-testid="grade-lut-name">{lutName ?? tr('grade.lutNone')}</span>
          <label class="gd-lut-pick" title={tr('grade.lutImport')}>
            <input type="file" accept=".cube" data-testid="grade-lut-input" onchange={pickLut} />
            {tr('grade.lutImport')}
          </label>
        </div>

        {#if lutOptions.length > 0}
          <Select
            value={String(lutInst?.values['lutAssetId'] ?? '')}
            options={[{ value: '', label: tr('grade.lutNone') }, ...lutOptions]}
            testid="grade-lut-select"
            onchange={setAsset}
          />
        {:else}
          <p class="gd-note">{tr('grade.lutEmpty')}</p>
        {/if}

        {#if spaceParam && spaceParam.type === 'select'}
          <div class="gd-lut-space">
            <span class="gd-row-l">{resolveLabel(spaceParam.labelKey, tr)}</span>
            <Select
              value={spaceValue}
              options={spaceParam.options.map((o) => ({ value: o.value, label: resolveLabel(o.labelKey, tr) }))}
              testid="grade-lut-space"
              onchange={(v) => {
                if (!lutInst) return;
                writeOn(lutInst.instanceId, (it) => {
                  it.values[spaceParam.key] = v;
                });
                commit();
              }}
            />
          </div>
        {/if}
      </div>
    </section>
  {/if}
</aside>

<style>
  .gd {
    display: flex;
    flex-direction: column;
    min-width: 0;
    min-height: 0;
    background: var(--surface-1);
    border-left: 1px solid var(--border);
    overflow: hidden;
  }
  .gd-panel {
    display: flex;
    flex-direction: column;
    min-height: 0;
    min-width: 0;
  }
  /* 示波器吃满剩余高度；LUT 只占内容高度。 */
  .gd-scopes {
    flex: 1 1 auto;
  }
  .gd-scopes + .gd-panel {
    border-top: 1px solid var(--border);
  }
  .gd-head {
    display: flex;
    align-items: center;
    gap: var(--sp-2);
    padding: var(--sp-1) var(--sp-1) var(--sp-1) var(--sp-3);
    border-bottom: 1px solid var(--border);
    flex: none;
  }
  .gd-h {
    margin: 0;
    font-size: var(--fs-xs);
    font-weight: 600;
    letter-spacing: 0.04em;
    color: var(--text-muted);
  }
  .gd-head > :global(.ic-btn) {
    margin-left: auto;
  }
  .gd-body {
    flex: 1;
    display: flex;
    flex-direction: column;
    min-height: 0;
    min-width: 0;
    padding: var(--sp-2) var(--sp-3);
    overflow: auto;
  }
  .gd-lut-body {
    display: flex;
    flex-direction: column;
    gap: var(--sp-2);
    flex: none;
  }
  .gd-lut-line {
    display: flex;
    align-items: center;
    gap: var(--sp-2);
    min-width: 0;
  }
  .gd-lut-name {
    font-size: var(--fs-xs);
    color: var(--text-secondary);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    min-width: 0;
  }
  /* 文件选择：原生 input 太丑，用 label 顶替，input 自己藏起来但仍可点。 */
  .gd-lut-pick {
    margin-left: auto;
    flex: none;
    display: inline-flex;
    align-items: center;
    height: var(--control-h-sm);
    padding: 0 var(--sp-2);
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    font-size: var(--fs-xs);
    color: var(--text-secondary);
    cursor: pointer;
  }
  .gd-lut-pick:hover {
    border-color: var(--border-strong);
  }
  .gd-lut-pick input {
    display: none;
  }
  .gd-lut-space {
    display: grid;
    grid-template-columns: 56px minmax(0, 1fr);
    align-items: center;
    gap: var(--sp-2);
  }
  .gd-row-l {
    font-size: var(--fs-xs);
    color: var(--text-secondary);
  }
  .gd-note {
    margin: 0;
    font-size: var(--fs-xs);
    color: var(--text-muted);
    line-height: 1.5;
  }
</style>
