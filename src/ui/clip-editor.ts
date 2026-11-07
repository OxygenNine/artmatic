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
import { getGenerator } from '../algos/registry';
import type { AnyClip } from '../core/schema';

/**
 * 片段自己的独立编辑页。
 *
 * `particles` 是「可调项数量过大」这一类功能的入口：凡是 `gpu-sim` 形态
 * （走 `createParticleGenerator` 的生成器）都自动有全屏编辑器，
 * 不需要新生成器再来这里登记一次 —— 复用内核就该顺带复用界面。
 */
export type ClipEditorKind = 'grade' | 'typography' | 'particles';

/** 这个生成器是不是「参数多到需要全屏子系统」的那一类。 */
export function hasFullscreenEditor(generatorId: string): boolean {
  return getGenerator(generatorId)?.kind === 'gpu-sim';
}

/**
 * 片段能进的编辑页；`null` = 没有独立页面（双击只打开检查器抽屉）。
 *
 * - 排版：`source` 且来源是 `text`（工程里就是排版文档）。
 * - 调色：`effect` 且链上**真有 `grade-*`** —— 不看片段名、不看标签。
 *   即便这条 grade 被停用也照样算：用户要能进去把它重新打开。
 * - 粒子：`source` 且生成器是 `gpu-sim` —— 参数表几十项，检查器的一列平铺
 *   放不下；后续复用粒子内核的生成器自动走这一支。
 */
export function clipEditorOf(clip: AnyClip): ClipEditorKind | null {
  if (clip.kind === 'source' && clip.source.type === 'text') return 'typography';
  if (clip.kind === 'effect' && clip.chain.some((i) => isGradeDef(i.defId))) return 'grade';
  if (clip.kind === 'source' && clip.source.type === 'algo' && hasFullscreenEditor(clip.source.generator)) {
    return 'particles';
  }
  return null;
}
