/**
 * hook-registry.ts — **插件对排版文档的钩子**（双层注册表：内置层为空 + 插件层）。
 *
 * 三个阶段：
 *  - `open`  ：读工程后、挂上选项卡之前。结果**只在内存**，绝不自动落盘。
 *  - `save`  ：写 `project.json` 之前，对**将要写盘的副本**跑，不改 store。
 *  - `render`：光栅化时、`buildDocDom` 之前。只作用于本次出图。
 *
 * 三条硬纪律（与 `plugins/host.ts` 的编译校验同构）：
 *  1. **失败保留原文档**。抛错、返回非对象、或结果里出现未知键（`coerceDocument`
 *     的 `droppedKeys`）都算失败 —— 「尽力而为写半截」会让工程再也打不开。
 *  2. **输入只读**。钩子拿到的是深拷贝 + `Object.freeze`，改它会抛（严格模式），
 *     而不是悄悄改掉 store 里那份。
 *  3. **问题用 code + detail 记录**，句子在 `i18n` 的 `pl.*`（这里不写文案）。
 *
 * 注册表是**进程级单例**，与 effects / algos 一样按 `pluginId` 整插件替换；
 * 引用计数与卸载时机由 `PluginHost` 负责（见 `plugins/host.ts`）。
 */

import type { Project } from '../core/schema';
import type { TypographyDocument } from './document';
import { coerceDocument } from './agent-ops';
import type { TypoHookContext, TypoHookDef, TypoHookPhase } from './hook-types';

export type { TypoHookContext, TypoHookDef, TypoHookPhase, TypoHookRun } from './hook-types';
export { TYPO_HOOK_PHASES } from './hook-types';

export interface RegisteredTypoHook {
  /** 对外 id：`${pluginId}/${localId}`（与 effects / generators 同一约定）。 */
  key: string;
  pluginId: string;
  def: TypoHookDef;
}

export interface TypoHookFailure {
  key: string;
  phase: TypoHookPhase;
  /** 非文案细节：`throw: …` / `not-object` / `unknown-keys:elements[2].colour` */
  detail: string;
  repeats: number;
  at: number;
}

const byPlugin = new Map<string, RegisteredTypoHook[]>();
const failures = new Map<string, TypoHookFailure>();
const MAX_FAILURES = 32;
let rev = 0;
const listeners = new Set<() => void>();

function bump(): void {
  rev++;
  for (const fn of [...listeners]) fn();
}

export function hookRegistryRevision(): number {
  return rev;
}

export function subscribeHookRegistry(fn: () => void): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

/** 整插件替换语义：同一个 pluginId 再注册一次 = 用新的清单覆盖旧的。 */
export function registerPluginTypoHooks(
  pluginId: string,
  defs: readonly TypoHookDef[],
): RegisteredTypoHook[] {
  const list = defs.map((def) => ({ key: `${pluginId}/${def.id}`, pluginId, def }));
  byPlugin.set(pluginId, list);
  bump();
  return list;
}

export function unregisterPluginTypoHooks(pluginId: string): void {
  if (!byPlugin.delete(pluginId)) return;
  for (const key of [...failures.keys()]) {
    if (key.startsWith(`${pluginId}/`)) failures.delete(key);
  }
  bump();
}

export function listTypoHooks(phase?: TypoHookPhase): RegisteredTypoHook[] {
  const out: RegisteredTypoHook[] = [];
  for (const list of byPlugin.values()) {
    for (const h of list) if (!phase || h.def.phase === phase) out.push(h);
  }
  return out;
}

/** 有没有启用中的渲染钩子（缓存键要据此走逐帧模式）。 */
export function hasRenderTypoHooks(): boolean {
  return listTypoHooks('render').length > 0;
}

export function typoHookFailures(pluginId?: string): TypoHookFailure[] {
  const out: TypoHookFailure[] = [];
  for (const [key, f] of failures) {
    if (!pluginId || key.startsWith(`${pluginId}/`)) out.push(f);
  }
  return out;
}

export function clearTypoHookFailures(pluginId?: string): void {
  if (!pluginId) {
    if (failures.size === 0) return;
    failures.clear();
    bump();
    return;
  }
  let changed = false;
  for (const key of [...failures.keys()]) {
    if (key.startsWith(`${pluginId}/`)) {
      failures.delete(key);
      changed = true;
    }
  }
  if (changed) bump();
}

function noteFailure(key: string, phase: TypoHookPhase, detail: string): void {
  const prev = failures.get(key);
  failures.set(key, {
    key,
    phase,
    detail,
    repeats: prev && prev.detail === detail ? prev.repeats + 1 : 1,
    at: Date.now(),
  });
  if (failures.size > MAX_FAILURES) {
    const first = failures.keys().next().value;
    if (first !== undefined) failures.delete(first);
  }
  if (!prev || prev.detail !== detail) bump();
}

/** 深拷贝 + 冻结：钩子改输入会抛，而不是静默改掉 store 里那份。 */
function frozenCopy(doc: TypographyDocument): TypographyDocument {
  const copy =
    typeof structuredClone === 'function'
      ? structuredClone(doc)
      : (JSON.parse(JSON.stringify(doc)) as TypographyDocument);
  return deepFreeze(copy);
}

/** 校验期用：给钩子一份与运行期同形态的只读输入（`PluginHost.verify`）。 */
export function frozenHookInput(doc: TypographyDocument): TypographyDocument {
  return frozenCopy(doc);
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const v of Object.values(value as Record<string, unknown>)) deepFreeze(v);
  }
  return value;
}

export interface HookRunResult {
  doc: TypographyDocument;
  /** 真正改写了文档的钩子数。 */
  applied: number;
  failures: { key: string; detail: string }[];
}

/**
 * 依次跑某一阶段的全部钩子。
 *
 * 每个钩子看到的是**上一个钩子的输出**（顺序即注册顺序 = 插件加载顺序），
 * 与 `doc.scripts` 的「数组顺序即语义」同一套思路。
 */
export function runTypoHooks(
  phase: TypoHookPhase,
  doc: TypographyDocument,
  ctx: Omit<TypoHookContext, 'phase'>,
): HookRunResult {
  const hooks = listTypoHooks(phase);
  if (!hooks.length) return { doc, applied: 0, failures: [] };

  let current = doc;
  let applied = 0;
  const failed: { key: string; detail: string }[] = [];

  for (const hook of hooks) {
    let out: unknown;
    try {
      out = hook.def.run(frozenCopy(current), { ...ctx, phase });
    } catch (err) {
      const detail = `throw: ${err instanceof Error ? err.message : String(err)}`;
      noteFailure(hook.key, phase, detail);
      failed.push({ key: hook.key, detail });
      continue;
    }
    if (out === undefined || out === null) continue;
    if (
      typeof out !== 'object' ||
      Array.isArray(out) ||
      typeof (out as { then?: unknown }).then === 'function'
    ) {
      // Promise 也归这一类：钩子必须是同步的（渲染路径没有 await 它的位置）。
      const detail = 'not-object';
      noteFailure(hook.key, phase, detail);
      failed.push({ key: hook.key, detail });
      continue;
    }
    const report = { droppedKeys: [] as string[], droppedAnimations: [] as string[] };
    const next = coerceDocument(out, current, report);
    if (report.droppedKeys.length > 0 || report.droppedAnimations.length > 0) {
      // 未知键 = 插件在写一份宿主不认识的文档。宁可整条拒绝，也不写半截。
      const detail = `unknown-keys:${report.droppedKeys.concat(report.droppedAnimations).join(',')}`;
      noteFailure(hook.key, phase, detail);
      failed.push({ key: hook.key, detail });
      continue;
    }
    current = next;
    applied++;
    failures.delete(hook.key);
  }

  if (applied > 0) bump();
  return { doc: current, applied, failures: failed };
}

export interface ProjectHookResult {
  /** 钩子改写之后的工程副本（没有钩子时就是原对象）。 */
  project: Project;
  /** 真正改写了文档的钩子次数。 */
  appliedHooks: number;
  /** 被改写的文本片段数。 */
  changedClips: number;
  failures: { key: string; detail: string }[];
}

/**
 * 对整个工程里的**文本片段**跑某一阶段的钩子。
 *
 * - `open`：直接改传进来的工程对象（它还没进 store）；
 * - `save`：**先深拷贝**再改 —— 落盘的是一份被插件规范化的副本，
 *   store 里用户看到的仍是原样。写盘之后 `savedDocVersion` 才会对上，
 *   所以这份差异不会被误报成「未保存的改动」。
 */
export function runProjectDocHooks(
  project: Project,
  phase: 'open' | 'save',
  ctx: { seed: number },
): ProjectHookResult {
  if (!listTypoHooks(phase).length) {
    return { project, appliedHooks: 0, changedClips: 0, failures: [] };
  }
  const copy =
    phase === 'save'
      ? typeof structuredClone === 'function'
        ? structuredClone(project)
        : (JSON.parse(JSON.stringify(project)) as Project)
      : project;

  let appliedHooks = 0;
  let changedClips = 0;
  const failures: { key: string; detail: string }[] = [];
  for (const track of copy.tracks) {
    for (const clip of track.clips) {
      if (clip.kind !== 'source' || clip.source.type !== 'text') continue;
      const before = clip.source.doc;
      const r = runTypoHooks(phase, before, { seed: ctx.seed, clipId: clip.id });
      if (r.applied > 0 && r.doc !== before) {
        clip.source.doc = r.doc;
        appliedHooks += r.applied;
        changedClips++;
      }
      failures.push(...r.failures);
    }
  }
  return { project: copy, appliedHooks, changedClips, failures };
}

/** 测试钩子。 */
export function resetTypoHookRegistry(): void {
  byPlugin.clear();
  failures.clear();
  bump();
}
