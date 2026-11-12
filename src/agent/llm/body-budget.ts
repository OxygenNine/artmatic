/**
 * body-budget.ts — 请求体**字节**预算（纯函数，可单测）。
 *
 * ## 为什么需要一层专门管字节
 *
 * 上下文环形量的是 **token**，服务端卡的是**字节**，两者不是一回事：
 * DeepSeek 的一帧截图按 token 算最多 1024（视觉输入缩放到约 1300×1300 后封顶），
 * 按 base64 字节算却有 1–3 MB。于是下面两句话可以同时为真：
 *
 *   - 面板显示「上下文 12%」（12 万 token，离 1M 很远）
 *   - 上游返回「输入太大」（请求体撞了 48 MiB 上限）
 *
 * 历史里从不清除旧截图，所以这个比例会随会话长度单调恶化 —— 而且 token 估算
 * 永远看不到它。这里按**字节**给出一个本地预算，超了就**从最老的开始**把内联图
 * 换成一行说明文字（保留最近的那几张）。
 *
 * ## 为什么预算小于服务端上限
 *
 * 48 MiB 是整个请求体（含消息、工具表、思考链回写），不是图片专项。留出十几 MB
 * 给文本与工具 schema，图片侧按 32 MiB 夹。
 *
 * 换掉旧图会改变前缀 ⇒ 那一次请求的缓存必然 miss。这是**必须付**的代价：
 * 另一条路是整轮发不出去。
 */

import type { WireMessage, WirePart } from './types';

/** 内联图片（base64 data URL）允许占用的字节数。 */
export const INLINE_IMAGE_BUDGET = 32 * 1024 * 1024;

/** 被换掉的内联图留下的占位文案（英文，和工具描述同语言）。 */
export const DROPPED_IMAGE_NOTE =
  '[screenshot dropped: the request body was over the size limit, so older inline images were removed. ' +
  'Take a fresh render_frame if you need to look again.]';

/** 只对 base64 data URL 计字节：外链图片是服务端去下载，不占我们的请求体。 */
function dataUrlBytes(part: WirePart): number {
  if (part.type !== 'image_url') return 0;
  const url = part.image_url.url;
  return url.startsWith('data:') ? url.length : 0;
}

/** 历史里内联图片一共占多少字节。 */
export function inlineImageBytes(messages: readonly WireMessage[]): number {
  let total = 0;
  for (const m of messages) {
    if (!Array.isArray(m.content)) continue;
    for (const part of m.content) total += dataUrlBytes(part);
  }
  return total;
}

/**
 * 把最老的内联图换成占位文字，直到字节数落回预算内。
 *
 * 返回**新数组**（不改入参）：调用方通常还要用原历史做别的判断。
 * `dropped` 是换掉的张数，0 表示什么都没做（此时 `messages` 原样返回同一引用）。
 */
export function shedInlineImages(
  messages: readonly WireMessage[],
  budget = INLINE_IMAGE_BUDGET,
): { messages: readonly WireMessage[]; dropped: number } {
  let total = inlineImageBytes(messages);
  if (total <= budget) return { messages, dropped: 0 };

  const out: WireMessage[] = [];
  let dropped = 0;
  for (const m of messages) {
    if (total <= budget || !Array.isArray(m.content)) {
      out.push(m);
      continue;
    }
    let touched = false;
    const parts: WirePart[] = m.content.map((part) => {
      const bytes = dataUrlBytes(part);
      if (bytes === 0 || total <= budget) return part;
      total -= bytes;
      dropped += 1;
      touched = true;
      return { type: 'text', text: DROPPED_IMAGE_NOTE };
    });
    out.push(touched ? { ...m, content: parts } : m);
  }
  return { messages: out, dropped };
}
