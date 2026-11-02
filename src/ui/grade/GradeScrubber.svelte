<script lang="ts">
  /**
   * GradeScrubber — 调色页工具条里的**播放进度条**。
   *
   * 调色页把时间轴隐藏了（那里换成了色轮与曲线），于是「拖播放头看别的帧」
   * 这条最基本的操作没了着落。这一条补回来：播放 / 停止 + 时间读数 + 一条
   * 覆盖整条时间线的进度条。
   *
   * 为什么不是直接复用 `Transport`：那一排控件（拍网格 / 吸附 / 时长 / 重叠 /
   * 波纹 / 缩放）全是**编辑时间轴**用的，在调色页一个都用不上；它们挤在这里
   * 只会把进度条压成一小段。
   */
  import IconButton from '../controls/IconButton.svelte';
  import Slider from '../controls/Slider.svelte';
  import { appState } from '../app-state.svelte';
  import { tr } from '../../i18n/index.svelte';

  const project = $derived.by(() => {
    void appState.version;
    return appState.store.project;
  });
  const duration = $derived.by(() => {
    void appState.version;
    return Math.max(0.1, appState.store.project.duration);
  });
  const fps = $derived.by(() => {
    void appState.version;
    return Math.max(1, appState.store.project.fps);
  });

  /**
   * 拖动进度条时先暂停。
   *
   * 不暂停的话每一帧 `seek()` 都会重排一次音频（`playAudio`），拖动会卡成
   * 一顿一顿的，而且松手之后声音位置与画面还得靠运气对上。
   */
  let scrubbing = $state(false);

  function scrub(v: number): void {
    if (appState.playing && !scrubbing) {
      scrubbing = true;
      appState.pause();
    }
    appState.seek(v);
  }

  function endScrub(): void {
    scrubbing = false;
  }

  function fmt(t: number): string {
    const m = Math.floor(t / 60);
    const s = (t % 60).toFixed(2).padStart(5, '0');
    return `${m}:${s}`;
  }
</script>

<div class="gs" data-testid="grade-scrubber">
  <IconButton
    icon={appState.playing ? 'pause' : 'play'}
    label={appState.playing ? tr('tp.pause') : tr('tp.play')}
    shortcut="Space"
    tipPlacement="top"
    testid="grade-play"
    onclick={() => appState.togglePlay()}
  />
  <span class="gs-time" data-testid="grade-time">
    {fmt(appState.playT)}<em>/ {fmt(project.duration)}</em>
  </span>
  <Slider
    value={appState.playT}
    min={0}
    max={duration}
    step={1 / fps}
    ariaLabel={tr('grade.scrub')}
    testid="grade-scrub"
    oninput={scrub}
    onchange={endScrub}
  />
</div>

<style>
  .gs {
    display: flex;
    align-items: center;
    gap: var(--sp-2);
    /* 进度条要吃掉工具条剩下的宽度：它是这一条里唯一「越长越好用」的控件。 */
    flex: 1 1 auto;
    min-width: 120px;
  }
  .gs :global(.sld) {
    flex: 1;
  }
  /*
   * 进度条的轨道比普通滑杆粗一档、颜色也重一档：普通滑杆 3px 的浅灰在工具条里
   * 几乎看不见，「这一条是进度」这件事就丢了。
   */
  .gs :global(.sld-track),
  .gs :global(.sld-fill) {
    height: 5px;
    border-radius: 3px;
  }
  .gs :global(.sld-track) {
    background: var(--border-strong);
  }
  .gs-time {
    flex: none;
    font-size: var(--fs-xs);
    font-variant-numeric: tabular-nums;
    color: var(--text-secondary);
    white-space: nowrap;
  }
  .gs-time em {
    margin-left: var(--sp-1);
    font-style: normal;
    color: var(--text-muted);
  }
</style>
