/**
 * grade-panels.svelte.ts — 调色页里四个面板的显隐。
 *
 * 为什么不是 `appState` 的字段：这是**页内**的视图偏好（和大纲折叠一样），
 * 不参与保存、不参与导出、也不该让工程变脏。放成模块单例，侧栏（开关）与
 * 面板本身（× 关闭）读同一份，不需要逐层传 props。
 *
 * 默认全开：第一次进调色页的人该看到全部四块，然后自己关掉不要的。
 */

export type GradePanelId = 'wheels' | 'curves' | 'scopes' | 'lut';

class GradePanelsState {
  wheels = $state(true);
  curves = $state(true);
  scopes = $state(true);
  lut = $state(true);

  /**
   * 色轮那一块占底部宽度的比例（另一块吃掉剩下的）。
   *
   * 只有「拖」这一个入口，所以不钳到 0/1：0.3–0.85 是拖拽时允许的范围，
   * 再外面就有一块小到连标题都放不下。
   */
  wheelsFrac = $state(0.56);

  setWheelsFrac(v: number): void {
    if (!Number.isFinite(v)) return;
    this.wheelsFrac = Math.min(0.85, Math.max(0.3, v));
  }

  /** 示波器在码头里占的高度比例（剩下给查找表）。 */
  scopeFrac = $state(0.62);

  setScopeFrac(v: number): void {
    if (!Number.isFinite(v)) return;
    this.scopeFrac = Math.min(0.85, Math.max(0.2, v));
  }

  isOpen(id: GradePanelId): boolean {
    return this[id];
  }

  toggle(id: GradePanelId): void {
    this[id] = !this[id];
  }

  set(id: GradePanelId, open: boolean): void {
    this[id] = open;
  }

  /** 底部那一行（色轮 / 曲线）有没有开着的。 */
  get bottomOpen(): boolean {
    return this.wheels || this.curves;
  }

  /** 右栏码头有没有开着的。 */
  get dockOpen(): boolean {
    return this.scopes || this.lut;
  }
}

export const gradePanels = new GradePanelsState();
