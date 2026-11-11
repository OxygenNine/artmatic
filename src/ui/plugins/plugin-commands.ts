/**
 * plugin-commands.ts — 插件**唯一**的写入口：命令名 → 控制平面方法。
 *
 * ## 为什么是白名单而不是「给个 store 句柄」
 *
 * 插件要「控制排版编辑器」，但它不能自己改 `project`：
 *  - 撤销栈只认 `store.commit`，裸改之后 Ctrl+Z 会把工程退回到一个**从未存在过**
 *    的状态（撤销的是别人那一笔）；
 *  - 脏标记（`docVersion`）不会前进，用户以为没改，关闭时不提示保存；
 *  - `coerceDocument` 是文档唯一校验处，绕过它等于允许插件写出一份打不开的工程。
 *
 * 所以写操作一律映射到控制平面的既有方法：校验前置、`beforeWrite()`、一笔撤销、
 * 与 Agent 工具**同一份实现**。这里只做「参数形状 → 方法参数」的翻译。
 *
 * ## 名字与形状
 *
 * 命令名与 Agent 工具同名（`typo_add_element` / `set_params` …），参数形状也一致
 * —— 插件作者与模型看的是同一套文档。两个命名空间：排版（`PLUGIN_COMMANDS`）
 * 与时间轴（`PLUGIN_TIMELINE_COMMANDS`）。**加一条命令**要同时改三处：
 * `plugins/api-types.ts` 的清单、本文件的映射与参数表、`agent/plugin-spec.ts`。
 * `tests/unit/plugin-commands.test.ts` 会断言两张表与工具表对得上。
 *
 * ## 失败
 *
 * **抛 `Error`**（消息来自 `ControlError.message`）。调用方是插件自己的代码，
 * 它需要一条能显示在面板上的原因；静默吞掉会让「点了没反应」变成唯一线索。
 */

import type { AgentControlPlane } from '../../agent/control-plane';
import type { MaskRef } from '../../core/mask';
import type {
  PluginCommandName,
  PluginTimelineCommandName,
} from '../../plugins/api-types';

function asRecord(v: unknown): Record<string, unknown> {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}

/** `clipId` 缺省 = 排版编辑器当前那份（控制平面自己会解析）。 */
function clipArg(args: Record<string, unknown>): string | undefined {
  return typeof args.clipId === 'string' && args.clipId ? args.clipId : undefined;
}

/** 取出 `ControlResult.data`，失败转成一句可抛的 Error。 */
function unwrap<T>(r: { ok: true; data: T } | { ok: false; error: { message: string } }): T {
  if (!r.ok) throw new Error(r.error.message);
  return r.data;
}

export async function runPluginCommand(
  control: AgentControlPlane,
  name: PluginCommandName,
  rawArgs?: Record<string, unknown>,
): Promise<unknown> {
  const args = asRecord(rawArgs);
  switch (name) {
    case 'typo_add_element':
      return unwrap(
        await control.addTypographyElement(clipArg(args), asRecord(args.element) as never),
      );
    case 'typo_update_element':
      return unwrap(
        await control.updateTypographyElement(
          clipArg(args),
          String(args.elementId ?? ''),
          asRecord(args.patch) as never,
        ),
      );
    case 'typo_remove_element':
      return unwrap(await control.removeTypographyElement(clipArg(args), String(args.elementId ?? '')));
    case 'typo_set_canvas_size': {
      // 形状与 Agent 工具一致：`size: { w, h }`（不是两个平铺的键）。
      const size = asRecord(args.size);
      return unwrap(
        await control.setTypographyCanvasSize(
          clipArg(args),
          { w: Number(size.w ?? 0), h: Number(size.h ?? 0) },
          args.scaleContent === true,
        ),
      );
    }
    case 'typo_set_theme':
      return unwrap(
        await control.setTypographyTheme(
          clipArg(args),
          typeof args.theme === 'string' ? args.theme : null,
          args.scope === 'project' ? 'project' : 'clip',
        ),
      );
    default: {
      // 穷尽性检查：`PLUGIN_COMMANDS` 多一条而这里没分支时编译报错。
      const never: never = name;
      throw new Error(`unknown command: ${String(never)}`);
    }
  }
}

/** 每条命令的必需参数键。给 Agent 工具描述与 `plugin-spec.ts` 共用一份。 */
export const PLUGIN_COMMAND_ARGS: Record<PluginCommandName, { required: string[]; optional: string[] }> = {
  typo_add_element: { required: ['element'], optional: ['clipId'] },
  typo_update_element: { required: ['elementId', 'patch'], optional: ['clipId'] },
  typo_remove_element: { required: ['elementId'], optional: ['clipId'] },
  typo_set_canvas_size: { required: ['size'], optional: ['clipId', 'scaleContent'] },
  typo_set_theme: { required: [], optional: ['clipId', 'theme', 'scope'] },
};

/* --------------------------------------------------------------- 时间轴 */

function needClipId(args: Record<string, unknown>): string {
  const id = typeof args.clipId === 'string' ? args.clipId : '';
  if (!id) throw new Error('clipId is required for timeline commands');
  return id;
}

/** `Record<string, number|string>`；非标量在这里就挡下（控制平面还会再校验一遍）。 */
function asScalars(v: unknown, what: string): Record<string, number | string> {
  const rec = asRecord(v);
  const out: Record<string, number | string> = {};
  for (const [k, x] of Object.entries(rec)) {
    if (typeof x !== 'number' && typeof x !== 'string') {
      throw new Error(`${what}.${k}: expected number or string`);
    }
    out[k] = x;
  }
  return out;
}

/**
 * 时间轴命令。与 `runPluginCommand` 的分工只是「命令属于哪个命名空间」：
 * 两条路最终都走控制平面同一个方法，所以撤销 / 校验语义完全一致。
 */
export async function runPluginTimelineCommand(
  control: AgentControlPlane,
  name: PluginTimelineCommandName,
  rawArgs?: Record<string, unknown>,
): Promise<unknown> {
  const args = asRecord(rawArgs);
  switch (name) {
    case 'set_params': {
      const clipId = needClipId(args);
      const target = args.target === 'effect' ? 'effect' : 'source';
      if (target === 'effect') {
        const chainIndex = Number(args.chainIndex);
        if (!Number.isInteger(chainIndex) || chainIndex < 0) {
          throw new Error('set_params: chainIndex (integer) is required for target:"effect"');
        }
        const values = args.params === undefined ? undefined : asScalars(args.params, 'params');
        return unwrap(
          await control.setEffectParams(
            clipId,
            chainIndex,
            values,
            typeof args.enabled === 'boolean' ? args.enabled : undefined,
            args.mask === undefined ? undefined : (args.mask as MaskRef | null),
          ),
        );
      }
      return unwrap(await control.setClipSourceParams(clipId, asScalars(args.params ?? {}, 'params')));
    }
    case 'set_clip_props':
      return unwrap(await control.setClipProps(needClipId(args), asRecord(args.patch) as never));
    case 'set_generator':
      return unwrap(
        await control.setGenerator(
          needClipId(args),
          String(args.generator ?? ''),
          args.params === undefined ? undefined : asScalars(args.params, 'params'),
        ),
      );
    default: {
      const never: never = name;
      throw new Error(`unknown timeline command: ${String(never)}`);
    }
  }
}

/** 时间轴命令的必需 / 可选参数键（与 `tools.ts` 的同名工具对齐，单测会断言）。 */
export const PLUGIN_TIMELINE_COMMAND_ARGS: Record<
  PluginTimelineCommandName,
  { required: string[]; optional: string[] }
> = {
  set_params: { required: ['clipId', 'target'], optional: ['chainIndex', 'params', 'enabled', 'mask'] },
  set_clip_props: { required: ['clipId', 'patch'], optional: [] },
  set_generator: { required: ['clipId', 'generator'], optional: ['params'] },
};
