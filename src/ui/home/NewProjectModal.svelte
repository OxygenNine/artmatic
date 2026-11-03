<script lang="ts">
  /**
   * NewProjectModal — 首页那个「+」打开的建工程弹窗。
   *
   * 四个值：名称 / 比例 / 分辨率 / 帧率。别的**一律不问** —— 时长、拍网格、
   * 重叠策略都能在工程里改，而它们在「还没开始」的时候没有答案。
   *
   * 比例不是工程字段，它只是分辨率的**筛选器**：选 9:16 之后分辨率下拉里只剩
   * 竖屏档位，省得用户自己对着 1920×1080 想「要不要对调」。所以两个控件之间
   * 是单向的（改比例 → 重置分辨率到该比例的第一档），不互相反推。
   *
   * ⚠️ 提交时 **先关弹窗再建工程**：`newProject` 一把 `hasProject` 变成真，
   * 首页（连同这个弹窗）就整棵卸载了，反过来写会对着已销毁的组件设状态。
   */
  import Modal from '../controls/Modal.svelte';
  import Button from '../controls/Button.svelte';
  import Field from '../controls/Field.svelte';
  import TextField from '../controls/TextField.svelte';
  import Select from '../controls/Select.svelte';
  import { newProject } from '../project-actions';
  import { tr } from '../../i18n/index.svelte';

  interface Props {
    onclose: () => void;
  }
  const { onclose }: Props = $props();

  /** 比例 → 可选分辨率。每族第一档就是该比例的默认值（1080 级）。 */
  const RATIOS = [
    { id: '16:9', sizes: [[1920, 1080], [1280, 720], [3840, 2160], [854, 480]] },
    { id: '9:16', sizes: [[1080, 1920], [720, 1280]] },
    { id: '1:1', sizes: [[1080, 1080], [720, 720]] },
    { id: '4:3', sizes: [[1440, 1080], [1024, 768]] },
    { id: '21:9', sizes: [[2560, 1080], [3440, 1440]] },
  ] as const;

  const FPS = [24, 25, 30, 50, 60] as const;

  const sizeId = (w: number, h: number): string => `${w}x${h}`;

  let name = $state(tr('proj.unnamed'));
  let ratio = $state<string>('16:9');
  let size = $state<string>(sizeId(1920, 1080));
  let fps = $state<string>('30');

  const sizes = $derived(RATIOS.find((r) => r.id === ratio)?.sizes ?? RATIOS[0].sizes);

  const ratioOptions = RATIOS.map((r) => ({ value: r.id as string, label: r.id }));
  const sizeOptions = $derived(
    sizes.map(([w, h]) => ({ value: sizeId(w, h), label: `${w} × ${h}` })),
  );
  const fpsOptions = FPS.map((v) => ({ value: String(v), label: `${v} fps` }));

  function pickRatio(next: string): void {
    ratio = next;
    const first = RATIOS.find((r) => r.id === next)?.sizes[0];
    // 换比例必须同时换分辨率：留着 1920×1080 会让「9:16」显示成横屏。
    if (first) size = sizeId(first[0], first[1]);
  }

  function create(): void {
    const [w, h] = size.split('x').map(Number);
    const payload = {
      name,
      width: w ?? 0,
      height: h ?? 0,
      fps: Number(fps),
    };
    onclose();
    void newProject(false, payload);
  }
</script>

<Modal title={tr('app.newProject')} testid="modal-new-project" {onclose}>
  <div class="np">
    <Field label={tr('app.projectName')} labelWidth={72} testid="new-project-row-name">
      <TextField
        value={name}
        ariaLabel={tr('app.projectName')}
        testid="new-project-name"
        maxLength={80}
        onchange={(v) => (name = v)}
      />
    </Field>

    <Field label={tr('app.homeRatio')} labelWidth={72} testid="new-project-row-ratio">
      <Select
        value={ratio}
        options={ratioOptions}
        ariaLabel={tr('app.homeRatio')}
        testid="new-project-ratio"
        optionTestidPrefix="new-project-ratio-opt"
        onchange={pickRatio}
      />
    </Field>

    <Field label={tr('app.resolution')} labelWidth={72} testid="new-project-row-size">
      <Select
        value={size}
        options={sizeOptions}
        ariaLabel={tr('app.resolution')}
        testid="new-project-size"
        optionTestidPrefix="new-project-size-opt"
        onchange={(v) => (size = v)}
      />
    </Field>

    <Field label={tr('app.frameRate')} labelWidth={72} testid="new-project-row-fps">
      <Select
        value={fps}
        options={fpsOptions}
        ariaLabel={tr('app.frameRate')}
        testid="new-project-fps"
        optionTestidPrefix="new-project-fps-opt"
        onchange={(v) => (fps = v)}
      />
    </Field>
  </div>

  {#snippet footer()}
    <Button label={tr('common.cancel')} variant="outline" testid="new-project-cancel" onclick={onclose} />
    <Button label={tr('app.homeCreate')} variant="accent" testid="new-project-create" onclick={create} />
  {/snippet}
</Modal>

<style>
  .np {
    display: flex;
    flex-direction: column;
    gap: var(--sp-4);
    /* 四个值不值得占满 760px：整块居中、行内容左对齐，读起来才是「一份表单」。 */
    max-width: 420px;
    margin: 0 auto;
  }
</style>
