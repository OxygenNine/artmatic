/**
 * context.ts — 「用户标注的对象」与「用户此刻在哪」的提示词渲染。
 *
 * 两件事放在同一份文件里，因为它们回答的是同一个问题的两半：
 *  1. `ContextRef` —— 用户**主动**钉在某一条消息上的对象（右键 → 添加进上下文）；
 *  2. `UiContextSnapshot` —— 每轮都重刷的「用户此刻在看什么」，进系统提示。
 *
 * 都是**纯函数**：只依赖 `core/` 与 `engine/clock`，能在 Node 里单测。
 *
 * 为什么必须把 id 与名字一起写出来：模型看到「把标题改大」时，唯一能用来定位的
 * 是 id；而只给 id 时它读不懂那句话指的是哪个对象，会去猜 / 去 `get_scene` 里翻。
 * 名字是给人看的锚，id 是给工具用的键 —— 少任何一个都会让模型多绕一轮。
 */

import { barBeatAt, type BeatGrid } from '../core/time';
import { frameOf } from '../engine/clock';

/* ------------------------------------------------ 用户标注（右键加入上下文） */

/** 时间轴上的一个片段（源 / 特效 / 音频都可能）。 */
export interface ClipContextRef {
  kind: 'clip';
  id: string;
  name: string;
}

/** 排版文档里的一个元素，`clipId` 是它所属的文本片段。 */
export interface ElementContextRef {
  kind: 'element';
  id: string;
  name: string;
  clipId: string;
  clipName: string;
}

export type ContextRef = ClipContextRef | ElementContextRef;

/** 去重键。同一个对象钉两次没有意义，而重复的条目会让模型以为有多个对象。 */
export function contextRefKey(ref: ContextRef): string {
  return ref.kind === 'clip' ? `clip:${ref.id}` : `element:${ref.clipId}/${ref.id}`;
}

/**
 * 追加一批引用（去重、保序、封顶）。
 *
 * 上限不是安全边界，是**上下文预算**：每个条目至少要占一行，几十个片段钉进去
 * 会把真正的需求挤出注意力之外。超出时丢新来的 —— 先钉的那些是用户先想到的。
 */
export function mergeContextRefs(
  current: readonly ContextRef[],
  add: readonly ContextRef[],
  limit = 16,
): ContextRef[] {
  const seen = new Set(current.map(contextRefKey));
  const out = [...current];
  for (const ref of add) {
    const key = contextRefKey(ref);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(ref);
  }
  return out.slice(0, Math.max(1, limit));
}

/** 名字为空时退回 id：`【】` 这种空括号只会让模型以为对象没有名字。 */
function labelOf(name: string, id: string): string {
  const text = String(name ?? '').trim();
  return text || id;
}

/**
 * 渲染成随 user 消息发出的一段标注。
 *
 * 形状（片段与元素分开，元素按所属片段分组 —— 排版工具都要 `clipId`，
 * 分组的写法让模型不用自己把元素映射回片段）：
 *
 * ```
 * ## 用户标注的片段
 * - 【片头】 id: c_1
 *
 * ## 用户标注的排版元素
 * ### 位于片段【标题卡】（id: c_2）
 * - 【大标题】 id: e_1
 * ```
 */
export function renderAttachedRefs(refs: readonly ContextRef[]): string {
  if (!refs.length) return '';
  const clips = refs.filter((r): r is ClipContextRef => r.kind === 'clip');
  const elements = refs.filter((r): r is ElementContextRef => r.kind === 'element');

  const lines: string[] = [
    'The user picked these from the UI right before typing this message.',
    'When they say "this clip" / "this element" (这个片段 / 这个元素), it means one of them;',
    'the ids are exact — pass them to tools as-is, do not guess others.',
  ];

  /*
   * id 不加反引号：这段是**给模型读的纯文本**，不是要渲染的 Markdown。
   * 反引号在模板字符串里要转义成 \`，徒增两处易错的字符。
   */
  if (clips.length) {
    lines.push('', '## 用户标注的片段');
    for (const ref of clips) lines.push(`- 【${labelOf(ref.name, ref.id)}】 id: ${ref.id}`);
  }

  if (elements.length) {
    lines.push('', '## 用户标注的排版元素');
    // 按片段分组，组的顺序 = 首次出现的顺序（用户钉元素的先后是有效信息）。
    const groups: { clipId: string; clipName: string; items: ElementContextRef[] }[] = [];
    for (const ref of elements) {
      const group = groups.find((g) => g.clipId === ref.clipId);
      if (group) group.items.push(ref);
      else groups.push({ clipId: ref.clipId, clipName: ref.clipName, items: [ref] });
    }
    for (const g of groups) {
      lines.push('', `### 位于片段【${labelOf(g.clipName, g.clipId)}】（id: ${g.clipId}）`);
      for (const ref of g.items) lines.push(`- 【${labelOf(ref.name, ref.id)}】 id: ${ref.id}`);
    }
  }

  return lines.join('\n');
}

/* ------------------------------------------------- 界面状态（每轮刷进系统提示） */

/** 一个只有 id 与显示名的对象（片段 / 排版元素共用）。 */
export interface UiObjectRef {
  id: string;
  name: string;
}

/**
 * 用户此刻的界面快照。
 *
 * 只装「从工程数据推不出来」的东西：播放头、在看哪一页、选中了什么。
 * 场景本身有 `get_scene`，不要在这里复制它。
 */
export interface UiContextSnapshot {
  /** `timeline` = 时间轴主界面；`typography` = 排版编辑器；`grade` = 调色页。 */
  view: 'timeline' | 'typography' | 'grade';
  /** 播放头（秒）。与 `ControlContext.getPlayT()` 同口径，未吸附。 */
  playT: number;
  fps: number;
  beatGrid: BeatGrid;
  /** 排版页正在编辑的文本片段（时间轴页为 null）。 */
  typoClip: UiObjectRef | null;
  /** 时间轴上选中的片段（多选时按选区顺序）。 */
  selectedClips: UiObjectRef[];
  /** 排版页选中的元素。 */
  selectedElements: UiObjectRef[];
}

function refLine(label: string, items: readonly UiObjectRef[]): string {
  if (!items.length) return `- ${label}: none`;
  return `- ${label}: ${items.map((i) => `【${labelOf(i.name, i.id)}】 id: ${i.id}`).join(', ')}`;
}

/**
 * 渲染成**这一轮那条 user 消息的结尾**。
 *
 * 每一轮重取，但**绝不进系统提示**：前缀缓存按字节比较，`messages[0]` 一变，
 * 整段历史都按未命中计费（各家的机制都是「前缀相同才复用」）。
 * 摆在句尾既保住缓存，也更贴切 —— 播放头与选区是这句请求的语境，不是对话规则。
 */
export function renderUiContext(snap: UiContextSnapshot): string {
  const frame = frameOf(snap.playT, snap.fps);
  const { bar, beat } = barBeatAt(snap.playT, snap.beatGrid);
  const bpb = Math.max(1, Math.round(snap.beatGrid.beatsPerBar));
  const seconds = Number.isFinite(snap.playT) ? snap.playT.toFixed(3) : '0.000';

  const lines: string[] = [
    '# Where the user is right now (refreshed every turn)',
    '- View: ' +
      (snap.view === 'typography'
        ? `the typography editor${
            snap.typoClip
              ? `, editing clip 【${labelOf(snap.typoClip.name, snap.typoClip.id)}】 id: ${snap.typoClip.id}`
              : ''
          }`
        : 'the timeline'),
    `- Playhead: ${seconds}s = frame ${frame} = bar ${bar}, beat ${beat} (${bpb} beats/bar, ${snap.beatGrid.bpm} bpm)`,
    refLine('Selected clips', snap.selectedClips),
    refLine('Selected typography elements', snap.selectedElements),
    '- "this clip" / "this element" means the selection above. If it is empty and the',
    '  request is ambiguous, ask which one instead of guessing.',
  ];
  return lines.join('\n');
}

/* ------------------------------------------------- 插话（模型干活时用户说的话） */

/**
 * 插话的包头。
 *
 * 模型在工具循环中途收到一条 user 消息时会愣一下（「我不是还在调工具吗」），
 * 一行说明比让它自己猜便宜得多：它必须知道这是**新要求**，要并入当前任务，
 * 而不是当成又一条工具结果或对上一句话的补充。
 */
export function interjectionText(text: string): string {
  return `(interjection — the user sent this while you were working; fold it into the current task before continuing)\n${text}`;
}
