/**
 * plugin-text.ts — Agent 读写插件源码的**纯文本原语**。
 *
 * 只做「字符串 → 字符串 / 行号」，不碰宿主、不碰注册表、不碰 DOM。这样三件事
 * 都能在 Node 里单测；至于「读哪一份源码」（会话草稿还是磁盘上的已安装文件）
 * 留给 `plugin-author.ts`。
 *
 * 为什么要这一层：插件源码是 Agent 唯一需要**逐行迭代**的文本。整份重发既贵又
 * 容易在无关处漂移，所以工具面给的是「分页看 / 正则找 / 唯一串替换」三件套 ——
 * 而它们的错误形态（行号算错、替换命中多处）必须在这里定死，不能靠调用方自觉。
 */

/** 一页的默认行数。 */
export const VIEW_DEFAULT_LIMIT = 200;
/** 一页的硬上限。 */
export const VIEW_MAX_LIMIT = 500;

/**
 * 源码 → 行。
 *
 * **行号从 1 开始**（与编辑器、编译错误、`plugin_view` 的输出一致）。
 * 末尾换行不额外产生一个空行：`"a\n"` 是一行，`"a\n\n"` 是两行（第二行空）。
 * CRLF 归一成 LF，`\r` 不会留在行尾污染模型复制出去的 `old_string`。
 */
export function sourceLines(source: string): string[] {
  if (source === '') return [''];
  const lines = source.replace(/\r\n?/g, '\n').split('\n');
  if (lines.length > 1 && lines[lines.length - 1] === '') lines.pop();
  return lines;
}

export interface SourceView {
  /** 带行号的正文（每行 `  12 | code`）。 */
  text: string;
  /** 1-based，含。空页时 `to < from`。 */
  from: number;
  to: number;
  total: number;
  hasMore: boolean;
  /** 下一页的 `offset`；没有下一页时为 null。 */
  nextOffset: number | null;
}

function clampInt(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, Math.trunc(value)));
}

/**
 * 取一段带行号的源码。
 *
 * `offset` 越界**不报错**：返回空页 + `hasMore:false`。模型按上一页的 `nextOffset`
 * 翻页，若文件在两次调用之间被改短，报错只会让它卡住；空页加 `total` 已经说清了
 * 「文件只有这么长」。
 */
export function viewSource(source: string, offset = 1, limit = VIEW_DEFAULT_LIMIT): SourceView {
  const lines = sourceLines(source);
  const total = lines.length;
  const from = clampInt(offset, 1, total + 1);
  const count = clampInt(limit, 1, VIEW_MAX_LIMIT);
  const to = Math.min(total, from + count - 1);
  const hasMore = to < total;
  const width = Math.max(3, String(total).length);
  const body =
    from > to
      ? ''
      : lines
          .slice(from - 1, to)
          .map((line, i) => `${String(from + i).padStart(width, ' ')} | ${line}`)
          .join('\n');
  const tail = hasMore
    ? `[${total - to} more lines; continue with offset=${to + 1}]`
    : `[end of file (${total} lines)]`;
  return {
    text: body ? `${body}\n\n${tail}` : tail,
    from,
    to,
    total,
    hasMore,
    nextOffset: hasMore ? to + 1 : null,
  };
}

/* ------------------------------------------------------------------ grep */

/** 前后各带几行（上限 2：再多就不像「定位」而像「看全文」）。 */
export const GREP_MAX_CONTEXT = 2;
export const GREP_DEFAULT_MAX = 40;
export const GREP_MAX_RESULTS = 200;

export interface GrepMatch {
  /** 1-based。 */
  line: number;
  text: string;
  before?: string[];
  after?: string[];
}

export interface GrepResult {
  matches: GrepMatch[];
  /** 命中总数（截断前）。 */
  total: number;
  truncated: boolean;
}

/**
 * 逐行正则匹配。
 *
 * 不用 `String.matchAll`：需求是「行号 + 整行」，逐行 `test` 的语义最直白，
 * 也不会因为表达式带 `g` 而出现 `lastIndex` 那种状态。
 */
export function grepSource(
  source: string,
  pattern: RegExp,
  opts: { context?: number; max?: number } = {},
): GrepResult {
  const lines = sourceLines(source);
  const context = clampInt(opts.context ?? 0, 0, GREP_MAX_CONTEXT);
  const max = clampInt(opts.max ?? GREP_DEFAULT_MAX, 1, GREP_MAX_RESULTS);
  const matches: GrepMatch[] = [];
  let total = 0;
  for (let i = 0; i < lines.length; i++) {
    if (!pattern.test(lines[i]!)) continue;
    total++;
    if (matches.length >= max) continue;
    const match: GrepMatch = { line: i + 1, text: lines[i]! };
    if (context > 0) {
      if (i > 0) match.before = lines.slice(Math.max(0, i - context), i);
      if (i + 1 < lines.length) match.after = lines.slice(i + 1, i + 1 + context);
    }
    matches.push(match);
  }
  return { matches, total, truncated: total > matches.length };
}

/* ------------------------------------------------------------------ edit */

export type EditFailure = 'empty-old' | 'same' | 'not-found' | 'ambiguous';

export type EditResult =
  | { ok: true; source: string; /** 替换处的 1-based 行号 */ line: number }
  | { ok: false; code: EditFailure; /** `ambiguous` 时给出全部命中行号 */ lines?: number[] };

function countOccurrences(haystack: string, needle: string): { count: number; at: number } {
  let count = 0;
  let at = -1;
  let from = 0;
  for (;;) {
    const i = haystack.indexOf(needle, from);
    if (i < 0) break;
    count++;
    if (at < 0) at = i;
    from = i + needle.length;
  }
  return { count, at };
}

/**
 * **唯一匹配**的精确字面量替换。
 *
 * 唯一性是这条工具的整个价值：模型对上下文理解有偏差时，`old_string` 常常会
 * 命中多处 —— 那时静默替换第一处（或全部）就是「改对了语法、改错了地方」，
 * 而且回执看起来完全正常。所以非唯一一律失败，并把命中行号报回去让它补上下文。
 *
 * CRLF：外部导入的插件可能是 CRLF。`viewSource` 把 `\r` 归一掉了，模型复制回来
 * 的 `old_string` 只有 `\n` —— 直接比会永远 not-found。这里按文件现有风格
 * （含 `\r\n` 就整体转 CRLF）匹配与插入，写回时保持原风格。
 */
export function applyUniqueEdit(source: string, oldString: string, newString: string): EditResult {
  if (oldString === '') return { ok: false, code: 'empty-old' };
  if (oldString === newString) return { ok: false, code: 'same' };

  const crlf = source.includes('\r\n');
  const toFileStyle = (s: string): string => (crlf ? s.replace(/\r\n?/g, '\n').replace(/\n/g, '\r\n') : s);
  const needle = toFileStyle(oldString);
  const replacement = toFileStyle(newString);

  const { count, at } = countOccurrences(source, needle);
  if (count === 0) return { ok: false, code: 'not-found' };
  if (count > 1) {
    const lines: number[] = [];
    let from = 0;
    for (;;) {
      const i = source.indexOf(needle, from);
      if (i < 0) break;
      lines.push(source.slice(0, i).split('\n').length);
      from = i + needle.length;
    }
    return { ok: false, code: 'ambiguous', lines };
  }

  const next = source.slice(0, at) + replacement + source.slice(at + needle.length);
  return { ok: true, source: next, line: source.slice(0, at).split('\n').length };
}
