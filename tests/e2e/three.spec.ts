/**
 * three.spec.ts — three.js 片段（实验）真的出图了吗。
 *
 * 这条用例守的是**四件会静默失效的事**，它们各自的表现都一样：画面一块空白，
 * 没有任何报错。
 *
 * 1. **朝向**：three 渲进自己的画布，再 `texImage2D` 进主上下文。翻与不翻都
 *    能出图，翻错就是整幅上下颠倒 —— 而「上下颠倒的抽象动画」肉眼未必看得出来。
 *    所以画面故意做成上红下蓝。
 * 2. **透明底**：three 的清屏 alpha 必须是 0。写错（清成黑）的表现是这一层
 *    永远挡住下面的轨道，与「背景色设错了」长得一模一样。
 * 3. **时间**：`update(t, frame)` 的 t 必须是**片段内秒**。接错（传绝对时间、
 *    或压根不调 update）时静止画面照样正常，只有对比两个时刻才看得出。
 * 4. **控制平面那条路**：`add_clip({kind:'three'})` 要过编译检查与一次试跑，
 *    而试跑结果必须真的回到回执里（模型只信那个 `ok`）。
 *
 * 断言的形状沿用 `tests/e2e/AGENTS.md`：数颜色、给宽阈值，不逐点比色 ——
 * 预览尺寸随窗口变。
 */

import { expect, test, type Page } from '@playwright/test';
import { openDemo } from './_stage';

/** three 画面上半红、下半蓝（正交相机 + 两块 2×1 平面，与画幅比例无关）。 */
const SPLIT_CODE = `
function create(THREE, ctx) {
  const scene = new THREE.Scene();
  const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 10);
  camera.position.z = 1;
  const top = new THREE.Mesh(
    new THREE.PlaneGeometry(2, 1),
    new THREE.MeshBasicMaterial({ color: 0xff0000 }),
  );
  top.position.set(0, 0.5, 0);
  const bottom = new THREE.Mesh(
    new THREE.PlaneGeometry(2, 1),
    new THREE.MeshBasicMaterial({ color: 0x0000ff }),
  );
  bottom.position.set(0, -0.5, 0);
  scene.add(top, bottom);
  return { scene, camera };
}
`;

/** 什么都不画：整层透明，下层必须原样透出来。 */
const EMPTY_CODE = `
function create(THREE, ctx) {
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(50, ctx.width / ctx.height, 0.1, 100);
  camera.position.z = 3;
  return { scene, camera };
}
`;

/** 白块在 t < 1 站左半边、t >= 1 站右半边：用来证明 t 真的进了 update。 */
const MOVING_CODE = `
function create(THREE, ctx) {
  const scene = new THREE.Scene();
  const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 10);
  camera.position.z = 1;
  const quad = new THREE.Mesh(
    new THREE.PlaneGeometry(1, 2),
    new THREE.MeshBasicMaterial({ color: 0xffffff }),
  );
  quad.position.set(-0.5, 0, 0);
  scene.add(quad);
  return { scene, camera, update(t) { quad.position.x = t >= 1 ? 0.5 : -0.5; } };
}
`;

/**
 * 8 条竖白条（占一半宽度，间隔一半）。
 *
 * 存在的理由：**渲染尺寸**。three 那个画布如果停在建上下文时的 2×2，上红下蓝
 * 与左右中段都会「看起来对」（大块色域上采样之后还是那个色域），只有细条纹会
 * 糊成一片。这条用例是那条 bug 唯一抓得住的东西。
 */
const STRIPES_CODE = `
function create(THREE, ctx) {
  const scene = new THREE.Scene();
  const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 10);
  camera.position.z = 1;
  const N = 8;
  for (let i = 0; i < N; i++) {
    const bar = new THREE.Mesh(
      new THREE.PlaneGeometry(2 / N / 2, 2),
      new THREE.MeshBasicMaterial({ color: 0xffffff }),
    );
    bar.position.set(-1 + (i + 0.25) * (2 / N), 0, 0);
    scene.add(bar);
  }
  return { scene, camera };
}
`;

const UNDER_RED = '#ff0000';

interface StageApi {
  store: {
    addTrack: (kind: 'visual', name?: string) => string;
    addClip: (trackId: string, clip: unknown) => void;
    commit: (label: string, fn: (p: { tracks: { id: string; enabled: boolean }[] }) => void) => void;
    project: { tracks: { id: string; clips: { id: string }[] }[] };
  };
  renderer: { onSeek: () => void };
  renderFrame: (t: number) => void;
  readPixels: () => { data: number[]; w: number; h: number };
}

/**
 * 搭舞台：底层一条纯红，上面一条 three。
 *
 * 与 `_stage.buildStage` 分开是因为那边只认 algo / solid —— 而这里要测的正是
 * 「three 这一层有没有盖住 / 透出下层」，两层的关系是断言的一部分。
 */
async function stage(page: Page, code: string): Promise<string> {
  return page.evaluate(
    ({ code, under }) => {
      const A = (window as never as { __artmatic: StageApi }).__artmatic;
      const base = {
        fadeSec: 0,
        curves: {},
        transform: { x: 0.5, y: 0.5, sx: 1, sy: 1, rot: 0 },
        fit: 'stretch',
        blend: 'normal',
        opacity: 1,
      };
      A.store.commit('e2e: 清空舞台', (p) => {
        for (const t of p.tracks) t.enabled = false;
      });
      // 先加 = 数组更靠前 = z 更高（z 序见 engine/stack.ts）。
      const threeTrack = A.store.addTrack('visual');
      A.store.addClip(threeTrack, {
        ...base,
        kind: 'source',
        id: 'e2e-three',
        start: 0,
        end: 8,
        label: 'e2e-three',
        source: { type: 'three', code },
      });
      const underTrack = A.store.addTrack('visual');
      A.store.addClip(underTrack, {
        ...base,
        kind: 'source',
        id: 'e2e-under',
        start: 0,
        end: 8,
        label: 'e2e-under',
        source: { type: 'solid', color: under },
      });
      A.store.commit('e2e: 启用舞台', (p) => {
        for (const t of p.tracks) t.enabled = t.id === threeTrack || t.id === underTrack;
      });
      // 回到首页时渲染服务可能还没装过 three 片段：给一次明确的 seek，
      // 让 `Renderer.onSeek` 那条路也走一遍（three 无状态，这一步只是对齐）。
      A.renderer.onSeek();
      return threeTrack;
    },
    { code, under: UNDER_RED },
  );
}

interface Sample {
  /** 屏幕上半 20% 的平均色（按 **屏幕** 方向，已经翻过行序）。 */
  top: [number, number, number];
  /** 屏幕下半 20% 的平均色。 */
  bottom: [number, number, number];
  /** 竖直中段的左 15%..35%（按 x 比例）。 */
  left: [number, number, number];
  /** 竖直中段的右 65%..85%。 */
  right: [number, number, number];
}

/** 渲一帧并按**屏幕方向**取四块色带。`readPixels` 是自下而上的。 */
async function sample(page: Page, t: number): Promise<Sample> {
  return page.evaluate((t) => {
    const A = (window as never as { __artmatic: StageApi }).__artmatic;
    A.renderFrame(t);
    const { data, w, h } = A.readPixels();
    const band = (x0f: number, x1f: number, y0f: number, y1f: number): [number, number, number] => {
      const x0 = Math.floor(w * x0f);
      const x1 = Math.max(x0 + 1, Math.floor(w * x1f));
      const y0 = Math.floor(h * y0f);
      const y1 = Math.max(y0 + 1, Math.floor(h * y1f));
      let r = 0;
      let g = 0;
      let b = 0;
      let n = 0;
      for (let y = y0; y < y1; y++) {
        for (let x = x0; x < x1; x++) {
          const i = (y * w + x) * 4;
          r += data[i]!;
          g += data[i + 1]!;
          b += data[i + 2]!;
          n++;
        }
      }
      return n ? [r / n, g / n, b / n] : [0, 0, 0];
    };
    return {
      // 缓冲区第 0 行是**画面底部**：bottom 取低行，top 取高行。
      bottom: band(0.4, 0.6, 0, 0.2),
      top: band(0.4, 0.6, 0.8, 1),
      left: band(0.15, 0.35, 0.4, 0.6),
      right: band(0.65, 0.85, 0.4, 0.6),
    };
  }, t);
}

/** three 的 `import('three')` 是异步的：第一帧缺席，轮询到真的出图为止。 */
async function waitForLayer(page: Page, t: number, ok: (s: Sample) => boolean, what: string): Promise<Sample> {
  let last: Sample | null = null;
  for (let i = 0; i < 60; i++) {
    last = await sample(page, t);
    if (ok(last)) return last;
    await page.waitForTimeout(50);
  }
  throw new Error(`three 层一直没有出图（${what}）：最后一次取样 ${JSON.stringify(last)}`);
}

const isRed = (c: [number, number, number]) => c[0] > 180 && c[1] < 60 && c[2] < 60;
const isBlue = (c: [number, number, number]) => c[2] > 180 && c[0] < 60 && c[1] < 60;
const isWhite = (c: [number, number, number]) => c[0] > 220 && c[1] > 220 && c[2] > 220;

/** 竖直中段、指定归一化 x 处的平均色（±1% 宽）。 */
async function colorsAt(page: Page, t: number, xs: number[]): Promise<[number, number, number][]> {
  return page.evaluate(
    ({ t, xs }) => {
      const A = (window as never as { __artmatic: StageApi }).__artmatic;
      A.renderFrame(t);
      const { data, w, h } = A.readPixels();
      return xs.map((xf) => {
        const cx = Math.min(w - 1, Math.max(0, Math.round(xf * w)));
        const half = Math.max(1, Math.round(w * 0.01));
        const y0 = Math.floor(h * 0.4);
        const y1 = Math.floor(h * 0.6);
        let r = 0;
        let g = 0;
        let b = 0;
        let n = 0;
        for (let y = y0; y < y1; y++) {
          for (let x = Math.max(0, cx - half); x < Math.min(w, cx + half); x++) {
            const i = (y * w + x) * 4;
            r += data[i]!;
            g += data[i + 1]!;
            b += data[i + 2]!;
            n++;
          }
        }
        return [r / n, g / n, b / n] as [number, number, number];
      });
    },
    { t, xs },
  );
}

test.beforeEach(async ({ page }) => {
  await page.goto('/');
  await page.waitForFunction(() => Boolean((window as never as { __artmatic?: unknown }).__artmatic));
  await openDemo(page);
});

test('朝向与出图：上红下蓝，说明翻转与上传都对了', async ({ page }) => {
  await stage(page, SPLIT_CODE);
  const s = await waitForLayer(page, 0.5, (v) => isRed(v.top) && isBlue(v.bottom), '上红下蓝');
  // 再渲一帧确认稳定（启动窗口内 GPU 有两个稳定态，AGENTS §1.3）。
  const again = await sample(page, 0.5);
  expect(isRed(again.top) && isBlue(again.bottom)).toBe(true);
  expect(s.top[0]).toBeGreaterThan(s.top[2]);
});

test('透明底：空场景不该挡住下层那条纯红', async ({ page }) => {
  await stage(page, EMPTY_CODE);
  /*
   * 这一层的全部像素都是 alpha 0 —— 判据是「纯红原样透出来」。
   * 清屏写成不透明黑的表现是整幅黑掉，而那种错在别的用例里看不出来
   * （上面的 SPLIT_CODE 整幅都有内容）。
   */
  const s = await waitForLayer(page, 0.5, (v) => isRed(v.top) && isRed(v.bottom), '纯红透出');
  expect(s.top[1]).toBeLessThan(40);
  expect(s.bottom[1]).toBeLessThan(40);
});

test('时间：update(t) 拿到的是片段内秒，两个时刻画面不同', async ({ page }) => {
  await stage(page, MOVING_CODE);
  // 白块 1×2 站一侧：正交相机的 x∈[-1,1] 铺满画宽，所以「左中 / 右中」就是判据。
  const early = await waitForLayer(page, 0.2, (v) => v.left[0] > 220 && v.left[1] > 220, 't=0.2 白块在左');
  expect(early.right[1]).toBeLessThan(60);
  const late = await sample(page, 1.4);
  expect(late.right[0]).toBeGreaterThan(220);
  expect(late.right[1]).toBeGreaterThan(220);
  expect(late.left[1]).toBeLessThan(60);
});

test('渲染尺寸：细条纹还是条纹，不是一片糊', async ({ page }) => {
  await stage(page, STRIPES_CODE);
  /*
   * 8 条白条各占 1/16 宽、间隔 1/16。取每条的**条心**与**缝心**共 16 个点。
   * 画布若停在 2×2（建上下文时的尺寸），这里拿到的是一串灰粉色 —— 大块色域
   * 上采样之后与「画对了」长得一样，所以只有这条用例抓得住。
   */
  const xs: number[] = [];
  for (let i = 0; i < 8; i++) xs.push((i + 0.25) / 8, (i + 0.75) / 8);
  let cols = await colorsAt(page, 0.5, xs);
  for (let i = 0; i < 30 && !cols.filter(isWhite).length; i++) {
    await page.waitForTimeout(50);
    cols = await colorsAt(page, 0.5, xs);
  }
  const barsWhite = cols.filter((_, i) => i % 2 === 0).every(isWhite);
  const gapsRed = cols.filter((_, i) => i % 2 === 1).every(isRed);
  expect({ barsWhite, gapsRed }).toEqual({ barsWhite: true, gapsRed: true });
});

test('控制平面：加片段 / 改代码 / 试跑回执都说真话', async ({ page }) => {
  const out = await page.evaluate(async () => {
    const A = (window as never as {
      __artmatic: {
        store: { addTrack: (kind: 'visual') => string; commit: (l: string, f: (p: unknown) => void) => void; project: { tracks: { id: string; clips: { id: string }[] }[] } };
        control: {
          addClip: (trackId: string, input: unknown) => Promise<{ ok: boolean; data?: { clipId: string; three: { ok: boolean; error: string | null; checked: string } }; error?: { code: string; message: string } }>;
          setThreeCode: (id: string, code: string) => Promise<{ ok: boolean; data?: { three: { ok: boolean; error: string | null; checked: string }; chars: number; lines: number }; error?: { code: string; message: string } }>;
          threeStatus: (id: string) => Promise<{ ok: boolean; data?: { ok: boolean; checked: string } }>;
          getScene: (opt?: unknown) => Promise<{ ok: boolean; data?: { tracks: { clips: { source?: { type?: string; code?: string } }[] }[] } }>;
        };
      };
    }).__artmatic;

    // 舞台只留一条空轨，别让 demo 的内容干扰「画面里有没有它」的判断。
    A.store.commit('e2e: 清空', (p) => {
      for (const t of (p as { tracks: { enabled: boolean }[] }).tracks) t.enabled = false;
    });
    const track = A.store.addTrack('visual');

    const added = await A.control.addClip(track, {
      kind: 'three',
      start: 0,
      end: 4,
      code: 'function create(THREE, ctx) {\n  const scene = new THREE.Scene();\n  const camera = new THREE.PerspectiveCamera(50, ctx.width / ctx.height, 0.1, 100);\n  camera.position.z = 3;\n  return { scene, camera };\n}',
    });
    if (!added.ok || !added.data) return { step: 'add', added };
    const id = added.data.clipId;

    const bad = await A.control.setThreeCode(id, 'function create( {');
    const thrown = await A.control.setThreeCode(
      id,
      'function create(THREE, ctx) {\n  throw new Error("boom");\n}',
    );
    const good = await A.control.setThreeCode(
      id,
      'function create(THREE, ctx) {\n  const scene = new THREE.Scene();\n  const camera = new THREE.PerspectiveCamera(50, ctx.width / ctx.height, 0.1, 100);\n  camera.position.z = 3;\n  return { scene, camera };\n}',
    );
    const status = await A.control.threeStatus(id);
    const scene = await A.control.getScene();
    const code = scene.data?.tracks.flatMap((t) => t.clips).find((c) => c.source?.type === 'three')?.source?.code;

    return {
      step: 'done',
      add: added.data.three,
      bad: { ok: bad.ok, code: bad.error?.code ?? null },
      thrown: thrown.data?.three ?? null,
      good: good.data?.three ?? null,
      lines: good.data?.lines ?? 0,
      status: status.data ?? null,
      readBack: typeof code === 'string' && code.includes('PerspectiveCamera'),
    };
  });

  expect(out.step).toBe('done');
  const v = out as {
    add: { ok: boolean; checked: string };
    bad: { ok: boolean; code: string | null };
    thrown: { ok: boolean; error: string | null; checked: string } | null;
    good: { ok: boolean; checked: string } | null;
    lines: number;
    status: { ok: boolean; checked: string } | null;
    readBack: boolean;
  };
  // 加片段时就试跑过一帧（模型据此知道「这版代码能不能出图」）。
  expect(v.add).toMatchObject({ ok: true, checked: 'render' });
  // 语法错误在**写入之前**被拒，落到 `invalid-argument`。
  expect(v.bad).toEqual({ ok: false, code: 'invalid-argument' });
  // 语法过了、运行时抛：写入成功但试跑失败，错误原样回来。
  expect(v.thrown?.ok).toBe(false);
  expect(v.thrown?.error).toContain('boom');
  expect(v.thrown?.checked).toBe('render');
  expect(v.good).toMatchObject({ ok: true, checked: 'render' });
  expect(v.lines).toBeGreaterThan(3);
  expect(v.status).toMatchObject({ ok: true, checked: 'render' });
  // get_scene 把代码原样带回来（读回 → 改一行 → 写回的闭环）。
  expect(v.readBack).toBe(true);
});
