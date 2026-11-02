/**
 * grade-session.ts — 调色页的读写入口（不是组件状态，全部读 `appState`）。
 *
 * 页面被拆成几块（侧栏 / 底部面板 / 右栏码头），它们都要「往链上某个实例写一个
 * 参数」。把这几步收在这里，而不是每块各写一遍 `store.updateClip`：
 * 事务边界（一次拖动 = 一条撤销）是这个功能最容易写错的地方，重复三份就一定
 * 有一份忘了 `endTx`。
 *
 * 约定：调用方负责在自己的 `$derived.by` 里 `void appState.version`。
 * 这里的函数只读一次性快照，不建立订阅。
 */

import type { EffectClip, EffectInstance } from '../../core/schema';
import { newId } from '../../core/schema';
import { defaultEffectValues } from '../../effects/registry';
import { tr } from '../../i18n/index.svelte';
import { appState } from '../app-state.svelte';
import { resetBasic } from './grade-ops';

/** 正在调色的片段（不在调色页 / 片段没了 → null）。 */
export function gradeClip(): EffectClip | null {
  const id = appState.gradeClipId;
  if (!id) return null;
  const found = appState.store.findClip(id);
  return found && found.clip.kind === 'effect' ? found.clip : null;
}

/**
 * 往某个实例写参数。
 *
 * **写入端必须自己指名实例**，不要在这里推断「当前模块」。
 * 曾经有一个 `write()`（= 写 `appState.gradeInstanceId` 指向的那个，缺省链上第一个
 * `grade-*`），而面板展示的却是「链上第一个 `grade-basic`」：点过「加上曲线」之后
 * `gradeInstanceId` 变成曲线模块，于是五个滑杆与数字框把 `contrast/saturation/...`
 * 写进了那个**没有这些参数**的实例 —— 把手不动、画面不动、不报错，离开页面再进来
 * 又好了（`openGradeEditor` 会把选中重置成链上第一个调色模块）。这就是「偶发的
 * 滑块无响应」。谁展示，谁写入：色轮 / 曲线 / 查找表本来就是这个写法。
 *
 * 拖动期间每帧调用：不在事务里就先开一个，于是**一次拖动 = 一条撤销**。
 * 手势结束由 `commit` 收口。
 */
export function writeOn(instanceId: string, mutate: (inst: EffectInstance) => void): void {
  const clip = gradeClip();
  if (!clip) return;
  const store = appState.store;
  if (!store.inTx) store.beginTx();
  store.updateClip(clip.id, tr('insp.editEffectParam'), (c) => {
    if (c.kind !== 'effect') return;
    const target = c.chain.find((i) => i.instanceId === instanceId);
    if (target) mutate(target);
  });
}

export function commit(): void {
  const store = appState.store;
  if (store.inTx) store.endTx(tr('insp.editEffectParam'));
}

/** 往链尾追加一个调色模块（同一笔撤销，与检查器的「添加特效」一致）。 */
export function addModule(defId: string): string {
  const clip = gradeClip();
  const inst = { instanceId: newId(), defId, enabled: true, values: defaultEffectValues(defId) };
  if (clip) {
    appState.store.updateClip(clip.id, tr('insp.addEffect'), (c) => {
      if (c.kind === 'effect') c.chain.push(inst);
    });
  }
  appState.gradeInstanceId = inst.instanceId;
  return inst.instanceId;
}

/** 「全部复位」：轮盘与五个滑杆一起回默认值（一笔撤销）。实例由调用方指名。 */
export function resetAllWheels(inst: EffectInstance): void {
  if (inst.defId !== 'grade-basic') return;
  writeOn(inst.instanceId, (it) => resetBasic(it));
  commit();
}

/** 这个实例是不是 `grade-basic`（面板按 defId 决定画什么）。 */
export function isBasic(inst: EffectInstance): boolean {
  return inst.defId === 'grade-basic';
}
