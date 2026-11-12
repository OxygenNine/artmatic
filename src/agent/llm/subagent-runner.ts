/**
 * subagent-runner.ts — 子代理的**运行时**：起会话、盯墙钟、收结果。
 *
 * 子代理就是第二个 `AgentSession`（见 `subagents.ts` 文件头与 `session.ts` 的
 * `SessionOptions`）。这里只做四件事：装配、限额、把事件翻译成父会话看得懂的
 * 形状、把结果放进收件箱。
 *
 * ## 为什么不复用父会话的 `onEvent`
 *
 * 子代理的事件里有几类**必须挡掉**（`agent-state` 那边没有穷尽检查，透传不会
 * 报错，只会静默污染）：
 *
 *  · `user`      —— 委派消息会变成一条用户气泡；
 *  · `turn-end`  —— 会覆盖父轮的 writes / ms / 费用；
 *  · `context`   —— 会覆盖父的环形进度条；
 *  · `error`     —— 会弹一条顶级的「重试」错误。
 *
 * 所以 runner 转发时**重建**事件，只放行 tool / assistant / reasoning / image /
 * notice。token 走 `onUsage` 单独累加。
 */

import type { AgentControlPlane } from '../control-plane';
import type { LlmConfig, SessionEvent, ToolOutcome } from './types';
import { AgentSession } from './session';
import { createToolExecutor } from './executor';
import { contextLimitOf, supportsImages } from './providers/registry';
import {
  MAX_CONCURRENT_SUBAGENTS,
  SUMMARY_MAX_CHARS,
  SUBAGENT_CONTEXT_TOKENS,
  SUBAGENT_WALL_MS,
  claimDomains,
  domainsOverlap,
  isPreset,
  parseSubagentResult,
  presetDef,
  presetSystemPrompt,
  presetTools,
  presetWritable,
  type SpawnRequest,
  type SubagentHost,
  type SubagentResult,
  type WriteFence,
} from './subagents';

export interface SubagentRunnerOpts {
  control: AgentControlPlane;
  fence: WriteFence;
  /** 与父会话**同一个** config 对象（原地更新），所以取函数。 */
  config: () => LlmConfig;
  onEvent(e: SessionEvent): void;
  /** 父会话的「截图回传」偏好。关掉时子代理也看不到画面。 */
  screenshots?: () => boolean;
  /** 设置里的总开关。关掉时 `spawn_agent` 本来就不在工具表里，这里是双保险。 */
  enabled?: () => boolean;
  /** 子代理的 token 记到父轮的账上。 */
  onUsage?(tokens: { hit: number; miss: number; out: number }): void;
}

interface Run {
  id: string;
  preset: string;
  task: string;
  status: 'running' | 'ok' | 'error' | 'cancelled';
  startedAt: number;
  ms?: number;
  writes: number;
  tokens: number;
  result?: SubagentResult;
  /** 结果还没被 `wait_for_agent` 或收件箱取走。 */
  pending: boolean;
  /** 已经被投递进父对话（避免同一条结果出现两次）。 */
  delivered: boolean;
  session: AgentSession;
  ctrl: AbortController;
  timer: ReturnType<typeof setTimeout> | null;
  promise: Promise<void>;
}

const CHILD_EVENTS = new Set<SessionEvent['kind']>(['tool', 'assistant', 'reasoning', 'image', 'notice']);

/** 结果 → 回给父代理的一段文本。父只会读这段，所以它必须自足。 */
export function resultText(run: Run): string {
  const r = run.result;
  const head = `[subagent ${run.preset} ${run.id} — ${run.status}${
    run.ms === undefined ? '' : `, ${(run.ms / 1000).toFixed(1)}s`
  }]`;
  if (!r) {
    return `${head}\n(no result)`;
  }
  const lines = [head, r.summary || '(empty summary)'];
  if (r.evidence.length) lines.push(`evidence: ${r.evidence.join(' | ')}`);
  if (r.gaps.length) lines.push(`gaps: ${r.gaps.join(' | ')}`);
  if (r.needsDecision) lines.push(`needs decision from the user: ${r.needsDecision}`);
  return lines.join('\n');
}

export function createSubagentRunner(opts: SubagentRunnerOpts): SubagentHost {
  const runs = new Map<string, Run>();
  let seq = 0;
  /** 本轮子代理的 token（父轮 `turn-end` 会把它加上去）。 */
  let spent = { hit: 0, miss: 0, out: 0 };

  function emit(e: SessionEvent): void {
    opts.onEvent(e);
  }

  function running(): Run[] {
    return [...runs.values()].filter((r) => r.status === 'running');
  }

  /** 已经结束但没人取的结果（按结束顺序）。 */
  function undelivered(): Run[] {
    return [...runs.values()].filter((r) => r.status !== 'running' && r.pending && !r.delivered);
  }

  function finish(run: Run, status: Run['status']): void {
    if (run.status !== 'running') return;
    run.status = status;
    run.ms = Date.now() - run.startedAt;
    if (run.timer) clearTimeout(run.timer);
    run.timer = null;
    opts.fence.release(run.id);

    const text = lastAssistantText(run.session);
    if (status === 'ok') {
      run.result = parseSubagentResult(text);
    } else {
      run.result = {
        summary:
          status === 'cancelled'
            ? `cancelled after ${(run.ms / 1000).toFixed(1)}s`
            : `failed after ${(run.ms / 1000).toFixed(1)}s: ${text.slice(0, 400)}`,
        evidence: [],
        gaps: [status === 'cancelled' ? 'the run was cancelled' : 'the run ended with an error'],
        needsDecision: null,
        unstructured: false,
      };
    }
    run.pending = true;
    emit({
      kind: 'subagent',
      phase: 'end',
      agentId: run.id,
      preset: run.preset,
      status,
      summary: run.result.summary.slice(0, SUMMARY_MAX_CHARS),
      ms: run.ms,
      writes: run.writes,
      tokens: run.tokens,
    });
  }

  function lastAssistantText(session: AgentSession): string {
    const messages = session.snapshot().messages;
    for (let i = messages.length - 1; i >= 0; i--) {
      const m = messages[i]!;
      if (m.role !== 'assistant') continue;
      if (typeof m.content === 'string' && m.content.trim()) return m.content;
    }
    return '';
  }

  function outcome(data: unknown): ToolOutcome {
    return { ok: true, text: JSON.stringify(data) };
  }

  function refuse(code: string, message: string): ToolOutcome {
    return {
      ok: false,
      code,
      text: JSON.stringify({ ok: false, error: { code, message } }),
    };
  }

  async function spawn(req: SpawnRequest): Promise<ToolOutcome> {
    if (opts.enabled && !opts.enabled()) {
      return refuse('unsupported', 'Subagents are switched off in the agent settings.');
    }
    if (!isPreset(req.preset)) {
      return refuse('invalid-argument', 'preset must be one of: explore, review, code.');
    }
    const task = req.task.trim();
    if (task.length < 12) {
      return refuse(
        'invalid-argument',
        'Write the task as a goal + what to inspect (ids) + the exact output you need. ' +
          'A one-line "check the scene" wastes the subagent\'s whole context.',
      );
    }
    const canWrite = req.canWrite === true;
    if (canWrite && !presetWritable(req.preset)) {
      return refuse(
        'unsupported',
        `preset "${req.preset}" is read-only. Only "code" can be spawned with canWrite.`,
      );
    }
    const domains = claimDomains(req.scope);
    if (canWrite && !domains.length) {
      return refuse(
        'invalid-argument',
        'canWrite needs a scope: name the tracks / clips / plugins you will touch ' +
          '(every write outside it is rejected).',
      );
    }
    const def = presetDef(req.preset);
    if (def.needsImages && !supportsImages(opts.config())) {
      return refuse(
        'unsupported',
        `preset "${req.preset}" reviews pictures, but the current model cannot read images.`,
      );
    }
    if (running().length >= MAX_CONCURRENT_SUBAGENTS) {
      return refuse(
        'conflict',
        `${MAX_CONCURRENT_SUBAGENTS} subagents are already running. Wait for one (wait_for_agent) ` +
          'or cancel it (cancel_agent) — do not spawn more and do not retry in a loop.',
      );
    }
    for (const other of opts.fence.claims()) {
      if (domainsOverlap(domains, [...other.domains])) {
        return refuse(
          'conflict',
          `The scope overlaps a reservation held by ${other.ownerId}. ` +
            'Two agents editing the same objects is exactly what the scope is for — pick another region.',
        );
      }
    }

    seq += 1;
    const id = `a${seq}`;
    const config = opts.config();
    const ctrl = new AbortController();
    const fence = opts.fence;
    const childExec = createToolExecutor(opts.control, {
      llm: () => opts.config(),
      fence,
      // 不给 subagents：深度固定为 1（工具白名单也会挡，这里是第二道）。
    });

    let runRef: Run | null = null;
    const session = new AgentSession({
      config,
      control: opts.control,
      execute: childExec,
      tools: presetTools(req.preset, canWrite),
      systemPrompt: presetSystemPrompt(req.preset),
      contextLimit: Math.min(contextLimitOf(config), SUBAGENT_CONTEXT_TOKENS),
      tx: false,
      ownerId: id,
      contextSuffix: false,
      maxSteps: def.steps,
      ...(opts.screenshots ? { screenshots: opts.screenshots } : {}),
      onStatus: () => {
        /* 子代理的状态不进父面板：父面板的状态由父会话自己维护 */
      },
      onUsage: (t) => {
        const run = runRef;
        if (!run) return;
        run.tokens += t.hit + t.miss + t.out;
        spent = { hit: spent.hit + t.hit, miss: spent.miss + t.miss, out: spent.out + t.out };
        opts.onUsage?.(t);
      },
      onEvent: (e) => {
        const run = runRef;
        if (!run) return;
        if (e.kind === 'turn-end') {
          run.writes += e.writes;
          return;
        }
        if (e.kind === 'error') {
          emit({
            kind: 'subagent',
            phase: 'event',
            agentId: run.id,
            event: { kind: 'notice', text: e.message },
          });
          return;
        }
        if (!CHILD_EVENTS.has(e.kind)) return;
        emit({ kind: 'subagent', phase: 'event', agentId: run.id, event: e });
      },
    });

    ctrl.signal.addEventListener('abort', () => session.stop(), { once: true });

    const scopeNote = domains.length
      ? `\n\n---\nYou may modify ONLY: ${domains.join(', ')}. ` +
        'Any write outside that set is rejected with a conflict — report it instead of working around it.'
      : '';

    const run: Run = {
      id,
      preset: req.preset,
      task,
      status: 'running',
      startedAt: Date.now(),
      writes: 0,
      tokens: 0,
      pending: false,
      delivered: false,
      session,
      ctrl,
      timer: null,
      promise: Promise.resolve(),
    };
    runRef = run;
    runs.set(id, run);
    fence.reserve(id, domains);

    run.timer = setTimeout(() => {
      run.ctrl.abort();
    }, SUBAGENT_WALL_MS);

    run.promise = session
      .send(`${task}${scopeNote}`)
      .then(() => finish(run, 'ok'))
      .catch((e: unknown) => {
        const cancelled = run.ctrl.signal.aborted;
        finish(run, cancelled ? 'cancelled' : 'error');
        if (!cancelled) {
          emit({
            kind: 'subagent',
            phase: 'event',
            agentId: id,
            event: { kind: 'notice', text: e instanceof Error ? e.message : String(e) },
          });
        }
      });

    emit({
      kind: 'subagent',
      phase: 'start',
      agentId: id,
      preset: req.preset,
      task,
      status: 'running',
    });

    if (req.mode === 'wait') return await wait(id);

    return outcome({
      ok: true,
      agentId: id,
      status: 'running',
      preset: req.preset,
      canWrite,
      note:
        'It runs in the background. Keep working; its result will be delivered to you automatically, ' +
        'or call wait_for_agent when you actually need it. There is no progress tool — do not poll.',
    });
  }

  async function wait(agentId: string | undefined, signal?: AbortSignal): Promise<ToolOutcome> {
    let targets: Run[];
    if (agentId) {
      const run = runs.get(agentId);
      if (!run) return refuse('not-found', `No subagent "${agentId}".`);
      targets = [run];
    } else {
      targets = [...runs.values()];
    }
    if (!targets.length) {
      return refuse('not-found', 'No subagent has been spawned in this conversation.');
    }

    const pendingRuns = targets.filter((r) => r.status === 'running');
    if (pendingRuns.length) {
      await raceAbort(
        Promise.all(pendingRuns.map((r) => r.promise)),
        signal,
      );
    }

    const results = targets.map((run) => {
      const alreadyReported = run.delivered;
      run.delivered = true;
      run.pending = false;
      return {
        agentId: run.id,
        preset: run.preset,
        status: run.status,
        alreadyReported,
        ms: run.ms ?? 0,
        writes: run.writes,
        tokens: run.tokens,
        summary: run.result?.summary ?? '',
        evidence: run.result?.evidence ?? [],
        gaps: run.result?.gaps ?? [],
        needsDecision: run.result?.needsDecision ?? null,
      };
    });
    return outcome({ ok: results.every((r) => r.status === 'ok'), results });
  }

  async function cancel(agentId: string): Promise<ToolOutcome> {
    const run = runs.get(agentId);
    if (!run) return refuse('not-found', `No subagent "${agentId}".`);
    if (run.status !== 'running') return outcome({ ok: true, agentId, status: run.status });
    run.ctrl.abort();
    // 工具执行不可中断，等它收尾（通常是当前这一次调用返回）。
    await raceAbort(run.promise, undefined).catch(() => undefined);
    return outcome({ ok: true, agentId, status: run.status });
  }

  return {
    available: () => !opts.enabled || opts.enabled(),
    spawn,
    wait,
    cancel,
    usage: () => spent,
    resetUsage: () => {
      spent = { hit: 0, miss: 0, out: 0 };
    },

    takeResults(): string[] {
      const ready = undelivered();
      if (!ready.length) return [];
      const out: string[] = [];
      for (const run of ready) {
        run.delivered = true;
        run.pending = false;
        out.push(resultText(run));
      }
      return out;
    },

    cancelAll(): void {
      for (const run of runs.values()) {
        if (run.status === 'running') run.ctrl.abort();
      }
    },
  };
}

/** `wait` 必须能被父代理的「停止」打断，否则按停之后要干等满墙钟。 */
function raceAbort<T>(p: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return p;
  if (signal.aborted) return Promise.reject(new Error('aborted'));
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => reject(new Error('aborted'));
    signal.addEventListener('abort', onAbort, { once: true });
    p.then(
      (v) => {
        signal.removeEventListener('abort', onAbort);
        resolve(v);
      },
      (e: unknown) => {
        signal.removeEventListener('abort', onAbort);
        reject(e);
      },
    );
  });
}
