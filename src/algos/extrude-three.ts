/**
 * extrude-three.ts — 3D 格式化（three 版，`kind:'three'`）。
 *
 * 代码就是那个文件里的全部内容（`three-programs/extrude-three.js`，原始文本
 * 导入），参数表由它的 `params()` 派生 —— 这个 def 只负责把「叫什么、算哪一类」
 * 补齐。
 *
 * ## 为什么是新 id 而不是覆盖 `extrude-material`
 *
 * 与黑洞同一条纪律：老工程里写着 `generator: 'extrude-material'`，覆盖它等于让
 * 那些工程换一种画面，而用户什么都没做。SDF 版原地归档（`archived: true`），
 * 新 id 走新实现。
 *
 * ## 它与原版不是同一件东西
 *
 * 原版是「SDF 光线步进 + 一套自写的金属/玻璃着色」，这一版是「真挤出几何 +
 * 影棚环境贴图下的 PBR」：倒角是高光能咬住的几何，金属靠环境倒影成形，玻璃是
 * 真透明混合，还多了一盏投影灯与接影地面。**不追求画面一致** —— 形体语言相同
 * （一样的图 → 一样的立体商标），材质语言全部重来。
 */

import type { GeneratorDef } from './types';
import { defineThreeGenerator } from './three-generator';
import EXTRUDE_CODE from './three-programs/extrude-three.js?raw';

export const extrudeThreeDef: GeneratorDef = defineThreeGenerator({
  id: 'extrude-material-three',
  nameKey: 'algo.extrude',
  code: EXTRUDE_CODE,
});
