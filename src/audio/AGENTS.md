# src/audio/ —— 离线音频

离线 FFT · BPM / offset 估计 · 波形桶 · 播放器。
**音频分析一律离线预计算**（给生成器的是「曲线的查表」，`at(t)` 是 t 的纯函数）——
逐帧按 `dt` 推进的有状态量在 seek 下不可复现。

**何时读我**：改 `audio/**`；给算法生成器加一个吃音频 / 频谱 / 特征的东西。

相关：`src/algos/AGENTS.md`（`AlgoFeatureSource` 注入点与 uniform 口径）、
根 `AGENTS.md` 硬约束 1.1 / 1.3。

---

- **手动打点用 `currentTapT()`，不要用 `playT`**：人跟着听到的声音按下去，与已经排进
  声卡的时间线差一个输出延迟（`outputLatency` / `baseLatency`）。`currentTapT()` 扣掉它，
  只给打点用；**渲染时间仍然只认 `t`**（硬约束 1.1）。
- **节拍器（`metronome.ts`）必须和音乐共用同一个 `AudioContext`**：它读
  `player.audioTimeOf(t)` 提前 200 ms 把点击排进同一条 WebAudio 时间线，两个上下文
  会随设备 / 负载慢慢漂开（越听越偏）。它只在预览播放时响，不进导出；由 `appState`
  在 play / pause / seek 后调 `onPlay()` / `onPause()`，别让它自己轮询播放状态
  （暂停后会剩一个 40 次/秒的空转定时器）。手动节奏点用 sine、拍用 triangle，
  20 ms 内撞车只发节奏点（两个一起响只会更响）。
- **预览播放的响度与导出同源**：`player.ts` 给每个片段挂一个 `GainNode`，曲线由
  `core/audio-envelope.ts::sampleAudioEnvelope` 采样（gain 曲线 × `fadeSec` ×
  `fadeIn` / `fadeOut`），用 `setValueCurveAtTime` 排进 WebAudio。导出走
  `exporters/mixdown.ts` 的逐样本求值。**不要在播放器里另写一条淡变斜坡**。
- **音频特征层**（`audio/features.ts` + `algos/feature-source.ts`）：
  - **必须离线预计算**。上游的 `Impulse.step(dt)` / `approach` 是逐帧按 `dt` 推进的有状态量，
    与硬约束 1.1 冲突（seek 不可复现）。这里给的是**曲线的查表**：`at(t)` 是 t 的纯函数。
  - 与频谱**共用一趟 FFT 走查**：`computeSpectrum(buffer, onProgress, onFrame)` 的钩子挂上
    特征累加器。帧数 / hop 由 `planSpectrum()` 唯一定义 —— 自己抄一遍那套算术，
    表现是「特征曲线尾部静默变成 0」。
  - 接口注入（`AlgoFeatureSource`），`render-core` 依然不 import `audio/`。主应用给
    `ProjectAudio`（频谱 + 特征一次算完），lab 给 `createLabFeatures()` 的合成特征。
  - **冲量是闭式的**：`exp(-距今多久 / decay)`，不是累加器。kick / bar 由**拍网格**给
    （JS 侧才拿得到 `BeatGrid`），hit 由 **onset 年龄**给。
  - `u_ages` 是 `vec4`（最近四个 onset 的年龄），没有 onset 时给哨兵 9。

---

- **结构分析（`structure.ts`）在小节级做，不做亚小节精修**。边界只取整数小节，
  于是同一份音频每次得到同一批段落 id（`auto:<assetId>:<startBar>`）；一旦引入
  亚小节边界，浮点抖动就会让「重跑一次」变成「换了一套段落」。
- **Foote 棋盘核是可分离的**：`K(i,j)=c(i)·c(j)` ⇒ `nov[n]=‖Σ c(i)·x[n+i]‖²`。
  不要为了「照教科书」去建 `B×B` 的相似度矩阵 —— 结果逐位等价，代价差两个数量级
  （300 小节从 90k 个 float 降到 300 次向量加）。
- **核取 2L 项而不是 2L+1**：象限缝落在 `i=-1` 与 `i=0` 之间，`nov[n]` 比较的是
  `[n-L,n-1]` 与 `[n,n+L-1]`，边界正好落在第 n 小节之前。写成 2L+1（`i=0` 处为零）
  会让中心小节被两边跳过，峰值落到边界两侧各半小节处的巧合点上 —— 症状是
  「段落边界比耳朵听到的早一小节」，而所有数值都正常。
- **特征分工**：音色/能量（rms / flux / centroid / flat / 五段占比 / onset 密度）
  做**边界**，chroma 做**段落归组**。混用会同时变差。归组向量是 chroma 块 +
  音色块的拼接（各占 0.7）：只靠 chroma 会把「和弦一样、配器不同」的主歌副歌
  并成一段（EDM 的常态），只靠音色会把「升 key 的副歌」判成新段。
- **chroma 不做 HPSS**：宽带冲击在 12 个音级上加的是常数地板，而小节聚合取的是
  **逐音级中位数** —— 中位数留持续音、滤短冲击。放在聚合侧做的代价比逐帧滚动
  中位数低两个数量级，口径也更好解释。
- **`music-store.ts` 是「此刻的音乐地图」的唯一入口**。缓存键必须包含**影响结果的
  每个输入**（素材 / 拍网格 / 窗口 / 最短段落长度）：`setBeatGrid` 是 `Object.assign`
  原地改写，按 `project` 引用判失效会漏掉网格变化，而症状是「改了 BPM，段落带不动」。
- **`ProjectAudio.musicAt` 与 `at()` 必须分开**：前者每帧每**参数**读一次（要段内进度），
  后者每帧每**源**读一次（要 uniform 形状）。合成一个对象会让两条消费路径互相绑死。
  两者都要复用出参、不能分配。
