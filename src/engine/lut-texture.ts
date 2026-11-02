/**
 * lut-texture.ts — `.cube` 查找表的 3D 纹理（`u_lut`）。
 *
 * 与 `glyph-atlas.ts` / `curve-texture.ts` 同构：CPU 侧解析（`core/lut-cube.ts`），
 * GL 侧只负责上传与绑定；特效只认 uniform 协议。
 *
 * ## 没有 LUT 时绑的是「2 阶恒等表」
 *
 * 不绑 sampler 是未定义行为，而绑一张假数据会让「没载入」和「载入了但读失败」
 * 长得一样。2×2×2 的恒等斜坡经过三线性插值**在数学上恰好等于 `x`** ——
 * 于是「没有 LUT」与「恒等 LUT」是同一条路径，shader 不需要分支。
 *
 * ## 异步载入，抢跑的是「这张先绑上，下一帧换掉」
 *
 * LUT 字节可能还在磁盘上（打开工程后第一次渲）。这里不阻塞渲染：先绑恒等表，
 * 载入完成写进缓存，下一次 `bindTo` 就拿到了。预览循环每帧都跑，所以最多
 * 一帧的延迟 —— 比「为了 LUT 让整帧 await」好得多（那是硬约束 1.1 的地盘）。
 */

import type { Kit, Program } from './kit';
import { parseCubeLut } from '../core/lut-cube';

/** 取 LUT 字节：同步（已在内存）或异步（要读盘）。 */
export type LutLoader = (assetId: string) => Uint8Array | null | Promise<Uint8Array | null>;

interface Entry {
  tex: WebGLTexture;
  size: number;
  used: number;
}

const MAX_ENTRIES = 4;

export class LutTextures {
  private readonly scratchUnit: number;
  private readonly cache = new Map<string, Entry>();
  private readonly pending = new Set<string>();
  /** 载入失败的素材（面板要据此说「这条 LUT 读不了」）。 */
  private readonly failed = new Map<string, string>();
  private clock = 0;
  /** 2 阶恒等表：没有 LUT 时绑它。 */
  private readonly identity: WebGLTexture;

  constructor(
    private readonly kit: Kit,
    private load: LutLoader,
  ) {
    const gl = kit.gl;
    const max = gl.getParameter(gl.MAX_COMBINED_TEXTURE_IMAGE_UNITS) as number;
    this.scratchUnit = Math.max(1, (max || 16) - 1);
    this.identity = this.upload(identityGrid(), 2);
  }

  /** 换了字节来源（例如切工程）时重设读取器。 */
  setLoader(load: LutLoader): void {
    this.load = load;
  }

  /**
   * 绑 LUT。`assetId` 为空 / 还没载入时绑恒等表。
   *
   * 没声明 `u_lut` 的 program 直接返回（其余特效零开销）。
   */
  bindTo(prog: Program, assetId: string | null): void {
    if (!prog.uniforms['u_lut']) return;
    if (!assetId) {
      prog.tex3d('u_lut', this.identity).u('u_lutOn', 0);
      return;
    }
    const hit = this.cache.get(assetId);
    if (!hit) {
      this.request(assetId);
      prog.tex3d('u_lut', this.identity).u('u_lutOn', 0);
      return;
    }
    hit.used = ++this.clock;
    prog.tex3d('u_lut', hit.tex).u('u_lutOn', 1).u('u_lutSize', hit.size);
  }

  /** 这条素材为什么载入失败（诊断 / 面板提示）。没有失败返回 null。 */
  errorOf(assetId: string): string | null {
    return this.failed.get(assetId) ?? null;
  }

  /** 素材字节变了（重新导入同一个 id）时丢掉缓存。 */
  invalidate(assetId: string): void {
    const hit = this.cache.get(assetId);
    if (hit) {
      this.kit.gl.deleteTexture(hit.tex);
      this.cache.delete(assetId);
    }
    this.failed.delete(assetId);
    this.pending.delete(assetId);
  }

  clear(): void {
    const gl = this.kit.gl;
    for (const e of this.cache.values()) gl.deleteTexture(e.tex);
    this.cache.clear();
    this.failed.clear();
    this.pending.clear();
  }

  private request(assetId: string): void {
    if (this.pending.has(assetId)) return;
    this.pending.add(assetId);
    void (async () => {
      try {
        const bytes = await this.load(assetId);
        if (!bytes) {
          this.failed.set(assetId, 'missing');
          return;
        }
        const text = new TextDecoder().decode(bytes);
        const parsed = parseCubeLut(text);
        if (!parsed.ok) {
          this.failed.set(assetId, parsed.reason);
          return;
        }
        this.failed.delete(assetId);
        const entry: Entry = { tex: this.upload(parsed.lut.data, parsed.lut.size), size: parsed.lut.size, used: ++this.clock };
        this.cache.set(assetId, entry);
        this.evict();
      } catch (e) {
        // 读盘失败也要落成「读不了」，否则面板上永远显示「载入中」。
        this.failed.set(assetId, e instanceof Error ? e.message : 'read-failed');
      } finally {
        this.pending.delete(assetId);
      }
    })();
  }

  private upload(data: Float32Array, size: number): WebGLTexture {
    const gl = this.kit.gl;
    gl.activeTexture(gl.TEXTURE0 + this.scratchUnit);
    const tex = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_3D, tex);
    gl.texImage3D(gl.TEXTURE_3D, 0, gl.RGBA16F, size, size, size, 0, gl.RGBA, gl.FLOAT, data);
    gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_WRAP_R, gl.CLAMP_TO_EDGE);
    gl.bindTexture(gl.TEXTURE_3D, null);
    return tex;
  }

  private evict(): void {
    if (this.cache.size <= MAX_ENTRIES) return;
    const gl = this.kit.gl;
    const oldest = [...this.cache.entries()].sort((a, b) => a[1].used - b[1].used);
    for (const [key, e] of oldest) {
      if (this.cache.size <= MAX_ENTRIES) break;
      gl.deleteTexture(e.tex);
      this.cache.delete(key);
    }
  }
}

/** 2 阶恒等网格：三线性插值下等价于 `x`（见文件头）。 */
function identityGrid(): Float32Array {
  const out = new Float32Array(2 * 2 * 2 * 4);
  let w = 0;
  for (let b = 0; b < 2; b += 1) {
    for (let g = 0; g < 2; g += 1) {
      for (let r = 0; r < 2; r += 1) {
        out[w] = r;
        out[w + 1] = g;
        out[w + 2] = b;
        out[w + 3] = 1;
        w += 4;
      }
    }
  }
  return out;
}
