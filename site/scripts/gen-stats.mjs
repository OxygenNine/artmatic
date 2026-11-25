/**
 * gen-stats.mjs — 首页文案里的数字从这里来，不手写。
 *
 * 「81 个特效」这类数字写在文案里，加一个特效就变成谎话，而且没人会去改。
 * 这里每次 build 现数一遍，同时顺手校验首页文案里点名的工具与 id 还在
 * （那几个名字是硬编码的，改了就静默过期）。
 */
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { TRANSITIONS } from '../../src/effects/transitions/catalog.ts';

const repo = new URL('../../', import.meta.url);
const site = new URL('../', import.meta.url);
const fromRepo = (p) => fileURLToPath(new URL(p, repo));
const text = (p) => readFileSync(fromRepo(p), 'utf8');

/* ------------------------------------------------------------------ 特效 */
const effectDefs = readdirSync(fromRepo('src/effects/defs'))
  .filter((f) => f.endsWith('.ts'))
  .map((f) => f.replace(/\.ts$/, ''));

/* --------------------------------------------------------------- 生成器 */
/** 取 `ALGO_CATALOG` 对象的一级键。缩进的二级键不会命中 `^  `。 */
function algoCatalogKeys(src) {
  const at = src.indexOf('export const ALGO_CATALOG');
  if (at < 0) throw new Error('ALGO_CATALOG 不见了：src/algos/catalog.ts 的结构变了');
  const rest = src.slice(at);
  const end = rest.indexOf('\n};');
  if (end < 0) throw new Error('ALGO_CATALOG 的结尾 `};` 没找到');
  return [...rest.slice(0, end).matchAll(/^ {2}'?([a-z0-9-]+)'?:/gm)].map((m) => m[1]);
}

const generators = algoCatalogKeys(text('src/algos/catalog.ts'));

/* ------------------------------------------------------------- Agent 工具 */
const toolNames = [...text('src/agent/tools.ts').matchAll(/^ {4}name: '([a-z_]+)',$/gm)].map(
  (m) => m[1],
);

/* ------------------------------------------------------------- 一致性校验 */
const mustHave = [
  ['工具 set_generator', toolNames.includes('set_generator')],
  ['工具 add_effect_clip', toolNames.includes('add_effect_clip')],
  ['特效 pixel-sort', effectDefs.includes('pixel-sort')],
  ['生成器 lenia', generators.includes('lenia')],
];
const broken = mustHave.filter(([, ok]) => !ok).map(([name]) => name);
if (broken.length) {
  throw new Error(
    `首页文案引用的名字已不存在：${broken.join('、')}。\n` +
      '改 site/src/components/home/ 之前，先确认新的名字是真的。',
  );
}

/* ------------------------------------------------------------------ 输出 */
const appVersion = JSON.parse(text('package.json')).version;

const stats = {
  effects: effectDefs.length,
  generators: generators.length,
  transitions: TRANSITIONS.length,
  tools: toolNames.length,
  appVersion,
};

writeFileSync(
  fileURLToPath(new URL('src/data/stats.json', site)),
  `${JSON.stringify(stats, null, 2)}\n`,
);

console.log(
  `stats.json  特效 ${stats.effects} · 生成器 ${stats.generators} · ` +
    `转场 ${stats.transitions} · 工具 ${stats.tools} · v${appVersion}`,
);
