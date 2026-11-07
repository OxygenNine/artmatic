<script lang="ts">
  /**
   * AssetPickerModal — 从媒体池挑一张图片（图案导入用）。
   *
   * 只列**图片**：图案是二值位图，视频 / 音频在这里没有语义。缺字节的条目
   * 直接禁用而不是隐藏 —— 用户会奇怪「我明明导入过这张图」，而列表里少一条
   * 比一条灰掉的更让人怀疑。
   *
   * **不 import appState**：列表由宿主通过 `items` 给进来（见
   * `pattern-import.ts` 的文件头 —— 这个组件也会被 `/lab/` 的图案编辑器用到）。
   */
  import Modal from '../controls/Modal.svelte';
  import Icon from '../Icon.svelte';
  import { tr } from '../../i18n/index.svelte';
  import type { MessageKey } from '../../i18n/locales';
  import type { PatternAssetItem } from './pattern-import';

  interface Props {
    items: PatternAssetItem[];
    onpick: (assetId: string) => void;
    onclose: () => void;
    /** 标题文案键。缺省是图案导入；粒子素材用 `algo.particles.asset.title`。 */
    titleKey?: MessageKey;
  }
  const { items, onpick, onclose, titleKey = 'algo.pattern.importTitle' }: Props = $props();

  function pick(it: PatternAssetItem): void {
    if (it.missing) return;
    onpick(it.id);
  }
</script>

<Modal title={tr(titleKey)} width="normal" {onclose} testid="pattern-asset-picker">
  {#if items.length === 0}
    <p class="pat-empty" data-testid="pattern-asset-empty">{tr('algo.pattern.importEmpty')}</p>
  {:else}
    <div class="pat-list">
      {#each items as it (it.id)}
        <button
          type="button"
          class="pat-row"
          class:missing={it.missing}
          disabled={it.missing}
          data-testid="pattern-asset-item"
          data-asset-id={it.id}
          onclick={() => pick(it)}
        >
          <span class="pat-thumb">
            {#if it.thumb}
              <img src={it.thumb} alt="" loading="lazy" />
            {:else}
              <Icon name="image" size={16} />
            {/if}
          </span>
          <span class="pat-name" title={it.name}>{it.name}</span>
          {#if it.w && it.h}<span class="pat-dim">{it.w}×{it.h}</span>{/if}
        </button>
      {/each}
    </div>
  {/if}
</Modal>

<style>
  .pat-empty {
    margin: 0;
    color: var(--text-muted);
    font-size: var(--fs-sm);
  }
  .pat-list {
    display: flex;
    flex-direction: column;
    gap: 2px;
    max-height: 420px;
    overflow-y: auto;
  }
  .pat-row {
    display: flex;
    align-items: center;
    gap: var(--sp-2);
    padding: var(--sp-1) var(--sp-2);
    background: none;
    border: 1px solid transparent;
    border-radius: var(--radius-sm);
    color: var(--text-primary);
    font: inherit;
    text-align: left;
    cursor: pointer;
  }
  .pat-row:hover:not(:disabled) {
    background: var(--surface-2);
    border-color: var(--border);
  }
  .pat-row.missing {
    opacity: 0.45;
    cursor: default;
  }
  .pat-thumb {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 44px;
    height: 28px;
    flex-shrink: 0;
    overflow: hidden;
    background: var(--surface-2);
    border-radius: var(--radius-sm);
  }
  .pat-thumb img {
    max-width: 100%;
    max-height: 100%;
    object-fit: contain;
  }
  .pat-name {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .pat-dim {
    color: var(--text-muted);
    font-size: var(--fs-xs);
    font-variant-numeric: tabular-nums;
  }
</style>
