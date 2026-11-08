/**
 * clip-editor.test.ts — 「双击片段进哪个子界面」的判据。
 *
 * 这条判据是四处共用的（双击分派 / 时间轴角标 / 检查器按钮 / 底栏提示），
 * 所以错的形态不是崩溃，而是**四处说法不一致**：片段上画着 palette，
 * 双击却只打开了抽屉；或者底栏说「编辑调色」，按下去什么都没发生。
 */
import { describe, expect, it } from 'vitest';
import { clipEditorOf, hasFullscreenEditor } from '../../src/ui/clip-editor';
import type { AnyClip } from '../../src/core/schema';

const source = (type: string, generator?: string): AnyClip =>
  ({ kind: 'source', source: { type, ...(generator ? { generator } : {}) } }) as never;

const effect = (defIds: string[], enabled = true): AnyClip =>
  ({
    kind: 'effect',
    chain: defIds.map((defId) => ({ instanceId: `i-${defId}`, defId, enabled, values: {} })),
  }) as never;

describe('clipEditorOf', () => {
  it('排版：text 来源的 source 片段', () => {
    expect(clipEditorOf(source('text'))).toBe('typography');
  });

  it('其它来源没有独立页面（只开检查器抽屉）', () => {
    for (const type of ['solid', 'algo', 'image', 'video']) {
      expect(clipEditorOf(source(type)), type).toBeNull();
    }
  });

  it('调色：链上真有 grade-*，且混在别的特效中间也算', () => {
    expect(clipEditorOf(effect(['grade-basic']))).toBe('grade');
    expect(clipEditorOf(effect(['pixelate', 'grade-curves', 'glow']))).toBe('grade');
  });

  it('只有普通特效 / 空链：null', () => {
    expect(clipEditorOf(effect(['pixelate', 'glow']))).toBeNull();
    expect(clipEditorOf(effect([]))).toBeNull();
  });

  it('前缀必须完整匹配：`grade-` 开头的才叫调色模块', () => {
    expect(clipEditorOf(effect(['upgrade-look']))).toBeNull();
  });

  /*
   * 停用的 grade 也算：双击是**进去把它重新打开**的入口。若要按 enabled 判，
   * 用户停用之后就再也没有入口（片段上图标消失、按钮消失、底栏改口）。
   */
  it('grade 模块被停用也照样能进（进去才能重新打开它）', () => {
    expect(clipEditorOf(effect(['grade-basic'], false))).toBe('grade');
  });

  it('音频片段没有编辑器', () => {
    expect(clipEditorOf({ kind: 'audio' } as never)).toBeNull();
  });

  /*
   * 共内核 ≠ 共界面。流体复用粒子的 `gpu-sim` 内核，但没配粒子编辑器 ——
   * 按 `kind` 判会让它双击进到一页大半控件与它无关（看起来像「复用的时候忘删了」）。
   * 判据必须是「生成器自报有没有配界面」。
   */
  it('流体：共用 gpu-sim 内核，但没有全屏编辑页', () => {
    expect(hasFullscreenEditor('fluid')).toBe(false);
    expect(clipEditorOf(source('algo', 'fluid'))).toBeNull();
  });

  it('粒子：声明了全屏编辑页，双击进粒子编辑器', () => {
    expect(hasFullscreenEditor('particles')).toBe(true);
    expect(clipEditorOf(source('algo', 'particles'))).toBe('particles');
  });
});
