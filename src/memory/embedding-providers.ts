import type { EmbeddingProvider } from './embedding';

// ===== OpenAI Provider =====

class OpenAIEmbeddingProvider implements EmbeddingProvider {
  readonly name = 'openai';
  readonly model = 'text-embedding-3-small';
  /** OpenAI text-embedding-3-small 默认 1536 维 */
  readonly dimensions = 1536;

  constructor(
    private apiKey: string,
    private baseUrl: string = 'https://api.openai.com/v1',
  ) {}

  async embed(texts: string[]): Promise<Float32Array[]> {
    const MAX_BATCH = 8;
    const allResults: Float32Array[] = [];

    for (let i = 0; i < texts.length; i += MAX_BATCH) {
      const batch = texts.slice(i, i + MAX_BATCH);
      const result = await this.callApi(batch);
      allResults.push(...result);
    }

    return allResults;
  }

  private async callApi(texts: string[], retries = 3): Promise<Float32Array[]> {
    for (let attempt = 0; attempt < retries; attempt++) {
      try {
        const res = await fetch(`${this.baseUrl}/embeddings`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${this.apiKey}`,
          },
          body: JSON.stringify({
            model: this.model,
            input: texts,
          }),
        });

        if (!res.ok) {
          const body = await res.text().catch(() => '');
          throw new Error(`OpenAI API ${res.status}: ${body}`);
        }

        const json = await res.json() as {
          data: Array<{ embedding: number[]; index: number }>;
        };

        // 按 index 排序确保顺序正确
        const sorted = json.data.sort((a, b) => a.index - b.index);
        return sorted.map(d => new Float32Array(d.embedding));
      } catch (e) {
        if (attempt < retries - 1) {
          // 添加随机 jitter 避免惊群效应
          const baseDelay = 1000 * Math.pow(2, attempt);
          const jitter = Math.random() * 1000;
          await new Promise(resolve => setTimeout(resolve, baseDelay + jitter));
          continue;
        }
        throw e;
      }
    }
    throw new Error('unreachable');
  }
}

export function createOpenAIEmbeddingProvider(params: {
  apiKey: string;
  baseUrl?: string;
}): EmbeddingProvider {
  return new OpenAIEmbeddingProvider(params.apiKey, params.baseUrl);
}

// ===== OpenRouter Provider =====

class OpenRouterEmbeddingProvider implements EmbeddingProvider {
  readonly name = 'openrouter';
  readonly model: string;
  private _dimensions = 0;

  constructor(
    private apiKey: string,
    private baseUrl: string,
    model: string,
  ) {
    this.model = model;
  }

  get dimensions(): number {
    return this._dimensions || 1536; // 首次 embed 前的占位值，实际维度在 embed() 后更新
  }

  async embed(texts: string[]): Promise<Float32Array[]> {
    const out: Float32Array[] = [];
    for (const t of texts) {
      // 串行调用（OpenRouter 可能有并发限制）
      // eslint-disable-next-line no-await-in-loop
      const vec = await this.embedSingle(t);
      out.push(vec);
    }
    if (out.length > 0 && out[0].length > 0) {
      this._dimensions = out[0].length;
    }
    return out;
  }

  private async embedSingle(text: string, retries = 3): Promise<Float32Array> {
    for (let attempt = 0; attempt < retries; attempt++) {
      try {
        const url = `${this.baseUrl.replace(/\/$/, '')}/embeddings`;
        const res = await fetch(url, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${this.apiKey}`,
          },
          body: JSON.stringify({
            model: this.model,
            input: text,
          }),
        });

        if (!res.ok) {
          const body = await res.text().catch(() => '');
          throw new Error(`OpenRouter API ${res.status}: ${body}`);
        }

        const json = await res.json() as {
          data: Array<{ embedding: number[]; index: number }>;
        };

        const embedding = json.data[0]?.embedding ?? [];
        return new Float32Array(embedding);
      } catch (e) {
        if (attempt < retries - 1) {
          // 添加随机 jitter 避免惊群效应
          const baseDelay = 1000 * Math.pow(2, attempt);
          const jitter = Math.random() * 1000;
          await new Promise(resolve => setTimeout(resolve, baseDelay + jitter));
          continue;
        }
        throw e;
      }
    }
    throw new Error('unreachable');
  }
}

export function createOpenRouterEmbeddingProvider(params: {
  apiKey: string;
  baseUrl: string;
  model: string;
}): EmbeddingProvider {
  return new OpenRouterEmbeddingProvider(params.apiKey, params.baseUrl, params.model);
}

// ===== Ollama Provider =====

class OllamaEmbeddingProvider implements EmbeddingProvider {
  readonly name = 'ollama';
  readonly model: string;
  private _dimensions = 0;

  constructor(
    private baseUrl: string,
    model: string,
  ) {
    this.model = normalizeOllamaModel(model);
  }

  get dimensions(): number {
    return this._dimensions || 1536;
  }

  async embed(texts: string[]): Promise<Float32Array[]> {
    const out: Float32Array[] = [];
    for (const t of texts) {
      // 串行调用；后续如需可并行化
      // eslint-disable-next-line no-await-in-loop
      const vec = await this.embedSingle(t);
      out.push(vec);
    }
    if (out.length > 0 && out[0].length > 0) {
      this._dimensions = out[0].length;
    }
    return out;
  }

  private async embedSingle(text: string): Promise<Float32Array> {
    const url = `${this.baseUrl.replace(/\/$/, '')}/api/embeddings`;
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: this.model, prompt: text }),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`ollama embeddings failed: ${res.status} ${body}`);
    }
    const data = await res.json() as { embedding?: number[] };
    const arr = data.embedding ?? [];
    return new Float32Array(arr);
  }
}

export function createOllamaEmbeddingProvider(params: {
  baseUrl: string;
  model: string;
}): EmbeddingProvider {
  return new OllamaEmbeddingProvider(params.baseUrl, params.model);
}

// ===== Local Provider (Transformers.js) =====

// 动态导入，避免未安装时报错
let transformers: any = null;

async function loadTransformers(modelPath?: string) {
  if (!transformers) {
    try {
      // 使用类型断言避免编译错误
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      transformers = await import('@xenova/transformers' as any);
      // 设置缓存目录
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const path = require('path');
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const os = require('os');
      transformers.env.localModelPath = modelPath ||
        process.env.LOCAL_MODEL_PATH ||
        path.join(os.homedir(), '.cache', 'transformers');
    } catch (e) {
      throw new Error('Failed to load @xenova/transformers. Run: npm install @xenova/transformers');
    }
  }
  return transformers;
}

class LocalEmbeddingProvider implements EmbeddingProvider {
  readonly name = 'local';
  readonly model: string;
  // paraphrase-multilingual-MiniLM-L12-v2 和 all-MiniLM-L6-v2 都是 384 维
  // 作为静态默认值供 db.ts 建表使用；embed 后会从实际输出更新
  private _dimensions = 384;

  private extractor: any = null;
  private modelPath?: string;

  constructor(model?: string, modelPath?: string) {
    this.model = model || 'Xenova/paraphrase-multilingual-MiniLM-L12-v2';
    this.modelPath = modelPath;
  }

  get dimensions(): number {
    return this._dimensions;
  }

  async embed(texts: string[]): Promise<Float32Array[]> {
    // 懒加载模型
    if (!this.extractor) {
      const tf = await loadTransformers(this.modelPath);
      this.extractor = await tf.pipeline('feature-extraction', this.model);
    }

    // 逐个处理（批量处理内存占用大）
    const results: Float32Array[] = [];
    for (const text of texts) {
      const output = await this.extractor(text, {
        pooling: 'mean',
        normalize: true
      });
      results.push(new Float32Array(output.data));
    }

    // 从实际输出更新维度（覆盖默认值，支持非标准维度的自定义模型）
    if (results.length > 0) {
      this._dimensions = results[0].length;
    }

    return results;
  }
}

export function createLocalEmbeddingProvider(params: {
  model?: string;
  modelPath?: string;
}): EmbeddingProvider {
  return new LocalEmbeddingProvider(params.model, params.modelPath);
}

// ===== 工具函数 =====

function normalizeOllamaModel(model: string): string {
  const t = model.trim();
  if (!t) return 'nomic-embed-text';
  if (t.startsWith('ollama/')) return t.slice(7);
  if (/^text-embedding-3|^text-embedding-ada|embedding.*openai/i.test(t)) return 'nomic-embed-text';
  return t;
}
