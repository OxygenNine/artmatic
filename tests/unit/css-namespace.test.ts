import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * CSS 命名空间守卫。
 *
 * `src/app.css` 与 `src/ui/controls/controls.css` 是**全局**样式表（main.ts 直接
 * import）。Svelte 组件的 `<style>` 是 scoped 的，所以组件自己的规则不会外泄 ——
 * 但反过来成立：**组件里用的类名会被全局规则命中**。
 *
 * 踩过的真事：排版画布的选中框用了 `class="sel"`，而 `controls.css` 里 `.sel` 是
 * Select 控件的类名（`background: var(--input-bg)` + 1px 边框）。我的 scoped 规则
 * 只声明了 `outline`，背景没被覆盖，于是**选中框变成一个不透明白块，把图形整个盖住**。
 * 同样的问题还有 `.swatch`（Ribbon 色块 ↔ 全局 swatch）。
 *
 * 这类 bug 肉眼要等到某个元素正好被选中才出现，控制台没有任何提示。所以在这里
 * 用一条测试钉死：排版/Ribbon 组件里不许出现全局类名。
 */

const ROOT = process.cwd();
const GLOBAL_CSS = ['src/app.css', 'src/ui/controls/controls.css'];
/** 只扫新写的这几块；controls/ 自己就是全局类的**定义方**，不适用。 */
const SCANNED_DIRS = [
  'src/ui/typography',
  'src/ui/ribbon',
  'src/ui/effect-picker',
  'src/ui/algo-picker',
  'src/ui/mascot',
  'src/ui/pattern',
  'src/ui/agent',
  'src/ui/grade',
  'lab',
];

/**
 * **刻意**复用全局类的白名单：`相对路径 → [类名]`。
 *
 * 默认禁止是为了防「不小心继承到不该有的背景/边框」——那种碰撞是静默的，
 * 只有肉眼看到某个元素莫名其妙变样才会发现。但**刻意**复用是另一回事：
 * 它是「只留一份真源」的手段。
 *
 * 现在唯一的条目是试炼场的 rail 入口：硬要求是「rail 在每个界面都一致」，
 * 而 `.ic-btn` 就是 rail 图标尺寸/颜色/hover 的真源。不让它复用的话，
 * 只能把那五六条声明抄一份到 lab —— 那正是「两个真源」，
 * 将来改主应用的图标规格就会漏掉 lab。
 *
 * 加条目时必须写清理由，并且确认过：被复用的类只含**叶子级**声明
 * （尺寸/颜色/hover），不含容器类的背景与边框。
 */
const ALLOWED_REUSE: Record<string, string[]> = {
  'lab/LabRail.svelte': ['ic-btn'],
  // 与试炼场的 rail 同一套图标按钮：复用叶子级声明（尺寸 / 颜色 / hover），
  // 不含容器背景与边框。各写一份的下场是两处 rail 的图标大小迟早不一致。
  'src/ui/agent/AgentRailButton.svelte': ['ic-btn'],
};

function globalClassNames(): Set<string> {
  const out = new Set<string>();
  for (const rel of GLOBAL_CSS) {
    const css = readFileSync(join(ROOT, rel), 'utf8');
    for (const m of css.matchAll(/\.([a-z][a-z0-9-]*)/g)) out.add(m[1]!);
  }
  return out;
}

function collectSvelte(dir: string): string[] {
  const abs = join(ROOT, dir);
  const out: string[] = [];
  for (const entry of readdirSync(abs)) {
    const p = join(abs, entry);
    if (statSync(p).isDirectory()) out.push(...collectSvelte(join(dir, entry)));
    else if (entry.endsWith('.svelte')) out.push(p);
  }
  return out;
}

/** 文件里实际写进 `class=` / `class:xxx` 的类名。 */
function usedClassNames(file: string): Set<string> {
  // 先把 `{表达式}` 挖掉：`class="handle {h}"` 里的 `{h}` 是动态朝向类，
  // 不属于静态命名，挖掉之后仍然能捕到 `handle`。
  const src = readFileSync(file, 'utf8').replace(/\{[^{}]*\}/g, ' ');
  const names = new Set<string>();
  for (const m of src.matchAll(/class="([^"]*)"/g)) {
    for (const n of m[1]!.trim().split(/\s+/)) if (n) names.add(n);
  }
  for (const m of src.matchAll(/class:([a-z][a-z0-9-]*)/g)) names.add(m[1]!);
  return names;
}

describe('CSS 命名空间', () => {
  it('全局样式表能解析出类名（守住这个测试本身的有效性）', () => {
    const globals = globalClassNames();
    // 抽查几个已知的全局类，防止正则写歪之后「全绿」变成假绿
    expect(globals.has('sel')).toBe(true);
    expect(globals.has('swatch')).toBe(true);
    expect(globals.has('btn')).toBe(true);
    expect(globals.has('menu-item')).toBe(true);
    expect(globals.size).toBeGreaterThan(20);
  });

  it('排版 / Ribbon / 试炼场组件不使用任何全局类名', () => {
    const globals = globalClassNames();
    const clashes: string[] = [];
    for (const dir of SCANNED_DIRS) {
      for (const file of collectSvelte(dir)) {
        const rel = file.replace(ROOT, '').replace(/\\/g, '/').replace(/^\//, '');
        const allowed = new Set(ALLOWED_REUSE[rel] ?? []);
        for (const name of usedClassNames(file)) {
          if (globals.has(name) && !allowed.has(name)) {
            clashes.push(`/${rel} → .${name}`);
          }
        }
      }
    }
    expect(
      clashes,
      '这些类名与全局样式表撞车，会继承到不该有的背景/边框。加前缀改名（如 .sel → .typo-sel）；\n' +
        '确实是**刻意**复用的，加进本文件的 ALLOWED_REUSE 并写明理由。',
    ).toEqual([]);
  });

  it('白名单里的条目确实还在用（过期条目要删掉，否则会掩盖回归）', () => {
    const byRel = new Map<string, Set<string>>();
    for (const dir of SCANNED_DIRS) {
      for (const file of collectSvelte(dir)) {
        const rel = file.replace(ROOT, '').replace(/\\/g, '/').replace(/^\//, '');
        byRel.set(rel, usedClassNames(file));
      }
    }
    for (const [rel, names] of Object.entries(ALLOWED_REUSE)) {
      const used = byRel.get(rel);
      expect(used, `白名单里的 ${rel} 不存在了`).toBeTruthy();
      for (const n of names) {
        expect(used!.has(n), `${rel} 里已经不用 .${n} 了，把它从 ALLOWED_REUSE 删掉`).toBe(true);
      }
    }
  });

  it('扫描器确实能读到类名（否则上一条是空断言）', () => {
    const all = collectSvelte(SCANNED_DIRS[0]!).flatMap((f) => [...usedClassNames(f)]);
    expect(all).toContain('typo-sel'); // TypographyEditor 的选中框
    expect(all.length).toBeGreaterThan(10);
  });
});
