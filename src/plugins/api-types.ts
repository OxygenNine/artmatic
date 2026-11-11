/**
 * api-types.ts — 插件向宿主声明的**面板 / 动作 / 宿主 API** 的类型契约。
 *
 * 单独一个文件的理由与 `typography/hook-types.ts` 完全相同：
 * `plugins/manifest.ts` 是**纯校验层**（要能在 Node 里单测、不许拖 DOM / GL /
 * 注册表进来），而 `ui/` 那一侧要实现这套 API。把类型放在这里，两边都只依赖它。
 *
 * ## 三条约定
 *
 * 1. **这里只有类型**（外加两个 const 清单），没有运行时实现。谁实现谁负责
 *    （`ui/plugins/plugin-bridge.ts`）。
 * 2. **读是冻结快照，写只走命令**。`snapshot()` / `doc()` 返回的对象是深拷贝 +
 *    `Object.freeze` 的（与 `hook-registry.ts::frozenHookInput` 同口径）：
 *    插件改它会在严格模式下抛错，而不是悄悄改掉 store 里那份。想改就走
 *    `typography.command()` / `timeline.command()`，那条路会经过控制平面的校验与 `store.commit`，
 *    于是撤销栈、脏标记、`coerceDocument` 的唯一性都不必复制第二份。
 * 3. **没有逐帧事件**。`on()` 只收 `project` / `typography` / `save` 三种
 *    （内容版本级别），且回调按微任务合并。暴露播放头等于把插件拉进 rAF 循环，
 *    直接违反根 AGENTS §1.4。
 */

import type { Label } from '../i18n/label';
import type { Project } from '../core/schema';
import type { TypographyDocument } from '../typography/document';

/* ------------------------------------------------------------ 只读视图 */

/** 递归只读。工程 / 排版文档都是纯 JSON，函数与 Map 不出现，所以这样够了。 */
export type DeepReadonly<T> = T extends (infer U)[]
  ? ReadonlyArray<DeepReadonly<U>>
  : T extends object
    ? { readonly [K in keyof T]: DeepReadonly<T[K]> }
    : T;

/** 画在宿主里的只读快照类型（实际对象已冻结，这里只是让作者少写错）。 */
export type PluginSnapshot = DeepReadonly<Project>;
export type PluginDocSnapshot = DeepReadonly<TypographyDocument>;

/* --------------------------------------------------------------- 面板 */

/**
 * 面板形态：
 *  - `float`：无遮罩的可拖曳浮窗（默认 360×420）；
 *  - `modal`：套 `ui/controls/Modal.svelte`，有遮罩、Esc 关闭；
 *  - `dock` ：右侧常驻列，多个面板共用一条 tab 条。
 */
export type PluginPanelKind = 'float' | 'modal' | 'dock';

/**
 * 面板的渲染函数。
 *
 * `host` 是一个**已经挂在 Shadow Root 里**的普通 `div`：插件可以自由写
 * DOM / 追加 `<style>`，而主界面的样式与它互不影响。返回值如果是函数，
 * 会在面板关闭（或插件被卸载）时调用一次 —— 定时器、`ResizeObserver`、
 * 全局事件监听都在那里清。
 *
 * **不要**在这里做重活（渲染只在面板打开时发生一次）；也不要指望宿主帮
 * 你重绘 —— 数据变了要自己订阅 `api.on('typography' | 'project')`。
 */
export type PluginPanelRender = (host: HTMLElement, api: PluginApi) => unknown;

export interface PluginPanelDef {
  id: string;
  name: Label;
  /**
   * 图标名（`ui/icons.ts` 里的具名导出）。有图标才进 Rail；
   * 不认识的图标降级成 `puzzle` 并记一条 `unknown-meta`。
   */
  icon: string | null;
  kind: PluginPanelKind;
  /** 仅 `float` 用；渲染时按视口 clamp。 */
  width: number | null;
  height: number | null;
  render: PluginPanelRender;
}

/* --------------------------------------------------------------- 动作 */

/**
 * 动作参数的窄集合。
 *
 * 比 `ParamDef` 窄是刻意的：这些类型能无损序列化进工具 schema（Agent 面要
 * 看见它们），而 `asset` / `pattern` / `bitmask` 依赖宿主控件与素材台账，
 * 留到下一轮。
 */
export type PluginActionParamType = 'range' | 'select' | 'checkbox' | 'color' | 'text';

export interface PluginActionOption {
  value: string;
  labelKey: Label;
}

export interface PluginActionParam {
  key: string;
  labelKey: Label;
  type: PluginActionParamType;
  defaultValue: string | number | boolean;
  /** `range` 必填。 */
  min?: number;
  max?: number;
  step?: number;
  /** `select` 必填。 */
  options?: PluginActionOption[];
  /** `text` 可选。 */
  maxLength?: number;
  /** `text` 可选。 */
  placeholderKey?: Label;
}

/** 参数值：四种标量。缺省由宿主补齐，未知键在调用前拒绝。 */
export type PluginActionArg = string | number | boolean;
export type PluginActionArgs = Record<string, PluginActionArg>;

/**
 * 一个动作。**面板只是它的一种触发方式**：同一个函数还会经
 * `plugin_invoke` 被 Agent 调用，所以它不能依赖「面板正开着」。
 *
 * `run` 可以是 async；Agent 侧等 5 秒，超时记 `action-failed`。
 * 返回值会原样回给调用方（面板自己决定怎么显示；Agent 侧超过 16KB 截断）。
 */
export type PluginActionRun = (api: PluginApi, args: PluginActionArgs) => unknown;

export interface PluginActionDef {
  id: string;
  name: Label;
  desc: Label | null;
  params: PluginActionParam[];
  run: PluginActionRun;
}

/* ------------------------------------------------------------ 宿主 API */

/** 命令白名单。新增一条要同时改 `ui/plugins/plugin-commands.ts` 与 `agent/plugin-spec.ts`。 */
export const PLUGIN_COMMANDS = [
  'typo_add_element',
  'typo_update_element',
  'typo_remove_element',
  'typo_set_canvas_size',
  'typo_set_theme',
] as const;

export type PluginCommandName = (typeof PLUGIN_COMMANDS)[number];

/**
 * 时间轴命令白名单（`api.timeline.command()`）。
 *
 * 与 Agent 工具同名同形状，写法与排版那组一致。三条覆盖「改片段」的现状：
 * 源参数 / 片段属性 / 换生成器。特效实例的参数走 `set_params({ target:'effect' })`。
 */
export const PLUGIN_TIMELINE_COMMANDS = ['set_params', 'set_clip_props', 'set_generator'] as const;

export type PluginTimelineCommandName = (typeof PLUGIN_TIMELINE_COMMANDS)[number];

export type PluginNotifyKind = 'info' | 'success' | 'error';

/** 只在发生**内容变化**时触发；播放头 / 选中 / 视图切换不算（见文件头第 3 条）。 */
export type PluginEventType = 'project' | 'typography' | 'save';

export interface PluginTextClip {
  clipId: string;
  /** 片段显示名（`label`）。给面板列表用，不用再自己查一遍。 */
  name: string;
}

/**
 * 插件拿到的全部宿主能力。
 *
 * 这个对象是**按 (plugin, project) 一份**的：插件是工程级的，同一个插件在
 * 两个工程标签页里各有一份实例，`snapshot()` 永远只看到**自己那个工程**。
 */
export interface PluginApi {
  readonly pluginId: string;

  /** `console` 的宿主侧收集（进插件面板的诊断，限长）。 */
  log(...args: unknown[]): void;

  project: {
    /** 内容版本号（`docVersion`）。插件缓存快照时用它当判据。 */
    revision(): number;
    /** 只读冻结快照；工程已关闭时 null。 */
    snapshot(): PluginSnapshot | null;
    /** 这个工程里的文本片段（排版编辑器能打开的那些）。 */
    textClips(): PluginTextClip[];
  };

  typography: {
    /** 只读冻结文档；片段不存在 / 不是文本片段时 null。 */
    doc(clipId: string): PluginDocSnapshot | null;
    /** 排版编辑器当前选中的元素（没打开排版页时为 null）。 */
    selection(): { clipId: string; elementIds: string[] } | null;
    /**
     * 受控写入。参数形状与同名 Agent 工具一致（`clipId` 可省略 = 当前文档）。
     * **一次调用 = 一笔撤销**；校验在写之前，失败时抛错且不改文档。
     */
    command(name: PluginCommandName, args?: Record<string, unknown>): Promise<unknown>;
  };

  /**
   * 时间轴的受控写入。`clipId` 必填（时间轴没有「当前片段」这个概念）。
   *
   * 与 `typography.command()` 同一套纪律：参数形状 = 同名 Agent 工具，
   * 一次调用 = 一笔撤销，校验在写之前。读用 `project.snapshot()` 找片段与
   * 特效实例（`chain[].id` / `chainIndex`）。
   */
  timeline: {
    command(name: PluginTimelineCommandName, args: Record<string, unknown>): Promise<unknown>;
  };

  ui: {
    openPanel(panelId: string): void;
    closePanel(panelId: string): void;
    /** 切到排版页并打开这个片段。 */
    openTypography(clipId: string): void;
    notify(text: string, kind?: PluginNotifyKind): void;
  };

  state: {
    /** 插件私有的配置 / 缓存（按 (plugin, project) 落盘到 `plugins/<id>.state.json`）。 */
    get(key: string): unknown;
    set(key: string, value: unknown): void;
  };

  /** 返回退订函数。同一阶段多次变化合并成一次微任务回调。 */
  on(type: PluginEventType, fn: () => void): () => void;
}

/* ----------------------------------------------------------- 宿主注入 */

/**
 * 一份 API 的句柄。
 *
 * 单独给 dispose 而不是让 `PluginApi` 自己带：宿主卸载插件时要先让插件自己
 * 收尾（`activate` 返回的那个函数），再退订事件、把 state 刷盘 —— 后者属于
 * 实现侧的职责，不该出现在插件作者看见的 API 面上。
 */
export interface PluginApiHandle {
  api: PluginApi;
  dispose(): void;
}

/**
 * 宿主（`ui/`）注入给 `PluginHost` 的运行期。
 *
 * `plugins/` 里不许 import `ui/`（依赖方向），所以这里只有接口：
 * 装配点在 `app-boot.ts`，实现是 `ui/plugins/plugin-bridge.ts`。
 */
export interface PluginRuntime {
  /**
   * 为 (plugin, project) 造一份 API。工程没开 / 装配未完成时返回 null。
   *
   * ⚠️ **异步**：插件状态要先从 `plugins/<id>.state.json` 读回来，
   * 否则 `activate(api)` 里的第一次 `api.state.get()` 永远拿到 undefined
   * （而作者会以为是自己的键名写错了）。所以宿主那边的激活也是异步的。
   */
  createApi(pluginId: string, projectKey: string): Promise<PluginApiHandle | null>;
  /** 图标名是否在本版本的图标表里（决定 `unknown-meta` 警告）。 */
  hasIcon(name: string): boolean;
}

/** `activate(api)` 的返回值：函数 = dispose，其它一律忽略。 */
export type PluginActivate = (api: PluginApi) => unknown;
