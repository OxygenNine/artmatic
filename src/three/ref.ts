/**
 * three/ref.ts — 「这段代码从哪来」的**唯一一处判定**。
 *
 * 一个 three 片段有两种来源：自带内联代码，或引用插件提供的程序（`source.ref`）。
 * 渲染、检查器、控制平面三条路都要回答同一个问题，所以判定收在这里 ——
 * 各判一次的表现是「预览里是新代码、参数面板还是旧那张表」。
 *
 * 解析不到就返回 `null`（插件没装 / 被停用 / 程序被删）。调用方一律按
 * 「这一层不出图」处理，**不要**在这里抛：一条引用了缺失插件的片段不该让
 * 整个工程打不开。
 */

import type { ThreeSource } from '../core/schema';

export interface ThreeRef {
  plugin: string;
  name: string;
}

/** 插件代码的解析口。宿主侧实现是 `PluginHost.threeCode`。 */
export type ThreeCodeResolver = (ref: ThreeRef) => string | null;

/** 这一条片段是不是引用插件。 */
export function threeRefOf(source: ThreeSource): ThreeRef | null {
  const ref = source.ref;
  return ref && ref.plugin && ref.name ? ref : null;
}

/**
 * 取到这一条片段此刻该用的代码。
 *
 * 内联优先于引用只是**兜底顺序**，不是语义：`validateProject` 已经保证两者
 * 只存在一个（同时写出时以引用为准、删掉内联）。
 */
export function resolveThreeCode(
  source: ThreeSource,
  resolve: ThreeCodeResolver | null | undefined,
): string | null {
  const ref = threeRefOf(source);
  if (ref) return resolve ? resolve(ref) : null;
  return typeof source.code === 'string' ? source.code : null;
}
