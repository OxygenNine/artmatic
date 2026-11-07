<script lang="ts">
  /**
   * TopBar — 顶栏，打开的**工程**的选项卡。
   *
   * tab = 一份工程，不是一个网页里的「页面」。「时间轴 / 排版编辑」是工程
   * **内部**的视图，跟着工程走：切回某份工程时，它上次停在哪个视图就回到哪里。
   * 这样做的直接好处是「一个网页里同时开几份工程」变成免费的 ——
   * 切换工程 = 换一个 `activeProjectId`（见 app-state 的 OpenProject）。
   *
   * 这里是纯渲染 + 少量动作转发，不持有任何状态：「哪份工程是当前」
   * 只有 `appState.activeProjectId` 说了算。
   */
  import Icon from './Icon.svelte';
  import Brand from './Brand.svelte';
  import ConfirmDialog from './ConfirmDialog.svelte';
  import { appState } from './app-state.svelte';
  import { newProject } from './project-actions';
  import { reorder } from './drag-reorder';
  import { tip } from './tip';
  import { tr } from '../i18n/index.svelte';

  /** 待确认的关闭动作；非 null 时弹确认框。 */
  let pendingClose = $state<{ id: string; name: string } | null>(null);

  /**
   * 选项卡数据。
   *
   * ⚠️ **必须走 `$derived.by` 并显式依赖 `appState.version`。**
   *
   * `dirty` 要读 `p.store.version`，而 `ProjectStore` 是**类实例** ——
   * Svelte 的 `$state` 只深代理普通对象，类实例的字段读取**不可追踪**。
   * 所以直接写在模板里（`{@const dirty = p.savedVersion !== p.store.version}`）
   * 的表现是：只有「数组结构变化」（新开 / 关闭工程）才会重算，于是
   * 「保存一次之后圆点就再也不出现」。
   *
   * 这是 AGENTS §7 那条硬规则的又一形态：**模板里凡是读嵌套对象字段的地方，
   * 来源派生必须换引用**（这里是 `map` 出新对象 + 显式 `void` 那个可追踪的信号）。
   */
  const tabs = $derived.by(() => {
    void appState.version; // 当前工程的改动靠它触发重算
    void appState.activeProjectId; // 切工程时也要重算
    return appState.projects.map((p, i) => ({
      i,
      id: p.id,
      name: p.store.project.name || tr('proj.unnamed'),
      dirty: p.savedVersion !== p.store.version,
      inTypo: p.view.kind === 'typography',
      inGrade: p.view.kind === 'grade',
      inParticles: p.view.kind === 'particles',
      active: p.id === appState.activeProjectId,
    }));
  });

  /**
   * 点关闭。脏的**弹确认**而不是拒绝 —— 拒绝之后用户既关不掉、
   * 也不知道下一步该干什么（他常常只是想丢掉这次试验）。
   */
  function requestClose(id: string, name: string): void {
    const r = appState.closeProject(id);
    if (r === 'dirty') pendingClose = { id, name };
    else if (r === 'missing') appState.flash(tr('app.projectGone'), 'error');
  }

  function confirmClose(): void {
    const target = pendingClose;
    pendingClose = null;
    if (target) appState.closeProject(target.id, { force: true });
  }
</script>

<header class="topbar" data-testid="topbar">
  <span class="app-mark">
    <Brand variant="word" size={15} />
  </span>

  <!--
    没有工程时不画选项卡区（含那个「+」）：首页已经在问「要不要新建一份」，
    顶栏再放一个按不动的加号只是噪声 —— 此刻整条 shell 是 `inert` 的。
  -->
  {#if appState.hasProject}
    <div
      class="tabs"
      role="tablist"
      aria-label={tr('app.openProjects')}
      use:reorder={{
        axis: 'x',
        itemSelector: '.tab',
        onReorder: (from, to) => appState.moveProject(from, to),
      }}
    >
      {#each tabs as t (t.id)}
        <div
          class="tab"
          role="tab"
          aria-selected={t.active}
          data-active={t.active ? 'true' : undefined}
        >
          <button
            type="button"
            class="tab-main"
            data-testid={`project-tab-${t.i}`}
            onclick={() => appState.activateProject(t.id)}
          >
            <!--
              视图标记：排版页用 A 字，调色页用色轮。它回答的是「这份工程现在
              停在哪一页」—— 与名字并排，不看顶栏也能知道自己刚才在干什么。
            -->
            {#if t.inTypo}
              <Icon name="type" size={11} />
              <span class="sep">·</span>
            {:else if t.inGrade}
              <span class="tab-view" data-testid={`project-tab-grade-${t.i}`}>
                <Icon name="palette" size={11} />
              </span>
              <span class="sep">·</span>
            {:else if t.inParticles}
              <span class="tab-view" data-testid={`project-tab-particles-${t.i}`}>
                <Icon name="sparkles" size={11} />
              </span>
              <span class="sep">·</span>
            {/if}
            <span class="tab-name">{t.name}</span>
            {#if t.dirty}
              <span class="dot" title={tr('app.unsavedChanges')} data-testid={`project-tab-dirty-${t.i}`}></span>
            {/if}
          </button>

          {#if t.inTypo || t.inGrade || t.inParticles}
            <!-- 回到时间轴。用箭头而不是 ×：同一行里还有「关闭工程」，
                 两个 × 会让人分不清哪个是哪个。 -->
            <button
              type="button"
              class="tab-mini"
              aria-label={tr('app.backToTimeline')}
              data-testid={`project-tab-timeline-${t.i}`}
              onclick={() =>
                t.inTypo
                  ? appState.closeTypographyView(t.id)
                  : t.inParticles
                    ? appState.closeParticleEditor(t.id)
                    : appState.closeGradeEditor(t.id)}
            >
              <Icon name="arrow-left" size={11} />
            </button>
          {/if}

          <button
            type="button"
            class="tab-mini"
            aria-label={tr('app.closeProjectTab', { name: t.name })}
            data-testid={`project-tab-close-${t.i}`}
            onclick={() => requestClose(t.id, t.name)}
          >
            <Icon name="x" size={11} />
          </button>
        </div>
      {/each}

      <button
        type="button"
        class="ic-btn sm new-project"
        aria-label={tr('app.newProject')}
        data-testid="topbar-new-project"
        use:tip={{ text: tr('app.newProjectTip') }}
        onclick={() => void newProject(false)}
      >
        <Icon name="plus" size={12} />
      </button>
    </div>
  {/if}
</header>

{#if pendingClose}
  <ConfirmDialog
    title={tr('app.discardTitle')}
    message={tr('app.discardMessage', { name: pendingClose.name })}
    confirmLabel={tr('app.discardConfirm')}
    cancelLabel={tr('app.back')}
    danger
    testid="confirm-close-project"
    onconfirm={confirmClose}
    oncancel={() => (pendingClose = null)}
  />
{/if}

<style>
  .topbar {
    display: flex;
    align-items: center;
    gap: var(--sp-5);
    height: var(--topbar-h);
    padding: 0 var(--sp-3);
    background: var(--bar-bg);
    border-bottom: 1px solid var(--bar-border);
  }
  /*
   * 桌面壳：顶栏**就是**窗口标题栏（`titleBarStyle: 'hidden'`，原生那条已经没了）。
   *
   * 两件事只能在这里做：
   *   · 右侧让开系统画的三个窗口按钮。宽度是 `titlebar.ts` 量的，写死 px 会在
   *     高 DPI 或最大化时错位；
   *   · 让空处能拖窗口。
   *
   * 只认 `data-wco='on'`：浏览器里给顶栏加 `-webkit-app-region: drag` 等于把它
   * 变成点不到、选不中的死区。
   */
  :global(:root[data-wco='on']) .topbar {
    -webkit-app-region: drag;
    padding-right: calc(var(--wco-w, 0px) + var(--sp-3));
  }
  /*
   * 按钮与选项卡必须退出拖拽区，否则点不动（拖拽区会吞掉点击与指针事件）。
   * 选项卡尤其重要：它自己要用指针拖动排序。
   */
  :global(:root[data-wco='on']) .topbar button,
  :global(:root[data-wco='on']) .tab {
    -webkit-app-region: no-drag;
  }
  .app-mark {
    display: inline-flex;
    align-items: center;
    padding-right: var(--sp-4);
    /* 字标是品牌标记，用正文色读得清；紫色部分由 SVG 内的 var(--accent) 决定。 */
    color: var(--text-primary);
  }
  .tabs {
    display: flex;
    align-items: stretch;
    gap: var(--sp-1);
    height: 100%;
    min-width: 0;
  }
  .tab {
    display: inline-flex;
    align-items: center;
    max-width: 240px;
    border-bottom: 2px solid transparent;
    color: var(--text-muted);
    /* 拖曳排序要能整体平移；不设 transform 过渡，否则跟随指针会拖尾。 */
    will-change: transform;
  }
  /* 拖曳中的那一项浮到最上层；其它项靠 transform 滑开让位。 */
  .tabs :global(.is-dragging) {
    opacity: 0.9;
  }
  .tabs :global(.is-reordering) {
    cursor: grabbing;
  }
  /* 当前选项卡是「选中的东西」——主题色在此处出现是合规的少数场景之一。 */
  .tab[data-active='true'] {
    color: var(--text-primary);
    border-bottom-color: var(--accent);
  }
  .tab:hover {
    color: var(--text-primary);
  }
  .tab-main {
    display: inline-flex;
    align-items: center;
    gap: var(--sp-2);
    min-width: 0;
    height: 100%;
    padding: 0 var(--sp-2) 0 var(--sp-4);
    background: transparent;
    border: none;
    border-radius: 0;
    color: inherit;
    font-size: var(--fs-sm);
    cursor: pointer;
  }
  .tab-mini {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 16px;
    height: 16px;
    padding: 0;
    background: transparent;
    border: none;
    border-radius: var(--radius-sm);
    color: var(--text-muted);
    cursor: pointer;
  }
  .tab-mini:hover {
    color: var(--text-primary);
  }
  /* 最后一个小按钮与 tab 右沿留一点空，否则紧贴下一个 tab。 */
  .tab > .tab-mini:last-child {
    margin-right: var(--sp-2);
  }
  .tab-name {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .sep {
    color: var(--text-muted);
  }
  /* 视图标记的包壳：只为了让 E2E 能指到「这个 tab 在调色页」。 */
  .tab-view {
    display: inline-flex;
    align-items: center;
  }
  /* 未保存标记。用一个小圆点：它要能在 12px 的字号旁边被看见，
     又不能抢过标题本身。 */
  .dot {
    flex-shrink: 0;
    width: 5px;
    height: 5px;
    border-radius: 50%;
    background: var(--accent);
  }
  /*
   * 加号的垂直居中。
   *
   * `.tabs` 是 `align-items: stretch`（那是给 `.tab` 用的 —— 它的
   * border-bottom 要贴到顶栏下沿）。而 stretch 对**有确定高度**的子项
   * 等价于 `flex-start`，于是 `.ic-btn.sm` 一直顶着上沿。
   * 显式 `align-self` 把它摘出这个规则。
   */
  .new-project {
    align-self: center;
    margin-left: var(--sp-2);
  }
</style>
