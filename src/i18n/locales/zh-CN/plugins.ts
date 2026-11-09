/**
 * plugins.ts — 插件系统的文案。前缀 `pl.`。
 *
 * ## 为什么「问题码」的句子在这里，而不是在 `src/plugins/` 里拼
 *
 * 校验器与宿主只产出**机器可读的 `code` + 非文案细节**（见 `plugins/manifest.ts`
 * 的文件头）：它们是纯数据层，不该依赖 i18n 的运行期模块（`tr` 住在
 * `.svelte.ts` 里），而且 `src/` 下不许出现面向用户的中文字面量
 * （`i18n.test.ts` 守卫）。句子在这里按 code 查表，是本项目一贯的做法
 * （对比 `err.fs.*` 那一族）。
 *
 * ## 键名里为什么没有连字符
 *
 * 文案键的全局形状约束是 `域.名字`，每一段只允许字母数字
 * （`i18n.test.ts` 的「键名形如 域.名字」）。问题码里带连字符
 * （`bad-format` / `not-a-plugin`），所以键名一律写成 camelCase，
 * 与码的对应关系由 `ui/plugin-manager/plugin-panel-model.ts` 的两张表管
 * —— 那两张表是穷尽的，多一个码就编译报错。
 *
 * ## 风险提示为什么写得这么直白
 *
 * 插件是**运行在主 realm 的任意代码**，没有沙箱。用户选定了这个模型，代价就是
 * 这一段必须说清楚 —— 一句轻描淡写的「注意安全」等于没说。原文里的
 * 「用 AI 核验源码」是用户明确要求的建议，不要删。
 */

export const plugins = {
  /* ------------------------------------------------------------ 面板 */
  'pl.title': '插件',
  'pl.open': '管理插件…',
  'pl.subtitle': '插件给这个工程添加新的特效与算法生成器。',
  'pl.empty': '这个工程还没有插件。',
  'pl.emptyHint': '插件是一个 .js 文件，会连同工程目录一起保存。',
  'pl.import': '导入插件…',
  'pl.enable': '启用',
  'pl.disable': '停用',
  'pl.remove': '移除',
  'pl.close': '关闭',
  'pl.summary': '共 {total} 个插件。',
  'pl.summaryWithIssues': '共 {total} 个插件，其中 {bad} 个有问题。',
  'pl.countEffects': '{n} 个特效',
  'pl.countGenerators': '{n} 个生成器',
  'pl.license': '许可',
  'pl.version': '版本',
  'pl.removeConfirmTitle': '移除插件',
  'pl.removeConfirmBody':
    '会从工程目录里删掉「{name}」的文件。引用了它的片段会被保留，但画面里那部分会失效（可以事后重新导入同一个插件恢复）。',
  'pl.removeConfirmOk': '移除',

  /* ------------------------------------------------------------ 状态 */
  'pl.status.ok': '正常',
  'pl.status.partial': '部分可用',
  'pl.status.failed': '加载失败',
  'pl.status.disabled': '已停用',
  'pl.disabledNotice': '已停用：它的文件还在工程目录里，但这次没有加载（因此读不到它的名称与描述）。',

  /* -------------------------------------------------------- 风险确认 */
  'pl.risk.title': '插件会执行任意代码',
  'pl.risk.body':
    '插件是一个可直接运行的 JS 模块，它拥有这个页面能碰的一切权限（读写你打开的工程目录、发网络请求）。\n\n只导入你自己写的或完全信任来源的插件。来源不明的插件，建议先用 AI 或人工把源码看一遍再导入。',
  'pl.risk.file': '即将导入：{name}',
  'pl.risk.ok': '我已了解风险，导入',
  'pl.risk.cancel': '取消',

  /* -------------------------------------------------------- 缺失提示 */
  'pl.missing.title': '这个工程引用了未加载的插件',
  'pl.missing.body': '{ids}。相关片段与参数都原样保留着，把插件补上就会恢复。',
  'pl.missing.action': '导入插件…',
  'pl.missing.note': '（缺失的插件不会让其它图层失效，只是它自己那一部分不参与渲染。）',

  /* ---------------------------------------------------- 操作结果提示 */
  'pl.flash.imported': '已导入插件「{name}」',
  'pl.flash.importedMemoryOnly':
    '已临时加载「{name}」—— 这个工程还没保存，所以插件没有写进工程目录，刷新后就没了。',
  'pl.flash.writeFailed': '「{name}」这次能用，但没能写进工程目录（{detail}），刷新后就没了。',
  'pl.flash.removed': '已移除插件「{name}」',
  'pl.flash.enabled': '已启用「{name}」',
  'pl.flash.disabled': '已停用「{name}」',
  'pl.flash.enableAction': '启用',
  'pl.flash.disableAction': '停用',
  'pl.flash.toggleFailed': '没能{action}「{name}」：{detail}。插件状态没有改变。',

  /* -------------------------------------------------------- 问题码 */
  // 校验层（plugins/manifest.ts 的 PluginIssueCode）。键名是码的 camelCase。
  'pl.issue.notObject': '清单不是一个对象。',
  'pl.issue.badFormat': '清单缺少 `format: "artmatic-plugin"` 标记，可能不是插件文件。',
  'pl.issue.badApiVersion': '插件的 API 版本（{detail}）这个版本的 Artmatic 还不认识。',
  'pl.issue.badId':
    '插件 id「{detail}」不合法：只能用 a-z 0-9 . _ -，且以字母或数字开头，最长 64 位。',
  'pl.issue.badName': '插件缺少名称。',
  'pl.issue.badList': '「{path}」不是数组。',
  'pl.issue.noDefs': '插件里既没有特效也没有生成器（多半是字段名写错了）。',
  'pl.issue.badDef': '「{path}」不合法：{reason}',
  'pl.issue.duplicateId': 'id「{detail}」在同一个插件里重复了。',
  'pl.issue.badParam': '参数「{path}」不合法：{detail}。',
  'pl.issue.badShader': '着色器「{path}」不合法：{detail}。',
  'pl.issue.unknownMeta': '分类或标签「{detail}」不认识，已忽略。',
  'pl.issue.readFailed': '文件读不出来（{detail}）。',
  'pl.issue.compileFailed': '「{path}」的着色器编不过，已从这个插件里剔除：{detail}',
  'pl.issue.droppedUniform':
    '「{path}」声明了 uniform `{detail}` 但着色器从没读过它 —— 那个参数不会有反应。',
  'pl.issue.badHook': '文档钩子「{path}」不合法：{detail}。',
  'pl.issue.hookFailed': '文档钩子「{path}」在合成文档上跑不通，已剔除：{detail}',
  // 注册批次返回的 def 级码（host 塞在 detail 里，面板再翻一层）
  'pl.def.missingId': '缺少 id',
  'pl.def.duplicateId': 'id 与同一个插件里的另一条重复',
  'pl.def.builtinConflict': 'id 与内置条目冲突',

  /* -------------------------------------------------------- 失败原因 */
  'pl.fail.importFailed': '模块加载失败（{detail}）',
  'pl.fail.timeout': '模块加载超时（{detail} 毫秒）—— 它可能有顶层 await 一直没结束。',
  'pl.fail.notAPlugin':
    '这个文件没有导出插件对象（需要一句 `export const plugin` 或 `export default`，值是一个对象）。',
  'pl.fail.invalidManifest': '插件清单不合法。',
  'pl.fail.readFailed': '文件读不出来（{detail}）',

  /* ---------------------------------------------------- 文档钩子（排版） */
  'pl.countHooks': '{n} 个文档钩子',
  'pl.hookPhase.open': '打开时',
  'pl.hookPhase.render': '渲染时',
  'pl.hookPhase.save': '保存时',
  'pl.hookRuntime': '{phase}改写被拒绝（{detail}，已发生 {n} 次）。原文档保留。',
  'pl.hookOpened': '插件在打开时改写了 {n} 个排版片段。',
  'pl.hookSaved': '插件在保存时改写了 {n} 个排版片段（写盘的是改写后的副本，编辑器里仍是原样）。',

  /* ------------------------------------------------------------ 说明 */
  'pl.note.scope': '插件属于这个工程：换一个工程标签页就是另一套插件。',
  'pl.note.single': '一个插件就是一个文件，不能有相对导入（需要多文件的话请先打包成一个）。',
  'pl.note.missingDefs': '被剔除的条目不会参与渲染 —— 引用了它的片段会保持原样但不出效果。',
};
