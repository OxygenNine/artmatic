import { expect, test, type Page } from '@playwright/test';
import { addTextClip, openDemo } from './_stage';

/**
 * 排版镜头（2.5D 视差）的 E2E 守卫。
 *
 * 四条判据，每条对应一个「只在真浏览器里才看得见」的断点：
 *
 * 1. **入口是开合**（Ribbon 按钮 ↔ 浮层），与画布浮层同一套锚点写法；
 * 2. **depth 0 不吃镜头**：调 zoom 之后元素一个像素都不动 —— 这是「加了这个
 *    功能，老工程画面不变」的唯一证据；
 * 3. **depth 1 真的被放大**：`.typo-el` 的内联 transform 与 client rect 都跟着变
 *    （单测只钉字符串，这里钉浏览器真的这么渲）；
 * 4. **命中跟着视差走**：点放大后**才出现**的那片区域，选中的是同一个元素 ——
 *    不然「看得见却点不中」。
 */

interface Hooks {
  store: {
    project: {
      tracks: {
        clips: {
          id: string;
          source?: { type?: string; doc?: { camera?: { zoom: number }; elements: { depth?: number; frame: { w: number } }[] } };
        }[];
      }[];
    };
  };
  typoRasterize: (
    doc: unknown,
    w: number,
    h: number,
    localSec: number,
  ) => Promise<{ w: number; h: number; ink: number; sum: number; hash: string }>;
}

async function boot(page: Page): Promise<void> {
  // 面板 + Ribbon 同时在场时窄视口测的是滚动，不是功能。
  await page.setViewportSize({ width: 1920, height: 900 });
  await page.goto('/');
  await page.waitForFunction(() => (window as never as { __artmatic?: unknown }).__artmatic);
  await openDemo(page);
}

/** 640×360 画幅里一块 200×200 的白方块，**正好居中**（镜头绕画布中心缩放）。 */
const SQUARE_DOC = {
  size: { w: 640, h: 360 },
  background: { kind: 'none' },
  elements: [
    {
      kind: 'shape',
      id: 'sq',
      name: 'sq',
      frame: { x: 220, y: 80, w: 200, h: 200, rot: 0 },
      blend: 'normal',
      opacity: 1,
      visible: true,
      locked: false,
      animations: [],
      shape: 'rect',
      fill: { kind: 'solid', color: '#ffffff' },
      stroke: null,
    },
  ],
  fonts: [],
};

async function openEditor(page: Page, clipId: string): Promise<void> {
  await page.locator(`[data-testid=clip][data-clip-id="${clipId}"]`).dblclick();
  await expect(page.getByTestId('typo-editor')).toBeVisible();
}

function readDoc(page: Page, clipId: string) {
  return page.evaluate((id) => {
    const A = (window as never as { __artmatic: Hooks }).__artmatic;
    for (const t of A.store.project.tracks) {
      for (const c of t.clips) if (c.id === id) return c.source?.doc ?? null;
    }
    return null;
  }, clipId);
}

/** 第一个元素外壳的内联 transform 与屏幕框。 */
async function shellBox(page: Page) {
  return page.evaluate(() => {
    const el = document.querySelector<HTMLElement>('.paper [data-el-id]');
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return {
      inline: el.style.transform,
      width: r.width,
      height: r.height,
      cx: r.left + r.width / 2,
      cy: r.top + r.height / 2,
    };
  });
}

async function openCamera(page: Page): Promise<void> {
  await page.getByTestId('ribbon-tab-design').click();
  await page.getByTestId('ribbon-camera').click();
  await expect(page.getByTestId('typo-camera-pop')).toBeVisible();
}

/** 选中第一个元素并打开「元素属性」页签（走图层面板，与用户路径一致）。 */
async function selectFirstElement(page: Page): Promise<void> {
  await page.getByTestId('typo-layer-row').first().click();
  await page.getByTestId('typo-tab-props').click();
  await expect(page.getByTestId('prop-depth-num')).toBeVisible();
}

test('光栅化吃到镜头：depth 1 放大、depth 0 逐字节不变', async ({ page }) => {
  await boot(page);

  const r = await page.evaluate(async ({ doc }) => {
    const A = (window as never as { __artmatic: Hooks }).__artmatic;
    const withCam = (zoom: number, depth?: number) => {
      const d = JSON.parse(JSON.stringify(doc)) as typeof doc & {
        camera?: { x: number; y: number; zoom: number; rot: number };
        elements: { depth?: number }[];
      };
      d.camera = { x: 0, y: 0, zoom, rot: 0 };
      if (depth !== undefined) d.elements[0]!.depth = depth;
      return d;
    };
    return {
      flat: await A.typoRasterize(doc, 640, 360, 0),
      zero: await A.typoRasterize(withCam(2, 0), 640, 360, 0),
      zoomed: await A.typoRasterize(withCam(2, 1), 640, 360, 0),
    };
  }, { doc: SQUARE_DOC });

  /*
   * 没有任何元素吃镜头 ⇒ 画面一个像素都不变（这是「老工程不受影响」的证据，
   * 也是「镜头只影响吃它的那一层」的语义）。
   */
  expect(r.zero.hash).toBe(r.flat.hash);

  // 200×200 绕中心放大 2× ⇒ 400×400，上下被画布裁掉 ⇒ 面积约 3.6 倍。
  expect(r.zoomed.ink).toBeGreaterThan(r.flat.ink * 2);

  /*
   * 白色不能因为**超采样降采样**而变暗：位图是直通 alpha，若把 2× 截图丢给
   * 合成器的双线性采样，透明像素的 rgb=0 会在边缘糊出一圈暗边。
   * 判据是「平均亮度不下降」——降采样走 canvas（预乘空间）时它持平。
   */
  expect(r.zoomed.sum / r.zoomed.ink).toBeGreaterThan((r.flat.sum / r.flat.ink) * 0.97);
});

test('镜头浮层是开合：再点一次关掉', async ({ page }) => {
  await boot(page);
  await openEditor(page, await addTextClip(page));

  await openCamera(page);
  await page.getByTestId('ribbon-camera').click();
  await expect(page.getByTestId('typo-camera-pop')).toHaveCount(0);
});

test('depth 0（缺省）不吃镜头：调 zoom 之后元素一动不动', async ({ page }) => {
  await boot(page);
  const clipId = await addTextClip(page);
  await openEditor(page, clipId);
  const before = (await shellBox(page))!;

  await openCamera(page);
  await page.getByTestId('typo-camera-zoom-num').fill('200');
  await page.getByTestId('typo-camera-zoom-num').press('Enter');

  await expect.poll(async () => (await readDoc(page, clipId))?.camera?.zoom).toBe(2);
  const after = (await shellBox(page))!;
  expect(after.inline).toBe(before.inline);
  expect(after.width).toBeCloseTo(before.width, 1);
  expect(after.height).toBeCloseTo(before.height, 1);
});

test('depth 100 跟着镜头放大：DOM transform 与屏幕框同步变化', async ({ page }) => {
  await boot(page);
  const clipId = await addTextClip(page);
  await openEditor(page, clipId);
  await selectFirstElement(page);

  const before = (await shellBox(page))!;

  // 深度 100% = 完全跟随镜头。
  await page.getByTestId('prop-depth-num').fill('100');
  await page.getByTestId('prop-depth-num').press('Enter');
  await expect.poll(async () => (await readDoc(page, clipId))?.elements[0]?.depth).toBe(1);

  await openCamera(page);
  await page.getByTestId('typo-camera-zoom-num').fill('150');
  await page.getByTestId('typo-camera-zoom-num').press('Enter');
  await expect.poll(async () => (await readDoc(page, clipId))?.camera?.zoom).toBeCloseTo(1.5, 6);

  // 内联 transform 上多出一条前缀（translate / rotate / scale），并且框放大了 1.5×。
  await expect
    .poll(async () => (await shellBox(page))!.inline)
    .toContain('scale(1.5)');
  const after = (await shellBox(page))!;
  expect(after.width).toBeGreaterThan(before.width * 1.4);
  expect(after.height).toBeGreaterThan(before.height * 1.4);
});

test('复位镜头：字段删掉，画面回到恒等', async ({ page }) => {
  await boot(page);
  const clipId = await addTextClip(page);
  await openEditor(page, clipId);
  await selectFirstElement(page);
  await page.getByTestId('prop-depth-num').fill('100');
  await page.getByTestId('prop-depth-num').press('Enter');

  await openCamera(page);
  await page.getByTestId('typo-camera-zoom-num').fill('200');
  await page.getByTestId('typo-camera-zoom-num').press('Enter');
  await expect.poll(async () => (await readDoc(page, clipId))?.camera?.zoom).toBe(2);

  await page.getByTestId('typo-camera-reset').click();
  await expect.poll(async () => (await readDoc(page, clipId))?.camera).toBeUndefined();
  await expect.poll(async () => (await shellBox(page))!.inline).not.toContain('scale(');
});

test('命中跟着视差：放大后才出现的那片区域也能选中它', async ({ page }) => {
  await boot(page);
  const clipId = await addTextClip(page);
  await openEditor(page, clipId);
  await selectFirstElement(page);
  await page.getByTestId('prop-depth-num').fill('100');
  await page.getByTestId('prop-depth-num').press('Enter');

  await openCamera(page);
  await page.getByTestId('typo-camera-zoom-num').fill('200');
  await page.getByTestId('typo-camera-zoom-num').press('Enter');
  await expect.poll(async () => (await readDoc(page, clipId))?.camera?.zoom).toBe(2);
  // 关掉浮层（再点一次按钮 = 开合手势）：它盖住右上角，别让它吃掉后面的点击。
  await page.getByTestId('ribbon-camera').click();
  await expect(page.getByTestId('typo-camera-pop')).toHaveCount(0);

  const box = (await shellBox(page))!;
  /*
   * 点「放大后才存在」的那一圈：距中心 70% 宽处 —— 在放大后的框内、在原框外。
   * 命中测试若还按 `frame` 算，这一下会落到画布空白处（清空选择）；
   * 反过来它会选中同一个元素。判据就是「选择还在」。
   */
  await page.mouse.click(box.cx + box.width * 0.35, box.cy);
  await expect(page.getByTestId('prop-depth-num')).toBeVisible();
});
