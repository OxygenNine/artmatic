<script lang="ts">
  /**
   * AgentHistoryModal — 当前工程的 Agent 会话历史。
   *
   * 数据源是工程目录的 `agent/sessions/<id>.json`（由 `appState` 载入内存，可一键
   * 清空）。可以**从任意一条恢复到对话里继续**（`agentState.restoreSession`）：
   * 恢复的是历史里的文本摘要，工具调用/截图不落盘，所以续聊时模型会被告知
   * 重新读工程（见 `agent/history.ts::resumedMessages`）。
   *
   * 布局：左侧是一个**悬浮的**会话列表（自己的滚动容器，不跟着右侧内容滚），
   * 右侧是详情。所以 Modal 用 `split` + `flushBody` —— 外层不再提供 padding 与
   * 滚动，滚动只发生在两栏各自内部。
   *
   * 正文搜索是 **Ctrl+F 才浮出来的**：左栏已经有一个会话搜索，两个搜索框并排时
   * 没人分得清谁在过滤什么；而且它要能抢掉浏览器自带的查找栏（那个搜的是整页）。
   */
  import Modal from '../controls/Modal.svelte';
  import Button from '../controls/Button.svelte';
  import ConfirmDialog from '../ConfirmDialog.svelte';
  import IconButton from '../controls/IconButton.svelte';
  import Icon from '../Icon.svelte';
  import { tick } from 'svelte';
  import { agentState } from './agent-state.svelte';
  import { toolLabel } from './tool-labels';
  import { tr } from '../../i18n/index.svelte';
  import type { AgentSessionRecord, AgentStoredMessage } from '../../agent/history';

  interface Props {
    onclose: () => void;
  }
  const { onclose }: Props = $props();

  /** 左栏：按标题 / 内容筛会话。 */
  let query = $state('');
  /** 右栏：在这条会话的消息里找。空串 = 不过滤。 */
  let msgQuery = $state('');
  /** 正文搜索是**浮层**，只在 Ctrl+F 时出现（关掉即清空关键词）。 */
  let searchOpen = $state(false);
  let searchInput = $state<HTMLInputElement | null>(null);
  let selectedId = $state<string | null>(null);
  let confirmingClear = $state(false);

  const sessions = $derived(agentState.history);

  const filtered = $derived.by(() => {
    const q = query.trim().toLowerCase();
    if (!q) return sessions;
    return sessions.filter(
      (s) =>
        s.title.toLowerCase().includes(q) ||
        s.messages.some((m) => m.text.toLowerCase().includes(q)),
    );
  });

  const selected = $derived(filtered.find((s) => s.id === selectedId) ?? filtered[0] ?? null);

  /** 命中过滤后的消息，附带原始下标（`{#each}` 的键）与高亮片段。 */
  const shown = $derived.by(() => {
    const list = selected?.messages ?? [];
    const q = msgQuery.trim().toLowerCase();
    const rows = list.map((m, i) => ({ m, i }));
    if (!q) return rows;
    return rows.filter(({ m }) => `${entryTitle(m)} ${m.text}`.toLowerCase().includes(q));
  });

  const hits = $derived(shown.length);

  function select(id: string): void {
    selectedId = id;
    // 换会话就换一份正文：上一段的关键词留在这里只会让人以为这段也没有内容。
    msgQuery = '';
  }

  async function openSearch(): Promise<void> {
    searchOpen = true;
    // 等浮层真的进 DOM：先 focus 再渲染，输入法会落在别处（用户以为没打开）。
    await tick();
    searchInput?.focus();
    searchInput?.select();
  }

  /** 关掉浮层就清空关键词：否则「关了还在过滤」，看起来像丢了一半消息。 */
  function closeSearch(): void {
    searchOpen = false;
    msgQuery = '';
  }

  /*
   * Ctrl+F / ⌘F：抢浏览器自带的查找栏。它开在窗口右上角，会盖住面板标题那一带，
   * 而且搜的是整页文字（连左侧会话列表一起搜），在这个面板里没有意义。
   */
  $effect(() => {
    function onKeydown(e: KeyboardEvent): void {
      if (!(e.ctrlKey || e.metaKey) || e.altKey || e.key.toLowerCase() !== 'f') return;
      e.preventDefault();
      e.stopPropagation();
      if (searchOpen) closeSearch();
      else void openSearch();
    }
    window.addEventListener('keydown', onKeydown, true);
    return () => window.removeEventListener('keydown', onKeydown, true);
  });

  /** 把一段文本切成「命中 / 未命中」的片段（不用 innerHTML，避免 XSS 面）。 */
  function segments(text: string): { text: string; hit: boolean }[] {
    const q = msgQuery.trim().toLowerCase();
    if (!q) return [{ text, hit: false }];
    const lower = text.toLowerCase();
    const out: { text: string; hit: boolean }[] = [];
    let from = 0;
    for (;;) {
      const at = lower.indexOf(q, from);
      if (at < 0) break;
      if (at > from) out.push({ text: text.slice(from, at), hit: false });
      out.push({ text: text.slice(at, at + q.length), hit: true });
      from = at + q.length;
    }
    if (from < text.length) out.push({ text: text.slice(from), hit: false });
    return out;
  }

  function fmtTime(ts: number): string {
    if (!ts) return '—';
    const d = new Date(ts);
    const pad = (n: number): string => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
  }

  function roleLabel(role: AgentStoredMessage['role']): string {
    switch (role) {
      case 'user':
        return tr('agent.historyRole.user');
      case 'assistant':
        return tr('agent.historyRole.assistant');
      case 'reasoning':
        return tr('agent.historyRole.reasoning');
      case 'tool':
        return tr('agent.historyRole.tool');
      case 'image':
        return tr('agent.historyRole.image');
      default:
        return tr('agent.historyRole.error');
    }
  }

  function entryTitle(m: AgentStoredMessage): string {
    if (m.role === 'tool') return m.toolName ? toolLabel(m.toolName) : tr('agent.historyRole.tool');
    return roleLabel(m.role);
  }

  function resume(): void {
    if (!selected || agentState.busy) return;
    agentState.restoreSession(selected);
  }

  function clearAll(): void {
    confirmingClear = false;
    agentState.clearHistory();
    selectedId = null;
    msgQuery = '';
  }

  function remove(s: AgentSessionRecord): void {
    agentState.deleteSession(s.id);
    if (selectedId === s.id) selectedId = null;
  }
</script>

{#snippet marked(text: string)}
  {#each segments(text) as seg, k (k)}{#if seg.hit}<mark>{seg.text}</mark>{:else}{seg.text}{/if}{/each}
{/snippet}

<Modal
  title={tr('agent.history')}
  testid="agent-history-modal"
  width="split"
  flushBody
  onclose={onclose}
>
  <div class="history">
    <aside class="list-col" data-testid="agent-history-sidebar">
      <div class="search">
        <Icon name="search" size={12} />
        <input
          type="text"
          data-exempt
          spellcheck="false"
          data-testid="agent-history-search"
          placeholder={tr('agent.historySearch')}
          bind:value={query}
        />
        {#if sessions.length}
          <IconButton
            icon="trash"
            label={tr('agent.historyClear')}
            size="sm"
            testid="agent-history-clear"
            onclick={() => (confirmingClear = true)}
          />
        {/if}
      </div>

      {#if filtered.length === 0}
        <p class="empty">
          {query.trim() ? tr('agent.historyNoMatch') : tr('agent.historyEmpty')}
        </p>
      {:else}
        <div class="list">
          {#each filtered as s (s.id)}
            <div class="item" class:active={selected?.id === s.id}>
              <button
                type="button"
                class="item-main"
                data-testid="agent-history-item"
                onclick={() => select(s.id)}
              >
                <span class="item-title">{s.title || tr('agent.historyUntitled')}</span>
                <span class="item-meta">
                  {tr('agent.historyMeta', { n: s.messages.length, time: fmtTime(s.updatedAt) })}
                </span>
              </button>
              <IconButton
                icon="trash"
                label={tr('agent.historyDelete')}
                size="sm"
                testid="agent-history-delete"
                onclick={() => remove(s)}
              />
            </div>
          {/each}
        </div>
      {/if}
    </aside>

    <section class="detail-col" data-testid="agent-history-detail">
      {#if selected}
        <div class="detail-head">
          <span class="detail-title">{selected.title || tr('agent.historyUntitled')}</span>
          <span class="detail-meta">{fmtTime(selected.updatedAt)}</span>
          <Button
            label={tr('agent.historyResume')}
            variant="accent"
            size="sm"
            testid="agent-history-resume"
            disabled={agentState.busy}
            onclick={resume}
          />
        </div>
        <div class="body">
          <div class="messages">
            {#if shown.length === 0}
              <p class="empty">{tr('agent.historyMsgNoMatch')}</p>
            {:else}
              {#each shown as { m, i } (i)}
                <div class="entry {m.role}">
                  <div class="entry-head">
                    <span class="entry-role">{@render marked(entryTitle(m))}</span>
                    {#if m.role === 'tool' && m.toolStatus}
                      <span class="entry-status {m.toolStatus}">
                        {tr(m.toolStatus === 'error' ? 'agent.tool.error' : 'agent.tool.ok')}
                      </span>
                    {/if}
                    {#if m.ms !== undefined}<span class="entry-ms">{m.ms} ms</span>{/if}
                  </div>
                  {#if m.text}
                    <div class="entry-text">{@render marked(m.text)}</div>
                  {/if}
                </div>
              {/each}
            {/if}
          </div>

          <!--
            正文搜索**只在 Ctrl+F 时浮出来**：面板里已经有一个会话搜索，两个搜索框并排
            出现时没人分得清哪个在过滤什么。关掉即清空关键词（否则「关了还在过滤」）。
          -->
          {#if searchOpen}
            <div class="float-search" data-testid="agent-history-msg-search">
              <Icon name="search" size={12} />
              <input
                type="text"
                data-exempt
                spellcheck="false"
                bind:this={searchInput}
                bind:value={msgQuery}
                placeholder={tr('agent.historyMsgSearch')}
              />
              {#if msgQuery.trim()}
                <span class="hits" data-testid="agent-history-msg-count">
                  {tr('agent.historyMsgHits', { n: hits, total: selected.messages.length })}
                </span>
              {/if}
              <IconButton
                icon="x"
                label={tr('common.close')}
                size="sm"
                testid="agent-history-msg-close"
                onclick={closeSearch}
              />
            </div>
          {/if}
        </div>
      {:else}
        <p class="empty">{tr('agent.historyEmpty')}</p>
      {/if}
    </section>
  </div>

  {#snippet footer()}
    <Button
      label={tr('agent.exportLog')}
      variant="ghost"
      testid="agent-history-export"
      onclick={() => agentState.exportLog()}
    />
    <Button label={tr('common.close')} variant="outline" testid="agent-history-close" onclick={onclose} />
  {/snippet}
</Modal>

{#if confirmingClear}
  <ConfirmDialog
    title={tr('agent.historyClearTitle')}
    message={tr('agent.historyClearBody', { n: sessions.length })}
    confirmLabel={tr('agent.historyClear')}
    cancelLabel={tr('common.cancel')}
    danger
    testid="agent-history-confirm-clear"
    onconfirm={clearAll}
    oncancel={() => (confirmingClear = false)}
  />
{/if}

<style>
  /*
   * 两栏各自滚动：`.history` 撑满 Modal 的固定主体（`width="split"` + `flushBody`），
   * 左栏是**悬浮的**卡片（自己的背景 / 边框 / 滚动条），右栏按剩余宽度铺开。
   * 谁都不许把外层撑高 —— 一旦外层有滚动条，两栏就又会一起滚。
   */
  .history {
    display: grid;
    grid-template-columns: 248px minmax(0, 1fr);
    /* 唯一一行吃满高度：两栏的高度必须确定，否则它们的 overflow 没有依据，
       滚动条会落到外层（`.modal-body` 已经 flush，外层的表现是内容被切掉）。 */
    grid-template-rows: minmax(0, 1fr);
    gap: var(--sp-4);
    flex: 1;
    min-width: 0;
    min-height: 0;
    padding: var(--sp-4) var(--sp-5) var(--sp-4);
  }
  .list-col {
    display: flex;
    flex-direction: column;
    min-height: 0;
    padding: var(--sp-2);
    background: var(--surface-2);
    border: 1px solid var(--border);
    border-radius: var(--radius-md);
    overflow: hidden;
  }
  .search {
    display: flex;
    align-items: center;
    gap: var(--sp-2);
    flex-shrink: 0;
    padding: 2px var(--sp-2);
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    background: var(--surface-0);
    color: var(--text-muted);
  }
  .search:focus-within {
    border-color: var(--accent);
  }
  .search input {
    flex: 1;
    min-width: 0;
    height: 24px;
    background: transparent;
    border: none;
    color: var(--text-primary);
    font-family: inherit;
    font-size: 11px;
  }
  .search input:focus {
    outline: none;
  }
  .list {
    flex: 1;
    min-height: 0;
    overflow-y: auto;
    margin-top: var(--sp-2);
  }
  .item {
    display: flex;
    align-items: center;
    gap: 2px;
    border-radius: var(--radius-sm);
  }
  .item:hover {
    background: var(--surface-hover);
  }
  .item.active {
    background: var(--accent-weak);
  }
  .item-main {
    flex: 1;
    min-width: 0;
    padding: 5px var(--sp-2);
    background: transparent;
    border: none;
    color: var(--text-secondary);
    text-align: left;
    cursor: pointer;
  }
  .item-title {
    display: block;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    color: var(--text-primary);
    font-size: var(--fs-sm);
  }
  .item-meta {
    display: block;
    margin-top: 1px;
    color: var(--text-muted);
    font-size: 10px;
    font-variant-numeric: tabular-nums;
  }
  .empty {
    padding: var(--sp-4) var(--sp-2);
    color: var(--text-muted);
    font-size: 11px;
    line-height: 1.6;
  }
  .detail-col {
    display: flex;
    flex-direction: column;
    min-height: 0;
    min-width: 0;
    user-select: text;
  }
  .detail-head {
    display: flex;
    align-items: center;
    gap: var(--sp-2);
    flex-shrink: 0;
    padding-bottom: var(--sp-2);
    border-bottom: 1px solid var(--border);
  }
  .detail-title {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    color: var(--text-primary);
    font-size: var(--fs-md);
    font-weight: 500;
  }
  .detail-meta {
    color: var(--text-muted);
    font-size: 10px;
    font-variant-numeric: tabular-nums;
  }
  /* 正文 + 它的浮层：浮层定位在这块上面，不占行高（开关它不该让正文跳一下）。 */
  .body {
    position: relative;
    display: flex;
    flex-direction: column;
    flex: 1;
    min-height: 0;
  }
  .float-search {
    position: absolute;
    top: var(--sp-2);
    right: var(--sp-2);
    z-index: 2;
    display: flex;
    align-items: center;
    gap: var(--sp-2);
    width: 300px;
    max-width: calc(100% - var(--sp-4));
    padding: 2px var(--sp-2);
    background: var(--surface-2);
    border: 1px solid var(--border-strong, var(--border));
    border-radius: var(--radius-md);
    color: var(--text-muted);
  }
  .float-search input {
    flex: 1;
    min-width: 0;
    height: 24px;
    background: transparent;
    border: none;
    color: var(--text-primary);
    font-family: inherit;
    font-size: 11px;
  }
  .float-search input:focus {
    outline: none;
  }
  .hits {
    flex-shrink: 0;
    color: var(--text-muted);
    font-size: 10px;
    font-variant-numeric: tabular-nums;
  }
  .messages {
    flex: 1;
    min-height: 0;
    overflow-y: auto;
    padding-top: var(--sp-3);
  }
  .entry {
    padding: 4px var(--sp-2);
    border-left: 2px solid var(--border);
    margin-bottom: var(--sp-2);
  }
  .entry.user {
    border-left-color: var(--accent);
  }
  .entry.tool {
    border-left-color: var(--border-strong, var(--border));
  }
  .entry.error {
    border-left-color: var(--danger);
  }
  .entry-head {
    display: flex;
    align-items: center;
    gap: var(--sp-2);
    color: var(--text-muted);
    font-size: 10px;
  }
  .entry-role {
    color: var(--text-secondary);
  }
  .entry-status.ok {
    color: var(--success);
  }
  .entry-status.error {
    color: var(--danger);
  }
  .entry-ms {
    font-variant-numeric: tabular-nums;
  }
  .entry-text {
    margin-top: 2px;
    color: var(--text-primary);
    font-size: 11px;
    line-height: 1.55;
    white-space: pre-wrap;
    word-break: break-word;
    max-height: 220px;
    overflow-y: auto;
  }
  mark {
    background: var(--accent-weak);
    color: var(--text-primary);
    border-radius: 2px;
  }
</style>
