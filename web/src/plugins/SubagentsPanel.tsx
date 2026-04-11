/**
 * SubagentsPanel — Virtual Agent (Persona) 管理页面
 *
 * Browse 页签：搜索 + 卡片网格，点击进详情页（Markdown 渲染/编辑 + toggle）
 * Manage 页签：列表形式 + 每项 enable/disable 开关
 */

import { useState, useEffect, useRef, useCallback } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import rehypeHighlight from 'rehype-highlight';

// ─── 类型 ────────────────────────────────────────────────────────────────────

interface Subagent {
  name: string;
  description: string;
  tools: string[] | null;
  model: string | null;
  maxConcurrent: number;
  filePath: string;
  disabled: boolean;
}

type Tab = 'browse' | 'manage';

// ─── 工具函数 ─────────────────────────────────────────────────────────────────

async function apiFetch<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, init);
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(text || `HTTP ${res.status}`);
  }
  return res.json() as Promise<T>;
}

// ─── 小组件 ───────────────────────────────────────────────────────────────────

function Toggle({ checked, onChange, disabled }: { checked: boolean; onChange: () => void; disabled?: boolean }) {
  return (
    <button
      onClick={e => { e.stopPropagation(); onChange(); }}
      disabled={disabled}
      className={`relative inline-flex h-5 w-9 flex-shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors duration-150 focus:outline-none ${
        checked ? 'bg-purple-500' : 'bg-gray-200'
      } ${disabled ? 'opacity-50 cursor-not-allowed' : ''}`}
      role="switch"
      aria-checked={checked}
    >
      <span className={`pointer-events-none inline-block h-4 w-4 transform rounded-full bg-white shadow ring-0 transition duration-150 ${checked ? 'translate-x-4' : 'translate-x-0'}`} />
    </button>
  );
}

function PersonaIcon({ className = 'w-5 h-5' }: { className?: string }) {
  return (
    <svg className={className} fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor">
      <path strokeLinecap="round" strokeLinejoin="round" d="M15.75 6a3.75 3.75 0 1 1-7.5 0 3.75 3.75 0 0 1 7.5 0ZM4.501 20.118a7.5 7.5 0 0 1 14.998 0A17.933 17.933 0 0 1 12 21.75c-2.676 0-5.216-.584-7.499-1.632Z" />
    </svg>
  );
}

// ─── 方块卡片 ─────────────────────────────────────────────────────────────────

function SubagentCard({ agent, onClick }: { agent: Subagent; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      className="group flex flex-col gap-2.5 p-4 bg-white border border-gray-100 rounded-2xl text-left hover:border-purple-200 hover:shadow-md transition-all duration-150 cursor-pointer"
    >
      {/* Header: icon + name */}
      <div className="flex items-center gap-2.5">
        <div className="w-8 h-8 rounded-xl bg-purple-50 flex items-center justify-center flex-shrink-0 group-hover:bg-purple-100 transition-colors">
          <PersonaIcon className="w-4 h-4 text-purple-500" />
        </div>
        <span className="text-sm font-semibold text-gray-800 truncate leading-tight">{agent.name}</span>
      </div>
      {/* Description */}
      <p className="text-xs text-gray-400 leading-relaxed line-clamp-2 flex-1">
        {agent.description || <span className="italic text-gray-300">No description</span>}
      </p>
      {/* Footer */}
      <div className="flex items-center gap-1.5">
        <span className="text-[10px] font-medium px-1.5 py-0.5 rounded-full bg-purple-50 text-purple-600">
          max {agent.maxConcurrent}
        </span>
        {agent.disabled && (
          <span className="text-[10px] font-medium px-1.5 py-0.5 rounded-full bg-red-50 text-red-400">off</span>
        )}
      </div>
    </button>
  );
}

// ─── 详情页 ───────────────────────────────────────────────────────────────────

function SubagentDetail({ agent, onBack, onToggleDisabled }: {
  agent: Subagent;
  onBack: () => void;
  onToggleDisabled: (name: string, disabled: boolean) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [readme, setReadme] = useState<string | null>(null);
  const [draftContent, setDraftContent] = useState('');
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    fetch(`/api/subagents/${encodeURIComponent(agent.name)}/readme`)
      .then(r => r.ok ? r.text() : '')
      .then(setReadme)
      .catch(() => setReadme(''));
  }, [agent.name]);

  const handleSave = async () => {
    setSaving(true);
    try {
      await fetch(`/api/subagents/${encodeURIComponent(agent.name)}/readme`, {
        method: 'PUT', headers: { 'Content-Type': 'text/plain' }, body: draftContent,
      });
      setReadme(draftContent);
      setEditing(false);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="flex-1 flex flex-col overflow-hidden">
      {/* Top bar */}
      <div className="flex items-center gap-3 px-5 py-3 border-b border-gray-100 bg-white flex-shrink-0">
        <button
          onClick={onBack}
          className="flex items-center gap-1.5 text-xs text-gray-400 hover:text-purple-600 hover:bg-purple-50 px-2 py-1.5 rounded-lg transition-colors flex-shrink-0"
        >
          <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" d="M10.5 19.5 3 12m0 0 7.5-7.5M3 12h18" />
          </svg>
          Back
        </button>
        <span className="text-gray-200 select-none">|</span>
        {/* Name + meta */}
        <div className="flex items-center gap-2 flex-1 min-w-0">
          <span className="text-sm font-semibold text-gray-800 truncate">{agent.name}</span>
          <span className="text-[10px] font-medium px-1.5 py-0.5 rounded-full bg-purple-50 text-purple-600">
            max {agent.maxConcurrent}
          </span>
          {agent.model && (
            <span className="text-[10px] text-gray-400">{agent.model}</span>
          )}
          {agent.disabled && (
            <span className="text-[10px] font-medium px-1.5 py-0.5 rounded-full bg-red-50 text-red-400">disabled</span>
          )}
        </div>
        {/* Actions */}
        <div className="flex items-center gap-2 flex-shrink-0">
          {editing ? (
            <>
              <button onClick={() => setEditing(false)} className="text-xs text-gray-500 hover:text-gray-700 px-2 py-1 rounded hover:bg-gray-100">Cancel</button>
              <button onClick={handleSave} disabled={saving} className="text-xs bg-purple-500 text-white px-3 py-1 rounded-lg hover:bg-purple-600 disabled:opacity-50">
                {saving ? 'Saving...' : 'Save'}
              </button>
            </>
          ) : (
            <button
              onClick={() => { setDraftContent(readme ?? ''); setEditing(true); }}
              className="text-xs text-gray-400 hover:text-purple-600 hover:bg-purple-50 px-2 py-1 rounded-lg flex items-center gap-1 transition-colors"
            >
              <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" strokeWidth={1.8} stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" d="m16.862 4.487 1.687-1.688a1.875 1.875 0 1 1 2.652 2.652L6.832 19.82a4.5 4.5 0 0 1-1.897 1.13l-2.685.8.8-2.685a4.5 4.5 0 0 1 1.13-1.897L16.863 4.487Zm0 0L19.5 7.125" />
              </svg>
              Edit
            </button>
          )}
          <Toggle checked={!agent.disabled} onChange={() => onToggleDisabled(agent.name, agent.disabled)} />
        </div>
      </div>

      {/* Path */}
      <div className="px-5 py-2 bg-gray-50/60 border-b border-gray-100 flex-shrink-0">
        <span className="text-[10px] font-mono text-gray-400">{agent.filePath}</span>
      </div>

      {/* Content */}
      <div className="flex-1 overflow-y-auto bg-white">
        {readme === null ? (
          <div className="flex items-center justify-center h-32">
            <svg className="animate-spin w-4 h-4 text-purple-300" fill="none" viewBox="0 0 24 24">
              <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
              <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8H4z" />
            </svg>
          </div>
        ) : editing ? (
          <textarea
            className="w-full h-full font-mono text-xs text-gray-700 p-5 resize-none focus:outline-none leading-relaxed"
            value={draftContent}
            onChange={e => setDraftContent(e.target.value)}
            spellCheck={false}
            style={{ minHeight: '100%' }}
          />
        ) : readme ? (
          <div className="prose prose-sm max-w-none px-6 py-5 prose-headings:font-semibold prose-code:text-amber-700 prose-code:bg-amber-50 prose-code:px-1 prose-code:rounded prose-pre:bg-gray-50 prose-pre:border prose-pre:border-gray-200 [&_img]:rounded-lg">
            <ReactMarkdown remarkPlugins={[remarkGfm]} rehypePlugins={[rehypeHighlight]}>{readme}</ReactMarkdown>
          </div>
        ) : (
          <div className="flex items-center justify-center h-32 text-xs text-gray-400">No persona file found</div>
        )}
      </div>
    </div>
  );
}

// ─── 新建编辑器 ──────────────────────────────────────────────────────────────

const NEW_TEMPLATE = `---
name:
description:
max_concurrent: 3
---

**Calibrate your effort to the task.** For straightforward, well-defined requests, respond directly and efficiently — avoid over-research, over-plan, or over-elaborate. For complex or ambiguous tasks, engage your full methodology. Always strike the right balance between efficiency and output quality, guided by the intrinsic nature and complexity of the task.

`;

function CreateSubagentEditor({ onClose, onCreated }: { onClose: () => void; onCreated: () => void }) {
  const [content, setContent] = useState(NEW_TEMPLATE);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [showConfirmClose, setShowConfirmClose] = useState(false);

  const isDirty = content !== NEW_TEMPLATE;

  const handleClose = () => {
    if (isDirty) {
      setShowConfirmClose(true);
    } else {
      onClose();
    }
  };

  const extractName = (text: string): string => {
    const match = text.match(/^name:\s*(.+)$/m);
    return match ? match[1].trim() : '';
  };

  const handleSave = async () => {
    const name = extractName(content);
    if (!name) {
      setError('Please fill in the "name" field in the frontmatter.');
      return;
    }
    setSaving(true);
    setError('');
    try {
      const res = await fetch('/api/subagents/create', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, content }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
        setError(data.error || `HTTP ${res.status}`);
        return;
      }
      onCreated();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="flex-1 flex flex-col overflow-hidden">
      {/* Top bar */}
      <div className="flex items-center gap-3 px-5 py-3 border-b border-gray-100 bg-white flex-shrink-0">
        <div className="flex items-center gap-2 flex-1 min-w-0">
          <PersonaIcon className="w-4 h-4 text-purple-500 flex-shrink-0" />
          <span className="text-sm font-semibold text-gray-800">New Virtual Agent</span>
        </div>
        <button
          onClick={handleClose}
          className="text-gray-400 hover:text-gray-600 text-xs px-2 py-1 rounded hover:bg-gray-100 transition-colors"
        >
          Cancel
        </button>
      </div>

      {/* Editor */}
      <div className="flex-1 overflow-hidden relative">
        <textarea
          className="w-full h-full font-mono text-xs text-gray-700 p-5 resize-none focus:outline-none leading-relaxed"
          value={content}
          onChange={e => { setContent(e.target.value); setError(''); }}
          spellCheck={false}
          placeholder="Edit your persona file here..."
          style={{ minHeight: '100%' }}
        />

        {/* Save button — bottom right */}
        <div className="absolute bottom-4 right-4 flex flex-col items-end gap-2">
          {error && (
            <div className="bg-red-50 border border-red-200 text-red-600 text-xs px-3 py-2 rounded-lg max-w-xs">
              {error}
            </div>
          )}
          <button
            onClick={handleSave}
            disabled={saving}
            className="bg-purple-500 text-white text-sm font-medium px-5 py-2 rounded-xl hover:bg-purple-600 disabled:opacity-50 shadow-lg hover:shadow-xl transition-all"
          >
            {saving ? 'Saving...' : 'Save'}
          </button>
        </div>
      </div>

      {/* Confirm close dialog */}
      {showConfirmClose && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/30">
          <div className="bg-white rounded-2xl shadow-xl p-5 max-w-sm mx-4">
            <p className="text-sm font-semibold text-gray-800 mb-2">Discard changes?</p>
            <p className="text-xs text-gray-500 mb-4">You have unsaved changes. Are you sure you want to close?</p>
            <div className="flex justify-end gap-2">
              <button
                onClick={() => setShowConfirmClose(false)}
                className="text-xs text-gray-500 hover:text-gray-700 px-3 py-1.5 rounded-lg hover:bg-gray-100"
              >
                Keep editing
              </button>
              <button
                onClick={onClose}
                className="text-xs text-white bg-red-500 hover:bg-red-600 px-3 py-1.5 rounded-lg"
              >
                Discard
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ─── Browse 页签 ──────────────────────────────────────────────────────────────

function BrowseTab({ agents, onRefreshAgents, onReloadSuccess }: { agents: Subagent[]; onRefreshAgents: () => void; onReloadSuccess: () => void }) {
  const [query, setQuery] = useState('');
  const [selectedAgent, setSelectedAgent] = useState<Subagent | null>(null);
  const [creating, setCreating] = useState(false);

  const handleToggleDisabled = async (name: string, currentlyDisabled: boolean) => {
    const action = currentlyDisabled ? 'enable' : 'disable';
    try {
      await apiFetch(`/api/subagents/${encodeURIComponent(name)}/${action}`, { method: 'POST' });
      onRefreshAgents();
      onReloadSuccess();
      if (selectedAgent?.name === name) {
        setSelectedAgent(prev => prev ? { ...prev, disabled: !currentlyDisabled } : null);
      }
    } catch { /* ignore */ }
  };

  const localMatched = query.trim()
    ? agents.filter(a =>
        a.name.toLowerCase().includes(query.toLowerCase()) ||
        a.description.toLowerCase().includes(query.toLowerCase())
      )
    : agents;

  if (creating) {
    return (
      <CreateSubagentEditor
        onClose={() => setCreating(false)}
        onCreated={() => { setCreating(false); onRefreshAgents(); onReloadSuccess(); }}
      />
    );
  }

  if (selectedAgent) {
    return (
      <SubagentDetail
        agent={selectedAgent}
        onBack={() => setSelectedAgent(null)}
        onToggleDisabled={handleToggleDisabled}
      />
    );
  }

  return (
    <div className="flex-1 flex flex-col overflow-hidden">
      {/* Search bar + Add button */}
      <div className="px-5 py-3 border-b border-gray-100 bg-white flex-shrink-0">
        <div className="flex items-center gap-2">
          <div className="relative flex-1">
            <svg className="absolute left-3 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-gray-300" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" d="m21 21-5.197-5.197m0 0A7.5 7.5 0 1 0 5.196 5.196a7.5 7.5 0 0 0 10.607 10.607Z" />
            </svg>
            <input
              type="text"
              value={query}
              onChange={e => setQuery(e.target.value)}
              placeholder="Search persona name or description..."
              className="w-full pl-8 pr-4 py-2 text-sm border border-gray-200 rounded-lg bg-gray-50 focus:bg-white focus:border-purple-300 focus:outline-none focus:ring-1 focus:ring-purple-200 transition-colors"
            />
          </div>
          <button
            onClick={() => setCreating(true)}
            title="Create new virtual agent"
            className="flex items-center gap-1.5 px-3 py-2 text-xs font-medium text-purple-600 bg-purple-50 hover:bg-purple-100 rounded-lg transition-colors flex-shrink-0"
          >
            <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" d="M12 4.5v15m7.5-7.5h-15" />
            </svg>
            New
          </button>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto px-5 py-4">
        {localMatched.length === 0 && !query.trim() && (
          <div className="flex flex-col items-center justify-center py-16 text-center">
            <div className="w-10 h-10 rounded-2xl bg-purple-50 flex items-center justify-center mb-3">
              <PersonaIcon className="w-5 h-5 text-purple-300" />
            </div>
            <p className="text-sm text-gray-400">No virtual agents found.</p>
            <p className="text-xs text-gray-300 mt-1">
              Add .md persona files to ~/semaclaw/virtual-agents/
            </p>
          </div>
        )}

        {localMatched.length === 0 && query.trim() && (
          <p className="text-xs text-gray-400 py-4 text-center">No agents match "{query}".</p>
        )}

        {localMatched.length > 0 && (
          <div className="grid gap-3" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(200px, 1fr))' }}>
            {localMatched.map(a => (
              <SubagentCard key={a.name} agent={a} onClick={() => setSelectedAgent(a)} />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

// ─── Manage 页签 ──────────────────────────────────────────────────────────────

function ManageTab({ agents, onRefreshAgents, onReloadSuccess }: { agents: Subagent[]; onRefreshAgents: () => void; onReloadSuccess: () => void }) {
  const [toggling, setToggling] = useState<string | null>(null);

  const handleToggle = async (name: string, currentlyDisabled: boolean) => {
    setToggling(name);
    const action = currentlyDisabled ? 'enable' : 'disable';
    try {
      await apiFetch(`/api/subagents/${encodeURIComponent(name)}/${action}`, { method: 'POST' });
      onRefreshAgents();
      onReloadSuccess();
    } catch { /* ignore */ } finally {
      setToggling(null);
    }
  };

  if (agents.length === 0) {
    return (
      <div className="flex-1 flex flex-col items-center justify-center py-20 text-center">
        <div className="w-10 h-10 rounded-2xl bg-purple-50 flex items-center justify-center mb-3">
          <PersonaIcon className="w-5 h-5 text-purple-300" />
        </div>
        <p className="text-sm text-gray-400">No virtual agents found.</p>
      </div>
    );
  }

  return (
    <div className="flex-1 overflow-y-auto px-5 py-4">
      <div className="border border-gray-100 rounded-xl overflow-hidden divide-y divide-gray-50">
        {agents.map(agent => (
          <div key={agent.name} className="flex items-center gap-3 px-4 py-3 bg-white hover:bg-gray-50/50 transition-colors">
            <div className="w-7 h-7 rounded-lg bg-purple-50 flex items-center justify-center flex-shrink-0">
              <PersonaIcon className="w-3.5 h-3.5 text-purple-400" />
            </div>
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2">
                <span className={`text-sm font-medium ${agent.disabled ? 'text-gray-400' : 'text-gray-800'}`}>
                  {agent.name}
                </span>
                <span className="text-[10px] font-medium px-1.5 py-0.5 rounded-full bg-purple-50 text-purple-500">
                  max {agent.maxConcurrent}
                </span>
              </div>
              {agent.description && (
                <p className={`text-xs mt-0.5 truncate ${agent.disabled ? 'text-gray-300' : 'text-gray-400'}`}>
                  {agent.description}
                </p>
              )}
            </div>
            <Toggle
              checked={!agent.disabled}
              onChange={() => handleToggle(agent.name, agent.disabled)}
              disabled={toggling === agent.name}
            />
          </div>
        ))}
      </div>
    </div>
  );
}

// ─── 主入口 ───────────────────────────────────────────────────────────────────

export function SubagentsPanel() {
  const [tab, setTab] = useState<Tab>('browse');
  const [agents, setAgents] = useState<Subagent[]>([]);
  const [loading, setLoading] = useState(true);
  const [toast, setToast] = useState('');
  const toastTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const fetchAgents = useCallback(async () => {
    try {
      const data = await apiFetch<{ subagents: Subagent[] }>('/api/subagents');
      setAgents(data.subagents);
    } catch { /* ignore */ } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { fetchAgents(); }, [fetchAgents]);

  const showToast = useCallback((msg: string) => {
    setToast(msg);
    if (toastTimerRef.current) clearTimeout(toastTimerRef.current);
    toastTimerRef.current = setTimeout(() => setToast(''), 2500);
  }, []);

  return (
    <div className="flex-1 flex flex-col overflow-hidden">
      {/* Tab bar */}
      <div className="flex items-center px-5 pt-3 border-b border-gray-100 bg-white flex-shrink-0">
        {(['browse', 'manage'] as Tab[]).map(t => (
          <button
            key={t}
            onClick={() => setTab(t)}
            className={`px-4 py-2 text-sm font-medium border-b-2 transition-colors ${
              tab === t
                ? 'border-purple-500 text-purple-600'
                : 'border-transparent text-gray-400 hover:text-gray-600'
            }`}
          >
            {t === 'browse' ? 'Browse' : 'Manage'}
            {t === 'manage' && agents.length > 0 && (
              <span className="ml-1.5 text-[10px] bg-gray-100 text-gray-400 px-1.5 py-0.5 rounded-full">{agents.length}</span>
            )}
          </button>
        ))}
        <div className="flex-1" />
        {toast && (
          <span className="mr-2 text-[10px] text-purple-500 bg-purple-50 px-2 py-1 rounded-full animate-pulse">
            {toast}
          </span>
        )}
        <button
          onClick={fetchAgents}
          title="Refresh list"
          className="mb-1.5 p-1.5 text-gray-300 hover:text-purple-500 hover:bg-purple-50 rounded-lg transition-colors"
        >
          <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" d="M16.023 9.348h4.992v-.001M2.985 19.644v-4.992m0 0h4.992m-4.993 0 3.181 3.183a8.25 8.25 0 0 0 13.803-3.7M4.031 9.865a8.25 8.25 0 0 1 13.803-3.7l3.181 3.182m0-4.991v4.99" />
          </svg>
        </button>
      </div>

      {loading ? (
        <div className="flex-1 flex items-center justify-center">
          <svg className="animate-spin w-5 h-5 text-purple-300" fill="none" viewBox="0 0 24 24">
            <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
            <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8H4z" />
          </svg>
        </div>
      ) : tab === 'browse' ? (
        <BrowseTab agents={agents} onRefreshAgents={fetchAgents} onReloadSuccess={() => showToast('Saved')} />
      ) : (
        <ManageTab agents={agents} onRefreshAgents={fetchAgents} onReloadSuccess={() => showToast('Saved')} />
      )}
    </div>
  );
}
