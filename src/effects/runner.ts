/**
 * runner.ts — 特效执行器：把 EffectInstance 跑在 ping-pong 链上。
 *
 * 参数求值：基值在 inst.values，曲线在 EffectClip.curves 里以
 * `${instanceId}.${paramKey}` 为键——求值在这里统一做，
 * setUniforms 只收求值好的标量。
 *
 * 反馈类特效（feedback:true，如 echo）：主 pass 读 fb.read 写 fb.write，
 * commit 换手后再把 fb.write 拷到链上——每个特效实例一对历史目标，
 * seek 时由 Renderer.clearFeedback() 清空。`hdrFeedback` 时这对历史是
 * 浮点的（8bit 会把逐帧低于量化步长的增量抹平）。
 *
 * pre-pass（`shader.prePasses`）：主 pass 之前的一串全屏 pass，链式相接；
 * 第一环读本特效的输入，最后一环的输出就是主 pass 的 `u_texture`。
 * 非 feedback 的 pre-pass 渲染在半分辨率浮点草稿上，但 `u_resolution` 仍传
 * 全分辨率——降采样只改 tap 密度、不改模糊半径。带 feedback 的 pre-pass
 * 用**自己的**全分辨率浮点历史（`${instanceId}:${index}`）。
 *
 * `u_original` 恒为「本特效拿到的链输入」，即 pre-pass 之前的那一份 ——
 * glow / ghosting / fast-mosh / motion-mask 靠它拿回未处理的源。
 */

import { evalCurve } from '../core/curve';
import { seedFor } from '../engine/clock';
import type { Kit, Program, Target } from '../engine/kit';
import type { EffectRunner } from '../engine/compositor';
import { EFFECT_HEAD, effectProgramName, type EffectUniformCtx } from './shader-def';
import { getEffect } from './registry';

const PASSTHROUGH = `#version 300 es
precision highp float;
uniform sampler2D u_texture;
in vec2 vUv;
out vec4 outColor;
void main() { outColor = texture(u_texture, vUv); }`;

/**
 * 临时把一张贴图切成 LINEAR 采样，返回还原函数。
 *
 * 为什么敢改别人拥有的贴图：GL 的采样参数在 **draw 调用那一刻**被捕获，
 * 命令按序执行，所以「设 LINEAR → draw → 还原」在单线程里是安全的。
 * 只在协议声明了 `linearFilter` 时才做——smooth warps 没有它会有明显锯齿。
 */
function forceLinear(gl: WebGL2RenderingContext, tex: WebGLTexture): () => void {
  gl.bindTexture(gl.TEXTURE_2D, tex);
  const min = gl.getTexParameter(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER) as number;
  const mag = gl.getTexParameter(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER) as number;
  if (min === gl.LINEAR && mag === gl.LINEAR) return () => {};
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  return () => {
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, min);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, mag);
  };
}

export function createEffectRunner(kit: Kit, projectSeed: () => number): EffectRunner {
  const passProg = kit.quad(PASSTHROUGH, 'fx-passthrough');
  const programs = new Map<string, Program>();

  const programFor = (name: string, fragment: string): Program => {
    let p = programs.get(name);
    if (!p) {
      p = kit.quad(EFFECT_HEAD + fragment, name);
      programs.set(name, p);
    }
    return p;
  };

  return (inst, src, dst, ctx) => {
    const entry = getEffect(inst.defId);
    if (!entry) {
      // 未知特效：原样传递（工程向前兼容——新版本加的特效旧版不该毁图）
      passProg.use();
      passProg.tex('u_texture', src.tex);
      kit.pass(passProg, dst);
      return;
    }

    // 求值参数：曲线键 `${instanceId}.${key}`，clipStart/grid 上下文都在 ctx
    const values: Record<string, number | string> = {};
    for (const p of entry.params) {
      const curve = ctx.clip.curves[`${inst.instanceId}.${p.key}`];
      if (curve && p.type === 'range') {
        values[p.key] = evalCurve(curve, ctx.t, { grid: ctx.grid, clipStart: ctx.clip.start });
      } else {
        values[p.key] = inst.values[p.key] ?? p.defaultValue;
      }
    }

    /*
     * **保留键也要带上**：`values` 过去只收 `entry.params` 里声明过的键，于是
     * 「不是参数、但是实例数据」的那些（`curve#master`、`lutAssetId`）根本进不来，
     * 而 `curveTable` / `lut` 钩子正是读它们的 —— 症状是「拖了曲线，画面不动」，
     * 且不报错。这里把实例上没有声明成参数的键一并带上：`setUniforms` 只读
     * 自己那几张，多余的键对它无害。
     */
    for (const [k, v] of Object.entries(inst.values)) {
      if (!(k in values)) values[k] = v;
    }

    const shader = entry.shader;
    const seed = seedFor(projectSeed(), inst.instanceId, ctx.frame) / 4294967296;
    const gl = kit.gl;
    /** 只读快照：setUniforms 拿到的是带 t/frame/seed/... 的 ctx。 */
    const uniformCtx: EffectUniformCtx = {
      t: ctx.t,
      frame: ctx.frame,
      seed,
      w: ctx.w,
      h: ctx.h,
      fps: ctx.fps,
      grid: ctx.grid,
      clip: ctx.clip,
    };
    /** 名义帧间隔（秒）。反馈类特效按它缩放逐帧增量。 */
    const delta = ctx.fps > 0 ? 1 / ctx.fps : 0;

    // u_original 是「本特效拿到的链输入」，在 pre-pass 之前 —— 先钉住。
    const originalTex = src.tex;
    let inputTex = src.tex;

    /*
     * 外部蒙版：**必须在任何 prog.use() 之前**求值。
     *
     * `maskTexture` 会切 FBO / program / 纹理单元去渲被引用片段的那一层（以及
     * 那一层自己的绑定链），插在纹理绑定之后就会把 `u_texture` 顶掉 —— 与
     * `effects/AGENTS.md` 记过两次的那类事故同源。没接引用时绑 1×1 全白 +
     * `u_maskOn = 0`，数值上与「没有蒙版」一致。
     */
    const maskTarget = shader.mask ? ctx.compositor.maskTexture(inst, ctx) : null;
    const maskTex = maskTarget
      ? maskTarget.tex
      : shader.mask
        ? ctx.compositor.whiteMask()
        : null;
    const maskOn = maskTarget ? 1 : 0;

    /* ------------------------------------------------ pre-passes */
    const prePasses = shader.prePasses;
    let delayedTarget: Target | null = null;
    if (prePasses && prePasses.length > 0) {
      const scratch = ctx.compositor.preScratchFor(ctx.w, ctx.h);
      let slot = 0;
      for (let i = 0; i < prePasses.length; i++) {
        const pp = prePasses[i]!;
        const prog = programFor(effectProgramName(inst.defId, i), pp.fragment);

        let out: Target;
        let fbRead: Target | null = null;
        let fbKey = '';
        if (pp.feedback) {
          fbKey = `${inst.instanceId}:${i}`;
          const fb = ctx.compositor.preFeedbackFor(fbKey, ctx.w, ctx.h);
          fbRead = fb.read;
          out = fb.write;
        } else {
          out = slot === 0 ? scratch.a : scratch.b;
          slot = 1 - slot;
        }

        /*
         * 这一环的输入：默认是**上一环的输出**（链）。
         * 声明了 `delayedInput` 就换成**上一帧的链输入** —— 有些原作要拿
         * 「上一帧的输入」做帧间差分/运动估计，而链里拿不到它（见 shader-def 的说明）。
         */
        let passInput = inputTex;
        if (pp.delayedInput) {
          delayedTarget = ctx.compositor.delayedInputFor(inst.instanceId, ctx.w, ctx.h);
          passInput = delayedTarget.tex;
        }

        const restore = pp.linearFilter ? forceLinear(gl, passInput) : null;
        prog.use();
        prog.tex('u_texture', passInput).tex('u_original', originalTex);
        if (fbRead) prog.tex('u_feedback', fbRead.tex);
        // 蒙版也要在每个 pass 上绑：pre-pass 里用它是合法的（与参数同理）。
        if (maskTex) prog.tex('u_mask', maskTex).u('u_maskOn', maskOn);
        prog
          .u('u_time', ctx.t)
          .u('u_delta', delta)
          .u('u_seed', seed)
          .u('u_resolution', [ctx.w, ctx.h]);
        // **pre-pass 也要派发特效参数。** 上游的 `drawPass` 对每个 pass 都传
        // `def` 与 `values`，所以它的 pre-pass fragment 里是可以直接用特效参数的
        // （glow 的 u_cutoff/u_radius、blur 的 u_radius、ghosting 的 u_bias/u_scale、
        // fast-mosh 的 u_hold、motion-mask 的 u_persistence/u_erode/u_blur 都是）。
        // 只派发 head uniform 的话这些参数恒为 0 —— 画面会明显不对，但不报错。
        shader.setUniforms(gl, prog.uniforms, values, uniformCtx);
        // 与参数一样，**每个 pass 都尝试绑频谱**：没声明 u_spectrum 的 program
        // 里 `bindTo` 直接返回，绝大多数特效走的就是这条路径。
        ctx.spectrum?.bindTo(prog, inst.instanceId, ctx.t, delta, values);
        // 字形图集同理：没声明 u_atlas 的 program 里 bindTo 直接返回。
        ctx.glyphs?.bindTo(prog, shader.glyphs ? shader.glyphs(values) : null);
        // 调色曲线表同理：没声明 u_curve 的 program 里 bindTo 直接返回。
        ctx.curves?.bindTo(prog, shader.curveTable ? shader.curveTable(values) : null);
        // LUT 同理（`sampler3D`）：声明了 u_lut 才绑。
        ctx.luts?.bindTo(prog, shader.lut ? shader.lut(values) : null);
        kit.pass(prog, out);
        if (restore) restore();

        if (pp.feedback) ctx.compositor.preFeedbackCommit(fbKey);
        inputTex = out.tex;
      }
    }

    /* --------------------------------------------------- 主 pass */
    const prog = programFor(effectProgramName(inst.defId), shader.fragment);
    const fb = shader.feedback
      ? ctx.compositor.feedbackFor(inst.instanceId, ctx.w, ctx.h, shader.hdrFeedback ?? false)
      : null;

    /*
     * 追踪叠层（`u_overlay`）的准备工作：探针渲染、回读、检测、绘叠层、上传。
     *
     * **必须在 `prog.use()` 之前**：它要切 program / FBO / 激活纹理单元，
     * 插在纹理绑定之后会把这些绑定顶掉（`effects/AGENTS.md` 记过两次真实事故）。
     * 服务内部对「program 没声明 u_overlay」直接返回，所以绝大多数特效零开销。
     */
    ctx.tracker?.prepare(prog, inst, inputTex, values, {
      t: ctx.t,
      frame: ctx.frame,
      fps: ctx.fps,
      w: ctx.w,
      h: ctx.h,
      seed,
    });

    const restore = shader.linearFilter ? forceLinear(gl, inputTex) : null;
    prog.use();
    prog
      .tex('u_texture', inputTex)
      .tex('u_original', originalTex)
      .u('u_time', ctx.t)
      .u('u_delta', delta)
      .u('u_seed', seed)
      .u('u_resolution', [ctx.w, ctx.h]);
    ctx.tracker?.bind(prog, inst);
    if (fb) prog.tex('u_feedback', fb.read.tex);
    // `u_maskOn` 声明成 float，必须走 `u()`（uniform1f）；用 u1i 会 INVALID_OPERATION 且不写。
    if (maskTex) prog.tex('u_mask', maskTex).u('u_maskOn', maskOn);
    shader.setUniforms(gl, prog.uniforms, values, uniformCtx);
    ctx.spectrum?.bindTo(prog, inst.instanceId, ctx.t, delta, values);
    // 字形图集（u_atlas / u_glyphCount / u_glyphCols）。没声明 u_atlas 的特效
    // 在 `bindTo` 里早退，所以这一行对所有其它特效是零开销。
    ctx.glyphs?.bindTo(prog, shader.glyphs ? shader.glyphs(values) : null);
    // 调色曲线表同理：没声明 u_curve 的 program 里 bindTo 直接返回。
    ctx.curves?.bindTo(prog, shader.curveTable ? shader.curveTable(values) : null);
    ctx.luts?.bindTo(prog, shader.lut ? shader.lut(values) : null);

    if (fb) {
      // 主 pass 写历史，换手，再把刚写的那份拷到链上。
      const writeTarget: Target = fb.write;
      kit.pass(prog, writeTarget);
      ctx.compositor.feedbackCommit(inst.instanceId);
      passProg.use();
      passProg.tex('u_texture', writeTarget.tex);
      kit.pass(passProg, dst);
    } else {
      kit.pass(prog, dst);
    }
    if (restore) restore();

    /*
     * 延迟输入：把**本帧的链输入**存下来，供下一帧的 `delayedInput` pre-pass 读。
     *
     * 必须放在链跑完之后：这一帧读到的是上一帧存进去的值，两帧不能写坏。
     * 只在真的有人声明了才做（绝大多数特效没有这一环，零开销）。
     */
    if (delayedTarget) {
      passProg.use();
      passProg.tex('u_texture', originalTex);
      kit.pass(passProg, delayedTarget);
    }
  };
}
