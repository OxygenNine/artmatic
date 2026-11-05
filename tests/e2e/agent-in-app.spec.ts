/**
 * agent-in-app.spec.ts — 应用内 Agent 面板的端到端验收（不需要真 Key）。
 *
 * 做法：`page.route('**\/chat/completions')` 伪造 **SSE**，让「模型 → 工具 →
 * 结果 → 下一轮」这条循环真的跑一遍。断言落在三处：
 *   1. 面板状态机（消息流 / 工具卡 / 本轮改动条）；
 *   2. 工程真的被改了（`__artmatic.control.getScene` 读回来）；
 *   3. 「撤销本轮」真的把整轮撤掉（`CommandStack` 事务内的 commit 不单独入栈）。
 *
 * 插件那两条走**真 GL 编译**（预览就在这个页面里），所以它们是「插件作者面」
 * 唯一能自动化的一段：坏源码给结构化 issue、好源码进注册表。
 */

import { expect, test, type Page, type Route } from '@playwright/test';
import { openDemo } from './_stage';

const KEY = 'e2e-key';

/* --------------------------------------------------------------- SSE 工具 */

interface Delta {
  content?: string;
  reasoning_content?: string;
  tool_calls?: {
    index: number;
    id?: string;
    type?: 'function';
    function?: { name?: string; arguments?: string };
  }[];
}

function chunk(delta: Delta): string {
  return `data: ${JSON.stringify({ choices: [{ delta, finish_reason: null }] })}\n\n`;
}

function toolCall(id: string, name: string, args: unknown): string {
  return chunk({
    tool_calls: [
      { index: 0, id, type: 'function', function: { name, arguments: JSON.stringify(args) } },
    ],
  });
}

function textChunk(text: string): string {
  return chunk({ content: text });
}

function reasoningChunk(text: string): string {
  return chunk({ reasoning_content: text });
}

function usageChunk(prompt: number, completion: number): string {
  return `data: ${JSON.stringify({ choices: [], usage: { prompt_tokens: prompt, completion_tokens: completion } })}\n\n`;
}

const DONE = 'data: [DONE]\n\n';

const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-headers': '*',
  'access-control-allow-methods': 'POST, OPTIONS',
};

/**
 * 按请求序号返回不同的 SSE。`responses[i]` 是第 i 次请求的完整响应体；
 * 用完之后重复最后一条（避免竞态导致的 500 看起来像面板坏了）。
 */
async function stubLlm(
  page: Page,
  responses: string[],
): Promise<{ calls: () => number; bodies: () => Record<string, unknown>[] }> {
  let n = 0;
  const bodies: Record<string, unknown>[] = [];
  await page.route('**/chat/completions', async (route: Route) => {
    if (route.request().method() === 'OPTIONS') {
      await route.fulfill({ status: 204, headers: CORS, body: '' });
      return;
    }
    const raw = route.request().postData();
    if (raw) {
      try {
        bodies.push(JSON.parse(raw) as Record<string, unknown>);
      } catch {
        /* 非 JSON 请求体不参与断言 */
      }
    }
    const i = Math.min(n, responses.length - 1);
    n += 1;
    await route.fulfill({
      status: 200,
      headers: { ...CORS, 'content-type': 'text/event-stream', 'cache-control': 'no-store' },
      body: responses[i]!,
    });
  });
  return { calls: () => n, bodies: () => bodies };
}

/* --------------------------------------------------------------- 面板工具 */

async function openPanel(page: Page): Promise<void> {
  // 与 `agent.spec.ts` 的 `boot` 同序：先等页面真的挂上控制平面，再开示例工程。
  // 少了这步 `openDemo` 会因为 `__artmatic` 还没就绪直接返回，而首页上的
  // rail 是 `inert` 的 —— 后面的点击会一直等到超时。
  await page.goto('/');
  await page.waitForFunction(
    () => Boolean((window as never as { __artmatic?: { control?: unknown } }).__artmatic?.control),
  );
  await openDemo(page);
  await page.getByTestId('rail-agent').click();
  await expect(page.getByTestId('agent-drawer')).toBeVisible();
}

async function configureKey(page: Page): Promise<void> {
  const setup = page.getByTestId('agent-open-settings');
  if (await setup.isVisible()) await setup.click();
  else await page.getByTestId('agent-settings').click();
  const modal = page.getByTestId('agent-settings-modal');
  await expect(modal).toBeVisible();
  const key = page.getByTestId('agent-key');
  await key.fill(KEY);
  await key.press('Tab');
  await page.getByTestId('agent-settings-done').click();
  await expect(modal).toHaveCount(0);
}

async function send(page: Page, text: string): Promise<void> {
  const input = page.getByTestId('agent-input');
  await input.fill(text);
  await page.getByTestId('agent-send').click();
}

/* ------------------------------------------------------------------ tests */

test('未填 Key：面板给出可执行的下一步，设置是独立 modal', async ({ page }) => {
  await openPanel(page);
  await page.getByTestId('agent-open-settings').click();
  await expect(page.getByTestId('agent-settings-modal')).toBeVisible();
  // Esc 关掉（与其它 modal 同一套键位）
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('agent-settings-modal')).toHaveCount(0);
  // 填过 key 之后顶部图标仍能打开同一个 modal
  await configureKey(page);
  await page.getByTestId('agent-settings').click();
  await expect(page.getByTestId('agent-settings-modal')).toBeVisible();
});

test('消息多到一屏时能滚动，且每条消息保持自己的高度（不被 flex 压扁）', async ({ page }) => {
  await openPanel(page);
  await configureKey(page);

  const lines = Array.from({ length: 60 }, (_, i) => `第 ${i + 1} 行：这是一段用来撑高消息区的文本。`).join('\n');
  await stubLlm(page, [textChunk(lines) + DONE]);

  await send(page, '念一段长文本');
  await expect(page.getByTestId('agent-msg-assistant')).toContainText('第 60 行', { timeout: 20_000 });

  const box = await page.evaluate(() => {
    const stream = document.querySelector('[data-testid="agent-stream"]');
    const msgs = [...document.querySelectorAll('[data-testid="agent-msg-assistant"]')];
    if (!stream) return null;
    return {
      clientHeight: stream.clientHeight,
      scrollHeight: stream.scrollHeight,
      scrollTop: stream.scrollTop,
      msgHeights: msgs.map((m) => Math.round(m.getBoundingClientRect().height)),
    };
  });
  expect(box).not.toBeNull();
  expect(box!.scrollHeight).toBeGreaterThan(box!.clientHeight + 120);
  // 压扁的形态是每条 20px 上下；这里要求最后一条真的占到了多行的高度
  expect(Math.max(...box!.msgHeights)).toBeGreaterThan(200);
  // 贴底自动跟随（用户没往上翻）
  expect(box!.scrollHeight - box!.scrollTop - box!.clientHeight).toBeLessThan(80);
});

test('对话文本可选中，右键是 Artmatic 自己的菜单（复制 / 添加到输入框）', async ({ page }) => {
  await openPanel(page);
  await configureKey(page);

  await stubLlm(page, [textChunk('这一段可以复制。') + DONE]);
  await send(page, '说一句');
  await expect(page.getByTestId('agent-msg-assistant')).toContainText('可以复制', { timeout: 20_000 });

  const selectable = await page.getByTestId('agent-stream').evaluate((el) => getComputedStyle(el).userSelect);
  expect(selectable).toBe('text');

  await page.evaluate(() => {
    const el = document.querySelector('[data-testid="agent-msg-assistant"]');
    if (!el) throw new Error('no message');
    const range = document.createRange();
    range.selectNodeContents(el);
    const sel = window.getSelection();
    sel?.removeAllRanges();
    sel?.addRange(range);
    el.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 320, clientY: 260 }));
  });

  await expect(page.getByTestId('agent-ctx-menu')).toBeVisible();
  await page.getByTestId('agent-ctx-to-input').click();
  await expect(page.getByTestId('agent-input')).toHaveValue(/可以复制/);
});

test('上下文环形常驻，用量来自服务端 usage', async ({ page }) => {
  await openPanel(page);
  await configureKey(page);

  await stubLlm(page, [textChunk('好的。') + usageChunk(120_000, 2_000) + DONE]);
  await send(page, '随便说一句');
  await expect(page.getByTestId('agent-msg-assistant')).toContainText('好的', { timeout: 20_000 });

  const ring = page.getByTestId('agent-context-ring');
  await expect(ring).toBeVisible();
  await expect(ring).toHaveAttribute('data-pct', '12');
});

test('输入框：悬浮在底部、模型/强度菜单、附图', async ({ page }) => {
  await openPanel(page);
  await configureKey(page);

  const composerPos = await page.getByTestId('agent-composer').evaluate((el) => getComputedStyle(el).position);
  expect(composerPos).toBe('absolute');

  // 二级菜单：换强度 → chip 跟着变
  await page.getByTestId('agent-composer-meta').click();
  await expect(page.getByTestId('agent-composer-menu')).toBeVisible();
  await page.getByTestId('agent-effort-option-high').click();
  await expect(page.getByTestId('agent-composer-meta')).toContainText('高');
  await page.keyboard.press('Escape');

  // 附图（1×1 PNG，走真实的 file input）
  const png = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
    'base64',
  );
  await page.getByTestId('agent-file-input').setInputFiles({
    name: 'dot.png',
    mimeType: 'image/png',
    buffer: png,
  });
  await expect(page.getByTestId('agent-remove-image')).toHaveCount(1);

  await stubLlm(page, [textChunk('收到图片。') + DONE]);
  await send(page, '看这张图');
  await expect(page.getByTestId('agent-msg-assistant')).toContainText('收到图片', { timeout: 20_000 });
  // 用户消息里带缩略图（base64 不落工程，只在本轮上下文里）
  await expect(page.getByTestId('agent-msg-user').locator('img')).toHaveCount(1);
});

test('思考过程：生成时显示，整轮结束后自动折叠', async ({ page }) => {
  await openPanel(page);
  await configureKey(page);

  await stubLlm(page, [
    reasoningChunk('先看看工程里有什么，再决定要不要改。\n第二行推理。') +
      textChunk('我看了工程，暂时不用改。') +
      DONE,
  ]);

  await send(page, '看一下工程');
  await expect(page.getByTestId('agent-msg-assistant')).toContainText('暂时不用改', { timeout: 20_000 });

  const reasoning = page.getByTestId('agent-reasoning');
  await expect(reasoning).toBeVisible();
  // 轮次结束后自动折叠：文本节点不该在 DOM 里
  await expect(page.getByTestId('agent-reasoning-text')).toHaveCount(0);
  await reasoning.locator('button').click();
  await expect(page.getByTestId('agent-reasoning-text')).toContainText('第二行推理');
});

test('思考模式：原生 reasoning_effort，且工具轮完整回传 reasoning_content', async ({ page }) => {
  await openPanel(page);
  await configureKey(page);

  const stubbed = await stubLlm(page, [
    reasoningChunk('先读场景，再决定。') + toolCall('r1', 'get_scene', { detail: 'ids' }) + DONE,
    textChunk('看完了，没改东西。') + DONE,
    textChunk('好的。') + DONE,
  ]);

  await send(page, '看一眼工程');
  await expect(page.getByTestId('agent-msg-assistant').last()).toContainText('没改东西', { timeout: 20_000 });

  const bodies = stubbed.bodies() as {
    thinking?: { type?: string };
    reasoning_effort?: string;
    messages?: { role: string; tool_calls?: unknown[]; reasoning_content?: string }[];
  }[];
  // 默认强度 = high，原生字段而不是提示词
  expect(bodies[0]?.thinking).toEqual({ type: 'enabled' });
  expect(bodies[0]?.reasoning_effort).toBe('high');

  // 第二次请求（工具结果回填）必须带回上一轮 assistant 的 reasoning_content
  const assistant = bodies[1]?.messages?.find((m) => m.role === 'assistant' && m.tool_calls?.length);
  expect(assistant?.reasoning_content).toBe('先读场景，再决定。');

  // 切到「关闭」再发一轮：thinking.disabled 且不带强度
  await page.getByTestId('agent-composer-meta').click();
  await page.getByTestId('agent-effort-option-off').click();
  await send(page, '再说一句');
  await expect(page.getByTestId('agent-msg-assistant').last()).toContainText('好的', { timeout: 20_000 });
  const offBody = stubbed.bodies().at(-1) as { thinking?: { type?: string }; reasoning_effort?: string };
  expect(offBody.thinking).toEqual({ type: 'disabled' });
  expect(offBody.reasoning_effort).toBeUndefined();
});

test('重复调用：引导写在 tool 结果里，不新增 system 消息（避免 400）', async ({ page }) => {
  await openPanel(page);
  await configureKey(page);

  const same = { detail: 'ids' };
  const stubbed = await stubLlm(page, [
    toolCall('s1', 'get_scene', same) + DONE,
    toolCall('s2', 'get_scene', same) + DONE,
    toolCall('s3', 'get_scene', same) + DONE,
    textChunk('看清楚了。') + DONE,
  ]);

  await send(page, '反复看场景');
  await expect(page.getByTestId('agent-msg-assistant').last()).toContainText('看清楚了', { timeout: 20_000 });
  await expect(page.getByTestId('agent-notice')).toHaveCount(1);

  const bodies = stubbed.bodies() as { messages?: { role: string; content?: unknown }[] }[];
  // 第 4 次请求 = 3 次重复 + 引导
  const last = bodies.at(-1)!;
  expect(last.messages?.filter((m) => m.role === 'system')).toHaveLength(1);
  const toolText = last.messages?.filter((m) => m.role === 'tool').map((m) => String(m.content ?? '')).join('\n');
  expect(toolText).toContain('[system note]');
});

test('HTTP 400 之后自动重置上下文，下一条消息能继续', async ({ page }) => {
  await openPanel(page);
  await configureKey(page);

  let n = 0;
  await page.route('**/chat/completions', async (route: Route) => {
    if (route.request().method() === 'OPTIONS') {
      await route.fulfill({ status: 204, headers: CORS, body: '' });
      return;
    }
    n += 1;
    if (n === 1) {
      await route.fulfill({
        status: 400,
        headers: { ...CORS, 'content-type': 'application/json' },
        body: JSON.stringify({ error: { message: 'reasoning_content is required' } }),
      });
      return;
    }
    await route.fulfill({
      status: 200,
      headers: { ...CORS, 'content-type': 'text/event-stream' },
      body: textChunk('重置之后正常了。') + DONE,
    });
  });

  await send(page, '第一次');
  await expect(page.getByTestId('agent-error')).toContainText('400', { timeout: 20_000 });
  await expect(page.getByTestId('agent-notice')).toContainText('已重置模型上下文');

  await send(page, '第二次');
  await expect(page.getByTestId('agent-msg-assistant').last()).toContainText('正常了', { timeout: 20_000 });
  expect(n).toBe(2);
});

test('ask_user：模型主动暂停提问，回答后继续同一轮', async ({ page }) => {
  await openPanel(page);
  await configureKey(page);

  await stubLlm(page, [
    toolCall('q1', 'ask_user', { question: '用哪个颜色？', options: ['红色', '蓝色'], allowFreeText: true }) + DONE,
    textChunk('好，就用红色。') + DONE,
  ]);

  await send(page, '帮我改个颜色');
  const ask = page.getByTestId('agent-ask');
  await expect(ask).toBeVisible({ timeout: 20_000 });
  await expect(ask).toContainText('用哪个颜色');
  await page.getByTestId('agent-ask-option').filter({ hasText: '红色' }).click();

  await expect(page.getByTestId('agent-ask-answer')).toContainText('红色');
  await expect(page.getByTestId('agent-msg-assistant').last()).toContainText('就用红色', { timeout: 20_000 });
});

// 这一条跑在「没有目录」的工程上：历史只在内存里（与「工程没保存」同一语义）。
// 落盘那条由下一个用例守。
test('会话历史：可搜索、可清空（未保存的工程只在内存里）', async ({ page }) => {
  await openPanel(page);
  await configureKey(page);

  await stubLlm(page, [textChunk('历史记录测试回答。') + DONE]);
  await send(page, '历史搜索关键词海马体');
  await expect(page.getByTestId('agent-msg-assistant')).toContainText('历史记录测试回答', { timeout: 20_000 });

  await page.getByTestId('agent-history').click();
  await expect(page.getByTestId('agent-history-modal')).toBeVisible();
  await expect(page.getByTestId('agent-history-item')).toHaveCount(1);

  // 按内容搜（不是按标题）
  await page.getByTestId('agent-history-search').fill('海马体');
  await expect(page.getByTestId('agent-history-item')).toHaveCount(1);
  await page.getByTestId('agent-history-search').fill('查无此词');
  await expect(page.getByTestId('agent-history-item')).toHaveCount(0);
  await expect(page.getByTestId('agent-history-modal')).toContainText('没有匹配的会话');

  await page.getByTestId('agent-history-search').fill('');
  await page.getByTestId('agent-history-clear').click();
  await expect(page.getByTestId('agent-history-confirm-clear')).toBeVisible();
  await page.getByTestId('agent-history-confirm-clear-ok').click();
  await expect(page.getByTestId('agent-history-item')).toHaveCount(0);
});

/**
 * 历史住在工程目录的 `agent/sessions/<id>.json`，**不在 project.json 里**。
 *
 * 这条同时守三件事：文件真的落了盘；`project.json` 里没有聊天记录；清空历史
 * 会把文件删掉（而不是只清内存 —— 否则下次打开又回来了）。
 */
test('会话历史落盘到 agent/sessions，且不写进 project.json', async ({ page }) => {
  const DIR = 'e2e-agent-history';
  await openPanel(page);
  await configureKey(page);

  // 上一轮的残留会让「文件存在」这类断言假绿。
  await page.evaluate(async (d) => {
    const p = (
      window as never as { __artmatic: { project: { wipe(n: string): Promise<void> } } }
    ).__artmatic.project;
    await p.wipe(d);
  }, DIR);

  // 先给工程一个真实目录，否则历史只会在内存里（与「工程没保存」同一语义）。
  const saved = await page.evaluate(async (d) => {
    const p = (
      window as never as {
        __artmatic: {
          project: {
            useOpfs(n: string): Promise<string>;
            save(): Promise<boolean>;
            list(path?: string): Promise<{ name: string }[]>;
          };
        };
      }
    ).__artmatic.project;
    await p.useOpfs(d);
    const ok = await p.save();
    const root = await p.list(d).catch((e: unknown) => [{ name: `ERR:${String(e)}` }]);
    return { ok, root: root.map((f) => f.name) };
  }, DIR);
  expect(saved.ok, `保存失败：${JSON.stringify(saved.root)}`).toBe(true);
  expect(saved.root, '工程目录里应当有 agent/sessions（PROJECT_DIRS）').toContain('agent');

  await stubLlm(page, [textChunk('落盘回答。') + DONE]);
  await send(page, '落盘测试消息');
  await expect(page.getByTestId('agent-msg-assistant').last()).toContainText('落盘回答', { timeout: 20_000 });

  // 轮末写盘是排队进行的：轮询到文件出现（而不是死等一个固定时长）。
  await expect
    .poll(
      async () =>
        page.evaluate(async (d) => {
          const p = (
            window as never as { __artmatic: { project: { list(path: string): Promise<{ name: string }[]> } } }
          ).__artmatic.project;
          const files = await p.list(`${d}/agent/sessions`).catch(() => []);
          return files.filter((f) => f.name.endsWith('.json')).length;
        }, DIR),
      { timeout: 10_000 },
    )
    .toBe(1);

  const stored = await page.evaluate(async (d) => {
    const p = (
      window as never as {
        __artmatic: { project: { list(path: string): Promise<{ name: string }[]>; read(path: string): Promise<string | null> } };
      }
    ).__artmatic.project;
    const files = await p.list(`${d}/agent/sessions`);
    const name = files.find((f) => f.name.endsWith('.json'))!.name;
    const raw = await p.read(`${d}/agent/sessions/${name}`);
    const projectJson = await p.read(`${d}/project.json`);
    return { session: JSON.parse(raw ?? '{}') as Record<string, unknown>, projectJson: projectJson ?? '' };
  }, DIR);
  expect(stored.session.version).toBe(1);
  expect(stored.session.title).toContain('落盘测试消息');
  expect(JSON.stringify(stored.session.messages)).toContain('落盘回答');
  // 工程本体里不应该再出现聊天记录（历史不再是 Project 的字段）
  expect(stored.projectJson).not.toContain('agentSessions');

  // 重新打开工程：历史从磁盘读回来（这条才证明「关掉再开还在」）
  await page.evaluate(async (d) => {
    const p = (
      window as never as { __artmatic: { project: { open(n: string): Promise<boolean> } } }
    ).__artmatic.project;
    await p.open(d);
  }, DIR);
  await expect(page.getByTestId('agent-drawer')).toBeVisible();
  await page.getByTestId('agent-history').click();
  await expect(page.getByTestId('agent-history-item')).toHaveCount(1, { timeout: 10_000 });

  // 清空 → 文件也消失
  await page.getByTestId('agent-history-clear').click();
  await page.getByTestId('agent-history-confirm-clear-ok').click();
  await expect(page.getByTestId('agent-history-item')).toHaveCount(0);
  await expect
    .poll(
      async () =>
        page.evaluate(async (d) => {
          const p = (
            window as never as { __artmatic: { project: { list(path: string): Promise<{ name: string }[]> } } }
          ).__artmatic.project;
          const files = await p.list(`${d}/agent/sessions`).catch(() => []);
          return files.filter((f) => f.name.endsWith('.json')).length;
        }, DIR),
      { timeout: 10_000 },
    )
    .toBe(0);

  // 收尾：删掉测试目录，别让下一轮「文件存在」类断言假绿。
  await page.evaluate(async (d) => {
    const p = (
      window as never as { __artmatic: { project: { wipe(n: string): Promise<void> } } }
    ).__artmatic.project;
    await p.wipe(d);
  }, DIR);
});

test('一轮对话：读场景 → 加片段 → 本轮改动条 → 撤销本轮', async ({ page }) => {
  await openPanel(page);
  await configureKey(page);

  const trackId = await page.evaluate(async () => {
    const C = (window as never as { __artmatic: { control: { getScene: (o: unknown) => Promise<{ ok: boolean; data: { tracks: { id: string; kind: string }[] } }> } } })
      .__artmatic.control;
    const r = await C.getScene({ detail: 'ids' });
    return r.ok ? (r.data.tracks.find((t) => t.kind === 'visual')?.id ?? '') : '';
  });
  expect(trackId).not.toBe('');

  const stubbed = await stubLlm(page, [
    // 第 1 轮：模型读场景
    toolCall('c1', 'get_scene', { detail: 'ids' }) + DONE,
    // 第 2 轮：加一个纯色片段
    toolCall('c2', 'add_clip', {
      trackId,
      kind: 'solid',
      start: 0,
      end: 2,
      color: '#ff3366',
      label: 'agent-solid',
    }) + DONE,
    // 第 3 轮：收尾
    textChunk('已在最上层加了一段纯色片段。') + DONE,
  ]);

  await send(page, '加一个纯色片段');

  await expect(page.getByTestId('agent-msg-assistant')).toContainText('纯色片段', { timeout: 20_000 });
  await expect(page.getByTestId('agent-tool-card')).toHaveCount(2);
  await expect(page.getByTestId('agent-turn-foot')).toBeVisible();
  expect(stubbed.calls()).toBe(3);

  // 工程真的改了
  const labels = await page.evaluate(() => {
    const C = (window as never as { __artmatic: { control: { getScene: (o: unknown) => Promise<{ ok: boolean; data: { tracks: { clips: { label: string }[] }[] } }> } } })
      .__artmatic.control;
    return C.getScene({ detail: 'ids' }).then((r) =>
      r.ok ? r.data.tracks.flatMap((t) => t.clips.map((c) => c.label)) : [],
    );
  });
  expect(labels).toContain('agent-solid');

  // 一轮 = 一笔撤销
  await page.getByTestId('agent-undo-turn').click();
  await expect
    .poll(async () =>
      page.evaluate(() => {
        const C = (window as never as { __artmatic: { control: { getScene: (o: unknown) => Promise<{ ok: boolean; data: { tracks: { clips: { label: string }[] }[] } }> } } })
          .__artmatic.control;
        return C.getScene({ detail: 'ids' }).then((r) =>
          r.ok ? r.data.tracks.flatMap((t) => t.clips.map((c) => c.label)) : [],
        );
      }),
    )
    .not.toContain('agent-solid');
});

test('插件试挂：坏着色器回结构化 issue，好源码进注册表', async ({ page }) => {
  await openPanel(page);
  await configureKey(page);

  const badSource = `export const plugin = {
  format: 'artmatic-plugin', apiVersion: 1, id: 'e2e-bad', name: 'E2E bad',
  effects: [{ id: 'x', name: 'X', params: [],
    shader: { fragment: 'void main() { this is not glsl }', setUniforms() {} } }],
};`;

  const goodSource = `export const plugin = {
  format: 'artmatic-plugin', apiVersion: 1, id: 'e2e-good', name: 'E2E good',
  effects: [{ id: 'tint', name: 'Tint', params: [],
    shader: { fragment: 'void main() { outColor = texture(u_texture, vUv); }', setUniforms() {} } }],
};`;

  /*
   * 注意：工具循环只在**模型又给了 tool_calls** 时继续。中间那条「我改一版」
   * 如果单独成一轮（没有 tool_calls），整轮就结束了 —— 所以这里直接接着调
   * 第二次 plugin_try，最后才给一句收尾文本。
   */
  await stubLlm(page, [
    toolCall('p1', 'plugin_try', { id: 'e2e-bad', name: 'E2E bad', source: badSource }) + DONE,
    toolCall('p2', 'plugin_try', { id: 'e2e-good', name: 'E2E good', source: goodSource }) + DONE,
    textChunk('试挂成功。') + DONE,
  ]);

  await send(page, '写一个插件');

  /*
   * 试挂会在主世界执行源码，所以第一份源码先弹卡。
   * 勾上「本次会话允许试挂」后，第二轮 plugin_try 不再询问 ——
   * 如果这个开关没生效，下面的收尾文本会等不到（工具循环卡在第二张卡上）。
   */
  await expect(page.getByTestId('agent-approval')).toHaveAttribute('data-kind', 'try', {
    timeout: 30_000,
  });
  await page.getByTestId('agent-approval-allow').check();
  await page.getByTestId('agent-approval-install').click();

  await expect(page.getByTestId('agent-msg-assistant').last()).toContainText('试挂成功', { timeout: 30_000 });

  // 坏源码的 issue 里有 compile-failed；好源码进了能力清单
  const state = await page.evaluate(async () => {
    const C = (window as never as { __artmatic: { control: {
      getCapabilities: (o?: unknown) => Promise<{ ok: boolean; data: { effects: { id: string }[] } }>;
      pluginList: () => Promise<{ ok: boolean; data: { plugins: { id: string; status: string }[] } }>;
    } } }).__artmatic.control;
    const caps = await C.getCapabilities({ detail: 'ids' });
    const list = await C.pluginList();
    return {
      effects: caps.ok ? caps.data.effects.map((e) => e.id) : [],
      plugins: list.ok ? list.data.plugins.map((p) => ({ id: p.id, status: p.status })) : [],
    };
  });

  expect(state.effects).toContain('e2e-good/tint');
  const good = state.plugins.find((p) => p.id === 'e2e-good');
  expect(good?.status === 'ok' || good?.status === 'partial').toBe(true);

  // 工具卡用**显示名**（不是 id），data-tool 仍保留 id 供断言 / 排查
  const cards = page.getByTestId('agent-tool-card');
  await expect(cards.first()).toHaveAttribute('data-tool', 'plugin_try');
  await expect(cards.first()).toContainText('试挂插件');
  // 工具卡不能被 flex 压扁（历史 bug 的形态是高度趋近 0）
  const heights = await cards.evaluateAll((els) => els.map((e) => e.getBoundingClientRect().height));
  expect(Math.min(...heights)).toBeGreaterThan(20);
});

test('排版：加文字 + 图形 → 截图回传 → 布局 → 撤销本轮恢复原状', async ({ page }) => {
  await openPanel(page);
  await configureKey(page);

  const textClipId = await page.evaluate(async () => {
    const C = (window as never as { __artmatic: { control: {
      getScene: (o: unknown) => Promise<{ ok: boolean; data: { tracks: { clips: { id: string; kind: string; source?: { type: string } }[] }[] } }>;
    } } }).__artmatic.control;
    const r = await C.getScene({ detail: 'full' });
    if (!r.ok) return '';
    for (const t of r.data.tracks) {
      for (const c of t.clips) {
        if (c.kind === 'source' && c.source?.type === 'text') return c.id;
      }
    }
    return '';
  });
  expect(textClipId, 'demo 工程里应当有一段标题排版').not.toBe('');

  const before = await page.evaluate(async (clipId) => {
    const C = (window as never as { __artmatic: { control: {
      getTypographyDoc: (id: string, detail: string) => Promise<{ ok: boolean; data: { elements: unknown[] } }>;
    } } }).__artmatic.control;
    const r = await C.getTypographyDoc(clipId, 'ids');
    return r.ok ? r.data.elements.length : -1;
  }, textClipId);
  expect(before).toBeGreaterThan(0);

  await stubLlm(page, [
    toolCall('t1', 'typo_add_element', {
      clipId: textClipId,
      element: {
        kind: 'text',
        text: 'AGENT SUBTITLE',
        frame: { x: 160, y: 760, w: 1600, h: 120 },
        style: { fontSize: 56, align: 'center', color: '#ffffff' },
      },
    }) + DONE,
    toolCall('t2', 'typo_add_element', {
      clipId: textClipId,
      element: {
        kind: 'shape',
        shape: 'star',
        frame: { x: 120, y: 120, w: 160, h: 160 },
        fill: { kind: 'solid', color: '#ffcc00' },
      },
    }) + DONE,
    // 截图：模型「看」一眼
    toolCall('t3', 'render_frame', { t: 0.5, size: { w: 320, h: 180 } }) + DONE,
    toolCall('t4', 'typo_layout', { clipId: textClipId, op: 'grid', cols: 2, gap: 40, margin: 80 }) + DONE,
    textChunk('已加上副标题与星形并重新排布。') + DONE,
  ]);

  await send(page, '帮我排一版');
  await expect(page.getByTestId('agent-msg-assistant').last()).toContainText('星形', { timeout: 30_000 });
  await expect(page.getByTestId('agent-image')).toHaveCount(1);

  const after = await page.evaluate(async (clipId) => {
    const C = (window as never as { __artmatic: { control: {
      getTypographyDoc: (id: string, detail: string) => Promise<{ ok: boolean; data: { elements: { kind: string }[] } }>;
    } } }).__artmatic.control;
    const r = await C.getTypographyDoc(clipId, 'ids');
    return r.ok ? r.data.elements.length : -1;
  }, textClipId);
  expect(after).toBe(before + 2);

  await page.getByTestId('agent-undo-turn').click();
  await expect
    .poll(async () =>
      page.evaluate(async (clipId) => {
        const C = (window as never as { __artmatic: { control: {
          getTypographyDoc: (id: string, detail: string) => Promise<{ ok: boolean; data: { elements: unknown[] } }>;
        } } }).__artmatic.control;
        const r = await C.getTypographyDoc(clipId, 'ids');
        return r.ok ? r.data.elements.length : -1;
      }, textClipId),
    )
    .toBe(before);
});

test('排版页里也能开 Agent 抽屉，且与媒体池互斥（左列只有一个位置）', async ({ page }) => {
  await openPanel(page);

  const clipId = await page.evaluate(async () => {
    const C = (window as never as { __artmatic: { control: {
      getScene: (o: unknown) => Promise<{ ok: boolean; data: { tracks: { clips: { id: string; kind: string; source?: { type: string } }[] }[] } }>;
    } } }).__artmatic.control;
    const r = await C.getScene({ detail: 'full' });
    if (!r.ok) return '';
    for (const t of r.data.tracks) {
      for (const c of t.clips) if (c.source?.type === 'text') return c.id;
    }
    return '';
  });
  expect(clipId).not.toBe('');

  await page.evaluate((id) => {
    const A = (window as never as { __artmatic: { appState: { openTypographyTab: (c: string) => void } } }).__artmatic;
    A.appState.openTypographyTab(id);
  }, clipId);
  await expect(page.getByTestId('typo-editor')).toBeVisible();

  // 主界面那份被 display:none 卸载，排版页这份在 DOM 里 —— 只允许有一个实例。
  await expect(page.getByTestId('agent-drawer')).toHaveCount(1);
  await expect(page.getByTestId('agent-drawer')).toBeVisible();

  // 打开媒体池 → Agent 收起（同一个左列）。
  await page.getByTestId('rail-media').click();
  await expect(page.getByTestId('agent-drawer')).toHaveCount(0);
  await expect(page.getByTestId('media-drawer')).toBeVisible();
});

test('插件安装需要确认：未确认时出审批卡，拒绝后不写盘', async ({ page }) => {
  await openPanel(page);
  await configureKey(page);

  const source = `export const plugin = {
  format: 'artmatic-plugin', apiVersion: 1, id: 'e2e-approve', name: 'E2E approve',
  effects: [{ id: 'tint', name: 'Tint', params: [],
    shader: { fragment: 'void main() { outColor = texture(u_texture, vUv); }', setUniforms() {} } }],
};`;

  await stubLlm(page, [
    toolCall('a1', 'plugin_try', { id: 'e2e-approve', name: 'E2E approve', source }) + DONE,
    toolCall('a2', 'plugin_install', { pluginId: 'e2e-approve' }) + DONE,
    textChunk('等你确认安装。') + DONE,
  ]);

  await send(page, '装一个插件');

  // 先过试挂那道卡（它会执行源码）
  await expect(page.getByTestId('agent-approval')).toHaveAttribute('data-kind', 'try', {
    timeout: 30_000,
  });
  await page.getByTestId('agent-approval-install').click();

  // 再是安装的卡：拒绝 → 不写盘
  await expect(page.getByTestId('agent-approval')).toHaveAttribute('data-kind', 'install');
  await page.getByTestId('agent-approval-reject').click();
  await expect(page.getByTestId('agent-approval')).toHaveCount(0);
  await expect(page.getByTestId('agent-msg-assistant').last()).toContainText('确认');

  const fileName = await page.evaluate(async () => {
    const C = (window as never as {
      __artmatic: {
        control: {
          pluginList: () => Promise<{
            ok: boolean;
            data: { plugins: { id: string; fileName: string | null }[] };
          }>;
        };
      };
    }).__artmatic.control;
    const r = await C.pluginList();
    return r.ok ? (r.data.plugins.find((p) => p.id === 'e2e-approve')?.fileName ?? null) : null;
  });
  expect(fileName, '拒绝安装之后磁盘上不该有文件').toBeNull();
});

test('插件试挂未确认时不执行源码，确认后才产生实例', async ({ page }) => {
  await openPanel(page);

  const source = `export const plugin = {
  format: 'artmatic-plugin', apiVersion: 1, id: 'e2e-try-approval', name: 'E2E try approval',
  effects: [{ id: 'tint', name: 'Tint', params: [],
    shader: { fragment: 'void main() { outColor = texture(u_texture, vUv); }', setUniforms() {} } }],
};`;

  const probe = await page.evaluate(async (src) => {
    const C = (window as never as {
      __artmatic: {
        control: {
          pluginTry: (i: Record<string, unknown>) => Promise<{
            ok: boolean;
            error?: { code: string };
            data?: { effects: string[] };
          }>;
          pluginList: () => Promise<{ ok: boolean; data: { plugins: { id: string }[] } }>;
          getCapabilities: (o: unknown) => Promise<{ ok: boolean; data: { effects: { id: string }[] } }>;
        };
      };
    }).__artmatic.control;

    const first = await C.pluginTry({ id: 'e2e-try-approval', name: 'E2E try approval', source: src });
    const afterFirst = await C.pluginList();
    const capsAfterFirst = await C.getCapabilities({ detail: 'ids' });
    const confirmed = await C.pluginTry({
      id: 'e2e-try-approval',
      name: 'E2E try approval',
      source: src,
      confirm: true,
    });
    return {
      first,
      plugins: afterFirst.ok ? afterFirst.data.plugins.map((p) => p.id) : [],
      effectsBefore: capsAfterFirst.ok ? capsAfterFirst.data.effects.map((e) => e.id) : [],
      confirmed,
    };
  }, source);

  // 未确认：明确要审批，而且**实例一个都没有**（源码没被执行）。
  expect(probe.first.ok).toBe(false);
  expect(probe.first.error?.code).toBe('needs-approval');
  expect(probe.plugins).not.toContain('e2e-try-approval');
  expect(probe.effectsBefore).not.toContain('e2e-try-approval/tint');

  // 确认后同一份源码进注册表。
  expect(probe.confirmed.ok).toBe(true);
  expect(probe.confirmed.data?.effects).toContain('e2e-try-approval/tint');
});

test('插件热重载：同一个 id 换源码必须重编，不许复用上一版 program', async ({ page }) => {
  await openPanel(page);

  const good = `export const plugin = {
  format: 'artmatic-plugin', apiVersion: 1, id: 'e2e-hot', name: 'E2E hot',
  effects: [{ id: 'tint', name: 'Tint', params: [],
    shader: { fragment: 'void main() { outColor = texture(u_texture, vUv); }', setUniforms() {} } }],
};`;
  /*
   * 清单合法、只有 fragment 编不过。命中旧 program 的话这里会返回 ok ——
   * 那正是「同一个 id 永远在跑第一版 shader」的症状（缓存按名字命中，
   * 名字只由 plugin id 决定）。
   */
  const bad = good.replace(
    'void main() { outColor = texture(u_texture, vUv); }',
    'void main() { outColor = ; }',
  );

  const probe = await page.evaluate(async (srcs) => {
    const C = (window as never as {
      __artmatic: {
        control: {
          pluginTry: (i: Record<string, unknown>) => Promise<{
            ok: boolean;
            data?: {
              ok: boolean;
              status: string;
              effects: string[];
              verified: boolean;
              issues: { code: string }[];
            };
          }>;
          pluginDiscard: (id: string) => Promise<{ ok: boolean }>;
        };
      };
    }).__artmatic.control;

    const first = await C.pluginTry({ id: 'e2e-hot', name: 'E2E hot', source: srcs.good, confirm: true });
    const edited = await C.pluginTry({ id: 'e2e-hot', name: 'E2E hot', source: srcs.bad, confirm: true });
    // 丢弃之后连记录都没了，只剩 Kit 里那份同名的旧 program。
    await C.pluginDiscard('e2e-hot');
    const afterDiscard = await C.pluginTry({ id: 'e2e-hot', name: 'E2E hot', source: srcs.bad, confirm: true });
    return { first, edited, afterDiscard };
  }, { good, bad });

  expect(probe.first.data?.verified, '这条用例要真 GL 编译，预览必须已装配').toBe(true);
  expect(probe.first.data?.ok, '第一版应当编过').toBe(true);
  expect(probe.first.data?.effects).toEqual(['e2e-hot/tint']);

  // 同一 id、同一份清单，只改了 fragment：必须真的重编，而不是回旧 program 报 ok。
  expect(probe.edited.data?.ok, '同 id 的新源码必须重编').toBe(false);
  expect(probe.edited.data?.status).toBe('failed');
  expect(probe.edited.data?.effects).toEqual([]);
  expect(probe.edited.data?.issues.some((i) => i.code === 'compile-failed')).toBe(true);

  expect(probe.afterDiscard.data?.ok, '丢弃之后重来也必须重编').toBe(false);
  expect(probe.afterDiscard.data?.status).toBe('failed');
});

test('插件编辑闭环：分页读 → grep → 唯一替换 → 静态检查 → 试挂用草稿', async ({ page }) => {
  await openPanel(page);

  // 常量是**字符串**：拼进 GLSL 后是 `* 1.0`（`* 1` 会因为 vec4 * int 编不过）。
  const source = `const GAIN = '1.0';
// marker: alpha
// marker: beta
export const plugin = {
  format: 'artmatic-plugin', apiVersion: 1, id: 'e2e-edit', name: 'E2E edit',
  effects: [{ id: 'tint', name: 'Tint', params: [],
    shader: { fragment: 'void main() { outColor = texture(u_texture, vUv) * ' + GAIN + '; }', setUniforms() {} } }],
};
`;

  const probe = await page.evaluate(async (src) => {
    type R<T> = Promise<{
      ok: boolean;
      data?: T;
      error?: { code: string; detail?: { lines?: number[] } };
    }>;
    const C = (
      window as never as {
        __artmatic: {
          control: {
            pluginTry(input: Record<string, unknown>): R<{ ok: boolean; status: string }>;
            pluginView(input: Record<string, unknown>): R<{
              origin: string;
              from: number;
              to: number;
              total: number;
              hasMore: boolean;
              text: string;
            }>;
            pluginGrep(input: Record<string, unknown>): R<{
              total: number;
              matches: { line: number; text: string }[];
            }>;
            pluginEdit(input: Record<string, unknown>): R<{ line: number; origin: string }>;
            pluginCheck(pluginId: string): R<{ ok: boolean; issues: unknown[]; exports: string[] }>;
            pluginDiscard(pluginId: string): R<unknown>;
          };
        };
      }
    ).__artmatic.control;

    const first = await C.pluginTry({ id: 'e2e-edit', name: 'E2E edit', source: src, confirm: true });
    const head = await C.pluginView({ pluginId: 'e2e-edit', offset: 1, limit: 2 });
    const found = await C.pluginGrep({ pluginId: 'e2e-edit', pattern: '// marker:' });
    const ambiguous = await C.pluginEdit({
      pluginId: 'e2e-edit',
      oldString: '// marker:',
      newString: '// gone',
    });
    const edited = await C.pluginEdit({
      pluginId: 'e2e-edit',
      oldString: "const GAIN = '1.0';",
      newString: "const GAIN = '2.0';",
    });
    const again = await C.pluginEdit({
      pluginId: 'e2e-edit',
      oldString: "const GAIN = '1.0';",
      newString: "const GAIN = '3.0';",
    });
    const checked = await C.pluginCheck('e2e-edit');
    // 不传 source：用刚才 edit 过的草稿（而不是第一次 try 的那份）。
    const applied = await C.pluginTry({ id: 'e2e-edit', name: 'E2E edit', confirm: true });
    const after = await C.pluginGrep({ pluginId: 'e2e-edit', pattern: 'GAIN = ' });
    // 这个插件没装到磁盘：丢弃草稿之后就什么都读不到了。
    await C.pluginDiscard('e2e-edit');
    const gone = await C.pluginView({ pluginId: 'e2e-edit', offset: 1, limit: 5 });
    return { first, head, found, ambiguous, edited, again, checked, applied, after, gone };
  }, source);

  expect(probe.first.data?.ok, '第一版应当编过').toBe(true);

  // 分页：带行号，并且明确告诉模型还有多少行、下一句怎么翻。
  expect(probe.head.data).toMatchObject({ origin: 'draft', from: 1, to: 2, hasMore: true });
  expect(probe.head.data?.text).toContain("  1 | const GAIN = '1.0';");
  expect(probe.head.data?.text).toContain('more lines; continue with offset=3');

  // grep：1-based 行号，两条 marker 都找到。
  expect(probe.found.data?.total).toBe(2);
  expect(probe.found.data?.matches.map((m) => m.line)).toEqual([2, 3]);

  // 命中多处必须失败（否则就是「改对了语法、改错了地方」）。
  expect(probe.ambiguous.ok).toBe(false);
  expect(probe.ambiguous.error?.code).toBe('invalid-argument');
  expect(probe.ambiguous.error?.detail?.lines).toEqual([2, 3]);

  // 唯一命中：只改草稿，并回报行号。
  expect(probe.edited.ok).toBe(true);
  expect(probe.edited.data?.line).toBe(1);
  expect(probe.edited.data?.origin).toBe('draft');

  // 同一处再改一次：原文已经不在。
  expect(probe.again.ok).toBe(false);
  expect(probe.again.error?.code).toBe('not-found');

  // 静态检查：语法通过、导出看得见。
  expect(probe.checked.ok).toBe(true);
  expect(probe.checked.data?.ok).toBe(true);
  expect(probe.checked.data?.exports).toContain('plugin');

  // 省略 source 的试挂用的是草稿（2.0），不是第一次那份（1.0）。
  expect(probe.applied.data?.ok).toBe(true);
  expect(probe.after.data?.matches[0]?.text).toContain('2.0');

  expect(probe.gone.ok).toBe(false);
  expect(probe.gone.error?.code).toBe('not-found');
});

test('右键片段「添加进上下文」：胶囊进输入框，消息里带 id 与界面快照（系统提示保持常量）', async ({ page }) => {
  const llm = await stubLlm(page, [textChunk('收到。') + DONE]);

  await page.goto('/');
  await page.waitForFunction(
    () => Boolean((window as never as { __artmatic?: { control?: unknown } }).__artmatic?.control),
  );
  await openDemo(page);

  const clip = await page.evaluate(() => {
    const p = (
      window as never as {
        __artmatic: { store: { project: { tracks: { kind: string; clips: { id: string; label: string }[] }[] } } };
      }
    ).__artmatic.store.project;
    for (const tk of p.tracks) {
      if (tk.kind === 'visual' && tk.clips.length) return { id: tk.clips[0]!.id, label: tk.clips[0]!.label };
    }
    return null;
  });
  expect(clip).not.toBeNull();

  await page.locator(`[data-clip-id="${clip!.id}"]`).click({ button: 'right' });
  await page.getByTestId('ctx-add-context').click();

  // 抽屉自动打开；胶囊显示的是**名字**（id 在提示词里，界面上不需要），焦点已交给输入框。
  await expect(page.getByTestId('agent-drawer')).toBeVisible();
  const pill = page.getByTestId('agent-context-ref');
  await expect(pill).toHaveCount(1);
  await expect(pill).toContainText(clip!.label);
  await expect(page.getByTestId('agent-input')).toBeFocused();

  await configureKey(page);
  await send(page, '改一下这个片段');
  await expect.poll(() => llm.calls()).toBeGreaterThan(0);

  const messages = llm.bodies()[0]!.messages as { role: string; content: unknown }[];
  /*
   * 系统提示是**纯常量**（缓存纪律）：界面快照不在里面，否则每一轮都会把
   * 整段前缀缓存作废。动态语境只能贴在 user 消息尾部。
   */
  const system = JSON.stringify(messages[0]);
  expect(system).not.toContain('Where the user is right now');

  // user 消息：界面快照 + 标注块（标注里必须有可直接拿去调工具的 id）。
  const user = JSON.stringify(messages.filter((m) => m.role === 'user').pop());
  expect(user).toContain('Where the user is right now');
  expect(user).toContain('Playhead:');
  expect(user).toContain('View: the timeline');
  expect(user).toContain('用户标注的片段');
  expect(user).toContain(`id: ${clip!.id}`);
  expect(user).toContain('改一下这个片段');

  // 发送后清空：它已经进了那条消息，留着会让下一条莫名其妙又带上它。
  await expect(page.getByTestId('agent-context-ref')).toHaveCount(0);
});

test('排版元素右键「添加进上下文」：按所属片段分组，界面快照写明在排版页', async ({ page }) => {
  const llm = await stubLlm(page, [textChunk('收到。') + DONE]);

  await page.goto('/');
  await page.waitForFunction(
    () => Boolean((window as never as { __artmatic?: { control?: unknown } }).__artmatic?.control),
  );
  await openDemo(page);

  const clipId = await page.evaluate(async () => {
    const A = (
      window as never as {
        __artmatic: {
          control: { getScene: (o?: unknown) => Promise<{ ok: boolean; data: { tracks: { clips: { id: string; source?: { type: string } }[] }[] } }> };
          appState: { openTypographyTab: (c: string) => void };
        };
      }
    ).__artmatic;
    // 用完整快照：`ids` 档的片段视图没有 `source`，判断不出哪一个是文本片段。
    const r = await A.control.getScene();
    for (const t of r.data.tracks) {
      for (const c of t.clips) {
        if (c.source?.type === 'text') {
          A.appState.openTypographyTab(c.id);
          return c.id;
        }
      }
    }
    return '';
  });
  expect(clipId).not.toBe('');

  const stage = page.getByTestId('typo-stage');
  await expect(stage).toBeVisible();
  const el = page.locator('.paper [data-el-id]').first();
  await expect(el).toBeVisible();
  const elementId = (await el.getAttribute('data-el-id'))!;
  const box = (await el.boundingBox())!;

  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2, { button: 'right' });
  await page.getByTestId('typo-ctx-add-context').click();

  const pill = page.getByTestId('agent-context-ref');
  await expect(pill).toHaveCount(1);
  await expect(pill).toHaveAttribute('data-kind', 'element');

  await configureKey(page);
  await send(page, '把这个元素放大');
  await expect.poll(() => llm.calls()).toBeGreaterThan(0);

  const messages = llm.bodies()[0]!.messages as { role: string; content: unknown }[];
  // 视图信息在 user 消息里（系统提示是常量，见上一条用例的注释）。
  expect(JSON.stringify(messages[0])).not.toContain('View:');
  const user = JSON.stringify(messages.filter((m) => m.role === 'user').pop());
  expect(user).toContain('View: the typography editor');
  expect(user).toContain('用户标注的排版元素');
  expect(user).toContain(`位于片段`);
  expect(user).toContain(clipId);
  expect(user).toContain(`id: ${elementId}`);
});

/* ------------------------------------------------ 前缀缓存与插话（2026-10-24） */

/** DeepSeek 口径的 usage：命中 / 未命中分开报。 */
function usageCache(hit: number, miss: number): string {
  return `data: ${JSON.stringify({
    choices: [],
    usage: {
      prompt_tokens: hit + miss,
      completion_tokens: 5,
      prompt_cache_hit_tokens: hit,
      prompt_cache_miss_tokens: miss,
    },
  })}\n\n`;
}

test('前缀缓存：第二轮是上一轮的严格前缀，界面快照只在 user 消息里，命中率按轮显示', async ({ page }) => {
  const llm = await stubLlm(page, [
    textChunk('第一轮。') + usageCache(0, 1_000) + DONE,
    textChunk('第二轮。') + usageCache(900, 100) + DONE,
  ]);
  await openPanel(page);
  await configureKey(page);

  await send(page, '第一句');
  await expect(page.getByTestId('agent-msg-assistant')).toContainText('第一轮', { timeout: 20_000 });
  // 有字段但命中 0：这是「第一次请求必然全 miss」，要显示 0%，而不是不显示
  await expect(page.getByTestId('agent-cache')).toHaveAttribute('data-pct', '0');

  await send(page, '第二句');
  await expect(page.getByTestId('agent-msg-assistant').last()).toContainText('第二轮', {
    timeout: 20_000,
  });
  await expect(page.getByTestId('agent-cache')).toHaveAttribute('data-pct', '90');

  const bodies = llm.bodies();
  expect(bodies).toHaveLength(2);
  const firstMsgs = bodies[0]!.messages as unknown[];
  const secondMsgs = bodies[1]!.messages as unknown[];
  /*
   * 严格前缀。这条是整份 spec 里最重要的断言：前缀一旦被改写（例如把播放头
   * 拼进系统提示），DeepSeek / 智谱 / Kimi / 阿里 / Anthropic 的缓存**整段失效**，
   * 而回执上完全看不出来 —— 只有账单会变。
   */
  expect(secondMsgs.slice(0, firstMsgs.length)).toEqual(firstMsgs);
  expect(secondMsgs[0]).toEqual(firstMsgs[0]);

  // 动态语境必须在最后一条 user 消息里，**不能**进系统提示
  expect(JSON.stringify(firstMsgs[0])).not.toContain('Where the user is right now');
  expect(JSON.stringify(firstMsgs[firstMsgs.length - 1])).toContain('Where the user is right now');
});

test('插话：运行期间可发送，卡片可编辑/撤销，内容在下一次调用前注入', async ({ page }) => {
  const llm = await stubLlm(page, [
    toolCall('q1', 'ask_user', { question: '继续吗？', options: ['继续'] }) + DONE,
    textChunk('收到插话。') + DONE,
  ]);
  await openPanel(page);
  await configureKey(page);

  await send(page, '先问我一句');
  await expect(page.getByTestId('agent-ask')).toBeVisible({ timeout: 20_000 });

  const INTERJECT = '顺便把标题改成红的';

  // 运行期间发送 = 插话：不报错、不进对话，先挂在输入框上方
  await page.getByTestId('agent-input').fill(INTERJECT);
  await page.getByTestId('agent-send').click();
  await expect(page.getByTestId('agent-queued-item')).toHaveCount(1);
  await expect(page.getByTestId('agent-queued-item')).toContainText(INTERJECT);

  // 编辑：回到输入框，卡片撤下
  await page.getByTestId('agent-queued-edit').click();
  await expect(page.getByTestId('agent-queued-item')).toHaveCount(0);
  await expect(page.getByTestId('agent-input')).toHaveValue(INTERJECT);

  // 撤销：排队里的直接丢掉
  await page.getByTestId('agent-send').click();
  await expect(page.getByTestId('agent-queued-item')).toHaveCount(1);
  await page.getByTestId('agent-queued-cancel').click();
  await expect(page.getByTestId('agent-queued-item')).toHaveCount(0);

  // 再插一次，这回让它送到模型
  await page.getByTestId('agent-input').fill(INTERJECT);
  await page.getByTestId('agent-send').click();
  await expect(page.getByTestId('agent-queued-item')).toHaveCount(1);

  // 回答问答卡 → 本轮继续 → 插话在**下一次请求**里
  await page.getByTestId('agent-ask-option').first().click();
  await expect(page.getByTestId('agent-msg-assistant').last()).toContainText('收到插话', {
    timeout: 20_000,
  });

  const injected = JSON.stringify(llm.bodies()[1]!.messages);
  expect(injected).toContain(INTERJECT);
  expect(injected).toContain('interjection');

  // 送达后卡片撤下，消息流里出现一条用户气泡
  await expect(page.getByTestId('agent-queued-item')).toHaveCount(0);
  await expect(page.getByTestId('agent-msg-user').last()).toContainText(INTERJECT);
});
