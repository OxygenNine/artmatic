/**
 * plugin-panels.ts — 插件面板的**界面状态**（开着哪些、浮窗在哪、dock 停在哪个 tab）。
 *
 * 真相在 `OpenProject.pluginPanels`（普通对象，要原样进 `session.json`），
 * 这里只提供改它的函数。改完统一走 `appState.touchPluginPanels()`：
 * 一次调用同时负责「界面重算」与「把会话状态排进落盘队列」——
 * 漏掉后者的表现是「拖完浮窗、下次打开回到原位」，而且不会报错。
 *
 * ## 为什么键是 `${pluginId}/${panelId}`
 *
 * 复用 `core/plugin-id.ts` 的命名空间规则：面板 / 动作 / 特效 / 生成器共用一个
 * 对外 id 形态，缺失与归属判定不必再写一套。
 *
 * ## 为什么没有「按 kind 分类」的字段
 *
 * 面板的 kind 属于**清单**（运行期随时可能换一版），不属于界面状态。
 * 状态里只记「这个键开着」，kind 由 `PluginPanelLayer` 现查现用 ——
 * 把 kind 抄进 session 会出现「插件改名了、面板还按旧形态渲染」。
 */

import { appState } from '../app-state.svelte';
import { pluginDefId } from '../../core/plugin-id';
import type { SessionPanelBox, SessionPanels } from '../../project/session';

/** 面板 / 动作的对外 id。与 `pluginDefId` 同一实现，单独包一层是为了语义。 */
export function panelKey(pluginId: string, panelId: string): string {
  return pluginDefId(pluginId, panelId);
}

function state(): SessionPanels {
  return appState.pluginPanels;
}

export function isPanelOpen(key: string): boolean {
  return state().open.includes(key);
}

/** 打开一个面板。已经开着时什么都不做（幂等：Rail 图标可能连点）。 */
export function openPanel(key: string): void {
  const s = state();
  if (s.open.includes(key)) return;
  s.open = [...s.open, key];
  appState.touchPluginPanels();
}

export function closePanel(key: string): void {
  const s = state();
  if (!s.open.includes(key)) return;
  s.open = s.open.filter((x) => x !== key);
  if (s.dock === key) s.dock = null;
  appState.touchPluginPanels();
}

export function togglePanel(key: string): void {
  if (isPanelOpen(key)) closePanel(key);
  else openPanel(key);
}

export function panelBox(key: string): SessionPanelBox | null {
  return state().boxes[key] ?? null;
}

/**
 * 记一次浮窗几何（拖动结束 / 缩放结束调）。
 *
 * 拖动过程中**不要**每帧调 —— 它每次都推一次会话落盘调度（0.9 s 防抖，
 * 但会一直重置计时器）。调用点在 pointerup。
 */
export function setPanelBox(key: string, box: SessionPanelBox): void {
  const s = state();
  s.boxes = { ...s.boxes, [key]: box };
  appState.touchPluginPanels();
}

export function dockKey(): string | null {
  return state().dock;
}

export function setDockKey(key: string | null): void {
  const s = state();
  if (s.dock === key) return;
  s.dock = key;
  appState.touchPluginPanels();
}

/* --------------------------------------------------------- 就绪标记 */

/**
 * 已经挂完插件的工程。**没有就绪的工程一律不剪**。
 *
 * 打开工程的顺序是「读 session（含面板开关）→ adoptProject → 挂插件」，
 * 中间那一步 `panelsFor()` 还是空的。这时剪一次会把用户上次开着的面板
 * 全部删掉，而界面上只是「面板没恢复」，没有任何错误。
 */
const ready = new Set<string>();

export function isPanelStateReady(projectId: string): boolean {
  return ready.has(projectId);
}

/** `mountPlugins` 返回之后调一次：剪掉已失效的键，并让面板层重算。 */
export function markPanelStateReady(projectId: string): void {
  if (ready.has(projectId)) return;
  ready.add(projectId);
  prunePanelState(
    new Set(appState.plugins.panelsFor(projectId).map((e) => pluginDefId(e.pluginId, e.panel.id))),
  );
  // 即使什么都没剪，也要让面板层重算一次（它可能在等这个标记）。
  appState.pluginPanelRevision++;
}

/**
 * 收敛到「当前真实存在的面板集合」。
 *
 * 调用点只有一个：插件 revision 变化时（安装 / 停用 / 移除 / 热重载）。
 * 不做这一步的表现是：停用插件后 session 里还留着它的键，下次打开工程时
 * 面板层尝试渲染一个不存在的面板 —— 报不出来，只是那一格空着。
 */
export function prunePanelState(available: ReadonlySet<string>): void {
  const s = state();
  const open = s.open.filter((k) => available.has(k));
  const boxes: Record<string, SessionPanelBox> = {};
  for (const [key, box] of Object.entries(s.boxes)) {
    if (available.has(key)) boxes[key] = box;
  }
  const dock = s.dock && available.has(s.dock) ? s.dock : null;
  const changed =
    open.length !== s.open.length ||
    Object.keys(boxes).length !== Object.keys(s.boxes).length ||
    dock !== s.dock;
  if (!changed) return;
  s.open = open;
  s.boxes = boxes;
  s.dock = dock;
  appState.touchPluginPanels();
}
