/**
 * scene.ts — `getScene()` 的构造：把 `Project` 在某个 t 抽成一份**紧凑、确定、
 * 可序列化**的快照（方案 §3.2）。
 *
 * **纯函数**：只依赖 `core/`，不碰 DOM / WebGL / 运行期实例，因此能在 Node 里
 * 单测（`tests/unit/agent-scene.test.ts`）。这是它被单独拆出来的唯一理由 ——
 * 控制平面里其余部分都需要注入的实例，测不动。
 *
 * 三件由**控制平面算好**而不是让 agent 自己推的事（方案 §3.2 的「设计要点」）：
 *  1. `z` 序：`视觉轨数 − 1 − 视觉轨下标`，只数视觉轨（AGENTS §4.1）。
 *     写反的表现是「特效完全无效且不报错」，不该让每个 agent 各自推一遍。
 *  2. `active`：判断 t 是否命中片段要处理**出画转场窗口**，而窗口的后半段
 *     已经越过出画片段的 `end`（`transitionAt` 必须在 span 过滤**之前**判，
 *     见 `engine/stack.ts` 的注释）。让 agent 自己判会引入一整类边界 bug。
 *  3. `detail: 'ids'` 的裁剪：长工程里先探路再细读，省上下文。
 */

import { transitionAt } from '../core/transitions';
import { frameOf, timeOf } from '../engine/clock';
import type { Curve } from '../core/curve';
import type { AnyClip, Project, SourceClip, VisualTrack } from '../core/schema';
import type {
  ClipIdView,
  ClipSourceView,
  ClipTextSummary,
  ClipView,
  SceneDetail,
  SceneIdSnapshot,
  SceneSnapshot,
  TrackIdView,
  TrackView,
} from './types';

/** `t` → 最近的帧栅格。与 `engine/clock.ts` 的 `frameOf` 同一口径（唯一时钟）。 */
export function snapToFrame(t: number, fps: number): number {
  return timeOf(frameOf(t, fps), fps);
}

/* ------------------------------------------------------ z 序（AGENTS §4.1） */

/**
 * 每条轨道在合成栈里的层号。音频轨是 `null`（不参与合成，但记账时仍占一个下标）。
 *
 * **只数视觉轨**：4 条视觉轨 + 1 条音频必须是 0..3，否则 z 会出现空洞。
 * 与 `engine/stack.ts::buildStack` 逐字一致（那边也是先走一遍、只给视觉轨编号）。
 */
export function visualZ(tracks: Project['tracks']): (number | null)[] {
  let count = 0;
  for (const tk of tracks) if (tk.kind === 'visual') count++;
  const last = count - 1;
  let i = 0;
  return tracks.map((tk) => (tk.kind === 'visual' ? last - i++ : null));
}

/* --------------------------------------------------------------- active */

/**
 * 一帧里每个片段是否「命中」。
 *
 * 与 `buildStack` 的命中判据对齐，但**转场窗口的两侧都算命中**（那是「这一帧
 * 的画面由谁决定」的诚实答案：转场 op 同时读两张贴图）。
 */
function activeFlags(track: VisualTrack, t: number): boolean[] {
  const clips = track.clips;
  return clips.map((clip, i) => {
    if (t >= clip.start && t < clip.end) return true;
    if (clip.kind !== 'source') return false;
    // 作为出画片段：窗口后半段在自己的 end 之外，仍然在画。
    if (clip.transitionOut && transitionAt(track, i, 'out', t)) return true;
    // 作为入画片段：窗口前半段在自己的 start 之前，先就位了。
    if (clip.transitionIn && transitionAt(track, i, 'in', t)) return true;
    const prev = clips[i - 1];
    if (prev?.kind === 'source' && prev.transitionOut && transitionAt(track, i - 1, 'out', t)?.to) {
      return true;
    }
    const next = clips[i + 1];
    if (next?.kind === 'source' && next.transitionIn && transitionAt(track, i + 1, 'in', t)?.from) {
      return true;
    }
    return false;
  });
}

/* ------------------------------------------------------------- 视图构造 */

/**
 * 文本片段只给摘要（v2）。
 *
 * 整份 `TypographyDocument` 有元素、富文本 runs、动画、组合表 —— 一段文字就
 * 能把上下文塞满，而 agent 大多数时候只需要知道「这是一张多大的画、几个元素」。
 * 详情走 `getTypographyDoc`（按需拉，且可只拉 ids）。
 */
function textSummary(doc: Extract<SourceClip['source'], { type: 'text' }>['doc']): ClipTextSummary {
  return {
    size: { w: doc.size.w, h: doc.size.h },
    elements: doc.elements.length,
    theme: doc.theme ?? null,
    animated: doc.elements.some((e) => (e.animations?.length ?? 0) > 0),
  };
}

function sourceView(clip: Extract<AnyClip, { kind: 'source' }>): ClipSourceView {
  const src = clip.source;
  switch (src.type) {
    case 'video':
      return { type: 'video', assetId: src.assetId, srcIn: src.srcIn, speed: src.speed };
    case 'image':
      return { type: 'image', assetId: src.assetId };
    case 'algo':
      return { type: 'algo', generator: src.generator, params: { ...src.params } };
    case 'text':
      return { type: 'text', doc: textSummary(src.doc) };
    default:
      return { type: 'solid', color: src.color };
  }
}

/** 只留**有键**的曲线：`curves` 里空对象很常见，铺开它只会浪费上下文。 */
function keysOnly(curves: AnyClip['curves']): Record<string, Curve> | undefined {
  const out: Record<string, Curve> = {};
  let n = 0;
  for (const [k, c] of Object.entries(curves)) {
    if (c.keys.length > 0) {
      out[k] = c;
      n++;
    }
  }
  return n > 0 ? out : undefined;
}

function clipViewFull(clip: AnyClip, active: boolean): ClipView {
  const base: ClipView = {
    id: clip.id,
    kind: clip.kind,
    label: clip.label,
    start: clip.start,
    end: clip.end,
    fadeSec: clip.fadeSec,
    active,
  };
  const curves = keysOnly(clip.curves);
  if (clip.kind === 'effect') {
    return {
      ...base,
      chain: clip.chain.map((i) => ({
        instanceId: i.instanceId,
        defId: i.defId,
        enabled: i.enabled,
        values: { ...i.values },
        // 蒙版引用（v19）：读不到它，agent 就无法判断「这个模块吃的是哪来的蒙版」，
        // 而写入端的形状必须能被这里原样读回（硬约束 1.9 第 5 条）。
        ...(i.inputs?.mask ? { mask: i.inputs.mask } : {}),
      })),
      // 0 = 下方全部 = 缺省，不铺开（agent 读到的键越少越省上下文）
      ...(clip.affectDepth ? { affectDepth: clip.affectDepth } : {}),
      // 绑定片段（v11）：读不到它的话，agent 会以为这条特效在按 z 序作用，
      // 然后花几轮去调一个根本不生效的 affectDepth。
      ...(clip.boundClipId ? { boundClipId: clip.boundClipId } : {}),
      ...(curves ? { curves: curves as ClipView['curves'] } : {}),
    };
  }
  if (clip.kind === 'audio') {
    return {
      ...base,
      assetId: clip.assetId,
      srcIn: clip.srcIn,
      // 0 = 不淡（缺省），不铺开：agent 读到的键越少越省上下文。
      ...(clip.fadeIn ? { fadeIn: clip.fadeIn } : {}),
      ...(clip.fadeOut ? { fadeOut: clip.fadeOut } : {}),
      ...(clip.gainDb ? { gainDb: clip.gainDb } : {}),
      ...(clip.linkedVideoId ? { linkedVideoId: clip.linkedVideoId } : {}),
      ...(clip.lockedTo ? { lockedTo: clip.lockedTo } : {}),
      ...(curves ? { curves } : {}),
    };
  }
  return {
    ...base,
    source: sourceView(clip),
    blend: clip.blend,
    opacity: clip.opacity,
    transform: { ...clip.transform },
    fit: clip.fit,
    ...(clip.transitionIn
      ? {
          transitionIn: {
            defId: clip.transitionIn.defId,
            duration: clip.transitionIn.duration,
            values: { ...clip.transitionIn.values },
          },
        }
      : {}),
    ...(clip.transitionOut
      ? {
          transitionOut: {
            defId: clip.transitionOut.defId,
            duration: clip.transitionOut.duration,
            values: { ...clip.transitionOut.values },
          },
        }
      : {}),
    ...(clip.audio ? { audio: { ...clip.audio } } : {}),
    ...(clip.linkedAudioId ? { linkedAudioId: clip.linkedAudioId } : {}),
    ...(curves ? { curves } : {}),
  };
}

function clipIdView(clip: AnyClip): ClipIdView {
  return { id: clip.id, kind: clip.kind, label: clip.label, start: clip.start, end: clip.end };
}

/* ------------------------------------------------------------- 入口 */

function head(project: Project, t: number) {
  return {
    t,
    fps: project.fps,
    resolution: { ...project.resolution },
    duration: project.duration,
    beatGrid: { ...project.beatGrid },
    seed: project.seed,
    /*
     * 段落标记（v3）。**`ids` 与 `full` 两份快照都给**：它不是片段那样的重对象，
     * 几段名字 + 起点对上下文没有任何压力，而少给它的后果是 agent 在
     * 「把音乐按段落铺开」这件事上完全没有坐标系（那正是段落存在的理由）。
     */
    sections: project.sections.map((s) => ({
      id: s.id,
      name: s.name,
      start: s.start,
      ...(s.color ? { color: s.color } : {}),
    })),
    /*
     * 手动节奏点（v5）。**原样给整份数组**：它不是重对象（几百个 number），
     * 而漏给它的后果是 agent 完全不知道用户已经打了点、又去 estimate_beat_grid
     * 覆盖掉一张本来对得很准的网格。
     */
    beatMarks: [...project.beatMarks],
  };
}

/**
 * 构造快照。`t` 是**秒**，会被吸附到帧栅格（否则反馈帧与导出帧不是同一帧）。
 */
export function buildSceneSnapshot(project: Project, t: number, detail: 'ids'): SceneIdSnapshot;
export function buildSceneSnapshot(project: Project, t: number, detail?: SceneDetail): SceneSnapshot;
export function buildSceneSnapshot(project: Project, t: number, detail: SceneDetail = 'full'): SceneSnapshot | SceneIdSnapshot {
  const at = snapToFrame(t, project.fps);
  const z = visualZ(project.tracks);

  if (detail === 'ids') {
    const tracks: TrackIdView[] = project.tracks.map((tk, i) => ({
      id: tk.id,
      kind: tk.kind,
      name: tk.name,
      enabled: tk.enabled,
      // 视觉轨总是带 muted（缺省 false）：模型不用猜「没给」是什么意思。
      ...(tk.kind === 'visual' ? { muted: tk.muted === true } : {}),
      z: z[i] ?? null,
      clips: tk.clips.map(clipIdView),
    }));
    return { ...head(project, at), tracks };
  }

  const tracks: TrackView[] = project.tracks.map((tk, i) => {
    if (tk.kind !== 'visual') {
      return {
        id: tk.id,
        kind: tk.kind,
        name: tk.name,
        enabled: tk.enabled,
        z: z[i] ?? null,
        // 音频片段没有转场，命中判据就是 span。
        clips: tk.clips.map((c) => clipViewFull(c, at >= c.start && at < c.end)),
      };
    }
    const flags = activeFlags(tk, at);
    return {
      id: tk.id,
      kind: tk.kind,
      name: tk.name,
      enabled: tk.enabled,
      muted: tk.muted === true,
      z: z[i] ?? null,
      clips: tk.clips.map((c, j) => clipViewFull(c, flags[j] ?? false)),
    };
  });
  return { ...head(project, at), tracks };
}

/**
 * 单个片段的视图（`getClip`）。找不到返回 `null`（而不是抛错）——
 * 「这个 id 不存在」是 agent 探路时的正常结果，不是异常。
 */
export function buildClipView(project: Project, clipId: string, t: number): ClipView | null {
  const at = snapToFrame(t, project.fps);
  for (const tk of project.tracks) {
    const i = tk.clips.findIndex((c) => c.id === clipId);
    if (i < 0) continue;
    const clip = tk.clips[i]!;
    if (tk.kind === 'audio') {
      return clipViewFull(clip, at >= clip.start && at < clip.end);
    }
    return clipViewFull(clip, activeFlags(tk, at)[i] ?? false);
  }
  return null;
}
