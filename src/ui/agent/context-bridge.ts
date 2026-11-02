/**
 * context-bridge.ts — 界面状态 → Agent 上下文的两座桥。
 *
 *  1. **用户标注**（右键「添加进上下文」）：`clipContextRefs` / `elementContextRefs`
 *     把 id 与显示名一起取出来，`addToAgentContext` 存进面板并打开它。
 *  2. **界面快照**（每轮刷进系统提示）：`buildUiContext` 读出播放头、当前页与选区，
 *     由 `app-boot.ts` 注入成 `ControlContext.getUiContext`。
 *
 * 为什么两件事都放在 `ui/` 这一层：id → 显示名要走 `Label` 解析（i18n 是 UI 层），
 * 而 `agent/` 不许 import i18n 的运行时状态。它们都不能进 `agent/context.ts` ——
 * 那里只有纯渲染。
 */

import { appState } from '../app-state.svelte';
import { editorState } from '../typography/editor-state.svelte';
import type { ContextRef, UiContextSnapshot, UiObjectRef } from '../../agent/context';
import { agentState } from './agent-state.svelte';

/** 片段 id → 显示名（片段已删 / 没命名时退回 id，绝不返回空串）。 */
function clipName(clipId: string): string {
  const found = appState.store.findClip(clipId);
  const text = found?.clip.label.trim() ?? '';
  return text || clipId;
}

/** 时间轴里的片段 → 引用。`ids` 保持传入顺序（= 用户选中的顺序）。 */
export function clipContextRefs(ids: readonly string[]): ContextRef[] {
  return ids
    .filter((id) => Boolean(appState.store.findClip(id)))
    .map((id) => ({ kind: 'clip', id, name: clipName(id) }) as const);
}

/** 排版元素 → 引用。`clipId` 是元素所属的文本片段（排版工具都要它）。 */
export function elementContextRefs(
  clipId: string,
  elements: readonly { id: string; name: string }[],
): ContextRef[] {
  const owner = clipName(clipId);
  return elements.map((el) => ({
    kind: 'element',
    id: el.id,
    name: el.name,
    clipId,
    clipName: owner,
  }));
}

/**
 * 右键菜单的落点：存进面板 + 打开抽屉。
 *
 * **不自动聚焦输入框**：抽屉自己会发现引用数量变多并聚焦（见 `AgentDrawer`），
 * 两处都做会让焦点在动画中跳两次。
 */
export function addToAgentContext(refs: readonly ContextRef[]): void {
  if (!refs.length) return;
  agentState.addContextRefs(refs);
  appState.setAgentOpen(true);
}

/* --------------------------------------------------------- 界面快照 */

/**
 * 用户此刻在看什么。
 *
 * 判据只有一处：`appState.editorOpen`（= `activeProject.view.kind`，工程级）。
 * 不要按「编辑器组件挂没挂」判断 —— 排版页与时间轴是同格兄弟，主界面只是
 * `display:none`，DOM 里永远两份都在。
 */
export function buildUiContext(): UiContextSnapshot | null {
  if (!appState.hasProject) return null;
  const project = appState.store.project;
  const typoId = appState.activeTypoClipId;
  const clipRef = (id: string): UiObjectRef => ({ id, name: clipName(id) });

  return {
    view: appState.editorOpen ? 'typography' : appState.gradeOpen ? 'grade' : 'timeline',
    playT: appState.playT,
    fps: project.fps,
    beatGrid: { ...project.beatGrid },
    typoClip: typoId ? clipRef(typoId) : null,
    selectedClips: appState.selectedClipIds.filter((id) => Boolean(appState.store.findClip(id))).map(clipRef),
    /*
     * 元素只在**排版页编辑的那个片段**上取：`editorState` 保留着上一次打开时的
     * 选区（关页时才清），拿它去配时间轴页的上下文会报出一批用户看不见的元素。
     */
    selectedElements:
      typoId && editorState.clipId === typoId
        ? editorState.selected.map((el) => ({ id: el.id, name: el.name }))
        : [],
  };
}
