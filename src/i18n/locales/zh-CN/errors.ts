/**
 * errors.ts — 会**呈现在界面上**的错误与降级提示。
 *
 * 前缀：`err.*`
 *
 * 判定标准只有一条：**用户有没有可能看到它**。看得到的进这里，看不到的
 * （`console.warn` 的开发诊断、断言式的内部不变量）**不进**——那些是给
 * 写代码的人看的，本地化只会让 grep 变难。
 *
 * 例：`特效 echo 缺少 glsl/echo.ts（两个文件纪律）` 是启动期的开发错误，
 * 不本地化；而 `打开失败：…` 会出现在底栏，必须本地化。
 *
 * 这些消息里**带着具体数值**（路径、字节数、版本号），所以大多是
 * 带占位符的模板。带占位符的统一用 `{名字}`，不要用模板字符串拼接 ——
 * 拼接会让「一句话」被拆成两半存进语言文件，翻译时无法重排语序。
 */

export const errors = {
  /* ------------------------------------------------ 工程校验（core/schema.ts） */
  /* 这些消息会被 project-actions 拼进底栏的「打开失败：…」，所以用户看得到。
     单测用正则断言了其中的关键词（/fps/、/轨道类型/、/音频轨/…），
     改文案时那几条会先失败——那不是测试过时，是提醒你它确实是对外契约。 */
  'err.schema.notObject': '不是对象',
  'err.schema.missingVersion': '缺少 schemaVersion',
  'err.schema.missingName': '缺少 name',
  'err.schema.badFps': 'fps 非法',
  'err.schema.badResolution': 'resolution 非法',
  'err.schema.badDuration': 'duration 非法',
  'err.schema.badBeatGrid': 'beatGrid 非法',
  'err.schema.badSeed': 'seed 非法',
  'err.schema.badOverlap': 'overlapBehavior 非法',
  'err.schema.badAssets': 'assets 非法',
  'err.schema.badTracks': 'tracks 非法',
  'err.schema.versionTooNew': '工程版本 {found} 高于本应用支持的 {supported}，请升级应用',
  'err.schema.missingMigration': '缺少从版本 {version} 的迁移函数',
  'err.schema.stuckMigration': '版本 {version} 的迁移没有把 schemaVersion 抬上去',
  'err.schema.unknownTrackKind': '未知轨道类型 {kind}',
  'err.schema.trackMissingClips': '轨道缺少 clips',
  'err.schema.clipMissingId': '片段缺少 id',
  'err.schema.clipBadSpan': '片段 {id} 时间区间非法',
  'err.schema.clipBadFade': '片段 {id} fadeSec 非法',
  'err.schema.clipBadCurves': '片段 {id} curves 非法',
  'err.schema.audioTrackHasNonAudio': '音频轨里有非音频片段',
  'err.schema.visualTrackHasNonVisual': '视觉轨里有非视觉片段',
  'err.schema.effectClipMissingChain': '特效片段 {id} 缺少 chain',
  'err.schema.effectBadAffectDepth': '特效片段 {id} 的影响深度必须是非负整数',
  'err.schema.effectBadBoundClip': '特效片段 {id} 的绑定片段 id 必须是非空字符串',
  'err.schema.typographyBadDoc': '排版片段 {id} 的 doc 非法',
  'err.schema.typographyBadSize': '排版片段 {id} 的文档尺寸非法',
  'err.schema.typographyBadTextRuns': '排版片段 {id} 里有文本元素缺少内容段（runs）',
  'err.schema.transitionBadDefId': '片段 {id} 的转场缺少 defId',
  'err.schema.transitionBadDuration': '片段 {id} 的转场时长非法',
  'err.schema.transitionBadValues': '片段 {id} 的转场参数非法',
  /* v7 的片段级抠图 / 四角。手改 JSON 形状不对时在打开时就报错（不许穿透到渲染期）。 */
  'err.schema.badKeySettings': '片段 {id} 的抠图参数不合法',
  'err.schema.badQuad': '片段 {id} 的四角坐标不合法',
  'err.schema.badCrop': '片段 {id} 的裁剪参数不合法',

  /* ------------------------------------------------ 工程读写（project/io.ts） */
  /* 这些会经「打开失败：…」/「保存失败：…」进底栏，或进 SaveReport 的警告。 */
  'err.io.notAProject': '「{name}」不是一个 Artmatic 工程目录',
  'err.io.badJson': '{file} 不是合法 JSON：{detail}',
  'err.io.pathConflict': '素材文件名冲突，已中止保存：{detail}',
  'err.io.assetBytesMissing': '素材 {name}（{id}）在内存里没有字节，跳过写入',
  'err.io.ledgerRebuilt': 'assets.json 缺失或不完整，已从 assets/ 目录重建台账',
  'err.io.untrackedFile': 'assets/{name} 不在工程的素材表里，已标为未跟踪',

  /* ------------------------------------------------ 工程包（.artmatic） */
  'err.pack.notZip': '这个文件不是工程包（不是 ZIP，或文件已损坏）',
  'err.pack.noManifest': '这个文件不是 Artmatic 工程包（缺少 manifest.json）',
  'err.pack.badManifest': '工程包的清单损坏或不受支持',
  'err.pack.tooNew': '工程包格式版本 {format} 比本应用新，请升级 Artmatic',
  'err.pack.noProject': '工程包里没有 project.json',
  'err.pack.corruptProject': '工程包里的 project.json 校验失败（文件可能损坏）',
  'err.pack.corruptAsset': '工程包里的素材「{path}」校验失败（文件可能损坏）',
  'err.pack.missingAsset': '工程包缺少素材「{path}」',
  'err.pack.unsafePath': '工程包里有不安全的路径：{path}',
  'err.pack.unknownEntry': '工程包里有无法识别的文件：{path}',
  'err.pack.tooLarge': '工程包解压后 {size}，超过上限 {limit}',
  'err.pack.pluginsIgnored': '已跳过包里的 {n} 个插件文件（导入他人工程不执行代码）',
  'err.pack.duplicatePath': '工程包里有重复的素材路径：{path}',
  'err.file.readFailed': '读不了「{name}」：{detail}',
  'err.io.openFailed': '打开失败：{detail}',
  'err.io.saveFailed': '保存失败：{detail}',
  'err.io.deleteFailed': '删除失败：{detail}',

  /* ------------------------------------------------ 原子写（project/fs.ts） */
  'err.fs.backupFailed': '备份失败（继续保存）：{detail}',
  'err.fs.writeMismatch': '写入后校验失败：{name} 期望 {want} 字节，磁盘上是 {got}',
  'err.fs.writeCorrupt': '写入后校验失败：{name} 内容与预期不一致',
  'err.fs.dirNoIterator': '目录句柄不支持遍历（既没有 values() 也没有 entries()）',
  'err.fs.noDirPicker': '此浏览器不支持选择本地目录（需要 Chrome / Edge）',

  /* ------------------------------------------------ 素材台账（project/ledger.ts） */
  /* 前四条来自 parseLedger 的警告，后五条是 auditLedger 的 issue.message，
     会直接渲染在 Rail 的「素材检查」里。 */
  'err.ledger.badJson': 'assets.json 不是合法 JSON，已按空台账处理（将从 assets/ 重建）',
  'err.ledger.notObject': 'assets.json 不是对象，已按空台账处理',
  'err.ledger.versionTooNew': 'assets.json 的 layoutVersion {found} 高于本应用支持的 {supported}',
  'err.ledger.badEntry': 'assets.json 里的 {id} 形状不对，已忽略',
  'err.ledger.missing': '素材文件不在：{path}',
  'err.ledger.changed': '文件可能被替换过，{path} 的内容与工程记录不一致',
  'err.ledger.sizeChanged': '{path} 的大小是 {to} 字节，而非预期的 {from} 字节',
  'err.ledger.unhashed': '{path} 没有可用的哈希值',
  /* 单个未记录文件（`auditLedger` 的逐条形态；保留给直接调用者与测试）。 */
  'err.ledger.untracked': 'assets/ 里有存在未被记录的文件：{path}',
  /* 打开工程时的聚合形态：保存不再删素材，孤儿会成批出现。 */
  'err.ledger.orphans': '磁盘上有 {n} 个不再被引用的素材，占用 {size}；暂不自动清理，可手动从 assets/ 删除',

  /* ------------------------------------------------ 导出（ui/export.ts、exporters/） */
  /* sink 抛出的错会经 `flash('导出失败：' + msg)` 进底栏，所以这些也要抽。 */
  'err.export.noWebCodecs': '本机浏览器不支持 WebCodecs，请改用 PNG 序列导出',
  /* 有 WebCodecs、但四档 H.264 profile 全被拒——
     不要与上一条混用：那是「编不了」，这是「编不动这个 profile」。 */
  'err.export.noH264': '本机没有可用的 H.264 编码器（Main / Baseline 都被拒），只能导出 PNG 序列',
  /* 导出前会先保存工程。还没落地到目录时只提示，不拦导出。 */
  'err.export.saveFirstHint': '这个工程还没有保存到目录：导出期间如果崩溃，未保存的改动会丢，建议先保存一次',
  'err.export.silentAudio': '音轨混流结果是静音，本次只导出画面',
  'err.export.mp4Done': '已导出 MP4 ，共 {size}',
  /* 导出落盘方式：预估体积超过内存预算时改成「先选保存位置，再边编边写」
     （见 ui/export.ts::pickOutput）。 */
  'err.export.streamingSave': '本次预计 {size}，超过内存预算 {budget}，改为直接写入你选择的文件',
  'err.export.streamDone': '已保存到 {name}{size}',
  'err.export.overBudget': '本次预计 {size}，超过内存预算 {budget}；本浏览器不支持选择保存位置，仍会先在内存里产完',
  'err.export.fileTypeMp4': 'MP4 视频',
  'err.export.fileTypeZip': 'PNG 序列压缩包',
  'err.export.failed': '导出失败：{detail}',
  'err.export.sinkCodec': 'Mp4Sink 只支持 {want}，收到 {got}',
  'err.export.sinkNoCanvas': 'Mp4Sink.configure 需要真实 canvas（见 frame-sink 的 FrameSinkConfigureOptions）',
  'err.export.canvasSizeMismatch':
    'canvas 尺寸 {cw}×{ch} 与声明的 {dw}×{dh} 不一致（是不是忘了先 renderer.setExportSize？）',
  'err.export.pngBlobNull': 'canvas.toBlob 返回 null',
  'err.export.notConfigured': 'configure 还没调用',
  'err.export.noBuffer': 'mediabunny 没有产出 buffer',
  'err.export.gifDone': '已导出 GIF，共 {size}',
  'err.export.gifSinkCodec': 'GifSink 只支持 {want}，收到 {got}',
  'err.export.gifNo2d': 'GIF 编码需要一张 2D 暂存 canvas，getContext("2d") 返回了 null',
  /* gifenc 是惰性写头的：一帧都没写就 finish，得到的是只有 trailer 的 1 字节文件。
     那种「成功」的空下载比报错更难排查，所以在这里挡死。 */
  'err.export.gifEmpty': 'GIF 一帧都没有写出（工程时长为 0，或抽帧步长不合理）',

  /* ------------------------------------------------ 视频素材 */
  /* 进底栏的 flash。容器认得、轨里没视频、或者编码本机解不动，都归这条 ——
     对用户来说下一步动作是同一个：换一个文件。 */
  'err.video.unreadable': '「{name}」不是能读的视频文件（容器或编码不支持）',

  /* ------------------------------------------------ 图片素材 */
  /* 与视频同口径：浏览器解不开的字节（扩展名骗人、文件截断、SVG 没有固有尺寸）。 */
  'err.image.unreadable': '「{name}」不是能读的图片文件',

  /* ------------------------------------------------ 音频素材 */
  'err.audio.unreadable': '「{name}」不是能读的音频文件',

  /* ------------------------------------------------ 拖进来的文件 */
  /* 拖拽才会遇到：一整个文件夹里混着 pdf / txt / zip 是常态。 */
  'err.file.unsupported': '「{name}」不是能读的素材（支持视频 / 图片 / 音频）',

  /* ------------------------------------------------ 平台能力 */  
  'err.platform.openDirUnsupported': '这个浏览器不支持打开本地目录（需要 Chrome / Edge）',
  'err.platform.saveDirUnsupported': '这个浏览器不支持保存到本地目录（需要 Chrome / Edge）',
  'err.platform.webgl2': '此浏览器没有 WebGL2',
} as const;
