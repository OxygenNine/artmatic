import { expect, test, type Page } from '@playwright/test';
import {
  buildImageStage,
  openDemo,
  readClipImageState,
  rgbaAtTopLeft,
  setClipKey,
  settle,
} from './_stage';

/**
 * 「简易抠图」（`SourceClip.key`，v7 引入）的 E2E 守卫。
 *
 * 素材是页面内现画的 640×360 PNG，**横向三段**：左 1/3 纯白 / 中 1/3 浅灰
 * (#e0e0e0) / 右 1/3 纯红；下面垫一条纯蓝的 solid 背景轨。
 *
 * 为什么横着分三段（而不是上下两半）：判据全部落在**水平位置**上，于是不会和
 * `readPixels` 的行序（GL 左下原点）纠缠；上下方向由 quad 用例单独负责。
 *
 * 判据的数学（placement.frag 的抠图实现，见 task 契约）：
 *
 *   d = sqrt(|Δchroma|² + 0.25·Δluma²)   // 到键色的距离
 *   t0 = tolerance/2, w = max(softness/2, 1e-4)
 *   keep = smoothstep(t0, t0+w, d)       // 0 = 全透明，1 = 完整保留
 *
 * - 白色 d=0：任何容差下都被抠掉（tolerance 0.3 → t0=0.15）。
 * - 浅灰 #e0e0e0 与白的距离 **d≈0.0608**（只差亮度）：
 *     tolerance 0.30 → t0=0.15，d<t0 ⇒ 被抠掉；
 *     tolerance 0.05 + softness 0.01 → t0=0.025, w=0.005，d≈0.061>0.03 ⇒ 完整保留。
 *   这条是「容差语义」的判据 —— 不是「画面变了」（那两张黑图也满足）。
 * - 纯红 #ff0000 的 d≈0.634 ≫ 任何上述 t0 ⇒ 永远保留。
 *
 * 每条用例都从**空舞台**起步（`buildImageStage` 关掉 demo 全部轨道），并且
 * **先量基线再量 A/B**：没有基线的「变蓝/变红」断言在两张黑图下也会通过。
 */

const WHITE = '#ffffff';
const GREY = '#e0e0e0';
const RED = '#ff0000';
const BLUE = '#0000ff';

type Rgba = [number, number, number, number];

/** 探针的时间点：图片片段是 [0,8)，1s 处稳稳在画面里。 */
const T = 1;

/** 三段各自的中心（横向归一化坐标）。 */
const LEFT = 1 / 6;
const MIDDLE = 0.5;
const RIGHT = 5 / 6;

const fmt = (c: Rgba): string => `rgba(${c.join(', ')})`;

async function boot(page: Page): Promise<void> {
  await page.goto('/');
  await page.waitForFunction(() => (window as never as { __artmatic?: unknown }).__artmatic);
  await openDemo(page);
}

/* ------------------------------------------------------------ 分通道判据 */

/* 判据写成「不变量」而不是「等于某个具体值」：GPU 量化 + 纹理采样会差 1~2，
   写死 255 会在换机器时假失败；而这些区间只对「颜色类别」敏感。 */

function expectWhite(c: Rgba, where: string): void {
  expect(c[0], `${where}：应为白（R>200），实测 ${fmt(c)}`).toBeGreaterThan(200);
  expect(c[1], `${where}：应为白（G>200），实测 ${fmt(c)}`).toBeGreaterThan(200);
  expect(c[2], `${where}：应为白（B>200），实测 ${fmt(c)}`).toBeGreaterThan(200);
}

function expectGrey(c: Rgba, where: string): void {
  expect(c[0], `${where}：浅灰应可见（R>150），实测 ${fmt(c)}`).toBeGreaterThan(150);
  expect(c[1], `${where}：浅灰应可见（G>150），实测 ${fmt(c)}`).toBeGreaterThan(150);
}

function expectRed(c: Rgba, where: string): void {
  expect(c[0], `${where}：红色应保留（R>180），实测 ${fmt(c)}`).toBeGreaterThan(180);
  expect(c[1], `${where}：红色应保留（G<100），实测 ${fmt(c)}`).toBeLessThan(100);
  expect(c[2], `${where}：红色应保留（B<100），实测 ${fmt(c)}`).toBeLessThan(100);
}

/** 被抠掉的区域应当透出纯蓝背景（R/G 近 0、B 高）。 */
function expectBlue(c: Rgba, where: string): void {
  expect(c[0], `${where}：应透出蓝色背景（R<60），实测 ${fmt(c)}`).toBeLessThan(60);
  expect(c[1], `${where}：应透出蓝色背景（G<60），实测 ${fmt(c)}`).toBeLessThan(60);
  expect(c[2], `${where}：应透出蓝色背景（B>180），实测 ${fmt(c)}`).toBeGreaterThan(180);
}

/** 解析 `#rrggbb`；吸管取色要求三通道都 > 235（= 取到白色）。 */
function hexChannels(hex: string | undefined): [number, number, number] {
  expect(hex, `键色应当是 #rrggbb，实测 ${String(hex)}`).toMatch(/^#[0-9a-fA-F]{6}$/);
  const n = parseInt(hex!.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

/* ============================================================ 场景 A：渲染 */

test('抠图渲染：白底被抠掉透出下层、浅灰按容差保留、红色不受影响（A/B）', async ({ page }) => {
  await boot(page);
  const stage = await buildImageStage(page, {
    pattern: { kind: 'thirds', left: WHITE, middle: GREY, right: RED },
    background: BLUE,
  });
  await settle(page, T);

  /* ---- 1) 基线：三段各是各的颜色（先证明"不是两张黑图"） ---- */
  const white0 = await rgbaAtTopLeft(page, T, LEFT, 0.5);
  const grey0 = await rgbaAtTopLeft(page, T, MIDDLE, 0.5);
  const red0 = await rgbaAtTopLeft(page, T, RIGHT, 0.5);
  expectWhite(white0, '基线·左段');
  expectGrey(grey0, '基线·中段');
  expectRed(red0, '基线·右段');

  /* ---- 2) key(color=白, tolerance=0.30)：白与浅灰都该被抠掉，红保留 ---- */
  await setClipKey(page, stage.imageClipId, {
    color: WHITE,
    tolerance: 0.3,
    softness: 0.01,
    spill: 0,
  });
  expect((await readClipImageState(page, stage.imageClipId)).key?.color).toBe(WHITE);
  await settle(page, T);
  const white1 = await rgbaAtTopLeft(page, T, LEFT, 0.5);
  const grey1 = await rgbaAtTopLeft(page, T, MIDDLE, 0.5);
  const red1 = await rgbaAtTopLeft(page, T, RIGHT, 0.5);
  expectBlue(white1, 'tolerance=0.30·左段（白）');
  expectBlue(grey1, 'tolerance=0.30·中段（浅灰 d≈0.061 < t0=0.15）');
  expectRed(red1, 'tolerance=0.30·右段（红 d≈0.634）');

  /* ---- 3) tolerance=0.05 + softness=0.01：浅灰恢复可见，白仍被抠 ---- */
  await setClipKey(page, stage.imageClipId, {
    color: WHITE,
    tolerance: 0.05,
    softness: 0.01,
    spill: 0,
  });
  await settle(page, T);
  const white2 = await rgbaAtTopLeft(page, T, LEFT, 0.5);
  const grey2 = await rgbaAtTopLeft(page, T, MIDDLE, 0.5);
  const red2 = await rgbaAtTopLeft(page, T, RIGHT, 0.5);
  expectBlue(white2, 'tolerance=0.05·左段（白 d=0）');
  expectGrey(grey2, 'tolerance=0.05·中段（浅灰 d≈0.061 > t0+w=0.03）');
  expectRed(red2, 'tolerance=0.05·右段（红）');

  /* ---- 4) 删除 key：回到基线（白又出现） ---- */
  await setClipKey(page, stage.imageClipId, null);
  expect((await readClipImageState(page, stage.imageClipId)).key).toBeNull();
  await settle(page, T);
  const white3 = await rgbaAtTopLeft(page, T, LEFT, 0.5);
  const grey3 = await rgbaAtTopLeft(page, T, MIDDLE, 0.5);
  const red3 = await rgbaAtTopLeft(page, T, RIGHT, 0.5);
  expectWhite(white3, '删除 key·左段（应恢复基线白）');
  expectGrey(grey3, '删除 key·中段（应恢复基线灰）');
  expectRed(red3, '删除 key·右段（应恢复基线红）');
});

/* ================================================== 场景 B：UI 接线 + 吸管 */

test('抠图 UI：开关写库、默认参数、吸管从画面取白并立即生效', async ({ page }) => {
  await boot(page);
  const stage = await buildImageStage(page, {
    pattern: { kind: 'thirds', left: WHITE, middle: GREY, right: RED },
    background: BLUE,
  });
  await settle(page, T);

  // 选中片段 → 检查器抽屉自动打开，出现抠图区块
  await page.evaluate((id) => {
    const A = (window as never as { __artmatic: { appState: { selectClip: (x: string) => void } } })
      .__artmatic;
    A.appState.selectClip(id);
  }, stage.imageClipId);
  await expect(page.getByTestId('keying-section')).toBeVisible();

  const enable = page.getByTestId('clip-key-enable');

  /* ---- 5) 开 → 写入默认值；关 → 删除（都是 store 层的断言，不只 DOM） ---- */
  await enable.click();
  await expect
    .poll(async () => (await readClipImageState(page, stage.imageClipId)).key)
    .toEqual({ color: '#00ff00', tolerance: 0.25, softness: 0.12, spill: 0.5 });
  await expect(page.getByTestId('clip-key-color')).toBeVisible();
  await expect(page.getByTestId('clip-key-pick')).toBeVisible();

  await enable.click();
  await expect.poll(async () => (await readClipImageState(page, stage.imageClipId)).key).toBeNull();
  await expect(page.getByTestId('clip-key-color')).toHaveCount(0);

  /* ---- 6) 再开 → 吸管点画面左 1/3（白），键色变成白、取色模式结束 ---- */
  await enable.click();
  await expect.poll(async () => (await readClipImageState(page, stage.imageClipId)).key).not.toBeNull();

  // 吸管读的是 playT 处「只渲染这一轨」的一帧 —— 先把播放头放到素材稳稳在场的位置
  await page.evaluate(() => {
    (window as never as { __artmatic: { appState: { playT: number } } }).__artmatic.appState.playT = 1;
  });

  await page.getByTestId('clip-key-pick').click();
  const canvas = (await page.locator('#gl').boundingBox())!;
  // 左 1/3 的中心：画面坐标是左上原点，但取色只关心横向位置；纵向取正中
  await page.mouse.click(canvas.x + canvas.width / 6, canvas.y + canvas.height / 2);

  await expect
    .poll(async () => hexChannels((await readClipImageState(page, stage.imageClipId)).key?.color).join(','))
    .not.toBe('0,255,0'); // 不再是默认键色（绿）—— 先给出「确实改了」的失败信息

  const pickedKey = (await readClipImageState(page, stage.imageClipId)).key!;
  const [pr, pg, pb] = hexChannels(pickedKey.color);
  expect(pr, `吸管应取到白色（R>235），实测 ${pickedKey.color}`).toBeGreaterThan(235);
  expect(pg, `吸管应取到白色（G>235），实测 ${pickedKey.color}`).toBeGreaterThan(235);
  expect(pb, `吸管应取到白色（B>235），实测 ${pickedKey.color}`).toBeGreaterThan(235);
  // 吸管只改键色，不该动其余三个参数
  expect(pickedKey.tolerance, `吸管不该改容差，实测 ${JSON.stringify(pickedKey)}`).toBe(0.25);
  expect(pickedKey.softness).toBe(0.12);
  expect(pickedKey.spill).toBe(0.5);

  // 取色模式必须结束（否则下一次点画面还会继续改键色）
  const pickMode = await page.evaluate(
    () =>
      (window as never as { __artmatic: { appState: { keyPickClipId?: string | null } } }).__artmatic
        .appState.keyPickClipId ?? null,
  );
  expect(pickMode, '取色结束后 keyPickClipId 必须复位为 null').toBeNull();

  // 反向自检：再点画面右 1/3（红）不应再改键色
  await page.mouse.click(canvas.x + (canvas.width * 5) / 6, canvas.y + canvas.height / 2);
  const afterExtraClick = (await readClipImageState(page, stage.imageClipId)).key!;
  expect(
    afterExtraClick.color,
    `取色模式已结束，再点画面不该改键色（实测 ${afterExtraClick.color}）`,
  ).toBe(pickedKey.color);

  /* ---- 7) 吸管拿到的白直接生效：左段透出蓝背景 ---- */
  await settle(page, T);
  const leftKeyed = await rgbaAtTopLeft(page, T, LEFT, 0.5);
  const midKeyed = await rgbaAtTopLeft(page, T, MIDDLE, 0.5);
  const rightKeyed = await rgbaAtTopLeft(page, T, RIGHT, 0.5);
  expectBlue(leftKeyed, '吸管取白后·左段');
  // 默认 tolerance=0.25 → t0=0.125，浅灰 d≈0.061 也被抠掉（键色白、容差不小）
  expectBlue(midKeyed, '吸管取白后·中段（t0=0.125 > d≈0.061）');
  expectRed(rightKeyed, '吸管取白后·右段（红不受影响）');
});
