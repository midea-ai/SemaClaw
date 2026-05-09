/**
 * IsolatedRunner — 一次性独立 Agent 执行器
 *
 * 与 AgentPool 完全解耦：不依赖 GroupBinding、ScheduleTool、broadcastReply。
 * 适用场景：
 *   1. AgentPool.runIsolated  — 定时任务（包一层注入 ScheduleTool + broadcastReply）
 *   2. semaclaw agent-task CLI — Hook 脚本调用，反思/总结/分析等独立 Agent 任务
 *
 * 默认行为：
 *   - hooks: undefined（防止 hook 递归触发 child agent）
 *   - skipMCPInit: true（与 AgentPool 一致，避免并发竞态）
 *   - skip*Permission: true（独立任务无人值守）
 */
import { SemaCore } from 'sema-core';
import type { MessageCompleteData, StateUpdateData } from 'sema-core/event';
import type { SemaCoreConfig } from 'sema-core/types';
import type { MCPServerConfig, MCPScopeType } from 'sema-core/mcp';

const MAIN_AGENT_ID = 'main';
const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000;

export interface OneShotOptions {
  /** 用户输入提示词 */
  prompt: string;
  /** 工作目录（文件读写、Bash 执行等） */
  workingDir: string;
  /** Agent 数据目录（CLAUDE.md、.sema/）；不传则等于 workingDir */
  agentDataDir?: string;
  /** 引擎实例 ID（多租户隔离 key）；不传则自动生成 */
  instanceId?: string;
  /** 限定使用的工具；null/undefined = 所有工具 */
  useTools?: string[] | null;
  /** 额外 skills 目录 */
  skillsExtraDirs?: SemaCoreConfig['skillsExtraDirs'];
  /** 系统提示 */
  systemPrompt?: string;
  /** 用户规则 */
  customRules?: string;
  /** Agent 模式 */
  agentMode?: 'Agent' | 'Plan';
  /** Hook 配置（默认 undefined，禁用 hooks 防止递归） */
  hooks?: SemaCoreConfig['hooks'];
  /** Hook 环境变量 */
  hookEnv?: Record<string, string>;
  /** 启动后注册的 MCP 服务器（创建 session 之前） */
  mcpConfigs?: Array<{ config: MCPServerConfig; scope: MCPScopeType }>;
  /** 超时（毫秒），默认 5 分钟 */
  timeoutMs?: number;
  /** 跳过权限检查；默认全部跳过 */
  skipPermissions?: {
    fileEdit?: boolean;
    bashExec?: boolean;
    skill?: boolean;
    mcpTool?: boolean;
  };
  /** 监听 message:complete（主 Agent 每轮回复） */
  onMessage?: (data: MessageCompleteData) => void;
  /** 监听 state:update */
  onState?: (data: StateUpdateData) => void;
}

export interface OneShotResult {
  /** 最后一条主 Agent message:complete 的 content（最终回复） */
  text: string;
  /** 所有主 Agent message:complete 的 content（按顺序） */
  allTexts: string[];
  /** 总耗时（毫秒） */
  durationMs: number;
  /** 主 Agent message:complete 触发次数（粗略 turn 数） */
  turnCount: number;
  /** 是否因超时结束 */
  timedOut: boolean;
}

/**
 * 创建独立 SemaCore，执行单次 prompt，到达 idle 后 dispose 并返回结果。
 *
 * 与 SemaCore 事件流的对接：
 *   - message:complete (agentId === 'main') → 收集到 allTexts
 *   - state:update (state === 'idle') → resolve
 *   - 超时 → 强制 reject（不抛错，返回 timedOut: true）
 */
export async function runOneShot(opts: OneShotOptions): Promise<OneShotResult> {
  const startedAt = Date.now();
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const skip = opts.skipPermissions ?? {};

  const instanceId = opts.instanceId ?? `oneshot-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;

  const core = new SemaCore({
    instanceId,
    workingDir: opts.workingDir,
    agentDataDir: opts.agentDataDir ?? opts.workingDir,
    agentMode: opts.agentMode ?? 'Agent',
    useTools: opts.useTools ?? null,
    skillsExtraDirs: opts.skillsExtraDirs,
    systemPrompt: opts.systemPrompt,
    customRules: opts.customRules,
    logLevel: 'warn',
    skipMCPInit: true,
    skipFileEditPermission: skip.fileEdit ?? true,
    skipBashExecPermission: skip.bashExec ?? true,
    skipSkillPermission: skip.skill ?? true,
    skipMCPToolPermission: skip.mcpTool ?? true,
    hooks: opts.hooks,
    hookEnv: opts.hookEnv,
  });

  for (const { config, scope } of opts.mcpConfigs ?? []) {
    await core.addOrUpdateMCPServer(config, scope);
  }

  await core.createSession(`session-${instanceId}`);

  const allTexts: string[] = [];
  let turnCount = 0;
  let timedOut = false;

  return new Promise<OneShotResult>((resolve) => {
    let done = false;

    const finish = (reason: 'idle' | 'timeout') => {
      if (done) return;
      done = true;
      if (reason === 'timeout') timedOut = true;
      clearTimeout(timer);
      core.off('message:complete', onMessageComplete);
      core.off('state:update', onStateUpdate);
      // dispose 是异步的，我们不等它完成 — 失败也只是泄漏一次性资源
      (core as { dispose?: () => Promise<void> }).dispose?.().catch(() => {});
      resolve({
        text: allTexts[allTexts.length - 1] ?? '',
        allTexts,
        durationMs: Date.now() - startedAt,
        turnCount,
        timedOut,
      });
    };

    const timer = setTimeout(() => finish('timeout'), timeoutMs);

    const onMessageComplete = (data: MessageCompleteData) => {
      if (data.agentId !== MAIN_AGENT_ID) return;
      turnCount += 1;
      if (data.content.trim()) allTexts.push(data.content);
      opts.onMessage?.(data);
    };

    const onStateUpdate = (data: StateUpdateData) => {
      opts.onState?.(data);
      if (data.state === 'idle') finish('idle');
    };

    core.on<MessageCompleteData>('message:complete', onMessageComplete);
    core.on<StateUpdateData>('state:update', onStateUpdate);
    core.processUserInput(opts.prompt);
  });
}
