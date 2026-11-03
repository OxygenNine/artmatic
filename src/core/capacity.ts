/**
 * capacity.ts — 机器能力 → 容量预算的**唯一策略处**（纯函数，不碰 DOM / GL）。
 *
 * ## 为什么需要这一层
 *
 * 内存 / 显存类上限过去是散落的字面量（`DEFAULT_BUDGET_BYTES = 192MB`、
 * `MAX_RASTER_BYTES = 48MB`、`EXPORT_ENTRIES = 2` …）。它们有两个问题：
 *
 * 1. **它们其实是「机器有多宽裕」的函数，却写成了常数。** 16 GB 内存 + 16 GB 显存
 *    的台式机与 8 GB 内存的轻薄本共用同一组数字，结果要么在一台上浪费、
 *    要么在另一台上把浏览器拖死。更要命的是容量不足时的表现**通常是静默的**
 *    （画面缺层、变糊、context lost），不是报错。
 * 2. **上限与内容规模的关系容易写反。** `EXPORT_ENTRIES = 2` 那种「猜一个数」
 *    在「一帧有 3 层排版」时必然互相淘汰 —— 见 `typography/runtime.ts`。
 *    所以这里的预算只是**兜底上限**：每条消费方都还要有自己的「不许淘汰在用的」
 *    不变量，预算不够时的正确表现是**明确的降级提示**，不是悄悄少画一层。
 *
 * ## 浏览器测不准，所以由 Node 测
 *
 * 页面里能拿到的只有 `navigator.deviceMemory`（粗到 GB、只有 Chromium 有）与
 * `performance.memory`（**只统计 JS 堆**，与纹理/显存无关）。而 WebGL 连显存
 * 大小都不肯说 —— `WEBGL_debug_renderer_info` 给的是型号字符串，
 * `MAX_TEXTURE_SIZE` 是格式上限，都不是容量。
 *
 * 所以**容量由开发/预览服务端的 Node 进程探测**（`scripts/capacity.mjs`：
 * `os.freemem()` + `nvidia-smi` / 注册表），经 `/__capacity.json` 交给页面；
 * 页面用 `applyMachine()` 写进这里。探测不到（纯静态部署、探测失败）就退回
 * `DEFAULT_LIMITS` —— 那组值刻意等于「改造之前的行为」，所以**不会因为探测失败
 * 而回归**，只是拿不到更好的利用。
 *
 * ## 「可用」比「总量」重要
 *
 * 内存的判据是**探测那一刻的可用量**，不是总量：开发机同时开着 IDE 与浏览器，
 * 16 GB 的机器实际能给页面的常常只剩 3~4 GB。总量只用来做上界夹取
 * （`free` 不可能超过 `total`），以及显存那条 —— 显存没有可靠的
 * 「这个进程用了多少」的浏览器侧读数，只能按总量取份额。
 *
 * ## 派生规则是**保守**的
 *
 * 每个预算都取「这份资源里我们只占一小块」的比例，再夹进 `[floor, cap]`。
 * 比例小是刻意的：同一块显存上还有浏览器合成器、解码器表面、别的标签页；
 * 同一份内存上还有 IDE / 其它应用，而**标签页被浏览器杀掉**对用户是灾难
 * （没保存的编辑一起没了）。
 *
 * 想要更大的值：改 `artmatic.capacity.json`（见 `scripts/capacity.mjs`），
 * 或在宿主里 `setLimits()`。**不要**回来改这里的比例 —— 那是所有机器共享的策略。
 */

/** 机器能力（由 Node 探测或人工覆盖）。单位一律 MB。 */
export interface MachineCapacity {
  /** 物理内存总量。 */
  totalRamMB: number;
  /** **探测那一刻**的可用物理内存。拿不到就填 `totalRamMB`。 */
  freeRamMB: number;
  /** 显存总量；`null` = 探测不到（无独显 / 驱动不配合 / 探测手段都没有）。 */
  vramMB: number | null;
  /** 显存可用量；`null` = 没测到（只用于展示，不参与派生）。 */
  freeVramMB: number | null;
  /** 探测来源，只用于展示与排错：`node` / `override` / `unknown` … */
  source: string;
}

/**
 * 容量预算。**每一条都必须有消费方** —— 没有消费方的项不要加进来，
 * 那会变成「配置项看起来生效了，其实没人读」。
 */
export interface CapacityLimits {
  /** 视频纹理缓存的**全局**预算（MB）—— 所有素材合起来，不是每素材一份。 */
  videoTextureMB: number;
  /**
   * 单个视频素材的**纹理缓存**上限（MB）：防一个素材把全局预算吃光。
   *
   * 它衡量的是「解出来的帧占多少显存」，与源文件的体积无关 —— 一个 40 MB 的
   * H.264 与一个 800 MB 的 ProRes 解出来是同一张纹理。**不要拿它当文件大小闸门。**
   */
  videoPerAssetMB: number;
  /** 视频上传纹理的最大宽度（像素）。超过渲染宽度的像素是纯浪费。 */
  maxUploadWidth: number;
  /**
   * 视频音轨解码缓存（MB，**JS 堆**，v13）。
   *
   * 与 `videoTextureMB` 不同侧：那条是显存里的画面帧，这条是把内嵌音轨解成
   * `AudioBuffer` 占的堆。超出时不解码新的素材（播放静音 / 导出不带这条），
   * 而不是把已经在用的那条扔掉 —— 声音中途消失比一开始就没有更难查。
   */
  videoAudioMB: number;
  /** 排版位图预算（MB）：**兜底**，真正的不变量是「不许淘汰这一帧在屏的层」。 */
  textRasterMB: number;
  /** 排版位图最大边长（像素）。4K 文本层 + 放大动画的上限。 */
  rasterEdge: number;
  /** 特效池预算（MB）：主反馈 + pre-pass 历史 + delayedInput + 作用域组。 */
  effectPoolMB: number;
  /**
   * 调色的 16F 中间缓冲预算（MB）。
   *
   * 有调色模块时 ping/pong（加每层作用域一对）与绑定链的草稿要升成 RGBA16F，
   * 每像素 4 → 8 字节。超了**不悄悄降精度**：整帧退回 8 位，并在调色面板上
   * 明说（见 `core/grade.ts`）。4K + 多层作用域是唯一会撞到它的情况。
   */
  gradeTargetMB: number;
  /** 算法模拟状态纹理预算（MB）：所有 sim 源合起来。 */
  simStateMB: number;
  /**
   * 蒙版目标的长边（像素）。蒙版是**灰度、被后续采样放大**的量，所以它不属于
   * 容量预算（MB）而属于质量档：512 长边下 1080p 的蒙版约 0.15 MB/张，比一张
   * 全分辨率的中间缓冲小两个数量级。
   *
   * 为什么不做成「跟随渲染尺寸」：蒙版会随分辨率变糊，于是「同一工程换导出
   * 分辨率，局部调色的边缘跟着变」—— 而蒙版的用途本来就是柔软的范围。
   */
  maskEdge: number;
  /**
   * 导出时允许「屯在内存里」的产物上限（MB）。
   *
   * 超过它就不再走 `BufferTarget` / `zipSync` 那条整份驻留的路，改为**流式写盘**。
   * 这是唯一以「崩」收场的容量项（标签页 OOM 会把没保存的编辑一起带走），
   * 所以这一项的判据取得最小。
   */
  exportMemoryMB: number;
  /** 撤销栈步数。每条是一份**整工程快照**，所以它是内存量的函数。 */
  undoSteps: number;
  /**
   * 快照（当前帧截图）**按帧顺序重放**的帧数上限。
   *
   * 反馈类特效的历史存在池子里，钉尺寸取材时会失效 —— 只有「从第 0 帧顺序走到
   * 目标帧」才能等价于导出的那一帧。这条上限是那次重放的成本闸门：超了就不重放，
   * 退回单帧并在提示语里说明（见 `render/export-frame.ts`）。
   * 它是**帧数**而不是毫秒：重放循环里的每一帧都是一次完整渲染，
   * 帧数 × 单帧开销才是耗时，而单帧开销随分辨率与特效数变化。
   */
  snapshotReplayMaxFrames: number;
}

/**
 * 探测不到时用的保守默认。
 *
 * **刻意等于改造之前的行为**（`videoPerAssetMB` 是旧的每素材预算，
 * `textRasterMB` / `rasterEdge` / `undoSteps` 是旧常数）。这样「探测失败」
 * 只是拿不到更好的利用，不会让画面或内存表现变差。
 */
export const DEFAULT_LIMITS: CapacityLimits = {
  videoTextureMB: 512,
  videoPerAssetMB: 192,
  maxUploadWidth: 3840,
  // 256 MB ≈ 12 分钟立体声 48 kHz float32。按「只解使用区间」算，绝大多数工程够用。
  videoAudioMB: 256,
  textRasterMB: 48,
  rasterEdge: 4096,
  effectPoolMB: 256,
  maskEdge: 512,
  // 1080p 一张 RGBA16F 是 15.8 MiB，调色最坏情况（主链 + 绑定链 + 一层作用域）7 张
  // ≈ 111 MiB。384 给 1080p 留一倍余量；4K 会撞上它并退回 8 位（有明确提示）。
  gradeTargetMB: 384,
  simStateMB: 128,
  exportMemoryMB: 512,
  undoSteps: 80,
  // 900 帧 ≈ 15 s @60fps。1080p 一帧几毫秒，重放一次约 2~5 s ——
  // 是「点一下截图会等一下」的量级，还能覆盖绝大多数带反馈特效的片段。
  snapshotReplayMaxFrames: 900,
};

const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v));

/** 夹取 + 取整（避免把小数预算传进按 MB 换算的算式）。 */
function budget(share: number, floor: number, cap: number): number {
  return Math.round(clamp(share, floor, cap));
}

/**
 * 显存里我们愿意占的份额。
 *
 * 0.25 是刻意保守的：同一块卡上还有浏览器合成器、硬件解码器的表面、
 * 以及别的标签页 / 应用。显存**没有**「进程配额」这回事，超了就是整块卡
 * 一起变慢或直接把上下文丢掉。
 */
const VRAM_SHARE = 0.25;
/** 内存里我们愿意占的份额。判据是**可用**内存，不是总量。 */
const RAM_SHARE = 0.25;

/**
 * 由机器能力派生预算。
 *
 * 三段式，每段都能单独解释：
 *  1. **上界**：`free` 不可能超过 `total`（探测抖动 / 覆盖文件写错时的护栏）。
 *  2. **份额**：毛预算 = 可用量 × share。
 *  3. **夹取**：进 `[floor, cap]`。floor 保证小机器上也还能干活（不会因为
 *     探测到 1 GB 就把缓存压成 0），cap 保证大机器上也不会一次吃掉半个卡。
 *
 * 显存未知（`vramMB === null`）时不猜：GPU 侧退回保守默认，但**内存侧仍然按
 * 探测到的值算** —— 导出屯帧与撤销栈都在 JS 堆里，跟显存无关。
 */
export function deriveLimits(machine: MachineCapacity): CapacityLimits {
  const freeRam = Math.max(0, Math.min(machine.freeRamMB, machine.totalRamMB));
  const ramBudget = budget(freeRam * RAM_SHARE, 256, 4096);
  const ramSide = {
    exportMemoryMB: budget(ramBudget, 128, 2048),
    videoAudioMB: budget(ramBudget * 0.5, 128, 1024),
    undoSteps: Math.round(clamp(ramBudget / 4 / 2, 40, 200)),
  };

  const vram = machine.vramMB;
  if (vram === null || !Number.isFinite(vram) || vram <= 0) {
    return { ...DEFAULT_LIMITS, ...ramSide };
  }

  const gpu = budget(vram * VRAM_SHARE, 512, 8192);
  return {
    // 视频纹理是大头：它逐帧换、由 LRU 管，多给一点收益最大。
    videoTextureMB: budget(gpu * 0.4, 192, 2048),
    videoPerAssetMB: budget(gpu * 0.2, 64, 1024),
    // 上传宽度是**质量**旋钮不是容量旋钮：它只决定一张纹理多大，
    // 所以按「够不够 8K 素材」分档，而不是按预算比例。
    maxUploadWidth: vram >= 8192 ? 8192 : 4096,
    // 排版位图：一帧同时在屏的层数 × 单张体积。1080p 一张 8.3 MB，
    // 所以 floor 96 MB ≈ 11 层 @1080p 预览 —— 低于这个数就是「随便一个工程都闪」。
    textRasterMB: budget(gpu * 0.15, 96, 512),
    rasterEdge: DEFAULT_LIMITS.rasterEdge,
    // 特效池与模拟状态是**状态**（不能淘汰在用的那份），预算主要防「调参时越攒越多」。
    effectPoolMB: budget(gpu * 0.25, 64, 1024),
    // 调色中间缓冲只在大分辨率 + 多层作用域时才可观，但它是**当帧在用**的，
    // 超了就是整帧降精度，所以给得比特效池松：0.3 份额，floor 覆盖 1080p。
    gradeTargetMB: budget(gpu * 0.3, 192, 1536),
    simStateMB: budget(gpu * 0.1, 32, 512),
    // 蒙版边长是质量档而不是容量档（见字段说明），与机器能力无关。
    maskEdge: DEFAULT_LIMITS.maskEdge,
    // 快照重放是**时间**而不是空间，与机器能力无关：跟着默认值走。
    snapshotReplayMaxFrames: DEFAULT_LIMITS.snapshotReplayMaxFrames,
    ...ramSide,
  };
}

/* ------------------------------------------------------------- 运行期持有 */

let machine: MachineCapacity | null = null;
let limits: CapacityLimits = { ...DEFAULT_LIMITS };
let source = 'default';
const listeners = new Set<() => void>();

/**
 * 当前预算。消费方**每次用到时读**，不要缓存在自己的字段里 ——
 * 探测结果是异步到达的，缓存住就永远用不上更好的那组值。
 */
export function getLimits(): CapacityLimits {
  return limits;
}

export interface CapacitySnapshot {
  machine: MachineCapacity | null;
  limits: CapacityLimits;
  source: string;
}

export function currentCapacity(): CapacitySnapshot {
  return { machine, limits: { ...limits }, source };
}

/**
 * 写入一份新预算（可以只给部分字段）。
 *
 * 消费方读的是 `getLimits()`，所以这里只要通知一次，各池子就会在下次取用时
 * 按新预算淘汰 —— 不需要重建任何对象。
 */
export function setLimits(patch: Partial<CapacityLimits>, from = 'runtime'): void {
  limits = sanitize({ ...limits, ...patch });
  source = from;
  for (const cb of listeners) cb();
}

/** 由机器能力派生并写入（探测结果到达时走这一条）。 */
export function applyMachine(m: MachineCapacity, overrides?: Partial<CapacityLimits>): void {
  machine = m;
  limits = sanitize({ ...deriveLimits(m), ...overrides });
  source = m.source;
  for (const cb of listeners) cb();
}

/** 预算变化通知（宿主用它重画一帧 / 让池子立刻按新预算淘汰）。 */
export function onLimitsChange(cb: () => void): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

/** 测试用：恢复出厂默认（避免用例之间互相污染）。 */
export function resetCapacity(): void {
  machine = null;
  limits = { ...DEFAULT_LIMITS };
  source = 'default';
  listeners.clear();
}

/**
 * 各项的安全区间（MB / 像素 / 步）。
 *
 * 存在的理由与 `sanitize` 相同：配置项是**入口**，入口必须有边界。
 * 上界取「再大也不可能是本意」的量级（例如视频缓存 64 GB），
 * 下界取「再小就一定画不出东西」。
 */
export const RANGE: Record<keyof CapacityLimits, [number, number]> = {
  videoTextureMB: [16, 65536],
  videoPerAssetMB: [8, 32768],
  maxUploadWidth: [256, 16384],
  videoAudioMB: [16, 8192],
  textRasterMB: [8, 8192],
  rasterEdge: [256, 16384],
  effectPoolMB: [8, 8192],
  gradeTargetMB: [32, 4096],
  simStateMB: [8, 8192],
  // 下界 64 = 「再小就不是蒙版了」，上界 2048 = 「再大就和全分辨率重复了」。
  maskEdge: [64, 2048],
  exportMemoryMB: [16, 16384],
  undoSteps: [4, 2000],
  // 下界 60 帧（1 s @60fps）是「至少还能重放一秒」，上界 6000 帧是「再长就不该卡在
  // 一次点击上」—— 想重放整段长片，正确做法是走导出，不是截图。
  snapshotReplayMaxFrames: [60, 6000],
};

/**
 * 配置文件的防线：`input` 来自人工编辑的 JSON（或页面侧的补丁），**不能信**。
 *
 * 规则：非有限数 / ≤ 0 的项一律丢掉（保留默认），其余按 `RANGE` 夹取。
 * 不抛异常是刻意的 —— 一个打错的配置项不该让整个页面起不来。
 */
export function sanitize(input: Partial<CapacityLimits>): CapacityLimits {
  const out: CapacityLimits = { ...DEFAULT_LIMITS };
  for (const key of Object.keys(DEFAULT_LIMITS) as (keyof CapacityLimits)[]) {
    const v = input[key];
    if (typeof v !== 'number' || !Number.isFinite(v) || v <= 0) continue;
    const [lo, hi] = RANGE[key];
    out[key] = Math.round(clamp(v, lo, hi));
  }
  return out;
}

/** MB → 字节。所有消费方都该走它，免得各处各写一遍 `* 1024 * 1024`。 */
export function mbToBytes(mb: number): number {
  return Math.round(mb * 1024 * 1024);
}


