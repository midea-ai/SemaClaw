/**
 * 停用词表
 *
 * 停用词是指在信息检索中无意义或意义很小的词，应该在分词后过滤掉。
 */

/**
 * 中文停用词表
 *
 * 包括：
 * - 疑问词：为什么、怎么、如何、什么等
 * - 助词：的、了、在、是等
 * - 连词：和、或、但是等
 * - 代词：我、你、他等
 */
export const CHINESE_STOPWORDS = new Set([
  // 疑问词
  '为什么', '怎么', '如何', '什么', '哪个', '哪些', '哪里', '哪儿',
  '怎样', '怎么样', '为何',

  // 助词
  '的', '了', '在', '是', '我', '有', '和', '就', '不', '人', '都', '一',
  '会', '能', '可以', '应该', '着', '过', '吗', '呢', '吧', '啊', '呀',

  // 连词
  '和', '或', '但是', '然后', '因为', '所以', '如果', '虽然', '但',
  '而且', '并且', '或者', '以及',

  // 代词
  '我', '你', '他', '她', '它', '我们', '你们', '他们', '她们', '它们',
  '这', '那', '这个', '那个', '这些', '那些', '这里', '那里',

  // 介词
  '在', '从', '到', '对', '向', '往', '于', '给', '为', '被', '把',

  // 时间词（通用）
  '时候', '时间', '现在', '以前', '以后', '之前', '之后',

  // 程度词
  '很', '非常', '特别', '十分', '极', '更', '最', '比较',

  // 其他
  '等', '等等', '之类', '左右', '上下', '前后',
]);

/**
 * 英文停用词表
 *
 * 包括：
 * - 冠词：the, a, an
 * - 介词：in, on, at, to, from
 * - 连词：and, or, but
 * - 代词：I, you, he, she, it
 * - 疑问词：why, how, what, when, where, who
 */
export const ENGLISH_STOPWORDS = new Set([
  // 冠词
  'the', 'a', 'an',

  // 介词
  'in', 'on', 'at', 'to', 'from', 'by', 'with', 'about', 'as', 'into',
  'through', 'during', 'before', 'after', 'above', 'below', 'between',
  'under', 'over',

  // 连词
  'and', 'or', 'but', 'if', 'then', 'else', 'when', 'while', 'because',
  'so', 'though', 'although', 'unless', 'until', 'since',

  // 代词
  'i', 'you', 'he', 'she', 'it', 'we', 'they', 'me', 'him', 'her', 'us',
  'them', 'my', 'your', 'his', 'its', 'our', 'their', 'mine', 'yours',
  'this', 'that', 'these', 'those',

  // be 动词
  'is', 'am', 'are', 'was', 'were', 'be', 'been', 'being',

  // 助动词
  'do', 'does', 'did', 'have', 'has', 'had', 'will', 'would', 'shall',
  'should', 'may', 'might', 'must', 'can', 'could',

  // 疑问词
  'why', 'how', 'what', 'when', 'where', 'who', 'which', 'whom', 'whose',

  // 其他常见词
  'not', 'no', 'yes', 'all', 'any', 'some', 'more', 'most', 'other',
  'such', 'very', 'just', 'only', 'own', 'same', 'than', 'too', 'also',
  'there', 'here', 'now', 'then', 'up', 'down', 'out',
]);

/**
 * 检查是否为停用词
 */
export function isStopword(word: string): boolean {
  const lowerWord = word.toLowerCase();
  return CHINESE_STOPWORDS.has(word) || ENGLISH_STOPWORDS.has(lowerWord);
}

/**
 * 过滤停用词
 */
export function filterStopwords(tokens: string[]): string[] {
  return tokens.filter(token => !isStopword(token));
}
