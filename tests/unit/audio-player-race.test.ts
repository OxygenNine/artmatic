import { afterEach, describe, expect, it, vi } from 'vitest';
import { AudioPlayer } from '../../src/audio/player';
import { createBlankProject } from '../../src/core/demo-project';
import { deferred } from './_deferred';

/**
 * 只实现 `play()` 走到的那几条 API。`resume()` 的结算由测试控制，
 * 这正是「await 期间用户按了暂停」那个窗口。
 */
class FakeAudioContext {
  state: AudioContextState = 'suspended';
  currentTime = 0;
  destination = {} as AudioDestinationNode;
  private readonly resumed = deferred<void>();

  resume(): Promise<void> {
    return this.resumed.promise;
  }

  finishResume(): void {
    this.resumed.resolve();
    this.state = 'running';
  }

  createBufferSource(): AudioBufferSourceNode {
    return {
      buffer: null,
      playbackRate: { value: 1, setValueCurveAtTime() {} },
      connect() {},
      start() {},
      stop() {},
    } as unknown as AudioBufferSourceNode;
  }

  createGain(): GainNode {
    return {
      gain: { setValueCurveAtTime() {} },
      connect() {},
    } as unknown as GainNode;
  }
}

let ctx: FakeAudioContext;

function installFakeAudio(): void {
  ctx = new FakeAudioContext();
  vi.stubGlobal('AudioContext', function AudioContext() {
    return ctx;
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('AudioPlayer 的异步播放竞态', () => {
  it('await resume 期间 stop()，旧的 play 不得复活播放', async () => {
    installFakeAudio();
    const player = new AudioPlayer();
    const project = createBlankProject('t');
    project.tracks = [];

    const playing = player.play(project, 0);
    expect(player.isPlaying).toBe(false);

    player.stop();
    ctx.finishResume();
    await playing;

    expect(player.isPlaying).toBe(false);
    expect(player.currentT()).toBeNull();
  });

  it('连续两次 play 只有最后一次生效', async () => {
    installFakeAudio();
    const player = new AudioPlayer();
    const project = createBlankProject('t');
    project.tracks = [];

    const first = player.play(project, 0);
    const second = player.play(project, 1);
    ctx.finishResume();
    await Promise.all([first, second]);

    // 第二次 play 自己先 stop 了一次，所以它拿到的代次是最新的。
    expect(player.isPlaying).toBe(true);
    expect(player.currentT()).toBe(1);
  });
});
