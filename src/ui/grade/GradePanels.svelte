<script lang="ts">
  /**
   * GradePanels — 调色页底部那一行：一级校色轮（左）与曲线（右）。
   *
   * 位置与时间轴那片区域重合（同样的高度变量、同样的拖拽把手），所以进调色页
   * 等于把时间轴换成调色台，画面一点没挪 —— 这是「边看边调」的前提。
   *
   * 两块的宽度**可拖**（中间的 4px 竖条）：四个色轮与四张曲线图都要横向空间，
   * 谁更吃宽取决于窗口，写死比例总有一边难受。
   */
  import type { EffectInstance } from '../../core/schema';
  import type { MessageKey } from '../../i18n/locales';
  import { tr } from '../../i18n/index.svelte';
  import { resolveLabel } from '../../i18n/label';
  import { visibleParams, type ParamDef } from '../../effects/types';
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
  import { addModule, commit, gradeClip, isBasic, resetAllWheels, writeOn } from './grade-session';

  const clip = $derived.by(() => {
    void appState.version;
    return gradeClip();
  });
  const instances = $derived.by(() => {
    void appState.version;
    return clip ? clip.chain.filter((i) => i.defId.startsWith('grade-')) : [];
  });

  /**
   * 色轮区认的是 `grade-basic`，不是「当前选中的模块」。
   *
   * 曾经有一排「基础调色 / 曲线 / 查找表」的模块页签，但曲线和查找表已经有
   * 自己的面板 —— 页签除了制造「我到底在改哪一个」的疑问之外没有用处。
   * 现在只有链上真有**多个** basic 时才出现页签（那种情况本身很少见，
   * 但不能没有出口）。
   */
  const basics = $derived.by(() => {
    void appState.version;
    return instances.filter(isBasic);
  });
  const basicInst = $derived.by<EffectInstance | undefined>(() => {
    void appState.version;
    const picked = basics.find((i) => i.instanceId === appState.gradeInstanceId);
    // 优先**启用中**的那个：编辑一个停用的模块，画面上当然什么都没有。
    return picked ?? basics.find((i) => i.enabled) ?? basics[0];
  });

  const curvesInst = $derived.by(() => {
    void appState.version;
    const all = instances.filter((i) => i.defId === 'grade-curves');
    return all.find((i) => i.enabled) ?? all[0];
  });

  /**
   * 参数行。**值必须在派生里取**（连同 `void appState.version`）：
   * `active.values` 是普通对象的原地写，模板里直接读它不会让 Slider 重新求值 ——
   * 症状正是「拖滑杆画面在变、滑杆位置和数字不动」。
   */
  interface Row {
    key: string;
    label: string;
    type: 'range' | 'select';
    value: number | string;
    /** range 用；select 时为占位值（模板按 type 分支取值）。 */
    min: number;
    max: number;
    step: number;
    defValue: number | string;
    options: { value: string; label: string }[];
  }

  /** 校色台的读法：对比与色彩浓度一组，色相与色温色调一组（图 2 的排法）。 */
  const PARAM_ORDER = ['contrast', 'hue', 'temp', 'saturation', 'tint'] as const;

  const rows = $derived.by<Row[]>(() => {
    void appState.version;
    const inst = basicInst;
    if (!inst) return [];
    const entry = getEffect(inst.defId);
    if (!entry) return [];
    return visibleParams(entry.params, inst.values)
      .filter((p) => (p.type === 'range' || p.type === 'select') && !p.key.includes('#'))
      .sort((a, b) => {
        const ia = PARAM_ORDER.indexOf(a.key as (typeof PARAM_ORDER)[number]);
        const ib = PARAM_ORDER.indexOf(b.key as (typeof PARAM_ORDER)[number]);
        return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib);
      })
      .map((p) => ({
        key: p.key,
        label: resolveLabel(p.labelKey, tr),
        type: p.type === 'select' ? ('select' as const) : ('range' as const),
        value: inst.values[p.key] ?? p.defaultValue,
        min: p.type === 'range' ? p.min : 0,
        max: p.type === 'range' ? p.max : 0,
        step: p.type === 'range' ? (p.step ?? 0) : 0,
        defValue: p.defaultValue,
        options:
          p.type === 'select'
            ? p.options.map((o) => ({ value: o.value, label: resolveLabel(o.labelKey, tr) }))
            : [],
      }));
  });

  /** 色相 / 色调这类是**抽象偏移**，渐变背景只会误导 —— 只有色温带渐变。 */
  const GRADIENT_KEYS = new Set(['temp']);

  function resetParam(inst: EffectInstance, key: string, fallback: number): void {
    writeOn(inst.instanceId, (it) => {
      it.values[key] = fallback;
    });
    commit();
  }

  /** 停用的模块要明说：不然「改了没反应」会被当成 bug（它确实像）。 */
  function enable(inst: EffectInstance): void {
    appState.store.updateClip(clip!.id, tr('insp.editEffectParam'), (c) => {
      if (c.kind !== 'effect') return;
      const target = c.chain.find((i) => i.instanceId === inst.instanceId);
      if (target) target.enabled = true;
    });
  }

  /* ------------------------------------------------ 两块之间的拖拽 */

  let rowEl = $state<HTMLElement | null>(null);
  let dragging = $state(false);

  function startSplit(e: PointerEvent): void {
    if (e.button !== 0) return;
    e.preventDefault();
    const el = e.currentTarget as HTMLElement;
    el.setPointerCapture(e.pointerId);
    dragging = true;
    const mv = (ev: PointerEvent): void => {
      const box = rowEl?.getBoundingClientRect();
      if (!box || box.width <= 0) return;
      gradePanels.setWheelsFrac((ev.clientX - box.left) / box.width);
    };
    const up = (ev: PointerEvent): void => {
      el.removeEventListener('pointermove', mv);
      el.removeEventListener('pointerup', up);
      el.removeEventListener('pointercancel', up);
      if (el.hasPointerCapture(ev.pointerId)) el.releasePointerCapture(ev.pointerId);
      dragging = false;
    };
    el.addEventListener('pointermove', mv);
    el.addEventListener('pointerup', up);
    el.addEventListener('pointercancel', up);
  }

  const bothOpen = $derived(gradePanels.wheels && gradePanels.curves);
</script>

<div
  class="gp"
  data-dragging={dragging ? 'on' : undefined}
  class:both={bothOpen}
  bind:this={rowEl}
  style:--wf={gradePanels.wheelsFrac}
  data-testid="grade-panels"
>
  {#if gradePanels.wheels}
    <section
      class="gp-cell gp-wheels"
      data-testid="grade-wheels-panel"
      aria-label={tr('grade.colWheels')}
    >
      <header class="gp-head">
        <h4 class="gp-h">{tr('grade.colWheels')}</h4>
        {#if basics.length > 1}
          <div class="gp-tabs" role="tablist" aria-label={tr('grade.module')}>
            {#each basics as inst (inst.instanceId)}
              {@const e = getEffect(inst.defId)}
              <button
                class="gp-tab"
                class:on={inst.instanceId === basicInst?.instanceId}
                type="button"
                role="tab"
                aria-selected={inst.instanceId === basicInst?.instanceId}
                data-testid={`grade-tab-${inst.defId}-${inst.instanceId}`}
                onclick={() => (appState.gradeInstanceId = inst.instanceId)}
              >
                {e ? resolveLabel(e.nameKey, tr) : inst.defId}
              </button>
            {/each}
          </div>
        {/if}
        <div class="gp-head-tail">
          {#if basicInst}
            <button
              class="gp-link"
              type="button"
              data-testid="grade-reset-all"
              onclick={() => basicInst && resetAllWheels(basicInst)}
            >
              {tr('grade.resetAll')}
            </button>
          {/if}
          <IconButton
            icon="x"
            label={tr('grade.panelCollapse', { name: tr('grade.colWheels') })}
            size="sm"
            testid="grade-close-wheels"
            onclick={() => gradePanels.set('wheels', false)}
          />
        </div>
      </header>

      <div class="gp-body">
        {#if basicInst && !basicInst.enabled}
          <p class="gp-note gp-warn" data-testid="grade-wheels-disabled">
            {tr('grade.moduleDisabled')}
            <button class="gp-link" type="button" onclick={() => enable(basicInst)}>
              {tr('grade.enableModule')}
            </button>
          </p>
        {/if}

        {#if basicInst}
          {@const inst = basicInst}
          <div class="gp-wheel-row">
            {#each WHEELS as spec (spec.group)}
              <ColorWheel
                inst={inst}
                {spec}
                onvalue={(fn) => writeOn(inst.instanceId, fn)}
                oncommit={commit}
              />
            {/each}
          </div>

          {#if rows.length > 0}
            <div class="gp-params">
              {#each rows as p (p.key)}
                {#if p.type === 'range'}
                  {@const grad = GRADIENT_KEYS.has(p.key) ? paramGradient(p.key) : null}
                  <div class="gp-row">
                    <span class="gp-row-l">{p.label}</span>
                    {#if grad}
                      <GradientSlider
                        value={Number(p.value)}
                        min={p.min}
                        max={p.max}
                        step={p.step}
                        gradient={grad}
                        neutral={Number(p.defValue)}
                        ariaLabel={p.label}
                        testid={`grade-param-${p.key}`}
                        oninput={(v) => writeOn(inst.instanceId, (it) => (it.values[p.key] = v))}
                        onchange={commit}
                      />
                    {:else}
                      <Slider
                        value={Number(p.value)}
                        min={p.min}
                        max={p.max}
                        step={p.step}
                        ariaLabel={p.label}
                        testid={`grade-param-${p.key}`}
                        oninput={(v) => writeOn(inst.instanceId, (it) => (it.values[p.key] = v))}
                        onchange={commit}
                      />
                    {/if}
                    <NumberInput
                      value={Number(p.value)}
                      min={p.min}
                      max={p.max}
                      step={p.step}
                      width={52}
                      ariaLabel={p.label}
                      testid={`grade-param-num-${p.key}`}
                      oninput={(v) => writeOn(inst.instanceId, (it) => (it.values[p.key] = v))}
                      onchange={(v) => {
                        writeOn(inst.instanceId, (it) => (it.values[p.key] = v));
                        commit();
                      }}
                    />
                    <IconButton
                      icon="rotate-ccw"
                      label={tr('grade.resetShort')}
                      size="sm"
                      testid={`grade-param-reset-${p.key}`}
                      onclick={() => resetParam(inst, p.key, Number(p.defValue))}
                    />
                  </div>
                {:else if p.type === 'select'}
                  <div class="gp-row gp-row-select">
                    <span class="gp-row-l">{p.label}</span>
                    <Select
                      value={String(p.value)}
                      options={p.options}
                      testid={`grade-param-${p.key}`}
                      optionTestidPrefix={`grade-param-${p.key}-opt`}
                      onchange={(v) => {
                        writeOn(inst.instanceId, (it) => {
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
        {:else}
          <p class="gp-note">{tr('grade.noWheel')}</p>
        {/if}
      </div>
    </section>
  {/if}

  {#if bothOpen}
    <div
      class="gp-split"
      class:active={dragging}
      role="separator"
      aria-orientation="vertical"
      aria-label={tr('grade.splitPanels')}
      data-testid="grade-panels-split"
      onpointerdown={startSplit}
    ></div>
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
            label={tr('grade.panelCollapse', { name: tr('grade.colCurves') })}
            size="sm"
            testid="grade-close-curves"
            onclick={() => gradePanels.set('curves', false)}
          />
        </div>
      </header>

      <div class="gp-body">
        {#if curvesInst && clip}
          {#if !curvesInst.enabled}
            <p class="gp-note gp-warn" data-testid="grade-curves-disabled">
              {tr('grade.moduleDisabled')}
              <button class="gp-link" type="button" onclick={() => enable(curvesInst)}>
                {tr('grade.enableModule')}
              </button>
            </p>
          {/if}
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
    background: var(--border);
    overflow: hidden;
  }
  /* 拖动中禁止选中文本（与时间轴 / 抽屉同一处理）。 */
  .gp[data-dragging='on'] {
    user-select: none;
  }
  .gp-cell {
    display: flex;
    flex-direction: column;
    min-width: 0;
    min-height: 0;
    background: var(--surface-1);
  }
  /* 只有一块开着时吃满；两块都开时按拖出来的比例分（`--wf`，见 `grade-panels`）。 */
  .gp-wheels {
    flex: 1 1 0;
  }
  .gp.both .gp-wheels {
    flex: 0 0 calc((100% - 4px) * var(--wf, 0.55));
  }
  .gp-curves {
    flex: 1 1 0;
  }
  /*
   * 4px 竖条：命中区比视觉宽（左右各外扩 2px），但**不占更多列宽** ——
   * 与排版页的 `.split` 同一套做法。
   */
  .gp-split {
    flex: 0 0 4px;
    cursor: col-resize;
    background: var(--border);
  }
  .gp-split:hover,
  .gp-split.active {
    background: var(--accent);
  }
  .gp-head {
    display: flex;
    align-items: center;
    gap: var(--sp-2);
    padding: var(--sp-1) var(--sp-1) var(--sp-1) var(--sp-3);
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
  .gp-hint {
    font-size: var(--fs-xs);
    color: var(--text-muted);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    min-width: 0;
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
   * 四列等宽 + 最小 120px：120 是「四个 42px 数值框」放得下的下限。
   * 再窄数值框就会叠在一起；格子自身还有 196px 上限（见 `ColorWheel`）。
   */
  .gp-wheel-row {
    display: grid;
    grid-template-columns: repeat(4, minmax(120px, 1fr));
    gap: var(--sp-2);
    /* 不许被压缩：flex 项的默认 `shrink: 1` 会把这一块压到比内容矮，
       而溢出**不计入**滚动高度 —— 表现是最后一行被面板下沿切掉一半，
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
  .gp-warn {
    color: var(--warning);
  }
  .gp-empty {
    display: flex;
    flex-direction: column;
    align-items: flex-start;
    gap: var(--sp-2);
  }
  /* 曲线那一栏：图按宽度算尺寸，剩下的高度居中（顶对齐会在下方空一大片）。 */
  .gp-curves .gp-body {
    justify-content: center;
  }
</style>
