/**
 * project.ts — 「工程」这一侧的文案：新建 / 打开 / 保存 / 另存为 / 最近工程 /
 * 素材台账问题 / 脏标记 / 目录授权 / 工程面板。
 *
 * 前缀：`proj.*`
 *
 * > 用词约定（AGENTS §5）：Artmatic 产出的那个目录一律叫「工程」，不叫「项目」。
 */

export const project = {
  /** 新建工程的默认名。schema / demo / 顶栏 / 底栏 / app-state 共 5 处用它。 */
  'proj.unnamed': '未命名工程',

  /* -------------------------------------------- 新建 / 打开 / 保存的底栏提示 */
  /* 这些都会经 `appState.flash()` 出现在底栏，所以逐字是界面契约 ——
     单测/e2e 用正则断言了其中的关键词（`已保存` / `不是一个 Artmatic 工程目录`…），
     改字会让那几条先失败。 */
  'proj.newDemoFlash': '已新开一份演示工程（尚未保存）',
  'proj.newBlankFlash': '已新开一份空白工程（尚未保存）',
  'proj.openedAssets': '已打开「{name}」，含 {n} 个本机素材',
  'proj.openedWithProblems': '已打开「{name}」，但有 {problems} 个素材丢失。在「工程」面板查看详细信息。',
  'proj.savedWithWarnings': '已保存（{n} 条警告）：{first}',
  /* `{size}` 已是调用方格式化好的 KB 数字，`{ms}` 是毫秒数 —— 数值格式化留在调用处。 */
  'proj.savedAssets': '已保存 · {n} 个本机素材 · {size} KB · {ms} ms',

  /* ------------------------------------------------ 崩溃恢复（草稿） */
  /* 启动横幅：草稿是「自动保存」在没有目录句柄时唯一的落点。 */
  'proj.draftHint': '有一份未保存的本地草稿「{name}」，保存于 {time}',
  'proj.draftRestore': '恢复草稿',
  'proj.draftDismiss': '忽略',
  'proj.draftRestored': '已从本地草稿恢复「{name}」（尚未保存）',
  'proj.draftBroken': '这份本地草稿读不出来，已跳过',

  /* -------------------------------------------------- 最近工程 / 权限 / 其它 */
  'proj.credentialExpired': '「{name}」的访问凭据已失效，请用「打开工程」重新选择目录',
  'proj.permissionDenied': '没有拿到「{name}」的访问权限',

  /* ------------------------------------- 最近工程的右键菜单（首页 / 工程面板） */
  'proj.menuOpenFolder': '打开文件夹',
  'proj.menuForget': '从最近工程列表移除',
  'proj.menuDelete': '删除工程',
  'proj.deleteTitle': '删除工程',
  /* 浏览器（FSA）：目录自己删不掉（没有父句柄），只能清空 —— 措辞必须比实际做得少。
     桌面壳（有本机路径）：真的连目录一起删，用下面那条。 */
  'proj.deleteBody': '「{name}」的工程文件会从磁盘上清空，这个动作不能撤销。',
  'proj.deleteBodyPath': '「{name}」连同工程目录会从磁盘上删除，这个动作不能撤销。',
  'proj.removedFromRecent': '已从最近工程列表移除「{name}」',
  'proj.deleted': '已删除工程「{name}」',
  /* 保存对话框里那一栏文件类型说明，由系统弹出，但文案是我们的。 */
  'proj.filePickerDescription': 'Artmatic 工程',
  'proj.noEditorYet': '功能尚未实现',
} as const;
