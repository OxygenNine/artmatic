/**
 * asset-params.ts — `asset` 型参数的引用修复（纯函数，不依赖 `algos/` 与 `ui/`）。
 *
 * 依赖方向：`algos/particles` 与 `ui/` 都 import 这里，反过来不行。
 * 键清单放在 `core/` 是刻意的 —— 打开工程（`validateProject`）、删除素材
 * （`appState.removeAsset`）、控制平面校验都要知道「哪些键是素材引用」，
 * 而 `core/` 不许 import 注册表。
 *
 * 与 `MaskRef` 的区别：mask 是**输入绑定**（可指向另一片段、要环检测），
 * asset 参数是片段自己的普通参数（只能指向静态图片、没有拓扑）。
 * 所以这里不需要环检测，只需要「悬空就置空」。
 */

/**
 * 所有 `asset` 型参数键的**唯一真源**。新增一种素材入参就加一行，
 * 三处引用修复自动跟上。
 *
 * ⚠️ 这是**全项目**的清单，不是某一族的。粒子的那两个与流体的 `maskAsset`
 * 在同一张表里 —— 各写一份的后果是「删了素材之后那个引用还挂着」，
 * 而它在运行期表现为「这张图一直缺席」，不报错。
 */
export const ASSET_PARAM_KEYS = ['spriteAsset', 'emitAsset', 'maskAsset', 'logoAsset'] as const;
export type AssetParamKey = (typeof ASSET_PARAM_KEYS)[number];

interface AssetRecord {
  kind?: string;
}

/**
 * 能带 asset 参数的两处：
 *  - `SourceClip.source.type === 'algo'` 的 `source.params`；
 *  - `EffectClip.chain[].values`（当前只有生成器用，但特效也能接）。
 *
 * 用**结构化类型**而不是 import `Project`：`schema.ts` 会 import 本文件，
 * 反过来 import 会在模块加载时成环（type-only import 虽能编译，但这里连
 * 类型都不需要 —— 只碰三张 `Record`）。
 */
interface ParamsOwner {
  kind?: string;
  source?: { type?: string; params?: Record<string, number | string> };
  chain?: { values: Record<string, number | string> }[];
}

interface AssetRefProject {
  assets: Record<string, AssetRecord>;
  tracks: { clips: ParamsOwner[] }[];
}

function* paramTables(p: AssetRefProject): Generator<Record<string, number | string>> {
  for (const tk of p.tracks) {
    for (const c of tk.clips) {
      if (c.source?.type === 'algo' && c.source.params) yield c.source.params;
      for (const inst of c.chain ?? []) yield inst.values;
    }
  }
}

/** 是不是一个「已绑定且存在」的图片素材引用。 */
export function isResolvedImageAsset(
  assets: Record<string, AssetRecord>,
  value: unknown,
): boolean {
  if (typeof value !== 'string' || !value) return false;
  return assets[value]?.kind === 'image';
}

/**
 * 打开工程时兜底：手改 JSON / 素材被删后的悬空 asset 引用一律置空串。
 *
 * **置空而不是删键** —— 与 `MaskRef` 同一条纪律：删键会让「运行时逐键
 * `?? defaultValue` 合并」把它变成 def 的默认值（可能是别的素材），
 * 空串才是「明确没绑」。
 */
export function sanitizeAssetParams(p: AssetRefProject): number {
  let fixed = 0;
  for (const table of paramTables(p)) {
    for (const key of ASSET_PARAM_KEYS) {
      const v = table[key];
      if (v === undefined) continue;
      if (typeof v !== 'string') {
        table[key] = '';
        fixed++;
      } else if (v && !isResolvedImageAsset(p.assets, v)) {
        table[key] = '';
        fixed++;
      }
    }
  }
  return fixed;
}

/**
 * 删除素材时：把所有指向它的 asset 参数置空。
 * 返回真正改了几处（0 = 本来没人引用，不是错误）。
 */
export function clearAssetRefsInProject(p: AssetRefProject, assetId: string): number {
  let changed = 0;
  for (const table of paramTables(p)) {
    for (const key of ASSET_PARAM_KEYS) {
      if (table[key] === assetId) {
        table[key] = '';
        changed++;
      }
    }
  }
  return changed;
}

/** 校验单个值是否合法的 asset 参数值（写入前置用）。只收字符串。 */
export function validAssetParamValue(v: unknown): boolean {
  return typeof v === 'string';
}
