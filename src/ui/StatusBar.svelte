<script lang="ts">
  /**
   * StatusBar — 底栏（高 22px）。
   *
   * 四段：工程名 · 提示 · 快捷键 · FPS。
   *
   * 「提示」这一段回答的是**「我现在能做什么」**，不是「这个控件叫什么」：
   *
   * - 控件叫什么在它自己的悬浮气泡里（`use:tip`），底栏抄一遍只会得到两处一模一样的
   *   字 —— 而且气泡能换行、底栏不能，同一句话在底栏里还得被截断。
   * - 底栏真正无可替代的是另外两件：**没气泡的东西**（片段、标尺、轨道行空白这些
   *   自绘/委托区域），以及**「下一步做什么」**（空时间轴该说「右键新建片段」、
   *   框选完该说「整组移动 / 批量删除」）。判定在 `hints.ts`，状态在 `status-hint`。
   *
   * 优先级：一次性提示（保存结果等）> 导出进度 > 模拟追赶 > 三层提示。
   * 前三条都是「画面为什么不对 / 刚才发生了什么」的解释，比提示重要。
   */
  import Icon from './Icon.svelte';
  import Modal from './controls/Modal.svelte';
  import Button from './controls/Button.svelte';
  import { appState } from './app-state.svelte';
  import {
    clearRuntimeErrors,
    diagnosticText,
    recentConsoleErrors,
    runtimeErrors,
  } from './runtime-errors.svelte';
  import { statusHint } from './status-hint.svelte';
  import { hoverHint, pickHint, sceneHint, type Hint, type HintContext } from './hints';
  import { splitKeysKeyOf } from './shortcuts';
  import { editorState } from './typography/editor-state.svelte';
  import { tr } from '../i18n/index.svelte';

  const project = $derived.by(() => {
    void appState.version;
    return appState.store.project;
  });

  const exporting = $derived(appState.exportProgress !== null);
  const pct = $derived(exporting ? Math.round((appState.exportProgress ?? 0) * 100) : 0);

  /**
   * 场景快照。
   *
   * `void appState.version` 不能省：片段的增删是**原地改**（见 Timeline 的响应式
   * 纪律），不订阅版本的话「删光片段」不会让提示切回「右键新建片段」。
   */
  const ctx = $derived.by((): HintContext => {
    void appState.version;
    let clipCount = 0;
    for (const track of project.tracks) clipCount += track.clips.length;
    return {
      view: appState.editorOpen ? 'typography' : appState.gradeOpen ? 'grade' : 'timeline',
      clipCount,
      selectedIds: appState.selectedClipIds,
      typoSelectedCount: editorState.selectedIds.length,
      playing: appState.playing,
      splitKey: splitKeysKeyOf(appState.shortcutScheme),
    };
  });

  const hint = $derived.by((): Hint | null => {
    // 手势层最先短路：拖动期间每帧都在改 version，没必要陪着重算后面两层。
    if (statusHint.gesture) return statusHint.gesture;
    return pickHint([hoverHint(statusHint.hover, ctx), sceneHint(ctx)]);
  });

  let errorOpen = $state(false);
  let copied = $state(false);

  async function copyDiagnostics(): Promise<void> {
    try {
      await navigator.clipboard.writeText(diagnosticText());
      copied = true;
      window.setTimeout(() => (copied = false), 1500);
    } catch {
      /* 剪贴板不可用（http / 权限）：保留内容让用户手动选，不弹新的错误。 */
    }
  }
</script>

{#snippet errorFooter()}
  <span class="dim">{copied ? tr('app.diagnosticsCopied') : ''}</span>
  <Button
    label={tr('app.clearErrors')}
    variant="outline"
    testid="runtime-error-clear"
    onclick={() => {
      clearRuntimeErrors();
      errorOpen = false;
    }}
  />
  <Button
    label={tr('app.copyDiagnostics')}
    icon="copy"
    variant="accent"
    testid="runtime-error-copy"
    onclick={copyDiagnostics}
  />
{/snippet}

<footer class="statusbar" data-testid="statusbar">
  {#if appState.hasProject}
    <span class="seg project" data-testid="statusbar-project">
      <Icon name="video" size={11} />
      {project.name || tr('proj.unnamed')}
    </span>
  {/if}

  <!--
    未捕获错误：**常驻段**，与下面那串一次性提示并列。
    它是「刚才那一下为什么没反应」的唯一出口；详情在 Modal 里，底栏只放计数。
  -->
  {#if runtimeErrors().length > 0}
    <button
      type="button"
      class="seg err"
      data-testid="runtime-error"
      onclick={() => (errorOpen = true)}
    >
      <Icon name="triangle-alert" size={11} />
      {tr('app.runtimeError', { n: runtimeErrors().length })}
    </button>
  {/if}

  <!--
    自动保存降级的**常驻**提示：它与下面那串一次性提示是两种东西 ——
    那边报「刚才发生了什么」，这边报「现在磁盘上的工程不是最新的」。
    所以它不参与优先级链，只在故障消失时跟着消失（下一次写入成功）。
  -->
  {#if appState.autosaveFailure}
    <span class="seg danger" data-testid="autosave-degraded">
      <Icon name="triangle-alert" size={11} />
      {tr(appState.autosaveFatal ? 'app.autosaveFailed' : 'app.autosaveDegraded', {
        reason: appState.autosaveFailure,
      })}
    </span>
  {/if}

  {#if appState.notice}
    <!-- 一次性提示（保存结果、Alt+↑↓ 被策略挡住…）：优先级最高，压过提示。
         三级颜色：中性 / 成功（绿）/ 失败（红）—— 见下面 .notice 的注释。 -->
    <span class="seg notice" data-testid="notice" data-level={appState.noticeLevel}>
      <Icon
        name={appState.noticeLevel === 'success'
          ? 'check'
          : appState.noticeLevel === 'error'
            ? 'triangle-alert'
            : 'info'}
        size={11}
      />
      {appState.notice}
    </span>
  {:else if appState.hasProject && exporting}
    <span class="seg accent" data-testid="statusbar-export">
      <Icon name="download" size={11} />
      {tr('app.exporting', { pct })}
    </span>
  {:else if appState.hasProject && appState.simLag > 0}
    <!-- 拖动播放头时模拟会落在播放头后面（见 app-state.syncSimBudget）。
         排在导出之后、提示之前：它是「画面为什么不对」的解释，比提示重要。 -->
    <span class="seg accent" data-testid="statusbar-simlag">
      <Icon name="clock" size={11} />
      {tr('app.simCatchUp')}
    </span>
  {:else if appState.hasProject && hint}
    <!--
      说明句 + 键位角标。**没有内容时这一段是整个消失的**：原来是常驻的
      「悬停任意控件获取说明」——一句恒为真、又从不改变的话，占着底栏最显眼的
      位置而零信息量。
    -->
    {#if hint.text}
      <span class="seg hint" data-testid="statusbar-hint">{tr(hint.text, hint.vars)}</span>
    {/if}
    {#each hint.actions ?? [] as a (a.keysKey + a.labelKey)}
      <span class="seg keys" data-testid="statusbar-keys">
        <kbd class="kbd">{tr(a.keysKey)}</kbd>
        <span class="klabel">{tr(a.labelKey)}</span>
      </span>
    {/each}
  {/if}

  <span class="seg spacer"></span>

  <!--
    右侧两段（帧率 / 时间码）只在有工程时存在：首页上它们读的是占位工程，
    显示出来是「30 fps · 0.00s」这种既不真也没用的数。
  -->
  {#if appState.hasProject}
    <span class="seg mono" title={tr('app.fpsTip')}>
      <span class="dim">fps</span>
      <span class="accent" data-testid="statusbar-fps">{appState.fps || '--'}</span>
    </span>
    <span class="seg mono dim">{appState.playT.toFixed(2)}s</span>
  {/if}
</footer>

{#if errorOpen}
  <Modal
    title={tr('app.runtimeErrorTitle')}
    testid="runtime-error-modal"
    width="wide"
    footer={errorFooter}
    onclose={() => (errorOpen = false)}
  >
    <p class="err-hint">{tr('app.runtimeErrorHint')}</p>
    {#each runtimeErrors() as e (e.id)}
      <div class="err-item" data-testid="runtime-error-item">
        <div class="err-head">
          <span class="mono">{e.source}</span>
          <span class="dim">{new Date(e.at).toLocaleTimeString()}</span>
        </div>
        <div class="err-msg">{e.message}</div>
        {#if e.stack}<pre class="err-stack">{e.stack}</pre>{/if}
      </div>
    {/each}
    {#if recentConsoleErrors().length > 0}
      <h4 class="err-sub">{tr('app.recentConsole')}</h4>
      <pre class="err-stack">{recentConsoleErrors().join('\n')}</pre>
    {/if}
  </Modal>
{/if}

<style>
  .statusbar {
    display: flex;
    align-items: center;
    gap: var(--sp-5);
    height: var(--statusbar-h);
    padding: 0 var(--sp-4);
    background: var(--bar-bg);
    border-top: 1px solid var(--bar-border);
    color: var(--bar-fg);
    font-size: var(--fs-xs);
    user-select: none;
    /*
     * 只为一个东西：看板娘（z-index: 0 的绝对定位元素，挂在 `.stage` 的右下角）。
     * 它是**定位元素**，会自动盖过没有定位的底栏——底栏必须自己也是定位的、
     * 且带的 z 比它大，否则她下半截会画在底栏上面。
     */
    position: relative;
    z-index: 2;
  }
  .seg {
    display: inline-flex;
    align-items: center;
    gap: var(--sp-2);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    min-width: 0;
  }
  .spacer {
    flex: 1;
  }
  .project {
    flex-shrink: 0;
    color: var(--bar-fg-strong);
  }
  /*
   * 提示分三级。
   *
   * 原来只有红色一种 —— 于是「已保存 · 3 个素材 · 12 ms」也是红的，
   * 用户第一眼会以为保存失败了。默认走中性色，只有真的失败了才红，
   * 成功才绿。
   */
  .notice {
    color: var(--bar-fg);
  }
  .notice[data-level='success'] {
    color: var(--success);
  }
  .notice[data-level='error'] {
    color: var(--danger);
  }
  .hint {
    color: var(--bar-fg);
  }
  .danger {
    color: var(--danger);
  }
  /*
   * 键位角标：`<kbd>` 说明「按什么」，紧跟的标签说明「按下去做什么」。
   * 标签比键位淡一档（它是解释，键位才是要记住的东西）；整段可收缩
   * ——底栏一行放不下时被截断的是最后一条提示，而不是 fps。
   */
  .keys {
    flex-shrink: 1;
    color: var(--text-muted);
  }
  .accent {
    color: var(--bar-accent);
  }
  .dim {
    color: var(--text-muted);
  }
  .mono {
    font-family: var(--font-mono);
    font-variant-numeric: tabular-nums;
  }
  kbd.kbd {
    border-color: var(--bar-border);
    flex-shrink: 0;
  }
  /* 底栏里的可点击段：去掉 button 的默认外观，只保留文字与颜色 */
  button.err {
    border: 0;
    padding: 0;
    background: transparent;
    font: inherit;
    color: var(--danger);
    cursor: pointer;
  }
  button.err:hover {
    text-decoration: underline;
  }
  .err-hint {
    margin: 0 0 var(--sp-3);
    color: var(--text-secondary);
    line-height: 1.5;
  }
  .err-item {
    margin-bottom: var(--sp-3);
    padding: var(--sp-2);
    background: var(--surface-2);
    border: 1px solid var(--input-border);
    border-radius: var(--radius-sm);
  }
  .err-head {
    display: flex;
    justify-content: space-between;
    margin-bottom: 2px;
    font-size: var(--fs-xs);
  }
  .err-msg {
    font-weight: 600;
    word-break: break-word;
  }
  .err-stack {
    max-height: 220px;
    margin: var(--sp-2) 0 0;
    padding: var(--sp-2);
    overflow: auto;
    background: var(--surface-1);
    border: 1px solid var(--input-border);
    border-radius: var(--radius-sm);
    font-family: var(--font-mono);
    font-size: var(--fs-xs);
    white-space: pre-wrap;
    word-break: break-word;
    user-select: text;
  }
  .err-sub {
    margin: var(--sp-3) 0 var(--sp-2);
    font-size: var(--fs-sm);
  }
</style>
