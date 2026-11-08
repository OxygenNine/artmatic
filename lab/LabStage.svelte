<script lang="ts">
  /**
   * LabStage — 中栏：画布 + 工具栏。
   *
   * 工具栏里有两个 openmosh lab 的做法值得留着：
   *   - **按住 B 旁路**：审特效时"改之前 / 改之后"的对比要按着看才顺手，
   *     点一下切换反而会忘记自己现在看的是哪一版。
   *   - **分辨率档位**：审一个特效不该先被帧率绑架；先 25% 看行为，
   *     决定留下了再上 100% 看画质。
   */
  import { onMount } from 'svelte';
  import IconButton from '../src/ui/controls/IconButton.svelte';
  import Button from '../src/ui/controls/Button.svelte';
  import Slider from '../src/ui/controls/Slider.svelte';
  import Select from '../src/ui/controls/Select.svelte';
  import { labState, LAB_SCALES, type LabScale } from './lab-state.svelte';
  import { LAB_DURATION, LAB_FPS } from './build-project';
  import { SHOT_HEIGHTS, type ShotHeight } from './export-thumbs';
  import { tr } from '../src/i18n/index.svelte';

  let canvas: HTMLCanvasElement;

  onMount(() => {
    labState.attach(canvas);
  });

  const scaleOptions = LAB_SCALES.map((s) => ({
    value: String(s),
    label: `${Math.round(s * 100)}%`,
  }));
  const shotHeightOptions = SHOT_HEIGHTS.map((h) => ({ value: String(h), label: `${h}p` }));

  const compiled = $derived(labState.compileResults);
  const okCount = $derived(labState.compiledOkCount());
  const badCount = $derived((compiled?.length ?? 0) - okCount);
  const shotProgress = $derived(labState.shotProgress);
</script>

<main class="lab-stage-wrap">
  <div class="lab-stage">
    <canvas class="lab-canvas" bind:this={canvas} data-testid="lab-canvas"></canvas>
    {#if labState.compilePending > 0}
      <div class="lab-compiling" data-testid="lab-compiling">
        <span class="lab-spinner" aria-hidden="true"></span>
        <span>{tr('app.compilingShaders')}</span>
      </div>
    {/if}
  </div>

  <div class="lab-toolbar">
    <IconButton
      icon={labState.playing ? 'pause' : 'play'}
      label={labState.playing ? tr('lab.pause') : tr('lab.play')}
      tipPlacement="top"
      testid="lab-play"
      active={labState.playing}
      onclick={() => labState.togglePlay()}
    />
    <IconButton
      icon="arrow-left"
      label={tr('lab.stepBack')}
      tipPlacement="top"
      testid="lab-step-prev"
      onclick={() => labState.stepFrames(-1)}
    />
    <IconButton
      icon="arrow-right"
      label={tr('lab.stepForward')}
      tipPlacement="top"
      testid="lab-step-next"
      onclick={() => labState.stepFrames(1)}
    />

    <span class="lab-time">
      <Slider
        value={labState.t}
        min={0}
        max={LAB_DURATION}
        step={1 / LAB_FPS}
        ariaLabel={tr('lab.timeLabel')}
        testid="lab-time"
        oninput={(v) => labState.setT(v)}
      />
      <span class="lab-readout" data-testid="lab-time-readout">{labState.t.toFixed(2)}s</span>
    </span>

    <Select
      value={String(labState.scale)}
      options={scaleOptions}
      ariaLabel={tr('lab.scale')}
      tipText={tr('lab.scale')}
      testid="lab-scale"
      optionTestidPrefix="lab-scale-opt"
      minWidth={80}
      onchange={(v) => labState.setScale(Number(v) as LabScale)}
    />

    <!--
      旁路按钮是 lab 本地实现，不用 ui/controls/Button：那个组件只透出
      onclick，而「按住看原图」要的是 pointerdown/up。写法上也不去蹭全局的
      `.btn` 类名 —— 蹭了会踩 AGENTS §7 的全局类名坑（单测的扫描范围包含 lab/）。
    -->
    <button
      type="button"
      class="lab-bypass"
      class:lab-bypass-on={labState.bypass}
      aria-pressed={labState.bypass}
      title={tr('lab.bypassHint')}
      data-testid="lab-bypass"
      onpointerdown={() => labState.setBypass(true)}
      onpointerup={() => labState.setBypass(false)}
      onpointerleave={() => labState.setBypass(false)}
    >
      {tr('lab.bypass')}
    </button>

    <Button
      label={tr('lab.compileAll')}
      icon="combine"
      variant="outline"
      tipPlacement="top"
      testid="lab-compile-all"
      onclick={() => labState.runCompile()}
    />

    <!--
      导出截图：把缩略图变成**预先准备好的静态图**，而不是每次开选择器现渲。
      单张给的是「当前画面」（比右键另存为省事），批量给的是整套（按目录底图）。
    -->
    <Button
      label={tr('lab.shot')}
      icon="download"
      variant="outline"
      tipText={tr('lab.shotTip')}
      tipPlacement="top"
      testid="lab-shot"
      onclick={() => void labState.exportShot()}
    />
    <Select
      value={String(labState.shotHeight)}
      options={shotHeightOptions}
      ariaLabel={tr('lab.shotHeight')}
      tipText={tr('lab.shotHeight')}
      testid="lab-shot-height"
      optionTestidPrefix="lab-shot-height-opt"
      minWidth={76}
      onchange={(v) => (labState.shotHeight = Number(v) as ShotHeight)}
    />
    <Button
      label={tr('lab.shotAll')}
      icon="download"
      variant="outline"
      disabled={labState.shotBusy}
      tipText={tr('lab.shotAllTip')}
      tipPlacement="top"
      testid="lab-shot-all"
      onclick={() => void labState.exportShots()}
    />

    <span class="lab-tail">
      <span class="lab-readout" data-testid="lab-src-status" data-pending={labState.srcPending}>
        {tr('lab.srcLabel')}：{labState.srcPending ? tr('lab.srcPending') : tr('lab.srcReady')}
      </span>
      {#if shotProgress}
        <span class="lab-readout" data-testid="lab-shot-progress">
          {tr('lab.shotRunning', { done: shotProgress.done, total: shotProgress.total })}
        </span>
      {:else if labState.shotMessage}
        <span class="lab-readout" data-testid="lab-shot-message">{labState.shotMessage}</span>
      {/if}
      {#if compiled}
        <span
          class="lab-readout"
          class:lab-readout-bad={badCount > 0}
          data-testid="lab-compile-status"
        >
          {badCount > 0
            ? tr('lab.compileSomeBad', { bad: badCount, n: compiled.length })
            : tr('lab.compileAllOk', { n: compiled.length })}
        </span>
      {/if}
      <span class="lab-readout" data-testid="lab-fps">
        {labState.fps} fps · {labState.frameMs.toFixed(1)} ms
      </span>
    </span>
  </div>
</main>

<style>
  .lab-stage-wrap {
    display: grid;
    grid-template-rows: minmax(0, 1fr) auto;
    min-width: 0;
    min-height: 0;
    background: var(--surface-0);
  }
  /* 舞台底色固定深色：审特效时画面外的区域不该参与判断。 */
  .lab-stage {
    position: relative;
    display: flex;
    align-items: center;
    justify-content: center;
    min-height: 0;
    min-width: 0;
    padding: var(--sp-4);
    background: #000;
    overflow: hidden;
  }
  /*
   * canvas 的后备缓冲尺寸由 labState 用 renderer.setExportSize 钉死，
   * 这里只负责把它按比例缩放进舞台（object-fit 那套在 canvas 上不生效，
   * 用的是显式 max-width/max-height + 内在比例）。
   */
  .lab-canvas {
    max-width: 100%;
    max-height: 100%;
    display: block;
  }
  /* 编译中：与主应用预览里那颗转圈同一套语义（见 `ui/Preview.svelte`）。 */
  .lab-compiling {
    position: absolute;
    inset: 0;
    display: flex;
    align-items: center;
    justify-content: center;
    gap: var(--sp-2);
    color: var(--text-secondary);
    font-size: var(--fs-xs);
    pointer-events: none;
  }
  .lab-spinner {
    width: 14px;
    height: 14px;
    border: 2px solid currentColor;
    border-right-color: transparent;
    border-radius: 50%;
    animation: lab-spin 0.85s linear infinite;
  }
  @keyframes lab-spin {
    to {
      transform: rotate(360deg);
    }
  }
  @media (prefers-reduced-motion: reduce) {
    .lab-spinner {
      animation: none;
      border-right-color: currentColor;
      opacity: 0.45;
    }
  }
  .lab-toolbar {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: var(--sp-2);
    padding: var(--sp-2) var(--sp-3);
    background: var(--surface-2);
    border-top: 1px solid var(--border);
  }
  .lab-time {
    display: inline-flex;
    align-items: center;
    gap: var(--sp-2);
    flex: 1;
    min-width: 160px;
  }
  .lab-readout {
    font-size: var(--fs-xs);
    color: var(--text-muted);
    font-variant-numeric: tabular-nums;
    white-space: nowrap;
  }
  .lab-readout-bad {
    color: var(--danger);
  }
  .lab-tail {
    margin-left: auto;
    display: inline-flex;
    align-items: center;
    gap: var(--sp-3);
  }
  .lab-bypass {
    height: var(--control-h, 22px);
    padding: 0 var(--sp-3);
    font: inherit;
    font-size: var(--fs-sm);
    color: var(--text-primary);
    background: var(--surface-1);
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    cursor: pointer;
  }
  .lab-bypass:hover {
    border-color: var(--border-strong);
  }
  /* 按住时用强调色描边 —— 与自研控件的激活态同一套语言。 */
  .lab-bypass-on {
    border-color: var(--accent);
    color: var(--accent);
  }
</style>
