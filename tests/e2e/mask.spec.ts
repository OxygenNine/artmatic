/**
 * mask.spec.ts — 外部蒙版（P2）：一个特效真的读到**另一片段的输出**。
 *
 * 判据只有一条，但必须是逐像素的：**被引用片段在哪、蒙版就只在哪起作用**。
 * 「画面变了」不够 —— 蒙版接歪、通道取错、或者根本没接上（1×1 全白占位）
 * 都会让画面变，而它们要的是完全不同的断言。
 *
 * 舞台（z 从下到上）：
 *   1. 底：中灰纯色，铺满；
 *   2. 蒙版源：**红色**纯色，只占左半（`transform.x = 0.25, sx = 0.5`），
 *      放在**禁用轨道**上 —— 它不进画面，但仍然是可引用的片段。这条同时钉住了
 *      「引用的是片段，不是这一帧恰好画了什么」；
 *   3. 特效：`grade-qualifier` 的键开到最大（选全图）+ 曝光 +2EV。
 *
 * 于是：
 *   - 没接蒙版 ⇒ 左右都变亮；
 *   - 接 `alpha` ⇒ **左半**变亮、右半不动；
 *   - 换成 `g`（红块的绿通道恒为 0）⇒ 全图都不变亮（通道真的被用上了）。
 */

import { expect, test, type Page } from '@playwright/test';
import { openDemo } from './_stage';

type Api = {
  __artmatic: {
    store: {
      commit: (
        label: string,
        fn: (p: { tracks: { enabled: boolean; name: string }[] }) => void,
      ) => void;
      addTrack: (kind: 'visual', name?: string) => string;
      addClip: (trackId: string, clip: unknown) => void;
      setEffectMaskRef: (clipId: string, instanceId: string, ref: unknown) => boolean;
      findClip: (clipId: string) => { clip: unknown } | null;
      setEffectBoundClip: (clipId: string, boundClipId: string | null) => void;
      updateClip: (clipId: string, label: string, fn: (c: { chain: { enabled: boolean; values: Record<string, number | string> }[] }) => void) => void;
    };
    renderer: {
      onSeek: () => void;
      poolStats: () => { masks: number };
      renderFrame: (p: unknown, t: number) => void;
    };
    renderFrame: (t: number) => void;
    readPixels: () => { data: number[]; w: number; h: number };
  };
};

interface Stage {
  baseClipId: string;
  maskClipId: string;
  fxClipId: string;
  fxInstanceId: string;
}

/** 键开到最大 = 「只靠外部蒙版决定范围」。 */
const SELECT_ALL = {
  hueRange: 180,
  softness: 0,
  satMin: 0,
  lumaMin: 0,
  lumaMax: 1,
  invert: 0,
  exposure: 2,
  saturation: 1,
  hueShift: 0,
  amount: 1,
};

interface StageOpts {
  defId?: string;
  values?: Record<string, number>;
  baseColor?: string;
}

async function buildStage(page: Page, opts: StageOpts = {}): Promise<Stage> {
  return page.evaluate(({ selectAll, defId, values, baseColor }) => {
    const A = (window as never as Api).__artmatic;
    const store = A.store;
    const base = { fadeSec: 0, curves: {}, start: 0, end: 8, blend: 'normal', opacity: 1, fit: 'stretch' };

    // demo 的轨道全关：它们的 echo 是反馈型，会污染「同一 t 两渲」的读数。
    store.commit('e2e: 清空舞台', (p) => {
      for (const t of p.tracks) t.enabled = false;
    });

    /*
     * addTrack 是 push ⇒ **后加的轨 z 更低**。所以按「上 → 下」的顺序建：
     * 特效先加（数组最靠后 → z 最低）…不对，见 engine/stack.ts 的 z 映射：
     * z = last - 下标，数组末尾 z=0。所以**先加的是最上层**。
     * 这里顺序就是「特效 → 蒙版源 → 底」的反面：先加 fx，再加蒙版源，最后加底。
     */
    const fxTrack = store.addTrack('visual', 'fx');
    const maskTrack = store.addTrack('visual', 'maskSrc');
    const baseTrack = store.addTrack('visual', 'base');

    const fxClipId = 'e2e-mask-fx';
    const fxInstanceId = 'e2e-mask-inst';
    store.addClip(fxTrack, {
      ...base,
      kind: 'effect',
      id: fxClipId,
      label: 'fx',
      chain: [{ instanceId: fxInstanceId, defId, enabled: true, values: { ...selectAll, ...values } }],
    });

    // 蒙版源：红块只占左半（sx = 0.5，中心 x = 0.25）。
    const maskClipId = 'e2e-mask-src';
    store.addClip(maskTrack, {
      ...base,
      kind: 'source',
      id: maskClipId,
      label: 'mask',
      source: { type: 'solid', color: '#ff0000' },
      transform: { x: 0.25, y: 0.5, sx: 0.5, sy: 1, rot: 0 },
    });

    const baseClipId = 'e2e-mask-base';
    store.addClip(baseTrack, {
      ...base,
      kind: 'source',
      id: baseClipId,
      label: 'base',
      source: { type: 'solid', color: baseColor },
      transform: { x: 0.5, y: 0.5, sx: 1, sy: 1, rot: 0 },
    });

    // 只启用 fx 与底：蒙版源留在禁用轨上（它仍然可以被引用）。
    store.commit('e2e: 启用舞台', (p) => {
      for (const t of p.tracks) {
        t.enabled = t.name === 'fx' || t.name === 'base';
      }
    });

    return { baseClipId, maskClipId, fxClipId, fxInstanceId };
  }, {
    selectAll: SELECT_ALL,
    defId: opts.defId ?? 'grade-qualifier',
    values: opts.values ?? {},
    baseColor: opts.baseColor ?? '#808080',
  });
}

/** 采样一个点（`fx` 是横向比例）。渲前 seek：反馈历史不该参与读数。 */
async function pixelAt(page: Page, fx: number, fy = 0.5): Promise<[number, number, number, number]> {
  return page.evaluate(
    ({ fx, fy }) => {
      const A = (window as never as Api).__artmatic;
      A.renderer.onSeek();
      A.renderFrame(2);
      const { data, w, h } = A.readPixels();
      const x = Math.min(w - 1, Math.max(0, Math.floor(fx * w)));
      const y = Math.min(h - 1, Math.max(0, Math.floor(fy * h)));
      const i = (y * w + x) * 4;
      return [data[i]!, data[i + 1]!, data[i + 2]!, data[i + 3]!] as [number, number, number, number];
    },
    { fx, fy },
  );
}

async function setEnabled(page: Page, stage: Stage, enabled: boolean): Promise<void> {
  await page.evaluate(
    ({ clipId, enabled }) => {
      const A = (window as never as Api).__artmatic;
      A.store.updateClip(clipId, 'e2e: fx enabled', (c) => {
        c.chain[0]!.enabled = enabled;
      });
    },
    { clipId: stage.fxClipId, enabled },
  );
}

test('外部蒙版：被引用片段只覆盖左半 ⇒ 只有左半被调亮', async ({ page }) => {
  await page.goto('/');
  await page.waitForFunction(() => Boolean((window as never as { __artmatic?: unknown }).__artmatic));
  const stage = await buildStage(page);

  // 基线：特效关掉时左右都是中灰。
  await setEnabled(page, stage, false);
  const baseLeft = await pixelAt(page, 0.25);
  const baseRight = await pixelAt(page, 0.75);
  expect(baseLeft[0]).toBeGreaterThan(100);
  expect(Math.abs(baseLeft[0] - baseRight[0])).toBeLessThanOrEqual(3);

  // 特效开、不接蒙版：两侧一起变亮（+2EV）。
  await setEnabled(page, stage, true);
  const plainLeft = await pixelAt(page, 0.25);
  const plainRight = await pixelAt(page, 0.75);
  expect(plainLeft[0] - baseLeft[0], '不接蒙版时全图应该一起被调亮').toBeGreaterThan(40);
  expect(plainRight[0] - baseRight[0], '不接蒙版时全图应该一起被调亮').toBeGreaterThan(40);
  expect(await page.evaluate(() => (window as never as Api).__artmatic.renderer.poolStats().masks)).toBe(0);

  // 接 alpha：红块的 alpha 只在左半为 1（铺满层框），右半是层外 ⇒ 0。
  const ok = await page.evaluate(
    ({ clipId, instanceId, maskClipId }) =>
      (window as never as Api).__artmatic.store.setEffectMaskRef(clipId, instanceId, {
        kind: 'clip',
        clipId: maskClipId,
        channel: 'alpha',
      }),
    { clipId: stage.fxClipId, instanceId: stage.fxInstanceId, maskClipId: stage.maskClipId },
  );
  expect(ok, '接一个不成环的引用应当成功').toBe(true);

  const maskedLeft = await pixelAt(page, 0.25);
  const maskedRight = await pixelAt(page, 0.75);
  expect(maskedLeft[0] - baseLeft[0], '蒙版覆盖的左半必须仍然被调亮').toBeGreaterThan(40);
  expect(Math.abs(maskedRight[0] - baseRight[0]), '蒙版之外的右半必须回到原样').toBeLessThanOrEqual(3);
  expect(await page.evaluate(() => (window as never as Api).__artmatic.renderer.poolStats().masks)).toBe(1);

  // 换通道：红块的绿通道恒为 0 ⇒ 蒙版全黑 ⇒ 全图都不该被调亮。
  await page.evaluate(
    ({ clipId, instanceId, maskClipId }) =>
      (window as never as Api).__artmatic.store.setEffectMaskRef(clipId, instanceId, {
        kind: 'clip',
        clipId: maskClipId,
        channel: 'g',
      }),
    { clipId: stage.fxClipId, instanceId: stage.fxInstanceId, maskClipId: stage.maskClipId },
  );
  const greenLeft = await pixelAt(page, 0.25);
  const greenRight = await pixelAt(page, 0.75);
  expect(Math.abs(greenLeft[0] - baseLeft[0]), 'channel=g 时蒙版应当是 0').toBeLessThanOrEqual(3);
  expect(Math.abs(greenRight[0] - baseRight[0]), 'channel=g 时蒙版应当是 0').toBeLessThanOrEqual(3);
});

test('检查器里能接上：每个特效都有这一行', async ({ page }) => {
  await page.goto('/');
  await page.waitForFunction(() => Boolean((window as never as Api).__artmatic));
  await openDemo(page);
  const stage = await buildStage(page);

  await page.evaluate((id) => {
    (
      window as never as { __artmatic: { appState: { selectedClipId: string | null } } }
    ).__artmatic.appState.selectedClipId = id;
  }, stage.fxClipId);

  // 还没接：只有来源下拉，没有通道（通道跟着引用走，单独一个通道下拉没有语义）。
  await expect(page.getByTestId('effect-mask-source')).toBeVisible();
  await expect(page.getByTestId('effect-mask-channel')).toHaveCount(0);

  await page.getByTestId('effect-mask-source').click();
  await page.getByTestId('effect-mask-opt-e2e-mask-src').click();

  const stored = await page.evaluate((clipId) => {
    const A = (window as never as Api).__artmatic;
    const found = A.store.findClip(clipId);
    const clip = found?.clip as { chain?: { inputs?: { mask?: unknown } }[] } | undefined;
    return clip?.chain?.[0]?.inputs?.mask ?? null;
  }, stage.fxClipId);
  expect(stored).toEqual({ kind: 'clip', clipId: 'e2e-mask-src', channel: 'luma' });

  // 接上之后通道才出现，换它写回同一个引用（只换 channel）。
  await expect(page.getByTestId('effect-mask-channel')).toBeVisible();
  await page.getByTestId('effect-mask-channel').click();
  await page.getByTestId('effect-mask-channel-opt-alpha').click();
  const rechannelled = await page.evaluate((clipId) => {
    const A = (window as never as Api).__artmatic;
    const clip = A.store.findClip(clipId)?.clip as { chain?: { inputs?: { mask?: unknown } }[] } | undefined;
    return clip?.chain?.[0]?.inputs?.mask ?? null;
  }, stage.fxClipId);
  expect(rechannelled).toEqual({ kind: 'clip', clipId: 'e2e-mask-src', channel: 'alpha' });

  /*
   * 换成另一个特效（blur 的 shader 里没有一行蒙版代码）：这一行**仍然在**
   * —— 缺省的 `composite` 模式在链上混回，所以「每个特效都能接」是协议层的事，
   * 不需要 def 声明。摘掉引用之后通道行跟着消失。
   */
  await page.evaluate(
    ({ clipId, instanceId }) => {
      const A = (window as never as Api).__artmatic;
      A.store.setEffectMaskRef(clipId, instanceId, null);
      A.store.updateClip(clipId, 'e2e: 换成 blur', (c) => {
        const inst = (c as unknown as { chain: { defId: string }[] }).chain[0]!;
        inst.defId = 'blur';
      });
    },
    { clipId: stage.fxClipId, instanceId: stage.fxInstanceId },
  );
  await expect(page.getByTestId('effect-mask-source')).toBeVisible();
  await expect(page.getByTestId('effect-mask-channel')).toHaveCount(0);
});

test('没声明 mask 的特效也能接：去饱和只在蒙版范围内生效', async ({ page }) => {
  await page.goto('/');
  await page.waitForFunction(() => Boolean((window as never as Api).__artmatic));
  // bleach 的 shader 里没有一行蒙版代码 —— 它走的是缺省的 composite 模式
  // （特效 pass 之后 `mix(输入, 输出, mask)`）。这条用例守的就是「协议层兜底」：
  // 81 个特效不需要各自声明，接上就该局部生效。
  const stage = await buildStage(page, { defId: 'bleach', values: { amount: 1 }, baseColor: '#ff0000' });

  const plainLeft = await pixelAt(page, 0.25);
  const plainRight = await pixelAt(page, 0.75);
  // 不接蒙版：整幅去饱和（红通道掉下来、绿通道升上去）。
  expect(plainLeft[0] - plainLeft[1]).toBeLessThan(30);
  expect(plainRight[0] - plainRight[1]).toBeLessThan(30);

  const ok = await page.evaluate(
    ({ clipId, instanceId, maskClipId }) =>
      (window as never as Api).__artmatic.store.setEffectMaskRef(clipId, instanceId, {
        kind: 'clip',
        clipId: maskClipId,
        channel: 'alpha',
      }),
    { clipId: stage.fxClipId, instanceId: stage.fxInstanceId, maskClipId: stage.maskClipId },
  );
  expect(ok).toBe(true);

  const maskedLeft = await pixelAt(page, 0.25);
  const maskedRight = await pixelAt(page, 0.75);
  expect(maskedLeft[0] - maskedLeft[1], '蒙版覆盖的左半仍被去饱和').toBeLessThan(30);
  expect(maskedRight[0] - maskedRight[1], '蒙版之外的右半必须仍是原色（纯红）').toBeGreaterThan(200);
});

test('成环的引用在写入口被拒，画面与工程都不变', async ({ page }) => {
  await page.goto('/');
  await page.waitForFunction(() => Boolean((window as never as { __artmatic?: unknown }).__artmatic));
  const stage = await buildStage(page);

  // 先把特效绑到底层片段上 ⇒ 底层的层要跑这条链（依赖边 base → fx）。
  await page.evaluate(
    ({ clipId, baseClipId }) => {
      (window as never as Api).__artmatic.store.setEffectBoundClip(clipId, baseClipId);
    },
    { clipId: stage.fxClipId, baseClipId: stage.baseClipId },
  );

  // 再让这条链引用底层自己 ⇒ base → fx → base。store 必须拒。
  const rejected = await page.evaluate(
    ({ clipId, instanceId, baseClipId }) =>
      (window as never as Api).__artmatic.store.setEffectMaskRef(clipId, instanceId, {
        kind: 'clip',
        clipId: baseClipId,
        channel: 'luma',
      }),
    { clipId: stage.fxClipId, instanceId: stage.fxInstanceId, baseClipId: stage.baseClipId },
  );
  expect(rejected, '指向自己的绑定片段必须被拒').toBe(false);

  /*
   * 控制平面用的是**同一个判据** —— 那条在 `agent-control-plane.test.ts` 里验
   * （这里没有「打开的工程」，控制平面的写接口会先返回 `no-project`，
   * 那是另一回事，混进来只会让失败原因变糊）。
   */

  // 工程里没有留下半条引用：渲染照常（画面上蒙版数为 0）。
  expect(await page.evaluate(() => (window as never as Api).__artmatic.renderer.poolStats().masks)).toBe(0);
  const left = await pixelAt(page, 0.25);
  expect(left[0], '画面仍然渲得出来').toBeGreaterThan(100);
});
