import { readFileSync } from 'node:fs';
import { expect, test, type Page } from '@playwright/test';
import { addTextClip, openDemo } from './_stage';

/**
 * 排版编辑器 → 右键菜单「保存到本机 / 输出到媒体池」。
 *
 * 判据都是**产物本身**，不是「点了没报错」：
 *  - PNG 读 IHDR 的宽高 —— 它必须是**选中元素**的包围盒，不是整张画布；
 *  - SVG 读文件内容 —— 必须有 `<svg>` 与同一个包围盒的 `viewBox`；
 *  - 媒体池那条读 `project.assets` 与 `assets.size()`。
 *
 * 文字元素上 `SVG` 必须置灰：矢量表达不了文字（要过 HarfBuzz 转路径），
 * 给一个能点但少内容的格式比置灰更坏。
 */

interface Pt {
  x: number;
  y: number;
}

/** 打开编辑页并返回「图形 / 文字」两个元素在屏幕上的中心点。 */
async function mount(page: Page): Promise<{ shape: Pt; text: Pt; box: { w: number; h: number } }> {
  await page.goto('/');
  await page.waitForFunction(() => (window as never as { __artmatic?: unknown }).__artmatic);
  await openDemo(page);
  const clipId = await addTextClip(page);

  // 给这个片段补一个**位置确定**的图形，并把默认文字挪到左上角 —— 两者不重叠，
  // 右键点谁就是谁（命中测试取最上面那一层）。
  await page.evaluate((id) => {
    const A = (window as never as { __artmatic: { store: { commit: (l: string, fn: (p: PanelProject) => void) => void } } })
      .__artmatic;
    A.store.commit('e2e: add shape', (p) => {
      for (const t of p.tracks) {
        for (const c of t.clips) {
          if (c.id !== id || !c.source?.doc) continue;
          const doc = c.source.doc;
          const { w, h } = doc.size;
          const text = doc.elements.find((e) => e.kind === 'text');
          if (text) text.frame = { x: 40, y: 40, w: 320, h: 90, rot: 0 };
          doc.elements.push({
            kind: 'shape',
            id: 'e2e-shape',
            name: 'e2e 矩形',
            // 取整数：导出的包围盒是「floor 左/上、ceil 右/下」，小数会让
            // 「产物宽 = 元素宽」这条断言凭空差一个像素。
            frame: {
              x: Math.round(w * 0.5),
              y: Math.round(h * 0.5),
              w: Math.round(w * 0.4),
              h: Math.round(h * 0.4),
              rot: 0,
            },
            blend: 'normal',
            opacity: 1,
            visible: true,
            locked: false,
            animations: [],
            shape: 'rect',
            fill: { kind: 'solid', color: '#ffffff' },
            stroke: null,
          });
        }
      }
    });
  }, clipId);

  await page.locator(`[data-testid=clip][data-clip-id="${clipId}"]`).dblclick();
  await expect(page.getByTestId('typo-editor')).toBeVisible();

  const shape = await readElement(page, 'shape');
  const text = await readElement(page, 'text');
  return { shape: shape.center, text: text.center, box: shape.box };
}

/**
 * 当前编辑文档里某类元素在屏幕上的中心 + 它的导出包围盒。
 *
 * 包围盒口径与 `exportBoxOf` 一致（floor 左/上、ceil 右/下）：元素框可能带小数
 * （图片的默认框按原始比例算），用 `frame.w` 直接断言会差一个像素。
 */
async function readElement(
  page: Page,
  kind: 'shape' | 'text' | 'image',
): Promise<{ center: Pt; box: { w: number; h: number } }> {
  return page.evaluate((k) => {
    const A = (window as never as {
      __artmatic: {
        appState: { activeTypoClipId: string | null };
        store: { project: { tracks: { clips: { id: string; source?: { doc?: ShapeDoc } }[] }[] } };
      };
    }).__artmatic;
    const id = A.appState.activeTypoClipId;
    let doc: ShapeDoc | null = null;
    for (const t of A.store.project.tracks) {
      for (const c of t.clips) if (c.id === id && c.source?.doc) doc = c.source.doc;
    }
    if (!doc) throw new Error(`找不到当前编辑的排版文档（activeTypoClipId=${id}）`);
    const el = doc.elements.find((e) => e.kind === k);
    if (!el) throw new Error(`文档里没有 ${k} 元素`);
    const wrap = document.querySelector('.paper-wrap')!.getBoundingClientRect();
    const zoom = wrap.width / doc.size.w;
    const f = el.frame;
    return {
      center: { x: wrap.left + (f.x + f.w / 2) * zoom, y: wrap.top + (f.y + f.h / 2) * zoom },
      box: { w: Math.ceil(f.x + f.w) - Math.floor(f.x), h: Math.ceil(f.y + f.h) - Math.floor(f.y) },
    };
  }, kind);
}

/** 当前编辑文档里某类元素的个数（等异步插入用）。 */
async function countElements(page: Page, kind: string): Promise<number> {
  return page.evaluate((k) => {
    const A = (window as never as {
      __artmatic: {
        appState: { activeTypoClipId: string | null };
        store: { project: { tracks: { clips: { id: string; source?: { doc?: ShapeDoc } }[] }[] } };
      };
    }).__artmatic;
    const id = A.appState.activeTypoClipId;
    for (const t of A.store.project.tracks) {
      for (const c of t.clips) {
        if (c.id === id && c.source?.doc) return c.source.doc.elements.filter((e) => e.kind === k).length;
      }
    }
    return 0;
  }, kind);
}

interface Frame {
  x: number;
  y: number;
  w: number;
  h: number;
  rot: number;
}
/** 只看用得上的几个字段；元素其余字段由构造处按真实模型写全。 */
interface DocElement {
  id: string;
  kind?: string;
  name?: string;
  frame: Frame;
  [key: string]: unknown;
}
interface ShapeDoc {
  size: { w: number; h: number };
  elements: DocElement[];
}
interface PanelProject {
  tracks: { clips: { id: string; source?: { doc?: ShapeDoc } }[] }[];
}

/**
 * 右键 → 打开某个一级项的子菜单 → 点其中一项。
 *
 * `download: true` 时等这次点击触发的下载（「输出到媒体池」不落盘，
 * 等下载会一直挂到超时）。
 */
async function exportVia(
  page: Page,
  at: Pt,
  parent: string,
  child: string,
  opts: { download: true } | { download: false },
): Promise<import('@playwright/test').Download | null> {
  await page.mouse.click(at.x, at.y, { button: 'right' });
  await expect(page.getByTestId('typo-context-menu')).toBeVisible();
  await page.getByTestId(parent).hover();
  const picked = page.getByTestId(child);
  await expect(picked).toBeVisible();
  const download = opts.download ? page.waitForEvent('download') : null;
  await picked.click();
  return download;
}

test('保存到本机：图形出 PNG / SVG，文字上 SVG 置灰', async ({ page }) => {
  const { shape, text, box } = await mount(page);

  // ---- PNG：产物尺寸 = 选中元素的包围盒（不是整张画布）
  const png = (await exportVia(page, shape, 'typo-ctx-save-file', 'typo-ctx-save-png', {
    download: true,
  }))!;
  expect(png.suggestedFilename()).toMatch(/\.png$/);
  const pngPath = await png.path();
  expect(pngPath, '下载没有落地').toBeTruthy();
  const bytes = readFileSync(pngPath!);
  // PNG 签名 + IHDR（偏移 16 起的两个大端 32 位就是宽高）
  expect([...bytes.subarray(0, 8)]).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  expect(bytes.readUInt32BE(16)).toBe(Math.round(box.w));
  expect(bytes.readUInt32BE(20)).toBe(Math.round(box.h));

  // ---- SVG：矢量产物带同一个 viewBox，且只含这一个元素
  const svg = (await exportVia(page, shape, 'typo-ctx-save-file', 'typo-ctx-save-svg', {
    download: true,
  }))!;
  expect(svg.suggestedFilename()).toMatch(/\.svg$/);
  const svgText = readFileSync((await svg.path())!, 'utf8');
  expect(svgText).toContain('<svg');
  expect(svgText).toContain(`viewBox="0 0 ${Math.round(box.w)} ${Math.round(box.h)}"`);
  expect(svgText).toContain('<path');

  // ---- 文字元素上 SVG 置灰（PNG 仍然可用）
  await page.mouse.click(text.x, text.y, { button: 'right' });
  await expect(page.getByTestId('typo-context-menu')).toBeVisible();
  await page.getByTestId('typo-ctx-save-file').hover();
  await expect(page.getByTestId('typo-ctx-save-svg')).toBeDisabled();
  await expect(page.getByTestId('typo-ctx-save-png')).toBeEnabled();
  await page.keyboard.press('Escape');
});

test('图片元素也能导出：PNG 尺寸 = 图片自己的框（不是画布）', async ({ page }) => {
  await page.goto('/');
  await page.waitForFunction(() => (window as never as { __artmatic?: unknown }).__artmatic);
  await openDemo(page);
  const clipId = await addTextClip(page);
  await page.locator(`[data-testid=clip][data-clip-id="${clipId}"]`).dblclick();
  await expect(page.getByTestId('typo-editor')).toBeVisible();

  // 真实文件选择器插入一张图（绿底红块，现场画，不往仓库塞二进制）。
  await page.getByTestId('ribbon-tab-insert').click();
  const [chooser] = await Promise.all([
    page.waitForEvent('filechooser', { timeout: 15_000 }),
    page.getByTestId('typo-add-image').click(),
  ]);
  await chooser.setFiles({
    name: 'green-red.png',
    mimeType: 'image/png',
    buffer: Buffer.from(
      await page.evaluate(async () => {
        const c = document.createElement('canvas');
        c.width = 128;
        c.height = 128;
        const ctx = c.getContext('2d')!;
        ctx.fillStyle = '#00ff00';
        ctx.fillRect(0, 0, 128, 128);
        ctx.fillStyle = '#ff0000';
        ctx.fillRect(32, 32, 64, 64);
        const blob = await new Promise<Blob>((r) => c.toBlob((b) => r(b!), 'image/png'));
        return Array.from(new Uint8Array(await blob.arrayBuffer()));
      }),
    ),
  });
  // 插入图片是异步的（解码 → 登记 → 写文档），等元素真的出现再量位置。
  let pos: Awaited<ReturnType<typeof readElement>> | null = null;
  await expect
    .poll(
      async () => {
        if ((await countElements(page, 'image')) === 0) return false;
        pos = await readElement(page, 'image');
        return true;
      },
      { timeout: 15_000 },
    )
    .toBe(true);
  const at = pos!;

  const png = (await exportVia(page, at.center, 'typo-ctx-save-file', 'typo-ctx-save-png', {
    download: true,
  }))!;
  const bytes = readFileSync((await png.path())!);
  // 图片元素走的是**同一条光栅化通路**（只是内容节点是 canvas / img），
  // 所以包围盒口径与图形完全一致。
  expect(bytes.readUInt32BE(16)).toBe(at.box.w);
  expect(bytes.readUInt32BE(20)).toBe(at.box.h);
  // 不是一张空图：128×128 的实心图压出来总有几百字节。
  expect(bytes.byteLength).toBeGreaterThan(200);

  // 图片没有矢量表达 ⇒ SVG 置灰。
  await page.mouse.click(at.center.x, at.center.y, { button: 'right' });
  await expect(page.getByTestId('typo-context-menu')).toBeVisible();
  await page.getByTestId('typo-ctx-save-file').hover();
  await expect(page.getByTestId('typo-ctx-save-svg')).toBeDisabled();
});

test('输出到媒体池：登记成一条图片素材，字节进仓', async ({ page }) => {
  const { shape, box } = await mount(page);

  const before = await page.evaluate(() => {
    const A = (window as never as { __artmatic: { store: { project: { assets: Record<string, unknown> } } } })
      .__artmatic;
    return Object.keys(A.store.project.assets);
  });

  await exportVia(page, shape, 'typo-ctx-to-pool', 'typo-ctx-pool-png', { download: false });

  // 登记是同步 `commit`，但字节解码（`registerImageBytes`）在它之前 await 过，
  // 所以轮询到「真的多了一条、而且有字节」为止。
  const read = () =>
    page.evaluate((known: string[]) => {
      const A = (window as never as {
        __artmatic: {
          store: { project: { assets: Record<string, { kind?: string; name?: string }> } };
          assets: { size: (id: string) => number | null; originName: (id: string) => string | null };
        };
      }).__artmatic;
      const ids = Object.keys(A.store.project.assets);
      const fresh = ids.find((id) => !known.includes(id));
      const a = fresh ? A.store.project.assets[fresh] : null;
      return {
        count: ids.length,
        fresh: a
          ? {
              kind: a.kind,
              name: a.name ?? '',
              origin: A.assets.originName(fresh!) ?? '',
              bytes: A.assets.size(fresh!) ?? 0,
            }
          : null,
      };
    }, before);

  await expect.poll(async () => (await read()).fresh?.bytes ?? 0, { timeout: 15_000 }).toBeGreaterThan(0);
  const got = (await read()).fresh!;
  expect(await read().then((r) => r.count)).toBe(before.length + 1);
  expect(got.kind).toBe('image');
  // 原始文件名决定 `assets/` 里的扩展名，必须是 png。
  expect(got.origin).toMatch(/\.png$/);
  expect(got.name).toMatch(/\.png$/);
  // 与「保存到本机」同一份包围盒：素材取的是元素名，不是整张画布。
  expect(got.name).toContain('e2e 矩形');
  expect(box.w).toBeGreaterThan(0);
});
