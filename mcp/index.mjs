#!/usr/bin/env node
/**
 * index.mjs — Artmatic 的 MCP 网关（薄壳）。
 *
 * 用法（MCP 客户端配置里的 command/args）：
 *   node mcp/index.mjs
 * 环境变量：
 *   ARTMATIC_URL=http://localhost:5173   旁挂一个已经在跑的 dev / preview（有头；
 *                                        **这是「agent 与用户操作同一个实例」的唯一方式**）
 *   ARTMATIC_PORT=4173                   自己起服务时的端口（默认 4173；那儿已有服务就复用）
 *   ARTMATIC_NO_BUILD=1                  不给自己跑 vite build（服务已在运行时省时间）
 *   ARTMATIC_HEADLESS=0                  起有头浏览器（调试用）
 *
 * ## 它做什么、不做什么（方案 §2.1）
 *
 * 做：工具清单与入参校验（`tools.mjs`）、传输（`bridge.mjs`）、把控制平面的
 * `{ ok, data }` 包成 MCP 的 content，把 `onProgress` 轮询成 progress notification。
 * 不做：任何编辑 / 渲染 / 导出逻辑。那些全在页面内的 `src/agent/` 里，网关换了
 * 传输（CDP → WS）也不会动一行。
 *
 * ## stdio 协议的一条硬规矩
 *
 * stdout 是协议通道：**任何 `console.log` 都会把 JSON-RPC 冲烂**。这个进程里
 * 一切人类可读的输出都走 stderr。
 *
 * ## 单位
 *
 * `t` 是**秒**（控制平面吸附到帧栅格）；`frameRange` / `frameStep` 是**帧号**
 * （AGENTS §5.8：秒 → 帧号只在 `gif-plan.ts` 换算一次）。
 */

import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readFileSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { Bridge } from './bridge.mjs';
import { TOOL_BY_NAME, checkFrameRange, checkIdInList, listToolDescriptors, validateArgs } from './tools.mjs';

/** 与内核同源：`package.json` 是版本号唯一真源（`vite.config.ts` 也读它）。 */
const APP_VERSION = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;
/** 网关自己的版本：与控制平面（`CONTROL_API_VERSION`）分开演进。 */
const GATEWAY_VERSION = 1;

/* ---------------------------------------------------------------- 输出形状 */

const okResult = (data) => ({
  content: [{ type: 'text', text: JSON.stringify({ ok: true, data }, null, 2) }],
});

/**
 * 工具级失败走 `isError: true` 而不是**协议异常**：异常会让 MCP 客户端把它当成
 * 「工具坏了」，而绝大多数失败（落点被拒、id 不存在）是**正常的业务结果**，
 * agent 需要看到 `code` 才能决定下一步。这与控制平面「不抛异常」是同一条理由。
 */
const errResult = (error) => ({
  content: [{ type: 'text', text: JSON.stringify({ ok: false, error }, null, 2) }],
  isError: true,
});

const log = (msg) => process.stderr.write(`[artmatic-mcp] ${msg}\n`);

/* ------------------------------------------------------------------ 网关 */

const bridge = new Bridge();
/** 能力清单在一次会话里不变（注册表在模块加载时建好）。 */
let caps = null;

async function capabilities() {
  if (caps) return caps;
  const r = await bridge.call('getCapabilities');
  if (!r.ok) throw new Error(`拿不到能力清单：${r.error.message}`);
  caps = r.data;
  return caps;
}

/** 控制平面的返回值直接透传给 agent；只有失败要标 isError。 */
function unwrap(r) {
  return r && r.ok ? okResult(r.data) : errResult(r?.error ?? { code: 'internal', message: '空返回' });
}

/** 校验一个 id 在不在能力清单里；不在就直接返回错误结果。 */
async function requireId(value, listName, what) {
  const list = (await capabilities())[listName].map((x) => x.id);
  const check = checkIdInList(value, list, what);
  return check.ok ? null : errResult(check.error);
}

/* ------------------------------------------------------------- 工具分发 */

async function dispatch(name, args, extra) {
  switch (name) {
    /* ------------------------------------------------------------- 读 */
    case 'artmatic_describe':
      return unwrap(await bridge.call('describe'));
    case 'artmatic_get_scene':
      return unwrap(await bridge.call('getScene', [{ t: args.t, detail: args.detail }]));
    case 'artmatic_get_capabilities':
      return unwrap(
        await bridge.call('getCapabilities', [
          {
            ...(args.detail ? { detail: args.detail } : {}),
            ...(Array.isArray(args.ids) ? { ids: args.ids } : {}),
          },
        ]),
      );

    case 'artmatic_help':
      return unwrap(await bridge.call('help', [args.topic]));

    case 'artmatic_get_typography_capabilities':
      return unwrap(await bridge.call('getTypographyCapabilities'));

    case 'artmatic_get_typography_doc':
      return unwrap(await bridge.call('getTypographyDoc', [args.clipId, args.detail]));

    case 'artmatic_typo_add_element':
      return unwrap(await bridge.call('addTypographyElement', [args.clipId, args.element]));

    case 'artmatic_typo_add_elements':
      return unwrap(await bridge.call('addTypographyElements', [args.clipId, args.elements]));

    case 'artmatic_typo_measure':
      return unwrap(await bridge.call('measureTypography', [args.clipId, args.elementIds]));

    case 'artmatic_typo_add_generated_shape':
      return unwrap(
        await bridge.call('addGeneratedShape', [
          args.clipId,
          {
            genId: args.genId,
            params: args.params,
            seed: args.seed,
            frame: args.frame,
            name: args.name,
            fill: args.fill,
            stroke: args.stroke,
          },
        ]),
      );

    case 'artmatic_typo_update_element':
      return unwrap(await bridge.call('updateTypographyElement', [args.clipId, args.elementId, args.patch]));

    case 'artmatic_typo_update_elements':
      return unwrap(await bridge.call('updateTypographyElements', [args.clipId, args.updates]));

    case 'artmatic_typo_set_animation':
      return unwrap(
        await bridge.call('setTypographyAnimation', [
          args.clipId,
          args.elementId,
          args.animation ?? null,
          args.mode === 'add' ? 'add' : 'replace',
        ]),
      );

    case 'artmatic_typo_copy_style':
      return unwrap(
        await bridge.call('copyTypographyStyle', [
          args.clipId,
          args.sourceId,
          Array.isArray(args.targetIds) ? args.targetIds : [],
          args.what === 'animation' ? 'animation' : 'format',
        ]),
      );

    case 'artmatic_typo_set_scripts':
      return unwrap(await bridge.call('setTypographyScripts', [args.clipId, args.scripts]));

    case 'artmatic_typo_set_text':
      return unwrap(await bridge.call('setTypographyText', [args.clipId, args.elementId, args.text]));

    case 'artmatic_typo_remove_element':
      return unwrap(await bridge.call('removeTypographyElement', [args.clipId, args.elementId]));

    case 'artmatic_typo_reorder_element':
      return unwrap(
        await bridge.call('reorderTypographyElement', [args.clipId, args.elementId, args.op, args.index]),
      );

    case 'artmatic_typo_group':
      return unwrap(
        await bridge.call('groupTypographyElements', [args.clipId, args.elementIds, args.name]),
      );

    case 'artmatic_typo_ungroup':
      return unwrap(await bridge.call('ungroupTypographyElements', [args.clipId, args.elementIds]));

    case 'artmatic_typo_layout':
      return unwrap(
        await bridge.call('layoutTypography', [
          args.clipId,
          {
            op: args.op,
            ...(args.axis ? { axis: args.axis } : {}),
            ...(args.target ? { target: args.target } : {}),
            ...(args.elementIds ? { elementIds: args.elementIds } : {}),
            ...(args.cols !== undefined ? { cols: args.cols } : {}),
            ...(args.rows !== undefined ? { rows: args.rows } : {}),
            ...(args.gap !== undefined ? { gap: args.gap } : {}),
            ...(args.margin !== undefined ? { margin: args.margin } : {}),
          },
        ]),
      );

    case 'artmatic_typo_set_background':
      return unwrap(await bridge.call('setTypographyBackground', [args.clipId, args.paint]));

    case 'artmatic_typo_set_theme':
      return unwrap(
        await bridge.call('setTypographyTheme', [args.clipId, args.theme ?? null, args.scope]),
      );

    case 'artmatic_typo_save_theme':
      return unwrap(
        await bridge.call('saveTypographyTheme', [
          args.clipId,
          {
            id: args.id,
            base: args.base,
            name: args.name,
            colors: args.colors,
            scope: args.scope,
          },
        ]),
      );

    case 'artmatic_typo_remove_theme':
      return unwrap(await bridge.call('removeTypographyTheme', [args.themeId]));

    case 'artmatic_typo_update_group':
      return unwrap(
        await bridge.call('updateTypographyGroup', [args.clipId, args.groupId, args.patch]),
      );

    case 'artmatic_typo_boolean':
      return unwrap(
        await bridge.call('booleanTypographyShapes', [args.clipId, args.elementIds, args.op]),
      );

    case 'artmatic_typo_divide':
      return unwrap(await bridge.call('divideTypographyShapes', [args.clipId, args.elementIds]));

    case 'artmatic_typo_convert_to_path':
      return unwrap(await bridge.call('convertTypographyToPath', [args.clipId, args.elementIds]));

    case 'artmatic_typo_set_canvas_size':
      return unwrap(
        await bridge.call('setTypographyCanvasSize', [args.clipId, args.size, args.scaleContent === true]),
      );

    case 'artmatic_typo_set_camera':
      // `undefined` 也当复位：镜头是文档级的唯一一份，省略它没有别的语义。
      return unwrap(await bridge.call('setTypographyCamera', [args.clipId, args.camera ?? null]));

    case 'artmatic_typo_set_camera_animation':
      // `keys` 省略 = 删掉这条通道（与控制平面的 `null` 同义）。
      return unwrap(
        await bridge.call('setTypographyCameraAnimation', [
          args.clipId,
          String(args.channel ?? ''),
          args.keys ?? null,
        ]),
      );

    case 'artmatic_typo_replace_doc':
      return unwrap(await bridge.call('replaceTypographyDoc', [args.clipId, args.doc]));
    case 'artmatic_get_clip':
      return unwrap(await bridge.call('getClip', [args.clipId]));
    case 'artmatic_list_projects':
      return unwrap(await bridge.call('listProjects'));
    case 'artmatic_undo_state':
      return unwrap(await bridge.call('undoState'));
    case 'artmatic_compile_all':
      return unwrap(await bridge.call('compileAll'));

    /* ------------------------------------------------------------- 写 */
    case 'artmatic_add_track':
      return unwrap(await bridge.call('addTrack', [args.kind, args.name]));

    case 'artmatic_remove_track':
      return unwrap(await bridge.call('removeTrack', [args.trackId]));

    case 'artmatic_move_track':
      return unwrap(await bridge.call('moveTrack', [args.from, args.to]));

    case 'artmatic_set_track':
      return unwrap(
        await bridge.call('setTrack', [
          args.trackId,
          { enabled: args.enabled, name: args.name, muted: args.muted },
        ]),
      );

    case 'artmatic_add_clip': {
      const base = {
        start: args.start,
        end: args.end,
        id: args.id,
        label: args.label,
        blend: args.blend,
        opacity: args.opacity,
        transform: args.transform,
        fit: args.fit,
        fadeSec: args.fadeSec,
      };
      if (args.kind === 'effect') {
        for (const c of args.chain ?? []) {
          const bad = await requireId(c.defId, 'effects', '特效');
          if (bad) return bad;
        }
        return unwrap(
          await bridge.call('addEffectClip', [args.trackId, { ...base, chain: args.chain }]),
        );
      }
      if (args.kind === 'algo') {
        const bad = await requireId(args.generator, 'generators', '生成器');
        if (bad) return bad;
      }
      if (args.blend !== undefined) {
        const list = (await capabilities()).blendModes;
        const check = checkIdInList(args.blend, list, '混合模式');
        if (!check.ok) return errResult(check.error);
      }
      return unwrap(
        await bridge.call('addClip', [
          args.trackId,
          {
            ...base,
            kind: args.kind,
            generator: args.generator,
            params: args.params,
            color: args.color,
            assetId: args.assetId,
            srcIn: args.srcIn,
            speed: args.speed,
            doc: args.doc,
          },
        ]),
      );
    }

    case 'artmatic_add_effect_clip':
      return unwrap(
        await bridge.call('addEffectClip', [
          args.trackId,
          {
            start: args.start,
            end: args.end,
            chain: args.chain,
            label: args.label,
            fadeSec: args.fadeSec,
            affectDepth: args.affectDepth,
            boundClipId: args.boundClipId,
          },
        ]),
      );

    case 'artmatic_remove_clip':
      return unwrap(await bridge.call('removeClip', [args.clipId]));

    case 'artmatic_move_clip':
      return unwrap(await bridge.call('moveClip', [args.clipId, args.targetTrackId, args.newStart]));

    case 'artmatic_resize_clip':
      return unwrap(await bridge.call('resizeClip', [args.clipId, args.edge, args.time]));

    case 'artmatic_split_clip':
      return unwrap(await bridge.call('splitClip', [args.clipId, args.at]));

    case 'artmatic_set_clip_props':
      return unwrap(await bridge.call('setClipProps', [args.clipId, args.patch]));

    case 'artmatic_set_params': {
      if (args.target === 'effect') {
        if (!Number.isInteger(args.chainIndex)) {
          return errResult({
            code: 'invalid-argument',
            message: "target:'effect' 时必须给 chainIndex",
          });
        }
        return unwrap(
          await bridge.call('setEffectParams', [
            args.clipId,
            args.chainIndex,
            args.params,
            args.enabled,
            // 三态照原样过桥：缺省 = 不动，null = 摘掉。
            'mask' in args ? args.mask : undefined,
          ]),
        );
      }
      return unwrap(await bridge.call('setClipSourceParams', [args.clipId, args.params]));
    }

    case 'artmatic_set_generator':
      return unwrap(await bridge.call('setGenerator', [args.clipId, args.generator, args.params]));

    case 'artmatic_seed_pattern_from_asset':
      return unwrap(
        await bridge.call('seedPatternFromAsset', [args.clipId, args.param, args.assetId]),
      );

    case 'artmatic_set_curve':
      return unwrap(await bridge.call('setCurve', [args.clipId, args.param, args.curve ?? null]));

    case 'artmatic_list_modulators':
      return unwrap(await bridge.call('listModulators', []));

    case 'artmatic_set_modulator':
      return unwrap(
        await bridge.call('setModulator', [
          { id: args.id, name: args.name, expr: args.expr, min: args.min, max: args.max },
        ]),
      );

    case 'artmatic_remove_modulator':
      return unwrap(await bridge.call('removeModulator', [args.id]));

    case 'artmatic_bind_modulator':
      return unwrap(
        await bridge.call('bindModulator', [
          { clipId: args.clipId, param: args.param, modulatorId: args.modulatorId, gain: args.gain, mode: args.mode },
        ]),
      );

    case 'artmatic_unbind_modulator':
      return unwrap(
        await bridge.call('unbindModulator', [args.clipId, args.param, args.modulatorId]),
      );

    case 'artmatic_add_effect': {
      const bad = await requireId(args.defId, 'effects', '特效');
      if (bad) return bad;
      return unwrap(
        await bridge.call('addEffect', [args.clipId, args.defId, args.values, args.index, args.enabled]),
      );
    }

    case 'artmatic_remove_effect':
      return unwrap(await bridge.call('removeEffect', [args.clipId, args.chainIndex]));

    case 'artmatic_reorder_effect':
      return unwrap(await bridge.call('reorderEffect', [args.clipId, args.from, args.to]));

    case 'artmatic_set_transition': {
      const bad = await requireId(args.defId, 'transitions', '转场');
      if (bad) return bad;
      return unwrap(
        await bridge.call('setTransition', [args.clipId, args.defId, args.duration, args.values, args.side]),
      );
    }

    case 'artmatic_clear_transition':
      return unwrap(await bridge.call('clearTransition', [args.clipId, args.side]));

    case 'artmatic_get_asset_ranges':
      return unwrap(await bridge.call('getAssetRanges', [args.assetId]));

    case 'artmatic_set_asset_range':
      return unwrap(
        await bridge.call('setAssetRange', [
          args.assetId,
          { inSec: args.inSec, outSec: args.outSec, name: args.name, id: args.rangeId },
        ]),
      );

    case 'artmatic_remove_asset_range':
      return unwrap(await bridge.call('removeAssetRange', [args.assetId, args.rangeId]));

    case 'artmatic_set_active_range':
      return unwrap(await bridge.call('setActiveRange', [args.assetId, args.rangeId ?? null]));

    case 'artmatic_detach_video_audio':
      return unwrap(await bridge.call('detachVideoAudio', [args.clipId]));

    case 'artmatic_set_audio_lock':
      return unwrap(await bridge.call('setAudioLock', [args.clipId, args.locked]));

    case 'artmatic_set_clip_audio':
      return unwrap(
        await bridge.call('setClipAudio', [
          args.clipId,
          {
            gainDb: args.gainDb,
            fadeIn: args.fadeIn,
            fadeOut: args.fadeOut,
            muted: args.muted,
          },
        ]),
      );

    case 'artmatic_set_project':
      return unwrap(await bridge.call('setProject', [args]));

    case 'artmatic_estimate_beat_grid':
      return unwrap(await bridge.call('estimateBeatGrid'));

    case 'artmatic_set_beat_marks':
      return unwrap(await bridge.call('setBeatMarks', [args.marks]));

    case 'artmatic_media_list':
      return unwrap(await bridge.call('listMediaPool'));

    case 'artmatic_media_op':
      // 不带 confirm：需要审批时应用会弹卡，用户确认之前不会真的动文件。
      return unwrap(await bridge.call('mediaPoolOp', [{ op: args.op, assetId: args.assetId }]));

    case 'artmatic_rename_asset':
      // 只改显示名，不碰磁盘文件 —— 所以不经过媒体池动作的确认闸门。
      return unwrap(await bridge.call('renameAsset', [args.assetId, args.name]));

    case 'artmatic_edit_sections': {
      const op = args.op;
      // 只把该 op 需要的键送过去：其余 `undefined` 会让控制平面的类型判断更难读。
      const req =
        op === 'add'
          ? { op, start: args.start, name: args.name }
          : op === 'split'
            ? { op, sectionId: args.sectionId, at: args.at }
            : op === 'rename'
              ? { op, sectionId: args.sectionId, name: args.name }
              : op === 'remove'
                ? { op, sectionId: args.sectionId }
                : { op, sectionId: args.sectionId, start: args.start };
      return unwrap(await bridge.call('editSections', [req]));
    }

    case 'artmatic_load_scene':
      return unwrap(await bridge.call('loadScene', [args.project]));

    case 'artmatic_begin_transaction':
      return unwrap(await bridge.call('beginTx'));

    case 'artmatic_commit_transaction':
      return unwrap(await bridge.call('endTx', [args.label ?? 'agent: transaction']));

    case 'artmatic_cancel_transaction':
      return unwrap(await bridge.call('cancelTx'));

    case 'artmatic_undo':
      return unwrap(await bridge.call('undo'));

    case 'artmatic_redo':
      return unwrap(await bridge.call('redo'));

    /* ---------------------------------------------------------- 看 / 导 */
    case 'artmatic_frame_signature':
      return unwrap(
        await bridge.call('frameSignature', [
          { t: args.t, size: args.size, grid: args.grid, only: args.only },
        ]),
      );

    case 'artmatic_render_frame': {
      const r = await bridge.snapshotPng({
        t: args.t,
        size: args.size,
        only: args.only,
        region: args.region,
      });
      if (!r.ok) return errResult(r.error);
      return {
        content: [
          { type: 'text', text: JSON.stringify({ ok: true, data: { bytes: r.data.bytes } }) },
          { type: 'image', data: r.data.base64, mimeType: 'image/png' },
        ],
      };
    }

    case 'artmatic_ui_screenshot': {
      const r = await bridge.uiScreenshotPng({ scale: args.scale });
      if (!r.ok) return errResult(r.error);
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              ok: true,
              data: { w: r.data.w, h: r.data.h, bytes: r.data.bytes, warnings: r.data.warnings },
            }),
          },
          { type: 'image', data: r.data.base64, mimeType: 'image/png' },
        ],
      };
    }

    case 'artmatic_render_sequence': {
      const r = await bridge.renderSequencePng({
        from: args.from,
        to: args.to,
        step: args.step,
        size: args.size,
        cols: args.cols,
        only: args.only,
        region: args.region,
      });
      if (!r.ok) return errResult(r.error);
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              ok: true,
              data: { times: r.data.times, cols: r.data.cols, rows: r.data.rows, w: r.data.w, h: r.data.h },
            }),
          },
          { type: 'image', data: r.data.base64, mimeType: 'image/png' },
        ],
      };
    }

    case 'artmatic_export':
      return exportToDisk(args, extra);

    /* -------------------------------------------------------- 工程级 */
    case 'artmatic_open_project':
      return unwrap(await bridge.call('openProject', [args.name]));

    case 'artmatic_save_project':
      return unwrap(await bridge.call('saveProject'));

    /* -------------------------------------------------------------- 插件 */
    case 'artmatic_plugin_try':
      return unwrap(
        await bridge.call('pluginTry', [
          {
            id: args.id,
            name: args.name ?? '',
            // 省略 = 用草稿（plugin_edit 之后那条路），不要塞空串。
            ...(typeof args.source === 'string' ? { source: args.source } : {}),
            confirm: args.confirm === true,
          },
        ]),
      );

    case 'artmatic_plugin_view':
      return unwrap(
        await bridge.call('pluginView', [
          {
            pluginId: args.pluginId,
            ...(args.offset === undefined ? {} : { offset: args.offset }),
            ...(args.limit === undefined ? {} : { limit: args.limit }),
          },
        ]),
      );

    case 'artmatic_plugin_grep':
      return unwrap(
        await bridge.call('pluginGrep', [
          {
            pluginId: args.pluginId,
            pattern: args.pattern,
            ...(args.ignoreCase === undefined ? {} : { ignoreCase: args.ignoreCase }),
            ...(args.context === undefined ? {} : { context: args.context }),
            ...(args.max === undefined ? {} : { max: args.max }),
          },
        ]),
      );

    case 'artmatic_plugin_edit':
      return unwrap(
        await bridge.call('pluginEdit', [
          { pluginId: args.pluginId, oldString: args.oldString, newString: args.newString },
        ]),
      );

    case 'artmatic_plugin_check':
      return unwrap(await bridge.call('pluginCheck', [args.pluginId]));

    case 'artmatic_plugin_install':
      return unwrap(await bridge.call('pluginInstall', [args.pluginId, args.confirm === true]));

    case 'artmatic_plugin_list':
      return unwrap(await bridge.call('pluginList'));

    case 'artmatic_plugin_discard':
      return unwrap(await bridge.call('pluginDiscard', [args.pluginId]));

    case 'artmatic_plugin_remove':
      return unwrap(await bridge.call('pluginRemove', [args.pluginId]));

    case 'artmatic_plugin_source':
      return unwrap(await bridge.call('pluginSource', [args.pluginId]));

    case 'artmatic_plugin_ui': {
      const action = String(args.action ?? 'list');
      if (action === 'open') {
        return unwrap(await bridge.call('openPluginPanel', [args.pluginId, args.panelId]));
      }
      if (action === 'close') {
        return unwrap(await bridge.call('closePluginPanel', [args.pluginId, args.panelId]));
      }
      if (action !== 'list') {
        return errResult({ code: 'invalid-argument', message: `未知的 plugin_ui action：${action}` });
      }
      return unwrap(await bridge.call('listPluginUi'));
    }

    case 'artmatic_plugin_invoke':
      return unwrap(
        await bridge.call('invokePluginAction', [args.pluginId, args.actionId, args.args]),
      );

    default:
      return errResult({ code: 'not-found', message: `没有工具 ${name}` });
  }
}

/* ---------------------------------------------------------------- 导出 */

/** 产物扩展名：PNG 序列在内存里是 zip（逃生舱的既定形态，见 `png-sequence.ts`）。 */
const EXT = { mp4: 'mp4', png: 'zip', gif: 'gif' };

/**
 * 导出 + 进度通知 + 落盘。
 *
 * 为什么不直接 `await control.export(...)`：进度回调在页面里，过不了 CDP。
 * 所以这里「起跑不等 → 轮询 `exportState()` → 转成 `notifications/progress`」，
 * 顺带也就有了取消：客户端发 `notifications/cancelled` 时 `extra.signal` 会中止，
 * 那时去按页面里的取消。
 */
async function exportToDisk(args, extra) {
  const info = await bridge.call('describe');
  if (!info.ok) return errResult(info.error);
  const total = Math.max(1, Math.ceil(info.data.duration * info.data.fps));
  const rangeCheck = checkFrameRange(args.frameRange, total);
  if (!rangeCheck.ok) return errResult(rangeCheck.error);

  const progressToken = extra?._meta?.progressToken;
  const notify = async (progress, total_) => {
    if (progressToken === undefined) return;
    await extra
      .sendNotification({ method: 'notifications/progress', params: { progressToken, progress, total: total_ } })
      .catch(() => {});
  };

  await bridge.startExport({
    format: args.format,
    frameRange: args.frameRange,
    size: args.size,
    frameStep: args.frameStep,
  });

  let cancelled = false;
  for (;;) {
    const { done, state } = await bridge.pollExport();
    if (state) await notify(state.frac, 1);
    if (done) break;
    if (extra?.signal?.aborted && !cancelled) {
      cancelled = true;
      await bridge.call('abortExport');
    }
    await delay(200);
  }

  const res = await bridge.takeExportResult();
  if (!res) return errResult({ code: 'internal', message: '导出没有留下结果' });
  if (!res.ok) return errResult(res.error);
  if (cancelled) return errResult({ code: 'cancelled', message: '导出已被调用方取消' });

  const outPath = args.outPath ?? join(tmpdir(), `artmatic-${Date.now()}.${EXT[args.format]}`);
  await writeFile(outPath, Buffer.from(res.data.base64, 'base64'));
  return okResult({ path: outPath, bytes: res.data.bytes, mimeType: res.data.mimeType });
}

/* --------------------------------------------------------------- 服务装配 */

const server = new Server(
  { name: 'artmatic', version: APP_VERSION },
  {
    capabilities: { tools: {} },
    // 网关的版本在 initialize 的 serverInfo 里带上（与控制平面版本分开演进）。
    instructions:
      `Artmatic 控制平面网关 v${GATEWAY_VERSION}（控制平面契约 v4）。渲染只在浏览器里发生：` +
      '所有工具都是对**页面上那一台编辑器**的操作，没有第二套求值路径。' +
      '先 get_capabilities 拿合法 id；参数表用 detail:"params" 按需展开。' +
      '写插件前先 artmatic_help(topic:"plugin-api")；安装需要用户在页面上确认。' +
      '自循环判断优先用 frame_signature，需要看构图时再用 render_frame。',
  },
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: listToolDescriptors() }));

server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
  const name = request.params.name;
  const tool = TOOL_BY_NAME.get(name);
  if (!tool) {
    return errResult({ code: 'not-found', message: `没有工具 ${name}`, detail: { validIds: [...TOOL_BY_NAME.keys()] } });
  }
  const check = validateArgs(tool, request.params.arguments);
  if (!check.ok) return errResult(check.error);
  try {
    return await dispatch(name, check.value, extra);
  } catch (e) {
    // 走到这里说明是**网关自己**的 bug（bridge / 进程问题），不是控制平面的业务结果。
    log(`工具 ${name} 异常：${e?.stack ?? e}`);
    return errResult({ code: 'internal', message: String(e?.message ?? e) });
  }
});

async function shutdown() {
  await bridge.close();
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

await server.connect(new StdioServerTransport());
log(`就绪（control-plane API v4，网关 v${GATEWAY_VERSION}）。日志走 stderr，stdout 只走协议。`);
