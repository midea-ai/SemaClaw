/**
 * GroupManager — 群组绑定的注册、查询与目录管理
 *
 * 目录结构（新）：
 *   ~/semaclaw/agents/{folder}/       — agentDataDir（SOUL.md, memory/）
 *   ~/semaclaw/workspace/{folder}/    — defaultWorkingDir（项目文档，无明确项目时工作于此）
 *
 * 全局配置：
 *   ~/.semaclaw/config.json           — 用户可编辑；allowedWorkDirs 等 per-agent 配置
 *   启动时读取，覆盖 DB 中对应字段（config.json 优先级高于 DB）
 */

import * as fs from 'fs';
import * as path from 'path';
import {
  upsertGroup,
  getGroup,
  listGroups,
  deleteGroup,
  deleteGroupByFolder,
  renameGroupJid,
  touchGroupActive,
} from '../db/db';
import { GroupBinding } from '../types';
import { config } from '../config';

// ===== 默认工具权限 =====

/**
 * 普通群组/主频道均使用 null（全部工具可用）。
 * 具体操作的安全管控由 skip*Permission = false + PermissionBridge 实现。
 */
export const DEFAULT_GROUP_TOOLS: string[] | null = null;
export const ADMIN_DEFAULT_TOOLS: string[] | null = null;

// ===== Soul（CLAUDE.md）模板 =====

/**
 * agentDataDir/CLAUDE.md — agent 人格/身份/长期指令（永远加载）
 * workingDir/CLAUDE.md   — 当前项目上下文（切换工作目录时加载，可由用户自定义）
 *
 * 本模板写入 agentDataDir，告知 agent 自身身份与行为规范。
 */
function defaultSoulMd(folder: string, name: string): string {
  return `# ${name}

You are a helpful AI assistant.

## Identity

Your agent ID is \`${folder}\`.
Your memory is stored in \`memory/\` within your agent directory.

## Guidelines

- Be helpful, concise, and friendly
- Respond in the language the user is using
- Keep responses focused and actionable

## Memory Management

Before answering, check \`MEMORY.md\` in your memory directory for relevant context.
After important interactions, update your memory with key information.

## Working Directory

Your default workspace is \`~/semaclaw/workspace/${folder}/\`.
When the user mentions working on a specific project at a particular path,
use the WorkspaceTool to switch to that directory.
Return to your default workspace when the task is complete or the topic changes.
`;
}

// ===== 目录管理 =====

/**
 * 确保 agent 目录结构存在。幂等，安全重复调用。
 *
 * 创建：
 *   agentsDir/{folder}/               — agentDataDir
 *   agentsDir/{folder}/memory/
 *   agentsDir/{folder}/.sema/sessions/
 *   agentsDir/{folder}/SOUL.md        （仅在不存在时创建 soul 模板）
 *   agentsDir/{folder}/MEMORY.md      （仅在不存在时创建空文件）
 *
 *   workspaceDir/{folder}/            — defaultWorkingDir（项目工作区）
 */
export function ensureAgentDirs(folder: string, name = folder): {
  agentDataDir: string;
  workspaceDir: string;
} {
  const agentDataDir = path.resolve(config.paths.agentsDir, folder);
  const workspaceDir = path.resolve(config.paths.workspaceDir, folder);

  // agent 目录
  fs.mkdirSync(path.join(agentDataDir, 'memory'), { recursive: true });
  fs.mkdirSync(path.join(agentDataDir, '.sema', 'sessions'), { recursive: true });

  const soulMd = path.join(agentDataDir, 'SOUL.md');
  if (!fs.existsSync(soulMd)) {
    fs.writeFileSync(soulMd, defaultSoulMd(folder, name), 'utf8');
  }

  const memoryMd = path.join(agentDataDir, 'MEMORY.md');
  if (!fs.existsSync(memoryMd)) {
    fs.writeFileSync(memoryMd, '# Memory\n\n', 'utf8');
  }

  // workspace 目录（空目录即可，用户自行放项目文档）
  fs.mkdirSync(workspaceDir, { recursive: true });

  return { agentDataDir, workspaceDir };
}

// ===== 全局配置 =====

interface GlobalAgentConfig {
  allowedWorkDirs?: string[] | null;
}

/**
 * config.json 中存储的群组条目（非 admin 群组，序列化子集）。
 * 不含 isAdmin（始终 false）、allowedPaths（废弃）、lastActive/addedAt（运行时字段）。
 */
export interface GroupConfigEntry {
  jid: string;
  folder: string;
  name: string;
  channel?: string;
  requiresTrigger?: boolean;
  allowedTools?: string[] | null;
  allowedWorkDirs?: string[] | null;
  botToken?: string | null;
  maxMessages?: number | null;
}

/** 飞书额外应用凭证（子 agent 用） */
export interface FeishuAppConfig {
  appSecret: string;
  domain?: string;
}

/** QQ 额外应用凭证（子 agent 用） */
export interface QQAppConfig {
  appSecret: string;
  sandbox?: boolean;
}

/** 微信额外账户配置（凭证在 ~/.semaclaw/wechat/accounts/{folder}.json） */
export interface WeixinAccountConfig {
  name?: string;
}

/** config.json 中的额外 Telegram Bot 绑定条目 */
export interface TelegramBotConfig {
  /** Bot token（BotFather 获取） */
  token: string;
  /** 绑定的管理员 Telegram User ID */
  adminUserId: string;
  /** 绑定到哪个 agent folder */
  folder: string;
  /** 群组显示名称（可选，默认 "Admin (Telegram)"） */
  name?: string;
}

export interface LLMConfig {
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

interface GlobalConfig {
  agents?: Record<string, GlobalAgentConfig>;
  adminPermissions?: {
    /** true = 主 Agent 执行工具时跳过所有权限审批 */
    skipMainAgentPermissions?: boolean;
    /** true = 所有 Agent（含子 Agent）执行工具时跳过权限审批 */
    skipAllAgentsPermissions?: boolean;
  };
  /** 非 admin 群组列表，config.json 为唯一持久化来源 */
  groups?: GroupConfigEntry[];
  /** 飞书额外应用凭证（子 agent 绑定不同飞书应用时使用） */
  feishuApps?: Record<string, FeishuAppConfig>;
  /** QQ 额外应用凭证（子 agent 绑定不同 QQ Bot 时使用） */
  qqApps?: Record<string, QQAppConfig>;
  /** 微信额外账户（凭证存磁盘，key = folder = accountId） */
  wechatAccounts?: Record<string, WeixinAccountConfig>;
  /** 额外 Telegram Bot 绑定列表（主 bot 之外的附加绑定） */
  telegramBots?: TelegramBotConfig[];
  /** LLM API 配置列表 */
  llmConfigs?: LLMConfig[];
  /** 当前激活的主模型 LLM 配置 ID */
  activeLlmConfigId?: string | null;
  /** 当前激活的快速模型 LLM 配置 ID（null = 与主模型相同） */
  activeQuickLlmConfigId?: string | null;
  /** 是否启用 Thinking 模式（默认 true） */
  thinkingEnabled?: boolean;
}

/**
 * 读取 ~/.semaclaw/config.json。
 * 文件不存在或 JSON 无效时返回空对象。
 */
export function loadGlobalConfig(): GlobalConfig {
  try {
    const raw = fs.readFileSync(config.paths.globalConfigPath, 'utf8');
    return JSON.parse(raw) as GlobalConfig;
  } catch {
    return {};
  }
}

/**
 * 将更新后的全局配置写回 config.json（深合并，不覆盖其他字段）。
 */
function saveGlobalConfig(update: Partial<GlobalConfig>): void {
  let existing: GlobalConfig = {};
  try {
    existing = JSON.parse(fs.readFileSync(config.paths.globalConfigPath, 'utf8'));
  } catch { /* 文件不存在时从空对象开始 */ }
  const merged = { ...existing, ...update };
  fs.mkdirSync(path.dirname(config.paths.globalConfigPath), { recursive: true });
  fs.writeFileSync(config.paths.globalConfigPath, JSON.stringify(merged, null, 2), 'utf8');
}

// ===== 飞书应用配置持久化 =====

/**
 * 保存飞书应用凭证到 config.json feishuApps（upsert by appId）。
 */
export function saveFeishuApp(appId: string, appSecret: string, domain?: string): void {
  const cfg = loadGlobalConfig();
  const apps = cfg.feishuApps ?? {};
  apps[appId] = { appSecret, ...(domain ? { domain } : {}) };
  saveGlobalConfig({ ...cfg, feishuApps: apps });
}

/**
 * 从 config.json feishuApps 中删除指定应用。
 */
export function deleteFeishuApp(appId: string): void {
  const cfg = loadGlobalConfig();
  const apps = cfg.feishuApps ?? {};
  delete apps[appId];
  saveGlobalConfig({ ...cfg, feishuApps: apps });
}

/**
 * 获取所有额外飞书应用凭证。
 */
export function getFeishuApps(): Record<string, FeishuAppConfig> {
  return loadGlobalConfig().feishuApps ?? {};
}

// ===== QQ 多 App 配置 =====

/**
 * 保存 QQ 应用凭证到 config.json qqApps（upsert by appId）。
 */
export function saveQQApp(appId: string, appSecret: string, sandbox?: boolean): void {
  const cfg = loadGlobalConfig();
  const apps = cfg.qqApps ?? {};
  apps[appId] = { appSecret, ...(sandbox ? { sandbox } : {}) };
  saveGlobalConfig({ ...cfg, qqApps: apps });
}

/**
 * 从 config.json qqApps 中删除指定应用。
 */
export function deleteQQApp(appId: string): void {
  const cfg = loadGlobalConfig();
  const apps = cfg.qqApps ?? {};
  delete apps[appId];
  saveGlobalConfig({ ...cfg, qqApps: apps });
}

/**
 * 获取所有额外 QQ 应用凭证。
 */
export function getQQApps(): Record<string, QQAppConfig> {
  return loadGlobalConfig().qqApps ?? {};
}

/**
 * 获取所有 CLI 配置的微信账户（key = folder = accountId）。
 */
export function getWechatAccounts(): Record<string, WeixinAccountConfig> {
  return loadGlobalConfig().wechatAccounts ?? {};
}

// ===== Telegram 多 Bot 配置 =====

/**
 * 保存额外 Telegram Bot 绑定到 config.json（upsert by token）。
 */
export function saveTelegramBot(entry: TelegramBotConfig): void {
  const cfg = loadGlobalConfig();
  const bots = cfg.telegramBots ?? [];
  const idx = bots.findIndex(b => b.token === entry.token);
  if (idx >= 0) bots[idx] = entry; else bots.push(entry);
  saveGlobalConfig({ ...cfg, telegramBots: bots });
}

/**
 * 从 config.json 删除指定 Telegram Bot 绑定。
 */
export function deleteTelegramBot(token: string): void {
  const cfg = loadGlobalConfig();
  const bots = (cfg.telegramBots ?? []).filter(b => b.token !== token);
  saveGlobalConfig({ ...cfg, telegramBots: bots });
}

/**
 * 获取所有额外 Telegram Bot 绑定列表。
 */
export function getTelegramBots(): TelegramBotConfig[] {
  return loadGlobalConfig().telegramBots ?? [];
}

// ===== 群组配置持久化 =====

/**
 * 将群组绑定持久化到 config.json 的 groups 数组（upsert by jid）。
 * 跳过 isAdmin 群组（主频道由 ensureAdminGroup + env var 管理，不存 config）。
 */
export function saveGroupToConfig(binding: GroupBinding): void {
  if (binding.isAdmin) return;
  const cfg = loadGlobalConfig();
  const groups = cfg.groups ?? [];
  const idx = groups.findIndex(g => g.jid === binding.jid);
  const entry: GroupConfigEntry = {
    jid: binding.jid,
    folder: binding.folder,
    name: binding.name,
    channel: binding.channel,
    requiresTrigger: binding.requiresTrigger,
    allowedTools: binding.allowedTools,
    allowedWorkDirs: binding.allowedWorkDirs,
    botToken: binding.botToken,
    maxMessages: binding.maxMessages,
  };
  if (idx >= 0) {
    groups[idx] = entry;
  } else {
    groups.push(entry);
  }
  saveGlobalConfig({ ...cfg, groups });
}

/**
 * 从 config.json 的 groups 数组中移除指定 jid 的条目。
 */
export function removeGroupFromConfig(jid: string): void {
  const cfg = loadGlobalConfig();
  const groups = (cfg.groups ?? []).filter(g => g.jid !== jid);
  saveGlobalConfig({ ...cfg, groups });
}

/**
 * 启动时将 config.json 中的 groups 数组完整同步到 DB（config.json 权威）。
 *
 * - config 中有、DB 中没有 → 创建（ensureAgentDirs + upsertGroup）
 * - config 中有、DB 中有   → 更新（保留 lastActive/addedAt 等运行时字段）
 * - config 中没有、DB 中有（非 admin）→ 从 DB 删除（用户手动从 config 移除了该群组）
 *
 * 不通过 GroupManager.register() 方法，直接操作 DB，避免循环写回 config。
 */
export function syncGroupsFromConfig(groupManager: GroupManager): { added: number; updated: number; removed: number } {
  const cfg = loadGlobalConfig();
  const configGroups = cfg.groups ?? [];
  const configJids = new Set(configGroups.map(g => g.jid));
  const now = new Date().toISOString();
  let added = 0, updated = 0, removed = 0;

  // 1. Upsert config → DB（不写回 config，避免循环）
  for (const entry of configGroups) {
    // folder UNIQUE 冲突预防：若 DB 中已有同 folder 但不同 jid 的记录（如 pending→真实 JID 迁移后
    // 用户 remove 再 add），先删掉旧记录，避免触发 UNIQUE constraint
    const existingByFolder = listGroups().find(g => g.folder === entry.folder && g.jid !== entry.jid);
    if (existingByFolder) {
      deleteGroupByFolder(entry.folder);
    }
    const existing = groupManager.get(entry.jid);
    const binding: GroupBinding = {
      jid: entry.jid,
      folder: entry.folder,
      name: entry.name,
      channel: entry.channel ?? '',
      isAdmin: false,
      requiresTrigger: entry.requiresTrigger ?? true,
      allowedTools: entry.allowedTools ?? null,
      allowedPaths: null,
      allowedWorkDirs: entry.allowedWorkDirs ?? null,
      botToken: entry.botToken ?? null,
      maxMessages: entry.maxMessages ?? null,
      lastActive: existing?.lastActive ?? null,
      addedAt: existing?.addedAt ?? now,
    };
    ensureAgentDirs(binding.folder, binding.name);
    upsertGroup(binding);
    if (existing) updated++; else added++;
  }

  // 2. 删除不在 config 中的非 admin DB 群组
  for (const dbGroup of groupManager.list()) {
    if (dbGroup.isAdmin) continue;
    if (!configJids.has(dbGroup.jid)) {
      deleteGroup(dbGroup.jid);
      removed++;
    }
  }

  return { added, updated, removed };
}

/**
 * 从全局配置中读取指定 agent 的 allowedWorkDirs。
 * 返回 undefined 表示配置文件中没有该 agent 的条目（保持 DB 值不变）。
 */
export function getAgentAllowedWorkDirs(folder: string): string[] | null | undefined {
  const cfg = loadGlobalConfig();
  const entry = cfg.agents?.[folder];
  if (entry === undefined) return undefined;          // 配置中无此 agent
  return entry.allowedWorkDirs ?? null;               // null = 不允许切换
}

/**
 * 读取权限配置。默认 false（需审批）。
 */
export function getAdminPermissionsConfig(): {
  skipMainAgentPermissions: boolean;
  skipAllAgentsPermissions: boolean;
} {
  const cfg = loadGlobalConfig();
  const p = cfg.adminPermissions ?? {};
  return {
    skipMainAgentPermissions: p.skipMainAgentPermissions ?? false,
    skipAllAgentsPermissions: p.skipAllAgentsPermissions ?? false,
  };
}

/**
 * 写入权限配置。
 */
export function saveAdminPermissionsConfig(opts: {
  skipMainAgentPermissions: boolean;
  skipAllAgentsPermissions: boolean;
}): void {
  const cfg = loadGlobalConfig();
  saveGlobalConfig({
    ...cfg,
    adminPermissions: {
      ...(cfg.adminPermissions ?? {}),
      skipMainAgentPermissions: opts.skipMainAgentPermissions,
      skipAllAgentsPermissions: opts.skipAllAgentsPermissions,
    },
  });
}

// ===== Thinking 配置 =====

/** 读取 Thinking 模式开关。默认 true（开启）。 */
export function getThinkingEnabled(): boolean {
  const cfg = loadGlobalConfig();
  return cfg.thinkingEnabled ?? true;
}

/** 写入 Thinking 模式开关。 */
export function saveThinkingEnabled(enabled: boolean): void {
  const cfg = loadGlobalConfig();
  saveGlobalConfig({ ...cfg, thinkingEnabled: enabled });
}

// ===== LLM 配置持久化 =====

export function loadLLMConfigs(): { configs: LLMConfig[]; activeId: string | null; activeQuickId: string | null } {
  const cfg = loadGlobalConfig();
  return {
    configs: cfg.llmConfigs ?? [],
    activeId: cfg.activeLlmConfigId ?? null,
    activeQuickId: cfg.activeQuickLlmConfigId ?? null,
  };
}

export function saveLLMConfig(c: LLMConfig): void {
  const cfg = loadGlobalConfig();
  const configs = cfg.llmConfigs ?? [];
  const idx = configs.findIndex(x => x.id === c.id);
  if (idx >= 0) configs[idx] = c; else configs.push(c);
  saveGlobalConfig({ ...cfg, llmConfigs: configs });
}

export function removeLLMConfig(id: string): void {
  const cfg = loadGlobalConfig();
  const configs = (cfg.llmConfigs ?? []).filter(x => x.id !== id);
  const activeId = cfg.activeLlmConfigId === id ? null : cfg.activeLlmConfigId;
  const activeQuickId = cfg.activeQuickLlmConfigId === id ? null : cfg.activeQuickLlmConfigId;
  saveGlobalConfig({ ...cfg, llmConfigs: configs, activeLlmConfigId: activeId, activeQuickLlmConfigId: activeQuickId });
}

export function setActiveLLMConfig(id: string | null): void {
  const cfg = loadGlobalConfig();
  saveGlobalConfig({ ...cfg, activeLlmConfigId: id });
}

export function setActiveQuickLLMConfig(id: string | null): void {
  const cfg = loadGlobalConfig();
  saveGlobalConfig({ ...cfg, activeQuickLlmConfigId: id });
}

// ===== GroupManager =====

export class GroupManager {
  private onGroupsChangedCb?: () => void;

  /** 注入回调，在 register/unregister/update 后触发（用于同步 DispatchBridge agents 列表）*/
  setOnGroupsChanged(cb: () => void): void {
    this.onGroupsChangedCb = cb;
  }

  /**
   * 注册群组：写 SQLite + 创建目录结构 + 持久化到 config.json（非 admin 群组）
   */
  register(binding: GroupBinding): void {
    ensureAgentDirs(binding.folder, binding.name);
    upsertGroup(binding);
    saveGroupToConfig(binding);
    this.onGroupsChangedCb?.();
  }

  /**
   * 注销群组：删除 DB 记录 + 从 config.json 移除（不删除目录）
   */
  unregister(jid: string): void {
    deleteGroup(jid);
    removeGroupFromConfig(jid);
    this.onGroupsChangedCb?.();
  }

  /**
   * 更新群组部分字段：写 DB + 持久化到 config.json
   */
  update(jid: string, updates: Partial<Omit<GroupBinding, 'jid' | 'addedAt'>>): GroupBinding {
    const existing = getGroup(jid);
    if (!existing) throw new Error(`Group not found: ${jid}`);
    const updated = { ...existing, ...updates };
    upsertGroup(updated);
    saveGroupToConfig(updated);
    this.onGroupsChangedCb?.();
    return updated;
  }

  get(jid: string): GroupBinding | null {
    return getGroup(jid);
  }

  list(): GroupBinding[] {
    return listGroups();
  }

  touchActive(jid: string): void {
    touchGroupActive(jid, new Date().toISOString());
  }

  /**
   * 查找飞书 pending 绑定（jid = feishu:pending:{appId}）。
   * 用于首条消息到达时自动完成绑定。
   */
  findPendingFeishuBinding(appId: string): GroupBinding | null {
    if (!appId) return null;
    return getGroup(`feishu:pending:${appId}`);
  }

  /**
   * 查找 QQ pending 绑定（jid = qq:pending:{appId}）。
   * 用于首条消息到达时自动完成绑定。
   */
  findPendingQQBinding(appId: string): GroupBinding | null {
    if (!appId) return null;
    return getGroup(`qq:pending:${appId}`);
  }

  /**
   * 查找微信 pending 绑定（jid = wx:pending:{folder}）。
   * 用于首条消息到达时自动完成绑定（folder = accountId = botToken）。
   */
  findPendingWechatBinding(folder: string): GroupBinding | null {
    if (!folder) return null;
    return getGroup(`wx:pending:${folder}`);
  }

  /**
   * 将群组 JID 从 oldJid 迁移到 newJid（飞书 pending 绑定完成后调用）。
   * 原子性地更新 DB + config.json，触发 onGroupsChanged。
   * 返回更新后的 GroupBinding，若 oldJid 不存在则返回 null。
   */
  migrateJid(oldJid: string, newJid: string): GroupBinding | null {
    const newBinding = renameGroupJid(oldJid, newJid);
    if (!newBinding) return null;
    removeGroupFromConfig(oldJid);
    saveGroupToConfig(newBinding);
    this.onGroupsChangedCb?.();
    return newBinding;
  }

  /**
   * 收集所有已注册群组使用的非默认 Bot token（用于 TelegramChannel.addBot）
   */
  getExtraBotTokens(defaultToken: string): string[] {
    const tokens = new Set<string>();
    for (const g of listGroups()) {
      if (g.botToken && g.botToken !== defaultToken) {
        tokens.add(g.botToken);
      }
    }
    return [...tokens];
  }

  /**
   * 根据 chatJid 前缀找到负责此 JID 的 channel 名
   */
  getChannelForJid(jid: string): 'telegram' | 'feishu' | 'qq' | 'whatsapp' | 'wechat' | null {
    if (jid.startsWith('tg:')) return 'telegram';
    if (jid.startsWith('feishu:')) return 'feishu';
    if (jid.startsWith('qq:')) return 'qq';
    if (jid.startsWith('wx:')) return 'wechat';
    if (jid.endsWith('@s.whatsapp.net') || jid.endsWith('@g.us')) return 'whatsapp';
    return null;
  }
}

// ===== 启动时自动注册主频道 =====

/**
 * 确保主频道已注册（每次启动都 upsert）。
 * - 保留用户自定义字段（botToken/allowedPaths/maxMessages）
 * - 始终更新 allowedTools 为当前默认值
 * - 若 ~/.semaclaw/config.json 有 main agent 的 allowedWorkDirs，同步到 DB
 */
export function ensureAdminGroup(groupManager: GroupManager, botUserId?: number): void {
  const adminUserId = config.admin.telegramUserId;
  const adminFeishuOpenId = config.admin.feishuOpenId;

  // 优先级：Telegram > Feishu > Web-only
  let jid: string;
  let channel: string;
  if (adminUserId) {
    // botUserId 可用时用新格式（bot 感知路由），否则降级到旧格式（兼容单 bot 场景）
    jid = botUserId ? `tg:${botUserId}:user:${adminUserId}` : `tg:user:${adminUserId}`;
    channel = 'telegram';
  } else if (adminFeishuOpenId) {
    jid = `feishu:user:${adminFeishuOpenId}`;
    channel = 'feishu';
  } else {
    jid = 'web:main';
    channel = '';
  }

  const now = new Date().toISOString();

  const folder = config.telegram.agentFolder;

  // folder UNIQUE 约束：若目标 folder 已被不同 jid 占用（如切换了 channel 或 userId），先删旧记录
  const existingByFolder = groupManager.list().find(g => g.folder === folder);

  // Telegram 断线时（botUserId 为 undefined），若 DB 中已有 bot-aware jid（tg:{botId}:user:{}），
  // 保留该 jid 而不降级到旧格式。避免无意义的 jid 往返迁移导致重启后名称丢失。
  if (!botUserId && adminUserId && existingByFolder) {
    const existingJid = existingByFolder.jid;
    if (/^tg:\d+:user:/.test(existingJid)) {
      jid = existingJid;
      channel = 'telegram';
      console.log(`[GroupManager] Telegram disconnected; keeping existing jid ${jid}`);
    }
  }

  if (existingByFolder && existingByFolder.jid !== jid) {
    groupManager.unregister(existingByFolder.jid);
    console.log(`[GroupManager] Migrated admin group from ${existingByFolder.jid} to ${jid}`);
  }

  // 清理旧格式 jid（如 tg:user:{id} → tg:{botId}:user:{id} 升级时遗留的旧记录）
  // 避免同一个 adminUserId 因 jid 格式变更后出现重复 binding
  if (adminUserId && jid !== `tg:user:${adminUserId}`) {
    const legacyJid = `tg:user:${adminUserId}`;
    if (groupManager.get(legacyJid)) {
      groupManager.unregister(legacyJid);
      console.log(`[GroupManager] Removed legacy jid ${legacyJid} (superseded by ${jid})`);
    }
  }

  // 以新 jid 查找（迁移后可能不存在，保留字段用旧记录兜底）
  const existing = groupManager.get(jid) ?? existingByFolder ?? null;

  // 从全局配置读取 allowedWorkDirs（undefined = 配置文件中无条目，保持 DB 值）
  const configAllowedWorkDirs = getAgentAllowedWorkDirs(folder);

  const binding: GroupBinding = {
    jid,
    folder,
    name: existing?.name ?? `${folder} (${channel || 'web'})`,
    channel,
    isAdmin: folder === 'main',
    requiresTrigger: false,
    allowedTools: ADMIN_DEFAULT_TOOLS,
    allowedPaths: existing?.allowedPaths ?? null,
    allowedWorkDirs: configAllowedWorkDirs !== undefined
      ? configAllowedWorkDirs
      : (existing?.allowedWorkDirs ?? null),
    botToken: existing?.botToken ?? null,
    maxMessages: existing?.maxMessages ?? null,
    lastActive: existing?.lastActive ?? null,
    addedAt: existing?.addedAt ?? now,
  };

  groupManager.register(binding);
  console.log(
    `[GroupManager] Admin group ${existing ? 'updated' : 'registered'}: ${jid} → agents/${folder}/`
  );
}

/**
 * 微信扫码绑定后调用：将扫码者的 JID 注册为 main agent 的微信入口。
 * - 若 main 已由 Telegram/Feishu 占用，则将微信 JID 注册为 `main` folder 的额外绑定
 *   （folder 允许多 JID 指向，MessageRouter 按 jid 精确查找）
 * - 幂等，每次启动都 upsert
 */
export function ensureWechatAdminGroup(
  groupManager: GroupManager,
  ownerJid: string,
  folder: string = 'main',
): void {
  const now = new Date().toISOString();

  // folder UNIQUE 约束：若该 folder 已被不同 jid 占用，先删旧记录（内存 + config.json）
  const existingByFolder = groupManager.list().find(g => g.folder === folder);
  if (existingByFolder && existingByFolder.jid !== ownerJid) {
    groupManager.unregister(existingByFolder.jid);
    removeGroupFromConfig(existingByFolder.jid);
    console.log(`[GroupManager] Migrated WeChat group from ${existingByFolder.jid} to ${ownerJid}`);
  }

  const existing = groupManager.get(ownerJid) ?? existingByFolder ?? null;

  const isAdmin = folder === 'main';

  const binding: GroupBinding = {
    jid: ownerJid,
    folder,
    name: existing?.name ?? folder,
    channel: 'wechat',
    isAdmin,
    requiresTrigger: false,
    allowedTools: existing?.allowedTools ?? (isAdmin ? ADMIN_DEFAULT_TOOLS : null),
    allowedPaths: existing?.allowedPaths ?? null,
    allowedWorkDirs: existing?.allowedWorkDirs ?? null,
    botToken: null,
    maxMessages: existing?.maxMessages ?? null,
    lastActive: existing?.lastActive ?? null,
    addedAt: existing?.addedAt ?? now,
  };

  groupManager.register(binding);
  // 非 admin 群组写入 config.json，防止 syncGroupsFromConfig 下次启动时删除
  if (!isAdmin) saveGroupToConfig(binding);
  console.log(
    `[GroupManager] WeChat group ${existing ? 'updated' : 'registered'}: ${ownerJid} → agents/${folder}/ (isAdmin=${isAdmin})`
  );
}
