/**
 * providers/ids.ts — 提供商 id 的**唯一清单**。
 *
 * 单独一个文件、零 import：`registry` / `protocol` / UI / 代理路由表都要用它，
 * 谁都不该为了拿一个字符串联合去拖整张注册表（那会把工具说明与模型列表
 * 一起拉进 `/lab/` 之类的入口）。
 *
 * id 同时承担三个身份，改名的代价是三处：
 *   1. 代理路径段 `/__llm/<id>/...`
 *   2. `localStorage` 里 `overrides` 的键
 *   3. i18n 键 `agent.provider.<id>`
 * 所以格式被单测钉成 `/^[a-z0-9-]+$/`。
 */

export type ProviderId =
  /* 国内 */
  | 'deepseek'
  | 'dashscope' // 阿里云百炼 / 通义千问
  | 'zhipu' // 智谱 GLM
  | 'kimi' // 月之暗面
  | 'doubao' // 字节火山方舟
  | 'hunyuan' // 腾讯混元
  | 'qianfan' // 百度千帆 / 文心
  | 'spark' // 讯飞星火
  | 'stepfun' // 阶跃星辰
  | 'minimax'
  | 'siliconflow' // 硅基流动
  /* 国外 */
  | 'openai'
  | 'anthropic'
  | 'gemini'
  | 'openrouter'
  | 'xai'
  /* 网关 / 云 */
  | 'azure'
  | 'cloudflare'
  /* 兜底 */
  | 'custom';
