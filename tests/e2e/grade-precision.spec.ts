import { expect, test, type Page } from '@playwright/test';
import { buildStage, openDemo, rgbaAt, settle } from './_stage';

/**
 * P0 色彩管线的 E2E：**有调色就升 16F，没浮点就明着降级**。
 *
 * 用 `grade-basic` 这个 defId 而工程里暂时没有这个模块（P1 才落）—— 未知特效
 * 在 runner 里是**原样传递**（向前兼容），所以它在这里正好充当一个「什么都不做
 * 的调色模块」：能触发 16F 判定，又不会改变画面。等 P1 真的把它注册进来，
 * 这条用例只会变得更强（画面断言仍然成立）。
 *
 * 两条判据分开取，因为它们是两件不同的事：
 *  1. 分配（`gradeStats().float`）—— 16F 有没有真的拿到；
 *  2. 可见性（`grade-precision-warn`）—— 拿不到的时候用户看不看得见。
 * 「画面变没变」不作判据（原样传递本来就不变），改用「基线与有调色逐通道一致」
 * 证明升精度没有引入回归。
 */

const GREY = '#808080';

interface GradeStats {
  requested: boolean;
  float: boolean;
  allocFloat: boolean;
  reason: 'idle' | 'ok' | 'no-float' | 'over-budget';
  targets: number;
  floatSupported: boolean;
}

async function gradeStats(page: Page): Promise<GradeStats> {
  return page.evaluate(
    () => (window as never as { __artmatic: { gradeStats: () => GradeStats } }).__artmatic.gradeStats(),
  );
}

/** 只在页面脚本启动之前改掉扩展探测：`Target.float` 与判定层都走它。 */
async function withoutFloatTargets(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const proto = WebGL2RenderingContext.prototype;
    const orig = proto.getExtension;
    // 只挡这一个：其余扩展（含 sim 用的浮点能力）保持原样，免得一条用例顺手改了别的路径。
    proto.getExtension = function (this: WebGL2RenderingContext, name: string) {
      if (name === 'EXT_color_buffer_float') return null;
      return orig.call(this, name);
    } as typeof proto.getExtension;
  });
}

test('链里有调色 ⇒ 中间缓冲是 16F，且画面与没有调色时逐通道一致', async ({ page }) => {
  await page.goto('/');
  await page.waitForFunction(() => (window as never as { __artmatic?: unknown }).__artmatic);
  await openDemo(page);

  const stage = await buildStage(
    page,
    { id: 'src', source: { type: 'solid', color: GREY } },
    { id: 'fx', defId: 'grade-basic', values: {} },
  );
  await settle(page, 1);

  const stats = await gradeStats(page);
  test.skip(!stats.floatSupported, '这台机器的 WebGL2 没有 EXT_color_buffer_float');
  expect(stats.requested, '这一帧应当被判定为「有调色」').toBe(true);
  expect(stats.reason).toBe('ok');
  expect(stats.float).toBe(true);
  // 判定与实际分配分开断言：前者是「我们打算升」，后者是 GL 真的给了。
  expect(stats.allocFloat, '中间目标实际必须是 RGBA16F').toBe(true);
  expect(stats.targets, '主链至少要 ping/pong 两张浮点目标').toBeGreaterThanOrEqual(2);

  const graded = await rgbaAt(page, 1, 0.5, 0.5);
  // 关掉那条调色轨拿基线：升精度不该改变任何像素（原样传递 + 8bit 落盘）。
  await page.evaluate((id) => {
    const A = (window as never as { __artmatic: { store: { commit: (l: string, fn: (p: unknown) => void) => void } } })
      .__artmatic;
    A.store.commit('e2e: 关调色轨', (p) => {
      const tracks = (p as { tracks: { id: string; enabled: boolean }[] }).tracks;
      const fx = tracks.find((t) => t.id === id);
      if (fx) fx.enabled = false;
    });
  }, stage.effectTrack);
  const base = await rgbaAt(page, 1, 0.5, 0.5);
  for (let i = 0; i < 3; i += 1) {
    expect(
      Math.abs(graded[i]! - base[i]!),
      `第 ${i} 通道：有调色 ${graded.join(',')} vs 无调色 ${base.join(',')}`,
    ).toBeLessThanOrEqual(2);
  }

  // 调色轨关掉之后判定要跟着回到 idle（按 op 列表扫，而不是按工程扫），
  // 而且中间缓冲要退回 8 位 —— 「没有调色也占 2× 显存」是不许发生的回归。
  const after = await gradeStats(page);
  expect(after.requested).toBe(false);
  expect(after.allocFloat, '没有调色还在用 16F 中间缓冲 = 白花一倍显存').toBe(false);
});

test('没有浮点渲染目标 ⇒ 退回 8 位，检查器里看得见', async ({ page }) => {
  await withoutFloatTargets(page);
  await page.goto('/');
  await page.waitForFunction(() => (window as never as { __artmatic?: unknown }).__artmatic);
  await openDemo(page);

  await buildStage(
    page,
    { id: 'src', source: { type: 'solid', color: GREY } },
    { id: 'fx', defId: 'grade-basic', values: {} },
  );
  await settle(page, 1);

  const stats = await gradeStats(page);
  expect(stats.floatSupported, '这条用例的前提是扩展被拿掉').toBe(false);
  expect(stats.reason).toBe('no-float');
  expect(stats.float, '没有浮点目标时不许声称自己是 16F').toBe(false);
  expect(stats.allocFloat).toBe(false);

  // 选中调色片段，提示条必须出现（「用户以为自己有 16 bit」是这条的唯一防线）。
  await page.evaluate(() => {
    (window as never as { __artmatic: { appState: { selectedClipId: string | null } } }).__artmatic.appState.selectedClipId =
      'fx';
  });
  const warn = page.getByTestId('grade-precision-warn');
  await expect(warn).toBeVisible();
  await expect(warn).toContainText('8 位');

  // 画面照常出（降级是降精度，不是拒渲）。
  const px = await rgbaAt(page, 1, 0.5, 0.5);
  expect(px[0], `灰底应当照常出现，实测 ${px.join(',')}`).toBeGreaterThan(0x60);
});
