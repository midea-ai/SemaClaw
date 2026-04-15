/**
 * GroupQueue — 群组消息串行化 + 全局并发控制
 *
 * 设计：
 *   - 同一群组严格串行：前一条处理完才处理下一条
 *   - 全局并发上限（MAX_CONCURRENT_AGENTS）：防止 API 过载
 *   - 新任务到达时：若群组未在运行则立即启动 drain；否则入队等待
 */

import { config } from '../config';

type Task = () => Promise<void>;

/** 单个 jid 最大排队任务数，防止洪泛导致内存溢出 */
const MAX_QUEUE_PER_JID = 50;

export class GroupQueue {
  /** jid → 等待执行的任务队列 */
  private queues = new Map<string, Task[]>();

  /** 当前正在 drain 的 jid 集合 */
  private running = new Set<string>();

  /** 当前全局并发数 */
  private globalActive = 0;
  private readonly maxConcurrent: number;

  /** 等待全局并发槽的 resolve 回调 */
  private slotWaiters: Array<() => void> = [];

  constructor(maxConcurrent = config.agent.maxConcurrent) {
    this.maxConcurrent = maxConcurrent;
  }

  /**
   * 向指定群组的队列追加任务。
   * 若群组当前无任务正在处理，立即触发 drain。
   */
  enqueue(jid: string, task: Task): boolean {
    if (!this.queues.has(jid)) this.queues.set(jid, []);
    const q = this.queues.get(jid)!;
    if (q.length >= MAX_QUEUE_PER_JID) {
      console.warn(`[GroupQueue] Queue overflow for ${jid} (max=${MAX_QUEUE_PER_JID}), dropping task`);
      return false;
    }
    q.push(task);

    if (!this.running.has(jid)) {
      this.drain(jid).catch((err) =>
        console.error(`[GroupQueue] drain error for ${jid}:`, err)
      );
    }
    return true;
  }

  /**
   * 持续执行某群组队列中的所有任务，直到队列清空。
   * 获取全局并发槽后才开始执行，处理完所有任务后释放槽。
   */
  private async drain(jid: string): Promise<void> {
    const queue = this.queues.get(jid);
    if (!queue || queue.length === 0) return;

    // 必须在第一个 await 之前标记，防止 acquireSlot yield 期间
    // 新消息入队时误判 running 为空而重复启动 drain
    this.running.add(jid);
    await this.acquireSlot(jid);

    while (true) {
      const q = this.queues.get(jid)!;
      if (q.length === 0) break;

      const task = q.shift()!;
      try {
        await task();
      } catch (err) {
        console.error(`[GroupQueue] Task error for ${jid}:`, err);
      }
    }

    this.running.delete(jid);
    this.releaseSlot(jid);

    // 检查在最后一个任务执行期间是否有新任务入队
    const remaining = this.queues.get(jid);
    if (remaining && remaining.length > 0) {
      // 此处调用 drain 是安全的：running 已删除，不会重复启动
      this.drain(jid).catch((err) =>
        console.error(`[GroupQueue] drain error for ${jid}:`, err)
      );
    }
  }

  /**
   * 清空指定群组的待处理队列（stop 时调用）。
   * 不影响正在执行的任务，仅丢弃尚未开始的任务。
   */
  clearQueue(jid: string): void {
    const queue = this.queues.get(jid);
    if (queue && queue.length > 0) {
      console.log(`[GroupQueue] Clearing ${queue.length} pending task(s) for ${jid}`);
      queue.length = 0;
    }
  }

  /** 申请一个全局并发槽；若已满则等待 */
  private acquireSlot(_jid?: string): Promise<void> {
    if (this.globalActive < this.maxConcurrent) {
      this.globalActive++;
      return Promise.resolve();
    }
    return new Promise<void>((resolve) => {
      this.slotWaiters.push(() => {
        this.globalActive++;
        resolve();
      });
    });
  }

  /** 释放一个全局并发槽，唤醒等待中的 drain */
  private releaseSlot(_jid?: string): void {
    this.globalActive--;
    if (this.slotWaiters.length > 0) {
      const next = this.slotWaiters.shift()!;
      next();
    }
  }
}
