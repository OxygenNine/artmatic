/**
 * apollonian.ts — 阿波罗尼奥斯球堆叠（球反演 IFS），realtime 型。
 *
 * 几何（折叠 + 反演 + 那条容易写错的 DE）在 `sdf-geoms.ts::APOLLONIAN_GEOM`，
 * 相机 / 步进 / 法线 / 光照 / 雾在 `sdf-lib.ts`。本文件只剩运镜与参数表。
 *
 * `iter` 的形态很敏感：不够时球面还没长出来（一片噪点），过多会把远处细节
 * 抹成灰雾。默认 8。
 *
 * ## 穿梭在这里是免费的
 *
 * fold 用 `fract`，整个距离场本来就以 2 为周期 —— 画面里那一团只是其中一个
 * 周期，隔壁还有无穷多团同样的球堆。所以只需要移动镜头，不需要像 menger
 * 那样先折叠坐标。
 */

import { APOLLONIAN_GEOM } from './sdf-geoms';
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

const CAM = `
uniform float u_push;
uniform float u_rate;
uniform float u_dist;
uniform int   u_camera;    // 0 = 环绕 · 1 = 穿梭
uniform float u_flySpeed;
uniform float u_flyShake;
uniform float u_flyTilt;

void apollCam(out vec3 eye, out vec3 rd) {
  if (u_camera == 1) {
    mat3 cam;
    /*
     * head 取 cell 的角 (1,1,1)：折叠把 [-1,1]³ 里的球堆当作一个周期，
     * 原点在球堆内部（而且 r2 = 0 会让反演倍率炸成 1e6，是个退化点），
     * 角上是这个周期里最空的地方。于是每段都从空处出发、穿过一团球堆、
     * 再回到空处 —— 就是「朝一个方向飞过去」。
     *
     * axes = 2：**只在 XZ 平面里走**。球堆沿竖直方向也以 2 为周期，
     * 但头上脚下是一整片纯色，竖直飞过去整屏什么都没有。
     */
    sdfFlyCam(u_time, u_seed, u_flySpeed, u_flyShake, u_flyTilt, 2, vec3(1.0), eye, cam);
    /* 推出实体：球堆两两相切，缝很窄，镜头擦到球面上时整幅画面会变成一块纯色。
       ⚠️ 这个余量调不大：实测 0.1 与 0.45 的画面几乎一样 —— 因为这条折叠-反演的
       距离场在球堆外侧会 plateau（0.25*|p.y|/s，s 累积越大越扁），它自己就认为
       「到处都是表面」，沿它的梯度推不动。要根治得换一条可靠的距离估计。 */
    eye = sdfCameraClear(eye, 0.15);
    rd = sdfRay(sdfUv, u_aspect, cam);
  } else {
    float yaw = u_time * 0.06 * u_rate + u_push * 1.6;
    float pitch = 0.20 + 0.14 * sin(u_time * 0.04 * u_rate);
    mat3 cam = sdfOrbitCam(yaw, pitch, u_dist * (1.0 - 0.25 * u_push), eye);
    rd = sdfRay(sdfUv, u_aspect, cam);
  }
}`;

export const APOLLONIAN_FRAG = sdfFrag(APOLLONIAN_GEOM, { src: CAM, call: 'apollCam(eye, rd);' });

export const apollonianDef: GeneratorDef = {
  id: 'apollonian',
  nameKey: 'algo.apollonian',
  kind: 'realtime',
  fragment: APOLLONIAN_FRAG,
  params: [
    { key: 'iter', labelKey: 'algo.apollonian.iter', type: 'range', min: 3, max: 16, step: 1, defaultValue: 8 },
    { key: 'scale', labelKey: 'algo.apollonian.scale', type: 'range', min: 0.6, max: 1.6, step: 0.01, defaultValue: 1 },
    ...sdfCameraParams(),
    {
      key: 'dist',
      labelKey: 'algo.sdf.dist',
      type: 'range',
      min: 1,
      max: 6,
      step: 0.02,
      defaultValue: 2.6,
      visibleWhen: (v) => v.camera !== 'fly',
    },
    {
      key: 'push',
      labelKey: 'algo.sdf.push',
      type: 'range',
      min: 0,
      max: 1,
      step: 0.01,
      defaultValue: 0,
      visibleWhen: (v) => v.camera !== 'fly',
    },
    {
      key: 'rate',
      labelKey: 'algo.sdf.rate',
      type: 'range',
      min: 0,
      max: 6,
      step: 0.05,
      defaultValue: 1,
      visibleWhen: (v) => v.camera !== 'fly',
    },
    ...sdfParams({ fog: 0.25, ao: 0.5, gloss: 0.45, ambient: '#182338', pointPow: 0.3, pointDist: 2.4 }),
  ],
  setUniforms: composeUniforms(
    sdfUniforms(),
    sdfShadeUniforms(),
    (gl, l, v, ctx) => APOLLONIAN_GEOM.set(gl, l, v, ctx, { infinite: false }),
    (gl, l, v) => {
      const set1f = (name: string, value: number): void => {
        const loc = l[name];
        if (loc) gl.uniform1f(loc, value);
      };
      set1f('u_push', Number(v.push ?? 0));
      set1f('u_rate', Number(v.rate ?? 1));
      set1f('u_dist', Number(v.dist ?? 2.6));
      set1f('u_flySpeed', Number(v.flySpeed ?? 0.6));
      set1f('u_flyShake', Number(v.flyShake ?? 0.3));
      set1f('u_flyTilt', (Number(v.flyTilt ?? 0) * Math.PI) / 180);
      set1i(gl, l, 'u_camera', SDF_CAMERAS[String(v.camera)] ?? 0);
    },
  ),
};
