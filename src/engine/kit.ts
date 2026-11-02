/**
 * kit.ts — WebGL2 微工具箱。
 *
 * 移植自 angel-echo js/gl.js（282 行，同作者内部移植，见 CREDITS.md），
 * 去掉 MVP 用不到的 points() 点精灵与 spectrogram()。
 *
 * 两条移植红线（都是踩过的坑）：
 *   1. 上下文属性必须保留 preserveDrawingBuffer: true——导出走
 *      canvas.toBlob / readPixels，没有这个会读到空缓冲。
 *   2. UNPACK_ALIGNMENT = 1——R8 纹理行宽不是 4 的倍数时（如 177 列），
 *      默认 4 字节对齐会把图剪成每行错一字节的斜纹。
 */

import { tr } from '../i18n/index.svelte';

export const VERT_QUAD = `#version 300 es
layout(location = 0) in vec2 aPos;
out vec2 vUv;
void main() {
  vUv = aPos * 0.5 + 0.5;
  gl_Position = vec4(aPos, 0.0, 1.0);
}`;

/* ---------------------------------------------------------------- program */

type UniformValue = number | boolean | number[] | Float32Array;

export class Program {
  private prog: WebGLProgram;
  readonly uniforms: Record<string, WebGLUniformLocation | null> = {};
  private texUnit = 0;

  constructor(
    private gl: WebGL2RenderingContext,
    vsSrc: string,
    fsSrc: string,
    readonly name: string,
  ) {
    const vs = compile(gl, gl.VERTEX_SHADER, vsSrc, `${name}.vert`);
    const fs = compile(gl, gl.FRAGMENT_SHADER, fsSrc, `${name}.frag`);
    const p = gl.createProgram()!;
    gl.attachShader(p, vs);
    gl.attachShader(p, fs);
    gl.linkProgram(p);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) {
      throw new Error(`link ${name}: ${gl.getProgramInfoLog(p)}`);
    }
    gl.deleteShader(vs);
    gl.deleteShader(fs);
    this.prog = p;
    const n = gl.getProgramParameter(p, gl.ACTIVE_UNIFORMS) as number;
    for (let i = 0; i < n; i++) {
      const info = gl.getActiveUniform(p, i)!;
      const nm = info.name.replace(/\[0\]$/, '');
      this.uniforms[nm] = gl.getUniformLocation(p, nm);
    }
  }

  use(): this {
    this.gl.useProgram(this.prog);
    this.texUnit = 0;
    return this;
  }

  /** 按名字设 uniform，setter 按值的形状选。未声明的 uniform 静默跳过。 */
  u(name: string, v: UniformValue): this {
    const gl = this.gl;
    const loc = this.uniforms[name];
    if (loc === undefined || loc === null) return this;
    if (typeof v === 'number') gl.uniform1f(loc, v);
    else if (typeof v === 'boolean') gl.uniform1i(loc, v ? 1 : 0);
    else {
      const n = v.length;
      if (n === 2) gl.uniform2f(loc, v[0]!, v[1]!);
      else if (n === 3) gl.uniform3f(loc, v[0]!, v[1]!, v[2]!);
      else if (n === 4) gl.uniform4f(loc, v[0]!, v[1]!, v[2]!, v[3]!);
      else if (n === 9) gl.uniformMatrix3fv(loc, false, v);
      else if (n === 16) gl.uniformMatrix4fv(loc, false, v);
    }
    return this;
  }

  u1i(name: string, v: number): this {
    const loc = this.uniforms[name];
    if (loc) this.gl.uniform1i(loc, v | 0);
    return this;
  }

  /**
   * 3D 纹理版（`sampler3D`，LUT 用）。
   *
   * **不能拿 `tex()` 绑 3D 纹理**：它把贴图绑到 `TEXTURE_2D` 目标上，而 3D 纹理
   * 必须绑到 `TEXTURE_3D` —— 绑错时 GL 报 `INVALID_OPERATION`，sampler 什么
   * 都收不到，画面完全不变且不报错（只有控制台里一行警告）。
   */
  tex3d(name: string, texture: WebGLTexture): this {
    const gl = this.gl;
    const loc = this.uniforms[name];
    if (loc === undefined || loc === null) return this;
    const unit = this.texUnit++;
    gl.activeTexture(gl.TEXTURE0 + unit);
    gl.bindTexture(gl.TEXTURE_3D, texture);
    gl.uniform1i(loc, unit);
    return this;
  }

  /** 把纹理绑到下一个空闲单元，并把 name 指过去。 */
  tex(name: string, texture: WebGLTexture): this {
    const gl = this.gl;
    const loc = this.uniforms[name];
    if (loc === undefined || loc === null) return this;
    const unit = this.texUnit++;
    gl.activeTexture(gl.TEXTURE0 + unit);
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.uniform1i(loc, unit);
    return this;
  }

  dispose(): void {
    this.gl.deleteProgram(this.prog);
  }
}

function compile(gl: WebGL2RenderingContext, type: number, src: string, label: string): WebGLShader {
  const s = gl.createShader(type)!;
  gl.shaderSource(s, src);
  gl.compileShader(s);
  if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) {
    const log = gl.getShaderInfoLog(s);
    const lines = src
      .split('\n')
      .map((l, i) => `${String(i + 1).padStart(3)}| ${l}`)
      .join('\n');
    console.error(`[shader ${label}] ${log}\n${lines}`);
    throw new Error(`compile ${label}: ${log}`);
  }
  return s;
}

/* ---------------------------------------------------------------- target */

export class Target {
  tex: WebGLTexture;
  private fb: WebGLFramebuffer;
  private readonly nearest: boolean;
  /** 实际是否拿到了浮点渲染目标（缺 EXT_color_buffer_float 时回落 RGBA8）。 */
  readonly float: boolean;

  constructor(
    private gl: WebGL2RenderingContext,
    public w: number,
    public h: number,
    opts: { nearest?: boolean; float?: boolean } = {},
  ) {
    this.nearest = opts.nearest ?? false;
    this.float = (opts.float ?? false) && hasColorBufferFloat(gl);
    this.tex = gl.createTexture()!;
    this.alloc();
    this.fb = gl.createFramebuffer()!;
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.fb);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, this.tex, 0);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  }

  private alloc(): void {
    const gl = this.gl;
    const filter = this.nearest ? gl.NEAREST : gl.LINEAR;
    gl.bindTexture(gl.TEXTURE_2D, this.tex);
    if (this.float) {
      // RGBA16F：有状态模拟的逐帧增量会低于 8bit 量化步长，RGBA8 下会 stall 成色块。
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA16F, this.w, this.h, 0, gl.RGBA, gl.HALF_FLOAT, null);
    } else {
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, this.w, this.h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    }
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, filter);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, filter);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  }

  /** 尺寸变化时重分配（反馈池、ping-pong 都会用到）。保留 filter 与浮点标志。 */
  resize(w: number, h: number): void {
    if (w === this.w && h === this.h) return;
    this.w = w;
    this.h = h;
    const gl = this.gl;
    gl.deleteTexture(this.tex);
    this.tex = gl.createTexture()!;
    this.alloc();
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.fb);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, this.tex, 0);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  }

  bind(): this {
    const gl = this.gl;
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.fb);
    gl.viewport(0, 0, this.w, this.h);
    return this;
  }

  dispose(): void {
    this.gl.deleteTexture(this.tex);
    this.gl.deleteFramebuffer(this.fb);
  }
}

/**
 * 浮点颜色缓冲的可用性。每个上下文只探一次——`getExtension` 的结果
 * 在上下文生命周期内不变，重复问是浪费。
 *
 * **导出是给判定层用的**（`core/grade.ts::gradePrecision`）：`Target.float`
 * 在没有这个扩展时**静默回落 RGBA8**，所以「能不能升 16F」必须在分配之前
 * 问清楚，而不是分配之后看 `target.float`。后者在降级时恰好也是 false，
 * 于是「本来不打算升」与「想升但升不了」分不开。
 */
const floatRtCache = new WeakMap<WebGL2RenderingContext, boolean>();

export function hasColorBufferFloat(gl: WebGL2RenderingContext): boolean {
  const cached = floatRtCache.get(gl);
  if (cached !== undefined) return cached;
  const ok = gl.getExtension('EXT_color_buffer_float') !== null;
  floatRtCache.set(gl, ok);
  return ok;
}

/* ------------------------------------------------------------------- kit */

export class Kit {
  readonly gl: WebGL2RenderingContext;
  readonly canvas: HTMLCanvasElement;
  private quadVao: WebGLVertexArrayObject;
  private programs = new Map<string, Program>();

  constructor(canvas: HTMLCanvasElement) {
    const gl = canvas.getContext('webgl2', {
      alpha: false,
      antialias: false,
      depth: false,
      stencil: false,
      premultipliedAlpha: false,
      preserveDrawingBuffer: true,
      powerPreference: 'high-performance',
    });
    if (!gl) throw new Error(tr('err.platform.webgl2'));
    this.gl = gl;
    this.canvas = canvas;

    /* 全屏三角形 */
    this.quadVao = gl.createVertexArray()!;
    const qb = gl.createBuffer();
    gl.bindVertexArray(this.quadVao);
    gl.bindBuffer(gl.ARRAY_BUFFER, qb);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    gl.bindVertexArray(null);

    gl.disable(gl.DEPTH_TEST);
    gl.disable(gl.BLEND);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
  }

  get w(): number {
    return this.canvas.width;
  }

  get h(): number {
    return this.canvas.height;
  }

  size(w: number, h: number): void {
    if (this.canvas.width === w && this.canvas.height === h) return;
    this.canvas.width = w;
    this.canvas.height = h;
  }

  /** quad program：所有只吃 aPos + vUv 的着色器共用。按名字缓存。 */
  quad(fs: string, name: string, vs: string = VERT_QUAD): Program {
    const cached = this.programs.get(name);
    if (cached) return cached;
    const p = new Program(this.gl, vs, fs, name);
    this.programs.set(name, p);
    return p;
  }

  target(w: number, h: number, opts?: { nearest?: boolean; float?: boolean }): Target {
    return new Target(this.gl, w, h, opts);
  }

  /** 这台设备能不能给浮点渲染目标（见 `hasColorBufferFloat`）。 */
  get floatTargets(): boolean {
    return hasColorBufferFloat(this.gl);
  }

  drawQuad(): void {
    const gl = this.gl;
    gl.bindVertexArray(this.quadVao);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }

  /** 全屏画一个 program 到 target（null = 默认帧缓冲，即屏幕）。 */
  pass(program: Program, target: Target | null): void {
    const gl = this.gl;
    if (target) target.bind();
    else {
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      gl.viewport(0, 0, this.w, this.h);
    }
    program.use();
    this.drawQuad();
  }

  clear(r = 0, g = 0, b = 0, a = 0): void {
    const gl = this.gl;
    gl.clearColor(r, g, b, a);
    gl.clear(gl.COLOR_BUFFER_BIT);
  }
}
