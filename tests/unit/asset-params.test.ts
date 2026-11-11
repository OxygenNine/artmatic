import { afterEach, describe, expect, it } from 'vitest';
import {
  ASSET_PARAM_KEYS,
  assetParamKeys,
  clearAssetRefsInProject,
  sanitizeAssetParams,
  setAssetParamKeySource,
} from '../../src/core/asset-params';

/**
 * `asset` 参数的引用修复。
 *
 * 内置键是静态表，**插件键是运行期注入的**（`app-boot.ts` →
 * `algos/registry.ts::listAssetParamKeys`）。这条注入最容易漏的地方是
 * 「只在内置表里找」—— 症状是删了素材之后插件生成器的引用还挂着，
 * 而画面只是那张图一直缺席，不报错。
 */

afterEach(() => {
  setAssetParamKeySource(null);
});

function project(paramKey: string, value: number | string) {
  return {
    assets: { a1: { kind: 'image' }, v1: { kind: 'video' } },
    tracks: [
      {
        clips: [
          { kind: 'source', source: { type: 'algo', params: { [paramKey]: value } } },
        ],
      },
    ],
  };
}

describe('asset 参数键的来源', () => {
  it('缺省只有内置表', () => {
    expect(assetParamKeys()).toEqual([...ASSET_PARAM_KEYS]);
  });

  it('注入源并入，且每次调用重新求值（插件是后挂上来的）', () => {
    let keys: string[] = [];
    setAssetParamKeySource(() => keys);
    expect(assetParamKeys()).not.toContain('srcAsset');
    keys = ['srcAsset'];
    expect(assetParamKeys()).toContain('srcAsset');
  });

  it('注入源与内置键去重', () => {
    setAssetParamKeySource(() => ['logoAsset', 'srcAsset']);
    const keys = assetParamKeys();
    expect(keys.filter((k) => k === 'logoAsset')).toHaveLength(1);
    expect(keys).toContain('srcAsset');
  });
});

describe('引用修复覆盖注入键', () => {
  it('打开工程：悬空 / 非图片的插件引用置空串', () => {
    setAssetParamKeySource(() => ['srcAsset']);
    expect(sanitizeAssetParams(project('srcAsset', 'gone'))).toBe(1);

    const p = project('srcAsset', 'v1');
    expect(sanitizeAssetParams(p)).toBe(1);
    expect(p.tracks[0]!.clips[0]!.source!.params!.srcAsset).toBe('');

    const ok = project('srcAsset', 'a1');
    expect(sanitizeAssetParams(ok)).toBe(0);
    expect(ok.tracks[0]!.clips[0]!.source!.params!.srcAsset).toBe('a1');
  });

  it('删素材：插件引用被清掉，返回真的改了几处', () => {
    setAssetParamKeySource(() => ['srcAsset']);
    const p = project('srcAsset', 'a1');
    expect(clearAssetRefsInProject(p, 'a1')).toBe(1);
    expect(p.tracks[0]!.clips[0]!.source!.params!.srcAsset).toBe('');
  });

  it('没注入时插件的键不被当成素材引用（不误伤同名的普通字符串参数）', () => {
    const p = project('srcAsset', 'a1');
    expect(clearAssetRefsInProject(p, 'a1')).toBe(0);
    expect(p.tracks[0]!.clips[0]!.source!.params!.srcAsset).toBe('a1');
  });
});
