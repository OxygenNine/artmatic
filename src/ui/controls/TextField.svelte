<script lang="ts">
  /**
   * TextField — `text` 参数的行内控件。
   *
   * 为什么不做成 `<input>` 直接写在检查器里：检查器有两处参数循环、试炼场
   * 还有两处，四处各写一遍的形态是「某一处忘了更新就在那一处失效」。
   * 这里把取值/上限/提交时机收在一处。
   *
   * 提交时机选 `change`（失焦 / 回车）而不是每次键入就提交：
   * 参数写入是**一次撤销记录**（`setEffectParam`），逐字符提交会把
   * 撤销栈塞满，用户按一次 Ctrl+Z 只退回一个字符。
   *
   * 原生 `<input>` 本来就在全局快捷键的放行名单里（`ui/focus.ts` 的
   * `isExempt()`），这里仍显式加 `data-exempt` —— 与自研控件统一，且
   * 将来若改成 contenteditable 不会静默失效。
   */
  interface Props {
    value: string;
    ariaLabel: string;
    multiline?: boolean;
    maxLength?: number;
    placeholder?: string;
    disabled?: boolean;
    testid?: string;
    onchange: (v: string) => void;
  }
  const {
    value,
    ariaLabel,
    multiline = false,
    maxLength = 400,
    placeholder = '',
    disabled = false,
    testid = 'text',
    onchange,
  }: Props = $props();

  /**
   * 输入中的草稿：避免「每敲一个字就写一次参数 / 进一次撤销栈」。
   * 初值取一次的 `value` 是**有意的**（后面那条 `$effect` 负责跟随外部改动），
   * 所以显式忽略 svelte 的「只捕获了初值」提示。
   */
  // svelte-ignore state_referenced_locally
  let draft = $state(value);
  /** 外部改值（撤销 / 换工程 / 关键帧）时要跟上，但不能把正在输入的内容冲掉。 */
  let focused = $state(false);
  $effect(() => {
    if (!focused) draft = value;
  });

  function commit(): void {
    if (draft === value) return;
    onchange(draft);
  }

  function oninput(e: Event): void {
    draft = (e.currentTarget as HTMLInputElement | HTMLTextAreaElement).value;
  }

  function onkeydown(e: KeyboardEvent): void {
    if (!multiline && e.key === 'Enter') {
      e.preventDefault();
      (e.currentTarget as HTMLInputElement).blur();
    } else if (e.key === 'Escape' && focused) {
      // 放弃本次编辑：还原成外部值再失焦（不回写参数）。
      draft = value;
      (e.currentTarget as HTMLElement).blur();
    }
  }
</script>

{#if multiline}
  <textarea
    class="txt txt-multi"
    class:empty={draft.length === 0}
    rows="3"
    {placeholder}
    {disabled}
    maxlength={maxLength}
    aria-label={ariaLabel}
    data-exempt
    data-testid={testid}
    bind:value={draft}
    onfocus={() => (focused = true)}
    onblur={() => {
      focused = false;
      commit();
    }}
    oninput={oninput}
    onkeydown={onkeydown}
  ></textarea>
{:else}
  <input
    class="txt"
    class:empty={draft.length === 0}
    type="text"
    {placeholder}
    {disabled}
    maxlength={maxLength}
    aria-label={ariaLabel}
    data-exempt
    data-testid={testid}
    bind:value={draft}
    onfocus={() => (focused = true)}
    onblur={() => {
      focused = false;
      commit();
    }}
    oninput={oninput}
    onkeydown={onkeydown}
  />
{/if}

<style>
  /*
   * 与 `.num` 同一套表面语言（纯色底 + 1px 实线 + 4px 圆角），但左对齐、
   * 可拉伸 —— 文本不像数字那样有稳定宽度。字体用正文族而不是等宽：
   * 这里填的是给用户看的词，不是标识符。
   */
  .txt {
    flex: 1;
    min-width: 0;
    height: var(--control-h);
    padding: 0 var(--sp-2);
    background: var(--input-bg);
    color: var(--input-fg);
    border: 1px solid var(--input-border);
    border-radius: var(--radius-sm);
    font: inherit;
    font-size: var(--fs-sm);
    text-align: left;
  }
  .txt:hover:not(:disabled) {
    border-color: var(--input-border-hover);
  }
  /*
   * 焦点环画在输入框自己身上（它是视觉主体，没有外层壳）。
   * 再加一层 inset 描边：光换 border-color 时，浅色主题下那一档色差在密集的
   * 参数行里几乎看不出来，而键盘用户需要「一眼定位焦点在哪」。
   */
  .txt:focus {
    outline: none;
    border-color: var(--border-focus);
    box-shadow: inset 0 0 0 1px var(--border-focus);
  }
  .txt:disabled {
    background: var(--surface-2);
    color: var(--text-disabled);
  }
  .txt-multi {
    height: auto;
    min-height: 52px;
    padding: var(--sp-1) var(--sp-2);
    line-height: 1.45;
    resize: vertical;
  }
  .txt::placeholder {
    color: var(--text-disabled);
  }
</style>
