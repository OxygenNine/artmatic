/**
 * web-tools.ts — 网页搜索与抓取（DeepSeek `/v1/tools/search`、`/v1/tools/fetch`）。
 *
 * ## 为什么要有它
 *
 * 模型的训练数据里没有「这个 WebGL 扩展在这台机器上的行为」「这个 uniform 名
 * 在最新版里改成什么了」这类问题，而它**不会说自己不知道** —— 它会写出一段
 * 看起来对、编译也过、效果不对的 GLSL。给它一个能查文档的口子，比在提示词里
 * 反复叮嘱「不要编」有用得多。
 *
 * ## 三个刻意的取舍
 *
 * 1. **只取 `summary`，不取正文**。Search 的 `need_content: true` 会把整页正文
 *    塞进结果（一页几万字 = 几万 token），一次搜索就能把上下文吃掉一成。
 *    要读正文就用 `web_fetch` 精确挑一页 —— 它是有意识的一步，不是副产品。
 * 2. **结果按 `rerank_score` 截断后原样给模型看**（标题 / 链接 / 摘要 / 日期 /
 *    站点），不做「智能挑选」。选择权留给模型，它读了摘要才知道该抓哪一页。
 * 3. 计费按**成功请求**：搜索无结果不计费，所以空结果不是错误（返回空数组）。
 */

import { LlmError, type LlmConfig } from './types';
import { apisOf, providerOf } from './providers/registry';
import { authHeaders } from './providers/endpoint';
import { providerFetch } from './transport';

/** 默认返回条数（官方默认 10，1–50）。 */
export const SEARCH_DEFAULT_COUNT = 8;
/** 单页正文回给模型的字符上限（约 5k token）。 */
export const FETCH_TEXT_LIMIT = 20_000;

export interface SearchArgs {
  query: string;
  count?: number;
  /** 用户原话：帮助搜索引擎理解意图（官方建议）。 */
  oriQuestion?: string;
}

export interface SearchHit {
  title: string;
  url: string;
  snippet: string;
  /** 长摘要（600–800 字），给模型读的就是它。 */
  summary: string;
  site: string | null;
  date: string | null;
  /** 0–4，≥3 为极权威；-1 表示未知。 */
  authority: number | null;
  rerank: number | null;
}

/** 请求体（纯函数）。`count` 夹在 1–50，未知字段官方会忽略，但我们不靠这个兜底。 */
export function searchBody(args: SearchArgs): Record<string, unknown> {
  const body: Record<string, unknown> = { query: args.query.trim() };
  if (args.count !== undefined) body.count = Math.max(1, Math.min(50, Math.round(args.count)));
  if (args.oriQuestion?.trim()) body.ori_question = args.oriQuestion.trim().slice(0, 128);
  // 固定 false：正文走 web_fetch，见文件头的取舍 1。
  body.need_content = false;
  return body;
}

function str(v: unknown): string {
  return typeof v === 'string' ? v : '';
}

function num(v: unknown): number | null {
  const n = typeof v === 'number' ? v : Number.NaN;
  return Number.isFinite(n) ? n : null;
}

/**
 * 解析 `results[]`。
 *
 * 官方明确「搜索正常结束但没有匹配结果时返回空数组」—— 空数组不是错误。
 * 认不出的条目**跳过**而不是整份失败：一条脏数据不该让整次搜索白花钱。
 */
export function parseSearchResults(json: unknown): SearchHit[] {
  if (typeof json !== 'object' || json === null) return [];
  const list = (json as Record<string, unknown>).results;
  if (!Array.isArray(list)) return [];
  const out: SearchHit[] = [];
  for (const item of list) {
    if (typeof item !== 'object' || item === null) continue;
    const rec = item as Record<string, unknown>;
    const url = str(rec.url);
    if (!url) continue;
    out.push({
      title: str(rec.title) || url,
      url,
      snippet: str(rec.snippet),
      summary: str(rec.summary) || str(rec.snippet),
      site: str(rec.site_name) || null,
      date: str(rec.date) || null,
      authority: num(rec.authority),
      rerank: num(rec.rerank_score),
    });
  }
  return out;
}

/** 搜索。没有这家 API 时抛 `unsupported`。 */
export async function searchWeb(
  config: LlmConfig,
  args: SearchArgs,
  signal?: AbortSignal,
): Promise<SearchHit[]> {
  const path = apisOf(config.providerId).search?.path;
  if (!path) throw new LlmError('unsupported', `${config.providerId} has no search api`);
  if (!args.query.trim()) throw new LlmError('unsupported', 'query is empty');

  const def = providerOf(config.providerId);
  const res = await providerFetch(config, path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...authHeaders(def.auth, config.apiKey) },
    body: JSON.stringify(searchBody(args)),
  }, signal);

  let json: unknown;
  try {
    json = await res.json();
  } catch {
    throw new LlmError('bad-response', 'search did not return JSON');
  }
  return parseSearchResults(json);
}

/** 抓一页正文（Markdown）。 */
export async function fetchPage(
  config: LlmConfig,
  url: string,
  signal?: AbortSignal,
): Promise<{ title: string; content: string }> {
  const path = apisOf(config.providerId).fetch?.path;
  if (!path) throw new LlmError('unsupported', `${config.providerId} has no fetch api`);
  const target = url.trim();
  // 官方要求含 host 的 http(s)、不带用户名密码；本地先挡一道，省一次 403。
  if (!/^https?:\/\/[^\s/]+/i.test(target) || target.length > 8192) {
    throw new LlmError('unsupported', 'url must be an absolute http(s) url under 8192 chars');
  }

  const def = providerOf(config.providerId);
  const res = await providerFetch(config, path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...authHeaders(def.auth, config.apiKey) },
    body: JSON.stringify({ url: target }),
  }, signal);

  let json: unknown;
  try {
    json = await res.json();
  } catch {
    throw new LlmError('bad-response', 'fetch did not return JSON');
  }
  const rec = (typeof json === 'object' && json !== null ? json : {}) as Record<string, unknown>;
  const content = str(rec.content);
  if (!content) {
    // 404 的另一面：抓到了但提不出正文。当成失败，让模型换一页，别让它以为这页是空的。
    throw new LlmError('bad-response', 'page had no extractable text');
  }
  return { title: str(rec.title), content };
}
