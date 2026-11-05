/**
 * plugin-check.ts — 插件的**静态**检查：真语法解析，但一行都不执行。
 *
 * 为什么不直接 `import()` 一遍：那正是 `plugin_try` 干的事，而它需要用户批准
 * （源码在主世界执行、没有沙箱）。本工具存在的意义就是「拿到批准之前先把低级
 * 错误清掉」，所以只能解析、不能求值。
 *
 * 解析器用 acorn（MIT），**动态加载**：只在 `plugin_check` 真被调用时才进
 * 页面，首屏与普通对话不为它付体积。
 *
 * 除了语法，还报三类「一定跑不起来」的静态问题：
 *   - `import` / `import()`：插件是单文件、经 blob URL 载入，任何模块说明符都
 *     解析不了（相对路径与裸包名都不行）。
 *   - 没有 `plugin`（或 `default`）导出：宿主读不到清单。
 *   - `format` 明确写了别的值：`artmatic-plugin` 是唯一被接受的。
 *     只在**字面量看得见**时报 —— `export const plugin = make()` 不猜。
 */

import { sourceLines } from './plugin-text';

export type PluginCheckCode =
  | 'parser'
  | 'syntax'
  | 'import'
  | 'dynamic-import'
  | 'no-export'
  | 'bad-format';

export interface PluginCheckIssue {
  code: PluginCheckCode;
  /** 1-based。 */
  line: number;
  /** 1-based。 */
  column: number;
  /** 非文案细节（解析器原始消息 / 模块名 / 写错的 format 值）。句子由调用方按 code 拼。 */
  detail?: string;
}

export interface PluginCheckResult {
  ok: boolean;
  /** 源码行数。 */
  lines: number;
  issues: PluginCheckIssue[];
  /** 静态能看到的导出名（`default` 也会出现）。 */
  exports: string[];
}

interface AstNode {
  type: string;
  [key: string]: unknown;
}

function asNode(value: unknown): AstNode | null {
  if (!value || typeof value !== 'object') return null;
  const node = value as AstNode;
  return typeof node.type === 'string' ? node : null;
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

/** 通用 AST 遍历：跳过位置字段，其余对象/数组递归。 */
function walk(node: unknown, visit: (n: AstNode) => void): void {
  if (Array.isArray(node)) {
    for (const item of node) walk(item, visit);
    return;
  }
  const n = asNode(node);
  if (!n) return;
  visit(n);
  for (const key of Object.keys(n)) {
    if (key === 'type' || key === 'start' || key === 'end' || key === 'loc' || key === 'range') continue;
    walk(n[key], visit);
  }
}

function lineOf(node: AstNode): number {
  const loc = node.loc as { start?: { line?: unknown } } | undefined;
  const line = loc?.start?.line;
  return typeof line === 'number' ? line : 1;
}

function columnOf(node: AstNode): number {
  const loc = node.loc as { start?: { column?: unknown } } | undefined;
  const column = loc?.start?.column;
  return typeof column === 'number' ? column + 1 : 1;
}

function errorText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** acorn 在消息尾部拼了 `(line:col)`；位置已经单独给了，别让它混进 detail。 */
function stripPosition(message: string): string {
  return message.replace(/\s*\(\d+:\d+\)\s*$/, '');
}

const PLUGIN_FORMAT = 'artmatic-plugin';

/**
 * 解析 + 静态规则。
 *
 * 不抛：解析失败就是一条 `syntax` issue（带 acorn 给的行列），这比让工具调用
 * 整体失败更有用 —— 模型要的是「第几行错了」。
 */
export async function checkPluginSource(source: string): Promise<PluginCheckResult> {
  const lines = sourceLines(source).length;

  let parse: ((input: string, opts: Record<string, unknown>) => AstNode) | null = null;
  try {
    const acorn = await import('acorn');
    parse = acorn.parse as unknown as (input: string, opts: Record<string, unknown>) => AstNode;
  } catch (e) {
    return {
      ok: false,
      lines,
      issues: [{ code: 'parser', line: 1, column: 1, detail: errorText(e) }],
      exports: [],
    };
  }

  let ast: AstNode;
  try {
    ast = parse(source, {
      ecmaVersion: 'latest',
      sourceType: 'module',
      locations: true,
      allowHashBang: true,
    });
  } catch (e) {
    const err = e as { message?: unknown; loc?: { line?: unknown; column?: unknown } };
    return {
      ok: false,
      lines,
      issues: [
        {
          code: 'syntax',
          line: typeof err.loc?.line === 'number' ? err.loc.line : 1,
          column: (typeof err.loc?.column === 'number' ? err.loc.column : 0) + 1,
          detail: stripPosition(typeof err.message === 'string' ? err.message : 'syntax error'),
        },
      ],
      exports: [],
    };
  }

  const issues: PluginCheckIssue[] = [];
  const exports = new Set<string>();

  walk(ast, (node) => {
    switch (node.type) {
      case 'ImportDeclaration': {
        const src = asNode(node.source);
        issues.push({
          code: 'import',
          line: lineOf(node),
          column: columnOf(node),
          detail: typeof src?.value === 'string' ? src.value : '',
        });
        break;
      }
      case 'ImportExpression': {
        issues.push({ code: 'dynamic-import', line: lineOf(node), column: columnOf(node) });
        break;
      }
      case 'ExportDefaultDeclaration':
        exports.add('default');
        break;
      case 'ExportAllDeclaration': {
        const src = asNode(node.source);
        if (src) {
          issues.push({
            code: 'import',
            line: lineOf(node),
            column: columnOf(node),
            detail: typeof src.value === 'string' ? src.value : '',
          });
        }
        exports.add('*');
        break;
      }
      case 'ExportNamedDeclaration': {
        // `export { x } from './y'` 也是模块说明符，同样在 blob 里解析不了。
        const from = asNode(node.source);
        if (from) {
          issues.push({
            code: 'import',
            line: lineOf(node),
            column: columnOf(node),
            detail: typeof from.value === 'string' ? from.value : '',
          });
        }
        const decl = asNode(node.declaration);
        if (decl?.type === 'VariableDeclaration') {
          for (const raw of asArray(decl.declarations)) {
            const id = asNode(asNode(raw)?.id);
            if (id?.type === 'Identifier' && typeof id.name === 'string') exports.add(id.name);
          }
        } else if (decl && typeof decl.id === 'object') {
          const id = asNode(decl.id);
          if (id?.type === 'Identifier' && typeof id.name === 'string') exports.add(id.name);
        }
        for (const raw of asArray(node.specifiers)) {
          const exported = asNode(asNode(raw)?.exported);
          if (exported?.type === 'Identifier' && typeof exported.name === 'string') {
            exports.add(exported.name);
          }
        }
        break;
      }
    }
  });

  if (!exports.has('plugin') && !exports.has('default')) {
    issues.push({ code: 'no-export', line: 1, column: 1 });
  }

  // `format` 写成别的值：只在 `export const plugin = { format: '…' }` 这种
  // 字面量形态下判。用函数造出来的清单不猜（猜错比不查更糟）。
  walk(ast, (node) => {
    if (node.type !== 'ExportNamedDeclaration') return;
    const decl = asNode(node.declaration);
    if (decl?.type !== 'VariableDeclaration') return;
    for (const raw of asArray(decl.declarations)) {
      const d = asNode(raw);
      const id = asNode(d?.id);
      if (id?.type !== 'Identifier' || id.name !== 'plugin') continue;
      const init = asNode(d?.init);
      if (init?.type !== 'ObjectExpression') continue;
      for (const rawProp of asArray(init.properties)) {
        const prop = asNode(rawProp);
        if (prop?.type !== 'Property') continue;
        const key = asNode(prop.key);
        const keyName =
          key?.type === 'Identifier' && typeof key.name === 'string'
            ? key.name
            : key?.type === 'Literal' && typeof key.value === 'string'
              ? key.value
              : null;
        if (keyName !== 'format') continue;
        const value = asNode(prop.value);
        if (value?.type !== 'Literal' || typeof value.value !== 'string') continue;
        if (value.value === PLUGIN_FORMAT) continue;
        issues.push({
          code: 'bad-format',
          line: lineOf(prop),
          column: columnOf(prop),
          detail: value.value,
        });
      }
    }
  });

  issues.sort((a, b) => a.line - b.line || a.column - b.column);
  return {
    ok: issues.length === 0,
    lines,
    issues,
    exports: [...exports].sort(),
  };
}
