# tests/e2e/ —— E2E 的硬规矩

`tests/e2e/_stage.ts` 已经把渲染类用例最难的三件事封好了；本文件记的是
**这个项目里最容易写错的那几类断言**（它们全部不会报错，只会「什么都没测到」）。

**何时读我**：写或改任何 `.spec.ts` 之前。

相关：`tests/AGENTS.md`（单测 / 守卫纪律 · 分层回归表）、`src/timeline/AGENTS.md`、
`src/exporters/AGENTS.md`（导出的磁盘纪律）。

---

- **`.spec` 后缀不能省**：`scripts/e2e.mjs` 的位置参数是按完整路径做正则匹配的，
    而本机路径里有 `\Projects\`（见 `tests/AGENTS.md` 的 ⚠️）。

- **持久化的 E2E 跑在 OPFS 上，那不是 mock**：`navigator.storage.getDirectory()` 返回的
  就是一个 `FileSystemDirectoryHandle`，与 `showDirectoryPicker()` 是同类对象。
  `__artmatic.project.useOpfs(name)` 把 OPFS 下的一子目录接成当前工程位置，之后走的是与
  生产**完全同一条**链路，唯一差别是「根句柄从哪来」。`showDirectoryPicker()` 是系统对话框、
  Playwright 驱动不了 —— 这是绕开它的唯一诚实办法。
  - **会话状态（`session.json`）也跟工程目录走**：播放头 / 选中 / 视图会在
    `project.open()` 时被还原。多个用例复用同一个 `DIR` 时，上一个用例留下的位置
    会静默改变这个用例的起手条件 —— 要干净起点就在 `beforeEach` 里 `project.wipe(DIR)`。
    要断言「回到上次位置」用 `project.sessionNow()` 立刻落盘（别靠 0.9 s 防抖）。
  - ⚠️ **`scripts/e2e.mjs` 的位置参数是按「完整路径」做正则匹配的**，而本机路径里有
    `\Projects\` —— 所以 `node scripts/e2e.mjs project` 会匹配到**全部** spec。
    要限定文件就写 `project.spec`。
- **单测里的文件系统是 `memoryRoot()`，它模拟了 swap 语义**（写入进临时缓冲、`close()` 才提交），
  所以「写到一半失败不损坏原文件」在单测里是被真测到的。它还支持
  `setFault(op => Error | null)` 注入失败、`inspect(path)` 直接看磁盘状态 ——
  写这类测试时**别去 mock `FileSystemDirectoryHandle`**，用这个。
- **选择器一律优先 `data-testid`**，不要绑 CSS 类名。所有自研控件都暴露了稳定 testid
  （`param-row` / `param-slider` / `param-number` / `select` / `menu-item-*` /
  `track-side-row` / `tl-row` / `tl-scroll` / `ctx-menu` …）。绑类名的那批断言在换控件时
  全碎过一次，不值得再来一遍。
  - 顶栏工程页签带**序号**：`project-tab-N`（切换）/ `project-tab-timeline-N` /
    `project-tab-close-N` / `project-tab-dirty-N`，加上全局的 `topbar-new-project`。
    用序号而不是 id，因为 id 是运行时 uuid，测试拿不到。
  - 约定：`NumberInput` 的 `testid` 落在**内部 `<input>`** 上（保住 `fill()` /
    `inputValue()`），拖拽热区的 testid 是 `testid + '-wrap'`。
- **手势类断言必须走 `page.mouse`**，不要直接调 store —— 策略结算时序、跨轨、右键菜单
  这些问题全在手势层，直接调 store 会把它们整个绕过去。
- **断言要写成不变量，不要写成两点相等**。修「暗色下太阳图标是主题色」时，只比
  「主题切换 vs 设置图标」两个够不到同批引入的「`/lab` 入口用浏览器默认链接蓝」那个 bug；
  改成「**rail 上所有图标必须同色**」之后它一次就抓住了。配套：量颜色前先把指针移开，
  hover 态是另一套颜色，点完直接量到的是 hover 色。
- **片段 id 在 E2E 里不能写死**：`ProjectStore.findClip` 返回**第一个** id 匹配的片段，
  同一个页面里搭两次同 id 的舞台时，第二次的操作会落到第一次那条轨道上 —— 画面里根本没有
  那东西，断言却「看起来过了」。`tests/e2e/_stage.ts::buildTransitionStage` 因此给每次调用加了序号后缀。
- **点轨道菜单别用 `.first()`**：demo 的轨道还在列表里（只是被禁用），`.first()` 会点到它们，
  片段落进看不见的轨里，断言随后以令人困惑的方式失败。用 `.last()`（新建的轨在末尾），
  或按轨名定位。
- **检查器抽屉浮在时间轴右侧**：拖拽 / 点击的起手点若落在抽屉覆盖区内，
  `elementFromPoint` 拿到的是 `.drawer`，**手势被静默吞掉**（不报错、几何不变）。
  写涉及时间轴的指针测试时，起手点取靠左的位置。
- **轨道行数多时轨道区会出纵向滚动条**，`boundingBox()` 拿到的行可能落在视口外
  （鼠标事件被钳到视口边界）。要么把 viewport 开高，要么先 `scrollTop = scrollHeight` 再量。
- **进场动画期间不要量几何**：modal / 抽屉 / 面板都有 100–150ms 的缩放或位移动画，
  动画中途 `boundingBox()` 给的是**变换后**的坐标 —— 分处缩放中心两侧的两个元素 y 会差几像素，
  断言以「布局错」的样子失败，而布局根本没错。判据写成 `await expect.poll(...)`（等状态落定），
  不要靠 `waitForTimeout` 猜一个拍数：机器一慢就重现，且只在整份 spec 连跑时重现。

---

## 渲染类 E2E 的三条硬规矩（`tests/e2e/_stage.ts` 已封好）

1. **从空舞台起步**：用 `buildStage`（关掉 demo 全部轨道），不要往 demo 工程上叠。
2. **被测特效必须在源之上**：`buildStage` 会把它提到数组最前。
   **写反了不会报错，只是「什么都没测到」**（见 `src/engine/AGENTS.md` 的 z 序）。
3. **「同帧一致」类断言必须每次渲前 `onSeek()`**（`renderTwiceDiff` 默认如此），
   且在测量前 `settle()`。两个坑：
   - `page.evaluate` 的回调**读不到模块作用域** —— 每个回调里就地写
     `(window as never as { __artmatic: StageApi }).__artmatic`，别指望抽个 `api()` 助手。
   - warm-up **不能用固定帧数**（一次性过渡的时机随负载浮动），要用收敛判据
     `settle()`（渲到连续 `SETTLE_FRAMES` 帧完全一致为止）。
4. 等异步烘焙要**从 Node 侧**轮询（`waitForSourceReady`）；在 page 里忙轮询会把 worker
   回包饿死。
5. **昂贵的性能类测试只从导出路径量**（见 `src/algos/AGENTS.md`）。
6. **判断「文档脚本 / 插件 render 钩子」的效果只走 `typoRasterize`**（不经过
   compositor / GPU）。合成链上有已知的边界采样竞态，逐像素相等在那里是偶发的；
   脚本的承诺是「同一 t 同结果」，要在光栅化这一层断言（见
   `tests/e2e/typography-script.spec.ts`）。开关用 `appState.setRunTypoScripts()`，
   测完关回去 —— 偏好会写 localStorage，残留会污染后续用例。
