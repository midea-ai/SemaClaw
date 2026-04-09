/**
 * WikiManager — 个人知识库核心模块
 *
 * 负责：
 *  - wiki 目录初始化（git init + 初始结构）
 *  - 文件读写（含 YAML frontmatter 自动维护）
 *  - git 自动 commit
 *  - 目录树扫描
 *  - 标题搜索（Node.js 遍历，零依赖）
 *  - 统计数据
 */

import * as fs from 'fs';
import * as path from 'path';
import { exec, execFile } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);
const execFileAsync = promisify(execFile);

// ── 类型定义 ─────────────────────────────────────────────────────

export interface Frontmatter {
  created: string;
  updated: string;
  tags: string[];
  source: string;
}

export interface DirNode {
  name: string;
  path: string;
  type: 'dir' | 'file';
  children?: DirNode[];
  frontmatter?: Frontmatter;
}

export interface WikiDoc {
  path: string;
  content: string;
  frontmatter: Frontmatter;
  gitLog: GitCommit[];
}

export interface SearchResult {
  path: string;
  title: string;
  tags: string[];
  updated: string;
}

export interface WikiStats {
  totalFiles: number;
  totalDirs: number;
  byCategory: { dir: string; count: number; lastUpdated: string }[];
  byTag: { tag: string; count: number }[];
  recentFiles: { path: string; title: string; updated: string }[];
}

export interface GitCommit {
  hash: string;
  date: string;
  message: string;
}

export interface TagEntry {
  name: string;
  count: number;
}

// ── 常量 ─────────────────────────────────────────────────────────

const EXCLUDED = new Set(['.git', 'node_modules', '.DS_Store']);

// ── WikiManager ──────────────────────────────────────────────────

export class WikiManager {
  constructor(private readonly wikiDir: string) {}

  /** 首次使用时初始化 git repo + 基础目录结构 */
  async ensureInit(): Promise<void> {
    const gitDir = path.join(this.wikiDir, '.git');
    if (fs.existsSync(gitDir)) return;

    fs.mkdirSync(path.join(this.wikiDir, 'inbox'), { recursive: true });

    await this.git('init');
    await this.git('config user.name "semaclaw"');
    await this.git('config user.email "semaclaw@local"');

    fs.writeFileSync(path.join(this.wikiDir, '.gitignore'), '.DS_Store\n*.swp\n', 'utf-8');

    const readme = [
      '# Wiki',
      '',
      '个人知识库，由 SemaClaw 维护。',
      '',
      '## 目录说明',
      '',
      '- `inbox/` — Agent 暂存区，分类不明时先放这里',
      '',
      '## 远程备份（可选）',
      '',
      '```bash',
      'cd ~/semaclaw/wiki',
      'git remote add origin git@github.com:user/my-wiki.git',
      'git push -u origin main',
      '```',
    ].join('\n');
    fs.writeFileSync(path.join(this.wikiDir, 'README.md'), readme, 'utf-8');

    await this.git('add -A');
    await this.git('commit -m "wiki: initial commit"');

    console.log(`[WikiManager] Initialized wiki at ${this.wikiDir}`);
  }

  /** 获取目录树（目录优先，文件包含 frontmatter） */
  async getTree(): Promise<DirNode[]> {
    return this.scanDir(this.wikiDir, '');
  }

  /** 读取文档内容 + frontmatter + git 历史 */
  async readFile(relPath: string): Promise<WikiDoc> {
    const absPath = this.safePath(relPath);
    const content = fs.readFileSync(absPath, 'utf-8');
    const { fm } = this.parseFrontmatter(content);
    const gitLog = await this.getHistory(relPath, 10);
    return { path: relPath, content, frontmatter: fm, gitLog };
  }

  /**
   * 写入文档（新建或更新）
   * - 自动注入/更新 frontmatter（created/updated/tags/source）
   * - 自动 git commit
   */
  async writeFile(
    relPath: string,
    content: string,
    opts?: { source?: string; tags?: string[]; commitMsg?: string },
  ): Promise<void> {
    const absPath = this.safePath(relPath);
    const isNew = !fs.existsSync(absPath);
    const now = new Date().toISOString();

    const { fm: existingFm } = this.parseFrontmatter(content);
    const fm: Frontmatter = {
      created: isNew ? now : (existingFm.created || now),
      updated: now,
      tags: opts?.tags ?? existingFm.tags ?? [],
      source: opts?.source ?? existingFm.source ?? 'manual',
    };

    const finalContent = this.injectFrontmatter(content, fm);
    fs.mkdirSync(path.dirname(absPath), { recursive: true });
    fs.writeFileSync(absPath, finalContent, 'utf-8');

    const action = isNew ? 'add' : 'edit';
    const commitMsg = opts?.commitMsg ?? `wiki: ${action} ${relPath}`;
    await this.gitCommit(commitMsg, [relPath]);
  }

  /**
   * 标题搜索：遍历所有 .md 文件，按文件名 / H1 标题 / tags 匹配
   * query 为空时返回所有文档（用于 tags 过滤）
   */
  async search(query: string, opts?: { tags?: string[]; limit?: number }): Promise<SearchResult[]> {
    const limit = opts?.limit ?? 20;
    const queryLower = query.toLowerCase();
    const filterTags = opts?.tags ?? [];
    const results: SearchResult[] = [];

    this.walkMd(this.wikiDir, '', (relPath, content) => {
      const { fm } = this.parseFrontmatter(content);
      const title = this.extractTitle(content, relPath);
      const titleLower = title.toLowerCase();
      const filenameLower = path.basename(relPath, '.md').toLowerCase();
      const tagsLower = (fm.tags ?? []).map(t => t.toLowerCase());

      if (filterTags.length > 0 && !filterTags.some(t => tagsLower.includes(t.toLowerCase()))) {
        return;
      }

      const matches =
        !query ||
        filenameLower.includes(queryLower) ||
        titleLower.includes(queryLower) ||
        tagsLower.some(t => t.includes(queryLower));

      if (matches) {
        results.push({ path: relPath, title, tags: fm.tags ?? [], updated: fm.updated ?? '' });
      }
    });

    results.sort((a, b) => (b.updated > a.updated ? 1 : -1));
    return results.slice(0, limit);
  }

  /** 统计数据：分类文件数 + 标签分布 + 最近修改 */
  async getStats(): Promise<WikiStats> {
    const byCategory = new Map<string, { count: number; lastUpdated: string }>();
    const byTag = new Map<string, number>();
    const allFiles: { path: string; title: string; updated: string }[] = [];

    this.walkMd(this.wikiDir, '', (relPath, content) => {
      const { fm } = this.parseFrontmatter(content);
      const title = this.extractTitle(content, relPath);
      const updated = fm.updated ?? '';

      const topDir = relPath.includes('/') ? relPath.split('/')[0] : '(root)';
      const cat = byCategory.get(topDir) ?? { count: 0, lastUpdated: '' };
      cat.count++;
      if (updated > cat.lastUpdated) cat.lastUpdated = updated;
      byCategory.set(topDir, cat);

      for (const tag of fm.tags ?? []) {
        byTag.set(tag, (byTag.get(tag) ?? 0) + 1);
      }

      allFiles.push({ path: relPath, title, updated });
    });

    allFiles.sort((a, b) => (b.updated > a.updated ? 1 : -1));

    return {
      totalFiles: allFiles.length,
      totalDirs: this.countDirs(this.wikiDir),
      byCategory: [...byCategory.entries()]
        .map(([dir, { count, lastUpdated }]) => ({ dir, count, lastUpdated }))
        .sort((a, b) => b.count - a.count),
      byTag: [...byTag.entries()]
        .map(([tag, count]) => ({ tag, count }))
        .sort((a, b) => b.count - a.count),
      recentFiles: allFiles.slice(0, 10),
    };
  }

  /** 文件 git 历史 */
  async getHistory(relPath: string, limit = 10): Promise<GitCommit[]> {
    const safeRel = this.safeRelPath(relPath);
    try {
      const { stdout } = await this.git(
        `log --pretty=format:"%H|%ai|%s" -n ${limit} -- "${safeRel}"`,
      );
      return stdout
        .trim()
        .split('\n')
        .filter(Boolean)
        .map(line => {
          const idx1 = line.indexOf('|');
          const idx2 = line.indexOf('|', idx1 + 1);
          return {
            hash: line.slice(0, idx1),
            date: line.slice(idx1 + 1, idx2),
            message: line.slice(idx2 + 1),
          };
        });
    } catch {
      return [];
    }
  }

  /** 所有标签及出现次数 */
  async getTags(): Promise<TagEntry[]> {
    const byTag = new Map<string, number>();
    this.walkMd(this.wikiDir, '', (_relPath, content) => {
      const { fm } = this.parseFrontmatter(content);
      for (const tag of fm.tags ?? []) {
        byTag.set(tag, (byTag.get(tag) ?? 0) + 1);
      }
    });
    return [...byTag.entries()]
      .map(([name, count]) => ({ name, count }))
      .sort((a, b) => b.count - a.count);
  }

  /** 创建目录（含 .gitkeep 使 git 可追踪） */
  async mkdir(relPath: string): Promise<void> {
    const absPath = this.safePath(relPath);
    fs.mkdirSync(absPath, { recursive: true });
    const keepFile = path.join(absPath, '.gitkeep');
    if (!fs.existsSync(keepFile)) {
      fs.writeFileSync(keepFile, '', 'utf-8');
      await this.gitCommit(`wiki: mkdir ${relPath}`, [`${relPath}/.gitkeep`]);
    }
  }

  /** 删除空目录（有文件时报错） */
  async deleteEmptyDir(relPath: string): Promise<void> {
    const absPath = this.safePath(relPath);
    const entries = fs.readdirSync(absPath).filter(e => e !== '.gitkeep');
    if (entries.length > 0) throw new Error(`Directory not empty: ${relPath}`);
    fs.rmSync(absPath, { recursive: true, force: true });
    await this.gitCommit(`wiki: rmdir ${relPath}`);
  }

  /** 返回 wiki 目录树的纯文本表示（CLI / Agent 用） */
  async treeText(): Promise<string> {
    const nodes = await this.getTree();
    const lines: string[] = [];
    const render = (nodes: DirNode[], indent: string) => {
      for (const node of nodes) {
        if (node.type === 'dir') {
          lines.push(`${indent}${node.name}/`);
          if (node.children) render(node.children, indent + '  ');
        } else {
          lines.push(`${indent}${node.name}`);
        }
      }
    };
    render(nodes, '');
    return lines.join('\n');
  }

  // ── private helpers ──────────────────────────────────────────────

  private async scanDir(absDir: string, relBase: string): Promise<DirNode[]> {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(absDir, { withFileTypes: true });
    } catch {
      return [];
    }

    const nodes: DirNode[] = [];
    for (const entry of entries) {
      if (EXCLUDED.has(entry.name) || entry.name.startsWith('.')) continue;
      const relPath = relBase ? `${relBase}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        const children = await this.scanDir(path.join(absDir, entry.name), relPath);
        nodes.push({ name: entry.name, path: relPath, type: 'dir', children });
      } else if (entry.isFile() && entry.name.endsWith('.md')) {
        try {
          const content = fs.readFileSync(path.join(absDir, entry.name), 'utf-8');
          const { fm } = this.parseFrontmatter(content);
          nodes.push({ name: entry.name, path: relPath, type: 'file', frontmatter: fm });
        } catch {
          nodes.push({ name: entry.name, path: relPath, type: 'file' });
        }
      }
    }

    nodes.sort((a, b) => {
      if (a.type !== b.type) return a.type === 'dir' ? -1 : 1;
      return a.name.localeCompare(b.name);
    });
    return nodes;
  }

  private walkMd(
    dir: string,
    relBase: string,
    cb: (relPath: string, content: string) => void,
  ): void {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (EXCLUDED.has(entry.name) || entry.name.startsWith('.')) continue;
      const relPath = relBase ? `${relBase}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        this.walkMd(path.join(dir, entry.name), relPath, cb);
      } else if (entry.isFile() && entry.name.endsWith('.md')) {
        try {
          const content = fs.readFileSync(path.join(dir, entry.name), 'utf-8');
          cb(relPath, content);
        } catch { /* skip unreadable files */ }
      }
    }
  }

  private countDirs(dir: string): number {
    let count = 0;
    try {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        if (EXCLUDED.has(entry.name) || entry.name.startsWith('.')) continue;
        if (entry.isDirectory()) {
          count++;
          count += this.countDirs(path.join(dir, entry.name));
        }
      }
    } catch { /* ignore */ }
    return count;
  }

  private async gitCommit(message: string, files?: string[]): Promise<void> {
    try {
      if (files) {
        for (const f of files) {
          await execFileAsync('git', ['add', '--', f], { cwd: this.wikiDir });
        }
      } else {
        await this.git('add -A');
      }
      await execFileAsync('git', ['commit', '-m', message], { cwd: this.wikiDir });
    } catch (e) {
      const msg = String(e);
      if (!msg.includes('nothing to commit') && !msg.includes('nothing added')) {
        console.warn('[WikiManager] git commit warning:', msg.slice(0, 200));
      }
    }
  }

  /** 简单手写 YAML frontmatter 解析（避免引入额外依赖） */
  private parseFrontmatter(content: string): { fm: Frontmatter; body: string } {
    const defaultFm: Frontmatter = { created: '', updated: '', tags: [], source: 'manual' };
    if (!content.startsWith('---')) return { fm: defaultFm, body: content };

    const end = content.indexOf('\n---', 3);
    if (end === -1) return { fm: defaultFm, body: content };

    const yamlBlock = content.slice(4, end);
    const body = content.slice(end + 4).replace(/^\n/, '');
    const fm: Frontmatter = { ...defaultFm };

    for (const line of yamlBlock.split('\n')) {
      const colon = line.indexOf(':');
      if (colon === -1) continue;
      const key = line.slice(0, colon).trim();
      const val = line.slice(colon + 1).trim();

      if (key === 'created' || key === 'updated' || key === 'source') {
        (fm as unknown as Record<string, string>)[key] = val;
      } else if (key === 'tags') {
        const tagStr = val.replace(/^\[/, '').replace(/\]$/, '');
        fm.tags = tagStr.split(',').map(t => t.trim()).filter(Boolean);
      }
    }

    return { fm, body };
  }

  private injectFrontmatter(content: string, fm: Partial<Frontmatter>): string {
    const { body } = this.parseFrontmatter(content);
    const tags = fm.tags?.length ? `[${fm.tags.join(', ')}]` : '[]';
    const header = [
      '---',
      `created: ${fm.created ?? ''}`,
      `updated: ${fm.updated ?? ''}`,
      `tags: ${tags}`,
      `source: ${fm.source ?? 'manual'}`,
      '---',
      '',
    ].join('\n');
    return header + body;
  }

  private extractTitle(content: string, relPath: string): string {
    const { body } = this.parseFrontmatter(content);
    const h1 = body.match(/^#\s+(.+)/m);
    if (h1) return h1[1].trim();
    return path.basename(relPath, '.md');
  }

  private safePath(relPath: string): string {
    const abs = path.resolve(this.wikiDir, relPath);
    if (!abs.startsWith(this.wikiDir + path.sep) && abs !== this.wikiDir) {
      throw new Error(`Path traversal detected: ${relPath}`);
    }
    return abs;
  }

  private safeRelPath(relPath: string): string {
    this.safePath(relPath); // validates
    return relPath.replace(/"/g, '\\"');
  }

  private async git(args: string): Promise<{ stdout: string; stderr: string }> {
    return execAsync(`git ${args}`, { cwd: this.wikiDir });
  }
}
