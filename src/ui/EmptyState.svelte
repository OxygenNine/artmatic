<script lang="ts">
  /**
   * EmptyState — 一份工程都没打开时的那一整页（首页）。
   *
   * ## 只盖「内容区」，不盖 chrome
   *
   * 它仍然是盖在主界面之上的一层，而不是替换掉主界面 —— Studio 的 `<canvas>` 一旦
   * 离开 DOM，WebGL 上下文连同 kit 里所有 Program / Target / 纹理一起失效，
   * 且不是重新 mount 能恢复的（详见 app-state.svelte.ts 里 `placeholder` 的注释）。
   *
   * 区别在于**盖到哪为止**：顶栏 / 窄侧栏 / 底栏留出来。这三条是「这个应用是什么」
   * 的一部分，首页把它们抹掉之后，用户点进第一份工程时看到的是另一套骨架 ——
   * 而它们本来就一直在这儿（`inert` 让它们此刻不可点，见 App.svelte）。
   *
   * ## 内容只有三件事
   *
   * 品牌（左侧） / 新建（弹窗） / 最近打开的工程（封面 + 列表）。**没有说明文案**：
   * 没工程的时候能做的事就这几件，多一句解释只是把「从哪开始」变得更模糊。
   * 「导入工程」「载入演示」不在这一页 —— rail 的工程面板里一直有它们
   * （`ProjectModal` 的操作页），首页再放一遍是两份入口两份文案。
   *
   * ## 动效
   *
   * 这一页刻意不受编辑器那条「只动 opacity / ≤2px 位移」的约束（见
   * `RecentTile.svelte` 的注释）：它不出画面，是摆东西的那张桌子。背景跟着指针
   * 做几十像素的视差，封面卡各自倾斜。`theme.motionEnabled` 与系统
   * `prefers-reduced-motion` 都会把它整个关掉。
   */
  import Brand from './Brand.svelte';
  import RecentTile from './home/RecentTile.svelte';
  import SocialMark from './home/SocialMark.svelte';
  import NewProjectModal from './home/NewProjectModal.svelte';
  import Menu from './controls/Menu.svelte';
  import ConfirmDialog from './ConfirmDialog.svelte';
  import { appState } from './app-state.svelte';
  import { theme } from './theme.svelte';
  import { deleteProjectFromDisk, openRecentProject } from './project-actions';
  import { recentMenuItems } from './recent-menu';
  import type { ProjectRef } from '../project/handles';
  import { coverOf, loadCovers } from './project-cover.svelte';
  import { openExternal } from './external-link';
  import { ago } from './format-time';
  import { tr } from '../i18n/index.svelte';
  import lightBg from '../assets/home/light.png?url';
  import darkBg from '../assets/home/dark.png?url';

  const GITHUB = 'https://github.com/OxygenNine/artmatic';
  const BILIBILI = 'https://space.bilibili.com/159146024';

  let newOpen = $state(false);
  let expanded = $state(false);

  /** 右键菜单的位置与目标条目。`null` = 没开。 */
  let ctx = $state<{ ref: ProjectRef; x: number; y: number } | null>(null);
  /** 等待二次确认的删除目标。 */
  let pendingDelete = $state<ProjectRef | null>(null);

  function openMenu(e: MouseEvent, ref: ProjectRef): void {
    e.preventDefault();
    // 键盘的菜单键也会派发 contextmenu，但坐标是 0/0 —— 退到元素自己的位置。
    const box = (e.currentTarget as HTMLElement | null)?.getBoundingClientRect();
    ctx = {
      ref,
      x: e.clientX || box?.left || 0,
      y: e.clientY || box?.top || 0,
    };
  }

  /** 前 3 份用封面卡，其余是列表行（见 recents 的注释）。 */
  const CARDS = 3;
  /** 列表默认只铺 4 行：再多就把「新建」推到要滚动才看得见的地方。 */
  const ROWS = 4;

  const recents = $derived(appState.recentProjects);
  const tiles = $derived(recents.slice(0, CARDS));
  const rest = $derived(recents.slice(CARDS));
  const rows = $derived(expanded ? rest : rest.slice(0, ROWS));

  /** 背景图按**族**选（灰度 / 高对比度都是深底），与 logo 取哪份墨色同一个判据。 */
  const backdrop = $derived(theme.family === 'light' ? lightBg : darkBg);

  /* 视差：±11 / ±8 px。再多会让人注意到位移本身，而不是那张背景。 */
  let px = $state(0);
  let py = $state(0);

  function parallax(e: PointerEvent): void {
    if (!theme.motionEnabled) return;
    px = (e.clientX / window.innerWidth - 0.5) * -22;
    py = (e.clientY / window.innerHeight - 0.5) * -16;
  }

  function recenter(): void {
    px = 0;
    py = 0;
  }

  /* 封面缓存在 IndexedDB 里：列表一变就把缺的那几张读进来（幂等）。 */
  $effect(() => {
    void loadCovers(recents.map((r) => r.key));
  });
</script>

<div
  class="home"
  role="main"
  data-family={theme.family}
  data-testid="empty-state"
  onpointermove={parallax}
  onpointerleave={recenter}
>
  <div class="scene" aria-hidden="true">
    <div
      class="scene-img"
      style:background-image={`url("${backdrop}")`}
      style:--px={`${px}px`}
      style:--py={`${py}px`}
    ></div>
  </div>

  <!--
    右键菜单必须留在 `.home` **里面**：`.home` 自己是 `--z-modal` 的层叠上下文，
    菜单的 `--z-menu` 在它外面永远会被它盖住（表现是「菜单出现了但点不动」）。
  -->
  {#if ctx}
    <Menu
      at={{ x: ctx.x, y: ctx.y }}
      head={{ label: ctx.ref.name }}
      items={recentMenuItems(ctx.ref, (ref) => (pendingDelete = ref))}
      testid="recent-menu"
      onclose={() => (ctx = null)}
    />
  {/if}

  <div class="inner">
    <div class="side">
      <div class="brand-block">
        <span class="lockup">
          <!-- largeFrom 抬高是刻意的：首页要的是 rail 上那个 2×2 标记的放大版，
               而不是 3×3 的大标记（那一档在 60px 上糊成一团）。 -->
          <Brand variant="mark" size={62} largeFrom={72} />
          <Brand variant="word" size={40} />
        </span>
        <span class="ver">v{__APP_VERSION__}</span>
      </div>

      <div class="links">
        <a
          class="link"
          href={GITHUB}
          target="_blank"
          rel="noreferrer"
          onclick={(e) => {
            e.preventDefault();
            openExternal(GITHUB);
          }}
        >
          <SocialMark name="github" size={14} />
          <span>GitHub</span>
        </a>
        <a
          class="link"
          href={BILIBILI}
          target="_blank"
          rel="noreferrer"
          onclick={(e) => {
            e.preventDefault();
            openExternal(BILIBILI);
          }}
        >
          <SocialMark name="bilibili" size={14} />
          <span>Bilibili</span>
        </a>
      </div>
    </div>

    <div class="main">
      <section class="new-block">
        <h2>{tr('app.newProject')}</h2>
        <!-- 与「最近的工程」共用同一个三列网格：新建卡与封面卡必须同宽，
             否则第一眼就是两张对不齐的卡片（数值对齐靠布局，不靠写死的 px）。 -->
        <div class="cards">
          <button
            type="button"
            class="new-card"
            aria-label={tr('app.newProject')}
            data-testid="empty-new"
            disabled={appState.projectBusy}
            onclick={() => (newOpen = true)}
          >
            <svg viewBox="0 0 24 24" width="26" height="26" aria-hidden="true">
              <path d="M12 5v14M5 12h14" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" />
            </svg>
          </button>
        </div>
      </section>

      {#if tiles.length > 0 || rest.length > 0}
        <section class="recent-block" data-testid="empty-recent">
          <h2>{tr('app.recentProjects')}</h2>

          {#if tiles.length > 0}
            <div class="cards">
              {#each tiles as r, i (r.key)}
                <RecentTile
                  name={r.name}
                  time={ago(r.openedAt)}
                  cover={coverOf(r.key)}
                  index={i}
                  disabled={appState.projectBusy}
                  onopen={() => void openRecentProject(r)}
                  onmenu={(e) => openMenu(e, r)}
                />
              {/each}
            </div>
          {/if}

          {#if rest.length > 0}
            <div class="rows">
              {#each rows as r (r.key)}
                <button
                  type="button"
                  class="row"
                  data-testid="empty-recent-item"
                  disabled={appState.projectBusy}
                  onclick={() => void openRecentProject(r)}
                  oncontextmenu={(e) => openMenu(e, r)}
                >
                  <svg
                    class="folder"
                    viewBox="0 0 24 24"
                    width="15"
                    height="15"
                    fill="none"
                    stroke="currentColor"
                    stroke-width="1.6"
                    stroke-linejoin="round"
                    aria-hidden="true"
                  >
                    <path d="M3 6.5A1.5 1.5 0 0 1 4.5 5h4l2 2.5h9A1.5 1.5 0 0 1 21 9v9a1.5 1.5 0 0 1-1.5 1.5h-15A1.5 1.5 0 0 1 3 18z" />
                  </svg>
                  <span class="nm">{r.name}</span>
                  <span class="meta">{tr('app.homeProjectMeta', {
                    n: r.assetCount ?? 0,
                    ago: ago(r.openedAt),
                  })}</span>
                </button>
              {/each}

              {#if rest.length > rows.length}
                <button type="button" class="more" data-testid="empty-view-all" onclick={() => (expanded = true)}>
                  {tr('app.homeViewAll')}
                </button>
              {/if}
            </div>
          {/if}
        </section>
      {/if}
    </div>
  </div>
</div>

{#if newOpen}
  <NewProjectModal onclose={() => (newOpen = false)} />
{/if}

{#if pendingDelete}
  <ConfirmDialog
    title={tr('proj.deleteTitle')}
    message={tr(pendingDelete.path ? 'proj.deleteBodyPath' : 'proj.deleteBody', {
      name: pendingDelete.name,
    })}
    confirmLabel={tr('proj.menuDelete')}
    danger
    testid="confirm-delete-project"
    onconfirm={() => {
      const ref = pendingDelete;
      pendingDelete = null;
      if (ref) void deleteProjectFromDisk(ref);
    }}
    oncancel={() => (pendingDelete = null)}
  />
{/if}

<style>
  /*
   * 只盖内容区：左边留 `--rail-w`、上面留顶栏、下面留底栏。
   * 用 token 而不是算出来的像素 —— 那三处的高度都在 tokens.ts 里。
   */
  .home {
    position: fixed;
    left: var(--rail-w);
    top: var(--topbar-h);
    right: 0;
    bottom: var(--statusbar-h);
    z-index: var(--z-modal);
    overflow: auto;
    background: var(--surface-0);
    animation: home-in 240ms var(--motion-ease) backwards;
  }

  /*
   * 背景。`inset: -4%` 是给位移留的余量：图片平移时左右不能露出底色。
   *
   * 原图是**没有渐变遮罩**的那一份（渐变压进位图再经 WebP 压缩会出现可见的
   * 色阶跳变，看起来像裁切出了断层），渐变改由 `.scene::after` 用 CSS 画 ——
   * 合成器出的渐变是连续的，且不占位图体积。
   */
  .scene {
    position: absolute;
    inset: 0;
    overflow: hidden;
    pointer-events: none;
  }
  .scene-img {
    position: absolute;
    inset: -4%;
    background-position: center;
    background-size: cover;
    /* 只做位移，不做缩放 / 透视：这一层只是「光比界面慢半拍」，多余变换只会多一次采样。 */
    transform: translate3d(var(--px, 0), var(--py, 0), 0);
    /* 比指针事件慢半拍：跟手会显得廉价，滞后一点才像「光在动」。 */
    transition: transform 700ms cubic-bezier(0.2, 0.7, 0.2, 1);
    will-change: transform;
  }
  /*
   * 顶部压深：这是原图里被压出跳变的那一段，现在由 CSS 渐变承担。
   * 两个色标都是「到 0 就再也不参与」的收尾，所以整条曲线没有台阶。
   */
  .scene::after {
    content: '';
    position: absolute;
    inset: 0;
    background: linear-gradient(90deg, var(--surface-0) 20%, transparent 75%)
  }
  .inner {
    position: relative;
    display: grid;
    grid-template-columns: minmax(200px, 0.82fr) minmax(0, 1.3fr);
    gap: clamp(40px, 7vw, 104px);
    width: min(1120px, 100%);
    min-height: 100%;
    margin: 0 auto;
    padding: clamp(36px, 6vh, 62px) clamp(28px, 4vw, 56px) 28px;
  }

  .side {
    display: grid;
    grid-template-rows: 1fr auto;
    min-height: 100%;
  }
  .brand-block {
    display: flex;
    flex-direction: column;
    gap: 10px;
    align-self: center;
    animation: side-in 420ms var(--motion-ease) backwards;
  }
  .lockup {
    display: flex;
    align-items: center;
    gap: 18px;
    color: var(--text-primary);
  }
  .ver {
    padding-left: 2px;
    color: var(--text-muted);
    font-size: var(--fs-md);
    font-variant-numeric: tabular-nums;
  }

  .links {
    display: flex;
    align-items: center;
    gap: var(--sp-6);
    animation: side-in 420ms var(--motion-ease) 80ms backwards;
  }
  .link {
    display: inline-flex;
    align-items: center;
    gap: var(--sp-3);
    color: var(--text-muted);
    font-size: var(--fs-md);
    text-decoration: none;
    transition: color var(--motion-duration-hover) var(--motion-ease);
  }
  .link:hover {
    color: var(--text-primary);
  }

  .main {
    display: flex;
    flex-direction: column;
    justify-content: center;
    gap: clamp(22px, 4vh, 36px);
    min-width: 0;
    animation: main-in 460ms var(--motion-ease) 60ms backwards;
  }

  h2 {
    margin: 0;
    color: var(--text-primary);
    font-size: var(--fs-md);
    font-weight: 600;
    letter-spacing: 0.02em;
  }

  /* ------------------------------------------------------------ 新建 */
  .new-block {
    display: flex;
    flex-direction: column;
    gap: var(--sp-4);
  }
  .new-card {
    display: grid;
    place-items: center;
    /* 宽度由 `.cards` 的网格给：与封面卡同宽是布局保证，不是两个数字凑巧相等。 */
    grid-column: 1;
    width: 100%;
    aspect-ratio: 16 / 9;
    background: var(--surface-3);
    border: 1px solid var(--border);
    border-radius: var(--radius-md);
    color: var(--text-secondary);
    transition:
      color var(--motion-duration-hover) var(--motion-ease),
      border-color var(--motion-duration-hover) var(--motion-ease),
      background-color var(--motion-duration-hover) var(--motion-ease),
      transform 220ms var(--motion-ease);
  }
  .new-card:hover:not(:disabled) {
    background: var(--surface-hover);
    border-color: var(--accent);
    color: var(--text-primary);
    transform: translateY(-2px);
  }
  .new-card:disabled {
    opacity: 0.5;
    cursor: default;
  }

  /* ------------------------------------------------------------ 最近 */
  .recent-block {
    display: flex;
    flex-direction: column;
    gap: var(--sp-4);
    min-width: 0;
  }
  .cards {
    display: grid;
    grid-template-columns: repeat(3, minmax(0, 1fr));
    gap: var(--sp-6);
    min-width: 0;
  }

  .rows {
    display: flex;
    flex-direction: column;
    gap: 1px;
    margin-top: var(--sp-1);
  }
  .row {
    display: flex;
    align-items: center;
    gap: var(--sp-4);
    height: 30px;
    margin: 0 calc(var(--sp-3) * -1);
    padding: 0 var(--sp-3);
    background: transparent;
    border: none;
    border-radius: var(--radius-sm);
    color: var(--text-secondary);
    font-size: var(--fs-md);
    text-align: left;
    cursor: pointer;
    transition:
      background var(--motion-duration-hover) var(--motion-ease),
      color var(--motion-duration-hover) var(--motion-ease);
  }
  .row:hover:not(:disabled) {
    background: var(--surface-hover);
    color: var(--text-primary);
  }
  .row:disabled {
    opacity: 0.5;
    cursor: default;
  }
  .folder {
    flex-shrink: 0;
    color: var(--text-muted);
  }
  .nm {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .meta {
    flex-shrink: 0;
    color: var(--text-muted);
    font-size: var(--fs-sm);
    white-space: nowrap;
  }

  .more {
    align-self: flex-end;
    margin-top: var(--sp-3);
    padding: 0;
    background: none;
    border: none;
    color: var(--text-muted);
    font-size: var(--fs-sm);
    cursor: pointer;
    transition: color var(--motion-duration-hover) var(--motion-ease);
  }
  .more:hover {
    color: var(--text-primary);
  }

  @keyframes home-in {
    from {
      opacity: 0;
    }
    to {
      opacity: 1;
    }
  }
  @keyframes side-in {
    from {
      opacity: 0;
      transform: translateY(12px);
    }
    to {
      opacity: 1;
      transform: none;
    }
  }
  @keyframes main-in {
    from {
      opacity: 0;
      transform: translateY(16px);
    }
    to {
      opacity: 1;
      transform: none;
    }
  }

  /* 窗口窄到放不下两列时改成上下排：首页在 1024 宽的窗口里也得成立。 */
  @media (max-width: 860px) {
    .inner {
      grid-template-columns: minmax(0, 1fr);
      gap: var(--sp-6);
    }
    .side {
      grid-template-rows: auto auto;
      gap: var(--sp-6);
    }
    .brand-block {
      align-self: start;
    }
    .cards {
      grid-template-columns: repeat(2, minmax(0, 1fr));
    }
  }

  @media (prefers-reduced-motion: reduce) {
    .home,
    .brand-block,
    .links,
    .main {
      animation: none;
    }
    .scene-img,
    .new-card,
    .row,
    .more,
    .link {
      transition: none;
    }
  }
</style>
