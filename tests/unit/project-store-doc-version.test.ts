import { describe, expect, it } from 'vitest';
import { createBlankProject } from '../../src/core/demo-project';
import { ProjectStore } from '../../src/core/project-store';

/**
 * `ProjectStore` 的两个计数器：`version`（重绘信号）与 `docVersion`（内容版本）。
 *
 * 「未保存圆点」的判据是后者。这两个混在一起时的症状不是报错，而是
 * 「播放时一直被标脏」或者「改了东西却没标脏」—— 只有把每条路径的增量钉住才看得见。
 */
function store(): { s: ProjectStore; mirror: () => number } {
  const s = new ProjectStore(createBlankProject('doc-version'));
  // 模拟 `AppState.subscribeActive` 的响应式镜像：它只在收到通知时更新。
  let mirror = s.docVersion;
  s.subscribe(() => {
    mirror = s.docVersion;
  });
  return { s, mirror: () => mirror };
}

describe('ProjectStore.docVersion', () => {
  it('invalidate：只动 version，不动内容版本', () => {
    const { s } = store();
    s.invalidate();
    expect(s.version).toBe(1);
    expect(s.docVersion).toBe(0);
  });

  it('touch / commit：两个都动', () => {
    const { s } = store();
    s.touch();
    expect(s.version).toBe(1);
    expect(s.docVersion).toBe(1);

    s.commit('改名', (p) => {
      p.name = '改过了';
    });
    expect(s.version).toBe(2);
    expect(s.docVersion).toBe(2);
  });

  it('内容没变的 commit 什么都不动（撤销栈与脏标记都不该多一条）', () => {
    const { s } = store();
    expect(
      s.commit('没改', () => {
        /* 空操作 */
      }),
    ).toBe(false);
    expect(s.version).toBe(0);
    expect(s.docVersion).toBe(0);
  });

  it('取消手势：内容版本退回事务起点，并且界面收到通知', () => {
    const { s, mirror } = store();
    s.touch();
    const base = s.docVersion; // 1

    s.beginTx();
    s.touch();
    s.touch();
    expect(s.docVersion).toBe(base + 2);

    s.cancelTx();
    expect(s.docVersion).toBe(base);
    // 回退必须通知出去，否则镜像停在 base+2，圆点要等下一次无关重绘才消失。
    expect(mirror()).toBe(base);
  });

  it('手势结束但内容回到起点：内容版本同样退回', () => {
    const { s, mirror } = store();
    const base = s.docVersion;

    s.beginTx();
    s.touch();
    expect(s.docVersion).toBe(base + 1);

    expect(s.endTx('拖回原处')).toBe(false);
    expect(s.docVersion).toBe(base);
    expect(mirror()).toBe(base);
  });

  it('手势真的改了内容：内容版本保留', () => {
    const { s } = store();
    const base = s.docVersion;

    s.beginTx();
    s.commit('改分辨率', (p) => {
      p.resolution = { w: 320, h: 180 };
    });
    expect(s.endTx('改分辨率')).toBe(true);
    expect(s.docVersion).toBeGreaterThan(base);
  });

  it('撤销 / 重做都是内容变化', () => {
    const { s } = store();
    s.commit('改名', (p) => {
      p.name = 'a';
    });
    const afterEdit = s.docVersion;

    s.undo();
    expect(s.docVersion).toBe(afterEdit + 1);
    s.redo();
    expect(s.docVersion).toBe(afterEdit + 2);
  });
});
