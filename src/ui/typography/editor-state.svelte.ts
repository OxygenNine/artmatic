/**
 * editor-state.svelte.ts — 排版编辑器的界面态（runes 单例）。
 *
 * 为什么单独一个模块而不是塞进 appState：这是**编辑器局部**的状态
 * （选中集、缩放、参考线），只有排版页和它的键盘分发用得到。放进 appState
 * 会让「时间轴的选择态」和「排版的选择态」纠缠在一起，而它们连语义都不同
 * （前者单选一个片段，后者多选若干元素）。
 *
 * 两条硬纪律：
 *  1. **选中态不进 store**（与时间轴的 selectedClipId 一致）——选择态写库会
 *     在拖拽过程中触发全量重建，把正在拖的 DOM 换掉。
 *  2. 文档写入一律经这里收口：离散改动走 store.commit（一笔撤销），
 *     手势中途走 store.touch（实时、不入栈），松手时 endTx 结算。
 *     直接改 store.project 会绕过撤销栈。
 */

import { appState } from '../app-state.svelte';
import type { Project, SourceClip } from '../../core/schema';
import {
  reorderElements,
  type ImageElement,
  type ShapeElement,
  type TypographyDocument,
  type TypographyElement,
  type ZOrderOp,
} from '../../typography/document';
import { boundsOf, toRects, type Guide, type Rect } from '../../typography/geometry';
import { screenFrame, type CameraDoc } from '../../typography/camera';
import {
  expandToGroups,
  groupsInSelection,
  isGroupFullySelected,
  membersOf,
  pruneGroups,
  reorderSelection,
  type GroupedFragment,
} from '../../typography/groups';
import { tr } from '../../i18n/index.svelte';

/** 在工程里找到某个排版片段的文档。找不到返回 null（片段可能刚被删）。 */
export function findTextDoc(project: Project, clipId: string): TypographyDocument | null {
  for (const track of project.tracks) {
    for (const clip of track.clips) {
      if (clip.id !== clipId) continue;
      if (clip.kind === 'source' && clip.source.type === 'text') return clip.source.doc;
      return null;
    }
  }
  return null;
}

class TypographyEditorState {
  /** 当前编辑的片段 id。null = 编辑器没打开。 */
  clipId = $state<string | null>(null);

  selectedIds = $state<string[]>([]);

  /** 显示缩放（1 = 文档像素 : 屏幕像素 1:1）。 */
  zoom = $state(1);

  /** 拖动中的智能参考线。松手即清空，不写库。 */
  guides = $state<Guide[]>([]);

  /** 「光栅预览」开关：把舞台换成显示真实光栅结果，用来验证所见即所得。 */
  rasterPreview = $state(false);

  /** 正在编辑文本的元素 id（P4 用）。 */
  editingTextId = $state<string | null>(null);

  /**
   * 正在编辑的文本选区（**只记非空区间**）。`null` = 没有行内选区。
   *
   * 它是「这次格式改的是整块还是选中的那一段」的**唯一判据**：光标收起时
   * （start === end）不记 —— 那时把整段都加粗是很意外的行为，用户只是把光标
   * 放在那儿而已。
   *
   * ⚠️ **它比 `editingTextId` 活得更久**：点 Ribbon 上的字号输入框会让编辑区
   * 失焦，但用户的心智里「我刚选的那一段」还在。所以失焦只结束编辑态，
   * 不清这个；只有**选到别处去**（`setSelection` 不再包含它）或清空选择时才清。
   */
  textRange = $state.raw<{ elId: string; start: number; end: number } | null>(null);

  /**
   * 正在做**顶点 / 控制点编辑**的那个元素 id。null = 普通选择模式。
   *
   * 与 `editingTextId` 是同一类东西（「这个元素处于更细的编辑态」），区别是
   * 文本编辑改内容、它改形状。**只在单选时成立**，且选区一变就退出
   * （见 `setSelection`）—— 多选状态下同时拖八个图形的锚点没有任何意义，
   * 而混着来会让「拖的到底是哪个」变成猜谜。
   */
  nodeEditId = $state<string | null>(null);

  /**
   * 正在做**四角调整**的图片元素 id。null = 不显示四角手柄。
   *
   * 与 `nodeEditId` 同一类「更细的编辑态」，也遵守同一条约束：**只在单选时
   * 成立，选区一变就退出**（见 `setSelection`）。四角手柄与缩放把手在角上
   * 完全重合，两套同时显示时用户分不清拖的是哪一个 —— 所以进入这个模式时
   * 选择框只留外框（见 `SelectionLayer` 的 `quadEdit`）。
   */
  quadEditId = $state<string | null>(null);

  /**
   * **格式刷 / 动画刷**的待落点态。null = 没启用。
   *
   * 启用后下一次点击舞台上的元素 = 「把 sourceId 的格式 / 动画刷给它」，而不是
   * 普通选择（见 TypographyEditor 的 onStageDown）。`sticky` = 双击启用的连续模
   * 式：刷完一个继续等下一个；单击启用的只生效一次。
   *
   * 与 `nodeEditId` 同属「编辑器模式」，但它**不是**只在单选时成立 —— 连续模式下
   * 刷过的目标会成为当前选择集，而源元素保持不变。
   */
  painter = $state<{ kind: 'format' | 'animation'; sourceId: string; sticky: boolean } | null>(null);

  /** 处于顶点 / 控制点编辑态的那个图形元素（不是图形就当作没有）。 */
  get nodeEdit(): ShapeElement | null {
    const id = this.nodeEditId;
    if (!id) return null;
    const el = this.doc?.elements.find((e) => e.id === id);
    return el && el.kind === 'shape' ? el : null;
  }

  /** 处于四角调整态的那个图片元素（不是图片就当作没有）。 */
  get quadEdit(): ImageElement | null {
    const id = this.quadEditId;
    if (!id) return null;
    const el = this.doc?.elements.find((e) => e.id === id);
    return el && el.kind === 'image' ? el : null;
  }

  /** 进入 / 退出四角调整（传 null 退出）。 */
  setQuadEdit(id: string | null): void {
    const el = id ? this.doc?.elements.find((e) => e.id === id) : null;
    this.quadEditId = el && el.kind === 'image' && !el.locked ? id : null;
  }


  /**
   * 编辑器内部的剪贴板（**不碰系统剪贴板**：那需要权限、无头 E2E 里还不一定可用，
   * 而这套功能只在编辑器内部闭环）。存的是未偏移的原件，偏移随粘贴次数累加。
   *
   * 为什么是 `$state` 而不是 actions.ts 里的模块级变量：**右键菜单的「粘贴」
   * 可用性要跟着它变**。模块级普通变量不是响应式的，菜单会拿着打开那一刻算出来的
   * `disabled` 不放 —— 表现是「刚复制完，粘贴项还是灰的」（E2E 抓到的）。
   *
   * 为什么是 **`$state.raw` 而不是 `$state`**：`$state` 会**深代理**数组与元素，
   * 而 `structuredClone` 遇到 Proxy 直接抛 `DataCloneError`（V8 实测），
   * 于是粘贴静默失败。这里本来也是「整份换掉」而不是原地改，raw 正合适。
   */
  clipboard = $state.raw<GroupedFragment | null>(null);

  /** 连续粘贴的偏移计数。纯非响应式：它不影响任何界面状态。 */
  pasteCount = 1;

  /**
   * 已经「进入」的组合 id。
   *
   * 单击语义（PPT / Figma 同款）：点组里的元素 → 选中**整个组**；在组已经
   * 整体选中的状态下再点 → 进入组，只选中被点的那一个子元素。
   * 这个字段记住「我在组里面」，于是再点子元素时不会又跳回整组。
   */
  enteredGroupId = $state<string | null>(null);

  private inGesture = false;

  /* ------------------------------------------------------------ 读取 */

  get clip(): SourceClip | null {
    void appState.version;
    const id = this.clipId;
    const store = appState.store;
    if (!id || !store) return null;
    const found = store.findClip(id);
    if (!found) return null;
    const c = found.clip;
    if (c.kind !== 'source' || c.source.type !== 'text') return null;
    return c;
  }

  get doc(): TypographyDocument | null {
    return this.clip?.source.type === 'text' ? this.clip.source.doc : null;
  }

  get elements(): TypographyElement[] {
    return this.doc?.elements ?? [];
  }

  get selected(): TypographyElement[] {
    const set = new Set(this.selectedIds);
    return this.elements.filter((e) => set.has(e.id));
  }

  /** 不可见的元素不参与选择（它根本不在 DOM 里，选中了也拖不动）。 */
  get selectableRects(): Rect[] {
    return toRects(this.elements.filter((e) => e.visible && !e.locked));
  }

  /**
   * 可选元素在**屏幕上**的框（已吃镜头视差）。
   *
   * 命中测试与框选必须走它：镜头把元素放大 / 推走之后，可见位置与 `frame`
   * 已经不是同一处，用 `selectableRects` 会「点不中自己看得见的东西」。
   *
   * 传进来的 `view` 是**播放头时刻的文档视图**（`withCameraAt` 的产物）：
   * 镜头有关键帧时取景逐帧在变，这里不能自己去读 `doc.camera`。
   *
   * 手势内部仍用 `selectableRects`（吸附 / 参考线都在文档坐标系里算），
   * 指针进入那个坐标系靠 `TypographyEditor` 的 `makeEnv(focusId)`。
   */
  screenRects(view: CameraDoc): Rect[] {
    const out: Rect[] = [];
    for (const el of this.elements) {
      if (!el.visible || el.locked) continue;
      const f = screenFrame(view, el);
      // 与 `toRects` 同口径：命中用**未旋转**的框，旋转交给 `isOpaqueAt` 的局部变换。
      out.push({ id: el.id, x: f.x, y: f.y, w: f.w, h: f.h });
    }
    return out;
  }

  get selectionRect(): Rect | null {
    const sel = this.selected;
    return sel.length ? boundsOf(toRects(sel)) : null;
  }

  get canvasSize(): { w: number; h: number } {
    return this.doc?.size ?? { w: 1920, h: 1080 };
  }

  /** 选区里涉及的全部组合 id（去重，按 z 序）。 */
  get selectedGroupIds(): string[] {
    const doc = this.doc;
    if (!doc) return [];
    return groupsInSelection(doc, this.selectedIds);
  }

  /** 选区是不是**恰好一个完整的组**（图形/组合格式选项卡据此切换）。 */
  get soleSelectedGroupId(): string | null {
    const doc = this.doc;
    if (!doc) return null;
    const ids = this.selectedGroupIds;
    if (ids.length !== 1) return null;
    return isGroupFullySelected(doc, ids[0]!, new Set(this.selectedIds)) ? ids[0]! : null;
  }

  /**
   * 「组语义」展开后的选择集 —— **所有按元素逐个操作的动作都该用它**。
   *
   * 组内编辑态（`enteredGroupId` 非空）下**不展开**：那时用户就是在跟子元素
   * 打交道，展开会把「拖一个子元素」变成「拖整组」，与画布上的拖拽手势
   * （它只动实际选中的那几个）对不上。
   */
  get groupAwareIds(): string[] {
    const doc = this.doc;
    if (!doc || this.enteredGroupId) return this.selectedIds;
    return expandToGroups(doc, this.selectedIds);
  }

  isSelected(id: string): boolean {
    return this.selectedIds.includes(id);
  }

  /**
   * 点中某个元素时的选择语义（组内外两态）。
   *
   * 返回 true 表示「选中了整个组」，false 表示「只选中被点的那个」。规则：
   *  - 元素不在组里 → 单选它，并退出「组内」态；
   *  - **已经在组里**（`enteredGroupId === gid`）→ 直接选子元素，点兄弟也换兄弟，
   *    不会又跳回整组；
   *  - 组里、但该组已整体选中且还没进来 → 进入组，只选被点的那个（第二次单击）；
   *  - 其余情况 → 选中整组（第一次单击）。
   *
   * 判据必须是「已进入」而不是「已整体选中」：后者在进入之后就不再成立
   * （只剩一个子元素被选中），第三次单击会莫名其妙又跳回整组。
   */
  pickElement(el: TypographyElement): boolean {
    const doc = this.doc;
    const gid = el.groupId;
    if (!doc || !gid) {
      this.enteredGroupId = null;
      this.setSelection([el.id]);
      return false;
    }

    if (this.enteredGroupId === gid) {
      this.setSelection([el.id]);
      return false;
    }

    if (isGroupFullySelected(doc, gid, new Set(this.selectedIds))) {
      this.enteredGroupId = gid;
      this.setSelection([el.id]);
      return false;
    }

    this.enteredGroupId = null;
    this.setSelection(membersOf(doc, gid).map((m) => m.id));
    return true;
  }

  /** 直接选中整组（图层列表的组行点击走它）。 */
  selectGroup(groupId: string): void {
    const doc = this.doc;
    if (!doc) return;
    this.enteredGroupId = null;
    this.setSelection(membersOf(doc, groupId).map((m) => m.id));
  }

  /** 进入组（双击组行 / 展开时用）。 */
  enterGroup(groupId: string): void {
    this.enteredGroupId = groupId;
  }

  /* ------------------------------------------------------------ 文本编辑 */

  beginEditing(id: string): void {
    if (this.editingTextId === id) return;
    this.editingTextId = id;
    this.textRange = null;
  }

  /**
   * 结束文本编辑。
   *
   * **必须先 blur 再清状态**：提交逻辑挂在 `focusout` 上，而在那里读的是
   * `editingTextId` 才知道要提交哪个元素 —— 先清掉的话，用户刚打的字会被
   * 静默丢弃（而且看起来像「失焦了但没保存」这种最难描述的现象）。
   */
  stopEditing(): void {
    const active = typeof document !== 'undefined' ? (document.activeElement as HTMLElement | null) : null;
    if (active && active.isContentEditable) active.blur();
    this.editingTextId = null;
    this.textRange = null;
  }

  /* ------------------------------------------------------------ 生命周期 */

  open(clipId: string): void {
    if (this.clipId === clipId) return;
    this.clipId = clipId;
    this.selectedIds = [];
    this.guides = [];
    this.editingTextId = null;
    this.textRange = null;
    this.nodeEditId = null;
    this.quadEditId = null;
    this.enteredGroupId = null;
    this.painter = null;
  }

  close(): void {
    if (this.inGesture) this.cancelGesture();
    this.clipId = null;
    this.selectedIds = [];
    this.guides = [];
    this.editingTextId = null;
    this.textRange = null;
    this.nodeEditId = null;
    this.quadEditId = null;
    this.enteredGroupId = null;
    this.painter = null;
    appState.registerGestureCancel(null);
  }

  /* ------------------------------------------------------------ 选择 */

  setSelection(ids: string[]): void {
    // 选区一旦挪到别处，之前记下的行内选区就失效了（见 textRange 的说明）。
    if (this.textRange && !ids.includes(this.textRange.elId)) this.textRange = null;
    // 顶点编辑态同理：选的已经不是那个元素了，编辑态自然结束。
    if (this.nodeEditId && !ids.includes(this.nodeEditId)) this.nodeEditId = null;
    // 四角调整同样只在单选时成立：选区换了就退出（手柄会跟错元素）。
    if (this.quadEditId && (ids.length !== 1 || ids[0] !== this.quadEditId)) {
      this.quadEditId = null;
    }
    // 去重但保序：z 序是有意义的（后选中的应当是最后绘制的）。
    const next = [...new Set(ids)];
    // 被编辑的元素不在新选择集里就收尾（提交在 focusout 里做）。
    if (this.editingTextId && !next.includes(this.editingTextId)) this.stopEditing();
    this.selectedIds = next;
  }

  selectOnly(id: string | null): void {
    this.setSelection(id ? [id] : []);
  }

  toggle(id: string): void {
    this.setSelection(
      this.selectedIds.includes(id)
        ? this.selectedIds.filter((x) => x !== id)
        : [...this.selectedIds, id],
    );
  }

  selectAll(): void {
    this.setSelection(this.selectableRects.map((r) => r.id));
  }

  clearSelection(): void {
    this.selectedIds = [];
    this.textRange = null;
    this.nodeEditId = null;
    this.quadEditId = null;
    this.enteredGroupId = null;
    // 「点空白处」= 取消刷子（用户明确要求的取消方式之一）。
    this.painter = null;
    this.stopEditing();
  }

  /* ------------------------------------------------------------ 写入 */

  /** 离散改动：一笔撤销。 */
  commit(label: string, fn: (doc: TypographyDocument) => void): void {
    const id = this.clipId;
    if (!id) return;
    appState.store.commit(label, (p) => {
      const doc = findTextDoc(p, id);
      if (!doc) return;
      fn(doc);
      /*
       * 写库之后统一收口：成员少于 2 个、或成员在数组里已经不连续的组，直接解掉。
       *
       * 会不连续的唯一路径是图层拖曳把一个成员挪到别处。与其在那一条路径上
       * 到处补判断（还有下一次加别的入口时又会漏），不如每次落库后统一收拾 ——
       * 表现是「拖散了就自动解组」，比留下一个半坏不坏的组清楚。
       */
      const pruned = pruneGroups(doc);
      if (pruned.groups !== doc.groups) doc.groups = pruned.groups;
    });
  }

  /* 手势：beginTx → live(多次) → endTx / cancelTx。
   * 中途**不能**用 commit：每一步都会拍一次快照，一次拖拽会塞满撤销栈。 */
  beginGesture(): void {
    if (this.inGesture) return;
    appState.store.beginTx();
    this.inGesture = true;
    // 关 tab / 切页时若手势还没结算，必须回滚——否则 beginTx 悬空，
    // 之后每一次 commit 都会被并进这个事务里。
    appState.registerGestureCancel(() => this.cancelGesture());
  }

  live(fn: (doc: TypographyDocument) => void): void {
    const id = this.clipId;
    if (!id) return;
    const doc = findTextDoc(appState.store.project, id);
    if (!doc) return;
    fn(doc);
    appState.store.touch();
  }

  endGesture(label: string): void {
    if (!this.inGesture) return;
    this.inGesture = false;
    appState.store.endTx(label);
    appState.registerGestureCancel(null);
  }

  cancelGesture(): void {
    if (!this.inGesture) return;
    this.inGesture = false;
    appState.store.cancelTx();
    appState.registerGestureCancel(null);
  }

  get gestureActive(): boolean {
    return this.inGesture;
  }

  /* ------------------------------------------------------------ 常用动作 */

  nudge(dx: number, dy: number): void {
    const doc = this.doc;
    if (!doc) return;
    // 组内任一成员被选中 ⇒ 整组一起走（组内编辑态除外，见 groupAwareIds）。
    // 在每一处各补一次「再算上同组成员」迟早会漏，所以收口成一个 getter。
    const ids = new Set(this.groupAwareIds);
    if (!ids.size) return;
    this.commit(tr('typo.undo.move'), (d) => {
      for (const el of d.elements) {
        if (!ids.has(el.id) || el.locked) continue;
        el.frame.x += dx;
        el.frame.y += dy;
      }
    });
  }

  /**
   * 层级调整。**唯一实现**：Ribbon 的四个按钮与图层面板的上下移都走这里，
   * 两处各写一份的话「上移一层」在两个入口下的行为迟早会不一致。
   *
   * 选中的是一整段连续区间（组合就是这种情况）时走**整块移动**，
   * 否则逐层移动会把块拆散 —— 成员一旦不连续，组合就散了。
   */
  order(op: ZOrderOp): void {
    const doc = this.doc;
    if (!doc) return;
    const ids = this.groupAwareIds;
    if (!ids.length) return;
    this.commit(tr('typo.undo.order'), (d) => {
      const next = reorderSelection(d, ids, op, (dd, ii, oo) => reorderElements(dd, ii, oo));
      d.elements = next.elements;
    });
  }

  /**
   * 拖曳排序：把 `doc.elements[from]` 挪到下标 `to`。
   *
   * 传的是**数组下标**（不是图层列表里的视觉下标）。列表是倒序渲染的
   * （数组末尾 = 最前景 = 列表顶部），所以调用方负责换算：
   * 视觉第 i 行 ↔ 数组下标 `len - 1 - i`。这个换算只放一处，
   * 放进这里会让「上下移」那套按 id 的动作与按下标的动作混在一起。
   */
  moveElement(from: number, to: number): void {
    const n = this.elements.length;
    if (from === to || from < 0 || to < 0 || from >= n || to >= n) return;
    this.commit(tr('typo.undo.order'), (doc) => {
      const [moved] = doc.elements.splice(from, 1);
      if (moved) doc.elements.splice(to, 0, moved);
    });
  }

  setZoom(z: number): void {
    this.zoom = Math.max(0.05, Math.min(4, z));
  }

  /**
   * 重命名元素（可撤销）。
   *
   * **空名回退为不改名**：清空输入框再回车是个很常见的手滑，把它写成空名字
   * 会让图层行只剩一个类型图标、再也认不出是谁。判据放在这里而不是组件里，
   * 因为「什么算有效的名字」是数据层的规则。
   */
  renameElement(id: string, name: string): void {
    const next = name.trim();
    const el = this.doc?.elements.find((e) => e.id === id);
    if (!el || !next || el.name === next) return;
    this.commit(tr('typo.undo.renameElement'), (doc) => {
      const target = doc.elements.find((e) => e.id === id);
      if (target) target.name = next;
    });
  }

  /** 重命名组合（可撤销）。空名同样回退为不改名。 */
  renameGroup(id: string, name: string): void {
    const next = name.trim();
    const g = this.doc?.groups?.find((x) => x.id === id);
    if (!g || !next || g.name === next) return;
    this.commit(tr('typo.undo.renameGroup'), (doc) => {
      const target = (doc.groups ?? []).find((x) => x.id === id);
      if (target) target.name = next;
    });
  }
}

export const editorState = new TypographyEditorState();
