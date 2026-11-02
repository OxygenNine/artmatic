<script lang="ts">
  /**
   * GradePanels — 调色页底部那一行：一级校色轮（左）与曲线（右）。
   *
   * 位置与时间轴那片区域重合（同样的高度变量、同样的拖拽把手），所以进调色页
   * 等于把时间轴换成调色台，画面一点没挪 —— 这是「边看边调」的前提。
   *
   * 色轮与曲线的分栏比例按内容定：色轮要四个并排（宽），曲线要四张并排（也宽），
   * 所以给 1.2 : 1，而不是硬对半 —— 对半时四个色轮会挤到拖不开。
   */
  import type { EffectInstance } from '../../core/schema';
  import { tr } from '../../i18n/index.svelte';
  import { resolveLabel } from '../../i18n/label';
  import { visibleParams } from '../../effects/types';
  import { getEffect } from '../../effects/registry';
  import IconButton from '../controls/IconButton.svelte';
  import Button from '../controls/Button.svelte';
  import GradientSlider from '../controls/GradientSlider.svelte';
  import NumberInput from '../controls/NumberInput.svelte';
  import Select from '../controls/Select.svelte';
  import Slider from '../controls/Slider.svelte';
  import { appState } from '../app-state.svelte';
  import ColorWheel from './ColorWheel.svelte';
  import ToneCurveEditor from './ToneCurveEditor.svelte';
  import { WHEELS } from './grade-ops';
  import { paramGradient } from './gradients';
  import { gradePanels } from './grade-panels.svelte';
  import {
    activeInstance,
    addModule,
    chain,
    commit,
    gradeClip,
    isBasic,
    resetAllWheels,
    write,
    writeOn,
  } from './grade-session';

  const clip = $derived.by(() => {
    void appState.version;
    return gradeClip();
  });
  const instances = $derived.by(() => {
    void appState.version;
    return chain();
  });
  const active = $derived.by<EffectInstance | undefined>(() => {
    void appState.version;
    return activeInstance();
  });
  const entry = $derived.by(() => {
    void appState.version;
    return active ? getEffect(active.defId) : undefined;
  });
  const curvesInst = $derived.by(() => {
    void appState.version;
    return instances.find((i) => i.defId === 'grade-curves');
  });

  /**
   * 对比 / 饱和 / 色相 / 色温 / 色调。
   *
   * 顺序刻意按「校色台」的读法排（对比与色彩浓度、色相与色温色调各成一组），
   * 不是参数表顺序 —— 图 2 的排布就是这样，眼睛从左到右扫两行就够。
   */
  const PARAM_ORDER = ['contrast', 'hue', 'temp', 'saturation', 'tint'] as const;

  const plainParams = $derived.by(() => {
    void appState.version;
    if (!active || !entry) return [];
    const list = visibleParams(entry.params, active.values).filter((p) => !p.key.includes('#'));
    return [...list].sort((a, b) => {
      const ia = PARAM_ORDER.indexOf(a.key as (typeof PARAM_ORDER)[number]);
      const ib = PARAM_ORDER.indexOf(b.key as (typeof PARAM_ORDER)[number]);
      return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib);
    });
  });

  function resetParam(key: string, fallback: number): void {
    write((it) => {
      it.values[key] = fallback;
    });
    commit();
  }
</script>

<div class="gp" data-testid="grade-panels">
  {#if gradePanels.wheels}
    <section class="gp-cell gp-wheels" data-testid="grade-wheels-panel" aria-label={tr('grade.colWheels')}>
      <header class="gp-head">
        <h4 class="gp-h">{tr('grade.colWheels')}</h4>
        {#if instances.length > 1}
          <div class="gp-tabs" role="tablist" aria-label={tr('grade.module')}>
            {#each instances as inst (inst.instanceId)}
              {@const e = getEffect(inst.defId)}
              <button
                class="gp-tab"
                class:on={inst.instanceId === active?.instanceId}
                type="button"
                role="tab"
                aria-selected={inst.instanceId === active?.instanceId}
                data-testid={`grade-tab-${inst.defId}`}
                onclick={() => (appState.gradeInstanceId = inst.instanceId)}
              >
                {e ? resolveLabel(e.nameKey, tr) : inst.defId}
              </button>
            {/each}
          </div>
        {/if}
        <div class="gp-head-tail">
          {#if active && isBasic(active)}
            <button
              class="gp-link"
              type="button"
              data-testid="grade-reset-all"
              onclick={() => resetAllWheels()}
            >
              {tr('grade.resetAll')}
            </button>
          {/if}
          <IconButton
            icon="x"
            label={tr('grade.panelHide')}
            size="sm"
            testid="grade-close-wheels"
            onclick={() => gradePanels.set('wheels', false)}
          />
        </div>
      </header>

      <div class="gp-body">
        {#if active && isBasic(active)}
          <div class="gp-wheel-row">
            {#each WHEELS as spec (spec.group)}
              <ColorWheel inst={active} {spec} onvalue={write} oncommit={commit} />
            {/each}
          </div>
        {:else if active}
          <p class="gp-note">{tr('grade.noWheel')}</p>
        {/if}

        {#if plainParams.length > 0}
          <div class="gp-params">
            {#each plainParams as p (p.key)}
              {#if p.type === 'range'}
                {@const grad = paramGradient(p.key)}
                <div class="gp-row">
                  <span class="gp-row-l">{resolveLabel(p.labelKey, tr)}</span>
                  {#if grad}
                    <GradientSlider
                      value={Number(active!.values[p.key] ?? p.defaultValue)}
                      min={p.min}
                      max={p.max}
                      step={p.step}
                      gradient={grad}
                      neutral={p.defaultValue}
                      ariaLabel={resolveLabel(p.labelKey, tr)}
                      testid={`grade-param-${p.key}`}
                      oninput={(v) => write((it) => (it.values[p.key] = v))}
                      onchange={commit}
                    />
                  {:else}
                    <Slider
                      value={Number(active!.values[p.key] ?? p.defaultValue)}
                      min={p.min}
                      max={p.max}
                      step={p.step}
                      ariaLabel={resolveLabel(p.labelKey, tr)}
                      testid={`grade-param-${p.key}`}
                      oninput={(v) => write((it) => (it.values[p.key] = v))}
                      onchange={commit}
                    />
                  {/if}
                  <NumberInput
                    value={Number(active!.values[p.key] ?? p.defaultValue)}
                    min={p.min}
                    max={p.max}
                    step={p.step}
                    width={52}
                    ariaLabel={resolveLabel(p.labelKey, tr)}
                    testid={`grade-param-num-${p.key}`}
                    oninput={(v) => write((it) => (it.values[p.key] = v))}
                    onchange={(v) => {
                      write((it) => (it.values[p.key] = v));
                      commit();
                    }}
                  />
                  <IconButton
                    icon="rotate-ccw"
                    label={tr('grade.resetShort')}
                    size="sm"
                    testid={`grade-param-reset-${p.key}`}
                    onclick={() => resetParam(p.key, p.defaultValue)}
                  />
                </div>
              {:else if p.type === 'select'}
                <div class="gp-row gp-row-select">
                  <span class="gp-row-l">{resolveLabel(p.labelKey, tr)}</span>
                  <Select
                    value={String(active!.values[p.key] ?? p.defaultValue)}
                    options={p.options.map((o) => ({ value: o.value, label: resolveLabel(o.labelKey, tr) }))}
                    testid={`grade-param-${p.key}`}
                    optionTestidPrefix={`grade-param-${p.key}-opt`}
                    onchange={(v) => {
                      write((it) => {
                        it.values[p.key] = v;
                      });
                      commit();
                    }}
                  />
                </div>
              {/if}
            {/each}
          </div>
        {/if}
      </div>
    </section>
  {/if}

  {#if gradePanels.curves}
    <section class="gp-cell gp-curves" data-testid="grade-curves-panel" aria-label={tr('grade.colCurves')}>
      <header class="gp-head">
        <h4 class="gp-h">{tr('grade.colCurves')}</h4>
        {#if curvesInst}
          <span class="gp-hint" title={tr('grade.curveHint')}>{tr('grade.curveHintShort')}</span>
        {/if}
        <div class="gp-head-tail">
          <IconButton
            icon="x"
            label={tr('grade.panelHide')}
            size="sm"
            testid="grade-close-curves"
            onclick={() => gradePanels.set('curves', false)}
          />
        </div>
      </header>

      <div class="gp-body">
        {#if curvesInst && clip}
          <ToneCurveEditor
            inst={curvesInst}
            onvalue={(fn) => writeOn(curvesInst!.instanceId, fn)}
            oncommit={commit}
          />
        {:else if clip}
          <div class="gp-empty">
            <p class="gp-note">{tr('grade.curvesMissing')}</p>
            <Button
              label={tr('grade.addCurves')}
              icon="plus"
              variant="outline"
              testid="grade-add-curves"
              onclick={() => addModule('grade-curves')}
            />
          </div>
        {/if}
      </div>
    </section>
  {/if}
</div>

<style>
  /*
   * 高度吃父级给的那一格（`.stage` 的最后一行的 `--tracks-h`），
   * 不再自己定高度 —— 拖上方那条把手时两块面板一起变高。
   */
  .gp {
    display: flex;
    min-height: 0;
    min-width: 0;
    height: 100%;
    gap: 1px;
    background: var(--border);
    overflow: hidden;
  }
  .gp-cell {
    display: flex;
    flex-direction: column;
    min-width: 0;
    min-height: 0;
    background: var(--surface-1);
  }
  /* 四个色轮每个要放「盘 + 主量条 + 三个数值框」，比四张曲线图更吃宽度。 */
  .gp-wheels {
    flex: 1.45 1 0;
  }
  .gp-curves {
    flex: 1 1 0;
  }
  .gp-head {
    display: flex;
    align-items: center;
    gap: var(--sp-2);
    padding: var(--sp-1) var(--sp-2) var(--sp-1) var(--sp-3);
    border-bottom: 1px solid var(--border);
    flex: none;
    min-width: 0;
  }
  .gp-h {
    margin: 0;
    font-size: var(--fs-xs);
    font-weight: 600;
    letter-spacing: 0.04em;
    color: var(--text-muted);
    flex: none;
  }
  .gp-head-tail {
    margin-left: auto;
    display: inline-flex;
    align-items: center;
    gap: var(--sp-1);
    flex: none;
  }
  /* 「全部复位」是文字链接样式：它在标题栏里，不该比标题更抢眼。 */
  .gp-link {
    height: 18px;
    padding: 0 var(--sp-1);
    background: none;
    border: 0;
    border-radius: var(--radius-sm);
    color: var(--text-muted);
    font: inherit;
    font-size: var(--fs-xs);
    cursor: pointer;
  }
  .gp-link:hover {
    color: var(--accent);
  }
  .gp-hint {
    font-size: var(--fs-xs);
    color: var(--text-muted);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    min-width: 0;
  }
  .gp-tabs {
    display: flex;
    gap: 2px;
    min-width: 0;
    overflow: hidden;
  }
  .gp-tab {
    height: 18px;
    padding: 0 var(--sp-2);
    background: transparent;
    border: 1px solid transparent;
    border-radius: var(--radius-sm);
    color: var(--text-muted);
    font: inherit;
    font-size: var(--fs-xs);
    cursor: pointer;
    white-space: nowrap;
  }
  .gp-tab:hover {
    color: var(--text-secondary);
  }
  .gp-tab.on {
    border-color: var(--border-strong);
    color: var(--text-primary);
  }
  .gp-body {
    flex: 1;
    min-height: 0;
    min-width: 0;
    display: flex;
    flex-direction: column;
    gap: var(--sp-2);
    padding: var(--sp-2) var(--sp-2) var(--sp-2) var(--sp-3);
    overflow: auto;
  }
  /*
   * 四列等宽 + 最小 120px：120 是「三个 38px 数值框 + 2px 间隔」正好放得下
   * 的下限。再宽没有必要，再窄数值框就要叠在一起（实测 132 下限在 1280
   * 窗口下会溢出 21px，第四颗轮盘被切掉一角）。
   */
  .gp-wheel-row {
    display: grid;
    grid-template-columns: repeat(4, minmax(120px, 1fr));
    gap: var(--sp-2);
    /* 不许被压缩：flex 项的默认 `shrink: 1` 会把这一块压到比内容矮，
       而溢出**不计入**滚动高度 —— 表现是最后一行参数被面板下沿切掉一半，
       但 `scrollHeight === clientHeight`，看起来像「没地方可滚」。 */
    flex: none;
  }
  /* 对比 / 饱和 / 色相 / 色温 / 色调：三列两行（图 2 的排法）。 */
  .gp-params {
    display: grid;
    grid-template-columns: repeat(3, minmax(0, 1fr));
    gap: 2px var(--sp-3);
    border-top: 1px solid var(--border);
    padding-top: var(--sp-2);
    margin-top: auto;
    flex: none;
  }
  /* 曲线那一栏：四张方图按宽度定尺寸，剩下的高度居中 —— 顶对齐会让下半截
     空出一大片，读起来像「图没画完」。 */
  .gp-curves .gp-body {
    justify-content: center;
  }
  .gp-row {
    display: grid;
    grid-template-columns: 44px minmax(0, 1fr) auto auto;
    align-items: center;
    gap: var(--sp-1);
    min-width: 0;
  }
  .gp-row-l {
    font-size: var(--fs-xs);
    color: var(--text-secondary);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .gp-row-select {
    grid-template-columns: 44px minmax(0, 1fr);
  }
  .gp-note {
    margin: 0;
    font-size: var(--fs-xs);
    color: var(--text-muted);
    line-height: 1.5;
  }
  .gp-empty {
    display: flex;
    flex-direction: column;
    align-items: flex-start;
    gap: var(--sp-2);
  }
</style>
