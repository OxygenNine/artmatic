/**
 * logo-sdf.ts — 位图 → 有符号距离场（纯 CPU，无 DOM / 无 GL）。
 *
 * `extrude-material` 的底座：把一张图的轮廓变成**精确欧氏距离场**，交给
 * 3D 内核当 `sdLogo(p.xy)` 用，于是「挤出 + 倒角 + 材质」全部落在 SDF 上。
 *
 * ## 为什么必须在 CPU 上算
 *
 * 光线步进要求每一步的返回值是**真实的距离下界**（过估就会穿过表面）。
 * 距离场本身是全局性质 —— 一个像素的值取决于最近的前景像素在哪，这不是
 * 逐像素能算的，所以只能用可分离变换（Felzenszwalb & Huttenlocher 的
 * 一维下界包络）在 CPU 上跑两遍：先按行、再按列，O(n) 每遍。
 *
 * 结果**按素材缓存**（见 `AlgoRuntime` 的 `logoField`）：方形 768 的图实测
 * 77 ms（成本看面积，宽幅 2400×900 只要 40 ms），只在换图时付一次。
 *
 * ## 为什么是 `R16F` 而不是「8 位 + hi/lo 打包」
 *
 * 双通道打包 + `LINEAR` 是**错的**：hi 与 lo 各自被双线性插值，而 lo 在
 * 255→0 处会跳，插出来的中间值毫无意义（画面表现为一圈圈等距的台阶）。
 * 要消除它就只能 `NEAREST`，那样轮廓在 texel 尺度上是锯齿。
 * 半浮点单通道是 WebGL2 核心格式、可线性过滤、也没有打包误差 ——
 * 代价是每 texel 2 字节（640 的内容区约 1.6 MB）。
 *
 * ## 坐标系
 *
 * 输出第 0 行 = **图像底部**，与纹理 `v = 0` 对齐（`SourceManager.uploadImage`
 * 会 `UNPACK_FLIP_Y`，而 `TexImageSource` 才受那个标志影响；这里的
 * `Float32Array` 上传**不受**它控制，所以翻转在这里做一次）。
 *
 * 世界尺度：内容区最长边固定为 **2**，所以 `texel = 2 / max(contentW,
 * contentH)`；距离值以 texel 为单位，乘 `texel` 得世界单位。
 */

/**
 * 内容区最长边（texel）。
 *
 * 768 是「够用」与「一次性成本」的折中：1 texel ≈ 0.0026 世界单位。再小一档
 * （640）在**细笔画文字**上会露馅 —— 一条 0.05 世界单位宽的笔画只剩 16 texel，
 * 二值化之后斜边的台阶是 1 texel = 6%，倒角把它放成大台阶。再往上翻倍只让
 * EDT 慢四倍，看不出差别。
 */
export const FIELD_MAX_SIDE = 768;

/**
 * 四周留白（texel）。
 *
 * 它是**倒角能吃多少距离**的余量，不是饱和值：留白带里的距离照实算（角上会
 * 超过这个数），超出纹理之外由 shader 用「到内容框的距离」接管。
 * 默认倒角 0.03 世界单位 ≈ 12 texel，128 是十倍余量 —— 用户把倒角推到参数
 * 上限（0.3 ≈ 115 texel）时距离仍然没有触到纹理边界。
 */
export const FIELD_PAD = 128;

/** 单通道灰度图（0..255）。**第 0 行是图像顶部**，与 canvas 的行序一致。 */
export interface AlphaBitmap {
  data: Uint8Array;
  w: number;
  h: number;
}

export interface LogoField {
  /** 有符号距离，单位 texel，**负值在形体内**。第 0 行 = 图像底部。 */
  data: Float32Array;
  w: number;
  h: number;
  contentW: number;
  contentH: number;
  /** 1 texel 对应的世界长度。 */
  texel: number;
}

/* ------------------------------------------------------------ 精确 EDT */

/** 不可达的平方距离哨兵。取 1e20 而不是 `Infinity`：下面的包络求交要做减法。 */
const FAR = 1e20;

/**
 * 一维下界包络（Felzenszwalb & Huttenlocher 2012, §3）。
 *
 * 输入 `f` 是平方距离（或 FAR），输出 `d[q] = min_i (f[i] + (q-i)²)`。
 * 抛物线两两求交、维护一条下包络，每点均摊 O(1)。
 */
function edt1d(f: Float64Array, n: number, d: Float64Array, v: Int32Array, z: Float64Array): void {
  let k = 0;
  v[0] = 0;
  z[0] = -Infinity;
  z[1] = Infinity;
  for (let q = 1; q < n; q += 1) {
    let s = (f[q]! + q * q - (f[v[k]!]! + v[k]! * v[k]!)) / (2 * q - 2 * v[k]!);
    // 上一条抛物线被完全遮住 ⇒ 弹出（`k === 0` 时 z[0] 是 -Infinity，不会越界）
    while (s <= z[k]!) {
      k -= 1;
      s = (f[q]! + q * q - (f[v[k]!]! + v[k]! * v[k]!)) / (2 * q - 2 * v[k]!);
    }
    k += 1;
    v[k] = q;
    z[k] = s;
    z[k + 1] = Infinity;
  }
  k = 0;
  for (let q = 0; q < n; q += 1) {
    while (z[k + 1]! < q) k += 1;
    const dq = q - v[k]!;
    d[q] = dq * dq + f[v[k]!]!;
  }
}

/**
 * 二维可分离 EDT，返回**平方距离**（不是距离）。
 *
 * `target = true` 求「到最近前景像素」的平方距离，`false` 求「到最近背景像素」。
 * 两次调用合起来就是有符号距离：内部到背景、外部到前景。
 *
 * 导出是给单测做**暴力对照**用的 —— 这个函数错了，整张距离场就错，
 * 而它的错误形态极其温和（棱角略圆、倒角略粗），肉眼无法判定。
 */
export function edt2dSquared(binary: Uint8Array, w: number, h: number, target: boolean): Float32Array {
  const col = new Float64Array(w * h);
  const out = new Float32Array(w * h);
  const maxN = Math.max(w, h);
  const f = new Float64Array(maxN);
  const d = new Float64Array(maxN);
  const v = new Int32Array(maxN);
  const z = new Float64Array(maxN + 1);

  // 行：目标像素 f = 0，其余 FAR
  for (let y = 0; y < h; y += 1) {
    const row = y * w;
    for (let x = 0; x < w; x += 1) f[x] = (binary[row + x] !== 0) === target ? 0 : FAR;
    edt1d(f, w, d, v, z);
    for (let x = 0; x < w; x += 1) col[row + x] = d[x]!;
  }
  // 列：吃上一遍的结果
  for (let x = 0; x < w; x += 1) {
    for (let y = 0; y < h; y += 1) f[y] = col[y * w + x]!;
    edt1d(f, h, d, v, z);
    for (let y = 0; y < h; y += 1) out[y * w + x] = d[y]!;
  }
  return out;
}

/* -------------------------------------------------------------- 距离场 */

/**
 * 灰度图 → 距离场。
 *
 * `threshold` 是二值化阈值（128 = 半覆盖）。距离的 0 等值面落在二值边界
 * 中间那条线上：内部 `0.5 - √distIn`、外部 `√distOut - 0.5`，所以插值出的
 * 轮廓与「像素中心落在哪一侧」严格一致，不会整体涨缩半个像素。
 */
export function buildLogoField(bmp: AlphaBitmap, threshold = 128): LogoField {
  // **只缩小、不放大**：小于 640 的图放大只会把锯齿一起放大成台阶，
  // 距离场表达不了源图没有的细节。
  const scale = Math.min(1, FIELD_MAX_SIDE / Math.max(1, bmp.w, bmp.h));
  const cw = Math.max(1, Math.round(bmp.w * scale));
  const ch = Math.max(1, Math.round(bmp.h * scale));
  const w = cw + FIELD_PAD * 2;
  const h = ch + FIELD_PAD * 2;

  const binary = new Uint8Array(w * h);
  for (let y = 0; y < ch; y += 1) {
    // y 是**输出行序**（自下而上），源图自上而下 ⇒ 先换成自上而下的行号
    const oy = ch - 1 - y;
    const sy0 = Math.floor((oy * bmp.h) / ch);
    const sy1 = Math.max(sy0 + 1, Math.floor(((oy + 1) * bmp.h) / ch));
    const dstRow = (FIELD_PAD + y) * w + FIELD_PAD;
    for (let x = 0; x < cw; x += 1) {
      const sx0 = Math.floor((x * bmp.w) / cw);
      const sx1 = Math.max(sx0 + 1, Math.floor(((x + 1) * bmp.w) / cw));
      /* **区域平均，不是最近邻**。缩小比例不是整数时（768 → 640 那种 0.83），
         最近邻会让相邻输出像素随机取到同一源像素，二值化后就是一条 1 texel
         的锯齿；区域平均把边界变成一条灰度斜坡，128 阈值落在亚像素位置，斜边
         因此是直的。比例恰好为 1 时每个块就是一个像素，等价于直接复制。 */
      let sum = 0;
      for (let sy = sy0; sy < sy1; sy += 1) {
        const row = sy * bmp.w;
        for (let sx = sx0; sx < sx1; sx += 1) sum += bmp.data[row + sx]!;
      }
      const avg = sum / ((sy1 - sy0) * (sx1 - sx0));
      if (avg >= threshold) binary[dstRow + x] = 1;
    }
  }

  const toFg = edt2dSquared(binary, w, h, true);
  const toBg = edt2dSquared(binary, w, h, false);
  const data = new Float32Array(w * h);
  for (let i = 0; i < data.length; i += 1) {
    const inside = binary[i] !== 0;
    const dd = Math.sqrt(inside ? toBg[i]! : toFg[i]!);
    /* 边界位置一律用 EDT 的**精确**距离，不掺覆盖率。覆盖率只适合「边界是
       一整格」的场合；45° 边上它本身是周期量化的（见 placeholderBitmap 的
       超采样注释），直接拿它定位置会把那条周期性写进距离场。 */
    data[i] = inside ? -(dd - 0.5) : dd - 0.5;
  }
  smoothField(data, w, h);
  return { data, w, h, contentW: cw, contentH: ch, texel: 2 / Math.max(cw, ch) };
}

/**
 * 一次可分离二项式平滑（`[1,4,6,4,1]/16`，σ ≈ 1 texel）。
 *
 * ## 为什么非要这一步
 *
 * EDT 给的是**精确**距离，但它在 texel 网格上采样，而 shader 端只能双线性
 * 重构 —— 双线性的等值线是一条**折线**，顶点落在每个 texel 的边上。曲线边界
 * 于是被切成一节一节的斜切，倒角上的高光把这节距放大成一条毛边（实测近看
 * 就是锯齿）。
 *
 * 折线来自**重构**，不来自数据：真实距离场是光滑的，只是采样不够密。把数据
 * 先变成带限的，重构误差就从「格点上的折角」降到 `O(h²·f'')`，等值线随之
 * 变成光滑曲线。
 *
 * 代价两条，都可接受：形状被抹圆约 1 texel（0.0026 世界单位，肉眼不可见）；
 * `|∇d|` 略小于 1 —— 这是**低估**，对光线步进是安全方向（顶多多走几步）。
 *
 * 线性函数会被这个核**精确保留**，所以直线边界、等距带都不会被这步影响。
 */
function smoothField(data: Float32Array, w: number, h: number): void {
  const tmp = new Float32Array(data.length);
  const at = (x: number, y: number): number =>
    data[Math.min(h - 1, Math.max(0, y)) * w + Math.min(w - 1, Math.max(0, x))]!;

  for (let y = 0; y < h; y += 1) {
    for (let x = 0; x < w; x += 1) {
      tmp[y * w + x] =
        (at(x - 2, y) + 4 * at(x - 1, y) + 6 * at(x, y) + 4 * at(x + 1, y) + at(x + 2, y)) / 16;
    }
  }
  for (let y = 0; y < h; y += 1) {
    for (let x = 0; x < w; x += 1) {
      const col = (v: number): number => tmp[Math.min(h - 1, Math.max(0, v)) * w + x]!;
      data[y * w + x] =
        (col(y - 2) + 4 * col(y - 1) + 6 * col(y) + 4 * col(y + 1) + col(y + 2)) / 16;
    }
  }
}

/* ------------------------------------------------------------ 素材适配 */

/**
 * RGBA → 单通道掩码。
 *
 * 有透明通道就用 alpha（PNG / WebP 的常态）。**没有**透明通道时退到亮度，
 * 否则一张白底黑字的 JPG 会整块变成实的 —— 那是最容易发生的情况（照片、
 * 截图、导出时勾了「背景」的图）。
 *
 * 亮度那一支要判断**哪一侧是墨**：拿全图平均亮度当背景色的代理，均值偏亮
 * ⇒ 暗的是墨，偏暗 ⇒ 亮的是墨。两种常见构图（黑字白底 / 白字黑底）都对，
 * 灰底彩字会判错 —— 那种图本来就该带 alpha 导出。
 */
export function alphaFromRgba(rgba: Uint8ClampedArray | Uint8Array, w: number, h: number): AlphaBitmap {
  const n = w * h;
  const out = new Uint8Array(n);
  let translucent = 0;
  for (let i = 0; i < n; i += 1) {
    if (rgba[i * 4 + 3]! < 250) translucent += 1;
  }
  if (translucent > n * 0.01) {
    for (let i = 0; i < n; i += 1) out[i] = rgba[i * 4 + 3]!;
    return { data: out, w, h };
  }

  let sum = 0;
  for (let i = 0; i < n; i += 1) {
    const l = 0.2126 * rgba[i * 4]! + 0.7152 * rgba[i * 4 + 1]! + 0.0722 * rgba[i * 4 + 2]!;
    out[i] = l;
    sum += l;
  }
  const inkIsDark = sum / Math.max(1, n) > 128;
  for (let i = 0; i < n; i += 1) {
    out[i] = (out[i]! < 128) === inkIsDark ? 255 : 0;
  }
  return { data: out, w, h };
}

/**
 * 没绑素材时用的占位轮廓：一个「图片」图标 —— 圆角外框 + 山 + 太阳。
 *
 * 为什么要有它而不是「未绑定时什么都不画」：这个生成器的输入是**外部素材**，
 * 而它同时出现在选择器缩略图、Agent 首次插入、以及用户还没选图的那几秒里。
 * 空画面在这三处都会被读成「坏了」。占位轮廓把「这是一个待填的图形」说清楚，
 * 而且它本身是镂空的细笔画 —— 挤出之后能看清厚度，正好当前导览。
 */
export function placeholderBitmap(size = FIELD_MAX_SIDE): AlphaBitmap {
  const data = new Uint8Array(size * size);
  const px = 2 / size; // 世界单位 / 像素（归一化盒 [-1, 1]）
  /* **3× 超采样再按面积平均**。一像素一次采样的覆盖率只是「中心处的线性
     近似」，对 45° 边会给出周期 2 的量化值（0.5±0.25 交替）—— 二值化之后
     边界是一条周期 2 的锯齿，距离场把它原封不动传下去，倒角高光就沿边起
     一串珠子。按 3×3 面积平均之后这条锯齿基本消失（成本一次性）。 */
  const SS = 3;
  const steps = SS * SS;
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      let hit = 0;
      for (let j = 0; j < SS; j += 1) {
        const sy = ((y + (j + 0.5) / SS) * px) - 1;
        for (let i = 0; i < SS; i += 1) {
          const sx = ((x + (i + 0.5) / SS) * px) - 1;
          if (placeholderSd(sx, sy) < 0) hit += 1;
        }
      }
      const a = hit / steps;
      data[y * size + x] = a <= 0 ? 0 : a >= 1 ? 255 : Math.round(a * 255);
    }
  }
  return { data, w: size, h: size };
}

const FRAME_HALF = 0.84;
const FRAME_RADIUS = 0.26;
const FRAME_STROKE = 0.075;

/** 圆角矩形 SDF（内部为负）。 */
function sdRoundBox(x: number, y: number, hx: number, hy: number, r: number): number {
  const qx = Math.abs(x) - hx + r;
  const qy = Math.abs(y) - hy + r;
  return Math.min(Math.max(qx, qy), 0) + Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) - r;
}

/** 到一条边的有符号距离。`k` 已按「哪个方向算内侧」归一（见 `placeholderSd`）。 */
function edgeDist(x: number, y: number, ax: number, ay: number, bx: number, by: number, k: number): number {
  const ex = bx - ax;
  const ey = by - ay;
  return ((ex * (y - ay) - ey * (x - ax)) / Math.hypot(ex, ey)) * k;
}

/**
 * 占位轮廓的距离场。三个部件取并集（`min`）。
 *
 * 山脚的 y 落在**外框笔画的中线**上（`FRAME_HALF`），于是山与外框连成一体；
 * 悬空的部件在挤出时是合法岛屿，但一体的轮廓在缩略图里更像一枚徽标。
 * 三角用三条边的半平面最大值 —— 顶点附近不是精确距离，而这里只要能定符号。
 */
function placeholderSd(x: number, y: number): number {
  const frame = Math.abs(sdRoundBox(x, y, FRAME_HALF, FRAME_HALF, FRAME_RADIUS)) - FRAME_STROKE;
  const sun = Math.hypot(x + 0.30, y + 0.34) - 0.155;

  const ax = 0.06, ay = -0.10;
  const bx = 0.76, by = FRAME_HALF;
  const cx = -0.50, cy = FRAME_HALF;
  // 三条边的内侧方向由对顶点决定，预先折算进 k（省掉逐像素的叉积判号）。
  // 取**负**号：内侧与对顶点同号，而 SDF 约定内部为负。
  const kAB = -Math.sign((bx - ax) * (cy - ay) - (by - ay) * (cx - ax));
  const kBC = -Math.sign((cx - bx) * (ay - by) - (cy - by) * (ax - bx));
  const kCA = -Math.sign((ax - cx) * (by - cy) - (ay - cy) * (bx - cx));
  const tri = Math.max(
    kAB === 0 ? -1e9 : edgeDist(x, y, ax, ay, bx, by, kAB),
    kBC === 0 ? -1e9 : edgeDist(x, y, bx, by, cx, cy, kBC),
    kCA === 0 ? -1e9 : edgeDist(x, y, cx, cy, ax, ay, kCA),
  );

  return Math.min(frame, Math.min(sun, tri));
}
