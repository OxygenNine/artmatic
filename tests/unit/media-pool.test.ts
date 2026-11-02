import { describe, expect, it } from 'vitest';
import { ProjectStore } from '../../src/core/project-store';
import { defaultProject, type Asset, type Project } from '../../src/core/schema';
import type { AssetStore } from '../../src/project/asset-store';
import {
  assetUsageSeconds,
  buildPoolItems,
  clipAssetId,
  clipForAsset,
  filterPoolItems,
  groupPool,
  insertAssetClip,
  kindOfFile,
  poolItemById,
  sortPoolItems,
  stillLength,
  type PoolItem,
  type PoolKind,
} from '../../src/ui/media-pool';
import { loadPoolPinyin, poolPinyinHaystack } from '../../src/ui/pool-pinyin';

/**
 * media-pool.ts 的守卫：列表怎么合成、怎么分组、以及「从素材建片段」的默认值。
 *
 * 素材仓用**替身**：它对外只是三个只读查询（`ids` / `input` / `get`），而真的
 * 那一份连着哈希与 OPFS —— 拿它测等于在测文件系统。工程侧用**真的 `ProjectStore`**：
 * 落点顺延、撑长工程时长、撤销栈都是它的行为，替身会把被测对象换掉。
 */

type PoolSource = Pick<AssetStore, 'ids' | 'input' | 'size'>;

interface FakeItem {
  kind: Asset['kind'];
  name: string;
  /** 不给 = 没有字节（generated 素材的形态）。 */
  bytes?: Uint8Array | null;
}

function fakeStore(items: Record<string, FakeItem>): PoolSource {
  return {
    ids: () => Object.keys(items),
    input: (id) => {
      const it = items[id];
      return it ? { kind: it.kind, name: it.name, originName: `${it.name}.bin` } : null;
    },
    size: (id) => items[id]?.bytes?.byteLength ?? null,
  };
}

const asset = (kind: Asset['kind'], name: string, extra: Partial<Asset> = {}): Asset => ({
  id: name,
  kind,
  name,
  ...extra,
});

const grid = defaultProject('t').beatGrid; // 120 BPM → 一拍 0.5s

function item(kind: PoolKind, id = `${kind}-1`, extra: Partial<PoolItem> = {}): PoolItem {
  return {
    id,
    kind,
    name: id,
    fileName: `${id}.bin`,
    durationSec: null,
    size: null,
    bytes: 8,
    addedAt: 0,
    modifiedAt: null,
    missing: false,
    ...extra,
  };
}

/* ------------------------------------------------------------------ 列表 */

describe('buildPoolItems：把工程表与素材仓合成一行', () => {
  it('工程里登记过、仓里也有字节：元信息齐、不算缺失', () => {
    const v = new Uint8Array([1, 2, 3, 4]);
    const items = buildPoolItems(
      { a: asset('video', 'take1.mp4', { durationSec: 3.5, size: { w: 1920, h: 1080 } }) },
      fakeStore({ a: { kind: 'video', name: 'take1.mp4', bytes: v } }),
    );
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      id: 'a',
      kind: 'video',
      name: 'take1.mp4',
      durationSec: 3.5,
      size: { w: 1920, h: 1080 },
      bytes: 4,
      missing: false,
    });
  });

  it('工程里登记过、仓里没有：missing，且不编造时长 / 尺寸', () => {
    // 打开工程时那个文件读不到，就是这一形态。
    const items = buildPoolItems({ a: asset('image', 'gone.png') }, fakeStore({}));
    expect(items[0]).toMatchObject({ missing: true, bytes: null, durationSec: null, size: null });
  });

  it('generated 素材（有登记、没有字节）不算缺失', () => {
    // 演示工程的节拍音频走这条路：字节是算出来的，随时可重建。
    const items = buildPoolItems(
      { g: asset('audio', 'demo', { durationSec: 24 }) },
      fakeStore({ g: { kind: 'audio', name: 'demo' } }),
    );
    expect(items[0]).toMatchObject({ missing: false, bytes: null, durationSec: 24 });
  });

  it('仓里有、工程还没登记（导入到一半）也列出来，不凭空少一条', () => {
    const items = buildPoolItems({}, fakeStore({ x: { kind: 'image', name: 'half.png', bytes: new Uint8Array([7]) } }));
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ id: 'x', kind: 'image', name: 'half.png', missing: false });
  });


});

describe('kindOfFile', () => {
  it('MIME 说了算', () => {
    expect(kindOfFile('whatever.bin', 'video/mp4')).toBe('video');
    expect(kindOfFile('whatever.bin', 'image/png')).toBe('image');
    expect(kindOfFile('whatever.bin', 'audio/wav')).toBe('audio');
  });

  it('MIME 空（拖进来的文件常常没有 type）时退回扩展名，且大小写不敏感', () => {
    expect(kindOfFile('take 02.MP4', '')).toBe('video');
    expect(kindOfFile('海报.PNG', '')).toBe('image');
    expect(kindOfFile('song.flac', '')).toBe('audio');
  });

  it('认不出就是 null —— 调用方据此提示，而不是静默丢掉', () => {
    expect(kindOfFile('readme.txt', 'text/plain')).toBeNull();
    expect(kindOfFile('archive.zip', '')).toBeNull();
    expect(kindOfFile('no-extension', '')).toBeNull();
  });

  it('不认识的名字里也带着点号时不会误判', () => {
    // 「我的视频.v2」这种名字：最后一段不是已知扩展名
    expect(kindOfFile('我的视频.v2', '')).toBeNull();
  });
});

describe('groupPool', () => {
  it('顺序固定为 视频 → 图片 → 音频，空组不出现', () => {
    const groups = groupPool([item('audio', 'a'), item('video', 'v'), item('image', 'i')]);
    expect(groups.map((g) => g.kind)).toEqual(['video', 'image', 'audio']);
  });

  it('只有一类时只返回那一组', () => {
    expect(groupPool([item('image')]).map((g) => g.kind)).toEqual(['image']);
  });

  it('全空时返回空数组（面板据此显示空状态）', () => {
    expect(groupPool([])).toEqual([]);
  });
});

describe('poolItemById', () => {
  it('拖拽落点靠 id 重新解析成条目（拿到的必须是当下的事实）', () => {
    const declared = { a: asset('image', 'a.png') };
    const store = fakeStore({ a: { kind: 'image', name: 'a.png', bytes: new Uint8Array([1, 2]) } });
    expect(poolItemById(declared, store, 'a')).toMatchObject({
      id: 'a',
      kind: 'image',
      name: 'a.png',
      missing: false,
    });
  });

  it('id 不在表里（拖拽期间被删了）返回 null', () => {
    expect(poolItemById({}, fakeStore({}), 'gone')).toBeNull();
  });
});

/* ------------------------------------------------------------------ 建片段 */

describe('clipForAsset', () => {
  it('图片：contain + image 源，长度 4 拍', () => {
    const c = clipForAsset(item('image'), 1, grid)!;
    expect(c.kind).toBe('source');
    if (c.kind !== 'source') return;
    expect(c.source).toEqual({ type: 'image', assetId: 'image-1' });
    expect(c.fit).toBe('contain');
    expect(c.end - c.start).toBeCloseTo(2, 9); // 4 拍 @120BPM
  });

  it('视频：cover + video 源，长度取素材时长', () => {
    const c = clipForAsset(item('video', 'v1', { durationSec: 3.5 }), 0, grid)!;
    if (c.kind !== 'source') throw new Error('应当是 source');
    expect(c.source).toEqual({ type: 'video', assetId: 'v1', srcIn: 0, speed: 1 });
    expect(c.fit).toBe('cover');
    expect(c.end).toBeCloseTo(3.5, 9);
  });

  it('音频：不带画面，srcIn 从 0 开始', () => {
    const c = clipForAsset(item('audio', 'a1', { durationSec: 12 }), 2, grid)!;
    expect(c.kind).toBe('audio');
    if (c.kind !== 'audio') return;
    expect(c.srcIn).toBe(0);
    expect([c.start, c.end]).toEqual([2, 14]);
  });


  it('起点为负时钳到 0', () => {
    expect(clipForAsset(item('image'), -5, grid)!.start).toBe(0);
  });
});

describe('stillLength', () => {
  it('4 拍（120 BPM → 2s）', () => {
    expect(stillLength({ bpm: 120, offset: 0, beatsPerBar: 4 })).toBeCloseTo(2, 9);
  });

  it('极快的拍也不会短到看不见（下限 0.5s）', () => {
    expect(stillLength({ bpm: 1200, offset: 0, beatsPerBar: 4 })).toBe(0.5);
  });
});

/* ------------------------------------------------------------------ 插入 */

function projectWith(...kinds: ('visual' | 'audio')[]): Project {
  const p = defaultProject('t');
  p.tracks = kinds.map((kind, i) =>
    kind === 'visual'
      ? { kind, id: `v${i}`, name: `V${i}`, enabled: true, clips: [] }
      : { kind, id: `a${i}`, name: `A${i}`, enabled: true, clips: [], bus: 'master' },
  );
  return p;
}

describe('insertAssetClip', () => {
  it('优先落到主选中片段所在的那条轨上', () => {
    const store = new ProjectStore(projectWith('visual', 'visual'));
    const id = insertAssetClip(store, item('image'), { at: 1, grid, preferredTrackId: 'v1' })!;
    expect(id).toBeTruthy();
    expect(store.findClip(id)!.track.id).toBe('v1');
  });

  it('优先轨装不下（音频素材 vs 视觉轨）时退到第一条装得下的轨', () => {
    const store = new ProjectStore(projectWith('visual', 'audio'));
    const id = insertAssetClip(store, item('audio'), { at: 0, grid, preferredTrackId: 'v0' })!;
    expect(store.findClip(id)!.track.id).toBe('a1');
  });

  it('一条装得下的轨都没有时补一条，并且片段真的落到里面', () => {
    const store = new ProjectStore(projectWith('audio'));
    const id = insertAssetClip(store, item('video'), { at: 0, grid })!;
    expect(store.project.tracks).toHaveLength(2);
    expect(store.project.tracks[1]!.kind).toBe('visual');
    expect(store.findClip(id)!.track.id).toBe(store.project.tracks[1]!.id);
  });

  it('落点被占时顺延到邻居末尾（与「新建片段」同一条落点规则）', () => {
    const store = new ProjectStore(projectWith('visual'));
    store.addClip('v0', { ...clipForAsset(item('image', 'first'), 0, grid)! });
    const id = insertAssetClip(store, item('image', 'second'), { at: 0.5, grid })!;
    const clip = store.findClip(id)!.clip;
    // 第一条占了 [0, 2)，第二条从 2 起（addClip 会带一个 1e-6 的偏移避开贴边）
    expect(clip.start).toBeCloseTo(2, 4);
  });

  it('缺字节的素材不插、也不改动工程', () => {
    const store = new ProjectStore(projectWith('visual'));
    const before = store.version;
    expect(insertAssetClip(store, item('image', 'x', { missing: true }), { at: 0, grid })).toBeNull();
    expect(store.version).toBe(before);
    expect(store.project.tracks[0]!.clips).toHaveLength(0);
  });
});

/* ------------------------------------------------------------ 搜索 / 排序 */

const pool = [
  item('video', 'a', { name: '片头镜头', fileName: 'intro-take-01.mp4', bytes: 900 }),
  item('image', 'b', { name: 'cover', fileName: '封面最终.png', bytes: 100 }),
  item('audio', 'c', { name: 'bgm', fileName: 'bgm-v2.wav', bytes: 400 }),
];

describe('filterPoolItems', () => {
  it('拼音：媒体池用的是按需加载的转换器（中文文件名也能按拼音命中）', async () => {
    await loadPoolPinyin();
    const items = [item('video', 'v', { name: '片头镜头', fileName: '片头镜头.mp4' })];
    // 全拼 / 首字母
    expect(filterPoolItems(items, 'piantou', poolPinyinHaystack).map((i) => i.id)).toEqual(['v']);
    expect(filterPoolItems(items, 'pt', poolPinyinHaystack).map((i) => i.id)).toEqual(['v']);
    /*
     * 没注入转换器（= 手写表那条路）时这条名字搜不到 —— 这正说明「按需加载的库」
     * 不是装饰：素材名是用户数据，手写表覆盖不了。
     */
    expect(filterPoolItems(items, 'piantou')).toEqual([]);
  });

  it('空查询返回全部，且保持原顺序', () => {
    expect(filterPoolItems(pool, '   ').map((i) => i.id)).toEqual(['a', 'b', 'c']);
  });

  it('包含匹配：展示名与原始文件名都算命中', () => {
    expect(filterPoolItems(pool, 'bgm').map((i) => i.id)).toEqual(['c']);
    // 展示名是 cover，但用户记得的是文件名
    expect(filterPoolItems(pool, '封面').map((i) => i.id)).toEqual(['b']);
  });

  it('子序列匹配：打漏分隔符也能命中文件名', () => {
    // `introtake` → `intro-take-01.mp4`
    expect(filterPoolItems(pool, 'introtake').map((i) => i.id)).toEqual(['a']);
  });

  it('拼音命中（走 i18n 的手写表；表里没有的名字退化成另外两条）', () => {
    const withPinyin = [item('image', 'd', { name: '像素化', fileName: 'x.png' })];
    expect(filterPoolItems(withPinyin, 'xiangsu').map((i) => i.id)).toEqual(['d']);
    expect(filterPoolItems(withPinyin, 'xsh').map((i) => i.id)).toEqual(['d']);
  });

  it('单字符只做包含，不启用子序列（否则「搜 a」会命中一大片）', () => {
    expect(filterPoolItems(pool, 'z')).toEqual([]);
  });
});

describe('sortPoolItems', () => {
  it('默认（added）不动顺序 —— 它就是导入顺序', () => {
    expect(sortPoolItems(pool, 'added').map((i) => i.id)).toEqual(['a', 'b', 'c']);
  });

  it('名称按本地化比较（中文按拼音排）', () => {
    const items = [
      item('image', '1', { name: '波' }),
      item('image', '2', { name: '阿' }),
      item('image', '3', { name: '册' }),
    ];
    expect(sortPoolItems(items, 'name').map((i) => i.name)).toEqual(['阿', '波', '册']);
  });

  it('体积：大的在前，未知（null）排最后', () => {
    const items = [...pool, item('image', 'z', { name: 'generated', bytes: null })];
    expect(sortPoolItems(items, 'size').map((i) => i.id)).toEqual(['a', 'c', 'b', 'z']);
  });

  it('修改日期：新的在前；mtime 未知时退回导入时间', () => {
    const items = [
      item('image', 'old', { modifiedAt: 1000, addedAt: 1 }),
      item('image', 'new', { modifiedAt: 5000, addedAt: 2 }),
      item('image', 'unknown', { modifiedAt: null, addedAt: 9000 }),
      item('image', 'nothing', { modifiedAt: null, addedAt: null }),
    ];
    expect(sortPoolItems(items, 'modified').map((i) => i.id)).toEqual([
      'unknown',
      'new',
      'old',
      'nothing',
    ]);
  });

  it('时间轴时长：按使用总秒数降序', () => {
    const used = new Map([
      ['b', 12],
      ['c', 3],
    ]);
    expect(sortPoolItems(pool, 'duration', used).map((i) => i.id)).toEqual(['b', 'c', 'a']);
  });
});

describe('assetUsageSeconds / clipAssetId', () => {
  it('同一素材被多个片段引用时时长累加', () => {
    const project = projectWith('visual', 'audio');
    const store = new ProjectStore(project);
    store.addClip('v0', { ...clipForAsset(item('image', 'pic'), 0, grid)! });
    store.addClip('v0', { ...clipForAsset(item('image', 'pic'), 10, grid)! });
    store.addClip('a1', { ...clipForAsset(item('audio', 'song', { durationSec: 6 }), 0, grid)! });

    const usage = assetUsageSeconds(store.project);
    // 两张图各 2 秒（4 拍 @120BPM）
    expect(usage.get('pic')).toBeCloseTo(4, 9);
    expect(usage.get('song')).toBeCloseTo(6, 9);
  });

  it('不引用素材的片段（特效）返回 null，不进统计', () => {
    const project = projectWith('visual');
    project.tracks[0]!.clips.push({
      kind: 'effect',
      id: 'fx',
      start: 0,
      end: 1,
      label: 'fx',
      fadeSec: 0,
      curves: {},
      chain: [],
      affectDepth: 1,
    } as never);
    expect(clipAssetId(project.tracks[0]!.clips[0]!)).toBeNull();
    expect(assetUsageSeconds(project).size).toBe(0);
  });
});
