<script lang="ts">
  /**
   * ToneCurveEditor — 色调曲线区：主 / R / G / B 四张并排（每张见 `ToneCurveChart`）。
   *
   * 它只做「从哪读、往哪写」，控件本身在 chart 里。提出来是因为四张图共用
   * 同一份读写协议：`values['curve#master' | 'curve#r' | 'curve#g' | 'curve#b']`。
   */
  import type { EffectInstance } from '../../core/schema';
  import { stringifyToneCurve, type CurvePoint } from '../../core/tone-curve';
  import { tr } from '../../i18n/index.svelte';
  import type { MessageKey } from '../../i18n/locales';
  import { appState } from '../app-state.svelte';
  import ToneCurveChart from './ToneCurveChart.svelte';

  type Channel = 'master' | 'r' | 'g' | 'b';

  interface Props {
    inst: EffectInstance;
    onvalue: (mutate: (inst: EffectInstance) => void) => void;
    oncommit: () => void;
  }
  const { inst, onvalue, oncommit }: Props = $props();

  const CHANNELS: { id: Channel; labelKey: MessageKey }[] = [
    { id: 'master', labelKey: 'grade.curveMaster' },
    { id: 'r', labelKey: 'grade.curveChannelR' },
    { id: 'g', labelKey: 'grade.curveChannelG' },
    { id: 'b', labelKey: 'grade.curveChannelB' },
  ];

  /**
   * 曲线线的颜色。
   *
   * R/G/B 用**字面量色相**是对的：它们表示通道，不是界面 chrome ——
   * 跟着主题变会让「这是红通道」丢失。主曲线用文字色（中性）。
   */
  const STROKE: Record<Channel, string> = {
    master: 'var(--text-primary)',
    r: 'hsl(0 62% 55%)',
    g: 'hsl(140 45% 45%)',
    b: 'hsl(215 68% 60%)',
  };

  /**
   * 四条曲线的原始串。整块取一次而不是在模板里逐个读：`inst` 是 store 里的
   * 普通对象，必须在同一个派生里 `void appState.version`，否则拖完控制点
   * 曲线不会重画（父组件不会因为「值变了」而重跑）。
   */
  const values = $derived.by(() => {
    void appState.version;
    return CHANNELS.map((c) => String(inst.values[`curve#${c.id}`] ?? ''));
  });

  function write(channel: Channel, next: CurvePoint[]): void {
    onvalue((it) => {
      it.values[`curve#${channel}`] = stringifyToneCurve(next);
    });
  }
</script>

<div class="tce">
  {#each CHANNELS as c, i (c.id)}
    <ToneCurveChart
      value={values[i] ?? ''}
      color={STROKE[c.id]}
      label={tr(c.labelKey)}
      testid={`grade-curve-canvas-${c.id}`}
      onpoints={(next) => write(c.id, next)}
      {oncommit}
    />
  {/each}
</div>

<style>
  /*
   * 四张**等分**，不加最小宽度：加过 `minmax(120px, …)`，在 1440 宽的窗口下
   * 四张要 504px 而这一栏只有 430px，第四张直接被切在面板外面（看起来像
   * 「B 通道丢了」）。等分时 430px 仍是每张约 100px，拖点够用。
   */
  .tce {
    display: grid;
    grid-template-columns: repeat(4, minmax(0, 1fr));
    gap: var(--sp-2);
    min-height: 0;
    min-width: 0;
  }
</style>
