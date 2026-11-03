/**
 * platform/electron.ts — 桌面宿主实现（preload bridge → 主进程）。
 *
 * 只覆盖**浏览器做不到的三件事**：
 *   1. 原生文件选择器给真实路径（不是 FSA 句柄）；
 *   2. 按范围读（视频 seek / 指纹，几 GB 不整份进堆）；
 *   3. 源文件监视。
 *
 * 其余（保存 / 下载 / 剪贴板 / FSA）直接复用 `browserPlatform`：
 * Electron 里这些 Web API 都在，另写一份只会让两个宿主慢慢分叉。
 *
 * 例外是 `probeCapacity()`：浏览器版 fetch `/__capacity.json`，那是 dev / preview
 * 服务端的路由，`app://` 下不存在 —— 不覆盖就会静默退回保守默认预算。
 */

import { browserPlatform } from './browser';
import type { MachineCapacity } from '../core/capacity';
import type { NodeFs, PickedLinked, Platform, ShellActions } from './types';

/** `desktop/preload.cjs` 暴露的形状。页面只认这一份。 */
export interface ElectronHostBridge {
  pickLinked(kind: 'audio' | 'image' | 'video'): Promise<{
    path: string;
    name: string;
    size: number;
    mtime?: number;
  } | null>;
  readFile(path: string): Promise<Uint8Array>;
  readRange(path: string, start: number, end: number): Promise<Uint8Array>;
  stat(path: string): Promise<{ size: number; mtime: number } | null>;
  pathForFile(file: File): string | null;
  pickArchive(): Promise<{ path: string; name: string; size: number } | null>;
  watch(paths: string[]): Promise<number>;
  unwatch(): Promise<boolean>;
  onAssetChanged(cb: (path: string) => void): () => void;
  showInFolder(path: string): Promise<void>;
  capacity(): Promise<{
    machine: MachineCapacity;
    overrides: Partial<Record<string, number>> | null;
  } | null>;
  /**
   * 窗口级动作。**可选**：旧壳（没接这组 IPC）上不存在，
   * 界面据此不显示「桌面」页，而不是画三个按了没反应的按钮。
   */
  shell?: ShellActions;
  /**
   * 本机路径文件系统。同样是**可选**：旧壳没有这组 IPC 时，工程目录继续走
   * FSA（能读写、但定位不到、删不干净），界面按它是否存在决定走哪条路。
   */
  fs?: NodeFs;
}

const MIME: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
  gif: 'image/gif',
  avif: 'image/avif',
  mp3: 'audio/mpeg',
  wav: 'audio/wav',
  ogg: 'audio/ogg',
  m4a: 'audio/mp4',
  flac: 'audio/flac',
  mp4: 'video/mp4',
  m4v: 'video/mp4',
  mov: 'video/quicktime',
  webm: 'video/webm',
  mkv: 'video/x-matroska',
};

function mimeOf(name: string): string {
  const ext = name.slice(name.lastIndexOf('.') + 1).toLowerCase();
  return MIME[ext] ?? 'application/octet-stream';
}

export function createElectronPlatform(host: ElectronHostBridge): Platform {
  return {
    ...browserPlatform,
    supportsLinked: true,

    async pickLinkedFile(kind): Promise<PickedLinked | null> {
      const picked = await host.pickLinked(kind);
      if (!picked) return null;
      /*
       * 视频只给路径：`File` 需要字节，而桌面版的全部意义就是**不读**。
       * 图片 / 音频本来就要整份喂解码器，读一份 `File` 是合理的。
       */
      if (kind === 'video') {
        return {
          kind,
          name: picked.name,
          file: null,
          handle: null,
          path: picked.path,
          size: picked.size,
        };
      }
      const bytes = await host.readFile(picked.path);
      return {
        kind,
        name: picked.name,
        file: new File([bytes as unknown as BlobPart], picked.name, {
          type: mimeOf(picked.name),
        }),
        handle: null,
        path: picked.path,
        size: picked.size,
      };
    },

    readPath: (path, start, end) => host.readRange(path, start, end),
    readFileAt: (path) => host.readFile(path),
    statPath: (path) => host.stat(path),
    pathForFile: (file) => host.pathForFile(file),

    /**
     * 机器事实由主进程量（`os.totalmem/freemem` + 显卡探测），不走 HTTP。
     * 拿不到就返回 null —— 上层退回 `DEFAULT_LIMITS`，与浏览器版同一条兜底。
     */
    async probeCapacity() {
      try {
        const c = await host.capacity();
        return c?.machine ? c : null;
      } catch {
        return null;
      }
    },

    watchPaths(paths, onChange) {
      void host.watch([...paths]);
      const off = host.onAssetChanged(onChange);
      return () => {
        off();
        void host.unwatch();
      };
    },

    showInFolder: (path) => {
      void host.showInFolder(path);
    },

    // 窗口能力只有主进程有；旧壳拿不到就不给这个键（界面自动降级）。
    ...(host.shell ? { shell: host.shell } : {}),
    // 本机路径文件系统同理：旧壳没有它时，工程目录继续用 FSA。
    ...(host.fs ? { fs: host.fs } : {}),
  };
}
