/**
 * MCP 服务器配置构建器
 *
 * 供 AgentPool 使用，根据运行模式（tsx dev vs 编译 JS）
 * 构建正确的 MCPServerConfig。
 */

import * as path from 'path';
import type { MCPServerConfig } from 'sema-core/mcp';

// 检测运行模式：tsx（开发）还是编译后的 JS
const isDevMode = __filename.endsWith('.ts');

// dev 模式下不依赖 PATH 中的裸 `tsx`，改用绝对路径的 tsx CLI 以兼容非 npm run dev 启动方式
const tsxCliPath = isDevMode
  ? path.join(__dirname, '..', '..', 'node_modules', 'tsx', 'dist', 'cli.mjs')
  : '';

// 子进程需要继承父进程的 PATH 等环境变量，否则在 Windows 上找不到 tsx/node
// SEMACLAW_* 变量在各函数中单独覆盖
const baseEnv = process.env as Record<string, string>;

/**
 * 构建 ScheduleTool MCP 服务器配置（群组作用域）
 */
export function scheduleMCPConfig(opts: {
  dbPath: string;
  groupFolder: string;
  chatJid: string;
}): MCPServerConfig {
  const serverPath = isDevMode
    ? path.join(__dirname, 'schedule-server.ts')
    : path.join(__dirname, 'schedule-server.js');

  return {
    name: 'semaclaw-schedule',
    transport: 'stdio',
    command: process.execPath,
    args: isDevMode ? [tsxCliPath, serverPath] : [serverPath],
    env: {
      ...baseEnv,
      SEMACLAW_DB_PATH: opts.dbPath,
      SEMACLAW_GROUP_FOLDER: opts.groupFolder,
      SEMACLAW_CHAT_JID: opts.chatJid,
    },
  };
}

/**
 * 构建 AdminTool MCP 服务器配置（isAdmin 群组专用）
 */
/**
 * 构建 WorkspaceTool MCP 服务器配置（所有群组可用）
 */
export function workspaceMCPConfig(opts: {
  stateFile: string;
  defaultWorkspace: string;
  allowedWorkDirs: string[] | null;
}): MCPServerConfig {
  const serverPath = isDevMode
    ? path.join(__dirname, 'workspace-server.ts')
    : path.join(__dirname, 'workspace-server.js');

  return {
    name: 'semaclaw-workspace',
    transport: 'stdio',
    command: process.execPath,
    args: isDevMode ? [tsxCliPath, serverPath] : [serverPath],
    env: {
      ...baseEnv,
      SEMACLAW_WORKSPACE_STATE_FILE: opts.stateFile,
      SEMACLAW_DEFAULT_WORKSPACE: opts.defaultWorkspace,
      // null → 空字符串（server 端以此区分"未配置"和"空列表"）
      SEMACLAW_ALLOWED_WORK_DIRS: opts.allowedWorkDirs !== null
        ? JSON.stringify(opts.allowedWorkDirs)
        : '',
    },
  };
}

/**
 * 构建 MemoryTool MCP 服务器配置（所有群组可用）
 * v2: memory_search + memory_get（只读），写入由 sema-core Write/Edit 完成
 */
export function memoryMCPConfig(opts: {
  dbPath: string;
  folder: string;
  agentsDir: string;
  embeddingProvider?: string;
  openaiApiKey?: string;
  openaiBaseUrl?: string;
}): MCPServerConfig {
  const serverPath = isDevMode
    ? path.join(__dirname, 'memory-server.ts')
    : path.join(__dirname, 'memory-server.js');

  return {
    name: 'semaclaw-memory',
    transport: 'stdio',
    command: process.execPath,
    args: isDevMode ? [tsxCliPath, serverPath] : [serverPath],
    env: {
      ...baseEnv,
      SEMACLAW_DB_PATH: opts.dbPath,
      SEMACLAW_FOLDER: opts.folder,
      SEMACLAW_AGENTS_DIR: opts.agentsDir,
      ...(opts.embeddingProvider ? { SEMACLAW_EMBEDDING_PROVIDER: opts.embeddingProvider } : {}),
      ...(opts.openaiApiKey ? { SEMACLAW_OPENAI_API_KEY: opts.openaiApiKey } : {}),
      ...(opts.openaiBaseUrl ? { SEMACLAW_OPENAI_BASE_URL: opts.openaiBaseUrl } : {}),
    },
  };
}

/**
 * 构建 SendTool MCP 服务器配置（所有群组可用）
 */
export function sendMCPConfig(opts: {
  bridgePort: number;
  chatJid: string;
  isAdmin: boolean;
  botToken?: string;
  dbPath: string;
}): MCPServerConfig {
  const serverPath = isDevMode
    ? path.join(__dirname, 'send-server.ts')
    : path.join(__dirname, 'send-server.js');

  return {
    name: 'semaclaw-send',
    transport: 'stdio',
    command: process.execPath,
    args: isDevMode ? [tsxCliPath, serverPath] : [serverPath],
    env: {
      ...baseEnv,
      SEMACLAW_SEND_BRIDGE_PORT: String(opts.bridgePort),
      SEMACLAW_CHAT_JID: opts.chatJid,
      SEMACLAW_IS_ADMIN: opts.isAdmin ? '1' : '0',
      ...(opts.botToken ? { SEMACLAW_BOT_TOKEN: opts.botToken } : {}),
      SEMACLAW_DB_PATH: opts.dbPath,
    },
  };
}

/**
 * 构建 DispatchTool MCP 服务器配置（isAdmin 群组专用）
 */
export function dispatchMCPConfig(opts: {
  statePath: string;
  adminFolder: string;
  agentsConfigDir?: string;
}): MCPServerConfig {
  const serverPath = isDevMode
    ? path.join(__dirname, 'dispatch-server.ts')
    : path.join(__dirname, 'dispatch-server.js');

  return {
    name: 'semaclaw-dispatch',
    transport: 'stdio',
    command: process.execPath,
    args: isDevMode ? [tsxCliPath, serverPath] : [serverPath],
    env: {
      ...baseEnv,
      SEMACLAW_DISPATCH_STATE_PATH: opts.statePath,
      SEMACLAW_ADMIN_FOLDER: opts.adminFolder,
      ...(opts.agentsConfigDir ? { SEMACLAW_AGENTS_CONFIG_DIR: opts.agentsConfigDir } : {}),
    },
  };
}

/**
 * 构建 VirtualAgent MCP 服务器配置（isAdmin 群组专用）
 */
export function virtualMCPConfig(opts: {
  agentsConfigDir: string;
  adminFolder: string;
  defaultWorkspace: string;
}): MCPServerConfig {
  const serverPath = isDevMode
    ? path.join(__dirname, 'virtual-server.ts')
    : path.join(__dirname, 'virtual-server.js');

  return {
    name: 'semaclaw-virtual',
    transport: 'stdio',
    command: process.execPath,
    args: isDevMode ? [tsxCliPath, serverPath] : [serverPath],
    env: {
      ...baseEnv,
      SEMACLAW_AGENTS_CONFIG_DIR: opts.agentsConfigDir,
      SEMACLAW_ADMIN_FOLDER: opts.adminFolder,
      SEMACLAW_DEFAULT_WORKSPACE: opts.defaultWorkspace,
    },
  };
}

/**
 * 构建 FeishuWiki MCP 服务器配置（飞书渠道群组专用）
 */
export function feishuWikiMCPConfig(opts: {
  appId: string;
  appSecret: string;
  domain?: string;
}): MCPServerConfig {
  const serverPath = isDevMode
    ? path.join(__dirname, 'feishu-wiki-server.ts')
    : path.join(__dirname, 'feishu-wiki-server.js');

  return {
    name: 'semaclaw-feishu-wiki',
    transport: 'stdio',
    command: process.execPath,
    args: isDevMode ? [tsxCliPath, serverPath] : [serverPath],
    env: {
      FEISHU_APP_ID: opts.appId,
      FEISHU_APP_SECRET: opts.appSecret,
      FEISHU_DOMAIN: opts.domain ?? 'feishu',
    },
  };
}

