<script lang="ts">
  /**
   * Transport — 轨道正上方的工具条。
   *
   * 只放**逐帧/逐拍**的操作（播放、拍网格、吸附、时长、缩放、重叠策略）。
   * 导出属于工程级动作，已搬去窄侧栏的面板；一次性提示（notice）搬去了底栏。
   * 这条划分见 AGENTS.md §5 的布局约定。
   */
  import Icon from './Icon.svelte';
  import IconButton from './controls/IconButton.svelte';
  import NumberInput from './controls/NumberInput.svelte';
  import Select from './controls/Select.svelte';
  import Slider from './controls/Slider.svelte';
  import { appState } from './app-state.svelte';
  import { beatAtTime, SNAP_MODES } from '../core/time';
  import { SNAP_MODES_FOR, TIMELINE_MODE_ICONS } from '../timeline/view-model';
  import type { OverlapBehavior } from '../core/schema';
  import { platform } from '../platform/index';
  import { tip } from './tip';
  import { tr } from '../i18n/index.svelte';

  /**
   * 横向滚动容器（窄窗口下不拆行、改滚动）。
   *
   * 做法与 Ribbon 面板同源：`overflow-x: auto` + 隐藏滚动条 + 把纵向滚轮转成
   * 横向。**绝不加任何「刷新时把 scrollLeft 归零」的效果** —— Ribbon 的
   * `lastScrollResetTab` 注释记着这个教训：挂在 version 上的重算会把用户
   * 正在点的按钮永远打回到视口外。
   */
  let scrollEl = $state<HTMLDivElement | null>(null);
  /** 两侧渐变的可见性：**可滚且没到边**才显示（两端留着假的淡出比没有更糟）。 */
  let fadeL = $state(false);
  let fadeR = $state(false);

  function updateFades(): void {
    const el = scrollEl;
    if (!el) return;
    const scrollable = el.scrollWidth > el.clientWidth + 1;
    fadeL = scrollable && el.scrollLeft > 1;
    fadeR = scrollable && el.scrollLeft < el.scrollWidth - el.clientWidth - 1;
  }

  /** 纵向滚轮改为横向滚动 —— 工具条没有纵向内容，不接管就完全没反应。 */
  function onWheel(e: WheelEvent): void {
    const el = scrollEl;
    if (!el) return;
    if (el.scrollWidth <= el.clientWidth) return;
    if (e.deltaY !== 0) el.scrollLeft += e.deltaY;
    if (e.deltaX !== 0) el.scrollLeft += e.deltaX;
  }

  // 容器尺寸变（窗口缩放）→ 重算渐变可见性。只读 scrollLeft 相关量，不写它。
  $effect(() => {
    const el = scrollEl;
    if (!el) return;
    const ro = new ResizeObserver(() => updateFades());
    ro.observe(el);
    return () => ro.disconnect();
  });

  const grid = $derived.by(() => {
    void appState.version;
    return { ...appState.store.project.beatGrid };
  });
  const overlapBehavior = $derived.by(() => {
    void appState.version;
    return appState.store.project.overlapBehavior;
  });
  /** 工程时长不是素材长度的函数，是一个可以随便改的独立参数。 */
  const duration = $derived.by(() => {
    void appState.version;
    return appState.store.project.duration;
  });
  const playT = $derived(appState.playT);
  const beatPos = $derived(beatAtTime(playT, grid));
  const barBeat = $derived.by(() => {
    const b = Math.max(0, beatPos);
    const bar = Math.floor(b / grid.beatsPerBar) + 1;
    const beat = Math.floor(b % grid.beatsPerBar) + 1;
    return `${bar}.${beat}`;
  });

  function fmt(t: number): string {
    const m = Math.floor(t / 60);
    const s = (t % 60).toFixed(2).padStart(5, '0');
    return `${m}:${s}`;
  }

  const barOptions = [2, 3, 4, 6].map((n) => ({ value: n, label: String(n) }));

  /** 时间轴形态（只改标尺文案 / 这一组控件的可见性 / 吸附档位）。 */
  const timelineMode = $derived(appState.timelineMode);
  const modeIcon = $derived(TIMELINE_MODE_ICONS[timelineMode]);
  const modeLabel = $derived(tr(timelineMode === 'beat' ? 'tp.modeBeat' : 'tp.modeStandard'));
  const modeTip = $derived(tr(timelineMode === 'beat' ? 'tp.modeTipBeat' : 'tp.modeTipStandard'));

  /**
   * 吸附档位**按形态列**：半拍 / 拍 / 小节是拍单位，标准模式的标尺上没有拍，
   * 列出来只会让人选到一个「吸附到哪里都看不出来」的值。标准模式给「自由 / 帧」。
   */
  const snapOptions = $derived(
    SNAP_MODES_FOR[timelineMode].map((mode) => ({
      value: mode,
      label: tr(SNAP_MODES[mode].labelKey),
    })),
  );
  const projectFps = $derived.by(() => {
    void appState.version;
    return appState.store.project.fps;
  });

  const overlapOptions = $derived<{ value: OverlapBehavior; label: string }[]>([
    { value: 'reject', label: tr('tp.overlapReject') },
    { value: 'push', label: tr('tp.overlapPush') },
    { value: 'trim', label: tr('tp.overlapTrim') },
  ]);

  /**
   * 把**当前预览帧**送出去：默认进系统剪贴板，不支持 / 被拒时回退成下载。
   *
   * 为什么默认剪贴板：截图是「拿去用」的动作（贴进聊天 / 文档 / 当参考图），
   * 而下载会在下载文件夹里堆一串 `xxx-frame-00042.png`。
   * 逃生通道保留：**按住 Alt 点击 = 强制下载**（要文件名、要归档时用）。
   *
   * 渲染那段收在 `appState.snapshotFrame()`（它要碰 renderer 与工程分辨率，
   * 属于状态层的活）；这里只管「拿到 Blob → 挑通道 → 报一句结果」。
   * 两条通道都走平台层，不在这里自己拼 anchor / ClipboardItem。
   *
   * ⚠️ **剪贴板写入必须在手势里**（`clipboard.write` 要求瞬时激活）：
   * 这条链路上不能插 `setTimeout` / 二次事件循环，否则会被判成 `denied`。
   */
  async function saveCurrentFrame(forceDownload = false): Promise<void> {
    const shot = await appState.snapshotFrame();
    if (!shot) {
      appState.flash(tr('tp.snapshotFailed'), 'error');
      return;
    }
    if (!forceDownload) {
      const res = await platform.writeImageToClipboard(shot.blob);
      if (res === 'ok') {
        appState.flash(
          tr(shot.truncated ? 'tp.snapshotCopiedPartial' : 'tp.snapshotCopied', { frame: shot.frame }),
          'success',
        );
        return;
      }
      await platform.download(shot.blob, shot.filename);
      appState.flash(
        tr(res === 'denied' ? 'tp.snapshotClipDenied' : 'tp.snapshotClipUnsupported', {
          frame: shot.frame,
        }),
        'info',
      );
      return;
    }
    await platform.download(shot.blob, shot.filename);
    appState.flash(tr('tp.snapshotSaved', { frame: shot.frame }), 'success');
  }
</script>

<div class="transport-wrap">
  <div class="transport" bind:this={scrollEl} onscroll={updateFades} onwheel={onWheel}>
    <div class="transport-inner">
    <IconButton
      icon={appState.playing ? 'pause' : 'play'}
      label={appState.playing ? tr('tp.pause') : tr('tp.play')}
      shortcut="Space"
      size="lg"
      tipPlacement="top"
      testid="play-toggle"
      onclick={() => appState.togglePlay()}
    />
    <IconButton
      icon="square"
      label={tr('tp.stop')}
      tipPlacement="top"
      testid="stop"
      onclick={() => appState.stop()}
    />

    <span class="time" use:tip={{ placement: 'top', text: tr('tp.timeTip') }}>
      {fmt(playT)}<em>{barBeat}</em>
    </span>

    <!-- 当前帧截图：与时间读数同一簇（都是「此刻这一帧」的事）。 -->
    <IconButton
      icon="image"
      label={tr('tp.snapshot')}
      tipText={tr('tp.snapshotTip')}
      tipPlacement="top"
      testid="preview-snapshot"
      disabled={appState.snapshotting}
      onclick={(e) => void saveCurrentFrame(e.altKey)}
    />

    <span class="sep"></span>

    <!--
      时间轴形态：**两态按钮**，不是下拉 —— 只有两个状态，下拉的两步操作
      （展开、选另一个）与一次点击相比纯属多余。图标表示当前形态：
      activity = 节奏（小节.拍）、timer = 标准（分:秒.帧）。
    -->
    <button
      type="button"
      class="mode-btn"
      data-testid="timeline-mode"
      data-mode={timelineMode}
      aria-label={modeTip}
      use:tip={{ placement: 'top', text: modeTip }}
      onclick={() => appState.setTimelineMode(timelineMode === 'beat' ? 'standard' : 'beat')}
    >
      <Icon name={modeIcon} size={13} />
      <span>{modeLabel}</span>
    </button>

    {#if timelineMode === 'beat'}
      <span class="ctl" use:tip={{ placement: 'top', text: tr('tp.bpmTip') }}>
        <span class="lbl">BPM</span>
        <NumberInput
          value={grid.bpm}
          min={20}
          max={300}
          step={0.1}
          width={58}
          ariaLabel="BPM"
          testid="bpm-input"
          onchange={(v) => appState.store.setBeatGrid({ bpm: Math.max(20, Math.min(300, v || 120)) })}
        />
        <!--
          自动估计（ADR-002）。放在 BPM 右边而不是设置面板里：它是「对着这首曲子
          调拍网格」这个动作的一部分，离 BPM/offset 越近越顺手。
        -->
        <IconButton
          icon="wand-sparkles"
          label={tr('tp.estimate')}
          tipText={appState.beatBusy ? tr('tp.estimateBusy') : tr('tp.estimateTip')}
          size="sm"
          disabled={appState.beatBusy}
          testid="estimate-bpm"
          onclick={() => void appState.estimateBeatGrid()}
        />
      </span>

      <span class="ctl" use:tip={{ placement: 'top', text: tr('tp.offsetTip') }}>
        <span class="lbl">offset</span>
        <NumberInput
          value={grid.offset}
          step={0.01}
          width={58}
          ariaLabel="offset"
          testid="offset-input"
          onchange={(v) => appState.store.setBeatGrid({ offset: v })}
        />
      </span>

      <span class="ctl" use:tip={{ placement: 'top', text: tr('tp.beatsPerBarTip') }}>
        <span class="lbl">{tr('tp.beatsPerBar')}</span>
        <Select
          value={grid.beatsPerBar}
          options={barOptions}
          onchange={(v) => appState.store.setBeatGrid({ beatsPerBar: v })}
          testid="beats-per-bar"
          optionTestidPrefix="beats-per-bar-opt"
          minWidth={56}
        />
      </span>
    {:else}
      <!-- 标准模式：时间码是「分:秒.帧」，帧率直接决定小数位 —— 所以它在工具条上。 -->
      <span class="ctl" use:tip={{ placement: 'top', text: tr('tp.fpsTip') }}>
        <span class="lbl">{tr('tp.fps')}</span>
        <NumberInput
          value={projectFps}
          min={1}
          max={240}
          step={1}
          width={52}
          ariaLabel={tr('tp.fps')}
          testid="fps-input"
          onchange={(v) => appState.store.setFps(v || 30)}
        />
      </span>
    {/if}

    <span class="ctl" use:tip={{ placement: 'top', text: tr('tp.snapTip') }}>
      <span class="lbl">{tr('tp.snap')}</span>
      <Select
        value={appState.snap}
        options={snapOptions}
        onchange={(v) => appState.setSnap(v)}
        testid="snap-mode"
        optionTestidPrefix="snap-mode-opt"
        minWidth={88}
      />
    </span>

    <span class="sep"></span>

    <span class="ctl" use:tip={{ placement: 'top', text: tr('tp.durationTip') }}>
      <span class="lbl">{tr('tp.duration')}</span>
      <NumberInput
        value={+duration.toFixed(2)}
        min={0.1}
        step={0.5}
        width={62}
        suffix="s"
        ariaLabel={tr('tp.projectDuration')}
        testid="duration-input"
        onchange={(v) => appState.store.setDuration(v || 0.1)}
      />
      <IconButton
        icon="minimize-2"
        label={tr('tp.fitDuration')}
        size="sm"
        tipPlacement="top"
        testid="fit-duration"
        onclick={() => appState.store.fitDurationToContent()}
      />
    </span>

    <span class="ctl" use:tip={{ placement: 'top', text: tr('tp.overlapTip') }}>
      <span class="lbl">{tr('tp.overlap')}</span>
      <Select
        value={overlapBehavior}
        options={overlapOptions}
        onchange={(v) => appState.store.setOverlapBehavior(v)}
        testid="overlap-behavior"
        optionTestidPrefix="overlap-behavior-opt"
        minWidth={96}
      />
    </span>

    <!--
      波纹删除：**两态按钮**（与时间轴形态同一条：只有开 / 关两个状态时，
      下拉展开再选另一个是多余的一步）。图标表示「后面的往左补位」。
      开着时用主题色 —— 这是一个会静默挪动别的片段的行为，必须一眼看出它在。
    -->
    <button
      type="button"
      class="mode-btn"
      class:on={appState.rippleEdit}
      data-testid="ripple-edit"
      data-on={appState.rippleEdit}
      aria-pressed={appState.rippleEdit}
      aria-label={tr('tp.rippleTip')}
      use:tip={{ placement: 'top', text: tr('tp.rippleTip') }}
      onclick={() => appState.setRippleEdit(!appState.rippleEdit)}
    >
      <Icon name="move-horizontal" size={13} />
      <span>{tr('tp.ripple')}</span>
    </button>

    <span class="ctl zoom" use:tip={{ placement: 'top', text: tr('tp.zoomTip') }}>
      <Icon name="search" size={12} />
      <Slider
        value={appState.pxPerBeat}
        min={6}
        max={96}
        step={1}
        ariaLabel={tr('tp.zoom')}
        testid="zoom-slider"
        oninput={(v) => (appState.pxPerBeat = v)}
      />
    </span>
    </div>
  </div>
  <!-- 两侧渐层：绝对定位、不随内容滚动、不吃指针事件。可见性见 updateFades。 -->
  <div class="fade fade-l" class:on={fadeL} aria-hidden="true" data-testid="transport-fade-left"></div>
  <div class="fade fade-r" class:on={fadeR} aria-hidden="true" data-testid="transport-fade-right"></div>
</div>

<style>
  .transport-wrap {
    position: relative;
    flex: 1;
    min-width: 0;
  }
  .transport {
    min-width: 0;
    /* 横向滚动、纵向裁剪。装不下就滚，不再拆成两行 —— 拆行会让工具条高度
        随窗口宽度跳变，且把 stage 的列撑宽（历史bug，见 App.svelte 的 .stage）。 */
    overflow-x: auto;
    overflow-y: hidden;
    /* 触板横滑到两端时不要链到页面滚动。 */
    overscroll-behavior-x: contain;
    /* 不要可见滚动条：渐层已经暗示了「这里能滚」。 */
    scrollbar-width: none;
  }
  .transport::-webkit-scrollbar {
    display: none;
  }
  .transport-inner {
    display: flex;
    align-items: center;
    gap: var(--sp-3);
    /* max-content：控件保持自然宽度排队溢出，由外层滚动 —— 默认的 flex-shrink
       会把它们压扁（那是另一种坏法：控件变形而不是滚动）。 */
    width: max-content;
  }
  .fade {
    position: absolute;
    top: 0;
    bottom: 0;
    width: 20px;
    pointer-events: none;
    opacity: 0;
    transition: opacity var(--motion-duration-enter, 120ms) var(--motion-ease, ease-out);
  }
  .fade-l {
    left: 0;
    background: linear-gradient(to right, var(--surface-2), transparent);
  }
  .fade-r {
    right: 0;
    background: linear-gradient(to left, var(--surface-2), transparent);
  }
  .fade.on {
    opacity: 1;
  }
  .time {
    display: inline-flex;
    align-items: baseline;
    gap: var(--sp-3);
    flex-shrink: 0;
    color: var(--text-primary);
    font-family: var(--font-mono);
    font-size: var(--fs-sm);
    font-variant-numeric: tabular-nums;
  }
  .time em {
    font-style: normal;
    color: var(--accent);
  }
  .sep {
    width: 1px;
    height: 14px;
    flex-shrink: 0;
    background: var(--tl-border);
  }
  .ctl {
    display: inline-flex;
    align-items: center;
    gap: var(--sp-2);
    flex-shrink: 0;
    min-width: 0;
  }
  .lbl {
    color: var(--text-secondary);
    font-size: var(--fs-sm);
    white-space: nowrap;
  }
  /*
    两态形态按钮。与 `.ic-btn` 同一条外观纪律：**没有底色**，hover 只变前景色，
    只是它多一个当前形态的词（图标单独一个时读不出「现在是什么」）。
  */
  .mode-btn {
    display: inline-flex;
    align-items: center;
    gap: var(--sp-1);
    flex-shrink: 0;
    height: var(--control-h);
    padding: 0 var(--sp-2);
    border: 0;
    border-radius: var(--radius-sm);
    background: transparent;
    color: var(--text-secondary);
    font-family: inherit;
    font-size: var(--fs-sm);
    cursor: pointer;
  }
  .mode-btn:hover {
    color: var(--text-primary);
  }
  /* 开着 = 主题色（这是会挪动别的片段的行为，必须一眼看出它在） */
  .mode-btn.on {
    color: var(--accent);
  }
  .mode-btn.on:hover {
    color: var(--accent);
  }
  .zoom {
    min-width: 140px;
  }
  @media (prefers-reduced-motion: reduce) {
    .fade {
      transition: none;
    }
  }
</style>
