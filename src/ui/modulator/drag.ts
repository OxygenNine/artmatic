/**
 * drag.ts — 调制器条目的拖拽载荷约定（纯常量 + 两个小函数）。
 *
 * 单独一个模块而不是从抽屉组件里 `export const`：Svelte 的实例脚本不许
 * 导出非 prop 的绑定，而**拖端与落端必须用同一个类型字符串** ——
 * 两处各写一遍就是「有一天其中一处拼错了，拖放静默失效」。
 *
 * 用自定义 MIME 而不是 `text/plain`：从别处拖一段文字进来时不该被当成绑定。
 * 读不到类型时整段忽略，于是「拖了个别的东西」就是什么都不发生。
 */
export const MOD_DRAG_TYPE = 'application/x-artmatic-modulator';

/** 落点读出的调制器 id（不是本类型的拖拽返回 null）。 */
export function readModDrag(dt: DataTransfer | null): string | null {
  if (!dt) return null;
  const id = dt.getData(MOD_DRAG_TYPE);
  if (id) return id;
  /*
   * Chromium 在 `dragover` 阶段不给 `getData()`（数据只在 drop 时可读）——
   * 所以**能不能落**必须靠 `types` 判，而不是靠 `getData` 空不空。
   */
  return dt.types.includes(MOD_DRAG_TYPE) ? '' : null;
}

/** `dragover` 阶段判「这是不是我们的拖拽」（此时 `getData` 恒为空）。 */
export function isModDrag(dt: DataTransfer | null): boolean {
  return !!dt && dt.types.includes(MOD_DRAG_TYPE);
}
