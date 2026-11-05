/**
 * executor.ts — 把模型的**工具调用**翻译成控制平面调用。
 *
 * 这里是「工具名 ↔ 方法」的**唯一映射**（应用内侧）。MCP 网关有它自己的一份
 * dispatch（那边还要过 CDP），但两边的工具名集合由 parity 单测钉住。
 *
 * 三条纪律：
 *  1. **不抛异常**：任何失败都变成 `{ ok:false, text, code }` 回给模型 ——
 *     它需要读 `code` 才能自我修复（与控制平面「不抛」同一条理由）。
 *  2. **截图走 `snapshotPng`**：与预览/导出一模一样的求值路径（含 onSeek 与
 *     排版异步光栅就绪）。控制平面内部已经把尺寸钉好又还原。
 *  3. **导出不回 base64**：一段 3 秒的 mp4 有几百 KB，塞进对话就是几万 token。
 *     应用内直接触发浏览器下载，只把体积/路径告诉模型。
 */

import type { AgentControlPlane } from '../control-plane';
import { ControlFailure } from '../types';
import type { ToolOutcome } from './types';

/** 工具结果回给模型时的文本上限（字符）。超出截断并注明。 */
export const TOOL_TEXT_LIMIT = 20_000;

function clip(text: string): string {
  if (text.length <= TOOL_TEXT_LIMIT) return text;
  return `${text.slice(0, TOOL_TEXT_LIMIT)}\n…[truncated ${text.length - TOOL_TEXT_LIMIT} chars]`;
}

function okText(data: unknown): ToolOutcome {
  return { ok: true, text: clip(JSON.stringify(data)) };
}

function errText(message: string, code = 'internal', detail?: unknown): ToolOutcome {
  return {
    ok: false,
    code,
    ...(detail === undefined ? {} : { detail }),
    text: clip(JSON.stringify({ ok: false, error: { code, message, ...(detail === undefined ? {} : { detail }) } })),
  };
}

function unwrap(r: { ok: true; data: unknown } | { ok: false; error: { code: string; message: string; detail?: unknown } }): ToolOutcome {
  return r.ok ? okText(r.data) : errText(r.error.message, r.error.code, r.error.detail);
}

function asRecord(v: unknown): Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}

function bytesToBase64(buf: Uint8Array): string {
  let latin = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < buf.length; i += CHUNK) {
    latin += String.fromCharCode(...buf.subarray(i, i + CHUNK));
  }
  return btoa(latin);
}

/** PNG 的 IHDR 里读宽高（大端 32 位，偏移 16 / 20）。读不出就返回 0。 */
function pngSize(bytes: Uint8Array): { w: number; h: number } {
  if (bytes.length < 24) return { w: 0, h: 0 };
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return { w: view.getUint32(16), h: view.getUint32(20) };
}

function saveBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.rel = 'noopener';
  document.body.appendChild(a);
  a.click();
  a.remove();
  // 立刻 revoke 会让部分浏览器的下载悬空；下一个任务再释放。
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

const EXT: Record<string, string> = { mp4: 'mp4', png: 'zip', gif: 'gif' };

export type ToolExecutor = (name: string, args: Record<string, unknown>) => Promise<ToolOutcome>;

export function createToolExecutor(control: AgentControlPlane): ToolExecutor {
  /** 截图尺寸要跟着工程宽高比走；describe 在一次会话里基本不变，缓存它。 */
  let stepSize: { w: number; h: number } | null = null;
  async function snapshotSize(size: unknown): Promise<{ w: number; h: number } | undefined> {
    if (size && typeof size === 'object') {
      const r = asRecord(size);
      const w = Number(r.w);
      const h = Number(r.h);
      if (Number.isFinite(w) && Number.isFinite(h) && w >= 2 && h >= 2) return { w: Math.round(w), h: Math.round(h) };
    }
    if (!stepSize) {
      const d = await control.describe();
      const res = d.ok ? d.data.resolution : { w: 16, h: 9 };
      const w = 640;
      stepSize = { w, h: Math.max(2, Math.round((w * res.h) / Math.max(1, res.w) / 2) * 2) };
    }
    return stepSize;
  }

  return async (name, args) => {
    try {
      switch (name) {
        /* ------------------------------------------------------------ 读 */
        case 'describe':
          return unwrap(await control.describe());

        case 'help': {
          const topic = typeof args.topic === 'string' ? args.topic : undefined;
          const r = await control.help(topic);
          // help 的正文是纯文本，不要再套一层 JSON 转义。
          return r.ok ? { ok: true, text: clip(r.data.text) } : errText(r.error.message, r.error.code);
        }

        case 'get_scene':
          return unwrap(
            await control.getScene({
              ...(typeof args.t === 'number' ? { t: args.t } : {}),
              ...(args.detail === 'ids' || args.detail === 'full' ? { detail: args.detail } : {}),
            }),
          );

        case 'get_capabilities':
          return unwrap(
            await control.getCapabilities({
              ...(args.detail === 'params' ? { detail: 'params' as const } : {}),
              ...(Array.isArray(args.ids) ? { ids: args.ids.filter((x): x is string => typeof x === 'string') } : {}),
            }),
          );

        case 'get_typography_capabilities':
          return unwrap(await control.getTypographyCapabilities());

        case 'get_typography_doc':
          return unwrap(
            await control.getTypographyDoc(
              typeof args.clipId === 'string' ? args.clipId : undefined,
              args.detail === 'ids' ? 'ids' : 'full',
            ),
          );

        case 'get_clip':
          return unwrap(await control.getClip(String(args.clipId ?? '')));

        case 'undo_state':
          return unwrap(await control.undoState());

        case 'frame_signature': {
          const sig = await control.frameSignature({
            ...(typeof args.t === 'number' ? { t: args.t } : {}),
            ...(args.size ? { size: asRecord(args.size) as { w: number; h: number } } : {}),
            ...(typeof args.grid === 'number' ? { grid: Math.max(1, Math.round(args.grid)) } : {}),
            ...(args.only ? { only: asRecord(args.only) as never } : {}),
          });
          if (!sig.ok) return errText(sig.error.message, sig.error.code, sig.error.detail);
          // 与 render_frame 同一条理由：隔离隐藏了哪些层必须回显，否则
          // 「数值一模一样」会被误判成「参数没生效」。
          const layers = await control.frameLayers({
            ...(typeof args.t === 'number' ? { t: args.t } : {}),
            ...(args.only ? { only: asRecord(args.only) as never } : {}),
          });
          return okText({ ...sig.data, ...(layers.ok ? { layers: layers.data.layers } : {}) });
        }

        case 'render_frame': {
          const size = await snapshotSize(args.size);
          const r = await control.snapshotPng({
            ...(typeof args.t === 'number' ? { t: args.t } : {}),
            ...(size ? { size } : {}),
            ...(args.only ? { only: asRecord(args.only) as never } : {}),
            ...(args.region ? { region: asRecord(args.region) as never } : {}),
          });
          if (!r.ok) return errText(r.error.message, r.error.code, r.error.detail);
          const bytes = r.data;
          const dim = pngSize(bytes);
          const t = typeof args.t === 'number' ? args.t : undefined;
          const caption =
            `Rendered frame${t === undefined ? '' : ` at t=${t}s`} (${dim.w}x${dim.h})` +
            `${args.region ? ', zoomed' : ''}.`;
          // 回显「这一帧到底合成了哪些层」：`only` 把特效轨一起隐藏时，截图与参数
          // 无效长得一模一样，只有这份清单能区分两者。
          const layers = await control.frameLayers({
            ...(typeof args.t === 'number' ? { t: args.t } : {}),
            ...(args.only ? { only: asRecord(args.only) as never } : {}),
          });
          return {
            ok: true,
            text: clip(
              JSON.stringify({
                ok: true,
                data: {
                  w: dim.w,
                  h: dim.h,
                  bytes: bytes.byteLength,
                  ...(layers.ok ? { layers: layers.data.layers } : {}),
                },
              }),
            ),
            images: [{ base64: bytesToBase64(bytes), mimeType: 'image/png', caption }],
          };
        }

        case 'render_sequence': {
          const size = args.size ? await snapshotSize(args.size) : undefined;
          const r = await control.renderSequence({
            ...(typeof args.from === 'number' ? { from: args.from } : {}),
            ...(typeof args.to === 'number' ? { to: args.to } : {}),
            ...(typeof args.step === 'number' ? { step: args.step } : {}),
            ...(size ? { size } : {}),
            ...(typeof args.cols === 'number' ? { cols: args.cols } : {}),
            ...(args.only ? { only: asRecord(args.only) as never } : {}),
            ...(args.region ? { region: asRecord(args.region) as never } : {}),
          });
          if (!r.ok) return errText(r.error.message, r.error.code, r.error.detail);
          const { png, times, cols, rows, w, h } = r.data;
          return {
            ok: true,
            text: clip(
              JSON.stringify({
                ok: true,
                data: { times, cols, rows, w, h, bytes: png.byteLength, layout: 'row-major, time label bottom-left of each cell' },
              }),
            ),
            images: [
              {
                base64: bytesToBase64(png),
                mimeType: 'image/png',
                caption: `Contact sheet: ${times.length} frames from ${times[0]?.toFixed(2)}s in ${cols}x${rows} cells.`,
              },
            ],
          };
        }

        /* -------------------------------------------------------- 时间轴写 */
        case 'add_track':
          return unwrap(await control.addTrack(args.kind === 'audio' ? 'audio' : 'visual', typeof args.name === 'string' ? args.name : undefined));

        case 'remove_track':
          return unwrap(await control.removeTrack(String(args.trackId ?? '')));

        case 'move_track':
          return unwrap(await control.moveTrack(Number(args.from), Number(args.to)));

        case 'set_track':
          return unwrap(
            await control.setTrack(String(args.trackId ?? ''), {
              ...(typeof args.enabled === 'boolean' ? { enabled: args.enabled } : {}),
              ...(typeof args.name === 'string' ? { name: args.name } : {}),
              ...(typeof args.muted === 'boolean' ? { muted: args.muted } : {}),
            }),
          );

        case 'add_clip':
          return unwrap(
            await control.addClip(String(args.trackId ?? ''), {
              kind: args.kind as never,
              start: Number(args.start),
              end: Number(args.end),
              ...(typeof args.id === 'string' ? { id: args.id } : {}),
              ...(typeof args.label === 'string' ? { label: args.label } : {}),
              ...(typeof args.generator === 'string' ? { generator: args.generator } : {}),
              ...(args.params ? { params: asRecord(args.params) as Record<string, number | string> } : {}),
              ...(typeof args.color === 'string' ? { color: args.color } : {}),
              ...(typeof args.assetId === 'string' ? { assetId: args.assetId } : {}),
              ...(typeof args.srcIn === 'number' ? { srcIn: args.srcIn } : {}),
              ...(typeof args.speed === 'number' ? { speed: args.speed } : {}),
              ...(args.doc !== undefined ? { doc: args.doc } : {}),
              ...(typeof args.blend === 'string' ? { blend: args.blend as never } : {}),
              ...(typeof args.opacity === 'number' ? { opacity: args.opacity } : {}),
              ...(typeof args.fit === 'string' ? { fit: args.fit as never } : {}),
              ...(typeof args.fadeSec === 'number' ? { fadeSec: args.fadeSec } : {}),
            }),
          );

        case 'add_effect_clip':
          return unwrap(
            await control.addEffectClip(String(args.trackId ?? ''), {
              start: Number(args.start),
              end: Number(args.end),
              ...(Array.isArray(args.chain) ? { chain: args.chain as never } : {}),
              ...(typeof args.label === 'string' ? { label: args.label } : {}),
              ...(typeof args.fadeSec === 'number' ? { fadeSec: args.fadeSec } : {}),
              ...(typeof args.affectDepth === 'number' ? { affectDepth: args.affectDepth } : {}),
              ...(typeof args.boundClipId === 'string' ? { boundClipId: args.boundClipId } : {}),
            }),
          );

        case 'remove_clip':
          return unwrap(await control.removeClip(String(args.clipId ?? '')));

        case 'move_clip':
          return unwrap(
            await control.moveClip(String(args.clipId ?? ''), String(args.targetTrackId ?? ''), Number(args.newStart)),
          );

        case 'resize_clip':
          return unwrap(
            await control.resizeClip(String(args.clipId ?? ''), args.edge === 'start' ? 'start' : 'end', Number(args.time)),
          );

        case 'split_clip':
          return unwrap(await control.splitClip(String(args.clipId ?? ''), Number(args.at)));

        case 'set_clip_props':
          return unwrap(await control.setClipProps(String(args.clipId ?? ''), asRecord(args.patch)));

        case 'set_params':
          return unwrap(
            args.target === 'effect'
              ? await control.setEffectParams(
                  String(args.clipId ?? ''),
                  Number(args.chainIndex),
                  args.params === undefined
                    ? undefined
                    : (asRecord(args.params) as Record<string, number | string>),
                  typeof args.enabled === 'boolean' ? args.enabled : undefined,
                  /*
                   * `mask` 的三态必须原样传下去：`undefined`（没给，不动）、
                   * `null`（摘掉）、对象（接上）。写成 `args.mask ?? null` 会把
                   * 「没给」变成「摘掉」—— 每次点参数都会把蒙版清掉。
                   */
                  'mask' in args
                    ? (args.mask as never)
                    : undefined,
                )
              : await control.setClipSourceParams(
                  String(args.clipId ?? ''),
                  asRecord(args.params) as Record<string, number | string>,
                ),
          );

        case 'set_generator':
          return unwrap(
            await control.setGenerator(
              String(args.clipId ?? ''),
              String(args.generator ?? ''),
              args.params === undefined
                ? undefined
                : (asRecord(args.params) as Record<string, number | string>),
            ),
          );

        case 'seed_pattern_from_asset':
          return unwrap(
            await control.seedPatternFromAsset(
              String(args.clipId ?? ''),
              String(args.param ?? ''),
              String(args.assetId ?? ''),
            ),
          );

        case 'set_curve':
          return unwrap(
            await control.setCurve(String(args.clipId ?? ''), String(args.param ?? ''), (args.curve ?? null) as never),
          );

        case 'list_modulators':
          return unwrap(await control.listModulators());

        case 'set_modulator':
          return unwrap(
            await control.setModulator({
              id: typeof args.id === 'string' && args.id ? args.id : undefined,
              name: typeof args.name === 'string' ? args.name : undefined,
              expr: typeof args.expr === 'string' ? args.expr : undefined,
              min: typeof args.min === 'number' ? args.min : undefined,
              max: typeof args.max === 'number' ? args.max : undefined,
            }),
          );

        case 'remove_modulator':
          return unwrap(await control.removeModulator(String(args.id ?? '')));

        case 'bind_modulator':
          return unwrap(
            await control.bindModulator({
              clipId: String(args.clipId ?? ''),
              param: String(args.param ?? ''),
              modulatorId: String(args.modulatorId ?? ''),
              gain: typeof args.gain === 'number' ? args.gain : undefined,
              mode: args.mode === 'mul' ? 'mul' : args.mode === 'add' ? 'add' : undefined,
            }),
          );

        case 'unbind_modulator':
          return unwrap(
            await control.unbindModulator(
              String(args.clipId ?? ''),
              String(args.param ?? ''),
              typeof args.modulatorId === 'string' && args.modulatorId ? args.modulatorId : undefined,
            ),
          );

        case 'add_effect':
          return unwrap(
            await control.addEffect(
              String(args.clipId ?? ''),
              String(args.defId ?? ''),
              asRecord(args.values) as Record<string, number | string>,
              typeof args.index === 'number' ? args.index : undefined,
              typeof args.enabled === 'boolean' ? args.enabled : undefined,
            ),
          );

        case 'remove_effect':
          return unwrap(await control.removeEffect(String(args.clipId ?? ''), Number(args.chainIndex)));

        case 'reorder_effect':
          return unwrap(await control.reorderEffect(String(args.clipId ?? ''), Number(args.from), Number(args.to)));

        case 'set_transition':
          return unwrap(
            await control.setTransition(
              String(args.clipId ?? ''),
              String(args.defId ?? ''),
              Number(args.duration),
              asRecord(args.values) as Record<string, number>,
              args.side === 'in' ? 'in' : 'out',
            ),
          );

        case 'clear_transition':
          return unwrap(
            await control.clearTransition(String(args.clipId ?? ''), args.side === 'in' ? 'in' : 'out'),
          );

        case 'get_asset_ranges':
          return unwrap(await control.getAssetRanges(String(args.assetId ?? '')));

        case 'set_asset_range':
          return unwrap(
            await control.setAssetRange(String(args.assetId ?? ''), {
              ...(typeof args.rangeId === 'string' ? { id: args.rangeId } : {}),
              ...(typeof args.name === 'string' ? { name: args.name } : {}),
              inSec: Number(args.inSec),
              outSec: Number(args.outSec),
            }),
          );

        case 'remove_asset_range':
          return unwrap(
            await control.removeAssetRange(String(args.assetId ?? ''), String(args.rangeId ?? '')),
          );

        case 'set_active_range':
          return unwrap(
            await control.setActiveRange(
              String(args.assetId ?? ''),
              typeof args.rangeId === 'string' && args.rangeId ? args.rangeId : null,
            ),
          );

        case 'detach_video_audio':
          return unwrap(await control.detachVideoAudio(String(args.clipId ?? '')));

        case 'set_audio_lock':
          return unwrap(
            await control.setAudioLock(String(args.clipId ?? ''), args.locked !== false),
          );

        case 'set_clip_audio':
          return unwrap(
            await control.setClipAudio(String(args.clipId ?? ''), {
              ...(typeof args.gainDb === 'number' ? { gainDb: args.gainDb } : {}),
              ...(typeof args.fadeIn === 'number' ? { fadeIn: args.fadeIn } : {}),
              ...(typeof args.fadeOut === 'number' ? { fadeOut: args.fadeOut } : {}),
              ...(typeof args.muted === 'boolean' ? { muted: args.muted } : {}),
            }),
          );

        case 'estimate_beat_grid':
          return unwrap(await control.estimateBeatGrid());

        case 'media_list':
          return unwrap(await control.listMediaPool());

        case 'media_op':
          // `confirm` 不在这里传：需要审批时控制平面回 needs-approval，用户点过之后
          // 由会话层带 `confirm:true` 重放（模型不能自己批准）。
          return unwrap(
            await control.mediaPoolOp({
              op: String(args.op ?? '') as never,
              ...(typeof args.assetId === 'string' ? { assetId: args.assetId } : {}),
            }),
          );

        case 'rename_asset':
          return unwrap(
            await control.renameAsset(String(args.assetId ?? ''), String(args.name ?? '')),
          );

        case 'set_project':
          return unwrap(
            await control.setProject({
              ...(typeof args.name === 'string' ? { name: args.name } : {}),
              ...(typeof args.fps === 'number' ? { fps: args.fps } : {}),
              ...(args.resolution ? { resolution: asRecord(args.resolution) as { w: number; h: number } } : {}),
              ...(typeof args.duration === 'number' ? { duration: args.duration } : {}),
              ...(args.beatGrid ? { beatGrid: asRecord(args.beatGrid) as never } : {}),
              ...(typeof args.overlapBehavior === 'string' ? { overlapBehavior: args.overlapBehavior as never } : {}),
            }),
          );

        case 'edit_sections': {
          const op = String(args.op ?? '');
          const sectionId = typeof args.sectionId === 'string' ? args.sectionId : '';
          switch (op) {
            case 'add':
              return unwrap(
                await control.editSections({
                  op: 'add',
                  start: Number(args.start),
                  ...(typeof args.name === 'string' ? { name: args.name } : {}),
                }),
              );
            case 'split':
              return unwrap(
                await control.editSections({ op: 'split', sectionId, at: Number(args.at) }),
              );
            case 'rename':
              return unwrap(
                await control.editSections({ op: 'rename', sectionId, name: String(args.name ?? '') }),
              );
            case 'remove':
              return unwrap(await control.editSections({ op: 'remove', sectionId }));
            case 'move':
              return unwrap(
                await control.editSections({ op: 'move', sectionId, start: Number(args.start) }),
              );
            default:
              return errText(`unknown edit_sections op: ${op}`, 'invalid-argument', {
                validIds: ['add', 'split', 'rename', 'remove', 'move'],
              });
          }
        }

        case 'load_scene':
          return unwrap(await control.loadScene(args.project));

        case 'begin_transaction':
          return unwrap(await control.beginTx());

        case 'commit_transaction':
          return unwrap(await control.endTx(typeof args.label === 'string' ? args.label : 'agent: turn'));

        case 'cancel_transaction':
          return unwrap(await control.cancelTx());

        case 'undo':
          return unwrap(await control.undo());

        case 'redo':
          return unwrap(await control.redo());

        /* ------------------------------------------------------------ 排版 */
        case 'typo_add_element':
          return unwrap(
            await control.addTypographyElement(
              typeof args.clipId === 'string' ? args.clipId : undefined,
              asRecord(args.element) as never,
            ),
          );

        case 'typo_add_elements':
          return unwrap(
            await control.addTypographyElements(
              typeof args.clipId === 'string' ? args.clipId : undefined,
              (Array.isArray(args.elements) ? args.elements : []) as never,
            ),
          );

        case 'typo_measure':
          return unwrap(
            await control.measureTypography(
              typeof args.clipId === 'string' ? args.clipId : undefined,
              Array.isArray(args.elementIds) ? args.elementIds.map(String) : undefined,
            ),
          );

        case 'typo_add_generated_shape':
          return unwrap(
            await control.addGeneratedShape(typeof args.clipId === 'string' ? args.clipId : undefined, {
              genId: String(args.genId ?? ''),
              ...(args.params ? { params: asRecord(args.params) as Record<string, number | string> } : {}),
              ...(typeof args.seed === 'number' ? { seed: args.seed } : {}),
              ...(args.frame ? { frame: asRecord(args.frame) as never } : {}),
              ...(typeof args.name === 'string' ? { name: args.name } : {}),
              ...(args.fill !== undefined ? { fill: args.fill } : {}),
              ...(args.stroke !== undefined ? { stroke: args.stroke } : {}),
            }),
          );

        case 'typo_update_element':
          return unwrap(
            await control.updateTypographyElement(
              typeof args.clipId === 'string' ? args.clipId : undefined,
              String(args.elementId ?? ''),
              asRecord(args.patch) as never,
            ),
          );

        case 'typo_update_elements':
          return unwrap(
            await control.updateTypographyElements(
              typeof args.clipId === 'string' ? args.clipId : undefined,
              (Array.isArray(args.updates) ? args.updates : []) as never,
            ),
          );

        case 'typo_set_animation':
          return unwrap(
            await control.setTypographyAnimation(
              typeof args.clipId === 'string' ? args.clipId : undefined,
              String(args.elementId ?? ''),
              args.animation ?? null,
              args.mode === 'add' ? 'add' : 'replace',
            ),
          );

        case 'typo_copy_style':
          return unwrap(
            await control.copyTypographyStyle(
              typeof args.clipId === 'string' ? args.clipId : undefined,
              String(args.sourceId ?? ''),
              Array.isArray(args.targetIds) ? args.targetIds.map(String) : [],
              args.what === 'animation' ? 'animation' : 'format',
            ),
          );

        case 'typo_set_scripts':
          return unwrap(
            await control.setTypographyScripts(
              typeof args.clipId === 'string' ? args.clipId : undefined,
              args.scripts ?? [],
            ),
          );

        case 'typo_set_text':
          return unwrap(
            await control.setTypographyText(
              typeof args.clipId === 'string' ? args.clipId : undefined,
              String(args.elementId ?? ''),
              String(args.text ?? ''),
            ),
          );

        case 'typo_remove_element':
          return unwrap(
            await control.removeTypographyElement(
              typeof args.clipId === 'string' ? args.clipId : undefined,
              String(args.elementId ?? ''),
            ),
          );

        case 'typo_reorder_element':
          return unwrap(
            await control.reorderTypographyElement(
              typeof args.clipId === 'string' ? args.clipId : undefined,
              String(args.elementId ?? ''),
              (args.op as never) ?? 'front',
              typeof args.index === 'number' ? args.index : undefined,
            ),
          );

        case 'typo_update_group':
          return unwrap(
            await control.updateTypographyGroup(
              typeof args.clipId === 'string' ? args.clipId : undefined,
              String(args.groupId ?? ''),
              asRecord(args.patch),
            ),
          );

        case 'typo_boolean':
          return unwrap(
            await control.booleanTypographyShapes(
              typeof args.clipId === 'string' ? args.clipId : undefined,
              Array.isArray(args.elementIds) ? args.elementIds.map(String) : [],
              String(args.op ?? 'union') as never,
            ),
          );

        case 'typo_divide':
          return unwrap(
            await control.divideTypographyShapes(
              typeof args.clipId === 'string' ? args.clipId : undefined,
              Array.isArray(args.elementIds) ? args.elementIds.map(String) : [],
            ),
          );

        case 'typo_convert_to_path':
          return unwrap(
            await control.convertTypographyToPath(
              typeof args.clipId === 'string' ? args.clipId : undefined,
              Array.isArray(args.elementIds) ? args.elementIds.map(String) : [],
            ),
          );

        case 'typo_set_camera':
          return unwrap(
            await control.setTypographyCamera(
              typeof args.clipId === 'string' ? args.clipId : undefined,
              args.camera ?? null,
            ),
          );

        case 'typo_set_camera_animation':
          return unwrap(
            await control.setTypographyCameraAnimation(
              typeof args.clipId === 'string' ? args.clipId : undefined,
              String(args.channel ?? ''),
              args.keys ?? null,
            ),
          );

        case 'typo_set_canvas_size':
          return unwrap(
            await control.setTypographyCanvasSize(
              typeof args.clipId === 'string' ? args.clipId : undefined,
              asRecord(args.size) as { w: number; h: number },
              args.scaleContent === true,
            ),
          );

        case 'typo_group':
          return unwrap(
            await control.groupTypographyElements(
              typeof args.clipId === 'string' ? args.clipId : undefined,
              Array.isArray(args.elementIds) ? args.elementIds.map(String) : [],
              typeof args.name === 'string' ? args.name : undefined,
            ),
          );

        case 'typo_ungroup':
          return unwrap(
            await control.ungroupTypographyElements(
              typeof args.clipId === 'string' ? args.clipId : undefined,
              Array.isArray(args.elementIds) ? args.elementIds.map(String) : [],
            ),
          );

        case 'typo_layout':
          return unwrap(
            await control.layoutTypography(typeof args.clipId === 'string' ? args.clipId : undefined, {
              op: String(args.op ?? 'align') as never,
              ...(typeof args.axis === 'string' ? { axis: args.axis as never } : {}),
              ...(args.target === 'selection' ? { target: 'selection' as const } : {}),
              ...(Array.isArray(args.elementIds) ? { elementIds: args.elementIds.map(String) } : {}),
              ...(typeof args.cols === 'number' ? { cols: args.cols } : {}),
              ...(typeof args.rows === 'number' ? { rows: args.rows } : {}),
              ...(typeof args.gap === 'number' ? { gap: args.gap } : {}),
              ...(typeof args.margin === 'number' ? { margin: args.margin } : {}),
            } as never),
          );

        case 'typo_set_background':
          return unwrap(
            await control.setTypographyBackground(
              typeof args.clipId === 'string' ? args.clipId : undefined,
              args.paint,
            ),
          );

        case 'typo_set_theme':
          return unwrap(
            await control.setTypographyTheme(
              typeof args.clipId === 'string' ? args.clipId : undefined,
              typeof args.theme === 'string' ? args.theme : null,
              args.scope === 'project' ? 'project' : 'clip',
            ),
          );

        case 'typo_save_theme':
          return unwrap(
            await control.saveTypographyTheme(typeof args.clipId === 'string' ? args.clipId : undefined, {
              ...(typeof args.id === 'string' ? { id: args.id } : {}),
              ...(typeof args.base === 'string' ? { base: args.base } : {}),
              ...(typeof args.name === 'string' ? { name: args.name } : {}),
              ...(args.colors === undefined ? {} : { colors: args.colors }),
              scope: args.scope === 'project' ? 'project' : 'clip',
            }),
          );

        case 'typo_remove_theme':
          return unwrap(await control.removeTypographyTheme(String(args.themeId ?? '')));

        case 'typo_replace_doc':
          return unwrap(
            await control.replaceTypographyDoc(typeof args.clipId === 'string' ? args.clipId : undefined, args.doc),
          );

        /* ------------------------------------------------------------ 插件 */
        case 'plugin_try':
          return unwrap(
            await control.pluginTry({
              id: String(args.id ?? ''),
              name: String(args.name ?? ''),
              // 省略 = 用草稿（`plugin_edit` 之后那条路），见 `tryPlugin` 的注释。
              ...(typeof args.source === 'string' ? { source: args.source } : {}),
            }),
          );

        case 'plugin_view':
          return unwrap(
            await control.pluginView({
              pluginId: String(args.pluginId ?? ''),
              ...(typeof args.offset === 'number' ? { offset: args.offset } : {}),
              ...(typeof args.limit === 'number' ? { limit: args.limit } : {}),
            }),
          );

        case 'plugin_grep':
          return unwrap(
            await control.pluginGrep({
              pluginId: String(args.pluginId ?? ''),
              pattern: String(args.pattern ?? ''),
              ...(typeof args.ignoreCase === 'boolean' ? { ignoreCase: args.ignoreCase } : {}),
              ...(typeof args.context === 'number' ? { context: args.context } : {}),
              ...(typeof args.max === 'number' ? { max: args.max } : {}),
            }),
          );

        case 'plugin_edit':
          return unwrap(
            await control.pluginEdit({
              pluginId: String(args.pluginId ?? ''),
              oldString: String(args.oldString ?? ''),
              newString: String(args.newString ?? ''),
            }),
          );

        case 'plugin_check':
          return unwrap(await control.pluginCheck(String(args.pluginId ?? '')));

        case 'plugin_install':
          // confirm:false → 未确认时返回 needs-approval，由面板弹确认卡。
          return unwrap(await control.pluginInstall(String(args.pluginId ?? ''), false));

        case 'plugin_list':
          return unwrap(await control.pluginList());

        case 'plugin_discard':
          return unwrap(await control.pluginDiscard(String(args.pluginId ?? '')));

        case 'plugin_remove':
          return unwrap(await control.pluginRemove(String(args.pluginId ?? '')));

        case 'plugin_source':
          return unwrap(await control.pluginSource(String(args.pluginId ?? '')));

        /* ------------------------------------------------------------ 导出 */
        case 'export': {
          const format = args.format === 'png' || args.format === 'gif' ? args.format : 'mp4';
          const r = await control.export({
            format,
            ...(args.frameRange ? { frameRange: asRecord(args.frameRange) as never } : {}),
            ...(args.size ? { size: asRecord(args.size) as { w: number; h: number } } : {}),
            ...(typeof args.frameStep === 'number' ? { frameStep: args.frameStep } : {}),
          });
          if (!r.ok) return errText(r.error.message, r.error.code, r.error.detail);
          const name = `artmatic-${Date.now()}.${EXT[format] ?? 'bin'}`;
          saveBlob(r.data.blob, name);
          return okText({ downloadedAs: name, bytes: r.data.bytes, mimeType: r.data.mimeType });
        }

        default:
          return errText(`unknown tool: ${name}`, 'not-found');
      }
    } catch (e) {
      if (e instanceof ControlFailure) return errText(e.message, e.code, e.detail);
      return errText(e instanceof Error ? e.message : String(e), 'internal');
    }
  };
}
