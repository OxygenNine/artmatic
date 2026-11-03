/**
 * external-link.ts — 打开站外链接的唯一入口。
 *
 * 两条路，判据是「宿主有没有系统浏览器」而不是「是不是桌面」：
 *
 *  - 桌面壳（`platform.shell.openExternal`）：交给系统浏览器。页面自己开窗口会得到
 *    一个没有菜单、没有地址栏的 Electron 窗口，用户回不来。
 *  - 浏览器：`window.open(..., 'noopener')`，新标签页。
 *
 * 调用点仍然把 `href` 写在 `<a>` 上（中键 / 复制链接 / 无障碍语义都靠它），
 * 只在左键点击时 `preventDefault()` 转给这里 —— 这样两边的行为不会分叉。
 */

import { platform } from '../platform/index';

export function openExternal(url: string): void {
  const shell = platform.shell;
  if (shell?.openExternal) {
    shell.openExternal(url);
    return;
  }
  window.open(url, '_blank', 'noopener,noreferrer');
}
