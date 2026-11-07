<script lang="ts">
  /**
   * LabParams — 右栏：源参数 + 特效参数 + 编译日志。
   *
   * 为什么两块参数同时显示，而不是"跟着左栏选中项走"：
   * 试炼场最常做的动作是**同时**调源与特效（源给一个更锐利的测试图、
   * 特效再压一层），一次只显示一块的话每次都要点回去。
   * 左边两张清单本来就是并置的，右边也并置才对称。
   *
   * 控件按 `ParamDef` 生成 —— 与 `ui/Inspector.svelte` 走同一套类型系统
   * （effects 与 algos 共用），所以这里不需要知道任何一个具体特效长什么样。
   */
  import Field from '../src/ui/controls/Field.svelte';
  import NumericField from '../src/ui/controls/NumericField.svelte';
  import Select from '../src/ui/controls/Select.svelte';
  import Checkbox from '../src/ui/controls/Checkbox.svelte';
  import BitmaskField from '../src/ui/controls/BitmaskField.svelte';
  import PatternField from '../src/ui/controls/PatternField.svelte';
  import TextField from '../src/ui/controls/TextField.svelte';
  import IconButton from '../src/ui/controls/IconButton.svelte';
  import ColorField from '../src/ui/controls/ColorField.svelte';
  import { labState, itemFor, paramsFor, NO_EFFECT_ID } from './lab-state.svelte';
  import { tr } from '../src/i18n/index.svelte';
  import { resolveLabel } from '../src/i18n/label';
  import { visibleParams, type ParamDef } from '../src/effects/types';
  import { gridSizeFromDefs } from '../src/algos/grid-dims';
  // 取色卡给的是主题色引用（`@accent1`），而算法/特效参数直接进 `hexToRgba()`，
  // 引用在那里会退化成**品红**。与检查器同一条纪律：写入时就解析成裸 hex。
  import { resolveThemeColor } from '../src/typography/theme';

  // 两处都要过 `visibleWhen`。**主应用的 Inspector 一直是这么做的，试炼场漏了** ——
  // 于是 clock 的 `division`、channel-split-prism 的分模式参数在 lab 里全都常显。
  // 试炼场是「新增参数类型（含 visibleWhen）的 testbed」，这里与产品端不一致，
  // 等于 testbed 测不到产品行为。
  const sourceParams = $derived(visibleParams(paramsFor('source', labState.sourceId), labState.sourceParams));
  /** 源生成器的网格尺寸（图案导入按它采样）。没有网格参数的生成器是 null。 */
  const sourceGrid = $derived(
    gridSizeFromDefs(labState.sourceParams, paramsFor('source', labState.sourceId)) ?? undefined,
  );
  const effectParams = $derived(
    visibleParams(paramsFor('effect', labState.effectId ?? NO_EFFECT_ID), labState.effectParams),
  );
  const failures = $derived((labState.compileResults ?? []).filter((r) => !r.ok));

  /**
   * 右栏标题里的特效名 + id。试炼场的活儿就是「决定这个特效留不留、参数定多少」，
   * 而**要落进代码的是 id**（文件名、i18n 键、CREDITS 都按它写），不是显示名 ——
   * 所以两个并排给出来，省得来回翻左栏或源码。
   */
  const effectItem = $derived(
    labState.effectId ? itemFor('effect', labState.effectId) : undefined,
  );

  function valueOf(scope: 'source' | 'effect', p: ParamDef): number | string {
    const bag = scope === 'source' ? labState.sourceParams : labState.effectParams;
    return bag[p.key] ?? p.defaultValue;
  }
</script>

<aside class="lab-panel" data-testid="lab-params">
  <div class="lab-scroll">
    <section class="lab-section">
      <header class="lab-section-head">
        <h3 class="lab-section-title">{tr('lab.paramsSource')}</h3>
        <IconButton
          icon="rotate-cw"
          label={tr('lab.reset')}
          size="sm"
          tipPlacement="top"
          testid="lab-reset-source"
          onclick={() => labState.resetParams('source')}
        />
        <IconButton
          icon="wand-sparkles"
          label={tr('lab.randomize')}
          tipText={tr('lab.randomizeTip')}
          size="sm"
          tipPlacement="top"
          testid="lab-random-source"
          onclick={() => labState.randomizeParams('source')}
        />
      </header>

      {#if sourceParams.length === 0}
        <p class="lab-note">{tr('lab.noParams')}</p>
      {:else}
        {#each sourceParams as p (p.key)}
          <div data-testid={`lab-source-param-${p.key}`}>
            {#if p.type === 'range'}
              <NumericField
                label={resolveLabel(p.labelKey, tr)}
                labelWidth={78}
                min={p.min}
                max={p.max}
                step={p.step}
                value={Number(valueOf('source', p))}
                numberWidth={62}
                sliderTestid={`lab-source-slider-${p.key}`}
                numberTestid={`lab-source-num-${p.key}`}
                oninput={(v) => labState.setParam('source', p.key, v)}
              />
            {:else if p.type === 'select'}
              <Field label={resolveLabel(p.labelKey, tr)} labelWidth={78}>
                <Select
                  value={String(valueOf('source', p))}
                  options={p.options.map((o) => ({ value: o.value, label: resolveLabel(o.labelKey, tr) }))}
                  testid={`lab-source-select-${p.key}`}
                  optionTestidPrefix={`lab-source-select-${p.key}-opt`}
                  onchange={(v) => labState.setParam('source', p.key, v)}
                />
              </Field>
            {:else if p.type === 'checkbox'}
              <Field label={resolveLabel(p.labelKey, tr)} labelWidth={78}>
                <Checkbox
                  checked={Number(valueOf('source', p)) !== 0}
                  testid={`lab-source-check-${p.key}`}
                  onchange={(v) => labState.setParam('source', p.key, v ? 1 : 0)}
                />
              </Field>
            {:else if p.type === 'color'}
              <Field label={resolveLabel(p.labelKey, tr)} labelWidth={78}>
                <ColorField
                  label={resolveLabel(p.labelKey, tr)}
                  value={String(valueOf('source', p))}
                  testid={`lab-source-color-${p.key}`}
                  onchange={(v) => labState.setParam('source', p.key, resolveThemeColor(v))}
                />
              </Field>
            {:else if p.type === 'bitmask'}
              <Field label={resolveLabel(p.labelKey, tr)} labelWidth={78}>
                <BitmaskField
                  value={Number(valueOf('source', p))}
                  bits={p.bits}
                  slider={p.slider}
                  groups={p.groups.map((g) => ({ label: resolveLabel(g.labelKey, tr), bits: g.bits, style: g.style }))}
                  presets={p.presets?.map((o) => ({ label: resolveLabel(o.labelKey, tr), value: o.value }))}
                  testid={`lab-source-bitmask-${p.key}`}
                  oninput={(v) => labState.setParam('source', p.key, v)}
                  onchange={(v) => labState.setParam('source', p.key, v)}
                />
              </Field>
            {:else if p.type === 'pattern'}
              <Field label={resolveLabel(p.labelKey, tr)} labelWidth={78}>
                <PatternField
                  value={String(valueOf('source', p))}
                  label={resolveLabel(p.labelKey, tr)}
                  mode={p.mode}
                  editorSize={p.editorSize}
                  grid={sourceGrid}
                  colors={{
                    bg: String(labState.sourceParams.colorBg ?? '#05070f'),
                    live: String(labState.sourceParams.colorLive ?? '#7fd4ff'),
                  }}
                  testid={`lab-source-pattern-${p.key}`}
                  onchange={(v) => labState.setParam('source', p.key, v)}
                />
              </Field>
            {:else if p.type === 'text'}
              <Field label={resolveLabel(p.labelKey, tr)} labelWidth={78}>
                <TextField
                  value={String(valueOf('source', p))}
                  ariaLabel={resolveLabel(p.labelKey, tr)}
                  multiline={p.multiline}
                  maxLength={p.maxLength}
                  placeholder={p.placeholderKey ? resolveLabel(p.placeholderKey, tr) : ''}
                  testid={`lab-source-text-${p.key}`}
                  onchange={(v) => labState.setParam('source', p.key, v)}
                />
              </Field>
            {/if}
          </div>
        {/each}
      {/if}
    </section>

    <section class="lab-section">
      <header class="lab-section-head">
        <h3 class="lab-section-title">
          {#if effectItem}
            <span class="lab-title-name" data-testid="lab-effect-name">{resolveLabel(effectItem.nameKey, tr)}</span>
            <code class="lab-id" data-testid="lab-effect-id">{effectItem.id}</code>
          {:else}
            <span class="lab-title-name">{tr('lab.paramsEffect')}</span>
          {/if}
        </h3>
        <IconButton
          icon="rotate-cw"
          label={tr('lab.reset')}
          size="sm"
          tipPlacement="top"
          testid="lab-reset-effect"
          onclick={() => labState.resetParams('effect')}
        />
        <IconButton
          icon="wand-sparkles"
          label={tr('lab.randomize')}
          tipText={tr('lab.randomizeTip')}
          size="sm"
          tipPlacement="top"
          testid="lab-random-effect"
          onclick={() => labState.randomizeParams('effect')}
        />
      </header>

      {#if !labState.effectId}
        <p class="lab-note">{tr('lab.none')}</p>
      {:else if effectParams.length === 0}
        <p class="lab-note">{tr('lab.noParams')}</p>
      {:else}
        {#each effectParams as p (p.key)}
          <div data-testid={`lab-effect-param-${p.key}`}>
            {#if p.type === 'range'}
              <NumericField
                label={resolveLabel(p.labelKey, tr)}
                labelWidth={78}
                min={p.min}
                max={p.max}
                step={p.step}
                value={Number(valueOf('effect', p))}
                numberWidth={62}
                sliderTestid={`lab-effect-slider-${p.key}`}
                numberTestid={`lab-effect-num-${p.key}`}
                oninput={(v) => labState.setParam('effect', p.key, v)}
              />
            {:else if p.type === 'select'}
              <Field label={resolveLabel(p.labelKey, tr)} labelWidth={78}>
                <Select
                  value={String(valueOf('effect', p))}
                  options={p.options.map((o) => ({ value: o.value, label: resolveLabel(o.labelKey, tr) }))}
                  testid={`lab-effect-select-${p.key}`}
                  optionTestidPrefix={`lab-effect-select-${p.key}-opt`}
                  onchange={(v) => labState.setParam('effect', p.key, v)}
                />
              </Field>
            {:else if p.type === 'checkbox'}
              <Field label={resolveLabel(p.labelKey, tr)} labelWidth={78}>
                <Checkbox
                  checked={Number(valueOf('effect', p)) !== 0}
                  testid={`lab-effect-check-${p.key}`}
                  onchange={(v) => labState.setParam('effect', p.key, v ? 1 : 0)}
                />
              </Field>
            {:else if p.type === 'color'}
              <Field label={resolveLabel(p.labelKey, tr)} labelWidth={78}>
                <ColorField
                  label={resolveLabel(p.labelKey, tr)}
                  value={String(valueOf('effect', p))}
                  testid={`lab-effect-color-${p.key}`}
                  onchange={(v) => labState.setParam('effect', p.key, resolveThemeColor(v))}
                />
              </Field>
            {:else if p.type === 'bitmask'}
              <Field label={resolveLabel(p.labelKey, tr)} labelWidth={78}>
                <BitmaskField
                  value={Number(valueOf('effect', p))}
                  bits={p.bits}
                  slider={p.slider}
                  groups={p.groups.map((g) => ({ label: resolveLabel(g.labelKey, tr), bits: g.bits, style: g.style }))}
                  presets={p.presets?.map((o) => ({ label: resolveLabel(o.labelKey, tr), value: o.value }))}
                  testid={`lab-effect-bitmask-${p.key}`}
                  oninput={(v) => labState.setParam('effect', p.key, v)}
                  onchange={(v) => labState.setParam('effect', p.key, v)}
                />
              </Field>
            {:else if p.type === 'pattern'}
              <Field label={resolveLabel(p.labelKey, tr)} labelWidth={78}>
                <PatternField
                  value={String(valueOf('effect', p))}
                  label={resolveLabel(p.labelKey, tr)}
                  mode={p.mode}
                  editorSize={p.editorSize}
                  colors={{
                    bg: String(labState.effectParams.colorBg ?? '#05070f'),
                    live: String(labState.effectParams.colorLive ?? '#7fd4ff'),
                  }}
                  testid={`lab-effect-pattern-${p.key}`}
                  onchange={(v) => labState.setParam('effect', p.key, v)}
                />
              </Field>
            {:else if p.type === 'text'}
              <Field label={resolveLabel(p.labelKey, tr)} labelWidth={78}>
                <TextField
                  value={String(valueOf('effect', p))}
                  ariaLabel={resolveLabel(p.labelKey, tr)}
                  multiline={p.multiline}
                  maxLength={p.maxLength}
                  placeholder={p.placeholderKey ? resolveLabel(p.placeholderKey, tr) : ''}
                  testid={`lab-effect-text-${p.key}`}
                  onchange={(v) => labState.setParam('effect', p.key, v)}
                />
              </Field>
            {/if}
          </div>
        {/each}
      {/if}
    </section>
  </div>

  {#if failures.length > 0}
    <div class="lab-errors">
      <h4 class="lab-section-title">{tr('lab.errorLog')}</h4>
      <pre class="lab-error-text" data-testid="lab-error-log">{failures
          .map((f) => `${f.id}: ${f.error ?? ''}`)
          .join('\n\n')}</pre>
    </div>
  {/if}
</aside>

<style>
  .lab-panel {
    display: grid;
    grid-template-rows: minmax(0, 1fr) auto;
    background: var(--surface-1);
    border-left: 1px solid var(--border);
    min-height: 0;
  }
  :global(.lab-panel .field) {
    padding-left: var(--sp-4); /* 无 inspector 包裹，必须手动设置 padding */
  }
  .lab-scroll {
    overflow-y: auto;
    padding-bottom: var(--sp-4);
  }
  .lab-section {
    padding-top: var(--sp-2);
    border-bottom: 1px solid var(--border);
  }
  .lab-section-head {
    display: flex;
    align-items: center;
    gap: var(--sp-1);
    padding: var(--sp-1) var(--sp-2) var(--sp-1) var(--sp-3);
  }
  .lab-section-title {
    flex: 1;
    display: flex;
    align-items: baseline;
    gap: var(--sp-2);
    min-width: 0; /* 长特效名要能省略号，不然会把右边两个按钮顶出去 */
    margin: 0;
    font-size: var(--fs-xs);
    font-weight: 600;
    letter-spacing: 0.06em;
    color: var(--text-muted);
    text-transform: uppercase;
  }
  .lab-title-name {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .lab-id {
    flex: none;
    /* 父级是 uppercase + 0.06em 字距；id 必须还原这两条，否则会显示成 NEON-EDGES */
    text-transform: none;
    letter-spacing: normal;
    font-family: var(--font-mono);
    font-weight: 400;
    opacity: 0.7;
  }
  .lab-note {
    margin: 0 var(--sp-3) var(--sp-3);
    font-size: var(--fs-sm);
    color: var(--text-muted);
  }
  .lab-errors {
    max-height: 40%;
    overflow: auto;
    padding: var(--sp-2) var(--sp-3);
    border-top: 1px solid var(--border);
  }
  .lab-error-text {
    margin: var(--sp-1) 0 0;
    font-family: var(--font-mono);
    font-size: var(--fs-xs);
    line-height: 1.45;
    color: var(--danger);
    white-space: pre-wrap;
    word-break: break-word;
  }
</style>
