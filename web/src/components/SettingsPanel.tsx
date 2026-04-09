import { useEffect, useState } from 'react';
import type { GroupInfo, RegisterGroupPayload, UpdateGroupPayload } from '../types';

// ===== Types =====

type Tab = 'permissions' | 'agents' | 'llm';

// ===== LLM Config types & constants =====

interface LLMConfig {
  id: string;
  label: string;
  provider: string;
  baseURL: string;
  apiKey: string;
  modelName: string;
  adapt: 'openai' | 'anthropic';
  maxTokens: number;
  contextLength: number;
}

interface ProviderDef {
  name: string;
  baseURL: string;
  /** Override URL for fetching model list (some providers use a different endpoint) */
  modelsUrl?: string;
  baseURLPlaceholder?: string;
  apiKeyPlaceholder?: string;
  defaultAdapt: 'openai' | 'anthropic';
  defaultMaxTokens?: number;
  defaultContextLength?: number;
}

const PROVIDERS: Record<string, ProviderDef> = {
  anthropic:  { name: 'Anthropic',          baseURL: 'https://api.anthropic.com',                         defaultAdapt: 'anthropic', apiKeyPlaceholder: '输入您的 Anthropic API Key' },
  openai:     { name: 'OpenAI',             baseURL: 'https://api.openai.com/v1',                         defaultAdapt: 'openai',    apiKeyPlaceholder: '输入您的 OpenAI API Key' },
  kimi:       { name: 'Kimi (Moonshot)',     baseURL: 'https://api.moonshot.cn/v1',                        defaultAdapt: 'openai',    apiKeyPlaceholder: '输入您的 Moonshot API Key' },
  minimax:    { name: 'MiniMax',            baseURL: 'https://api.minimaxi.com/anthropic',                 defaultAdapt: 'anthropic', apiKeyPlaceholder: '输入您的 MiniMax API Key' },
  deepseek:   { name: 'DeepSeek',           baseURL: 'https://api.deepseek.com/anthropic', modelsUrl: 'https://api.deepseek.com/v1',        defaultAdapt: 'anthropic', apiKeyPlaceholder: '输入您的 DeepSeek API Key' },
  glm:        { name: 'GLM (智谱)',          baseURL: 'https://open.bigmodel.cn/api/paas/v4',              defaultAdapt: 'openai',    apiKeyPlaceholder: '输入您的智谱 API Key' },
  openrouter: { name: 'OpenRouter',         baseURL: 'https://openrouter.ai/api',          modelsUrl: 'https://openrouter.ai/api/v1',       defaultAdapt: 'openai', apiKeyPlaceholder: '输入您的 OpenRouter API Key' },
  qwen:       { name: 'Qwen (Alibaba)',      baseURL: 'https://dashscope.aliyuncs.com/compatible-mode/v1', defaultAdapt: 'openai',   apiKeyPlaceholder: '输入您的阿里云 API Key' },
  custom:     { name: '自定义 LLM 接口',    baseURL: '',                                                   defaultAdapt: 'openai',    baseURLPlaceholder: 'https://your-api.com/v1', apiKeyPlaceholder: '输入您的 API Key' },
};
const PROVIDER_ORDER = ['anthropic','openai','kimi','minimax','deepseek','glm','openrouter','qwen','custom'];
const DEFAULT_MAX_TOKENS_OPTIONS = [4096, 8192, 16000, 32000, 64000, 100000];
const DEFAULT_CONTEXT_LENGTH_OPTIONS = [8000, 16000, 32000, 64000, 128000, 200000, 256000, 512000, 1000000];

// 按前缀匹配的模型限制表（前缀越具体越靠前）
const MODEL_LIMITS_TABLE: Array<[string, { maxTokens: number; contextLength: number }]> = [
  // Anthropic Claude
  ['claude-opus-4',       { maxTokens: 32000,   contextLength: 200000  }],
  ['claude-sonnet-4',     { maxTokens: 64000,   contextLength: 200000  }],
  ['claude-haiku-4',      { maxTokens: 16000,   contextLength: 200000  }],
  ['claude-3-7-sonnet',   { maxTokens: 64000,   contextLength: 200000  }],
  ['claude-3-5-sonnet',   { maxTokens: 8192,    contextLength: 200000  }],
  ['claude-3-5-haiku',    { maxTokens: 8192,    contextLength: 200000  }],
  ['claude-3-opus',       { maxTokens: 4096,    contextLength: 200000  }],
  ['claude-3-sonnet',     { maxTokens: 4096,    contextLength: 200000  }],
  ['claude-3-haiku',      { maxTokens: 4096,    contextLength: 200000  }],
  // OpenAI
  ['o3-mini',             { maxTokens: 65536,   contextLength: 200000  }],
  ['o3',                  { maxTokens: 100000,  contextLength: 200000  }],
  ['o1-mini',             { maxTokens: 65536,   contextLength: 128000  }],
  ['o1',                  { maxTokens: 32768,   contextLength: 200000  }],
  ['gpt-4o-mini',         { maxTokens: 16384,   contextLength: 128000  }],
  ['gpt-4o',              { maxTokens: 16384,   contextLength: 128000  }],
  ['gpt-4-turbo',         { maxTokens: 4096,    contextLength: 128000  }],
  ['gpt-4',               { maxTokens: 8192,    contextLength: 8192    }],
  ['gpt-3.5-turbo',       { maxTokens: 4096,    contextLength: 16384   }],
  // DeepSeek
  ['deepseek-r1',         { maxTokens: 32000,   contextLength: 64000   }],
  ['deepseek-v3',         { maxTokens: 32000,   contextLength: 64000   }],
  ['deepseek-chat',       { maxTokens: 8192,    contextLength: 64000   }],
  ['deepseek-reasoner',   { maxTokens: 8192,    contextLength: 64000   }],
  ['deepseek-coder',      { maxTokens: 8192,    contextLength: 16000   }],
  // Kimi / Moonshot
  ['kimi-k2',             { maxTokens: 32000,   contextLength: 131072  }],
  ['moonshot-v1-128k',    { maxTokens: 8192,    contextLength: 128000  }],
  ['moonshot-v1-32k',     { maxTokens: 8192,    contextLength: 32000   }],
  ['moonshot-v1-8k',      { maxTokens: 8192,    contextLength: 8000    }],
  // MiniMax
  ['minimax-m1',          { maxTokens: 40960,   contextLength: 1000000 }],
  ['abab6.5',             { maxTokens: 8192,    contextLength: 245760  }],
  // GLM / 智谱
  ['glm-4-long',          { maxTokens: 8192,    contextLength: 1000000 }],
  ['glm-4-flash',         { maxTokens: 8192,    contextLength: 128000  }],
  ['glm-4',               { maxTokens: 8192,    contextLength: 128000  }],
  ['glm-z1',              { maxTokens: 32768,   contextLength: 32768   }],
  // Qwen / 通义
  ['qwen3',               { maxTokens: 32768,   contextLength: 32768   }],
  ['qwen-long',           { maxTokens: 8192,    contextLength: 1000000 }],
  ['qwen-max',            { maxTokens: 8192,    contextLength: 32000   }],
  ['qwen-plus',           { maxTokens: 8192,    contextLength: 131072  }],
  ['qwen-turbo',          { maxTokens: 8192,    contextLength: 131072  }],
  ['qwq',                 { maxTokens: 32768,   contextLength: 131072  }],
  // Gemini
  ['gemini-2.5-pro',      { maxTokens: 65536,   contextLength: 1000000 }],
  ['gemini-2.5-flash',    { maxTokens: 65536,   contextLength: 1000000 }],
  ['gemini-2.0-flash',    { maxTokens: 8192,    contextLength: 1000000 }],
  ['gemini-1.5-pro',      { maxTokens: 8192,    contextLength: 1000000 }],
  ['gemini-1.5-flash',    { maxTokens: 8192,    contextLength: 1000000 }],
  // Llama
  ['llama-3.3',           { maxTokens: 32768,   contextLength: 131072  }],
  ['llama-3.1',           { maxTokens: 32768,   contextLength: 131072  }],
  ['llama-3',             { maxTokens: 8192,    contextLength: 8192    }],
];

function lookupModelLimits(modelName: string): { maxTokens: number; contextLength: number } | null {
  const lower = modelName.toLowerCase();
  for (const [prefix, limits] of MODEL_LIMITS_TABLE) {
    if (lower.startsWith(prefix)) return limits;
  }
  return null;
}

/** 确保 options 列表里包含 value，不在则追加 */
function ensureOption(options: number[], value: number): number[] {
  return options.includes(value) ? options : [...options, value].sort((a, b) => a - b);
}

interface Props {
  onClose: () => void;
  groups: GroupInfo[];
  onRegisterGroup: (data: RegisterGroupPayload) => void;
  onRegisterFeishuApp: (appId: string, appSecret: string, domain?: string) => void;
  onRegisterQQApp: (appId: string, appSecret: string, sandbox?: boolean) => void;
  onUnregisterGroup: (jid: string) => void;
  onUpdateGroup: (jid: string, updates: UpdateGroupPayload) => void;
}

// ===== Helpers =====

/** Validate folder: alphanumeric + hyphens only */
function isValidFolder(s: string): boolean {
  return /^[a-z0-9-]+$/.test(s);
}

function slugify(s: string): string {
  return s.toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '').slice(0, 32);
}

// ===== Sub-components =====

function Toggle({ value, onChange, disabled }: { value: boolean; onChange: (v: boolean) => void; disabled?: boolean }) {
  return (
    <button
      type="button"
      onClick={() => !disabled && onChange(!value)}
      disabled={disabled}
      className={`relative flex-shrink-0 rounded-full transition-colors disabled:opacity-40 ${value ? 'bg-[#5BBFE8]' : 'bg-gray-200'}`}
      style={{ width: 40, height: 22 }}
      aria-pressed={value}
    >
      <span
        className={`absolute top-0.5 rounded-full bg-white shadow transition-transform`}
        style={{ width: 18, height: 18, transform: value ? 'translateX(19px)' : 'translateX(2px)' }}
      />
    </button>
  );
}

// ===== Permission Tab =====

interface PermissionsState {
  skipMainAgentPermissions: boolean;
  skipAllAgentsPermissions: boolean;
}

function PermissionsTab() {
  const [perms, setPerms]       = useState<PermissionsState>({ skipMainAgentPermissions: false, skipAllAgentsPermissions: false });
  const [loading, setLoading]   = useState(true);
  const [saving, setSaving]     = useState(false);
  const [feedback, setFeedback] = useState<{ ok: boolean; msg: string } | null>(null);

  useEffect(() => {
    fetch('/api/admin-permissions')
      .then(r => r.json())
      .then((d: PermissionsState) => { setPerms(d); setLoading(false); })
      .catch(() => setLoading(false));
  }, []);

  const save = async (next: PermissionsState) => {
    setSaving(true);
    setFeedback(null);
    try {
      const r = await fetch('/api/admin-permissions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(next),
      });
      if (!r.ok) throw new Error('failed');
      setPerms(next);
      setFeedback({ ok: true, msg: '已保存' });
    } catch {
      setFeedback({ ok: false, msg: '操作失败，请重试' });
    } finally {
      setSaving(false);
    }
  };

  const toggleMain = () => save({ ...perms, skipMainAgentPermissions: !perms.skipMainAgentPermissions });
  const toggleAll  = () => {
    const next = !perms.skipAllAgentsPermissions;
    // 开启「全部放开」时，主 Agent 开关也跟着置为 true（语义包含）
    save({ skipMainAgentPermissions: next ? true : perms.skipMainAgentPermissions, skipAllAgentsPermissions: next });
  };

  return (
    <section className="space-y-3">
      <p className="text-[11px] font-semibold text-[#5BBFE8] uppercase tracking-wide">权限审批</p>

      {/* 主 Agent */}
      <div className="bg-gray-50 rounded-xl p-3.5">
        <div className="flex items-center justify-between mb-2">
          <span className="text-sm font-medium text-gray-800">主 Agent 免审批</span>
          <Toggle
            value={perms.skipMainAgentPermissions || perms.skipAllAgentsPermissions}
            onChange={toggleMain}
            disabled={loading || saving || perms.skipAllAgentsPermissions}
          />
        </div>
        <p className="text-[11px] text-gray-400 leading-relaxed">
          开启后，主 Agent 执行文件读写、Bash 命令时无需逐步审批。
          {perms.skipAllAgentsPermissions && <span className="text-[#5BBFE8]"> （已被「全部放开」覆盖）</span>}
        </p>
        {!loading && (
          <p className={`mt-1.5 text-[11px] font-medium ${(perms.skipMainAgentPermissions || perms.skipAllAgentsPermissions) ? 'text-[#5BBFE8]' : 'text-gray-400'}`}>
            {(perms.skipMainAgentPermissions || perms.skipAllAgentsPermissions) ? '● 已开启' : '○ 已关闭'}
          </p>
        )}
      </div>

      {/* 全部 Agent */}
      <div className="bg-gray-50 rounded-xl p-3.5">
        <div className="flex items-center justify-between mb-2">
          <span className="text-sm font-medium text-gray-800">全部 Agent 免审批</span>
          <Toggle value={perms.skipAllAgentsPermissions} onChange={toggleAll} disabled={loading || saving} />
        </div>
        <p className="text-[11px] text-gray-400 leading-relaxed">
          开启后，所有 Agent（含 dispatch 子 Agent）执行工具时均无需审批。适合完全信任的本地环境。
        </p>
        {!loading && (
          <p className={`mt-1.5 text-[11px] font-medium ${perms.skipAllAgentsPermissions ? 'text-amber-500' : 'text-gray-400'}`}>
            {perms.skipAllAgentsPermissions ? '● 已开启' : '○ 已关闭'}
          </p>
        )}
      </div>

      {feedback && (
        <p className={`text-[11px] px-1 ${feedback.ok ? 'text-green-600' : 'text-red-500'}`}>
          {feedback.msg}
        </p>
      )}
    </section>
  );
}

// ===== Agent Row =====

interface AgentRowProps {
  group: GroupInfo;
  onDelete: (jid: string) => void;
  onEditName: (jid: string, name: string) => void;
}

function AgentRow({ group, onDelete, onEditName }: AgentRowProps) {
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [editingName, setEditingName]     = useState(false);
  const [nameInput, setNameInput]         = useState(group.name);

  const handleSaveName = () => {
    const trimmed = nameInput.trim();
    if (trimmed && trimmed !== group.name) {
      onEditName(group.jid, trimmed);
    }
    setEditingName(false);
  };

  const avatar = (
    <div className={`w-9 h-9 rounded-full flex items-center justify-center text-white font-semibold text-sm flex-shrink-0 select-none ${
      group.isAdmin ? 'bg-amber-400' : 'bg-[#5BBFE8]'
    }`}>
      {group.name.charAt(0).toUpperCase()}
    </div>
  );

  return (
    <div className={`rounded-xl p-3 flex items-start gap-3 ${
      group.isAdmin ? 'bg-amber-50 border border-amber-100' : 'bg-gray-50 border border-gray-100'
    }`}>
      {avatar}

      <div className="flex-1 min-w-0">
        {/* Name row */}
        <div className="flex items-center gap-1.5 mb-0.5">
          {editingName ? (
            <input
              className="text-sm font-medium text-gray-800 border border-[#5BBFE8] rounded px-1.5 py-0.5 w-full outline-none"
              value={nameInput}
              onChange={e => setNameInput(e.target.value)}
              onBlur={handleSaveName}
              onKeyDown={e => { if (e.key === 'Enter') handleSaveName(); if (e.key === 'Escape') { setEditingName(false); setNameInput(group.name); } }}
              autoFocus
            />
          ) : (
            <>
              <span className="text-sm font-medium text-gray-800 truncate">{group.name}</span>
              {group.isAdmin && (
                <span className="text-[10px] bg-amber-100 text-amber-700 px-1.5 py-0.5 rounded font-semibold flex-shrink-0">主</span>
              )}
              {/* Pencil icon to edit name */}
              <button
                onClick={() => { setNameInput(group.name); setEditingName(true); }}
                className="opacity-0 group-hover:opacity-100 hover:!opacity-100 flex-shrink-0 text-gray-400 hover:text-[#5BBFE8] transition-all"
                title="编辑名称"
              >
                <svg xmlns="http://www.w3.org/2000/svg" className="w-3 h-3" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" d="m16.862 4.487 1.687-1.688a1.875 1.875 0 1 1 2.652 2.652L10.582 16.07a4.5 4.5 0 0 1-1.897 1.13L6 18l.8-2.685a4.5 4.5 0 0 1 1.13-1.897l8.932-8.931Z" />
                </svg>
              </button>
            </>
          )}
        </div>

        {/* ID + JID */}
        <p className="text-[11px] text-gray-400 font-mono truncate">ID: {group.folder}</p>
        <p className="text-[11px] text-gray-400 truncate">{group.jid}</p>

        {/* Tags */}
        <div className="flex gap-1.5 mt-1.5 flex-wrap">
          {(group.jid.startsWith('feishu:pending:') || group.jid.startsWith('qq:pending:')) && (
            <span className="text-[10px] bg-amber-50 text-amber-600 px-1.5 py-0.5 rounded">待绑定</span>
          )}
          {group.channel ? (
            <span className="text-[10px] bg-gray-100 text-gray-500 px-1.5 py-0.5 rounded">
              {group.channel === 'telegram' ? 'Telegram' : group.channel === 'feishu' ? 'Feishu' : group.channel === 'qq' ? 'QQ' : group.channel}
            </span>
          ) : (
            <span className="text-[10px] bg-purple-50 text-purple-500 px-1.5 py-0.5 rounded">Web only</span>
          )}
          {group.requiresTrigger && group.channel && (
            <span className="text-[10px] bg-gray-100 text-gray-500 px-1.5 py-0.5 rounded">触发词</span>
          )}
          {group.allowedWorkDirs !== null && (
            <span className="text-[10px] bg-blue-50 text-blue-500 px-1.5 py-0.5 rounded">工作目录限制</span>
          )}
        </div>
      </div>

      {/* Delete (non-admin only) */}
      {!group.isAdmin && (
        <div className="flex-shrink-0">
          {confirmDelete ? (
            <div className="flex items-center gap-1">
              <button
                onClick={() => onDelete(group.jid)}
                className="text-[11px] bg-red-500 text-white px-2 py-1 rounded-lg hover:bg-red-600 transition-colors"
              >确认</button>
              <button
                onClick={() => setConfirmDelete(false)}
                className="text-[11px] bg-gray-100 text-gray-600 px-2 py-1 rounded-lg hover:bg-gray-200 transition-colors"
              >取消</button>
            </div>
          ) : (
            <button
              onClick={() => setConfirmDelete(true)}
              className="w-7 h-7 flex items-center justify-center rounded-lg hover:bg-red-50 text-gray-300 hover:text-red-400 transition-colors"
              title="删除 Agent"
            >
              <svg xmlns="http://www.w3.org/2000/svg" className="w-4 h-4" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" d="m14.74 9-.346 9m-4.788 0L9.26 9m9.968-3.21c.342.052.682.107 1.022.166m-1.022-.165L18.16 19.673a2.25 2.25 0 0 1-2.244 2.077H8.084a2.25 2.25 0 0 1-2.244-2.077L4.772 5.79m14.456 0a48.108 48.108 0 0 0-3.478-.397m-12 .562c.34-.059.68-.114 1.022-.165m0 0a48.11 48.11 0 0 1 3.478-.397m7.5 0v-.916c0-1.18-.91-2.164-2.09-2.201a51.964 51.964 0 0 0-3.32 0c-1.18.037-2.09 1.022-2.09 2.201v.916m7.5 0a48.667 48.667 0 0 0-7.5 0" />
              </svg>
            </button>
          )}
        </div>
      )}
    </div>
  );
}

// ===== Create Agent Form =====

interface CreateFormProps {
  groups: GroupInfo[];
  onSubmit: (data: RegisterGroupPayload) => void;
  onRegisterFeishuApp: (appId: string, appSecret: string, domain?: string) => void;
  onRegisterQQApp: (appId: string, appSecret: string, sandbox?: boolean) => void;
  onCancel: () => void;
}

function CreateAgentForm({ groups, onSubmit, onRegisterFeishuApp, onRegisterQQApp, onCancel }: CreateFormProps) {
  const [name, setName]           = useState('');
  const [folder, setFolder]       = useState('');
  const [jid, setJid]             = useState('');
  const [channel, setChannel]     = useState<'telegram' | 'feishu' | 'qq' | ''>('');
  const [botToken, setBotToken]   = useState('');
  const [appSecret, setAppSecret] = useState('');
  const [tgChatId, setTgChatId]   = useState('');
  const [tgChatType, setTgChatType] = useState<'group' | 'user'>('group');
  const [qqSandbox, setQQSandbox]             = useState(false);
  const [requiresTrigger, setRequiresTrigger] = useState(true);
  const [submitting, setSubmitting]           = useState(false);
  const [errors, setErrors]                   = useState<Record<string, string>>({});

  const isWebOnly = channel === '';

  // Auto-derive folder from name
  const handleNameChange = (v: string) => {
    setName(v);
    const newSlug = slugify(v);
    if (!folder || folder === slugify(name)) {
      setFolder(newSlug);
      if (isWebOnly && (!jid || jid.startsWith('web:'))) {
        setJid(newSlug ? `web:${newSlug}` : '');
      }
    }
  };

  const handleFolderChange = (v: string) => {
    const clean = v.toLowerCase().replace(/[^a-z0-9-]/g, '');
    setFolder(clean);
    if (isWebOnly && (!jid || jid.startsWith('web:'))) {
      setJid(clean ? `web:${clean}` : '');
    }
  };

  const handleChannelChange = (v: 'telegram' | 'feishu' | 'qq' | '') => {
    setChannel(v);
    if (v === '') {
      if (!jid || jid.startsWith('tg:') || jid.startsWith('feishu:') || jid.startsWith('qq:') || jid === 'tg:group:' || jid === 'feishu:group:') {
        setJid(folder ? `web:${folder}` : '');
      }
    } else if (v === 'telegram') {
      setTgChatId('');
      setTgChatType('group');
      setJid('');
    } else if (v === 'feishu') {
      if (!jid || jid.startsWith('web:') || jid.startsWith('tg:') || jid.startsWith('qq:')) {
        setJid('');  // 飞书 JID 可留空（首条消息后自动绑定）
      }
    } else if (v === 'qq') {
      setJid(''); // QQ 始终 pending，JID 由首条消息自动绑定
    }
  };

  const handleTgChange = (chatId: string, chatType: 'group' | 'user') => {
    setTgChatId(chatId);
    setTgChatType(chatType);
    setJid(chatId.trim() ? `tg:${chatType}:${chatId.trim()}` : '');
  };

  const validate = (): boolean => {
    const errs: Record<string, string> = {};
    const trimName   = name.trim();
    const trimFolder = folder.trim();
    const trimJid    = jid.trim();

    if (!trimName) errs.name = '名称不能为空';
    else if (groups.some(g => g.name.toLowerCase() === trimName.toLowerCase())) errs.name = '名称已存在';

    if (!trimFolder) errs.folder = 'Agent ID 不能为空';
    else if (!isValidFolder(trimFolder)) errs.folder = '只允许小写字母、数字和连字符';
    else if (groups.some(g => g.folder === trimFolder)) errs.folder = 'Agent ID 已存在';

    if (channel === 'telegram') {
      const trimId = tgChatId.trim();
      if (!trimId) errs.tgChatId = 'Chat ID 不能为空';
      else if (!/^-?\d+$/.test(trimId)) errs.tgChatId = 'Chat ID 必须是数字';
      else if (groups.some(g => g.jid === trimJid)) errs.tgChatId = '该群组已注册';
      if (tgChatType === 'user' && !botToken.trim()) errs.botToken = 'User 绑定必须填写 Bot Token';
    } else if (channel === 'feishu') {
      const hasAppId = !!botToken.trim();
      const hasAppSecret = !!appSecret.trim();
      if (hasAppId && !hasAppSecret) errs.appSecret = '填写了 App ID 时必须填写 App Secret';
      if (!hasAppId && hasAppSecret) errs.appId = '填写了 App Secret 时必须填写 App ID';
      // 飞书 JID 可选留空（将存为 feishu:pending:{appId}）
      if (trimJid && !trimJid.startsWith('feishu:')) errs.jid = '飞书 JID 格式错误（应以 feishu: 开头）';
      else if (trimJid && groups.some(g => g.jid === trimJid)) errs.jid = '该 JID 已注册';
      if (!trimJid && !botToken.trim()) errs.appId = '留空 Chat JID 时必须填写 App ID';
    } else if (channel === 'qq') {
      if (!botToken.trim()) errs.appId = 'App ID 不能为空';
      if (!appSecret.trim()) errs.appSecret = 'App Secret 不能为空';
      // 检查 pending JID 唯一性
      const pendingJid = botToken.trim() ? `qq:pending:${botToken.trim()}` : '';
      if (pendingJid && groups.some(g => g.jid === pendingJid)) errs.appId = '该 QQ App 已绑定';
    } else {
      // Web-only: JID 自动生成，仅检查唯一性
      if (groups.some(g => g.jid === trimJid)) errs.jid = 'Agent JID 已存在（请修改 Agent ID）';
    }

    setErrors(errs);
    return Object.keys(errs).length === 0;
  };

  const handleSubmit = () => {
    if (!validate()) return;
    setSubmitting(true);
    const trimmedJid = jid.trim();
    const payload: RegisterGroupPayload = {
      folder: folder.trim(),
      name:   name.trim(),
    };
    // pending 绑定（Feishu/QQ）：JID 留空，由后端生成 {channel}:pending:{appId}
    if (trimmedJid) payload.jid = trimmedJid;
    if (channel) payload.channel = channel;
    if (channel) payload.requiresTrigger = requiresTrigger;
    if (botToken.trim()) payload.botToken = botToken.trim();
    // Feishu: register app credentials before registering group
    if (channel === 'feishu' && botToken.trim() && appSecret.trim()) {
      onRegisterFeishuApp(botToken.trim(), appSecret.trim());
    }
    // QQ: register app credentials before registering group
    if (channel === 'qq' && botToken.trim() && appSecret.trim()) {
      onRegisterQQApp(botToken.trim(), appSecret.trim(), qqSandbox || undefined);
    }
    onSubmit(payload);
    setTimeout(() => setSubmitting(false), 2000);
  };

  return (
    <div className="border border-[#5BBFE8]/30 rounded-xl p-4 bg-[#EEF7FD]/40 space-y-3">
      <p className="text-xs font-semibold text-gray-700">新增 Agent</p>

      {/* Name */}
      <div>
        <label className="text-[11px] text-gray-500 mb-1 block">显示名称 <span className="text-red-400">*</span></label>
        <input
          className={`w-full text-sm border rounded-lg px-3 py-2 outline-none transition-colors ${errors.name ? 'border-red-300 bg-red-50' : 'border-gray-200 focus:border-[#5BBFE8]'}`}
          placeholder="工作群助手"
          value={name}
          onChange={e => handleNameChange(e.target.value)}
        />
        {errors.name && <p className="text-[11px] text-red-500 mt-0.5">{errors.name}</p>}
      </div>

      {/* Folder / Agent ID */}
      <div>
        <label className="text-[11px] text-gray-500 mb-1 block">Agent ID <span className="text-red-400">*</span></label>
        <input
          className={`w-full text-sm font-mono border rounded-lg px-3 py-2 outline-none transition-colors ${errors.folder ? 'border-red-300 bg-red-50' : 'border-gray-200 focus:border-[#5BBFE8]'}`}
          placeholder="work-group"
          value={folder}
          onChange={e => handleFolderChange(e.target.value)}
        />
        {errors.folder
          ? <p className="text-[11px] text-red-500 mt-0.5">{errors.folder}</p>
          : <p className="text-[11px] text-gray-400 mt-0.5">小写字母、数字和连字符，创建后不可修改</p>
        }
      </div>

      {/* Channel */}
      <div>
        <label className="text-[11px] text-gray-500 mb-1 block">Channel</label>
        <select
          className="w-full text-sm border border-gray-200 rounded-lg px-3 py-2 outline-none focus:border-[#5BBFE8] bg-white"
          value={channel}
          onChange={e => handleChannelChange(e.target.value as 'telegram' | 'feishu' | '')}
        >
          <option value="">无（仅 Web）</option>
          <option value="telegram">Telegram</option>
          <option value="feishu">飞书 / Feishu</option>
          <option value="qq">QQ</option>
        </select>
        {isWebOnly && (
          <p className="text-[11px] text-gray-400 mt-0.5">仅通过 Web 界面接收主 Agent 下发的任务</p>
        )}
      </div>

      {/* Channel-specific binding fields */}
      {channel === 'telegram' && (
        <>
          {/* Chat ID + Type */}
          <div className="flex gap-2.5">
            <div className="flex-1">
              <label className="text-[11px] text-gray-500 mb-1 block">Chat ID <span className="text-red-400">*</span></label>
              <input
                className={`w-full text-sm font-mono border rounded-lg px-3 py-2 outline-none transition-colors ${errors.tgChatId ? 'border-red-300 bg-red-50' : 'border-gray-200 focus:border-[#5BBFE8]'}`}
                placeholder="-100123456789"
                value={tgChatId}
                onChange={e => handleTgChange(e.target.value, tgChatType)}
              />
              {errors.tgChatId
                ? <p className="text-[11px] text-red-500 mt-0.5">{errors.tgChatId}</p>
                : <p className="text-[11px] text-gray-400 mt-0.5">可用 @userinfobot 获取</p>
              }
            </div>
            <div className="w-28 flex-shrink-0">
              <label className="text-[11px] text-gray-500 mb-1 block">类型</label>
              <select
                className="w-full text-sm border border-gray-200 rounded-lg px-3 py-2 outline-none focus:border-[#5BBFE8] bg-white"
                value={tgChatType}
                onChange={e => handleTgChange(tgChatId, e.target.value as 'group' | 'user')}
              >
                <option value="group">Group</option>
                <option value="user">User</option>
              </select>
            </div>
          </div>
          {/* Bot Token */}
          <div>
            <label className="text-[11px] text-gray-500 mb-1 block">
              Bot Token{tgChatType === 'user' ? <span className="text-red-400"> *</span> : '（可选）'}
            </label>
            <input
              className={`w-full text-sm font-mono border rounded-lg px-3 py-2 outline-none transition-colors ${errors.botToken ? 'border-red-300 bg-red-50' : 'border-gray-200 focus:border-[#5BBFE8]'}`}
              placeholder={tgChatType === 'user' ? '必填，绑定此用户的专属 Bot' : '空 = 使用 .env 中的默认 Bot'}
              value={botToken}
              onChange={e => setBotToken(e.target.value)}
            />
            {errors.botToken && <p className="text-[11px] text-red-500 mt-0.5">{errors.botToken}</p>}
          </div>
          {/* Trigger */}
          <div>
            <label className="text-[11px] text-gray-500 mb-1 block">需要@触发</label>
            <div className="flex items-center gap-2 py-1">
              <Toggle value={requiresTrigger} onChange={setRequiresTrigger} />
              <span className="text-[11px] text-gray-500">{requiresTrigger ? '开启' : '关闭'}</span>
            </div>
          </div>
        </>
      )}

      {channel === 'feishu' && (
        <>
          {/* Feishu Chat JID（可选） */}
          <div>
            <label className="text-[11px] text-gray-500 mb-1 block">Chat JID <span className="text-gray-400">（可选）</span></label>
            <input
              className={`w-full text-sm font-mono border rounded-lg px-3 py-2 outline-none transition-colors ${errors.jid ? 'border-red-300 bg-red-50' : 'border-gray-200 focus:border-[#5BBFE8]'}`}
              placeholder="feishu:group:oc_xxx 或 feishu:user:ou_xxx（可留空）"
              value={jid}
              onChange={e => setJid(e.target.value)}
            />
            {errors.jid
              ? <p className="text-[11px] text-red-500 mt-0.5">{errors.jid}</p>
              : <p className="text-[11px] text-gray-400 mt-0.5">留空将在 Bot 收到第一条消息后自动完成绑定</p>
            }
          </div>
          {/* Trigger */}
          <div>
            <label className="text-[11px] text-gray-500 mb-1 block">需要@触发</label>
            <div className="flex items-center gap-2 py-1">
              <Toggle value={requiresTrigger} onChange={setRequiresTrigger} />
              <span className="text-[11px] text-gray-500">{requiresTrigger ? '开启' : '关闭'}</span>
            </div>
          </div>
          {/* App ID + App Secret */}
          <div className="bg-gray-50 rounded-lg p-3 space-y-2.5">
            <p className="text-[11px] font-medium text-gray-600">飞书应用凭证（可选，空则使用全局默认）</p>
            <div className="flex gap-2.5">
              <div className="flex-1">
                <label className="text-[11px] text-gray-500 mb-1 block">App ID</label>
                <input
                  className={`w-full text-sm font-mono border rounded-lg px-3 py-2 outline-none transition-colors ${errors.appId ? 'border-red-300 bg-red-50' : 'border-gray-200 focus:border-[#5BBFE8]'}`}
                  placeholder="cli_xxx"
                  value={botToken}
                  onChange={e => setBotToken(e.target.value)}
                />
                {errors.appId && <p className="text-[11px] text-red-500 mt-0.5">{errors.appId}</p>}
              </div>
              <div className="flex-1">
                <label className="text-[11px] text-gray-500 mb-1 block">App Secret</label>
                <input
                  className={`w-full text-sm font-mono border rounded-lg px-3 py-2 outline-none transition-colors ${errors.appSecret ? 'border-red-300 bg-red-50' : 'border-gray-200 focus:border-[#5BBFE8]'}`}
                  placeholder="必填（填 App ID 时）"
                  type="password"
                  value={appSecret}
                  onChange={e => setAppSecret(e.target.value)}
                />
                {errors.appSecret && <p className="text-[11px] text-red-500 mt-0.5">{errors.appSecret}</p>}
              </div>
            </div>
          </div>
        </>
      )}

      {channel === 'qq' && (
        <>
          {/* QQ App ID + App Secret（必填） */}
          <div className="bg-gray-50 rounded-lg p-3 space-y-2.5">
            <p className="text-[11px] font-medium text-gray-600">QQ 应用凭证</p>
            <div className="flex gap-2.5">
              <div className="flex-1">
                <label className="text-[11px] text-gray-500 mb-1 block">App ID <span className="text-red-400">*</span></label>
                <input
                  className={`w-full text-sm font-mono border rounded-lg px-3 py-2 outline-none transition-colors ${errors.appId ? 'border-red-300 bg-red-50' : 'border-gray-200 focus:border-[#5BBFE8]'}`}
                  placeholder="QQ 开放平台 AppID"
                  value={botToken}
                  onChange={e => setBotToken(e.target.value)}
                />
                {errors.appId && <p className="text-[11px] text-red-500 mt-0.5">{errors.appId}</p>}
              </div>
              <div className="flex-1">
                <label className="text-[11px] text-gray-500 mb-1 block">App Secret <span className="text-red-400">*</span></label>
                <input
                  className={`w-full text-sm font-mono border rounded-lg px-3 py-2 outline-none transition-colors ${errors.appSecret ? 'border-red-300 bg-red-50' : 'border-gray-200 focus:border-[#5BBFE8]'}`}
                  placeholder="QQ 开放平台 AppSecret"
                  type="password"
                  value={appSecret}
                  onChange={e => setAppSecret(e.target.value)}
                />
                {errors.appSecret && <p className="text-[11px] text-red-500 mt-0.5">{errors.appSecret}</p>}
              </div>
            </div>
            {/* Sandbox toggle */}
            <div className="flex items-center gap-2">
              <Toggle value={qqSandbox} onChange={setQQSandbox} />
              <span className="text-[11px] text-gray-500">沙盒模式（Sandbox）</span>
            </div>
          </div>
          {/* Trigger */}
          <div>
            <label className="text-[11px] text-gray-500 mb-1 block">需要@触发</label>
            <div className="flex items-center gap-2 py-1">
              <Toggle value={requiresTrigger} onChange={setRequiresTrigger} />
              <span className="text-[11px] text-gray-500">{requiresTrigger ? '开启' : '关闭'}</span>
            </div>
          </div>
          <p className="text-[11px] text-gray-400">
            Chat JID 将在 Bot 收到第一条 QQ 消息后自动完成绑定，无需手动填写。
          </p>
        </>
      )}

      {/* Actions */}
      <div className="flex justify-end gap-2 pt-1">
        <button
          onClick={onCancel}
          className="text-sm px-3 py-1.5 rounded-lg border border-gray-200 text-gray-600 hover:bg-gray-50 transition-colors"
        >取消</button>
        <button
          onClick={handleSubmit}
          disabled={submitting}
          className="text-sm px-4 py-1.5 rounded-lg bg-[#5BBFE8] text-white hover:bg-[#3AAAD4] transition-colors disabled:opacity-50"
        >
          {submitting ? '创建中…' : '创建 Agent'}
        </button>
      </div>
    </div>
  );
}

// ===== Agent Management Tab =====

interface AgentsTabProps {
  groups: GroupInfo[];
  onRegisterGroup: (data: RegisterGroupPayload) => void;
  onRegisterFeishuApp: (appId: string, appSecret: string, domain?: string) => void;
  onRegisterQQApp: (appId: string, appSecret: string, sandbox?: boolean) => void;
  onUnregisterGroup: (jid: string) => void;
  onUpdateGroup: (jid: string, updates: UpdateGroupPayload) => void;
}

function AgentsTab({ groups, onRegisterGroup, onRegisterFeishuApp, onRegisterQQApp, onUnregisterGroup, onUpdateGroup }: AgentsTabProps) {
  const [showCreate, setShowCreate] = useState(false);

  const adminGroup = groups.find(g => g.isAdmin);
  const otherGroups = groups.filter(g => !g.isAdmin);

  const handleCreate = (data: RegisterGroupPayload) => {
    onRegisterGroup(data);
    setShowCreate(false);
  };

  const handleEditName = (jid: string, name: string) => {
    // Uniqueness check
    if (groups.some(g => g.jid !== jid && g.name.toLowerCase() === name.toLowerCase())) {
      return; // silently skip duplicate name
    }
    onUpdateGroup(jid, { name });
  };

  return (
    <div className="space-y-3">
      {/* Section header */}
      <div className="flex items-center justify-between">
        <p className="text-[11px] font-semibold text-[#5BBFE8] uppercase tracking-wide">
          Agents <span className="text-gray-400 font-normal normal-case">({groups.length})</span>
        </p>
        {!showCreate && (
          <button
            onClick={() => setShowCreate(true)}
            className="flex items-center gap-1 text-[11px] text-[#5BBFE8] hover:text-[#3AAAD4] font-medium transition-colors"
          >
            <svg xmlns="http://www.w3.org/2000/svg" className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" strokeWidth={2.5} stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" d="M12 4.5v15m7.5-7.5h-15" />
            </svg>
            新增
          </button>
        )}
      </div>

      {/* Create form */}
      {showCreate && (
        <CreateAgentForm
          groups={groups}
          onSubmit={handleCreate}
          onRegisterFeishuApp={onRegisterFeishuApp}
          onRegisterQQApp={onRegisterQQApp}
          onCancel={() => setShowCreate(false)}
        />
      )}

      {/* Admin agent — always at top */}
      {adminGroup && (
        <div className="group">
          <AgentRow
            group={adminGroup}
            onDelete={() => {/* admin cannot be deleted */}}
            onEditName={handleEditName}
          />
        </div>
      )}

      {/* Regular agents */}
      {otherGroups.length > 0 && (
        <div className="space-y-2">
          {otherGroups.map(g => (
            <div key={g.jid} className="group">
              <AgentRow
                group={g}
                onDelete={onUnregisterGroup}
                onEditName={handleEditName}
              />
            </div>
          ))}
        </div>
      )}

      {groups.length === 0 && (
        <p className="text-[11px] text-gray-400 text-center py-4">暂无 Agent</p>
      )}

      {/* Dispatch note */}
      {otherGroups.length > 0 && (
        <div className="bg-blue-50/60 rounded-xl p-3 mt-1">
          <p className="text-[11px] text-[#3AAAD4] leading-relaxed">
            💡 主 Agent 可通过 <span className="font-mono bg-white px-1 rounded">send_message</span> 工具向其他 Agent 所在群组发消息，
            或在自然语言中通过 Agent 名称指代调度。
          </p>
        </div>
      )}
    </div>
  );
}

// ===== LLM Add Model Slide Panel =====

interface AddModelPanelProps {
  onClose: () => void;
  onSaved: () => void;
}

function AddModelPanel({ onClose, onSaved }: AddModelPanelProps) {
  const [provider, setProvider]         = useState('anthropic');
  const [baseURL, setBaseURL]           = useState(PROVIDERS['anthropic'].baseURL);
  const [apiKey, setApiKey]             = useState('');
  const [adapt, setAdapt]               = useState<'openai' | 'anthropic'>('anthropic');
  const [modelName, setModelName]       = useState('');
  const [selectedModel, setSelectedModel] = useState('');
  const [isManual, setIsManual]         = useState(false);
  const [availableModels, setAvailableModels] = useState<string[]>([]);
  const [maxTokens, setMaxTokens]       = useState(8192);
  const [contextLength, setContextLength] = useState(128000);
  const [showKey, setShowKey]           = useState(false);
  const [fetching, setFetching]         = useState(false);
  const [testStatus, setTestStatus]     = useState<{ msg: string; type: 'ok' | 'err' | 'loading' | '' }>({ msg: '', type: '' });
  const [saving, setSaving]             = useState(false);
  const [connTested, setConnTested]     = useState(false);
  const [connOk, setConnOk]             = useState(false);

  const currentModel = isManual ? modelName : selectedModel;

  // 当模型名变化时自动填入已知限制
  useEffect(() => {
    if (!currentModel) return;
    const limits = lookupModelLimits(currentModel);
    if (limits) {
      setMaxTokens(limits.maxTokens);
      setContextLength(limits.contextLength);
    }
  }, [currentModel]);

  const handleProviderChange = (p: string) => {
    const def = PROVIDERS[p];
    setProvider(p);
    setBaseURL(def.baseURL);
    setAdapt(def.defaultAdapt);
    setApiKey('');
    setModelName('');
    setSelectedModel('');
    setAvailableModels([]);
    setConnTested(false); setConnOk(false);
    setTestStatus({ msg: '', type: '' });
    setMaxTokens(def.defaultMaxTokens ?? 8192);
    setContextLength(def.defaultContextLength ?? 128000);
  };

  const handleFetchModels = async () => {
    if (!baseURL) { setTestStatus({ msg: '请输入模型地址', type: 'err' }); return; }
    if (!apiKey)  { setTestStatus({ msg: '请输入 API Key', type: 'err' }); return; }
    setFetching(true);
    setTestStatus({ msg: '正在获取模型列表…', type: 'loading' });
    // Use provider-specific models URL if available (some providers use a different endpoint for listing models)
    const fetchBaseURL = PROVIDERS[provider]?.modelsUrl ?? baseURL;
    try {
      const r = await fetch('/api/llm-config/models', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ baseURL: fetchBaseURL, apiKey, adapt }),
      });
      const data = await r.json() as { success: boolean; models?: string[]; message?: string };
      if (data.success && data.models?.length) {
        setAvailableModels(data.models);
        setSelectedModel(data.models[0]);
        setTestStatus({ msg: `✓ 获取到 ${data.models.length} 个模型`, type: 'ok' });
        setTimeout(() => setTestStatus({ msg: '', type: '' }), 3000);
      } else {
        setTestStatus({ msg: `✗ ${data.message ?? '获取失败'}`, type: 'err' });
      }
    } catch {
      setTestStatus({ msg: '✗ 网络错误', type: 'err' });
    } finally {
      setFetching(false);
    }
  };

  const handleTest = async () => {
    if (!baseURL || !apiKey) { setTestStatus({ msg: '请填写模型地址和 API Key', type: 'err' }); return; }
    setTestStatus({ msg: '正在测试连接…', type: 'loading' });
    // Use provider-specific models URL for connection test (avoids auth mismatch on models endpoint)
    const testBaseURL = PROVIDERS[provider]?.modelsUrl ?? baseURL;
    try {
      const r = await fetch('/api/llm-config/test', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ baseURL: testBaseURL, apiKey, adapt }),
      });
      const data = await r.json() as { success: boolean; message?: string };
      setConnTested(true); setConnOk(data.success);
      setTestStatus({ msg: data.success ? '✓ 连接成功' : `✗ ${data.message ?? '连接失败'}`, type: data.success ? 'ok' : 'err' });
    } catch {
      setConnTested(true); setConnOk(false);
      setTestStatus({ msg: '✗ 网络错误', type: 'err' });
    }
  };

  const handleSave = async () => {
    if (!apiKey)         { setTestStatus({ msg: '请输入 API Key', type: 'err' }); return; }
    if (!currentModel)   { setTestStatus({ msg: '请选择或输入模型名称', type: 'err' }); return; }
    if (!baseURL)        { setTestStatus({ msg: '请输入模型地址', type: 'err' }); return; }
    if (!connTested)     { setTestStatus({ msg: '⚠ 请先点击「测试连接」', type: 'err' }); return; }
    if (!connOk)         { setTestStatus({ msg: '⚠ 连接测试未通过，请修正后重新测试', type: 'err' }); return; }
    setSaving(true);
    const label = `${currentModel} (${PROVIDERS[provider]?.name ?? provider})`;
    try {
      const r = await fetch('/api/llm-config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ label, provider, baseURL, apiKey, modelName: currentModel, adapt, maxTokens, contextLength }),
      });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      onSaved();
      onClose();
    } catch {
      setTestStatus({ msg: '保存失败，请重试', type: 'err' });
    } finally {
      setSaving(false);
    }
  };

  const def = PROVIDERS[provider];

  return (
    <aside
      className="relative h-full bg-white border-l border-gray-100 flex flex-col shadow-lg overflow-y-auto"
      style={{ width: 480 }}
      onClick={e => e.stopPropagation()}
    >
      {/* Header */}
      <div className="flex items-center justify-between px-5 py-4 border-b border-gray-100 flex-shrink-0 sticky top-0 bg-white z-10">
        <span className="font-semibold text-gray-800 text-sm">添加模型</span>
        <button onClick={onClose} className="w-6 h-6 flex items-center justify-center rounded-lg hover:bg-gray-100 text-gray-400 hover:text-gray-600 transition-colors">
          <svg xmlns="http://www.w3.org/2000/svg" className="w-4 h-4" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" d="M6 18 18 6M6 6l12 12" />
          </svg>
        </button>
      </div>

      <div className="flex-1 p-5 space-y-4">
        {/* Provider */}
        <div>
          <label className="text-[11px] text-gray-500 mb-1 block">服务提供商</label>
          <select
            className="w-full text-sm border border-gray-200 rounded-lg px-3 py-2 outline-none focus:border-[#5BBFE8] bg-white"
            value={provider}
            onChange={e => handleProviderChange(e.target.value)}
          >
            {PROVIDER_ORDER.map(k => (
              <option key={k} value={k}>{PROVIDERS[k].name}</option>
            ))}
          </select>
        </div>

        {/* Base URL */}
        <div>
          <label className="text-[11px] text-gray-500 mb-1 block">模型地址</label>
          <input
            className="w-full text-sm border border-gray-200 rounded-lg px-3 py-2 outline-none focus:border-[#5BBFE8] transition-colors"
            placeholder={def.baseURLPlaceholder ?? def.baseURL}
            value={baseURL}
            onChange={e => { setBaseURL(e.target.value); setConnTested(false); setConnOk(false); }}
          />
        </div>

        {/* API Key */}
        <div>
          <label className="text-[11px] text-gray-500 mb-1 block">API Key</label>
          <div className="relative">
            <input
              type={showKey ? 'text' : 'password'}
              className="w-full text-sm border border-gray-200 rounded-lg px-3 py-2 pr-10 outline-none focus:border-[#5BBFE8] transition-colors"
              placeholder={def.apiKeyPlaceholder ?? '输入您的 API Key'}
              value={apiKey}
              onChange={e => { setApiKey(e.target.value.trim()); setConnTested(false); setConnOk(false); }}
            />
            <button
              type="button"
              onClick={() => setShowKey(v => !v)}
              className="absolute right-2.5 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-600"
            >
              {showKey ? (
                <svg xmlns="http://www.w3.org/2000/svg" className="w-4 h-4" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" d="M3.98 8.223A10.477 10.477 0 0 0 1.934 12C3.226 16.338 7.244 19.5 12 19.5c.993 0 1.953-.138 2.863-.395M6.228 6.228A10.451 10.451 0 0 1 12 4.5c4.756 0 8.773 3.162 10.065 7.498a10.522 10.522 0 0 1-4.293 5.774M6.228 6.228 3 3m3.228 3.228 3.65 3.65m7.894 7.894L21 21m-3.228-3.228-3.65-3.65m0 0a3 3 0 1 0-4.243-4.243m4.242 4.242L9.88 9.88" />
                </svg>
              ) : (
                <svg xmlns="http://www.w3.org/2000/svg" className="w-4 h-4" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" d="M2.036 12.322a1.012 1.012 0 0 1 0-.639C3.423 7.51 7.36 4.5 12 4.5c4.638 0 8.573 3.007 9.963 7.178.07.207.07.431 0 .639C20.577 16.49 16.64 19.5 12 19.5c-4.638 0-8.573-3.007-9.963-7.178Z" />
                  <path strokeLinecap="round" strokeLinejoin="round" d="M15 12a3 3 0 1 1-6 0 3 3 0 0 1 6 0Z" />
                </svg>
              )}
            </button>
          </div>
        </div>

        {/* Model name */}
        <div>
          <div className="flex items-center justify-between mb-1">
            <label className="text-[11px] text-gray-500">模型名称</label>
            <button
              type="button"
              className="text-[11px] text-[#5BBFE8] hover:text-[#3AAAD4]"
              onClick={() => setIsManual(v => !v)}
            >
              {isManual ? '从列表选择' : '手动输入'}
            </button>
          </div>
          {isManual ? (
            <input
              className="w-full text-sm border border-gray-200 rounded-lg px-3 py-2 outline-none focus:border-[#5BBFE8] transition-colors"
              placeholder="手动输入模型名称"
              value={modelName}
              onChange={e => { setModelName(e.target.value); setConnTested(false); setConnOk(false); }}
            />
          ) : (
            <div className="flex gap-2">
              <select
                className="flex-1 min-w-0 text-sm border border-gray-200 rounded-lg px-3 py-2 outline-none focus:border-[#5BBFE8] bg-white"
                value={selectedModel}
                onChange={e => { setSelectedModel(e.target.value); setConnTested(false); setConnOk(false); }}
              >
                {availableModels.length === 0
                  ? <option value="">-- 请先获取模型列表 --</option>
                  : availableModels.map(m => <option key={m} value={m}>{m}</option>)
                }
              </select>
              <button
                type="button"
                onClick={handleFetchModels}
                disabled={fetching}
                className="px-3 py-2 text-xs rounded-lg border border-gray-200 text-gray-600 hover:bg-gray-50 disabled:opacity-50 transition-colors whitespace-nowrap"
              >
                {fetching ? '获取中…' : '获取模型'}
              </button>
            </div>
          )}
        </div>

        {/* API type */}
        <div>
          <label className="text-[11px] text-gray-500 mb-1 block">API 类型</label>
          <select
            className="w-full text-sm border border-gray-200 rounded-lg px-3 py-2 outline-none focus:border-[#5BBFE8] bg-white"
            value={adapt}
            onChange={e => setAdapt(e.target.value as 'openai' | 'anthropic')}
          >
            <option value="openai">OpenAI 格式</option>
            <option value="anthropic">Anthropic 格式</option>
          </select>
        </div>

        {/* Max tokens + context length */}
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="text-[11px] text-gray-500 mb-1 block">最大生成 token 数</label>
            <select
              className="w-full text-sm border border-gray-200 rounded-lg px-3 py-2 outline-none focus:border-[#5BBFE8] bg-white"
              value={maxTokens}
              onChange={e => setMaxTokens(Number(e.target.value))}
            >
              {ensureOption(DEFAULT_MAX_TOKENS_OPTIONS, maxTokens).map(v => (
                <option key={v} value={v}>{Math.round(v / 1000)}k</option>
              ))}
            </select>
          </div>
          <div>
            <label className="text-[11px] text-gray-500 mb-1 block">上下文窗口大小</label>
            <select
              className="w-full text-sm border border-gray-200 rounded-lg px-3 py-2 outline-none focus:border-[#5BBFE8] bg-white"
              value={contextLength}
              onChange={e => setContextLength(Number(e.target.value))}
            >
              {ensureOption(DEFAULT_CONTEXT_LENGTH_OPTIONS, contextLength).map(v => (
                <option key={v} value={v}>{Math.round(v / 1000)}k</option>
              ))}
            </select>
          </div>
        </div>

        {/* Status */}
        {testStatus.type && (
          <p className={`text-[11px] px-1 ${testStatus.type === 'ok' ? 'text-green-600' : testStatus.type === 'err' ? 'text-red-500' : 'text-gray-400'}`}>
            {testStatus.msg}
          </p>
        )}

        {/* Actions */}
        <div className="flex gap-2 pt-1">
          <button
            type="button"
            onClick={handleTest}
            disabled={testStatus.type === 'loading' || saving}
            className="flex-1 text-sm py-2 rounded-lg border border-gray-200 text-gray-600 hover:bg-gray-50 disabled:opacity-50 transition-colors"
          >
            {testStatus.type === 'loading' ? '测试中…' : '测试连接'}
          </button>
          <button
            type="button"
            onClick={handleSave}
            disabled={saving || testStatus.type === 'loading'}
            className="flex-1 text-sm py-2 rounded-lg bg-[#5BBFE8] text-white hover:bg-[#3AAAD4] disabled:opacity-50 transition-colors"
          >
            {saving ? '添加中…' : '添加模型'}
          </button>
        </div>
      </div>
    </aside>
  );
}

// ===== LLM Config Tab =====

interface LLMTabProps {
  onOpenAdd: () => void;
  refreshKey: number;
}

function LLMTab({ onOpenAdd, refreshKey }: LLMTabProps) {
  const [configs, setConfigs]   = useState<LLMConfig[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [semaModel, setSemaModel] = useState<{ modelName: string; provider: string } | null>(null);

  const load = async () => {
    try {
      const r = await fetch('/api/llm-config');
      const data = await r.json() as { configs: LLMConfig[]; activeId: string | null; semaModel?: { modelName: string; provider: string } | null };
      setConfigs(data.configs);
      setActiveId(data.activeId);
      setSemaModel(data.semaModel ?? null);
    } catch { /* ignore */ }
  };

  useEffect(() => { load(); }, [refreshKey]);

  const handleSetActive = async (id: string) => {
    await fetch('/api/llm-config/active', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id }),
    });
    setActiveId(id);
    // 乐观更新 semaModel 显示
    const cfg = configs.find(c => c.id === id);
    if (cfg) setSemaModel({ modelName: cfg.modelName, provider: cfg.provider });
  };

  const handleDelete = async (id: string) => {
    await fetch(`/api/llm-config/${encodeURIComponent(id)}`, { method: 'DELETE' });
    load();
  };

  const activeConfig = configs.find(c => c.id === activeId);
  // 显示来源：优先展示已选中的 config，其次展示 sema-core 实际运行的模型
  const displayModel = activeConfig
    ? { modelName: activeConfig.modelName, providerLabel: PROVIDERS[activeConfig.provider]?.name ?? activeConfig.provider }
    : semaModel
    ? { modelName: semaModel.modelName, providerLabel: PROVIDERS[semaModel.provider]?.name ?? semaModel.provider }
    : null;

  return (
    <div className="space-y-3">
      {/* Current active model */}
      <div>
        <p className="text-[11px] font-semibold text-[#5BBFE8] uppercase tracking-wide mb-2">当前使用模型</p>
        {displayModel ? (
          <div className="bg-[#EEF7FD]/60 border border-[#5BBFE8]/20 rounded-xl p-3.5">
            <div className="flex items-center gap-2">
              <div className="w-2 h-2 rounded-full bg-[#5BBFE8] flex-shrink-0" />
              <div className="min-w-0">
                <p className="text-sm font-medium text-gray-800 truncate">{displayModel.modelName}</p>
                <p className="text-[11px] text-gray-400">{displayModel.providerLabel}</p>
              </div>
            </div>
          </div>
        ) : (
          <div className="bg-gray-50 rounded-xl p-3.5">
            <p className="text-[11px] text-gray-400">暂未配置模型</p>
          </div>
        )}
      </div>

      {/* Saved configs list */}
      <div>
        <div className="flex items-center justify-between mb-2">
          <p className="text-[11px] font-semibold text-[#5BBFE8] uppercase tracking-wide">
            已配置模型 <span className="text-gray-400 font-normal normal-case">({configs.length})</span>
          </p>
          <button
            onClick={onOpenAdd}
            className="flex items-center gap-1 text-[11px] text-[#5BBFE8] hover:text-[#3AAAD4] font-medium transition-colors"
          >
            <svg xmlns="http://www.w3.org/2000/svg" className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" strokeWidth={2.5} stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" d="M12 4.5v15m7.5-7.5h-15" />
            </svg>
            新增
          </button>
        </div>

        {configs.length === 0 ? (
          <p className="text-[11px] text-gray-400 text-center py-6">暂无配置，点击「新增」添加模型</p>
        ) : (
          <div className="space-y-2">
            {configs.map(c => {
              const isActive = c.id === activeId;
              return (
                <div
                  key={c.id}
                  onClick={() => handleSetActive(c.id)}
                  className={`rounded-xl p-3 border cursor-pointer transition-all ${
                    isActive
                      ? 'bg-[#EEF7FD]/60 border-[#5BBFE8]/30'
                      : 'bg-gray-50 border-gray-100 hover:border-[#5BBFE8]/20 hover:bg-[#EEF7FD]/30'
                  }`}
                >
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-1.5">
                        {isActive && <div className="w-1.5 h-1.5 rounded-full bg-[#5BBFE8] flex-shrink-0" />}
                        <p className="text-sm font-medium text-gray-800 truncate">{c.modelName}</p>
                      </div>
                      <p className="text-[11px] text-gray-400 mt-0.5">{PROVIDERS[c.provider]?.name ?? c.provider} · {c.adapt === 'anthropic' ? 'Anthropic 格式' : 'OpenAI 格式'}</p>
                      <p className="text-[11px] text-gray-300 font-mono truncate mt-0.5">{c.baseURL}</p>
                    </div>
                    <button
                      onClick={e => { e.stopPropagation(); handleDelete(c.id); }}
                      className="flex-shrink-0 w-6 h-6 flex items-center justify-center rounded-lg hover:bg-red-50 text-gray-300 hover:text-red-400 transition-colors"
                    >
                      <svg xmlns="http://www.w3.org/2000/svg" className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor">
                        <path strokeLinecap="round" strokeLinejoin="round" d="m14.74 9-.346 9m-4.788 0L9.26 9m9.968-3.21c.342.052.682.107 1.022.166m-1.022-.165L18.16 19.673a2.25 2.25 0 0 1-2.244 2.077H8.084a2.25 2.25 0 0 1-2.244-2.077L4.772 5.79m14.456 0a48.108 48.108 0 0 0-3.478-.397m-12 .562c.34-.059.68-.114 1.022-.165m0 0a48.11 48.11 0 0 1 3.478-.397m7.5 0v-.916c0-1.18-.91-2.164-2.09-2.201a51.964 51.964 0 0 0-3.32 0c-1.18.037-2.09 1.022-2.09 2.201v.916m7.5 0a48.667 48.667 0 0 0-7.5 0" />
                      </svg>
                    </button>
                  </div>
                  {isActive && (
                    <p className="text-[10px] text-[#5BBFE8] mt-1.5 font-medium">● 使用中</p>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}

// ===== Tab Bar =====

function TabBar({ active, onChange }: { active: Tab; onChange: (t: Tab) => void }) {
  const tabs: { id: Tab; label: string }[] = [
    { id: 'permissions', label: '权限' },
    { id: 'agents',      label: 'Agents' },
    { id: 'llm',         label: 'LLM' },
  ];
  return (
    <div className="flex border-b border-gray-100">
      {tabs.map(t => (
        <button
          key={t.id}
          onClick={() => onChange(t.id)}
          className={`flex-1 py-2.5 text-xs font-medium transition-colors border-b-2 -mb-px ${
            active === t.id
              ? 'text-[#5BBFE8] border-[#5BBFE8]'
              : 'text-gray-400 border-transparent hover:text-gray-600'
          }`}
        >
          {t.label}
        </button>
      ))}
    </div>
  );
}

// ===== Main SettingsPanel =====

export function SettingsPanel({ onClose, groups, onRegisterGroup, onRegisterFeishuApp, onRegisterQQApp, onUnregisterGroup, onUpdateGroup }: Props) {
  const [tab, setTab]           = useState<Tab>('agents');
  const [showAddLLM, setShowAddLLM] = useState(false);
  const [llmRefreshKey, setLlmRefreshKey] = useState(0);

  return (
    <div className="fixed inset-0 z-50 flex">
      <div className="absolute inset-0 bg-black/20" onClick={onClose} />

      <aside
        className="relative h-full bg-white border-r border-gray-100 flex flex-col shadow-lg"
        style={{ width: 360 }}
        onClick={e => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-4 py-3 border-b border-gray-100 flex-shrink-0">
          <span className="font-semibold text-gray-800 text-sm">Settings</span>
          <button
            onClick={onClose}
            className="w-6 h-6 flex items-center justify-center rounded-lg hover:bg-gray-100 text-gray-400 hover:text-gray-600 transition-colors"
            aria-label="Close"
          >
            <svg xmlns="http://www.w3.org/2000/svg" className="w-4 h-4" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" d="M6 18 18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        {/* Tabs */}
        <div className="px-4 flex-shrink-0">
          <TabBar active={tab} onChange={t => { setTab(t); setShowAddLLM(false); }} />
        </div>

        {/* Content */}
        <div className="flex-1 overflow-y-auto p-4">
          {tab === 'permissions' && <PermissionsTab />}
          {tab === 'agents' && (
            <AgentsTab
              groups={groups}
              onRegisterGroup={onRegisterGroup}
              onRegisterFeishuApp={onRegisterFeishuApp}
              onRegisterQQApp={onRegisterQQApp}
              onUnregisterGroup={onUnregisterGroup}
              onUpdateGroup={onUpdateGroup}
            />
          )}
          {tab === 'llm' && (
            <LLMTab
              onOpenAdd={() => setShowAddLLM(true)}
              refreshKey={llmRefreshKey}
            />
          )}
        </div>
      </aside>

      {/* LLM add model slide panel */}
      {showAddLLM && (
        <AddModelPanel
          onClose={() => setShowAddLLM(false)}
          onSaved={() => setLlmRefreshKey(k => k + 1)}
        />
      )}
    </div>
  );
}
