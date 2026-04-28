/**
 * SkillsPanel — Skills 管理页面
 *
 * Browse 页签：方块卡片按来源分组，点击进详情页（含 SKILL.md 浏览/编辑），顶部搜索同步本地+远程
 * Manage 页签：按来源分区展示已安装 skill，每条带 enable/disable 开关
 */

import { useState, useEffect, useRef, useCallback } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import rehypeHighlight from 'rehype-highlight';
import 'highlight.js/styles/github.css';

// ─── 类型 ────────────────────────────────────────────────────────────────────

interface LocalSkill {
  name: string;
  description: string;
  version?: string;
  source: string;
  dir: string;
  disabled: boolean;
}

interface RemoteResult {
  slug: string;
  displayName?: string;
  summary?: string | null;
  version?: string | null;
  score: number;
  installed: boolean;
}

type Tab = 'browse' | 'manage';

// ─── 常量 ─────────────────────────────────────────────────────────────────────

const SOURCE_LABEL: Record<string, string> = {
  bundled: 'Bundled',
  'global-compat': 'Global',
  'global-sema': 'Global',
  'clawhub-managed': 'ClaWHub',
  workspace: 'Workspace',
};

const SOURCE_ORDER = ['bundled', 'clawhub-managed', 'global-compat', 'global-sema', 'workspace'];

const SOURCE_COLOR: Record<string, string> = {
  bundled: 'bg-violet-100 text-violet-700',
  'clawhub-managed': 'bg-blue-100 text-blue-700',
  'global-compat': 'bg-gray-100 text-gray-600',
  'global-sema': 'bg-gray-100 text-gray-600',
  workspace: 'bg-amber-100 text-amber-700',
};

function getSourceLabel(source: string): string {
  if (source.startsWith('marketplace:')) return source.slice('marketplace:'.length);
  return SOURCE_LABEL[source] ?? source;
}

function getSourceColor(source: string): string {
  if (source.startsWith('marketplace:')) return 'bg-lime-200 text-lime-700';
  return SOURCE_COLOR[source] ?? 'bg-gray-100 text-gray-600';
}


// ─── 工具函数 ─────────────────────────────────────────────────────────────────

async function apiFetch<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, init);
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(text || `HTTP ${res.status}`);
  }
  return res.json() as Promise<T>;
}

function groupBySource(skills: LocalSkill[]) {
  const knownSources = new Set(SOURCE_ORDER);
  const groups = SOURCE_ORDER
    .map(src => ({ source: src, skills: skills.filter(s => s.source === src) }))
    .filter(g => g.skills.length > 0);

  // Collect marketplace sources (source starts with 'marketplace:')
  const marketplaceSources = [...new Set(skills.filter(s => s.source.startsWith('marketplace:')).map(s => s.source))];
  for (const src of marketplaceSources) {
    groups.push({ source: src, skills: skills.filter(s => s.source === src) });
  }

  const others = skills.filter(s => !knownSources.has(s.source) && !s.source.startsWith('marketplace:'));
  if (others.length > 0) groups.push({ source: 'other', skills: others });
  return groups;
}

// ─── 小组件 ───────────────────────────────────────────────────────────────────

function SourceBadge({ source, className = '' }: { source: string; className?: string }) {
  return (
    <span className={`text-[10px] font-medium px-1.5 py-0.5 rounded-full ${getSourceColor(source)} ${className}`}>
      {getSourceLabel(source)}
    </span>
  );
}

function Toggle({ checked, onChange, disabled }: { checked: boolean; onChange: () => void; disabled?: boolean }) {
  return (
    <button
      onClick={e => { e.stopPropagation(); onChange(); }}
      disabled={disabled}
      className={`relative inline-flex h-5 w-9 flex-shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors duration-150 focus:outline-none ${
        checked ? 'bg-violet-500' : 'bg-gray-200'
      } ${disabled ? 'opacity-50 cursor-not-allowed' : ''}`}
      role="switch"
      aria-checked={checked}
    >
      <span className={`pointer-events-none inline-block h-4 w-4 transform rounded-full bg-white shadow ring-0 transition duration-150 ${checked ? 'translate-x-4' : 'translate-x-0'}`} />
    </button>
  );
}

// Skill 图标（闪电）
function SkillIcon({ className = 'w-5 h-5' }: { className?: string }) {
  return (
    <svg className={className} fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor">
      <path strokeLinecap="round" strokeLinejoin="round" d="M3.75 13.5l10.5-11.25L12 10.5h8.25L9.75 21.75 12 13.5H3.75z" />
    </svg>
  );
}

// ─── 方块卡片 ─────────────────────────────────────────────────────────────────

function SkillCard({ skill, onClick }: { skill: LocalSkill; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      className="group flex flex-col gap-2.5 p-4 bg-white border border-gray-100 rounded-2xl text-left hover:border-violet-200 hover:shadow-md transition-all duration-150 cursor-pointer"
    >
      {/* Header: icon + name */}
      <div className="flex items-center gap-2.5">
        <div className="w-8 h-8 rounded-xl bg-violet-50 flex items-center justify-center flex-shrink-0 group-hover:bg-violet-100 transition-colors">
          <SkillIcon className="w-4 h-4 text-violet-500" />
        </div>
        <span className="text-sm font-semibold text-gray-800 truncate leading-tight">{skill.name}</span>
      </div>
      {/* Description */}
      <p className="text-xs text-gray-400 leading-relaxed line-clamp-2 flex-1">
        {skill.description || <span className="italic text-gray-300">No description</span>}
      </p>
      {/* Footer */}
      <div className="flex items-center gap-1.5">
        <SourceBadge source={skill.source} />
        {skill.version && <span className="text-[10px] text-gray-300">v{skill.version}</span>}
        {skill.disabled && (
          <span className="text-[10px] font-medium px-1.5 py-0.5 rounded-full bg-red-50 text-red-400">off</span>
        )}
      </div>
    </button>
  );
}

// ─── 详情页 ───────────────────────────────────────────────────────────────────

function SkillDetail({ skill, onBack, onToggleDisabled }: {
  skill: LocalSkill;
  onBack: () => void;
  onToggleDisabled: (name: string, disabled: boolean) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [readme, setReadme] = useState<string | null>(null);
  const [draftContent, setDraftContent] = useState('');
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    fetch(`/api/skills/${encodeURIComponent(skill.name)}/readme`)
      .then(r => r.ok ? r.text() : '')
      .then(setReadme)
      .catch(() => setReadme(''));
  }, [skill.name]);

  const handleSave = async () => {
    setSaving(true);
    try {
      await fetch(`/api/skills/${encodeURIComponent(skill.name)}/readme`, {
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
          className="flex items-center gap-1.5 text-xs text-gray-400 hover:text-violet-600 hover:bg-violet-50 px-2 py-1.5 rounded-lg transition-colors flex-shrink-0"
        >
          <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" d="M10.5 19.5 3 12m0 0 7.5-7.5M3 12h18" />
          </svg>
          Back
        </button>
        <span className="text-gray-200 select-none">|</span>
        {/* Name + meta */}
        <div className="flex items-center gap-2 flex-1 min-w-0">
          <span className="text-sm font-semibold text-gray-800 truncate">{skill.name}</span>
          {skill.version && <span className="text-[10px] text-gray-400">v{skill.version}</span>}
          <SourceBadge source={skill.source} />
          {skill.disabled && (
            <span className="text-[10px] font-medium px-1.5 py-0.5 rounded-full bg-red-50 text-red-400">disabled</span>
          )}
        </div>
        {/* Actions */}
        <div className="flex items-center gap-2 flex-shrink-0">
          {editing ? (
            <>
              <button onClick={() => setEditing(false)} className="text-xs text-gray-500 hover:text-gray-700 px-2 py-1 rounded hover:bg-gray-100">Cancel</button>
              <button onClick={handleSave} disabled={saving} className="text-xs bg-violet-500 text-white px-3 py-1 rounded-lg hover:bg-violet-600 disabled:opacity-50">
                {saving ? 'Saving…' : 'Save'}
              </button>
            </>
          ) : (
            <button
              onClick={() => { setDraftContent(readme ?? ''); setEditing(true); }}
              className="text-xs text-gray-400 hover:text-violet-600 hover:bg-violet-50 px-2 py-1 rounded-lg flex items-center gap-1 transition-colors"
            >
              <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" strokeWidth={1.8} stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" d="m16.862 4.487 1.687-1.688a1.875 1.875 0 1 1 2.652 2.652L6.832 19.82a4.5 4.5 0 0 1-1.897 1.13l-2.685.8.8-2.685a4.5 4.5 0 0 1 1.13-1.897L16.863 4.487Zm0 0L19.5 7.125" />
              </svg>
              Edit
            </button>
          )}
          <Toggle checked={!skill.disabled} onChange={() => onToggleDisabled(skill.name, skill.disabled)} />
        </div>
      </div>

      {/* Path */}
      <div className="px-5 py-2 bg-gray-50/60 border-b border-gray-100 flex-shrink-0">
        <span className="text-[10px] font-mono text-gray-400">{skill.dir}</span>
      </div>

      {/* Content */}
      <div className="flex-1 overflow-y-auto bg-white">
        {readme === null ? (
          <div className="flex items-center justify-center h-32">
            <svg className="animate-spin w-4 h-4 text-violet-300" fill="none" viewBox="0 0 24 24">
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
          <div className="flex items-center justify-center h-32 text-xs text-gray-400">No SKILL.md found</div>
        )}
      </div>
    </div>
  );
}

// ─── Browse 页签 ──────────────────────────────────────────────────────────────

function BrowseTab({ skills, onRefreshSkills, onReloadSuccess }: { skills: LocalSkill[]; onRefreshSkills: () => void; onReloadSuccess: () => void }) {
  const [query, setQuery] = useState('');
  const [selectedSkill, setSelectedSkill] = useState<LocalSkill | null>(null);
  const [remoteResults, setRemoteResults] = useState<RemoteResult[]>([]);
  const [remoteLoading, setRemoteLoading] = useState(false);
  const [remoteError, setRemoteError] = useState('');
  const [installingSlug, setInstallingSlug] = useState<string | null>(null);
  const [installError, setInstallError] = useState('');
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // 退出详情时同步 disabled 状态
  const handleBack = () => setSelectedSkill(null);

  const handleToggleDisabled = async (name: string, currentlyDisabled: boolean) => {
    const action = currentlyDisabled ? 'enable' : 'disable';
    try {
      await apiFetch(`/api/skills/${encodeURIComponent(name)}/${action}`, { method: 'POST' });
      onRefreshSkills();
      onReloadSuccess();
      // 更新详情页里的 skill 对象
      if (selectedSkill?.name === name) {
        setSelectedSkill(prev => prev ? { ...prev, disabled: !currentlyDisabled } : null);
      }
    } catch { /* ignore */ }
  };

  // 本地过滤
  const localMatched = query.trim()
    ? skills.filter(s =>
        s.name.toLowerCase().includes(query.toLowerCase()) ||
        s.description.toLowerCase().includes(query.toLowerCase())
      )
    : skills;

  // 远程搜索，防抖 500ms
  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    if (!query.trim()) { setRemoteResults([]); setRemoteError(''); return; }
    debounceRef.current = setTimeout(async () => {
      setRemoteLoading(true);
      setRemoteError('');
      try {
        const data = await apiFetch<{ results: RemoteResult[] }>(
          `/api/skills/remote-search?q=${encodeURIComponent(query)}`
        );
        setRemoteResults(data.results);
      } catch (err) {
        setRemoteError(err instanceof Error ? err.message : String(err));
        setRemoteResults([]);
      } finally {
        setRemoteLoading(false);
      }
    }, 500);
    return () => { if (debounceRef.current) clearTimeout(debounceRef.current); };
  }, [query]);

  const handleInstall = async (slug: string) => {
    setInstallingSlug(slug);
    setInstallError('');
    try {
      await apiFetch('/api/skills/install', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ slug }),
      });
      onRefreshSkills();
      setRemoteResults(prev => prev.map(r => r.slug === slug ? { ...r, installed: true } : r));
    } catch (err) {
      setInstallError(err instanceof Error ? err.message : String(err));
    } finally {
      setInstallingSlug(null);
    }
  };

  // 详情页视图
  if (selectedSkill) {
    return (
      <SkillDetail
        skill={selectedSkill}
        onBack={handleBack}
        onToggleDisabled={handleToggleDisabled}
      />
    );
  }

  // 卡片网格视图
  const groups = groupBySource(localMatched);

  return (
    <div className="flex-1 flex flex-col overflow-hidden">
      {/* Search bar */}
      <div className="px-5 py-3 border-b border-gray-100 bg-white flex-shrink-0">
        <div className="relative">
          <svg className="absolute left-3 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-gray-300" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" d="m21 21-5.197-5.197m0 0A7.5 7.5 0 1 0 5.196 5.196a7.5 7.5 0 0 0 10.607 10.607Z" />
          </svg>
          <input
            type="text"
            value={query}
            onChange={e => setQuery(e.target.value)}
            placeholder="搜索 skill 名称或描述，同步搜索 ClaWHub 远程…"
            className="w-full pl-8 pr-4 py-2 text-sm border border-gray-200 rounded-lg bg-gray-50 focus:bg-white focus:border-violet-300 focus:outline-none focus:ring-1 focus:ring-violet-200 transition-colors"
          />
        </div>
      </div>

      <div className="flex-1 overflow-y-auto px-5 py-4 space-y-7">
        {installError && (
          <div className="text-xs text-red-500 bg-red-50 border border-red-100 rounded-lg px-3 py-2">{installError}</div>
        )}

        {/* 本地 skill 按来源分组卡片网格 */}
        {groups.length === 0 && !query.trim() && (
          <div className="flex flex-col items-center justify-center py-16 text-center">
            <div className="w-10 h-10 rounded-2xl bg-violet-50 flex items-center justify-center mb-3">
              <SkillIcon className="w-5 h-5 text-violet-300" />
            </div>
            <p className="text-sm text-gray-400">No skills installed.</p>
          </div>
        )}

        {groups.length === 0 && query.trim() && !remoteLoading && (
          <p className="text-xs text-gray-400 py-4 text-center">No local skills match "{query}".</p>
        )}

        {groups.map(({ source, skills: groupSkills }) => (
          <section key={source}>
            <div className="flex items-center gap-2 mb-3">
              <SourceBadge source={source} />
              <span className="text-[10px] text-gray-300">{groupSkills.length}</span>
            </div>
            <div className="grid gap-3" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(200px, 1fr))' }}>
              {groupSkills.map(s => (
                <SkillCard key={s.name} skill={s} onClick={() => setSelectedSkill(s)} />
              ))}
            </div>
          </section>
        ))}

        {/* 远程搜索结果 */}
        {query.trim() && (
          <section>
            <div className="flex items-center gap-2 mb-3">
              <span className="text-xs font-semibold text-gray-400 uppercase tracking-wide">ClaWHub</span>
              {remoteLoading && (
                <svg className="animate-spin w-3 h-3 text-violet-400" fill="none" viewBox="0 0 24 24">
                  <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                  <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8H4z" />
                </svg>
              )}
            </div>
            {remoteError && <p className="text-xs text-red-400 mb-2">{remoteError}</p>}
            {!remoteLoading && remoteResults.length === 0 && !remoteError && (
              <p className="text-xs text-gray-400 py-2 text-center">No remote results.</p>
            )}
            {/* 远程结果也用卡片网格 */}
            <div className="grid gap-3" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(200px, 1fr))' }}>
              {remoteResults.map(r => (
                <div
                  key={r.slug}
                  className="flex flex-col gap-2.5 p-4 bg-white border border-gray-100 rounded-2xl hover:border-blue-200 hover:shadow-md transition-all duration-150"
                >
                  <div className="flex items-center gap-2.5">
                    <div className="w-8 h-8 rounded-xl bg-blue-50 flex items-center justify-center flex-shrink-0">
                      <SkillIcon className="w-4 h-4 text-blue-400" />
                    </div>
                    <span className="text-sm font-semibold text-gray-800 truncate">{r.displayName ?? r.slug}</span>
                  </div>
                  <p className="text-xs text-gray-400 leading-relaxed line-clamp-2 flex-1">
                    {r.summary || <span className="italic text-gray-300">No description</span>}
                  </p>
                  <div className="flex items-center justify-between gap-1.5">
                    <div className="flex items-center gap-1.5">
                      <span className="text-[10px] font-medium px-1.5 py-0.5 rounded-full bg-blue-50 text-blue-600">ClaWHub</span>
                      {r.version && <span className="text-[10px] text-gray-300">v{r.version}</span>}
                    </div>
                    {r.installed ? (
                      <span className="text-[10px] text-violet-500 font-medium px-1.5 py-0.5 bg-violet-50 rounded-full">Installed</span>
                    ) : (
                      <button
                        onClick={() => handleInstall(r.slug)}
                        disabled={installingSlug === r.slug}
                        className="text-[10px] font-medium text-white bg-violet-500 hover:bg-violet-600 disabled:opacity-50 px-2.5 py-1 rounded-lg transition-colors"
                      >
                        {installingSlug === r.slug ? '…' : 'Install'}
                      </button>
                    )}
                  </div>
                </div>
              ))}
            </div>
          </section>
        )}
      </div>
    </div>
  );
}

// ─── Manage 页签 ──────────────────────────────────────────────────────────────

function ManageTab({ skills, onRefreshSkills, onReloadSuccess }: { skills: LocalSkill[]; onRefreshSkills: () => void; onReloadSuccess: () => void }) {
  const [toggling, setToggling] = useState<string | null>(null);

  const handleToggle = async (name: string, currentlyDisabled: boolean) => {
    setToggling(name);
    const action = currentlyDisabled ? 'enable' : 'disable';
    try {
      await apiFetch(`/api/skills/${encodeURIComponent(name)}/${action}`, { method: 'POST' });
      onRefreshSkills();
      onReloadSuccess();
    } catch { /* ignore */ } finally {
      setToggling(null);
    }
  };

  const groups = groupBySource(skills);

  if (skills.length === 0) {
    return (
      <div className="flex-1 flex flex-col items-center justify-center py-20 text-center">
        <div className="w-10 h-10 rounded-2xl bg-violet-50 flex items-center justify-center mb-3">
          <SkillIcon className="w-5 h-5 text-violet-300" />
        </div>
        <p className="text-sm text-gray-400">No skills installed yet.</p>
      </div>
    );
  }

  return (
    <div className="flex-1 overflow-y-auto px-5 py-4 space-y-6">
      {groups.map(({ source, skills: groupSkills }) => (
        <section key={source}>
          <div className="flex items-center gap-2 mb-2">
            <SourceBadge source={source} />
            <span className="text-[10px] text-gray-300">
              {groupSkills.length} skill{groupSkills.length !== 1 ? 's' : ''}
            </span>
          </div>
          <div className="border border-gray-100 rounded-xl overflow-hidden divide-y divide-gray-50">
            {groupSkills.map(skill => (
              <div key={skill.name} className="flex items-center gap-3 px-4 py-3 bg-white hover:bg-gray-50/50 transition-colors">
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <span className={`text-sm font-medium ${skill.disabled ? 'text-gray-400' : 'text-gray-800'}`}>
                      {skill.name}
                    </span>
                    {skill.version && <span className="text-[10px] text-gray-400">v{skill.version}</span>}
                  </div>
                  {skill.description && (
                    <p className={`text-xs mt-0.5 truncate ${skill.disabled ? 'text-gray-300' : 'text-gray-400'}`}>
                      {skill.description}
                    </p>
                  )}
                </div>
                <Toggle
                  checked={!skill.disabled}
                  onChange={() => handleToggle(skill.name, skill.disabled)}
                  disabled={toggling === skill.name}
                />
              </div>
            ))}
          </div>
        </section>
      ))}
    </div>
  );
}

// ─── 主入口 ───────────────────────────────────────────────────────────────────

export function SkillsPanel() {
  const [tab, setTab] = useState<Tab>('browse');
  const [skills, setSkills] = useState<LocalSkill[]>([]);
  const [loading, setLoading] = useState(true);
  const [toast, setToast] = useState('');
  const toastTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const fetchSkills = useCallback(async () => {
    try {
      const data = await apiFetch<{ skills: LocalSkill[] }>('/api/skills');
      setSkills(data.skills);
    } catch { /* ignore */ } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { fetchSkills(); }, [fetchSkills]);

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
                ? 'border-violet-500 text-violet-600'
                : 'border-transparent text-gray-400 hover:text-gray-600'
            }`}
          >
            {t === 'browse' ? 'Browse' : 'Manage'}
            {t === 'manage' && skills.length > 0 && (
              <span className="ml-1.5 text-[10px] bg-gray-100 text-gray-400 px-1.5 py-0.5 rounded-full">{skills.length}</span>
            )}
          </button>
        ))}
        <div className="flex-1" />
        {/* Toast：toggle 操作后短暂显示 */}
        {toast && (
          <span className="mr-2 text-[10px] text-violet-500 bg-violet-50 px-2 py-1 rounded-full animate-pulse">
            {toast}
          </span>
        )}
        <button
          onClick={fetchSkills}
          title="刷新列表显示（不影响运行中的 agent）"
          className="mb-1.5 p-1.5 text-gray-300 hover:text-violet-500 hover:bg-violet-50 rounded-lg transition-colors"
        >
          <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" d="M16.023 9.348h4.992v-.001M2.985 19.644v-4.992m0 0h4.992m-4.993 0 3.181 3.183a8.25 8.25 0 0 0 13.803-3.7M4.031 9.865a8.25 8.25 0 0 1 13.803-3.7l3.181 3.182m0-4.991v4.99" />
          </svg>
        </button>
      </div>

      {loading ? (
        <div className="flex-1 flex items-center justify-center">
          <svg className="animate-spin w-5 h-5 text-violet-300" fill="none" viewBox="0 0 24 24">
            <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
            <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8H4z" />
          </svg>
        </div>
      ) : tab === 'browse' ? (
        <BrowseTab skills={skills} onRefreshSkills={fetchSkills} onReloadSuccess={() => showToast('✓ 已即时生效')} />
      ) : (
        <ManageTab skills={skills} onRefreshSkills={fetchSkills} onReloadSuccess={() => showToast('✓ 已即时生效')} />
      )}
    </div>
  );
}
