/**
 * MCP 服务器配置构建器
 *
 * 供 AgentPool 使用，根据运行模式（tsx dev vs 编译 JS）
 * 构建正确的 MCPServerConfig。
 */

import * as fs from 'fs';
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

/** injectCapabilityMCP 所需的最小 core 接口 */
type MCPAddableCore = {
  addOrUpdateMCPServer: (config: MCPServerConfig, scope: 'project' | 'user') => Promise<unknown>;
};

/**
 * 注入"能力面"MCP——marketplace 插件 + 用户全局 mcp.json，**不含** semaclaw 自带控制面 MCP
 * （schedule / workspace / dispatch / memory / send / virtual / feishu-wiki）。
 *
 * 主 agent 与虚拟 worker 共用，使"哪些 MCP 算能力面、可下放给 worker"这条边界单点定义。
 * 控制面由各调用方在调用本函数之外、按自身权限语义单独 addOrUpdateMCPServer。
 *
 * 连接成本：sema-core 的 MCPMux 按 config-hash 去重 + 引用计数，相同 config 的子进程全进程复用。
 * 故 marketplace/用户全局这类"带群无关"config，主 agent / warmup probe 连过后，虚拟 worker 这里
 * 只是 refcount++ 并用缓存 tools 现搭 per-session 适配器（便宜），不重启子进程。真正冷启动（180s
 * 超时即为此设）只发生在某 config 从未被任何 session 预热过的首次连接。
 */
export async function injectCapabilityMCP(
  core: MCPAddableCore,
  opts: {
    /** marketplace 插件 MCP 定义（调用方自行从其 MarketplaceManager 取，避免本模块反向依赖）。 */
    marketplaceDefs?: MCPServerConfig[];
    /** 用户全局配置目录（读取其下 mcp.json）。 */
    configHome: string;
    /** 日志前缀。 */
    label: string;
    /** 单个 server 连接超时，默认 180s。 */
    timeoutMs?: number;
    /** 每个成功加入的用户 MCP server 名回调（如主 agent 用于后续清理跟踪）。 */
    onUserServerAdded?: (name: string) => void;
  },
): Promise<void> {
  const timeoutMs = opts.timeoutMs ?? 180_000;
  const addMCP = async (cfg: MCPServerConfig, sub: string): Promise<void> => {
    try {
      await Promise.race([
        core.addOrUpdateMCPServer(cfg, 'project'),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error(`${sub} MCP connect timeout (${timeoutMs / 1000}s)`)), timeoutMs),
        ),
      ]);
    } catch (e) {
      console.warn(`[${opts.label}] ${sub} MCP unavailable: ${e}`);
    }
  };

  // marketplace 插件 MCP
  for (const cfg of opts.marketplaceDefs ?? []) {
    await addMCP(cfg, `Marketplace[${cfg.name}]`);
  }

  // 用户全局 MCP（${configHome}/mcp.json）
  const userMCPPath = path.join(opts.configHome, 'mcp.json');
  if (fs.existsSync(userMCPPath)) {
    try {
      const data = JSON.parse(fs.readFileSync(userMCPPath, 'utf-8')) as { mcpServers?: Record<string, unknown> };
      for (const [name, cfg] of Object.entries(data.mcpServers ?? {})) {
        if ((cfg as Record<string, unknown>).enabled !== false) {
          await addMCP({ ...(cfg as MCPServerConfig), name }, `User[${name}]`);
          opts.onUserServerAdded?.(name);
        }
      }
    } catch (e) {
      console.warn(`[${opts.label}] Failed to load user MCP config: ${e}`);
    }
  }
}

