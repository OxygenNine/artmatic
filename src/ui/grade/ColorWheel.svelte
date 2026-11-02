<script lang="ts">
  /**
   * ColorWheel — 一个色轮格子：色轮 + 复位 + 主量渐变条 + 主量/三分量数值。
   *
   * 四个实例（阴影 / 中间调 / 高光 / 偏移）就是四个格子，差别只在 meta 里的量纲。
   * 轮盘本身不认识「lift 是加性」这类语义 —— 它只写三分量方向向量，
   * 量纲在 shader 里（`glsl/grade-basic.ts` 的注释写了为什么）。
   *
   * ## 数值框为什么都在最下面一行、还限制格子宽度
   *
   * 主量（明度）的输入框曾经挂在渐变条右侧。四个格子并排时，那条「条 + 框」的
   * 接缝和「框 + 下一个格子的条」长得一模一样 —— 首尾相接时根本分不清哪个框
   * 属于哪一条。现在主量与 R/G/B 排成一行（主 / R / G / B），字母在下；
   * 整格再限一个最大宽度，免得窗口一宽数值就漂离轮盘。
   *
   * 数值可编辑是刻意的：色轮是二维控件，精确复现别人的调色时数值是唯一能对齐
   * 的东西。四个框与轮盘写**同一份数据**，改任一边另一边立刻跟着动。
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

  <div class="gw-values">
    <div class="gw-cell">
      <NumberInput
        value={master}
        min={spec.min}
        max={spec.max}
        step={spec.step}
        fluid
        ariaLabel={tr(spec.masterKey)}
        testid={`grade-master-${spec.group}`}
        oninput={setMaster}
        onchange={(v) => {
          setMaster(v);
          oncommit();
        }}
      />
      <span class="gw-cell-l" aria-hidden="true">{tr('grade.masterShort')}</span>
    </div>
    {#each CHANNELS as ch, i (ch.id)}
      <div class="gw-cell">
        <NumberInput
          value={dir[i]!}
          min={-1}
          max={1}
          step={0.01}
          fluid
          ariaLabel={`${tr(spec.labelKey)} ${ch.label}`}
          testid={`grade-wheel-${spec.group}-${ch.id}`}
          oninput={(v) => setChannel(ch.id, v)}
          onchange={(v) => {
            setChannel(ch.id, v);
            oncommit();
          }}
        />
        <span class="gw-cell-l" aria-hidden="true">{ch.label}</span>
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
    /* 上限比「一行四个数值框」宽一点：再宽轮盘与数值就分家，读起来像两个控件。 */
    width: 100%;
    max-width: 200px;
    justify-self: center;
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
  /*
   * 主量 + R/G/B 一行四格：数字在上、字母在下。
   * 字母不能省 —— 四个一模一样的框，读的人只会去数第几个，而数错一格就改错量。
   */
  .gw-values {
    display: grid;
    grid-template-columns: repeat(4, minmax(0, 1fr));
    /* 2px 的缝在 1280 宽下正好把 `-0.20` 挤掉半个 0；1px 够区分相邻两框了。 */
    gap: 1px;
    align-items: end;
  }
  .gw-cell {
    display: flex;
    flex-direction: column;
    /* stretch 而不是 center：`center` 会让数值框缩到内容宽（22px），
       「0.00」正好被裁掉半个字符。 */
    align-items: stretch;
    gap: 1px;
    min-width: 0;
  }
  /*
   * 一行四个框时字要小两号：格子只有 26–30px，11px 的 `-0.20`（最长的形态）
   * 要 30px，会被裁成 `-0.2`。9px 下 `-0.20` 约 22px，刚好放得下。
   */
  .gw-values :global(input) {
    font-size: 9px;
    letter-spacing: -0.01em;
    padding: 0;
  }
  .gw-cell-l {
    font-size: 9px;
    line-height: 1;
    letter-spacing: 0.04em;
    color: var(--text-muted);
    text-align: center;
  }
</style>
