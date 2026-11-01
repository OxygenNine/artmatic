/**
 * serve.mjs 的类型声明。
 *
 * 与 `scripts/capacity.d.mts` 同一个手法：服务本体保持零依赖 ESM（npm 包直接跑），
 * 声明文件只为了让 `tests/unit` 能 import 它的纯函数。
 */

export type Route =
  | { kind: 'file'; path: string }
  | { kind: 'redirect'; location: string }
  | { kind: 'fallback' };

export interface ServerInfo {
  port: number;
  host: string;
  /** 展示用地址（`0.0.0.0` 绑定时固定写 localhost）。 */
  origin: string;
  url: string;
  loopback: boolean;
  close: () => Promise<void>;
}

export declare const DEFAULT_PORT: number;

/** 扩展名 → Content-Type（`.wasm` 必须是 `application/wasm`）。 */
export declare function mimeFor(file: string): string;

/** 请求路径 → 动作。纯函数，不碰磁盘。 */
export declare function routePath(pathname: string): Route;

/** URL 路径 → 磁盘绝对路径；不存在 / 越界 / 坏编码返回 null。 */
export declare function resolveFile(root: string, urlPath: string): string | null;

export declare function startServer(opts: {
  root: string;
  host?: string;
  port?: number;
  /** 覆盖文件路径（`/__capacity.json` 用）；不给就退化到 `scripts/capacity.mjs` 的默认。 */
  configPath?: string;
}): Promise<ServerInfo>;
