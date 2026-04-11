/**
 * DispatchTool MCP 服务器进程（isAdmin 群组专用）
 *
 * 通过 stdio 接入 sema-core。仅读写 dispatch-state.json，
 * 不直接控制 AgentPool / GroupManager，所有实际调度由主进程 DispatchBridge 执行。
 *
 * 环境变量：
 *   SEMACLAW_DISPATCH_STATE_PATH — dispatch-state.json 绝对路径
 *   SEMACLAW_ADMIN_FOLDER        — 发起 dispatch 的 admin agent folder
 *
 * 工具：
 *   list_agents     — 列出所有可用 agent（非 admin）
 *   create_parent   — 声明一个主任务及其所有子任务，返回 parentId
 *   dispatch_task   — 等待指定 parent 下某个 task 的子任务完成，返回结果
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import type { DispatchState, DispatchParent, DispatchTask } from '../agent/DispatchBridge';
import { PersonaRegistry } from '../agent/PersonaRegistry';
import { readDisabledSubagents } from '../subagents/disabled.js';

// TS2589 workaround: MCP SDK zod type instantiation
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyZod = any;

// ===== 环境变量 =====

const statePath = process.env.SEMACLAW_DISPATCH_STATE_PATH;
if (!statePath) {
  console.error('[dispatch-server] Missing SEMACLAW_DISPATCH_STATE_PATH');
  process.exit(1);
}

const adminFolder = process.env.SEMACLAW_ADMIN_FOLDER;
if (!adminFolder) {
  console.error('[dispatch-server] Missing SEMACLAW_ADMIN_FOLDER');
  process.exit(1);
}

// 虚拟 agent 人设注册表（可选）
const agentsConfigDir = process.env.SEMACLAW_AGENTS_CONFIG_DIR;
const personaRegistry = agentsConfigDir ? new PersonaRegistry(agentsConfigDir) : null;

/** 读取 admin agent 当前工作目录（workspace state 文件） */
function readAdminWorkspace(): string {
  try {
    const stateFile = path.join(os.homedir(), '.semaclaw', `workspace-state-${adminFolder}.json`);
    const raw = fs.readFileSync(stateFile, 'utf-8');
    return (JSON.parse(raw) as { currentDir?: string }).currentDir ?? '';
  } catch {
    return '';
  }
}

// ===== File helpers（与 DispatchBridge 相同的锁机制）=====

function readState(): DispatchState {
  try {
    return JSON.parse(fs.readFileSync(statePath!, 'utf-8')) as DispatchState;
  } catch {
    return { _seq: 0, agents: [], parents: [] };
  }
}

function writeState(state: DispatchState): void {
  fs.mkdirSync(path.dirname(statePath!), { recursive: true });
  fs.writeFileSync(statePath!, JSON.stringify(state, null, 2), 'utf-8');
}

function modifyState(fn: (state: DispatchState) => void): void {
  const lockPath = statePath! + '.lock';
  let locked = false;
  for (let i = 0; i < 50; i++) {
    try {
      fs.writeFileSync(lockPath, String(process.pid), { flag: 'wx' });
      locked = true;
      break;
    } catch {
      // 同步忙等 ~10ms，给另一进程释放锁的时间
      const until = Date.now() + 10;
      while (Date.now() < until) { /* spin */ }
    }
  }
  if (!locked) {
    // 50 次抢锁失败：通过 PID 判断是否是 stale lock（进程崩溃遗留），安全后才强删。
    let staleLock = false;
    try {
      const lockPid = parseInt(fs.readFileSync(lockPath, 'utf-8'), 10);
      if (!isNaN(lockPid) && lockPid !== process.pid) {
        try {
          process.kill(lockPid, 0);
          staleLock = false; // 进程存在，锁有效
        } catch {
          staleLock = true; // 进程不存在，stale lock
        }
      }
    } catch { /* ignore */ }

    if (staleLock) {
      try { fs.unlinkSync(lockPath); } catch { /* ignore */ }
      try {
        fs.writeFileSync(lockPath, String(process.pid), { flag: 'wx' });
        locked = true;
      } catch { /* ignore */ }
    }
  }
  if (!locked) {
    console.warn('[dispatch-server] Failed to acquire state lock, skipping modification');
    return;
  }
  try {
    const state = readState();
    fn(state);
    writeState(state);
  } finally {
    try { fs.unlinkSync(lockPath); } catch { /* ignore */ }
  }
}

/** 生成 ID：p-YYYYMMDD-{seq:04d} 或 d-YYYYMMDD-{seq:04d} */
function nextId(state: DispatchState, prefix: 'p' | 'd'): string {
  const seq = ++state._seq;
  const date = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  return `${prefix}-${date}-${String(seq).padStart(4, '0')}`;
}

/** 在 state 里按 parentId + taskLabel 查找任务 */
function findTaskByLabel(state: DispatchState, parentId: string, label: string): DispatchTask | undefined {
  const parent = state.parents.find(p => p.id === parentId);
  return parent?.tasks.find(t => t.label === label);
}

/** 解析 agentName（支持 name/id 匹配 + persona:{name} 格式） */
function resolveAgent(state: DispatchState, agentName: string): {
  id: string; jid: string; isVirtual: boolean; personaName?: string;
} | null {
  // persona:{name} 格式：虚拟 agent
  if (agentName.startsWith('persona:')) {
    const personaName = agentName.slice(8);
    if (personaRegistry?.get(personaName)) {
      return { id: agentName, jid: '', isVirtual: true, personaName };
    }
    return null;
  }
  // 持久 agent
  const lower = agentName.toLowerCase();
  const agent = state.agents.find(
    a => a.name.toLowerCase() === lower || a.id.toLowerCase() === lower
  );
  return agent ? { id: agent.id, jid: agent.jid, isVirtual: false } : null;
}

/**
 * DAG 环检测（DFS）。
 * 返回环中某个节点的 label，无环返回 null。
 */
function detectCycle(tasks: Array<{ label: string; dependsOn: string[] }>): string | null {
  const visited = new Set<string>();
  const inStack = new Set<string>();

  const dfs = (label: string): boolean => {
    if (inStack.has(label)) return true;
    if (visited.has(label)) return false;
    visited.add(label);
    inStack.add(label);
    const task = tasks.find(t => t.label === label);
    for (const dep of task?.dependsOn ?? []) {
      if (dfs(dep)) return true;
    }
    inStack.delete(label);
    return false;
  };

  for (const task of tasks) {
    if (!visited.has(task.label) && dfs(task.label)) return task.label;
  }
  return null;
}

// ===== MCP Server =====

const server = new McpServer({ name: 'semaclaw-dispatch', version: '1.0.0' });
// TS2589 workaround
const tool = server.tool.bind(server) as AnyZod;

// ===== list_agents =====

tool(
  'list_agents',
  'List all available agents (persistent + virtual personas) that can be dispatched tasks.',
  {},
  async () => {
    const state = readState();
    const lines: string[] = [];

    // 持久 agent
    if (state.agents.length > 0) {
      lines.push('**Persistent Agents:**');
      for (const a of state.agents) {
        lines.push(`- ${a.name} (id: ${a.id}, channel: ${a.channel || 'web-only'})`);
      }
    }

    // 虚拟 agent personas（过滤已禁用的）
    const disabledSubagents = readDisabledSubagents();
    const personas = (personaRegistry?.list() ?? []).filter(p => !disabledSubagents.has(p.name));
    if (personas.length > 0) {
      if (lines.length > 0) lines.push('');
      lines.push('**Virtual Personas:**');
      for (const p of personas) {
        const desc = p.description.replace(/^["']|["']$/g, '');
        lines.push(`- persona:${p.name} — ${desc}`);
      }
    }

    if (lines.length === 0) {
      return { content: [{ type: 'text', text: 'No agents or personas registered.' }] };
    }
    return { content: [{ type: 'text', text: lines.join('\n') }] };
  }
);

// ===== create_parent =====

tool(
  'create_parent',
  'Declare a parent task with a goal and a DAG of subtasks. Each task can declare dependsOn (labels of tasks that must complete first). Tasks with no dependencies start immediately; others start once all deps are terminal. Returns a parentId and task list for use in dispatch_task calls.',
  {
    goal: z.string().describe('Overall goal of this task group (shown to each agent as context)'),
    tasks: z.array(z.object({
      label:      z.string().describe('Unique label for this task within the parent (used in dependsOn and dispatch_task). Auto-generated as "task-N" if omitted.'),
      agentName:  z.string().describe('Agent name or ID to assign this subtask to'),
      prompt:     z.string().describe('The specific task prompt for this agent'),
      dependsOn:  z.array(z.string()).optional().describe('Labels of other tasks in this parent that must reach terminal state before this task starts. Omit or pass [] for tasks with no prerequisites.'),
    })).min(1).describe('DAG of subtasks. Multiple tasks can share the same agent (e.g., same agent in sequential stages).'),
    timeoutSeconds: z.number().optional().describe('Per-task timeout in seconds, counted from when each task actually starts processing (default: 900)'),
  },
  async ({ goal, tasks, timeoutSeconds = 900 }: {
    goal: string;
    tasks: { label?: string; agentName: string; prompt: string; dependsOn?: string[] }[];
    timeoutSeconds?: number;
  }) => {
    const state = readState();
    const errors: string[] = [];

    // 补全 label（未提供时自动生成）
    const normalized = tasks.map((t, i) => ({
      label:     t.label?.trim() || `task-${i}`,
      agentName: t.agentName,
      prompt:    t.prompt,
      dependsOn: t.dependsOn ?? [],
    }));

    // 校验 label 唯一性
    const labelSet = new Set<string>();
    for (const t of normalized) {
      if (labelSet.has(t.label)) errors.push(`Duplicate label: "${t.label}"`);
      else labelSet.add(t.label);
    }

    // 校验 dependsOn 引用存在
    for (const t of normalized) {
      for (const dep of t.dependsOn) {
        if (!labelSet.has(dep)) errors.push(`Task "${t.label}" depends on unknown label: "${dep}"`);
      }
    }

    // 解析 agentName（支持持久 agent 和 persona:{name}）
    type Resolved = {
      label: string; agentId: string; agentJid: string;
      prompt: string; dependsOn: string[];
      isVirtual: boolean; personaName?: string;
    };
    const resolved: Resolved[] = [];
    for (const t of normalized) {
      const agent = resolveAgent(state, t.agentName);
      if (!agent) {
        errors.push(`Unknown agent: "${t.agentName}" (for task "${t.label}")`);
      } else {
        resolved.push({
          label: t.label, agentId: agent.id, agentJid: agent.jid,
          prompt: t.prompt, dependsOn: t.dependsOn,
          isVirtual: agent.isVirtual, personaName: agent.personaName,
        });
      }
    }

    if (errors.length > 0) {
      return { content: [{ type: 'text', text: `Error:\n${errors.map(e => `  - ${e}`).join('\n')}` }], isError: true };
    }

    // DAG 环检测
    const cycleNode = detectCycle(normalized);
    if (cycleNode) {
      return { content: [{ type: 'text', text: `Error: Circular dependency detected involving task "${cycleNode}"` }], isError: true };
    }

    let parentId = '';
    let isQueued = false;
    modifyState(s => {
      parentId = nextId(s, 'p');
      const now = new Date().toISOString();
      // 同一 admin 同时只允许一个 active parent，多余的排队
      const hasActive = s.parents.some(
        p => p.adminFolder === adminFolder && p.status === 'active'
      );
      isQueued = hasActive;
      const parent: DispatchParent = {
        id: parentId,
        adminFolder: adminFolder!,
        sharedWorkspace: hasActive ? null : readAdminWorkspace(),
        goal,
        status: hasActive ? 'queued' : 'active',
        createdAt: now,
        completedAt: null,
        tasks: resolved.map(r => ({
          id:          nextId(s, 'd'),
          label:       r.label,
          agentId:     r.agentId,
          agentJid:    r.agentJid,
          dependsOn:   r.dependsOn,
          status:      'registered',
          prompt:      r.prompt,
          result:      null,
          createdAt:   now,
          startedAt:   null,
          timeoutSeconds,
          timeoutAt:   null,
          completedAt: null,
          ...(r.isVirtual ? { isVirtual: true, personaName: r.personaName } : {}),
        } satisfies DispatchTask)),
      };
      s.parents.push(parent);
    });

    const taskLines = resolved.map(r => {
      const deps = r.dependsOn.length > 0 ? `, depends on: [${r.dependsOn.join(', ')}]` : ', no deps';
      return `  - "${r.label}" (agent: ${r.agentId}${deps})`;
    }).join('\n');

    const statusNote = isQueued
      ? `Status: QUEUED (another dispatch is active; this will start automatically when it completes)`
      : `Status: ACTIVE (starting immediately)`;

    return {
      content: [{
        type: 'text',
        text: [
          `Parent task created: ${parentId}`,
          statusNote,
          `Tasks:\n${taskLines}`,
          ``,
          `Call dispatch_task("${parentId}", "<label>") for each task concurrently.`,
          `DispatchBridge handles dependency ordering and workspace switching automatically.`,
        ].join('\n'),
      }],
    };
  }
);

// ===== dispatch_task =====

tool(
  'dispatch_task',
  'Wait for a specific task (identified by its label) under a parent to complete and return the result. Call this concurrently for all tasks in the parent — DispatchBridge handles dependency ordering automatically.',
  {
    parentId:       z.string().describe('Parent task ID returned by create_parent'),
    taskLabel:      z.string().describe('The label of the task to wait for (as returned by create_parent)'),
    timeoutSeconds: z.number().optional().describe('Override poll timeout in seconds (default: uses task timeoutAt)'),
  },
  async ({ parentId, taskLabel, timeoutSeconds }: { parentId: string; taskLabel: string; timeoutSeconds?: number }) => {
    const startTask = findTaskByLabel(readState(), parentId, taskLabel);
    if (!startTask) {
      return {
        content: [{ type: 'text', text: `Task not found: parent=${parentId} label="${taskLabel}"` }],
        isError: true,
      };
    }

    // 初始 deadline：用调用者传入的 timeoutSeconds，或根据任务定义估算。
    // 注意：任务可能还没开始（status=registered），此时 timeoutAt 为 null。
    // 一旦任务开始（timeoutAt 被设置），在轮询中动态切换到实际 deadline，
    // 避免依赖前序任务的顺序任务因等待时间过长而提前宣告超时。
    let deadline = timeoutSeconds
      ? Date.now() + timeoutSeconds * 1000
      : Date.now() + startTask.timeoutSeconds * 1000;

    // Poll until terminal status
    while (true) {
      if (Date.now() > deadline) {
        return { content: [{ type: 'text', text: `Task "${taskLabel}" timed out waiting for result` }], isError: true };
      }
      const current = findTaskByLabel(readState(), parentId, taskLabel);
      if (!current) {
        return { content: [{ type: 'text', text: `Task "${taskLabel}" disappeared from state file` }], isError: true };
      }
      // 任务开始后，切换到任务实际的 timeoutAt 作为 deadline（从任务实际启动时刻起算的 15 分钟）。
      // 只在未显式指定 timeoutSeconds 时才动态更新，避免覆盖调用者的意图。
      if (!timeoutSeconds && current.timeoutAt) {
        const taskDeadline = new Date(current.timeoutAt).getTime();
        if (taskDeadline > deadline) {
          deadline = taskDeadline;
        }
      }
      if (current.status === 'done') {
        return { content: [{ type: 'text', text: current.result ?? '' }] };
      }
      if (current.status === 'error') {
        return { content: [{ type: 'text', text: `Task "${taskLabel}" failed (agent: ${current.agentId})` }], isError: true };
      }
      if (current.status === 'timeout') {
        return { content: [{ type: 'text', text: `Task "${taskLabel}" timed out (agent: ${current.agentId})` }], isError: true };
      }
      await new Promise(r => setTimeout(r, 500));
    }
  }
);

// ===== Start =====

const transport = new StdioServerTransport();
server.connect(transport).catch(err => {
  console.error('[dispatch-server] Fatal:', err);
  process.exit(1);
});
