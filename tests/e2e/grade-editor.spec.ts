import { expect, test, type Page } from '@playwright/test';
import { buildStage, openDemo, rgbaAt, settle } from './_stage';

/**
 * 调色页（P1）的 E2E。
 *
 * 判据全部落在**像素**上，而不是「面板出现了」：
 *  - 拖色轮必须让画面变色（不是只有数字动了）；
 *  - 前 / 后对比必须回到基线（旁路真的生效，而不是按钮亮了）；
 *  - 曲线拖上去必须变亮；
 *  - 示波器只在面板可见时才有探针数据（`readPixels` 是同步 stall，不能白花）。
 */

const GREY = '#808080';

async function openEditor(page: Page): Promise<void> {
  // 双击 = 进片段自己的编辑器（与排版页同一手势）。
  await page.locator('[data-clip-id="fx"]').dblclick();
  // 侧栏出现 = 真的进了调色页（不是 drawer、不是 modal）。
  await expect(page.getByTestId('grade-rail')).toBeVisible();
  await expect(page.getByTestId('grade-panels')).toBeVisible();
  /*
   * 进页会触发一次整体重排，排版光栅化（异步）可能在这一刻才落地 ——
   * 只 `settle` 会读到中间态（实测差 20 多个色阶）。所以先给异步的那一套
   * 一点时间，再等画面稳定。
   */
  await page.waitForTimeout(400);
}

async function stats(page: Page): Promise<{ floatSupported: boolean; allocFloat: boolean }> {
  return page.evaluate(
    () =>
      (window as never as { __artmatic: { gradeStats: () => { floatSupported: boolean; allocFloat: boolean } } })
        .__artmatic.gradeStats(),
  );
}

test('双击调色片段打开面板；拖色轮改画面，前 / 后对比回到基线', async ({ page }) => {
  await page.goto('/');
  await page.waitForFunction(() => (window as never as { __artmatic?: unknown }).__artmatic);
  await openDemo(page);
  await buildStage(
    page,
    { id: 'src', source: { type: 'solid', color: GREY } },
    { id: 'fx', defId: 'grade-basic', values: {} },
  );
  await settle(page, 1);
  await openEditor(page);
  await settle(page, 1);

  // 有调色 ⇒ 这一帧的中间缓冲应当是 16F（P0 的判定在面板打开后也成立）。
  const s = await stats(page);
  test.skip(!s.floatSupported, '这台机器没有 EXT_color_buffer_float');
  expect(s.allocFloat).toBe(true);

  /*
   * 基线取「同一场景、调色旁路」的那一帧，而不是打开面板之前的：
   * 打开面板要等排版/字体那一套稳定下来，早取会读到中间态（实测差 20+ 个色阶）。
   */
  await page.getByTestId('grade-ab').click();
  await settle(page, 1);
  const base = await rgbaAt(page, 1, 0.5, 0.5);
  await page.getByTestId('grade-ab').click();
  await settle(page, 1);
  // 恒等参数的 grade-basic 必须与原片逐通道一致。
  const identity = await rgbaAt(page, 1, 0.5, 0.5);
  for (let i = 0; i < 3; i += 1) {
    expect(Math.abs(identity[i]! - base[i]!), `恒等调色不该改画面：${identity.join(',')} vs ${base.join(',')}`).toBeLessThanOrEqual(2);
  }

  // 把暗部轮盘往红推：拖动落在盘内，半径 > 0。
  const ring = page.getByTestId('grade-wheel-ring-lift');
  const box = (await ring.boundingBox())!;
  await page.mouse.move(box.x + box.width * 0.78, box.y + box.height * 0.5);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * 0.8, box.y + box.height * 0.52, { steps: 3 });
  await page.mouse.up();
  await settle(page, 1);

  const graded = await rgbaAt(page, 1, 0.5, 0.5);
  expect(graded[0]!, `暗部往红推之后 R 应当上升：${base.join(',')} → ${graded.join(',')}`).toBeGreaterThan(
    base[0]! + 8,
  );


  // 前 / 后：旁路整条链，画面必须回到基线（±2 是 8 位落盘的余量）。
  await page.getByTestId('grade-ab').click();
  await settle(page, 1);
  const bypassed = await rgbaAt(page, 1, 0.5, 0.5);
  for (let i = 0; i < 3; i += 1) {
    expect(
      Math.abs(bypassed[i]! - base[i]!),
      `第 ${i} 通道：对比原片 ${bypassed.join(',')} vs 基线 ${base.join(',')}`,
    ).toBeLessThanOrEqual(2);
  }

  // 切回「看调色」，画面回到调过的样子（不是卡在原片）。
  await page.getByTestId('grade-ab').click();
  await settle(page, 1);
  const back = await rgbaAt(page, 1, 0.5, 0.5);
  expect(Math.abs(back[0]! - graded[0]!)).toBeLessThanOrEqual(2);
});

test('曲线：加一个模块、拖控制点上去，画面变亮', async ({ page }) => {
  await page.goto('/');
  await page.waitForFunction(() => (window as never as { __artmatic?: unknown }).__artmatic);
  await openDemo(page);
  await buildStage(
    page,
    { id: 'src', source: { type: 'solid', color: GREY } },
    { id: 'fx', defId: 'grade-basic', values: {} },
  );
  await settle(page, 1);

  await openEditor(page);
  // 基线同样取「面板已打开、曲线还没加」的那一帧。
  const base = await rgbaAt(page, 1, 0.5, 0.5);
  await page.getByTestId('grade-add-curves').click();
  await expect(page.getByTestId('grade-curve-canvas-master')).toBeVisible();

  // 双击空白处加一个中点，然后把它往上拖 —— 中灰提亮。
  const cv = page.getByTestId('grade-curve-canvas-master');
  const b = (await cv.boundingBox())!;
  await page.mouse.dblclick(b.x + b.width * 0.5, b.y + b.height * 0.5);
  // 四个通道各有一张图，所以点数要按**这张图**数（不是整页）。
  await expect(page.locator('[data-testid="grade-curve-canvas-master-point"]')).toHaveCount(3);

  await page.mouse.move(b.x + b.width * 0.5, b.y + b.height * 0.5);
  await page.mouse.down();
  await page.mouse.move(b.x + b.width * 0.5, b.y + b.height * 0.28, { steps: 4 });
  await page.mouse.up();
  await settle(page, 1);

  const brighter = await rgbaAt(page, 1, 0.5, 0.5);
  expect(
    brighter[0]!,
    `曲线往上拉之后应当更亮：${base.join(',')} → ${brighter.join(',')}`,
  ).toBeGreaterThan(base[0]! + 10);
});

/**
 * 拖一长段（而不是只拖四下）。
 *
 * 一张曲线表按「四条参数串」做键缓存，所以拖动时**每一帧都是一个新键**，缓存
 * 一定会满。曾经淘汰顺序写反（先淘汰再刷新 `used`），被删的恰好是刚建好、下一行
 * 就要绑的那张表 —— 表现出来是「拖到第七八步画面就不动了，刷新页面才能恢复」，
 * 既不报错也不掉帧。这条用例盯的是**画面在整段拖动里逐步跟随**，不是「最后更亮」：
 * 后者在冻住之后仍然成立（画面停在某个中间态上也是亮的）。
 */
test('曲线：一路拖上去时画面逐步跟随（缓存不吞新表）', async ({ page }) => {
  await page.goto('/');
  await page.waitForFunction(() => (window as never as { __artmatic?: unknown }).__artmatic);
  await openDemo(page);
  await buildStage(
    page,
    { id: 'src', source: { type: 'solid', color: GREY } },
    { id: 'fx', defId: 'grade-basic', values: {} },
  );
  await settle(page, 1);
  await openEditor(page);
  await page.getByTestId('grade-add-curves').click();

  const cv = page.getByTestId('grade-curve-canvas-master');
  await expect(cv).toBeVisible();
  const b = (await cv.boundingBox())!;
  await page.mouse.dblclick(b.x + b.width * 0.5, b.y + b.height * 0.5);
  await expect(page.locator('[data-testid="grade-curve-canvas-master-point"]')).toHaveCount(3);

  await page.mouse.move(b.x + b.width * 0.5, b.y + b.height * 0.5);
  await page.mouse.down();
  const samples: number[] = [];
  for (let i = 1; i <= 24; i += 1) {
    await page.mouse.move(b.x + b.width * 0.5, b.y + b.height * (0.5 - i * 0.008));
    if (i % 4 === 0) samples.push((await rgbaAt(page, 1, 0.5, 0.5))[0]!);
  }
  await page.mouse.up();

  for (let i = 1; i < samples.length; i += 1) {
    expect(
      samples[i]!,
      `第 ${(i + 1) * 4} 步画面没有跟随（冻在旧表上）：${samples.join(',')}`,
    ).toBeGreaterThan(samples[i - 1]! + 4);
  }
});

test('示波器：面板在时才有探针数据，关掉就停', async ({ page }) => {
  await page.goto('/');
  await page.waitForFunction(() => (window as never as { __artmatic?: unknown }).__artmatic);
  await openDemo(page);
  await buildStage(
    page,
    { id: 'src', source: { type: 'solid', color: GREY } },
    { id: 'fx', defId: 'grade-basic', values: {} },
  );

  const frameNow = () =>
    page.evaluate(
      () => (window as never as { __artmatic: { renderer: { scopeFrame: () => unknown } } }).__artmatic.renderer.scopeFrame() !== null,
    );

  await settle(page, 1);
  expect(await frameNow(), '面板没开时不该有探针数据').toBe(false);

  await openEditor(page);
  await settle(page, 1);
  // 探针每 6 帧采一次，`settle` 已经渲染了足够多帧。
  expect(await frameNow(), '面板打开后应当采到一帧').toBe(true);

  // Esc = 退出调色页（页面不是 modal，没有右上角的 ×）。
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('grade-rail')).toHaveCount(0);
  expect(await frameNow(), '关掉面板必须停掉探针（readPixels 是同步 stall）').toBe(false);
});

test('查找表：导入 .cube 后画面真的按表变，名字也显示出来', async ({ page }) => {
  await page.goto('/');
  await page.waitForFunction(() => (window as never as { __artmatic?: unknown }).__artmatic);
  await openDemo(page);
  await buildStage(
    page,
    { id: 'src', source: { type: 'solid', color: GREY } },
    { id: 'fx', defId: 'grade-basic', values: {} },
  );
  await settle(page, 1);
  await openEditor(page);
  const base = await rgbaAt(page, 1, 0.5, 0.5);

  /*
   * 2×2×2 的**反相** LUT：每个节点 = 1 - 输入。中灰 128 → 约 127（仍在中灰附近），
   * 所以判据取「与原片不同」而不是「变亮/变暗」—— 反相在中灰上最不明显，
   * 这正好说明判据不能依靠方向。
   */
  const inv = `LUT_3D_SIZE 2
${[0, 1]
  .map((b) => [0, 1].map((g) => [0, 1].map((r) => `${1 - r} ${1 - g} ${1 - b}`).join('\n')).join('\n'))
  .join('\n')}
`;
  await page.getByTestId('grade-lut-input').setInputFiles({
    name: 'invert.cube',
    mimeType: 'text/plain',
    buffer: Buffer.from(inv, 'utf8'),
  });
  await expect(page.getByTestId('grade-lut-name')).toHaveText('invert');

  // 纹理是异步载入的（读盘 / 解析），给它一拍再取像素。
  await page.waitForTimeout(300);
  await settle(page, 1);
  const after = await rgbaAt(page, 1, 0.5, 0.5);
  expect(after.join(','), `反相 LUT 应当改变画面：${base.join(',')} → ${after.join(',')}`).not.toBe(base.join(','));
});

test('色轮：拖动**中途**把手与数值就跟着走（不是松手才更新）', async ({ page }) => {
  await page.goto('/');
  await page.waitForFunction(() => (window as never as { __artmatic?: unknown }).__artmatic);
  await openDemo(page);
  await buildStage(
    page,
    { id: 'src', source: { type: 'solid', color: GREY } },
    { id: 'fx', defId: 'grade-basic', values: {} },
  );
  await settle(page, 1);
  await openEditor(page);

  const knob = page.locator('[data-testid="grade-wheel-ring-lift"] >> .ring-knob');
  const before = await knob.evaluate((el) => (el as HTMLElement).style.transform);

  const ring = page.getByTestId('grade-wheel-ring-lift');
  const box = (await ring.boundingBox())!;
  await page.mouse.move(box.x + box.width * 0.5, box.y + box.height * 0.5);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * 0.82, box.y + box.height * 0.26, { steps: 3 });

  /*
   * 松手前就读：色轮写的是 store 里的**普通对象**，漏了 `void appState.version`
   * 时把手要等下一次别的重绘才跳 —— 表现为「拖的时候只有画面动、把手不动」。
   */
  const mid = await page.evaluate(() => {
    const A = (window as never as {
      __artmatic: { store: { findClip: (id: string) => { clip: { chain: { values: Record<string, number> }[] } } } };
    }).__artmatic;
    const clip = A.store.findClip('fx').clip;
    const el = document.querySelector('[data-testid="grade-wheel-ring-lift"] .ring-knob') as HTMLElement;
    return { r: clip.chain[0]!.values['lift#r'] ?? 0, transform: el.style.transform };
  });

  await page.mouse.up();
  await settle(page, 1);

  expect(mid.r, '拖动中途就该写进 store').toBeGreaterThan(0.1);
  expect(mid.transform, '把手必须在拖动中途跟着动，而不是松手才跳').not.toBe(before);
});

test('侧栏图标：关掉示波器 / 查找表后画面变宽，再打开还原', async ({ page }) => {
  await page.goto('/');
  await page.waitForFunction(() => (window as never as { __artmatic?: unknown }).__artmatic);
  await openDemo(page);
  await buildStage(
    page,
    { id: 'src', source: { type: 'solid', color: GREY } },
    { id: 'fx', defId: 'grade-basic', values: {} },
  );
  await settle(page, 1);
  await openEditor(page);

  /*
   * 量的是**预览容器**（`.preview`）而不是 canvas：canvas 的像素尺寸由
   * `renderer.syncSize` 按工程分辨率定，容器变宽不会立刻改它（还要等一次
   * 重排）。容器才是「画面占多大地方」的真源。
   */
  const previewWidth = async (): Promise<number> =>
    (await page.locator('.preview').first().boundingBox())!.width;

  const withDock = await previewWidth();
  await page.getByTestId('grade-close-scopes').click();
  await page.getByTestId('grade-close-lut').click();
  await expect(page.getByTestId('grade-dock')).toHaveCount(0);
  await settle(page, 1);
  const withoutDock = await previewWidth();
  expect(withoutDock, `收起码头后画面应当变宽：${withDock} → ${withoutDock}`).toBeGreaterThan(withDock + 40);

  // 侧栏图标是同一个开关：点回来要有。
  await page.getByTestId('grade-panel-scopes').click();
  await expect(page.getByTestId('grade-dock')).toBeVisible();
  await expect(page.getByTestId('grade-scope-canvas')).toBeVisible();
});

test('片段在调色页里被删掉 → 自动退回时间轴（不留半态）', async ({ page }) => {
  await page.goto('/');
  await page.waitForFunction(() => (window as never as { __artmatic?: unknown }).__artmatic);
  await openDemo(page);
  await buildStage(
    page,
    { id: 'src', source: { type: 'solid', color: GREY } },
    { id: 'fx', defId: 'grade-basic', values: {} },
  );
  await settle(page, 1);
  await openEditor(page);

  /*
   * 不收视图的话界面长得像时间轴，而快捷键仍被调色页那一支接管
   * （S / Del 全失效），顶栏 tab 上的色轮图标也还亮着。
   */
  await page.evaluate(() => {
    (window as never as { __artmatic: { store: { removeClip: (id: string) => void } } }).__artmatic.store.removeClip(
      'fx',
    );
  });
  await expect(page.getByTestId('grade-rail')).toHaveCount(0);
  await expect(page.getByTestId('topbar')).toBeVisible();
  // 时间轴回来了：轨道区可见（调色页里它是 display:none）。
  await expect(page.getByTestId('tracks-resize')).toBeVisible();
});

test('进度条：拖它真的改播放头（时间轴隐藏后唯一的寻帧入口）', async ({ page }) => {
  await page.goto('/');
  await page.waitForFunction(() => (window as never as { __artmatic?: unknown }).__artmatic);
  await openDemo(page);
  await buildStage(
    page,
    { id: 'src', source: { type: 'solid', color: GREY } },
    { id: 'fx', defId: 'grade-basic', values: {} },
  );
  await settle(page, 1);
  await openEditor(page);

  const before = await page.evaluate(
    () => (window as never as { __artmatic: { appState: { playT: number } } }).__artmatic.appState.playT,
  );
  const bar = page.getByTestId('grade-scrub');
  const b = (await bar.boundingBox())!;
  await page.mouse.move(b.x + b.width * 0.2, b.y + b.height / 2);
  await page.mouse.down();
  await page.mouse.move(b.x + b.width * 0.6, b.y + b.height / 2, { steps: 4 });
  await page.mouse.up();

  const after = await page.evaluate(
    () => (window as never as { __artmatic: { appState: { playT: number } } }).__artmatic.appState.playT,
  );
  expect(after, `播放头应当跟着进度条走：${before} → ${after}`).toBeGreaterThan(before + 0.5);
});

test('面板接缝：色轮 / 曲线宽度可拖，示波器 / 查找表高度可拖', async ({ page }) => {
  await page.goto('/');
  await page.waitForFunction(() => (window as never as { __artmatic?: unknown }).__artmatic);
  await openDemo(page);
  await buildStage(
    page,
    { id: 'src', source: { type: 'solid', color: GREY } },
    { id: 'fx', defId: 'grade-basic', values: {} },
  );
  await settle(page, 1);
  await openEditor(page);

  const widthOf = async (id: string): Promise<number> =>
    (await page.getByTestId(id).boundingBox())!.width;

  const w0 = await widthOf('grade-wheels-panel');
  const split = page.getByTestId('grade-panels-split');
  const s = (await split.boundingBox())!;
  await page.mouse.move(s.x + s.width / 2, s.y + s.height / 2);
  await page.mouse.down();
  await page.mouse.move(s.x + 140, s.y + s.height / 2, { steps: 4 });
  await page.mouse.up();
  const w1 = await widthOf('grade-wheels-panel');
  expect(w1, `拖接缝之后色轮那一栏应当变宽：${w0} → ${w1}`).toBeGreaterThan(w0 + 40);

  // 码头：示波器 / 查找表之间的高度
  const hOf = async (id: string): Promise<number> =>
    (await page.getByTestId(id).boundingBox())!.height;
  const h0 = await hOf('grade-scopes-panel');
  const dsplit = page.getByTestId('grade-dock-split');
  const d = (await dsplit.boundingBox())!;
  await page.mouse.move(d.x + d.width / 2, d.y + d.height / 2);
  await page.mouse.down();
  await page.mouse.move(d.x + d.width / 2, d.y + 120, { steps: 4 });
  await page.mouse.up();
  const h1 = await hOf('grade-scopes-panel');
  expect(h1, `拖码头接缝之后示波器应当变高：${h0} → ${h1}`).toBeGreaterThan(h0 + 40);
});

test('曲线：分页按钮（放不下四张时）与每通道独立生效', async ({ page }) => {
  await page.goto('/');
  await page.waitForFunction(() => (window as never as { __artmatic?: unknown }).__artmatic);
  await openDemo(page);
  await buildStage(
    page,
    { id: 'src', source: { type: 'solid', color: GREY } },
    { id: 'fx', defId: 'grade-basic', values: {} },
  );
  await settle(page, 1);
  await openEditor(page);
  await page.getByTestId('grade-add-curves').click();
  await expect(page.getByTestId('grade-curve-canvas-master')).toBeVisible();

  /*
   * 一页放不下四张时才有翻页（一页几张取决于窗口宽度，1280 下只有一张）。
   * 一路翻到最后一页：B 必须出现、主曲线必须消失 —— 那证明是「换页」而不是
   * 「裁掉」。
   */
  const counter = page.getByTestId('grade-curve-page');
  const at = async (): Promise<[number, number]> => {
    const t = (await counter.textContent())?.trim() ?? '0/0';
    const [cur, total] = t.split('/').map(Number);
    return [cur ?? 0, total ?? 0];
  };
  for (let i = 0; i < 4; i += 1) {
    const [cur, total] = await at();
    if (cur >= total) break;
    await page.getByTestId('grade-curve-next').click();
    await expect.poll(async () => (await at())[0]).toBe(cur + 1);
  }
  await expect(page.getByTestId('grade-curve-canvas-b')).toBeVisible();
  await expect(page.getByTestId('grade-curve-canvas-master')).toHaveCount(0);
  // 往回翻一页：页码必须减一（不是「翻不动」）
  const [last] = await at();
  await page.getByTestId('grade-curve-prev').click();
  await expect.poll(async () => (await at())[0]).toBe(last - 1);

  /*
   * 三张表各自落到自己的通道上。判据是**逐通道**的：曾经有过「四张表读到同一
   * 行」的怀疑，只有分开断言才分得清「都生效」和「只有一个生效」。
   */
  const sample = async (): Promise<[number, number, number]> =>
    page.evaluate(() => {
      const A = (window as never as { __artmatic: { renderer: { onSeek: () => void }; renderFrame: (p: unknown, t: number) => void; readPixels: () => { data: Uint8ClampedArray; w: number; h: number }; store: { project: unknown } } }).__artmatic;
      A.renderer.onSeek();
      A.renderFrame(A.store.project, 1);
      const { data, w, h } = A.readPixels();
      const i = (Math.floor(h / 2) * w + Math.floor(w / 2)) * 4;
      return [data[i]!, data[i + 1]!, data[i + 2]!] as [number, number, number];
    });

  /** 直接往曲线模块写一条表（绕开鼠标，只为验通道落点）。 */
  const setCurve = async (key: string, str: string): Promise<void> => {
    await page.evaluate(
      ({ k, v }) => {
        const A = (window as never as {
          __artmatic: {
            store: {
              commit: (
                label: string,
                fn: (p: {
                  tracks: {
                    clips: {
                      id: string;
                      chain: { defId: string; values: Record<string, number | string> }[];
                    }[];
                  }[];
                }) => void,
              ) => void;
            };
          };
        }).__artmatic;
        A.store.commit('e2e', (p) => {
          for (const t of p.tracks) {
            for (const c of t.clips) {
              if (c.id !== 'fx') continue;
              const cur = c.chain.find((i) => i.defId === 'grade-curves');
              if (cur) cur.values[k] = v;
            }
          }
        });
      },
      { k: key, v: str },
    );
  };

  const base = await sample();
  await setCurve('curve#r', '0,0;1,0');
  const rCut = await sample();
  expect(rCut[0], `R 表压到底之后 R 通道应当接近 0：${base.join(',')} → ${rCut.join(',')}`).toBeLessThan(8);
  expect(rCut[1], '其他通道不应该被 R 表带走').toBeGreaterThan(100);

  await setCurve('curve#r', '');
  await setCurve('curve#g', '0,0;1,0');
  const gCut = await sample();
  expect(gCut[1], 'G 表只压 G 通道').toBeLessThan(8);
  expect(gCut[0]).toBeGreaterThan(100);
});

test('参数滑杆：拖动中途数值框与滑杆一起走（不是只有画面在变）', async ({ page }) => {
  await page.goto('/');
  await page.waitForFunction(() => (window as never as { __artmatic?: unknown }).__artmatic);
  await openDemo(page);
  await buildStage(
    page,
    { id: 'src', source: { type: 'solid', color: GREY } },
    { id: 'fx', defId: 'grade-basic', values: {} },
  );
  await settle(page, 1);
  await openEditor(page);

  const num = page.getByTestId('grade-param-num-contrast');
  const before = Number(await num.inputValue());
  const bar = page.getByTestId('grade-param-contrast');
  const b = (await bar.boundingBox())!;
  await page.mouse.move(b.x + b.width * 0.5, b.y + b.height / 2);
  await page.mouse.down();
  await page.mouse.move(b.x + b.width * 0.75, b.y + b.height / 2, { steps: 4 });

  /*
   * 松手前就读：`values` 是普通对象的原地写，`rows` 派生漏了
   * `void appState.version` 时，画面在变而滑杆与数字不动 —— 用户的原话是
   * 「调色轮实时更新但曲线可以」，其实是同一类漏法在不同组件上的表现。
   */
  const mid = Number(await num.inputValue());
  await page.mouse.up();
  await settle(page, 1);
  expect(mid, `拖动中途数值框就该变：${before} → ${mid}`).toBeGreaterThan(before + 0.05);

  const contrastOf = async (): Promise<number> =>
    page.evaluate(() => {
      const A = (window as never as {
        __artmatic: {
          store: { findClip: (id: string) => { clip: { chain: { defId: string; values: Record<string, number> }[] } } };
        };
      }).__artmatic;
      return A.store.findClip('fx').clip.chain.find((i) => i.defId === 'grade-basic')!.values['contrast']!;
    });

  const stored = await contrastOf();
  expect(Math.abs(stored - mid), `UI 与落库值必须一致：${stored} vs ${mid}`).toBeLessThan(1e-6);

  /*
   * **加上曲线之后再拖一次。**
   *
   * 滑杆认的是「面板上摆着的那个 `grade-basic`」，不是「当前模块」：曾经写入端
   * 走 `appState.gradeInstanceId`，而「加上曲线」正是把它改成曲线模块的那一步 ——
   * 之后滑杆把 `contrast` 写进一个**没有这个参数**的实例，把手不动、画面不动、
   * 不报错，离开调色页再进来又好了（用户报的「偶发滑块无响应」）。
   */
  await page.getByTestId('grade-add-curves').click();
  await expect(page.getByTestId('grade-curve-canvas-master')).toBeVisible();
  const b2 = (await bar.boundingBox())!;
  await page.mouse.move(b2.x + b2.width * 0.5, b2.y + b2.height / 2);
  await page.mouse.down();
  await page.mouse.move(b2.x + b2.width * 0.2, b2.y + b2.height / 2, { steps: 4 });
  await page.mouse.up();
  await settle(page, 1);

  const afterCurves = await contrastOf();
  expect(
    Math.abs(afterCurves - stored),
    `加上曲线之后滑杆仍必须改到 grade-basic：${stored} → ${afterCurves}`,
  ).toBeGreaterThan(0.05);
});

test('侧栏提示说清是哪个面板（不是「展开面板」）', async ({ page }) => {
  await page.goto('/');
  await page.waitForFunction(() => (window as never as { __artmatic?: unknown }).__artmatic);
  await openDemo(page);
  await buildStage(
    page,
    { id: 'src', source: { type: 'solid', color: GREY } },
    { id: 'fx', defId: 'grade-basic', values: {} },
  );
  await settle(page, 1);
  await openEditor(page);

  await page.getByTestId('grade-panel-scopes').hover();
  await expect(page.getByTestId('tip-bubble')).toContainText('收起示波器面板');
  // 关掉之后同一颗图标的提示要变成「展开…」
  await page.getByTestId('grade-close-scopes').click();
  await page.getByTestId('grade-panel-scopes').hover();
  await expect(page.getByTestId('tip-bubble')).toContainText('展开示波器面板');
});
