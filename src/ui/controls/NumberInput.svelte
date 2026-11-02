<script lang="ts">
  /**
   * NumberInput — 数字输入框，带 drag-to-tweak。
   *
   * 这是达芬奇/After Effects/Blender 那套参数框的交互：
   *   点击       → 聚焦文本编辑（全选，直接打字覆盖）
   *   横向拖动   → 连续改值（光标是 ew-resize，可发现性靠它）
   *   Ctrl 按住   → 吸附到 step 整数倍
   *   Alt 按住    → 精细，灵敏度 ×0.1
   *   Shift 按住  → 粗调，灵敏度 ×10
   *   Esc        → 取消这次拖动，恢复原值
   *
   * 状态机与数值映射全在 scrub.ts（纯函数、可单测），这里只做事件接线。
   *
   * testid 约定：`testid` 落在**内部 input** 上，所以 `getByTestId(x).fill()`
   * 与 `.inputValue()` 照常可用；拖拽热区（外层容器）的 testid 是 `testid + '-wrap'`。
   */
  import {
    NO_MODIFIERS,
    beginScrub,
    commitValue,
    formatValue,
    modifiersEqual,
    parseValue,
    rebase,
    scrubValue,
    shouldBeginScrub,
    type Modifiers,
    type ScrubSession,
  } from './scrub';
  import { keyDelta, precisionOf } from './slider-math';
  import { tip } from '../tip';

  interface Props {
    value: number;
    /** 提交（Enter / 失焦 / 拖动结束 / 步进键）。 */
    onchange: (v: number) => void;
    /** 拖动过程中的实时值（不写撤销栈时用）。 */
    oninput?: (v: number) => void;
    /**
     * 拖动结束（含 Esc 取消）时调一次，**在 onchange 之后**。
     *
     * 给「实时预览」用：调用方在 oninput 里开一个手势事务把每帧写进文档，
     * 这里给它一个确定的收尾信号。没有这个回调的话，事务只能等 onchange ——
     * 而实时预览已经让值等于最终值，`up()` 里的 `v !== value` 判断会短路，
     * onchange 根本不触发，事务就悬在那儿了（后续每一次 commit 都被并进去）。
     */
    onliveend?: () => void;
    min?: number;
    max?: number;
    step?: number;
    /** 显示小数位。默认由 step 推。 */
    precision?: number;
    suffix?: string;
    /** 宽度（px）。默认 62。 */
    width?: number;
    /**
     * 由容器决定宽度（`width:100%`，可被压缩）。
     *
     * 给「一行并排好几个数值框」的场合用：写死 px 时窄容器里的框会被邻格裁掉，
     * 而这类地方（色轮的一行四个值）本来就该跟着格子走。
     */
    fluid?: boolean;
    disabled?: boolean;
    /** false 关闭拖拽改值，只留文本编辑。 */
    scrub?: boolean;
    tipText?: string;
    ariaLabel?: string;
    testid?: string;
    /** 输入框变窄时的对齐方式，右对齐适合数值。 */
    align?: 'left' | 'right';
  }
  const {
    value,
    onchange,
    oninput,
    onliveend,
    min,
    max,
    step = 1,
    precision,
    suffix,
    width = 62,
    fluid = false,
    disabled = false,
    scrub = true,
    tipText,
    ariaLabel,
    testid,
    align = 'right',
  }: Props = $props();

  let inputEl: HTMLInputElement;
  let wrapEl: HTMLDivElement;

  const decimals = $derived(precision ?? precisionOf(step > 0 ? step : 1));
  const cfg = $derived({ step: step > 0 ? step : 1, min, max });

  let focused = $state(false);
  let dragging = $state(false);
  let text = $state('');

  // 拖拽/编辑期间不覆盖用户看到的东西；其余时候跟随外部 value。
  $effect(() => {
    const v = value;
    if (!focused && !dragging) text = formatValue(v, decimals);
  });

  /* --------------------------------------------------------- 手势（非响应式） */
  let session: ScrubSession | null = null;
  let lastMods: Modifiers = NO_MODIFIERS;
  let startX = 0;
  let currentValue = 0;
  let armed = false;
  /** 累计位移。正常情况 = clientX - startX；指针锁定后改为累加 movementX。 */
  let accumDx = 0;
  /** 本次手势是否已经在贴边时尝试过指针锁定（只试一次，失败就安静降级）。 */
  let lockTried = false;

  /** 距视口边缘多少像素内就尝试指针锁定。 */
  const EDGE_PX = 3;

  const modsOf = (e: PointerEvent): Modifiers => ({
    ctrl: e.ctrlKey,
    alt: e.altKey,
    shift: e.shiftKey,
  });

  const locked = (): boolean => document.pointerLockElement === wrapEl;

  /**
   * 松开指针锁。浏览器在按 Esc / 窗口失焦时会自己解除，所以这是幂等的。
   */
  function releaseLock(): void {
    if (document.pointerLockElement === wrapEl) document.exitPointerLock();
  }

  /**
   * 指针锁被意外解除（Esc / 失焦）＝ 取消这次拖动。
   * 这样 Esc 与浏览器内建的「Esc 退出指针锁」是同一个语义，不会出现
   * 「Esc 只解锁、值还停在中途」这种半截状态。
   */
  function onLockChange(): void {
    if (locked() || !armed) return;
    cancelScrub();
  }

  function cancelScrub(): void {
    const origin = session?.originValue ?? value;
    currentValue = origin;
    text = formatValue(origin, decimals);
    oninput?.(origin);
    dragging = false;
    detach();
    onliveend?.();
  }

  function detach(): void {
    window.removeEventListener('keydown', onWindowKey, true);
    document.removeEventListener('pointerlockchange', onLockChange);
    armed = false;
    session = null;
  }

  function onWindowKey(e: KeyboardEvent): void {
    if (e.key !== 'Escape' || !armed) return;
    // 拖动中按 Esc = 取消这次拖动。stopPropagation 免得顺带关掉菜单之类。
    e.preventDefault();
    e.stopPropagation();
    releaseLock();
    cancelScrub();
  }

  function down(e: PointerEvent): void {
    if (disabled || !scrub || e.button !== 0) return;
    // 已经在编辑文本：让原生行为接管（可以拖选字符）
    if (document.activeElement === inputEl) return;
    e.preventDefault();
    wrapEl.setPointerCapture(e.pointerId);
    startX = e.clientX;
    accumDx = 0;
    lockTried = false;
    currentValue = value;
    session = beginScrub(value);
    lastMods = modsOf(e);
    armed = true;
    dragging = false;
    window.addEventListener('keydown', onWindowKey, true);
    document.addEventListener('pointerlockchange', onLockChange);
  }

  function move(e: PointerEvent): void {
    if (!armed || !session) return;

    // 指针锁定后 clientX 会冻在锁定点，必须改用 movementX 累加。
    if (locked()) accumDx += e.movementX;
    else accumDx = e.clientX - startX;

    if (!dragging) {
      if (!shouldBeginScrub(accumDx)) return; // 还没越过阈值：仍可能是「点击」
      dragging = true;
    }

    /*
     * 贴到视口边缘时上指针锁。
     *
     * 不加这个的话，检查器在屏幕右侧，往右拖几下鼠标就撞到窗口边缘、位移不再增加，
     * 值卡在那里（达芬奇那类工具靠「光标从另一侧穿回来」解决，浏览器里做不了光标
     * 回绕，但 Pointer Lock 是等价手段：光标隐藏后 movementX 不再受屏幕边界约束）。
     * 只在贴边时启用，所以普通拖动的手感与光标形态完全不变。
     */
    if (!lockTried && (e.clientX <= EDGE_PX || e.clientX >= window.innerWidth - EDGE_PX)) {
      lockTried = true;
      const req = wrapEl.requestPointerLock?.();
      // 新版 Chrome 返回 Promise，可能被拒绝（无用户手势 / 无头环境）——静默降级
      if (req && typeof (req as Promise<void>).catch === 'function') {
        (req as Promise<void>).catch(() => {});
      }
    }

    const mods = modsOf(e);
    // 修饰键变了就把锚点挪到当下——否则值会瞬间跳到另一套灵敏度算出的刻度。
    if (!modifiersEqual(mods, lastMods)) {
      session = rebase(session, currentValue, accumDx);
      lastMods = mods;
    }
    const v = scrubValue(session, accumDx, mods, cfg);
    currentValue = v;
    text = formatValue(v, decimals);
    oninput?.(v);
  }

  function up(e: PointerEvent): void {
    if (!armed) return;
    const wasDragging = dragging;
    dragging = false;
    const wasLocked = locked();
    detach();
    if (wasLocked) document.exitPointerLock();
    if (wrapEl.hasPointerCapture(e.pointerId)) wrapEl.releasePointerCapture(e.pointerId);

    if (wasDragging) {
      const v = commitValue(currentValue, { ...cfg, precision: decimals });
      text = formatValue(v, decimals);
      if (v !== value) onchange(v);
      // 拖完失焦：下一次点击又从头开始拖动，而不是先进入编辑态
      inputEl.blur();
    } else {
      // 没越过阈值 → 当点击：聚焦并全选，直接打字就覆盖
      inputEl.focus();
      inputEl.select();
    }
    // 无论 onchange 有没有触发，都要给实时预览一个确定的收尾信号。
    onliveend?.();
  }

  /* --------------------------------------------------------- 文本编辑 */

  function onFocus(): void {
    focused = true;
    inputEl.select();
  }

  function onBlur(): void {
    focused = false;
    commit();
  }

  function commit(): void {
    const parsed = parseValue(inputEl.value);
    // 空 / 只有减号 = 还在编辑中，别提交，回退到当前值
    if (parsed === null) {
      text = formatValue(value, decimals);
      return;
    }
    // 键入的是精确值：只钳制、不吸附到 step 格点（见 scrub.ts 的 commitValue 注释）
    const v = commitValue(parsed, { ...cfg, precision: decimals }, { quantize: false });
    text = formatValue(v, decimals);
    if (v !== value) onchange(v);
  }

  function onTextKey(e: KeyboardEvent): void {
    if (e.key === 'Enter') {
      e.preventDefault();
      commit();
      inputEl.blur();
      return;
    }
    if (e.key === 'Escape') {
      e.preventDefault();
      text = formatValue(value, decimals);
      inputEl.blur();
      return;
    }
    if (e.key === 'Home' || e.key === 'End') {
      e.preventDefault();
      const v = e.key === 'Home' ? (min ?? value) : (max ?? value);
      text = formatValue(v, decimals);
      onchange(commitValue(v, { ...cfg, precision: decimals }));
      return;
    }
    const d = keyDelta(e.key, cfg.step, e.shiftKey);
    if (d === null) return;
    e.preventDefault();
    const v = commitValue(value + d, { ...cfg, precision: decimals });
    text = formatValue(v, decimals);
    onchange(v);
  }
</script>

<!--
  svelte-ignore a11y_no_static_element_interactions
  这个 div 只是**拖拽热区**：语义元素是它内部的 input（role=spinbutton，
  带 aria-valuenow 等）。给热区加 role 反而会让屏幕阅读器多读一个空节点。
-->
<div
  class="num"
  class:dragging
  bind:this={wrapEl}
  class:fluid
  style:width={fluid ? '100%' : `${width}px`}
  data-exempt
  data-testid={testid ? `${testid}-wrap` : 'param-number-wrap'}
  use:tip={{ text: tipText ?? '', disabled: !tipText }}
  onpointerdown={down}
  onpointermove={move}
  onpointerup={up}
  onpointercancel={up}
>
  <input
    bind:this={inputEl}
    type="text"
    inputmode="decimal"
    role="spinbutton"
    autocomplete="off"
    spellcheck="false"
    style:text-align={align}
    aria-label={ariaLabel}
    aria-valuemin={min}
    aria-valuemax={max}
    aria-valuenow={value}
    {disabled}
    value={text}
    data-testid={testid ?? 'param-number'}
    oninput={(e) => (text = e.currentTarget.value)}
    onfocus={onFocus}
    onblur={onBlur}
    onkeydown={onTextKey}
  />
  {#if suffix}<span class="num-suffix">{suffix}</span>{/if}
</div>

<style>
  /*
   * 填满容器：宽度交给行内样式（`100%`），这里只管「可以被压缩 + 内边距收窄」。
   *
   * 不能用 `flex: 1 1 0` —— 色轮那一行是**纵向** flex 格子，那个简写会把
   * `flex-basis` 作用到高度上，框会被压成 14px 高、内容还缩到 22px 宽。
   * 一行四个框时的 16px 左右留白也是「0.00 被裁掉」的元凶，这里收成 2px。
   */
  .num.fluid {
    flex: 0 1 auto;
    min-width: 0;
    /* 内边距归零：一行四个框时那 4px 就是 `-0.20` 被裁掉的那几个像素。 */
    padding: 0;
  }
  .num.fluid input {
    width: 100%;
    min-width: 0;
  }
</style>
