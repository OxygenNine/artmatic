import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Plugin } from 'vite';

export interface LlmProxyOptions {
  /** providerId → 上游 origin。由 `PROXY_ROUTES` 提供，测试可传自造表。 */
  routes?: Record<string, string>;
  prefix?: string;
}

/**
 * 中间件本体（connect 形状）。`server/serve.mjs`（npm 版）直接用它，
 * Vite 侧由下面的 `llmProxy` 包成插件。
 */
export function createLlmProxyHandler(
  options?: LlmProxyOptions,
): (req: IncomingMessage, res: ServerResponse, next: () => void) => void;

/** `scripts/llm-proxy.mjs` 的类型声明（给 vite.config.ts 用）。 */
export function llmProxy(options: LlmProxyOptions): Plugin;

/** `/__llm/<providerId>/<tail>` 的解析（纯函数，单测直接喂字符串）。 */
export function parseProxyPath(
  url: string,
  prefix?: string,
): { providerId: string; tail: string } | null;

/** 只透传白名单请求头。 */
export function pickForwardHeaders(headers: Record<string, unknown>): Record<string, string>;

/** 上游 URL = `baseUrl` + `tail`（纯拼接：保留 baseUrl 自带的路径）。 */
export function proxyTargetUrl(base: string, tail: string): URL;
