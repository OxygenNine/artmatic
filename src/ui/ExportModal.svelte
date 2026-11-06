<script lang="ts">
  /**
   * ExportModal — 导出面板。
   *
   * 版式的两条约束（都是「点之前要看清」的落实）：
   *  1. 文件名 / 时长 / 分辨率是**只读事实**，排成对齐的三行；
   *  2. MP4 与 PNG 两个入口**同一行、水平居中**，各自的体积提示挂在按钮下方 ——
   *     体积是「这个按钮会花掉多少磁盘」的注解，放在按钮里会把标签挤成一句话，
   *     排成上下两行又会变成「哪个提示对应哪个按钮」的猜谜。
   *
   * 从 Rail.svelte 抽出来，因为设置面板与排版编辑器都在往 Rail 里塞东西了，
   * 那个文件已经很长。
   */
  import Modal from './controls/Modal.svelte';
  import Button from './controls/Button.svelte';
  import Select from './controls/Select.svelte';
  import NumberInput from './controls/NumberInput.svelte';
  import type { SelectOption } from './controls/select-model';
  import { untrack } from 'svelte';
  import { appState } from './app-state.svelte';
  import {
    GIF_DEFAULT_FPS,
    GIF_DEFAULT_WIDTH,
    GIF_FPS_CHOICES,
    GIF_WIDTH_CHOICES,
    cancelExport,
    estimateMp4Bytes,
    exportGif,
    exportMp4,
    exportPngSequence,
    fmtSize,
    gifPlan,
    hasRunnableTypoScripts,
    probeMp4Availability,
    samplePngFrameBytes,
    totalFrames,
    type Mp4Availability,
  } from './export';
  import { tr } from '../i18n/index.svelte';

  interface Props {
    onclose: () => void;
  }
  const { onclose }: Props = $props();

  /**
   * 文件名草稿。默认取工程名。
   *
   * 用 `$state` 初值（组件在面板打开时才挂载），所以每次打开都是当前的工程名。
   */
  let name = $state(appState.store.project.name || 'artmatic');

  /**
   * GIF 的帧率 / 宽度草稿。
   *
   * 与文件名不同，这两个**刻意不落 UiPrefs**：导出参数取决于「这次要发到哪儿」
   * （聊天窗口 480 够看、当封面要 640），是一次性决策而不是稳定偏好。
   * 组件在面板打开时才挂载，所以每次打开都回到默认档。
   */
  let gifFps = $state<number>(GIF_DEFAULT_FPS);
  let gifWidth = $state<number>(GIF_DEFAULT_WIDTH);
  /**
   * 导出区间（秒）。
   *
   * 初值取当前工程时长 —— 组件在面板打开时才挂载，所以每次打开都是「整段」。
   * 留两位小数：再细的位数在这个输入框里只是噪声（`planGif` 本来就会把区间
   * 对齐到帧网格）。
   *
   * 这是 GIF 最实用的一个旋钮：体积与「时长 × 面积」成正比，而一段 24 秒的
   * 片子往往只有几秒值得发出去。
   */
  let gifStart = $state(0);
  let gifEnd = $state(Number(appState.store.project.duration.toFixed(2)));

  /**
   * 轨道筛选（三种格式通用）。`''` = 全部视觉轨；其余是某条视觉轨的 id。
   *
   * 只列**视觉轨**：音频单独处理，选了某条视觉轨导 MP4 时音轨照常混入
   * （音频不属视觉轨）。禁用轨列出来但不可选 —— `buildStack` 会跳过禁用轨，
   * 选它只会得到一张空画面，那是纯粹的困惑来源。
   */
  let trackSel = $state('');

  /** 区间输入框的步长：0.1 秒。GIF 不需要帧级精度，但拖动得跟手。 */
  const GIF_RANGE_STEP = 0.1;

  /** 下拉项的 label 是纯 ASCII（数字 + 单位），不涉及本地化。 */
  const fpsOptions: SelectOption<number>[] = GIF_FPS_CHOICES.map((v) => ({
    value: v,
    label: `${v} fps`,
  }));
  const widthOptions: SelectOption<number>[] = GIF_WIDTH_CHOICES.map((v) => ({
    value: v,
    label: `${v}px`,
  }));

  const frames = $derived.by(() => {
    void appState.version;
    return totalFrames();
  });
  const res = $derived.by(() => {
    void appState.version;
    return appState.project.resolution;
  });
  const seconds = $derived.by(() => {
    void appState.version;
    return Number(appState.project.duration.toFixed(2));
  });
  const pct = $derived(Math.round((appState.exportProgress ?? 0) * 100));
  const exporting = $derived(appState.exportProgress !== null);
  /**
   * MP4 能力。**不是同步的**：无硬编的机器要逐档问 `isConfigSupported`，
   * 才能知道能不能退到 Constrained Baseline。`checking` 期间按钮保持可用 ——
   * 真点下去时 `exportMp4` 会自己再探一次，并以底栏提示收场。
   */
  let mp4 = $state<Mp4Availability | { kind: 'checking' }>({ kind: 'checking' });
  $effect(() => {
    // 探测与 coded area 相关，跟着工程分辨率走（`res` 是响应式派生）。
    void res.w;
    void res.h;
    let live = true;
    void probeMp4Availability().then((a) => {
      if (live) mp4 = a;
    });
    return () => {
      live = false;
    };
  });
  const mp4Blocked = $derived(mp4.kind === 'no-webcodecs' || mp4.kind === 'no-h264');

  /**
   * 工程带脚本、总开关却关着 —— 导出的是一份**没有脚本效果的静态版**。
   * 这里必须显式提示并给一键开启：静默出一份不一样的片子是最坏的一类错。
   */
  const scriptWarn = $derived.by(() => {
    void appState.version;
    void appState.runTypoScripts;
    return !appState.runTypoScripts && hasRunnableTypoScripts();
  });
  const mp4Size = $derived.by(() => {
    void appState.version;
    return fmtSize(estimateMp4Bytes());
  });
  /**
   * PNG 序列体积的**回退上界**：每帧 RGBA 原始大小 × 帧数。
   *
   * 只在真实采样失败时用（见 `pngFrameBytes`）。它是确定的、可复核的，但不代表
   * 预计体积 —— PNG 的压缩率完全取决于画面内容（纯色能压到百分之几，噪点几乎压不动）。
   */
  const pngRawSize = $derived.by(() => {
    void appState.version;
    return fmtSize(frames * res.w * res.h * 4);
  });
  /**
   * GIF 导出计划。面板上显示的尺寸 / 帧数 / 体积，与真正导出时用的，是**同一个**
   * `gifPlan` 调用 —— 各算一份的 bug 形态是「提示说 300 帧，导出来是别的数」。
   */
  const gifInfo = $derived.by(() => {
    void appState.version;
    return gifPlan({
      fps: gifFps,
      width: gifWidth,
      range: { start: gifStart, end: gifEnd },
    });
  });

  /** 轨道下拉的选项：首项「全部轨道」，其余为各视觉轨（禁用轨不可选）。 */
  const trackOptions = $derived.by<SelectOption<string>[]>(() => {
    void appState.version;
    const opts: SelectOption<string>[] = [{ value: '', label: tr('app.exportTrackAll') }];
    for (const tk of appState.project.tracks) {
      if (tk.kind !== 'visual') continue;
      opts.push({ value: tk.id, label: tk.name, disabled: !tk.enabled });
    }
    return opts;
  });

  /**
   * PNG 体积估算的采样结果（单帧真实 PNG 字节数）。`null` = 还没采到 / 采样失败。
   *
   * 旧口径「未压缩 RGBA 上界」常比真实产物大 1~2 个数量级（PNG 对平坦画面能压到
   * 百分之几）。这里改成**按当前帧采样**：面板打开时渲一帧、量真实 PNG 字节，
   * 再乘帧数。会随画面内容波动，所以文案是「约」。
   */
  let pngFrameBytes = $state<number | null>(null);
  /** 采样进行中（提示显示「估算中…」）。 */
  let pngSampling = $state(false);

  /*
   * 打开面板（组件挂载）时采一次；切换轨道时重采。
   *
   * **只把 `trackSel` 当依赖**：`playT` 与 `version` 全部 `untrack`。
   * 跟踪 `playT` 会在播放中每帧重采（采样风暴）；跟踪 `version` 会在视频解码
   * 出帧（store.touch）时同样重采。`samplePngFrameBytes` 内部读的 appState 一并
   * 被 untrack 包住。
   */
  $effect(() => {
    const onlyTrackId = trackSel || undefined;
    let cancelled = false;
    pngSampling = true;
    pngFrameBytes = null;
    const t = untrack(() => appState.playT);
    void untrack(() => samplePngFrameBytes(t, onlyTrackId)).then((bytes) => {
      if (cancelled) return;
      pngFrameBytes = bytes;
      pngSampling = false;
    });
    return () => {
      cancelled = true;
    };
  });
</script>

<Modal title={tr('app.export')} testid="modal-export" {onclose}>
  <div class="exp-rows">
    <label class="exp-lbl" for="exp-name">{tr('app.exportFileName')}</label>
    <input
      id="exp-name"
      class="exp-name"
      data-testid="export-name"
      bind:value={name}
      disabled={exporting}
    />

    <span class="exp-lbl">{tr('app.duration')}</span>
    <span class="exp-val mono" data-testid="export-duration">
      {tr('app.framesSeconds', { n: frames, sec: seconds })}
    </span>

    <span class="exp-lbl">{tr('app.resolution')}</span>
    <span class="exp-val mono">{res.w}×{res.h}</span>
  </div>

  {#if exporting}
    <div class="exp-progress">
      <div class="exp-track"><div class="exp-fill" style:width={`${pct}%`}></div></div>
      <span class="mono">{pct}%</span>
      <Button label={tr('common.cancel')} variant="outline" testid="export-cancel" onclick={cancelExport} />
    </div>
  {:else}
    {#if scriptWarn}
      <div class="exp-script-warn" data-testid="export-script-warn">
        <span>{tr('typo.scriptExportWarn')}</span>
        <Button
          label={tr('typo.scriptExportEnable')}
          variant="outline"
          size="sm"
          testid="export-script-enable"
          onclick={() => appState.setRunTypoScripts(true)}
        />
      </div>
    {/if}

    <!--
      Track filter applies to all three formats, so it sits above the GIF-only
      params. Audio tracks are deliberately absent: audio is handled separately,
      and selecting a visual track still mixes the audio track into MP4.
      Kept ASCII: the i18n guard does not strip markup comments.
    -->
    <div class="exp-track-row">
      <span class="exp-lbl">{tr('app.exportTrack')}</span>
      <div class="exp-track-sel">
        <Select
          value={trackSel}
          options={trackOptions}
          ariaLabel={tr('app.exportTrack')}
          testid="export-track-select"
          optionTestidPrefix="export-track-opt"
          onchange={(v) => (trackSel = v)}
        />
      </div>
    </div>

    <!--
      GIF params get their own row: they only apply to GIF, and folding them into
      the read-only facts table above would blur facts and choices together.
      Kept ASCII: the i18n guard strips // and /* */ comments, but not markup ones.
    -->
    <div class="exp-gif">
      <span class="exp-gif-title">{tr('app.exportGif')}</span>

      <div class="exp-gif-rows">
        <div class="exp-gif-row">
          <span class="exp-lbl">{tr('app.gifFps')}</span>
          <div class="exp-gif-sel">
            <Select
              value={gifFps}
              options={fpsOptions}
              ariaLabel={tr('app.gifFps')}
              testid="gif-fps"
              optionTestidPrefix="gif-fps-opt"
              onchange={(v) => (gifFps = v)}
            />
          </div>

          <span class="exp-lbl">{tr('app.gifWidth')}</span>
          <div class="exp-gif-sel">
            <Select
              value={gifWidth}
              options={widthOptions}
              ariaLabel={tr('app.gifWidth')}
              testid="gif-width"
              optionTestidPrefix="gif-width-opt"
              onchange={(v) => (gifWidth = v)}
            />
          </div>

          <!-- The derived output size, so changing the width shows its effect at once. -->
          <span class="exp-val mono" data-testid="gif-size">
            {gifInfo.size.w}×{gifInfo.size.h}
          </span>
        </div>

        <div class="exp-gif-row">
          <span class="exp-lbl">{tr('app.gifRange')}</span>
          <div class="exp-gif-num">
            <NumberInput
              value={gifStart}
              min={0}
              max={gifEnd}
              step={GIF_RANGE_STEP}
              precision={2}
              width={78}
              suffix="s"
              ariaLabel={tr('app.gifRangeStart')}
              testid="gif-start"
              onchange={(v) => (gifStart = v)}
            />
          </div>
          <span class="exp-gif-dash">–</span>
          <div class="exp-gif-num">
            <NumberInput
              value={gifEnd}
              min={gifStart}
              max={seconds}
              step={GIF_RANGE_STEP}
              precision={2}
              width={78}
              suffix="s"
              ariaLabel={tr('app.gifRangeEnd')}
              testid="gif-end"
              onchange={(v) => (gifEnd = v)}
            />
          </div>

          <!-- Frame count after decimation -- the range's immediate feedback. -->
          <span class="exp-val mono" data-testid="gif-frames">
            {tr('app.gifFrames', { n: gifInfo.frameCount })}
          </span>
        </div>
      </div>
    </div>

    <div class="exp-actions">
      <div class="exp-action">
        <Button
          label={tr('app.exportPng')}
          icon="download"
          variant="outline"
          size="lg"
          testid="export-png"
          onclick={() => void exportPngSequence(name, trackSel || undefined)}
        />
        <p class="exp-hint" data-testid="export-png-hint">
          {#if pngFrameBytes !== null}
            {tr('app.exportPngHint', { size: fmtSize(pngFrameBytes * frames) })}
          {:else if pngSampling}
            {tr('app.exportPngHintSampling')}
          {:else}
            {tr('app.exportPngHintRaw', { size: pngRawSize })}
          {/if}
        </p>
      </div>

      <div class="exp-action">
        <Button
          label={tr('app.exportGif')}
          icon="download"
          variant="outline"
          size="lg"
          testid="export-gif"
          onclick={() =>
            void exportGif(
              name,
              {
                fps: gifFps,
                width: gifWidth,
                range: { start: gifStart, end: gifEnd },
              },
              trackSel || undefined,
            )}
        />
        <p class="exp-hint" data-testid="export-gif-hint">
          {tr('app.exportGifHint', { size: fmtSize(gifInfo.rawBytes) })}
        </p>
      </div>

      <div class="exp-action">
        <Button
          label={tr('app.exportMp4')}
          icon="download"
          variant="accent"
          size="lg"
          testid="export-mp4"
          disabled={mp4Blocked}
          onclick={() => void exportMp4(name, trackSel || undefined)}
        />
        <p class="exp-hint" data-testid="export-mp4-hint">
          {#if mp4.kind === 'no-h264'}
            {tr('app.exportMp4NoH264')}
          {:else if mp4.kind === 'no-webcodecs'}
            {tr('app.exportMp4Unsupported')}
          {:else}
            {tr('app.exportMp4Hint', { size: mp4Size })}
            {#if mp4.kind === 'ok' && mp4.software}
              <span class="exp-hint-soft" data-testid="export-mp4-software">
                {tr('app.exportMp4Software')}
              </span>
            {/if}
          {/if}
        </p>
      </div>
    </div>
  {/if}
</Modal>

<style>
  .exp-rows {
    display: grid;
    /* 标签列定宽：三行的值左边缘必须对齐，否则读起来是散的。 */
    grid-template-columns: 84px minmax(0, 1fr);
    align-items: center;
    gap: var(--sp-3) var(--sp-4);
    margin-bottom: var(--sp-6);
  }
  .exp-lbl {
    color: var(--text-secondary);
    font-size: var(--fs-sm);
  }
  .exp-name {
    /* 不要占满整行：文件名不长，一个横贯面板的输入框反而显得空。 */
    max-width: 260px;
    height: var(--control-h);
  }
  /*
   * 轨道筛选行：三种格式通用，所以单独一行、排在 GIF 参数之上。
   * 标签列定宽 84px = 上面那张事实表的标签列宽，左边缘才对得齐。
   */
  .exp-track-row {
    display: flex;
    align-items: center;
    gap: var(--sp-3);
    margin-bottom: var(--sp-5);
  }
  .exp-track-row .exp-lbl {
    width: 84px;
    flex-shrink: 0;
  }
  .exp-track-sel {
    width: 200px;
  }
  .exp-track-sel :global(.sel) {
    width: 100%;
  }
  /*
   * GIF 参数行。与下面三个导出按钮之间划一条线：上面是「选参数」，
   * 下面是「点哪个」，混成一片会让人以为参数对三种格式都生效。
   */
  .exp-gif {
    display: flex;
    align-items: flex-start;
    gap: var(--sp-3);
    margin-bottom: var(--sp-5);
    padding-bottom: var(--sp-5);
    border-bottom: 1px solid var(--border);
  }
  .exp-gif-title {
    /* 定宽 84px = 上面那张事实表的标签列宽，两块内容的左边缘才对得齐。 */
    width: 84px;
    flex-shrink: 0;
    color: var(--text-primary);
    font-size: var(--fs-sm);
    font-weight: 600;
    /* 与右侧第一行的文字基线对齐（行高由行内的 .exp-lbl 决定）。 */
    line-height: var(--control-h);
  }
  /*
   * 参数分两行：第一行是「多大、多快」，第二行是「哪一段」。
   * 挤成一行在 760px 的面板里会溢出去，而且这三类参数本来就不是一回事。
   */
  .exp-gif-rows {
    display: flex;
    flex-direction: column;
    gap: var(--sp-3);
    min-width: 0;
  }
  .exp-gif-row {
    display: flex;
    align-items: center;
    gap: var(--sp-3);
  }
  .exp-gif .exp-lbl {
    flex-shrink: 0;
  }
  .exp-gif-sel {
    width: 104px;
    flex-shrink: 0;
  }
  .exp-gif-sel :global(.sel) {
    width: 100%;
  }
  .exp-gif-num {
    flex-shrink: 0;
  }
  .exp-gif-dash {
    color: var(--text-muted);
    font-size: var(--fs-sm);
  }
  .exp-val {
    color: var(--text-primary);
    font-size: var(--fs-sm);
  }
  .mono {
    font-family: var(--font-mono);
  }
  .exp-actions {
    display: flex;
    align-items: flex-start;
    justify-content: center;
    gap: var(--sp-6);
  }
  .exp-action {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: var(--sp-2);
    /* 两个按钮同宽：一宽一窄会让"主操作"这件事看起来像排版事故。 */
    width: 150px;
  }
  .exp-action :global(.btn) {
    width: 100%;
  }
  .exp-hint {
    margin: 0;
    color: var(--text-muted);
    font-size: var(--fs-xs);
    line-height: 1.4;
    text-align: center;
  }
  /* 脚本未开启的导出警告：是一整行可操作提示（含「开启并继续」），不是注解。 */
  .exp-script-warn {
    display: flex;
    align-items: center;
    gap: var(--sp-2);
    margin: var(--sp-2) 0 0;
    padding: 4px var(--sp-2);
    background: color-mix(in srgb, var(--warning) 12%, transparent);
    border: 1px solid color-mix(in srgb, var(--warning) 45%, var(--border));
    border-radius: var(--radius-sm);
    color: var(--warning);
    font-size: var(--fs-xs);
    line-height: 1.4;
  }
  .exp-script-warn span {
    flex: 1;
    min-width: 0;
  }
  /* 软件编码提示：是警告不是错误（能导，只是慢），所以用 warning 色。 */
  .exp-hint-soft {
    display: block;
    color: var(--warning);
  }
  .exp-progress {
    display: flex;
    align-items: center;
    gap: var(--sp-4);
  }
  .exp-track {
    flex: 1;
    height: 6px;
    background: var(--surface-active);
    border-radius: 3px;
    overflow: hidden;
  }
  .exp-fill {
    height: 100%;
    background: var(--accent);
  }
</style>
