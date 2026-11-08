<script lang="ts">
  /**
   * TypographyEditor — 排版片段的主编辑页（顶栏选项卡宿主内容）。
   *
   * 与时间轴主界面是**同格兄弟**：切页时主界面只是 display:none，绝不卸载
   * （卸载 Preview 的 canvas 会丢 WebGL 上下文，renderer 永久坏掉）。
   *
   * 舞台显示的是**实时 DOM**（buildDocDom 的产物），可以选中、框选、拖拽、
   * 缩放、旋转；右上角的「光栅预览」把舞台换成真实光栅结果 —— 它和光栅化
   * 走的是同一个 buildDocDom，两边本就该一致，这个开关是用来**验证**一致的。
   */
  import { onDestroy } from 'svelte';
  import IconButton from '../controls/IconButton.svelte';
  import Select from '../controls/Select.svelte';
  import Slider from '../controls/Slider.svelte';
  import Ribbon from '../ribbon/Ribbon.svelte';
  import { contextualTabIds } from '../ribbon/ribbon-model';
  import { appState } from '../app-state.svelte';
  import { editorState } from './editor-state.svelte';
  import { registerTextRangeRefresher } from './keys';
  import { createTypographyActions } from './actions';
  import {
    CAMERA_TESTID,
    CANVAS_SIZE_TESTID,
    IMAGE_TOOL_TESTIDS,
    buildTypographyTabs,
    type ImageToolId,
  } from './ribbon-defs';
  import ImageAdjustPopover from './ImageAdjustPopover.svelte';
  import ImageRecolorPopover from './ImageRecolorPopover.svelte';
  import ImageFilterPopover from './ImageFilterPopover.svelte';
  import ImageSizePopover from './ImageSizePopover.svelte';
  import { defaultImageAdjust, defaultImageRecolor } from '../../typography/image-effects';
  import { imageSourceFor } from '../../engine/media-assets';
  import SelectionLayer from './SelectionLayer.svelte';
  import QuadEditLayer from './QuadEditLayer.svelte';
  import NodeEditor from './NodeEditor.svelte';
  import SidePanel from './SidePanel.svelte';
  import KeyframePanel from './KeyframePanel.svelte';
  import { kfPanel } from './keyframe-panel-state.svelte';
  import CanvasSizePopover from './CanvasSizePopover.svelte';
  import CameraPopover from './CameraPopover.svelte';
  import BackgroundLayer from './BackgroundLayer.svelte';
  import { bgPreview } from './background-preview.svelte';
  import {
    startMoveGesture,
    startNodeDrag,
    startResizeGesture,
    startRotateGesture,
    startShapeHandleDrag,
    type GestureEnv,
  } from './gestures';
  import {
    buildDocDom,
    caretRange,
    docSignature,
    serializeRuns,
    setCaretRange,
    syncDocDom,
  } from '../../typography/render-dom';
  import { normalizeRuns, runsEquivalent, runsSignature } from '../../typography/rich-text';
  import {
    GUARDS_ATTR,
    RUNS_SIG_ATTR,
    defaultCamera,
    resizeDocument,
    type ShapeElement,
    type Size,
  } from '../../typography/document';

  import { parsePathNodes, type SubPath } from '../../typography/path-nodes';
  import { shapeHandles, type ShapeHandle } from '../../typography/shape-handles';
  import { resolveImageAsset } from '../../typography/image-assets';
  import Menu from '../controls/Menu.svelte';
  import type { MenuItem } from '../controls/menu-model';
  import MediaPoolDrawer from '../MediaPoolDrawer.svelte';
  import AgentDrawer from '../agent/AgentDrawer.svelte';
  import { addToAgentContext, elementContextRefs } from '../agent/context-bridge';
  import { ASSET_DRAG_MIME, poolItemById, type PoolItem } from '../media-pool';
  import { animationSpecs, seekAnimations } from '../../typography/bake-animation';
  import { runScripts } from '../../typography/script/run';
  import { keyframeBodyOf } from '../../typography/animation';
  import CustomCssModal from './CustomCssModal.svelte';
  import ThemeEditorModal from './ThemeEditorModal.svelte';
  import IconPickerModal from './IconPickerModal.svelte';
  import SvgGenPickerModal from './SvgGenPickerModal.svelte';
  import type { IconInsert } from '../../typography/icon-shapes';
  import { cloneAsCustomTheme, themeById } from '../../typography/theme';
  import { canExportSvg } from '../../typography/element-export';
  import { newId } from '../../core/schema';
  import {
    SNAP_PX,
    boundsOf,
    hitTestAll,
    hitTestFirst,
    rectsIntersect,
    type Guide,
    type HandleId,
    type Rect,
  } from '../../typography/geometry';
  import {
    IDENTITY_PARALLAX,
    inverseParallax,
    parallaxIsIdentity,
    parallaxOf,
    screenFrame,
  } from '../../typography/camera';
  import { cameraAt, withCameraAt } from '../../typography/camera-tracks';
  import { isOpaqueAt } from './hit-area';
  import { gridSpacing } from '../../typography/grid';
  import { groupById } from '../../typography/groups';
  import { statusHint } from '../status-hint.svelte';
  import { tr } from '../../i18n/index.svelte';

  const { clipId }: { clipId: string } = $props();

  const PAD = 24;
  /** actions 只是回调的集合，无内部状态；建一次就够。 */
  const actions = createTypographyActions();

  let paperEl = $state<HTMLElement | null>(null);
  let paperWrapEl = $state<HTMLElement | null>(null);
  let rasterHostEl = $state<HTMLElement | null>(null);
  let viewportEl = $state<HTMLElement | null>(null);
  let vpW = $state(0);
  let vpH = $state(0);
  let autoFit = $state(true);
  let marquee = $state<Rect | null>(null);
  let activeRibbonTab = $state('home');
  let customCssOpen = $state(false);
  let themeEditorOpen = $state(false);

  /**
   * 「配色方案编辑器」的初值：当前文档的方案（内置或自定义）。
   *
   * 内置方案 → 弹窗打开即复制成自定义方案（`cloneAsCustomTheme` 在弹窗里做），
   * 标题也随之换成「新建」。判据是「在不在工程的 customThemes 里」。
   */
  const themeEditorDraft = $derived.by(() => {
    void appState.version;
    const d = doc;
    if (!d) return null;
    const custom = appState.project.customThemes ?? [];
    const cur = themeById(d.theme, custom);
    return { theme: cur, isCustom: custom.some((t) => t.id === cur.id) };
  });
  let iconPickerOpen = $state(false);
  let genPickerOpen = $state(false);
  /** 中键拖拽平移中（只为光标形态）。 */
  let panning = $state(false);
  /** 右栏宽度拖曳中（与检查器一致：拖动中分隔条保持高亮）。 */
  let panelResizing = $state(false);
  /** 关键帧面板高度拖曳中。 */
  let kfResizing = $state(false);
  /** 右键菜单的屏幕坐标。null = 关着。 */
  let ctxMenu = $state<{ x: number; y: number } | null>(null);

  /** 关掉右键菜单。所有菜单项动作都先调它，免得菜单留在屏幕上。 */
  function closeCtx(): void {
    ctxMenu = null;
  }

  /* ------------------------------------------------------------ 生命周期 */

  $effect(() => {
    editorState.open(clipId);
  });

  onDestroy(() => editorState.close());

  /* ------------------------------------------------------------ 派生 */

  const doc = $derived.by(() => {
    void appState.version;
    return editorState.doc;
  });

  const signature = $derived.by(() => {
    void appState.version;
    // 脚本的结构预处理（逐字 span / canvas）与「正在编辑哪个文本」都会改变
    // DOM，必须进签名；否则加完脚本舞台不重建，逐字永远不出现。
    return docSignature(doc, {
      scriptsActive: appState.runTypoScripts,
      editingId: editorState.editingTextId,
    });
  });

  /**
   * 画布尺寸读数。
   *
   * **返回新对象**：文档是原地改的普通对象，`$derived` 靠 `===` 传播 —— 直接返回
   * `doc.size` 会在「改画布之后对象引用没变」的那条路上静默断更（舞台不重排、
   * 读数还是旧值，而工程里已经是新尺寸）。见 AGENTS §7「界面实时性」。
   */
  const docSize = $derived.by(() => {
    void appState.version;
    const s = editorState.doc?.size;
    return s ? { w: s.w, h: s.h } : { w: 1920, h: 1080 };
  });

  /**
   * 画布尺寸弹层要的片段属性（`fit` / 缩放 / 是否被曲线接管）。
   *
   * 同样返回新对象，理由与 `docSize` 一样：这些字段都在片段上**原地**改。
   */
  const canvasInfo = $derived.by(() => {
    void appState.version;
    const c = appState.store.findClip(clipId)?.clip;
    if (!c || c.kind !== 'source' || c.source.type !== 'text') return null;
    return {
      fit: c.fit,
      sx: c.transform.sx,
      sy: c.transform.sy,
      keyed: !!c.curves['transform.sx'] || !!c.curves['transform.sy'],
    };
  });

  /**
   * 画布尺寸浮层开着没有，以及它的锚点。
   *
   * 入口是「设计」Ribbon 的按钮 —— `ribbon-defs` 只能发一个无参意图，拿不到
   * 事件目标，所以锚点用 testid 现查（那个 testid 同时也是 E2E 的稳定契约）。
   * 再点一次按钮 = 关掉，所以这里是开合而不是「只开」。
   */
  let canvasOpen = $state(false);
  let canvasAnchor = $state<HTMLElement | null>(null);

  function toggleCanvasSize(): void {
    if (canvasOpen) {
      canvasOpen = false;
      return;
    }
    const anchor = document.querySelector<HTMLElement>(`[data-testid="${CANVAS_SIZE_TESTID}"]`);
    if (!anchor) return;
    canvasAnchor = anchor;
    canvasOpen = true;
  }

  /** 镜头浮层：与画布同一条开合 / 锚点现查的写法（见上）。 */
  let cameraOpen = $state(false);
  let cameraAnchor = $state<HTMLElement | null>(null);

  /**
   * 当前镜头（**播放头时刻**的实际取景：有关键帧的通道取轨道值）。
   *
   * 返回新对象 —— 文档里的对象是原地改的，直接把引用交给浮层会让它读不到变化。
   */
  const cameraView = $derived.by(() => {
    void appState.version;
    const d = doc;
    return d ? cameraAt(d, localSec) : defaultCamera();
  });

  function toggleCamera(): void {
    if (cameraOpen) {
      cameraOpen = false;
      return;
    }
    const anchor = document.querySelector<HTMLElement>(`[data-testid="${CAMERA_TESTID}"]`);
    if (!anchor) return;
    cameraAnchor = anchor;
    cameraOpen = true;
  }

  /* ------------------------------------------------- 图片格式浮层 */

  /**
   * 当前打开的图片浮层（色彩校正 / 重新着色 / 滤镜 / 调整大小）。
   *
   * 与画布浮层同一套：Ribbon 只能发无参意图，锚点按 testid 现查。
   * **同一时刻只开一个** —— 四个浮层都是「选中图片的效果参数」，并列摆出来
   * 只会互相遮挡。
   */
  let imageTool = $state<ImageToolId | null>(null);
  let imageToolAnchor = $state<HTMLElement | null>(null);

  function toggleImageTool(tool: ImageToolId): void {
    if (imageTool === tool) {
      imageTool = null;
      return;
    }
    const anchor = document.querySelector<HTMLElement>(`[data-testid="${IMAGE_TOOL_TESTIDS[tool]}"]`);
    if (!anchor) return;
    imageToolAnchor = anchor;
    imageTool = tool;
  }

  /**
   * 四角调整的开合 = **进出「在画布上拖角」这个模式**。
   *
   * 打开时顺手补一份恒等四角（字段存在 = 变形已启用），关闭时**只退出模式、
   * 不删数据**：用户点灭开关多半是想继续编辑别的，而不是想把拖了半天的透视
   * 扔掉。真要撤销变形走旁边的「复位」；彻底移除字段在元素属性面板里。
   */
  function toggleImageQuad(on: boolean): void {
    if (!on) {
      editorState.setQuadEdit(null);
      return;
    }
    const sel = editorState.selected;
    if (sel.length !== 1 || sel[0]!.kind !== 'image') return;
    if (!sel[0]!.quad) actions.setImageQuad(true);
    editorState.setQuadEdit(sel[0]!.id);
  }

  /** 当前文档的配色方案（浮层里的取色卡要用它画主题色）。 */
  const docTheme = $derived.by(() => {
    void appState.version;
    return themeById(doc?.theme, appState.project.customThemes ?? []);
  });

  /**
   * 选中图片的浮层取值（**深拷**）。
   *
   * 元素是原地改的普通对象：直接把 `el.adjust` 交给浮层，引用不变 ⇒ Svelte 按
   * `===` 认为没变 ⇒ 滑杆读数停在旧值（而画面是对的）。见 AGENTS 的「界面实时性」。
   */
  const imageFx = $derived.by(() => {
    void appState.version;
    const el = editorState.selected.find((e) => e.kind === 'image');
    if (!el || el.kind !== 'image') return null;
    const nat = imageSourceFor(el.assetId);
    const c = el.adjust?.curves;
    const curves = c
      ? {
          ...(c.master ? { master: c.master.map((p) => ({ ...p })) } : {}),
          ...(c.r ? { r: c.r.map((p) => ({ ...p })) } : {}),
          ...(c.g ? { g: c.g.map((p) => ({ ...p })) } : {}),
          ...(c.b ? { b: c.b.map((p) => ({ ...p })) } : {}),
        }
      : undefined;
    return {
      adjust: { ...(el.adjust ?? defaultImageAdjust()), ...(curves ? { curves } : {}) },
      recolor: { ...(el.recolor ?? defaultImageRecolor()) },
      filter: el.filter ? { ...el.filter } : undefined,
      frame: { ...el.frame },
      natural: nat && nat.w > 0 && nat.h > 0 ? { w: nat.w, h: nat.h } : null,
    };
  });

  /** 选中换了（或没图了）就把浮层收掉：留着一个改不了任何东西的浮层。 */
  $effect(() => {
    const has = !!imageFx;
    if (!has && imageTool) queueMicrotask(() => (imageTool = null));
  });

  /**
   * 切走「图片格式」页签也收掉浮层。
   *
   * 锚点按钮随 Contextual Tab 一起消失，留着浮层会飘在一个已经不存在的按钮
   * 原来的位置上（既点不动也看不懂它属于谁）。
   */
  $effect(() => {
    const stray = !!imageTool && activeRibbonTab !== 'image-format';
    if (stray) queueMicrotask(() => (imageTool = null));
  });

  /**
   * 手势途中不允许 commit（见 editor-state 的注释：每一步都会拍快照）。
   * 滑杆松手那一下 `onchange` 紧跟在 live 之后，所以离散提交统一先结算手势。
   */
  function settleThen(label: string, fn: () => void): void {
    if (editorState.gestureActive) editorState.endGesture(label);
    fn();
  }

  /** 曲线的一次离散改动（拖动刚结束时手势还开着）。 */
  function commitImageCurve(channel: 'master' | 'r' | 'g' | 'b', pts: { x: number; y: number }[] | null): void {
    settleThen(tr('typo.undo.imgCurve'), () => actions.setImageCurve(channel, pts));
  }

  /**
   * 改画布尺寸。
   *
   * `scaleContent` 开着时走 `resizeDocument`（元素、字号、阴影、3D 的 px 参数
   * 一起按比例重排）—— 那才是「换画幅」；关掉就只改画布，元素留在原像素位置，
   * 超出的部分被画布边缘裁掉。两种都是真实需求，所以给它一个开关而不是替用户选。
   */
  function setCanvasSize(next: Size, scaleContent: boolean): void {
    editorState.commit(tr('typo.undo.canvasSize'), (d) => {
      if (!scaleContent) {
        d.size = { w: next.w, h: next.h };
        return;
      }
      const resized = resizeDocument(d, next);
      d.size = resized.size;
      d.elements = resized.elements;
    });
  }

  /**
   * 上屏缩放（`transform.sx/sy` 两轴同一个值）。
   *
   * 这个缩放**不进光栅尺寸** —— `runtime.ts::rasterSizeFor` 只认 fit，所以缩小
   * 不会降低文字清晰度，放大则会略微变软（与检查器里的「缩放 X/Y」完全同一件事）。
   */
  function setCanvasScale(v: number): void {
    appState.store.updateClip(clipId, tr('typo.undo.canvasScale'), (c) => {
      if (c.kind !== 'source') return;
      c.transform.sx = v;
      c.transform.sy = v;
    });
  }

  const selection = $derived.by(() => {
    void appState.version;
    return editorState.selected;
  });

  /**
   * 选区框。
   *
   * **单选时用元素自己的框（含 rot）**，不是未旋转的 AABB —— 单个元素绕自身
   * 中心旋转时 x/y/w/h 一点没变（只有 rot 变），用 AABB 的话框会纹丝不动，
   * 看着像「只有图形在转，框没跟上」。
   * 多选时用整个选区的 AABB（那一堆角度没有统一的说法）。
   */
  const selectionBox = $derived.by(() => {
    void appState.version;
    const d = viewDoc;
    if (!d) return null;
    const sel = editorState.selected;
    if (sel.length === 1) {
      // **屏幕**框（含镜头视差），与元素实际画出来的位置一致。
      const f = screenFrame(d, sel[0]!);
      return { x: f.x, y: f.y, w: f.w, h: f.h, rot: f.rot };
    }
    const rects = sel.map((e) => screenFrame(d, e));
    if (!rects.length) return null;
    const r = boundsOf(rects.map((f, i) => ({ id: sel[i]!.id, x: f.x, y: f.y, w: f.w, h: f.h })));
    return { x: r.x, y: r.y, w: r.w, h: r.h, rot: 0 };
  });

  /**
   * 正在做四角调整的图片元素（null = 不显示四角手柄）。
   *
   * 包一层 `$derived` 并读 version：`editorState.quadEdit` 返回的是元素本身
   * （原地改），直接读它不会在 `el.quad` 变化时更新 —— 与 `nodeEdit` 同一套
   * 理由，见 AGENTS §7「界面实时性」。
   */
  const quadEditEl = $derived.by(() => {
    void appState.version;
    return editorState.quadEdit;
  });

  /**
   * 每个选中元素的框 —— **返回新对象**，且带上 rot。
   *
   * 不能直接在模板里读 `el.frame.x`：元素是原地改的，Svelte 5 的模板 effect
   * 靠 `===` 判断传播，对象引用没变就静默不更新。见 AGENTS §7。
   */
  const selectionRects = $derived.by(() => {
    void appState.version;
    const d = viewDoc;
    const sel = editorState.selected;
    return sel.map((e) => {
      const f = d ? screenFrame(d, e) : e.frame;
      return { id: e.id, x: f.x, y: f.y, w: f.w, h: f.h, rot: f.rot };
    });
  });

  /** 弧度 → CSS `rotate()`。与 css.ts 的 elementStyle 用同一套角度约定。 */  function rotCss(rad: number): string | undefined {
    return rad ? `rotate(${(rad * 180) / Math.PI}deg)` : undefined;
  }

  /**
   * 正在做顶点 / 控制点编辑的那个图形。
   *
   * 包一层 `$derived`：`editorState.nodeEdit` 是个 getter，模板里直接读它在
   * 路径每帧变化时不一定重算（它返回的是同一个元素对象），而节点层必须跟着
   * `el.path` 变。
   */
  const nodeEditEl = $derived(editorState.nodeEdit);

  /**
   * 单选一个图形 —— **形状控制点**的显示条件。
   *
   * 控制点不需要任何模式：它改的是图形自身的参数（圆角 / 谷半径 / 壁厚 / 张角），
   * 与「拖右下角把手改尺寸」是同一层级的东西，选中就该能拖。要求用户先点一次
   * 「编辑顶点」才看得到圆角手柄，是拿模式去挡一个本来没有模式的操作。
   *
   * 多选时不显示：那时把手属于谁没有答案。自定义路径也没有（`shapeHandles`
   * 对它返回空数组），它的可调之处是顶点。
   */
  const soloShape = $derived.by((): ShapeElement | null => {
    const sel = selection;
    return sel.length === 1 && sel[0]!.kind === 'shape' ? (sel[0] as ShapeElement) : null;
  });

  /*
   * 顶点层的两份数据在这里算好再传下去。
   *
   * `void appState.version` 不是仪式：元素是**原地改的普通对象**，读它的属性
   * 建立不起响应式依赖 —— 少了这一句，拖完锚点锚点不会动、转成路径之后
   * 形状控制点还赖在屏幕上（都实测过）。与 `selectionRects` 同一套约定。
   */
  const nodeSubs = $derived.by((): SubPath[] => {
    void appState.version;
    const el = nodeEditEl;
    return el && el.shape === 'svg' ? parsePathNodes(el.path ?? '') : [];
  });

  const nodeHandles = $derived.by((): ShapeHandle[] => {
    void appState.version;
    const el = nodeEditEl ?? soloShape;
    return el ? shapeHandles(el) : [];
  });

  const contextualActive = $derived(
    contextualTabIds(selection, { soleGroup: !!editorState.soleSelectedGroupId }),
  );

  /** 选区恰好是一个完整组合时，那个组合的定义（「组合格式」控件的取值来源）。 */
  const soleGroup = $derived.by(() => {
    void appState.version;
    const gid = editorState.soleSelectedGroupId;
    const d = doc;
    if (!gid || !d) return null;
    return groupById(d, gid);
  });

  const tabs = $derived.by(() => {
    void appState.version;
    void appState.typoAlignTarget;
    const d = doc;
    if (!d) return [];
    return buildTypographyTabs(
      {
        doc: d,
        selection,
        alignTarget: appState.typoAlignTarget,
        fontFamilies: appState.fontFamilies,
        localFontFamilies: appState.localFontFamilies,
        supportsLocalFonts: appState.supportsLocalFonts,
        onOpenCustomCss: () => (customCssOpen = true),
        onOpenIconPicker: () => (iconPickerOpen = true),
        onOpenGenPicker: () => (genPickerOpen = true),
        mediaPoolOpen: appState.mediaPoolOpen,
        onToggleMediaPool: () => appState.toggleMediaPool(),
        onFlatten: () => actions.flattenToImage(appState.playT - (editorState.clip?.start ?? 0)),
        grid: gridPrefs,
        onGrid: (patch) => appState.setTypoGrid(patch),
        soleGroup,
        // 行内选区直接给：它比 editingTextId 活得久（点 Ribbon 的输入框会让编辑区
        // 失焦但选区仍该是作用对象），失效由 setSelection / clearSelection 负责清。
        spanRange: editorState.textRange,
        nodeEditing: !!editorState.nodeEditId,
        customThemes: appState.project.customThemes ?? [],
        onOpenThemeEditor: () => (themeEditorOpen = true),
        onOpenCanvasSize: toggleCanvasSize,
        onOpenCamera: toggleCamera,
        onOpenImageTool: toggleImageTool,
        onImageQuad: toggleImageQuad,
        quadEditing: !!editorState.quadEditId,
        imageTool,
        painter: editorState.painter?.kind ?? null,
      },
      actions,
    );
  });

  /** 「自定义 CSS」弹窗的初始内容：当前动画的 keyframes 体。 */
  const currentKeyframes = $derived.by(() => {
    void appState.version;
    const first = selection.flatMap((e) => e.animations)[0];
    return first ? keyframeBodyOf(first) : '';
  });

  /**
   * 舞台的时钟（绝对秒）= 工程播放头。
   *
   * **只有一份**：底栏进度条、关键帧面板的播放头、时间轴播放头、元素动画、底图
   * 取帧读的都是 `appState.playT`（硬约束 1.1）。这里曾经有过一份「局部预览时间」
   * 盖住它，后果是「拖底栏滑块，关键帧面板的播放头不动」—— 看着是同一个播放头，
   * 实际是两份状态。
   */
  const stageTime = $derived.by(() => {
    void appState.playT;
    return appState.playT;
  });

  /** 片段内本地时间 —— 舞台上的 CSS 动画就是被它 seek 的（唯一时钟仍是 t）。 */
  const localSec = $derived.by(() => {
    const clip = editorState.clip;
    return clip ? stageTime - clip.start : 0;
  });

  /**
   * **播放头时刻的文档视图**：镜头关键帧已经解算进 `camera`。
   *
   * 舞台 / 选择框 / 命中测试 / 手势全读它。没有镜头轨道时它就是 `doc` 本身
   * （`withCameraAt` 的快路径），所以这是零成本的 —— 也正因为如此，**不要**
   * 拿它当依赖去建 DOM：那会让每一帧重建整棵舞台（见下面的 build effect）。
   */
  const viewDoc = $derived.by(() => {
    /*
     * `void appState.version` 是**必需的**，不是冗余：`doc` 是原地改的普通对象，
     * `$derived` 靠 `===` 传播 —— 上游 `doc` 重算后返回的还是同一个引用，
     * 不直接订阅 version 的话这里永远不会重算（同一份大小写陷阱见 `docSize`）。
     * 表现是「加了关键帧、拖了播放头，画面纹丝不动，但文档里明明已经变了」。
     */
    void appState.version;
    const d = doc;
    return d ? withCameraAt(d, localSec) : null;
  });

  /**
   * 命中 / 框选用的一组屏幕框。
   *
   * 必须是派生值而不是每次点击现算：`screenRects` 要遍历全部元素并做一次相似
   * 变换，而命中测试在一次 pointerdown 里被调 3 次（hitAt / hitIdsAt / hitTopAt）。
   */
  const viewRects = $derived.by(() => {
    void appState.version;
    return viewDoc ? editorState.screenRects(viewDoc) : [];
  });

  /** 片段时长（脚本的 `ctx.duration`；`0` 会让模板里的归一化变成 NaN）。 */
  const clipDuration = $derived.by(() => {
    const clip = editorState.clip;
    return clip ? Math.max(0.001, clip.end - clip.start) : 1;
  });

  /**
   * 时间量化到整帧，供光栅预览当依赖用。
   * 直接用 localSec 会让播放时每帧重烘一张全尺寸位图（每帧几十毫秒）。
   */
  const rasterFrame = $derived.by(() => {
    const clip = editorState.clip;
    if (!clip) return 0;
    return Math.round((stageTime - clip.start) * appState.store.project.fps);
  });

  const zoom = $derived(editorState.zoom);

  /* ------------------------------------------------------------ 网格 / 线框 */

  const gridPrefs = $derived.by(() => {
    void appState.typoGrid;
    return appState.typoGrid;
  });

  /** 一格在文档坐标里的尺寸。百分比模式在这里换算成 px，下游只认 px。 */
  const gridStep = $derived(gridSpacing(gridPrefs, docSize));

  const frameVisible = $derived(gridPrefs.frame);

  const missingFonts = $derived.by(() => {
    void appState.version;
    // 字体表变了（导入 / 注册内置）也要重算 —— 注册不动 project store 的 version，
    // 只订阅 version 的话「导入完提示不消失」。
    void appState.fontFamilies;
    const d = doc;
    return d ? appState.fonts.missing(d) : [];
  });

  /* ------------------------------------------------------------ 舞台 DOM */

  // 结构变了才重建：纯几何改动走 syncDocDom。重建会丢掉正在编辑的
  // contenteditable 的选区，用户打到一半光标就飞了。
  $effect(() => {
    const sig = signature;
    const d = doc;
    if (!paperEl || !d || !sig) return;
    // resolveImage 必须传：文档里图片元素只存 assetId，舞台要靠它解引用成
    // 对象 URL。漏传的表现是「插入图片后舞台一片空白，但片段预览正常」
    // —— 光栅化那条路（runtime.ts）自己带了 resolver，所以只有舞台缺。
    // isImageOffline + offlineLabel：素材不存在时画「脱机媒体」占位符
    // （与时间轴上的图片 / 视频片段同一形态，判据唯一实现在 appState）。
    paperEl.replaceChildren(
      buildDocDom(d, {
        resolveImage: resolveImageAsset,
        scriptsActive: appState.runTypoScripts,
        editingId: editorState.editingTextId,
        isImageOffline: (id) => appState.isAssetOffline(id),
        offlineLabel: tr('pool.offline'),
        customThemes: appState.project.customThemes ?? [],
        // 图片的抠图 / 四角是 CPU 异步处理的（typography/image-fx.ts）：
        // 就绪后 bump 一次 version，下面的 syncDocDom effect 会把 `<img>`
        // 换成处理好的 `<canvas>`。只是重绘（内容没变），所以走 invalidate。
        onImageFxReady: () => appState.store.invalidate(),
      }),
    );
  });

  // 版本或播放头变了就就地刷新样式，并把动画 seek 到当前时刻。
  $effect(() => {
    void appState.version;
    const ls = localSec;
    // 镜头有轨道时它逐帧是新的对象（浅拷贝）：这正是「就地刷新」要的依赖。
    const d = viewDoc;
    const root = paperEl;
    if (!d || !root) return;
    // 注意传的是 `.paper` 这个**外层容器**：syncDocDom 自己会往下找文档根。
    syncDocDom(root, d, {
      editingId: editorState.editingTextId,
      scriptsActive: appState.runTypoScripts,
      resolveImage: resolveImageAsset,
      isImageOffline: (id) => appState.isAssetOffline(id),
      offlineLabel: tr('pool.offline'),
      customThemes: appState.project.customThemes ?? [],
      onImageFxReady: () => appState.store.invalidate(),
    });
    restoreCaretIfNeeded();
    seekAnimations(root, animationSpecs(d), ls);
    /*
     * 与光栅化**同一个函数、同一个顺序**（烘焙动画 → 跑脚本）。
     * 舞台没有 rAF 循环：`localSec` 一变这个 effect 就重跑，求值是同步的，
     * 所以画面上不会出现「脚本慢了一帧」的错位。
     */
    runScripts({
      doc: d,
      root,
      localSec: ls,
      fps: appState.store.project.fps,
      duration: clipDuration,
      seed: appState.store.project.seed,
      active: appState.runTypoScripts,
    });
  });

  /**
   * 进入编辑态后把焦点给文本框。
   *
   * **刻意不在这里全选。** 原来会 `selectNodeContents` 把所有文字选中，于是
   * 双击进来就是「整段高亮」状态：用户接着单击想挪光标，那一下只是把已有的
   * 选区收拢，看起来像「又选中了整个文本框」，再打字就整段替换。Office 的
   * 行为是双击只把光标放到点击处 —— 光标位置由 `onStageDblClick` 按点击点放。
   *
   * `document.activeElement !== node` 这个判断不能省：效果每次重跑都 focus 的话，
   * 用户打字打到一半就会被重排光标。
   */
  $effect(() => {
    const id = editorState.editingTextId;
    if (!id) return;
    const node = paperEl?.querySelector<HTMLElement>(`[data-el-id="${id}"] .typo-text`);
    if (!node || document.activeElement === node) return;
    node.focus();
  });

  /**
   * 把光标放到屏幕坐标处。
   *
   * `caretRangeFromPoint` 是 Chromium/WebKit 的扩展，Firefox 走
   * `caretPositionFromPoint`。两个都拿不到（或落点不在这个文本框里）时
   * **什么都不做**，由浏览器自己的单击结果说了算 —— 不强行塞一个「文末光标」，
   * 那会在用户明明点在中间时把光标扔到末尾。
   */
  function placeCaretAt(node: HTMLElement, clientX: number, clientY: number): void {
    const sel = window.getSelection();
    if (!sel) return;
    const d = document as Document & {
      caretRangeFromPoint?: (x: number, y: number) => Range | null;
      caretPositionFromPoint?: (x: number, y: number) => { offsetNode: Node; offset: number } | null;
    };
    let range = d.caretRangeFromPoint?.(clientX, clientY) ?? null;
    if (!range && d.caretPositionFromPoint) {
      const pos = d.caretPositionFromPoint(clientX, clientY);
      if (pos) {
        range = document.createRange();
        range.setStart(pos.offsetNode, pos.offset);
        range.collapse(true);
      }
    }
    if (!range || !node.contains(range.startContainer)) return;
    sel.removeAllRanges();
    sel.addRange(range);
  }

  // 光栅预览：只在「文档内容变了 / 帧号变了 / 停止播放」时重烘。
  // 播放中不重烘 —— 它是用来核对「所见即所得」的，不是播放器。
  $effect(() => {
    void signature;
    void appState.version;
    void rasterFrame;
    const playing = appState.playing;
    const d = doc;
    const runtime = appState.textRaster;
    const host = rasterHostEl;
    // 局部播放期间也不重烘：它是用来核对「所见即所得」的，不是播放器。
    if (!editorState.rasterPreview || !d || !runtime || !host || playing || bgPreview.playing) {
      if (host) host.replaceChildren();
      return;
    }
    let cancelled = false;
    const ls = localSec;
    void runtime
      .rasterizeOnce(d, d.size.w, d.size.h, ls, clipDuration)
      .then((canvas) => {
        if (cancelled) return;
        // canvas 的固有尺寸是**文档像素**（d.size.w × d.size.h），而 host 是按
        // 当前 zoom 算的。不显式压到 100% 的话它会按固有尺寸显示 —— 表现为
        // 「光栅预览比可编辑画面大一圈」（用户报的「一大一小重叠」就是这个）。
        canvas.style.width = '100%';
        canvas.style.height = '100%';
        canvas.style.display = 'block';
        host.replaceChildren(canvas);
      })
      .catch(() => {
        if (!cancelled) host.replaceChildren();
      });
    return () => {
      cancelled = true;
    };
  });

  /* ------------------------------------------------------------ 视口尺寸 */

  $effect(() => {
    const el = viewportEl;
    if (!el) return;
    const measure = (): void => {
      vpW = el.clientWidth;
      vpH = el.clientHeight;
    };
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    measure();
    return () => ro.disconnect();
  });

  // 自动适配：留 48px 边距，放大不超过 1:1（放大了只是更模糊）。
  $effect(() => {
    if (!autoFit || !vpW || !vpH) return;
    const z = Math.min((vpW - 48) / docSize.w, (vpH - 48) / docSize.h, 1);
    if (z > 0) editorState.setZoom(z);
  });

  function zoomBy(f: number): void {
    autoFit = false;
    editorState.setZoom(editorState.zoom * f);
  }

  function zoomFit(): void {
    autoFit = true;
    const z = Math.min((vpW - 48) / docSize.w, (vpH - 48) / docSize.h, 1);
    if (z > 0) editorState.setZoom(z);
  }

  /**
   * 以某个屏幕点为锚缩放 —— Ctrl+滚轮 / 触控板双指缩放走这里。
   *
   * 数学：内容坐标 = `paperWrap.offsetLeft + 文档坐标 × zoom`。
   * 想让 (clientX) 底下的那个文档点**不动**，就得让缩放后它的内容坐标
   * 仍然对应同一个屏幕位置 ⇒ `scrollLeft = offsetLeft' + docX·zoom' - (clientX - rect.left)`。
   *
   * `offsetLeft'` 必须**在布局更新后**再读：paper-wrap 是 `margin: auto` 居中的，
   * 缩小到比视口窄时它的偏移会变，用旧值算出来的锚点会整体偏一截。
   * 所以缩放先落盘，滚动位置放在 rAF 里补。
   */
  function zoomAt(clientX: number, clientY: number, factor: number): void {
    const vp = viewportEl;
    const wrap = paperWrapEl;
    if (!vp || !wrap) return;
    const rect = vp.getBoundingClientRect();
    const z0 = editorState.zoom;
    const docX = (clientX - (rect.left - vp.scrollLeft + wrap.offsetLeft)) / z0;
    const docY = (clientY - (rect.top - vp.scrollTop + wrap.offsetTop)) / z0;

    autoFit = false;
    editorState.setZoom(z0 * factor);
    const z1 = editorState.zoom;
    if (z1 === z0) return;

    requestAnimationFrame(() => {
      vp.scrollLeft = wrap.offsetLeft + docX * z1 - (clientX - rect.left);
      vp.scrollTop = wrap.offsetTop + docY * z1 - (clientY - rect.top);
    });
  }

  /** Ctrl（或 ⌘）+ 滚轮 / 双指捏合。浏览器原生缩放必须挡掉。 */
  $effect(() => {
    const el = viewportEl;
    if (!el) return;
    const onWheel = (e: WheelEvent): void => {
      // 触控板双指捏合在 Chromium 里就是 `ctrlKey === true` 的 wheel，
      // 与「Ctrl + 滚轮」共用一条路 —— 不需要单独处理 gesturestart。
      if (!e.ctrlKey && !e.metaKey) return;
      e.preventDefault();
      zoomAt(e.clientX, e.clientY, Math.exp(-e.deltaY * 0.0018));
    };
    // 必须 passive:false，否则 preventDefault 无效、页面会跟着缩放。
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  });

  /**
   * 中键拖拽平移。
   *
   * 原生中键在 Windows 上是「自动滚动」（出现那个四向圆圈），必须自己接管 ——
   * `preventDefault` 掉 pointerdown 还不够，`auxclick` 也要挡，否则某些构建
   * 里中键松手仍会触发默认行为。
   */
  function startPan(e: PointerEvent): void {
    const vp = viewportEl;
    if (!vp) return;
    e.preventDefault();
    const startX = e.clientX;
    const startY = e.clientY;
    const sl = vp.scrollLeft;
    const st = vp.scrollTop;
    panning = true;

    const onMove = (ev: PointerEvent): void => {
      vp.scrollLeft = sl - (ev.clientX - startX);
      vp.scrollTop = st - (ev.clientY - startY);
    };
    const onUp = (): void => {
      panning = false;
      window.removeEventListener('pointermove', onMove);
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp, { once: true });
    window.addEventListener('pointercancel', onUp, { once: true });
  }

  /** 缩放百分比（滑杆与读数共用同一个取整口径）。 */
  const zoomPct = $derived(Math.round(zoom * 100));

  function setZoomPct(pct: number): void {
    autoFit = false;
    editorState.setZoom(pct / 100);
  }

  /* ------------------------------------------------------------ 背景预览 */

  /** 当前片段的时长（进度条量程）。至少 0.001 免得量程为 0。 */
  const clipDur = $derived.by(() => {
    void appState.version;
    const c = editorState.clip;
    return c ? Math.max(0.001, c.end - c.start) : 1;
  });

  /** 进度条读数：播放头在片段内的位置（秒），夹进 [0, clipDur]。 */
  const bgLocalSec = $derived.by(() => {
    void appState.playT;
    const c = editorState.clip;
    if (!c) return 0;
    return Math.min(clipDur, Math.max(0, stageTime - c.start));
  });

  /**
   * 拖动进度条 = 拖**工程播放头**（关键帧面板与时间轴同步跟着走）。
   * 底图与舞台动画都读同一个 `playT`，所以一次 seek 三者一起变。
   */
  function seekBgLocal(sec: number): void {
    const c = editorState.clip;
    if (!c) return;
    bgPreview.seekTo(c.start + sec);
  }

  function toggleBgPlay(): void {
    if (bgPreview.playing) bgPreview.pause();
    else bgPreview.play();
  }

  /* ------------------------------------------------------------ 手势环境 */

  function toDoc(e: { clientX: number; clientY: number }): { x: number; y: number } {
    const wrap = paperWrapEl;
    if (!wrap) return { x: 0, y: 0 };
    // 用 paper-wrap 的实际矩形而不是「视口原点 + 固定边距」：paper-wrap 是
    // 水平居中的，内容比视口窄时左边距远大于 PAD，按固定值算会整体偏移。
    const r = wrap.getBoundingClientRect();
    return { x: (e.clientX - r.left) / zoom, y: (e.clientY - r.top) / zoom };
  }

  /* ---------------------------------------------------- 媒体池 → 画布 */

  /**
   * 把媒体池的图片素材放到画布上。
   *
   * 两条入口共用：拖到画布（落点 = `toDoc(e)`）、双击 / +（画布中心）。
   * 只有图片能进来 —— 排版文档里没有视频/音频的表达形式，那种拖拽给一句
   * 说明而不是静默吞掉。
   */
  function placePoolImage(item: PoolItem, center?: { x: number; y: number }): void {
    if (item.kind !== 'image') {
      appState.flash(tr('pool.canvasImageOnly'));
      return;
    }
    if (item.missing) {
      appState.flash(tr('pool.missing'), 'error');
      return;
    }
    actions.placeImageAsset(item.id, item.name, center);
  }

  /** 排版页里的媒体池条目落点：宿主接管（见 MediaPool 的 `oninsert`）。 */
  function insertPoolItem(item: PoolItem): void {
    placePoolImage(item);
  }

  /**
   * 认我们自己的拖拽靠 `types`（拖动期间 `getData` 读不出来），与时间轴
   * 落点同一条判据 —— 从系统拖文件的 `Files` 不在这里处理。
   */
  function onStageDragOver(e: DragEvent): void {
    if (!e.dataTransfer?.types.includes(ASSET_DRAG_MIME)) return;
    // 不 preventDefault 浏览器不允许落点（drop 根本不会发生）
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
  }

  function onStageDrop(e: DragEvent): void {
    const dt = e.dataTransfer;
    if (!dt || !dt.types.includes(ASSET_DRAG_MIME)) return;
    e.preventDefault();
    const id = dt.getData(ASSET_DRAG_MIME);
    // 拖拽期间工程可能被改（撤销 / 删除）：落地时按 id 重新解析，拿到的是当下的事实。
    const item = id ? poolItemById(appState.store.project.assets, appState.assets, id) : null;
    if (!item) return;
    // 落点钳进画布：拖到画布边的空白处时，元素不该整个跑到画布外（中心贴边也算放下了）。
    const p = toDoc(e);
    const size = docSize;
    placePoolImage(item, {
      x: Math.min(Math.max(p.x, 0), size.w),
      y: Math.min(Math.max(p.y, 0), size.h),
    });
  }

  /**
   * 手势环境。
   *
   * `focusId` = 这次手势「跟着谁走」：镜头生效时，屏幕坐标要先换算进**那个
   * 元素自己的坐标空间**（除以视差缩放、反转视差旋转）再交给手势。
   * 不做这一步的话，depth=1 + zoom 2× 时元素跑得比指针快一倍 ——
   * 而视差是**绕画布中心**的，所以换算不能只是「除以 zoom」。
   *
   * 多选且各元素 depth 不同时，统一按 `focusId` 那个元素的视差换算：
   * 元素之间保持刚性（各自的可见位移按自己的 depth 走），这是可接受的代价 ——
   * 同一 depth 的多选完全精确。
   */
  function toDocOf(elId?: string): (e: { clientX: number; clientY: number }) => { x: number; y: number } {
    const d = viewDoc;
    const focus = elId && d ? d.elements.find((e) => e.id === elId) : undefined;
    const p = d && focus ? parallaxOf(d, focus) : IDENTITY_PARALLAX;
    if (!d || parallaxIsIdentity(p)) return toDoc;
    return (e) => inverseParallax(d, p, toDoc(e));
  }

  function makeEnv(focusId?: string): GestureEnv {
    return {
      toDoc: toDocOf(focusId),
      docSize,
      setGuides: (g: Guide[]) => (editorState.guides = g),
      snapThreshold: SNAP_PX,
      // 关掉吸附时不传网格：`snapMove` 里 grid 为 null 就完全不走那条分支。
      gridSpacing: gridPrefs.snap ? gridStep : null,
    };
  }

  /** 单选时那个元素的 id（手势的视差换算用它）。 */
  function singleSelectedId(): string | undefined {
    const sel = editorState.selected;
    return sel.length === 1 ? sel[0]!.id : undefined;
  }

  /** 缩放 / 旋转把手：视差按「被操作的那一层」换算。 */
  function startResize(handle: HandleId, e: PointerEvent): void {
    const env = makeEnv(singleSelectedId() ?? hitTopAt(e)?.id);
    startResizeGesture(env, handle, env.toDoc(e));
  }

  function startRotate(e: PointerEvent): void {
    const env = makeEnv(singleSelectedId() ?? hitTopAt(e)?.id);
    startRotateGesture(env, env.toDoc(e));
  }

  /**
   * 指针下最上层的元素。
   *
   * 不只是「外接框命中」：图形元素还要过一遍像素级的实心判定（`isOpaqueAt`），
   * 于是面积很大的中空图形（圆环 / 方框 / 星形）**中间透的区域会让位给下一层**
   * —— 之前那种情况下层元素根本点不到，只能靠 Alt 轮询。
   *
   * 两处容差（都是「屏幕 px 换算成文档单位」，与缩放无关的手感）：
   *  · `HIT_SLOP_PX` 放宽**外接框**判定 —— 细线的框只有一两像素，压在边缘外侧
   *    一点点也该算在它旁边；
   *  · `isOpaqueAt` 内部撒探针做**模糊判定** —— 框里很大一片不在墨迹上时
   *    （旋转过的细长条）仍然点得中。
   *
   * 文本 / 图片不过闸（它们的框就是它们的身份），所以这条对它们零代价。
   */
  const HIT_SLOP_PX = 3;

  function hitAt(e: { clientX: number; clientY: number }) {
    const p = toDoc(e);
    const slop = HIT_SLOP_PX / Math.max(0.01, zoom);
    return hitTestFirst(viewRects, p.x, p.y, {
      slop,
      accept: (id) => {
        const el = viewDoc?.elements.find((x) => x.id === id);
        if (!el || !viewDoc) return true;
        // 元素自己的框（含镜头视差）—— 图形的像素闸要用它换算到路径坐标。
        return isOpaqueAt(paperEl, el, p, zoom, screenFrame(viewDoc, el));
      },
    });
  }

  /**
   * 只看外接框的最上层（**不做**实心判定）。
   *
   * 按在**选择框**上时用它：那个框属于已选元素，指针落在框内就是「在指这个
   * 元素」—— 用穿透判定的话，中空图形选中后按框中央会返回下层的元素，
   * Shift 减选 / 单击进组都会作用到别人身上。
   */
  function hitTopAt(e: { clientX: number; clientY: number }) {
    const p = toDoc(e);
    return hitTestFirst(viewRects, p.x, p.y);
  }

  /** 点下的**全部**命中 id，从最上层到最下层（Alt 轮询用；同样是外接框口径）。 */
  function hitIdsAt(e: { clientX: number; clientY: number }): string[] {
    const p = toDoc(e);
    return hitTestAll(viewRects, p.x, p.y);
  }

  /**
   * Alt 单击重叠元素时，在命中集合里**轮询**到下一个。
   *
   * 规则：当前选区若已包含命中集合中的某个元素，就选它的下一个（在集合内循环）；
   * 否则选第一个（最上层）。用 `selectOnly` 而不是 `toggle` —— 轮询是「换一个」，
   * 不是「加一个」，否则连续 Alt 点会把重叠元素全选上、再也分不开。
   */
  function cycleOverlap(hits: string[]): void {
    if (hits.length === 0) return;
    const cur = hits.findIndex((id) => editorState.isSelected(id));
    const next = cur >= 0 ? hits[(cur + 1) % hits.length]! : hits[0]!;
    editorState.selectOnly(next);
  }

  /** 右侧面板宽度拖曳。指针动一下写一次（节流交给 setTypoPanelWidth 的去重）。 */
  function startPanelDrag(e: PointerEvent): void {
    if (e.button !== 0) return;
    e.preventDefault();
    const startX = e.clientX;
    const startW = appState.typoPanelWidth;
    panelResizing = true;
    const onMove = (ev: PointerEvent): void => {
      // 面板在右侧：指针往左移 ⇒ 面板变宽，所以是减。
      appState.setTypoPanelWidth(startW - (ev.clientX - startX));
    };
    const onUp = (): void => {
      panelResizing = false;
      window.removeEventListener('pointermove', onMove);
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp, { once: true });
    window.addEventListener('pointercancel', onUp, { once: true });
  }

  /**
   * 关键帧面板高度拖曳：面板在预览**下方**，指针往上移 ⇒ 面板变高，所以是减。
   * （与右侧竖把手方向相反，见 ui/AGENTS.md 里「方向都是边界跟随光标」那条。）
   */
  function startKfDrag(e: PointerEvent): void {
    if (e.button !== 0) return;
    e.preventDefault();
    const startY = e.clientY;
    const startH = appState.typoKfHeight;
    kfResizing = true;
    const onMove = (ev: PointerEvent): void => {
      appState.setTypoKfHeight(startH - (ev.clientY - startY));
    };
    const onUp = (): void => {
      kfResizing = false;
      window.removeEventListener('pointermove', onMove);
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp, { once: true });
    window.addEventListener('pointercancel', onUp, { once: true });
  }

  /**
   * 按在**选择框**上。
   *
   * 选择框会吞掉 pointerdown（拖整块选区靠它），所以「再单击一次进入组合」
   * 必须在这里补 —— 而且只能补在**没拖动**的那次上：按下去就进组的话，
   * 想拖整组的人会发现自己拖走的是组里的一个子元素。
   *
   * **Shift / Alt 的单击语义也补在这里**：选择框覆盖着已选元素，指针落在框上，
   * `onStageDown` 根本收不到那次 pointerdown。不在这里补的话，多选时 Shift 点已选
   * 元素不会把它移出选区、Alt 点也不会轮询到下层元素（都表现成「这个手势没反应」）。
   * 二者都只在**没拖动**时生效，所以 Shift/Alt 拖拽（单轴 / 关吸附）的手感不变。
   *
   * 只对**组内**的元素做「进组」这件事。多选时选择框是整个选区的外接框，随便按一下
   * 就把选择收缩成指针底下那一个，那是很烦人的事故。
   */
  function onSelectionBoxDown(e: PointerEvent): void {
    const hit = hitTopAt(e);
    const el = hit ? (doc?.elements.find((x) => x.id === hit.id) ?? null) : null;
    const env = makeEnv(hit?.id ?? singleSelectedId());
    startMoveGesture(env, env.toDoc(e), {
      onClick: () => {
        // Alt：在重叠元素里轮询（与 onStageDown 的同一条判据，避免两个入口两套行为）。
        if (e.altKey) {
          const hits = hitIdsAt(e);
          if (hits.length > 1) {
            cycleOverlap(hits);
            return;
          }
        }
        // Shift：单击已选项 = 移出选区（其余保留），点未选项 = 加入。
        if (e.shiftKey) {
          if (hit) editorState.toggle(hit.id);
          return;
        }
        if (el?.groupId) editorState.pickElement(el);
      },
    });
  }

  /** 空白处的 pointerdown：命中就起手势，落空就框选。 */
  function onStageDown(e: PointerEvent): void {
    // 中键 = 平移。放在最前面，因为它与选择/框选完全无关，
    // 而且要挡住原生自动滚动（`preventDefault` 必须在默认行为发生前调）。
    if (e.button === 1) {
      startPan(e);
      return;
    }
    if (e.button !== 0) return;
    if (!doc) return;

    /*
     * 格式刷 / 动画刷：这一次点击是「选目标」，不是选择语义。
     *
     * 必须放在**最前面**（连文本编辑那条分支之前）：刷子开着时点哪儿都是刷，
     * 不该有「点到正在编辑的文本框就把光标挪过去」这种例外。
     * 落空 = 取消（用户明确要求），由 `clearSelection()` 顺手做掉。
     */
    const brush = editorState.painter;
    if (brush) {
      const target = hitAt(e);
      if (!target) {
        editorState.clearSelection();
        return;
      }
      actions.applyPainterTo(target.id);
      return;
    }

    const hit = hitAt(e);

    // 正在编辑这个元素时，指针事件归浏览器的文本选择 —— 否则一按就把
    // 光标位置抢走，变成拖拽。
    if (editorState.editingTextId && hit?.id === editorState.editingTextId) return;

    if (!hit) {
      if (!e.shiftKey) editorState.clearSelection();
      startMarquee(e, toDoc(e));
      return;
    }

    /*
     * Alt 单击 = 轮询重叠元素。**只在命中多个时启用** —— 命中一个时保持普通
     * 选择语义（Alt 本来就是「关吸附」的修饰键，单元素场景别抢它的含义）。
     * 用 selectOnly 逐个换选：同一位置连续 Alt 单击能把叠在一起的元素挨个选中。
     */
    if (e.altKey) {
      const hits = hitIdsAt(e);
      if (hits.length > 1) {
        cycleOverlap(hits);
        if (editorState.selectedIds.length) {
          const env = makeEnv(hit.id);
          startMoveGesture(env, env.toDoc(e));
        }
        return;
      }
    }

    // Shift = 加/减选，此时不做组合语义（用户明确在按元素挑）。
    if (e.shiftKey) {
      editorState.toggle(hit.id);
    } else {
      const el = doc.elements.find((x) => x.id === hit.id);
      // 单击选组合、再单击进组选子元素 —— 规则全在 pickElement 里，
      // 这里不重复一遍（重复 = 两个真源，迟早不一致）。
      if (el) editorState.pickElement(el);
      else editorState.selectOnly(hit.id);
    }

    if (editorState.selectedIds.length) {
      // 指针下的那个元素决定「这次拖拽用哪一层的视差」。
      const env = makeEnv(hit.id);
      startMoveGesture(env, env.toDoc(e));
    }
  }

  /**
   * 双击文本元素 → 进入编辑，并把光标放到双击的那一点。
   *
   * 双击的第一下会先起一次拖拽手势，但那次没有位移，松手时走 `cancelGesture`
   * （不留撤销记录），所以两者不冲突。
   */
  function onStageDblClick(e: MouseEvent): void {
    if (!doc) return;
    // 刷子开着时双击只是「刷了两次」，不该顺手进入文本编辑。
    if (editorState.painter) return;
    const hit = hitAt(e);
    if (!hit) return;
    const el = doc.elements.find((x) => x.id === hit.id);
    if (!el || el.kind !== 'text' || el.locked) return;
    e.preventDefault();
    // 组里的文本框：双击要**进组**再编辑，否则下一次单击又会跳回整组选中，
    // 用户会觉得「点了两下还是选不中文字」。
    if (el.groupId) editorState.enterGroup(el.groupId);
    editorState.selectOnly(el.id);
    editorState.beginEditing(el.id);
    // 等 DOM 真的进入编辑态（contenteditable 打开 + 上面那个 effect 里的 focus
    // 跑完）再放光标。rAF 保证排在 Svelte 的 effect 刷新之后。
    const { clientX, clientY } = e;
    requestAnimationFrame(() => {
      const node = paperEl?.querySelector<HTMLElement>(`[data-el-id="${el.id}"] .typo-text`);
      if (node) placeCaretAt(node, clientX, clientY);
    });
  }

  /**
   * 编辑区的输入回写。
   *
   * **每次都把 DOM 读回模型**（走 live 事务，不落撤销记录）。不这么做的话，
   * 「打字 → 顺手点一下加粗」会让加粗作用在**过时的 runs** 上：模型里还没有
   * 刚打进去的那些字，结果是格式跑到别的地方去。
   *
   * 整段编辑仍然只结算成**一笔**撤销 —— 撤销记录挂在 `commitEditing` 的
   * `endGesture` 上，与以前一致。
   */
  function onTextInput(e: Event): void {
    const id = editorState.editingTextId;
    if (!id) return;
    const node = (e.target as HTMLElement | null)?.closest?.('.typo-text') as HTMLElement | null;
    if (!node) return;
    const runs = serializeRuns(node);
    if (!editorState.gestureActive) editorState.beginGesture();
    editorState.live((d) => {
      const el = d.elements.find((x) => x.id === id);
      if (el && el.kind === 'text') el.runs = runs;
    });
    // DOM 已经和模型一致了 —— 把签名同步过去，下一次 sync 才不会把用户
    // 刚打的字重建一遍（那会丢光标）。
    node.setAttribute(RUNS_SIG_ATTR, runsSignature(runs));
    syncTextRange(node, id);
  }

  /** 编辑区的选区变化 → 记下「行内选区」。只记**非空**区间。 */
  function syncTextRange(node: HTMLElement, id: string): void {
    const r = caretRange(node);
    // 只记**非空**区间：光标收起时「改整块」才是符合直觉的行为。
    editorState.textRange = r && r.end > r.start ? { elId: id, start: r.start, end: r.end } : null;
  }

  /**
   * 接管回车与粘贴。
   *
   * 两件事都只有一个目的：**让编辑区永远只是一串文本节点**。
   *
   *  - 回车默认会造 `<div>` / `<br>` / `<p>`，而 `textContent` 对它们视而不见
   *    （换行会丢），「range 偏移 ↔ 纯文本下标」的换算立刻失真。
   *    改成直接插一个 `\n`（编辑区是 `white-space: pre-wrap`，换行照样显示）。
   *  - 粘贴默认会带入外部 HTML（一段从网页复制的文字能带进 `<font>`、`<a>`、
   *    甚至 `<script>` 标签的残留），既是注入点也让 runs 变得不可控。
   *    只取纯文本。
   *
   * 用 `execCommand` 而不是手改 DOM：它会把这次改动**并入浏览器的撤销栈**、
   * 并正确移动光标 —— 手改 DOM 两者都要自己实现一遍。该 API 虽已废弃，
   * 但 Chromium 里是唯一能「在光标处插入且保持选区」的可用手段。
   */
  function installTypingGuards(node: HTMLElement): void {
    if (node.getAttribute(GUARDS_ATTR) === '1') return;
    node.setAttribute(GUARDS_ATTR, '1');
    node.addEventListener('beforeinput', (e) => {
      const it = (e as InputEvent).inputType;
      if (it !== 'insertParagraph' && it !== 'insertLineBreak') return;
      e.preventDefault();
      document.execCommand('insertText', false, '\n');
    });
    node.addEventListener('paste', (e) => {
      e.preventDefault();
      const text = (e as ClipboardEvent).clipboardData?.getData('text/plain') ?? '';
      if (text) document.execCommand('insertText', false, text);
    });
  }

  /**
   * 失焦即提交。
   *
   * 提交挂在 `focusout` 而不是每帧同步里：编辑期间同步**不重建**文本节点
   * （重建就把用户刚打的字和光标一起弄没了）。打字过程走 live 事务，
   * 这里只负责**结算成一笔撤销**。
   */
  function commitEditing(): void {
    const id = editorState.editingTextId;
    if (!id) return;
    const node = paperEl?.querySelector<HTMLElement>(`[data-el-id="${id}"] .typo-text`);
    const runs = node ? serializeRuns(node) : null;
    // 直接赋值而不是 stopEditing()：那个会再 blur 一次，形成递归。
    editorState.editingTextId = null;
    // **不清 textRange**：点 Ribbon 的输入框也会走到这里，而那时用户刚选的那一段
    // 还该是这次格式的作用对象（见 editor-state 里 textRange 的注释）。
    const cur = doc?.elements.find((x) => x.id === id);
    if (cur?.kind === 'text' && runs && !runsEquivalent(cur.runs, runs)) {
      editorState.live((d) => {
        const el = d.elements.find((x) => x.id === id);
        if (el && el.kind === 'text') el.runs = normalizeRuns(runs);
      });
    }
    // 有 live 事务就结算成一笔；没打过字则什么都不留（不放空记录）。
    if (editorState.gestureActive) editorState.endGesture(tr('typo.undo.editText'));
  }

  /**
   * 把「当前行内选区」刷新一次。
   *
   * **不依赖 `selectionchange`**：那个事件的派发目标在各版本 Chromium 里不稳定
   * （规范派给 document，带上可编辑宿主之后实测只在某些路径上派发 —— 同一个
   * 页面里手写探针收得到、E2E 收不到）。只挂它的话表现是「行内选区时有时无」：
   * 同样的操作，加粗一次生效一次不生效。
   *
   * 改成两件事：
   *   ① 键 / 鼠标一松就重算（覆盖所有用键鼠改变选区的方式）；
   *   ② 通过 `registerTextRangeRefresher` 暴露给快捷键路径，**在动手之前
   *      再读一次 DOM 选区** —— 权威来源永远是「此刻的 DOM」，缓存只是为了
   *      让 Ribbon 上的控件能跟着重渲染。
   */
  function refreshTextRange(): void {
    const id = editorState.editingTextId;
    if (!id) return;
    const node = paperEl?.querySelector<HTMLElement>(`[data-el-id="${id}"] .typo-text`);
    if (node) syncTextRange(node, id);
  }

  // 注册给快捷键路径（keys.ts 不认识 DOM，也不该认识）。
  $effect(() => {
    registerTextRangeRefresher(refreshTextRange);
    return () => registerTextRangeRefresher(null);
  });

  /**
   * 刷子开着时底栏说清楚「现在在等什么、怎么退出」。
   *
   * 走 `statusHint.gesture`（优先级最高的那一层）而不是一次性 toast：刷子是个
   * **持续状态**，用户可能过几秒才点目标 —— toast 早就消失了，而底栏会一直
   * 提示到收起为止。清扫放在 effect 的清理函数里，于是「点了空白 / 再点按钮 /
   * 按 Esc / 关编辑器」这些路径都不必各自记得清一次。
   */
  $effect(() => {
    const brush = editorState.painter;
    if (!brush) return;
    statusHint.setGesture({
      text: brush.kind === 'format' ? 'typo.painterFormat' : 'typo.painterAnimation',
      actions: [{ keysKey: 'sc.key.esc', labelKey: 'typo.painterCancel' }],
    });
    return () => statusHint.clearGesture();
  });

  /**
   * 重建文本节点之后把光标放回去（只在选区**确实丢了**时才动手）。
   *
   * 挂在同步之后同步调用，而不是另起一个 `requestAnimationFrame`：rAF 与
   * Svelte 的 flush 谁先谁后并没有保证，实测会出现「还原时 DOM 还是旧的，
   * 于是光标落在了被替换掉的那个节点上」—— 表现是一加粗光标就没了。
   */
  function restoreCaretIfNeeded(): void {
    const id = editorState.editingTextId;
    const range = editorState.textRange;
    if (!id || !range || range.elId !== id) return;
    const node = paperEl?.querySelector<HTMLElement>(`[data-el-id="${id}"] .typo-text`);
    if (!node) return;
    const live = caretRange(node);
    if (live && live.end > live.start) return; // 选区还在，别去动它
    setCaretRange(node, range.start, range.end);
  }

  /** 框选：拖出矩形，与外接框相交即选中。 */
  function startMarquee(e: PointerEvent, start: { x: number; y: number }): void {
    const base = new Set(e.shiftKey ? editorState.selectedIds : []);
    let moved = false;

    const onMove = (ev: PointerEvent): void => {
      const p = toDoc(ev);
      if (Math.abs(p.x - start.x) > 1 || Math.abs(p.y - start.y) > 1) moved = true;
      marquee = {
        id: 'marquee',
        x: Math.min(start.x, p.x),
        y: Math.min(start.y, p.y),
        w: Math.abs(p.x - start.x),
        h: Math.abs(p.y - start.y),
      };
    };

    const onUp = (): void => {
      const box = marquee;
      marquee = null;
      // 空白区单击 = 清空选择，不做框选。
      if (!moved || !box) return;
      // 屏幕上看到的框 —— 镜头把元素推走 / 放大后，框选必须跟着它。
      const ids = viewRects.filter((r) => rectsIntersect(box, r)).map((r) => r.id);
      editorState.setSelection([...base, ...ids]);
    };

    attachWindow(onMove, onUp);
  }

  /**
   * 右键菜单。
   *
   * 空白处右键**不清空选择集** —— 与 PPT / 设计工具一致：用户往往先选好一批
   * 元素，再到空白处右键做「置顶 / 组合」。清空的话那批操作就没对象了。
   * 点在某个未选中的元素上则先把它选上，这样「右键 → 复制这个」符合直觉。
   */
  function onStageContextMenu(e: MouseEvent): void {
    e.preventDefault();
    if (!doc) return;
    const hit = hitAt(e);
    if (hit && !editorState.isSelected(hit.id)) editorState.selectOnly(hit.id);
    ctxMenu = { x: e.clientX, y: e.clientY };
  }

  /** 修饰键提示文案。平台相关的部分集中在这里，免得散落成一堆字面量。 */
  const macLike = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform);
  function mod(key: string): string {
    return `${macLike ? '⌘' : 'Ctrl'}+${key}`;
  }

  const ctxItems = $derived.by<MenuItem[]>(() => {
    void appState.version;
    const n = selection.length;
    const none = n === 0;
    const a = actions;
    /** 动作包装：先关菜单再执行 —— 菜单是条件渲染的，动作里若再触发重排会打架。 */
    const run = (fn: () => void) => () => {
      closeCtx();
      fn();
    };
    return [
      /*
       * 标注：把选中的元素钉进 Agent 的那一条消息。放在最前面 —— 它不是编辑动作，
       * 混在「复制 / 成组 / 层级」中间会被当成又一个改文档的项。
       */
      {
        id: 'add-to-context',
        label: n > 1 ? tr('agent.addToContextElements', { n }) : tr('agent.addToContext'),
        icon: 'message-circle-plus',
        testid: 'typo-ctx-add-context',
        disabled: none,
        onselect: run(() => addToAgentContext(elementContextRefs(clipId, selection))),
      },
      { id: 'sep-ctx', separator: true },
      {
        id: 'copy',
        label: tr('typo.menu.copy'),
        icon: 'copy',
        shortcut: mod('C'),
        testid: 'typo-ctx-copy',
        disabled: none,
        onselect: run(() => a.copySelection()),
      },
      {
        id: 'cut',
        label: tr('typo.menu.cut'),
        icon: 'scissors',
        shortcut: mod('X'),
        testid: 'typo-ctx-cut',
        disabled: none,
        onselect: run(() => a.cutSelection()),
      },
      {
        id: 'paste',
        label: tr('typo.menu.paste'),
        icon: 'clipboard-paste',
        shortcut: mod('V'),
        testid: 'typo-ctx-paste',
        disabled: !a.hasClipboard(),
        onselect: run(() => a.pasteClipboard()),
      },
      { id: 'sep-1', separator: true },
      {
        id: 'group',
        label: tr('typo.menu.group'),
        icon: 'group',
        shortcut: mod('G'),
        testid: 'typo-ctx-group',
        disabled: !a.canGroup(),
        onselect: run(() => a.groupSelection()),
      },
      {
        id: 'ungroup',
        label: tr('typo.menu.ungroup'),
        icon: 'ungroup',
        shortcut: `${mod('Shift')}+G`,
        testid: 'typo-ctx-ungroup',
        disabled: !a.canUngroup(),
        onselect: run(() => a.ungroupSelection()),
      },
      { id: 'sep-g', separator: true },
      {
        id: 'duplicate',
        label: tr('rib.duplicate'),
        icon: 'copy',
        shortcut: mod('D'),
        testid: 'typo-ctx-duplicate',
        disabled: none,
        onselect: run(() => a.duplicateSelection()),
      },
      {
        id: 'delete',
        label: tr('common.delete'),
        icon: 'trash',
        danger: true,
        shortcut: 'Del',
        testid: 'typo-ctx-delete',
        disabled: none,
        onselect: run(() => a.deleteSelection()),
      },
      { id: 'sep-2', separator: true },
      {
        id: 'front',
        label: tr('rib.toFront'),
        icon: 'bring-to-front',
        testid: 'typo-ctx-front',
        disabled: none,
        onselect: run(() => a.order('front')),
      },
      {
        id: 'forward',
        label: tr('typo.menu.forward'),
        icon: 'move-up',
        testid: 'typo-ctx-forward',
        disabled: none,
        onselect: run(() => a.order('forward')),
      },
      {
        id: 'backward',
        label: tr('typo.menu.backward'),
        icon: 'move-down',
        testid: 'typo-ctx-backward',
        disabled: none,
        onselect: run(() => a.order('backward')),
      },
      {
        id: 'back',
        label: tr('rib.toBack'),
        icon: 'send-to-back',
        testid: 'typo-ctx-back',
        disabled: none,
        onselect: run(() => a.order('back')),
      },
      { id: 'sep-3', separator: true },
      {
        id: 'lock',
        label: tr('rib.lock'),
        icon: 'lock',
        testid: 'typo-ctx-lock',
        disabled: none,
        onselect: run(() => a.toggleFlag('locked')),
      },
      {
        id: 'hide',
        label: tr('rib.hide'),
        icon: 'eye-off',
        testid: 'typo-ctx-hide',
        disabled: none,
        onselect: run(() => a.toggleFlag('visible')),
      },
      { id: 'sep-4', separator: true },
      /*
       * 反向导出。两条动作 × 两种格式，所以各挂一个二级菜单 —— 平铺成四项的话
       * 「保存到本机 PNG」这类名字会挤满右侧快捷键那一栏的宽度。
       *
       * SVG 只对**整份选择都是图形**开放（`canExportSvg`）：文字与图片没有矢量
       * 表达，混选时给一个能点但会静默少内容的格式比置灰更坏。
       * 父项**不置灰** —— 按钮 disabled 时子菜单根本打不开，用户连「为什么不行」
       * 都无从看起（子项各自带 disabled）。
       */
      {
        id: 'export-file',
        label: tr('typo.menu.saveToDevice'),
        icon: 'download',
        testid: 'typo-ctx-save-file',
        children: exportItems('file'),
      },
      {
        id: 'export-pool',
        label: tr('typo.menu.toPool'),
        icon: 'images',
        testid: 'typo-ctx-to-pool',
        children: exportItems('pool'),
      },
    ];
  });

  /**
   * 导出子菜单（保存到本机 / 输出到媒体池共用一份定义）。
   *
   * 两个入口的格式集合必须一模一样：少一个 `SVG` 的话，「这个图形的矢量版
   * 拿不出来」会变成「换个入口再试一次」的猜谜。
   */
  function exportItems(target: 'file' | 'pool'): MenuItem[] {
    const a = actions;
    const svgOk = canExportSvg(selection);
    const run = (fn: () => void) => () => {
      closeCtx();
      fn();
    };
    const pick = (format: 'png' | 'svg') => () =>
      target === 'file'
        ? a.saveSelectionToFile(localSec, format)
        : a.sendSelectionToPool(localSec, format);
    return [
      {
        id: `${target}-png`,
        label: tr('typo.menu.formatPng'),
        testid: `typo-ctx-${target === 'file' ? 'save' : 'pool'}-png`,
        disabled: !selection.length,
        onselect: run(pick('png')),
      },
      {
        id: `${target}-svg`,
        label: tr('typo.menu.formatSvg'),
        testid: `typo-ctx-${target === 'file' ? 'save' : 'pool'}-svg`,
        disabled: !svgOk,
        onselect: run(pick('svg')),
      },
    ];
  }

  /** 指针监听挂 window（与 gestures.ts 同一套约定）。 */  function attachWindow(onMove: (e: PointerEvent) => void, onUp: () => void): void {
    const up = (): void => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', up);
      onUp();
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', up, { once: true });
  }
</script>

<div class="editor" data-testid="typo-editor">
  <!--
    Ribbon 与「缺字体」横幅包在**同一个网格行**里。
    分开的话 banner 是条件渲染，缺字体时网格会多出一行、不缺时少一行，
    于是 .main 与 .zoombar 各自落到不同的轨道上 —— 表现见下面 .editor 的注释。
  -->
  <div class="top">
    <Ribbon {tabs} activeId={activeRibbonTab} {contextualActive} onchange={(id) => (activeRibbonTab = id)} />

    {#if missingFonts.length}
      <div class="banner" data-testid="typo-font-missing">
        {tr('typo.missingFonts', { fonts: missingFonts.join(tr('typo.fontListSeparator')) })}
      </div>
    {/if}
  </div>

  <div
    class="main"
    class:resizing={panelResizing}
    class:kfresizing={kfResizing}
    style:--typo-panel-w={`${appState.typoPanelWidth}px`}
    style:--typo-pool-w={appState.mediaPoolOpen || appState.agentOpen
      ? `${appState.mediaPoolWidth}px`
      : '0px'}
  >
    <!--
      左列（媒体池 / Agent 互斥）：媒体池在排版页里是「拖图片进画布」的来源，
      条目的落点由本页接管（见 insertPoolItem）。Agent 抽屉与时间轴共用同一个
      组件与同一份宽度 —— **排版页也必须能开 Agent**（需求 3 的核心场景）。
    -->
    {#if appState.agentOpen}
      <AgentDrawer />
    {:else if appState.mediaPoolOpen}
      <MediaPoolDrawer />
    {/if}

    <!--
      中间列 = 预览 + 关键帧面板（纵向 flex）。
      包一层是刻意的：给 `.main` 加一行会让 `.split` 与右栏都要显式 `grid-row`，
      而「每一列都必须显式定位」这条教训（见 .main 的 CSS 注释）就是这么来的。
    -->
    <div class="center">
    <!-- role="presentation" 与 Timeline 的 .rows 一致：这是指针手势面，不是语义容器。 -->
    <div
      class="viewport"
      class:panning
      class:painting={!!editorState.painter}
      role="presentation"
      bind:this={viewportEl}
      onpointerdown={onStageDown}
      ondragover={onStageDragOver}
      ondrop={onStageDrop}
      ondblclick={onStageDblClick}
      oncontextmenu={onStageContextMenu}
      oninput={onTextInput}
      onkeyup={refreshTextRange}
      onmouseup={refreshTextRange}
      onauxclick={(e) => e.preventDefault()}
      data-testid="typo-stage"
    >
      <div
        class="paper-wrap"
        bind:this={paperWrapEl}
        style:width={`${docSize.w * zoom}px`}
        style:height={`${docSize.h * zoom}px`}
        style:margin={`${PAD}px auto`}
      >
        <!--
          背景帧层：铺在最底下（先于 .paper），被编辑内容之下。
          它按 document 像素取「当前帧画面」的截图，半透明地正好占满画幅框。
        -->
        <BackgroundLayer />
        <div
          class="raster-host"
          bind:this={rasterHostEl}
          style:width={`${docSize.w * zoom}px`}
          style:height={`${docSize.h * zoom}px`}
        ></div>
        <div
          class="paper"
          class:paper-hidden={editorState.rasterPreview}
          bind:this={paperEl}
          style:transform={`scale(${zoom})`}
          onfocusout={commitEditing}
        ></div>

        <div class="overlay">
          <!--
            画幅线框 + 网格。两者都画在**文档坐标系**里（这里就是 paper-wrap 的原点），
            所以随 zoom 一起缩放，位置天然与元素一致。
            网格用两个元素 + CSS mask 做「虚线」：一个元素画满实线、mask 把它切成
            短划线。逐条渲染要 75～750 个 DOM 节点，而且每条都要绑 zoom。
          -->
          {#if frameVisible}
            <i class="canvas-frame" data-testid="typo-canvas-frame"></i>
          {/if}
          {#if gridPrefs.enabled}
            {#if gridPrefs.showX}
              <i
                class="grid grid-v"
                data-testid="typo-grid-v"
                style:background-size={`${gridStep.x * zoom}px 100%`}
              ></i>
            {/if}
            {#if gridPrefs.showY}
              <i
                class="grid grid-h"
                data-testid="typo-grid-h"
                style:background-size={`100% ${gridStep.y * zoom}px`}
              ></i>
            {/if}
          {/if}

          <!--
            用 selectionRects（每项是**新对象**）而不是 selection（元素本身原地改）。
            Svelte 5 的模板 effect 靠 `===` 判断传播，直接读 `el.frame.x` 会因为
            对象引用没变而**静默不更新** —— 这是本项目的常客，见 AGENTS §7。
          -->
          {#each selectionRects as r (r.id)}
            <i
              class="typo-sel"
              style:left={`${r.x * zoom}px`}
              style:top={`${r.y * zoom}px`}
              style:width={`${r.w * zoom}px`}
              style:height={`${r.h * zoom}px`}
              style:transform={rotCss(r.rot)}
              data-testid="typo-sel"
            ></i>
          {/each}

          {#if selection.length > 1 && selectionBox}
            <i
              class="typo-sel typo-sel-bounds"
              style:left={`${selectionBox.x * zoom}px`}
              style:top={`${selectionBox.y * zoom}px`}
              style:width={`${selectionBox.w * zoom}px`}
              style:height={`${selectionBox.h * zoom}px`}
            ></i>
          {/if}

          {#each editorState.guides as g, i (i)}
            {#if g.axis === 'v'}
              <i class="guide v" style:left={`${g.pos * zoom}px`}></i>
            {:else}
              <i class="guide h" style:top={`${g.pos * zoom}px`}></i>
            {/if}
          {/each}

          {#if marquee}
            <i
              class="marquee"
              style:left={`${marquee.x * zoom}px`}
              style:top={`${marquee.y * zoom}px`}
              style:width={`${marquee.w * zoom}px`}
              style:height={`${marquee.h * zoom}px`}
            ></i>
          {/if}
        </div>

        <!--
          选择层必须挂在 .paper-wrap 里面：它的把手坐标是**按文档原点**算的，
          挂到 viewport 上就会以 viewport 的左上角为基准，而 paper 是水平居中
          且带 PAD 边距的 —— 结果是选择框整体偏移、把手完全点不中。
        -->
        <!--
          顶点编辑态下**不渲染**选择层：它的 8 个缩放把手画在框边上，而椭圆这类
          路径的四个锚点正好落在框边的中点上 —— 叠加时锚点会被把手盖住，点下去
          是缩放而不是拖点。退出编辑（Escape）后选择层回来。

          控制点（`paths: false`）则**与选择层并存**，所以它必须排在选择层**之后**
          （DOM 靠后 = 叠在上面）：选择层的框会吞掉整片 pointerdown。

          格式刷 / 动画刷开着时也不渲染选择层：那一次点击要落到「目标元素」上，
          而选择框（含把手）会把它整片吞掉 —— 源元素完全盖住目标时，刷子就
          永远刷不到它，看起来像「点了没反应」。
        -->
        {#if !nodeEditEl && !editorState.painter}
          <SelectionLayer
            rect={selectionBox}
            {zoom}
            editing={!!editorState.editingTextId &&
              selection.length === 1 &&
              selection[0]!.id === editorState.editingTextId}
            quadEdit={!!quadEditEl}
            onMove={(e) => onSelectionBoxDown(e)}
            onHandle={(h: HandleId, e: PointerEvent) => startResize(h, e)}
            onRotate={(e) => startRotate(e)}
          />
        {/if}

        <!--
          四角调整手柄：只在「元素确实开着四角」时出现（`el.quad` 存在）。
          开关关着却画手柄的话，拖完不知道该往哪存 —— 面板的开关与这里是一对。
        -->
        {#if quadEditEl && quadEditEl.quad}
          <QuadEditLayer
            el={quadEditEl}
            {zoom}
            toDoc={toDocOf(quadEditEl.id)}
            onExit={() => editorState.setQuadEdit(null)}
          />
        {/if}

        {#if nodeEditEl ?? soloShape}
          {@const target = (nodeEditEl ?? soloShape)!}
          <NodeEditor
            el={target}
            {zoom}
            paths={!!nodeEditEl}
            subs={nodeSubs}
            handles={nodeHandles}
            toDoc={toDocOf(target.id)}
            onShapeHandle={(h, e) => {
              const env = makeEnv(target.id);
              startShapeHandleDrag(env, target.id, h, env.toDoc(e));
            }}
            onNodeDrag={(t, e) => {
              const env = makeEnv(target.id);
              startNodeDrag(env, target.id, t, env.toDoc(e));
            }}
            onAddNode={(hit) => actions.addPathNode(hit)}
            onDeleteNode={(i) => actions.deletePathNode(i)}
          />
        {/if}
      </div>
    </div>

    <div
      class="kf-split"
      role="separator"
      aria-orientation="horizontal"
      aria-label={tr('typo.kfDrag')}
      data-testid="typo-kf-split"
      onpointerdown={startKfDrag}
    ></div>

    <KeyframePanel />
    </div>

    <div
      class="split"
      role="separator"
      aria-orientation="vertical"
      aria-label={tr('typo.panelDrag')}
      data-testid="typo-panel-split"
      onpointerdown={startPanelDrag}
    ></div>

    <SidePanel />
  </div>

  <div class="zoombar">
    <IconButton icon="minus" label={tr('typo.zoomOut')} testid="typo-zoom-out" onclick={() => zoomBy(1 / 1.25)} />
    <span class="zoom-slider">
      <Slider
        min={5}
        max={400}
        step={1}
        value={zoomPct}
        ariaLabel={tr('typo.zoom')}
        tipText={tr('typo.zoom')}
        testid="typo-zoom-slider"
        oninput={setZoomPct}
      />
    </span>
    <span class="zoom-val">{zoomPct}%</span>
    <IconButton icon="plus" label={tr('typo.zoomIn')} testid="typo-zoom-in" onclick={() => zoomBy(1.25)} />
    <IconButton icon="minimize-2" label={tr('typo.zoomFit')} testid="typo-zoom-fit" onclick={zoomFit} />

    <!--
      背景预览：播放按钮 + 进度条（用户要求放在缩放区右侧）+ 开关 + 不透明度。
      播放/拖动都推**工程播放头**（`bgPreview`），所以它和关键帧面板的播放头、
      时间轴播放头永远是同一时刻。
    -->
    <div class="typo-bg-controls" data-testid="typo-bg-controls">
      <IconButton
        icon={bgPreview.playing ? 'pause' : 'play'}
        label={bgPreview.playing ? tr('typo.bgPause') : tr('typo.bgPlay')}
        testid="typo-bg-play"
        onclick={toggleBgPlay}
      />
      <span class="typo-bg-scrub">
        <Slider
          min={0}
          max={clipDur}
          step={0}
          value={bgLocalSec}
          ariaLabel={tr('typo.bgScrub')}
          tipText={tr('typo.bgScrub')}
          testid="typo-bg-scrub"
          oninput={seekBgLocal}
        />
      </span>
      <span class="typo-bg-time mono" data-testid="typo-bg-time">{bgLocalSec.toFixed(2)}s</span>
      <IconButton
        icon="image"
        label={tr('typo.bgToggle')}
        testid="typo-bg-toggle"
        active={bgPreview.enabled}
        onclick={() => bgPreview.toggleEnabled()}
      />
      <span class="typo-bg-opacity">
        <Slider
          min={0}
          max={100}
          step={1}
          value={Math.round(bgPreview.opacity * 100)}
          ariaLabel={tr('typo.bgOpacity')}
          tipText={tr('typo.bgOpacity')}
          disabled={!bgPreview.enabled}
          testid="typo-bg-opacity"
          oninput={(v) => bgPreview.setOpacity(v / 100)}
        />
      </span>
    </div>

    <span class="spacer"></span>
    <!-- 固定宽度：.sel 带 flex:1，直接放进 flex 行会被拉成整行宽。 -->
    <span class="scale-pick">
      <Select
        value={String(appState.typoPreviewScale)}
        options={[
          { value: '1', label: tr('typo.previewScale', { scale: '1.0x' }) },
          { value: '0.5', label: tr('typo.previewScale', { scale: '0.5x' }) },
          { value: '0.25', label: tr('typo.previewScale', { scale: '0.25x' }) },
        ]}
        testid="typo-preview-scale"
        onchange={(v) => (appState.typoPreviewScale = Number(v))}
      />
    </span>
    <IconButton
      icon="monitor"
      label={tr('typo.rasterPreview')}
      testid="typo-raster-toggle"
      active={editorState.rasterPreview}
      onclick={() => (editorState.rasterPreview = !editorState.rasterPreview)}
    />
  </div>

  <!--
    画布尺寸浮层（「设计 → 画布大小」）。挂在根节点下、`position: fixed`：
    它要能盖住 Ribbon 与画布两侧，不能留在 `.zoombar` / `.ribbon` 这类带
    `overflow` 或层叠上下文的祖先里。
  -->
  {#if canvasOpen && canvasAnchor && canvasInfo}
    <CanvasSizePopover
      anchor={canvasAnchor}
      onclose={() => (canvasOpen = false)}
      size={docSize}
      frame={appState.project.resolution}
      fit={canvasInfo.fit}
      sx={canvasInfo.sx}
      sy={canvasInfo.sy}
      keyed={canvasInfo.keyed}
      onsize={setCanvasSize}
      onscale={setCanvasScale}
    />
  {/if}

  <!-- 镜头浮层（「设计 → 镜头」）：与画布浮层同一条理由，挂在根节点下。 -->
  {#if cameraOpen && cameraAnchor}
    <CameraPopover
      anchor={cameraAnchor}
      onclose={() => (cameraOpen = false)}
      camera={cameraView}
      onset={(patch) => actions.setCamera(patch, localSec)}
      onlive={(patch) => actions.setCameraLive(patch, localSec)}
      onend={() => actions.endLive(tr('typo.undo.camera'))}
      onreset={() => actions.resetCamera()}
    />
  {/if}

  <!--
    「图片格式」的四个浮层（色彩校正 / 重新着色 / 滤镜 / 调整大小）。
    与画布浮层同一条理由：`position: fixed`、挂在根节点下，不能被 Ribbon 或
    右侧面板的 `overflow` 裁掉。同一时刻只开一个（`imageTool`）。
  -->
  {#if imageTool && imageToolAnchor && imageFx}
    {#if imageTool === 'adjust'}
      <ImageAdjustPopover
        anchor={imageToolAnchor}
        onclose={() => (imageTool = null)}
        adjust={imageFx.adjust}
        onlive={(patch) => actions.patchImageAdjustLive(patch)}
        oncommit={(patch) =>
          settleThen(tr('typo.undo.imgAdjust'), () => actions.patchImageAdjust(patch))}
        onliveend={() => actions.endLive(tr('typo.undo.imgAdjust'))}
        oncurve={commitImageCurve}
        oncurvelive={(channel, pts) => actions.setImageCurveLive(channel, pts)}
        oncurveend={() => actions.endLive(tr('typo.undo.imgCurve'))}
      />
    {:else if imageTool === 'recolor'}
      <ImageRecolorPopover
        anchor={imageToolAnchor}
        onclose={() => (imageTool = null)}
        recolor={imageFx.recolor}
        theme={docTheme}
        onchange={(patch) =>
          settleThen(tr('typo.undo.imgRecolor'), () => actions.patchImageRecolor(patch))}
        onlive={(patch) => actions.patchImageRecolorLive(patch)}
        onliveend={() => actions.endLive(tr('typo.undo.imgRecolor'))}
      />
    {:else if imageTool === 'filter'}
      <ImageFilterPopover
        anchor={imageToolAnchor}
        onclose={() => (imageTool = null)}
        filter={imageFx.filter}
        onchange={(f) => settleThen(tr('typo.undo.imgFilter'), () => actions.setImageFilter(f))}
        onlive={(f) => actions.setImageFilterLive(f)}
        onliveend={() => actions.endLive(tr('typo.undo.imgFilter'))}
      />
    {:else if imageTool === 'size'}
      <ImageSizePopover
        anchor={imageToolAnchor}
        onclose={() => (imageTool = null)}
        frame={imageFx.frame}
        natural={imageFx.natural}
        onresize={(next, lock) => actions.resizeImages(next, lock)}
      />
    {/if}
  {/if}
</div>

{#if ctxMenu}
  <Menu items={ctxItems} at={ctxMenu} onclose={closeCtx} testid="typo-context-menu" />
{/if}

{#if customCssOpen}
  <CustomCssModal
    initialOf={() => currentKeyframes}
    onclose={() => (customCssOpen = false)}
    onsave={(css: string) => actions.applyCustomCss(css)}
  />
{/if}

{#if themeEditorOpen && themeEditorDraft}
  <ThemeEditorModal
    initialOf={() => {
      const { theme: cur, isCustom } = themeEditorDraft;
      // 内置方案打开即复制成自定义方案（内置数据表只读；id 新建、名字加「副本」）
      return isCustom
        ? { ...cur, colors: { ...cur.colors } }
        : cloneAsCustomTheme(cur, newId(), `${tr(cur.labelKey!)}${tr('rib.themeCopySuffix')}`);
    }}
    title={themeEditorDraft.isCustom ? tr('rib.themeEditTitle') : tr('rib.themeNewTitle')}
    onclose={() => (themeEditorOpen = false)}
    onsave={(t) => actions.saveCustomTheme(t)}
  />
{/if}

{#if iconPickerOpen}
  <IconPickerModal
    onclose={() => (iconPickerOpen = false)}
    onapply={(items: IconInsert[]) => {
      iconPickerOpen = false;
      actions.addIcons(items);
    }}
  />
{/if}

{#if genPickerOpen}
  <SvgGenPickerModal
    onclose={() => (genPickerOpen = false)}
    onpick={(id: string) => {
      genPickerOpen = false;
      actions.addGeneratedShape(id);
    }}
  />
{/if}

<style>
  .editor {
    display: grid;
    /*
     * 三行：Ribbon 区 / 舞台（吃满）/ zoombar。
     *
     * ⚠️ 这里曾经是 `auto auto minmax(0,1fr) auto` —— 四行，但只有三个子项
     * （「缺字体」横幅是条件渲染的）。不缺字体时 .main 落到第 2 行的 `auto`、
     * .zoombar 落到第 3 行的 `minmax(0,1fr)`，于是：
     *   · zoombar 被拉成 `1fr` 的高度（默认情况下就偏高，窗口一变化更明显）；
     *   · 舞台那一行是 `auto`，会随画布尺寸无限长高，把 zoombar 挤出屏幕。
     * 现在 Ribbon 与横幅合成一个 `.top` 子项，行数与子项数一一对应。
     */
    grid-template-rows: auto minmax(0, 1fr) auto;
    grid-template-columns: minmax(0, 1fr);
    min-height: 0;
    min-width: 0;
    background: var(--surface-0);
  }
  .top {
    display: flex;
    flex-direction: column;
    min-width: 0;
  }
  .main {
    display: grid;
    /* 四列：媒体池 | 舞台 | 拖曳把手 | 右面板。中间 4px 是拖曳把手列：
       用独立的 grid 列而不是绝对定位，这样它天然吃满高度、也不会和两侧内容重叠。 */
    grid-template-columns: var(--typo-pool-w, 0px) minmax(0, 1fr) 4px var(--typo-panel-w, 208px);
    min-height: 0;
    min-width: 0;
  }
  /*
   * ⚠️ 每一列都必须**显式定位**：媒体池是条件渲染的，靠自动排布时它缺席会让
   * 后面的子项整体前移一格 —— 舞台落进 0 宽的第一列，表现是「关掉媒体池，
   * 画面整个消失」。与 App.svelte 的 .body 是同一条教训。
   */
  .main > :global(aside.media-drawer) {
    grid-column: 1;
  }
  .main > :global(aside.agent-drawer) {
    grid-column: 1;
  }
  .main > :global(aside.side) {
    grid-column: 4;
  }
  .split {
    grid-column: 3;
    /* 与片段编辑器的检查器抽屉（InspectorDrawer 的 .drawer-resize）保持同一套：
       4px 命中区、ew-resize 光标、hover / 拖动中都是**实心主题色**。
       之前这里是 col-resize + --accent-weak，同一个交互在两条链路上长得不一样。 */
    cursor: ew-resize;
    background: transparent;
  }
  .split:hover,
  .resizing .split {
    background: var(--accent);
  }
  /* 拖动中禁止选中文本，否则整页会变蓝（与检查器同款处理）。 */
  .resizing {
    user-select: none;
  }
  .banner {
    padding: 4px var(--sp-4);
    font-size: var(--fs-xs);
    color: var(--warning);
    background: var(--surface-2);
    border-bottom: 1px solid var(--border);
  }

  /* 中间列：预览（吃满剩余高度）+ 横向把手 + 关键帧面板。 */
  .center {
    grid-column: 2;
    display: flex;
    flex-direction: column;
    min-height: 0;
    min-width: 0;
  }
  /*
   * 面板在预览**下方**：指针往上移 ⇒ 面板变高（`startKfDrag` 里是减）。
   * 命中区 4px、hover / 拖动中实心主题色 —— 与右侧竖把手同一套。
   */
  .kf-split {
    flex: none;
    height: 4px;
    cursor: row-resize;
    background: transparent;
  }
  .kf-split:hover,
  .kfresizing .kf-split {
    background: var(--accent);
  }
  .kfresizing {
    user-select: none;
  }
  .viewport {
    flex: 1 1 auto;
    position: relative;
    overflow: auto;
    min-height: 0;
    min-width: 0;
    /* 棋盘格底：让「文档本身是透明的」这件事看得见（排版层要叠到画面上）。 */
    background: repeating-conic-gradient(var(--surface-2) 0% 25%, var(--surface-1) 0% 50%) 50% / 16px 16px;
    touch-action: none;
  }
  /* 中键平移中：光标要有反馈，否则用户不知道手势被接住了。 */
  .viewport.panning {
    cursor: grabbing;
  }
  /*
   * 刷子开着：`copy` 是系统里「把东西刷到这儿」的通用光标（带一个加号）。
   * 用 `!important` 是因为文档元素自己会设 cursor（文本框是 text、图片是 move），
   * 那些规则更靠内层、优先级更高。
   */
  .viewport.painting,
  .viewport.painting :global(*) {
    cursor: copy !important;
  }
  .paper-wrap {
    position: relative;
  }
  .paper,
  .raster-host {
    position: absolute;
    left: 0;
    top: 0;
    transform-origin: 0 0;
  }
  /*
   * 光栅预览打开时把可编辑画面整个让出来。
   * 两者是**同一位置的两张图**，都显示的话就是「一模一样的两幅叠在一起」，
   * 而且光栅那张按文档像素渲染、不跟 zoom 缩，看起来会比可编辑的大一圈。
   * 这个开关的语义本来就是 A/B 对照（验证「看到的 = 导出的」），不是叠加。
   */
  .paper-hidden {
    visibility: hidden;
  }
  .raster-host {
    pointer-events: none;
  }
  .overlay {
    position: absolute;
    left: 0;
    top: 0;
    right: 0;
    bottom: 0;
    pointer-events: none;
  }
  /* 画幅线框：常驻，告诉用户「画面范围到哪儿」。用 inset 边框 + 外发光，
     透明文档（排版层要叠到画面上）也能一眼看出边界。
     颜色从语义色 mix 出来而不是新增 token：网格是**编辑器 chrome**，
     不该进主题色板（那会让主题测试与配色面板多两个没有语义的槽位）。 */
  .canvas-frame {
    position: absolute;
    inset: 0;
    outline: 1px solid color-mix(in srgb, var(--text-secondary) 65%, transparent);
    box-shadow: 0 0 0 1px color-mix(in srgb, var(--surface-0) 55%, transparent);
    pointer-events: none;
  }
  .grid {
    position: absolute;
    inset: 0;
    pointer-events: none;
    /* 一个实线格 + 一个 mask 切成虚线：两个元素顶掉几百个 DOM 节点。
       mask 的虚线周期是**屏幕 px**（不随 zoom 缩），所以任何缩放下
       网格看起来都是同一套点线。 */
    --grid: color-mix(in srgb, var(--text-muted) 42%, transparent);
    -webkit-mask-image: repeating-linear-gradient(to bottom, #000 0 3px, transparent 3px 9px);
    mask-image: repeating-linear-gradient(to bottom, #000 0 3px, transparent 3px 9px);
  }
  .grid-v {
    background-image: linear-gradient(to right, var(--grid) 0 1px, transparent 1px);
    background-repeat: repeat;
  }
  .grid-h {
    /* 横线的虚线方向要转 90°，否则短划线顺着线走 —— 看起来还是一条实线。 */
    -webkit-mask-image: repeating-linear-gradient(to right, #000 0 3px, transparent 3px 9px);
    mask-image: repeating-linear-gradient(to right, #000 0 3px, transparent 3px 9px);
    background-image: linear-gradient(to bottom, var(--grid) 0 1px, transparent 1px);
    background-repeat: repeat;
  }

  /* 多选时每项一个细框，外接框用虚线区分「这是整体」。 */
  .typo-sel {
    position: absolute;
    outline: 1px solid var(--accent);
    outline-offset: -1px;
  }
  .typo-sel-bounds {
    outline: 1px dashed var(--accent);
  }
  /* 参考线用主题色 1px 实线 —— 「主题色只出现在选中/激活态」的一处。 */
  .guide {
    position: absolute;
    background: var(--accent);
  }
  .guide.v {
    top: 0;
    bottom: 0;
    width: 1px;
  }
  .guide.h {
    left: 0;
    right: 0;
    height: 1px;
  }
  /*
   * 框选矩形必须是**半透明**的：它盖在画面之上，不透明的话拖框的过程中
   * 底下被框住的内容全看不见（用户报的「选框是个实心块」）。
   * 用 color-mix 而不是 --accent-weak —— 后者是**不透明**的色阶值。
   */
  .marquee {
    position: absolute;
    border: 1px solid var(--accent);
    background: color-mix(in srgb, var(--accent) 16%, transparent);
  }

  .zoombar {
    display: flex;
    align-items: center;
    gap: var(--sp-1);
    /* 固定高度：它是布局的常数，不该随内容或窗口宽度变。 */
    height: 26px;
    flex-shrink: 0;
    padding: 0 var(--sp-4);
    background: var(--surface-1);
    border-top: 1px solid var(--border);
  }
  /* .sld 自带 flex:1，放进 flex 行会被拉成整行宽 —— 定宽框住它。 */
  .zoom-slider {
    display: inline-flex;
    flex: none;
    width: 120px;
  }
  .zoom-val {
    min-width: 42px;
    text-align: center;
    font-size: var(--fs-xs);
    color: var(--text-secondary);
  }
  .spacer {
    margin-left: auto;
  }
  /*
   * 背景预览控件组：与左侧缩放区分开（一条竖线），进度条紧挨缩放区的右侧。
   * 定宽框住自带 flex:1 的 .sld —— 同 .zoom-slider 的处理。
   */
  .typo-bg-controls {
    display: inline-flex;
    align-items: center;
    gap: var(--sp-1);
    flex: none;
    margin-left: var(--sp-3);
    padding-left: var(--sp-3);
    border-left: 1px solid var(--border);
  }
  .typo-bg-scrub {
    display: inline-flex;
    flex: none;
    width: 120px;
  }
  .typo-bg-opacity {
    display: inline-flex;
    flex: none;
    width: 72px;
  }
  .typo-bg-time {
    min-width: 44px;
    text-align: center;
    font-size: var(--fs-xs);
    color: var(--text-secondary);
  }
  /* .sel 自带 flex:1，放进 flex 行会被拉成整行宽（实测占满 90% 屏幕）——
     包一层定宽容器把它框住。 */
  .scale-pick {
    display: inline-flex;
    flex: none;
    width: 132px;
  }
</style>
