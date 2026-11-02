/**
 * curve-texture.ts — 调色曲线的采样表（`u_curve`）：1024×4 的 R16F。
 *
 * 与 `glyph-atlas.ts` / `spectrum-texture.ts` / `box-tracker.ts` 同构：
 * CPU 侧准备好数据（这里是三段 Hermite 采样），GL 侧只负责上传与绑定；特效
 * 那一侧只认 uniform 协议（fragment 声明了 `u_curve` 就调用它），所以主应用、
 * `/lab/`、离屏缩略图渲染器自动都有。
 *
 * ## 为什么是「一张纹理四行」而不是四张纹理
 *
 * 主 / R / G / B 是同一组参数的四张表，永远一起变。四张纹理要么四个 sampler
 * （单元预算），要么四次上传；一张四行的纹理一次 `texSubImage` 就够，shader
 * 侧只是 `vec2(x, (row + 0.5) / 4)`。
 *
 * ## 为什么是 R16F 而不是 RGBA8
 *
 * 8 位表会把曲线量化成 1/255 的台阶 —— 平滑渐变上直接看得见色带，
 * 而这恰恰是「用曲线做微调」时最不能有的东西。R16F 单通道、每像素 2 字节，
 * 1024×4 只要 8 KB。
 *
 * ## 建纹理前先切 scratch 单元
 *
 * `Program.tex()` 把采样本依次绑到 0..n 并留下最后一个为激活态，而
 * `bindTexture` / `texImage2D` 作用在**当前激活单元**上 —— 直接建纹理会把
 * `u_texture` 顶掉（`effects/AGENTS.md` 记过两次真实事故）。
 */

import type { Kit, Program } from './kit';
import { TONE_CURVE_ROWS, TONE_CURVE_WIDTH, parseToneCurve, sampleToneCurve } from '../core/tone-curve';

/** 一个调色模块要传的曲线集。空串 / 缺省 = 恒等。 */
export interface ToneCurveSet {
  master?: string;
  r?: string;
  g?: string;
  b?: string;
}

interface Entry {
  tex: WebGLTexture;
  used: number;
}

/** 最多留几张：拖曲线时每帧都会产生新内容，必须封顶。 */
const MAX_ENTRIES = 8;

/**
 * 表内容的键：四条参数串，缺省与空串等价（都表示恒等）。
 *
 * 不按「采样后的表」做键：那要先算 4096 个点才能查缓存，而拖一条曲线每帧
 * 只产生一个键 —— 用原始串更快，且同样能把「拖回恒等」复用成同一张纹理。
 */
function keyOf(set: ToneCurveSet): string {
  return [set.master ?? '', set.r ?? '', set.g ?? '', set.b ?? ''].join('\u0000');
}

export class CurveTextures {
  private readonly scratchUnit: number;
  private readonly cache = new Map<string, Entry>();
  private clock = 0;
  /** 没有曲线 / 还没建好时绑它：恒等表（画面原样）。 */
  private readonly identity: WebGLTexture;

  constructor(private readonly kit: Kit) {
    const gl = kit.gl;
    const max = gl.getParameter(gl.MAX_COMBINED_TEXTURE_IMAGE_UNITS) as number;
    this.scratchUnit = Math.max(1, (max || 16) - 1);
    this.identity = this.upload(this.buildTable({}), true);
  }

  /**
   * program 声明了 `u_curve` 就绑表；没声明直接返回（其它七十多个特效零开销）。
   *
   * `set === null` 绑恒等表而不是不绑：未绑定的 sampler 是未定义行为，
   * 而「原样输出」是坏掉时最容易认出来的样子。
   */
  bindTo(prog: Program, set: ToneCurveSet | null): void {
    if (!prog.uniforms['u_curve']) return;
    if (!set) {
      prog.tex('u_curve', this.identity);
      return;
    }
    const key = keyOf(set);
    let hit = this.cache.get(key);
    const fresh = !hit;
    if (!hit) {
      hit = { tex: this.upload(this.buildTable(set)), used: 0 };
      this.cache.set(key, hit);
    }
    /*
     * **先记 `used`，再淘汰。**
     *
     * 顺序反过来（先 `evict()` 后赋值）时，刚建的那一条 `used` 还是 0 ——
     * 它是全表最小值，于是 `evict()` 删掉的恰好是**下一行就要绑的那张**纹理：
     * 绑定一个已删除的纹理不生效，采样停在上一张上。临床表现是「拖曲线拖到第
     * 七八步画面就不动了，刷新页面（缓存清空）又好了」，而且不报错。
     */
    hit.used = ++this.clock;
    if (fresh) this.evict();
    prog.tex('u_curve', hit.tex);
  }

  /** 诊断 / 上下文重建用。正常路径不需要调用（缓存已按张数封顶）。 */
  clear(): void {
    const gl = this.kit.gl;
    for (const e of this.cache.values()) gl.deleteTexture(e.tex);
    this.cache.clear();
  }

  /**
   * 四张表拼成一个 `Float32Array(1024 * 4)`，行序 = 主 / R / G / B。
   *
   * 每行都从**控制点**重新采样（而不是复用上一帧的表），因为曲线之间没有
   * 增量关系 —— 一条 1024 点的 Hermite 采样在这个频率下完全不是瓶颈。
   */
  private buildTable(set: ToneCurveSet): Float32Array {
    const rows = [set.master, set.r, set.g, set.b];
    const data = new Float32Array(TONE_CURVE_WIDTH * TONE_CURVE_ROWS);
    for (let row = 0; row < TONE_CURVE_ROWS; row += 1) {
      const table = sampleToneCurve(parseToneCurve(rows[row]), TONE_CURVE_WIDTH);
      data.set(table, row * TONE_CURVE_WIDTH);
    }
    return data;
  }

  private upload(data: Float32Array, keep = false): WebGLTexture {
    const gl = this.kit.gl;
    gl.activeTexture(gl.TEXTURE0 + this.scratchUnit);
    const tex = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, tex);
    // R16F + RED + FLOAT：规格允许（R16F 接受 HALF_FLOAT 或 FLOAT），
    // 上传端用 Float32Array 最省事，GPU 侧自动转半浮点。
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.R16F, TONE_CURVE_WIDTH, TONE_CURVE_ROWS, 0, gl.RED, gl.FLOAT, data);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    if (!keep) gl.bindTexture(gl.TEXTURE_2D, null);
    return tex;
  }

  private evict(): void {
    if (this.cache.size <= MAX_ENTRIES) return;
    const gl = this.kit.gl;
    const oldest = [...this.cache.entries()].sort((a, b) => a[1].used - b[1].used);
    for (const [key, e] of oldest) {
      if (this.cache.size <= MAX_ENTRIES) break;
      // 正在用的那张（`used` 刚被刷新，等于当前时钟）绝不淘汰。
      if (e.used === this.clock) continue;
      gl.deleteTexture(e.tex);
      this.cache.delete(key);
    }
  }
}
