/**
 * capacity-profile.ts — 启动时把「机器能力」灌进容量策略（装配层，不在 core）。
 *
 * 分工（三条都不许越界）：
 *  - **测量**在 Node（`scripts/capacity.mjs`）：`os.freemem()` + 显存探测；
 *  - **策略**在 `core/capacity.ts`：比例、夹取、默认值（纯函数，可单测）；
 *  - **装配**在这里：什么时候问、问不到怎么办、通知谁。
 *
 * ## 为什么是「起了不等」
 *
 * 消费者读的是 `getLimits()`（用到时才读，不缓存在字段里），所以探测结果
 * **晚到也照样生效**：池子下一次取用就按新预算淘汰。既然如此，就绝不该让
 * 启动等它 —— 一次 `nvidia-smi` 的 spawn 在冷启动时可能要几百毫秒，
 * 而那几百毫秒是用户盯着空画布的时间。
 *
 * ## 探测不到时**什么都不做**
 *
 * 不猜、不估算、不用 `navigator.deviceMemory` 凑一个数：`DEFAULT_LIMITS`
 * 就是「改造之前的行为」，保持不动即是不回归。宁可要「没赚到」，不要
 * 「猜错了把画质或稳定性搭进去」。
 */

import {
  applyMachine,
  currentCapacity,
  resetCapacity,
  setLimits,
  type CapacityLimits,
  type CapacitySnapshot,
} from '../core/capacity';
import { platform } from '../platform/index';

let loading: Promise<CapacitySnapshot> | null = null;

/**
 * 问一次机器能力并写进策略。幂等：并发调用共用同一个 promise。
 *
 * @returns 生效后的快照（探测失败时就是保守默认）。
 */
export function loadCapacityProfile(): Promise<CapacitySnapshot> {
  loading ??= (async () => {
    const probed = await platform.probeCapacity();
    if (!probed) {
      // 纯静态部署 / 探测失败：保持默认，**不报错**（这条路径是可缺的）。
      console.info('[capacity] 拿不到宿主机器能力，使用保守默认预算');
      return currentCapacity();
    }
    applyMachine(probed.machine, probed.overrides ?? undefined);
    const snap = currentCapacity();
    const l = snap.limits;
    console.info(
      `[capacity] 来源 ${snap.source}｜内存 ${probed.machine.freeRamMB}/${probed.machine.totalRamMB} MB` +
        `｜显存 ${probed.machine.vramMB ?? '未知'} MB` +
        `｜预算：视频 ${l.videoTextureMB} MB、排版 ${l.textRasterMB} MB、` +
        `特效池 ${l.effectPoolMB} MB、调色 ${l.gradeTargetMB} MB、模拟 ${l.simStateMB} MB、` +
        `导出内存 ${l.exportMemoryMB} MB、撤销 ${l.undoSteps} 步`,
    );
    return snap;
  })();
  return loading;
}

/** 测试 / 诊断用：强制写入一份预算（`__artmatic.capacity.set`）。 */
export function overrideLimits(patch: Partial<CapacityLimits>): CapacitySnapshot {
  setLimits(patch, 'override');
  return currentCapacity();
}

export { currentCapacity, resetCapacity };
