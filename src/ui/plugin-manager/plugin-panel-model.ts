/**
 * plugin-panel-model.ts — 插件管理面板的**纯逻辑**：把宿主的 `LoadedPlugin[]`
 * 翻译成可以直接画的几行字。
 *
 * 与 `effect-picker/picker-model.ts` 同一条纪律：`tr` 从外面传进来，于是
 * 「某个问题码显示成什么句子」「停用的插件显示什么」都能脱离 DOM 单测 ——
 * 而这些恰好是最容易出错又最难手工复现的部分（要造一个坏插件才看得到）。
 *
 * ## 两张 `Record<Code, MessageKey>` 是刻意的
 *
 * 它们把「码 → 句子」的映射写成**穷尽的**：`PluginIssueCode` / `PluginFailure['code']`
 * 多一个新值时，这两张表会**编译报错**。否则新码的表现是界面上出现
 * `pl.issue.xxx` 这样的键名，而那要等到真有人踩中才被发现。
 */

import type { PluginDefIssue } from '../../core/plugin-id';
import type { LoadedPlugin, PluginFailure } from '../../plugins/host';
import type { PluginIssue, PluginIssueCode } from '../../plugins/manifest';
import type { PluginPanelKind } from '../../plugins/api-types';
import { resolveLabel } from '../../i18n/label';
import type { MessageVars } from '../../i18n/format';
import type { MessageKey } from '../../i18n/locales';
import type { TypoHookFailure, TypoHookPhase } from '../../typography/hook-registry';

export type Translate = (key: MessageKey, vars?: MessageVars) => string;

const ISSUE_KEY: Record<PluginIssueCode, MessageKey> = {
  'not-object': 'pl.issue.notObject',
  'bad-format': 'pl.issue.badFormat',
  'bad-api-version': 'pl.issue.badApiVersion',
  'bad-id': 'pl.issue.badId',
  'bad-name': 'pl.issue.badName',
  'bad-list': 'pl.issue.badList',
  'no-defs': 'pl.issue.noDefs',
  'bad-def': 'pl.issue.badDef',
  'duplicate-id': 'pl.issue.duplicateId',
  'bad-param': 'pl.issue.badParam',
  'bad-shader': 'pl.issue.badShader',
  'unknown-meta': 'pl.issue.unknownMeta',
  'read-failed': 'pl.issue.readFailed',
  'compile-failed': 'pl.issue.compileFailed',
  'dropped-uniform': 'pl.issue.droppedUniform',
  'bad-aux': 'pl.issue.badAux',
  'bad-hook': 'pl.issue.badHook',
  'hook-failed': 'pl.issue.hookFailed',
  'bad-panel': 'pl.issue.badPanel',
  'bad-action': 'pl.issue.badAction',
  'bad-activate': 'pl.issue.badActivate',
  'panel-failed': 'pl.issue.panelFailed',
  'action-failed': 'pl.issue.actionFailed',
  'activate-failed': 'pl.issue.activateFailed',
};

const HOOK_PHASE_KEY: Record<TypoHookPhase, MessageKey> = {
  open: 'pl.hookPhase.open',
  render: 'pl.hookPhase.render',
  save: 'pl.hookPhase.save',
};

const DEF_ISSUE_KEY: Record<PluginDefIssue['code'], MessageKey> = {
  'missing-id': 'pl.def.missingId',
  'duplicate-id': 'pl.def.duplicateId',
  'builtin-conflict': 'pl.def.builtinConflict',
};

const FAILURE_KEY: Record<PluginFailure['code'], MessageKey> = {
  'import-failed': 'pl.fail.importFailed',
  timeout: 'pl.fail.timeout',
  'not-a-plugin': 'pl.fail.notAPlugin',
  'invalid-manifest': 'pl.fail.invalidManifest',
  'read-failed': 'pl.fail.readFailed',
};

const STATUS_KEY: Record<LoadedPlugin['status'], MessageKey> = {
  ok: 'pl.status.ok',
  partial: 'pl.status.partial',
  failed: 'pl.status.failed',
  disabled: 'pl.status.disabled',
};

export type PluginTone = 'ok' | 'warn' | 'error' | 'muted';

const STATUS_TONE: Record<LoadedPlugin['status'], PluginTone> = {
  ok: 'ok',
  partial: 'warn',
  failed: 'error',
  disabled: 'muted',
};

export interface PluginRow {
  id: string;
  /** 展示名。停用 / 加载失败时回落到 id（那时读不到清单）。 */
  name: string;
  /** 版本 · 作者 · 许可，有哪项写哪项。都没有时是空串。 */
  meta: string;
  /** 「2 个特效 · 1 个生成器」。两个都是 0 时是空串。 */
  counts: string;
  /** 这个插件声明的面板（无 icon 的只能从这里打开）。 */
  panels: PluginPanelRow[];
  /** 面板 / 动作的计数（管理器里一行摘要）。 */
  panelCount: number;
  actionCount: number;
  statusLabel: string;
  tone: PluginTone;
  /** 已翻译的问题行（含失败原因）。可能为空。 */
  issues: string[];
  /** 运行期钩子失败（打开 / 保存 / 渲染时被拒绝的那几次）。 */
  runtimeIssues: string[];
  enabled: boolean;
  /** 停用时的额外说明（它为什么没有名字）。 */
  disabledNote: string | null;
}

/** 管理器里可点开的一行面板。`key` 是宿主使用的对外 id（`pluginId/panelId`）。 */
export interface PluginPanelRow {
  key: string;
  id: string;
  name: string;
  icon: string | null;
  kind: PluginPanelKind;
}

/** 一条 issue → 一句可读的话。 */
export function issueText(issue: PluginIssue, tr: Translate): string {
  // `bad-def` 的 detail 是**另一个码**（注册批次返回的），要再翻一层。
  if (issue.code === 'bad-def') {
    const def = issue.detail as PluginDefIssue['code'] | undefined;
    const reason =
      def && def in DEF_ISSUE_KEY ? tr(DEF_ISSUE_KEY[def as PluginDefIssue['code']]) : (issue.detail ?? '');
    return tr('pl.issue.badDef', { path: issue.path ?? '', reason });
  }
  return tr(ISSUE_KEY[issue.code], {
    path: issue.path ?? '',
    detail: issue.detail ?? '',
  });
}

function metaOf(p: LoadedPlugin, tr: Translate): string {
  const parts: string[] = [];
  if (p.version) parts.push(`${tr('pl.version')} ${p.version}`);
  if (p.author) parts.push(p.author);
  if (p.license) parts.push(`${tr('pl.license')} ${p.license}`);
  return parts.join(' · ');
}

function countsOf(p: LoadedPlugin, tr: Translate): string {
  const parts: string[] = [];
  if (p.effectCount > 0) parts.push(tr('pl.countEffects', { n: p.effectCount }));
  if (p.generatorCount > 0) parts.push(tr('pl.countGenerators', { n: p.generatorCount }));
  if (p.hookCount > 0) parts.push(tr('pl.countHooks', { n: p.hookCount }));
  if (p.panels.length > 0) parts.push(tr('pl.countPanels', { n: p.panels.length }));
  if (p.actions.length > 0) parts.push(tr('pl.countActions', { n: p.actions.length }));
  return parts.join(' · ');
}

/**
 * 面板名走 `resolveLabel`，不直接 `tr()`：插件给的是运行期字面量。
 * 面板的可用性不再单独判 —— 渲染失败落在面板体内，管理器里仍然能点开看错误。
 */
function panelsOf(p: LoadedPlugin, tr: Translate): PluginPanelRow[] {
  return p.panels.map((panel) => ({
    key: `${p.id}/${panel.id}`,
    id: panel.id,
    name: resolveLabel(panel.name, tr),
    icon: panel.icon,
    kind: panel.kind,
  }));
}

/**
 * 建造面板上的每一行。
 *
 * 顺序沿用宿主给的顺序（按 id 排序）：插件之间没有优先级，按 id 排是唯一
 * 稳定的顺序 —— 用「导入时间」的话，两次打开同一个工程顺序会不一样。
 */
export function buildPluginRows(
  plugins: readonly LoadedPlugin[],
  tr: Translate,
  hookFailures: readonly TypoHookFailure[] = [],
): PluginRow[] {
  return plugins.map((p) => {
    const issues = p.failure
      ? [tr(FAILURE_KEY[p.failure.code], { detail: p.failure.detail })]
      : p.issues.map((i) => issueText(i, tr));
    const runtimeIssues = hookFailures
      .filter((f) => f.key.startsWith(`${p.id}/`))
      .map((f) =>
        tr('pl.hookRuntime', {
          phase: tr(HOOK_PHASE_KEY[f.phase]),
          detail: f.detail,
          n: f.repeats,
        }),
      );
    return {
      id: p.id,
      name: p.name ?? p.id,
      meta: metaOf(p, tr),
      counts: countsOf(p, tr),
      panels: panelsOf(p, tr),
      panelCount: p.panels.length,
      actionCount: p.actions.length,
      statusLabel: tr(STATUS_KEY[p.status]),
      tone: STATUS_TONE[p.status],
      issues,
      runtimeIssues,
      enabled: p.enabled,
      // 停用时不导入它 ⇒ 读不到名字与描述。这个空白必须解释，否则看起来像加载坏了。
      disabledNote: p.enabled || p.name ? null : tr('pl.disabledNotice'),
    };
  });
}

/**
 * 缺失插件的提示句。
 *
 * 用「、」连接而不是逗号：id 里允许出现 `-` 与 `.`，中文顿号在视觉上把
 * 每个 id 分得开，而逗号会让 `a.b, c` 这种连成一片。
 */
export function missingText(pluginIds: readonly string[], tr: Translate): string {
  return tr('pl.missing.body', { ids: pluginIds.join('、') });
}

/** 面板顶部的一行统计（「3 个插件，其中 1 个有问题」）。 */
export function summaryText(rows: readonly PluginRow[], tr: Translate): string {
  const bad = rows.filter((r) => r.tone === 'error' || r.tone === 'warn').length;
  if (rows.length === 0) return tr('pl.empty');
  return bad > 0 ? tr('pl.summaryWithIssues', { total: rows.length, bad }) : tr('pl.summary', { total: rows.length });
}
