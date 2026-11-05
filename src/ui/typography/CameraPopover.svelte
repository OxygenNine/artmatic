<script lang="ts">
  /**
   * CameraPopover — 排版镜头的浮层（受控，触发按钮在「设计」Ribbon 里）。
   *
   * 四个数字就是 `Camera` 的四个参数：平移（文档 px）、缩放（倍）、旋转（度）。
   * **没有「确定」**，改一下立刻生效 —— 与画布浮层、取色卡一致。
   * 元素吃多少镜头由各自的「深度」决定（元素属性面板），这里只管相机本身。
   *
   * 复位是一个图标按钮而不是「缩放回 100%」的隐含语义：镜头有四个参数，
   * 让用户逐个调回去不算复位。
   */
  import NumberInput from '../controls/NumberInput.svelte';
  import Slider from '../controls/Slider.svelte';
  import IconButton from '../controls/IconButton.svelte';
  import Field from '../controls/Field.svelte';
  import { attachDismiss, computePopoverPosition } from '../controls/popover';
  import { CAMERA_ZOOM_RANGE, type Camera } from '../../typography/document';
  import { tr } from '../../i18n/index.svelte';

  interface Props {
    /** 锚点元素（Ribbon 里那个按钮）。浮层贴着它向下展开。 */
    anchor: HTMLElement;
    /** 关闭（外点 / 滚轮 / Esc；再点一次按钮由编辑器负责开合）。 */
    onclose: () => void;
    /** 当前镜头（已归一化；没有镜头时就是恒等值）。 */
    camera: Camera;
    /** 一次性的离散改动（数字框回车 / 失焦）。一笔撤销。 */
    onset: (patch: Partial<Camera>) => void;
    /** 拖动中的实时改动（不入撤销栈）。 */
    onlive: (patch: Partial<Camera>) => void;
    /** 实时改动收尾（松手）。 */
    onend: () => void;
    /** 复位：删掉镜头字段（回到「没有镜头」，与新建文档逐像素相同）。 */
    onreset: () => void;
  }
  const { anchor, onclose, camera, onset, onlive, onend, onreset }: Props = $props();

  let panelEl = $state<HTMLDivElement | undefined>(undefined);
  const pos = $state({ x: -1, y: -1 });
  const positioned = $derived(pos.x >= 0 && pos.y >= 0);
  const panelId = $props.id();

  /** 缩放用百分比显示（0.05..40 → 5..4000）。 */
  const zoomPct = $derived(Math.round(camera.zoom * 100));

  $effect(() => {
    if (!panelEl) return;
    const p = computePopoverPosition(
      anchor.getBoundingClientRect(),
      { width: panelEl.offsetWidth, height: panelEl.offsetHeight },
      { width: window.innerWidth, height: window.innerHeight },
      'bottom-start',
    );
    if (pos.x !== p.x || pos.y !== p.y) {
      pos.x = p.x;
      pos.y = p.y;
    }
  });

  $effect(() => {
    const handle = attachDismiss({
      onclose,
      // 锚点也算「里面」：再点一次按钮是编辑器的开合手势，这里不要抢先关。
      isInside: (t) => panelEl?.contains(t) === true || anchor.contains(t),
    });
    return () => handle.destroy();
  });
</script>

<div
  class="cam-pop"
  id={panelId}
  bind:this={panelEl}
  role="dialog"
  aria-label={tr('typo.camera')}
  data-testid="typo-camera-pop"
  style:left={`${pos.x}px`}
  style:top={`${pos.y}px`}
  style:visibility={positioned ? undefined : 'hidden'}
  onwheel={(e) => e.stopPropagation()}
>
  <div class="cam-head">
    <IconButton
      icon="rotate-ccw"
      label={tr('typo.cameraReset')}
      tipText={tr('typo.cameraReset')}
      size="sm"
      testid="typo-camera-reset"
      onclick={onreset}
    />
  </div>

  <Field label={tr('typo.cameraPanX')} labelWidth={48}>
    <NumberInput
      value={Math.round(camera.x)}
      step={10}
      width={72}
      suffix="px"
      ariaLabel={tr('typo.cameraPanX')}
      testid="typo-camera-x"
      onchange={(v) => onset({ x: v })}
    />
  </Field>
  <Field label={tr('typo.cameraPanY')} labelWidth={48}>
    <NumberInput
      value={Math.round(camera.y)}
      step={10}
      width={72}
      suffix="px"
      ariaLabel={tr('typo.cameraPanY')}
      testid="typo-camera-y"
      onchange={(v) => onset({ y: v })}
    />
  </Field>

  <Field label={tr('typo.cameraZoom')} labelWidth={48} tipText={tr('typo.cameraZoomTip')}>
    <Slider
      min={Math.round(CAMERA_ZOOM_RANGE[0] * 100)}
      max={400}
      step={1}
      value={zoomPct}
      ariaLabel={tr('typo.cameraZoom')}
      testid="typo-camera-zoom"
      oninput={(v) => onlive({ zoom: v / 100 })}
      onchange={() => onend()}
    />
    <NumberInput
      value={zoomPct}
      min={Math.round(CAMERA_ZOOM_RANGE[0] * 100)}
      max={Math.round(CAMERA_ZOOM_RANGE[1] * 100)}
      step={5}
      width={58}
      suffix="%"
      ariaLabel={tr('typo.cameraZoom')}
      testid="typo-camera-zoom-num"
      onchange={(v) => onset({ zoom: v / 100 })}
    />
  </Field>

  <Field label={tr('typo.cameraRot')} labelWidth={48}>
    <NumberInput
      value={Math.round(camera.rot * 10) / 10}
      step={1}
      width={72}
      suffix="°"
      ariaLabel={tr('typo.cameraRot')}
      testid="typo-camera-rot"
      onchange={(v) => onset({ rot: v })}
    />
  </Field>
</div>

<style>
  .cam-pop {
    position: fixed;
    z-index: var(--z-menu);
    width: 236px;
    padding: var(--sp-3);
    background: var(--menu-bg);
    border: 1px solid var(--menu-border);
    border-radius: var(--radius-md);
  }
  .cam-head {
    display: flex;
    justify-content: flex-end;
    margin-bottom: var(--sp-1);
  }
</style>
