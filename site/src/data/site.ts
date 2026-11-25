export const GITHUB = 'https://github.com/OxygenNine/artmatic';

/** `BASE_URL` 一定以 `/` 结尾；拼完不会出现 `//`，也不依赖部署在域名根。 */
export function url(path: string): string {
  const base = import.meta.env.BASE_URL.replace(/\/$/, '');
  return `${base}${path.startsWith('/') ? path : `/${path}`}`;
}

/** 顶栏的三个入口。文档根落 `/guide/`，新闻暂时是占位页。 */
export const LINKS = [
  { label: '主页', href: '/' },
  { label: '文档', href: '/guide/' },
  { label: '新闻', href: '/news/' },
] as const;

/** 下载入口。版本号与体积由 gen-stats 汇总，这里只放地址与名称。 */
export const DOWNLOAD = {
  version: 'v0.3.0',
  size: '142MB',
  url: `${GITHUB}/releases`,
  label: 'Windows 便携版',
} as const;
