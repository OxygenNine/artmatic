/**
 * hints.ts — 底栏提示的**纯逻辑**：把「指针指着什么」「现在是什么状态」翻译成提示。
 *
 * 三层，优先级从高到低（`pickHint` 取第一个非空的）：
 *
 * 1. **手势**（`statusHint.gesture`，不在这里）—— 正在拖片段 / 正在框选。
 *    Blender 的模态键位那一栏：手还没松开时最想知道的就是「松开会怎样、Esc 会怎样」。
 * 2. **悬停**（`hoverHint`）—— 指针下的东西能做什么。**只覆盖没有气泡的目标**：
 *    片段 / 轨道行 / 标尺 / 轨道头 / 轨道行空白。有 `use:tip` 的控件已经有悬浮气泡，
 *    底栏再抄一遍就是两处一模一样的字（而且气泡能换行、底栏不能，抄过去只会更糟）。
 * 3. **场景**（`sceneHint`）—— 没指着任何东西时按状态说「下一步做什么」：
 *    空时间轴、没有选中、框选了一片、排版页里选中了几个元素、正在播放。
 *
 * 这个模块**不 import appState、不碰响应式**：状态快照由调用方（StatusBar）组装成
 * `HintContext` 传进来。两个理由：纯函数可以单测；而 `timeline/drag.ts` /
 * `timeline/marquee.ts` 也要用它的类型与常量，手势代码不该把 appState
 * （连带渲染器、导出器整棵树）拖进自己的模块图。
 */
import type { MessageKey } from '../i18n/locales';
import type { MessageVars } from '../i18n/format';
import type { ClipEditorKind } from './clip-editor';
import { shortcutOf, type Shortcut } from './shortcuts';

/** 提示里的一对「按键 + 它做什么」——就是快捷键清单里的一行，不另立一份表。 */
export type HintAction = Shortcut;

/** 一条底栏提示。`text` 与 `actions` 至少要有一样（都没有 = 这一层没提示）。 */
export interface Hint {
  /** 说明句（可省略 —— 只有按键列的提示是常态）。 */
  text?: MessageKey;
  /** 说明句的占位符参数。 */
  vars?: MessageVars;
  actions?: readonly HintAction[];
}

/**
 * 指针下的时间轴目标。
 *
 * 解析在 `Timeline.svelte` 的委托处理器里（`data-clip-id` → 片段，
 * `data-hint` → 标尺 / 轨道行 / 轨道头），这里只认结果。
 */
export type HintTarget =
  /**
   * `editor` = 这个片段双击会进哪个子界面（`ui/clip-editor.ts` 的判据）。
   * 由 Timeline 在解析目标时一起算出来 —— 悬停层要说准「双击进调色」还是
   * 「双击进排版」，只说「打开片段编辑器」等于什么都没说。
   */
  | { kind: 'clip'; id: string; editor: ClipEditorKind | null }
  | { kind: 'rows' }
  | { kind: 'ruler' }
  | { kind: 'track' }
  /** 排版编辑器的关键帧时间轴：轨道区（拖动 = 框选）。 */
  | { kind: 'kf' }
  /** 同上，标尺（拖动 = 播放头）。 */
  | { kind: 'kfRuler' };

/**
 * 当前页面。
 *
 * `grade` 是调色页：它没有时间轴，所以**一条时间轴提示都不该出现**
 * （`sceneHint` 对它返回 null，悬停提示在 `view !== 'timeline'` 时已经短路）。
 */
export type HintView = 'timeline' | 'typography' | 'grade';

/** 场景快照。全是**值**，不是 store —— 纯函数才好测。 */
export interface HintContext {
  /** 当前页面。两边的「能做什么」没有交集，所以它是第一分支。 */
  view: HintView;
  /** 时间轴上的片段总数（0 = 空时间轴，该提示「怎么开始」）。 */
  clipCount: number;
  /** 时间轴选中集。悬停要用它：同一个片段，选中与没选中的提示不同。 */
  selectedIds: readonly string[];
  /** 选中集**恰好一个**时，那个片段双击会进的子界面（否则 null）。 */
  selectedEditor: ClipEditorKind | null;
  /** 排版页选中元素数。 */
  typoSelectedCount: number;
  playing: boolean;
  /** 当前「操作习惯」下的切分键。提示必须说**当前生效**的那个键。 */
  splitKey: MessageKey;
}

/**
 * 比较键：Timeline 的 pointerover 每次过滤都会调它，挡住「同一目标重复写 $state」。
 *
 * 片段要把 `editor` 也算进来：给片段加上 / 删掉 grade 模块时指针不动，
 * 但底栏那句话必须从「打开片段编辑器」变成「双击 编辑调色」。
 */
export function targetKey(target: HintTarget): string {
  return target.kind === 'clip' ? `clip:${target.id}:${target.editor ?? '-'}` : target.kind;
}

/** 取第一个「真的有内容」的层。空对象（既没 text 也没 actions）不算数。 */
export function pickHint(layers: readonly (Hint | null | undefined)[]): Hint | null {
  for (const layer of layers) {
    if (layer && (layer.text || layer.actions?.length)) return layer;
  }
  return null;
}

/* ------------------------------------------------------------ 手势层 */

/** 手势提示的收尾角标：拖拽 / 框选的 Esc 语义一致（中止并回到按下那一刻）。 */
const ESC_CANCEL: HintAction = { keysKey: 'sc.key.esc', labelKey: 'hint.cancel' };

/**
 * 手势层**只有三项**（拖片段 / 框选 / 落点被拒），而且都由这里构造 ——
 * 文案与角标集中在一处，`tests/unit/hints.test.ts` 的全矩阵才盖得住它们。
 * 上面那条 `ESC_CANCEL` 必须先于 `ILLEGAL_DROP_HINT` 声明（模块加载即求值）。
 */

/** 拖片段（`move=false` = 拖边缩放）。只在指针真的动过之后写进底栏。 */
export function dragHint(move: boolean): Hint {
  return {
    actions: [
      move
        ? { keysKey: 'sc.key.drag', labelKey: 'sc.moveClip' }
        : { keysKey: 'sc.key.dragEdge', labelKey: 'sc.resizeClip' },
      ESC_CANCEL,
    ],
  };
}

/**
 * 落点被拒收（reject 策略下片段描红框）。
 *
 * 红框只说明「不行」，而用户真正要知道的是**松手之后它会回到原位** ——
 * 少了这句话，「拖过去弹回来」看起来就像界面卡了一下。
 */
export const ILLEGAL_DROP_HINT: Hint = {
  text: 'hint.illegalDrop',
  actions: [ESC_CANCEL],
};

/** 框选进行中：报「框里已经有多少个」。框 0 个时不能报「框选中 0 个片段」。 */
export function marqueeHint(count: number): Hint {
  return count > 0
    ? { text: 'hint.marquee', vars: { n: count }, actions: [ESC_CANCEL] }
    : { text: 'hint.marqueeNone', actions: [ESC_CANCEL] };
}

/* ------------------------------------------------------------ 悬停层 */

/**
 * 切分动作的按键**随方案变**（S / Ctrl+K / Ctrl+Shift+D / Ctrl+B，见 shortcuts.ts）。
 * 底栏在这里说错键比什么都不说更坏 —— 它是唯一"教按键"的地方。
 */
const splitAction = (keysKey: MessageKey): HintAction => ({ keysKey, labelKey: 'sc.splitAtPlayhead' });

/**
 * 双击这一下的**具体后果**。
 *
 * 没有独立页面时说泛泛的「打开片段编辑器」；能进调色 / 排版时把目标说出来 ——
 * 「双击 编辑调色」是用户唯一能发现这条通路的文字提示（片段上那颗图标只说
 * 「这里有个编辑器」，不说是什么）。
 */
function editorAction(editor: ClipEditorKind | null): HintAction {
  if (!editor) return shortcutOf('sc.openClipEditor');
  return {
    keysKey: 'sc.key.dblClick',
    labelKey: editor === 'grade' ? 'insp.editGrade' : 'insp.editTypography',
  };
}

/**
 * 悬停层：指针下的目标能做什么。null = 这个目标没有可说的（保持场景层）。
 *
 * 片段分「选中 / 没选中」两套是**刻意的**：F2 / S / Del 只作用于选中片段，
 * 在一个没选中的片段上说「F2 重命名」是假话 —— 按下去改的是另一个片段。
 */
export function hoverHint(target: HintTarget | null, ctx: HintContext): Hint | null {
  /*
   * 时间轴的目标只在时间轴视图里成立。
   *
   * 必须显式判 `view`，不能只判 target 有没有值：双击片段开排版页时，主界面是
   * `display:none`（**不卸载**，见 App.svelte），而浏览器不会为隐藏的元素补
   * `pointerleave` —— 指针「还挂在」一个已经看不见的片段上。少这一句，排版页的
   * 底栏会一直报「F2 重命名 / Del 删除」，而那边根本没有片段这个概念。
   */
  if (!target) return null;
  // 关键帧时间轴反过来：它只在排版页存在。轨道与标尺是两套手势，别混说。
  if (target.kind === 'kf') return ctx.view === 'typography' ? KF_HINT : null;
  if (target.kind === 'kfRuler') return ctx.view === 'typography' ? KF_RULER_HINT : null;
  if (ctx.view !== 'timeline') return null;
  switch (target.kind) {
    case 'clip': {
      if (!ctx.selectedIds.includes(target.id)) {
        // 没选中：只说**鼠标手势**（这些都即时生效，不需要先选中）
        return {
          actions: [
            shortcutOf('sc.moveClip'),
            shortcutOf('sc.resizeClip'),
            editorAction(target.editor),
          ],
        };
      }
      /*
       * 选中后满四条。能进子界面时**让「移动」让位**：拖动是这个片段上最直白
       * 的手势（片段摆在那儿就是拿来挪的），而「双击进调色 / 排版」是唯一
       * 没有别的文字出口的动作 —— 底栏不说，用户就只能靠猜。
       */
      return {
        actions: [
          ...(target.editor
            ? [editorAction(target.editor)]
            : [shortcutOf('sc.moveClip')]),
          splitAction(ctx.splitKey),
          shortcutOf('sc.renameClip'),
          shortcutOf('sc.deleteClip'),
        ],
      };
    }
    case 'rows':
      return ROWS_HINT;
    case 'ruler':
      return RULER_HINT;
    case 'track':
      return TRACK_HINT;
  }
}

/**
 * 关键帧轨道区：拖动 = **框选**（与片段编辑器一致，不是擦洗），双击补帧。
 *
 * 「双击加帧」原来写在面板顶栏里，那是**位置固定的说明文字** —— 一条只在
 * 指针真的落在轨道上时才成立的操作提示，属于底栏。
 */
const KF_HINT: Hint = {
  text: 'typo.kfAddKeyHint',
  actions: [
    { keysKey: 'sc.key.dragEmpty', labelKey: 'typo.kfMarquee' },
    { keysKey: 'sc.key.ctrlWheel', labelKey: 'hint.zoomTimeline' },
  ],
};

/** 关键帧标尺：拖动 = 播放头（与片段编辑器的标尺同一套手势）。 */
const KF_RULER_HINT: Hint = {
  actions: [
    shortcutOf('sc.scrub'),
    { keysKey: 'sc.key.ctrlWheel', labelKey: 'hint.zoomTimeline' },
  ],
};

/** 轨道行空白。三件事按「最可能想做的」排：框选 → 新建 → 拖文件进来。 */
const ROWS_HINT: Hint = {
  actions: [
    { keysKey: 'sc.key.dragEmpty', labelKey: 'hint.marqueeClips' },
    shortcutOf('sc.newClipAtCursor'),
    { keysKey: 'hint.key.dropFile', labelKey: 'hint.newClip' },
  ],
};

/** 标尺：擦洗与缩放。滚轮横向滚动刻意不列 —— 它是所有滚动区的默认行为，不需要教。 */
const RULER_HINT: Hint = {
  actions: [
    shortcutOf('sc.scrub'),
    { keysKey: 'sc.key.ctrlWheel', labelKey: 'hint.zoomTimeline' },
  ],
};

/**
 * 轨道头（左侧栏那一行）。
 *
 * 三条都**没有**别的出口：行内那两个开关按钮自己带 tooltip（不列），
 * 而「拖动排序」「双击名改名」「右键菜单」原来只存在于别人的记忆里。
 */
const TRACK_HINT: Hint = {
  actions: [
    { keysKey: 'sc.key.drag', labelKey: 'tl.moveTrack' },
    { keysKey: 'hint.key.dblTrackName', labelKey: 'tl.renameTrack' },
    { keysKey: 'sc.key.rightClick', labelKey: 'tl.trackMenu' },
  ],
};

/* ------------------------------------------------------------ 场景层 */

/** 播放中顶在最前面的一条（其余内容照旧跟在后面）。 */
const PAUSE_ACTION: HintAction = { keysKey: 'sc.key.space', labelKey: 'hint.pause' };

/**
 * 场景层：没指着任何东西时，「下一步该做什么」。
 *
 * 共同纪律：**一条提示最多四件事**（含播放中前置的那个暂停角标）。底栏是一行，
 * 右边还有 fps 与播放时间；列成待办清单的结果是把几件事一起挤成省略号
 * （等于一件也没说）。`tests/unit/hints.test.ts` 按这条上限守着全矩阵。
 */
export function sceneHint(ctx: HintContext): Hint | null {
  // 调色页：底栏那片留给工具条里的分级读数（`GradeInfo`），这里不再多说一句。
  if (ctx.view === 'grade') return null;
  const base = ctx.view === 'typography' ? typoScene(ctx) : timelineScene(ctx);
  if (!base) return null;
  // 播放中：此刻最想要的动作是「停下来」，所以前置一个空格键角标。
  return ctx.playing ? { ...base, actions: [PAUSE_ACTION, ...(base.actions ?? [])] } : base;
}

function timelineScene(ctx: HintContext): Hint {
  /*
   * 空时间轴 —— 这里就是 Blender 在空场景里报「Shift+A 新建物体」的那个位置。
   *
   * 只说**一件事**：右键新建片段。素材相关的入口（媒体池、从系统拖文件）
   * 都挂在鼠标真正会经过的地方（轨道行的悬停提示），这里列出来反而没人读。
   */
  if (ctx.clipCount === 0) {
    return { actions: [shortcutOf('sc.newClipAtCursor')] };
  }
  if (ctx.selectedIds.length === 0) {
    return {
      actions: [
        { keysKey: 'sc.key.dragEmpty', labelKey: 'hint.marqueeClips' },
        shortcutOf('sc.playPause'),
      ],
    };
  }
  if (ctx.selectedIds.length === 1) {
    return {
      // 选中一个可进子界面的片段时，把「双击进哪里」顶到最前面（指针可能已经在别处）。
      actions: [
        ...(ctx.selectedEditor ? [editorAction(ctx.selectedEditor)] : []),
        splitAction(ctx.splitKey),
        shortcutOf('sc.renameClip'),
        shortcutOf('sc.deleteClip'),
      ],
    };
  }
  // 多个：**整组移动**与批量删除是框选之后唯一的两件事（切分只作用于主选中）。
  return {
    text: 'hint.selectedClips',
    vars: { n: ctx.selectedIds.length },
    actions: [
      { keysKey: 'sc.key.dragSelection', labelKey: 'hint.moveGroup' },
      shortcutOf('sc.deleteClip'),
    ],
  };
}

function typoScene(ctx: HintContext): Hint {
  if (ctx.typoSelectedCount === 0) {
    return {
      actions: [shortcutOf('sc.selectElement'), shortcutOf('sc.marquee'), shortcutOf('sc.selectAll')],
    };
  }
  return {
    text: 'hint.selectedElements',
    vars: { n: ctx.typoSelectedCount },
    actions: [
      { keysKey: 'sc.key.dragElement', labelKey: 'hint.moveElement' },
      { keysKey: 'sc.key.arrows', labelKey: 'hint.nudge' },
      shortcutOf('sc.deselect'),
    ],
  };
}
