<script lang="ts">
  /**
   * ScriptPanel — 文档级脚本（「脚本」选项卡）。
   *
   * 为什么是独立一栏而不是元素属性里的一段代码框：脚本是**整篇文档**的
   * 表现层编排（`ctx.el(id)` 想动谁就动谁，能安排跨元素的先后），它不属于
   * 任何一个元素。挂在元素上会让「同一个节奏管三个元素」变成三份互相抄的
   * 代码，而删掉其中任意一个元素就悄悄少一段动画。
   *
   * 三条界面纪律：
   *  1. **总开关是信任边界**，默认关；关着时这里必须一眼看出「脚本没跑」。
   *  2. 代码编辑走**草稿 + 失焦提交**：每个字符一次 `commit` 会把撤销栈
   *     灌满（一次 Ctrl+Z 只退一个字母）。
   *  3. 运行错误、耗时、超预算都从 `script/diagnostics.ts` 读 —— 它们
   *     不进文档，所以刷新 / 重开工程就没了（这是对的，工程不该被诊断弄脏）。
   */
  import Icon from '../Icon.svelte';
  import { appState } from '../app-state.svelte';
  import { editorState } from './editor-state.svelte';
  import { newId } from '../../core/schema';
  import { tr } from '../../i18n/index.svelte';
  import type { MessageKey } from '../../i18n/locales';
  import {
    SCRIPT_LIMITS,
    type ScriptNeed,
    type TypographyScript,
  } from '../../typography/script/model';
  import { checkScriptSyntax } from '../../typography/script/compile';
  import { SCRIPT_TEMPLATES } from '../../typography/script/templates';
  import {
    scriptDiagnosticsFor,
    subscribeScriptDiagnostics,
    type ScriptDiagnosticCode,
  } from '../../typography/script/diagnostics';

  /** 诊断 → 文案键。**唯一一份**：UI 与（将来的）agent 回执都从这里取。 */
  const DIAG_KEY: Record<ScriptDiagnosticCode, MessageKey> = {
    'compile-failed': 'typo.scriptErrCompile',
    'runtime-error': 'typo.scriptErrRuntime',
    'async-return': 'typo.scriptErrAsync',
    'budget-writes': 'typo.scriptErrWrites',
    'budget-time': 'typo.scriptErrTime',
    slow: 'typo.scriptErrSlow',
    'no-element': 'typo.scriptErrNoElement',
    'path-only': 'typo.scriptErrPath',
  };

  /**
   * 列表必须返回**浅拷贝**。
   *
   * `doc.scripts[i]` 是原地改的普通对象（本工程不用 `$state` 包 Project）：
   * 版本号变了、派生也重跑了，但如果返回的还是同一批引用，Svelte 5 会按
   * `===` 判断「值没变」而不向下传播 —— 表现就是新增 / 删除脚本后列表
   * 要等一次别的交互才刷新（与 `LayersPanel` 文件头记着的是同一个坑）。
   *
   * 依赖显式写成 `appState.version`：只读 `editorState.doc` 的话，文档对象
   * 每次还是同一个，派生可能压根不重算。
   */
  const scripts = $derived.by<TypographyScript[]>(() => {
    void appState.version;
    return (editorState.doc?.scripts ?? []).map((s) => ({
      ...s,
      ...(s.needs?.length ? { needs: [...s.needs] } : {}),
      ...(s.targets?.length ? { targets: [...s.targets] } : {}),
    }));
  });

  let selectedId = $state<string | null>(null);
  let draft = $state('');
  let checkMsg = $state('');
  let checkOk = $state(false);

  /** 诊断表不是响应式的，靠订阅它的 revision 触发重读。 */
  let diagRev = $state(0);
  $effect(() => {
    const off = subscribeScriptDiagnostics(() => {
      diagRev++;
    });
    return off;
  });
  const diagnostics = $derived.by(() => {
    void diagRev;
    void appState.version;
    return scriptDiagnosticsFor(scripts.map((s) => s.id));
  });

  const current = $derived(scripts.find((s) => s.id === selectedId) ?? scripts[0] ?? null);
  const isOn = $derived(appState.runTypoScripts);

  /**
   * 「目标元素」列表同样返回浅拷贝：元素是原地改的普通对象，直接给
   * `{#each}` 的同一个数组会让新增元素 / 改名在面板里静默不刷新。
   */
  const targetElements = $derived.by<{ id: string; name: string; kind: string }[]>(() => {
    void appState.version;
    return (editorState.doc?.elements ?? []).map((el) => ({
      id: el.id,
      name: el.name,
      kind: el.kind,
    }));
  });

  /**
   * 代码框是否聚焦。聚焦时**绝不动草稿**：下面的同步 effect 会在每次
   * 版本变化时重跑（`current` 是新拷贝），不挡住的话打字过程中会被库里的
   * 旧代码覆盖。
   */
  let codeFocused = $state(false);
  /** 上一次同步进草稿的（脚本 id, 代码）。纯记账，不参与渲染。 */
  let syncedId: string | null = null;
  let syncedCode = '';

  /**
   * 草稿与「库里那条」的同步：
   *  - 切换选中 / 撤销重做 / 脚本代码被别处改过 → 换成库里的代码；
   *  - 同一条脚本的其它字段变了（启停 / needs / 目标）→ 不碰草稿；
   *  - 焦点在代码框里 → 一个字都不动。
   */
  $effect(() => {
    const c = current;
    if (!c) {
      draft = '';
      syncedId = null;
      syncedCode = '';
      return;
    }
    if (codeFocused) return;
    if (syncedId !== c.id || syncedCode !== c.code) {
      draft = c.code;
      syncedId = c.id;
      syncedCode = c.code;
      checkMsg = '';
    }
  });

  function write(label: string, fn: (list: TypographyScript[]) => void): void {
    editorState.commit(label, (d) => {
      const list = d.scripts ?? [];
      fn(list);
      d.scripts = list;
    });
  }

  function addScript(code: string, needs: ScriptNeed[], name: string): void {
    const id = newId();
    write(tr('typo.scriptUndoAdd'), (list) => {
      if (list.length >= SCRIPT_LIMITS.maxScripts) return;
      list.push({ id, name, code, enabled: true, ...(needs.length ? { needs } : {}) });
    });
    selectedId = id;
  }

  function addBlank(): void {
    addScript('// ctx.t is the local time in seconds.\n// See the docs for the full ctx API.\n', [], tr('typo.scriptAdd'));
  }

  function removeScript(id: string): void {
    write(tr('typo.scriptUndoRemove'), (list) => {
      const i = list.findIndex((s) => s.id === id);
      if (i >= 0) list.splice(i, 1);
    });
    if (selectedId === id) selectedId = null;
  }

  function toggleScript(id: string, on: boolean): void {
    write(tr('typo.scriptUndoToggle'), (list) => {
      const s = list.find((x) => x.id === id);
      if (s) s.enabled = on;
    });
  }

  function moveScript(id: string, dir: -1 | 1): void {
    write(tr('typo.scriptUndoUpdate'), (list) => {
      const i = list.findIndex((s) => s.id === id);
      const j = i + dir;
      if (i < 0 || j < 0 || j >= list.length) return;
      const [m] = list.splice(i, 1);
      if (m) list.splice(j, 0, m);
    });
  }

  function rename(id: string, name: string): void {
    const next = name.trim();
    if (!next) return;
    write(tr('typo.scriptUndoUpdate'), (list) => {
      const s = list.find((x) => x.id === id);
      if (s) s.name = next;
    });
  }

  function applyCode(): void {
    const c = current;
    if (!c || draft === c.code) return;
    write(tr('typo.scriptUndoUpdate'), (list) => {
      const s = list.find((x) => x.id === c.id);
      if (s) s.code = draft;
    });
    // 刚提交的这份就是「库里的代码」：记下来，免得同步 effect 把「语法没问题」
    // 那行提示顺手清掉（它只该在代码真的被外部换掉时清）。
    syncedId = c.id;
    syncedCode = draft;
  }

  function toggleNeed(need: ScriptNeed, on: boolean): void {
    const c = current;
    if (!c) return;
    write(tr('typo.scriptUndoUpdate'), (list) => {
      const s = list.find((x) => x.id === c.id);
      if (!s) return;
      const set = new Set<ScriptNeed>(s.needs ?? []);
      if (on) set.add(need);
      else set.delete(need);
      if (set.size) s.needs = [...set];
      else delete s.needs;
    });
  }

  function toggleTarget(id: string, on: boolean): void {
    const c = current;
    if (!c) return;
    write(tr('typo.scriptUndoUpdate'), (list) => {
      const s = list.find((x) => x.id === c.id);
      if (!s) return;
      const set = new Set(s.targets ?? []);
      if (on) set.add(id);
      else set.delete(id);
      if (set.size) s.targets = [...set];
      else delete s.targets;
    });
  }

  function clearTargets(): void {
    const c = current;
    if (!c) return;
    write(tr('typo.scriptUndoUpdate'), (list) => {
      const s = list.find((x) => x.id === c.id);
      if (s) delete s.targets;
    });
  }

  function check(): void {
    const r = checkScriptSyntax(draft);
    checkOk = r.ok;
    checkMsg = r.ok ? tr('typo.scriptChecked') : r.detail;
  }

  function diagOf(id: string) {
    return diagnostics.find((d) => d.scriptId === id) ?? null;
  }

  function needsLabel(needs: ScriptNeed[] | undefined): string {
    if (!needs?.length) return '';
    return needs
      .map((n) => (n === 'chars' ? tr('typo.scriptNeedChars') : tr('typo.scriptNeedCanvas')))
      .join(' · ');
  }
</script>

<div class="script" data-testid="typo-script-panel">
  <div class="bar">
    <label class="switch" title={tr('typo.scriptEnabledHint')}>
      <input
        type="checkbox"
        checked={isOn}
        data-testid="typo-script-toggle"
        onchange={(e) => appState.setRunTypoScripts(e.currentTarget.checked)}
      />
      {tr('typo.scriptEnabled')}
    </label>
    <span class="spacer"></span>
    <span class="hint">{scripts.length}/{SCRIPT_LIMITS.maxScripts}</span>
  </div>

  {#if !isOn}
    <p class="off" data-testid="typo-script-off">{tr('typo.scriptEnabledHint')}</p>
  {/if}
  <p class="risk">{tr('typo.scriptRisk')}</p>

  <div class="list" role="list">
    {#each scripts as s (s.id)}
      <div
        class="row"
        class:on={current?.id === s.id}
        role="presentation"
        data-testid="typo-script-row"
        onclick={() => (selectedId = s.id)}
      >
        <input
          type="checkbox"
          checked={s.enabled}
          aria-label={tr('typo.scriptEnabled')}
          data-testid="typo-script-enabled"
          onclick={(e) => e.stopPropagation()}
          onchange={(e) => toggleScript(s.id, e.currentTarget.checked)}
        />
        <span class="name" class:dim={!s.enabled}>{s.name}</span>
        {#if needsLabel(s.needs)}
          <span class="tag">{needsLabel(s.needs)}</span>
        {/if}
        <span class="acts">
          <button
            type="button"
            class="ic"
            aria-label={tr('typo.scriptMoveUp')}
            onclick={(e) => {
              e.stopPropagation();
              moveScript(s.id, -1);
            }}
          >
            <Icon name="move-up" size={11} />
          </button>
          <button
            type="button"
            class="ic"
            aria-label={tr('typo.scriptMoveDown')}
            onclick={(e) => {
              e.stopPropagation();
              moveScript(s.id, 1);
            }}
          >
            <Icon name="move-down" size={11} />
          </button>
          <button
            type="button"
            class="ic"
            aria-label={tr('typo.scriptRemove')}
            data-testid="typo-script-remove"
            onclick={(e) => {
              e.stopPropagation();
              removeScript(s.id);
            }}
          >
            <Icon name="trash" size={11} />
          </button>
        </span>
      </div>
    {/each}
    {#if scripts.length === 0}
      <p class="empty">{tr('typo.scriptEmpty')}</p>
    {/if}
  </div>

  <div class="tools">
    <button type="button" class="sbtn" data-testid="typo-script-add" onclick={addBlank}>
      <Icon name="plus" size={11} />
      {tr('typo.scriptAdd')}
    </button>
    {#each SCRIPT_TEMPLATES as t (t.id)}
      <button
        type="button"
        class="sbtn"
        data-testid={`typo-script-template-${t.id}`}
        title={tr(t.labelKey)}
        onclick={() => addScript(t.code, t.needs, tr(t.labelKey))}
      >
        {tr(t.labelKey)}
      </button>
    {/each}
  </div>

  {#if current}
    {@const c = current}
    <div class="editor">
      <div class="line">
        <span class="label">{tr('typo.scriptName')}</span>
        <input
          class="name-input"
          value={c.name}
          onchange={(e) => rename(c.id, e.currentTarget.value)}
        />
      </div>

      <div class="line">
        <span class="label">{tr('typo.scriptNeeds')}</span>
        <label class="chk">
          <input
            type="checkbox"
            checked={c.needs?.includes('chars') ?? false}
            data-testid="typo-script-needs-chars"
            onchange={(e) => toggleNeed('chars', e.currentTarget.checked)}
          />
          {tr('typo.scriptNeedChars')}
        </label>
        <label class="chk">
          <input
            type="checkbox"
            checked={c.needs?.includes('canvas') ?? false}
            data-testid="typo-script-needs-canvas"
            onchange={(e) => toggleNeed('canvas', e.currentTarget.checked)}
          />
          {tr('typo.scriptNeedCanvas')}
        </label>
      </div>

      <details class="targets">
        <summary>
          {tr('typo.scriptTargets')}
          <span class="hint">
            {c.targets?.length ? `${c.targets.length}` : tr('typo.scriptAllTargets')}
          </span>
        </summary>
        <div class="target-list">
          {#each targetElements as el (el.id)}
            <label class="chk">
              <input
                type="checkbox"
                checked={c.targets?.includes(el.id) ?? false}
                onchange={(e) => toggleTarget(el.id, e.currentTarget.checked)}
              />
              <span class="trunc">{el.name || el.kind}</span>
            </label>
          {/each}
        </div>
        {#if c.targets?.length}
          <button type="button" class="sbtn" onclick={clearTargets}>
            {tr('typo.scriptAllTargets')}
          </button>
        {/if}
      </details>

      <p class="hint code-hint">{tr('typo.scriptEditHint')}</p>
      <textarea
        class="code"
        spellcheck={false}
        data-testid="typo-script-code"
        bind:value={draft}
        onfocus={() => (codeFocused = true)}
        onblur={() => {
          codeFocused = false;
          applyCode();
        }}
      ></textarea>

      <div class="line">
        <button type="button" class="sbtn" data-testid="typo-script-check" onclick={check}>
          {tr('typo.scriptCheck')}
        </button>
        {#if checkMsg}
          <span class="msg" class:ok={checkOk} class:bad={!checkOk}>{checkMsg}</span>
        {/if}
      </div>

      {#if diagOf(c.id)}
        {@const dg = diagOf(c.id)!}
        <p class="diag" data-testid="typo-script-diag">
          <Icon name="triangle-alert" size={11} />
          <span class="dg-code">{tr(DIAG_KEY[dg.code])}</span>
          <span class="dg-detail">{dg.detail}</span>
          {#if dg.repeats > 1}
            <span class="hint">{tr('typo.scriptDiagRepeats', { n: dg.repeats })}</span>
          {/if}
          <span class="hint">
            {tr('typo.scriptDiagFrame', { n: dg.frame, ms: `${dg.elapsedMs.toFixed(1)}ms` })}
          </span>
        </p>
      {/if}
    </div>
  {/if}
</div>

<style>
  .script {
    display: grid;
    grid-template-rows: auto auto auto minmax(60px, auto) auto minmax(0, 1fr);
    min-height: 0;
    background: var(--surface-1);
    overflow: auto;
  }
  .bar {
    display: flex;
    align-items: center;
    gap: var(--sp-2);
    padding: 3px var(--sp-3);
    border-bottom: 1px solid var(--border);
  }
  .spacer {
    margin-left: auto;
  }
  .switch,
  .chk {
    display: flex;
    align-items: center;
    gap: 4px;
    font-size: var(--fs-sm);
    color: var(--text-secondary);
    cursor: pointer;
  }
  .hint {
    font-size: var(--fs-xs);
    color: var(--text-muted);
  }
  .off {
    margin: 0;
    padding: 3px var(--sp-3);
    font-size: var(--fs-xs);
    color: var(--warning);
    background: color-mix(in srgb, var(--warning) 10%, transparent);
    border-bottom: 1px solid var(--border);
  }
  .risk {
    margin: 0;
    padding: 3px var(--sp-3);
    font-size: var(--fs-xs);
    color: var(--text-muted);
    border-bottom: 1px solid var(--border);
  }
  .list {
    overflow: auto;
    min-height: 0;
  }
  .row {
    display: flex;
    align-items: center;
    gap: var(--sp-2);
    height: 22px;
    padding: 0 var(--sp-3);
    cursor: pointer;
    border-bottom: 1px solid var(--border);
    font-size: var(--fs-sm);
  }
  .row:hover {
    background: var(--surface-hover);
  }
  .row.on {
    background: var(--accent-weak);
  }
  .name {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .name.dim {
    color: var(--text-muted);
    text-decoration: line-through;
  }
  .tag {
    font-size: var(--fs-xs);
    color: var(--text-muted);
    white-space: nowrap;
  }
  .acts {
    display: flex;
    gap: 1px;
  }
  .ic {
    display: grid;
    place-items: center;
    width: 16px;
    height: 16px;
    padding: 0;
    background: transparent;
    border: none;
    border-radius: var(--radius-sm);
    color: var(--text-muted);
    cursor: pointer;
  }
  .ic:hover {
    background: var(--surface-2);
    color: var(--text-primary);
  }
  .empty {
    margin: 0;
    padding: var(--sp-3);
    font-size: var(--fs-xs);
    color: var(--text-muted);
  }
  .tools {
    display: flex;
    flex-wrap: wrap;
    gap: 3px;
    padding: 3px var(--sp-3);
    border-bottom: 1px solid var(--border);
  }
  .sbtn {
    display: inline-flex;
    align-items: center;
    gap: 3px;
    height: 18px;
    padding: 0 6px;
    background: var(--surface-2);
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    color: var(--text-secondary);
    font-size: var(--fs-xs);
    cursor: pointer;
    white-space: nowrap;
  }
  .sbtn:hover {
    background: var(--surface-hover);
    color: var(--text-primary);
  }
  .editor {
    display: grid;
    gap: 3px;
    padding: var(--sp-3);
    align-content: start;
  }
  .line {
    display: flex;
    align-items: center;
    gap: var(--sp-2);
  }
  .label {
    font-size: var(--fs-xs);
    color: var(--text-muted);
    min-width: 52px;
  }
  .name-input {
    flex: 1;
    min-width: 0;
    height: 20px;
    background: var(--surface-2);
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    color: var(--text-primary);
    font-size: var(--fs-sm);
    padding: 0 4px;
  }
  .targets summary {
    font-size: var(--fs-xs);
    color: var(--text-muted);
    cursor: pointer;
    display: flex;
    gap: var(--sp-2);
  }
  .target-list {
    max-height: 110px;
    overflow: auto;
    padding: 2px 0;
  }
  .trunc {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .code-hint {
    margin: 2px 0 0;
  }
  .code {
    width: 100%;
    min-height: 150px;
    resize: vertical;
    background: var(--surface-2);
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    color: var(--text-primary);
    font-family: var(--font-mono);
    font-size: var(--fs-xs);
    line-height: 1.45;
    padding: 4px 6px;
    tab-size: 2;
  }
  .msg {
    font-size: var(--fs-xs);
  }
  .msg.ok {
    color: var(--text-muted);
  }
  .msg.bad {
    color: var(--danger);
  }
  .diag {
    display: flex;
    align-items: baseline;
    flex-wrap: wrap;
    gap: 4px;
    margin: 0;
    font-size: var(--fs-xs);
    color: var(--danger);
  }
  .dg-code {
    font-weight: 600;
  }
  .dg-detail {
    font-family: var(--font-mono);
    color: var(--text-secondary);
    word-break: break-all;
  }
</style>
