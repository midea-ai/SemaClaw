/**
 * FTS + 向量混合搜索（优化版 V2 — 停用词过滤 + 查询改写）
 *
 * 优化点：
 * 1. 集成 Jieba 中文分词
 * 2. 改进 tokenize() 函数，支持中英混合
 * 3. 改进 Keyword Fallback 层，使用 2-gram 匹配
 * 4. 停用词过滤（V2 新增）
 * 5. 查询改写（V2 新增）
 *
 * 检索策略（渐进回退）：
 *   1. 有 embedding → 混合搜索（向量 0.7 + FTS 0.3）
 *   2. 无 embedding 或失败 → FTS5 全文搜索
 *   3. FTS 无结果 → 关键词子串匹配（兜底）
 */

import type Database from 'better-sqlite3';
import type { EmbeddingProvider } from './embedding';
import { tokenizeOptimized, generate2gram } from './tokenizer';
import { smartRewriteQuery, expandQueryTokens } from './query-rewrite';

// ===== 类型 =====

export interface SearchResult {
  id: string;
  path: string;
  startLine: number;
  endLine: number;
  text: string;
  score: number;
  source: string;
}

export interface SearchOptions {
  maxResults?: number;
  minScore?: number;
  source?: 'memory' | 'session' | 'all';
}

// ===== 主搜索函数 =====

/**
 * 混合搜索：根据是否有 embedding provider 选择策略。
 */
export async function hybridSearch(
  db: Database.Database,
  folder: string,
  query: string,
  embeddingProvider: EmbeddingProvider | null,
  options: SearchOptions = {},
): Promise<SearchResult[]> {
  const maxResults = options.maxResults ?? 6;
  // minScore 仅对混合搜索路径生效（过滤低质量融合结果）；FTS-only 路径始终返回 top-K
  const minScore = options.minScore ?? 0.25;
  const sourceFilter = options.source ?? 'all';

  // 策略 1：混合搜索（有 embedding 时）
  if (embeddingProvider) {
    try {
      const results = await mixedSearch(db, folder, query, embeddingProvider, sourceFilter, maxResults);
      if (results.length > 0) {
        return results.filter(r => r.score >= minScore).slice(0, maxResults);
      }
    } catch (e) {
      console.warn('[MemorySearch] Embedding search failed, falling back to FTS:', e);
    }
  }

  // 策略 2：FTS5 全文搜索
  const ftsResults = ftsSearch(db, folder, query, sourceFilter, maxResults * 2);
  if (ftsResults.length > 0) {
    return ftsResults.slice(0, maxResults);
  }

  // 策略 3：关键词子串匹配（兜底）
  return keywordFallback(db, folder, query, sourceFilter, maxResults);
}

// ===== 优化 2 & 5：改进 FTS5 搜索（增加查询改写）=====

function ftsSearch(
  db: Database.Database,
  folder: string,
  query: string,
  sourceFilter: string,
  limit: number,
): SearchResult[] {
  // 查询改写（移除疑问词、助词）
  const rewrittenQuery = smartRewriteQuery(query);

  // 分词 + 停用词过滤
  const tokens = tokenizeOptimized(rewrittenQuery, true);
  if (tokens.length === 0) return [];

  // 扩展同义词 token（中→英 / 英→中），增强跨语言 FTS 匹配
  const expandedTokens = expandQueryTokens(tokens);

  // 构建 FTS5 查询：OR 连接所有 token（含扩展词）
  // 不加双引号：FTS5 双引号表示 phrase query，会阻止词干匹配（如 "optimize" 不匹配 "optimized"）
  // 清理 FTS5 特殊字符（双引号、单引号、反引号、括号、- 操作符等），避免语法错误
  const sanitize = (t: string) => t.replace(/["'`()*^-]/g, '').trim();
  const ftsQuery = expandedTokens.map(sanitize).filter(t => t.length > 0).join(' OR ');

  const sourceClause = sourceFilter !== 'all' ? 'AND c.source = ?' : '';
  const params: unknown[] = [ftsQuery, folder];
  if (sourceFilter !== 'all') params.push(sourceFilter);
  params.push(limit);

  try {
    const rows = db.prepare(`
      SELECT c.id, c.path, c.start_line, c.end_line, c.text, c.source,
             bm25(memory_chunks_fts) AS rank
      FROM memory_chunks_fts f
      JOIN memory_chunks c ON c.id = f.chunk_id
      WHERE f.text MATCH ?
        AND c.folder = ?
        ${sourceClause}
      ORDER BY rank
      LIMIT ?
    `).all(...params) as Array<{
      id: string;
      path: string;
      start_line: number;
      end_line: number;
      text: string;
      source: string;
      rank: number;
    }>;

    if (rows.length === 0) return [];

    // BM25 归一化：bm25() 返回负分，越负越相关，越接近 0 越不相关
    // minRank 是最负的（最相关），maxRank 是最接近 0 的（最不相关）
    // 正确公式：score = (maxRank - r.rank) / range → 最相关得 1，最不相关得 0
    // 单结果时 range=0，直接给 score=1（唯一结果即最相关）
    const ranks = rows.map(r => r.rank);
    const minRank = Math.min(...ranks);
    const maxRank = Math.max(...ranks);
    const range = maxRank - minRank;

    return rows.map(r => ({
      id: r.id,
      path: r.path,
      startLine: r.start_line,
      endLine: r.end_line,
      text: r.text,
      score: range === 0 ? 1 : (maxRank - r.rank) / range,
      source: r.source,
    }));
  } catch (e) {
    console.warn('[FTS] Query failed:', e);
    return [];
  }
}

// ===== 优化 3：改进 Keyword Fallback（增加停用词过滤）=====

function keywordFallback(
  db: Database.Database,
  folder: string,
  query: string,
  sourceFilter: string,
  limit: number,
): SearchResult[] {
  // 查询改写
  const rewrittenQuery = smartRewriteQuery(query);

  // 分词 + 2-gram（停用词过滤）
  const tokens = tokenizeOptimized(rewrittenQuery, true);
  const ngrams = generate2gram(rewrittenQuery);
  const allTokens = [...tokens, ...ngrams];

  // 改写后无有效 token（全是停用词）时直接返回空，不做无意义的全库扫描
  if (allTokens.length === 0) return [];

  const sourceClause = sourceFilter !== 'all' ? 'AND source = ?' : '';
  const params: unknown[] = [folder];
  if (sourceFilter !== 'all') params.push(sourceFilter);

  const rows = db.prepare(`
    SELECT id, path, start_line, end_line, text, source
    FROM memory_chunks
    WHERE folder = ?
      ${sourceClause}
  `).all(...params) as Array<{
    id: string;
    path: string;
    start_line: number;
    end_line: number;
    text: string;
    source: string;
  }>;

  const results: SearchResult[] = [];

  for (const row of rows) {
    const textLower = row.text.toLowerCase();
    const rowTokenSet = new Set([...tokenizeOptimized(row.text, false), ...generate2gram(row.text)]);

    let matchCount = 0;
    for (const token of allTokens) {
      if (rowTokenSet.has(token) || textLower.includes(token.toLowerCase())) {
        matchCount++;
      }
    }

    if (matchCount > 0) {
      results.push({
        id: row.id,
        path: row.path,
        startLine: row.start_line,
        endLine: row.end_line,
        text: row.text,
        score: matchCount / allTokens.length,
        source: row.source,
      });
    }
  }

  return results
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
}

// ===== 优化 4：改进混合搜索 =====

async function mixedSearch(
  db: Database.Database,
  folder: string,
  query: string,
  embeddingProvider: EmbeddingProvider,
  sourceFilter: string,
  limit: number,
): Promise<SearchResult[]> {
  // 1. 获取查询向量
  const queryEmbeddings = await embeddingProvider.embed([query]);
  const queryEmbedding = queryEmbeddings[0];
  if (!queryEmbedding) throw new Error('[mixedSearch] embed() returned empty array');

  // 2. 向量搜索（余弦距离）
  const vecResults = vecSearch(db, folder, queryEmbedding, sourceFilter, limit * 2);

  // 质量门控触发（vecResults 为空）：向量对此查询无区分力，回退到纯 FTS
  // 返回空让 hybridSearch 走策略 2，避免 FTS score 被 0.7 压缩
  if (vecResults.length === 0) return [];

  // 3. FTS5 搜索
  const ftsResults = ftsSearch(db, folder, query, sourceFilter, limit * 2);

  // 4. 合并结果（向量 0.7 + FTS 0.3，FTS-only 文档使用对称权重 0.7）
  // C2：FTS 独有文档（不在向量结果中）不再被惩罚到 0.3。
  // 跨语言场景中 expandQueryTokens 找到的正确文档往往只出现在 FTS 结果里，
  // 若给 0.3 则被向量结果（score * 0.7）压制，导致跨语言命中率下降。
  const combined = new Map<string, SearchResult>();

  for (const result of vecResults) {
    combined.set(result.id, {
      ...result,
      score: result.score * 0.7,
    });
  }

  for (const result of ftsResults) {
    const existing = combined.get(result.id);
    if (existing) {
      // 同时出现在向量和 FTS 结果中：两路融合
      existing.score += result.score * 0.3;
    } else {
      // 仅出现在 FTS 结果中：给与 vec-only 文档对称的权重 0.7
      combined.set(result.id, {
        ...result,
        score: result.score * 0.7,
      });
    }
  }

  return Array.from(combined.values())
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
}

function vecSearch(
  db: Database.Database,
  folder: string,
  queryEmbedding: Float32Array,
  sourceFilter: string,
  limit: number,
): SearchResult[] {
  const sourceClause = sourceFilter !== 'all' ? 'AND c.source = ?' : '';
  const queryBuf = Buffer.from(queryEmbedding.buffer, queryEmbedding.byteOffset, queryEmbedding.byteLength);

  // 优先使用 vec0 虚拟表（有向量索引，cosine 距离）
  try {
    // k 必须 >= 整个 vec0 表的行数（跨 folder），否则 JOIN 后 per-folder 结果会不足
    // 例：10 docs 分 2 个 folder，k=6 只能拿到 ~3 条 folder=f1 的结果
    const totalRow = db.prepare('SELECT COUNT(*) as c FROM memory_chunks_vec').get() as { c: number } | undefined;
    const kValue = Math.max((totalRow?.c ?? 0), limit * 2);
    const params: unknown[] = [queryBuf, kValue, folder];
    if (sourceFilter !== 'all') params.push(sourceFilter);

    const rows = db.prepare(`
      SELECT v.chunk_id AS id, c.path, c.start_line, c.end_line, c.text, c.source,
             v.distance
      FROM memory_chunks_vec v
      JOIN memory_chunks c ON c.id = v.chunk_id
      WHERE v.embedding MATCH ?
        AND k = ?
        AND c.folder = ?
        ${sourceClause}
    `).all(...params) as Array<{
      id: string;
      path: string;
      start_line: number;
      end_line: number;
      text: string;
      source: string;
      distance: number;
    }>;

    if (rows.length > 0) {
      return normalizeVecResults(rows);
    }
  } catch {
    // vec0 不可用（sqlite-vec 未加载或表不存在），回退到 BLOB 扫描
  }

  // 回退：直接对 memory_chunks.embedding BLOB 列做全表扫描
  const params2: unknown[] = [queryBuf, folder];
  if (sourceFilter !== 'all') params2.push(sourceFilter);
  params2.push(limit * 2);

  try {
    const rows = db.prepare(`
      SELECT c.id, c.path, c.start_line, c.end_line, c.text, c.source,
             vec_distance_cosine(c.embedding, ?) AS distance
      FROM memory_chunks c
      WHERE c.folder = ?
        AND c.embedding IS NOT NULL
        ${sourceClause}
      ORDER BY distance
      LIMIT ?
    `).all(...params2) as Array<{
      id: string;
      path: string;
      start_line: number;
      end_line: number;
      text: string;
      source: string;
      distance: number;
    }>;

    return normalizeVecResults(rows);
  } catch {
    return [];
  }
}

function normalizeVecResults(rows: Array<{
  id: string; path: string; start_line: number; end_line: number;
  text: string; source: string; distance: number;
}>): SearchResult[] {
  if (rows.length === 0) return [];

  // 相对归一化：余弦距离越小越相关，最小距离对应 score=1，最大距离对应 score=0
  const distances = rows.map(r => r.distance);
  const minDist = Math.min(...distances);
  const maxDist = Math.max(...distances);
  const distRange = maxDist - minDist;

  // C1 质量门控：两个条件任一触发时放弃向量结果，回退到纯 FTS
  //   条件 A: distRange < 0.05 — 所有文档余弦距离几乎相同（模型对此查询无区分力）
  //           相对归一化会把噪声放大 20x 以上，以 0.7 权重注入混合结果
  //   条件 B: minDist > 0.6   — 最相关文档余弦距离仍然很高（模型语义空间与查询不对齐）
  //           此时向量 top-K 基本是随机的，强行融合只会降低排序质量
  if (distRange < 0.05 || minDist > 0.6) return [];

  return rows.map(r => ({
    id: r.id,
    path: r.path,
    startLine: r.start_line,
    endLine: r.end_line,
    text: r.text,
    score: (maxDist - r.distance) / distRange,
    source: r.source,
  }));
}

// ===== 导出（兼容旧接口）=====

export { tokenizeOptimized } from './tokenizer';
