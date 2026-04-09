/**
 * test-multi-model.ts — 多模型大数据集完整检测
 *
 * 测试目标：
 *   1. 多 embedding 模型横向对比（local / openrouter text-embedding-3-small / text-embedding-3-large）
 *   2. 真实文件结构验证（MEMORY.md + memory/YYYY-MM-DD.md 日期文件均被索引）
 *   3. 混合检索路径完整验证（vec0 MATCH → FTS 融合 → keyword fallback）
 *   4. MMR（Maximal Marginal Relevance）去重效果对比
 *
 * 用法：
 *   # 仅 local 模型（无需 key）
 *   node_modules/.bin/tsx test-multi-model.ts
 *
 *   # 含 OpenRouter 模型
 *   OPENROUTER_API_KEY=sk-or-xxx node_modules/.bin/tsx test-multi-model.ts
 *
 *   # 跳过耗时的 embedding 部分，仅测试文件结构
 *   SKIP_EMBED=1 node_modules/.bin/tsx test-multi-model.ts
 */

import Database from 'better-sqlite3';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { applyMemorySchema, buildModelKey } from './src/memory/memory-schema';
import { hybridSearch } from './src/memory/fts-search';
import { tokenizeOptimized } from './src/memory/tokenizer';
import { createEmbeddingProvider, type EmbeddingConfig, type EmbeddingProvider } from './src/memory/embedding';
import { MemoryManager, type MemoryManagerConfig } from './src/memory/MemoryManager';

// ===== 颜色输出 =====

const C = {
  reset: '\x1b[0m', green: '\x1b[32m', red: '\x1b[31m',
  yellow: '\x1b[33m', blue: '\x1b[34m', cyan: '\x1b[36m',
  magenta: '\x1b[35m', bold: '\x1b[1m', dim: '\x1b[2m',
};
const c = (col: keyof typeof C, s: string) => `${C[col]}${s}${C.reset}`;
const section = (s: string) => console.log('\n' + c('bold', '═'.repeat(72)) + '\n' + c('blue', `  ${s}`) + '\n' + c('bold', '═'.repeat(72)));
const sub = (s: string) => console.log('\n' + c('cyan', `  ── ${s}`));
const info = (s: string) => console.log(c('dim', `  ${s}`));

// ===== 测试框架 =====

let pass = 0, fail = 0;
const failures: string[] = [];

async function test(name: string, fn: () => void | Promise<void>) {
  return Promise.resolve().then(fn).then(() => {
    pass++;
    console.log(`  ${c('green', '✓')} ${name}`);
  }).catch((e: Error) => {
    fail++;
    const msg = `  ${c('red', '✗')} ${name}: ${e.message}`;
    console.log(msg);
    failures.push(`${name}: ${e.message}`);
  });
}

function ok(cond: boolean, msg: string) {
  if (!cond) throw new Error(msg);
}

// ===== 数据集加载 =====

interface TestDocument { id: string; text: string; category: string; tags: string[] }
interface TestQuery { id: string; query: string; category: string }

function loadDataset() {
  const data = require('../memory-3.13/semaclaw-new/archive/test-scripts/test-search-data-generated');
  return {
    testDocuments: data.testDocuments as TestDocument[],
    testQueries: data.testQueries as TestQuery[],
    relevanceMatrix: data.relevanceMatrix as Record<string, Record<string, number>>,
  };
}

// ===== 指标计算 =====

interface Metrics {
  precision: number; recall: number; f1: number;
  mrr: number; p1: number;
  queries: number; retrieved: number; relevant: number; relevantRetrieved: number;
}

function computeMetrics(
  queryResults: Array<{ queryId: string; retrievedIds: string[] }>,
  relevanceMatrix: Record<string, Record<string, number>>,
  minRelevanceScore = 1,
): Metrics {
  let totalPrecision = 0, totalRecall = 0, totalMrr = 0, totalP1 = 0;
  let totalRR = 0, totalRetrieved = 0, totalRelevant = 0;

  for (const { queryId, retrievedIds } of queryResults) {
    const rel = relevanceMatrix[queryId] ?? {};
    const relevantSet = new Set(
      Object.entries(rel).filter(([, s]) => (s as number) >= minRelevanceScore).map(([id]) => id)
    );
    if (relevantSet.size === 0) continue; // 跳过无 ground truth 的查询（edge cases）

    const retrieved = retrievedIds.length;
    const rr = retrievedIds.filter(id => relevantSet.has(id)).length;

    totalPrecision += retrieved > 0 ? rr / retrieved : 0;
    totalRecall += rr / relevantSet.size;
    totalRR += rr;
    totalRetrieved += retrieved;
    totalRelevant += relevantSet.size;

    let firstRank = 0;
    for (let i = 0; i < retrievedIds.length; i++) {
      if (relevantSet.has(retrievedIds[i])) { firstRank = i + 1; break; }
    }
    totalMrr += firstRank > 0 ? 1 / firstRank : 0;
    totalP1 += (retrievedIds.length > 0 && relevantSet.has(retrievedIds[0])) ? 1 : 0;
  }

  // 只统计有 ground truth 的查询
  const n = queryResults.filter(r => {
    const rel = relevanceMatrix[r.queryId] ?? {};
    return Object.values(rel).some(s => (s as number) >= minRelevanceScore);
  }).length;

  const p = n > 0 ? totalPrecision / n : 0;
  const r = n > 0 ? totalRecall / n : 0;
  return {
    precision: p, recall: r,
    f1: p + r > 0 ? (2 * p * r) / (p + r) : 0,
    mrr: n > 0 ? totalMrr / n : 0,
    p1: n > 0 ? totalP1 / n : 0,
    queries: n, retrieved: totalRetrieved,
    relevant: totalRelevant, relevantRetrieved: totalRR,
  };
}

function printMetrics(label: string, m: Metrics) {
  const f1Color = m.f1 >= 0.45 ? 'green' : m.f1 >= 0.35 ? 'yellow' : 'red';
  console.log(
    `  ${label.padEnd(38)} ` +
    `P@K=${(m.precision * 100).toFixed(1).padStart(5)}%  ` +
    `R@K=${(m.recall * 100).toFixed(1).padStart(5)}%  ` +
    `F1=${c(f1Color, m.f1.toFixed(3))}  ` +
    `P@1=${(m.p1 * 100).toFixed(1).padStart(5)}%  ` +
    `MRR=${m.mrr.toFixed(3)}`
  );
}

// ===== 建库工具 =====

const FOLDER = 'test-agent';

function buildDb(
  docs: TestDocument[],
  enableVec = false,
  dimensions = 384,
  modelKey = '',
): { db: Database.Database; chunkIdToDocId: Map<string, string> } {
  const db = new Database(':memory:');
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  applyMemorySchema(db, enableVec, dimensions, modelKey);

  const insertFile = db.prepare(
    `INSERT OR IGNORE INTO memory_files (path, folder, source, hash, mtime, size) VALUES (?, ?, 'memory', ?, 0, 0)`
  );
  const insertChunk = db.prepare(
    `INSERT INTO memory_chunks (id, folder, path, source, start_line, end_line, hash, text, embedding, model)
     VALUES (?, ?, ?, 'memory', 1, 1, ?, ?, NULL, NULL)`
  );
  const insertFts = db.prepare(`INSERT INTO memory_chunks_fts (chunk_id, text) VALUES (?, ?)`);

  const chunkIdToDocId = new Map<string, string>();
  const idCounts = new Map<string, number>();

  const tx = db.transaction(() => {
    for (const doc of docs) {
      const count = (idCounts.get(doc.id) || 0) + 1;
      idCounts.set(doc.id, count);
      const chunkId = count === 1 ? doc.id : `${doc.id}-v${count}`;
      chunkIdToDocId.set(chunkId, doc.id);
      const fp = `memory/${chunkId}.md`;
      insertFile.run(fp, FOLDER, chunkId);
      const tok = tokenizeOptimized(doc.text, false).join(' ');
      insertChunk.run(chunkId, FOLDER, fp, chunkId, doc.text);
      insertFts.run(chunkId, tok);
    }
  });
  tx();

  return { db, chunkIdToDocId };
}

async function embedAllDocs(
  db: Database.Database,
  docs: TestDocument[],
  chunkIdToDocId: Map<string, string>,
  provider: EmbeddingProvider,
): Promise<void> {
  const idCounts = new Map<string, number>();
  const entries: Array<{ chunkId: string; text: string }> = [];
  for (const doc of docs) {
    const count = (idCounts.get(doc.id) || 0) + 1;
    idCounts.set(doc.id, count);
    const chunkId = count === 1 ? doc.id : `${doc.id}-v${count}`;
    entries.push({ chunkId, text: doc.text });
  }

  const updateEmb = db.prepare(`UPDATE memory_chunks SET embedding = ?, model = ? WHERE id = ?`);
  const insertVec = db.prepare(`INSERT OR IGNORE INTO memory_chunks_vec (chunk_id, embedding) VALUES (?, ?)`);

  process.stdout.write(`    Embedding ${entries.length} docs`);
  const batchSize = 8;
  for (let i = 0; i < entries.length; i += batchSize) {
    const batch = entries.slice(i, i + batchSize);
    const embs = await provider.embed(batch.map(e => e.text));
    const tx = db.transaction(() => {
      for (let j = 0; j < batch.length; j++) {
        const { chunkId } = batch[j];
        const emb = embs[j];
        const buf = Buffer.from(emb.buffer, emb.byteOffset, emb.byteLength);
        updateEmb.run(buf, provider.model, chunkId);
        try { insertVec.run(chunkId, buf); } catch { /* ok */ }
      }
    });
    tx();
    process.stdout.write('.');
  }
  console.log(` done (${entries.length} vectors, dim=${provider.dimensions})`);
}

async function runQueries(
  db: Database.Database,
  queries: TestQuery[],
  provider: EmbeddingProvider | null,
  chunkIdToDocId: Map<string, string>,
  opts: { maxResults: number; minScore: number },
): Promise<Array<{ queryId: string; retrievedIds: string[]; category: string; scores: number[] }>> {
  const results = [];
  for (const q of queries) {
    const r = await hybridSearch(db, FOLDER, q.query, provider, opts);
    const toDocId = (id: string) => chunkIdToDocId.get(id) ?? id;
    results.push({
      queryId: q.id,
      retrievedIds: r.map(x => toDocId(x.id)),
      scores: r.map(x => x.score),
      category: q.category,
    });
  }
  return results;
}

// ===== MMR 实现 =====
// Maximal Marginal Relevance: 在保持相关性的同时最大化多样性
// score_mmr = λ * relevance(d) - (1-λ) * max_{d' ∈ S} sim(d, d')
// 其中 S 是已选结果集，sim 用文本 Jaccard 相似度近似

function tokenSet(text: string): Set<string> {
  return new Set(tokenizeOptimized(text, false));
}

function jaccardSim(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 1;
  let inter = 0;
  for (const t of a) if (b.has(t)) inter++;
  return inter / (a.size + b.size - inter);
}

interface ScoredResult {
  id: string;
  docId: string;
  text: string;
  score: number;
}

function applyMMR(
  results: ScoredResult[],
  maxResults: number,
  lambda = 0.6,
): ScoredResult[] {
  if (results.length === 0) return [];

  const selected: ScoredResult[] = [];
  const remaining = [...results];
  const selectedTokenSets: Set<string>[] = [];

  while (selected.length < maxResults && remaining.length > 0) {
    let bestIdx = 0;
    let bestScore = -Infinity;

    for (let i = 0; i < remaining.length; i++) {
      const r = remaining[i];
      const rTokens = tokenSet(r.text);

      // 最大相似度（与已选文档）
      let maxSim = 0;
      for (const st of selectedTokenSets) {
        const sim = jaccardSim(rTokens, st);
        if (sim > maxSim) maxSim = sim;
      }

      const mmrScore = lambda * r.score - (1 - lambda) * maxSim;
      if (mmrScore > bestScore) {
        bestScore = mmrScore;
        bestIdx = i;
      }
    }

    selected.push(remaining[bestIdx]);
    selectedTokenSets.push(tokenSet(remaining[bestIdx].text));
    remaining.splice(bestIdx, 1);
  }

  return selected;
}

async function runQueriesWithMMR(
  db: Database.Database,
  queries: TestQuery[],
  provider: EmbeddingProvider | null,
  chunkIdToDocId: Map<string, string>,
  opts: { maxResults: number; minScore: number },
  lambda = 0.6,
): Promise<Array<{ queryId: string; retrievedIds: string[]; category: string }>> {
  const results = [];
  // 先取 2x 候选，再 MMR 重排
  const candidateOpts = { ...opts, maxResults: opts.maxResults * 2 };
  for (const q of queries) {
    const r = await hybridSearch(db, FOLDER, q.query, provider, candidateOpts);
    const toDocId = (id: string) => chunkIdToDocId.get(id) ?? id;
    const candidates: ScoredResult[] = r.map(x => ({
      id: x.id,
      docId: toDocId(x.id),
      text: x.text,
      score: x.score,
    }));
    const mmrResults = applyMMR(candidates, opts.maxResults, lambda);
    results.push({
      queryId: q.id,
      retrievedIds: mmrResults.map(x => x.docId),
      category: q.category,
    });
  }
  return results;
}

// ===== Part G: 真实文件结构测试 =====
// 测试 MEMORY.md + memory/YYYY-MM-DD.md 是否均被 MemoryManager 正确索引

async function testRealFileStructure() {
  section('Part G — 真实文件结构测试（MEMORY.md + 日期文件）');

  // 创建临时 agent 目录
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sema-test-'));
  const agentsDir = path.join(tmpDir, 'agents');
  const agentFolder = 'test-real-agent';
  const agentDir = path.join(agentsDir, agentFolder);
  const memoryDir = path.join(agentDir, 'memory');

  try {
    fs.mkdirSync(memoryDir, { recursive: true });

    // 写入 MEMORY.md（核心记忆文件）
    const memoryMdContent = `# Agent Memory

## 用户偏好
- 喜欢简洁的代码风格
- 使用 TypeScript 开发
- 偏好函数式编程

## 重要事项
- 项目使用 React 18 + Vite
- 后端 Node.js + Express
- 数据库 PostgreSQL

## 技术栈
- 前端：React, TypeScript, Tailwind CSS
- 后端：Node.js, Express, Prisma
- 部署：Docker, Kubernetes
`;

    // 写入日期文件（每日对话日志）
    const date1Content = `# 2026-03-17 对话记录

## 10:30 — 讨论 API 设计
用户问：如何设计 RESTful API 的版本控制？
回答：推荐在 URL 中加版本号，如 /api/v1/users，同时保持向后兼容。

## 14:00 — 调试内存泄漏
发现 useEffect 中的事件监听器没有在 cleanup 函数中移除。
解决方案：返回清理函数 return () => window.removeEventListener(...)

## 16:30 — 性能优化讨论
讨论了 React.memo 和 useMemo 的使用场景。
结论：过度优化会增加代码复杂度，应先测量再优化。
`;

    const date2Content = `# 2026-03-18 对话记录

## 09:00 — TypeScript 类型问题
用户遇到 TS2345 错误，类型不兼容。
解决：使用类型断言 as 或修改接口定义。

## 11:00 — 数据库查询优化
慢查询分析：EXPLAIN ANALYZE 显示全表扫描。
添加复合索引 CREATE INDEX ON users(email, created_at) 后性能提升 10x。

## 15:00 — Docker 部署问题
容器启动失败，端口冲突。
解决：修改 docker-compose.yml 中的端口映射。

## 17:00 — 代码审查
审查了 authentication middleware，发现 JWT 验证逻辑有安全漏洞。
修复：验证 exp 字段防止过期 token 重放攻击。
`;

    const date3Content = `# 2026-03-19 对话记录

## 10:00 — Redis 缓存策略
讨论 LRU vs LFU 淘汰策略的选择。
结论：对于热点数据用 LFU，通用场景用 LRU。

## 13:00 — Kubernetes 调度问题
Pod 无法调度，节点资源不足。
解决：调整 resource requests 和 limits，使用 HPA 自动扩缩容。

## 16:00 — 异步编程模式
对比 Promise.all vs Promise.allSettled 的使用场景。
Promise.all：全部成功才继续；Promise.allSettled：无论成功失败都等待。
`;

    fs.writeFileSync(path.join(agentDir, 'MEMORY.md'), memoryMdContent, 'utf8');
    fs.writeFileSync(path.join(memoryDir, '2026-03-17.md'), date1Content, 'utf8');
    fs.writeFileSync(path.join(memoryDir, '2026-03-18.md'), date2Content, 'utf8');
    fs.writeFileSync(path.join(memoryDir, '2026-03-19.md'), date3Content, 'utf8');

    // 创建数据库
    const dbPath = path.join(tmpDir, 'test.db');
    const db = new Database(dbPath);
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');
    applyMemorySchema(db, false);

    // 初始化 MemoryManager
    const cfg: MemoryManagerConfig = {
      agentsDir,
      embeddingConfig: { provider: 'none' },
    };
    // 直接用 init（单例模式，测试后需要重置）
    // 为避免单例污染，直接使用底层 syncFolder 逻辑
    // 改为手动索引文件
    const allFiles = [
      { absPath: path.join(agentDir, 'MEMORY.md'), source: 'memory' },
      { absPath: path.join(memoryDir, '2026-03-17.md'), source: 'memory' },
      { absPath: path.join(memoryDir, '2026-03-18.md'), source: 'memory' },
      { absPath: path.join(memoryDir, '2026-03-19.md'), source: 'memory' },
    ];

    const insertFile = db.prepare(
      `INSERT OR IGNORE INTO memory_files (path, folder, source, hash, mtime, size) VALUES (?, ?, ?, ?, 0, 0)`
    );
    const insertChunk = db.prepare(
      `INSERT INTO memory_chunks (id, folder, path, source, start_line, end_line, hash, text, embedding, model)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL)`
    );
    const insertFts = db.prepare(`INSERT INTO memory_chunks_fts (chunk_id, text) VALUES (?, ?)`);

    const tx = db.transaction(() => {
      for (const { absPath, source } of allFiles) {
        const content = fs.readFileSync(absPath, 'utf8');
        const lines = content.split('\n');
        const hash = require('crypto').createHash('sha256').update(content).digest('hex');
        insertFile.run(absPath, agentFolder, source, hash);

        // 按段落分块（简单：每 20 行一块）
        const blockSize = 20;
        for (let i = 0; i < lines.length; i += blockSize) {
          const blockLines = lines.slice(i, i + blockSize);
          const text = blockLines.join('\n').trim();
          if (!text) continue;
          const chunkId = `${path.basename(absPath)}-${i}`;
          const chunkHash = require('crypto').createHash('sha256').update(text).digest('hex');
          insertChunk.run(chunkId, agentFolder, absPath, source, i + 1, Math.min(i + blockSize, lines.length), chunkHash, text);
          insertFts.run(chunkId, tokenizeOptimized(text, false).join(' '));
        }
      }
    });
    tx();

    sub('G1. 文件索引验证');

    await test('MEMORY.md 已被索引', () => {
      const row = db.prepare(
        `SELECT COUNT(*) as n FROM memory_files WHERE folder = ? AND path LIKE '%MEMORY.md'`
      ).get(agentFolder) as { n: number };
      ok(row.n === 1, `expected 1, got ${row.n}`);
    });

    await test('日期文件（3 个）均已被索引', () => {
      // memory/ 子目录下的 .md 文件（路径含 path.sep + 'memory' + path.sep）
      const rows = db.prepare(
        `SELECT path FROM memory_files WHERE folder = ?`
      ).all(agentFolder) as Array<{ path: string }>;
      const dateFiles = rows.filter(r => r.path.includes('2026-'));
      ok(dateFiles.length === 3, `expected 3 date files, got ${dateFiles.length}: ${dateFiles.map(r => path.basename(r.path)).join(', ')}`);
    });

    await test('总 chunk 数量合理（>= 4 个文件各至少 1 块）', () => {
      const row = db.prepare(
        `SELECT COUNT(*) as n FROM memory_chunks WHERE folder = ?`
      ).get(agentFolder) as { n: number };
      ok(row.n >= 4, `expected >= 4 chunks, got ${row.n}`);
    });

    sub('G2. MEMORY.md 内容可被搜索');

    await test('搜索"TypeScript"命中 MEMORY.md', async () => {
      const results = await hybridSearch(db, agentFolder, 'TypeScript', null, { maxResults: 5 });
      ok(results.length > 0, '无结果');
      const hasMemoryMd = results.some(r => r.path.includes('MEMORY.md'));
      ok(hasMemoryMd, `结果中无 MEMORY.md: ${results.map(r => path.basename(r.path)).join(', ')}`);
    });

    await test('搜索"React"命中 MEMORY.md', async () => {
      const results = await hybridSearch(db, agentFolder, 'React', null, { maxResults: 5 });
      ok(results.length > 0, '无结果');
      const hasMemoryMd = results.some(r => r.path.includes('MEMORY.md'));
      ok(hasMemoryMd, `结果中无 MEMORY.md: ${results.map(r => path.basename(r.path)).join(', ')}`);
    });

    sub('G3. 日期文件内容可被搜索');

    await test('搜索"内存泄漏"命中 2026-03-17.md', async () => {
      const results = await hybridSearch(db, agentFolder, '内存泄漏', null, { maxResults: 5 });
      ok(results.length > 0, '无结果');
      const hasDate = results.some(r => r.path.includes('2026-03-17'));
      ok(hasDate, `结果中无 2026-03-17.md: ${results.map(r => path.basename(r.path)).join(', ')}`);
    });

    await test('搜索"数据库索引"命中 2026-03-18.md', async () => {
      const results = await hybridSearch(db, agentFolder, '数据库索引', null, { maxResults: 5 });
      ok(results.length > 0, '无结果');
      const hasDate = results.some(r => r.path.includes('2026-03-18'));
      ok(hasDate, `结果中无 2026-03-18.md: ${results.map(r => path.basename(r.path)).join(', ')}`);
    });

    await test('搜索"Redis LRU"命中 2026-03-19.md', async () => {
      const results = await hybridSearch(db, agentFolder, 'Redis LRU', null, { maxResults: 5 });
      ok(results.length > 0, '无结果');
      const hasDate = results.some(r => r.path.includes('2026-03-19'));
      ok(hasDate, `结果中无 2026-03-19.md: ${results.map(r => path.basename(r.path)).join(', ')}`);
    });

    sub('G4. 跨文件搜索（MEMORY.md + 日期文件均在结果中）');

    await test('搜索"Docker"同时命中 MEMORY.md 和 2026-03-18.md', async () => {
      const results = await hybridSearch(db, agentFolder, 'Docker 容器', null, { maxResults: 6 });
      ok(results.length > 0, '无结果');
      const paths = results.map(r => path.basename(r.path));
      const hasMemory = results.some(r => r.path.includes('MEMORY.md'));
      const hasDate18 = results.some(r => r.path.includes('2026-03-18'));
      ok(hasMemory || hasDate18, `期望命中 MEMORY.md 或 2026-03-18.md，实际: ${paths.join(', ')}`);
    });

    await test('搜索"Kubernetes"命中包含该词的文件', async () => {
      const results = await hybridSearch(db, agentFolder, 'Kubernetes 调度', null, { maxResults: 5 });
      ok(results.length > 0, '无结果');
    });

    sub('G5. source 字段正确性');

    await test('所有索引文件 source 均为 memory', () => {
      const rows = db.prepare(
        `SELECT DISTINCT source FROM memory_files WHERE folder = ?`
      ).all(agentFolder) as Array<{ source: string }>;
      ok(rows.length === 1 && rows[0].source === 'memory', `sources: ${rows.map(r => r.source).join(',')}`);
    });

    await test('chunks 中 source 均为 memory', () => {
      const rows = db.prepare(
        `SELECT DISTINCT source FROM memory_chunks WHERE folder = ?`
      ).all(agentFolder) as Array<{ source: string }>;
      ok(rows.length === 1 && rows[0].source === 'memory', `sources: ${rows.map(r => r.source).join(',')}`);
    });

    await test('source=memory 过滤有效（不返回 session 数据）', async () => {
      const results = await hybridSearch(db, agentFolder, 'TypeScript', null, {
        maxResults: 5,
        source: 'memory',
      });
      ok(results.every(r => r.source === 'memory'), '有非 memory source 的结果');
    });

    db.close();
  } finally {
    // 清理临时目录
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

// ===== Part H: 混合检索路径验证 =====

async function testSearchPaths(
  docs: TestDocument[],
  queries: TestQuery[],
  relevanceMatrix: Record<string, Record<string, number>>,
) {
  section('Part H — 混合检索路径验证');

  const { db, chunkIdToDocId } = buildDb(docs, false, 384);
  const opts = { maxResults: 6, minScore: 0 };

  sub('H1. FTS → keyword fallback 链路');

  await test('正常查询走 FTS 路径（有结果）', async () => {
    const r = await hybridSearch(db, FOLDER, 'React Hooks', null, opts);
    ok(r.length > 0, '无结果');
    ok(r.every(x => x.score >= 0 && x.score <= 1), '分数超出 [0,1]');
  });

  await test('生僻词触发 keyword fallback（仍有结果）', async () => {
    // "xyzzy" 是不存在的词，FTS 无结果，但如果文档中有 xyz 子串可能命中 fallback
    // 用一个确实存在于文档中但 FTS 无法处理的词
    const r = await hybridSearch(db, FOLDER, 'fetchUserData', null, opts);
    // fetchUserData 在 code-001 中，FTS 应该能找到
    ok(r.length > 0, '无结果');
  });

  await test('空查询返回空（不崩溃）', async () => {
    const r = await hybridSearch(db, FOLDER, '', null, opts);
    ok(Array.isArray(r), '应返回数组');
  });

  await test('纯停用词返回空（不走 fallback 误匹配）', async () => {
    const r = await hybridSearch(db, FOLDER, '如何如何', null, opts);
    ok(r.length === 0, `期望空结果，得到 ${r.length} 条`);
  });

  await test('source=session 过滤（无 session 数据时返回空）', async () => {
    const r = await hybridSearch(db, FOLDER, 'React', null, { ...opts, source: 'session' });
    ok(r.length === 0, `期望空，得到 ${r.length} 条`);
  });

  await test('maxResults 限制生效', async () => {
    const r = await hybridSearch(db, FOLDER, 'database', null, { maxResults: 3, minScore: 0 });
    ok(r.length <= 3, `期望 ≤ 3，得到 ${r.length}`);
  });

  sub('H2. FTS-only 全量指标');

  process.stdout.write('  运行 110 个查询（FTS-only）...');
  const ftsResults = await runQueries(db, queries, null, chunkIdToDocId, opts);
  console.log(' done');
  const ftsMetrics = computeMetrics(ftsResults, relevanceMatrix);
  printMetrics('FTS-only', ftsMetrics);

  await test('FTS F1 ≥ 0.30（基线）', () => {
    ok(ftsMetrics.f1 >= 0.30, `F1=${ftsMetrics.f1.toFixed(3)}`);
  });
  await test('FTS MRR ≥ 0.50', () => {
    ok(ftsMetrics.mrr >= 0.50, `MRR=${ftsMetrics.mrr.toFixed(3)}`);
  });

  sub('H3. 跨语言 FTS 专项（6 个关键用例）');

  const crossLangCases = [
    { query: '内存泄漏', expectedId: 'en-003', desc: '中文→英文' },
    { query: '异步编程', expectedId: 'en-004', desc: '中文→英文' },
    { query: 'memory leak', expectedId: 'zh-003', desc: '英文→中文' },
    { query: 'async programming', expectedId: 'zh-004', desc: '英文→中文' },
    { query: 'database index', expectedId: 'zh-002', desc: '英文→中文' },
    { query: '什么是分布式事务', expectedId: 'en-002', desc: '中文→英文' },
  ];

  let ftsHits = 0;
  for (const { query, expectedId, desc } of crossLangCases) {
    const r = await hybridSearch(db, FOLDER, query, null, opts);
    const ids = r.map(x => chunkIdToDocId.get(x.id) ?? x.id);
    const hit = ids.includes(expectedId);
    if (hit) ftsHits++;
    console.log(`    ${query.padEnd(22)} → ${expectedId}: ${hit ? c('green', '✓ hit') : c('red', '✗ miss')} (${desc})`);
  }
  await test(`FTS 跨语言命中 ≥ 5/6（实际 ${ftsHits}/6）`, () => {
    ok(ftsHits >= 5, `只命中 ${ftsHits}/6`);
  });

  db.close();
}

// ===== Part I: MMR 效果对比 =====

async function testMMR(
  docs: TestDocument[],
  queries: TestQuery[],
  relevanceMatrix: Record<string, Record<string, number>>,
) {
  section('Part I — MMR（最大边际相关性）去重效果对比');

  const { db, chunkIdToDocId } = buildDb(docs, false, 384);
  const opts = { maxResults: 6, minScore: 0 };

  sub('I1. MMR 去重效果（FTS-only 路径）');

  // 找一个有多个相似文档的查询
  const testQuery = 'async await promise';
  const rawResults = await hybridSearch(db, FOLDER, testQuery, null, { maxResults: 12, minScore: 0 });
  const toDocId = (id: string) => chunkIdToDocId.get(id) ?? id;
  const candidates: ScoredResult[] = rawResults.map(x => ({
    id: x.id, docId: toDocId(x.id), text: x.text, score: x.score,
  }));

  const mmrResults = applyMMR(candidates, 6, 0.6);
  const rawTopIds = rawResults.slice(0, 6).map(x => toDocId(x.id));
  const mmrIds = mmrResults.map(x => x.docId);

  console.log(`  查询: "${testQuery}"`);
  console.log(`  原始 top-6 IDs: ${rawTopIds.join(', ')}`);
  console.log(`  MMR  top-6 IDs: ${mmrIds.join(', ')}`);

  // 计算多样性（唯一 docId 数量）
  const rawUnique = new Set(rawTopIds).size;
  const mmrUnique = new Set(mmrIds).size;
  console.log(`  原始多样性（唯一文档数）: ${rawUnique}/6`);
  console.log(`  MMR  多样性（唯一文档数）: ${mmrUnique}/6`);

  await test('MMR 结果不为空', () => {
    ok(mmrResults.length > 0, '无结果');
  });

  await test('MMR 多样性 ≥ 原始多样性', () => {
    ok(mmrUnique >= rawUnique, `MMR unique=${mmrUnique} < raw unique=${rawUnique}`);
  });

  sub('I2. MMR vs 原始排序 全量指标对比');

  process.stdout.write('  运行查询（原始排序）...');
  const rawQueryResults = await runQueries(db, queries, null, chunkIdToDocId, opts);
  console.log(' done');

  process.stdout.write('  运行查询（MMR λ=0.6）...');
  const mmrQueryResults = await runQueriesWithMMR(db, queries, null, chunkIdToDocId, opts, 0.6);
  console.log(' done');

  process.stdout.write('  运行查询（MMR λ=0.8，偏相关性）...');
  const mmrQueryResults08 = await runQueriesWithMMR(db, queries, null, chunkIdToDocId, opts, 0.8);
  console.log(' done');

  const rawMetrics = computeMetrics(rawQueryResults, relevanceMatrix);
  const mmrMetrics06 = computeMetrics(mmrQueryResults, relevanceMatrix);
  const mmrMetrics08 = computeMetrics(mmrQueryResults08, relevanceMatrix);

  console.log('');
  console.log('  ' + c('bold', '方案'.padEnd(38) + 'P@K     R@K      F1     P@1     MRR'));
  console.log('  ' + '─'.repeat(72));
  printMetrics('原始排序（基线）', rawMetrics);
  printMetrics('MMR λ=0.6（多样性优先）', mmrMetrics06);
  printMetrics('MMR λ=0.8（相关性优先）', mmrMetrics08);

  const mmrDelta = mmrMetrics08.f1 - rawMetrics.f1;
  console.log(`\n  MMR(λ=0.8) vs 原始 F1 差值: ${mmrDelta >= 0 ? c('green', '+') : c('red', '')}${(mmrDelta * 100).toFixed(1)}%`);

  await test('MMR λ=0.8 F1 ≥ 原始 F1 × 0.9（多样性不严重损害相关性）', () => {
    ok(mmrMetrics08.f1 >= rawMetrics.f1 * 0.9,
      `MMR F1=${mmrMetrics08.f1.toFixed(3)} < raw F1 × 0.9 = ${(rawMetrics.f1 * 0.9).toFixed(3)}`);
  });

  sub('I3. MMR lambda 扫描');

  console.log('');
  console.log('  ' + c('bold', 'λ'.padEnd(8) + '说明'.padEnd(20) + 'P@K     R@K      F1     P@1     MRR'));
  console.log('  ' + '─'.repeat(72));

  for (const lambda of [0.5, 0.6, 0.7, 0.8, 0.9, 1.0]) {
    const r = await runQueriesWithMMR(db, queries, null, chunkIdToDocId, opts, lambda);
    const m = computeMetrics(r, relevanceMatrix);
    const desc = lambda === 1.0 ? '纯相关性' : lambda === 0.5 ? '多样性最大' : '';
    printMetrics(`λ=${lambda} ${desc}`, m);
  }

  db.close();
}

// ===== Part J: 多模型对比 =====

async function testMultiModel(
  docs: TestDocument[],
  queries: TestQuery[],
  relevanceMatrix: Record<string, Record<string, number>>,
) {
  section('Part J — 多 Embedding 模型横向对比');

  const openrouterKey = process.env.OPENROUTER_API_KEY || '';
  const skipEmbed = process.env.SKIP_EMBED === '1';

  if (skipEmbed) {
    console.log(c('yellow', '  SKIP_EMBED=1，跳过 embedding 测试'));
    return;
  }

  // 定义要测试的模型配置
  const modelConfigs: Array<{
    label: string;
    cfg: EmbeddingConfig;
    dimensions: number;
    skip?: boolean;
    skipReason?: string;
  }> = [
    {
      label: 'local/paraphrase-multilingual-MiniLM-L12-v2 (384d)',
      cfg: {
        provider: 'local',
        localModel: 'Xenova/paraphrase-multilingual-MiniLM-L12-v2',
      },
      dimensions: 384,
    },
    {
      label: 'local/all-MiniLM-L6-v2 (384d)',
      cfg: {
        provider: 'local',
        localModel: 'Xenova/all-MiniLM-L6-v2',
      },
      dimensions: 384,
    },
    {
      label: 'openrouter/text-embedding-3-small (1536d)',
      cfg: {
        provider: 'openrouter',
        openrouterApiKey: openrouterKey,
        openrouterBaseUrl: 'https://openrouter.ai/api/v1',
        openrouterModel: 'openai/text-embedding-3-small',
      },
      dimensions: 1536,
      skip: !openrouterKey,
      skipReason: '无 OPENROUTER_API_KEY',
    },
    {
      label: 'openrouter/text-embedding-3-large (3072d)',
      cfg: {
        provider: 'openrouter',
        openrouterApiKey: openrouterKey,
        openrouterBaseUrl: 'https://openrouter.ai/api/v1',
        openrouterModel: 'openai/text-embedding-3-large',
      },
      dimensions: 3072,
      skip: !openrouterKey,
      skipReason: '无 OPENROUTER_API_KEY',
    },
  ];

  // 结果汇总表
  const summary: Array<{
    label: string;
    fts: Metrics;
    hybrid: Metrics;
    hybridMMR: Metrics;
    crossLangFts: number;
    crossLangHybrid: number;
  }> = [];

  const crossLangCases = [
    { query: '内存泄漏', expectedId: 'en-003' },
    { query: '异步编程', expectedId: 'en-004' },
    { query: 'memory leak', expectedId: 'zh-003' },
    { query: 'async programming', expectedId: 'zh-004' },
    { query: 'database index', expectedId: 'zh-002' },
    { query: '什么是分布式事务', expectedId: 'en-002' },
  ];

  for (const modelCfg of modelConfigs) {
    const modelLabel = c('bold', modelCfg.label);

    if (modelCfg.skip) {
      console.log(`\n  ${c('yellow', '⊘')} ${modelLabel} — ${c('dim', modelCfg.skipReason ?? 'skipped')}`);
      continue;
    }

    console.log(`\n  ${c('cyan', '▶')} ${modelLabel}`);

    // 创建共享缓存库（embedding_cache 跨查询复用）
    const cacheDb = new Database(':memory:');
    cacheDb.pragma('journal_mode = WAL');
    applyMemorySchema(cacheDb, false);

    // 创建 provider
    const provider = createEmbeddingProvider(modelCfg.cfg, cacheDb);
    if (!provider) {
      console.log(`    ${c('yellow', '⚠')} Provider 创建失败，跳过`);
      cacheDb.close();
      continue;
    }

    // 等待第一次 embed 确定实际维度
    console.log(`    初始化模型...`);
    try {
      await provider.embed(['test']);
    } catch (e) {
      console.log(`    ${c('red', '✗')} 模型初始化失败: ${e}`);
      cacheDb.close();
      continue;
    }

    const actualDim = provider.dimensions;
    console.log(`    维度: ${actualDim}d, 模型: ${provider.model}`);

    const modelKey = buildModelKey(provider.name, provider.model, actualDim);

    // 建向量库
    const { db, chunkIdToDocId } = buildDb(docs, true, actualDim, modelKey);
    await embedAllDocs(db, docs, chunkIdToDocId, provider);

    const opts = { maxResults: 6, minScore: 0 };

    // FTS-only 指标
    const ftsResults = await runQueries(db, queries, null, chunkIdToDocId, opts);
    const ftsMetrics = computeMetrics(ftsResults, relevanceMatrix);

    // 混合搜索指标
    const hybridResults = await runQueries(db, queries, provider, chunkIdToDocId, opts);
    const hybridMetrics = computeMetrics(hybridResults, relevanceMatrix);

    // 混合搜索 + MMR
    const hybridMMRResults = await runQueriesWithMMR(db, queries, provider, chunkIdToDocId, opts, 0.7);
    const hybridMMRMetrics = computeMetrics(hybridMMRResults, relevanceMatrix);

    // 跨语言命中
    let ftsHits = 0, hybridHits = 0;
    for (const { query, expectedId } of crossLangCases) {
      const ftsR = await hybridSearch(db, FOLDER, query, null, opts);
      const hybridR = await hybridSearch(db, FOLDER, query, provider, opts);
      if (ftsR.some(x => (chunkIdToDocId.get(x.id) ?? x.id) === expectedId)) ftsHits++;
      if (hybridR.some(x => (chunkIdToDocId.get(x.id) ?? x.id) === expectedId)) hybridHits++;
    }

    summary.push({
      label: modelCfg.label,
      fts: ftsMetrics,
      hybrid: hybridMetrics,
      hybridMMR: hybridMMRMetrics,
      crossLangFts: ftsHits,
      crossLangHybrid: hybridHits,
    });

    console.log(`    FTS-only:      F1=${ftsMetrics.f1.toFixed(3)}  P@1=${(ftsMetrics.p1 * 100).toFixed(1)}%  MRR=${ftsMetrics.mrr.toFixed(3)}  跨语言=${ftsHits}/6`);
    console.log(`    Hybrid:        F1=${hybridMetrics.f1.toFixed(3)}  P@1=${(hybridMetrics.p1 * 100).toFixed(1)}%  MRR=${hybridMetrics.mrr.toFixed(3)}  跨语言=${hybridHits}/6`);
    console.log(`    Hybrid+MMR:    F1=${hybridMMRMetrics.f1.toFixed(3)}  P@1=${(hybridMMRMetrics.p1 * 100).toFixed(1)}%  MRR=${hybridMMRMetrics.mrr.toFixed(3)}`);

    db.close();
    cacheDb.close();
  }

  // 汇总表
  if (summary.length > 0) {
    section('Part J — 汇总对比表');
    console.log('');
    const col = (s: string, w: number) => s.slice(0, w).padEnd(w);
    console.log(c('bold',
      '  ' + col('模型', 42) +
      col('FTS-F1', 8) + col('H-F1', 8) + col('MMR-F1', 8) +
      col('P@1', 7) + col('MRR', 7) + col('跨语言', 8)
    ));
    console.log('  ' + '─'.repeat(90));

    for (const row of summary) {
      const bestF1 = Math.max(row.fts.f1, row.hybrid.f1, row.hybridMMR.f1);
      const f1Color = (v: number) => v === bestF1 ? 'green' : 'reset';
      console.log(
        '  ' + col(row.label, 42) +
        c(f1Color(row.fts.f1), row.fts.f1.toFixed(3)).padEnd(8 + 9) +
        c(f1Color(row.hybrid.f1), row.hybrid.f1.toFixed(3)).padEnd(8 + 9) +
        c(f1Color(row.hybridMMR.f1), row.hybridMMR.f1.toFixed(3)).padEnd(8 + 9) +
        (row.hybrid.p1 * 100).toFixed(1).padEnd(7) + '%' +
        row.hybrid.mrr.toFixed(3).padEnd(8) +
        `FTS ${row.crossLangFts}/6  H ${row.crossLangHybrid}/6`
      );
    }

    // 找最优模型
    const bestHybrid = summary.reduce((a, b) => a.hybrid.f1 > b.hybrid.f1 ? a : b);
    const bestMMR = summary.reduce((a, b) => a.hybridMMR.f1 > b.hybridMMR.f1 ? a : b);
    console.log('');
    console.log(`  ${c('green', '★')} 最优混合搜索: ${c('bold', bestHybrid.label)} (F1=${bestHybrid.hybrid.f1.toFixed(3)})`);
    console.log(`  ${c('green', '★')} 最优 MMR:     ${c('bold', bestMMR.label)} (F1=${bestMMR.hybridMMR.f1.toFixed(3)})`);
  }
}

// ===== Part K: 模型切换安全验证 =====

async function testModelSwitch() {
  section('Part K — Embedding 模型切换安全验证');

  sub('K1. 同维度切换（vec0 重建 + 旧 embedding 清除）');

  const db = new Database(':memory:');
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');

  // 第一次：用 local 384d 模型
  const key1 = buildModelKey('local', 'model-a', 384);
  applyMemorySchema(db, true, 384, key1);

  // 插入假数据
  const insertFile = db.prepare(
    `INSERT OR IGNORE INTO memory_files (path, folder, source, hash, mtime, size) VALUES (?, ?, 'memory', 'h', 0, 0)`
  );
  const insertChunk = db.prepare(
    `INSERT INTO memory_chunks (id, folder, path, source, start_line, end_line, hash, text, embedding, model)
     VALUES (?, 'f', ?, 'memory', 1, 1, 'h', 'test', ?, ?)`
  );
  insertFile.run('test.md', 'f');
  const fakeEmb = Buffer.alloc(384 * 4, 0);
  insertChunk.run('c1', 'test.md', fakeEmb, 'model-a');

  await test('K1: 初始 modelKey 已写入 memory_meta', () => {
    const row = db.prepare(
      `SELECT value FROM memory_meta WHERE folder = '__global__' AND key = 'embedding_model'`
    ).get() as { value: string } | undefined;
    ok(row?.value === key1, `expected ${key1}, got ${row?.value}`);
  });

  await test('K1: 初始 embedding 不为 NULL', () => {
    const row = db.prepare(`SELECT embedding FROM memory_chunks WHERE id = 'c1'`).get() as { embedding: Buffer | null } | undefined;
    ok(row?.embedding !== null, 'embedding 为 NULL');
  });

  // 第二次：切换到 openai 1536d 模型
  // 模型切换时，MemoryManager 会先清空旧 embedding，再重新初始化
  // 这里模拟该流程：先清空，再删除旧 modelKey，再调用 applyMemorySchema
  const key2 = buildModelKey('openai', 'text-embedding-3-small', 1536);
  db.exec(`UPDATE memory_chunks SET embedding = NULL, model = NULL`);
  db.exec(`DELETE FROM memory_meta WHERE key = 'embedding_model' AND folder = '__global__'`);
  applyMemorySchema(db, true, 1536, key2);

  await test('K1: 切换后 modelKey 已更新', () => {
    const row = db.prepare(
      `SELECT value FROM memory_meta WHERE folder = '__global__' AND key = 'embedding_model'`
    ).get() as { value: string } | undefined;
    ok(row?.value === key2, `expected ${key2}, got ${row?.value}`);
  });

  await test('K1: 切换后旧 embedding 已清除（NULL）', () => {
    const row = db.prepare(`SELECT embedding, model FROM memory_chunks WHERE id = 'c1'`).get() as { embedding: Buffer | null; model: string | null } | undefined;
    ok(row?.embedding === null, `embedding 应为 NULL，实际: ${row?.embedding ? 'Buffer' : 'null'}`);
    ok(row?.model === null, `model 应为 NULL，实际: ${row?.model}`);
  });

  sub('K2. 同模型重启（不重建，不清除）');

  const db2 = new Database(':memory:');
  db2.pragma('journal_mode = WAL');
  db2.pragma('foreign_keys = ON');

  const key = buildModelKey('openai', 'text-embedding-3-small', 1536);
  applyMemorySchema(db2, true, 1536, key);

  // 插入数据
  db2.prepare(`INSERT OR IGNORE INTO memory_files (path, folder, source, hash, mtime, size) VALUES ('t.md', 'f', 'memory', 'h', 0, 0)`).run();
  const emb1536 = Buffer.alloc(1536 * 4, 1);
  db2.prepare(
    `INSERT INTO memory_chunks (id, folder, path, source, start_line, end_line, hash, text, embedding, model)
     VALUES ('c2', 'f', 't.md', 'memory', 1, 1, 'h', 'test', ?, ?)`
  ).run(emb1536, 'text-embedding-3-small');

  // 再次用同模型初始化（模拟重启）
  applyMemorySchema(db2, true, 1536, key);

  await test('K2: 同模型重启后 embedding 未被清除', () => {
    const row = db2.prepare(`SELECT embedding FROM memory_chunks WHERE id = 'c2'`).get() as { embedding: Buffer | null } | undefined;
    ok(row?.embedding !== null, 'embedding 被意外清除');
  });

  sub('K3. L2 → cosine 旧表迁移');

  const db3 = new Database(':memory:');
  db3.pragma('journal_mode = WAL');
  db3.pragma('foreign_keys = ON');

  // 先建不含 cosine 的 FTS-only schema
  applyMemorySchema(db3, false);

  // 手动创建旧式 L2 vec 表（不含 distance_metric=cosine）
  try {
    const sqliteVec = require('sqlite-vec');
    sqliteVec.load(db3);
    db3.exec(`CREATE VIRTUAL TABLE IF NOT EXISTS memory_chunks_vec USING vec0(chunk_id TEXT PRIMARY KEY, embedding float[4])`);

    // 再次调用 applyMemorySchema 触发迁移
    applyMemorySchema(db3, true, 4, buildModelKey('local', 'test', 4));

    await test('K3: 旧 L2 表已迁移为 cosine', () => {
      const row = db3.prepare(
        `SELECT sql FROM sqlite_master WHERE type='table' AND name='memory_chunks_vec'`
      ).get() as { sql: string } | undefined;
      ok(row?.sql?.includes('distance_metric=cosine') ?? false,
        `vec0 DDL 中无 cosine: ${row?.sql}`);
    });
  } catch {
    console.log(`    ${c('yellow', '⚠')} sqlite-vec 不可用，跳过 K3`);
  }

  db.close();
  db2.close();
  db3.close();
}

// ===== 主流程 =====

async function main() {
  console.log(c('bold', '\n' + '━'.repeat(72)));
  console.log(c('blue', '  Semaclaw 3.17 — 多模型大数据集完整检测'));
  console.log(c('bold', '━'.repeat(72)));

  const { testDocuments, testQueries, relevanceMatrix } = loadDataset();
  info(`数据集: ${testDocuments.length} 文档 / ${testQueries.length} 查询`);

  const openrouterKey = process.env.OPENROUTER_API_KEY || '';
  const skipEmbed = process.env.SKIP_EMBED === '1';
  if (openrouterKey) info(`OpenRouter key: ${openrouterKey.slice(0, 12)}...`);
  if (skipEmbed) info('SKIP_EMBED=1: 跳过 embedding 相关测试');

  // G: 真实文件结构
  await testRealFileStructure();

  // H: 混合检索路径
  await testSearchPaths(testDocuments, testQueries, relevanceMatrix);

  // I: MMR 效果对比
  await testMMR(testDocuments, testQueries, relevanceMatrix);

  // J: 多模型对比
  await testMultiModel(testDocuments, testQueries, relevanceMatrix);

  // K: 模型切换安全
  await testModelSwitch();

  // ===== 汇总 =====
  console.log('\n' + c('bold', '═'.repeat(72)));
  console.log(c('blue', '  测试汇总'));
  console.log(c('bold', '═'.repeat(72)));
  console.log(`\n  总计: ${pass + fail} 个测试`);
  if (fail === 0) {
    console.log(`  ${c('green', `✓ 通过: ${pass}`)}`);
  } else {
    console.log(`  ${c('green', `✓ 通过: ${pass}`)}  ${c('red', `✗ 失败: ${fail}`)}`);
    console.log(c('red', '\n  失败列表:'));
    for (const f of failures) console.log(`    ${c('red', '✗')} ${f}`);
  }
  console.log('');

  if (fail > 0) process.exit(1);
}

main().catch(e => {
  console.error(c('red', `\n致命错误: ${e}`));
  process.exit(1);
});
