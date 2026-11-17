/**
 * issues.ts — 画面批注标记（「Issues」）。
 *
 * 一条标记 = **一个时间段**（`start` … `end`）+ 画面上的一个矩形 + 一句注释。
 * 时间轴把它画成一条彩色实线（起点）与一段很淡的范围；预览只在播放头落在
 * 这个时间段里时显示它。它属于工程内容（`Project.issues`），撤销 / 保存 / 导出
 * 工程都照常覆盖它，但它**不参与渲染**（不进合成、不进导出画面）。
 *
 * ## 坐标约定
 *
 * `x` / `y` 是矩形**中心**，`w` / `h` 是尺寸，全部归一化到画面（0..1，左上原点）。
 * 与 `SourceClip.transform` 的 (x, y) 同义，UI 与 agent 都不需要各记一套。
 *
 * `w` / `h` 分别按**画面宽 / 高**归一化 —— 所以视觉上的正方形是
 * `h = w * resolution.w / resolution.h`（`squareSize` 算的就是这个）。
 * 这样拖动出来的矩形在任意分辨率下都保持相对位置，代价是改工程分辨率时
 * 正方形的宽高比会跟着变（评审标记，不值得为它引入第二套像素坐标）。
 */

/** 新建标记的默认边长（占画面宽度的比例）。 */
export const ISSUE_DEFAULT_W = 0.05;
/** 标记的最小边长（归一化）。再小就点不中了。 */
export const ISSUE_MIN_SIZE = 0.006;
/** 注释长度上限。评审批注不是文档，超长内容会让 scene 快照爆掉。 */
export const ISSUE_MAX_NOTE = 400;

/**
 * 新标记的候选颜色。按创建顺序轮换（`ISSUE_COLORS[n % length]`）——
 * 相邻标记不同色，时间轴上的多条线才分得开。
 */
export const ISSUE_COLORS = [
  '#ff4d4f',
  '#fa8c16',
  '#fadb14',
  '#52c41a',
  '#13c2c2',
  '#1677ff',
  '#722ed1',
  '#eb2f96',
] as const;

export const DEFAULT_ISSUE_COLOR: string = ISSUE_COLORS[0];

export interface IssueMarker {
  id: string;
  /** 秒。标记生效的第一帧（时间轴那条实线画在这里）。 */
  start: number;
  /**
   * 秒。**开区间**的结尾：播放头落在 `[start, end)` 里时预览才显示这条标记。
   * 至少比 `start` 长一帧（`normalizeIssueSpan`），所以拖到一帧上不会变成 0 长。
   */
  end: number;
  /** 矩形中心 X（0..1）。 */
  x: number;
  /** 矩形中心 Y（0..1）。 */
  y: number;
  /** 宽（占画面宽度的比例）。 */
  w: number;
  /** 高（占画面高度的比例）。 */
  h: number;
  /** `#rrggbb`。时间轴那条实线与画面描边都用它。 */
  color: string;
  /** 注释。可以为空（用户先标位置、后补文字）。 */
  note: string;
}

/** 新建一条标记的入参（`id` 由 store 生成）。 */
export interface IssueInput {
  /** 秒。省略 / NaN 时落 0（UI 一定给播放头）。 */
  start: number;
  /** 秒。省略 = 比 `start` 长一帧。 */
  end?: number;
  x: number;
  y: number;
  w?: number;
  h?: number;
  color?: string;
  note?: string;
}

/** 修改一条标记：只写给出的字段，其余保持原值。 */
export interface IssuePatch {
  start?: number;
  end?: number;
  x?: number;
  y?: number;
  w?: number;
  h?: number;
  color?: string;
  note?: string;
}

/** 归一化矩形（左上角 + 尺寸），画图与命中判定用。 */
export interface IssueRect {
  left: number;
  top: number;
  w: number;
  h: number;
}

const HEX_COLOR = /^#[0-9a-fA-F]{6}$/;

export function isIssueColor(v: unknown): v is string {
  return typeof v === 'string' && HEX_COLOR.test(v);
}

function finite(v: unknown, fallback: number): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

/**
 * 钳制一个矩形：尺寸至少 `ISSUE_MIN_SIZE`、至多 1；中心往里收，保证矩形不越过画面。
 * 拖动 / 鼠标画框 / agent 写入共用这一份数学。
 */
export function normalizeIssueRect(input: {
  x?: unknown;
  y?: unknown;
  w?: unknown;
  h?: unknown;
}): { x: number; y: number; w: number; h: number } {
  const w = Math.min(1, Math.max(ISSUE_MIN_SIZE, Math.abs(finite(input.w, ISSUE_DEFAULT_W)) || ISSUE_DEFAULT_W));
  const h = Math.min(1, Math.max(ISSUE_MIN_SIZE, Math.abs(finite(input.h, ISSUE_DEFAULT_W)) || ISSUE_DEFAULT_W));
  // 半宽可能 > 0.5（w = 1 时正好 0.5），clamp 的两端顺序要对：先钳到画面内。
  const x = Math.min(1 - w / 2, Math.max(w / 2, finite(input.x, 0.5)));
  const y = Math.min(1 - h / 2, Math.max(h / 2, finite(input.y, 0.5)));
  return { x, y, w, h };
}

/**
 * 钳制标记的时间段。
 *
 * - 起点 ≥ 0，且不超过工程时长（给了 `maxTime` 时）；
 * - 结尾至少比起点长一帧 —— 允许 0 长会让「拖到一帧上」变成永远不可见的标记，
 *   而用户看不出是时长没了还是标记没了；
 * - 结尾不超过工程时长（除非起点已经在末尾，此时保底留一帧）。
 */
export function normalizeIssueSpan(
  input: { start?: unknown; end?: unknown },
  fps: number,
  maxTime?: number,
): { start: number; end: number } {
  const step = 1 / Math.max(1, Number.isFinite(fps) ? fps : 30);
  const limit =
    maxTime !== undefined && Number.isFinite(maxTime) ? Math.max(0, maxTime) : Number.POSITIVE_INFINITY;
  const start = Math.min(Math.max(0, finite(input.start, 0)), limit);
  const floor = start + step;
  const end = Math.min(Math.max(floor, finite(input.end, floor)), Math.max(floor, limit));
  return { start, end };
}

/** 线段长度（秒）。读回形状与面板显示共用，避免各处相减。 */
export function issueDuration(issue: Pick<IssueMarker, 'start' | 'end'>): number {
  return Math.max(0, issue.end - issue.start);
}

/** 播放头是否落在这条标记里（`[start, end)`，带 1e-9 容差吸收帧栅格误差）。 */
export function issueCovers(issue: Pick<IssueMarker, 'start' | 'end'>, t: number): boolean {
  return t >= issue.start - 1e-9 && t < issue.end - 1e-9;
}

/** 中心 + 尺寸 → 左上角矩形。 */
export function issueRectOf(issue: Pick<IssueMarker, 'x' | 'y' | 'w' | 'h'>): IssueRect {
  return {
    left: issue.x - issue.w / 2,
    top: issue.y - issue.h / 2,
    w: issue.w,
    h: issue.h,
  };
}

/**
 * 视觉上正方形的默认尺寸（宽归一化到画面宽度，高按比例折算）。
 * 画面比例未知时退回 16:9。
 */
export function squareSize(size?: { w: number; h: number } | null): { w: number; h: number } {
  const aspect = size && size.w > 0 && size.h > 0 ? size.w / size.h : 16 / 9;
  return { w: ISSUE_DEFAULT_W, h: ISSUE_DEFAULT_W * aspect };
}

/** 命中判定（归一化坐标）。后加入的标记在上层，所以倒序找。 */
export function issueAt(
  issues: readonly IssueMarker[],
  u: number,
  v: number,
): IssueMarker | null {
  for (let i = issues.length - 1; i >= 0; i -= 1) {
    const it = issues[i]!;
    if (Math.abs(u - it.x) <= it.w / 2 && Math.abs(v - it.y) <= it.h / 2) return it;
  }
  return null;
}

/**
 * 打开工程时的清洗。与 `sections` / `beatMarks` 同一条纪律：**坏条目逐条丢弃**，
 * 工程必须打得开。缺字段（v22 工程、手改 JSON）补成 `[]` 由 schema 那一侧做。
 *
 * `time` 是 v23 早期草稿的字段（一条标记只有一个时刻）：这里当作 `start` 读、
 * 补一帧的时长 —— 那个版本没有发布，但用户在草稿上标过的数据不该白丢。
 */
export function sanitizeIssues(raw: unknown, fps = 30): IssueMarker[] {
  if (!Array.isArray(raw)) return [];
  const out: IssueMarker[] = [];
  const seen = new Set<string>();
  const step = 1 / Math.max(1, Number.isFinite(fps) ? fps : 30);
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const it = item as Partial<IssueMarker> & { time?: unknown };
    const id = typeof it.id === 'string' ? it.id : '';
    if (!id || seen.has(id)) continue;
    const legacyStart = it.start ?? it.time;
    if (legacyStart === undefined || !Number.isFinite(Number(legacyStart))) continue;
    const start = Math.max(0, Number(legacyStart));
    const { start: s, end } = normalizeIssueSpan(
      { start, end: it.end ?? start + step },
      fps,
    );
    const rect = normalizeIssueRect(it);
    seen.add(id);
    out.push({
      id,
      start: s,
      end,
      ...rect,
      color: isIssueColor(it.color) ? it.color : DEFAULT_ISSUE_COLOR,
      note: typeof it.note === 'string' ? it.note.slice(0, ISSUE_MAX_NOTE) : '',
    });
  }
  // 按时间排序：面板、时间轴、scene 快照读到的顺序一致（同一份数据一种读法）。
  return out.sort((a, b) => a.start - b.start);
}
