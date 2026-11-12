import { describe, expect, it } from 'vitest';
import { fetchPage, parseSearchResults, searchBody, searchWeb } from '../../src/agent/llm/web-tools';
import { DEFAULT_LLM_CONFIG, LlmError, type LlmConfig } from '../../src/agent/llm/types';

/**
 * 联网检索的纯逻辑守卫。
 *
 * 这里刻意**不测网络**：真发请求的测试会在 CI 上变成「偶尔红」，而它要证明的
 * 那件事（请求形状 / 解析规则）全在纯函数里。发请求那一层只测「没有这家 API
 * 时立刻报错」—— 那条判据决定模型会不会白调一次工具。
 */

const cfg = (providerId: string, key = 'test-key'): LlmConfig => ({
  ...DEFAULT_LLM_CONFIG,
  providerId,
  apiKey: key,
});

describe('searchBody', () => {
  it('count 夹在 1–50，query 去空白', () => {
    expect(searchBody({ query: '  webgl2 extensions  ' })).toEqual({ query: 'webgl2 extensions', need_content: false });
    expect(searchBody({ query: 'x', count: 0 }).count).toBe(1);
    expect(searchBody({ query: 'x', count: 999 }).count).toBe(50);
    expect(searchBody({ query: 'x', count: 7.6 }).count).toBe(8);
  });

  it('不请求正文（正文走 web_fetch，一次搜索不该吃掉一成上下文）', () => {
    expect(searchBody({ query: 'x', oriQuestion: '这是什么' }).need_content).toBe(false);
  });

  it('ori_question 截到 128 字符；空串不发这个键', () => {
    expect(searchBody({ query: 'x', oriQuestion: 'a'.repeat(300) }).ori_question).toHaveLength(128);
    expect('ori_question' in searchBody({ query: 'x', oriQuestion: '   ' })).toBe(false);
  });
});

describe('parseSearchResults', () => {
  it('按官方字段映射，summary 缺席时用 snippet 顶上', () => {
    const hits = parseSearchResults({
      results: [
        {
          rerank_score: 2.4,
          title: 'MDN',
          url: 'https://developer.mozilla.org/x',
          snippet: 'short',
          summary: 'long summary',
          site_name: 'MDN',
          date: '2026-06-01T00:00:00+00:00',
          authority: 3,
        },
        { title: 'no summary', url: 'https://a.b', snippet: 'snippet only' },
      ],
    });
    expect(hits[0]).toMatchObject({ title: 'MDN', summary: 'long summary', site: 'MDN', authority: 3 });
    expect(hits[1]).toMatchObject({ url: 'https://a.b', summary: 'snippet only', site: null, authority: null });
  });

  it('没有 url 的条目跳过（一条脏数据不该让整次搜索白花钱）', () => {
    expect(parseSearchResults({ results: [{ title: 'x', url: '' }, { title: 'y', url: 'https://y.z' }] })).toHaveLength(1);
  });

  it('空结果 / 意外形状都是空数组而不是抛 —— 官方明确「无匹配返回空数组」', () => {
    expect(parseSearchResults({ results: [] })).toEqual([]);
    expect(parseSearchResults({})).toEqual([]);
    expect(parseSearchResults(null)).toEqual([]);
  });
});

describe('能力判据（没有这家 API 时立刻报错，不发请求）', () => {
  it('没有 search 的提供商：unsupported，而不是 400 或空结果', async () => {
    await expect(searchWeb(cfg('openai'), { query: 'x' })).rejects.toMatchObject({ code: 'unsupported' });
    await expect(searchWeb(cfg('custom'), { query: 'x' })).rejects.toBeInstanceOf(LlmError);
  });

  it('没有 fetch 的提供商同样 unsupported', async () => {
    await expect(fetchPage(cfg('openai'), 'https://example.com')).rejects.toMatchObject({ code: 'unsupported' });
  });

  it('有 fetch 但 url 不合法：本地先挡（省一次 403）', async () => {
    await expect(fetchPage(cfg('deepseek'), 'file:///etc/passwd')).rejects.toMatchObject({ code: 'unsupported' });
    await expect(fetchPage(cfg('deepseek'), 'not a url')).rejects.toMatchObject({ code: 'unsupported' });
    await expect(fetchPage(cfg('deepseek'), `https://x.dev/${'a'.repeat(9000)}`)).rejects.toMatchObject({
      code: 'unsupported',
    });
  });

  it('query 全空白不发请求', async () => {
    await expect(searchWeb(cfg('deepseek'), { query: '   ' })).rejects.toMatchObject({ code: 'unsupported' });
  });
});
