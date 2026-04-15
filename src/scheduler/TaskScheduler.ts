/**
 * TaskScheduler — 定时任务轮询执行器
 *
 * 每隔 SCHEDULER_INTERVAL_SEC 秒轮询 SQLite，找出 next_run <= now 的 active 任务，
 * 通过 GroupQueue 异步分发给 AgentPool 执行。
 *
 * context_mode:
 *   'notify'       — 直接发送 prompt 文本，不启动 Agent
 *   'isolated'     — 创建临时 SemaCore，独立 session，执行完丢弃
 *   'group'        — 复用 pool 中的现有 SemaCore session（有聊天上下文）
 *   'script'       — 执行脚本，将 stdout/stderr 直接发送
 *   'script-agent' — 执行脚本，将输出注入 prompt 后交给 isolated Agent 汇报
 */

import { exec } from 'child_process';
import { promisify } from 'util';
import { parseExpression } from 'cron-parser';
import { config } from '../config';
import { localISOString } from '../util/localTime';
import { getDueTasks, updateTaskRun, advanceTaskNextRun, updateTaskStatus, insertTaskRunLog } from '../db/db';
import { GroupManager } from '../gateway/GroupManager';
import type { GroupBinding, ScheduledTask } from '../types';
import type { AgentPool } from '../agent/AgentPool';
import type { GroupQueue } from '../agent/GroupQueue';
import type { WebSocketGateway } from '../gateway/WebSocketGateway';

const execAsync = promisify(exec);

/** 脚本执行超时（ms） */
const SCRIPT_TIMEOUT_MS = 60_000;
/** 脚本输出最大长度（Telegram 单条限 4096，留 buffer） */
const SCRIPT_OUTPUT_MAX = 3_500;

/** 跨平台 shell：Windows 用系统默认 cmd，Unix 用 bash */
const SCRIPT_SHELL: string = process.platform === 'win32'
  ? (process.env.COMSPEC || 'cmd.exe')
  : '/bin/bash';

export class TaskScheduler {
  private timer: NodeJS.Timeout | null = null;
  private wsGateway: WebSocketGateway | null = null;

  constructor(
    private readonly agentPool: AgentPool,
    private readonly groupQueue: GroupQueue,
    private readonly groupManager: GroupManager,
  ) {}

  setWsGateway(gateway: WebSocketGateway): void {
    this.wsGateway = gateway;
  }

  start(): void {
    const intervalMs = config.scheduler.intervalSec * 1000;
    this.timer = setInterval(() => this.tick(), intervalMs);
    console.log(`[TaskScheduler] Started (interval: ${config.scheduler.intervalSec}s)`);
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    console.log('[TaskScheduler] Stopped');
  }

  private tick(): void {
    const now = new Date().toISOString();
    const tasks = getDueTasks(now);
    if (tasks.length > 0) {
      console.log(`[TaskScheduler] ${tasks.length} due task(s) found`);
    }
    for (const task of tasks) {
      this.dispatch(task);
    }
  }

  private dispatch(task: ScheduledTask): void {
    const group = this.groupManager.get(task.chatJid);
    if (!group) {
      console.warn(`[TaskScheduler] Group not found for task ${task.id} (chatJid: ${task.chatJid})`);
      updateTaskStatus(task.id, 'error');
      return;
    }

    // Advance next_run immediately so subsequent ticks won't re-pick this task
    const nextRun = computeNextRun(task);
    const nextStatus: ScheduledTask['status'] =
      task.scheduleType === 'once' ? 'completed' : 'active';
    advanceTaskNextRun(task.id, nextRun, nextStatus);

    this.groupQueue.enqueue(task.chatJid, async () => {
      const startMs = Date.now();
      let result: string | null = null;
      let errorMsg: string | null = null;
      let runStatus: 'success' | 'error' = 'success';

      try {
        switch (task.contextMode) {
          case 'notify':
            await this.runNotify(task, group);
            result = 'Notification sent';
            break;
          case 'isolated':
            await this.agentPool.runIsolated(task, group);
            result = 'Task completed successfully';
            break;
          case 'script':
            result = await this.runScript(task, group);
            break;
          case 'script-agent':
            await this.runScriptAgent(task, group);
            result = 'Script-agent task completed';
            break;
          case 'group':
          default:
            await this.agentPool.processAndWait(task.chatJid, group, task.prompt);
            result = 'Task completed successfully';
            break;
        }
      } catch (err) {
        runStatus = 'error';
        errorMsg = String(err);
        console.error(`[TaskScheduler] Task ${task.id} failed:`, err);
      }

      const durationMs = Date.now() - startMs;

      // interval 积压检测：nextRun 已落后于当前时间，说明间隔比执行时长短
      if (task.scheduleType === 'interval' && nextRun && this.wsGateway) {
        const overdueMs = Date.now() - new Date(nextRun).getTime();
        if (overdueMs > 0) {
          const intervalMs = Number(task.scheduleValue);
          console.warn(
            `[TaskScheduler] Task ${task.id} backlog detected: overdue ${overdueMs}ms, interval ${intervalMs}ms, execution ${durationMs}ms`
          );
          this.wsGateway.notifyTaskBacklog(
            task.id,
            task.chatJid,
            task.prompt.slice(0, 80),
            intervalMs,
            overdueMs,
          );
        }
      }

      const now = new Date().toISOString();        // UTC，用于 DB 时间比较字段
      const nowLocal = localISOString();           // 本地时间，用于展示性日志字段
      updateTaskRun(task.id, nextRun, now, result ?? errorMsg, nextStatus);
      insertTaskRunLog({
        taskId: task.id,
        runAt: nowLocal,
        durationMs,
        status: runStatus,
        result: runStatus === 'success' ? result : null,
        error: runStatus === 'error' ? errorMsg : null,
      });
    });
  }

  // ===== context_mode handlers =====

  /**
   * notify：直接发送 prompt 文本，不启动 Agent。
   * 有 TTL 检查，避免重启后发出过期通知。
   */
  private async runNotify(task: ScheduledTask, group: GroupBinding): Promise<void> {
    const maxDelayMs = config.scheduler.notifyMaxDelayMinutes * 60 * 1000;
    const overdueMs = task.nextRun ? Date.now() - new Date(task.nextRun).getTime() : 0;
    if (overdueMs > maxDelayMs) {
      console.warn(
        `[TaskScheduler] Skipping stale notify task ${task.id} (overdue ${Math.round(overdueMs / 60000)}m)`
      );
      return;
    }
    await this.agentPool.broadcastReply(task.chatJid, task.prompt, group.botToken ?? undefined);
  }

  /**
   * script：执行脚本命令，将 stdout/stderr 直接发送到频道和 Web UI。
   * 返回结果摘要（用于 task_run_logs）。
   * 命令通过系统 shell 执行（Windows: cmd.exe, Unix: bash），支持任意解释器。
   */
  private async runScript(task: ScheduledTask, group: GroupBinding): Promise<string> {
    if (!task.scriptCommand) {
      throw new Error(`Task ${task.id}: script_command is required for ${task.contextMode} mode`);
    }
    const { stdout, stderr } = await execAsync(task.scriptCommand, {
      shell: SCRIPT_SHELL,
      timeout: SCRIPT_TIMEOUT_MS,
    });
    const output = [stdout, stderr].filter(Boolean).join('\n').trim() || '(no output)';
    const text = output.length > SCRIPT_OUTPUT_MAX
      ? output.slice(0, SCRIPT_OUTPUT_MAX) + '\n…(output truncated)'
      : output;
    await this.agentPool.broadcastReply(task.chatJid, text, group.botToken ?? undefined);
    return `Script output sent (${output.length} chars)`;
  }

  /**
   * script-agent：执行脚本命令，将输出注入 prompt，交给 isolated Agent 格式化汇报。
   * isolated agent 已设置 skipBashExecPermission=true，无需用户审批。
   */
  private async runScriptAgent(task: ScheduledTask, group: GroupBinding): Promise<void> {
    if (!task.scriptCommand) {
      throw new Error(`Task ${task.id}: script_command is required for ${task.contextMode} mode`);
    }
    const { stdout, stderr } = await execAsync(task.scriptCommand, {
      shell: SCRIPT_SHELL,
      timeout: SCRIPT_TIMEOUT_MS,
    });
    const output = [stdout, stderr].filter(Boolean).join('\n').trim() || '(no output)';
    const prompt = `${task.prompt}\n\n<script_output>\n${output}\n</script_output>`;
    await this.agentPool.runIsolated(task, group, prompt);
  }
}

// ===== 辅助函数 =====

function computeNextRun(task: ScheduledTask): string | null {
  if (task.scheduleType === 'once') return null;

  if (task.scheduleType === 'interval') {
    const ms = Number(task.scheduleValue);
    if (isNaN(ms) || ms <= 0) return null;
    const base = task.nextRun ? new Date(task.nextRun).getTime() : Date.now();
    return new Date(base + ms).toISOString();
  }

  try {
    return parseExpression(task.scheduleValue).next().toDate().toISOString();
  } catch {
    return null;
  }
}
