import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * `SCHEMA_VERSION` 的**写法**守卫 —— 纪律见 `src/core/AGENTS.md` 的
 * 「`SCHEMA_VERSION` 与迁移链」。
 *
 * 三条判据的共同点是：**写错了不会有任何测试变红，只会让人按过期的地图改代码**。
 *
 * 1. 值的**定义**只有一处（`src/core/schema.ts`）。别处出现 `SCHEMA_VERSION = 5`
 *    这种形态，就是在冒充「当前版本」—— 句子写完当天就开始过期。
 * 2. 源码里的 `schemaVersion: 22` 只能出现在 `src/core/schema.ts`（迁移的落款）。
 *    别处写字面量意味着有条路径绕过了迁移链或版本检查。
 * 3. 测试不许「断言这个常量等于某个数字」：它不保护任何行为，只在抬版本时变红。
 *    要钉迁移行为，链条形状由 `schema.test.ts` 的用例守。
 *
 * **只扫代码（`.ts` / `.svelte` / `.mjs`），不扫 `.md`**：文档里「举一条过期写法的
 * 反例」与「真心写过期的值」在文本上一模一样，正则分不开 —— 与其造一个会误报的
 * 守卫，不如把「文档里不许写『目前 SCHEMA_VERSION = N』」留在 AGENTS 里当人工纪律。
 *
 * 不受影响的是**历史锚点**：`MIGRATIONS` 的键、测试里「造一个 v20 工程」、
 * 注释里的「v7 → v8」—— 匹配的是带等号 / 冒号的赋值形态，不是 `vN` 这种叙述。
 */

const ROOT = process.cwd();
const DIRS = ['src', 'tests', 'lab', 'cli', 'mcp'];
const EXT = ['.ts', '.svelte', '.mjs'];
/** 唯一允许写版本字面量的文件：常量定义 + 迁移链落款。POSIX 斜杠，与 `rel()` 同口径。 */
const OWNER = 'src/core/schema.ts';
/** 本文件自己要举反例（`SCHEMA_VERSION = 22;`），不豁免就没法写。 */
const SELF = 'tests/unit/schema-version-discipline.test.ts';

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (EXT.some((e) => name.endsWith(e))) out.push(p);
  }
  return out;
}

const files = DIRS.flatMap((d) => walk(join(ROOT, d)));
const rel = (p: string) => p.slice(ROOT.length + 1).split('\\').join('/');

/** 逐行匹配，报出 `path:line 内容`，方便直接跳过去。 */
function offenders(pattern: RegExp, allowed: string[] = []): string[] {
  const out: string[] = [];
  for (const file of files) {
    const r = rel(file);
    if (allowed.includes(r)) continue;
    const lines = readFileSync(file, 'utf8').split(/\r?\n/);
    for (const [i, line] of lines.entries()) {
      if (pattern.test(line)) out.push(`${r}:${i + 1} ${line.trim()}`);
    }
  }
  return out;
}

describe('SCHEMA_VERSION：只在 core/schema.ts 里定值', () => {
  it('扫到的文件数是个像样的数（防止路径写错变成空跑）', () => {
    expect(files.length).toBeGreaterThan(300);
  });

  it('没有别处写 `SCHEMA_VERSION = <数字>`', () => {
    expect(
      offenders(/SCHEMA_VERSION\s*=\s*\d/, [OWNER, SELF]),
      '要写「当前版本」就引用常量；历史锚点请写「vN 引入」或「vN → vN+1」',
    ).toEqual([]);
  });

  it('源码里的 schemaVersion 字面量只出现在迁移链里', () => {
    const bad = offenders(/schemaVersion\s*:\s*\d/, [OWNER]).filter((l) => l.startsWith('src/'));
    expect(bad, '任何构造 / 写入 Project 的地方都必须用 SCHEMA_VERSION 或走迁移').toEqual([]);
  });

  it('测试不断言常量的具体数值', () => {
    const bad = offenders(/expect\(\s*SCHEMA_VERSION\s*\)\s*\.to(Be|Equal)\(/).filter((l) =>
      l.startsWith('tests/'),
    );
    expect(bad, '要钉的是迁移行为，不是常量值 —— 见 schema.test.ts 的「迁移链连续」').toEqual([]);
  });
});
