import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { AGENT_TOOLS } from '../../src/agent/tools';
import { TOOLS } from '../../mcp/tools.mjs';

/**
 * 应用内工具表 与 MCP 网关工具表的一致性。
 *
 * 两边各写一份 dispatch 是刻意的（网关要过 CDP、应用内是直接函数调用），
 * 但**名字与必需参数必须对齐** —— 漏一边的形态是「模型应用内能用、外接客户端
 * 说没有这个工具」，或者参数名拼错后静默取默认值。
 *
 * 反向不做全等：MCP 还暴露了 `compile_all` / `list_projects` /
 * `open_project` 这类页面自动化专用工具，应用内面板不需要它们。
 */

const MCP = TOOLS as { name: string; args?: Record<string, { required?: boolean }> }[];
const MCP_BY_NAME = new Map(MCP.map((t) => [t.name, t]));

/** MCP 有、应用内刻意不暴露的工具。 */
const MCP_ONLY = new Set([
  'artmatic_list_projects',
  'artmatic_compile_all',
  'artmatic_open_project',
  'artmatic_save_project',
]);

describe('工具表一致性', () => {
  it('应用内的每个工具在 MCP 网关里都有同名工具（appOnly 的除外）', () => {
    const missing = AGENT_TOOLS.filter(
      (t) => !t.appOnly && !MCP_BY_NAME.has(`artmatic_${t.name}`),
    ).map((t) => t.name);
    expect(missing).toEqual([]);
  });

  it('appOnly 工具确实没有出现在网关里（否则客户端会等一个没人回答的问题）', () => {
    const leaked = AGENT_TOOLS.filter((t) => t.appOnly && MCP_BY_NAME.has(`artmatic_${t.name}`)).map(
      (t) => t.name,
    );
    expect(leaked).toEqual([]);
  });

  it('MCP 独有的工具在允许清单里（新增时要显式决定要不要同步到应用内）', () => {
    const appNames = new Set(AGENT_TOOLS.map((t) => `artmatic_${t.name}`));
    const extra = MCP.map((t) => t.name).filter((n) => !appNames.has(n));
    expect(new Set(extra)).toEqual(MCP_ONLY);
  });

  it('必需参数键在两侧一致', () => {
    const problems: string[] = [];
    for (const tool of AGENT_TOOLS) {
      const mcp = MCP_BY_NAME.get(`artmatic_${tool.name}`);
      if (!mcp) continue;
      const mcpArgs = mcp.args ?? {};
      for (const p of tool.params) {
        const spec = mcpArgs[p.key];
        if (!spec) {
          problems.push(`${tool.name}: MCP 缺少参数 ${p.key}`);
          continue;
        }
        if (Boolean(spec.required) !== Boolean(p.required)) {
          problems.push(`${tool.name}.${p.key}: required 不一致（app=${Boolean(p.required)} mcp=${Boolean(spec.required)}）`);
        }
      }
    }
    expect(problems).toEqual([]);
  });

  it('工具名不重复', () => {
    const names = AGENT_TOOLS.map((t) => t.name);
    expect(new Set(names).size).toBe(names.length);
    const mcpNames = MCP.map((t) => t.name);
    expect(new Set(mcpNames).size).toBe(mcpNames.length);
  });

  /**
   * 网关的 dispatch 覆盖：工具在 `tools.mjs` 里登记了，却忘了在 `index.mjs` 的
   * switch 里加 case —— 表现是「schema 里有这个工具，一调就 unknown action」。
   * 两边不在同一个文件，静态检查是唯一便宜的守卫（上面那条只查名字与必需参数）。
   */
  it('每个 MCP 工具在网关 dispatch 里都有 case', () => {
    const src = readFileSync(new URL('../../mcp/index.mjs', import.meta.url), 'utf8');
    const missing = MCP.map((t) => t.name).filter((n) => !src.includes(`case '${n}':`));
    expect(missing).toEqual([]);
  });
});
