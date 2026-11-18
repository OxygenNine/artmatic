/**
 * stable-json.ts — 稳定序列化 + 32 位哈希（纯函数）。
 *
 * 存在的理由只有一个：**缓存键要能跨进程、跨会话复现**。`JSON.stringify` 按插入
 * 顺序输出键，而 `{a:1,b:2}` 与 `{b:2,a:1}` 是同一份数据 —— 拿它当键就会得到
 * 「同一个工程两次算出的键不同」，缓存永远不命中。
 *
 * 放在 `core/` 而不是排版目录：预览渲染缓存（`core/preview-cache.ts`）也要它，
 * 而 `core/` 不许反向依赖 `typography/`。排版那边的 `cache-key.ts` 继续对外
 * 导出这两个函数，调用点不用改。
 */

/** 稳定 JSON：对象键排序后再序列化。 */
export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;

  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  const parts: string[] = [];
  for (const k of keys) {
    const v = obj[k];
    if (v === undefined) continue;
    parts.push(`${JSON.stringify(k)}:${stableStringify(v)}`);
  }
  return `{${parts.join(',')}}`;
}

/** FNV-1a 32 位。够用：这里的碰撞后果只是缓存错命中，不是安全问题。 */
export function fnv1a(s: string, seed = 0x811c9dc5): string {
  let h = seed;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}
