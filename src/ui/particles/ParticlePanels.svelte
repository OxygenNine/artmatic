<script lang="ts">
  /**
   * ParticlePanels — 粒子编辑器的左列：按 group 折叠的参数面板。
   *
   * 参数表、分组顺序与 `visibleWhen` 全部来自 `algos/particles/params.ts`，
   * 这里不另造一份键空间。控件复用 `ui/controls/` 那一套（与检查器同源），
   * 于是关键帧 / 调制槽 / 素材选择在两处行为完全一致。
   *
   * 写入一律走 `store.updateClip` 的**一笔提交**：拖一次滑杆是一笔撤销，
   * 点一次预设也是一笔。
   */
  import { appState } from '../app-state.svelte';
  import { getGenerator } from '../../algos/registry';
  import { visibleParams, type ParamDef } from '../../effects/types';
  import {
    PARTICLE_GROUPS,
    PARTICLE_COLLAPSED_GROUPS,
  } from '../../algos/particles/config';
  import { particleGroupLabel } from '../../algos/particles/params';
  import { tr } from '../../i18n/index.svelte';
  import { resolveLabel } from '../../i18n/label';
  import type { AnyClip, SourceClip } from '../../core/schema';
  import type { ModSlot } from '../../core/modulation';
  import { upsertCurveKey } from '../clip-edit';
  import { resolveThemeColor } from '../../typography/theme';
  import KeyableField from '../KeyableField.svelte';
  import Field from '../controls/Field.svelte';
  import Select from '../controls/Select.svelte';
  import Checkbox from '../controls/Checkbox.svelte';
  import ColorField from '../controls/ColorField.svelte';
  import NumericField from '../controls/NumericField.svelte';
  import AssetField from '../controls/AssetField.svelte';
  import IconButton from '../controls/IconButton.svelte';
  import { sliderScaleOf } from '../controls/param-scale';
  import { appPatternSource } from '../pattern/pattern-import';

  interface Props {
    clipId: string;
    /** 窄窗口下右栏折成抽屉，由左栏这颗按钮开合。 */
    onToggleDock?: () => void;
  }
  const { clipId, onToggleDock }: Props = $props();

  const patternAssets = appPatternSource();

  /**
   * 片段是原地改的普通对象 —— 必须显式订阅 version，**并且返回新引用**。
   *
   * 只 `void appState.version` 不够：Svelte 5 的 derived 以 `===` 判等决定要不要
   * 通知模板 effect，而 store 是原地改的（`found.clip` 每次都是同一引用）⇒
   * 派生重跑了但「值没变」⇒ 依赖它的滑杆 / 数字框静默断更。
   * 症状：拖滑杆时**画面在动、把手与数字不动**，松手也不补上（`ui/AGENTS.md`
   * 的「根因一」）。检查器同一处坑，解法相同（`Inspector.svelte::found`）。
   */
  const clip = $derived.by<SourceClip | null>(() => {
    void appState.version;
    const found = appState.store.findClip(clipId);
    if (!found || found.clip.kind !== 'source' || found.clip.source.type !== 'algo') return null;
    return structuredClone(found.clip) as SourceClip;
  });

  const def = $derived.by(() => {
    void appState.version;
    return clip ? getGenerator(clip.source.type === 'algo' ? clip.source.generator : '') : null;
  });

  const params = $derived.by<ParamDef[]>(() => {
    void appState.version;
    if (!clip || !def) return [];
    return visibleParams(def.params, clip.source.type === 'algo' ? clip.source.params : {});
  });

  /** 折叠状态按分组键，出厂折叠的组见 config。 */
  let collapsed = $state<Set<string>>(new Set(PARTICLE_COLLAPSED_GROUPS));

  function groups(): { id: string; label: string; items: ParamDef[] }[] {
    return PARTICLE_GROUPS.map((id) => ({
      id,
      label: tr(particleGroupLabel(id)),
      items: params.filter((p) => (p.group ?? 'system') === id),
    })).filter((g) => g.items.length > 0);
  }

  function toggle(id: string): void {
    const next = new Set(collapsed);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    collapsed = next;
  }

  function valueOf(p: ParamDef): number | string {
    if (!clip || clip.source.type !== 'algo') return p.defaultValue;
    return clip.source.params[p.key] ?? p.defaultValue;
  }

  /** 一笔提交。标签带上参数名，撤销栈里能看出改了什么。 */
  function write(p: ParamDef, v: number | string): void {
    const c = clip;
    if (!c) return;
    appState.store.updateClip(clipId, tr('insp.editParam'), (draft: AnyClip) => {
      if (draft.kind === 'source' && draft.source.type === 'algo') draft.source.params[p.key] = v;
    });
    appState.refreshPreview();
  }

  /** 与检查器 `curveProps` 同一条键约定：`clip.curves[key]`。 */
  function curveProps(p: ParamDef) {
    const c = clip;
    if (!c) return null;
    const key = p.key;
    const base = Number(valueOf(p));
    return {
      base,
      curve: c.curves[key],
      clipStart: c.start,
      clipId: c.id,
      curveKey: key,
      onBase: (v: number) => write(p, v),
      onKey: (v: number, anchor: { beat: number } | null) =>
        appState.store.updateClip(clipId, tr('insp.keyframe'), (draft: AnyClip) =>
          upsertCurveKey(draft, key, v, appState.playT, anchor, appState.project.beatGrid)),
      onRemoveKey: (i: number) =>
        appState.store.updateClip(clipId, tr('insp.removeKeyframe'), (draft: AnyClip) => {
          const cv = draft.curves[key];
          if (cv) cv.keys = cv.keys.filter((_, k) => k !== i);
        }),
      onAnchorChange: (anchor: { beat: number } | null) =>
        appState.store.updateClip(clipId, tr('insp.toggleAnchor'), (draft: AnyClip) => {
          const cv = draft.curves[key];
          if (cv) cv.beatAnchor = anchor;
        }),
      onClearCurve: () =>
        appState.store.updateClip(clipId, tr('insp.clearCurve'), (draft: AnyClip) => {
          delete draft.curves[key];
        }),
      mods: c.mods?.[key],
      onMods: (next: ModSlot[] | null) => appState.store.setClipMods(clipId, key, next),
    };
  }
</script>

<aside class="pe-panels" data-testid="particle-panels">
  <header class="pe-head">
    <span class="pe-title">{tr('algo.particles.editor.title')}</span>
    <span class="pe-head-actions">
      {#if onToggleDock}
        <IconButton
          icon="panel-right"
          label={tr('algo.particles.editor.stats')}
          testid="particle-dock-toggle"
          onclick={onToggleDock}
        />
      {/if}
      <IconButton
        icon="arrow-left"
        label={tr('algo.particles.editor.back')}
        testid="particle-back"
        onclick={() => appState.closeParticleEditor()}
      />
    </span>
  </header>

  <div class="pe-scroll">
    {#if !clip}
      <p class="pe-empty" data-testid="particle-no-clip">{tr('algo.particles.editor.noClip')}</p>
    {:else}
      {#each groups() as g (g.id)}
        <section class="pe-group" data-testid={`particle-group-${g.id}`}>
          <button
            type="button"
            class="pe-group-head"
            aria-expanded={!collapsed.has(g.id)}
            data-testid={`particle-group-toggle-${g.id}`}
            onclick={() => toggle(g.id)}
          >
            <span class="pe-group-name">{g.label}</span>
            <span class="pe-group-count">{g.items.length}</span>
          </button>
          {#if !collapsed.has(g.id)}
            <div class="pe-group-body">
              {#each g.items as p (p.key)}
                <div data-testid={`particle-param-${p.key}`}>
                  {#if p.type === 'range'}
                    {@const cp = curveProps(p)}
                    {#if cp}
                      <KeyableField
                        label={resolveLabel(p.labelKey, tr)}
                        min={p.min}
                        max={p.max}
                        step={p.step}
                        scale={sliderScaleOf(p)}
                        {...cp}
                      />
                    {/if}
                  {:else if p.type === 'select'}
                    <Field label={resolveLabel(p.labelKey, tr)}>
                      <Select
                        value={String(valueOf(p))}
                        options={p.options.map((o) => ({ value: o.value, label: resolveLabel(o.labelKey, tr) }))}
                        testid={`particle-select-${p.key}`}
                        onchange={(v) => write(p, v)}
                      />
                    </Field>
                  {:else if p.type === 'checkbox'}
                    <Field label={resolveLabel(p.labelKey, tr)}>
                      <Checkbox
                        checked={Number(valueOf(p)) !== 0}
                        testid={`particle-check-${p.key}`}
                        onchange={(v) => write(p, v ? 1 : 0)}
                      />
                    </Field>
                  {:else if p.type === 'color'}
                    <Field label={resolveLabel(p.labelKey, tr)}>
                      <ColorField
                        label={resolveLabel(p.labelKey, tr)}
                        value={String(valueOf(p))}
                        testid={`particle-color-${p.key}`}
                        onchange={(v) => write(p, resolveThemeColor(v))}
                      />
                    </Field>
                  {:else if p.type === 'asset'}
                    <AssetField
                      label={resolveLabel(p.labelKey, tr)}
                      value={String(valueOf(p))}
                      items={() => patternAssets.list()}
                      testid={`particle-asset-${p.key}`}
                      onchange={(v) => write(p, v)}
                    />
                  {:else}
                    <!-- 其余标量类型（bitmask / pattern / text）走数值/文本兜底，
                         参数表新增类型时不会静默消失。 -->
                    <NumericField
                      label={resolveLabel(p.labelKey, tr)}
                      min={0}
                      max={1e6}
                      step={1}
                      value={Number(valueOf(p)) || 0}
                      oninput={(v) => write(p, v)}
                    />
                  {/if}
                </div>
              {/each}
            </div>
          {/if}
        </section>
      {/each}
    {/if}
  </div>
</aside>

<style>
  .pe-panels {
    grid-column: 1;
    display: flex;
    flex-direction: column;
    min-height: 0;
    min-width: 0;
    background: var(--surface-1);
    border-right: 1px solid var(--border);
  }
  .pe-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--sp-2);
    padding: var(--sp-2) var(--sp-3);
    border-bottom: 1px solid var(--border);
    flex: 0 0 auto;
  }
  .pe-title {
    font-size: var(--fs-md);
    font-weight: 600;
    color: var(--text);
  }
  .pe-head-actions {
    display: inline-flex;
    align-items: center;
    gap: var(--sp-1);
  }
  .pe-scroll {
    flex: 1 1 auto;
    overflow-y: auto;
    overscroll-behavior: contain;
  }
  .pe-empty {
    padding: var(--sp-4);
    color: var(--text-dim);
    font-size: var(--fs-sm);
  }
  .pe-group {
    border-bottom: 1px solid var(--border);
  }
  .pe-group-head {
    width: 100%;
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: var(--sp-2) var(--sp-3);
    background: transparent;
    border: 0;
    color: var(--text);
    cursor: pointer;
    font-size: var(--fs-sm);
    font-weight: 500;
    text-align: left;
  }
  .pe-group-head:hover {
    background: var(--surface-2);
  }
  .pe-group-count {
    color: var(--text-dim);
    font-size: var(--fs-xs);
    font-variant-numeric: tabular-nums;
  }
  .pe-group-body {
    padding: var(--sp-1) var(--sp-3) var(--sp-3);
    display: flex;
    flex-direction: column;
    gap: 2px;
  }
</style>
