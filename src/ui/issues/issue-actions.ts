/**
 * issue-actions.ts — 批注的用户动作（新建 / 跳转 / 颜色落库）。
 *
 * 预览右键菜单、Issues 面板、时间轴的彩色线都调这里，**不各自拼一份写入**：
 * 新建要一起决定默认色、默认大小、时间段与「建完立刻写注释」这条顺手流程，
 * 散在三处就一定会有一处忘掉其中一项（表现是「从这个入口建的标记不弹注释框」）。
 */

import { ISSUE_COLORS, squareSize, type IssueMarker } from '../../core/issues';
import { resolveThemeColor } from '../../typography/theme';
import { appState } from '../app-state.svelte';
import { openIssueNote } from './issue-state.svelte';

/**
 * 在画面的归一化坐标 (u, v) 处新建一条标记，并打开注释框。
 *
 * - 时间段从**当前播放头**开始，默认只有**一帧**（标记就是「我看到这一帧有问题」）；
 *   想要它持续显示，就在时间轴上拖结尾手柄或在面板里改时长。
 * - 尺寸是视觉上的正方形（`squareSize` 按画面比例折算）；
 * - 颜色按已有条数轮换，相邻标记不同色，时间轴上的多条线才分得开。
 */
export function createIssueAt(u: number, v: number): string | null {
  if (!appState.hasProject) return null;
  const issues = appState.project.issues ?? [];
  const size = squareSize(appState.project.resolution);
  const start = appState.playT;
  const id = appState.store.addIssue({
    start,
    end: start + 1 / Math.max(1, appState.project.fps),
    x: u,
    y: v,
    w: size.w,
    h: size.h,
    color: ISSUE_COLORS[issues.length % ISSUE_COLORS.length]!,
    note: '',
  });
  appState.selectIssue(id);
  openIssueNote(id);
  return id;
}

/** 跳到标记的起点并选中它（面板条目与时间轴线共用）。 */
export function jumpToIssue(issue: Pick<IssueMarker, 'id' | 'start'>): void {
  appState.selectIssue(issue.id);
  appState.seek(issue.start);
}

/**
 * 取色卡可能写回主题色引用（`@accent1`），而批注存的是裸 hex。
 *
 * 不在这里解析的话，`store.updateIssue` 会把非 hex 的值当成坏颜色**静默保留原色** ——
 * 表现正是「取色卡能点、颜色就是不变」。与检查器里那几处取色同一条纪律：
 * 解析在写入端做，落库值永远是 hex。
 */
export function resolveIssueColor(v: string): string {
  return resolveThemeColor(v, appState.project.typographyTheme, appState.project.customThemes ?? null);
}
