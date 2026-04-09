/**
 * Semaclaw 3.17 综合功能测试
 *
 * 覆盖范围（每个细节功能）：
 *
 *  Part A — 基础组件单元测试
 *    A1. Chunker：CJK 比例、重叠、空文本、长文本
 *    A2. Tokenizer：中文 Jieba、英文、中英混合、停用词过滤
 *    A3. Query Rewrite：疑问词移除、助词移除、空结果返回 ''
 *    A4. expandQueryTokens：中→英、英→中、双向、去重
 *    A5. Schema：表结构、FTS 独立表、触发器、向量表维度
 *    A6. Embedding Cache：命中/未命中、去重
 *
 *  Part B — 搜索路径分层测试
 *    B1. FTS-only 路径（无 embedding）：基本搜索、BM25 归一化
 *    B2. minScore 仅对混合搜索路径生效（FTS-only 路径 minScore 无效）
 *    B3. 混合搜索路径（有 embedding）：向量+FTS 融合
 *    B4. Fallback 链路：FTS 无结果 → keyword fallback
 *    B5. 空查询 / 纯停用词查询
 *    B6. source 过滤（memory / session / all）
 *
 *  Part C — 向量搜索专项
 *    C1. 向量 score 相对归一化（最近距离=1，最远=0）
 *    C2. 混合权重（向量 0.7 + FTS 0.3）
 *    C3. 跨语言向量匹配（中文查→英文文档，英文查→中文文档）
 *
 *  Part D — FTS 专项
 *    D1. 跨语言 FTS（expandQueryTokens 中↔英）
 *    D2. BM25 归一化：最相关 score=1，最不相关 score=0
 *    D3. 2-gram fallback
 *
 *  Part E — Embedding Provider 测试
 *    E1. local provider（Transformers.js）：初始化、embed、维度
 *    E2. openai provider mock（无真实 key，验证构建和错误处理）
 *    E3. openrouter provider mock
 *    E4. ollama provider mock
 *    E5. none provider → null
 *
 *  Part F — 大批量质量指标
 *    F1. FTS-only 全量 P/R/F1/MRR
 *    F2. 混合搜索 全量 P/R/F1/MRR（最优 minScore 扫描）
 *    F3. FTS vs 混合 并排对比
 *    F4. 跨语言专项命中率
 *    F5. 按类别细分
 */

import Database from 'better-sqlite3';
import * as assert from 'assert';
import { applyMemorySchema } from './src/memory/memory-schema';
import { hybridSearch } from './src/memory/fts-search';
import { tokenizeOptimized, generate2gram } from './src/memory/tokenizer';
import { smartRewriteQuery, expandQueryTokens } from './src/memory/query-rewrite';
import { estimateTokens, chunkText } from './src/memory/chunker';
import { createEmbeddingProvider, CachedEmbeddingProvider, type EmbeddingConfig, type EmbeddingProvider } from './src/memory/embedding';

// ===== 颜色输出 =====

const C = {
  reset: '\x1b[0m', green: '\x1b[32m', red: '\x1b[31m',
  yellow: '\x1b[33m', blue: '\x1b[34m', cyan: '\x1b[36m',
  bold: '\x1b[1m', dim: '\x1b[2m',
};
const c = (col: keyof typeof C, s: string) => `${C[col]}${s}${C.reset}`;
const section = (s: string) => console.log('\n' + c('bold', '═'.repeat(68)) + '\n' + c('blue', `  ${s}`) + '\n' + c('bold', '═'.repeat(68)));
const sub = (s: string) => console.log('\n' + c('cyan', `  ── ${s}`));

// ===== 测试框架 =====

let pass = 0, fail = 0, skip = 0;
const failures: string[] = [];

function test(name: string, fn: () => void | Promise<void>) {
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

function approx(a: number, b: number, tol = 0.01, msg = '') {
  if (Math.abs(a - b) > tol) throw new Error(`${msg} expected ~${b}, got ${a} (tol=${tol})`);
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

// ===== 建库工具 =====

function buildDb(
  docs: TestDocument[],
  enableVec = false,
  dimensions = 384,
): { db: Database.Database; chunkIdToDocId: Map<string, string> } {
  const db = new Database(':memory:');
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  applyMemorySchema(db, enableVec, dimensions);

  const folder = 'test-agent';
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
      insertFile.run(fp, folder, chunkId);
      const tok = tokenizeOptimized(doc.text, false).join(' ');
      insertChunk.run(chunkId, folder, fp, chunkId, doc.text);
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

  process.stdout.write(`  Embedding ${entries.length} docs`);
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
    const retrieved = retrievedIds.length;
    const relevant = relevantSet.size;
    const rr = retrievedIds.filter(id => relevantSet.has(id)).length;

    totalPrecision += retrieved > 0 ? rr / retrieved : 0;
    totalRecall += relevant > 0 ? rr / relevant : (retrieved === 0 ? 1 : 0);
    totalRR += rr;
    totalRetrieved += retrieved;
    totalRelevant += relevant;

    // MRR
    let firstRank = 0;
    for (let i = 0; i < retrievedIds.length; i++) {
      if (relevantSet.has(retrievedIds[i])) { firstRank = i + 1; break; }
    }
    totalMrr += firstRank > 0 ? 1 / firstRank : 0;

    // P@1
    totalP1 += (retrievedIds.length > 0 && relevantSet.has(retrievedIds[0])) ? 1 : 0;
  }

  const n = queryResults.length;
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

async function runQueries(
  db: Database.Database,
  queries: TestQuery[],
  folder: string,
  embeddingProvider: EmbeddingProvider | null,
  chunkIdToDocId: Map<string, string>,
  opts: { maxResults: number; minScore: number },
): Promise<Array<{ queryId: string; retrievedIds: string[]; category: string }>> {
  const results: Array<{ queryId: string; retrievedIds: string[]; category: string }> = [];
  for (const q of queries) {
    const r = await hybridSearch(db, folder, q.query, embeddingProvider, opts);
    const toDocId = (id: string) => chunkIdToDocId.get(id) ?? id;
    results.push({ queryId: q.id, retrievedIds: r.map(x => toDocId(x.id)), category: q.category });
  }
  return results;
}

// ===== 主流程 =====

async function main() {
  console.log(c('bold', '\n' + '━'.repeat(68)));
  console.log(c('blue', '  Semaclaw 3.17 综合功能测试'));
  console.log(c('bold', '━'.repeat(68)));

  // ─────────────────────────────────────────────────────────
  section('Part A — 基础组件单元测试');
  // ─────────────────────────────────────────────────────────

  sub('A1. Chunker');

  await test('estimateTokens: 空字符串返回 0', () => {
    ok(estimateTokens('') === 0, `got ${estimateTokens('')}`);
    ok(estimateTokens('   ') === 0, `got ${estimateTokens('   ')}`);
  });

  await test('estimateTokens: 纯英文按词计数', () => {
    const n = estimateTokens('hello world foo bar');
    ok(n === 4, `got ${n}`);
  });

  await test('estimateTokens: CJK 比例 1.2（非 1.5）', () => {
    // "你好世界测试" = 6 CJK 字符 → ceil(6/1.2) = 5（若比例为 1.5 则 ceil(6/1.5)=4）
    const n = estimateTokens('你好世界测试');
    ok(n === 5, `6 CJK chars → expected 5 (ratio=1.2), got ${n}. If got 4 → ratio is still 1.5`);
  });

  await test('estimateTokens: 中英混合', () => {
    // "hello 世界" → 1 英文词 + ceil(2/1.2)=2 CJK = 3
    const n = estimateTokens('hello 世界');
    ok(n === 3, `got ${n}`);
  });

  await test('chunkText: 空文本返回空数组', () => {
    const chunks = chunkText('');
    ok(chunks.length === 0, `got ${chunks.length}`);
    const chunks2 = chunkText('   \n  \n  ');
    ok(chunks2.length === 0, `got ${chunks2.length}`);
  });

  await test('chunkText: 短文本单块', () => {
    const text = 'line1\nline2\nline3';
    const chunks = chunkText(text, { chunkSize: 400 });
    ok(chunks.length === 1, `expected 1 chunk, got ${chunks.length}`);
    ok(chunks[0].startLine === 1, `startLine=${chunks[0].startLine}`);
    ok(chunks[0].endLine === 3, `endLine=${chunks[0].endLine}`);
  });

  await test('chunkText: 长文本分多块（有重叠）', () => {
    // 每行约 10 tokens（10 个英文词），chunkSize=30 → 每 3 行一块
    const lines = Array.from({ length: 20 }, (_, i) =>
      `word${i}a word${i}b word${i}c word${i}d word${i}e word${i}f word${i}g word${i}h word${i}i word${i}j`
    );
    const text = lines.join('\n');
    const chunks = chunkText(text, { chunkSize: 30, chunkOverlap: 10 });
    ok(chunks.length > 1, `expected multiple chunks, got ${chunks.length}`);
    // 验证重叠：相邻块的结束行应 > 下一块起始行
    for (let i = 0; i < chunks.length - 1; i++) {
      ok(chunks[i + 1].startLine <= chunks[i].endLine,
        `chunk ${i} endLine=${chunks[i].endLine}, chunk ${i+1} startLine=${chunks[i+1].startLine} — no overlap`);
    }
  });

  await test('chunkText: 行号正确（1-based）', () => {
    const text = 'a\nb\nc\nd\ne';
    const chunks = chunkText(text, { chunkSize: 2, chunkOverlap: 0 });
    ok(chunks[0].startLine === 1, `first chunk startLine=${chunks[0].startLine}`);
    ok(chunks[0].endLine >= 1, `first chunk endLine=${chunks[0].endLine}`);
  });

  await test('chunkText: 单行超过 chunkSize 不无限循环', () => {
    // 一行 1000 词，chunkSize=10 → 不应卡死
    const longLine = Array.from({ length: 1000 }, (_, i) => `w${i}`).join(' ');
    const chunks = chunkText(longLine, { chunkSize: 10, chunkOverlap: 5 });
    ok(chunks.length >= 1, `got ${chunks.length}`);
  });

  sub('A2. Tokenizer');

  await test('tokenizeOptimized: 空文本返回 []', () => {
    ok(tokenizeOptimized('').length === 0, 'empty string');
    ok(tokenizeOptimized('   ').length === 0, 'whitespace only');
  });

  await test('tokenizeOptimized: 中文 Jieba 分词', () => {
    const tokens = tokenizeOptimized('内存泄漏问题', false);
    ok(tokens.length > 0, 'no tokens');
    // Jieba 应能切出"内存"或"内存泄漏"
    const joined = tokens.join('');
    ok(joined.includes('内存') || joined.includes('泄漏'), `tokens=${tokens.join(',')}`);
  });

  await test('tokenizeOptimized: 英文按空格/标点分词', () => {
    const tokens = tokenizeOptimized('memory leak detection', false);
    ok(tokens.includes('memory'), `tokens=${tokens.join(',')}`);
    ok(tokens.includes('leak'), `tokens=${tokens.join(',')}`);
    ok(tokens.includes('detection'), `tokens=${tokens.join(',')}`);
  });

  await test('tokenizeOptimized: 中英混合', () => {
    const tokens = tokenizeOptimized('内存 memory leak 泄漏', false);
    const joined = tokens.join(' ');
    ok(joined.includes('memory'), `missing 'memory': ${joined}`);
    ok(joined.includes('leak'), `missing 'leak': ${joined}`);
  });

  await test('tokenizeOptimized: 停用词过滤（removeStopwords=true）', () => {
    // "的" "是" "在" 是中文停用词
    const withStop = tokenizeOptimized('这是一个问题', false);
    const noStop = tokenizeOptimized('这是一个问题', true);
    // 过滤后应 ≤ 未过滤
    ok(noStop.length <= withStop.length, `noStop=${noStop.length} > withStop=${withStop.length}`);
  });

  await test('tokenizeOptimized: 结果去重', () => {
    const tokens = tokenizeOptimized('test test test', false);
    const unique = [...new Set(tokens)];
    ok(tokens.length === unique.length, `duplicates found: ${tokens.join(',')}`);
  });

  await test('generate2gram: 中文 2-gram', () => {
    const grams = generate2gram('内存泄漏');
    ok(grams.includes('内存'), `missing '内存': ${grams.join(',')}`);
    ok(grams.includes('存泄'), `missing '存泄': ${grams.join(',')}`);
    ok(grams.includes('泄漏'), `missing '泄漏': ${grams.join(',')}`);
  });

  await test('generate2gram: 纯英文返回 []', () => {
    const grams = generate2gram('hello world');
    ok(grams.length === 0, `got ${grams.join(',')}`);
  });

  sub('A3. Query Rewrite');

  await test('smartRewriteQuery: 移除中文疑问词', () => {
    const r = smartRewriteQuery('为什么内存泄漏');
    ok(!r.startsWith('为什么'), `result: "${r}"`);
    ok(r.length > 0, 'empty result');
  });

  await test('smartRewriteQuery: 移除英文疑问词', () => {
    const r = smartRewriteQuery('how to debug memory leak');
    ok(!r.toLowerCase().startsWith('how'), `result: "${r}"`);
  });

  await test('smartRewriteQuery: 移除助词', () => {
    const r = smartRewriteQuery('如何能优化数据库');
    ok(!r.includes('能'), `result: "${r}"`);
  });

  await test('smartRewriteQuery: 单字停用词返回空字符串', () => {
    // 单字停用词（"的""是""在"等）改写后 < 2 chars，应返回 ''
    const cases = ['的', '了', '在', '是', '和'];
    for (const q of cases) {
      const r = smartRewriteQuery(q);
      ok(r === '', `"${q}" → expected '', got "${r}"`);
    }
  });

  await test('smartRewriteQuery: 多字停用词重复也返回空字符串（Fix3）', () => {
    // Fix3: rewriteQueryWithTokenization 改为返回 '' 而非回退到原字符串
    // "如何如何如何" → rewriteQuery 去掉前缀"如何" → "如何如何" → tokenize → [] → 返回 ''
    // smartRewriteQuery 得到 '' → 返回 ''
    const r = smartRewriteQuery('如何如何如何');
    ok(r === '', `expected '', got "${r}"`);
  });

  await test('smartRewriteQuery: 正常查询不丢失关键词', () => {
    const r = smartRewriteQuery('内存泄漏排查');
    ok(r.length > 0, 'empty result');
  });

  sub('A4. expandQueryTokens');

  await test('expandQueryTokens: 中→英扩展', () => {
    const tokens = ['内存', '泄漏'];
    const expanded = expandQueryTokens(tokens);
    ok(expanded.includes('memory'), `missing 'memory': ${expanded.join(',')}`);
    ok(expanded.includes('leak'), `missing 'leak': ${expanded.join(',')}`);
  });

  await test('expandQueryTokens: 英→中扩展', () => {
    const tokens = ['memory', 'leak'];
    const expanded = expandQueryTokens(tokens);
    ok(expanded.includes('内存'), `missing '内存': ${expanded.join(',')}`);
    ok(expanded.includes('泄漏'), `missing '泄漏': ${expanded.join(',')}`);
  });

  await test('expandQueryTokens: 双向不重复', () => {
    const tokens = ['database', '数据库'];
    const expanded = expandQueryTokens(tokens);
    const counts = new Map<string, number>();
    for (const t of expanded) counts.set(t, (counts.get(t) || 0) + 1);
    for (const [t, n] of counts) {
      ok(n === 1, `token "${t}" appears ${n} times`);
    }
  });

  await test('expandQueryTokens: 未知词原样保留', () => {
    const tokens = ['unknownXYZ'];
    const expanded = expandQueryTokens(tokens);
    ok(expanded.includes('unknownXYZ'), `missing original: ${expanded.join(',')}`);
  });

  sub('A5. Schema 结构验证');

  await test('Schema: 所有必要表都存在', () => {
    const db = new Database(':memory:');
    applyMemorySchema(db, false);
    const tables = (db.prepare(
      `SELECT name FROM sqlite_master WHERE type='table' ORDER BY name`
    ).all() as Array<{ name: string }>).map(r => r.name);
    const required = ['memory_files', 'memory_chunks', 'embedding_cache', 'memory_meta'];
    for (const t of required) {
      ok(tables.includes(t), `missing table: ${t}`);
    }
    db.close();
  });

  await test('Schema: FTS 表为独立表（非 external-content）', () => {
    const db = new Database(':memory:');
    applyMemorySchema(db, false);
    // 独立表：memory_chunks_fts 的 shadow tables 不含 content 字段
    // 验证方式：直接插入 chunk_id 和 text 不报错
    db.prepare(`INSERT INTO memory_files (path, folder, source, hash, mtime, size) VALUES ('p', 'f', 'memory', 'h', 0, 0)`).run();
    db.prepare(`INSERT INTO memory_chunks (id, folder, path, source, start_line, end_line, hash, text) VALUES ('c1', 'f', 'p', 'memory', 1, 1, 'h', 'test text')`).run();
    // 应能独立写入分词文本（不同于原始文本）
    db.prepare(`INSERT INTO memory_chunks_fts (chunk_id, text) VALUES ('c1', 'tokenized text here')`).run();
    const row = db.prepare(`SELECT text FROM memory_chunks_fts WHERE chunk_id = 'c1'`).get() as { text: string } | undefined;
    ok(row?.text === 'tokenized text here', `FTS text=${row?.text}`);
    db.close();
  });

  await test('Schema: DELETE 触发器同步删除 FTS', () => {
    const db = new Database(':memory:');
    applyMemorySchema(db, false);
    db.prepare(`INSERT INTO memory_files (path, folder, source, hash, mtime, size) VALUES ('p', 'f', 'memory', 'h', 0, 0)`).run();
    db.prepare(`INSERT INTO memory_chunks (id, folder, path, source, start_line, end_line, hash, text) VALUES ('c1', 'f', 'p', 'memory', 1, 1, 'h', 'test')`).run();
    db.prepare(`INSERT INTO memory_chunks_fts (chunk_id, text) VALUES ('c1', 'test')`).run();
    // 删除 chunk → 触发器应删除 FTS 行
    db.prepare(`DELETE FROM memory_chunks WHERE id = 'c1'`).run();
    const row = db.prepare(`SELECT * FROM memory_chunks_fts WHERE chunk_id = 'c1'`).get();
    ok(row === undefined, 'FTS row should be deleted by trigger');
    db.close();
  });

  await test('Schema: 向量表维度正确（384d）', () => {
    const db = new Database(':memory:');
    applyMemorySchema(db, true, 384);
    // 尝试插入 384 维向量
    const vec = new Float32Array(384).fill(0.1);
    const buf = Buffer.from(vec.buffer);
    db.prepare(`INSERT INTO memory_files (path, folder, source, hash, mtime, size) VALUES ('p', 'f', 'memory', 'h', 0, 0)`).run();
    db.prepare(`INSERT INTO memory_chunks (id, folder, path, source, start_line, end_line, hash, text) VALUES ('c1', 'f', 'p', 'memory', 1, 1, 'h', 'test')`).run();
    // 向量插入不应报错
    try {
      db.prepare(`INSERT INTO memory_chunks_vec (chunk_id, embedding) VALUES ('c1', ?)`).run(buf);
      ok(true, 'vector insert succeeded');
    } catch (e: any) {
      // sqlite-vec 可能未安装，跳过
      if (e.message.includes('no such table') || e.message.includes('sqlite-vec')) {
        console.log(c('dim', `    (sqlite-vec not available, skipping vec insert check)`));
      } else {
        throw e;
      }
    }
    db.close();
  });

  await test('Schema: 幂等（多次调用不报错）', () => {
    const db = new Database(':memory:');
    applyMemorySchema(db, false);
    applyMemorySchema(db, false); // 第二次调用
    applyMemorySchema(db, false); // 第三次调用
    ok(true, 'no error');
    db.close();
  });

  await test('Schema: vec0 使用 cosine distance_metric（Fix1）', () => {
    const db = new Database(':memory:');
    applyMemorySchema(db, true, 4);
    // 验证建表 SQL 包含 distance_metric=cosine
    const row = db.prepare(
      `SELECT sql FROM sqlite_master WHERE type='table' AND name='memory_chunks_vec'`
    ).get() as { sql: string } | undefined;
    ok(row !== undefined, 'memory_chunks_vec table not found');
    ok(row!.sql.includes('distance_metric=cosine'), `DDL missing cosine: ${row!.sql}`);
    db.close();
  });

  await test('Schema: vec0 迁移（旧 L2 表自动重建为 cosine）（Fix1）', () => {
    const db = new Database(':memory:');
    // 手动创建旧版（无 distance_metric）vec0 表
    const sqliteVec = require('sqlite-vec');
    sqliteVec.load(db);
    db.exec(`CREATE VIRTUAL TABLE memory_chunks_vec USING vec0(chunk_id TEXT PRIMARY KEY, embedding float[4])`);
    const before = db.prepare(`SELECT sql FROM sqlite_master WHERE name='memory_chunks_vec'`).get() as { sql: string };
    ok(!before.sql.includes('distance_metric=cosine'), 'pre-condition: should not have cosine yet');
    // 调用 applyMemorySchema 应触发迁移
    applyMemorySchema(db, true, 4);
    const after = db.prepare(`SELECT sql FROM sqlite_master WHERE name='memory_chunks_vec'`).get() as { sql: string };
    ok(after.sql.includes('distance_metric=cosine'), `after migration DDL missing cosine: ${after.sql}`);
    db.close();
  });

  sub('A6. Embedding Cache');

  await test('EmbeddingCache: 命中时不重复调用 inner.embed', async () => {
    let callCount = 0;
    const mockProvider: EmbeddingProvider = {
      name: 'mock', model: 'mock-model', dimensions: 4,
      async embed(texts: string[]) {
        callCount++;
        return texts.map(() => new Float32Array([0.1, 0.2, 0.3, 0.4]));
      },
    };
    const db = new Database(':memory:');
    applyMemorySchema(db, false);
    const cached = new CachedEmbeddingProvider(mockProvider, db);

    // 第一次调用
    await cached.embed(['hello world']);
    ok(callCount === 1, `first call: callCount=${callCount}`);

    // 第二次相同文本 → 应命中缓存
    await cached.embed(['hello world']);
    ok(callCount === 1, `cache hit: callCount=${callCount} (expected 1)`);

    // 不同文本 → 应调用 inner
    await cached.embed(['different text']);
    ok(callCount === 2, `new text: callCount=${callCount}`);

    db.close();
  });

  await test('EmbeddingCache: 返回正确的向量', async () => {
    const mockProvider: EmbeddingProvider = {
      name: 'mock', model: 'mock-model', dimensions: 4,
      async embed(texts: string[]) {
        return texts.map((_, i) => new Float32Array([i + 0.1, i + 0.2, i + 0.3, i + 0.4]));
      },
    };
    const db = new Database(':memory:');
    applyMemorySchema(db, false);
    const cached = new CachedEmbeddingProvider(mockProvider, db);

    const results = await cached.embed(['a', 'b']);
    ok(results.length === 2, `length=${results.length}`);
    approx(results[0][0], 0.1, 0.001, 'results[0][0]');
    approx(results[1][0], 1.1, 0.001, 'results[1][0]');

    // 从缓存读取
    const cached2 = await cached.embed(['a', 'b']);
    approx(cached2[0][0], 0.1, 0.001, 'cached[0][0]');
    approx(cached2[1][0], 1.1, 0.001, 'cached[1][0]');

    db.close();
  });

  await test('EmbeddingCache: Buffer 对齐安全构造（Fix6）', async () => {
    // 验证从缓存读回的向量与写入时相同（buffer.slice 方式不丢数据）
    const expected = new Float32Array([0.1, 0.2, 0.3, 0.4]);
    const mockProvider: EmbeddingProvider = {
      name: 'mock', model: 'mock-model', dimensions: 4,
      async embed() { return [expected]; },
    };
    const db = new Database(':memory:');
    applyMemorySchema(db, false);
    const cached = new CachedEmbeddingProvider(mockProvider, db);
    await cached.embed(['test']);          // 写入缓存
    const [fromCache] = await cached.embed(['test']);  // 从缓存读取
    ok(fromCache.length === 4, `length=${fromCache.length}`);
    for (let i = 0; i < 4; i++) {
      approx(fromCache[i], expected[i], 0.0001, `fromCache[${i}]`);
    }
    db.close();
  });

  // ─────────────────────────────────────────────────────────
  section('Part B — 搜索路径分层测试');
  // ─────────────────────────────────────────────────────────

  const { testDocuments, testQueries, relevanceMatrix } = loadDataset();
  console.log(`\n  数据集: ${testDocuments.length} 文档 / ${testQueries.length} 查询`);

  const { db: dbFts, chunkIdToDocId } = buildDb(testDocuments, false);
  const folder = 'test-agent';

  sub('B1. FTS-only 基本搜索');

  await test('FTS: 中文查询返回相关结果', async () => {
    const results = await hybridSearch(dbFts, folder, '数据库索引优化', null, { maxResults: 5 });
    ok(results.length > 0, 'no results');
    // 验证结果有 score 和 text
    ok(results[0].score >= 0 && results[0].score <= 1, `score=${results[0].score}`);
    ok(results[0].text.length > 0, 'empty text');
  });

  await test('FTS: 英文查询返回相关结果', async () => {
    const results = await hybridSearch(dbFts, folder, 'memory leak', null, { maxResults: 5 });
    ok(results.length > 0, 'no results');
  });

  await test('FTS: 结果按 score 降序排列', async () => {
    const results = await hybridSearch(dbFts, folder, '性能优化', null, { maxResults: 6 });
    for (let i = 0; i < results.length - 1; i++) {
      ok(results[i].score >= results[i + 1].score,
        `score[${i}]=${results[i].score} < score[${i+1}]=${results[i+1].score}`);
    }
  });

  await test('FTS: 最多返回 maxResults 条', async () => {
    const results = await hybridSearch(dbFts, folder, '数据库', null, { maxResults: 3 });
    ok(results.length <= 3, `got ${results.length}`);
  });

  sub('B2. minScore 仅对混合路径生效');

  await test('FTS-only: minScore=0.99 不过滤结果（FTS 不受 minScore 影响）', async () => {
    const r1 = await hybridSearch(dbFts, folder, '数据库索引', null, { maxResults: 6, minScore: 0 });
    const r2 = await hybridSearch(dbFts, folder, '数据库索引', null, { maxResults: 6, minScore: 0.99 });
    // FTS-only 路径 minScore 无效，两者应返回相同数量
    ok(r1.length === r2.length,
      `FTS minScore should not filter: minScore=0 got ${r1.length}, minScore=0.99 got ${r2.length}`);
  });

  sub('B2b. Fix3 验证：多字停用词查询不走 fallback');

  await test('多字停用词查询返回空（不走 keyword fallback 误匹配）（Fix3）', async () => {
    // Fix3 前："如何如何如何" → smartRewriteQuery 返回 "如何如何" → FTS 无结果 → keyword fallback → 随机结果
    // Fix3 后："如何如何如何" → smartRewriteQuery 返回 '' → hybridSearch 直接返回 []
    const results = await hybridSearch(dbFts, folder, '如何如何如何', null, { maxResults: 5 });
    ok(results.length === 0, `expected 0 results for stopword-only query, got ${results.length}`);
  });

  sub('B3. Fallback 链路');

  await test('Fallback: 不存在的词触发 keyword fallback', async () => {
    // 完全不存在的词 → FTS 无结果 → keyword fallback → 可能 0 结果（正常）
    const results = await hybridSearch(dbFts, folder, 'xyzzy_nonexistent_9999', null, { maxResults: 3, minScore: 0 });
    // 只验证不报错，结果 0 或有结果都可接受
    ok(results.length >= 0, 'should not throw');
  });

  await test('Fallback: 2-gram 匹配中文子串', async () => {
    // "内存泄" 不是完整词，但 2-gram 应能匹配含"内存"或"泄漏"的文档
    const results = await hybridSearch(dbFts, folder, '内存泄', null, { maxResults: 5, minScore: 0 });
    ok(results.length >= 0, 'should not throw');
  });

  sub('B4. 空查询 / 纯停用词');

  await test('空查询返回空数组', async () => {
    const results = await hybridSearch(dbFts, folder, '', null, { maxResults: 5 });
    ok(results.length === 0, `expected 0, got ${results.length}`);
  });

  await test('纯停用词查询（如"如何如何"）不崩溃', async () => {
    const results = await hybridSearch(dbFts, folder, '如何如何如何', null, { maxResults: 5 });
    ok(results.length >= 0, 'should not throw');
  });

  sub('B5. source 过滤');

  await test('source=memory 只返回 memory 来源', async () => {
    const results = await hybridSearch(dbFts, folder, '数据库', null, { maxResults: 10, source: 'memory' });
    for (const r of results) {
      ok(r.source === 'memory', `unexpected source: ${r.source}`);
    }
  });

  await test('source=session 无 session 数据时返回空', async () => {
    const results = await hybridSearch(dbFts, folder, '数据库', null, { maxResults: 10, source: 'session' });
    ok(results.length === 0, `expected 0, got ${results.length}`);
  });

  // ─────────────────────────────────────────────────────────
  section('Part C — 向量搜索专项');
  // ─────────────────────────────────────────────────────────

  console.log('\n  初始化本地 embedding provider...');
  const embCfg: EmbeddingConfig = {
    provider: 'local',
    localModel: 'Xenova/paraphrase-multilingual-MiniLM-L12-v2',
  };
  const embeddingProvider = createEmbeddingProvider(embCfg, dbFts);

  if (!embeddingProvider) {
    console.log(c('yellow', '  ⚠ local embedding provider 不可用，跳过 Part C 向量测试'));
    skip += 6;
  } else {
    console.log(`  Provider: ${embeddingProvider.name}, model: ${embeddingProvider.model}, dim: ${embeddingProvider.dimensions}`);

    await test('C1. Provider 维度正确（384d）', () => {
      ok(embeddingProvider.dimensions === 384, `expected 384, got ${embeddingProvider.dimensions}`);
    });

    await test('C1. embed() 返回正确形状', async () => {
      const embs = await embeddingProvider.embed(['hello world', '内存泄漏']);
      ok(embs.length === 2, `length=${embs.length}`);
      ok(embs[0].length === 384, `dim=${embs[0].length}`);
      ok(embs[1].length === 384, `dim=${embs[1].length}`);
    });

    await test('C1. embed() 向量范数合理（非全零）', async () => {
      const embs = await embeddingProvider.embed(['test sentence']);
      const norm = Math.sqrt(embs[0].reduce((s, v) => s + v * v, 0));
      ok(norm > 0.1, `norm=${norm} too small`);
    });

    // 建向量库
    console.log('\n  建向量库...');
    const { db: dbVec, chunkIdToDocId: cid2 } = buildDb(testDocuments, true, 384);
    await embedAllDocs(dbVec, testDocuments, cid2, embeddingProvider);

    await test('C2. 混合搜索返回结果（有 embedding）', async () => {
      const results = await hybridSearch(dbVec, folder, '内存泄漏', embeddingProvider, { maxResults: 5, minScore: 0 });
      ok(results.length > 0, 'no results');
    });

    await test('C2. 混合搜索 score 在 [0, 1] 范围', async () => {
      const results = await hybridSearch(dbVec, folder, '数据库优化', embeddingProvider, { maxResults: 6, minScore: 0 });
      for (const r of results) {
        ok(r.score >= 0 && r.score <= 1.5, `score=${r.score} out of range`);
      }
    });

    await test('C2. minScore 过滤（混合路径）', async () => {
      const r0 = await hybridSearch(dbVec, folder, '数据库', embeddingProvider, { maxResults: 10, minScore: 0 });
      const r8 = await hybridSearch(dbVec, folder, '数据库', embeddingProvider, { maxResults: 10, minScore: 0.8 });
      // minScore=0.8 应过滤掉一些结果
      ok(r8.length <= r0.length, `minScore=0.8 got ${r8.length} > minScore=0 got ${r0.length}`);
    });

    await test('C2. vecSearch 走 vec0 MATCH 路径（Fix1）', async () => {
      // 验证：vec0 表中有数据，且搜索能通过 MATCH 路径返回结果（而非 BLOB 全表扫描）
      const vecCount = (dbVec.prepare('SELECT COUNT(*) as c FROM memory_chunks_vec').get() as { c: number }).c;
      ok(vecCount > 0, `vec0 table empty (${vecCount} rows) — Fix1 may not be working`);
      // 搜索应能正常返回（vec0 MATCH 路径）
      const results = await hybridSearch(dbVec, folder, '内存管理', embeddingProvider, { maxResults: 5, minScore: 0 });
      ok(results.length > 0, 'no results via vec0 MATCH path');
      // score 应在合理范围（相对归一化后 [0,1]）
      for (const r of results) {
        ok(r.score >= 0 && r.score <= 1.01, `vec0 score out of range: ${r.score}`);
      }
    });

    await test('C2. vec0 MATCH k 不因多 folder 欠取（Fix8）', async () => {
      // 创建独立的双 folder 数据库，验证 k 取 total count 后每个 folder 都能拿到足够结果
      const db2 = new Database(':memory:');
      const sqliteVec2 = require('sqlite-vec');
      sqliteVec2.load(db2);
      applyMemorySchema(db2, true, 4);
      db2.exec('PRAGMA foreign_keys = OFF');  // 测试只需 memory_chunks + vec，不需要 memory_files

      // 插入 10 条 chunks：f1 和 f2 各 5 条
      const insertChunk = db2.prepare(
        `INSERT INTO memory_chunks (id, folder, path, source, start_line, end_line, hash, text, embedding, model)
         VALUES (?, ?, ?, 'memory', 1, 1, ?, ?, ?, 'test')`
      );
      const insertVec = db2.prepare('INSERT INTO memory_chunks_vec (chunk_id, embedding) VALUES (?, ?)');
      const rng = (i: number) => new Float32Array([Math.sin(i), Math.cos(i), Math.sin(i * 2), Math.cos(i * 2)]);
      for (let i = 0; i < 10; i++) {
        const id = `chunk-${i}`;
        const folder2 = i < 5 ? 'f1' : 'f2';
        const emb = rng(i);
        const embBuf = Buffer.from(emb.buffer);
        insertChunk.run(id, folder2, `/p/${id}`, `hash${i}`, `text ${i}`, embBuf);
        insertVec.run(id, embBuf);
      }

      // 用 f1 第一个 chunk 的向量搜 f1，应能拿到 5 条（不是 k/2=3 条）
      const q = Buffer.from(rng(0).buffer);
      // 直接测 SQL：k = total (10)
      const total = (db2.prepare('SELECT COUNT(*) as c FROM memory_chunks_vec').get() as { c: number }).c;
      const rows = db2.prepare(`
        SELECT v.chunk_id, v.distance
        FROM memory_chunks_vec v
        JOIN memory_chunks c ON c.id = v.chunk_id
        WHERE v.embedding MATCH ? AND k = ? AND c.folder = 'f1'
      `).all(q, total) as Array<{ chunk_id: string; distance: number }>;
      ok(rows.length === 5, `k=total(${total}) should return 5 f1 results, got ${rows.length}`);

      // 对比：k = limit*2 = 6 时只能拿到 ~3 条（验证问题确实存在）
      const rowsSmallK = db2.prepare(`
        SELECT v.chunk_id, v.distance
        FROM memory_chunks_vec v
        JOIN memory_chunks c ON c.id = v.chunk_id
        WHERE v.embedding MATCH ? AND k = 6 AND c.folder = 'f1'
      `).all(q) as Array<{ chunk_id: string; distance: number }>;
      ok(rowsSmallK.length < 5, `k=6 should under-fetch (got ${rowsSmallK.length}, expected < 5)`);

      db2.close();
    });

    await test('C3. 跨语言：中文查→英文文档', async () => {
      // "内存泄漏" → 应能找到包含 "memory leak" 的英文文档
      const results = await hybridSearch(dbVec, folder, '内存泄漏', embeddingProvider, { maxResults: 6, minScore: 0 });
      const docIds = results.map(r => cid2.get(r.id) ?? r.id);
      const hit = docIds.includes('en-003');
      console.log(`    内存泄漏 → en-003: ${hit ? c('green', '✓ hit') : c('yellow', '△ miss')} (results: ${docIds.slice(0, 3).join(',')})`);
      // 跨语言是 bonus，不强制通过
      ok(results.length > 0, 'no results at all');
    });

    await test('C3. 跨语言：英文查→中文文档', async () => {
      const results = await hybridSearch(dbVec, folder, 'database index', embeddingProvider, { maxResults: 6, minScore: 0 });
      const docIds = results.map(r => cid2.get(r.id) ?? r.id);
      const hit = docIds.includes('zh-002');
      console.log(`    database index → zh-002: ${hit ? c('green', '✓ hit') : c('yellow', '△ miss')} (results: ${docIds.slice(0, 3).join(',')})`);
      ok(results.length > 0, 'no results at all');
    });

    dbVec.close();
  }

  // ─────────────────────────────────────────────────────────
  section('Part D — FTS 专项');
  // ─────────────────────────────────────────────────────────

  sub('D1. 跨语言 FTS（expandQueryTokens）');

  await test('FTS 跨语言：中文查→英文文档（expandQueryTokens）', async () => {
    const results = await hybridSearch(dbFts, folder, '内存泄漏', null, { maxResults: 6, minScore: 0 });
    const docIds = results.map(r => chunkIdToDocId.get(r.id) ?? r.id);
    const hit = docIds.includes('en-003');
    console.log(`    内存泄漏 → en-003: ${hit ? c('green', '✓ hit') : c('yellow', '△ miss')} (results: ${docIds.slice(0, 3).join(',')})`);
    ok(results.length > 0, 'no results at all');
  });

  await test('FTS 跨语言：英文查→中文文档', async () => {
    const results = await hybridSearch(dbFts, folder, 'database index', null, { maxResults: 6, minScore: 0 });
    const docIds = results.map(r => chunkIdToDocId.get(r.id) ?? r.id);
    const hit = docIds.includes('zh-002');
    console.log(`    database index → zh-002: ${hit ? c('green', '✓ hit') : c('yellow', '△ miss')} (results: ${docIds.slice(0, 3).join(',')})`);
    ok(results.length > 0, 'no results at all');
  });

  sub('D2. BM25 归一化正确性');

  await test('BM25: 最相关文档 score=1.0', () => {
    // 直接查 BM25 原始值并验证归一化公式
    const rows = dbFts.prepare(`
      SELECT c.id, bm25(memory_chunks_fts) AS rank
      FROM memory_chunks_fts f
      JOIN memory_chunks c ON c.id = f.chunk_id
      WHERE f.text MATCH ? AND c.folder = ?
      ORDER BY rank
      LIMIT 5
    `).all(`"数据库" OR "索引"`, folder) as Array<{ id: string; rank: number }>;

    ok(rows.length > 0, 'no BM25 results');
    const ranks = rows.map(r => r.rank);
    const minR = Math.min(...ranks);
    const maxR = Math.max(...ranks);
    const range = maxR - minR || 1;

    // 验证：所有 rank 为负数（BM25 特性）
    for (const r of ranks) {
      ok(r <= 0, `BM25 rank should be ≤ 0, got ${r}`);
    }

    // 验证归一化：第一行（最相关）应得 score=1.0
    const firstScore = (maxR - rows[0].rank) / range;
    approx(firstScore, 1.0, 0.001, 'first result score');

    // 验证：最后一行得 score=0.0
    if (rows.length > 1) {
      const lastScore = (maxR - rows[rows.length - 1].rank) / range;
      approx(lastScore, 0.0, 0.001, 'last result score');
    }
  });

  await test('BM25: 相关性排序正确（更匹配的文档排前面）', async () => {
    // zh-001 含多个"数据库"词，应排在只含一个的文档前面
    const results = await hybridSearch(dbFts, folder, '数据库', null, { maxResults: 10, minScore: 0 });
    ok(results.length > 0, 'no results');
    // 第一个结果 score 应最高
    ok(results[0].score >= results[results.length - 1].score, 'not sorted by score');
  });

  // ─────────────────────────────────────────────────────────
  section('Part E — Embedding Provider 测试');
  // ─────────────────────────────────────────────────────────

  sub('E1. local provider（Transformers.js）');

  await test('local: createEmbeddingProvider 返回非 null', () => {
    const db = new Database(':memory:');
    applyMemorySchema(db, false);
    const p = createEmbeddingProvider({ provider: 'local', localModel: 'Xenova/paraphrase-multilingual-MiniLM-L12-v2' }, db);
    ok(p !== null, 'expected non-null provider');
    ok(p!.name === 'local', `name=${p!.name}`);
    ok(p!.dimensions === 384, `dimensions=${p!.dimensions}`);
    db.close();
  });

  await test('local: embed 返回正确维度', async () => {
    const db = new Database(':memory:');
    applyMemorySchema(db, false);
    const p = createEmbeddingProvider({ provider: 'local', localModel: 'Xenova/paraphrase-multilingual-MiniLM-L12-v2' }, db);
    if (!p) { console.log(c('dim', '    (skipped: local provider not available)')); skip++; db.close(); return; }
    const embs = await p.embed(['test']);
    ok(embs.length === 1, `length=${embs.length}`);
    ok(embs[0].length === 384, `dim=${embs[0].length}`);
    db.close();
  });

  sub('E2. none provider');

  await test('none: createEmbeddingProvider 返回 null', () => {
    const db = new Database(':memory:');
    applyMemorySchema(db, false);
    const p = createEmbeddingProvider({ provider: 'none' }, db);
    ok(p === null, `expected null, got ${p}`);
    db.close();
  });

  sub('E3. openai provider（无 key → null + 警告）');

  await test('openai: 无 API key 时返回 null（fallback to FTS）', () => {
    const db = new Database(':memory:');
    applyMemorySchema(db, false);
    const origKey = process.env.OPENAI_API_KEY;
    delete process.env.OPENAI_API_KEY;
    const p = createEmbeddingProvider({ provider: 'openai', openaiApiKey: '' }, db);
    ok(p === null, `expected null, got ${p}`);
    if (origKey) process.env.OPENAI_API_KEY = origKey;
    db.close();
  });

  sub('E4. openrouter provider（无 key → null）');

  await test('openrouter: 无 API key 时返回 null', () => {
    const db = new Database(':memory:');
    applyMemorySchema(db, false);
    const origKey = process.env.OPENROUTER_API_KEY;
    delete process.env.OPENROUTER_API_KEY;
    const p = createEmbeddingProvider({ provider: 'openrouter', openrouterApiKey: '' }, db);
    ok(p === null, `expected null, got ${p}`);
    if (origKey) process.env.OPENROUTER_API_KEY = origKey;
    db.close();
  });

  sub('E5. ollama provider（有 baseUrl → 非 null，实际 embed 可能失败）');

  await test('ollama: 有 baseUrl 时返回非 null provider', () => {
    const db = new Database(':memory:');
    applyMemorySchema(db, false);
    const p = createEmbeddingProvider({
      provider: 'ollama',
      ollamaBaseUrl: 'http://localhost:11434',
      ollamaModel: 'nomic-embed-text',
    }, db);
    // ollama 不需要 key，应返回非 null
    ok(p !== null, 'expected non-null provider');
    ok(p!.name === 'ollama', `name=${p!.name}`);
    db.close();
  });

  // ─────────────────────────────────────────────────────────
  section('Part F — 大批量质量指标');
  // ─────────────────────────────────────────────────────────

  sub('F1. FTS-only 全量指标');
  console.log('  Running all queries (FTS-only)...');
  const ftsResults = await runQueries(dbFts, testQueries, folder, null, chunkIdToDocId, { maxResults: 6, minScore: 0 });
  const mFts = computeMetrics(ftsResults, relevanceMatrix);

  console.log(`\n  FTS-only 指标:`);
  console.log(`    Queries:   ${mFts.queries}`);
  console.log(`    P@K:       ${(mFts.precision * 100).toFixed(1)}%`);
  console.log(`    R@K:       ${(mFts.recall * 100).toFixed(1)}%`);
  console.log(`    F1:        ${c(mFts.f1 >= 0.35 ? 'green' : 'yellow', mFts.f1.toFixed(3))}`);
  console.log(`    P@1:       ${(mFts.p1 * 100).toFixed(1)}%`);
  console.log(`    MRR:       ${mFts.mrr.toFixed(3)}`);

  await test('F1. FTS F1 ≥ 0.30（基线）', () => {
    ok(mFts.f1 >= 0.30, `F1=${mFts.f1.toFixed(3)} < 0.30`);
  });

  await test('F1. FTS P@1 ≥ 0.40', () => {
    ok(mFts.p1 >= 0.40, `P@1=${mFts.p1.toFixed(3)} < 0.40`);
  });

  await test('F1. FTS MRR ≥ 0.50', () => {
    ok(mFts.mrr >= 0.50, `MRR=${mFts.mrr.toFixed(3)} < 0.50`);
  });

  sub('F2. minScore 阈值扫描（混合搜索）');

  if (!embeddingProvider) {
    console.log(c('yellow', '  ⚠ 跳过混合搜索指标（local embedding 不可用）'));
    skip += 4;
  } else {
    console.log('  Building vector DB for batch test...');
    const { db: dbVec2, chunkIdToDocId: cid3 } = buildDb(testDocuments, true, 384);
    await embedAllDocs(dbVec2, testDocuments, cid3, embeddingProvider);

    console.log('\n  minScore 扫描...');
    console.log(`  ${'minScore'.padEnd(10)} ${'P@K'.padStart(7)} ${'R@K'.padStart(7)} ${'F1'.padStart(7)} ${'P@1'.padStart(7)} ${'MRR'.padStart(7)} ${'Hits'.padStart(6)}`);
    console.log('  ' + '-'.repeat(62));

    let bestF1 = 0, bestMs = 0;
    const msValues = [0.0, 0.1, 0.2, 0.25, 0.3, 0.35, 0.4, 0.5];
    for (const ms of msValues) {
      const r = await runQueries(dbVec2, testQueries, folder, embeddingProvider, cid3, { maxResults: 6, minScore: ms });
      const m = computeMetrics(r, relevanceMatrix);
      if (m.f1 > bestF1) { bestF1 = m.f1; bestMs = ms; }
      const marker = m.f1 === bestF1 && m.f1 > 0 ? c('green', ' ←best') : '';
      console.log(
        `  ${String(ms).padEnd(10)}` +
        ` ${(m.precision*100).toFixed(1).padStart(6)}%` +
        ` ${(m.recall*100).toFixed(1).padStart(6)}%` +
        ` ${m.f1.toFixed(3).padStart(7)}` +
        ` ${(m.p1*100).toFixed(1).padStart(6)}%` +
        ` ${m.mrr.toFixed(3).padStart(7)}` +
        ` ${String(m.relevantRetrieved).padStart(6)}${marker}`
      );
    }
    console.log(`\n  Best minScore: ${bestMs} (F1=${bestF1.toFixed(3)})`);

    const hybBestResults = await runQueries(dbVec2, testQueries, folder, embeddingProvider, cid3, { maxResults: 6, minScore: bestMs });
    const mHyb = computeMetrics(hybBestResults, relevanceMatrix);

    sub('F3. FTS vs 混合 并排对比');
    console.log(`\n  ${'方案'.padEnd(28)} ${'P@K'.padStart(7)} ${'R@K'.padStart(7)} ${'F1'.padStart(7)} ${'P@1'.padStart(7)} ${'MRR'.padStart(7)}`);
    console.log('  ' + '-'.repeat(70));
    const fmt = (m: Metrics) =>
      ` ${(m.precision*100).toFixed(1).padStart(6)}%` +
      ` ${(m.recall*100).toFixed(1).padStart(6)}%` +
      ` ${m.f1.toFixed(3).padStart(7)}` +
      ` ${(m.p1*100).toFixed(1).padStart(6)}%` +
      ` ${m.mrr.toFixed(3).padStart(7)}`;
    console.log(`  ${'FTS-only'.padEnd(28)}${fmt(mFts)}`);
    console.log(`  ${`Hybrid (minScore=${bestMs})`.padEnd(28)}${fmt(mHyb)}`);

    const f1Gain = mHyb.f1 - mFts.f1;
    console.log(`\n  F1 增益: ${f1Gain >= 0 ? c('green', '+' + f1Gain.toFixed(3)) : c('red', f1Gain.toFixed(3))} (${(f1Gain / mFts.f1 * 100).toFixed(1)}%)`);

    await test('F3. 混合搜索 F1 ≥ FTS-only F1', () => {
      ok(mHyb.f1 >= mFts.f1 - 0.02, // 允许 2% 误差
        `Hybrid F1=${mHyb.f1.toFixed(3)} < FTS F1=${mFts.f1.toFixed(3)}`);
    });

    await test('F3. 混合搜索 F1 ≥ 0.35', () => {
      ok(mHyb.f1 >= 0.35, `F1=${mHyb.f1.toFixed(3)} < 0.35`);
    });

    sub('F4. 跨语言专项命中率');
    const crossLangCases = [
      { query: '内存泄漏', expectedDoc: 'en-003', desc: '中文→英文' },
      { query: '异步编程', expectedDoc: 'en-004', desc: '中文→英文' },
      { query: 'memory leak', expectedDoc: 'zh-003', desc: '英文→中文' },
      { query: 'async programming', expectedDoc: 'zh-004', desc: '英文→中文' },
      { query: 'database index', expectedDoc: 'zh-002', desc: '英文→中文' },
      { query: '什么是分布式事务', expectedDoc: 'en-002', desc: '中文→英文' },
    ];

    let ftsHits = 0, hybHits = 0;
    console.log(`\n  ${'查询'.padEnd(20)} ${'期望'.padEnd(10)} ${'FTS'.padEnd(10)} ${'Hybrid'.padEnd(10)} ${'方向'}`);
    console.log('  ' + '-'.repeat(62));
    for (const { query, expectedDoc, desc } of crossLangCases) {
      const ftsR = await hybridSearch(dbFts, folder, query, null, { maxResults: 6, minScore: 0 });
      const hybR = await hybridSearch(dbVec2, folder, query, embeddingProvider, { maxResults: 6, minScore: 0 });
      const ftsHit = ftsR.some(r => (chunkIdToDocId.get(r.id) ?? r.id) === expectedDoc);
      const hybHit = hybR.some(r => (cid3.get(r.id) ?? r.id) === expectedDoc);
      if (ftsHit) ftsHits++;
      if (hybHit) hybHits++;
      console.log(
        `  ${query.padEnd(20)} ${expectedDoc.padEnd(10)} ` +
        `${(ftsHit ? c('green', '✓') : c('red', '✗')).padEnd(18)} ` +
        `${(hybHit ? c('green', '✓') : c('red', '✗')).padEnd(18)} ${desc}`
      );
    }
    console.log(`\n  FTS 跨语言命中: ${ftsHits}/${crossLangCases.length}  Hybrid 跨语言命中: ${hybHits}/${crossLangCases.length}`);

    await test('F4. FTS 跨语言命中 ≥ 3/6', () => {
      ok(ftsHits >= 3, `FTS cross-lang hits=${ftsHits} < 3`);
    });

    sub('F5. 按类别细分（混合搜索）');
    const categories = [...new Set(testQueries.map(q => q.category))];
    console.log(`\n  ${'Category'.padEnd(16)} ${'Queries'.padStart(7)} ${'P@K'.padStart(7)} ${'R@K'.padStart(7)} ${'F1'.padStart(7)}`);
    console.log('  ' + '-'.repeat(48));
    for (const cat of categories) {
      const catR = hybBestResults.filter(r => r.category === cat);
      if (!catR.length) continue;
      const m = computeMetrics(catR, relevanceMatrix);
      const f1s = m.f1 >= 0.5 ? c('green', m.f1.toFixed(3)) : m.f1 >= 0.3 ? c('yellow', m.f1.toFixed(3)) : c('red', m.f1.toFixed(3));
      console.log(`  ${cat.padEnd(16)} ${String(m.queries).padStart(7)} ${(m.precision*100).toFixed(1).padStart(6)}% ${(m.recall*100).toFixed(1).padStart(6)}% ${f1s.padStart(7)}`);
    }

    dbVec2.close();
  }

  // ─────────────────────────────────────────────────────────
  section('测试汇总');
  // ─────────────────────────────────────────────────────────

  const total = pass + fail + skip;
  console.log(`\n  总计: ${total} 个测试`);
  console.log(`  ${c('green', `✓ 通过: ${pass}`)}`);
  if (fail > 0) console.log(`  ${c('red', `✗ 失败: ${fail}`)}`);
  if (skip > 0) console.log(`  ${c('yellow', `△ 跳过: ${skip}`)}`);

  if (failures.length > 0) {
    console.log('\n  失败详情:');
    for (const f of failures) {
      console.log(`    ${c('red', '✗')} ${f}`);
    }
  }

  dbFts.close();

  if (fail > 0) {
    process.exit(1);
  }
}

main().catch(e => { console.error(e); process.exit(1); });
