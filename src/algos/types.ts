/**
 * types.ts — 算法生成器注册表协议（与特效共用 ParamDef 类型系统）。
 *
 * 四型生成器各自验证一条架构通路：
 *   bake    一次性烘焙（Worker 里跑）→ R8 纹理。例：Rule 110。
 *   sim     有状态模拟：固定步长 + 快照 + seek 重放（硬约束 1.3）。例：生命游戏。
 *   realtime 逐帧实时 shader，参数走关键帧。例：Mandelbrot。
 *   recall  内容来自**时间轴上过去的整帧**，由宿主重渲。例：闪回。
 */

import type { ParamDef } from '../effects/types';
import type { Label } from '../i18n/label';
import type { AlgoSetUniforms } from './shader-lib';

export interface BakeResult {
  data: Uint8Array;
  w: number;
  h: number;
  /** 生长方向的总量（reveal shader 的 front 以它归一）。口径随 `reveal` 变。 */
  frontMax: number;
}

export type BakeFn = (params: Record<string, number | string>, seed: number) => BakeResult;

/**
 * reveal pass 的揭示方式 —— 决定「生长」是沿哪个量推进的。
 *
 * 三种都由同一个 shape 表达（`cell * step(量, u_front)`），只是那个「量」不同：
 *
 * | 值 | 量 | frontMax 的口径 | 用在哪 |
 * |---|---|---|---|
 * | `'front-y'`（默认） | 输出空间的纵坐标 | 纹理行数 | Rule 110 那类「一代一行」的图 |
 * | `'front-x'` | 输出空间的横坐标 | 纹理列数 | 分岔图（横轴 r，逐列算出来） |
 * | `'value'` | 像素自身的值 | 255（R8 值域） | L-system 的离根距离场 —— 生长顺序**编在像素值里** |
 *
 * 三者共用 `cell` 乘子：值为 0 的像素（背景）在任何模式下都不会被点亮，
 * 所以 `'value'` 模式不必额外判「这里到底有没有东西」。
 */
export type BakeReveal = 'front-y' | 'front-x' | 'value';

/**
 * `BakeReveal` → reveal shader 的 `u_reveal` 取值。
 *
 * 放在这里而不是 `runtime.ts`：它是这个类型的一部分（协议），
 * 且 `types.ts` 不依赖 DOM/GL，单测可以直接断言「每个 bake 生成器的
 * `reveal` 都在表里」—— 拼错一个值会静默退回 `'front-y'`，没有任何报错。
 */
export const REVEAL_MODE: Record<BakeReveal, number> = {
  'front-y': 0,
  'front-x': 1,
  value: 2,
};

/** 有状态模拟句柄：纯数据，不碰 GL（单测可以直接打）。 */
export interface SimHandle {
  /** 列数。**两轴可以不等** —— 网格模拟的尺寸是 `width × height`（见 grid-dims.ts）。 */
  readonly gridW: number;
  /** 行数。 */
  readonly gridH: number;
  readonly stepsPerSec: number;
  /**
   * 通道数：`1`（默认，R8）/ `2`（RG8）/ `4`（RGBA8）。**不支持 3** ——
   * 纹理内部格式没有 24 位这一档，多出来的那一通道浪费掉比造一个奇怪格式划算。
   *
   * 缺省即单通道 ⇒ 现有生成器（生命游戏 / 兰顿蚂蚁）**逐字节走同一条旧路径**，
   * 这是 `algos.spec.ts` 的 seek 确定性用例继续成立的前提。
   */
  readonly channels?: 1 | 2 | 4;
  /** 第 simFrame 步的状态（0/255）。seek 必须满足：seek(f) ≡ 从 0 顺序 step f 次。 */
  seek(simFrame: number): void;
  /**
   * 当前状态，**通道交错**排列，长度 = `gridW * gridH * channels`。
   *
   * 交错而不是分平面：`texSubImage2D` 一次上传就吃交错数据，分平面要么多次
   * `pixelStorei` 偏移、要么在 JS 侧重排一遍。`channels === 1` 时逐字节等于
   * 旧的单通道布局，所以这个改动对老生成器是透明的。
   */
  current(): Uint8Array;
}

export type SimFactory = (params: Record<string, number | string>, seed: number) => SimHandle;

/**
 * `realtime` 生成器可以申请的**内部生成纹理**。
 *
 * 目前只有字形图集一项（ASCII 类生成器要）：它在运行时用 Canvas2D +
 * 系统等宽字体画出来，所以**不引入任何字体资产** —— 也就没有授权问题。
 * 做成声明式（而不是「生成器自己 import 一个 builder」）是为了让运行时
 * 能统一按 kind 缓存与销毁。
 */
export type AlgoAuxKind = 'glyph-atlas';

export interface AlgoAuxRef {
  /** 绑到哪个 sampler 上，如 `'u_glyph'`。 */
  uniform: string;
  kind: AlgoAuxKind;
}


interface GeneratorBase {
  id: string;
  /**
   * 展示名。内置存**文案键**、插件存字面量文本 —— 理由见 `i18n/label.ts`
   * 与 `effects/types.ts` 的注释（读取点必须走 `resolveLabel()`）。
   */
  nameKey: Label;
  /**
   * 一句话说明。**内置一律不写**（它们在 `algos/catalog.ts` 的 `ALGO_CATALOG`
   * 里，为了成批校对语气），插件则写在这里 —— 插件进不了构建期的目录表。
   * 取用顺序：`ALGO_CATALOG[id]?.descKey` → 本字段 → 回落到名称。
   */
  desc?: Label;
  params: ParamDef[];
  /**
   * **不参与「算一次、缓存起来」那段计算**的参数键（配色、调色板、显示开关、
   * 揭示速度…）—— 对 `bake` 是烘焙入参，对 `sim` 是构造参数。
   *
   * 哈希会把这些键排除，所以改它们**不会重烘 / 不会重建模拟**。对两类都是刚需：
   * 反应扩散跑了几千步、或 L-system 烘了一张 1024×512，拉一下配色就从头再来
   * 是不可接受的。
   *
   * ⚠️ 列进来就等于承诺「这个键不参与 `bake()` / `create()`」。把 `size`、
   * `rule`、`mask` 这类真入参写进来，会得到「改了参数但画面不变」的静默 bug。
   *
   * 速度不算在内 —— `bake` 的 `speed` 是揭示速度（渲染期读），sim 的 `rate`
   * 由运行时每帧从当前参数读（`liveRate`），两者都不该进哈希。但显式列上
   * 也无害，反而更明确。
   */
  volatile?: string[];
}

export type GeneratorDef =
  | (GeneratorBase & { kind: 'bake'; bake: BakeFn; reveal?: BakeReveal })
  | (GeneratorBase & {
      kind: 'sim';
      create: SimFactory;
      /**
       * 自定义着色：**替代**共享的 `TINT_FRAG`（双色调）。
       *
       * 不含头 —— 运行时会把 `TINT_HEAD` 拼在前面（那一份里已经声明了
       * `u_tex` / `u_colorBg` / `u_colorLive` / `vUv` / `outColor` 与
       * contain 适配的 `u_srcAspect` / `u_outAspect`）。所以多通道模拟
       * （如 Gray-Scott 的 u/v）只写 `main`，直接读 `u_tex.r` / `u_tex.g`。
       */
      tintFragment?: string;
      /** 上面的自定义着色需要的额外 uniform。 */
      setTintUniforms?: AlgoSetUniforms;
    })
  /**
   * `recall` 型：内容不来自算法，而来自**时间轴上更早的那一帧**。
   *
   * 它是唯一依赖「工程此刻长什么样」的生成器，所以运行时不算像素 ——
   * 由宿主注入的 `RecallProvider`（`render/recall.ts`）把过去的一整帧渲出来
   * 交回去。详见 `flashback.ts` 的文件头。
   *
   * 没有 fragment / `intRes`：多一道 pass 只会把回放帧重采样一次。
   */
  | (GeneratorBase & { kind: 'recall' })
  | (GeneratorBase & {
      kind: 'realtime';
      /** fragment **不含头** —— 由 `ALGO_HEAD` 拼在前面（见 shader-lib.ts）。 */
      fragment: string;
      /** 把求值后的参数派发到 `u_<key>`。缺了它参数永远拿不到值且不报错。 */
      setUniforms: AlgoSetUniforms;
      /**
       * **参数决定 shader 结构**时的片段工厂（目前只有 `scene-3d`：槽里放哪几个
       * 几何体决定了要拼哪些 `sdX`）。
       *
       * 给了它之后，`fragment` 只代表「出厂参数那一份」—— 预编译、接线自检、
       * 缩略图仍然拿到一个确定的东西，而运行期走这个函数。返回的 `name` 会被
       * `Kit.quad` 当成 program 缓存键，所以**不同的结构必须给不同的名字**，
       * 否则「换了两个槽的画面」和「原来的」会共用一份 program。
       */
      build?: (values: Record<string, number | string>) => BuiltShader;
      /**
       * 需要运行时创建的内部纹理（见 `AlgoAuxRef`）。
       *
       * ⚠️ 这里声明的 sampler 由**运行时**绑定，不经 `setUniforms` ——
       * 所以 `algo-uniforms.test.ts` 的「声明了的都被写到」判据会把它
       * 误判成漏写。用 aux 的 def 落地时，必须把这些名字并进那份测试的
       * `HEAD_OWNED` 集合。
       */
      auxTextures?: AlgoAuxRef[];
    });

/** `realtime def.build` 的产物：一份完整 fragment + 它在 `Kit.quad` 里的名字。 */
export interface BuiltShader {
  fragment: string;
  name: string;
}
