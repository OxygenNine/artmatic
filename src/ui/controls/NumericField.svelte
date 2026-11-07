<script lang="ts">
  /**
   * NumericField — 滑杆 + 数字框的**非关键帧**参数行。
   *
   * 这是「参数类型分派」的收口：检查器的烘焙入参 / 转场参数，以及 lab
   * 的源 / 特效参数，原来各抄一份 `Field + Slider + NumberInput`。四处只在
   * testid、宽度、tip 上不同 —— 这些全部走 props，不再复制结构。
   *
   * **不是 `KeyableField` 的替代**：那个还要 ◆、曲线键列表、播放头处 key 的
   * 读写语义，是这一层的超集。关键帧参数继续用 `KeyableField`。
   *
   * 硬契约（与 Slider/NumberInput 一致）：`oninput` 每帧触发，`onchange` 只在
   * 提交时触发；没给 `onchange` 时按 `oninput` 处理（幂等提交）。
   *
   * `scale` 原样转给 `Slider`（刻度只在滑杆上成立；数字框始终是绝对值）。
   * 调用点一律从参数表取：`scale={sliderScaleOf(p)}`（见 `controls/param-scale.ts`）。
   */
  import Field from './Field.svelte';
  import NumberInput from './NumberInput.svelte';
  import Slider from './Slider.svelte';
  import type { SliderScale } from './slider-math';

  interface Props {
    label: string;
    min: number;
    max: number;
    step: number;
    value: number;
    /** 滑杆刻度（缺省线性）。 */
    scale?: SliderScale;
    oninput: (v: number) => void;
    onchange?: (v: number) => void;
    labelWidth?: number;
    tipText?: string;
    ariaLabel?: string;
    /** 变灰且不可操作（滑杆与数字框一起）。语义与原生 `disabled` 一致。 */
    disabled?: boolean;
    /** 数字框宽度。默认 64（检查器口径），lab 传 62。 */
    numberWidth?: number;
    sliderTestid?: string;
    numberTestid?: string;
  }
  const {
    label,
    min,
    max,
    step,
    value,
    scale,
    oninput,
    onchange,
    labelWidth,
    tipText,
    ariaLabel = label,
    disabled = false,
    numberWidth = 64,
    sliderTestid,
    numberTestid,
  }: Props = $props();

  const commit = (v: number): void => (onchange ?? oninput)(v);
</script>

<Field {label} {labelWidth} {tipText}>
  <Slider
    {min}
    {max}
    {step}
    {value}
    {scale}
    {ariaLabel}
    {disabled}
    testid={sliderTestid}
    oninput={oninput}
    onchange={onchange}
  />
  <NumberInput
    {value}
    {min}
    {max}
    {step}
    width={numberWidth}
    {ariaLabel}
    {disabled}
    testid={numberTestid}
    oninput={oninput}
    onchange={commit}
  />
</Field>
