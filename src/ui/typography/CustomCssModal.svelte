<script lang="ts">
  /**
   * CustomCssModal — 手写 CSS 动画的唯一入口。
   *
   * 支持两种写法（都由 `parseCustomCss` 校验）：
   *
   *  ① **单条**：只填一个 `@keyframes` 的**体**（`from{opacity:0} to{opacity:1}`）。
   *     旧工程就是这种，渲染结果不变。
   *  ② **多条**：写一个或多个 `@keyframes 名字{…}` 块，再写一行
   *     `animation: 名字 时长 缓动 延迟 …;`，多条用逗号分隔 —— 于是同一元素上
   *     可以同时或先后跑多条动画。名字可引用上面的块，也可用预设名（如 fade-in）。
   *
   * 只收这些，不收整段 CSS。理由不是偷懒：允许顶层选择器的话，用户就能影响
   * 同页的其它元素（预览页里还有时间轴和面板）；`@import` 会外发请求破坏离线与
   * 确定性；`position:fixed` 能让元素逃出快照区域。允许 `@keyframes` 块之后，
   * 选择器仍恒为 `[data-anim-id]`，注入点唯一 —— 它只影响被绑定的那个元素，
   * 而且每个名字都被命名空间化（`artmatic-a-<id>-…`），两个元素各写一个
   * `@keyframes pulse` 不会互相覆盖。
   *
   * 校验在写入前做（`parseCustomCss` 会剥掉 @import / 标签 / 注释，并校验
   * 花括号配平与名字引用）—— 非法代码绝不能进文档，否则用户会以为「保存成功了」。
   */
  import Modal from '../controls/Modal.svelte';
  import Button from '../controls/Button.svelte';
  import { CUSTOM_CSS_ERROR_KEYS, parseCustomCss, type CustomCssParse } from '../../typography/animation';
  import { tr } from '../../i18n/index.svelte';

  interface Props {
    /**
     * 初值用**函数**而不是字符串：弹窗每次打开都是新建的，所以这里要的是
     * 「打开那一刻的快照」。传字符串会让 Svelte 报「只捕获了初值」——
     * 那确实是我们想要的语义，但用函数表达出来更清楚，也不产生警告。
     */
    initialOf: () => string;
    onclose: () => void;
    /** 返回 false 表示代码非法。 */
    onsave: (css: string) => boolean;
  }
  const { initialOf, onclose, onsave }: Props = $props();

  // svelte-ignore state_referenced_locally -- 只取挂载那一刻的快照，正是意图
  let text = $state(initialOf());
  let error = $state<string | null>(null);

  const parsed = $derived(parseCustomCss(text));
  const isEmpty = $derived(text.trim() === '');
  const liveError = $derived(errorOf(parsed));
  const preview = $derived(previewOf(parsed));

  function errorOf(p: CustomCssParse): string {
    return p.ok ? '' : tr(CUSTOM_CSS_ERROR_KEYS[p.reason]);
  }

  /** 归一化后的结果预览：旧单 body 包一层 @keyframes，多动画显示块 + 简写。 */
  function previewOf(p: CustomCssParse): string {
    if (!p.ok) return '';
    if (p.animation) return `${p.css ? `${p.css}\n` : ''}animation: ${p.animation};`;
    return `@keyframes …{${p.css}}`;
  }

  function save(): void {
    const p = parseCustomCss(text);
    if (isEmpty) {
      error = tr('typo.customCssEmpty');
      return;
    }
    if (!p.ok) {
      error = tr(CUSTOM_CSS_ERROR_KEYS[p.reason]);
      return;
    }
    if (!onsave(text)) {
      error = tr('typo.customCssUnwritable');
      return;
    }
    onclose();
  }
</script>

<Modal title={tr('typo.customCssTitle')} onclose={onclose} testid="typo-css-modal" width="wide">
  <p class="hint">{tr('typo.customCssHintA')}<code>@keyframes</code>{tr('typo.customCssHintB')}<strong>{tr('typo.customCssHintC')}</strong>{tr('typo.customCssHintD')}<code>from&#123;opacity:0&#125;to&#123;opacity:1&#125;</code>{tr('typo.customCssHintE')}</p>
  <p class="hint">{tr('typo.customCssMultiA')}<code>@keyframes {tr('typo.customCssWordName')}&#123;…&#125;</code>{tr('typo.customCssMultiB')}<code>animation: {tr('typo.customCssWordName')} {tr('typo.customCssWordDuration')} {tr('typo.customCssWordEasing')} {tr('typo.customCssWordDelay')} …;</code>{tr('typo.customCssMultiC')}<code>fade-in</code>{tr('typo.customCssMultiD')}</p>
  <p class="hint">{tr('typo.customCssHintF')}<code>@import</code>{tr('typo.customCssHintG')}<code>position:fixed</code>{tr('typo.customCssHintH')}</p>

  <textarea
    class="code"
    spellcheck="false"
    bind:value={text}
    data-testid="typo-css-input"
    oninput={() => (error = null)}
  ></textarea>

  {#if error}
    <p class="err" data-testid="typo-css-error">{error}</p>
  {:else if isEmpty}
    <p class="note">{tr('typo.customCssEmpty')}</p>
  {:else if !parsed.ok}
    <p class="err" data-testid="typo-css-error">{liveError}</p>
  {:else}
    <p class="ok">{tr('typo.customCssResult')}<code class="preview">{preview}</code></p>
  {/if}

  <div class="acts">
    <Button label={tr('common.cancel')} testid="typo-css-cancel" onclick={onclose} />
    <Button label={tr('common.save')} variant="accent" testid="typo-css-save" onclick={save} />
  </div>
</Modal>

<style>
  .hint {
    margin: 0 0 var(--sp-2);
    font-size: var(--fs-sm);
    color: var(--text-secondary);
    line-height: 1.6;
  }
  code {
    font-family: var(--font-mono);
    font-size: var(--fs-sm);
    color: var(--text-primary);
  }
  .code {
    width: 100%;
    min-height: 140px;
    margin-top: var(--sp-3);
    padding: var(--sp-3);
    background: var(--input-bg);
    border: 1px solid var(--input-border);
    border-radius: var(--radius-sm);
    color: var(--input-fg);
    font-family: var(--font-mono);
    font-size: var(--fs-md);
    line-height: 1.6;
    resize: vertical;
  }
  .code:focus {
    outline: 1px solid var(--border-focus);
    outline-offset: -1px;
  }
  .err {
    margin: var(--sp-3) 0 0;
    font-size: var(--fs-sm);
    color: var(--danger);
    line-height: 1.5;
  }
  .note {
    margin: var(--sp-3) 0 0;
    font-size: var(--fs-sm);
    color: var(--text-muted);
    line-height: 1.5;
  }
  .ok {
    margin: var(--sp-3) 0 0;
    font-size: var(--fs-sm);
    color: var(--text-muted);
    line-height: 1.5;
    word-break: break-all;
  }
  .preview {
    display: block;
    margin-top: var(--sp-1);
    white-space: pre-wrap;
  }
  .acts {
    display: flex;
    justify-content: flex-end;
    gap: var(--sp-3);
    margin-top: var(--sp-5);
  }
</style>
