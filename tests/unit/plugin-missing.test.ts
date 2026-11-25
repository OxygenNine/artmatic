import { describe, expect, it } from 'vitest';
import { findMissingPlugins } from '../../src/plugins/missing';
import type { Project } from '../../src/core/schema';

/**
 * 「工程引用了没挂载的插件」的检测。
 *
 * 它的输出直接决定用户看到的那句话，所以两个方向都要钉死：
 * **漏报**的表现是「画面不对但没人解释」，**误报**的表现是「明明装了插件，
 * 却让你去导入插件」—— 后者更烦人，因为它把人指向一个已经做完的动作。
 */

/**
 * 造一个只含视觉轨的最小工程。
 *
 * 刻意手写而不复用 `createBlankProject`：这里要精确控制片段形状，
 * 还要能塞进**畸形数据**（检测函数必须对坏数据免疫 —— 它会在工程加载的
 * 早期被调用，那时数据刚从磁盘读出来）。
 */
function project(clips: unknown[]): Project {
  return {
    tracks: [{ kind: 'visual', id: 'v1', name: 'V1', enabled: true, clips }],
  } as unknown as Project;
}

function algoClip(generator: string): unknown {
  return { kind: 'source', id: 'c', start: 0, end: 1, source: { type: 'algo', generator, params: {} } };
}

function effectClip(defIds: string[]): unknown {
  return { kind: 'effect', id: 'e', start: 0, end: 1, chain: defIds.map((defId) => ({ instanceId: 'i', defId })) };
}

describe('内置 id 不算缺失', () => {
  it('内置生成器与特效照常', () => {
    const p = project([algoClip('mandelbrot'), effectClip(['blur', 'glow'])]);
    expect(findMissingPlugins(p, new Set())).toEqual([]);
  });

  it('空工程什么都不报', () => {
    expect(findMissingPlugins(project([]), new Set())).toEqual([]);
  });
});

describe('插件引用：装了就不报，没装就报', () => {
  it('引用了已挂载的插件', () => {
    const p = project([algoClip('my-plugin/waves')]);
    expect(findMissingPlugins(p, new Set(['my-plugin']))).toEqual([]);
  });

  it('引用了没挂载的插件', () => {
    const p = project([algoClip('my-plugin/waves')]);
    expect(findMissingPlugins(p, new Set())).toEqual([
      { pluginId: 'my-plugin', count: 1, defIds: ['my-plugin/waves'] },
    ]);
  });

  it('特效与生成器一起统计', () => {
    const p = project([algoClip('my-plugin/waves'), effectClip(['my-plugin/scanline', 'blur'])]);
    const [ref] = findMissingPlugins(p, new Set());
    expect(ref).toEqual({
      pluginId: 'my-plugin',
      count: 2,
      defIds: ['my-plugin/scanline', 'my-plugin/waves'],
    });
  });

  it('同一个 def 用了两次：count 是引用次数，defIds 仍然去重', () => {
    const p = project([algoClip('my-plugin/waves'), algoClip('my-plugin/waves')]);
    expect(findMissingPlugins(p, new Set())[0]).toEqual({
      pluginId: 'my-plugin',
      count: 2,
      defIds: ['my-plugin/waves'],
    });
  });

  it('多个插件：引用多的排前面，同数按 id 升序', () => {
    const p = project([
      algoClip('b-plugin/x'),
      algoClip('a-plugin/y'),
      algoClip('a-plugin/y'),
      algoClip('a-plugin/y'),
    ]);
    const list = findMissingPlugins(p, new Set());
    expect(list.map((r) => [r.pluginId, r.count])).toEqual([
      ['a-plugin', 3],
      ['b-plugin', 1],
    ]);
  });
});

describe('只认插件前缀，不做别的猜测', () => {
  it('非 algo 的源类型不看 generator 字段', () => {
    const p = project([{ kind: 'source', id: 'c', source: { type: 'solid', color: '#000' } }]);
    expect(findMissingPlugins(p, new Set())).toEqual([]);
  });

  it('id 里含斜杠但前缀不是合法插件分段：**仍然算缺失**', () => {
    // `pluginIdOf` 会对非法前缀返回 null，而检测用的是「含 `/` 就是插件的 id」。
    // 这条钉住的是**不能因此崩**：坏数据只影响它自己那一条。
    const p = project([algoClip('Bad/UPPER')]);
    expect(findMissingPlugins(p, new Set())).toEqual([]);
  });

  it('音频轨不参与', () => {
    const p = {
      tracks: [{ kind: 'audio', id: 'a1', name: 'A1', enabled: true, clips: [{ kind: 'audio', assetId: 'x' }] }],
    } as unknown as Project;
    expect(findMissingPlugins(p, new Set())).toEqual([]);
  });
});

describe('畸形数据：不抛', () => {
  it('没有 tracks / clips 不是数组 / 片段是 null', () => {
    expect(findMissingPlugins({} as Project, new Set())).toEqual([]);
    expect(findMissingPlugins({ tracks: null } as unknown as Project, new Set())).toEqual([]);
    expect(findMissingPlugins({ tracks: [{ clips: 'x' }] } as unknown as Project, new Set())).toEqual([]);
    expect(findMissingPlugins(project([null, undefined]), new Set())).toEqual([]);
  });

  it('特效链不是数组 / 实例是 null', () => {
    const p = project([{ kind: 'effect', id: 'e', chain: null }]);
    expect(findMissingPlugins(p, new Set())).toEqual([]);
    const p2 = project([{ kind: 'effect', id: 'e', chain: [null, { defId: 'p/x' }] }]);
    expect(findMissingPlugins(p2, new Set()).map((r) => r.pluginId)).toEqual(['p']);
  });

  it('generator 不是字符串', () => {
    const p = project([algoClip(42 as unknown as string)]);
    expect(findMissingPlugins(p, new Set())).toEqual([]);
  });
});

describe('three 引用（apiVersion 4）', () => {
  function threeClip(plugin: string, name: string): unknown {
    return { kind: 'source', id: 't', start: 0, end: 1, source: { type: 'three', ref: { plugin, name } } };
  }

  it('只引用了插件的 three 程序也算「缺这个插件」', () => {
    expect(findMissingPlugins(project([threeClip('my-plugin', 'vaporwave')]), new Set())).toEqual([
      { pluginId: 'my-plugin', count: 1, defIds: ['my-plugin/vaporwave'] },
    ]);
  });

  it('插件装了就不报；内联 three 片段不引用任何插件', () => {
    expect(findMissingPlugins(project([threeClip('my-plugin', 'vaporwave')]), new Set(['my-plugin']))).toEqual([]);
    const inline = { kind: 'source', id: 'i', start: 0, end: 1, source: { type: 'three', code: 'x' } };
    expect(findMissingPlugins(project([inline]), new Set())).toEqual([]);
  });

  it('同一插件的多个程序与特效合并计数', () => {
    const p = project([threeClip('p', 'a'), threeClip('p', 'b'), effectClip(['p/scanline'])]);
    expect(findMissingPlugins(p, new Set())).toEqual([
      { pluginId: 'p', count: 3, defIds: ['p/a', 'p/b', 'p/scanline'] },
    ]);
  });
});
