/**
 * missing.ts — 「工程引用了没挂载的插件」的检测。
 *
 * 纯函数：只读 `Project` 与一个「已挂载的插件 id 集合」，不碰注册表、不碰 DOM。
 * 这样它能脱离浏览器单测，也能被 lab / agent / 导出路径复用。
 *
 * ## 为什么需要它
 *
 * 渲染层的降级**已经存在**（未知特效原样透传、未知生成器返回 null，见
 * `effects/runner.ts` / `algos/runtime.ts`），所以缺插件不会崩、不会毁图 ——
 * 但它会**安静地什么都不做**：用户看到的是「我这层特效怎么没反应」。
 * 缺失检测补的就是这一句解释。
 *
 * ## 它不负责的事
 *
 * 不负责「把片段修好」。片段与参数**原样保留**是刻意的（AGENTS §5.1 的
 * 「工程引用了已删素材是有害的」反过来：数据在磁盘上不能因为我们认不出来就丢）。
 * 用户事后补载插件，画面应该立刻恢复 —— 这就要求 id 一个字节都不能动。
 */

import type { Project } from '../core/schema';
import { isPluginDefId, pluginIdOf } from '../core/plugin-id';

export interface MissingPluginRef {
  pluginId: string;
  /** 被引用的次数（一个片段或一条特效实例算一次）。用来排序与措辞。 */
  count: number;
  /** 引用到的**对外 id**（含命名空间），已去重并排序。给诊断用。 */
  defIds: string[];
}

/**
 * 找出工程里引用了、但当前没有挂载的插件。
 *
 * 结果按「引用次数降序、id 升序」排列：引用最多的是用户最可能在找的那个。
 *
 * `loaded` 传**插件 id 的集合**（不是 def id）—— 因为判定的是插件级缺失，
 * 「同一插件有一半特效编译失败」属于该插件自己的 issue（见 `host.ts`），
 * 不是缺失。
 */
export function findMissingPlugins(project: Project, loaded: ReadonlySet<string>): MissingPluginRef[] {
  /** pluginId → { count, defIds } */
  const acc = new Map<string, { count: number; defIds: Set<string> }>();

  const bump = (pluginId: string, defId: string): void => {
    if (!pluginId || loaded.has(pluginId)) return;
    let rec = acc.get(pluginId);
    if (!rec) {
      rec = { count: 0, defIds: new Set() };
      acc.set(pluginId, rec);
    }
    rec.count++;
    rec.defIds.add(defId);
  };

  const use = (defId: unknown): void => {
    if (!isPluginDefId(defId)) return;
    const pluginId = pluginIdOf(defId);
    if (!pluginId) return;
    bump(pluginId, defId as string);
  };

  const tracks = Array.isArray(project?.tracks) ? project.tracks : [];
  for (const track of tracks) {
    const clips = Array.isArray(track?.clips) ? track.clips : [];
    for (const clip of clips) {
      if (!clip) continue;
      if (clip.kind === 'source') {
        const src = clip.source;
        if (src && src.type === 'algo') use(src.generator);
        /*
         * three 引用（`{ plugin, name }`）不走 `pluginIdOf` —— 它不是
         * `pluginId/localId` 形式的 def id，插件 id 直接躺在字段里。
         * 漏了这一条的表现：工程只引用了插件的 three 程序时，「缺少插件」
         * 的提示永远不出现，而画面是一块空白。
         */
        if (src && src.type === 'three' && src.ref) bump(src.ref.plugin, `${src.ref.plugin}/${src.ref.name}`);
      } else if (clip.kind === 'effect') {
        const chain = Array.isArray(clip.chain) ? clip.chain : [];
        for (const inst of chain) use(inst?.defId);
      }
    }
  }

  return [...acc.entries()]
    .map(([pluginId, rec]) => ({
      pluginId,
      count: rec.count,
      defIds: [...rec.defIds].sort(),
    }))
    .sort((a, b) => b.count - a.count || (a.pluginId < b.pluginId ? -1 : 1));
}
