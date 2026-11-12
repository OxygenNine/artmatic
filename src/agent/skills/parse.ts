/**
 * parse.ts — SKILL.md 的 frontmatter 解析与校验（纯函数，可在 Node 里单测）。
 *
 * 格式是 Agent Skills 开放标准（agentskills.io）：`---` 包住的 YAML frontmatter
 * 加一段 markdown 正文。**不引 YAML 库**：SKILL.md 只会用到标量与 `>` / `|`
 * 两种块标量，映射 / 锚点 / 多文档一次都用不到，而引一个库的代价是体积和
 * 「解析歧义归谁」说不清。
 *
 * 三条取舍：
 *
 * 1. **语法错误抛异常，语义错误返回问题清单。** 前者是「文件坏了」（少了收尾
 *    `---`、块标量没缩进），后者是「内容不合格」（name 与目录不一致）。前者
 *    只有作者能修，后者作者在单测里一眼能看到。
 * 2. **未知键不报错**，落进 `extra`。标准之外的字段（`allowed-tools` 之类）在
 *    别家 harness 里合法，搬过来不该整份拒绝。内置技能只用核心字段，这条由
 *    `tests/unit/agent-skills.test.ts` 钉住。
 * 3. **正文原样返回**：不 trim 缩进、不重排。模型读到的就是文件里写的那样。
 *
 * 诊断消息用英文：它们的读者是**写 SKILL.md 的人**，出口只有 `SKILL_ISSUES` 与单测
 * 失败信息，没有任何界面路径。语言跟技能文件与工具描述保持一致，也就不用为它们
 * 在 i18n 守卫里开一堆例外。
 */

export class SkillFormatError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SkillFormatError';
  }
}

export interface SkillFrontmatter {
  name: string;
  description: string;
  license?: string;
  compatibility?: string;
  /** 核心四键之外的字段。我们不解释它们，只保证不丢。 */
  extra: Record<string, string>;
}

export interface ParsedSkill {
  front: SkillFrontmatter;
  /** 去掉 frontmatter 之后的正文。 */
  body: string;
}

/** name 的字符集（标准：小写字母 / 数字 / 连字符，不许首尾或连续连字符）。 */
export const SKILL_NAME_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
export const SKILL_NAME_MAX = 64;
export const SKILL_DESC_MAX = 1024;
export const SKILL_COMPAT_MAX = 500;

const CORE_KEYS = new Set(['name', 'description', 'license', 'compatibility']);

interface Field {
  key: string;
  /** 第一行是 `key:` 之后的内容，其余是后续（缩进）行。 */
  lines: string[];
}

export function parseSkill(raw: string, where = 'SKILL.md'): ParsedSkill {
  const lines = raw.replace(/\r\n/g, '\n').split('\n');
  if (lines[0]?.trim() !== '---') {
    throw new SkillFormatError(`${where}: the first line must be ---`);
  }
  const end = lines.findIndex((l, i) => i > 0 && l.trim() === '---');
  if (end < 0) throw new SkillFormatError(`${where}: frontmatter is missing its closing ---`);

  const values = readFields(lines.slice(1, end), where);
  const extra: Record<string, string> = {};
  for (const [k, v] of Object.entries(values)) if (!CORE_KEYS.has(k)) extra[k] = v;

  const front: SkillFrontmatter = {
    name: values.name ?? '',
    description: values.description ?? '',
    ...(values.license ? { license: values.license } : {}),
    ...(values.compatibility ? { compatibility: values.compatibility } : {}),
    extra,
  };
  // 收尾 `---` 之后通常有一个空行，它不属于正文。
  const body = lines.slice(end + 1).join('\n').replace(/^\n+/, '');
  return { front, body };
}

function readFields(head: string[], where: string): Record<string, string> {
  const fields: Field[] = [];
  for (const line of head) {
    if (!line.trim() || /^\s/.test(line)) {
      if (!fields.length) throw new SkillFormatError(`${where}: the first frontmatter line must not be indented`);
      fields[fields.length - 1].lines.push(line);
      continue;
    }
    const m = /^([A-Za-z][A-Za-z0-9_-]*):(.*)$/.exec(line);
    if (!m) {
      throw new SkillFormatError(`${where}: cannot parse frontmatter line "${line}" (block scalar content must be indented)`);
    }
    fields.push({ key: m[1], lines: [m[2].trim()] });
  }

  const out: Record<string, string> = {};
  for (const f of fields) {
    if (f.key in out) throw new SkillFormatError(`${where}: field ${f.key} appears twice`);
    out[f.key] = fieldValue(f, where);
  }
  return out;
}

function fieldValue(f: Field, where: string): string {
  const [first, ...rest] = f.lines;
  if (/^[>|][+-]?$/.test(first)) {
    return block(rest, first[0] as '>' | '|', where, f.key);
  }
  if (rest.some((l) => l.trim())) {
    throw new SkillFormatError(`${where}: ${f.key} is a multi-line plain scalar (unsupported) - use > or |`);
  }
  return scalar(first, where, f.key);
}

/** 块标量：按最浅缩进剥掉公共前缀；`>` 折成段落，`|` 保留换行。 */
function block(lines: string[], mode: '>' | '|', where: string, key: string): string {
  const rows = lines.slice();
  while (rows.length && !rows[0].trim()) rows.shift();
  while (rows.length && !rows[rows.length - 1].trim()) rows.pop();
  if (!rows.length) throw new SkillFormatError(`${where}: ${key} has an empty block scalar`);

  // 走到这里的内容行都带缩进（不带缩进的行会被当成新字段），所以 cut >= 1。
  const cut = Math.min(...rows.filter((l) => l.trim()).map((l) => (/^[ \t]*/.exec(l) as RegExpExecArray)[0].length));
  const stripped = rows.map((l) => l.slice(cut));
  if (mode === '|') return stripped.join('\n');

  const out: string[] = [];
  let para: string[] = [];
  const flush = () => {
    if (para.length) out.push(para.join(' '));
    para = [];
  };
  for (const line of stripped) {
    // 空行 = 段落分隔。`out` 之间本来就用换行拼，所以这里只收段落，
    // 不再补一个空串 —— 那会得到 YAML 里不存在的空行。
    if (!line.trim()) flush();
    else para.push(line.trim());
  }
  flush();
  return out.join('\n').trim();
}

function scalar(v: string, where: string, key: string): string {
  if (v.startsWith('"')) {
    if (v.length < 2 || !v.endsWith('"')) throw new SkillFormatError(`${where}: ${key} has an unterminated double quote`);
    try {
      return JSON.parse(v) as string;
    } catch {
      throw new SkillFormatError(`${where}: ${key} is not a valid double-quoted string`);
    }
  }
  if (v.startsWith("'")) {
    if (v.length < 2 || !v.endsWith("'")) throw new SkillFormatError(`${where}: ${key} has an unterminated single quote`);
    return v.slice(1, -1).replace(/''/g, "'");
  }
  return v;
}

/**
 * 语义检查。返回空数组 = 合格。
 *
 * `dir` 是技能目录名：标准要求 `name` 与它一致 —— 不一致的后果是
 * 「索引里叫 A、按名字读却读到 B」，模型会被自己的索引误导。
 */
export function validateSkill(skill: ParsedSkill, dir: string, where = 'SKILL.md'): string[] {
  const problems: string[] = [];
  const { front, body } = skill;

  if (!front.name) problems.push(`${where}: missing name`);
  else if (!SKILL_NAME_RE.test(front.name)) {
    problems.push(`${where}: name "${front.name}" must be lowercase letters / digits / single hyphens`);
  } else if (front.name.length > SKILL_NAME_MAX) {
    problems.push(`${where}: name exceeds ${SKILL_NAME_MAX} chars`);
  } else if (front.name !== dir) {
    problems.push(`${where}: name "${front.name}" does not match directory "${dir}"`);
  }

  if (!front.description.trim()) problems.push(`${where}: missing description`);
  else if (front.description.length > SKILL_DESC_MAX) {
    problems.push(`${where}: description exceeds ${SKILL_DESC_MAX} chars`);
  }

  if (front.compatibility && front.compatibility.length > SKILL_COMPAT_MAX) {
    problems.push(`${where}: compatibility exceeds ${SKILL_COMPAT_MAX} chars`);
  }
  if (!body.trim()) problems.push(`${where}: body is empty`);

  return problems;
}
