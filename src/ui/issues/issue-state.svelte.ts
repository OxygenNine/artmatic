/**
 * issue-state.svelte.ts — 预览批注的**即时 UI 状态**（不进工程、不进撤销栈）。
 *
 * 只有一件事：现在正在给哪条标记写注释。它由三处驱动 —— 右键菜单的
 * 「编辑注释」、新建标记（建完立刻开）、面板里的条目点击 —— 而注释框长在
 * `IssueOverlay` 里（它才知道标记在画面上的像素位置）。放在这里是为了让
 * 三个入口不必各自维护一个「注释框开着没」的布尔量。
 *
 * 选中态（`appState.selectedIssueId`）不在这里：它跨面板 / 时间轴 / 预览，
 * 属于应用级 UI 状态。
 */

let editing = $state<string | null>(null);

/** 正在编辑注释的标记 id（`null` = 没开）。 */
export function editingIssueId(): string | null {
  return editing;
}

export function openIssueNote(id: string): void {
  editing = id;
}

export function closeIssueNote(): void {
  editing = null;
}
