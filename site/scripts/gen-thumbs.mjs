/**
 * gen-thumbs.mjs — 把首页特效区要用的缩略图从主工程搬进 site。
 *
 * 官网是独立 workspace，不能 import `src/assets`；而「官网展示的不是真特效」比
 * 没有缩略图更糟。所以构建前复制一份真图，缺失就硬失败（不静默跳过）。
 * 产物在 .gitignore 里，`pnpm run gen` 每次重算。
 */
import { copyFileSync, existsSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const repo = new URL('../../', import.meta.url);
const src = (p) => fileURLToPath(new URL(`src/assets/${p}`, repo));
const out = fileURLToPath(new URL('../src/assets/thumbs/', import.meta.url));

const EFFECTS = [
  'slices',
  'rgb-burst',
  'data-bend',
  'channel-split',
  'liquid-light',
  'flow-contours',
  'grade-basic',
  'pixel-sort',
  'vhs',
  'halftone',
  'scanlines',
  'kaleido',
  'melt',
  'tile-shuffle',
  'echo',
  'glow',
  'thermal',
  'ascii',
  'polar',
  'mirror',
  'strobe',
  'tunnel',
  'swirl',
  'vignette',
  'soft-glitch',
  'jitter',
  'resize-glitch',
  'petri',
];

const GEN = [
  'black-hole-three',
  'mandelbrot',
  'mandelbulb',
  'fluid',
  'lenia',
  'reaction-diffusion',
  'game-of-life',
  'apollonian',
  'bifurcation',
  'lyapunov',
  'kleinian',
  'noise-field',
  'streamlines',
  'volumetric-cloud',
  'tunnel-3d',
  'polyhedron',
];

mkdirSync(out, { recursive: true });

const missing = [];
for (const [kind, list] of [
  ['fx', EFFECTS],
  ['gen', GEN],
]) {
  for (const id of list) {
    const from = src(`${kind === 'fx' ? 'effect' : 'algo'}-thumbnails/${id}.webp`);
    if (!existsSync(from)) {
      missing.push(`${kind}:${id}`);
      continue;
    }
    copyFileSync(from, `${out}${kind}-${id}.webp`);
  }
}

if (missing.length) {
  throw new Error(`缩略图不存在：${missing.join('、')}\n改 site/scripts/gen-thumbs.mjs 的清单。`);
}

console.log(`thumbs: ${EFFECTS.length + GEN.length}`);
