<script lang="ts">
  /**
   * ColorWheel — 一个色轮格子：色轮 + 复位 + 主量渐变条 + R/G/B 三分量。
   *
   * 四个实例（暗部 / 中间调 / 高光 / 偏移）就是四个格子，差别只在 meta 里的量纲。
   * 轮盘本身不认识「lift 是加性」这类语义 —— 它只写三分量方向向量，
   * 量纲在 shader 里（`glsl/grade-basic.ts` 的注释写了为什么）。
   *
   * 为什么三分量也做成可编辑的数字框（而不只是读颜色）：色轮是二维控件，
   * 精确复现一个别人的调色参数时，数值是唯一能对齐的东西。R/G/B 三个框与
   * 轮盘写的是**同一份数据**，改任一边另一边立刻跟着动（`readWheel` 反解）。
   */
  import type { EffectInstance } from '../../core/schema';
  import { tr } from '../../i18n/index.svelte';
  import Icon from '../Icon.svelte';
  import RingSlider from '../controls/RingSlider.svelte';
  import GradientSlider from '../controls/GradientSlider.svelte';
  import NumberInput from '../controls/NumberInput.svelte';
  import { readDirection, readWheel, writeWheel, type WheelSpec } from './grade-ops';
  import { masterGradient } from './gradients';
  import { appState } from '../app-state.svelte';

  interface Props {
    inst: EffectInstance;
    spec: WheelSpec;
    /** 拖动的每一帧：写值 + 保证 UI 跟上。 */
    onvalue: (mutate: (inst: EffectInstance) => void) => void;
    /** 手势结束：收事务（一次拖动 = 一条撤销）。 */
    oncommit: () => void;
  }
  const { inst, spec, onvalue, oncommit }: Props = $props();

  /**
   * 轮的直径：四个并排时这是「放得下且还能拖」的上限。
   * 再大一点，面板默认高度下就会把下面的参数行挤出可视区。
   */
  const SIZE = 96;

  /*
   * ⚠️ 每个派生都要 `void appState.version`：`inst` 是 store 里的**普通对象**，
   * 原地写 `values` 不换引用。漏了的表现是「拖轮盘时把手不动、松开才跳」——
   * 数字框反而正常（它自己持有输入态），所以很像「只有色轮坏了」。
   */
  const pos = $derived.by(() => {
    void appState.version;
    return readWheel(inst, spec.group);
  });
  const master = $derived.by(() => {
    void appState.version;
    return Number(inst.values[`${spec.group}#m`] ?? spec.neutral);
  });
  const dir = $derived.by(() => {
    void appState.version;
    return readDirection(inst, spec.group);
  });

  const CHANNELS = [
    { id: 'r', label: 'R' },
    { id: 'g', label: 'G' },
    { id: 'b', label: 'B' },
  ] as const;

  function setPos(next: { angle: number; radius: number }): void {
    onvalue((it) => writeWheel(it, spec.group, next));
  }

  function setMaster(v: number): void {
    onvalue((it) => {
      it.values[`${spec.group}#m`] = v;
    });
  }

  function setChannel(ch: 'r' | 'g' | 'b', v: number): void {
    onvalue((it) => {
      it.values[`${spec.group}#${ch}`] = v;
    });
  }

  /** 双击 / 复位：角度归零 + 强度归零 + 主量回中性。 */
  function reset(): void {
    setPos({ angle: 0, radius: 0 });
    setMaster(spec.neutral);
    oncommit();
  }
</script>

<div class="gw" data-testid={`grade-wheel-${spec.group}`}>
  <div class="gw-head">
    <span class="gw-name">{tr(spec.labelKey)}</span>
  </div>

  <div class="gw-disc">
    <RingSlider
      angle={pos.angle}
      radius={pos.radius}
      size={SIZE}
      ariaLabel={tr(spec.labelKey)}
      testid={`grade-wheel-ring-${spec.group}`}
      oninput={setPos}
      onchange={() => oncommit()}
      onreset={reset}
    />
    <!--
      复位挂在轮盘左下角外侧：放在标题行会与「全部复位」撞在一起，
      放在盘心则会挡住拖拽的落点。
    -->
    <button
      class="gw-reset"
      type="button"
      title={tr('grade.reset')}
      aria-label={`${tr(spec.labelKey)} · ${tr('grade.resetShort')}`}
      data-testid={`grade-wheel-reset-${spec.group}`}
      onclick={reset}
    >
      <Icon name="rotate-ccw" size={12} />
    </button>
  </div>

  <div class="gw-master">
    <GradientSlider
      value={master}
      min={spec.min}
      max={spec.max}
      step={spec.step}
      neutral={spec.neutral}
      gradient={masterGradient(spec.group)}
      ariaLabel={spec.unit ? `${tr(spec.masterKey)} (${spec.unit})` : tr(spec.masterKey)}
      testid={`grade-master-slider-${spec.group}`}
      oninput={setMaster}
      onchange={() => oncommit()}
    />
    <NumberInput
      value={master}
      min={spec.min}
      max={spec.max}
      step={spec.step}
      width={46}
      ariaLabel={tr(spec.masterKey)}
      testid={`grade-master-${spec.group}`}
      oninput={setMaster}
      onchange={(v) => {
        setMaster(v);
        oncommit();
      }}
    />
  </div>

  <div class="gw-rgb">
    {#each CHANNELS as ch (ch.id)}
      <div class="gw-ch">
        <NumberInput
          value={dir[ch.id === 'r' ? 0 : ch.id === 'g' ? 1 : 2]}
          min={-1}
          max={1}
          step={0.01}
          width={38}
          ariaLabel={`${tr(spec.labelKey)} ${ch.label}`}
          testid={`grade-wheel-${spec.group}-${ch.id}`}
          oninput={(v) => setChannel(ch.id, v)}
          onchange={(v) => {
            setChannel(ch.id, v);
            oncommit();
          }}
        />
        <span class="gw-ch-l" aria-hidden="true">{ch.label}</span>
      </div>
    {/each}
  </div>
</div>

<style>
  .gw {
    position: relative;
    display: flex;
    flex-direction: column;
    align-items: stretch;
    gap: 6px;
    min-width: 0;
  }
  .gw-head {
    display: flex;
    align-items: center;
    justify-content: center;
    min-height: 16px;
  }
  .gw-name {
    font-size: var(--fs-xs);
    color: var(--text-secondary);
    letter-spacing: 0.02em;
  }
  .gw-disc {
    position: relative;
    display: flex;
    justify-content: center;
  }
  /* 复位是图标按钮：文字版在四个格子里会变成一排「复位」，反而找不到是哪一个。 */
  .gw-reset {
    position: absolute;
    left: -2px;
    bottom: -2px;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 20px;
    height: 20px;
    padding: 0;
    background: none;
    border: 0;
    border-radius: var(--radius-sm);
    color: var(--text-muted);
    cursor: pointer;
    opacity: 0;
    transition: opacity var(--motion-duration-hover) var(--motion-ease);
  }
  .gw:hover .gw-reset,
  .gw-reset:focus-visible {
    opacity: 1;
  }
  .gw-reset:hover {
    color: var(--accent);
    background: var(--surface-hover);
  }
  .gw-master {
    display: flex;
    align-items: center;
    gap: var(--sp-1);
    min-width: 0;
  }
  .gw-rgb {
    display: grid;
    grid-template-columns: repeat(3, minmax(0, 1fr));
    gap: 2px;
    align-items: end;
  }
  /*
   * 单个分量：数字框在上、通道字母在下。
   * 字母不能省 —— 三个一模一样的框，读的人只会去数第几个。
   */
  .gw-ch {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 1px;
    min-width: 0;
  }
  .gw-ch-l {
    font-size: 9px;
    line-height: 1;
    letter-spacing: 0.04em;
    color: var(--text-muted);
  }
</style>
