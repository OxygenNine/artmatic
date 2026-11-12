/**
 * providers/errors.ts — HTTP 错误归一。
 *
 * 为什么不能只按状态码：**402 不是唯一的「余额不足」**。DeepSeek 用 402，OpenAI 用
 * `429 + insufficient_quota`，腾讯/百度用 `Arrearage` 之类的词。按状态码硬映射的
 * 结果是「用户反复重试，以为是限流」，而真正的原因永远不暴露。
 *
 * 反过来，**上下文超限也不能当成普通 400**：`session.ts` 对普通 400 的处理是
 * 「清空模型历史」（那是为了逃离被污染的历史）。上下文超限清掉历史等于把用户
 * 的会话直接删了 —— 这种情况应该触发压缩，不是重置。
 */

import { LlmError, type LlmErrorCode } from '../types';

export interface ErrorEnvelope {
  /** 机器可读的码（`insufficient_quota` / `context_length_exceeded` …），可能是空串。 */
  code: string;
  /** 给人看的那句话。 */
  message: string;
}

const EMPTY: ErrorEnvelope = { code: '', message: '' };

function str(v: unknown): string {
  return typeof v === 'string' ? v : '';
}

/** 有的服务商把错误码写成数字（`error_code: 17`），有的写成字符串。 */
function id(v: unknown): string {
  return typeof v === 'string' ? v : typeof v === 'number' ? String(v) : '';
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/**
 * 兼容四种错误体：
 *   `{error:{message,code,type}}`（OpenAI / DeepSeek / Anthropic）
 *   `{code,msg}` / `{message,code}`（扁平）
 *   `{error_code,error_msg}`（百度千帆老接口）
 *   `{base_resp:{status_code,status_msg}}`（MiniMax 老接口）
 * 认不出来就返回空壳，由调用方拿原始文本兜底。
 */
export function parseErrorEnvelope(bodyText: string): ErrorEnvelope {
  const text = bodyText.trim();
  if (!text) return EMPTY;

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { code: '', message: text.slice(0, 400) };
  }
  if (!isRecord(parsed)) return { code: '', message: text.slice(0, 400) };

  const err = parsed.error;
  if (isRecord(err)) {
    return {
      code: id(err.code) || str(err.type),
      message: str(err.message) || str(err.msg) || text.slice(0, 400),
    };
  }
  if (typeof err === 'string') return { code: '', message: err };

  const legacyCode = id(parsed.error_code);
  if (legacyCode) {
    return { code: legacyCode, message: str(parsed.error_msg) || text.slice(0, 400) };
  }

  const base = parsed.base_resp;
  if (isRecord(base)) {
    return {
      code: String(base.status_code ?? ''),
      message: str(base.status_msg) || text.slice(0, 400),
    };
  }

  const flatCode = id(parsed.code) || str(parsed.type);
  const flatMsg = str(parsed.message) || str(parsed.msg);
  if (flatCode || flatMsg) {
    return { code: flatCode, message: flatMsg || text.slice(0, 400) };
  }
  return { code: '', message: text.slice(0, 400) };
}

/** 「上下文太长」的各种说法。命中就要**压缩**，不能清空历史。 */
const CONTEXT_MARKERS = [
  'context_length_exceeded',
  'context length',
  'maximum context',
  'context window',
  'too many tokens',
  'prompt is too long',
  'input is too long',
  'range of input',
  'exceeds the maximum',
  /*
   * 「请求体太大」也归这一类（DeepSeek 的 48 MiB / 单图 32 MiB）：
   * 它不是上下文 token 超了，但**处理方式相同** —— 压缩历史（连带丢掉旧图）
   * 是唯一能自己动手的解法。归成普通 400 的后果是清空整个会话，而用户的
   * 请求其实完全合法，只是背着的截图太多（见 `llm/body-budget.ts`）。
   */
  'request entity too large',
  'request body is too large',
  'body too large',
  'payload too large',
  'input is too large',
];

/** 「没钱了」的各种说法。命中就报 `balance`，别让用户去重试。 */
const BALANCE_MARKERS = [
  'insufficient_quota',
  'insufficient_balance',
  'insufficient balance',
  'exceeded your current quota',
  'quota exceeded',
  'arrearage',
  '账户余额',
  '余额不足',
];

function hits(haystack: string, markers: readonly string[]): boolean {
  const s = haystack.toLowerCase();
  return markers.some((m) => s.includes(m));
}

/**
 * 状态码 + 错误体 → `LlmError`。
 *
 * 判定顺序很重要：**先看错误体再看状态码**。429 既可能是真的限流，也可能是
 * 配额用完；只看状态码会把后者永远归成前者。
 */
export function classifyHttpError(status: number, bodyText: string): LlmError {
  const env = parseErrorEnvelope(bodyText);
  const hay = `${env.code} ${env.message}`;
  const detail = bodyText.trim().slice(0, 800) || `${status}`;
  const message = `HTTP ${status}`;

  const code: LlmErrorCode = (() => {
    if (hits(hay, BALANCE_MARKERS)) return 'balance';
    if (status === 402) return 'balance';
    if (hits(hay, CONTEXT_MARKERS)) return 'context';
    // 413 几乎总是请求体超限（nginx 一类前置会先挡掉，错误体可能不是 JSON）。
    if (status === 413) return 'context';
    if (status === 401 || status === 403) return 'auth';
    if (status === 429) return 'rate-limit';
    if (status === 408 || status === 504) return 'timeout';
    if (status >= 500) return 'server';
    return 'bad-response';
  })();

  return new LlmError(code, message, status, detail);
}

/** 流内 `error` 事件（Anthropic 用 `error.type`，OpenAI 兼容用字符串码）。 */
export function classifyStreamError(type: string, message: string): LlmError {
  const t = type.toLowerCase();
  if (t.includes('overloaded') || t.includes('api_error')) return new LlmError('server', message);
  if (t.includes('rate_limit')) return new LlmError('rate-limit', message);
  if (t.includes('authentication') || t.includes('permission')) return new LlmError('auth', message);
  if (t.includes('invalid_request')) return new LlmError('bad-response', message);
  return new LlmError('server', message);
}
