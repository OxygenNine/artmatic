import { expect, test, type Page } from '@playwright/test';
import { addTextClip, openDemo } from './_stage';

/**
 * 排版文档里的图片元素：**元素级抠图（色键）与四角透视**。
 *
 * 走真实路径：新建排版片段 → Ribbon「插入图片」（文件选择器）→ 选中 →
 * 元素属性面板开抠图 / 四角 → 在画布上拖角。
 *
 * ## 为什么要断言像素，而不是「有没有那个开关」
 *
 * 这条功能的失效形态全是**静默**的：
 *  - 处理没跑（`<img>` 还在）——面板照样显示已开启；
 *  - canvas 上下颠倒 / 二次裁切 —— 开关、属性、DOM 结构全对；
 *  - 光栅化（导出）那条路没等异步处理 —— 舞台上是对的，导出是原图。
 * 所以判据是「舞台 canvas 与 `rasterizeOnce` 产物的 alpha / rgb」。
 *
 * 底图是现场画的（绿底 + 中心红块），不往仓库塞二进制。
 */

async function boot(page: Page): Promise<void> {
  await page.goto('/');
  await page.waitForFunction(() => (window as never as { __artmatic?: unknown }).__artmatic);
  await openDemo(page);
}

/** 工程里全部排版片段的 id。 */
async function textClipIds(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const A = (window as never as { __artmatic: { store: { project: Tracks } } }).__artmatic;
    const out: string[] = [];
    for (const t of A.store.project.tracks) {
      for (const c of t.clips) if (c.source?.type === 'text') out.push(c.id);
    }
    return out;
  });
}

interface Tracks {
  tracks: {
    clips: { id: string; source?: { type?: string; doc?: DocShape } }[];
  }[];
}

interface DocShape {
  size: { w: number; h: number };
  elements: {
    id: string;
    kind?: string;
    frame: { x: number; y: number; w: number; h: number; rot: number };
    key?: unknown;
    quad?: { tl: [number, number]; tr: [number, number]; br: [number, number]; bl: [number, number] };
  }[];
}

/** 128×128：绿底 + 中心 64×64 红块。 */
async function makePng(page: Page): Promise<Buffer> {
  const bytes = await page.evaluate(async () => {
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
  });
  return Buffer.from(bytes);
}

/**
 * 当前编辑中的排版文档里**那张图片元素**。
 *
 * 不能取 `elements[0]`：新建的排版片段自带一个默认文本框（「双击编辑文本」），
 * 图片是后插入的、排在它后面。取错元素的形态是「quad 永远是 undefined」，
 * 而失败信息会指到断言上，看不出是取错了对象。
 */
async function readImageEl(page: Page): Promise<DocShape['elements'][number]> {
  const el = await page.evaluate(() => {
    const A = (window as never as {
      __artmatic: { store: { project: Tracks }; appState: { activeTypoClipId: string | null } };
    }).__artmatic;
    const id = A.appState.activeTypoClipId;
    for (const t of A.store.project.tracks) {
      for (const c of t.clips) {
        if (c.id !== id || c.source?.type !== 'text' || !c.source.doc) continue;
        const found = c.source.doc.elements.find((e) => e.kind === 'image');
        if (found) return JSON.parse(JSON.stringify(found)) as DocShape['elements'][number];
      }
    }
    throw new Error('文档里没有图片元素');
  });
  return el;
}

test('排版图片：抠图在舞台与光栅化两条路上都生效', async ({ page }) => {
  await boot(page);
  const clipId = await addTextClip(page);
  await page.locator(`[data-testid=clip][data-clip-id="${clipId}"]`).dblclick();
  await expect(page.getByTestId('typo-stage')).toBeVisible();

  // 插入图片：真实文件选择器
  await page.getByTestId('ribbon-tab-insert').click();
  const [chooser] = await Promise.all([
    page.waitForEvent('filechooser', { timeout: 15_000 }),
    page.getByTestId('typo-add-image').click(),
  ]);
  await chooser.setFiles({ name: 'green-red.png', mimeType: 'image/png', buffer: await makePng(page) });
  await expect(page.locator('.paper .typo-image img')).toHaveCount(1, { timeout: 15_000 });

  // 选中图片元素 → 元素属性面板开抠图
  const box = await page
    .locator('.paper .typo-el', { has: page.locator('.typo-image') })
    .first()
    .boundingBox();
  expect(box, '图片元素没有出现在舞台上').not.toBeNull();
  await page.mouse.click(box!.x + box!.width / 2, box!.y + box!.height / 2);
  await page.getByTestId('typo-tab-props').click();
  await expect(page.getByTestId('prop-key-enable')).toBeVisible();
  await page.getByTestId('prop-key-enable').click();

  // 处理是异步的：就绪后 `<img>` 被换成带 fx 标记的 canvas
  const fxCanvas = page.locator('.paper .typo-image canvas[data-typo-fx]');
  await expect(fxCanvas).toHaveCount(1, { timeout: 10_000 });

  const stagePx = await fxCanvas.evaluate((cv) => {
    const el = cv as HTMLCanvasElement;
    const d = el.getContext('2d')!;
    const at = (x: number, y: number) => Array.from(d.getImageData(x, y, 1, 1).data);
    return {
      size: [el.width, el.height],
      corner: at(2, 2),
      center: at(Math.floor(el.width / 2), Math.floor(el.height / 2)),
    };
  });
  // 绿底被抠掉（alpha 0）、中心红块保留
  expect(stagePx.corner[3], `舞台左上角应被抠掉，实得 ${JSON.stringify(stagePx)}`).toBe(0);
  expect(stagePx.center[3]).toBe(255);
  expect(stagePx.center[0]).toBeGreaterThan(200);

  // 光栅化（导出走的同一条路）：抠图必须同样生效
  const raster = await page.evaluate(async () => {
    const A = (window as never as {
      __artmatic: {
        store: { project: Tracks };
        appState: {
          activeTypoClipId: string | null;
          textRaster: {
            rasterizeOnce: (
              doc: DocShape,
              w: number,
              h: number,
              t: number,
            ) => Promise<HTMLCanvasElement>;
          };
        };
      };
    }).__artmatic;
    const id = A.appState.activeTypoClipId;
    let doc: DocShape | null = null;
    for (const t of A.store.project.tracks) {
      for (const c of t.clips) {
        if (c.id === id && c.source?.type === 'text' && c.source.doc) doc = c.source.doc;
      }
    }
    if (!doc) throw new Error('找不到文档');
    const cv = await A.appState.textRaster.rasterizeOnce(doc, doc.size.w, doc.size.h, 0);
    const d = cv.getContext('2d')!;
    const at = (x: number, y: number) => Array.from(d.getImageData(x, y, 1, 1).data);
    const f = doc.elements.find((e) => e.kind === 'image')!.frame;
    return {
      // 元素框左上角内侧 → 一定是被抠掉的绿底
      corner: at(Math.round(f.x + 3), Math.round(f.y + 3)),
      center: at(Math.round(f.x + f.w / 2), Math.round(f.y + f.h / 2)),
    };
  });
  expect(raster.corner[3], `光栅化的绿底应透明，实得 ${JSON.stringify(raster)}`).toBe(0);
  expect(raster.center[3]).toBe(255);
});

test('排版图片：四角手柄改 quad、一笔撤销、光栅化跟着变形', async ({ page }) => {
  await boot(page);
  const clipId = await addTextClip(page);
  await page.locator(`[data-testid=clip][data-clip-id="${clipId}"]`).dblclick();
  await expect(page.getByTestId('typo-stage')).toBeVisible();

  await page.getByTestId('ribbon-tab-insert').click();
  const [chooser] = await Promise.all([
    page.waitForEvent('filechooser', { timeout: 15_000 }),
    page.getByTestId('typo-add-image').click(),
  ]);
  await chooser.setFiles({ name: 'warp.png', mimeType: 'image/png', buffer: await makePng(page) });
  await expect(page.locator('.paper .typo-image img')).toHaveCount(1, { timeout: 15_000 });

  // 文档里还有一个默认文本框：**按内容节点挑图片那个框**，不能用 .first()。
  const imageShell = page.locator('.paper .typo-el', { has: page.locator('.typo-image') }).first();
  const box = await imageShell.boundingBox();
  await page.mouse.click(box!.x + box!.width / 2, box!.y + box!.height / 2);
  await page.getByTestId('typo-tab-props').click();
  await page.getByTestId('prop-quad-enable').click();

  // 画布上调整 → 四角手柄出现，缩放把手让位
  await page.getByTestId('prop-quad-edit').click();
  await expect(page.getByTestId('typo-quad-layer')).toBeVisible();
  await expect(page.getByTestId('typo-quad-corner-tl')).toBeVisible();
  await expect(page.getByTestId('typo-handle-nw')).toHaveCount(0);

  // 拖左上角：往右下推，层空间 uv 应变成 (0.125, 0.0833)（拖动距离 / 元素框尺寸）
  const cb = (await page.getByTestId('typo-quad-corner-tl').boundingBox())!;
  const before = (await readImageEl(page)).quad!;
  expect(before.tl).toEqual([0, 0]);
  await page.mouse.move(cb.x + cb.width / 2, cb.y + cb.height / 2);
  await page.mouse.down();
  // 元素框在屏幕上的尺寸：拖 1/8 宽、1/12 高
  await page.mouse.move(
    cb.x + cb.width / 2 + box!.width / 8,
    cb.y + cb.height / 2 + box!.height / 12,
    { steps: 6 },
  );
  await page.mouse.up();

  const after = (await readImageEl(page)).quad!;
  expect(after.tl[0], `拖角后 quad 没变：${JSON.stringify(after)}`).toBeGreaterThan(0.1);
  expect(after.tl[1]).toBeGreaterThan(0.05);
  // 其余三个角不动
  expect(after.tr).toEqual([1, 0]);
  expect(after.br).toEqual([1, 1]);
  expect(after.bl).toEqual([0, 1]);

  // 一笔撤销：整段拖动只留一条记录
  await page.evaluate(() => (window as never as { __artmatic: { store: { undo: () => void } } }).__artmatic.store.undo());
  const undone = (await readImageEl(page)).quad!;
  expect(undone.tl).toEqual([0, 0]);

  // 光栅化也要变形：恢复后重新拖一次再截图，被推掉的右上角区域应完全透明
  await page.mouse.move(cb.x + cb.width / 2, cb.y + cb.height / 2);
  await page.mouse.down();
  await page.mouse.move(cb.x + cb.width / 2 + box!.width * 0.4, cb.y + cb.height / 2, { steps: 6 });
  await page.mouse.up();

  const warped = await page.evaluate(async () => {
    const A = (window as never as {
      __artmatic: {
        store: { project: Tracks };
        appState: {
          activeTypoClipId: string | null;
          textRaster: {
            rasterizeOnce: (
              doc: DocShape,
              w: number,
              h: number,
              t: number,
            ) => Promise<HTMLCanvasElement>;
          };
        };
      };
    }).__artmatic;
    const id = A.appState.activeTypoClipId;
    let doc: DocShape | null = null;
    for (const t of A.store.project.tracks) {
      for (const c of t.clips) {
        if (c.id === id && c.source?.type === 'text' && c.source.doc) doc = c.source.doc;
      }
    }
    if (!doc) throw new Error('找不到文档');
    const cv = await A.appState.textRaster.rasterizeOnce(doc, doc.size.w, doc.size.h, 0);
    const d = cv.getContext('2d')!;
    const at = (x: number, y: number) => Array.from(d.getImageData(x, y, 1, 1).data);
    const img = doc.elements.find((e) => e.kind === 'image')!;
    const f = img.frame;
    const q = img.quad!;
    return {
      q: q.tl,
      // 左上角被拖走之后，原位置的左上角外侧应该是空的
      outsideTopLeft: at(Math.round(f.x + 4), Math.round(f.y + 4)),
      center: at(Math.round(f.x + f.w / 2), Math.round(f.y + f.h / 2)),
    };
  });
  expect(warped.q[0]).toBeGreaterThan(0.3);
  expect(warped.outsideTopLeft[3], `透视后左上角外应透明：${JSON.stringify(warped)}`).toBe(0);
  expect(warped.center[3]).toBe(255);
});

/**
 * snapDOM 的**持久缓存**守卫（`backends/dom-snap.ts` 的 `cache: 'soft'`）。
 *
 * 光栅化后端复用 snapDOM 的 style / resource 缓存，单次捕获因此减半。安全的前提
 * 只有一条：**换了字节就必须换 URL**（`image-assets.ts::putImageAsset` 每次
 * revoke 旧 URL、建新的），缓存按 URL 做键才不会把旧图吐回来。
 *
 * 这条用例盯的就是那个前提。判据必须看**像素颜色**：
 *  - 只看「元素还在 / 尺寸对」的话，一张旧图能整场过；
 *  - 只比两次的哈希「不同」也不行 —— 换 URL 失败但重烘发生了、两次都糊了也「不同」。
 * 所以钉死「绿 → 蓝」，颜色不对就是缓存或 URL 规则坏了。
 */
test('排版图片：同一 assetId 换字节后必须重烘出新图（snapDOM 持久缓存的守卫）', async ({ page }) => {
  await boot(page);
  const clipId = await addTextClip(page);
  await page.locator(`[data-testid=clip][data-clip-id="${clipId}"]`).dblclick();
  await expect(page.getByTestId('typo-stage')).toBeVisible();

  await page.getByTestId('ribbon-tab-insert').click();
  const [chooser] = await Promise.all([
    page.waitForEvent('filechooser', { timeout: 15_000 }),
    page.getByTestId('typo-add-image').click(),
  ]);
  await chooser.setFiles({ name: 'green.png', mimeType: 'image/png', buffer: await makePng(page) });
  await expect(page.locator('.paper .typo-image img')).toHaveCount(1, { timeout: 15_000 });

  /**
   * 光栅化整份文档，读图片元素框内左上角那一像素。
   *
   * 用 `rasterizeOnce`（不走 LRU 键）—— 这里要证明的是**后端缓存**不会串帧，
   * 而 LRU 在文档没变时本来就该命中原图。
   */
  const cornerPixel = () =>
    page.evaluate(async () => {
      const A = (window as never as {
        __artmatic: {
          store: { project: Tracks };
          appState: {
            activeTypoClipId: string | null;
            textRaster: {
              rasterizeOnce: (
                doc: DocShape,
                w: number,
                h: number,
                t: number,
              ) => Promise<HTMLCanvasElement>;
            };
          };
        };
      }).__artmatic;
      const id = A.appState.activeTypoClipId;
      let doc: DocShape | null = null;
      for (const t of A.store.project.tracks) {
        for (const c of t.clips) {
          if (c.id === id && c.source?.type === 'text' && c.source.doc) doc = c.source.doc;
        }
      }
      if (!doc) throw new Error('找不到文档');
      const cv = await A.appState.textRaster.rasterizeOnce(doc, doc.size.w, doc.size.h, 0);
      const f = doc.elements.find((e) => e.kind === 'image')!.frame;
      return Array.from(cv.getContext('2d')!.getImageData(Math.round(f.x + 3), Math.round(f.y + 3), 1, 1).data);
    });

  const first = await cornerPixel();
  expect(first[3], `图片没画出来（alpha=0）：${JSON.stringify(first)}`).toBe(255);
  expect(first[1], `第一张图应是绿底：${JSON.stringify(first)}`).toBeGreaterThan(200);

  // 同一个 assetId 换一份纯蓝字节（真实路径：`placeImageBytes` 的 putImageBytes）。
  const replaced = await page.evaluate(async () => {
    const A = (window as never as {
      __artmatic: {
        store: { project: Tracks };
        appState: { activeTypoClipId: string | null };
        typoReplaceImageBytes: (assetId: string, blob: Blob, mime?: string) => Promise<void>;
      };
    }).__artmatic;
    const id = A.appState.activeTypoClipId;
    let assetId: string | null = null;
    for (const t of A.store.project.tracks) {
      for (const c of t.clips) {
        if (c.id === id && c.source?.type === 'text' && c.source.doc) {
          assetId = (c.source.doc.elements.find((e) => e.kind === 'image') as { assetId?: string } | undefined)?.assetId ?? null;
        }
      }
    }
    if (!assetId) throw new Error('文档里没有图片素材引用');
    const cv = document.createElement('canvas');
    cv.width = 128;
    cv.height = 128;
    const g = cv.getContext('2d')!;
    g.fillStyle = '#0000ff';
    g.fillRect(0, 0, 128, 128);
    const blob = await new Promise<Blob>((r) => cv.toBlob((b) => r(b!), 'image/png'));
    await A.typoReplaceImageBytes(assetId, blob);
    return assetId;
  });
  expect(replaced).toBeTruthy();

  // 图解码是异步的：轮询到蓝色出现为止（失败信息指方向，不只是一句「超时」）。
  await expect
    .poll(async () => (await cornerPixel())[2], {
      timeout: 10_000,
      message:
        '换字节后光栅化仍是旧图 —— snapDOM 的持久缓存拿 URL 做键，说明 URL 没跟着换字节一起换',
    })
    .toBeGreaterThan(200);

  const second = await cornerPixel();
  expect(second[1], `换字节后不该还是绿底：${JSON.stringify(second)}`).toBeLessThan(60);
});
