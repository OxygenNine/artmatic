/**
 * three-source.ts — 把 `kind:'three'` 生成器接成一次普通的 three 解析。
 *
 * `algos/` 不认识 three，`three/` 也不认识算法生成器；两边在装配层（`render/`）
 * 会合。这个文件就是那道缝合线，只有几行，但它存在的理由是**三个消费方**
 * （主链 / 回放 / 烘焙面）都要接同一条缝，而它们各自绑了一份 three 运行时 ——
 * 谁抄一遍这段「造一个临时片段」的逻辑，谁就会在某一处漏掉字段。
 *
 * ## 为什么造一个临时 SourceClip 而不是给 `bind()` 加参数
 *
 * three 运行时按 `clip.id` 缓存实例、按 `clip.start` 换算片段内秒、按
 * `clip.source.params` 取参数值。这三件事都要求「它看起来就是那条片段」。
 * 加一条平行的入参路径等于让 `bind()` 里每个 `clip.source.xxx` 都变成二选一，
 * 而漏掉任何一处都不会报错（最典型的是 `clip.start` 漏了 —— 生成器片段的
 * `update(t)` 会拿到绝对秒，动画整体偏移）。
 *
 * 参数**已经求值过**（`AlgoRuntime.evalParams`，含关键帧 / 调制），这里不再
 * 合并默认值：两套求值规则就是两个答案。
 */

import type { SourceClip } from '../core/schema';
import type { SourceTexture } from '../engine/compositor';
import type { ThreeSourceProvider } from '../algos/types';
import type { ThreeResolver } from '../three/runtime';

/**
 * `ThreeResolver` → `ThreeSourceProvider`。
 *
 * `resolve` 为空（那台运行时还没建好）时恒返回 null —— 与「这一帧没有画面」
 * 同一条语义，调用方不需要判空。
 */
export function threeGeneratorProvider(resolve: ThreeResolver | null | undefined): ThreeSourceProvider {
  return (
    clip: SourceClip,
    code: string,
    params: Record<string, number | string>,
    t: number,
    frame: number,
  ): SourceTexture | null => {
    if (!resolve) return null;
    // 只换 source：id / start / end 是实例缓存与时间换算的依据，必须保留。
    const asThree: SourceClip = { ...clip, source: { type: 'three', code, params } };
    return resolve(asThree, t, frame);
  };
}
