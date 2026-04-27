/**
 * UIServer — 静态文件服务器 + /api/config 端点
 *
 * 默认监听 127.0.0.1:18788（GATEWAY_UI_PORT 可覆盖）。
 * 服务 web/dist/ 目录，并暴露 /api/config 供前端获取 WS 连接参数。
 */

import * as http from 'http';
import * as https from 'https';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import type { AgentPool } from '../agent/AgentPool';
import { saveAdminPermissionsConfig, loadLLMConfigs, saveLLMConfig, updateLLMConfig, removeLLMConfig, setActiveLLMConfig, setActiveQuickLLMConfig, saveThinkingEnabled, type LLMConfig } from './GroupManager';
import { syncLLMConfigToCore } from './llmModelSync';
import { getModelManager } from 'sema-core';
import type { WikiManager } from '../wiki/WikiManager';
import { readDisabledSkills, disableSkill, enableSkill } from '../skills/disabled.js';
import { loadAllLocalSkills } from '../skills/scan.js';
import { emitSkillsRefresh } from '../clawhub/signal.js';
import { searchSkills, getSkillMeta, downloadSkillZip, DEFAULT_REGISTRY } from '../clawhub/client.js';
import { extractZipToDir, writeSkillOrigin, readLockfile, writeLockfile } from '../clawhub/lockfile.js';
import { readDisabledSubagents, disableSubagent, enableSubagent } from '../subagents/disabled.js';
import type { PersonaRegistry } from '../agent/PersonaRegistry';
import { config } from '../config.js';

const MIME: Record<string, string> = {
  '.html':  'text/html; charset=utf-8',
  '.js':    'application/javascript',
  '.mjs':   'application/javascript',
  '.css':   'text/css',
  '.svg':   'image/svg+xml',
  '.png':   'image/png',
  '.ico':   'image/x-icon',
  '.json':  'application/json',
  '.woff2': 'font/woff2',
  '.woff':  'font/woff',
  '.ttf':   'font/ttf',
};

export class UIServer {
  private server: http.Server;
  private readonly port: number;
  private readonly distDir: string;
  private wikiManager: WikiManager | null = null;
  private personaRegistry: PersonaRegistry | null = null;

  setWikiManager(wm: WikiManager): void {
    this.wikiManager = wm;
  }

  setPersonaRegistry(pr: PersonaRegistry): void {
    this.personaRegistry = pr;
  }

  constructor(private readonly agentPool: AgentPool, opts?: { port?: number }) {
    this.port    = opts?.port ?? parseInt(process.env.GATEWAY_UI_PORT ?? '18788', 10);
    // Resolve web/dist relative to the package install location.
    // __dirname at runtime points to <pkg>/dist/gateway, so the bundled
    // web/dist sits at ../../web/dist. Falls back to cwd-based path for
    // local development where the package may not yet be built/installed.
    const packagedDist = path.resolve(__dirname, '..', '..', 'web', 'dist');
    const cwdDist      = path.join(process.cwd(), 'web', 'dist');
    this.distDir = fs.existsSync(packagedDist) ? packagedDist : cwdDist;

    this.server = http.createServer((req, res) => {
      this.handle(req, res).catch((err) => {
        console.error('[UIServer]', err);
        res.writeHead(500).end('Internal Server Error');
      });
    });
  }

  start(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.server.listen(this.port, '127.0.0.1', () => {
        console.log(`[UIServer] Web UI at http://127.0.0.1:${this.port}`);
        resolve();
      });
      this.server.once('error', reject);
    });
  }

  stop(): Promise<void> {
    return new Promise((resolve) => this.server.close(() => resolve()));
  }

  private readBody(req: http.IncomingMessage): Promise<string> {
    return new Promise((resolve) => {
      let data = '';
      req.on('data', chunk => { data += String(chunk); });
      req.on('end', () => resolve(data));
    });
  }

  /** Make a GET request supporting both http:// and https:// */
  private httpGet(url: string, headers: Record<string, string>): Promise<{ status: number; body: string }> {
    return new Promise((resolve, reject) => {
      const parsed = new URL(url);
      const isHttps = parsed.protocol === 'https:';
      const transport = isHttps ? https : http;
      const options = {
        hostname: parsed.hostname,
        port: parsed.port || (isHttps ? 443 : 80),
        path: parsed.pathname + parsed.search,
        method: 'GET',
        headers,
        timeout: 15000,
      };
      const req = transport.request(options, (res) => {
        let body = '';
        res.on('data', chunk => { body += String(chunk); });
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body }));
      });
      req.on('error', reject);
      req.on('timeout', () => { req.destroy(); reject(new Error('Request timeout')); });
      req.end();
    });
  }

  /** Fetch available models from an LLM provider */
  private async fetchModels(baseURL: string, apiKey: string, adapt: string): Promise<string[]> {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    let modelsUrl: string;

    // Official Anthropic API uses x-api-key; every other provider's /models endpoint
    // (including DeepSeek and OpenRouter in Anthropic-compat mode) uses Bearer.
    if (adapt === 'anthropic' && /anthropic\.com/i.test(baseURL)) {
      const base = baseURL.replace(/\/v1\/?$/, '');
      modelsUrl = `${base}/v1/models`;
      headers['x-api-key'] = apiKey;
      headers['anthropic-version'] = '2023-06-01';
    } else {
      // OpenAI-compatible models endpoint (universal for all other providers)
      const base = baseURL.replace(/\/$/, '').replace(/\/chat\/completions$/, '');
      modelsUrl = `${base}/models`;
      headers['Authorization'] = `Bearer ${apiKey}`;
    }

    const { status, body } = await this.httpGet(modelsUrl, headers);
    if (status < 200 || status >= 300) {
      throw new Error(`HTTP ${status}: ${body.slice(0, 200)}`);
    }
    const json = JSON.parse(body);
    // Anthropic: { data: [{ id }] }, OpenAI: { data: [{ id }] }
    const list: Array<{ id: string }> = json.data ?? [];
    return list.map(m => m.id).filter(Boolean);
  }

  /** Test connection by attempting to list models */
  private async testConnection(baseURL: string, apiKey: string, adapt: string): Promise<void> {
    await this.fetchModels(baseURL, apiKey, adapt);
  }

  private async handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const urlPath = (req.url ?? '/').split('?')[0];

    // CORS for dev proxy
    res.setHeader('Access-Control-Allow-Origin', '*');

    // CORS preflight
    if (req.method === 'OPTIONS') {
      res.writeHead(204).end();
      return;
    }

    if (urlPath === '/api/config') {
      res.writeHead(200, { 'Content-Type': 'application/json' }).end(
        JSON.stringify({
          wsPort: parseInt(process.env.GATEWAY_PORT ?? '18789', 10),
          token:  process.env.GATEWAY_TOKEN ?? '',
        })
      );
      return;
    }

    // LLM config endpoints
    if (urlPath === '/api/llm-config') {
      if (req.method === 'GET') {
        const stored = loadLLMConfigs();
        // 附带 sema-core 当前实际使用的模型（用于 UI 显示）
        const semaProfile = (() => {
          try { return getModelManager().getModel('main'); } catch { return null; }
        })();
        const semaQuickProfile = (() => {
          try { return getModelManager().getModel('quick'); } catch { return null; }
        })();
        res.writeHead(200, { 'Content-Type': 'application/json' }).end(
          JSON.stringify({
            ...stored,
            semaModel: semaProfile ? { modelName: semaProfile.modelName, provider: semaProfile.provider } : null,
            semaQuickModel: semaQuickProfile ? { modelName: semaQuickProfile.modelName, provider: semaQuickProfile.provider } : null,
            thinkingEnabled: this.agentPool.getThinkingEnabled(),
          })
        );
        return;
      }
      if (req.method === 'POST') {
        const body = await this.readBody(req);
        const data = JSON.parse(body) as Omit<LLMConfig, 'id'>;
        const id = `llm_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
        const cfg: LLMConfig = { id, ...data };
        saveLLMConfig(cfg);

        // 同步写入 sema-core 单例（下一次 LLM call 立刻生效）
        try {
          await syncLLMConfigToCore(cfg);
        } catch (e) {
          console.warn('[UIServer] syncLLMConfigToCore failed:', e);
        }

        // 第一条配置自动激活
        const { configs } = loadLLMConfigs();
        if (configs.length === 1) {
          setActiveLLMConfig(id);
          try { await getModelManager().switchCurrentModel(`${cfg.modelName}[${cfg.provider}]`); } catch { /* ignore */ }
        }

        res.writeHead(201, { 'Content-Type': 'application/json' }).end(JSON.stringify(cfg));
        return;
      }
    }

    if (urlPath === '/api/llm-config/active') {
      if (req.method === 'POST') {
        const body = await this.readBody(req);
        const { id, type = 'main' } = JSON.parse(body) as { id: string | null; type?: 'main' | 'quick' };

        if (type === 'quick') {
          // 设置快速模型
          setActiveQuickLLMConfig(id);
          if (id) {
            const { configs, activeId: mainId } = loadLLMConfigs();
            const cfg = configs.find(c => c.id === id);
            if (cfg) {
              try {
                await syncLLMConfigToCore(cfg);
                // applyTaskModelConfig 同时更新 main + quick 指针
                const mainCfg = configs.find(c => c.id === mainId);
                const mainName = mainCfg ? `${mainCfg.modelName}[${mainCfg.provider}]` : (getModelManager().getModelName('main') ?? '');
                await getModelManager().applyTaskModelConfig({
                  main: mainName,
                  quick: `${cfg.modelName}[${cfg.provider}]`,
                });
                console.log(`[UIServer] Switched sema-core quick model to: ${cfg.modelName}[${cfg.provider}]`);
              } catch (e) {
                console.warn('[UIServer] applyTaskModelConfig (quick) failed:', e);
              }
            }
          }
          res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ activeQuickId: id }));
        } else {
          // 设置主模型（原有逻辑）
          setActiveLLMConfig(id);
          if (id) {
            const { configs } = loadLLMConfigs();
            const cfg = configs.find(c => c.id === id);
            if (cfg) {
              try {
                await syncLLMConfigToCore(cfg);
                await getModelManager().switchCurrentModel(`${cfg.modelName}[${cfg.provider}]`);
                console.log(`[UIServer] Switched sema-core main model to: ${cfg.modelName}[${cfg.provider}]`);
              } catch (e) {
                console.warn('[UIServer] switchCurrentModel failed:', e);
              }
            }
          }
          res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ activeId: id }));
        }
        return;
      }
    }

    if (urlPath === '/api/llm-config/test') {
      if (req.method === 'POST') {
        const body = await this.readBody(req);
        const { baseURL, apiKey, adapt } = JSON.parse(body) as { baseURL: string; apiKey: string; adapt: string };
        try {
          await this.testConnection(baseURL, apiKey, adapt);
          res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ success: true, message: '连接成功' }));
        } catch (e: unknown) {
          res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ success: false, message: String((e as Error).message ?? e) }));
        }
        return;
      }
    }

    if (urlPath === '/api/llm-config/models') {
      if (req.method === 'POST') {
        const body = await this.readBody(req);
        const { baseURL, apiKey, adapt } = JSON.parse(body) as { baseURL: string; apiKey: string; adapt: string };
        try {
          const models = await this.fetchModels(baseURL, apiKey, adapt);
          res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ success: true, models }));
        } catch (e: unknown) {
          res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ success: false, message: String((e as Error).message ?? e) }));
        }
        return;
      }
    }

    // PATCH /api/llm-config/:id — 部分更新（用于 toggle vision 等）
    const idMatch = urlPath.match(/^\/api\/llm-config\/([^/]+)$/);
    if (idMatch && req.method === 'PATCH') {
      const id = decodeURIComponent(idMatch[1]);
      const body = await this.readBody(req);
      let patch: Record<string, unknown>;
      try {
        patch = JSON.parse(body) as Record<string, unknown>;
      } catch {
        res.writeHead(400, { 'Content-Type': 'application/json' }).end(JSON.stringify({ error: 'invalid JSON' }));
        return;
      }
      // 防止 id 被绕过修改
      delete patch.id;
      const updated = updateLLMConfig(id, patch);
      if (!updated) {
        res.writeHead(404, { 'Content-Type': 'application/json' }).end(JSON.stringify({ error: 'config not found' }));
        return;
      }
      // 同步到 sema-core 单例（addNewModel 是 upsert by name；vision 单独打 patch）
      try {
        await syncLLMConfigToCore(updated);
      } catch (e) {
        console.warn('[UIServer] PATCH syncLLMConfigToCore failed:', e);
      }
      res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify(updated));
      return;
    }

    // DELETE /api/llm-config/:id
    if (idMatch && req.method === 'DELETE') {
      const id = decodeURIComponent(idMatch[1]);
      removeLLMConfig(id);
      res.writeHead(204).end();
      return;
    }

    // GET /api/skills/remote-search?q= — 代理 ClaWHub 搜索，附带本地已安装标记
    if (urlPath.startsWith('/api/skills/remote-search') && req.method === 'GET') {
      const qs = new URL(req.url ?? '', 'http://x').searchParams;
      const q = qs.get('q') ?? '';
      if (!q.trim()) {
        res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ results: [] }));
        return;
      }
      try {
        const registry = process.env['CLAWHUB_REGISTRY']?.trim() || DEFAULT_REGISTRY;
        const rawResults = await searchSkills(q, { limit: 20, registry });
        const localSlugs = new Set(loadAllLocalSkills().map(s => s.name));
        const results = rawResults.map(r => ({ ...r, installed: localSlugs.has(r.slug) }));
        res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ results }));
      } catch (err) {
        res.writeHead(502, { 'Content-Type': 'application/json' }).end(
          JSON.stringify({ error: err instanceof Error ? err.message : String(err) })
        );
      }
      return;
    }

    // POST /api/skills/install — 安装远程 skill
    if (urlPath === '/api/skills/install' && req.method === 'POST') {
      const body = await this.readBody(req);
      const { slug } = JSON.parse(body) as { slug: string };
      if (!slug?.trim()) {
        res.writeHead(400, { 'Content-Type': 'application/json' }).end(JSON.stringify({ error: 'slug required' }));
        return;
      }
      if (!/^[a-zA-Z0-9_-]+$/.test(slug)) {
        res.writeHead(400, { 'Content-Type': 'application/json' }).end(JSON.stringify({ error: 'invalid slug' }));
        return;
      }
      const managedDir = config.paths.managedSkillsDir;
      const target = path.resolve(managedDir, slug);
      if (!target.startsWith(path.resolve(managedDir) + path.sep)) {
        res.writeHead(400, { 'Content-Type': 'application/json' }).end(JSON.stringify({ error: 'invalid slug' }));
        return;
      }
      try {
        const registry = process.env['CLAWHUB_REGISTRY']?.trim() || DEFAULT_REGISTRY;
        const meta = await getSkillMeta(slug, { registry });
        if (meta.moderation?.isMalwareBlocked) {
          res.writeHead(403, { 'Content-Type': 'application/json' }).end(
            JSON.stringify({ error: `${slug} is flagged as malicious`, blocked: true })
          );
          return;
        }
        const version = meta.latestVersion?.version;
        if (!version) {
          res.writeHead(422, { 'Content-Type': 'application/json' }).end(JSON.stringify({ error: 'no version available' }));
          return;
        }
        const zipBuf = await downloadSkillZip(slug, version, { registry });
        if (fs.existsSync(target)) await fs.promises.rm(target, { recursive: true, force: true });
        await extractZipToDir(new Uint8Array(zipBuf), target);
        await writeSkillOrigin(target, {
          version: 1, registry: DEFAULT_REGISTRY, slug,
          installedVersion: version, installedAt: Date.now(),
        });
        const lock = await readLockfile(managedDir);
        lock.skills[slug] = { version, installedAt: Date.now() };
        await writeLockfile(managedDir, lock);
        this.agentPool.reloadAllSkills();
        await emitSkillsRefresh();
        res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ ok: true, slug, version }));
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'application/json' }).end(
          JSON.stringify({ error: err instanceof Error ? err.message : String(err) })
        );
      }
      return;
    }

    // GET /api/skills/:name/readme — 返回 SKILL.md 原始内容
    const readmeMatch = urlPath.match(/^\/api\/skills\/([^/]+)\/readme$/);
    if (readmeMatch) {
      const name = decodeURIComponent(readmeMatch[1]);
      const skills = loadAllLocalSkills();
      const skill = skills.find(s => s.name === name);
      if (!skill) {
        res.writeHead(404).end('Not found');
        return;
      }
      if (req.method === 'GET') {
        const content = fs.existsSync(skill.filePath) ? fs.readFileSync(skill.filePath, 'utf8') : '';
        res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' }).end(content);
        return;
      }
      if (req.method === 'PUT') {
        const content = await this.readBody(req);
        fs.writeFileSync(skill.filePath, content, 'utf8');
        res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ ok: true }));
        return;
      }
    }

    // GET /api/skills — 返回所有本地 skill 列表及启用/禁用状态
    if (urlPath === '/api/skills' && req.method === 'GET') {
      const skills = loadAllLocalSkills();
      const disabled = readDisabledSkills();
      const result = skills.map(s => ({
        name: s.name,
        description: s.description,
        version: s.version,
        source: s.source,
        dir: s.dir,
        disabled: disabled.has(s.name),
      }));
      res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ skills: result }));
      return;
    }

    // POST /api/skills/:name/enable|disable — 切换 skill 启用状态
    const skillToggleMatch = urlPath.match(/^\/api\/skills\/([^/]+)\/(enable|disable)$/);
    if (skillToggleMatch && req.method === 'POST') {
      const name = decodeURIComponent(skillToggleMatch[1]);
      const action = skillToggleMatch[2] as 'enable' | 'disable';
      if (action === 'enable') {
        enableSkill(name);
      } else {
        disableSkill(name);
      }
      // 通知所有活跃 agent 重新加载（同时使缓存失效）
      this.agentPool.reloadAllSkills();
      // 写信号文件，通知其他进程（如 CLI daemon）
      await emitSkillsRefresh();
      const disabled = readDisabledSkills();
      res.writeHead(200, { 'Content-Type': 'application/json' }).end(
        JSON.stringify({ name, disabled: disabled.has(name) })
      );
      return;
    }

    // ─── Subagents (virtual persona) API ──────────────────────────────────────

    // GET /api/subagents — 返回所有 persona 列表及启用/禁用状态
    if (urlPath === '/api/subagents' && req.method === 'GET') {
      this.personaRegistry?.reload();
      const personas = this.personaRegistry?.list() ?? [];
      const disabled = readDisabledSubagents();
      const result = personas.map(p => ({
        name: p.name,
        description: p.description,
        tools: p.tools,
        model: p.model,
        maxConcurrent: p.maxConcurrent,
        filePath: p.filePath,
        disabled: disabled.has(p.name),
      }));
      res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ subagents: result }));
      return;
    }

    // GET/PUT /api/subagents/:name/readme — 读取/保存 persona .md 文件原始内容
    const subagentReadmeMatch = urlPath.match(/^\/api\/subagents\/([^/]+)\/readme$/);
    if (subagentReadmeMatch) {
      const name = decodeURIComponent(subagentReadmeMatch[1]);
      const persona = this.personaRegistry?.get(name);
      if (!persona) {
        res.writeHead(404).end('Not found');
        return;
      }
      if (req.method === 'GET') {
        const content = fs.existsSync(persona.filePath) ? fs.readFileSync(persona.filePath, 'utf8') : '';
        res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' }).end(content);
        return;
      }
      if (req.method === 'PUT') {
        const content = await this.readBody(req);
        fs.writeFileSync(persona.filePath, content, 'utf8');
        this.personaRegistry?.reload();
        res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ ok: true }));
        return;
      }
    }

    // POST /api/subagents/create — 创建新 persona .md 文件
    if (urlPath === '/api/subagents/create' && req.method === 'POST') {
      const body = await this.readBody(req);
      const { name, content } = JSON.parse(body) as { name: string; content: string };
      if (!name || !content) {
        res.writeHead(400, { 'Content-Type': 'application/json' }).end(JSON.stringify({ error: 'name and content are required' }));
        return;
      }
      // name → filename: 空格替换为连字符，去除不安全字符
      const filename = name.trim().replace(/\s+/g, '-').replace(/[^a-zA-Z0-9_\-\u4e00-\u9fff]/g, '');
      if (!filename) {
        res.writeHead(400, { 'Content-Type': 'application/json' }).end(JSON.stringify({ error: 'Invalid name' }));
        return;
      }
      const filePath = path.join(config.paths.virtualAgentsDir, `${filename}.md`);
      // 检查文件名冲突
      if (fs.existsSync(filePath)) {
        res.writeHead(409, { 'Content-Type': 'application/json' }).end(
          JSON.stringify({ error: `A persona file "${filename}.md" already exists. Please choose a different name or update the existing file.` })
        );
        return;
      }
      // 检查 PersonaRegistry 中是否有同名 persona（name 字段可能不等于 filename）
      if (this.personaRegistry?.get(name)) {
        res.writeHead(409, { 'Content-Type': 'application/json' }).end(
          JSON.stringify({ error: `A persona named "${name}" already exists. Please choose a different name.` })
        );
        return;
      }
      // 确保目录存在
      if (!fs.existsSync(config.paths.virtualAgentsDir)) {
        fs.mkdirSync(config.paths.virtualAgentsDir, { recursive: true });
      }
      fs.writeFileSync(filePath, content, 'utf-8');
      this.personaRegistry?.reload();
      res.writeHead(201, { 'Content-Type': 'application/json' }).end(JSON.stringify({ ok: true, filename }));
      return;
    }

    // POST /api/subagents/:name/enable|disable — 切换 persona 启用状态
    const subagentToggleMatch = urlPath.match(/^\/api\/subagents\/([^/]+)\/(enable|disable)$/);
    if (subagentToggleMatch && req.method === 'POST') {
      const name = decodeURIComponent(subagentToggleMatch[1]);
      const action = subagentToggleMatch[2] as 'enable' | 'disable';
      if (action === 'enable') {
        enableSubagent(name);
      } else {
        disableSubagent(name);
      }
      const disabled = readDisabledSubagents();
      res.writeHead(200, { 'Content-Type': 'application/json' }).end(
        JSON.stringify({ name, disabled: disabled.has(name) })
      );
      return;
    }

    // ── Hooks config ────────────────────────────────────────────
    if (urlPath === '/api/hooks') {
      const hooksPath = path.join(os.homedir(), '.semaclaw', 'hooks.json');
      if (req.method === 'GET') {
        try {
          const raw = fs.readFileSync(hooksPath, 'utf-8');
          res.writeHead(200, { 'Content-Type': 'application/json' }).end(raw);
        } catch {
          res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ hooks: {} }, null, 2));
        }
        return;
      }
      if (req.method === 'PUT') {
        const body = await this.readBody(req);
        let parsed: unknown;
        try {
          parsed = JSON.parse(body);
        } catch (e) {
          res.writeHead(400, { 'Content-Type': 'application/json' }).end(JSON.stringify({ error: `Invalid JSON: ${(e as Error).message}` }));
          return;
        }
        if (typeof parsed !== 'object' || parsed === null || !('hooks' in parsed) || typeof (parsed as Record<string, unknown>).hooks !== 'object' || Array.isArray((parsed as Record<string, unknown>).hooks)) {
          res.writeHead(400, { 'Content-Type': 'application/json' }).end(JSON.stringify({ error: 'Root object must have a "hooks" key of type object' }));
          return;
        }
        const hooks = (parsed as Record<string, unknown>).hooks as Record<string, unknown>;
        for (const [event, configs] of Object.entries(hooks)) {
          if (!Array.isArray(configs)) {
            res.writeHead(400, { 'Content-Type': 'application/json' }).end(JSON.stringify({ error: `Event "${event}": value must be an array` }));
            return;
          }
          for (let i = 0; i < configs.length; i++) {
            const cfg = configs[i] as Record<string, unknown>;
            if (!Array.isArray(cfg?.hooks)) {
              res.writeHead(400, { 'Content-Type': 'application/json' }).end(JSON.stringify({ error: `Event "${event}"[${i}]: must have a "hooks" array` }));
              return;
            }
            for (let j = 0; j < (cfg.hooks as unknown[]).length; j++) {
              const hook = (cfg.hooks as Record<string, unknown>[])[j];
              if (hook.type !== 'command' && hook.type !== 'prompt') {
                res.writeHead(400, { 'Content-Type': 'application/json' }).end(JSON.stringify({ error: `Event "${event}"[${i}].hooks[${j}]: type must be "command" or "prompt"` }));
                return;
              }
              if (hook.type === 'command' && !hook.command) {
                res.writeHead(400, { 'Content-Type': 'application/json' }).end(JSON.stringify({ error: `Event "${event}"[${i}].hooks[${j}]: type "command" requires a "command" field` }));
                return;
              }
              if (hook.type === 'prompt' && !hook.prompt) {
                res.writeHead(400, { 'Content-Type': 'application/json' }).end(JSON.stringify({ error: `Event "${event}"[${i}].hooks[${j}]: type "prompt" requires a "prompt" field` }));
                return;
              }
            }
          }
        }
        fs.mkdirSync(path.join(os.homedir(), '.semaclaw'), { recursive: true });
        fs.writeFileSync(hooksPath, JSON.stringify(parsed, null, 2), 'utf-8');
        res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ ok: true }));
        return;
      }
    }

    if (urlPath === '/api/thinking') {
      if (req.method === 'POST') {
        const body = await this.readBody(req);
        const { enabled } = JSON.parse(body) as { enabled: boolean };
        saveThinkingEnabled(enabled);
        this.agentPool.setThinkingEnabled(enabled);
        res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ thinkingEnabled: enabled }));
        return;
      }
    }

    if (urlPath === '/api/admin-permissions') {
      if (req.method === 'GET') {
        res.writeHead(200, { 'Content-Type': 'application/json' }).end(
          JSON.stringify(this.agentPool.getPermissionsConfig())
        );
        return;
      }
      if (req.method === 'POST') {
        const body = await this.readBody(req);
        const opts = JSON.parse(body) as { skipMainAgentPermissions: boolean; skipAllAgentsPermissions: boolean };
        saveAdminPermissionsConfig(opts);
        await this.agentPool.setPermissionsConfig(opts);
        res.writeHead(200, { 'Content-Type': 'application/json' }).end(
          JSON.stringify(opts)
        );
        return;
      }
    }

    if (urlPath === '/api/quicknotes' && req.method === 'POST') {
      const body = await this.readBody(req);
      const { text } = JSON.parse(body) as { text: string };

      // Extract filename: H1 → H2 → timestamp
      const h1 = text.match(/^#(?!#)\s+(.+)/m);
      const h2 = text.match(/^##(?!#)\s+(.+)/m);
      let rawTitle: string;
      if (h1) {
        rawTitle = h1[1].trim();
      } else if (h2) {
        rawTitle = h2[1].trim();
      } else {
        const now = new Date();
        const pad = (n: number) => String(n).padStart(2, '0');
        rawTitle = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}-${pad(now.getHours())}-${pad(now.getMinutes())}-${pad(now.getSeconds())}`;
      }

      // Sanitize: strip forbidden chars, collapse spaces to dashes, truncate
      const safe = rawTitle
        .replace(/[<>:"/\\|?*\x00-\x1f]/g, '')
        .trim()
        .replace(/\s+/g, '-')
        .slice(0, 60) || 'quicknote';

      const dir = path.join(os.homedir(), 'semaclaw', 'quicknotes');
      fs.mkdirSync(dir, { recursive: true });

      // Resolve filename conflicts
      let filename = `${safe}.md`;
      let filepath = path.join(dir, filename);
      let counter = 1;
      while (fs.existsSync(filepath)) {
        filename = `${safe}-${counter}.md`;
        filepath = path.join(dir, filename);
        counter++;
      }

      fs.writeFileSync(filepath, text, 'utf-8');
      res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ filename }));
      return;
    }

    // ── Wiki API ────────────────────────────────────────────────
    if (urlPath.startsWith('/api/wiki') && this.wikiManager) {
      await this.handleWiki(urlPath, req, res);
      return;
    }

    // /wiki and /wiki/* → standalone wiki SPA
    const isWikiRoute = urlPath === '/wiki' || urlPath.startsWith('/wiki/');
    // /plugins and /plugins/* → standalone plugins SPA
    const isPluginsRoute = urlPath === '/plugins' || urlPath.startsWith('/plugins/');
    const spaFallback = isWikiRoute ? 'wiki.html' : isPluginsRoute ? 'plugins.html' : 'index.html';

    let filePath = path.join(this.distDir, urlPath === '/' || isWikiRoute || isPluginsRoute ? spaFallback : urlPath);

    // Path traversal guard
    const sep = path.sep;
    if (!filePath.startsWith(this.distDir + sep) && filePath !== path.join(this.distDir, 'index.html')) {
      res.writeHead(403).end('Forbidden');
      return;
    }

    if (!fs.existsSync(filePath)) {
      // SPA fallback
      filePath = path.join(this.distDir, spaFallback);
    }

    if (!fs.existsSync(filePath)) {
      res.writeHead(404, { 'Content-Type': 'text/plain' }).end(
        'Web UI not built. Run: npm run build:web'
      );
      return;
    }

    const mime = MIME[path.extname(filePath)] ?? 'application/octet-stream';
    res.writeHead(200, { 'Content-Type': mime });
    fs.createReadStream(filePath).pipe(res);
  }

  // ── Wiki API handler ───────────────────────────────────────────

  private async handleWiki(
    urlPath: string,
    req: http.IncomingMessage,
    res: http.ServerResponse,
  ): Promise<void> {
    const wm = this.wikiManager!;
    const json = (data: unknown, status = 200) =>
      res.writeHead(status, { 'Content-Type': 'application/json' }).end(JSON.stringify(data));
    const err = (msg: string, status = 400) => json({ error: msg }, status);

    const qs = new URL(req.url ?? '/', 'http://localhost').searchParams;

    try {
      // GET /api/wiki/tree
      if (urlPath === '/api/wiki/tree' && req.method === 'GET') {
        const tree = await wm.getTree();
        json({ tree });
        return;
      }

      // GET /api/wiki/file?path=...
      if (urlPath === '/api/wiki/file' && req.method === 'GET') {
        const p = qs.get('path');
        if (!p) { err('Missing path'); return; }
        const doc = await wm.readFile(p);
        json(doc);
        return;
      }

      // PUT /api/wiki/file — { path, content, commitMsg? }
      if (urlPath === '/api/wiki/file' && req.method === 'PUT') {
        const body = await this.readBody(req);
        const { path: p, content, commitMsg, source, tags } = JSON.parse(body) as {
          path: string; content: string; commitMsg?: string; source?: string; tags?: string[];
        };
        if (!p || content === undefined) { err('Missing path or content'); return; }
        await wm.writeFile(p, content, { commitMsg, source, tags });
        json({ path: p, updated: new Date().toISOString() });
        return;
      }

      // GET /api/wiki/search?q=...&tags=...&limit=...
      if (urlPath === '/api/wiki/search' && req.method === 'GET') {
        const q = qs.get('q') ?? '';
        const tagsParam = qs.get('tags');
        const limit = parseInt(qs.get('limit') ?? '20', 10);
        const tags = tagsParam ? tagsParam.split(',').map(t => t.trim()).filter(Boolean) : [];
        const results = await wm.search(q, { tags, limit });
        json({ results });
        return;
      }

      // GET /api/wiki/stats
      if (urlPath === '/api/wiki/stats' && req.method === 'GET') {
        const stats = await wm.getStats();
        json(stats);
        return;
      }

      // GET /api/wiki/history?path=...&limit=...
      if (urlPath === '/api/wiki/history' && req.method === 'GET') {
        const p = qs.get('path');
        if (!p) { err('Missing path'); return; }
        const limit = parseInt(qs.get('limit') ?? '20', 10);
        const commits = await wm.getHistory(p, limit);
        json({ commits });
        return;
      }

      // GET /api/wiki/tags
      if (urlPath === '/api/wiki/tags' && req.method === 'GET') {
        const tags = await wm.getTags();
        json({ tags });
        return;
      }

      // POST /api/wiki/mkdir — { path }
      if (urlPath === '/api/wiki/mkdir' && req.method === 'POST') {
        const body = await this.readBody(req);
        const { path: p } = JSON.parse(body) as { path: string };
        if (!p) { err('Missing path'); return; }
        await wm.mkdir(p);
        json({ path: p });
        return;
      }

      // DELETE /api/wiki/dir?path=...
      if (urlPath === '/api/wiki/dir' && req.method === 'DELETE') {
        const p = qs.get('path');
        if (!p) { err('Missing path'); return; }
        await wm.deleteEmptyDir(p);
        res.writeHead(204).end();
        return;
      }

      err('Not found', 404);
    } catch (e: unknown) {
      err(String((e as Error).message ?? e), 500);
    }
  }
}
