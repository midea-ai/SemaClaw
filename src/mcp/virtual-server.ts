/**
 * VirtualAgent MCP 服务器进程（isAdmin 群组专用）
 *
 * 通过 stdio 接入 sema-core。提供 run_persona / list_personas 工具，
 * 在 admin agent 的 tool_use 上下文中阻塞执行虚拟 agent 任务。
 *
 * 环境变量：
 *   SEMACLAW_AGENTS_CONFIG_DIR  — 人设文件目录（~/.semaclaw/agents）
 *   SEMACLAW_ADMIN_FOLDER       — admin agent folder（用于读取 workspace state）
 *   SEMACLAW_DEFAULT_WORKSPACE  — 默认 workspace 路径（fallback）
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

// ===== model.conf 隔离（必须在 sema-core 加载前执行）=====
{
  const semaclawModelConf = path.join(os.homedir(), '.semaclaw', 'semaclaw-model.conf');
  if (fs.existsSync(semaclawModelConf)) {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { setModelConfigPathOverride } = require('sema-core') as { setModelConfigPathOverride: (p: string) => void };
    setModelConfigPathOverride(semaclawModelConf);
  }
}

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { PersonaRegistry } from '../agent/PersonaRegistry';
import { VirtualWorkerPool } from '../agent/VirtualWorkerPool';
import { getMarketplaceManager } from '../marketplace/MarketplaceManager';

// TS2589 workaround: MCP SDK zod type instantiation
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyZod = any;

// ===== 环境变量 =====

const agentsConfigDir = process.env.SEMACLAW_AGENTS_CONFIG_DIR;
if (!agentsConfigDir) {
  console.error('[virtual-server] Missing SEMACLAW_AGENTS_CONFIG_DIR');
  process.exit(1);
}

const adminFolder = process.env.SEMACLAW_ADMIN_FOLDER;
if (!adminFolder) {
  console.error('[virtual-server] Missing SEMACLAW_ADMIN_FOLDER');
  process.exit(1);
}

const defaultWorkspace = process.env.SEMACLAW_DEFAULT_WORKSPACE ?? '';

/** 读取 admin agent 当前工作目录（与 dispatch-server 同模式） */
function readCurrentWorkspace(): string {
  try {
    const stateFile = path.join(os.homedir(), '.semaclaw', `workspace-state-${adminFolder}.json`);
    const raw = fs.readFileSync(stateFile, 'utf-8');
    return (JSON.parse(raw) as { currentDir?: string }).currentDir ?? defaultWorkspace;
  } catch {
    return defaultWorkspace;
  }
}

// ===== 初始化 =====

const marketplaceManager = getMarketplaceManager();

const registry = new PersonaRegistry(agentsConfigDir);
registry.setExtraDirs(marketplaceManager.getSubagentDirs());

const pool = new VirtualWorkerPool();
pool.setGetMarketplaceHookFiles(() => marketplaceManager.getHookFiles());

// ===== MCP Server =====

const server = new McpServer({ name: 'semaclaw-virtual', version: '1.0.0' });
const tool = server.tool.bind(server) as AnyZod;

// ===== list_personas =====

tool(
  'list_personas',
  'List all available virtual agent personas that can be invoked with run_persona.',
  {},
  async () => {
    const personas = registry.list();
    if (personas.length === 0) {
      return {
        content: [{
          type: 'text',
          text: 'No personas configured. Add .md files to ~/semaclaw/virtual-agents/',
        }],
      };
    }

    const lines = personas.map(p => `- **${p.name}**: ${p.description}`);

    return { content: [{ type: 'text', text: lines.join('\n') }] };
  },
);

// ===== run_persona =====

tool(
  'run_persona',
  'Invoke a virtual agent persona to execute a task. The persona runs as an ephemeral agent instance with its own tools and system prompt, then returns the result. This call blocks until the persona completes or times out.',
  {
    persona: z.string().describe('Name of the persona to invoke (from list_personas)'),
    prompt: z.string().describe('The task prompt to send to the virtual agent'),
    timeout_seconds: z.number().optional().describe('Override default timeout (600s). Max 1800s.'),
  },
  async ({ persona: personaName, prompt, timeout_seconds }: {
    persona: string;
    prompt: string;
    timeout_seconds?: number;
  }) => {
    const persona = registry.get(personaName);
    if (!persona) {
      return {
        content: [{
          type: 'text',
          text: `Persona "${personaName}" not found. Use list_personas to see available personas.`,
        }],
        isError: true,
      };
    }

    // Clamp timeout
    const timeout = timeout_seconds
      ? Math.min(Math.max(timeout_seconds, 10), 1800)
      : undefined;

    try {
      const currentWorkspace = readCurrentWorkspace();
      if (!currentWorkspace) {
        return {
          content: [{ type: 'text', text: 'Cannot determine workspace directory. Set workspace first.' }],
          isError: true,
        };
      }
      const result = await pool.run(persona, prompt, currentWorkspace, {
        timeout,
      });

      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            persona: personaName,
            result: result.result || '(completed with no text output)',
            duration_ms: result.durationMs,
          }, null, 2),
        }],
      };
    } catch (e: any) {
      return {
        content: [{
          type: 'text',
          text: `run_persona failed: ${e.message}`,
        }],
        isError: true,
      };
    }
  },
);

// ===== Start =====

const transport = new StdioServerTransport();
server.connect(transport).catch(err => {
  console.error('[virtual-server] Fatal:', err);
  process.exit(1);
});
