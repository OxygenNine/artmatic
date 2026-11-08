<script lang="ts">
  import { appState } from '../ui/app-state.svelte';
  import Icon from '../ui/Icon.svelte';
  import { clipEditorOf } from '../ui/clip-editor';
  import { pxPerSec, xOfTime } from './view-model';
  import { startClipDrag, type DragPeer, type DragMode } from './drag';
  import { liveTrim } from './live-trim.svelte';
  import { clipCurvePath, curveAreaPath } from '../ui/curve-editor/curve-geometry';
  import { curveParamOf } from '../ui/curve-editor/curve-meta';
  import { lastCurveKeyOf } from '../ui/curve-editor/curve-editor-state.svelte';
  import { timeAtBeat } from '../core/time';
  import type { AnyClip, Track } from '../core/schema';
  import { tr } from '../i18n/index.svelte';

  const { track, clip }: { track: Track; clip: AnyClip } = $props();

  const grid = $derived.by(() => {
    void appState.version;
    return appState.store.project.beatGrid;
  });
  // 订阅 version：clip 是原地改的对象，不订版本位置不更新（见 Timeline 的纪律注释）
  const left = $derived.by(() => {
    void appState.version;
    return xOfTime(clip.start, appState.pxPerBeat, grid);
  });
  const width = $derived.by(() => {
    void appState.version;
    return Math.max(
      4,
      xOfTime(clip.end, appState.pxPerBeat, grid) - xOfTime(clip.start, appState.pxPerBeat, grid),
    );
  });
  // 读的是**选中集**，不是主选中（selectedClipId 只是集合第一个元素的视图）。
  // 框选与 Shift+单击都能让集合里不止一个。
  const selected = $derived(appState.isClipSelected(clip.id));

  /**
   * 显示名。**必须订阅 version**：clip 是原地改的对象，模板里直接读 `clip.label`
   * 拿不到信号 —— 名字会一直显示旧值，直到那个 `{#if renaming}` 分支翻一次面。
   * 表现是「换算法时自动改名了，但时间轴上还写着旧算法」（改名来自检查器 / agent
   * 时同理，只是没人盯着那一行看）。
   */
  const name = $derived.by(() => {
    void appState.version;
    return clip.label || clip.kind;
  });
  /** 拖拽中且当前落点会被拒收（reject 策略）：红框预告，避免「松手弹回去」的困惑。 */
  const illegal = $derived(selected && appState.dragIllegal);

  /**
   * 正在裁剪这条片段吗（v13）。
   *
   * 裁剪与移动看起来一模一样，用户分不清「我是在挪它还是在裁它」。这个状态
   * 同时驱动两件事：边框切成裁剪态（accent），以及显示名被边界裁掉。
   */
  const trimming = $derived.by(() => {
    const v = liveTrim.value;
    return v && v.clipId === clip.id ? v : null;
  });

  /**
   * 显示名相对常规位置（5px）的横向偏移。
   *
   * 拖左边界时文字锚在**手势起点的内容原点**：`clip.start` 右移多少，文字就
   * 左移多少 —— 于是它被片段左边界一点点裁掉，而不是整块跟着平移。
   * 松手时 `liveTrim` 清空，偏移回到 0（名字重新出现在新边界右侧 5px）。
   *
   * 右边界不需要偏移：容器 `overflow: hidden` 本来就会把超出右边的文字截断。
   */
  const labelShift = $derived.by(() => {
    void appState.version;
    if (!trimming || trimming.edge !== 'start') return 0;
    return -(clip.start - trimming.anchorStart) * pxPerSec(appState.pxPerBeat, grid);
  });

  /**
   * 影响深度（0 = 下方全部）。
   *
   * **必须走 version 订阅过的派生，不能在模板里直接读 `clip.affectDepth`**：
   * clip 是原地改的对象，父级 `{#each}` 传下来的还是同一个引用 ⇒ 直接读不会重渲
   * （症状：检查器里把深度从 0 改成 1，片段上的角标要等换一次选中才出现）。
   * 这与 `left` / `width` 是同一条纪律（见 Timeline.svelte 的响应式说明）。
   */
  const affectDepth = $derived.by(() => {
    void appState.version;
    return clip.kind === 'effect' ? (clip.affectDepth ?? 0) : 0;
  });

  /**
   * 双击会进哪个子界面（调色 / 排版）。`null` = 没有独立页面（双击只开抽屉）。
   *
   * 与 `openClipEditor` 读同一份判据（`ui/clip-editor.ts`）：片段上画了 palette，
   * 双击就必须真的进调色页 —— 两处各判一次的话，图标会变成一句假话。
   *
   * 订阅 version：特效链是原地改的，加了 / 删了 grade 模块要立刻反映到图标上。
   */
  const editorKind = $derived.by(() => {
    void appState.version;
    return clipEditorOf(clip);
  });

  /**
   * 绑定片段的角标文字（`boundClipId`，v11）。
   *
   * 与深度角标共用同一条纪律：读 `appState.version`，否则绑上之后角标要等换一次
   * 选中才出现。目标被删了就回落到 id —— 显示一个 `→undefined` 会更难查。
   */
  const boundTarget = $derived.by(() => {
    void appState.version;
    if (clip.kind !== 'effect' || !clip.boundClipId) return null;
    const foundClip = appState.store.findClip(clip.boundClipId);
    return {
      id: clip.boundClipId,
      label: foundClip?.clip.label || clip.boundClipId,
      track: foundClip?.track.name ?? '',
    };
  });

  /**
   * 音频淡变手柄的横向位置（px，片段内偏移）。
   *
   * 两端手柄贴住**淡变区的边界**（而不是片段边缘）：看到的就是听到的 ——
   * 三角在 1.5s 处，声音就从 1.5s 处淡进来。淡变为 0 时回到边缘。
   */
  const fadeInPx = $derived.by(() => {
    void appState.version;
    if (clip.kind !== 'audio') return 0;
    return (clip.fadeIn ?? 0) * pxPerSec(appState.pxPerBeat, grid);
  });
  const fadeOutPx = $derived.by(() => {
    void appState.version;
    if (clip.kind !== 'audio') return 0;
    return (clip.fadeOut ?? 0) * pxPerSec(appState.pxPerBeat, grid);
  });

  /**
   * 片段内绘制的迷你曲线：**最后一次在曲线编辑器里显示的那个属性**。
   *
   * 只画一个属性是刻意的：片段高度只够一条曲线，多条叠在一起什么都读不出来。
   * 数据源是 `lastCurveKeyOf`（会话级视图状态），退出编辑器后仍然保留，所以
   * 用户下次右键打开的就是同一条曲线。
   *
   * x 轴映射片段范围而非全部关键帧范围：被 trim 过的片段，关键帧常在片段外，
   * 按 key 范围映射会把片段内的形状压扁 / 错位。
   */
  const curvePreview = $derived.by(() => {
    void appState.version;
    const key = lastCurveKeyOf(clip.id);
    if (!key) return null;
    const cv = clip.curves[key];
    if (!cv || cv.keys.length === 0) return null;
    const origin = cv.beatAnchor ? timeAtBeat(cv.beatAnchor.beat, grid) : clip.start;
    const keys = cv.keys.map((k) => ({ ...k, t: k.t + origin }));
    const meta = curveParamOf(clip, key);
    const box = { left: 0, top: 0, width: 100, height: 100 };
    const d = clipCurvePath(keys, clip.start, clip.end, meta?.min ?? -1, meta?.max ?? 1, box);
    if (!d) return null;
    return { key, d, area: curveAreaPath(d, box) };
  });

  function down(e: PointerEvent, mode: DragMode): void {
    // 只有主键起手势：右键归自绘菜单（Timeline 的 contextmenu），中键归浏览器
    if (e.button !== 0) return;
    /*
     * Shift / Ctrl + 单击 = 加选 / 减选，**不起拖拽**。
     * 这是框选之后的微调手段：框多了一个、漏了一个都能就地补，
     * 没有它就只能整片重框。只在 move 上生效 —— 左右边缘是缩放热区，
     * 在那里加选会让人没法微调一个已选片段的长度。
     */
    if (mode === 'move' && (e.shiftKey || e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      e.stopPropagation();
      appState.toggleClipSelection(clip.id);
      return;
    }
    /*
     * 拖**已在选中集里**的片段 = 整组一起走；拖没选中的片段 = 先单选它再拖。
     *
     * 判据是「按下时它已经选中」而不是「选中集非空」—— 后者会让用户想单独挪一个
     * 片段时发现整片选择跟着动，而他从没表达过这个意图。
     * 组只在 move 上成立：缩放是「这条边的位置」，套到一组上没有唯一定义。
     */
    const selected = appState.selectedClipIds;
    const group = mode === 'move' && selected.length > 1 && selected.includes(clip.id);
    const peers: DragPeer[] = [];
    if (group) {
      for (const id of selected) {
        if (id === clip.id) continue;
        const found = appState.store.findClip(id);
        if (found) peers.push({ clipId: id, trackId: found.track.id, start: found.clip.start });
      }
    } else {
      appState.selectClip(clip.id);
    }
    startClipDrag(e, appState.store, {
      track,
      clip,
      mode,
      pxPerBeat: appState.pxPerBeat,
      snapMode: appState.snap,
      peers,
      onHint: (illegal) => (appState.dragIllegal = illegal),
      /*
       * 按下了但没拖动 = 一次单击（见 DragOptions.onClick）：整组拖动成立的前提是
       * 按下时**保持**选中集，所以「只选它一个」这件事只能放到松手时做。
       */
      onClick: () => appState.selectClip(clip.id),
    });
  }

  function dblclick(): void {
    /*
     * 双击 = 打开这个片段自己的编辑器，**一律不切分**。
     * 破坏性操作不该绑在高误触手势上（原来双击切分，很容易手一抖就把片段切开）。
     * 切分保留两个入口：S 键、检查器的「在播放头切分」。
     */
    appState.selectedClipId = clip.id;
    appState.openClipEditor(clip);
  }

  /** 正在就地改名的那一行（见 appState.renamingClipId）。 */
  const renaming = $derived(appState.renamingClipId === clip.id);

  /**
   * 就地改名的输入框只在 `appState.renamingClipId === clip.id` 时渲染。
   *
   * **入口是 F2（选中片段后），不是双击**：片段本体的双击已经是「打开它的
   * 编辑器」，而片段很矮（行高 ~24px）—— 名字那条带子几乎盖住整个片段，
   * 「双击名字改名」实测会把所有「双击片段开编辑器」的路径抢走
   * （typography 那一批 spec 一起红）。所以改名只用不与既有手势冲突的入口：
   * F2、以及检查器里那个 `clip-label` 输入框。
   */
  function commitRename(value: string): void {
    appState.store.renameClip(clip.id, value);
    appState.endClipRename();
  }
</script>

<div
  class="clip"
  class:selected
  class:effect={clip.kind === 'effect'}
  class:audio={clip.kind === 'audio'}
  class:trimming={trimming !== null}
  data-clip-id={clip.id}
  data-testid="clip"
  data-illegal={illegal ? 'true' : undefined}
  style:left={`${left}px`}
  style:width={`${width}px`}
  role="button"
  tabindex="0"
  onpointerdown={(e) => down(e, 'move')}
  ondblclick={dblclick}
>
  {#if curvePreview}
    <!--
      迷你曲线：曲线下方整块加深 + 一条更实的线。颜色取片段自己的 border 色
      （content 层，随亮暗变）—— 它是这套类别色里与底色对比最稳定的那一档。
      `preserveAspectRatio="none"` 允许横向/纵向各自拉伸；没有文字，不怕变形。
    -->
    <svg
      class="curve-preview"
      viewBox="0 0 100 100"
      preserveAspectRatio="none"
      aria-hidden="true"
      data-testid="clip-curve-preview"
      data-curve-key={curvePreview.key}
    >
      <path class="curve-area" d={curvePreview.area} />
      <path
        class="curve-line"
        d={curvePreview.d}
        vector-effect="non-scaling-stroke"
      />
    </svg>
  {/if}
  {#if editorKind && !renaming}
    <!--
      双击能进子界面（调色 / 排版）的**可视提示**。
      光靠底栏不够：底栏只在指针真的停在片段上时才说那一句，而「这个片段能进去」
      是片段的属性，不是悬停态的属性。图标也顺带解释了为什么双击别的片段没反应。

      改名时让位：改名输入框固定从 5px 起（CSS），图标会和它叠在一起。
    -->
    <span
      class="editor-mark"
      data-testid="clip-editor-mark"
      data-editor={editorKind}
      aria-hidden="true"
    >
      <Icon
        name={editorKind === 'grade' ? 'palette' : editorKind === 'particles' ? 'sparkles' : 'type'}
        size={10}
      />
    </span>
  {/if}
  {#if renaming}
    <!--
      svelte-ignore a11y_autofocus
      输入框盖住标签那一块（同名区域，见 CSS 的 `.label, .rename`）。
      `onpointerdown` 停冒泡是**必须的**：不停的话按下去就开始拖片段，
      指针一移输入框就被拖走了（与轨道名就地改名同一套）。
    -->
    <input
      class="rename"
      data-testid="clip-rename-input"
      value={clip.label || clip.kind}
      autofocus
      onblur={(e) => commitRename(e.currentTarget.value)}
      onkeydown={(e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          commitRename(e.currentTarget.value);
        } else if (e.key === 'Escape') {
          e.preventDefault();
          /*
           * 先把输入框的**文字改回已提交的值**再退出。
           *
           * 退出会让这个输入框被卸载，而 Chromium 在卸载带焦点的元素时**照样派发
           * blur** —— `onblur` 那个提交于是把刚被 Esc 取消掉的草稿写了回去
           * （表现：Esc 之后片段真的改名了）。改回原值后即使 blur 照发，`renameClip`
           * 也会因为「新旧同名」直接返回，不产生撤销条目。
           */
          e.currentTarget.value = clip.label || clip.kind;
          appState.endClipRename();
        }
      }}
      onpointerdown={(e) => e.stopPropagation()}
      ondblclick={(e) => e.stopPropagation()}
    />
  {:else}
    <!--
      名字**不吃指针事件**（见 CSS 的 `.label`）：双击必须原样落到片段本体上
      —— 那是「打开编辑器」，是这里被点得最多的那一下。改名的入口是 F2。
    -->
    <span
      class="label"
      style:left={`${(editorKind ? 19 : 5) + labelShift}px`}
      data-testid="clip-name">{name}</span>
  {/if}
  {#if affectDepth > 0}
    <!-- 影响深度角标：不写出来就没人知道这条特效被限过范围（画面差别还很隐蔽） -->
    <span class="fx-depth" data-testid="clip-effect-depth" title={tr('insp.affectDepth')}>↓{affectDepth}</span>
  {/if}
  {#if boundTarget}
    <!-- 绑定片段角标：看不出这条特效绑在哪一层时，用户会以为它根本没生效 -->
    <span
      class="fx-depth fx-bound"
      data-testid="clip-effect-bound"
      title={boundTarget.track ? `${boundTarget.track} · ${boundTarget.label}` : boundTarget.label}
    >→{boundTarget.label}</span>
  {/if}
  {#if clip.fadeSec > 0}
    <!-- 淡入淡出标记：纯几何形状，不引图标（这里只有 10px 见方） -->
    <i class="fade" title={tr('tl.fade')}></i>
  {/if}
  {#if clip.kind === 'audio'}
    <!--
      音频淡变手柄（v8）：两端各一个三角，拖的是 `fadeIn` / `fadeOut` 的**秒数**。
      左下 / 右下两个角 —— 右上角已经被 `fadeSec` 的标记占了。
      与缩放热区重叠：手柄 z 更高，所以边缘那 8px 归手柄（缩放热区仍是整条边）。
    -->
    <i
      class="fade-handle l"
      role="presentation"
      data-testid="clip-fade-in"
      title={tr('tl.fadeInTip')}
      style:left={`${fadeInPx}px`}
      onpointerdown={(e) => down(e, 'fade-in')}
    ></i>
    <i
      class="fade-handle r"
      role="presentation"
      data-testid="clip-fade-out"
      title={tr('tl.fadeOutTip')}
      style:right={`${fadeOutPx}px`}
      onpointerdown={(e) => down(e, 'fade-out')}
    ></i>
  {/if}
  <i class="edge l" role="presentation" onpointerdown={(e) => down(e, 'resize-l')}></i>
  <i class="edge r" role="presentation" onpointerdown={(e) => down(e, 'resize-r')}></i>
</div>

<style>
  /*
   * 片段色走 content 层（--clip-*），它随亮暗变但**不随主题色变**：
   * 这里的颜色编码的是「这是哪类数据」，不是界面角色。详见 ui/tokens.ts。
   */
  .clip {
    position: absolute;
    top: 3px;
    bottom: 3px;
    background: var(--clip-source-bg);
    border: 1px solid var(--clip-source-border);
    border-radius: var(--radius-sm);
    color: var(--clip-source-text);
    cursor: grab;
    overflow: hidden;
    user-select: none;
    touch-action: none;
  }
  .clip:active {
    cursor: grabbing;
  }
  .clip.selected {
    /* 选中用主题色描边——这是「主题色只出现在当前/激活态」的一处。 */
    outline: 2px solid var(--accent);
    outline-offset: -1px;
    z-index: var(--z-clip-selected);
  }
  /* 落点会被 reject 策略拒收：松手会整次弹回，先在这里预告 */
  .clip[data-illegal='true'] {
    outline: 2px dashed var(--danger);
    outline-offset: -1px;
    opacity: 0.7;
  }
  .clip.effect {
    background: var(--clip-effect-bg);
    border-color: var(--clip-effect-border);
    color: var(--clip-effect-text);
  }
  .clip.audio {
    background: var(--clip-audio-bg);
    border-color: var(--clip-audio-border);
    color: var(--clip-audio-text);
  }
  /*
   * 片段内的关键帧曲线。`pointer-events: none` 必须保留：片段本体的拖动 /
   * 双击都靠指针事件落到 `.clip` 上（与 `.label` 同一条纪律）。
   */
  .curve-preview {
    position: absolute;
    inset: 0;
    width: 100%;
    height: 100%;
    overflow: hidden;
    pointer-events: none;
  }
  .curve-area {
    fill: var(--clip-source-border);
    opacity: 0.3;
    stroke: none;
  }
  .curve-line {
    fill: none;
    stroke: var(--clip-source-border);
    stroke-width: 1;
    opacity: 0.9;
  }
  .clip.effect .curve-area {
    fill: var(--clip-effect-border);
  }
  .clip.effect .curve-line {
    stroke: var(--clip-effect-border);
  }
  /* 音频的底色是半透明的（波形在下面），填充再淡一档，别把波形盖没了 */
  .clip.audio .curve-area {
    fill: var(--clip-audio-border);
    opacity: 0.16;
  }
  .clip.audio .curve-line {
    stroke: var(--clip-audio-border);
  }
  /*
   * 名字区与改名输入框盖的是同一块地方。名字**必须** `pointer-events: none`：
   * 它占着片段顶部那条带子（行高只有 20 多像素，这条带子几乎就是整个片段），
   * 吃掉事件等于把「双击片段 = 打开编辑器」这条主手势改掉
   * （实测：typography 那一批按双击开编辑器的 spec 全红）。
   */
  .label,
  .rename {
    position: absolute;
    left: 5px;
    top: 1px;
    right: 12px;
    height: 14px;
    font-size: var(--fs-xs);
    line-height: 14px;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .label {
    pointer-events: none;
  }
  /*
   * 「双击进子界面」的图标。`pointer-events: none` 与 `.label` 同一条纪律：
   * 双击必须原样落到片段本体上（图标正好在名字前面，是双击最常落的地方）。
   */
  .editor-mark {
    position: absolute;
    left: 4px;
    top: 2px;
    display: grid;
    place-items: center;
    width: 11px;
    height: 11px;
    opacity: 0.85;
    pointer-events: none;
  }
  .rename {
    min-width: 24px;
    padding: 0 1px;
    /* 底色用片段自己的，免得输入框在三种片段色上各显各的 */
    background: color-mix(in srgb, currentColor 12%, transparent);
    border: 1px solid currentColor;
    border-radius: 2px;
    color: inherit;
    font-family: inherit;
  }
  .fade {
    position: absolute;
    right: 2px;
    top: 2px;
    width: 0;
    height: 0;
    border-left: 7px solid transparent;
    border-bottom: 7px solid currentColor;
    opacity: 0.5;
  }
  /* 影响深度角标：贴右下角（左上角是片段名，右上角是淡变标记），不抢片段名 */
  .fx-depth {
    position: absolute;
    right: 4px;
    bottom: 1px;
    font-size: var(--fs-xs);
    line-height: 10px;
    opacity: 0.75;
    pointer-events: none;
  }
  /* 绑定角标与深度角标同位（两者互斥，不会同时出现）：名字长了就省略，
     完整「轨道 · 片段」在 title 里。 */
  .fx-bound {
    max-width: calc(100% - 8px);
    overflow: hidden;
    white-space: nowrap;
    text-overflow: ellipsis;
  }
  .edge {
    position: absolute;
    top: 0;
    bottom: 0;
    width: 6px;
    cursor: ew-resize;
    z-index: var(--z-edge);
  }
  .edge.l {
    left: 0;
  }
  .edge.r {
    right: 0;
  }
  /* 纯图标/纯热区 hover 不用底色块，只提亮——与全局「图标按钮 hover 只变色」一致 */
  .edge:hover {
    background: color-mix(in srgb, currentColor 22%, transparent);
  }
  /*
   * 裁剪态（v13）：边框转 accent、正在拖的那条边加底色。
   *
   * 之前拖动首尾与拖动整段长得分毫不差，用户只能从「松手后长度变了」反推自己
   * 刚才在裁剪。这里让**按下那一刻**就能看出来（配合显示名被边界裁掉）。
   */
  .clip.trimming {
    border-color: var(--accent);
  }
  .clip.trimming .edge {
    background: color-mix(in srgb, var(--accent) 30%, transparent);
  }
  /*
   * 淡变手柄：零尺寸 + 两条边框拼出的三角（视觉纪律：不用渐变 / 阴影 / 图标）。
   * 命中区域是 border-box（8×8），比缩放热区窄 2px —— 挪到片段底部，避开
   * 「想拖长度却拖到淡变」的主手势。
   */
  .fade-handle {
    position: absolute;
    bottom: 0;
    width: 0;
    height: 0;
    cursor: ew-resize;
    opacity: 0.55;
    z-index: calc(var(--z-edge) + 1);
  }
  .fade-handle:hover {
    opacity: 1;
  }
  .fade-handle.l {
    border-left: 8px solid currentColor;
    border-top: 8px solid transparent;
  }
  .fade-handle.r {
    border-right: 8px solid currentColor;
    border-top: 8px solid transparent;
  }
</style>
