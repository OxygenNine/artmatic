<script lang="ts">
  /**
   * MediaPoolDrawer — 左侧可收起的媒体池抽屉。右列（`DockStack`）的镜像：
   * 同一套头部（标题 + 收起）× 、同一个拖宽热区，只是热区贴在**右**边缘、往右拖变宽。
   *
   * 宽度走**元素内联样式**而不是 CSS 变量，理由与那边完全一致：token 注入函数
   * 每次主题变化都会重写 `:root` 的全部变量，放进去的话用户拖出来的宽度会被
   * 主题切换覆盖掉。它是实例值，不是 token。
   *
   * 它**只在时间轴视图里参与布局**：排版编辑页是一整页（`.body` 被 display:none），
   * 点侧栏入口会得到一句说明而不是一个什么都看不见的开关 —— 与检查器同一条边界。
   */
  import Icon from './Icon.svelte';
  import IconButton from './controls/IconButton.svelte';
  import Select from './controls/Select.svelte';
  import MediaPool from './MediaPool.svelte';
  import { appState } from './app-state.svelte';
  import { importFiles } from './media-import';
  import { POOL_SORTS, type PoolSort } from './media-pool';
  import { loadPoolPinyin } from './pool-pinyin';
  import { DENSITY } from './tokens';
  import type { MessageKey } from '../i18n/locales';
  import { tr } from '../i18n/index.svelte';

  let resizing = $state(false);
  let dragStartX = 0;
  let dragStartW = 0;

  /* --------------------------------------------------------- 搜索 / 形态 / 排序 */

  /** 搜索词是这一层（抽屉）的临时状态：关掉抽屉再开，用户不该还困在上次的过滤里。 */
  let query = $state('');

  const compact = $derived(appState.poolView === 'compact');

  /** 排序档位 → 文案键。方向写进标签（大→小 / 新→旧），省掉一次猜测。 */
  const SORT_LABEL: Record<PoolSort, MessageKey> = {
    added: 'pool.sortAdded',
    name: 'pool.sortName',
    size: 'pool.sortSize',
    modified: 'pool.sortModified',
    duration: 'pool.sortDuration',
  };
  const sortOptions = $derived(POOL_SORTS.map((v) => ({ value: v, label: tr(SORT_LABEL[v]) })));

  /* ------------------------------------------------------ 从系统拖文件进来 */

  /**
   * 有没有正在把**系统文件**拖到抽屉上。
   *
   * 用进出计数而不是「dragenter 置真 / dragleave 置假」：后者在子元素之间
   * 移动时会连着触发（dragenter/dragleave 会为每个子元素冒泡一轮），
   * 覆盖层会一闪一闪。
   */
  let fileDragDepth = $state(0);
  const fileDragging = $derived(fileDragDepth > 0);

  const draggingFiles = (dt: DataTransfer | null): boolean => !!dt?.types.includes('Files');

  function onDragEnter(e: DragEvent): void {
    if (!draggingFiles(e.dataTransfer)) return;
    fileDragDepth += 1;
  }

  function onDragLeave(e: DragEvent): void {
    if (!draggingFiles(e.dataTransfer)) return;
    fileDragDepth = Math.max(0, fileDragDepth - 1);
  }

  function onDragOver(e: DragEvent): void {
    if (!draggingFiles(e.dataTransfer)) return;
    // 不 preventDefault 浏览器就不允许落点（drop 根本不会发生）
    e.preventDefault();
    if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
  }

  function onDrop(e: DragEvent): void {
    if (!draggingFiles(e.dataTransfer)) return;
    e.preventDefault();
    fileDragDepth = 0;
    const files = Array.from(e.dataTransfer?.files ?? []);
    // 不给 trackId：落在池子上只登记素材，不建片段（要片段就拖到时间轴那条路上）
    if (files.length) void importFiles(files);
  }

  function startResize(e: PointerEvent): void {
    if (e.button !== 0) return;
    e.preventDefault();
    resizing = true;
    dragStartX = e.clientX;
    dragStartW = appState.mediaPoolWidth;
    const el = e.currentTarget as HTMLElement;
    el.setPointerCapture(e.pointerId);

    const mv = (ev: PointerEvent): void => {
      // 热区在右边缘，所以往**右**拖是变宽（检查器那条是反的）
      appState.setMediaPoolWidth(dragStartW + (ev.clientX - dragStartX));
    };
    const up = (ev: PointerEvent): void => {
      el.removeEventListener('pointermove', mv);
      el.removeEventListener('pointerup', up);
      el.removeEventListener('pointercancel', up);
      if (el.hasPointerCapture(ev.pointerId)) el.releasePointerCapture(ev.pointerId);
      resizing = false;
    };
    el.addEventListener('pointermove', mv);
    el.addEventListener('pointerup', up);
    el.addEventListener('pointercancel', up);
  }
</script>

<aside
  class="media-drawer"
  class:resizing
  class:file-drag={fileDragging}
  data-testid="media-drawer"
  style:width={`${appState.mediaPoolWidth}px`}
  style:min-width={`${DENSITY.poolMinW}px`}
  role="presentation"
  ondragenter={onDragEnter}
  ondragleave={onDragLeave}
  ondragover={onDragOver}
  ondrop={onDrop}
>
  <!-- 拖宽热区：贴在右边界（它左边是窄侧栏，右边才是画面） -->
  <div
    class="drawer-resize"
    role="separator"
    aria-label={tr('pool.resizeWidth')}
    aria-orientation="vertical"
    data-testid="media-drawer-resize"
    onpointerdown={startResize}
  ></div>

  <div class="drawer-head">
    <div class="head-row">
      <span class="drawer-title">
        <Icon name="images" size={12} />
        {tr('pool.title')}
      </span>
      <IconButton
        icon="x"
        label={tr('pool.collapse')}
        size="sm"
        testid="media-drawer-toggle"
        onclick={() => appState.setMediaPoolOpen(false)}
      />
    </div>
    <!--
      搜索 / 形态 / 排序同占一行。搜索框吃掉剩余宽度（抽屉只有两三百像素，
      给排序下拉固定宽度、余下的全给输入框）。
    -->
    <div class="head-tools">
      <span class="search">
        <Icon name="search" size={12} />
        <input
          type="text"
          class="search-input"
          placeholder={tr('pool.search')}
          aria-label={tr('pool.search')}
          data-testid="pool-search"
          bind:value={query}
          onfocus={() => {
            // 拼音库在这儿才下载：只有「来搜索」的人才付它的体积。
            void loadPoolPinyin().then(() => appState.markPoolPinyinReady());
          }}
          onkeydown={(e) => {
            // Esc = 清空搜索（抽屉本身的关闭由头部那个 × 负责，不让一个键既是
            // 「退出搜索」又是「收起面板」）。
            if (e.key === 'Escape' && query) {
              e.stopPropagation();
              query = '';
            }
          }}
        />
      </span>
      <!-- 两态图标按钮：当前是缩略图就显示「切到紧凑」的图标，反之亦然。 -->
      <IconButton
        icon={compact ? 'layout-grid' : 'list'}
        label={compact ? tr('pool.viewThumbs') : tr('pool.viewCompact')}
        size="sm"
        testid="pool-view-toggle"
        onclick={() => appState.setPoolView(compact ? 'thumbs' : 'compact')}
      />
      <Select
        value={appState.poolSort}
        options={sortOptions}
        onchange={(v) => appState.setPoolSort(v)}
        ariaLabel={tr('pool.sort')}
        testid="pool-sort"
        optionTestidPrefix="pool-sort-opt"
        minWidth={104}
      />
    </div>
  </div>

  <div class="drawer-body">
    <MediaPool {query} />
  </div>

  <!--
    拖文件进来时的回执。盖在列表上而不是只描个边框：抽屉里可能已经排了一屏
    素材行，光靠边框用户看不出「松手会发生什么」。
  -->
  {#if fileDragging}
    <div class="drop-veil" data-testid="pool-drop-veil">
      <Icon name="image-plus" size={20} />
      <span>{tr('pool.dropHint')}</span>
    </div>
  {/if}
</aside>

<style>
  .media-drawer {
    position: relative;
    /*
     * 与检查器同一个层级。理由也一样：抽屉是一个**层叠上下文**，从里面打开的
     * 浮层（这里是素材的悬停预览一类的将来项）不能被时间轴内部那套（1..5）
     * 盖住。见 tokens.ts 的 z-drawer 那一段。这里虽然当前没有浮层，
     * 但两个抽屉的层级没有理由不一样。
     */
    z-index: var(--z-drawer);
    flex-shrink: 0;
    display: flex;
    flex-direction: column;
    min-height: 0;
    background: var(--drawer-bg);
    border-right: 1px solid var(--drawer-border);
    overflow: hidden;
  }
  .drawer-resize {
    position: absolute;
    right: 0;
    top: 0;
    bottom: 0;
    width: 4px;
    cursor: ew-resize;
    z-index: 1;
  }
  .drawer-resize:hover,
  .resizing .drawer-resize {
    background: var(--accent);
  }
  .resizing {
    user-select: none;
  }
  /*
    头部两行：标题行（与顶栏同高，两个抽屉的标题落在同一条水平线上）+ 工具行。
    不把搜索框塞进标题行：抽屉常态只有 300px 宽，标题与输入框抢宽度时
    两边都会被截断（标题变成「媒体…」、输入框只剩十几个像素）。
  */
  .drawer-head {
    display: flex;
    flex-direction: column;
    flex-shrink: 0;
    padding: 0 var(--sp-2) var(--sp-2) var(--sp-4);
    border-bottom: 1px solid var(--drawer-border);
  }
  .head-row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--sp-3);
    height: var(--topbar-h);
  }
  .head-tools {
    display: flex;
    align-items: center;
    gap: var(--sp-1);
    min-width: 0;
  }
  /* 搜索框与特效选择器同形（图标 + 无边框输入），只是更矮更窄 */
  .search {
    display: flex;
    align-items: center;
    gap: var(--sp-2);
    flex: 1;
    min-width: 0;
    height: var(--control-h);
    padding: 0 var(--sp-2);
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    background: var(--input-bg);
    color: var(--text-muted);
  }
  .search:focus-within {
    border-color: var(--accent);
  }
  .search-input {
    flex: 1;
    min-width: 0;
    border: 0;
    padding: 0;
    background: transparent;
    color: var(--text-primary);
    font: inherit;
    font-size: var(--fs-xs);
    outline: none;
  }
  .drawer-title {
    display: inline-flex;
    align-items: center;
    gap: var(--sp-2);
    color: var(--text-muted);
    font-size: var(--fs-xs);
    letter-spacing: 0.08em;
    text-transform: uppercase;
  }
  .drawer-body {
    flex: 1;
    min-height: 0;
    overflow-y: auto;
  }
  /* 拖文件进来时：抽屉自己也要有变化，否则「落在哪儿」全靠猜 */
  .media-drawer.file-drag {
    border-right-color: var(--accent);
  }
  .drop-veil {
    position: absolute;
    inset: 0;
    /* 盖住列表，但要让**抽屉的拖拽事件**继续收得到：它自己没有交互 */
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: var(--sp-3);
    padding: var(--sp-5);
    /* 盖住列表但**留一点影子**：完全糊掉会让人以为抽屉坏了 */
    background: color-mix(in srgb, var(--surface-1) 94%, transparent);
    border: 1px dashed var(--accent);
    color: var(--accent);
    text-align: center;
    font-size: var(--fs-sm);
    line-height: 1.5;
    pointer-events: none;
  }
</style>
