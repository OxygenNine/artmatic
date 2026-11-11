import { describe, expect, it } from 'vitest';
import { draftSource, tryPlugin, type DraftStore } from '../../src/agent/plugin-author';
import { ControlFailure, type AgentPluginHost } from '../../src/agent/types';

/**
 * 试挂的**审批卡**要能读到源码。
 *
 * 这张卡显示在 `host.importBytes` 之前（那时插件还没执行、也没有宿主记录），
 * 所以源码只能来自草稿区。旧实现把 `drafts.set` 放在确认之后，卡片点开永远是
 * 一个破折号 —— 而这不是「源码没显示」，是用户被要求批准一份自己看不见的代码。
 */

const SOURCE = `export const plugin = {
  format: 'artmatic-plugin',
  apiVersion: 3,
  id: 'demo',
  name: 'Demo',
  generators: [{ id: 'g', name: 'G', params: [], fragment: 'void main(){}', setUniforms() {} }],
};`;

/** 只满足类型的最小宿主：确认之前它一次都不该被调用。 */
function fakeHost(): AgentPluginHost {
  return {
    importBytes: async () => {
      throw new Error('importBytes must not run before confirmation');
    },
    get: () => null,
    list: () => [],
    markPersisted: () => undefined,
  };
}

describe('试挂的审批卡', () => {
  it('未确认时抛 needs-approval，但源码已经进了草稿区', async () => {
    const drafts: DraftStore = new Map();
    await expect(
      tryPlugin({
        host: fakeHost(),
        projectKey: 'p1',
        drafts,
        input: { id: 'demo', name: 'Demo', source: SOURCE },
      }),
    ).rejects.toBeInstanceOf(ControlFailure);

    expect(draftSource(drafts, 'demo')).toBe(SOURCE);
  });

  it('needs-approval 的 detail 不带源码（那是几十 KB，进模型上下文就是浪费）', async () => {
    const drafts: DraftStore = new Map();
    let failure: ControlFailure | null = null;
    try {
      await tryPlugin({
        host: fakeHost(),
        projectKey: 'p1',
        drafts,
        input: { id: 'demo', name: 'Demo', source: SOURCE },
      });
    } catch (e) {
      failure = e as ControlFailure;
    }
    expect(failure?.code).toBe('needs-approval');
    expect(JSON.stringify(failure?.detail ?? {})).not.toContain('artmatic-plugin');
  });
});
