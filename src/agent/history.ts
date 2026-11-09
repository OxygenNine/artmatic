/**
 * history.ts — Agent 对话历史的**数据模型**（纯数据 + 纯函数，不碰文件系统）。
 *
 * ## 为什么不在 `project.json` 里
 *
 * 历史曾经是 `Project.agentSessions` 的一部分，代价有三个：
 *
 * 1. **每一轮对话都重写整份工程**。`project.json` 是工程真相，保存时整份序列化 +
 *    原子写；聊天记录挂在上面意味着「聊一句 = 写一遍整份工程」，自动保存的静默
 *    开销全落在聊天上。
 * 2. **历史越长，保存越慢**：30 个会话 × 400 条 × 20k 字的上限本身就允许几十 MB，
 *    而它们与片段 / 曲线 / 排版文档**共用**同一条写入路径与同一份撤销快照。
 * 3. **撤销栈要专门绕开它**（快照剔除 + 恢复时保留），这条特例本身就是设计味道。
 *
 * 现在历史住在工程目录的 `agent/sessions/<id>.json`（见 `project/agent-history.ts`）：
 * **一个会话一个文件**。所以一轮对话只重写自己那一个文件；删一个会话是 unlink；
 * 一个文件坏掉只丢那一个会话。工程只记「工程」。
 *
 * ## 上限
 *
 * 仍然是 30 会话 / 400 条 / 20k 字（单条）—— 换个存储位置不改变「不能让聊天记录
 * 无限长大」这条。图片只留说明，不存 base64。
 */

export type AgentStoredRole = 'user' | 'assistant' | 'tool' | 'error' | 'reasoning' | 'image';

export interface AgentStoredMessage {
  role: AgentStoredRole;
  /** 纯文本（工具卡存的是结果摘要）。 */
  text: string;
  toolName?: string;
  toolStatus?: 'running' | 'ok' | 'error';
  code?: string;
  ms?: number;
  /** `role:'image'` 的说明（**不存 base64**：那是工程体积的灾难）。 */
  caption?: string;
}

export interface AgentSessionRecord {
  id: string;
  /** 第一条用户消息的前若干字，列表里当标题。 */
  title: string;
  /** 毫秒时间戳（界面显示用；不参与渲染）。 */
  createdAt: number;
  updatedAt: number;
  messages: AgentStoredMessage[];
}

/** 落盘文件的格式版本（与 `Project.schemaVersion` 无关，独立演进）。 */
export const HISTORY_FORMAT_VERSION = 1;

export const MAX_SESSIONS = 30;
export const MAX_MESSAGES = 400;
export const MAX_TEXT = 20_000;
export const MAX_CAPTION = 500;
const MAX_TITLE = 120;

const ROLES = new Set<AgentStoredRole>(['user', 'assistant', 'tool', 'error', 'reasoning', 'image']);

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/**
 * 单条会话的清洗。**永不抛**：文件坏了只丢这一个会话，别的照常。
 *
 * 返回 null = 整条不可用（没有 id 或 messages 不是数组）。
 */
export function sanitizeAgentSession(raw: unknown): AgentSessionRecord | null {
  if (!isRecord(raw)) return null;
  const id = typeof raw.id === 'string' ? raw.id.trim() : '';
  if (!id || !Array.isArray(raw.messages)) return null;

  const messages: AgentStoredMessage[] = [];
  for (const m of raw.messages) {
    if (!isRecord(m)) continue;
    if (typeof m.text !== 'string' || !ROLES.has(m.role as AgentStoredRole)) continue;
    messages.push({
      role: m.role as AgentStoredRole,
      text: m.text.slice(0, MAX_TEXT),
      ...(typeof m.toolName === 'string' ? { toolName: m.toolName } : {}),
      ...(m.toolStatus === 'ok' || m.toolStatus === 'error' || m.toolStatus === 'running'
        ? { toolStatus: m.toolStatus }
        : {}),
      ...(typeof m.code === 'string' ? { code: m.code } : {}),
      ...(Number.isFinite(Number(m.ms)) ? { ms: Number(m.ms) } : {}),
      ...(typeof m.caption === 'string' ? { caption: m.caption.slice(0, MAX_CAPTION) } : {}),
    });
    if (messages.length >= MAX_MESSAGES) break;
  }
  if (!messages.length) return null;

  const created = Number(raw.createdAt);
  const updated = Number(raw.updatedAt);
  return {
    id,
    title: (typeof raw.title === 'string' && raw.title.trim() ? raw.title : '').slice(0, MAX_TITLE),
    createdAt: Number.isFinite(created) ? created : 0,
    updatedAt: Number.isFinite(updated) ? updated : 0,
    messages,
  };
}

/**
 * 多会话清洗：逐条丢弃坏数据、按 `updatedAt` 倒序、同 id 只留一条、截断到 30 条。
 *
 * 目录里读出来是一堆文件，顺序由文件系统给 ⇒ 必须在这里定序，
 * 否则「同一工程两次打开」的历史面板顺序会不一样。
 */
export function sanitizeAgentSessions(raw: unknown): AgentSessionRecord[] {
  if (!Array.isArray(raw)) return [];
  const out: AgentSessionRecord[] = [];
  for (const item of raw) {
    const s = sanitizeAgentSession(item);
    if (s) out.push(s);
  }
  const seen = new Set<string>();
  return out
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .filter((s) => (seen.has(s.id) ? false : (seen.add(s.id), true)))
    .slice(0, MAX_SESSIONS);
}

/** 恢复会话用的线格式消息（只认 `role` 与文本）。 */
export interface ResumedMessage {
  role: 'user' | 'assistant';
  content: string;
}

/**
 * 把一条会话记录接成**可续聊**的线格式消息。
 *
 * 只接 `user` / `assistant` 的文本，其余（tool / reasoning / error / image）
 * 一律丢掉。历史里没有 `tool_calls` / `tool_call_id` —— 那是「逐字节回放」
 * 才需要的东西，存进磁盘既臃肿、又会和换过之后的模型不兼容；凭工具名硬造
 * 一对出来则等于伪造一次没发生过的调用，服务端会因为孤立的 `tool_call_id` 直接 400。
 *
 * 代价是「模型记得结论、不记得参数」，所以 `session` 会在末尾补一句
 * resume note（`prompt.ts::RESUME_NOTE`）让它重新读工程，而不是照着记忆改。
 *
 * 相邻同角色合并：丢掉工具卡之后 `assistant / assistant / assistant` 是常态
 * （每次工具往返都是「说一句 → 调工具 → 再说一句」），拼成一条更像真实对话。
 */
export function resumedMessages(record: AgentSessionRecord): ResumedMessage[] {
  const out: ResumedMessage[] = [];
  for (const m of record.messages) {
    if (m.role !== 'user' && m.role !== 'assistant') continue;
    const text = m.text.trim();
    if (!text) continue;
    const last = out[out.length - 1];
    if (last && last.role === m.role) last.content += `\n\n${text}`;
    else out.push({ role: m.role, content: text });
  }
  return out;
}

/**
 * 插入 / 覆盖一条会话，返回新列表与**被挤出去的 id**。
 *
 * 被挤出去的文件必须由调用方删掉：留在磁盘上的话，下次打开工程它会重新出现在
 * 历史里 —— 「我明明删了它又回来了」。
 */
export function upsertAgentSession(
  list: readonly AgentSessionRecord[],
  record: AgentSessionRecord,
): { sessions: AgentSessionRecord[]; evicted: string[] } {
  const kept = list.filter((s) => s.id !== record.id);
  const next = [record, ...kept].sort((a, b) => b.updatedAt - a.updatedAt);
  const sessions = next.slice(0, MAX_SESSIONS);
  const keptIds = new Set(sessions.map((s) => s.id));
  const evicted = next.filter((s) => !keptIds.has(s.id)).map((s) => s.id);
  return { sessions, evicted };
}
