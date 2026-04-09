/**
 * MemoryManager — 记忆系统核心管理器
 *
 * 职责：
 *   1. 文件扫描 + 增量同步（hash 比对 → 分块 → FTS/embedding 索引）
 *   2. 混合搜索（FTS5 + 可选 embedding）
 *   3. 文件监听（MEMORY.md + memory/*.md 变更自动重索引）
 *   4. 为 AgentPool pre-retrieval 提供搜索接口
 *
 * 记忆来源：
 *   - memory: MEMORY.md + memory/*.md（每日对话日志）
 *   - session: ~/.sema/history/ 下的会话 JSON
 */

import * as fs from 'fs';
import * as path from 'path';
import { createHash, randomUUID } from 'crypto';
import type Database from 'better-sqlite3';
import { chunkText, type ChunkerOptions } from './chunker';
import { hybridSearch, type SearchResult, type SearchOptions } from './fts-search';
import { createEmbeddingProvider, type EmbeddingProvider, type EmbeddingConfig } from './embedding';
import { tokenizeOptimized } from './tokenizer';

// ===== 类型 =====

export interface MemoryManagerConfig {
  agentsDir: string;
  embeddingConfig: EmbeddingConfig;
  chunkerOptions?: ChunkerOptions;
}

interface FileRecord {
  path: string;
  folder: string;
  source: string;
  hash: string;
  mtime: number;
  size: number;
}

// ===== 单例 =====

let _instance: MemoryManager | null = null;

export class MemoryManager {
  private embeddingProvider: EmbeddingProvider | null = null;
  private watchers = new Map<string, () => void>(); // folder → cleanup fn
  private dirtyFolders = new Set<string>();
  private dirtyFiles = new Map<string, Set<string>>(); // folder → changed file paths
  private syncDebounceTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private chunkerOptions: ChunkerOptions;
  private agentsDir: string;

  // Prepared statements (lazily created)
  private stmts!: ReturnType<typeof this.prepareStatements>;

  private constructor(
    private db: Database.Database,
    cfg: MemoryManagerConfig,
  ) {
    this.agentsDir = cfg.agentsDir;
    this.chunkerOptions = cfg.chunkerOptions ?? {};
    this.embeddingProvider = createEmbeddingProvider(cfg.embeddingConfig, db);
    this.stmts = this.prepareStatements();
  }

  static init(db: Database.Database, cfg: MemoryManagerConfig): MemoryManager {
    if (_instance) return _instance;
    _instance = new MemoryManager(db, cfg);
    return _instance;
  }

  static getInstance(): MemoryManager {
    if (!_instance) throw new Error('MemoryManager not initialized. Call MemoryManager.init() first.');
    return _instance;
  }

  // ===== Prepared Statements =====

  private prepareStatements() {
    return {
      getFile: this.db.prepare<[string, string]>(
        'SELECT * FROM memory_files WHERE path = ? AND folder = ?'
      ),
      upsertFile: this.db.prepare(
        `INSERT INTO memory_files (path, folder, source, hash, mtime, size)
         VALUES (@path, @folder, @source, @hash, @mtime, @size)
         ON CONFLICT(path, folder) DO UPDATE SET
           hash = excluded.hash, mtime = excluded.mtime, size = excluded.size`
      ),
      deleteFile: this.db.prepare<[string, string]>(
        'DELETE FROM memory_files WHERE path = ? AND folder = ?'
      ),
      deleteChunksByPath: this.db.prepare<[string, string]>(
        'DELETE FROM memory_chunks WHERE path = ? AND folder = ?'
      ),
      insertChunk: this.db.prepare(
        `INSERT INTO memory_chunks (id, folder, path, source, start_line, end_line, hash, text, embedding, model)
         VALUES (@id, @folder, @path, @source, @startLine, @endLine, @hash, @text, @embedding, @model)`
      ),
      insertChunkFts: this.db.prepare(
        'INSERT INTO memory_chunks_fts (chunk_id, text) VALUES (?, ?)'
      ),
      listFiles: this.db.prepare<[string]>(
        'SELECT * FROM memory_files WHERE folder = ?'
      ),
      getChunk: this.db.prepare<[string, string, number, number]>(
        `SELECT text FROM memory_chunks
         WHERE folder = ? AND path = ? AND start_line <= ? AND end_line >= ?
         ORDER BY start_line LIMIT 1`
      ),
    };
  }

  // ===== 公开接口 =====

  /**
   * 初始化 agent 的记忆索引：全量扫描 + 启动文件监听。
   */
  async initAgent(folder: string): Promise<void> {
    console.log(`[MemoryManager] initAgent(${folder}): syncFolder starting...`);
    await this.syncFolder(folder);
    console.log(`[MemoryManager] initAgent(${folder}): syncFolder done, startWatching...`);
    this.startWatching(folder);
    console.log(`[MemoryManager] initAgent(${folder}): done`);
  }

  /**
   * 搜索记忆。
   */
  async search(folder: string, query: string, options?: SearchOptions): Promise<SearchResult[]> {
    // 搜索前同步 dirty 文件
    if (this.dirtyFolders.has(folder)) {
      this.dirtyFolders.delete(folder);
      const changedFiles = this.dirtyFiles.get(folder);
      this.dirtyFiles.delete(folder);
      if (changedFiles && changedFiles.size > 0) {
        // 增量同步：只处理变化的文件
        for (const absPath of changedFiles) {
          const existing = (this.stmts.getFile.get(absPath, folder) as FileRecord | undefined);
          const source = absPath.includes(`${path.sep}memory${path.sep}`) ? 'memory' : 'session';
          await this.syncFile(absPath, folder, source, existing);
        }
      } else {
        // 未知哪些文件变了，全量扫描
        await this.syncFolder(folder);
      }
    }
    return hybridSearch(this.db, folder, query, this.embeddingProvider, options);
  }

  /**
   * 按路径+行范围读取记忆文件片段。
   */
  readFile(folder: string, relativePath: string, startLine?: number, endLine?: number): string | null {
    const absPath = this.resolveMemoryPath(folder, relativePath);
    if (!absPath || !fs.existsSync(absPath)) return null;

    try {
      const content = fs.readFileSync(absPath, 'utf8');
      const lines = content.split('\n');

      const start = Math.max((startLine ?? 1) - 1, 0);
      const end = endLine ? Math.min(endLine, lines.length) : lines.length;

      return lines.slice(start, end).join('\n');
    } catch {
      return null;
    }
  }

  /**
   * 标记 folder 为 dirty，下次搜索前会重新同步。
   * 可选传入变化文件路径，避免全量扫描。
   */
  markDirty(folder: string, changedFile?: string): void {
    this.dirtyFolders.add(folder);
    if (changedFile) {
      if (!this.dirtyFiles.has(folder)) this.dirtyFiles.set(folder, new Set());
      this.dirtyFiles.get(folder)!.add(changedFile);
    }
  }

  /**
   * 停止监听并清理资源。
   */
  destroyAgent(folder: string): void {
    const cleanup = this.watchers.get(folder);
    if (cleanup) {
      cleanup();
      this.watchers.delete(folder);
    }
    const timer = this.syncDebounceTimers.get(folder);
    if (timer) {
      clearTimeout(timer);
      this.syncDebounceTimers.delete(folder);
    }
  }

  /**
   * 全局清理。
   */
  destroy(): void {
    for (const [folder] of this.watchers) {
      this.destroyAgent(folder);
    }
  }

  // ===== 同步逻辑 =====

  /**
   * 全量同步指定 agent 的记忆文件。
   */
  private async syncFolder(folder: string): Promise<void> {
    const agentDir = path.join(this.agentsDir, folder);
    const memoryDir = path.join(agentDir, 'memory');

    // 收集当前磁盘上的文件
    const diskFiles = new Map<string, { absPath: string; source: string }>();

    // MEMORY.md
    const memoryMdPath = path.join(agentDir, 'MEMORY.md');
    if (fs.existsSync(memoryMdPath)) {
      diskFiles.set(memoryMdPath, { absPath: memoryMdPath, source: 'memory' });
    }

    // memory/*.md
    if (fs.existsSync(memoryDir)) {
      for (const file of fs.readdirSync(memoryDir)) {
        if (file.endsWith('.md')) {
          const absPath = path.join(memoryDir, file);
          diskFiles.set(absPath, { absPath, source: 'memory' });
        }
      }
    }

    console.log(`[MemoryManager] syncFolder(${folder}): ${diskFiles.size} disk files found`);

    // 对比 DB 中已索引的文件
    const dbFiles = this.stmts.listFiles.all(folder) as FileRecord[];
    const dbFileMap = new Map(dbFiles.map(f => [f.path, f]));
    console.log(`[MemoryManager] syncFolder(${folder}): ${dbFiles.length} DB files, syncing...`);

    // 删除 DB 中有但磁盘上已不存在的文件
    for (const dbFile of dbFiles) {
      if (!diskFiles.has(dbFile.path)) {
        this.removeFile(dbFile.path, folder);
      }
    }

    // 逐文件检查 hash，变化时重新分块
    let synced = 0;
    for (const [absPath, { source }] of diskFiles) {
      const existing = dbFileMap.get(absPath);
      await this.syncFile(absPath, folder, source, existing);
      synced++;
    }
    console.log(`[MemoryManager] syncFolder(${folder}): done, ${synced} files synced`);
  }

  /**
   * 同步单个文件：hash 不变跳过，变化时重新分块。
   */
  private async syncFile(
    absPath: string,
    folder: string,
    source: string,
    existing: FileRecord | undefined,
  ): Promise<void> {
    let stat: fs.Stats;
    try {
      stat = fs.statSync(absPath);
    } catch {
      if (existing) this.removeFile(absPath, folder);
      return;
    }

    let content: string;
    try {
      content = fs.readFileSync(absPath, 'utf8');
    } catch {
      // stat 成功但读取失败（TOCTOU），跳过
      return;
    }
    const hash = createHash('sha256').update(content).digest('hex');

    // hash 相同 → 无需更新
    if (existing && existing.hash === hash) {
      return;
    }

    // 删除旧 chunks
    this.removeChunks(absPath, folder);

    // 分块
    const rawChunks = chunkText(content, this.chunkerOptions);
    if (rawChunks.length === 0) return;

    // 生成 embedding（如果有 provider）
    let embeddings: Float32Array[] | null = null;
    if (this.embeddingProvider) {
      try {
        embeddings = await this.embeddingProvider.embed(rawChunks.map(c => c.text));
      } catch (e) {
        console.warn(`[MemoryManager] Embedding failed for ${absPath}, indexing without vectors:`, e);
      }
    }

    // 批量写入
    const insertMany = this.db.transaction(() => {
      // 更新文件记录
      this.stmts.upsertFile.run({
        path: absPath,
        folder,
        source,
        hash,
        mtime: Math.floor(stat.mtimeMs),
        size: stat.size,
      });

      // 写入 chunks
      for (let i = 0; i < rawChunks.length; i++) {
        const chunk = rawChunks[i];
        const chunkHash = createHash('sha256').update(chunk.text).digest('hex');
        const id = randomUUID();
        const embeddingBuf = embeddings?.[i]
          ? Buffer.from(embeddings[i].buffer, embeddings[i].byteOffset, embeddings[i].byteLength)
          : null;

        this.stmts.insertChunk.run({
          id,
          folder,
          path: absPath,
          source,
          startLine: chunk.startLine,
          endLine: chunk.endLine,
          hash: chunkHash,
          text: chunk.text,
          embedding: embeddingBuf,
          model: this.embeddingProvider?.model ?? null,
        });

        // 写入 FTS（独立表，存分词后文本以支持 Jieba 中文检索）
        // 注意：此处 removeStopwords=false（保留停用词），与查询时 =true 不对称，属于有意设计：
        //   - 索引阶段保留全量 token，避免因停用词过滤导致内容漏索引（例如"的确"被拆成"的"+"确"后"的"是停用词）
        //   - 查询阶段过滤停用词，减少噪声 token，提升 BM25 排序精度
        const tokenizedText = tokenizeOptimized(chunk.text, false).join(' ');
        this.stmts.insertChunkFts.run(id, tokenizedText);

        // 写入 sqlite-vec（如果可用）
        if (embeddingBuf) {
          this.tryInsertVec(id, embeddingBuf);
        }
      }
    });

    insertMany();
  }

  private removeFile(absPath: string, folder: string): void {
    this.removeChunks(absPath, folder);
    this.stmts.deleteFile.run(absPath, folder);
  }

  private removeChunks(absPath: string, folder: string): void {
    // 先删除 vec 表中的对应条目
    try {
      const chunkIds = this.db.prepare(
        'SELECT id FROM memory_chunks WHERE path = ? AND folder = ?'
      ).all(absPath, folder) as Array<{ id: string }>;

      if (chunkIds.length > 0) {
        const BATCH = 500;
        try {
          for (let i = 0; i < chunkIds.length; i += BATCH) {
            const batch = chunkIds.slice(i, i + BATCH);
            const placeholders = batch.map(() => '?').join(',');
            this.db.prepare(`DELETE FROM memory_chunks_vec WHERE chunk_id IN (${placeholders})`)
              .run(...batch.map(r => r.id));
          }
        } catch { /* vec table may not exist */ }
      }
    } catch { /* ignore */ }

    this.stmts.deleteChunksByPath.run(absPath, folder);
  }

  private tryInsertVec(chunkId: string, embeddingBuf: Buffer): void {
    try {
      this.db.prepare(
        'INSERT INTO memory_chunks_vec (chunk_id, embedding) VALUES (?, ?)'
      ).run(chunkId, embeddingBuf);
    } catch { /* vec table not available */ }
  }

  // ===== 文件监听 =====

  private startWatching(folder: string): void {
    if (this.watchers.has(folder)) return;

    const agentDir = path.join(this.agentsDir, folder);
    const memoryMdPath = path.join(agentDir, 'MEMORY.md');
    const memoryDir = path.join(agentDir, 'memory');

    const pendingFiles = new Set<string>();

    const onFileChange = (absPath: string) => {
      // 将变更文件加入集合，防抖 1.5s 后批量同步
      pendingFiles.add(absPath);
      const existing = this.syncDebounceTimers.get(folder);
      if (existing) clearTimeout(existing);

      this.syncDebounceTimers.set(folder, setTimeout(() => {
        this.syncDebounceTimers.delete(folder);
        const filesToSync = [...pendingFiles];
        pendingFiles.clear();
        for (const p of filesToSync) {
          const dbRecord = this.stmts.getFile.get(p, folder) as FileRecord | undefined;
          const source = p.includes(`${path.sep}memory${path.sep}`) ? 'memory' : 'session';
          this.syncFile(p, folder, source, dbRecord).catch(e => {
            console.warn(`[MemoryManager] Sync failed for ${folder}/${path.basename(p)}:`, e);
          });
        }
      }, 1500));
    };

    // 监听 MEMORY.md
    const memoryMdHandler = (curr: fs.Stats, prev: fs.Stats) => {
      if (curr.mtimeMs !== prev.mtimeMs) onFileChange(memoryMdPath);
    };
    fs.watchFile(memoryMdPath, { interval: 1500, persistent: false }, memoryMdHandler);

    // 监听 memory/ 目录下的 .md 文件
    let dirWatcher: fs.FSWatcher | null = null;
    try {
      fs.mkdirSync(memoryDir, { recursive: true });
      dirWatcher = fs.watch(memoryDir, (_eventType, filename) => {
        if (filename && filename.endsWith('.md')) {
          onFileChange(path.join(memoryDir, filename));
        }
      });
    } catch { /* dir may not exist */ }

    this.watchers.set(folder, () => {
      fs.unwatchFile(memoryMdPath, memoryMdHandler);
      dirWatcher?.close();
    });
  }

  // ===== 路径解析 =====

  /**
   * 解析相对路径到绝对路径（限制在 agent 目录下）。
   * 支持格式：
   *   - "MEMORY.md" → agents/{folder}/MEMORY.md
   *   - "2026-03-09.md" → agents/{folder}/memory/2026-03-09.md
   *   - "memory/2026-03-09.md" → agents/{folder}/memory/2026-03-09.md
   */
  private resolveMemoryPath(folder: string, relativePath: string): string | null {
    const agentDir = path.join(this.agentsDir, folder);
    const safeCheck = (p: string) => p.startsWith(agentDir + path.sep) || p === agentDir;

    // 尝试直接拼接（安全检查前置）
    let candidate = path.resolve(agentDir, relativePath);
    if (!safeCheck(candidate)) return null;
    if (fs.existsSync(candidate)) return candidate;

    // 尝试 memory/ 子目录
    candidate = path.resolve(agentDir, 'memory', relativePath);
    if (!safeCheck(candidate)) return null;
    if (fs.existsSync(candidate)) return candidate;

    return null;
  }
}

// ===== Pre-Retrieval 格式化 =====

/**
 * 格式化搜索结果为 prompt 注入内容。
 */
export function formatSearchResults(results: SearchResult[]): string {
  if (results.length === 0) return '';

  const lines: string[] = ['Relevant memories:'];
  for (let i = 0; i < results.length; i++) {
    const r = results[i];
    const pathParts = r.path.split(/[\\/]/);
    const displayPath = pathParts.slice(-2).join('/');
    lines.push(`[${i + 1}] ${displayPath}:${r.startLine}-${r.endLine} (score: ${r.score.toFixed(2)})`);
    // 截取前 200 字符的摘要
    const summary = r.text.length > 200
      ? r.text.slice(0, 200) + '...'
      : r.text;
    lines.push(summary);
    lines.push('');
  }

  return lines.join('\n').trim();
}
