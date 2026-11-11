import { describe, expect, it } from 'vitest';
import {
  buildPluginRows,
  issueText,
  missingText,
  summaryText,
} from '../../src/ui/plugin-manager/plugin-panel-model';
import { LOCALES, type MessageKey } from '../../src/i18n/locales';
import { interpolate, type MessageVars } from '../../src/i18n/format';
import type { LoadedPlugin, PluginFailure } from '../../src/plugins/host';
import type { PluginIssueCode } from '../../src/plugins/manifest';
import type { PluginDefIssue } from '../../src/core/plugin-id';

/**
 * 插件面板的纯逻辑。
 *
 * 它做的事情很窄（码 → 句子），但**错了很难发现**：要造一个坏插件才会在界面上
 * 看到那些行，而坏法有十几种。所以这里逐条把「码」喂进去，断言它不会退化成
 * 键名 —— 界面上出现 `pl.issue.xxx` 就是这一层漏了。
 */

const zh = LOCALES['zh-CN'] as Record<string, string>;
const tr = (key: MessageKey, vars?: MessageVars): string => interpolate(zh[key] ?? key, vars);

function plugin(overrides: Partial<LoadedPlugin> = {}): LoadedPlugin {
  return {
    id: 'demo',
    name: '演示插件',
    author: null,
    version: null,
    license: null,
    fileName: 'demo.js',
    enabled: true,
    status: 'ok',
    effectCount: 1,
    generatorCount: 0,
    hookCount: 0,
    panels: [],
    actions: [],
    activated: true,
    issues: [],
    failure: null,
    verified: true,
    ...overrides,
  };
}

/** 界面上出现了 `pl.x` 这种键名 —— 说明某条码没有对应的文案。 */
function looksLikeKey(s: string): boolean {
  return /^pl\.[a-z-]+(\.[a-z-]+)?$/.test(s);
}

describe('每一行', () => {
  it('正常插件：名称、状态、计数、元信息', () => {
    const [row] = buildPluginRows(
      [plugin({ version: '1.0.0', author: '某人', license: 'MIT', effectCount: 2, generatorCount: 1 })],
      tr,
    );
    expect(row!.name).toBe('演示插件');
    expect(row!.statusLabel).toBe(zh['pl.status.ok']);
    expect(row!.tone).toBe('ok');
    expect(row!.counts).toContain('2');
    expect(row!.counts).toContain('1');
    expect(row!.meta).toContain('1.0.0');
    expect(row!.meta).toContain('某人');
    expect(row!.meta).toContain('MIT');
    expect(row!.issues).toEqual([]);
    expect(row!.disabledNote).toBeNull();
  });

  it('没有版本/作者/许可时元信息是空串（不是一串空分隔符）', () => {
    const [row] = buildPluginRows([plugin()], tr);
    expect(row!.meta).toBe('');
  });

  it('两个计数都是 0 时计数串是空串', () => {
    const [row] = buildPluginRows(
      [plugin({ effectCount: 0, generatorCount: 0, status: 'failed', failure: { code: 'not-a-plugin', detail: '' } })],
      tr,
    );
    expect(row!.counts).toBe('');
  });

  it('部分可用：tone 是 warn，问题进 issues', () => {
    const [row] = buildPluginRows(
      [plugin({ status: 'partial', issues: [{ code: 'dropped-uniform', path: 'effects:x', detail: 'u_a' }] })],
      tr,
    );
    expect(row!.tone).toBe('warn');
    expect(row!.statusLabel).toBe(zh['pl.status.partial']);
    expect(row!.issues).toHaveLength(1);
  });

  it('加载失败：tone 是 error，名字回落到 id', () => {
    const [row] = buildPluginRows(
      [plugin({ status: 'failed', name: null, failure: { code: 'import-failed', detail: 'SyntaxError: x' } })],
      tr,
    );
    expect(row!.tone).toBe('error');
    expect(row!.name).toBe('demo');
    expect(row!.issues[0]).toContain('SyntaxError: x');
    expect(looksLikeKey(row!.issues[0]!)).toBe(false);
  });

  it('停用：tone 是 muted，并解释「为什么没有名字」', () => {
    const [row] = buildPluginRows([plugin({ status: 'disabled', enabled: false, name: null })], tr);
    expect(row!.tone).toBe('muted');
    expect(row!.enabled).toBe(false);
    expect(row!.disabledNote).toBe(zh['pl.disabledNotice']);
  });

  it('停用但**有**名字时不显示那条解释（它本来就是多余的）', () => {
    const [row] = buildPluginRows([plugin({ status: 'disabled', enabled: false })], tr);
    expect(row!.disabledNote).toBeNull();
  });

  it('顺序沿用宿主给的顺序', () => {
    const rows = buildPluginRows([plugin({ id: 'a' }), plugin({ id: 'b' }), plugin({ id: 'c' })], tr);
    expect(rows.map((r) => r.id)).toEqual(['a', 'b', 'c']);
  });
});

describe('问题码 → 句子：一个都不能漏', () => {
  const ALL_ISSUE_CODES: PluginIssueCode[] = [
    'not-object',
    'bad-format',
    'bad-api-version',
    'bad-id',
    'bad-name',
    'bad-list',
    'no-defs',
    'bad-def',
    'duplicate-id',
    'bad-param',
    'bad-shader',
    'unknown-meta',
    'read-failed',
    'compile-failed',
    'dropped-uniform',
    'bad-aux',
    'bad-hook',
    'hook-failed',
    'bad-panel',
    'bad-action',
    'bad-activate',
    'panel-failed',
    'action-failed',
    'activate-failed',
  ];

  it('每个码都翻得出句子，且不是键名、不留占位符', () => {
    for (const code of ALL_ISSUE_CODES) {
      const text = issueText({ code, path: 'effects[0]', detail: 'X' }, tr);
      expect(text, code).toBeTruthy();
      expect(looksLikeKey(text), `${code} → ${text}`).toBe(false);
      expect(text, `${code} 的占位符没被替换`).not.toContain('{');
    }
  });

  it('bad-def 的 detail 是**另一个码**，会被再翻一层', () => {
    const codes: PluginDefIssue['code'][] = ['missing-id', 'duplicate-id', 'builtin-conflict'];
    const texts = codes.map((def) => issueText({ code: 'bad-def', path: 'effects:x', detail: def }, tr));
    for (const t of texts) {
      expect(t).not.toContain('{');
      expect(looksLikeKey(t), t).toBe(false);
    }
    // 三句互不相同 —— 否则「id 重复」与「与内置冲突」会长得一模一样。
    expect(new Set(texts).size).toBe(3);
    // 认不出来的 detail 原样带出来，不吞掉（好过显示一句没有信息量的话）。
    expect(issueText({ code: 'bad-def', path: 'effects:x', detail: 'weird' }, tr)).toContain('weird');
  });

  it('五种失败原因都有句子', () => {
    const codes: PluginFailure['code'][] = [
      'import-failed',
      'timeout',
      'not-a-plugin',
      'invalid-manifest',
      'read-failed',
    ];
    for (const code of codes) {
      const [row] = buildPluginRows([plugin({ status: 'failed', failure: { code, detail: 'D' } })], tr);
      expect(row!.issues[0], code).toBeTruthy();
      expect(looksLikeKey(row!.issues[0]!), code).toBe(false);
      // 占位符必须被替换掉。**不能笼统地断言「不含 `{`」** ——
      // `pl.fail.notAPlugin` 里就带着一段示例代码 `{...}`。
      expect(row!.issues[0], code).not.toContain('{detail}');
    }
    expect(
      buildPluginRows([plugin({ status: 'failed', failure: { code: 'timeout', detail: '8000' } })], tr)[0]!.issues[0],
    ).toContain('8000');
  });

  it('四种状态都有句子，且互不相同', () => {
    const labels = (['ok', 'partial', 'failed', 'disabled'] as const).map((status) => {
      const [row] = buildPluginRows(
        [plugin({ status, failure: status === 'failed' ? { code: 'not-a-plugin', detail: '' } : null })],
        tr,
      );
      expect(looksLikeKey(row!.statusLabel), status).toBe(false);
      return row!.statusLabel;
    });
    expect(new Set(labels).size).toBe(4);
  });

  it('失败时**不显示** issues 列表（失败原因已经够了）', () => {
    const [row] = buildPluginRows(
      [
        plugin({
          status: 'failed',
          failure: { code: 'invalid-manifest', detail: 'bad-id' },
          issues: [{ code: 'bad-id', detail: 'X' }],
        }),
      ],
      tr,
    );
    expect(row!.issues).toHaveLength(1);
    expect(row!.issues[0]).toBe(zh['pl.fail.invalidManifest']);
  });
});

describe('摘要与缺失提示', () => {
  it('空集合显示空态文案', () => {
    expect(summaryText([], tr)).toBe(zh['pl.empty']);
  });

  it('全好时只说数量', () => {
    expect(summaryText(buildPluginRows([plugin(), plugin({ id: 'b' })], tr), tr)).toBe(
      interpolate(zh['pl.summary'], { total: 2 }),
    );
  });

  it('有问题时把「几个有问题」说出来', () => {
    const rows = buildPluginRows(
      [
        plugin(),
        plugin({ id: 'b', status: 'partial' }),
        plugin({ id: 'c', status: 'failed', failure: { code: 'not-a-plugin', detail: '' } }),
      ],
      tr,
    );
    const text = summaryText(rows, tr);
    expect(text).toContain('3');
    expect(text).toContain('2');
  });

  it('缺失提示用顿号连接 id（id 里本来就有点和连字符）', () => {
    const text = missingText(['a-plugin', 'b.plugin'], tr);
    expect(text).toContain('a-plugin、b.plugin');
    expect(text).not.toContain('{');
  });

  it('缺失提示空集合时不炸（调用方会先判空，但纯函数不该因此抛）', () => {
    expect(() => missingText([], tr)).not.toThrow();
  });
});
