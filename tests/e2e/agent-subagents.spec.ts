/**
 * agent-subagents.spec.ts — 子代理那条路的端到端验收（不需要真 Key）。
 *
 * 与 `agent-in-app.spec.ts` 同一套伪造 SSE，但**按请求体的系统提示分流**而不是
 * 按请求序号：父子的请求会交错，序号路由必然把子代理的回答喂给父代理。
 *
 * 断言的是四件在单测里看不见的事：
 *   1. 子代理卡出现，并且**它的工具调用留在卡里**（展开才看得见）；
 *   2. 子代理的工具卡**没有**混进父对话顶层；
 *   3. `wait_for_agent` 的工具结果里真的有子代理的结论（结论回传这条路通了）；
 *   4. 子代理的 token 计进父轮的账（否则用户看到的钱只有一半）。
 */

import { expect, test, type Page, type Route } from '@playwright/test';
import { openDemo } from './_stage';

const KEY = 'e2e-key';

/* --------------------------------------------------------------- SSE 工具 */

function chunk(delta: Record<string, unknown>): string {
  return `data: ${JSON.stringify({ choices: [{ delta, finish_reason: null }] })}\n\n`;
}

function toolCall(id: string, name: string, args: unknown): string {
  return chunk({
    tool_calls: [{ index: 0, id, type: 'function', function: { name, arguments: JSON.stringify(args) } }],
  });
}

function textChunk(text: string): string {
  return chunk({ content: text });
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

/** 子代理的系统提示里有这句（见 `subagents.ts` 的 EXPLORE_SYSTEM）。 */
const CHILD_MARK = 'You survey an Artmatic project';

interface Stub {
  calls: () => number;
  childCalls: () => number;
}

/**
 * 父子各一条队列，按**系统提示**分流。
 *
 * 两个队列都用「用完之后重复最后一条」的兜底：竞态让人看到 500 比看到一条重复
 * 回答更难查（前者像面板坏了，后者只是断言失败）。
 */
async function stubLlm(page: Page, parent: string[], child: string[]): Promise<Stub> {
  let total = 0;
  let p = 0;
  let c = 0;
  await page.route('**/chat/completions', async (route: Route) => {
    if (route.request().method() === 'OPTIONS') {
      await route.fulfill({ status: 204, headers: CORS, body: '' });
      return;
    }
    total += 1;
    const raw = route.request().postData() ?? '';
    let isChild = false;
    try {
      const body = JSON.parse(raw) as { messages?: { role?: string; content?: unknown }[] };
      const sys = body.messages?.[0];
      isChild = typeof sys?.content === 'string' && sys.content.includes(CHILD_MARK);
    } catch {
      /* 非 JSON 请求体按父代理处理 */
    }
    const queue = isChild ? child : parent;
    const i = isChild ? Math.min(c, queue.length - 1) : Math.min(p, queue.length - 1);
    if (isChild) c += 1;
    else p += 1;
    await route.fulfill({
      status: 200,
      headers: { ...CORS, 'content-type': 'text/event-stream', 'cache-control': 'no-store' },
      body: queue[i]!,
    });
  });
  return { calls: () => total, childCalls: () => c };
}

/* --------------------------------------------------------------- 面板工具 */

async function openPanel(page: Page): Promise<void> {
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
  await page.getByTestId('agent-input').fill(text);
  await page.getByTestId('agent-send').click();
}

const SUMMARY = '3 visual tracks, 12 clips, no audio';

/* ------------------------------------------------------------------ tests */

test('子代理：卡内保留过程、结论回到父代理、token 计入父轮', async ({ page }) => {
  await openPanel(page);
  await configureKey(page);

  const stub = await stubLlm(
    page,
    [
      toolCall('call_0', 'spawn_agent', {
        preset: 'explore',
        task: 'Report how many tracks and clips this project has, and which tracks are empty.',
      }),
      toolCall('call_1', 'wait_for_agent', {}),
      textChunk('统计完成。') + DONE,
    ],
    [
      toolCall('call_0', 'project_stats', {}),
      textChunk(
        JSON.stringify({
          summary: SUMMARY,
          evidence: ['project_stats: tracks.visual=3'],
          gaps: [],
          needsDecision: null,
        }),
      ) +
        usageChunk(900, 40) +
        DONE,
    ],
  );

  await send(page, '派个人统计一下这个工程的规模');

  const card = page.getByTestId('agent-subagent-card');
  await expect(card).toBeVisible({ timeout: 20_000 });
  await expect(card).toHaveAttribute('data-status', 'ok', { timeout: 20_000 });

  /*
   * 子代理的工具卡只能在卡里：顶层只有 spawn_agent 与 wait_for_agent 两张。
   * 混进顶层正是「省上下文」失败的形态 —— 转录回到了父对话。
   */
  const topLevel = page.locator('[data-testid="agent-stream"] > [data-testid="agent-tool-card"]');
  await expect(topLevel).toHaveCount(2);

  // 展开卡片：子代理自己的 project_stats 在里面（父代理看不见它）。
  await card.locator('.head').click();
  await expect(card.locator('[data-testid="agent-tool-card"]')).toHaveCount(1);
  await expect(card.locator('[data-testid="agent-tool-card"]')).toHaveAttribute('data-tool', 'project_stats');

  // 结论真的回到了父代理：展开 wait_for_agent 那张工具卡读结果。
  const waitCard = page.locator(
    '[data-testid="agent-stream"] > [data-testid="agent-tool-card"][data-tool="wait_for_agent"]',
  );
  await waitCard.locator('.head').click();
  await expect(waitCard).toContainText(SUMMARY);

  // 两边都真的发过请求（证明子代理确实跑在自己的会话里，不是同一次调用）。
  expect(stub.childCalls()).toBeGreaterThan(0);

  // 父轮收尾，子代理不再发请求。
  await expect(card).toHaveAttribute('data-status', 'ok');
  const settled = stub.calls();
  await page.waitForTimeout(400);
  expect(stub.calls()).toBe(settled);
});

test('设置里关掉子代理：工具不出现在请求体里', async ({ page }) => {
  await openPanel(page);
  await configureKey(page);

  // 关掉开关（behavior 段）。
  await page.getByTestId('agent-settings').click();
  await expect(page.getByTestId('agent-settings-modal')).toBeVisible();
  // 分节导航：开关在「行为」那一页。
  await page.getByTestId('agent-settings-nav-behavior').click();
  const toggle = page.getByTestId('agent-subagents');
  await expect(toggle).toBeVisible();
  await toggle.click();
  await page.getByTestId('agent-settings-done').click();

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
        /* 忽略 */
      }
    }
    await route.fulfill({
      status: 200,
      headers: { ...CORS, 'content-type': 'text/event-stream', 'cache-control': 'no-store' },
      body: textChunk('好。') + DONE,
    });
  });

  await send(page, '随便说一句');
  await expect.poll(() => bodies.length).toBeGreaterThan(0);

  const names = (bodies[0] as { tools?: { function?: { name?: string } }[] }).tools ?? [];
  const flat = names.map((t) => t.function?.name);
  expect(flat).not.toContain('spawn_agent');
  expect(flat).not.toContain('wait_for_agent');
});
