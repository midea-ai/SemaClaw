/**
 * CommandDispatcher — 管理命令解析与执行（isAdmin 群组专用）
 *
 * Channel 无关：被 MessageRouter 调用，所有接入渠道（Telegram / WS / Voice…）均可复用。
 *
 * 支持命令（前缀 / 可选，大小写不敏感，下划线/空格均可）：
 *   list_tasks [folder]       — 列出任务
 *   task_logs <taskId> [n]    — 查看执行日志
 *   pause_task <taskId>       — 暂停任务
 *   resume_task <taskId>      — 恢复任务
 *   cancel_task <taskId>      — 取消任务（标记完成，保留记录）
 *   del_task <taskId>         — 删除任务（彻底移除）
 *   help                      — 显示帮助
 */

import type { ScheduledTask, TaskRunLog } from '../types';
import { getTasksByGroup, getTaskRunLogs, listAllTasks, updateTaskStatus, deleteTask, getTaskById, advanceTaskNextRun } from '../db/db';
import { computeNextRunOnResume } from '../scheduler/TaskScheduler';

export const COMMANDS_HELP = [
  '📋 可用命令：',
  '  list_tasks [folder]       — 列出任务（可按群组 folder 筛选）',
  '  task_logs <taskId> [n]    — 查看最近 n 条执行日志（默认 20）',
  '  pause_task <taskId>       — 暂停任务',
  '  resume_task <taskId>      — 恢复任务',
  '  cancel_task <taskId>      — 取消任务（标记完成，保留记录）',
  '  del_task <taskId>         — 删除任务（彻底移除）',
  '  help                      — 显示此帮助',
].join('\n');

/**
 * 尝试将 text 解析为管理命令并执行。
 * @returns 命令执行结果文本，或 null（不是命令，应交给 Agent 处理）
 */
export function dispatchCommand(text: string): string | null {
  const t = text.trim();

  if (/^\/?help$/i.test(t)) return COMMANDS_HELP;

  // list_tasks [folder]
  const listMatch = t.match(/^\/?list[_\s]tasks?(?:\s+(\S+))?$/i);
  if (listMatch) {
    const folder = listMatch[1];
    const tasks = folder ? getTasksByGroup(folder) : listAllTasks();
    return formatTaskList(tasks, folder);
  }

  // task_logs <taskId> [limit]
  const logsMatch = t.match(/^\/?task[_\s]logs?\s+(\S+)(?:\s+(\d+))?$/i);
  if (logsMatch) {
    const taskId = logsMatch[1];
    const limit = logsMatch[2] ? parseInt(logsMatch[2], 10) : 20;
    return formatTaskLogs(taskId, getTaskRunLogs(taskId, limit));
  }

  // pause_task / resume_task / cancel_task <taskId>
  const manageMatch = t.match(/^\/?(pause|resume|cancel)[_\s]task\s+(\S+)$/i);
  if (manageMatch) {
    const action = manageMatch[1].toLowerCase();
    const taskId = manageMatch[2];

    // resume 需要同时重置 next_run，避免沿用暂停前已过期的时间导致追赶风暴
    if (action === 'resume') {
      const task = getTaskById(taskId);
      if (!task) return `❌ 任务不存在: ${taskId}`;
      if (task.scheduleType === 'once') {
        return `⚠️ One-time tasks cannot be resumed. Cancel this task and create a new one instead.`;
      }
      advanceTaskNextRun(task.id, computeNextRunOnResume(task), 'active');
      return `✅ 任务 ${taskId} 已恢复`;
    }

    const statusMap: Record<string, ScheduledTask['status']> = {
      pause: 'paused', cancel: 'completed',
    };
    updateTaskStatus(taskId, statusMap[action]);
    const label = action === 'pause' ? '已暂停' : '已取消';
    return `✅ 任务 ${taskId} ${label}`;
  }

  // del_task <taskId>
  const delMatch = t.match(/^\/?del[_\s]task\s+(\S+)$/i);
  if (delMatch) {
    const taskId = delMatch[1];
    return deleteTask(taskId) ? `🗑️ 任务 ${taskId} 已删除` : `❌ 任务不存在: ${taskId}`;
  }

  return null;
}

// ===== 格式化 =====

function formatTaskList(tasks: ScheduledTask[], folder?: string): string {
  const title = folder
    ? `📋 任务列表 — ${folder}（${tasks.length} 个）`
    : `📋 所有任务（${tasks.length} 个）`;
  if (tasks.length === 0) return `${title}\n暂无任务`;

  const statusIcon = (s: string) => s === 'active' ? '🟢' : s === 'paused' ? '⏸' : '⏹';
  const lines = [title, ''];
  for (const t of tasks) {
    lines.push(`${statusIcon(t.status)} ${t.groupFolder} · ${t.contextMode}`);
    lines.push(`   ID: ${t.id}`);
    lines.push(`   计划: ${t.scheduleValue} (${t.scheduleType})`);
    const preview = t.prompt.length > 60 ? `${t.prompt.slice(0, 60)}…` : t.prompt;
    lines.push(`   内容: ${preview}`);
    if (t.nextRun) lines.push(`   下次: ${t.nextRun}`);
    if (t.lastRun)  lines.push(`   上次: ${t.lastRun}`);
    lines.push('');
  }
  return lines.join('\n').trimEnd();
}

function formatTaskLogs(taskId: string, logs: TaskRunLog[]): string {
  if (logs.length === 0) return `📜 任务 ${taskId} 暂无执行记录`;
  const lines = [`📜 执行日志 — ${taskId}（最近 ${logs.length} 条）`, ''];
  for (const log of logs) {
    const icon = log.status === 'success' ? '✅' : '❌';
    lines.push(`${icon} ${log.runAt}${log.durationMs !== null ? `  (${log.durationMs}ms)` : ''}`);
    if (log.result) {
      const p = log.result.length > 120 ? `${log.result.slice(0, 120)}…` : log.result;
      lines.push(`   ${p}`);
    }
    if (log.error) lines.push(`   错误: ${log.error.slice(0, 120)}`);
    lines.push('');
  }
  return lines.join('\n').trimEnd();
}
