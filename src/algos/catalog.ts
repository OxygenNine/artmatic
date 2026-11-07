/**
 * catalog.ts — 算法生成器的**展示信息**目录：一句话说明 + 预览缩略图的配方。
 *
 * ## 为什么不放在各自的 `defs` 文件里
 *
 * 与 `effects/catalog.ts` 完全同一条理由：二十多条说明要**成批读一遍**才能保证
 * 语气与长度一致（"…的…。"这种句式），散在二十多个文件里做不到。而且这些是
 * **展示信息**，不是生成器协议 —— `types.ts` 讲的是这个生成器算什么，
 * 这里讲的是怎么把它介绍给人看。
 *
 * 代价是「新增一个生成器 = 两个地方」（def + 这里），摩擦由
 * `tests/unit/algo-thumb-assets.test.ts` 的「生成器展示信息目录」一节变成
 * **明确报错**：缺条目、孤儿条目、文案键解析不了、`previewParams` 写了不存在
 * 的参数键、文案超过 44 字 —— 全部会红。
 *
 * 表里的 `group` 是选择器的**浏览分组**（数学模拟 / 几何图形 / 物理模拟 / 特殊），
 * 决定卡片落在哪个小标题下。**它是必填字段**（漏了编译报错）；运行期只有插件
 * 走 `algoGroupOf` 的兜底 —— 插件没有目录条目，一律落 `DEFAULT_ALGO_GROUP`。
 *
 * ## 为什么预览要有「配方」而不是直接用默认值
 *
 * **因为默认值在 t = 0 时对 sim / bake 是全黑的。** 元胞自动机、反应扩散、
 * 沙堆、雪花这些东西的初始态是「一个种子点」，第一帧必然是空屏；bake 型还要
 * 等生长前沿走完。所以每条都要说清「在哪一秒截」。实测踩过：第一版按 t = 0
 * 截，十来个生成器的缩略图全是黑的，而且**不报错**。
 *
 * 采样时刻的选取依据是各类的「长起来要多久」：
 * - **bake**：`frontMax / speed` 是前沿走满的秒数（见 `types.ts` 的 `BakeReveal`），
 *   取它的 1.5 倍左右留余量。
 * - **realtime**：有 `u_time` 的（场景族、`menger`）取 4 秒让动画走到有形的
 *   相位；纯几何的（牛顿 / Kleinian / Lyapunov / Mandelbrot 默认视角）与 t 无关，
 *   一律 0。
 *
 * ⚠️ **`sim` 那一列的单位不是「秒」，是「步数」。** 决定形态的永远是
 * `t × rate`，而各生成器的默认步频差几十倍（兰顿蚂蚁 400、雪花 30）——
 * 按秒给就会得到一堆「刚开始长」的图。实测第一版就是这么错的：雪花在
 * t = 16s 时只有 160 步（一个孤点），蚂蚁 2400 步（一小团），反应扩散
 * 1680 步（一个环）。所以下面每条都按**目标步数**反推：
 *
 * | 生成器 | 默认 rate | 目标步数 | 秒 |
 * |---|---|---|---|
 * | 兰顿蚂蚁 | 400 | 12000（高速公路成形） | 30 |
 * | 反应扩散 | 120 | 4800（珊瑚铺开） | 40 |
 * | 雪花 | 30 | 1200（主枝带侧枝张开） | 40 |
 * | Lenia | 12 | 240 | 20 |
 * | 生命游戏 | 12 | 300 | 25 |
 * | Brian's Brain | 30 | 180 | 6 |
 * | 循环 CA | 40 | 320 | 8 |
 * | 沙堆 | 30 | 600（约 3.6 万粒，**不能更多**） | 20 |
 * | Wireworld | 60 | 600 | 10 |
 * | Buddhabrot | 15 | 450（每步 2000 样本 → 90 万） | 30 |
 *
 * 沙堆是个特例：它的总沙量有硬上限（约 4.3 万粒可完整稳定化，再多就会被
 * 防卡死闸门静默截断，见 `sandpile.ts` 文件头）。600 次落沙 × 默认 60 粒
 * = 3.6 万粒，正好在安全区内 —— **调大这一条之前先读那段**。
 *
 * Buddhabrot 是另一个特例：它的**亮度与样本数无关**（色调映射按「计数 /
 * 均值」做自适应高通，见 `buddhabrot.ts` 文件头），所以要挑的只是「噪点
 * 收敛到什么程度还能算好看」，而不是「什么时候才亮起来」。
 */

import type { MessageKey } from '../i18n/locales';

/**
 * 生成器的**浏览分组**（选择器里的小标题）。
 *
 * 与特效的 `EffectCategory` 不同，它是**浏览维度**而不是技术分类：判据是
 * 「用户想找的东西长什么样」，所以 `sandpile`（物理）与 `cyclic-ca`（数学）
 * 虽然都是网格上的规则，却分在两处。技术分类（bake / sim / realtime）在卡片
 * 上另有标记，不占小标题 —— 那个维度用户不关心。
 */
export type AlgoGroupId = 'math' | 'geometry' | 'physics' | 'special';

/** 小标题的展示顺序。 */
export const ALGO_GROUPS: AlgoGroupId[] = ['math', 'geometry', 'physics', 'special'];

/**
 * 没有分组信息的生成器（插件）落在哪。
 *
 * 与 `DEFAULT_EFFECT_CATEGORY` 同一条理由：必须是一个具体值而不是 `null`，
 * 否则那些卡片在选择器里**一条都看不见**，看起来像加载失败。
 */
export const DEFAULT_ALGO_GROUP: AlgoGroupId = 'special';

export interface AlgoCatalogEntry {
  /** 一句话说明。存**文案键**，理由同 `effects/types.ts` 的 `labelKey`。 */
  descKey: MessageKey;
  /** 浏览分组。必填 —— 漏了会在选择器里掉出全部小标题之外。 */
  group: AlgoGroupId;
  /**
   * 预览的采样时刻（秒）。
   *
   * **sim / bake 必须显式给** —— 见文件头：它们在第 0 秒是空屏。
   * 缺省值只对 realtime 有意义。
   */
  previewT?: number;
  /** 预览用的参数覆盖（与该生成器的默认值合并）。 */
  previewParams?: Record<string, number | string>;
}

/** realtime 且有 `u_time` 时用的缺省采样时刻：4 秒，让动画走到有形的相位。 */
const RT_TIME = 4;

/**
 * **realtime 条目**的构造助手。
 *
 * 它存在的理由是 `intRes` **只对 realtime 有意义** —— bake / sim 的参数表里
 * 根本没有这一项（它们的分辨率由 `size` / `width` / `height` 决定）。所以
 * `intRes` 不能像别的共用参数那样全局合并：那样会给十来个 def 塞一个它们
 * 不认识的键。让**条目构造本身**区分这两类，比在每个 def 上判断干净。
 *
 * `intRes` 提到最高档：缩略图是**唯一一次**渲染，没有「拖一下滑杆重渲」的
 * 机会，所以直接按质量优先。实测 640×360 下没有任何生成器会慢到需要降档。
 */
function rt(group: AlgoGroupId, descKey: MessageKey, previewT: number = RT_TIME): AlgoCatalogEntry {
  return { descKey, group, previewT, previewParams: { intRes: '720' } };
}

export const ALGO_CATALOG: Record<string, AlgoCatalogEntry> = {
  /* ---------------------------------------------------------------- bake */
  rule110: { descKey: 'algo.desc.rule110', group: 'math', previewT: 8 },
  bifurcation: { descKey: 'algo.desc.bifurcation', group: 'math', previewT: 6 },
  lsystem: { descKey: 'algo.desc.lsystem', group: 'math', previewT: 10 },
  // `'value'` 揭示按 speed 推进，要到 speed 秒把 255 走完才全长出来。
  'chaos-game': { descKey: 'algo.desc.chaosGame', group: 'math', previewT: 8 },
  dla: { descKey: 'algo.desc.dla', group: 'physics', previewT: 10 },

  /* ----------------------------------------------------------------- sim */
  'game-of-life': { descKey: 'algo.desc.gameOfLife', group: 'math', previewT: 25 },
  'langtons-ant': { descKey: 'algo.desc.langtonsAnt', group: 'math', previewT: 30 },
  'reaction-diffusion': { descKey: 'algo.desc.reactionDiffusion', group: 'physics', previewT: 40 },
  'brians-brain': { descKey: 'algo.desc.briansBrain', group: 'math', previewT: 6 },
  'cyclic-ca': { descKey: 'algo.desc.cyclicCa', group: 'math', previewT: 8 },
  sandpile: { descKey: 'algo.desc.sandpile', group: 'physics', previewT: 20 },
  /*
   * 40 秒 = 1200 步（默认 rate 30）。此时主枝带侧枝、枝隙清楚，晶体半径约
   * 90 格 —— 占钉扎半径的六成，画幅里留得住呼吸。
   *
   * ⚠️ 再往后长会顶到远场钉扎圈（`r > 0.92·n/2`，见 `snowflake.ts`），
   * 晶体变成一整个实心圆盘。这是 Reiter 模型的固有行为（"growth limited
   * by radius"），不是 bug —— 想要更大的晶体就调大「网格」。
   */
  snowflake: { descKey: 'algo.desc.snowflake', group: 'physics', previewT: 40 },
  lenia: { descKey: 'algo.desc.lenia', group: 'math', previewT: 20 },
  wireworld: { descKey: 'algo.desc.wireworld', group: 'math', previewT: 10 },
  buddhabrot: { descKey: 'algo.desc.buddhabrot', group: 'math', previewT: 30 },

  /* ------------------------------------------------------------ realtime */
  // 基础图案：默认参数下与 t 无关（滚动 / 旋转默认 0），0 秒截即可
  bars: rt('geometry', 'algo.desc.bars', 0),
  grid: rt('geometry', 'algo.desc.grid', 0),
  gradient: rt('geometry', 'algo.desc.gradient', 0),
  /*
   * 噪声场：有 `u_time`（场在漂移，默认 0.15 格/秒），4 秒走到一个不像 t=0
   * 的相位。三种族都铺满整幅，所以是「底纹/蒙版」而不是「黑底 + 形体」。
   */
  'noise-field': rt('geometry', 'algo.desc.noiseField'),
  /*
   * 流线：有 `u_time`（笔画在生长），所以按缺省的 4 秒截 ——
   * 那时每束线都已铺开，又不是「刚起步」的空屏。
   */
  streamlines: rt('geometry', 'algo.desc.streamlines'),
  mandelbrot: rt('math', 'algo.desc.mandelbrot', 0),
  menger: rt('math', 'algo.desc.menger'),
  /*
   * 3D 隧道：`previewT = 8` 让镜头在单元里走出一段（默认 2.6 单位/秒 → 约 21 单位，
   * 三个单元），零秒那一帧是「站在拱架正下方」，看不出纵深。
   */
  'tunnel-3d': rt('geometry', 'algo.desc.tunnel3d', 8.6),
  /*
   * 正多面体：4 秒让自旋走到一个不撞坐标轴的姿态。默认 0.6 弧度/秒 ⇒ 2.4 弧度，
   * 五重对称的形体在这个角度上棱的疏密最均匀。
   */
  polyhedron: rt('geometry', 'algo.desc.polyhedron'),
  mandelbulb: rt('math', 'algo.desc.mandelbulb'),
  apollonian: rt('math', 'algo.desc.apollonian'),
  /*
   * 3D 场景：几何体摆位与镜头都由参数定，默认是「海绵 + 曼德球」。
   * 4 秒让镜头走到一个能同时看见两个物体的侧角（默认公转 0.036 弧度/秒）。
   */
  'scene-3d': rt('geometry', 'algo.desc.scene3d'),
  newton: rt('math', 'algo.desc.newton', 0),
  /*
   * 二维码：`sim` 型但**没有步进状态**（图案与 t 无关），所以 1 秒只是满足
   * 「sim/bake 必须显式给 previewT 且 > 0」那条守卫，画面上与 t = 0 逐像素相同。
   */
  'qr-code': { descKey: 'algo.desc.qrCode', group: 'math', previewT: 1 },
  kleinian: rt('math', 'algo.desc.kleinian', 0),
  lyapunov: rt('math', 'algo.desc.lyapunov', 0),

  /*
   * 跃动几何：4 秒时（默认 0.45 次/秒 ⇒ 1.8 轮）各形状的相位已经错开，
   * 画面里既有满尺寸的、也有正在进出场的 —— 0 秒那一帧恰好可能是一屏
   * 「都在场」或「都不在场」的相位。
   */
  'kinetic-shapes': rt('geometry', 'algo.desc.kineticShapes'),

  'scene-ripple': rt('geometry', 'algo.desc.sceneRipple'),
  /*
   * 场景家族里「几何形状本身就是画面」的四个也归「几何图形」：尘场是一层层
   * 网格上的点、墨迹是等值线、损坏栅格是像素块阵、竖线束是一排竖线。
   * 它们与 `scene-flow` 的区别不在技术（都读音频特征），而在**用户找它们时
   * 想的是「一串线」还是「一团运动」** —— 分组是浏览维度，见 AlgoGroupId。
   */
  'scene-field': rt('geometry', 'algo.desc.sceneField'),
  'scene-datamosh': rt('geometry', 'algo.desc.sceneDatamosh'),
  'scene-flow': rt('geometry', 'algo.desc.sceneFlow'),
  'scene-strands': rt('geometry', 'algo.desc.sceneStrands'),
  /*
   * 体积烟雾：t 无关（噪声沿 `-wind·t` 平移，没有「长出来」的过程），4 秒只是
   * 让涡纹走到一个不像 t = 0 的相位。
   *
   * 缩略图**强制纯色背景**：它出厂是透明底，直接截会在菜单底板上糊成一片
   * 半透明的脏灰 —— 那不能代表这条生成器的样子。
   */
  smoke: {
    descKey: 'algo.desc.smoke',
    group: 'physics',
    previewT: 4,
    previewParams: { intRes: '720', bgMode: 'solid', bg: '#0a0c11' },
  },
  /*
   * 黑洞：t 只驱动盘面的差动旋转（`orbit` 出厂为 0，时间不会带着构图跑）。
   * 取 5 秒是为了让噪声的剪切错开一个不像 t = 0 的相位。
   */
  'black-hole': rt('physics', 'algo.desc.blackHole', 5),
  /*
   * 体积云：t 只驱动噪声漂移（默认 0.3 世界单位/秒），4 秒让云团走到一个不像
   * t = 0 的相位。缺省就是纯色天空，因此不像 smoke 那样需要强制 bgMode。
   */
  'volumetric-cloud': rt('physics', 'algo.desc.volumetricCloud'),

  /* ------------------------------------------------------------- recall */
  /*
   * 闪回的画面来自「片段之前的整帧」，所以缩略图**必须**给它一些过去：
   * `algo-thumb-renderer.ts` 会给这类生成器垫一条彩条轨、把片段头往后挪。
   * 采样时刻要落在片段头（约 40% 处）之后。
   */
  flashback: { descKey: 'algo.desc.flashback', group: 'special', previewT: 6 },
};

/** 某个生成器的浏览分组。插件没有目录条目 → 落在 `DEFAULT_ALGO_GROUP`。 */
export function algoGroupOf(id: string): AlgoGroupId {
  return ALGO_CATALOG[id]?.group ?? DEFAULT_ALGO_GROUP;
}

/**
 * 取某个生成器的预览配方（含全局参数合并）。
 *
 * 生成器不在目录里时返回 `null` —— 调用方（批量脚本 / lab 钩子）据此跳过，
 * 而 `algo-catalog.test.ts` 保证**注册表里的每一个都有条目**，所以线上不会
 * 走到那个分支。
 */
export function previewRecipe(
  id: string,
): { t: number; params: Record<string, number | string> } | null {
  const entry = ALGO_CATALOG[id];
  if (!entry) return null;
  return { t: entry.previewT ?? RT_TIME, params: { ...entry.previewParams } };
}
