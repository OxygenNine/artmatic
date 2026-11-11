import { describe, expect, it } from 'vitest';
import {
  manifestFromModule,
  validateManifest,
  PLUGIN_API_VERSION,
  PLUGIN_FORMAT,
  type PluginIssueCode,
} from '../../src/plugins/manifest';

/**
 * 插件清单的校验器。
 *
 * 它是**不可信输入的唯一入口**：插件由用户从磁盘导入，结构写错的表现是
 * 「检查器整块面板崩掉」或「参数拨了没反应」，两者都极难从现象回溯到原因。
 * 所以这里逐条钉住「什么被拒收、什么只警告、拒收之后能不能拿到可读的 code」。
 */

/** 一个结构完整的最小插件；各用例只改其中一处。 */
function good(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    format: PLUGIN_FORMAT,
    apiVersion: 1,
    id: 'demo',
    name: '演示插件',
    effects: [goodEffect()],
    ...overrides,
  };
}

function goodEffect(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'scanline',
    name: '扫描线',
    params: [
      { key: 'amount', labelKey: '强度', type: 'range', min: 0, max: 1, step: 0.01, defaultValue: 0.5 },
    ],
    shader: { fragment: 'void main() { outColor = vec4(1.0); }', setUniforms: () => {} },
    ...overrides,
  };
}

function goodGenerator(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'waves',
    name: '波纹',
    params: [],
    fragment: 'void main() { outColor = vec4(vUv, 0.0, 1.0); }',
    setUniforms: () => {},
    ...overrides,
  };
}

function codes(result: ReturnType<typeof validateManifest>): PluginIssueCode[] {
  return (result.ok ? result.warnings : result.issues).map((i) => i.code);
}

describe('形状：合法清单通过', () => {
  it('最小可用插件', () => {
    const r = validateManifest(good());
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.manifest.id).toBe('demo');
    expect(r.manifest.name).toBe('演示插件');
    expect(r.manifest.effects).toHaveLength(1);
    expect(r.manifest.generators).toEqual([]);
    expect(r.manifest.author).toBeNull();
    expect(r.manifest.license).toBeNull();
    expect(r.warnings).toEqual([]);
  });

  it('只有生成器的插件也合法', () => {
    const r = validateManifest(good({ effects: undefined, generators: [goodGenerator()] }));
    expect(r.ok).toBe(true);
  });

  it('缺省的可选字段被规范成 null（而不是 undefined / 空串）', () => {
    const r = validateManifest(good({ author: '', version: '   ', license: 'MIT' }));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.manifest.author).toBeNull();
    expect(r.manifest.version).toBeNull();
    expect(r.manifest.license).toBe('MIT');
  });

  it('name 支持两种标签形态：普通字符串与 { text }', () => {
    const a = validateManifest(good({ effects: [goodEffect({ name: '扫描线' })] }));
    const b = validateManifest(good({ effects: [goodEffect({ name: { text: '扫描线' } })] }));
    expect(a.ok && a.manifest.effects[0]!.name).toBe('扫描线');
    expect(b.ok && b.manifest.effects[0]!.name).toEqual({ text: '扫描线' });
  });

  it('未知的额外字段被忽略（前向兼容：插件多写点元数据不该被拒）', () => {
    const r = validateManifest(good({ homepage: 'https://x', future: { a: 1 } }));
    expect(r.ok).toBe(true);
  });
});

describe('头部字段：缺一即拒收', () => {
  it('不是对象', () => {
    for (const bad of [null, undefined, 42, 'x', []]) {
      const r = validateManifest(bad);
      expect(r.ok, JSON.stringify(bad)).toBe(false);
      expect(codes(r)).toEqual(['not-object']);
    }
  });

  it('format 不对', () => {
    const r = validateManifest(good({ format: 'something-else' }));
    expect(codes(r)).toEqual(['bad-format']);
  });

  it('apiVersion 超出宿主能力：拒收而不是尽力而为', () => {
    for (const bad of [0, -1, 1.5, PLUGIN_API_VERSION + 1, '1', null, undefined]) {
      const r = validateManifest(good({ apiVersion: bad }));
      expect(r.ok, JSON.stringify(bad)).toBe(false);
      expect(codes(r)).toEqual(['bad-api-version']);
    }
  });

  it('apiVersion 是已知的整数就通过', () => {
    expect(validateManifest(good({ apiVersion: 1 })).ok).toBe(true);
  });

  it('id 不符合命名空间分段规则', () => {
    for (const bad of ['', 'Demo', 'demo/plugin', '..', '.hidden', '-x', 'a b', 'x'.repeat(65), 42]) {
      const r = validateManifest(good({ id: bad }));
      expect(r.ok, JSON.stringify(bad)).toBe(false);
      expect(codes(r)).toEqual(['bad-id']);
    }
  });

  it('name 缺失或为空', () => {
    for (const bad of [undefined, '', '   ', 42]) {
      const r = validateManifest(good({ name: bad }));
      expect(r.ok, JSON.stringify(bad)).toBe(false);
      expect(codes(r)).toEqual(['bad-name']);
    }
  });

  it('effects / generators 不是数组', () => {
    expect(codes(validateManifest(good({ effects: {} })))).toEqual(['bad-list']);
    expect(codes(validateManifest(good({ effects: undefined, generators: 'x' })))).toEqual(['bad-list']);
  });

  it('两个列表都空：多半是字段名写错了，拒收', () => {
    expect(codes(validateManifest(good({ effects: [] })))).toEqual(['no-defs']);
  });
});

describe('条目：特效', () => {
  it('id 非法 / name 缺失', () => {
    expect(codes(validateManifest(good({ effects: [goodEffect({ id: 'Bad' })] })))).toEqual(['bad-def']);
    expect(codes(validateManifest(good({ effects: [goodEffect({ name: '' })] })))).toEqual(['bad-def']);
    expect(codes(validateManifest(good({ effects: [42] })))).toEqual(['bad-def']);
  });

  it('与生成器共用同一个 id 空间：重名会被拒', () => {
    const r = validateManifest(good({ effects: [goodEffect({ id: 'same' })], generators: [goodGenerator({ id: 'same' })] }));
    expect(r.ok).toBe(false);
    expect(codes(r)).toEqual(['duplicate-id']);
  });

  it('着色器缺 fragment 或 setUniforms', () => {
    expect(codes(validateManifest(good({ effects: [goodEffect({ shader: { setUniforms: () => {} } })] })))).toEqual([
      'bad-shader',
    ]);
    expect(codes(validateManifest(good({ effects: [goodEffect({ shader: { fragment: 'x' } })] })))).toEqual([
      'bad-shader',
    ]);
    expect(codes(validateManifest(good({ effects: [goodEffect({ shader: 'nope' })] })))).toEqual(['bad-shader']);
  });

  it('prePasses 的形状', () => {
    const bad1 = goodEffect({ shader: { fragment: 'x', setUniforms: () => {}, prePasses: {} } });
    const bad2 = goodEffect({ shader: { fragment: 'x', setUniforms: () => {}, prePasses: [{ fragment: '' }] } });
    const bad3 = goodEffect({ shader: { fragment: 'x', setUniforms: () => {}, prePasses: [{ fragment: 'x', feedback: 1 }] } });
    const ok = goodEffect({
      shader: { fragment: 'x', setUniforms: () => {}, prePasses: [{ fragment: 'y', linearFilter: true }] },
    });
    expect(codes(validateManifest(good({ effects: [bad1] })))).toEqual(['bad-shader']);
    expect(codes(validateManifest(good({ effects: [bad2] })))).toEqual(['bad-shader']);
    expect(codes(validateManifest(good({ effects: [bad3] })))).toEqual(['bad-shader']);
    expect(validateManifest(good({ effects: [ok] })).ok).toBe(true);
  });

  it('着色器的布尔开关必须是布尔', () => {
    for (const k of ['feedback', 'hdrFeedback', 'linearFilter', 'opaqueOutput']) {
      const bad = goodEffect({ shader: { fragment: 'x', setUniforms: () => {}, [k]: 1 } });
      expect(codes(validateManifest(good({ effects: [bad] }))), k).toEqual(['bad-shader']);
    }
  });
});

describe('条目：生成器', () => {
  it('缺 fragment / setUniforms', () => {
    expect(codes(validateManifest(good({ effects: undefined, generators: [goodGenerator({ fragment: '' })] })))).toEqual([
      'bad-shader',
    ]);
    expect(
      codes(validateManifest(good({ effects: undefined, generators: [goodGenerator({ setUniforms: 1 })] }))),
    ).toEqual(['bad-shader']);
  });

  it('合法生成器通过，且参数原样带出', () => {
    const r = validateManifest(
      good({
        effects: undefined,
        generators: [
          goodGenerator({
            params: [{ key: 'freq', labelKey: '频率', type: 'range', min: 0, max: 10, step: 0.1, defaultValue: 2 }],
          }),
        ],
      }),
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.manifest.generators[0]!.params).toHaveLength(1);
  });

  it('auxTextures：合法的原样带出（这是插件拿素材纹理的通路）', () => {
    const r = validateManifest(
      good({
        effects: undefined,
        generators: [
          goodGenerator({
            params: [{ key: 'srcAsset', labelKey: '图像', type: 'asset', defaultValue: '' }],
            auxTextures: [{ uniform: 'u_tex', kind: 'asset-image', assetParam: 'srcAsset' }],
          }),
        ],
      }),
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.manifest.generators[0]!.auxTextures).toEqual([
      { uniform: 'u_tex', kind: 'asset-image', assetParam: 'srcAsset' },
    ]);
  });

  it('auxTextures：结构坏 / kind 不认识 / assetParam 指错，一律拒收', () => {
    const assetOnly = [{ key: 'srcAsset', labelKey: '图像', type: 'asset', defaultValue: '' }];
    const gen = (aux: unknown, params: unknown[] = []) =>
      codes(
        validateManifest(
          good({ effects: undefined, generators: [goodGenerator({ params, auxTextures: aux })] }),
        ),
      );

    expect(gen('nope')).toEqual(['bad-aux']);
    // uniform 不是 u_ 开头：运行期 getUniformLocation 拿不到位置，静默不绑
    expect(gen([{ uniform: 'tex', kind: 'asset-image', assetParam: 'srcAsset' }], assetOnly)).toEqual(['bad-aux']);
    expect(gen([{ uniform: 'u_tex', kind: 'video', assetParam: 'srcAsset' }], assetOnly)).toEqual(['bad-aux']);
    /*
     * 指向一个 **range** 参数：只查「键存在」会放过它，而运行期拿 String(数值)
     * 当 assetId —— 这条 aux 永远缺席且不报错。
     */
    expect(
      gen(
        [{ uniform: 'u_tex', kind: 'asset-image', assetParam: 'freq' }],
        [...assetOnly, { key: 'freq', labelKey: '频率', type: 'range', min: 0, max: 1, step: 0.1, defaultValue: 0 }],
      ),
    ).toEqual(['bad-aux']);
    // 同一个 uniform 声明两次：后一项覆盖前一项，两条都白写
    expect(
      gen(
        [
          { uniform: 'u_tex', kind: 'asset-image', assetParam: 'srcAsset' },
          { uniform: 'u_tex', kind: 'logo-sdf', assetParam: 'srcAsset' },
        ],
        assetOnly,
      ),
    ).toEqual(['bad-aux']);
    // 字形图集是运行时自己画的，不需要 assetParam
    expect(gen([{ uniform: 'u_glyph', kind: 'glyph-atlas' }])).toEqual([]);
  });
});

describe('参数表：逐类型的结构不变量', () => {
  function withParam(param: unknown) {
    return validateManifest(good({ effects: [goodEffect({ params: [param] })] }));
  }

  it('未知类型：拒收（UI 会静默跳过它，等于参数丢失）', () => {
    expect(codes(withParam({ key: 'a', labelKey: 'x', type: 'slider', defaultValue: 1 }))).toEqual(['bad-param']);
  });

  it('缺 key 或 labelKey', () => {
    expect(codes(withParam({ labelKey: 'x', type: 'checkbox', defaultValue: 1 }))).toEqual(['bad-param']);
    expect(codes(withParam({ key: 'a', type: 'checkbox', defaultValue: 1 }))).toEqual(['bad-param']);
  });

  it('range 的数值字段缺一不可', () => {
    for (const missing of ['min', 'max', 'step', 'defaultValue']) {
      const p: Record<string, unknown> = { key: 'a', labelKey: 'x', type: 'range', min: 0, max: 1, step: 1, defaultValue: 0 };
      delete p[missing];
      expect(codes(withParam(p)), missing).toEqual(['bad-param']);
    }
    expect(codes(withParam({ key: 'a', labelKey: 'x', type: 'range', min: '0', max: 1, step: 1, defaultValue: 0 }))).toEqual(
      ['bad-param'],
    );
  });

  it('select 必须有非空 options，且每项有 value 与 labelKey', () => {
    expect(codes(withParam({ key: 'a', labelKey: 'x', type: 'select', defaultValue: 'a', options: [] }))).toEqual([
      'bad-param',
    ]);
    expect(
      codes(withParam({ key: 'a', labelKey: 'x', type: 'select', defaultValue: 'a', options: [{ value: 'a' }] })),
    ).toEqual(['bad-param']);
    expect(
      validateManifest(
        good({
          effects: [
            goodEffect({
              params: [{ key: 'a', labelKey: 'x', type: 'select', defaultValue: 'a', options: [{ value: 'a', labelKey: 'A' }] }],
            }),
          ],
        }),
      ).ok,
    ).toBe(true);
  });

  it('bitmask 的分组位数、样式与预设都要合法', () => {
    const base = { key: 'm', labelKey: '掩码', type: 'bitmask', bits: 18, defaultValue: 0 };
    expect(codes(withParam({ ...base, groups: [] }))).toEqual(['bad-param']);
    expect(codes(withParam({ ...base, groups: [{ labelKey: 'B', bits: 9, style: 'wrong' }] }))).toEqual(['bad-param']);
    expect(codes(withParam({ ...base, groups: [{ labelKey: 'B', bits: 9, style: 'count' }], presets: [{ value: 1 }] }))).toEqual(
      ['bad-param'],
    );
    expect(
      validateManifest(
        good({
          effects: [
            goodEffect({
              params: [
                {
                  ...base,
                  groups: [
                    { labelKey: 'B', bits: 9, style: 'count' },
                    { labelKey: 'S', bits: 9, style: 'count' },
                  ],
                  presets: [{ labelKey: '生命', value: 3 }],
                },
              ],
            }),
          ],
        }),
      ).ok,
    ).toBe(true);
  });

  it('asset 的默认值必须是 assetId 字符串；accept 只收 image', () => {
    expect(codes(withParam({ key: 'a', labelKey: '图', type: 'asset', defaultValue: 42 }))).toEqual(['bad-param']);
    expect(
      codes(withParam({ key: 'a', labelKey: '图', type: 'asset', defaultValue: '', accept: 'video' })),
    ).toEqual(['bad-param']);
    expect(withParam({ key: 'a', labelKey: '图', type: 'asset', defaultValue: '' }).ok).toBe(true);
  });

  it('pattern 的默认值必须是字符串（空串 = 无图案，合法）', () => {
    expect(codes(withParam({ key: 'p', labelKey: '图案', type: 'pattern', defaultValue: 42 }))).toEqual(['bad-param']);
    expect(validateManifest(good({ effects: [goodEffect({ params: [{ key: 'p', labelKey: '图案', type: 'pattern', defaultValue: '' }] })] })).ok).toBe(true);
  });

  it('参数表里键重复：拒收（两个控件会改同一个值）', () => {
    const dup = [
      { key: 'a', labelKey: 'x', type: 'checkbox', defaultValue: 1 },
      { key: 'a', labelKey: 'y', type: 'checkbox', defaultValue: 0 },
    ];
    expect(codes(validateManifest(good({ effects: [goodEffect({ params: dup })] })))).toEqual(['bad-param']);
  });

  it('params 不是数组', () => {
    expect(codes(validateManifest(good({ effects: [goodEffect({ params: {} })] })))).toEqual(['bad-param']);
  });

  it('visibleWhen 必须是函数', () => {
    expect(codes(withParam({ key: 'a', labelKey: 'x', type: 'checkbox', defaultValue: 1, visibleWhen: true }))).toEqual([
      'bad-param',
    ]);
    expect(validateManifest(good({ effects: [goodEffect({ params: [{ key: 'a', labelKey: 'x', type: 'checkbox', defaultValue: 1, visibleWhen: () => true }] })] })).ok).toBe(true);
  });

  it('问题定位带路径，能指到具体那一项', () => {
    const r = validateManifest(good({ effects: [goodEffect({ params: [{ key: 'a', labelKey: 'x', type: 'bogus' }] })] }));
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.issues[0]!.path).toBe('effects[0].params[0]');
  });
});

describe('展示元数据：不认识只警告，不拒收', () => {
  it('未知分类被丢掉，条目照常挂载', () => {
    const r = validateManifest(good({ effects: [goodEffect({ category: 'nope' })] }));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.manifest.effects[0]!.category).toBeNull();
    expect(codes(r)).toEqual(['unknown-meta']);
  });

  it('六选一的分类照常收下', () => {
    const r = validateManifest(good({ effects: [goodEffect({ category: 'glitch' })] }));
    expect(r.ok && r.manifest.effects[0]!.category).toBe('glitch');
  });

  it('未知标签被丢掉，已知的保留', () => {
    const r = validateManifest(good({ effects: [goodEffect({ tags: ['overlay', 'nope', 42] })] }));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.manifest.effects[0]!.tags).toEqual(['overlay']);
    expect(codes(r)).toEqual(['unknown-meta', 'unknown-meta']);
  });

  it('tags 不是数组：只警告', () => {
    const r = validateManifest(good({ effects: [goodEffect({ tags: 'overlay' })] }));
    expect(r.ok).toBe(true);
    expect(codes(r)).toEqual(['unknown-meta']);
  });
});

describe('manifestFromModule：两种导出形式', () => {
  it('具名导出 plugin', () => {
    const m = { plugin: { format: PLUGIN_FORMAT } };
    expect(manifestFromModule(m)).toBe(m.plugin);
  });

  it('默认导出', () => {
    const d = { format: PLUGIN_FORMAT };
    expect(manifestFromModule({ default: d })).toBe(d);
  });

  it('两个都没有 → null', () => {
    expect(manifestFromModule({})).toBeNull();
    expect(manifestFromModule({ something: 1 })).toBeNull();
    expect(manifestFromModule(null)).toBeNull();
    expect(manifestFromModule('x')).toBeNull();
  });

  it('具名导出优先于默认导出（两者都在时不该猜）', () => {
    const named = { n: 1 };
    const def = { d: 1 };
    expect(manifestFromModule({ plugin: named, default: def })).toBe(named);
  });
});
