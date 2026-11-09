/**
 * bake-client.ts — 主线程侧烘焙请求 / 缓存 / 纹理上传。
 *
 * 缓存键 = genId + params + seed 的哈希。命中即返回纹理；未命中发
 * Worker 请求并返回 null——这一帧该层缺席，烘好后经 onReady 回调
 * 触发一次重绘（bump version）。
 *
 * R8 + NEAREST：二值纹理用 LINEAR 会出灰边；UNPACK_ALIGNMENT=1
 * 在 kit 里已经设好（行宽非 4 倍数必需的坑在那里已埋）。
 */

import type { Kit } from '../engine/kit';
import type { BakeResult } from './types';

export interface BakedTexture {
  tex: WebGLTexture;
  w: number;
  h: number;
  frontMax: number;
}

interface Pending {
  hash: string;
  resolve: (t: BakedTexture) => void;
}

export class BakeClient {
  private worker: Worker;
  private reqId = 0;
  private readonly pending = new Map<number, Pending>();
  private readonly cache = new Map<string, BakedTexture>();
  /** 同一键的失败是确定性的；不记下来就会每帧重发。 */
  private readonly failed = new Set<string>();
  private disposed = false;

  constructor(
    private readonly kit: Kit,
    private readonly onReady: () => void,
  ) {
    this.worker = new Worker(new URL('./bake.worker.ts', import.meta.url), { type: 'module' });
    this.worker.onerror = (e) => {
      console.error('[bake] worker error', e.message);
      // 崩溃时不清理，请求会永远挂在 pending；顺手把在飞的都记为失败。
      for (const p of this.pending.values()) this.failed.add(p.hash);
      this.pending.clear();
    };
    this.worker.onmessage = (e: MessageEvent) => {
      const msg = e.data as
        | { type: 'done'; reqId: number; result: BakeResult }
        | { type: 'error'; reqId: number; message: string };
      const p = this.pending.get(msg.reqId);
      if (!p) return;
      this.pending.delete(msg.reqId);
      if (msg.type === 'error') {
        this.failed.add(p.hash);
        console.error(`[bake] ${msg.message}`);
        return;
      }
      const tex = this.uploadR8(msg.result);
      this.cache.set(p.hash, tex);
      p.resolve(tex);
      this.onReady();
    };
  }

  /** 请求烘焙结果：命中缓存直接返回，未命中启动 Worker 并返回 null。 */
  request(hash: string, genId: string, params: Record<string, number | string>, seed: number): BakedTexture | null {
    if (this.disposed || this.failed.has(hash)) return null;
    const hit = this.cache.get(hash);
    if (hit) return hit;
    const already = [...this.pending.values()].some((p) => p.hash === hash);
    if (!already) {
      const reqId = ++this.reqId;
      this.pending.set(reqId, {
        hash,
        resolve: () => {},
      });
      this.worker.postMessage({ type: 'bake', reqId, genId, params, seed });
    }
    return null;
  }

  private uploadR8(result: BakeResult): BakedTexture {
    const gl = this.kit.gl;
    const tex = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.R8, result.w, result.h, 0, gl.RED, gl.UNSIGNED_BYTE, result.data);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    return { tex, w: result.w, h: result.h, frontMax: result.frontMax };
  }

  dispose(): void {
    this.disposed = true;
    this.worker.terminate();
    this.pending.clear();
    for (const tex of this.cache.values()) this.kit.gl.deleteTexture(tex.tex);
    this.cache.clear();
    this.failed.clear();
  }
}
