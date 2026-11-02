<script lang="ts">
  /**
   * RingSlider — 环形滚动条：把「角度（+ 可选的半径）」做成一个可以拖的轮盘。
   *
   * 它服务两类东西：
   *  1. **色相**（一维）：把手沿环走，`radius` 不传。色轮之外的场合（色相旋转、
   *     色键色相）用它比一条直滑杆直观 —— 「红在哪里」不需要看刻度。
   *  2. **色轮**（二维）：传 `radius`，把手落在盘内，角度 = 色相、半径 = 强度。
   *     暗部 / 中部 / 亮部三个轮盘就是三个实例。
   *
   * 为什么不做成 `input[type=range]` 的皮肤：色相是**周期**量，线性滑杆的头尾
   * 同色却相距最远 —— 红要么被切成两段、要么藏在一端。环形是唯一不撒谎的形状。
   *
   * 视觉：环/盘是**内容**（必须显示真实色相，不随主题变），把手是 chrome 但用
   * 白 + 深描边：它要压在任意色相上，跟主题走就会在浅色块上消失。
   */
  import type { Snippet } from 'svelte';
  import { angleOf, hueRingGradient, neutralRingGradient, nudgeAngle } from './ring-math';

  interface Props {
    /** 角度，`0..1`（0 = 右，逆时针）。 */
    angle: number;
    /** 半径，`0..1`。**给了就是二维盘**，不给就只有环。 */
    radius?: number;
    /** 直径（px）。 */
    size?: number;
    /** 画色相环。`false` = 中性环形刻度（纯指示那类）。 */
    hue?: boolean;
    disabled?: boolean;
    ariaLabel?: string;
    testid?: string;
    /** 双击复位（二维时回到圆心）。不给则双击不响应。 */
    onreset?: () => void;
    oninput: (v: { angle: number; radius: number }) => void;
    /** 松手 / 键盘结束时触发（写撤销栈）。 */
    onchange?: (v: { angle: number; radius: number }) => void;
    /**
     * 盘心内容：数值、标签、或者什么都不放。
     *
     * 默认 `undefined` 是必须的：svelte-check 会把没有默认值的 snippet 属性
     * 当成**必填**，于是「不写盘心内容」变成类型错误（只有几何、没有数值的
     * 用法是合法的）。
     */
    children?: Snippet;
  }

  const {
    angle,
    radius,
    size = 108,
    hue = true,
    disabled = false,
    ariaLabel,
    testid = 'ring-slider',
    onreset,
    oninput,
    onchange,
    children = undefined,
  } = $props();

  /** 把手中心离边缘的留白：贴在环上时不该被裁掉一半。 */
  const INSET = 7;
  /** Ctrl 吸附：24 格（15°）。六个主角与十二个间色都在格点上。 */
  const SNAP = 1 / 24;
  /** 方向键步长：1°。 */
  const KEY_STEP = 1 / 360;

  /** 把手的活动半径（px）—— 与 `angleOf` 的换算必须同一个数。 */
  const reach = $derived(size / 2 - INSET);
  const twoAxis = $derived(radius !== undefined);
  const r = $derived(twoAxis ? (radius ?? 0) : 1);
  const ringBg = $derived(hue ? hueRingGradient() : neutralRingGradient());
  const knob = $derived({
    x: Math.cos(angle * Math.PI * 2) * reach * r,
    y: -Math.sin(angle * Math.PI * 2) * reach * r,
  });
  const deg = $derived(Math.round(angle * 360));

  let el: HTMLDivElement | undefined;

  function valueAt(clientX: number, clientY: number, ctrl: boolean): { angle: number; radius: number } {
    if (!el) return { angle: 0, radius: 0 };
    const box = el.getBoundingClientRect();
    const p = angleOf(
      clientX - (box.left + box.width / 2),
      clientY - (box.top + box.height / 2),
      reach,
      ctrl,
      SNAP,
    );
    return twoAxis ? p : { angle: p.angle, radius: 1 };
  }

  function down(e: PointerEvent): void {
    if (disabled || e.button !== 0) return;
    e.preventDefault();
    el?.setPointerCapture(e.pointerId);
    oninput(valueAt(e.clientX, e.clientY, e.ctrlKey));

    const mv = (ev: PointerEvent): void => oninput(valueAt(ev.clientX, ev.clientY, ev.ctrlKey));
    const up = (ev: PointerEvent): void => {
      el?.removeEventListener('pointermove', mv);
      el?.removeEventListener('pointerup', up);
      el?.removeEventListener('pointercancel', up);
      onchange?.(valueAt(ev.clientX, ev.clientY, ev.ctrlKey));
    };
    el?.addEventListener('pointermove', mv);
    el?.addEventListener('pointerup', up);
    el?.addEventListener('pointercancel', up);
  }

  /**
   * 滚轮改**半径**（二维盘）。环模式不接管滚轮：惯性滚动会把角度一路转过去，
   * 而盘模式下「往里压 / 往外推」是自然的。
   */
  function wheel(e: WheelEvent): void {
    if (disabled || !twoAxis) return;
    e.preventDefault();
    const next = Math.min(1, Math.max(0, r - Math.sign(e.deltaY) * (e.shiftKey ? 0.01 : 0.05)));
    oninput({ angle, radius: next });
    onchange?.({ angle, radius: next });
  }

  function key(e: KeyboardEvent): void {
    if (disabled) return;
    if (e.key === 'Home' && twoAxis) {
      e.preventDefault();
      oninput({ angle, radius: 0 });
      onchange?.({ angle, radius: 0 });
      return;
    }
    const dir =
      e.key === 'ArrowRight' || e.key === 'ArrowUp' ? 1 : e.key === 'ArrowLeft' || e.key === 'ArrowDown' ? -1 : 0;
    if (!dir) return;
    e.preventDefault();
    const next = nudgeAngle(angle, dir, e.shiftKey ? KEY_STEP * 10 : KEY_STEP);
    oninput({ angle: next, radius: r });
    onchange?.({ angle: next, radius: r });
  }
</script>

<div
  class="ring"
  class:two-axis={twoAxis}
  class:disabled
  style:--ring-size={`${size}px`}
  role="slider"
  tabindex={disabled ? -1 : 0}
  aria-label={ariaLabel}
  aria-valuemin={0}
  aria-valuemax={360}
  aria-valuenow={deg}
  aria-disabled={disabled ? 'true' : undefined}
  data-testid={testid}
  bind:this={el}
  onpointerdown={down}
  onwheel={wheel}
  onkeydown={key}
  ondblclick={() => onreset?.()}
>
  <!-- 环：conic 渐变 + 径向遮罩挖空中间。这一层是内容，不吃 token。 -->
  <div class="ring-track" style:background={ringBg} aria-hidden="true"></div>
  {#if twoAxis}
    <!-- 盘：同一圈色相，遮罩从中心淡出 ⇒ 圆心是面板底色 = 中性。 -->
    <div class="ring-disc" style:background={ringBg} aria-hidden="true"></div>
    <div class="ring-guide" aria-hidden="true"></div>
    <div class="ring-crosshair" aria-hidden="true"></div>
  {/if}
  <div
    class="ring-knob"
    style:transform={`translate(calc(-50% + ${knob.x}px), calc(-50% + ${knob.y}px))`}
    aria-hidden="true"
  ></div>
  <div class="ring-center">{@render children?.()}</div>
</div>

<style>
  .ring {
    position: relative;
    width: var(--ring-size);
    height: var(--ring-size);
    border-radius: 50%;
    flex: none;
    cursor: grab;
    touch-action: none;
    outline: none;
  }
  .ring:active {
    cursor: grabbing;
  }
  .ring:focus-visible {
    outline: 2px solid var(--accent);
    outline-offset: 2px;
  }
  .ring.disabled {
    cursor: default;
    opacity: 0.45;
  }
  .ring-track,
  .ring-disc,
  .ring-guide,
  .ring-crosshair,
  .ring-knob {
    position: absolute;
    pointer-events: none;
  }
  /* 环厚：1/10 直径。再厚会挤压盘，再薄不好抓。 */
  .ring-track {
    inset: 0;
    border-radius: 50%;
    -webkit-mask: radial-gradient(closest-side, transparent calc(100% - 11px), #000 calc(100% - 9px));
    mask: radial-gradient(closest-side, transparent calc(100% - 11px), #000 calc(100% - 9px));
  }
  .ring-disc {
    inset: 9px;
    border-radius: 50%;
    opacity: 0.5;
    -webkit-mask: radial-gradient(closest-side, transparent 4%, #000 64%);
    mask: radial-gradient(closest-side, transparent 4%, #000 64%);
    transition: opacity var(--motion-duration-hover) var(--motion-ease);
  }
  .ring:hover .ring-disc {
    opacity: 0.68;
  }
  .ring-guide {
    inset: 9px;
    border-radius: 50%;
    border: 1px solid var(--border);
  }
  /* 圆心十字：读「当前偏向哪个色相」用的，1px 中性线。 */
  .ring-crosshair {
    left: 50%;
    top: 50%;
    width: 9px;
    height: 9px;
    margin: -4px 0 0 -4px;
    border-left: 1px solid var(--border-strong);
    border-top: 1px solid var(--border-strong);
    opacity: 0.5;
  }
  .ring-knob {
    left: 50%;
    top: 50%;
    width: 12px;
    height: 12px;
    box-sizing: border-box;
    border-radius: 50%;
    background: #fff;
    border: 1px solid rgba(0, 0, 0, 0.55);
  }
  .ring-center {
    position: absolute;
    inset: 30%;
    display: flex;
    align-items: center;
    justify-content: center;
    pointer-events: none;
    font-size: var(--fs-xs);
    font-variant-numeric: tabular-nums;
    color: var(--text-secondary);
  }
</style>
