/**
 * picker-model.ts — 算法生成器选择器的**纯逻辑**：建造条目、搜索、排序。
 *
 * 与 `ui/effect-picker/picker-model.ts` / `ui/transition-picker/picker-model.ts`
 * 同构：全部是纯函数（翻译函数从外面传进来），可以脱离 DOM 单测。
 *
 * ## 生成器数量远少于特效，所以这里更简单
 *
 * 二十多个生成器不需要分类 / 标签 / 多选 —— 一个搜索框 + 一张缩略图网格就够。
 * 说明来自 `algos/catalog.ts`（内置）或 def 自带的 `desc`（插件），名称来自
 * def 的 `nameKey`（`Label`，经 `resolveLabel` 解析）。
 *
 * 生成器目录里没有「分类」这类数据，硬造筛选就是假选项 —— 与转场选择器同一条
 * 取舍：**没有的维度不出现**。
 */

import {
  ALGO_CATALOG,
  ALGO_GROUPS,
  ARCHIVE_ALGO_GROUP,
  algoGroupOf,
  type AlgoGroupId,
} from '../../algos/catalog';
import { listGenerators } from '../../algos/registry';
import { resolveLabel } from '../../i18n/label';
import { pinyinHaystack } from '../../i18n/pinyin';
import type { MessageKey } from '../../i18n/locales';
import type { GeneratorDef } from '../../algos/types';

export type Translate = (key: MessageKey) => string;

export type AlgoView = 'grid' | 'list';
export type AlgoSort = 'default' | 'name';

export const ALGO_SORTS: AlgoSort[] = ['default', 'name'];

/** 分组小标题的文案键。`AlgoGroupId` 是闭联合，索引结果仍是字面量键。 */
const GROUP_LABEL_KEY: Record<AlgoGroupId, MessageKey> = {
  math: 'insp.algoGroupMath',
  geometry: 'insp.algoGroupGeometry',
  physics: 'insp.algoGroupPhysics',
  special: 'insp.algoGroupSpecial',
  archive: 'insp.algoGroupArchive',
};

export interface AlgoItem {
  /** 生成器 id，也是工程里 `SourceClip.source.generator` 与缩略图文件名。 */
  id: string;
  /** 已翻译的显示名。 */
  name: string;
  /** 已翻译的一句话说明。插件没写说明时是空串（卡片据此不画那一行）。 */
  desc: string;
  /** 生成器类型：决定「有没有关键帧」等，列表视图里显示。 */
  kind: GeneratorDef['kind'];
  /** 浏览分组（小标题）。插件没有目录条目 → `DEFAULT_ALGO_GROUP`。 */
  group: AlgoGroupId;
  /**
   * 已归档：不再维护，只为老工程保留。**分组被强制成「归档」**，与它自己的
   * 浏览分组无关 —— 否则「物理模拟」里会混着一条不再改进的东西，而用户
   * 没有办法从卡片上分辨它。
   */
  archived: boolean;
  /** 提供者：`null` = 内置，否则是插件 id。 */
  pluginId: string | null;
  /** 搜索用的**预折叠**小写串：id + 名称 + 说明 + 拼音。 */
  haystack: string;
}

/** 建造全部条目。顺序 = 注册表顺序（内置在前、插件在后）。 */
export function buildItems(tr: Translate): AlgoItem[] {
  const out: AlgoItem[] = [];
  for (const e of listGenerators()) {
    const meta = ALGO_CATALOG[e.id];
    const name = resolveLabel(e.nameKey, tr);
    // 内置说明在 ALGO_CATALOG；插件写在 def 自己的 desc 上（没有就是空串）。
    const desc = meta ? tr(meta.descKey) : e.desc ? resolveLabel(e.desc, tr) : '';
    out.push({
      id: e.id,
      name,
      desc,
      kind: e.kind,
      group: e.archived ? ARCHIVE_ALGO_GROUP : algoGroupOf(e.id),
      archived: e.archived,
      pluginId: e.pluginId,
      // 拼音只补名字：说明是整句，逐句标拼音没人维护也没人这样搜。
      haystack: [e.id, name, desc, pinyinHaystack(name)].filter(Boolean).join(' ').toLowerCase(),
    });
  }
  return out;
}

export interface AlgoFilterState {
  query: string;
}

export const EMPTY_ALGO_FILTER: AlgoFilterState = { query: '' };

/** 只按关键词过滤（中文名 / 说明 / id）。空查询返回原数组的浅拷。 */
export function filterItems(items: readonly AlgoItem[], f: AlgoFilterState): AlgoItem[] {
  const q = f.query.trim().toLowerCase();
  if (!q) return items.slice();
  return items.filter((it) => it.haystack.includes(q));
}

/** 排序。`name` 走本地化比较（中文按拼音）；`default` = 注册表原生顺序。 */
export function sortItems(items: readonly AlgoItem[], sort: AlgoSort): AlgoItem[] {
  const out = items.slice();
  if (sort === 'name') {
    out.sort((a, b) => a.name.localeCompare(b.name, 'zh-Hans-CN') || a.id.localeCompare(b.id));
  }
  return out;
}

/** 已知 id → 显示名；未知 id → null（调用方自行退回显示 id）。 */
export function labelOf(items: readonly AlgoItem[], id: string): string | null {
  return items.find((it) => it.id === id)?.name ?? null;
}

/** 一组卡片 + 它的小标题。 */
export interface AlgoGroup {
  id: AlgoGroupId;
  label: string;
  items: AlgoItem[];
}

/**
 * 按浏览分组切小标题。
 *
 * 空组不出现（筛到只剩分形时不留三个空标题占位置）；组序恒为 `ALGO_GROUPS`
 * （数学 → 几何 → 物理 → 特殊），与排序无关 —— 排序只决定组内顺序。
 *
 * **归档组永远排最后**，且只有真的有条目时才出现。它不进 `ALGO_GROUPS`，
 * 因为它不是并列的浏览维度：那一个组的界面形态不同（默认折叠），语义也不同
 * （这里的东西不要用于新片段）。
 */
export function groupItems(items: readonly AlgoItem[], tr: Translate): AlgoGroup[] {
  const byId = new Map<AlgoGroupId, AlgoItem[]>();
  for (const it of items) {
    const list = byId.get(it.group);
    if (list) list.push(it);
    else byId.set(it.group, [it]);
  }
  const groups = ALGO_GROUPS.filter((g) => byId.has(g)).map((g) => ({
    id: g,
    label: tr(GROUP_LABEL_KEY[g]),
    items: byId.get(g)!,
  }));
  const archived = byId.get(ARCHIVE_ALGO_GROUP);
  if (archived) {
    groups.push({
      id: ARCHIVE_ALGO_GROUP,
      label: tr(GROUP_LABEL_KEY[ARCHIVE_ALGO_GROUP]),
      items: archived,
    });
  }
  return groups;
}
