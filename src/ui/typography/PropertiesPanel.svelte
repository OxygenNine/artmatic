<script lang="ts">
  /**
   * PropertiesPanel — 「元素属性」窗格（与图层 / 动画共用右侧同一个位置）。
   *
   * 为什么要有它：填充 / 描边 / 几何这些参数原先散在 Ribbon 里，而 Ribbon 是
   * **按填充方式条件展开**控件的 —— 每切换一次填充方式，整条 Ribbon 的控件
   * 集合就变一次，右侧的按钮整体位移（用户点不到刚瞄准的那个）。这里把
   * 「当前选中元素长什么样」的完整参数收进一个**固定版式**的面板：
   * 控件集合不再随值变化，Ribbon 也能收成稳定的快速入口。
   *
   * 取值一律从 `editorState.selected` 派生（元素是原地改的对象，派生必须
   * 返回新对象、且 version 是依赖，否则模板会静默断更 —— 见 AGENTS §7）。
   * 写入一律走 actions（撤销栈完整的唯一前提）。
   *
   * 多选语义：
   *  - 位置：按首元素为锚整体平移（见 actions.setFrame）；
   *  - 宽 / 高 / 旋转：多选时禁用（「那条边」没有唯一定义）；
   *  - 填充 / 描边：显示首个元素的取值，写入作用于全部同类元素（与 Ribbon 同款）。
   */
  import Icon from '../Icon.svelte';
  import Field from '../controls/Field.svelte';
  import NumberInput from '../controls/NumberInput.svelte';
  import Select from '../controls/Select.svelte';
  import Slider from '../controls/Slider.svelte';
  import Checkbox from '../controls/Checkbox.svelte';
  import IconButton from '../controls/IconButton.svelte';
  import Button from '../controls/Button.svelte';
  import SvgGenPickerModal from './SvgGenPickerModal.svelte';
  import PaintEditor from './PaintEditor.svelte';
import ColorField from '../controls/ColorField.svelte';
  import { appState } from '../app-state.svelte';
  import { editorState } from './editor-state.svelte';
  import { createTypographyActions } from './actions';
  import {
    MIX_BLENDS,
    SHADOW_PRESETS,
    TEXT_SHADOW_PRESETS,
    defaultElementShadow,
    defaultTextShadow,
    textShadowList,
    type ElementShadow,
    type MixBlend,
    type Paint,
    type Stroke,
    type TextStyleShadow,
  } from '../../typography/document';
  import { defaultKeySettings, type KeySettings } from '../../core/image-fx';
  import { resolveThemeColor, themeById } from '../../typography/theme';
  import { generatorById, mergeParams } from '../../typography/svg-gen';
  import { visibleParams } from '../../effects/types';
  import { tr } from '../../i18n/index.svelte';
  import { resolveLabel } from '../../i18n/label';

  /** actions 只是回调的集合，无内部状态；建一次就够（与 TypographyEditor 同款）。 */
  const actions = createTypographyActions();

  /**
   * 当前配色方案（**对象**，含工程自定义方案）。
   *
   * 文档里的 `@slot` 引用可能指向自定义方案（`Project.customThemes`）——
   * 只按 id 查内置表的话那些颜色会静默回落默认方案。传给 PaintEditor 与
   * 这里的两处描边色共用同一份。
   */
  const theme = $derived(themeById(editorState.doc?.theme, appState.project.customThemes));

  /**
   * 当前文档启用的脚本条数。**只读提示**：脚本是文档级的，不属于「选中了
   * 哪个元素」，所以这里不提供任何编辑入口（在「脚本」选项卡里改）。
   */
  const scriptCount = $derived.by(() => {
    void appState.version;
    return (editorState.doc?.scripts ?? []).filter((s) => s.enabled).length;
  });

  /**
   * 颜色 → 可显示的值（配色方案引用解析成真实 hex）。
   *
   * 取色卡不认 `@accent1`，不解析就会把色块画成黑色 —— 看起来像「颜色被
   * 改坏了」，而实际只是没解析。见 PaintEditor 的同名说明。
   */
  function dc(color: string | undefined, fallback: string): string {
    return color ? resolveThemeColor(color, theme) : fallback;
  }

  /** 线型选项。与 Ribbon 的同一套值，标签取自本面板的文案。 */
  const LINE_OPTIONS = [
    { value: 'solid' as const, label: tr('typo.propLineSolid') },
    { value: 'dashed' as const, label: tr('typo.propLineDashed') },
    { value: 'dotted' as const, label: tr('typo.propLineDotted') },
  ];

  const SHAPE_KIND_OPTIONS: { value: Paint['kind']; label: string }[] = [
    { value: 'none', label: tr('typo.propNone') },
    { value: 'solid', label: tr('typo.propFillSolid') },
    { value: 'linear', label: tr('typo.propFillLinear') },
    { value: 'radial', label: tr('typo.propFillRadial') },
    { value: 'texture', label: tr('typo.propFillTexture') },
  ];

  /** 字形填充没有「纯色」：纯色字形走 `style.color`，「无」= 跟随文字色。 */
  const GLYPH_KIND_OPTIONS: { value: Paint['kind']; label: string }[] = SHAPE_KIND_OPTIONS.filter(
    (o) => o.value !== 'solid',
  ).map((o) => (o.value === 'none' ? { ...o, label: tr('typo.propFillFollow') } : o));

  /**
   * 描边填充：`none` 就是**纯色**（走 `Stroke.color`），没有「无」这一档 ——
   * 描边本身有「无」，那是「宽度 0」，不在这里表达（见 document.ts::Stroke.paint）。
   */
  const STROKE_KIND_OPTIONS: { value: Paint['kind']; label: string }[] = [
    { value: 'none', label: tr('typo.propFillSolid') },
    { value: 'linear', label: tr('typo.propFillLinear') },
    { value: 'radial', label: tr('typo.propFillRadial') },
    { value: 'texture', label: tr('typo.propFillTexture') },
  ];

  /** 预设下拉：`''` 是「选一个套上」的占位项（不表示某份数据里的状态）。 */
  function presetOptions(list: { id: string; labelKey: Parameters<typeof tr>[0] }[]) {
    return [
      { value: '', label: tr('typo.propShadowPreset') },
      ...list.map((p) => ({ value: p.id, label: tr(p.labelKey) })),
    ];
  }

  /** 深拷贝一份 Paint：派生必须产出新对象，否则 Svelte 认为值没变（见文件头）。 */
  function clonePaint(p: Paint | undefined): Paint | undefined {
    if (!p) return undefined;
    if (p.kind === 'linear' || p.kind === 'radial') {
      return { ...p, stops: p.stops.map((s) => ({ ...s })) };
    }
    return { ...p };
  }

  const model = $derived.by(() => {
    void appState.version;
    const sel = editorState.selected;
    if (!sel.length) return null;
    const el = sel[0]!;
    return {
      count: sel.length,
      /** 当前元素 id（四角模式要按元素 id 切换）。 */
      id: el.id,
      kind: el.kind,
      frame: { ...el.frame },
      /**
       * 3D 参数。深拷一份：元素是原地改的，嵌套对象共享引用会让 Svelte
       * 认为「值没变」（见文件头的多选说明）。
       */
      transform3d: el.transform3d
        ? {
            ...el.transform3d,
            translate: { ...el.transform3d.translate },
            rotate: { ...el.transform3d.rotate },
            scale: { ...el.transform3d.scale },
            skew: { ...el.transform3d.skew },
            origin: { ...el.transform3d.origin },
          }
        : null,
      opacity: el.opacity,
      blend: el.blend,
      /** 镜头景深（0..1）。0 = 无穷远（不吃镜头）。 */
      depth: el.depth ?? 0,
      /**
       * 阴影 / 虚化（所有元素通用）。逐层深拷：元素是原地改的，
       * 共享引用会让「改了一层」在模板里看起来没变（见文件头的多选说明）。
       */
      shadows: (el.shadows ?? []).map((s) => ({ ...s })),
      blur: el.blur ?? 0,
      /** 图形填充（shape.fill）。 */
      fill: el.kind === 'shape' ? clonePaint(el.fill) : undefined,
      stroke: el.kind === 'shape' && el.stroke ? ({ ...el.stroke } as Stroke) : null,
      /** 字形填充（text.fill）。 */
      glyphFill: el.kind === 'text' ? clonePaint(el.fill) : undefined,
      /** 文本框背景 / 边框（text.boxFill / boxStroke）。 */
      boxFill: el.kind === 'text' ? clonePaint(el.boxFill) : undefined,
      boxStroke: el.kind === 'text' && el.boxStroke ? ({ ...el.boxStroke } as Stroke) : null,
      /** 描边填充方式（图形 stroke.paint / 文本框 boxStroke.paint）。 */
      strokePaint: el.kind === 'shape' ? clonePaint(el.stroke?.paint) : undefined,
      boxStrokePaint: el.kind === 'text' ? clonePaint(el.boxStroke?.paint) : undefined,
      /**
       * 文字阴影（多层）。老工程里 `style.shadow` 是单个对象 ——
       * `textShadowList` 负责归一化，这里不重复判断。
       */
      textShadows:
        el.kind === 'text' ? textShadowList(el.style).map((s) => ({ ...s })) : [],
      textFontSize: el.kind === 'text' ? el.style.fontSize : 1,
      /** 字形描边（-webkit-text-stroke），只对文本框。 */
      glyphStroke: el.kind === 'text' && el.glyphStroke ? ({ ...el.glyphStroke } as Stroke) : null,
      /** 图形路径（「已烘焙」的命令数提示用）。 */
      path: el.kind === 'shape' ? (el.path ?? '') : '',
      /** 生成器状态。浅拷贝：面板只读，写入一律走 actions。 */
      gen:
        el.kind === 'shape' && el.gen
          ? { id: el.gen.id, seed: el.gen.seed, params: { ...el.gen.params } }
          : null,
      genSpec: el.kind === 'shape' ? generatorById(el.gen?.id) : null,
      /** 图片填充（「裁剪为形状」的产物）。有它时面板把填充编辑换成「移除」。 */
      imageFill: el.kind === 'shape' && el.imageFill ? { ...el.imageFill } : null,
      /**
       * 图片专有：抠图 / 四角。
       *
       * 深拷一份：面板只读、写入走 actions / live 手势，且模板要靠**新对象**
       * 才更新（元素是原地改的，见文件头的多选说明）。
       */
      image:
        el.kind === 'image'
          ? {
              key: el.key ? { ...el.key } : null,
              quad: el.quad
                ? {
                    tl: [...el.quad.tl] as [number, number],
                    tr: [...el.quad.tr] as [number, number],
                    br: [...el.quad.br] as [number, number],
                    bl: [...el.quad.bl] as [number, number],
                  }
                : null,
            }
          : null,
    };
  });

  /** 生成器的参数表（已合并默认值）。未知 id ⇒ null，整节降级。 */
  const genParams = $derived(
    model?.gen && model.genSpec ? mergeParams(model.genSpec, model.gen.params) : null,
  );
  /** 按 `visibleWhen` 过滤后的可见参数（模式切换时控件集合会变，见 ParamDef）。 */
  const genVisible = $derived(
    model?.genSpec && genParams ? visibleParams(model.genSpec.params, genParams) : [],
  );
  /** 路径命令数：直接数 `d` 里的命令字母，不重新 build 一遍。 */
  const genCommands = $derived((model?.path?.match(/[MLCZ]/gi) ?? []).length);
  /** 「更换生成器」弹窗（与插入时同一个选择器，只是换标题 + 高亮当前项）。 */
  let genPickerOpen = $state(false);

  const multi = $derived((model?.count ?? 0) > 1);
  /** 旋转：模型存弧度，面板显示度（一位小数）。 */
  const rotDeg = $derived(Math.round((((model?.frame.rot ?? 0) * 180) / Math.PI) * 10) / 10);

  /* ------------------------------------------------- 图片：抠图 / 四角 */

  /**
   * 抠图参数的两条写入路径（与文字输入的「拖动实时 / 松手一笔」同构）。
   *
   * 滑杆的 `oninput` 每移动一格就写文档，走 `live`（**不入撤销栈**）；
   * `onchange`（松手）把这一段结算成一笔。整段用 `beginGesture` 打开事务，
   * 中途不 commit —— 每次 commit 都拍一次工程快照，拖一个滑杆会塞几十条记录。
   */
  function keyLive(id: string, patch: Partial<KeySettings>): void {
    if (!editorState.gestureActive) editorState.beginGesture();
    editorState.live((doc) => {
      const el = doc.elements.find((x) => x.id === id);
      if (!el || el.kind !== 'image') return;
      if (!el.key) el.key = defaultKeySettings();
      Object.assign(el.key, patch);
    });
  }

  function keyCommit(id: string, patch: Partial<KeySettings>): void {
    keyLive(id, patch);
    if (editorState.gestureActive) editorState.endGesture(tr('typo.undo.key'));
  }

  /* ------------------------------------------------- 元素阴影 / 虚化 */

  /**
   * 改第 i 层阴影。
   *
   * 动作层收的是**整份列表**（见 actions.ts::setShadows）：层会增删，
   * 「按下标打补丁」要求调用方维护一份稳定的下标映射，而那份映射正是
   * 「删掉一层之后改到另一层」这类 bug 的来源。
   */
  function setShadowAt(i: number, patch: Partial<ElementShadow>): void {
    if (!model) return;
    actions.setShadows(model.shadows.map((s, j) => (j === i ? { ...s, ...patch } : s)));
  }

  function setShadowAtLive(i: number, patch: Partial<ElementShadow>): void {
    if (!model) return;
    actions.setShadowsLive(model.shadows.map((s, j) => (j === i ? { ...s, ...patch } : s)));
  }

  function addShadow(): void {
    if (!model) return;
    actions.setShadows([...model.shadows.map((s) => ({ ...s })), defaultElementShadow()]);
  }

  function removeShadow(i: number): void {
    if (!model) return;
    actions.setShadows(model.shadows.filter((_, j) => j !== i));
  }

  function applyShadowPreset(id: string): void {
    const p = SHADOW_PRESETS.find((x) => x.id === id);
    if (p) actions.setShadows(p.shadows.map((s) => ({ ...s })));
  }

  /* ------------------------------------------------- 文字阴影 */

  /** 模型存的是**字号倍数**，面板显示 px —— 倍数在面板上没法读（0.045px 是多少？）。 */
  function tsPx(v: number): number {
    return Math.round(v * (model?.textFontSize ?? 1) * 10) / 10;
  }

  function tsRatio(px: number): number {
    return px / Math.max(1, model?.textFontSize ?? 1);
  }

  function setTextShadowAt(i: number, patch: Partial<TextStyleShadow>): void {
    if (!model) return;
    actions.setTextShadow(model.textShadows.map((s, j) => (j === i ? { ...s, ...patch } : s)));
  }

  function setTextShadowAtLive(i: number, patch: Partial<TextStyleShadow>): void {
    if (!model) return;
    actions.setTextShadowLive(model.textShadows.map((s, j) => (j === i ? { ...s, ...patch } : s)));
  }

  function addTextShadow(): void {
    if (!model) return;
    actions.setTextShadow([...model.textShadows.map((s) => ({ ...s })), defaultTextShadow()]);
  }

  function removeTextShadow(i: number): void {
    if (!model) return;
    actions.setTextShadow(model.textShadows.filter((_, j) => j !== i));
  }

  function applyTextShadowPreset(id: string): void {
    const p = TEXT_SHADOW_PRESETS.find((x) => x.id === id);
    if (p) actions.setTextShadow(p.shadows.map((s) => ({ ...s })));
  }

  /** 描边填充是否已经是渐变 / 纹理（线型在那种情况下不生效，见 Stroke.paint）。 */
  function painted(paint: Paint | undefined): boolean {
    return !!paint && paint.kind !== 'none' && paint.kind !== 'solid';
  }
</script>

{#snippet colorRow(label: string, value: string, testid: string, oninput: (v: string) => void)}
  <Field {label} labelWidth={74}>
    <span class="prop-swatch">
      <ColorField
        {label}
        {value}
        {theme}
        testid={testid}
        onchange={oninput}
      />
    </span>
  </Field>
{/snippet}

{#if genPickerOpen && model?.gen}
  <SvgGenPickerModal
    title={tr('gen.changeTypeTitle')}
    current={model.gen.id}
    onclose={() => (genPickerOpen = false)}
    onpick={(id) => {
      genPickerOpen = false;
      actions.setGeneratorType(id);
    }}
  />
{/if}

<aside class="props" data-testid="typo-props">
  {#if !model}
    <p class="props-empty">{tr('typo.propsEmpty')}</p>
  {:else}
    <div class="props-scroll">
      <h4 class="prop-sec">{tr('typo.propTransform')}</h4>
      {#if multi}
        <p class="props-note">{tr('typo.propsMulti', { n: model.count })}</p>
      {/if}
      <!--
        拖动（横向 scrub）走 oninput：连续写文档、松手由 onliveend 结算成一笔。
        键盘步进 / 文本回车只触发 onchange（那是一笔 commit）——两条路径都写同一个值，
        但只有拖动需要「每帧可见」。
      -->
      <Field label={tr('typo.propPos')} labelWidth={50} testid="prop-pos">
        <NumberInput
          value={model.frame.x}
          step={1}
          width={54}
          ariaLabel="X"
          testid="prop-x"
          onchange={(v) => actions.setFrame({ x: v })}
          oninput={(v) => actions.setFrameLive({ x: v })}
          onliveend={() => actions.endLive(tr('typo.undo.frame'))}
        />
        <NumberInput
          value={model.frame.y}
          step={1}
          width={54}
          ariaLabel="Y"
          testid="prop-y"
          onchange={(v) => actions.setFrame({ y: v })}
          oninput={(v) => actions.setFrameLive({ y: v })}
          onliveend={() => actions.endLive(tr('typo.undo.frame'))}
        />
      </Field>
      <Field label={tr('typo.propSize')} labelWidth={50}>
        <NumberInput
          value={model.frame.w}
          min={1}
          step={1}
          width={54}
          disabled={multi}
          ariaLabel={tr('typo.propSize')}
          testid="prop-w"
          onchange={(v) => actions.setFrame({ w: v })}
          oninput={(v) => actions.setFrameLive({ w: v })}
          onliveend={() => actions.endLive(tr('typo.undo.frame'))}
        />
        <NumberInput
          value={model.frame.h}
          min={1}
          step={1}
          width={54}
          disabled={multi}
          ariaLabel={tr('typo.propSize')}
          testid="prop-h"
          onchange={(v) => actions.setFrame({ h: v })}
          oninput={(v) => actions.setFrameLive({ h: v })}
          onliveend={() => actions.endLive(tr('typo.undo.frame'))}
        />
      </Field>
      <Field label={tr('typo.propRotate')} labelWidth={50}>
        <NumberInput
          value={rotDeg}
          step={1}
          precision={1}
          width={62}
          suffix="°"
          disabled={multi}
          ariaLabel={tr('typo.propRotate')}
          testid="prop-rot"
          onchange={(v) => actions.setFrame({ rot: (v * Math.PI) / 180 })}
          oninput={(v) => actions.setFrameLive({ rot: (v * Math.PI) / 180 })}
          onliveend={() => actions.endLive(tr('typo.undo.frame'))}
        />
      </Field>
      <Field label={tr('typo.propOpacity')} labelWidth={50}>
        <NumberInput
          value={Math.round(model.opacity * 100)}
          min={0}
          max={100}
          step={5}
          width={62}
          suffix="%"
          ariaLabel={tr('typo.propOpacity')}
          testid="prop-opacity"
          onchange={(v) => actions.setOpacity(Math.max(0, Math.min(100, v)) / 100)}
          oninput={(v) => actions.setOpacityLive(Math.max(0, Math.min(100, v)) / 100)}
          onliveend={() => actions.endLive(tr('typo.undo.opacity'))}
        />
      </Field>
      <Field label={tr('typo.propBlend')} labelWidth={50}>
        <Select
          value={model.blend}
          options={MIX_BLENDS.map((b) => ({ value: b.id, label: tr(b.labelKey) }))}
          testid="prop-blend"
          optionTestidPrefix="prop-blend-option"
          onchange={(v) => actions.setBlend(v as MixBlend)}
        />
      </Field>
      <!--
        镜头景深：0 = 无穷远（完全不吃镜头），100 = 完全跟随镜头。
        镜头本身（平移 / 缩放 / 旋转）是文档级的，入口在「设计 → 镜头」——
        元素这里只有「你在哪一层」。
      -->
      <Field label={tr('typo.propDepth')} labelWidth={50} tipText={tr('typo.propDepthTip')}>
        <Slider
          min={0}
          max={100}
          step={1}
          value={Math.round(model.depth * 100)}
          ariaLabel={tr('typo.propDepth')}
          testid="prop-depth"
          oninput={(v) => actions.setDepthLive(v / 100)}
          onchange={() => actions.endLive(tr('typo.undo.depth'))}
        />
        <NumberInput
          value={Math.round(model.depth * 100)}
          min={0}
          max={100}
          step={5}
          width={58}
          suffix="%"
          ariaLabel={tr('typo.propDepth')}
          testid="prop-depth-num"
          onchange={(v) => actions.setDepth(Math.max(0, Math.min(100, v)) / 100)}
        />
      </Field>

      <!--
        3D 变换：与 CSS 的 3D 属性一一对应（见 document.ts::Transform3D）。
        存的是参数不是矩阵，渲染走 elementStyle 生成 transform 字符串。
        透视用 perspective() 函数，所以没有「透视原点」——消失点跟着「原点」走。
      -->
      <h4 class="prop-sec">{tr('typo.prop3d')}</h4>
      <Field label={tr('typo.prop3dEnable')} labelWidth={74}>
        <Checkbox
          checked={!!model.transform3d}
          label={tr('typo.prop3dEnable')}
          testid="prop-3d-enable"
          onchange={(v) => actions.setTransform3dEnabled(v)}
        />
      </Field>
      {#if model.transform3d}
        {@const t3 = model.transform3d}
        <Field label={tr('typo.prop3dPerspective')} labelWidth={74}>
          <NumberInput
            value={t3.perspective}
            min={0}
            max={5000}
            step={50}
            width={62}
            suffix="px"
            ariaLabel={tr('typo.prop3dPerspective')}
            testid="prop-3d-persp"
            onchange={(v) => actions.patchTransform3d({ perspective: v })}
            oninput={(v) => actions.patchTransform3dLive({ perspective: v })}
            onliveend={() => actions.endLive(tr('typo.undo.t3d'))}
          />
        </Field>
        <Field label={tr('typo.prop3dRotate')} labelWidth={74}>
          <NumberInput
            value={t3.rotate.x}
            step={5}
            width={50}
            suffix="°"
            ariaLabel={`${tr('typo.prop3dRotate')} X`}
            testid="prop-3d-rotx"
            onchange={(v) => actions.patchTransform3d({ rotate: { x: v } })}
            oninput={(v) => actions.patchTransform3dLive({ rotate: { x: v } })}
            onliveend={() => actions.endLive(tr('typo.undo.t3d'))}
          />
          <NumberInput
            value={t3.rotate.y}
            step={5}
            width={50}
            suffix="°"
            ariaLabel={`${tr('typo.prop3dRotate')} Y`}
            testid="prop-3d-roty"
            onchange={(v) => actions.patchTransform3d({ rotate: { y: v } })}
            oninput={(v) => actions.patchTransform3dLive({ rotate: { y: v } })}
            onliveend={() => actions.endLive(tr('typo.undo.t3d'))}
          />
          <NumberInput
            value={t3.rotate.z}
            step={5}
            width={50}
            suffix="°"
            ariaLabel={`${tr('typo.prop3dRotate')} Z`}
            testid="prop-3d-rotz"
            onchange={(v) => actions.patchTransform3d({ rotate: { z: v } })}
            oninput={(v) => actions.patchTransform3dLive({ rotate: { z: v } })}
            onliveend={() => actions.endLive(tr('typo.undo.t3d'))}
          />
        </Field>
        <Field label={tr('typo.prop3dTranslate')} labelWidth={74}>
          <NumberInput
            value={t3.translate.x}
            step={1}
            width={50}
            suffix="px"
            ariaLabel={`${tr('typo.prop3dTranslate')} X`}
            testid="prop-3d-tx"
            onchange={(v) => actions.patchTransform3d({ translate: { x: v } })}
            oninput={(v) => actions.patchTransform3dLive({ translate: { x: v } })}
            onliveend={() => actions.endLive(tr('typo.undo.t3d'))}
          />
          <NumberInput
            value={t3.translate.y}
            step={1}
            width={50}
            suffix="px"
            ariaLabel={`${tr('typo.prop3dTranslate')} Y`}
            testid="prop-3d-ty"
            onchange={(v) => actions.patchTransform3d({ translate: { y: v } })}
            oninput={(v) => actions.patchTransform3dLive({ translate: { y: v } })}
            onliveend={() => actions.endLive(tr('typo.undo.t3d'))}
          />
          <NumberInput
            value={t3.translate.z}
            step={10}
            width={50}
            suffix="px"
            ariaLabel={`${tr('typo.prop3dTranslate')} Z`}
            testid="prop-3d-tz"
            onchange={(v) => actions.patchTransform3d({ translate: { z: v } })}
            oninput={(v) => actions.patchTransform3dLive({ translate: { z: v } })}
            onliveend={() => actions.endLive(tr('typo.undo.t3d'))}
          />
        </Field>
        <Field label={tr('typo.prop3dScale')} labelWidth={74}>
          <NumberInput
            value={t3.scale.x}
            min={0}
            step={0.05}
            precision={2}
            width={50}
            ariaLabel={`${tr('typo.prop3dScale')} X`}
            testid="prop-3d-sx"
            onchange={(v) => actions.patchTransform3d({ scale: { x: v } })}
            oninput={(v) => actions.patchTransform3dLive({ scale: { x: v } })}
            onliveend={() => actions.endLive(tr('typo.undo.t3d'))}
          />
          <NumberInput
            value={t3.scale.y}
            min={0}
            step={0.05}
            precision={2}
            width={50}
            ariaLabel={`${tr('typo.prop3dScale')} Y`}
            testid="prop-3d-sy"
            onchange={(v) => actions.patchTransform3d({ scale: { y: v } })}
            oninput={(v) => actions.patchTransform3dLive({ scale: { y: v } })}
            onliveend={() => actions.endLive(tr('typo.undo.t3d'))}
          />
          <NumberInput
            value={t3.scale.z}
            min={0}
            step={0.05}
            precision={2}
            width={50}
            ariaLabel={`${tr('typo.prop3dScale')} Z`}
            testid="prop-3d-sz"
            onchange={(v) => actions.patchTransform3d({ scale: { z: v } })}
            oninput={(v) => actions.patchTransform3dLive({ scale: { z: v } })}
            onliveend={() => actions.endLive(tr('typo.undo.t3d'))}
          />
        </Field>
        <Field label={tr('typo.prop3dSkew')} labelWidth={74}>
          <NumberInput
            value={t3.skew.x}
            step={5}
            width={50}
            suffix="°"
            ariaLabel={`${tr('typo.prop3dSkew')} X`}
            testid="prop-3d-skewx"
            onchange={(v) => actions.patchTransform3d({ skew: { x: v } })}
            oninput={(v) => actions.patchTransform3dLive({ skew: { x: v } })}
            onliveend={() => actions.endLive(tr('typo.undo.t3d'))}
          />
          <NumberInput
            value={t3.skew.y}
            step={5}
            width={50}
            suffix="°"
            ariaLabel={`${tr('typo.prop3dSkew')} Y`}
            testid="prop-3d-skewy"
            onchange={(v) => actions.patchTransform3d({ skew: { y: v } })}
            oninput={(v) => actions.patchTransform3dLive({ skew: { y: v } })}
            onliveend={() => actions.endLive(tr('typo.undo.t3d'))}
          />
        </Field>
        <Field label={tr('typo.prop3dOrigin')} labelWidth={74}>
          <NumberInput
            value={Math.round(t3.origin.x * 100)}
            min={0}
            max={100}
            step={5}
            width={50}
            suffix="%"
            ariaLabel={`${tr('typo.prop3dOrigin')} X`}
            testid="prop-3d-ox"
            onchange={(v) => actions.patchTransform3d({ origin: { x: v / 100 } })}
            oninput={(v) => actions.patchTransform3dLive({ origin: { x: v / 100 } })}
            onliveend={() => actions.endLive(tr('typo.undo.t3d'))}
          />
          <NumberInput
            value={Math.round(t3.origin.y * 100)}
            min={0}
            max={100}
            step={5}
            width={50}
            suffix="%"
            ariaLabel={`${tr('typo.prop3dOrigin')} Y`}
            testid="prop-3d-oy"
            onchange={(v) => actions.patchTransform3d({ origin: { y: v / 100 } })}
            oninput={(v) => actions.patchTransform3dLive({ origin: { y: v / 100 } })}
            onliveend={() => actions.endLive(tr('typo.undo.t3d'))}
          />
        </Field>
        <Field label={tr('typo.prop3dBackface')} labelWidth={74}>
          <Checkbox
            checked={t3.backface === 'visible'}
            label={tr('typo.prop3dBackface')}
            testid="prop-3d-backface"
            onchange={(v) => actions.patchTransform3d({ backface: v ? 'visible' : 'hidden' })}
          />
        </Field>
        <Field label={tr('typo.prop3dPreserve')} labelWidth={74}>
          <Checkbox
            checked={t3.style === 'preserve-3d'}
            label={tr('typo.prop3dPreserve')}
            testid="prop-3d-preserve"
            onchange={(v) => actions.patchTransform3d({ style: v ? 'preserve-3d' : 'flat' })}
          />
        </Field>
        <p class="props-note">{tr('typo.prop3dHint')}</p>
      {/if}

      <!--
        阴影 / 虚化：所有元素通用，与小节顺序无关（放在「变换」之后、类型专属
        小节之前 —— 它们是「这个元素整体长什么样」，比填充更外层）。
        渲染是 `filter: blur() drop-shadow(…)`，见 css.ts::elementFilter。
      -->
      <h4 class="prop-sec">{tr('typo.propShadow')}</h4>
      <Field label={tr('typo.propShadowPreset')} labelWidth={50}>
        <Select
          value=""
          options={presetOptions(SHADOW_PRESETS)}
          testid="prop-shadow-preset"
          optionTestidPrefix="prop-shadow-preset-option"
          onchange={(id) => applyShadowPreset(id)}
        />
      </Field>
      {#each model.shadows as sh, i (i)}
        <div class="prop-card" data-testid={`prop-shadow-${i}`}>
          <div class="prop-card-head">
            <span class="prop-card-name">{tr('typo.propShadowLayer', { n: i + 1 })}</span>
            <span class="prop-swatch prop-swatch-sm">
              <ColorField
                label={tr('typo.propShadow')}
                value={dc(sh.color, '#000000')}
                {theme}
                testid={`prop-shadow-color-${i}`}
                onchange={(v) => setShadowAt(i, { color: v })}
              />
            </span>
            <button
              type="button"
              class="prop-ic"
              aria-label={tr('typo.propShadow')}
              data-testid={`prop-shadow-remove-${i}`}
              onclick={() => removeShadow(i)}
            >
              <Icon name="minus" size={11} />
            </button>
          </div>
          <Field label="X / Y" labelWidth={44}>
            <NumberInput
              value={sh.dx}
              step={1}
              width={50}
              suffix="px"
              ariaLabel={`${tr('typo.propShadowOffset')} X`}
              testid={`prop-shadow-dx-${i}`}
              onchange={(v) => setShadowAt(i, { dx: v })}
              oninput={(v) => setShadowAtLive(i, { dx: v })}
              onliveend={() => actions.endLive(tr('typo.undo.shadow'))}
            />
            <NumberInput
              value={sh.dy}
              step={1}
              width={50}
              suffix="px"
              ariaLabel={`${tr('typo.propShadowOffset')} Y`}
              testid={`prop-shadow-dy-${i}`}
              onchange={(v) => setShadowAt(i, { dy: v })}
              oninput={(v) => setShadowAtLive(i, { dy: v })}
              onliveend={() => actions.endLive(tr('typo.undo.shadow'))}
            />
          </Field>
          <Field label={tr('typo.propShadowBlur')} labelWidth={44}>
            <NumberInput
              value={sh.blur}
              min={0}
              step={1}
              width={62}
              suffix="px"
              ariaLabel={tr('typo.propShadowBlur')}
              testid={`prop-shadow-blur-${i}`}
              onchange={(v) => setShadowAt(i, { blur: Math.max(0, v) })}
              oninput={(v) => setShadowAtLive(i, { blur: Math.max(0, v) })}
              onliveend={() => actions.endLive(tr('typo.undo.shadow'))}
            />
          </Field>
        </div>
      {/each}
      <button type="button" class="prop-add" data-testid="prop-shadow-add" onclick={addShadow}>
        <Icon name="plus" size={11} />
        {tr('typo.propShadowAdd')}
      </button>
      <p class="props-note">{tr('typo.propShadowHint')}</p>

      <Field label={tr('typo.propBlur')} labelWidth={50}>
        <NumberInput
          value={model.blur}
          min={0}
          step={1}
          width={62}
          suffix="px"
          ariaLabel={tr('typo.propBlur')}
          testid="prop-blur"
          onchange={(v) => actions.setBlur(Math.max(0, v))}
          oninput={(v) => actions.setBlurLive(Math.max(0, v))}
          onliveend={() => actions.endLive(tr('typo.undo.blur'))}
        />
      </Field>

      {#if model.kind === 'image' && model.image}
        <!--
          抠图 / 四角：与时间轴片段上的同名能力**同一套语义**（同一个
          `core/image-fx.ts` 的色键公式与单应数学），差别只是这里作用在排版
          文档里的一张图片元素上、由 CPU 处理（snapDOM 会丢掉 matrix3d，
          见 typography/image-fx.ts 的文件头）。
        -->
        <h4 class="prop-sec">{tr('typo.propKeying')}</h4>
        <Field label={tr('typo.propKeyEnable')} labelWidth={74}>
          <Checkbox
            checked={!!model.image.key}
            label={tr('typo.propKeyEnable')}
            testid="prop-key-enable"
            onchange={(v) => actions.setImageKey(v)}
          />
        </Field>
        {#if model.image.key}
          {@const k = model.image.key}
          <Field label={tr('typo.propKeyColor')} labelWidth={74}>
            <ColorField
              label={tr('typo.propKeyColor')}
              value={k.color}
              {theme}
              testid="prop-key-color"
              onchange={(v) => actions.patchImageKey({ color: resolveThemeColor(v, theme) })}
            />
          </Field>
          <Field label={tr('typo.propKeyTolerance')} labelWidth={74}>
            <Slider
              min={0}
              max={1}
              step={0.01}
              value={k.tolerance}
              ariaLabel={tr('typo.propKeyTolerance')}
              testid="prop-key-tolerance"
              oninput={(v) => keyLive(model.id, { tolerance: v })}
              onchange={(v) => keyCommit(model.id, { tolerance: v })}
            />
            <NumberInput
              value={k.tolerance}
              min={0}
              max={1}
              step={0.01}
              width={58}
              testid="prop-key-tolerance-num"
              oninput={(v) => keyLive(model.id, { tolerance: v })}
              onchange={(v) => keyCommit(model.id, { tolerance: v })}
            />
          </Field>
          <Field label={tr('typo.propKeySoftness')} labelWidth={74}>
            <Slider
              min={0}
              max={1}
              step={0.01}
              value={k.softness}
              ariaLabel={tr('typo.propKeySoftness')}
              testid="prop-key-softness"
              oninput={(v) => keyLive(model.id, { softness: v })}
              onchange={(v) => keyCommit(model.id, { softness: v })}
            />
            <NumberInput
              value={k.softness}
              min={0}
              max={1}
              step={0.01}
              width={58}
              testid="prop-key-softness-num"
              oninput={(v) => keyLive(model.id, { softness: v })}
              onchange={(v) => keyCommit(model.id, { softness: v })}
            />
          </Field>
          <Field label={tr('typo.propKeySpill')} labelWidth={74}>
            <Slider
              min={0}
              max={1}
              step={0.01}
              value={k.spill}
              ariaLabel={tr('typo.propKeySpill')}
              testid="prop-key-spill"
              oninput={(v) => keyLive(model.id, { spill: v })}
              onchange={(v) => keyCommit(model.id, { spill: v })}
            />
            <NumberInput
              value={k.spill}
              min={0}
              max={1}
              step={0.01}
              width={58}
              testid="prop-key-spill-num"
              oninput={(v) => keyLive(model.id, { spill: v })}
              onchange={(v) => keyCommit(model.id, { spill: v })}
            />
          </Field>
        {/if}

        <h4 class="prop-sec">{tr('typo.propQuad')}</h4>
        <Field label={tr('typo.propQuadEnable')} labelWidth={74}>
          <Checkbox
            checked={!!model.image.quad}
            label={tr('typo.propQuadEnable')}
            testid="prop-quad-enable"
            onchange={(v) => actions.setImageQuad(v)}
          />
        </Field>
        {#if model.image.quad}
          <Field label={tr('typo.propQuadEdit')} labelWidth={74}>
            <Checkbox
              checked={editorState.quadEditId === model.id}
              label={tr('typo.propQuadEdit')}
              testid="prop-quad-edit"
              onchange={(v) => editorState.setQuadEdit(v ? model.id : null)}
            />
            <Button
              label={tr('typo.propQuadReset')}
              icon="rotate-ccw"
              variant="outline"
              testid="prop-quad-reset"
              onclick={() => actions.resetImageQuad()}
            />
          </Field>
          <p class="props-note">{tr('typo.propQuadHint')}</p>
        {/if}
      {/if}

      {#if model.kind === 'shape'}
        <!--
          生成器区放在**填充之前**：它是「这个图形怎么长出来的」，比「填什么色」
          更接近元素的身份。类型 / 种子 / 参数三块版式固定，切换类型时不跳位。
        -->
        {#if model.gen}
          <h4 class="prop-sec">{tr('gen.panelTitle')}</h4>
          {#if !model.genSpec || !genParams}
            <!-- 未知 id（旧档 / 别人的数据）：路径照常渲染，只把参数区降级。 -->
            <p class="props-note">{tr('gen.unknown')}</p>
          {:else}
            <!--
              类型不是下拉而是**弹窗**：二十个生成器靠名字挑不出来，必须看见
              缩略图（与「更换特效 / 转场 / 算法艺术」同一种交互）。
            -->
            <Field label={tr('gen.type')} labelWidth={56}>
              <Button
                label={tr(model.genSpec.labelKey)}
                icon="layout-grid"
                variant="outline"
                testid="prop-gen-type"
                tipText={tr('gen.changeType')}
                onclick={() => (genPickerOpen = true)}
              />
            </Field>
            <Field label={tr('gen.seed')} labelWidth={56}>
              <NumberInput
                value={model.gen.seed}
                min={0}
                step={1}
                precision={0}
                width={64}
                ariaLabel={tr('gen.seed')}
                testid="prop-gen-seed"
                onchange={(v) => actions.setGeneratorSeed(v)}
              />
              <!--
                图标按钮而不是带字按钮：这一栏只有 150px 左右，「换一个」会被
                截成「换一…」。语义靠 tooltip（`gen.reseedTip`）给全。
              -->
              <IconButton
                icon="rotate-cw"
                label={tr('gen.reseed')}
                tipText={tr('gen.reseedTip')}
                size="sm"
                testid="prop-gen-reseed"
                onclick={() => actions.reseedGenerator()}
              />
            </Field>
            {#each genVisible as p (p.key)}
              {#if p.type === 'range'}
                {@const v = Number(genParams[p.key] ?? p.defaultValue)}
                <Field label={resolveLabel(p.labelKey, tr)} labelWidth={56}>
                  <Slider
                    min={p.min}
                    max={p.max}
                    step={p.step}
                    value={v}
                    ariaLabel={resolveLabel(p.labelKey, tr)}
                    testid={`prop-gen-${p.key}-slider`}
                    oninput={(nv) => actions.setGeneratorParamLive(p.key, nv)}
                    onchange={() => actions.endGeneratorParamLive()}
                  />
                  <NumberInput
                    value={v}
                    min={p.min}
                    max={p.max}
                    step={p.step}
                    width={58}
                    ariaLabel={resolveLabel(p.labelKey, tr)}
                    testid={`prop-gen-${p.key}-number`}
                    oninput={(nv) => actions.setGeneratorParamLive(p.key, nv)}
                    onliveend={() => actions.endGeneratorParamLive()}
                    onchange={(nv) => {
                      actions.setGeneratorParamLive(p.key, nv);
                      actions.endGeneratorParamLive();
                    }}
                  />
                </Field>
              {:else if p.type === 'select'}
                <Field label={resolveLabel(p.labelKey, tr)} labelWidth={56}>
                  <Select
                    value={String(genParams[p.key] ?? p.defaultValue)}
                    options={p.options.map((o) => ({
                      value: o.value,
                      label: resolveLabel(o.labelKey, tr),
                    }))}
                    testid={`prop-gen-${p.key}`}
                    optionTestidPrefix={`prop-gen-${p.key}-opt`}
                    onchange={(nv) => actions.setGeneratorParam(p.key, nv)}
                  />
                </Field>
              {:else if p.type === 'checkbox'}
                <Field label={resolveLabel(p.labelKey, tr)} labelWidth={56}>
                  <Checkbox
                    checked={Number(genParams[p.key] ?? p.defaultValue) >= 0.5}
                    label={resolveLabel(p.labelKey, tr)}
                    testid={`prop-gen-${p.key}`}
                    onchange={(on) => actions.setGeneratorParam(p.key, on ? 1 : 0)}
                  />
                </Field>
              {/if}
            {/each}
            <p class="props-note">{tr('gen.commands', { n: genCommands })}</p>
          {/if}
        {/if}
        <h4 class="prop-sec">{tr('typo.propFill')}</h4>
        <!--
          图片填充（「裁剪为形状」的产物）：此时路径的 `fill` 被忽略，只画图。
          不给一个显式的出口的话，用户会在这里调填充色并发现「怎么调都没反应」
          —— 而真正的原因是那块填充被图片盖住了。
        -->
        {#if model.imageFill}
          <Field label={tr('typo.propImageFill')} labelWidth={74}>
            <Button
              label={tr('typo.propImageFillRemove')}
              icon="trash"
              variant="outline"
              testid="prop-image-fill-remove"
              onclick={() => actions.setShapeImageFill(null)}
            />
          </Field>
        {:else}
          <PaintEditor
            paint={model.fill}
            kindOptions={SHAPE_KIND_OPTIONS}
            prefix="prop-fill"
            {theme}
            onkind={(k) => actions.setShapePaint({ kind: k })}
            onpatch={(p) => actions.setShapePaint(p)}
            onpatchlive={(p) => actions.setShapePaintLive(p)}
            onliveend={() => actions.endLive(tr('typo.undo.shapeFill'))}
          />
        {/if}

        <h4 class="prop-sec">{tr('typo.propStroke')}</h4>
        <!--
          纯色时显示色块；渐变 / 纹理时颜色由 PaintEditor 的色标决定，
          再把色块摆在那里就是「调了没反应」的第二个入口（见 Stroke.paint）。
        -->
        {#if !painted(model.strokePaint)}
          {@render colorRow(tr('typo.propStrokeColor'), dc(model.stroke?.color, '#ffffff'), 'prop-stroke-color', (v) =>
            actions.setShapeStroke(v))}
        {/if}
        <Field label={tr('typo.propStrokeWidth')} labelWidth={74}>
          <NumberInput
            value={model.stroke?.width ?? 0}
            min={0}
            step={1}
            width={62}
            suffix="px"
            ariaLabel={tr('typo.propStrokeWidth')}
            testid="prop-stroke-width"
            onchange={(v) => actions.setShapeStrokeWidth(v)}
            oninput={(v) => actions.setShapeStrokeWidthLive(v)}
            onliveend={() => actions.endLive(tr('typo.undo.strokeWidth'))}
          />
        </Field>
        <PaintEditor
          paint={model.strokePaint}
          kindOptions={STROKE_KIND_OPTIONS}
          kindLabel={tr('typo.propStrokePaint')}
          prefix="prop-stroke-paint"
          {theme}
          onkind={(k) => actions.patchStrokePaint('shape', { kind: k })}
          onpatch={(p) => actions.patchStrokePaint('shape', p)}
          onpatchlive={(p) => actions.patchStrokePaintLive('shape', p)}
          onliveend={() => actions.endLive(tr('typo.undo.strokePaint'))}
        />
        <Field label={tr('typo.propStrokeStyle')} labelWidth={74} tipText={tr('typo.propStrokePaintHint')}>
          <Select
            value={model.stroke?.style ?? 'solid'}
            options={LINE_OPTIONS}
            disabled={painted(model.strokePaint)}
            testid="prop-stroke-style"
            optionTestidPrefix="prop-stroke-style-option"
            onchange={(v) => actions.setShapeStrokeStyle(v)}
          />
        </Field>
      {:else if model.kind === 'text'}
        <h4 class="prop-sec">{tr('typo.propTextBg')}</h4>
        <PaintEditor
          paint={model.boxFill}
          kindOptions={SHAPE_KIND_OPTIONS}
          prefix="prop-box"
          {theme}
          onkind={(k) => actions.setTextBoxFill({ kind: k })}
          onpatch={(p) => actions.setTextBoxFill(p)}
          onpatchlive={(p) => actions.setTextBoxFillLive(p)}
          onliveend={() => actions.endLive(tr('typo.undo.shapeFill'))}
        />

        <h4 class="prop-sec">{tr('typo.propTextBorder')}</h4>
        {#if !painted(model.boxStrokePaint)}
          {@render colorRow(tr('typo.propStrokeColor'), dc(model.boxStroke?.color, '#ffffff'), 'prop-box-stroke-color', (v) =>
            actions.setTextBoxStroke({ color: v }))}
        {/if}
        <Field label={tr('typo.propStrokeWidth')} labelWidth={74}>
          <NumberInput
            value={model.boxStroke?.width ?? 0}
            min={0}
            step={1}
            width={62}
            suffix="px"
            ariaLabel={tr('typo.propStrokeWidth')}
            testid="prop-box-stroke-width"
            onchange={(v) => actions.setTextBoxStroke({ width: v })}
            oninput={(v) => actions.setTextBoxStrokeLive({ width: v })}
            onliveend={() => actions.endLive(tr('typo.undo.shapeStroke'))}
          />
        </Field>
        <!--
          描边填充：渐变 / 纹理走 CSS `border-image`（见 css.ts::borderImageCss）。
          宽度仍然靠上面那一格 —— border-image 只在有边框宽度时才画得出来。
        -->
        <PaintEditor
          paint={model.boxStrokePaint}
          kindOptions={STROKE_KIND_OPTIONS}
          kindLabel={tr('typo.propStrokePaint')}
          prefix="prop-box-stroke-paint"
          {theme}
          onkind={(k) => actions.patchStrokePaint('box', { kind: k })}
          onpatch={(p) => actions.patchStrokePaint('box', p)}
          onpatchlive={(p) => actions.patchStrokePaintLive('box', p)}
          onliveend={() => actions.endLive(tr('typo.undo.borderPaint'))}
        />
        <Field label={tr('typo.propStrokeStyle')} labelWidth={74} tipText={tr('typo.propStrokePaintHint')}>
          <Select
            value={model.boxStroke?.style ?? 'solid'}
            options={LINE_OPTIONS}
            disabled={painted(model.boxStrokePaint)}
            testid="prop-box-stroke-style"
            optionTestidPrefix="prop-box-stroke-style-option"
            onchange={(v) => actions.setTextBoxStroke({ style: v })}
          />
        </Field>

        <!--
          文字阴影：**只对文本框**（text-shadow 裁在字形上，图形没有字形）。
          多层 + 预设；面板显示 px，模型存字号倍数（见 TextStyleShadow）。
        -->
        <h4 class="prop-sec">{tr('typo.propTextShadow')}</h4>
        <Field label={tr('typo.propShadowPreset')} labelWidth={50}>
          <Select
            value=""
            options={presetOptions(TEXT_SHADOW_PRESETS)}
            testid="prop-text-shadow-preset"
            optionTestidPrefix="prop-text-shadow-preset-option"
            onchange={(id) => applyTextShadowPreset(id)}
          />
        </Field>
        {#each model.textShadows as sh, i (i)}
          <div class="prop-card" data-testid={`prop-text-shadow-${i}`}>
            <div class="prop-card-head">
              <span class="prop-card-name">{tr('typo.propShadowLayer', { n: i + 1 })}</span>
              <span class="prop-swatch prop-swatch-sm">
                <ColorField
                  label={tr('typo.propTextShadow')}
                  value={dc(sh.color, '#000000')}
                  {theme}
                  testid={`prop-text-shadow-color-${i}`}
                  onchange={(v) => setTextShadowAt(i, { color: v })}
                />
              </span>
              <button
                type="button"
                class="prop-ic"
                aria-label={tr('typo.propTextShadow')}
                data-testid={`prop-text-shadow-remove-${i}`}
                onclick={() => removeTextShadow(i)}
              >
                <Icon name="minus" size={11} />
              </button>
            </div>
            <Field label="X / Y" labelWidth={44}>
              <NumberInput
                value={tsPx(sh.dx)}
                step={1}
                precision={1}
                width={50}
                suffix="px"
                ariaLabel={`${tr('typo.propShadowOffset')} X`}
                testid={`prop-text-shadow-dx-${i}`}
                onchange={(v) => setTextShadowAt(i, { dx: tsRatio(v) })}
                oninput={(v) => setTextShadowAtLive(i, { dx: tsRatio(v) })}
                onliveend={() => actions.endLive(tr('typo.undo.textShadow'))}
              />
              <NumberInput
                value={tsPx(sh.dy)}
                step={1}
                precision={1}
                width={50}
                suffix="px"
                ariaLabel={`${tr('typo.propShadowOffset')} Y`}
                testid={`prop-text-shadow-dy-${i}`}
                onchange={(v) => setTextShadowAt(i, { dy: tsRatio(v) })}
                oninput={(v) => setTextShadowAtLive(i, { dy: tsRatio(v) })}
                onliveend={() => actions.endLive(tr('typo.undo.textShadow'))}
              />
            </Field>
            <Field label={tr('typo.propShadowBlur')} labelWidth={44}>
              <NumberInput
                value={tsPx(sh.blur)}
                min={0}
                step={1}
                precision={1}
                width={62}
                suffix="px"
                ariaLabel={tr('typo.propShadowBlur')}
                testid={`prop-text-shadow-blur-${i}`}
                onchange={(v) => setTextShadowAt(i, { blur: tsRatio(Math.max(0, v)) })}
                oninput={(v) => setTextShadowAtLive(i, { blur: tsRatio(Math.max(0, v)) })}
                onliveend={() => actions.endLive(tr('typo.undo.textShadow'))}
              />
            </Field>
          </div>
        {/each}
        <button type="button" class="prop-add" data-testid="prop-text-shadow-add" onclick={addTextShadow}>
          <Icon name="plus" size={11} />
          {tr('typo.propShadowAdd')}
        </button>

        <h4 class="prop-sec">{tr('typo.propGlyphFill')}</h4>
        <PaintEditor
          paint={model.glyphFill}
          kindOptions={GLYPH_KIND_OPTIONS}
          prefix="prop-glyph"
          {theme}
          onkind={(k) => (k === 'none' ? actions.clearTextFill() : actions.setTextFill({ kind: k }))}
          onpatch={(p) => actions.setTextFill(p)}
          onpatchlive={(p) => actions.setTextFillLive(p)}
          onliveend={() => actions.endLive(tr('typo.undo.shapeFill'))}
        />

        <!--
          字形描边 = 单个可调宽度的属性（`-webkit-text-stroke`），不是四向阴影叠
          —— text-shadow 没有 spread，靠 copy 拼出来的「描边」层数随厚度线性涨、
          尖角还会漏。与「文本框边框」是两件事：那个是矩形框，这个是字形轮廓。
        -->
        <h4 class="prop-sec">{tr('typo.propGlyphStroke')}</h4>
        <!--
          宽度为 0 时颜色仍显示（Word / PPT 同款）：藏起来会让控件集随数值跳动，
          而「先挑色、再调宽」是常见的操作顺序。
        -->
        {@render colorRow(tr('typo.propStrokeColor'), dc(model.glyphStroke?.color, '#ffffff'), 'prop-glyph-stroke-color', (v) =>
          actions.setGlyphStroke({ color: v }))}
        <Field label={tr('typo.propStrokeWidth')} labelWidth={74}>
          <NumberInput
            value={model.glyphStroke?.width ?? 0}
            min={0}
            step={0.5}
            precision={1}
            width={62}
            suffix="px"
            ariaLabel={tr('typo.propGlyphStroke')}
            testid="prop-glyph-stroke-width"
            onchange={(v) => actions.setGlyphStroke({ width: v })}
            oninput={(v) => actions.setGlyphStrokeLive({ width: v })}
            onliveend={() => actions.endLive(tr('typo.undo.glyphStroke'))}
          />
        </Field>
        <p class="props-note">{tr('typo.propGlyphStrokeHint')}</p>
      {/if}

      {#if scriptCount > 0}
        <p class="props-note" data-testid="typo-props-script">
          {tr('typo.scriptControls', { n: scriptCount })}
          {#if !appState.runTypoScripts}
            · {tr('typo.scriptOffBadge')}
          {/if}
        </p>
      {/if}
    </div>
  {/if}
</aside>

<style>
  .props {
    display: grid;
    grid-template-rows: minmax(0, 1fr);
    min-height: 0;
    min-width: 0;
    background: var(--surface-1);
  }
  .props-scroll {
    overflow: auto;
    min-height: 0;
    padding: var(--sp-2) var(--sp-3) var(--sp-5);
  }
  /* 分节标题：比正文重一点、有上间距把它和上一段分开。 */
  .prop-sec {
    margin: var(--sp-3) 0 var(--sp-2);
    font-size: var(--fs-xs);
    font-weight: 600;
    color: var(--text-secondary);
    text-transform: none;
  }
  .prop-sec:first-child {
    margin-top: 0;
  }
  .props-note {
    margin: 0 0 var(--sp-2);
    font-size: var(--fs-xs);
    color: var(--text-muted);
    line-height: 1.5;
  }
  .props-empty {
    padding: var(--sp-4);
    margin: 0;
    font-size: var(--fs-xs);
    color: var(--text-muted);
    line-height: 1.5;
  }
  .prop-swatch {
    position: relative;
    display: block;
    width: 26px;
    height: 18px;
    background: var(--surface-0);
    border: 1px solid var(--border-strong);
    border-radius: var(--radius-sm);
    overflow: hidden;
  }
  .prop-swatch-sm {
    width: 18px;
  }
  /* 一层阴影 = 一张小卡片：标题行（名字 / 色块 / 删除）+ 两行数值。
     卡片边界是必要的 —— 多层阴影连着排时，没有边界就看不出「这几行是一层」。 */
  .prop-card {
    display: grid;
    gap: 2px;
    margin-bottom: var(--sp-2);
    padding: var(--sp-2);
    background: var(--surface-0);
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
  }
  .prop-card-head {
    display: flex;
    align-items: center;
    gap: var(--sp-2);
    margin-bottom: 2px;
  }
  .prop-card-name {
    flex: 1;
    min-width: 0;
    font-size: var(--fs-xs);
    color: var(--text-secondary);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .prop-ic {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 18px;
    height: 18px;
    padding: 0;
    background: transparent;
    border: none;
    border-radius: var(--radius-sm);
    color: var(--text-secondary);
    cursor: pointer;
    flex: none;
  }
  .prop-ic:hover {
    color: var(--text-primary);
    background: var(--surface-hover);
  }
  .prop-add {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    justify-self: start;
    height: 20px;
    margin: 0 0 var(--sp-2);
    padding: 0 var(--sp-2);
    background: transparent;
    border: 1px dashed var(--border-strong);
    border-radius: var(--radius-sm);
    color: var(--text-secondary);
    font-size: var(--fs-xs);
    cursor: pointer;
  }
  .prop-add:hover {
    color: var(--text-primary);
    border-color: var(--accent);
  }
</style>
