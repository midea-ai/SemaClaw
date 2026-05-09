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
import { runOneShot } from '../../agent/IsolatedRunner';
import { config } from '../../config';
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

  const useTools = opts.tools
    ? opts.tools.split(',').map(t => t.trim()).filter(Boolean)
    : null;

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
