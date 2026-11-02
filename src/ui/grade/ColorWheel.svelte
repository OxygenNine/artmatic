<script lang="ts">
  /**
   * ColorWheel — 一个色轮：环形滚动条（角度 = 色相，半径 = 强度）+ 主量。
   *
   * 三个实例（暗部 / 中间调 / 亮部）就是三个轮盘，差别只在 meta 里的量纲。
   * 轮盘本身不认识「lift 是加性」这类语义 —— 它只写三分量方向向量，
   * 量纲在 shader 里（`glsl/grade-basic.ts` 的注释写了为什么）。
   */
  import type { EffectInstance } from '../../core/schema';
  import { tr } from '../../i18n/index.svelte';
  import RingSlider from '../controls/RingSlider.svelte';
  import Slider from '../controls/Slider.svelte';
  import NumberInput from '../controls/NumberInput.svelte';
  import { readWheel, writeWheel, type WheelSpec } from './grade-ops';

  interface Props {
    inst: EffectInstance;
    spec: WheelSpec;
    /** 拖动的每一帧：写值 + 保证 UI 跟上。 */
    onvalue: (mutate: (inst: EffectInstance) => void) => void;
    /** 手势结束：收事务（一次拖动 = 一条撤销）。 */
    oncommit: () => void;
  }
  const { inst, spec, onvalue, oncommit }: Props = $props();

  const pos = $derived(readWheel(inst, spec.group));
  const master = $derived(Number(inst.values[`${spec.group}#m`] ?? spec.neutral));
  const strength = $derived(Math.round(pos.radius * 100));

  function setPos(next: { angle: number; radius: number }): void {
    onvalue((it) => writeWheel(it, spec.group, next));
  }

  function setMaster(v: number): void {
    onvalue((it) => {
      it.values[`${spec.group}#m`] = v;
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
    <button class="gw-reset" type="button" title={tr('grade.reset')} onclick={reset}>
      {tr('grade.resetShort')}
    </button>
  </div>

  <RingSlider
    angle={pos.angle}
    radius={pos.radius}
    size={96}
    ariaLabel={tr(spec.labelKey)}
    testid={`grade-wheel-ring-${spec.group}`}
    oninput={setPos}
    onchange={() => oncommit()}
    onreset={reset}
  >
    {#if strength > 0}
      <span class="gw-strength">{strength}</span>
    {/if}
  </RingSlider>

  <div class="gw-master">
    <Slider
      value={master}
      min={spec.min}
      max={spec.max}
      step={spec.step}
      ariaLabel={tr(spec.masterKey)}
      testid={`grade-master-slider-${spec.group}`}
      oninput={setMaster}
      onchange={() => oncommit()}
    />
    <NumberInput
      value={master}
      min={spec.min}
      max={spec.max}
      step={spec.step}
      width={62}
      suffix={spec.unit}
      ariaLabel={tr(spec.masterKey)}
      testid={`grade-master-${spec.group}`}
      oninput={setMaster}
      onchange={(v) => {
        setMaster(v);
        oncommit();
      }}
    />
  </div>
</div>

<style>
  .gw {
    position: relative;
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: var(--sp-2);
    min-width: 0;
    padding: 0 var(--sp-1);
  }
  /* 名字居中当标题，复位挂在右上角 —— 两者同一行会让人以为「复位」属于右邻的轮盘。 */
  .gw-head {
    display: flex;
    align-items: center;
    justify-content: center;
    gap: var(--sp-2);
    width: 100%;
    min-height: 16px;
  }
  .gw-name {
    font-size: var(--fs-xs);
    color: var(--text-secondary);
    letter-spacing: 0.02em;
  }
  /* 复位是文字按钮：三个轮盘各挂一个图标会变成一排色块，反而找不到。 */
  .gw-reset {
    position: absolute;
    top: 0;
    right: 0;
    background: none;
    border: 0;
    padding: 0;
    font: inherit;
    font-size: var(--fs-xs);
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
  }
  .gw-strength {
    font-size: var(--fs-xs);
    color: var(--text-secondary);
  }
  .gw-master {
    display: flex;
    align-items: center;
    gap: var(--sp-2);
    width: 100%;
  }
</style>
