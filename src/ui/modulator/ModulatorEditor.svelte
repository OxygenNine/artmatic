<script lang="ts">
  /**
   * ModulatorEditor — 一个调制器的表达式编辑器：积木 / 文本两张脸，同一棵 AST。
   *
   * 为什么是 modal 而不是抽屉里的内联区：积木树要有横向空间（五参数的 `map`
   * 缩进四次），而抽屉只有三百来像素。列表留在抽屉里、编辑进 modal，
   * 于是「拖条目到参数行」与「改表达式」各用各的界面。
   *
   * 提交时机：积木每次操作立刻落库（一次撤销记录，与滑杆同构）；文本走
   * 「应用」，因为半截表达式不该进工程（它会静默求值成 0）。
   */
  import Modal from '../controls/Modal.svelte';
  import Button from '../controls/Button.svelte';
  import NumberInput from '../controls/NumberInput.svelte';
  import TextField from '../controls/TextField.svelte';
  import GraphEditor from './GraphEditor.svelte';
  import { appState } from '../app-state.svelte';
  import { modTable, modulatorSample, type Modulator } from '../../core/modulation';
  import { parseCached, printExpr } from '../../core/expr';
  import { tr } from '../../i18n/index.svelte';
  import type { MessageKey } from '../../i18n/locales';
  import type { ExprErrorCode } from '../../core/expr';

  interface Props {
    id: string;
    onclose: () => void;
  }
  const { id, onclose }: Props = $props();

  /*
   * 从 store 现取，不用 props 传引用：store 是原地改的，外面传进来的对象在
   * 一次编辑之后就是旧的。`void appState.version` 让这块跟着版本重算。
   */
  const mod = $derived.by<Modulator | null>(() => {
    void appState.version;
    return (appState.project.modulators ?? []).find((m) => m.id === id) ?? null;
  });

  let view = $state<'blocks' | 'text'>('blocks');
  let draft = $state('');
  let textError = $state<{ code: ExprErrorCode; at: number } | null>(null);

  const parsed = $derived(mod ? parseCached(mod.expr) : null);
  const ast = $derived(parsed?.ok ? parsed.ast : null);

  /** 文本草稿跟随工程值（换调制器 / 撤销之后要跟上）。 */
  $effect(() => {
    draft = mod?.expr ?? '';
  });

  /* 解析失败时积木画不出来，直接切到文本 —— 那一页才看得见哪里错。 */
  $effect(() => {
    if (!parsed?.ok) view = 'text';
  });

  /* 被删掉的调制器：编辑器没有对象可编，自己关掉（与调色页同一条纪律）。 */
  $effect(() => {
    if (!mod) onclose();
  });

  const value = $derived.by(() => {
    if (!mod) return 0;
    return modulatorSample(mod.id, appState.playT, {
      grid: appState.project.beatGrid,
      fps: appState.project.fps,
      seed: appState.project.seed,
      clipStart: 0,
      mods: modTable(appState.project.modulators),
    });
  });

  const ERROR_KEY: Record<ExprErrorCode, MessageKey> = {
    unexpectedChar: 'mod.err.unexpectedChar',
    badNumber: 'mod.err.badNumber',
    unclosedString: 'mod.err.unclosedString',
    unexpectedToken: 'mod.err.unexpectedToken',
    unexpectedEnd: 'mod.err.unexpectedEnd',
    unknownIdent: 'mod.err.unknownIdent',
    unknownFunc: 'mod.err.unknownFunc',
    badArity: 'mod.err.badArity',
    empty: 'mod.err.empty',
    tooDeep: 'mod.err.tooDeep',
  };

  function applyText(): void {
    if (!mod) return;
    const res = parseCached(draft);
    if (!res.ok) {
      textError = res.error;
      return;
    }
    textError = null;
    // 归一化打印：去掉多余括号与空格，于是「应用」之后文本与积木看到的是同一份。
    appState.store.setModulatorExpr(mod.id, printExpr(res.ast));
  }

  const rangeMin = $derived(mod?.unit.min ?? -1);
  const rangeMax = $derived(mod?.unit.max ?? 1);
</script>

<Modal title={mod?.name ?? tr('mod.title')} width="wide" testid="modal-modulator" {onclose}>
  {#if mod}
    <div class="head">
      <label class="cell">
        <span class="cap">{tr('mod.name')}</span>
        <TextField
          value={mod.name}
          ariaLabel={tr('mod.name')}
          maxLength={40}
          testid="mod-name"
          onchange={(v) => appState.store.renameModulator(mod.id, v)}
        />
      </label>
      <label class="cell narrow">
        <span class="cap">{tr('mod.rangeMin')}</span>
        <NumberInput
          value={rangeMin}
          step={0.1}
          width={70}
          ariaLabel={tr('mod.rangeMin')}
          onchange={(v) => appState.store.setModulatorUnit(mod.id, { min: v, max: rangeMax })}
        />
      </label>
      <label class="cell narrow">
        <span class="cap">{tr('mod.rangeMax')}</span>
        <NumberInput
          value={rangeMax}
          step={0.1}
          width={70}
          ariaLabel={tr('mod.rangeMax')}
          onchange={(v) => appState.store.setModulatorUnit(mod.id, { min: rangeMin, max: v })}
        />
      </label>
      <span class="readout">
        <span class="cap">{tr('mod.preview')}</span>
        <span class="mono" data-testid="mod-value">{value.toFixed(3)}</span>
      </span>
    </div>

    <div class="bar">
      <span class="seg" role="group" aria-label={tr('mod.view.switch')}>
        <button
          type="button"
          class="segb"
          class:on={view === 'blocks'}
          data-testid="mod-view-blocks"
          onclick={() => (view = 'blocks')}
        >
          {tr('mod.view.blocks')}
        </button>
        <button
          type="button"
          class="segb"
          class:on={view === 'text'}
          data-testid="mod-view-text"
          onclick={() => (view = 'text')}
        >
          {tr('mod.view.text')}
        </button>
      </span>
      <span class="hint">{tr('mod.exprHint')}</span>
    </div>

    {#if view === 'blocks' && ast}
      <GraphEditor
        {ast}
        storageKey={mod.id}
        mods={appState.project.modulators ?? []}
        selfId={mod.id}
        onast={(next) => appState.store.setModulatorExpr(mod.id, printExpr(next))}
      />
    {/if}

    {#if view === 'text'}
      <div class="canvas">
        <TextField
          value={draft}
          ariaLabel={tr('mod.expr')}
          multiline
          maxLength={400}
          placeholder="sin(t * 2 * pi)"
          testid="mod-expr"
          onchange={(v) => (draft = v)}
        />
        <div class="textbar">
          <Button
            label={tr('mod.textApply')}
            testid="mod-expr-apply"
            variant="accent"
            onclick={applyText}
          />
          {#if textError}
            <span class="err" data-testid="mod-expr-error">
              {tr(ERROR_KEY[textError.code], { at: textError.at + 1 })}
            </span>
          {:else if parsed && !parsed.ok}
            <span class="err" data-testid="mod-expr-error">
              {tr(ERROR_KEY[parsed.error.code], { at: parsed.error.at + 1 })}
            </span>
          {/if}
        </div>
      </div>
    {/if}
  {/if}
</Modal>

<style>
  .head {
    display: flex;
    align-items: flex-end;
    gap: var(--sp-4);
    margin-bottom: var(--sp-4);
  }
  .cell {
    display: flex;
    flex-direction: column;
    gap: 3px;
    flex: 1;
    min-width: 0;
  }
  .cell.narrow {
    flex: none;
    width: 90px;
  }
  .cap {
    color: var(--text-muted);
    font-size: var(--fs-xs);
  }
  .readout {
    display: flex;
    flex-direction: column;
    gap: 3px;
    align-items: flex-end;
    flex: none;
  }
  .bar {
    display: flex;
    align-items: center;
    gap: var(--sp-4);
    margin-bottom: var(--sp-3);
  }
  .seg {
    display: inline-flex;
    flex: none;
    border: 1px solid var(--input-border);
    border-radius: var(--radius-sm);
    overflow: hidden;
  }
  .segb {
    padding: 3px 10px;
    background: transparent;
    border: none;
    color: var(--text-secondary);
    font-size: var(--fs-sm);
    cursor: pointer;
  }
  .segb.on {
    color: var(--accent-contrast, #fff);
    background: var(--accent);
  }
  .hint {
    color: var(--text-muted);
    font-size: var(--fs-xs);
    min-width: 0;
  }
  .canvas {
    display: flex;
    flex-direction: column;
    gap: var(--sp-2);
    min-width: 0;
  }
  .textbar {
    display: flex;
    align-items: center;
    gap: var(--sp-3);
    margin-top: var(--sp-2);
  }
  .err {
    color: var(--danger);
    font-size: var(--fs-xs);
  }
  .mono {
    font-family: var(--font-mono);
    color: var(--text-primary);
    font-size: var(--fs-sm);
  }
</style>
