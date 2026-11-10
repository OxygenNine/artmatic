/**
 * providers/models-dev.ts — 模型目录的**外部真源**（models.dev），纯函数层。
 *
 * 注册表里的 `models` 是离线快照，一定会腐烂（见 `docs/provider-matrix.md` §8）。
 * 这里接的是同一件事的在线版本：`GET https://models.dev/api.json`（CORS 全开，
 * 6 MB，服务端 `max-age=0` + ETag ⇒ 浏览器缓存会替我们做条件请求）。
 *
 * 分工：
 *   - 本文件 = 解析 + 合并（**纯函数**，能单测；不 fetch、不碰 localStorage）
 *   - `ui/agent/model-catalog.svelte.ts` = 取一次、缓存、失败静默回落
 *
 * 三条判据：
 *   1. **只收能干活儿的模型** —— 没有 `tool_call` 的进去就是个死选项（Agent 全靠
 *      工具），所以过滤掉而不是排在后面。
 *   2. **按发布日倒序** —— 预设列表的长度有限，留最新的那一撮。
 *   3. **合并而不是替换** —— 静态预设永远垫在后面。models.dev 挂掉、被墙、
 *      某家从目录里消失时，用户的下拉不能变成空的。
 */

import type { ProviderId } from './ids';

export const MODELS_DEV_URL = 'https://models.dev/api.json';

/**
 * 我们的一家 → models.dev 的那一条。
 *
 * 同一家在目录里常有 `-cn` / 国际两条（`alibaba` vs `alibaba-cn`、
 * `moonshotai` 与 `moonshotai-cn`），**要选与注册表 baseUrl 同一个计费区的**，
 * 否则拿到的 id 在自己的端点上不存在。
 *
 * 模型 id 相同的两家可以复用同一条：混元走 TokenHub 的 `tencent-tokenhub`
 * （`api.hunyuan.cloud.tencent.com` 与 `tokenhub.tencentmaas.com` 是同一批 id）。
 */
export const MODELS_DEV_SOURCE: Readonly<Partial<Record<ProviderId, string>>> = {
  deepseek: 'deepseek',
  dashscope: 'alibaba-cn',
  zhipu: 'zhipuai',
  kimi: 'moonshotai-cn',
  doubao: 'volcengine',
  hunyuan: 'tencent-tokenhub',
  stepfun: 'stepfun',
  minimax: 'minimax',
  siliconflow: 'siliconflow-cn',
  openai: 'openai',
  anthropic: 'anthropic',
  gemini: 'google',
  openrouter: 'openrouter',
  xai: 'xai',
} as const;

/**
 * 目录里没有（或不该用）的那些家，各自的原因。**这张表存在的唯一理由是让
 * 「新加一家却忘了映射」变成红测**：mapped ∪ unmapped 必须恰好等于注册表全集，
 * 否则那一家会在下拉里永远显示三年前的模型，而且没有任何报错。
 */
export const MODELS_DEV_UNMAPPED: readonly ProviderId[] = [
  // 千帆与星火不在 models.dev 的收录范围里，只能靠注册表的人工快照。
  'qianfan',
  'spark',
  // 资源级端点：模型框里填的是**部署名**，与目录里的模型 id 没有对应关系。
  'azure',
  // 网关：id 要带 `workers-ai/` 之类的前缀，目录里给的是裸 id，拼不起来。
  'cloudflare',
  // 用户自填端点，目录里不可能有。
  'custom',
];

/** 每家最多从目录里取多少条。够新，又不会把下拉拉成一份列表页。 */
export const LIVE_MODEL_LIMIT = 12;

/** 合并后总长的上限（目录在前、静态预设垫后）。 */
export const MAX_PRESETS = 16;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** 目录里一条模型能不能进预设。 */
function usable(entry: Record<string, unknown>): boolean {
  // 图片 / 视频 / 嵌入 / 转写这些不是对话模型（`type` 缺省 = chat）。
  if (entry.type !== undefined && entry.type !== 'chat') return false;
  // Agent 全靠工具调用，收进来只会让用户以为能选。
  if (entry.tool_call !== true) return false;
  if (entry.status === 'deprecated') return false;
  return true;
}

/**
 * 带 `:` 的是**同一模型的变体**而不是另一代（OpenRouter 的 `:free` / `:nitro`）。
 * 它们进下拉只是噪音：限流版、加价版，换了名字但能力一样。
 */
function variant(id: string): boolean {
  return id.includes(':');
}

/**
 * 全量目录 → `{ 我们的 id: 模型 id 列表 }`（倒序、已截断）。
 *
 * 坏数据一律跳过而不是抛：这个文件是**别人的**，字段随时会加会改；
 * 一次解析崩溃会把整个设置面板带下水，而它只是「多给几个选项」。
 */
export function parseModelsDev(
  payload: unknown,
  source: Readonly<Partial<Record<ProviderId, string>>> = MODELS_DEV_SOURCE,
): Map<ProviderId, string[]> {
  const out = new Map<ProviderId, string[]>();
  if (!isRecord(payload)) return out;

  for (const [providerId, upstreamId] of Object.entries(source) as [ProviderId, string][]) {
    const provider = payload[upstreamId];
    if (!isRecord(provider)) continue;
    const models = provider.models;
    if (!isRecord(models)) continue;

    const picked: { id: string; released: string }[] = [];
    for (const [key, raw] of Object.entries(models)) {
      if (!isRecord(raw)) continue;
      if (!usable(raw)) continue;
      const id = typeof raw.id === 'string' && raw.id ? raw.id : key;
      if (variant(id)) continue;
      const released = typeof raw.release_date === 'string' ? raw.release_date : '';
      picked.push({ id, released });
    }

    if (!picked.length) continue;
    // ISO 日期串按字典序就是时间序；没有日期的排最后（旧条目常缺这个字段）。
    picked.sort((a, b) => (a.released === b.released ? a.id.localeCompare(b.id) : b.released.localeCompare(a.released)));
    out.set(
      providerId,
      picked.slice(0, LIVE_MODEL_LIMIT).map((m) => m.id),
    );
  }
  return out;
}

/**
 * 目录里的模型 + 注册表预设 → 下拉里看到的那一串。
 *
 * 目录在前（新的先出现），静态预设垫后补漏；按出现顺序去重，封顶 `MAX_PRESETS`。
 * `live` 为空（没联网 / 解析空）时原样返回静态预设 —— 这就是离线兜底。
 */
export function mergeModelPresets(
  staticModels: readonly string[],
  live: readonly string[] | undefined,
): string[] {
  const out: string[] = [];
  for (const id of [...(live ?? []), ...staticModels]) {
    if (!id || out.includes(id)) continue;
    out.push(id);
    if (out.length >= MAX_PRESETS) break;
  }
  return out;
}
