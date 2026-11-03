/**
 * recent-menu.ts — 「最近工程」的右键菜单内容。
 *
 * 单独一份而不是散在组件里：首页的封面卡 / 列表行、工程面板的「最近」页都是
 * 同一批数据，三条动作必须一字不差地出现在这三处 —— 各写一遍必然漂（其中一处
 * 忘了加二次确认就是真事故）。
 *
 * 「删除工程」不在这里直接执行：它要过 `ConfirmDialog`，而弹窗是调用方的状态。
 * 所以只把意图回调出去（见 `ondelete`）。
 */

import type { MenuItem } from './controls/menu-model';
import type { ProjectRef } from '../project/handles';
import { forgetRecentProject, openProjectFolder } from './project-actions';
import { tr } from '../i18n/index.svelte';

/**
 * @param ondelete 用户选了「删除工程」——调用方负责弹二次确认，确认后调
 *   `deleteProjectFromDisk(ref)`。
 */
export function recentMenuItems(ref: ProjectRef, ondelete: (ref: ProjectRef) => void): MenuItem[] {
  return [
    {
      id: 'open-folder',
      label: tr('proj.menuOpenFolder'),
      icon: 'folder-open',
      testid: 'recent-menu-open',
      onselect: () => void openProjectFolder(ref),
    },
    {
      // 只动列表，不碰磁盘 —— 所以没有二次确认：再打开一次就回来了。
      id: 'forget',
      label: tr('proj.menuForget'),
      icon: 'minus',
      testid: 'recent-menu-forget',
      onselect: () => forgetRecentProject(ref),
    },
    { id: 'sep', separator: true },
    {
      id: 'delete',
      label: tr('proj.menuDelete'),
      icon: 'trash',
      danger: true,
      testid: 'recent-menu-delete',
      onselect: () => ondelete(ref),
    },
  ];
}
