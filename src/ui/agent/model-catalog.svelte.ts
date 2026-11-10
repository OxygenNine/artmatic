/**
 * ui/agent/model-catalog.svelte.ts — models.dev 目录的**运行时外壳**。
 *
 * 解析与合并的判据全在 `agent/llm/providers/models-dev.ts`（纯函数、可单测）；
 * 这里只做三件事：取一次、缓存一天、失败静默。
 *
 * 为什么不每次打开设置都重新取：目录是 6 MB。服务端带 `max-age=0` + ETag，
 * 浏览器缓存会把重复请求压成 304，但**解析**那 6 MB 仍然要占主线程一次。
 * 模型上新以天为单位，所以 24h 的本地缓存足够新，也足够便宜。
 *
 * 缓存只存**过滤后的 id 列表**（每家中位数 12 条，几 KB），不存原始 JSON ——
 * `localStorage` 的 5 MB 配额装不下目录，而且装下了也没用。
 */

import type { ProviderDef } from '../../agent/llm/index';
import {
  MODELS_DEV_URL,
  mergeModelPresets,
  parseModelsDev,
} from '../../agent/llm/providers/models-dev';

const CACHE_KEY = 'artmatic.modelsdev';
const CACHE_TTL = 24 * 60 * 60 * 1000;
const REQUEST_TIMEOUT = 20_000;

interface CacheShape {
  at: number;
  providers: Record<string, string[]>;
}

function readCache(): CacheShape | null {
  try {
    const raw = localStorage.getItem(CACHE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as unknown;
    if (typeof parsed !== 'object' || parsed === null) return null;
    const { at, providers } = parsed as Partial<CacheShape>;
    if (typeof at !== 'number' || typeof providers !== 'object' || providers === null) return null;
    const clean: Record<string, string[]> = {};
    for (const [id, list] of Object.entries(providers)) {
      if (!Array.isArray(list)) continue;
      const ids = list.filter((v): v is string => typeof v === 'string' && v.length > 0);
      if (ids.length) clean[id] = ids;
    }
    return Object.keys(clean).length ? { at, providers: clean } : null;
  } catch {
    // 隐私模式 / 配额 / 内容损坏：当成没有缓存，走网络。
    return null;
  }
}

class ModelCatalog {
  /** 目录给的 id，按 provider 分桶。空桶 = 用注册表的静态预设。 */
  live = $state<Record<string, readonly string[]>>({});

  private loadedAt = 0;
  private inflight: Promise<void> | null = null;

  constructor() {
    const cached = readCache();
    if (cached) {
      this.live = cached.providers;
      this.loadedAt = cached.at;
    }
  }

  /** 某一家下拉里该显示的模型串（目录在前的合并结果）。 */
  presetsFor(def: ProviderDef): readonly string[] {
    const live = this.live[def.id];
    return live?.length ? mergeModelPresets(def.models, live) : def.models;
  }

  /**
   * 打开设置面板时调一次。
   *
   * 缓存新鲜就直接返回；否则后台取。**永远不 reject** —— 调用方是 UI，
   * 这个请求失败的正确反应是「继续用旧列表」，不是弹错误（用户对它无能为力）。
   */
  ensureFresh(force = false): Promise<void> {
    if (this.inflight) return this.inflight;
    if (!force && this.loadedAt && Date.now() - this.loadedAt < CACHE_TTL) return Promise.resolve();
    this.inflight = this.refresh().finally(() => {
      this.inflight = null;
    });
    return this.inflight;
  }

  private async refresh(): Promise<void> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT);
    try {
      const res = await fetch(MODELS_DEV_URL, {
        signal: controller.signal,
        headers: { accept: 'application/json' },
      });
      if (!res.ok) return;
      const parsed = parseModelsDev(await res.json());
      if (!parsed.size) return;
      const next: Record<string, readonly string[]> = {};
      for (const [id, list] of parsed) next[id] = list;
      this.live = next;
      this.loadedAt = Date.now();
      this.persist(next);
    } catch {
      // 离线 / 被墙 / 超时 / 半截响应：保持现状。往下拉里塞三年前的模型，
      // 比让面板停在一个「加载失败」上更有用，而且用户改不了网。
    } finally {
      clearTimeout(timer);
    }
  }

  private persist(providers: Record<string, readonly string[]>): void {
    try {
      localStorage.setItem(CACHE_KEY, JSON.stringify({ at: this.loadedAt, providers }));
    } catch {
      // 存不下就每次重取，不影响这一轮显示。
    }
  }
}

export const modelCatalog = new ModelCatalog();
