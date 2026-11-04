/**
 * sdf-compose.ts — 把多个 `SdfGeom` 拼进**一个** fragment 的文本处理（纯函数）。
 *
 * 场景生成器的片段是**运行期拼出来的**：槽里放哪几个几何体是参数，不是编译期
 * 常量。拼的过程中有两件事必须做对，而它们都是纯字符串操作 —— 所以放在这里
 * 单独可测，而不是散在 shader 生成代码里。
 *
 * ## 1. 函数名要加前缀
 *
 * GLSL 里同名函数不能定义两次。两个槽都放 menger 时，`sdMenger` / `twistY`
 * 会各出现两遍 ⇒ `redefinition`。所以每个槽给几何体的**所有顶层函数名**加
 * `s1_` / `s2_` 前缀。
 *
 * ## 2. uniform 名要加前缀
 *
 * 同一个几何体在两个槽里通常是**不同参数**（一个深 3、一个深 5）。所以每个槽
 * 的 `u_<key>` 都改写成 `u_s1_<key>`。声明的名字与**使用点**都要改 —— 只改
 * 声明的话，函数体里读到的是另一个槽的值，画面看起来「两个物体参数联动」。
 *
 * 两条都靠 `\b` 边界替换。风险在宏、注释、多行声明上，而这里的三份几何体
 * 都是一行一个声明、没有宏 —— 换新的几何体进来时要先确认这一点（守卫见
 * `tests/unit/sdf-scene.test.ts` 的「改名之后没有漏网」）。
 */

import { declaredUniforms } from './shader-lib';
import type { SdfGeom } from './sdf-lib';

/** 顶层函数定义：行首的返回类型 + 名字 + `(`。 */
const FUNC_DEF = /^(?:float|int|bool|vec2|vec3|vec4|mat2|mat3|mat4|void)\s+([A-Za-z_]\w*)\s*\(/gm;

/** 把一个标识符的所有出现（按词边界）换成新名字。 */
function renameWord(src: string, from: string, to: string): string {
  return src.replace(new RegExp(`\\b${from}\\b`, 'g'), to);
}

/** 几何体源码里定义的全部顶层函数名（含 SDF 本身与辅助函数）。 */
export function geomFunctions(src: string): string[] {
  const out: string[] = [];
  for (const m of src.matchAll(FUNC_DEF)) out.push(m[1]!);
  return out;
}

/**
 * 给一个几何体加命名空间：函数名与 uniform 名各自加 `prefix`。
 *
 * 返回 `fn` = 加了前缀之后的 SDF 函数名（调用方靠它拼 `sdSlotN`）。
 */
export function namespaceGeom(
  geom: SdfGeom,
  prefix: string,
): { src: string; fn: string; uniforms: string[] } {
  let src = geom.src;
  for (const fn of geomFunctions(src)) src = renameWord(src, fn, prefix + fn);
  const uniforms = [...declaredUniforms(src).keys()];
  for (const u of uniforms) src = renameWord(src, u, 'u_' + prefix + u.slice(2));
  return { src, fn: prefix + geom.name, uniforms };
}

/**
 * 从整份参数表里取出某个槽的值（去掉 `s1.` 前缀）。
 *
 * 几何体的 `set` 是按**自己的**键写的（`v.power`），所以必须去掉前缀之后再交给
 * 它 —— 否则它会读到 `undefined` 并退回默认值，表现是「槽的参数拖了没反应」。
 */
export function slotValues(
  values: Record<string, number | string>,
  prefix: string,
): Record<string, number | string> {
  const out: Record<string, number | string> = {};
  for (const k of Object.keys(values)) {
    if (k.startsWith(prefix)) out[k.slice(prefix.length)] = values[k]!;
  }
  return out;
}

/**
 * 给 uniform 位置表加命名空间：`l['u_power']` → `l['u_s1_power']`。
 *
 * 用 Proxy 而不是先摊一张新表：**位置表每帧都要用**，而一张场景 program 有
 * 几十个槽位 uniform，每帧重建一张对象是白花的分配。Proxy 的 `get` 只在
 * `set` 真正读某个名字时触发。
 */
export function prefixedLocs(
  locs: Record<string, WebGLUniformLocation | null>,
  prefix: string,
): Record<string, WebGLUniformLocation | null> {
  return new Proxy(locs, {
    get(target, prop) {
      if (typeof prop !== 'string') return undefined;
      // `u_x` → `u_s1_x`；不像 uniform 的名字原样透传（`set` 里偶尔会读别的）。
      const key = prop.startsWith('u_') ? `u_${prefix}${prop.slice(2)}` : prop;
      return target[key] ?? null;
    },
  });
}
