/**
 * SQLite 数据库封装
 *
 * 负责 schema 初始化和所有持久化操作。
 * 使用 better-sqlite3（同步 API），无 async 开销，适合 Node.js 单线程模型。
 *
 * 表结构：
 *   groups            — GroupBinding 注册表
 *   channel_messages  — 消息历史（FIFO，每组保留 N 条）
 *   scheduled_tasks   — 定时任务
 *   task_run_logs     — 任务执行日志
 *   router_state      — 路由游标（key-value store）
 */

import Database from 'better-sqlite3';
import * as fs from 'fs';
import * as path from 'path';
import type { GroupBinding, StoredMessage, ScheduledTask, TaskRunLog } from '../types';
import { config } from '../config';
import { applyMemorySchema, buildModelKey } from '../memory/memory-schema';

function safeJsonParse<T>(raw: string | null): T | null {
  if (!raw) return null;
  try { return JSON.parse(raw) as T; } catch { return null; }
}

// ===== 初始化 =====

let _db: Database.Database | null = null;

export function getDb(): Database.Database {
  if (!_db) throw new Error('DB not initialized. Call initDb() first.');
  return _db;
}

/**
 * 初始化数据库：创建目录、打开连接、建表。
 * 幂等，可安全多次调用。
 */
export function initDb(dbPath = config.paths.dbPath): Database.Database {
  if (_db) return _db;

  // 确保目录存在
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });

  _db = new Database(dbPath);

  // WAL 模式：提升并发读性能
  _db.pragma('journal_mode = WAL');
  _db.pragma('foreign_keys = ON');

  applySchema(_db);
  const provider = config.memory.embeddingProvider;
  const enableVec = provider !== 'none';
  const dimensions = resolveDimensions(provider, config.memory.embeddingDimensions);
  const modelName = provider === 'openrouter' ? config.memory.openrouterModel
    : provider === 'ollama' ? config.memory.ollamaModel
    : provider === 'local' ? (config.memory.localModel || 'default')
    : provider === 'openai' ? (config.memory.openaiModel || 'text-embedding-3-small')
    : '';
  const modelKey = enableVec ? buildModelKey(provider, modelName, dimensions) : '';
  try {
    applyMemorySchema(_db, enableVec, dimensions, modelKey);
  } catch (e) {
    console.error('[DB] applyMemorySchema failed, memory search will be unavailable:', e);
  }
  return _db;
}

/**
 * 解析向量维度。优先使用用户显式配置（SEMACLAW_EMBEDDING_DIMENSIONS），
 * 未配置时按 provider 类型取默认值：
 *   openai=1536, openrouter=1536, ollama=1536, local=384
 */
export function resolveDimensions(provider: string, configured: number): number {
  if (configured > 0) return configured;
  if (provider === 'local') return 384;
  return 1536;
}

function applySchema(db: Database.Database): void {
  db.exec(`
    -- 群组绑定注册表
    CREATE TABLE IF NOT EXISTS groups (
      jid                  TEXT PRIMARY KEY,
      folder               TEXT UNIQUE NOT NULL,
      name                 TEXT NOT NULL DEFAULT '',
      channel              TEXT NOT NULL DEFAULT 'telegram',
      is_admin             INTEGER NOT NULL DEFAULT 0,
      requires_trigger     INTEGER NOT NULL DEFAULT 1,
      allowed_tools        TEXT,              -- JSON array | NULL（全部）
      allowed_paths        TEXT,              -- JSON array | NULL
      allowed_work_dirs    TEXT,              -- JSON array | NULL（不允许切换）
      bot_token            TEXT,              -- 绑定的 Bot token | NULL（用全局默认）
      max_messages         INTEGER,           -- NULL = 使用全局 MAX_MESSAGES_PER_GROUP
      last_active          TEXT,
      added_at             TEXT NOT NULL
    );

    -- 消息历史（FIFO，每组保留 N 条）
    CREATE TABLE IF NOT EXISTS channel_messages (
      message_id   TEXT NOT NULL,
      chat_jid     TEXT NOT NULL,
      sender_jid   TEXT NOT NULL DEFAULT '',
      sender_name  TEXT NOT NULL DEFAULT '',
      content      TEXT NOT NULL DEFAULT '',
      timestamp    TEXT NOT NULL,
      is_from_me   INTEGER NOT NULL DEFAULT 0,
      is_bot_reply INTEGER NOT NULL DEFAULT 0,
      reply_to_id  TEXT,
      media_type   TEXT,
      PRIMARY KEY (message_id, chat_jid)
    );
    CREATE INDEX IF NOT EXISTS idx_msg_timestamp
      ON channel_messages(chat_jid, timestamp);

    -- 定时任务
    CREATE TABLE IF NOT EXISTS scheduled_tasks (
      id             TEXT PRIMARY KEY,
      group_folder   TEXT NOT NULL,
      chat_jid       TEXT NOT NULL,
      prompt         TEXT NOT NULL,
      schedule_type  TEXT NOT NULL,     -- cron | interval | once
      schedule_value TEXT NOT NULL,
      context_mode   TEXT NOT NULL DEFAULT 'isolated',  -- isolated | group | notify | script | script-agent
      script_path    TEXT,             -- script / script-agent 模式：存储 shell 命令字符串
      next_run       TEXT,
      last_run       TEXT,
      last_result    TEXT,              -- 截断至 500 字
      status         TEXT NOT NULL DEFAULT 'active',
      created_at     TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_task_next_run
      ON scheduled_tasks(next_run, status);

    -- 任务执行日志
    CREATE TABLE IF NOT EXISTS task_run_logs (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      task_id     TEXT NOT NULL,
      run_at      TEXT NOT NULL,
      duration_ms INTEGER,
      status      TEXT NOT NULL,       -- success | error
      result      TEXT,
      error       TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_run_task_id
      ON task_run_logs(task_id, run_at);

    -- 路由游标（key-value store）
    -- 用于 lastAgentTimestamp（per group）等全局状态
    CREATE TABLE IF NOT EXISTS router_state (
      key   TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
  `);

  // 迁移：为已有 groups 表补充新列（SQLite 不支持 IF NOT EXISTS on ALTER）
  const cols = db.pragma('table_info(groups)') as Array<{ name: string }>;
  const colNames = new Set(cols.map((c) => c.name));
  if (!colNames.has('allowed_work_dirs')) {
    db.exec('ALTER TABLE groups ADD COLUMN allowed_work_dirs TEXT');
  }

  // scheduled_tasks 迁移
  const taskCols = db.pragma('table_info(scheduled_tasks)') as Array<{ name: string }>;
  const taskColNames = new Set(taskCols.map((c) => c.name));
  if (!taskColNames.has('script_path')) {
    db.exec('ALTER TABLE scheduled_tasks ADD COLUMN script_path TEXT');
  }
}

// ===== Groups =====

/** 注册或更新群组绑定 */
export function upsertGroup(g: GroupBinding): void {
  getDb().prepare(`
    INSERT INTO groups
      (jid, folder, name, channel, is_admin, requires_trigger,
       allowed_tools, allowed_paths, allowed_work_dirs, bot_token, max_messages, last_active, added_at)
    VALUES
      (@jid, @folder, @name, @channel, @isAdmin, @requiresTrigger,
       @allowedTools, @allowedPaths, @allowedWorkDirs, @botToken, @maxMessages, @lastActive, @addedAt)
    ON CONFLICT(jid) DO UPDATE SET
      folder             = excluded.folder,
      name               = excluded.name,
      channel            = excluded.channel,
      is_admin           = excluded.is_admin,
      requires_trigger   = excluded.requires_trigger,
      allowed_tools      = excluded.allowed_tools,
      allowed_paths      = excluded.allowed_paths,
      allowed_work_dirs  = excluded.allowed_work_dirs,
      bot_token          = excluded.bot_token,
      max_messages       = excluded.max_messages,
      last_active        = excluded.last_active
  `).run({
    jid: g.jid,
    folder: g.folder,
    name: g.name,
    channel: g.channel,
    isAdmin: g.isAdmin ? 1 : 0,
    requiresTrigger: g.requiresTrigger ? 1 : 0,
    allowedTools: g.allowedTools !== null ? JSON.stringify(g.allowedTools) : null,
    allowedPaths: g.allowedPaths !== null ? JSON.stringify(g.allowedPaths) : null,
    allowedWorkDirs: g.allowedWorkDirs !== null ? JSON.stringify(g.allowedWorkDirs) : null,
    botToken: g.botToken,
    maxMessages: g.maxMessages,
    lastActive: g.lastActive,
    addedAt: g.addedAt,
  });
}

/** 按 jid 查找群组 */
export function getGroup(jid: string): GroupBinding | null {
  const row = getDb().prepare(
    'SELECT * FROM groups WHERE jid = ?'
  ).get(jid) as Record<string, unknown> | undefined;
  return row ? rowToGroup(row) : null;
}

/** 获取所有注册群组 */
export function listGroups(): GroupBinding[] {
  const rows = getDb().prepare('SELECT * FROM groups ORDER BY added_at').all() as Record<string, unknown>[];
  return rows.map(rowToGroup);
}

/** 删除群组 */
export function deleteGroup(jid: string): void {
  getDb().prepare('DELETE FROM groups WHERE jid = ?').run(jid);
}

/** 删除指定 folder 的群组（folder UNIQUE 冲突时预清理用） */
export function deleteGroupByFolder(folder: string): void {
  getDb().prepare('DELETE FROM groups WHERE folder = ?').run(folder);
}

/**
 * 原子性地将群组的 JID 从 oldJid 改为 newJid（用于飞书 pending 绑定完成时）。
 * SQLite 不允许 UPDATE PRIMARY KEY，所以通过事务 DELETE + INSERT 实现。
 */
export function renameGroupJid(oldJid: string, newJid: string): GroupBinding | null {
  const db = getDb();
  const old = getGroup(oldJid);
  if (!old) return null;
  const newBinding: GroupBinding = { ...old, jid: newJid };
  db.transaction(() => {
    deleteGroup(oldJid);
    upsertGroup(newBinding);
  })();
  return newBinding;
}

/** 更新 last_active */
export function touchGroupActive(jid: string, timestamp: string): void {
  getDb().prepare(
    'UPDATE groups SET last_active = ? WHERE jid = ?'
  ).run(timestamp, jid);
}

function rowToGroup(row: Record<string, unknown>): GroupBinding {
  return {
    jid: row.jid as string,
    folder: row.folder as string,
    name: row.name as string,
    channel: (row.channel as string) ?? '',
    isAdmin: Boolean(row.is_admin),
    requiresTrigger: Boolean(row.requires_trigger),
    allowedTools: safeJsonParse<string[]>(row.allowed_tools as string | null),
    allowedPaths: safeJsonParse<string[]>(row.allowed_paths as string | null),
    allowedWorkDirs: safeJsonParse<string[]>(row.allowed_work_dirs as string | null),
    botToken: (row.bot_token as string | null) ?? null,
    maxMessages: (row.max_messages as number | null) ?? null,
    lastActive: (row.last_active as string | null) ?? null,
    addedAt: row.added_at as string,
  };
}

// ===== Messages =====

/**
 * 插入消息，然后 FIFO 清理（保留最新 N 条）。
 */
export function insertMessage(msg: StoredMessage): void {
  const db = getDb();

  // 获取该群组的 max_messages 限制
  const group = getGroup(msg.chatJid);
  const limit = group?.maxMessages ?? config.agent.maxMessagesPerGroup;

  db.prepare(`
    INSERT OR IGNORE INTO channel_messages
      (message_id, chat_jid, sender_jid, sender_name, content,
       timestamp, is_from_me, is_bot_reply, reply_to_id, media_type)
    VALUES
      (@messageId, @chatJid, @senderJid, @senderName, @content,
       @timestamp, @isFromMe, @isBotReply, @replyToId, @mediaType)
  `).run({
    messageId: msg.messageId,
    chatJid: msg.chatJid,
    senderJid: msg.senderJid,
    senderName: msg.senderName,
    content: msg.content,
    timestamp: msg.timestamp,
    isFromMe: msg.isFromMe ? 1 : 0,
    isBotReply: msg.isBotReply ? 1 : 0,
    replyToId: msg.replyToId,
    mediaType: msg.mediaType,
  });

  // FIFO 清理
  db.prepare(`
    DELETE FROM channel_messages
    WHERE chat_jid = ?
      AND message_id NOT IN (
        SELECT message_id FROM channel_messages
        WHERE chat_jid = ?
        ORDER BY timestamp DESC
        LIMIT ?
      )
  `).run(msg.chatJid, msg.chatJid, limit);
}

/**
 * 获取群组消息历史（按时间升序）。
 * @param since 只返回此 ISO 时间之后的消息（不含）
 */
export function getMessages(chatJid: string, since?: string): StoredMessage[] {
  const rows = since
    ? (getDb().prepare(`
        SELECT * FROM channel_messages
        WHERE chat_jid = ? AND timestamp > ?
        ORDER BY timestamp ASC
      `).all(chatJid, since) as Record<string, unknown>[])
    : (getDb().prepare(`
        SELECT * FROM channel_messages
        WHERE chat_jid = ?
        ORDER BY timestamp ASC
      `).all(chatJid) as Record<string, unknown>[]);

  return rows.map(rowToMessage);
}

function rowToMessage(row: Record<string, unknown>): StoredMessage {
  return {
    messageId: row.message_id as string,
    chatJid: row.chat_jid as string,
    senderJid: row.sender_jid as string,
    senderName: row.sender_name as string,
    content: row.content as string,
    timestamp: row.timestamp as string,
    isFromMe: Boolean(row.is_from_me),
    isBotReply: Boolean(row.is_bot_reply),
    replyToId: (row.reply_to_id as string | null) ?? null,
    mediaType: (row.media_type as string | null) ?? null,
  };
}

// ===== Scheduled Tasks =====

export function insertTask(task: ScheduledTask): void {
  getDb().prepare(`
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

/** 获取所有到期的 active 任务（next_run <= now） */
export function getDueTasks(now: string): ScheduledTask[] {
  const rows = getDb().prepare(`
    SELECT * FROM scheduled_tasks
    WHERE status = 'active' AND next_run IS NOT NULL AND next_run <= ?
    ORDER BY next_run ASC
  `).all(now) as Record<string, unknown>[];
  return rows.map(rowToTask);
}

export function getTasksByGroup(groupFolder: string): ScheduledTask[] {
  const rows = getDb().prepare(`
    SELECT * FROM scheduled_tasks WHERE group_folder = ? ORDER BY created_at DESC
  `).all(groupFolder) as Record<string, unknown>[];
  return rows.map(rowToTask);
}

export function updateTaskRun(
  id: string,
  nextRun: string | null,
  lastRun: string,
  lastResult: string | null,
  status: ScheduledTask['status'],
): void {
  getDb().prepare(`
    UPDATE scheduled_tasks
    SET next_run = ?, last_run = ?, last_result = ?, status = ?
    WHERE id = ?
  `).run(nextRun, lastRun, lastResult ? lastResult.slice(0, 500) : null, status, id);
}

export function advanceTaskNextRun(
  id: string,
  nextRun: string | null,
  status: ScheduledTask['status'],
): void {
  getDb().prepare(`
    UPDATE scheduled_tasks SET next_run = ?, status = ? WHERE id = ?
  `).run(nextRun, status, id);
}

export function updateTaskStatus(id: string, status: ScheduledTask['status']): void {
  getDb().prepare('UPDATE scheduled_tasks SET status = ? WHERE id = ?').run(status, id);
}

export function deleteTask(id: string): boolean {
  const result = getDb().prepare('DELETE FROM scheduled_tasks WHERE id = ?').run(id);
  return result.changes > 0;
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

// ===== Task Run Logs =====

export function insertTaskRunLog(entry: {
  taskId: string;
  runAt: string;
  durationMs: number | null;
  status: 'success' | 'error';
  result: string | null;
  error: string | null;
}): void {
  getDb().prepare(`
    INSERT INTO task_run_logs (task_id, run_at, duration_ms, status, result, error)
    VALUES (@taskId, @runAt, @durationMs, @status, @result, @error)
  `).run(entry);
}

/** 查询任务执行日志（按时间倒序） */
export function getTaskRunLogs(taskId: string, limit = 20): TaskRunLog[] {
  const rows = getDb().prepare(`
    SELECT * FROM task_run_logs WHERE task_id = ? ORDER BY run_at DESC LIMIT ?
  `).all(taskId, limit) as Record<string, unknown>[];
  return rows.map((r) => ({
    id: r.id as number,
    taskId: r.task_id as string,
    runAt: r.run_at as string,
    durationMs: (r.duration_ms as number | null) ?? null,
    status: r.status as 'success' | 'error',
    result: (r.result as string | null) ?? null,
    error: (r.error as string | null) ?? null,
  }));
}

/** 查询所有群组的全部任务（管理视图用） */
export function listAllTasks(): ScheduledTask[] {
  const rows = getDb().prepare(
    'SELECT * FROM scheduled_tasks ORDER BY created_at DESC'
  ).all() as Record<string, unknown>[];
  return rows.map(rowToTask);
}

// ===== Router State =====

export function getRouterState(key: string): string | null {
  const row = getDb().prepare(
    'SELECT value FROM router_state WHERE key = ?'
  ).get(key) as { value: string } | undefined;
  return row?.value ?? null;
}

export function setRouterState(key: string, value: string): void {
  getDb().prepare(`
    INSERT INTO router_state (key, value) VALUES (?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value
  `).run(key, value);
}

/**
 * 获取群组的 lastAgentTimestamp（Agent 最后一次响应时间）
 */
export function getLastAgentTimestamp(chatJid: string): string | null {
  return getRouterState(`lastAgent:${chatJid}`);
}

/**
 * 更新群组的 lastAgentTimestamp
 */
export function setLastAgentTimestamp(chatJid: string, timestamp: string): void {
  setRouterState(`lastAgent:${chatJid}`, timestamp);
}
