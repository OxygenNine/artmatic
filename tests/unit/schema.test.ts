import { describe, expect, it } from 'vitest';
import {
  cloneProject,
  defaultKeySettings,
  defaultProject,
  identityQuad,
  migrateProject,
  migrationVersions,
  newId,
  SCHEMA_VERSION,
  validateProject,
  type QuadCorners,
} from '../../src/core/schema';
import { resolveThemeColor } from '../../src/typography/theme';
import { createTextElement, createTypographyDocument } from '../../src/typography/document';

describe('validateProject', () => {
  it('defaultProject 通过校验', () => {
    expect(() => validateProject(defaultProject('ok'))).not.toThrow();
  });

  it('缺字段 / 非法值被拒', () => {
    const p = defaultProject('bad');
    (p as { fps: number }).fps = 0;
    expect(() => validateProject(p)).toThrow(/fps/);
  });

  it('未知轨道类型被拒', () => {
    const p = defaultProject('bad');
    (p.tracks as unknown[]).push({ kind: 'weird', id: 'x', clips: [] });
    expect(() => validateProject(p)).toThrow(/轨道类型/);
  });

  it('音频轨里放视觉片段被拒', () => {
    const p = defaultProject('bad');
    p.tracks.push({
      kind: 'audio', id: newId(), name: 'A1', enabled: true, bus: 'master',
      clips: [{
        kind: 'source', id: newId(), start: 0, end: 1, label: '', fadeSec: 0,
        curves: {}, source: { type: 'solid', color: '#000' }, blend: 'normal',
        opacity: 1, transform: { x: 0.5, y: 0.5, sx: 1, sy: 1, rot: 0 }, fit: 'contain',
      }],
    } as never);
    expect(() => validateProject(p)).toThrow(/音频轨/);
  });

  it('overlapBehavior 三值之外被拒', () => {
    const p = defaultProject('bad');
    (p as { overlapBehavior: string }).overlapBehavior = 'merge';
    expect(() => validateProject(p)).toThrow(/overlapBehavior/);
  });
});

describe('validateProject：历史遗留的「主题色引用」', () => {
  /*
   * 取色卡对**所有**颜色入口都提供主题色（`@accent1`），但只有排版文档会在
   * 渲染时解析引用。算法参数 / 特效参数 / 纯色片段的颜色直接进
   * `hexToRgba()` —— 引用在那里算坏颜色，回退成**品红**。
   *
   * 用户侧的形态：在检查器里挑一个主题色，画面整片变品红，而参数表里存的
   * 是一串 `@accent1`。新数据由检查器写入时解析，老数据由 validateProject 补。
   */
  const solid = (color: string) =>
    ({
      kind: 'source',
      id: newId(),
      start: 0,
      end: 1,
      label: '',
      fadeSec: 0,
      curves: {},
      source: { type: 'solid', color },
      blend: 'normal',
      opacity: 1,
      transform: { x: 0.5, y: 0.5, sx: 1, sy: 1, rot: 0 },
      fit: 'contain',
    }) as never;

  const algo = (params: Record<string, unknown>) =>
    ({
      kind: 'source',
      id: newId(),
      start: 0,
      end: 1,
      label: '',
      fadeSec: 0,
      curves: {},
      source: { type: 'algo', generator: 'game-of-life', params },
      blend: 'normal',
      opacity: 1,
      transform: { x: 0.5, y: 0.5, sx: 1, sy: 1, rot: 0 },
      fit: 'contain',
    }) as never;

  const effect = (values: Record<string, unknown>) =>
    ({
      kind: 'effect',
      id: newId(),
      start: 0,
      end: 1,
      label: '',
      fadeSec: 0,
      curves: {},
      chain: [{ instanceId: newId(), defId: 'duotone', enabled: true, values }],
    }) as never;

  it('纯色 / 算法参数 / 特效参数里的 @slot 被解析成裸 hex', () => {
    const p = defaultProject('refs');
    p.tracks = [
      {
        kind: 'visual',
        id: 'v1',
        name: 'V1',
        enabled: true,
        clips: [solid('@accent1'), algo({ colorLive: '@accent1.d25', speed: 1, colorBg: '#102030' }), effect({ tint: '@lt1', amount: 0.5 })],
      },
    ] as never;

    validateProject(p);
    const clips = (p.tracks[0] as unknown as { clips: unknown[] }).clips as {
      source?: { color?: string; params?: Record<string, unknown> };
      chain?: { values: Record<string, unknown> }[];
    }[];

    expect(clips[0]!.source!.color, '纯色片段里的引用必须解析成 hex').toBe('#156082');
    const params = clips[1]!.source!.params!;
    expect(String(params.colorLive)).toMatch(/^#[0-9a-f]{6}$/i);
    // 变体（`.d25`）也要解析对：它比原色暗，不是把整个引用当普通 hex 丢掉。
    expect(params.colorLive).toBe(resolveThemeColor('@accent1.d25'));
    expect(params.colorLive).not.toBe('#156082');
    // 非颜色参数（数字 / 裸 hex）一个都不能被动。
    expect(params.speed).toBe(1);
    expect(params.colorBg).toBe('#102030');
    expect(clips[2]!.chain![0]!.values.tint).toBe('#ffffff');
    expect(clips[2]!.chain![0]!.values.amount).toBe(0.5);
  });

  it('排版文档里的引用一个字都不能动（那是换配色方案的唯一依据）', () => {
    const doc = createTypographyDocument();
    const el = createTextElement(doc.size, { text: 'hi' });
    el.style.color = '@accent1';
    doc.elements.push(el);

    const p = defaultProject('refs-typo');
    p.tracks = [
      {
        kind: 'visual',
        id: 'v1',
        name: 'V1',
        enabled: true,
        clips: [
          {
            kind: 'source',
            id: newId(),
            start: 0,
            end: 1,
            label: '',
            fadeSec: 0,
            curves: {},
            source: { type: 'text', doc },
            blend: 'normal',
            opacity: 1,
            transform: { x: 0.5, y: 0.5, sx: 1, sy: 1, rot: 0 },
            fit: 'contain',
          },
        ],
      },
    ] as never;

    validateProject(p);
    const src = ((p.tracks[0] as unknown as { clips: { source: { doc: typeof doc } }[] }).clips[0]!).source;
    const first = src.doc.elements[0]!;
    expect(first.kind).toBe('text');
    expect(first.kind === 'text' ? first.style.color : null).toBe('@accent1');
  });

  it('解析不了的值原样保留（自定义文本参数里手打的 @foo）', () => {
    const p = defaultProject('refs-keep');
    p.tracks = [
      {
        kind: 'visual',
        id: 'v1',
        name: 'V1',
        enabled: true,
        clips: [algo({ labelCustom: '@foo', colorLive: '#123456' })],
      },
    ] as never;

    validateProject(p);
    const params = ((p.tracks[0] as { clips: { source: { params: Record<string, unknown> } }[] }).clips[0]!).source
      .params;
    expect(params.labelCustom).toBe('@foo');
    expect(params.colorLive).toBe('#123456');
  });
});

describe('migrateProject', () => {
  it('迁移链连续：1..SCHEMA_VERSION-1 一步不缺、一步不跳', () => {
    /*
     * `MIGRATIONS` 是「vN → vN+1」的链条，`migrateProject` 靠每一条把版本抬上去前进。
     * 漏一条的表现是某个版本的工程**打不开**（`missingMigration`）；跳号会让中间那几版
     * 永远升不上来。这里只钉链条形状，不看任何迁移的内容。
     *
     * 顺带一提：这条用例是唯一允许「知道」当前版本数值的地方 —— 它从 `SCHEMA_VERSION`
     * 算期望值，所以抬版本时不需要改它。
     */
    const expected = Array.from({ length: SCHEMA_VERSION - 1 }, (_, i) => i + 1);
    expect(migrationVersions()).toEqual(expected);
  });

  it('从最老版本一路升到当前（迁移写漏 schemaVersion 会卡死，不是报错）', () => {
    const p = defaultProject('old');
    p.schemaVersion = 1;
    const out = migrateProject(JSON.parse(JSON.stringify(p)));
    expect(out.schemaVersion).toBe(SCHEMA_VERSION);
  });

  it('当前版本原样通过', () => {
    const p = defaultProject('cur');
    const out = migrateProject(JSON.parse(JSON.stringify(p)));
    expect(out.schemaVersion).toBe(SCHEMA_VERSION);
    expect(out.name).toBe('cur');
  });

  it('拒绝更高版本（防静默损坏）', () => {
    const p = defaultProject('future');
    p.schemaVersion = SCHEMA_VERSION + 1;
    expect(() => migrateProject(JSON.parse(JSON.stringify(p)))).toThrow(/高于/);
  });

  it('缺 schemaVersion 被拒', () => {
    expect(() => migrateProject({})).toThrow(/schemaVersion/);
  });

  it('v1 → v2：形状不合法的手改 doc 被补齐成合法空文档', () => {
    // v1 里 text 源是 { type:'text'; doc: unknown }，理论上没产出过；
    // 但手改 JSON 可能带一个残缺 doc，不补的话 validateProject 会在更远处炸。
    const p = defaultProject('v1');
    p.schemaVersion = 1;
    p.tracks.push({
      kind: 'visual',
      id: newId(),
      name: 'V1',
      enabled: true,
      clips: [{
        kind: 'source', id: newId(), start: 0, end: 1, label: '', fadeSec: 0, curves: {},
        source: { type: 'text', doc: { garbage: true } },
        blend: 'normal', opacity: 1,
        transform: { x: 0.5, y: 0.5, sx: 1, sy: 1, rot: 0 }, fit: 'contain',
      }],
    } as never);

    const out = migrateProject(JSON.parse(JSON.stringify(p)));
    expect(out.schemaVersion).toBe(SCHEMA_VERSION);
    const clip = out.tracks[0]!.clips[0]!;
    if (clip.kind !== 'source' || clip.source.type !== 'text') throw new Error('unreachable');
    expect(Array.isArray(clip.source.doc.elements)).toBe(true);
    expect(clip.source.doc.size.w).toBeGreaterThan(0);
    expect(clip.source.doc.size.h).toBeGreaterThan(0);
  });

  it('v1 → v2：本来就合法的 doc 原样保留', () => {
    const doc = {
      size: { w: 1280, h: 720 },
      background: { kind: 'none' },
      elements: [{ id: 'keep-me' }],
      fonts: [],
    };
    const p = defaultProject('v1-ok');
    p.schemaVersion = 1;
    p.tracks.push({
      kind: 'visual', id: newId(), name: 'V1', enabled: true,
      clips: [{
        kind: 'source', id: newId(), start: 0, end: 1, label: '', fadeSec: 0, curves: {},
        source: { type: 'text', doc },
        blend: 'normal', opacity: 1,
        transform: { x: 0.5, y: 0.5, sx: 1, sy: 1, rot: 0 }, fit: 'contain',
      }],
    } as never);

    const out = migrateProject(JSON.parse(JSON.stringify(p)));
    const clip = out.tracks[0]!.clips[0]!;
    if (clip.kind !== 'source' || clip.source.type !== 'text') throw new Error('unreachable');
    expect((clip.source.doc.elements[0] as { id: string }).id).toBe('keep-me');
    expect(clip.source.doc.size).toEqual({ w: 1280, h: 720 });
  });

  it('v1 → v2 迁移是幂等的（跑两次结果一致）', () => {
    const p = defaultProject('idem');
    p.schemaVersion = 1;
    const once = migrateProject(JSON.parse(JSON.stringify(p)));
    const twice = migrateProject(JSON.parse(JSON.stringify(once)));
    expect(JSON.stringify(twice)).toBe(JSON.stringify(once));
  });

  /**
   * v15 → v16：网格模拟的 `size` 拆成 `width` / `height`。
   *
   * 判据必须是**两个轴都拿到原值**。只写 width 的话画面会从正方形变成
   * 「宽度对、高度退回默认」—— 那种变形不会报错，只会看起来「工程被改过」。
   */
  it('v15 → v16：网格模拟的 size 拆成 width / height；雪花保持 size', () => {
    const p = defaultProject('grid');
    p.schemaVersion = 15;
    const base = {
      kind: 'source',
      id: newId(),
      start: 0,
      end: 1,
      label: '',
      fadeSec: 0,
      curves: {},
      blend: 'normal',
      opacity: 1,
      transform: { x: 0.5, y: 0.5, sx: 1, sy: 1, rot: 0 },
      fit: 'contain',
    };
    p.tracks.push({
      kind: 'visual',
      id: newId(),
      name: 'V1',
      enabled: true,
      clips: [
        { ...base, id: newId(), source: { type: 'algo', generator: 'game-of-life', params: { size: 224, mask: 6152 } } },
        { ...base, id: newId(), source: { type: 'algo', generator: 'snowflake', params: { size: 320 } } },
        // 已经是新格式（或手改过）的不该被覆盖
        { ...base, id: newId(), source: { type: 'algo', generator: 'lenia', params: { size: 112, width: 96, height: 64 } } },
      ],
    } as never);

    const out = migrateProject(JSON.parse(JSON.stringify(p)));
    const clips = (out.tracks[0] as { clips: { source: { params: Record<string, unknown> } }[] }).clips;
    expect(clips[0]!.source.params).toEqual({ width: 224, height: 224, mask: 6152 });
    expect(clips[1]!.source.params).toEqual({ size: 320 });
    expect(clips[2]!.source.params).toEqual({ size: 112, width: 96, height: 64 });
  });

  /**
   * v17 → v18：排版动画的**作用层**从「隐式 = 内容层」变成显式字段，缺省改成了
   * `box`。判据只有一条：老工程里**没写 target** 的条目必须被钉成 `content`，
   * 否则打开就整块一起动（旧工程画面全变，而且不报错）。
   */
  it('v17 → v18：没写 target 的动画钉成 content；已有 target 原样保留', () => {
    const track = (id: string, target?: string) => ({
      id,
      kind: 'tracks',
      prop: 'rot',
      keys: [
        { t: 0, v: 0 },
        { t: 1, v: 90 },
      ],
      ...(target ? { target } : {}),
    });
    const p = defaultProject('v17-anim');
    p.schemaVersion = 17;
    p.tracks.push({
      kind: 'visual',
      id: newId(),
      name: 'V1',
      enabled: true,
      clips: [
        {
          kind: 'source', id: newId(), start: 0, end: 1, label: '', fadeSec: 0, curves: {},
          source: {
            type: 'text',
            doc: {
              size: { w: 1920, h: 1080 },
              background: { kind: 'none' },
              elements: [
                {
                  id: 'e1', kind: 'text', frame: { x: 0, y: 0, w: 100, h: 100, rot: 0 },
                  runs: [{ text: 'A' }], animations: [track('a1')],
                },
                {
                  id: 'e2', kind: 'text', frame: { x: 0, y: 0, w: 100, h: 100, rot: 0 },
                  runs: [{ text: 'B' }], animations: [track('a2', 'box')],
                },
              ],
              fonts: [],
            },
          },
          blend: 'normal', opacity: 1,
          transform: { x: 0.5, y: 0.5, sx: 1, sy: 1, rot: 0 }, fit: 'contain',
        },
      ],
    } as never);

    const out = migrateProject(JSON.parse(JSON.stringify(p)));
    expect(out.schemaVersion).toBe(SCHEMA_VERSION);
    const clip = out.tracks[0]!.clips[0]!;
    if (clip.kind !== 'source' || clip.source.type !== 'text') throw new Error('unreachable');
    const els = clip.source.doc.elements as unknown as {
      id: string;
      animations: { target?: string }[];
    }[];
    expect(els[0]!.animations[0]!.target, '老工程必须保持「只转字」').toBe('content');
    expect(els[1]!.animations[0]!.target, '显式写的 box 不该被迁移改写').toBe('box');
  });
});

describe('排版片段的校验', () => {
  const textClip = (doc: unknown) => ({
    kind: 'source', id: newId(), start: 0, end: 1, label: '', fadeSec: 0, curves: {},
    source: { type: 'text', doc },
    blend: 'normal', opacity: 1,
    transform: { x: 0.5, y: 0.5, sx: 1, sy: 1, rot: 0 }, fit: 'contain',
  });

  const withClip = (clip: unknown) => {
    const p = defaultProject('t');
    p.tracks.push({ kind: 'visual', id: newId(), name: 'V1', enabled: true, clips: [clip] } as never);
    return p;
  };

  it('合法文档通过', () => {
    const p = withClip(textClip({ size: { w: 1920, h: 1080 }, background: { kind: 'none' }, elements: [], fonts: [] }));
    expect(() => validateProject(p)).not.toThrow();
  });

  it('doc 缺 elements 被拒（否则会静默穿透到光栅化再炸）', () => {
    expect(() => validateProject(withClip(textClip({ size: { w: 10, h: 10 } })))).toThrow(/doc 非法/);
    expect(() => validateProject(withClip(textClip(null)))).toThrow(/doc 非法/);
  });

  it('文档尺寸非法被拒', () => {
    const bad = { size: { w: 0, h: 100 }, elements: [], fonts: [] };
    expect(() => validateProject(withClip(textClip(bad)))).toThrow(/尺寸非法/);
  });
});

describe('影响深度（EffectClip.affectDepth）', () => {
  const withFx = (affectDepth: unknown) => {
    const p = defaultProject('fx');
    p.tracks.push({
      kind: 'visual', id: newId(), name: 'V1', enabled: true,
      clips: [{
        kind: 'effect', id: newId(), start: 0, end: 1, label: '', fadeSec: 0, curves: {},
        chain: [], ...(affectDepth === undefined ? {} : { affectDepth }),
      }],
    } as never);
    return p;
  };

  it('0 / 正整数 / 缺省都通过', () => {
    expect(() => validateProject(withFx(undefined))).not.toThrow();
    expect(() => validateProject(withFx(0))).not.toThrow();
    expect(() => validateProject(withFx(2))).not.toThrow();
  });

  it('负数 / 小数 / 非数字被拒（否则会以另一种语义穿透到 buildStack）', () => {
    for (const bad of [-1, 2.5, NaN, 'two']) {
      expect(() => validateProject(withFx(bad)), String(bad)).toThrow(/影响深度/);
    }
  });

  it('v4 → v5 是恒等迁移：字段原样保留', () => {
    const p = withFx(3);
    p.schemaVersion = 4;
    const out = migrateProject(JSON.parse(JSON.stringify(p)));
    expect(out.schemaVersion).toBe(SCHEMA_VERSION);
    const clip = out.tracks[0]!.clips[0]!;
    if (clip.kind !== 'effect') throw new Error('unreachable');
    expect(clip.affectDepth).toBe(3);
  });
});

describe('绑定片段（EffectClip.boundClipId，v11）', () => {
  const withBound = (extra: Record<string, unknown>) => {
    const p = defaultProject('bound');
    p.tracks.push({
      kind: 'visual', id: newId(), name: 'V1', enabled: true,
      clips: [{
        kind: 'effect', id: newId(), start: 0, end: 1, label: '', fadeSec: 0, curves: {},
        chain: [], ...extra,
      }],
    } as never);
    return p;
  };

  it('v10 → v11 是恒等迁移：boundClipId 原样保留', () => {
    const p = withBound({ boundClipId: 'src-42' });
    p.schemaVersion = 10;
    const out = migrateProject(JSON.parse(JSON.stringify(p)));
    expect(out.schemaVersion).toBe(SCHEMA_VERSION);
    const clip = out.tracks[0]!.clips[0]!;
    if (clip.kind !== 'effect') throw new Error('unreachable');
    expect(clip.boundClipId).toBe('src-42');
  });

  it('与影响深度同时出现时以绑定为准（丢掉 affectDepth，工程照常打开）', () => {
    const out = validateProject(withBound({ boundClipId: 'src-42', affectDepth: 2 }));
    const clip = out.tracks[0]!.clips[0]!;
    if (clip.kind !== 'effect') throw new Error('unreachable');
    expect(clip.boundClipId).toBe('src-42');
    expect(clip.affectDepth).toBeUndefined();
  });

  it('空 / 非字符串被拒', () => {
    expect(() => validateProject(withBound({ boundClipId: '' }))).toThrow(/绑定片段/);
    expect(() => validateProject(withBound({ boundClipId: 7 }))).toThrow(/绑定片段/);
  });
});

describe('片段级抠图 / 四角（SourceClip.key / quad，v7）', () => {
  const sourceClip = (extra: Record<string, unknown> = {}) => ({
    kind: 'source', id: newId(), start: 0, end: 1, label: '', fadeSec: 0, curves: {},
    source: { type: 'solid', color: '#000' },
    blend: 'normal', opacity: 1,
    transform: { x: 0.5, y: 0.5, sx: 1, sy: 1, rot: 0 }, fit: 'contain',
    ...extra,
  });

  const withClip = (clip: unknown) => {
    const p = defaultProject('v7');
    p.tracks.push({ kind: 'visual', id: newId(), name: 'V1', enabled: true, clips: [clip] } as never);
    return p;
  };

  it('工厂函数给出约定的出厂值', () => {
    expect(defaultKeySettings()).toEqual({
      color: '#00ff00', tolerance: 0.25, softness: 0.12, spill: 0.5,
    });
    expect(identityQuad()).toEqual({ tl: [0, 0], tr: [1, 0], br: [1, 1], bl: [0, 1] });
  });

  it('合法的 key / quad 通过校验；缺省字段照旧通过', () => {
    expect(() => validateProject(withClip(sourceClip()))).not.toThrow();
    expect(() =>
      validateProject(withClip(sourceClip({ key: defaultKeySettings(), quad: identityQuad() }))),
    ).not.toThrow();
    // 边界值合法：容差 0 / 1 是闭区间端点。
    expect(() =>
      validateProject(withClip(sourceClip({
        key: { ...defaultKeySettings(), tolerance: 0, softness: 1, spill: 0 },
      }))),
    ).not.toThrow();
    // 四角允许拖到单位方之外（UI 就是让用户自由拉角），只要求有限数。
    const outward: QuadCorners = {
      tl: [-0.2, -0.1], tr: [1.1, 0.05], br: [1.05, 1.2], bl: [-0.05, 0.95],
    };
    expect(() => validateProject(withClip(sourceClip({ quad: outward })))).not.toThrow();
  });

  it('坏抠图参数被拒（错误文案里带片段 id）', () => {
    const cases: [string, unknown][] = [
      ['坏颜色（没有 #）', { ...defaultKeySettings(), color: '00ff00' }],
      ['坏颜色（三位简写）', { ...defaultKeySettings(), color: '#0f0' }],
      ['颜色不是字符串', { ...defaultKeySettings(), color: 255 }],
      ['tolerance = NaN', { ...defaultKeySettings(), tolerance: NaN }],
      ['tolerance = Infinity', { ...defaultKeySettings(), tolerance: Infinity }],
      ['softness 越界', { ...defaultKeySettings(), softness: 1.5 }],
      ['spill 是字符串', { ...defaultKeySettings(), spill: '0.5' }],
      ['不是对象', null],
      ['是数组', []],
    ];
    for (const [name, bad] of cases) {
      const clip = sourceClip({ key: bad });
      const p = withClip(clip);
      expect(() => validateProject(p), name).toThrow((clip as { id: string }).id);
      expect(() => validateProject(p), name).toThrow(/抠图/);
    }
  });

  it('坏四角被拒（错误文案里带片段 id）', () => {
    const good = identityQuad();
    const cases: [string, unknown][] = [
      ['少一个角', { tl: good.tl, tr: good.tr, bl: good.bl }],
      ['角不是数组', { ...good, tl: '0,0' }],
      ['角长度不是 2', { ...good, tl: [0, 0, 0] }],
      ['角里有 NaN', { ...good, bl: [0, NaN] }],
      ['角里有 Infinity', { ...good, br: [Infinity, 1] }],
      ['不是对象', '#fff'],
      ['是数组', [0, 0]],
    ];
    for (const [name, bad] of cases) {
      const clip = sourceClip({ quad: bad });
      const p = withClip(clip);
      expect(() => validateProject(p), name).toThrow((clip as { id: string }).id);
      expect(() => validateProject(p), name).toThrow(/四角/);
    }
  });

  it('v6 → v7 是恒等迁移：key / quad 原样保留，版本一路抬到当前版本', () => {
    const key = { ...defaultKeySettings(), color: '#123abc' };
    // 一般透视四边形（含负坐标，验证迁移 / 校验不会顺手夹到 [0,1]）。
    const quad: QuadCorners = {
      tl: [-0.1, 0.15], tr: [0.9, 0.2], br: [1.05, 0.95], bl: [0, 0.8],
    };
    const p = withClip(sourceClip({ key, quad }));
    p.schemaVersion = 6;
    const out = migrateProject(JSON.parse(JSON.stringify(p)));
    expect(out.schemaVersion).toBe(SCHEMA_VERSION);
    const clip = out.tracks[0]!.clips[0]!;
    if (clip.kind !== 'source') throw new Error('unreachable');
    expect(clip.key).toEqual(key);
    expect(clip.quad).toEqual(quad);
  });

  it('cloneProject 保留新字段，且是深拷贝', () => {
    const p = withClip(sourceClip({ key: defaultKeySettings(), quad: identityQuad() }));
    const copy = cloneProject(p);
    const clip = copy.tracks[0]!.clips[0]!;
    if (clip.kind !== 'source') throw new Error('unreachable');
    expect(clip.key).toEqual(defaultKeySettings());
    expect(clip.quad).toEqual(identityQuad());
    // 撤销栈按整份 JSON 深拷贝存储，改副本不能影响原工程。
    clip.key!.color = '#000000';
    const orig = p.tracks[0]!.clips[0]!;
    if (orig.kind !== 'source') throw new Error('unreachable');
    expect(orig.key!.color).toBe('#00ff00');
  });
});

describe('画面裁剪（SourceClip.crop，v10）', () => {
  const sourceClip = (extra: Record<string, unknown> = {}) => ({
    kind: 'source', id: newId(), start: 0, end: 1, label: '', fadeSec: 0, curves: {},
    source: { type: 'solid', color: '#000' },
    blend: 'normal', opacity: 1,
    transform: { x: 0.5, y: 0.5, sx: 1, sy: 1, rot: 0 }, fit: 'contain',
    ...extra,
  });

  const withClip = (clip: unknown) => {
    const p = defaultProject('v10');
    p.tracks.push({ kind: 'visual', id: newId(), name: 'V1', enabled: true, clips: [clip] } as never);
    return p;
  };

  it('缺省 / 合法值通过（四种源类型都接受）', () => {
    expect(() => validateProject(withClip(sourceClip()))).not.toThrow();
    const crop = { left: 0.1, top: 0.2, right: 0.3, bottom: 0.4 };
    for (const source of [
      { type: 'solid', color: '#000' },
      { type: 'algo', generator: 'mandelbrot', params: {} },
      { type: 'image', assetId: 'a1' },
      { type: 'video', assetId: 'v1', srcIn: 0, speed: 1 },
    ]) {
      expect(() => validateProject(withClip(sourceClip({ source, crop }))), source.type).not.toThrow();
    }
  });

  it('坏裁剪被拒（错误文案里带片段 id）', () => {
    const good = { left: 0.1, top: 0.1, right: 0.1, bottom: 0.1 };
    const cases: [string, unknown][] = [
      ['缺一条边', { left: 0.1, top: 0.1, right: 0.1 }],
      ['越界（= 1）', { ...good, left: 1 }],
      ['负数', { ...good, top: -0.1 }],
      ['NaN', { ...good, bottom: NaN }],
      ['字符串', { ...good, right: '0.1' }],
      ['两条边把画面吃光', { ...good, left: 0.6, right: 0.4 }],
      ['不是对象', 0.5],
      ['是数组', [0.1, 0.1, 0.1, 0.1]],
    ];
    for (const [name, bad] of cases) {
      const clip = sourceClip({ crop: bad });
      const p = withClip(clip);
      expect(() => validateProject(p), name).toThrow((clip as { id: string }).id);
      expect(() => validateProject(p), name).toThrow(/裁剪/);
    }
  });

  it('v9 → v10 是恒等迁移：裁剪原样保留', () => {
    const crop = { left: 0.25, top: 0, right: 0.25, bottom: 0.1 };
    const p = withClip(sourceClip({ crop }));
    p.schemaVersion = 9;
    const out = migrateProject(JSON.parse(JSON.stringify(p)));
    expect(out.schemaVersion).toBe(SCHEMA_VERSION);
    const clip = out.tracks[0]!.clips[0]!;
    if (clip.kind !== 'source') throw new Error('unreachable');
    expect(clip.crop).toEqual(crop);
  });
});

/**
 * 轨道静音（v15）。判据只有两条：
 *   1. v14 的工程升上来，`muted`（手改 JSON 带进去的）原样保留 —— 这是恒等迁移；
 *   2. 坏值 / 音频轨上的 muted 被删 —— 「意外没声」比「意外有声」更容易被报成 bug，
 *      但它同样是「数据说了一件事、程序做了另一件」。
 */
describe('schema v15：轨道静音', () => {
  it('v14 → v15 恒等迁移：muted 原样保留', () => {
    const p = defaultProject('mute');
    p.tracks.push({ kind: 'visual', id: newId(), name: 'V1', enabled: true, clips: [], muted: true });
    p.schemaVersion = 14;
    const out = migrateProject(JSON.parse(JSON.stringify(p)));
    expect(out.schemaVersion).toBe(SCHEMA_VERSION);
    expect((out.tracks[0] as { muted?: boolean }).muted).toBe(true);
  });

  it('只认 true；音频轨上的 muted 被删', () => {
    const p = defaultProject('mute-bad');
    p.tracks.push({ kind: 'visual', id: newId(), name: 'V1', enabled: true, clips: [] });
    const visual = p.tracks[0] as unknown as Record<string, unknown>;
    visual.muted = 'yes';
    p.tracks.push({
      kind: 'audio', id: newId(), name: 'A1', enabled: true, bus: 'master', clips: [], muted: true,
    } as never);
    const out = validateProject(JSON.parse(JSON.stringify(p)));
    expect((out.tracks[0] as { muted?: boolean }).muted).toBeUndefined();
    expect((out.tracks[1] as { muted?: boolean }).muted).toBeUndefined();
  });
});

/**
 * v21 → v22：万花筒的 `circle`（圆形对称）缺省是 **1**（新工程要圆），
 * 旧工程必须被显式钉成 0，否则一打开观感就变了。
 */
describe('schema v22：万花筒的圆形对称', () => {
  const withChain = (chain: unknown[]) => {
    const p = defaultProject('kaleido');
    p.tracks.push({
      kind: 'visual', id: newId(), name: 'V1', enabled: true,
      clips: [{
        kind: 'effect', id: newId(), start: 0, end: 1, label: '', fadeSec: 0, curves: {},
        chain,
      }],
    } as never);
    p.schemaVersion = 21;
    return p;
  };

  const chainOf = (out: ReturnType<typeof migrateProject>) =>
    (out.tracks[0] as unknown as { clips: { chain: { defId: string; values: Record<string, unknown> }[] }[] })
      .clips[0]!.chain;

  it('旧工程被钉成 circle: 0，其它参数原样保留', () => {
    const p = withChain([
      { instanceId: 'i1', defId: 'kaleido', enabled: true, values: { amount: 1, sides: 4, angle: 30 } },
    ]);
    const out = migrateProject(JSON.parse(JSON.stringify(p)));
    expect(out.schemaVersion).toBe(SCHEMA_VERSION);
    expect(chainOf(out)[0]!.values).toEqual({ amount: 1, sides: 4, angle: 30, circle: 0 });
  });

  it('只碰 kaleido；已经带 circle 的不覆盖', () => {
    const p = withChain([
      { instanceId: 'i1', defId: 'blur', enabled: true, values: { radius: 0.4 } },
      { instanceId: 'i2', defId: 'kaleido', enabled: true, values: { circle: 1 } },
    ]);
    const out = migrateProject(JSON.parse(JSON.stringify(p)));
    const chain = chainOf(out);
    expect(chain[0]!.values).toEqual({ radius: 0.4 });
    expect(chain[1]!.values).toEqual({ circle: 1 });
  });
});
