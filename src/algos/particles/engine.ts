/**
 * engine.ts — `ParticleEngine`：GPU 状态纹理的生命周期与确定性推进。
 *
 * 四张状态纹理（pos / vel 各一组 ping-pong），**只在构造时按上限开一次**，
 * 之后 `count` 滑杆只改「画几个点」，不重分配纹理。
 *
 * 确定性（硬约束 1.3）靠三件事：
 *   1. 每一步的两次 pass 都从**同一份 src** 读，做完才 swap ⇒ 与执行顺序无关；
 *   2. `u_step` 是步号（不是墙钟），所有随机是 `(槽, 步号, 种子)` 的闭式 hash；
 *   3. 快照存**内部精度的原始字节**，恢复时逐位上传 ⇒ `seek(f) ≡ 顺序 step f 次`。
 *
 * `readPixels` 是同步 stall，所以**只在快照点**读，绝不逐帧全量读。
 */

import type { Kit, Program, Target } from '../../engine/kit';
import type { AlgoAuxTexture, AlgoUniformCtx } from '../shader-lib';
import type { GpuSimHandle } from '../types';
import { SnapshotRing } from '../sim-util';
import { normalizeParticleConfig, type ParticleConfig } from './config';
import {
  DEFAULT_PARTICLE_SHADERS,
  particleProgramName,
  type ParticleProgramPart,
  type ParticleShaders,
} from './glsl';
import { auxOf } from './assets';

export type { ParticleShaders } from './glsl';
export { DEFAULT_PARTICLE_SHADERS } from './glsl';

/** 覆盖 GLSL 之后追加自定义 uniform 的钩子（内核仍然派发自己那批）。 */
export interface ParticleHooks {
  setStepUniforms?: (
    prog: Program,
    values: Record<string, number | string>,
    ctx: AlgoUniformCtx,
  ) => void;
  setRenderUniforms?: (
    prog: Program,
    values: Record<string, number | string>,
    ctx: AlgoUniformCtx,
  ) => void;
}

export interface ParticleEngineOptions {
  cfg: ParticleConfig;
  /** 构造期参数原表 —— 复用者的自定义 uniform 从它取值。渲染期可变的那批走 `values`。 */
  values: Record<string, number | string>;
  seed: number;
  /** 生成器的 id。**program 名按它区分** —— 名字相同会复用上一份 program。 */
  id: string;
  shaders?: Partial<ParticleShaders>;
  hooks?: ParticleHooks;
}

/** 一次快照 = 两张状态纹理的原始字节 + 当时用的 ping-pong 面。 */
interface StateSnapshot {
  pos: Uint8Array;
  vel: Uint8Array;
  side: number;
}

const cloneSnapshot = (s: StateSnapshot): StateSnapshot => ({
  pos: new Uint8Array(s.pos),
  vel: new Uint8Array(s.vel),
  side: s.side,
});

export interface ParticleDiagnostics {
  precision: '32f' | '8';
  degraded: boolean;
  reason: string;
  count: number;
  maxParticles: number;
  simFrame: number;
  snapshots: number;
}

/**
 * 降级原因只在**变化时在控制台报一次**（照 `compositor.ts` 的手法），
 * 不逐帧刷、不打印素材内容或参数全表。
 */
let lastWarn = '';
function warnOnce(reason: string): void {
  if (reason === lastWarn) return;
  lastWarn = reason;
  if (reason) console.warn(`[particles] ${reason}`);
}

export class ParticleEngine implements GpuSimHandle {
  readonly texW: number;
  readonly texH: number;
  readonly count: number;
  readonly stepsPerSec: number;
  readonly stateBytes: number;
  readonly precision: '32f' | '8';
  readonly degraded: boolean;
  readonly degradeReason: string;

  private readonly gl: WebGL2RenderingContext;
  private readonly pos: [Target, Target];
  private readonly vel: [Target, Target];
  private readonly initProg;
  private readonly stepPosProg;
  private readonly stepVelProg;
  private readonly pointProg;
  private readonly ring: SnapshotRing<StateSnapshot>;
  private readonly encode: number;
  private readonly snapshotEvery: number;
  /** `readPixels` 浮点不可用时的兜底：关掉快照，回退「从第 0 帧重放」。 */
  private snapshotsEnabled = true;
  private side = 0;
  private frame = 0;
  private aux: ReadonlyMap<string, AlgoAuxTexture> | undefined;
  private frameCtx: AlgoUniformCtx | undefined;
  private cfg: ParticleConfig;
  private readonly stateValues: Record<string, number | string>;
  private readonly seedNorm: number;
  private readonly hooks: ParticleHooks;
  private disposed = false;

  constructor(
    private readonly kit: Kit,
    options: ParticleEngineOptions,
  ) {
    const { cfg, values, seed, id, shaders, hooks } = options;
    const src: ParticleShaders = { ...DEFAULT_PARTICLE_SHADERS, ...shaders };
    this.cfg = cfg;
    this.stateValues = values;
    this.hooks = hooks ?? {};
    this.gl = kit.gl;
    this.texW = cfg.texW;
    this.texH = cfg.texH;
    this.count = cfg.count;
    this.stepsPerSec = cfg.stepsPerSec;
    this.seedNorm = (seed >>> 0) / 4294967296;
    this.snapshotEvery = cfg.capacity.snapshotEvery;

    // 先切 scratch 单元：建纹理会 bindTexture（见 runtime.ts 的 GL 状态事故注释）。
    const scratch = this.scratchUnit();
    this.gl.activeTexture(this.gl.TEXTURE0 + scratch);
    const opts = { nearest: true, float32: true } as const;
    this.pos = [kit.target(this.texW, this.texH, opts), kit.target(this.texW, this.texH, opts)];
    this.vel = [kit.target(this.texW, this.texH, opts), kit.target(this.texW, this.texH, opts)];

    // 32F 拿不到就整体退到 RGBA8 + 坐标编码。刻意**不**退 16F：16F 渲染目标
    // 同样依赖 EXT_color_buffer_float，而它的 readPixels type 在驱动间不一致，
    // 会让快照在少数机器上静默读到错字节。
    this.precision = this.pos[0].float32 ? '32f' : '8';
    this.encode = this.precision === '8' ? 1 : 0;
    this.degraded = this.precision === '8' || cfg.capacity.degraded;
    this.degradeReason = this.precision === '8'
      ? 'floatTargetsUnavailable'
      : cfg.capacity.degraded ? 'particleBudget' : '';
    warnOnce(this.degradeReason);

    const p = (n: ParticleProgramPart) => particleProgramName(id, n);
    this.initProg = kit.quad(src.init, p('init'));
    this.stepPosProg = kit.quad(src.stepPos, p('step-pos'));
    this.stepVelProg = kit.quad(src.stepVel, p('step-vel'));
    // 点精灵用自定义 vertex shader（gl_VertexID → 状态纹理 texelFetch）。
    this.pointProg = kit.quad(src.pointFrag, p('points'), src.pointVert);

    this.stateBytes = 4 * this.texW * this.texH * this.pos[0].bytesPerPixel;

    this.initialize();
    const initial = this.readSnapshot();
    this.ring = new SnapshotRing<StateSnapshot>(
      { every: this.snapshotEvery, cap: cfg.capacity.snapshotCap, clone: cloneSnapshot },
      initial,
    );
  }

  private scratchUnit(): number {
    const n = this.gl.getParameter(this.gl.MAX_COMBINED_TEXTURE_IMAGE_UNITS) as number;
    return Math.max(0, (n || 16) - 1);
  }

  /** 第 0 帧：两张状态纹理各画一次 init pass。 */
  private initialize(): void {
    for (let i = 0; i < 2; i++) {
      const side = i;
      this.bindStateUniforms(this.initProg.use(), 0);
      this.initProg.u1i('u_initVel', 0);
      this.kit.pass(this.initProg, this.pos[side]);
      this.bindStateUniforms(this.initProg.use(), 0);
      this.initProg.u1i('u_initVel', 1);
      this.kit.pass(this.initProg, this.vel[side]);
    }
    this.side = 0;
    this.frame = 0;
  }

  /** step / init 共用的一批 uniform。返回值仅为链式调用方便。 */
  private bindStateUniforms(prog: ReturnType<Kit['quad']>, step: number): ReturnType<Kit['quad']> {
    const c = this.cfg;
    prog
      .u('u_seed', this.seedNorm)
      .u('u_step', step)
      .u('u_dt', c.dt)
      .u('u_encode', this.encode)
      .u1i('u_texW', this.texW)
      .u1i('u_texH', this.texH)
      .u1i('u_shape', c.shape)
      .u('u_emitterSize', c.emitterSize)
      .u('u_lifeSteps', c.lifeSteps)
      .u('u_lifeVar', c.lifeVar)
      .u('u_speed', c.speed)
      .u('u_speedVar', c.speedVar)
      .u('u_spread', c.spread)
      .u('u_direction', c.direction)
      .u('u_gravity', [c.gravityX, c.gravityY, c.gravityZ])
      .u('u_drag', c.drag)
      .u('u_turbulence', c.turbulence)
      .u('u_turbScale', c.turbScale)
      .u('u_vortex', c.vortex)
      .u('u_attract', c.attract)
      .u1i('u_emitChannel', c.emitChannel)
      .u('u_emitThreshold', c.emitThreshold);
    // 素材没就绪 / 没解析到时**明确回退均匀发射**，绝不采未绑定的 sampler
    // （那会读到残留纹理，表现是「粒子莫名只在一小块出生」）。
    const mask = auxOf(this.aux, 'u_emitMask');
    prog.u1i('u_emitOn', mask ? c.emitOn : 0);
    if (mask) prog.tex('u_emitMask', mask.tex);
    return prog;
  }

  /** 一次固定步长：两次 pass 都读 src，写完才 swap。 */
  private stepOnce(step: number): void {
    const src = this.side;
    const dst = 1 - src;

    // pos pass：src.pos / src.vel → dst.pos
    this.bindStateUniforms(this.stepPosProg.use(), step);
    this.stepPosProg.tex('u_pos', this.pos[src].tex).tex('u_vel', this.vel[src].tex);
    this.applyHooks(this.stepPosProg, this.hooks.setStepUniforms);
    this.kit.pass(this.stepPosProg, this.pos[dst]);

    // vel pass：**仍然读 src**（不是刚写好的 dst.pos），与 pos pass 同一份输入
    this.bindStateUniforms(this.stepVelProg.use(), step);
    this.stepVelProg.tex('u_pos', this.pos[src].tex).tex('u_vel', this.vel[src].tex);
    this.applyHooks(this.stepVelProg, this.hooks.setStepUniforms);
    this.kit.pass(this.stepVelProg, this.vel[dst]);

    this.side = dst;
  }

  private applyHooks(prog: Program, hook: ParticleHooks['setStepUniforms']): void {
    if (!hook || !this.frameCtx) return;
    hook(prog, this.stateValues, this.frameCtx);
  }

  private readSnapshot(): StateSnapshot {
    const ctor = this.pos[0].readType.ctor;
    const n = this.texW * this.texH * 4;
    const posArr = new ctor(n);
    const velArr = new ctor(n);
    this.pos[this.side].bind();
    this.pos[this.side].readState(posArr);
    this.vel[this.side].bind();
    this.vel[this.side].readState(velArr);
    // 浮点 FBO 的 readPixels 可能不被驱动接受；失败就关掉快照，退回纯重放。
    if (this.precision === '32f' && this.gl.getError() !== this.gl.NO_ERROR && this.snapshotsEnabled) {
      this.snapshotsEnabled = false;
      warnOnce('stateReadbackUnavailable');
    }
    return {
      pos: new Uint8Array(posArr.buffer, posArr.byteOffset, posArr.byteLength),
      vel: new Uint8Array(velArr.buffer, velArr.byteOffset, velArr.byteLength),
      side: this.side,
    };
  }

  private restore(s: StateSnapshot): void {
    const scratch = this.scratchUnit();
    this.gl.activeTexture(this.gl.TEXTURE0 + scratch);
    const ctor = this.pos[0].readType.ctor;
    const asView = (bytes: Uint8Array): ArrayBufferView => {
      // 先拷成一份独立 ArrayBuffer，再按原类型重解释（不能直接 slice，
      // 那样会把字节当成数字逐个转换，32F 状态就全毁了）。
      const copy = new Uint8Array(bytes.byteLength);
      copy.set(bytes);
      return new ctor(copy.buffer);
    };
    this.pos[s.side].uploadState(asView(s.pos));
    this.vel[s.side].uploadState(asView(s.vel));
    this.side = s.side;
  }

  /** 素材与上下文在 seek 之前注入；不在推进过程中读工程树。 */
  setAux(aux: ReadonlyMap<string, AlgoAuxTexture> | undefined, ctx: AlgoUniformCtx): void {
    this.aux = aux;
    this.frameCtx = ctx;
  }

  /**
   * 精确语义：等价于从 0 顺序推进 `simFrame` 步。
   * 回退时从 ≤ 目标的最近快照恢复（第 0 帧恒存），再顺序补步。
   */
  seek(simFrame: number): void {
    if (this.disposed) return;
    const target = Math.max(0, Math.floor(simFrame));
    if (target === this.frame) return;
    if (!this.snapshotsEnabled) {
      // readPixels 不可用：快照字节不可信，重新初始化再纯重放（慢但精确）。
      this.initialize();
    } else if (target < this.frame) {
      const snap = this.ring.nearestAtOrBefore(target);
      this.restore(snap.value);
      this.frame = snap.frame;
    }
    while (this.frame < target) {
      this.stepOnce(this.frame);
      this.frame++;
      if (this.snapshotsEnabled && this.ring.shouldStore(this.frame)) {
        this.ring.store(this.frame, this.readSnapshot());
      }
    }
  }

  /**
   * `Renderer.onSeek()` 之后的强制对齐：从 ≤ `frame` 的最近快照恢复，
   * 再顺序补回自称所在的那一帧。不移动目标帧 —— 拖动 / 追赶的预算语义
   * 一个字都不变（与 `SimHandle.seek(frame)` 的对齐同构）。
   */
  align(): void {
    if (this.disposed) return;
    const want = this.frame;
    if (this.snapshotsEnabled) {
      const snap = this.ring.nearestAtOrBefore(want);
      this.restore(snap.value);
      this.frame = snap.frame;
    } else {
      this.initialize();
    }
    while (this.frame < want) {
      this.stepOnce(this.frame);
      this.frame++;
    }
  }

  /** 用当前参数（含 volatile）画点精灵。状态推进不在这里发生。 */
  render(
    out: Target,
    values: Record<string, number | string>,
    ctx: AlgoUniformCtx,
    aux: ReadonlyMap<string, AlgoAuxTexture> | undefined,
  ): void {
    if (this.disposed) return;
    this.aux = aux;
    const c = normalizeParticleConfig(values);
    const gl = this.gl;

    // 清屏给底色：透明底清成全 0，纯色底清成 colorBg。
    out.bind();
    gl.disable(gl.BLEND);
    if (c.bgMode === 1) gl.clearColor(0, 0, 0, 0);
    else gl.clearColor(c.colorBg[0], c.colorBg[1], c.colorBg[2], 1);
    gl.clear(gl.COLOR_BUFFER_BIT);

    const sprite = auxOf(aux, 'u_sprite');
    const prog = this.pointProg.use();
    prog
      .u('u_resolution', [out.w, out.h])
      .u('u_encode', this.encode)
      .u1i('u_texW', this.texW)
      .u('u_pointSize', c.pointSize)
      .u('u_sizeVar', c.sizeVar)
      .u1i('u_dimension', c.dimension)
      .u('u_perspective', c.perspective)
      .u('u_camYaw', c.camYaw)
      .u('u_camPitch', c.camPitch)
      .u('u_camDist', c.camDist)
      .u('u_depthSize', c.depthSize)
      .u('u_colorStart', c.colorStart)
      .u('u_colorEnd', c.colorEnd)
      .u('u_opacity', c.opacity)
      .u1i('u_spriteOn', c.spriteOn && sprite ? 1 : 0)
      .u1i('u_spriteChannel', c.spriteChannel)
      .u('u_spriteRotate', c.spriteRotate)
      .tex('u_pos', this.pos[this.side].tex)
      .tex('u_vel', this.vel[this.side].tex);
    if (sprite) prog.tex('u_sprite', sprite.tex);
    else prog.u1i('u_spriteOn', 0);
    // 复用者的自定义 uniform 在所有 tex() 之后派发，避免与纹理单元编号打架。
    this.hooks.setRenderUniforms?.(prog, values, ctx);

    // 加色 / 普通 alpha。画完必须关掉 blend —— 合成链假设它是关的。
    gl.enable(gl.BLEND);
    if (c.blend === 0) gl.blendFunc(gl.SRC_ALPHA, gl.ONE);
    else gl.blendFuncSeparate(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA, gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    this.kit.passPoints(prog, out, this.count);
    gl.disable(gl.BLEND);
  }

  diagnostics(): ParticleDiagnostics {
    return {
      precision: this.precision,
      degraded: this.degraded,
      reason: this.degradeReason || (this.snapshotsEnabled ? '' : 'stateReadbackUnavailable'),
      count: this.count,
      maxParticles: this.cfg.capacity.maxParticles,
      simFrame: this.frame,
      snapshots: this.ring.size,
    };
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const t of [...this.pos, ...this.vel]) t.dispose();
  }
}
