<script lang="ts">
  /**
   * MediaPool — 媒体池的内容：这个工程里已导入的素材，一行一条。
   *
   * 分组顺序固定为视频 → 图片 → 音频（空组不显示），组内顺序由头部那个排序档位决定
   * （默认导入顺序）。列表怎么合成、怎么分组 / 筛选 / 排序、从素材怎么建片段，
   * 全在 `media-pool.ts` 里（纯函数，有单测）；这里只负责把 appState 的几个值
   * 喂进去、把它画出来。
   *
   * 「插入」落在**播放头**上，优先用主选中片段所在的那条轨 —— 用户此刻在编辑
   * 哪条轨，新素材就该落到哪里，这是从「我正在拼这一段」的意图推出来的。
   */
  import Icon from './Icon.svelte';
  import IconButton from './controls/IconButton.svelte';
  import Menu from './controls/Menu.svelte';
  import ConfirmDialog from './ConfirmDialog.svelte';
  import PreClipModal from './preclip/PreClipModal.svelte';
  import { appState } from './app-state.svelte';
  import { collectAsset, relinkAsset } from './project-actions';
  import {
    ASSET_DRAG_MIME,
    assetUsageSeconds,
    buildPoolItems,
    clipsUsingAsset,
    filterPoolItems,
    groupPool,
    insertAssetClip,
    sortPoolItems,
    type PoolItem,
    type PoolKind,
  } from './media-pool';
  import { resolveImageAsset } from '../typography/image-assets';
  import { poolPinyinHaystack } from './pool-pinyin';
  import { ensureVideoThumb, forgetVideoThumb, videoThumb } from './media-thumbs.svelte';
  import { fmtSize } from './export';
  import { snapTimeWithSections } from '../core/sections';
  import type { IconName } from './icons';
  import type { AssetTrimRange } from '../core/schema';
  import type { MessageKey } from '../i18n/locales';
  import { tr } from '../i18n/index.svelte';

  interface Props {
    /**
     * 条目的落点由宿主决定：不传 = 时间轴（插到播放头，媒体池抽屉那条路）；
     * 排版编辑页传自己的实现（图片置入画布，视频/音频给一句说明）。
     * 「双击」与右侧的 + 按钮共用它。
     */
    oninsert?: (item: PoolItem) => void;
    /** 搜索词。输入框在抽屉头部（`MediaPoolDrawer`），过滤在这一层做。 */
    query?: string;
  }
  const { oninsert, query = '' }: Props = $props();

  /* 落点不同，提示语跟着换：在排版页说「插入到时间轴」是错的。 */
  const insertLabel = $derived(oninsert ? tr('pool.placeOnCanvas') : tr('pool.insert'));
  const hint = $derived(oninsert ? tr('pool.hintTypo') : tr('pool.hint'));
  /** 紧凑形态：去掉缩略图，只留名字，宽度够时自动多列（CSS grid）。 */
  const compact = $derived(appState.poolView === 'compact');

  const GROUP_LABEL: Record<PoolKind, MessageKey> = {
    video: 'pool.groupVideo',
    image: 'pool.groupImage',
    audio: 'pool.groupAudio',
  };
  const GROUP_ICON: Record<PoolKind, IconName> = {
    video: 'video',
    image: 'image',
    audio: 'audio-lines',
  };

  /**
   * 列表跟着 `appState.version` 走：导入素材是「先 put 字节、再 commit」，
   * 而 version 是 commit 推的 —— 读version 才能让新导进来的那条立刻出现。
   * 切工程也走它（`subscribeActive` 会把 version 换成新工程的计数）。
   */
  const rawItems = $derived.by(() => {
    void appState.version;
    return buildPoolItems(appState.store.project.assets, appState.assets);
  });
  /**
   * 每条素材在时间轴上的片段总时长（「时间轴时长」排序要用）。
   * 与 `clipsUsingAsset` 同一条判据（见 `clipAssetId`）。
   */
  const usedSec = $derived.by(() => {
    void appState.version;
    return assetUsageSeconds(appState.store.project);
  });
  const items = $derived.by(() => {
    // 拼音转换器就绪后要重算一遍：它加载完成时用户可能已经打完一轮查询了。
    void appState.poolPinyinReady;
    const filtered = filterPoolItems(rawItems, query, poolPinyinHaystack);
    return sortPoolItems(filtered, appState.poolSort, usedSec);
  });
  const groups = $derived(groupPool(items));

  /**
   * 视频缩略图：**惰性**解一帧（图片那边导入时就解好了，见 media-thumbs）。
   * 放 `$effect` 而不是在 `items` 的派生里做 —— 派生必须保持纯的，
   * 而 `ensureVideoThumb` 有副作用（排队解码）。它内部幂等，重复调用无代价。
   * 紧凑形态不显示缩略图，也就不必为它解码。
   */
  $effect(() => {
    if (compact) return;
    for (const it of items) if (it.kind === 'video') ensureVideoThumb(it.id);
  });

  /**
   * 元信息一行：尺寸 / 时长 / 体积。
   *
   * 用 `·` 连起来而不是拼句子 —— 这三段都是**纯数值格式化**（`1920×1080`
   * 与 `12.3s` 一样不进语言文件），拼接也不影响语序。
   */
  function metaOf(it: PoolItem): string {
    const parts: string[] = [];
    if (it.size) parts.push(`${it.size.w}×${it.size.h}`);
    if (it.durationSec !== null) parts.push(`${it.durationSec.toFixed(1)}s`);
    if (it.bytes !== null) parts.push(fmtSize(it.bytes));
    return parts.join(' · ');
  }

  /**
   * 插入时间轴。`range === undefined` = 用条目的激活范围（双击 / + 的行为）；
   * 显式给 `null` 才插整段（预剪辑弹窗里没选范围时的那条路）。
   */
  function insert(it: PoolItem, range?: AssetTrimRange | null): void {
    // 宿主接管了落点（排版页）：交给它，这一层不认识那种落点的规则。
    if (oninsert) {
      oninsert(it);
      return;
    }
    const grid = appState.store.project.beatGrid;
    const selected = appState.selectedClipId;
    const clipId = insertAssetClip(appState.store, it, {
      at: snapTimeWithSections(
        appState.playT,
        appState.snap,
        grid,
        appState.store.project.sections,
        appState.store.project.fps,
        appState.store.project.beatMarks,
      ),
      grid,
      preferredTrackId: selected ? (appState.store.findClip(selected)?.track.id ?? null) : null,
      ...(range === undefined ? {} : { range }),
    });
    // 缺字节的条目按钮是禁用的，正常走不到这里；真到了也不该静默。
    if (!clipId) {
      appState.flash(tr('pool.missing'), 'error');
      return;
    }
    appState.selectedClipId = clipId;
  }

  /**
   * 正在预剪辑的条目（v13）。
   *
   * 单击视频打开它；排版页（`oninsert` 有值）不打开 —— 那里没有时间线可插入，
   * 弹窗唯一的主按钮在那边没有意义。
   */
  let preclipItem = $state<PoolItem | null>(null);
  /** 拖拽开始时刻：拖完浏览器可能补发一次 click，用时间窗把它吃掉。 */
  let dragAt = 0;
  /**
   * 单击延迟。视频条目的单击 = 开预剪辑，双击 = 插入；不区分的话双击会先
   * 打开弹窗再插入（两次 click + 一次 dblclick）。延迟 220ms 是常见双击阈值。
   */
  let clickTimer: ReturnType<typeof setTimeout> | null = null;

  function rowClick(it: PoolItem): void {
    if (Date.now() - dragAt < 300) return;
    if (it.kind !== 'video' || it.missing || oninsert) return;
    if (clickTimer) clearTimeout(clickTimer);
    clickTimer = setTimeout(() => {
      clickTimer = null;
      // 主时间线在播时开预剪辑 = 两块画面同时动、两份声音同时响。
      // 弹窗是模态的，进来先停主传输。
      appState.pause();
      preclipItem = it;
    }, 220);
  }

  function rowDblClick(it: PoolItem): void {
    if (clickTimer) {
      clearTimeout(clickTimer);
      clickTimer = null;
    }
    insert(it);
  }

  function dragStart(e: DragEvent, it: PoolItem): void {
    dragAt = Date.now();
    const dt = e.dataTransfer;
    if (!dt) return;
    dt.effectAllowed = 'copy';
    dt.setData(ASSET_DRAG_MIME, it.id);
    // 兜底：拖到文本框、别的应用里至少留下名字
    dt.setData('text/plain', it.name);
  }

  /* ------------------------------------------------------------ 重命名素材 */

  /**
   * 就地改名的条目。名字是**工程数据**（随工程保存），与磁盘文件名无关 ——
   * 「重命名素材」只改它在 Artmatic 里的显示名（见 `ProjectStore.renameAsset`）。
   */
  let renamingId = $state<string | null>(null);
  let renameValue = $state('');

  function beginRename(it: PoolItem): void {
    renamingId = it.id;
    renameValue = it.name;
  }

  function commitRename(): void {
    const id = renamingId;
    const name = renameValue.trim();
    renamingId = null;
    if (!id || !name) return;
    appState.renameAsset(id, name);
  }

  /* ------------------------------------------------------------ 移除素材 */

  /**
   * 菜单开在哪个条目上（非 null 时渲染菜单）。只用于**渲染**。
   * `anchor` = ⋯ 按钮（菜单贴在按钮下方），`at` = 右键（贴在鼠标处）。
   */
  let menuFor = $state<{
    item: PoolItem;
    anchor?: HTMLElement;
    at?: { x: number; y: number };
  } | null>(null);
  /**
   * 菜单当前作用的条目。**不能从 `menuFor` 派生**：
   * `Menu.activate()` 是「先 `onclose()` 再跑 `onselect()`」（见 controls/Menu.svelte），
   * 那时 `menuFor` 已经是 null。闭包里读 `menuFor.item`（或模板里用 `{@const}`
   * 从它派生）都会在那一刻抛 TypeError —— 表现是「点菜单项什么都不发生」。
   *
   * `$state.raw` 而不是普通 `let`：模板不读它（只供闭包），但 svelte-check 会把
   * 「在组件里重新赋值的普通变量」报成疑似漏写 `$state`。`raw` 不做深代理，
   * `PoolItem` 保持导入时那个对象，语义与普通变量一致。
   */
  let menuTarget = $state.raw<PoolItem | null>(null);
  /**
   * 待确认的移除。**引用数在按下那一刻算一次**并存在这里 ——
   * 弹窗期间工程还能被改（另一只手在拖片段），实时重算会让文案在用户眼皮底下跳。
   */
  let pendingDelete = $state<{ item: PoolItem; used: number } | null>(null);

  /** 右键：菜单贴在鼠标处（与时间轴片段右键同一套）。`preventDefault` 必须有 —— 全局右键已禁用。 */
  function openContextMenu(e: MouseEvent, it: PoolItem): void {
    e.preventDefault();
    e.stopPropagation();
    menuTarget = it;
    menuFor = { item: it, at: { x: e.clientX, y: e.clientY } };
  }

  function askDelete(it: PoolItem): void {
    pendingDelete = { item: it, used: clipsUsingAsset(appState.store.project, it.id).length };
  }

  function confirmDelete(): void {
    const p = pendingDelete;
    pendingDelete = null;
    if (!p) return;
    appState.removeAsset(p.item.id);
    // 缩略图缓存是 UI 层的（`media-thumbs`），跟着这一行一起丢掉 ——
    // objectURL 不 revoke 就一直钉着那份字节。
    forgetVideoThumb(p.item.id);
    appState.flash(tr('pool.deleted', { name: p.item.name }), 'success');
  }
</script>

<div class="pool">
  {#if !items.length}
    {#if rawItems.length}
      <!-- 有素材、但没有一条命中搜索：报「没有匹配」，而不是「这个工程还没有素材」。 -->
      <div class="empty" data-testid="pool-no-match">
        <Icon name="search" size={22} />
        <p>{tr('pool.noMatch')}</p>
      </div>
    {:else}
      <div class="empty" data-testid="pool-empty">
        <Icon name="images" size={22} />
        <p>{tr('pool.empty')}</p>
        <p class="hint">{tr('pool.emptyHint')}</p>
      </div>
    {/if}
  {:else}
    {#each groups as g (g.kind)}
      <!-- 分组容器带 kind：测试与将来的拖放都要能一眼认出「这是哪一组」。 -->
      <section class="group" class:compact data-testid="pool-group" data-kind={g.kind}>
        <h3 class="group-head">
          <Icon name={GROUP_ICON[g.kind]} size={12} />
          <span>{tr(GROUP_LABEL[g.kind])}</span>
          <span class="count" data-testid="pool-group-count">{g.items.length}</span>
        </h3>

        <div class="rows">
          {#each g.items as it (it.id)}
            <!--
              缩略图：图片是导入时解好的 objectURL；视频要**惰性解一帧**
              （`media-thumbs` 排队解码，就绪后 version 一变这里自动重渲）；
              音频没有画面，用类型图标。紧凑形态整个不渲染（省掉那条解码）。
            -->
            {@const thumb = it.kind === 'image'
              ? resolveImageAsset(it.id)
              : it.kind === 'video'
                ? videoThumb(it.id)
                : null}
            <!--
              双击 = 插入，拖 = 拖到时间轴上落成片段，右键 = 素材菜单。行本身不是按钮
              （它没有自己的动作），所以用 role="presentation" 挂交互，真正的动作在右侧那个 + 上。
            -->
            <div
              class="row"
              class:missing={it.missing}
              class:compact
              role="presentation"
              draggable={!it.missing}
              data-testid="pool-item"
              data-asset-id={it.id}
              data-kind={it.kind}
              ondragstart={(e) => dragStart(e, it)}
              ondblclick={() => rowDblClick(it)}
              onclick={() => rowClick(it)}
              oncontextmenu={(e) => openContextMenu(e, it)}
              title={compact
                ? [it.name, metaOf(it)].filter(Boolean).join(' · ')
                : it.kind === 'video'
                  ? tr('pool.preclipTip')
                  : undefined}
            >
              {#if renamingId === it.id}
                <!--
                  就地改名。`stopPropagation` 全都要：行上的 click 会开预剪辑、
                  dblclick 会插入，而输入框里双击是选词。
                -->
                <!-- svelte-ignore a11y_autofocus -->
                <input
                  class="rename-input"
                  bind:value={renameValue}
                  autofocus
                  data-testid="pool-rename-input"
                  aria-label={tr('pool.renameAsset')}
                  onpointerdown={(e) => e.stopPropagation()}
                  onclick={(e) => e.stopPropagation()}
                  ondblclick={(e) => e.stopPropagation()}
                  oncontextmenu={(e) => e.stopPropagation()}
                  onblur={commitRename}
                  onkeydown={(e) => {
                    if (e.key === 'Enter') {
                      e.preventDefault();
                      commitRename();
                    } else if (e.key === 'Escape') {
                      e.preventDefault();
                      renamingId = null;
                    }
                  }}
                />
              {:else if compact}
                <!-- 紧凑形态：只有名字（多列由 `.group.compact .rows` 的 grid 决定） -->
                <span class="name" data-testid="pool-name">{it.name}</span>
              {:else}
                <span class="thumb">
                  {#if thumb}
                    <img src={thumb} alt="" loading="lazy" data-testid="pool-thumb" />
                  {:else}
                    <Icon name={GROUP_ICON[it.kind]} size={15} />
                  {/if}
                </span>

                <span class="text">
                  <span class="name" title={it.name} data-testid="pool-name">{it.name}</span>
                  <span class="sub">
                    {#if it.missing}
                      <span class="warn">{tr('pool.missing')}</span>
                    {/if}
                    {#if it.linked}
                      <span class="badge" title={tr('pool.linkedHint')} data-testid="pool-linked">
                        {tr('pool.linked')}
                      </span>
                    {/if}
                    {#if it.stale}
                      <span class="badge stale" title={tr('pool.staleHint')} data-testid="pool-stale">
                        {tr('pool.stale')}
                      </span>
                    {/if}
                    {#if metaOf(it)}<span>{metaOf(it)}</span>{/if}
                  </span>
                </span>

                <IconButton
                  icon="plus"
                  label={insertLabel}
                  size="sm"
                  testid="pool-insert"
                  disabled={it.missing}
                  onclick={(e) => {
                    // 别让 + 的 click 冒泡到行上（否则插入的同时又开了预剪辑）。
                    e.stopPropagation();
                    insert(it);
                  }}
                />

                <!--
                  ⋯ 与轨道行、时间轴片段用同一套菜单位置与图标：这一列的动作都是
                  「对这条东西做点什么」，放在行的右端、图标一致，用户不用重新找。
                -->
                <IconButton
                  icon="ellipsis-vertical"
                  label={tr('pool.menu')}
                  size="sm"
                  testid="pool-menu"
                  onclick={(e) => {
                    e.stopPropagation();
                    menuTarget = it;
                    menuFor = { item: it, anchor: e.currentTarget as HTMLElement };
                  }}
                />
              {/if}
            </div>
          {/each}
        </div>
      </section>
    {/each}

    <p class="foot">{hint}</p>
  {/if}
</div>

{#if menuFor}
  <Menu
    items={[
      {
        id: 'rename',
        label: tr('pool.renameAsset'),
        icon: 'pencil' as const,
        testid: 'pool-menu-rename',
        // 读 `menuTarget`（普通变量），**不是** `menuFor`：理由见它的声明。
        onselect: () => menuTarget && beginRename(menuTarget),
      },
      ...(menuTarget?.kind === 'video' && !menuTarget.missing && !oninsert
        ? [
            {
              id: 'preclip',
              label: tr('pool.preclip'),
              icon: 'scissors' as const,
              testid: 'pool-menu-preclip',
              onselect: () => {
                if (menuTarget) preclipItem = menuTarget;
              },
            },
          ]
        : []),
      ...(menuTarget?.linked
        ? [
            {
              id: 'collect',
              label: tr('pool.collect'),
              icon: 'hard-drive' as const,
              testid: 'pool-menu-collect',
              onselect: () => {
                if (menuTarget) void collectAsset(menuTarget.id);
              },
            },
            {
              id: 'relink',
              label: tr('pool.relink'),
              icon: 'link' as const,
              testid: 'pool-menu-relink',
              onselect: () => {
                if (menuTarget) void relinkAsset(menuTarget.id);
              },
            },
          ]
        : []),
      {
        id: 'delete',
        label: tr('pool.delete'),
        icon: 'trash' as const,
        danger: true,
        testid: 'pool-menu-delete',
        onselect: () => menuTarget && askDelete(menuTarget),
      },
    ]}
    at={menuFor.at}
    anchorEl={menuFor.anchor ?? null}
    onclose={() => (menuFor = null)}
    testid="pool-menu-panel"
  />
{/if}

{#if preclipItem}
  <PreClipModal
    item={preclipItem}
    onclose={() => (preclipItem = null)}
    oninsert={(range) => {
      const it = preclipItem;
      preclipItem = null;
      if (it) insert(it, range);
    }}
  />
{/if}

{#if pendingDelete}
  <ConfirmDialog
    title={tr('pool.deleteTitle')}
    message={pendingDelete.used > 0
      ? tr('pool.deleteUsedMessage', { name: pendingDelete.item.name, n: pendingDelete.used })
      : tr('pool.deleteMessage', { name: pendingDelete.item.name })}
    confirmLabel={tr('pool.deleteConfirm')}
    danger
    testid="confirm-delete-asset"
    onconfirm={confirmDelete}
    oncancel={() => (pendingDelete = null)}
  />
{/if}

<style>
  .pool {
    padding: var(--sp-3) 0 var(--sp-4);
  }

  .group + .group {
    margin-top: var(--sp-4);
  }
  .group-head {
    display: flex;
    align-items: center;
    gap: var(--sp-2);
    margin: 0 0 var(--sp-2);
    padding: 0 var(--sp-4);
    color: var(--text-muted);
    font-size: var(--fs-xs);
    font-weight: 500;
    letter-spacing: 0.08em;
    text-transform: uppercase;
  }
  /* 计数贴右：三组之间一眼看出「哪一类素材最多」 */
  .count {
    margin-left: auto;
    color: var(--text-disabled);
    letter-spacing: 0;
  }

  /*
    条目区。缩略图形态是一列；紧凑形态是「宽度够就多列」的 auto-fill 网格
    （minmax 下限 = 一个能看全名字的宽度，不够就自然退回一列）。
    网格挂在 `.rows` 上而不是 `.group` 上：小标题不该变成网格里的一格。
  */
  .rows {
    display: flex;
    flex-direction: column;
  }
  .group.compact .rows {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(144px, 1fr));
    gap: 1px var(--sp-2);
    padding: 0 var(--sp-2);
  }

  .row {
    display: flex;
    align-items: center;
    gap: var(--sp-3);
    min-width: 0;
    padding: var(--sp-2) var(--sp-4);
    cursor: default;
  }
  .row:hover {
    background: var(--surface-hover);
  }
  /* 可拖的条目给一个抓手光标（缺字节的那条不给：它拖不动） */
  .row[draggable='true'] {
    cursor: grab;
  }
  .row.missing .name {
    color: var(--text-muted);
    text-decoration: line-through;
  }
  /* 紧凑条目：只有名字，高度与内边距都收到最小（一屏几十条） */
  .row.compact {
    gap: var(--sp-2);
    padding: var(--sp-1) var(--sp-2);
    border-radius: var(--radius-sm);
  }

  /* 缩略图格子：定宽定比，图片与图标两种内容都落在同一块地里 */
  .thumb {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    flex-shrink: 0;
    width: 40px;
    height: 26px;
    background: var(--surface-2);
    border: 1px solid var(--border);
    border-radius: 2px;
    color: var(--text-muted);
    overflow: hidden;
  }
  .thumb img {
    display: block;
    width: 100%;
    height: 100%;
    /* contain 而不是 cover：素材的原始比例要看得见（裁过的缩略图会误导） */
    object-fit: contain;
  }

  .text {
    display: flex;
    flex-direction: column;
    gap: 1px;
    min-width: 0;
    flex: 1;
  }
  .name {
    color: var(--text-primary);
    font-size: var(--fs-sm);
    /* 长文件名不许把「+」按钮挤出抽屉 */
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .sub {
    display: flex;
    gap: var(--sp-2);
    color: var(--text-muted);
    font-size: var(--fs-xs);
    font-variant-numeric: tabular-nums;
    overflow: hidden;
    white-space: nowrap;
  }
  .warn {
    color: var(--danger);
  }
  .badge {
    flex: none;
    padding: 0 4px;
    border: 1px solid var(--border-subtle);
    border-radius: 3px;
    color: var(--text-secondary);
    font-size: 10px;
    line-height: 14px;
  }
  .badge.stale {
    color: var(--warn, #d9a441);
    border-color: color-mix(in srgb, var(--warn, #d9a441) 45%, transparent);
  }

  /* 就地改名：占满整行的文本区，焦点边框用主题色（与预剪辑的范围改名同形） */
  .rename-input {
    flex: 1;
    min-width: 0;
    padding: 2px 4px;
    background: var(--surface-1);
    border: 1px solid var(--accent);
    border-radius: 2px;
    color: var(--text-primary);
    font: inherit;
    font-size: var(--fs-sm);
  }

  .foot {
    margin: var(--sp-4) var(--sp-4) 0;
    color: var(--text-muted);
    font-size: var(--fs-xs);
    line-height: 1.5;
  }

  .empty {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: var(--sp-3);
    padding: var(--sp-6) var(--sp-4);
    color: var(--text-muted);
    text-align: center;
  }
  .empty p {
    margin: 0;
    color: var(--text-secondary);
    font-size: var(--fs-sm);
  }
  .empty .hint {
    color: var(--text-muted);
    font-size: var(--fs-xs);
    line-height: 1.5;
  }
</style>
