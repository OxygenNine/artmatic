/**
 * shortcuts.ts — 快捷键表的唯一真源。
 *
 * 三处消费同一份数据：侧栏的快捷键面板、底栏右侧的提示、各按钮 tooltip 的角标。
 * 分开写必然出现「面板里写 Ctrl+Z，实际上代码里拦的是别的组合」这类漂移。
 *
 * 用法约定：`keysKey` 是**给人看的写法**（'Ctrl+Shift+Z'，或 '拖动' 这种手势名），
 * 代码里判定的仍是 KeyboardEvent 的 key/code（App.svelte 与 typography/keys.ts）。
 * 目前不区分 macOS（本项目主平台是 Windows）。
 *
 * 两个字段都是 `MessageKey` 而不是 `string` —— 它们都是展示文案，
 * 直接写字面量会把语言冻结在模块加载那一刻（见 effects/types.ts 的注释）。
 */
import type { MessageKey } from '../i18n/locales';

export interface Shortcut {
  /** 展示用写法，例如 'Ctrl+Shift+Z' 或 '拖动'。 */
  keysKey: MessageKey;
  labelKey: MessageKey;
}

export interface ShortcutGroup {
  titleKey: MessageKey;
  items: Shortcut[];
}

export const SHORTCUT_GROUPS: ShortcutGroup[] = [
  {
    titleKey: 'sc.group.playback',
    items: [
      { keysKey: 'sc.key.space', labelKey: 'sc.playPause' },
      { keysKey: 'sc.key.rulerDrag', labelKey: 'sc.scrub' },
      { keysKey: 'sc.key.ctrlWheel', labelKey: 'sc.zoomAtCursor' },
      { keysKey: 'sc.key.wheel', labelKey: 'sc.scrollTimeline' },
    ],
  },
  {
    titleKey: 'sc.group.clip',
    items: [
      { keysKey: 'sc.key.drag', labelKey: 'sc.moveClip' },
      { keysKey: 'sc.key.dragEdge', labelKey: 'sc.resizeClip' },
      { keysKey: 'sc.key.dragEmpty', labelKey: 'sc.marqueeClips' },
      { keysKey: 'sc.key.shiftClickClip', labelKey: 'sc.addRemoveClip' },
      { keysKey: 'sc.key.dragSelection', labelKey: 'sc.moveClips' },
      { keysKey: 'sc.key.dblClick', labelKey: 'sc.openClipEditor' },
      { keysKey: 'sc.key.renameClip', labelKey: 'sc.renameClip' },
      { keysKey: 'sc.key.k', labelKey: 'sc.openCurveEditor' },
      { keysKey: 'sc.key.s', labelKey: 'sc.splitAtPlayhead' },
      { keysKey: 'sc.key.h', labelKey: 'sc.toggleClipHidden' },
      { keysKey: 'sc.key.altArrows', labelKey: 'sc.shiftTrack' },
      { keysKey: 'sc.key.delete', labelKey: 'sc.deleteClip' },
      { keysKey: 'sc.key.ctrlC', labelKey: 'sc.copyClips' },
      { keysKey: 'sc.key.ctrlX', labelKey: 'sc.cutClips' },
      { keysKey: 'sc.key.ctrlV', labelKey: 'sc.pasteClips' },
      { keysKey: 'sc.key.rightClick', labelKey: 'sc.newClipAtCursor' },
    ],
  },
  {
    titleKey: 'sc.group.typo',
    items: [
      { keysKey: 'sc.key.clickShiftClick', labelKey: 'sc.selectElement' },
      { keysKey: 'sc.key.dragEmpty', labelKey: 'sc.marquee' },
      { keysKey: 'sc.key.dragElement', labelKey: 'sc.moveElement' },
      { keysKey: 'sc.key.arrows', labelKey: 'sc.nudgeElement' },
      { keysKey: 'sc.key.ctrlA', labelKey: 'sc.selectAll' },
      { keysKey: 'sc.key.esc', labelKey: 'sc.deselect' },
      { keysKey: 'sc.key.space', labelKey: 'sc.playPauseAnim' },
    ],
  },
  {
    titleKey: 'sc.group.param',
    items: [
      { keysKey: 'sc.key.dragNumber', labelKey: 'sc.scrubValue' },
      { keysKey: 'sc.key.ctrlDrag', labelKey: 'sc.snapToStep' },
      { keysKey: 'sc.key.altDrag', labelKey: 'sc.fineTune' },
      { keysKey: 'sc.key.shiftDrag', labelKey: 'sc.coarseTune' },
      { keysKey: 'sc.key.esc', labelKey: 'sc.cancelDrag' },
      { keysKey: 'sc.key.upDown', labelKey: 'sc.stepValue' },
    ],
  },
  {
    titleKey: 'sc.group.project',
    items: [
      { keysKey: 'sc.key.ctrlS', labelKey: 'sc.saveProject' },
      { keysKey: 'sc.key.ctrlShiftS', labelKey: 'sc.saveAs' },
    ],
  },
  {
    titleKey: 'sc.group.general',
    items: [
      { keysKey: 'sc.key.ctrlZ', labelKey: 'sc.undo' },
      { keysKey: 'sc.key.ctrlShiftZ', labelKey: 'sc.redo' },
      { keysKey: 'sc.key.esc', labelKey: 'sc.closeOverlay' },
    ],
  },
];

/**
 * 扁平表，供需要按用途反查按键写法的场景（例如给按钮找它的快捷键角标）。
 *
 * 键是**文案键**而不是渲染后的文案：用渲染后的字符串当键的话，
 * `SHORTCUT_BY_LABEL['撤销']` 在切语言的那一刻就全部查不到了，
 * 而且失败是静默的（查不到就当没有快捷键）。
 */
export const SHORTCUT_BY_LABEL: Partial<Record<MessageKey, MessageKey>> = Object.fromEntries(
  SHORTCUT_GROUPS.flatMap((g) => g.items.map((i) => [i.labelKey, i.keysKey] as const)),
);

/**
 * 按描述键取回一整条快捷键（底栏提示用）。
 *
 * 查不到就**抛**：提示里的每一对「键 + 它做什么」都必须是这张表里真的登记过的
 * 那一条，否则底栏会显示成一条没有按键的说明 —— 那种失败看起来像「设计如此」。
 * 调用点全是字面量，所以这是开发期不变量，不是运行期分支
 * （同 `effects/registry.ts` 缺一半就启动报错的口径）。
 */
export function shortcutOf(labelKey: MessageKey): Shortcut {
  const keysKey = SHORTCUT_BY_LABEL[labelKey];
  if (!keysKey) throw new Error(`shortcutOf: 「${labelKey}」没有登记在 SHORTCUT_GROUPS 里`);
  return { keysKey, labelKey };
}

/* ------------------------------------------------------------ 快捷键方案
 *
 * 「操作习惯」面板里唯一**真的会改变行为**的一项。
 *
 * 只有「切分片段」这一个动作在四大剪辑软件里按键真的不同：
 *   Premiere      Ctrl+K
 *   After Effects Ctrl+Shift+D
 *   DaVinci       Ctrl+B
 *   Artmatic      S（单键，未选中任何东西时也不会误触别的功能）
 *
 * 其余动作（Ctrl+Z / Ctrl+S / Del / Space / Alt+↑↓）在四者之间是一致的，
 * **不要为了"看起来方案多"给它编造差异** —— 那会变成一份假的说明书。
 * 所以这张表只描述切分键，方案菜单里显示的也是同一份数据。
 */
export type ShortcutScheme = 'artmatic' | 'premiere' | 'aftereffects' | 'davinci';

export interface SchemeDef {
  id: ShortcutScheme;
  /** 展示名（Adobe / Blackmagic 的产品名是专名，不进语言表）。 */
  label: string;
  /**
   * 切分键的展示写法。
   *
   * 是 **MessageKey** 而不是字面量：底栏提示也要说这个键，而提示里的按键列
   * 一律走语言表（`HintAction.keysKey`）。写死字面量就成了同一件事的第二份副本
   * —— 改一处忘一处的时候，界面与行为会各说各的，且不会报错。
   */
  splitKeysKey: MessageKey;
  /** 是否与默认方案不同（"默认"那一项用它来做标记，不必翻语言表）。 */
  changesSplit: boolean;
}

export const SHORTCUT_SCHEMES: SchemeDef[] = [
  { id: 'artmatic', label: 'Artmatic', splitKeysKey: 'sc.key.s', changesSplit: false },
  { id: 'premiere', label: 'Premiere Pro', splitKeysKey: 'sc.key.ctrlK', changesSplit: true },
  { id: 'aftereffects', label: 'After Effects', splitKeysKey: 'sc.key.ctrlShiftD', changesSplit: true },
  { id: 'davinci', label: 'DaVinci Resolve', splitKeysKey: 'sc.key.ctrlB', changesSplit: true },
];

/** 某个方案下切分键的展示键。提示与设置面板都从这里取，不各自查表。 */
export function splitKeysKeyOf(scheme: ShortcutScheme): MessageKey {
  return (SHORTCUT_SCHEMES.find((s) => s.id === scheme) ?? SHORTCUT_SCHEMES[0]!).splitKeysKey;
}

/**
 * 某个方案下的切分键是否被按下。
 *
 * 默认方案返回 false：它的 `S` 由 App.svelte 那条既有分支处理，
 * 两处都判会让同一次击键走两遍（第二遍在切分后的片段上再切一刀）。
 */
export function isSplitKey(e: KeyboardEvent, scheme: ShortcutScheme): boolean {
  if (e.altKey) return false;
  const k = e.key.toLowerCase();
  switch (scheme) {
    case 'premiere':
      return e.ctrlKey && !e.shiftKey && k === 'k';
    case 'aftereffects':
      return e.ctrlKey && e.shiftKey && k === 'd';
    case 'davinci':
      return e.ctrlKey && !e.shiftKey && k === 'b';
    default:
      return false;
  }
}
