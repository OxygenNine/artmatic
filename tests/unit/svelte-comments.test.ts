import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * 模板注释守卫。
 *
 * HTML 注释由**第一个** `-->` 闭合，里面再写一次 `-->` 就等于提前收尾，
 * 后半句会原样变成正文。真事：检查器为了让注释说明「注释用尖括号写」，
 * 在注释里写了那对尖括号，于是「渐变」那一行的输入框底下多出一行
 * 「注释写法在这里也是必须的。-->」，而 Svelte 编译零警告。
 *
 * 判据用**成对计数**而不是「不许出现 `-->`」：正常注释本来就以它收尾，
 * 唯一能以零成本分辨的形态就是「开符比闭符少」。少一个开符/多一个闭符
 * 两种写错都会被抓到，而正确的注释不受影响。
 *
 * 只扫 `<script>` 之外的部分：字符串里出现 `<!--` 是合法的（本仓库有
 * 生成 HTML 的代码）。
 */
const ROOT = process.cwd();
const DIRS = ['src', 'lab'];

function svelteFiles(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) svelteFiles(p, out);
    else if (name.endsWith('.svelte')) out.push(p);
  }
  return out;
}

/** 去掉 `<script>` / `<style>` 段，只留模板。 */
function templateOf(source: string): string {
  return source
    .replace(/<script[\s\S]*?<\/script>/g, '')
    .replace(/<style[\s\S]*?<\/style>/g, '');
}

describe('模板注释：开符与闭符成对', () => {
  const files = DIRS.flatMap((d) => svelteFiles(join(ROOT, d)));

  it('扫到的文件数是个像样的数（防止路径写错变成空跑）', () => {
    expect(files.length).toBeGreaterThan(40);
  });

  it('每个 .svelte 的模板里 `<!--` 与 `-->` 数量相等', () => {
    const bad: string[] = [];
    for (const file of files) {
      const tpl = templateOf(readFileSync(file, 'utf8'));
      const open = tpl.split('<!--').length - 1;
      const close = tpl.split('-->').length - 1;
      if (open !== close) bad.push(`${file.slice(ROOT.length + 1)}: <!-- ×${open} --> ×${close}`);
    }
    expect(bad, '注释被提前闭合 ⇒ 后半句会渲染成正文').toEqual([]);
  });
});
