/**
 * MemoryTool MCP 服务器进程（所有群组可用）
 *
 * 通过 stdio 接入 sema-core。提供记忆检索工具（只读）。
 * 写入由 Agent 通过 sema-core Write/Edit 工具直接操作 MEMORY.md。
 *
 * 环境变量：
 *   SEMACLAW_DB_PATH     — SQLite 数据库路径
 *   SEMACLAW_FOLDER      — agent folder 名
 *   SEMACLAW_AGENTS_DIR  — agents 根目录
 *
 * 工具：
 *   memory_search — 语义/全文搜索记忆（MEMORY.md + 每日日志 + 会话）
 *   memory_get    — 按路径+行范围精确读取记忆文件片段
 */

import Database from 'better-sqlite3';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { applyMemorySchema, buildModelKey } from '../memory/memory-schema';
import { hybridSearch } from '../memory/fts-search';
import { createEmbeddingProvider, type EmbeddingConfig } from '../memory/embedding';
import { resolveDimensions } from '../db/db';
import * as fs from 'fs';
import * as path from 'path';

// ===== 环境变量 =====

const dbPath = process.env.SEMACLAW_DB_PATH;
const folder = process.env.SEMACLAW_FOLDER;
const agentsDir = process.env.SEMACLAW_AGENTS_DIR;

if (!dbPath || !folder || !agentsDir) {
  console.error('[memory-server] Missing required env vars: SEMACLAW_DB_PATH, SEMACLAW_FOLDER, SEMACLAW_AGENTS_DIR');
  process.exit(1);
}

// 打开数据库（搜索为主）
const db = new Database(dbPath, { readonly: false });
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

// 可选 embedding provider
const embeddingCfg: EmbeddingConfig = {
  provider: (process.env.SEMACLAW_EMBEDDING_PROVIDER as any) || 'none',
  openaiApiKey: process.env.SEMACLAW_OPENAI_API_KEY,
  openaiBaseUrl: process.env.SEMACLAW_OPENAI_BASE_URL,
  openaiModel: process.env.SEMACLAW_OPENAI_MODEL,
  openrouterApiKey: process.env.SEMACLAW_OPENROUTER_API_KEY,
  openrouterBaseUrl: process.env.SEMACLAW_OPENROUTER_BASE_URL,
  openrouterModel: process.env.SEMACLAW_OPENROUTER_MODEL,
  ollamaBaseUrl: process.env.SEMACLAW_OLLAMA_BASE_URL,
  ollamaModel: process.env.SEMACLAW_OLLAMA_MODEL,
  localModelPath: process.env.SEMACLAW_LOCAL_MODEL_PATH,
  localModel: process.env.SEMACLAW_LOCAL_MODEL,
};

// 构建 modelKey 并初始化 schema（支持动态维度 + 模型切换检测）
const _provider = embeddingCfg.provider;
const enableVec = _provider !== 'none';
const _configuredDim = parseInt(process.env.SEMACLAW_EMBEDDING_DIMENSIONS || '0', 10);
const dimensions = resolveDimensions(_provider, _configuredDim);
const _modelName = _provider === 'openrouter' ? (embeddingCfg.openrouterModel || '')
  : _provider === 'ollama' ? (embeddingCfg.ollamaModel || '')
  : _provider === 'local' ? (embeddingCfg.localModel || 'default')
  : _provider === 'openai' ? (embeddingCfg.openaiModel || 'text-embedding-3-small')
  : '';
const modelKey = enableVec ? buildModelKey(_provider, _modelName, dimensions) : '';
try {
  applyMemorySchema(db, enableVec, dimensions, modelKey);
} catch (e) {
  console.error('[memory-server] applyMemorySchema failed, memory search will be unavailable:', e);
}

const embeddingProvider = createEmbeddingProvider(embeddingCfg, db);

// ===== MCP 服务器 =====

const server = new McpServer({ name: 'semaclaw-memory', version: '2.0.0' });
// Cast to any to avoid TS2589 caused by MCP SDK's deep zod type inference
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const srv = server as any;

// memory_search
srv.registerTool(
  'memory_search',
  {
    description: [
      'Search memory files (MEMORY.md, daily conversation logs, session history).',
      'Returns relevant text chunks with file path and line range.',
      'Use this to recall past conversations, find facts, or get context.',
      'After finding relevant results, use memory_get to read the full context.',
    ].join('\n'),
    inputSchema: {
      query: z.string().min(1).describe('Search keywords or natural language query'),
      maxResults: z.number().min(1).max(20).optional().describe('Max results to return (default: 6)'),
      source: z.enum(['memory', 'session', 'all']).optional().describe('Filter by source type (default: all)'),
    },
  },
  async ({ query, maxResults, source }: {
    query: string;
    maxResults?: number;
    source?: 'memory' | 'session' | 'all';
  }) => {
    const limit = maxResults ?? 6;
    const rawResults = await hybridSearch(db, folder!, query, embeddingProvider, {
      maxResults: limit + 3, // 多取几条，排除当天文件后仍能返回足够结果
      source: source ?? 'all',
    });

    // 排除当天日志文件（实时写入，内容未稳定，会污染搜索结果）
    const todayFile = new Date().toISOString().slice(0, 10) + '.md';
    const results = rawResults
      .filter(r => !r.path.endsWith(todayFile))
      .slice(0, limit);

    if (results.length === 0) {
      return { content: [{ type: 'text' as const, text: 'No matching memories found.' }] };
    }

    let out = `Found ${results.length} results:\n\n`;
    for (let i = 0; i < results.length; i++) {
      const r = results[i];
      // 显示相对路径
      const pathParts = r.path.split(/[\\/]/);
      const displayPath = pathParts.slice(-2).join('/');
      out += `[${i + 1}] ${displayPath}:${r.startLine}-${r.endLine} (score: ${r.score.toFixed(2)})\n`;
      // 摘要：前 300 字符
      const summary = r.text.length > 300 ? r.text.slice(0, 300) + '...' : r.text;
      out += `${summary}\n\n`;
    }

    return { content: [{ type: 'text' as const, text: out.trim() }] };
  }
);

// memory_get
srv.registerTool(
  'memory_get',
  {
    description: [
      'Read a specific section of a memory file by path and line range.',
      'Use memory_search first to find relevant locations, then use this to read full context.',
      'Path is relative to agent memory directory (e.g., "MEMORY.md", "2026-03-09.md", "memory/2026-03-09.md").',
    ].join('\n'),
    inputSchema: {
      path: z.string().min(1).describe('File path relative to agent directory (e.g., "MEMORY.md" or "2026-03-09.md")'),
      startLine: z.number().min(1).optional().describe('Start line number (1-based, default: 1)'),
      endLine: z.number().min(1).optional().describe('End line number (inclusive, default: end of file)'),
    },
  },
  async ({ path: relPath, startLine, endLine }: {
    path: string;
    startLine?: number;
    endLine?: number;
  }) => {
    const absPath = resolveMemoryPath(folder!, relPath);
    if (!absPath || !fs.existsSync(absPath)) {
      return { content: [{ type: 'text' as const, text: `File not found: ${relPath}` }] };
    }

    try {
      const content = fs.readFileSync(absPath, 'utf8');
      const lines = content.split('\n');
      const totalLines = lines.length;

      const start = Math.max((startLine ?? 1) - 1, 0);
      const end = endLine ? Math.min(endLine, totalLines) : totalLines;

      const slice = lines.slice(start, end);
      const header = `${relPath} (lines ${start + 1}-${end} of ${totalLines}):\n\n`;

      return { content: [{ type: 'text' as const, text: header + slice.join('\n') }] };
    } catch (e) {
      return { content: [{ type: 'text' as const, text: `Error reading file: ${e}` }] };
    }
  }
);

// ===== 路径解析 =====

function resolveMemoryPath(folder: string, relativePath: string): string | null {
  const agentDir = path.resolve(path.join(agentsDir!, folder));
  // 安全检查必须在 existsSync 之前，防止路径穿越（../../etc/passwd 等）
  const safeCheck = (p: string) => p.startsWith(agentDir + path.sep) || p === agentDir;

  // 尝试直接拼接
  const c1 = path.resolve(agentDir, relativePath);
  if (safeCheck(c1) && fs.existsSync(c1)) return c1;

  // 尝试 memory/ 子目录
  const c2 = path.resolve(agentDir, 'memory', relativePath);
  if (safeCheck(c2) && fs.existsSync(c2)) return c2;

  // 文件不存在时返回安全路径（供调用方判断）
  if (safeCheck(c1)) return c1;

  return null;
}

// ===== 启动 =====

(async () => {
  const transport = new StdioServerTransport();
  await server.connect(transport);
})();
