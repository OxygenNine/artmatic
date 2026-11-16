/**
 * open-progress.ts — 「正在打开工程」进度条上的那个数（纯函数）。
 *
 * 分出来是为了能被单测钉住：进度条最典型的 bug 是**倒着走**（阶段换了、
 * 权重表少一项、`total` 清零时把比值算成 1），而它在界面上的表现只是
 * "条子抖了一下"，没人会在 E2E 里断言。
 */

import type { OpenProgress, OpenStep } from './app-state.svelte';

/**
 * 各阶段在整条进度里的占比。
 *
 * 是**粗估**，不追求与实际耗时成比例 —— 素材那一段本来就占九成，按真实比例
 * 画的话前三步会像没动。作用只有一件：让前三步也有可见的推进。
 */
export const OPEN_STEP_WEIGHT: Record<OpenStep, number> = {
  read: 0.18,
  plugins: 0.1,
  assets: 0.62,
  finalize: 0.1,
};

/** 阶段顺序。权重按它累加成「这一阶段的起点」。 */
export const OPEN_STEP_ORDER: OpenStep[] = ['read', 'plugins', 'assets', 'finalize'];

/**
 * 0..100 的百分比。
 *
 * `total === 0` 表示这一阶段还没有件数（还没数出来 / 本来就没有），此时停在
 * 阶段起点 —— **不许**把它当成「1/1 完成」，否则每换一个阶段条子就先跳满。
 */
export function openProgressPercent(p: OpenProgress | null): number {
  if (!p) return 0;
  let base = 0;
  for (const step of OPEN_STEP_ORDER) {
    if (step === p.step) break;
    base += OPEN_STEP_WEIGHT[step];
  }
  const within = p.total > 0 ? Math.min(1, Math.max(0, p.done / p.total)) : 0;
  return Math.min(100, (base + OPEN_STEP_WEIGHT[p.step] * within) * 100);
}
