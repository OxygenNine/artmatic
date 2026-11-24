/**
 * three/runtime.ts — three.js 片段运行时：Agent 写的动画 → 一张可以当源用的纹理。
 *
 * ## 它在这套架构里的位置
 *
 * 与 `engine/video-source.ts` 同形：**同步 resolve，这一帧拿不到就返回 null**。
 * 差别是它背后没有解码队列，而是一个**独立的 WebGL 上下文**（three 自己那台）。
 *
 * ## 为什么是第二个 WebGL 上下文，而不是复用 Artmatic 那台
 *
 * 复用要 `new WebGLRenderer({ canvas, context: kit.gl })`，而 three 会把 GL 状态
 * 缓存成自己的假设（绑定、blend、depth、viewport、program），`engine/` 那个
 * 极简的 Program/Target 抽象从不完整复位状态 —— 两边交替踩的结果是
 * **画面时好时坏而且没有任何报错**。独立上下文代价是一次跨上下文的
 * `texImage2D` 拷贝，换来的是「three 怎么折腾都碰不到主链」。
 *
 * ## 为什么是「一个渲染器 + 每个消费方一张纹理」
 *
 * 一帧里可能有三台合成器同时要图：主预览、闪回重渲（`render/recall.ts`）、
 * 预览缓存的离屏烘焙面（`render/bake-surface.ts`）。它们各自渲染**不同时刻**，
 * 共用一张纹理就是「闪回里出现主画面的内容」那类错。所以 `bind(consumer)`
 * 给每个消费方一份自己的 `SourceTexture`；渲染器与瞬间状态仍然是共用的
 * （同一时刻只渲一个，同步返回）。
 *
 * ## 性能与已知取舍
 *
 * - 渲染在**主线程**上同步做：一帧一次 three 渲染 + 一次 canvas→纹理上传。
 *   这是本功能唯一没有遵守「主线程只做 rAF 与 uniform 写入」的地方（见
 *   `docs/three-clips.md`）。真实的替代方案是把 three 塞进 Worker +
 *   OffscreenCanvas，但那会让 resolve 变成异步 —— 导出与闪回都要另建一条等待链。
 * - 同一 `(消费方, 片段, 帧, 尺寸)` 重复请求时**不重渲**：遮罩引用、转场两侧
 *   都会在同一帧里问两次。
 * - 首帧有一次性的上下文与着色器编译开销（几十毫秒），之后是每帧几毫秒。
 */

import type { Kit } from '../engine/kit';
import type { SourceTexture } from '../engine/compositor';
import type { SourceClip } from '../core/schema';
import { compileThreeCode, type ThreeApiContext } from './code';

/** 与 `SourceResolver` 同形：拿这一段在这一刻的画面，拿不到给 null。 */
export type ThreeResolver = (clip: SourceClip, t: number, frame: number) => SourceTexture | null;

/** 试跑结果。`checked:'syntax'` = 只编译过（没有渲染器 / three 载入失败）。 */
export interface ThreeProbe {
  ok: boolean;
  /** 失败原因（编译错误 / 运行期异常 / 缺 create）。`ok:true` 时为 null。 */
  error: string | null;
  checked: 'syntax' | 'render';
}

export interface ThreeRuntime {
  /**
   * 绑一个消费方（`'main'` / `'recall'` / `'bake'`）。返回的函数可以直接当
   * `SourceResolver` 用 —— 每个消费方拿到自己那张纹理，互不覆盖。
   */
  bind(consumer: string): ThreeResolver;
  /** 带渲染的试跑：编译 + 建场景 + 渲一帧（不上传纹理）。给写入回执用。 */
  probe(clip: SourceClip, w: number, h: number): Promise<ThreeProbe>;
  /** 片段被删 / 关工程时回收它的纹理与场景资源。 */
  forget(clipId: string): void;
  /** 丢掉整个上下文（换 canvas / 关工程）。 */
  dispose(): void;
}

interface Slot {
  tex: WebGLTexture;
  st: SourceTexture;
  frame: number;
  w: number;
  h: number;
}

interface Inst {
  code: string;
  scene: any;
  camera: any;
  ctrl: any;
  /** 编译 / create() 阶段就失败的原因。非空时这个片段不出图。 */
  err: string | null;
  slots: Map<string, Slot>;
  /** 尺寸变化时调一次（返回 resize 才调；否则只同步相机 aspect）。 */
  lastW: number;
  lastH: number;
}

type ThreeModule = typeof import('three');

/**
 * 用户场景的清理。**必须做**：模型不会替我们 dispose 几何体与材质，而每改一版
 * 代码就换一个新场景 —— 不回收的话「让 agent 改十遍」= 十份显存常驻。
 * 任何一步都不许抛（用户自定义对象上什么都可能有）。
 */
function disposeTree(root: any): void {
  const seen = new Set<unknown>();
  const disposeMaterial = (mat: any): void => {
    if (!mat || seen.has(mat)) return;
    seen.add(mat);
    try {
      for (const key of Object.keys(mat)) {
        const v = mat[key];
        if (v && typeof v === 'object' && v.isTexture === true) v.dispose?.();
      }
    } catch {
      /* 材质上的 getter 可能抛，忽略 */
    }
    try {
      mat.dispose?.();
    } catch {
      /* 同上 */
    }
  };
  try {
    root?.traverse?.((obj: any) => {
      try {
        obj.geometry?.dispose?.();
      } catch {
        /* ignore */
      }
      const m = obj.material;
      if (Array.isArray(m)) for (const one of m) disposeMaterial(one);
      else disposeMaterial(m);
    });
  } catch {
    /* 不是 Object3D（模型返回了别的东西）：没有可回收的 */
  }
}

function messageOf(err: unknown): string {
  if (err instanceof Error) return `${err.name}: ${err.message}`;
  return String(err);
}

export function createThreeRuntime(
  kit: Kit,
  opts: { onReady: () => void; getFps: () => number; getSeed: () => number },
): ThreeRuntime {
  /** three 模块（懒载入）。null = 还没载入完 / 载入失败。 */
  let mod: ThreeModule | null = null;
  let loading: Promise<ThreeModule | null> | null = null;
  let loadError: string | null = null;
  let renderer: any = null;
  let canvas: HTMLCanvasElement | null = null;
  const instances = new Map<string, Inst>();

  function ensureModule(): Promise<ThreeModule | null> {
    if (mod) return Promise.resolve(mod);
    if (loading) return loading;
    loading = import('three')
      .then((m) => {
        mod = m as ThreeModule;
        return mod;
      })
      .catch((err: unknown) => {
        // 载入失败只报一次，之后每帧直接走 null（不要每帧重试一个打包错误）。
        loadError = messageOf(err);
        return null;
      });
    return loading;
  }

  function ensureRenderer(m: ThreeModule): any {
    if (renderer) return renderer;
    canvas = document.createElement('canvas');
    canvas.width = 2;
    canvas.height = 2;
    renderer = new (m as any).WebGLRenderer({
      canvas,
      alpha: true,
      antialias: true,
      /*
       * `premultipliedAlpha: false` 是**必须**的：合成链的 blend 着色器按
       * **直通 alpha** 算（`mix(main, text, a)`，见 `engine/blend.frag.ts`）。
       * 让 three 输出预乘值会让半透明边缘比不透明区亮一圈 —— 画面看起来
       * 「有一层雾」，而任何单帧截图都说不清那是 bug。
       */
      premultipliedAlpha: false,
      powerPreference: 'high-performance',
      /*
       * `preserveDrawingBuffer` 保持默认（false）：上传发生在 `render()` 之后
       * 的**同一个任务**里，缓冲还没被合成器清掉；开它只是让驱动多拷一份。
       */
    });
    renderer.setPixelRatio(1);
    return renderer;
  }

  function dropInst(inst: Inst): void {
    try {
      inst.ctrl?.dispose?.();
    } catch {
      /* 用户代码 */
    }
    disposeTree(inst.scene);
    for (const slot of inst.slots.values()) kit.gl.deleteTexture(slot.tex);
    inst.slots.clear();
  }

  function build(clip: SourceClip, w: number, h: number): Inst {
    const code = clip.source.type === 'three' ? clip.source.code : '';
    const inst: Inst = {
      code,
      scene: null,
      camera: null,
      ctrl: null,
      err: null,
      slots: new Map(),
      /*
       * 从 0 起：`renderInst` 靠「和上一帧的尺寸不同」决定要不要 `setSize`。
       * 这里写成调用方给的 w / h 会让**第一次**渲染跳过 setSize —— 画布还是
       * 建上下文时的 2×2，渲出来是一张糊成一点的图，而 probe 照样报 ok。
       */
      lastW: 0,
      lastH: 0,
    };
    const compiled = compileThreeCode(code);
    if (!compiled.ok) {
      inst.err = compiled.error;
      return inst;
    }
    const ctx: ThreeApiContext = {
      width: w,
      height: h,
      fps: opts.getFps(),
      // 种子与时长是**片段级**的事实：用它们派生的随机 / 循环在导出里可复现
      // （代码自己调 Math.random() 的场合不在承诺范围内，见 docs/three-clips.md）。
      seed: opts.getSeed(),
      duration: Math.max(0, clip.end - clip.start),
      clipId: clip.id,
      renderer,
    };
    try {
      const ret = compiled.run(mod, ctx);
      if (!ret || typeof ret !== 'object') {
        inst.err = 'create(THREE, ctx) must return { scene, camera }';
        return inst;
      }
      const r = ret as { scene?: unknown; camera?: unknown; update?: unknown; resize?: unknown; dispose?: unknown };
      if (!r.scene || !r.camera) {
        inst.err = 'create(THREE, ctx) must return { scene, camera }';
        return inst;
      }
      if (r.update !== undefined && typeof r.update !== 'function') {
        inst.err = 'update must be a function';
        return inst;
      }
      inst.scene = r.scene;
      inst.camera = r.camera;
      inst.ctrl = r;
    } catch (err) {
      inst.err = messageOf(err);
    }
    return inst;
  }

  function instanceFor(clip: SourceClip, w: number, h: number): Inst {
    const code = clip.source.type === 'three' ? clip.source.code : '';
    let inst = instances.get(clip.id);
    if (inst && inst.code === code) return inst;
    // 代码变了：整份重建（旧场景回收）。尺寸变化不算换代码 —— 那走 resize。
    if (inst) dropInst(inst);
    inst = build(clip, w, h);
    instances.set(clip.id, inst);
    return inst;
  }

  /** 把渲染结果上传进某个消费方那张纹理（同一张纹理反复 texImage2D）。 */
  function upload(
    inst: Inst,
    consumer: string,
    src: HTMLCanvasElement,
    w: number,
    h: number,
    frame: number,
  ): SourceTexture {
    const gl = kit.gl;
    let slot = inst.slots.get(consumer);
    if (!slot) {
      const tex = gl.createTexture()!;
      gl.bindTexture(gl.TEXTURE_2D, tex);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      slot = { tex, st: { tex, w, h }, frame: NaN, w: 0, h: 0 };
      inst.slots.set(consumer, slot);
    }
    /*
     * 上传源是 canvas，翻转纪律与 `SourceManager.uploadImage` 逐字相同
     * （canvas 源受 `UNPACK_FLIP_Y_WEBGL` 控制，而 `ImageBitmap` 不受）。
     * 这里逐字复制那一段而不是调它 —— 那边每次新建纹理，而这里要复用。
     */
    gl.bindTexture(gl.TEXTURE_2D, slot.tex);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, src);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    slot.st = { tex: slot.tex, w, h };
    slot.frame = frame;
    slot.w = w;
    slot.h = h;
    return slot.st;
  }

  function renderInst(inst: Inst, localSec: number, localFrame: number, w: number, h: number): void {
    const r = renderer;
    if (!r) return;
    if (inst.lastW !== w || inst.lastH !== h) {
      r.setSize(w, h, false);
      inst.lastW = w;
      inst.lastH = h;
      const cam = inst.camera;
      if (typeof inst.ctrl?.resize === 'function') inst.ctrl.resize(w, h);
      else if (cam && typeof cam === 'object' && 'aspect' in cam && typeof cam.updateProjectionMatrix === 'function') {
        cam.aspect = w / h;
        cam.updateProjectionMatrix();
      }
    }
    inst.ctrl?.update?.(localSec, localFrame);
    r.render(inst.scene, inst.camera);
  }

  function bind(consumer: string): ThreeResolver {
    return (clip, t, frame) => {
      if (clip.source.type !== 'three') return null;
      const w = kit.w;
      const h = kit.h;
      if (!(w > 0 && h > 0)) return null;

      const m = mod;
      if (!m) {
        if (!loadError) void ensureModule().then((loaded) => { if (loaded) opts.onReady(); });
        return null;
      }
      if (!ensureRenderer(m)) return null;
      const cnv = canvas;
      if (!cnv) return null;

      const inst = instanceFor(clip, w, h);
      /*
       * 只有**建场景阶段**的失败才 latch（`ctrl` 没建起来，重跑也是同一个错）。
       * `update()` 抛异常不 latch：它可能只在某一帧写错，seek 回去还得出图 ——
       * 一次性写错却整段黑掉，比崩一下难查得多。
       */
      if (inst.err && !inst.ctrl) return null;

      const fps = opts.getFps() > 0 ? opts.getFps() : 30;
      const localSec = Math.max(0, t - clip.start);
      const localFrame = Math.max(0, Math.round(localSec * fps));

      const slot = inst.slots.get(consumer);
      if (slot && slot.frame === localFrame && slot.w === w && slot.h === h) return slot.st;

      try {
        renderInst(inst, localSec, localFrame, w, h);
      } catch (err) {
        // 运行期异常不 latch：模型可能只在某一帧写错，seek 回去还要能出图。
        inst.err = messageOf(err);
        return null;
      }
      inst.err = null;
      return upload(inst, consumer, cnv, w, h, localFrame);
    };
  }

  return {
    bind,
    async probe(clip, w, h) {
      if (clip.source.type !== 'three') return { ok: false, error: 'not a three clip', checked: 'syntax' };
      const compiled = compileThreeCode(clip.source.code);
      if (!compiled.ok) return { ok: false, error: compiled.error, checked: 'syntax' };
      const m = await ensureModule();
      if (!m) {
        return { ok: false, error: loadError ?? 'three.js is not available', checked: 'syntax' };
      }
      ensureRenderer(m);
      // 试跑必须用**真尺寸**：相机 aspect 与场景布局都依赖它，而这里正是
      // 「比例写错」唯一能被抓到的时机（写出 1:1 拉伸的场面在预览里才看得见）。
      const pw = w > 0 ? w : 960;
      const ph = h > 0 ? h : 540;
      const inst = instanceFor(clip, pw, ph);
      if (inst.err) return { ok: false, error: inst.err, checked: 'render' };
      try {
        renderInst(inst, 0, 0, pw, ph);
      } catch (err) {
        inst.err = messageOf(err);
        return { ok: false, error: inst.err, checked: 'render' };
      }
      return { ok: true, error: null, checked: 'render' };
    },
    forget(clipId) {
      const inst = instances.get(clipId);
      if (!inst) return;
      dropInst(inst);
      instances.delete(clipId);
    },
    dispose() {
      for (const inst of instances.values()) dropInst(inst);
      instances.clear();
      renderer?.dispose?.();
      renderer = null;
      canvas = null;
    },
  };
}
