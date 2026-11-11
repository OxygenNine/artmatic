<script lang="ts">
  /**
   * RailShell.svelte — 左侧窄栏的**外观骨架**（纯展示，不 import appState）。
   *
   * ## 为什么单独抽一层
   *
   * 硬要求是「rail 在每个界面都一致」。主应用与 `/lab/` 试炼场是两个独立的
   * Vite 入口，lab 刻意**不引主应用的图**（否则会把工程/导出/排版整棵子树
   * 拖进 lab 的 bundle，`lab.spec.ts` 还断言过 lab 里没有 `window.__artmatic`）。
   *
   * 所以两边共用的是**这个骨架**：三角色分块（品牌 / 主操作 / 底部），
   * 内容由 snippets 注入。放在 `src/ui/` 而不是 `lab/`，因为它不含任何
   * 应用状态 —— 谁都能用，谁用都不会因此背上对方的依赖。
   *
   * 块的划分不是随意切的：它对应「品牌 → 当前在做的事 → 怎么看待这个工具」
   * 三个层次，主应用与 lab 各自往里填。`rail-spacer` 把最后一组推到底部。
   */
  import type { Snippet } from 'svelte';

  interface Props {
    /** ① 品牌 / 身份。 */
    brand: Snippet;
    /** ② 主操作（当前视图相关的东西）。 */
    main: Snippet;
    /** ③ 底部（设置、主题、跳转）。 */
    bottom: Snippet;
    /** 测试用的钩子。lab 用 `lab-rail`，与主应用区分开。 */
    testid?: string;
  }
  const { brand, main, bottom, testid = 'rail' }: Props = $props();
</script>

<aside class="rail" data-testid={testid}>
  <div class="rail-block">{@render brand()}</div>
  <!-- 插件图标会长进来：这一块必须能滚动，否则装了几个插件之后底部的设置组被挤出屏幕。 -->
  <div class="rail-block rail-main">{@render main()}</div>
  <div class="rail-spacer"></div>
  <div class="rail-block">{@render bottom()}</div>
</aside>

<style>
  .rail {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: var(--sp-2);
    width: var(--rail-w);
    flex-shrink: 0;
    padding: var(--sp-3) 0;
    background: var(--rail-bg);
    border-right: 1px solid var(--rail-border);
    overflow: hidden;
  }
  .rail-block {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: var(--sp-2);
  }
  /*
   * 主操作块：空间不足时**内部滚动**（沿用 `GradeRail` 的做法，滚动条隐藏）。
   * 必须 `min-height: 0` —— flex 子项的默认最小高度是内容高度，
   * 不给它归零时这一块会把整个 rail 撑高、`overflow` 永远不触发。
   */
  .rail-main {
    flex: 0 1 auto;
    min-height: 0;
    overflow-y: auto;
    scrollbar-width: none;
  }
  .rail-main::-webkit-scrollbar {
    display: none;
  }
  .rail-spacer {
    flex: 1;
    min-height: 0;
  }
</style>
