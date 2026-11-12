/**
 * agent-prefs.ts — Agent 配置的**纯模型层**（localStorage 里那一份）。
 *
 * 从 `agent-state.svelte.ts` 里拆出来的原因只有一个：那个文件带 `$state`，
 * vitest 读不了；而「旧配置怎么迁」「baseUrl 反查哪一家」恰恰是最该被单测钉住的
 * 逻辑 —— 迁错的形态是 401，用户第一反应是「key 过期了」。
 *
 * ## 为什么是 per-provider 的覆盖表
 *
 * 用户会在 2~3 家之间来回切（一家便宜、一家能看图、一家额度大）。只存一份
 * `key` 的话，每切一次都要重填 —— 而重填的那次通常记不住是哪个 key。
 * 所以 key / 模型 / 端点都按 provider 各存一份，只覆盖**与注册表不同**的部分。
 */

import { DEFAULT_PROVIDER_ID, PROVIDER_BY_ID, PROVIDERS } from '../../agent/llm/providers/registry';
import type { ProviderDef } from '../../agent/llm/providers/types';
import { DEFAULT_LLM_CONFIG, type LlmConfig, type ReasoningEffort } from '../../agent/llm/types';

/** localStorage 结构版本：4 = per-provider 覆盖表（3 及以前是扁平的单家配置）。 */
export const PREFS_REV = 4;

export interface ProviderOverride {
  /** 只在用户改过端点时才存（缺省 = 跟随注册表）。 */
  baseUrl?: string;
  model?: string;
  apiKey?: string;
}

export interface AgentPrefs {
  providerId: string;
  overrides: Partial<Record<string, ProviderOverride>>;
  temperature: number;
  effort: ReasoningEffort;
  maxSteps: number;
  /** 每轮允许把截图回传给模型（关掉可以省 token / 不外传画面）。 */
  screenshots: boolean;
  /**
   * 操作媒体池前要用户确认（**默认开**）。
   *
   * 这些动作会移动 / 删除磁盘上的素材文件（移进回收站、彻底删除、收集进工程
   * 目录），而模型无法从画面判断哪一份是原件 —— 默认把决定权留给用户。
   */
  mediaPoolConfirm: boolean;
  /**
   * 允许模型派生**子代理**（**默认开**）。
   *
   * 关掉 = `spawn_agent` 从工具表里消失，模型看不见也就不会尝试。子代理会额外
   * 烧 token（独立上下文窗口），这是给成本敏感的用户留的闸。
   */
  subagents: boolean;
  /** key 只在内存里（不落 localStorage）。 */
  sessionOnly: boolean;
}

export function defaultPrefs(): AgentPrefs {
  return {
    providerId: DEFAULT_PROVIDER_ID,
    overrides: {},
    temperature: DEFAULT_LLM_CONFIG.temperature,
    effort: DEFAULT_LLM_CONFIG.effort,
    maxSteps: 200,
    screenshots: true,
    mediaPoolConfirm: true,
    subagents: true,
    sessionOnly: false,
  };
}

/* --------------------------------------------------------------- 小工具 */

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

const trimSlash = (s: string): string => s.trim().replace(/\/+$/, '');
const norm = (s: string): string => trimSlash(s).toLowerCase();

function text(v: unknown): string {
  return typeof v === 'string' ? v.trim() : '';
}

/* --------------------------------------------------------- provider 反查 */

/**
 * 旧的单家配置里只有一个 `baseUrl`。用它反查是哪一家。
 *
 * **匹配不上就返回 `custom`，绝不丢 key、也绝不静默落到 DeepSeek** ——
 * 落到默认值会让用户的 key 发给一家他没选的服务，比 401 更糟。
 */
export function inferProviderId(baseUrl: string): string {
  const target = norm(baseUrl);
  if (!target) return DEFAULT_PROVIDER_ID;

  let best = 'custom';
  let bestLen = 0;
  for (const def of PROVIDERS) {
    if (!def.baseUrl || def.id === 'custom') continue;
    const stock = norm(def.baseUrl);
    // 前缀匹配两个方向：旧配置可能多带 `/v1`，注册表也可能更新过路径。
    if (target === stock || target.startsWith(stock) || stock.startsWith(target)) {
      if (stock.length > bestLen) {
        best = def.id;
        bestLen = stock.length;
      }
    }
  }
  return best;
}

export function providerOfPrefs(prefs: AgentPrefs): ProviderDef {
  return PROVIDER_BY_ID.get(prefs.providerId) ?? PROVIDER_BY_ID.get('custom')!;
}

/** 当前 provider + 覆盖表 → 有效模型名。 */
export function activeModel(prefs: AgentPrefs): string {
  const def = providerOfPrefs(prefs);
  return text(prefs.overrides[def.id]?.model) || def.models[0] || '';
}

/** 当前 provider + 覆盖表 → 有效端点（`custom` 未填时是空串）。 */
export function activeBaseUrl(prefs: AgentPrefs): string {
  const def = providerOfPrefs(prefs);
  return trimSlash(text(prefs.overrides[def.id]?.baseUrl)) || def.baseUrl;
}

export function activeApiKey(prefs: AgentPrefs): string {
  return text(prefs.overrides[prefs.providerId]?.apiKey);
}

/* --------------------------------------------------------------- 迁移 */

function effortOf(raw: Record<string, unknown>): ReasoningEffort {
  const value = raw.effort;
  if (value === 'off' || value === 'low' || value === 'high' || value === 'max') return value;
  // 旧版的 `medium` 与更早的 `thinking:true` 统一迁到原生 high。
  if (value === 'medium' || raw.thinking === true) return 'high';
  return DEFAULT_LLM_CONFIG.effort;
}

function sanitizeOverrides(raw: unknown): Partial<Record<string, ProviderOverride>> {
  if (!isRecord(raw)) return {};
  const out: Partial<Record<string, ProviderOverride>> = {};
  for (const [id, value] of Object.entries(raw)) {
    if (id !== 'custom' && !PROVIDER_BY_ID.has(id)) continue;
    if (!isRecord(value)) continue;
    const entry: ProviderOverride = {};
    const baseUrl = text(value.baseUrl);
    const model = text(value.model);
    const apiKey = typeof value.apiKey === 'string' ? value.apiKey : '';
    if (baseUrl) entry.baseUrl = baseUrl;
    if (model) entry.model = model;
    if (apiKey) entry.apiKey = apiKey;
    if (Object.keys(entry).length) out[id] = entry;
  }
  return out;
}

/**
 * localStorage → `AgentPrefs`。坏数据一律回落到默认值，**不抛**：
 * 配置读不出来不该让整个面板打不开。
 */
export function migratePrefs(raw: unknown): AgentPrefs {
  const out = defaultPrefs();
  if (!isRecord(raw)) return out;

  const rev = Number(raw.prefsRev ?? 1);
  const fresh = rev < PREFS_REV;

  out.effort = effortOf(raw);
  out.temperature = Number.isFinite(Number(raw.temperature))
    ? Math.max(0, Math.min(2, Number(raw.temperature)))
    : out.temperature;
  // 旧默认（16 步）在真实任务里明显不够；只在新结构缺席时抬一次。
  out.maxSteps = Number.isFinite(Number(raw.maxSteps))
    ? Math.max(1, Math.min(2000, Math.round(fresh ? Math.max(200, Number(raw.maxSteps)) : Number(raw.maxSteps))))
    : out.maxSteps;
  out.screenshots = typeof raw.screenshots === 'boolean' ? raw.screenshots : out.screenshots;
  // 新加的安全开关缺省必须**偏安全**：老配置里没有这个键，读成 false 等于默认放行。
  out.mediaPoolConfirm =
    typeof raw.mediaPoolConfirm === 'boolean' ? raw.mediaPoolConfirm : out.mediaPoolConfirm;
  // 子代理默认**开**：老配置里没有这个键，读成 false 等于把功能藏起来。
  // 与上面 `mediaPoolConfirm` 的方向相反 —— 那个是安全闸（缺省偏保守），
  // 这个是功能开关（缺省偏可用）。
  out.subagents = typeof raw.subagents === 'boolean' ? raw.subagents : out.subagents;
  out.sessionOnly = typeof raw.sessionOnly === 'boolean' ? raw.sessionOnly : out.sessionOnly;

  // 已经是新结构
  if (rev >= PREFS_REV && typeof raw.providerId === 'string') {
    out.providerId = PROVIDER_BY_ID.has(raw.providerId) ? raw.providerId : 'custom';
    out.overrides = sanitizeOverrides(raw.overrides);
    return out;
  }

  // rev ≤ 3：扁平的单家配置
  const oldBaseUrl = text(raw.baseUrl) || DEFAULT_LLM_CONFIG.baseUrl;
  const providerId = inferProviderId(oldBaseUrl);
  const def = PROVIDER_BY_ID.get(providerId);

  out.providerId = providerId;
  const entry: ProviderOverride = {};
  const model = text(raw.model) || def?.models[0] || DEFAULT_LLM_CONFIG.model;
  if (model) entry.model = model;
  // 只有在用户改过端点时才留 baseUrl，否则跟随注册表（否则以后改默认端点不生效）。
  if (!def || norm(oldBaseUrl) !== norm(def.baseUrl)) entry.baseUrl = oldBaseUrl;
  if (typeof raw.apiKey === 'string' && raw.apiKey) entry.apiKey = raw.apiKey;
  out.overrides = { [providerId]: entry };
  return out;
}

/* --------------------------------------------------------------- 求值 */

/** `AgentPrefs` → 会话层要的 `LlmConfig`（**唯一**一处映射）。 */
export function resolveLlmConfig(
  prefs: AgentPrefs,
  proxyPath: string | null = DEFAULT_LLM_CONFIG.proxyPath,
): LlmConfig {
  const def = providerOfPrefs(prefs);
  return {
    providerId: def.id,
    baseUrl: activeBaseUrl(prefs),
    apiKey: activeApiKey(prefs),
    model: activeModel(prefs),
    temperature: prefs.temperature,
    effort: prefs.effort,
    proxyPath,
  };
}

/** 落盘用：`sessionOnly` 时把所有 key 剥掉（内存里仍保留）。 */
export function prefsForStorage(prefs: AgentPrefs): AgentPrefs {
  if (!prefs.sessionOnly) return prefs;
  const overrides: Partial<Record<string, ProviderOverride>> = {};
  for (const [id, value] of Object.entries(prefs.overrides)) {
    const { apiKey: _drop, ...rest } = value ?? {};
    if (Object.keys(rest).length) overrides[id] = rest;
  }
  return { ...prefs, overrides };
}
