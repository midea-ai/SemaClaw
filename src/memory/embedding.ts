/**
 * Embedding Provider — 向量嵌入抽象层
 *
 * 支持：
 *   - none：不使用 embedding（纯 FTS 模式）
 *   - openai：OpenAI text-embedding-3-small（1536 维）
 *   - openrouter：OpenRouter（支持多种模型，如 nvidia/llama-nemotron-embed-vl-1b-v2）
 *   - ollama：Ollama 本地模型（默认 nomic-embed-text）
 *   - local：Transformers.js 本地模型（默认 paraphrase-multilingual-MiniLM-L12-v2，384 维，多语言）
 *
 * 内置缓存层：通过 SQLite embedding_cache 表去重。
 */

import { createHash } from 'crypto';
import type Database from 'better-sqlite3';

// ===== 接口 =====

export interface EmbeddingProvider {
  readonly name: string;
  readonly model: string;
  readonly dimensions: number;
  /** 批量生成 embedding，返回与输入等长的 Float32Array 数组 */
  embed(texts: string[]): Promise<Float32Array[]>;
}

export interface EmbeddingConfig {
  provider: 'none' | 'openai' | 'openrouter' | 'ollama' | 'local';
  openaiApiKey?: string;
  openaiBaseUrl?: string;
  openaiModel?: string;
  openrouterApiKey?: string;
  openrouterBaseUrl?: string;
  openrouterModel?: string;
  ollamaBaseUrl?: string;
  ollamaModel?: string;
  localModelPath?: string;
  localModel?: string;
}

// ===== 缓存层 =====

export class CachedEmbeddingProvider implements EmbeddingProvider {
  get name() { return this.inner.name; }
  get model() { return this.inner.model; }
  get dimensions() { return this.inner.dimensions; }

  private getStmt: Database.Statement;
  private putStmt: Database.Statement;

  constructor(
    private inner: EmbeddingProvider,
    private db: Database.Database,
  ) {
    this.getStmt = db.prepare(
      'SELECT embedding FROM embedding_cache WHERE provider = ? AND model = ? AND hash = ?'
    );
    this.putStmt = db.prepare(
      'INSERT OR IGNORE INTO embedding_cache (provider, model, hash, embedding) VALUES (?, ?, ?, ?)'
    );
  }

  async embed(texts: string[]): Promise<Float32Array[]> {
    const results: (Float32Array | null)[] = new Array(texts.length).fill(null);
    const uncached: { idx: number; text: string }[] = [];

    // 查缓存
    for (let i = 0; i < texts.length; i++) {
      const hash = textHash(texts[i]);
      const row = this.getStmt.get(this.name, this.model, hash) as { embedding: Buffer } | undefined;
      if (row) {
        // 用 slice 确保独立、对齐的 ArrayBuffer，避免 byteOffset 非 4 对齐导致 Float32Array 崩溃
        const aligned = row.embedding.buffer.slice(
          row.embedding.byteOffset,
          row.embedding.byteOffset + row.embedding.byteLength,
        );
        results[i] = new Float32Array(aligned);
      } else {
        uncached.push({ idx: i, text: texts[i] });
      }
    }

    // 批量生成未缓存的
    if (uncached.length > 0) {
      const embeddings = await this.inner.embed(uncached.map(u => u.text));
      const insertMany = this.db.transaction(() => {
        for (let j = 0; j < uncached.length; j++) {
          const { idx, text } = uncached[j];
          results[idx] = embeddings[j];
          const hash = textHash(text);
          const buf = Buffer.from(embeddings[j].buffer, embeddings[j].byteOffset, embeddings[j].byteLength);
          this.putStmt.run(this.name, this.model, hash, buf);
        }
      });
      insertMany();
    }

    return results as Float32Array[];
  }
}

// ===== 工厂 =====

/**
 * 根据配置创建 EmbeddingProvider。
 * 返回 null 表示不使用 embedding（纯 FTS 模式）。
 */
export function createEmbeddingProvider(
  cfg: EmbeddingConfig,
  db: Database.Database,
): EmbeddingProvider | null {
  const provider = cfg.provider ?? 'none';

  if (provider === 'none') return null;

  if (provider === 'openai') {
    const apiKey = (cfg.openaiApiKey || process.env.OPENAI_API_KEY || '').trim();
    if (!apiKey) {
      console.warn('[Embedding] Falling back to FTS-only. Reason: openai selected but no API key (set OPENAI_API_KEY or embeddingConfig.openaiApiKey).');
      return null;
    }
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { createOpenAIEmbeddingProvider } = require('./embedding-providers') as typeof import('./embedding-providers');
    const inner = createOpenAIEmbeddingProvider({ apiKey, baseUrl: cfg.openaiBaseUrl });
    return new CachedEmbeddingProvider(inner, db);
  }

  if (provider === 'openrouter') {
    const apiKey = (cfg.openrouterApiKey || process.env.OPENROUTER_API_KEY || '').trim();
    if (!apiKey) {
      console.warn('[Embedding] Falling back to FTS-only. Reason: openrouter selected but no API key (set OPENROUTER_API_KEY or embeddingConfig.openrouterApiKey).');
      return null;
    }
    const baseUrl = cfg.openrouterBaseUrl || process.env.OPENROUTER_BASE_URL || 'https://openrouter.ai/api/v1';
    const model = cfg.openrouterModel || process.env.OPENROUTER_MODEL || 'nvidia/llama-nemotron-embed-vl-1b-v2';
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { createOpenRouterEmbeddingProvider } = require('./embedding-providers') as typeof import('./embedding-providers');
    const inner = createOpenRouterEmbeddingProvider({ apiKey, baseUrl, model });
    return new CachedEmbeddingProvider(inner, db);
  }

  if (provider === 'ollama') {
    const baseUrl =
      (cfg.ollamaBaseUrl && cfg.ollamaBaseUrl.trim()) ||
      (process.env.OLLAMA_BASE_URL && process.env.OLLAMA_BASE_URL.trim()) ||
      'http://localhost:11434';
    const model = cfg.ollamaModel || 'nomic-embed-text';
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { createOllamaEmbeddingProvider } = require('./embedding-providers') as typeof import('./embedding-providers');
    const inner = createOllamaEmbeddingProvider({ baseUrl, model });
    return new CachedEmbeddingProvider(inner, db);
  }

  if (provider === 'local') {
    try {
      const modelPath = cfg.localModelPath || process.env.LOCAL_MODEL_PATH;
      const model = cfg.localModel || process.env.LOCAL_MODEL || 'Xenova/all-MiniLM-L6-v2';
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const { createLocalEmbeddingProvider } = require('./embedding-providers') as typeof import('./embedding-providers');
      const inner = createLocalEmbeddingProvider({ model, modelPath });
      return new CachedEmbeddingProvider(inner, db);
    } catch (e) {
      console.warn('[Embedding] Falling back to FTS-only. Reason: local provider failed:', e instanceof Error ? e.message : String(e));
      return null;
    }
  }

  return null;
}

// ===== 工具函数 =====

function textHash(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}
