/**
 * clip-label.ts — 生成器片段的**默认显示名**，与「换算法之后该叫什么」。
 *
 * 为什么单独一个文件：`label === 默认名` 是「用户没改过名」的唯一判据，而
 * 默认名必须在**建片段的地方**与**换生成器的地方**取到同一个值。两处各写
 * 一份内联的 `resolveLabel(def.nameKey, tr)` 时，任何一处漂移的表现都是
 * 「换了算法名字不跟着变」—— 不报错、也没人会发现，直到用户自己去改名。
 *
 * 调用点：`ui/Inspector.svelte::changeAlgo`（点选器）与
 * `agent/control-plane.ts::setGenerator`（`set_generator` 工具）。
 */

import { resolveLabel, type Translate } from '../i18n/label';
import { getGenerator } from './registry';

/**
 * 生成器片段的默认名（= 新建片段时写进 `label` 的那个）。
 *
 * `genId` 找不到 def（插件被卸载、手改过的工程）时退回 id 本身：与 `tr` 的
 * 兜底语义一致，宁可显示 id 也不要空串。
 */
export function defaultAlgoLabel(genId: string, tr: Translate): string {
  const def = getGenerator(genId);
  return def ? resolveLabel(def.nameKey, tr) : genId;
}

/**
 * 这个 label 还停在默认名上吗（= 用户没改过名）。
 *
 * 认两种「默认」：**当前语言下的译名**与**生成器 id 本身**。后者是 agent 建片段
 * 时写的（`agent/clip-factory.ts::defaultLabel` 刻意不给模型塞译文），不认它的话
 * agent 建的片段永远被当成「改过名」。
 *
 * 语言切换（工程在英文下建、现在用中文打开）会让译名对不上，于是判成「改过名」
 * —— 这是刻意的：没把握时**不要**覆盖用户起的名字，代价只是那一次不自动改名。
 */
export function isDefaultAlgoLabel(genId: string, label: string, tr: Translate): boolean {
  return label === genId || label === defaultAlgoLabel(genId, tr);
}

/**
 * 换生成器之后片段该叫什么：**默认名跟着换，用户改过的名字原样保留**。
 *
 * 旧名不再是默认名（= 用户改过）时返回原值，调用方写回去等于什么都没做 ——
 * 这样两个调用点都不需要自己写分支。
 */
export function labelAfterGeneratorChange(
  oldGenerator: string,
  label: string,
  nextGenerator: string,
  tr: Translate,
): string {
  return isDefaultAlgoLabel(oldGenerator, label, tr) ? defaultAlgoLabel(nextGenerator, tr) : label;
}
