import { beforeEach, describe, expect, it } from 'vitest';
import {
  analysisCount,
  analyzeAsset,
  clearAnalyses,
  forgetAnalysis,
  peekAnalysis,
  type AnalysisBuffer,
} from '../../src/audio/analysis';
import { CHROMA_DIM } from '../../src/audio/chroma';

/**
 * 共享分析缓存。判据集中在「会不会白算一遍」和「删掉的素材会不会复活」：
 *
 * 1. 同 `(assetId, buffer)` 只算一次 —— 渲染与 agent 各要一份，算两遍是两倍等待。
 * 2. 换了 buffer 对象必须重算 —— 同名素材重新导入后帧数可能变，旧索引会整体错位。
 * 3. `forget` 之后在途的结果**不许**写回 —— 否则删掉的素材在几百毫秒后复活，
 *    而界面上看不出任何线索。
 */

const SR = 44100;

interface Fake extends AnalysisBuffer {
  id: string;
}

function fakeBuffer(id: string, seconds = 1): Fake {
  const length = Math.round(seconds * SR);
  const data = new Float32Array(length);
  for (let i = 0; i < length; i += 1) {
    data[i] = Math.sin((i / SR) * 2 * Math.PI * 440) * 0.5;
  }
  return { id, length, numberOfChannels: 1, sampleRate: SR, getChannelData: () => data };
}

beforeEach(() => clearAnalyses());

describe('共享分析缓存：只算一次', () => {
  it('同 (assetId, buffer) 两次调用给同一个对象', async () => {
    const buf = fakeBuffer('a');
    const first = await analyzeAsset('a', buf);
    const second = await analyzeAsset('a', buf);
    expect(second).toBe(first);
    expect(peekAnalysis('a', buf)).toBe(first);
  });

  it('并发调用拿到同一个 Promise（单飞）', () => {
    const buf = fakeBuffer('a');
    const p1 = analyzeAsset('a', buf);
    const p2 = analyzeAsset('a', buf);
    expect(p2).toBe(p1);
  });

  it('换了 buffer 对象必须重算', async () => {
    const one = fakeBuffer('a');
    const two = fakeBuffer('a');
    const a = await analyzeAsset('a', one);
    const b = await analyzeAsset('a', two);
    expect(b).not.toBe(a);
    expect(peekAnalysis('a', two)).toBe(b);
    expect(peekAnalysis('a', one)).toBeNull();
  });

  it('chroma 随特征一起产出，长度与帧数严格对应', async () => {
    const buf = fakeBuffer('a', 2);
    const { features } = await analyzeAsset('a', buf);
    expect(features.chroma).toBeDefined();
    expect(features.chroma!.length).toBe(features.frames * CHROMA_DIM);
  });
});

describe('共享分析缓存：失效', () => {
  it('forget 之后 peek 为空，但还能重新算', async () => {
    const buf = fakeBuffer('a');
    const first = await analyzeAsset('a', buf);
    forgetAnalysis('a');
    expect(peekAnalysis('a', buf)).toBeNull();
    expect(analysisCount()).toBe(0);
    const again = await analyzeAsset('a', buf);
    expect(again).not.toBe(first);
  });

  it('forget 之后在途的结果不写回缓存（素材不会复活）', async () => {
    const buf = fakeBuffer('a');
    const pending = analyzeAsset('a', buf);
    forgetAnalysis('a');
    await pending;
    expect(peekAnalysis('a', buf)).toBeNull();
    expect(analysisCount()).toBe(0);
  });

  it('clearAnalyses 清空全部', async () => {
    await analyzeAsset('a', fakeBuffer('a'));
    await analyzeAsset('b', fakeBuffer('b'));
    expect(analysisCount()).toBe(2);
    clearAnalyses();
    expect(analysisCount()).toBe(0);
  });
});
