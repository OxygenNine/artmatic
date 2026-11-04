/**
 * mandelbulb.ts — 三维 Mandelbulb（幂次球体分形），realtime 型。
 *
 * 几何在 `sdf-geoms.ts::MANDELBULB_GEOM`（场景模式共用同一份），相机 / 步进 /
 * 法线 / 光照 / 雾在 `sdf-lib.ts`。本文件只剩运镜与参数表。
 *
 * 上游是 White & Nylander 2009 那套球坐标幂推广，数学写在几何那一边。
 *
 * 三个几何参数各自的观感见 `sdf-geoms.ts` 的注释；这里只管怎么拍它：
 * `dist` 是相机距离、`push` 是编排量（推进）、`rate` 是公转速度。
 */

import { MANDELBULB_GEOM } from './sdf-geoms';
import {
  composeUniforms,
  sdfFrag,
  sdfParams,
  sdfShadeUniforms,
  sdfUniforms,
} from './sdf-lib';
import type { GeneratorDef } from './types';

const CAM = `
uniform float u_push;    // 0..1 编排量：推近
uniform float u_rate;    // 公转速度
uniform float u_dist;    // 相机距离

void bulbCam(out vec3 eye, out vec3 rd) {
  float yaw = u_time * 0.15 * u_rate + u_push * 2.2;
  float pitch = 0.22 + 0.16 * sin(u_time * 0.05 * u_rate);
  mat3 cam = sdfOrbitCam(yaw, pitch, u_dist * (1.0 - 0.18 * u_push), eye);
  rd = sdfRay(vUv, u_aspect, cam);
}`;

export const MANDELBULB_FRAG = sdfFrag(MANDELBULB_GEOM, { src: CAM, call: 'bulbCam(eye, rd);' });

export const mandelbulbDef: GeneratorDef = {
  id: 'mandelbulb',
  nameKey: 'algo.mandelbulb',
  kind: 'realtime',
  fragment: MANDELBULB_FRAG,
  params: [
    { key: 'power', labelKey: 'algo.mandelbulb.power', type: 'range', min: 2, max: 12, step: 1, defaultValue: 8 },
    { key: 'iter', labelKey: 'algo.mandelbulb.iter', type: 'range', min: 2, max: 16, step: 1, defaultValue: 8 },
    { key: 'bail', labelKey: 'algo.mandelbulb.bail', type: 'range', min: 1, max: 4, step: 0.05, defaultValue: 2 },
    { key: 'dist', labelKey: 'algo.sdf.dist', type: 'range', min: 1.2, max: 5, step: 0.01, defaultValue: 2.4 },
    { key: 'push', labelKey: 'algo.sdf.push', type: 'range', min: 0, max: 1, step: 0.01, defaultValue: 0 },
    { key: 'rate', labelKey: 'algo.sdf.rate', type: 'range', min: 0, max: 6, step: 0.05, defaultValue: 1 },
    ...sdfParams({ gloss: 0.4, ambient: '#141f38', pointPow: 0.35, pointDist: 2.6 }),
  ],
  setUniforms: composeUniforms(
    sdfUniforms(),
    sdfShadeUniforms(),
    (gl, l, v, ctx) => MANDELBULB_GEOM.set(gl, l, v, ctx, { infinite: false }),
    (gl, l, v) => {
      const set1f = (name: string, value: number): void => {
        const loc = l[name];
        if (loc) gl.uniform1f(loc, value);
      };
      set1f('u_push', Number(v.push ?? 0));
      set1f('u_rate', Number(v.rate ?? 1));
      set1f('u_dist', Number(v.dist ?? 2.4));
    },
  ),
};
