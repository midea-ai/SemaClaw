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
import { parse as parseYaml, Document as YamlDocument } from 'yaml';

const execAsync = promisify(exec);
const execFileAsync = promisify(execFile);

// ── 类型定义 ─────────────────────────────────────────────────────

export interface Frontmatter {
  created: string;
  updated: string;
  tags: string[];
  source: string;
  /** OKF (Open Knowledge Format) 对齐字段：概念类型，如 note / paper-note / runbook / reference */
  type?: string;
  title?: string;
  description?: string;
  /** 指向原始资源（URL 或 wiki 内相对路径，如生成的 HTML 产物） */
  resource?: string;
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
  /** 正文中链接到本文档的其他文档（反链） */
  backlinks: BacklinkEntry[];
}

export interface BacklinkEntry {
  path: string;
  title: string;
}

export interface SearchResult {
  path: string;
  title: string;
  tags: string[];
  updated: string;
  type?: string;
  description?: string;
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

/** frontmatter 中由 WikiManager 管理的字段；其余字段原样保留（round-trip） */
const MANAGED_FM_KEYS = new Set(['created', 'updated', 'tags', 'source', 'type', 'title', 'description', 'resource']);

/** 每目录自动维护的纯索引文件：不进 tree/search/stats，不接受直接写入 */
const INDEX_FILE = 'index.md';

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

    this.refreshIndexChain('inbox'); // 生成 inbox/ 与根目录的 index.md

    await this.git('add -A');
    await this.git('commit -m "wiki: initial commit"');

    console.log(`[WikiManager] Initialized wiki at ${this.wikiDir}`);
  }

  /** 获取目录树（目录优先，文件包含 frontmatter） */
  async getTree(): Promise<DirNode[]> {
    return this.scanDir(this.wikiDir, '');
  }

  /** 读取文档内容 + frontmatter + git 历史 + 反链 */
  async readFile(relPath: string): Promise<WikiDoc> {
    const absPath = this.safePath(relPath);
    const content = fs.readFileSync(absPath, 'utf-8');
    const { fm } = this.parseFrontmatter(content);
    const gitLog = await this.getHistory(relPath, 10);
    const backlinks = this.getBacklinks(relPath);
    return { path: relPath, content, frontmatter: fm, gitLog, backlinks };
  }

  /**
   * 写入文档（新建或更新）
   * - 自动注入/更新 frontmatter（created/updated/tags/source）
   * - 自动 git commit
   */
  async writeFile(
    relPath: string,
    content: string,
    opts?: {
      source?: string;
      tags?: string[];
      commitMsg?: string;
      type?: string;
      title?: string;
      description?: string;
      resource?: string;
    },
  ): Promise<void> {
    if (path.basename(relPath) === INDEX_FILE) {
      throw new Error('index.md is auto-generated and cannot be written directly');
    }
    const absPath = this.safePath(relPath);
    const isNew = !fs.existsSync(absPath);
    const now = new Date().toISOString();

    // 元数据基准：新 content 自带 frontmatter 时以它为准（编辑路径）；
    // 否则回落到磁盘旧文件（CLI 纯正文重存路径），避免更新时丢已有元数据
    const parsed = this.parseFrontmatter(content);
    let base = parsed;
    if (!parsed.hasFm && !isNew) {
      try {
        base = this.parseFrontmatter(fs.readFileSync(absPath, 'utf-8'));
      } catch { /* 磁盘读取失败时退回 content 解析结果 */ }
    }

    const fm: Frontmatter = {
      created: isNew ? now : (base.fm.created || now),
      updated: now,
      tags: opts?.tags ?? base.fm.tags ?? [],
      source: opts?.source ?? base.fm.source ?? 'manual',
      type: opts?.type ?? base.fm.type,
      title: opts?.title ?? base.fm.title,
      description: opts?.description ?? base.fm.description,
      resource: opts?.resource ?? base.fm.resource,
    };

    const finalContent = this.renderDoc(fm, base.extra, parsed.body);
    fs.mkdirSync(path.dirname(absPath), { recursive: true });
    fs.writeFileSync(absPath, finalContent, 'utf-8');

    const changedIndexes = this.refreshIndexChain(this.parentDirOf(relPath));

    const action = isNew ? 'add' : 'edit';
    const commitMsg = opts?.commitMsg ?? `wiki: ${action} ${relPath}`;
    await this.gitCommit(commitMsg, [relPath, ...changedIndexes]);
  }

  /**
   * 搜索：遍历所有 .md 文件，按文件名 / H1 标题 / tags / description / 正文匹配。
   * 结果按命中位置分级（文件名或标题 > tags > description > 正文），同级按 updated 倒序。
   * query 为空时返回所有文档（用于 tags 过滤）
   */
  async search(query: string, opts?: { tags?: string[]; limit?: number }): Promise<SearchResult[]> {
    const limit = opts?.limit ?? 20;
    const queryLower = query.toLowerCase();
    const filterTags = opts?.tags ?? [];
    const ranked: { result: SearchResult; tier: number }[] = [];

    this.walkMd(this.wikiDir, '', (relPath, content) => {
      const { fm, body } = this.parseFrontmatter(content);
      const title = this.extractTitle(content, relPath);
      const titleLower = title.toLowerCase();
      const filenameLower = path.basename(relPath, '.md').toLowerCase();
      const tagsLower = (fm.tags ?? []).map(t => t.toLowerCase());

      if (filterTags.length > 0 && !filterTags.some(t => tagsLower.includes(t.toLowerCase()))) {
        return;
      }

      let tier: number;
      if (!query) tier = 0;
      else if (filenameLower.includes(queryLower) || titleLower.includes(queryLower)) tier = 0;
      else if (tagsLower.some(t => t.includes(queryLower))) tier = 1;
      else if ((fm.description ?? '').toLowerCase().includes(queryLower)) tier = 2;
      else if (body.toLowerCase().includes(queryLower)) tier = 3;
      else return;

      ranked.push({
        tier,
        result: {
          path: relPath,
          title: fm.title || title,
          tags: fm.tags ?? [],
          updated: fm.updated ?? '',
          type: fm.type,
          description: fm.description,
        },
      });
    });

    ranked.sort((a, b) =>
      a.tier !== b.tier ? a.tier - b.tier : (b.result.updated > a.result.updated ? 1 : -1),
    );
    return ranked.slice(0, limit).map(r => r.result);
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

  /** 创建目录（含 .gitkeep 使 git 可追踪），并生成/刷新本目录及祖先的 index.md */
  async mkdir(relPath: string): Promise<void> {
    const absPath = this.safePath(relPath);
    fs.mkdirSync(absPath, { recursive: true });
    const keepFile = path.join(absPath, '.gitkeep');
    const isNew = !fs.existsSync(keepFile);
    if (isNew) fs.writeFileSync(keepFile, '', 'utf-8');
    const changedIndexes = this.refreshIndexChain(relPath);
    if (isNew || changedIndexes.length > 0) {
      const files = [...(isNew ? [`${relPath}/.gitkeep`] : []), ...changedIndexes];
      await this.gitCommit(`wiki: mkdir ${relPath}`, files);
    }
  }

  /** 删除空目录（有文件时报错；.gitkeep 与自动生成的 index.md 不算内容） */
  async deleteEmptyDir(relPath: string): Promise<void> {
    const absPath = this.safePath(relPath);
    const entries = fs.readdirSync(absPath).filter(e => e !== '.gitkeep' && e !== INDEX_FILE);
    if (entries.length > 0) throw new Error(`Directory not empty: ${relPath}`);
    fs.rmSync(absPath, { recursive: true, force: true });
    this.refreshIndexChain(this.parentDirOf(relPath));
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
      } else if (entry.isFile() && entry.name.endsWith('.md') && entry.name !== INDEX_FILE) {
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
      } else if (entry.isFile() && entry.name.endsWith('.md') && entry.name !== INDEX_FILE) {
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

  /** relPath 所在目录（wiki 相对路径，根目录为 ''） */
  private parentDirOf(relPath: string): string {
    return relPath.includes('/') ? relPath.slice(0, relPath.lastIndexOf('/')) : '';
  }

  /**
   * 重新生成 dirRel 及其所有祖先目录（含根）的 index.md。
   * 内容无变化时不写盘。返回实际变更的 index.md 相对路径列表（供并入 git commit）。
   */
  private refreshIndexChain(dirRel: string): string[] {
    const changed: string[] = [];
    let cur = dirRel;
    for (;;) {
      const idxRel = cur ? `${cur}/${INDEX_FILE}` : INDEX_FILE;
      const absIdx = this.safePath(idxRel);
      if (fs.existsSync(path.dirname(absIdx))) {
        const content = this.renderIndex(cur);
        let prev = '';
        try { prev = fs.readFileSync(absIdx, 'utf-8'); } catch { /* 尚不存在 */ }
        if (content !== prev) {
          fs.writeFileSync(absIdx, content, 'utf-8');
          changed.push(idxRel);
        }
      }
      if (!cur) break;
      cur = this.parentDirOf(cur);
    }
    return changed;
  }

  /** 生成单个目录的纯索引内容：子目录 + 文档（标题取 H1） */
  private renderIndex(dirRel: string): string {
    const absDir = dirRel ? this.safePath(dirRel) : this.wikiDir;
    let entries: fs.Dirent[] = [];
    try {
      entries = fs.readdirSync(absDir, { withFileTypes: true });
    } catch { /* 目录不可读则生成空索引 */ }

    const dirs: string[] = [];
    const files: { name: string; title: string }[] = [];
    for (const entry of entries) {
      if (EXCLUDED.has(entry.name) || entry.name.startsWith('.')) continue;
      if (entry.isDirectory()) {
        dirs.push(entry.name);
      } else if (entry.isFile() && entry.name.endsWith('.md') && entry.name !== INDEX_FILE) {
        let title = entry.name.replace(/\.md$/, '');
        try {
          const content = fs.readFileSync(path.join(absDir, entry.name), 'utf-8');
          title = this.extractTitle(content, entry.name);
        } catch { /* 读取失败则用文件名 */ }
        files.push({ name: entry.name, title });
      }
    }
    dirs.sort((a, b) => a.localeCompare(b));
    files.sort((a, b) => a.name.localeCompare(b.name));

    const lines = [
      '<!-- auto-generated by semaclaw wiki (directory index) — do not edit -->',
      `# ${dirRel || '(wiki root)'}`,
      '',
    ];
    for (const d of dirs) lines.push(`- [${d}/](./${this.escapeLinkTarget(d)}/${INDEX_FILE})`);
    for (const f of files) lines.push(`- [${f.title}](./${this.escapeLinkTarget(f.name)})`);
    lines.push('');
    return lines.join('\n');
  }

  /** 转义会破坏 Markdown 链接语法的文件名字符（空格、括号、# 等） */
  private escapeLinkTarget(name: string): string {
    return name.replace(/[% ()#?]/g, ch => encodeURIComponent(ch));
  }

  /** 反链扫描：找出正文中链接到 target 的所有文档 */
  getBacklinks(target: string): BacklinkEntry[] {
    const targetNorm = target.replace(/^\/+/, '');
    const results: BacklinkEntry[] = [];

    this.walkMd(this.wikiDir, '', (relPath, content) => {
      if (relPath === targetNorm) return;
      const { body } = this.parseFrontmatter(content);
      const dir = this.parentDirOf(relPath);
      const linkRe = /\[[^\]]*\]\(([^)\s]+)(?:\s[^)]*)?\)/g;
      let m: RegExpExecArray | null;
      while ((m = linkRe.exec(body))) {
        let href = m[1];
        if (/^[a-z][a-z0-9+.-]*:/i.test(href) || href.startsWith('//')) continue;
        href = href.replace(/[?#].*$/, '');
        if (!/\.md$/i.test(href)) continue;
        try { href = decodeURIComponent(href); } catch { /* 非法转义按原样比较 */ }
        const resolved = href.startsWith('/')
          ? path.posix.normalize(href.slice(1))
          : path.posix.normalize(path.posix.join(dir, href));
        if (resolved === targetNorm) {
          results.push({ path: relPath, title: this.extractTitle(content, relPath) });
          break;
        }
      }
    });

    return results;
  }

  /**
   * frontmatter 解析（yaml 库，与 workflow/editDef 同源）。
   * - extra 保留所有非管理字段（含嵌套结构），写回时原样保留
   * - YAML 非法时按"无 frontmatter"处理（整块并入 body），避免回写时覆盖丢数据
   */
  private parseFrontmatter(content: string): {
    fm: Frontmatter;
    body: string;
    extra: Record<string, unknown>;
    hasFm: boolean;
  } {
    const noFm = () => ({
      fm: { created: '', updated: '', tags: [], source: 'manual' } as Frontmatter,
      body: content,
      extra: {},
      hasFm: false,
    });
    if (!content.startsWith('---')) return noFm();

    const end = content.indexOf('\n---', 3);
    if (end === -1) return noFm();

    let data: Record<string, unknown>;
    try {
      const parsed: unknown = parseYaml(content.slice(4, end));
      if (parsed === null || parsed === undefined) data = {};
      else if (typeof parsed !== 'object' || Array.isArray(parsed)) return noFm();
      else data = parsed as Record<string, unknown>;
    } catch {
      return noFm();
    }

    const body = content.slice(end + 4).replace(/^\r?\n/, '');
    const str = (v: unknown): string => (v === null || v === undefined ? '' : String(v));
    const strOpt = (v: unknown): string | undefined => {
      const s = str(v);
      return s ? s : undefined;
    };

    const fm: Frontmatter = {
      created: str(data.created),
      updated: str(data.updated),
      tags: Array.isArray(data.tags) ? data.tags.map(v => String(v)).filter(Boolean) : [],
      source: str(data.source) || 'manual',
      type: strOpt(data.type),
      title: strOpt(data.title),
      description: strOpt(data.description),
      resource: strOpt(data.resource),
    };

    const extra: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(data)) {
      if (!MANAGED_FM_KEYS.has(k)) extra[k] = v;
    }

    return { fm, body, extra, hasFm: true };
  }

  /** 组装最终文档：管理字段 + 保留的未知字段 + 正文 */
  private renderDoc(fm: Partial<Frontmatter>, extra: Record<string, unknown>, body: string): string {
    const data: Record<string, unknown> = {
      created: fm.created ?? '',
      updated: fm.updated ?? '',
      tags: fm.tags ?? [],
      source: fm.source ?? 'manual',
    };
    for (const key of ['type', 'title', 'description', 'resource'] as const) {
      if (fm[key]) data[key] = fm[key];
    }
    for (const [k, v] of Object.entries(extra)) {
      if (!MANAGED_FM_KEYS.has(k)) data[k] = v;
    }

    const doc = new YamlDocument(data);
    const tagsNode = doc.get('tags');
    if (tagsNode && typeof tagsNode === 'object') {
      (tagsNode as { flow?: boolean }).flow = true; // tags 保持 [a, b] 行内风格
    }
    return `---\n${doc.toString({ flowCollectionPadding: false })}---\n\n${body}`;
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
