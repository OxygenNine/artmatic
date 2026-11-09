import { beforeEach, describe, expect, it } from 'vitest';
import {
  exportOwner,
  resetExportGateForTests,
  tryAcquireExport,
} from '../../src/exporters/export-gate';

describe('导出闸门', () => {
  beforeEach(() => resetExportGateForTests());

  it('同一时刻只允许一个占用者', () => {
    const release = tryAcquireExport('ui');
    expect(release).not.toBeNull();
    expect(exportOwner()).toBe('ui');
    expect(tryAcquireExport('agent')).toBeNull();
    expect(tryAcquireExport('ui')).toBeNull();
  });

  it('释放后可以再次占用，且旧 lease 的重复释放不会清掉新占用者', () => {
    const first = tryAcquireExport('ui')!;
    first();
    expect(exportOwner()).toBeNull();

    const second = tryAcquireExport('agent')!;
    expect(exportOwner()).toBe('agent');
    // 过期 lease 再次释放必须无效。
    first();
    expect(exportOwner()).toBe('agent');
    second();
    expect(exportOwner()).toBeNull();
  });
});
