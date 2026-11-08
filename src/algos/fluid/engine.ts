/**
 * engine.ts — `FluidEngine`：流体状态纹理的生命周期与确定性推进。
 *
 * 八张 RGBA16F：
 *   velocity ×2（ping-pong）· dye ×2 · pressure ×2（Jacobi ping-pong）
 *   · divergence ×1 · curl ×1
 *
 * ## 为什么不用 `SimHandle`
 *
 * 状态**全程在显存**：每步要跑 20 来个 pass，回读 CPU 再上传会把成本
 * 翻十倍，而 `SimHandle.current()` 的 8 位量化字节根本装不下速度场。
 * 这与粒子是同一个理由（见 `types.ts::GpuSimHandle`）。
 *
 * ## 确定性（硬约束 1.3）
 *
 * 1. 每个 pass 都读「上一次的纹理」、写另一侧，写完才 swap ⇒ 与执行顺序无关；
 * 2. 喷嘴位置是 `(i, 步号)` 的**闭式函数**（`config.jetAt`），不看墙钟、不看 t；
 * 3. 快照存 16F 的**原始字节**，恢复时按同一 type 上传 ⇒ 逐位相同；
 * 4. `readPixels` 是同步 stall，所以只在快照点读，绝不逐帧全量读。
 *
 * ## 降级
 *
 * `Target` 在缺 `EXT_color_buffer_float` 时静默回落 RGBA8 —— 而 RGBA8 装不下
 * 负的速度分量（clamp 到 0 之后整幅只会朝一个角流）。所以这里**显式检测**：
 * 拿不到 16F 就不推进模拟、`render` 只画底色，并在 `diagnostics()` 里报原因。
 * 让一台跑不动的机器画出「看起来像坏了」的画面，比明确说「这台机器不行」更糟。
 */

import { hashSeed, mulberry32 } from '../../core/prng';
import type { Kit, Program, Target } from '../../engine/kit';
import { SnapshotRing } from '../sim-util';
import type { AlgoAuxTexture, AlgoUniformCtx } from '../shader-lib';
import type { GpuSimHandle } from '../types';
import {
  dissipationPerStep,
  jetAt,
  jetHue,
  normalizeFluidConfig,
  type FluidConfig,
} from './config';
import { FLUID_SHADERS, fluidProgramName, type FluidProgramPart } from './glsl';

/**
 * 一次快照 = 两张状态纹理的 **float32 读回** + 当时用到的 ping-pong 面。
 *
 * ⚠️ 读回**必须用 `FLOAT`**，不能用 `HALF_FLOAT`：RGBA16F 帧缓冲的
 * `IMPLEMENTATION_COLOR_READ_TYPE` 是 `FLOAT`，用 HALF_FLOAT 时 `readPixels`
 * 静默失败（返回全 0），而快照看起来「存了」—— 实测形态是
 * 「t=3 → t=1.5 → t=3 两次画面不同」，其它一切正常。
 * half → float32 → half 是**精确往返**，所以存 float32 不引入任何误差。
 */
interface StateSnapshot {
  vel: Float32Array;
  dye: Float32Array;
  velSide: number;
  dyeSide: number;
}

const cloneSnapshot = (s: StateSnapshot): StateSnapshot => ({
  vel: new Float32Array(s.vel),
  dye: new Float32Array(s.dye),
  velSide: s.velSide,
  dyeSide: s.dyeSide,
});

export interface FluidDiagnostics {
  /** 拿到的状态精度。`8` 表示这台机器跑不了流体（见文件头）。 */
  precision: '16f' | '8';
  degraded: boolean;
  reason: string;
  texW: number;
  texH: number;
  simFrame: number;
  snapshots: number;
}

/** 一个喷嘴在**这一步**的完整描述（JS 侧算好，shader 只做加法）。 */
interface JetSpec {
  x: number;
  y: number;
  hue: number;
  /** 染料量（已乘 `inject`）。 */
  dye: number;
  /** 速度增量（texel/秒）。 */
  vx: number;
  vy: number;
}

const MAX_JETS = 4;

export interface FluidEngineOptions {
  values: Record<string, number | string>;
  seed: number;
  /** 生成器 id。**program 名按它区分** —— 名字相同会复用上一份 program。 */
  id: string;
}

let lastWarn = '';
function warnOnce(reason: string): void {
  if (reason === lastWarn) return;
  lastWarn = reason;
  if (reason) console.warn(`[fluid] ${reason}`);
}

export class FluidEngine implements GpuSimHandle {
  readonly texW: number;
  readonly texH: number;
  readonly count: number;
  readonly stepsPerSec: number;
  readonly stateBytes: number;
  readonly precision: '16f' | '8';

  private readonly gl: WebGL2RenderingContext;
  private readonly vel: [Target, Target];
  private readonly dye: [Target, Target];
  private readonly pressure: [Target, Target];
  private readonly divergence: Target;
  private readonly curl: Target;
  /** mask 缺席时的占位（1×1 白）。**必须存在**：sampler 指向未绑定单元时
   *  会读到上一个 pass 留下的纹理，而那条路径不报错。 */
  private readonly white: Target;
  private readonly ring: SnapshotRing<StateSnapshot>;
  private readonly progs = new Map<FluidProgramPart, Program>();
  private readonly cfg: FluidConfig;
  private readonly id: string;
  private readonly seedNorm: number;
  private velSide = 0;
  private dyeSide = 0;
  private frame = 0;
  private aux: ReadonlyMap<string, AlgoAuxTexture> | undefined;
  private snapshotsEnabled = true;
  /** `fence()` 的读回缓冲（复用，避免每帧分配）。 */
  private readonly probeTexel = new Float32Array(4);
  private disposed = false;

  constructor(
    private readonly kit: Kit,
    options: FluidEngineOptions,
  ) {
    const { values, seed, id } = options;
    this.cfg = normalizeFluidConfig(values);
    this.id = id;
    this.gl = kit.gl;
    this.texW = this.cfg.texW;
    this.texH = this.cfg.texH;
    this.count = this.texW * this.texH;
    this.stepsPerSec = this.cfg.stepsPerSec;
    this.seedNorm = (seed >>> 0) / 4294967296;

    // 建纹理前先切 scratch 单元（见 runtime.ts 的 GL 状态事故注释）。
    const scratch = this.scratchUnit();
    this.gl.activeTexture(this.gl.TEXTURE0 + scratch);
    // 只要 16F + LINEAR：32F 会被 `Target` 强制 NEAREST，advection 需要插值。
    const opts = { float: true } as const;
    this.vel = [kit.target(this.texW, this.texH, opts), kit.target(this.texW, this.texH, opts)];
    this.dye = [kit.target(this.texW, this.texH, opts), kit.target(this.texW, this.texH, opts)];
    this.pressure = [kit.target(this.texW, this.texH, opts), kit.target(this.texW, this.texH, opts)];
    this.divergence = kit.target(this.texW, this.texH, opts);
    this.curl = kit.target(this.texW, this.texH, opts);
    this.white = kit.target(1, 1, { nearest: true });

    this.precision = this.vel[0].float ? '16f' : '8';
    warnOnce(this.precision === '8' ? 'floatTargetsUnavailable' : '');

    // 常驻的是 8 张同尺寸纹理（velocity / dye / pressure 各两 + divergence + curl）。
    this.stateBytes = this.vel[0].bytesPerPixel * this.texW * this.texH * 8;

    this.initialize();
    const initial = this.readSnapshot();
    this.ring = new SnapshotRing<StateSnapshot>(
      { every: this.cfg.capacity.snapshotEvery, cap: this.cfg.capacity.snapshotCap, clone: cloneSnapshot },
      initial,
    );
  }

  private scratchUnit(): number {
    const n = this.gl.getParameter(this.gl.MAX_COMBINED_TEXTURE_IMAGE_UNITS) as number;
    return Math.max(0, (n || 16) - 1);
  }

  private prog(part: FluidProgramPart): Program {
    let p = this.progs.get(part);
    if (!p) {
      p = this.kit.quad(FLUID_SHADERS[part], fluidProgramName(this.id, part));
      this.progs.set(part, p);
    }
    return p;
  }

  private clearTarget(t: Target, r = 0, g = 0, b = 0, a = 0): void {
    const gl = this.gl;
    t.bind();
    gl.clearColor(r, g, b, a);
    gl.clear(gl.COLOR_BUFFER_BIT);
  }

  /** 第 0 帧：清空全部状态，再撒一批种子墨点（否则第 0 帧是一张纯底色）。 */
  private initialize(): void {
    this.velSide = 0;
    this.dyeSide = 0;
    this.frame = 0;
    for (const t of [...this.vel, ...this.dye, ...this.pressure]) this.clearTarget(t);
    this.clearTarget(this.divergence);
    this.clearTarget(this.curl);
    this.clearTarget(this.white, 1, 1, 1, 1);
    if (this.precision === '8') return;

    // 种子墨点：8 个随机位置 + 随机方向初速。随机源是种子，所以每次重建
    // （含 seek 从 0 重放）都得到同一组 → 硬约束 1.2。
    const rng = mulberry32(hashSeed(this.seedNorm, 'fluid-seed', this.texW));
    const jets: JetSpec[] = [];
    for (let i = 0; i < 8; i++) {
      const dir = rng() * Math.PI * 2;
      jets.push({
        x: 0.2 + rng() * 0.6,
        y: 0.2 + rng() * 0.6,
        hue: rng(),
        dye: this.cfg.inject * 1.6,
        vx: Math.cos(dir) * this.cfg.force * this.texH * 0.6,
        vy: Math.sin(dir) * this.cfg.force * this.texH * 0.6,
      });
    }
    // 每步最多 4 个喷嘴，所以分两批注入。
    this.splatBatch(jets.slice(0, MAX_JETS));
    this.splatBatch(jets.slice(MAX_JETS));
  }

  /** 一批注入（速度 + 染料各一个 pass，各换一次 ping-pong 面）。 */
  private splatBatch(jets: readonly JetSpec[]): void {
    if (jets.length === 0) return;
    const pv = this.prog('splat-velocity').use();
    this.bindJetUniforms(pv, jets);
    pv.tex('u_tex', this.vel[this.velSide].tex);
    this.bindMask(pv);
    this.kit.pass(pv, this.vel[1 - this.velSide]);
    this.velSide = 1 - this.velSide;

    const pd = this.prog('splat-dye').use();
    this.bindJetUniforms(pd, jets);
    pd.u('u_jetSaturation', this.cfg.saturation).u('u_jetBrightness', this.cfg.brightness);
    pd.tex('u_tex', this.dye[this.dyeSide].tex);
    this.bindMask(pd);
    this.kit.pass(pd, this.dye[1 - this.dyeSide]);
    this.dyeSide = 1 - this.dyeSide;
  }

  /**
   * 四个具名槽的 uniform 派发。超出的槽位**填 0**（位置无关、量为 0）——
   * 留上次的值会让第 3 个槽在 `nozzles` 减到 2 之后继续喷。
   */
  private bindJetUniforms(prog: Program, jets: readonly JetSpec[]): void {
    const names = ['0', '1', '2', '3'] as const;
    for (let i = 0; i < MAX_JETS; i++) {
      const j = jets[i];
      prog.u(`u_jetP${names[i]}`, j ? [j.x, j.y, j.hue, j.dye] : [0, 0, 0, 0]);
      prog.u(`u_jetV${names[i]}`, j ? [j.vx, j.vy, 0, 0] : [0, 0, 0, 0]);
    }
    prog
      .u1i('u_jetCount', Math.min(MAX_JETS, jets.length))
      .u('u_jetRadius', this.cfg.radius)
      .u('u_domainAspect', this.cfg.domainAspect);
  }

  private bindMask(prog: Program): void {
    const mask = this.aux?.get('u_mask');
    if (mask && this.cfg.maskOn === 1) {
      prog.u1i('u_maskOn', 1)
        .u1i('u_maskChannel', this.cfg.maskChannel)
        .u('u_maskThreshold', this.cfg.maskThreshold)
        .tex('u_mask', mask.tex);
      return;
    }
    prog.u1i('u_maskOn', 0).tex('u_mask', this.white.tex);
  }

  /** 第 `step` 步要注入的那几个喷嘴（闭式，见 `config.jetAt`）。 */
  private jetsAt(step: number): JetSpec[] {
    const cfg = this.cfg;
    const out: JetSpec[] = [];
    const n = Math.max(1, cfg.nozzles);
    for (let i = 0; i < n && i < MAX_JETS; i++) {
      const j = jetAt(i, step, cfg);
      out.push({
        x: j.x,
        y: j.y,
        hue: jetHue(i, cfg),
        dye: cfg.inject,
        vx: j.dx * cfg.force * this.texH,
        vy: j.dy * cfg.force * this.texH,
      });
    }
    return out;
  }

  /** 通用模拟 pass：设公共 uniform、绑纹理、画到 `out`。 */
  private simPass(
    part: FluidProgramPart,
    out: Target,
    texes: Record<string, WebGLTexture>,
    extra?: (p: Program) => void,
  ): void {
    const prog = this.prog(part).use();
    prog.u('u_texelSize', [1 / this.texW, 1 / this.texH]).u('u_dt', this.cfg.dt);
    for (const [name, tex] of Object.entries(texes)) prog.tex(name, tex);
    extra?.(prog);
    this.kit.pass(prog, out);
  }

  /** 一次固定步长。**只读上一次的纹理**：每次 swap 都在本函数里成对出现。 */
  private stepOnce(step: number): void {
    const cfg = this.cfg;
    const vel = () => this.vel[this.velSide].tex;
    const dstVel = () => this.vel[1 - this.velSide];

    // 1. 涡量
    this.simPass('curl', this.curl, { u_velocity: vel() });

    // 2. 涡量约束（速度写入另一侧）
    this.simPass(
      'vorticity',
      dstVel(),
      { u_velocity: vel(), u_curl: this.curl.tex },
      (p) => p.u('u_curlStrength', cfg.curl),
    );
    this.velSide = 1 - this.velSide;

    // 3. 散度
    this.simPass('divergence', this.divergence, { u_velocity: vel() });

    // 4. 压力：每步从 0 起算（不留上一帧的记忆 ⇒ 快照不必存它）
    this.clearTarget(this.pressure[0]);
    let ps = 0;
    for (let i = 0; i < cfg.pressureIter; i++) {
      this.simPass('pressure', this.pressure[1 - ps], {
        u_pressure: this.pressure[ps].tex,
        u_divergence: this.divergence.tex,
      });
      ps = 1 - ps;
    }

    // 5. 减梯度 ⇒ 无散度
    this.simPass(
      'gradient',
      dstVel(),
      { u_velocity: vel(), u_pressure: this.pressure[ps].tex },
    );
    this.velSide = 1 - this.velSide;

    // 6. 速度自平流（先衰减再取回）
    const velDiss = dissipationPerStep(cfg.velDissipation, cfg.dt);
    this.simPass(
      'advect',
      dstVel(),
      { u_tex: vel(), u_velocity: vel() },
      (p) => p.u('u_dissipation', velDiss),
    );
    this.velSide = 1 - this.velSide;

    // 7. 染料平流（速度用**刚更新完**的那一侧）
    const dyeDiss = dissipationPerStep(cfg.dyeDissipation, cfg.dt);
    this.simPass(
      'advect',
      this.dye[1 - this.dyeSide],
      { u_tex: this.dye[this.dyeSide].tex, u_velocity: vel() },
      (p) => p.u('u_dissipation', dyeDiss),
    );
    this.dyeSide = 1 - this.dyeSide;

    // 8. 注入（力 + 染料）
    this.splatBatch(this.jetsAt(step));
  }

  /** 清掉残留的 GL 错误，好让 `readSnapshot` 的错误检测只反映这一次读回。 */
  private drainGlErrors(): void {
    const gl = this.gl;
    for (let i = 0; i < 8; i++) if (gl.getError() === gl.NO_ERROR) return;
  }

  private readSnapshot(): StateSnapshot {
    const gl = this.gl;
    const n = this.texW * this.texH * 4;
    const vel = new Float32Array(n);
    const dye = new Float32Array(n);
    this.drainGlErrors();
    this.vel[this.velSide].bind();
    gl.readPixels(0, 0, this.texW, this.texH, gl.RGBA, gl.FLOAT, vel);
    this.dye[this.dyeSide].bind();
    gl.readPixels(0, 0, this.texW, this.texH, gl.RGBA, gl.FLOAT, dye);
    if (this.precision === '16f' && gl.getError() !== gl.NO_ERROR && this.snapshotsEnabled) {
      // 读不回来就关掉快照：宁可每次从第 0 帧重放，也不能用一张不可信的状态。
      this.snapshotsEnabled = false;
      warnOnce('stateReadbackUnavailable');
    }
    return { vel, dye, velSide: this.velSide, dyeSide: this.dyeSide };
  }

  private restore(s: StateSnapshot): void {
    const gl = this.gl;
    gl.activeTexture(gl.TEXTURE0 + this.scratchUnit());
    const upload = (t: Target, data: Float32Array): void => {
      t.bindTexture();
      gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, this.texW, this.texH, gl.RGBA, gl.FLOAT, data);
    };
    upload(this.vel[s.velSide], s.vel);
    upload(this.dye[s.dyeSide], s.dye);
    this.velSide = s.velSide;
    this.dyeSide = s.dyeSide;
  }

  /** 素材在 seek 之前注入（step 要采蒙版决定注入量）。 */
  setAux(aux: ReadonlyMap<string, AlgoAuxTexture> | undefined, _ctx: AlgoUniformCtx): void {
    this.aux = aux;
  }

  /**
   * 显式栅栏：读回**一个 texel**。
   *
   * ⚠️ 它不是「保险起见加一下」，是这套 ping-pong 能逐字节复现的前提。
   * 实测（ANGLE / D3D11，2026-11）：
   *
   * | 收尾动作 | 同帧连渲两次 | 前进后回退 |
   * |---|---|---|
   * | 什么都不做 | 不一致 | 不一致 |
   * | `gl.flush()` | 不一致 | 不一致 |
   * | `gl.finish()` | 不一致 | 不一致 |
   * | 一次 `readPixels` | **一致** | **一致** |
   *
   * 差异量级约 1%（`dye` 总和 179146 vs 181144），不是随机噪声 —— 是某一步的
   * 采样读到了**上一版**的纹理。WebGL 规范允许 `finish()` 等价于 `flush()`
   * （「may return without waiting」），所以那两条收尾都不建立真正的先后；
   * 只有从 FBO 读回像素才强制 GPU 把这条链跑完。
   *
   * 代价是每帧一次同步 stall。它本来就在路径上：快照点每 16 步要读回整张纹理，
   * 1 个 texel 相对可忽略。
   */
  private fence(): void {
    if (this.precision === '8') return;
    this.dye[this.dyeSide].bind();
    this.gl.readPixels(0, 0, 1, 1, this.gl.RGBA, this.gl.FLOAT, this.probeTexel);
  }

  /** 精确语义：等价于从 0 顺序推进 `simFrame` 步。 */
  seek(simFrame: number): void {
    if (this.disposed) return;
    const target = Math.max(0, Math.floor(simFrame));
    if (target === this.frame) return;
    if (!this.snapshotsEnabled) {
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
    this.fence();
  }

  /** `Renderer.onSeek()` 之后的强制对齐（见 `GpuSimHandle.align`）。 */
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
    this.fence();
  }

  render(
    out: Target,
    values: Record<string, number | string>,
    _ctx: AlgoUniformCtx,
    aux: ReadonlyMap<string, AlgoAuxTexture> | undefined,
  ): void {
    if (this.disposed) return;
    this.aux = aux;
    const c = normalizeFluidConfig(values);
    const gl = this.gl;

    if (this.precision === '8') {
      // 这台机器跑不了流体：画底色而不是画一张「看起来坏了」的图。
      out.bind();
      if (c.bgMode === 1) gl.clearColor(0, 0, 0, 0);
      else gl.clearColor(c.colorBg[0], c.colorBg[1], c.colorBg[2], 1);
      gl.clear(gl.COLOR_BUFFER_BIT);
      return;
    }

    const prog = this.prog('display').use();
    prog
      .u('u_dyeTexel', [1 / this.texW, 1 / this.texH])
      .tex('u_dye', this.dye[this.dyeSide].tex)
      .u('u_domainAspect', c.domainAspect)
      .u('u_outAspect', out.h > 0 ? out.w / out.h : c.domainAspect)
      .u('u_shading', c.shading)
      .u('u_glow', c.glow)
      .u('u_hueShift', c.hueShift)
      .u('u_contrast', c.contrast)
      .u1i('u_bgMode', c.bgMode)
      .u('u_colorBg', c.colorBg);
    this.kit.pass(prog, out);
  }

  diagnostics(): FluidDiagnostics {
    return {
      precision: this.precision,
      degraded: this.precision === '8',
      reason: this.precision === '8'
        ? 'floatTargetsUnavailable'
        : this.snapshotsEnabled ? '' : 'stateReadbackUnavailable',
      texW: this.texW,
      texH: this.texH,
      simFrame: this.frame,
      snapshots: this.ring.size,
    };
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const t of [...this.vel, ...this.dye, ...this.pressure]) t.dispose();
    this.divergence.dispose();
    this.curl.dispose();
    this.white.dispose();
  }
}
