<script lang="ts">
  /**
   * Rail — 窄图标侧栏（44px）。纯图标 + tooltip，从上到下三块：
   *
   *   ① LOGO
   *   ② 快捷键 · 保存 ｜ 媒体池 · 工程 · 插件 ｜ Agent ｜ 导出
   *   ③ 设置 · 明暗切换
   *
   * ② 的分组按「什么时候会想点它」切，短横线就是组界：
   *   - 快捷键 / 保存：正在做的那件事上的即时动作（看一眼按键、落盘）；
   *   - 媒体池 / 工程 / 插件：这份工程里有什么、它能怎么扩展 —— 三个都回答
   *     「工程的范围」（素材清单 / 生命周期 / 扩展），所以同组；
   *   - Agent：唯一会主动跟你对话的东西，单独一格；
   *   - 导出：一件事的终点，与入口分开，免得误触。
   *
   * **零工程时不是整条 rail 失效**（判定见下面的 `noProject`）：关于 / 快捷键 /
 * 设置 / 试炼场 / 明暗 / 工程面板照常可点，其余几颗带 `disabled`。首页盖住的是
 * 主界面，不是这条侧栏 —— 换主题、看快捷键、开设置都不该先建一份工程。
 *
 * 四个面板都是**全屏 modal**而不是贴着图标弹的 flyout：flyout 只有两百来像素宽，
   * 快捷键清单或导出信息塞进去就变成带滚动条的小盒子，而这几块只会继续长。
   * 现在留白多一点没关系。
   *
   * 「导出」从轨道工具条搬到了这里（属于工程级动作，与保存同类）；工具条只留
   * 逐帧/逐拍的操作。这条划分见 AGENTS.md §5。
   */
  import IconButton from './controls/IconButton.svelte';
  import Modal from './controls/Modal.svelte';
  import RailShell from './RailShell.svelte';
  import SettingsModal from './SettingsModal.svelte';
  import ProjectModal from './ProjectModal.svelte';
  import ExportModal from './ExportModal.svelte';
  import PluginManagerModal from './plugin-manager/PluginManagerModal.svelte';
  import AgentRailButton from './agent/AgentRailButton.svelte';
  import { tip } from './tip';
  import Brand from './Brand.svelte';
  import Icon from './Icon.svelte';
  import { appState } from './app-state.svelte';
  import { theme } from './theme.svelte';
  import { SHORTCUT_GROUPS } from './shortcuts';
  import { tr } from '../i18n/index.svelte';
  import { saveProjectNow } from './project-actions';

  type PanelId = 'about' | 'shortcuts' | 'export' | 'settings' | 'project' | 'plugins';
  let panel = $state<PanelId | null>(null);

  const exporting = $derived(appState.exportProgress !== null);

  /**
   * 零工程时哪几颗能点。
   *
   * 分界线是「这件事是不是**只**对某一分工程成立」：
   *
   *  - **壳层 / 编辑器级** —— 关于、快捷键、设置、试炼场、明暗、工程面板：
   *    它们属于应用本身，首页上也必须能用（否则换个主题得先建一份工程）。
   *  - **工程级** —— 保存、媒体池、插件、导出、Agent：它们全都要一份真工程
   *    （占位工程是丢弃用的，写进去等于无声丢掉）。禁用而不是隐藏：位置固定，
   *    用户建完工程第一次看 rail 时不用重新找。
   */
  const noProject = $derived(!appState.hasProject);

</script>

<RailShell>
  {#snippet brand()}
    <!-- ① 品牌 -->
    <button
      type="button"
      class="logo-btn"
      aria-label={tr('app.aboutArtmatic')}
      data-testid="rail-logo"
      onclick={() => (panel = 'about')}
    >
      <Brand variant="mark" size={20} />
    </button>
  {/snippet}

  {#snippet main()}
    <!-- ② 快捷键 · 保存 ｜ 媒体池 · 工程 · 插件 ｜ Agent ｜ 导出（组界见文件头） -->
    <IconButton
      icon="keyboard"
      label={tr('app.shortcuts')}
      testid="rail-shortcuts"
      onclick={() => (panel = 'shortcuts')}
    />
    <IconButton
      icon="save"
      label={tr('app.saveProject')}
      tipText={tr(appState.projectDir ? 'app.saveToCurrentDir' : 'app.savePickDir')}
      testid="rail-save"
      disabled={appState.projectBusy || noProject}
      onclick={() => void saveProjectNow()}
    />

    <div class="rail-sep" aria-hidden="true"></div>

    <!--
      媒体池与「工程 / 插件」同组：三个都在回答「这份工程的范围」——
      素材清单 / 生命周期 / 扩展。媒体池点开的是**左边**那条抽屉
      （检查器在右边，两个开关互不相干）。

      两个视图共用同一个开关：时间轴那边是「拖素材建片段」的来源，排版页那边
      是「拖图片进画布」的来源 —— 同一份素材清单，两处各渲染一份抽屉。
    -->
    <IconButton
      icon="images"
      label={tr('pool.title')}
      tipText={tr('pool.openTip')}
      testid="rail-media"
      active={appState.mediaPoolOpen}
      disabled={noProject}
      onclick={() => appState.toggleMediaPool()}
    />
    <IconButton
      icon="folder"
      label={tr('app.project')}
      tipText={tr('app.projectPanelTip')}
      testid="rail-project"
      active={panel === 'project'}
      onclick={() => (panel = 'project')}
    />
    <!--
      调制器是**工程级**实体（`Project.modulators`），所以与工程 / 插件同组，
      而不是挤在检查器里：它要被复用到十几条片段上，入口必须独立于「当前选中
      哪条片段」。开的是左列抽屉 —— 右侧检查器要同时可见，好把条目拖到参数行上。
    -->
    <IconButton
      icon="square-function"
      label={tr('mod.title')}
      tipText={tr('mod.openTip')}
      testid="rail-modulators"
      active={appState.modulatorOpen}
      disabled={noProject}
      onclick={() => appState.toggleModulatorPanel()}
    />
    <!-- 插件是**工程级**的扩展（每个工程一套，随工程目录走），所以紧挨工程。 -->
    <IconButton
      icon="puzzle"
      label={tr('pl.title')}
      tipText={tr('pl.open')}
      testid="rail-plugins"
      active={panel === 'plugins'}
      disabled={noProject}
      onclick={() => (panel = 'plugins')}
    />

    <div class="rail-sep" aria-hidden="true"></div>

    <!--
      Agent 单独一格：`appState.setAgentOpen` 会顺手收起媒体池（反之亦然），
      所以它俩在布局上是**同一个位置**的两种内容。图标本身带运行状态
      （思考那圈弧 / 工具计数 / 待确认点），见 `AgentRailButton` 的注释。
    -->
    <AgentRailButton disabled={noProject} />

    <div class="rail-sep" aria-hidden="true"></div>

    <IconButton
      icon="download"
      label={tr('app.export')}
      testid="rail-export"
      active={exporting}
      disabled={noProject}
      onclick={() => (panel = 'export')}
    />
  {/snippet}

  {#snippet bottom()}
    <!-- ③ 设置 · 试炼场入口 · 明暗 -->
    <IconButton
      icon="settings"
      label={tr('app.settings')}
      testid="rail-settings"
      onclick={() => (panel = 'settings')}
    />
    <!--
      试炼场入口用 `<a>` 而不是 Button：它是一次**真的页面跳转**
      （lab 是独立 Vite 入口，不是 SPA 视图）。锚点才有无障碍语义，
      中键新开标签页、复制链接也才跟着成立。

      `class="ic-btn"` 是刻意复用全局样式：rail 上所有图标的尺寸/颜色/hover
      必须一致，而那套规则在 `controls.css` 里已经定义了一份。**不加这个类
      的话锚点会用浏览器默认的链接蓝**（实测 `rgb(158,158,255)`）——
      一个又蓝又大的异类，正好破坏了「rail 每个界面都一致」。
    -->
    <a
      class="ic-btn rail-lab-link"
      href="/lab/"
      aria-label={tr('app.openLab')}
      data-testid="rail-lab"
      use:tip={{ text: tr('app.openLabTip') }}
    >
      <Icon name="flask-conical" size={14} />
    </a>
    <!--
      rail 这一颗**只切亮/暗**（按族判定）：灰色与高对比度只能从设置→外观里选，
      它们出现在这里的话「点一下太阳」会跳到一个谁都没预期的第三种观感。
      从灰/高对比度按它 = 回亮色（见 theme.toggleMode）。
    -->
    <IconButton
      icon={theme.family === 'light' ? 'moon' : 'sun'}
      label={tr(theme.family === 'light' ? 'app.toDark' : 'app.toLight')}
      testid="theme-toggle"
      onclick={() => theme.toggleMode()}
    />
  {/snippet}
</RailShell>

{#if panel === 'about'}
  <Modal title={tr('app.aboutArtmatic')} testid="modal-about" onclose={() => (panel = null)}>
    {#snippet hero()}
      <span class="hero-lockup">
        <Brand variant="mark" size={72} />
        <Brand variant="word" size={26} />
      </span>
    {/snippet}
    <p class="lead">{tr('app.aboutLead')}</p>
    <div class="kv">
      <span>{tr('app.version')}</span><span class="mono">{__APP_VERSION__}</span>
      <span>{tr('app.render')}</span><span class="mono">WebGL2 + GLSL ES 3.00</span>
      <span>{tr('app.icons')}</span><span class="mono">{tr('app.licenseLucide')}</span>
      <span>{tr('app.compression')}</span><span class="mono">{tr('app.licenseFflate')}</span>
    </div>
  </Modal>
{/if}

{#if panel === 'plugins'}
  <PluginManagerModal onclose={() => (panel = null)} />
{/if}

{#if panel === 'shortcuts'}
  <Modal title={tr('app.shortcuts')} testid="modal-shortcuts" width="wide" onclose={() => (panel = null)}>
    <div class="sc-grid">
      {#each SHORTCUT_GROUPS as group (group.titleKey)}
        <section>
          <h3>{tr(group.titleKey)}</h3>
          {#each group.items as s (s.labelKey)}
            <div class="sc-row">
              <span class="grow">{tr(s.labelKey)}</span>
              <kbd class="kbd">{tr(s.keysKey)}</kbd>
            </div>
          {/each}
        </section>
      {/each}
    </div>
  </Modal>
{/if}

{#if panel === 'export'}
  <ExportModal onclose={() => (panel = null)} />
{/if}
{#if panel === 'project'}
  <ProjectModal onclose={() => (panel = null)} />
{/if}

{#if panel === 'settings'}
  <SettingsModal onclose={() => (panel = null)} />
{/if}

<style>
  /* `.rail / .rail-block / .rail-spacer` 已上移到 RailShell.svelte ——
     它们在主应用与 lab 之间必须完全一致，留两份就是两个真源。 */

  /*
   * 试炼场入口复用全局 `.ic-btn`（尺寸/颜色/hover 全跟其它 rail 图标一致），
   * 这里只清掉锚点自带的浏览器默认样式 —— 下划线和链接色都是浏览器的，
   * 不是我们的设计。不加这一段，图标会是默认链接蓝，在一排灰色图标里非常扎眼。
   */
  a.rail-lab-link {
    text-decoration: none;
  }
  .logo-btn {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 30px;
    height: 30px;
    padding: 0;
    background: transparent;
    border: none;
    border-radius: var(--radius-sm);
    cursor: pointer;
  }
  .logo-btn:hover {
    background: var(--surface-hover);
  }

  .lead {
    margin: 0 0 var(--sp-5);
    color: var(--text-secondary);
    font-size: var(--fs-md);
  }
  /* 「关于」里的锁合：大标记 + 字标并排（资源里没有现成的锁合文件，两个部件拼一下） */
  .hero-lockup {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: var(--sp-6);
  }
  .kv {
    display: grid;
    grid-template-columns: 88px 1fr;
    gap: var(--sp-2) var(--sp-4);
    font-size: var(--fs-sm);
  }
  .kv > span:nth-child(odd) {
    color: var(--text-muted);
  }
  .kv > span:nth-child(even) {
    color: var(--text-primary);
  }
  .mono {
    font-family: var(--font-mono);
  }
  /* 组界：短横线。比 rail 窄得多，读起来是「分组」而不是「另一条边」。 */
  .rail-sep {
    flex-shrink: 0;
    width: 16px;
    height: 1px;
    margin: 2px 0;
    background: var(--rail-border);
  }

  .sc-grid {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(280px, 1fr));
    gap: var(--sp-5) var(--sp-6);
  }
  .sc-grid h3 {
    margin: 0 0 var(--sp-2);
    color: var(--text-muted);
    font-size: var(--fs-xs);
    font-weight: 500;
    letter-spacing: 0.08em;
    text-transform: uppercase;
  }
  .sc-row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--sp-4);
    min-height: 20px;
    color: var(--text-secondary);
    font-size: var(--fs-sm);
  }
  .grow {
    flex: 1;
    min-width: 0;
  }
  button.ic-btn.md {
    width: calc(var(--control-w) * 1.25);
    height: calc(var(--control-h) * 1.25);
  }

</style>
