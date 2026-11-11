import { beforeEach, describe, expect, it } from 'vitest';
import { validateManifest, PLUGIN_API_VERSION } from '../../src/plugins/manifest';
import {
  listTypoHooks,
  registerPluginTypoHooks,
  resetTypoHookRegistry,
  runTypoHooks,
  typoHookFailures,
  unregisterPluginTypoHooks,
} from '../../src/typography/hook-registry';
import { createTextElement, createTypographyDocument } from '../../src/typography/document';
import { labelText } from '../../src/i18n/label';
import type { TypographyDocument } from '../../src/typography/document';

function baseManifest(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    format: 'artmatic-plugin',
    apiVersion: PLUGIN_API_VERSION,
    id: 'demo',
    name: 'Demo',
    effects: [],
    generators: [],
    ...over,
  };
}

function sampleDoc(): TypographyDocument {
  const doc = createTypographyDocument({ w: 640, h: 360 });
  doc.elements.push(createTextElement(doc.size, { text: 'hello' }));
  return doc;
}

describe('manifest: typography hooks', () => {
  it('hooks-only 插件合法（apiVersion 2）', () => {
    const r = validateManifest(
      baseManifest({
        typography: {
          hooks: [{ id: 'h1', name: 'Hook', phase: 'open', run: (d: unknown) => d }],
        },
      }),
    );
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.manifest.hooks).toHaveLength(1);
      expect(r.manifest.hooks[0]!.phase).toBe('open');
    }
  });

  it('带钩子却写 apiVersion 1：钩子整块静默忽略，插件按其它 def 加载', () => {
    const r = validateManifest(
      baseManifest({
        apiVersion: 1,
        typography: { hooks: [{ id: 'h1', name: 'H', phase: 'save', run: () => undefined }] },
        generators: [
          { id: 'w', name: 'W', params: [], fragment: 'void main(){}', setUniforms: () => undefined },
        ],
      }),
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.manifest.hooks).toEqual([]);
    expect(r.manifest.generators).toHaveLength(1);
    expect(r.warnings).toEqual([]);
  });

  it('阶段不认识 / run 不是函数 / id 重复都拒收', () => {
    const bad = validateManifest(
      baseManifest({
        typography: { hooks: [{ id: 'h1', name: 'H', phase: 'nope', run: () => undefined }] },
      }),
    );
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.issues[0]!.code).toBe('bad-hook');

    const noRun = validateManifest(
      baseManifest({
        typography: { hooks: [{ id: 'h1', name: 'H', phase: 'open' }] },
      }),
    );
    expect(noRun.ok).toBe(false);

    const dup = validateManifest(
      baseManifest({
        typography: {
          hooks: [
            { id: 'h1', name: 'H', phase: 'open', run: () => undefined },
            { id: 'h1', name: 'H2', phase: 'save', run: () => undefined },
          ],
        },
      }),
    );
    expect(dup.ok).toBe(false);
    if (!dup.ok) expect(dup.issues[0]!.code).toBe('duplicate-id');
  });

  it('typography 不是对象 / hooks 不是数组都拒收', () => {
    expect(validateManifest(baseManifest({ typography: 1 })).ok).toBe(false);
    expect(validateManifest(baseManifest({ typography: { hooks: 'x' } })).ok).toBe(false);
  });

  it('两个列表与钩子都空 → no-defs', () => {
    const r = validateManifest(baseManifest({ typography: { hooks: [] } }));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.issues[0]!.code).toBe('no-defs');
  });
});

describe('hook registry', () => {
  beforeEach(() => resetTypoHookRegistry());

  it('注册 / 按阶段查询 / 整插件替换 / 注销', () => {
    registerPluginTypoHooks('p', [
      { id: 'a', name: labelText('A'), phase: 'open', run: () => undefined },
      { id: 'b', name: labelText('B'), phase: 'render', run: () => undefined },
    ]);
    expect(listTypoHooks()).toHaveLength(2);
    expect(listTypoHooks('render')).toHaveLength(1);

    registerPluginTypoHooks('p', [{ id: 'c', name: labelText('C'), phase: 'save', run: () => undefined }]);
    expect(listTypoHooks().map((h) => h.key)).toEqual(['p/c']);

    unregisterPluginTypoHooks('p');
    expect(listTypoHooks()).toHaveLength(0);
  });

  it('钩子改写后的文档被采纳（applied 计数）', () => {
    registerPluginTypoHooks('p', [
      {
        id: 'a',
        name: labelText('A'),
        phase: 'open',
        run: (doc) => ({ ...doc, theme: 'dark' }),
      },
    ]);
    const r = runTypoHooks('open', sampleDoc(), { seed: 1 });
    expect(r.applied).toBe(1);
    expect(r.doc.theme).toBe('dark');
    expect(r.failures).toEqual([]);
  });

  it('输入是冻结的深拷贝：原地改会抛，且原文档不变', () => {
    const source = sampleDoc();
    registerPluginTypoHooks('p', [
      {
        id: 'a',
        name: labelText('A'),
        phase: 'open',
        run: (doc) => {
          doc.size.w = 1;
          return doc;
        },
      },
    ]);
    const r = runTypoHooks('open', source, { seed: 1 });
    expect(r.applied).toBe(0);
    expect(r.failures[0]!.detail).toMatch(/throw:/);
    expect(source.size.w).toBe(640);
    expect(typoHookFailures('p')).toHaveLength(1);
  });

  it('结果里出现未知键 → 整条拒绝（保留原文档）', () => {
    registerPluginTypoHooks('p', [
      {
        id: 'a',
        name: labelText('A'),
        phase: 'save',
        run: (doc) => ({ ...doc, bogus: true }),
      },
    ]);
    const r = runTypoHooks('save', sampleDoc(), { seed: 1 });
    expect(r.applied).toBe(0);
    expect(r.doc.size.w).toBe(640);
    expect(r.failures[0]!.detail).toContain('unknown-keys');
  });

  it('返回 Promise / 数组 / 数字都算失败', () => {
    registerPluginTypoHooks('p', [
      { id: 'a', name: labelText('A'), phase: 'open', run: async () => undefined },
      { id: 'b', name: labelText('B'), phase: 'open', run: () => [1] },
      { id: 'c', name: labelText('C'), phase: 'open', run: () => 3 },
    ]);
    const r = runTypoHooks('open', sampleDoc(), { seed: 1 });
    expect(r.applied).toBe(0);
    expect(r.failures).toHaveLength(3);
  });

  it('多个钩子按注册顺序串起来（后者看到前者的输出）', () => {
    registerPluginTypoHooks('a', [
      { id: 'x', name: labelText('X'), phase: 'render', run: (doc) => ({ ...doc, theme: 'one' }) },
    ]);
    registerPluginTypoHooks('b', [
      {
        id: 'y',
        name: labelText('Y'),
        phase: 'render',
        run: (doc) => ({ ...doc, theme: `${doc.theme}-two` }),
      },
    ]);
    const r = runTypoHooks('render', sampleDoc(), { seed: 1, frame: 3 });
    expect(r.applied).toBe(2);
    expect(r.doc.theme).toBe('one-two');
  });
});
