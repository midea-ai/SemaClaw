/**
 * 查询改写（Query Rewrite）
 *
 * 将用户的自然语言查询改写为更精准的搜索查询。
 */

import { tokenizeOptimized } from './tokenizer';
import { filterStopwords } from './stopwords';

/**
 * 查询改写规则
 */
export interface RewriteRule {
  name: string;
  pattern: RegExp;
  replacement: string;
}

/**
 * 预定义的改写规则
 */
const REWRITE_RULES: RewriteRule[] = [
  // 规则 1：移除句首疑问词
  {
    name: '移除中文疑问词',
    pattern: /^(为什么|怎么|如何|什么|哪个|哪些)\s*/,
    replacement: '',
  },
  {
    name: '移除英文疑问词',
    pattern: /^(why|how|what|which|where|when|who)\s+/i,
    replacement: '',
  },

  // 规则 2：移除助词
  // 注意：只匹配独立出现的助词（前后为空格或边界），避免误伤复合词（性能、功能、可能性等）
  {
    name: '移除中文助词',
    pattern: /(^|\s)(会|能|可以|应该)(?=\s|$)/g,
    replacement: ' ',
  },
  {
    name: '移除英文助词',
    pattern: /\s+(should|could|can|will|would)\s+/gi,
    replacement: ' ',
  },

  // 规则 3：标准化空格
  {
    name: '标准化空格',
    pattern: /\s+/g,
    replacement: ' ',
  },
];

/**
 * 查询改写（基于规则）
 */
export function rewriteQuery(query: string): string {
  let rewritten = query;

  // 应用所有规则
  for (const rule of REWRITE_RULES) {
    rewritten = rewritten.replace(rule.pattern, rule.replacement);
  }

  return rewritten.trim();
}

/**
 * 查询改写（基于分词 + 停用词过滤）
 */
export function rewriteQueryWithTokenization(query: string): string {
  // 分词（tokenizeOptimized 内部已过滤停用词）
  const tokens = tokenizeOptimized(query);

  // 过滤后为空 → 返回 ''，由 smartRewriteQuery 统一处理（避免回退到含停用词的原始字符串）
  if (tokens.length === 0) {
    return '';
  }

  return tokens.join(' ');
}

/**
 * 智能查询改写（综合方法）
 */
export function smartRewriteQuery(query: string): string {
  // 1. 基于规则改写（移除疑问词、助词）
  let rewritten = rewriteQuery(query);

  // 2. 分词 + 停用词过滤
  rewritten = rewriteQueryWithTokenization(rewritten);

  // C3：改为检查是否为空字符串，而非字符数 < 2。
  // 原来的 `< 2` 会误杀有效的单字中文查询（如 "漏"、"库"）和单字母缩写。
  if (rewritten.trim().length === 0) {
    return '';
  }

  return rewritten;
}

/**
 * 查询扩展（添加同义词）— @deprecated 请使用 expandQueryTokens 代替
 *
 * 示例：
 * "内存泄漏" → "内存泄漏 OR memory leak"
 * "数据库优化" → "数据库优化 OR database optimization"
 */
export function expandQuery(query: string): string {
  // 简单的中英文映射表
  const synonyms: Record<string, string> = {
    // 内存相关
    '内存': 'memory',
    '内存泄漏': 'memory leak',
    '内存管理': 'memory management',

    // 数据库相关
    '数据库': 'database',
    '索引': 'index',
    '优化': 'optimization',
    '查询': 'query',

    // 异步相关
    '异步': 'async',
    '编程': 'programming',
    '同步': 'sync',

    // 性能相关
    '性能': 'performance',
    '调优': 'tuning',
    '加速': 'speed up',

    // 错误相关
    '错误': 'error',
    '异常': 'exception',
    '调试': 'debug',
  };

  const tokens = tokenizeOptimized(query);
  const expandedTokens = [...tokens];

  // 为每个中文词添加英文同义词
  for (const token of tokens) {
    if (synonyms[token]) {
      expandedTokens.push(synonyms[token]);
    }
  }

  return expandedTokens.join(' ');
}

/**
 * Token 级别的同义词扩展（问题7修复：供 ftsSearchOptimized 使用）
 *
 * 输入已分词的 token 列表，返回扩展后的 token 列表（含原词 + 同义词）。
 * 双向映射：中→英 和 英→中 都支持，增强跨语言 FTS 匹配。
 */
export function expandQueryTokens(tokens: string[]): string[] {
  // 中→英 映射
  const zhToEn: Record<string, string[]> = {
    '内存': ['memory'],
    '内存泄漏': ['memory', 'leak'],
    '泄漏': ['leak'],
    '数据库': ['database'],
    '索引': ['index'],
    '优化': ['optimization', 'optimize'],
    '查询': ['query'],
    '异步': ['async', 'asynchronous'],
    '编程': ['programming'],
    '同步': ['sync', 'synchronous'],
    '性能': ['performance'],
    '调试': ['debug', 'debugging'],
    '错误': ['error'],
    '异常': ['exception'],
    '部署': ['deploy', 'deployment'],
    '容器': ['container'],
    '缓存': ['cache', 'caching'],
    '并发': ['concurrent', 'concurrency'],
    '线程': ['thread'],
    '进程': ['process'],
    '函数': ['function'],
    '组件': ['component'],
    '接口': ['interface', 'api'],
    '排序': ['sort', 'sorting'],
    '算法': ['algorithm'],
    '架构': ['architecture'],
    '微服务': ['microservice'],
    '网络': ['network'],
    '安全': ['security'],
    '认证': ['authentication', 'auth'],
    '授权': ['authorization'],
    '日志': ['log', 'logging'],
    '监控': ['monitor', 'monitoring'],
    '分布式': ['distributed'],
    '事务': ['transaction'],
    '隔离': ['isolation'],
  };

  // 英→中 映射（反向）
  const enToZh: Record<string, string[]> = {
    'memory': ['内存'],
    'leak': ['泄漏'],
    'database': ['数据库'],
    'index': ['索引'],
    'optimization': ['优化'],
    'optimize': ['优化'],
    'query': ['查询'],
    'async': ['异步'],
    'asynchronous': ['异步'],
    'programming': ['编程'],
    'performance': ['性能'],
    'debug': ['调试'],
    'debugging': ['调试'],
    'error': ['错误'],
    'exception': ['异常'],
    'deploy': ['部署'],
    'deployment': ['部署'],
    'container': ['容器'],
    'cache': ['缓存'],
    'caching': ['缓存'],
    'concurrent': ['并发'],
    'concurrency': ['并发'],
    'thread': ['线程'],
    'function': ['函数'],
    'component': ['组件'],
    'interface': ['接口'],
    'api': ['接口'],
    'sort': ['排序'],
    'sorting': ['排序'],
    'algorithm': ['算法'],
    'architecture': ['架构'],
    'microservice': ['微服务'],
    'network': ['网络'],
    'security': ['安全'],
    'authentication': ['认证'],
    'auth': ['认证'],
    'authorization': ['授权'],
    'log': ['日志'],
    'logging': ['日志'],
    'monitor': ['监控'],
    'monitoring': ['监控'],
    'distributed': ['分布式'],
    'transaction': ['事务'],
    'isolation': ['隔离'],
  };

  const result = [...tokens];
  const added = new Set(tokens);  // 避免重复添加

  for (const token of tokens) {
    // 中→英
    const enSynonyms = zhToEn[token];
    if (enSynonyms) {
      for (const syn of enSynonyms) {
        if (!added.has(syn)) { result.push(syn); added.add(syn); }
      }
    }
    // 英→中
    const zhSynonyms = enToZh[token.toLowerCase()];
    if (zhSynonyms) {
      for (const syn of zhSynonyms) {
        if (!added.has(syn)) { result.push(syn); added.add(syn); }
      }
    }
  }

  return result;
}
