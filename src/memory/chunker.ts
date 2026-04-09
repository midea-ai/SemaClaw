/**
 * Chunker — 文本分块器
 *
 * 按行分块，保留行号信息，支持重叠。
 * Token 计数使用简易估算（不引入 tiktoken）。
 */

export interface Chunk {
  text: string;
  startLine: number;  // 1-based
  endLine: number;    // 1-based, inclusive
  hash: string;       // SHA256 of text
}

export interface ChunkerOptions {
  chunkSize?: number;    // 每块最大 token 数，默认 400
  chunkOverlap?: number; // 块间重叠 token 数，默认 80
}

const DEFAULT_CHUNK_SIZE = 400;
const DEFAULT_CHUNK_OVERLAP = 80;

/**
 * 简易 token 估算：
 * - ASCII 字符：按空格分词，约 1 token / word
 * - 中文/日文/韩文字符：约 1 token / 1.5 chars
 * - 其他：按 4 chars / token
 */
export function estimateTokens(text: string): number {
  let tokens = 0;
  // 匹配 CJK 字符
  const cjkChars = text.match(/[\u4e00-\u9fff\u3040-\u309f\u30a0-\u30ff\uac00-\ud7af]/g);
  if (cjkChars) {
    tokens += Math.ceil(cjkChars.length / 1.2);
  }
  // 非 CJK 部分按空格分词
  const nonCjk = text.replace(/[\u4e00-\u9fff\u3040-\u309f\u30a0-\u30ff\uac00-\ud7af]/g, ' ');
  const words = nonCjk.split(/\s+/).filter(w => w.length > 0);
  tokens += words.length;
  return tokens === 0 ? 0 : Math.max(tokens, 1);
}

/**
 * 将文本按行分块。
 *
 * 逐行累加 token 数，达到 chunkSize 时切分。
 * 切分后回退 chunkOverlap 个 token 的行作为下一块起始。
 */
export function chunkText(
  text: string,
  options: ChunkerOptions = {},
): Omit<Chunk, 'hash'>[] {
  const chunkSize = options.chunkSize ?? DEFAULT_CHUNK_SIZE;
  const chunkOverlap = options.chunkOverlap ?? DEFAULT_CHUNK_OVERLAP;

  if (text.trim().length === 0) return [];
  const lines = text.split('\n');
  if (lines.length === 0) return [];

  const chunks: Omit<Chunk, 'hash'>[] = [];
  let startIdx = 0; // 0-based line index

  while (startIdx < lines.length) {
    let tokenCount = 0;
    let endIdx = startIdx;

    // 向前扩展直到达到 chunkSize 或文件结束
    while (endIdx < lines.length) {
      const lineTokens = estimateTokens(lines[endIdx]);
      if (tokenCount + lineTokens > chunkSize && endIdx > startIdx) {
        break;
      }
      tokenCount += lineTokens;
      endIdx++;
    }

    const chunkLines = lines.slice(startIdx, endIdx);
    chunks.push({
      text: chunkLines.join('\n'),
      startLine: startIdx + 1,  // 1-based
      endLine: endIdx,          // 1-based, inclusive
    });

    if (endIdx >= lines.length) break;

    // 计算下一块起始：回退 overlap
    let overlapTokens = 0;
    let nextStart = endIdx;
    while (nextStart > startIdx && overlapTokens < chunkOverlap) {
      nextStart--;
      overlapTokens += estimateTokens(lines[nextStart]);
    }
    // 保证至少前进一行，避免单行超过 chunkSize 时无限循环
    startIdx = Math.max(nextStart, startIdx + 1);
  }

  return chunks;
}
