import { describe, expect, it } from 'vitest';
import { runExport } from '../../src/exporters/export-runner';
import type { FrameSink } from '../../src/exporters/frame-sink';
import { createBlankProject } from '../../src/core/demo-project';
import type { Project } from '../../src/core/schema';

interface FakeRenderer {
  setExportSize(w: number, h: number): void;
  onSeek(): void;
  enterExportMode(): void;
  clearExportSize(): void;
  exitExportMode(): void;
  prewarmFonts(p: Project): Promise<void>;
  prepareFrame(p: Project, t: number): Promise<void>;
  renderFrame(p: Project, t: number): void;
  kit: { canvas: HTMLCanvasElement };
}

function renderer(): FakeRenderer {
  return {
    setExportSize() {},
    onSeek() {},
    enterExportMode() {},
    clearExportSize() {},
    exitExportMode() {},
    async prewarmFonts() {},
    async prepareFrame() {},
    renderFrame() {},
    kit: { canvas: {} as HTMLCanvasElement },
  };
}

function sink(finalize: () => Promise<Blob | string>): FrameSink & { cancelled: number } {
  const s = {
    cancelled: 0,
    async configure() {},
    async submit() {},
    finalize,
    async cancel() {
      s.cancelled += 1;
    },
  };
  return s;
}

describe('runExport 收尾', () => {
  it('finalize 抛错时也要 cancel，释放编码器 / 流式写入', async () => {
    const s = sink(async () => {
      throw new Error('disk full');
    });
    const p = createBlankProject('t');
    p.duration = 0.1;
    await expect(
      runExport(renderer() as never, p, { sink: s, codec: 'png' }),
    ).rejects.toThrow('disk full');
    expect(s.cancelled).toBe(1);
  });

  it('finalize 成功时不调用 cancel', async () => {
    const s = sink(async () => new Blob(['ok']));
    const p = createBlankProject('t');
    p.duration = 0.1;
    const blob = await runExport(renderer() as never, p, { sink: s, codec: 'png' });
    expect(blob).toBeInstanceOf(Blob);
    expect(s.cancelled).toBe(0);
  });

  it('导出期间修改原工程不影响已开始的产物（使用快照）', async () => {
    const seen: string[] = [];
    const r = renderer();
    r.renderFrame = (p) => seen.push(p.name);
    const p = createBlankProject('before');
    p.duration = 0.3;
    const s = sink(async () => new Blob(['ok']));
    s.submit = async () => {
      // 模拟导出循环 await 期间用户在另一条路径改了工程。
      p.name = 'after';
    };
    await runExport(r as never, p, { sink: s, codec: 'png' });
    expect(seen.length).toBeGreaterThan(1);
    expect(seen.every((name) => name === 'before')).toBe(true);
  });
});
