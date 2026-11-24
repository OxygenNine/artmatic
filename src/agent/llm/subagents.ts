/**
 * subagents.ts — 子代理的**纯逻辑层**：预设、写栅栏、结果契约。
 *
 * 这里刻意不 import `session.ts`（运行时在 `subagent-runner.ts`）：
 * `session.ts` 需要 `SessionOptions` 上的子代理钩子类型，反向 import 会成环。
 *
 * ## 为什么没有「查状态」这个工具
 *
 * 工具面只有 spawn / wait / cancel。**没有 list / status / progress**，所以模型
 * 想轮询也没有可调的东西 —— `wait_for_agent` 也不带 timeout 参数（带 timeout
 * 就能把 timeout 当间隔用）。这是「禁止轮询」唯一的机械保证，不靠提示词。
 *
 * ## 写栅栏是声明式 scope，不是锁
 *
 * spawn 时定死 scope，运行期不变。冲突即 `conflict`，**不排队、不重试**：
 * 排队会把「两个代理想改同一个片段」变成一次静默的覆盖，而覆盖之后再解释
 * 已经是事后了。
 *
 * 父代理的隐式 claim 是「全域减去所有 reservation」—— 所以父也撞栅栏，这才叫
 * 「明确分开」。
 */

import type { ToolOutcome } from './types';
import type { ToolSpec } from '../tools';
import { AGENT_TOOLS } from '../tools';

/* --------------------------------------------------------------- 常量 */

/** 同时在跑的子代理上限。 */
export const MAX_CONCURRENT_SUBAGENTS = 3;
/** 单个子代理的墙钟上限（毫秒）。到点 abort，已产出的内容照常返回。 */
export const SUBAGENT_WALL_MS = 120_000;
/** 子代理的上下文窗口上限。父窗口更小时取父的。 */
export const SUBAGENT_CONTEXT_TOKENS = 120_000;
/** 回给父代理的 summary 字符上限（结果不该把父的上下文再撑爆一次）。 */
export const SUMMARY_MAX_CHARS = 1_200;

/** 父代理在栅栏里的 owner id。 */
export const PARENT_OWNER = 'parent';

export type SubagentPreset = 'explore' | 'review' | 'code';

/* --------------------------------------------------------------- 预设 */

/**
 * 一个预设 = 工具子集 + 系统提示 + 默认步数。
 *
 * 模型只能报预设名，**不能传工具列表** —— 那是自授权限（与 `plugin_try` 的
 * `confirm` 不暴露给模型同一条纪律）。
 */
export interface SubagentPresetDef {
  /** 只读工具。 */
  tools: readonly string[];
  /** `canWrite: true` 时额外给的工具。空数组 = 这个预设不支持写。 */
  writeTools: readonly string[];
  /** 单轮「模型 → 工具」往返上限。 */
  steps: number;
  /** 需要模型能读图（`review`）。父模型不收图时 spawn 直接拒。 */
  needsImages?: boolean;
  label: string;
}

/** 输出契约 + 边界，三个预设共用。 */
const CONTRACT = `You are a subagent of Artmatic, a glitch-art video editor. You work alone: the
parent agent cannot see your tool calls and will only read your final message.

Return ONE JSON object and nothing else:
{"summary": "...", "evidence": ["..."], "gaps": ["..."], "needsDecision": null}

- "summary": what you found or did, at most 1200 characters. Plain facts, no preamble.
- "evidence": concrete things you actually read — clip ids, frame times, numbers, source lines.
  Never claim something you did not observe.
- "gaps": what you could not check. An honest gap is worth more than a guess.
- "needsDecision": if the task needs a human decision, put the question here instead of guessing.

Rules:
- You cannot ask the user anything. There is no human in your loop.
- Do not write prose around the JSON. No markdown fence, no headings.
- If you run out of steps, return the JSON with what you have and list the rest in "gaps".`;

const PRESET_DEFS: Record<SubagentPreset, SubagentPresetDef> = {
  explore: {
    label: 'Explore',
    steps: 20,
    tools: [
      'describe',
      'help',
      'get_scene',
      'get_clip',
      'get_capabilities',
      'get_typography_capabilities',
      'get_typography_doc',
      'undo_state',
      'media_list',
      'project_stats',
      'frame_signature',
      'get_asset_ranges',
      'list_modulators',
      'typo_measure',
    ],
    writeTools: [],
  },
  review: {
    label: 'Visual review',
    steps: 24,
    needsImages: true,
    tools: [
      'get_scene',
      'get_clip',
      'get_capabilities',
      'render_frame',
      'render_sequence',
      'frame_signature',
      'typo_measure',
    ],
    writeTools: [],
  },
  code: {
    label: 'Plugin source',
    steps: 32,
    tools: [
      'describe',
      'get_capabilities',
      'plugin_list',
      'plugin_view',
      'plugin_grep',
      'plugin_source',
      'plugin_check',
    ],
    writeTools: ['plugin_edit'],
  },
};

const EXPLORE_SYSTEM = `You survey an Artmatic project and report facts. You cannot modify anything.

${CONTRACT}

How to be useful here: the parent usually needs a SHORT list — which tracks/clips/def ids
match some condition, and the numbers behind it. Start with get_scene (detail "ids" first)
or project_stats, then read only the clips you actually need. Never dump a whole scene back.`;

const REVIEW_SYSTEM = `You review the LOOK of rendered frames of an Artmatic project. You cannot modify anything.

${CONTRACT}

How to be useful here:
- Render with render_frame / render_sequence before saying anything about the image. At t=0 many
  generators are empty (they need time to grow) — use render_sequence to see the motion.
- Judge composition, contrast, legibility and rhythm. Name what is wrong in terms of where it is
  ("the lower third is dead space", "the text collides with the moving bars"), not in adjectives.
- If the frame is empty or black, say so and give the likely cause; do not describe a picture
  you cannot see.`;

const CODE_SYSTEM = `You review plugin source code in an Artmatic project. You cannot run or install plugins.

${CONTRACT}

How to be useful here:
- Read the real source (plugin_view / plugin_source). plugin_check is a static parse: it catches
  import / export / format problems, NOT GLSL problems.
- For shaders, check the things that fail silently: a uniform written with the wrong type
  (uniform1i on a float is INVALID_OPERATION and writes nothing), a uniform declared but never
  read (the linker drops it, so the slider moves and nothing happens), u_feedback used without
  the feedback flag.
- Quote the line you are talking about.`;

const PRESET_SYSTEM: Record<SubagentPreset, string> = {
  explore: EXPLORE_SYSTEM,
  review: REVIEW_SYSTEM,
  code: CODE_SYSTEM,
};

export function presetDef(preset: SubagentPreset): SubagentPresetDef {
  return PRESET_DEFS[preset];
}

export function presetSystemPrompt(preset: SubagentPreset): string {
  return PRESET_SYSTEM[preset];
}

export function isPreset(v: unknown): v is SubagentPreset {
  return v === 'explore' || v === 'review' || v === 'code';
}

/**
 * 预设的工具清单。
 *
 * `canWrite: false` 时把 `writes: true` 的工具一并剔掉 —— 双保险：预设本身
 * 就不该混进写工具，但漏标一个的后果是子代理绕过 scope 直接改工程。
 */
export function presetTools(preset: SubagentPreset, canWrite: boolean): ToolSpec[] {
  const def = PRESET_DEFS[preset];
  const names = new Set<string>([...def.tools, ...(canWrite ? def.writeTools : [])]);
  const byName = new Map(AGENT_TOOLS.map((t) => [t.name, t]));
  const out: ToolSpec[] = [];
  for (const name of names) {
    const spec = byName.get(name);
    if (!spec) continue;
    if (spec.writes && !canWrite) continue;
    out.push(spec);
  }
  return out;
}

/** 预设能不能写（`canWrite: true` 但 `writeTools` 为空时要直接拒，别假装能写）。 */
export function presetWritable(preset: SubagentPreset): boolean {
  return PRESET_DEFS[preset].writeTools.length > 0;
}

/* --------------------------------------------------------------- 写栅栏 */

/**
 * 域键。`global` 是 fail-closed 的兜底：解析不出目标 = 可能碰到任何东西。
 *
 * 一次写可以同时落在多个域（`move_clip` 改片段也改目标轨道），所以所有 API
 * 都用数组。
 */
export const GLOBAL_DOMAIN = 'global';

/** 模型能声明的 scope（结构化，比让它拼域键友好）。 */
export interface SubagentScope {
  tracks?: string[];
  /** 一个片段同时授予 `clip:<id>` 与 `typo:<id>`（文本片段的排版文档挂在片段上）。 */
  clips?: string[];
  plugins?: string[];
  media?: boolean;
  structure?: boolean;
  project?: boolean;
}

function strList(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  return v.filter((x): x is string => typeof x === 'string' && x.trim() !== '').map((x) => x.trim());
}

/** scope → 域键集合。空集 = 纯只读。 */
export function claimDomains(scope: SubagentScope | null | undefined): string[] {
  if (!scope || typeof scope !== 'object') return [];
  const out = new Set<string>();
  for (const id of strList(scope.tracks)) out.add(`track:${id}`);
  for (const id of strList(scope.clips)) {
    out.add(`clip:${id}`);
    out.add(`typo:${id}`);
  }
  for (const id of strList(scope.plugins)) out.add(`plugin:${id}`);
  if (scope.media) out.add('media');
  if (scope.structure) out.add('structure');
  if (scope.project) out.add('project');
  return [...out];
}

/** 解析一格字符串参数：trim 过，非字符串当空。 */
function argStr(args: Record<string, unknown>, key: string): string {
  const v = args[key];
  return typeof v === 'string' ? v.trim() : '';
}

function clipDomain(args: Record<string, unknown>): string[] {
  const id = argStr(args, 'clipId');
  return id ? [`clip:${id}`] : [GLOBAL_DOMAIN];
}

function typoDomain(name: string, args: Record<string, unknown>): string[] {
  // 工程级主题 / 画布尺寸：即使带了 clipId 也不止影响这一个片段。
  if (name === 'typo_save_theme' || name === 'typo_remove_theme') return ['project'];
  if (name === 'typo_set_theme') {
    if (argStr(args, 'scope') === 'project') return ['project'];
    const id = argStr(args, 'clipId');
    return id ? [`typo:${id}`] : [];
  }
  const id = argStr(args, 'clipId');
  // `[]` = 解析不出目标（省略 clipId = 当前打开的那份文档）。与 `global` 不同，
  // 见 `checkWrite` 的说明。
  return id ? [`typo:${id}`] : [];
}

const GLOBAL_ONLY = (): string[] => [GLOBAL_DOMAIN];

/**
 * 写工具 → 它真正会碰到的域。
 *
 * **表里必须有每一个有副作用的工具**，包括那些本来就该 `global` 的（整工程
 * 替换 / 撤销 / 导出）。漏一个就走兜底 `global`，而兜底在父代理单干时是放行的
 * —— 于是「两个代理同时改同一个片段」不会有任何报错。
 * `tests/unit/agent-subagents.test.ts` 会枚举 `writes: true` 的工具逐个断言它们
 * 在这张表里，所以漏登记会变红，而不是变成线上偶发。
 *
 * 一次写可以落在多个域（`move_clip` 改片段也改目标轨道），所以值都是数组。
 */
export const WRITE_TARGETS: Record<string, (args: Record<string, unknown>) => string[]> = {
  /* ---- 工程结构 ---- */
  add_track: () => ['structure'],
  remove_track: () => ['structure'],
  move_track: () => ['structure'],
  set_track: () => ['structure'],
  edit_sections: () => ['structure'],
  // 批注是工程级列表（与段落同级）：两个代理同时标问题必须让其中一个等。
  edit_issues: () => ['structure'],
  add_clip: (a) => {
    const t = argStr(a, 'trackId');
    return t ? [`track:${t}`] : [GLOBAL_DOMAIN];
  },
  add_effect_clip: (a) => {
    const out: string[] = [];
    const t = argStr(a, 'trackId');
    if (t) out.push(`track:${t}`);
    const bound = argStr(a, 'boundClipId');
    if (bound) out.push(`clip:${bound}`);
    return out.length ? out : [GLOBAL_DOMAIN];
  },

  /* ---- 片段级 ---- */
  remove_clip: clipDomain,
  resize_clip: clipDomain,
  split_clip: clipDomain,
  set_clip_props: clipDomain,
  set_params: clipDomain,
  set_generator: clipDomain,
  set_three_code: clipDomain,
  set_three_params: clipDomain,
  set_curve: clipDomain,
  add_effect: clipDomain,
  remove_effect: clipDomain,
  reorder_effect: clipDomain,
  set_transition: clipDomain,
  clear_transition: clipDomain,
  detach_video_audio: clipDomain,
  set_audio_lock: clipDomain,
  set_clip_audio: clipDomain,
  move_clip: (a) => {
    const out: string[] = [];
    const c = argStr(a, 'clipId');
    if (c) out.push(`clip:${c}`);
    const to = argStr(a, 'targetTrackId') || argStr(a, 'trackId');
    if (to) out.push(`track:${to}`);
    return out.length ? out : [GLOBAL_DOMAIN];
  },
  seed_pattern_from_asset: (a) => {
    const c = argStr(a, 'clipId');
    return c ? [`clip:${c}`, 'media'] : ['media'];
  },
  bind_modulator: (a) => {
    const out: string[] = [];
    const c = argStr(a, 'clipId');
    if (c) out.push(`clip:${c}`);
    const m = argStr(a, 'modulatorId') || argStr(a, 'id');
    if (m) out.push(`modulator:${m}`);
    return out.length ? out : [GLOBAL_DOMAIN];
  },
  unbind_modulator: (a) => {
    const out: string[] = [];
    const c = argStr(a, 'clipId');
    if (c) out.push(`clip:${c}`);
    const m = argStr(a, 'modulatorId') || argStr(a, 'id');
    if (m) out.push(`modulator:${m}`);
    return out.length ? out : [GLOBAL_DOMAIN];
  },
  // 省略 id = 新建一个调制器：目标未知，只能 fail-closed。
  set_modulator: (a) => {
    const m = argStr(a, 'modulatorId') || argStr(a, 'id');
    return m ? [`modulator:${m}`] : [GLOBAL_DOMAIN];
  },
  remove_modulator: (a) => {
    const m = argStr(a, 'modulatorId') || argStr(a, 'id');
    return m ? [`modulator:${m}`] : [GLOBAL_DOMAIN];
  },

  /* ---- 素材 ---- */
  set_asset_range: () => ['media'],
  remove_asset_range: () => ['media'],
  set_active_range: () => ['media'],
  rename_asset: () => ['media'],
  media_op: () => ['media'],

  /* ---- 工程属性 / 整工程 ---- */
  set_project: () => ['project'],
  estimate_beat_grid: () => ['project'],
  set_beat_marks: () => ['project'],
  /*
   * 分析与段落：它既写 `sections`（结构域）也**可能**重估 `beatGrid`
   * （project 域）。两个都报，子代理的 scope 相交判定才不会漏掉一次网格改写。
   */
  analyze_music: () => ['structure', 'project'],
  load_scene: GLOBAL_ONLY,

  /* ---- 事务 / 撤销：整工程回滚 ---- */
  begin_transaction: GLOBAL_ONLY,
  commit_transaction: GLOBAL_ONLY,
  cancel_transaction: GLOBAL_ONLY,
  undo: GLOBAL_ONLY,
  redo: GLOBAL_ONLY,

  /* ---- 插件 ---- */
  plugin_edit: (a) => {
    const id = argStr(a, 'pluginId') || argStr(a, 'id');
    return id ? [`plugin:${id}`] : [GLOBAL_DOMAIN];
  },
  plugin_discard: (a) => {
    const id = argStr(a, 'pluginId') || argStr(a, 'id');
    return id ? [`plugin:${id}`] : [GLOBAL_DOMAIN];
  },
  plugin_remove: (a) => {
    const id = argStr(a, 'pluginId') || argStr(a, 'id');
    return id ? [`plugin:${id}`] : [GLOBAL_DOMAIN];
  },
  plugin_try: (a) => {
    const id = argStr(a, 'pluginId') || argStr(a, 'id');
    return id ? [`plugin:${id}`] : [GLOBAL_DOMAIN];
  },
  plugin_install: (a) => {
    const id = argStr(a, 'pluginId') || argStr(a, 'id');
    return id ? [`plugin:${id}`] : [GLOBAL_DOMAIN];
  },
  // 插件动作的副作用范围无法静态推断，只能按宿主粗粒度声明。
  plugin_invoke: (a) => {
    const id = argStr(a, 'pluginId') || argStr(a, 'id');
    return id ? [`plugin:${id}`] : [GLOBAL_DOMAIN];
  },

  export: GLOBAL_ONLY,

  /* ---- 排版（每个都显式登记：新增 typo 写工具必须在这里出现） ---- */
  typo_add_element: (a) => typoDomain('typo_add_element', a),
  typo_add_elements: (a) => typoDomain('typo_add_elements', a),
  typo_add_generated_shape: (a) => typoDomain('typo_add_generated_shape', a),
  typo_update_element: (a) => typoDomain('typo_update_element', a),
  typo_update_elements: (a) => typoDomain('typo_update_elements', a),
  typo_set_animation: (a) => typoDomain('typo_set_animation', a),
  typo_copy_style: (a) => typoDomain('typo_copy_style', a),
  typo_set_scripts: (a) => typoDomain('typo_set_scripts', a),
  typo_set_text: (a) => typoDomain('typo_set_text', a),
  typo_remove_element: (a) => typoDomain('typo_remove_element', a),
  typo_reorder_element: (a) => typoDomain('typo_reorder_element', a),
  typo_group: (a) => typoDomain('typo_group', a),
  typo_ungroup: (a) => typoDomain('typo_ungroup', a),
  typo_update_group: (a) => typoDomain('typo_update_group', a),
  typo_boolean: (a) => typoDomain('typo_boolean', a),
  typo_divide: (a) => typoDomain('typo_divide', a),
  typo_convert_to_path: (a) => typoDomain('typo_convert_to_path', a),
  typo_set_canvas_size: (a) => typoDomain('typo_set_canvas_size', a),
  typo_set_camera: (a) => typoDomain('typo_set_camera', a),
  typo_set_camera_animation: (a) => typoDomain('typo_set_camera_animation', a),
  typo_layout: (a) => typoDomain('typo_layout', a),
  typo_set_background: (a) => typoDomain('typo_set_background', a),
  typo_set_theme: (a) => typoDomain('typo_set_theme', a),
  typo_save_theme: (a) => typoDomain('typo_save_theme', a),
  typo_remove_theme: (a) => typoDomain('typo_remove_theme', a),
  typo_replace_doc: (a) => typoDomain('typo_replace_doc', a),
};

/** 写工具 → 域。**未知工具 fail-closed 到 `global`**（并由守卫测试兜住漏登记）。 */
export function writeTargetsOf(name: string, args: Record<string, unknown>): string[] {
  const fn = WRITE_TARGETS[name];
  return fn ? fn(args) : [GLOBAL_DOMAIN];
}

export interface WriteClaim {
  ownerId: string;
  domains: Set<string>;
}

export type WriteVerdict =
  | { ok: true }
  | { ok: false; reason: 'scope' | 'reserved' | 'tx-closed' | 'unresolved'; target: string; owner: string };

/**
 * 冲突判定（纯函数）。
 *
 * `claims` 不含调用者自己时按「父代理」处理 —— 父的隐式 claim 是全域，
 * 所以它只需要检查别人的 reservation。
 */
export function checkWrite(
  claims: readonly WriteClaim[],
  ownerId: string,
  targets: readonly string[],
  opts: { txOpen: boolean },
): WriteVerdict {
  const isParent = ownerId === PARENT_OWNER;
  const others = claims.filter((c) => c.ownerId !== ownerId);

  if (!targets.length) {
    // 解析不出目标。父代理单干时合法；只要还有别的 claim 在，就没人能证明不冲突。
    if (!isParent) return { ok: false, reason: 'unresolved', target: '(unresolved)', owner: ownerId };
    if (others.length) return { ok: false, reason: 'unresolved', target: '(unresolved)', owner: ownerId };
    return { ok: true };
  }

  if (!isParent) {
    // 父轮已经不在事务里 ⇒ 子代理的写会变成一笔笔独立撤销记录，撤销语义断裂。
    if (!opts.txOpen) return { ok: false, reason: 'tx-closed', target: targets[0]!, owner: ownerId };
    const own = claims.find((c) => c.ownerId === ownerId);
    const ownDomains = own?.domains ?? new Set<string>();
    for (const t of targets) {
      if (!ownDomains.has(t)) return { ok: false, reason: 'scope', target: t, owner: ownerId };
    }
  }

  for (const other of others) {
    for (const t of targets) {
      if (other.domains.has(t)) return { ok: false, reason: 'reserved', target: t, owner: other.ownerId };
    }
  }
  return { ok: true };
}

export interface WriteFence {
  /** 登记一笔 reservation。空 domains = 纯只读，不占位。 */
  reserve(ownerId: string, domains: readonly string[]): void;
  release(ownerId: string): void;
  check(ownerId: string, targets: readonly string[]): WriteVerdict;
  /** 有没有除父代理之外的活跃 claim（决定「解析不出目标」要不要拒绝）。 */
  active(): boolean;
  claims(): readonly WriteClaim[];
}

export function createWriteFence(opts: { txOpen: () => boolean }): WriteFence {
  const claims = new Map<string, WriteClaim>();
  const view = (): WriteClaim[] => [...claims.values()];
  return {
    reserve(ownerId, domains) {
      if (!domains.length) return;
      claims.set(ownerId, { ownerId, domains: new Set(domains) });
    },
    release(ownerId) {
      claims.delete(ownerId);
    },
    check(ownerId, targets) {
      return checkWrite(view(), ownerId, targets, { txOpen: opts.txOpen() });
    },
    active() {
      return claims.size > 0;
    },
    claims: view,
  };
}

/** 两个 scope 是否有交集（spawn 时判冲突用）。 */
export function domainsOverlap(a: readonly string[], b: readonly string[]): boolean {
  if (!a.length || !b.length) return false;
  const set = new Set(a);
  return b.some((d) => set.has(d));
}

/* ------------------------------------------------------------ 结果契约 */

export interface SubagentResult {
  summary: string;
  evidence: string[];
  gaps: string[];
  needsDecision: string | null;
  /** 模型没按契约输出（原文被当成 summary）。 */
  unstructured: boolean;
}

function strArray(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  return v
    .filter((x): x is string => typeof x === 'string' && x.trim() !== '')
    .map((x) => x.trim())
    .slice(0, 24);
}

/** 从（可能带 fence / 前后废话的）最终回答里抠出契约对象。永不抛。 */
export function parseSubagentResult(text: string): SubagentResult {
  const raw = (text ?? '').trim();
  if (!raw) {
    return { summary: '', evidence: [], gaps: ['subagent returned nothing'], needsDecision: null, unstructured: true };
  }
  const candidates: string[] = [];
  const fenced = /```(?:json)?\s*\n([\s\S]*?)```/i.exec(raw);
  if (fenced?.[1]) candidates.push(fenced[1]);
  const first = raw.indexOf('{');
  const last = raw.lastIndexOf('}');
  if (first >= 0 && last > first) candidates.push(raw.slice(first, last + 1));
  candidates.push(raw);

  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate) as Record<string, unknown>;
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) continue;
      const summary = typeof parsed.summary === 'string' ? parsed.summary.trim() : '';
      if (!summary) continue;
      return {
        summary: summary.slice(0, SUMMARY_MAX_CHARS),
        evidence: strArray(parsed.evidence),
        gaps: strArray(parsed.gaps),
        needsDecision:
          typeof parsed.needsDecision === 'string' && parsed.needsDecision.trim()
            ? parsed.needsDecision.trim()
            : null,
        unstructured: false,
      };
    } catch {
      /* 试下一个候选 */
    }
  }
  return {
    summary: raw.slice(0, SUMMARY_MAX_CHARS),
    evidence: [],
    gaps: ['result not structured (the subagent did not return the JSON contract)'],
    needsDecision: null,
    unstructured: true,
  };
}

/* --------------------------------------------------------------- 宿主接口 */

export interface SpawnRequest {
  preset: SubagentPreset;
  task: string;
  scope?: SubagentScope | null;
  canWrite?: boolean;
  /** `wait` = 起完立刻堵住等结果（省一次工具往返）。 */
  mode?: 'async' | 'wait';
}

/** 会话层关心「把排队的结果取走」+「这一轮要不要暴露 spawn 工具」。 */
export interface SubagentInbox {
  takeResults(): string[];
  cancelAll(): void;
  /** 设置开关。`false` 时 `spawn_agent` 从工具表消失。 */
  available(): boolean;
  /**
   * 本轮子代理烧掉的 token。父轮的 `turn-end` 把它加进去 —— 不加的话用户看到
   * 的账只有一半（子代理有自己的上下文窗口，花的是同一张卡）。
   */
  usage(): { hit: number; miss: number; out: number };
  /** 每轮开始时清零（父会话在 `send()` 入口调）。 */
  resetUsage(): void;
}

/** 执行器需要的能力。由 `subagent-runner.ts` 实现。 */
export interface SubagentHost extends SubagentInbox {
  spawn(req: SpawnRequest): Promise<ToolOutcome>;
  wait(agentId: string | undefined, signal?: AbortSignal): Promise<ToolOutcome>;
  cancel(agentId: string): Promise<ToolOutcome>;
}
