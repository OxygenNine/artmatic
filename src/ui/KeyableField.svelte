<script lang="ts">
  /**
   * KeyableField — 可打关键帧的数值参数行。
   *
   * 行为约定（沿用原实现，语义未改）：
   *   无曲线：滑杆/数字框改基值。
   *   有曲线：它们改的是**播放头处那个关键帧**（upsertKey）。
   *   ◆ 按钮：播放头处有 key 就删，没有就打（值取当前求值结果）。
   *   「锚到拍」勾选切换 beatAnchor——锚定后曲线的 t=0 对齐 anchor 拍，
   *   改 BPM / offset 时卡点自动跟随（AGENTS.md §5）。
   *
   * 硬契约：滑杆拖动时数字框必须与 store 逐帧一致（|shown - stored| < 1e-6）。
   * 两者读同一个 `value` 派生，所以天然 lock-step；别在这里给滑杆加节流。
   * 控件已全部换成自研件（原生 range/number/checkbox 在本项目禁用）。
   *
   * 数字框的 `oninput` 与 `onchange` 都接到 slide：拖拽时要有实时反馈（否则
   * 松手才出结果，drag-to-tweak 的手感就没了），松手再提交一次是幂等的
   * （updateClip 比对快照，值没变就不入撤销栈）。
   *
   * ## 参数的两层（v20）
   *
   * 这个控件同时是**调制器绑定的落点**：把左侧调制器条目拖到这一行上就追加一个
   * 槽，行尾的徽标（KC / M / KC+M）看得出这个参数被哪几层控制。
   * 读数走 `resolveParam` —— 与渲染同一条路径，所以「滑杆跟着画面动」这件事
   * 不需要额外同步逻辑（两处各算一份才是「读数与画面不一致」的来源）。
   */
  import Checkbox from './controls/Checkbox.svelte';
  import Field from './controls/Field.svelte';
  import IconButton from './controls/IconButton.svelte';
  import NumberInput from './controls/NumberInput.svelte';
  import Select from './controls/Select.svelte';
  import Slider from './controls/Slider.svelte';
  import { appState } from './app-state.svelte';
  import { openCurveEditor } from './curve-editor/curve-editor-state.svelte';
  import { evalCurve, type Curve } from '../core/curve';
  import { beatAtTime, snapBeat, timeAtBeat } from '../core/time';
  import { modTable, paramLayer, resolveParam, type ModSlot } from '../core/modulation';
  import { isModDrag, readModDrag } from './modulator/drag';
  import { tr } from '../i18n/index.svelte';

  interface Props {
    label: string;
    min: number;
    max: number;
    step: number;
    base: number;
    curve?: Curve;
    clipStart: number;
    onBase: (v: number) => void;
    onKey: (v: number, beatAnchor: { beat: number } | null) => void;
    onRemoveKey: (index: number) => void;
    onAnchorChange: (anchor: { beat: number } | null) => void;
    onClearCurve: () => void;
    /** 额外的说明，进 tooltip 与底栏。 */
    tipText?: string;
    /**
     * 编辑信号：本字段属于哪条片段 / 哪条曲线键。
     *
     * 拖动滑杆 / 数字框时写进 `appState.editingKey`，供**跨剪切点两帧预览**的
     * 自动模式判断「正在给哪条片段设关键帧值」（见 app-state 的字段注释）。
     * 用状态信号而不是 DOM 查询——检查器整块会被 structuredClone 重建，聚焦态很脆。
     */
    clipId?: string;
    curveKey?: string;
    /** 这个参数上的调制槽（缺省 = 没有调制）。 */
    mods?: ModSlot[];
    /** 写入调制槽。`null` = 清空该参数的全部调制。 */
    onMods?: (next: ModSlot[] | null) => void;
  }
  const {
    label,
    min,
    max,
    step,
    base,
    curve,
    clipStart,
    onBase,
    onKey,
    onRemoveKey,
    onAnchorChange,
    onClearCurve,
    tipText,
    clipId,
    curveKey,
    mods,
    onMods,
  }: Props = $props();

  const grid = $derived(appState.project.beatGrid);
  const playT = $derived(appState.playT);

  /**
   * 求值上下文：与渲染侧 **同一份** `resolveParam`。
   * `clipStart` 由调用方给（音频 gain 是 0，其余是片段起点），这里不再假定。
   */
  const rctx = $derived({
    grid,
    fps: appState.project.fps,
    seed: appState.project.seed,
    clipStart,
    mods: modTable(appState.project.modulators),
  });

  /**
   * 滑杆 / 数字框显示的值**只含关键帧，不含调制**。
   *
   * 这是一条刻意的不对称：这两者的写入端要改的是**基值 / 关键帧**，而调制是
   * 叠加在它之上的另一层。把它们混在一起会形成反馈 —— 拖到 v 的下一帧读数变成
   * `v + m`，把手就永远追不上指针，越拖越远。调制后的实际值放在槽面板里
   * （`live`），要看画面看预览。
   */
  const value = $derived(curve ? evalCurve(curve, playT, { grid, clipStart }) : base);

  /** 调制之后的实际值（只显示，不参与编辑）。 */
  const live = $derived.by(() => {
    const k = curveKey ?? '';
    if (!mods || mods.length === 0 || !k) return value;
    return resolveParam(
      { curves: curve ? { [k]: curve } : {}, mods: { [k]: mods } },
      k,
      base,
      playT,
      rctx,
    );
  });

  /** 三态：`KC` 关键帧 / `M` 调制 / `KC+M` 叠加。两者都没有时不画徽标。 */
  const layer = $derived(paramLayer(!!curve, (mods?.length ?? 0) > 0));

  const localT = $derived(
    curve?.beatAnchor ? playT - timeAtBeat(curve.beatAnchor.beat, grid) : playT - clipStart,
  );
  const keyHereIndex = $derived(
    curve ? curve.keys.findIndex((k) => Math.abs(k.t - localT) < Math.max(step / 2, 0.02)) : -1,
  );

  function slide(v: number): void {
    if (curve) onKey(v, curve.beatAnchor ?? null);
    else onBase(v);
  }

  /**
   * 只有**已经有曲线**的字段才算「在设关键帧的值」（没有曲线的拖动改的是基值）。
   * 上报之后由控件的收尾事件（滑杆 onchange / 数字框 onliveend）清掉。
   */
  function markEditing(): void {
    if (curve && clipId && curveKey) appState.beginEditKey(clipId, curveKey);
  }

  function beginSlide(v: number): void {
    markEditing();
    slide(v);
  }

  function toggleKey(): void {
    if (!curve) {
      onKey(
        value,
        appState.beatAnchorNewKeys
          ? { beat: snapBeat(beatAtTime(playT, grid), 'beat', grid.beatsPerBar) }
          : null,
      );
      return;
    }
    if (keyHereIndex >= 0) onRemoveKey(keyHereIndex);
    else onKey(value, curve.beatAnchor ?? null);
  }

  const keyTip = $derived(
    curve
      ? keyHereIndex >= 0
        ? tr('ctl.keyframeTipDelete')
        : tr('ctl.keyframeTipAdd')
      : tr('ctl.keyframeTipCreate'),
  );

  /* ------------------------------------------------------ 调制（v20） */

  /** 槽面板开关。只有真的存在槽时才可能打开 —— 没有槽时徽标也不画。 */
  let slotOpen = $state(false);
  /** 拖拽悬停：显示一条「松手绑定到…」的提示条（行本身不好加描边）。 */
  let dropOver = $state(false);

  const modsList = $derived.by(() => {
    void appState.version;
    return appState.project.modulators ?? [];
  });

  function modName(ref: string): string {
    return modsList.find((m) => m.id === ref)?.name ?? tr('mod.slot.broken');
  }

  function patchSlot(index: number, patch: Partial<ModSlot>): void {
    if (!mods || !onMods) return;
    const next = mods.map((s, i) => (i === index ? { ...s, ...patch } : s));
    onMods(next);
  }

  function removeSlot(index: number): void {
    if (!mods || !onMods) return;
    const next = mods.filter((_, i) => i !== index);
    onMods(next.length > 0 ? next : null);
    if (next.length === 0) slotOpen = false;
  }

  function onDragOver(e: DragEvent): void {
    if (!onMods || !clipId || !curveKey) return;
    if (!isModDrag(e.dataTransfer)) return;
    // 不 preventDefault 就永远不会触发 drop（浏览器默认拒绝落点）。
    e.preventDefault();
    e.stopPropagation();
    if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
    dropOver = true;
  }

  function onDragLeave(): void {
    dropOver = false;
  }

  function onDrop(e: DragEvent): void {
    if (!onMods || !clipId || !curveKey) return;
    const ref = readModDrag(e.dataTransfer);
    dropOver = false;
    if (!ref) return;
    e.preventDefault();
    e.stopPropagation();
    appState.store.bindModulator(clipId, curveKey, ref);
    slotOpen = true;
  }

  const badgeText = $derived(
    layer === 'both' ? tr('mod.badge.both') : layer === 'kc' ? tr('mod.badge.kc') : tr('mod.badge.mod'),
  );
</script>

<!--
  `display: contents` 的外壳只为一件事：`Field` 不接受 DOM 属性，而拖放事件必须
  挂在一个真实存在的祖先上。contents 不生成盒子，所以参数行的布局一字不变。
-->
<div
  class="kf-drop"
  role="presentation"
  ondragover={onDragOver}
  ondragleave={onDragLeave}
  ondrop={onDrop}
>
  <Field label={label} tipText={tipText ?? label}>
    <Slider
      {min}
      {max}
      {step}
      value={Math.max(min, Math.min(max, value))}
      ariaLabel={label}
      oninput={beginSlide}
      onchange={() => appState.endEditKey()}
    />
    <NumberInput
      value={value}
      {min}
      {max}
      {step}
      width={58}
      ariaLabel={tr('ctl.valueAria', { label })}
      oninput={beginSlide}
      onchange={(v) => {
        slide(v);
        appState.endEditKey();
      }}
      onliveend={() => appState.endEditKey()}
    />
    {#snippet trailing()}
      {#if layer !== 'none'}
        <button
          type="button"
          class="badge"
          class:kc={layer === 'kc' || layer === 'both'}
          class:mod={layer === 'mod' || layer === 'both'}
          data-testid="mod-badge"
          title={tr('mod.badge.tip')}
          onclick={() => (slotOpen = !slotOpen)}
        >
          {badgeText}
        </button>
      {/if}
      <IconButton
        icon="diamond"
        label={keyTip}
        size="sm"
        active={keyHereIndex >= 0}
        testid="keyframe-toggle"
        onclick={toggleKey}
      />
    {/snippet}
  </Field>
</div>

{#if dropOver}
  <div class="drop-hint" data-testid="mod-drop-hint">{tr('mod.dropHint', { label })}</div>
{/if}

{#if slotOpen && mods && mods.length > 0}
  <div class="slots" data-testid="mod-slots">
    <!-- 调制后的实际值：滑杆显示的是基值，这里补上「合起来是多少」。 -->
    <div class="slot-head">
      <span class="mono">{tr('mod.slot.live')} {live.toFixed(3)}</span>
    </div>
    {#each mods as slot, i (i)}
      <div class="slot">
        <span class="slot-name" title={modName(slot.ref)}>{modName(slot.ref)}</span>
        <Select
          value={slot.mode}
          options={[
            { value: 'add', label: tr('mod.slot.modeAdd') },
            { value: 'mul', label: tr('mod.slot.modeMul') },
          ]}
          ariaLabel={tr('mod.slot.mode')}
          testid="mod-slot-mode"
          onchange={(v) => patchSlot(i, { mode: v === 'mul' ? 'mul' : 'add' })}
        />
        <NumberInput
          value={slot.gain}
          step={0.01}
          width={58}
          ariaLabel={tr('mod.slot.gain')}
          onchange={(v) => patchSlot(i, { gain: v })}
        />
        <IconButton
          icon="trash"
          label={tr('mod.slot.remove')}
          size="sm"
          variant="danger"
          testid="mod-slot-remove"
          onclick={() => removeSlot(i)}
        />
      </div>
    {/each}
  </div>
{/if}

{#if curve}
  <div class="keys">
    <Checkbox
      checked={!!curve.beatAnchor}
      label={tr('insp.anchorBeat')}
      tipText={tr('insp.anchorTip')}
      testid="anchor-beat"
      onchange={(v) =>
        onAnchorChange(
          v ? { beat: snapBeat(beatAtTime(playT, grid), 'beat', grid.beatsPerBar) } : null,
        )}
    />
    <span class="list">
      {#each curve.keys as k, i (i)}
        <button
          type="button"
          class="key"
          data-testid="curve-key"
          title={tr('ctl.keyframeDeleteTip')}
          onclick={() => onRemoveKey(i)}
        >
          {k.t.toFixed(2)}s={k.v.toFixed(2)}
        </button>
      {/each}
      <!--
        曲线编辑器入口。刻意只在这一行（已有曲线时）出现：检查器本身已经很挤，
        「打关键帧」旁边再挂一个常驻按钮会与 ◆ 抢注意力。没有曲线时新建曲线的
        入口在编辑器里（左侧参数表点一下即可）。
      -->
      {#if clipId && curveKey}
        <IconButton
          icon="spline"
          label={tr('curve.open')}
          size="sm"
          testid="curve-open"
          onclick={() => openCurveEditor(clipId!, curveKey!)}
        />
      {/if}
      <IconButton
        icon="trash"
        label={tr('ctl.clearCurve')}
        size="sm"
        variant="danger"
        testid="curve-clear"
        onclick={onClearCurve}
      />
    </span>
  </div>
{/if}

<style>
  .kf-drop {
    /* 不生成盒子：参数行的布局与没有这个外壳时逐像素相同。 */
    display: contents;
  }
  .drop-hint {
    margin: -2px 0 var(--sp-2) var(--sp-6);
    padding: 2px 6px;
    border: 1px dashed var(--accent);
    border-radius: 3px;
    color: var(--accent);
    font-size: var(--fs-xs);
  }
  /*
   * 状态徽标。KC / M 是**缩写而不是句子**：三态要在 66px 标签列旁边一眼扫完，
   * 写成「有关键帧 · 有调制」会占掉半行。`KC+M` 用等宽字，宽度天然对齐。
   */
  .badge {
    flex: none;
    height: 16px;
    padding: 0 4px;
    background: transparent;
    border: 1px solid var(--input-border);
    border-radius: 3px;
    color: var(--text-muted);
    font-family: var(--font-mono);
    font-size: 10px;
    line-height: 14px;
    cursor: pointer;
  }
  .badge.kc {
    color: var(--text-secondary);
  }
  .badge.mod {
    color: var(--accent);
    border-color: var(--accent);
  }
  .slots {
    display: flex;
    flex-direction: column;
    gap: 3px;
    margin: 0 0 var(--sp-2) var(--sp-6);
  }
  .slot-head {
    display: flex;
    align-items: center;
    justify-content: flex-end;
    color: var(--text-muted);
    font-size: var(--fs-xs);
  }
  .slot {
    display: flex;
    align-items: center;
    gap: var(--sp-2);
    min-width: 0;
  }
  .slot-name {
    flex: 1;
    min-width: 0;
    color: var(--text-secondary);
    font-size: var(--fs-xs);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .keys {
    display: flex;
    align-items: center;
    gap: var(--sp-3);
    margin: 0 0 var(--sp-2) var(--sp-6);
    flex-wrap: wrap;
  }
  .list {
    display: flex;
    gap: var(--sp-1);
    flex-wrap: wrap;
    align-items: center;
  }
  .key {
    height: 16px;
    padding: 0 var(--sp-1);
    background: transparent;
    border: 1px solid var(--input-border);
    border-radius: 3px;
    color: var(--text-secondary);
    font-family: var(--font-mono);
    font-size: var(--fs-xs);
    cursor: pointer;
  }
  .mono {
    font-family: var(--font-mono);
  }
  .key:hover {
    color: var(--danger);
    border-color: var(--danger);
  }
</style>
