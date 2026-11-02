import { describe, expect, it } from 'vitest';
import {
  dragHint,
  hoverHint,
  ILLEGAL_DROP_HINT,
  marqueeHint,
  pickHint,
  sceneHint,
  type Hint,
  type HintContext,
  type HintTarget,
} from '../../src/ui/hints';
import { placeholdersOf } from '../../src/i18n/format';
import { tr } from '../../src/i18n/index.svelte';
import { splitKeysKeyOf } from '../../src/ui/shortcuts';
import type { MessageKey } from '../../src/i18n/locales';

/* ------------------------------------------------------------ 测试工具 */

/** 一条提示里用到的全部文案键（说明句 + 每对「键 / 说明」）。 */
function keysOf(hint: Hint): string[] {
  const out: string[] = [];
  if (hint.text) out.push(hint.text);
  for (const a of hint.actions ?? []) out.push(a.keysKey, a.labelKey);
  return out;
}

/** 提示里每对「键 + 说明」的**说明键**——用来判「这条提示有没有讲某件事」。 */
function labelsOf(hint: Hint | null): string[] {
  return (hint?.actions ?? []).map((a) => a.labelKey);
}

const base: HintContext = {
  view: 'timeline',
  clipCount: 6,
  selectedIds: [],
  typoSelectedCount: 0,
  playing: false,
  splitKey: splitKeysKeyOf('artmatic'),
};

/** 全部有代表性的场景快照。下面「全矩阵」那几条守卫都跑在它上面。 */
const CONTEXTS: readonly HintContext[] = [
  base,
  { ...base, clipCount: 0 },
  { ...base, selectedIds: ['a'] },
  { ...base, selectedIds: ['a', 'b'] },
  { ...base, playing: true },
  { ...base, playing: true, selectedIds: ['a', 'b'] },
  { ...base, splitKey: splitKeysKeyOf('premiere') },
  { ...base, view: 'typography' },
  { ...base, view: 'typography', selectedIds: ['a'] },
  { ...base, view: 'typography', typoSelectedCount: 3 },
  // 调色页：没有时间轴，所以场景层与悬停层都该闭嘴（否则底栏会教人按 S 切分）。
  { ...base, view: 'grade' },
  { ...base, view: 'grade', selectedIds: ['a'] },
];

const TARGETS: readonly HintTarget[] = [
  { kind: 'clip', id: 'a' },
  { kind: 'clip', id: 'zz' },
  { kind: 'rows' },
  { kind: 'ruler' },
  { kind: 'track' },
];

/* --------------------------------------------------------------- 优先级 */

describe('pickHint', () => {
  it('取第一层非空的（手势压悬停、悬停压场景）', () => {
    const first: Hint = { text: 'hint.pause' };
    const second: Hint = { actions: [{ keysKey: 'sc.key.s', labelKey: 'sc.moveClip' }] };
    expect(pickHint([first, second])).toBe(first);
    expect(pickHint([null, second])).toBe(second);
  });

  it('空对象（既没说明句也没角标）不算一层', () => {
    expect(pickHint([null, {}, undefined])).toBeNull();
    expect(pickHint([{}, { text: 'hint.pause' }])?.text).toBe('hint.pause');
  });

  it('一片空白返回 null —— 底栏这一段整个不渲染，而不是显示一句废话', () => {
    expect(pickHint([null, undefined])).toBeNull();
    expect(hoverHint(null, base)).toBeNull();
  });
});

/* ----------------------------------------------------------- 空时间轴 */

describe('场景：空时间轴', () => {
  it('报的是「怎么开始」——右键新建片段（Blender 在空场景里报 Shift+A 的那个位置）', () => {
    const h = sceneHint({ ...base, clipCount: 0 });
    expect(labelsOf(h)).toContain('sc.newClipAtCursor');
  });

  it('不报选中集相关的动作（那时没有任何东西可选中）', () => {
    const labels = labelsOf(sceneHint({ ...base, clipCount: 0 }));
    expect(labels).not.toContain('sc.deleteClip');
    expect(labels).not.toContain('sc.splitAtPlayhead');
    expect(labels).not.toContain('hint.moveGroup');
  });
});

/* --------------------------------------------------------------- 悬停 */

describe('悬停：片段', () => {
  it('没选中时不报 F2 / S / Del —— 它们作用于**选中**的那个片段，说了就是假话', () => {
    const h = hoverHint({ kind: 'clip', id: 'a' }, { ...base, selectedIds: ['b'] });
    const labels = labelsOf(h);
    expect(labels).not.toContain('sc.renameClip');
    expect(labels).not.toContain('sc.splitAtPlayhead');
    expect(labels).not.toContain('sc.deleteClip');
    // 但鼠标手势照报（拖动 / 拖边 / 双击，不需要先选中）
    expect(labels).toContain('sc.moveClip');
    expect(labels).toContain('sc.openClipEditor');
  });

  it('选中后报的是键盘动作，且切分键是**当前方案**的那个', () => {
    const h = hoverHint({ kind: 'clip', id: 'a' }, { ...base, selectedIds: ['a'] });
    expect(labelsOf(h)).toEqual([
      'sc.moveClip',
      'sc.splitAtPlayhead',
      'sc.renameClip',
      'sc.deleteClip',
    ]);
    expect(keysOf(h!)).toContain('sc.key.s');

    const alt = hoverHint(
      { kind: 'clip', id: 'a' },
      { ...base, selectedIds: ['a'], splitKey: splitKeysKeyOf('premiere') },
    );
    expect(keysOf(alt!)).toContain('sc.key.ctrlK');
    expect(keysOf(alt!)).not.toContain('sc.key.s');
  });
});

describe('悬停：其它目标', () => {
  it('轨道行空白：框选 + 新建 + 拖入文件', () => {
    expect(labelsOf(hoverHint({ kind: 'rows' }, base))).toEqual([
      'hint.marqueeClips',
      'sc.newClipAtCursor',
      'hint.newClip',
    ]);
  });

  it('标尺：擦洗与缩放', () => {
    expect(labelsOf(hoverHint({ kind: 'ruler' }, base))).toEqual(['sc.scrub', 'hint.zoomTimeline']);
  });

  it('排版页里时间轴的目标一律不算数（切页时指针会「挂」在看不见的片段上）', () => {
    const ctx = { ...base, view: 'typography' as const };
    expect(hoverHint({ kind: 'clip', id: 'a' }, ctx)).toBeNull();
    expect(hoverHint({ kind: 'rows' }, ctx)).toBeNull();
    expect(hoverHint({ kind: 'track' }, ctx)).toBeNull();
  });

  it('关键帧：轨道上拖动 = 框选，标尺上拖动 = 播放头（与片段编辑器同一套手势）', () => {
    const typo = { ...base, view: 'typography' as const };
    const lanes = hoverHint({ kind: 'kf' }, typo);
    expect(lanes?.text).toBe('typo.kfAddKeyHint');
    expect(labelsOf(lanes)).toEqual(['typo.kfMarquee', 'hint.zoomTimeline']);
    expect(keysOf(lanes!)).not.toContain('sc.key.rulerDrag');

    const ruler = hoverHint({ kind: 'kfRuler' }, typo);
    expect(labelsOf(ruler)).toEqual(['sc.scrub', 'hint.zoomTimeline']);
    expect(keysOf(ruler!)).toContain('sc.key.rulerDrag');

    // 只在排版页成立（时间轴视图里没有这块面板）。
    expect(hoverHint({ kind: 'kf' }, base)).toBeNull();
    expect(hoverHint({ kind: 'kfRuler' }, base)).toBeNull();
  });

  it('轨道头：排序 / 改名 / 菜单（三条都没有别的出口）', () => {
    expect(labelsOf(hoverHint({ kind: 'track' }, base))).toEqual([
      'tl.moveTrack',
      'tl.renameTrack',
      'tl.trackMenu',
    ]);
  });
});

/* --------------------------------------------------------------- 场景 */

describe('场景：时间轴选中集', () => {
  it('选中一个：切分 / 改名 / 删除', () => {
    expect(labelsOf(sceneHint({ ...base, selectedIds: ['a'] }))).toEqual([
      'sc.splitAtPlayhead',
      'sc.renameClip',
      'sc.deleteClip',
    ]);
  });

  it('选中多个：先报个数，再报「只有框选才成立」的两件事', () => {
    const h = sceneHint({ ...base, selectedIds: ['a', 'b', 'c'] });
    expect(h?.text).toBe('hint.selectedClips');
    expect(h?.vars).toEqual({ n: 3 });
    expect(labelsOf(h)).toEqual(['hint.moveGroup', 'sc.deleteClip']);
  });

  it('没选中：框选与播放', () => {
    expect(labelsOf(sceneHint(base))).toEqual(['hint.marqueeClips', 'sc.playPause']);
  });

  it('播放中：第一条是「暂停」（此刻最想做的事），其余照旧跟在后面', () => {
    const h = sceneHint({ ...base, playing: true, selectedIds: ['a'] });
    expect(labelsOf(h)[0]).toBe('hint.pause');
    expect(labelsOf(h)).toContain('sc.splitAtPlayhead');
  });
});

describe('场景：排版编辑页', () => {
  it('没选元素：选中 / 框选 / 全选', () => {
    expect(labelsOf(sceneHint({ ...base, view: 'typography' }))).toEqual([
      'sc.selectElement',
      'sc.marquee',
      'sc.selectAll',
    ]);
  });

  it('选了元素：报个数 + 移动 / 微调 / 取消选择', () => {
    const h = sceneHint({ ...base, view: 'typography', typoSelectedCount: 2 });
    expect(h?.text).toBe('hint.selectedElements');
    expect(h?.vars).toEqual({ n: 2 });
    expect(labelsOf(h)).toEqual(['hint.moveElement', 'hint.nudge', 'sc.deselect']);
  });

  it('排版页不报时间轴的快捷键（S 切分在这边没有意义）', () => {
    const labels = labelsOf(sceneHint({ ...base, view: 'typography', selectedIds: ['a'] }));
    expect(labels).not.toContain('sc.splitAtPlayhead');
    expect(labels).not.toContain('sc.deleteClip');
  });
});

/* --------------------------------------------------------------- 全矩阵守卫 */

describe('手势：框选', () => {
  it('框里一个都没有时不报「框选中 0 个片段」——那是计数，不是话', () => {
    const h = marqueeHint(0);
    expect(h.text).toBe('hint.marqueeNone');
    expect(h.vars).toBeUndefined();
  });

  it('框住几个就报几个', () => {
    const h = marqueeHint(3);
    expect(h.text).toBe('hint.marquee');
    expect(h.vars).toEqual({ n: 3 });
  });
});

describe('提示表自检', () => {
  /** 三层里所有提示（手势 / 悬停 × 每个目标 / 场景 × 每个快照）。 */
  function allHints(): { where: string; hint: Hint }[] {
    const out: { where: string; hint: Hint }[] = [
      { where: 'gesture(drag)', hint: dragHint(true) },
      { where: 'gesture(resize)', hint: dragHint(false) },
      { where: 'gesture(illegalDrop)', hint: ILLEGAL_DROP_HINT },
      { where: 'gesture(marquee=0)', hint: marqueeHint(0) },
      { where: 'gesture(marquee=3)', hint: marqueeHint(3) },
    ];
    for (const ctx of CONTEXTS) {
      const scene = sceneHint(ctx);
      if (scene) out.push({ where: `scene(${ctx.view})`, hint: scene });
      for (const target of TARGETS) {
        const h = hoverHint(target, ctx);
        if (h) out.push({ where: `hover(${target.kind})`, hint: h });
      }
    }
    return out;
  }

  it('每条文案键都真的在语言表里（写错的表现是底栏直接把键名画出来）', () => {
    for (const { where, hint } of allHints()) {
      for (const key of keysOf(hint)) {
        expect(tr(key as MessageKey), `${where}: ${key}`).not.toBe(key);
      }
    }
  });

  it('说明句里的占位符都带了参数（否则底栏显示成「已选 {n} 个片段」）', () => {
    for (const { where, hint } of allHints()) {
      if (!hint.text) continue;
      const need = placeholdersOf(tr(hint.text));
      for (const name of need) {
        expect(hint.vars?.[name], `${where}: ${hint.text} 缺 {${name}}`).toBeDefined();
      }
    }
  });

  it('同一条提示里没有重复的角标（重复 = 同一件事写了两遍）', () => {
    for (const { where, hint } of allHints()) {
      const labels = labelsOf(hint);
      expect(new Set(labels).size, `${where}: ${labels.join(' / ')}`).toBe(labels.length);
    }
  });

  it('一条提示最多四件事：底栏只有一行，右边还压着 fps 与时间', () => {
    // 4 = 「播放中多压一个暂停角标」之后仍然放得下的上限（实测约 480px）。
    // 突破它就该先想清楚：底栏不是待办清单，多出来的那条会挤掉后面的。
    for (const { where, hint } of allHints()) {
      expect(hint.actions?.length ?? 0, where).toBeLessThanOrEqual(4);
    }
  });
});
