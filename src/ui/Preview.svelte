<script lang="ts">
  import { onMount } from 'svelte';
  import { appState } from './app-state.svelte';
  import PreviewToolbar from './PreviewToolbar.svelte';
  import QuadHandles from './QuadHandles.svelte';
  import { tr } from '../i18n/index.svelte';

  let host: HTMLDivElement;
  /*
   * canvas 与包住它的 stage 都用 `$state`：它们会作为 prop 传给 QuadHandles
   * （模板里的响应式读取），而 `bind:this` 给普通 `let` 赋值会让 svelte-check
   * 报 non_reactive_update。两者在挂载时都必然已被绑定，null 只是类型上的
   * 「还没挂上」那一瞬间。
   */
  let canvas = $state<HTMLCanvasElement | null>(null);
  let stageEl = $state<HTMLDivElement | null>(null);
  let splitLeft: HTMLCanvasElement;
  let splitRight: HTMLCanvasElement;

  /**
   * 全屏预览。宿主是 `.preview` 这个容器（不是 canvas）—— 全屏时悬浮工具条
   * 与两帧并排浮层都该跟着铺满，只把 canvas 放大它们会被挤出视口。
   *
   * 退出全屏必须**关回** `setPreviewUpscale(false)`：那是「允许预览缓冲放大
   * 到显示尺寸」的开关（见 renderer.setAllowUpscale），忘了关的后果是窗口
   * 模式下预览也按屏幕尺寸分配缓冲 —— 小窗口里白烧一份全屏的显存。
   */
  let fullscreen = $state(false);

  /**
   * 还在异步链接的着色器数（> 0 时画面上压一个转圈）。
   *
   * 数据来自 rAF 循环里的一次纯内存读（`kit.pendingCompiles`），不是订阅 ——
   * 编译完成没有事件可订阅，而这一层本来每帧都在跑。**它存在的意义就是把
   * 「几十秒的无声冻屏」换成「几十秒的转圈」**：链接本身在驱动线程上，
   * 主线程不再被 `linkProgram` 卡住（见 `engine/kit.ts` 的 Program 注释）。
   */
  let compiling = $state(0);

  function toggleFullscreen(): void {
    const el = host;
    if (!el) return;
    if (document.fullscreenElement === el) {
      void document.exitFullscreen().catch(() => {});
    } else {
      // 老浏览器没有这个 API 时静默不做（按钮根本不该出现，见 supportsFullscreen）
      void el.requestFullscreen?.().catch(() => {});
    }
  }

  /**
   * 不支持 Fullscreen API 的宿主（旧浏览器 / 被嵌进没有 allowfullscreen 的
   * iframe）不显示按钮 —— `fullscreenEnabled` 对这两种情况都是 false。
   */
  const supportsFullscreen = $derived(
    typeof document !== 'undefined' && document.fullscreenEnabled === true,
  );

  /**
   * 「跨剪切点两帧预览」的**拖拽入口**。
   *
   * 播放头停在剪切点时，在预览画面上横向轻拖（越过这个阈值、且方向不限）就临时
   * 把「切点前一帧 / 切点后一帧」并排摊出来；松手收起。真正的取帧与拼图在
   * `appState.renderSplit`（走同一个 `renderFrame`），这里只负责把「在拖」这件事告诉它。
   *
   * 阈值 6px：与拖拽排序同一套纪律（AGENTS §6.7），免得 1~2px 抖动就把浮层闪出来。
   */
  const SPLIT_DRAG_MIN_PX = 6;
  let armed = false;
  let startX = 0;

  function armDrag(e: PointerEvent): void {
    if (e.button !== 0) return;
    const target = e.target as Element | null;
    /*
     * 吸管取色模式：画面上的下一次按下就是「取这个点的颜色」，不再 arm 并排预览。
     * 只认画面本体（canvas / stage），工具栏与它的弹层不接管 —— 否则点工具条
     * 会被当成取色。
     */
    const onScreen = target === canvas || target === stageEl;
    if (appState.keyPickClipId !== null) {
      if (!onScreen) return;
      e.preventDefault();
      appState.pickKeyColorAt(e.clientX, e.clientY);
      return;
    }
    // 只接画面本体与信箱边的按下；工具栏（含其下拉弹层）不接管。
    // stage 是包住 canvas 的相对定位容器（QuadHandles 的坐标基准），它同样属于画面。
    if (target !== host && target !== canvas && target !== stageEl) return;
    armed = true;
    startX = e.clientX;
  }

  function moveDrag(e: PointerEvent): void {
    if (!armed) return;
    if (Math.abs(e.clientX - startX) >= SPLIT_DRAG_MIN_PX) appState.setSplitDrag(true);
  }

  function endDrag(): void {
    armed = false;
    appState.setSplitDrag(false);
  }

  /*
   * 「偶发黑屏」的审查结论（2026-10-14）：
   *
   * 查过并**排除**的怀疑项：exportSize 泄漏（7 处 setExportSize 全都有配对的
   * clearExportSize）、缓冲尺寸被置 0/NaN（三条入口都把分辨率钳到 ≥16）、
   * 切排版页卸载 canvas（`.body.is-hidden` 只是 display:none，canvas 不离开 DOM）、
   * 切工程 / 开关抽屉 / 改分辨率（都只改 CSS 变量与 view，尺寸靠 syncSize + RO 重算）。
   *
   * **查实的两条**（都已修）：
   *  1. 这个 rAF 循环没有异常保护 —— `tick()` 抛出就跳过下一帧调度，循环**永久死亡**
   *     （表现：画面冻住或全黑，而播放头/底栏这些不依赖 WebGL 的东西照常动）。
   *     下面 try/catch 兜住它。
   *  2. `attachPreview` 不校验 canvas 身份，而 `Kit` 把 canvas 存死 —— 组件卸载重挂
   *     （dev 的组件级 HMR）会带来新 canvas，旧服务继续画在脱离 DOM 的那块上。
   *     修在 `app-state.svelte.ts::attachPreview`（比对身份 → 整块重建），
   *     顺带补上 `webglcontextlost / restored` 的处理。
   */
  onMount(() => {
    if (canvas) appState.attachPreview(canvas, host);
    appState.attachSplit(splitLeft, splitRight, host);
    // 点击预览区空白不做事；播放循环永远跑（渲染成本在预览尺寸下很低，
    // 永远渲染让「版本变化→画面更新」不需要额外订阅）。
    // 降帧率节流在 appState.tick() 里，只作用于播放中。
    let raf = 0;
    /** 累计抛错次数。同一个错误只报头一次与每 300 次一次，避免每帧刷屏。 */
    let tickErrors = 0;
    /*
     * 全屏状态同步。浏览器给的退出通道（Esc / F11）不走我们的按钮，
     * 所以必须听 `fullscreenchange`：只信按钮的那份状态会在用户按 Esc 之后
     * 一直停在「全屏中」，而预览缓冲还开着放大 —— 退出全屏画面反而更糊。
     */
    const onFullscreenChange = (): void => {
      const on = document.fullscreenElement === host;
      fullscreen = on;
      appState.setPreviewUpscale(on);
    };
    document.addEventListener('fullscreenchange', onFullscreenChange);
    /*
     * 吸管取色：Esc 退出模式。用**捕获**监听：取色是一次性模式，Esc 的第一语义
     * 就是「离开这个模式」，不该先去触发别的全局快捷键（本项目 App 的全局
     * keydown 里没有 Escape 分支，这里也 stopPropagation 保持这个约定）。
     */
    const onKeyDown = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape' || appState.keyPickClipId === null) return;
      e.preventDefault();
      e.stopPropagation();
      appState.cancelKeyPick();
    };
    window.addEventListener('keydown', onKeyDown, true);
    const loop = () => {
      /*
       * 渲染失败是「这一帧没画成」，不是「预览关机」。
       *
       * `tick()` 里跑的是整条渲染链：惰性编译着色器（特效 / 生成器 / 插件的语法
       * 错误就在这一刻抛）、GL 调用（上下文丢失后必抛）、排版位图上传。
       * 不兜住的话异常会跳过下面那行调度 —— 循环死掉且**没有任何入口能重启它**
       * （唯一的重启是刷新页面），这与「偶发黑屏、刷新才好」的形态完全一致。
       */
      try {
        appState.tick();
      } catch (e) {
        tickErrors += 1;
        if (tickErrors === 1 || tickErrors % 300 === 0) {
          console.error(`[preview] 渲染循环抛错（已兜住，不会停循环；第 ${tickErrors} 次）`, e);
        }
      }
      /*
       * 编译转圈：只有值变化才写（Svelte 的 $state 会在同值时不触发更新，
       * 但每帧读一次 `pendingCompiles` 是纯内存读，不碰 GL）。
       */
      compiling = appState.renderer?.kit.pendingCompiles ?? 0;
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    const onResize = () => appState.renderer.syncSize(appState.project.resolution);
    const ro = new ResizeObserver(onResize);
    ro.observe(host);
    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
      document.removeEventListener('fullscreenchange', onFullscreenChange);
      window.removeEventListener('keydown', onKeyDown, true);
    };
  });

  /*
   * 换选中片段 = 退出吸管取色：取色对象是「某个片段的键色」，选中变了还停在
   * 那个模式里，下一次点画面会改到用户已经不看的那条片段上。
   * 只读 selectedClipId / keyPickClipId，两者都是响应式的。
   */
  $effect(() => {
    const selected = appState.selectedClipId;
    void selected;
    const picking = appState.keyPickClipId;
    if (picking !== null && picking !== selected) appState.cancelKeyPick();
  });
</script>

<!--
  svelte-ignore a11y_no_static_element_interactions
  这里只是**拖拽热区**：画面本身由内部 `#gl` 承载，语义元素是它。给容器加 role
  反而会让屏幕阅读器多读一个空节点（与 NumberInput 同一套处理）。
-->
<div
  class="preview"
  bind:this={host}
  onpointerdown={armDrag}
  onpointermove={moveDrag}
  onpointerup={endDrag}
  onpointercancel={endDrag}
  onpointerleave={endDrag}
>
  <div class="pv-stage" class:key-pick={appState.keyPickClipId !== null} bind:this={stageEl}>
    <canvas bind:this={canvas} id="gl"></canvas>
    <!--
      四角调整手柄层。绝对定位铺满 stage（canvas 的显示盒由 renderer 用 CSS 钉住，
      stage 跟着它收缩），`pointer-events` 只在手柄本身打开。
      取色模式（keyPickClipId 非空）时 stage 显示 crosshair。
    -->
    <QuadHandles {canvas} stage={stageEl} />
  </div>
  <!--
    两帧并排浮层。`#gl` 是 static、这是 absolute → 它盖在 GL 画布上；工具栏在它之后
    渲染且同样 absolute → 仍在它之上。`pointer-events: none` 让拖拽事件照常穿到 `#gl`。
    关闭时 `display: none`（不是透明），所以「并排 / 单幅」在 DOM 上一眼可分。
  -->
  <div
    class="pv-split"
    class:on={appState.splitVisible}
    aria-label={tr('insp.cutPreview')}
    data-testid="split-view"
  >
    <canvas class="pv-split-panel" data-testid="split-left" bind:this={splitLeft}></canvas>
    <canvas class="pv-split-panel" data-testid="split-right" bind:this={splitRight}></canvas>
  </div>
  <!--
    着色器编译中的转圈。压在画面正中：编译期间这一层本来就没画东西（生成器的
    program 还没好，resolver 返回 null），所以挡住的是黑底而不是画面。
    `pointer-events: none` —— 它只是状态，不该吃掉画面的拖拽 / 取色。
  -->
  {#if compiling > 0}
    <div class="pv-compiling" role="status" aria-live="polite" data-testid="compiling">
      <span class="pv-spinner" aria-hidden="true"></span>
      <span>{tr('app.compilingShaders')}</span>
    </div>
  {/if}
  <PreviewToolbar {fullscreen} {supportsFullscreen} ontoggleFullscreen={toggleFullscreen} />
</div>

<style>
  .preview {
    position: relative;
    flex: 1;
    display: flex;
    align-items: center;
    justify-content: center;
    overflow: hidden;
    min-height: 0;
    background: #000;
  }
  #gl {
    max-width: 100%;
    max-height: 100%;
  }
  /*
   * 画面容器：canvas 与四角手柄层的共同坐标基准。
   *
   * 它只是把 canvas 包起来的 flex 盒（不改变 canvas 既有的 max-width/height
   * 行为）。**不能加 transform / filter**：QuadHandles 内部按 canvas 的
   * getBoundingClientRect 定位，祖先的这两种属性会改掉包含块（浮层坑）。
   */
  .pv-stage {
    position: relative;
    display: flex;
    align-items: center;
    justify-content: center;
    max-width: 100%;
    max-height: 100%;
    min-width: 0;
    min-height: 0;
  }
  /* 吸管取色模式：画面内光标变十字，告诉用户「现在点一下就是取色」。 */
  .pv-stage.key-pick,
  .pv-stage.key-pick #gl {
    cursor: crosshair;
  }
  /* 并排两帧：占满画面区域、居中、等宽。黑底先兜住「某侧没有片段」那种情况。 */
  .pv-split {
    position: absolute;
    inset: 0;
    display: none;
    align-items: center;
    justify-content: center;
    gap: 1px;
    background: #000;
    pointer-events: none;
  }
  .pv-split.on {
    display: flex;
  }
  .pv-split-panel {
    display: block;
  }
  /*
   * 编译中：居中一行「转圈 + 文字」。**不做背景遮罩** —— 编译时画面本来就在
   * 缺席状态，加一层半透明只会让「画面坏了」和「在忙」更难区分。
   */
  .pv-compiling {
    position: absolute;
    inset: 0;
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 10px;
    color: var(--text-secondary);
    font-size: 12px;
    letter-spacing: 0.02em;
    pointer-events: none;
  }
  .pv-spinner {
    width: 14px;
    height: 14px;
    border: 2px solid currentColor;
    border-right-color: transparent;
    border-radius: 50%;
    animation: pv-spin 0.85s linear infinite;
  }
  @keyframes pv-spin {
    to {
      transform: rotate(360deg);
    }
  }
  /* 动效关闭时保留一个静态的环：状态还在，只是不转（与 AgentRailButton 同一套）。 */
  @media (prefers-reduced-motion: reduce) {
    .pv-spinner {
      animation: none;
      border-right-color: currentColor;
      opacity: 0.45;
    }
  }
</style>
