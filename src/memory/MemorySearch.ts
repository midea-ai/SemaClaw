/**
 * MemorySearch — 记忆检索共享模块
 *
 * 同时供以下两处使用：
 *   1. memory-server.ts（MCP 子进程）— memory_search 工具调用
 *   2. AgentPool.ts（主进程）— 每次 processAndWait 前的自动 pre-retrieval
 *
 * 存储结构：
 *   memory/memories.json   — 结构化记忆（MemoryEntry 数组）
 *   memory/YYYY-MM-DD.md   — 每日对话日志（DailyLogger 写入）
 */

import * as fs from 'fs';
import * as path from 'path';

// ===== 数据结构 =====

export interface MemoryEntry {
  id: string;
  content: string;
  created: string;  // ISO 时间
  hits: number;
  last_hit: string; // ISO 时间
}

const MEMORIES_FILE = 'memories.json';
export const MAX_MEMORIES = 100;

/** 最近多少天的 DailyLog 参与搜索 */
const DAILY_SEARCH_DAYS = 7;

const DATE_FILE_RE = /^(\d{4}-\d{2}-\d{2})\.md$/;

// ===== memories.json 读写 =====

export function readMemories(memoryDir: string): MemoryEntry[] {
  const filePath = path.join(memoryDir, MEMORIES_FILE);
  try {
    if (!fs.existsSync(filePath)) return [];
    return JSON.parse(fs.readFileSync(filePath, 'utf8')) as MemoryEntry[];
  } catch {
    return [];
  }
}

export function writeMemories(memoryDir: string, entries: MemoryEntry[]): void {
  fs.mkdirSync(memoryDir, { recursive: true });
  fs.writeFileSync(
    path.join(memoryDir, MEMORIES_FILE),
    JSON.stringify(entries, null, 2),
    'utf8',
  );
}

// ===== 淘汰策略 =====

/**
 * 淘汰评分：越高越应保留。
 * score = hits / (距上次命中天数 + 1)
 */
function retentionScore(entry: MemoryEntry): number {
  const daysSince = (Date.now() - new Date(entry.last_hit).getTime()) / 86_400_000;
  return entry.hits / (daysSince + 1);
}

/**
 * 若超出 MAX_MEMORIES，淘汰评分最低的条目。
 * 返回保留后的数组（不修改原数组）。
 */
export function evictIfNeeded(entries: MemoryEntry[]): MemoryEntry[] {
  if (entries.length <= MAX_MEMORIES) return entries;
  const sorted = [...entries].sort((a, b) => retentionScore(b) - retentionScore(a));
  return sorted.slice(0, MAX_MEMORIES);
}

// ===== 关键词匹配 =====

function tokenize(text: string): string[] {
  // 切词：英文按空格，中文按字（2 字以上）
  return text
    .toLowerCase()
    .split(/[\s，。！？、,.!?;；:：\n]+/)
    .filter(t => t.length >= 1);
}

function matchesTokens(text: string, tokens: string[]): boolean {
  const lower = text.toLowerCase();
  return tokens.some(t => lower.includes(t));
}

// ===== memories.json 搜索 =====

export interface MemorySearchResult {
  id: string;
  content: string;
  created: string;
  hits: number;
}

/**
 * 在 memories.json 中搜索，命中时自动更新 hits + last_hit。
 * 返回按命中率降序排列的结果（最多 topN 条）。
 */
export function searchMemories(
  memoryDir: string,
  query: string,
  topN = 5,
): MemorySearchResult[] {
  const tokens = tokenize(query);
  if (tokens.length === 0) return [];

  const entries = readMemories(memoryDir);
  const hitIds = new Set<string>();
  const matched: MemoryEntry[] = [];

  for (const e of entries) {
    if (matchesTokens(e.content, tokens)) {
      hitIds.add(e.id);
      matched.push(e);
    }
  }

  if (matched.length === 0) return [];

  // 更新命中统计
  const now = new Date().toISOString();
  writeMemories(
    memoryDir,
    entries.map(e =>
      hitIds.has(e.id) ? { ...e, hits: e.hits + 1, last_hit: now } : e
    ),
  );

  return matched
    .sort((a, b) => b.hits - a.hits)
    .slice(0, topN)
    .map(e => ({ id: e.id, content: e.content, created: e.created, hits: e.hits + 1 }));
}

// ===== DailyLog 搜索 =====

export interface DailyLogResult {
  date: string;
  section: string; // ## HH:MM 开头的段落
}

/**
 * 搜索最近 DAILY_SEARCH_DAYS 天的对话日志。
 * 按 ## 标题切片，逐片匹配，最多返回 topN 片。
 */
export function searchDailyLogs(
  memoryDir: string,
  query: string,
  topN = 3,
): DailyLogResult[] {
  const tokens = tokenize(query);
  if (tokens.length === 0) return [];

  const results: DailyLogResult[] = [];

  try {
    const files = fs.readdirSync(memoryDir)
      .filter(f => DATE_FILE_RE.test(f))
      .sort()
      .slice(-DAILY_SEARCH_DAYS);

    for (const file of files) {
      const m = DATE_FILE_RE.exec(file);
      if (!m) continue;
      const date = m[1];

      const raw = fs.readFileSync(path.join(memoryDir, file), 'utf8');
      // 按 "## " 行切分（跳过第一行的 # 标题）
      const sections = raw.split(/\n(?=## )/);

      for (const sec of sections) {
        if (!sec.startsWith('##')) continue;
        if (matchesTokens(sec, tokens)) {
          results.push({ date, section: sec.trim() });
          if (results.length >= topN) return results;
        }
      }
    }
  } catch {
    // ignore
  }

  return results;
}

// ===== prompt 注入格式化 =====

/**
 * 把搜索结果格式化为注入 prompt 的 <memory> 内容字符串。
 * 若无结果返回空字符串。
 */
export function formatMemoryContext(
  memories: MemorySearchResult[],
  dailyLogs: DailyLogResult[],
): string {
  if (memories.length === 0 && dailyLogs.length === 0) return '';

  let out = '';

  if (memories.length > 0) {
    out += 'Relevant memories:\n';
    for (const m of memories) {
      out += `- [${m.created.slice(0, 10)}] ${m.content}\n`;
    }
  }

  if (dailyLogs.length > 0) {
    if (out) out += '\n';
    out += 'Recent activity:\n';
    for (const d of dailyLogs) {
      out += `[${d.date}]\n${d.section}\n\n`;
    }
  }

  return out.trim();
}
