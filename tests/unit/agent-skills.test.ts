import { describe, expect, it } from 'vitest';
import {
  SKILL_DESC_MAX,
  SkillFormatError,
  parseSkill,
  validateSkill,
} from '../../src/agent/skills/parse';
import { SKILLS, SKILL_ISSUES, readSkillSource, skillIndexText } from '../../src/agent/skills/registry';
import { SYSTEM_PROMPT } from '../../src/agent/llm/prompt';

/**
 * 技能（SKILL.md）的解析、索引与读取。
 *
 * 这一层只有两个真源：文件本身，和系统提示里那段索引。所以断言集中在
 * 「索引说的和文件里写的是同一件事」——漂的那天不会有任何报错，只会表现为
 * 模型按一个不存在的技能名去读，或者读到一份缺了参考文件的正文。
 */

describe('parseSkill', () => {
  const ok = `---
name: demo
description: >
  First line of the description
  continues here.

  Second paragraph.
license: MIT
---

# Body`;

  it('解析标量、折行块标量与正文', () => {
    const s = parseSkill(ok);
    expect(s.front.name).toBe('demo');
    expect(s.front.description).toBe('First line of the description continues here.\nSecond paragraph.');
    expect(s.front.license).toBe('MIT');
    expect(s.body).toBe('# Body');
  });

  it('保留字面块标量的换行', () => {
    const s = parseSkill(`---\nname: a\ndescription: |\n  line one\n  line two\n---\nbody`);
    expect(s.front.description).toBe('line one\nline two');
  });

  it('脱引号（单引号里的双写是转义）', () => {
    expect(parseSkill(`---\nname: a\ndescription: 'it''s fine'\n---\nx`).front.description).toBe("it's fine");
    expect(parseSkill(`---\nname: a\ndescription: "a: b"\n---\nx`).front.description).toBe('a: b');
  });

  it('核心四键之外的字段落进 extra，不丢也不报错', () => {
    const s = parseSkill(`---\nname: a\ndescription: d\nallowed-tools: Read\n---\nx`);
    expect(s.front.extra).toEqual({ 'allowed-tools': 'Read' });
  });

  it('语法错误抛异常：缺收尾 / 重复键 / 多行普通标量 / 块标量不缩进', () => {
    expect(() => parseSkill('# no frontmatter')).toThrow(SkillFormatError);
    expect(() => parseSkill(`---\nname: a\ndescription: d\n`)).toThrow(/closing/);
    expect(() => parseSkill(`---\nname: a\nname: b\n---\n`)).toThrow(/twice/);
    expect(() => parseSkill(`---\nname: a\ndescription: one\n  two\n---\n`)).toThrow(/multi-line plain scalar/);
    expect(() => parseSkill(`---\nname: a\ndescription: >\nnot indented\n---\n`)).toThrow(/indented/);
  });

  it('CRLF 不影响解析', () => {
    expect(parseSkill(`---\r\nname: a\r\ndescription: d\r\n---\r\nx`).front.name).toBe('a');
  });
});

describe('validateSkill', () => {
  const base = { front: { name: 'demo', description: 'd', extra: {} }, body: 'x' };

  it('合格返回空数组', () => {
    expect(validateSkill(base, 'demo')).toEqual([]);
  });

  it('name 必须是 kebab-case 且与目录一致', () => {
    expect(validateSkill({ ...base, front: { ...base.front, name: 'Demo_Skill' } }, 'demo').length).toBe(1);
    expect(validateSkill({ ...base, front: { ...base.front, name: 'other' } }, 'demo')[0]).toMatch(/directory/);
    expect(validateSkill({ ...base, front: { ...base.front, name: 'a--b' } }, 'a--b').length).toBe(1);
  });

  it('缺描述 / 描述超长 / 正文为空都要报', () => {
    expect(validateSkill({ ...base, front: { ...base.front, description: ' ' } }, 'demo')[0]).toMatch(/description/);
    expect(
      validateSkill({ ...base, front: { ...base.front, description: 'x'.repeat(SKILL_DESC_MAX + 1) } }, 'demo')[0],
    ).toMatch(/exceeds/);
    expect(validateSkill({ ...base, body: '\n  \n' }, 'demo')[0]).toMatch(/body/);
  });
});

describe('内置技能', () => {
  it('没有加载期问题（坏文件会在这里点名）', () => {
    expect(SKILL_ISSUES).toEqual([]);
  });

  it('每一份都合格，且描述控制在索引预算内', () => {
    expect(SKILLS.length).toBeGreaterThan(0);
    for (const s of SKILLS) {
      expect(s.name).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*$/);
      expect(s.description.trim()).not.toBe('');
      // 索引对每个技能常驻上下文，480 字符 ≈ 120 token。超了就该拆。
      expect(s.description.length, `${s.name} 的描述太长`).toBeLessThanOrEqual(480);
      // 正文按 spec 的建议控制在 500 行内；超了说明该拆 references。
      expect(s.body.split('\n').length, `${s.name} 的正文太长`).toBeLessThanOrEqual(200);
    }
  });

  it('正文里引用的 references 文件都真的存在', () => {
    for (const s of SKILLS) {
      for (const m of s.body.matchAll(/references\/([A-Za-z0-9._-]+\.md)/g)) {
        expect(s.files, `${s.name} 引用了不存在的 ${m[1]}`).toContain(m[1]);
      }
    }
  });

  it('索引列出每个技能的描述，但不含正文', () => {
    const index = skillIndexText();
    for (const s of SKILLS) {
      expect(index).toContain(s.name);
      // 索引里的描述是压平过换行的版本。
      expect(index).toContain(s.description.replace(/\s+/g, ' ').trim());
      // 正文的第一个标题不该出现在索引里 —— 出现了就是「一级披露把正文也带上了」。
      const firstHeading = s.body.split('\n').find((l) => l.startsWith('# '));
      if (firstHeading && firstHeading.length > 12) expect(index).not.toContain(firstHeading);
    }
  });

  it('系统提示带上了索引（漏接的表现是模型不知道技能存在）', () => {
    expect(SYSTEM_PROMPT).toContain('# Skills');
    for (const s of SKILLS) expect(SYSTEM_PROMPT).toContain(s.name);
  });
});

describe('readSkillSource', () => {
  it('按名字读正文', async () => {
    const name = SKILLS[0].name;
    const r = await readSkillSource(name);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.text).toContain('# ');
    expect(r.files).toEqual(SKILLS[0].files);
  });

  it('按名字 + 文件读引用', async () => {
    const s = SKILLS.find((x) => x.files.length > 0);
    expect(s, '至少要有一份技能带 references，否则三级披露没有被用到').toBeTruthy();
    if (!s) return;
    const r = await readSkillSource(s.name, s.files[0]);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.file).toBe(s.files[0]);
    expect(r.text).toContain('BPM');
  });

  it('未知名字 / 未知文件 / 路径穿越都不抛，按返回值报', async () => {
    const missing = await readSkillSource('no-such-skill');
    expect(missing.ok).toBe(false);
    if (!missing.ok) {
      expect(missing.reason).toBe('no-skill');
      expect(missing.available).toContain(SKILLS[0].name);
    }

    const noFile = await readSkillSource(SKILLS[0].name, 'nope.md');
    expect(noFile.ok).toBe(false);
    if (!noFile.ok) expect(noFile.reason).toBe('no-file');

    // 只查 glob 的键，不做路径拼接 —— 穿越输入拿到的是 no-file。
    const escape = await readSkillSource(SKILLS[0].name, '../SKILL.md');
    expect(escape.ok).toBe(false);
  });
});
