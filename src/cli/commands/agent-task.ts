/**
 * semaclaw agent-task — 一次性独立 Agent 任务执行
 *
 * 用法（典型场景：Hook 脚本调用反思 Agent）：
 *   semaclaw agent-task --prompt-file ./full-prompt.md --output json
 *
 * 通用 CLI，不绑定具体 hook 用例。Hook 脚本负责：
 *   1. 触发条件判断
 *   2. 完整 prompt 拼装（任务模板 + 历史 + 已有 wiki 领域，全部一次性塞进 prompt）
 *   3. 调用 `semaclaw agent-task`（只关心最终 user prompt）
 *   4. 解析 JSON 输出，做去重/校验/落盘
 *
 * 防递归：进程启动即写 SEMACLAW_INTERNAL_AGENT=1 到 process.env。
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import type { MCPServerConfig, MCPScopeType } from 'sema-core/mcp';
import { runOneShot } from '../../agent/IsolatedRunner';
import { config } from '../../config';
import { getMarketplaceManager } from '../../marketplace/MarketplaceManager.js';
import { readDisabledSkills } from '../../skills/disabled.js';
import { expandSkillsDir } from '../../skills/expand.js';

export interface AgentTaskCliOptions {
  prompt?: string;
  promptFile?: string;
  workingDir?: string;
  agentDataDir?: string;
  tools?: string;
  skillsDir?: string[];
  output?: 'json' | 'text' | 'raw';
  timeout?: number;
  instanceId?: string;
  systemPrompt?: string;
  /**
   * MCP 接入（默认不连任何 MCP）：
   *   - true（裸 `--mcp`）：完整"能力面" = marketplace 已开启的 server + 用户全局 mcp.json，对齐主 agent。
   *   - string（`--mcp <path>`）：仅该 mcp.json 形状文件（{ mcpServers: { name: config } }），由调用方框定，不含 marketplace。
   * 均不含 semaclaw 控制面 MCP（memory/schedule/… 需持久化群组身份，一次性 agent 拿不到）。
   */
  mcp?: string | boolean;
}

function readStdin(): Promise<string> {
  return new Promise((resolve) => {
    if (process.stdin.isTTY) {
      resolve('');
      return;
    }
    let data = '';
    process.stdin.setEncoding('utf-8');
    process.stdin.on('data', chunk => { data += chunk; });
    process.stdin.on('end', () => resolve(data));
  });
}

async function readPromptInput(opts: AgentTaskCliOptions): Promise<string> {
  if (opts.prompt) return opts.prompt;
  if (opts.promptFile) {
    if (opts.promptFile === '-') return readStdin();
    return fs.readFileSync(resolveUserPath(opts.promptFile), 'utf-8');
  }
  return readStdin();
}

/**
 * 展开 `~` / `~/...` 为用户 home，再做 path.resolve。
 * Shell 不展开的场景（路径来自 JSON / 双引号 / 全角波浪 等）需要这层兜底。
 */
function resolveUserPath(p: string): string {
  if (p === '~') return os.homedir();
  if (p.startsWith('~/')) return path.resolve(os.homedir(), p.slice(2));
  return path.resolve(p);
}

export async function cmdAgentTask(opts: AgentTaskCliOptions): Promise<void> {
  process.env.SEMACLAW_INTERNAL_AGENT = '1';

  const prompt = (await readPromptInput(opts)).trim();
  if (!prompt) {
    console.error('Error: prompt is empty (use --prompt, --prompt-file, or pipe to stdin)');
    process.exit(2);
  }

  const workingDir = opts.workingDir ? resolveUserPath(opts.workingDir) : process.cwd();
  const agentDataDir = opts.agentDataDir ? resolveUserPath(opts.agentDataDir) : workingDir;

  assertDirExists(workingDir, '--working-dir');
  if (opts.agentDataDir) assertDirExists(agentDataDir, '--agent-data-dir');

  // MCP 可选（默认不连，保持轻量）。连了就自动补 ToolSearch，让 MCP 工具按需加载而非全量 inline。
  const mcpConfigs = resolveMcpConfigs(opts.mcp);

  let useTools = opts.tools
    ? opts.tools.split(',').map(t => t.trim()).filter(Boolean)
    : null;
  // useTools=null 时全部内置工具（含 ToolSearch）已在，defer 天然开启；仅在显式白名单里补 ToolSearch。
  if (mcpConfigs.length && useTools && !useTools.includes('ToolSearch')) {
    useTools = [...useTools, 'ToolSearch'];
  }

  const _disabled = readDisabledSkills();
  const skillsExtraDirs = [
    ...(config.paths.bundledSkillsDir
      ? expandSkillsDir(config.paths.bundledSkillsDir, 'managed', _disabled)
      : []),
    ...expandSkillsDir(path.join(os.homedir(), '.claude', 'skills'), 'user', _disabled),
    ...expandSkillsDir(config.paths.managedSkillsDir, 'managed', _disabled),
    ...expandSkillsDir(path.join(workingDir, 'skills'), 'workspace', _disabled),
    ...((opts.skillsDir ?? []).flatMap(d => expandSkillsDir(resolveUserPath(d), 'workspace', _disabled))),
  ];

  const result = await runOneShot({
    instanceId: opts.instanceId ?? `agent-task-${Date.now()}`,
    prompt,
    workingDir,
    agentDataDir,
    useTools,
    mcpConfigs,
    skillsExtraDirs,
    systemPrompt: opts.systemPrompt,
    timeoutMs: opts.timeout && opts.timeout > 0 ? opts.timeout : undefined,
    hooks: undefined,
    hookEnv: { SEMACLAW_INTERNAL_AGENT: '1' },
  });

  if (result.timedOut) {
    console.error(`[agent-task] timed out after ${result.durationMs}ms (turns: ${result.turnCount})`);
    process.exit(124);
  }

  const final = result.text;

  switch (opts.output ?? 'text') {
    case 'json': {
      const parsed = tryParseJson(final);
      if (parsed === undefined) {
        console.error('[agent-task] expected JSON output but got non-JSON');
        console.error('[agent-task] raw final text:');
        console.error(final);
        process.exit(3);
      }
      process.stdout.write(JSON.stringify(parsed) + '\n');
      break;
    }
    case 'raw':
      process.stdout.write(result.allTexts.join('\n---\n') + '\n');
      break;
    case 'text':
    default:
      process.stdout.write(final + '\n');
      break;
  }

  // SemaCore / Anthropic SDK / 内部 timer 可能持有 keep-alive 句柄，
  // 让事件循环空转。CLI 任务结束即退出，不等这些自然超时。
  process.exit(0);
}

type ScopedMCP = { config: MCPServerConfig; scope: MCPScopeType };

/**
 * 解析 --mcp 语义（默认不连任何 MCP）：
 *   - true（裸 --mcp）：完整"能力面" = marketplace 已开启的 server + 用户全局 mcp.json，对齐主 agent。
 *   - string（--mcp <path>）：仅该 mcp.json 形状文件，由调用方框定，不含 marketplace。
 * 全都以 'project' scope 注入（一次性 agent 无跨层覆盖需求）。
 */
function resolveMcpConfigs(mcp: string | boolean | undefined): ScopedMCP[] {
  if (mcp === true) {
    const out: ScopedMCP[] = [];
    // marketplace 已开启插件的 MCP（同步扫描，名字已带 mkt__<plugin>__<server> 前缀）
    for (const def of getMarketplaceManager().getMCPServerDefs()) {
      out.push({ config: def as unknown as MCPServerConfig, scope: 'project' });
    }
    // 用户全局 mcp.json（缺失属正常，软处理）
    out.push(...loadMcpConfigsFromFile(path.join(config.paths.configHome, 'mcp.json'), false));
    return out;
  }
  if (typeof mcp === 'string') {
    return loadMcpConfigsFromFile(resolveUserPath(mcp), true);
  }
  return [];
}

/**
 * 从 mcp.json 形状的文件加载 MCP server 配置。
 * 形状：{ "mcpServers": { "<name>": { transport, command, args, env, enabled? } } }
 * 与用户全局 ~/.semaclaw/mcp.json 同构，调用方可直接复用这些片段。
 * enabled === false 的 server 跳过。required=false 时文件缺失软处理返回空。
 */
function loadMcpConfigsFromFile(
  mcpPath: string,
  required: boolean,
): ScopedMCP[] {
  if (!required && !fs.existsSync(mcpPath)) {
    console.error(`[agent-task] no global MCP config at ${mcpPath}; continuing without MCP`);
    return [];
  }
  let raw: string;
  try {
    raw = fs.readFileSync(mcpPath, 'utf-8');
  } catch {
    console.error(`Error: --mcp file not found or unreadable: ${mcpPath}`);
    process.exit(2);
  }
  let parsed: { mcpServers?: Record<string, unknown> };
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    console.error(`Error: --mcp file is not valid JSON: ${e}`);
    process.exit(2);
  }
  const out: Array<{ config: MCPServerConfig; scope: MCPScopeType }> = [];
  for (const [name, cfg] of Object.entries(parsed.mcpServers ?? {})) {
    if ((cfg as Record<string, unknown>).enabled === false) continue;
    out.push({ config: { ...(cfg as MCPServerConfig), name }, scope: 'project' });
  }
  return out;
}

function assertDirExists(dir: string, flagName: string): void {
  let stat: fs.Stats;
  try {
    stat = fs.statSync(dir);
  } catch {
    console.error(`Error: ${flagName} path does not exist: ${dir}`);
    process.exit(2);
  }
  if (!stat.isDirectory()) {
    console.error(`Error: ${flagName} is not a directory: ${dir}`);
    process.exit(2);
  }
}

function tryParseJson(text: string): unknown | undefined {
  const trimmed = text.trim();
  if (!trimmed) return undefined;

  const direct = trySafeParse(trimmed);
  if (direct !== undefined) return direct;

  const fenceMatch = trimmed.match(/```(?:json)?\s*\n([\s\S]*?)\n```/);
  if (fenceMatch) {
    const inner = trySafeParse(fenceMatch[1]);
    if (inner !== undefined) return inner;
  }

  const objMatch = trimmed.match(/\{[\s\S]*\}|\[[\s\S]*\]/);
  if (objMatch) {
    const inner = trySafeParse(objMatch[0]);
    if (inner !== undefined) return inner;
  }

  return undefined;
}

function trySafeParse(s: string): unknown | undefined {
  try { return JSON.parse(s); } catch { return undefined; }
}
