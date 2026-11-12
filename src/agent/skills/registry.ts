/**
 * registry.ts — 内置技能清单（构建期加载，运行期只读）。
 *
 * 目录约定就是 Agent Skills 标准：`builtin/<name>/SKILL.md`，可选的
 * `builtin/<name>/references/*.md` 是三级披露的第三层。
 *
 * ## 三级披露落在哪
 *
 * | 层 | 内容 | 进上下文的方式 |
 * |---|---|---|
 * | 1 | name + description | 系统提示里的一段索引（`skillIndexText`） |
 * | 2 | SKILL.md 正文 | `read_skill({ name })` |
 * | 3 | references/*.md | `read_skill({ name, file })` |
 *
 * 第一层必须是**整会话不变的纯常量**：系统提示是前缀缓存的锚点，按字节比。
 * 内置技能是构建期常量，所以这条成立；将来要是支持运行期装技能，索引只能
 * 走 user 消息尾部（`context.ts` 那条路），不能改系统提示。
 *
 * ## 为什么元数据用 eager glob
 *
 * 索引要在模块加载时就拿到 name / description —— 而它们就写在同一份文件的
 * frontmatter 里。拆成「元数据文件 + 正文文件」能省下正文的 bundle，代价是
 * 一份技能两个真源，改一处忘一处就是「索引说有、读出来不对」。正文进 bundle
 * 不进上下文，几 KB 的代价换单一真源，值。
 *
 * 引用文件相反：可能很大，也可能一直用不到，所以走懒加载。**有哪几个**还是
 * 编译期就知道（glob 的键），所以索引里能直接列出文件名。
 */

import { parseSkill, validateSkill, type SkillFrontmatter } from './parse';

export interface SkillEntry {
  name: string;
  description: string;
  license?: string;
  compatibility?: string;
  /** `references/` 下的文件名（不含目录），按字母序。 */
  files: readonly string[];
  /** SKILL.md 正文（不含 frontmatter）。 */
  body: string;
}

/** 全部 SKILL.md 的原文。键形如 `./builtin/<name>/SKILL.md`。 */
const BODIES = import.meta.glob<string>('./builtin/*/SKILL.md', {
  eager: true,
  query: '?raw',
  import: 'default',
}) as Record<string, string>;

/** 引用文件 → 懒加载器。键形如 `./builtin/<name>/references/<file>`。 */
const REFS = import.meta.glob('./builtin/*/references/*.md', {
  query: '?raw',
  import: 'default',
}) as Record<string, () => Promise<string>>;

/** 从 glob 键里取 `builtin` 后面那一段。构建产物里的前缀可能被改，只认锚点。 */
function segmentsAfterBuiltin(path: string): string[] | null {
  const parts = path.split('/').filter(Boolean);
  const i = parts.lastIndexOf('builtin');
  return i >= 0 ? parts.slice(i + 1) : null;
}

const refsByName = new Map<string, Map<string, () => Promise<string>>>();
for (const [path, load] of Object.entries(REFS)) {
  const rest = segmentsAfterBuiltin(path);
  // rest = [<name>, 'references', ...<file>]
  if (!rest || rest.length < 3 || rest[1] !== 'references') continue;
  const file = rest.slice(2).join('/');
  const bucket = refsByName.get(rest[0]) ?? new Map<string, () => Promise<string>>();
  bucket.set(file, load);
  refsByName.set(rest[0], bucket);
}

const entries: SkillEntry[] = [];
/** 加载期发现的问题。非空 = 有技能被排除在索引之外（单测断言它为空）。 */
const issues: string[] = [];

for (const [path, raw] of Object.entries(BODIES)) {
  const rest = segmentsAfterBuiltin(path);
  if (!rest || rest.length !== 2) {
    issues.push(`${path}: not at builtin/<name>/SKILL.md`);
    continue;
  }
  const dir = rest[0];

  let parsed;
  try {
    parsed = parseSkill(raw, path);
  } catch (e) {
    issues.push(e instanceof Error ? e.message : String(e));
    continue;
  }
  const problems = validateSkill(parsed, dir, path);
  if (problems.length) {
    issues.push(...problems);
    continue;
  }

  const front: SkillFrontmatter = parsed.front;
  entries.push({
    name: front.name,
    description: front.description,
    ...(front.license ? { license: front.license } : {}),
    ...(front.compatibility ? { compatibility: front.compatibility } : {}),
    files: [...(refsByName.get(dir)?.keys() ?? [])].sort(),
    body: parsed.body,
  });
}

entries.sort((a, b) => a.name.localeCompare(b.name));

/** 全部可用技能，按名字排序。坏技能不会进来（`SKILL_ISSUES` 里记着原因）。 */
export const SKILLS: readonly SkillEntry[] = entries;

export const SKILL_ISSUES: readonly string[] = issues;

export function getSkill(name: string): SkillEntry | undefined {
  return SKILLS.find((s) => s.name === name);
}

/**
 * 系统提示里的技能索引（一级披露）。
 *
 * 描述是**整条**给出去的，不截断：截断会静默切掉触发词，而触发词正是模型
 * 决定「要不要读这份」的唯一依据。要省 token 就在写技能时把描述写短
 * （`src/agent/skills/AGENTS.md` 有长度要求）。
 */
export function skillIndexText(): string {
  if (!SKILLS.length) return '';
  const lines = [
    '# Skills',
    'A skill is a playbook for one class of task: the order of operations, the exact tool',
    'arguments, and the traps that fail silently. Only the lines below are in context — the',
    'body is not. Load one BEFORE starting the work it names, not after the third failed',
    'attempt: `read_skill({ name })`. Bundled files load separately:',
    '`read_skill({ name, file })`.',
    '',
    ...SKILLS.map(
      (s) =>
        // 描述里的换行要压平：一条多段描述会把索引里的这个条目撑成多行，
        // 而索引的格式（`- name — 一句话`）正是模型扫它的方式。
        `- ${s.name} — ${s.description.replace(/\s+/g, ' ').trim()}` +
        `${s.files.length ? ` (files: ${s.files.join(', ')})` : ''}`,
    ),
  ];
  return lines.join('\n');
}

export interface SkillReadSuccess {
  ok: true;
  name: string;
  description: string;
  /** `file` 给了就是那个文件的全文，否则是 SKILL.md 正文。 */
  text: string;
  /** 被读的是哪个引用文件（读正文时不出现）。 */
  file?: string;
  /** 这份技能还带了哪些引用文件。 */
  files: readonly string[];
}

export interface SkillReadFailure {
  ok: false;
  reason: 'no-skill' | 'no-file';
  name: string;
  file?: string;
  available: readonly string[];
  /** `reason: 'no-file'` 时给出这份技能实际有的文件。 */
  files?: readonly string[];
}

/**
 * 读一份技能。**不抛异常**（与控制平面同一条纪律）：失败是返回值，
 * 由调用方决定怎么归一成用户能读的句子。
 *
 * 文件名只从 glob 的键里查（不做路径拼接），所以 `../../etc/passwd` 这类
 * 输入只会得到 `no-file`。
 */
export async function readSkillSource(name: string, file?: string): Promise<SkillReadSuccess | SkillReadFailure> {
  const skill = getSkill(name);
  if (!skill) {
    return { ok: false, reason: 'no-skill', name, available: SKILLS.map((s) => s.name) };
  }
  if (file) {
    const load = refsByName.get(name)?.get(file);
    if (!load) {
      return { ok: false, reason: 'no-file', name, file, available: SKILLS.map((s) => s.name), files: skill.files };
    }
    return {
      ok: true,
      name,
      description: skill.description,
      text: await load(),
      file,
      files: skill.files,
    };
  }
  return { ok: true, name, description: skill.description, text: skill.body, files: skill.files };
}
