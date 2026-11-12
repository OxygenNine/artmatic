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
        out.push({ id: nextId(), role: 'image', text: m.caption ?? m.text });
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

class AgentUiState {
  prefs = $state<AgentPrefs>(defaultPrefs());
  messages = $state<AgentMessage[]>([]);
  status = $state<AgentStatus>('idle');
  busy = $state(false);
  /** 上下文用量（发送按钮左侧的环形进度）。 */
  context = $state<{ tokens: number; limit: number }>({ tokens: 0, limit: 1_000_000 });
  /** 历史面板是否打开（根级 modal，状态在这里）。 */
  historyOpen = $state(false);
  /**
   * 设置面板是**根级 modal**（挂在 `App.svelte` 的 `.page` 上），状态放这里：
   * 抽屉在 `.body` 里、又带着 `z-index`，把 modal 挂进抽屉会让它被困在那一层
   * （见 `ui/AGENTS.md` 的 z 刻度那一段）。放根级只有一个实例，两个视图共用。
   */
  settingsOpen = $state(false);
  /** 待用户确认的插件动作（试挂 / 安装；null = 没有）。 */
  pending = $state<PendingApproval | null>(null);
  /**
   * 「本次会话允许试挂」。
   *
   * 只活在**这个面板会话**里：不写偏好、不进工程，切工程 / 换控制平面即失效。
   * 插件迭代期模型往往要连续试挂十几轮，每轮弹卡会让人直接点「全都同意」——
   * 那比一次明确授权更糟。
   */
  allowTryThisSession = $state(false);
  /** 最近一轮改了几处（面板顶部提示「撤销本轮」）。 */
  lastWrites = $state(0);
  usage = $state<{ prompt: number; completion: number } | null>(null);
  /** 工具调用计数（rail 图标角标）。 */
  toolCalls = $state(0);
  /** 模型通过 `ask_user` 提的问题（null = 没有）。 */
  pendingAsk = $state<PendingAsk | null>(null);
  /** 本轮耗时（结束时写；摘要行用）。 */
  lastMs = $state(0);
  /**
   * 用户从界面里**标注**进这一条消息的对象（时间轴片段 / 排版元素）。
   *
   * 存在这里而不是抽屉组件内部：抽屉是条件渲染的（关掉就卸载），而「添加进
   * 上下文」的入口在时间轴与排版页的右键菜单上 —— 状态放组件里会在打开抽屉
   * 的那一刻丢掉。发送后清空，它们已经进了那条 user 消息。
   */
  contextRefs = $state<ContextRef[]>([]);
  /**
   * 排队中的插话。本轮运行期间用户发的东西都落在这里，
   * 由 session 在**下一次模型调用之前**取走（`takeInterjections`）。
   *
   * 放这里而不是 session 内部：用户要能在等待期间**编辑 / 撤销**（卡片在输入框上方），
   * 而 session 不该认识 UI 的编辑语义。
   */
  queued = $state<QueuedInterjection[]>([]);
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
  /** 账户余额（只有注册表里声明了 `apis.balance` 的提供商才有）。 */
  balance = $state<BalanceSnapshot | null>(null);
  balanceBusy = $state(false);
  /** 上一次余额查询的失败原因（`null` = 没有失败）。 */
  balanceError = $state<string | null>(null);

  /** 本轮是用户主动停的：剩下的插话留在卡片里让他改，不自动发出去。 */
  private stopRequested = false;

  private session: AgentSession | null = null;
  /** 会话代次：切工程 / 换控制平面后，旧会话的回调不再写进新工程。 */
  private sessionGen = 0;
  /** 轮次代次：clear / 切工程后，旧轮次的 finally 不再改新轮次的状态。 */
  private turnSeq = 0;
  private control: AgentControlPlane | null = null;
  private approvalResolve: ((ok: boolean) => void) | null = null;
  private askResolve: ((answer: string | null) => void) | null = null;
  private indexByCall = new Map<string, number>();
  /** 子代理卡在 `messages` 里的位置（按 agentId）。 */
  private indexByAgent = new Map<string, number>();
  /** 当前会话在 `project.agentSessions` 里的 id（第一次发消息时创建）。 */
  private activeSessionId: string | null = null;
  private sessionCreatedAt = 0;
  /**
   * 恢复会话的线格式起点，`ensureSession()` 建会话时消费一次（不做 `$state`：
   * 换它不该触发重渲，它只是「下一条会话的原料」）。
   */
  private resumeWire: ResumedMessage[] | null = null;
  /** 上一次绑定的工程 id：切工程时清空对话，别把 A 的聊天记进 B。 */
  private boundProjectId: string = appState.activeProjectId;
  /**
   * 会话持有的**同一个** config 对象：改设置时原地更新字段。
   *
   * 为什么不是每次 `send` 重新造一份：`AgentSession` 在构造时接住 config；
   * 换对象的话「先发一句 → 再填 key」会一直用旧对象（key 永远是空串）。
   */
  private cfg: LlmConfig;
  /** 子代理运行时。 */
  private subagents: SubagentHost | null = null;

  constructor() {
    this.prefs = loadPrefs();
    this.cfg = { ...DEFAULT_LLM_CONFIG };
    this.syncConfig();
    this.context = { tokens: 0, limit: this.contextLimit };
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

  /** 当前 (provider, model) 的上下文窗口 —— 各家从 32k 到 1M 不等。 */
  get contextLimit(): number {
    return contextLimitOf({ providerId: this.prefs.providerId, model: this.model });
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

  /* ------------------------------------------------------------ 生命周期 */

  attachControl(control: AgentControlPlane): void {
    // 子代理写的是同一个工程，换控制平面必须先把它们停掉。
    this.subagents?.cancelAll();
    this.session?.stop();
    this.sessionGen++;
    this.turnSeq++;
    this.busy = false;
    this.control = control;
    this.session = null; // 换控制平面 = 换工程容器，旧会话的工具闭包不能再用
    this.resumeWire = null;
    this.allowTryThisSession = false;
  }

  /**
   * 切换工程时由 `App.svelte` 的 effect 调一次。
   *
   * 不这么做的话：在 A 工程聊到一半，切到 B 再发一句，`saveSession` 会把 A 的
   * 消息记进 **B 的历史**（activeSessionId 还是 A 的）。消息只在轮末落库，
   * 所以这里不需要补存 —— 直接开一份新会话。
   */
  onProjectChanged(): void {
    const id = appState.activeProjectId;
    if (id === this.boundProjectId) return;
    this.boundProjectId = id;
    this.subagents?.cancelAll();
    this.session?.stop();
    this.sessionGen++;
    this.turnSeq++;
    this.busy = false;
    this.session = null;
    this.messages = [];
    // 标注指向的是上一个工程的片段 / 元素，留着就是一批悬空 id。
    this.clearContextRefs();
    this.activeSessionId = null;
    this.sessionCreatedAt = 0;
    this.resumeWire = null;
    this.pending = null;
    this.allowTryThisSession = false;
    this.pendingAsk = null;
    this.askResolve?.(null);
    this.askResolve = null;
    this.lastWrites = 0;
    this.lastMs = 0;
    this.usage = null;
    this.lastCache = null;
    this.lastCost = null;
    this.queued = [];
    this.toolCalls = 0;
    this.context = { tokens: 0, limit: this.contextLimit };
    this.historyOpen = false;
    this.status = 'idle';
  }

  /**
   * prefs → 会话持有的 config 对象（**原地改字段**）。
   *
   * `providerId` 必须在这里写：漏了的话 UI 切了家、请求还发往旧家 ——
   * 而如果那家恰好接受任意 key，会**返回正常内容**，用户以为在和新模型说话。
   */
  private syncConfig(): void {
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

  private ensureSession(): AgentSession | null {
    if (!this.control) return null;
    if (!this.session) {
      const gen = ++this.sessionGen;
      const control = this.control;
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
        config: () => this.cfg,
        enabled: () => this.prefs.subagents,
        screenshots: () => this.prefs.screenshots,
        onEvent: (e) => {
          if (gen === this.sessionGen) this.onEvent(e);
        },
      });
      const subagents = this.subagents;
      this.session = new AgentSession({
        config: this.cfg,
        control,
        execute: createToolExecutor(control, { llm: () => this.cfg, fence, subagents }),
        ...(this.resumeWire ? { initialMessages: this.resumeWire } : {}),
        maxSteps: () => this.prefs.maxSteps,
        screenshots: () => this.prefs.screenshots,
        subagents,
        fence,
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
    const snap = this.session?.snapshot();
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
      lastError: this.session?.lastError ?? null,
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
    this.context = { ...this.context, limit: this.contextLimit };
    this.syncConfig();
    this.persist();
  }

  /** 切提供商：保留每一家自己的 key / 模型 / 端点，别互相覆盖。 */
  setProvider(id: string): void {
    if (id === this.prefs.providerId) return;
    // 未知 id 直接忽略（下拉里不可能出现，但 localStorage 里的旧值可能）。
    const def = providerOf(id);
    this.prefs = { ...this.prefs, providerId: def.id };
    this.context = { tokens: 0, limit: this.contextLimit };
    // 余额是账号级的：换一家还显示上一家的钱会误导人。
    this.balance = null;
    this.balanceError = null;
    this.lastCost = null;
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
    this.context = { ...this.context, limit: this.contextLimit };
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

  /* ------------------------------------------------------------- 插话 */

  /**
   * session 在每次模型调用之前来取（**返回即清空**）。
   *
   * 面板不自己插气泡：注入后的 user 消息由 session 发 `kind:'user'` 事件回来。
   * 两边都插会看到两条一模一样的。
   */
  private takeInterjections(): InterjectionInput[] {
    if (!this.queued.length) return [];
    const items = this.queued.map((q) => ({
      text: q.text,
      ...(q.images?.length ? { images: q.images } : {}),
    }));
    this.queued = [];
    return items;
  }

  removeQueued(id: string): void {
    this.queued = this.queued.filter((q) => q.id !== id);
  }

  /* ------------------------------------------------------------ 对话 */

  async send(text: string, images: { base64: string; mimeType: string }[] = []): Promise<void> {
    /*
     * 运行期间发的东西是**插话**，不是错误：排队，等 session 在下一次模型调用
     * 之前取走（`takeInterjections`）。用户因此不必「等它跑完再按一次」，
     * 而且随时能撤销 —— 排队期间它还在输入框上方的卡片里。
     */
    if (this.busy) {
      const trimmed = text.trim();
      if (!trimmed && !images.length) return;
      this.queued = [
        ...this.queued,
        { id: nextId(), text: trimmed, ...(images.length ? { images } : {}) },
      ];
      return;
    }
    this.stopRequested = false;
    this.lastCache = null;
    this.lastCost = null;
    // 设置可能刚被改过（key / 模型 / 温度 / 思考强度）—— 会话持有的是同一个对象。
    this.syncConfig();
    const session = this.ensureSession();
    if (!session) {
      this.push({ id: nextId(), role: 'error', text: tr('agent.llm.notReady') });
      return;
    }
    if (!this.apiKey.trim()) {
      this.push({ id: nextId(), role: 'error', text: tr('agent.llm.noKey') });
      return;
    }
    /*
     * 上一轮被用户按停之后可能还留着排队卡片（那时故意不自动发）。新一轮开始
     * 就把它并进这一条 —— 让用户打的字永远跟着一条真实的消息走，
     * 而不是在别的轮次里半路冒出来。
     */
    if (this.queued.length) {
      const pending = this.queued;
      this.queued = [];
      const merged = [pending.map((q) => q.text).join('\n\n'), text].filter((s) => s.trim()).join('\n\n');
      text = merged;
      const queuedImages = pending.flatMap((q) => q.images ?? []);
      if (queuedImages.length) images = [...queuedImages, ...images];
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
    const refs = this.contextRefs;
    this.contextRefs = [];
    try {
      await session.send(text, images, refs);
    } finally {
      // clear / 切工程之后这一轮已经作废，不能改新一轮的 busy 与指标。
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
      const pending = this.queued;
      this.queued = [];
      const text = pending.map((q) => q.text).join('\n\n');
      const imgs = pending.flatMap((q) => q.images ?? []);
      void this.send(text, imgs);
    }
  }

  stop(): void {
    this.stopRequested = true;
    // 父按停的语义是「停下来」，不是「我看不见的地方继续改」。
    this.subagents?.cancelAll();
    this.session?.stop();
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
    this.lastWrites = 0;
  }

  clear(): void {
    // 开新会话之前先把这一段存进工程（否则「新会话」= 丢掉历史）。
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

  /**
   * 把当前消息流写成一条会话记录。
   *
   * **不写图片的 base64**（工程体积），只留说明；工具卡留下名字 / 状态 / 耗时。
   * 落盘走 `appState.saveAgentSession`：内存立即更新，磁盘排队写
   * （先把消息落到磁盘上，关页面 / 崩溃最多丢最后一条）。
   */
  private saveSession(): void {
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
    // 归属用 `boundProjectId`（轮次开始时绑定的那份）：轮末用户切了选项卡也不会
    // 把 A 的对话写进 B 的目录。
    appState.saveAgentSession(this.boundProjectId, record);
  }

  deleteSession(id: string): void {
    appState.deleteAgentSession(this.boundProjectId, id);
  }

  clearHistory(): void {
    // 当前会话也一并清掉（文件一起删）；内存里的消息保留与否由调用方决定。
    appState.clearAgentSessions(this.boundProjectId);
    this.activeSessionId = null;
    this.resumeWire = null;
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
    // 一轮还没跑完不能换会话：事务还开着，换掉 = 那一轮的改动失去归属。
    if (this.busy) return;
    // 先把当前这段落库（切走不该丢掉还没落盘的尾巴），再取回最新的一份 ——
    // 恢复的可能正是当前这条会话，此时上面的 save 刚把它覆盖过。
    this.saveSession();
    const fresh = this.history.find((s) => s.id === record.id) ?? record;

    this.session?.stop();
    this.sessionGen++;
    this.turnSeq++;
    this.session = null; // 下一次 send 用 restored 历史重建
    const wire = resumedMessages(fresh);
    this.resumeWire = wire.length ? wire : null;
    this.messages = restoredUiMessages(fresh);
    this.activeSessionId = fresh.id;
    this.sessionCreatedAt = fresh.createdAt;
    this.boundProjectId = appState.activeProjectId;

    this.lastWrites = 0;
    this.lastMs = 0;
    this.toolCalls = 0;
    this.usage = null;
    this.lastCache = null;
    this.lastCost = null;
    this.queued = [];
    this.stopRequested = false;
    this.pending = null;
    this.approvalResolve?.(false); // 上一段会话没答的审批卡：当作拒绝
    this.approvalResolve = null;
    this.pendingAsk = null;
    this.askResolve?.(null);
    this.askResolve = null;
    this.status = 'idle';

    // 立刻建会话：环形进度条要马上显示「背着多少上下文」，而不是等到下一次发送。
    const session = this.ensureSession();
    this.context = session?.context ?? { tokens: 0, limit: this.contextLimit };
    // 面板上看不到工具卡时，用户会以为历史没恢复全 —— 一句说明比空白诚实。
    this.messages = [
      ...this.messages,
      { id: nextId(), role: 'notice', text: tr('agent.historyRestored') },
    ];

    this.historyOpen = false;
    appState.setAgentOpen(true);
  }

  /** 审批卡「查看源码」用。 */
  async pluginSource(pluginId: string): Promise<string | null> {
    if (!this.control) return null;
    const r = await this.control.pluginSource(pluginId);
    return r.ok ? r.data.source : null;
  }

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

  private askApproval(req: {
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

  private activeAskId: string | null = null;

  private askUser(req: PendingAsk): Promise<string | null> {
    return new Promise<string | null>((resolve) => {
      const id = nextId();
      this.activeAskId = id;
      this.push({ id, role: 'ask', text: req.question, ...req, answer: undefined });
      this.askResolve = resolve;
      this.pendingAsk = req;
      this.status = 'awaiting-user';
    });
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
    const next = this.messages.slice();
    const current = next[i];
    if (!current) return;
    next[i] = { ...current, ...patch };
    this.messages = next;
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

  private onEvent(e: SessionEvent): void {
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

export const agentState = new AgentUiState();

/** `main.ts` 装配完控制平面后调一次。 */
export function registerControlPlane(control: AgentControlPlane): void {
  agentState.attachControl(control);
}
