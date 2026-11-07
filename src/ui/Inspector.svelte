<script lang="ts">
  import { appState } from './app-state.svelte';
  import Icon from './Icon.svelte';
  import KeyableField from './KeyableField.svelte';
  import Button from './controls/Button.svelte';
  import BitmaskField from './controls/BitmaskField.svelte';
  import Checkbox from './controls/Checkbox.svelte';
  import Field from './controls/Field.svelte';
  import IconButton from './controls/IconButton.svelte';
  import NumberInput from './controls/NumberInput.svelte';
  import NumericField from './controls/NumericField.svelte';
  import PatternField from './controls/PatternField.svelte';
  import Select from './controls/Select.svelte';
  import Slider from './controls/Slider.svelte';
  import TextField from './controls/TextField.svelte';
  import ColorField from './controls/ColorField.svelte';
  import {
    BLEND_MODES,
    defaultKeySettings,
    identityCrop,
    identityQuad,
    isIdentityCrop,
    newId,
    type AnyClip,
    type BlendMode,
    type CropSettings,
    type EffectInstance,
    type SourceClip,
  } from '../core/schema';
  import { withCropEdge } from '../core/image-fx';
  import type { ModSlot } from '../core/modulation';
  import { isGradeDef } from '../core/grade';
  import { clipEditorOf } from './clip-editor';
  import MaskField from './controls/MaskField.svelte';
  import { baseOf, setBase, upsertCurveKey } from './clip-edit';
  import { reorder } from './drag-reorder';
  import { rememberRecentAlgo, rememberRecentEffect } from './recent-defs.svelte';
  import { affectedVisualIndices, visualTracks } from '../engine/stack';
  import { defaultParams, getGenerator } from '../algos/registry';
  import { gridSizeFromDefs } from '../algos/grid-dims';
  import { appPatternSource } from './pattern/pattern-import';
  import { defaultEffectValues, getEffect } from '../effects/registry';
  import EffectPickerModal from './effect-picker/EffectPickerModal.svelte';
  import AlgoPickerModal from './algo-picker/AlgoPickerModal.svelte';
  import TransitionPickerModal from './transition-picker/TransitionPickerModal.svelte';
  import { transitionThumbUrl } from './transition-picker/thumb-assets';
  import { transitionCatalogInfo } from '../effects/transitions/catalog-info';
  import { defaultTransitionValues, getTransition } from '../effects/transitions/registry';
  import { transitionCut } from '../core/transitions';
  import { visibleParams, type RangeParam } from '../effects/types';
  import { tr } from '../i18n/index.svelte';
  import { resolveLabel } from '../i18n/label';
  import { themeById, resolveThemeColor } from '../typography/theme';

  /**
   * 取色入口用的配色方案：**工程级**（`Project.typographyTheme`），含工程
   * 自定义方案。检查器不属于某个排版文档，所以取工程默认而不是 `doc.theme`。
   */
  const inspectorTheme = $derived.by(() => {
    void appState.version;
    return themeById(appState.project.typographyTheme, appState.project.customThemes);
  });

  /**
   * 图案编辑器的「从素材导入」数据源。无状态，建一次即可 —— 列表在打开选择器时
   * 才读（那时 `appState.version` 是最新的）。
   */
  const patternAssets = appPatternSource();

  const blendOptions = BLEND_MODES.map((m) => ({ value: m.id, label: tr(m.labelKey) }));
  const fitOptions = [
    { value: 'contain' as const, label: tr('insp.fitContain') },
    { value: 'cover' as const, label: tr('insp.fitCover') },
    { value: 'stretch' as const, label: tr('insp.fitStretch') },
  ] satisfies { value: SourceClip['fit']; label: string }[];

  /** 新转场的默认时长。两拍以内、也不至于短到看不见。 */
  const DEFAULT_TRANSITION_SEC = 0.5;

  let pickerOpen = $state(false);
  let transitionPickerSide = $state<'in' | 'out' | null>(null);
  let algoPickerOpen = $state(false);

  /**
   * 按**选择顺序**把若干特效追加到链尾。
   *
   * 一次事务（一个 undo 步）：选择器允许多选，若逐个 push 各自成一笔撤销，
   * 用户按一次「撤销」只退掉最后一个，与"我加了一次特效"的直觉不符。
   */
  function addEffectInstances(clip: AnyClip, defIds: readonly string[]): void {
    if (defIds.length === 0) return;
    upd(clip, tr('insp.addEffect'), (c) => {
      if (c.kind !== 'effect') return;
      for (const defId of defIds) {
        c.chain.push({
          instanceId: newId(),
          defId,
          enabled: true,
          values: defaultEffectValues(defId),
        });
      }
    });
    for (const defId of defIds) rememberRecentEffect(defId);
  }

  function removeInstance(clip: AnyClip, instanceId: string): void {
    upd(clip, tr('insp.removeEffect'), (c) => {
      if (c.kind === 'effect') c.chain = c.chain.filter((i) => i.instanceId !== instanceId);
    });
  }

  function moveInstance(clip: AnyClip, instanceId: string, dir: -1 | 1): void {
    upd(clip, tr('insp.reorderEffect'), (c) => {
      if (c.kind !== 'effect') return;
      const idx = c.chain.findIndex((i) => i.instanceId === instanceId);
      const to = idx + dir;
      if (idx < 0 || to < 0 || to >= c.chain.length) return;
      const [it] = c.chain.splice(idx, 1);
      c.chain.splice(to, 0, it!);
    });
  }

  /** 拖曳排序的落点结算（与 `moveInstance` 同一笔撤销语义）。 */
  function reorderInstance(clip: AnyClip, from: number, to: number): void {
    upd(clip, tr('insp.reorderEffect'), (c) => {
      if (c.kind !== 'effect') return;
      if (from === to || from < 0 || to < 0 || from >= c.chain.length || to >= c.chain.length) return;
      const [it] = c.chain.splice(from, 1);
      c.chain.splice(to, 0, it!);
    });
  }

  /* ------------------------------------------------- 特效卡片的折叠 */
  /*
   * 折叠态按 instanceId 记（不落盘）：它是「这次编辑时我怎么看这条链」，
   * 与工程内容无关，也没重要到值得写 localStorage。切走再切回来保持原样，
   * 关掉页面就回到全部展开 —— 与大多数属性面板的手感一致。
   */
  let collapsedIds = $state<string[]>([]);

  function isCollapsed(id: string): boolean {
    return collapsedIds.includes(id);
  }

  function toggleCollapsed(id: string): void {
    collapsedIds = isCollapsed(id) ? collapsedIds.filter((x) => x !== id) : [...collapsedIds, id];
  }

  function allCollapsed(chain: readonly { instanceId: string }[]): boolean {
    return chain.length > 0 && chain.every((i) => collapsedIds.includes(i.instanceId));
  }

  function toggleAllCollapsed(chain: readonly { instanceId: string }[]): void {
    collapsedIds = allCollapsed(chain) ? [] : chain.map((i) => i.instanceId);
  }

  function setEffectParam(clip: AnyClip, inst: EffectInstance, key: string, v: number | string): void {
    upd(clip, tr('insp.editEffectParam'), (c) => {
      if (c.kind !== 'effect') return;
      const it = c.chain.find((i) => i.instanceId === inst.instanceId);
      if (it) it.values[key] = v;
    });
  }

  /**
   * 调制槽的读写（v20）。走 `store.setClipMods` —— 那是**唯一**写入口。
   * 曲线与调制共用键空间，在这里再拼一份「怎么改 mods」就是两套真源。
   */
  function modsOf(clip: AnyClip, key: string) {
    return {
      mods: clip.mods?.[key],
      onMods: (next: ModSlot[] | null) => appState.store.setClipMods(clip.id, key, next),
    };
  }

  /**
   * `KeyableField` 的一整套回调（曲线求值 / 打点 / 删点 / 锚拍 / 清曲线）。
   *
   * 抽出来是因为视频变速与特效参数用的是**同一套键约定**（`clip.curves[key]`）。
   * 各写一份的形态是「特效的关键帧能开曲线编辑器、视频速度的不行」这种
   * 静默的不一致。
   */
  function curveProps(
    clip: AnyClip,
    curveKey: string,
    base: number,
    onBase: (v: number) => void,
  ) {
    return {
      base,
      curve: clip.curves[curveKey],
      clipStart: clip.start,
      /* 编辑信号（跨剪切点两帧预览的自动模式用）。见 KeyableField 与 app-state。 */
      clipId: clip.id,
      curveKey,
      onBase,
      onKey: (v: number, anchor: { beat: number } | null) =>
        upd(clip, tr('insp.keyframe'), (c) => upsertCurveKey(c, curveKey, v, appState.playT, anchor, appState.project.beatGrid)),
      onRemoveKey: (i: number) =>
        upd(clip, tr('insp.removeKeyframe'), (c) => {
          const cv = c.curves[curveKey];
          if (cv) cv.keys = cv.keys.filter((_, k) => k !== i);
        }),
      onAnchorChange: (anchor: { beat: number } | null) =>
        upd(clip, tr('insp.toggleAnchor'), (c) => {
          const cv = c.curves[curveKey];
          if (cv) cv.beatAnchor = anchor;
        }),
      onClearCurve: () =>
        upd(clip, tr('insp.clearCurve'), (c) => {
          delete c.curves[curveKey];
        }),
      ...modsOf(clip, curveKey),
    };
  }

  function effectParamProps(clip: AnyClip, inst: EffectInstance, p: RangeParam) {
    return curveProps(clip, `${inst.instanceId}.${p.key}`, Number(inst.values[p.key] ?? p.defaultValue), (v) =>
      setEffectParam(clip, inst, p.key, v),
    );
  }

  /**
   * 视频变速（`core/speed.ts`）。
   *
   * **基值走 store**：只有 store 知道素材时长，能在「加速后素材不够」时把片段
   * 缩短（用户点名的那条规则）。曲线键 `speed` 与其它参数同构，允许负值 ——
   * 负速 = 倒放，媒体时间往回走。
   */
  function videoSpeedProps(clip: SourceClip) {
    return curveProps(clip, 'speed', clip.source.type === 'video' ? clip.source.speed : 1, (v) =>
      appState.store.setClipSpeed(clip.id, v),
    );
  }

  /**
   * 可关键帧的算法参数：realtime 生成器的全部 range 参数 +
   * bake 型的渲染期 speed。烘焙入参（width/rule/…）打关键帧 = 每帧重烘，禁止。
   */
  function keyframable(kind: string, key: string): boolean {
    return kind === 'realtime' || (kind === 'bake' && key === 'speed');
  }

  function setAlgoParam(clip: AnyClip, key: string, v: number | string): void {
    upd(clip, tr('insp.editParam'), (c) => {
      if (c.kind === 'source' && c.source.type === 'algo') c.source.params[key] = v;
    });
  }

  /**
   * 更换算法生成器：**整体替换** `clip.source`（一笔撤销）。
   *
   * 不同生成器的参数表完全不同（`rule` 对雪花没有意义、`speed` 含义也未必一样），
   * 所以旧参数一律不保留，新源写入新生成器的默认参数。旧生成器**同名参数上
   * 打的关键帧**也必须一起删 —— 否则新生成器若有同名的 `speed`，那条旧曲线会
   * 静默作用到新参数上（“换了算法却带着旧动画”）。只删旧生成器参数表里的键，
   * 不碰 opacity / transform.* 这些片段级曲线。
   */
  function changeAlgo(clip: AnyClip, genId: string): void {
    if (clip.kind !== 'source' || clip.source.type !== 'algo') return;
    if (clip.source.generator === genId) return;
    const oldKeys = new Set(getGenerator(clip.source.generator)?.params.map((p) => p.key) ?? []);
    upd(clip, tr('insp.changeAlgo'), (c) => {
      if (c.kind !== 'source' || c.source.type !== 'algo') return;
      c.source = { type: 'algo', generator: genId, params: defaultParams(genId) };
      for (const k of oldKeys) delete c.curves[k];
    });
    rememberRecentAlgo(genId);
  }

  function paramKeyableProps(clip: AnyClip, p: RangeParam) {
    return {
      base:
        clip.kind === 'source' && clip.source.type === 'algo'
          ? Number(clip.source.params[p.key] ?? p.defaultValue)
          : p.defaultValue,
      curve: clip.curves[p.key],
      clipStart: clip.start,
      clipId: clip.id,
      curveKey: p.key,
      onBase: (v: number) => setAlgoParam(clip, p.key, v),
      onKey: (v: number, anchor: { beat: number } | null) =>
        upd(clip, tr('insp.keyframe'), (c) => upsertCurveKey(c, p.key, v, appState.playT, anchor, appState.project.beatGrid)),
      onRemoveKey: (i: number) =>
        upd(clip, tr('insp.removeKeyframe'), (c) => {
          const cv = c.curves[p.key];
          if (cv) cv.keys = cv.keys.filter((_, idx) => idx !== i);
        }),
      onAnchorChange: (anchor: { beat: number } | null) =>
        upd(clip, tr('insp.toggleAnchor'), (c) => {
          const cv = c.curves[p.key];
          if (cv) cv.beatAnchor = anchor;
        }),
      onClearCurve: () =>
        upd(clip, tr('insp.clearCurve'), (c) => {
          delete c.curves[p.key];
        }),
      ...modsOf(clip, p.key),
    };
  }

  /**
   * 必须返回**新的引用**，不能只返回 store 里的原对象。
   *
   * Svelte 5 把 `{@const clip = found.clip}` 编译成 `$.derived(() => found.clip)`，
   * 而 derived 靠 `===` 判等决定是否向模板 effect 传播。store 里的 clip 是原地改的，
   * found.clip 每次都是同一引用 → clip 派生视为「没变」→ 整块模板 effect 不重跑。
   * 症状：加/删特效链只改 store，右侧面板纹丝不动；换选中再换回来才刷新。
   *
   * 所以包装对象每次新建、clip 深拷一份；track 浅拷即可（模板只读 name）。
   * 代价是一次片段级 structuredClone，可忽略。
   */
  const found = $derived.by(() => {
    void appState.version;
    const id = appState.selectedClipId;
    if (!id) return null;
    const f = appState.store.findClip(id);
    if (!f) return null;
    return { track: { ...f.track }, clip: structuredClone(f.clip) as AnyClip };
  });
  const playT = $derived(appState.playT);

  function upd(clip: AnyClip, label: string, fn: (c: AnyClip) => void): void {
    appState.store.updateClip(clip.id, label, fn);
  }

  function keyableProps(clip: AnyClip, key: string) {
    return {
      base: baseOf(clip, key),
      curve: clip.curves[key],
      clipStart: clip.start,
      clipId: clip.id,
      curveKey: key,
      onBase: (v: number) => upd(clip, tr('insp.editParam'), (c) => setBase(c, key, v)),
      onKey: (v: number, anchor: { beat: number } | null) =>
        upd(clip, tr('insp.keyframe'), (c) => upsertCurveKey(c, key, v, appState.playT, anchor, appState.project.beatGrid)),
      onRemoveKey: (i: number) =>
        upd(clip, tr('insp.removeKeyframe'), (c) => {
          const cv = c.curves[key];
          if (cv) cv.keys = cv.keys.filter((_, idx) => idx !== i);
        }),
      onAnchorChange: (anchor: { beat: number } | null) =>
        upd(clip, tr('insp.toggleAnchor'), (c) => {
          const cv = c.curves[key];
          if (cv) cv.beatAnchor = anchor;
        }),
      onClearCurve: () =>
        upd(clip, tr('insp.clearCurve'), (c) => {
          delete c.curves[key];
        }),
      ...modsOf(clip, key),
    };
  }

  /**
   * 缩放 X / Y 的联动。
   *
   * 默认联动：拖任一轴的滑杆或数字框，另一轴的**基准值**写成同一个数。
   * 勾「分离 XY」后回到两个独立字段。
   *
   * 只同步基值，**不碰曲线**：两轴各自的关键帧是独立编排的（比如只在 Y 上
   * 做弹跳），强行同步会把另一边已打好的关键帧抹平。基值在曲线存在时不参与
   * 求值 —— 这是 `KeyableField` 的既定语义，不是这里漏了什么。
   */
  function scaleProps(clip: AnyClip, key: 'transform.sx' | 'transform.sy') {
    const props = keyableProps(clip, key);
    if (!appState.scaleLinked) return props;
    const other = key === 'transform.sx' ? 'transform.sy' : 'transform.sx';
    return {
      ...props,
      onBase: (v: number) =>
        upd(clip, tr('insp.editParam'), (c) => {
          setBase(c, key, v);
          setBase(c, other, v);
        }),
    };
  }

  /* ------------------------------------------------- 抠图 / 四角调整（片段级）
   *
   * 两者都是 **SourceClip 自己的属性**（不是特效片段）：抠图只作用于本层 alpha，
   * 四角只把本层矩形做透视变形，实现全在同一次 placement pass。所以面板里把它们
   * 放在「片段自身属性」这一侧（变换之后），而不是特效链里。
   */

  /** 抠图的三种滑杆参数。 */
  type KeyParam = 'tolerance' | 'softness' | 'spill';

  function setKeyParam(clip: AnyClip, key: KeyParam, v: number): void {
    upd(clip, tr('insp.keyEdit'), (c) => {
      if (c.kind === 'source' && c.key) c.key[key] = v;
    });
  }

  /**
   * 取色卡写回键色。
   *
   * 取色卡里点「主题色」写进文档的是**槽位引用**（`@accent1` 这种），而键色会被
   * 引擎拿去和像素做色差、还要过 schema 的 `/^#[0-9a-fA-F]{6}$/` 校验 ——
   * 所以这里必须先解析成裸 hex 再存。漏了解析的表现是「调色板选了颜色，
   * 一保存工程就报『抠图参数不合法』」。
   */
  function setKeyColor(clip: AnyClip, v: string): void {
    upd(clip, tr('insp.keyEdit'), (c) => {
      if (c.kind === 'source' && c.key) c.key.color = resolveThemeColor(v, inspectorTheme);
    });
  }

  /* ------------------------------------------------- 裁剪（片段级）
   *
   * 与抠图 / 四角同一层：片段自身的属性，一次 placement pass 里完成。
   *
   * 写入走 `withCropEdge`（钳制在 `image-fx` 里，与校验同一份规则），全零时
   * **删掉字段** —— 缺省语义就是「不裁」，留一个恒等对象只会让「改过没改过」
   * 在工程 JSON 与撤销快照里表现不一致。
   */

  function setCropEdge(clip: AnyClip, edge: keyof CropSettings, v: number): void {
    upd(clip, tr('insp.cropEdit'), (c) => {
      if (c.kind !== 'source') return;
      const next = withCropEdge(c.crop ?? identityCrop(), edge, v);
      if (isIdentityCrop(next)) delete c.crop;
      else c.crop = next;
    });
  }

  /* ---------------------------------------------------------------- 转场 */

  /**
   * 落不了地的原因 → 文案键。v13 起只有三种：
   * `shadowed` = 同一边界的前一段出场转场接管；`too-short` = 两边长度不够。
   * `no-transition` 不会出现在这里（那是「还没设」）。
   */
  const REASON_KEYS = {
    shadowed: 'insp.transitionShadowed',
    'too-short': 'insp.transitionTooShort',
  } as const;

  /**
   * 两端剪切点几何（v13）。
   *
   * 注意这里**只做展示**：相邻判定与时长钳制只有 `core/transitions.ts` 一处实现，
   * 检查器不重算一遍（两边各写一套的话，"UI 上看着没问题、渲染时没生效" 就会
   * 变成一类查不出来的 bug）。
   */
  const transitionInfo = $derived.by(() => {
    void appState.version;
    const id = appState.selectedClipId;
    if (!id) return null;
    const f = appState.store.findClip(id);
    if (!f || f.track.kind !== 'visual') return null;
    const index = (f.track.clips as AnyClip[]).findIndex((c) => c.id === id);
    if (index < 0) return null;
    return {
      in: transitionCut(f.track, index, 'in'),
      out: transitionCut(f.track, index, 'out'),
    };
  });

  /**
   * 影响深度提示：这个特效片段实际覆盖了下方的哪几条轨。
   *
   * 判据是**与渲染侧同一份**的 `affectedVisualIndices`（`engine/stack.ts`）——
   * 深度是纯几何量，两边共用一份实现才不会出现「提示说影响 V2、画面却动了 V3」。
   * 这里只读不改：真正的边界（吸收 / 空作用域）在 `buildStack` 里算。
   */
  const scopeInfo = $derived.by(() => {
    void appState.version;
    const f = found;
    if (!f || f.clip.kind !== 'effect') return null;
    const depth = f.clip.affectDepth ?? 0;
    if (depth <= 0) return { depth, names: [] as string[] };
    const visuals = visualTracks(appState.project);
    const vis = visuals.findIndex((t) => t.id === f.track.id);
    const names = affectedVisualIndices(visuals, vis, depth).map((i) => visuals[i]!.name);
    return { depth, names };
  });

  /**
   * 绑定片段的可选目标：**其它视觉轨上的** source 片段。
   *
   * 同轨被排除：同轨片段在时间上不重叠，特效在它自己的区间里看不到同轨的另一段
   * （而且特效与 source 同轨重叠本身就是 `conflict`）。绑定目标若不在候选里
   * （被删 / 被移到同轨），补一条原值，否则下拉会显示「不绑定」而实际仍是绑定 ——
   * 那种「显示与实际不一致」比多一条选项坏得多。
   */
  const bindOptions = $derived.by(() => {
    void appState.version;
    const f = found;
    const out: { value: string; label: string }[] = [{ value: '', label: tr('insp.bindNone') }];
    if (!f || f.clip.kind !== 'effect') return out;
    const bound = f.clip.boundClipId;
    for (const t of appState.project.tracks) {
      if (t.kind !== 'visual' || t.id === f.track.id) continue;
      for (const c of t.clips) {
        if (c.kind !== 'source') continue;
        out.push({ value: c.id, label: `${t.name} · ${c.label || c.source.type}` });
      }
    }
    if (bound && !out.some((o) => o.value === bound)) out.push({ value: bound, label: bound });
    return out;
  });

  function setTransition(clip: AnyClip, side: 'in' | 'out', defId: string): void {
    if (!defId) {
      appState.store.setTransition(clip.id, side, '', 0, {});
      return;
    }
    // 换一条转场时**保住已有时长**：用户调好的节拍不该因为换了个效果被重置。
    const ref = clip.kind === 'source' ? (side === 'out' ? clip.transitionOut : clip.transitionIn) : undefined;
    appState.store.setTransition(
      clip.id,
      side,
      defId,
      ref?.duration ?? DEFAULT_TRANSITION_SEC,
      defaultTransitionValues(defId),
    );
  }

  function setTransitionParam(clip: AnyClip, side: 'in' | 'out', key: string, v: number): void {
    appState.store.updateTransition(
      clip.id,
      tr('insp.editTransitionParam'),
      (t) => {
        t.values[key] = v;
      },
      side,
    );
  }

  /* ------------------------------------------------------------ 片段音频 */

  /** 分离视频音频：建轨 + 建片段 + 静音原轨，一笔撤销；随后选中新音频片段。 */
  function detachAudio(clip: AnyClip): void {
    const id = appState.store.detachVideoAudio(clip.id);
    if (id) appState.selectClip(id);
  }

  /** 分离出来的音频在哪条轨上（检查器里的「已分离到 A2」）。 */
  function audioTrackName(audioClipId: string): string | null {
    const f = appState.store.findClip(audioClipId);
    return f ? f.track.name : null;
  }

  /**
   * 调色精度提示：链里有 `grade-*` 而中间缓冲拿不到 16F 时返回文案。
   *
   * 判定与渲染层**同一份**（`core/grade.ts`），这里只负责说出口。设备能力
   * （`floatSupported`）是静态的，所以这条提示在选中片段那一刻就成立；预算那条
   * 依赖上一帧的尺寸与作用域深度，晚一拍是可接受的。
   */
  function gradeWarning(chain: readonly EffectInstance[]): string | null {
    if (!chain.some((i) => isGradeDef(i.defId))) return null;
    const stats = appState.renderer.gradeStats();
    if (!stats.floatSupported) return tr('insp.gradeNoFloat');
    if (stats.reason === 'over-budget') return tr('insp.gradeBudget');
    return null;
  }
</script>

<div class="inspector">
  {#if found}
    {@const clip = found.clip}
    {@const track = found.track}
    <h3>
      {tr(clip.kind === 'source' ? 'insp.clipKindSource' : clip.kind === 'effect' ? 'insp.clipKindEffect' : 'insp.clipKindAudio')}
      <span class="track-name">{track.name}</span>
    </h3>

    <Field label={tr('insp.name')}>
      <input
        class="txt"
        data-testid="clip-label"
        value={clip.label}
        onchange={(e) => upd(clip, tr('common.rename'), (c) => (c.label = e.currentTarget.value))}
      />
    </Field>

    <Field label={tr('insp.start')}>
      <NumberInput
        value={clip.start}
        min={0}
        step={0.01}
        width={64}
        suffix="s"
        testid="clip-start"
        onchange={(v) => upd(clip, tr('insp.changeStart'), (c) => (c.start = Math.max(0, Math.min(v, c.end - 0.05))))}
      />
      <span class="dim">{tr('insp.end')}</span>
      <NumberInput
        value={clip.end}
        min={0}
        step={0.01}
        width={64}
        suffix="s"
        testid="clip-end"
        onchange={(v) =>
          upd(clip, tr('insp.changeEnd'), (c) => (c.end = Math.min(appState.project.duration, Math.max(v, c.start + 0.05))))}
      />
    </Field>

    {#if clip.kind === 'audio'}
      <!--
        音频片段给的是**编排用的**两条斜坡（与时间轴两端三角手柄同一份数据）。
        `fadeSec` 仍然在数据里（混流用它做剪辑点防爆音），但它对用户不可见：
        音频的「淡入淡出」就是这里这两条，多摆一个同义的输入框只会让人猜
        哪个在起作用。
      -->
      <Field label={tr('insp.fadeIn')} tipText={tr('insp.fadeInTip')}>
        <NumberInput
          value={clip.fadeIn ?? 0}
          min={0}
          step={0.05}
          width={64}
          suffix="s"
          testid="insp-fade-in"
          onchange={(v) => appState.store.setFade(clip.id, 'in', v)}
        />
        <span class="dim">{tr('insp.fadeOut')}</span>
        <NumberInput
          value={clip.fadeOut ?? 0}
          min={0}
          step={0.05}
          width={64}
          suffix="s"
          testid="insp-fade-out"
          onchange={(v) => appState.store.setFade(clip.id, 'out', v)}
        />
      </Field>

      <!-- 静态音量（dB）。与关键帧曲线相乘，求值在 core/audio-envelope（唯一真源）。 -->
      <NumericField
        label={tr('insp.audioGain')}
        min={-60}
        max={12}
        step={0.5}
        value={clip.gainDb ?? 0}
        sliderTestid="insp-audio-gain"
        numberTestid="insp-audio-gain-num"
        oninput={(v) => appState.store.setClipGainDb(clip.id, v)}
      />

      {#if clip.linkedVideoId}
        {@const video = appState.store.findClip(clip.linkedVideoId)?.clip}
        <Field label={tr('insp.audioLock')}>
          <Button
            label={clip.lockedTo ? tr('insp.audioUnlock') : tr('insp.audioLock')}
            icon="link"
            variant={clip.lockedTo ? 'accent' : 'outline'}
            testid="insp-audio-lock"
            onclick={() => appState.store.setAudioLocked(clip.id, !clip.lockedTo)}
          />
          <span class="dim">
            {clip.lockedTo
              ? tr('insp.audioLockedTo', { name: video?.label ?? clip.linkedVideoId })
              : tr('insp.audioUnlinked')}
          </span>
        </Field>
      {/if}
    {:else}
      <Field label={tr('insp.fade')}>
        <NumberInput
          value={clip.fadeSec}
          min={0}
          step={0.05}
          width={64}
          suffix="s"
          testid="clip-fade"
          onchange={(v) => upd(clip, tr('insp.changeFade'), (c) => (c.fadeSec = Math.max(0, v)))}
        />
      </Field>
    {/if}

    {#if clip.kind === 'source' && clip.source.type === 'video'}
      <!--
        视频内嵌音轨（v13）：默认就参与混流（预览与导出同源）。「分离音频」只是
        把这条声音搬到独立音频轨上以便单独编排；分离后原音轨自动静音，按钮变成
        一条「已分离到 Ax」的状态行。
      -->
      {@const audioTrack = clip.linkedAudioId ? audioTrackName(clip.linkedAudioId) : null}
      <div class="section" data-testid="clip-audio-section">
        <div class="section-head">
          <span class="section-title">{tr('insp.audio')}</span>
        </div>
        <!--
          轨道已被静音时先说明一句：这一层怎么调都听不见。没有这句的话，
          「片段没勾静音却还是没声」会被当成片段静音的 bug（而它其实是轨道的开关）。
        -->
        {#if found && found.track.kind === 'visual' && found.track.muted}
          <p class="note" data-testid="video-track-muted">{tr('insp.audioTrackMuted')}</p>
        {/if}
        <!--
          静音（v15）：只关这一条的内嵌音轨，画面照常（与轨道静音同一语义）。
          关掉之后音量 / 淡变**变灰但仍显示** —— 藏起来会让人以为设置丢了，
          而保留值才能在取消静音时原样恢复。
        -->
        <Checkbox
          checked={!!clip.audio?.muted}
          label={tr('insp.audioMuted')}
          testid="insp-video-muted"
          onchange={(v) => appState.store.setVideoAudioMuted(clip.id, v)}
        />
        <NumericField
          label={tr('insp.audioGain')}
          min={-60}
          max={12}
          step={0.5}
          value={clip.audio?.gainDb ?? 0}
          disabled={!!clip.audio?.muted}
          sliderTestid="insp-video-gain"
          numberTestid="insp-video-gain-num"
          oninput={(v) => appState.store.setClipGainDb(clip.id, v)}
        />
        <Field label={tr('insp.audioFadeIn')}>
          <NumberInput
            value={clip.audio?.fadeIn ?? 0}
            min={0}
            step={0.05}
            width={64}
            suffix="s"
            disabled={!!clip.audio?.muted}
            testid="insp-video-fade-in"
            onchange={(v) => appState.store.setClipAudioFade(clip.id, 'in', v)}
          />
          <span class="dim">{tr('insp.audioFadeOut')}</span>
          <NumberInput
            value={clip.audio?.fadeOut ?? 0}
            min={0}
            step={0.05}
            width={64}
            suffix="s"
            disabled={!!clip.audio?.muted}
            testid="insp-video-fade-out"
            onchange={(v) => appState.store.setClipAudioFade(clip.id, 'out', v)}
          />
        </Field>
        {#if clip.linkedAudioId}
          <p class="note" data-testid="video-audio-detached">
            {tr('insp.audioDetached', { track: audioTrack ?? clip.linkedAudioId })}
          </p>
        {:else}
          <Button
            label={tr('insp.audioDetach')}
            icon="audio-lines"
            variant="outline"
            testid="detach-video-audio"
            onclick={() => detachAudio(clip)}
          />
        {/if}
      </div>
    {/if}

    {#if clip.kind === 'source'}
      <Field label={tr('insp.blend')}>
        <Select
          value={clip.blend}
          options={blendOptions}
          testid="clip-blend"
          optionTestidPrefix="clip-blend-opt"
          onchange={(v) =>
            upd(clip, tr('insp.changeBlend'), (c) => {
              if (c.kind === 'source') c.blend = v as BlendMode;
            })}
        />
      </Field>
      <Field label={tr('insp.fit')}>
        <Select
          value={clip.fit}
          options={fitOptions}
          testid="clip-fit"
          optionTestidPrefix="clip-fit-opt"
          onchange={(v) =>
            upd(clip, tr('insp.changeFit'), (c) => {
              if (c.kind === 'source') c.fit = v;
            })}
        />
      </Field>

      {#if clip.source.type === 'video'}
        <!--
          变速：基值 = 常速（正数），曲线可以取负 = 倒放（见 core/speed.ts）。
          基值走 store —— 只有它拿得到素材时长，能在「加速后素材不够」时缩短片段。
          有曲线时滑杆改的是播放头处那个关键帧（KeyableField 的契约）。
        -->
        {@const speedProps = videoSpeedProps(clip)}
        <KeyableField
          label={tr('insp.speed')}
          min={clip.curves.speed ? -8 : 0.05}
          max={8}
          step={0.05}
          {...speedProps}
        />
      {/if}

      <KeyableField label={tr('insp.opacity')} min={0} max={1} step={0.01} {...keyableProps(clip, 'opacity')} />
      <KeyableField label={tr('insp.posX')} min={0} max={1} step={0.005} {...keyableProps(clip, 'transform.x')} />
      <KeyableField label={tr('insp.posY')} min={0} max={1} step={0.005} {...keyableProps(clip, 'transform.y')} />
      <KeyableField label={tr('insp.scaleX')} min={0.05} max={4} step={0.01} {...scaleProps(clip, 'transform.sx')} />
      <KeyableField label={tr('insp.scaleY')} min={0.05} max={4} step={0.01} {...scaleProps(clip, 'transform.sy')} />
      <!--
        「分离 XY」：默认不勾 = X/Y 联动（拖任一轴两轴一起变）。
        勾上才回到两个独立字段 —— 复选框的语义是「分离」，所以取反存。
        这是**编辑习惯**，落 localStorage（appState.scaleLinked），不进工程。
      -->
      <div class="scale-row">
        <Checkbox
          checked={!appState.scaleLinked}
          label={tr('insp.scaleSeparate')}
          tipText={tr('insp.scaleSeparateTip')}
          testid="clip-scale-separate"
          onchange={(v) => appState.setScaleLinked(!v)}
        />
      </div>
      <KeyableField label={tr('insp.rotate')} min={-3.1416} max={3.1416} step={0.01} {...keyableProps(clip, 'transform.rot')} />

      <!--
        抠图（色键）：引擎的 placement pass 对**任意源**生效，所以所有 source 片段
        都显示这一块。它不是特效片段：只处理这一层自己的 alpha，抠掉之后露出什么
        由 z 序下面的轨道决定。
      -->
      <div class="section" data-testid="keying-section">
        <div class="section-head">
          <span class="section-title">{tr('insp.keying')}</span>
          <Checkbox
            checked={!!clip.key}
            label={tr('insp.keyingEnable')}
            testid="clip-key-enable"
            onchange={(v) =>
              upd(clip, v ? tr('insp.keyingEnable') : tr('insp.keyingDisable'), (c) => {
                if (c.kind !== 'source') return;
                // 关闭 = 删字段（缺省语义就是「不抠」）；重新开启回到默认绿幕。
                if (v) c.key = defaultKeySettings();
                else delete c.key;
              })}
          />
        </div>

        {#if clip.key}
          {@const keySetting = clip.key}
          <Field label={tr('insp.keyColor')}>
            <ColorField
              label={tr('insp.keyColor')}
              value={keySetting.color}
              theme={inspectorTheme}
              testid="clip-key-color"
              onchange={(v) => setKeyColor(clip, v)}
            />
            <!--
              吸管：进入「在预览画面上点一下取色」的模式。取的是**只渲染这一轨**
              的一帧（见 appState.pickKeyColorAt），所以拿到的是这一层的原色，
              而不是被上层盖住 / 被混合模式混过的值。
            -->
            <IconButton
              icon="pipette"
              label={tr('insp.keyPick')}
              tipText={tr('insp.keyPickTip')}
              size="sm"
              active={appState.keyPickClipId === clip.id}
              testid="clip-key-pick"
              onclick={() => appState.beginKeyPick(clip.id)}
            />
            <span class="dim mono">{keySetting.color}</span>
          </Field>
          <Field label={tr('insp.keyTolerance')} tipText={tr('insp.keyToleranceTip')}>
            <Slider
              min={0}
              max={1}
              step={0.01}
              value={keySetting.tolerance}
              ariaLabel={tr('insp.keyTolerance')}
              testid="clip-key-tolerance"
              oninput={(v) => setKeyParam(clip, 'tolerance', v)}
              onchange={(v) => setKeyParam(clip, 'tolerance', v)}
            />
            <NumberInput
              value={keySetting.tolerance}
              min={0}
              max={1}
              step={0.01}
              width={58}
              testid="clip-key-tolerance-num"
              oninput={(v) => setKeyParam(clip, 'tolerance', v)}
              onchange={(v) => setKeyParam(clip, 'tolerance', v)}
            />
          </Field>
          <Field label={tr('insp.keySoftness')} tipText={tr('insp.keySoftnessTip')}>
            <Slider
              min={0}
              max={1}
              step={0.01}
              value={keySetting.softness}
              ariaLabel={tr('insp.keySoftness')}
              testid="clip-key-softness"
              oninput={(v) => setKeyParam(clip, 'softness', v)}
              onchange={(v) => setKeyParam(clip, 'softness', v)}
            />
            <NumberInput
              value={keySetting.softness}
              min={0}
              max={1}
              step={0.01}
              width={58}
              testid="clip-key-softness-num"
              oninput={(v) => setKeyParam(clip, 'softness', v)}
              onchange={(v) => setKeyParam(clip, 'softness', v)}
            />
          </Field>
          <Field label={tr('insp.keySpill')} tipText={tr('insp.keySpillTip')}>
            <Slider
              min={0}
              max={1}
              step={0.01}
              value={keySetting.spill}
              ariaLabel={tr('insp.keySpill')}
              testid="clip-key-spill"
              oninput={(v) => setKeyParam(clip, 'spill', v)}
              onchange={(v) => setKeyParam(clip, 'spill', v)}
            />
            <NumberInput
              value={keySetting.spill}
              min={0}
              max={1}
              step={0.01}
              width={58}
              testid="clip-key-spill-num"
              oninput={(v) => setKeyParam(clip, 'spill', v)}
              onchange={(v) => setKeyParam(clip, 'spill', v)}
            />
          </Field>
        {/if}
      </div>

      <!--
        裁剪（源边裁切）：**所有可见片段类型**都给（算法 / 排版 / 图片 / 视频 /
        纯色）—— 它在 placement pass 里只是「层内可见窗口」，与源的种类无关。
        四角与抠图只对图片 / 视频开放（它们的默认矩形对文本源不直观），裁剪不一样：
        「把文字块裁成一条」是常见要求。

        没有启用开关：四条边全 0 就是关闭，多一个开关只会让「关着但字段还在」
        变成又一种要解释的状态。
      -->
      <div class="section" data-testid="crop-section">
        <div class="section-head">
          <span class="section-title">{tr('insp.crop')}</span>
          {#if clip.crop}
            <IconButton
              icon="rotate-ccw"
              label={tr('insp.cropReset')}
              tipText={tr('insp.cropResetTip')}
              size="sm"
              testid="clip-crop-reset"
              onclick={() =>
                upd(clip, tr('insp.cropReset'), (c) => {
                  if (c.kind === 'source') delete c.crop;
                })}
            />
          {/if}
        </div>
        <Field label={tr('insp.cropLeft')}>
          <NumberInput
            value={Math.round((clip.crop?.left ?? 0) * 100)}
            min={0}
            max={98}
            step={1}
            width={54}
            suffix="%"
            testid="clip-crop-left"
            onchange={(v) => setCropEdge(clip, 'left', v / 100)}
          />
          <span class="dim">{tr('insp.cropRight')}</span>
          <NumberInput
            value={Math.round((clip.crop?.right ?? 0) * 100)}
            min={0}
            max={98}
            step={1}
            width={54}
            suffix="%"
            testid="clip-crop-right"
            onchange={(v) => setCropEdge(clip, 'right', v / 100)}
          />
        </Field>
        <Field label={tr('insp.cropTop')}>
          <NumberInput
            value={Math.round((clip.crop?.top ?? 0) * 100)}
            min={0}
            max={98}
            step={1}
            width={54}
            suffix="%"
            testid="clip-crop-top"
            onchange={(v) => setCropEdge(clip, 'top', v / 100)}
          />
          <span class="dim">{tr('insp.cropBottom')}</span>
          <NumberInput
            value={Math.round((clip.crop?.bottom ?? 0) * 100)}
            min={0}
            max={98}
            step={1}
            width={54}
            suffix="%"
            testid="clip-crop-bottom"
            onchange={(v) => setCropEdge(clip, 'bottom', v / 100)}
          />
        </Field>
      </div>

      <!--
        四角调整（透视变形）：引擎对任意源生效，但 UI 只在图片 / 视频上开放 ——
        算法 / 纯色 / 文本源的「默认图层矩形」对用户不直观，需求本身也只点名图片。
        手柄在预览画面上（QuadHandles），这一块只管开关与重置。
      -->
      {#if clip.source.type === 'image' || clip.source.type === 'video'}
        <div class="section" data-testid="quad-section">
          <div class="section-head">
            <span class="section-title">{tr('insp.quad')}</span>
            <Checkbox
              checked={!!clip.quad}
              label={tr('insp.quadEnable')}
              testid="clip-quad-enable"
              onchange={(v) =>
                upd(clip, v ? tr('insp.quadEnable') : tr('insp.quadDisable'), (c) => {
                  if (c.kind !== 'source') return;
                  // 恒等四角 = 不调整。字段在但恒等时引擎走旧路径（不丢层）。
                  if (v) c.quad = identityQuad();
                  else delete c.quad;
                })}
            />
          </div>
          {#if clip.quad}
            <p class="note">{tr('insp.quadHint')}</p>
            <Field label={tr('insp.quadAdjust')}>
              <Button
                label={tr('insp.quadReset')}
                icon="rotate-ccw"
                variant="outline"
                testid="clip-quad-reset"
                tipText={tr('insp.quadResetTip')}
                onclick={() =>
                  upd(clip, tr('insp.quadReset'), (c) => {
                    if (c.kind === 'source') c.quad = identityQuad();
                  })}
              />
            </Field>
          {/if}
        </div>
      {/if}

      {#if clip.source.type === 'solid'}
        <Field label={tr('insp.color')}>
          <ColorField
            label={tr('insp.color')}
            value={clip.source.color}
            theme={inspectorTheme}
            testid="clip-color"
            onchange={(v) =>
              upd(clip, tr('insp.changeColor'), (c) => {
                // 纯色片段的颜色直接进 `hexToRgba()`，不认 `@accent1` 这类引用
                // （会退化成品红）。取色卡给的是引用，这里先解析成裸 hex。
                if (c.kind === 'source' && c.source.type === 'solid') {
                  c.source.color = resolveThemeColor(v, inspectorTheme);
                }
              })}
          />
          <span class="dim mono">{clip.source.color}</span>
        </Field>
      {:else if clip.source.type === 'algo'}
        {@const def = getGenerator(clip.source.generator)}
        <div class="algo-head">
          <span class="note algo-name">{tr('insp.algoGenerator', { name: def ? resolveLabel(def.nameKey, tr) : clip.source.generator })}</span>
          <Button
            label={tr('insp.changeAlgo')}
            icon="wand-sparkles"
            variant="outline"
            testid="insp-change-algo"
            onclick={() => (algoPickerOpen = true)}
          />
        </div>
        {#if def}
          {#each visibleParams(def.params, clip.source.params) as p (p.key)}
            {#if p.type === 'range'}
              {#if keyframable(def.kind, p.key)}
                <KeyableField label={resolveLabel(p.labelKey, tr)} min={p.min} max={p.max} step={p.step} {...paramKeyableProps(clip, p)} />
              {:else}
                <!-- 烘焙入参：改了要重烘，所以不能打关键帧（每帧重烘会卡死） -->
                <NumericField
                  label={resolveLabel(p.labelKey, tr)}
                  tipText={tr('insp.bakedParamTip', { label: resolveLabel(p.labelKey, tr) })}
                  min={p.min}
                  max={p.max}
                  step={p.step}
                  value={Number(clip.source.params[p.key] ?? p.defaultValue)}
                  sliderTestid="bake-param-slider"
                  numberTestid="bake-param-number"
                  oninput={(v) => setAlgoParam(clip, p.key, v)}
                />
              {/if}
            {:else if p.type === 'select'}
              <Field label={resolveLabel(p.labelKey, tr)}>
                <Select
                  value={String(clip.source.params[p.key] ?? p.defaultValue)}
                  options={p.options.map((o) => ({ value: o.value, label: resolveLabel(o.labelKey, tr) }))}
                  testid={`algo-param-${p.key}`}
                  optionTestidPrefix={`algo-param-${p.key}-opt`}
                  onchange={(v) => setAlgoParam(clip, p.key, v)}
                />
              </Field>
            {:else if p.type === 'checkbox'}
              <Field label={resolveLabel(p.labelKey, tr)}>
                <Checkbox
                  checked={Number(clip.source.params[p.key] ?? p.defaultValue) !== 0}
                  testid={`algo-param-${p.key}`}
                  onchange={(v) => setAlgoParam(clip, p.key, v ? 1 : 0)}
                />
              </Field>
            {:else if p.type === 'color'}
              <Field label={resolveLabel(p.labelKey, tr)}>
                <ColorField
                  label={resolveLabel(p.labelKey, tr)}
                  value={String(clip.source.params[p.key] ?? p.defaultValue)}
                  theme={inspectorTheme}
                  testid={`algo-param-${p.key}`}
                  onchange={(v) => setAlgoParam(clip, p.key, resolveThemeColor(v, inspectorTheme))}
                />
              </Field>
            {:else if p.type === 'bitmask'}
              <!-- 规则号 / B/S 掩码：位表 + 数值框。同样是烘焙入参（不可打关键帧）。 -->
              <Field label={resolveLabel(p.labelKey, tr)} tipText={tr('insp.bakedParamTip', { label: resolveLabel(p.labelKey, tr) })}>
                <BitmaskField
                  value={Number(clip.source.params[p.key] ?? p.defaultValue)}
                  bits={p.bits}
                  slider={p.slider}
                  groups={p.groups.map((g) => ({ label: resolveLabel(g.labelKey, tr), bits: g.bits, style: g.style }))}
                  presets={p.presets?.map((o) => ({ label: resolveLabel(o.labelKey, tr), value: o.value }))}
                  testid={`algo-param-${p.key}`}
                  oninput={(v) => setAlgoParam(clip, p.key, v)}
                  onchange={(v) => setAlgoParam(clip, p.key, v)}
                />
              </Field>
            {:else if p.type === 'pattern'}
              <Field label={resolveLabel(p.labelKey, tr)} tipText={tr('insp.bakedParamTip', { label: resolveLabel(p.labelKey, tr) })}>
                <PatternField
                  value={String(clip.source.params[p.key] ?? p.defaultValue)}
                  label={resolveLabel(p.labelKey, tr)}
                  mode={p.mode}
                  editorSize={p.editorSize}
                  grid={gridSizeFromDefs(clip.source.params, def.params) ?? undefined}
                  source={patternAssets}
                  colors={{
                    bg: String(clip.source.params.colorBg ?? '#05070f'),
                    live: String(clip.source.params.colorLive ?? '#7fd4ff'),
                  }}
                  testid={`algo-param-${p.key}`}
                  onchange={(v) => setAlgoParam(clip, p.key, v)}
                />
              </Field>
            {:else if p.type === 'text'}
              <!-- 内容入参（候选词库之类）：可编辑但不可打关键帧。 -->
              <Field label={resolveLabel(p.labelKey, tr)} tipText={tr('insp.bakedParamTip', { label: resolveLabel(p.labelKey, tr) })}>
                <TextField
                  value={String(clip.source.params[p.key] ?? p.defaultValue)}
                  ariaLabel={resolveLabel(p.labelKey, tr)}
                  multiline={p.multiline}
                  maxLength={p.maxLength}
                  placeholder={p.placeholderKey ? resolveLabel(p.placeholderKey, tr) : ''}
                  testid={`algo-param-${p.key}`}
                  onchange={(v) => setAlgoParam(clip, p.key, v)}
                />
              </Field>
            {/if}
          {/each}
        {/if}

        {#if algoPickerOpen}
          <AlgoPickerModal
            current={clip.source.generator}
            onclose={() => (algoPickerOpen = false)}
            onapply={(id) => {
              changeAlgo(clip, id);
              algoPickerOpen = false;
            }}
          />
        {/if}
      {:else if clip.source.type === 'image'}
        <!-- 素材没了（被移除 / 打开工程时读不到）时显示「脱机媒体」而不是
             一串 assetId —— 与画面上的占位符同一个说法。 -->
        {@const imgAsset = appState.project.assets[clip.source.assetId]}
        <p class="note">
          {tr('insp.imageAsset', {
            name: imgAsset?.name ?? (appState.isAssetOffline(clip.source.assetId) ? tr('pool.offline') : clip.source.assetId),
          })}
        </p>
      {/if}

      <!--
        两端转场（v13）：入场挂 start、出场挂 end。与片段自身属性不同，它们发生在
        **剪切点**上；另一侧没有片段时那一侧是全透明，所以首尾片段也能做。

        每一端是一个独立区块：同一片段可以同时有入场与出场，混在一个区块里会让人
        以为它们是同一条转场的两个字段。
      -->
      {#each [{ side: 'in' as const }, { side: 'out' as const }] as trSide (trSide.side)}
        {@const side = trSide.side}
        {@const trRef = side === 'out' ? clip.transitionOut : clip.transitionIn}
        {@const trEntry = trRef ? getTransition(trRef.defId) : null}
        {@const cut = transitionInfo ? transitionInfo[side] : null}
        {@const trMax = cut?.ok ? cut.max : 0}
        {@const trThumb = trRef ? transitionThumbUrl(trRef.defId) : null}
        {@const trInfo = trRef ? transitionCatalogInfo(trRef.defId) : null}
        <!-- 目录里没有（工程来自更新的版本）→ 退回显示 id，而不是留一行空白 -->
        {@const trName = trRef ? (trInfo ? tr(trInfo.nameKey) : trRef.defId) : ''}
        {@const transparent = cut?.ok ? (side === 'out' ? cut.to === null : cut.from === null) : false}
        <!-- 出画那块的 testid 保持 v12 的名字：既有 E2E 用它定位。 -->
        <div class="section" data-testid={side === 'out' ? 'transition-section' : 'transition-section-in'}>
          <div class="section-head">
            <span class="section-title">{tr(side === 'out' ? 'insp.transitionOut' : 'insp.transitionIn')}</span>
            {#if trRef}
              <IconButton
                icon="x"
                label={tr('insp.transitionClear')}
                size="sm"
                variant="danger"
                testid={side === 'out' ? 'transition-clear' : 'transition-clear-in'}
                onclick={() => setTransition(clip, side, '')}
              />
            {/if}
          </div>

          {#if trRef && trEntry}
            <div class="tr-current">
              {#if trThumb}
                <img
                  class="tr-thumb"
                  src={trThumb}
                  alt=""
                  draggable="false"
                  loading="lazy"
                  decoding="async"
                  data-testid={side === 'out' ? 'transition-preview' : 'transition-preview-in'}
                />
              {:else}
                <span class="tr-thumb tr-thumb-none" aria-hidden="true"></span>
              {/if}
              <span class="tr-current-meta">
                <span
                  class="tr-name"
                  data-testid={side === 'out' ? 'transition-current-name' : 'transition-current-name-in'}
                >{trName}</span>
                <!-- 中文名之外**始终留着上游 id**：参数名不翻译，靠它回文档查这条转场 -->
                <span class="tr-sub">
                  <span
                    class="tr-id"
                    data-testid={side === 'out' ? 'transition-current-id' : 'transition-current-id-in'}
                  >{trRef.defId}</span>
                  <span class="tr-author">{trEntry.author} · {trEntry.license}</span>
                </span>
              </span>
            </div>
          {/if}

          <Field label={trRef ? tr('insp.transitionChange') : tr('insp.transitionPick')}>
            <Button
              label={trRef ? tr('insp.transitionChange') : tr('insp.transitionPick')}
              icon="blend"
              variant={trRef ? 'outline' : 'accent'}
              testid={side === 'out' ? 'open-transition-picker' : 'open-transition-picker-in'}
              onclick={() => (transitionPickerSide = side)}
            />
          </Field>

          {#if trRef && trEntry}
            <Field label={tr('insp.transitionDuration')}>
              <NumberInput
                value={trRef.duration}
                min={0.05}
                max={trMax > 0 ? trMax : undefined}
                step={0.05}
                width={64}
                suffix="s"
                testid={side === 'out' ? 'transition-duration' : 'transition-duration-in'}
                onchange={(v) => appState.store.setTransitionDuration(clip.id, v, side)}
              />
            </Field>

            {#each trEntry.params as p (p.key)}
              {#if p.type === 'checkbox'}
                <Field label={p.label}>
                  <Checkbox
                    checked={Number(trRef.values[p.key] ?? p.defaultValue) !== 0}
                    testid={`${side === 'out' ? 'transition-param' : 'transition-param-in'}-${p.key}`}
                    onchange={(v) => setTransitionParam(clip, side, p.key, v ? 1 : 0)}
                  />
                </Field>
              {:else}
                <NumericField
                  label={p.label}
                  min={p.min ?? 0}
                  max={p.max ?? 1}
                  step={p.step ?? 0.01}
                  value={Number(trRef.values[p.key] ?? p.defaultValue)}
                  sliderTestid={`${side === 'out' ? 'transition-param' : 'transition-param-in'}-${p.key}`}
                  numberTestid={`${side === 'out' ? 'transition-param-num' : 'transition-param-num-in'}-${p.key}`}
                  oninput={(v) => setTransitionParam(clip, side, p.key, v)}
                />
              {/if}
            {/each}

            {#if transparent}
              <p class="note" data-testid={side === 'out' ? 'transition-transparent' : 'transition-transparent-in'}>
                {tr(side === 'out' ? 'insp.transitionToTransparent' : 'insp.transitionFromTransparent')}
              </p>
            {/if}
            {#if cut && !cut.ok && cut.reason !== 'no-transition'}
              <p class="note insp-warn">
                {tr('insp.transitionInactive')}：{tr(REASON_KEYS[cut.reason as 'shadowed' | 'too-short'])}
              </p>
            {:else if trMax > 0 && trRef.duration > trMax + 1e-9}
              <p class="note insp-warn">
                {tr('insp.transitionClamped', { max: trMax.toFixed(2) })}
              </p>
            {/if}
            {#if clip.fadeSec > 0}
              <p class="note insp-warn">{tr('insp.transitionFadeTip')}</p>
            {/if}
          {/if}
        </div>
      {/each}

      {#if transitionPickerSide}
        <TransitionPickerModal
          current={
            (transitionPickerSide === 'out' ? clip.transitionOut : clip.transitionIn)?.defId ?? null
          }
          onclose={() => (transitionPickerSide = null)}
          onapply={(id) => {
            if (transitionPickerSide) setTransition(clip, transitionPickerSide, id);
            transitionPickerSide = null;
          }}
        />
      {/if}
    {:else if clip.kind === 'effect'}
      {@const gradeNote = gradeWarning(clip.chain)}
      <!--
        降级提示放在作用方式之前：它是**这一条链的前提**（有没有 16 bit），
        而不是某一组参数的说明。
      -->
      {#if gradeNote}
        <p class="note insp-warn" data-testid="grade-precision-warn">{gradeNote}</p>
      {/if}
      <!--
        作用方式：绑定到某个片段（只作用于那一层）或按影响深度作用（下方 N 条轨）。

        两者互斥，所以**同一处只出现一个可编辑项**：绑定时不给深度输入框，解绑后
        深度回到输入框（存的是 0 = 下方全部）。它是**片段级**属性而不是链级，
        所以放在链之前 —— 与「淡变」「混合」那些并列。
      -->
      <Field label={tr('insp.bindClip')} tipText={tr('insp.bindClipTip')}>
        <Select
          value={clip.boundClipId ?? ''}
          options={bindOptions}
          testid="effect-bind-target"
          optionTestidPrefix="effect-bind-opt"
          onchange={(v) => appState.store.setEffectBoundClip(clip.id, v || null)}
        />
      </Field>
      {#if !clip.boundClipId}
        <Field label={tr('insp.affectDepth')} tipText={tr('insp.affectDepthTip')}>
          <NumberInput
            value={clip.affectDepth ?? 0}
            min={0}
            step={1}
            width={64}
            testid="effect-affect-depth"
            onchange={(v) => appState.store.setEffectAffectDepth(clip.id, v)}
          />
        </Field>
      {/if}
      {#if !clip.boundClipId && scopeInfo}
        <!-- 到底影响了哪几条轨是**算出来的**而不是描述的（深度只数启用的轨），
             所以把它显示出来 —— 否则用户只能靠数轨道列表去猜。 -->
        {#if scopeInfo.depth === 0}
          <p class="note" data-testid="effect-scope-all">{tr('insp.affectDepthAll')}</p>
        {:else if scopeInfo.names.length > 0}
          <p class="note" data-testid="effect-scope-tracks">
            {tr('insp.affectDepthTracks', { names: scopeInfo.names.join(tr('common.listSep')) })}
          </p>
        {:else}
          <p class="note insp-warn" data-testid="effect-scope-empty">{tr('insp.affectDepthEmpty')}</p>
        {/if}
      {/if}

      <!--
        工具栏：添加特效 + 折叠/展开全部。

        「添加特效」：七十多个特效用一个下拉选不现实（不能搜、不能筛、看不见效果），
        改成唤起选择器。多选后一次追加到链尾，按选择顺序。

        「折叠/展开全部」：一条链上挂七八个特效时，参数表会长到要滚三四屏；
        折叠只看名字是「这条链到底做了什么」最省事的读法。
      -->
      <div class="fx-tools">
        <Button
          label={tr('insp.addEffect')}
          icon="plus"
          variant="accent"
          testid="add-effect-instance"
          onclick={() => (pickerOpen = true)}
        />
        {#if clip.chain.length > 0}
          <Button
            label={allCollapsed(clip.chain) ? tr('insp.expandAllEffects') : tr('insp.collapseAllEffects')}
            icon={allCollapsed(clip.chain) ? 'chevron-down' : 'chevron-up'}
            variant="outline"
            testid="effect-collapse-all"
            onclick={() => toggleAllCollapsed(clip.chain)}
          />
        {/if}
      </div>

      {#if pickerOpen}
        <EffectPickerModal
          onclose={() => (pickerOpen = false)}
          onapply={(ids) => {
            addEffectInstances(clip, ids);
            pickerOpen = false;
          }}
        />
      {/if}

      {#if clip.chain.length === 0}
        <p class="note">{tr('insp.emptyChain')}</p>
      {:else if clip.chain.length > 1}
        <!-- 链的顺序就是合成顺序，这一点在面板上要明说：卡片顺序不是「列表顺序」 -->
        <p class="note" data-testid="effect-chain-order">{tr('insp.fxOrderHint')}</p>
      {/if}

      <!--
        链的顺序 = 合成的顺序（上方的先作用于下方轨道的画面），所以排序是内容
        而不只是「列表长得顺眼」。拖曳复用 `ui/drag-reorder.ts`，把手是卡片
        左侧的 grip —— 卡片里全是滑杆，不能整卡起拖（一按滑杆就会拖走整张）。
      -->
      <div
        class="fx-chain"
        use:reorder={{
          axis: 'y',
          itemSelector: '[data-fx-item]',
          handleSelector: '[data-fx-handle]',
          onReorder: (from, to) => reorderInstance(clip, from, to),
        }}
      >
        {#each clip.chain as inst, idx (inst.instanceId)}
          {@const entry = getEffect(inst.defId)}
          {@const collapsed = isCollapsed(inst.instanceId)}
          <div class="fx" data-testid="effect-instance" data-fx-item data-collapsed={collapsed ? 'true' : undefined}>
            <div class="fx-head">
              <span class="fx-grip" data-fx-handle title={tr('insp.dragEffect')} aria-hidden="true">
                <Icon name="grip-vertical" size={12} />
              </span>
              <IconButton
                icon={collapsed ? 'chevron-right' : 'chevron-down'}
                label={collapsed ? tr('insp.expandEffect') : tr('insp.collapseEffect')}
                size="sm"
                testid="effect-collapse"
                onclick={() => toggleCollapsed(inst.instanceId)}
              />
              <Checkbox
                checked={inst.enabled}
                ariaLabel={tr('insp.effectEnable')}
                testid="effect-enabled"
                onchange={(v) =>
                  upd(clip, tr('insp.toggleEffect'), (c) => {
                    if (c.kind === 'effect') {
                      const it = c.chain.find((x) => x.instanceId === inst.instanceId);
                      if (it) it.enabled = v;
                    }
                  })}
              />
              <span class="fx-name">{entry ? resolveLabel(entry.nameKey, tr) : inst.defId}</span>
              <IconButton
                icon="arrow-up"
                label={tr('common.up')}
                size="sm"
                disabled={idx === 0}
                testid="effect-move-up"
                onclick={() => moveInstance(clip, inst.instanceId, -1)}
              />
              <IconButton
                icon="arrow-down"
                label={tr('common.down')}
                size="sm"
                disabled={idx === clip.chain.length - 1}
                testid="effect-move-down"
                onclick={() => moveInstance(clip, inst.instanceId, 1)}
              />
              <IconButton
                icon="x"
                label={tr('insp.removeEffect')}
                size="sm"
                variant="danger"
                testid="effect-remove"
                onclick={() => removeInstance(clip, inst.instanceId)}
              />
            </div>
            {#if entry && !collapsed}
              {#each visibleParams(entry.params, inst.values) as p (p.key)}
                {#if p.type === 'range'}
                  <KeyableField label={resolveLabel(p.labelKey, tr)} min={p.min} max={p.max} step={p.step} {...effectParamProps(clip, inst, p)} />
                {:else if p.type === 'select'}
                  <Field label={resolveLabel(p.labelKey, tr)}>
                    <Select
                      value={String(inst.values[p.key] ?? p.defaultValue)}
                      options={p.options.map((o) => ({ value: o.value, label: resolveLabel(o.labelKey, tr) }))}
                      testid={`effect-param-${p.key}`}
                      optionTestidPrefix={`effect-param-${p.key}-opt`}
                      onchange={(v) => setEffectParam(clip, inst, p.key, v)}
                    />
                  </Field>
                {:else if p.type === 'checkbox'}
                  <Field label={resolveLabel(p.labelKey, tr)}>
                    <Checkbox
                      checked={Number(inst.values[p.key] ?? p.defaultValue) !== 0}
                      testid={`effect-param-${p.key}`}
                      onchange={(v) => setEffectParam(clip, inst, p.key, v ? 1 : 0)}
                    />
                  </Field>
                {:else if p.type === 'color'}
                  <Field label={resolveLabel(p.labelKey, tr)}>
                    <ColorField
                      label={resolveLabel(p.labelKey, tr)}
                      value={String(inst.values[p.key] ?? p.defaultValue)}
                      theme={inspectorTheme}
                      testid={`effect-param-${p.key}`}
                      onchange={(v) => setEffectParam(clip, inst, p.key, resolveThemeColor(v, inspectorTheme))}
                    />
                  </Field>
                {:else if p.type === 'bitmask'}
                  <Field label={resolveLabel(p.labelKey, tr)}>
                    <BitmaskField
                      value={Number(inst.values[p.key] ?? p.defaultValue)}
                      bits={p.bits}
                      slider={p.slider}
                      groups={p.groups.map((g) => ({ label: resolveLabel(g.labelKey, tr), bits: g.bits, style: g.style }))}
                      presets={p.presets?.map((o) => ({ label: resolveLabel(o.labelKey, tr), value: o.value }))}
                      testid={`effect-param-${p.key}`}
                      oninput={(v) => setEffectParam(clip, inst, p.key, v)}
                      onchange={(v) => setEffectParam(clip, inst, p.key, v)}
                    />
                  </Field>
                {:else if p.type === 'pattern'}
                  <Field label={resolveLabel(p.labelKey, tr)}>
                    <PatternField
                      value={String(inst.values[p.key] ?? p.defaultValue)}
                      label={resolveLabel(p.labelKey, tr)}
                      mode={p.mode}
                      editorSize={p.editorSize}
                      colors={{
                        bg: String(inst.values.colorBg ?? '#05070f'),
                        live: String(inst.values.colorLive ?? '#7fd4ff'),
                      }}
                      testid={`effect-param-${p.key}`}
                      onchange={(v) => setEffectParam(clip, inst, p.key, v)}
                    />
                  </Field>
                {:else if p.type === 'text'}
                  <Field label={resolveLabel(p.labelKey, tr)}>
                    <TextField
                      value={String(inst.values[p.key] ?? p.defaultValue)}
                      ariaLabel={resolveLabel(p.labelKey, tr)}
                      multiline={p.multiline}
                      maxLength={p.maxLength}
                      placeholder={p.placeholderKey ? resolveLabel(p.placeholderKey, tr) : ''}
                      testid={`effect-param-${p.key}`}
                      onchange={(v) => setEffectParam(clip, inst, p.key, v)}
                    />
                  </Field>
                {/if}
              {/each}
              <!--
                蒙版引用：只有声明了 `mask: true` 的特效才有（`grade-qualifier` 是第一个）。
                接上之后这个实例在渲染时会先算出被引用片段的那一层，所以不接的时候
                它连一次额外的渲染都不产生 —— 不要把这一行做成「总是显示的空字段」。
              -->
              <!-- 每个特效都能接蒙版（缺省的 composite 模式在链上混回）。 -->
              <MaskField clipId={clip.id} {inst} />
            {/if}
          </div>
        {/each}
      </div>
    {:else}
      <Field label={tr('insp.srcIn')}>
        <NumberInput
          value={clip.srcIn}
          min={0}
          step={0.01}
          width={70}
          suffix="s"
          testid="clip-srcin"
          onchange={(v) =>
            upd(clip, tr('insp.changeSrcIn'), (c) => {
              if (c.kind === 'audio') c.srcIn = Math.max(0, v);
            })}
        />
      </Field>
    {/if}

    <div class="actions">
      {#if clip.kind === 'source' && clip.source.type === 'text'}
        <!-- 双击片段也能打开；这里是可发现性更好的显式入口。 -->
        <Button
          label={tr('insp.editTypography')}
          icon="type"
          testid="edit-typography"
          onclick={() => appState.openTypographyTab(clip.id)}
        />
      {:else if clipEditorOf(clip) === 'grade'}
        <!-- 与时间轴上那颗 palette 图标指向同一个动作（判据同一份：ui/clip-editor.ts）。 -->
        <Button
          label={tr('insp.editGrade')}
          icon="palette"
          testid="edit-grade"
          onclick={() => appState.openGradeEditor(clip.id)}
        />
      {/if}
      <Button
        label={tr('insp.splitAtPlayhead')}
        icon="scissors"
        shortcut="S"
        testid="split-at-playhead"
        onclick={() => appState.store.splitClipAt(track.id, clip.id, playT)}
      />
      <Button
        label={tr('common.delete')}
        icon="trash"
        variant="danger"
        shortcut="Del"
        testid="delete-clip"
        onclick={() => appState.removeClips([clip.id])}
      />
    </div>
  {:else}
    <h3>{tr('insp.title')}</h3>
    <p class="placeholder">
      {tr('insp.placeholderSelect')}
      <br />{tr('insp.placeholderRightClick')}
    </p>
  {/if}
</div>

<style>
  .inspector {
    padding: var(--sp-3) var(--sp-4);
  }
  h3 {
    margin: 0 0 var(--sp-3);
    color: var(--text-secondary);
    font-size: var(--fs-xs);
    letter-spacing: 0.08em;
    text-transform: uppercase;
  }
  .track-name {
    margin-left: var(--sp-2);
    color: var(--text-muted);
    text-transform: none;
    letter-spacing: 0;
  }
  .placeholder,
  .note {
    color: var(--text-muted);
    font-size: var(--fs-sm);
    margin: 0 0 var(--sp-2);
  }
  /* 转场落不了地 / 被钳制 / 与 fadeSec 打架时的提示。用 warning 而不是 danger：
     这些都不阻断操作，只是「照这样下去不会按你想的生效」。 */
  .note.insp-warn {
    color: var(--warning);
  }

  /* 算法片段顶部：生成器名 + 「更换算法艺术」按钮。名字占满剩余宽度并省略，
     按钮贴右不换行 —— 名字再长也不该把按钮挤到第二行。 */
  .algo-head {
    display: flex;
    align-items: center;
    gap: var(--sp-2);
    margin-bottom: var(--sp-2);
  }
  .algo-name {
    flex: 1;
    min-width: 0;
    margin: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  /* 区块分隔：转场与「片段自身属性」是两回事（见模板里的注释），靠一条上边线 +
     一个小写字标题把它隔开，而不是靠一个更大的 margin —— margin 在滚动到底部时
     读不出「这里换了一类东西」。 */
  .section {
    margin-top: var(--sp-4);
    padding-top: var(--sp-3);
    border-top: 1px solid var(--border);
  }
  .section-head {
    display: flex;
    align-items: center;
    gap: var(--sp-2);
    margin-bottom: var(--sp-2);
  }
  .section-title {
    flex: 1;
    min-width: 0;
    color: var(--text-secondary);
    font-size: var(--fs-xs);
    letter-spacing: 0.08em;
    text-transform: uppercase;
  }

  /* 当前转场：左侧 16:9 缩略图（50% 进度的那张），右侧 id + 署名 */
  .tr-current {
    display: flex;
    align-items: center;
    gap: var(--sp-3);
    margin-bottom: var(--sp-2);
  }
  .tr-thumb {
    flex-shrink: 0;
    width: 96px;
    aspect-ratio: 16 / 9;
    border: 1px solid var(--border);
    border-radius: 2px;
    object-fit: cover;
    background: #000;
  }
  .tr-thumb-none {
    background: var(--surface-active);
  }
  .tr-current-meta {
    min-width: 0;
  }
  .tr-name {
    display: block;
    overflow: hidden;
    color: var(--text-primary);
    font-size: var(--fs-sm);
    font-weight: 600;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  /* 第二行：上游 id + 署名。等宽、更小、更暗 —— 它是「能查到」的东西，不是要读的。 */
  .tr-sub {
    display: block;
    margin-top: 2px;
    overflow: hidden;
    color: var(--text-muted);
    font-size: var(--fs-xs);
    font-family: var(--font-mono);
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .dim {
    color: var(--text-muted);
    font-size: var(--fs-xs);
  }
  .mono {
    font-family: var(--font-mono);
  }
  .txt {
    flex: 1;
    min-width: 0;
    height: var(--control-h);
  }
  /* 添加特效 + 折叠/展开全部：两个按钮贴一行，窄抽屉里也不换行。 */
  .fx-tools {
    display: flex;
    align-items: center;
    gap: var(--sp-2);
    margin-bottom: var(--sp-3);
  }
  /*
   * 链容器：卡片间距走 `gap` 而不是卡片的 margin —— 拖曳排序（drag-reorder）
   * 靠 `getComputedStyle(container).gap` 算「让位」的位移量，用 margin 的话
   * 它会按 0 算，拖动时下面几张卡的让位距离会少一截。
   */
  .fx-chain {
    display: flex;
    flex-direction: column;
    gap: var(--sp-3);
    margin-bottom: var(--sp-3);
  }
  .fx {
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    padding: var(--sp-2) var(--sp-3);
    background: var(--surface-2);
  }
  .fx-head {
    display: flex;
    align-items: center;
    gap: var(--sp-1);
    margin-bottom: var(--sp-2);
  }
  /* 折叠后没有参数表，标题行下方不需要留白（否则卡片像个空盒子）。 */
  .fx[data-collapsed] .fx-head {
    margin-bottom: 0;
  }
  /* 拖曳把手：卡片里全是滑杆，只有这里能起拖（见 Inspector 模板里的注释）。 */
  .fx-grip {
    display: flex;
    align-items: center;
    justify-content: center;
    align-self: stretch;
    width: 12px;
    color: var(--text-muted);
    cursor: grab;
  }
  .fx-grip:active {
    cursor: grabbing;
  }
  /* 「分离 XY」与关键帧行同一缩进，让它明显从属于上面的两条缩放字段。 */
  .scale-row {
    margin: 0 0 var(--sp-2) var(--sp-6);
  }
  .fx-name {
    flex: 1;
    min-width: 0;
    color: var(--text-primary);
    font-size: var(--fs-sm);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .actions {
    display: flex;
    gap: var(--sp-3);
    margin-top: var(--sp-4);
  }
</style>
