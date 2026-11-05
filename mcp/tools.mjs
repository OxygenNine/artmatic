/**
 * tools.mjs — MCP 工具清单 + 入参校验。
 *
 * **这一层的定位**（方案 `docs/agent-control-plane.md` §2.1）：网关是**薄壳** ——
 * 不含业务逻辑（业务在页面内的控制平面里），只做三件事：
 *   1. schema：把工具入参的形状声明一次，同时产出 JSON Schema（给 `tools/list`）
 *      与校验函数（给 `tools/call`）；
 *   2. 协议适配：MCP ⇄ CDP；
 *   3. 错误归一：控制平面本来就不抛异常，这里只保证**校验失败也是同一种形状**。
 *
 * ## 为什么把「声明」与「校验」放在同一个来源
 *
 * 各写一份的 bug 形态很具体：JSON Schema 里改了枚举、校验函数忘了跟着改，
 * 于是「客户端按 schema 传的值被网关拒掉」——而两边看起来都对。
 * 所以这里只有一张表：`F.*` 描述字段，`buildSchema` 与 `validateArgs` 都读它。
 *
 * ## 为什么拒绝未知字段
 *
 * 拼错一个参数名（`trackid` / `clipID`）如果不报错，MCP 客户端会以为调用成功了，
 * 而工具用的是默认值 —— 这是最难查的一类「静默」。所以
 * `additionalProperties: false` 与校验里的 unknown-key 拒绝是**同一个决定**。
 *
 * ## 单位纪律
 *
 * `t` 是**秒**（控制平面会吸附到帧栅格）；要帧号的地方字段名带 `Frame`
 * （`frameRange.from` / `frameStep`）。与 `src/agent/types.ts` 顶部那条是同一件事。
 */

/* --------------------------------------------------------------- 字段声明 */

/**
 * 字段类型。`json` 是给 `tools/list` 的 JSON Schema 片段，`check` 是校验函数的
 * 单值判据（返回错误描述或 null）。
 */
const KINDS = {
  string: {
    json: () => ({ type: 'string' }),
    check: (v) => (typeof v === 'string' ? null : '必须是字符串'),
  },
  number: {
    json: () => ({ type: 'number' }),
    check: (v) => (typeof v === 'number' && Number.isFinite(v) ? null : '必须是有限数字'),
  },
  integer: {
    json: () => ({ type: 'integer' }),
    check: (v) => (Number.isInteger(v) ? null : '必须是整数'),
  },
  boolean: {
    json: () => ({ type: 'boolean' }),
    check: (v) => (typeof v === 'boolean' ? null : '必须是布尔值'),
  },
  /** `{ w, h }`：像素尺寸。非整数会被渲染层四舍五入，这里先挡住。 */
  size: {
    json: () => ({
      type: 'object',
      properties: { w: { type: 'integer' }, h: { type: 'integer' } },
      required: ['w', 'h'],
      additionalProperties: false,
    }),
    check: (v) => {
      if (typeof v !== 'object' || v === null || Array.isArray(v)) return '必须是 { w, h }';
      if (!Number.isInteger(v.w) || !Number.isInteger(v.h)) return 'w / h 必须是整数';
      if (v.w < 2 || v.h < 2) return 'w / h 至少为 2';
      return null;
    },
  },
  /** `Record<string, number | string>`：特效 / 生成器参数表。 */
  scalars: {
    json: () => ({ type: 'object', additionalProperties: { type: ['number', 'string'] } }),
    check: (v) => {
      if (typeof v !== 'object' || v === null || Array.isArray(v)) return '必须是对象';
      for (const [k, x] of Object.entries(v)) {
        if (typeof x !== 'number' && typeof x !== 'string') return `${k} 必须是数字或字符串`;
        if (typeof x === 'number' && !Number.isFinite(x)) return `${k} 不是有限数字`;
      }
      return null;
    },
  },
  /** `{ from, to }`：**帧号**，左闭右开（AGENTS §5.8 的约定）。 */
  frameRange: {
    json: () => ({
      type: 'object',
      properties: { from: { type: 'integer' }, to: { type: 'integer' } },
      required: ['from', 'to'],
      additionalProperties: false,
    }),
    check: (v) => {
      if (typeof v !== 'object' || v === null || Array.isArray(v)) return '必须是 { from, to }';
      if (!Number.isInteger(v.from) || !Number.isInteger(v.to)) return 'from / to 必须是整数帧号';
      if (v.from < 0) return 'from 不能为负';
      if (v.to <= v.from) return 'to 必须大于 from（左闭右开）';
      return null;
    },
  },
  /** `Curve | null`：形状由控制平面深校验（它才是知道键约定的一方），这里只看外壳。 */
  curve: {
    json: () => ({ type: ['object', 'null'] }),
    check: (v) => (v === null || (typeof v === 'object' && !Array.isArray(v)) ? null : '必须是曲线对象或 null'),
  },
  /** 字符串数组（能力清单按 id 过滤、排版元素的 id 列表）。 */
  stringArray: {
    json: () => ({ type: 'array', items: { type: 'string' } }),
    check: (v) => {
      if (!Array.isArray(v)) return '必须是字符串数组';
      for (const x of v) if (typeof x !== 'string') return '数组元素必须是字符串';
      return null;
    },
  },
  /** 透传：结构由控制平面校验（它才有 schema 与注册表）。 */
  any: {
    json: () => ({}),
    check: () => null,
  },
};

const F = Object.fromEntries(
  Object.entries(KINDS).map(([name, def]) => [name, (extra = {}) => ({ kind: name, ...extra })]),
);

/**
 * 一个「指向已有对象」的 id 字段：**一律必需**。
 *
 * 每张表里的 id 都是「你要改哪一个」，没有可省略的余地 —— 省了就只能靠猜，
 * 而猜错的表现是改到别的片段上（还会入撤销栈，用户以为自己没动过那一段）。
 * 合法性（这个 id 真的存在吗）由控制平面判，它才有 `Project`。
 */
const ID = (what) => F.string({ required: true, description: `${what} id。` });

/* ------------------------------------------------------------- Schema 产出 */

/** 字段声明 → JSON Schema 片段。 */
export function fieldSchema(spec) {
  const base = KINDS[spec.kind].json();
  const out = { ...base };
  if (spec.description) out.description = spec.description;
  if (spec.enum) {
    out.enum = spec.enum;
    if (!out.type) out.type = 'string';
  }
  if (spec.minimum !== undefined) out.minimum = spec.minimum;
  if (spec.maximum !== undefined) out.maximum = spec.maximum;
  if (out.type === undefined && !out.enum && out.additionalProperties === undefined) {
    // `any`：JSON Schema 里空对象即「任意」
    return out;
  }
  return out;
}

export function buildSchema(args) {
  const properties = {};
  const required = [];
  for (const [name, spec] of Object.entries(args)) {
    properties[name] = fieldSchema(spec);
    if (spec.required) required.push(name);
  }
  return {
    type: 'object',
    properties,
    required,
    // 见文件头：拼错的参数名必须报错，不许静默取默认值。
    additionalProperties: false,
  };
}

function bad(message, detail) {
  return { ok: false, error: { code: 'invalid-argument', message, ...(detail ? { detail } : {}) } };
}

/**
 * 校验一次工具调用的入参。**不抛异常** —— 失败也是一种正常返回值
 * （与控制平面的 `{ ok, data }` 包法是同一个理由）。
 */
export function validateArgs(tool, raw) {
  const args = raw === undefined || raw === null ? {} : raw;
  if (typeof args !== 'object' || Array.isArray(args)) {
    return bad('参数必须是对象');
  }

  const spec = tool.args ?? {};
  const unknown = Object.keys(args).filter((k) => !(k in spec));
  if (unknown.length > 0) {
    return bad(`不认识的参数：${unknown.join(', ')}`, { unknown, known: Object.keys(spec) });
  }

  const value = {};
  for (const [name, def] of Object.entries(spec)) {
    const v = args[name];
    if (v === undefined) {
      if (def.required) return bad(`缺少必需参数 ${name}`);
      continue;
    }
    const err = KINDS[def.kind].check(v);
    if (err) return bad(`${name}：${err}`, { field: name });
    if (def.enum && !def.enum.includes(v)) {
      return bad(`${name} 只能是 ${def.enum.join(' / ')}`, { field: name, validIds: def.enum });
    }
    if (def.minimum !== undefined && v < def.minimum) {
      return bad(`${name} 不能小于 ${def.minimum}`, { field: name, minimum: def.minimum });
    }
    if (def.maximum !== undefined && v > def.maximum) {
      return bad(`${name} 不能大于 ${def.maximum}`, { field: name, maximum: def.maximum });
    }
    value[name] = v;
  }
  return { ok: true, value };
}

/* ------------------------------------------------- 需要「外部事实」的校验 */

/**
 * 某个 id 必须在能力清单里（`defId` / `generator` / `blend`）。
 *
 * **必须在网关拦一次**：agent 最容易犯的错就是凭印象写 `defId`，而着色器是
 * 惰性编译的，拼错的特效在作用到画面之前不会有任何提示（AGENTS §5.5）。
 * 控制平面也会拦（那里有注册表），这里提前拦的好处是**连往返都省了**。
 */
export function checkIdInList(value, list, what) {
  if (list.includes(value)) return { ok: true };
  return {
    ok: false,
    error: {
      code: 'not-found',
      message: `${what} ${value} 不在能力清单里`,
      detail: { validIds: list },
    },
  };
}

/**
 * `frameRange` 越界检查。
 *
 * 越界本身不会崩（`runExport` 会再夹一次），但它会让「导了多少帧」与 agent 的
 * 预期不符 —— 而 agent 正是靠帧数算体积与时长预算的。所以宁可在这里报错，
 * 也不要把一个被悄悄改过的区间放过去。
 */
export function checkFrameRange(range, totalFrames) {
  if (!range) return { ok: true };
  if (range.from >= totalFrames) {
    return {
      ok: false,
      error: {
        code: 'invalid-argument',
        message: `frameRange.from ${range.from} 超出工程帧数（0..${totalFrames - 1}）`,
        detail: { totalFrames },
      },
    };
  }
  if (range.to > totalFrames) {
    return {
      ok: false,
      error: {
        code: 'invalid-argument',
        message: `frameRange.to ${range.to} 超出工程帧数（最多 ${totalFrames}）`,
        detail: { totalFrames },
      },
    };
  }
  return { ok: true };
}

/* --------------------------------------------------------------- 工具清单 */

const t = (v) => F.number({ description: '秒。会被吸附到帧栅格。', ...v });

/**
 * 工具表。`kind` 只用于文档与统计，网关不据此改行为。
 * `call` 字段没有 —— 映射写在 `index.mjs`（那里才有 bridge 与控制平面的接线）。
 */
export const TOOLS = [
  /* --------------------------------------------------------------- 读 */
  {
    name: 'artmatic_describe',
    kind: 'read',
    description: '握手 / 能力协商：API 版本、schema 版本、帧率、分辨率、时长。',
    args: {},
  },
  {
    name: 'artmatic_get_scene',
    kind: 'read',
    description:
      '工程在 t 时刻的紧凑快照：轨道（含 z 序）、片段（含 active）、曲线。' +
      "detail:'ids' 只给 id/start/end/label，用于长工程里先探路。",
    args: {
      t: t({ description: '查询时刻（秒）。省略 = 当前播放头。' }),
      detail: F.string({ enum: ['ids', 'full'], description: '默认 full。' }),
    },
  },
  {
    name: 'artmatic_get_capabilities',
    kind: 'read',
    description:
      '生成器 / 特效 / 转场 / 混合模式 / fit / 曲线模式清单。**选 id 只依据它**。' +
      "detail:'params' 额外给出参数表（键 / 类型 / 区间 / 选项 / 默认值 / 能否打关键帧），" +
      '配合 ids 过滤，避免一次吐几千 token。',
    args: {
      detail: F.string({ enum: ['ids', 'params'], description: '默认 ids。' }),
      ids: F.stringArray({ description: '只展开这几个 def id（省略 = 全部）。' }),
    },
  },
  {
    name: 'artmatic_get_clip',
    kind: 'read',
    description: '单个片段（含关键帧与特效链）。',
    args: { clipId: ID('片段') },
  },
  {
    name: 'artmatic_list_projects',
    kind: 'read',
    description: '已打开的工程列表（多工程是常态：顶栏选项卡每个是一份工程）。',
    args: {},
  },
  {
    name: 'artmatic_undo_state',
    kind: 'read',
    description: '撤销栈状态 { canUndo, canRedo }。agent 写完一步可以据此确认真的入栈了。',
    args: {},
  },
  {
    name: 'artmatic_compile_all',
    kind: 'read',
    description:
      '把上下文里所有着色器预编译一遍（特效 + realtime 算法 + 全部转场）。' +
      '着色器是惰性编译的，所以这是 agent 挂完一批特效后**唯一**能自查的手段。',
    args: {},
  },

  /* --------------------------------------------------------------- 写 */
  {
    name: 'artmatic_add_track',
    kind: 'write',
    description: '加一条轨道。新轨落在列表末尾（= z 最低 = 最底层）。',
    args: {
      kind: F.string({ required: true, enum: ['visual', 'audio'] }),
      name: F.string(),
    },
  },
  {
    name: 'artmatic_remove_track',
    kind: 'write',
    description: '删一条轨道（连同它的片段，一笔撤销）。',
    args: { trackId: ID('轨道') },
  },
  {
    name: 'artmatic_move_track',
    kind: 'write',
    description:
      '把轨道从 from 挪到 to 位。**轨道顺序就是合成顺序**：tracks[0] 在最前景（NLE 惯例）。',
    args: {
      from: F.integer({ required: true, minimum: 0 }),
      to: F.integer({ required: true, minimum: 0 }),
    },
  },
  {
    name: 'artmatic_set_track',
    kind: 'write',
    description:
      '改轨道的开关或名字。**关掉一条轨 = 它的画面整条不进合成**，做 A/B 时很有用。' +
      'muted（仅视觉轨）= 只关这条轨上视频片段的内嵌音轨，画面照常，导出同样生效；' +
      '音频轨没有 muted（它的 enabled 就是喇叭），传了会报 invalid-argument。',
    args: {
      trackId: ID('轨道'),
      enabled: F.boolean(),
      name: F.string(),
      muted: F.boolean({ description: '仅视觉轨：只静音内嵌音轨，不影响画面。' }),
    },
  },
  {
    name: 'artmatic_add_clip',
    kind: 'write',
    description:
      '加一个片段（一笔撤销）。kind:source 时其余字段按源类型取用；' +
      "kind:effect 时用 chain 给特效链（可同时给 defId 简写为单条链）。" +
      'params / 特效参数都会用**出厂默认值**补齐，只给想改的那几个。',
    args: {
      trackId: ID('轨道'),
      kind: F.string({ required: true, enum: ['algo', 'solid', 'image', 'video', 'text', 'effect'] }),
      start: t({ required: true }),
      end: t({ required: true }),
      id: F.string({ description: '显式 id（重放脚本的前提）。省略则生成。' }),
      label: F.string(),
      generator: F.string({ description: "kind:'algo' 的生成器 id。" }),
      params: F.scalars({ description: "kind:'algo' 的参数。" }),
      color: F.string({ description: "kind:'solid' 的颜色（#rrggbb）。" }),
      assetId: F.string({ description: "kind:'image' | 'video' 的素材 id。" }),
      srcIn: F.number({ description: "kind:'video' 的源内偏移（秒）。" }),
      speed: F.number({ description: "kind:'video' 的倍速。" }),
      doc: F.any({ description: "kind:'text' 的排版文档。" }),
      blend: F.string({ description: '混合模式，取值见 get_capabilities。' }),
      opacity: F.number(),
      transform: F.any({ description: '{ x, y, sx, sy, rot }，缺项取默认。' }),
      fit: F.string({ enum: ['contain', 'cover', 'stretch'] }),
      fadeSec: F.number({ minimum: 0 }),
      chain: F.any({ description: "kind:'effect' 的特效链：[{ defId, values? }]" }),
    },
  },
  {
    name: 'artmatic_add_effect_clip',
    kind: 'write',
    description:
      '加一个特效片段。两种用法：① 调整层（默认）—— 只作用于它下方（z 更小）的轨道，' +
      'affectDepth 限定只作用下方最近 N 条启用轨；② **绑定片段** boundClipId —— 链只跑在' +
      '那个片段的层上（先 placement，再特效，最后按该片段自己的 blend/opacity 混入），' +
      '与 z 序无关，也不影响别的层。节拍级的短促特效用它，不必每次开一条轨道。' +
      'boundClipId 与 affectDepth 互斥；目标必须是 source 片段。',
    args: {
      trackId: ID('轨道'),
      start: t({ required: true }),
      end: F.number({ required: true, description: '秒。' }),
      chain: F.any({ description: 'effects 链：[{ defId, values? }]' }),
      label: F.string(),
      fadeSec: F.number({ minimum: 0 }),
      affectDepth: F.integer({ minimum: 0 }),
      boundClipId: F.string({ description: '绑定到这个 source 片段（与 affectDepth 互斥）。' }),
    },
  },
  {
    name: 'artmatic_remove_clip',
    kind: 'write',
    description: '删一个片段（一笔撤销；用户在时间轴上按 Delete 是同一条路）。',
    args: { clipId: ID('片段') },
  },
  {
    name: 'artmatic_move_clip',
    kind: 'write',
    description: '移动片段到另一条轨道的 newStart。落点被重叠策略拒绝时整次不动（conflict）。',
    args: {
      clipId: ID('片段'),
      targetTrackId: ID('轨道'),
      newStart: t({ required: true }),
    },
  },
  {
    name: 'artmatic_resize_clip',
    kind: 'write',
    description:
      "拖一条边到 time。**start 边会推进 srcIn**（trim-in 语义：裁掉的就是素材头部）。",
    args: {
      clipId: ID('片段'),
      edge: F.string({ required: true, enum: ['start', 'end'] }),
      time: t({ required: true }),
    },
  },
  {
    name: 'artmatic_split_clip',
    kind: 'write',
    description: '在 at（秒）处切开。返回左右两段的 id（右半段是新的）。',
    args: { clipId: ID('片段'), at: t({ required: true }) },
  },
  {
    name: 'artmatic_set_clip_props',
    kind: 'write',
    description:
      '改片段属性。可写：label / fadeSec / blend / opacity / transform / fit / affectDepth / boundClipId /' +
      ' fadeIn + fadeOut（仅音频，秒，fadeIn+fadeOut ≤ 片段长度）/ srcIn（音频 / 视频的源内偏移）/' +
      ' crop（{left,top,right,bottom} 0..1，只收可见窗口不缩放）/ quad（四角 [x,y]，null 关）/' +
      ' key（{color,tolerance,softness,spill} 抠像，null 关）/' +
      ' speed（仅视频，正数倍速 0.05..100）。' +
      'speed **保持片段长度**（同一段时间轴吃掉更多 / 更少素材），只有素材不够时才缩短' +
      '（回执的 applied.end 是缩短后的终点）。它会清掉 speed 关键帧曲线 ——' +
      '要变速动画或倒放（负值）请用 artmatic_set_curve 的 param:"speed"。' +
      'null = 关掉那个效果。',
    args: {
      clipId: ID('片段'),
      patch: F.any({ required: true, description: '见 description 的白名单字段。' }),
    },
  },
  {
    name: 'artmatic_set_params',
    kind: 'write',
    description:
      '改参数。target:source 走源的参数表（algo 的生成器参数 / solid 的颜色）；' +
      "target:effect 改特效链第 chainIndex 条 —— params 与 enabled 至少给一个，" +
      'enabled 单独用就是「只关掉这一条做对比」。',
    args: {
      clipId: ID('片段'),
      target: F.string({ required: true, enum: ['source', 'effect'] }),
      chainIndex: F.integer({ minimum: 0, description: "target:'effect' 时要给。" }),
      params: F.scalars({ description: '参数键值对（给了 enabled / mask 时可省略）。' }),
      enabled: F.boolean({ description: "target:'effect'：这条实例的开关。" }),
      mask: F.any({
        description:
          "target:'effect'：外部蒙版。{ kind:'clip', clipId, channel } 读另一个片段这一帧的整帧层" +
          '（含它的绑定特效链），{ kind:"asset", assetId, channel } 读图片素材，null 摘掉。' +
          'channel 取 luma / alpha / r / g / b（缺省 luma）。只有 get_capabilities 里 ' +
          'flags.mask=true 的特效接受这个字段；成环或超过 8 层会被拒（code: conflict）。',
      }),
    },
  },
  {
    name: 'artmatic_set_generator',
    kind: 'write',
    description:
      '换掉算法片段的生成器（起止 / 混合 / 非生成器曲线保留）。参数重置为新生成器的默认值再合并 params；' +
      '旧生成器的参数曲线会被删掉（新生成器上没有这些键）。',
    args: {
      clipId: ID('片段'),
      generator: F.string({ required: true }),
      params: F.scalars(),
    },
  },
  {
    name: 'artmatic_seed_pattern_from_asset',
    kind: 'write',
    description:
      '把媒体池里的一张图片（SVG / PNG）按**不透明度**采样成算法片段的 pattern 参数：' +
      'alpha ≥ 50% 的像素变活格，颜色 / 亮度不参与。采样分辨率 = 当前网格（width × height），' +
      '并把 seedMode 切到 pattern（同一笔撤销）。返回编码后的图案（WxH:base64）与采样尺寸。',
    args: {
      clipId: ID('片段'),
      param: F.string({ required: true, description: '图案参数的键（通常是 "pattern"）。' }),
      assetId: ID('素材'),
    },
  },
  {
    name: 'artmatic_set_curve',
    kind: 'write',
    description:
      '设 / 删一条关键帧曲线。param 的合法取值与片段类型有关，' +
      '（源：opacity / transform.* / algo 的 range 参数；视频：speed（倍速，**负值 = 倒放**）；' +
      '特效：`<instanceId>.<参数>`；音频：gain）。curve 传 null 即删除。' +
      'speed 曲线下片段长度不变：负速区间把素材往回倒，内嵌音轨在速度 ≤ 0 时静音。',
    args: {
      clipId: ID('片段'),
      param: F.string({ required: true }),
      curve: F.curve({ required: false }),
    },
  },
  {
    name: 'artmatic_list_modulators',
    kind: 'read',
    description:
      '列出一个工程里的调制器（工程级表达式，可驱动任意 range 参数）以及它们的引用清单与函数词汇表。' +
      '形状：{ modulators: [{ id, name, expr, unit, refs: [{ clipId, clipLabel, param, slots }] }], ' +
      'functions: [{ name, arity }] }。unit 只影响界面显示范围，不参与求值。',
    args: {},
  },
  {
    name: 'artmatic_set_modulator',
    kind: 'write',
    description:
      '新建（省略 id）或修改一个调制器。表达式是**闭式**的：只依赖 t / beat / 种子，' +
      '没有跨帧状态（所以 seek 精确）。语法：数字、t（秒）、beat（拍）、pi/tau/e；' +
      '运算符 + - * / % ^ 与比较、`条件 ? a : b`；引用 modulator("id")（成环求值为 0）、param("键")；' +
      '函数 sin cos tan abs floor ceil round fract sign sqrt exp log smooth(x) mod(a,b) pow(a,b) ' +
      'min(a,b) max(a,b) step(edge,x) atan2(y,x) clamp(x,lo,hi) map(x,inMin,inMax,outMin,outMax) ' +
      'noise(x,freq,seed) fbm(x,octaves,seed) lfo(t,freq,shape) rand(seed)。' +
      'noise / fbm 返回 -1..1；lfo 的 shape：0 正弦 / 1 三角 / 2 锯齿 / 3 方波 / 4 随机保持。' +
      '表达式**先解析再落库**：语法错直接报错（带位置），不会静默变成 0。',
    args: {
      id: F.string({ description: '已有调制器 id（省略 = 新建）。' }),
      name: F.string({ description: '显示名（≤ 40 字符）。' }),
      expr: F.string({ description: '表达式源码，见工具说明里的语法。' }),
      min: F.number({ description: '显示范围下限（只影响界面，不钳制求值）。' }),
      max: F.number({ description: '显示范围上限（同上）。' }),
    },
  },
  {
    name: 'artmatic_remove_modulator',
    kind: 'write',
    description:
      '删除调制器，并在同一笔撤销里把它从所有引用它的参数上摘掉。返回 { removed, refs }，' +
      'refs 是被摘掉的槽数 —— 想知道是哪几处先调 list_modulators。',
    args: { id: F.string({ required: true, description: '调制器 id。' }) },
  },
  {
    name: 'artmatic_bind_modulator',
    kind: 'write',
    description:
      '把调制器绑到某个片段的某个 range 参数上，**叠加在关键帧曲线之上**（曲线先给值，再逐个槽作用）。' +
      'add：v += 增益 × 调制器；mul：v *= mix(1, 调制器, 增益)（增益 0 = 不生效，1 = 全乘）。' +
      'add 模式的增益是**参数自己的单位**（如 transform.x 的 40 = 40 个单位），mul 模式是 0..1。' +
      '默认增益 0.5、默认 add。同一个调制器同一种模式重复绑只更新增益。param 的寻址规则与 set_curve 相同。',
    args: {
      clipId: ID('片段'),
      param: F.string({ required: true, description: '参数键，寻址规则同 set_curve。' }),
      modulatorId: F.string({ required: true, description: '调制器 id。' }),
      gain: F.number({ description: '幅度 / 混合权重，默认 0.5。' }),
      mode: F.string({ description: 'add | mul，默认 add。', enum: ['add', 'mul'] }),
    },
  },
  {
    name: 'artmatic_unbind_modulator',
    kind: 'write',
    description:
      '解绑调制器。给了 modulatorId 只摘那一档，否则清空这个参数上的全部调制（关键帧曲线不动）。' +
      '返回 { param, slots }（剩余槽数）。',
    args: {
      clipId: ID('片段'),
      param: F.string({ required: true, description: '参数键，寻址规则同 set_curve。' }),
      modulatorId: F.string({ description: '只摘这一个；省略 = 全清。' }),
    },
  },
  {
    name: 'artmatic_add_effect',
    kind: 'write',
    description: '往特效片段的链里插一条特效（默认值自动补齐）。',
    args: {
      clipId: ID('特效片段'),
      defId: F.string({ required: true }),
      values: F.scalars(),
      index: F.integer({ minimum: 0, description: '插入位置，省略 = 追加到末尾。' }),
      enabled: F.boolean({ description: '建成就停用（默认 true）。' }),
    },
  },
  {
    name: 'artmatic_remove_effect',
    kind: 'write',
    description: '从特效链里删掉一条（下标按 get_clip 给的 chain 顺序）。',
    args: { clipId: ID('特效片段'), chainIndex: F.integer({ required: true, minimum: 0 }) },
  },
  {
    name: 'artmatic_reorder_effect',
    kind: 'write',
    description: '重排特效链。**顺序有语义**：链后的特效吃到链前的结果。',
    args: {
      clipId: ID('特效片段'),
      from: F.integer({ required: true, minimum: 0 }),
      to: F.integer({ required: true, minimum: 0 }),
    },
  },
  {
    name: 'artmatic_set_transition',
    kind: 'write',
    description:
      '设片段一端的转场。side=out（默认）窗口以 clip.end 为中心、作用于同轨紧邻的下一个 source 片段；' +
      'side=in 窗口以 clip.start 为中心、作用于同轨紧邻的上一个片段。**没有邻片段时那一侧是全透明**，' +
      '所以首尾片段也能做入场 / 出场。时长会被两侧长度钳制。',
    args: {
      clipId: ID('片段'),
      defId: F.string({ required: true }),
      duration: F.number({ required: true, minimum: 0.01 }),
      values: F.scalars(),
      side: F.string({ enum: ['in', 'out'], description: 'in = 入场，out = 出场（默认）。' }),
    },
  },
  {
    name: 'artmatic_clear_transition',
    kind: 'write',
    description: '删掉片段一端的转场（side 缺省 out）。',
    args: {
      clipId: ID('片段'),
      side: F.string({ enum: ['in', 'out'], description: 'in = 入场，out = 出场（默认）。' }),
    },
  },
  {
    name: 'artmatic_get_asset_ranges',
    kind: 'read',
    description:
      '读视频素材保存的预剪辑 In/Out 范围与当前激活范围。时间单位是**源内秒**；' +
      'frames 是按工程 fps 换算的帧数（插入片段时落下的长度就是它）。',
    args: { assetId: F.string({ required: true, description: '素材 id（media_list 给）。' }) },
  },
  {
    name: 'artmatic_set_asset_range',
    kind: 'write',
    description:
      '在视频素材上新增或更新（给 rangeId）一条 In/Out 范围。值按帧取整、钳到素材时长、至少 1 帧；' +
      '第一条自动成为激活范围。',
    args: {
      assetId: F.string({ required: true }),
      inSec: F.number({ required: true, minimum: 0, description: '入点（源内秒）。' }),
      outSec: F.number({ required: true, minimum: 0, description: '出点（源内秒）。' }),
      name: F.string({ description: '范围名；省略则生成「范围 N」。' }),
      rangeId: F.string({ description: '给 id = 更新已有范围。' }),
    },
  },
  {
    name: 'artmatic_remove_asset_range',
    kind: 'write',
    description: '删掉视频素材上的一条预剪辑范围。',
    args: {
      assetId: F.string({ required: true }),
      rangeId: F.string({ required: true }),
    },
  },
  {
    name: 'artmatic_set_active_range',
    kind: 'write',
    description: '指定插入素材时使用哪条范围；rangeId=null 清除（插入整段）。',
    args: {
      assetId: F.string({ required: true }),
      rangeId: F.string({ description: '省略 / null = 清除。' }),
    },
  },
  {
    name: 'artmatic_detach_video_audio',
    kind: 'write',
    description:
      '把视频片段的内嵌音轨分离到**新建的音频轨**上，位置对齐并默认锁定到视频（移动 / 裁剪 / 分裂跟随），' +
      '视频内嵌音轨同时静音。返回 audioClipId 与 trackId。',
    args: { clipId: ID('视频片段') },
  },
  {
    name: 'artmatic_set_audio_lock',
    kind: 'write',
    description: '锁定 / 解锁分离出来的音频片段。解锁保留血缘但不跟随；重新锁定会立刻对齐几何。',
    args: {
      clipId: ID('音频片段'),
      locked: F.boolean({ required: true, description: 'true = 跟随视频。' }),
    },
  },
  {
    name: 'artmatic_set_clip_audio',
    kind: 'write',
    description:
      '调音频片段 / 视频片段内嵌音轨的响度：gainDb 为 -60..+12 dB（0 = 原音量，-60 = 静音），' +
      'fadeIn / fadeOut 单位秒；muted 只对视频片段有意义。预览与导出走同一份求值。',
    args: {
      clipId: ID('片段'),
      gainDb: F.number({ minimum: -60, maximum: 12 }),
      fadeIn: F.number({ minimum: 0 }),
      fadeOut: F.number({ minimum: 0 }),
      muted: F.boolean(),
    },
  },
  {
    name: 'artmatic_media_list',
    kind: 'read',
    description:
      '媒体池：每条素材的 id / kind / 名字、是否在工程里（新片段能引用）、是否已移除但字节还在、' +
      '是否引用式（linked / stale）、字节是否缺失、字节数、被片段引用次数（0 = 未使用）；' +
      '另给磁盘占用（回收站 / 孤儿）。没有工程目录时 usage 为 null。删之前先读它，别猜 id。',
    args: {},
  },
  {
    name: 'artmatic_media_op',
    kind: 'write',
    description:
      '操作媒体池。**会移动 / 删除用户磁盘上的文件**，所以默认返回 needs-approval 并让应用弹确认；' +
      '用户确认后同一次调用才真正执行（设置里可以关掉「操作媒体池需我确认」）。' +
      'op: collect（把 linked 复制进工程）/ relink（重选源文件，需文件对话框）/ restore（恢复已移除素材）/' +
      ' trash（移进 assets/.trash）/ delete（彻底删除，**不可恢复**）/ trash_all / delete_all /' +
      ' clear_trash（清空回收站）/ cleanup_orphans（删 assets/ 里没人引用的文件）。' +
      'collect / relink / restore / trash / delete 需要 assetId。返回「真的改了几条」与释放的字节 —— ' +
      '0 表示什么都没做（没有工程目录 / 素材不在回收站 / 源文件没了），不是成功。',
    args: {
      op: F.string({
        required: true,
        enum: [
          'collect',
          'relink',
          'restore',
          'trash',
          'delete',
          'trash_all',
          'delete_all',
          'clear_trash',
          'cleanup_orphans',
        ],
      }),
      assetId: F.string({ description: '目标素材（collect / relink / restore / trash / delete）。' }),
    },
  },
  {
    name: 'artmatic_rename_asset',
    kind: 'write',
    description:
      '改素材的**显示名**（媒体池里看到的那个）。只改工程里的 name —— 磁盘文件名、扩展名、' +
      'linked 素材的原文件路径都不变；已有片段的 label 也不跟着改（那是另一份用户数据）。' +
      '空名字会被拒绝。',
    args: {
      assetId: F.string({ required: true, description: '素材 id（media_list 给）。' }),
      name: F.string({ required: true, description: '新的显示名（会 trim，不能为空）。' }),
    },
  },
  {
    name: 'artmatic_set_project',
    kind: 'write',
    description: '改工程级参数（name / fps / resolution / duration / beatGrid / overlapBehavior）。',
    args: {
      name: F.string({ description: '工程名（选项卡上显示的那个）。' }),
      fps: F.number(),
      resolution: F.size(),
      duration: F.number({ minimum: 0.1 }),
      beatGrid: F.any({ description: '{ bpm?, offset?, beatsPerBar? }' }),
      overlapBehavior: F.string({ enum: ['push', 'reject', 'trim'] }),
    },
  },
  {
    name: 'artmatic_estimate_beat_grid',
    kind: 'write',
    description:
      '从最早那条音频片段估 BPM / offset 并写进 beatGrid（与工具栏「一键估计」同一条实现）。' +
      '没有音频 / 静音 / 拍点不明显时直接失败（不写猜测值）。',
    args: {},
  },
  {
    name: 'artmatic_edit_sections',
    kind: 'write',
    description:
      '段落标记（sections）的增删改。段落**只存起点**：这一段的结尾是下一段的起点，最后一段到工程末尾。' +
      'op: add{start,name?} | split{sectionId,at} | rename{sectionId,name} | remove{sectionId} |' +
      ' move{sectionId,start}。start / at 是秒；add 会夹进 [0, duration]；split 在两半太窄时直接报错、' +
      '不改任何东西。返回改后的完整 sections（已按 start 排序）。',
    args: {
      op: F.string({ required: true, enum: ['add', 'split', 'rename', 'remove', 'move'] }),
      sectionId: F.string({ description: '目标段落（split / rename / remove / move）。' }),
      start: F.number({ description: '起点秒数（add / move）。' }),
      at: F.number({ description: '切点秒数（split）。' }),
      name: F.string({ description: '显示名（add / rename）。' }),
    },
  },
  {
    name: 'artmatic_load_scene',
    kind: 'write',
    description:
      '整体改写（路径 B）：传一份完整 Project（纯 JSON）。会先迁移 + 校验，' +
      '走 loadFrom ⇒ **整次只有一笔撤销**。生成式创作 / 批量重排用它。',
    args: { project: F.any({ required: true }) },
  },
  {
    name: 'artmatic_begin_transaction',
    kind: 'write',
    description: '开一段事务：后续所有写操作合成**一笔**撤销。写「一组改动」之前调它。',
    args: {},
  },
  {
    name: 'artmatic_commit_transaction',
    kind: 'write',
    description: '结束事务。label 会写进撤销记录。',
    args: { label: F.string() },
  },
  {
    name: 'artmatic_cancel_transaction',
    kind: 'write',
    description: '回滚整段事务（回到 begin 之前的状态）。',
    args: {},
  },
  {
    name: 'artmatic_undo',
    kind: 'write',
    description: '撤销一步（用户在界面上按 Ctrl+Z 是同一条路）。',
    args: {},
  },
  {
    name: 'artmatic_redo',
    kind: 'write',
    description: '重做一步（撤销之后想再试一次时用）。',
    args: {},
  },

  /* ---------------------------------------------------------- 看 / 导 */
  {
    name: 'artmatic_frame_signature',
    kind: 'view',
    description:
      '一帧的**数值指纹**（逐通道均值 + 分块均值 + 点采样 + 结构跨度）。' +
      '判断「改对没改对」默认用它 —— 一张 PNG 输入约合上千 token，指纹只有几十个数字。',
    args: {
      t: t(),
      size: F.size({ description: '默认 320×宽（小尺寸更快）。' }),
      grid: F.integer({ minimum: 1, maximum: 16, description: '分块数，默认 4。' }),
      only: F.any({
        description: '隔离渲染：{ trackId?, elementId? }。只让这一层可见（工程本身不改）。',
      }),
    },
  },
  {
    name: 'artmatic_render_frame',
    kind: 'view',
    description:
      '出图（PNG）。**只在需要「看」的时候用**：审美判断 / 最终验收 / 给人看。' +
      'only 可只渲染一条轨 / 一个排版元素（临时隐藏其它层，工程不改）。',
    args: {
      t: t(),
      size: F.size({ description: '默认工程分辨率。' }),
      only: F.any({ description: '隔离渲染：{ trackId?, elementId? }。' }),
      region: F.any({ description: '局部放大：{x,y,w,h}（0..1 的裁切框，裁完放大到 ≥480px 宽）。' }),
    },
  },
  {
    name: 'artmatic_render_sequence',
    kind: 'view',
    description:
      '一段时间的若干帧拼成**一张联系表**（行优先，每格左下角烧时间戳）。' +
      '判断节奏 / 卡点必须用它 —— 单帧看不出「这个重音落在拍上没」。' +
      'from / to / step 都是秒；默认 6 帧均分，最多 24 帧。',
    args: {
      from: F.number({ description: '起始秒，默认 0。' }),
      to: F.number({ description: '结束秒（不含），默认工程时长。' }),
      step: F.number({ description: '间隔秒；省略 = 6 帧均分。' }),
      size: F.size({ description: '单格尺寸，默认 320 宽。' }),
      cols: F.integer({ minimum: 1, maximum: 6, description: '列数，默认 3。' }),
      only: F.any({ description: '隔离渲染：{ trackId?, elementId? }。' }),
      region: F.any({ description: '局部放大：{x,y,w,h}。' }),
    },
  },
  {
    name: 'artmatic_export',
    kind: 'export',
    description:
      '导出到磁盘。**区间用帧号**（左闭右开）。' +
      '走的是与导出面板完全相同的驱动循环（硬约束 1.1：预览与导出同一条求值路径）。',
    args: {
      format: F.string({ required: true, enum: ['mp4', 'png', 'gif'] }),
      frameRange: F.frameRange({ description: '{ from, to } 帧号，左闭右开。' }),
      size: F.size({ description: '默认工程分辨率；GIF 默认 480 宽。' }),
      frameStep: F.integer({ minimum: 1, description: '抽帧步进，默认 1。' }),
      outPath: F.string({ description: '落盘路径。省略则写系统临时目录。' }),
    },
  },
  {
    name: 'artmatic_open_project',
    kind: 'project',
    description:
      "打开一份工程。给 name 走 OPFS（headless 驱动用），不给则弹系统目录选择器（需要用户手势）。",
    args: { name: F.string() },
  },
  {
    name: 'artmatic_save_project',
    kind: 'project',
    description: '保存当前工程到它的目录句柄。未绑定目录时会失败（不是「另存为」）。',
    args: {},
  },

  /* ------------------------------------------------------- 说明（按需取） */
  {
    name: 'artmatic_help',
    kind: 'read',
    description:
      '取一份说明：plugin-api（插件怎么写：着色器头 / 参数类型 / 派发规则 / 例子）|' +
      'timeline | typography | workflow | images。写插件之前先取 plugin-api。',
    args: { topic: F.string({ description: '主题名。省略 = 可用清单。' }) },
  },

  /* ------------------------------------------------------------ 排版 */
  {
    name: 'artmatic_get_typography_capabilities',
    kind: 'read',
    description:
      '排版能力：图形种类（及各自的专属参数）、22 个程序化生成器（含语义 notes）、配色方案、' +
      '填充形态、布局操作，以及 units（px / 0..1 比例 / rot 弧度 / 生成器坐标系）。',
    args: {},
  },
  {
    name: 'artmatic_get_typography_doc',
    kind: 'read',
    description:
      '读文本片段的排版文档。detail:\'ids\' 只给元素 id / 类型 / 框，full 还给样式、填充、文本、' +
      '3D、动画（预设 / keys / 自定义 css 原文，可直接写回）与生成器状态。' +
      '省略 clipId 时用排版编辑器当前打开的那份。',
    args: {
      clipId: F.string({ description: '文本片段 id；省略 = 当前打开的排版文档。' }),
      detail: F.string({ enum: ['ids', 'full'] }),
    },
  },
  {
    name: 'artmatic_typo_add_element',
    kind: 'write',
    description:
      '加排版元素。element.kind 决定形态：text{text,frame?,style?,fill?,boxFill?,boxStroke?,autoHeight?} |' +
      'shape{shape,frame?,fill?,stroke?,radius?,sides?,waist?,inner?,angle?,path?,pathUnit?,clipFrame?} |' +
      'image{assetId,frame?,fit?,crop?}。frame = {x,y,w,h,rot}（文档 px，左上原点）。' +
      '三者都接受 animation / animations（与 typo_set_animation 同 schema，含自定义 css）' +
      '与 transform3d（元素级 3D）。',
    args: {
      clipId: F.string(),
      element: F.any({ required: true, description: '元素对象（见 description）。' }),
    },
  },
  {
    name: 'artmatic_typo_add_elements',
    kind: 'write',
    description:
      '批量加排版元素：一次调用 = 一笔撤销。elements 的**数组顺序即 z 序**（后面的在前）。' +
      '返回 { elementIds, elements }（含落库后的值）。',
    args: {
      clipId: F.string(),
      elements: F.any({ required: true, description: '元素对象数组（形状同 typo_add_element.element）。' }),
    },
  },
  {
    name: 'artmatic_typo_add_generated_shape',
    kind: 'write',
    description: '插入一个程序化 SVG 生成器（环 / 条码 / 等高线…）。参数与种子决定图案，之后就是普通图形元素。',
    args: {
      clipId: F.string(),
      genId: F.string({ required: true }),
      params: F.scalars(),
      seed: F.integer({ description: '32 位无符号种子。' }),
      frame: F.any({ description: '{x,y,w,h,rot}。' }),
      name: F.string(),
      fill: F.any(),
      stroke: F.any(),
    },
  },
  {
    name: 'artmatic_typo_update_element',
    kind: 'write',
    description:
      '改一个元素：name / frame / blend / opacity / visible / locked / text / style / fill / boxFill /' +
      'boxStroke / glyphStroke / autoHeight（仅文本）/ stroke / radius / sides / waist / inner / angle / evenOdd /' +
      ' fit / crop / gen / transform3d（逐层合并，null 关闭）/ path（仅 shape:"svg"，写入会烘焙掉生成器绑定）/' +
      ' pathUnit / clipFrame / animations / animation / addAnimation / removeAnimations。' +
      '图片元素另有 adjust（{brightness,contrast,saturation,sharpen,soften,curves}，逐层合并、null 关闭）/' +
      ' recolor（{color,shadow,amount}）/ border（{color,width}，画在图内）/ filter（{id,amount}，id 见' +
      ' get_typography_capabilities().images.filter.ids）；图形另有 imageFill（{assetId,fit}，用路径裁剪图片，' +
      '此时 fill 被忽略 —— 这就是「裁剪为形状」）。',
    args: {
      clipId: F.string(),
      elementId: F.string({ required: true }),
      patch: F.any({ required: true }),
    },
  },
  {
    name: 'artmatic_typo_update_elements',
    kind: 'write',
    description:
      '批量改元素属性：一次调用 = 一笔撤销。updates = [{ elementId, patch }]；' +
      '所有 id 在改动之前校验。返回改后的 elements。',
    args: {
      clipId: F.string(),
      updates: F.any({ required: true, description: '[{ elementId, patch }]' }),
    },
  },
  {
    name: 'artmatic_typo_set_animation',
    kind: 'write',
    description:
      '设置 / 替换 / 清除元素动画（与编辑器同一套 CSS 动画，导出里同样生效）。' +
      '**首选**结构化轨道：{ prop, keys:[{ t, v, ease?, color? }], loop?, easing? } ——' +
      '一条动画只动一个属性。prop = x | y | sx | sy | rot | opacity | blur，或任意 CSS 属性名' +
      '（kebab-case：letter-spacing / clip-path / color / transform）。' +
      't 是**相对片段起点的绝对秒**（不是 0..1、不是帧号），也接受 { beat: n }；' +
      'v 是数字（x/y 为 px、sx/sy 为倍数、rot 为度、opacity 0..1、blur 为 px）或任意属性的原始字符串；' +
      'ease 是「从本帧到下一帧」那一段的缓动（关键字或 [x1,y1,x2,y2]），不填则继承条目 easing；' +
      'color 是可选的 #rrggbb **标记色**（只给编辑器做记号，不进样式表，读回时原样带回）。' +
      'delay / duration 由第一帧与最后一帧派生（传了也不改变时序）。' +
      '要让几个属性错开起落，就发多条动画（mode:"add"）—— 每条各自是一条 CSS 动画、各有各的 delay；' +
      '同一作用层（target）里不要对同一属性发两条。' +
      'target（可选）："box"（缺省）动**整个元素框**，文本框底板与边框跟着一起走' +
      '（clip-path 裁到框、rot 转整块）；"content" 只动文字 / 图形 / 图片本身、文本框底色' +
      '不动（只在明确要「只转字」时才用）。两层可以各自动同一属性。' +
      '其余形态照旧：{ css } / { preset, duration?, delay?, loop?, easing? } / ' +
      '{ keys:[{ at, opacity?, x?, y?, sx?, sy?, rot?, blur? }], duration?, delay?, easing? }' +
      '（旧式：at 为 0..1 或 { beat:n }，会按属性拆成多条轨道，t = delay + at × duration）。' +
      'css 是编辑器「自定义动画」的语法：一个或多个 @keyframes 块 + 一条顶层 ' +
      'animation: 名字 时长 …;（多条用逗号分隔）；只填 keyframes 体（from{…}to{…}）也可，' +
      '时序取 duration / delay / loop / easing。任何可动的 CSS 属性都能写（3D 旋转 / clip-path /' +
      ' 颜色 / 背景位移…），名字按元素命名空间化。顶层选择器 / @import / @charset / @namespace ' +
      '会被拒绝并给出具体原因。' +
      'duration / delay 单位秒；loop: "once" | "infinite" | 数字。' +
      '预设名见 get_typography_capabilities().animations.presets。animation:null 清空，' +
      'mode:"add" 叠加一条。',
    args: {
      clipId: F.string(),
      elementId: F.string({ required: true }),
      animation: F.any({ description: '动画对象，或 null 清空。' }),
      mode: F.string({ enum: ['replace', 'add'] }),
    },
  },
  {
    name: 'artmatic_typo_copy_style',
    kind: 'write',
    description:
      '把**一个元素**的样子刷到其它元素上（编辑器的「格式刷 / 动画刷」同一条路径）：一次调用 = 一笔撤销。' +
      "what:'format'（缺省）只复制**外观**：填充（图形的 fill 落到文本框的 boxFill，反之亦然）、" +
      '描边（同样的对角映射）、圆角、文本样式（字体 / 字号 / 字重 / 行高 / 对齐 / 字色 / 装饰 / 高亮）、' +
      '图片处理（fit / crop / key / quad / adjust / recolor / border / filter）、阴影与虚化；' +
      '**不**复制内容（runs / assetId）、几何（frame / transform3d）与 opacity / blend。' +
      "what:'animation' 用源的动画**整份替换**目标的动画（重新发 id；源没有动画 = 清空目标）。" +
      '目标种类没有的字段静默跳过（图形没有 fit / crop）。返回 { changed, elements }；changed = 0 表示本来就一样。',
    args: {
      clipId: F.string(),
      sourceId: F.string({ required: true, description: '从哪个元素复制。' }),
      targetIds: F.stringArray({ required: true, description: '要刷到的元素 id（源自己会被忽略）。' }),
      what: F.string({ enum: ['format', 'animation'] }),
    },
  },
  {
    name: 'artmatic_typo_set_scripts',
    kind: 'write',
    description:
      '整表替换排版文档的**逐帧脚本**（一笔撤销；数组顺序即执行顺序；[] 清空，省略字段则保留）。' +
      '每条 = { id?, name?, code, enabled?, targets?, needs? }。code 是**同步函数体**，ctx 在作用域内：' +
      'ctx.t / frame / fps / duration / w / h / seed；ctx.el(id) / els(kind?) → style(decls) /' +
      ' transform({x,y,rotate,scale,skew})（x/y 文档 px，rotate 角度）/ opacity / visible / attr /' +
      ' path(d)（shape:"svg"，坐标系看该元素 pathUnit）/ var(name,value) / canvas()（2D，需 needs:["canvas"]）' +
      ' / box() / d；ctx.chars(elId) → 逐字句柄（需 needs:["chars"]）；纯函数 rand(i) / ease /' +
      ' clamp / lerp / smoothstep / morph(a,b,k) / hsl / log。' +
      '禁止：跨帧状态、Math.random / Date.now / 定时器 / 网络 / await。' +
      '结构需求：needs:["chars"] 生成逐字 span（编辑该文本时暂停），"canvas" 在元素内插 2D 画布。' +
      '限制：8 条 / 单条 2 万字符 / 总计 6.4 万 / 每帧 5 千次写 / 单脚本 12ms。' +
      '完整 API 见 get_typography_capabilities().scripts。' +
      '⚠️ 脚本默认不运行（全局偏好），关闭时画面与没有脚本完全一致 —— 必须提示用户去开启，' +
      '不要假定效果已经可见。',
    args: {
      clipId: F.string(),
      scripts: F.any({ required: true, description: '脚本对象数组；[] 清空。' }),
    },
  },
  {
    name: 'artmatic_typo_measure',
    kind: 'read',
    description:
      '排版几何体检（不渲染）：每个元素的框、文字实际内容高度 / 行数 / 被裁掉多少、' +
      '出画距离、元素两两相交（文本压字单独标出）。适合「正文溢出 / 元素叠在一起」时先量再挪。',
    args: {
      clipId: F.string(),
      elementIds: F.stringArray({ description: '只看这些元素（省略 = 全部）。' }),
    },
  },
  {
    name: 'artmatic_typo_set_text',
    kind: 'write',
    description: '替换元素的文本（丢弃旧的逐段格式）。',
    args: { clipId: F.string(), elementId: F.string({ required: true }), text: F.string({ required: true }) },
  },
  {
    name: 'artmatic_typo_remove_element',
    kind: 'write',
    description: '从排版文档里删掉一个元素（一笔撤销；组合会在写库后自动收口）。',
    args: { clipId: F.string(), elementId: F.string({ required: true }) },
  },
  {
    name: 'artmatic_typo_reorder_element',
    kind: 'write',
    description:
      '调层级（数组下标即 z 序，越靠后越前）：front | back | forward | backward，' +
      '或 op:"index" + index 移到绝对位置（0 = 最后面）。',
    args: {
      clipId: F.string(),
      elementId: F.string({ required: true }),
      op: F.string({ required: true, enum: ['front', 'back', 'forward', 'backward', 'index'] }),
      index: F.integer({ minimum: 0, description: 'op:"index" 时的目标下标。' }),
    },
  },
  {
    name: 'artmatic_typo_group',
    kind: 'write',
    description: '成组（成员共享背景 / 边框外壳；在数组里变成连续一段）。',
    args: {
      clipId: F.string(),
      elementIds: F.stringArray({ required: true }),
      name: F.string(),
    },
  },
  {
    name: 'artmatic_typo_ungroup',
    kind: 'write',
    description: '解组（只影响这些元素所在的组）。',
    args: { clipId: F.string(), elementIds: F.stringArray({ required: true }) },
  },
  {
    name: 'artmatic_typo_update_group',
    kind: 'write',
    description:
      '改分组底板（成组只建壳，不给样式的话壳是不可见的）。' +
      'patch: { name?, fill?（Paint）, stroke?（Stroke 或 null）, radius?（px）, padding?（px，外壳比成员大出多少）}。',
    args: {
      clipId: F.string(),
      groupId: F.string({ required: true }),
      patch: F.any({ required: true, description: '{ name?, fill?, stroke?, radius?, padding? }' }),
    },
  },
  {
    name: 'artmatic_typo_boolean',
    kind: 'write',
    description:
      '图形布尔运算（z 序 = 文档顺序，不是 elementIds 顺序）。op: union | difference | intersection | xor。' +
      '差集以**最底下**的那个为被减数（后画的挖掉先画的）。结果是**一个新** shape:"svg" 元素，' +
      '放在最上面那个操作数的位置；操作数被移除、结果不带动画。结果为空时报错且不改文档。',
    args: {
      clipId: F.string(),
      elementIds: F.stringArray({ required: true }),
      op: F.string({ required: true, enum: ['union', 'difference', 'intersection', 'xor'] }),
    },
  },
  {
    name: 'artmatic_typo_divide',
    kind: 'write',
    description:
      '拆分：把重叠图形切成互不重叠的若干片，每片沿用「盖在它最上面的那个操作数」的外观。' +
      '操作数被移除，结果片保留原组。返回新元素 id。',
    args: { clipId: F.string(), elementIds: F.stringArray({ required: true }) },
  },
  {
    name: 'artmatic_typo_convert_to_path',
    kind: 'write',
    description:
      '转路径：参数化图形就地转（同 id，0..100 authored）；生成器图形只摘掉 gen 绑定；' +
      '文本走真实字形轮廓（DOM 排版 + HarfBuzz），产出一个或多个 pathUnit:"px" 的 svg 图形，' +
      '第一个沿用原 id，多个时包进新组合。**整批原子**：字体缺失 / 竖排 / 合成粗体等任何一条失败都不改文档。' +
      '文本转换较慢。',
    args: { clipId: F.string(), elementIds: F.stringArray({ required: true }) },
  },
  {
    name: 'artmatic_typo_set_canvas_size',
    kind: 'write',
    description:
      '改画幅（文档设计分辨率）。scaleContent:true = 元素 / 字号 / 描边 / 阴影 / 3D 的 px 一起按比例重排' +
      '（真正的「换画幅」）；false = 只改画布，元素留在原像素位置（构图会挪、超出被裁）。',
    args: {
      clipId: F.string(),
      size: F.size({ required: true }),
      scaleContent: F.boolean({ description: '默认 false。' }),
    },
  },
  {
    name: 'artmatic_typo_layout',
    kind: 'write',
    description:
      '排版布局：align（axis + target canvas|selection）| distribute（axis h|v，至少 3 个）|' +
      'grid（cols, rows?, gap?, margin?）| row | column。省略 elementIds = 所有未锁定元素。',
    args: {
      clipId: F.string(),
      op: F.string({ required: true, enum: ['align', 'distribute', 'grid', 'row', 'column'] }),
      axis: F.string(),
      target: F.string({ enum: ['canvas', 'selection'] }),
      elementIds: F.stringArray(),
      cols: F.integer({ minimum: 1 }),
      rows: F.integer({ minimum: 1 }),
      gap: F.number({ minimum: 0 }),
      margin: F.number({ minimum: 0 }),
    },
  },
  {
    name: 'artmatic_typo_set_background',
    kind: 'write',
    description: '文档背景（Paint：none | solid | linear | radial | texture）。',
    args: { clipId: F.string(), paint: F.any({ required: true }) },
  },
  {
    name: 'artmatic_typo_set_theme',
    kind: 'write',
    description:
      '切配色方案；只有用 @slot 引用的元素会换色（裸 hex 不跟）。theme 传 null = 默认方案。' +
      'scope:"project" = 同时写工程默认方案 + 所有文本文档（一笔撤销）。未知 id 会被拒绝，不静默回落。',
    args: {
      clipId: F.string(),
      theme: F.string(),
      scope: F.string({ enum: ['clip', 'project'] }),
    },
  },
  {
    name: 'artmatic_typo_save_theme',
    kind: 'write',
    description:
      '新建 / 更新一份自定义配色方案，并立即设为当前方案。colors 是**局部补丁**' +
      '（键见 get_typography_capabilities().themeSlots），省略的槽沿用 base 的值。' +
      'base = 复制基准（内置或自定义 id）；id = 更新已有的自定义方案。',
    args: {
      clipId: F.string(),
      id: F.string(),
      base: F.string(),
      name: F.string(),
      colors: F.any({ description: '局部色槽 → hex。' }),
      scope: F.string({ enum: ['clip', 'project'] }),
    },
  },
  {
    name: 'artmatic_typo_remove_theme',
    kind: 'write',
    description: '删除一份自定义配色方案，并抹掉工程里对它的引用（typographyTheme + 各文档）。内置方案删不掉。',
    args: { themeId: F.string({ required: true }) },
  },
  {
    name: 'artmatic_typo_replace_doc',
    kind: 'write',
    description:
      '整体替换文档（一笔撤销）。坏元素整条丢弃而不是整次失败 —— 看返回的 dropped；' +
      '不认识的键逐条列在 droppedKeys，非法动画条目列在 droppedAnimations' +
      '（如 elements[2].animations[0]），都不是静默归一化。动画（预设 / keys / 自定义 css）' +
      '会被保留，所以 detail:full 读出来的文档改完可以直接写回。text 是纯文本，' +
      '逐段行内格式不在这条路上。',
    args: { clipId: F.string(), doc: F.any({ required: true }) },
  },

  /* ------------------------------------------------------------ 插件 */
  {
    name: 'artmatic_plugin_try',
    kind: 'write',
    description:
      '校验 + 载入内存 + 真 GL 编译一个单文件插件（**不写盘**）。返回限定 id 与结构化 issue，' +
      '模型据此自修复后再次调用（同一个 id 会热替换草稿）。' +
      '**省略 source** = 用当前草稿（plugin_edit 之后）或磁盘上的已安装文件 —— 小改动不必重发全文。' +
      '**需要用户确认**：试挂会在页面主世界立刻执行源码；不传 confirm 时返回 code=needs-approval。',
    args: {
      id: F.string({ required: true, description: '[a-z0-9][a-z0-9._-]*' }),
      name: F.string({ description: '展示名。省略时沿用草稿 / 已安装记录里的名字。' }),
      source: F.string({ description: '完整 ESM 源码（export const plugin = …）。省略 = 用草稿。' }),
      confirm: F.boolean({
        description: '由客户端用户明确同意后传 true；MCP 客户端不要替用户做这个决定。',
      }),
    },
  },
  {
    name: 'artmatic_plugin_view',
    kind: 'read',
    description:
      '带行号分页读插件源码。每行形如 `  12 | code`；text 末尾是 ' +
      '`[N more lines; continue with offset=M]` 或 `[end of file (N lines)]`。' +
      'origin=draft 表示读到的是这次会话的草稿，file 表示磁盘上的已安装文件。',
    args: {
      pluginId: F.string({ required: true }),
      offset: F.integer({ description: '1-based 起始行，默认 1。' }),
      limit: F.integer({ description: '每页行数，默认 200，上限 500。' }),
    },
  },
  {
    name: 'artmatic_plugin_edit',
    kind: 'write',
    description:
      '按唯一字面量替换插件源码。oldString 必须在文件里**恰好出现一次**：' +
      '0 次返回 not-found，2 次以上返回 invalid-argument 并在 detail.lines 给出全部行号。' +
      '只改内存草稿（不执行、不写盘）：用 plugin_try（省略 source）生效，plugin_install 落盘。',
    args: {
      pluginId: F.string({ required: true }),
      oldString: F.string({ required: true, description: '要替换的精确字面量，必须唯一。' }),
      newString: F.string({ required: true, description: '替换后的文本；空字符串 = 删除该处。' }),
    },
  },
  {
    name: 'artmatic_plugin_grep',
    kind: 'read',
    description:
      '在插件源码里按正则搜索。返回 1-based 行号与整行；total 是 max 截断前的命中数；' +
      'context 可带前后各至多 2 行。正则非法 → invalid-argument。',
    args: {
      pluginId: F.string({ required: true }),
      pattern: F.string({ required: true, description: 'JavaScript 正则源码（不带 flags，用 ignoreCase）。' }),
      ignoreCase: F.boolean(),
      context: F.integer({ description: '命中行前后各带几行（0–2）。' }),
      max: F.integer({ description: '最多返回多少条，默认 40，上限 200。' }),
    },
  },
  {
    name: 'artmatic_plugin_check',
    kind: 'read',
    description:
      '静态语法检查（acorn 真解析，**不执行**）。issue 带 1-based 行列与稳定 code：' +
      'syntax | import | dynamic-import | no-export | bad-format。插件是单文件，任何 import 都会在加载时失败。',
    args: { pluginId: F.string({ required: true }) },
  },
  {
    name: 'artmatic_plugin_install',
    kind: 'write',
    description:
      '把试挂中的插件写进工程 plugins/。**需要用户确认**：不传 confirm 时返回 code=needs-approval，' +
      '面板上点「安装」之后页面内会带 confirm=true 再调一次。',
    args: {
      pluginId: F.string({ required: true }),
      confirm: F.boolean({ description: '页面内审批后由界面传 true；MCP 客户端不要自己传。' }),
    },
  },
  {
    name: 'artmatic_plugin_list',
    kind: 'read',
    description: '已安装插件（状态 / 条目数 / issue / 是否有草稿）。',
    args: {},
  },
  {
    name: 'artmatic_plugin_discard',
    kind: 'write',
    description: '丢弃内存里的草稿（不删已安装的文件）。',
    args: { pluginId: F.string({ required: true }) },
  },
  {
    name: 'artmatic_plugin_remove',
    kind: 'write',
    description: '摘注册表 + 删工程目录里的插件文件。',
    args: { pluginId: F.string({ required: true }) },
  },
  {
    name: 'artmatic_plugin_source',
    kind: 'read',
    description: '取当前草稿源码（给审批 / 对比用）。',
    args: { pluginId: F.string({ required: true }) },
  },
];

export const TOOL_BY_NAME = new Map(TOOLS.map((tool) => [tool.name, tool]));

/** `tools/list` 的返回体。 */
export function listToolDescriptors() {
  return TOOLS.map((tool) => ({
    name: tool.name,
    description: tool.description,
    inputSchema: buildSchema(tool.args),
  }));
}
