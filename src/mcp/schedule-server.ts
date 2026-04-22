/**
 * ScheduleTool MCP 服务器进程
 *
 * 通过 stdio 接入 sema-core。从环境变量读取上下文，直接操作 SQLite。
 *
 * 环境变量：
 *   SEMACLAW_DB_PATH      — DB 文件绝对路径
 *   SEMACLAW_GROUP_FOLDER — 所属群组 folder（作用域限定）
 *   SEMACLAW_CHAT_JID     — 所属群组 chatJid
 *
 * 工具：
 *   schedule_task  — 创建定时任务
 *   list_tasks     — 列出本群组所有任务
 *   pause_task     — 暂停任务
 *   cancel_task    — 取消任务
 */

import Database from 'better-sqlite3';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { parseExpression } from 'cron-parser';
import { randomUUID } from 'crypto';
import type { ScheduledTask } from '../types';

// ===== 环境变量 =====

const dbPath = process.env.SEMACLAW_DB_PATH;
const groupFolder = process.env.SEMACLAW_GROUP_FOLDER;
const chatJid = process.env.SEMACLAW_CHAT_JID;

if (!dbPath || !groupFolder || !chatJid) {
  console.error('[schedule-server] Missing required env vars: SEMACLAW_DB_PATH, SEMACLAW_GROUP_FOLDER, SEMACLAW_CHAT_JID');
  process.exit(1);
}

// ===== 数据库 =====

const db = new Database(dbPath);
db.pragma('journal_mode = WAL');

// ===== next_run 计算 =====

function computeNextRun(scheduleType: string, scheduleValue: string): string {
  switch (scheduleType) {
    case 'cron': {
      const expr = parseExpression(scheduleValue);
      return expr.next().toDate().toISOString();
    }
    case 'interval': {
      const ms = Number(scheduleValue);
      if (isNaN(ms) || ms <= 0) throw new Error(`Invalid interval value: ${scheduleValue}`);
      return new Date(Date.now() + ms).toISOString();
    }
    case 'once': {
      const parsed = new Date(scheduleValue);
      if (isNaN(parsed.getTime())) {
        throw new Error(`Invalid once datetime: ${scheduleValue}. Expected ISO 8601 with timezone offset, e.g. "2026-04-22T18:17:00+08:00".`);
      }
      return parsed.toISOString();
    }
    default:
      throw new Error(`Unknown schedule_type: ${scheduleType}`);
  }
}

// ===== DB 操作 =====

function insertTask(task: ScheduledTask): void {
  db.prepare(`
    INSERT INTO scheduled_tasks
      (id, group_folder, chat_jid, prompt, schedule_type, schedule_value,
       context_mode, script_path, next_run, last_run, last_result, status, created_at)
    VALUES
      (@id, @groupFolder, @chatJid, @prompt, @scheduleType, @scheduleValue,
       @contextMode, @scriptPath, @nextRun, @lastRun, @lastResult, @status, @createdAt)
  `).run({
    id: task.id,
    groupFolder: task.groupFolder,
    chatJid: task.chatJid,
    prompt: task.prompt,
    scheduleType: task.scheduleType,
    scheduleValue: task.scheduleValue,
    contextMode: task.contextMode,
    scriptPath: task.scriptCommand,
    nextRun: task.nextRun,
    lastRun: task.lastRun,
    lastResult: task.lastResult,
    status: task.status,
    createdAt: task.createdAt,
  });
}

function rowToTask(row: Record<string, unknown>): ScheduledTask {
  return {
    id: row.id as string,
    groupFolder: row.group_folder as string,
    chatJid: row.chat_jid as string,
    prompt: row.prompt as string,
    scheduleType: row.schedule_type as ScheduledTask['scheduleType'],
    scheduleValue: row.schedule_value as string,
    contextMode: row.context_mode as ScheduledTask['contextMode'],
    scriptCommand: (row.script_path as string | null) ?? null,
    nextRun: (row.next_run as string | null) ?? null,
    lastRun: (row.last_run as string | null) ?? null,
    lastResult: (row.last_result as string | null) ?? null,
    status: row.status as ScheduledTask['status'],
    createdAt: row.created_at as string,
  };
}

function getTasksByGroup(folder: string): ScheduledTask[] {
  const rows = db.prepare(
    'SELECT * FROM scheduled_tasks WHERE group_folder = ? ORDER BY created_at DESC'
  ).all(folder) as Record<string, unknown>[];
  return rows.map(rowToTask);
}

function updateTaskStatus(id: string, folder: string, status: ScheduledTask['status']): boolean {
  const result = db.prepare(
    'UPDATE scheduled_tasks SET status = ? WHERE id = ? AND group_folder = ?'
  ).run(status, id, folder);
  return result.changes > 0;
}

// ===== MCP 服务器 =====

const server = new McpServer({ name: 'semaclaw-schedule', version: '1.0.0' });
// Cast to any to avoid TS2589 caused by MCP SDK's deep zod type inference (ShapeOutput<ZodRawShape>)
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const srv = server as any;

// schedule_task
srv.registerTool(
  'schedule_task',
  {
    description: 'Create a scheduled task that runs a prompt on a schedule.',
    inputSchema: {
      prompt: z.string().describe('For "notify" mode: the exact message text to send. For other modes: the instruction given to the Agent.'),
      schedule_type: z.enum(['cron', 'interval', 'once']).describe(
        'Type of schedule: "cron" for cron expression, "interval" for repeating interval in ms, "once" for a one-time ISO timestamp'
      ),
      schedule_value: z.string().describe(
        'cron (e.g. "0 9 * * *"), interval ms (e.g. "3600000"), or once ISO datetime. ' +
        'For once: write local time without offset (e.g. "2026-04-23T18:00:00"); ' +
        'interpreted in server local TZ, stored as UTC.'
      ),
      context_mode: z.enum(['isolated', 'group', 'notify', 'script', 'script-agent']).optional().describe(
        'How the task runs when triggered:\n- "notify": send the prompt text as a fixed message, no Agent involved. Silently dropped if overdue by more than 30 min (e.g. after a restart). Use for reminders and alerts with static content.\n- "script": run a shell script and send its stdout/stderr directly. Zero LLM cost — best for deterministic health checks, metrics, or any task whose output needs no interpretation.\n- "script-agent": run a shell script, then have an Agent summarize or act on the output. Efficient when multiple data sources can be collected in one script and synthesized in a single Agent turn.\n- "group": run in the current group session, sharing full conversation history and context. Use for periodic awareness tasks (heartbeat-style): the prompt can instruct the Agent to run available scripts, check multiple things, and stay silent if nothing needs attention.\n- "isolated": start a fresh Agent session with no prior context. All tool permissions are pre-approved (no user confirmation required). Use for standalone scheduled tasks that need reasoning but must not affect or be affected by the ongoing conversation.\nDefault: "notify" for static reminders; "isolated" for standalone reasoning tasks; "group" for periodic monitoring that benefits from conversation context.'
      ),
      script_command: z.string().optional().describe(
        'Shell command to execute (required for "script" and "script-agent" modes). On Linux/macOS the command runs via /bin/bash; on Windows it runs via cmd.exe. Any interpreter is supported — e.g. "python3 /path/to/check.py", "node /app/report.js". No path restrictions apply; the command runs with the same permissions as the semaclaw process.'
      ),
    },
  },
  async ({ prompt, schedule_type, schedule_value, context_mode, script_command }: {
    prompt: string;
    schedule_type: 'cron' | 'interval' | 'once';
    schedule_value: string;
    context_mode?: 'isolated' | 'group' | 'notify' | 'script' | 'script-agent';
    script_command?: string;
  }) => {
    try {
      const resolvedMode = context_mode ?? 'notify';
      if ((resolvedMode === 'script' || resolvedMode === 'script-agent') && !script_command) {
        return {
          content: [{ type: 'text' as const, text: 'Error: script_command is required for script and script-agent modes' }],
          isError: true,
        };
      }
      const nextRun = computeNextRun(schedule_type, schedule_value);
      const task: ScheduledTask = {
        id: randomUUID(),
        groupFolder: groupFolder!,
        chatJid: chatJid!,
        prompt,
        scheduleType: schedule_type,
        scheduleValue: schedule_value,
        contextMode: resolvedMode,
        scriptCommand: script_command ?? null,
        nextRun,
        lastRun: null,
        lastResult: null,
        status: 'active',
        createdAt: new Date().toISOString(),
      };
      insertTask(task);
      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify({ success: true, taskId: task.id, nextRun }),
        }],
      };
    } catch (err) {
      return {
        content: [{ type: 'text' as const, text: `Error: ${String(err)}` }],
        isError: true,
      };
    }
  }
);

// list_tasks
srv.registerTool(
  'list_tasks',
  {
    description: 'List all scheduled tasks for the current group.',
    inputSchema: {},
  },
  async () => {
    const tasks = getTasksByGroup(groupFolder!);
    return {
      content: [{ type: 'text' as const, text: JSON.stringify(tasks, null, 2) }],
    };
  }
);

// pause_task
srv.registerTool(
  'pause_task',
  {
    description: 'Pause a scheduled task (it will not run until resumed).',
    inputSchema: {
      taskId: z.string().describe('The task ID to pause'),
    },
  },
  async ({ taskId }: { taskId: string }) => {
    const changed = updateTaskStatus(taskId, groupFolder!, 'paused');
    return {
      content: [{
        type: 'text' as const,
        text: changed
          ? JSON.stringify({ success: true, taskId, status: 'paused' })
          : `Task not found or not in this group: ${taskId}`,
      }],
      isError: !changed,
    };
  }
);

// cancel_task
srv.registerTool(
  'cancel_task',
  {
    description: 'Cancel a scheduled task permanently (marks as completed).',
    inputSchema: {
      taskId: z.string().describe('The task ID to cancel'),
    },
  },
  async ({ taskId }: { taskId: string }) => {
    const changed = updateTaskStatus(taskId, groupFolder!, 'completed');
    return {
      content: [{
        type: 'text' as const,
        text: changed
          ? JSON.stringify({ success: true, taskId, status: 'completed' })
          : `Task not found or not in this group: ${taskId}`,
      }],
      isError: !changed,
    };
  }
);

// ===== 启动 =====

(async () => {
  const transport = new StdioServerTransport();
  await server.connect(transport);
})();
