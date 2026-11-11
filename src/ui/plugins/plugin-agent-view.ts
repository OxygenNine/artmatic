/**
 * plugin-agent-view.ts — `LoadedPlugin` → `AgentLoadedPlugin` 的**形状翻译**。
 *
 * 为什么需要这一层：插件清单里的 `name` / `labelKey` 是 `Label`（运行期字符串，
 * 可能是 `{ text }`），而 Agent 面要的是已经翻好的纯字符串 —— 模型不解析
 * `Label`，也不会自己去查 i18n。两边**结构不同**（不是「多一个字段」），
 * 所以只能在装配点转一次。
 *
 * `AgentPluginHost` 的 `list()` / `get()` 由 `app-boot.ts` 用这里的函数包一层；
 * `plugins/` 自身不 import `agent/`（依赖方向），`agent/` 也不 import `plugins/`
 * （结构类型）—— 翻译发生在 `ui/`，正是两边都能看见的那一层。
 */

import { resolveLabel } from '../../i18n/label';
import { tr } from '../../i18n/index.svelte';
import type { LoadedPlugin } from '../../plugins/host';
import type {
  AgentLoadedPlugin,
  AgentPluginActionView,
  AgentPluginPanelView,
} from '../../agent/types';

function panelView(panel: LoadedPlugin['panels'][number]): AgentPluginPanelView {
  return {
    id: panel.id,
    name: resolveLabel(panel.name, tr),
    icon: panel.icon,
    kind: panel.kind,
  };
}

function actionView(action: LoadedPlugin['actions'][number]): AgentPluginActionView {
  return {
    id: action.id,
    name: resolveLabel(action.name, tr),
    desc: action.desc ? resolveLabel(action.desc, tr) : null,
    params: action.params.map((p) => ({
      key: p.key,
      label: resolveLabel(p.labelKey, tr),
      type: p.type,
      defaultValue: p.defaultValue,
      ...(p.min === undefined ? {} : { min: p.min }),
      ...(p.max === undefined ? {} : { max: p.max }),
      ...(p.options
        ? { options: p.options.map((o) => ({ value: o.value, label: resolveLabel(o.labelKey, tr) })) }
        : {}),
    })),
  };
}

export function agentPluginView(p: LoadedPlugin): AgentLoadedPlugin {
  return {
    id: p.id,
    name: p.name,
    author: p.author,
    version: p.version,
    license: p.license,
    fileName: p.fileName,
    enabled: p.enabled,
    status: p.status,
    effectCount: p.effectCount,
    generatorCount: p.generatorCount,
    hookCount: p.hookCount,
    panels: p.panels.map(panelView),
    actions: p.actions.map(actionView),
    activated: p.activated,
    issues: p.issues.map((i) => ({ code: i.code, path: i.path, detail: i.detail })),
    verified: p.verified,
    failure: p.failure,
  };
}
