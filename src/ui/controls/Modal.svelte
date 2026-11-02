<script lang="ts">
  /**
   * Modal — 覆盖全屏的模态面板。窄侧栏的四个入口（关于 / 快捷键 / 导出 / 设置）
   * 都用它，而不是浮在图标旁边的 popover。
   *
   * 为什么改成 modal：flyout 只有两百来像素宽，塞下快捷键清单或导出历史就会被
   * 挤成一个带滚动条的小盒子；而这几块以后只会继续长（导出格式、更多设置项）。
   * 现在留白多一点没关系。
   */
  import type { Snippet } from 'svelte';
  import IconButton from './IconButton.svelte';
  import { tr } from '../../i18n/index.svelte';
  import { appState } from '../app-state.svelte';

  interface Props {
    title: string;
    onclose: () => void;
    testid?: string;
    /**
     * 内容宽度：'wide' 给两栏内容（快捷键清单）。
     * 'tall' 是「侧栏 + 内容」型面板（设置）：宽度同 normal，
     * 但**高度固定**——左侧的 navside 需要一条确定的竖直空间，
     * 高度随内容变的话切换分页时整个框会跳一下。
     * 'picker' 是「工具栏 + 可滚动主体 + 底栏」型（特效选择器）：比 normal 宽
     * （一排要放下三到四张缩略图），高度也固定（网格/列表切换、筛选展开收起
     * 都不该让整个框跳高跳矮）。
     */
    width?: 'normal' | 'wide' | 'tall' | 'picker';
    /** 顶部徽标区（如大 logo）。 */
    hero?: Snippet;
    /**
     * 底部操作条。给了才渲染——没有底部动作的面板（关于 / 快捷键）
     * 不该凭空多出一条空白带。
     */
    footer?: Snippet;
    /**
     * 去掉 body 的内边距与滚动，交给内容自己管。
     * 「侧栏 + 内容」型面板需要这个：navside 的背景要顶到边，
     * 而滚动只能发生在右侧内容列里。
     */
    flushBody?: boolean;
    children: Snippet;
  }
  const {
    title,
    onclose,
    testid,
    width = 'normal',
    hero,
    footer,
    flushBody = false,
    children,
  }: Props = $props();

  /**
   * 把遮罩挂到 `document.body`。
   *
   * 抽屉（媒体池 / 检查器 / Agent）都带 `z-index: var(--z-drawer)`，是一个
   * **层叠上下文**：modal 留在抽屉里时，它自己的 `z-modal(150)` 只在这一层内
   * 有效。检查器与它同层、DOM 更靠后，就会盖住遮罩右侧 —— 表现是「弹窗开着，
   * 右边检查器还是亮的」。
   *
   * 挂到 body 之后 modal 回到根上下文，`z-modal` 才真的是全局最上层。
   * 这是 `ui/AGENTS.md` 里「浮层不要挂在带 z-index 的祖先里」那条规则的
   * 组件级兜底：以后任何抽屉里打开 Modal 都不会再踩一次。
   */
  function portal(node: HTMLElement): { destroy: () => void } {
    document.body.appendChild(node);
    return {
      destroy() {
        node.remove();
      },
    };
  }

  function onkeydown(e: KeyboardEvent): void {
    if (e.key !== 'Escape') return;
    // 阻止冒泡：否则会顺带关掉底下的菜单 / 触发其它 Esc 处理
    e.preventDefault();
    e.stopPropagation();
    onclose();
  }

  /**
   * 遮罩点击是否从**遮罩本身**开始。
   *
   * 只看 click 的 target 不够：在面板里按下、拖到外面松手时，click 的目标是
   * 「按下点与松手点的最近公共祖先」= 遮罩，于是拖动会顺手把弹窗关掉
   * （预剪辑拖 in/out 出界就是这个问题）。记录 pointerdown 是否真的落在遮罩上。
   */
  let backdropDown = false;
  function onBackdropDown(e: PointerEvent): void {
    backdropDown = e.target === e.currentTarget;
  }
  function onBackdropClick(e: MouseEvent): void {
    const fromBackdrop = backdropDown && e.target === e.currentTarget;
    backdropDown = false;
    if (fromBackdrop) onclose();
  }

  /*
   * 模态期间全局快捷键必须让路（见 `appState.modalDepth`）。用计数而不是布尔：
   * 转场选择器可以从设置里再叠一层，先进先出不能互相覆盖。
   */
  $effect(() => {
    appState.modalDepth += 1;
    return () => {
      appState.modalDepth -= 1;
    };
  });

  $effect(() => {
    window.addEventListener('keydown', onkeydown, true);
    return () => window.removeEventListener('keydown', onkeydown, true);
  });
</script>

<!-- svelte-ignore a11y_click_events_have_key_events -->
<!-- svelte-ignore a11y_no_static_element_interactions -->
<div
  class="backdrop"
  use:portal
  data-testid={testid ? `${testid}-backdrop` : undefined}
  onpointerdown={onBackdropDown}
  onclick={onBackdropClick}
>
  <!--
    `data-paper`：进入「纸面」上下文（灰色模式下弹窗是浅灰底 + 黑字，见
    tokens.ts 的 PAPER）。这个属性在亮 / 暗 / 高对比度下是**空操作** ——
    那三套模式的纸面值就是它们自己的语义值。
  -->
  <div
    class="modal {width}"
    role="dialog"
    aria-modal="true"
    aria-label={title}
    tabindex="-1"
    data-paper=""
    data-testid={testid}
    onclick={(e) => e.stopPropagation()}
  >
    <header class="modal-head">
      <h2>{title}</h2>
      <IconButton
        icon="x"
        label={tr('common.close')}
        testid={testid ? `${testid}-close` : 'modal-close'}
        onclick={onclose}
      />
    </header>
    {#if hero}
      <div class="modal-hero">{@render hero()}</div>
    {/if}
    <div class="modal-body" class:flush={flushBody}>
      {@render children()}
    </div>
    {#if footer}
      <footer class="modal-foot">{@render footer()}</footer>
    {/if}
  </div>
</div>

<style>
  .backdrop {
    position: fixed;
    inset: 0;
    z-index: var(--z-modal);
    display: flex;
    align-items: center;
    justify-content: center;
    /* 纯色半透明遮罩，不用模糊/渐变（视觉纪律：零阴影零渐变） */
    background: var(--overlay);
    /* 只做透明度入场：这里的 transform 会让内部 fixed Select 的包含块变成
       遮罩，弹层定位会整体偏掉（见 src/ui/AGENTS.md 的浮层纪律）。 */
    animation: modal-fade-in var(--motion-duration-modal, 140ms) var(--motion-ease, ease-out)
      backwards;
  }
  .modal {
    display: flex;
    flex-direction: column;
    width: min(760px, 88vw);
    max-height: 84vh;
    background: var(--surface-1);
    border: 1px solid var(--border);
    border-radius: var(--radius-md);
    overflow: hidden;
    animation: modal-panel-in var(--motion-duration-modal, 140ms) var(--motion-ease, ease-out)
      backwards;
  }
  .modal.wide {
    width: min(1080px, 92vw);
  }
  .modal.tall {
    /* 固定高度：侧栏需要确定的竖直空间（见 Props.width 的注释）。 */
    height: min(600px, 84vh);
  }
  .modal.picker {
    /* 同上：固定高度，切视图 / 展开筛选都不跳。宽度要放得下一排 3–4 张 16:9 卡。 */
    width: min(920px, 94vw);
    height: min(660px, 88vh);
  }
  .modal-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--sp-4);
    flex-shrink: 0;
    height: 40px;
    padding: 0 var(--sp-3) 0 var(--sp-5);
    border-bottom: 1px solid var(--border);
  }
  h2 {
    margin: 0;
    color: var(--text-primary);
    font-size: var(--fs-md);
    font-weight: 600;
    letter-spacing: 0.02em;
  }
  .modal-hero {
    display: flex;
    align-items: center;
    justify-content: center;
    gap: var(--sp-5);
    flex-shrink: 0;
    padding: var(--sp-6) 0;
    border-bottom: 1px solid var(--border);
  }
  .modal-body {
    flex: 1;
    min-height: 0;
    overflow-y: auto;
    padding: var(--sp-5);
  }
  /* 交给内容自己管：navside 的背景要顶到边，滚动只发生在内容列。 */
  .modal-body.flush {
    overflow: hidden;
    padding: 0;
    display: flex;
    min-width: 0;
  }
  .modal-foot {
    display: flex;
    align-items: center;
    justify-content: flex-end;
    gap: var(--sp-3);
    flex-shrink: 0;
    padding: 0 var(--sp-5);
    height: 46px;
    border-top: 1px solid var(--border);
  }

  @keyframes modal-fade-in {
    from {
      opacity: 0;
    }
    to {
      opacity: 1;
    }
  }
  @keyframes modal-panel-in {
    from {
      opacity: 0;
      transform: scale(0.9);
    }
    to {
      opacity: 1;
      transform: scale(1);
    }
  }

  /* 系统偏好优先于应用内开关。只关这个组件的动画，不用全局 * ——
     排版文档里的用户动画不属于界面微动效。 */
  @media (prefers-reduced-motion: reduce) {
    .backdrop,
    .modal {
      animation: none;
    }
  }
</style>
