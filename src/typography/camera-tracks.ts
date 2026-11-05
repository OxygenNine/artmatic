/**
 * camera-tracks.ts — 镜头关键帧（**文档级**动画）的模型与求值。
 *
 * 为什么与元素动画不是同一套实现：元素动画是 **CSS 动画**（`animation.ts` 发射
 * `@keyframes`，`bake-animation.ts` 用 WAAPI 把 currentTime seek 到 localSec），
 * 而镜头必须在 **JS 里同步求值** —— 命中测试、手势换算、光栅化的超采样密度都要
 * 在这一帧立刻知道「现在的取景是什么」，没法等浏览器把动画跑出来再读。
 * 所以镜头走 `TracksAnimation` 的**数据**（与面板同一份关键帧模型、同一套逐段
 * 缓动），求值在这里自己做一遍。
 *
 * 两条纪律：
 *  1. **不发射 CSS**：`animationStyleSheet` 只遍历元素，文档级轨道永远不进样式表。
 *  2. **纯函数、无时钟**：时间只从调用方传进来（AGENTS §1.1）。
 *
 * 通道用什么标识：`prop` 直接写 `'camera.x'` / `'camera.y'` / `'camera.zoom'` /
 * `'camera.rot'`。前缀让「这条轨道是文档级」在数据结构里就看得见 —— 元素轨道的
 * `prop` 是 CSS 属性名（`opacity` / `transform`…），两者不会撞。
 */

import {
  applyTrackTiming,
  normalizeKeys,
  toNumber,
  type TrackEase,
  type TrackKey,
  type TracksAnimation,
} from './animation-tracks';
import {
  CAMERA_ZOOM_RANGE,
  cameraIsIdentity,
  defaultCamera,
  mergeCamera,
  type Camera,
  type TypographyDocument,
} from './document';

/* ------------------------------------------------------------ 通道 */

export type CameraChannel = 'camera.x' | 'camera.y' | 'camera.zoom' | 'camera.rot';
/** `Camera` 上的键名（通道去掉前缀）。 */
export type CameraKey = 'x' | 'y' | 'zoom' | 'rot';

export const CAMERA_CHANNELS: CameraChannel[] = [
  'camera.x',
  'camera.y',
  'camera.zoom',
  'camera.rot',
];

export interface CameraChannelMeta {
  id: CameraChannel;
  key: CameraKey;
  /** 单位后缀（`px` / `×` / `°`），不翻译。 */
  unit: string;
  identity: number;
  min?: number;
  max?: number;
  step: number;
}

/**
 * 量纲与恒等值。`identity` 只有一个用途：**新轨道的初值**与面板的读数兜底；
 * 补缺省 / 夹取仍然只发生在 `document.ts::mergeCamera` 一处。
 */
export const CAMERA_CHANNEL_META: Record<CameraChannel, CameraChannelMeta> = {
  'camera.x': { id: 'camera.x', key: 'x', unit: 'px', identity: 0, step: 10 },
  'camera.y': { id: 'camera.y', key: 'y', unit: 'px', identity: 0, step: 10 },
  'camera.zoom': {
    id: 'camera.zoom',
    key: 'zoom',
    unit: '×',
    identity: 1,
    min: CAMERA_ZOOM_RANGE[0],
    max: CAMERA_ZOOM_RANGE[1],
    step: 0.01,
  },
  'camera.rot': { id: 'camera.rot', key: 'rot', unit: '°', identity: 0, step: 1 },
};

export function isCameraChannel(prop: string): prop is CameraChannel {
  return Object.prototype.hasOwnProperty.call(CAMERA_CHANNEL_META, prop);
}

/** `'camera.zoom'` → `'zoom'`；不是镜头通道返回 null。 */
export function cameraKeyOf(prop: string): CameraKey | null {
  return isCameraChannel(prop) ? CAMERA_CHANNEL_META[prop].key : null;
}

export function cameraChannelOf(key: CameraKey): CameraChannel {
  return `camera.${key}` as CameraChannel;
}

/**
 * 面板上「镜头」那一行在元素列里的 id。
 *
 * 它不是元素，但**复用元素列 / 轨道行**的全部交互（选中、加帧、拖帧），
 * 所以需要一个和元素 id 同域的标识。元素 id 由 `newId()` 生成（无 `@`），
 * 这个保留字不会撞。
 */
export const CAMERA_OWNER_ID = '@camera';

/**
 * 镜头通道行的 id（`cam:x` / `cam:zoom` …）。
 *
 * **虚拟行与真轨道用同一个 id**：四条属性常驻显示，但没打过关键帧的通道不落库
 * （否则每开一次面板就往工程里塞四条空轨道，agent 读回里全是噪声）。双击空白
 * 加帧时 `addKey` 按这个 id 物化轨道 —— 两边 id 一致，面板的选中态才不会在
 * 「第一次加帧」的瞬间丢。
 */
export const CAMERA_ROW_PREFIX = 'cam:';

export function cameraRowId(key: CameraKey): string {
  return `${CAMERA_ROW_PREFIX}${key}`;
}

/** `'cam:zoom'` → `'zoom'`；不是虚拟行返回 null。 */
export function cameraKeyOfRowId(animId: string): CameraKey | null {
  if (!animId.startsWith(CAMERA_ROW_PREFIX)) return null;
  const key = animId.slice(CAMERA_ROW_PREFIX.length);
  return key === 'x' || key === 'y' || key === 'zoom' || key === 'rot' ? key : null;
}

/* ------------------------------------------------------------ 缓动求值 */

/**
 * CSS 关键字 → 标准贝塞尔控制点。
 *
 * 数值来自 CSS Easing Functions 定义的等价曲线（`ease` 就是
 * `cubic-bezier(.25,.1,.25,1)`）。**不引入第三方求值器**：这四条常量加一个
 * 三次贝塞尔求根就够，多一个依赖只是多一个「预览与导出不一致」的来源。
 */
const EASE_BEZIER: Record<string, [number, number, number, number]> = {
  linear: [0, 0, 1, 1],
  ease: [0.25, 0.1, 0.25, 1],
  'ease-in': [0.42, 0, 1, 1],
  'ease-out': [0, 0, 0.58, 1],
  'ease-in-out': [0.42, 0, 0.58, 1],
};

/** 三次贝塞尔的 x 分量（控制点已归一化）。 */
function bezierX(t: number, x1: number, x2: number): number {
  const u = 1 - t;
  return 3 * u * u * t * x1 + 3 * u * t * t * x2 + t * t * t;
}

/** 三次贝塞尔的 y 分量。 */
function bezierY(t: number, y1: number, y2: number): number {
  const u = 1 - t;
  return 3 * u * u * t * y1 + 3 * u * t * t * y2 + t * t * t;
}

/**
 * 给定进度 x 反解参数 t（贝塞尔 x 单调，可二分），再取 y。
 *
 * 只做**固定 24 次二分**而不是牛顿迭代：24 次的误差 < 1e-7，代价恒定、不会因为
 * 控制点贴着边界（x1 = 0 或 x2 = 1）发散。求值在每帧每通道一次，这点开销可以忽略。
 */
export function cubicBezierAt(
  x: number,
  [x1, y1, x2, y2]: readonly [number, number, number, number],
): number {
  const p = x <= 0 ? 0 : x >= 1 ? 1 : x;
  if (x1 === 0 && y1 === 0 && x2 === 1 && y2 === 1) return p; // linear 快路径
  let lo = 0;
  let hi = 1;
  for (let i = 0; i < 24; i++) {
    const mid = (lo + hi) / 2;
    if (bezierX(mid, x1, x2) < p) lo = mid;
    else hi = mid;
  }
  return bezierY((lo + hi) / 2, y1, y2);
}

/** CSS `steps()` 的跳变位置。 */
type StepJump = 'jump-start' | 'jump-end' | 'jump-none' | 'jump-both' | 'start' | 'end';

function stepsAt(p: number, n: number, jump: StepJump): number {
  const count = Math.max(1, Math.round(n));
  const x = p <= 0 ? 0 : p >= 1 ? 1 : p;
  switch (jump) {
    case 'jump-start':
    case 'start':
      return Math.ceil(x * count) / count;
    case 'jump-none':
      return count <= 1 ? x : Math.min(1, Math.floor(x * count) / (count - 1));
    case 'jump-both':
      return Math.min(1, (Math.floor(x * count) + 1) / (count + 1));
    default:
      return Math.floor(x * count) / count;
  }
}

/**
 * 缓动 → 进度映射（0..1 → 0..1）。`null` / 未知一律线性。
 *
 * 与 CSS 同一套语义；**这是镜头动画与元素动画唯一必须逐字对齐的地方** ——
 * 面板上给某一段设了 `ease-in`，镜头在这一段也必须慢进，否则「同一条轨道在
 * 面板上画出来了、画面不照它走」。
 */
export function easeProgress(ease: TrackEase | null | undefined, p: number): number {
  if (!ease) return p;
  if (Array.isArray(ease)) return cubicBezierAt(p, ease);
  if (typeof ease === 'object') return stepsAt(p, ease.steps, ease.jump ?? 'end');
  const bez = EASE_BEZIER[ease];
  return bez ? cubicBezierAt(p, bez) : p;
}

/* ------------------------------------------------------------ 求值 */

/**
 * 一条轨道在 `t` 时刻的值（**走逐段缓动**）。
 *
 * 与 `sampleKeys` 的分工：那个是面板读数的线性插值，这个是画面真正看到的值。
 * 两处都保留是刻意的 —— 面板行头的读数在拖缓动时不该跳，而画面必须照缓动走。
 */
export function sampleTrackEased(
  keys: readonly TrackKey[],
  t: number,
  fallback: TrackEase = 'linear',
): number {
  const ks = normalizeKeys(keys);
  if (ks.length === 0) return 0;
  if (t <= ks[0]!.t) return toNumber(ks[0]!.v);
  const last = ks[ks.length - 1]!;
  if (t >= last.t) return toNumber(last.v);
  let i = 0;
  while (i < ks.length - 1 && ks[i + 1]!.t <= t) i += 1;
  const a = ks[i]!;
  const b = ks[i + 1]!;
  const span = b.t - a.t;
  if (span <= 1e-9) return toNumber(b.v);
  const v0 = toNumber(a.v);
  const v1 = toNumber(b.v);
  return v0 + (v1 - v0) * easeProgress(a.ease ?? fallback, (t - a.t) / span);
}

/* ------------------------------------------------------------ 文档级轨道 */

/** 文档里的镜头轨道（`prop` 以 `camera.` 开头）。 */
export function cameraTracksOf(doc: TypographyDocument): TracksAnimation[] {
  return (doc.animations ?? []).filter((a) => a.kind === 'tracks' && isCameraChannel(a.prop));
}

/** 文档是否有**生效的**镜头动画（空轨道不算 —— 它不影响任何像素）。 */
export function hasCameraAnimation(doc: TypographyDocument): boolean {
  return cameraTracksOf(doc).some((a) => a.keys.length > 0);
}

/**
 * 造一条镜头轨道（id 固定为 `camera-<通道>`：一个通道最多一条，确定性 id 让
 * 读回 / 写回的往返稳定，也让 agent 的 diff 不会每一轮都变）。
 */
export function createCameraTrack(
  key: CameraKey,
  keys: readonly TrackKey[] = [],
): TracksAnimation {
  return applyTrackTiming({
    id: cameraRowId(key),
    kind: 'tracks',
    prop: cameraChannelOf(key),
    keys: keys.map((k) => ({ ...k })),
    delay: 0,
    duration: 0.6,
    iterations: 1,
    /*
     * 缺省 **linear**（元素轨道那边是 `ease-out`）。差别不是口味：镜头轨道几乎
     * 总是由 agent 或「整条写」进来的，模型写 `[{t:0,v:1},{t:2,v:3}]` 时期待的
     * 就是匀速推近；偷偷套一条 ease-out 会让每段的首尾速度对不上它算好的时间表，
     * 而画面看起来「差不多对」。
     */
    easing: 'linear',
    direction: 'normal',
    fill: 'both',
  });
}

/**
 * 取（没有就建）某条镜头通道的轨道。**只改文档对象，不提交** —— 调用方负责
 * 包在 `store.commit` / `editorState.commit` 里。
 */
export function ensureCameraTrack(doc: TypographyDocument, key: CameraKey): TracksAnimation {
  const prop = cameraChannelOf(key);
  const found = (doc.animations ?? []).find((a) => a.kind === 'tracks' && a.prop === prop);
  if (found) return found;
  const track = createCameraTrack(key);
  doc.animations = [...(doc.animations ?? []), track];
  return track;
}

/** 删掉某条镜头通道的轨道（`null` 语义：这一层回到 `doc.camera`）。 */
export function removeCameraTrack(doc: TypographyDocument, key: CameraKey): void {
  const prop = cameraChannelOf(key);
  const next = (doc.animations ?? []).filter((a) => !(a.kind === 'tracks' && a.prop === prop));
  if (next.length) doc.animations = next;
  else delete doc.animations;
}

/**
 * 写入某条镜头通道的整串关键帧（`null` / 空数组 = 删掉这条轨道）。
 *
 * **整串写**而不是逐帧增删：控制平面的 `typo_set_camera_animation` 用它，
 * 「读回什么就能写回什么」在这里必须成立。
 */
export function setCameraTrack(
  doc: TypographyDocument,
  key: CameraKey,
  keys: readonly TrackKey[] | null,
): void {
  if (!keys || keys.length === 0) {
    removeCameraTrack(doc, key);
    return;
  }
  const track = ensureCameraTrack(doc, key);
  track.keys = normalizeKeys(keys).map((k) => ({ ...k }));
  applyTrackTiming(track);
}

/** 在 `t` 处写一帧（有就改、没有就插）。用于浮层的「自动关键帧」。 */
export function upsertCameraKey(
  doc: TypographyDocument,
  key: CameraKey,
  t: number,
  v: number,
): void {
  const track = ensureCameraTrack(doc, key);
  const at = Math.max(0, t);
  const hit = track.keys.find((k) => Math.abs(k.t - at) < 1e-6);
  if (hit) hit.v = v;
  else track.keys = [...track.keys, { t: at, v }];
  applyTrackTiming(track);
}

/** 某个通道的基准值（`doc.camera` 缺省即恒等）。 */
export function cameraBaseValue(doc: TypographyDocument, key: CameraKey): number {
  return (doc.camera ?? defaultCamera())[key];
}

/**
 * `t` 时刻的镜头。**这是渲染侧唯一该调的求值入口**。
 *
 * 有关键帧的通道取轨道值，其余取 `doc.camera`（缺省恒等），最后统一过
 * `mergeCamera` —— 夹取只发生在那一处，动画不会把 zoom 写成 0 或 NaN。
 */
export function cameraAt(doc: TypographyDocument, localSec: number): Camera {
  const tracks = cameraTracksOf(doc).filter((a) => a.keys.length > 0);
  if (!tracks.length) return { ...(doc.camera ?? defaultCamera()) };
  const raw: Partial<Camera> = {};
  for (const tr of tracks) {
    const key = cameraKeyOf(tr.prop);
    if (!key) continue;
    raw[key] = sampleTrackEased(tr.keys, localSec, tr.easing);
  }
  return mergeCamera(doc.camera, raw);
}

/** 一条通道在 `t` 时刻的读数（面板行头 / 新建关键帧的初值）。 */
export function cameraChannelValueAt(
  doc: TypographyDocument,
  key: CameraKey,
  localSec: number,
): number {
  const prop = cameraChannelOf(key);
  const track = cameraTracksOf(doc).find((a) => a.prop === prop);
  if (!track || track.keys.length === 0) return cameraBaseValue(doc, key);
  return sampleTrackEased(track.keys, localSec, track.easing);
}

/**
 * 「`t` 时刻的文档」—— 只把 `camera` 换成求值结果，其余字段是**同一份引用**。
 *
 * 这是渲染侧的统一入口（舞台 / 光栅化 / 命中测试）。返回的对象是**视图**：
 * 不要往它上面写（改元素会改到真文档，改 `camera` 会丢掉）。
 *
 * 没有生效的镜头轨道时**原样返回入参**：绝大多数文档走这条快路径，
 * 不会为「有镜头动画」这件事每帧复制一次文档。
 */
export function withCameraAt(doc: TypographyDocument, localSec: number): TypographyDocument {
  if (!hasCameraAnimation(doc)) return doc;
  const cam = cameraAt(doc, localSec);
  const next: TypographyDocument = { ...doc };
  if (cameraIsIdentity(cam)) delete next.camera;
  else next.camera = cam;
  return next;
}

/** 面板 / agent 读回共用：轨道列表 → 通道 → 关键帧（顺序固定，便于比对）。 */
export function cameraKeysMap(
  doc: TypographyDocument,
): Partial<Record<CameraKey, TrackKey[]>> {
  const out: Partial<Record<CameraKey, TrackKey[]>> = {};
  for (const tr of cameraTracksOf(doc)) {
    const key = cameraKeyOf(tr.prop);
    if (!key || tr.keys.length === 0) continue;
    out[key] = tr.keys.map((k) => ({ ...k }));
  }
  return out;
}
