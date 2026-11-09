/**
 * providers/endpoint.ts — 端点、鉴权头、头部叠加的**唯一解析点**。
 *
 * 三件事都曾经散在两个适配器里，加一家非标端点就要改两份：
 *
 *   1. **端点**：多数是 `baseUrl + endpointPath`，但 Azure 的部署名在路径里、
 *      还带固定查询串；网关类要按协议加子路径前缀。所以路径支持 `{model}`
 *      占位符与 `ModelRule.pathPrefix / endpointPath` 覆盖。
 *   2. **鉴权**：`Authorization: Bearer` 是常态，不是全部。Azure 是 `api-key`，
 *      Cloudflare 网关是 `cf-aig-authorization`。`AuthSpec` 描述，适配器不再写分支。
 *   3. **头部叠加**：适配器默认 → provider → model；值为 `null` 表示**删掉**同名
 *      默认头（网关类常要求掐掉 SDK 自动加的 `Authorization`）。
 *
 * 全是纯函数：不读时钟、不发请求，可直接单测。
 */

import { modelRule } from './registry';
import type { AuthSpec, ModelRule, ProviderDef, ProtocolId } from './types';

/** 各协议的规范路径。网关按模型切协议时，用它给缺省端点。 */
const CANONICAL_PATH: Record<ProtocolId, string> = {
  openai: '/chat/completions',
  anthropic: '/messages',
};

/** `{model}` 占位符替换。模型名里的 `/` 保留（网关的 `anthropic/claude...` 需要）。 */
export function fillPath(template: string, model: string): string {
  return template.replaceAll('{model}', model);
}

/** 按 `query` 拼查询串。空对象返回空串（**不要**留下一个裸 `?`）。 */
export function queryString(query: Readonly<Record<string, string>> | undefined): string {
  if (!query) return '';
  const pairs = Object.entries(query);
  if (!pairs.length) return '';
  return `?${pairs.map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join('&')}`;
}

/**
 * 有效端点路径（含查询串、不含 baseUrl）。
 *
 * 优先级：`ModelRule.endpointPath` → 提供商默认路径。默认路径的取法分两种：
 * 模型仍走原协议时用 `ProviderDef.endpointPath`；走了**另一个协议**时换成该协议
 * 的规范路径 —— 网关的 `anthropic/claude-*` 不能发到 `/chat/completions`。
 * `pathPrefix` 用于网关的每协议子路径（`/anthropic/v1`）。
 */
export function endpointTail(def: ProviderDef, model: string, rule?: ModelRule | null): string {
  // `undefined` = 自己查规则；`null` = 明确要提供商默认路由（注册表守卫用）。
  const effective = rule === undefined ? modelRule(def, model) : rule;
  const protocol = effective?.protocol ?? def.protocol;
  const base =
    effective?.endpointPath ??
    (protocol === def.protocol ? def.endpointPath : CANONICAL_PATH[protocol]);
  const path = `${effective?.pathPrefix ?? ''}${base}`;
  return `${fillPath(path, model)}${queryString(def.query)}`;
}

/** 绝对端点。`baseUrl` 允许带尾斜杠。 */
export function endpointFor(baseUrl: string, def: ProviderDef, model: string, rule?: ModelRule | null): string {
  return `${baseUrl.trim().replace(/\/+$/, '')}${endpointTail(def, model, rule)}`;
}

/** `AuthSpec` → 头部。`scheme` 缺省：对象形态是原始值（Azure 的 `api-key`）。 */
export function authHeaders(auth: AuthSpec, apiKey: string): Record<string, string> {
  if (auth === 'bearer') return { Authorization: `Bearer ${apiKey}` };
  if (auth === 'anthropic') return { 'x-api-key': apiKey };
  const scheme = auth.scheme ?? 'raw';
  return { [auth.header]: scheme === 'bearer' ? `Bearer ${apiKey}` : apiKey };
}

/**
 * 头部叠加。大小写不敏感；后写覆盖先写；`null` 删除同名键。
 *
 * 保留**最后写入者**的键名大小写 —— `anthropic-version` 这种全小写头被改成
 * 驼峰在个别代理上会被区别对待。
 */
export function mergeHeaders(
  ...layers: readonly (Readonly<Record<string, string | null>> | undefined)[]
): Record<string, string> {
  const out = new Map<string, { name: string; value: string }>();
  for (const layer of layers) {
    if (!layer) continue;
    for (const [name, value] of Object.entries(layer)) {
      const key = name.toLowerCase();
      if (value === null) {
        out.delete(key);
        continue;
      }
      out.set(key, { name, value });
    }
  }
  return Object.fromEntries([...out.values()].map(({ name, value }) => [name, value]));
}
