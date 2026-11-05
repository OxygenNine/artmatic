import { describe, expect, it } from 'vitest';
import { checkPluginSource } from '../../src/agent/plugin-check';

/**
 * 静态检查的两类判据要同时成立：
 *   1. 真语法错误必须带**行号**（模型没有终端，行号是它唯一的坐标）；
 *   2. 不该误报 —— `export const plugin = make()` 这种看不出清单内容的形态
 *      必须通过，否则模型会被一条假错误带着改一堆无关代码。
 */

const GOOD = `export const plugin = {
  format: 'artmatic-plugin',
  apiVersion: 1,
  id: 'demo',
  name: 'Demo',
  effects: [],
};
`;

describe('checkPluginSource', () => {
  it('合法单文件 ESM 通过，并报出导出的 plugin', async () => {
    const r = await checkPluginSource(GOOD);
    expect(r.ok).toBe(true);
    expect(r.issues).toEqual([]);
    expect(r.exports).toContain('plugin');
    expect(r.lines).toBe(7);
  });

  it('语法错误给出行列与解析器消息（去掉尾部 (l:c)）', async () => {
    const r = await checkPluginSource(`${GOOD}\nconst x = ;\n`);
    expect(r.ok).toBe(false);
    const issue = r.issues[0]!;
    expect(issue.code).toBe('syntax');
    expect(issue.line).toBe(9);
    expect(issue.column).toBeGreaterThan(0);
    expect(issue.detail).toBeTruthy();
    expect(issue.detail).not.toMatch(/\(\d+:\d+\)$/);
  });

  it('import 一律报错：blob URL 里解析不了任何模块说明符', async () => {
    const r = await checkPluginSource(`import { x } from './helper.js';\n${GOOD}`);
    expect(r.ok).toBe(false);
    const issue = r.issues.find((i) => i.code === 'import');
    expect(issue?.line).toBe(1);
    expect(issue?.detail).toBe('./helper.js');
  });

  it('动态 import 也报（会去 blob 的子路径找模块）', async () => {
    const r = await checkPluginSource(`const later = () => import('./x.js');\n${GOOD}`);
    expect(r.ok).toBe(false);
    expect(r.issues.some((i) => i.code === 'dynamic-import')).toBe(true);
  });

  it('export … from 也是模块说明符，同样报 import', async () => {
    const r = await checkPluginSource(`export { helper } from './helper.js';\n${GOOD}`);
    expect(r.ok).toBe(false);
    expect(r.issues.some((i) => i.code === 'import' && i.detail === './helper.js')).toBe(true);
  });

  it('没有 plugin / default 导出 → no-export', async () => {
    const r = await checkPluginSource('export const notPlugin = 1;\n');
    expect(r.ok).toBe(false);
    expect(r.issues.map((i) => i.code)).toContain('no-export');
  });

  it('default 导出算合格的插件形态', async () => {
    const r = await checkPluginSource("export default { format: 'artmatic-plugin', id: 'x' };\n");
    expect(r.ok).toBe(true);
    expect(r.exports).toContain('default');
  });

  it('format 写成别的值 → bad-format，并带上那个值', async () => {
    const r = await checkPluginSource(GOOD.replace("'artmatic-plugin'", "'other'"));
    expect(r.ok).toBe(false);
    const issue = r.issues.find((i) => i.code === 'bad-format');
    expect(issue?.detail).toBe('other');
    expect(issue?.line).toBe(2);
  });

  it('清单是函数造出来的：不猜 format，不误报', async () => {
    const r = await checkPluginSource(
      "const make = () => ({ format: 'artmatic-plugin' });\nexport const plugin = make();\n",
    );
    expect(r.ok).toBe(true);
  });
});
