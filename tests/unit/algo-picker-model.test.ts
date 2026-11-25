import { describe, expect, it } from 'vitest';
import {
  buildItems,
  filterItems,
  groupItems,
  labelOf,
  sortItems,
  type AlgoItem,
} from '../../src/ui/algo-picker/picker-model';
import { listGenerators } from '../../src/algos/registry';
import { ALGO_GROUPS, ARCHIVE_ALGO_GROUP } from '../../src/algos/catalog';
import type { MessageKey } from '../../src/i18n/locales';

/**
 * 算法生成器选择器的纯逻辑。翻译函数从外面传进来，所以这里能用一个**受控的假文案表**
 * 断言「搜索命中中文名 / 说明 / id」这几条 —— 不依赖真实语言表的内容（那份由
 * `algo-thumb-assets.test.ts` 与 `i18n.test.ts` 守）。
 */
const FAKE: Record<string, string> = {
  'algo.snowflake': '雪花',
  'algo.desc.snowflake': 'Reiter 六角雪花。',
  'algo.mandelbrot': '曼德博集合',
  'algo.desc.mandelbrot': '经典分形。',
};
const tr = (key: MessageKey): string => FAKE[key] ?? key;

const ALL = listGenerators().length;

describe('buildItems', () => {
  it('每个注册的生成器一条，id / 名称非空', () => {
    const items = buildItems(tr);
    expect(items.length).toBe(ALL);
    for (const it of items) {
      expect(it.id, 'id 不能为空').not.toBe('');
      expect(it.name, `${it.id} 缺显示名`).not.toBe('');
    }
  });

  it('名称取自 def.nameKey、说明取自 ALGO_CATALOG（都已翻译），不是 id 本身', () => {
    const items = buildItems(tr);
    const snow = items.find((i) => i.id === 'snowflake')!;
    expect(snow.name).toBe('雪花');
    expect(snow.desc).toBe('Reiter 六角雪花。');
    // 关键词表里没有的条目：名称退回键名（tr 的兜底），说明退回文案键 —— 都不是空串
    const other = items.find((i) => i.id !== 'snowflake')!;
    expect(other.name.length).toBeGreaterThan(0);
  });

  it('haystack 已折叠成小写，包含 id', () => {
    const items = buildItems(tr);
    for (const it of items) {
      expect(it.haystack).toBe(it.haystack.toLowerCase());
      expect(it.haystack).toContain(it.id.toLowerCase());
    }
    const snow = items.find((i) => i.id === 'snowflake')!;
    expect(snow.haystack).toContain('雪花');
    expect(snow.haystack).toContain('reiter');
  });
});

describe('filterItems', () => {
  const items = buildItems(tr);

  it('空查询返回全部（浅拷，不改原数组）', () => {
    const out = filterItems(items, { query: '   ' });
    expect(out.length).toBe(items.length);
    expect(out).not.toBe(items);
  });

  it('中文名、说明、id 都能命中', () => {
    expect(filterItems(items, { query: '雪花' }).map((i) => i.id)).toContain('snowflake');
    expect(filterItems(items, { query: 'reiter' }).map((i) => i.id)).toContain('snowflake');
    expect(filterItems(items, { query: 'mandelbrot' }).map((i) => i.id)).toEqual(['mandelbrot']);
  });

  it('大小写不敏感；搜不到就是空数组（不许悄悄退回全部）', () => {
    expect(filterItems(items, { query: 'SNOWFLAKE' }).map((i) => i.id)).toContain('snowflake');
    expect(filterItems(items, { query: 'zzz-no-such-thing' })).toEqual([]);
  });
});

describe('sortItems', () => {
  const items = buildItems(tr);

  it('default = 注册表原生顺序（浅拷，不改原数组）', () => {
    const out = sortItems(items, 'default');
    expect(out.map((i) => i.id)).toEqual(items.map((i) => i.id));
    expect(out).not.toBe(items);
  });

  it('name 排序是全量、确定性的重排', () => {
    const out = sortItems(items, 'name');
    expect(out.length).toBe(items.length);
    expect(new Set(out.map((i) => i.id)).size).toBe(items.length);
  });
});

describe('labelOf', () => {
  const items: AlgoItem[] = buildItems(tr);

  it('已知 id → 显示名；未知 id → null（调用方自行退回显示 id）', () => {
    expect(labelOf(items, 'snowflake')).toBe('雪花');
    expect(labelOf(items, 'no-such')).toBeNull();
  });
});

describe('groupItems', () => {
  const items = buildItems(tr);

  it('组序恒为 ALGO_GROUPS，归档单独收尾，且把全部条目**恰好一次**分完', () => {
    const groups = groupItems(items, tr);
    const ids = groups.map((g) => g.id);
    // 归档组不占 ALGO_GROUPS 的位置（它是「最后那一个、默认折叠的」）
    expect(ids[ids.length - 1]).toBe(ARCHIVE_ALGO_GROUP);
    expect(ids.slice(0, -1)).toEqual([...ALGO_GROUPS]);
    expect(groups.reduce((n, g) => n + g.items.length, 0)).toBe(items.length);
    for (const g of groups) {
      for (const it of g.items) expect(it.group).toBe(g.id);
    }
  });

  it('归档的生成器被强制分到归档组（与它自己的浏览分组无关）', () => {
    const groups = groupItems(items, tr);
    const archive = groups.find((g) => g.id === ARCHIVE_ALGO_GROUP)!;
    expect(archive.items.length).toBeGreaterThan(0);
    for (const it of archive.items) {
      expect(it.archived).toBe(true);
      // 黑洞（SDF）自己的分组是 physics，但落点在归档组
      expect(it.group).toBe(ARCHIVE_ALGO_GROUP);
    }
    // 归档组的标题来文案键，不是 id
    expect(archive.label).toBe('insp.algoGroupArchive');
  });

  it('归档条目不会再出现在任何普通分组里', () => {
    const groups = groupItems(items, tr);
    const archivedIds = new Set(items.filter((i) => i.archived).map((i) => i.id));
    for (const g of groups) {
      if (g.id === ARCHIVE_ALGO_GROUP) continue;
      for (const it of g.items) expect(archivedIds.has(it.id)).toBe(false);
    }
  });

  it('空组不出现（筛到只剩一条时不留下另外三个空标题）', () => {
    const one = items.filter((i) => i.id === 'mandelbrot');
    const groups = groupItems(one, tr);
    expect(groups.length).toBe(1);
    expect(groups[0]!.items.map((i) => i.id)).toEqual(['mandelbrot']);
  });


});
