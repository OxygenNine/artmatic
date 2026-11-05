/**
 * 镜头关键帧（`typography/camera-tracks.ts`）。
 *
 * 这一份测的是**求值**：缓动 → 采样 → 文档视图，以及它跟缓存键 / 动态判定
 * 的交界。三条最容易错、错了又看不出来的：
 *
 *  - 缓动必须与面板上画的一致（镜头是 JS 采样，CSS 那份实现帮不上忙）；
 *  - `withCameraAt` 在没有动画时**必须原样返回**改传对象（每帧复制文档是隐形的税）；
 *  - 空轨道不算「有动画」—— 否则一张静态标题卡会因为面板上那四条常驻行而每帧重烘。
 */

import { describe, expect, it } from 'vitest';
import {
  CAMERA_CHANNELS,
  CAMERA_OWNER_ID,
  cameraAt,
  cameraChannelValueAt,
  cameraKeyOf,
  cameraKeysMap,
  cameraRowId,
  cubicBezierAt,
  easeProgress,
  ensureCameraTrack,
  hasCameraAnimation,
  removeCameraTrack,
  sampleTrackEased,
  setCameraTrack,
  upsertCameraKey,
  withCameraAt,
} from '../../src/typography/camera-tracks';
import { docIsAnimated } from '../../src/typography/animation';
import { docHash, rasterKeyForDoc } from '../../src/typography/cache-key';
import {
  createTextElement,
  createTypographyDocument,
  defaultCamera,
  type Camera,
  type TypographyDocument,
} from '../../src/typography/document';
import type { TrackKey } from '../../src/typography/animation-tracks';

const SIZE = { w: 1000, h: 500 };

function doc(): TypographyDocument {
  const d = createTypographyDocument(SIZE);
  d.elements = [createTextElement(d.size, { id: 'e0', text: 'T', depth: 1 })];
  return d;
}

function cam(over: Partial<Camera> = {}): Camera {
  return { ...defaultCamera(), ...over };
}

describe('缓动求值（与 CSS 同一套语义）', () => {
  it('linear / 缺省 = 恒等映射', () => {
    expect(easeProgress(null, 0.37)).toBeCloseTo(0.37, 9);
    expect(easeProgress('linear', 0.37)).toBeCloseTo(0.37, 9);
    expect(cubicBezierAt(0.37, [0, 0, 1, 1])).toBeCloseTo(0.37, 9);
  });

  it('ease-in 慢进：中点进度 < 0.5；ease-out 反过来', () => {
    expect(easeProgress('ease-in', 0.5)).toBeLessThan(0.4);
    expect(easeProgress('ease-out', 0.5)).toBeGreaterThan(0.6);
    expect(easeProgress('ease-in-out', 0.5)).toBeCloseTo(0.5, 6);
  });

  it('cubic-bezier 四元组按 CSS 的定义解（x → t → y）', () => {
    // 端点必须精确。
    expect(easeProgress([0.42, 0, 1, 1], 0)).toBeCloseTo(0, 9);
    expect(easeProgress([0.42, 0, 1, 1], 1)).toBeCloseTo(1, 9);
    // 与关键字等价：ease-in 就是 cubic-bezier(.42,0,1,1)。
    expect(easeProgress([0.42, 0, 1, 1], 0.3)).toBeCloseTo(easeProgress('ease-in', 0.3), 6);
  });

  it('steps() 的四种跳变位置', () => {
    // jump-end（缺省）：floor(p·n)/n
    expect(easeProgress({ steps: 4 }, 0.6)).toBeCloseTo(0.5, 9);
    expect(easeProgress({ steps: 4 }, 1)).toBeCloseTo(1, 9);
    // jump-start：ceil(p·n)/n
    expect(easeProgress({ steps: 4, jump: 'jump-start' }, 0.1)).toBeCloseTo(0.25, 9);
    // jump-none：floor(p·n)/(n−1)
    expect(easeProgress({ steps: 4, jump: 'jump-none' }, 0.6)).toBeCloseTo(2 / 3, 9);
    // jump-both：(floor(p·n)+1)/(n+1)
    expect(easeProgress({ steps: 4, jump: 'jump-both' }, 0.1)).toBeCloseTo(0.2, 9);
  });
});

describe('轨道采样', () => {
  const keys: TrackKey[] = [
    { t: 0, v: 0 },
    { t: 1, v: 100 },
  ];

  it('首帧之前 / 末帧之后保持不变（不是外插）', () => {
    expect(sampleTrackEased(keys, -3)).toBe(0);
    expect(sampleTrackEased(keys, 5)).toBe(100);
  });

  it('线性段 = 线性插值；带 ease 的段按缓动走', () => {
    expect(sampleTrackEased(keys, 0.25)).toBeCloseTo(25, 6);
    const eased: TrackKey[] = [
      { t: 0, v: 0, ease: 'ease-in' },
      { t: 1, v: 100 },
    ];
    // ease-in 在中点还没走完一半。
    expect(sampleTrackEased(eased, 0.5)).toBeLessThan(45);
    expect(sampleTrackEased(eased, 0.5)).toBeGreaterThan(0);
  });

  it('段内没设 ease 时回落到条目的 easing', () => {
    const eased: TrackKey[] = [
      { t: 0, v: 0 },
      { t: 1, v: 100 },
    ];
    expect(sampleTrackEased(eased, 0.5, 'linear')).toBeCloseTo(50, 6);
    expect(sampleTrackEased(eased, 0.5, 'ease-in')).toBeLessThan(45);
  });

  it('单帧轨道 = 整段时间恒定值', () => {
    expect(sampleTrackEased([{ t: 2, v: 7 }], 0)).toBe(7);
    expect(sampleTrackEased([{ t: 2, v: 7 }], 9)).toBe(7);
  });
});

describe('文档级轨道', () => {
  it('setCameraTrack 整条覆盖、id 稳定、空数组删轨道', () => {
    const d = doc();
    setCameraTrack(d, 'zoom', [
      { t: 0, v: 1 },
      { t: 2, v: 2 },
    ]);
    expect(d.animations).toHaveLength(1);
    expect(d.animations![0]!.id).toBe(cameraRowId('zoom'));
    expect(d.animations![0]!.duration).toBe(2);
    // 覆盖写：旧帧不留。
    setCameraTrack(d, 'zoom', [{ t: 1, v: 3 }]);
    expect(d.animations![0]!.keys).toEqual([{ t: 1, v: 3 }]);
    setCameraTrack(d, 'zoom', []);
    expect(d.animations).toBeUndefined();
  });

  it('upsertCameraKey 同刻改、异刻插；镜头基准值可被单通道覆盖', () => {
    const d = doc();
    d.camera = cam({ zoom: 1.5, rot: 10 });
    upsertCameraKey(d, 'zoom', 1, 2);
    upsertCameraKey(d, 'zoom', 1, 3);
    const at1 = cameraAt(d, 1);
    expect(at1.zoom).toBe(3); // 轨道赢
    expect(at1.rot).toBe(10); // 没键的通道仍读基准
    expect(cameraChannelValueAt(d, 'zoom', 0)).toBe(3); // 首帧之前保持
  });

  it('采样结果过 mergeCamera：越界 / NaN 都被夹住', () => {
    const d = doc();
    setCameraTrack(d, 'zoom', [{ t: 0, v: 999 }]);
    expect(cameraAt(d, 0).zoom).toBe(40);
    setCameraTrack(d, 'x', [{ t: 0, v: Number.NaN }]);
    // NaN 的帧由写入端挡（`coerceCameraKeys`），这里只保证求值不产生 NaN。
    expect(Number.isFinite(cameraAt(d, 0).x)).toBe(true);
  });

  it('ensureCameraTrack 幂等；removeCameraTrack 后基准值回来', () => {
    const d = doc();
    const a = ensureCameraTrack(d, 'x');
    const b = ensureCameraTrack(d, 'x');
    expect(a).toBe(b);
    expect(d.animations).toHaveLength(1);
    removeCameraTrack(d, 'x');
    expect(d.animations).toBeUndefined();
    d.camera = cam({ x: 30 });
    expect(cameraAt(d, 0).x).toBe(30);
  });

  it('cameraKeysMap 只给有帧的通道（空轨道不进读回形状）', () => {
    const d = doc();
    ensureCameraTrack(d, 'x'); // 空轨道
    setCameraTrack(d, 'rot', [{ t: 0, v: 5 }]);
    const map = cameraKeysMap(d);
    expect(Object.keys(map)).toEqual(['rot']);
    expect(map.rot).toEqual([{ t: 0, v: 5 }]);
    expect(CAMERA_CHANNELS).toHaveLength(4);
    expect(CAMERA_OWNER_ID).toBe('@camera');
    expect(cameraKeyOf('camera.zoom')).toBe('zoom');
    expect(cameraKeyOf('opacity')).toBeNull();
  });
});

describe('文档视图（withCameraAt）', () => {
  it('没有生效轨道时原样返回同一个对象（每帧复制是隐形的税）', () => {
    const d = doc();
    d.camera = cam({ zoom: 2 });
    expect(withCameraAt(d, 0)).toBe(d);
    ensureCameraTrack(d, 'zoom'); // 空轨道同样不算
    expect(withCameraAt(d, 0)).toBe(d);
  });

  it('有轨道时是浅拷贝：elements 共享，camera 是求值结果', () => {
    const d = doc();
    setCameraTrack(d, 'zoom', [
      { t: 0, v: 1 },
      { t: 2, v: 3 },
    ]);
    const v = withCameraAt(d, 1);
    expect(v).not.toBe(d);
    expect(v.elements).toBe(d.elements);
    expect(v.camera?.zoom).toBeCloseTo(2, 6);
    // 原文档不动（视图绝不回写）。
    expect(d.camera).toBeUndefined();
  });

  it('求值结果是恒等时删字段（与「没有镜头」逐字相同）', () => {
    const d = doc();
    setCameraTrack(d, 'zoom', [
      { t: 0, v: 1.4 },
      { t: 2, v: 1 },
    ]);
    const v = withCameraAt(d, 2);
    expect(v.camera).toBeUndefined();
  });

  it('docIsAnimated：有帧的镜头轨道算动态，空轨道不算', () => {
    const d = doc();
    ensureCameraTrack(d, 'zoom');
    expect(docIsAnimated(d)).toBe(false);
    upsertCameraKey(d, 'zoom', 0, 1.5);
    expect(docIsAnimated(d)).toBe(true);
  });
});

describe('缓存键', () => {
  it('镜头动画逐帧换键（哈希本身不变，视差摘要变）', () => {
    const d = doc();
    setCameraTrack(d, 'zoom', [
      { t: 0, v: 1 },
      { t: 2, v: 2 },
    ]);
    const k0 = rasterKeyForDoc(withCameraAt(d, 0), 800, 400, 0);
    const k1 = rasterKeyForDoc(withCameraAt(d, 1), 800, 400, 1);
    expect(k0).not.toBe(k1);
    /*
     * 时间**不改变文档身份**：`docHash` 跨帧恒定，逐帧差异只由视差摘要承担
     * （否则「同一份文档」在每一帧看起来都是另一份文档）。
     */
    expect(docHash(withCameraAt(d, 0))).toBe(docHash(withCameraAt(d, 2)));
    // camera / depth 不进哈希（它们的像素效果由视差摘要表达）。
    const withCam = doc();
    withCam.camera = cam({ zoom: 2 });
    expect(docHash(withCam)).toBe(docHash(doc()));
  });

  /**
   * **缺帧回退的桶必须跨帧稳定**（回归）。
   *
   * `runtime.ts::sizeKeyOf` 拿键的前四段 `docHash|WxH|frame|模式盐` 当
   * 「上一帧顶上」的桶键。镜头动画会让视差摘要**每帧都不同**——它（和超采样
   * 密度）若落进第 4 段，每帧就是一个新桶，回退永远没有可用的上一帧：
   * 播放时排版整层消失、偶尔赶上就闪一下，暂停又正常。
   */
  it('视差 / 密度不进第 4 段（回退的桶跨帧一致）', () => {
    const d = doc();
    setCameraTrack(d, 'zoom', [
      { t: 0, v: 1 },
      { t: 2, v: 2 },
    ]);
    const k0 = rasterKeyForDoc(withCameraAt(d, 0), 800, 400, 0);
    const k1 = rasterKeyForDoc(withCameraAt(d, 1), 800, 400, 1);
    /** 与 `runtime.ts::sizeKeyOf` 同一条切法：**跳过**第 3 段（帧号）。 */
    const bucket = (k: string): string => {
      const p = k.split('|');
      return `${p[0]}|${p[1]}|${p[3]}`;
    };
    expect(bucket(k0)).toBe(bucket(k1));
    // 但整键必须不同（不然两帧会命中同一张图）。
    expect(k0).not.toBe(k1);
    // 密度同样单独成段。
    const dense = rasterKeyForDoc(withCameraAt(d, 1), 800, 400, 1, { density: 2 });
    expect(bucket(dense)).toBe(bucket(k1));
    expect(dense).not.toBe(k1);
  });

  it('空轨道：键与没有镜头逐字相同', () => {
    const a = doc();
    ensureCameraTrack(a, 'zoom');
    const b = doc();
    expect(rasterKeyForDoc(withCameraAt(a, 0), 800, 400, null)).toBe(
      rasterKeyForDoc(withCameraAt(b, 0), 800, 400, null),
    );
  });

  it('hasCameraAnimation 只看有帧的通道', () => {
    const d = doc();
    expect(hasCameraAnimation(d)).toBe(false);
    ensureCameraTrack(d, 'x');
    expect(hasCameraAnimation(d)).toBe(false);
    upsertCameraKey(d, 'x', 0, 10);
    expect(hasCameraAnimation(d)).toBe(true);
  });
});
