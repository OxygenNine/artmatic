import { describe, expect, it } from 'vitest';
import { TypographyRuntime } from '../../src/typography/runtime';
import type { TextBackendRegistry, TextRasterizer } from '../../src/typography/rasterizer';
import { createBlankProject } from '../../src/core/demo-project';
import { createTextElement, createTypographyDocument } from '../../src/typography/document';
import type { Project } from '../../src/core/schema';
import { deferred } from './_deferred';

function fakeGl(): WebGL2RenderingContext {
  return {
    createTexture: () => ({}) as WebGLTexture,
    deleteTexture() {},
    bindTexture() {},
    texImage2D() {},
    texParameteri() {},
    pixelStorei() {},
  } as unknown as WebGL2RenderingContext;
}

function projectWithText(): Project {
  const project = createBlankProject('race');
  const track = project.tracks.find((t) => t.kind === 'visual')!;
  const doc = createTypographyDocument({ w: 640, h: 360 });
  doc.elements.push(createTextElement(doc.size, { text: 'A' }));
  track.clips.push({
    kind: 'source',
    id: 'txt',
    start: 0,
    end: 2,
    label: 'text',
    fadeSec: 0,
    curves: {},
    source: { type: 'text', doc },
    blend: 'normal',
    opacity: 1,
    transform: { x: 0.5, y: 0.5, sx: 1, sy: 1, rot: 0 },
    fit: 'contain',
  } as never);
  return project;
}

describe('TypographyRuntime 导出预热', () => {
  it('同键已有预览在飞时必须等它，不能提前返回', async () => {
    const gate = deferred<HTMLCanvasElement>();
    let calls = 0;
    const backend = {
      id: 'dom-snap',
      isAvailable: () => true,
      rasterize: () => {
        calls += 1;
        return gate.promise;
      },
      dispose() {},
    } as TextRasterizer;
    const backends: TextBackendRegistry = {
      pick: () => backend,
      byId: () => backend,
      dispose() {},
    };
    const fonts = {
      ensure: async () => {},
      localFonts: () => undefined,
      ready: () => true,
      missing: () => [],
    };
    const runtime = new TypographyRuntime(
      { gl: fakeGl(), w: 320, h: 180 } as never,
      backends,
      fonts as never,
      {
        fps: () => 30,
        scriptsEnabled: () => false,
        isPlaying: () => false,
        projectSeed: () => 1,
        onReady: () => {},
      } as never,
    );
    const project = projectWithText();

    let secondSettled = false;
    const first = runtime.prewarmFrame(project, 0.5);
    const second = runtime.prewarmFrame(project, 0.5).then(() => {
      secondSettled = true;
    });

    // 第一次已经发起光栅化；第二次不能绕过它先结算。
    await Promise.resolve();
    await Promise.resolve();
    expect(calls).toBe(1);
    expect(secondSettled).toBe(false);

    const canvas = { width: 64, height: 36 } as HTMLCanvasElement;
    gate.resolve(canvas);
    await Promise.all([first, second]);
    expect(secondSettled).toBe(true);
  });

  it('dispose 之后回来的捕获不再上传纹理', async () => {
    const gate = deferred<HTMLCanvasElement>();
    let textures = 0;
    const gl = fakeGl();
    gl.createTexture = () => {
      textures += 1;
      return {} as WebGLTexture;
    };
    const backend = {
      id: 'dom-snap',
      isAvailable: () => true,
      rasterize: () => gate.promise,
      dispose() {},
    } as TextRasterizer;
    const runtime = new TypographyRuntime(
      { gl, w: 320, h: 180 } as never,
      { pick: () => backend, byId: () => backend, dispose() {} },
      { ensure: async () => {}, localFonts: () => undefined, ready: () => true, missing: () => [] } as never,
      {
        fps: () => 30,
        scriptsEnabled: () => false,
        isPlaying: () => false,
        projectSeed: () => 1,
        onReady: () => {},
      } as never,
    );
    const running = runtime.prewarmFrame(projectWithText(), 0.5);
    runtime.dispose();
    gate.resolve({ width: 64, height: 36 } as HTMLCanvasElement);
    await running;
    expect(textures).toBe(0);
  });
});
