/**
 * billing.ts — 价格表、峰谷判定、余额查询（纯数据 + 纯函数 + 一个 fetch）。
 *
 * ## 为什么价格表不进注册表
 *
 * 注册表描述「怎么发请求」，价格描述「怎么算钱」：两者更新节奏不同（价格改了
 * 不该动端点），而且价格有**时段**这个维度，放进 `ProviderDef` 会把那一层污染成
 * 一个带业务规则的巨型常量。所以价格单独一张表，按 `providerId` 索引；
 * 表里没有这一家 = 这家没有价目数据，`costOf` 返回 `null`，UI 什么都不显示。
 *
 * ## 峰谷（2026-11 官方口径）
 *
 * 北京时间**周一至周五**（不含中国法定节假日）**9:00–12:00 与 14:00–18:00**
 * 为高峰，其余全部为空闲；空闲价正好是高峰价的一半。
 *
 * 时区必须用 UTC+8 显式平移，不能读本机时区：用户在东京 / 柏林时本机的 9 点
 * 不是 DeepSeek 的 9 点，算出来的价会整整差一倍，而且**没有任何报错**。
 *
 * 节假日表是空的，见 `CN_HOLIDAYS` 的注释。
 */

import { LlmError, type LlmConfig, type LlmUsage, type TurnCost } from './types';
import { apisOf } from './providers/registry';
import { providerFetch } from './transport';

/* ------------------------------------------------------------------ 价格表 */

/** 每百万 token 的价格。 */
export interface TokenPrice {
  /** 输入 · 缓存命中。 */
  hit: number;
  /** 输入 · 缓存未命中。 */
  miss: number;
  /** 输出。 */
  out: number;
}

export interface PriceEntry {
  /** 模型 id 前缀，最长匹配（旧模型名常常与新模型同价）。 */
  prefix: string;
  peak: TokenPrice;
  idle: TokenPrice;
}

export interface PriceBook {
  currency: string;
  models: readonly PriceEntry[];
  /** 按次计费的附加 API（与 token 无关）。 */
  perRequest?: { search?: number; fetch?: number };
}

/**
 * 价目表。数字全部来自官方定价页（2026-11：`deepseek-flash` = V4.1-Flash-1017，
 * `deepseek-v4-pro` = V4-Pro-0813）。**改价时必须整表重抄**，不要只改一个数 ——
 * 峰谷是成对出现的，漏一半的后果是「谷价那半边还是旧钱」。
 */
export const PRICE_BOOKS: Readonly<Record<string, PriceBook>> = {
  deepseek: {
    currency: 'CNY',
    models: [
      // 旧名（deepseek-v4-flash / -vision-exp）已下线，但请求仍由 Flash 承接、按 Flash 计费。
      {
        prefix: 'deepseek-flash',
        idle: { hit: 0.02, miss: 1, out: 4 },
        peak: { hit: 0.04, miss: 2, out: 8 },
      },
      {
        prefix: 'deepseek-v4-flash',
        idle: { hit: 0.02, miss: 1, out: 4 },
        peak: { hit: 0.04, miss: 2, out: 8 },
      },
      {
        prefix: 'deepseek-v4-pro',
        idle: { hit: 0.15, miss: 4.5, out: 13.5 },
        peak: { hit: 0.3, miss: 9, out: 27 },
      },
    ],
    // 5 元 / 1000 次成功请求 → 每次 0.005 元。
    perRequest: { search: 0.005, fetch: 0.005 },
  },
};

/** 这家模型的价格条目（最长前缀匹配）；没有价目数据返回 `null`。 */
export function priceEntryOf(providerId: string, model: string): { entry: PriceEntry; book: PriceBook } | null {
  const book = PRICE_BOOKS[providerId];
  if (!book) return null;
  let best: PriceEntry | null = null;
  for (const entry of book.models) {
    if (!model.startsWith(entry.prefix)) continue;
    if (!best || entry.prefix.length > best.prefix.length) best = entry;
  }
  return best ? { entry: best, book } : null;
}

/* -------------------------------------------------------------- 峰谷判定 */

/** 高峰窗口（北京时间，左闭右开）。 */
export const PEAK_WINDOWS: readonly (readonly [number, number])[] = [
  [9, 12],
  [14, 18],
];

const CN_OFFSET_MS = 8 * 3_600_000;

/**
 * 中国法定节假日（`YYYY-MM-DD`，北京时间）。
 *
 * **空表是有意的**：写错一天就会让那天的估算差一倍，而「猜 2027 年春节放哪几天」
 * 只有国务院公告算依据。缺席时的行为是**按高峰价计**（偏高、不会少算），
 * 用户看到的多半是「贵了一点点」，而不是「账单比面板大一倍」。
 * 每年 12 月按公告补当年的日期即可，别用农历推算。
 */
export const CN_HOLIDAYS: ReadonlySet<string> = new Set<string>();

/** 北京时间下的日历字段（`key` 是 `YYYY-MM-DD`）。 */
export function beijingClock(at: number): { key: string; weekday: number; hour: number } {
  const shifted = new Date(at + CN_OFFSET_MS);
  return {
    key: shifted.toISOString().slice(0, 10),
    weekday: shifted.getUTCDay(),
    hour: shifted.getUTCHours(),
  };
}

/**
 * 此刻是否高峰时段。
 *
 * 周末与节假日整天是谷价。`at` 用毫秒时间戳（不传则以调用时刻算，测试传死值）。
 */
export function isPeak(at: number, holidays: ReadonlySet<string> = CN_HOLIDAYS): boolean {
  const { key, weekday, hour } = beijingClock(at);
  if (weekday === 0 || weekday === 6) return false;
  if (holidays.has(key)) return false;
  return PEAK_WINDOWS.some(([from, to]) => hour >= from && hour < to);
}

/* ---------------------------------------------------------------- 计价 */

export interface UsageTokens {
  /** 缓存命中的输入 token。 */
  hit: number;
  /** 缓存未命中的输入 token。 */
  miss: number;
  /** 输出 token。 */
  out: number;
}

/** 从服务端 usage 拆出三档 token。缺席的字段按 0 算。 */
export function tokensOf(usage: LlmUsage | null | undefined): UsageTokens {
  if (!usage) return { hit: 0, miss: 0, out: 0 };

  /*
   * Anthropic 是**减法口径**：`input_tokens` 不含缓存读写，`prompt_tokens` 根本
   * 不存在。按 prompt 口径去算会得到 miss = 0 的荒谬结果（看着像"全命中"）。
   */
  if (usage.prompt_tokens === undefined && (usage.input_tokens !== undefined || usage.cache_read_input_tokens !== undefined)) {
    return {
      hit: usage.cache_read_input_tokens ?? 0,
      miss: (usage.input_tokens ?? 0) + (usage.cache_creation_input_tokens ?? 0),
      out: usage.completion_tokens ?? usage.output_tokens ?? 0,
    };
  }

  const prompt = usage.prompt_tokens ?? 0;
  const hit = usage.prompt_cache_hit_tokens ?? usage.prompt_tokens_details?.cached_tokens ?? usage.cached_tokens ?? 0;
  return {
    hit,
    // 没有分开上报命中数时，整段输入按未命中计（对用户是保守的，不会少算）。
    miss: Math.max(0, prompt - hit),
    out: usage.completion_tokens ?? usage.output_tokens ?? 0,
  };
}

/**
 * 一轮（或一次请求）的估算费用。没有价目数据返回 `null`。
 *
 * 精度保留到 1e-6 元，显示时再取舍 —— 在 1M 上下文 + 谷价的组合下，
 * 一次请求的费用可能只有几厘钱，提前四舍五入会把它们全抹成 0。
 */
export function costOf(
  providerId: string,
  model: string,
  tokens: UsageTokens,
  at: number,
): TurnCost | null {
  const found = priceEntryOf(providerId, model);
  if (!found) return null;
  const peak = isPeak(at);
  const price = peak ? found.entry.peak : found.entry.idle;
  const input = (tokens.hit * price.hit + tokens.miss * price.miss) / 1_000_000;
  const output = (tokens.out * price.out) / 1_000_000;
  return {
    currency: found.book.currency,
    input: round6(input),
    output: round6(output),
    total: round6(input + output),
    peak,
    hit: tokens.hit,
    miss: tokens.miss,
    out: tokens.out,
  };
}

function round6(n: number): number {
  return Math.round(n * 1_000_000) / 1_000_000;
}

/** 展示用的货币符号。 */
export function currencySymbol(currency: string): string {
  if (currency === 'CNY') return '¥';
  if (currency === 'USD') return '$';
  return `${currency} `;
}

/* ---------------------------------------------------------------- 余额 */

export interface BalanceInfo {
  currency: string;
  /** 总可用（赠金 + 充值）。 */
  total: number;
  granted: number;
  toppedUp: number;
}

export interface BalanceSnapshot {
  available: boolean;
  infos: BalanceInfo[];
}

function money(v: unknown): number {
  // 官方给的是字符串（`"10.00"`），个别实现给数字。
  const n = typeof v === 'number' ? v : Number.parseFloat(String(v ?? ''));
  return Number.isFinite(n) ? n : 0;
}

/**
 * `GET /user/balance` 的响应 → 结构化余额。认不出来返回 `null`。
 *
 * 字段是字符串金额，不是 token —— 别拿它做「还能聊多少轮」的除法，
 * 一千万 token 的谷价才几块钱。
 */
export function parseBalance(json: unknown): BalanceSnapshot | null {
  if (typeof json !== 'object' || json === null) return null;
  const rec = json as Record<string, unknown>;
  const list = Array.isArray(rec.balance_infos) ? rec.balance_infos : [];
  const infos: BalanceInfo[] = [];
  for (const item of list) {
    if (typeof item !== 'object' || item === null) continue;
    const row = item as Record<string, unknown>;
    infos.push({
      currency: typeof row.currency === 'string' ? row.currency : '',
      total: money(row.total_balance),
      granted: money(row.granted_balance),
      toppedUp: money(row.topped_up_balance),
    });
  }
  // 一家都没解析出来 = 这不是余额响应（例如被网关换成了别的东西），别假装 0 元。
  if (!infos.length) return null;
  return { available: rec.is_available !== false, infos };
}

/**
 * 查余额。这家没有余额接口（或端点没配）返回 `null` —— 调用方据此不显示。
 *
 * 走 `providerFetch`：与对话同一条「先直连、失败再同源代理」的路，所以
 * 被 CORS 拦住的主机（DeepSeek 就是）照样能查到。
 */
export async function fetchBalance(
  config: LlmConfig,
  signal?: AbortSignal,
): Promise<BalanceSnapshot | null> {
  const path = apisOf(config.providerId).balance?.path;
  if (!path) return null;
  if (!config.apiKey.trim()) throw new LlmError('no-key', 'missing api key');

  const res = await providerFetch(config, path, { method: 'GET' }, signal);
  let json: unknown;
  try {
    json = await res.json();
  } catch {
    throw new LlmError('bad-response', 'balance endpoint did not return JSON');
  }
  const parsed = parseBalance(json);
  if (!parsed) throw new LlmError('bad-response', 'unexpected balance payload');
  return parsed;
}
