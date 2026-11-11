<script lang="ts">
  /**
   * AssetField — `asset` 型参数的控件：显示已绑素材的缩略图 + 选择 / 解绑。
   *
   * 与 `PatternField` 的「从素材导入」不同：这里**存的是引用**（assetId），
   * 不把图片烘成位图。选中的素材由渲染侧的 `AssetResolver` 解码，
   * 于是换一张图不需要重跑几千步模拟（精灵贴图是 volatile 参数）。
   *
   * 数据源是注入的（主应用给媒体池、lab 可以不给），组件不 import appState。
   */
  import Button from './Button.svelte';
  import Field from './Field.svelte';
  import Icon from '../Icon.svelte';
  import AssetPickerModal from '../pattern/AssetPickerModal.svelte';
  import type { PatternAssetItem } from '../pattern/pattern-import';
  import { tr } from '../../i18n/index.svelte';
  import type { MessageKey } from '../../i18n/locales';

  interface Props {
    label: string;
    value: string;
    /** 可选的图片列表。不给时只显示当前值，不显示「选择」按钮。 */
    items?: () => PatternAssetItem[];
    onchange: (assetId: string) => void;
    testid?: string;
    emptyKey?: MessageKey;
    chooseKey?: MessageKey;
    unbindKey?: MessageKey;
    titleKey?: MessageKey;
  }

  const {
    label,
    value,
    items,
    onchange,
    testid = 'asset-field',
    emptyKey = 'asset.field.empty',
    chooseKey = 'asset.field.choose',
    unbindKey = 'asset.field.unbind',
    titleKey = 'asset.field.title',
  }: Props = $props();

  let pickerOpen = $state(false);

  const current = $derived.by(() => {
    const list = items?.() ?? [];
    return list.find((i) => i.id === value) ?? null;
  });
  // 素材被删 / 工程里 assetId 悬空：显示 id 而不是假装没绑，
  // 让用户看得见「这里有个断掉的引用」。
  const displayName = $derived(current?.name ?? (value ? value : tr(emptyKey)));
</script>

<Field {label}>
  <div class="asset-row" data-testid={testid} data-asset-id={value}>
    <span class="asset-thumb">
      {#if current?.thumb}
        <img src={current.thumb} alt="" loading="lazy" />
      {:else}
        <Icon name="image" size={15} />
      {/if}
    </span>
    <span class="asset-name" title={displayName}>{displayName}</span>
    {#if items}
      <Button label={tr(chooseKey)} variant="outline" testid={`${testid}-choose`} onclick={() => (pickerOpen = true)} />
    {/if}
    {#if value}
      <Button label={tr(unbindKey)} variant="ghost" testid={`${testid}-unbind`} onclick={() => onchange('')} />
    {/if}
  </div>
</Field>

{#if pickerOpen && items}
  <AssetPickerModal
    items={items()}
    {titleKey}
    onpick={(id) => {
      onchange(id);
      pickerOpen = false;
    }}
    onclose={() => (pickerOpen = false)}
  />
{/if}

<style>
  .asset-row {
    display: flex;
    align-items: center;
    gap: var(--sp-2);
    min-width: 0;
  }
  .asset-thumb {
    flex: 0 0 auto;
    width: 26px;
    height: 26px;
    display: grid;
    place-items: center;
    border: 1px solid var(--line);
    border-radius: var(--radius-sm);
    background: var(--surface-2);
    overflow: hidden;
    color: var(--text-dim);
  }
  .asset-thumb img {
    width: 100%;
    height: 100%;
    object-fit: cover;
  }
  .asset-name {
    flex: 1 1 auto;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-size: var(--fs-sm);
    color: var(--text);
  }
</style>
