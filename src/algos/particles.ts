/**
 * particles.ts — 内置「粒子」生成器。
 *
 * 这一层**只有一份 spec**：参数表、GLSL、确定性纪律、复用 API 全在
 * `algos/particles/`。之后需要粒子效果的生成器不复制本文件，
 * 而是调 `createParticleGenerator({ id, nameKey, ... })`。
 *
 * 遵守跨项纪律：`registry.ts` + `catalog.ts` + i18n + 缩略图四处同改。
 */

import type { GeneratorDef } from './types';
import { createParticleGenerator } from './particles/index';

export const particlesDef: GeneratorDef = createParticleGenerator({
  id: 'particles',
  nameKey: 'algo.particles',
});
