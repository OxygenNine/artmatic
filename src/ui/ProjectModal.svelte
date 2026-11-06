<script lang="ts">
  /**
   * ProjectModal — 「工程」面板（Rail 的 folder 图标）。
   *
   * 四页：概览 / 清理 / 操作 / 最近。
   *
   * ## 为什么分页
   *
   * 以前是自上而下的一长条（状态 → 占用 → 未使用素材 → 六个动作 → 最近工程）。
   * 那四块服务的时刻完全不同：看一眼状态、回收磁盘空间、对工程做个动作、
   * 回到上次那份。混在一列里时，「最近工程」越长，动作与状态就被推得越远。
   * 分页之后每页只回答一个问题。
   *
   * 范式与 `SettingsModal` 同一套：`controls/SideNav` 固定在左，
   * 右列自己滚动，modal 高度固定（切页不跳高度）。
   *
   * ## 动作为什么是竖排列表
   *
   * 六个动作的标签长度差一倍（「新建空白」/「导入工程包…」）。排成一行时
   * 宽度会被最长那条撑开，剩下的按钮各宽各的 —— 读起来像一排等宽标签，
   * 而不是「几个可以按的东西」。竖排一行一个。
   *
   * 说明只挂在「打包 / 导入」两条下面：这两个动的是磁盘上的文件格式，
   * 光看标签猜不出会写出什么；其余动作看标签就够，不必每条都挂一段话。
   *
   * ## 画幅与帧率不在这里
   *
   * 它们已经搬进「设置 → 当前工程」。这份面板的职责是「这份工程现在是什么
   * 状态、能对它做什么」，改参数的入口集中在设置里 —— 同一个值有两个编辑
   * 入口迟早会漂移。
   */
  import Modal from './controls/Modal.svelte';
  import SideNav from './controls/SideNav.svelte';
  import Button from './controls/Button.svelte';
  import ConfirmDialog from './ConfirmDialog.svelte';
  import Menu from './controls/Menu.svelte';
  import Icon from './Icon.svelte';
  import { recentMenuItems } from './recent-menu';
  import type { ProjectRef } from '../project/handles';
  import type { IconName } from './icons';
  import { appState } from './app-state.svelte';
  import { tr, type MessageKey } from '../i18n/index.svelte';
  import { formatBytes } from '../core/format';
  import { ago } from './format-time';
  import {
    cleanupOrphanFiles,
    clearProjectTrash,
    deleteAllUnused,
    deleteProjectFromDisk,
    deleteUnusedAsset,
    getProjectUsage,
    newProject,
    openProjectPicker,
    openRecentProject,
    restoreUnusedAsset,
    saveProjectAs,
    trashAllUnused,
    trashUnusedAsset,
    type ProjectUsage,
  } from './project-actions';
  import { importProjectPackage, packProjectNow } from './package-actions';

  interface Props {
    onclose: () => void;
  }
  const { onclose }: Props = $props();

  type Section = 'overview' | 'cleanup' | 'actions' | 'recent';
  /**
   * 零工程时也开得起来（rail 上这一颗不随「有没有工程」禁用）：
   * 那是「导入工程包 / 打开 / 载入演示」唯一的入口。但这时**概览与清理不列出**——
   * 那两页描述的是「当前这份工程」，而没有工程时它只是一个随即丢弃的占位对象。
   */
  let section = $state<Section>(appState.hasProject ? 'overview' : 'actions');

  const SECTIONS: {
    id: Section;
    labelKey:
      | 'app.projectNavOverview'
      | 'app.projectNavCleanup'
      | 'app.projectNavActions'
      | 'app.projectNavRecent';
  }[] = [
    { id: 'overview', labelKey: 'app.projectNavOverview' },
    { id: 'cleanup', labelKey: 'app.projectNavCleanup' },
    { id: 'actions', labelKey: 'app.projectNavActions' },
    { id: 'recent', labelKey: 'app.projectNavRecent' },
  ];
  // 文案在调用处解析：模块级表里直接调 tr() 会把语言冻结在导入那一刻。
  const navItems = $derived(
    SECTIONS.filter(
      (s) => appState.hasProject || s.id === 'actions' || s.id === 'recent',
    ).map((s) => ({ id: s.id, label: tr(s.labelKey) })),
  );

  /* ------------------------------------------------------------ 概览 */

  /** 当前工程的素材计数。`void appState.version` 让它在工程改动时重算。 */
  const assetInfo = $derived.by(() => {
    void appState.version;
    return { count: appState.assets.ids().length, bytes: appState.assets.totalBytes() };
  });

  /* ---------------------------------------------------- 未使用素材 */

  /**
   * 已从工程移除、但字节文件还在的素材。
   *
   * 它是「移除 ≠ 销毁」唯一可操作的出口：没有这一段，`assets/` 里的文件
   * 就只是磁盘上的一堆垃圾，用户既找不到也删不掉。
   */
  const unused = $derived.by(() => {
    void appState.version;
    const store = appState.assets;
    return store.retainedIds().map((id) => ({
      id,
      name: store.retainedInput(id)?.name ?? id,
      bytes: store.retainedSize(id) ?? 0,
    }));
  });
  const unusedBytes = $derived(unused.reduce((n, u) => n + u.bytes, 0));

  let pendingUnused = $state<{ id: string; name: string; action: 'trash' | 'delete' } | null>(null);

  /* ------------------------------------------------ 最近工程的右键菜单 */

  /** 与首页共用一份菜单定义（`recent-menu.ts`）：三条动作必须一字不差。 */
  let recentCtx = $state<{ ref: ProjectRef; x: number; y: number } | null>(null);
  let pendingDeleteRecent = $state<ProjectRef | null>(null);

  function openRecentMenu(e: MouseEvent, ref: ProjectRef): void {
    e.preventDefault();
    const box = (e.currentTarget as HTMLElement | null)?.getBoundingClientRect();
    recentCtx = { ref, x: e.clientX || box?.left || 0, y: e.clientY || box?.top || 0 };
  }

  /* ---------------------------------------------------- 占用与批量清理 */

  let usage = $state<ProjectUsage | null>(null);
  let pendingCleanup = $state<'trash-all' | 'delete-all' | 'clear-trash' | 'orphans' | null>(null);

  async function refreshUsage(): Promise<void> {
    if (!appState.hasProject) {
      usage = null;
      return;
    }
    usage = await getProjectUsage();
  }

  // 面板开着时跟着版本刷新：清理动作不改 rev 的那几条，动作结束后也会手动调一次。
  $effect(() => {
    void appState.version;
    void appState.projectDir;
    void refreshUsage();
  });

  async function runCleanup(): Promise<void> {
    const action = pendingCleanup;
    pendingCleanup = null;
    if (!action) return;
    if (action === 'trash-all') {
      const n = await trashAllUnused();
      if (n) appState.flash(tr('app.trashAllDone', { n }), 'success');
    } else if (action === 'delete-all') {
      const n = await deleteAllUnused();
      if (n) appState.flash(tr('app.deleteAllDone', { n }), 'success');
    } else if (action === 'clear-trash') {
      await clearProjectTrash();
    } else {
      const n = await cleanupOrphanFiles();
      if (n) appState.flash(tr('app.orphansDone', { n }), 'success');
    }
    await refreshUsage();
  }

  const cleanupCopy = $derived.by(() => {
    const action = pendingCleanup;
    if (!action) return null;
    if (action === 'trash-all') {
      return {
        title: tr('app.trashAll'),
        message: tr('app.trashAllConfirm', { n: unused.length, size: formatBytes(unusedBytes) }),
        label: tr('app.trashAll'),
      };
    }
    if (action === 'delete-all') {
      return {
        title: tr('app.deleteAll'),
        message: tr('app.deleteAllConfirm', { n: unused.length, size: formatBytes(unusedBytes) }),
        label: tr('app.deleteAll'),
      };
    }
    if (action === 'clear-trash') {
      return {
        title: tr('app.clearTrash'),
        message: tr('app.clearTrashConfirm', {
          n: usage?.trashCount ?? 0,
          size: formatBytes(usage?.trashBytes ?? 0),
        }),
        label: tr('app.clearTrash'),
      };
    }
    return {
      title: tr('app.cleanupOrphans'),
      message: tr('app.cleanupOrphansConfirm', {
        n: usage?.orphanCount ?? 0,
        size: formatBytes(usage?.orphanBytes ?? 0),
      }),
      label: tr('app.cleanupOrphans'),
    };
  });

  async function restoreUnused(u: { id: string; name: string }): Promise<void> {
    if (await restoreUnusedAsset(u.id)) {
      appState.flash(tr('app.unusedRestored', { name: u.name }), 'success');
    }
  }

  async function confirmUnused(): Promise<void> {
    const p = pendingUnused;
    pendingUnused = null;
    if (!p) return;
    const ok = p.action === 'trash' ? await trashUnusedAsset(p.id) : await deleteUnusedAsset(p.id);
    if (ok) {
      appState.flash(
        tr(p.action === 'trash' ? 'app.unusedTrashed' : 'app.unusedDeleted', { name: p.name }),
        'success',
      );
    } else {
      appState.flash(tr('app.unusedFailed', { name: p.name }), 'error');
    }
    await refreshUsage();
  }

  /**
   * 三个可清的东西都空 → 说一句「没得清」，而不是留一片没有任何解释的白。
   * `usage` 还没读回来时不算空（否则会闪一下这句）。
   */
  const nothingToClean = $derived(
    unused.length === 0 &&
      usage !== null &&
      usage.trashCount === 0 &&
      usage.orphanCount === 0,
  );

  /* ------------------------------------------------------------ 操作 */

  type ActionId = 'new' | 'demo' | 'open' | 'save-as' | 'pack' | 'import';

  /**
   * 动作清单。`descKey` 可选：只有「打包 / 导入」两条带说明 ——
   * 它们动的是磁盘上的文件格式，不看说明分不清会写出什么；
   * 其余动作看标签就够，不必每条都挂一段话。
   */
  const ACTIONS: {
    id: ActionId;
    icon: IconName;
    testid: string;
    nameKey: MessageKey;
    descKey?: MessageKey;
    /** 要一份**真**工程才能做：零工程时禁用（占位工程不能落盘）。 */
    needsProject?: boolean;
  }[] = [
    {
      id: 'new',
      icon: 'file-plus',
      testid: 'project-new',
      nameKey: 'app.newBlank',
    },
    {
      id: 'demo',
      icon: 'sparkles',
      testid: 'project-demo',
      nameKey: 'app.loadDemo',
    },
    {
      id: 'open',
      icon: 'folder-open',
      testid: 'project-open',
      nameKey: 'app.openProjectEllipsis',
    },
    {
      id: 'save-as',
      icon: 'hard-drive',
      testid: 'project-save-as',
      nameKey: 'app.saveAsEllipsis',
      needsProject: true,
    },
    {
      id: 'pack',
      icon: 'archive',
      testid: 'project-pack',
      nameKey: 'app.pack',
      descKey: 'app.actionPackDesc',
      needsProject: true,
    },
    {
      id: 'import',
      icon: 'package-open',
      testid: 'project-import-pack',
      nameKey: 'app.importPack',
      descKey: 'app.actionImportDesc',
    },
  ];

  function runAction(id: ActionId): void {
    if (appState.projectBusy) return;
    switch (id) {
      // 新建 = 再开一份并切过去：面板说的「当前工程」已经变了，留着它就过时了。
      case 'new':
        void newProject(false);
        onclose();
        break;
      case 'demo':
        void newProject(true);
        onclose();
        break;
      case 'open':
        void openProjectPicker();
        break;
      case 'save-as':
        void saveProjectAs();
        break;
      case 'pack':
        void packProjectNow();
        break;
      case 'import':
        void importProjectPackage();
        break;
    }
  }
</script>

<Modal title={tr('app.project')} testid="modal-project" width="tall" flushBody {onclose}>
  <div class="pk">
    <SideNav
      items={navItems}
      value={section}
      label={tr('app.project')}
      testidPrefix="project-nav"
      onselect={(id) => (section = id)}
    />

    <div class="pk-pane" data-testid={`project-pane-${section}`}>
      {#if section === 'overview'}
        <div class="kv">
          <span>{tr('app.name')}</span>
          <span data-testid="project-name">{appState.projectName}</span>
          <span>{tr('app.location')}</span>
          <span data-testid="project-location">
            {tr(appState.projectDir ? 'app.dirConnected' : 'app.dirNotChosen')}
          </span>
          <span>{tr('app.status')}</span>
          <span data-testid="project-dirty">
            {#if appState.projectDirty}
              <span class="dirty">{tr('app.unsavedChanges')}</span>
            {:else if appState.savedAt}
              {tr('app.savedAgo', { ago: ago(appState.savedAt) })}
            {:else}
              {tr('app.notSavedYet')}
            {/if}
          </span>
          <span>{tr('app.assets')}</span>
          <span class="mono" data-testid="project-assets">
            {tr('app.assetCount', { n: assetInfo.count, size: formatBytes(assetInfo.bytes) })}
          </span>
        </div>

        <!--
          审计结果放在状态下面：它是「这份工程现在有没有缺口」，与脏标记同类。
          处理动作（重选文件）还没有，所以这里只报告 —— 见根 AGENTS §7。
        -->
        {#if appState.projectIssues.length}
          <h3 class="gap">{tr('app.assetAudit')}</h3>
          {#each appState.projectIssues as issue (issue.kind + ':' + issue.assetId + ':' + issue.path)}
            <div class="issue" class:err={issue.severity === 'error'}>
              <Icon name={issue.severity === 'error' ? 'triangle-alert' : 'info'} size={13} />
              <span>{issue.message}</span>
            </div>
          {/each}
        {/if}

        <!--
          占用：把「工程到底占了多大」摊开。回收站与未跟踪文件也在里面 ——
          它们不在台账里，别处没有任何地方能看到这两个数。
        -->
        <h3 class="gap">{tr('app.storageUsage')}</h3>
        {#if usage}
          <div class="usage">
            <span>{tr('app.usageProject')}</span>
            <span class="mono">{formatBytes(usage.projectBytes)}</span>
            <span>{tr('app.usageUnused')}</span>
            <span class="mono">{formatBytes(usage.unusedBytes)}</span>
            {#if appState.projectDir}
              <span>{tr('app.usageTrash')}</span>
              <span class="mono" data-testid="usage-trash">
                {tr('app.assetCount', { n: usage.trashCount, size: formatBytes(usage.trashBytes) })}
              </span>
              <span>{tr('app.usageOrphans')}</span>
              <span class="mono" data-testid="usage-orphans">
                {tr('app.assetCount', { n: usage.orphanCount, size: formatBytes(usage.orphanBytes) })}
              </span>
            {/if}
          </div>
        {/if}

        <!-- 这句话被三个 <code> 打断，所以按段取词（见语言文件里的注释）。 -->
        <p class="note foot">
          {tr('app.projectHintA')}<code class="mono">project.json</code>{tr('app.projectHintB')}<code
            class="mono">assets.json</code
          >{tr('app.projectHintC')}<code class="mono">assets/</code>{tr('app.projectHintD')}
        </p>
      {:else if section === 'cleanup'}
        {#if !appState.projectDir}
          <p class="note">{tr('app.cleanupNoDir')}</p>
        {/if}

        <!--
          未使用素材：「移除」只是解除关联，文件还在 assets/。
          逐条动作按破坏性递增排列 —— 恢复在最左，彻底删除在最右（红色确认）。
        -->
        {#if unused.length}
          <h3>{tr('app.unusedAssets')}</h3>
          <p class="note">
            {tr('app.unusedAssetsHint', { n: unused.length, size: formatBytes(unusedBytes) })}
          </p>
          {#if unused.length > 1}
            <div class="row wrap">
              {#if appState.projectDir}
                <Button
                  label={tr('app.trashAll')}
                  variant="outline"
                  testid="unused-trash-all"
                  onclick={() => (pendingCleanup = 'trash-all')}
                />
              {/if}
              <Button
                label={tr('app.deleteAll')}
                variant="outline"
                testid="unused-delete-all"
                onclick={() => (pendingCleanup = 'delete-all')}
              />
            </div>
          {/if}
          {#each unused as u (u.id)}
            <div class="unused" data-testid="unused-asset" data-asset-id={u.id}>
              <span class="grow">{u.name}</span>
              <span class="mono dim">{formatBytes(u.bytes)}</span>
              <Button
                label={tr('app.unusedRestore')}
                variant="outline"
                testid="unused-restore"
                onclick={() => void restoreUnused(u)}
              />
              {#if appState.projectDir}
                <Button
                  label={tr('app.unusedTrash')}
                  variant="outline"
                  testid="unused-trash"
                  onclick={() => (pendingUnused = { id: u.id, name: u.name, action: 'trash' })}
                />
              {/if}
              <Button
                label={tr('app.unusedDelete')}
                variant="outline"
                testid="unused-delete"
                onclick={() => (pendingUnused = { id: u.id, name: u.name, action: 'delete' })}
              />
            </div>
          {/each}
        {/if}

        {#if appState.projectDir && (usage?.trashCount ?? 0) > 0}
          <h3 class="gap">{tr('app.usageTrash')}</h3>
          <p class="note">
            {tr('app.cleanupTrashHint', {
              n: usage?.trashCount ?? 0,
              size: formatBytes(usage?.trashBytes ?? 0),
            })}
          </p>
          <Button
            label={tr('app.clearTrash')}
            icon="trash"
            variant="outline"
            testid="trash-clear"
            onclick={() => (pendingCleanup = 'clear-trash')}
          />
        {/if}

        {#if appState.projectDir && (usage?.orphanCount ?? 0) > 0}
          <h3 class="gap">{tr('app.usageOrphans')}</h3>
          <p class="note">
            {tr('app.cleanupOrphansHint', {
              n: usage?.orphanCount ?? 0,
              size: formatBytes(usage?.orphanBytes ?? 0),
            })}
          </p>
          <Button
            label={tr('app.cleanupOrphans')}
            icon="file-x"
            variant="outline"
            testid="orphans-clean"
            onclick={() => (pendingCleanup = 'orphans')}
          />
        {/if}

        {#if appState.projectDir && nothingToClean}
          <p class="note">{tr('app.nothingToClean')}</p>
        {/if}
      {:else if section === 'actions'}
        <!-- 没有 h3：分页名就在左边写着，再抄一遍只是噪声。 -->
        <div class="acts">
          {#each ACTIONS as a (a.id)}
            <button
              type="button"
              class="act"
              data-testid={a.testid}
              disabled={appState.projectBusy || (a.needsProject === true && !appState.hasProject)}
              onclick={() => runAction(a.id)}
            >
              <span class="act-ic"><Icon name={a.icon} size={14} /></span>
              <span class="act-body">
                <span class="act-name">{tr(a.nameKey)}</span>
                <!-- 说明缺席时整条少一行（见 ACTIONS 的 descKey 可选）。 -->
                {#if a.descKey}
                  <span class="act-desc">{tr(a.descKey)}</span>
                {/if}
              </span>
              <span class="act-go"><Icon name="chevron-right" size={12} /></span>
            </button>
          {/each}
        </div>
      {:else}
        {#if appState.recentProjects.length}
          {#each appState.recentProjects as r (r.key)}
            <button
              type="button"
              class="recent"
              data-testid="project-recent"
              disabled={appState.projectBusy}
              onclick={() => void openRecentProject(r)}
              oncontextmenu={(e) => openRecentMenu(e, r)}
            >
              <Icon name="folder" size={13} />
              <span class="grow">{r.name}</span>
              <span class="dim">{tr('app.assetCountShort', { n: r.assetCount ?? 0 })}</span>
              <span class="dim">{ago(r.openedAt)}</span>
            </button>
          {/each}
        {:else}
          <p class="note">{tr('app.noRecentProjects')}</p>
        {/if}
      {/if}
    </div>
  </div>

  <!--
    右键菜单挂在 Modal **内部**：Modal 被 portal 到 body，入口在 `#app` 里的浮层
    （`--z-menu`）永远被它盖住。留在这一层，菜单才和这个面板同属一个层叠上下文。
    （`position: fixed` 不受 `.modal` 的 overflow 裁剪。）
  -->
  {#if recentCtx}
    <Menu
      at={{ x: recentCtx.x, y: recentCtx.y }}
      head={{ label: recentCtx.ref.name }}
      items={recentMenuItems(recentCtx.ref, (ref) => (pendingDeleteRecent = ref))}
      testid="recent-menu"
      onclose={() => (recentCtx = null)}
    />
  {/if}
</Modal>

{#if pendingUnused}
  <ConfirmDialog
    title={tr(pendingUnused.action === 'trash' ? 'app.unusedTrash' : 'app.unusedDelete')}
    message={tr(
      pendingUnused.action === 'trash' ? 'app.unusedTrashConfirm' : 'app.unusedDeleteConfirm',
      { name: pendingUnused.name },
    )}
    confirmLabel={tr(pendingUnused.action === 'trash' ? 'app.unusedTrash' : 'app.unusedDelete')}
    danger
    testid="confirm-unused-asset"
    onconfirm={() => void confirmUnused()}
    oncancel={() => (pendingUnused = null)}
  />
{/if}

{#if cleanupCopy}
  <ConfirmDialog
    title={cleanupCopy.title}
    message={cleanupCopy.message}
    confirmLabel={cleanupCopy.label}
    danger
    testid="confirm-cleanup"
    onconfirm={() => void runCleanup()}
    oncancel={() => (pendingCleanup = null)}
  />
{/if}

{#if pendingDeleteRecent}
  <ConfirmDialog
    title={tr('proj.deleteTitle')}
    message={tr(pendingDeleteRecent.path ? 'proj.deleteBodyPath' : 'proj.deleteBody', {
      name: pendingDeleteRecent.name,
    })}
    confirmLabel={tr('proj.menuDelete')}
    danger
    testid="confirm-delete-project"
    onconfirm={() => {
      const ref = pendingDeleteRecent;
      pendingDeleteRecent = null;
      if (ref) void deleteProjectFromDisk(ref);
    }}
    oncancel={() => (pendingDeleteRecent = null)}
  />
{/if}

<style>
  /* navside 固定宽 + 内容列吃满；两者都必须能各自滚动/裁剪。 */
  .pk {
    display: grid;
    grid-template-columns: 128px minmax(0, 1fr);
    width: 100%;
    min-width: 0;
    min-height: 0;
  }
  .pk-pane {
    min-width: 0;
    min-height: 0;
    padding: var(--sp-5) var(--sp-6);
    overflow-y: auto;
  }
  .pk-pane h3 {
    margin: 0 0 var(--sp-2);
    color: var(--text-muted);
    font-size: var(--fs-xs);
    font-weight: 500;
    letter-spacing: 0.08em;
    text-transform: uppercase;
  }
  .pk-pane h3.gap {
    margin-top: var(--sp-6);
  }

  .kv {
    display: grid;
    grid-template-columns: 88px minmax(0, 1fr);
    gap: var(--sp-2) var(--sp-4);
    font-size: var(--fs-sm);
  }
  .kv > span:nth-child(odd) {
    color: var(--text-muted);
  }
  .kv > span:nth-child(even) {
    color: var(--text-primary);
  }
  /* 未保存用主题色：它是「该做点什么」的提示，不是错误。 */
  .dirty {
    color: var(--accent);
  }

  .mono {
    font-family: var(--font-mono);
  }
  .dim {
    color: var(--text-muted);
  }
  .grow {
    flex: 1;
    min-width: 0;
  }
  .note {
    margin: 0 0 var(--sp-4);
    color: var(--text-muted);
    font-size: var(--fs-xs);
    line-height: 1.55;
  }
  /* 概览最后那句说明：与上面的数字隔开，别让它看起来是「占用」的注脚。 */
  .note.foot {
    margin-top: var(--sp-6);
    font-size: var(--fs-sm);
  }
  code {
    padding: 0 3px;
    background: var(--surface-active);
    border-radius: 3px;
  }

  /* 占用：两列（项目 / 体积），窄面板里也不会挤成一团。 */
  .usage {
    display: grid;
    grid-template-columns: 1fr auto;
    gap: var(--sp-1) var(--sp-3);
    margin-bottom: var(--sp-2);
    color: var(--text-secondary);
    font-size: var(--fs-xs);
  }

  .issue {
    display: flex;
    align-items: flex-start;
    gap: var(--sp-2);
    padding: 3px 0;
    color: var(--text-secondary);
    font-size: var(--fs-sm);
    line-height: 1.45;
  }
  /* 图标跟随严重级上色；文字保持中性，免得整块面板变成一片红。 */
  .issue.err {
    color: var(--text-primary);
  }
  .issue.err > :global(svg) {
    color: var(--danger);
    flex-shrink: 0;
  }

  .row {
    display: flex;
    align-items: center;
    gap: var(--sp-3);
    margin-bottom: var(--sp-3);
  }
  .wrap {
    flex-wrap: wrap;
  }

  /* 未使用素材：一行 = 名字 + 体积 + 三个动作。窄面板里允许换行。 */
  .unused {
    display: flex;
    align-items: center;
    flex-wrap: wrap;
    gap: var(--sp-2);
    padding: var(--sp-1) 0;
    color: var(--text-secondary);
    font-size: var(--fs-sm);
  }

  /* 动作：整行是一个按钮，说明（可缺席）在标签下面。 */
  .acts {
    display: flex;
    flex-direction: column;
    gap: 1px;
  }
  .act {
    display: grid;
    grid-template-columns: 20px minmax(0, 1fr) 14px;
    align-items: center;
    gap: var(--sp-3);
    width: 100%;
    padding: var(--sp-3);
    background: transparent;
    border: none;
    border-radius: var(--radius-sm);
    color: var(--text-primary);
    text-align: left;
    cursor: pointer;
    min-height: 36px;
  }
  .act:hover:not(:disabled) {
    background: var(--surface-hover);
  }
  .act:disabled {
    opacity: 0.45;
    cursor: default;
  }
  .act-ic {
    display: inline-flex;
    justify-content: center;
    /* 顶对齐后图标贴着名称行的上沿，比文字的视觉中心高一点点 —— 压下来。 */
    margin-top: 1px;
    color: var(--text-secondary);
  }
  .act-body {
    display: flex;
    flex-direction: column;
    gap: 1px;
    min-width: 0;
  }
  .act-name {
    font-size: var(--fs-md);
  }
  .act-desc {
    color: var(--text-muted);
    font-size: var(--fs-xs);
    line-height: 1.4;
  }
  .act-go {
    display: inline-flex;
    color: var(--text-muted);
  }
  .act:hover:not(:disabled) .act-go {
    color: var(--text-secondary);
  }

  .recent {
    display: flex;
    align-items: center;
    gap: var(--sp-3);
    width: 100%;
    padding: 6px var(--sp-2);
    background: transparent;
    border: none;
    border-radius: var(--radius-sm);
    color: var(--text-secondary);
    font-size: var(--fs-sm);
    text-align: left;
    cursor: pointer;
  }
  .recent:hover:not(:disabled) {
    background: var(--surface-hover);
  }
  .recent:disabled {
    opacity: 0.5;
    cursor: default;
  }
</style>
