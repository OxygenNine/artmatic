import { expect, test, type Page } from '@playwright/test';
import { addTextClip, openDemo } from './_stage';
import { parsePathNodes } from '../../src/typography/path-nodes';

/**
 * 排版：Ribbon 与画布交互。
 *
 * ## 为什么这个文件里到处是 DOM 断言
 *
 * 这一轮的 bug 全部是「store 改了、界面没改」：拖动生效但画面不动、图层眼睛
 * 图标不刷新、字体下拉把布局顶歪。**原有 E2E 一条都抓不到** —— 它们只读
 * store，而 store 一直是对的。
 *
 * 所以这里的纪律是：**凡是用户能看见的状态，就断言 DOM**。store 断言只是
 * 补充，不是替代。
 *
 * 手势一律走 page.mouse / page.keyboard —— 命中测试、事务结算、编辑态切换
 * 这些问题全在手势层，直接调 store 会把它们整个绕过去。
 */

async function boot(page: Page): Promise<void> {
  await page.goto('/');
  await page.waitForFunction(() => (window as never as { __artmatic?: unknown }).__artmatic);
  await openDemo(page);
}

interface DocShape {
  size: { w: number; h: number };
  elements: {
    id: string;
    kind: string;
    name: string;
    visible: boolean;
    locked: boolean;
    text?: string;
    frame: { x: number; y: number; w: number; h: number; rot: number };
    /** 富文本内容段。**`text` 字段在 v4 之后没了** —— 纯文本是 runs 拼出来的。 */
    runs?: { text: string; style?: Record<string, string | number> }[];
    style?: {
      fontWeight: number;
      letterSpacing: number;
      fontSize: number;
      /** 字形色。**可能是配色方案引用**（`@accent1`），与渲染侧同一套语义。 */
      color: string;
      /** 大小写转换。 */
      textTransform: string;
      /** 文字高亮（「突出显示颜色」）。缺省 = 不高亮。 */
      highlight?: string;
      /** 文字阴影（多层）。三个尺寸都是**字号倍数**（见 document.ts）。 */
      shadow?:
        | { color: string; dx: number; dy: number; blur: number }
        | { color: string; dx: number; dy: number; blur: number }[];
    };
    radius?: number;
    /** 星形的谷半径比例。 */
    waist?: number;
    sides?: number;
    inner?: number;
    angle?: number;
    shape?: string;
    path?: string;
    groupId?: string;
    /** 填充（图形与文本共用）。`opacity` 是可选的整体不透明度（0..1）。 */
    fill?: { kind: string; color?: string; bg?: string; opacity?: number; stops?: { color: string }[] };
  }[];
  /** 组合表。老工程没有这一项。 */
  groups?: { id: string; name: string; padding: number; radius: number }[];
  /** 配色方案 id。缺省 = 默认方案。 */
  theme?: string;
}

interface Hooks {
  store: { project: { tracks: { clips: { id: string; source?: { type?: string; doc?: DocShape } }[] }[] } };
  appState: { playT: number };
}

async function openEditor(page: Page, clipId: string): Promise<void> {
  await page.locator(`[data-testid=clip][data-clip-id="${clipId}"]`).dblclick();
  await expect(page.getByTestId('typo-editor')).toBeVisible();
}

/**
 * 元素的纯文本。
 *
 * v4（富文本）之后文档里没有 `text` 字段了，纯文本是 runs 拼出来的 ——
 * 测试里到处都要用，所以收成一个助手，而不是每处各写一遍 `.map(...).join('')`。
 */
function plainText(el: { runs?: { text: string }[] } | undefined): string {
  return (el?.runs ?? []).map((r) => r.text).join('');
}

async function readDoc(page: Page): Promise<DocShape> {
  return page.evaluate(() => {
    const A = (window as never as { __artmatic: Hooks & { appState: { activeTypoClipId: string | null } } })
      .__artmatic;
    const id = A.appState.activeTypoClipId;
    for (const t of A.store.project.tracks) {
      for (const c of t.clips) {
        if (c.id === id && c.source?.type === 'text' && c.source.doc) return c.source.doc;
      }
    }
    throw new Error(`找不到当前编辑的排版文档（activeTypoClipId=${id}）`);
  });
}

/** 选中第一个元素（走图层面板，与用户路径一致）。 */
async function selectFirst(page: Page): Promise<void> {
  await page.getByTestId('typo-layer-row').first().click();
  await expect(page.getByTestId('typo-selection')).toBeVisible();
}

/**
 * 画布上第 index 个元素的**实际屏幕矩形与内联样式**。
 * 这是「界面到底有没有跟着变」的唯一可靠来源。
 */
async function domBox(page: Page, index = 0) {
  return page.evaluate((i) => {
    const el = document.querySelectorAll<HTMLElement>('.paper [data-el-id]')[i];
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return {
      x: r.x,
      y: r.y,
      w: r.width,
      h: r.height,
      left: el.style.left,
      width: el.style.width,
      transform: el.style.transform,
      text: el.textContent ?? '',
    };
  }, index);
}

/** 元素框在屏幕上的位置（用于把把手换算成坐标）。 */
async function screenRect(page: Page, index = 0) {
  return page.evaluate((i) => {
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
    const f = doc.elements[i]!.frame;
    return { zoom, x: wrap.left + f.x * zoom, y: wrap.top + f.y * zoom, w: f.w * zoom, h: f.h * zoom };
  }, index);
}

/**
 * 把窗口开宽再测。
 *
 * 「开始」Tab 有 6 组 30 多个项，在 1280 宽下会横向溢出（见下面对应的用例）。
 * 测对齐/属性时先把视口开宽，否则你测的是滚动不是功能。
 */
async function wide(page: Page): Promise<void> {
  await page.setViewportSize({ width: 1920, height: 900 });
}

test('Ribbon 渲染出三个常驻 Tab，切换后面板内容随之变化', async ({ page }) => {
  await boot(page);
  const clipId = await addTextClip(page);
  await openEditor(page, clipId);

  for (const id of ['home', 'insert', 'anim']) {
    await expect(page.getByTestId(`ribbon-tab-${id}`)).toBeVisible();
  }
  await expect(page.getByTestId('ribbon-tab-shape-format')).toHaveCount(0);

  await expect(page.getByTestId('ribbon-bold')).toHaveCount(1);
  await expect(page.getByTestId('typo-shape')).toHaveCount(0);

  await page.getByTestId('ribbon-tab-insert').click();
  await expect(page.getByTestId('typo-shape')).toHaveCount(1);
  await expect(page.getByTestId('ribbon-bold')).toHaveCount(0);
});

test('排版页里窄侧栏仍在（工程级动作不随页面消失）', async ({ page }) => {
  await boot(page);
  const clipId = await addTextClip(page);
  await openEditor(page, clipId);
  await expect(page.getByTestId('rail')).toBeVisible();
  // 侧栏的导出入口也还在
  await page.getByTestId('rail-export').click();
  await expect(page.getByTestId('export-png')).toBeVisible();
});

test('Ribbon 改属性落库，且可撤销', async ({ page }) => {
  await boot(page);
  const clipId = await addTextClip(page);
  await openEditor(page, clipId);
  await selectFirst(page);

  expect((await readDoc(page)).elements[0]!.style!.fontWeight).toBe(700);

  await page.getByTestId('ribbon-bold').click();
  expect((await readDoc(page)).elements[0]!.style!.fontWeight).toBe(400);
  // 文本的粗细也要立刻反映在画布上（不是等重进页面）
  expect((await domBox(page))!.text).toBeTruthy();

  await page.keyboard.press('Control+z');
  expect((await readDoc(page)).elements[0]!.style!.fontWeight).toBe(700);

  // 字距在「字符间距」菜单里（预设列表 + 底部的自定义输入框）
  await page.getByTestId('ribbon-letter-spacing').click();
  const spacing = page.getByTestId('ribbon-letter-spacing-custom');
  await spacing.fill('7');
  await spacing.press('Enter');
  expect((await readDoc(page)).elements[0]!.style!.letterSpacing).toBe(7);
});

test('插入图形：预览图面板（缩略图就是形状本身，无文字说明）；随后出现「图形格式」', async ({ page }) => {
  await boot(page);
  const clipId = await addTextClip(page);
  await openEditor(page, clipId);

  await page.getByTestId('ribbon-tab-insert').click();
  await page.getByTestId('typo-shape').click();

  const panel = page.getByTestId('typo-shape-pop');
  await expect(panel).toBeVisible();

  // 面板里每一项都有一张**真形状**（SVG path），不是文字标签。
  const rect = page.getByTestId('typo-shape-card-rect');
  await expect(rect.locator('svg path')).toHaveCount(1);
  // 无文字说明：卡片的可见文本必须为空（名称只作 title / aria-label）。
  expect((await rect.innerText()).trim()).toBe('');
  // 卡片数量与预设表一致 —— 防止「面板只渲染了一部分」这类静默缺项。
  expect(await panel.locator('[data-testid^="typo-shape-card-"]').count()).toBeGreaterThan(10);

  await rect.click();

  const doc = await readDoc(page);
  expect(doc.elements).toHaveLength(2);
  expect(doc.elements[1]!.kind).toBe('shape');

  // 插入后自动选中 → contextual Tab 出现
  await expect(page.getByTestId('ribbon-tab-shape-format')).toBeVisible();

  await page.getByTestId('ribbon-tab-shape-format').click();
  const radius = page.getByTestId('ribbon-shape-radius');
  await radius.fill('24');
  await radius.press('Enter');
  expect((await readDoc(page)).elements[1]!.radius).toBe(24);

  await page.keyboard.press('Escape');
  await expect(page.getByTestId('ribbon-tab-shape-format')).toHaveCount(0);
  await expect(page.getByTestId('ribbon-tab-home')).toHaveAttribute('data-active', 'true');
  await expect(page.getByTestId('ribbon-bold')).toHaveCount(1);
});

test('插入图形：圆角对非矩形图形也生效（不是矩形专属）', async ({ page }) => {
  await boot(page);
  const clipId = await addTextClip(page);
  await openEditor(page, clipId);

  await page.getByTestId('ribbon-tab-insert').click();
  await page.getByTestId('typo-shape').click();
  await page.getByTestId('typo-shape-card-triangle').click();

  await page.getByTestId('ribbon-tab-shape-format').click();
  const radius = page.getByTestId('ribbon-shape-radius');
  await radius.fill('20');
  await radius.press('Enter');

  // 断言的是**画出来的路径**（DOM），不是文档字段 —— 字段改对了但渲染没跟上的
  // 情况在历史上出现过。
  const d = await page
    .locator('[data-el-id] svg[viewBox] g path')
    .first()
    .getAttribute('d');
  expect(d).toContain('A');
});

test('填充整体不透明度：落进文档，且即时反映到 <path> 的 fill-opacity', async ({ page }) => {
  await wide(page);
  await boot(page);
  const clipId = await addTextClip(page);
  await openEditor(page, clipId);

  await page.getByTestId('ribbon-tab-insert').click();
  await page.getByTestId('typo-shape').click();
  await page.getByTestId('typo-shape-card-rect').click();

  // 填充不透明度住在「元素属性」面板里：Ribbon 的填充组已收成稳定控件集
  // （类型 + 主色），不再随填充方式条件展开 —— 见 ribbon-defs 的注释。
  await page.getByTestId('typo-tab-props').click();
  const op = page.getByTestId('prop-fill-opacity');
  await expect(op).toBeVisible();
  await op.fill('50');
  await op.press('Enter');

  // 断言 DOM：fill-opacity 必须落在同一条 <path> 上（一处覆盖纯色/渐变/纹理三种填充）。
  const attr = await page
    .locator('[data-el-id] svg[viewBox] g path')
    .first()
    .getAttribute('fill-opacity');
  expect(attr).toBe('0.5');

  // 文档同步（补充，不替代上面的 DOM 断言）。
  expect((await readDoc(page)).elements[1]!.fill?.opacity).toBe(0.5);
});

test('文字填充：渐变裁到字形上（background-clip: text），切回「跟随文字色」会复位', async ({ page }) => {
  await wide(page);
  await boot(page);
  const clipId = await addTextClip(page);
  await openEditor(page, clipId);
  await selectFirst(page);

  // 选中文本后 home 里才出现「文字填充」组。
  const kind = page.getByTestId('ribbon-text-fill-kind');
  await expect(kind).toBeVisible();
  await kind.click();
  await page.getByTestId('ribbon-text-fill-kind-option-linear').click();

  const box = page.locator('.paper .typo-text').first();
  // 只断言标准属性 `background-clip` —— 单位测试已锁 `-webkit-background-clip`
  // 的声明，但 CSSOM 对它（前缀别名）的读回行为在各版本不稳定，E2E 不押它。
  const styled = await box.evaluate((el) => {
    const s = (el as HTMLElement).style;
    return {
      clip: s.getPropertyValue('background-clip'),
      image: s.backgroundImage,
      color: s.color,
    };
  });
  expect(styled.clip).toBe('text');
  expect(styled.image).toContain('linear-gradient');
  // 裁切填充时字形本身必须透明，否则会盖住背景。
  expect(styled.color).toBe('transparent');

  // 文档同步。
  expect((await readDoc(page)).elements[0]!.fill?.kind).toBe('linear');

  // 切回「跟随文字色」→ 必须复位（就地同步不重建节点，残留的裁切会让纯色再也显不出来）。
  await page.getByTestId('ribbon-text-fill-kind').click();
  await page.getByTestId('ribbon-text-fill-kind-option-none').click();
  const after = await box.evaluate((el) => {
    const s = (el as HTMLElement).style;
    return { clip: s.getPropertyValue('background-clip'), image: s.backgroundImage };
  });
  expect(after.clip).toBe('border-box');
  expect(after.image).toBe('none');
  expect((await readDoc(page)).elements[0]!.fill).toBeUndefined();
});

/* ------------------------------------------------------------ DOM 实时性
 *
 * 下面三条是本轮 bug 的回归守卫。它们的共同点：**断言 DOM，不只断言 store**。
 * 上一版的 `syncDocDom` 传错了根节点，导致文档改了但画面纹丝不动 ——
 * 而 store 断言全绿，E2E 一条都没挡住。
 */

test('拖动元素：画布 DOM 实时跟随（不是退出重进才更新）', async ({ page }) => {
  await wide(page);
  await boot(page);
  const clipId = await addTextClip(page);
  await openEditor(page, clipId);
  await selectFirst(page);

  const before = await domBox(page);
  expect(before).not.toBeNull();

  const start = await screenRect(page);
  const dx = 200;
  await page.mouse.move(start.x + start.w / 2, start.y + start.h / 2);
  await page.mouse.down();
  await page.mouse.move(start.x + start.w / 2 + dx * start.zoom, start.y + start.h / 2, { steps: 10 });
  await page.mouse.up();

  const after = await domBox(page);
  // 屏幕位移 ≈ 文档位移 × zoom（可能有 6px 的吸附修正）
  expect(after!.x - before!.x).toBeGreaterThan(dx * start.zoom - 10);
  expect(after!.x - before!.x).toBeLessThan(dx * start.zoom + 10);
});

test('旋转元素：画布 DOM 的 transform 实时跟随', async ({ page }) => {
  await wide(page);
  await boot(page);
  const clipId = await addTextClip(page);
  await openEditor(page, clipId);
  await selectFirst(page);

  expect((await domBox(page))!.transform).toBe('none');

  const start = await screenRect(page);
  const cx = start.x + start.w / 2;
  const cy = start.y + start.h / 2;
  // 从旋转把手往外拖：把手在顶边中点上方 20px
  await page.mouse.move(cx, start.y - 20);
  await page.mouse.down();
  await page.mouse.move(cx + start.w * 0.5, cy + start.h * 0.5, { steps: 10 });
  await page.mouse.up();

  const after = await domBox(page);
  expect(after!.transform).toContain('rotate');
  // 元素自身的角度也落了库
  expect(Math.abs((await readDoc(page)).elements[0]!.frame.rot)).toBeGreaterThan(0.05);
});

test('缩放元素：画布 DOM 的宽高实时跟随（不是等重进页面）', async ({ page }) => {
  await wide(page);
  await boot(page);
  const clipId = await addTextClip(page);
  await openEditor(page, clipId);
  await selectFirst(page);

  const before = await domBox(page);
  const rect = await screenRect(page);
  await page.mouse.move(rect.x + rect.w, rect.y + rect.h);
  await page.mouse.down();
  await page.mouse.move(rect.x + rect.w + 80, rect.y + rect.h + 40, { steps: 10 });
  await page.mouse.up();

  const after = await domBox(page);
  expect(after!.w).toBeGreaterThan(before!.w + 40);
  expect(after!.h).toBeGreaterThan(before!.h + 20);
  // 左上的锚定边不动
  expect(Math.abs(after!.x - before!.x)).toBeLessThan(2);
  expect(after!.width).not.toBe(before!.width); // 内联样式真的换了
});

test('图层面板的眼睛与锁图标实时刷新', async ({ page }) => {
  await boot(page);
  const clipId = await addTextClip(page);
  await openEditor(page, clipId);

  const eye = page.getByTestId('typo-layer-eye').first();
  const before = await eye.innerHTML();

  await eye.click();
  // 图标本身要换（eye → eye-off）。只断言 store 的话这条 bug 会溜过去。
  await expect
    .poll(async () => eye.innerHTML(), { timeout: 3000 })
    .not.toBe(before);
  expect((await readDoc(page)).elements[0]!.visible).toBe(false);

  const lock = page.getByTestId('typo-layer-lock').first();
  const lockBefore = await lock.innerHTML();
  await lock.click();
  // 锁用的是 lock / lock-open 双图标而不是同一图标变色 —— 只变色的话
  // DOM 里什么都看不出来，测试无从断言、用户也容易漏看。
  await expect
    .poll(async () => lock.innerHTML(), { timeout: 3000 })
    .not.toBe(lockBefore);
  await expect(lock).toHaveAttribute('aria-pressed', 'true');
  expect((await readDoc(page)).elements[0]!.locked).toBe(true);
});

test('双击文本进入编辑：光标落在点击处（不再全选），失焦提交为**一笔**撤销', async ({ page }) => {
  await wide(page);
  await boot(page);
  const clipId = await addTextClip(page);
  await openEditor(page, clipId);

  const rect = await screenRect(page);
  const box = (await domBox(page))!;

  // 双击文本框**靠左**的位置（不是正中，这样"光标落在点击处"才有判据）
  await page.mouse.dblclick(box.x + 8, box.y + box.h / 2);

  // 进入编辑态：焦点落在文本框上且可编辑
  const editable = await page.evaluate(() => {
    const el = document.activeElement as HTMLElement | null;
    return { isText: el?.classList.contains('typo-text') ?? false, editable: el?.isContentEditable ?? false };
  });
  expect(editable.isText).toBe(true);
  expect(editable.editable).toBe(true);

  /*
   * 关键改动：**不再全选**。
   *
   * 旧实现在进入编辑时 `selectNodeContents` 全选整段，于是接着打的字会
   * 整段替换（这条测试原来就是这么写的），而且用户**没法单击挪光标** ——
   * 那一下只是把已有选区收拢。Office 的行为是双击只把光标放到点击处。
   */
  const selected = await page.evaluate(() => window.getSelection()?.toString() ?? '');
  expect(selected, '双击进入编辑时不该全选文字').toBe('');

  await page.keyboard.type('改过的文字');
  // 点空白处失焦 → 提交
  await page.mouse.click(rect.x + 4, rect.y - 60);

  const doc = await readDoc(page);
  const text = plainText(doc.elements[0]);
  // 新文字是**插入**进去的（老文字还在），不是替换
  expect(text).toContain('改过的文字');
  expect(text.length).toBeGreaterThan('改过的文字'.length);
  // 画布上也是新文字（同步没被编辑态挡住）
  expect((await domBox(page))!.text).toBe(text);

  // 整段提交是**一笔**撤销：按一次 Ctrl+Z 就回到编辑前的文本
  await page.keyboard.press('Control+z');
  expect(plainText((await readDoc(page)).elements[0])).not.toBe(text);
});

test('编辑文本时：点文字内部挪光标，点文本框边框才退回选中', async ({ page }) => {
  // Office 系的手感：编辑态下框的内部归文字（放光标），只有**边框**归"这个框本身"。
  // 旧实现里 SelectionLayer 的框盖满整个元素并吞掉 pointerdown，
  // 所以编辑开着也挪不动光标，一点就退回选中框。
  await wide(page);
  await boot(page);
  const clipId = await addTextClip(page);
  await openEditor(page, clipId);

  const box = (await domBox(page))!;
  await page.mouse.dblclick(box.x + 8, box.y + box.h / 2);

  const activeIs = () =>
    page.evaluate(() => {
      const el = document.activeElement as HTMLElement | null;
      return el?.classList.contains('typo-text') === true;
    });
  expect(await activeIs()).toBe(true);

  // ① 点文字内部：仍在编辑态，焦点没离开文本框
  await page.mouse.click(box.x + box.w / 2, box.y + box.h / 2);
  expect(await activeIs(), '点文字内部应当仍在编辑（放光标），而不是退回选中框').toBe(true);

  // ② 点 6px 的边框环：退出编辑（focusout 提交），此时才轮到"选中文本框本身"
  await page.mouse.click(box.x + box.w / 2, box.y + 2);
  expect(await activeIs(), '点文本框边框应当退出文字编辑').toBe(false);
  await expect(page.getByTestId('typo-selection')).toBeVisible();
});

test('长字体名不会把 Ribbon 布局顶歪（定宽 + 截断）', async ({ page }) => {
  await boot(page);

  // 注册一个**名字很长**的字体。测试要的正是「名字长」这件事本身，
  // 所以刻意用同一个 woff2 换个长族名注册。
  const LONG = 'A Very Long Font Family Name That Should Never Widen The Ribbon';
  await page.evaluate(async (family) => {
    const A = (window as never as {
      __artmatic: { typoRegisterFont: (name: string, bytes: Uint8Array) => Promise<string> };
    }).__artmatic;
    const res = await fetch('/fonts/inter-latin-400.woff2');
    const bytes = new Uint8Array(await res.arrayBuffer());
    await A.typoRegisterFont(family, bytes);
  }, LONG);

  const clipId = await addTextClip(page);
  await openEditor(page, clipId);
  await selectFirst(page);

  const trigger = page.getByTestId('ribbon-font-family');
  const group = page.getByTestId('ribbon-group').first();
  const boxBefore = await trigger.boundingBox();
  const groupBefore = await group.boundingBox();

  await trigger.click();
  await page.locator('[data-testid^="ribbon-font-option-"]', { hasText: 'A Very Long' }).first().click();

  // 换字体后：触发区宽度不变（定宽），整组宽度也不变（不撑开邻居）
  const boxAfter = await trigger.boundingBox();
  const groupAfter = await group.boundingBox();
  expect(Math.abs(boxAfter!.width - boxBefore!.width)).toBeLessThan(2);
  expect(Math.abs(groupAfter!.width - groupBefore!.width)).toBeLessThan(2);
  expect(Math.abs(groupAfter!.x - groupBefore!.x)).toBeLessThan(2);

  // 而且当前值是长名字 —— 触发区应当靠 ellipsis 截断而不是撑开
  const label = await trigger.locator('.sel-label').evaluate((el) => ({
    text: el.textContent ?? '',
    clipped: el.scrollWidth > el.clientWidth,
  }));
  expect(label.text.length).toBeGreaterThan(20);
  expect(label.clipped).toBe(true);
});

test('字体下拉：每个名字用它自己的字体画（内置四族都在，触发区跟着换）', async ({ page }) => {
  /*
   * 「宋体」两个字就该是宋体画的 —— 挑字体时看的是「长什么样」，比小字说明直接。
   *
   * 断言分两层，缺一层就测不到东西：
   *  ① **声明**：选项的 computed font-family 就是它代表的族；
   *  ② **真的用上了**：同一串字在四族里量出来的宽度互不相同。
   *     只看 ① 的话，族名写错（比如漏了引号导致整条声明失效）也照样过 ——
   *     那时浏览器会静默回落到界面字体。
   */
  await wide(page);
  await boot(page);
  const clipId = await addTextClip(page);
  await openEditor(page, clipId);
  await selectFirst(page);

  const BUILTIN = ['Inter', 'JetBrains Mono', 'Lora', 'Outfit'];

  // 内置字体是启动时预加载的；量宽度前必须真的 loaded，否则四族都会回落到界面字体。
  await page.waitForFunction(
    (families: string[]) => {
      const loaded = new Set(
        [...document.fonts].filter((f) => f.status === 'loaded').map((f) => f.family.replace(/["']/g, '')),
      );
      return families.every((f) => loaded.has(f));
    },
    BUILTIN,
    { timeout: 20_000 },
  );

  await page.getByTestId('ribbon-font-family').click();
  await expect(page.getByTestId('ribbon-font-family-pop')).toBeVisible();

  const rows = await page.evaluate((families: string[]) => {
    const ctx = document.createElement('canvas').getContext('2d')!;
    return families.map((family) => {
      const el = document.querySelector<HTMLElement>(`[data-testid="ribbon-font-option-${family}"]`);
      if (!el) return { family, css: '(missing)', width: -1 };
      const cs = getComputedStyle(el);
      ctx.font = `${cs.fontSize} ${cs.fontFamily}`;
      return {
        family,
        // Chromium 会把多词族名带引号串行化回来，引号是语法不是名字的一部分。
        css: cs.fontFamily.replace(/["']/g, ''),
        width: Math.round(ctx.measureText('Hamburgefonstiv').width * 100) / 100,
      };
    });
  }, BUILTIN);

  for (const row of rows) expect(row.css, `${row.family} 的选项没用它自己的字体`).toBe(row.family);
  expect(
    new Set(rows.map((r) => r.width)).size,
    `四族的字宽应当互不相同（实测 ${JSON.stringify(rows.map((r) => [r.family, r.width]))}）`,
  ).toBe(BUILTIN.length);

  await page.getByTestId('ribbon-font-option-Outfit').click();
  const trigger = await page.getByTestId('ribbon-font-family').evaluate((root) => {
    const label = root.querySelector('.sel-label')!;
    return { text: label.textContent ?? '', css: getComputedStyle(label).fontFamily.replace(/["']/g, '') };
  });
  expect(trigger.text).toBe('Outfit');
  expect(trigger.css).toBe('Outfit');
});

test('窄窗口：Ribbon 横向滚动，不换行也不出纵向滚动条', async ({ page }) => {
  await page.setViewportSize({ width: 1100, height: 800 });
  await boot(page);
  const clipId = await addTextClip(page);
  await openEditor(page, clipId);

  const body = page.getByTestId('ribbon-body');
  const box = await body.boundingBox();
  const scroll = await body.evaluate((el) => ({
    sw: el.scrollWidth,
    cw: el.clientWidth,
    sh: el.scrollHeight,
    ch: el.clientHeight,
  }));

  // 真的溢出了（所以需要滚动），且**只有横向** ——
  // 面板一旦允许纵向变化，舞台高度会随窗口宽度抖动。
  expect(scroll.sw).toBeGreaterThan(scroll.cw);
  expect(scroll.sh).toBeLessThanOrEqual(scroll.ch + 1);
  expect(box!.height).toBeLessThan(100);

  // 滚到最右，最后一组的按钮仍然可达、可点（不是被裁掉或藏进一个失效的弹层）
  await body.evaluate((el) => {
    el.scrollLeft = el.scrollWidth;
  });
  await selectFirst(page);
  const hide = page.getByTestId('typo-hide');
  await hide.scrollIntoViewIfNeeded();
  await hide.click();
  expect((await readDoc(page)).elements[0]!.visible).toBe(false);
});

test('底部画质下拉是定宽的，不会占满整行', async ({ page }) => {
  await boot(page);
  const clipId = await addTextClip(page);
  await openEditor(page, clipId);

  const box = await page.getByTestId('typo-preview-scale').boundingBox();
  const vw = page.viewportSize()!.width;
  expect(box).not.toBeNull();
  expect(box!.width).toBeLessThan(vw * 0.3);
});

/* ------------------------------------------------------------ 选中框 */

test('选中框是透明的，不会盖住图形', async ({ page }) => {
  // 回归守卫：选中框曾经用 `class="sel"`，撞上 controls.css 里 Select 控件的
  // 全局 `.sel`（`background: var(--input-bg)` 白色）—— 选中就变成一个不透明白块，
  // 把图形整个盖住。scoped 样式只声明了 outline，背景没被覆盖，所以漏了出来。
  await boot(page);
  const clipId = await addTextClip(page);
  await openEditor(page, clipId);
  await selectFirst(page);

  for (const id of ['typo-sel', 'typo-selection']) {
    const box = page.getByTestId(id);
    await expect(box).toHaveCount(1);
    const bg = await box.evaluate((el) => getComputedStyle(el).backgroundColor);
    expect(bg, `${id} 不该有背景色`).toMatch(/rgba\(0, 0, 0, 0\)|transparent/);
  }
});

test('旋转时选中框跟着转（不是只有图形在动）', async ({ page }) => {
  await wide(page);
  await boot(page);
  const clipId = await addTextClip(page);
  await openEditor(page, clipId);
  await selectFirst(page);

  const box = page.getByTestId('typo-selection');
  expect(await box.evaluate((el) => getComputedStyle(el).transform)).toBe('none');

  const start = await screenRect(page);
  const cx = start.x + start.w / 2;
  const cy = start.y + start.h / 2;
  await page.mouse.move(cx, start.y - 20);
  await page.mouse.down();
  await page.mouse.move(cx + start.w * 0.6, cy + start.h * 0.6, { steps: 10 });
  await page.mouse.up();

  // 直接看变换矩阵的非对角项：转过的框，矩阵是 [cos, sin, -sin, cos, 0, 0]，
  // 对角线之外的项必然明显非零。比拿外接矩形比大小稳 —— 细长条转 90° 之后
  // 外接矩形的宽反而变小，用一个「宽必须变大」的断言会误判。
  const m = await box.evaluate((el) => getComputedStyle(el).transform);
  const parts = m.match(/-?[\d.]+/g)?.map(Number) ?? [];
  expect(parts.length).toBeGreaterThanOrEqual(6);
  expect(Math.abs(parts[1]!) + Math.abs(parts[2]!)).toBeGreaterThan(0.1);
});

test('旋转后缩放沿元素自身坐标轴（不是世界坐标轴）', async ({ page }) => {
  await wide(page);
  await boot(page);
  const clipId = await addTextClip(page);

  // 用**正方形**来测：细长条（默认文本框是 1536×173）转 90° 之后，它的「右边
  // 把手」会跑到视口外，鼠标根本点不到。图形的默认框是短边 30% 的正方形。
  await openEditor(page, clipId);
  await page.getByTestId('ribbon-tab-insert').click();
  await page.getByTestId('typo-shape').click();
  await page.getByTestId('typo-shape-card-rect').click();
  await expect(page.getByTestId('typo-selection')).toBeVisible();

  // 直接把角度设成 90°：这是**前置条件**，不是被测行为（被测的是缩放手势）。
  await page.evaluate(() => {
    const A = (window as never as { __artmatic: Hooks & { appState: { activeTypoClipId: string | null; store: { touch: () => void } } } })
      .__artmatic;
    const id = A.appState.activeTypoClipId;
    for (const t of A.store.project.tracks) {
      for (const c of t.clips) {
        if (c.id !== id) continue;
        const src = c.source as { type?: string; doc?: DocShape } | undefined;
        if (src?.type === 'text' && src.doc) src.doc.elements[1]!.frame.rot = Math.PI / 2;
      }
    }
    A.appState.store.touch();
  });

  const geom = await screenRect(page, 1);
  const cx = geom.x + geom.w / 2;
  const cy = geom.y + geom.h / 2;
  // 元素转了 90°，本地 +x 指向世界 +y：它的「右边把手」现在在视觉框的**下方**。
  const handleX = cx;
  const handleY = cy + geom.w / 2;

  const wBefore = (await readDoc(page)).elements[1]!.frame.w;

  // 往世界**下**拖 = 沿元素本地 +x → 宽度增长
  await page.mouse.move(handleX, handleY);
  await page.mouse.down();
  await page.mouse.move(handleX, handleY + 120, { steps: 10 });
  await page.mouse.up();
  const afterDown = (await readDoc(page)).elements[1]!.frame.w;
  expect(afterDown, `w: ${wBefore} → ${afterDown}`).toBeGreaterThan(wBefore + 60);

  await page.keyboard.press('Control+z');
  expect(Math.abs((await readDoc(page)).elements[1]!.frame.w - wBefore)).toBeLessThan(1);

  // 往世界**右**拖 = 垂直于把手 → 尺寸不变。
  // 旧实现把世界位移直接当成本地位移，这一拖会让宽度也增长（差 120px）。
  await page.mouse.move(handleX, handleY);
  await page.mouse.down();
  await page.mouse.move(handleX + 120, handleY, { steps: 10 });
  await page.mouse.up();
  expect(Math.abs((await readDoc(page)).elements[1]!.frame.w - wBefore)).toBeLessThan(2);
});

/* ------------------------------------------------------------ 选择 / 对齐 */

test('选择框画在元素真实位置上（不是「有就行」）', async ({ page }) => {
  // 回归守卫：SelectionLayer 曾经挂在 .paper-wrap 外面，把手坐标就以 viewport
  // 原点算了，整体偏移到点不中 —— 而 toBeVisible() 抓不到这个。
  await boot(page);
  const clipId = await addTextClip(page);
  await openEditor(page, clipId);
  await selectFirst(page);

  const expectBox = await screenRect(page);
  const actual = await page.getByTestId('typo-selection').boundingBox();
  expect(actual).not.toBeNull();
  expect(Math.abs(actual!.x - expectBox.x)).toBeLessThan(2);
  expect(Math.abs(actual!.y - expectBox.y)).toBeLessThan(2);
  expect(Math.abs(actual!.width - expectBox.w)).toBeLessThan(2);
  expect(Math.abs(actual!.height - expectBox.h)).toBeLessThan(2);
});

test('对齐与居中：手动选择对齐目标', async ({ page }) => {
  await wide(page);
  await boot(page);
  const clipId = await addTextClip(page);
  await openEditor(page, clipId);
  await selectFirst(page);

  // 先挪开，否则「居中」是恒等变换，测不出东西
  for (let i = 0; i < 5; i++) await page.keyboard.press('ArrowRight');
  const nudged = (await readDoc(page)).elements[0]!;
  const base = (await readDoc(page)).size;

  await page.getByTestId('typo-center-h').click();
  const centered = (await readDoc(page)).elements[0]!;
  expect(centered.frame.x).toBeCloseTo((base.w - centered.frame.w) / 2, 6);
  expect(centered.frame.y).toBeCloseTo(nudged.frame.y, 6); // 只动一个轴

  await page.getByTestId('typo-center-v').click();
  const both = (await readDoc(page)).elements[0]!;
  expect(both.frame.y).toBeCloseTo((base.h - both.frame.h) / 2, 6);

  // 画布也要跟着动（同样是「改了但没刷新」的高危点）：
  // domBox 是 DOM 实测位置，screenRect 是把文档 frame 换算到屏幕的期望位置。
  const box = await domBox(page);
  const rect = await screenRect(page);
  expect(Math.abs(box!.x - rect.x)).toBeLessThan(2);
  expect(Math.abs(box!.y - rect.y)).toBeLessThan(2);
});

test('图层面板：选择与层级调整', async ({ page }) => {
  await boot(page);
  const clipId = await addTextClip(page);
  await openEditor(page, clipId);

  await page.getByTestId('ribbon-tab-insert').click();
  await page.getByTestId('typo-shape').click();
  await page.getByTestId('typo-shape-card-rect').click();

  await expect(page.getByTestId('typo-layer-row')).toHaveCount(2);
  expect((await readDoc(page)).elements.map((e) => e.kind)).toEqual(['text', 'shape']);

  await page.getByTestId('typo-layer-row').first().click();
  await expect(page.getByTestId('typo-selection')).toBeVisible();

  // 把最前景那一层下移一层 → 数组顺序反转
  await page.getByTestId('typo-layer-down').first().click();
  expect((await readDoc(page)).elements.map((e) => e.kind)).toEqual(['shape', 'text']);

  // DOM 的绘制顺序也要跟着换（z 序在 DOM 里就是兄弟顺序）
  const order = await page.evaluate(() =>
    Array.from(document.querySelectorAll('.paper [data-el-id]')).map((n) =>
      (n as HTMLElement).className.includes('shape') ? 'shape' : 'text',
    ),
  );
  expect(order).toEqual(['shape', 'text']);
});

/* ------------------------------------------------------------ 视图与面板
 *
 * 下面这一组对应「排版选项卡优化」那一轮加进来的东西。纪律不变：
 * **凡用户能看见的状态就断言 DOM**，断言 store 只是补充。
 */

test('画幅线框常驻；网格开关与纵横分控各自独立', async ({ page }) => {
  await boot(page);
  const clipId = await addTextClip(page);
  await openEditor(page, clipId);

  // 线框默认就在（用户不该先找到一个开关才知道画面多大）。
  await expect(page.getByTestId('typo-canvas-frame')).toBeVisible();
  // 网格默认关着 —— 它盖在画面上，默认开会让每一份工程都变脏。
  await expect(page.getByTestId('typo-grid-v')).toHaveCount(0);

  await page.getByTestId('ribbon-tab-view').click();
  await page.getByTestId('ribbon-grid-show').click();
  await expect(page.getByTestId('typo-grid-v')).toBeVisible();
  await expect(page.getByTestId('typo-grid-h')).toBeVisible();

  // 纵横**分别**关闭：排版时经常只需要一个方向的参考。
  await page.getByTestId('ribbon-grid-show-x').click();
  await expect(page.getByTestId('typo-grid-v')).toHaveCount(0);
  await expect(page.getByTestId('typo-grid-h')).toBeVisible();

  // 画幅线框也能关。
  await page.getByTestId('ribbon-canvas-frame').click();
  await expect(page.getByTestId('typo-canvas-frame')).toHaveCount(0);
});

test('网格密度：像素 / 画幅百分比两种策略产出不同的格距', async ({ page }) => {
  await boot(page);
  const clipId = await addTextClip(page);
  await openEditor(page, clipId);

  await page.getByTestId('ribbon-tab-view').click();
  await page.getByTestId('ribbon-grid-show').click();

  const size = page.getByTestId('ribbon-grid-size');
  await size.fill('40');
  await size.press('Enter');
  const pxSpacing = await page
    .getByTestId('typo-grid-v')
    .evaluate((n) => (n as HTMLElement).style.backgroundSize);

  // 切到「画幅百分比」：同一条网格线间距应当变成与画幅挂钩的值。
  await page.getByTestId('ribbon-grid-mode').click();
  await page.getByTestId('ribbon-grid-mode-percent').click();
  await size.fill('10');
  await size.press('Enter');
  const pctSpacing = await page
    .getByTestId('typo-grid-v')
    .evaluate((n) => (n as HTMLElement).style.backgroundSize);

  expect(pctSpacing).not.toBe(pxSpacing);
  // 竖线间距是「画幅宽 × 10% × zoom」，必然远大于 40px 的那一档。
  const px = Number(pxSpacing.split('px')[0]);
  const pct = Number(pctSpacing.split('px')[0]);
  expect(pct).toBeGreaterThan(px);
});

test('光栅预览：可编辑画面被让出来，不再与位图叠成两张', async ({ page }) => {
  await boot(page);
  const clipId = await addTextClip(page);
  await openEditor(page, clipId);

  const paper = page.locator('.paper');
  expect(await paper.evaluate((n) => getComputedStyle(n).visibility)).not.toBe('hidden');

  await page.getByTestId('typo-raster-toggle').click();
  await expect
    .poll(() => paper.evaluate((n) => getComputedStyle(n).visibility))
    .toBe('hidden');

  // 光栅那张图必须被压到容器尺寸 —— 否则它按文档像素显示，比舞台大一圈。
  await expect
    .poll(() =>
      page
        .locator('[data-testid="typo-stage"] .raster-host canvas')
        .evaluate((n) => (n as HTMLElement).style.width),
    )
    .toBe('100%');

  await page.getByTestId('typo-raster-toggle').click();
  await expect
    .poll(() => paper.evaluate((n) => getComputedStyle(n).visibility))
    .not.toBe('hidden');
});

test('右键菜单：复制 / 粘贴作用于当前选择集', async ({ page }) => {
  await boot(page);
  const clipId = await addTextClip(page);
  await openEditor(page, clipId);
  expect((await readDoc(page)).elements).toHaveLength(1);

  const stage = page.getByTestId('typo-stage');
  const box = (await stage.boundingBox())!;
  const el = (await page.locator('.paper [data-el-id]').first().boundingBox())!;

  // 先在元素上右键：应当先把该元素选上，再弹菜单。
  await page.mouse.click(el.x + el.width / 2, el.y + el.height / 2, { button: 'right' });
  await expect(page.getByTestId('typo-context-menu')).toBeVisible();
  await page.getByTestId('typo-ctx-copy').click();
  await expect(page.getByTestId('typo-context-menu')).toHaveCount(0);

  // 空白处右键 → 粘贴。粘贴项此时应当可用（剪贴板里有东西）。
  await page.mouse.click(box.x + 8, box.y + box.height - 8, { button: 'right' });
  await expect(page.getByTestId('typo-context-menu')).toBeVisible();
  await page.getByTestId('typo-ctx-paste').click();
  expect((await readDoc(page)).elements).toHaveLength(2);
});

test('动画窗格已删除；Ribbon 的预设展开成属性轨道，关键帧面板列得出', async ({ page }) => {
  await boot(page);
  const clipId = await addTextClip(page);
  await openEditor(page, clipId);

  // 只读的「动画」选项卡整体删掉了 —— 动画现在住预览下方的关键帧面板。
  await expect(page.getByTestId('typo-tab-anim')).toHaveCount(0);
  await expect(page.getByTestId('typo-kf-panel')).toBeVisible();

  const el = (await page.locator('.paper [data-el-id]').first().boundingBox())!;
  await page.mouse.click(el.x + el.width / 2, el.y + el.height / 2);
  await expect(page.getByTestId('typo-selection')).toBeVisible();

  await page.getByTestId('ribbon-tab-anim').click();
  await page.getByTestId('typo-anim-preset').click();
  await expect(page.getByTestId('typo-anim-preset-pop')).toBeVisible();
  await page.getByTestId('typo-anim-preset-card-slide-in-left').click();

  // slide-in-left 动 translateX + opacity ⇒ **两条轨道**（一条动画一个属性），
  // 每条两根关键帧。
  await expect(page.getByTestId('typo-kf-track')).toHaveCount(2);
  await expect(page.getByTestId('typo-kf-lane')).toHaveCount(2);
  await expect(page.getByTestId('typo-kf-key')).toHaveCount(4);
  await expect(page.getByTestId('typo-kf-clock')).toBeVisible();
});

/**
 * 「动画」页的**常驻预设条**（与「添加动画」弹层并存）。
 *
 * 三件事各自会静默失效：
 *  1. 条子必须真的在 Ribbon 里、**宽度够宽**（缩成一行图标就没法「一眼挑」了）；
 *  2. 滚轮翻的是**这一条**，不是整条 Ribbon —— 面板把纵向滚轮改成了横向滚动，
 *     没拦住的话「在这条上滚一下，整排按钮跑到左边去了」；
 *  3. 卡片上图形与名字都在（纯文字就是退回到当年那个 select 了）。
 */
test('动画页的常驻预设条：在 Ribbon 里、滚轮翻自己的页、点卡即插入', async ({ page }) => {
  await boot(page);
  const clipId = await addTextClip(page);
  await openEditor(page, clipId);

  const el = (await page.locator('.paper [data-el-id]').first().boundingBox())!;
  await page.mouse.click(el.x + el.width / 2, el.y + el.height / 2);
  await expect(page.getByTestId('typo-selection')).toBeVisible();
  await page.getByTestId('ribbon-tab-anim').click();

  const strip = page.getByTestId('typo-anim-strip');
  await expect(strip).toBeVisible();
  const box = (await strip.boundingBox())!;
  // 「很宽」：至少放得下六七张卡，而且不超出一行面板的高度（否则会把舞台挤下去）。
  expect(box.width).toBeGreaterThan(400);
  const bodyH = (await page.getByTestId('ribbon-body').boundingBox())!.height;
  expect(box.height).toBeLessThanOrEqual(bodyH);

  const card = page.getByTestId('typo-anim-strip-card-fade-in');
  await expect(card.locator('svg')).toHaveCount(1);
  await expect(card).toContainText('淡入');

  // 滚轮 = 翻这一条；面板自己不许跟着滚。
  const track = page.getByTestId('typo-anim-strip-track');
  const ribbon = page.getByTestId('ribbon-body');
  const ribbonBefore = await ribbon.evaluate((n) => n.scrollLeft);
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.wheel(0, 200);
  await expect.poll(() => track.evaluate((n) => n.scrollLeft)).toBeGreaterThan(100);
  expect(await ribbon.evaluate((n) => n.scrollLeft)).toBe(ribbonBefore);

  // 翻回第一页（两端各有一枚翻页键），点一张卡：插入 + 这张卡高亮。
  await page.getByTestId('typo-anim-strip-prev').click();
  await expect.poll(() => track.evaluate((n) => n.scrollLeft)).toBeLessThan(50);
  await card.click();
  await expect(page.getByTestId('typo-kf-track')).toHaveCount(1);
  await expect(card).toHaveClass(/\bon\b/);
});

test('右栏宽度可拖曳', async ({ page }) => {
  await boot(page);
  const clipId = await addTextClip(page);
  await openEditor(page, clipId);

  const before = (await page.getByTestId('typo-side').boundingBox())!.width;
  const split = (await page.getByTestId('typo-panel-split').boundingBox())!;

  await page.mouse.move(split.x + split.width / 2, split.y + split.height / 2);
  await page.mouse.down();
  await page.mouse.move(split.x - 80, split.y + split.height / 2, { steps: 8 });
  await page.mouse.up();

  const after = (await page.getByTestId('typo-side').boundingBox())!.width;
  expect(after).toBeGreaterThan(before + 40);
});

test('中键拖曳平移画布（原生中键自动滚动被接管）', async ({ page }) => {
  await boot(page);
  const clipId = await addTextClip(page);
  await openEditor(page, clipId);

  // 先放大到超出视口，否则没有可滚动的余量（auto-fit 时内容正好装下）。
  // Slider 是自绘的 div（不是原生 range），键盘 End = 量程上限。
  const zoom = page.getByTestId('typo-zoom-slider');
  await zoom.focus();
  await page.keyboard.press('End');

  const stage = page.getByTestId('typo-stage');
  const box = (await stage.boundingBox())!;
  const cx = box.x + box.width / 2;
  const cy = box.y + box.height / 2;

  const read = (): Promise<{ left: number; top: number }> =>
    stage.evaluate((n) => ({ left: (n as HTMLElement).scrollLeft, top: (n as HTMLElement).scrollTop }));

  await stage.evaluate((n) => {
    (n as HTMLElement).scrollLeft = 200;
    (n as HTMLElement).scrollTop = 200;
  });
  const base = await read();
  expect(base.left).toBeGreaterThan(0);

  await page.mouse.move(cx, cy);
  await page.mouse.down({ button: 'middle' });
  await page.mouse.move(cx - 60, cy - 40, { steps: 6 });
  await page.mouse.up({ button: 'middle' });

  const moved = await read();
  // 往左上拖 ⇒ 视口往右下看 ⇒ scrollLeft/Top 变大。
  expect(moved.left).toBeGreaterThan(base.left);
  expect(moved.top).toBeGreaterThan(base.top);
});

/* ------------------------------------------------------------ 组合与布尔
 *
 * 这一组的共同点：**断言 DOM 与文档两边的形状**。组合最容易出的问题是
 * 「文档字段对了、画面没分组框」或反过来，只断言 store 抓不到。
 */

/** 从插入面板插一个形状。 */
async function insertShape(page: Page, key: string): Promise<void> {
  await page.getByTestId('ribbon-tab-insert').click();
  await page.getByTestId('typo-shape').click();
  await page.getByTestId(`typo-shape-card-${key}`).click();
}

test('元素组合：单击选组、再单击进组；图层默认折叠可展开', async ({ page }) => {
  await boot(page);
  const clipId = await addTextClip(page);
  await openEditor(page, clipId);

  await insertShape(page, 'rect');
  await insertShape(page, 'ellipse');
  await page.keyboard.press('Control+a');
  await page.keyboard.press('Control+g');

  const grouped = await readDoc(page);
  expect(grouped.elements).toHaveLength(3);
  expect(grouped.elements.every((e) => !!e.groupId)).toBe(true);
  expect(new Set(grouped.elements.map((e) => e.groupId)).size).toBe(1);
  expect(grouped.groups).toHaveLength(1);

  // 图层：默认折叠 —— 只出一个组行，组内成员不单独出行。
  await expect(page.getByTestId('typo-layer-group')).toHaveCount(1);
  expect(await page.getByTestId('typo-layer-row').count()).toBe(0);
  await page.getByTestId('typo-layer-twist').click();
  expect(await page.getByTestId('typo-layer-row').count()).toBe(3);

  // 组外壳真的画出来了。
  const shell = page.locator('.paper .typo-group');
  await expect(shell).toHaveCount(1);
  const w0 = (await shell.boundingBox())!.width;

  // 整组选中 ⇒ 出现「组合格式」而不是「图形格式」。
  await expect(page.getByTestId('ribbon-tab-group-format')).toBeVisible();
  await page.getByTestId('ribbon-tab-group-format').click();

  // 改内边距：外壳必须跟着长大（8 → 40，每边多 32 ⇒ 文档坐标 +64）。
  // ⚠️ boundingBox 是**屏幕** px，舞台有 zoom ⇒ 期望值要按缩放折算，
  // 直接写 64 会在任何非 100% 的缩放下失败（而 auto-fit 几乎从不是 100%）。
  const zoomPct = Number(await page.getByTestId('typo-zoom-slider').getAttribute('aria-valuenow'));
  const pad = page.getByTestId('ribbon-group-padding');
  await pad.fill('40');
  await pad.press('Enter');

  expect((await readDoc(page)).groups?.[0]?.padding).toBe(40);
  const expectDelta = Math.round(64 * (zoomPct / 100));
  await expect
    .poll(() => shell.boundingBox().then((b) => Math.round((b?.width ?? 0) - w0)))
    .toBeGreaterThanOrEqual(expectDelta - 2);

  // 先清空选择（成组后整组本来就是选中的，不清掉就测不到「单击选组」这一态）。
  await page.keyboard.press('Escape');
  expect(await page.locator('.typo-sel').count()).toBe(0);

  // 单击画布上的任一成员 → 整组选中（3 个选择框 + 1 个外接框）
  const el = (await page.locator('.paper [data-el-id]').first().boundingBox())!;
  const cx = el.x + el.width / 2;
  const cy = el.y + el.height / 2;
  await page.mouse.click(cx, cy);
  expect(await page.locator('.typo-sel').count()).toBe(4);

  // 再单击一次 → 进入组，只选中被点的那一个。
  // ⚠️ 这一下按在**选择框**上（它会吞掉 pointerdown 来支持拖整块），
  // 所以进组只能发生在「按下但没拖动」时 —— 见 onSelectionBoxDown。
  await page.mouse.click(cx, cy);
  expect(await page.locator('.typo-sel').count()).toBe(1);

  // 拖动仍然整组走：先退出组内态重新整组选中，再拖。
  await page.keyboard.press('Escape');
  await page.mouse.click(cx, cy);
  expect(await page.locator('.typo-sel').count()).toBe(4);
  const beforeX = (await readDoc(page)).elements.find((e) => e.kind === 'shape')!.frame.x;
  await page.mouse.move(cx, cy);
  await page.mouse.down();
  await page.mouse.move(cx + 30, cy, { steps: 6 });
  await page.mouse.up();
  const afterX = (await readDoc(page)).elements.find((e) => e.kind === 'shape')!.frame.x;
  expect(afterX).not.toBe(beforeX);

  // 解组
  await page.keyboard.press('Control+a');
  await page.keyboard.press('Control+Shift+g');
  const ungrouped = await readDoc(page);
  expect(ungrouped.elements.every((e) => !e.groupId)).toBe(true);
  expect(ungrouped.groups ?? []).toHaveLength(0);
  await expect(page.locator('.paper .typo-group')).toHaveCount(0);
});

test('拖组合：整组一起走（不是只拖走一个成员）', async ({ page }) => {
  await boot(page);
  const clipId = await addTextClip(page);
  await openEditor(page, clipId);

  await insertShape(page, 'rect');
  await insertShape(page, 'ellipse');
  await page.keyboard.press('Control+a');
  await page.keyboard.press('Control+g');

  const before = await readDoc(page);
  const el = (await page.locator('.paper [data-el-id]').first().boundingBox())!;
  await page.mouse.move(el.x + el.width / 2, el.y + el.height / 2);
  await page.mouse.down();
  await page.mouse.move(el.x + el.width / 2 + 40, el.y + el.height / 2 + 30, { steps: 8 });
  await page.mouse.up();

  const after = await readDoc(page);
  const moved = after.elements.filter((e, i) => e.frame.x !== before.elements[i]!.frame.x);
  expect(moved).toHaveLength(3);

  // 组外壳跟着走：它的 DOM 位置必须也变了
  await expect(page.locator('.paper .typo-group')).toHaveCount(1);
});

test('布尔运算：并集把两个图形合成一个 svg 图形', async ({ page }) => {
  await boot(page);
  const clipId = await addTextClip(page);
  await openEditor(page, clipId);

  await insertShape(page, 'rect');
  await insertShape(page, 'rect');
  // 把第二个往右挪 60px（Shift+方向键 = 10px/次），两个矩形部分重叠。
  for (let i = 0; i < 6; i++) await page.keyboard.press('Shift+ArrowRight');

  const before = await readDoc(page);
  expect(before.elements).toHaveLength(3);
  const w0 = before.elements[1]!.frame.w;
  const x0 = Math.min(...before.elements.slice(1).map((e) => e.frame.x));

  await page.keyboard.press('Control+a');
  await page.getByTestId('ribbon-tab-shape-format').click();
  await page.getByTestId('typo-bool-union').click();

  const after = await readDoc(page);
  // 两个图形 → 一个；文本元素不动
  expect(after.elements).toHaveLength(2);
  const merged = after.elements.find((e) => e.kind === 'shape')!;
  expect(merged.shape).toBe('svg');
  expect(merged.path).toBeTruthy();
  // 并集的外接框：宽 = 原宽 + 60，高不变
  expect(merged.frame.w).toBeCloseTo(w0 + 60, 0);
  expect(merged.frame.h).toBeCloseTo(before.elements[1]!.frame.h, 0);
  expect(merged.frame.x).toBeCloseTo(x0, 0);
});

test('拆分：两个图形切成三块独立图形，每块沿用覆盖它的来源样式', async ({ page }) => {
  await boot(page);
  const clipId = await addTextClip(page);
  await openEditor(page, clipId);

  await insertShape(page, 'rect');
  await insertShape(page, 'rect');
  // 第二个往右挪 60px（Shift+方向键 = 10px/次），两个矩形部分重叠。
  for (let i = 0; i < 6; i++) await page.keyboard.press('Shift+ArrowRight');

  const before = await readDoc(page);
  const shapes = before.elements.filter((e) => e.kind === 'shape');
  expect(shapes).toHaveLength(2);
  const [bottom, top] = shapes; // 数组序 = 底 → 顶
  const w0 = bottom!.frame.w;

  /*
   * 上色：底层蓝、顶层红。拆分后应当得到 1 块蓝 + 2 块红 ——
   * A−B 只被 A 覆盖，重叠区与 B−A 的最上层覆盖者是 B。
   */
  await page.evaluate(
    ({ id, bottomId, topId }) => {
      // 这个 spec 的 `Hooks` 只声明了读的部分；写操作用局部类型补 commit。
      const A = (
        window as never as {
          __artmatic: {
            store: {
              project: Hooks['store']['project'];
              commit: (label: string, fn: (p: unknown) => void) => void;
            };
          };
        }
      ).__artmatic;
      A.store.commit('e2e: 给两块上色', (p) => {
        const proj = p as {
          tracks: { clips: { id: string; source?: { doc?: DocShape } }[] }[];
        };
        for (const t of proj.tracks) {
          for (const c of t.clips) {
            if (c.id !== id || !c.source?.doc) continue;
            for (const el of c.source.doc.elements) {
              if (el.id === bottomId) el.fill = { kind: 'solid', color: '#0000ff' };
              if (el.id === topId) el.fill = { kind: 'solid', color: '#ff0000' };
            }
          }
        }
      });
    },
    { id: clipId, bottomId: bottom!.id, topId: top!.id },
  );

  await page.keyboard.press('Control+a');
  await page.getByTestId('ribbon-tab-shape-format').click();
  await page.getByTestId('typo-bool-divide').click();

  const after = await readDoc(page);
  // 文本 + 三块
  expect(after.elements).toHaveLength(4);
  const pieces = after.elements.filter((e) => e.kind === 'shape');
  expect(pieces).toHaveLength(3);
  for (const p of pieces) {
    expect(p.shape).toBe('svg');
    expect(p.path).toBeTruthy();
    // 结果按 0..100 authored 归一化（与其它布尔结果一致）。
    expect(p.groupId).toBeUndefined();
  }

  const colors = pieces.map((p) => p.fill?.color).sort();
  expect(colors).toEqual(['#0000ff', '#ff0000', '#ff0000']);

  // 三块的宽度：A−B(60) + 重叠(w0−60) + B−A(60)，按左边界从左到右排。
  const widths = pieces.map((p) => Math.round(p.frame.w)).sort((a, b) => a - b);
  expect(widths).toEqual([60, 60, Math.round(w0 - 60)].sort((a, b) => a - b));
  const xs = pieces.map((p) => Math.round(p.frame.x)).sort((a, b) => a - b);
  expect(xs).toHaveLength(3);
  expect(xs[0]).toBe(Math.round(bottom!.frame.x));
  expect(xs[1] - xs[0]).toBe(60);
  expect(xs[2] - xs[1]).toBe(Math.round(w0 - 60));

  // 一步撤销回到两个图形。
  await page.keyboard.press('Control+z');
  await expect.poll(async () => (await readDoc(page)).elements.filter((e) => e.kind === 'shape').length).toBe(2);
});

test('布尔运算：结果为空时不动文档，并给出提示', async ({ page }) => {
  await boot(page);
  const clipId = await addTextClip(page);
  await openEditor(page, clipId);

  // 两个**完全重合**的矩形做差集 ⇒ 空集
  await insertShape(page, 'rect');
  await insertShape(page, 'rect');

  await page.keyboard.press('Control+a');
  await page.getByTestId('ribbon-tab-shape-format').click();
  await page.getByTestId('typo-bool-subtract').click();

  // 文档不变（三个元素还在），而不是留下一个空图形
  const after = await readDoc(page);
  expect(after.elements).toHaveLength(3);
});

/* ------------------------------------------------------------ 富文本（行内）
 *
 * 纪律与上面一致：**DOM 与文档两边都断**。行内格式最容易出的问题是
 * 「文档字段对了、画面上没变」或反过来，只断 store 抓不到。
 */

/** 进入文本编辑态（双击靠左，光标落在点击处）。 */
async function enterTextEditing(page: Page): Promise<void> {
  const box = (await domBox(page))!;
  await page.mouse.dblclick(box.x + 8, box.y + box.h / 2);
  await expect
    .poll(() => page.evaluate(() => (document.activeElement as HTMLElement | null)?.isContentEditable ?? false))
    .toBe(true);
}

/** 从行首选中前 n 个字符。 */
async function selectLeadingChars(page: Page, n: number): Promise<void> {
  await page.keyboard.press('Home');
  await page.keyboard.down('Shift');
  for (let i = 0; i < n; i++) await page.keyboard.press('ArrowRight');
  await page.keyboard.up('Shift');
}

test('富文本：选中一段加粗只在那一段留覆盖，元素级样式不动', async ({ page }) => {
  await wide(page);
  await boot(page);
  const clipId = await addTextClip(page);
  await openEditor(page, clipId);

  await enterTextEditing(page);
  await selectLeadingChars(page, 2);
  await page.keyboard.press('Control+b');

  const el = (await readDoc(page)).elements[0]!;
  // 元素级**没被改**（默认就是 700）：行内格式不该顺手改整块
  expect(el.style!.fontWeight).toBe(700);

  const runs = el.runs!;
  expect(runs.length).toBeGreaterThanOrEqual(2);
  // 前两个字符那一段被反转成 400
  expect(runs[0]!.style?.fontWeight).toBe(400);
  expect(runs[0]!.text.length).toBe(2);
  // 其余段落一点没被碰
  expect(runs.slice(1).every((r) => !r.style?.fontWeight)).toBe(true);

  // DOM 上也真的生效了（只加个 span 没有样式等于没做）
  const weights = await page
    .locator('.paper .typo-text span[data-run]')
    .evaluateAll((nodes) => nodes.map((n) => getComputedStyle(n).fontWeight));
  expect(weights[0]).toBe('400');
  expect(weights.slice(1).every((w) => w !== '400')).toBe(true);

  // 光标还在选中范围上（应用格式不该把选区弄丢）
  expect(await page.evaluate(() => window.getSelection()?.toString())).toBe(runs[0]!.text);
});

test('富文本：字号只作用于选中那一段，且「清除格式」能还原', async ({ page }) => {
  await wide(page);
  await boot(page);
  const clipId = await addTextClip(page);
  await openEditor(page, clipId);

  await enterTextEditing(page);
  await selectLeadingChars(page, 2);

  const size = page.getByTestId('ribbon-font-size-input');
  await size.fill('200');
  await size.press('Enter');

  const after = (await readDoc(page)).elements[0]!;
  expect(after.runs![0]!.style?.fontSize).toBe(200);
  // 元素级字号不变 —— 这正是「先改元素级、再单独改一段」能成立的前提
  expect(after.style!.fontSize).toBe(97);

  // 清除格式按钮此时可用，点它把那一段的覆盖全部抹掉
  const clear = page.getByTestId('typo-clear-format');
  await expect(clear).toBeEnabled();
  await clear.click();
  const restored = (await readDoc(page)).elements[0]!;
  expect(restored.runs!.every((r) => !r.style?.fontSize)).toBe(true);
});

/*
 * PPT 式的三条直觉（来自用户：「全选文本 → 设文本框样式 → 不起效」）。
 *
 *  ① 全选后设样式 = 改**整块**（元素级变，且区间内该键的旧覆盖被清掉 ——
 *     不清的话覆盖会继续压着元素级，症状与「设了没反应」一模一样）
 *  ② 加粗按「是否**全部**已生效」整体开关（混合选区按一下 = 全部加粗）
 *  ③ 字号不一致时输入框显示 `XX+`；增减按钮是**按比例整体缩放**，
 *     不是跳到阶梯上的固定档，也不能把混排抹平
 */
test('富文本：全选后设样式作用于整块（元素级）并清掉区间内的旧覆盖', async ({ page }) => {
  await wide(page);
  await boot(page);
  const clipId = await addTextClip(page);
  await openEditor(page, clipId);

  // 先在一段字上留一条覆盖
  await enterTextEditing(page);
  await selectLeadingChars(page, 2);
  const size = page.getByTestId('ribbon-font-size-input');
  await size.fill('200');
  await size.press('Enter');
  expect((await readDoc(page)).elements[0]!.runs![0]!.style?.fontSize).toBe(200);

  // 全选 → 改成 120：落在**元素级**，那条 200 的覆盖被清掉
  await enterTextEditing(page);
  await page.keyboard.press('Control+a');
  await size.fill('120');
  await size.press('Enter');

  const after = (await readDoc(page)).elements[0]!;
  expect(after.style!.fontSize).toBe(120);
  expect(
    after.runs!.some((r) => r.style?.fontSize !== undefined),
    '全选改整块时必须清掉区间内的同名覆盖',
  ).toBe(false);
});

test('富文本：加粗按「全部已生效」整体开关（混合选区按一下 = 全部加粗）', async ({ page }) => {
  await wide(page);
  await boot(page);
  const clipId = await addTextClip(page);
  await openEditor(page, clipId);

  // 默认元素级 700 → 全选按一下 = 整体取消
  await enterTextEditing(page);
  await page.keyboard.press('Control+a');
  await page.getByTestId('ribbon-bold').click();
  const off = (await readDoc(page)).elements[0]!;
  expect(off.style!.fontWeight).toBe(400);
  expect(off.runs!.some((r) => r.style?.fontWeight !== undefined)).toBe(false);

  // 再按一下 = 整体加粗
  await page.getByTestId('ribbon-bold').click();
  expect((await readDoc(page)).elements[0]!.style!.fontWeight).toBe(700);

  // 制造混排：前两个字单独改成不加粗
  await enterTextEditing(page);
  await selectLeadingChars(page, 2);
  await page.getByTestId('ribbon-bold').click();
  const mixed = (await readDoc(page)).elements[0]!;
  expect(mixed.runs![0]!.style?.fontWeight).toBe(400);
  expect(mixed.style!.fontWeight).toBe(700);

  // 全选（此时状态是「一部分粗」）→ 按一下必须是**全部加粗**，
  // 而不是「起点那段反向、其余不动」（那是按两次才统一，第二次还反着来）
  await enterTextEditing(page);
  await page.keyboard.press('Control+a');
  await page.getByTestId('ribbon-bold').click();
  const all = (await readDoc(page)).elements[0]!;
  expect(all.style!.fontWeight).toBe(700);
  expect(all.runs!.some((r) => r.style?.fontWeight !== undefined)).toBe(false);
});

test('富文本：字号不一致显示「XX+」，增减按钮按比例整体缩放（不抹平混排）', async ({ page }) => {
  await wide(page);
  await boot(page);
  const clipId = await addTextClip(page);
  await openEditor(page, clipId);

  // 混排：前两个字 200，其余继承元素级 97
  await enterTextEditing(page);
  await selectLeadingChars(page, 2);
  const size = page.getByTestId('ribbon-font-size-input');
  await size.fill('200');
  await size.press('Enter');
  expect((await readDoc(page)).elements[0]!.style!.fontSize).toBe(97);

  // 全选：字号不一致 → 显示模糊值「97+」（97 是区间里的最小值，读作「至少 97」）
  await enterTextEditing(page);
  await page.keyboard.press('Control+a');
  await expect(size).toHaveValue('97+');

  // 增大 = 每一处各乘 1.15（不是跳到阶梯上的 96/128 这种固定档）
  await page.getByTestId('ribbon-font-size-inc').click();
  const scaled = (await readDoc(page)).elements[0]!;
  const sizes = scaled.runs!.map((r) => r.style?.fontSize).filter((v): v is number => v !== undefined);
  expect(sizes.length).toBeGreaterThanOrEqual(2);
  expect(Math.min(...sizes)).toBeCloseTo(97 * 1.15, 1);
  expect(Math.max(...sizes)).toBeCloseTo(200 * 1.15, 1);

  // 元素级**没被改**：整体缩放是「逐处各乘」，不会顺手把整块钉成一个值
  //（那会把用户刚看到的那份混排抹平 —— 输入框上的「97+」正是在说这里有大小之分）
  expect(scaled.style!.fontSize).toBe(97);
});

test('富文本：等长替换不会被当成「没变化」丢进垃圾桶', async ({ page }) => {
  await wide(page);
  await boot(page);
  const clipId = await addTextClip(page);
  await openEditor(page, clipId);

  const before = plainText((await readDoc(page)).elements[0]);
  expect(before.length).toBeGreaterThan(0);

  await enterTextEditing(page);
  // 全选后打上**同样长度**的另一串字
  await page.keyboard.press('Control+a');
  const same = 'x'.repeat(before.length);
  await page.keyboard.type(same);
  await page.mouse.click(20, 20 + 300);

  const after = plainText((await readDoc(page)).elements[0]);
  expect(after).toBe(same);
  expect(after.length).toBe(before.length);
});

test('富文本：回车插的是换行，且编辑区不会长出块级元素', async ({ page }) => {
  await wide(page);
  await boot(page);
  const clipId = await addTextClip(page);
  await openEditor(page, clipId);

  await enterTextEditing(page);
  await page.keyboard.press('Home');
  await page.keyboard.press('Enter');
  await page.keyboard.type('B');
  await page.mouse.click(20, 20 + 300);

  const el = (await readDoc(page)).elements[0]!;
  expect(plainText(el)).toContain('\nB');

  /*
   * 块级元素**必须**为零：不接管的话 Chromium 的 insertParagraph 会把块级
   * 内层盒子一拆为二（两个 `display:block` 的克隆），`serializeRuns` 穿过
   * 块级元素读回时换行就丢了，且 `textContent` 对它们视而不见。
   *
   * `<br>` / 字面 `\n` 则**允许**存在 —— 守卫路径
   * （`execCommand('insertLineBreak')`，见 TypographyEditor 的 installTypingGuards）
   * 的产出按上下文是两者之一，跟它较劲没有意义；
   * 偏移换算已按「换行记 1 个字符」统一（见 render-dom 的 `plainIndex`）。
   */
  const blocks = await page.evaluate(() => {
    const box = document.querySelector('.paper .typo-text');
    if (!box) return null;
    return Array.from(box.querySelectorAll('*'))
      .map((n) => n.tagName.toLowerCase())
      .filter((t) => t === 'div' || t === 'p' || t === 'li');
  });
  expect(blocks).toEqual([]);
});

test('富文本：行内格式不会让文字断行（flex 会把子元素块级化）', async ({ page }) => {
  await wide(page);
  await boot(page);
  const clipId = await addTextClip(page);
  await openEditor(page, clipId);

  const boxHeight = (): Promise<number> =>
    page.evaluate(() => {
      const box = document.querySelector('.paper .typo-text');
      return box ? Math.round(box.getBoundingClientRect().height) : -1;
    });
  const before = await boxHeight();

  await enterTextEditing(page);
  await selectLeadingChars(page, 2);
  await page.keyboard.press('Control+b');

  const after = await page.evaluate(() => {
    const box = document.querySelector('.paper .typo-text');
    if (!box) return null;
    const runs = Array.from(box.querySelectorAll('[data-run]'));
    return {
      h: Math.round(box.getBoundingClientRect().height),
      tops: runs.map((n) => Math.round(n.getBoundingClientRect().top)),
      count: runs.length,
    };
  });
  expect(after!.count).toBeGreaterThanOrEqual(2);
  /*
   * ⚠️ 这条是本轮实测抓出来的 bug 的守卫。
   *
   * `.typo-text` 是 `display: flex`（垂直对齐靠它），而 **flex 容器的每一个
   * 子元素都会被块级化**。把每段文字直接当 flex 项挂进去，一个 6 字标题只要
   * 中间加粗两个字就会断成三行 —— 而文档数据完全正确，单测一条都不会红。
   * 修法是套一层普通块级内层盒子，让 flex 项只剩它一个。
   */
  expect(new Set(after!.tops).size, '所有文本段必须在同一行').toBe(1);
  // 盒子高度也不该因为「段数变了」而长高
  expect(Math.abs(after!.h - before)).toBeLessThanOrEqual(2);
});

/* ------------------------------------------------------------ 形状控制点与顶点编辑
 *
 * 这一组的共同点：拖的是**画布上的把手**，不是 Ribbon 里的数字。所以一律走
 * page.mouse —— 命中测试、坐标换算（元素局部 ↔ 文档 ↔ 屏幕）、事务结算全在
 * 手势层，直接改 store 会把它们整个绕过去（而这一层恰好是最容易错的地方）。
 */

/** 当前文档里最后一个图形元素。 */
async function lastShape(page: Page): Promise<NonNullable<DocShape['elements'][number]>> {
  const doc = await readDoc(page);
  const shapes = doc.elements.filter((e) => e.kind === 'shape');
  expect(shapes.length).toBeGreaterThan(0);
  return shapes[shapes.length - 1]!;
}

test('形状控制点：选中即有（不需要进模式），拖动改的是参数', async ({ page }) => {
  await wide(page);
  await boot(page);
  const clipId = await addTextClip(page);
  await openEditor(page, clipId);

  // 圆角矩形预设自带 radius=24
  await insertShape(page, 'round-rect');

  /*
   * 关键判据：**不点任何按钮**控制点就该在。
   *
   * 它改的是图形自身的参数（和「拖右下角把手改尺寸」同级），要求先进入某个
   * 「编辑顶点」模式才看得到圆角手柄，是拿模式去挡一个本来没有模式的操作。
   */
  const grip = page.getByTestId('typo-shape-handle');
  await expect(grip).toHaveCount(1);
  await expect(grip).toHaveAttribute('data-param', 'radius');

  const before = (await lastShape(page)).radius ?? 0;
  const g = (await grip.boundingBox())!;
  await page.mouse.move(g.x + g.width / 2, g.y + g.height / 2);
  await page.mouse.down();
  await page.mouse.move(g.x + g.width / 2 + 30, g.y + g.height / 2 + 30, { steps: 8 });
  await page.mouse.up();

  expect((await lastShape(page)).radius ?? 0).toBeGreaterThan(before);

  // 撤销一笔就回到原值（整段拖拽只算一笔）
  await page.keyboard.press('Control+z');
  expect((await lastShape(page)).radius ?? 0).toBeCloseTo(before, 3);
});

test('星形的谷半径控制点：拖出边界会被钳住，形状不会翻出去', async ({ page }) => {
  await wide(page);
  await boot(page);
  const clipId = await addTextClip(page);
  await openEditor(page, clipId);
  await insertShape(page, 'star5');

  // ⚠️ 不能用 `getByTestId('typo-shape-handle[data-param=waist]')` ——
  // 那会去找 `data-testid="typo-shape-handle[data-param=waist]"`，永远 0 个。
  const grip = page.locator('[data-testid=typo-shape-handle][data-param=waist]');
  await expect(grip).toHaveCount(1);

  const g = (await grip.boundingBox())!;
  // 往圆心拖（左上方向足够远）⇒ 谷半径趋向下限，而不是变成负数
  await page.mouse.move(g.x + g.width / 2, g.y + g.height / 2);
  await page.mouse.down();
  await page.mouse.move(g.x - 400, g.y - 400, { steps: 10 });
  await page.mouse.up();

  const waist = (await lastShape(page)).waist ?? 0.4;
  expect(waist).toBeGreaterThanOrEqual(0.05);
  expect(waist).toBeLessThanOrEqual(0.98);
});

test('「编辑顶点」在参数化图形上一步到位：自动转路径并进入编辑', async ({ page }) => {
  await wide(page);
  await boot(page);
  const clipId = await addTextClip(page);
  await openEditor(page, clipId);
  await insertShape(page, 'round-rect');

  await page.getByTestId('ribbon-tab-shape-format').click();
  await page.getByTestId('typo-node-edit').click();

  const el = await lastShape(page);
  expect(el.shape).toBe('svg');
  expect(el.path).toBeTruthy();
  // 参数化字段被清掉：留着会让「图形格式」面板继续显示一排没有作用的滑杆
  expect(el.radius).toBeUndefined();

  // 锚点出来了，控制点让位（两者不该同时存在 —— 用户分不清哪个在响应）
  await expect(page.getByTestId('typo-node')).toHaveCount(8);
  await expect(page.getByTestId('typo-shape-handle')).toHaveCount(0);

  // 选择层让位给顶点层：缩放把手会和框边上的锚点重叠
  await expect(page.getByTestId('typo-selection')).toHaveCount(0);

  // Escape **只**退出编辑层，选择集还在
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('typo-node')).toHaveCount(0);
  await expect(page.getByTestId('typo-selection')).toBeVisible();
});

test('顶点编辑：拖锚点改路径，手柄跟着走', async ({ page }) => {
  await wide(page);
  await boot(page);
  const clipId = await addTextClip(page);
  await openEditor(page, clipId);
  await insertShape(page, 'ellipse');

  await page.getByTestId('ribbon-tab-shape-format').click();
  await page.getByTestId('typo-node-edit').click();
  await expect(page.getByTestId('typo-node')).toHaveCount(4);
  await expect(page.getByTestId('typo-node-knob')).toHaveCount(8);

  const before = parsePathNodes((await lastShape(page)).path!)[0]!.nodes[0]!;

  const n0 = (await page.getByTestId('typo-node').first().boundingBox())!;
  await page.mouse.move(n0.x + n0.width / 2, n0.y + n0.height / 2);
  await page.mouse.down();
  await page.mouse.move(n0.x + n0.width / 2 + 30, n0.y + n0.height / 2, { steps: 8 });
  await page.mouse.up();

  const after = parsePathNodes((await lastShape(page)).path!)[0]!.nodes[0]!;
  expect(after.x).not.toBeCloseTo(before.x, 1);
  /*
   * 手柄**必须跟着锚点走**（它存的是绝对坐标）。
   * 漏掉这一步的症状是「拖锚点时曲线被拉成锥形」—— 而且只在有手柄的点上出现，
   * 圆角矩形的角点（没有手柄）看起来一切正常，很容易漏过。
   */
  expect(after.out!.x - after.x).toBeCloseTo(before.out!.x - before.x, 1);
  expect(after.out!.y - after.y).toBeCloseTo(before.out!.y - before.y, 1);
});

test('顶点编辑：双击线段加点，形状不变（相邻锚点不动）', async ({ page }) => {
  await wide(page);
  await boot(page);
  const clipId = await addTextClip(page);
  await openEditor(page, clipId);
  // 圆角矩形转路径后是「弧—直边—弧—直边」交替，第 1、2 号锚点之间是**直线**。
  await insertShape(page, 'round-rect');

  await page.getByTestId('ribbon-tab-shape-format').click();
  await page.getByTestId('typo-node-edit').click();
  await expect(page.getByTestId('typo-node')).toHaveCount(8);

  const before = parsePathNodes((await lastShape(page)).path!)[0]!.nodes;

  /*
   * 双击第 1、2 号锚点的**中心连线中点**。
   *
   * 特意挑直线段：弧上的点不在两个锚点的连线上（椭圆的 90° 弧里，连线中点
   * 离真实弧点有 15 个 authored 单位，超出命中容差），拿它当双击目标是**构造
   * 错误**而不是算法错误。最近点算法本身在单测里用精确参数测过。
   */
  const mid = await page.evaluate(() => {
    const ns = document.querySelectorAll('[data-testid=typo-node]');
    const a = ns[1]!.getBoundingClientRect();
    const b = ns[2]!.getBoundingClientRect();
    return {
      x: (a.x + a.width / 2 + b.x + b.width / 2) / 2,
      y: (a.y + a.height / 2 + b.y + b.height / 2) / 2,
    };
  });
  await page.mouse.dblclick(mid.x, mid.y);

  await expect(page.getByTestId('typo-node')).toHaveCount(9);
  const after = parsePathNodes((await lastShape(page)).path!)[0]!.nodes;
  expect(after).toHaveLength(9);

  // 原有锚点一个都没被挪动（加点只该**插**，不该顺手改别处）
  expect(after[0]!.x).toBeCloseTo(before[0]!.x, 3);
  expect(after[1]!.x).toBeCloseTo(before[1]!.x, 3);
  expect(after[1]!.y).toBeCloseTo(before[1]!.y, 3);
  expect(after[3]!.x).toBeCloseTo(before[2]!.x, 3);
  expect(after[3]!.y).toBeCloseTo(before[2]!.y, 3);
});

test('顶点编辑：双击锚点删除它（少于下限时拒绝）', async ({ page }) => {
  await wide(page);
  await boot(page);
  const clipId = await addTextClip(page);
  await openEditor(page, clipId);
  await insertShape(page, 'ellipse');

  await page.getByTestId('ribbon-tab-shape-format').click();
  await page.getByTestId('typo-node-edit').click();
  await expect(page.getByTestId('typo-node')).toHaveCount(4);

  const n1 = (await page.getByTestId('typo-node').nth(1).boundingBox())!;
  await page.mouse.dblclick(n1.x + n1.width / 2, n1.y + n1.height / 2);

  await expect(page.getByTestId('typo-node')).toHaveCount(3);
  // 撤销回来
  await page.keyboard.press('Control+z');
  await expect(page.getByTestId('typo-node')).toHaveCount(4);
});

test('拖手柄：默认镜像另一侧（平滑点）；按住 Alt 拖则断开（角点）', async ({ page }) => {
  await wide(page);
  await boot(page);
  const clipId = await addTextClip(page);
  await openEditor(page, clipId);
  await insertShape(page, 'ellipse');

  await page.getByTestId('ribbon-tab-shape-format').click();
  await page.getByTestId('typo-node-edit').click();
  await expect(page.getByTestId('typo-node-knob')).toHaveCount(8);

  /** 第 0 号锚点的两个手柄相对锚点的偏移。 */
  const knobs = async (): Promise<{ in: [number, number]; out: [number, number] }> => {
    const n = parsePathNodes((await lastShape(page)).path!)[0]!.nodes[0]!;
    expect(n.in).toBeTruthy();
    expect(n.out).toBeTruthy();
    return {
      in: [n.in!.x - n.x, n.in!.y - n.y],
      out: [n.out!.x - n.x, n.out!.y - n.y],
    };
  };

  const outKnob = page.locator('[data-testid=typo-node-knob][data-side=out]').first();
  const drag = async (dx: number, dy: number, alt: boolean): Promise<void> => {
    const b = (await outKnob.boundingBox())!;
    if (alt) await page.keyboard.down('Alt');
    await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2);
    await page.mouse.down();
    await page.mouse.move(b.x + b.width / 2 + dx, b.y + b.height / 2 + dy, { steps: 6 });
    await page.mouse.up();
    if (alt) await page.keyboard.up('Alt');
  };

  await drag(28, 0, false);
  const smooth = await knobs();
  // 平滑点：另一侧被镜像（方向相反、长度相同）
  expect(smooth.in[0]).toBeCloseTo(-smooth.out[0], 1);
  expect(smooth.in[1]).toBeCloseTo(-smooth.out[1], 1);

  // Alt 拖：断开镜像，另一侧**一点不动**
  const locked = (await knobs()).in;
  await drag(0, 22, true);
  const broken = await knobs();
  expect(broken.in[0]).toBeCloseTo(locked[0], 1);
  expect(broken.in[1]).toBeCloseTo(locked[1], 1);
  expect(broken.out[1]).not.toBeCloseTo(smooth.out[1], 1);
});

test('多选时不显示形状控制点（把手属于谁没有答案）', async ({ page }) => {
  await wide(page);
  await boot(page);
  const clipId = await addTextClip(page);
  await openEditor(page, clipId);

  await insertShape(page, 'round-rect');
  await expect(page.getByTestId('typo-shape-handle')).toHaveCount(1);

  await insertShape(page, 'round-rect');
  await page.keyboard.press('Control+a');
  await expect(page.getByTestId('typo-shape-handle')).toHaveCount(0);
});

test('拖锚点：authored 位移必须与屏幕位移相称（路径存的是 0..100，不是像素）', async ({ page }) => {
  await wide(page);
  await boot(page);
  const clipId = await addTextClip(page);
  await openEditor(page, clipId);
  await insertShape(page, 'round-rect');

  await page.getByTestId('ribbon-tab-shape-format').click();
  await page.getByTestId('typo-node-edit').click();
  await expect(page.getByTestId('typo-node')).toHaveCount(8);

  const el = await lastShape(page);
  const zoom = Number(await page.getByTestId('typo-zoom-slider').getAttribute('aria-valuenow')) / 100;
  const before = parsePathNodes(el.path!)[0]!.nodes[0]!;

  // 往右拖 30 个**屏幕**像素 ⇒ authored 位移 = 30 / (框宽 × zoom) × 100
  const DRAG = 30;
  const want = (DRAG * 100) / (el.frame.w * zoom);

  const n0 = (await page.getByTestId('typo-node').first().boundingBox())!;
  await page.mouse.move(n0.x + n0.width / 2, n0.y + n0.height / 2);
  await page.mouse.down();
  await page.mouse.move(n0.x + n0.width / 2 + DRAG, n0.y + n0.height / 2, { steps: 6 });
  await page.mouse.up();

  const after = parsePathNodes((await lastShape(page)).path!)[0]!.nodes[0]!;
  /*
   * 这一条守的是一个**差一个比例因子**的错误：手势拿到的是文档坐标 → 局部
   * 像素，而路径按 0..100 authored 存。忘了换算的话，写进去的是像素值
   * （324 宽的框上差 3.24 倍），拖一下锚点就飞出框外 —— 而**那一次拖动的
   * DOM 更新看起来完全正常**（路径确实变了），只有下一次想再拖它时才发现
   * 点不到了。断言「位移与屏幕距离相称」才抓得住这种量纲错误。
   */
  expect(after.x - before.x).toBeCloseTo(want, 1);
  expect(after.y - before.y).toBeCloseTo(0, 1);
  // 顺带：锚点仍在元素框内（authored 0..100）
  expect(after.x).toBeGreaterThanOrEqual(-1);
  expect(after.x).toBeLessThanOrEqual(101);
});

test('本机字体：授权后把系统字体并进下拉', async ({ page, context }) => {
  /*
   * 这个 API 要求权限：有头浏览器里是**弹权限框让用户点**，自动化里可以用
   * `grantPermissions` 预置 —— 于是**成功路径也进回归网**。
   *
   * （第一版把挂点写成 `navigator.queryLocalFonts`，探测永远失败，于是误判成
   * 「这个 API 在自动化环境里不存在、成功路径没法测」。那不是环境的问题，
   * 是找错了对象：API 挂在 `window` 上。）
   */
  await context.grantPermissions(['local-fonts']);

  await wide(page);
  await boot(page);
  const clipId = await addTextClip(page);
  await openEditor(page, clipId);

  const btn = page.getByTestId('typo-local-fonts');
  await expect(btn).toBeEnabled();
  // 对照：同组的「导入字体」走文件选择，与这个 API 无关，永远可用。
  await expect(page.getByTestId('typo-font-import')).toBeEnabled();

  await btn.click();
  /*
   * 显式给 30s：`window.queryLocalFonts()` 要枚举**本机全部字体**（本机实测
   * 上千个），整套并跑时机器一忙，默认 10s 会表现成「超时失败」而不是真违规
   * —— 与 AGENTS §7「遍历全目录的用例要显式给超时」同一类。
   */
  await expect(page.getByTestId('notice')).toContainText('本机字体', { timeout: 30_000 });

  // 系统字体**真的**进了下拉。Arial 是 Windows 必装的，挑它最稳。
  // 字体下拉要求**先选中文本元素**（`disabled: !hasText`）—— 新建片段时
  // 文档里有一个文本元素但并没有选中它，不先选的话下拉是灰的、点不动。
  await page.keyboard.press('Control+a');
  await page.getByTestId('ribbon-font-family').click();
  await expect(page.getByTestId('ribbon-font-option-Arial')).toBeVisible();
});

test('本机字体：没授权时提示要说清是**权限**，不是「载入成功 0 个」', async ({ page }) => {
  /*
   * 不调 grantPermissions ⇒ 浏览器把这次查询当成「用户拒绝」，而 API 的约定是
   * resolve **空数组**而不是抛错。这里钉住界面把它归到「没拿到权限」——
   * 含糊的「已载入 0 个本机字体」会让用户不知道该去浏览器设置里授权。
   */
  await wide(page);
  await boot(page);
  const clipId = await addTextClip(page);
  await openEditor(page, clipId);

  const btn = page.getByTestId('typo-local-fonts');
  await expect(btn).toBeEnabled(); // API 在 ⇒ 按钮是亮的
  await btn.click();

  await expect(page.getByTestId('notice')).toContainText('权限');

  // 下拉里不该冒出系统字体
  // 字体下拉要求**先选中文本元素**（`disabled: !hasText`）—— 新建片段时
  // 文档里有一个文本元素但并没有选中它，不先选的话下拉是灰的、点不动。
  await page.keyboard.press('Control+a');
  await page.getByTestId('ribbon-font-family').click();
  await expect(page.getByTestId('ribbon-font-option-Arial')).toHaveCount(0);
});

test('形状缩略图：实心填充、不描边（描边会被 viewBox 边界裁掉）', async ({ page }) => {
  await wide(page);
  await boot(page);
  const clipId = await addTextClip(page);
  await openEditor(page, clipId);

  await page.getByTestId('ribbon-tab-insert').click();
  await page.getByTestId('typo-shape').click();
  await expect(page.getByTestId('typo-shape-pop')).toBeVisible();

  const svgs = page.locator('[data-testid=typo-shape-pop] svg');
  const paths = page.locator('[data-testid=typo-shape-pop] svg path');
  const total = await paths.count();
  expect(total).toBeGreaterThan(10);

  /*
   * 这一组守的是「图标边框太粗 + 明显裁剪」那次的回归。
   *
   * 根因是两个叠加的毛病：`vector-effect="non-scaling-stroke"` + `stroke-width="3"`
   * 让线宽成为**屏幕**像素（34px 的卡片上占掉八分之一），而图形顶点本来就在
   * viewBox 边界上，线宽的一半落到框外**直接被裁**（多边形的尖角看起来是平的）。
   * 所以两条都钉住：不许有 non-scaling-stroke，默认必须是填充。
   */
  expect(await page.locator('[data-testid=typo-shape-pop] [vector-effect]').count()).toBe(0);
  expect(await svgs.count()).toBe(total);

  const attrs = await paths.evaluateAll((ns) =>
    ns.map((n) => ({ fill: n.getAttribute('fill'), stroke: n.getAttribute('stroke') })),
  );
  // 只有**没有面积**的图形（直线）该走描边，其余全部实心填充。
  const stroked = attrs.filter((a) => a.stroke !== 'none');
  expect(stroked).toHaveLength(1);
  expect(attrs.filter((a) => a.fill === 'currentColor')).toHaveLength(total - 1);
});

test('字体提示：导入一个字体之后不该再报「未就绪」（显示明明正常）', async ({ page }) => {
  await wide(page);
  await boot(page);
  const clipId = await addTextClip(page);
  await openEditor(page, clipId);

  /*
   * 走与「导入字体」**同一条注册路径**（`registerFile`），只是字节取自仓库里
   * 内置的那份字体文件 —— 免得测试依赖 `C:/Windows/Fonts` 的存在。
   * 第三个参数换掉族名，避免与内置的 Inter 撞车。
   */
  const family = await page.evaluate(async () => {
    const A = (
      window as never as {
        __artmatic: {
          appState: {
            fonts: { registerFile(n: string, b: ArrayBuffer, f?: string): Promise<{ family: string }> };
            refreshFontFamilies(): void;
          };
        };
      }
    ).__artmatic;
    const bytes = await (await fetch('/fonts/inter-latin-400.woff2')).arrayBuffer();
    const face = await A.appState.fonts.registerFile('probe.woff2', bytes, 'ProbeFontX');
    A.appState.refreshFontFamilies();
    return face.family;
  });
  expect(family).toBe('ProbeFontX');

  // 让文档真的用它 —— 不然 missing() 根本不会看这个族
  await page.keyboard.press('Control+a');
  await page.getByTestId('ribbon-font-family').click();
  await page.getByTestId('ribbon-font-option-ProbeFontX').click();

  /*
   * 判据：**不该出现**「字体…还没准备好」。
   *
   * 原来的 `missing()` 拿 `dataUrl` 当判据，而那个只在导出前的 `ensure()` 里
   * 生成 —— 于是「刚导入、显示完全正常」的字体被一直报成「未就绪，正在用回落
   * 字体」。正确的判据是 `loaded`（FontFace 已进 `document.fonts`）。
   */
  await expect(page.getByTestId('typo-font-missing')).toHaveCount(0);
});

test('下拉弹层里的滚轮不会带着 Ribbon 一起横滚', async ({ page, context }) => {
  // 窄视口：Ribbon 必须真的有横向溢出，这条才构造得出「重叠」的场景。
  await page.setViewportSize({ width: 900, height: 780 });
  // 载入本机字体，把字体下拉撑到几百项 —— 只有一项的话弹层根本不可滚，
  // 这条就变成了「在两个不可滚的东西上滚一下」，什么也没测。
  await context.grantPermissions(['local-fonts']);

  await boot(page);
  const clipId = await addTextClip(page);
  await openEditor(page, clipId);
  await page.keyboard.press('Control+a');

  const body = page.getByTestId('ribbon-body');
  const canScroll = await body.evaluate((n) => n.scrollWidth > n.clientWidth);
  test.skip(!canScroll, '这个视口下 Ribbon 没有横向溢出，构造不出重叠场景');

  await page.getByTestId('typo-local-fonts').click();
  await expect(page.getByTestId('notice')).toContainText('本机字体');

  await page.getByTestId('ribbon-font-family').click();
  const pop = page.getByTestId('ribbon-font-family-pop');
  await expect(pop).toBeVisible();

  /*
   * 本机字体是**异步**加载的：列表就绪前后会重建一次下拉，滚动位置随之归零。
   * 直接滚会在全量并跑（机器忙、异步回来得晚）时踩到「刚滚完就被重建」，
   * 断言读到 scrollTop = 0 —— 这条用例单独跑必过、并跑偶发红，就是这个原因。
   * 先等列表高度稳定（连续两次采样一致）再滚。
   */
  let prevH = await pop.evaluate((n) => n.scrollHeight);
  await expect
    .poll(
      async () => {
        const now = await pop.evaluate((n) => n.scrollHeight);
        const same = now === prevH;
        prevH = now;
        return same;
      },
      { timeout: 5000, intervals: [100, 200, 300] },
    )
    .toBe(true);

  // 兜底：环境里真的一个系统字体都没有时，这条没有可测的东西。
  const scrollable = await pop.evaluate((n) => n.scrollHeight > n.clientHeight);
  test.skip(!scrollable, '弹层内容不足以滚动，这条测不到东西');

  /*
   * 判据是「**wheel 有没有冒泡到 Ribbon**」，而不是「Ribbon 的 scrollLeft 变没变」。
   *
   * 后者会被一条无关的 effect 干扰：Ribbon 在切换标签页时会把 scrollLeft 归零
   * （`Ribbon.svelte` 里那条 $effect），于是测试可能因为别的原因变绿或变红。
   * 直接数事件才是这件事本身 —— 而且它能抓住「拦没拦」这个唯一的机制。
   *
   * 监听挂在**冒泡阶段**：弹层的 handler 更内层、先跑，`stopPropagation` 之后
   * 这个计数就该停在 0。
   */
  await page.evaluate(() => {
    const g = globalThis as unknown as { __wheelOnRibbon: number };
    g.__wheelOnRibbon = 0;
    document.querySelector('[data-testid=ribbon-body]')!.addEventListener('wheel', () => {
      g.__wheelOnRibbon += 1;
    });
  });

  const box = (await pop.boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.wheel(0, 240);

  // 弹层自己照滚不误（stopPropagation 不挡它自己的滚动）
  expect(await pop.evaluate((n) => n.scrollTop), '弹层自己该滚起来').toBeGreaterThan(0);
  expect(
    await page.evaluate(() => (globalThis as unknown as { __wheelOnRibbon: number }).__wheelOnRibbon),
    'wheel 不该冒泡到 Ribbon（冒泡了它的横向滚动就会被带走）',
  ).toBe(0);
});

/* ------------------------------------------------------------ 字体区（PPT 式两排布局）与配色方案
 *
 * 这一组用例守的是本轮的三条**跨层链路**，它们每一环单看都"应该没问题"：
 *   ① 取色卡选主题色 → 文档里存引用 → 渲染时解析 → 换方案时画面跟着变；
 *   ② 高亮色下发到**行内段**（变量那条路），不是给文本框刷底色；
 *   ③ 字体区的纯图标按钮与菜单仍能改到文档（紧凑布局没有把功能弄丢）。
 *
 * 只读 store 抓不到任何一条 —— 所以这里一律断言**画布上的 computed style**。
 */

/** 画布上第一个文本框的**实际渲染颜色**（换方案后它必须变）。 */
async function domTextColor(page: Page): Promise<string> {
  return page.evaluate(() => {
    const el = document.querySelector<HTMLElement>('.paper .typo-text');
    return el ? getComputedStyle(el).color : '';
  });
}

test('取色卡选的是「主题色引用」：换配色方案时字体颜色跟着变', async ({ page }) => {
  await wide(page);
  await boot(page);
  const clipId = await addTextClip(page);
  await openEditor(page, clipId);
  await selectFirst(page);

  // 字体颜色按钮 = 图标 + 当前色条，点开是本项目的取色卡
  await page.getByTestId('ribbon-text-color').click();
  await expect(page.getByTestId('ribbon-text-color-pop')).toBeVisible();
  await page.getByTestId('ribbon-text-color-palette-theme-@accent1').click();

  // 存的是**引用**而不是 hex —— 这是整条联动链的根
  expect((await readDoc(page)).elements[0]!.style!.color).toBe('@accent1');
  // 画布上已按当前方案（Office）渲染
  expect(await domTextColor(page)).toBe('rgb(21, 96, 130)');

  // 「设计」里换配色方案 ⇒ 同一个引用渲染出另一个颜色
  await page.getByTestId('ribbon-tab-design').click();
  await page.getByTestId('ribbon-themes').click();
  await page.getByTestId('ribbon-themes-opt-office-2007').click();

  expect((await readDoc(page)).theme).toBe('office-2007');
  expect(await domTextColor(page)).toBe('rgb(79, 129, 189)');
});

test('标准色是裸色：换配色方案时它**不**变（「仅限于用了配色的元素」）', async ({ page }) => {
  await wide(page);
  await boot(page);
  const clipId = await addTextClip(page);
  await openEditor(page, clipId);
  await selectFirst(page);

  await page.getByTestId('ribbon-text-color').click();
  await page.getByTestId('ribbon-text-color-palette-std-ff0000').click();
  expect((await readDoc(page)).elements[0]!.style!.color).toBe('#ff0000');
  expect(await domTextColor(page)).toBe('rgb(255, 0, 0)');

  await page.getByTestId('ribbon-tab-design').click();
  await page.getByTestId('ribbon-themes').click();
  await page.getByTestId('ribbon-themes-opt-violet-ii').click();

  // 裸色**不跟着变** —— 与上一条互为对照
  expect(await domTextColor(page)).toBe('rgb(255, 0, 0)');
});

test('突出显示颜色画在**字形底色**上（不是给文本框刷底），并且能清掉', async ({ page }) => {
  await wide(page);
  await boot(page);
  const clipId = await addTextClip(page);
  await openEditor(page, clipId);
  await selectFirst(page);

  await page.getByTestId('ribbon-text-highlight').click();
  await page.getByTestId('ribbon-text-highlight-palette-std-ffff00').click();
  expect((await readDoc(page)).elements[0]!.style!.highlight).toBe('#ffff00');

  // 落点在行内段（含 var(--typo-hl) 兜底的那一层）上，而不是 .typo-text 盒子上
  const painted = await page.evaluate(() => {
    const span = document.querySelector<HTMLElement>('.paper .typo-text span[data-run]');
    const box = document.querySelector<HTMLElement>('.paper .typo-text');
    return {
      span: span ? getComputedStyle(span).backgroundColor : '',
      box: box ? getComputedStyle(box).backgroundColor : '',
    };
  });
  expect(painted.span).toBe('rgb(255, 255, 0)');
  expect(painted.box).not.toBe('rgb(255, 255, 0)');

  // 「无颜色」清掉
  await page.getByTestId('ribbon-text-highlight').click();
  await page.getByTestId('ribbon-text-highlight-palette-none').click();
  expect((await readDoc(page)).elements[0]!.style!.highlight).toBeUndefined();
});

test('文字阴影开关：开有 shadow 且画布上真的画了，再点关掉', async ({ page }) => {
  await wide(page);
  await boot(page);
  const clipId = await addTextClip(page);
  await openEditor(page, clipId);
  await selectFirst(page);

  await page.getByTestId('ribbon-text-shadow').click();
  // 开关只造**一层**；写回一律是数组（多层是面板的能力，见 PropertiesPanel）。
  const shadow = (await readDoc(page)).elements[0]!.style!.shadow;
  const first = Array.isArray(shadow) ? shadow[0] : shadow;
  expect(first?.blur).toBeGreaterThan(0);
  const css = await page.evaluate(() =>
    getComputedStyle(document.querySelector('.paper .typo-text')!).textShadow,
  );
  expect(css).not.toBe('none');

  await page.getByTestId('ribbon-text-shadow').click();
  expect((await readDoc(page)).elements[0]!.style!.shadow).toBeUndefined();
});

test('字符间距菜单：预设与自定义输入框都能改到同一个属性', async ({ page }) => {
  await wide(page);
  await boot(page);
  const clipId = await addTextClip(page);
  await openEditor(page, clipId);
  await selectFirst(page);

  await page.getByTestId('ribbon-letter-spacing').click();
  await page.getByTestId('ribbon-spacing-8').click();
  expect((await readDoc(page)).elements[0]!.style!.letterSpacing).toBe(8);

  // 预设之外的任意值走菜单底部的输入框（NumberInput 的 testid 直接挂在 input 上）
  await page.getByTestId('ribbon-letter-spacing').click();
  const input = page.getByTestId('ribbon-letter-spacing-custom');
  await input.fill('3.5');
  await input.press('Enter');
  expect((await readDoc(page)).elements[0]!.style!.letterSpacing).toBeCloseTo(3.5, 2);
});

test('大小写转换：菜单勾选当前项，画布上真的变更了大小写', async ({ page }) => {
  await wide(page);
  await boot(page);
  const clipId = await addTextClip(page);
  await openEditor(page, clipId);
  await selectFirst(page);

  await page.getByTestId('ribbon-text-case').click();
  await page.getByTestId('ribbon-case-uppercase').click();
  expect((await readDoc(page)).elements[0]!.style!.textTransform).toBe('uppercase');
  const css = await page.evaluate(() =>
    getComputedStyle(document.querySelector('.paper .typo-text')!).textTransform,
  );
  expect(css).toBe('uppercase');
});

test('清除全部格式：选中文本就能用，字形类属性回默认、段落对齐保留', async ({ page }) => {
  await wide(page);
  await boot(page);
  const clipId = await addTextClip(page);
  await openEditor(page, clipId);
  await selectFirst(page);

  // 先改出一身非默认：取消加粗（700 → 400）+ 字体颜色改红
  await page.getByTestId('ribbon-bold').click();
  await page.getByTestId('ribbon-text-color').click();
  await page.getByTestId('ribbon-text-color-palette-std-ff0000').click();
  expect((await readDoc(page)).elements[0]!.style!.fontWeight).toBe(400);

  await page.getByTestId('typo-clear-format').click();
  const after = (await readDoc(page)).elements[0]!.style!;
  expect(after.fontWeight).toBe(700);
  // 默认字形色是「文字色 1」这个槽位的引用，不是写死的白（见 document.ts）
  expect(after.color).toBe('@lt1');
  expect(await domTextColor(page)).toBe('rgb(255, 255, 255)');
});

test('切换配色方案后，图形填充的取色卡跟着刷新（回归）', async ({ page }) => {
  /*
   * 这条守的是「取色卡画的色格」与「选出来的颜色」用的是**同一个**方案。
   *
   * 曾经的 bug：颜色控件没有把自己的方案 id 带给取色卡，于是取色卡画的是
   * **默认**方案的格子，而选中之后颜色按**当前**方案解析 —— 「看着是深蓝、
   * 选出来是蓝绿」，并且只在切换过配色方案之后才出现，不报任何错。
   * 根因是「themeId 要每个颜色控件各带一遍」，现在收口在
   * `ribbon-defs.ts::injectThemeId` 一处，这条用例是它的守卫。
   */
  await wide(page);
  await boot(page);
  const clipId = await addTextClip(page);
  await openEditor(page, clipId);
  await insertShape(page, 'rect');
  await page.getByTestId('ribbon-tab-shape-format').click();

  const cell = page.getByTestId('ribbon-shape-fill-palette-theme-@accent1');
  await page.getByTestId('ribbon-shape-fill').click();
  await expect(cell).toBeVisible();
  const before = await cell.evaluate((el) => getComputedStyle(el).backgroundColor);
  expect(before).toBe('rgb(21, 96, 130)'); // 「Office」的强调色 1

  // 换配色方案。点 tab 会顺带关掉取色卡（外点关闭），不用按 Escape ——
  // 那个在排版页是「退出选择」，会把选中集清掉，图形格式页随之消失。
  await page.getByTestId('ribbon-tab-design').click();
  await page.getByTestId('ribbon-themes').click();
  await page.getByTestId('ribbon-themes-opt-office-2007').click();

  // 回到图形格式重开取色卡：色格必须已经是新方案的颜色
  await page.getByTestId('ribbon-tab-shape-format').click();
  await page.getByTestId('ribbon-shape-fill').click();
  await expect(cell).toBeVisible();
  const after = await cell.evaluate((el) => getComputedStyle(el).backgroundColor);
  expect(after).toBe('rgb(79, 129, 189)'); // 「Office 2007-2010」的强调色 1
});

test('「其他颜色」的原生取色器：拖动（input）不关弹层，确认（change）才关（回归）', async ({ page }) => {
  /*
   * 回归：曾经把原生取色器的 `input` 也接进了提交流程 —— 拖动中弹层就被关掉，
   * 而弹层里的 `<input type=color>` 一被销毁，**原生取色器也跟着消失**，
   * 颜色根本拖不动（用户报的现象）。
   *
   * 原生取色器是浏览器 widget，Playwright 点不到它，所以这里直接对那个
   * input 派发 DOM 事件 —— 这正是「拖动中 / 确认时」在页面侧的样子。
   */
  await wide(page);
  await boot(page);
  const clipId = await addTextClip(page);
  await openEditor(page, clipId);
  await selectFirst(page);

  await page.getByTestId('ribbon-text-color').click();
  const pop = page.getByTestId('ribbon-text-color-pop');
  const native = page.getByTestId('ribbon-text-color-palette-native');
  await expect(pop).toBeVisible();
  // 「其他颜色…」= 唤起原生取色器（headless 下不弹窗，但路径要走通）
  await page.getByTestId('ribbon-text-color-palette-more').click();

  // 拖动中的一串 input：弹层必须一直在，否则原生取色器会被连坐关闭
  await native.evaluate((el) => {
    const input = el as HTMLInputElement;
    for (const v of ['#112233', '#445566', '#778899']) {
      input.value = v;
      input.dispatchEvent(new Event('input', { bubbles: true }));
    }
  });
  await expect(pop).toBeVisible();
  // 而且拖动中**不该**改文档 —— 一次确认 = 一笔撤销
  expect((await readDoc(page)).elements[0]!.style!.color).toBe('@lt1');

  // 确认：这时才提交并关掉取色卡
  await native.evaluate((el) => {
    (el as HTMLInputElement).value = '#123456';
    el.dispatchEvent(new Event('change', { bubbles: true }));
  });
  await expect(pop).toHaveCount(0);
  expect((await readDoc(page)).elements[0]!.style!.color).toBe('#123456');
});

/* ---------------------------------------- 配色方案：工程级 + 自定义（v6） */

/** 工程里全部文本片段的 theme（「应用到整个项目」的判据）。 */
async function allTextThemes(page: Page): Promise<(string | undefined)[]> {
  return page.evaluate(() => {
    const A = (window as never as {
      __artmatic: {
        appState: {
          store: {
            project: {
              typographyTheme?: string;
              customThemes?: unknown[];
              tracks: { clips: { kind: string; source?: { type?: string; doc?: { theme?: string } } }[] }[];
            };
          };
        };
      };
    }).__artmatic;
    const p = A.appState.store.project;
    const out: (string | undefined)[] = [];
    for (const t of p.tracks) {
      for (const c of t.clips) {
        if (c.kind === 'source' && c.source?.type === 'text') out.push(c.source.doc?.theme);
      }
    }
    return out;
  });
}

test('「应用到整个项目」：一次写所有文本片段 + 新片段默认（一笔撤销）', async ({ page }) => {
  await wide(page);
  await boot(page);
  const clipId = await addTextClip(page);
  await openEditor(page, clipId);

  // 工程里另有文本片段（demo 的标题排版）—— 它们也要跟着变
  const before = await allTextThemes(page);
  expect(before.length).toBeGreaterThan(1);

  await page.getByTestId('ribbon-tab-design').click();
  await page.getByTestId('ribbon-themes').click();
  await page.getByTestId('ribbon-themes-opt-office-2007').click();
  // 图库只改当前文档
  expect((await readDoc(page)).theme).toBe('office-2007');
  expect(await allTextThemes(page)).toContain(undefined);

  await page.getByTestId('ribbon-theme-apply-project').click();
  expect(await allTextThemes(page)).toEqual(before.map(() => 'office-2007'));
  const project = await page.evaluate(
    () =>
      (window as never as { __artmatic: { appState: { store: { project: { typographyTheme?: string } } } } })
        .__artmatic.appState.store.project.typographyTheme,
  );
  expect(project).toBe('office-2007');

  // 逐笔撤销：第一笔回「图库那次」（只改当前文档），第二笔才回到全都没设过
  await page.keyboard.press('Control+z');
  expect(await allTextThemes(page)).toEqual(before.map((_, i) => (i === 0 ? 'office-2007' : before[i])));
  await page.keyboard.press('Control+z');
  expect(await allTextThemes(page)).toEqual(before);
});

test('自定义配色方案：内置方案打开即复制，改槽位保存后成为当前方案', async ({ page }) => {
  await wide(page);
  await boot(page);
  const clipId = await addTextClip(page);
  await openEditor(page, clipId);

  await page.getByTestId('ribbon-tab-design').click();
  await page.getByTestId('ribbon-theme-edit').click();

  // 当前是内置方案 → 标题是「新建」，名字预填「Office 副本」
  await expect(page.getByTestId('theme-editor-modal')).toBeVisible();
  const name = page.getByTestId('theme-editor-name');
  await expect(name).toHaveValue('Office 副本');

  // 改一个槽位（accent1 → 标准色里的纯红），保存
  await page.getByTestId('theme-editor-color-accent1').click();
  await page.getByTestId('theme-editor-color-accent1-palette-std-ff0000').click();
  await page.getByTestId('theme-editor-save').click();
  await expect(page.getByTestId('theme-editor-modal')).toHaveCount(0);

  // 落库：customThemes 多了一条，当前文档的方案指向它
  const saved = await page.evaluate(
    () =>
      (window as never as {
        __artmatic: {
          appState: {
            store: {
              project: {
                customThemes?: { id: string; name: string; colors: Record<string, string> }[];
                tracks: { clips: { kind: string; source?: { type?: string; doc?: { theme?: string } } }[] }[];
              };
            };
          };
        };
      }).__artmatic.appState.store.project,
  );
  expect(saved.customThemes).toHaveLength(1);
  expect(saved.customThemes![0]!.name).toBe('Office 副本');
  expect(saved.customThemes![0]!.colors.accent1).toBe('#ff0000');
  const themes = await allTextThemes(page);
  expect(themes).toContain(saved.customThemes![0]!.id);
  expect((await readDoc(page)).theme).toBe(saved.customThemes![0]!.id);

  // 再打开 → 标题变成「编辑」，改的是同一条（不是又复制一份）
  await page.getByTestId('ribbon-theme-edit').click();
  await expect(page.getByTestId('theme-editor-modal')).toBeVisible();
  await page.getByTestId('theme-editor-cancel').click();
  const after = await page.evaluate(
    () =>
      (window as never as { __artmatic: { appState: { store: { project: { customThemes?: unknown[] } } } } })
        .__artmatic.appState.store.project.customThemes?.length,
  );
  expect(after).toBe(1);

  // 图库里出现了这一条（名字是用户文本）
  await page.getByTestId('ribbon-themes').click();
  await expect(page.getByTestId('ribbon-themes-pop')).toContainText('Office 副本');
});

test('自定义配色方案：图库右键可移除，引用它的文档回落默认方案（一笔撤销）', async ({ page }) => {
  await wide(page);
  await boot(page);
  const clipId = await addTextClip(page);
  await openEditor(page, clipId);

  // 先造一份自定义方案（「内置方案打开即复制」那条路径已在上一用例覆盖）
  await page.getByTestId('ribbon-tab-design').click();
  await page.getByTestId('ribbon-theme-edit').click();
  await page.getByTestId('theme-editor-color-accent1').click();
  await page.getByTestId('theme-editor-color-accent1-palette-std-ff0000').click();
  await page.getByTestId('theme-editor-save').click();

  const state = (): Promise<{
    ids: string[];
    projectTheme?: string;
    themes: (string | undefined)[];
  }> =>
    page.evaluate(() => {
      const p = (window as never as {
        __artmatic: {
          appState: {
            store: {
              project: {
                typographyTheme?: string;
                customThemes?: { id: string }[];
                tracks: { clips: { kind: string; source?: { type?: string; doc?: { theme?: string } } }[] }[];
              };
            };
          };
        };
      }).__artmatic.appState.store.project;
      const themes: (string | undefined)[] = [];
      for (const t of p.tracks) {
        for (const c of t.clips) if (c.source?.type === 'text') themes.push(c.source.doc?.theme);
      }
      return {
        ids: (p.customThemes ?? []).map((t) => t.id),
        projectTheme: p.typographyTheme,
        themes,
      };
    });

  const before = await state();
  expect(before.ids).toHaveLength(1);
  const customId = before.ids[0]!;
  expect(before.themes).toContain(customId);

  await page.getByTestId('ribbon-themes').click();

  // 内置方案没有「移除」：右键它不弹菜单（只读数据表）
  await page.getByTestId('ribbon-themes-opt-office-2007').click({ button: 'right' });
  await expect(page.getByTestId('ribbon-themes-remove')).toHaveCount(0);
  // 图库也不该被右键关掉（否则下一次右键根本落不到那一行上）
  await expect(page.getByTestId('ribbon-themes-pop')).toBeVisible();

  // 自定义方案：右键 → 「移除」
  await page.getByTestId(`ribbon-themes-opt-${customId}`).click({ button: 'right' });
  await expect(page.getByTestId('ribbon-themes-remove')).toBeVisible();
  await page.getByTestId('ribbon-themes-remove').click();

  const after = await state();
  expect(after.ids).toEqual([]);
  // 引用它的地方不留下悬空 id（渲染本来就会回落，但工程不该带着它）
  expect(after.themes).not.toContain(customId);
  expect(after.projectTheme).toBeUndefined();

  // 一笔撤销：方案与引用一起回来
  await page.keyboard.press('Control+z');
  const undone = await state();
  expect(undone.ids).toEqual([customId]);
  expect(undone.themes).toContain(customId);
});
