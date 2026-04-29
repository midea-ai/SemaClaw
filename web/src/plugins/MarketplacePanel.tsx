/**
 * MarketplacePanel — 插件市场管理页面
 *
 * 左侧：来源列表（local/git，优先级排序，同步按钮）
 * 右侧：来源内的 plugin 卡片，插件级开关 + 批量操作
 */

import { useState, useEffect, useCallback, useRef } from 'react';

// ─── 类型 ─────────────────────────────────────────────────────────────────────

interface MarketplaceSource {
  id: string;
  name: string;
  type: 'git' | 'local';
  url?: string;
  branch?: string;
  localPath: string;
  priority: number;
  enabled: boolean;
  lastSynced: string | null;
  syncError?: string;
}

interface PluginSkill { name: string; description: string; disabled: boolean }
interface PluginSubagent { name: string; description: string; disabled: boolean }
interface PluginMCPServer { name: string; transport: string; description?: string; useTools: string[] | null }

interface MarketplacePlugin {
  name: string;
  description: string;
  version?: string;
  author?: string;
  keywords?: string[];
  dir: string;
  sourceId: string;
  sourceName: string;
  priority: number;
  enabled: boolean;
  skillCount: number;
  subagentCount: number;
  hasHooks: boolean;
  mcpServerCount: number;
  skills: PluginSkill[];
  subagents: PluginSubagent[];
  mcpServers: PluginMCPServer[];
}

interface SourceInfo extends MarketplaceSource {
  plugins: MarketplacePlugin[];
}

// ─── 工具 ─────────────────────────────────────────────────────────────────────

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, init);
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(text || `HTTP ${res.status}`);
  }
  return res.json() as Promise<T>;
}

function jsonPost(path: string, body?: unknown) {
  return api(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
}

// ─── 小组件 ───────────────────────────────────────────────────────────────────

function Toggle({ checked, onChange, disabled }: { checked: boolean; onChange: () => void; disabled?: boolean }) {
  return (
    <button
      onClick={e => { e.stopPropagation(); onChange(); }}
      disabled={disabled}
      className={`relative inline-flex h-5 w-9 flex-shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors duration-150 focus:outline-none ${
        checked ? 'bg-purple-500' : 'bg-gray-200'
      } ${disabled ? 'opacity-40 cursor-not-allowed' : ''}`}
      role="switch"
      aria-checked={checked}
    >
      <span className={`pointer-events-none inline-block h-4 w-4 transform rounded-full bg-white shadow ring-0 transition duration-150 ${checked ? 'translate-x-4' : 'translate-x-0'}`} />
    </button>
  );
}

function SyncIcon({ spinning }: { spinning: boolean }) {
  return (
    <svg className={`w-3.5 h-3.5 ${spinning ? 'animate-spin' : ''}`} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
      <path strokeLinecap="round" strokeLinejoin="round" d="M16.023 9.348h4.992v-.001M2.985 19.644v-4.992m0 0h4.992m-4.993 0 3.181 3.183a8.25 8.25 0 0 0 13.803-3.7M4.031 9.865a8.25 8.25 0 0 1 13.803-3.7l3.181 3.182m0-4.991v4.99" />
    </svg>
  );
}

// ─── Add Source Modal ──────────────────────────────────────────────────────────

function AddSourceModal({ onClose, onAdded }: { onClose: () => void; onAdded: () => void }) {
  const [type, setType] = useState<'local' | 'git'>('local');
  const [name, setName] = useState('');
  const [localPath, setLocalPath] = useState('');
  const [url, setUrl] = useState('');
  const [branch, setBranch] = useState('main');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const submit = async () => {
    if (!name.trim()) { setError('Name is required'); return; }
    if (type === 'local' && !localPath.trim()) { setError('Local path is required'); return; }
    if (type === 'git' && !url.trim()) { setError('Git URL is required'); return; }
    setLoading(true);
    setError('');
    try {
      await jsonPost('/api/marketplace/sources', { name: name.trim(), type, localPath: localPath.trim() || undefined, url: url.trim() || undefined, branch: branch.trim() || 'main' });
      onAdded();
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/30">
      <div className="bg-white rounded-xl shadow-xl w-full max-w-md mx-4 p-6">
        <h3 className="text-base font-semibold text-gray-800 mb-4">Add Marketplace Source</h3>

        <div className="flex gap-2 mb-4">
          {(['local', 'git'] as const).map(t => (
            <button
              key={t}
              onClick={() => setType(t)}
              className={`flex-1 py-2 rounded-lg text-sm font-medium transition-colors border ${
                type === t ? 'bg-violet-50 border-violet-300 text-violet-700' : 'bg-white border-gray-200 text-gray-600 hover:bg-gray-50'
              }`}
            >
              {t === 'local' ? 'Local Folder' : 'Git Repository'}
            </button>
          ))}
        </div>

        <div className="space-y-3">
          <div>
            <label className="block text-xs font-medium text-gray-600 mb-1">Name</label>
            <input
              value={name} onChange={e => setName(e.target.value)}
              placeholder="My Plugins"
              className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-violet-300"
            />
          </div>

          {type === 'local' ? (
            <div>
              <label className="block text-xs font-medium text-gray-600 mb-1">Local Path</label>
              <input
                value={localPath} onChange={e => setLocalPath(e.target.value)}
                placeholder="/Users/me/my-plugins"
                className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm font-mono focus:outline-none focus:ring-2 focus:ring-violet-300"
              />
            </div>
          ) : (
            <>
              <div>
                <label className="block text-xs font-medium text-gray-600 mb-1">Git URL</label>
                <input
                  value={url} onChange={e => setUrl(e.target.value)}
                  placeholder="https://github.com/org/repo"
                  className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm font-mono focus:outline-none focus:ring-2 focus:ring-violet-300"
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-gray-600 mb-1">Branch</label>
                <input
                  value={branch} onChange={e => setBranch(e.target.value)}
                  className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-violet-300"
                />
              </div>
            </>
          )}
        </div>

        {error && <p className="mt-3 text-xs text-red-500">{error}</p>}

        <div className="flex gap-2 mt-5">
          <button onClick={onClose} className="flex-1 py-2 rounded-lg border border-gray-200 text-sm text-gray-600 hover:bg-gray-50">Cancel</button>
          <button
            onClick={submit} disabled={loading}
            className="flex-1 py-2 rounded-lg bg-violet-500 text-white text-sm font-medium hover:bg-violet-600 disabled:opacity-50"
          >
            {loading ? 'Adding…' : 'Add Source'}
          </button>
        </div>
      </div>
    </div>
  );
}

// ─── Sub-item row ─────────────────────────────────────────────────────────────

function SubItemRow({
  name,
  description,
  enabled,
  parentEnabled,
  onToggle,
  type,
}: {
  name: string;
  description: string;
  enabled: boolean;
  parentEnabled: boolean;
  onToggle: (enabled: boolean) => void;
  type: 'skill' | 'subagent';
}) {
  const iconColor = type === 'skill' ? 'text-violet-400' : 'text-blue-400';
  return (
    <div className={`flex items-center gap-3 pl-10 pr-4 py-2 ${!parentEnabled ? 'opacity-40' : ''}`}>
      <span className={`flex-shrink-0 ${iconColor}`}>
        {type === 'skill' ? (
          <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" d="M3.75 13.5l10.5-11.25L12 10.5h8.25L9.75 21.75 12 13.5H3.75z" />
          </svg>
        ) : (
          <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" d="M15.75 6a3.75 3.75 0 1 1-7.5 0 3.75 3.75 0 0 1 7.5 0ZM4.501 20.118a7.5 7.5 0 0 1 14.998 0A17.933 17.933 0 0 1 12 21.75c-2.676 0-5.216-.584-7.499-1.632Z" />
          </svg>
        )}
      </span>
      <div className="flex-1 min-w-0">
        <span className="text-xs font-medium text-gray-700">{name}</span>
        {description && <p className="text-[11px] text-gray-400 truncate">{description}</p>}
      </div>
      <Toggle
        checked={enabled}
        onChange={() => onToggle(!enabled)}
        disabled={!parentEnabled}
      />
    </div>
  );
}

// ─── Plugin Card ──────────────────────────────────────────────────────────────

type MCPConnStatus = 'connected' | 'connecting' | 'error' | 'disconnected';

function MCPStatusDot({ status }: { status: MCPConnStatus | undefined }) {
  if (!status) return null;
  const colors: Record<MCPConnStatus, string> = {
    connected: 'bg-green-400',
    connecting: 'bg-yellow-400 animate-pulse',
    error: 'bg-red-400',
    disconnected: 'bg-gray-300',
  };
  const labels: Record<MCPConnStatus, string> = {
    connected: 'Connected',
    connecting: 'Connecting…',
    error: 'Connection error',
    disconnected: 'Disconnected',
  };
  return (
    <span className="flex items-center gap-1" title={labels[status]}>
      <span className={`inline-block w-1.5 h-1.5 rounded-full flex-shrink-0 ${colors[status]}`} />
      <span className="text-[10px] text-gray-400">{labels[status]}</span>
    </span>
  );
}

function MCPServerRow({
  server,
  sourceId,
  pluginName,
  pluginEnabled,
  connStatus,
  availableTools,
  onReload,
}: {
  server: PluginMCPServer;
  sourceId: string;
  pluginName: string;
  pluginEnabled: boolean;
  connStatus?: MCPConnStatus;
  availableTools?: { name: string; description?: string }[];
  onReload: () => void;
}) {
  const [savingTool, setSavingTool] = useState<string | null>(null);

  const hasTools = availableTools && availableTools.length > 0;

  function isEnabled(toolName: string) {
    return server.useTools === null || server.useTools.includes(toolName);
  }

  async function saveUseTools(useTools: string[] | null) {
    await api(`/api/marketplace/sources/${sourceId}/plugins/${encodeURIComponent(pluginName)}/mcp/${encodeURIComponent(server.name)}/use-tools`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ useTools }),
    });
    onReload();
  }

  async function toggleTool(toolName: string) {
    setSavingTool(toolName);
    try {
      const total = availableTools!.length;
      let next: string[] | null;
      if (server.useTools === null) {
        // all enabled → disable just this one
        next = availableTools!.map(t => t.name).filter(n => n !== toolName);
      } else if (server.useTools.includes(toolName)) {
        // disable it
        const removed = server.useTools.filter(n => n !== toolName);
        next = removed.length === total ? null : removed;
      } else {
        // enable it
        const added = [...server.useTools, toolName];
        next = added.length === total ? null : added;
      }
      await saveUseTools(next);
    } finally {
      setSavingTool(null);
    }
  }

  async function toggleAll() {
    const allEnabled = server.useTools === null;
    await saveUseTools(allEnabled ? [] : null);
  }

  const enabledCount = hasTools
    ? (server.useTools === null ? availableTools!.length : server.useTools.filter(n => availableTools!.some(t => t.name === n)).length)
    : 0;

  return (
    <div className="pl-10 pr-4 py-1.5">
      {/* Server header */}
      <div className="flex items-center gap-1.5 flex-wrap mb-1">
        <svg className="w-3.5 h-3.5 text-blue-400 flex-shrink-0" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor">
          <path strokeLinecap="round" strokeLinejoin="round" d="M14.25 9.75 16.5 12l-2.25 2.25m-4.5 0L7.5 12l2.25-2.25M6 20.25h12A2.25 2.25 0 0 0 20.25 18V6A2.25 2.25 0 0 0 18 3.75H6A2.25 2.25 0 0 0 3.75 6v12A2.25 2.25 0 0 0 6 20.25Z" />
        </svg>
        <span className={`text-[11px] font-medium ${pluginEnabled ? 'text-gray-600' : 'text-gray-400'}`}>{server.name}</span>
        <span className="text-[10px] font-mono text-blue-500 bg-blue-50 border border-blue-100 rounded px-1 py-0.5">{server.transport}</span>
        <MCPStatusDot status={connStatus} />
        {hasTools && (
          <span className="text-[10px] text-gray-400 ml-auto">{enabledCount}/{availableTools!.length} tools</span>
        )}
      </div>
      {server.description && (
        <p className="text-[11px] text-gray-400 mb-1 pl-5">{server.description}</p>
      )}

      {/* Tool list */}
      {hasTools ? (
        <div className="pl-5 space-y-0.5">
          {/* Select-all row */}
          <label className="flex items-center gap-2 py-0.5 cursor-pointer group">
            <input
              type="checkbox"
              checked={server.useTools === null}
              onChange={() => void toggleAll()}
              disabled={!!savingTool}
              className="w-3 h-3 rounded accent-violet-500 cursor-pointer"
            />
            <span className="text-[11px] font-medium text-gray-500 group-hover:text-gray-700">All tools</span>
          </label>
          <div className="border-t border-gray-100 pt-0.5">
            {availableTools!.map(tool => (
              <label key={tool.name} className="flex items-start gap-2 py-0.5 cursor-pointer group">
                <input
                  type="checkbox"
                  checked={isEnabled(tool.name)}
                  onChange={() => void toggleTool(tool.name)}
                  disabled={savingTool === tool.name}
                  className="w-3 h-3 rounded accent-violet-500 mt-0.5 flex-shrink-0 cursor-pointer"
                />
                <span className="min-w-0">
                  <span className={`text-[11px] font-mono ${savingTool === tool.name ? 'text-gray-300' : isEnabled(tool.name) ? 'text-gray-600' : 'text-gray-300'}`}>
                    {tool.name}
                  </span>
                  {tool.description && (
                    <span className="text-[10px] text-gray-400 ml-1.5">{tool.description}</span>
                  )}
                </span>
              </label>
            ))}
          </div>
        </div>
      ) : (
        <div className="pl-5 text-[10px] text-gray-400 italic">
          {connStatus === 'connecting' ? 'Loading tools…' : connStatus === 'connected' ? 'No tools' : 'Connect to see tools'}
        </div>
      )}
    </div>
  );
}

function PluginCard({
  plugin,
  onToggle,
  onToggleSkill,
  onToggleSubagent,
  mcpStatus,
  onReload,
}: {
  plugin: MarketplacePlugin;
  onToggle: (plugin: MarketplacePlugin, enabled: boolean) => void;
  onToggleSkill: (name: string, enabled: boolean) => Promise<void>;
  onToggleSubagent: (name: string, enabled: boolean) => Promise<void>;
  mcpStatus: Record<string, { status: string; error?: string; tools?: { name: string; description?: string }[] }>;
  onReload: () => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const hasSubItems = plugin.skills.length > 0 || plugin.subagents.length > 0 || plugin.hasHooks || plugin.mcpServers.length > 0;

  const contentParts: string[] = [];
  if (plugin.skillCount > 0) contentParts.push(`${plugin.skillCount} skill${plugin.skillCount !== 1 ? 's' : ''}`);
  if (plugin.subagentCount > 0) contentParts.push(`${plugin.subagentCount} subagent${plugin.subagentCount !== 1 ? 's' : ''}`);
  if (plugin.hasHooks) contentParts.push('hooks');
  if (plugin.mcpServerCount > 0) contentParts.push(`${plugin.mcpServerCount} MCP server${plugin.mcpServerCount !== 1 ? 's' : ''}`);
  const contentSummary = contentParts.length > 0 ? contentParts.join(' · ') : 'No content';

  return (
    <div className="border-b border-gray-50">
      {/* Header row */}
      <div
        className={`flex items-start gap-3 px-4 py-3.5 transition-colors ${hasSubItems ? 'cursor-pointer hover:bg-gray-50/60' : ''}`}
        onClick={() => hasSubItems && setExpanded(e => !e)}
      >
        {/* Expand chevron */}
        <div className="flex-shrink-0 mt-1 w-4">
          {hasSubItems && (
            <svg
              className={`w-3.5 h-3.5 text-gray-300 transition-transform ${expanded ? 'rotate-90' : ''}`}
              fill="none" viewBox="0 0 24 24" strokeWidth={2.5} stroke="currentColor"
            >
              <path strokeLinecap="round" strokeLinejoin="round" d="m8.25 4.5 7.5 7.5-7.5 7.5" />
            </svg>
          )}
        </div>

        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-sm font-medium text-gray-800">{plugin.name}</span>
            {plugin.version && (
              <span className="text-[10px] text-gray-400 font-mono">v{plugin.version}</span>
            )}
          </div>
          {plugin.description && (
            <p className="text-xs text-gray-500 mt-0.5 line-clamp-2">{plugin.description}</p>
          )}
          <div className="flex items-center gap-3 mt-1">
            <span className="text-[11px] text-gray-400">{contentSummary}</span>
            {plugin.author && (
              <span className="text-[11px] text-gray-300">by {plugin.author}</span>
            )}
          </div>
          {plugin.keywords && plugin.keywords.length > 0 && (
            <div className="flex flex-wrap gap-1 mt-1.5">
              {plugin.keywords.slice(0, 4).map(kw => (
                <span key={kw} className="text-[10px] bg-gray-100 text-gray-500 px-1.5 py-0.5 rounded">{kw}</span>
              ))}
            </div>
          )}
        </div>

        <Toggle
          checked={plugin.enabled}
          onChange={() => onToggle(plugin, !plugin.enabled)}
        />
      </div>

      {/* Sub-items (expanded) */}
      {expanded && hasSubItems && (
        <div className="bg-gray-50/50 border-t border-gray-50 pb-1">
          {plugin.skills.length > 0 && (
            <>
              <div className="px-4 pt-2 pb-1">
                <span className="text-[10px] font-semibold text-gray-400 uppercase tracking-wider">Skills</span>
              </div>
              {plugin.skills.map(skill => (
                <SubItemRow
                  key={skill.name}
                  name={skill.name}
                  description={skill.description}
                  enabled={!skill.disabled}
                  parentEnabled={plugin.enabled}
                  onToggle={en => void onToggleSkill(skill.name, en)}
                  type="skill"
                />
              ))}
            </>
          )}
          {plugin.subagents.length > 0 && (
            <>
              <div className="px-4 pt-2 pb-1">
                <span className="text-[10px] font-semibold text-gray-400 uppercase tracking-wider">Subagents</span>
              </div>
              {plugin.subagents.map(sa => (
                <SubItemRow
                  key={sa.name}
                  name={sa.name}
                  description={sa.description}
                  enabled={!sa.disabled}
                  parentEnabled={plugin.enabled}
                  onToggle={en => void onToggleSubagent(sa.name, en)}
                  type="subagent"
                />
              ))}
            </>
          )}
          {plugin.hasHooks && (
            <div className="flex items-center gap-2 pl-10 pr-4 py-2">
              <svg className="w-3.5 h-3.5 text-amber-400 flex-shrink-0" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" d="M17.25 6.75 22.5 12l-5.25 5.25m-10.5 0L1.5 12l5.25-5.25m7.5-3-4.5 16.5" />
              </svg>
              <span className="text-[11px] text-gray-400">Hooks config — active when plugin is enabled</span>
            </div>
          )}
          {plugin.mcpServers.length > 0 && (
            <>
              <div className="px-4 pt-2 pb-1">
                <span className="text-[10px] font-semibold text-gray-400 uppercase tracking-wider">MCP Servers</span>
              </div>
              {plugin.mcpServers.map(server => {
                const statusKey = `mkt__${plugin.name}__${server.name}`;
                const statusEntry = mcpStatus[statusKey];
                return (
                  <MCPServerRow
                    key={server.name}
                    server={server}
                    sourceId={plugin.sourceId}
                    pluginName={plugin.name}
                    pluginEnabled={plugin.enabled}
                    connStatus={statusEntry?.status as MCPConnStatus | undefined}
                    availableTools={statusEntry?.tools}
                    onReload={onReload}
                  />
                );
              })}
            </>
          )}
        </div>
      )}
    </div>
  );
}

// ─── Sources Sidebar ──────────────────────────────────────────────────────────

function SourcesSidebar({
  sources,
  selected,
  onSelect,
  onAdd,
  onSync,
  onDelete,
  onReorder,
  syncingId,
}: {
  sources: MarketplaceSource[];
  selected: string | null;
  onSelect: (id: string) => void;
  onAdd: () => void;
  onSync: (id: string) => void;
  onDelete: (id: string) => void;
  onReorder: (id: string, dir: 'up' | 'down') => void;
  syncingId: string | null;
}) {
  return (
    <div className="w-56 border-r border-gray-100 flex flex-col flex-shrink-0">
      <div className="px-3 py-2.5 border-b border-gray-100 flex items-center justify-between">
        <span className="text-xs font-semibold text-gray-500 uppercase tracking-wide">Sources</span>
        <button
          onClick={onAdd}
          className="text-violet-500 hover:text-violet-700 transition-colors"
          title="Add source"
        >
          <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M12 4.5v15m7.5-7.5h-15" />
          </svg>
        </button>
      </div>

      <div className="flex-1 overflow-y-auto py-1">
        {sources.length === 0 && (
          <div className="px-4 py-6 text-center">
            <p className="text-xs text-gray-400">No sources yet</p>
            <button onClick={onAdd} className="mt-2 text-xs text-violet-500 hover:underline">Add one</button>
          </div>
        )}
        {sources.map((src, idx) => (
          <div
            key={src.id}
            onClick={() => onSelect(src.id)}
            className={`group flex items-center gap-2 px-3 py-2 cursor-pointer transition-colors ${
              selected === src.id ? 'bg-violet-50' : 'hover:bg-gray-50'
            }`}
          >
            <span className={`flex-shrink-0 ${src.type === 'git' ? 'text-lime-950' : 'text-blue-400'}`}>
              {src.type === 'git' ? (
                <svg className="w-3.5 h-3.5" fill="currentColor" viewBox="0 0 24 24">
                  <path d="M12 0C5.37 0 0 5.373 0 12c0 5.303 3.438 9.8 8.205 11.385.6.113.82-.258.82-.577 0-.285-.01-1.04-.015-2.04-3.338.724-4.042-1.61-4.042-1.61C4.422 18.07 3.633 17.7 3.633 17.7c-1.087-.744.084-.729.084-.729 1.205.084 1.838 1.236 1.838 1.236 1.07 1.835 2.809 1.305 3.495.998.108-.776.417-1.305.76-1.605-2.665-.3-5.466-1.332-5.466-5.93 0-1.31.465-2.38 1.235-3.22-.135-.303-.54-1.523.105-3.176 0 0 1.005-.322 3.3 1.23.96-.267 1.98-.399 3-.405 1.02.006 2.04.138 3 .405 2.28-1.552 3.285-1.23 3.285-1.23.645 1.653.24 2.873.12 3.176.765.84 1.23 1.91 1.23 3.22 0 4.61-2.805 5.625-5.475 5.92.42.36.81 1.096.81 2.22 0 1.606-.015 2.896-.015 3.286 0 .315.21.69.825.57C20.565 21.795 24 17.298 24 12c0-6.627-5.373-12-12-12"/>
                </svg>
              ) : (
                <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.8}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M2.25 12.75V12A2.25 2.25 0 0 1 4.5 9.75h15A2.25 2.25 0 0 1 21.75 12v.75m-8.69-6.44-2.12-2.12a1.5 1.5 0 0 0-1.061-.44H4.5A2.25 2.25 0 0 0 2.25 6v8.25A2.25 2.25 0 0 0 4.5 16.5h15a2.25 2.25 0 0 0 2.25-2.25V10.5a2.25 2.25 0 0 0-2.25-2.25H15.75" />
                </svg>
              )}
            </span>

            <div className="flex-1 min-w-0">
              <div className={`text-xs font-medium truncate ${selected === src.id ? 'text-violet-700' : 'text-gray-700'}`}>{src.name}</div>
              {src.syncError && <div className="text-[10px] text-red-400 truncate">Sync error</div>}
            </div>

            <span className="text-[10px] text-gray-300 flex-shrink-0">#{src.priority}</span>

            <div className="flex items-center gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity flex-shrink-0">
              <button
                onClick={e => { e.stopPropagation(); onReorder(src.id, 'up'); }}
                disabled={idx === 0}
                className="p-0.5 text-gray-400 hover:text-gray-600 disabled:opacity-20"
                title="Increase priority"
              >
                <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="m4.5 15.75 7.5-7.5 7.5 7.5" />
                </svg>
              </button>
              <button
                onClick={e => { e.stopPropagation(); onReorder(src.id, 'down'); }}
                disabled={idx === sources.length - 1}
                className="p-0.5 text-gray-400 hover:text-gray-600 disabled:opacity-20"
                title="Decrease priority"
              >
                <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="m19.5 8.25-7.5 7.5-7.5-7.5" />
                </svg>
              </button>
              <button
                onClick={e => { e.stopPropagation(); onSync(src.id); }}
                className="p-0.5 text-gray-400 hover:text-lime-600"
                title="Sync"
              >
                <SyncIcon spinning={syncingId === src.id} />
              </button>
              <button
                onClick={e => { e.stopPropagation(); onDelete(src.id); }}
                className="p-0.5 text-gray-400 hover:text-red-500"
                title="Remove source"
              >
                <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M6 18 18 6M6 6l12 12" />
                </svg>
              </button>
            </div>
          </div>
        ))}
      </div>

    </div>
  );
}

// ─── Main Panel ───────────────────────────────────────────────────────────────

export function MarketplacePanel() {
  const [sources, setSources] = useState<MarketplaceSource[]>([]);
  const [sourcePlugins, setSourcePlugins] = useState<Record<string, MarketplacePlugin[]>>({});
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [showAdd, setShowAdd] = useState(false);
  const [syncingId, setSyncingId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [mcpStatus, setMcpStatus] = useState<Record<string, { status: string; error?: string; tools?: { name: string; description?: string }[] }>>({});
  const mcpPollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const loadData = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const { sources: srcs } = await api<{ sources: SourceInfo[] }>('/api/marketplace/items');
      setSources(srcs);
      const pluginsMap: Record<string, MarketplacePlugin[]> = {};
      for (const src of srcs) pluginsMap[src.id] = src.plugins;
      setSourcePlugins(pluginsMap);
      if (!selectedId && srcs.length > 0) setSelectedId(srcs[0].id);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [selectedId]);

  useEffect(() => { void loadData(); }, []);

  useEffect(() => {
    const fetchStatus = () => {
      api<Record<string, { status: string; error?: string; tools?: { name: string; description?: string }[] }>>('/api/marketplace/mcp-status')
        .then(setMcpStatus)
        .catch(() => {/* ignore */});
    };
    fetchStatus();
    mcpPollRef.current = setInterval(fetchStatus, 5000);
    return () => { if (mcpPollRef.current) clearInterval(mcpPollRef.current); };
  }, []);

  const handleSync = async (id: string) => {
    setSyncingId(id);
    try {
      await jsonPost(`/api/marketplace/sources/${id}/sync`);
      await loadData();
    } catch (e) {
      setError(`Sync failed: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setSyncingId(null);
    }
  };

  const handleDelete = async (id: string) => {
    if (!confirm('Remove this marketplace source?')) return;
    try {
      await api(`/api/marketplace/sources/${id}`, { method: 'DELETE' });
      if (selectedId === id) setSelectedId(null);
      await loadData();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const handleReorder = async (id: string, dir: 'up' | 'down') => {
    const sorted = [...sources];
    const idx = sorted.findIndex(s => s.id === id);
    if (idx === -1) return;
    const target = dir === 'up' ? idx - 1 : idx + 1;
    if (target < 0 || target >= sorted.length) return;
    [sorted[idx], sorted[target]] = [sorted[target], sorted[idx]];
    setSources(sorted);
    try {
      await jsonPost('/api/marketplace/sources/reorder', { orderedIds: sorted.map(s => s.id) });
      await loadData();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const handleTogglePlugin = async (plugin: MarketplacePlugin, enabled: boolean) => {
    try {
      await jsonPost(
        `/api/marketplace/sources/${plugin.sourceId}/plugins/${encodeURIComponent(plugin.name)}/toggle`,
        { enabled }
      );
      await loadData();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const handleToggleSkill = async (name: string, enabled: boolean) => {
    try {
      await jsonPost(`/api/skills/${encodeURIComponent(name)}/${enabled ? 'enable' : 'disable'}`);
      await loadData();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const handleToggleSubagent = async (name: string, enabled: boolean) => {
    try {
      await jsonPost(`/api/subagents/${encodeURIComponent(name)}/${enabled ? 'enable' : 'disable'}`);
      await loadData();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const handleEnableAll = async (sourceId: string) => {
    try {
      await jsonPost(`/api/marketplace/sources/${sourceId}/enable-all`);
      await loadData();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const handleDisableAll = async (sourceId: string) => {
    try {
      await jsonPost(`/api/marketplace/sources/${sourceId}/disable-all`);
      await loadData();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const selectedSource = sources.find(s => s.id === selectedId);
  const plugins = selectedId ? (sourcePlugins[selectedId] ?? []) : [];
  const enabledCount = plugins.filter(p => p.enabled).length;

  return (
    <div className="flex flex-1 h-full overflow-hidden">
      <SourcesSidebar
        sources={sources}
        selected={selectedId}
        onSelect={setSelectedId}
        onAdd={() => setShowAdd(true)}
        onSync={handleSync}
        onDelete={handleDelete}
        onReorder={handleReorder}
        syncingId={syncingId}
      />

      {/* Main content */}
      <div className="flex-1 flex flex-col overflow-hidden">
        {/* Compatibility notice */}
        <div className="flex items-start gap-2 px-4 py-2 bg-amber-50 border-b border-amber-100 flex-shrink-0">
          <svg className="w-3.5 h-3.5 text-amber-400 flex-shrink-0 mt-0.5" fill="none" viewBox="0 0 24 24" strokeWidth={1.8} stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" d="M12 9v3.75m-9.303 3.376c-.866 1.5.217 3.374 1.948 3.374h14.71c1.73 0 2.813-1.874 1.948-3.374L13.949 3.378c-.866-1.5-3.032-1.5-3.898 0L2.697 16.126ZM12 15.75h.007v.008H12v-.008Z" />
          </svg>
          <p className="text-[11px] text-amber-700 leading-relaxed">
            Third-party plugin configurations are not guaranteed to be fully compatible. Some skills, subagents, or hooks may require adaptation before use.
          </p>
        </div>
        {loading && !sources.length ? (
          <div className="flex-1 flex items-center justify-center text-sm text-gray-400">Loading…</div>
        ) : !selectedSource ? (
          <div className="flex-1 flex flex-col items-center justify-center gap-3 text-center px-8">
            <svg className="w-10 h-10 text-gray-200" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1}>
              <path strokeLinecap="round" strokeLinejoin="round" d="m20.25 7.5-.625 10.632a2.25 2.25 0 0 1-2.247 2.118H6.622a2.25 2.25 0 0 1-2.247-2.118L3.75 7.5M10 11.25h4M3.375 7.5h17.25c.621 0 1.125-.504 1.125-1.125v-1.5c0-.621-.504-1.125-1.125-1.125H3.375c-.621 0-1.125.504-1.125 1.125v1.5c0 .621.504 1.125 1.125 1.125Z" />
            </svg>
            <div>
              <p className="text-sm font-medium text-gray-600">No source selected</p>
              <p className="text-xs text-gray-400 mt-1">Add a marketplace source to get started</p>
            </div>
            <button
              onClick={() => setShowAdd(true)}
              className="mt-1 px-4 py-2 bg-violet-500 text-white text-sm rounded-lg hover:bg-violet-600"
            >
              Add Source
            </button>
          </div>
        ) : (
          <>
            {/* Source header */}
            <div className="flex items-center gap-3 px-4 py-3 border-b border-gray-100 flex-shrink-0">
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2">
                  <span className="text-sm font-semibold text-gray-800">{selectedSource.name}</span>
                  <span className={`text-[10px] px-1.5 py-0.5 rounded font-medium ${
                    selectedSource.type === 'git' ? 'bg-lime-100 text-lime-700' : 'bg-blue-100 text-blue-700'
                  }`}>
                    {selectedSource.type === 'git' ? 'git' : 'local'}
                  </span>
                  <span className="text-[10px] text-gray-400">priority #{selectedSource.priority}</span>
                </div>
                <p className="text-xs text-gray-400 mt-0.5 truncate font-mono">{selectedSource.localPath}</p>
                {selectedSource.lastSynced && (
                  <p className="text-[11px] text-gray-300 mt-0.5">
                    Synced {new Date(selectedSource.lastSynced).toLocaleString()}
                  </p>
                )}
                {selectedSource.syncError && (
                  <p className="text-[11px] text-red-400 mt-0.5">{selectedSource.syncError}</p>
                )}
              </div>

              <div className="flex items-center gap-2 flex-shrink-0">
                <button
                  onClick={() => void handleSync(selectedSource.id)}
                  disabled={syncingId === selectedSource.id}
                  className="flex items-center gap-1.5 px-3 py-1.5 text-xs border border-gray-200 rounded-lg text-gray-600 hover:bg-gray-50 disabled:opacity-50"
                >
                  <SyncIcon spinning={syncingId === selectedSource.id} />
                  Sync
                </button>
                <button
                  onClick={() => void handleEnableAll(selectedSource.id)}
                  className="px-3 py-1.5 text-xs border border-gray-200 rounded-lg text-gray-600 hover:bg-gray-50"
                >
                  Enable All
                </button>
                <button
                  onClick={() => void handleDisableAll(selectedSource.id)}
                  className="px-3 py-1.5 text-xs border border-gray-200 rounded-lg text-gray-600 hover:bg-gray-50"
                >
                  Disable All
                </button>
              </div>
            </div>

            {/* Plugin count summary */}
            <div className="px-4 py-2 border-b border-gray-50 flex-shrink-0">
              <span className="text-xs text-gray-400">
                {plugins.length === 0
                  ? 'No plugins found in this source'
                  : `${plugins.length} plugin${plugins.length !== 1 ? 's' : ''} · ${enabledCount} enabled`}
              </span>
            </div>

            {/* Plugin list */}
            <div className="flex-1 overflow-y-auto">
              {error && (
                <div className="mx-4 mt-3 px-3 py-2 bg-red-50 border border-red-100 rounded-lg text-xs text-red-500">{error}</div>
              )}
              {plugins.length === 0 ? (
                <div className="flex flex-col items-center justify-center py-16 text-center">
                  <p className="text-sm text-gray-400">No plugins found</p>
                  <p className="text-xs text-gray-300 mt-1">
                    Plugins need a <span className="font-mono">.claude-plugin/plugin.json</span> file
                  </p>
                </div>
              ) : (
                plugins.map(plugin => (
                  <PluginCard
                    key={`${plugin.sourceId}-${plugin.name}`}
                    plugin={plugin}
                    onToggle={handleTogglePlugin}
                    onToggleSkill={handleToggleSkill}
                    onToggleSubagent={handleToggleSubagent}
                    mcpStatus={mcpStatus}
                    onReload={loadData}
                  />
                ))
              )}
            </div>
          </>
        )}
      </div>

      {showAdd && <AddSourceModal onClose={() => setShowAdd(false)} onAdded={loadData} />}
    </div>
  );
}
