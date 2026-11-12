import { describe, expect, it } from 'vitest';
import { DROPPED_IMAGE_NOTE, inlineImageBytes, shedInlineImages } from '../../src/agent/llm/body-budget';
import type { WireMessage } from '../../src/agent/llm/types';

/**
 * 字节预算的守卫。
 *
 * 它守的是一个**看不见的量**：token 环永远不会因为 base64 太大而变红，所以
 * 「请求体超限」只能在本地先算一次字节。三条判据：
 *   1. 只算 base64 data URL（外链图是服务端去下载，不占我们的请求体）；
 *   2. 从**最老的**开始丢，最近的那几张必须留着（模型正在看的就是它们）；
 *   3. 消息结构不能坏（丢图 ≠ 删消息，否则会拆散 user/tool 的邻接关系）。
 */

const PREFIX = 'data:image/png;base64,';
const img = (bytes: number): WireMessage => ({
  role: 'user',
  content: [
    { type: 'text', text: 'look' },
    { type: 'image_url', image_url: { url: `${PREFIX}${'A'.repeat(bytes)}`, detail: 'low' } },
  ],
});

describe('inlineImageBytes', () => {
  it('只数 data URL，外链与文本不计', () => {
    const msgs: WireMessage[] = [
      img(1000),
      { role: 'user', content: [{ type: 'text', text: 'x'.repeat(5000) }] },
      { role: 'user', content: [{ type: 'image_url', image_url: { url: 'https://x/y.png' } }] },
    ];
    expect(inlineImageBytes(msgs)).toBe(1000 + PREFIX.length);
  });

  it('file 块（Files API）不占字节 —— 这正是它存在的理由', () => {
    expect(inlineImageBytes([{ role: 'user', content: [{ type: 'file', file_id: 'file-api-abc' }] }])).toBe(0);
  });
});

describe('shedInlineImages', () => {
  it('没超预算时原样返回**同一引用**（不制造无意义的历史副本）', () => {
    const msgs = [img(10), img(10)];
    const out = shedInlineImages(msgs, 1000);
    expect(out.dropped).toBe(0);
    expect(out.messages).toBe(msgs);
  });

  it('超预算时从最老的丢，最近的留着', () => {
    const msgs = [img(400), img(400), img(400)];
    const out = shedInlineImages(msgs, 700);
    expect(out.dropped).toBe(2);
    const kept = out.messages[2]!.content as { type: string }[];
    expect(kept.some((p) => p.type === 'image_url')).toBe(true);
    for (const m of out.messages.slice(0, 2)) {
      const parts = m.content as { type: string; text?: string }[];
      expect(parts.some((p) => p.type === 'image_url')).toBe(false);
      expect(parts.some((p) => p.text === DROPPED_IMAGE_NOTE)).toBe(true);
    }
  });

  it('丢图不删消息：文字还在，角色不变（否则 user/tool 邻接会被拆散）', () => {
    const out = shedInlineImages([img(400)], 10);
    const m = out.messages[0]!;
    expect(m.role).toBe('user');
    const parts = m.content as { type: string; text?: string }[];
    expect(parts[0]).toEqual({ type: 'text', text: 'look' });
  });

  it('不修改入参（调用方还要用原历史做别的判断）', () => {
    const msgs = [img(400)];
    shedInlineImages(msgs, 10);
    expect(inlineImageBytes(msgs)).toBe(400 + PREFIX.length);
  });
});
