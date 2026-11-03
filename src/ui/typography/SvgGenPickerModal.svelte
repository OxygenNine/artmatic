<script lang="ts">
  /**
   * SvgGenPickerModal — 「插入生成器」选择器（一期 20 + 二期 2，共 22 个）。
   *
   * 三个设计点：
   *  1. **预览与插入同源**：每张卡就是 `buildFromSpec(spec, 默认参数, defaultSeed)`
   *     的真实输出 —— 和 `insert` 后落到画布上的那条 `d` 逐字节相同。手画预览
   *     迟早与生成器分家（`shapeCards()` 也是同一套纪律）。
   *  2. **按组分区**（网格 / 径向 / 线 / 轮廓 / 伪 3D / 编码）：二十多个平铺会把
   *     「这条斜纹和那条斜纹有什么区别」变成找不同。
   *  3. **单击即插入**：不做多选。一次要几个就再开一次 —— 多选插入一大堆元素
   *     在排版场景里没人用，而多选状态会让「点错了」变成先取消再重来。
   */
  import Modal from '../controls/Modal.svelte';
  import {
    GEN_GROUPS,
    SVG_GENERATORS,
    buildFromSpec,
    defaultsOf,
    generatorsInGroup,
    type SvgGenSpec,
  } from '../../typography/svg-gen';
  import { tr } from '../../i18n/index.svelte';

  interface Props {
    onpick: (id: string) => void;
    onclose: () => void;
    /** 弹窗标题（缺省 = 插入生成器）。换类型时由属性面板给「更换生成器」。 */
    title?: string;
    /** 当前正在用的生成器 id：高亮那一格。 */
    current?: string;
  }
  const { onpick, onclose, title, current }: Props = $props();

  interface Card {
    id: string;
    label: string;
    d: string;
    evenOdd: boolean;
    strokeOnly: boolean;
    aspect: number;
    /** 预览盒尺寸（px）。**必须与 aspect 严格同比例** —— 见文件头的说明。 */
    artW: number;
    artH: number;
  }

  /*
   * 预览盒尺寸**算出来**，不靠 `width:78% + max-height` 夹。
   *
   * 之前那套写法在宽卡片上会把高度钳到 72px、宽度保持 78%（≈122px），
   * 于是 `<svg preserveAspectRatio="none">` 把 0..100 的方盒横向拉成 1.7 倍 ——
   * 表现就是「同心环变成横向椭圆」。这里先按 aspect 定死盒子的宽高，
   * 拉伸比例才与插入后的元素框一致（1:1 的生成器就一定是正方形）。
   */
  const ART_H = 76;
  const ART_MAX_W = 132;
  function artBox(aspect: number): { w: number; h: number } {
    const w = Math.min(ART_MAX_W, ART_H * aspect);
    return { w, h: w / aspect };
  }

  function cardOf(spec: SvgGenSpec): Card {
    // 默认参数 + 默认种子 —— 与 `actions.addGeneratedShape` 的第一次 build 一致。
    const r = buildFromSpec(spec, defaultsOf(spec), spec.defaultSeed);
    const aspect = spec.aspect ?? 1;
    const box = artBox(aspect);
    return {
      id: spec.id,
      label: tr(spec.labelKey),
      d: r.d,
      evenOdd: r.evenOdd === true,
      strokeOnly: r.strokeOnly === true,
      aspect,
      artW: box.w,
      artH: box.h,
    };
  }

  /** 每个分组在打开弹窗时算一次（22 次纯循环，关闭即销毁）。 */
  const groups = GEN_GROUPS.map((g) => ({
    id: g.id,
    label: tr(g.labelKey),
    cards: generatorsInGroup(g.id).map(cardOf),
  }));

  function pick(id: string): void {
    onpick(id);
    onclose();
  }
</script>

<Modal title={title ?? tr('gen.pickerTitle')} testid="typo-gen-picker" {onclose}>
  <div class="gen-body">
    {#each groups as group (group.id)}
      <section class="gen-group" data-testid={`typo-gen-group-${group.id}`}>
        <h3>{group.label}</h3>
        <div class="gen-grid">
          {#each group.cards as card (card.id)}
            <button
              type="button"
              class="gen-card"
              class:current={card.id === current}
              data-current={card.id === current ? 'true' : undefined}
              title={card.label}
              aria-label={card.label}
              data-testid={`typo-gen-card-${card.id}`}
              onclick={() => pick(card.id)}
            >
              <span
                class="gen-art"
                style:width={`${card.artW}px`}
                style:height={`${card.artH}px`}
              >
                <svg viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true">
                  <path
                    d={card.d}
                    fill-rule={card.evenOdd ? 'evenodd' : 'nonzero'}
                    fill={card.strokeOnly ? 'none' : 'currentColor'}
                    stroke={card.strokeOnly ? 'currentColor' : 'none'}
                    stroke-width={card.strokeOnly ? 1.4 : 0}
                    stroke-linejoin="round"
                    stroke-linecap="round"
                  />
                </svg>
              </span>
              <span class="gen-name">{card.label}</span>
            </button>
          {/each}
        </div>
      </section>
    {/each}
  </div>
</Modal>

<style>
  .gen-hint {
    margin: 0 0 var(--sp-3);
    font-size: var(--fs-xs);
    color: var(--text-muted);
    line-height: 1.5;
  }
  /*
   * **固定四列**：每组最多 4 个生成器，用 auto-fill 会排出 7～8 个空列，
   * 整块内容挤在左边、右半幅全是空白。四列正好让「有一组只有 3 个」留一个空位，
   * 而不是每行都短一截。
   */
  .gen-body {
    min-height: 0;
  }
  .gen-group {
    margin-bottom: var(--sp-4);
  }
  .gen-group h3 {
    margin: 0 0 var(--sp-2);
    font-size: var(--fs-xs);
    font-weight: 600;
    color: var(--text-secondary);
  }
  .gen-grid {
    display: grid;
    grid-template-columns: repeat(4, minmax(0, 1fr));
    gap: var(--sp-2);
  }
  .gen-card {
    display: grid;
    grid-template-rows: 1fr auto;
    gap: 4px;
    align-items: center;
    justify-items: center;
    padding: var(--sp-2);
    min-height: 104px;
    background: var(--surface-0);
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    color: var(--text-primary);
    cursor: pointer;
  }
  .gen-card:hover {
    border-color: var(--accent);
  }
  /* 当前正在用的那一格（换类型时高亮）。 */
  .gen-card.current {
    border-color: var(--accent);
    background: var(--surface-2);
  }
  /*
   * 盒子尺寸由 JS 按 `aspect` 算好后内联（见 `artBox`）。这里**不要**再用
   * `width: %` + `max-height` 夹 —— 那会让盒子与 aspect 脱钩、把图形横向拉伸。
   */
  .gen-art {
    display: block;
    color: var(--text-primary);
  }
  .gen-art svg {
    display: block;
    width: 100%;
    height: 100%;
  }
  .gen-name {
    font-size: var(--fs-xs);
    color: var(--text-muted);
    line-height: 1.3;
    text-align: center;
  }
</style>
