<script lang="ts">
  import Icon from '../ui/Icon.svelte';
  import IconButton from '../ui/controls/IconButton.svelte';
  import Menu from '../ui/controls/Menu.svelte';
  import { separator, submenu, type MenuItem } from '../ui/controls/menu-model';
  import { algoThumbUrl } from '../ui/algo-thumb-assets';
  import { thumbUrl as effectThumbUrl } from '../ui/effect-picker/thumb-assets';
  import { ALGO_CATALOG } from '../algos/catalog';
  import { EFFECT_CATALOG } from '../effects/catalog';
  import { defaultEffectValues, getEffect } from '../effects/registry';
  import EffectPickerModal from '../ui/effect-picker/EffectPickerModal.svelte';
  import AlgoPickerModal from '../ui/algo-picker/AlgoPickerModal.svelte';
  import { rememberRecentAlgo, rememberRecentEffect, recentAlgoIds, recentEffectIds } from '../ui/recent-defs.svelte';
  import { RECENT_LIMIT } from '../ui/recent-defs';
  import ClipView from './ClipView.svelte';
  import { startMarquee, type MarqueeBox } from './marquee';
  import { startSectionDrag } from './drag';
  import { drawGrid, drawRuler, type DrawRange, type GridTrackRow } from './grid-draw';
  import {
    xOfTime,
    timeAtX,
    RULER_HEIGHT,
    ROW_HEIGHT,
    SECTION_BAND_HEIGHT,
  } from './view-model';
  import { platform } from '../platform/index';
  import {
    newId,
    type AudioClip,
    type EffectClip,
    type Section,
    type SourceClip,
    type Track,
  } from '../core/schema';
  import { beatDur } from '../core/time';
  import { snapTimeWithSections } from '../core/sections';
  import { resolveTransition } from '../core/transitions';
  import {
    importAudioBlob,
    importFiles,
    importImageBlob,
    importLinkedPath,
    importVideoFile,
  } from '../ui/media-import';
  import { ASSET_DRAG_MIME, insertAssetClip, poolItemById } from '../ui/media-pool';
  import { defaultParams, getGenerator, listGenerators } from '../algos/registry';
  import { createTextElement, createTypographyDocument } from '../typography/document';
  import { canvasPalette } from '../ui/tokens';
  import { reorder } from '../ui/drag-reorder';
  import { theme } from '../ui/theme.svelte';
  import { appState } from '../ui/app-state.svelte';
  import { addToAgentContext, clipContextRefs } from '../ui/agent/context-bridge';
  import { openCurveEditor } from '../ui/curve-editor/curve-editor-state.svelte';
  import { registryRevision } from '../ui/registry-revision.svelte';
  import { statusHint } from '../ui/status-hint.svelte';
  import type { HintTarget } from '../ui/hints';
  import { tr } from '../i18n/index.svelte';
  import { resolveLabel } from '../i18n/label';

  /*
   * 生成器菜单的清单要跟着**运行期注册表**走：插件挂载后，右键菜单必须立刻
   * 多出新的生成器。`registryRevision()` 只为了建立这个依赖 —— 没有它，
   * 这是一次普通的模块级调用，算一次就冻住了（表现是「装了插件但菜单里没有」）。
   */
  const generators = $derived.by(() => {
    registryRevision();
    return listGenerators();
  });

  /** 右键菜单：在鼠标位置（时间 + 轨道）新建片段。 */
  interface CtxMenu {
    x: number;
    y: number;
    trackId: string;
    kind: Track['kind'];
    name: string;
    time: number;
    /** 右键落在哪个片段上（不是空白行）。用来在菜单顶部给出片段级动作。 */
    clipId: string | null;
  }
  let ctxMenu = $state<CtxMenu | null>(null);

  /** 轨道行 ⋯ 菜单：{ 轨道 id, 锚点元素 }。 */
  let rowMenu = $state<{ trackId: string; kind: Track['kind']; anchor: HTMLElement } | null>(null);

  /** 正在重命名的轨道 id。 */
  let renaming = $state<string | null>(null);

  let rulerCanvas: HTMLCanvasElement;
  let gridCanvas: HTMLCanvasElement;
  let scrollEl: HTMLDivElement;
  let rowsEl: HTMLDivElement;
  /** 轨道头列的滚动容器（竖直滚动与画布双向同步，见 `syncVertical`）。 */
  let sideEl: HTMLDivElement;
  /**
   * 轨道头列滚动内容末尾的补偿内边距（px）= 画布那列横向滚动条的高度。
   *
   * 画布的横向滚动条占掉的是它的视口高度，而这列没有那条滚动条 —— 不补的话
   * 两侧最大滚动量差 s，滚到底时低位那侧会把高位那侧拽回来（最后一条轨被
   * 「添加轨道」页脚盖住）。值在 `paint` 里从 `offsetHeight - clientHeight` 读出。
   */
  let sidePad = $state(0);

  /**
   * 轨道头列与画布**竖直**滚动合一。
   *
   * 为什么不是「把两者塞进同一个滚动容器」：两侧的横向滚动语义完全不同
   * （画布要能横向滚几千像素，轨道头列一点都不能动），合并会把 sticky 表头、
   * 横向滚动与 `.rows` 的坐标原点（拖拽/框选/标尺都按 `scrollEl.scrollLeft` 换算）
   * 一起搅进来。而竖直方向**本来就是 1:1 的**：两侧顶部各有一个同高的表头
   * （`.side-head` / 粘住的 `.ruler-wrap`，都是 `RULER_HEIGHT + SECTION_BAND_HEIGHT`），行高也一样。
   * 所以互写 `scrollTop` 就够 —— 但前提是**两侧的滚动量程必须相等**：
   *
   *   - 轨道头列底部有一个 28px 的固定页脚（`添加轨道`），它占掉的是**视口**；
   *   - 画布那列的底部要被横向滚动条吃掉 s 像素（经典滚动条；overlay 时为 0）。
   *
   * 两边各补对方的亏空：画布内容的末尾加一条 28px 空白带（`.footer-pad`），
   * 轨道头列的滚动内容加 s 像素的底部内边距（`sidePad`，见 `paint`）。
   * 量程一相等，`scrollTop` 就是同一把尺子 —— 否则滚到底时低位那侧会把高位那侧
   * 拽回来，表现是「最后一条轨被加轨按钮盖住」。
   *
   * 回环守卫是**值比较**，不是布尔量：写对方会再派发一次 scroll 事件，而 scroll
   * 事件是异步派发的 —— 赋值后立刻复位的布尔量根本来不及挡。等那次事件到达时，
   * 两边的值已经相等，`to.scrollTop === from.scrollTop` 直接返回。
   */
  function syncVertical(from: HTMLElement | undefined, to: HTMLElement | undefined): void {
    if (!from || !to) return;
    if (to.scrollTop === from.scrollTop) return;
    to.scrollTop = from.scrollTop;
  }

  /**
   * 框选进行中的矩形（**内容坐标**，相对 .rows 左上角）。null = 没在框选。
   *
   * 它只是那个框的几何：选中集本身在 appState 里（见 marquee.ts 的注释）。
   * 选中态刻意不进渲染循环的依赖（见下面 `$effect` 的「选中态不在其中」）。
   */
  let marqueeBox = $state<MarqueeBox | null>(null);

  /**
   * 滚动视口的宽度。画布要至少铺这么宽——否则工程末尾右侧会露一条底色空档
   * （时间轴横向只画到 totalWidth，而视口通常比它宽）。
   */
  let scrollW = $state(0);

  /**
   * 响应式纪律（Svelte 5 陷阱）：store.project 是原地改的对象，
   * $derived 靠 === 判断传播——返回同一个引用就断更。
   * 所以从 store 读的派生都必须 ① 先 void appState.version 订阅版本
   * ② 返回新引用（浅拷贝），让变更真正流下去。
   */
  const tracks = $derived.by(() => {
    void appState.version;
    // 浅拷两层：track 与 clips 数组都是原地改的，给 each 新引用才会重渲染。
    return appState.store.project.tracks.map((t) => ({ ...t, clips: [...t.clips] }) as Track);
  });
  const grid = $derived.by(() => {
    void appState.version;
    return { ...appState.store.project.beatGrid };
  });
  const duration = $derived.by(() => {
    void appState.version;
    return appState.store.project.duration;
  });
  const totalWidth = $derived(Math.ceil(xOfTime(duration, appState.pxPerBeat, grid)) + 2);

  /**
   * 每条视觉轨上**能生效**的转场窗口（v13：入场 / 出场各一条，按 trackId 分组）。
   *
   * 只在时间轴上画出来是不够的：「窗口以剪切点为中心、两侧各让 d/2」这件事
   * 必须让人**看见**，否则「转场为什么吃掉了隔壁半秒」永远是个谜。
   * 窗口由 `core/transitions.ts` 算（与渲染同一份钳制），这里只做像素换算。
   */
  type TransitionMark = {
    id: string;
    clipId: string;
    side: 'in' | 'out';
    left: number;
    width: number;
    title: string;
  };
  const transitionMarks = $derived.by(() => {
    void appState.version;
    const map = new Map<string, TransitionMark[]>();
    const px = appState.pxPerBeat;
    const g = appState.store.project.beatGrid;
    for (const track of appState.store.project.tracks) {
      if (track.kind !== 'visual') continue;
      const marks: TransitionMark[] = [];
      for (let i = 0; i < track.clips.length; i += 1) {
        const clip = track.clips[i]!;
        if (clip.kind !== 'source') continue;
        for (const side of ['in', 'out'] as const) {
          const ref = side === 'out' ? clip.transitionOut : clip.transitionIn;
          if (!ref) continue;
          const r = resolveTransition(track, i, side);
          if (!r) continue;
          const start = r.cut - r.duration / 2;
          const end = r.cut + r.duration / 2;
          marks.push({
            id: `${clip.id}:${side}`,
            clipId: clip.id,
            side,
            left: xOfTime(start, px, g),
            width: Math.max(6, xOfTime(end, px, g) - xOfTime(start, px, g)),
            title: `${ref.defId} · ${r.duration.toFixed(2)}s`,
          });
        }
      }
      if (marks.length) map.set(track.id, marks);
    }
    return map;
  });

  /*
   * 段落标记（v8）。**画在标尺上方的 DOM 带子里**，不是 canvas ——
   * 双击改名要输入框、右键要菜单、悬停要 title，这三样在 12px 的画布条里都没有。
   * 标尺的绘制结构因此没动（只多了一个 `mode` 参数决定刻度文案）。
   */
  const sections = $derived.by(() => {
    void appState.version;
    return appState.store.project.sections.map((s) => ({ ...s }));
  });

  /**
   * 手动节奏点（打点计时）。段落带里画成一格刻度、主时间轴画成整条虚线
   * （后者在 `grid-draw.ts`）。读 `version` + 换引用，缺一不会重渲。
   */
  const beatMarks = $derived.by(() => {
    void appState.version;
    return [...appState.store.project.beatMarks];
  });

  /** 段落在带子上的几何：左端 = 起点，右端 = 下一段起点（最后一段到工程末尾）。 */
  const sectionChips = $derived.by(() => {
    const px = appState.pxPerBeat;
    return sections.map((s, i) => {
      const next = sections[i + 1];
      const left = xOfTime(s.start, px, grid);
      const right = xOfTime(next ? next.start : duration, px, grid);
      return { ...s, left, width: Math.max(10, right - left) };
    });
  });

  /** 段落的右键菜单：`id === null` = 在空白处（动作是「在这里加一段」）。 */
  let sectionMenu = $state<{ x: number; y: number; id: string | null; time: number } | null>(null);

  /** 就地改名的输入框（段落名与坐标）。 */
  let sectionRenaming = $state<{ id: string; left: number; width: number; value: string } | null>(
    null,
  );

  function sectionMenuItems(): MenuItem[] {
    const m = sectionMenu;
    if (!m) return [];
    if (!m.id) {
      return [
        {
          id: 'section-add',
          label: tr('tl.addSection'),
          icon: 'plus',
          testid: 'section-add',
          onselect: () => appState.store.addSection(m.time),
        },
      ];
    }
    return [
      {
        /*
         * 「在鼠标处切分」是标记段落的主路径：段落只存起点，所以先标的第一个点
         * 会把整首歌都圈成第一段；从后往前标又反直觉。切一刀 = 插入一个起点，
         * 左半的右边界自动变成它 —— 顺序标记与事后补标记都只需要这一下。
         */
        id: 'section-split',
        label: tr('tl.splitSection'),
        icon: 'scissors',
        disabled: !appState.store.canSplitSection(m.id, m.time),
        testid: 'section-split',
        onselect: () => appState.store.splitSection(m.id!, m.time),
      },
      {
        id: 'section-rename',
        label: tr('tl.renameSection'),
        icon: 'pencil',
        testid: 'section-rename',
        onselect: () => {
          const chip = sectionChips.find((c) => c.id === m.id);
          if (chip) beginSectionRename(chip);
        },
      },
      separator('section-sep'),
      {
        id: 'section-remove',
        label: tr('tl.removeSection'),
        icon: 'trash',
        danger: true,
        testid: 'section-remove',
        onselect: () => appState.store.removeSection(m.id!),
      },
    ];
  }

  /** 右键段落带：落在某一段上就给它菜单，落在空白处就提供「在这里加一段」。 */
  function openSectionCtx(e: MouseEvent): void {
    e.preventDefault();
    e.stopPropagation();
    closeMenus();
    const el = (e.target as HTMLElement)?.closest?.('[data-section-id]');
    sectionMenu = {
      x: e.clientX,
      y: e.clientY,
      id: el?.getAttribute('data-section-id') ?? null,
      time: timeAtClientX(e.clientX),
    };
  }

  function beginSectionRename(chip: { id: string; left: number; width: number; name: string }): void {
    sectionMenu = null;
    sectionRenaming = { id: chip.id, left: chip.left, width: chip.width, value: chip.name };
  }

  function commitSectionRename(value: string): void {
    const target = sectionRenaming;
    sectionRenaming = null;
    if (!target) return;
    const name = value.trim();
    // 空名字保持原名：段落名是唯一的可读标识，删空会变成一个点不中的色块。
    if (name && name !== sections.find((s) => s.id === target.id)?.name) {
      appState.store.renameSection(target.id, name);
    }
  }

  function sectionDown(e: PointerEvent, section: Section): void {
    // 只有主键起手势（右键归 sectionMenu，中键归浏览器）。
    if (e.button !== 0) return;
    if (sectionRenaming?.id === section.id) return;
    startSectionDrag(e, appState.store, {
      section,
      pxPerBeat: appState.pxPerBeat,
      snapMode: appState.snap,
      onClick: () => appState.seek(section.start),
    });
  }

  /** 实际绘制宽度：工程内容与滚动视口取大者。 */
  const drawWidth = $derived(Math.max(totalWidth, scrollW));
  const playheadX = $derived(xOfTime(appState.playT, appState.pxPerBeat, grid));

  const dpr = typeof window !== 'undefined' ? window.devicePixelRatio || 1 : 1;

  /** Canvas 写不了 var()，所以颜色必须由 TS 传进去。这里跟着主题一起派生。 */
  const palette = $derived(canvasPalette(theme.spec));

  function gridRows(): GridTrackRow[] {
    return tracks.map((t) => ({
      kind: t.kind,
      waveClips:
        t.kind === 'audio'
          ? (t.clips as AudioClip[]).map((c) => ({
              start: c.start,
              end: c.end,
              srcIn: c.srcIn,
              assetId: c.assetId,
              fadeIn: c.fadeIn,
              fadeOut: c.fadeOut,
            }))
          : [],
    }));
  }

  /**
   * 已绘制区间（**内容坐标** CSS px）。null = 整块位图都不可信。
   *
   * 每次重绘只覆盖可见那一段 —— 波形按像素走，整幅重绘的成本随工程时长超线性
   * 增长（实测 315s 音频：17650px 的波形路径光栅化要 1096ms，摘掉波形只有 8.4ms）。
   * 所以「已画到哪」必须记账：滚动时只补新露出来的那一条，其余保留位图里的旧像素
   * （由浏览器合成器滚动，本来就是免费的）。
   */
  let painted: { from: number; to: number } | null = null;

  /**
   * 位图覆盖的窗口（**内容坐标**）。画布只占 `[winFrom, winFrom + winW)` 这一段，
   * 不是整幅工程宽。
   *
   * 为什么必须这样做：整幅宽时内存 = 工程时长 × 缩放 × 轨道数 × dpr²，**无上界**。
   * 实测 950s@28px/beat 是 64MB，950s@96px/beat 是 219MB，3000s@96px/beat 是 692MB；
   * 再往上会撞浏览器的 canvas 面积上限（实测 2^28 像素），而**超限时
   * `canvas.width = …` 是静默失败的** —— 留下「位图宽 ≠ style.width」的错位，
   * 整幅画面被压扁，控制台一句话都没有。
   *
   * 改成窗口后是常数：3 个视口宽 ≈ 4MB（dpr 1.5 / 5 轨），与时长和缩放都无关。
   * 窗口靠 `left` / `margin-left` 跟着滚动挪位置 —— 元素本身仍在滚动容器里正常
   * 排布，所以合成器滚动时它和片段 DOM 一起动，不会错位。
   */
  let winFrom = 0;
  let winW = 0;

  /** 当前可见区间（内容坐标）。 */
  function viewRange(): DrawRange {
    const el = scrollEl;
    if (!el) return { x0: 0, x1: 0 };
    return { x0: el.scrollLeft, x1: el.scrollLeft + el.clientWidth };
  }

  /**
   * 窗口宽度：3 个视口宽（上限是工程宽）。
   * 取 3 而不是 1，是为了让窗口有 2 个视口的滑动余量 —— 少挪窗口 = 少一次整窗重画。
   */
  function windowWidth(viewW: number): number {
    return Math.min(drawWidth, Math.max(viewW * 3, viewW));
  }

  /**
   * 这次要补画的区间；返回 null 表示可见区已被覆盖，不用动。
   *
   * `painted` 恒为一段连续区间，所以「没覆盖」的情形只有两种：完全不相交
   * （跳转），或者只缺左边 / 只缺右边一条。
   */
  function gapFor(view: DrawRange): DrawRange | null {
    if (!painted || view.x1 <= painted.from || view.x0 >= painted.to) return view;
    if (view.x0 < painted.from) return { x0: view.x0, x1: Math.min(view.x1, painted.from) };
    if (view.x1 > painted.to) return { x0: Math.max(view.x0, painted.to), x1: view.x1 };
    return null;
  }

  /**
   * 重绘。
   *
   * @param invalidate 内容变了（version / 缩放 / 波形 / 主题 / 工程宽）→ 整块位图
   *   都不可信；否则只是滚动，补画缺的那一条即可。
   */
  function paint(invalidate: boolean): void {
    if (invalidate) painted = null;
    if (!rulerCanvas || !gridCanvas) return;
    const el = scrollEl;
    if (!el) return;
    const viewW = el.clientWidth;
    if (viewW <= 0) return;
    /*
     * 横向滚动条从这一列的**视口**里吃掉 s 像素（经典滚动条；overlay 时为 0）。
     * 轨道头列用同高的底部内边距补回来 —— 两侧量程相等，`scrollTop` 才是同一把尺子。
     * 读的是 offsetHeight/clientHeight，与滚动条实现无关（不写死 9px）。
     *
     * `clientHeight === 0` 是**还没布局**（首次 paint 早于 layout）：此时两者的差
     * 等于整个高度，拿它当滚动条会把轨道头列撑出一个巨大的空白。钳到一行以内即可
     * —— 真实的滚动条高度是 9~17px。
     */
    if (el.clientHeight > 0) {
      const bar = Math.max(0, Math.min(ROW_HEIGHT, el.offsetHeight - el.clientHeight));
      if (bar !== sidePad) sidePad = bar;
    }
    const view = viewRange();

    // ① 窗口几何：宽度变了、或者可见区跑到窗口外面去了 → 重新定位 + 整窗重画
    const want = windowWidth(viewW);
    if (want !== winW) {
      winW = want;
      invalidate = true;
    }
    if (invalidate || view.x0 < winFrom || view.x1 > winFrom + winW) {
      // 尽量让可见区居中，两端钳到工程范围内
      const maxFrom = Math.max(0, drawWidth - winW);
      winFrom = Math.min(maxFrom, Math.max(0, view.x0 - Math.round((winW - (view.x1 - view.x0)) / 2)));
      invalidate = true;
    }
    if (invalidate) painted = null;

    // 元素位置必须在画之前落定：画布就摆在那，绘制原点才不会和它对不上
    if (rulerCanvas.style.marginLeft !== `${winFrom}px`) {
      rulerCanvas.style.marginLeft = `${winFrom}px`;
    }
    if (gridCanvas.style.left !== `${winFrom}px`) {
      gridCanvas.style.left = `${winFrom}px`;
    }

    const gap = gapFor(view);
    if (!gap) return;
    const pal = palette;
    const project = appState.store.project;
    const ppb = appState.pxPerBeat;
    const r1 = drawRuler(
      rulerCanvas,
      project,
      ppb,
      dpr,
      pal,
      winW,
      winFrom,
      gap,
      appState.timelineMode,
    );
    const r2 = drawGrid(
      gridCanvas,
      project,
      ppb,
      gridRows(),
      appState.waveforms,
      dpr,
      pal,
      winW,
      winFrom,
      gap,
    );
    // 画布被重建过 → 位图已经清空，之前画的统统不算，只认这次画到的
    painted =
      r1 || r2 || !painted
        ? { from: gap.x0, to: gap.x1 }
        : { from: Math.min(painted.from, gap.x0), to: Math.max(painted.to, gap.x1) };
  }

  // 重绘订阅源：version / 缩放 / 吸附 / 波形 / 主题 / 视口宽。选中态刻意不在其中
  // （splitter 的教训：select 触发全量重建会在拖拽中换掉 DOM）。
  $effect(() => {
    void appState.version;
    void appState.pxPerBeat;
    void appState.snap;
    // 标尺文案（小节.拍 / 分:秒.帧）只在换形态时变，但它写在位图里 —— 必须重画。
    void appState.timelineMode;
    void appState.waveforms;
    /* activeProjectId 必须进依赖：切工程时 `subscribeActive` 只是把 version
       换成新工程的计数，**两份工程的 version 撞号时这次赋值不产生变化**，
       effect 就不会跑 —— 画布会停在上一份工程的内容上，而 `painted` 还声称
       自己是新鲜的。切换工程是「内容整体换掉」，必须无条件重画。 */
    void appState.activeProjectId;
    void palette;
    // 绘制本身直接读 store.project（不是响应式的），所以拍网格与工程宽这两个
    // 决定画布几何的派生量必须在这里显式订阅，否则改了 BPM 网格不重画。
    void grid;
    void drawWidth;
    paint(true);
  });

  /** 跟踪滚动视口宽度，供 drawWidth 使用。 */
  $effect(() => {
    const el = scrollEl;
    if (!el) return;
    const ro = new ResizeObserver(() => {
      if (el.clientWidth !== scrollW) scrollW = el.clientWidth;
      // 视口变宽会让右侧露出没画过的区域（drawWidth 未必跟着变，所以不能只靠上面的 effect）
      paint(false);
    });
    ro.observe(el);
    scrollW = el.clientWidth;
    paint(false);
    return () => ro.disconnect();
  });

  /*
   * 界面字体是随包分发的 webfont，而**标尺文案画在位图里**：DOM 文本在字体
   * 到达后浏览器会自己重排，Canvas 不会 —— 首帧用回落字体量出来的刻度会一直
   * 留到下一次重绘（CJK 那份 13MB，冷启动时基本赶不上第一帧）。
   *
   * 两个信号都要听：`ready` 只等「此刻在途」的那批；`loadingdone` 补上之后才
   * 被某个控件触发的族（字体是逐字回落时才去取的）。
   */
  $effect(() => {
    if (typeof document === 'undefined' || !document.fonts) return;
    let alive = true;
    const repaint = () => {
      if (alive) paint(true);
    };
    void document.fonts.ready.then(repaint);
    document.fonts.addEventListener('loadingdone', repaint);
    return () => {
      alive = false;
      document.fonts.removeEventListener('loadingdone', repaint);
    };
  });

  /* ------------------------------------------------------------ 新建 */

  function startAtPlayhead(): number {
    return Math.max(
      0,
      Math.min(
        duration - 0.25,
        snapTimeWithSections(
          appState.playT,
          appState.snap,
          grid,
          appState.store.project.sections,
          appState.store.project.fps,
          appState.store.project.beatMarks,
        ),
      ),
    );
  }

  /** 新建片段的起点：右键菜单给位置，按钮给播放头。 */
  function startFor(at?: number): number {
    return at === undefined ? startAtPlayhead() : Math.max(0, at);
  }

  function twoBeats(): number {
    return Math.max(0.25, beatDur(grid) * 2);
  }

  /** 新片段默认长度（秒）：纯色 2 拍，算法 / 特效 4 拍。 */
  function solidLen(): number {
    return twoBeats();
  }
  function longLen(): number {
    return twoBeats() * 2;
  }

  function addAlgo(trackId: string, genId: string, at?: number): void {
    const def = getGenerator(genId);
    if (!def) return;
    closeMenus();
    const start = startFor(at);
    const clip: SourceClip = {
      kind: 'source',
      id: newId(),
      start,
      end: start + longLen(),
      label: resolveLabel(def.nameKey, tr),
      fadeSec: 0,
      curves: {},
      source: { type: 'algo', generator: genId, params: defaultParams(genId) },
      blend: 'normal',
      opacity: 1,
      transform: { x: 0.5, y: 0.5, sx: 1, sy: 1, rot: 0 },
      fit: 'stretch',
    };
    appState.store.addClip(trackId, clip);
    appState.selectedClipId = clip.id;
    rememberRecentAlgo(genId);
  }

  function addSolid(trackId: string, at?: number): void {
    closeMenus();
    const start = startFor(at);
    const clip: SourceClip = {
      kind: 'source',
      id: newId(),
      start,
      end: start + solidLen(),
      label: tr('tl.clipSolid'),
      fadeSec: 0,
      curves: {},
      source: { type: 'solid', color: '#3a6ea5' },
      blend: 'normal',
      opacity: 1,
      transform: { x: 0.5, y: 0.5, sx: 1, sy: 1, rot: 0 },
      fit: 'stretch',
    };
    appState.store.addClip(trackId, clip);
    appState.selectedClipId = clip.id;
  }

  /**
   * 排版片段。文档尺寸默认取当前工程分辨率 —— 这样新建出来的文本框是
   * 「1:1 摆在画面上」的，用户不必先算缩放。
   *
   * fit 用 contain 而不是 stretch：以后改工程分辨率时文字不会被拉变形
   * （contain 会等比缩放并留边），而 stretch 会把版式压扁。
   */
  function addText(trackId: string, at?: number): void {
    closeMenus();
    const start = startFor(at);
    const doc = createTypographyDocument(appState.store.project.resolution);
    doc.elements = [createTextElement(doc.size)];
    // 新文档继承**工程级**配色方案（「应用到整个项目」设的那个）。没设过就不写这个键
    // —— 显式写 undefined 会在文档上留一个幽灵属性（JSON 往返会把它丢掉，
    // 于是「存过没存过」在比较里表现不一致）。
    const projectTheme = appState.project.typographyTheme;
    if (projectTheme) doc.theme = projectTheme;
    const clip: SourceClip = {
      kind: 'source',
      id: newId(),
      start,
      end: start + longLen(),
      label: tr('tl.clipText'),
      fadeSec: 0,
      curves: {},
      source: { type: 'text', doc },
      blend: 'normal',
      opacity: 1,
      transform: { x: 0.5, y: 0.5, sx: 1, sy: 1, rot: 0 },
      fit: 'contain',
    };
    appState.store.addClip(trackId, clip);
    appState.selectedClipId = clip.id;
  }

  /**
   * 新建特效片段。
   *
   * 以前这里是「建一个空链」——菜单里没有特效可选，用户得再去检查器里加。
   * 现在「特效片段」的二级菜单直接给最近用过的特效 + 「全部特效…」，
   * 所以新建时**就带着至少一个实例**；多选（选择器里）按选择顺序入链。
   */
  function addEffect(trackId: string, defIds: readonly string[], at?: number): void {
    closeMenus();
    const start = startFor(at);
    const chain = defIds
      .filter((id) => getEffect(id))
      .map((defId) => ({
        instanceId: newId(),
        defId,
        enabled: true,
        values: defaultEffectValues(defId),
      }));
    const clip: EffectClip = {
      kind: 'effect',
      id: newId(),
      start,
      end: start + longLen(),
      label: tr('tl.clipEffect'),
      fadeSec: 0,
      curves: {},
      chain,
    };
    appState.store.addClip(trackId, clip);
    appState.selectedClipId = clip.id;
    for (const inst of chain) rememberRecentEffect(inst.defId);
  }

  /**
   * 导入音频。
   *
   * 三条导入（视频 / 图片 / 音频）都只是**选文件**这一步不同，剩下的
   * （进仓 → 登记 → 建片段 → 选中）全在 `ui/media-import.ts` —— 拖拽走的是
   * 同一个函数。这里各留一个短壳，是因为菜单里的选项本来就叫「导入音频…」。
   */
  async function addAudio(trackId: string, at?: number): Promise<void> {
    closeMenus();
    const target = { trackId, start: startFor(at) };
    // 默认 linked：文件留在原处，工程里不复制（换机器/打包时再 collect）。
    if (platform.supportsLinked) {
      const linked = await platform.pickLinkedFile('audio');
      if (!linked) return;
      // 桌面版即使给了 `File`，也要走 path 分支：`File` 只是读取用，
      // 台账必须记真实路径（否则会退化成 bundled，白读一份字节）。
      if (linked.path) {
        await importLinkedPath('audio', linked.name, linked.path, linked.size, target);
      } else if (linked.file) {
        await importAudioBlob(linked.name, await linked.file.arrayBuffer(), target, linked.handle);
      }
      return;
    }
    const picked = await platform.pickAudioFile();
    if (!picked) return;
    await importAudioBlob(picked.name, picked.data, target);
  }

  /** 导入视频。细节见 `ui/media-import.ts::importVideoFile`（含「先给句柄」的理由）。 */
  async function addVideo(trackId: string, at?: number): Promise<void> {
    closeMenus();
    const target = { trackId, start: startFor(at) };
    if (platform.supportsLinked) {
      const linked = await platform.pickLinkedFile('video');
      if (!linked) return;
      if (linked.file) {
        await importVideoFile(linked.file, target, linked.handle);
      } else if (linked.path) {
        await importLinkedPath('video', linked.name, linked.path, linked.size, target);
      }
      return;
    }
    const picked = await platform.pickVideoFile();
    if (!picked) return;
    await importVideoFile(picked.file, target);
  }

  /** 导入图片（`fit: 'contain'`、长度 4 拍 —— 理由见 `ui/media-pool.ts::clipForAsset`）。 */
  async function addImage(trackId: string, at?: number): Promise<void> {
    closeMenus();
    const target = { trackId, start: startFor(at) };
    if (platform.supportsLinked) {
      const linked = await platform.pickLinkedFile('image');
      if (!linked) return;
      if (linked.path) {
        await importLinkedPath('image', linked.name, linked.path, linked.size, target);
      } else if (linked.file) {
        await importImageBlob(linked.name, await linked.file.arrayBuffer(), target, linked.handle);
      }
      return;
    }
    const picked = await platform.pickImageFile();
    if (!picked) return;
    await importImageBlob(picked.name, picked.data, target);
  }

  /* ------------------------------------------------------------ 轨道操作 */

  function removeTrack(track: Track): void {
    closeMenus();
    // 这条轨上的片段若在选中集里，一并摘掉 —— 否则选中集里留着指向
    // 不存在片段（甚至指向别的工程的对象）的 id。
    const gone = new Set(track.clips.map((c) => c.id));
    appState.setClipSelection(appState.selectedClipIds.filter((id) => !gone.has(id)));
    appState.store.removeTrack(track.id);
  }

  function beginRename(trackId: string): void {
    closeMenus();
    renaming = trackId;
  }

  function commitRename(trackId: string, value: string): void {
    appState.store.renameTrack(trackId, value);
    renaming = null;
  }

  /* ------------------------------------------------------------ 菜单构造
   *
   * 轨道行 ⋯ 菜单与时间轴右键菜单是**同一套动作**（都是「在这条轨上新建片段 /
   * 改这条轨」），所以共用构造器，用一个 `prefix` 区分 testid：
   * 行菜单 `add-*`（add-solid / add-effect / add-algo-<id> / import-audio），
   * 右键菜单 `ctx-*`。测试要能分辨「从行菜单建的」与「从右键建的」两条入口。
   */

  /**
   * 「特效片段」/「算法片段」的二级菜单：**最近用过的 5 个 + 全部…**
   *
   * 为什么不再平铺全部：特效七十多个、生成器二十多个，一次列出来既撑爆菜单，
   * 也让人每次都要从头找自己那三五个常用的。最近项按「用过的时间」倒序，
   * 存在 localStorage（见 `ui/recent-defs.ts`）；条目带缩略图，悬停就出预览浮层。
   *
   * 注册表里已经没有的 id（插件卸载、老工程残留）**静默跳过** —— 菜单少一项
   * 远好过点进去建出一个渲染不出来的片段。
   */
  function recentEffectMenuItems(trackId: string, at: number | undefined, prefix: string): MenuItem[] {
    const out: MenuItem[] = [];
    const seen = new Set<string>();
    for (const id of recentEffectIds()) {
      if (seen.has(id)) continue;
      const entry = getEffect(id);
      if (!entry) continue;
      seen.add(id);
      const cat = EFFECT_CATALOG[id];
      out.push({
        id: `${prefix}effect-${id}`,
        label: resolveLabel(entry.nameKey, tr),
        testid: `${prefix}effect-${id}`,
        onselect: () => addEffect(trackId, [id], at),
        thumb: effectThumbUrl(id) ?? undefined,
        desc: cat
          ? tr(cat.descKey)
          : entry.meta?.desc
            ? resolveLabel(entry.meta.desc, tr)
            : resolveLabel(entry.nameKey, tr),
      });
      if (out.length >= RECENT_LIMIT) break;
    }
    return out;
  }

  function recentAlgoMenuItems(trackId: string, at: number | undefined, prefix: string): MenuItem[] {
    const byId = new Map(generators.map((g) => [g.id, g]));
    const out: MenuItem[] = [];
    for (const id of recentAlgoIds()) {
      const g = byId.get(id);
      if (!g) continue;
      const entry = ALGO_CATALOG[id];
      out.push({
        id: `${prefix}algo-${id}`,
        label: resolveLabel(g.nameKey, tr),
        testid: `${prefix}algo-${id}`,
        onselect: () => addAlgo(trackId, id, at),
        thumb: algoThumbUrl(id) ?? undefined,
        desc: entry ? tr(entry.descKey) : g.desc ? resolveLabel(g.desc, tr) : resolveLabel(g.nameKey, tr),
      });
      if (out.length >= RECENT_LIMIT) break;
    }
    return out;
  }

  /** 「全部…」放在最近项之后，中间用分隔线隔开 —— 它不是「最近用过的」之一。 */
  function withAll(
    recent: MenuItem[],
    prefix: string,
    kind: 'effect' | 'algo',
    trackId: string,
    at: number | undefined,
  ): MenuItem[] {
    const allId = `${prefix}${kind}-all`;
    return [
      ...recent,
      // 没有最近项时不画空分隔线（菜单顶部贴一条线很难看）
      ...(recent.length ? [separator(`${prefix}${kind}-sep`)] : []),
      {
        id: allId,
        label: kind === 'effect' ? tr('tl.allEffects') : tr('tl.allAlgos'),
        icon: 'layout-grid',
        testid: allId,
        onselect: () => openPicker(kind, trackId, at),
      },
    ];
  }

  function effectMenuItems(trackId: string, at: number | undefined, prefix: string): MenuItem[] {
    return withAll(recentEffectMenuItems(trackId, at, prefix), prefix, 'effect', trackId, at);
  }

  function generatorItems(trackId: string, at: number | undefined, prefix: string): MenuItem[] {
    return withAll(recentAlgoMenuItems(trackId, at, prefix), prefix, 'algo', trackId, at);
  }

  /* ------------------------------------------------------------ 选择器 */

  type PickKind = 'effect' | 'algo';

  /**
   * 正在为哪条轨 / 哪个时刻选择片段。`null` = 没有打开选择器。
   *
   * 存 `at` 而不是「建好片段再让选择器往里填」：右键菜单给的是**鼠标位置**，
   * 建完片段再问用户要选什么的话，中途关掉选择器就会留下一个空片段。
   */
  let pickTarget = $state<{ kind: PickKind; trackId: string; at: number | undefined } | null>(null);

  function openPicker(kind: PickKind, trackId: string, at: number | undefined): void {
    closeMenus();
    pickTarget = { kind, trackId, at };
  }

  function clipItems(track: Track, at: number | undefined, prefix: string): MenuItem[] {
    if (track.kind === 'audio') {
      return [
        {
          id: `${prefix}audio`,
          label: tr('tl.importAudioMenu'),
          icon: 'music',
          testid: prefix === 'ctx-' ? `${prefix}audio` : 'import-audio',
          onselect: () => void addAudio(track.id, at),
        },
      ];
    }
    /*
     * 一级平铺；「特效片段」「算法片段」各展开一级。
     *
     * 曾经把三个都塞进「添加片段」二级里，反而多一次悬停才点得到；
     * 用户反馈要的是「+ 纯色片段 / + 特效片段 / + 算法片段」这种直接可点的形式。
     * 现在这两类各自**再有一级**，但只放最近用过的 5 个 —— 既保持一级可点，
     * 又不必在七十多个特效里翻。
     */
    return [
      {
        id: `${prefix}solid`,
        label: tr('tl.addSolid'),
        icon: 'palette',
        testid: `${prefix}solid`,
        onselect: () => addSolid(track.id, at),
      },
      {
        id: `${prefix}text`,
        label: tr('tl.addText'),
        icon: 'type',
        testid: `${prefix}text`,
        onselect: () => addText(track.id, at),
      },
      {
        ...submenu(`${prefix}effect`, tr('tl.addEffect'), effectMenuItems(track.id, at, prefix), 'flask-conical'),
        testid: `${prefix}effect`,
      },
      {
        id: `${prefix}image`,
        label: tr('tl.importImageMenu'),
        icon: 'image',
        testid: prefix === 'ctx-' ? `${prefix}image` : 'import-image',
        onselect: () => void addImage(track.id, at),
      },
      {
        id: `${prefix}video`,
        label: tr('tl.importVideoMenu'),
        icon: 'video',
        testid: prefix === 'ctx-' ? `${prefix}video` : 'import-video',
        onselect: () => void addVideo(track.id, at),
      },
      // `submenu()` 不接 testid，但这一项需要能被测试点到（`add-algo`）。
      // 子项带 `add-algo-<id>`，父项没名字就没法定位到那个二级菜单。
      {
        ...submenu(`${prefix}algo`, tr('tl.addAlgo'), generatorItems(track.id, at, prefix), 'sigma'),
        testid: `${prefix}algo`,
      },
    ];
  }

  /**
   * 视觉轨上是否有视频片段 —— 只有它们带声音，喇叭按钮才有意义。
   * 纯色 / 算法 / 图片 / 排版轨上放一个永远不生效的静音键只会占位。
   */
  function trackHasVideo(track: Track): boolean {
    return (
      track.kind === 'visual' &&
      track.clips.some((c) => c.kind === 'source' && c.source.type === 'video')
    );
  }

  function trackMenuItems(track: Track, at?: number, prefix = 'add-'): MenuItem[] {
    return [
      ...clipItems(track, at, prefix),
      separator('s1'),
      { id: 'rename', label: tr('tl.renameTrack'), icon: 'pencil', testid: 'track-menu-rename', onselect: () => beginRename(track.id) },
      separator('s2'),
      { id: 'remove', label: tr('tl.removeTrack'), icon: 'trash', danger: true, testid: 'track-menu-remove', onselect: () => removeTrack(track) },
    ];
  }

  /** 右键菜单：与行菜单同动作，但 testid 带 ctx- 前缀（测试要能分辨入口）。 */
  function ctxItems(): MenuItem[] {
    const m = ctxMenu;
    if (!m) return [];
    const track = appState.store.track(m.trackId);
    if (!track) return [];
    const base = trackMenuItems(track, m.time, 'ctx-');
    if (!m.clipId) return base;
    const found = appState.store.findClip(m.clipId);
    if (!found) return base;
    /*
     * 片段级动作放在「新建片段」前面：右键一个片段时，用户想的多半是
     * 「改这一个」而不是「在这里再加一个」。曲线入口不看有没有关键帧 ——
     * 没有时编辑器会显示空白参数表，点一下就能建，比禁用一个菜单项好懂。
     */
    const audioActions: MenuItem[] = [];
    if (found.clip.kind === 'source' && found.clip.source.type === 'video' && !found.clip.linkedAudioId) {
      audioActions.push({
        id: 'ctx-detach-audio',
        label: tr('tl.detachAudio'),
        icon: 'audio-lines',
        testid: 'ctx-detach-audio',
        onselect: () => {
          const id = appState.store.detachVideoAudio(found.clip.id);
          if (id) appState.selectClip(id);
        },
      });
    }
    if (found.clip.kind === 'audio' && found.clip.linkedVideoId) {
      const locked = Boolean(found.clip.lockedTo);
      audioActions.push({
        id: 'ctx-audio-lock',
        label: tr(locked ? 'tl.audioUnlock' : 'tl.audioLock'),
        icon: 'link',
        testid: 'ctx-audio-lock',
        onselect: () => appState.store.setAudioLocked(found.clip.id, !locked),
      });
    }

    /*
     * 「添加进上下文」：右键的片段若在选区里，钉的是**整个选区** —— 多选的
     * 含义就是「这一组」，只钉一个会让用户以为漏了。取选区在 `onselect` 里做，
     * 菜单开着的时候选择还可能变。
     */
    const inSelection = appState.selectedClipIds.includes(found.clip.id);
    const selectedCount = inSelection ? appState.selectedClipIds.length : 1;

    return [
      {
        id: 'ctx-add-context',
        label: selectedCount > 1 ? tr('agent.addToContextMany', { n: selectedCount }) : tr('agent.addToContext'),
        icon: 'message-circle-plus',
        testid: 'ctx-add-context',
        onselect: () => {
          const ids = appState.selectedClipIds.includes(found.clip.id)
            ? appState.selectedClipIds
            : [found.clip.id];
          addToAgentContext(clipContextRefs(ids));
        },
      },
      separator('ctx-context-sep'),
      {
        id: 'ctx-edit-curves',
        label: tr('curve.openMenu'),
        icon: 'spline',
        testid: 'ctx-edit-curves',
        onselect: () => {
          appState.selectClip(found.clip.id);
          openCurveEditor(found.clip.id);
        },
      },
      ...(audioActions.length ? [separator('ctx-audio-sep'), ...audioActions] : []),
      separator('ctx-clip-sep'),
      ...base,
    ];
  }

  function closeMenus(): void {
    ctxMenu = null;
    rowMenu = null;
  }

  /* ------------------------------------------------------------ 交互 */

  /** 标尺按下 / 拖动 = scrub 播放头（吸附到当前档位）。 */
  function scrub(e: PointerEvent): void {
    e.preventDefault();
    const el = e.currentTarget as HTMLElement;
    el.setPointerCapture(e.pointerId);
    const seekTo = (ev: PointerEvent): void => {
      const rect = scrollEl.getBoundingClientRect();
      const x = ev.clientX - rect.left + scrollEl.scrollLeft;
      appState.seek(Math.max(0, timeAtX(x, appState.pxPerBeat, grid)), { snap: true });
    };
    // 拖动期间给模拟步进压预算：向前跳要真把中间每一步算完（迭代系统没有
    // 闭式解），不给预算就会在拖动时冰住几秒。松手后 appState 自己切追赶档。
    appState.beginScrub();
    seekTo(e);
    const mv = (ev: PointerEvent): void => seekTo(ev);
    const up = (): void => {
      appState.endScrub();
      el.removeEventListener('pointermove', mv);
      el.removeEventListener('pointerup', up);
      el.removeEventListener('pointercancel', up);
    };
    el.addEventListener('pointermove', mv);
    el.addEventListener('pointerup', up);
    el.addEventListener('pointercancel', up);
  }

  /** 滚轮：纵向滚 = 横向滚动；Ctrl+滚 = 以鼠标为锚缩放。 */
  function wheel(e: WheelEvent): void {
    if (e.ctrlKey) {
      e.preventDefault();
      const rect = scrollEl.getBoundingClientRect();
      const x = e.clientX - rect.left + scrollEl.scrollLeft;
      const tAnchor = timeAtX(x, appState.pxPerBeat, grid);
      const next = Math.max(6, Math.min(96, appState.pxPerBeat * (e.deltaY > 0 ? 0.85 : 1.18)));
      appState.pxPerBeat = next;
      // 缩放后把锚点时间放回鼠标下
      scrollEl.scrollLeft = Math.max(0, xOfTime(tAnchor, next, grid) - (e.clientX - rect.left));
      return;
    }
    scrollEl.scrollLeft += e.deltaY + e.deltaX;
    e.preventDefault();
  }

  /**
   * 空白处按下 = 点一下取消选择 / 拖出矩形框选，由 marquee.ts 用 4px 阈值区分。
   *
   * 片段与转场标记在各自的 pointerdown 里 stopPropagation，所以能冒泡到
   * 这里的本来就是真正的空白；判 `data-tl-row` 只是再确认一次。
   */
  function onRowsPointerDown(e: PointerEvent): void {
    if (e.button !== 0) return;
    if (!(e.target as HTMLElement).hasAttribute('data-tl-row')) return;
    const rows = rowsEl;
    if (!rows) return;
    startMarquee(e, {
      start: { x: e.clientX, y: e.clientY },
      selection: [...appState.selectedClipIds],
      /*
       * 局部坐标 = client 减 .rows 的 rect。**不读 scrollLeft** ——
       * 滚动已经反映在 rect 的位置里，再减一次会在滚动过的位置整体错位。
       */
      toLocal: (cx, cy) => {
        const r = rows.getBoundingClientRect();
        return { x: cx - r.left, y: cy - r.top };
      },
      onSelect: (ids) => appState.setClipSelection(ids),
      onBox: (b) => (marqueeBox = b),
    });
  }

  /* ------------------------------------------------------------ 底栏提示 */

  /**
   * 指针落在了哪一类目标上（底栏提示的悬停层）。
   *
   * **一个委托处理器**，不是每个元素各挂一份 —— 判定顺序本身就是优先级：
   * 片段（`data-clip-id`）压过它所在的行，行 / 标尺 / 轨道头由 `data-hint` 标记
   * （在模板上就近写着「这里是什么」，比在这里列一串选择器更难漂移）。
   *
   * 用 `pointerover`（会冒泡）而不是 `pointerenter`（不会）：在行内从一个元素滑到
   * 另一个（片段 ↔ 行背景 ↔ 转场标记）时，只有冒泡的那个能重新判定「现在指着谁」。
   * 底栏说明的是**上下文**，不是「上一次指针进到哪里」。
   */
  function hintTargetAt(target: EventTarget | null): HintTarget | null {
    if (!(target instanceof HTMLElement)) return null;
    const id = target.closest('[data-clip-id]')?.getAttribute('data-clip-id');
    if (id) return { kind: 'clip', id };
    const named = target.closest('[data-hint]')?.getAttribute('data-hint');
    return named === 'rows' || named === 'ruler' || named === 'track' ? { kind: named } : null;
  }

  /** 鼠标 x → 工程时间（吸附）。右键菜单与拖拽落点共用同一套换算。 */
  function timeAtClientX(clientX: number): number {
    const rect = scrollEl.getBoundingClientRect();
    const x = clientX - rect.left + scrollEl.scrollLeft;
    return Math.max(
      0,
      snapTimeWithSections(
        timeAtX(x, appState.pxPerBeat, grid),
        appState.snap,
        grid,
        appState.store.project.sections,
        appState.store.project.fps,
        appState.store.project.beatMarks,
      ),
    );
  }

  function openCtx(e: MouseEvent, track: Track): void {
    e.preventDefault();
    e.stopPropagation();
    rowMenu = null;
    /*
     * 右键落在片段上时记下它：ClipView 自己不处理 contextmenu（右键归 Timeline），
     * 所以这里用 `elementFromPoint` 反查 —— 比给每个片段再挂一个 contextmenu
     * 处理器少一条事件路径，也不会出现「片段菜单与轨道菜单各有各的实现」。
     */
    const hit = document.elementFromPoint(e.clientX, e.clientY);
    const clipId = hit?.closest('[data-clip-id]')?.getAttribute('data-clip-id') ?? null;
    ctxMenu = {
      x: e.clientX,
      y: e.clientY,
      trackId: track.id,
      kind: track.kind,
      name: track.name,
      time: timeAtClientX(e.clientX),
      clipId,
    };
  }

  function openRowMenu(e: MouseEvent, track: Track): void {
    e.preventDefault();
    e.stopPropagation();
    ctxMenu = null;
    rowMenu = { trackId: track.id, kind: track.kind, anchor: e.currentTarget as HTMLElement };
  }

  /* ------------------------------------------------------------ 拖进来 */

  /**
   * 拖拽落点提示：**指针所在的行 + 吸附后的落点**（画一条竖线）。
   * 只在拖进来的东西认得时才亮 —— 拖个网页链接过来不该在轨道上画线。
   */
  let dropHint = $state<{ trackId: string; x: number; top: number } | null>(null);

  /** 拖的是不是我们认的东西：媒体池的素材（自定义类型）还是系统文件。 */
  function droppedKind(dt: DataTransfer | null): 'asset' | 'files' | null {
    if (!dt) return null;
    if (dt.types.includes(ASSET_DRAG_MIME)) return 'asset';
    if (dt.types.includes('Files')) return 'files';
    return null;
  }

  /**
   * clientY → 行下标。拖到行区下面的空白处算**最后一行**（那里没有时刻可言，
   * 但「想放到最下面那条轨」的意图很清楚）。
   */
  function rowIndexAt(clientY: number): number {
    if (!rowsEl) return 0;
    const r = rowsEl.getBoundingClientRect();
    const i = Math.floor((clientY - r.top) / ROW_HEIGHT);
    return Math.min(Math.max(i, 0), Math.max(0, tracks.length - 1));
  }

  function onRowsDragOver(e: DragEvent): void {
    if (!droppedKind(e.dataTransfer)) return;
    /*
     * preventDefault 是**必须的**：不阻止默认行为，浏览器根本不允许在这里落点
     * （drop 事件不会发生，而 dragover 也不会被允许改 dropEffect）。
     */
    e.preventDefault();
    if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
    const i = rowIndexAt(e.clientY);
    const track = tracks[i];
    if (!track) return;
    dropHint = {
      trackId: track.id,
      x: xOfTime(timeAtClientX(e.clientX), appState.pxPerBeat, grid),
      top: i * ROW_HEIGHT,
    };
  }

  function onRowsDragLeave(e: DragEvent): void {
    // 只在**真的离开整块行区**时清：dragleave 会为每个子元素冒泡上来一次，
    // 按它清会让竖线在行内移动时闪。
    const to = e.relatedTarget as Node | null;
    if (to && rowsEl?.contains(to)) return;
    dropHint = null;
  }

  function onRowsDrop(e: DragEvent): void {
    const kind = droppedKind(e.dataTransfer);
    if (!kind) return;
    e.preventDefault();
    const track = tracks[rowIndexAt(e.clientY)];
    dropHint = null;
    if (!track) return;

    const start = timeAtClientX(e.clientX);
    if (kind === 'asset') {
      // 媒体池里拖出来的一条素材：与点「+」走**同一个函数**（落点规则只有一处）
      const id = e.dataTransfer?.getData(ASSET_DRAG_MIME) ?? '';
      const item = id ? poolItemById(appState.store.project.assets, appState.assets, id) : null;
      if (!item) return;
      const clipId = insertAssetClip(appState.store, item, {
        at: start,
        grid,
        preferredTrackId: track.id,
      });
      if (clipId) appState.selectedClipId = clipId;
      return;
    }

    // 系统文件：与菜单里的「导入…」同一条路（probe / 进仓 / 建片段都在那边）
    const files = Array.from(e.dataTransfer?.files ?? []);
    if (files.length) void importFiles(files, { start, trackId: track.id });
  }
</script>

<!--
  底栏提示的悬停判定挂在整个时间轴上（而不是每个片段 / 每行各挂一份）：
  见 `hintTargetAt` 的注释。
-->
<div
  class="tl"
  role="presentation"
  onpointerover={(e) => statusHint.setHover(hintTargetAt(e.target))}
  onpointerleave={() => statusHint.clearHover()}
>
  <!--
    轨道行可拖曳排序。挂在整个 .side 上而不是每行上：拖动时要把它**兄弟**
   的 transform 一起算，只有容器才拿得到全量。
    行菜单 / 重命名输入框都在行内，所以拖曳是「位移超过阈值才算」——
    4px 以内的移动仍然是一次正常的点击。
  -->
  <div class="side-wrap">
    <div
      class="side"
      bind:this={sideEl}
      style:padding-bottom={`${sidePad}px`}
      onscroll={() => syncVertical(sideEl, scrollEl)}
      use:reorder={{
        axis: 'y',
        itemSelector: '[data-testid=track-side-row]',
        onReorder: (from, to) => appState.store.moveTrack(from, to),
      }}
    >
      <!-- 与画布列等高：段落带 + 标尺（见 SECTION_BAND_HEIGHT 的注释） -->
      <div class="side-head" style:height={`${RULER_HEIGHT + SECTION_BAND_HEIGHT}px`}>
        <span class="side-title">{tr('tl.sideTitle')}</span>
      </div>

      {#each tracks as track (track.id)}
        <div
          class="side-row"
          style:height={`${ROW_HEIGHT}px`}
          class:muted={!track.enabled}
          data-track-id={track.id}
          data-hint="track"
          data-testid="track-side-row"
          role="presentation"
          oncontextmenu={(e) => openCtx(e, track)}
        >
          <IconButton
            icon={track.kind === 'audio'
              ? track.enabled
                ? 'megaphone'
                : 'megaphone-off'
              : track.enabled
                ? 'eye'
                : 'eye-off'}
            label={track.kind === 'audio'
              ? track.enabled
                ? tr('tl.muteAudioTrack')
                : tr('tl.unmuteAudioTrack')
              : track.enabled
                ? tr('tl.hideTrack')
                : tr('tl.showTrack')}
            size="sm"
            active={track.enabled}
            testid="track-enabled"
            onclick={() => appState.store.toggleTrackEnabled(track.id)}
          />

          {#if renaming === track.id}
            <!-- svelte-ignore a11y_autofocus -->
            <input
              class="rename"
              data-testid="track-rename-input"
              value={track.name}
              autofocus
              onblur={(e) => commitRename(track.id, e.currentTarget.value)}
              onkeydown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault();
                  commitRename(track.id, e.currentTarget.value);
                } else if (e.key === 'Escape') {
                  e.preventDefault();
                  renaming = null;
                }
              }}
              onpointerdown={(e) => e.stopPropagation()}
            />
          {:else}
            <span
              class="tname"
              data-testid="track-name"
              title={track.name}
              role="presentation"
              ondblclick={() => beginRename(track.id)}
            >{track.name}</span>
          {/if}

          {#if track.kind === 'visual' && trackHasVideo(track)}
            <!--
              轨道静音（v15）：只关这条轨的内嵌音轨，画面照常。
              与左边的眼睛刻意分开 —— 「画面留着、声音不要」是审片时最常见的操作，
              用眼睛关会让整层消失，改完还得再点回来。
            -->
            <IconButton
              icon={track.muted ? 'volume-x' : 'volume-2'}
              label={track.muted ? tr('tl.unmuteTrack') : tr('tl.muteTrack')}
              size="sm"
              active={!track.muted}
              testid="track-muted"
              onclick={() => appState.store.toggleTrackMuted(track.id)}
            />
          {/if}

          <IconButton
            icon="ellipsis-vertical"
            label={tr('tl.trackMenu')}
            size="sm"
            testid="track-menu"
            onclick={(e) => openRowMenu(e, track)}
          />
        </div>
      {/each}
    </div>

    <!--
      加轨按钮是**固定页脚**，不参与竖直滚动。它占掉的是本列的**视口**（28px），
      所以画布那列的内容末尾补了一条等高的空白带（`.footer-pad`）：
      两侧的**滚动量程**必须相等，互写 scrollTop 才成立。
      页脚若留在滚动区里，它会跟着内容滚走（滚到底才看得见加轨按钮）。
    -->
    <div class="side-add" style:height={`${ROW_HEIGHT}px`}>
      <span class="add-label">{tr('tl.addTrack')}</span>
      <button
        type="button"
        class="add-btn"
        data-testid="add-visual-track"
        onclick={() => appState.store.addTrack('visual')}
      >
        <Icon name="video" size={12} /> {tr('tl.addVisualTrack')}
      </button>
      <button
        type="button"
        class="add-btn"
        data-testid="add-audio-track"
        onclick={() => appState.store.addTrack('audio')}
      >
        <Icon name="audio-lines" size={12} /> {tr('tl.addAudioTrack')}
      </button>
    </div>
  </div>

  <div
    class="scroll"
    data-testid="tl-scroll"
    bind:this={scrollEl}
    onwheel={wheel}
    onscroll={() => {
      syncVertical(scrollEl, sideEl);
      paint(false);
    }}
  >
    <div class="canvas-wrap" data-testid="tl-canvas-wrap" style:width={`${drawWidth}px`}>
      <!--
        段落带 + 标尺一起 sticky：两者必须同时吸顶，否则纵向滚动时段落带会
        跟着内容滚走、而标尺还停在上面（看起来像「段落消失了」）。
      -->
      <div class="ruler-wrap" style:height={`${RULER_HEIGHT + SECTION_BAND_HEIGHT}px`}>
        <div
          class="section-band"
          data-testid="tl-section-band"
          data-hint="ruler"
          style:height={`${SECTION_BAND_HEIGHT}px`}
          role="presentation"
          oncontextmenu={openSectionCtx}
        >
          {#each sectionChips as s (s.id)}
            <!--
              段落色块 = 从本段起点铺到下一段起点。允许重叠（数据层不禁止），
              后画的盖住先画的 —— 与「谁的 start 更小谁在前」是同一件事实。
            -->
            <div
              class="section-chip"
              data-testid="tl-section"
              data-section-id={s.id}
              title={s.name}
              style:left={`${s.left}px`}
              style:width={`${s.width}px`}
              style:--section-color={s.color ?? 'var(--accent)'}
              role="presentation"
              onpointerdown={(e) => sectionDown(e, s)}
              ondblclick={() => beginSectionRename(s)}
            >
              <span class="section-name">{s.name}</span>
            </div>
          {/each}
          <!--
            手动节奏点的刻度：段落色块之上、只占 1px、不吃指针事件 ——
            段落仍要能拖 / 双击改名。位置与主时间轴虚线同一套换算（`xOfTime`）。
          -->
          {#each beatMarks as m (m)}
            <span
              class="beat-mark"
              data-testid="tl-beat-mark"
              style:left={`${xOfTime(m, appState.pxPerBeat, grid)}px`}
            ></span>
          {/each}
          {#if sectionRenaming}
            <!-- svelte-ignore a11y_autofocus -->
            <input
              class="section-rename"
              data-testid="section-rename-input"
              style:left={`${sectionRenaming.left}px`}
              style:width={`${Math.max(88, sectionRenaming.width)}px`}
              value={sectionRenaming.value}
              aria-label={tr('tl.sectionName')}
              autofocus
              onpointerdown={(e) => e.stopPropagation()}
              onblur={(e) => commitSectionRename(e.currentTarget.value)}
              onkeydown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault();
                  commitSectionRename(e.currentTarget.value);
                } else if (e.key === 'Escape') {
                  e.preventDefault();
                  sectionRenaming = null;
                }
              }}
            />
          {/if}
        </div>
        <canvas class="ruler" data-hint="ruler" bind:this={rulerCanvas} onpointerdown={scrub}></canvas>
      </div>
      <div
        class="rows"
        data-hint="rows"
        role="presentation"
        bind:this={rowsEl}
        onpointerdown={onRowsPointerDown}
        ondragover={onRowsDragOver}
        ondragleave={onRowsDragLeave}
        ondrop={onRowsDrop}
      >
        <canvas class="grid" bind:this={gridCanvas}></canvas>
        <!--
          拖拽落点：目标行加一层底色 + 一条竖线。
          竖线落在**吸附后**的时刻上 —— 看见的就是会落下的位置。
          （整块行区不加描边：`.rows` 与工程一样宽，右边界在屏幕外，那种「回执」
          用户根本看不到；逐行染色才落在眼睛够得着的地方。）
        -->
        {#if dropHint}
          <div
            class="drop-line"
            data-testid="tl-drop-line"
            style:left={`${dropHint.x}px`}
            style:top={`${dropHint.top}px`}
            style:height={`${ROW_HEIGHT}px`}
          ></div>
        {/if}
        {#each tracks as track (track.id)}
          <div
            class="row"
            class:audio={track.kind === 'audio'}
            class:disabled={!track.enabled}
            class:drop-target={dropHint?.trackId === track.id}
            style:height={`${ROW_HEIGHT}px`}
            data-track-id={track.id}
            data-tl-row
            data-testid="tl-row"
            role="presentation"
            oncontextmenu={(e) => openCtx(e, track)}
          >
            {#each track.clips as clip (clip.id)}
              <ClipView {track} {clip} />
            {/each}
            {#each transitionMarks.get(track.id) ?? [] as m (m.id)}
              <!--
                转场窗口涂层：跨在剪切点上，两侧各 d/2。
                点它选中出画片段（转场挂在它身上）。
              -->
              <div
                class="tl-transition"
                class:in={m.side === 'in'}
                class:out={m.side === 'out'}
                style:left={`${m.left}px`}
                style:width={`${m.width}px`}
                title={m.title}
                data-testid="transition-marker"
                data-side={m.side}
                role="presentation"
                onpointerdown={(e) => {
                  e.stopPropagation();
                  appState.selectedClipId = m.clipId;
                }}
              ></div>
            {/each}
          </div>
        {/each}
        {#if marqueeBox}
          <!--
            框选框。半透明是必须的（框住的内容要看得见）；`pointer-events: none`
            也是必须的 —— 否则框一出现就把指针下的片段盖住，拖框本身会卡住。
          -->
          <div
            class="marquee"
            data-testid="tl-marquee"
            style:left={`${marqueeBox.x}px`}
            style:top={`${marqueeBox.y}px`}
            style:width={`${marqueeBox.w}px`}
            style:height={`${marqueeBox.h}px`}
          ></div>
        {/if}
        <div class="playhead" style:left={`${playheadX}px`}></div>
      </div>
      <!--
        与轨道头列「添加轨道」页脚等高的空白带：页脚占掉那一列的 **28px 视口**，
        这里补 28px 的**内容**，两侧的最大滚动量才相等（见 `.side-add` 的注释）。
        少了它，滚到底时轨道头列总比画布多走一行 —— 表现就是「最后一条轨的名字
        被加轨按钮盖住」。纯空白，不接收指针事件。
      -->
      <div class="footer-pad" style:height={`${ROW_HEIGHT}px`} aria-hidden="true"></div>
    </div>
  </div>
</div>

{#if ctxMenu}
  <Menu
    items={ctxItems()}
    at={{ x: ctxMenu.x, y: ctxMenu.y }}
    head={{ label: ctxMenu.name, value: `${ctxMenu.time.toFixed(2)}s` }}
    testid="ctx-menu"
    onclose={closeMenus}
  />
{/if}

{#if rowMenu}
  {@const track = appState.store.track(rowMenu.trackId)}
  {#if track}
    <Menu
      items={trackMenuItems(track)}
      anchorEl={rowMenu.anchor}
      testid="track-menu-panel"
      onclose={closeMenus}
    />
  {/if}
{/if}

{#if sectionMenu}
  {@const hit = sectionMenu.id ? sections.find((s) => s.id === sectionMenu!.id) : undefined}
  <Menu
    items={sectionMenuItems()}
    at={{ x: sectionMenu.x, y: sectionMenu.y }}
    head={{ label: hit ? hit.name : tr('tl.addSection'), value: `${sectionMenu.time.toFixed(2)}s` }}
    testid="section-menu"
    onclose={() => (sectionMenu = null)}
  />
{/if}

<!--
  「全部特效…」/「全部算法片段…」的选择器。
  与检查器里那两个选择器是同一个组件 —— 从时间轴进来只是**建片段**，
  从检查器进来是给已有片段追加 / 更换。共用一份避免两套筛选与缩略图逻辑漂移。
-->
{#if pickTarget?.kind === 'effect'}
  <EffectPickerModal
    onclose={() => (pickTarget = null)}
    onapply={(ids) => {
      const target = pickTarget;
      pickTarget = null;
      if (target) addEffect(target.trackId, ids, target.at);
    }}
  />
{:else if pickTarget?.kind === 'algo'}
  <AlgoPickerModal
    current=""
    title={tr('tl.addAlgo')}
    applyLabel={tr('tl.insertAlgo')}
    onclose={() => (pickTarget = null)}
    onapply={(id) => {
      const target = pickTarget;
      pickTarget = null;
      if (target) addAlgo(target.trackId, id, target.at);
    }}
  />
{/if}

<style>
  .tl {
    height: 100%;
    display: flex;
    overflow: hidden;
  }
  /*
   * 轨道头列 = 外壳（定宽 + 右边框 + 纵向排布）+ 滚动区 + 固定页脚。
   * 拆这一层是为了让「滚动内容」只有表头 + 各行 —— 与画布那列严格等高。
   */
  .side-wrap {
    width: var(--tl-side-w);
    flex-shrink: 0;
    display: flex;
    flex-direction: column;
    min-height: 0;
    border-right: 1px solid var(--tl-border);
    background: var(--tl-side-bg);
  }
  .side {
    flex: 1;
    min-height: 0;
    overflow-y: auto;
    overflow-x: hidden;
    /* 竖直滚动条**只留画布那一条**（两者由 `syncVertical` 联动）。
       这里再挂一条就是用户报的「两条各滚各的」。 */
    scrollbar-width: none;
  }
  .side::-webkit-scrollbar {
    display: none;
  }
  .side-head {
    display: flex;
    align-items: center;
    padding: 0 var(--sp-4);
    border-bottom: 1px solid var(--tl-border);
    position: sticky;
    top: 0;
    background: var(--tl-side-bg);
    z-index: 1;
  }
  .side-title {
    color: var(--text-muted);
    font-size: var(--fs-xs);
    letter-spacing: 0.08em;
    text-transform: uppercase;
  }
  .side-row {
    display: flex;
    align-items: center;
    gap: var(--sp-1);
    padding: 0 var(--sp-2) 0 var(--sp-1);
    border-bottom: 1px solid var(--tl-gutter);
    /* 拖曳排序：不设过渡，否则跟随指针会拖尾。 */
    will-change: transform;
  }
  .side :global(.is-dragging) {
    background: var(--surface-hover);
  }
  .side :global(.is-reordering) {
    cursor: grabbing;
  }
  .side-row.muted .tname {
    color: var(--tl-name-muted);
  }
  .tname {
    flex: 1;
    min-width: 0;
    color: var(--tl-name);
    font-size: var(--fs-sm);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    cursor: text;
  }
  .rename {
    flex: 1;
    min-width: 0;
    height: 18px;
    padding: 0 var(--sp-1);
    font-size: var(--fs-sm);
  }

  .side-add {
    display: flex;
    align-items: center;
    gap: var(--sp-2);
    padding: 0 var(--sp-2) 0 var(--sp-3);
    border-bottom: 1px solid var(--tl-gutter);
    /* 固定页脚：不参与滚动。它占掉 28px 视口，画布那列用等高的 `.footer-pad`
       补在内容末尾 —— 两侧量程相等，`syncVertical` 才是 1:1（见模板里的注释）。 */
    flex-shrink: 0;
  }
  .add-label {
    color: var(--text-muted);
    font-size: var(--fs-xs);
    white-space: nowrap;
  }
  .add-btn {
    display: inline-flex;
    align-items: center;
    gap: 3px;
    height: 18px;
    padding: 0 var(--sp-2);
    background: transparent;
    border: 1px solid var(--tl-border);
    border-radius: var(--radius-sm);
    color: var(--tl-name);
    font-size: var(--fs-xs);
    cursor: pointer;
  }
  .add-btn:hover {
    border-color: var(--border-focus);
    color: var(--accent);
  }

  .scroll {
    flex: 1;
    overflow-x: auto;
    overflow-y: auto;
  }
  .canvas-wrap {
    position: relative;
  }
  /* 底部空白带：与轨道头列的「添加轨道」页脚等高，只负责把这一列的滚动量程
     撑到和对面一样（见模板注释）。不画任何东西，也不吃指针事件。 */
  .footer-pad {
    pointer-events: none;
  }
  /*
   * 段落带 + 标尺一起吸顶。**吸顶的是外层**：两层各自 sticky 会在纵向滚动时
   * 互相错开（带子跟着内容走、标尺留在上面）。
   */
  .ruler-wrap {
    position: sticky;
    top: 0;
    z-index: var(--z-ruler);
  }
  .section-band {
    position: relative;
    /*
     * 底色走 `--tl-side-bg`（行标题槽那档），**不能**用 `--tl-gutter`：后者映射到
     * `border`，在常规三套里恰好是一层很淡的灰、看着像底色，但它同时是**分隔线**
     * 的颜色 —— 高对比度下 `border` 是纯白，拿它填底就成了白底白字的段落名。
     */
    background: var(--tl-side-bg);
    border-bottom: 1px solid var(--tl-border);
    overflow: hidden;
  }
  .section-chip {
    position: absolute;
    top: 1px;
    bottom: 1px;
    display: flex;
    align-items: center;
    padding: 0 3px;
    background: color-mix(in srgb, var(--section-color) 26%, transparent);
    border-left: 2px solid var(--section-color);
    color: var(--text-secondary);
    font-size: 9px;
    line-height: 1;
    white-space: nowrap;
    overflow: hidden;
    cursor: grab;
    user-select: none;
  }
  .section-chip:active {
    cursor: grabbing;
  }
  .section-name {
    overflow: hidden;
    text-overflow: ellipsis;
    pointer-events: none;
  }
  .section-rename {
    position: absolute;
    top: 0;
    height: calc(100% - 1px);
    padding: 0 2px;
    font-size: 9px;
    background: var(--surface-1);
    border: 1px solid var(--accent);
    border-radius: 2px;
    color: var(--text-primary);
  }
  /* 段落带上的节奏点刻度：只负责「这里有一个点」，点击归下面的段落色块。 */
  .beat-mark {
    position: absolute;
    top: 0;
    bottom: 0;
    width: 1px;
    margin-left: -0.5px;
    background: var(--accent);
    opacity: 0.85;
    pointer-events: none;
  }
  .ruler {
    display: block;
    cursor: ew-resize;
  }
  .rows {
    position: relative;
    /* 框选是在这块上拖出来的：不加的话拖动会顺手把行里的文字选中 */
    user-select: none;
  }
  /*
   * 框选框。与排版编辑器的同款：半透明填充 + 主题色描边 ——
   * 用 color-mix 而不是 --accent-weak，后者是**不透明**的色阶值。
   * z 与选中片段的描边同层：DOM 里排在片段之后，所以盖在它们上面。
   */
  .marquee {
    position: absolute;
    z-index: var(--z-clip-selected);
    border: 1px solid var(--accent);
    background: color-mix(in srgb, var(--accent) 16%, transparent);
    pointer-events: none;
  }
  .grid {
    position: absolute;
    left: 0;
    top: 0;
    pointer-events: none;
  }
  /* 拖拽落点所在的行：底色（半透明主题色，与框选框同一套写法） */
  .row.drop-target {
    background: color-mix(in srgb, var(--accent) 10%, transparent);
  }
  .drop-line {
    position: absolute;
    width: 2px;
    margin-left: -1px;
    background: var(--accent);
    pointer-events: none;
    /* 与选中片段的描边同层（时间轴内部 z 预算 ≤5，见 tokens） */
    z-index: var(--z-clip-selected);
  }
  .row {
    position: relative;
  }
  .row.disabled {
    opacity: 0.5;
  }
  .playhead {
    position: absolute;
    top: 0;
    bottom: 0;
    width: 0;
    border-left: 1.5px solid var(--accent);
    pointer-events: none;
    z-index: var(--z-playhead);
  }

  /*
   * 转场窗口涂层：斜纹是「这里两段画面在同时存在」的通用视觉语言。
   * 用 currentColor 之外的 token（--warning）是因为它表达的是**操作语义**
   * （这块区域的行为被改写了），不是某一类数据。
   */
  .tl-transition {
    position: absolute;
    top: 3px;
    bottom: 3px;
    border-radius: var(--radius-sm);
    border: 1px solid var(--warning);
    background: repeating-linear-gradient(
      45deg,
      color-mix(in srgb, var(--warning) 55%, transparent) 0 3px,
      transparent 3px 7px
    );
    cursor: pointer;
    z-index: var(--z-edge);
  }
  .tl-transition:hover {
    background: color-mix(in srgb, var(--warning) 35%, transparent);
  }
</style>
