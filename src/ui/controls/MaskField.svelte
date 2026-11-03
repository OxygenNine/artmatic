<script lang="ts">
  /**
   * MaskField — 「外部蒙版」的两个下拉（来源 + 通道）。
   *
   * 检查器与调色页共用这一份：两处各写一遍的形态是「一边能接、另一边点了没反应」，
   * 而两边都只是在写同一个 `EffectInstance.inputs.mask`（`core/mask.ts`）。
   *
   * **每个特效都能接**（缺省的 `composite` 在链上混回），所以调用方无条件渲染它；
   * 只有 `grade-qualifier` 这类把蒙版当自己输入的特效走 `'input'` 模式，但对用户
   * 是同一件事：接一个来源、选一个通道。
   */
  import type { EffectInstance } from '../../core/schema';
  import {
    MASK_CHANNELS,
    maskEdges,
    maskPathExists,
    maskRefOf,
    type MaskChannel,
  } from '../../core/mask';
  import { appState } from '../app-state.svelte';
  import { tr } from '../../i18n/index.svelte';
  import Field from './Field.svelte';
  import Select from './Select.svelte';

  interface Props {
    /** 声明这条引用的特效片段（环判据以它为一端）。 */
    clipId: string;
    inst: EffectInstance;
    /** data-testid 前缀：`${prefix}-source` / `-channel` / `-rejected`。 */
    prefix?: string;
    /** 通道的默认值（新接一条引用时用）。 */
    defaultChannel?: MaskChannel;
  }

  let { clipId, inst, prefix = 'effect-mask', defaultChannel = 'luma' }: Props = $props();

  const CHANNEL_LABEL = {
    luma: 'insp.maskChannelLuma',
    alpha: 'insp.maskChannelAlpha',
    r: 'insp.maskChannelR',
    g: 'insp.maskChannelG',
    b: 'insp.maskChannelB',
  } as const;

  /**
   * 依赖图一次建好、每次 store 变化重建一次。
   *
   * 不能对每个候选各调一次 `maskRefCreatesCycle`（那个每次都要扫全工程建边表），
   * 而这个下拉是「每个候选问一次」—— 片段一多就是 O(n²)，拖滑杆时会卡在面板上。
   */
  const graph = $derived.by(() => {
    void appState.version;
    return maskEdges(appState.project);
  });

  /**
   * 当前引用。**值必须在派生里取**：`inst` 是 store 里的普通对象、原地改，
   * 模板里直接读不会重算（与 `ui/AGENTS.md` 那条「拖滑杆画面变、读数不动」同源）。
   */
  const current = $derived.by(() => {
    void appState.version;
    return maskRefOf(inst);
  });
  const currentId = $derived(current?.kind === 'clip' ? current.clipId : '');
  const channel = $derived(current?.kind === 'clip' ? current.channel : defaultChannel);

  /**
   * 候选来源：工程里所有**画面片段**，会成环的直接不列出来（写了也会被 store 拒）。
   *
   * 包含停用轨道上的片段：引用的是片段本身，不是「这一帧恰好画了什么」。
   */
  const options = $derived.by(() => {
    void appState.version;
    const out: { value: string; label: string }[] = [{ value: '', label: tr('insp.maskNone') }];
    for (const t of appState.project.tracks) {
      if (t.kind !== 'visual') continue;
      for (const c of t.clips) {
        if (c.kind !== 'source') continue;
        if (c.id !== currentId && maskPathExists(graph, c.id, clipId)) continue;
        out.push({ value: c.id, label: `${t.name} · ${c.label || c.source.type}` });
      }
    }
    // 目标已经不在了（被删 / 手改）时补一条原值，否则下拉显示「不接」而实际仍指着它。
    if (currentId && !out.some((o) => o.value === currentId)) {
      out.push({ value: currentId, label: currentId });
    }
    return out;
  });

  let rejected = $state<string | null>(null);

  function setTarget(clipIdValue: string): void {
    if (!clipIdValue) {
      appState.store.setEffectMaskRef(clipId, inst.instanceId, null);
      rejected = null;
      return;
    }
    const ok = appState.store.setEffectMaskRef(clipId, inst.instanceId, {
      kind: 'clip',
      clipId: clipIdValue,
      channel,
    });
    // 候选已经过滤过，正常不会走到这里；写失败说明工程在两次判断之间被改过。
    rejected = ok ? null : tr('insp.maskCycle');
  }

  function setChannel(value: string): void {
    if (current?.kind !== 'clip') return;
    appState.store.setEffectMaskRef(clipId, inst.instanceId, {
      kind: 'clip',
      clipId: current.clipId,
      channel: value as MaskChannel,
    });
  }
</script>

<Field label={tr('insp.mask')} tipText={tr('insp.maskTip')}>
  <Select
    value={currentId}
    {options}
    testid={`${prefix}-source`}
    optionTestidPrefix={`${prefix}-opt`}
    onchange={setTarget}
  />
</Field>
{#if current?.kind === 'clip'}
  <Field label={tr('insp.maskChannel')}>
    <Select
      value={channel}
      options={MASK_CHANNELS.map((c) => ({ value: c, label: tr(CHANNEL_LABEL[c]) }))}
      testid={`${prefix}-channel`}
      optionTestidPrefix={`${prefix}-channel-opt`}
      onchange={setChannel}
    />
  </Field>
{/if}
{#if rejected}
  <p class="mf-warn" data-testid={`${prefix}-rejected`}>{rejected}</p>
{/if}

<style>
  .mf-warn {
    margin: 0;
    font-size: var(--fs-xs);
    color: var(--warning);
  }
</style>
