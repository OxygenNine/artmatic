# LLM 提供商差异矩阵

应用内 Agent 的注册表在 `src/agent/llm/providers/registry.ts`，这是它的**说明文档**：
端点、鉴权、思考参数、思维链回传策略，以及哪些结论有官方文档、哪些还等实测。

规则只有一条：**能写进数据表的，不要写进代码。** 新增一家 = 加一条注册表 + 一张
`src/assets/providers/<id>.svg`。

---

## 1. 端点与鉴权

| id | 提供商 | baseUrl | 端点 | 鉴权 |
|---|---|---|---|---|
| `deepseek` | 深度求索 | `https://api.deepseek.com` | `/chat/completions` | `Bearer` |
| `dashscope` | 通义千问（百炼） | `https://dashscope.aliyuncs.com/compatible-mode/v1` | `/chat/completions` | `Bearer` |
| `zhipu` | 智谱 GLM | `https://open.bigmodel.cn/api/paas/v4` | `/chat/completions` | `Bearer` |
| `kimi` | 月之暗面 | `https://api.moonshot.cn/v1` | `/chat/completions` | `Bearer` |
| `doubao` | 豆包（火山方舟） | `https://ark.cn-beijing.volces.com/api/v3` | `/chat/completions` | `Bearer` |
| `hunyuan` | 腾讯混元 | `https://api.hunyuan.cloud.tencent.com/v1` | `/chat/completions` | `Bearer` |
| `qianfan` | 文心一言（千帆 v2） | `https://qianfan.baidubce.com/v2` | `/chat/completions` | `Bearer` |
| `spark` | 讯飞星火 | `https://spark-api-open.xf-yun.com/v1` | `/chat/completions` | `Bearer` |
| `stepfun` | 阶跃星辰 | `https://api.stepfun.com/v1` | `/chat/completions` | `Bearer` |
| `minimax` | MiniMax | `https://api.minimaxi.com/v1` | `/chat/completions` | `Bearer` |
| `siliconflow` | 硅基流动 | `https://api.siliconflow.cn/v1` | `/chat/completions` | `Bearer` |
| `openai` | OpenAI | `https://api.openai.com/v1` | `/chat/completions` | `Bearer` |
| `anthropic` | Anthropic | `https://api.anthropic.com/v1` | `/messages` | `x-api-key` + `anthropic-version` |
| `gemini` | Google Gemini | `https://generativelanguage.googleapis.com/v1beta/openai` | `/chat/completions` | `Bearer` |
| `openrouter` | OpenRouter | `https://openrouter.ai/api/v1` | `/chat/completions` | `Bearer` |
| `xai` | xAI | `https://api.x.ai/v1` | `/chat/completions` | `Bearer` |
| `azure` | Azure OpenAI | **用户填资源端点** | `/openai/deployments/{model}/chat/completions?api-version=…` | `api-key` |
| `cloudflare` | Cloudflare AI Gateway | **用户填网关根** | 按模型前缀三条通道（见 §9.4） | `cf-aig-authorization` |
| `custom` | 自定义（OpenAI 兼容） | 用户填 | `/chat/completions` | `Bearer` |

**Gemini 走官方 OpenAI 兼容层**（`/v1beta/openai`），不写原生 `generateContent`：
兼容层支持 tools / 图片 / 流式 / `reasoning_effort`，官方文档给了
`reasoning_effort → thinking_level` 的映射表。原生协议要另外维护 content parts
与 `thoughtSignature` 回传，收益不抵成本。

**Anthropic 必须带两个头**，否则浏览器直连会被拒：

```
anthropic-version: 2023-06-01
anthropic-dangerous-direct-browser-access: true
```

---

## 2. 浏览器直连

| 情况 | 结论 | 依据 |
|---|---|---|
| OpenAI 官方端点 | **拒绝**带 `Origin` 的请求 | 官方行为；只走 `/__llm` 代理 |
| Anthropic | 带 `anthropic-dangerous-direct-browser-access: true` 可直连 | 官方 CORS 开关 |
| Gemini / OpenRouter | 可直连 | CORS 开放 |
| DeepSeek | 实测被拦 | 现有实现的来源 |
| 其余 11 家 | **未实测** | 策略是「先直连，首字节前失败才退化代理」 |

`transport.browserDirect` 的语义是「**先试直连**」而不是「禁止直连」。未实测的不要
写成 `false` —— 那会把本来可用的直连路径无谓地砍掉，而且用户看到的是「多转一手」。

代理（`scripts/llm-proxy.mjs`）挂在三个宿主上 —— dev、preview 与 npm 版的本地服务
（`server/serve.mjs`，路由表读生成的 `server/llm-routes.json`）。路径
`/__llm/<providerId>/<端点>`，转发目标取自注册表、**不接受请求里带的 URL**。
纯静态部署没有这条路由。

---

## 3. 思考参数的五种形态

| style | 请求参数 | 使用者 |
|---|---|---|
| `deepseek` | `thinking:{type}` + `reasoning_effort:'low'\|'high'\|'max'` | DeepSeek |
| `toggle` | `thinking:{type:'enabled'\|'disabled'}` | 智谱、Kimi、豆包、混元、千帆 |
| `budget` | `enable_thinking:bool` + `thinking_budget:int` | 通义千问、硅基流动 |
| `effort` | `reasoning_effort:'minimal'\|'low'\|'medium'\|'high'` | OpenAI、Gemini、阶跃、MiniMax、xAI |
| `openrouter` | `reasoning:{effort}` | OpenRouter |
| `anthropic` | `thinking:{type:'enabled',budget_tokens:N}` | Anthropic |

UI 只有四档 `off / low / high / max`，映射集中在
`providers/reasoning.ts::thinkingParamsFor`。OpenAI 与 Gemini 没有 `max` 档
（落到 `high`），`off` 是「不发这个参数」而不是发 `none`。

**关不掉思考的模型**（传 `disabled` = 400）：`glm-5.3` / `glm-5.3-flash`、
`MiniMax-M3.x`。这是**模型级**属性，写在 `ModelRule.alwaysThinking` 上 ——
同一家既有能关的模型也有关不掉的。

---

## 4. 思维链：读哪个字段、要不要回传

| 读的字段 | 使用者 |
|---|---|
| `delta.reasoning_content` | DeepSeek、通义千问、智谱、Kimi、豆包、千帆、MiniMax、硅基流动、阶跃、xAI |
| `delta.reasoning` | Groq；OpenRouter 的旧字段 |
| `delta.reasoning_details[]` | OpenRouter 新格式（带 `format` / `signature`） |
| `thinking` / `redacted_thinking` 块 | Anthropic |
| 无 | OpenAI 官方 chat completions、Gemini 兼容层 |

| `echo` | 谁 | 漏了会怎样 |
|---|---|---|
| `required` | DeepSeek、Anthropic | **400**。DeepSeek 带 tools 时每轮都要带 `reasoning_content`（没有就空串）；Anthropic 的 thinking 块必须连 `signature` 原样回传，且 `redacted_thinking` 只有 `data` 没有 signature |
| `optional` | 豆包、Kimi、阶跃、MiniMax、OpenRouter | 不报错，丢推理连续性 |
| `never` | 智谱（官方明确不回传）、通义千问（`preserve_thinking` 默认 false）、OpenAI、Gemini | 回了可能 400 或多花 input token |

Anthropic 的 `thinking` 块**必须整段复用**，不能重建：重建会丢 signature、
把块序排错，两种都是 400 —— 而且**第一轮完全正常，用到工具的第二轮才炸**。

---

## 5. 请求体字段差异

| 项 | 差异 |
|---|---|
| 输出上限 | `max_tokens`（多数）/ `max_completion_tokens`（OpenAI o1/o3/o4/gpt-5、MiniMax） |
| `stream_options.include_usage` | 部分服务不支持 → **400 而不是忽略**，必须 per-provider 开关 |
| `temperature` | 推理模型只接受默认值（不发）或只接受 1，`ModelRule.temperature` 三态 |
| `max_tokens` 必填 | 仅 Anthropic，且必须 **大于** `budget_tokens`（否则 400，错误体是 `thinking.budget_tokens`，用户看不懂） |
| `role:'tool'` 的 `name` | 少数兼容层硬要求；历史里没存函数名，序列化时从前一条 assistant 的 `tool_calls` 找回（`compat.requiresToolResultName`） |
| tool 与 user 之间的 assistant | 少数兼容层要求隔一条空 assistant（`compat.requiresAssistantAfterToolResult`） |
| 固定查询串 / 路径里的部署名 | Azure：`query` + `endpointPath` 的 `{model}` 占位（见 §9.4） |

---

## 6. 错误体与状态码

认四种形状：

```
{"error": {"message", "code", "type"}}     OpenAI / DeepSeek / Anthropic
{"code", "msg"} 或 {"message", "code"}      扁平
{"error_code": 17, "error_msg": "..."}      百度千帆老接口（码是数字）
{"base_resp": {"status_code", "status_msg"}} MiniMax 老接口
```

判定**先看错误体再看状态码**：

- 余额不足不只有 402。OpenAI 是 `429 + insufficient_quota`，腾讯/百度用
  `Arrearage` / `账户余额`。只看状态码会把它们归成 `rate-limit`，
  用户于是反复重试，真正的原因永远不暴露。
- **上下文超限单独归 `context`**。普通 400 的处理是「清空模型历史」（逃离被污染
  的历史），而上下文超限只是装不下 —— 清空等于把用户的会话删了。

---

## 7. 上下文缓存（2026-10 核实官方文档）

前缀缓存直接决定成本：一次多轮对话里，输入 token 通常是主要开销，而命中价
往往是原价的 10%–50%。各家的机制**不一样**，但只有一条共同前提：**前缀逐字节相同**。

| 家 | 开启方式 | 命中口径 | 最小前缀 | 有效期 | 命中价 |
|---|---|---|---|---|---|
| DeepSeek | 默认开，零代码 | `prompt_cache_hit_tokens` / `prompt_cache_miss_tokens` | 文档未给数字 | 数小时到数天（闲置清理） | 官方价格页 |
| 通义（百炼） | 隐式默认开；显式需 `cache_control` | `prompt_tokens_details.cached_tokens`（部分模型在顶层 `cached_tokens`） | 1024（智谱/MiniMax 部署为 512） | 隐式无固定；显式 5 分钟（命中续期） | 隐式约 20%，显式 10% |
| 智谱 GLM | 隐式，无法配置 | `prompt_tokens_details.cached_tokens` | 建议 ≥500（非硬门槛） | 文档未提 | 约 50% |
| Kimi | 隐式；`prompt_cache_options` 可调 TTL | `prompt_tokens_details.cached_tokens`（+ `cache_write_tokens`） | 按块存储，不足一块不写 | 5m / 1h（首次写入锁定） | 1/10 |
| Anthropic | **必须显式 `cache_control` 断点** | `cache_read_input_tokens` / `cache_creation_input_tokens` | 1024 起（Sonnet 一族） | 5 分钟（命中续期） | 10%（写入 125%） |

三条必须记住的差异：

1. **「自动」不等于「一定命中」**：DeepSeek 明说「尽力而为」，阿里说「达到 1024
   只代表具备条件」。所以命中率是**观测量**，不能当成契约去断言。
2. **Anthropic 是唯一一家不打标记就完全没缓存的**。断点打在最后一个 user 回合的
   最后一个可缓存块（`markCacheBreakpoint`），每轮往后移；历史消息不带标记，
   它们的字节因此不变，旧缓存照样命中。
3. **Anthropic 的 `input_tokens` 不含缓存读写**（其余各家 `prompt_tokens` 含），
   分母必须分开算 —— `llm/usage.ts` 是唯一归一的地方。

### 本项目的实现约束

- **系统提示是常量**。播放头 / 选区 / 用户标注一律贴在**最后一条 user 消息**尾部
  （`agent/context.ts`）。曾经把播放头拼进 `messages[0]`，代价是每轮整段历史按未命中计费。
- **工具表、消息顺序、拼装顺序都不许按请求变化**（`openai.ts` 的键序是契约）。
- 压缩（`maybeCompact`）与硬裁剪（`trimMessages`）会重写历史 = 缓存清零。它们是
  兜底手段，不是优化手段；不要在 75% 以下主动压缩。
- 面板在轮末显示命中率（`turn-end.cache`）。**没上报**（老模型 / 自建服务）时
  什么都不显示 —— 不要用 0% 冒充「没有这项数据」。

## 8. 待实测

以下项没有官方文档或文档与实现不一致，代码里按保守值处理，实测之后再改注册表：

1. 11 家国产端点的 **CORS 行为**（目前一律「先直连再退化代理」）。
2. 豆包 / 混元 / 千帆 / 星火的**思考开关字段名**（现按 `toggle` 处理）。
3. 阶跃 / xAI 的**思维链字段**（现按 `reasoning_content` 读，xAI 可能不返回）。
4. MiniMax 的 `max_completion_tokens`（现按该字段发）。
5. Kimi 的 `thinking` 开关（旧模型不接受，新模型需要）。
6. 各家 `stream_options` 的支持情况（现按支持处理，除已注明者）。
7. **模型预设会腐烂**：`models` 只是省打字的建议，UI 允许手填任意模型名。
   别名（`qwen-plus` / `kimi-latest`）会随服务端前移，快照名会过期，两者都不该
   被当成契约。

---

## 9. 方言 / 端点 / 分流（2026-11 接入）

前八节记的是「哪一家有什么结论」。这一节记**这些结论现在存在哪、怎么生效** ——
因为加第 N 家时最容易犯的错不是不知道结论，而是把它写进了适配器的 `if`。

### 9.1 三个解析点（都在 `providers/`，全是纯函数）

| 文件 | 负责 | 不变量 |
|---|---|---|
| `compat.ts` | 请求体方言：字段名、开关、兼容怪癖 | 默认 → **自填端点的**嗅探 → provider → model |
| `endpoint.ts` | 端点（`{model}` 模板 + `query`）、鉴权头、头部叠加 | 适配器默认 → provider → model；`null` 删头 |
| `routing.ts` | 这个模型走哪个协议、用哪份 `thinking` 策略 | 模型规则优先，缺省跟随 provider |

**嗅探只对自填端点生效**（`endpointIsCustom()`）。官方端点的结论是实测出来的，
让主机名猜测去覆盖它等于把实测降级成猜。`custom` / Azure / 网关的 `baseUrl`
是用户填的，所以它们才需要嗅探。

### 9.2 `compat` 的键与「不写会怎样」

| 键 | 默认 | 谁会偏离 | 写错的后果 |
|---|---|---|---|
| `maxTokensField` | `max_tokens` | OpenAI o/gpt-5、MiniMax、Azure | 400（字段不认识） |
| `streamUsage` | `true` | 少数兼容层 | 400（不是忽略） |
| `supportsReasoningEffort` | `true` | xAI / 智谱 / Together / NVIDIA 系 | 开了思考才 400 |
| `requiresToolResultName` | `false` | 部分 one-api 类网关 | 工具结果被忽略或 400 |
| `requiresAssistantAfterToolResult` | `false` | 少数兼容层 | 第二轮起 400 |
| `temperature` | `send` | 推理模型（`omit` / `one`） | 400 或参数被拒 |

`thinking.style / field / echo` 仍是独立的一份（见 §3 / §4）：它描述的是**协议
形态**，不属于「OpenAI 兼容层的方言」。

### 9.3 鉴权与头部

```ts
auth: 'bearer' | 'anthropic' | { header: 'api-key' | 'cf-aig-authorization', scheme?: 'bearer' | 'raw' }
```

- Azure OpenAI：`{ header: 'api-key' }`（raw，不加 `Bearer`）
- Cloudflare AI Gateway：`{ header: 'cf-aig-authorization', scheme: 'bearer' }`，
  并且 `headers: { Authorization: null }` —— 网关只认自己的头，把平台 key 混进
  上游 `Authorization` 会让上游按「无效厂商 key」拒绝。

### 9.4 端点模板与按模型分流

- `endpointPath` 支持 `{model}`：Azure 是 `/openai/deployments/{model}/chat/completions`，
  `query: { 'api-version': '2024-10-21' }`；模型框里填**部署名**。
- `ModelRule.protocol / pathPrefix / endpointPath / thinking` 让一个 baseUrl
  下并存多条上游通道。目前只有 Cloudflare AI Gateway 用到：

| 模型前缀 | 协议 | 端点 |
|---|---|---|
| `anthropic/` | `anthropic` | `/anthropic/v1/messages` |
| `openai/` | `openai` | `/openai/v1/chat/completions` |
| `workers-ai/` | `openai` | `/compat/chat/completions` |

这两家（`azure` / `cloudflare`）**只验证了请求形状，没有真 key 实测**：
按 §8 的惯例，结论先按文档写，实测之后再改注册表与本节。

### 9.5 厂商独有参数

`ProviderDef.body` → `ModelRule.body` → `LlmConfig.extraBody`，后者覆盖前者，
**三者都空时一个键都不加**（DeepSeek 的 golden 字节基线靠这条）。它只接
注册表能声明的东西；一次性的试验参数（`top_k` / `min_p` / 网关路由偏好）才走
`extraBody`，不要拿它绕开 `compat`。

### 9.6 新增一家到底改几处

1. `providers/ids.ts`：id（同时是代理路径段 / localStorage 键 / i18n 键段）；
2. `providers/registry.ts`：一条 `ProviderDef`（端点、鉴权、模型、思考、方言）；
3. `src/assets/providers/<id>.svg` + `agent.provider.<id>` 文案；
4. 若 `baseUrl` 由用户填：`baseUrlRequired: true` + `transport.proxy: false`；
5. 若与已有结论不同：优先写 `compat` / `ModelRule`，**不要**动适配器；
6. 跑 `tests/unit/agent-providers.test.ts`（守卫）+ `agent-provider-compat.test.ts`（胶水）；
7. 改了代理白名单才需要 `pnpm run gen:llm-routes`（Azure / 网关不进白名单）。
