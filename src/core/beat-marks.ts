/**
 * beat-marks.ts — 手动节奏点（打点计时）的纯逻辑。
 *
 * 与 `BeatGrid` 的分工：
 *   - `BeatGrid` 是**等距**的拍网格（BPM / offset / 拍号），`beatAtTime` 之类
 *     的换算、音频特征、生成器的拍冲量全部只认它；
 *   - `beatMarks` 是用户跟着音乐**逐个点下来**的时刻（秒，升序）。它不参与
 *     任何渲染 / 音频求值，只有两处生效：
 *       1. 时间轴吸附的额外硬点（`snapTimeWithSections` 的 `beatMarks` 参数）；
 *       2. 标尺上方段落带与主时间轴的可见标记。
 *
 * **它不是新的拍网格。** 不要拿它算「第 n 拍」或替换 `beatGrid`：非等距的拍
 * 网格会让所有以「拍」为单位的参数（吸附步长、`Curve.beatAnchor`、音频特征、
 * agent 的 beat↔秒换算）失去定义。一首歌的 BPM 仍然只有一个，节奏点回答的是
 * 「这几个具体的音落在哪」，两者并存。
 *
 * 录制语义（`mergeRecordedMarks` 的调用方）：从播放头起录时，播放头**已经
 * 经过的**旧点被清掉，只接受这一轮新点的；播放头之前与之后没走到的点保留。
 * 这条规则住在 UI 的录制状态里（它需要 `playT`），这里只提供纯函数。
 */

/** 上限：一首 10 分钟的歌以 8 次/秒连点也只有 ~4800 个，两万是防病态数据的闸门。 */
export const MAX_BEAT_MARKS = 20000;

/** 两个点被视为「同一个」的阈值（秒）。比一帧还小，不会吃掉十六分音符。 */
export const BEAT_MARK_DEDUPE_SEC = 0.001;

/**
 * 打点去抖窗口（秒）。**只用于录制**：人手指连按不会给出两个 30 ms 内的
 * 明确意图，而按键自动重复会在同一位置灌进几十个点。
 */
export const BEAT_MARK_TAP_GUARD_SEC = 0.03;

/**
 * 节奏点参与吸附时的**最大**容差（秒）。
 *
 * 不能直接用 `snapToleranceSec`（半个吸附步长）：bar 档在 120 BPM 下是 1 秒，
 * 而节奏点通常每 0.5 秒就有一个 —— 整条时间轴会被这些点盖满，用户再也摆不到
 * 「不在点上」的位置。100 ms 是「明显想贴上去」的距离，又不会劫持正常拖动。
 * 帧 / 自由档本身的容差更小，取 min 之后仍按那两档的粒度走。
 */
export const BEAT_MARK_SNAP_SEC = 0.1;

/**
 * 把时刻量化到 1 ms。
 *
 * 不是为了精度（1 ms 远低于听感），而是为了让 JSON 里的数字稳定：音频时钟
 * 给的是 12.345670000000001 这类浮点尾巴，整表比较 / 撤销快照都会被它搅得
 * 「看起来变了」。**写入方（UI / agent）也要走它**，否则选中态拿原始浮点去
 * 比对落库后的整数会差 0.0004 s，表现为「点选不中」。
 */
export function quantizeBeatTime(t: number): number {
  return Math.round(t * 1000) / 1000;
}

/** 一个合法时刻：有限、非负。坏值一律拒绝（比静默归 0 诚实）。 */
function validTime(v: unknown): number | null {
  const n = typeof v === 'number' || typeof v === 'string' ? Number(v) : Number.NaN;
  if (!Number.isFinite(n) || n < 0) return null;
  return quantizeBeatTime(n);
}

/**
 * 清洗磁盘 / 手改 JSON / 工具入参里的 `beatMarks`。**永不抛**：工程必须打得开。
 *
 * 规则：丢掉非有限 / 负数 / 非数字；按时间升序；相距 < 1 ms 的重复点只留第一个；
 * 超过 `MAX_BEAT_MARKS` 的部分丢弃（保留最早的）。数字字符串接受（手改 JSON 常见）。
 */
export function sanitizeBeatMarks(raw: unknown): number[] {
  if (!Array.isArray(raw)) return [];
  const out: number[] = [];
  for (const item of raw) {
    const t = validTime(item);
    if (t === null) continue;
    // 输入未必有序：先全部收下，排序后再去重（只挡相邻重复会让乱序输入漏过去）。
    out.push(t);
  }
  out.sort((a, b) => a - b);
  const unique: number[] = [];
  for (const t of out) {
    if (unique.length && t - unique[unique.length - 1]! < BEAT_MARK_DEDUPE_SEC) continue;
    unique.push(t);
    if (unique.length >= MAX_BEAT_MARKS) break;
  }
  return unique;
}

/**
 * 插入一个点（返回新数组）。已经有点落在 `guardSec` 内时原样返回 ——
 * 调用方据此判断「这次点击什么都没改」。排序仍走 `sanitizeBeatMarks`。
 */
export function insertBeatMark(
  marks: readonly number[],
  t: number,
  guardSec = BEAT_MARK_TAP_GUARD_SEC,
): number[] {
  const at = validTime(t);
  if (at === null) return [...marks];
  for (const m of marks) if (Math.abs(m - at) < guardSec) return [...marks];
  return sanitizeBeatMarks([...marks, at]);
}

/** 删除第 `index` 个点（越界时原样返回 —— 菜单 / 快捷键不该因此抛错）。 */
export function removeBeatMark(marks: readonly number[], index: number): number[] {
  if (!Number.isInteger(index) || index < 0 || index >= marks.length) return [...marks];
  return marks.filter((_, i) => i !== index);
}

/**
 * 把第 `index` 个点挪到 `t`。返回**重新排序后**的数组；钳到 ≥ 0。
 *
 * 拖动时要传「起点时的数组 + 固定的原下标」，不要传上一次的结果：排序会让
 * 被拖的那个点换下标，按新下标继续拖会抓到邻居。
 */
export function moveBeatMark(marks: readonly number[], index: number, t: number): number[] {
  if (!Number.isInteger(index) || index < 0 || index >= marks.length) return [...marks];
  const raw = typeof t === 'number' ? t : Number(t);
  if (!Number.isFinite(raw)) return [...marks];
  const next = marks.slice();
  // 拖动时指针可能移出左端：钳到 0 而不是让点消失（用户没有「删掉」的意图）。
  next[index] = Math.max(0, raw);
  return sanitizeBeatMarks(next);
}

/** 录制一轮的结果：保留段 + 未走到的旧点 + 本轮新点。 */
export function mergeRecordedMarks(
  keep: readonly number[],
  notReached: readonly number[],
  recorded: readonly number[],
): number[] {
  return sanitizeBeatMarks([...keep, ...notReached, ...recorded]);
}
