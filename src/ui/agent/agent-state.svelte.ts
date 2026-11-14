/**
 * agent-state.svelte.ts — Agent 面板的**界面状态**（消息流 / 运行状态 / 配置）。
 *
 * 与 `src/agent/llm/session.ts` 的分工：session 管「模型 ↔ 工具」的循环，
 * 这个类只管「用户看到什么」—— 事件怎么落成消息、待审批卡怎么弹、配置存哪。
 *
 * 配置的**数据形状与迁移**在 `agent-prefs.ts`（纯函数、可单测）。
 * 这里只负责把 `$state` 接到那份数据上，并在改动时持久化。
 *
 * ## 控制平面从哪来
 *
 * `main.ts` 装配完控制平面后调 `registerControlPlane(control)`。不在这里
 * import 它：`createControlPlane` 需要注入 `appState`（ui 层），模块级 import
 * 会把 ui 的初始化顺序搅乱（也会让 `/lab/` 之类的入口被迫背上整棵 ui 依赖）。
 *
 * ## 任务跟着工程走（v22）
 *
 * 顶栏的选项卡 = **一份工程**。切选项卡不是「换页面」，所以它不该杀死正在跑的
 * Agent 任务 —— 用户的原话是「只要工程还开着就保持运行」。
 *
 * 于是运行态按工程分家：一份工程一个 `AgentChannel`，各自持有消息流、待确认卡、
 * `AgentSession`、以及一道 `SuspendGate`。切走时只**关闸**（会话在下一个检查点
 * 停下来等），不 `abort` —— 已经生成的那半轮回答与已经花掉的 token 都不作废；
 * 切回来开闸，任务从停下的地方接着跑。
 *
 * 为什么不能让它干脆继续跑：控制平面是单实例、绑**当前激活工程**，切走之后
 * 下一步工具就会写进另一份工程里（而且不会有任何报错）。闸门是这个约束的
 * 唯一正确解法，见 `agent/llm/suspend-gate.ts`。
 *
 * **真正会丢任务的地方仍然要问**（关工程选项卡、关页面）：`hasActiveTask()` /
 * `stopProject()` 是给那些确认框用的。
 *
 * ## Key 只存本机
 *
 * 存 `localStorage` 的 `artmatic.agent`（独立键，**不进 project.json**）。
 * 这不是「安全存储」—— 本机任何脚本都能读；设置面板里写明了这一点。
 * 「仅本次会话」开关会在落盘时把所有 provider 的 key 剥掉（内存里保留）。
 */

import { tr } from '../../i18n/index.svelte';
import type { AgentControlPlane } from '../../agent/control-plane';
import type {
  AgentStatus,
  CacheStats,
  InterjectionInput,
  LlmConfig,
  ReasoningEffort,
  SessionEvent,
  TurnCost,
  WireMessage,
} from '../../agent/llm/types';
import {
  AgentSession,
  canDisableThinking,
  contextLimitOf,
  createSubagentRunner,
  createToolExecutor,
  createWriteFence,
  DEFAULT_LLM_CONFIG,
  fetchBalance,
  MAX_STEPS_LIMIT,
  providerOf,
  SuspendGate,
  type BalanceSnapshot,
  type SubagentHost,
} from '../../agent/llm/index';
import type { ProviderDef } from '../../agent/llm/index';
import { resumedMessages, type AgentSessionRecord, type AgentStoredMessage, type ResumedMessage, type StoredFileRef } from '../../agent/history';
import { contextRefKey, mergeContextRefs, type ContextRef } from '../../agent/context';
import {
  PREFS_REV,
  activeApiKey,
  activeBaseUrl,
  activeModel,
  defaultPrefs,
  migratePrefs,
  prefsForStorage,
  providerOfPrefs,
  resolveLlmConfig,
  type AgentPrefs,
} from './agent-prefs';
import { modelCatalog } from './model-catalog.svelte';
import { appState } from '../app-state.svelte';

const KEY = 'artmatic.agent';

/** 界面层的名字；真源在 `agent/llm/types.ts`。 */
export type AgentEffort = ReasoningEffort;
export type { AgentPrefs };

/** 思考强度四档的展示顺序。具体某一家能用哪几档由注册表决定。 */
const ALL_EFFORTS: readonly ReasoningEffort[] = ['off', 'low', 'high', 'max'];

/** 一条消息最多点名几份技能。三份正文已经是一万多字，再多就不是「指定打法」了。 */
const MAX_SKILL_REFS = 3;

/* ------------------------------------------------------------------ 消息 */

export type AgentMessageRole =
  | 'user'
  | 'assistant'
  | 'reasoning'
  | 'tool'
  | 'ask'
  | 'notice'
  | 'error'
  | 'image'
  | 'subagent'
  | 'system';

export interface AgentMessage {
  id: string;
  role: AgentMessageRole;
  text: string;
  /** `role:'tool'` */
  callId?: string;
  toolName?: string;
  args?: unknown;
  toolStatus?: 'running' | 'ok' | 'error';
  code?: string;
  ms?: number;
  /** `role:'image'` / 用户消息里附的图（不落工程，只在本轮上下文里）。 */
  image?: { base64: string; mimeType: string; caption: string };
  images?: { base64: string; mimeType: string }[];
  /**
   * 图片的 **Files API 引用**（有就能落盘并在恢复时重新指向同一张图）。
   * 与 `image` / `images` 并存：base64 给灯箱看，`fileId` 给历史和下一轮请求用。
   */
  files?: StoredFileRef[];
  /** `role:'ask'` */
  question?: string;
  options?: string[];
  allowFreeText?: boolean;
  answer?: string | null;
  /**
   * `role:'subagent'`：子代理卡。
   *
   * 子代理的转录**只活在这里**（不落盘、不进父的 `messages`）。`tools` 里是它
   * 自己的工具调用 —— 注意 `callId` 只在**那个会话内**唯一，父子的 `call_0`
   * 必然撞号，所以这里按数组找，不进全局索引。
   */
  subagent?: {
    agentId: string;
    preset: string;
    task: string;
    status: 'running' | 'ok' | 'error' | 'cancelled';
    /** 流式回答（只留最后一段，中间的工具调用在 `tools` 里）。 */
    text: string;
    tools: AgentMessage[];
    summary?: string;
    ms?: number;
    writes?: number;
  };
}

export interface PendingApproval {
  /**
   * `try` = 立刻执行源码；`install` = 写进工程目录；`media` = 媒体池动作
   * （会移动 / 删除磁盘文件）。三者文案与按钮不同。
   */
  kind: 'try' | 'install' | 'media';
  pluginId: string;
  /** `media` 时给动作与目标（卡片正文用）。 */
  media?: { op: string; assetId?: string; assetName?: string };
  text: string;
  detail?: unknown;
}

export interface PendingAsk {
  question: string;
  options: string[];
  allowFreeText: boolean;
}

/** 排队中的插话（模型还在干活，本轮的下一次调用之前才注入）。 */
export interface QueuedInterjection {
  id: string;
  text: string;
  images?: { base64: string; mimeType: string }[];
  /** 发这条插话时点名的技能。跟着插话一起注入，不能在队列里丢掉。 */
  skills?: string[];
}

let seq = 0;
const nextId = (): string => `m${++seq}`;

/**
 * 历史记录 → 面板消息（恢复会话时的一次性投影）。
 *
 * 只还原**看得见的东西**：历史里没有 `args`、没有图片 base64（见
 * `agent/history.ts`），所以工具卡退化成「名字 + 状态 + 结果文本」，
 * 截图退化成一行说明。`running` 不会出现在磁盘上（保存时跳过），万一有也按
 * `ok` 还原 —— 一张永远转圈的卡比一张已完成的可疑得多。
 */
function restoredUiMessages(record: AgentSessionRecord): AgentMessage[] {
  const out: AgentMessage[] = [];
  for (const m of record.messages) {
    switch (m.role) {
      case 'user':
        out.push({ id: nextId(), role: 'user', text: m.text });
        break;
      case 'assistant':
        out.push({ id: nextId(), role: 'assistant', text: m.text });
        break;
      case 'reasoning':
        out.push({ id: nextId(), role: 'reasoning', text: m.text });
        break;
      case 'tool':
        out.push({
          id: nextId(),
          role: 'tool',
          text: m.text,
          ...(m.toolName ? { toolName: m.toolName } : {}),
          toolStatus: m.toolStatus === 'error' ? 'error' : 'ok',
          ...(m.code ? { code: m.code } : {}),
          ...(m.ms === undefined ? {} : { ms: m.ms }),
        });
        break;
      case 'image':
        out.push({
          id: nextId(),
          role: 'image',
          text: m.caption ?? m.text,
          ...(m.files?.length ? { files: m.files } : {}),
        });
        break;
      default:
        out.push({ id: nextId(), role: 'error', text: m.text });
        break;
    }
  }
  return out;
}

/* ------------------------------------------------------------------ 状态 */

function loadPrefs(): AgentPrefs {
  try {
    const raw = localStorage.getItem(KEY);
    return raw ? migratePrefs(JSON.parse(raw) as unknown) : defaultPrefs();
  } catch {
    // 存储不可用（隐私模式）或内容损坏：回落到默认值，别让面板打不开。
    return defaultPrefs();
  }
}

/**
 * 一份工程的 Agent 运行态。
 *
 * **一份工程一个实例**：消息流、待确认卡、会话句柄、挂起闸门都在这里。
 * 切走工程时它原封不动留在 `AgentUiState.channels` 里，切回来接上 ——
 * 这正是「只要工程还开着，任务就还在」的实现。
 *
 * 注意：只有**当前**这份的字段会驱动界面（`AgentUiState` 的 getter 转发到
 * `active`）。其余实例照常被自己的会话回调写入（流式回答还要落地），
 * 只是没有组件在读它们。
 */
class AgentChannel {
  messages = $state<AgentMessage[]>([]);
  status = $state<AgentStatus>('idle');
  busy = $state(false);
  /** 上下文用量（发送按钮左侧的环形进度）。 */
  context = $state<{ tokens: number; limit: number }>({ tokens: 0, limit: 1_000_000 });
  /** 待用户确认的插件 / 媒体池动作（null = 没有）。 */
  pending = $state<PendingApproval | null>(null);
  /** 模型通过 `ask_user` 提的问题（null = 没有）。 */
  pendingAsk = $state<PendingAsk | null>(null);
  /** 排队中的插话（本轮的下一次模型调用之前注入）。 */
  queued = $state<QueuedInterjection[]>([]);
  /** 工具调用计数（rail 图标角标）。 */
  toolCalls = $state(0);
  /** 最近一轮改了几处（面板顶部提示「撤销本轮」）。 */
  lastWrites = $state(0);
  /** 本轮耗时（结束时写；摘要行用）。 */
  lastMs = $state(0);
  /**
   * 上一轮的缓存账（`null` = 这家没上报缓存字段）。
   *
   * 显示判据就是这个 null：不支持的实现**什么都不显示**，而不是假装 0% ——
   * 「0%」是一个陈述（这次真的一句都没命中），而「没这项数据」是另一件事。
   */
  lastCache = $state<CacheStats | null>(null);
  /**
   * 上一轮的估算费用（`null` = 这家没有价目表）。
   *
   * 与 `lastCache` 同一条纪律：**没有数据就不显示**，不要用 0 冒充。
   */
  lastCost = $state<TurnCost | null>(null);
  usage = $state<{ prompt: number; completion: number } | null>(null);
  /**
   * 「本工程本次会话允许试挂」。
   *
   * 只活在**这条通道**里：不写偏好、不进工程，切工程即失效（每个工程各一份）。
   * 插件迭代期模型往往要连续试挂十几轮，每轮弹卡会让人直接点「全都同意」——
   * 那比一次明确授权更糟。
   */
  allowTryThisSession = $state(false);

  /** 挂起闸门：这份工程不是当前激活的那份时关上（见 `suspend-gate.ts`）。 */
  readonly gate = new SuspendGate();
  /** 本轮是用户主动停的：剩下的插话留在卡片里让他改，不自动发出去。 */
  stopRequested = false;

  session: AgentSession | null = null;
  subagents: SubagentHost | null = null;
  /** 会话代次：clear / 恢复历史后，旧会话的回调不再写进这一份。 */
  sessionGen = 0;
  /** 轮次代次：clear / 恢复历史后，旧轮次的 finally 不再改新轮次的状态。 */
  turnSeq = 0;
  /** 子代理卡在 `messages` 里的位置（按 agentId）。 */
  indexByCall = new Map<string, number>();
  indexByAgent = new Map<string, number>();
  /** 当前会话在 `project.agentSessions` 里的 id（第一次发消息时创建）。 */
  activeSessionId: string | null = null;
  sessionCreatedAt = 0;
  /**
   * 恢复会话的线格式起点，`ensureSession()` 建会话时消费一次（不做 `$state`：
   * 换它不该触发重渲，它只是「下一条会话的原料」）。
   */
  resumeWire: ResumedMessage[] | null = null;

  approvalResolve: ((ok: boolean) => void) | null = null;
  askResolve: ((answer: string | null) => void) | null = null;
  activeAskId: string | null = null;

  constructor(
    readonly projectId: string,
    private readonly host: AgentUiState,
  ) {
    this.context = { tokens: 0, limit: host.contextLimit };
  }

  /* ------------------------------------------------------------ 生命周期 */

  /** 会话句柄。第一次要的时候建，之后一直复用（历史与事务都挂在它上面）。 */
  ensureSession(): AgentSession | null {
    const control = this.host.plane;
    if (!control) return null;
    if (!this.session) {
      const gen = ++this.sessionGen;
      /*
       * 写栅栏与子代理运行时都建在**这一层**：它们要同时被父会话、子会话和
       * 执行器用到，而这里是唯一同时握着 `onEvent`（带代次校验）与控制平面的地方。
       *
       * `fence` 必须**父子共用一个实例** —— 否则两个代理各有一份 claim 表，
       * 「明确分开」就不成立。
       */
      const fence = createWriteFence({ txOpen: () => control.txState().open });
      this.subagents = createSubagentRunner({
        control,
        fence,
        config: () => this.host.llmConfig,
        enabled: () => this.host.prefs.subagents,
        screenshots: () => this.host.prefs.screenshots,
        // 子代理写的是同一份工程：父会话被挂起时它们也必须停手。
        suspend: this.gate,
        onEvent: (e) => {
          if (gen === this.sessionGen) this.onEvent(e);
        },
      });
      const subagents = this.subagents;
      this.session = new AgentSession({
        config: this.host.llmConfig,
        control,
        execute: createToolExecutor(control, { llm: () => this.host.llmConfig, fence, subagents }),
        ...(this.resumeWire ? { initialMessages: this.resumeWire } : {}),
        maxSteps: () => this.host.prefs.maxSteps,
        screenshots: () => this.host.prefs.screenshots,
        subagents,
        fence,
        suspend: this.gate,
        onEvent: (e) => {
          if (gen === this.sessionGen) this.onEvent(e);
        },
        onStatus: (s) => {
          if (gen === this.sessionGen) this.status = s;
        },
        onApproval: (req) => (gen === this.sessionGen ? this.askApproval(req) : Promise.resolve(false)),
        onAskUser: (req) => (gen === this.sessionGen ? this.askUser(req) : Promise.resolve(null)),
        takeInterjections: () => (gen === this.sessionGen ? this.takeInterjections() : []),
      });
    }
    return this.session;
  }

  /* ------------------------------------------------------------ 对话 */

  async send(text: string, images: { base64: string; mimeType: string }[] = []): Promise<void> {
    const host = this.host;
    /*
     * 运行期间发的东西是**插话**，不是错误：排队，等 session 在下一次模型调用
     * 之前取走（`takeInterjections`）。用户因此不必「等它跑完再按一次」，
     * 而且随时能撤销 —— 排队期间它还在输入框上方的卡片里。
     *
     * 点名的技能跟着这条插话走（`skills`），不能像标注那样留着等下一轮：
     * 「在它跑的时候补一句 + 指定打法」是一个动作，拆开就没意义了。
     */
    if (this.busy) {
      const trimmed = text.trim();
      if (!trimmed && !images.length) return;
      this.queued = [
        ...this.queued,
        {
          id: nextId(),
          text: trimmed,
          ...(images.length ? { images } : {}),
          ...(host.skillRefs.length ? { skills: host.takeSkillRefs() } : {}),
        },
      ];
      return;
    }
    this.stopRequested = false;
    this.lastCache = null;
    this.lastCost = null;
    // 设置可能刚被改过（key / 模型 / 温度 / 思考强度）—— 会话持有的是同一个对象。
    host.syncConfig();
    const session = this.ensureSession();
    if (!session) {
      this.push({ id: nextId(), role: 'error', text: tr('agent.llm.notReady') });
      return;
    }
    if (!host.apiKey.trim()) {
      this.push({ id: nextId(), role: 'error', text: tr('agent.llm.noKey') });
      return;
    }
    /*
     * 上一轮被用户按停之后可能还留着排队卡片（那时故意不自动发）。新一轮开始
     * 就把它并进这一条 —— 让用户打的字永远跟着一条真实的消息走，
     * 而不是在别的轮次里半路冒出来。
     */
    if (this.queued.length) {
      const queued = this.queued;
      this.queued = [];
      const merged = [queued.map((q) => q.text).join('\n\n'), text].filter((s) => s.trim()).join('\n\n');
      text = merged;
      const queuedImages = queued.flatMap((q) => q.images ?? []);
      if (queuedImages.length) images = [...queuedImages, ...images];
      // 排队期间点名的技能并到这一条：它们是「这条消息的打法」，而这条消息
      // 就是那句排队的话本身（见上面的合并规则）。
      host.addSkillRefs(queued.flatMap((q) => q.skills ?? []));
    }
    this.busy = true;
    const turn = ++this.turnSeq;
    this.lastWrites = 0;
    this.lastMs = 0;
    this.toolCalls = 0;
    const started = Date.now();
    // 会话记录从第一条消息开始；标题取用户第一句话。
    if (!this.activeSessionId) {
      this.activeSessionId = `as-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
      this.sessionCreatedAt = started;
    }
    // 标注随这一条消息发出去，随后清空 —— 留着会让下一条消息莫名其妙地
    // 又带上同样的宾语。清空放在真正要发之后：没有 key 时不吞掉用户钉的东西。
    const refs = host.contextRefs;
    host.contextRefs = [];
    const skills = host.takeSkillRefs();
    try {
      await session.send(text, images, refs, skills);
    } finally {
      // clear / 恢复历史之后这一轮已经作废，不能改新一轮的 busy 与指标。
      // 切工程**不**作废（那只是挂起），所以这一支照常收尾 —— 只是写进
      // 本通道自己的字段，与当前界面上显示的是哪一份无关。
      if (turn === this.turnSeq) {
        this.busy = false;
        this.status = 'idle';
        this.lastMs = Date.now() - started;
        const snap = session.snapshot();
        if (snap.usage) {
          this.usage = {
            prompt: snap.usage.prompt_tokens ?? 0,
            completion: snap.usage.completion_tokens ?? 0,
          };
        }
        this.saveSession();
      }
    }

    /*
     * 收尾时还有没被注入的插话（模型已经给完答案 / 步数用尽）：当成下一条消息
     * 直接发出去 —— 用户打的字不该停在队列里。**用户主动停的不算**：那时他多半
     * 是想改这句，卡片留着让他编辑。
     */
    if (turn === this.turnSeq && !this.stopRequested && this.queued.length) {
      const queued = this.queued;
      this.queued = [];
      const next = queued.map((q) => q.text).join('\n\n');
      const imgs = queued.flatMap((q) => q.images ?? []);
      host.addSkillRefs(queued.flatMap((q) => q.skills ?? []));
      void this.send(next, imgs);
    }
  }

  /**
   * 手动压缩上下文（斜杠命令 `/compact`）。
   *
   * 面板自己持 `busy`：压缩是一次真实的模型请求，用户要能按停（`stop()`），
   * 也**不能**和一轮对话并发 —— 两边都会重写 `messages`。
   */
  async compact(): Promise<void> {
    if (this.busy) {
      this.push({ id: nextId(), role: 'error', text: tr('agent.slash.busy') });
      return;
    }
    this.host.syncConfig();
    const session = this.ensureSession();
    if (!session) {
      this.push({ id: nextId(), role: 'error', text: tr('agent.llm.notReady') });
      return;
    }
    if (!this.host.apiKey.trim()) {
      this.push({ id: nextId(), role: 'error', text: tr('agent.llm.noKey') });
      return;
    }
    this.busy = true;
    this.stopRequested = false;
    const turn = ++this.turnSeq;
    const started = Date.now();
    try {
      const outcome = await session.compact();
      // `ok` 的那条通知由 session 发（带前后 token 数），这里只管另外三种。
      if (outcome === 'short') this.push({ id: nextId(), role: 'notice', text: tr('agent.slash.short') });
      else if (outcome === 'busy') this.push({ id: nextId(), role: 'error', text: tr('agent.slash.busy') });
      else if (outcome === 'failed') this.push({ id: nextId(), role: 'error', text: tr('agent.slash.failed') });
    } catch {
      // 按停（cancelled）与请求失败在这里是同一种处理：什么都不改，也不再吵一句。
    } finally {
      if (turn === this.turnSeq) {
        this.busy = false;
        this.status = 'idle';
        this.lastMs = Date.now() - started;
        this.saveSession();
      }
    }
  }

  stop(): void {
    this.stopRequested = true;
    // 父按停的语义是「停下来」，不是「我看不见的地方继续改」。
    this.subagents?.cancelAll();
    this.session?.stop();
  }

  /** 新会话。历史先落库（否则「新会话」= 丢掉历史）。 */
  clear(): void {
    this.saveSession();
    this.subagents?.cancelAll();
    this.session?.clear();
    this.turnSeq++;
    this.busy = false;
    this.messages = [];
    this.lastWrites = 0;
    this.lastMs = 0;
    this.toolCalls = 0;
    this.usage = null;
    this.lastCache = null;
    this.lastCost = null;
    this.queued = [];
    this.pending = null;
    this.pendingAsk = null;
    this.askResolve?.(null);
    this.askResolve = null;
    this.activeSessionId = null;
    this.sessionCreatedAt = 0;
    this.resumeWire = null;
    this.status = 'idle';
  }

  /* ------------------------------------------------------------ 会话历史 */

  /**
   * 把当前消息流写成一条会话记录。
   *
   * **不写图片的 base64**（工程体积），只留说明；工具卡留下名字 / 状态 / 耗时。
   * 落盘走 `appState.saveAgentSession`：内存立即更新，磁盘排队写
   * （先把消息落到磁盘上，关页面 / 崩溃最多丢最后一条）。
   */
  saveSession(): void {
    if (!this.activeSessionId || this.messages.length === 0) return;
    const stored: AgentStoredMessage[] = [];
    for (const m of this.messages) {
      if (m.role === 'tool' && m.toolStatus === 'running') continue;
      if (m.role === 'image') {
        stored.push({
          role: 'image',
          text: m.text,
          caption: m.text,
          ...(m.files?.length ? { files: m.files } : {}),
        });
        continue;
      }
      if (m.role === 'ask') {
        stored.push({ role: 'user', text: `${m.text}\n→ ${m.answer ?? ''}`.trim() });
        continue;
      }
      if (m.role === 'system' || m.role === 'notice') continue;
      /*
       * 子代理不落盘成 `subagent` 角色：`history.ts::ROLES` 里没有它，
       * `sanitizeAgentSession` 会**静默丢弃** —— 表现是「重开工程那一段凭空
       * 消失」，且不报错。折成一条工具记录，恢复时还原成一张普通工具卡。
       * 转录本来就不该进磁盘（一次审查几十次工具调用，会话文件会从 20k 字变 200k）。
       */
      if (m.role === 'subagent') {
        const sub = m.subagent;
        if (!sub) continue;
        stored.push({
          role: 'tool',
          text: `[subagent ${sub.preset} ${sub.agentId}] ${sub.summary ?? sub.text}`.slice(0, 20_000),
          toolName: 'spawn_agent',
          toolStatus: sub.status === 'error' ? 'error' : 'ok',
          ...(sub.ms === undefined ? {} : { ms: sub.ms }),
        });
        continue;
      }
      stored.push({
        role: m.role,
        text: m.text.slice(0, 20_000),
        ...(m.toolName ? { toolName: m.toolName } : {}),
        ...(m.toolStatus ? { toolStatus: m.toolStatus } : {}),
        ...(m.code ? { code: m.code } : {}),
        ...(m.ms === undefined ? {} : { ms: m.ms }),
        // 图片引用：40 字节的 `file-api-...`，恢复会话时能让模型重新看到那张图。
        ...(m.files?.length ? { files: m.files } : {}),
      });
    }
    if (!stored.length) return;
    const title =
      this.messages.find((m) => m.role === 'user')?.text.trim().slice(0, 60) || tr('agent.historyUntitled');
    const record: AgentSessionRecord = {
      id: this.activeSessionId,
      title,
      createdAt: this.sessionCreatedAt || Date.now(),
      updatedAt: Date.now(),
      messages: stored,
    };
    /*
     * 归属是本通道的工程 —— 不是「当前激活的那份」。轮末用户早就切走了也写对，
     * 这正是 handler 从 `boundProjectId` 换成 `channel.projectId` 的原因。
     */
    appState.saveAgentSession(this.projectId, record);
  }

  /* ------------------------------------------------------------ 审批 / 问答 */

  /**
   * 待确认卡上的按钮。
   *
   * `rememberTry` 只对 `kind === 'try'` 有意义：勾了「本次会话允许试挂」之后，
   * 后续试挂直接放行（不再弹卡）。**安装永远不会被这个开关顺带批准** ——
   * 写盘是另一种风险，必须每次显式点。
   */
  resolveApproval(approved: boolean, rememberTry = false): void {
    const req = this.pending;
    const resolve = this.approvalResolve;
    this.approvalResolve = null;
    this.pending = null;
    if (approved && rememberTry && req?.kind === 'try') this.allowTryThisSession = true;
    resolve?.(approved);
  }

  askApproval(req: {
    kind: 'try' | 'install' | 'media';
    pluginId: string;
    media?: { op: string; assetId?: string; assetName?: string };
    text: string;
    detail?: unknown;
  }): Promise<boolean> {
    // 已授权「本次会话允许试挂」：试挂直接放行，不弹卡（安装照旧弹）。
    if (req.kind === 'try' && this.allowTryThisSession) return Promise.resolve(true);
    return new Promise<boolean>((resolve) => {
      this.approvalResolve = resolve;
      this.pending = req;
      this.status = 'awaiting-approval';
    });
  }

  /** 问答卡上的提交（null = 取消）。 */
  resolveAsk(answer: string | null): void {
    const resolve = this.askResolve;
    this.askResolve = null;
    this.pendingAsk = null;
    const id = this.activeAskId;
    this.activeAskId = null;
    if (id) this.patch(id, { answer });
    resolve?.(answer);
  }

  askUser(req: PendingAsk): Promise<string | null> {
    return new Promise<string | null>((resolve) => {
      const id = nextId();
      this.activeAskId = id;
      this.push({ id, role: 'ask', text: req.question, ...req, answer: undefined });
      this.askResolve = resolve;
      this.pendingAsk = req;
      this.status = 'awaiting-user';
    });
  }

  /* ------------------------------------------------------------ 插话 */

  /**
   * session 在每次模型调用之前来取（**返回即清空**）。
   *
   * 面板不自己插气泡：注入后的 user 消息由 session 发 `kind:'user'` 事件回来。
   * 两边都插会看到两条一模一样的。
   */
  takeInterjections(): InterjectionInput[] {
    if (!this.queued.length) return [];
    const items = this.queued.map((q) => ({
      text: q.text,
      ...(q.images?.length ? { images: q.images } : {}),
      ...(q.skills?.length ? { skills: q.skills } : {}),
    }));
    this.queued = [];
    return items;
  }

  removeQueued(id: string): void {
    this.queued = this.queued.filter((q) => q.id !== id);
  }

  /* ------------------------------------------------------------ 事件 */

  private push(msg: AgentMessage): void {
    this.messages = [...this.messages, msg];
  }

  private patch(callId: string, patch: Partial<AgentMessage>): void {
    // 工具卡按 callId 定位；其它消息（问答卡）按消息 id 定位。
    let i = this.indexByCall.get(callId);
    if (i === undefined) i = this.messages.findIndex((m) => m.id === callId);
    if (i === undefined || i < 0) return;
    this.patchMessage(i, patch);
  }

  /** 按位置整条替换（保持数组不可变，`$state` 才能察觉）。 */
  private patchMessage(i: number, patch: Partial<AgentMessage>): void {
    const next = this.messages.slice();
    const current = next[i];
    if (!current) return;
    next[i] = { ...current, ...patch };
    this.messages = next;
  }

  /**
   * 子代理事件 → 一张可折叠的卡。
   *
   * 里层事件**只能进卡**：`kind:'user'` / `turn-end'` / `context'` 已经在 runner
   * 那侧被挡掉了（透传会污染父的用户气泡、父的费用账、父的进度环）。
   * 这里再滤一次 `reasoning`：子代理怎么想的，对用户没有价值。
   */
  private onSubagentEvent(e: Extract<SessionEvent, { kind: 'subagent' }>): void {
    if (e.phase === 'start') {
      this.indexByAgent.set(e.agentId, this.messages.length);
      this.push({
        id: nextId(),
        role: 'subagent',
        text: '',
        subagent: {
          agentId: e.agentId,
          preset: e.preset ?? '',
          task: e.task ?? '',
          status: 'running',
          text: '',
          tools: [],
        },
      });
      return;
    }
    const i = this.indexByAgent.get(e.agentId);
    if (i === undefined) return;
    const current = this.messages[i];
    const sub = current?.subagent;
    if (!sub) return;

    if (e.phase === 'end') {
      this.patchMessage(i, {
        subagent: {
          ...sub,
          status: e.status ?? 'ok',
          ...(e.summary === undefined ? {} : { summary: e.summary }),
          ...(e.ms === undefined ? {} : { ms: e.ms }),
          ...(e.writes === undefined ? {} : { writes: e.writes }),
        },
      });
      return;
    }

    const inner = e.event;
    if (!inner) return;
    if (inner.kind === 'tool') {
      if (inner.status === 'running') {
        this.patchMessage(i, {
          subagent: {
            ...sub,
            // 新一次工具往返开始 = 上一段话已经说完，卡片正文只留最后一段。
            text: '',
            tools: [
              ...sub.tools,
              {
                id: nextId(),
                role: 'tool',
                text: '',
                callId: inner.callId,
                toolName: inner.name,
                args: inner.args,
                toolStatus: 'running',
              },
            ],
          },
        });
      } else {
        this.patchMessage(i, {
          subagent: {
            ...sub,
            tools: sub.tools.map((t) =>
              t.callId === inner.callId
                ? {
                    ...t,
                    toolStatus: inner.status === 'error' ? 'error' : 'ok',
                    text: inner.text ?? '',
                    ...(inner.code ? { code: inner.code } : {}),
                    ...(inner.ms === undefined ? {} : { ms: inner.ms }),
                  }
                : t,
            ),
          },
        });
      }
      return;
    }
    if (inner.kind === 'assistant') {
      this.patchMessage(i, { subagent: { ...sub, text: sub.text + inner.text } });
      return;
    }
    if (inner.kind === 'notice') {
      this.patchMessage(i, {
        subagent: { ...sub, tools: [...sub.tools, { id: nextId(), role: 'notice', text: inner.text }] },
      });
      return;
    }
    if (inner.kind === 'image') {
      this.patchMessage(i, {
        subagent: {
          ...sub,
          tools: [
            ...sub.tools,
            {
              id: nextId(),
              role: 'image',
              text: inner.caption,
              image: { base64: inner.base64, mimeType: inner.mimeType, caption: inner.caption },
              ...(inner.file ? { files: [inner.file] } : {}),
            },
          ],
        },
      });
    }
  }

  onEvent(e: SessionEvent): void {
    switch (e.kind) {
      case 'user':
        this.push({
          id: nextId(),
          role: 'user',
          text: e.text,
          ...(e.images?.length ? { images: e.images } : {}),
          ...(e.files?.length ? { files: e.files } : {}),
        });
        break;
      case 'assistant': {
        const last = this.messages[this.messages.length - 1];
        if (last && last.role === 'assistant') {
          // 流式增量：原地追加到最后一条 assistant。
          const next = this.messages.slice();
          next[next.length - 1] = { ...last, text: last.text + e.text };
          this.messages = next;
        } else {
          this.push({ id: nextId(), role: 'assistant', text: e.text });
        }
        break;
      }
      case 'reasoning': {
        // 同一段思考流式追加（模型开思考时才有）。
        const last = this.messages[this.messages.length - 1];
        if (last && last.role === 'reasoning') {
          const next = this.messages.slice();
          next[next.length - 1] = { ...last, text: last.text + e.text };
          this.messages = next;
        } else {
          this.push({ id: nextId(), role: 'reasoning', text: e.text });
        }
        break;
      }
      case 'ask':
        // 卡片由 `askUser()` 插入（它要拿 id 回填答案），这里只更新状态。
        this.status = 'awaiting-user';
        break;
      case 'notice':
        this.push({ id: nextId(), role: 'notice', text: e.text });
        break;
      case 'context':
        this.context = { tokens: e.tokens, limit: e.limit };
        break;
      case 'tool': {
        if (e.status === 'running') {
          this.toolCalls += 1;
          this.indexByCall.set(e.callId, this.messages.length);
          this.push({
            id: nextId(),
            role: 'tool',
            text: '',
            callId: e.callId,
            toolName: e.name,
            args: e.args,
            toolStatus: 'running',
          });
        } else {
          this.patch(e.callId, {
            toolStatus: e.status,
            text: e.text ?? '',
            ...(e.code ? { code: e.code } : {}),
            ...(e.ms === undefined ? {} : { ms: e.ms }),
          });
        }
        break;
      }
      case 'image':
        this.push({
          id: nextId(),
          role: 'image',
          text: e.caption,
          image: { base64: e.base64, mimeType: e.mimeType, caption: e.caption },
          ...(e.file ? { files: [e.file] } : {}),
        });
        break;
      case 'error':
        this.push({ id: nextId(), role: 'error', text: e.message });
        break;
      case 'subagent':
        this.onSubagentEvent(e);
        break;
      case 'turn-end':
        this.lastWrites = e.writes;
        this.lastMs = e.ms;
        // 这家不上报缓存时保持 null（面板不显示），不要写成 0。
        this.lastCache = e.cache ?? null;
        this.lastCost = e.cost ?? null;
        break;
    }
  }
}

class AgentUiState {
  prefs = $state<AgentPrefs>(defaultPrefs());
  /** 历史面板是否打开（根级 modal，状态在这里）。 */
  historyOpen = $state(false);
  /**
   * 设置面板是**根级 modal**（挂在 `App.svelte` 的 `.page` 上），状态放这里：
   * 抽屉在 `.body` 里、又带着 `z-index`，把 modal 挂进抽屉会让它被困在那一层
   * （见 `ui/AGENTS.md` 的 z 刻度那一段）。放根级只有一个实例，两个视图共用。
   */
  settingsOpen = $state(false);
  /**
   * 用户从界面里**标注**进这一条消息的对象（时间轴片段 / 排版元素）。
   *
   * 存在这里而不是抽屉组件内部：抽屉是条件渲染的（关掉就卸载），而「添加进
   * 上下文」的入口在时间轴与排版页的右键菜单上 —— 状态放组件里会在打开抽屉
   * 的那一刻丢掉。发送后清空，它们已经进了那条 user 消息。
   *
   * 它**不按工程分家**：标注的是「当前界面上选中的东西」，切工程时本来就该清。
   */
  contextRefs = $state<ContextRef[]>([]);
  /**
   * 用户在斜杠菜单里**点名**的技能（名字，顺序 = 点名顺序）。
   *
   * 与 `contextRefs` 同类：随这一条消息发出去、随后清空。区别是它带的是
   * **打法**（正文直接进 user 消息），不是宾语 —— 所以只能由用户点，模型不能
   * 往这里写（模型要读技能走 `read_skill` 工具）。
   *
   * 上限 3：技能正文是几千字，点名四份等于把对话挤掉。超出的静默不追加，
   * 但输入框上沿的胶囊会显示已经点了几份，用户看得见。
   */
  skillRefs = $state<string[]>([]);
  /** 账户余额（只有注册表里声明了 `apis.balance` 的提供商才有）。 */
  balance = $state<BalanceSnapshot | null>(null);
  balanceBusy = $state(false);
  /** 上一次余额查询的失败原因（`null` = 没有失败）。 */
  balanceError = $state<string | null>(null);

  /** 当前这份工程。**换成别的实例** = 界面换了一份对话（`$state` 才能追踪）。 */
  active = $state<AgentChannel>(null as unknown as AgentChannel);
  /** 上一次绑定的工程 id：切工程时换通道，别把 A 的聊天记进 B。 */
  private boundProjectId: string = appState.activeProjectId;
  /** 每份工程一条通道。工程关掉时一起回收（见 `pruneChannels`）。 */
  private channels = new Map<string, AgentChannel>();

  private control: AgentControlPlane | null = null;
  /**
   * 会话持有的**同一个** config 对象：改设置时原地更新字段。
   *
   * 为什么不是每次 `send` 重新造一份：`AgentSession` 在构造时接住 config；
   * 换对象的话「先发一句 → 再填 key」会一直用旧对象（key 永远是空串）。
   */
  private cfg: LlmConfig;

  constructor() {
    this.prefs = loadPrefs();
    this.cfg = { ...DEFAULT_LLM_CONFIG };
    this.syncConfig();
    this.active = this.channelFor(appState.activeProjectId);
    /*
     * 工程被关掉 = 通道的宿主没了。方向只能是 appState → 这里（appState 不能
     * import agent-state，它反过来被 import），所以走它已有的钩子。
     */
    appState.onProjectRemoved = (id) => this.dropProject(id);
  }

  /* ---------------------------------------------------------- 派生查询 */

  /** 当前提供商（注册表条目）。 */
  get provider(): ProviderDef {
    return providerOfPrefs(this.prefs);
  }

  /** 当前提供商的 key（渲染时直接读，不用另开一份 `$state` 镜像）。 */
  get apiKey(): string {
    return activeApiKey(this.prefs);
  }

  get model(): string {
    return activeModel(this.prefs);
  }

  get baseUrl(): string {
    return activeBaseUrl(this.prefs);
  }

  get contextLimit(): number {
    return contextLimitOf(this.cfg);
  }

  /** 这一家这一型能选的思考档位（有的模型关不掉思考）。 */
  get efforts(): readonly ReasoningEffort[] {
    return canDisableThinking(this.provider, this.model)
      ? ALL_EFFORTS
      : ALL_EFFORTS.filter((e) => e !== 'off');
  }

  /**
   * 这一家的预设模型（手填仍然允许）。
   *
   * models.dev 的实时目录排前面、注册表快照垫后（`model-catalog.svelte.ts`）——
   * 目录没取到时这里就是注册表那一份，不会变成空下拉。
   */
  get modelPresets(): readonly string[] {
    return modelCatalog.presetsFor(this.provider);
  }

  /* ---------------------------------------------- 当前工程的只读视图 */
  /*
   * 界面只认「当前激活这份工程」。这些 getter 让面板与时间轴代码不用知道
   * 通道的存在 —— `agentState.busy` 永远是**这一份工程**的 busy。
   */

  get messages(): AgentMessage[] {
    return this.active.messages;
  }
  get status(): AgentStatus {
    return this.active.status;
  }
  get busy(): boolean {
    return this.active.busy;
  }
  get context(): { tokens: number; limit: number } {
    return this.active.context;
  }
  get pending(): PendingApproval | null {
    return this.active.pending;
  }
  get pendingAsk(): PendingAsk | null {
    return this.active.pendingAsk;
  }
  get queued(): QueuedInterjection[] {
    return this.active.queued;
  }
  get toolCalls(): number {
    return this.active.toolCalls;
  }
  get lastWrites(): number {
    return this.active.lastWrites;
  }
  get lastMs(): number {
    return this.active.lastMs;
  }
  get lastCache(): CacheStats | null {
    return this.active.lastCache;
  }
  get lastCost(): TurnCost | null {
    return this.active.lastCost;
  }
  get usage(): { prompt: number; completion: number } | null {
    return this.active.usage;
  }
  get allowTryThisSession(): boolean {
    return this.active.allowTryThisSession;
  }

  /** 会话持有的 config（通道装配执行器时要同一份对象）。 */
  get llmConfig(): LlmConfig {
    return this.cfg;
  }

  /** 控制平面（没装配好时是 null）。 */
  get plane(): AgentControlPlane | null {
    return this.control;
  }

  /* ------------------------------------------------------------ 生命周期 */

  private channelFor(projectId: string): AgentChannel {
    let ch = this.channels.get(projectId);
    if (!ch) {
      ch = new AgentChannel(projectId, this);
      this.channels.set(projectId, ch);
    }
    return ch;
  }

  attachControl(control: AgentControlPlane): void {
    // 子代理写的是同一个工程，换控制平面必须先把它们停掉（旧闭包不能再用）。
    for (const ch of this.channels.values()) {
      ch.subagents?.cancelAll();
      ch.session?.stop();
      ch.sessionGen++;
      ch.turnSeq++;
      ch.busy = false;
      ch.session = null;
      ch.resumeWire = null;
      ch.allowTryThisSession = false;
    }
    this.control = control;
  }

  /**
   * 切换工程选项卡时由 `App.svelte` 的 effect 调一次。
   *
   * **不掐断正在跑的任务**：只把旧通道的闸门关上（会话在下一个检查点停下），
   * 换到目标工程的通道并把它的闸门打开。于是「只要工程还开着，任务就还在」，
   * 切回来时从停下的地方接着跑，不需要用户重发。
   *
   * 不这么做的话还有另一个坑：在 A 工程聊到一半切到 B 再发一句，
   * `saveSession` 会把 A 的消息记进 **B 的历史**。通道让归属天然正确。
   */
  onProjectChanged(): void {
    const id = appState.activeProjectId;
    if (id === this.boundProjectId) return;
    const prev = this.active;
    this.boundProjectId = id;
    /*
     * 只挂起**在跑的**。空闲通道不关闸：它可能是「聊完就切走」的那种，
     * 关着会让用户切回来后第一次发送立刻卡住（闸门只在循环检查点看）。
     */
    if (prev.busy) prev.gate.close();
    this.active = this.channelFor(id);
    this.active.gate.open();
    // 标注指向的是上一个工程的片段 / 元素，留着就是一批悬空 id。
    this.clearContextRefs();
    this.historyOpen = false;
    // 被关掉的工程：连通道一起回收（任务如果真的还在跑，这里会把它停掉）。
    this.pruneChannels();
  }

  private pruneChannels(): void {
    const alive = new Set(appState.projects.map((p) => p.id));
    for (const [id, ch] of [...this.channels]) {
      // 当前通道永远留着：即使它对应的是「没有工程」那个回落值（`''`）。
      if (alive.has(id) || id === this.boundProjectId) continue;
      ch.subagents?.cancelAll();
      ch.session?.stop();
      ch.gate.open();
      this.channels.delete(id);
    }
  }

  /* -------------------------------------------------- 给确认框用的查询 */

  /**
   * 这份工程上有没有**没跑完**的 Agent 任务。
   *
   * 判据是 `busy`（含等用户确认 / 等问答的那一刻）—— 「有一堆历史消息但闲着」
   * 不算，那不需要拦。
   */
  hasActiveTask(projectId: string = appState.activeProjectId): boolean {
    const ch = this.channels.get(projectId);
    return Boolean(ch?.busy);
  }

  /**
   * 有没有**任何**一份工程在跑 Agent 任务。
   *
   * 给 `beforeunload` 用：关页面会把所有工程和所有在跑的任务一起丢掉，
   * 而浏览器不会给我们第二次机会。与 `anyDirty` 同一类判据。
   */
  get anyBusy(): boolean {
    for (const ch of this.channels.values()) if (ch.busy) return true;
    return false;
  }

  /** 除了当前这份之外，还有别的工程在跑任务吗（rail 上那个「后台有任务」提示用）。 */
  get backgroundTasks(): number {
    let n = 0;
    for (const [id, ch] of this.channels) {
      if (id !== this.boundProjectId && ch.busy) n++;
    }
    return n;
  }

  /** 真的要中断（关工程 / 关页面前确认过之后）。 */
  stopProject(projectId: string): void {
    this.channels.get(projectId)?.stop();
  }

  /**
   * 工程被关掉了：它的通道没有宿主了。
   *
   * 停止是**必须**的 —— 会话的工具写的是「当前激活工程」，容器消失之后那次
   * 写入会落到别人身上。`appState.closeProject` 在 `activeProjectId` 改之前
   * 调这里，所以还能判断出被关的是不是当前那份。
   */
  dropProject(projectId: string): void {
    const ch = this.channels.get(projectId);
    if (!ch) return;
    ch.subagents?.cancelAll();
    ch.session?.stop();
    ch.gate.open();
    if (projectId === this.boundProjectId) {
      /*
       * 关的正是当前这份：**先不删**。此刻 `activeProjectId` 还没变，
       * getter 仍指到这里；删掉它会让面板读到 undefined。擦成空壳即可，
       * 下一次 `onProjectChanged` 切到新工程后由 `pruneChannels` 回收。
       */
      ch.messages = [];
      ch.status = 'idle';
      ch.busy = false;
      ch.queued = [];
      ch.pending = null;
      ch.pendingAsk = null;
      return;
    }
    this.channels.delete(projectId);
  }

  /** 当前工程的停止按钮 / Esc。 */
  stop(): void {
    this.active.stop();
  }

  /* ------------------------------------------------------------ 配置 */

  openSettings(): void {
    this.settingsOpen = true;
    // 顺手刷一次模型目录：设置面板一打开就该有几分钟内的模型列表。
    void modelCatalog.ensureFresh();
    // 余额也顺手查一次（没有余额接口的提供商直接空着，不报错）。
    void this.refreshBalance();
  }

  /**
   * 查账户余额。没有 `apis.balance` 的提供商什么也不做（`balance` 保持 null，
   * 面板据此不显示那一行）。
   *
   * 失败只推一条提示、不清空上一次的值：查不到余额不代表账户出问题，
   * 而把已经显示的数字抹掉会让人以为余额归零。
   */
  async refreshBalance(): Promise<void> {
    if (!this.provider.apis?.balance || !this.apiKey.trim() || this.balanceBusy) return;
    this.balanceBusy = true;
    this.balanceError = null;
    try {
      this.balance = await fetchBalance(this.cfg);
    } catch (e) {
      // 不推进对话流：这是设置页的一次查询，失败了在那一行下面说一句就够。
      this.balanceError = (e instanceof Error ? e.message : String(e)).slice(0, 160);
    } finally {
      this.balanceBusy = false;
    }
  }

  closeSettings(): void {
    this.settingsOpen = false;
  }

  openHistory(): void {
    this.historyOpen = true;
  }

  closeHistory(): void {
    this.historyOpen = false;
  }

  /**
   * 导出这一轮的详细日志（JSON）。**key 打码**，图片只留尺寸与 MIME ——
   * 日志是为了排查 400 / 上下文问题，不需要把 base64 复制一份到磁盘。
   */
  exportLog(): void {
    const snap = this.active.session?.snapshot();
    const key = this.apiKey.trim();
    const payload = {
      kind: 'artmatic-agent-log',
      exportedAt: new Date().toISOString(),
      project: appState.projectName,
      config: {
        provider: this.prefs.providerId,
        model: this.model,
        baseUrl: this.baseUrl,
        effort: this.prefs.effort,
        temperature: this.prefs.temperature,
        maxSteps: this.prefs.maxSteps,
        screenshots: this.prefs.screenshots,
        apiKey: key ? `${key.slice(0, 4)}…${key.slice(-4)}` : '',
      },
      usage: this.usage,
      context: this.context,
      lastError: this.active.session?.lastError ?? null,
      uiMessages: this.messages.map((m) => ({
        role: m.role,
        text: m.text,
        ...(m.toolName ? { toolName: m.toolName } : {}),
        ...(m.toolStatus ? { toolStatus: m.toolStatus } : {}),
        ...(m.code ? { code: m.code } : {}),
        ...(m.ms !== undefined ? { ms: m.ms } : {}),
        ...(m.args !== undefined ? { args: m.args } : {}),
        ...(m.image ? { image: { mimeType: m.image.mimeType, bytes: m.image.base64.length } } : {}),
      })),
      // 图片 base64 不写进日志（一张就能几十 MB）：只留占位。
      wireMessages: (snap?.messages ?? []).map((m) =>
        Array.isArray(m.content)
          ? {
              ...m,
              content: m.content.map((p) =>
                p.type === 'image_url' ? { type: 'text' as const, text: '[image omitted]' } : p,
              ),
            }
          : m,
      ),
    };
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    const safeName = (appState.projectName || 'project').replace(/[^\w\u4e00-\u9fa5-]+/g, '_').slice(0, 40);
    const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    a.href = url;
    a.download = `agent-log-${safeName}-${stamp}.json`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    // 下一帧再回收：立刻 revoke 在部分浏览器里会让下载拿到空文件。
    setTimeout(() => URL.revokeObjectURL(url), 0);
  }

  setPrefs(patch: Partial<AgentPrefs>): void {
    this.prefs = { ...this.prefs, ...patch };
    // 切模型会改上下文窗口：环形进度条的刻度要跟着走。
    this.active.context = { ...this.active.context, limit: this.contextLimit };
    this.syncConfig();
    this.persist();
  }

  /** 切提供商：保留每一家自己的 key / 模型 / 端点，别互相覆盖。 */
  setProvider(id: string): void {
    if (id === this.prefs.providerId) return;
    // 未知 id 直接忽略（下拉里不可能出现，但 localStorage 里的旧值可能）。
    const def = providerOf(id);
    this.prefs = { ...this.prefs, providerId: def.id };
    this.active.context = { tokens: 0, limit: this.contextLimit };
    // 余额是账号级的：换一家还显示上一家的钱会误导人。
    this.balance = null;
    this.balanceError = null;
    this.active.lastCost = null;
    this.syncConfig();
    this.persist();
    void this.refreshBalance();
  }

  setModel(model: string): void {
    this.patchOverride({ model: model.trim() || undefined });
  }

  setBaseUrl(baseUrl: string): void {
    this.patchOverride({ baseUrl: baseUrl.trim() || undefined });
  }

  setApiKey(key: string): void {
    this.patchOverride({ apiKey: key || undefined });
    // 换 key = 可能换了账号，余额要重新查（查不到就保持空）。
    this.balance = null;
    this.balanceError = null;
    void this.refreshBalance();
  }

  clearApiKey(): void {
    this.patchOverride({ apiKey: undefined });
  }

  /** 只改当前 provider 的覆盖项；清空即回到注册表默认。 */
  private patchOverride(patch: { model?: string; baseUrl?: string; apiKey?: string }): void {
    const id = this.prefs.providerId;
    const current = { ...(this.prefs.overrides[id] ?? {}) };
    for (const [key, value] of Object.entries(patch) as [keyof typeof patch, string | undefined][]) {
      if (value === undefined) delete current[key];
      else current[key] = value;
    }
    const overrides = { ...this.prefs.overrides };
    if (Object.keys(current).length) overrides[id] = current;
    else delete overrides[id];
    this.prefs = { ...this.prefs, overrides };
    this.active.context = { ...this.active.context, limit: this.contextLimit };
    this.syncConfig();
    this.persist();
  }

  private persist(): void {
    try {
      localStorage.setItem(KEY, JSON.stringify({ ...prefsForStorage(this.prefs), prefsRev: PREFS_REV }));
    } catch {
      // 存储不可用（隐私模式 / 配额）不该打断对话。
    }
  }

  /**
   * prefs → 会话持有的 config 对象（**原地改字段**）。
   *
   * `providerId` 必须在这里写：漏了的话 UI 切了家、请求还发往旧家 ——
   * 而如果那家恰好接受任意 key，会**返回正常内容**，用户以为在和新模型说话。
   */
  syncConfig(): void {
    const next = resolveLlmConfig(this.prefs, DEFAULT_LLM_CONFIG.proxyPath);
    this.cfg.providerId = next.providerId;
    this.cfg.baseUrl = next.baseUrl;
    this.cfg.apiKey = next.apiKey;
    this.cfg.model = next.model;
    this.cfg.temperature = next.temperature;
    // 强度是 UI 词汇，翻译成各家原生参数发生在 providers/reasoning.ts。
    this.cfg.effort = next.effort;
    this.cfg.proxyPath = next.proxyPath;
  }

  get ready(): boolean {
    return Boolean(this.control) && this.apiKey.trim().length > 0;
  }

  /** 当前提供商可用的申请地址（`custom` 没有）。 */
  get needsProxy(): boolean {
    return this.provider.transport.proxy && !this.provider.transport.browserDirect;
  }

  /* ------------------------------------------------------- 上下文标注 */

  /**
   * 「添加进上下文」的落点。去重与封顶都在 `mergeContextRefs`（纯函数）。
   *
   * 重复钉同一个对象不是错误，只是没有意义 —— 静默去重比弹一句提示好：
   * 用户点第二次时想的是「怎么没反应」，而画面里那个胶囊本来就在。
   */
  addContextRefs(refs: readonly ContextRef[]): void {
    if (!refs.length) return;
    this.contextRefs = mergeContextRefs(this.contextRefs, refs);
  }

  removeContextRef(key: string): void {
    this.contextRefs = this.contextRefs.filter((ref) => contextRefKey(ref) !== key);
  }

  clearContextRefs(): void {
    if (this.contextRefs.length) this.contextRefs = [];
  }

  /* ------------------------------------------------------------- 技能点名 */

  /** 斜杠菜单选中一份技能。重复点名无效（胶囊本来就在）。 */
  attachSkill(name: string): void {
    if (!name || this.skillRefs.includes(name)) return;
    if (this.skillRefs.length >= MAX_SKILL_REFS) return;
    this.skillRefs = [...this.skillRefs, name];
  }

  removeSkillRef(name: string): void {
    this.skillRefs = this.skillRefs.filter((n) => n !== name);
  }

  /** 批量追加（排队插话里的技能并进下一条消息时用）。 */
  addSkillRefs(names: readonly string[]): void {
    for (const n of names) this.attachSkill(n);
  }

  /** 取走点名列表：**返回即清空**，与 `takeInterjections` 同一条纪律。 */
  takeSkillRefs(): string[] {
    const out = this.skillRefs;
    if (out.length) this.skillRefs = [];
    return out;
  }

  /* ------------------------------------------------------------ 对话转发 */

  async send(text: string, images: { base64: string; mimeType: string }[] = []): Promise<void> {
    await this.active.send(text, images);
  }

  async compact(): Promise<void> {
    await this.active.compact();
  }

  clear(): void {
    this.active.clear();
  }

  removeQueued(id: string): void {
    this.active.removeQueued(id);
  }

  resolveApproval(approved: boolean, rememberTry = false): void {
    this.active.resolveApproval(approved, rememberTry);
  }

  resolveAsk(answer: string | null): void {
    this.active.resolveAsk(answer);
  }

  /**
   * 撤销整轮。
   *
   * 一轮 = 一笔撤销（`CommandStack.commit` 在事务内不入栈），所以点一次
   * `undo()` 就够 —— 不需要按工具调用次数循环。
   */
  async undoTurn(): Promise<void> {
    if (!this.control) return;
    await this.control.undo();
    this.active.lastWrites = 0;
  }

  /* ------------------------------------------------------------ 会话历史 */

  /**
   * 当前工程的会话记录。
   *
   * 数据挂在 `OpenProject.agentSessions`（每个选项卡一份），磁盘真源是
   * `agent/sessions/<id>.json`。**不是 `project.agentSessions`** —— 聊天记录
   * 不属于工程内容，挂在工程上会让「聊一句 = 重写整份 project.json」。
   */
  get history(): AgentSessionRecord[] {
    // 读 version 建立依赖：切工程 / 打开工程 / 删除会话后列表要跟着刷新。
    void appState.version;
    return appState.activeProject.agentSessions;
  }

  deleteSession(id: string): void {
    appState.deleteAgentSession(appState.activeProjectId, id);
  }

  clearHistory(): void {
    // 当前会话也一并清掉（文件一起删）；内存里的消息保留与否由调用方决定。
    appState.clearAgentSessions(appState.activeProjectId);
    this.active.activeSessionId = null;
    this.active.resumeWire = null;
  }

  /**
   * 从历史恢复一段会话，接着聊。
   *
   * **恢复的是摘要，不是完整线格式**：历史里只有 user / assistant 的文本
   * （`resumedMessages` 的注释解释了这个取舍），工具调用与结果不进上下文。
   * 起点因此只能在下一次建 `AgentSession` 时注入（`ensureSession` 的
   * `initialMessages`），session 会补一句 resume note 让模型重新读工程。
   *
   * 沿用记录的 id：下一轮落库是**覆盖**那条会话（`updatedAt` 刷新、排到最前），
   * 而不是新建一条 —— 「继续这个任务」本来就该是同一条记录。
   */
  restoreSession(record: AgentSessionRecord): void {
    const ch = this.active;
    // 一轮还没跑完不能换会话：事务还开着，换掉 = 那一轮的改动失去归属。
    if (ch.busy) return;
    // 先把当前这段落库（切走不该丢掉还没落盘的尾巴），再取回最新的一份 ——
    // 恢复的可能正是当前这条会话，此时上面的 save 刚把它覆盖过。
    ch.saveSession();
    const fresh = this.history.find((s) => s.id === record.id) ?? record;

    ch.session?.stop();
    ch.sessionGen++;
    ch.turnSeq++;
    ch.session = null; // 下一次 send 用 restored 历史重建
    const wire = resumedMessages(fresh);
    ch.resumeWire = wire.length ? wire : null;
    ch.messages = restoredUiMessages(fresh);
    ch.activeSessionId = fresh.id;
    ch.sessionCreatedAt = fresh.createdAt;

    ch.lastWrites = 0;
    ch.lastMs = 0;
    ch.toolCalls = 0;
    ch.usage = null;
    ch.lastCache = null;
    ch.lastCost = null;
    ch.queued = [];
    ch.stopRequested = false;
    ch.pending = null;
    ch.approvalResolve?.(false); // 上一段会话没答的审批卡：当作拒绝
    ch.approvalResolve = null;
    ch.pendingAsk = null;
    ch.askResolve?.(null);
    ch.askResolve = null;
    ch.status = 'idle';

    // 立刻建会话：环形进度条要马上显示「背着多少上下文」，而不是等到下一次发送。
    const session = ch.ensureSession();
    ch.context = session?.context ?? { tokens: 0, limit: this.contextLimit };
    // 面板上看不到工具卡时，用户会以为历史没恢复全 —— 一句说明比空白诚实。
    ch.messages = [...ch.messages, { id: nextId(), role: 'notice', text: tr('agent.historyRestored') }];

    this.historyOpen = false;
    appState.setAgentOpen(true);
  }

  /** 审批卡「查看源码」用。 */
  async pluginSource(pluginId: string): Promise<string | null> {
    if (!this.control) return null;
    const r = await this.control.pluginSource(pluginId);
    return r.ok ? r.data.source : null;
  }
}

export const agentState = new AgentUiState();

/** `main.ts` 装配完控制平面后调一次。 */
export function registerControlPlane(control: AgentControlPlane): void {
  agentState.attachControl(control);
}
