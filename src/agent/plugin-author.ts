/**
 * plugin-author.ts — 让 agent **写插件**的那一层：校验 → 试挂 → 安装 / 移除。
 *
 * ## 为什么「试挂」不是「直接写盘」
 *
 * 插件是运行在主 realm 的任意代码（`src/plugins/AGENTS.md` 的安全边界）。把
 * 「生成 → 执行」交给模型一步做完，等于让它在你不知情时跑代码。所以分两级：
 *
 *   1. `pluginTry`   —— 载入内存 + 真 GL 编译校验，可立刻加到时间轴上预览；
 *      模型拿得到结构化错误，能自修复（这是「生成可用插件」的关键闭环）。
 *   2. `pluginInstall` —— 写进 `<工程>/plugins/<id>.js`，**必须**显式确认。
 *
 * 两级都要经过面板上的告知（插件没有沙箱）。控制平面这一侧只负责「没确认就
 * 返回 `needs-approval`」，不自己弹框 —— 它不知道界面长什么样。
 *
 * ## 草稿区
 *
 * 草稿（源码字节）只活在控制平面实例的内存里：它是「这一次会话正在迭代的那份」，
 * 不是工程数据。写进工程之后磁盘才是真源（与 `project/plugins.ts` 同一立场：
 * 不做台账、不做哈希）。
 */

import { isValidPluginSegment } from '../core/plugin-id';
import { listEffects } from '../effects/registry';
import { listGenerators } from '../algos/registry';
import { listTypoHooks } from '../typography/hook-registry';
import { tr } from '../i18n/index.svelte';
import { checkPluginSource } from './plugin-check';
import { applyUniqueEdit, grepSource, sourceLines, viewSource } from './plugin-text';
import { ControlFailure } from './types';
import type {
  AgentPluginHost,
  PluginCheckView,
  PluginEditResult,
  PluginGrepResult,
  PluginInfoView,
  PluginIssueView,
  PluginSourceOrigin,
  PluginTryResult,
  PluginViewResult,
} from './types';

/** 单文件插件的体积上限。超过这个数多半是模型把整段 base64 塞进来了。 */
export const MAX_PLUGIN_BYTES = 256 * 1024;

export interface PluginDraft {
  pluginId: string;
  name: string;
  source: string;
  bytes: Uint8Array;
}

export type DraftStore = Map<string, PluginDraft>;

/**
 * 读已安装插件源码的注入回调（`ControlContext.readPluginSource`）。
 * null = 这个宿主没有磁盘能力（headless / 未绑定工程目录）。
 */
export type SourceReader = ((pluginId: string) => Promise<string | null>) | null;

export interface PluginSourceRef {
  host: AgentPluginHost | null;
  drafts: DraftStore;
  readSource: SourceReader;
}

function encode(source: string): Uint8Array {
  return new TextEncoder().encode(source);
}

/** 同一份清单可能同时报 manifest 与 compile 的问题，去重后按 path 排序。 */
function mergeIssues(...lists: PluginIssueView[][]): PluginIssueView[] {
  const seen = new Set<string>();
  const out: PluginIssueView[] = [];
  for (const list of lists) {
    for (const i of list) {
      const key = `${i.code}|${i.path ?? ''}|${i.detail ?? ''}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ code: i.code, ...(i.path ? { path: i.path } : {}), ...(i.detail ? { detail: i.detail } : {}) });
    }
  }
  return out.sort((a, b) => (a.path ?? '').localeCompare(b.path ?? ''));
}

/** 这个插件注册进注册表的**限定 id**（`${pluginId}/${localId}`）。 */
function qualifiedIds(pluginId: string): {
  effects: string[];
  generators: string[];
  hooks: string[];
} {
  return {
    effects: listEffects().filter((e) => e.pluginId === pluginId).map((e) => e.id),
    generators: listGenerators().filter((g) => g.pluginId === pluginId).map((g) => g.id),
    hooks: listTypoHooks().filter((h) => h.pluginId === pluginId).map((h) => h.key),
  };
}

function infoOf(host: AgentPluginHost, pluginId: string): PluginInfoView | null {
  const info = host.get(pluginId);
  if (!info) return null;
  return {
    id: info.id,
    name: info.name,
    enabled: info.enabled,
    status: info.status,
    effectCount: info.effectCount,
    generatorCount: info.generatorCount,
    hookCount: info.hookCount ?? 0,
    issues: mergeIssues(info.issues),
    fileName: info.fileName,
    draft: false,
  };
}

/* --------------------------------------------------------------- 源码 */

function sourceId(raw: unknown): string {
  const id = String(raw ?? '').trim();
  if (!isValidPluginSegment(id)) {
    throw new ControlFailure('invalid-argument', tr('agent.plugin.badId', { id }), {
      pattern: '[a-z0-9][a-z0-9._-]*',
    });
  }
  return id;
}

/**
 * 取「这次要操作的那份源码」：草稿优先，其次磁盘上的已安装文件。
 *
 * 草稿优先是刻意的：`plugin_edit` 之后模型继续 `plugin_view` / `plugin_check`
 * 必须看到自己刚改的那份。磁盘只在「这次会话还没碰过这个插件」时出场 ——
 * 已安装的插件（含停用的）不需要先试挂就能读。
 */
async function resolveSource(opts: PluginSourceRef & { pluginId: string }): Promise<{
  pluginId: string;
  name: string;
  source: string;
  origin: PluginSourceOrigin;
}> {
  const id = sourceId(opts.pluginId);
  const draft = opts.drafts.get(id);
  if (draft) return { pluginId: id, name: draft.name, source: draft.source, origin: 'draft' };

  const info = opts.host?.get(id) ?? null;
  if (!info) throw new ControlFailure('not-found', tr('agent.plugin.notFound', { id }), { pluginId: id });
  const source = opts.readSource ? await opts.readSource(id) : null;
  if (source === null) {
    throw new ControlFailure('not-found', tr('agent.plugin.noSourceFile', { id }), { pluginId: id });
  }
  return { pluginId: id, name: info.name ?? id, source, origin: 'file' };
}

/* --------------------------------------------------------------- 试挂 */

export async function tryPlugin(opts: {
  host: AgentPluginHost | null;
  projectKey: string | null;
  drafts: DraftStore;
  readSource?: SourceReader;
  input: { id: string; name: string; source?: string };
  /** 用户已确认「这次可以在页面里执行」。默认 false = 返回 needs-approval。 */
  confirm?: boolean;
}): Promise<PluginTryResult> {
  const { host, projectKey, drafts } = opts;
  if (!host) throw new ControlFailure('not-ready', tr('agent.plugin.noHost'));

  /*
   * `source` 省略时用草稿（没有草稿再退到磁盘）。这不是便利功能：
   * Agent 起不了终端，改插件只能走 `plugin_edit` 的局部替换 —— 试挂若还要求
   * 它把整份源码复述一遍，那「只改一行」既没省下 token，又给了模型一次
   * 把无关处改回去的机会。
   */
  const provided = typeof opts.input.source === 'string' && opts.input.source.trim() !== '';
  const resolved = provided
    ? { pluginId: sourceId(opts.input.id), name: opts.input.name || sourceId(opts.input.id), source: opts.input.source! }
    : await resolveSource({ ...opts, readSource: opts.readSource ?? null, pluginId: opts.input.id });
  const id = resolved.pluginId;
  const source = resolved.source;
  const name = opts.input.name || resolved.name || id;

  const bytes = encode(source);
  if (bytes.byteLength > MAX_PLUGIN_BYTES) {
    throw new ControlFailure('invalid-argument', tr('agent.plugin.tooLarge', { bytes: bytes.byteLength, max: MAX_PLUGIN_BYTES }));
  }

  /*
   * 确认必须挡在 `host.importBytes` **之前**。
   *
   * 试挂不是「先建个对象看看」：`importBytes` 会 `import()` 这份源码，
   * 也就是**立刻在主世界执行它**。晚一步再拦，代码已经跑过了，
   * 「未确认时没有产生实例」这条判据根本不可能成立。
   *
   * 控制平面永远要求显式 confirm；「本次会话允许试挂」只活在 UI 会话里
   * （`agent-state` 自己决定要不要弹卡），不进入协议。
   */
  if (opts.confirm !== true) {
    throw new ControlFailure('needs-approval', tr('agent.plugin.tryRisk'), {
      kind: 'try',
      pluginId: id,
      name,
      sourceBytes: bytes.byteLength,
    });
  }

  // 文件名用清单 id 的猜测值；真正的 id 以清单为准（outcome.pluginId）。
  const outcome = await host.importBytes(`${id}.js`, bytes, projectKey);
  const info = host.get(outcome.pluginId);

  const registered = qualifiedIds(outcome.pluginId);
  const issues = mergeIssues(outcome.issues, info?.issues ?? []);
  const status = info?.status ?? (outcome.ok ? 'ok' : 'failed');
  const ok = status === 'ok' || status === 'partial';

  /*
   * 校验没过也留着源码：模型下一步要基于它改，而面板要能显示「哪一行」。
   * 草稿 ≠ 已安装 —— 安装必须走 `installPlugin` 的确认。
   */
  drafts.set(outcome.pluginId, {
    pluginId: outcome.pluginId,
    name: name || info?.name || outcome.pluginId,
    source,
    bytes,
  });

  return {
    pluginId: outcome.pluginId,
    ok,
    status,
    effects: registered.effects,
    generators: registered.generators,
    hooks: registered.hooks,
    issues,
    verified: info?.verified ?? false,
    draft: true,
  };
}

/* ------------------------------------------------------ 阅读 / 搜索 / 编辑 */

/**
 * 分页读源码。**带行号**，每页末尾写明还有多少行、下一页的 `offset` 是多少 ——
 * 模型没有终端，行号是它与 `plugin_edit` / `plugin_check` 之间的唯一坐标。
 */
export async function viewPlugin(
  opts: PluginSourceRef & { pluginId: string; offset?: number; limit?: number },
): Promise<PluginViewResult> {
  const resolved = await resolveSource(opts);
  const view = viewSource(resolved.source, opts.offset, opts.limit);
  return {
    pluginId: resolved.pluginId,
    origin: resolved.origin,
    from: view.from,
    to: view.to,
    total: view.total,
    hasMore: view.hasMore,
    nextOffset: view.nextOffset,
    text: view.text,
  };
}

/** 在插件源码里按正则找行。`total` 是截断前的命中数。 */
export async function grepPlugin(
  opts: PluginSourceRef & {
    pluginId: string;
    pattern: string;
    ignoreCase?: boolean;
    context?: number;
    max?: number;
  },
): Promise<PluginGrepResult> {
  const raw = String(opts.pattern ?? '');
  if (!raw) {
    throw new ControlFailure('invalid-argument', tr('agent.plugin.badPattern', { detail: 'empty' }));
  }
  let pattern: RegExp;
  try {
    pattern = new RegExp(raw, opts.ignoreCase ? 'i' : '');
  } catch (e) {
    throw new ControlFailure(
      'invalid-argument',
      tr('agent.plugin.badPattern', { detail: e instanceof Error ? e.message : String(e) }),
      { pattern: raw },
    );
  }
  const resolved = await resolveSource(opts);
  const result = grepSource(resolved.source, pattern, { context: opts.context, max: opts.max });
  return { pluginId: resolved.pluginId, origin: resolved.origin, ...result };
}

/**
 * 唯一匹配的字面量替换。**只改内存草稿，不执行、不写盘** —— 生效要等
 * `plugin_try`（它仍然过用户确认），落盘要等 `plugin_install`。
 */
export async function editPlugin(
  opts: PluginSourceRef & { pluginId: string; oldString: string; newString: string },
): Promise<PluginEditResult> {
  const resolved = await resolveSource(opts);
  const result = applyUniqueEdit(
    resolved.source,
    String(opts.oldString ?? ''),
    String(opts.newString ?? ''),
  );
  if (result.ok === false) {
    switch (result.code) {
      case 'empty-old':
        throw new ControlFailure('invalid-argument', tr('agent.plugin.editEmpty'));
      case 'same':
        throw new ControlFailure('invalid-argument', tr('agent.plugin.editSame'));
      case 'not-found':
        throw new ControlFailure('not-found', tr('agent.plugin.editNotFound', { id: resolved.pluginId }), {
          pluginId: resolved.pluginId,
        });
      case 'ambiguous':
        throw new ControlFailure(
          'invalid-argument',
          tr('agent.plugin.editAmbiguous', { count: String(result.lines?.length ?? 0) }),
          { pluginId: resolved.pluginId, lines: result.lines ?? [] },
        );
    }
  }

  const bytes = encode(result.source);
  if (bytes.byteLength > MAX_PLUGIN_BYTES) {
    throw new ControlFailure(
      'invalid-argument',
      tr('agent.plugin.tooLarge', { bytes: bytes.byteLength, max: MAX_PLUGIN_BYTES }),
    );
  }

  opts.drafts.set(resolved.pluginId, {
    pluginId: resolved.pluginId,
    name: resolved.name,
    source: result.source,
    bytes,
  });
  return {
    pluginId: resolved.pluginId,
    origin: resolved.origin,
    line: result.line,
    lines: sourceLines(result.source).length,
    bytes: bytes.byteLength,
  };
}

/** 静态检查：真语法解析（acorn），**不执行**源码。 */
export async function checkPlugin(
  opts: PluginSourceRef & { pluginId: string },
): Promise<PluginCheckView> {
  const resolved = await resolveSource(opts);
  const checked = await checkPluginSource(resolved.source);
  return { pluginId: resolved.pluginId, origin: resolved.origin, ...checked };
}

/* --------------------------------------------------------------- 安装 */

export interface InstallResult {
  pluginId: string;
  /** 有没有写进工程目录。false = 仅本次会话可用（未绑定目录）。 */
  persisted: boolean;
  effects: string[];
  generators: string[];
  /** 已注册的文档钩子限定 id。 */
  hooks: string[];
}

export async function installPlugin(opts: {
  host: AgentPluginHost | null;
  drafts: DraftStore;
  projectKey: string | null;
  persist: ((pluginId: string, source: string) => Promise<boolean>) | null;
  pluginId: string;
  confirm: boolean;
}): Promise<InstallResult> {
  const { host, drafts, pluginId, confirm } = opts;
  if (!host) throw new ControlFailure('not-ready', tr('agent.plugin.noHost'));
  const draft = drafts.get(pluginId);
  if (!draft) throw new ControlFailure('not-found', tr('agent.plugin.noDraft', { id: pluginId }), { pluginId });

  const info = host.get(pluginId);
  if (!info || (info.status !== 'ok' && info.status !== 'partial')) {
    throw new ControlFailure('unsupported', tr('agent.plugin.blocked', { id: pluginId, status: info?.status ?? 'missing' }), {
      pluginId,
      issues: info?.issues ?? [],
    });
  }
  if (!confirm) {
    throw new ControlFailure('needs-approval', tr('agent.plugin.needsApproval'), {
      kind: 'install',
      pluginId,
      name: draft.name,
      effectCount: info.effectCount,
      generatorCount: info.generatorCount,
      sourceBytes: draft.bytes.byteLength,
    });
  }
  if (!opts.projectKey) throw new ControlFailure('no-project', tr('agent.plugin.noProject'));

  let persisted = false;
  if (opts.persist) persisted = await opts.persist(pluginId, draft.source);
  /*
   * 只有真写进磁盘才 `markPersisted`。内存安装也记成「有文件名」的话，
   * `plugin_discard` 会以为它已经装过而拒绝卸载（表现是「丢弃了但还在」）。
   */
  if (persisted) host.markPersisted(pluginId, `${pluginId}.js`);

  const registered = qualifiedIds(pluginId);
  return {
    pluginId,
    persisted,
    effects: registered.effects,
    generators: registered.generators,
    hooks: registered.hooks,
  };
}

/* --------------------------------------------------------------- 丢弃 / 移除 */

export async function discardPlugin(opts: {
  host: AgentPluginHost | null;
  drafts: DraftStore;
  unload: ((pluginId: string) => Promise<void>) | null;
  pluginId: string;
}): Promise<{ discarded: boolean; stillInstalled: boolean }> {
  const { host, drafts, pluginId } = opts;
  drafts.delete(pluginId);
  const info = host?.get(pluginId) ?? null;
  // 已经写进磁盘的插件不能被「丢弃草稿」顺手卸掉 —— 用户装过它。
  const stillInstalled = Boolean(info?.fileName);
  if (info && !stillInstalled && opts.unload) await opts.unload(pluginId);
  return { discarded: true, stillInstalled };
}

export async function removePlugin(opts: {
  host: AgentPluginHost | null;
  drafts: DraftStore;
  remove: ((pluginId: string) => Promise<void>) | null;
  pluginId: string;
}): Promise<{ removed: boolean }> {
  const { host, drafts, pluginId } = opts;
  if (!host?.get(pluginId) && !drafts.has(pluginId)) {
    throw new ControlFailure('not-found', tr('agent.plugin.notFound', { id: pluginId }));
  }
  drafts.delete(pluginId);
  if (opts.remove) await opts.remove(pluginId);
  return { removed: true };
}

export function listPlugins(host: AgentPluginHost | null, drafts: DraftStore): PluginInfoView[] {
  if (!host) return [];
  const out: PluginInfoView[] = [];
  for (const p of host.list()) {
    const info = infoOf(host, p.id);
    if (info) out.push({ ...info, draft: drafts.has(p.id) });
  }
  return out;
}

/** 面板审批卡要显示源码（用户得看一眼自己批准了什么）。 */
export function draftSource(drafts: DraftStore, pluginId: string): string | null {
  return drafts.get(pluginId)?.source ?? null;
}
