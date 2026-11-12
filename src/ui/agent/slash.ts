/**
 * slash.ts — 输入框里的斜杠菜单（纯函数：识别、过滤、取词）。
 *
 * 两件事共用一张表：**宿主动作**（本轮只有 `/compact`）与**技能**
 * （`src/agent/skills/builtin/` 里有什么就有什么）。分成两套菜单是错的：
 * 用户想的是「我要它按某种打法做这件事」，不该先知道那件事归哪一层管。
 *
 * 三条纪律：
 *
 * 1. **识别只认「词首的 `/`」**。`a/b`、`https://x` 这类不弹菜单 —— mid-word
 *    的斜杠是内容，不是命令。判断是「前一个字符是行首或空白」，不解析 markdown。
 * 2. **词里出现空白就不再是命令**：那已经是「选好了之后接着说的话」。
 * 3. **过滤对 id 与描述同时生效**：描述里有 `卡点 / 海报 / 封面` 这些词，
 *    用中文问也能找到英文名的技能。
 */

import { SKILLS } from '../../agent/skills/registry';
import type { MessageKey } from '../../i18n/locales';

export interface SlashCommand {
  kind: 'command';
  id: string;
  labelKey: MessageKey;
  hintKey: MessageKey;
}

export interface SlashSkill {
  kind: 'skill';
  id: string;
  description: string;
  files: readonly string[];
}

export type SlashItem = SlashCommand | SlashSkill;

/**
 * 宿主动作。加一条就在这里加一行 —— **不要**为了一个动作去写「技能」，
 * 技能是给模型的打法，命令是宿主自己执行的东西（不动模型、不花 token）。
 */
export const SLASH_COMMANDS: readonly SlashCommand[] = [
  {
    kind: 'command',
    id: 'compact',
    labelKey: 'agent.slash.compact',
    hintKey: 'agent.slash.compactHint',
  },
];

/** 菜单的全部条目：命令在前，技能按名字排序（`SKILLS` 已经排过）。 */
export function slashItems(): SlashItem[] {
  return [
    ...SLASH_COMMANDS,
    ...SKILLS.map(
      (s): SlashSkill => ({ kind: 'skill', id: s.name, description: s.description, files: s.files }),
    ),
  ];
}

/** 光标所在的斜杠词。`null` = 此刻不该弹菜单。 */
export interface SlashToken {
  /** `/` 之后的文字（不含 `/`）。 */
  query: string;
  /** `/` 的位置。 */
  start: number;
  /** 词尾（光标之后同一词的末端）。替换时用它，不会吃掉后面的话。 */
  end: number;
}

export function slashToken(text: string, caret: number): SlashToken | null {
  const at = Math.max(0, Math.min(caret, text.length));
  const before = text.slice(0, at);
  const start = before.lastIndexOf('/');
  if (start < 0) return null;
  // 词首才认：`a/b` 与 `https://` 里的斜杠是内容。
  if (start > 0 && !/\s/.test(before[start - 1])) return null;
  const query = before.slice(start + 1);
  // 已经带空白 = 用户在说需求了，菜单让位。
  if (/\s/.test(query)) return null;
  const tail = /^[^\s]*/.exec(text.slice(at))?.[0] ?? '';
  return { query, start, end: at + tail.length };
}

function rank(item: SlashItem, q: string, labelOf?: (item: SlashItem) => string): number {
  const id = item.id.toLowerCase();
  if (id.startsWith(q)) return 0;
  if (id.includes(q)) return 1;
  // 描述与显示名都算：技能描述里有 `卡点 / 海报`，命令的显示名是中文。
  const extra = [item.kind === 'skill' ? item.description : '', labelOf?.(item) ?? ''].join(' ').toLowerCase();
  return extra.includes(q) ? 2 : -1;
}

/**
 * 过滤 + 排序（前缀匹配优先，同一档位保持原顺序）。空查询返回全表。
 *
 * `labelOf` 给命令的**显示名**参与匹配用（`/压缩` 要能找到 `/compact`）。
 * 传函数而不是在这里 `tr()`：这一层是纯逻辑，界面语言由调用方决定。
 */
export function filterSlash(
  items: readonly SlashItem[],
  query: string,
  labelOf?: (item: SlashItem) => string,
): SlashItem[] {
  const q = query.trim().toLowerCase();
  if (!q) return [...items];
  return items
    .map((item) => ({ item, score: rank(item, q, labelOf) }))
    .filter((x) => x.score >= 0)
    .sort((a, b) => a.score - b.score)
    .map((x) => x.item);
}

/**
 * 选中一项之后输入框该变成什么。
 *
 * 只摘掉那个词，**不重排剩下的文字**：用户在别处写的东西不该因为点了一个
 * 菜单项而变形。词首的 `/xxx` 被摘掉后紧跟的空格也一起去掉，否则输入框里
 * 会留一个看不见的前导空格。
 */
export function removeSlashToken(text: string, token: SlashToken): { text: string; caret: number } {
  const before = text.slice(0, token.start);
  const after = text.slice(token.end);
  const next = before + (before ? after : after.replace(/^[ \t]+/, ''));
  return next.trim() ? { text: next, caret: Math.min(before.length, next.length) } : { text: '', caret: 0 };
}
