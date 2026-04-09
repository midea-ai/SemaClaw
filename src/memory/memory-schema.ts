/**
 * Memory System Schema — SQLite 表定义
 *
 * 在现有 semaclaw.db 上扩展记忆索引表：
 *   memory_files      — 源文件追踪（hash 变更检测）
 *   memory_chunks     — 分块索引（文本 + 可选 embedding）
 *   memory_chunks_fts — FTS5 全文索引
 *   embedding_cache   — Embedding 缓存（跨 agent 共享）
 *   memory_meta       — 记忆元数据 KV（含 embedding_model 切换检测）
 */

import type Database from 'better-sqlite3';

/**
 * 创建记忆系统表（幂等）。
 * @param enableVec 是否加载 sqlite-vec 向量扩展（仅 embedding 启用时需要）
 * @param dimensions 向量维度（仅在 enableVec=true 时有效）
 * @param modelKey   当前 embedding 模型标识（"provider:model:dimensions"），用于切换检测
 * @throws {Error} 如果检测到模型冲突（多 Agent 使用不同模型）
 */
export function applyMemorySchema(
  db: Database.Database,
  enableVec = false,
  dimensions = 1536,
  modelKey = '',
): void {
  // ── FTS 表迁移检测：旧版使用 external content 表（content=memory_chunks），
  // 新版使用独立表（chunk_id UNINDEXED, text）。两者 schema 不兼容，需重建。
  // CREATE VIRTUAL TABLE IF NOT EXISTS 遇到已有表会静默跳过，因此必须在 CREATE 前检测。
  migrateFtsTableIfNeeded(db);

  db.exec(`
    -- 源文件追踪
    CREATE TABLE IF NOT EXISTS memory_files (
      path     TEXT NOT NULL,
      folder   TEXT NOT NULL,
      source   TEXT NOT NULL,       -- 'memory' | 'session'
      hash     TEXT NOT NULL,
      mtime    INTEGER NOT NULL,
      size     INTEGER NOT NULL,
      PRIMARY KEY (path, folder)
    );

    -- 分块索引
    CREATE TABLE IF NOT EXISTS memory_chunks (
      id         TEXT PRIMARY KEY,
      folder     TEXT NOT NULL,
      path       TEXT NOT NULL,
      source     TEXT NOT NULL,
      start_line INTEGER NOT NULL,
      end_line   INTEGER NOT NULL,
      hash       TEXT NOT NULL,
      text       TEXT NOT NULL,
      embedding  BLOB,
      model      TEXT,
      FOREIGN KEY (path, folder) REFERENCES memory_files(path, folder) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_chunks_folder ON memory_chunks(folder);
    CREATE INDEX IF NOT EXISTS idx_chunks_path   ON memory_chunks(path, folder);

    -- FTS5 全文索引（独立表，存储分词后文本以支持中文搜索）
    -- 注意：不使用 content=memory_chunks，因为写入的是分词文本而非原始文本
    CREATE VIRTUAL TABLE IF NOT EXISTS memory_chunks_fts
      USING fts5(chunk_id UNINDEXED, text);

    -- 删除触发器（INSERT/UPDATE 由应用层手动写入分词文本，无需触发器）
    CREATE TRIGGER IF NOT EXISTS memory_chunks_ad AFTER DELETE ON memory_chunks BEGIN
      DELETE FROM memory_chunks_fts WHERE chunk_id = old.id;
    END;

    -- Embedding 缓存（按 provider+model+hash 去重，切换模型后旧缓存自动失效）
    CREATE TABLE IF NOT EXISTS embedding_cache (
      provider   TEXT NOT NULL,
      model      TEXT NOT NULL,
      hash       TEXT NOT NULL,
      embedding  BLOB NOT NULL,
      created_at INTEGER NOT NULL DEFAULT (unixepoch()),
      PRIMARY KEY (provider, model, hash)
    );

    -- 记忆元数据 KV（存储 embedding_model 标识，用于切换检测）
    CREATE TABLE IF NOT EXISTS memory_meta (
      folder TEXT NOT NULL,
      key    TEXT NOT NULL,
      value  TEXT,
      PRIMARY KEY (folder, key)
    );
  `);

  // 仅在启用 embedding 时加载 sqlite-vec 创建向量表
  if (enableVec) {
    tryCreateVecTable(db, dimensions, modelKey);
  }
}

/**
 * 构建 embedding 模型标识字符串，用于切换检测。
 * 格式："provider:model:dimensions"
 */
export function buildModelKey(provider: string, model: string, dimensions: number): string {
  return `${provider}:${model}:${dimensions}`;
}

/**
 * FTS 表迁移：检测旧版 external content 表，重建为独立表。
 *
 * 旧格式（develop 原版）：
 *   fts5(text, content=memory_chunks, content_rowid=rowid)
 * 新格式（我们）：
 *   fts5(chunk_id UNINDEXED, text)
 *
 * 检测方式：查 sqlite_master DDL，若不含 "chunk_id" 则视为旧格式。
 * 迁移代价：清空 FTS 索引 + memory_chunks（触发重新同步），但不影响其他表。
 */
function migrateFtsTableIfNeeded(db: Database.Database): void {
  const row = db.prepare(
    `SELECT sql FROM sqlite_master WHERE type='table' AND name='memory_chunks_fts'`
  ).get() as { sql: string } | undefined;

  // 表不存在（首次启动）或已是新格式：无需迁移
  if (!row || /chunk_id/i.test(row.sql)) return;

  console.log('[MemorySchema] Migrating FTS table from external-content to independent mode...');
  db.transaction(() => {
    // 删除旧触发器（AI/AU 在旧格式中存在）
    db.exec(`DROP TRIGGER IF EXISTS memory_chunks_ai`);
    db.exec(`DROP TRIGGER IF EXISTS memory_chunks_au`);
    db.exec(`DROP TRIGGER IF EXISTS memory_chunks_ad`);
    // 重建 FTS 表
    db.exec(`DROP TABLE IF EXISTS memory_chunks_fts`);
    // 清空 chunks（下次 syncFolder 会重新索引）
    db.exec(`DELETE FROM memory_chunks`);
    db.exec(`DELETE FROM memory_files`);
  })();
  console.log('[MemorySchema] FTS migration done. Files will be re-indexed on next startup.');
}

/** sqlite-vec 可选：加载失败不影响 FTS 功能 */
function tryCreateVecTable(db: Database.Database, dimensions: number, modelKey: string): void {
  // ── 模型切换检测：检测到不同模型时自动清空旧 embedding，不抛异常 ──
  // 设计原则：单进程场景（用户换模型重启）应自动迁移；
  // 多 Agent 并发写同一 DB 使用不同模型属于配置错误，靠文档约束而非运行时崩溃。
  if (modelKey) {
    const storedRow = db.prepare(
      `SELECT value FROM memory_meta WHERE folder = '__global__' AND key = 'embedding_model'`
    ).get() as { value: string } | undefined;
    const storedKey = storedRow?.value ?? '';

    if (storedKey && storedKey !== modelKey) {
      // 模型已切换：清空旧 embedding 数据，下次 syncFolder 会重新生成
      console.log(`[MemorySchema] Embedding model changed (${storedKey} → ${modelKey}), clearing old embeddings...`);
      db.transaction(() => {
        db.exec(`UPDATE memory_chunks SET embedding = NULL, model = NULL`);
        db.exec(`DELETE FROM memory_meta WHERE key = 'embedding_model' AND folder = '__global__'`);
        try { db.exec(`DROP TABLE IF EXISTS memory_chunks_vec`); } catch { /* ok */ }
      })();
    }
  }

  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const sqliteVec = require('sqlite-vec');
    sqliteVec.load(db);

    // ── 迁移检测 1：旧表使用 L2 距离（无 distance_metric=cosine）→ 重建 ──
    const existingDdl = db.prepare(
      `SELECT sql FROM sqlite_master WHERE type='table' AND name='memory_chunks_vec'`
    ).get() as { sql: string } | undefined;

    if (existingDdl && !/distance_metric\s*=\s*cosine/i.test(existingDdl.sql)) {
      db.transaction(() => {
        db.exec(`DROP TABLE IF EXISTS memory_chunks_vec`);
        db.exec(`UPDATE memory_chunks SET embedding = NULL, model = NULL`);
        db.exec(`DELETE FROM memory_meta WHERE key = 'embedding_model' AND folder = '__global__'`);
      })();
      console.log('[MemorySchema] Migrated memory_chunks_vec to cosine distance metric');
    }

    // ── 迁移检测 2：模型标识更新（冲突已在外层检测）──
    if (modelKey) {
      // 首次设置或模型一致：更新模型标识
      db.prepare(
        `INSERT OR REPLACE INTO memory_meta (folder, key, value) VALUES ('__global__', 'embedding_model', ?)`
      ).run(modelKey);
    }

    // 使用动态维度 + cosine 距离创建向量表
    db.exec(`
      CREATE VIRTUAL TABLE IF NOT EXISTS memory_chunks_vec
        USING vec0(chunk_id TEXT PRIMARY KEY, embedding float[${dimensions}] distance_metric=cosine);
    `);
    console.log(`[MemorySchema] Vector table ready (${dimensions}d, cosine)`);
  } catch (err) {
    console.warn('[MemorySchema] sqlite-vec not available, vector search disabled (FTS only)', err);
  }
}

/**
 * 清理 embedding 缓存（P1 修复）
 *
 * 用途：
 * - 清理特定 provider/model 的缓存
 * - 清理所有缓存
 * - 定期清理旧缓存
 *
 * @param db 数据库连接
 * @param provider 可选，指定 provider（如 'local', 'openai'）
 * @param model 可选，指定 model（如 'all-MiniLM-L6-v2'）
 * @returns 删除的缓存条目数量
 *
 * @example
 * // 清理特定模型的缓存
 * cleanupEmbeddingCache(db, 'local', 'all-MiniLM-L6-v2');
 *
 * // 清理特定 provider 的所有缓存
 * cleanupEmbeddingCache(db, 'local');
 *
 * // 清理所有缓存
 * cleanupEmbeddingCache(db);
 */
export function cleanupEmbeddingCache(
  db: Database.Database,
  provider?: string,
  model?: string
): number {
  let sql = 'DELETE FROM embedding_cache';
  const params: string[] = [];

  if (provider && model) {
    sql += ' WHERE provider = ? AND model = ?';
    params.push(provider, model);
  } else if (provider) {
    sql += ' WHERE provider = ?';
    params.push(provider);
  }
  // 如果都不提供，删除所有缓存

  const result = db.prepare(sql).run(...params);
  return result.changes;
}

/**
 * 获取 embedding 缓存统计信息（P1 辅助功能）
 *
 * @param db 数据库连接
 * @returns 缓存统计信息数组，每个元素包含 provider, model, count, totalSize
 */
export function getEmbeddingCacheStats(
  db: Database.Database
): Array<{ provider: string; model: string; count: number; totalSize: number }> {
  const rows = db.prepare(`
    SELECT
      provider,
      model,
      COUNT(*) as count,
      SUM(LENGTH(embedding)) as totalSize
    FROM embedding_cache
    GROUP BY provider, model
    ORDER BY totalSize DESC
  `).all() as Array<{ provider: string; model: string; count: number; totalSize: number }>;

  return rows;
}
