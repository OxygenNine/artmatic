import { afterEach, describe, expect, it } from 'vitest';
import { withExportFrame } from '../../src/render/export-frame';
import { stackNeedsReplay } from '../../src/effects/feedback-detect';
import { createBlankProject } from '../../src/core/demo-project';
import { resetCapacity, setLimits } from '../../src/core/capacity';
import type { EffectClip, Project, SourceClip } from '../../src/core/schema';
import type { Renderer } from '../../src/engine/renderer';
import { deferred } from './_deferred';

/**
 * `render/export-frame.ts` 的取材序列 + `effects/feedback-detect.ts` 的判据。
 *
 * 这两个文件是**没有渲染结果可看**的那种代码：错了不会报错，只会让「截图与预览
 * 不一致」在某个用户那里复现。所以这里用**假 renderer** 把调用序列逐条钉住 ——
 * 真 GPU 上做这件事既慢又会被 AGENTS §1.3 的两只鬼打成偶发失败。
 */

const FPS = 30;
const DURATION = 4;

function solid(): SourceClip {
  return {
    kind: 'source',
    id: 'src',
    start: 0,
    end: DURATION,
    label: 'src',
    fadeSec: 0,
    curves: {},
    source: { type: 'solid', color: '#ffffff' },
    blend: 'normal',
    opacity: 1,
    transform: { x: 0.5, y: 0.5, sx: 1, sy: 1, rot: 0 },
    fit: 'stretch',
  };
}

function effect(defId: string): EffectClip {
  return {
    kind: 'effect',
    id: 'fx',
    start: 0,
    end: DURATION,
    label: 'fx',
    fadeSec: 0,
    curves: {},
    chain: [{ instanceId: 'i1', defId, enabled: true, values: {} }],
  };
}

/** 一条源轨；`defId` 给了就再压一条特效轨（**在其之上**：z 序 = 列表位置取反）。 */
function projectWith(defId?: string): Project {
  const p = createBlankProject('t');
  p.fps = FPS;
  p.duration = DURATION;
  p.resolution = { w: 320, h: 180 };
  const visual = p.tracks.find((t) => t.kind === 'visual');
  if (!visual || visual.kind !== 'visual') throw new Error('空白工程应当有一条视觉轨');
  visual.clips.push(solid());
  if (defId) {
    p.tracks.unshift({
      kind: 'visual',
      id: 'fx-track',
      name: 'FX',
      enabled: true,
      clips: [effect(defId)],
    });
  }
  return p;
}

/** 记录调用顺序的假 renderer。只用到 `withExportFrame` 碰的那几个方法。 */
interface Probe {
  renderer: Renderer;
  /** 每次 `renderFrame` 的 t（按顺序）。 */
  frames: number[];
  /** 完整调用日志，用来断言「钉尺寸 → seek → 导出模式 → 字体」的先后与对称还原。 */
  log: string[];
}

function probe(): Probe {
  const frames: number[] = [];
  const log: string[] = [];
  const renderer = {
    kit: { canvas: {} as HTMLCanvasElement },
    setExportSize: (w: number, h: number) => log.push(`size:${w}x${h}`),
    clearExportSize: () => log.push('clearSize'),
    onSeek: () => log.push('seek'),
    enterExportMode: () => log.push('enter'),
    exitExportMode: () => log.push('exit'),
    prewarmFonts: async () => {
      log.push('fonts');
    },
    prepareFrame: async () => {
      log.push('prepare');
    },
    renderFrame: (_p: Project, t: number) => {
      frames.push(t);
    },
  };
  return { renderer: renderer as unknown as Renderer, frames, log };
}

afterEach(() => {
  resetCapacity();
});

describe('stackNeedsReplay', () => {
  it('没有跨帧历史的栈不需要重放', () => {
    expect(stackNeedsReplay(projectWith(), 1)).toBe(false);
    // 有特效但那个特效没有 feedback / delayedInput 也一样
    expect(stackNeedsReplay(projectWith('grain'), 1)).toBe(false);
  });

  it('主 pass 带 feedback 的特效需要重放（echo）', () => {
    expect(stackNeedsReplay(projectWith('echo'), 1)).toBe(true);
  });

  it('只有 pre-pass 带 feedback 的特效也要重放', () => {
    // fast-mosh 的 pre-pass 声明了 feedback + delayedInput（见 shader-def 的字段说明）
    expect(stackNeedsReplay(projectWith('fast-mosh'), 1)).toBe(true);
  });

  it('只看命中 t 的时刻：片段之外不算', () => {
    const p = projectWith('echo');
    const fx = p.tracks.find((t) => t.id === 'fx-track');
    if (fx?.kind !== 'visual') throw new Error('缺少特效轨');
    fx.clips[0]!.start = 2;
    expect(stackNeedsReplay(p, 1)).toBe(false);
    expect(stackNeedsReplay(p, 3)).toBe(true);
  });

  it('禁用的实例不算（它不会跑，也就没有历史）', () => {
    const p = projectWith('echo');
    const fx = p.tracks.find((t) => t.id === 'fx-track');
    if (fx?.kind !== 'visual') throw new Error('缺少特效轨');
    (fx.clips[0] as EffectClip).chain[0]!.enabled = false;
    expect(stackNeedsReplay(p, 1)).toBe(false);
  });
});

describe('withExportFrame', () => {
  it('钉尺寸 → seek → 导出模式 → 字体预热，结束时对称还原', async () => {
    const { renderer, log } = probe();
    const out = await withExportFrame(renderer, projectWith(), 1, () => 'done');
    expect(out).toBe('done');
    expect(log).toEqual([
      'size:320x180',
      'seek',
      'enter',
      'fonts',
      'prepare',
      'prepare',
      'clearSize',
      'seek',
      'exit',
    ]);
  });

  it('无反馈的栈走单帧取材：同一 t 渲两次，取第二帧（跨过启动窗口）', async () => {
    const { renderer, frames } = probe();
    await withExportFrame(renderer, projectWith(), 1, () => null);
    expect(frames).toEqual([1, 1]);
  });

  it('有反馈时从第 0 帧顺序重放到目标帧（与导出循环逐帧等价）', async () => {
    const { renderer, frames } = probe();
    const info = await withExportFrame(renderer, projectWith('echo'), 0.1, (_c, i) => i);
    // 0.1 s @30fps = 第 3 帧；重放 0,1,2,3
    expect(frames.map((t) => Math.round(t * FPS))).toEqual([0, 1, 2, 3]);
    expect(info.replayed).toBe(4);
    expect(info.truncated).toBe(false);
  });

  it('重放超过上限时退回单帧，并把 truncated 报出去（不许卡住一次点击）', async () => {
    setLimits({ snapshotReplayMaxFrames: 60 });
    const { renderer, frames } = probe();
    // 第 90 帧 > 60 帧上限
    const info = await withExportFrame(renderer, projectWith('echo'), 3, (_c, i) => i);
    expect(frames).toEqual([3, 3]);
    expect(info.replayed).toBe(0);
    expect(info.truncated).toBe(true);
  });

  it('replay:false（体积采样）即使栈里有反馈也只渲单帧', async () => {
    const { renderer, frames } = probe();
    const info = await withExportFrame(renderer, projectWith('echo'), 3, (_c, i) => i, {
      replay: false,
    });
    expect(frames).toEqual([3, 3]);
    expect(info.truncated).toBe(false);
  });

  it('两次取材串行执行，不会同时钉尺寸', async () => {
    let active = 0;
    let peak = 0;
    const renderer = {
      kit: { canvas: {} as HTMLCanvasElement },
      setExportSize() {
        active += 1;
        peak = Math.max(peak, active);
      },
      clearExportSize() {
        active -= 1;
      },
      onSeek() {},
      enterExportMode() {},
      exitExportMode() {},
      async prewarmFonts() {},
      async prepareFrame() {},
      renderFrame() {},
    } as unknown as Renderer;
    const gate = deferred<void>();
    const first = withExportFrame(renderer, projectWith(), 0, async () => {
      await gate.promise;
      return 1;
    });
    const second = withExportFrame(renderer, projectWith(), 0, async () => 2);

    await Promise.resolve();
    await Promise.resolve();
    expect(peak).toBe(1);

    gate.resolve();
    await Promise.all([first, second]);
    expect(peak).toBe(1);
  });
});
