/**
 * capacity.mjs 的类型声明。
 *
 * 为什么手写而不是把脚本改成 TS：这个文件是**服务端 Node 脚本**（要 spawn
 * `nvidia-smi` / `reg query`），而 `vite.config.ts` 用动态 `import()` 引它 ——
 * Vite 的配置加载器会把它当外部模块处理，声明文件是让 TS 认账的最轻做法。
 *
 * 机器事实的类型与页面共用（`src/core/capacity.ts`），所以两边不会漂。
 */

import type { MachineCapacity } from '../src/core/capacity';

/** 覆盖文件的默认位置（可用 `ARTMATIC_CAPACITY` 环境变量指定）。 */
export declare const CAPACITY_FILE: string;

/** 探测显存；全部手段都失败时返回 null。 */
export declare function probeVram(): Promise<{
  vramMB: number;
  freeVramMB: number | null;
  source: string;
} | null>;

/** 探测整机（内存一定有值，显存可以是 null）。 */
export declare function probeMachine(): Promise<MachineCapacity>;

/** 读覆盖文件；不存在 / 坏 JSON 都当没有（不抛）。 */
export declare function readOverrides(path?: string): {
  path: string;
  machine: Partial<MachineCapacity> | null;
  limits: Partial<Record<string, number>> | null;
};

/**
 * 服务端交给页面的那一份：`{ machine, overrides }`（见 `__capacity.json`）。
 *
 * `configPath` 显式给时覆盖文件从那儿读 —— npm 版（`server/serve.mjs`）传用户 cwd。
 */
export declare function capacityPayload(configPath?: string): Promise<{
  machine: MachineCapacity;
  overrides: Partial<Record<string, number>> | null;
  configPath: string;
  configFound: boolean;
}>;
