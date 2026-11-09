/**
 * export-gate.ts — 同一时刻只允许一份导出。
 *
 * UI 与 Agent 共用一台 Renderer；两边的忙标记各自为政，且都在 await 之后才置上。
 * 闸门必须同步获取，并且跨界面共用一个模块实例。
 */

export type ExportOwner = 'ui' | 'agent';

let current: ExportOwner | null = null;

/** 占用闸门；已被占用时返回 null。一个 lease 只对应一次导出。 */
export function tryAcquireExport(owner: ExportOwner): (() => void) | null {
  if (current !== null) return null;
  current = owner;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    if (current === owner) current = null;
  };
}

export function exportOwner(): ExportOwner | null {
  return current;
}

/** 单测用：清空模块级状态。 */
export function resetExportGateForTests(): void {
  current = null;
}
