/**
 * types.ts — 参数定义类型系统。
 *
 * 移植自 openmosh effects/types.ts（MIT，见 CREDITS.md），裁掉
 * mosh/volumeLink/fontPicker/text。特效与算法生成器共用这一套——
 * 「新增特效/生成器 = 定义 + 实现」的纪律靠统一的 ParamDef 撑住。
 *
 * ## 为什么字段叫 `labelKey` 而不是 `label`
 *
 * 这些定义表在**模块加载时求值一次**。里面如果直接写 `tr('…')`，取到的值会被
 * 冻结在导入那一刻的语言上，之后切语言永远不更新 —— 而且看不出来（只有
 * 那几项不动，别的都变了）。所以定义表只存 **key**，由 UI 侧 `tr()` 解析。
 *
 * 字段名带 `Key` 后缀是刻意的：它让「这里存的是键，用之前必须过 tr()」
 * 写在类型里。改名的另一个好处是所有使用点都会编译报错，漏不掉。
 *
 * ## 类型为什么是 `Label` 而不是 `MessageKey`
 *
 * 插件在**运行期**加载，拿不到编译期的文案键，只能带字面量文本。`Label`
 * 把两种情况收进同一个类型（见 `i18n/label.ts`），字段名与内置定义一字不改。
 * 代价是所有读取点必须走 `resolveLabel()` —— 而这正是我们要的：
 * 它让「忘了翻译」变成编译错误。
 */

import type { Label } from '../i18n/label';

interface ParamBase {
  key: string;
  labelKey: Label;
  /**
   * 条件可见性：返回 false 时这一项在检查器里不出现（值仍保留在
   * `values` 里，不参与渲染的部分照样能写 uniforms）。
   *
   * 收到的是**当前求值后的**参数表（已含默认值），所以可以写
   * `(v) => v.outline === 1`。移植自 openmosh 的同名机制。
   */
  visibleWhen?: (values: Record<string, number | string>) => boolean;
  /**
   * 分组键（文案键段）。**纯展示元数据**：检查器仍按 `params` 顺序平铺，
   * 只有分组型界面（如全屏粒子编辑器）按它把参数切成可折叠的区。
   *
   * 不另建一套控件体系是刻意的 —— 参数量大的功能用同一个 `visibleParams`
   * 消费同一份表，只是排布不同。缺省 = 不归组（由界面放进「其它」）。
   */
  group?: string;
}

export interface RangeParam extends ParamBase {
  type: 'range';
  min: number;
  max: number;
  step: number;
  defaultValue: number;
  /**
   * 非线性滑杆指数（>1 时低段占更多行程，如 zoom）。
   *
   * 只影响滑杆的像素 ↔ 值换算，不影响数字框 / 关键帧 / 落库值。
   * 换算在 `ui/controls/slider-math.ts`，参数表 → 刻度的翻译在 `param-scale.ts`。
   */
  curve?: number;
  /**
   * 对数刻度：每个倍频程占相同行程。
   *
   * 给**跨几个数量级**的量用（粒子数 256…262144）。线性的情况下
   * 「256 → 2000」只占轨道 0.7% —— 250px 的滑杆里不到 2px，等于调不动，
   * 而用户九成时间就待在这一段。只在 `min > 0` 时生效，否则退回线性。
   */
  scale?: 'log';
}

export interface SelectParam extends ParamBase {
  type: 'select';
  defaultValue: string;
  options: { labelKey: Label; value: string }[];
}

export interface CheckboxParam extends ParamBase {
  type: 'checkbox';
  defaultValue: number;
}

export interface ColorParam extends ParamBase {
  type: 'color';
  defaultValue: string;
}

/**
 * 位分组：决定位表编辑器里这一组怎么画。
 *
 * - `'eca'`   每行画三格邻域图（■■■ → □），行序 bit 高位在前（bit7 → bit0）。
 *              一维元胞自动机的规则号就是这么读出来的。
 * - `'count'` 每行是一个计数 n（生命类 CA 的 B/S：邻居数 0..8）。
 */
export interface BitmaskGroup {
  labelKey: Label;
  bits: number;
  style: 'eca' | 'count';
}

/**
 * 位掩码参数：一个 `0 .. 2^bits-1` 的整数，UI 是「可点击的位表 + 数值框」。
 *
 * 存在的理由是**同一个控件要服务两种八竿子打不着的规则**：一维 CA 的
 * 规则号（8 位、0..255）与生命类 CA 的 B/S 掩码（18 位 = 出生 9 + 存活 9）。
 * 做成 `range` 的话，B/S 会得到一条 `0..262143` 的线性滑杆 —— 毫无语义；
 * 而且 `runtime.evalParams` 对 `range` 有关键帧分支，混进来会让「这个参数
 * 能不能打关键帧」变得说不清。
 *
 * 位掩码是 **bake 入参**，因此天然不可打关键帧（`evalParams` 只对
 * `type === 'range'` 走曲线）。
 */
export interface BitmaskParam extends ParamBase {
  type: 'bitmask';
  bits: number;
  defaultValue: number;
  groups: BitmaskGroup[];
  /** 额外给一条 `0..2^bits-1` 的滑杆（一维 CA 要，B/S 不要）。 */
  slider?: boolean;
  /** 快捷预设（取代「规则号只能靠手输」）。 */
  presets?: { labelKey: Label; value: number }[];
}

/**
 * 位图参数：值是一枚 `WxH:<base64>` 编码串（见 `algos/pattern-codec.ts`）。
 *
 * **空串 = 没有图案**（调用方回退到随机撒种）。图案**自带尺寸** —— 这是
 * 「改了模拟网格大小之后还能重新居中裁剪」的关键：图案不是网格的附属，
 * 它是一张独立的、可以在任何网格上盖印的图。
 *
 * 与 `bitmask` 同理，它是 bake/sim 入参、不可打关键帧。
 */
export interface PatternParam extends ParamBase {
  type: 'pattern';
  defaultValue: string;
  /** 打开编辑器时的初建边长（新建空白图案用）。 */
  editorSize?: number;
  /** `'2d'` 手绘图案（生命游戏）；`'1d'` 单行（一维 CA 的初始行）。 */
  mode?: '2d' | '1d';
}

/**
 * 文本参数：值就是用户键入的字符串。
 *
 * 存在的理由是**候选词库**这类「内容由用户定、但不能是自由文案键」的参数：
 * 内置几套词库够用，但要的是「用户能填自己的词」。
 *
 * 与 `pattern` / `bitmask` 同理，它是**内容入参**、不可打关键帧
 * （`evalParams` 只对 `range` 走曲线）—— 让一段文字逐帧变形没有语义。
 *
 * **不是**富文本，也不做换行编辑：`multiline` 只是让输入框长高、
 * 用换行分隔多个候选（例如每行一个标签词）。
 */
export interface TextParam extends ParamBase {
  type: 'text';
  defaultValue: string;
  /** 输入上限（按字符数）。超长不会有提示，所以默认值要给得宽一点。 */
  maxLength?: number;
  /** 允许多行输入（换行分隔）。 */
  multiline?: boolean;
  /** 空值时输入框里的灰字提示。存键，理由同 `labelKey`。 */
  placeholderKey?: Label;
}

/**
 * 素材参数：值是媒体池里的 `assetId`，**空串 = 未绑定**。
 *
 * 存在的理由：生成器 / 特效需要一张**外部图片**当输入（粒子精灵、发射密度图）。
 * 它与 `EffectInstance.inputs.mask` 不是一回事 —— mask 是一次**输入绑定**
 * （可以引用另一片段的输出，要环检测），而 asset 参数是片段自己的普通参数，
 * 只能指向工程台账里的一张静态图片，没有拓扑、也就没有环。
 *
 * 只读静态图片：视频会在任意 seek 上引入异步取帧，`seek(f) ≡ 顺序 step f 次`
 * 无法保证。需要视频当纹理是独立一轮的事。
 *
 * 与 `pattern` / `text` 同理，它是内容入参、**不可打关键帧**
 * （`evalParams` 只对 `range` 走 `resolveParam`）。
 */
export interface AssetParam extends ParamBase {
  type: 'asset';
  defaultValue: string;
  /** 只收静态图片；缺省即 `'image'`。 */
  accept?: 'image';
}

export type ParamDef =
  | RangeParam
  | SelectParam
  | CheckboxParam
  | ColorParam
  | BitmaskParam
  | PatternParam
  | TextParam
  | AssetParam;

export function defaultValues(params: ParamDef[]): Record<string, number | string> {
  const out: Record<string, number | string> = {};
  for (const p of params) out[p.key] = p.defaultValue;
  return out;
}

/** 按 `visibleWhen` 过一遍参数表。values 缺项时用 defaultValue 补。 */
export function visibleParams(
  params: ParamDef[],
  values: Record<string, number | string>,
): ParamDef[] {
  return params.filter((p) => {
    if (!p.visibleWhen) return true;
    const merged: Record<string, number | string> = {};
    for (const q of params) merged[q.key] = values[q.key] ?? q.defaultValue;
    return p.visibleWhen(merged);
  });
}
