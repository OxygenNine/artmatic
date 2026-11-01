/**
 * npm 版运行时（`server/serve.mjs`）的路径解析。
 *
 * 这里测的是**发布版唯一会做错的地方**：`/lab` 的尾斜杠、缺资源不回落 HTML、
 * 路径穿越。它们全都「不报错、只是看起来能用」—— 与 `vite preview` 的差异
 * 只会在用户机器上暴露，所以钉在这里。
 */
import { describe, expect, it } from 'vitest';
import { fileURLToPath } from 'node:url';
import { DEFAULT_PORT, mimeFor, resolveFile, routePath } from '../../server/serve.mjs';

const REPO_ROOT = fileURLToPath(new URL('../..', import.meta.url));

describe('mimeFor', () => {
  it('wasm 必须是 application/wasm（HarfBuzz 的流式实例化只认它）', () => {
    expect(mimeFor('/x/app-abc.wasm')).toBe('application/wasm');
    expect(mimeFor('APP.WASM')).toBe('application/wasm');
  });

  it('常见资源类型', () => {
    expect(mimeFor('index.html')).toBe('text/html; charset=utf-8');
    expect(mimeFor('a.mjs')).toBe('text/javascript; charset=utf-8');
    expect(mimeFor('f.woff2')).toBe('font/woff2');
    expect(mimeFor('t.ttf')).toBe('font/ttf');
    expect(mimeFor('i.webp')).toBe('image/webp');
  });

  it('未知扩展名退到 octet-stream（不是空字符串）', () => {
    expect(mimeFor('a.zzz')).toBe('application/octet-stream');
    expect(mimeFor('noext')).toBe('application/octet-stream');
  });
});

describe('routePath', () => {
  it('/lab 补尾斜杠：不补的话 SPA 回落会端出**主应用**', () => {
    expect(routePath('/lab')).toEqual({ kind: 'redirect', location: '/lab/' });
    expect(routePath('/lab/')).toEqual({ kind: 'file', path: '/lab/index.html' });
  });

  it('/ 与带扩展名的路径直接找文件', () => {
    expect(routePath('/')).toEqual({ kind: 'file', path: '/index.html' });
    expect(routePath('/assets/app-abc.js')).toEqual({ kind: 'file', path: '/assets/app-abc.js' });
  });

  it('没有扩展名 → SPA 回落；有扩展名绝不回落（否则 import 拿到 HTML）', () => {
    expect(routePath('/some/page')).toEqual({ kind: 'fallback' });
    expect(routePath('/assets/missing.js')).toEqual({ kind: 'file', path: '/assets/missing.js' });
  });
});

describe('resolveFile', () => {
  it('真实文件能解析，目录不算文件', () => {
    expect(resolveFile(REPO_ROOT, '/README.md')).toBeTruthy();
    expect(resolveFile(REPO_ROOT, '/src')).toBeNull();
    expect(resolveFile(REPO_ROOT, '/nope.md')).toBeNull();
  });

  it('路径穿越（含编码过的 ..%2f）一律 null', () => {
    expect(resolveFile(REPO_ROOT, '/..%2fREADME.md')).toBeNull();
    expect(resolveFile(REPO_ROOT, '/../../etc/passwd')).toBeNull();
    expect(resolveFile(REPO_ROOT, '/%00')).toBeNull();
    // 坏编码（不完整的多字节序列）不能抛异常，只能当没有
    expect(resolveFile(REPO_ROOT, '/%E4%B8')).toBeNull();
  });
});

describe('DEFAULT_PORT', () => {
  it('不占 5173 / 4173（那两个是 dev 与 preview 的）', () => {
    expect(DEFAULT_PORT).not.toBe(5173);
    expect(DEFAULT_PORT).not.toBe(4173);
  });
});
