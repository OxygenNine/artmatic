import { describe, expect, it } from 'vitest';
import { PLUGIN_COMMANDS, PLUGIN_TIMELINE_COMMANDS } from '../../src/plugins/api-types';
import {
  PLUGIN_COMMAND_ARGS,
  PLUGIN_TIMELINE_COMMAND_ARGS,
} from '../../src/ui/plugins/plugin-commands';
import { TOOL_BY_NAME } from '../../src/agent/tools';

/**
 * 插件命令白名单与 Agent 工具表的一致性。
 *
 * 命令名与参数形状都**刻意**与同名工具一致：插件作者与模型读的是同一套文档。
 * 两边漂移的形态是「插件按文档传了 `size`，桥接层却在读 `w` / `h`」——
 * 结果是一次静默的空画布，而不是报错。
 */

/**
 * 两条命名空间共用同一套断言：命令名必须在工具表里、参数键必须是工具参数的
 * 子集、工具必须标 `writes`。分成两个 describe 是为了让失败信息直接指到
 * 「哪一组命令漂了」。
 */
function checkNamespace(
  names: readonly string[],
  argsTable: Record<string, { required: string[]; optional: string[] }>,
): void {
  expect(Object.keys(argsTable).sort()).toEqual([...names].sort());
  expect(names.filter((name) => !TOOL_BY_NAME.has(name))).toEqual([]);

  const problems: string[] = [];
  for (const name of names) {
    const spec = TOOL_BY_NAME.get(name);
    if (!spec) continue;
    const toolKeys = new Set(spec.params.map((p) => p.key));
    const entry = argsTable[name]!;
    for (const key of [...entry.required, ...entry.optional]) {
      if (!toolKeys.has(key)) problems.push(`${name}.${key}`);
    }
  }
  expect(problems).toEqual([]);

  for (const name of names) {
    expect(TOOL_BY_NAME.get(name)?.writes, name).toBe(true);
  }
}

describe('命令表（排版）', () => {
  it('与 Agent 工具表对齐', () => {
    checkNamespace(PLUGIN_COMMANDS, PLUGIN_COMMAND_ARGS);
  });
});

describe('命令表（时间轴）', () => {
  it('与 Agent 工具表对齐', () => {
    checkNamespace(PLUGIN_TIMELINE_COMMANDS, PLUGIN_TIMELINE_COMMAND_ARGS);
  });
});
