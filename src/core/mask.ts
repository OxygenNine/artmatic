/**
 * mask.ts — 蒙版引用（`EffectInstance.inputs.mask`）的形状、依赖图与环检测。
 *
 * ## 蒙版不是资源，是一次输入绑定
 *
 * 媒体池只存**烘出来的静态蒙版图**（那就是一张普通 image 素材）；活的蒙版是
 * 「某个片段在这一帧的样子」的引用。所以数据侧只有这一个类型，没有「蒙版实体」。
 *
 * ## 引用点的语义
 *
 * 被引用片段的求值结果 = **该片段 placement 之后的整帧层 + 它的绑定效应链**
 * （`boundClipId` 指向它的 EffectClip），**不含 blend / opacity**。
 * 取 placement 原始输出更安全（无递归），但那样「模糊后的亮度当蒙版」做不到 ——
 * 既然允许递归，就必须有环检测，而环检测必须发生在**写入口**（本文件 +
 * `project-store` 的 setter），不能只在渲染层兜底：渲染层发现环的时候只能给
 * 白图或者死循环，两种都是静默的坏画面。
 *
 * ## 依赖边是两种
 *
 * - **引用边** `effectClip → 目标片段`：渲这条链要先算出目标那一层。
 * - **绑定边** `sourceClip → 绑定在它上面的 effectClip`：渲那一层要先跑那些链。
 *
 * ## `kind: 'asset'` 是「烘好的全帧蒙版」
 *
 * 素材引用**不做 placement**：图片整张铺满蒙版目标（即整帧），因为它的语义是
 * 「一张已经按画面构图烘好的蒙版图」。想要「用某个位置的一块图」，就把它摆成
 * 一个片段再引用片段。这条差别是有意的：素材没有 transform，按 content box
 * 去猜缩放只会得到「同一张图在两台机器上是两个范围」。
 *
 * 两条一起才能抓到「A 的链引用 B、B 绑定的链又引用 A」这种环 —— 只看引用边
 * 会漏掉它，因为环是穿过绑定关系绕回来的。
 */

import type { Project } from './schema';

export type MaskChannel = 'luma' | 'alpha' | 'r' | 'g' | 'b';

/** 通道的规范顺序 —— 索引就是 shader 里的 `u_channel`。 */
export const MASK_CHANNELS: readonly MaskChannel[] = ['luma', 'alpha', 'r', 'g', 'b'];

export const MASK_CHANNEL_INDEX: Record<MaskChannel, number> = {
  luma: 0,
  alpha: 1,
  r: 2,
  g: 3,
  b: 4,
};

/**
 * `inputs` 里的键名。只认这一个 —— 将来再加第二种输入（深度 / 法线）时键名
 * 才是分派点，所以不要把它写成 `inputs.mask` 的字面量散落各处。
 */
export const MASK_INPUT_KEY = 'mask';

/**
 * 蒙版嵌套上限（层数，不是像素）。超了**当作环**处理：链长到 8 层已经是
 * 「用户自己也不知道自己在做什么」，而渲染侧每多一层就多一遍全帧渲染。
 */
export const MAX_MASK_DEPTH = 8;

/**
 * 一条蒙版引用。
 *
 * `{ kind: 'none' }` 是**有意义的空**：删除被引用片段时把引用置成它，
 * 而不是删掉整个 `inputs` —— 后者会让「下一帧整条链的行为」因为一个字段消失
 * 而变化（`undefined` 与 `none` 在渲染侧等价，但在撤销栈与检查器里不等价）。
 */
export type MaskRef =
  | { kind: 'none' }
  | { kind: 'clip'; clipId: string; channel: MaskChannel }
  | { kind: 'asset'; assetId: string; channel: MaskChannel };

export function isMaskChannel(v: unknown): v is MaskChannel {
  return typeof v === 'string' && (MASK_CHANNELS as readonly string[]).includes(v);
}

/** 这条引用真的要读一张贴图吗（`none` 与缺省都不读）。 */
export function maskRefTarget(
  ref: MaskRef | null | undefined,
): { kind: 'clip' | 'asset'; id: string; channel: MaskChannel } | null {
  if (!ref || ref.kind === 'none') return null;
  return ref.kind === 'clip'
    ? { kind: 'clip', id: ref.clipId, channel: ref.channel }
    : { kind: 'asset', id: ref.assetId, channel: ref.channel };
}

/** 实例上的蒙版引用（读不到合法值就是 `null`）。 */
export function maskRefOf(inst: { inputs?: Record<string, MaskRef> }): MaskRef | null {
  return inst.inputs?.[MASK_INPUT_KEY] ?? null;
}

/**
 * 形状校验：坏值返回 `null`（调用方据此**删掉这个键**），合法值原样收窄。
 *
 * 与 `validateProject` 的其它可选字段同一条纪律：手改 JSON 不该让工程打不开。
 */
export function sanitizeMaskRef(raw: unknown): MaskRef | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  if (r.kind === 'none') return { kind: 'none' };
  if (r.kind === 'clip') {
    if (typeof r.clipId !== 'string' || !r.clipId) return null;
    if (!isMaskChannel(r.channel)) return null;
    return { kind: 'clip', clipId: r.clipId, channel: r.channel };
  }
  if (r.kind === 'asset') {
    if (typeof r.assetId !== 'string' || !r.assetId) return null;
    if (!isMaskChannel(r.channel)) return null;
    return { kind: 'asset', assetId: r.assetId, channel: r.channel };
  }
  return null;
}

/* ------------------------------------------------------------- 依赖图 */

/** `effect` 链里所有「引用某个片段」的条目（改引用与查环共用）。 */
interface ClipMaskUse {
  /** 声明这条引用的片段（effect clip）。 */
  ownerId: string;
  instanceId: string;
  targetClipId: string;
}

/**
 * 扫一遍工程里全部 clip 引用。
 *
 * 只认 `kind: 'clip'` —— 素材引用不引入依赖（素材是静态图，不会反过来要一条链）。
 */
export function clipMaskUses(project: Project): ClipMaskUse[] {
  const out: ClipMaskUse[] = [];
  for (const track of project.tracks) {
    for (const clip of track.clips) {
      if (clip.kind !== 'effect') continue;
      for (const inst of clip.chain) {
        const target = maskRefTarget(maskRefOf(inst));
        if (target?.kind === 'clip') {
          out.push({ ownerId: clip.id, instanceId: inst.instanceId, targetClipId: target.id });
        }
      }
    }
  }
  return out;
}

/**
 * 依赖边：`clipId → 渲它之前要先算出来的 clipId`。
 *
 * 两种边（见文件头）：引用边与绑定边。**同一个目标只留一条**：渲染侧一帧内按
 * clipId 去重，重复边只影响遍历次数。
 */
export function maskEdges(project: Project): Map<string, string[]> {
  const edges = new Map<string, string[]>();
  const add = (from: string, to: string): void => {
    const list = edges.get(from);
    if (!list) edges.set(from, [to]);
    else if (!list.includes(to)) list.push(to);
  };
  for (const up of clipMaskUses(project)) add(up.ownerId, up.targetClipId);
  for (const track of project.tracks) {
    for (const clip of track.clips) {
      if (clip.kind !== 'effect' || !clip.boundClipId) continue;
      add(clip.boundClipId, clip.id);
    }
  }
  return edges;
}

/**
 * `from` 能否沿依赖边走到 `to`（深度上限之外的路径一律**当作到了**）。
 *
 * 导出它是给**界面**用的：候选下拉要在一次渲染里问很多遍（每个候选一次），
 * 每问一次重建一遍边表的代价是 O(片段数²)。写入侧仍然走 `maskRefCreatesCycle`
 * （它会把「这一笔还没落库的边」算进去）。
 *
 * 两者等价：新增的那条边是 `owner→target`，而问题问的是「target 能不能到 owner」，
 * 方向相反 —— 除非环已经存在，否则它帮不上忙。
 */
export function maskPathExists(
  edges: Map<string, string[]>,
  from: string,
  to: string,
): boolean {
  const seen = new Set<string>();
  let frontier = [from];
  for (let depth = 0; depth <= MAX_MASK_DEPTH && frontier.length > 0; depth += 1) {
    const next: string[] = [];
    for (const id of frontier) {
      if (id === to) return true;
      if (seen.has(id)) continue;
      seen.add(id);
      next.push(...(edges.get(id) ?? []));
    }
    frontier = next;
  }
  // 走完 MAX_MASK_DEPTH 步还没到但**还有下一层** ⇒ 链太深，按环处理。
  return frontier.some((id) => !seen.has(id));
}

/**
 * 新增 / 修改一条引用会不会成环（store setter 用）。
 *
 * 判据 = 「目标能不能绕回声明者」，而不是「目标是不是自己」：三层互相引用
 * （A→B→C→A）在最后一笔写下去时同样要拒，而那一笔看着完全无辜。
 */
export function maskRefCreatesCycle(project: Project, ownerId: string, targetClipId: string): boolean {
  if (ownerId === targetClipId) return true;
  const edges = maskEdges(project);
  const list = edges.get(ownerId);
  // 这次写入还没落库，先把边加上再判 —— 否则「A→B 已存在、现在改 A→A」看不出问题。
  if (list && !list.includes(targetClipId)) list.push(targetClipId);
  else if (!list) edges.set(ownerId, [targetClipId]);
  return maskPathExists(edges, targetClipId, ownerId);
}

/**
 * 就地清掉成环（或过深）的引用，返回清掉的条数。
 *
 * 处理方式是「把引用置成 `none`」而不是拒绝整份工程：`validateProject` 的
 * 纪律是**坏数据回落、工程必须打得开**（与坏段落标记、坏配色方案同一条）。
 * 环是手改 JSON 或者跨越版本拼接才会出现的东西，为它让整份工程打不开不成比例。
 *
 * 每清一条就重建一次图，因为一条边消失可能让另一个「深链」变短 ——
 * 条目数是个位数，重建的成本可以忽略。
 */
export function dropMaskCycles(project: Project): number {
  let dropped = 0;
  for (let round = 0; round < 64; round += 1) {
    const edges = maskEdges(project);
    const bad = clipMaskUses(project).filter((u) => maskPathExists(edges, u.targetClipId, u.ownerId));
    if (bad.length === 0) return dropped;
    const first = bad[0]!;
    for (const track of project.tracks) {
      for (const clip of track.clips) {
        if (clip.kind !== 'effect' || clip.id !== first.ownerId) continue;
        const inst = clip.chain.find((i) => i.instanceId === first.instanceId);
        if (inst?.inputs) inst.inputs[MASK_INPUT_KEY] = { kind: 'none' };
      }
    }
    dropped += 1;
  }
  return dropped;
}

/**
 * `validateProject` 的那一趟：形状 → 悬空 → 环。
 *
 * 悬空引用（目标片段 / 素材已经不在了）**置成 `none` 而不是删键**：留着一条
 * 指向空气的引用，检查器会显示一个用户点不到的 id，而渲染侧读到的是「没有蒙版」
 * —— 显示与实际不一致比少一条引用坏得多。与 `linkedAudioId` 的悬空清扫同一条纪律。
 *
 * 就地改，返回「动过几处」，只给测试与诊断用。
 */
export function sanitizeMaskInputs(project: Project): number {
  const clipIds = new Set<string>();
  for (const track of project.tracks) for (const clip of track.clips) clipIds.add(clip.id);
  const assets = project.assets ?? {};

  let touched = 0;
  for (const track of project.tracks) {
    for (const clip of track.clips) {
      if (clip.kind !== 'effect') continue;
      for (const inst of clip.chain) {
        const raw = (inst as { inputs?: unknown }).inputs;
        if (raw === undefined) continue;
        if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
          delete (inst as { inputs?: unknown }).inputs;
          touched += 1;
          continue;
        }
        const inputs = inst.inputs!;
        for (const key of Object.keys(inputs)) {
          if (key !== MASK_INPUT_KEY) {
            // 只有一种输入。未知键留着会让「下一版加了新输入」变成两套并行真源。
            delete inputs[key];
            touched += 1;
            continue;
          }
          const ref = sanitizeMaskRef(inputs[key]);
          if (!ref) {
            delete inputs[key];
            touched += 1;
            continue;
          }
          const target = maskRefTarget(ref);
          const dangling =
            target !== null &&
            (target.kind === 'clip'
              ? !clipIds.has(target.id)
              : assets[target.id]?.kind !== 'image');
          if (dangling) {
            inputs[key] = { kind: 'none' };
            touched += 1;
          } else {
            inputs[key] = ref;
          }
        }
        if (Object.keys(inputs).length === 0) {
          delete (inst as { inputs?: unknown }).inputs;
          touched += 1;
        }
      }
    }
  }
  return touched + dropMaskCycles(project);
}
