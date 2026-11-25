import { defineConfig } from 'astro/config';
import starlight from '@astrojs/starlight';
import svelte from '@astrojs/svelte';

/*
 * `BASE_PATH` 由部署方注入（GitHub Actions 的 configure-pages 输出）：
 *   project site（oxygennine.github.io/artmatic）→ `/artmatic`
 *   自定义域名                                  → `/`
 * 本地不设，落到 `/`，和生产同一套路径假设 —— 这样「本地好、线上白屏」不会发生。
 * Vite 要求 base 带尾斜杠，写成 `(x || '') + '/'` 在自定义域名下会得到 `//`。
 */
const rawBase = process.env.BASE_PATH ?? '';
const base = rawBase && rawBase !== '/' ? `${rawBase.replace(/\/+$/, '')}/` : '/';

export default defineConfig({
  site: process.env.SITE_URL ?? 'https://oxygennine.github.io',
  base,
  outDir: './dist',
  trailingSlash: 'ignore',
  devToolbar: { enabled: false },
  integrations: [
    svelte(),
    starlight({
      title: 'Artmatic',
      description: 'Artmatic 是一款面向算法艺术与故障艺术的 Web 原生开源剪辑软件。',
      // 单语言站，但要让 <html lang> 与 Starlight 自身的中文 UI 文案生效
      locales: { root: { label: '简体中文', lang: 'zh-CN' } },
      titleDelimiter: '·',
      customCss: [
        './src/fonts/font-face.css',
        './src/styles/tokens.css',
        './src/styles/theme.css',
        './src/styles/site.css',
      ],
      social: [
        { icon: 'github', label: 'GitHub', href: 'https://github.com/OxygenNine/artmatic' },
      ],
      expressiveCode: { themes: ['github-light', 'github-dark'] },
      // 只能用 autogenerate：手写 slug 指向不存在的文件会让构建硬失败，
      // 而 autogenerate 对一个还空着的目录是静默的 —— 生成物缺失由
      // scripts/check-content.mjs 拦，那是唯一能让它变红的地方。
      sidebar: [
        { label: '使用指南', items: [{ autogenerate: { directory: 'guide' } }] },
        { label: '开发手册', items: [{ autogenerate: { directory: 'dev' } }] },
        {
          label: 'API',
          items: [
            { label: 'core', items: [{ autogenerate: { directory: 'api/core' } }] },
            { label: 'agent', items: [{ autogenerate: { directory: 'api/agent' } }] },
          ],
        },
      ],
      components: {
        Header: './src/components/Header.astro',
      },
      credits: false,
      pagefind: true,
      tableOfContents: { minHeadingLevel: 2, maxHeadingLevel: 3 },
      editLink: { baseUrl: 'https://github.com/OxygenNine/artmatic/edit/main/site/' },
    }),
  ],
});
