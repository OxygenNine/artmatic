/**
 * menger.ts — Menger 海绵（三维光线步进），realtime 型。
 *
 * 移植自 angel-echo `js/scenes.js` 的 `mathfield` mode 6（同作者内部移植，见 CREDITS.md）。
 * 上游把它塞在一个「七模式采样器」里（`uMathMode` 分派），本项目的模型是
 * **一个生成器 = 一个 def**，所以单独成文件。
 *
 * 几何在 `sdf-geoms.ts::MENGER_GEOM`（场景模式共用同一份），相机 / 步进 / 法线 /
 * 光照 / 雾在 `sdf-lib.ts`。本文件只剩**运镜**与参数表 —— 这也是 P4 拆 def 的
 * 直接结果：「几何」与「怎么拍它」现在可以分开复用。
 *
 * 两条保真细节：
 * - **不要把面打爆白。** 上游第一版把光项求和到 1.65，平面糊成一片纸白，
 *   把唯一值得看的东西 —— 洞的阶梯内部 —— 全抹掉了。这条现在由 `gain = 1`
 *   加 ACES 的肩来守（`sdf-lib` 的 `sdfShade`），不再是硬编码的系数。
 * - ⚠️ **着色模型换过一次**（三项假光照 → 半球环境光 + GGX + 软阴影），
 *   所以上游那张参考画面**不可能再逐像素复现**。`steps / fog` 保的是几何与
 *   干净背景，那两项仍然有效；明暗值只能比「像不像」。
 *
 * `u_push` 代替上游的 `uMathGrow`：那是「镜头在这一个 shot 里走了多远」，
 * 属于**编排层**（硬编码的镜头表）。artmatic 的模型是用户自己编排，
 * 所以它变成一个**可打关键帧**的参数。
 *
 * ## 为什么相机没有换成内核的 `sdfOrbitCam`
 *
 * 上游同时旋转 `ro` 与 `rd`，与「把眼睛摆在球面上看向原点」数值等价但
 * **参数化不同**（`push` 同时改 yaw 与距离）。换过去会让这一个生成器的取景
 * 与以前对不上 —— 而它是唯一有「上游参考画面」要保的对象。新的 3D 都走
 * `sdfOrbitCam`，场景（`scene3d.ts`）也是。
 */

import { MENGER_GEOM } from './sdf-geoms';
import {
  SDF_CAMERAS,
  composeUniforms,
  sdfCameraParams,
  sdfFrag,
  sdfParams,
  sdfShadeUniforms,
  sdfUniforms,
  set1i,
} from './sdf-lib';
import type { GeneratorDef } from './types';

/**
 * 运镜。**只在单生成器模式下用** —— 场景模式有自己的共享镜头，槽里的几何
 * 不参与取景（否则两个物体各自摆镜头，画面就是两张图叠在一起）。
 */
const CAM = `
uniform float u_push;     // 0..1：镜头推进（编排 → 参数/关键帧）
uniform float u_rate;     // 公转速度倍率
uniform int   u_camera;   // 0 = 环绕 · 1 = 穿梭
uniform float u_flySpeed;
uniform float u_flyShake;
uniform float u_flyTilt;

void mengerCam(out vec3 eye, out vec3 rd) {
  if (u_camera == 1) {
    /*
     * 穿梭：镜头沿坐标轴直飞整整一个周期再换轴（见 sdf-lib 的 SDF_FLY_GLSL）。
     * 相机基用显式的上向量，否则视线接近竖直时右向量会退化 —— 表现为
     * 「看天花板时镜头猛地转 180°」。
     */
    mat3 cam;
    /* head = (0,0,0)：Menger 的八度 1 十字孔是三条互相垂直的贯通隧道，
       它们的交点就是原点。六个方向的走廊都从这一点出发，所以「飞一个周期
       再换轴」永远不会撞墙，sdfCameraClear 只是兜底。
       axes = 3：海绵上下左右前后都是同一套结构，竖直飞也有内容。 */
    sdfFlyCam(u_time, u_seed, u_flySpeed, u_flyShake, u_flyTilt, 3, vec3(0.0), eye, cam);
    eye = sdfCameraClear(eye, 0.08);
    rd = sdfRay(sdfUv, u_aspect, cam);
  } else {
    // 相机：上游那套「同时转 ro 与 rd」的轨道 + 推进（见文件头）
    float tm = u_time * 0.10 * u_rate;
    float yaw = tm + u_push * 1.9;
    float pit = 0.44 + 0.13 * sin(u_time * 0.063 * u_rate);
    eye = vec3(0.0, 0.0, 3.05 - u_push * 1.20);
    vec2 sc = (sdfUv - 0.5) * vec2(u_aspect, 1.0) * u_fov;
    rd = normalize(vec3(sc, -1.0));

    float cy = cos(yaw), sy = sin(yaw);
    rd.xz = mat2(cy, -sy, sy, cy) * rd.xz;
    eye.xz = mat2(cy, -sy, sy, cy) * eye.xz;
    float cp = cos(pit), sp = sin(pit);
    rd.yz = mat2(cp, -sp, sp, cp) * rd.yz;
    eye.yz = mat2(cp, -sp, sp, cp) * eye.yz;
  }
}`;

export const MENGER_FRAG = sdfFrag(MENGER_GEOM, { src: CAM, call: 'mengerCam(eye, rd);' });

export const mengerDef: GeneratorDef = {
  id: 'menger',
  nameKey: 'algo.menger',
  kind: 'realtime',
  fragment: MENGER_FRAG,
  params: [
    {
      key: 'variant',
      labelKey: 'algo.menger.variant',
      type: 'select',
      defaultValue: 'sponge',
      options: [
        { labelKey: 'algo.menger.variantSponge', value: 'sponge' },
        { labelKey: 'algo.menger.variantCarpet', value: 'carpet' },
      ],
    },
    /*
     * 无限延伸。**只对三维海绵成立** —— 地毯是二维图案挤出，把它铺满空间就是
     * 「一整块挖了洞的墙」，没有穿梭可言。所以按 variant 藏起来；着色器里也
     * 再判一次 `u_variant == 0`，因为切回地毯时存着的值仍然是 infinite。
     */
    {
      key: 'extent',
      labelKey: 'algo.menger.extent',
      type: 'select',
      defaultValue: 'bounded',
      options: [
        { labelKey: 'algo.menger.extentBounded', value: 'bounded' },
        { labelKey: 'algo.menger.extentInfinite', value: 'infinite' },
      ],
      visibleWhen: (v) => v.variant === 'sponge',
    },
    ...sdfCameraParams(),
    {
      key: 'push',
      labelKey: 'algo.menger.push',
      type: 'range',
      min: 0,
      max: 1,
      step: 0.01,
      defaultValue: 0.35,
      visibleWhen: (v) => v.camera !== 'fly',
    },
    {
      key: 'rate',
      labelKey: 'algo.menger.rate',
      type: 'range',
      min: 0,
      max: 6,
      step: 0.05,
      defaultValue: 1.6,
      visibleWhen: (v) => v.camera !== 'fly',
    },
    { key: 'depth', labelKey: 'algo.menger.depth', type: 'range', min: 2, max: 5, step: 1, defaultValue: 4 },
    {
      key: 'twist',
      labelKey: 'algo.menger.twist',
      type: 'range',
      min: -2,
      max: 2,
      step: 0.01,
      defaultValue: 0,
      // 无限延伸下不做扭转（cell 边界会撕开，见 sdf-geoms.ts 的注释）
      visibleWhen: (v) => v.extent !== 'infinite',
    },
    /*
     * 光照 / 配色 / 质量 / intRes 全是 3D 内核那套（文案键共用 `algo.sdf.*`）。
     *
     * 两个值刻意与内核默认不同，为的是**保住上游那张画面**：
     * `steps = 48`（上游的硬编码上界，72 会让远处的洞多爬出几层，取景变了）、
     * `fog = 0`（上游不开雾）。
     *
     * `ao` 反向破例：上游是 0（它用「距离衰减」代替采样遮蔽），这里给 0.55。
     * 新版着色把那条「距离衰减压全部明暗」的腿拆掉了（现在只压环境光），
     * AO 归零会让深洞变成一片平灰 —— 这不是保真，是丢掉了海绵唯一值得看的内部阶梯。
     * 阴影给得比另两个分形弱一点（0.55 / 10 步）：海绵的洞本来就深，阴影一硬
     * 整块塌成黑的。
     */
    ...sdfParams({
      steps: 48,
      fog: 0,
      ao: 0.55,
      shadow: 0.55,
      shadowSteps: 10,
      gloss: 0.5,
      ambient: '#1b2233',
      pointPow: 0.22,
      pointDist: 3.2,
    }),
  ],
  setUniforms: composeUniforms(
    sdfUniforms(),
    sdfShadeUniforms(),
    (gl, l, v, ctx) => MENGER_GEOM.set(gl, l, v, ctx, { infinite: v.extent === 'infinite' }),
    (gl, l, v) => {
      const set1f = (name: string, value: number): void => {
        const loc = l[name];
        if (loc) gl.uniform1f(loc, value);
      };
      set1f('u_push', Number(v.push ?? 0.35));
      set1f('u_rate', Number(v.rate ?? 1.6));
      set1f('u_flySpeed', Number(v.flySpeed ?? 0.6));
      set1f('u_flyShake', Number(v.flyShake ?? 0.3));
      set1f('u_flyTilt', (Number(v.flyTilt ?? 0) * Math.PI) / 180);
      set1i(gl, l, 'u_camera', SDF_CAMERAS[String(v.camera)] ?? 0);
    },
  ),
};
