<script lang="ts">
  import { onMount } from 'svelte';
  import TopBar from './TopBar.svelte';
  import Rail from './Rail.svelte';
  import Transport from './Transport.svelte';
  import Preview from './Preview.svelte';
  import MediaPoolDrawer from './MediaPoolDrawer.svelte';
  import ModulatorDrawer from './modulator/ModulatorDrawer.svelte';
  import ModulatorEditor from './modulator/ModulatorEditor.svelte';
  import AgentDrawer from './agent/AgentDrawer.svelte';
  import AgentSettingsModal from './agent/AgentSettingsModal.svelte';
  import AgentHistoryModal from './agent/AgentHistoryModal.svelte';
  import { agentState } from './agent/agent-state.svelte';
  import StatusBar from './StatusBar.svelte';
  import Tip from './Tip.svelte';
  import EmptyState from './EmptyState.svelte';
  import PluginMissingBanner from './PluginMissingBanner.svelte';
  import RestoreTabsBanner from './RestoreTabsBanner.svelte';
  import IconButton from './controls/IconButton.svelte';
  import Timeline from '../timeline/Timeline.svelte';
  import TypographyEditor from './typography/TypographyEditor.svelte';
  import GradeRail from './grade/GradeRail.svelte';
  import GradePanels from './grade/GradePanels.svelte';
  import GradeDock from './grade/GradeDock.svelte';
  import GradeInfo from './grade/GradeInfo.svelte';
  import Scrubber from './Scrubber.svelte';
  import ParticleEditor from './particles/ParticleEditor.svelte';
  import { hasFullscreenEditor } from './clip-editor';
  import { gradePanels } from './grade/grade-panels.svelte';
  import Mascot from './mascot/Mascot.svelte';
  import PasteAssetsModal from './PasteAssetsModal.svelte';
  import CurveEditor from './curve-editor/CurveEditor.svelte';
  import DockStack from './plugins/DockStack.svelte';
  import PluginPanelLayer from './plugins/PluginPanelLayer.svelte';
  import { hasOpenDock } from './plugins/plugin-panels';
  import {
    curveEditorTargets,
    openCurveEditor,
  } from './curve-editor/curve-editor-state.svelte';
  import { handleTypographyKey, handleTypingFormatKey } from './typography/keys';
  import { appState } from './app-state.svelte';
  import { theme } from './theme.svelte';
  import { installTheme, applyFontScale, applyMotion } from './theme-apply';
  import { syncTitleBarOverlay } from './titlebar';
  import { activeElementOwnsSpace, isExempt } from './focus';
  import { saveProjectAs, saveProjectNow } from './project-actions';
  import { isSplitKey } from './shortcuts';
  import { parseClipboard } from '../core/clipboard';
  import { clipboardAssets, type ClipboardAsset } from './clipboard-assets';
  import { addAssetsToPool, pasteAssetsIntoTypography, placeAssetsAtPlayhead } from './paste-assets';
  import { tr } from '../i18n/index.svelte';

  /**
   * 剪贴板里有素材、等着选落点的那一批（时间轴视图）。
   * 走 paste 事件而不是 Ctrl+V 的 keydown：`clipboardData` 只在事件派发期间
   * 可读（同步、零权限），而 keydown 里只能去够 navigator.clipboard（要授权）。
   */
  let pendingPaste = $state<ClipboardAsset[] | null>(null);

  function resolvePaste(target: 'timeline' | 'pool'): void {
    const assets = pendingPaste;
    pendingPaste = null;
    if (!assets) return;
    if (target === 'timeline') void placeAssetsAtPlayhead(assets);
    else void addAssetsToPool(assets);
  }

  /**
   * 主题的唯一写入口。main.ts 在 mount 前已经装过一次（防首帧闪默认值），
   * 这里负责**后续变更**：runtime 改 mode/accent/fontScale 后重新注入 :root。
   * 用 $effect 而不是 store 订阅，因为它天然读到哪些 rune 就订阅哪些。
   */
  $effect(() => {
    installTheme(theme.spec);
    applyFontScale(theme.fontScale);
    applyMotion(theme.motionEnabled, theme.motionSpeed);
    // 桌面壳：窗口按钮由主进程画，读不到上面的 CSS 变量 —— 得把新配色推过去。
    // 顺序有关系：它读的是 installTheme 刚写下的 token。
    syncTitleBarOverlay();
  });

  // 切工程 = 新会话：否则 A 的聊天会被记进 B 的历史（见 agentState.onProjectChanged）。
  $effect(() => {
    void appState.activeProjectId;
    agentState.onProjectChanged();
  });

  /* ------------------------------------------------ 面板调校（拖拽热区）
   *
   * 两个入口：工具条下缘的一条横带（只调轨道区高度）、轨道区与抽屉夹角的
   * 两个方块（一次手势同时调高度与对应列的宽度）。都走 appState 的 setter
   * —— 钳制与持久化各只有一处实现。指针捕获的形态照抄
   * `DockStack.startResize`（那是同一件事的既有做法）。
   */
  let resizingH = $state(false);

  function startHeightResize(e: PointerEvent): void {
    if (e.button !== 0) return;
    e.preventDefault();
    resizingH = true;
    const startY = e.clientY;
    const startH = appState.timelineHeight;
    const el = e.currentTarget as HTMLElement;
    el.setPointerCapture(e.pointerId);

    const mv = (ev: PointerEvent): void => {
      /*
       * **边界跟随光标**：热区贴在轨道区的**上沿**，往下拖 = 上沿下移 =
       * 轨道区变矮。写反了的形态是「拖动手感是反的」—— 不报错，但用一次就知道
       * 不对劲。夹角的那个热区在下沿，方向与之相反（那边是 +deltaY）。
       */
      appState.setTimelineHeight(startH - (ev.clientY - startY));
    };
    const up = (ev: PointerEvent): void => {
      el.removeEventListener('pointermove', mv);
      el.removeEventListener('pointerup', up);
      el.removeEventListener('pointercancel', up);
      if (el.hasPointerCapture(ev.pointerId)) el.releasePointerCapture(ev.pointerId);
      resizingH = false;
    };
    el.addEventListener('pointermove', mv);
    el.addEventListener('pointerup', up);
    el.addEventListener('pointercancel', up);
  }

  /**
   * 调色码头（右栏）的宽度。
   *
   * 复用 `drawerWidth`：同一列、同样的量纲、同样的持久化 —— 用户在时间轴里
   * 把检查器拖到 320px，进调色页时码头也是 320px，不会突然换一个宽度。
   */
  function startDockResize(e: PointerEvent): void {
    if (e.button !== 0) return;
    e.preventDefault();
    const startX = e.clientX;
    const startW = appState.drawerWidth;
    const el = e.currentTarget as HTMLElement;
    el.setPointerCapture(e.pointerId);
    const mv = (ev: PointerEvent): void => {
      appState.setDrawerWidth(startW - (ev.clientX - startX));
    };
    const up = (ev: PointerEvent): void => {
      el.removeEventListener('pointermove', mv);
      el.removeEventListener('pointerup', up);
      el.removeEventListener('pointercancel', up);
      if (el.hasPointerCapture(ev.pointerId)) el.releasePointerCapture(ev.pointerId);
    };
    el.addEventListener('pointermove', mv);
    el.addEventListener('pointerup', up);
    el.addEventListener('pointercancel', up);
  }

  /** 夹角热区：`side` 是「这一次连哪个抽屉的宽度一起调」。 */
  function startCornerResize(e: PointerEvent, side: 'pool' | 'drawer'): void {
    if (e.button !== 0) return;
    e.preventDefault();
    const startX = e.clientX;
    const startY = e.clientY;
    const startH = appState.timelineHeight;
    const startW = side === 'pool' ? appState.mediaPoolWidth : appState.drawerWidth;
    const el = e.currentTarget as HTMLElement;
    el.setPointerCapture(e.pointerId);

    const mv = (ev: PointerEvent): void => {
      // 夹角热区贴在轨道区**下沿**（与抽屉的夹角处）：往上拖 = 变矮，
      // 与工具条下缘那条热区正好相反（那条是上沿，边界跟随光标）。
      appState.setTimelineHeight(startH + (ev.clientY - startY));
      const dx = ev.clientX - startX;
      // 媒体池在左：往右拖变宽；检查器在右：往左拖变宽（与各自独立的热区同向）。
      if (side === 'pool') appState.setMediaPoolWidth(startW + dx);
      else appState.setDrawerWidth(startW - dx);
    };
    const up = (ev: PointerEvent): void => {
      el.removeEventListener('pointermove', mv);
      el.removeEventListener('pointerup', up);
      el.removeEventListener('pointercancel', up);
      if (el.hasPointerCapture(ev.pointerId)) el.releasePointerCapture(ev.pointerId);
    };
    el.addEventListener('pointermove', mv);
    el.addEventListener('pointerup', up);
    el.addEventListener('pointercancel', up);
  }

  onMount(() => {
    const onKey = (e: KeyboardEvent): void => {
      /*
       * **编辑文本时也要能用的**快捷键必须在豁免检查之前拦。
       *
       * contenteditable 命中了 `isExempt`（打字当然不能被全局键吃掉），
       * 但 Ctrl+B/I/U 是「正在打字时才最想按的」那三个键 —— 放在豁免之后
       * 等于它们只在没编辑时可用，正好把用处反过来了。
       */
      if (appState.editorOpen && handleTypingFormatKey(e)) return;

      // 控件自己处理键盘的（自研控件带 data-exempt）一律让路，
      // 否则在下拉上按 Space 会「打开下拉 + 开始播放」同时发生。
      if (isExempt(e.target)) return;

      /*
       * modal 是模态：里面的快捷键（预剪辑的 I/O/空格）由它自己的 window 监听器
       * 处理，全局这一份必须整段让路。两个监听器都在 window 上，靠
       * `preventDefault()` 是拦不住的（它不阻止同一 target 上的其它监听器）。
       */
      if (appState.modalDepth > 0) return;

      /*
       * Esc = 退出调色页（与侧栏底部的返回键同一个动作）。
       *
       * 放在 `isExempt` **之后**：数字框里按 Esc 是「放弃这次输入」，
       * 下拉/菜单打开时 Esc 是「关掉它」—— 那些归控件自己。这一页没有
       * 右上角的 ×，所以除了侧栏那一个按钮，这里是第二个出口。
       */
      if (appState.gradeOpen && e.key === 'Escape') {
        e.preventDefault();
        appState.closeGradeEditor();
        return;
      }
      // 粒子页同调色页：Esc 回时间轴。两个全屏子系统用同一手势退出。
      if (appState.particlesOpen && e.key === 'Escape') {
        e.preventDefault();
        appState.closeParticleEditor();
        return;
      }

      // —— 覆盖浏览器原生快捷键 ——
      // 这几组在浏览器里有默认行为（保存网页 / 打印 / 查找 / 前进后退），
      // 在一个浏览器内应用里它们全是误触。刻意**不**拦 Ctrl+滚轮（浏览器缩放）
      // 与 F5 / Ctrl+R / Ctrl+Shift+I：那是无障碍与开发的逃生舱，拦了只有坏处。
      if (e.ctrlKey && !e.shiftKey && !e.altKey) {
        const k = e.key.toLowerCase();
        if (k === 's') {
          e.preventDefault();
          // 位置未知时 saveProjectNow 会自己转成「另存为」——
          // 第一次保存本来就要问路径，没必要分成两个快捷键。
          void saveProjectNow();
          return;
        }
        if (k === 'p' || k === 'f') {
          e.preventDefault();
          return;
        }
      }
      if (e.ctrlKey && e.shiftKey && !e.altKey && e.key.toLowerCase() === 's') {
        e.preventDefault();
        void saveProjectAs();
        return;
      }
      if (e.altKey && (e.key === 'ArrowLeft' || e.key === 'ArrowRight')) {
        e.preventDefault();
        return;
      }

      /*
       * 排版编辑页的快捷键**分流**在这里，而不是在下面每条分支上加
       * `if (!editorOpen)`。分流之后：S（切分）与 Alt+↑↓（移轨）在排版页
       * 自然失效 —— 它们在那边没有意义，而「不处理」正是想要的语义。
       */
      if (appState.editorOpen) {
        handleTypographyKey(e);
        return;
      }

      /*
       * 调色页 / 粒子页：只留「看片」与「历史」两类键 —— 空格播放、Ctrl+Z/Y 撤销。
       * 切分（S）、删除、Alt+↑↓ 移轨在这两页没有对应物，留着只会让一次误触
       * 悄悄改掉时间轴（而画面上什么都不会变，因为这两页根本不显示时间轴）。
       */
      if (appState.gradeOpen || appState.particlesOpen) {
        if (e.code === 'Space' && !activeElementOwnsSpace()) {
          e.preventDefault();
          appState.togglePlay();
          return;
        }
        if (e.ctrlKey && !e.shiftKey && e.key.toLowerCase() === 'z') {
          e.preventDefault();
          appState.store.undo();
          return;
        }
        if ((e.ctrlKey && e.key.toLowerCase() === 'y') || (e.ctrlKey && e.shiftKey && e.key.toLowerCase() === 'z')) {
          e.preventDefault();
          appState.store.redo();
        }
        return;
      }

      /*
       * K = 打开关键帧曲线编辑器（选中片段后）。
       *
       * 单键的理由与 S（切分）相同：它是时间轴视图里的高频动作，而 Ctrl+K 在
       * 其他方案里已经被「切分」占了（见 shortcuts.ts 的方案表）。`isExempt`
       * 已经挡掉了输入框与自研控件，所以只有真正的「没在打字」才会命中。
       */
      if (!e.ctrlKey && !e.altKey && !e.metaKey && e.key.toLowerCase() === 'k' && appState.selectedClipId) {
        e.preventDefault();
        openCurveEditor(appState.selectedClipId);
        return;
      }

      /*
       * Ctrl+C / Ctrl+X / Ctrl+V：**时间轴视图专用**。
       *
       * 刻意放在 `editorOpen` 分流**之后**：排版编辑页有自己的 keys.ts
       * （元素级复制/剪切/粘贴），放在分流前面会让那边整个失灵。
       *
       * V 的兜底分支只在「上次复制写不进去系统剪贴板」时拦截 —— 写得进去时
       * 走 `onPaste` 的系统剪贴板通道（那里读的是最新内容，包括从别的窗口
       * 复制进来的片段 JSON）。
       */
      if (e.ctrlKey && !e.shiftKey && !e.altKey) {
        const k = e.key.toLowerCase();
        if (k === 'c' && appState.selectedClipIds.length) {
          e.preventDefault();
          appState.copySelectedClips();
          return;
        }
        if (k === 'x' && appState.selectedClipIds.length) {
          e.preventDefault();
          appState.cutSelectedClips();
          return;
        }
        if (k === 'v' && appState.clipClipboardFallbackActive()) {
          e.preventDefault();
          appState.pasteClipsFromClipboard();
          return;
        }
      }

      /*
       * F2 = 给选中的片段就地改名（双击片段名是同一个入口）。
       * 放在时间轴这一侧：排版页有自己的 keys.ts 分流，那边没有「片段」这个概念。
       */
      if (e.key === 'F2' && appState.selectedClipId) {
        e.preventDefault();
        appState.beginClipRename(appState.selectedClipId);
        return;
      }

      /*
       * 切分键的方案别名（「操作习惯」）。默认方案下 `isSplitKey` 恒返回 false，
       * 走下面那条 `e.key === 's'` 的分支 —— 两处都判会让同一次击键切两刀。
       */
      if (appState.selectedClipId && isSplitKey(e, appState.shortcutScheme)) {
        e.preventDefault();
        const f = appState.store.findClip(appState.selectedClipId);
        if (f) appState.store.splitClipAt(f.track.id, f.clip.id, appState.playT);
        return;
      }

      if (e.code === 'Space') {
        // 聚焦在按钮/role 控件上时 Space 归它们——否则会「激活按钮 + 播放」双触发
        if (activeElementOwnsSpace()) return;
        e.preventDefault();
        appState.togglePlay();
      } else if (e.altKey && (e.key === 'ArrowUp' || e.key === 'ArrowDown') && appState.selectedClipId) {
        // alt-up / alt-down：抬一轨 / 降一轨（剪辑软件的通用手势）
        e.preventDefault();
        const r = appState.store.shiftClipTrack(appState.selectedClipId, e.key === 'ArrowUp' ? -1 : 1);
        if (r === 'no-track') appState.flash(tr('app.noTrackFits'));
        else if (r === 'blocked') appState.flash(tr('app.targetOccupied'));
      } else if ((e.key === 'Delete' || e.key === 'Backspace') && appState.selectedClipIds.length) {
        // 框选之后一次删干净：走**一笔撤销**（逐个 removeClip 会让 Ctrl+Z
        // 只回来一个，看起来像撤销坏了）
        appState.removeSelectedClips();
      } else if (e.ctrlKey && !e.shiftKey && e.key === 'z') {
        e.preventDefault();
        appState.store.undo();
      } else if ((e.ctrlKey && e.key === 'y') || (e.ctrlKey && e.shiftKey && (e.key === 'Z' || e.key === 'z'))) {
        e.preventDefault();
        appState.store.redo();
      } else if (e.key === 's' && appState.selectedClipId) {
        const f = appState.store.findClip(appState.selectedClipId);
        if (f) appState.store.splitClipAt(f.track.id, f.clip.id, appState.playT);
      }
    };

    /**
     * 粘贴素材 / 片段。
     *
     * **片段 JSON 优先**（自有格式，命中才接管）：剪贴板里不可能同时是
     * 片段 JSON 又是可识别的素材文件，两条路互斥。没命中必须整段放行 ——
     * 粘贴一段文字要原样走浏览器默认行为，否则输入类控件的粘贴会整个失灵。
     * `isExempt` 放最前面 —— 输入框与自研控件（data-exempt）的粘贴归它们自己；
     * 文本编辑区的粘贴守卫也会 `preventDefault`，由 defaultPrevented 让路。
     *
     * 时间轴视图弹 modal 问落点；排版视图按类型直接落地（图片进画布、
     * 视频 / 音频进媒体池）—— 在那边这是唯一合理的解释，不值得再问一次。
     */
    const onPaste = (e: ClipboardEvent): void => {
      if (e.defaultPrevented) return;
      if (isExempt(e.target)) return;
      // 没有工程时整段放行：素材仓属于「当前工程」，粘进 placeholder 等于无声丢弃。
      if (!appState.hasProject) return;
      // 片段 JSON：只认文本通道里那份（系统剪贴板）。排版页不接 —— 那边有
      // 自己的元素剪贴板，粘时间轴片段进去没有意义。
      if (!appState.editorOpen) {
        const payload = parseClipboard(e.clipboardData?.getData('text/plain') ?? '');
        if (payload) {
          e.preventDefault();
          appState.pasteClipsFromClipboard(payload);
          return;
        }
      }
      const assets = clipboardAssets(Array.from(e.clipboardData?.items ?? []));
      if (!assets.length) return;
      e.preventDefault();
      if (appState.editorOpen) {
        void pasteAssetsIntoTypography(assets);
        return;
      }
      // 已经在问一次了：第二次粘贴既不覆盖上一个询问、也不弹第二个框。
      if (!pendingPaste) pendingPaste = assets;
    };

    /**
     * 原生右键菜单全应用禁用（轨道区与菜单都用自绘 div 菜单）。
     * 文本类输入例外：那里的复制/粘贴/拼写检查是系统能力，禁掉只会让人难受。
     */
    const onContextMenu = (e: MouseEvent): void => {
      if (isExempt(e.target)) return;
      e.preventDefault();
    };

    /**
     * 关页面 / F5 / 关标签时的保护。
     *
     * 弹的是**浏览器自己的**确认框（文案我们控制不了，也不该控制 ——
     * 伪造一个页面内的对话框会撒谎，因为它挡不住真正的离开）。我们能决定的
     * 只有「有没有这个框」，而这正是需要的：F5 一下全部烟消云散是最糟的形态。
     *
     * 判据是 `anyDirty` 而不是当前那份 —— 关页面会把**所有**打开的工程一起丢掉。
     */
    const onBeforeUnload = (e: BeforeUnloadEvent): void => {
      if (!appState.anyDirty) return;
      e.preventDefault();
      // 老浏览器看 returnValue 的内容；现代浏览器只看「有没有赋值」，
      // 赋值本身才是触发条件（赋任何非空串都一样）。
      e.returnValue = '';
    };

    window.addEventListener('keydown', onKey);
    window.addEventListener('paste', onPaste);
    window.addEventListener('contextmenu', onContextMenu);
    window.addEventListener('beforeunload', onBeforeUnload);
    return () => {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('paste', onPaste);
      window.removeEventListener('contextmenu', onContextMenu);
      window.removeEventListener('beforeunload', onBeforeUnload);
    };
  });

  /**
   * 调色页的目标片段。片段被删后调色页自动退出（`open` 依赖它与视图两个条件），
   * 不需要在别处维护「关页面」。
   */
  const gradeClip = $derived.by(() => {
    void appState.version;
    const id = appState.gradeClipId;
    if (!id) return null;
    const found = appState.store.findClip(id);
    return found && found.clip.kind === 'effect' ? found.clip : null;
  });
  /** 真的在调色页：视图指向它，且片段还在。 */
  const gradeOpen = $derived(appState.gradeOpen && gradeClip !== null);

  /** 粒子页的目标片段。片段被删 / 换了生成器之后页面自动退出。 */
  const particleClip = $derived.by(() => {
    void appState.version;
    const id = appState.particlesClipId;
    if (!id) return null;
    const found = appState.store.findClip(id);
    if (!found || found.clip.kind !== 'source' || found.clip.source.type !== 'algo') return null;
    /*
     * 与双击分派同一份判据：生成器被换成**没有**全屏页的那个（比如流体）时
     * 页面一起退出。不判的话 `view` 还停在粒子页 —— 顶栏 tab 亮着 sparkles，
     * 中列却是一堆与它无关的控件（预设 / 发射器形状 / 素材精灵）。
     */
    return hasFullscreenEditor(found.clip.source.generator) ? found.clip : null;
  });
  const particlesOpen = $derived(appState.particlesOpen && particleClip !== null);

  /**
   * 右列（检查器 + 右侧插件分节共用一条）要不要在场。
   *
   * 检查器关掉但还有插件分节时，这一列仍然要在 —— 那正是「共用容器」的意义：
   * 不开检查器也能用插件面板，不必为了看一块插件而先开检查器。
   */
  const dockRightOpen = $derived(appState.drawerOpen || hasOpenDock('right'));

  /** 左侧有没有开着的插件分节（决定左列在不在）。宽度与原生面板同源。 */
  const dockLeftOpen = $derived(hasOpenDock('left'));

  /*
   * 片段在调色页里被删掉（或撤销成非特效）时，视图必须一起退回时间轴。
   * 不收的话 `view` 还停在 `grade`：界面长得像时间轴，而快捷键仍被调色页
   * 那一支接管（S / Del 全失效），顶栏 tab 上的色轮图标也还亮着。
   */
  $effect(() => {
    if (appState.gradeOpen && gradeClip === null) appState.closeGradeEditor();
    if (appState.particlesOpen && particleClip === null) appState.closeParticleEditor();
  });
</script>

<!--
  `inert` + 空界面覆盖层：没有工程时，主界面**留在 DOM 里**（Studio 的 canvas
  不能卸载，否则 WebGL 上下文永久失效），但那一页对焦点与指针都失效，
  视觉上被 EmptyState 完全盖住。见 app-state.svelte.ts 的 `placeholder`。

  `inert` 只加在 `.page` 上，**不是整条 shell**：顶栏 / 窄侧栏 / 底栏里有一批
  与「当前有没有工程」无关的动作（外观、快捷键、设置、试炼场、明暗），
  首页上它们必须能点 —— 整棵树封死时，用户连换个主题都得先建一份工程。
  工程级的入口（保存 / 媒体池 / 插件 / 导出 / Agent）改由各自的 `disabled` 拦住。
-->
<div class="shell">
  <TopBar />

  <div class="content">
    <!--
      窄侧栏在页面**外面**：切到排版页时它必须还在（工程级动作、设置、明暗
      切换都不该随页面消失）。所以页面级的切换发生在它右边那一格里。
    -->
    <Rail />

    <div class="page" inert={!appState.hasProject}>
      <!--
        主界面**永不卸载**，切到排版页只是 display:none。
        卸载 Preview 的 <canvas> 会丢掉 WebGL 上下文 —— kit 里所有 Program /
        Target / 纹理随之失效，renderer 永久坏掉，而且不是重新 mount 能恢复的。
        代价是排版页打开时它还在 DOM 里，由 appState.tick() 的闸门挡住渲染。
      -->
      <div
        class="body"
        class:is-hidden={appState.editorOpen}
        class:is-grade={gradeOpen}
        class:is-particles={particlesOpen}
        style={`--pool-w: ${!gradeOpen && !particlesOpen && (appState.mediaPoolOpen || appState.agentOpen || appState.modulatorOpen || dockLeftOpen)
          ? `${appState.mediaPoolWidth}px`
          : '0px'}; --drawer-w: ${!gradeOpen && !particlesOpen && dockRightOpen
          ? `${appState.drawerWidth}px`
          : '0px'}; --grade-w: ${gradeOpen && gradePanels.dockOpen
          ? `${appState.drawerWidth}px`
          : '0px'}`}
      >
        <!--
          左列 = **一个容器**：媒体池 / Agent / 调制器（互斥，同一时刻只有一个）
          与 `side: 'left'` 的插件分节都住在这里，从上到下排。
          以前是两条独立轨道，视觉上是「插件一列 + 原生一列」—— 同一个容器不该
          有两条竖线，所以边框归这里画，里面谁都不画。

          ⚠️ `!editorOpen` 是必须的：排版编辑页也有自己的媒体池（同一个开关、
          同一个组件）。主界面切到排版页只是 `display:none`、**不卸载**，
          少了这个条件时两份抽屉会同时在 DOM 里 —— 两份列表、两份视频缩略图
          队列，`getByTestId('media-drawer')` 也会同时命中两个。
        -->
        {#if particlesOpen && appState.particlesClipId}
          <!--
            粒子全屏子系统：输出左列参数与右栏预设/状态两个 aside。
            **不渲染 Preview** —— 中列就是下面那块常驻的 `.stage`。
          -->
          <ParticleEditor clipId={appState.particlesClipId} />
        {:else if !gradeOpen && !appState.editorOpen && (appState.agentOpen || appState.modulatorOpen || appState.mediaPoolOpen || dockLeftOpen)}
          <div class="left-col">
            {#if appState.agentOpen}
              <AgentDrawer />
            {:else if appState.modulatorOpen}
              <ModulatorDrawer />
            {:else if appState.mediaPoolOpen}
              <MediaPoolDrawer />
            {/if}
            <!-- 插件分节排在原生面板下面：原生面板是这一列的主体，先看到它。 -->
            <DockStack side="left" />
          </div>
        {/if}

        <div class="stage" class:is-grade={gradeOpen} style:--tracks-h={`${appState.timelineHeight}px`}>
          <Preview />
          <!--
            缺失插件提示条：绝对定位浮在预览上方，**不参与网格** ——
            stage 的三行（预览 / 工具条 / 轨道区）是精心排过的，
            多一个流内子项会把轨道区顶出去。见组件自己的说明。
          -->
          <PluginMissingBanner />
          <RestoreTabsBanner />
          <div class="toolbar">
            <!--
              调色页与粒子页把「编辑时间轴」那一排控件换成进度条：拍网格 / 吸附 /
              时长 / 重叠 / 波纹 / 缩放在这两页没有一处用得上（时间轴是隐藏的），
              而它们会把进度条挤没。播放头是唯一还需要的东西（拖它看别的帧）。
            -->
            {#if gradeOpen}
              <Scrubber testid="grade-scrub" />
              <GradeInfo />
            {:else if particlesOpen}
              <Scrubber testid="particle-scrub" />
            {:else}
              <Transport />
              <span class="toolbar-tail">
                <IconButton
                  icon="panel-right"
                  label={tr('app.inspector')}
                  tipPlacement="top"
                  testid="drawer-open"
                  active={appState.drawerOpen}
                  onclick={() => appState.toggleDrawer()}
                />
              </span>
            {/if}
          </div>
          <!--
            高度热区：工具条与轨道区交界的一条 4px 横带（贴在轨道区上沿）。
            位置用 `--tracks-h` 算，不写死像素 —— 高度是可拖的。
          -->
          <div
            class="h-resize"
            class:active={resizingH}
            role="separator"
            aria-label={tr('app.resizeTimeline')}
            aria-orientation="horizontal"
            data-testid="tracks-resize"
            onpointerdown={startHeightResize}
          ></div>
          <!--
            夹角热区：轨道区与抽屉的交界。只在对应抽屉开着时出现
            （关着时没有第二件事可做，一个只能调高度的方块只会让人以为坏了）。
          -->
          {#if !gradeOpen && (appState.mediaPoolOpen || appState.agentOpen) && !appState.editorOpen}
            <div
              class="corner-resize left"
              role="separator"
              aria-label={tr('app.resizeTimelineCorner')}
              data-testid="tracks-corner-pool"
              onpointerdown={(e) => startCornerResize(e, 'pool')}
            ></div>
          {/if}
          {#if dockRightOpen && !gradeOpen}
            <div
              class="corner-resize right"
              role="separator"
              aria-label={tr('app.resizeTimelineCorner')}
              data-testid="tracks-corner-drawer"
              onpointerdown={(e) => startCornerResize(e, 'drawer')}
            ></div>
          {/if}
          <!--
            时间轴在调色页只是**隐藏**，不卸载：滚到哪、缩放到哪都是它的内部
            状态，卸载就丢。隐藏期间它自己会把尺寸量成 0，回时间轴时
            `refreshPreview` 会重排一次（与排版页同一条路径）。
          -->
          <div class="tracks" class:hidden={gradeOpen || particlesOpen}>
            <Timeline />
          </div>
          {#if gradeOpen}
            <div class="grade-rail-host">
              <GradeRail />
            </div>
            <div class="grade-panels" style:--grade-h={`${appState.timelineHeight}px`}>
              <GradePanels />
            </div>
          {/if}

          <!--
            彩蛋：看板娘（设置 → 外观）。挂在 `.stage` 里 ⇒ 她的右边界自动
            跟着检查器的宽度走（`.body` 的列是 1fr + --drawer-w）。绝对定位
            ⇒ 不参与 `.stage` 的网格，其余控件的几何与她在不在无关。
          -->
          {#if appState.mascotEnabled}
            <Mascot />
          {/if}
        </div>

        {#if gradeOpen && gradePanels.dockOpen}
          <GradeDock />
          <!-- 码头宽度的拖拽热区：贴在它的左沿，整条高度都是命中区。 -->
          <div
            class="dock-resize"
            role="separator"
            aria-label={tr('grade.resizeDock')}
            aria-orientation="vertical"
            data-testid="grade-dock-resize"
            onpointerdown={startDockResize}
          ></div>
        {/if}

        <!--
          右列 = **一个容器**：检查器与右侧 dock 面板是同一列里的两节（可折叠成
          标题栏），不再各占一条轨道。宽度走 `--drawer-w`（用户拖的那个），
          容器自己决定渲染不渲染（检查器关着但还有插件分节时它仍然在）。

          ⚠️ 它在 DOM 里排在最后：`grid-column` 是显式给的，本来不怕顺序，
          但顺序 + `grid-row: 1` 两道一起才挡住「自动排布换行」那个坑
          （见 `.body` 的注释）。
        -->
        <DockStack side="right" />
      </div>

      <!-- 排版编辑页：同格兄弟，同一时刻只有一个在流内。 -->
      {#if appState.editorOpen && appState.activeTypoClipId}
        <TypographyEditor clipId={appState.activeTypoClipId} />
      {/if}

      <!--
        Agent 设置放在**根级**（`.page` 里、抽屉外）：抽屉是带 z-index 的层叠
        上下文，modal 挂进去会被右侧检查器盖住遮罩（见 ui/AGENTS.md 的 z 刻度）。
        这里只渲染一个实例，时间轴与排版页共用；状态在 agentState 上。
      -->
      {#if agentState.settingsOpen}
        <AgentSettingsModal />
      {/if}
      {#if agentState.historyOpen}
        <AgentHistoryModal onclose={() => agentState.closeHistory()} />
      {/if}
    </div>
  </div>

  <StatusBar />
</div>

{#if !appState.hasProject}
  <EmptyState />
{/if}

<!--
  关键帧曲线编辑器：根级浮层（不在抽屉 / 时间轴里）。
  放在 shell 外面是为了不进任何祖先的层叠上下文 —— 与 modal 的理由相同；
  它自己只到 `--z-popover`，菜单与 tooltip 仍然盖得住它。
-->
{#if !appState.editorOpen}
  {#each curveEditorTargets() as t, i (t.clipId)}
    <CurveEditor target={t} layer={i} />
  {/each}
{/if}

<!--
  插件浮窗 / 模态面板：同样是根级浮层。
  不随排版页隐藏 —— 插件面板可能正是用来操作排版文档的；调色页同理。
  停靠面板不在这里（它们是 `.body` 右列里的分节，见 `<DockStack />`）。
-->
<PluginPanelLayer />

<!--
  调制器编辑器：同样是根级浮层。它自己是一个 Modal（会 portal 到 body），
  放在这里只是为了让「谁在编辑哪个调制器」这件事只由一份状态决定。
-->
{#if appState.modulatorEditId}
  <ModulatorEditor id={appState.modulatorEditId} onclose={() => appState.closeModulatorEditor()} />
{/if}

<!--
  粘贴素材的落点询问。挂在 shell **外面**：这里是根层叠上下文，
  modal 不会被任何祖先的 z-index / 层叠上下文困住（见 tokens.ts 的 z-modal）。
-->
{#if pendingPaste}
  <PasteAssetsModal
    assets={pendingPaste}
    onplace={() => resolvePaste('timeline')}
    onpool={() => resolvePaste('pool')}
    oncancel={() => (pendingPaste = null)}
  />
{/if}

<Tip />

<style>
  .shell {
    height: 100%;
    display: grid;
    grid-template-rows: var(--topbar-h) minmax(0, 1fr) var(--statusbar-h);
    background: var(--surface-0);
  }
  /*
   * .content：左侧窄侧栏（常驻）+ 右侧「页面」列。切页面时侧栏不消失。
   * 必须显式约束列：隐式列默认是 auto，会被子项的最小内容宽度撑开
   * —— 与 .stage 那条教训同源（AGENTS §7 坑 3）。同一时刻只有一个子项在流内。
   */
  .content {
    display: grid;
    grid-template-columns: var(--rail-w) minmax(0, 1fr);
    grid-template-rows: minmax(0, 1fr);
    min-height: 0;
    min-width: 0;
  }
  /* 页面宿主：同一时刻只有一个子项在流内（时间轴主界面 或 排版编辑页）。 */
  .page {
    display: grid;
    grid-template-columns: minmax(0, 1fr);
    grid-template-rows: minmax(0, 1fr);
    min-height: 0;
    min-width: 0;
  }
  .page > :global(*) {
    min-height: 0;
    min-width: 0;
  }
  /*
   * 三列：左列（原生面板 + 插件分节共用一个容器）| 舞台 | 右列（检查器 + 插件分节）。
   * 两个宽度都是实例值（用户可拖 / 有内容才占位），关掉时是 0 —— 列还在，
   * 只是没有宽度。
   *
   * ⚠️ **行必须显式给，且每个直接子项都要落到第 1 行。** 只写 `grid-column`
   * 是不够的：自动排布按「列游标只往前走」，DOM 里排在后面的子项若声明了更小的
   * 列号，会被推进**下一行**（隐式多出一条行）—— 症状是「某块面板突然变成半高、
   * 掉到舞台下面」，任何断言都不报错。粒子页那条注释记的是同一个坑。
   */
  .body {
    position: relative;
    display: grid;
    grid-template-columns: var(--pool-w) minmax(0, 1fr) var(--drawer-w);
    grid-template-rows: minmax(0, 1fr);
    min-height: 0;
    min-width: 0;
  }
  .body > :global(*) {
    grid-row: 1;
  }
  .body.is-hidden {
    display: none;
  }
  /*
   * 调色页：两列（舞台 | 码头）。
   *
   * 调色侧栏**不在这一列**：它只有五个图标，占满一整条纵向空间纯属浪费。
   * 它挂在 `.stage` 内部、只占工具条 + 底部面板那一条（见 `.grade-rail-host`）。
   */
  .body.is-grade {
    grid-template-columns: minmax(0, 1fr) var(--grade-w, 0px);
  }
  /*
   * 粒子页：左列分组参数 | 中列画面 | 右栏预设与状态。
   * 换页只是换左右两列和网格宽度，不卸载 canvas。`.stage` 不用动：
   * 基础规则里它本来就在第 2 列。
   */
  .body.is-particles {
    grid-template-columns: var(--pe-left-w, 296px) minmax(0, 1fr) var(--pe-right-w, 248px);
    grid-template-rows: minmax(0, 1fr);
  }
  /* 时间轴隐藏了，调高度 / 夹角的热区在这一页没有对象可拖。 */
  .body.is-particles :global(.h-resize),
  .body.is-particles :global(.corner-resize) {
    display: none;
  }
  @media (max-width: 1100px) {
    /* 窄窗口：右栏折成抽屉（见 ParticleEditor.svelte），网格退回两列。 */
    .body.is-particles {
      grid-template-columns: var(--pe-left-w, 248px) minmax(0, 1fr);
    }
  }
  /* 舞台仍然在第 1 列（基础规则里它是第 2 列，左边还有左列）。 */
  .body.is-grade > .stage {
    grid-column: 1;
  }
  .body > :global(aside.gd) {
    grid-column: 2;
  }
  /*
   * 码头左沿的拖拽热区：整条高度都是命中区（夹角的那个小方块在调色页不够用 ——
   * 这一页没有时间轴，用户心里的「调宽」是竖直的一条边，不是一个角）。
   */
  .dock-resize {
    position: absolute;
    top: 0;
    bottom: 0;
    right: var(--grade-w, 0px);
    width: 5px;
    margin-right: -2px;
    cursor: ew-resize;
    z-index: 6;
  }
  .dock-resize:hover {
    background: var(--accent);
  }
  /*
   * 左列：原生面板（媒体池 / Agent / 调制器，互斥）在上，插件分节在下，同一条列。
   *
   * 边框 / 背景**只在这里画** —— 里面的抽屉与 `DockStack` 各画一条的话，
   * 会得到一条把同一个容器切成两半的竖线（「插件一列 + 原生一列」的观感）。
   * 宽度由 `--pool-w` 给；抽屉自己的内联宽度与它同源（都是 `mediaPoolWidth`）。
   */
  .left-col {
    grid-column: 1;
    display: flex;
    flex-direction: column;
    min-width: 0;
    min-height: 0;
    background: var(--drawer-bg);
    border-right: 1px solid var(--drawer-border);
    overflow: hidden;
  }
  .left-col > :global(aside) {
    /* 抽屉自己带 `flex-shrink: 0`，这里只补「有剩高就吃」。 */
    flex-grow: 1;
    flex-basis: 0;
    min-height: 120px;
  }
  /*
   * 里面那三个抽屉的右沿竖线要摘掉（否则和容器那条叠在一起）。
   *
   * ⚠️ 必须带类名：它们自己的样式是 `.agent-drawer.svelte-xxx`（两个类），
   * 光写 `.left-col > aside` 只有 (0,1,1)，**输给**它们，线会留着 ——
   * 而这件事在功能断言里看不出来，只有截图能看出来。
   */
  .left-col > :global(aside.media-drawer),
  .left-col > :global(aside.agent-drawer),
  .left-col > :global(aside.mod-drawer) {
    border-right: none;
  }
  /* 右列（检查器 + 右侧插件分节同一个容器）在第 3 列。 */
  .body > :global(aside[data-side='right']) {
    grid-column: 3;
  }
  .stage {
    grid-column: 2;
    display: grid;
    /* 预览吃满剩余高度；工具条与轨道区按内容/固定高度排在下面 */
    grid-template-rows: minmax(0, 1fr) auto auto;
    /*
     * 必须显式约束列宽。隐式列默认是 `auto`，会被子项的**最小内容宽度**撑开——
     * 工具条里几乎所有控件都是 flex-shrink:0，实测在 1280 宽的窗口下把这一列
     * 撑到 1058px，而 stage 本身只有 936px：preview / toolbar / tracks 三个子项
     * 一起溢出到右侧抽屉底下，并把预览宿主撑成一个不受网格约束的尺寸。
     */
    grid-template-columns: minmax(0, 1fr);
    min-height: 0;
    min-width: 0;
    /*
     * 只为一个东西存在：看板娘（绝对定位，锚在右下角）。它是定位**祖先**，
     * 且它的右边界就是检查器的左边界（`.body` 的列 = 1fr + --drawer-w），
     * 所以「位置跟着检查器宽度让开」不需要任何 calc。
     * 加这一行不改布局：静态→relative 的盒模型完全一致；也没有后代依赖
     * `.stage` 之上的包含块（悬浮工具条锚 `.preview`、时间轴的绝对元素锚
     * `.rows`，都是各自组件里显式 relative）。
     */
    position: relative;
  }
  .toolbar {
    display: flex;
    align-items: center;
    gap: var(--sp-4);
    flex-shrink: 0;
    min-width: 0;
    /* 兜底：工具条内部自己横向滚动（见 Transport.svelte），这一层再夹一次，
       保证没有任何子内容能把 stage 的列撑宽（那条历史 bug 见 .stage 注释）。 */
    overflow: hidden;
    padding: 3px var(--sp-4);
    background: var(--surface-2);
    border-top: 1px solid var(--tl-border);
    border-bottom: 1px solid var(--tl-border);
  }
  .toolbar-tail {
    margin-left: auto;
    display: inline-flex;
    align-items: center;
    gap: var(--sp-2);
  }
  .tracks {
    /* 高度是可拖的实例值（appState.timelineHeight，localStorage 持久化）。
       变量在 .stage 上内联下发；回退值给「JS 还没跑起来」那一瞬兜底。 */
    height: var(--tracks-h, 320px);
    min-height: 0;
    min-width: 0;
    border-top: none;
  }
  /*
   * 调色页的舞台：两列（窄侧栏 | 内容），三行（预览 / 工具条 / 调色台）。
   * 预览**跨两列**：侧栏只在下面那一条出现，画面上方不该留一条空白。
   */
  .stage.is-grade {
    grid-template-columns: var(--grade-rail-w, 40px) minmax(0, 1fr);
  }
  .stage.is-grade > :global(.preview) {
    grid-column: 1 / -1;
    grid-row: 1;
  }
  .stage.is-grade > .toolbar {
    grid-column: 2;
    grid-row: 2;
  }
  .stage.is-grade > .grade-panels {
    grid-column: 2;
    grid-row: 3;
  }
  .grade-rail-host {
    grid-column: 1;
    grid-row: 2 / span 2;
    min-height: 0;
    display: flex;
  }
  /* 调色页：时间轴只是隐藏（不卸载，见模板上的注释）。 */
  .tracks.hidden {
    display: none;
  }
  /*
   * 调色台：占的正是时间轴那一格的高度（同一个 `timelineHeight`），
   * 所以进 / 出调色页时画面高度不变 —— 手感上像同一个界面换了内容。
   */
  .grade-panels {
    height: var(--grade-h, 320px);
    min-height: 0;
    min-width: 0;
    border-top: 1px solid var(--border);
  }
  /* 工具条 / 轨道区交界的高度热区。hover 才显形 —— 平时它不该被看见。 */
  .h-resize {
    position: absolute;
    left: 0;
    right: 0;
    bottom: var(--tracks-h, 320px);
    height: 4px;
    cursor: ns-resize;
    z-index: 6;
  }
  .h-resize:hover,
  .h-resize.active {
    background: var(--accent);
  }
  /* 夹角热区：轨道区底角与抽屉的交界，一次手势同时调高与宽。 */
  .corner-resize {
    position: absolute;
    bottom: 0;
    width: 12px;
    height: 12px;
    z-index: 6;
  }
  .corner-resize.left {
    left: 0;
    cursor: nesw-resize;
  }
  .corner-resize.right {
    right: 0;
    cursor: nwse-resize;
  }
  .corner-resize:hover {
    background: var(--accent);
  }
  /* 拖动中禁止选中文本，否则整页会变蓝（与 DockStack 同一处理）。 */
  :global(body:has(.h-resize.active)) {
    user-select: none;
  }
</style>
