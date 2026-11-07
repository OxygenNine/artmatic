/**
 * sections.ts — 段落标记的纯逻辑：排序 / 清洗 / 吸附点。
 *
 * `Project.sections` 是**标记**，不是容器：片段不归属段落、段落也不裁剪片段。
 * 它回答的是「这一段在讲什么」（序曲 / 发展 / 副歌），所以：
 *   - 只存 `start`（秒，与 `clip.start` 同口径），不存长度。「这一段的结尾」= 下一段的
 *     开头；最后一段到工程末尾。存 `end` 会立刻出现「相邻两段之间的缝算谁的」这种
 *     没有正确答案的问题，而且改 `duration` 时还得跟着修。
 *   - **允许重叠 / 同起点**。它是标记不是轨道，拒绝重叠只会在拖动时制造「为什么拖不过去」
 *     的哑谜（谁的 start 更小谁在前面，排序是稳定的）。
 *   - `start` 吸附到拍是**UI 的决定**（`snapTimeWithSections`），数据层不存「贴在第几拍」
 *     —— 与 `Curve.beatAnchor` 相反：段落的音乐位置本来就是人手动摆的，BPM 改了它不该
 *     偷偷跳走（那是「重排」，不是「跟着走」）。
 *
 * 本文件不 import `schema.ts` 的**运行时**：`Schema` 只取类型，所以 `schema.ts`
 * 反过来在 `validateProject` 里调 `sanitizeSections` 不会形成运行时循环。
 */

import type { Section } from './schema';
import { snapTime, snapToleranceSec, type BeatGrid, type SnapMode } from './time';
import { BEAT_MARK_SNAP_SEC } from './beat-marks';

/** 段落名的上限：标尺上方只有 12px 高的一条带，名字更长也显示不出来。 */
const MAX_NAME = 60;

/** 按 `start` 稳定排序（同 start 保持原相对顺序，拖动时不会无故互换）。 */
export function sortSections(list: readonly Section[]): Section[] {
  return [...list].sort((a, b) => a.start - b.start);
}

/**
 * 清洗磁盘 / 手改 JSON 里的 `sections`。**永不抛**：工程必须打得开。
 *
 * 丢掉的条目：不是对象、`id` 不是非空字符串、`start` 不是有限非负数。
 * `color` 不是 `#rrggbb` 就删掉这个键（回落到默认色），不丢整条 ——
 * 颜色错了不该让用户的段落标记消失。
 */
export function sanitizeSections(raw: unknown): Section[] {
  if (!Array.isArray(raw)) return [];
  const out: Section[] = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
    const r = item as Partial<Section>;
    if (typeof r.id !== 'string' || !r.id) continue;
    const start = Number(r.start);
    if (!Number.isFinite(start) || start < 0) continue;
    const section: Section = {
      id: r.id,
      name: (typeof r.name === 'string' ? r.name : '').slice(0, MAX_NAME),
      start,
    };
    if (typeof r.color === 'string' && /^#[0-9a-fA-F]{6}$/.test(r.color)) section.color = r.color;
    out.push(section);
  }
  return sortSections(out);
}

/** `t` 时刻落在哪一段里（起点不晚于 `t` 的最后一段）；没有任何段落时 null。 */
export function sectionAt(sections: readonly Section[], t: number): Section | null {
  let found: Section | null = null;
  for (const s of sections) {
    if (s.start <= t + 1e-9 && (!found || s.start >= found.start)) found = s;
  }
  return found;
}

/**
 * 某一段的右边界（秒）= 下一段的起点；没有下一段就是工程末尾。
 *
 * 重叠时结果可能 ≤ 起点（下一段起点更早）—— 调用方按「至少给一点可点宽度」处理即可，
 * 这里不做钳制：那是画法，不是几何。
 */
export function sectionEnd(sections: readonly Section[], section: Section, projectDuration: number): number {
  let next = Number.POSITIVE_INFINITY;
  for (const s of sections) {
    if (s.id === section.id) continue;
    if (s.start > section.start + 1e-9 && s.start < next) next = s.start;
  }
  return Math.min(Number.isFinite(next) ? next : projectDuration, Math.max(0, projectDuration));
}

/**
 * 带上「硬点」的吸附：**网格、段落起点与手动节奏点里更近的那个赢**。
 *
 * 容差来自 `snapToleranceSec`（半个吸附步长，帧吸附是半帧），所以：
 *   - 节奏模式（bar / beat / half）下，段落边界 / 节奏点只要比网格线更近就抢过来；
 *   - 标准模式（free）步长 0.01 拍，它们几乎不可能赢 —— 与「标准模式吸附默认关」一致；
 *   - 帧吸附下只有落在同一帧里的点才抢。
 *
 * 段落不是「额外的网格」而是**更硬的点**：用户摆段落时就是想说「这里是一个结构分界」，
 * 片段贴上去的意愿比贴到最近的小节线更强。`beatMarks` 同理 —— 它是用户跟着音乐
 * 一个个点出来的真实落点（打点计时），比等距 BPM 网格更可信。
 *
 * 注意 `beatMarks` 只参与吸附，**不参与拍换算**（见 `core/beat-marks.ts`）。
 */
export function snapTimeWithSections(
  t: number,
  mode: SnapMode,
  grid: BeatGrid,
  sections: readonly Section[],
  fps = 30,
  beatMarks: readonly number[] = [],
): number {
  const base = snapTime(t, mode, grid, fps);
  if (!sections.length && !beatMarks.length) return Math.max(0, base);
  const tol = snapToleranceSec(mode, grid, fps);
  let best = base;
  let bestD = Math.abs(t - base);
  for (const s of sections) {
    const d = Math.abs(t - s.start);
    if (d <= tol && d < bestD) {
      best = s.start;
      bestD = d;
    }
  }
  // 节奏点比段落密得多，用更紧的容差（见 `BEAT_MARK_SNAP_SEC` 的注释）。
  const markTol = Math.min(tol, BEAT_MARK_SNAP_SEC);
  for (const m of beatMarks) {
    const d = Math.abs(t - m);
    if (d <= markTol && d < bestD) {
      best = m;
      bestD = d;
    }
  }
  return Math.max(0, best);
}

/**
 * 段落默认名：「段落 1」「段落 2」…（避开已有编号，删掉中间几段也不会撞名）。
 *
 * 名字由调用方给（`nameFor(i)`）而不是在这里拼 `base + ' ' + i`：本项目**禁止用
 * 模板字符串拼句子**（翻译时无法重排语序，见 `src/i18n/AGENTS.md`），
 * 所以编号文案必须是 `tr('tl.sectionN', { n })`。
 */
export function nextSectionName(
  sections: readonly Section[],
  nameFor: (n: number) => string,
): string {
  const used = new Set(sections.map((s) => s.name));
  for (let i = 1; i <= sections.length + 1; i += 1) {
    const name = nameFor(i);
    if (!used.has(name)) return name;
  }
  return nameFor(sections.length + 2);
}
