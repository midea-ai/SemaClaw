/**
 * WorkspaceTool MCP 服务器进程（所有群组可用）
 *
 * 通过 stdio 接入 sema-core。Agent 调用这些工具切换工作目录。
 * AgentPool 通过 fs.watchFile 监听 stateFile，检测到变化后调用 core.setWorkingDir()。
 *
 * 环境变量：
 *   SEMACLAW_WORKSPACE_STATE_FILE  — 状态文件路径（AgentPool 监听此文件）
 *   SEMACLAW_DEFAULT_WORKSPACE     — 默认工作目录（workspace_reset 回到此目录）
 *   SEMACLAW_ALLOWED_WORK_DIRS     — JSON 数组 | "" (null = 不允许切换)
 *
 * 工具：
 *   workspace_switch  — 切换到指定目录（需在 allowedWorkDirs 内）
 *   workspace_reset   — 回到默认工作目录
 *   workspace_info    — 查看当前工作目录和权限配置
 */

import * as fs from 'fs';
import * as path from 'path';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

// ===== 环境变量 =====

const stateFile = process.env.SEMACLAW_WORKSPACE_STATE_FILE;
const defaultWorkspace = process.env.SEMACLAW_DEFAULT_WORKSPACE;
const allowedWorkDirsRaw = process.env.SEMACLAW_ALLOWED_WORK_DIRS;

if (!stateFile || !defaultWorkspace) {
  console.error('[workspace-server] Missing required env vars: SEMACLAW_WORKSPACE_STATE_FILE, SEMACLAW_DEFAULT_WORKSPACE');
  process.exit(1);
}

/**
 * null  = 切换功能完全禁用（allowedWorkDirs not set）
 * []    = 没有预授权目录（不能切换）
 * [...] = 预授权目录列表
 */
const allowedWorkDirs: string[] | null = allowedWorkDirsRaw
  ? (JSON.parse(allowedWorkDirsRaw) as string[])
  : null;

// ===== 状态文件操作 =====

interface WorkspaceState {
  currentDir: string;
  updatedAt: string;
}

function readState(): WorkspaceState {
  try {
    return JSON.parse(fs.readFileSync(stateFile!, 'utf8')) as WorkspaceState;
  } catch {
    return { currentDir: defaultWorkspace!, updatedAt: new Date().toISOString() };
  }
}

function writeState(newDir: string): void {
  const state: WorkspaceState = {
    currentDir: newDir,
    updatedAt: new Date().toISOString(),
  };
  fs.writeFileSync(stateFile!, JSON.stringify(state, null, 2), 'utf8');
}

// ===== 路径验证 =====

function isPathAllowed(targetPath: string): boolean {
  if (allowedWorkDirs === null) return false;
  const normalized = path.resolve(targetPath);
  return allowedWorkDirs.some((allowed) =>
    normalized === allowed || normalized.startsWith(allowed + path.sep)
  );
}

// ===== MCP 服务器 =====

const server = new McpServer({ name: 'semaclaw-workspace', version: '1.0.0' });
// Cast to any to avoid TS2589 caused by MCP SDK's deep zod type inference (ShapeOutput<ZodRawShape>)
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const srv = server as any;

// workspace_switch
srv.registerTool(
  'workspace_switch',
  {
    description: 'Switch the current working directory to a specified path. Only paths in allowedWorkDirs are permitted.',
    inputSchema: {
      path: z.string().describe('Absolute path to switch to'),
    },
  },
  async ({ path: targetPath }: { path: string }) => {
    if (allowedWorkDirs === null) {
      return {
        content: [{ type: 'text' as const, text: '❌ 此 agent 未启用工作目录切换功能（allowedWorkDirs 未配置）' }],
        isError: true,
      };
    }

    const resolved = path.resolve(targetPath);

    if (!fs.existsSync(resolved)) {
      return {
        content: [{ type: 'text' as const, text: `❌ 目录不存在: ${resolved}` }],
        isError: true,
      };
    }

    if (!fs.statSync(resolved).isDirectory()) {
      return {
        content: [{ type: 'text' as const, text: `❌ 路径不是目录: ${resolved}` }],
        isError: true,
      };
    }

    if (!isPathAllowed(resolved)) {
      const list = allowedWorkDirs.length > 0
        ? allowedWorkDirs.map((d) => `  • ${d}`).join('\n')
        : '  （暂无预授权目录，请在 ~/.semaclaw/config.json 中配置 allowedWorkDirs）';
      return {
        content: [{
          type: 'text' as const,
          text: `❌ 目录未在 allowedWorkDirs 中：\n${resolved}\n\n已授权目录：\n${list}`,
        }],
        isError: true,
      };
    }

    writeState(resolved);

    return {
      content: [{
        type: 'text' as const,
        text: `✅ 工作目录已切换至：${resolved}`,
      }],
    };
  }
);

// workspace_reset
srv.registerTool(
  'workspace_reset',
  {
    description: 'Reset the working directory back to the default workspace for this agent.',
    inputSchema: {},
  },
  async () => {
    writeState(defaultWorkspace!);
    return {
      content: [{
        type: 'text' as const,
        text: `✅ 工作目录已重置至默认工作区：${defaultWorkspace}`,
      }],
    };
  }
);

// workspace_info
srv.registerTool(
  'workspace_info',
  {
    description: 'Show current working directory, default workspace, and allowed directories.',
    inputSchema: {},
  },
  async () => {
    const state = readState();
    const info = {
      currentDir: state.currentDir,
      defaultWorkspace,
      allowedWorkDirs: allowedWorkDirs ?? '(disabled)',
      isAtDefault: state.currentDir === defaultWorkspace,
    };
    return {
      content: [{ type: 'text' as const, text: JSON.stringify(info, null, 2) }],
    };
  }
);

// ===== 启动 =====

(async () => {
  const transport = new StdioServerTransport();
  await server.connect(transport);
})();
