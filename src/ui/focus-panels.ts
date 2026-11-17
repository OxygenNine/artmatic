/**
 * focus-panels.ts — 面板级键盘焦点。
 *
 * 「面板」在这里是一个**布局区域**，不是组件：时间轴、左抽屉、右侧检查器。
 * 每个面板的最外层容器带 `data-focus-panel="<id>"` —— 这是唯一真源，本文件
 * 与全局 CSS 都只认这个属性：
 *
 *   - `Shift + 1…6`：打开（需要时）并聚焦对应面板；焦点落在面板内第一个可聚焦
 *     元素上，之后 Tab 在该面板内回绕（见 `tabWithinPanel`）。
 *   - `Ctrl + Shift + .`：在**当前在场**的面板之间轮询（不打开关着的面板 ——
 *     一次快捷键顺手打开四个抽屉不是用户要的）。
 *   - `Esc`：退出面板模式并把焦点从当前元素上释放（`releaseFocusOnEscape`）。
 *
 * 为什么需要「面板模式」这一层状态：面板内 Tab 回绕是**有侵略性**的（它不让
 * 焦点用 Tab 走出去）。默认浏览（鼠标点一下然后 Tab）必须保持浏览器原生行为，
 * 只有用户显式用面板快捷键进来之后才接管 Tab。Esc 是那个出口 —— 这也是为什么
 * 它必须和这套机制一起做，单独一个 Esc 快捷键没有意义。
 *
 * 高亮线是纯 CSS（`[data-focus-panel]:focus-within`），不在这里维护状态：
 * 焦点在哪，线就画哪 —— 手点、键盘、程序聚焦三种来源天然一致。
 */

import { tick } from 'svelte';
import type { MessageKey } from '../i18n/locales';
import { appState } from './app-state.svelte';
import { focusablesIn, isTextEditable } from './focus';

export type FocusPanelId = 'timeline' | 'pool' | 'modulator' | 'agent' | 'issues' | 'inspector';

interface PanelDef {
  id: FocusPanelId;
  /** `Shift + 数字` 的编号（1 起）。 */
  digit: number;
  labelKey: MessageKey;
  /** 让面板出现。已经开着时必须是 no-op（幂等）—— 连按两次不能把抽屉关掉。 */
  open: () => void;
}

/**
 * 编号按**界面上的位置**排：时间轴（主体）→ 左侧抽屉（rail 从上到下）→ 检查器。
 * 顺序即 `Ctrl+Shift+.` 的轮询顺序，改顺序前先想「用户脑子里的『下一个面板』是什么」。
 */
export const FOCUS_PANELS: readonly PanelDef[] = [
  { id: 'timeline', digit: 1, labelKey: 'app.panelTimeline', open: () => backToTimeline() },
  {
    id: 'pool',
    digit: 2,
    labelKey: 'app.panelPool',
    open: () => {
      backToTimeline();
      appState.setMediaPoolOpen(true);
    },
  },
  {
    id: 'modulator',
    digit: 3,
    labelKey: 'app.panelModulator',
    open: () => {
      backToTimeline();
      appState.setModulatorOpen(true);
    },
  },
  {
    id: 'agent',
    digit: 4,
    labelKey: 'app.panelAgent',
    open: () => {
      backToTimeline();
      appState.setAgentOpen(true);
    },
  },
  {
    id: 'issues',
    digit: 5,
    labelKey: 'app.panelIssues',
    open: () => {
      backToTimeline();
      appState.setIssuesOpen(true);
    },
  },
  {
    id: 'inspector',
    digit: 6,
    labelKey: 'app.panelInspector',
    open: () => {
      backToTimeline();
      // `toggleDrawer` 是三态的，这里要的是「确保可见且展开」。
      if (!appState.drawerOpen) appState.toggleDrawer();
      else if (appState.drawerCollapsed) appState.setDrawerCollapsed(false);
    },
  },
];

/** 排版 / 调色 / 粒子页都不在主界面里，面板住在时间轴页上。 */
function backToTimeline(): void {
  if (appState.editorOpen) appState.closeTypographyView();
  else if (appState.gradeOpen) appState.closeGradeEditor();
  else if (appState.particlesOpen) appState.closeParticleEditor();
}

/** 当前处于「面板模式」的面板。null = 普通浏览（Tab 完全交给浏览器）。 */
let activePanel: FocusPanelId | null = null;

/** 面板容器（不存在 = 这个面板此刻不在场）。 */
function panelEl(id: FocusPanelId): HTMLElement | null {
  return document.querySelector<HTMLElement>(`[data-focus-panel="${id}"]`);
}

function focusFirstIn(panel: HTMLElement): void {
  const list = focusablesIn(panel);
  if (list.length) {
    list[0]!.focus({ preventScroll: true });
    return;
  }
  /*
   * 面板里一个可聚焦元素都没有（空媒体池、空的 Agent 抽屉）：焦点落在容器本身上。
   * 这样高亮线与面板模式的语义都还成立，Tab / Esc 也不会「按了没反应」。
   * `tabindex="-1"` 是「可程序聚焦但不在 Tab 序列里」，比把它塞进 Tab 序列更准确。
   */
  if (!panel.hasAttribute('tabindex')) panel.setAttribute('tabindex', '-1');
  panel.focus({ preventScroll: true });
}

/**
 * 打开（必要时）并聚焦面板。返回是否成功 —— 面板在 `tick()` 之后仍不存在
 * （例如工程被关掉了），调用方不该假装它发生了。
 */
export async function focusPanel(id: FocusPanelId): Promise<boolean> {
  const def = FOCUS_PANELS.find((p) => p.id === id);
  if (!def) return false;
  def.open();
  // 抽屉是条件渲染的：`open()` 只是改状态，DOM 要到下一次 flush 才有。
  await tick();
  const el = panelEl(id);
  if (!el) return false;
  activePanel = id;
  focusFirstIn(el);
  return true;
}

/** `Ctrl + Shift + .`：在**在场**面板之间轮询。 */
export async function cyclePanel(): Promise<boolean> {
  const present = FOCUS_PANELS.filter((p) => panelEl(p.id) !== null);
  if (!present.length) return false;
  const current = activePanel ? present.findIndex((p) => p.id === activePanel) : -1;
  const next = present[(current + 1) % present.length]!;
  return focusPanel(next.id);
}

/**
 * 面板内 Tab 回绕。只在面板模式生效，并且焦点必须真的还在那个面板里
 * （用户中途用鼠标点了别的区域 → 模式自动失效，Tab 回到浏览器原生行为）。
 */
export function tabWithinPanel(e: KeyboardEvent): boolean {
  if (e.key !== 'Tab' || e.ctrlKey || e.altKey || e.metaKey) return false;
  if (!activePanel) return false;
  const panel = panelEl(activePanel);
  if (!panel) {
    activePanel = null;
    return false;
  }
  const active = document.activeElement;
  if (!(active instanceof HTMLElement) || !panel.contains(active)) {
    // 焦点跑到面板外了：模式结束，别把 Tab 抢回来。
    activePanel = null;
    return false;
  }
  const list = focusablesIn(panel);
  if (list.length < 2) return false;
  const i = list.indexOf(active);
  if (i < 0) return false;
  const next = (i + (e.shiftKey ? -1 : 1) + list.length) % list.length;
  e.preventDefault();
  list[next]!.focus();
  return true;
}

/**
 * `Esc` = 从当前焦点元素上逃离。
 *
 * 顺序上必须在全局快捷键的 `isExempt` **之前**调用：文本框命中豁免就整段早退，
 * 而「离开输入框」正是这里要做的事。控件自己处理 Esc 时会 `preventDefault`
 * （NumberInput 取消输入、Select 收起列表），那种情况一律让路 —— 所以先看
 * `defaultPrevented`。
 *
 * 返回 true = 这次 Esc 已经用掉了，调用方不要再执行「关闭页面 / 关弹窗」。
 */
export function releaseFocusOnEscape(e: KeyboardEvent): boolean {
  if (e.key !== 'Escape' || e.defaultPrevented) return false;
  const active = document.activeElement;
  if (!(active instanceof HTMLElement) || active === document.body) {
    activePanel = null;
    return false;
  }
  /*
   * 菜单 / 下拉弹层 / 弹窗里的焦点归它们自己：那些组件的 Esc 是「关掉它」，
   * 不是「失焦」。菜单项不是表单控件，失焦之后菜单反而关不掉。
   */
  if (active.closest('[role="menu"], [role="listbox"], [role="dialog"]')) return false;

  activePanel = null;
  e.preventDefault();
  if (isTextEditable(active)) {
    /*
     * 失焦会让 TextField / NumberInput 的 `onblur` 提交草稿。但走到这里说明
     * 控件自己**没有**处理 Esc（处理了就会 defaultPrevented）—— 大多是没有
     * Esc 语义的原生输入框，提交是比「卡在框里」更合理的结局。
     */
    active.blur();
    return true;
  }
  active.blur();
  return true;
}

/**
 * 焦点是否落在某个面板内（给测试 / 调试用）。
 * 不参与运行期逻辑：界面只用 CSS 的 `:focus-within` 判断高亮。
 */
export function focusedPanelId(): FocusPanelId | null {
  const active = document.activeElement;
  if (!(active instanceof Element)) return null;
  const id = active.closest<HTMLElement>('[data-focus-panel]')?.dataset.focusPanel;
  return (id as FocusPanelId | undefined) ?? null;
}
