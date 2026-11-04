/**
 * graph-layout.ts — 节点位置（**会话级** UI 状态）。
 *
 * 位置不是工程数据：它是「这一次我怎么摆这块画布」，与表达式本身无关，也
 * 不该跟着工程走（同一份「抖动」在两个工程里被摆在不同的角落是正常的）。
 * 放模块级 Map 而不是 UiPrefs：它每天都会变，而 localStorage 是给「一次设好
 * 长期不变」的东西用的。
 *
 * 键用 `modulatorId`：表达式变了导致路径对不上时，多余的条目会在下次布局时
 * 被忽略（改 AST 不会去扫旧键 —— 那点内存不值得写一段对账代码）。
 */
const store = new Map<string, Record<string, { x: number; y: number }>>();

export function loadLayout(key: string): Record<string, { x: number; y: number }> {
  return store.get(key) ?? {};
}

export function saveLayout(key: string, value: Record<string, { x: number; y: number }>): void {
  if (Object.keys(value).length > 0) store.set(key, value);
  else store.delete(key);
}

export function resetLayout(key: string): void {
  store.delete(key);
}
