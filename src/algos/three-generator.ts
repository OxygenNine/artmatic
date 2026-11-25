/**
 * three-generator.ts — 用 three 程序写**内置生成器**的接线。
 *
 * 一个 `kind:'three'` 的生成器与片段里手写的 three 代码是同一份东西
 * （契约见 `three/code.ts`），差别只在参数的来路：
 *
 * | | 参数从哪来 | 谁改 |
 * |---|---|---|
 * | `source.type:'three'` 片段 | 片段自己的 `source.params` | 检查器 / `set_three_params` |
 * | `def.kind:'three'` 生成器 | `source.params`（`{type:'algo'}` 片段）经 `evalParams` 求值 | 检查器 / `set_params` / 关键帧 |
 *
 * 生成器这条多走了一步 `resolveParam`，所以关键帧与调制自动可用 —— 那是
 * `evalParams` 既有的能力，这里不需要另开一条求值路径。
 *
 * ## 为什么参数表在模块加载时就要成型
 *
 * 检查器、能力清单（Agent 看到的参数名）、缩略图配方读的都是 `def.params`，
 * 而它们不认识「代码」这个概念。`readThreeParams` 按源码缓存，所以这里只是
 * 把同一份真相换个形状，不是第二份定义表。
 *
 * ⚠️ 代价：参数标签是**代码里的中文文本**（`Label` 的字面量分支），不随语言
 * 切换。要本地化，得让 `params()` 接受文案键 —— 那是另一轮的事，别在这里
 * 偷偷加一张「生成器 → 文案键」的映射表（那正是三维表漂移的起点）。
 */

import { readThreeParams } from '../three/code';
import type { ParamDef } from '../effects/types';
import type { Label } from '../i18n/label';
import type { GeneratorDef } from './types';

/**
 * 代码里的 `params()` → 注册表协议的 `ParamDef[]`。
 *
 * 逐字段搬运，不做二次校验：`normalizeThreeParams` 已经把坏条目丢掉、把区间
 * 夹好了，两边再各判一次只会让「代码里写的」与「面板上显示的」出现两套规则。
 */
export function threeParamDefs(code: string): ParamDef[] {
  const out: ParamDef[] = [];
  for (const d of readThreeParams(code)) {
    switch (d.type) {
      case 'range':
        out.push({
          key: d.key,
          labelKey: d.label,
          type: 'range',
          min: d.min ?? 0,
          max: d.max ?? 1,
          step: d.step ?? 0.01,
          defaultValue: Number(d.defaultValue),
          ...(d.rebuild ? { rebuild: true } : {}),
        });
        break;
      case 'select':
        out.push({
          key: d.key,
          labelKey: d.label,
          type: 'select',
          options: (d.options ?? []).map((o) => ({ value: o.value, labelKey: o.label })),
          defaultValue: String(d.defaultValue),
          ...(d.rebuild ? { rebuild: true } : {}),
        });
        break;
      case 'checkbox':
        out.push({
          key: d.key,
          labelKey: d.label,
          type: 'checkbox',
          defaultValue: Number(d.defaultValue) ? 1 : 0,
          ...(d.rebuild ? { rebuild: true } : {}),
        });
        break;
      case 'color':
        out.push({
          key: d.key,
          labelKey: d.label,
          type: 'color',
          defaultValue: String(d.defaultValue),
          ...(d.rebuild ? { rebuild: true } : {}),
        });
        break;
    }
  }
  return out;
}

/**
 * 定义一个 three 生成器。
 *
 * `params` 由代码给出，这里**不允许**再传一份 —— 两处都能写的话，改代码里
 * 的参数名就有一次「忘了改 def」的机会，而它的表现是面板上多一个改了没反应
 * 的滑杆。
 */
export function defineThreeGenerator(spec: {
  id: string;
  nameKey: Label;
  code: string;
}): GeneratorDef {
  return {
    id: spec.id,
    nameKey: spec.nameKey,
    kind: 'three',
    code: spec.code,
    params: threeParamDefs(spec.code),
  };
}
