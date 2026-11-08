/**
 * project-session.ts — 把「上次停在哪」写进工程目录（`session.json`）。
 *
 * ## 与自动保存的分工
 *
 * | 谁 | 写什么 | 什么时候 |
 * |---|---|---|
 * | `ui/autosave.ts` | `project.json`（**工程内容**） | 内容脏了，防抖 2 s |
 * | 本文件 | `session.json`（**播放头 / 选中 / 视图**） | 这些变了，防抖 0.9 s |
 *
 * 两者刻意不共用一个调度器：会话状态变化**不是**工程变更，不该进自动保存的
 * 快照、不该让工程变脏、也不该触发 `.bak` 之类的语义。它们只是恰好都要落盘。
 *
 * ## 为什么必须防抖，且不能设上限
 *
 * 播放头在播放 / 拖动时每帧都在变。没有防抖就是每帧写一次小文件；而「最多等
 * N 秒也要写一次」会让**播放期间**每秒都在写盘 —— 我们真正需要的时刻只有一个：
 * 用户停下来的时候。所以每次变化都重置计时器（不设 maxWait），播放中它自然
 * 一直不触发，暂停后 0.9 s 落一次最终位置。
 *
 * ## 失败一律降级
 *
 * 没有目录（还没保存过的工程）、磁盘写不进去、权限降级 —— 全部静默。
 * 丢的只是「下次打开停在第几秒」，工程内容一个字节都不会少（见
 * `project/session.ts` 文件头）。
 */

import { appState, type OpenProject } from './app-state.svelte';
import {
  serializeSession,
  writeSessionFile,
  type ProjectSession,
  type SessionView,
} from '../project/session';

/** 静默期。比自动保存短：它是一次几百字节的写，用户感知不到。 */
const SESSION_GAP_MS = 900;

let timer: ReturnType<typeof setTimeout> | null = null;
/** 正在写的那一轮（同一时刻只允许一个 writer，见 `flushProjectSession`）。 */
let inFlight: Promise<void> | null = null;
/** 等着写的工程（通常是 0～1 个；切工程时可能短暂有两个）。 */
const pending = new Set<OpenProject>();

/**
 * 每个工程上一次**确实写下去**的文本（键 = `draftKey`）。
 *
 * 与自动保存的 `lastWritten` 同一个作用：内容没变就不写。没有它的话，打开
 * 一份工程后哪怕什么都没动，第一次刷新预览也会引起一次无谓的写盘。
 */
const lastWritten = new Map<string, string>();

/** 当前工程该被记住的那一份状态。 */
function sessionOf(p: OpenProject): ProjectSession {
  const view: SessionView =
    p.view.kind === 'timeline' ? { kind: 'timeline' } : { kind: p.view.kind, clipId: p.view.clipId };
  return { playT: p.playT, selectedClipIds: p.selectedClipIds, view };
}

/** 「这份工程的会话状态可能变了」（播放头 / 选中 / 视图）。 */
export function scheduleProjectSession(p: OpenProject): void {
  // 没有目录就没有可写的地方：草稿只存工程本体（见 `project/drafts.ts`）。
  if (!p.dir) return;
  pending.add(p);
  if (timer !== null) clearTimeout(timer);
  timer = setTimeout(() => {
    timer = null;
    void flushProjectSession();
  }, SESSION_GAP_MS);
}

/**
 * 立刻写掉排队中的会话状态（保存 / E2E 不等防抖）。
 *
 * 同一时刻只允许一轮写入：`writeBytesAtomic` 用的是 exclusive writer，两次
 * 并发写同一个 `session.json` 会让后到的那个拿到 `NoModificationAllowedError`
 * （它会被当成写失败，白丢一次状态）。正在写时后来的调用排在它后面，合并成
 * 一轮 —— 与自动保存的「单飞」同一条口径。
 */
export function flushProjectSession(): Promise<void> {
  if (timer !== null) {
    clearTimeout(timer);
    timer = null;
  }
  if (inFlight) return inFlight.then(() => flushProjectSession());
  const run = (async () => {
    const list = [...pending];
    pending.clear();
    for (const p of list) await writeOne(p);
  })();
  inFlight = run;
  void run.finally(() => {
    if (inFlight === run) inFlight = null;
  });
  return run;
}

async function writeOne(p: OpenProject): Promise<void> {
  const dir = p.dir;
  if (!dir) return;
  const session = sessionOf(p);
  const text = serializeSession(session);
  if (lastWritten.get(p.draftKey) === text) return;
  // 写失败（权限降级 / 目录被移走）就保持缓存未命中，下次变化再试。
  if (await writeSessionFile(dir, session)) lastWritten.set(p.draftKey, text);
}

/**
 * 刚打开一份工程：把「当前状态」记成已落盘。
 *
 * 打开时状态就是从 `session.json` 读出来的（或默认值），所以此刻写一遍纯粹是
 * 无谓的磁盘抖动。调用点只有一个：`openAt`。
 */
export function primeProjectSession(p: OpenProject): void {
  lastWritten.set(p.draftKey, serializeSession(sessionOf(p)));
}

/**
 * 这份工程刚接上 / 换了目录（首次保存、另存为、E2E 接 OPFS）：
 * 之前记的「已写过」属于上一个位置，必须作废并立刻补写一次。
 */
export function attachProjectSession(p: OpenProject): void {
  lastWritten.delete(p.draftKey);
  scheduleProjectSession(p);
  // 保存是显式的「记住现在」：不等防抖，立刻补写一次再走。
  void flushProjectSession();
}

/** 接上「跟工程走的界面状态变了」这条线。在 `app-boot.ts` 里调一次。 */
export function startProjectSession(): void {
  appState.onSessionChange = (p) => scheduleProjectSession(p);
}
