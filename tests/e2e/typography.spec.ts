import { expect, test, type Page } from '@playwright/test';
import { addTextClip, openDemo } from './_stage';

/**
 * 排版：编辑器页宿主的生命周期与交互。
 *
 * 走**真实手势**（page.mouse / page.keyboard）而不是直接调 store ——
 * 分页、命中测试、事务结算这些问题全在手势层，直接调 store 会把它们整个绕过去。
 */

async function boot(page: Page): Promise<void> {
  await page.goto('/');
  await page.waitForFunction(() => (window as never as { __artmatic?: unknown }).__artmatic);
  await openDemo(page);
}

interface Hooks {
  store: {
    project: {
      assets: Record<string, { id: string; kind: string }>;
      tracks: {
        id: string;
        clips: {
          id: string;
          start: number;
          end: number;
          source?: { type?: string; assetId?: string; doc?: DocShape };
        }[];
      }[];
    };
    undo: () => boolean;
  };
  assets: { size: (id: string) => number | null };
  renderer: {
    renderFrame: (p: unknown, t: number) => void;
    readPixels: () => { data: Uint8Array; w: number; h: number };
    kit: { gl: WebGL2RenderingContext };
  };
  appState: { playT: number };
  renderFrame: (t: number) => void;
}

interface DocShape {
  size: { w: number; h: number };
  elements: {
    id: string;
    kind?: string;
    name?: string;
    frame: { x: number; y: number; w: number; h: number; rot: number };
  }[];
}

/**
 * 取**当前正在编辑**的那个排版片段。
 *
 * 不能再用「工程里第一个 text 片段」：开箱 demo 自己就带一个标题排版片段，
 * 于是「第一个」永远是 demo 的，新加的那个根本读不到 ——
 * 拖拽用例会表现成「元素纹丝不动」，而真因完全指不到这里。
 * 编辑页有 `activeTypoClipId`，直接用它。
 */
async function readGeom(page: Page) {
  return page.evaluate(() => {
    const A = (window as never as { __artmatic: Hooks & { appState: { activeTypoClipId: string | null } } })
      .__artmatic;
    const id = A.appState.activeTypoClipId;
    let doc: DocShape | null = null;
    for (const t of A.store.project.tracks) {
      for (const c of t.clips) {
        if (c.id === id && c.source?.type === 'text' && c.source.doc) doc = c.source.doc;
      }
    }
    if (!doc) throw new Error(`找不到当前编辑的排版文档（activeTypoClipId=${id}）`);
    const wrap = document.querySelector('.paper-wrap')!.getBoundingClientRect();
    const zoom = wrap.width / doc.size.w;
    const f = doc.elements[0]!.frame;
    return { zoom, left: wrap.left, top: wrap.top, frame: { ...f } };
  });
}

/** 读回第一个元素的 frame.x。 */
async function readFrameX(page: Page): Promise<number> {
  return page.evaluate(() => {
    const A = (window as never as { __artmatic: Hooks & { appState: { activeTypoClipId: string | null } } })
      .__artmatic;
    const id = A.appState.activeTypoClipId;
    for (const t of A.store.project.tracks) {
      for (const c of t.clips) {
        if (c.id === id && c.source?.type === 'text' && c.source.doc) return c.source.doc.elements[0]!.frame.x;
      }
    }
    throw new Error(`找不到当前编辑的排版文档（activeTypoClipId=${id}）`);
  });
}

/** 工程里全部排版片段的 id。 */
async function textClipIds(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const A = (window as never as { __artmatic: Hooks }).__artmatic;
    const out: string[] = [];
    for (const t of A.store.project.tracks) {
      for (const c of t.clips) if (c.source?.type === 'text') out.push(c.id);
    }
    return out;
  });
}

async function openEditor(page: Page, clipId: string): Promise<void> {
  await page.locator(`[data-testid=clip][data-clip-id="${clipId}"]`).dblclick();
  await expect(page.getByTestId('typo-editor')).toBeVisible();
}

test('双击排版片段打开编辑页；关闭后回到时间轴', async ({ page }) => {
  await boot(page);
  const clipId = await addTextClip(page);

  // 双击 = 打开（不再是切分）
  await openEditor(page, clipId);
  // 排版视图不是独立的 tab —— 顶栏的 tab 是工程，这里出现的是「回到时间轴」。
  await expect(page.getByTestId('project-tab-timeline-0')).toBeVisible();

  // 主界面只是被隐藏，没有卸载
  await expect(page.getByTestId('tl-scroll')).toBeHidden();

  // 回到时间轴
  await page.getByTestId('project-tab-timeline-0').click();
  await expect(page.getByTestId('typo-editor')).toHaveCount(0);
  await expect(page.getByTestId('tl-scroll')).toBeVisible();
});

test('排版片段有角标，底栏把双击的去向说出来（与调色片段同一套提示）', async ({ page }) => {
  await boot(page);
  const clipId = await addTextClip(page);
  const clip = page.locator(`[data-testid=clip][data-clip-id="${clipId}"]`);

  // 角标：type 图标，文字标签让位（不许盖在图标上）。
  await expect(clip.locator('[data-testid=clip-editor-mark]')).toHaveAttribute('data-editor', 'typography');
  const mark = (await clip.locator('[data-testid=clip-editor-mark]').boundingBox())!;
  const name = (await clip.locator('[data-testid=clip-name]').boundingBox())!;
  expect(name.x, '片段名压在图标上了').toBeGreaterThanOrEqual(mark.x + mark.width);

  // 底栏：说的是「双击 编辑排版」，不是泛泛的「打开片段编辑器」。
  await clip.hover();
  const bar = page.getByTestId('statusbar');
  await expect(bar).toContainText('编辑排版');
  await expect(bar).not.toContainText('打开片段编辑器');

  // 检查器里的显式入口同样在（双击之外的第二个出口）。
  await clip.click();
  await expect(page.getByTestId('edit-typography')).toBeVisible();
});

test('切页不丢 WebGL 上下文，也不动播放头', async ({ page }) => {
  await boot(page);
  const clipId = await addTextClip(page);

  const before = await page.evaluate(() => {
    const A = (window as never as { __artmatic: Hooks }).__artmatic;
    A.appState.playT = 3.25;
    return A.appState.playT;
  });

  await openEditor(page, clipId);
  await page.getByTestId('project-tab-timeline-0').click();
  await expect(page.getByTestId('tl-scroll')).toBeVisible();

  const after = await page.evaluate(() => {
    const A = (window as never as { __artmatic: Hooks }).__artmatic;
    // 这是本用例的核心：切页若卸载了 <canvas>，上下文会丢，
    // kit 里所有 Program / Target / 纹理一起失效，且无法恢复。
    const lost = A.renderer.kit.gl.isContextLost();
    A.renderer.renderFrame(A.store.project, A.appState.playT);
    const px = A.renderer.readPixels();
    let ink = 0;
    for (let i = 0; i < px.data.length; i += 4) if (px.data[i]! > 8) ink += 1;
    return { lost, ink, playT: A.appState.playT };
  });

  expect(after.lost).toBe(false);
  expect(after.ink).toBeGreaterThan(0); // demo 有四层画面，不该是全黑
  expect(after.playT).toBe(before);
});

test('编辑器里拖拽元素：落库、可撤销、且是一笔', async ({ page }) => {
  await boot(page);
  const clipId = await addTextClip(page);
  await openEditor(page, clipId);

  const geom = await readGeom(page);

  const startX = geom.left + (geom.frame.x + geom.frame.w / 2) * geom.zoom;
  const startY = geom.top + (geom.frame.y + geom.frame.h / 2) * geom.zoom;
  const dxDoc = 200;

  await page.mouse.move(startX, startY);
  await page.mouse.down();
  await page.mouse.move(startX + dxDoc * geom.zoom, startY, { steps: 12 });
  await page.mouse.up();

  const moved = await readFrameX(page);
  expect(Math.abs(moved - (geom.frame.x + dxDoc))).toBeLessThan(3);

  // 整段拖拽应当是**一笔**撤销，而不是几十笔逐帧记录
  await page.keyboard.press('Control+z');
  const restored = await readFrameX(page);
  expect(Math.abs(restored - geom.frame.x)).toBeLessThan(0.001);
});

test('按住 Alt 可临时关吸附', async ({ page }) => {
  await boot(page);
  const clipId = await addTextClip(page);
  await openEditor(page, clipId);

  const geom = await readGeom(page);

  const startX = geom.left + (geom.frame.x + geom.frame.w / 2) * geom.zoom;
  const startY = geom.top + (geom.frame.y + geom.frame.h / 2) * geom.zoom;

  await page.keyboard.down('Alt');
  await page.mouse.move(startX, startY);
  await page.mouse.down();
  // 只挪 4 文档像素：开着吸附时这点距离会被拉回对齐位置，关了才留得住。
  await page.mouse.move(startX + 4 * geom.zoom, startY, { steps: 6 });
  await page.mouse.up();
  await page.keyboard.up('Alt');

  const moved = await readFrameX(page);
  expect(Math.abs(moved - (geom.frame.x + 4))).toBeLessThan(1.5);
});

test('时间轴快捷键在编辑页失效（S 不切分、Alt+↑↓ 不移轨）', async ({ page }) => {
  await boot(page);
  const clipId = await addTextClip(page);

  const snapshot = (id: string) => {
    const A = (window as never as { __artmatic: Hooks }).__artmatic;
    const all: { i: number; j: number; start: number; end: number }[] = [];
    for (let i = 0; i < A.store.project.tracks.length; i++) {
      const t = A.store.project.tracks[i]!;
      for (let j = 0; j < t.clips.length; j++) {
        const c = t.clips[j]!;
        if (c.id === id) all.push({ i, j, start: c.start, end: c.end });
      }
    }
    let total = 0;
    for (const t of A.store.project.tracks) total += t.clips.length;
    return { self: all, total };
  };

  const before = await page.evaluate(snapshot, clipId);

  await openEditor(page, clipId);
  await page.keyboard.press('s');
  await page.keyboard.press('Alt+ArrowUp');
  await page.keyboard.press('Alt+ArrowDown');

  const after = await page.evaluate(snapshot, clipId);

  // 片段总数不变（S 没切分）、位置不变（Alt+↑↓ 没换轨）、时间区间不变。
  expect(after.total).toBe(before.total);
  expect(after.self).toEqual(before.self);
});

/* ------------------------------------------------------------ 选择手势辅助 */

/**
 * 从插入选项卡插一个形状（与 typography-ribbon.spec.ts 同一路径）。
 * 连续插两个形状会落在**同一个默认框**上（`defaultShapeFrame` 与预设无关），
 * 正好用来造出完美重叠的两个元素。
 */
async function insertShape(page: Page, key: string): Promise<void> {
  await page.getByTestId('ribbon-tab-insert').click();
  await page.getByTestId('typo-shape').click();
  await page.getByTestId(`typo-shape-card-${key}`).click();
}

/** 当前编辑文档里的元素（id / kind / name / frame）与 paper-wrap 的屏幕换算。 */
async function readElements(page: Page) {
  return page.evaluate(() => {
    const A = (window as never as { __artmatic: Hooks & { appState: { activeTypoClipId: string | null } } })
      .__artmatic;
    const id = A.appState.activeTypoClipId;
    let doc: DocShape | null = null;
    for (const t of A.store.project.tracks) {
      for (const c of t.clips) {
        if (c.id === id && c.source?.type === 'text' && c.source.doc) doc = c.source.doc;
      }
    }
    if (!doc) throw new Error(`找不到当前编辑的排版文档（activeTypoClipId=${id}）`);
    const wrap = document.querySelector('.paper-wrap')!.getBoundingClientRect();
    return {
      zoom: wrap.width / doc.size.w,
      left: wrap.left,
      top: wrap.top,
      elements: doc.elements.map((e) => ({ id: e.id, kind: e.kind, name: e.name, frame: { ...e.frame } })),
    };
  });
}

/**
 * 图层面板里**选中**的元素 id（读 DOM，不读 store）。
 *
 * 选中行带 `selected` 类。这里刻意读界面而不是 store：这一整类 bug 正是
 * 「store 对了、界面没跟上」，只有读界面才抓得到（见文件头与 AGENTS §6.3）。
 * 返回的是**列表顺序**（从上到下 = 从前景到后景），断言里一般先排序再比。
 */
async function selectedRowIds(page: Page): Promise<string[]> {
  return page.$$eval('[data-testid=typo-layer-row].selected', (els) =>
    els.map((e) => e.getAttribute('data-el-id') ?? ''),
  );
}

/** 某元素框中心的屏幕坐标（用于鼠标手势）。 */
function centerOf(geo: Awaited<ReturnType<typeof readElements>>, index: number) {
  const f = geo.elements[index]!.frame;
  return {
    x: geo.left + (f.x + f.w / 2) * geo.zoom,
    y: geo.top + (f.y + f.h / 2) * geo.zoom,
  };
}

test('Shift 单击：多选下点已选项移出选区、点未选项加入', async ({ page }) => {
  await boot(page);
  const clipId = await addTextClip(page);
  await openEditor(page, clipId);
  // 新片段自带一个文本框；再插一个图形 ⇒ 两个元素。
  await insertShape(page, 'rect');

  const geo = await readElements(page);
  expect(geo.elements.length).toBe(2);
  const ids = geo.elements.map((e) => e.id);
  const sortedIds = [...ids].sort();

  // Control+A 全选（走真实键盘手势，不是直接调 store）。
  await page.keyboard.press('Control+a');
  await expect.poll(async () => (await selectedRowIds(page)).sort()).toEqual(sortedIds);

  // Shift 单击其中一个已选元素 ⇒ 它被移出，其余保留。
  const target = geo.elements[1]!; // 数组末位 = 最前景（后插入的图形）
  const p = centerOf(geo, 1);
  await page.keyboard.down('Shift');
  await page.mouse.click(p.x, p.y);
  await page.keyboard.up('Shift');

  const afterRemove = (await selectedRowIds(page)).sort();
  expect(afterRemove, 'Shift 单击已选项没有把它移出选区').not.toContain(target.id);
  expect(afterRemove, '其余已选项不该被清掉').toEqual([ids[0]!]);

  // 再 Shift 单击同一个（现在未选）元素 ⇒ 重新加入。
  await page.keyboard.down('Shift');
  await page.mouse.click(p.x, p.y);
  await page.keyboard.up('Shift');
  await expect.poll(async () => (await selectedRowIds(page)).sort()).toEqual(sortedIds);
});

test('Alt 单击：在同一位置轮询重叠元素', async ({ page }) => {
  await boot(page);
  const clipId = await addTextClip(page);
  await openEditor(page, clipId);
  // 两个形状落在同一个默认框上 ⇒ 完全重叠（最前景 = 后插入的椭圆）。
  await insertShape(page, 'rect');
  await insertShape(page, 'ellipse');

  const geo = await readElements(page);
  const shapes = geo.elements.filter((e) => e.kind === 'shape');
  expect(shapes.length).toBe(2);
  const top = geo.elements[geo.elements.length - 1]!;
  const p = centerOf(geo, geo.elements.length - 1);

  // 先清空选择：否则「已选集合里含命中元素 → 选下一个」会跳过最上层。
  await page.keyboard.press('Escape');
  await expect.poll(() => selectedRowIds(page)).toEqual([]);

  const altClick = async (): Promise<void> => {
    await page.keyboard.down('Alt');
    await page.mouse.move(p.x, p.y);
    await page.mouse.down();
    await page.mouse.up();
    await page.keyboard.up('Alt');
  };

  await altClick();
  expect((await selectedRowIds(page))[0], '第一次 Alt 单击应选中重叠里最上层').toBe(top.id);

  // 连续 Alt 单击必须能轮到另一个形状 —— 否则就还是「只选最上层」的老行为。
  const visited = new Set<string>();
  for (let i = 0; i < 4; i++) {
    await altClick();
    const cur = (await selectedRowIds(page))[0];
    if (cur) visited.add(cur);
  }
  for (const s of shapes) expect(visited, `轮询没有覆盖到 ${s.id}`).toContain(s.id);
});

test('双击图层名称改名：行内输入、Enter 提交、可撤销', async ({ page }) => {
  await boot(page);
  const clipId = await addTextClip(page);
  await openEditor(page, clipId);
  await insertShape(page, 'rect'); // 第一行 = 最前景 = 这个图形

  const nameLoc = page.locator('[data-testid=typo-layer-row]').first().locator('.name');
  const original = (await nameLoc.textContent())!.trim();

  await nameLoc.dblclick();
  const input = page.getByTestId('layer-rename-input');
  await expect(input).toBeVisible();
  await input.fill('我的元素');
  await input.press('Enter');

  await expect(input).toHaveCount(0);
  await expect(nameLoc, '改名没有反映到图层行').toHaveText('我的元素');

  // 一笔撤销能把名字还原。
  await page.keyboard.press('Control+z');
  await expect(nameLoc).toHaveText(original);

  // 清空再回车 = 不改名（也不落一笔空记录）。
  await nameLoc.dblclick();
  await expect(input).toBeVisible();
  await input.fill('');
  await input.press('Enter');
  await expect(nameLoc).toHaveText(original);
});

test('双击组行的非名称区域仍展开/折叠；双击名称区是改名', async ({ page }) => {
  await boot(page);
  const clipId = await addTextClip(page);
  await openEditor(page, clipId);
  await insertShape(page, 'rect');
  await page.keyboard.press('Control+a');
  await page.keyboard.press('Control+g');

  const group = page.getByTestId('typo-layer-group');
  await expect(group).toHaveCount(1);
  // 组合默认折叠：成员不单独出行。
  expect(await page.getByTestId('typo-layer-row').count()).toBe(0);

  // 双击组行**名称区以外**（成员计数）→ 展开。
  await group.locator('.count').dblclick();
  await expect.poll(() => page.getByTestId('typo-layer-row').count()).toBe(2);

  // 双击**名称区** → 出现改名输入框，而不是把组折叠掉。
  await group.locator('.name').dblclick();
  await expect(page.getByTestId('layer-rename-input')).toBeVisible();
  expect(await page.getByTestId('typo-layer-row').count(), '改名不该顺带折叠组').toBe(2);

  await page.getByTestId('layer-rename-input').fill('我的组');
  await page.getByTestId('layer-rename-input').press('Enter');
  await expect(group.locator('.name')).toHaveText('我的组');
});

/**
 * 脚本列表的刷新是**派生值身份**问题：脚本对象是原地改的，`$derived` 若返回
 * 同一批引用，Svelte 会按 `===` 认定「没变」。表现是新增/删除后列表不动，
 * 直到点一下别的东西。`ScriptPanel` 因此必须返回浅拷贝。
 */
test('脚本页签：新增 / 删除脚本后列表立刻刷新', async ({ page }) => {
  await boot(page);
  const clipId = await addTextClip(page);
  await openEditor(page, clipId);
  await page.getByTestId('typo-tab-script').click();
  await expect(page.getByTestId('typo-script-panel')).toBeVisible();

  const rows = page.getByTestId('typo-script-row');
  await expect(rows).toHaveCount(0);

  await page.getByTestId('typo-script-add').click();
  await expect(rows).toHaveCount(1);
  await page.getByTestId('typo-script-add').click();
  await expect(rows).toHaveCount(2);

  await page.getByTestId('typo-script-remove').first().click();
  await expect(rows).toHaveCount(1);
  await page.getByTestId('typo-script-remove').first().click();
  await expect(rows).toHaveCount(0);
});

/**
 * 「转为图片」：整段排版权 → 一张 image 素材，`clip.source` 从 text 换成 image。
 *
 * 这是**唯一**覆盖这条链的用例。删掉 `m6.spec.ts` 里那条手工
 * `registerImageAsset()` 的用例之后（它测的是 image 片段的渲染，不是这个入口），
 * 没有第二个地方能发现「烘出来的图没登记」或「换源之后撤销坏了」。
 */
test('转为图片：源变 image、素材已登记、且是一笔撤销', async ({ page }) => {
  await boot(page);
  const clipId = await addTextClip(page);
  await openEditor(page, clipId);

  await page.getByTestId('ribbon-tab-anim').click();
  await page.getByTestId('typo-flatten').click();

  // 源已经不是 text，编辑页必须自己关掉（留着会指向不存在的文档）。
  await expect(page.getByTestId('typo-editor')).toHaveCount(0);

  const after = await page.evaluate((id) => {
    const A = (window as never as { __artmatic: Hooks }).__artmatic;
    for (const t of A.store.project.tracks) {
      for (const c of t.clips) {
        if (c.id !== id) continue;
        const assetId = c.source?.assetId ?? null;
        return {
          type: c.source?.type ?? null,
          assetId,
          registered: assetId ? (A.store.project.assets[assetId]?.kind ?? null) : null,
          bytes: assetId ? A.assets.size(assetId) : 0,
        };
      }
    }
    return null;
  }, clipId);

  expect(after, '片段在工程里找不到了').not.toBeNull();
  expect(after!.type).toBe('image');
  expect(after!.registered, '素材没登记 → 重开工程后这张图丢失').toBe('image');
  // 空图 / toBlob 失败时的极小数：1920×1080 的文字图不可能低于这个量级。
  expect(after!.bytes ?? 0, '烘出来的 PNG 小到不像有内容（空图也会「成功」）').toBeGreaterThan(2000);

  /*
   * **一笔撤销必须同时回退「换源」与「登记」**。
   *
   * 这两笔曾经是两个独立 commit：栈顶是登记，第一下 Ctrl+Z 只把 `assets[assetId]`
   * 撤掉，而片段已经指向它 —— 画面当场变离线占位符，再撤一次才回到文字。
   * 所以下面两条断言必须同时成立，只断 source 的话，那个缺陷会以
   * 「撤销一次后图没了」的形式漏过去。
   */
  const undone = await page.evaluate((id) => {
    const A = (window as never as { __artmatic: Hooks }).__artmatic;
    A.store.undo();
    for (const t of A.store.project.tracks) {
      for (const c of t.clips) {
        if (c.id !== id) continue;
        const assetId = c.source?.assetId ?? null;
        return {
          type: c.source?.type ?? null,
          stillRegistered: assetId ? Boolean(A.store.project.assets[assetId]) : null,
        };
      }
    }
    return null;
  }, clipId);

  expect(undone!.type, '撤销一次没回到文字 → 那次操作被拆成了多笔').toBe('text');
  expect(undone!.stillRegistered, '撤销后素材登记还在 → 留下一条孤儿').not.toBe(true);
});
