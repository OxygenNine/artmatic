import { describe, expect, it, vi } from 'vitest';
import type { SourceClip } from '../../src/core/schema';
import { deferred } from './_deferred';

const nextCalled = deferred<void>();
const sampleReady = deferred<unknown>();
let closes = 0;

vi.mock('mediabunny', () => {
  class BlobSource {}
  class BufferSource {}
  class CustomSource {}
  class Input {
    async canRead(): Promise<boolean> {
      return true;
    }
    async getPrimaryVideoTrack() {
      return {
        async getDisplayWidth() {
          return 64;
        },
        async getDisplayHeight() {
          return 36;
        },
      };
    }
    dispose(): void {}
  }
  class VideoSampleSink {
    samples() {
      return {
        next: async () => {
          nextCalled.resolve();
          return { done: false, value: await sampleReady.promise };
        },
        return: async () => ({ done: true, value: undefined }),
      };
    }
  }
  return { ALL_FORMATS: [], BlobSource, BufferSource, CustomSource, Input, VideoSampleSink };
});

vi.mock('../../src/engine/media-assets', () => ({
  videoMediaFor: () => new Uint8Array([1]),
}));

import { createVideoSourceManager } from '../../src/engine/video-source';

function clip(): SourceClip {
  return {
    kind: 'source',
    id: 'v',
    start: 0,
    end: 2,
    label: 'v',
    fadeSec: 0,
    curves: {},
    source: { type: 'video', assetId: 'a' },
    blend: 'normal',
    opacity: 1,
    transform: { x: 0.5, y: 0.5, sx: 1, sy: 1, rot: 0 },
    fit: 'contain',
  } as SourceClip;
}

describe('VideoSourceManager 的释放竞态', () => {
  it('forget 之后解码回来的一帧不再上传纹理', async () => {
    let uploads = 0;
    const manager = createVideoSourceManager(
      { gl: { deleteTexture() {} } } as never,
      () => {
        uploads += 1;
        return { tex: {} as WebGLTexture, w: 64, h: 36 };
      },
    );

    const pending = manager.prepare(clip(), 0.5, 100);
    await nextCalled.promise;
    manager.forget('a');
    sampleReady.resolve({
      timestamp: 0.5,
      duration: 1 / 30,
      draw() {},
      close() {
        closes += 1;
      },
    });
    await pending;

    expect(uploads).toBe(0);
    // 解码器池里的这一帧必须关掉，不能因为“不要了”就漏 close。
    expect(closes).toBe(1);
  });
});
