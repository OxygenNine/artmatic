import { describe, expect, it } from 'vitest';
import { PLUGIN_API_VERSION, PLUGIN_FORMAT, validateManifest, type PluginIssueCode } from '../../src/plugins/manifest';

/**
 * Manifest v3 的面板 / 动作 / 激活三块。
 *
 * 版本语义只有一条：**能力按 `apiVersion` 解析，低于引入版本的声明静默忽略**。
 * v1 / v2 插件全部是项目发布前的测试产物，所以不为它们写兼容分支与报错文案。
 */

function good(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    format: PLUGIN_FORMAT,
    apiVersion: 3,
    id: 'demo',
    name: '演示插件',
    ...overrides,
  };
}

function goodPanel(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'browser',
    name: '字体',
    icon: 'type',
    kind: 'float',
    width: 360,
    height: 420,
    render: () => undefined,
    ...overrides,
  };
}

function goodAction(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'apply',
    name: '应用',
    params: [],
    run: () => undefined,
    ...overrides,
  };
}

/** 一个最小可用的生成器：让「只有被忽略的能力块」的插件不会撞上 `no-defs`。 */
function plainGenerator(): Record<string, unknown> {
  return {
    id: 'w',
    name: '波纹',
    params: [],
    fragment: 'void main(){}',
    setUniforms: () => undefined,
  };
}

function codes(result: ReturnType<typeof validateManifest>): PluginIssueCode[] {
  return (result.ok ? result.warnings : result.issues).map((i) => i.code);
}

describe('版本：能力按 apiVersion 解析', () => {
  it('只有面板的插件在 v3 下合法', () => {
    const r = validateManifest(good({ panels: [goodPanel()] }));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.manifest.panels).toHaveLength(1);
    expect(r.manifest.panels[0]!.kind).toBe('float');
    expect(r.manifest.effects).toEqual([]);
    expect(r.manifest.generators).toEqual([]);
  });

  it('只有动作的插件在 v3 下合法', () => {
    const r = validateManifest(good({ actions: [goodAction()] }));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.manifest.actions).toHaveLength(1);
  });

  it('只有 activate 的插件也合法（它确实做了事）', () => {
    expect(validateManifest(good({ activate: () => undefined })).ok).toBe(true);
  });

  it('写 v2 却声明 v3 能力：整块静默忽略，其余 def 照常挂载', () => {
    const r = validateManifest(
      good({
        apiVersion: 2,
        panels: [goodPanel()],
        actions: [goodAction()],
        activate: () => undefined,
        generators: [plainGenerator()],
      }),
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.manifest.panels).toEqual([]);
    expect(r.manifest.actions).toEqual([]);
    expect(r.manifest.activate).toBeNull();
    expect(r.manifest.generators).toHaveLength(1);
    // 静默 = 连警告都没有。
    expect(r.warnings).toEqual([]);
  });

  it('写 v1 却声明钩子：同样静默忽略', () => {
    const r = validateManifest(
      good({
        apiVersion: 1,
        typography: { hooks: [{ id: 'h', name: '钩子', phase: 'render', run: () => undefined }] },
        generators: [plainGenerator()],
      }),
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.manifest.hooks).toEqual([]);
    expect(r.manifest.generators).toHaveLength(1);
  });

  it('v1 / v2 老插件照常加载', () => {
    expect(validateManifest(good({ apiVersion: 1, generators: [plainGenerator()] })).ok).toBe(true);
  });

  it('宿主认识的最高版本就是 3', () => {
    expect(PLUGIN_API_VERSION).toBe(3);
    expect(validateManifest(good({ apiVersion: 4, panels: [goodPanel()] })).ok).toBe(false);
  });
});

describe('面板结构的逐项校验', () => {
  function withPanel(overrides: Record<string, unknown>) {
    return validateManifest(good({ panels: [goodPanel(overrides)] }));
  }

  it('不是对象 / 缺 id / id 非法', () => {
    expect(codes(validateManifest(good({ panels: [42] })))).toEqual(['bad-panel']);
    expect(codes(withPanel({ id: undefined }))).toEqual(['bad-panel']);
    expect(codes(withPanel({ id: 'Bad Id' }))).toEqual(['bad-panel']);
  });

  it('缺 name', () => {
    expect(codes(withPanel({ name: '' }))).toEqual(['bad-panel']);
  });

  it('kind 必须是三选一（缺省不猜）', () => {
    for (const bad of [undefined, 'window', 'FLOAT']) {
      expect(codes(withPanel({ kind: bad })), String(bad)).toEqual(['bad-panel']);
    }
    for (const ok of ['float', 'modal', 'dock']) {
      expect(validateManifest(good({ panels: [goodPanel({ kind: ok })] })).ok, ok).toBe(true);
    }
  });

  it('side 只收 left / right；缺省归一成 right（老插件不用改）', () => {
    expect(codes(withPanel({ side: 'Left' }))).toEqual(['bad-panel']);
    expect(codes(withPanel({ side: 'top' }))).toEqual(['bad-panel']);
    expect(codes(withPanel({ side: 1 }))).toEqual(['bad-panel']);

    const plain = validateManifest(good({ panels: [goodPanel({ kind: 'dock' })] }));
    expect(plain.ok).toBe(true);
    if (plain.ok) expect(plain.manifest.panels[0]!.side).toBe('right');

    const left = validateManifest(good({ panels: [goodPanel({ kind: 'dock', side: 'left' })] }));
    expect(left.ok).toBe(true);
    if (left.ok) expect(left.manifest.panels[0]!.side).toBe('left');
  });

  it('icon 只收 kebab-case；缺省合法（= 不进 Rail）', () => {
    expect(codes(withPanel({ icon: 'Type' }))).toEqual(['bad-panel']);
    expect(codes(withPanel({ icon: 'chevron_left' }))).toEqual(['bad-panel']);
    expect(validateManifest(good({ panels: [goodPanel({ icon: undefined })] })).ok).toBe(true);
  });

  it('width / height 给了就必须是 ≥24 的有限数', () => {
    expect(codes(withPanel({ width: 0 }))).toEqual(['bad-panel']);
    expect(codes(withPanel({ height: -10 }))).toEqual(['bad-panel']);
    expect(codes(withPanel({ width: Number.NaN }))).toEqual(['bad-panel']);
    expect(validateManifest(good({ panels: [goodPanel({ width: undefined, height: undefined })] })).ok).toBe(true);
  });

  it('render 必须是函数', () => {
    expect(codes(withPanel({ render: 'x' }))).toEqual(['bad-panel']);
  });

  it('面板 id 与特效 / 动作共用命名空间', () => {
    const dupEffect = validateManifest(
      good({
        effects: [
          {
            id: 'browser',
            name: '同名特效',
            params: [],
            shader: { fragment: 'void main(){}', setUniforms: () => undefined },
          },
        ],
        panels: [goodPanel()],
      }),
    );
    expect(codes(dupEffect)).toEqual(['duplicate-id']);

    const dupAction = validateManifest(good({ panels: [goodPanel()], actions: [goodAction({ id: 'browser' })] }));
    expect(codes(dupAction)).toEqual(['duplicate-id']);
  });

  it('panels 不是数组 → bad-list', () => {
    expect(codes(validateManifest(good({ panels: {} })))).toEqual(['bad-list']);
  });
});

describe('动作结构的逐项校验', () => {
  function withAction(overrides: Record<string, unknown>) {
    return validateManifest(good({ actions: [goodAction(overrides)] }));
  }

  it('id / name / run', () => {
    expect(codes(withAction({ id: 'Apply It' }))).toEqual(['bad-action']);
    expect(codes(withAction({ name: undefined }))).toEqual(['bad-action']);
    expect(codes(withAction({ run: 1 }))).toEqual(['bad-action']);
    expect(codes(validateManifest(good({ actions: [null] })))).toEqual(['bad-action']);
  });

  it('params 不是数组 / 键重复', () => {
    expect(codes(withAction({ params: {} }))).toEqual(['bad-action']);
    const p = { key: 'a', labelKey: 'A', type: 'text', defaultValue: '' };
    expect(codes(withAction({ params: [p, p] }))).toEqual(['bad-action']);
  });

  it('未知参数类型被拒（asset / bitmask 留到下一轮）', () => {
    expect(codes(withAction({ params: [{ key: 'a', labelKey: 'A', type: 'asset', defaultValue: '' }] }))).toEqual([
      'bad-action',
    ]);
  });

  it('range：min / max / step / defaultValue 缺一不可，默认值必须在区间内', () => {
    const base = { key: 'a', labelKey: 'A', type: 'range', min: 0, max: 1, step: 0.1, defaultValue: 0.5 };
    expect(validateManifest(good({ actions: [goodAction({ params: [base] })] })).ok).toBe(true);
    for (const override of [
      { min: undefined },
      { max: 0 },
      { step: 0 },
      { defaultValue: 2 },
      { defaultValue: -1 },
    ]) {
      const p = { ...base, ...override };
      expect(codes(withAction({ params: [p] })), JSON.stringify(override)).toEqual(['bad-action']);
    }
  });

  it('select：options 非空且每项有 value / labelKey，默认值必须是字符串', () => {
    const ok = { key: 'a', labelKey: 'A', type: 'select', defaultValue: 'x', options: [{ value: 'x', labelKey: 'X' }] };
    expect(validateManifest(good({ actions: [goodAction({ params: [ok] })] })).ok).toBe(true);
    expect(codes(withAction({ params: [{ ...ok, options: [] }] }))).toEqual(['bad-action']);
    expect(codes(withAction({ params: [{ ...ok, options: [{ value: 'x' }] }] }))).toEqual(['bad-action']);
    expect(codes(withAction({ params: [{ ...ok, defaultValue: 1 }] }))).toEqual(['bad-action']);
  });

  it('checkbox 的默认值只收 0 / 1', () => {
    const base = { key: 'a', labelKey: 'A', type: 'checkbox', defaultValue: 1 };
    expect(validateManifest(good({ actions: [goodAction({ params: [base] })] })).ok).toBe(true);
    expect(codes(withAction({ params: [{ ...base, defaultValue: 2 }] }))).toEqual(['bad-action']);
  });

  it('color / text 的默认值类型', () => {
    expect(codes(withAction({ params: [{ key: 'c', labelKey: 'C', type: 'color', defaultValue: 1 }] }))).toEqual([
      'bad-action',
    ]);
    expect(codes(withAction({ params: [{ key: 't', labelKey: 'T', type: 'text', defaultValue: 1 }] }))).toEqual([
      'bad-action',
    ]);
  });

  it('参数问题带具体路径', () => {
    const r = withAction({ params: [{ key: 'a', labelKey: 'A', type: 'nope' }] });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.issues[0]!.path).toBe('actions[0].params[0]');
  });
});

describe('activate', () => {
  it('非函数被拒', () => {
    expect(codes(validateManifest(good({ activate: 'x' })))).toEqual(['bad-activate']);
    expect(codes(validateManifest(good({ activate: {} })))).toEqual(['bad-activate']);
  });

  it('null / 缺省都当作没有', () => {
    const r = validateManifest(good({ activate: null, panels: [goodPanel()] }));
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.manifest.activate).toBeNull();
  });
});

describe('no-defs 放宽', () => {
  it('什么都不声明的插件仍然拒收', () => {
    expect(codes(validateManifest(good()))).toEqual(['no-defs']);
  });

  it('只声明面板 / 动作 / 激活任一项就不再是 no-defs', () => {
    expect(validateManifest(good({ panels: [goodPanel()] })).ok).toBe(true);
    expect(validateManifest(good({ actions: [goodAction()] })).ok).toBe(true);
    expect(validateManifest(good({ activate: () => undefined })).ok).toBe(true);
  });
});
