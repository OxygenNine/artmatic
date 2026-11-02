<script lang="ts">
  /**
   * GradeEditor — 调色面板（三栏：一级校色 / 曲线 / 示波器）。
   *
   * 它不是通用特效检查器：检查器是「一个参数一行」的清单，而调色是看数值
   * 之外的东西（色轮位置、曲线形状、波形）。所以这里**只**服务于 `grade-*`
   * 模块，普通特效仍然走检查器。
   *
   * 三件必须出现在面板里、而且只有面板能做的：
   *  1. **分级信息条**：这一条链作用在哪个片段 / 哪几条轨。用户以为在调 A
   *     其实在调整条时间线，是这个功能最容易犯的错。
   *  2. **前 / 后对比**：走渲染旁路（`appState.setGradeBypass`），不动工程。
   *  3. **精度提示**：链里有调色而本帧拿不到 16F 时，说清楚按 8 位在算。
   */
  import type { EffectClip, EffectInstance } from '../../core/schema';
  import { affectedVisualIndices, visualTracks } from '../../engine/stack';
  import { tr } from '../../i18n/index.svelte';
  import { resolveLabel } from '../../i18n/label';
  import { defaultEffectValues, getEffect } from '../../effects/registry';
  import { newId } from '../../core/schema';
  import Modal from '../controls/Modal.svelte';
  import Button from '../controls/Button.svelte';
  import Slider from '../controls/Slider.svelte';
  import NumberInput from '../controls/NumberInput.svelte';
  import Select from '../controls/Select.svelte';
  import { appState } from '../app-state.svelte';
  import ColorWheel from './ColorWheel.svelte';
  import ToneCurveEditor from './ToneCurveEditor.svelte';
  import Scopes from './Scopes.svelte';
  import { WHEELS, gradeInstances, isBasic } from './grade-ops';
  import { importLutFile, lutAssets } from './lut-import';
  import { visibleParams } from '../../effects/types';

  interface Props {
    clip: EffectClip;
    onclose: () => void;
  }
  const { clip, onclose }: Props = $props();

  /*
   * ⚠️ 每个派生都要 `void appState.version`：`clip` 是 store 里的**普通对象**
   * （不是 `$state` 代理），链上 push 一个模块时引用不变，$derived 会认为
   * 「没变」而不再计算 —— 表现是「点了『加上曲线』，右边什么都不出现」。
   * 与检查器里那几个派生的理由是同一个。
   */
  const instances = $derived.by(() => {
    void appState.version;
    return gradeInstances(clip.chain);
  });
  /** 当前模块：用户选的，缺省是链上第一个调色模块。 */
  const active = $derived.by<EffectInstance | undefined>(() => {
    void appState.version;
    return instances.find((i) => i.instanceId === appState.gradeInstanceId) ?? instances[0];
  });
  const entry = $derived.by(() => {
    void appState.version;
    return active ? getEffect(active.defId) : undefined;
  });
  /**
   * 链上的曲线模块（编辑区始终认它，而不管当前选中的是哪个模块）。
   *
   * 中间那一栏是「整条链的曲线」，不是「当前模块的曲线」—— 调色是按模块串行的，
   * 但用户的动作是「给这个镜头加一条 S 曲线」，不该先切模块再找入口。
   */
  const curvesInst = $derived.by(() => {
    void appState.version;
    return instances.find((i) => i.defId === 'grade-curves');
  });
  const lutInst = $derived.by(() => {
    void appState.version;
    return instances.find((i) => i.defId === 'grade-lut');
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

  /**
   * 分级信息条的数据。与检查器同一份判据（`affectedVisualIndices`），
   * 不在 UI 里另算一遍 —— 对不上时不报错，只是显示错。
   */
  const scope = $derived.by(() => {
    void appState.version;
    const bound = clip.boundClipId ? appState.store.findClip(clip.boundClipId) : null;
    if (bound) {
      return {
        text: tr('grade.infoBound', { name: bound.clip.label }),
        empty: false,
      };
    }
    const depth = clip.affectDepth ?? 0;
    if (depth <= 0) return { text: tr('grade.infoAll'), empty: false };
    const visuals = visualTracks(appState.project);
    const self = visuals.findIndex((t) => t.clips.some((c) => c.id === clip.id));
    const names = affectedVisualIndices(visuals, self, depth).map((i) => visuals[i]!.name);
    if (names.length === 0) return { text: tr('grade.infoEmpty'), empty: true };
    return { text: tr('grade.infoTracks', { names: names.join(tr('common.listSep')) }), empty: false };
  });

  const precision = $derived.by(() => {
    void appState.version;
    const s = appState.renderer.gradeStats();
    if (!s.floatSupported) return tr('insp.gradeNoFloat');
    if (s.reason === 'over-budget') return tr('insp.gradeBudget');
    return null;
  });

  /**
   * 写一个参数。
   *
   * 拖动期间每帧调用：如果不在事务里就先开一个，于是**一次拖动 = 一条撤销**
   * （不包事务的话每次 pointermove 都会进撤销栈，用户按十次撤销才回到拖动前）。
   * 手势结束由 `onchange` 收口。
   */
  function writeOn(instanceId: string, mutate: (inst: EffectInstance) => void): void {
    const store = appState.store;
    if (!store.inTx) store.beginTx();
    store.updateClip(clip.id, tr('insp.editEffectParam'), (c) => {
      if (c.kind !== 'effect') return;
      const target = c.chain.find((i) => i.instanceId === instanceId);
      if (target) mutate(target);
    });
  }

  /** 当前模块的写入入口（色轮与普通参数用它）。 */
  function write(mutate: (inst: EffectInstance) => void): void {
    if (active) writeOn(active.instanceId, mutate);
  }

  function commit(): void {
    const store = appState.store;
    if (store.inTx) store.endTx(tr('insp.editEffectParam'));
  }

  /** 往链尾追加一个调色模块（同一笔撤销，与检查器的「添加特效」一致）。 */
  function addModule(defId: string): string {
    const inst = { instanceId: newId(), defId, enabled: true, values: defaultEffectValues(defId) };
    appState.store.updateClip(clip.id, tr('insp.addEffect'), (c) => {
      if (c.kind === 'effect') c.chain.push(inst);
    });
    appState.gradeInstanceId = inst.instanceId;
    return inst.instanceId;
  }

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

  /** basic 之外的那些参数（对比 / 饱和 / 色相 / 色温色调），一行一个。 */
  const plainParams = $derived.by(() => {
    void appState.version;
    if (!active || !entry) return [];
    return visibleParams(entry.params, active.values).filter(
      (p) => (p.type === 'range' || p.type === 'select') && !p.key.includes('#') && !WHEELS.some((w) => p.key === `${w.group}#m`),
    );
  });
</script>

<Modal
  title={tr('grade.title')}
  {onclose}
  width="grade"
  flushBody
  testid="grade-editor"
>
  <div class="ge">
    <div class="ge-bar">
      <button
        class="ge-ab"
        class:on={appState.gradeBypass}
        type="button"
        data-testid="grade-ab"
        onclick={() => appState.setGradeBypass(!appState.gradeBypass)}
      >
        {appState.gradeBypass ? tr('grade.before') : tr('grade.after')}
      </button>
      <span class="ge-scope" class:warn={scope.empty} data-testid="grade-scope">{scope.text}</span>
      {#if precision}
        <span class="ge-precision" data-testid="grade-precision">{precision}</span>
      {/if}
      {#if instances.length > 1}
        <div class="ge-tabs" role="tablist" aria-label={tr('grade.module')}>
          {#each instances as inst (inst.instanceId)}
            {@const e = getEffect(inst.defId)}
            <button
              class="ge-tab"
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
    </div>

    <div class="ge-body">
      <section class="ge-col" aria-label={tr('grade.colWheels')}>
        <h4 class="ge-h">{tr('grade.colWheels')}</h4>
        {#if active && isBasic(active)}
          <div class="ge-wheels">
            {#each WHEELS as spec (spec.group)}
              <ColorWheel inst={active} {spec} onvalue={write} oncommit={commit} />
            {/each}
          </div>
          <div class="ge-rows">
            {#each plainParams as p (p.key)}
              {#if p.type === 'range'}
                <div class="ge-row">
                  <span class="ge-row-l">{resolveLabel(p.labelKey, tr)}</span>
                  <Slider
                    value={Number(active.values[p.key] ?? p.defaultValue)}
                    min={p.min}
                    max={p.max}
                    step={p.step}
                    ariaLabel={resolveLabel(p.labelKey, tr)}
                    testid={`grade-param-${p.key}`}
                    oninput={(v) => write((it) => (it.values[p.key] = v))}
                    onchange={commit}
                  />
                  <NumberInput
                    value={Number(active.values[p.key] ?? p.defaultValue)}
                    min={p.min}
                    max={p.max}
                    step={p.step}
                    width={58}
                    ariaLabel={resolveLabel(p.labelKey, tr)}
                    testid={`grade-param-num-${p.key}`}
                    oninput={(v) => write((it) => (it.values[p.key] = v))}
                    onchange={(v) => {
                      write((it) => (it.values[p.key] = v));
                      commit();
                    }}
                  />
                </div>
              {:else if p.type === 'select'}
                <div class="ge-row ge-row-select">
                  <span class="ge-row-l">{resolveLabel(p.labelKey, tr)}</span>
                  <Select
                    value={String(active.values[p.key] ?? p.defaultValue)}
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
        {:else}
          <p class="ge-note">{tr('grade.noWheel')}</p>
        {/if}
      </section>

      <section class="ge-col" aria-label={tr('grade.colCurves')}>
        <h4 class="ge-h">{tr('grade.colCurves')}</h4>
        {#if curvesInst}
          <ToneCurveEditor
            inst={curvesInst}
            onvalue={(fn) => writeOn(curvesInst!.instanceId, fn)}
            oncommit={commit}
          />
          <p class="ge-note">{tr('grade.curveHint')}</p>
        {:else}
          <p class="ge-note">{tr('grade.curvesMissing')}</p>
          <div>
            <Button
              label={tr('grade.addCurves')}
              icon="plus"
              variant="outline"
              testid="grade-add-curves"
              onclick={() => addModule('grade-curves')}
            />
          </div>
        {/if}

        <!-- 查找表：与曲线同栏（两者都是「这一段的样子」而不是「一级校色」）。 -->
        <div class="ge-lut" data-testid="grade-lut-block">
          <div class="ge-lut-head">
            <span class="ge-row-l">{tr('fx.gradeLut')}</span>
            <span class="ge-lut-name" data-testid="grade-lut-name">
              {lutName ?? tr('grade.lutNone')}
            </span>
            <label class="ge-lut-pick" title={tr('grade.lutImport')}>
              <input
                type="file"
                accept=".cube"
                data-testid="grade-lut-input"
                onchange={pickLut}
              />
              {tr('grade.lutImport')}
            </label>
          </div>
          {#if lutOptions.length > 1 || (lutInst && !lutName)}
            <Select
              value={String(lutInst?.values['lutAssetId'] ?? '')}
              options={[{ value: '', label: tr('grade.lutNone') }, ...lutOptions]}
              testid="grade-lut-select"
              onchange={(v) => {
                if (!lutInst) addModule('grade-lut');
                const target = lutInst?.instanceId ?? instances[instances.length - 1]!.instanceId;
                writeOn(target, (it) => {
                  it.values['lutAssetId'] = v;
                });
                commit();
              }}
            />
          {/if}
        </div>
      </section>

      <section class="ge-col ge-col-scope" aria-label={tr('grade.colScopes')}>
        <h4 class="ge-h">{tr('grade.colScopes')}</h4>
        <Scopes />
      </section>
    </div>
  </div>
</Modal>

<style>
  .ge {
    display: flex;
    flex-direction: column;
    min-height: 0;
    flex: 1;
  }
  /* 顶栏：作用范围 + 精度提示 + 模块切换。它是**读数区**，不是工具栏。 */
  .ge-bar {
    display: flex;
    align-items: center;
    gap: var(--sp-3);
    padding: var(--sp-2) var(--sp-4);
    border-bottom: 1px solid var(--border);
    flex-shrink: 0;
    min-width: 0;
  }
  .ge-ab {
    height: var(--control-h-sm);
    padding: 0 var(--sp-3);
    background: var(--btn-bg);
    border: 1px solid var(--btn-border);
    border-radius: var(--radius-sm);
    color: var(--text-secondary);
    font: inherit;
    font-size: var(--fs-xs);
    cursor: pointer;
    flex: none;
  }
  .ge-ab:hover {
    color: var(--text-primary);
  }
  /* 按下去时是「你现在看的是原片」——用主题色标出来，避免忘了自己在对比。 */
  .ge-ab.on {
    border-color: var(--accent-border);
    color: var(--accent);
  }
  .ge-scope {
    font-size: var(--fs-xs);
    color: var(--text-secondary);
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .ge-scope.warn {
    color: var(--warning);
  }
  .ge-precision {
    font-size: var(--fs-xs);
    color: var(--warning);
    flex: none;
  }
  .ge-tabs {
    display: flex;
    gap: var(--sp-1);
    margin-left: auto;
    flex: none;
  }
  .ge-tab {
    height: var(--control-h-sm);
    padding: 0 var(--sp-3);
    background: transparent;
    border: 1px solid transparent;
    border-radius: var(--radius-sm);
    color: var(--text-muted);
    font: inherit;
    font-size: var(--fs-xs);
    cursor: pointer;
  }
  .ge-tab:hover {
    color: var(--text-secondary);
  }
  .ge-tab.on {
    border-color: var(--border-strong);
    color: var(--text-primary);
  }

  .ge-body {
    display: grid;
    grid-template-columns: minmax(0, 1.15fr) minmax(0, 1fr) minmax(0, 1fr);
    gap: 1px;
    background: var(--border);
    flex: 1;
    min-height: 0;
  }
  .ge-col {
    display: flex;
    flex-direction: column;
    gap: var(--sp-3);
    padding: var(--sp-4);
    background: var(--surface-1);
    min-width: 0;
    min-height: 0;
    overflow: auto;
  }
  .ge-h {
    margin: 0;
    font-size: var(--fs-xs);
    font-weight: 600;
    letter-spacing: 0.04em;
    color: var(--text-muted);
  }
  .ge-wheels {
    display: grid;
    grid-template-columns: repeat(3, minmax(0, 1fr));
    gap: var(--sp-2);
  }
  /* 1px 结构线：三个轮盘挨在一起时，「这是哪一个的复位」靠它读。 */
  .ge-wheels > :global(* + *) {
    border-left: 1px solid var(--border);
  }
  .ge-rows {
    display: flex;
    flex-direction: column;
    gap: var(--sp-2);
    border-top: 1px solid var(--border);
    padding-top: var(--sp-3);
  }
  .ge-row {
    display: grid;
    grid-template-columns: 62px minmax(0, 1fr) auto;
    align-items: center;
    gap: var(--sp-2);
  }
  .ge-row-l {
    font-size: var(--fs-xs);
    color: var(--text-secondary);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .ge-lut {
    display: flex;
    flex-direction: column;
    gap: var(--sp-2);
    border-top: 1px solid var(--border);
    padding-top: var(--sp-3);
  }
  .ge-lut-head {
    display: flex;
    align-items: center;
    gap: var(--sp-2);
    min-width: 0;
  }
  .ge-lut-name {
    font-size: var(--fs-xs);
    color: var(--text-secondary);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  /* 文件选择：原生 input 太丑，用 label 顶替，input 自己藏起来但仍是可点的。 */
  .ge-lut-pick {
    margin-left: auto;
    flex: none;
    height: var(--control-h-sm);
    padding: 0 var(--sp-2);
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    font-size: var(--fs-xs);
    color: var(--text-secondary);
    cursor: pointer;
  }
  .ge-lut-pick:hover {
    border-color: var(--border-strong);
  }
  .ge-lut-pick input {
    display: none;
  }
  .ge-row-select {
    grid-template-columns: 62px minmax(0, 1fr);
  }
  .ge-note {
    margin: 0;
    font-size: var(--fs-xs);
    color: var(--text-muted);
    line-height: 1.5;
  }
</style>
