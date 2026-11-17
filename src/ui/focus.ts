/**
 * focus.ts — 全局快捷键的豁免判据。
 *
 * 背景：应用在 window 上接管了 Space / Delete / Ctrl+Z 等一批键。自研控件
 * （下拉、滑杆、数字框、复选框）**不是**原生 `<input>`，所以原来那句
 * 「target 是 INPUT/SELECT/TEXTAREA 就放行」对它们全部失效——在下拉上按
 * Space 会同时打开下拉和开始播放。约定是：所有自研控件的根节点带
 * `data-exempt`，这里统一识别。
 */

const NATIVE_TEXT_TAGS = new Set(['INPUT', 'SELECT', 'TEXTAREA']);

export function isTextEditable(el: Element | null): boolean {
  if (!el) return false;
  if (NATIVE_TEXT_TAGS.has(el.tagName)) return true;
  return el instanceof HTMLElement && el.isContentEditable;
}

/** 该目标是否「自己处理键盘」，全局快捷键必须让路。 */
export function isExempt(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) return false;
  if (isTextEditable(target)) return true;
  return target.closest('[data-exempt]') !== null;
}

/**
 * 这些角色会**自己吃掉 Space**（控件自己的语义键）。若不管，聚焦在它们上面
 * 按 Space 会「操作控件」+「全局 togglePlay」同时发生。
 *
 * **原生按钮与 `role="button"` 不在名单里**，这是刻意的取舍：
 * 浏览器把 Space 当按钮的激活键，所以「聚焦按钮 → 按 Space」原本会激活按钮
 * 而不是播放。可 Space 是本应用最常用的快捷键，而用户总是刚点完某个按钮 ——
 * 于是它变成「点了按钮之后 Space 就暂时坏了」，比失去「Space 激活按钮」
 * 这条无障碍旁路更糟。按钮仍然可以用 **Enter** 激活（原生 `<button>` 的
 * Enter 默认行为保留；`role="button"` 的元素——时间轴片段——自己处理 Enter）。
 */
const SPACE_OWNER_ROLES = new Set([
  'checkbox',
  'combobox',
  'listbox',
  'menu',
  'menuitem',
  'option',
  'radio',
  'slider',
  'spinbutton',
  'switch',
  'tab',
]);

export function ownsSpaceKey(el: Element | null): boolean {
  if (!el) return false;
  if (el.tagName === 'BUTTON') return false;
  const role = el.getAttribute('role');
  if (role === 'button') return false;
  return role !== null && SPACE_OWNER_ROLES.has(role);
}

/** 当前焦点元素是否自己吃 Space。传给全局 Space 快捷键做二次判断。 */
export function activeElementOwnsSpace(): boolean {
  if (typeof document === 'undefined') return false;
  return ownsSpaceKey(document.activeElement);
}

/**
 * `Shift + 1…9` 的数字；不是这个组合时返回 null。
 *
 * 用 `e.code` 而不是 `e.key`：Shift 按下时 `key` 是 `!@#$%`，而 `Digit1` 稳定。
 * 小键盘也认（`Numpad1`）。
 *
 * 放在这里而不是 `focus-panels.ts`：它是纯的键位识别，能单测；而 focus-panels
 * 依赖 `appState`（含 runes），单测里拉不起。
 */
export function shiftDigitOf(e: KeyboardEvent): number | null {
  if (!e.shiftKey || e.ctrlKey || e.altKey || e.metaKey) return null;
  const m = /^(?:Digit|Numpad)([1-9])$/.exec(e.code);
  return m ? Number(m[1]) : null;
}

/* ------------------------------------------------------------ 焦点遍历 */

const FOCUSABLE_SELECTOR = [
  'a[href]',
  'button:not([disabled])',
  'input:not([disabled])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[contenteditable="true"]',
  '[tabindex]:not([tabindex="-1"])',
].join(',');

/**
 * `root` 里真正能被 Tab 到的元素，按 DOM 顺序。
 *
 * 用 `getClientRects()` 而不是 `offsetParent` 判可见性：`position: fixed` 的
 * 元素 `offsetParent` 恒为 null，而弹窗 / 面板里确实有 fixed 的浮层元素。
 *
 * 两个消费方：面板内 Tab 回绕（`focus-panels.ts`）与弹窗的焦点圈（`controls/Modal`）。
 * 它们必须对「什么算可聚焦」有同一份判断，否则同一个 Tab 在弹窗里和外面对不上。
 */
export function focusablesIn(root: HTMLElement): HTMLElement[] {
  return [...root.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)].filter(
    (el) => el.getClientRects().length > 0,
  );
}
