import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { randomUUID } from 'node:crypto';
import type {
  MarketplaceSource,
  MarketplaceConfig,
  MarketplaceSourceItemState,
  MarketplaceStateFile,
  MarketplacePlugin,
  MarketplacePluginSkill,
  MarketplacePluginSubagent,
  MarketplaceSourceInfo,
} from './types.js';
import { scanSource, type SourceDef } from '../skills/scan.js';
import { expandSkillsDir, type SkillLocate } from '../skills/expand.js';
import { readDisabledSkills } from '../skills/disabled.js';
import { readDisabledSubagents } from '../subagents/disabled.js';
import { cloneOrPull } from './GitSync.js';

const SEMACLAW_DIR = path.join(os.homedir(), '.semaclaw');
const MARKETPLACE_CONFIG_PATH = path.join(SEMACLAW_DIR, 'marketplace.json');
const MARKETPLACE_STATE_PATH = path.join(SEMACLAW_DIR, 'marketplace-state.json');
const MARKETPLACE_CLONES_DIR = path.join(SEMACLAW_DIR, 'marketplace');

function parseSubagentFrontmatter(raw: string): Record<string, string> {
  const result: Record<string, string> = {};
  if (!raw.startsWith('---')) return result;
  const end = raw.indexOf('\n---', 3);
  if (end === -1) return result;
  for (const line of raw.slice(4, end).split('\n')) {
    const col = line.indexOf(':');
    if (col === -1) continue;
    const key = line.slice(0, col).trim();
    const val = line.slice(col + 1).trim().replace(/^['"]|['"]$/g, '');
    if (key) result[key] = val;
  }
  return result;
}

// ── Plugin discovery types ───────────────────────────────────────────────────

interface PluginDef {
  dir: string;
  pluginJsonPath: string;
}

interface PluginJson {
  name?: string;
  description?: string;
  version?: string;
  author?: { name?: string } | string;
  keywords?: string[];
}

interface MCPPluginServerDef {
  name: string;
  transport: 'stdio' | 'sse' | 'http';
  description?: string;
  enabled?: boolean;
  useTools?: string[] | null;
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
  headers?: Record<string, string>;
}

export class MarketplaceManager {
  private config: MarketplaceConfig = { sources: [] };
  private state: MarketplaceStateFile = {};

  constructor() {
    this.loadConfig();
    this.loadState();
  }

  // ── Source CRUD ──────────────────────────────────────────────────────────────

  getSources(): MarketplaceSource[] {
    return [...this.config.sources].sort((a, b) => a.priority - b.priority);
  }

  getSource(id: string): MarketplaceSource | null {
    return this.config.sources.find(s => s.id === id) ?? null;
  }

  addSource(data: {
    name: string;
    type: 'git' | 'local';
    url?: string;
    branch?: string;
    localPath?: string;
    priority?: number;
    enabled?: boolean;
  }): MarketplaceSource {
    const id = randomUUID();
    const maxPriority = this.config.sources.reduce((m, s) => Math.max(m, s.priority), 0);
    const source: MarketplaceSource = {
      id,
      name: data.name,
      type: data.type,
      url: data.url,
      branch: data.branch ?? 'main',
      localPath: data.type === 'git'
        ? path.join(MARKETPLACE_CLONES_DIR, id)
        : path.resolve(data.localPath ?? ''),
      priority: data.priority ?? maxPriority + 1,
      enabled: data.enabled ?? true,
      lastSynced: null,
    };
    this.config.sources.push(source);
    this.saveConfig();
    return source;
  }

  updateSource(id: string, patch: Partial<Omit<MarketplaceSource, 'id'>>): MarketplaceSource | null {
    const idx = this.config.sources.findIndex(s => s.id === id);
    if (idx === -1) return null;
    const updated = { ...this.config.sources[idx], ...patch, id };
    this.config.sources[idx] = updated;
    this.saveConfig();
    return updated;
  }

  removeSource(id: string): boolean {
    const idx = this.config.sources.findIndex(s => s.id === id);
    if (idx === -1) return false;
    const source = this.config.sources[idx];
    this.config.sources.splice(idx, 1);
    delete this.state[id];
    this.saveConfig();
    this.saveState();
    if (source.type === 'git') {
      const cloneDir = path.join(MARKETPLACE_CLONES_DIR, id);
      try { if (fs.existsSync(cloneDir)) fs.rmSync(cloneDir, { recursive: true, force: true }); } catch { /* ignore */ }
    }
    return true;
  }

  async syncSource(id: string): Promise<void> {
    const source = this.config.sources.find(s => s.id === id);
    if (!source) throw new Error(`Marketplace source not found: ${id}`);
    if (source.type === 'git') {
      if (!source.url) throw new Error('Git source missing URL');
      await cloneOrPull(source.url, source.branch ?? 'main', source.localPath);
    }
    this.updateSource(id, { lastSynced: new Date().toISOString(), syncError: undefined });
  }

  reorderSources(orderedIds: string[]): void {
    for (let i = 0; i < orderedIds.length; i++) {
      const idx = this.config.sources.findIndex(s => s.id === orderedIds[i]);
      if (idx !== -1) this.config.sources[idx].priority = i + 1;
    }
    this.saveConfig();
  }

  // ── Plugin state (plugin-level toggle, absent = disabled) ────────────────────

  private getSourceState(sourceId: string): MarketplaceSourceItemState {
    const st = this.state[sourceId];
    // Handle migration from old format (had skills/subagents/hooksEnabled keys)
    if (!st || !st.plugins) return { plugins: {} };
    return st;
  }

  private ensureSourceState(sourceId: string): MarketplaceSourceItemState {
    if (!this.state[sourceId] || !this.state[sourceId].plugins) {
      this.state[sourceId] = { plugins: {} };
    }
    return this.state[sourceId];
  }

  setPluginEnabled(sourceId: string, pluginName: string, enabled: boolean): void {
    const st = this.ensureSourceState(sourceId);
    if (enabled) {
      st.plugins[pluginName] = true;
    } else {
      delete st.plugins[pluginName];
    }
    this.saveState();
  }

  enableAllInSource(sourceId: string): void {
    const source = this.config.sources.find(s => s.id === sourceId);
    if (!source) return;
    const st = this.ensureSourceState(sourceId);
    for (const plugin of this.findPlugins(source.localPath)) {
      const meta = this.readPluginJson(plugin.pluginJsonPath);
      const name = this.pluginName(meta, plugin.dir);
      st.plugins[name] = true;
    }
    this.saveState();
  }

  disableAllInSource(sourceId: string): void {
    const st = this.ensureSourceState(sourceId);
    st.plugins = {};
    this.saveState();
  }

  enableAll(): void {
    for (const source of this.config.sources) this.enableAllInSource(source.id);
  }

  disableAll(): void {
    for (const source of this.config.sources) this.disableAllInSource(source.id);
  }

  // ── Integration helpers for skills/subagents/hooks ───────────────────────────

  /**
   * SourceDef[] for injection into loadAllLocalSkills().
   * Sorted DESCENDING by priority so priority=1 (highest) is appended last = wins.
   * Only includes skill dirs from enabled plugins.
   */
  getSkillSourceDefs(): SourceDef[] {
    const result: SourceDef[] = [];
    for (const source of this.enabledSourcesByDescPriority()) {
      const st = this.getSourceState(source.id);
      for (const plugin of this.findPlugins(source.localPath)) {
        const meta = this.readPluginJson(plugin.pluginJsonPath);
        const name = this.pluginName(meta, plugin.dir);
        if (st.plugins[name] !== true) continue;
        for (const dirName of ['skills', 'commands']) {
          const dir = path.join(plugin.dir, dirName);
          if (fs.existsSync(dir)) {
            result.push({
              dir,
              source: `marketplace:${source.name}`,
              sourceId: source.id,
            });
          }
        }
      }
    }
    return result;
  }

  /**
   * Extra dirs for PersonaRegistry.
   * Only includes subagent dirs from enabled plugins.
   */
  getSubagentDirs(): Array<{ dir: string; sourceId: string; sourceName: string }> {
    const result: Array<{ dir: string; sourceId: string; sourceName: string }> = [];
    for (const source of this.enabledSourcesByDescPriority()) {
      const st = this.getSourceState(source.id);
      for (const plugin of this.findPlugins(source.localPath)) {
        const meta = this.readPluginJson(plugin.pluginJsonPath);
        const name = this.pluginName(meta, plugin.dir);
        if (st.plugins[name] !== true) continue;
        for (const dirName of ['subagents', 'agents']) {
          const dir = path.join(plugin.dir, dirName);
          if (fs.existsSync(dir)) {
            result.push({ dir, sourceId: source.id, sourceName: source.name });
          }
        }
      }
    }
    return result;
  }

  /**
   * Expanded skill dirs for SemaCore's skillsExtraDirs list.
   * Accounts for per-source enabled state AND the global disabled set.
   */
  getSkillExtraDirs(globalDisabled: Set<string>): Array<{ dir: string; locate: SkillLocate }> {
    const result: Array<{ dir: string; locate: SkillLocate }> = [];
    for (const source of this.enabledSourcesByDescPriority()) {
      const st = this.getSourceState(source.id);
      for (const plugin of this.findPlugins(source.localPath)) {
        const meta = this.readPluginJson(plugin.pluginJsonPath);
        const name = this.pluginName(meta, plugin.dir);
        if (st.plugins[name] !== true) continue;
        for (const dirName of ['skills', 'commands']) {
          const dir = path.join(plugin.dir, dirName);
          if (fs.existsSync(dir)) {
            result.push(...expandSkillsDir(dir, 'managed', globalDisabled));
          }
        }
      }
    }
    return result;
  }

  /**
   * Paths to enabled marketplace hooks.json files.
   * Sorted DESCENDING by priority so highest priority hooks merge last.
   */
  getHookFiles(): string[] {
    const files: string[] = [];
    for (const source of this.enabledSourcesByDescPriority()) {
      const st = this.getSourceState(source.id);
      for (const plugin of this.findPlugins(source.localPath)) {
        const meta = this.readPluginJson(plugin.pluginJsonPath);
        const name = this.pluginName(meta, plugin.dir);
        if (st.plugins[name] !== true) continue;
        const hookFile = path.join(plugin.dir, 'hooks', 'hooks.json');
        if (fs.existsSync(hookFile)) files.push(hookFile);
      }
    }
    return files;
  }

  /**
   * Returns MCP server configs for all enabled plugins, with names prefixed `mkt__<pluginName>__<serverName>`.
   * Higher-priority sources processed last so they overwrite lower-priority same-name entries.
   */
  getMCPServerDefs(): MCPPluginServerDef[] {
    const result = new Map<string, MCPPluginServerDef>();
    for (const source of this.enabledSourcesByDescPriority()) {
      const st = this.getSourceState(source.id);
      for (const plugin of this.findPlugins(source.localPath)) {
        const meta = this.readPluginJson(plugin.pluginJsonPath);
        const name = this.pluginName(meta, plugin.dir);
        if (st.plugins[name] !== true) continue;
        for (const server of this.readPluginMCPConfig(plugin.dir)) {
          const useToolsKey = `${name}/${server.name}`;
          // User override takes precedence over plugin-defined useTools
          const userOverride = st.mcpUseTools?.[useToolsKey];
          const prefixed: MCPPluginServerDef = {
            ...server,
            name: `mkt__${name}__${server.name}`,
            ...(userOverride !== undefined ? { useTools: userOverride } : {}),
          };
          result.set(prefixed.name, prefixed);
        }
      }
    }
    return Array.from(result.values());
  }

  /** Set per-server useTools override for a marketplace plugin MCP server. null clears the override. */
  setMCPServerUseTools(sourceId: string, pluginName: string, serverName: string, useTools: string[] | null): void {
    const st = this.ensureSourceState(sourceId);
    if (!st.mcpUseTools) st.mcpUseTools = {};
    const key = `${pluginName}/${serverName}`;
    st.mcpUseTools[key] = useTools;
    this.saveState();
  }

  private readPluginMCPConfig(pluginDir: string): MCPPluginServerDef[] {
    // .mcp.json at plugin root — primary (Claude Code ecosystem format)
    const dotMcpJson = path.join(pluginDir, '.mcp.json');
    if (fs.existsSync(dotMcpJson)) {
      try {
        const data = JSON.parse(fs.readFileSync(dotMcpJson, 'utf-8')) as Record<string, unknown>;
        return this.parseDotMcpJson(data, pluginDir);
      } catch { return []; }
    }
    // mcp/mcp.json — semaclaw-specific format with explicit `servers` array
    const mcpFile = path.join(pluginDir, 'mcp', 'mcp.json');
    if (fs.existsSync(mcpFile)) {
      try {
        const data = JSON.parse(fs.readFileSync(mcpFile, 'utf-8')) as { servers?: MCPPluginServerDef[] };
        return Array.isArray(data.servers) ? data.servers : [];
      } catch { return []; }
    }
    return [];
  }

  /**
   * Parse `.mcp.json` in either format:
   *   Flat:   { "serverName": { command/url/type... } }
   *   Nested: { "mcpServers": { "serverName": { ... } } }
   *
   * Normalises `type` → `transport` and resolves ${CLAUDE_PLUGIN_ROOT}.
   * Other ${VAR} references (e.g. ${GITHUB_TOKEN}) are left intact.
   */
  private parseDotMcpJson(data: Record<string, unknown>, pluginDir: string): MCPPluginServerDef[] {
    // Detect nested format
    let serversObj: Record<string, unknown>;
    if (typeof data.mcpServers === 'object' && data.mcpServers !== null && !Array.isArray(data.mcpServers)) {
      serversObj = data.mcpServers as Record<string, unknown>;
    } else {
      serversObj = data;
    }

    const result: MCPPluginServerDef[] = [];
    for (const [name, cfg] of Object.entries(serversObj)) {
      if (typeof cfg !== 'object' || cfg === null || Array.isArray(cfg)) continue;
      const raw = cfg as Record<string, unknown>;

      // Resolve transport: `transport` field, then `type` field, then infer from shape
      const transportRaw = (raw.transport ?? raw.type) as string | undefined;
      let transport: 'stdio' | 'sse' | 'http';
      if (transportRaw === 'stdio' || transportRaw === 'sse' || transportRaw === 'http') {
        transport = transportRaw;
      } else if (raw.url) {
        transport = 'sse';
      } else {
        transport = 'stdio';
      }

      // Resolve ${CLAUDE_PLUGIN_ROOT} in args (leave other ${...} vars intact)
      const args = Array.isArray(raw.args)
        ? (raw.args as unknown[]).map(a =>
            typeof a === 'string' ? a.replace(/\$\{CLAUDE_PLUGIN_ROOT\}/g, pluginDir) : a
          )
        : undefined;

      const { type: _type, transport: _transport, args: _args, ...rest } = raw as Record<string, unknown> & { type?: unknown; transport?: unknown; args?: unknown };
      result.push({
        ...(rest as Partial<MCPPluginServerDef>),
        name,
        transport,
        ...(args !== undefined ? { args: args as string[] } : {}),
      });
    }
    return result;
  }

  // ── All plugins with state (for API) ─────────────────────────────────────────

  getItems(): MarketplaceSourceInfo[] {
    const sources = this.getSources(); // ascending priority
    const disabledSkills = readDisabledSkills();
    const disabledSubagents = readDisabledSubagents();
    const result: MarketplaceSourceInfo[] = [];

    for (const source of sources) {
      const st = this.getSourceState(source.id);
      const pluginDefs = this.findPlugins(source.localPath);
      const plugins: MarketplacePlugin[] = [];

      for (const pluginDef of pluginDefs) {
        const meta = this.readPluginJson(pluginDef.pluginJsonPath);
        const name = this.pluginName(meta, pluginDef.dir);
        const { skillCount, subagentCount, hasHooks, mcpServerCount } = this.countPluginContents(pluginDef.dir);
        const authorRaw = meta.author;
        const author = typeof authorRaw === 'string'
          ? authorRaw
          : typeof authorRaw === 'object' && authorRaw !== null
          ? (authorRaw as { name?: string }).name
          : undefined;

        const skills: MarketplacePluginSkill[] = this.scanPluginSkills(pluginDef.dir).map(s => ({
          ...s,
          disabled: disabledSkills.has(s.name),
        }));
        const subagents: MarketplacePluginSubagent[] = this.scanPluginSubagents(pluginDef.dir).map(s => ({
          ...s,
          disabled: disabledSubagents.has(s.name),
        }));

        const mcpServers = this.readPluginMCPConfig(pluginDef.dir).map(s => {
          const useToolsKey = `${name}/${s.name}`;
          const userOverride = st.mcpUseTools?.[useToolsKey];
          return {
            name: s.name,
            transport: s.transport,
            description: s.description,
            useTools: userOverride !== undefined ? userOverride : (s.useTools ?? null),
          };
        });

        plugins.push({
          name,
          description: meta.description ?? '',
          version: meta.version,
          author,
          keywords: meta.keywords,
          dir: pluginDef.dir,
          sourceId: source.id,
          sourceName: source.name,
          priority: source.priority,
          enabled: st.plugins[name] === true,
          skillCount,
          subagentCount,
          hasHooks,
          mcpServerCount,
          skills,
          subagents,
          mcpServers,
        });
      }

      result.push({ ...source, plugins });
    }
    return result;
  }

  // ── Private helpers ──────────────────────────────────────────────────────────

  private enabledSourcesByDescPriority(): MarketplaceSource[] {
    return this.config.sources
      .filter(s => s.enabled)
      .sort((a, b) => b.priority - a.priority);
  }

  /**
   * Resolve plugin.json path for a given directory.
   * .semaclaw-plugin takes priority over .claude-plugin when both exist.
   */
  private resolvePluginJson(dir: string): string | null {
    const primary = path.join(dir, '.semaclaw-plugin', 'plugin.json');
    if (fs.existsSync(primary)) return primary;
    const fallback = path.join(dir, '.claude-plugin', 'plugin.json');
    if (fs.existsSync(fallback)) return fallback;
    return null;
  }

  /**
   * Find all plugin directories in a source root.
   * Handles three layouts:
   *   1. Root-is-plugin: source root itself has a plugin.json
   *   2. Flat: source root contains plugin subdirs directly (external_plugins/discord/)
   *   3. Grouped: source root contains group dirs, each containing plugin subdirs (plugins/code-review/)
   * Config dir priority: .semaclaw-plugin > .claude-plugin
   */
  private findPlugins(localPath: string): PluginDef[] {
    if (!fs.existsSync(localPath)) return [];
    const results: PluginDef[] = [];

    // Layout 1: the source root itself is the plugin
    const rootPluginJson = this.resolvePluginJson(localPath);
    if (rootPluginJson) {
      return [{ dir: localPath, pluginJsonPath: rootPluginJson }];
    }

    let topEntries: string[];
    try { topEntries = fs.readdirSync(localPath); } catch { return results; }

    for (const entry of topEntries) {
      if (entry.startsWith('.')) continue;
      const entryPath = path.join(localPath, entry);
      try {
        if (!fs.statSync(entryPath).isDirectory()) continue;
      } catch { continue; }

      const pluginJson = this.resolvePluginJson(entryPath);
      if (pluginJson) {
        results.push({ dir: entryPath, pluginJsonPath: pluginJson });
        continue; // don't recurse into a plugin dir
      }

      // One level deeper
      let subEntries: string[];
      try { subEntries = fs.readdirSync(entryPath); } catch { continue; }
      for (const sub of subEntries) {
        if (sub.startsWith('.')) continue;
        const subPath = path.join(entryPath, sub);
        try {
          if (!fs.statSync(subPath).isDirectory()) continue;
        } catch { continue; }
        const subPluginJson = this.resolvePluginJson(subPath);
        if (subPluginJson) {
          results.push({ dir: subPath, pluginJsonPath: subPluginJson });
        }
      }
    }

    return results;
  }

  private readPluginJson(p: string): PluginJson {
    try {
      return JSON.parse(fs.readFileSync(p, 'utf-8')) as PluginJson;
    } catch { return {}; }
  }

  private pluginName(meta: PluginJson, dir: string): string {
    return meta.name || path.basename(dir);
  }

  private countPluginContents(dir: string): { skillCount: number; subagentCount: number; hasHooks: boolean; mcpServerCount: number } {
    let skillCount = 0;
    let subagentCount = 0;

    // Skills: subdirs with SKILL.md (in skills/) or flat .md files (in commands/)
    for (const skillsDirName of ['skills', 'commands']) {
      const skillsDir = path.join(dir, skillsDirName);
      if (!fs.existsSync(skillsDir)) continue;
      try {
        const entries = fs.readdirSync(skillsDir);
        if (skillsDirName === 'skills') {
          // SKILL.md in subdirectory format
          for (const entry of entries) {
            if (entry.startsWith('.')) continue;
            const entryPath = path.join(skillsDir, entry);
            try {
              if (fs.statSync(entryPath).isDirectory()) {
                const hasSKILL = ['SKILL.md', 'skill.md', 'Skill.md'].some(n => fs.existsSync(path.join(entryPath, n)));
                if (hasSKILL) skillCount++;
              }
            } catch { continue; }
          }
        } else {
          // commands/: count flat .md files
          skillCount += entries.filter(e => e.endsWith('.md') && !e.startsWith('.')).length;
        }
      } catch { continue; }
    }

    // Subagents: .md files in subagents/ or agents/
    for (const subDirName of ['subagents', 'agents']) {
      const subDir = path.join(dir, subDirName);
      if (!fs.existsSync(subDir)) continue;
      try {
        const entries = fs.readdirSync(subDir);
        subagentCount += entries.filter(e => e.endsWith('.md') && !e.startsWith('.')).length;
      } catch { continue; }
    }

    const hasHooks = fs.existsSync(path.join(dir, 'hooks', 'hooks.json'));
    const mcpServerCount = this.readPluginMCPConfig(dir).length;
    return { skillCount, subagentCount, hasHooks, mcpServerCount };
  }

  /** Returns skill name+description for all skills in a plugin dir. */
  private scanPluginSkills(pluginDir: string): Array<{ name: string; description: string }> {
    const result: Array<{ name: string; description: string }> = [];
    // skills/: SKILL.md subdir format
    const skillsDir = path.join(pluginDir, 'skills');
    if (fs.existsSync(skillsDir)) {
      for (const e of scanSource({ dir: skillsDir, source: 'marketplace' })) {
        result.push({ name: e.name, description: e.description });
      }
    }
    // commands/: flat .md files
    const commandsDir = path.join(pluginDir, 'commands');
    if (fs.existsSync(commandsDir)) {
      try {
        for (const file of fs.readdirSync(commandsDir)) {
          if (!file.endsWith('.md') || file.startsWith('.')) continue;
          try {
            const content = fs.readFileSync(path.join(commandsDir, file), 'utf-8');
            const fm = parseSubagentFrontmatter(content);
            result.push({ name: fm.name || path.basename(file, '.md'), description: fm.description || '' });
          } catch { continue; }
        }
      } catch { /* ignore */ }
    }
    return result;
  }

  /** Returns subagent name+description for all subagents in a plugin dir. */
  private scanPluginSubagents(pluginDir: string): Array<{ name: string; description: string }> {
    const result: Array<{ name: string; description: string }> = [];
    for (const dirName of ['subagents', 'agents']) {
      for (const e of this.scanSubagentDir(path.join(pluginDir, dirName))) {
        result.push({ name: e.name, description: e.description });
      }
    }
    return result;
  }

  private scanSubagentDir(dir: string): Array<{ name: string; description: string; filePath: string }> {
    if (!fs.existsSync(dir)) return [];
    const result: Array<{ name: string; description: string; filePath: string }> = [];
    try {
      for (const file of fs.readdirSync(dir)) {
        if (!file.endsWith('.md') || file.startsWith('.')) continue;
        const filePath = path.join(dir, file);
        try {
          const raw = fs.readFileSync(filePath, 'utf-8');
          const fm = parseSubagentFrontmatter(raw);
          if (fm.description) {
            result.push({ name: fm.name || path.basename(file, '.md'), description: fm.description, filePath });
          }
        } catch { continue; }
      }
    } catch { /* dir not readable */ }
    return result;
  }

  private loadConfig(): void {
    try {
      if (fs.existsSync(MARKETPLACE_CONFIG_PATH)) {
        this.config = JSON.parse(fs.readFileSync(MARKETPLACE_CONFIG_PATH, 'utf-8')) as MarketplaceConfig;
      }
    } catch { this.config = { sources: [] }; }
  }

  private saveConfig(): void {
    fs.mkdirSync(SEMACLAW_DIR, { recursive: true });
    fs.writeFileSync(MARKETPLACE_CONFIG_PATH, JSON.stringify(this.config, null, 2) + '\n', 'utf-8');
  }

  private loadState(): void {
    try {
      if (fs.existsSync(MARKETPLACE_STATE_PATH)) {
        this.state = JSON.parse(fs.readFileSync(MARKETPLACE_STATE_PATH, 'utf-8')) as MarketplaceStateFile;
      }
    } catch { this.state = {}; }
  }

  private saveState(): void {
    fs.mkdirSync(SEMACLAW_DIR, { recursive: true });
    fs.writeFileSync(MARKETPLACE_STATE_PATH, JSON.stringify(this.state, null, 2) + '\n', 'utf-8');
  }
}

let _instance: MarketplaceManager | null = null;

export function getMarketplaceManager(): MarketplaceManager {
  if (!_instance) _instance = new MarketplaceManager();
  return _instance;
}
