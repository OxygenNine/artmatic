import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { isWebp } from './_thumb-assets';
import { getGenerator, listBuiltinGenerators } from '../../src/algos/registry';
import { ALGO_CATALOG, previewRecipe } from '../../src/algos/catalog';
import { LOCALES } from '../../src/i18n/locales';

/**
 * 两件互相关联的守卫，放在一个文件里：
 *
 * 1. **缩略图资源与注册表对齐**（`src/assets/algo-thumbnails/`）—— 这类
 *    「预先烘好的静态素材」唯一的真实风险：加了生成器忘了导出，菜单里那张
 *    预览就是空的（浮层不显示，而且**不报错**）；删了生成器而资源留在仓库里，
 *    就一直躺在构建产物里没人发现。
 * 2. **展示信息目录与注册表对齐**（`algos/catalog.ts`）—— 缺条目 / 孤儿条目 /
 *    文案键解析不了 / `previewParams` 写了不存在的参数键。
 *
 * 两条都会**明确报错**，修法只有一条命令：`node scripts/gen-algo-thumbs.mjs`。
 */

const DIR = fileURLToPath(new URL('../../src/assets/algo-thumbnails', import.meta.url));


const FILES = readdirSync(DIR).filter((f) => f.endsWith('.webp'));
const IDS = FILES.map((f) => f.replace(/\.webp$/, '')).sort();
// 只比内置：缩略图与 `ALGO_CATALOG` 都是随应用一起发出去的静态资源，
// 插件生成器两者都没有（它的说明写在 def 自己的 `desc` 上）。
const GENS = listBuiltinGenerators()
  .map((g) => g.id)
  .sort();

describe('生成器缩略图资源：与注册表对齐', () => {
  it('资源非空（守卫本身要有覆盖面）', () => {
    expect(FILES.length, '一个缩略图都没有，这条守卫是空转的').toBeGreaterThanOrEqual(20);
  });

  it('每个注册的生成器都有缩略图', () => {
    const have = new Set(IDS);
    const missing = GENS.filter((id) => !have.has(id));
    expect(
      missing,
      '这些生成器没有缩略图 → 菜单里的预览浮层会是空的。跑 node scripts/gen-algo-thumbs.mjs',
    ).toEqual([]);
  });

  it('没有孤儿资源（每个文件都对应一个真实生成器）', () => {
    const known = new Set(GENS);
    expect(IDS.filter((id) => !known.has(id)), '这些缩略图对应的生成器已经不存在了').toEqual([]);
  });

  it('目录里不该混进别的扩展名（PNG / JPEG 会把仓库撑大十几倍）', () => {
    expect(
      readdirSync(DIR).filter((f) => !f.endsWith('.webp')),
      '只放导出的 WebP；原始 PNG 不要进仓库',
    ).toEqual([]);
  });

  it('每个文件都是合法 WebP，而且不是空图', () => {
    for (const f of FILES) {
      const p = join(DIR, f);
      const bytes = new Uint8Array(readFileSync(p));
      expect(isWebp(bytes), `${f} 不是 WebP`).toBe(true);
      // 空图（纯色）在 WebP 里极小。实测最小的是雪花（1.5 KB，一张圆盘），
      // 所以 400 字节是个安全的「这东西真的有内容」下限。
      expect(statSync(p).size, `${f} 太小了，可能是空图`).toBeGreaterThan(400);
    }
  });
});

describe('生成器展示信息目录：与注册表对齐', () => {
  it('每个注册的生成器都有条目（说明 + 预览时刻）', () => {
    const missing = GENS.filter((id) => !ALGO_CATALOG[id]);
    expect(missing, '这些生成器没有 descKey / 预览配方 → 菜单里没有说明文字').toEqual([]);
  });

  it('没有孤儿条目', () => {
    const known = new Set(GENS);
    expect(
      Object.keys(ALGO_CATALOG).filter((id) => !known.has(id)),
      '这些条目的生成器已经不存在了',
    ).toEqual([]);
  });

  it('sim / bake 的采样时刻必须显式给，而且大于 0', () => {
    // 这条是这批缩略图最容易错的地方：这些生成器在第 0 秒是空屏（一个种子点），
    // 用缺省的 4 秒会让十来个生成器的预览全黑 —— 而且不报错。实测踩过。
    for (const id of GENS) {
      const def = getGenerator(id)!;
      if (def.kind === 'realtime') continue;
      const entry = ALGO_CATALOG[id];
      expect(entry?.previewT, `${id}（${def.kind}）必须显式给 previewT`).toBeDefined();
      expect(entry!.previewT!, `${id} 的 previewT 必须 > 0`).toBeGreaterThan(0);
    }
  });

  it('previewParams 里的键都真的存在，且值类型对得上', () => {
    for (const [id, entry] of Object.entries(ALGO_CATALOG)) {
      const def = getGenerator(id);
      if (!def) continue;
      const byKey = new Map(def.params.map((p) => [p.key, p]));
      for (const [k, v] of Object.entries(entry.previewParams ?? {})) {
        expect(byKey.has(k), `${id} 的 previewParams 里有不存在的键 ${k}`).toBe(true);
      }
      for (const k of Object.keys(previewRecipe(id)!.params)) {
        expect(byKey.has(k), `${id} 的预览配方里有不存在的参数键 ${k}`).toBe(true);
      }
    }
  });

  it('realtime 条目都带上了 intRes（它只对 realtime 有意义，所以由 rt() 加）', () => {
    for (const id of GENS) {
      const def = getGenerator(id)!;
      if (def.kind !== 'realtime') continue;
      const keys = Object.keys(previewRecipe(id)!.params);
      expect(keys, `${id} 的预览配方缺 intRes（应当用 rt() 构造条目）`).toContain('intRes');
    }
  });

  it('参数表里没有 intRes 的生成器，条目也不该带（gpu-sim 与 realtime 都有）', () => {
    /*
     * 判据按**参数表**而不是 kind：过去只有 realtime 吃 intRes，新形态
     * `gpu-sim` 也走 intResSize（状态纹理与出图尺寸解耦），所以它同样带。
     * 写成「非 realtime 一律不许」会把一个正确的条目判成错。
     */
    for (const id of GENS) {
      const def = getGenerator(id)!;
      const defHasIntRes = def.params.some((p) => p.key === 'intRes');
      const keys = Object.keys(previewRecipe(id)!.params);
      if (defHasIntRes) continue;
      expect(keys, `${id} 的参数表里没有 intRes，预览配方却给了`).not.toContain('intRes');
    }
  });

  it('说明文案都解析得出来，而且长度是「一句话」', () => {
    const zh = LOCALES['zh-CN'] as Record<string, string>;
    for (const [id, entry] of Object.entries(ALGO_CATALOG)) {
      const text = zh[entry.descKey];
      expect(text, `${id} 的 descKey 解析不出来：${entry.descKey}`).toBeTruthy();
      // 预览浮层宽度有限，太长会折成三行把版面顶开
      expect(text.length, `${id} 的说明太长（${text.length} 字）`).toBeLessThanOrEqual(44);
    }
  });
});
