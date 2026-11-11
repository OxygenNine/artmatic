/**
 * floating.ts — 无遮罩浮层的**拖动 / 缩放**（曲线编辑器与插件浮窗共用）。
 *
 * 从 `CurveEditor.svelte` 里抽出来的，行为逐字保持：
 *  - 只在标题栏起拖，坐标用 `getBoundingClientRect` 的左上角 + 指针位移；
 *  - 全程 clamp 在视口内（`4px` 边距），拖出屏幕的浮窗再也拿不回来；
 *  - 监听挂在 `window` 上而不是元素上：指针移出面板时仍然跟手；
 *  - `pointerup` / `pointercancel` 都收尾，不留下半截手势。
 *
 * 为什么不是 Svelte action：拖动过程要写组件内的 `$state`（位置 / 尺寸），
 * 做成 action 反而要通过闭包回传，读起来比直接给回调更绕。
 */

export interface FloatingPos {
  x: number;
  y: number;
}

export interface FloatingSize {
  w: number;
  h: number;
}

/** 视口内边距：贴边时仍能看到 4px 的边框，不至于「框没了、只剩阴影」。 */
const EDGE = 4;

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
}

function listen(onMove: (e: PointerEvent) => void, onEnd: () => void): void {
  const up = (): void => {
    window.removeEventListener('pointermove', onMove);
    window.removeEventListener('pointerup', up);
    window.removeEventListener('pointercancel', up);
    onEnd();
  };
  window.addEventListener('pointermove', onMove);
  window.addEventListener('pointerup', up);
  window.addEventListener('pointercancel', up);
}

export interface FloatingMoveOptions {
  e: PointerEvent;
  el: HTMLElement;
  onMove: (pos: FloatingPos) => void;
  onEnd?: (pos: FloatingPos) => void;
}

/**
 * 起拖。调用方负责判断「这次 pointerdown 该不该拖」（例如标题栏 / 按钮例外），
 * 这里只处理左键与实际的位移。
 */
export function startFloatingMove(opt: FloatingMoveOptions): void {
  const { e, el, onMove, onEnd } = opt;
  if (e.button !== 0) return;
  e.preventDefault();
  const r = el.getBoundingClientRect();
  const startX = e.clientX;
  const startY = e.clientY;
  const ox = r.left;
  const oy = r.top;
  let last: FloatingPos = { x: ox, y: oy };
  const mv = (ev: PointerEvent): void => {
    last = {
      x: clamp(ox + ev.clientX - startX, EDGE, window.innerWidth - r.width - EDGE),
      y: clamp(oy + ev.clientY - startY, EDGE, window.innerHeight - r.height - EDGE),
    };
    onMove(last);
  };
  listen(mv, () => onEnd?.(last));
}

export interface FloatingResizeOptions {
  e: PointerEvent;
  el: HTMLElement;
  /** 下限（px）。插件浮窗用 240×160，曲线编辑器用 520×260。 */
  minW: number;
  minH: number;
  onStart?: () => void;
  onMove: (size: FloatingSize) => void;
  onEnd?: (size: FloatingSize) => void;
}

/** 右下角热区起缩放。上限是「不超出视口」（至少保留 `minW` / `minH`）。 */
export function startFloatingResize(opt: FloatingResizeOptions): void {
  const { e, el, minW, minH, onStart, onMove, onEnd } = opt;
  if (e.button !== 0) return;
  e.preventDefault();
  e.stopPropagation();
  const r = el.getBoundingClientRect();
  const w0 = r.width;
  const h0 = r.height;
  const x0 = e.clientX;
  const y0 = e.clientY;
  const maxW = Math.max(minW, window.innerWidth - r.left - 8);
  const maxH = Math.max(minH, window.innerHeight - r.top - 8);
  onStart?.();
  let last: FloatingSize = { w: w0, h: h0 };
  const mv = (ev: PointerEvent): void => {
    last = {
      w: clamp(w0 + ev.clientX - x0, minW, maxW),
      h: clamp(h0 + ev.clientY - y0, minH, maxH),
    };
    onMove(last);
  };
  listen(mv, () => onEnd?.(last));
}
