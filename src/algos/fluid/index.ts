/**
 * index.ts — 「流体」生成器的对外出口。
 *
 * `gpu-sim` 型（第五型的第二个使用者）。**不是 `sim`**：状态是八张 RGBA16F
 * 纹理，`SimHandle.current()` 的 8 位量化字节装不下速度场，见 `engine.ts`。
 *
 * 参数表在 `params.ts`、归一化在 `config.ts`、着色器在 `glsl.ts`；
 * 这个文件只做组装，不碰 GL（可以在 Node 里单测）。
 */

import type { GeneratorDef } from '../types';
import { FLUID_VOLATILE_KEYS } from './config';
import { FluidEngine } from './engine';
import { FLUID_SHADERS, fluidProgramName, type FluidProgramPart } from './glsl';
import { fluidParams } from './params';

export const FLUID_ID = 'fluid';

export const fluidDef: GeneratorDef = {
  id: FLUID_ID,
  nameKey: 'algo.fluid',
  kind: 'gpu-sim',
  params: fluidParams(),
  /*
   * 只列**渲染期**的量。注入量 / 力 / 耗散 / 色相都写进状态（染料里已经有
   * 颜色了），改它们必须重放；列进来会得到「改了色相但墨流还是旧颜色」。
   */
  volatile: [...FLUID_VOLATILE_KEYS],
  auxTextures: [{ uniform: 'u_mask', kind: 'asset-image', assetParam: 'maskAsset' }],
  programs: () => (Object.keys(FLUID_SHADERS) as FluidProgramPart[]).map((part) => ({
    name: fluidProgramName(FLUID_ID, part),
    fragment: FLUID_SHADERS[part],
  })),
  create: (values, seed, kit) => new FluidEngine(kit, { values, seed, id: FLUID_ID }),
};

export {
  FLUID_DOMAIN_ASPECT,
  FLUID_MOTIONS,
  FLUID_SIM_RES_OPTIONS,
  FLUID_VOLATILE_KEYS,
  dissipationPerStep,
  fluidHexRgb,
  fluidParamKeys,
  jetAt,
  jetColor,
  jetHue,
  normalizeFluidConfig,
  type FluidConfig,
  type FluidMotion,
  type Jet,
} from './config';
export { fluidParams } from './params';
export { FLUID_SHADERS, fluidProgramName, type FluidProgramPart } from './glsl';
export { FluidEngine, type FluidDiagnostics, type FluidEngineOptions } from './engine';
