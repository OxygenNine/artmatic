/**
 * three/code.ts — three.js 片段代码的**契约、上限与编译**。纯函数，可单测。
 *
 * 这一层刻意不认识 WebGL、`engine/`、`three` 包本身：控制平面要拿它做写入前的
 * 语法检查（没有渲染器时也要能查），而渲染侧只在真正出图时才 `import('three')`。
 *
 * ## 为什么是「`create(THREE, ctx)` + 返回 scene/camera」
 *
 * 片段跑的是**模型写的代码**，所以契约必须窄到不可能写歪：
 *
 * - `THREE` 作为**参数**传进来，不让它写 import —— 项目里没有模块解析给这段代码用。
 * - 场景与相机由代码自己建、自己返回。渲染器、尺寸、时钟全由宿主管，
 *   模型只需要回答「这一帧画什么」。
 * - 唯一的动画入口是 `update(t, frame)`，`t` 是**片段内秒**。不给 delta、
 *   不给 Clock —— 给了 delta 就等于允许「累加式动画」，那种东西 seek 之后
 *   和正放不是同一幅画面。
 *
 * ## 语法检查是「编译不执行」
 *
 * `new Function` 只编译不运行（与 `plugin_check` 用 acorn 同一目的，只是这里
 * 不需要 AST）。运行期错误由 `runtime.ts` 的试跑负责抓。
 */

/**
 * 代码体积上限（字符数 ≈ UTF-16 码元）。
 *
 * 定在 16 KB 是为了**读回能装进一次工具结果**（`TOOL_TEXT_LIMIT` 是 20k）：
 * `get_scene` 会把代码原样带回来，超过工具结果上限就被截断 —— 而截断过的代码
 * 被模型原样写回去，就是一段半截的程序，且没有任何报错。16 KB 已经够写几百行。
 */
export const THREE_CODE_MAX_CHARS = 16 * 1024;

/** 传给 `create(THREE, ctx)` 的 ctx。字段只增不改 —— 模型的代码依赖它。 */
export interface ThreeApiContext {
  /** 渲染宽度（px）。预览 ≈960、导出 = 工程分辨率 —— 会变。 */
  width: number;
  /** 渲染高度（px）。 */
  height: number;
  fps: number;
  /** 工程种子。想要可复现的随机就从它派生（不给 `Math.random()` 的替代品）。 */
  seed: number;
  /** 片段时长（秒）。 */
  duration: number;
  clipId: string;
  /** three 的 `WebGLRenderer`。所有 three 片段共用一台，别改它的像素比 / renderTarget。 */
  renderer: unknown;
}

export interface ThreeCompileOk {
  ok: true;
  /** 调用即执行用户的 `create`。渲染侧与试跑都走它。 */
  run: (THREE: unknown, ctx: ThreeApiContext) => unknown;
}

export interface ThreeCompileErr {
  ok: false;
  error: string;
}

export type ThreeCompile = ThreeCompileOk | ThreeCompileErr;

function messageOf(err: unknown): string {
  if (err instanceof Error) return `${err.name}: ${err.message}`;
  return String(err);
}

/**
 * 编译一段 three 片段代码。
 *
 * 包裹体做的事只有两件：给 strict mode，然后把 `create` 调出来交回去。
 * 代码里没有 `create` 时返回 `null`（运行侧报「没有 create」），而不是在这里
 * 抛 —— 语法检查的目的就是把「编译不过」与「写得不对」分开报。
 */
export function compileThreeCode(code: string): ThreeCompile {
  if (typeof code !== 'string' || !code.trim()) {
    return { ok: false, error: 'code is empty' };
  }
  if (code.length > THREE_CODE_MAX_CHARS) {
    return {
      ok: false,
      error: `code is ${code.length} chars, limit is ${THREE_CODE_MAX_CHARS}`,
    };
  }
  let fn: (THREE: unknown, ctx: ThreeApiContext) => unknown;
  try {
    // 末尾那个 `return` 前的空行是必须的：代码最后一行可能是 `//` 注释。
    fn = new Function(
      'THREE',
      'ctx',
      `"use strict";\n${code}\n;return typeof create === "function" ? create(THREE, ctx) : null;`,
    ) as (THREE: unknown, ctx: ThreeApiContext) => unknown;
  } catch (err) {
    return { ok: false, error: messageOf(err) };
  }
  return { ok: true, run: fn };
}

/**
 * 模型看到的契约（能力清单与工具描述共用）。
 *
 * 写在这里而不是各写一份：工具表有两个（应用内 / MCP），能力清单还有一个，
 * 三份手写必然漂。改动这里等于同时改了给模型看的说明书。
 */
export const THREE_CODE_CONTRACT = `A three.js clip is a JavaScript function body that defines create(THREE, ctx) and returns { scene, camera, update?, resize?, dispose? }.

function create(THREE, ctx) {
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(50, ctx.width / ctx.height, 0.1, 100);
  camera.position.set(0, 0, 6);
  const mesh = new THREE.Mesh(new THREE.TorusKnotGeometry(1, 0.32, 160, 32), new THREE.MeshNormalMaterial());
  scene.add(mesh);
  return {
    scene, camera,
    update(t, frame) { mesh.rotation.set(t * 0.9, t * 0.6, 0); },
  };
}

- update(t, frame): t is CLIP-LOCAL seconds (0 at the clip start), frame = round(t * fps). Called once per rendered frame; the order can jump (scrubbing / export seek). Derive the pose from t, not from accumulated deltas.
- Two shapes are equally valid: a scene graph (meshes + lights + a real camera), or ONE fullscreen quad with a ShaderMaterial and your own GLSL. Raymarched / SDF looks are usually cheaper and sharper as a fullscreen shader — do not build geometry just to fake them.
- ctx: { width, height, fps, seed, duration, clipId, renderer }. width/height change between preview and export sizes — return resize(w, h) if the scene depends on them (the camera aspect is updated for you otherwise).
- Nothing on screen? three_status reports drawCalls and filled. drawCalls=0 = nothing drawable in the scene (or all culled); drawCalls>0 with filled=0 = it DID draw but every pixel is transparent or black (camera at/behind the near plane, vertex shader writing w=0, material alpha 0). None of those throw, so check the numbers before rewriting the scene.
- No imports, no network, no asset loaders, no addons (OrbitControls / GLTFLoader / postprocessing are NOT available). Build geometry and textures procedurally.
- All three clips share one WebGLRenderer: do not call setPixelRatio / setRenderTarget / setSize on it.
- Determinism is not required, but Math.random() will make exports differ from the preview. Derive randomness from ctx.seed.`;
