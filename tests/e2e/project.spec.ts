/**
 * project.spec.ts — 工程持久化的端到端验证。
 *
 * ## 为什么跑在 OPFS 上而不是 mock 一个文件系统
 *
 * `navigator.storage.getDirectory()` 返回的**就是一个 `FileSystemDirectoryHandle`**，
 * 与 `showDirectoryPicker()` 给的是同类对象。所以这里跑的是真实文件系统、
 * 真实的 `createWritable` swap 语义、真实的目录遍历 —— 不是桩。
 *
 * 生产与测试走的是**同一条代码路径**，唯一差别是「根句柄从哪来」。
 * `showDirectoryPicker()` 是系统对话框，Playwright 驱动不了，这是绕开它的
 * 唯一诚实的办法：不假装，只是换一个真根。（硬约束 1.5 的推论：
 * 任何只能在 Electron 里跑起来才能测的功能设计，都应当视为设计错误。）
 */

import { createHash } from 'node:crypto';
import { expect, test, type Page } from '@playwright/test';
import { openDemo } from './_stage';

/** `window.__artmatic` 在页面里的形状。类型只在编译期存在，运行时被擦除。 */
type W = {
  __artmatic: {
    project: {
      useOpfs(name?: string): Promise<string>;
      save(): Promise<boolean>;
      open(name?: string): Promise<boolean>;
      read(path: string): Promise<string | null>;
      list(path?: string): Promise<{ name: string; kind: string }[]>;
      remove(path: string): Promise<void>;
      write(path: string, bytes: number[]): Promise<void>;
      wipe(name?: string): Promise<void>;
      /** 立即写一次会话状态（不等 0.9 s 防抖）。 */
      sessionNow(): Promise<void>;
    };
    store: {
      project: {
        name: string;
        assets: Record<string, unknown>;
        tracks: { clips: { id: string; label?: string; source?: { type?: string } }[] }[];
      };
      commit(label: string, fn: (p: Record<string, unknown>) => void): boolean;
    };
    /** 打开的工程列表（摊平的纯数据）。 */
    projects(): {
      name: string;
      dirty: boolean;
      active: boolean;
      view: string;
      saved: boolean;
      dir: string | null;
    }[];
    appState: {
      projectDirty: boolean;
      projectName: string;
      projectIssues: { kind: string; severity: string; message: string; path: string | null }[];
      playT: number;
      selectedClipId: string | null;
      seek(t: number): void;
      /** 进排版编辑页（工程视图，不是 modal）。 */
      openTypographyTab(clipId: string): void;
      flash(text: string, level?: 'info' | 'success' | 'error'): void;
      removeAsset(id: string): void;
    };
    assets: {
      put(id: string, bytes: Uint8Array, input: Record<string, unknown>): void;
      ids(): string[];
      /** 已移除但字节文件仍保留的素材。 */
      retainedIds(): string[];
    };
  };
};

const DIR = 'e2e-project';

/** 一份固定的假 PNG 头 + 几个字节。内容不重要，重要的是它在 Node 侧也能算哈希。 */
const ASSET_BYTES = [137, 80, 78, 71, 13, 10, 26, 10, 1, 2, 3, 4];

async function boot(page: Page): Promise<void> {
  await page.goto('/');
  await page.waitForFunction(() => (window as never as W).__artmatic);
  await openDemo(page);
  // 上一轮的残留会让「文件存在」这类断言假绿。
  await page.evaluate((d) => (window as never as W).__artmatic.project.wipe(d), DIR);
}

/** 打开的工程列表（摊平的纯数据，跨 realm 传得回来）。 */
function projects(page: Page): Promise<Awaited<ReturnType<W['__artmatic']['projects']>>> {
  return page.evaluate(() => (window as never as W).__artmatic.projects());
}

/** 底栏提示当前算出来的颜色。 */
function noticeColor(page: Page): Promise<string> {
  return page.evaluate(() => {
    const el = document.querySelector('[data-testid=notice]');
    return el ? getComputedStyle(el).color : '';
  });
}

/**
 * 某个 token 解析成 `rgb(...)` 之后的样子。
 *
 * `getComputedStyle().color` 永远是 rgb 空间，而 token 是 hex，
 * 所以要比色就得先让浏览器把变量也解析一遍 —— 直接比字符串必然不相等。
 */
function tokenColor(page: Page, name: string): Promise<string> {
  return page.evaluate((n) => {
    const probe = document.createElement('span');
    document.body.appendChild(probe);
    probe.style.color = `var(${n})`;
    const out = getComputedStyle(probe).color;
    probe.remove();
    return out;
  }, name);
}

test.describe('工程目录的保存与打开', () => {
  test.beforeEach(async ({ page }) => boot(page));

  test('保存建出完整的目录结构', async ({ page }) => {
    await page.evaluate((d) => (window as never as W).__artmatic.project.useOpfs(d), DIR);
    await page.evaluate(() => (window as never as W).__artmatic.project.save());

    const top = (await page.evaluate((d) => (window as never as W).__artmatic.project.list(d), DIR)).map((i) => i.name);
    expect(top).toContain('project.json');
    expect(top).toContain('assets.json');
    expect(top).toContain('assets');
    expect(top).toContain('analysis');
    expect(top).toContain('thumbs');

    const analysis = await page.evaluate((d) => (window as never as W).__artmatic.project.list(`${d}/analysis`), DIR);
    expect(analysis.map((i) => i.name)).toContain('audio');
  });


  test('保存 → 改动 → 再保存：.bak 是上一版，当前是最新版', async ({ page }) => {
    await page.evaluate((d) => (window as never as W).__artmatic.project.useOpfs(d), DIR);
    await page.evaluate(() => (window as never as W).__artmatic.project.save());
    const first = await page.evaluate((d) => (window as never as W).__artmatic.project.read(`${d}/project.json`), DIR);

    await page.evaluate(() => {
      (window as never as W).__artmatic.store.commit('改名', (p) => {
        p.name = '改过名的工程';
      });
    });
    await page.evaluate(() => (window as never as W).__artmatic.project.save());

    const now = await page.evaluate((d) => (window as never as W).__artmatic.project.read(`${d}/project.json`), DIR);
    const bak = await page.evaluate((d) => (window as never as W).__artmatic.project.read(`${d}/project.json.bak`), DIR);
    expect((JSON.parse(now!) as { name: string }).name).toBe('改过名的工程');
    // 逐字节相同 —— .bak 就是上一次成功保存的那一份，不是重新序列化的近似品。
    expect(bak).toBe(first);
  });

  test('重新打开工程，内容与保存时完全一致', async ({ page }) => {
    await page.evaluate((d) => (window as never as W).__artmatic.project.useOpfs(d), DIR);
    const before = await page.evaluate(() => JSON.stringify((window as never as W).__artmatic.store.project));
    await page.evaluate(() => (window as never as W).__artmatic.project.save());

    // 先把内存里的工程改脏，才能证明 open 真的从磁盘读回来了。
    await page.evaluate(() => {
      (window as never as W).__artmatic.store.commit('破坏性改动', (p) => {
        p.name = '内存里的脏名字';
        p.tracks = [];
      });
    });

    const ok = await page.evaluate((d) => (window as never as W).__artmatic.project.open(d), DIR);
    expect(ok).toBe(true);

    const after = await page.evaluate(() => JSON.stringify((window as never as W).__artmatic.store.project));
    expect(after).toBe(before);

    /*
     * 磁盘上那份也必须带着**和内存里同一个**版本号。
     *
     * 从前这条单独立案，判据是 `schemaVersion > 0` / `name` 非空 / `tracks` 是数组
     * —— 那对任何 `save()` 出来的文件都恒真。现在钉的是「写盘用的不是一份过期的
     * 快照」：迁移改过 `schemaVersion` 而 writer 还在序列化旧对象时，这里会红。
     *
     * 不 import `src/core/schema` 拿常量 —— 那条链会拖进 `i18n/index.svelte`
     * 的 `$state`，Node 侧直接 ReferenceError，整个 spec 收集阶段就挂。
     */
    const disk = await page.evaluate(
      (d) => (window as never as W).__artmatic.project.read(`${d}/project.json`),
      DIR,
    );
    const memVersion = await page.evaluate(
      () =>
        (window as never as { __artmatic: { store: { project: { schemaVersion: number } } } }).__artmatic
          .store.project.schemaVersion,
    );
    expect(JSON.parse(disk!).schemaVersion).toBe(memVersion);
    expect(typeof memVersion).toBe('number');
  });

  test('打开时没有素材问题就不留 issue', async ({ page }) => {
    await page.evaluate((d) => (window as never as W).__artmatic.project.useOpfs(d), DIR);
    await page.evaluate(() => (window as never as W).__artmatic.project.save());
    await page.evaluate((d) => (window as never as W).__artmatic.project.open(d), DIR);
    const issues = await page.evaluate(() => (window as never as W).__artmatic.appState.projectIssues);
    expect(issues).toEqual([]);
  });
});

test.describe('素材台账', () => {
  test.beforeEach(async ({ page }) => boot(page));

  test('素材字节落进 assets/，台账记的采样指纹与 Node 算的一致', async ({ page }) => {
    await page.evaluate((d) => (window as never as W).__artmatic.project.useOpfs(d), DIR);
    await page.evaluate((bytes) => {
      (window as never as W).__artmatic.assets.put('img-test', new Uint8Array(bytes), {
        kind: 'image',
        name: '测试图',
        originName: 'pic.png',
      });
    }, ASSET_BYTES);
    await page.evaluate(() => (window as never as W).__artmatic.project.save());

    const files = await page.evaluate((d) => (window as never as W).__artmatic.project.list(`${d}/assets`), DIR);
    // 文件名是 <assetId>.<原始扩展名>：扩展名来自用户那份文件，不是展示名。
    expect(files.map((i) => i.name)).toContain('img-test.png');

    const ledgerText = await page.evaluate((d) => (window as never as W).__artmatic.project.read(`${d}/assets.json`), DIR);
    const entry = (
      JSON.parse(ledgerText!) as {
        entries: Record<
          string,
          { content: { size: number; fp: string }; locations: { kind: string; path: string }[] }
        >;
      }
    ).entries['img-test']!;

    expect(entry.locations.find((l) => l.kind === 'project')?.path).toBe('assets/img-test.png');
    expect(entry.content.size).toBe(ASSET_BYTES.length);

    /*
     * 独立在 Node 侧算一遍采样指纹：证明浏览器里那份不是自己跟自己对账。
     * 算法见 `src/project/fingerprint.ts`：fp1:<size>:<sha256(size\nhead\ntail) 前 32>。
     * 只读首尾各 64 KiB —— 这正是它能用在 2 GB 视频上的原因。
     */
    const full = Buffer.from(ASSET_BYTES);
    const head = full.subarray(0, 64 * 1024);
    const tail = full.length > 64 * 1024 ? full.subarray(-64 * 1024) : Buffer.alloc(0);
    const expected =
      `fp1:${full.length}:` +
      createHash('sha256')
        .update(Buffer.concat([Buffer.from(`${full.length}\n`), head, tail]))
        .digest('hex')
        .slice(0, 32);
    expect(entry.content.fp).toBe(expected);
  });

  test('素材文件被删掉后重开，检出 missing', async ({ page }) => {
    await page.evaluate((d) => (window as never as W).__artmatic.project.useOpfs(d), DIR);
    await page.evaluate((bytes) => {
      (window as never as W).__artmatic.assets.put('img-gone', new Uint8Array(bytes), {
        kind: 'image',
        name: '会被删掉的图',
        originName: 'gone.png',
      });
    }, ASSET_BYTES);
    await page.evaluate(() => (window as never as W).__artmatic.project.save());

    await page.evaluate((d) => (window as never as W).__artmatic.project.remove(`${d}/assets/img-gone.png`), DIR);
    await page.evaluate((d) => (window as never as W).__artmatic.project.open(d), DIR);

    const issues = await page.evaluate(
      () => (window as never as W).__artmatic.appState.projectIssues as { kind: string; severity: string }[],
    );
    expect(issues.some((i) => i.kind === 'missing' && i.severity === 'error')).toBe(true);
  });

  test('移除素材后保存：文件仍在，重开是「未使用素材」而不是孤儿', async ({ page }) => {
    await page.evaluate((d) => (window as never as W).__artmatic.project.useOpfs(d), DIR);
    await page.evaluate((bytes) => {
      (window as never as W).__artmatic.assets.put('img-keep', new Uint8Array(bytes), {
        kind: 'image',
        name: '留着文件的图',
        originName: 'keep.png',
      });
      (window as never as W).__artmatic.store.commit('e2e: 登记素材', (p) => {
        (p as { assets: Record<string, unknown> }).assets['img-keep'] = {
          id: 'img-keep',
          kind: 'image',
          name: '留着文件的图',
        };
      });
    }, ASSET_BYTES);
    await page.evaluate(() => (window as never as W).__artmatic.project.save());

    const assetFiles = (): Promise<string[]> =>
      page.evaluate(
        async (d) =>
          (await (window as never as W).__artmatic.project.list(`${d}/assets`)).map((i) => i.name),
        DIR,
      );
    expect(await assetFiles()).toContain('img-keep.png');

    // 「移除」只解除引用：字节留在磁盘上，台账改记 retained。
    await page.evaluate(() => (window as never as W).__artmatic.appState.removeAsset('img-keep'));
    await page.evaluate(() => (window as never as W).__artmatic.project.save());
    expect(await assetFiles()).toContain('img-keep.png');

    // 重开：它不再是「孤儿」（台账知道这个文件），而是可恢复的保留项。
    await page.evaluate((d) => (window as never as W).__artmatic.project.open(d), DIR);
    const state = await page.evaluate(() => {
      const A = (window as never as W).__artmatic;
      return {
        issues: A.appState.projectIssues,
        retained: A.assets.retainedIds(),
      };
    });
    expect(state.issues.filter((i) => i.kind === 'untracked')).toHaveLength(0);
    expect(state.retained).toContain('img-keep');

    // 面板里能恢复回工程（未使用素材在「清理」页）。
    await page.getByTestId('rail-project').click();
    await page.getByTestId('project-nav-cleanup').click();
    await expect(page.getByTestId('unused-asset')).toHaveCount(1);
    await page.getByTestId('unused-restore').click();
    // 恢复是异步的：`restore()` 会先把字节从句柄读回来，`store.commit` 才落地。
    // 点完立刻断言会稳定抢跑（不是 flake —— 那次 OPFS 读总比 evaluate 往返慢）。
    await expect
      .poll(async () =>
        page.evaluate(() => Object.keys((window as never as W).__artmatic.store.project.assets)),
      )
      .toContain('img-keep');
    const retained = await page.evaluate(() => (window as never as W).__artmatic.assets.retainedIds());
    expect(retained).not.toContain('img-keep');
  });


  test('素材内容被替换后重开，检出 changed', async ({ page }) => {
    await page.evaluate((d) => (window as never as W).__artmatic.project.useOpfs(d), DIR);
    await page.evaluate((bytes) => {
      (window as never as W).__artmatic.assets.put('img-swap', new Uint8Array(bytes), {
        kind: 'image',
        name: '会被替换的图',
        originName: 'swap.png',
      });
    }, ASSET_BYTES);
    await page.evaluate(() => (window as never as W).__artmatic.project.save());

    // **同长度、不同内容**：这一种只有哈希比对抓得到，比大小的实现会静默放过。
    const tampered = ASSET_BYTES.slice();
    tampered[0] = 255;
    await page.evaluate(
      (args) => (window as never as W).__artmatic.project.write(`${args.dir}/assets/img-swap.png`, args.bytes),
      { dir: DIR, bytes: tampered },
    );

    await page.evaluate((d) => (window as never as W).__artmatic.project.open(d), DIR);
    const issues = await page.evaluate(
      () => (window as never as W).__artmatic.appState.projectIssues as { kind: string }[],
    );
    expect(issues.some((i) => i.kind === 'changed')).toBe(true);
  });
});

test.describe('脏标记、多工程与侧栏接线', () => {
  test.beforeEach(async ({ page }) => boot(page));

  test('未保存的工程是脏的，保存后干净，改动后又变脏', async ({ page }) => {
    expect(await page.evaluate(() => (window as never as W).__artmatic.appState.projectDirty)).toBe(true);

    await page.evaluate((d) => (window as never as W).__artmatic.project.useOpfs(d), DIR);
    await page.evaluate(() => (window as never as W).__artmatic.project.save());
    expect(await page.evaluate(() => (window as never as W).__artmatic.appState.projectDirty)).toBe(false);

    await page.evaluate(() => {
      (window as never as W).__artmatic.store.commit('改点东西', (p) => {
        p.fps = 60;
      });
    });
    expect(await page.evaluate(() => (window as never as W).__artmatic.appState.projectDirty)).toBe(true);
  });

  /*
   * 「更准确的工程变更提示」的回归：播放头 / 选中 / 视图都不改 project.json，
   * 因此不可能是「未保存的改动」；但它们要落进 session.json，下次打开回到原处。
   *
   * 用字节比对（read project.json 前后各一次）当判据，而不是只看 `projectDirty`：
   * 脏标记坏了与「文件真的被重写」是两件事，这条用例同时盯住两者。
   */
  test('拖播放头 / 选中 / 切视图不算未保存改动，但下次打开会回到那个位置', async ({ page }) => {
    await page.evaluate((d) => (window as never as W).__artmatic.project.useOpfs(d), DIR);
    await page.evaluate(() => (window as never as W).__artmatic.project.save());
    expect(await page.evaluate(() => (window as never as W).__artmatic.appState.projectDirty)).toBe(false);

    const textId = await page.evaluate(() => {
      const p = (window as never as W).__artmatic.store.project;
      for (const t of p.tracks) for (const c of t.clips) if (c.source?.type === 'text') return c.id;
      return null;
    });
    expect(textId).toBeTruthy();

    const before = await page.evaluate(
      (d) => (window as never as W).__artmatic.project.read(`${d}/project.json`),
      DIR,
    );

    await page.evaluate((id) => {
      const A = (window as never as W).__artmatic;
      A.appState.seek(3.2);
      A.appState.selectedClipId = id;
      A.appState.openTypographyTab(id);
    }, textId!);

    /*
     * 等一会儿：seek 会让 demo 里的算法源重新烘焙、排版层重新光栅化 ——
     * 那两条异步就绪回调正是过去把工程标脏的元凶（它们接的是 invalidate）。
     */
    await page.waitForTimeout(600);
    expect(await page.evaluate(() => (window as never as W).__artmatic.appState.projectDirty)).toBe(false);

    const after = await page.evaluate(
      (d) => (window as never as W).__artmatic.project.read(`${d}/project.json`),
      DIR,
    );
    expect(after, '播放头 / 选中 / 视图不该改动 project.json 的任何一个字节').toBe(before);

    // 会话状态必须落盘（否则「有保存提示却还是从第 0 秒开始」的老问题又回来了）。
    await page.evaluate(() => (window as never as W).__artmatic.project.sessionNow());
    const raw = await page.evaluate(
      (d) => (window as never as W).__artmatic.project.read(`${d}/session.json`),
      DIR,
    );
    expect(raw).not.toBeNull();
    const session = JSON.parse(raw!) as {
      playT: number;
      selectedClipIds: string[];
      view: { kind: string; clipId?: string };
    };
    expect(session.playT).toBeCloseTo(3.2, 1);
    expect(session.selectedClipIds).toEqual([textId]);
    expect(session.view).toEqual({ kind: 'typography', clipId: textId });

    // 重新打开同一份工程：停在上次的位置、选中与视图都回来，而且仍然是干净的。
    await page.evaluate((d) => (window as never as W).__artmatic.project.open(d), DIR);
    expect(await page.evaluate(() => (window as never as W).__artmatic.appState.playT)).toBeCloseTo(3.2, 1);
    expect(await page.evaluate(() => (window as never as W).__artmatic.appState.selectedClipId)).toBe(textId);
    const active = (await projects(page)).find((p) => p.active);
    expect(active?.view).toBe('typography');
    expect(active?.dirty).toBe(false);
  });

  test('导出前会先保存：改片段 → 点导出 → 重新加载后改动还在', async ({ page }) => {
    await page.evaluate((d) => (window as never as W).__artmatic.project.useOpfs(d), DIR);
    // 把工程压到 320×180 / 0.5s：PNG 序列只产 15 帧，够证明「走完导出」而不占磁盘。
    await page.evaluate(() => {
      (window as never as W).__artmatic.store.commit('e2e: 压缩工程', (p) => {
        p.resolution = { w: 320, h: 180 };
        p.duration = 0.5;
      });
    });
    await page.evaluate(() => (window as never as W).__artmatic.project.save());

    // 保存之后的改动（没手动保存）—— 导出入口必须替我们落盘。
    await page.evaluate(() => {
      (window as never as W).__artmatic.store.commit('e2e: 导出前的改动', (p) => {
        p.name = '导出前已保存';
        const tracks = p.tracks as { clips: { label?: string }[] }[];
        const first = tracks.find((t) => t.clips.length > 0);
        if (first) first.clips[0]!.label = '导出前的改动';
      });
    });

    await page.getByTestId('rail-export').click();
    const downloadPromise = page.waitForEvent('download');
    await page.getByTestId('export-png').click();
    await downloadPromise;

    // 重新加载 → 从 OPFS 打开：改动来自磁盘，不是内存。
    await page.reload();
    await page.waitForFunction(() => (window as never as W).__artmatic);
    expect(await page.evaluate((d) => (window as never as W).__artmatic.project.open(d), DIR)).toBe(true);

    const labels = await page.evaluate(() =>
      (window as never as W).__artmatic.store.project.tracks
        .flatMap((t) => t.clips)
        .map((c) => c.label ?? ''),
    );
    expect(labels).toContain('导出前的改动');
  });

  test('侧栏保存按钮能写进已连接的目录，面板如实显示状态', async ({ page }) => {
    await page.evaluate((d) => (window as never as W).__artmatic.project.useOpfs(d), DIR);
    await page.evaluate(() => {
      (window as never as W).__artmatic.store.commit('改点东西', (p) => {
        p.fps = 60;
      });
    });

    // ① 先点保存。**位置已经接上，所以这一下不会弹系统目录选择器** ——
    //    这正是「已连接目录」与「尚未选择位置」的区别。
    //    （实测这里点不了 rail-save：工程面板的 modal 会盖住整条侧栏，
    //     所以保存与看面板必须分两步，不能一边开着面板一边点侧栏。）
    await page.click('[data-testid=rail-save]');
    await expect
      .poll(async () => page.evaluate((d) => (window as never as W).__artmatic.project.read(`${d}/project.json`), DIR))
      .not.toBeNull();

    // ② 再开面板看它有没有如实反映。
    await page.click('[data-testid=rail-project]');
    await expect(page.locator('[data-testid=modal-project]')).toBeVisible();
    await expect(page.locator('[data-testid=project-location]')).toContainText('已连接');
    await expect(page.locator('[data-testid=project-dirty]')).toContainText('已保存');
  });

  test('顶栏加号在同一页里再开一份，原来那份不动', async ({ page }) => {
    await page.evaluate((d) => (window as never as W).__artmatic.project.useOpfs(d), DIR);
    await page.evaluate(() => (window as never as W).__artmatic.project.save());
    expect(await projects(page)).toHaveLength(1);

    await page.click('[data-testid=topbar-new-project]');

    const all = await projects(page);
    expect(all).toHaveLength(2);
    // 第一份还在原地，名字没变、仍然是干净的。
    expect(all[0]).toMatchObject({ dirty: false, active: false, saved: true });
    // 新的那份被激活，且从未保存过（没有位置）—— 所以立刻是脏的。
    expect(all[1]).toMatchObject({ name: '未命名工程', dirty: true, active: true, saved: false });
  });

  test('切选项卡换的是「当前工程」，播放头跟着工程走', async ({ page }) => {
    await page.evaluate((d) => (window as never as W).__artmatic.project.useOpfs(d), DIR);
    await page.evaluate(() => (window as never as W).__artmatic.project.save());

    // 在 A 上把播放头挪走
    await page.evaluate(() => (window as never as W).__artmatic.appState.seek(3.25));
    expect(await page.evaluate(() => (window as never as W).__artmatic.appState.playT)).toBeCloseTo(3.25);

    // 新开 B：播放头是它自己的 0，不该被 A 的进度带走
    await page.click('[data-testid=topbar-new-project]');
    expect(await page.evaluate(() => (window as never as W).__artmatic.appState.playT)).toBe(0);

    // 切回 A：停在离开的位置
    await page.click('[data-testid=project-tab-0]');
    expect(await page.evaluate(() => (window as never as W).__artmatic.appState.playT)).toBeCloseTo(3.25);
  });

  test('关闭工程：脏的先弹确认，取消无事，确认才关', async ({ page }) => {
    // A 干净
    await page.evaluate((d) => (window as never as W).__artmatic.project.useOpfs(d), DIR);
    await page.evaluate(() => (window as never as W).__artmatic.project.save());
    // B 脏（新开，没保存）
    await page.click('[data-testid=topbar-new-project]');
    expect(await projects(page)).toHaveLength(2);

    // 脏的**不是直接拒绝**，而是弹确认 —— 用户常常就是想丢掉这次试验
    await page.click('[data-testid=project-tab-close-1]');
    await expect(page.locator('[data-testid=confirm-close-project]')).toBeVisible();
    expect(await projects(page)).toHaveLength(2);

    // 取消：什么都没发生
    await page.click('[data-testid=confirm-close-project-cancel]');
    await expect(page.locator('[data-testid=confirm-close-project]')).toHaveCount(0);
    expect(await projects(page)).toHaveLength(2);

    // 确认：真的关掉
    await page.click('[data-testid=project-tab-close-1]');
    await page.click('[data-testid=confirm-close-project-ok]');
    const left = await projects(page);
    expect(left).toHaveLength(1);
    expect(left[0]).toMatchObject({ active: true });
  });

  test('未保存圆点：保存后消失，改动后立刻回来，而且能反复', async ({ page }) => {
    await page.evaluate((d) => (window as never as W).__artmatic.project.useOpfs(d), DIR);
    await page.evaluate(() => (window as never as W).__artmatic.project.save());

    const dot = page.locator('[data-testid=project-tab-dirty-0]');
    await expect(dot).toHaveCount(0);

    // 改一下 → 圆点必须**立刻**出现。
    // 这正是修掉的那个 bug：`dirty` 读的是 `p.store.version`，而 store 是类实例、
    // 不被 $state 代理，所以以前只有「新开/关闭工程」让数组换引用时才重算。
    await page.evaluate(() => {
      (window as never as W).__artmatic.store.commit('改点东西', (p) => {
        p.fps = 60;
      });
    });
    await expect(dot).toBeVisible();

    // 再保存 → 又消失
    await page.evaluate(() => (window as never as W).__artmatic.project.save());
    await expect(dot).toHaveCount(0);

    // 而且要能**反复**。旧 bug 的症状正是「保存一次之后圆点再也不出现」。
    await page.evaluate(() => {
      (window as never as W).__artmatic.store.commit('再改一次', (p) => {
        p.fps = 24;
      });
    });
    await expect(dot).toBeVisible();
  });

  test('底栏提示按级别上色：成功是绿、失败是红，不再是清一色红字', async ({ page }) => {
    await page.evaluate((d) => (window as never as W).__artmatic.project.useOpfs(d), DIR);
    await page.click('[data-testid=rail-save]');

    const notice = page.locator('[data-testid=notice]');
    await expect(notice).toHaveAttribute('data-level', 'success');
    expect(await noticeColor(page)).toBe(await tokenColor(page, '--success'));

    await page.evaluate(() => (window as never as W).__artmatic.appState.flash('假装失败', 'error'));
    await expect(notice).toHaveAttribute('data-level', 'error');
    expect(await noticeColor(page)).toBe(await tokenColor(page, '--danger'));
  });

  test('有未保存改动时，刷新（F5）会先拦一下', async ({ page }) => {
    // 初始 demo 工程没保存过，本来就是脏的。
    expect(await page.evaluate(() => (window as never as W).__artmatic.appState.projectDirty)).toBe(true);

    const dialogs: string[] = [];
    page.on('dialog', (d) => {
      dialogs.push(d.type());
      void d.accept();
    });
    await page.reload().catch(() => {});

    expect(dialogs).toContain('beforeunload');
  });
});
