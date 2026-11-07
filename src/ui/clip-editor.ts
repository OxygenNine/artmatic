/**
 * clip-editor.ts — 「双击这个片段会进哪个子界面」的**唯一判据**。
 *
 * 四个地方要同一份答案，各写一份的下场是「片段上画着 palette 图标、双击却只
 * 打开了抽屉」——不报错，只在用户点下去时才暴露：
 *
 *   · 双击分派       `ui/app-state.svelte.ts::openClipEditor`
 *   · 时间轴片段角标 `timeline/ClipView.svelte`
 *   · 检查器入口按钮 `ui/Inspector.svelte`
 *   · 底栏提示       `timeline/Timeline.svelte` 解析 → `ui/hints.ts` 出文案
 *
 * 判据刻意放在 `ui/`（而不是 `core/`）：它描述的是**界面分派**，不是工程数据。
 * 但它不依赖任何 UI 状态，只读片段本身，所以能单测、也能被纯逻辑的 hints 引用。
 */
import { isGradeDef } from '../core/grade';
import type { AnyClip } from '../core/schema';

/** 片段自己的独立编辑页。 */
export type ClipEditorKind = 'grade' | 'typography';

/**
 * 片段能进的编辑页；`null` = 没有独立页面（双击只打开检查器抽屉）。
 *
 * - 排版：`source` 且来源是 `text`（工程里就是排版文档）。
 * - 调色：`effect` 且链上**真有 `grade-*`** —— 不看片段名、不看标签。
 *   即便这条 grade 被停用也照样算：用户要能进去把它重新打开。
 */
export function clipEditorOf(clip: AnyClip): ClipEditorKind | null {
  if (clip.kind === 'source' && clip.source.type === 'text') return 'typography';
  if (clip.kind === 'effect' && clip.chain.some((i) => isGradeDef(i.defId))) return 'grade';
  return null;
}
