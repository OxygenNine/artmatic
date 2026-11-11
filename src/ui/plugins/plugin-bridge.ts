/**
 * plugin-bridge.ts — `PluginApi` 的**唯一实现**（插件作者能看到的那一侧）。
 *
 * 分成这一层的原因与 `platform/`、`ControlContext` 相同：`plugins/` 不许 import
 * `ui/`，所以宿主只持有接口（`PluginRuntime`），真正的实现由装配点注入。
 *
 * ## 四条设计约束
 *
 * 1. **读是冻结快照**。`snapshot()` / `doc()` 返回深拷贝 + `Object.freeze`：
 *    插件改它会在严格模式下抛，而不是悄悄改掉 store 里那份（与
 *    `hook-registry.ts::frozenHookInput` 同一条口径）。快照按 `docVersion`
 *    缓存一份，插件在一次内容变化里多次读不会反复深拷贝整个工程。
 * 2. **写只走控制平面**（`plugin-commands.ts`）。这里不出现第二次撤销语义。
 * 3. **没有逐帧事件**。`on()` 只认 `project` / `typography` / `save`，且回调
 *    按微任务合并。播放头 / 选中 / 视图切换**不触发**（它们不是内容变化）。
 * 4. **一份实例对一份工程**。插件是按 `(pluginId, projectKey)` 激活的，
 *    所以这里拿到的 `store` / 目录 / 选区永远是自己那份工程的。
 */

import { ICONS } from '../icons';
import { appState } from '../app-state.svelte';
import { editorState } from '../typography/editor-state.svelte';
import { runPluginCommand, runPluginTimelineCommand } from './plugin-commands';
import { closePanel, openPanel } from './plugin-panels';
import { readPluginState, writePluginState, type PluginState } from '../../project/plugin-state';
import type { AgentControlPlane } from '../../agent/control-plane';
import type { TypographyDocument } from '../../typography/document';
import type {
  PluginApi,
  PluginApiHandle,
  PluginDocSnapshot,
  PluginEventType,
  PluginRuntime,
  PluginSnapshot,
  PluginTextClip,
} from '../../plugins/api-types';

/* --------------------------------------------------------- 控制平面 */

let control: AgentControlPlane | null = null;

/**
 * 把控制平面交给插件桥。`app-boot.ts` 在 `createControlPlane` 之后调一次。
 *
 * 用 late binding 而不是构造参数：插件桥在模块 import 时就被 App 引用了，
 * 而控制平面是装配阶段的产物 —— 反过来注入会成环。
 */
export function setPluginControl(c: AgentControlPlane | null): void {
  control = c;
}

/* ------------------------------------------------------------ 保存通知 */

const savedListeners = new Map<string, Set<() => void>>();

/**
 * 订阅「这个工程刚保存」。返回退订函数。
 *
 * 保存**不是** store 事件（`savedDocVersion` 在 `appState` 上，不经过 `commit`），
 * 所以需要一条独立通知。调用点：`ui/project-actions.ts` 写完盘之后。
 */
export function onProjectSaved(projectId: string, fn: () => void): () => void {
  let set = savedListeners.get(projectId);
  if (!set) {
    set = new Set();
    savedListeners.set(projectId, set);
  }
  set.add(fn);
  return () => {
    set?.delete(fn);
    if (set && set.size === 0) savedListeners.delete(projectId);
  };
}

/** 保存成功后调一次（`project-actions.ts`）。没有订阅者时是空操作。 */
export function notifyProjectSaved(projectId: string): void {
  for (const fn of [...(savedListeners.get(projectId) ?? [])]) {
    try {
      fn();
    } catch {
      // 插件的回调失败不能影响保存本身。
    }
  }
}

/* ------------------------------------------------------------- 小工具 */

/** 深冻结。与 `hook-registry.ts` 同一条纪律：改输入要抛，不能静默生效。 */
function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const v of Object.values(value as Record<string, unknown>)) deepFreeze(v);
  }
  return value;
}

function clonePlain<T>(value: T): T {
  try {
    return structuredClone(value);
  } catch {
    return JSON.parse(JSON.stringify(value)) as T;
  }
}

/** 状态落盘防抖。500 ms：面板里连点几个开关只写一次。 */
const STATE_FLUSH_MS = 500;

/* -------------------------------------------------------------- 运行时 */

export function createPluginRuntime(): PluginRuntime {
  return {
    hasIcon: (name) => name in ICONS,

    async createApi(pluginId: string, projectKey: string): Promise<PluginApiHandle | null> {
      const project = appState.projects.find((p) => p.id === projectKey);
      if (!project) return null;
      const store = project.store;

      const state: PluginState = project.dir ? await readPluginState(project.dir, pluginId) : {};
      let stateDirty = false;
      let stateTimer: ReturnType<typeof setTimeout> | null = null;

      /** 目录可能在这之后才出现（工程第一次保存），所以每次都重新解析。 */
      function currentDir() {
        return appState.projects.find((p) => p.id === projectKey)?.dir ?? null;
      }

      async function flushState(): Promise<void> {
        if (!stateDirty) return;
        const dir = currentDir();
        if (!dir) return; // 没有目录：只在内存里，等保存后再写。
        const ok = await writePluginState(dir, pluginId, state);
        if (ok) stateDirty = false;
      }

      function scheduleStateFlush(): void {
        stateDirty = true;
        if (stateTimer !== null) clearTimeout(stateTimer);
        stateTimer = setTimeout(() => {
          stateTimer = null;
          void flushState();
        }, STATE_FLUSH_MS);
      }

      /* ---------------------------------------------------------- 事件 */

      const listeners = new Map<PluginEventType, Set<() => void>>();
      const pending = new Set<PluginEventType>();
      let disposed = false;

      function emit(type: PluginEventType): void {
        if (pending.has(type)) return;
        pending.add(type);
        queueMicrotask(() => {
          if (!pending.delete(type) || disposed) return;
          for (const fn of [...(listeners.get(type) ?? [])]) {
            try {
              fn();
            } catch (err) {
              api.log('listener failed', type, err instanceof Error ? err.message : String(err));
            }
          }
        });
      }

      let lastDocVersion = store.docVersion;
      const unsubStore = store.subscribe(() => {
        if (disposed) return;
        // 纯重绘（视频取帧 / 烘焙就绪）不算内容变化：插件不该被拉进每帧循环。
        if (store.docVersion === lastDocVersion) return;
        lastDocVersion = store.docVersion;
        emit('project');
        emit('typography');
      });
      const unsubSaved = onProjectSaved(projectKey, () => emit('save'));

      /* -------------------------------------------------------- 只读 */

      let snapVersion = -1;
      let snap: PluginSnapshot | null = null;

      function snapshot(): PluginSnapshot | null {
        if (store.docVersion === snapVersion && snap) return snap;
        snapVersion = store.docVersion;
        snap = deepFreeze(clonePlain(store.project)) as PluginSnapshot;
        return snap;
      }

      function textDoc(clipId: string): TypographyDocument | null {
        const found = store.findClip(clipId);
        if (!found) return null;
        const clip = found.clip;
        if (clip.kind !== 'source' || clip.source.type !== 'text') return null;
        return clip.source.doc;
      }

      const api: PluginApi = {
        pluginId,

        log(...args: unknown[]): void {
          // 前缀是刻意的：控制台里一堆输出时能按插件 id 过滤。
          console.info(`[plugin:${pluginId}]`, ...args);
        },

        project: {
          revision: () => store.docVersion,
          snapshot,
          textClips(): PluginTextClip[] {
            const out: PluginTextClip[] = [];
            for (const track of store.project.tracks) {
              for (const clip of track.clips) {
                if (clip.kind === 'source' && clip.source.type === 'text') {
                  out.push({ clipId: clip.id, name: clip.label });
                }
              }
            }
            return out;
          },
        },

        typography: {
          doc: (clipId) => {
            const doc = textDoc(clipId);
            return doc ? (deepFreeze(clonePlain(doc)) as PluginDocSnapshot) : null;
          },
          selection: () => {
            const clipId = editorState.clipId;
            if (!clipId) return null;
            // 只在这个片段属于**本实例的工程**时给选区：否则两个工程标签页的
            // 面板会读到彼此的选择。
            if (!store.findClip(clipId)) return null;
            return { clipId, elementIds: [...editorState.selectedIds] };
          },
          command: async (name, args) => {
            if (!control) throw new Error('control plane not ready');
            const r = await runPluginCommand(control, name, args);
            // 插件拿到的是纯数据：控制平面返回的 view 对象里可能有引用，
            // 深拷贝一次，避免它持有一个会变的 store 内部对象。
            return clonePlain(r);
          },
        },

        timeline: {
          command: async (name, args) => {
            if (!control) throw new Error('control plane not ready');
            return clonePlain(await runPluginTimelineCommand(control, name, args));
          },
        },

        ui: {
          openPanel: (panelId) => {
            // 只有**自己那个工程在前台**时才有意义：后台工程的 DOM 不该被创建。
            if (appState.activeProjectId !== projectKey) return;
            openPanel(`${pluginId}/${panelId}`);
          },
          closePanel: (panelId) => {
            closePanel(`${pluginId}/${panelId}`);
          },
          openTypography: (clipId) => {
            if (appState.activeProjectId !== projectKey) return;
            if (!store.findClip(clipId)) return;
            appState.openTypographyTab(clipId);
          },
          notify: (text, kind = 'info') => {
            if (appState.activeProjectId !== projectKey) return;
            appState.flash(String(text ?? ''), kind);
          },
        },

        state: {
          get: (key) => state[key],
          set: (key, value) => {
            if (typeof key !== 'string' || !key) return;
            state[key] = value;
            scheduleStateFlush();
          },
        },

        on(type, fn) {
          let set = listeners.get(type);
          if (!set) {
            set = new Set();
            listeners.set(type, set);
          }
          set.add(fn);
          return () => {
            set?.delete(fn);
            if (set && set.size === 0) listeners.delete(type);
          };
        },
      };

      return {
        api,
        dispose() {
          disposed = true;
          unsubStore();
          unsubSaved();
          listeners.clear();
          pending.clear();
          if (stateTimer !== null) {
            clearTimeout(stateTimer);
            stateTimer = null;
          }
          // 卸载前把没落盘的状态冲一次（fire-and-forget：dispose 是同步的）。
          void flushState();
        },
      };
    },
  };
}
