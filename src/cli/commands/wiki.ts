/**
 * semaclaw wiki <subcommand>
 *
 * CLI 命令，供用户和 Agent 操作个人知识库。
 *
 * 用法：
 *   semaclaw wiki tree                                — 列出目录结构
 *   semaclaw wiki save --path <rel> [--tags <t1,t2>] — 从 stdin 保存文档
 *   semaclaw wiki search <query>                      — 标题/tags 搜索
 *   semaclaw wiki mkdir <path>                        — 新建目录
 *   semaclaw wiki stats                               — 统计概览
 */

import * as path from 'path';
import * as os from 'os';
import { WikiManager, type WikiStats } from '../../wiki/WikiManager.js';

function getWikiDir(): string {
  return process.env.WIKI_DIR ?? path.join(os.homedir(), 'semaclaw', 'wiki');
}

function getWiki(): WikiManager {
  return new WikiManager(getWikiDir());
}

// ── semaclaw wiki tree ────────────────────────────────────────────

export async function cmdWikiTree(): Promise<void> {
  const wm = getWiki();
  await wm.ensureInit();
  const text = await wm.treeText();
  console.log(text || '(empty wiki)');
}

// ── semaclaw wiki save ────────────────────────────────────────────

export async function cmdWikiSave(opts: {
  path: string;
  tags?: string;
  source?: string;
  msg?: string;
}): Promise<void> {
  if (!opts.path) {
    console.error('Error: --path is required');
    process.exit(1);
  }

  const wm = getWiki();
  await wm.ensureInit();

  // Read content from stdin
  const content = await readStdin();
  if (!content.trim()) {
    console.error('Error: no content received on stdin');
    process.exit(1);
  }

  const tags = opts.tags
    ? opts.tags.split(',').map(t => t.trim()).filter(Boolean)
    : undefined;

  await wm.writeFile(opts.path, content, {
    tags,
    source: opts.source ?? 'agent',
    commitMsg: opts.msg,
  });

  const result = { path: opts.path, action: 'created' };
  console.log(JSON.stringify(result));
}

// ── semaclaw wiki search ──────────────────────────────────────────

export async function cmdWikiSearch(
  query: string,
  opts: { limit?: number; tags?: string },
): Promise<void> {
  const wm = getWiki();
  await wm.ensureInit();

  const tags = opts.tags
    ? opts.tags.split(',').map(t => t.trim()).filter(Boolean)
    : [];
  const limit = opts.limit ?? 10;

  const results = await wm.search(query, { tags, limit });

  if (results.length === 0) {
    console.log('No results found.');
    return;
  }

  const wikiDir = getWikiDir();
  for (const r of results) {
    const tagStr = r.tags.length ? `  [${r.tags.join(', ')}]` : '';
    console.log(`${path.join(wikiDir, r.path)}  —  ${r.title}${tagStr}`);
  }
}

// ── semaclaw wiki mkdir ───────────────────────────────────────────

export async function cmdWikiMkdir(dirPath: string): Promise<void> {
  if (!dirPath) {
    console.error('Error: path argument is required');
    process.exit(1);
  }
  const wm = getWiki();
  await wm.ensureInit();
  await wm.mkdir(dirPath);
  console.log(`Created: ${dirPath}`);
}

// ── semaclaw wiki stats ───────────────────────────────────────────

export async function cmdWikiStats(): Promise<void> {
  const wm = getWiki();
  await wm.ensureInit();
  const stats: WikiStats = await wm.getStats();

  console.log(`Wiki 统计`);
  console.log(`─────────────────────────────────────`);
  console.log(`总计：${stats.totalFiles} 篇 | ${stats.totalDirs} 个目录`);
  console.log('');

  if (stats.byCategory.length > 0) {
    console.log('分类分布：');
    const maxCount = Math.max(...stats.byCategory.map((c: { count: number }) => c.count));
    for (const cat of stats.byCategory) {
      const bar = '█'.repeat(Math.ceil((cat.count / maxCount) * 20));
      console.log(`  ${cat.dir.padEnd(20)} ${bar}  ${cat.count} 篇`);
    }
    console.log('');
  }

  if (stats.byTag.length > 0) {
    const topTags = stats.byTag.slice(0, 10);
    console.log(`热门标签：${topTags.map((t: { tag: string; count: number }) => `[${t.tag}×${t.count}]`).join(' ')}`);
    console.log('');
  }

  if (stats.recentFiles.length > 0) {
    const wikiDir = getWikiDir();
    console.log('最近修改：');
    for (const f of stats.recentFiles.slice(0, 5)) {
      console.log(`  ${path.join(wikiDir, f.path)}  —  ${f.title}`);
    }
  }
}

// ── helpers ──────────────────────────────────────────────────────

function readStdin(): Promise<string> {
  return new Promise((resolve) => {
    let data = '';
    process.stdin.setEncoding('utf-8');
    process.stdin.on('data', chunk => { data += chunk; });
    process.stdin.on('end', () => resolve(data));
    // If stdin is a TTY (interactive), resolve immediately with empty string
    if (process.stdin.isTTY) resolve('');
  });
}
