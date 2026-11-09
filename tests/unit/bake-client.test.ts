import { afterEach, describe, expect, it, vi } from 'vitest';
import { BakeClient } from '../../src/algos/bake-client';

interface Posted {
  type: string;
  reqId: number;
}

class FakeWorker {
  static last: FakeWorker;
  onmessage: ((e: MessageEvent) => void) | null = null;
  onerror: ((e: ErrorEvent) => void) | null = null;
  readonly posted: Posted[] = [];
  terminated = false;

  constructor() {
    FakeWorker.last = this;
  }

  postMessage(msg: Posted): void {
    this.posted.push(msg);
  }

  terminate(): void {
    this.terminated = true;
  }

  emit(msg: unknown): void {
    this.onmessage?.({ data: msg } as MessageEvent);
  }

  crash(message: string): void {
    this.onerror?.({ message } as ErrorEvent);
  }
}

function fakeKit(): { gl: WebGL2RenderingContext } {
  return {
    gl: {
      createTexture: () => ({}) as WebGLTexture,
      deleteTexture() {},
      bindTexture() {},
      texImage2D() {},
      texParameteri() {},
    } as unknown as WebGL2RenderingContext,
  };
}

function makeClient(): { client: BakeClient; worker: FakeWorker; ready: () => number } {
  let ready = 0;
  vi.stubGlobal('Worker', FakeWorker);
  const client = new BakeClient(fakeKit() as never, () => {
    ready += 1;
  });
  return { client, worker: FakeWorker.last, ready: () => ready };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('BakeClient 失败态', () => {
  it('同一条请求只会发一次', () => {
    const { client, worker } = makeClient();
    expect(client.request('h1', 'g', {}, 1)).toBeNull();
    expect(client.request('h1', 'g', {}, 1)).toBeNull();
    expect(worker.posted).toHaveLength(1);
  });

  it('error 消息之后不再每帧重发（粘性失败）', () => {
    const { client, worker } = makeClient();
    client.request('h1', 'g', {}, 1);
    worker.emit({ type: 'error', reqId: worker.posted[0]!.reqId, message: 'bad' });
    client.request('h1', 'g', {}, 1);
    client.request('h1', 'g', {}, 1);
    expect(worker.posted).toHaveLength(1);
  });

  it('Worker 级崩溃不会把请求永久挂在 pending 里', () => {
    const { client, worker } = makeClient();
    client.request('h1', 'g', {}, 1);
    worker.crash('boom');
    client.request('h1', 'g', {}, 1);
    // 崩溃被记为粘性失败：不重发，也不卡在「已有请求」的假状态。
    expect(worker.posted).toHaveLength(1);
  });

  it('成功结果进缓存，后续请求不再发消息', () => {
    const { client, worker, ready } = makeClient();
    client.request('h1', 'g', {}, 1);
    worker.emit({
      type: 'done',
      reqId: worker.posted[0]!.reqId,
      result: { data: new Uint8Array(4), w: 2, h: 2, frontMax: 1 },
    });
    const tex = client.request('h1', 'g', {}, 1);
    expect(tex).not.toBeNull();
    expect(worker.posted).toHaveLength(1);
    expect(ready()).toBe(1);
  });

  it('dispose 之后请求返回 null 且 Worker 被终止', () => {
    const { client, worker } = makeClient();
    client.request('h1', 'g', {}, 1);
    client.dispose();
    expect(worker.terminated).toBe(true);
    expect(client.request('h1', 'g', {}, 1)).toBeNull();
  });
});
