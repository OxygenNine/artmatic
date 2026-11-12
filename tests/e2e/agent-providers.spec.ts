/**
 * agent-providers.spec.ts — 换一家之后**真的换了协议**。
 *
 * 单测已经钉住了序列化与归约（`agent-protocol.test.ts`）。这里只验三件
 * 单测看不到的事：
 *
 *  1. 面板切到 Anthropic 之后，请求打的是 `/v1/messages`、带 `x-api-key` 与
 *     `anthropic-version`、`system` 在顶层 —— 以及**没有**任何请求漏去
 *     `/chat/completions`（`syncConfig` 漏写 providerId 就是这个形状）。
 *  2. 用工具的第二轮请求里，`thinking` 块带着上一轮的 `signature` 回来了。
 *     丢了它第一轮完全正常，**第二轮才 400**，是最难靠肉眼发现的一种。
 *  3. 代理只认注册表里的 provider，别的路径一律 404。
 */

import { expect, test, type Page, type Route } from '@playwright/test';
import { PROVIDERS } from '../../src/agent/llm/providers/registry';
import { openDemo } from './_stage';

const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-headers': '*',
  'access-control-allow-methods': 'POST, OPTIONS',
};

function sse(events: unknown[]): string {
  return events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join('');
}

/** 第一轮：先思考、再调 `get_scene`。 */
const TURN_WITH_TOOL = sse([
  { type: 'message_start', message: { usage: { input_tokens: 12 } } },
  { type: 'content_block_start', index: 0, content_block: { type: 'thinking' } },
  { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: '先看场景' } },
  { type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature: 'SIG-ABC' } },
  { type: 'content_block_stop', index: 0 },
  { type: 'content_block_start', index: 1, content_block: { type: 'tool_use', id: 'tu_1', name: 'get_scene' } },
  { type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '{}' } },
  { type: 'content_block_stop', index: 1 },
  { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 8 } },
  { type: 'message_stop' },
]);

/** 第二轮：给一句话收尾。 */
const TURN_TEXT = sse([
  { type: 'message_start', message: { usage: { input_tokens: 40 } } },
  { type: 'content_block_start', index: 0, content_block: { type: 'text' } },
  { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: '场景看过了。' } },
  { type: 'content_block_stop', index: 0 },
  { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 4 } },
  { type: 'message_stop' },
]);

interface Captured {
  body: Record<string, unknown>;
  headers: Record<string, string>;
}

async function stubAnthropic(page: Page, responses: string[]): Promise<Captured[]> {
  const captured: Captured[] = [];
  await page.route('**/v1/messages', async (route: Route) => {
    if (route.request().method() === 'OPTIONS') {
      await route.fulfill({ status: 204, headers: CORS, body: '' });
      return;
    }
    captured.push({
      body: JSON.parse(route.request().postData() ?? '{}') as Record<string, unknown>,
      headers: route.request().headers(),
    });
    const i = Math.min(captured.length - 1, responses.length - 1);
    await route.fulfill({
      status: 200,
      headers: { ...CORS, 'content-type': 'text/event-stream', 'cache-control': 'no-store' },
      body: responses[i]!,
    });
  });
  return captured;
}

/** OpenAI 兼容端点的请求计数（用来证明「没有漏过去」）。 */
async function countOpenAiCalls(page: Page): Promise<() => number> {
  let n = 0;
  await page.route('**/chat/completions', async (route: Route) => {
    if (route.request().method() === 'OPTIONS') {
      await route.fulfill({ status: 204, headers: CORS, body: '' });
      return;
    }
    n += 1;
    await route.fulfill({ status: 500, headers: CORS, body: 'should not be hit' });
  });
  return () => n;
}

async function openPanel(page: Page): Promise<void> {
  await page.goto('/');
  await page.waitForFunction(
    () => Boolean((window as never as { __artmatic?: { control?: unknown } }).__artmatic?.control),
  );
  await openDemo(page);
  await page.getByTestId('rail-agent').click();
  await expect(page.getByTestId('agent-drawer')).toBeVisible();
}

/** 在设置里切到某一家并填 key。 */
async function useProvider(page: Page, id: string, key: string): Promise<void> {
  await page.getByTestId('agent-settings').click();
  const modal = page.getByTestId('agent-settings-modal');
  await expect(modal).toBeVisible();
  await page.getByTestId(`agent-provider-${id}`).click();
  const input = page.getByTestId('agent-key');
  await input.fill(key);
  await input.press('Tab');
  await page.getByTestId('agent-settings-done').click();
  await expect(modal).toHaveCount(0);
}

test('切到 Anthropic：走 /v1/messages、带齐鉴权头、system 在顶层', async ({ page }) => {
  const openaiCalls = await countOpenAiCalls(page);
  const captured = await stubAnthropic(page, [TURN_WITH_TOOL, TURN_TEXT]);

  await openPanel(page);
  await useProvider(page, 'anthropic', 'sk-ant-test');

  const input = page.getByTestId('agent-input');
  await input.fill('看一下场景');
  await page.getByTestId('agent-send').click();

  await expect(page.getByTestId('agent-tool-card').first()).toBeVisible({ timeout: 15_000 });
  await expect.poll(() => captured.length, { timeout: 15_000 }).toBeGreaterThanOrEqual(2);

  const first = captured[0]!;
  // 鉴权头是 Anthropic 专属的；浏览器直连还需要那一条 dangerous 头。
  expect(first.headers['x-api-key']).toBe('sk-ant-test');
  expect(first.headers['anthropic-version']).toBe('2023-06-01');
  expect(first.headers['anthropic-dangerous-direct-browser-access']).toBe('true');
  expect(first.headers.authorization).toBeUndefined();

  // system 是顶层参数，不是一条消息
  expect(typeof first.body.system).toBe('string');
  expect((first.body.system as string).length).toBeGreaterThan(20);
  const firstMessages = first.body.messages as { role: string }[];
  expect(firstMessages.some((m) => m.role === 'system')).toBe(false);

  // 工具用 Anthropic 的 input_schema，不是 OpenAI 的 function.parameters
  const tools = first.body.tools as { name: string; input_schema: unknown; function?: unknown }[];
  expect(tools.length).toBeGreaterThan(10);
  expect(tools[0]!.input_schema).toBeTruthy();
  expect(tools[0]!.function).toBeUndefined();
  expect(JSON.stringify(tools)).not.toMatch(/"type":\[/);

  // 输出上限必须大于思考预算（否则服务端 400，错误体是 budget_tokens）
  const thinking = first.body.thinking as { budget_tokens: number } | undefined;
  if (thinking) expect(first.body.max_tokens as number).toBeGreaterThan(thinking.budget_tokens);

  // 一个请求都不许漏去 OpenAI 兼容端点
  expect(openaiCalls()).toBe(0);
});

test('用工具的第二轮把 thinking 块连 signature 一起带回去', async ({ page }) => {
  const captured = await stubAnthropic(page, [TURN_WITH_TOOL, TURN_TEXT]);

  await openPanel(page);
  await useProvider(page, 'anthropic', 'sk-ant-test');

  await page.getByTestId('agent-input').fill('看一下场景');
  await page.getByTestId('agent-send').click();
  await expect.poll(() => captured.length, { timeout: 15_000 }).toBeGreaterThanOrEqual(2);

  const messages = captured[1]!.body.messages as { role: string; content: { type: string; signature?: string; tool_use_id?: string }[] }[];
  const assistant = messages.find((m) => m.role === 'assistant');
  expect(assistant, '第二轮里必须有上一轮的 assistant 回合').toBeTruthy();

  // thinking 块必须原样（含 signature）排在 tool_use 之前
  expect(assistant!.content[0]).toEqual({
    type: 'thinking',
    thinking: '先看场景',
    signature: 'SIG-ABC',
  });
  const useIndex = assistant!.content.findIndex((b) => b.type === 'tool_use');
  expect(useIndex).toBeGreaterThan(0);

  // tool 结果折进 user 消息，且排在 content 最前
  const last = messages[messages.length - 1]!;
  expect(last.role).toBe('user');
  expect(last.content[0]).toMatchObject({ type: 'tool_result', tool_use_id: 'tu_1' });
});

test('每家都真的画出了品牌图（资源 404 / 蒙版丢失都是静默失效）', async ({ page }) => {
  await openPanel(page);
  await page.getByTestId('agent-settings').click();
  await page.getByTestId('agent-settings-modal').waitFor();

  /*
   * 三种渲染路径都要验：`<img>` 看 `naturalWidth`（404 时是 0，且不报错），
   * 蒙版看 `mask-image` 算出来是不是 none（写成无效值时浏览器直接忽略该声明）。
   * 「自定义」没有品牌图，回落到首字母方块（它同样有 `agent-logo-` 的 testid，
   * 但既不是 `<img>` 也不是蒙版，所以不会被判成坏的）。
   */
  // 只查列表里的：抽屉的 chip 与菜单里也有同一个组件。
  const list = page.getByTestId('agent-provider-list');
  const broken = await list.locator('[data-testid^="agent-logo-"]').evaluateAll((nodes) =>
    nodes
      .filter((node) => {
        if (node instanceof HTMLImageElement) return !(node.complete && node.naturalWidth > 0);
        if (node.classList.contains('plogo-mask')) {
          const style = getComputedStyle(node);
          const mask = style.maskImage || style.webkitMaskImage;
          return !mask || mask === 'none';
        }
        return false;
      })
      .map((node) => node.getAttribute('data-testid') ?? '?'),
  );
  expect(broken).toEqual([]);
  // 注册表里每家（含自定义）都要有一个图标节点
  await expect(list.locator('[data-testid^="agent-logo-"]')).toHaveCount(PROVIDERS.length);
});

test('代理只认注册表里的 provider', async ({ page }) => {
  await page.goto('/');
  const base = page.url().replace(/\/[^/]*$/, '');

  const unknown = await page.request.post(`${base}/__llm/nope/chat/completions`, { data: {} });
  expect(unknown.status()).toBe(404);

  // 自定义服务商不进白名单：拿它当反代用必须 404。
  const custom = await page.request.post(`${base}/__llm/custom/chat/completions`, { data: {} });
  expect(custom.status()).toBe(404);

  // 只放行 POST 与 GET（余额是 GET）。PUT 这类写方法仍然挡在门外。
  const wrongMethod = await page.request.put(`${base}/__llm/deepseek/chat/completions`, { data: {} });
  expect(wrongMethod.status()).toBe(405);

  /*
   * GET 必须被**路由**（不是 405）：`/user/balance` 是只读查询，挡掉它余额就永远
   * 显示不出来，而且只在被 CORS 拦的主机上出问题。E2E 里上游不可达，
   * 所以这里只断言「没有在方法这一层被拒」。
   */
  const balance = await page.request.get(`${base}/__llm/deepseek/user/balance`);
  expect(balance.status()).not.toBe(405);
});
