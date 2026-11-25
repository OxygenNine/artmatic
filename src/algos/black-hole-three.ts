/**
 * black-hole-three.ts — 黑洞 · 引力透镜（three 版，`kind:'three'`）。
 *
 * 代码就是那个文件里的全部内容（`three-programs/black-hole.js`，原始文本导入），
 * 参数表由它的 `params()` 派生 —— 这个 def 只负责把「叫什么、算哪一类」补齐。
 *
 * ## 为什么是新 id 而不是覆盖 `black-hole`
 *
 * 老工程里写着 `generator: 'black-hole'`（SDF 版）。覆盖它等于让那些工程
 * 换一种画面，而用户什么都没做。所以 SDF 版原地归档（`archived: true`），
 * 新 id 走新实现 —— 「归档」这个词的全部含义就在这里。
 *
 * ## 参数默认值
 *
 * 用的是 `2027 新春会/artmatic-programs/three-js-test` 里那条片段调好的那一组，
 * 不是 `params()` 最初写的那组。开箱就该是那张图。
 */

import type { GeneratorDef } from './types';
import { defineThreeGenerator } from './three-generator';
import BLACK_HOLE_CODE from './three-programs/black-hole.js?raw';

export const blackHoleThreeDef: GeneratorDef = defineThreeGenerator({
  id: 'black-hole-three',
  nameKey: 'algo.blackHole',
  code: BLACK_HOLE_CODE,
});
