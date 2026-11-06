<script lang="ts">
  /**
   * PreClipModal — 视频预剪辑（v13）。
   *
   * 三件事在这里合流，所以它值得一个独立组件：
   *  1. **逐帧打点**：`I` / `O` / 方向键 / 空格，所有边界都按工程 fps 取整；
   *  2. **范围列表**：多个 In/Out 对随工程保存，单选当前激活的那一个；
   *  3. **插入**：把当前范围交给宿主（媒体池 → `insertAssetClip`），落下的片段
   *     长度与 srcIn 就是这里看到的数字。
   *
   * 预览刻意不接渲染核心（见 `preclip-preview.ts` 文件头）。
   */
  import Modal from '../controls/Modal.svelte';
  import Button from '../controls/Button.svelte';
  import IconButton from '../controls/IconButton.svelte';
  import NumberInput from '../controls/NumberInput.svelte';
  import Menu from '../controls/Menu.svelte';
  import { appState } from '../app-state.svelte';
  import { activeElementOwnsSpace } from '../focus';
  import { videoMediaFor } from '../../engine/media-assets';
  import { activeRangeOf, frameOfSec, newRange, nextRangeName, normalizeRange } from '../../core/preclip';
  import type { AssetTrimRange } from '../../core/schema';
  import type { PoolItem } from '../media-pool';
  import { PreClipPreview } from './preclip-preview';
  import { tr } from '../../i18n/index.svelte';

  interface Props {
    item: PoolItem;
    onclose: () => void;
    /** 宿主决定落到哪里（媒体池 = 时间轴播放头）。`range` 为 null = 整段素材。 */
    oninsert: (range: AssetTrimRange | null) => void;
  }
  const { item, onclose, oninsert }: Props = $props();

  const fps = $derived(Math.max(1, appState.store.project.fps));
  const totalFrames = $derived(Math.max(1, Math.round((item.durationSec ?? 1 / fps) * fps)));

  /*
   * 直接读 `appState.version` 再取素材：`ranges` / `activeRange` 都是从它派生的，
   * 多一层 `$derived` 转手没有任何好处，反而让「保存之后列表还是 0 条」这种
   * 依赖追踪问题更难查（实测踩过：外层派生没把更新传下去）。
   */
  /*
   * 注意这里是**拷贝**而不是直接返回 `asset.ranges`：`setAssetRange` 新增一条时
   * 是对同一个数组 `push`（引用不变），而 `$derived` 用 `===` 判断传播 ——
   * 直接返回的话「新建第二条范围」不会让列表重渲（标题还写着（1），而激活范围
   * 已经是范围 2）。第一次新建之所以看起来正常，是因为那时 `ranges` 从
   * `undefined` 变成了一个新数组。
   */
  const ranges = $derived.by(() => {
    void appState.version;
    return [...(appState.store.project.assets[item.id]?.ranges ?? [])];
  });
  const activeRange = $derived.by(() => {
    void appState.version;
    return activeRangeOf(appState.store.project.assets[item.id] ?? {});
  });

  /** 播放头（源内帧号）。与 in/out 独立：先移动播放头，再打点。 */
  let cursor = $state(0);
  let inF = $state(0);
  /* 真实值由下面的初始化 effect 写入（`totalFrames` 是派生值，不能拿来当初值）。 */
  let outF = $state(1);
  let playing = $state(false);
  let failed = $state(false);
  /** 预览解码器就绪。`PreClipPreview.ready` 是普通字段，不能进 `$effect` 依赖。 */
  let ready = $state(false);
  let canvasEl = $state<HTMLCanvasElement | null>(null);
  let stripEl = $state<HTMLElement | null>(null);
  let menuFor = $state<{ anchor: HTMLElement } | null>(null);
  /**
   * 菜单作用的范围。**不能从 `menuFor` 派生**：`Menu.activate()` 是先
   * `onclose()` 再 `onselect()`（见 controls/Menu.svelte），那时 `menuFor` 已经
   * 是 null —— 闭包里读它会 TypeError，表现是「点菜单项什么都不发生」。
   */
  let menuTarget = $state.raw<AssetTrimRange | null>(null);
  let renamingId = $state<string | null>(null);
  let renameValue = $state('');

  const preview = new PreClipPreview();

  /** 当前 in/out 与激活范围不一致 → 保存按钮变成「更新」。 */
  const dirty = $derived(
    activeRange !== null &&
      (inF !== frameOfSec(activeRange.inSec, fps) || outF !== frameOfSec(activeRange.outSec, fps)),
  );

  const rangeTitle = $derived(tr('preclip.ranges', { n: ranges.length }));

  $effect(() => {
    const media = videoMediaFor(item.id);
    if (!media) {
      failed = true;
      return;
    }
    let alive = true;
    void preview.open(media).then((ok) => {
      if (!alive) return;
      if (!ok) {
        failed = true;
        return;
      }
      ready = true;
      const c = canvasEl;
      if (c) void preview.drawAt(cursor / fps, c);
    });
    return () => {
      alive = false;
      preview.dispose();
    };
  });

  /* 打开时落在激活范围（没有就整段）。只跑一次：之后用户的拖动不该被重置。 */
  let initialized = false;
  $effect(() => {
    if (initialized) return;
    initialized = true;
    const r = activeRange;
    inF = r ? frameOfSec(r.inSec, fps) : 0;
    outF = r ? frameOfSec(r.outSec, fps) : totalFrames;
    cursor = inF;
  });

  /* 播放头变化 → 稀疏取一帧。播放中跳过（播放自己逐帧画）。 */
  $effect(() => {
    const f = cursor;
    const p = playing;
    const c = canvasEl;
    const ok = ready;
    if (p || !c || !ok) return;
    void preview.drawAt(f / fps, c);
  });

  function clampCursor(f: number): number {
    return Math.max(0, Math.min(totalFrames - 1, Math.round(f)));
  }

  function seek(f: number): void {
    stopPlayback();
    cursor = clampCursor(f);
  }

  function stopPlayback(): void {
    if (!playing) return;
    preview.stop();
    playing = false;
  }

  function togglePlay(): void {
    if (playing) {
      stopPlayback();
      return;
    }
    const c = canvasEl;
    if (!c || !preview.ready) return;
    if (cursor >= outF - 1) cursor = inF;
    playing = true;
    preview.play(
      cursor / fps,
      outF / fps,
      c,
      (sec) => {
        cursor = clampCursor(sec * fps);
      },
      () => {
        playing = false;
        cursor = clampCursor(outF - 1);
      },
    );
  }

  function setIn(f: number): void {
    inF = Math.max(0, Math.min(clampCursor(f), outF - 1));
    seek(inF);
  }

  function setOut(f: number): void {
    outF = Math.max(inF + 1, Math.min(totalFrames, Math.round(f)));
    seek(outF - 1);
  }

  function onKey(e: KeyboardEvent): void {
    const el = e.target as HTMLElement | null;
    if (el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable)) return;
    if (e.code === 'Space') {
      // 焦点在按钮/role 控件上时 Space 归它们（与全局 Space 同一条判据）。
      if (activeElementOwnsSpace()) return;
      e.preventDefault();
      togglePlay();
      return;
    }
    if (e.key === 'i' || e.key === 'I') {
      e.preventDefault();
      setIn(cursor);
      return;
    }
    if (e.key === 'o' || e.key === 'O') {
      e.preventDefault();
      // 出点是**开区间**：要让当前这帧留在范围里，out 必须写 cursor + 1。
      setOut(cursor + 1);
      return;
    }
    if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
      e.preventDefault();
      if (e.shiftKey) {
        // Shift + 方向键 = 10 帧；打点时的粗调。
        const dir = e.key === 'ArrowLeft' ? -1 : 1;
        seek(cursor + dir * 10);
        return;
      }
      seek(cursor + (e.key === 'ArrowLeft' ? -1 : 1));
    }
  }

  /* ---------------------------------------------------------- 拖柄 / 拖带 */

  function beginDrag(e: PointerEvent, kind: 'in' | 'out' | 'band'): void {
    e.preventDefault();
    e.stopPropagation();
    const el = stripEl;
    if (!el) return;
    stopPlayback();
    /*
     * 指针捕获：松手时鼠标可能已经在弹窗外面。不捕获的话 pointerdown（柄）
     * 与 pointerup（遮罩）的公共祖先是 backdrop，浏览器会补一个 click 到遮罩上
     * —— 表现就是「拖完 in/out 弹窗被关掉」。捕获后 pointerup 的目标仍是时间条，
     * click 也落在时间条上（在 modal 内部）。
     */
    el.setPointerCapture(e.pointerId);
    const rect = el.getBoundingClientRect();
    const frameAt = (clientX: number): number =>
      Math.round(((clientX - rect.left) / Math.max(1, rect.width)) * totalFrames);
    const startIn = inF;
    const startOut = outF;
    const startFrame = frameAt(e.clientX);
    const onMove = (ev: PointerEvent): void => {
      const f = frameAt(ev.clientX);
      if (kind === 'in') {
        inF = Math.max(0, Math.min(f, outF - 1));
        cursor = inF;
      } else if (kind === 'out') {
        outF = Math.max(inF + 1, Math.min(totalFrames, f));
        cursor = Math.max(inF, outF - 1);
      } else {
        const len = startOut - startIn;
        const next = Math.max(0, Math.min(totalFrames - len, startIn + (f - startFrame)));
        inF = next;
        outF = next + len;
        cursor = Math.max(inF, Math.min(outF - 1, cursor));
      }
    };
    const onUp = (ev: PointerEvent): void => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', onUp);
      if (el.hasPointerCapture(ev.pointerId)) el.releasePointerCapture(ev.pointerId);
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onUp);
  }

  /** 点时间条空白处 = 移动播放头；按住拖动 = 连续 scrub（同样用指针捕获）。 */
  function scrubStrip(e: PointerEvent): void {
    if (e.button !== 0) return;
    const el = stripEl;
    if (!el) return;
    stopPlayback();
    el.setPointerCapture(e.pointerId);
    const rect = el.getBoundingClientRect();
    const seekAt = (clientX: number): void =>
      seek(((clientX - rect.left) / Math.max(1, rect.width)) * totalFrames);
    seekAt(e.clientX);
    const onMove = (ev: PointerEvent): void => seekAt(ev.clientX);
    const onUp = (ev: PointerEvent): void => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', onUp);
      if (el.hasPointerCapture(ev.pointerId)) el.releasePointerCapture(ev.pointerId);
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onUp);
  }

  /* ------------------------------------------------------------- 范围列表 */

  function selectRange(r: AssetTrimRange): void {
    appState.store.setActiveRange(item.id, r.id);
    inF = frameOfSec(r.inSec, fps);
    outF = frameOfSec(r.outSec, fps);
    seek(inF);
  }

  /** 把改过的入点 / 出点写回**当前激活范围**（只有它存在且真的变了时才点得到）。 */
  function updateActive(): void {
    if (!activeRange || !dirty) return;
    const norm = normalizeRange({ inSec: inF / fps, outSec: outF / fps }, item.durationSec ?? 0, fps);
    if (!norm) return;
    appState.store.setAssetRange(item.id, { ...activeRange, ...norm });
  }

  /**
   * 用当前入点 / 出点**新建**一条范围。
   *
   * 与「更新」拆成两个按钮是刻意的：合成一个时标签会在「保存」与「更新」之间跳，
   * 用户分不清这一次点下去是新建还是覆盖 —— 「第二个范围怎么建」这个问题就是
   * 这么来的（旧实现里再点一次「保存」会静默造一条与当前范围一模一样的重复条目）。
   *
   * 当前区间与某条已有范围**完全重合**时不再造重复条目，直接把它设为激活：
   * 插入片段用的是激活范围，一条重复条目只会让列表变长而不改变任何行为。
   */
  function createRange(): void {
    const norm = normalizeRange({ inSec: inF / fps, outSec: outF / fps }, item.durationSec ?? 0, fps);
    if (!norm) return;
    const same = ranges.find(
      (r) => frameOfSec(r.inSec, fps) === frameOfSec(norm.inSec, fps)
        && frameOfSec(r.outSec, fps) === frameOfSec(norm.outSec, fps),
    );
    if (same) {
      selectRange(same);
      return;
    }
    const range = newRange(
      norm.inSec,
      norm.outSec,
      nextRangeName(ranges, (n) => tr('preclip.rangeDefault', { n })),
    );
    appState.store.setAssetRange(item.id, range);
    appState.store.setActiveRange(item.id, range.id);
  }

  function beginRename(r: AssetTrimRange): void {
    renamingId = r.id;
    renameValue = r.name;
  }

  function commitRename(): void {
    const id = renamingId;
    const name = renameValue.trim();
    renamingId = null;
    if (!id || !name) return;
    const r = ranges.find((x) => x.id === id);
    if (r) appState.store.setAssetRange(item.id, { ...r, name });
  }

  /**
   * 时间条的刻度：按总时长选一个「一秒能画得下」的步长。
   *
   * 逐帧刻度只在高倍放大下有意义；素材动辄几分钟，全画出来是几千个 DOM 节点。
   */
  const ticks = $derived.by(() => {
    const seconds = totalFrames / fps;
    const step = seconds <= 12 ? 1 : seconds <= 60 ? 5 : seconds <= 300 ? 15 : 60;
    const out: { f: number; pct: number }[] = [];
    for (let s = 0; s <= seconds + 1e-6; s += step) {
      out.push({ f: Math.round(s * fps), pct: (s / Math.max(1e-6, seconds)) * 100 });
    }
    return out;
  });

  function timestamp(frames: number): string {
    const total = Math.max(0, Math.round(frames));
    const ff = total % Math.round(fps);
    const totalSec = Math.floor(total / fps);
    const ss = totalSec % 60;
    const mm = Math.floor(totalSec / 60) % 60;
    const hh = Math.floor(totalSec / 3600);
    const pad = (n: number): string => String(n).padStart(2, '0');
    return `${pad(hh)}:${pad(mm)}:${pad(ss)}:${pad(ff)}`;
  }

  function insert(): void {
    const norm = normalizeRange({ inSec: inF / fps, outSec: outF / fps }, item.durationSec ?? 0, fps);
    if (!norm) return;
    const same = activeRange && frameOfSec(activeRange.inSec, fps) === inF && frameOfSec(activeRange.outSec, fps) === outF;
    oninsert({
      id: same && activeRange ? activeRange.id : 'preclip-temp',
      name: same && activeRange ? activeRange.name : item.name,
      ...norm,
    });
  }
</script>

<svelte:window onkeydown={onKey} />

<Modal title={tr('preclip.title')} testid="preclip-modal" width="wide" flushBody onclose={onclose}>
  <div class="wrap">
    <!-- 左：预览 + 时间码 -->
    <div class="stage">
      <div class="frame">
        <canvas bind:this={canvasEl} class="canvas" data-testid="preclip-canvas"></canvas>
        {#if failed}
          <p class="fail">{tr('preclip.decodeFailed')}</p>
        {/if}
        <span class="tc" data-testid="preclip-timecode">{timestamp(cursor)}</span>
      </div>
      <!--
        帧级时间条：范围高亮带 + 两个拖柄 + 播放头。
        点空白处 = 移动播放头；拖带子 = 整体平移范围；拖柄 = 改入 / 出点。
      -->
      <div
        class="strip"
        bind:this={stripEl}
        role="presentation"
        data-testid="preclip-strip"
        onpointerdown={scrubStrip}
      >
        {#each ticks as tick (tick.f)}
          <i class="tick" style:left={`${tick.pct}%`}></i>
        {/each}
        <div
          class="band"
          style:left={`${(inF / totalFrames) * 100}%`}
          style:width={`${((outF - inF) / totalFrames) * 100}%`}
          role="presentation"
          data-testid="preclip-band"
          onpointerdown={(e) => beginDrag(e, 'band')}
        ></div>
        <i
          class="handle in"
          style:left={`${(inF / totalFrames) * 100}%`}
          role="presentation"
          data-testid="preclip-handle-in"
          onpointerdown={(e) => beginDrag(e, 'in')}
        ></i>
        <i
          class="handle out"
          style:left={`${(outF / totalFrames) * 100}%`}
          role="presentation"
          data-testid="preclip-handle-out"
          onpointerdown={(e) => beginDrag(e, 'out')}
        ></i>
        <i
          class="playhead"
          style:left={`${(cursor / totalFrames) * 100}%`}
          data-testid="preclip-playhead"
        ></i>
      </div>

      <div class="meta">
        {tr('preclip.meta', { fps: Math.round(fps), frames: totalFrames })}
        {#if activeRange}
          <span class="dot">·</span>
          <span>{activeRange.name}</span>
        {/if}
      </div>
    </div>

    <!-- 右：范围列表 -->
    <aside class="ranges">
      <div class="ranges-head">
        <span class="ranges-title">{rangeTitle}</span>
        <span class="range-actions">
          <!-- 只有入出点真的被改过时才出现「更新」：平时它点了什么也不会发生。 -->
          {#if activeRange && dirty}
            <button
              class="text-btn"
              type="button"
              data-testid="preclip-update-range"
              onclick={updateActive}
            >
              {tr('preclip.updateRange', { name: activeRange.name })}
            </button>
          {/if}
          <!-- 新建范围常驻：这是「想再存一段」的唯一入口，不该藏在某个状态后面。 -->
          <button
            class="text-btn"
            type="button"
            data-testid="preclip-new-range"
            onclick={createRange}
          >
            {tr('preclip.newRange')}
          </button>
        </span>
      </div>
      <div class="range-list">
        {#each ranges as r (r.id)}
          <div
            class="range-row"
            class:active={activeRange?.id === r.id}
            data-testid="preclip-range"
            role="presentation"
            onclick={() => selectRange(r)}
          >
            {#if renamingId === r.id}
              <!-- svelte-ignore a11y_autofocus -->
              <input
                class="range-input"
                value={renameValue}
                autofocus
                onpointerdown={(e) => e.stopPropagation()}
                onblur={commitRename}
                onkeydown={(e) => {
                  if (e.key === 'Enter') {
                    e.preventDefault();
                    commitRename();
                  } else if (e.key === 'Escape') {
                    e.preventDefault();
                    renamingId = null;
                  }
                }}
              />
            {:else}
              <span class="range-main">
                <span class="range-name">{r.name}</span>
                <span class="range-meta">
                  {tr('preclip.rangeMeta', {
                    frames: frameOfSec(r.outSec, fps) - frameOfSec(r.inSec, fps),
                    seconds: (r.outSec - r.inSec).toFixed(2),
                  })}
                </span>
              </span>
              <IconButton
                icon="ellipsis-vertical"
                label={tr('preclip.rename')}
                size="sm"
                testid="preclip-range-menu"
                onclick={(e) => {
                  e.stopPropagation();
                  menuTarget = r;
                  menuFor = { anchor: e.currentTarget as HTMLElement };
                }}
              />
            {/if}
          </div>
        {:else}
          <p class="empty">{tr('preclip.emptyHint')}</p>
        {/each}
      </div>
    </aside>
  </div>

  {#snippet footer()}
    <div class="footer">
      <div class="io">
        <span class="io-label">{tr('preclip.in')}</span>
        <NumberInput
          value={Math.round(inF)}
          min={0}
          max={Math.max(0, outF - 1)}
          step={1}
          width={72}
          testid="preclip-in"
          onchange={(v) => setIn(Math.round(v))}
        />
        <span class="io-unit">{tr('preclip.frameUnit')}</span>
        <span class="io-label">{tr('preclip.out')}</span>
        <NumberInput
          value={Math.round(outF)}
          min={Math.min(totalFrames, inF + 1)}
          max={totalFrames}
          step={1}
          width={72}
          testid="preclip-out"
          onchange={(v) => setOut(Math.round(v))}
        />
        <span class="io-unit">{tr('preclip.frameUnit')}</span>
      </div>
      <span class="hint">{tr('preclip.hint')}</span>
      <Button
        label={tr('preclip.insert')}
        variant="accent"
        icon="plus"
        testid="preclip-insert"
        onclick={insert}
      />
    </div>
  {/snippet}
</Modal>

{#if menuFor}
  <Menu
    items={[
      {
        id: 'rename',
        label: tr('preclip.rename'),
        icon: 'pencil' as const,
        testid: 'preclip-range-rename',
        onselect: () => menuTarget && beginRename(menuTarget),
      },
      {
        id: 'remove',
        label: tr('preclip.remove'),
        icon: 'trash' as const,
        danger: true,
        testid: 'preclip-range-remove',
        onselect: () => menuTarget && appState.store.removeAssetRange(item.id, menuTarget.id),
      },
    ]}
    anchorEl={menuFor.anchor}
    onclose={() => (menuFor = null)}
    testid="preclip-range-panel"
  />
{/if}

<style>
  /* 预览在上、范围列表在下的窄屏布局在 `.wrap` 的媒体查询里切。 */
  .wrap {
    display: flex;
    width: 100%;
    min-height: 0;
    flex: 1;
  }

  .stage {
    display: flex;
    flex: 1;
    min-width: 0;
    flex-direction: column;
    padding: var(--sp-4);
    gap: var(--sp-2);
  }
  .frame {
    position: relative;
    flex: 1;
    min-height: 0;
    display: flex;
    align-items: center;
    justify-content: center;
    background: #16181d;
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    overflow: hidden;
  }
  .canvas {
    max-width: 100%;
    max-height: 100%;
    object-fit: contain;
    display: block;
  }
  .fail {
    position: absolute;
    margin: 0;
    padding: 0 var(--sp-4);
    color: var(--text-secondary);
    font-size: var(--fs-sm);
    text-align: center;
  }
  .tc {
    position: absolute;
    left: var(--sp-3);
    bottom: var(--sp-2);
    padding: 1px 5px;
    border-radius: 2px;
    background: color-mix(in srgb, #16181d 78%, transparent);
    color: var(--text-primary);
    font-family: var(--font-mono);
    font-size: var(--fs-xs);
    letter-spacing: 0.04em;
  }
  /* 时间条：深底 + 1px 边框，范围带用 accent 半透明（视觉纪律：不用渐变/阴影）。 */
  .strip {
    position: relative;
    height: 64px;
    flex-shrink: 0;
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    background: var(--surface-2);
    cursor: crosshair;
    touch-action: none;
    overflow: hidden;
  }
  .tick {
    position: absolute;
    top: 0;
    bottom: 0;
    width: 1px;
    background: var(--border);
    opacity: 0.6;
    pointer-events: none;
  }
  .band {
    position: absolute;
    top: 12px;
    bottom: 12px;
    background: color-mix(in srgb, var(--accent) 20%, transparent);
    border: 1px solid var(--accent);
    border-radius: 2px;
    cursor: grab;
  }
  .band:active {
    cursor: grabbing;
  }
  .handle {
    position: absolute;
    top: 0;
    bottom: 0;
    width: 12px;
    margin-left: -6px;
    cursor: ew-resize;
    z-index: 2;
  }
  /* 两个三角拼成的拖柄：与时间轴音频淡变手柄同一形状语言。 */
  .handle::before {
    content: '';
    position: absolute;
    top: 50%;
    left: 1px;
    width: 0;
    height: 0;
    margin-top: -6px;
    border-top: 6px solid transparent;
    border-bottom: 6px solid transparent;
  }
  .handle.in::before {
    border-left: 9px solid var(--accent);
  }
  .handle.out::before {
    border-right: 9px solid var(--accent);
    left: auto;
    right: 1px;
  }
  .playhead {
    position: absolute;
    top: 0;
    bottom: 0;
    width: 1px;
    margin-left: -0.5px;
    background: var(--text-primary);
    pointer-events: none;
  }
  .meta {
    display: flex;
    gap: 6px;
    color: var(--text-tertiary);
    font-size: var(--fs-xs);
    flex-shrink: 0;
  }
  .dot {
    opacity: 0.6;
  }

  .ranges {
    display: flex;
    width: 260px;
    flex-shrink: 0;
    flex-direction: column;
    border-left: 1px solid var(--border);
    min-height: 0;
  }
  .ranges-head {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    justify-content: space-between;
    gap: var(--sp-2);
    padding: var(--sp-3) var(--sp-3) var(--sp-2);
    border-bottom: 1px solid var(--border);
  }
  /*
    两个动作放在右侧一簇。「更新「范围 1」」+「新建范围」在 260px 里放不下时
    换行，而不是把标题挤没 —— 挤掉标题会让人看不出这几条是什么。
  */
  .range-actions {
    display: flex;
    flex-wrap: wrap;
    justify-content: flex-end;
    gap: var(--sp-2);
    margin-left: auto;
  }
  .ranges-title {
    color: var(--text-secondary);
    font-size: var(--fs-xs);
  }
  .text-btn {
    padding: 0;
    border: 0;
    background: none;
    color: var(--accent);
    font: inherit;
    font-size: var(--fs-xs);
    cursor: pointer;
  }
  .text-btn:hover {
    text-decoration: underline;
  }
  .range-list {
    flex: 1;
    min-height: 0;
    overflow-y: auto;
    padding: var(--sp-2) 0;
  }
  .range-row {
    display: flex;
    align-items: center;
    gap: var(--sp-2);
    min-height: 40px;
    padding: 0 var(--sp-2) 0 var(--sp-3);
    border-left: 2px solid transparent;
    cursor: pointer;
  }
  .range-row:hover {
    background: var(--surface-2);
  }
  .range-row.active {
    border-left-color: var(--accent);
    background: var(--accent-weak);
  }
  .range-main {
    display: flex;
    flex: 1;
    min-width: 0;
    flex-direction: column;
  }
  .range-name {
    color: var(--text-primary);
    font-size: var(--fs-sm);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .range-meta {
    color: var(--text-tertiary);
    font-size: var(--fs-xs);
  }
  .range-input {
    flex: 1;
    min-width: 0;
    padding: 2px 3px;
    background: var(--surface-1);
    border: 1px solid var(--accent);
    border-radius: 2px;
    color: inherit;
    font: inherit;
    font-size: var(--fs-sm);
  }
  .empty {
    margin: var(--sp-3);
    color: var(--text-tertiary);
    font-size: var(--fs-xs);
    line-height: 1.6;
  }

  .footer {
    display: flex;
    align-items: center;
    gap: var(--sp-3);
    width: 100%;
  }
  .io {
    display: flex;
    align-items: center;
    gap: 6px;
  }
  .io-label {
    color: var(--text-secondary);
    font-size: var(--fs-xs);
  }
  .io-unit {
    color: var(--text-tertiary);
    font-size: var(--fs-xs);
  }
  .hint {
    flex: 1;
    color: var(--text-tertiary);
    font-size: var(--fs-xs);
    text-align: right;
  }

  @media (max-width: 900px) {
    .wrap {
      flex-direction: column;
    }
    .ranges {
      width: auto;
      max-height: 220px;
      border-left: 0;
      border-top: 1px solid var(--border);
    }
    .hint {
      display: none;
    }
  }
</style>
