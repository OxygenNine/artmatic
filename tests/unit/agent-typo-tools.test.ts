/**
 * 排版工具面的集成守卫（一次性反馈里的 1 / 2 / 4 / 5 / 6）。
 *
 * 用真的 `ProjectStore` + 真的控制平面：这几条要守的恰恰是「写入怎么落库、
 * 返回什么、撤销栈怎么记」——拿替身测等于把被测对象换掉。渲染 / DOM 在
 * Node 里不存在，所以 `typo_measure` 走估算分支（`estimated:true`），
 * 这也是它必须如实标注的原因。
 */

import { describe, expect, it } from 'vitest';
import { createControlPlane, type AgentControlPlane } from '../../src/agent/control-plane';
import type { ControlContext, ControlResult } from '../../src/agent/types';
import { ProjectStore } from '../../src/core/project-store';
import { createBlankProject } from '../../src/core/demo-project';
import type { Project } from '../../src/core/schema';

interface Harness {
  store: ProjectStore;
  cp: AgentControlPlane;
}

function harness(project: Project = createBlankProject('typo-tools')): Harness {
  const store = new ProjectStore(project);
  const ctx: ControlContext = {
    getStore: () => store,
    getRenderer: () => null,
    getAssets: () => null,
    getPlayT: () => 0,
    setPlayT: () => {},
    getAudioBuffer: () => null,
    listProjects: () => [],
    saveProject: async () => false,
    openProject: async () => false,
    cancelPendingGesture: () => {},
    refreshPreview: () => {},
  };
  return { store, cp: createControlPlane(ctx) };
}

async function ok<T>(p: Promise<ControlResult<T>>): Promise<T> {
  const r = await p;
  if (!r.ok) throw new Error(`期望成功，实际失败：${r.error.code} / ${r.error.message}`);
  return r.data;
}

async function code<T>(p: Promise<ControlResult<T>>): Promise<string> {
  const r = await p;
  if (r.ok) throw new Error(`期望失败，实际成功：${JSON.stringify(r.data)}`);
  return r.error.code;
}

/** 建一个文本片段，返回 clipId。 */
async function textClip(h: Harness): Promise<string> {
  const track = h.store.project.tracks.find((t) => t.kind === 'visual');
  if (!track) throw new Error('空白工程应当有一条视觉轨');
  const r = await ok(h.cp.addClip(track.id, { kind: 'text', start: 0, end: 4 }));
  return r.clipId;
}

describe('排版批量写', () => {
  it('typo_add_elements：一次调用一笔撤销，数组顺序即 z 序，回显落库值', async () => {
    const h = harness();
    const clipId = await textClip(h);

    const added = await ok(
      h.cp.addTypographyElements(clipId, [
        { kind: 'text', text: 'BODY', frame: { x: 100, y: 100, w: 260, h: 24 }, style: { fontSize: 20 } },
        {
          kind: 'shape',
          shape: 'frame',
          frame: { x: 60, y: 60, w: 400, h: 300 },
          stroke: { color: '#ffffff', width: 2 },
        },
        { kind: 'text', text: 'TITLE', frame: { x: 120, y: 110, w: 240, h: 40 }, style: { fontSize: 28 } },
      ]),
    );

    expect(added.elementIds).toHaveLength(3);
    expect(added.elements).toHaveLength(3);
    // 1) 形状给了 stroke 没给 fill ⇒ none；2) 顺序即 z 序。
    expect((added.elements[1] as { fill?: unknown }).fill).toEqual({ kind: 'none' });
    expect(added.elements.map((e) => e.id)).toEqual(added.elementIds);

    const doc = await ok(h.cp.getTypographyDoc(clipId, 'ids'));
    expect(doc.elements.map((e) => e.id)).toEqual(added.elementIds);
    expect(h.store.canUndo()).toBe(true);

    // 一笔撤销回到「空文档」，片段本身还在 —— 批量写只占一条记录。
    await ok(h.cp.undo());
    const afterUndo = await ok(h.cp.getTypographyDoc(clipId, 'ids'));
    expect(afterUndo.elements).toHaveLength(0);
    expect(h.store.findClip(clipId)).not.toBeNull();
  });

  it('typo_update_elements：全部 id 先校验，回显改后的元素', async () => {
    const h = harness();
    const clipId = await textClip(h);
    const added = await ok(
      h.cp.addTypographyElements(clipId, [
        { kind: 'text', text: 'ONE', frame: { x: 0, y: 0, w: 200, h: 40 } },
        { kind: 'text', text: 'TWO', frame: { x: 0, y: 80, w: 200, h: 40 } },
      ]),
    );
    const [a, b] = added.elementIds as [string, string];

    const updated = await ok(
      h.cp.updateTypographyElements(clipId, [
        { elementId: a, patch: { frame: { h: 200 }, opacity: 0.5 } },
        { elementId: b, patch: { name: 'renamed' } },
      ]),
    );
    expect(updated.changed).toBe(2);
    expect(updated.elements[0]!.frame.h).toBe(200);
    expect(updated.elements[0]!.opacity).toBe(0.5);
    expect(updated.elements[1]!.name).toBe('renamed');

    // 一个坏 id 让整次调用在写入之前失败。
    const before = JSON.stringify(h.store.project);
    expect(
      await code(
        h.cp.updateTypographyElements(clipId, [
          { elementId: a, patch: { opacity: 1 } },
          { elementId: 'missing', patch: { opacity: 1 } },
        ]),
      ),
    ).toBe('not-found');
    expect(JSON.stringify(h.store.project)).toBe(before);
  });
});

describe('typo_measure', () => {
  it('给出文字溢出、相交与出画，并且纯读（不动版本）', async () => {
    const h = harness();
    const clipId = await textClip(h);
    const canvas = (await ok(h.cp.getTypographyDoc(clipId, 'ids'))).size;
    const added = await ok(
      h.cp.addTypographyElements(clipId, [
        // 长文 + 很矮的框：估算必然溢出。
        {
          kind: 'text',
          text: 'THE QUICK BROWN FOX JUMPS OVER THE LAZY DOG AND KEEPS RUNNING',
          frame: { x: 100, y: 100, w: 220, h: 20 },
          style: { fontSize: 20 },
        },
        // 与上一块相交。
        { kind: 'shape', shape: 'rect', frame: { x: 150, y: 110, w: 120, h: 120 } },
        // 出画：右边超出画布 180px。
        { kind: 'shape', shape: 'rect', frame: { x: canvas.w - 20, y: 0, w: 200, h: 100 } },
      ]),
    );
    const [body, overlap, outside] = added.elementIds as [string, string, string];

    const v0 = h.store.version;
    const before = JSON.stringify(h.store.project);
    const m = await ok(h.cp.measureTypography(clipId));
    expect(h.store.version).toBe(v0);
    expect(JSON.stringify(h.store.project)).toBe(before);

    expect(m.summary.elements).toBe(3);
    expect(m.summary.textOverflow).toContain(body);
    expect(m.summary.outside).toContain(outside);
    expect(m.summary.overlapPairs).toBeGreaterThan(0);
    expect(m.overlaps.some((p) => (p.a === body && p.b === overlap) || (p.a === overlap && p.b === body))).toBe(true);

    const text = m.elements.find((e) => e.id === body);
    expect(text?.text?.estimated).toBe(true);
    expect(text?.text?.overflowY).toBeGreaterThan(0);

    // 过滤 + 未知 id。
    const only = await ok(h.cp.measureTypography(clipId, [body]));
    expect(only.elements.map((e) => e.id)).toEqual([body]);
    expect(await code(h.cp.measureTypography(clipId, ['missing']))).toBe('not-found');
  });
});

describe('sceneVersion', () => {
  it('内容变化才让版本前进（给重复调用判据用）', async () => {
    const h = harness();
    const v0 = await ok(h.cp.sceneVersion());
    expect(v0.version).toBe(h.store.version);

    const clipId = await textClip(h);
    const v1 = await ok(h.cp.sceneVersion());
    expect(v1.version).toBeGreaterThan(v0.version);

    await ok(h.cp.addTypographyElement(clipId, { kind: 'text', text: 'x' }));
    const v2 = await ok(h.cp.sceneVersion());
    expect(v2.version).toBeGreaterThan(v1.version);

    // 纯读不推进版本。
    await ok(h.cp.getTypographyDoc(clipId, 'ids'));
    expect((await ok(h.cp.sceneVersion())).version).toBe(v2.version);
  });
});

/* ------------------------------------------------------------ 镜头与深度 */

describe('镜头（typo_set_camera）与元素景深', () => {
  it('镜头按出现的键合并，复位 = 删字段；都是一笔撤销', async () => {
    const h = harness();
    const clipId = await textClip(h);

    const a = await ok(h.cp.setTypographyCamera(clipId, { zoom: 1.6 }));
    expect(a.camera).toEqual({ x: 0, y: 0, zoom: 1.6, rot: 0 });

    // 只给 x —— zoom 必须保留（补默认值会把「只改一个键」变成「重置整份」）。
    const b = await ok(h.cp.setTypographyCamera(clipId, { x: 40 }));
    expect(b.camera).toEqual({ x: 40, y: 0, zoom: 1.6, rot: 0 });

    // 复位：字段整个删掉，读回不再给 camera。
    const reset = await ok(h.cp.setTypographyCamera(clipId, null));
    expect(reset.camera).toBeNull();
    const doc = await ok(h.cp.getTypographyDoc(clipId, 'full'));
    expect((doc as { camera?: unknown }).camera).toBeUndefined();

    await ok(h.cp.undo());
    expect((await ok(h.cp.getTypographyDoc(clipId, 'full')) as { camera?: unknown }).camera).toEqual({
      x: 40,
      y: 0,
      zoom: 1.6,
      rot: 0,
    });
  });

  it('形状不对报 invalid-argument（不静默当复位）', async () => {
    const h = harness();
    const clipId = await textClip(h);
    expect(await code(h.cp.setTypographyCamera(clipId, 'zoom'))).toBe('invalid-argument');
    expect(await code(h.cp.setTypographyCamera(clipId, 3))).toBe('invalid-argument');
  });

  it('depth 走 typo_update_element，回显成 0..1；null 删字段', async () => {
    const h = harness();
    const clipId = await textClip(h);
    const el = await ok(h.cp.addTypographyElement(clipId, { kind: 'text', text: 'T' }));

    const set = await ok(h.cp.updateTypographyElement(clipId, el.elementId, { depth: 1 }));
    expect((set.element as { depth?: number }).depth).toBe(1);
    // 越界夹到 1。
    const clamped = await ok(h.cp.updateTypographyElement(clipId, el.elementId, { depth: 4 }));
    expect((clamped.element as { depth?: number }).depth).toBe(1);
    const cleared = await ok(h.cp.updateTypographyElement(clipId, el.elementId, { depth: null }));
    expect((cleared.element as { depth?: number }).depth).toBeUndefined();
  });

  it('typo_replace_doc 把 camera 与 depth 一起搬（读回形状可原样写回）', async () => {
    const h = harness();
    const clipId = await textClip(h);
    const el = await ok(h.cp.addTypographyElement(clipId, { kind: 'text', text: 'T' }));
    await ok(h.cp.updateTypographyElement(clipId, el.elementId, { depth: 0.6 }));
    await ok(h.cp.setTypographyCamera(clipId, { zoom: 1.4, rot: 12 }));

    const before = await ok(h.cp.getTypographyDoc(clipId, 'full'));
    await ok(h.cp.replaceTypographyDoc(clipId, before));
    const after = await ok(h.cp.getTypographyDoc(clipId, 'full'));
    expect((after as { camera?: unknown }).camera).toEqual({ x: 0, y: 0, zoom: 1.4, rot: 12 });
    expect((after.elements[0] as { depth?: number }).depth).toBe(0.6);
  });
});

describe('镜头关键帧（typo_set_camera_animation）', () => {
  it('整条通道覆盖写，读回在 cameraTracks；null / [] 删轨道', async () => {
    const h = harness();
    const clipId = await textClip(h);

    const w = await ok(h.cp.setTypographyCameraAnimation(clipId, 'zoom', [
      { t: 0, v: 1 },
      { t: 2, v: 2 },
    ]));
    expect(w.channel).toBe('zoom');
    expect(w.keys).toHaveLength(2);

    const full = (await ok(h.cp.getTypographyDoc(clipId, 'full'))) as {
      cameraTracks?: Record<string, unknown>;
    };
    expect(full.cameraTracks?.zoom).toEqual([
      { t: 0, v: 1 },
      { t: 2, v: 2 },
    ]);

    // 覆盖写：旧的两帧不留。
    await ok(h.cp.setTypographyCameraAnimation(clipId, 'zoom', [{ t: 1, v: 1.5 }]));
    const after = (await ok(h.cp.getTypographyDoc(clipId, 'full'))) as {
      cameraTracks?: Record<string, unknown>;
    };
    expect(after.cameraTracks?.zoom).toEqual([{ t: 1, v: 1.5 }]);

    // 删：读回不再给这个通道。
    await ok(h.cp.setTypographyCameraAnimation(clipId, 'zoom', null));
    const gone = (await ok(h.cp.getTypographyDoc(clipId, 'full'))) as {
      cameraTracks?: Record<string, unknown>;
    };
    expect(gone.cameraTracks).toBeUndefined();
  });

  it('通道名两种写法都收（zoom / camera.zoom）', async () => {
    const h = harness();
    const clipId = await textClip(h);
    const r = await ok(
      h.cp.setTypographyCameraAnimation(clipId, 'camera.rot', [{ t: 0, v: 15 }]),
    );
    expect(r.channel).toBe('rot');
  });

  it('通道 / 关键帧形状不对 = invalid-argument（不静默当成删轨道）', async () => {
    const h = harness();
    const clipId = await textClip(h);
    expect(await code(h.cp.setTypographyCameraAnimation(clipId, 'pan', [{ t: 0, v: 1 }]))).toBe(
      'invalid-argument',
    );
    expect(await code(h.cp.setTypographyCameraAnimation(clipId, 'zoom', 'nope'))).toBe(
      'invalid-argument',
    );
    expect(
      await code(h.cp.setTypographyCameraAnimation(clipId, 'zoom', [{ t: 'x', v: 1 }])),
    ).toBe('invalid-argument');
    // 一帧都不合法就不许写进去（半途失败会留下用户没见过的状态）。
    const doc = (await ok(h.cp.getTypographyDoc(clipId, 'full'))) as { cameraTracks?: unknown };
    expect(doc.cameraTracks).toBeUndefined();
  });

  it('typo_replace_doc 原样搬 cameraTracks', async () => {
    const h = harness();
    const clipId = await textClip(h);
    await ok(
      h.cp.setTypographyCameraAnimation(clipId, 'x', [
        { t: 0, v: -40, ease: 'ease-in-out' },
        { t: 1.5, v: 40 },
      ]),
    );
    const before = await ok(h.cp.getTypographyDoc(clipId, 'full'));
    await ok(h.cp.replaceTypographyDoc(clipId, before));
    const after = (await ok(h.cp.getTypographyDoc(clipId, 'full'))) as {
      cameraTracks?: Record<string, unknown>;
    };
    expect(after.cameraTracks?.x).toEqual([
      { t: 0, v: -40, ease: 'ease-in-out' },
      { t: 1.5, v: 40 },
    ]);
  });
});

/* ------------------------------------------------ 元素动画（Agent 反馈 10） */

describe('元素动画', () => {
  it('预设动画落库成结构化轨道，读回时给完整字段（不是只有 kind+duration）', async () => {
    const h = harness();
    const clipId = await textClip(h);
    const el = await ok(h.cp.addTypographyElement(clipId, { kind: 'text', text: 'T' }));

    const r = await ok(
      h.cp.setTypographyAnimation(clipId, el.elementId, { preset: 'slide-in-up', duration: 0.8, loop: 'infinite' }),
    );
    const anims = (r.element as { animations?: Record<string, unknown>[] }).animations ?? [];
    // slide-in-up 动 transform.translateY + opacity ⇒ **每条一个属性**。
    expect(anims.map((a) => [a.kind, a.prop])).toEqual([
      ['tracks', 'y'],
      ['tracks', 'opacity'],
    ]);
    expect(anims[0]!.keys).toEqual([
      { t: 0, v: 80, ease: null },
      { t: 0.8, v: 0, ease: null },
    ]);
    expect(anims[0]!.duration).toBeCloseTo(0.8, 6);
    expect(anims[0]!.iterations).toBe('infinite');
  });

  it('旧式 keys 的 { beat } 按工程 BPM 换算成绝对秒（120BPM ⇒ 一拍 0.5s）', async () => {
    const h = harness();
    const clipId = await textClip(h);
    const el = await ok(h.cp.addTypographyElement(clipId, { kind: 'text', text: 'T' }));
    // 工程默认 120BPM / offset 0；动画时长 1s ⇒ beat 1 = 0.5s。
    await ok(
      h.cp.setTypographyAnimation(clipId, el.elementId, {
        duration: 1,
        keys: [
          { at: { beat: 0 }, opacity: 0 },
          { at: { beat: 1 }, opacity: 1 },
        ],
      }),
    );
    const doc = await ok(h.cp.getTypographyDoc(clipId, 'full'));
    const anim = (doc.elements[0] as { animations?: { kind?: string; prop?: string; keys?: unknown }[] })
      .animations?.[0];
    expect(anim?.kind).toBe('tracks');
    expect(anim?.prop).toBe('opacity');
    expect(anim?.keys).toEqual([
      { t: 0, v: 0, ease: null },
      { t: 0.5, v: 1, ease: null },
    ]);
  });

  it('预设名拼错时报 invalid-argument（不静默忽略）', async () => {
    const h = harness();
    const clipId = await textClip(h);
    const el = await ok(h.cp.addTypographyElement(clipId, { kind: 'text', text: 'T' }));
    expect(await code(h.cp.setTypographyAnimation(clipId, el.elementId, { preset: 'slideInUp' }))).toBe(
      'invalid-argument',
    );
    // animation:null 清空不需要合法预设。
    await ok(h.cp.setTypographyAnimation(clipId, el.elementId, null));
  });

  it('typo_add_element 可以一次就把动画带上', async () => {
    const h = harness();
    const clipId = await textClip(h);
    const el = await ok(
      h.cp.addTypographyElement(clipId, {
        kind: 'text',
        text: 'T',
        animation: { preset: 'fade-in', duration: 0.5 },
      } as never),
    );
    const anims = (el.element as { animations?: unknown[] }).animations ?? [];
    expect(anims).toHaveLength(1);
  });
});
