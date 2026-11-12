/**
 * files.ts — Files API：把图片换成 `file_id` 再进对话。
 *
 * ## 为什么值得多一次上传
 *
 * 一张 640px 截图 base64 之后 1–3 MB，而它在对话里的**信息量**只有 1024 token。
 * 两者分属不同的限额（token 归上下文窗口，字节归 48 MiB 请求体），所以「环里
 * 才 12%，上游说输入太大」是真实存在的一对。走 Files API 之后历史里只留
 * `file-api-xxxx`：请求体小三个数量级，而模型看到的仍是同一张图。
 *
 * 顺带解决第二件事：**历史可以带着图恢复**。以前截图只存在内存里，恢复会话
 * 只剩一行说明；现在 `file_id` 能落进会话记录（40 字节），恢复时按 id 引用同一张图。
 * 注意它**不能**让恢复后的第一轮命中旧缓存：工具调用与结果本来就没落盘，
 * 恢复出来的字节序列与当时发出去的不一样（见 `history.ts::resumedMessages`）。
 *
 * ## 有效期
 *
 * 官方范围 1 小时 – 30 天，不传就永久。这里**显式要 30 天**（上限）：
 *   - 不传的话文件永久留在账号里，25 GiB / 10000 个的上限迟早被截图撑满；
 *   - 30 天足够「隔几天接着聊」，过期后 `file_id` 失效，恢复时按过期时间过滤掉。
 *
 * ## 去重
 *
 * 同一张图（同样的 base64）在一个会话里只上传一次：`render_frame` 在同一 t 连
 * 调两次是常态，而重复上传既慢又占配额。键用长度 + FNV-1a，命中即复用。
 */

import { LlmError, type LlmConfig } from './types';
import { apisOf, providerOf } from './providers/registry';
import { authHeaders } from './providers/endpoint';
import { providerFetch } from './transport';

/** 默认有效期：30 天（官方上限）。 */
export const FILE_TTL_SECONDS = 2_592_000;

/** 单次上传的失败原因里最容易被误读的一条：文件太大。 */
const MAX_BYTES_FALLBACK = 64 * 1024 * 1024;

export interface ImageInput {
  base64: string;
  mimeType: string;
}

export interface UploadedImage {
  fileId: string;
  /** 毫秒时间戳；`null` = 官方没给（没设有效期），当作不过期。 */
  expiresAt: number | null;
  bytes: number;
}

/** base64 → 字节。不用 `atob` 拼字符串：2 MB 的图会炸掉调用栈。 */
export function base64Bytes(base64: string): Uint8Array<ArrayBuffer> {
  const clean = base64.includes(',') ? base64.slice(base64.indexOf(',') + 1) : base64;
  const bin = atob(clean);
  // 显式用 `new ArrayBuffer` 分配：`new Uint8Array(n)` 的 buffer 类型是
  // `ArrayBufferLike`，喂给 `Blob` 会因 `SharedArrayBuffer` 的可能而被 TS 拒。
  const out = new Uint8Array(new ArrayBuffer(bin.length));
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** 去重键：长度 + FNV-1a 32（足够区分不同截图，且不用引 crypto）。 */
export function imageKey(image: ImageInput): string {
  const s = image.base64;
  let h = 0x811c9dc5;
  /*
   * **采样**而不是整串哈希：一张 3 MB 的图逐字符算要几十毫秒，而这里只需要
   * 「两张不同的截图不撞」。所以固定取 ~64 个等距位置 + 末尾 8 个字符
   * （PNG 的差异常常落在尾部压缩块里）。步长必须随长度自适应 —— 固定步长
   * 在短图上只取到第一个字符，那会造成真实碰撞（曾在小图上踩到）。
   */
  const step = Math.max(1, Math.floor(s.length / 64));
  for (let i = 0; i < s.length; i += step) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  for (let i = Math.max(0, s.length - 8); i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return `${image.mimeType}:${s.length}:${h.toString(36)}`;
}

/** 扩展名由 MIME 反推（官方按内容判格式，文件名只是给人看的）。 */
function extOf(mimeType: string): string {
  switch (mimeType.toLowerCase()) {
    case 'image/jpeg':
      return 'jpg';
    case 'image/webp':
      return 'webp';
    case 'image/gif':
      return 'gif';
    default:
      return 'png';
  }
}

/** 上传用的表单（纯函数，单测能直接查字段）。 */
export function uploadForm(image: ImageInput, filename: string, ttl = FILE_TTL_SECONDS): FormData {
  const form = new FormData();
  const bytes = base64Bytes(image.base64);
  form.append('file', new Blob([bytes], { type: image.mimeType }), filename);
  form.append('purpose', 'user_data');
  if (ttl > 0) {
    form.append('expires_after[anchor]', 'created_at');
    form.append('expires_after[seconds]', String(Math.round(ttl)));
  }
  return form;
}

/** 解析上传响应。缺 `id` 视为上游异常，别让 `undefined` 混进历史。 */
export function parseUpload(json: unknown, fallbackBytes = 0): UploadedImage {
  if (typeof json !== 'object' || json === null) throw new LlmError('bad-response', 'files: empty response');
  const rec = json as Record<string, unknown>;
  const id = typeof rec.id === 'string' ? rec.id : '';
  if (!id) throw new LlmError('bad-response', 'files: response has no id');
  const expires = Number(rec.expires_at);
  return {
    fileId: id,
    expiresAt: Number.isFinite(expires) && expires > 0 ? expires * 1000 : null,
    bytes: Number.isFinite(Number(rec.bytes)) ? Number(rec.bytes) : fallbackBytes,
  };
}

/* ---------------------------------------------------------------- 缓存 */

const cache = new Map<string, UploadedImage>();

/** 测试用：清空去重缓存。 */
export function resetFileCache(): void {
  cache.clear();
}

/**
 * 上传一张图。这家没有 Files API 时抛 `unsupported`（调用方据此回落内联）。
 *
 * 失败一律抛 `LlmError`：截图是「锦上添花」，调用方要能安静地退回 base64，
 * 而不是让整轮对话失败。
 */
export async function uploadImage(
  config: LlmConfig,
  image: ImageInput,
  filename: string,
  signal?: AbortSignal,
): Promise<UploadedImage> {
  const api = apisOf(config.providerId).files;
  if (!api) throw new LlmError('unsupported', `${config.providerId} has no files api`);

  const key = imageKey(image);
  const hit = cache.get(key);
  // 有 id 但已过期（30 天前的缓存项）就重传，别把一个死 id 塞进历史。
  if (hit && (hit.expiresAt === null || hit.expiresAt > Date.now())) return hit;

  const bytes = base64Bytes(image.base64);
  const limit = api.maxBytes ?? MAX_BYTES_FALLBACK;
  if (bytes.byteLength > limit) {
    throw new LlmError('unsupported', `image is ${Math.round(bytes.byteLength / 1024)} KiB, over the ${Math.round(limit / 1024)} KiB limit`);
  }

  const form = uploadForm(image, filename.endsWith(`.${extOf(image.mimeType)}`) ? filename : `${filename}.${extOf(image.mimeType)}`);
  // **不要**手写 Content-Type：boundary 由浏览器生成，写一个固定值会直接 400。
  const def = providerOf(config.providerId);
  const res = await providerFetch(config, api.upload, {
    method: 'POST',
    headers: authHeaders(def.auth, config.apiKey),
    body: form,
  }, signal);

  let json: unknown;
  try {
    json = await res.json();
  } catch {
    throw new LlmError('bad-response', 'files: upload did not return JSON');
  }
  const uploaded = parseUpload(json, bytes.byteLength);
  cache.set(key, uploaded);
  return uploaded;
}

/** 这个 `file_id` 还能用吗（恢复历史时按它过滤）。 */
export function fileStillValid(expiresAt: number | null | undefined, now = Date.now()): boolean {
  return expiresAt === undefined || expiresAt === null || expiresAt > now;
}
