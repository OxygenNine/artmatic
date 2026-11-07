<script lang="ts">
  /**
   * Slider — 自绘滑杆，替掉原生 `input[type=range]`。
   *
   * 硬契约：`oninput` **每帧都触发**（拖动的每一次 pointermove 都调一次）。
   * E2E 有一条断言——拖动滑杆时同行数字框显示值必须与 store 落库值逐帧一致
   * （|shown - stored| < 1e-6）。那条断言成立的前提就是这里不做节流、不攒批，
   * 且写入与显示**共用同一份** slider-math 映射。改这个组件时别破坏这两条。
   *
   * `scale` 只改刻度，不改上面两条：把手位置与落库值仍然逐帧互逆。
   * 跨几个数量级的量（粒子数 256…262144）必须给 `{ log: true }`，
   * 否则低段只有几个像素。参数表 → 刻度的换算在 `controls/param-scale.ts`。
   */
  import { clamp, fractionOf, keyDelta, precisionOf, valueAtX, type SliderScale } from './slider-math';
  import { tip } from '../tip';

  interface Props {
    value: number;
    min: number;
    max: number;
    /** 0 表示连续（按像素取值）。 */
    step?: number;
    /** 刻度（缺省线性）。见 `slider-math.ts` 的 `SliderScale`。 */
    scale?: SliderScale;
    oninput: (v: number) => void;
    /** 松手/键盘操作结束时触发，用于写撤销栈。 */
    onchange?: (v: number) => void;
    disabled?: boolean;
    tipText?: string;
    ariaLabel?: string;
    testid?: string;
  }
  const {
    value,
    min,
    max,
    step = 0,
    scale,
    oninput,
    onchange,
    disabled = false,
    tipText,
    ariaLabel,
    testid = 'param-slider',
  }: Props = $props();

  let el: HTMLDivElement;

  const frac = $derived(fractionOf(clamp(value, min, max), min, max, scale));

  function emit(clientX: number): number {
    const r = el.getBoundingClientRect();
    const v = valueAtX(clientX, r.left, r.width, min, max, step, scale);
    oninput(v);
    return v;
  }

  function down(e: PointerEvent): void {
    if (disabled || e.button !== 0) return;
    e.preventDefault();
    el.setPointerCapture(e.pointerId);
    emit(e.clientX);

    const mv = (ev: PointerEvent): void => {
      emit(ev.clientX);
    };
    const up = (ev: PointerEvent): void => {
      el.removeEventListener('pointermove', mv);
      el.removeEventListener('pointerup', up);
      el.removeEventListener('pointercancel', up);
      if (el.hasPointerCapture(ev.pointerId)) el.releasePointerCapture(ev.pointerId);
      onchange?.(clamp(value, min, max));
    };
    el.addEventListener('pointermove', mv);
    el.addEventListener('pointerup', up);
    el.addEventListener('pointercancel', up);
  }

  function onkeydown(e: KeyboardEvent): void {
    if (disabled) return;
    if (e.key === 'Home' || e.key === 'End') {
      e.preventDefault();
      const v = e.key === 'Home' ? min : max;
      oninput(v);
      onchange?.(v);
      return;
    }
    // 没给 step 的连续滑杆，键盘按量程的 1% 走，否则方向键几乎不动。
    const unit = step > 0 ? step : (max - min) / 100;
    const delta = keyDelta(e.key, unit, e.shiftKey);
    if (delta === null) return;
    e.preventDefault();
    const v = clamp((value ?? min) + delta, min, max);
    oninput(v);
    onchange?.(v);
  }

  void precisionOf;
</script>

<div
  class="sld"
  bind:this={el}
  role="slider"
  tabindex={disabled ? -1 : 0}
  aria-valuemin={min}
  aria-valuemax={max}
  aria-valuenow={value}
  aria-label={ariaLabel}
  aria-disabled={disabled}
  data-exempt
  data-testid={testid}
  use:tip={{ text: tipText ?? '', disabled: !tipText }}
  onpointerdown={down}
  {onkeydown}
>
  <div class="sld-track"></div>
  <div class="sld-fill" style:width={`${frac * 100}%`}></div>
  <div class="sld-thumb" style:left={`${frac * 100}%`}></div>
</div>
