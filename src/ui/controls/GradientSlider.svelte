<script lang="ts">
  /**
   * GradientSlider — 轨道比把手高的滑杆，背景是渐变色。
   *
   * 普通滑杆（`Slider`）的轨道只有 3px：它是「一个数轴」，越细越不抢戏。
   * 但调色里有些量本身就是**一段颜色**（色温冷→暖、饱和度灰→艳、主量暗→亮），
   * 3px 的轨道表达不了。这里把轨道做成一条 12px 的渐变条，把手压在上面 ——
   * 于是「这条滑杆在调什么」不需要标签也看得出来。
   *
   * 与 `Slider` 同一套硬契约（`oninput` 每帧触发、`onchange` 收口），
   * 换算也走同一份 `slider-math` —— 两套映射漂移一次，手感就会不一样。
   */
  import { clamp, fractionOf, keyDelta, valueAtX } from './slider-math';

  interface Props {
    value: number;
    min: number;
    max: number;
    step?: number;
    /** CSS 渐变（`linear-gradient(...)`）。 */
    gradient: string;
    /**
     * 中性值：在轨道上画一条细刻度。调色的主量都是「回零 = 中性」，
     * 没有这个刻度就只能靠把数字拖到 0.00 才知道到没到。
     */
    neutral?: number;
    oninput: (v: number) => void;
    onchange?: (v: number) => void;
    disabled?: boolean;
    ariaLabel?: string;
    testid?: string;
  }
  const {
    value,
    min,
    max,
    step = 0,
    gradient,
    neutral,
    oninput,
    onchange,
    disabled = false,
    ariaLabel,
    testid = 'gradient-slider',
  }: Props = $props();

  let el: HTMLDivElement | undefined;

  const frac = $derived(fractionOf(clamp(value, min, max), min, max));
  const neutralFrac = $derived(
    neutral === undefined ? null : fractionOf(clamp(neutral, min, max), min, max),
  );

  function emit(clientX: number): void {
    if (!el) return;
    const r = el.getBoundingClientRect();
    oninput(valueAtX(clientX, r.left, r.width, min, max, step));
  }

  function down(e: PointerEvent): void {
    if (disabled || e.button !== 0) return;
    e.preventDefault();
    el?.setPointerCapture(e.pointerId);
    emit(e.clientX);
    const mv = (ev: PointerEvent): void => emit(ev.clientX);
    const up = (ev: PointerEvent): void => {
      el?.removeEventListener('pointermove', mv);
      el?.removeEventListener('pointerup', up);
      el?.removeEventListener('pointercancel', up);
      if (el?.hasPointerCapture(ev.pointerId)) el.releasePointerCapture(ev.pointerId);
      onchange?.(clamp(value, min, max));
    };
    el?.addEventListener('pointermove', mv);
    el?.addEventListener('pointerup', up);
    el?.addEventListener('pointercancel', up);
  }

  function key(e: KeyboardEvent): void {
    if (disabled) return;
    if (e.key === 'Home' || e.key === 'End') {
      e.preventDefault();
      const v = e.key === 'Home' ? min : max;
      oninput(v);
      onchange?.(v);
      return;
    }
    const unit = step > 0 ? step : (max - min) / 100;
    const delta = keyDelta(e.key, unit, e.shiftKey);
    if (delta === null) return;
    e.preventDefault();
    const v = clamp(value + delta, min, max);
    oninput(v);
    onchange?.(v);
  }
</script>

<div
  class="grs"
  class:disabled
  bind:this={el}
  role="slider"
  tabindex={disabled ? -1 : 0}
  aria-valuemin={min}
  aria-valuemax={max}
  aria-valuenow={value}
  aria-label={ariaLabel}
  aria-disabled={disabled ? 'true' : undefined}
  data-exempt
  data-testid={testid}
  onpointerdown={down}
  onkeydown={key}
>
  <div class="grs-track" style:background={gradient} aria-hidden="true"></div>
  {#if neutralFrac !== null}
    <div class="grs-neutral" style:left={`${neutralFrac * 100}%`} aria-hidden="true"></div>
  {/if}
  <div class="grs-thumb" style:left={`${frac * 100}%`} aria-hidden="true"></div>
</div>

<style>
  .grs {
    position: relative;
    flex: 1;
    min-width: 0;
    height: var(--control-h);
    display: flex;
    align-items: center;
    cursor: ew-resize;
    touch-action: none;
    outline: none;
  }
  .grs:focus-visible .grs-track {
    box-shadow:
      inset 0 0 0 1px rgba(0, 0, 0, 0.3),
      0 0 0 1px var(--accent);
  }
  /*
   * 轨道 12px、圆角 6px：比把手的 16px 矮一档，但足够读出一条渐变的层次。
   * 内描边是为了让浅色端（白）不融进浅色面板、深色端不融进暗色面板。
   */
  .grs-track {
    width: 100%;
    height: 12px;
    border-radius: 6px;
    box-shadow: inset 0 0 0 1px rgba(0, 0, 0, 0.22);
  }
  .grs-neutral {
    position: absolute;
    top: 50%;
    width: 1px;
    height: 12px;
    margin-left: -0.5px;
    transform: translateY(-50%);
    background: rgba(0, 0, 0, 0.35);
    box-shadow: 0 0 0 1px rgba(255, 255, 255, 0.25);
    pointer-events: none;
  }
  /*
   * 把手：白底 + 深描边。它要压在任意渐变上（包括纯白那一段），
   * 跟主题走就会在浅色端消失。
   */
  .grs-thumb {
    position: absolute;
    top: 50%;
    width: 3px;
    height: 16px;
    margin-left: -1.5px;
    transform: translateY(-50%);
    border-radius: 2px;
    background: #fff;
    box-shadow: 0 0 0 1px rgba(0, 0, 0, 0.5);
    pointer-events: none;
  }
  .grs:hover .grs-thumb {
    height: 18px;
  }
  .grs.disabled {
    cursor: default;
    opacity: 0.5;
  }
</style>
