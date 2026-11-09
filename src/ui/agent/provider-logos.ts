/**
 * provider-logos.ts — 提供商的品牌图（18 张）。
 *
 * 素材来自 Lobe Icons（`@lobehub/icons-static-svg`）：每个品牌有 `{id}.svg`
 * 单色版与 `{id}-color.svg` 彩色版。打包进 `src/assets/providers/`、用
 * `import.meta.glob` 取 URL —— 同步可得，组件里不需要「加载中」状态。
 *
 * ## 为什么两种渲染方式
 *
 * `img`（默认）—— 直接贴彩色 SVG。品牌色在明暗两种主题下都看得见，识别度最高。
 *
 * `mask` —— 单色字形用 CSS 蒙版 + `currentColor`。这批品牌的**品牌色就是黑**
 * （OpenAI、Anthropic、xAI、Kimi 的 mark 本来就是黑的），贴彩色在暗色主题里
 * 是一块看不见的黑斑；OpenRouter 反过来是荧光绿 `#C8FF00`，在白底上几乎看不见。
 * 这五家一律走蒙版，跟着前景色走。
 *
 * 文件名 = provider id，由 `tests/unit/agent-providers.test.ts` 的守卫钉住；
 * 只有「自定义」没有品牌可画，面板回落到首字母方块。
 */

export type LogoMode = 'mask' | 'img';

export interface ProviderLogo {
  url: string;
  mode: LogoMode;
}

const SVG = import.meta.glob('../../assets/providers/*.svg', {
  eager: true,
  query: '?url',
  import: 'default',
}) as Record<string, string>;

/**
 * 只能靠蒙版跟随主题的那几家。
 *
 * 判据不是「有没有彩色版」，而是**在两种主题下都看得见**：补图标时先看彩色版的
 * `fill`，接近 `#000` 或亮到压不住白底，就别用 `<img>`。
 */
const MONO_LOGOS = new Set(['kimi', 'openai', 'anthropic', 'openrouter', 'xai']);

function idOf(path: string): string {
  return path.replace(/^.*\//, '').replace(/\.\w+$/, '');
}

function build(): Record<string, ProviderLogo> {
  const out: Record<string, ProviderLogo> = {};
  for (const [path, url] of Object.entries(SVG)) {
    const id = idOf(path);
    out[id] = { url, mode: MONO_LOGOS.has(id) ? 'mask' : 'img' };
  }
  return out;
}

export const PROVIDER_LOGOS: Record<string, ProviderLogo> = build();

export function providerLogo(id: string): ProviderLogo | null {
  return PROVIDER_LOGOS[id] ?? null;
}
