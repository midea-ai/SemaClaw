/**
 * AgentPool — 每群组一个 SemaCore 实例（懒创建）
 *
 * 职责：
 *   1. getOrCreate(binding) — 懒初始化 SemaCore，创建 session，绑定事件
 *   2. processAndWait(jid, binding, prompt) — 调用 processUserInput，等待 idle
 *   3. destroy(jid) — 销毁指定群组的 Agent（用于注销时清理）
 *
 * 事件绑定：
 *   - message:complete（agentId === 'main'）→ sendReply
 *   - session:error → 打印错误日志
 *
 * 注意：sendReply 由外层（MessageRouter）注入，避免循环依赖。
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { SemaCore } from 'sema-core';
import type { MessageCompleteData, StateUpdateData, SessionErrorData, TodosUpdateData, CompactExecData, CompactStartData } from 'sema-core/event';
import type { ScheduledTask, MessageAttachment } from '../types';
import { GroupBinding, IChannel } from '../types';
import { buildAgentInput, type ImageAttachment } from './InputBuilder';
import { config } from '../config';
import { scheduleMCPConfig, workspaceMCPConfig, memoryMCPConfig, dispatchMCPConfig, feishuWikiMCPConfig, virtualMCPConfig } from '../mcp/mcpHelper';
import { getFeishuApps } from '../gateway/GroupManager';
import type { PermissionPayload, AskQuestionPayload } from './PermissionBridge';
import { getAgentAllowedWorkDirs, getAdminPermissionsConfig, getThinkingEnabled } from '../gateway/GroupManager';
import { DailyLogger } from '../memory/DailyLogger';
import { MemoryManager, formatSearchResults } from '../memory/MemoryManager';
import { PermissionBridge, PermissionBridgeOptions } from './PermissionBridge';
import { readDisabledSkills, invalidateDisabledSkillsCache } from '../skills/disabled.js';
import { expandSkillsDir } from '../skills/expand.js';
import type { MarketplaceManager } from '../marketplace/MarketplaceManager.js';
import type { DispatchBridge } from './DispatchBridge';
import type { GroupQueue } from './GroupQueue';
import { getSkillsReloadSignalPath } from '../clawhub/signal.js';
import { buildPromptForGroup } from './SessionBridge';
import { setLastAgentTimestamp } from '../db/db';
import { loadAndResolveHookConfig } from '../hooks/HookConfigLoader';

/** Agent 响应回调：由 MessageRouter 提供，发送消息回频道 */
export type SendReply = (
  chatJid: string,
  text: string,
  botToken?: string
) => Promise<void>;

/** WsGateway 事件接收接口（解耦，避免循环依赖） */
export interface AgentEventSink {
  notifyAgentReply(chatJid: string, text: string): void;
  notifyAgentState(chatJid: string, state: string): void;
  notifyPermissionRequest?(chatJid: string, requestId: string, payload: PermissionPayload): void;
  notifyAskQuestionRequest?(chatJid: string, requestId: string, payload: AskQuestionPayload): void;
  notifyPermissionResolved?(chatJid: string, requestId: string, optionKey: string, optionLabel: string): void;
  notifyAskQuestionResolved?(chatJid: string, requestId: string, answers: Record<string, string>): void;
  notifyAgentTodos?(agentJid: string, agentName: string, todos: { content: string; status: string; activeForm?: string }[]): void;
  notifyAgentCompacting?(chatJid: string, isCompacting: boolean): void;
}

/** Agent 收到 message:complete 时的主代理 ID */
const MAIN_AGENT_ID = 'main';

/** processAndWait 超时（毫秒）
 * 需大于 dispatch_task 的最长运行时间（默认 600s），故设为 30 分钟。 */
const AGENT_TIMEOUT_MS = 30 * 60 * 1000; // 30 分钟

/** 工作区状态文件路径 */
function workspaceStateFile(folder: string): string {
  return path.join(os.homedir(), '.semaclaw', `workspace-state-${folder}.json`);
}


/**
 * 为 resume prompt 构建 dispatch 上下文提示。
 * 若 adminFolder 有 active dispatch parents，返回提醒文本（防止 agent 因
 * checkpoint-1 cancel stop 误以为 dispatch 失败而重新分发）；否则返回 null。
 */
function buildDispatchResumeHint(dispatchBridge: import('./DispatchBridge').DispatchBridge | null, adminFolder: string): string | null {
  if (!dispatchBridge) return null;
  const parents = dispatchBridge.getParents().filter(
    p => p.adminFolder === adminFolder && p.status === 'active',
  );
  if (parents.length === 0) return null;

  const lines: string[] = [
    '[系统提示] 你之前已通过 dispatch_task 分发了以下任务，这些任务正在运行中，请勿重复创建或分发：',
  ];
  for (const parent of parents) {
    lines.push(`- 任务组 ${parent.id}（目标：${parent.goal}）`);
    for (const task of parent.tasks) {
      const statusLabel =
        task.status === 'processing' ? '执行中' :
        task.status === 'registered' ? '等待中' :
        task.status === 'done' ? '已完成' : task.status;
      lines.push(`  • [${task.label}] → ${task.agentId}：${task.prompt.slice(0, 80)}（${statusLabel}）`);
    }
  }
  lines.push('这些任务完成后会通过消息通知你，请等待结果。');
  return lines.join('\n');
}

export class AgentPool {
  private cores = new Map<string, SemaCore>();
  /** jid → 对应的 GroupBinding */
  private bindings = new Map<string, GroupBinding>();
  private permissionBridge: PermissionBridge;
  private dailyLogger = new DailyLogger();
  private agentEventSink: AgentEventSink | null = null;
  /** 主 Agent 是否跳过权限审批（运行时状态，从 config.json 初始化） */
  private skipMainAgentPermissions = false;
  /** 所有 Agent 是否跳过权限审批（运行时状态，从 config.json 初始化） */
  private skipAllAgentsPermissions = false;
  /** 是否启用 Thinking 模式（运行时状态，从 config.json 初始化） */
  private thinkingEnabled = true;
  /** jid → 重置超时计时器的函数（processAndWait 运行期间有效） */
  private activeTimerResets = new Map<string, () => void>();
  /** jid → 当前运行时工作目录（workspace_switch 后更新） */
  private runtimeWorkDirs = new Map<string, string>();
  /** jid → 取消文件监听的函数 */
  private workspaceWatchers = new Map<string, () => void>();
  private dispatchBridge: DispatchBridge | null = null;
  private groupQueue: GroupQueue | null = null;
  /** jid → dispatch task 期间的临时工作目录（完成后 revert） */
  private marketplaceManager: MarketplaceManager | null = null;
  private userMCPServerNames = new Set<string>();
  /** marketplace MCP 预热用的最小化 SemaCore，无需真实 session，仅用于连接 MCP */
  private probeCore?: SemaCore;
  private mcpWarmupStarted = false;
  private dispatchWorkspaceOverrides = new Map<string, string>();
  /** jid 集合：当前正在实际执行 dispatch task 的 agent（非仅入队） */
  private dispatchExecuting = new Set<string>();
  /** jid → 最后一条 agent 回复（供 dispatch fallback 通知使用） */
  private lastDispatchReplies = new Map<string, string>();
  /** jid → 当前正在执行的 dispatch taskId（由 DispatchBridge 通过 sendToAgent 传入） */
  private dispatchTaskMap = new Map<string, string>();
  /** jid → processAndWait 的中止回调（destroy 时触发，打断挂起的 Promise） */
  private activeAborts = new Map<string, (reason: string) => void>();
  /** jid → bindEvents/PermissionBridge 注册的持久监听器清理函数 */
  private eventCleanups = new Map<string, () => void>();
  /** jid → 最新完整 todos 快照（供 WsGateway subscribe 时初始推送） */
  private cachedTodos = new Map<string, { agentName: string; todos: { content: string; status: string; activeForm?: string }[] }>();
  /** jid → 正在进行的 getOrCreate Promise（并发锁，防止同一 jid 重复创建） */
  private pendingCreates = new Map<string, Promise<SemaCore>>();
  /** admin jid → 因 pauseAgent 被同步暂停的子 agent jid 列表（resume 时恢复） */
  private pausedChildrenByAdmin = new Map<string, string[]>();
  /**
   * core 处于 idle 且无活跃 dispatch 时被 pauseAgent 调用的 jid 集合（「合成暂停」）。
   * sema-core 是 idle，pauseSession() 是 no-op；需手动推送 paused 给前端。
   * resume 时不调 processUserInput（避免在干净 session 注入多余 user turn）。
   */
  private synthPausedJids = new Set<string>();
  /**
   * core 处于 idle 但 dispatch 有活跃任务时被 pauseAgent 调用的 jid 集合（「调度暂停」）。
   * 主 agent 本身在等待子任务结果（两次 PAW 之间），不需要 pauseSession()；
   * 暂停语义是阻止 DispatchBridge 调度新任务，同时给前端推 paused 状态。
   * resume 时同样不调 processUserInput，只恢复 dispatch 调度。
   */
  private dispatchPausedJids = new Set<string>();

  constructor(
    private readonly sendReply: SendReply,
    channels: IChannel | IChannel[],
    permissionBridgeOptions?: PermissionBridgeOptions,
  ) {
    // maxContentLength: 200 — 适配 Telegram 单条消息长度限制
    // Web UI 实现时可通过 permissionBridgeOptions 传入更大值或 Infinity
    this.permissionBridge = new PermissionBridge(
      Array.isArray(channels) ? channels : [channels],
      {
        maxContentLength: 200,
        ...permissionBridgeOptions,
      },
    );
    // 权限消息发出或用户点击按钮时重置超时计时器，避免权限等待期间超时
    this.permissionBridge.setActivityCallback((jid) => this.notifyActivity(jid));
    // 从 config.json 初始化权限开关
    const permCfg = getAdminPermissionsConfig();
    this.skipMainAgentPermissions = permCfg.skipMainAgentPermissions;
    this.skipAllAgentsPermissions = permCfg.skipAllAgentsPermissions;
    // 从 config.json 初始化 Thinking 开关
    this.thinkingEnabled = getThinkingEnabled();
    // 监听 skills 热更新信号（CLI install/refresh 后写入）
    this.watchSkillsReloadSignal();
  }

  /**
   * 监听 CLI 写入的 skills reload 信号文件。
   * 信号文件变化时调用所有活跃 agent 的 reloadSkills()。
   */
  private watchSkillsReloadSignal(): void {
    const signalPath = getSkillsReloadSignalPath();
    fs.watchFile(signalPath, { interval: 1000 }, () => {
      this.reloadAllSkills();
    });
  }

  /** 重新加载所有活跃 agent 的 skill 注册表（不重建 session） */
  reloadAllSkills(): void {
    invalidateDisabledSkillsCache();
    const count = this.cores.size;
    if (count === 0) {
      console.log('[AgentPool] skills reload signal received (no active agents)');
      return;
    }
    console.log(`[AgentPool] Reloading skills for ${count} active agent(s)...`);
    // 重新展开 skillsExtraDirs（携带最新 disabled 状态）并写回 core 的 initialConfig，
    // 否则 SemaCore.reloadSkills() 会沿用构造时的静态目录列表，disable/enable 不生效。
    const _disabled = readDisabledSkills();
    for (const [jid, core] of this.cores.entries()) {
      const binding = this.bindings.get(jid);
      if (binding) {
        const workingDir = path.resolve(config.paths.workspaceDir, binding.folder);
        const freshDirs = [
          ...(config.paths.bundledSkillsDir
            ? expandSkillsDir(config.paths.bundledSkillsDir, 'managed', _disabled)
            : []),
          ...expandSkillsDir(path.join(os.homedir(), '.claude', 'skills'), 'user', _disabled),
          ...expandSkillsDir(config.paths.managedSkillsDir, 'managed', _disabled),
          ...(this.marketplaceManager?.getSkillExtraDirs(_disabled) ?? []),
          ...expandSkillsDir(path.join(workingDir, 'skills'), 'workspace', _disabled),
        ];
        // SemaCore.engine.initialConfig 是可变对象，直接更新 skillsExtraDirs
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const engineConfig = (core as any)?.engine?.initialConfig;
        if (engineConfig) engineConfig.skillsExtraDirs = freshDirs;
      }
      core.reloadSkills(_disabled);
    }
    console.log('[AgentPool] Skills reloaded.');
  }

  setMarketplaceManager(mm: MarketplaceManager): void {
    this.marketplaceManager = mm;
  }

  /** 插件启用/禁用后，对所有活跃 engine（含 probeCore）reconcile marketplace MCP 服务器（mkt__ 前缀）*/
  async reloadMarketplaceMCPServers(): Promise<void> {
    const desired = this.marketplaceManager?.getMCPServerDefs() ?? [];
    const desiredNames = new Set(desired.map(c => c.name));

    const targets = [...this.cores.values(), ...(this.probeCore ? [this.probeCore] : [])];
    for (const core of targets) {
      const allInfos = [
        ...(core.getMCPServerConfigs().get('project') ?? []),
        ...(core.getMCPServerConfigs().get('user') ?? []),
      ];
      for (const { config: cfg } of allInfos) {
        if (cfg.name.startsWith('mkt__') && !desiredNames.has(cfg.name)) {
          void core.removeMCPServer(cfg.name, 'project');
        }
      }
      for (const cfg of desired) {
        void core.addOrUpdateMCPServer(cfg as Parameters<typeof core.addOrUpdateMCPServer>[0], 'project');
      }
    }

    // 如果还没有 probeCore 且现在有了新的 marketplace MCP，重置预热标志让 warmup 可重新触发
    if (!this.probeCore && desired.length > 0 && this.cores.size === 0) {
      this.mcpWarmupStarted = false;
    }
  }

  /** 用户 MCP 配置保存后，对所有活跃 engine reconcile 用户全局 MCP 服务器 */
  async reloadUserMCPServers(newConfigs: Array<Record<string, unknown> & { name: string }>): Promise<void> {
    const newNames = new Set(newConfigs.map(c => c.name));
    for (const core of this.cores.values()) {
      for (const name of this.userMCPServerNames) {
        if (!newNames.has(name)) {
          void core.removeMCPServer(name, 'project');
        }
      }
      for (const cfg of newConfigs) {
        if (cfg['enabled'] !== false) {
          void core.addOrUpdateMCPServer(cfg as unknown as Parameters<typeof core.addOrUpdateMCPServer>[0], 'project');
        }
      }
    }
    this.userMCPServerNames = newNames;
  }

  /** 读取当前权限开关状态 */
  getPermissionsConfig(): { skipMainAgentPermissions: boolean; skipAllAgentsPermissions: boolean } {
    return {
      skipMainAgentPermissions: this.skipMainAgentPermissions,
      skipAllAgentsPermissions: this.skipAllAgentsPermissions,
    };
  }

  /** 在没有活跃 agent 时预热 marketplace MCP 连接，使 UI 能立即展示工具列表。
   *  只运行一次；有真实 core 后自动降级（getMarketplaceMCPStatus 优先用真实 core）。*/
  warmUpMarketplaceMCPs(): void {
    if (this.mcpWarmupStarted || this.cores.size > 0) return;
    const mcpDefs = this.marketplaceManager?.getMCPServerDefs() ?? [];
    if (mcpDefs.length === 0) return;

    this.mcpWarmupStarted = true;
    void (async () => {
      try {
        const probeDir = path.join(os.homedir(), '.semaclaw', '__mcp_probe__');
        fs.mkdirSync(path.join(probeDir, '.sema'), { recursive: true });
        fs.writeFileSync(path.join(probeDir, '.sema', 'mcp.json'), JSON.stringify({ mcpServers: {} }), 'utf-8');

        const core = new SemaCore({
          instanceId: '__mcp_probe__',
          agentDataDir: probeDir,
          workingDir: os.homedir(),
          agentMode: 'Agent',
          skipMCPInit: true,
          logLevel: 'error',
        } as any);

        for (const cfg of mcpDefs) {
          try {
            await Promise.race([
              core.addOrUpdateMCPServer(cfg as Parameters<typeof core.addOrUpdateMCPServer>[0], 'project'),
              new Promise<never>((_, reject) => setTimeout(() => reject(new Error('timeout')), 180_000)),
            ]);
          } catch (e) {
            console.warn(`[AgentPool:probe] MCP warmup failed for ${cfg.name}: ${e}`);
          }
        }
        this.probeCore = core;
      } catch (e) {
        console.warn(`[AgentPool:probe] probe core init failed: ${e}`);
        this.mcpWarmupStarted = false; // allow retry
      }
    })();
  }

  /** 返回所有 marketplace MCP 服务器的连接状态及工具列表（取第一个活跃 engine 的状态）。
   *  Key 为完整命名空间名称（mkt__pluginName__serverName），无活跃 agent 时返回空对象。 */
  getMarketplaceMCPStatus(): Record<string, { status: string; error?: string; tools?: { name: string; description?: string }[] }> {
    const core = (this.cores.values().next().value ?? this.probeCore) as (typeof this.cores extends Map<string, infer V> ? V : never) | undefined;
    if (!core) return {};
    const result: Record<string, { status: string; error?: string; tools?: { name: string; description?: string }[] }> = {};
    for (const infos of core.getMCPServerConfigs().values()) {
      for (const info of infos) {
        if (info.config.name.startsWith('mkt__')) {
          result[info.config.name] = {
            status: info.status,
            error: info.error,
            tools: info.capabilities?.tools?.map(t => ({ name: t.name, description: t.description })),
          };
        }
      }
    }
    return result;
  }

  /** 虚拟 agent 继承主 agent 的权限配置 */
  getSkipPermsForVirtual(): boolean {
    if (this.skipAllAgentsPermissions) return true;
    if (this.skipMainAgentPermissions) return true;
    return false;
  }

  /** 暴露 PermissionBridge 供 VirtualWorkerPool 绑定虚拟 agent 权限请求 */
  getPermissionBridge(): PermissionBridge {
    return this.permissionBridge;
  }

  /**
   * 更新权限开关（Web UI 调用）。
   * 立即热更新所有受影响的运行中 agent，无需销毁重建。
   */
  async setPermissionsConfig(opts: { skipMainAgentPermissions: boolean; skipAllAgentsPermissions: boolean }): Promise<void> {
    this.skipMainAgentPermissions = opts.skipMainAgentPermissions;
    this.skipAllAgentsPermissions = opts.skipAllAgentsPermissions;

    let updated = 0;
    for (const [jid, binding] of this.bindings) {
      const core = this.cores.get(jid);
      if (!core) continue;
      const skip = this.resolveSkipPerms(binding);
      core.updateSkipPermissions(skip);
      updated++;
    }
    console.log(`[AgentPool] Permissions updated (skipMain=${opts.skipMainAgentPermissions}, skipAll=${opts.skipAllAgentsPermissions}), hot-updated ${updated} agent(s)`);
  }

  /**
   * 更新 Thinking 开关（Web UI 调用）。
   * 立即热更新所有运行中 agent，无需销毁重建。
   */
  setThinkingEnabled(enabled: boolean): void {
    this.thinkingEnabled = enabled;
    let updated = 0;
    for (const core of this.cores.values()) {
      core.updateThinking(enabled);
      updated++;
    }
    console.log(`[AgentPool] Thinking mode ${enabled ? 'enabled' : 'disabled'}, hot-updated ${updated} agent(s)`);
  }

  getThinkingEnabled(): boolean {
    return this.thinkingEnabled;
  }

  /** 根据当前开关状态和 binding 计算该 agent 是否跳过权限 */
  private resolveSkipPerms(binding: GroupBinding): boolean {
    if (this.skipAllAgentsPermissions) return true;
    // dispatch agent 是主 agent 的子任务，继承主 agent 的权限设置
    const isDispatchAgent = this.dispatchWorkspaceOverrides.has(binding.jid);
    if ((binding.isAdmin || isDispatchAgent) && this.skipMainAgentPermissions) return true;
    return false;
  }

  setGroupQueue(queue: GroupQueue): void {
    this.groupQueue = queue;
  }

  setDispatchBridge(bridge: DispatchBridge): void {
    this.dispatchBridge = bridge;
    // 子任务完成/出错时，按 adminFolder 找到 admin agent jid，重置其超时计时器
    bridge.setAdminActivityCallback((adminFolder: string) => {
      for (const [jid, binding] of this.bindings) {
        if (binding.folder === adminFolder) {
          this.notifyActivity(jid);
          break;
        }
      }
    });
  }

  /**
   * dispatch task 开始时，临时将子 agent 切换到 admin 的工作目录。
   * workspaceDir 为空字符串时不切换（子 agent 保持自身目录）。
   *
   * 注意：若子 agent 尚未创建（第一次 dispatch），仅存储 override，
   * getOrCreate() 会在 agent 创建后自动应用。
   */
  setDispatchWorkspace(jid: string, workspaceDir: string): void {
    if (!workspaceDir) return;
    // 始终先存储，即使 agent 尚未创建（getOrCreate 会在创建后应用）
    this.dispatchWorkspaceOverrides.set(jid, workspaceDir);
    const core = this.cores.get(jid);
    if (!core) return;
    core.setWorkingDir(workspaceDir);
    // 已存在的 dispatch agent 也要同步权限状态
    const binding = this.bindings.get(jid);
    if (binding) core.updateSkipPermissions(this.resolveSkipPerms(binding));
    console.log(`[AgentPool] Dispatch workspace set for ${jid}: ${workspaceDir}`);
  }

  /**
   * dispatch task 全部完成后，恢复子 agent 自身的工作目录（来自 workspace state 文件）。
   */
  /** 标记 agent 开始实际执行 dispatch task（由 queue 回调调用，非入队时） */
  markDispatchExecuting(jid: string): void {
    this.dispatchExecuting.add(jid);
  }

  /** 清除 dispatch 实际执行标记 */
  clearDispatchExecuting(jid: string): void {
    this.dispatchExecuting.delete(jid);
  }

  /** 记录当前 agent 正在执行的 dispatch taskId（由 DispatchBridge sendToAgent 回调注入） */
  setCurrentDispatchTaskId(jid: string, taskId: string): void {
    this.dispatchTaskMap.set(jid, taskId);
  }

  /**
   * Fallback：dispatch task 的 processAndWait 完成后调用。
   * 如果 idle 事件中的 notifyTaskDone 因时序问题未触发，
   * 在此处补发通知，确保 dispatch 状态文件被正确更新。
   * @param expectedTaskId 由 sendToAgent 闭包捕获的 taskId，防止竞态时消费下一个任务的回复
   */
  notifyDispatchIfPending(jid: string, expectedTaskId?: string): void {
    const content = this.lastDispatchReplies.get(jid);
    if (!content) return; // idle 事件已处理，无需 fallback
    const currentTaskId = this.dispatchTaskMap.get(jid);
    // 如果 dispatchTaskMap 已被下一个任务覆盖（currentTaskId !== expectedTaskId），
    // 说明 idle 事件已处理了当前任务，且新任务已启动——跳过，避免错误消费新任务的回复
    if (expectedTaskId && currentTaskId && currentTaskId !== expectedTaskId) return;
    const taskId = expectedTaskId ?? currentTaskId;
    if (taskId) {
      this.dispatchBridge?.notifyTaskDone(taskId, content);
      if (this.dispatchTaskMap.get(jid) === taskId) {
        this.dispatchTaskMap.delete(jid);
      }
    } else {
      // taskId 未知，尝试兼容桥接
      this.dispatchBridge?.notifyReply(jid, content);
    }
    this.lastDispatchReplies.delete(jid);
  }

  revertDispatchWorkspace(jid: string): void {
    if (!this.dispatchWorkspaceOverrides.has(jid)) return;
    this.dispatchWorkspaceOverrides.delete(jid);
    const binding = this.bindings.get(jid);
    const core = this.cores.get(jid);
    if (!core || !binding) return;
    // 恢复子 agent 自身的权限设置（非 admin 默认不跳过）
    if (!binding.isAdmin) {
      core.updateSkipPermissions(false);
    }
    const stateFile = workspaceStateFile(binding.folder);
    try {
      const raw = fs.readFileSync(stateFile, 'utf-8');
      const { currentDir } = JSON.parse(raw) as { currentDir: string };
      if (currentDir) {
        core.setWorkingDir(currentDir);
        console.log(`[AgentPool] Dispatch workspace reverted for ${jid}: ${currentDir}`);
      }
    } catch {
      core.clearWorkingDir();
    }
  }

  /** WsGateway 启动后注入，bindEvents 中转发 Agent 事件到 WS 客户端 */
  setAgentEventSink(sink: AgentEventSink): void {
    this.agentEventSink = sink;
    // 同时将 PermissionBridge 的通知回调接入 sink
    this.permissionBridge.onPermissionRequest((chatJid, requestId, payload) => {
      sink.notifyPermissionRequest?.(chatJid, requestId, payload);
    });
    this.permissionBridge.onAskQuestionRequest((chatJid, requestId, payload) => {
      sink.notifyAskQuestionRequest?.(chatJid, requestId, payload);
    });
    this.permissionBridge.onPermissionResolved((chatJid, requestId, optionKey, optionLabel) => {
      sink.notifyPermissionResolved?.(chatJid, requestId, optionKey, optionLabel);
    });
    this.permissionBridge.onAskQuestionResolved((chatJid, requestId, answers) => {
      sink.notifyAskQuestionResolved?.(chatJid, requestId, answers);
    });
  }

  /** 获取所有缓存的 agent todos 快照（供 WsGateway subscribe 时初始推送） */
  getAllCachedTodos(): Map<string, { agentName: string; todos: { content: string; status: string; activeForm?: string }[] }> {
    return this.cachedTodos;
  }

  /** Web UI 侧权限决策（由 WsGateway 调用，"先响应生效"） */
  resolvePermission(requestId: string, optionKey: string): boolean {
    return this.permissionBridge.resolvePermission(requestId, optionKey);
  }

  /** Web UI 侧批量回答问答（answers: {[qi]: oi | oi[]}, otherTexts: {[qi]: text}） */
  resolveAskQuestionBatch(requestId: string, answers: Record<number, number | number[]>, otherTexts?: Record<number, string>): boolean {
    return this.permissionBridge.resolveAskQuestionBatch(requestId, answers, otherTexts);
  }

  /**
   * 统一出口：同时发送到 Channel（Telegram）和 WsGateway（Web UI）。
   * 所有定时任务的直发消息、isolated agent 回复均走此方法。
   */
  async broadcastReply(jid: string, text: string, botToken?: string): Promise<void> {
    // Web-only agents have no channel binding; reply goes via WsGateway only
    if (!jid.startsWith('web:')) {
      try {
        await this.sendReply(jid, text, botToken);
      } catch (err) {
        console.error(`[AgentPool] sendReply failed for ${jid}:`, err);
      }
    }
    this.agentEventSink?.notifyAgentReply(jid, text);
    // Dispatch completion is signalled via state:update→idle in bindEvents,
    // NOT here — a session may emit multiple messages before going idle.
  }

  /** 由 PermissionBridge 在权限消息发出 / 回调收到时调用 */
  private notifyActivity(jid: string): void {
    this.activeTimerResets.get(jid)?.();
  }

  /**
   * 获取或创建指定群组的 SemaCore。
   * 首次创建时初始化 session 并绑定事件。
   */
  async getOrCreate(bindingInput: GroupBinding): Promise<SemaCore> {
    if (this.cores.has(bindingInput.jid)) return this.cores.get(bindingInput.jid)!;
    // 并发锁：如果同一 jid 正在创建中，等待已有的 Promise 而非重复创建
    const pending = this.pendingCreates.get(bindingInput.jid);
    if (pending) return pending;
    const promise = this.getOrCreateInternal(bindingInput);
    this.pendingCreates.set(bindingInput.jid, promise);
    try {
      return await promise;
    } finally {
      this.pendingCreates.delete(bindingInput.jid);
    }
  }

  private async getOrCreateInternal(bindingInput: GroupBinding): Promise<SemaCore> {
    // 双重检查：可能在等待锁期间已被其他路径创建
    if (this.cores.has(bindingInput.jid)) return this.cores.get(bindingInput.jid)!;
    let binding = bindingInput;

    // agentDataDir: ~/semaclaw/agents/{folder}/ — SOUL.md, memory/, .sema/
    const agentDataDir = path.resolve(config.paths.agentsDir, binding.folder);
    // workingDir: ~/semaclaw/workspace/{folder}/ — 默认工作目录（项目文档）
    const workingDir = path.resolve(config.paths.workspaceDir, binding.folder);

    // 从 ~/.semaclaw/config.json 同步 allowedWorkDirs（config.json 优先于 DB）
    const configAllowedWorkDirs = getAgentAllowedWorkDirs(binding.folder);
    if (configAllowedWorkDirs !== undefined && configAllowedWorkDirs !== binding.allowedWorkDirs) {
      binding = { ...binding, allowedWorkDirs: configAllowedWorkDirs };
    }

    const skipPerms = this.resolveSkipPerms(binding);
    // Skills 额外搜索目录（低→高优先级，追加在 sema-core 内置目录之后）
    // bundled < global-compat < managed(clawhub) < marketplace < workspace
    // 每个来源目录展开为单个 skill 子目录，过滤掉 disabled skills
    const _disabled = readDisabledSkills();
    const skillsExtraDirs = [
      ...(config.paths.bundledSkillsDir
        ? expandSkillsDir(config.paths.bundledSkillsDir, 'managed', _disabled)
        : []),
      ...expandSkillsDir(path.join(os.homedir(), '.claude', 'skills'), 'user', _disabled),
      ...expandSkillsDir(config.paths.managedSkillsDir, 'managed', _disabled),
      ...(this.marketplaceManager?.getSkillExtraDirs(_disabled) ?? []),
      ...expandSkillsDir(path.join(workingDir, 'skills'), 'workspace', _disabled),
    ];

    const memSnap = (label: string) => {
      const m = process.memoryUsage();
      console.log(`[AgentPool:MEM] ${label}: rss=${(m.rss/1024/1024).toFixed(0)}MB heap=${(m.heapUsed/1024/1024).toFixed(0)}MB`);
    };

    // 清除旧的 MCP 配置文件，避免 SemaCore 构造函数中 MCPManager.init()
    // 与下面的 addOrUpdateMCPServer 并发竞争导致重复连接/子进程泄漏。
    // AgentPool 会在下方显式添加所有需要的 MCP 服务器。
    const mcpJsonPath = path.join(agentDataDir, '.sema', 'mcp.json');
    try {
      fs.mkdirSync(path.dirname(mcpJsonPath), { recursive: true });
      fs.writeFileSync(mcpJsonPath, JSON.stringify({ mcpServers: {} }, null, 2), 'utf8');
    } catch (e) {
      console.warn(`[AgentPool] Failed to clear stale MCP config: ${e}`);
    }

    // Task tool 由 semaclaw DispatchBridge 层统一管理，禁用 sema-core 内置 sub-agent
    const EXCLUDED_TOOLS = ['Task']
    const ALL_POOLED_TOOLS = [
      'Bash', 'Glob', 'Grep', 'Read', 'Write', 'Edit',
      'TodoWrite', 'Skill', 'NotebookEdit', 'AskUser',
    ]
    const useTools = binding.allowedTools
      ? binding.allowedTools.filter(t => !EXCLUDED_TOOLS.includes(t))
      : ALL_POOLED_TOOLS

    // 加载 hook 配置（全局 ~/.semaclaw/ + workspace + 插件市场）
    const globalConfigDir = path.dirname(config.paths.globalConfigPath);
    const marketplaceHookFiles = this.marketplaceManager?.getHookFiles() ?? [];
    const { hookConfig, hookEnv } = loadAndResolveHookConfig(globalConfigDir, workingDir, marketplaceHookFiles);

    memSnap('before new SemaCore');
    const core = new SemaCore({
      instanceId: binding.folder,
      agentDataDir,
      workingDir,
      agentMode: 'Agent',
      useTools,
      logLevel: 'warn',
      skillsExtraDirs,
      skipFileEditPermission: skipPerms,
      skipBashExecPermission: skipPerms,
      skipSkillPermission: skipPerms,
      skipMCPToolPermission: true,
      skipMCPInit: true, // AgentPool 清空 mcp.json 后手动 addOrUpdateMCPServer，跳过 init 避免全局 MCP 并发卡死
      ...(hookConfig ? { hooks: hookConfig, hookEnv } : {}),
    } as any);
    memSnap('after new SemaCore');

    const cleanupPermission = this.permissionBridge.bindCore(core, binding);
    this.bindEvents(core, binding, cleanupPermission);

    try {
    /** 带超时的 addOrUpdateMCPServer，失败时仅打印 warning 不中断启动。内置服务默认 30s，marketplace/用户 MCP 传 180s */
    const addMCP = async (cfg: Parameters<typeof core.addOrUpdateMCPServer>[0], label: string, timeoutMs = 30_000) => {
      try {
        await Promise.race([
          core.addOrUpdateMCPServer(cfg, 'project'),
          new Promise<never>((_, reject) =>
            setTimeout(() => reject(new Error(`${label} MCP connect timeout (${timeoutMs / 1000}s)`)), timeoutMs)
          ),
        ]);
      } catch (e) {
        console.warn(`[AgentPool] ${label} MCP unavailable for ${binding.folder}: ${e}`);
      }
    };

    memSnap('before MCP servers');
    // 注入 ScheduleTool MCP 服务器（所有群组都有）
    await addMCP(
      scheduleMCPConfig({
        dbPath: config.paths.dbPath,
        groupFolder: binding.folder,
        chatJid: binding.jid,
      }),
      'ScheduleTool'
    );

    // 注入 WorkspaceTool MCP 服务器（所有群组）
    const stateFile = workspaceStateFile(binding.folder);
    this.initWorkspaceState(stateFile, workingDir);
    const workspaceMCPAdded = await (async () => {
      try {
        await Promise.race([
          core.addOrUpdateMCPServer(
            workspaceMCPConfig({
              stateFile,
              defaultWorkspace: workingDir,
              allowedWorkDirs: binding.allowedWorkDirs,
            }),
            'project'
          ),
          new Promise<never>((_, reject) =>
            setTimeout(() => reject(new Error('WorkspaceTool MCP connect timeout (10s)')), 10_000)
          ),
        ]);
        return true;
      } catch (e) {
        console.warn(`[AgentPool] WorkspaceTool MCP unavailable for ${binding.folder}, workspace switching disabled: ${e}`);
        return false;
      }
    })();
    // 只有 MCP 服务器成功连接时才启动文件监听
    if (workspaceMCPAdded) {
      this.setupWorkspaceWatcher(binding.jid, binding.folder, stateFile, core);
    }

    // 主频道额外注入 DispatchTool MCP 服务器（虚拟 agent 统一走 DAG dispatch，不注入 run_persona）
    if (binding.isAdmin) {
      await addMCP(
        dispatchMCPConfig({ statePath: config.paths.dispatchStatePath, adminFolder: binding.folder, agentsConfigDir: config.paths.virtualAgentsDir }),
        'DispatchTool'
      );
    }

    memSnap('after admin/dispatch MCP');
    // 注入 MemoryTool MCP 服务器（所有群组）— v2: memory_search + memory_get
    await addMCP(memoryMCPConfig({
      dbPath: config.paths.dbPath,
      folder: binding.folder,
      agentsDir: config.paths.agentsDir,
      embeddingProvider: config.memory.embeddingProvider,
      openaiApiKey: config.memory.openaiApiKey || undefined,
      openaiBaseUrl: config.memory.openaiBaseUrl || undefined,
    }), 'MemoryTool');

    // 飞书渠道额外注入 FeishuWiki MCP 服务器
    if (binding.channel === 'feishu') {
      const feishuCreds = this.resolveFeishuCredentials(binding.botToken ?? undefined);
      if (feishuCreds) {
        await addMCP(feishuWikiMCPConfig(feishuCreds), 'FeishuWiki');
      }
    }

    // 注入 Marketplace 插件 MCP 服务器（首次可能需要下载依赖，给 180s）
    for (const cfg of this.marketplaceManager?.getMCPServerDefs() ?? []) {
      await addMCP(cfg as Parameters<typeof core.addOrUpdateMCPServer>[0], `Marketplace[${cfg.name}]`, 180_000);
    }

    // 注入用户全局 MCP 配置（~/.semaclaw/mcp.json，同样给 180s）
    const userMCPPath = path.join(os.homedir(), '.semaclaw', 'mcp.json');
    if (fs.existsSync(userMCPPath)) {
      try {
        const userMCPData = JSON.parse(fs.readFileSync(userMCPPath, 'utf-8')) as { mcpServers?: Record<string, unknown> };
        for (const [name, cfg] of Object.entries(userMCPData.mcpServers ?? {})) {
          if ((cfg as Record<string, unknown>).enabled !== false) {
            await addMCP({ ...(cfg as Parameters<typeof core.addOrUpdateMCPServer>[0]), name }, `User[${name}]`, 180_000);
            this.userMCPServerNames.add(name);
          }
        }
      } catch (e) {
        console.warn(`[AgentPool] Failed to load user MCP config: ${e}`);
      }
    }

    memSnap('after memory MCP');
    // 初始化 MemoryManager 索引（首次全量扫描 + 文件监听）
    console.log(`[AgentPool] MemoryManager.initAgent starting for ${binding.folder}...`);
    const memInterval0 = setInterval(() => memSnap('initAgent in progress...'), 3000);
    try {
      const mm = MemoryManager.getInstance();
      console.log(`[AgentPool] MemoryManager instance obtained`);
      await mm.initAgent(binding.folder);
      console.log(`[AgentPool] MemoryManager.initAgent done for ${binding.folder}`);
    } catch (e) {
      console.warn(`[AgentPool] MemoryManager init failed for ${binding.folder}:`, e);
    } finally {
      clearInterval(memInterval0);
    }

    memSnap('before createSession');
    // createSession 带 60s 超时保护，避免无限卡住阻塞 GroupQueue
    const memInterval = setInterval(() => memSnap('createSession in progress...'), 3000);
    try {
      await Promise.race([
        core.createSession(),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error(`createSession timeout (60s) for ${binding.folder}`)), 60_000)
        ),
      ]);
    } finally {
      clearInterval(memInterval);
    }
    memSnap('after createSession');
    // initializePlugins 不经过 expandSkillsDir 过滤，~/.sema/skills 里的 disabled skills
    // 会被 baseDir 扫描加载进来。这里做一次 post-filter，确保 disabled 状态在启动时也生效。
    core.reloadSkills(readDisabledSkills());
    this.cores.set(binding.jid, core);
    this.bindings.set(binding.jid, binding);

    // 应用 dispatch 开始时已存储但尚未应用的 workspace（因 agent 当时尚未创建）
    const pendingWorkspace = this.dispatchWorkspaceOverrides.get(binding.jid);
    if (pendingWorkspace) {
      core.setWorkingDir(pendingWorkspace);
      console.log(`[AgentPool] Applied pending dispatch workspace for ${binding.jid}: ${pendingWorkspace}`);
    }

    // 应用 Thinking 开关（直接 mutate initialConfig，保证 AsyncLocalStorage 上下文内生效）
    core.updateThinking(this.thinkingEnabled);

    console.log(`[AgentPool] Created agent for ${binding.jid} (folder: ${binding.folder}, skipPerms: ${skipPerms}, thinking: ${this.thinkingEnabled})`);
    return core;
    } catch (e) {
      // 创建失败时清理已注册的事件监听器和 PermissionBridge 绑定
      const cleanupEvents = this.eventCleanups.get(binding.jid);
      if (cleanupEvents) {
        cleanupEvents();
        this.eventCleanups.delete(binding.jid);
      }
      try { core.clearWorkingDir(); await core.dispose(); } catch { /* ignore */ }
      console.error(`[AgentPool] Failed to create agent for ${binding.jid}:`, e);
      throw e;
    }
  }

  /**
   * 调用 processUserInput 并等待 Agent 回到 idle 状态。
   * 超时后抛出错误并从 pool 移除该 Agent（下次会重新创建）。
   */
  async processAndWait(
    jid: string,
    binding: GroupBinding,
    prompt: string,
    retriesLeft = 5,
    attachments?: MessageAttachment[],
  ): Promise<void> {
    const core = await this.getOrCreate(binding);

    const memSnap2 = (label: string) => {
      const m = process.memoryUsage();
      console.log(`[AgentPool:MEM] processAndWait ${label}: rss=${(m.rss/1024/1024).toFixed(0)}MB heap=${(m.heapUsed/1024/1024).toFixed(0)}MB`);
    };
    memSnap2('start');

    // Auto memory pre-retrieval：搜索相关记忆并注入到 prompt
    // 默认关闭（SEMACLAW_PRE_RETRIEVAL=true 启用），Agent 可通过 memory_search MCP 工具主动检索
    let fullPrompt = prompt;
    if (config.memory.preRetrieval) {
      try {
        const mm = MemoryManager.getInstance();
        const results = await mm.search(binding.folder, prompt, {
          maxResults: config.memory.searchMaxResults,
          minScore: config.memory.searchMinScore,
        });
        // minScore 在 FTS-only 路径不生效，在此统一过滤后取 top-5
        // 同时排除当天日志文件（实时写入，内容未稳定，会污染搜索结果）
        const todayFile = new Date().toISOString().slice(0, 10) + '.md'; // e.g. "2026-03-20.md"
        const filtered = results
          .filter(r => r.score >= config.memory.searchMinScore)
          .filter(r => !r.path.endsWith(todayFile))
          .slice(0, config.memory.searchMaxResults);
        const memContext = formatSearchResults(filtered);
        if (memContext) {
          fullPrompt = `<memory>\n${memContext}\n</memory>\n\n${prompt}`;
        }
      } catch (e) {
        console.warn(`[AgentPool] Memory pre-retrieval failed for ${binding.jid}:`, e);
      }
    }

    return new Promise<void>((resolve, reject) => {
      let timer: ReturnType<typeof setTimeout>;

      // 每次有活动（非 idle 状态变化）重置计时器，
      // 只有 AGENT_TIMEOUT_MS 内完全无活动才触发超时。
      // 这样多次权限授权的等待时间不会累积导致超时。
      const resetTimer = (): void => {
        clearTimeout(timer);
        timer = setTimeout(() => {
          this.activeTimerResets.delete(jid);
          core.off('state:update', onStateUpdate);
          core.off('session:error', onSessionError);
          // 销毁超时的 Agent，下次重建
          this.destroy(jid).catch(() => {});
          // 无条件通知 DispatchBridge（notifyError 内部通过 activeAgentTasks 过滤非 dispatch 调用）
          this.dispatchBridge?.notifyError(jid, 'Agent timeout');
          reject(new Error(`[AgentPool] Agent timeout for ${jid}`));
        }, AGENT_TIMEOUT_MS);
      };

      // 暴露给 PermissionBridge：权限消息发出或回调收到时可重置计时器
      this.activeTimerResets.set(jid, resetTimer);

      const cleanup = () => {
        clearTimeout(timer);
        this.activeTimerResets.delete(jid);
        this.activeAborts.delete(jid);
        core.off('state:update', onStateUpdate);
        core.off('session:error', onSessionError);
      };

      // 注册中止回调：destroy() 调用时打断挂起的 Promise，避免 GroupQueue 死锁
      this.activeAborts.set(jid, (reason: string) => {
        cleanup();
        reject(new Error(reason));
      });

      const onStateUpdate = (data: StateUpdateData) => {
        if (data.state === 'idle') {
          cleanup();
          resolve();
        } else if (data.state === 'paused') {
          // 用户主动暂停：挂起计时器，Promise 保持等待（等 resume 后的 idle 再 resolve）
          clearTimeout(timer);
        } else {
          // processing 等活跃状态 → 重置超时计时器
          resetTimer();
        }
      };

      const onSessionError = (data: SessionErrorData) => {
        cleanup();
        // Transient API errors — retry without destroying the agent
        // so session history and prompt cache are preserved
        const TRANSIENT_PATTERNS = ['terminated', 'Unexpected event order', 'API_RESPONSE_ERROR', 'API响应格式错误', 'Premature close', 'missing finish_reason'];
        const isTransient = TRANSIENT_PATTERNS.some(p => data.error.message.includes(p));
        // Network errors — preserve session context (history + tool results) so the agent can
        // resume from where it left off. Do NOT destroy: just interrupt back to idle.
        const isNetworkError = data.error.code === 'NETWORK_ERROR';
        if (isTransient && retriesLeft > 0) {
          console.warn(`[AgentPool] Transient error for ${jid}: "${data.error.message}", retrying in 3s (${retriesLeft} left)`);
          // 暂时移除 dispatchExecuting 标记，防止 bindEvents 的持久 state:update 监听
          // 在 retry 等待期间看到 idle 状态后误调 notifyReply 将任务提前标记为 done
          const wasDispatching = this.dispatchExecuting.has(jid);
          if (wasDispatching) this.dispatchExecuting.delete(jid);
          setTimeout(() => {
            if (wasDispatching) this.dispatchExecuting.add(jid);
            this.processAndWait(jid, binding, prompt, retriesLeft - 1).then(resolve, reject);
          }, 3000);
        } else if (isNetworkError) {
          // Soft interrupt: keep SemaCore alive so session history (including tool results)
          // is preserved for the next user message / resume.
          console.warn(`[AgentPool] Network error for ${jid}: "${data.error.message}", preserving session context`);
          core.interruptSession();
          this.dispatchExecuting.delete(jid);
          this.agentEventSink?.notifyAgentState(jid, 'idle');
          this.dispatchBridge?.notifyError(jid, `[${data.error.code}] ${data.error.message}`);
          this.broadcastReply(jid, `⚠️ Network error: ${data.error.message}\nContext preserved — you can continue from where I left off.`, binding.botToken ?? undefined);
          reject(new Error(`[AgentPool] Session error for ${jid}: [${data.error.code}] ${data.error.message}`));
        } else {
          this.destroy(jid).catch(() => {});
          // 无条件通知 DispatchBridge（notifyError 内部通过 activeAgentTasks 过滤非 dispatch 调用）
          this.dispatchBridge?.notifyError(jid, `[${data.error.code}] ${data.error.message}`);
          this.broadcastReply(jid, `❌ Session error [${data.error.code}]: ${data.error.message}\nSession has been reset.`, binding.botToken ?? undefined);
          reject(new Error(`[AgentPool] Session error for ${jid}: [${data.error.code}] ${data.error.message}`));
        }
      };

      // 必须在 processUserInput 之前注册监听，避免错过事件
      core.on<StateUpdateData>('state:update', onStateUpdate);
      core.on<SessionErrorData>('session:error', onSessionError);
      resetTimer(); // 启动初始计时器

      // 记录用户 query 到每日日志（用原始 prompt，不含 memory 注入）
      this.dailyLogger.append(binding.folder, 'User', prompt);

      // 多模态：buildAgentInput 既扫文本内的图片地址，也合并显式 attachments
      const explicitImages: ImageAttachment[] = (attachments ?? [])
        .filter((a) => a.type === 'image')
        .map((a) => ({ url: a.url, mimeType: a.mimeType }));
      buildAgentInput(fullPrompt, explicitImages)
        .then((built) => {
          if (built.failures.length > 0) {
            console.warn(`[AgentPool] Image load failures for ${jid}:`, built.failures);
          }
          core.processUserInput(built.input);
        })
        .catch((err) => {
          console.error(`[AgentPool] buildAgentInput failed for ${jid}:`, err);
          // 兜底：回退到纯文本，避免一次图片处理失败阻断整个对话
          core.processUserInput(fullPrompt);
        });
    });
  }

  /**
   * 创建临时 SemaCore（不加入 pool），执行 prompt，完成后销毁。
   * 适用于 context_mode='isolated' 和 'script-agent' 的定时任务。
   * 响应通过 broadcastReply 同时发到 Telegram 和 Web UI。
   *
   * @param task      定时任务（用于 instanceId 和 ScheduleTool 注入）
   * @param group     群组绑定（workingDir / allowedTools / botToken 等）
   * @param prompt    执行的 prompt，不传时使用 task.prompt
   */
  async runIsolated(task: ScheduledTask, group: GroupBinding, prompt?: string): Promise<void> {
    const agentDataDir = path.resolve(config.paths.agentsDir, group.folder);
    const workingDir = path.resolve(config.paths.workspaceDir, group.folder);
    const effectivePrompt = prompt ?? task.prompt;

    const _disabled = readDisabledSkills();
    const skillsExtraDirs = [
      ...(config.paths.bundledSkillsDir
        ? expandSkillsDir(config.paths.bundledSkillsDir, 'managed', _disabled)
        : []),
      ...expandSkillsDir(path.join(os.homedir(), '.claude', 'skills'), 'user', _disabled),
      ...expandSkillsDir(config.paths.managedSkillsDir, 'managed', _disabled),
      ...expandSkillsDir(path.join(workingDir, 'skills'), 'workspace', _disabled),
    ];

    const core = new SemaCore({
      instanceId: `isolated-${task.id}`,
      agentDataDir,
      workingDir,
      agentMode: 'Agent',
      useTools: group.allowedTools ?? null,
      logLevel: 'warn',
      skillsExtraDirs,
      skipFileEditPermission: true,
      skipBashExecPermission: true,
      skipSkillPermission: true,
      skipMCPToolPermission: true,
    });

    await core.addOrUpdateMCPServer(
      scheduleMCPConfig({
        dbPath: config.paths.dbPath,
        groupFolder: group.folder,
        chatJid: group.jid,
      }),
      'project'
    );

    await core.createSession(`task-${task.id}`);

    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        cleanup();
        reject(new Error(`[AgentPool] Isolated task ${task.id} timed out`));
      }, AGENT_TIMEOUT_MS);

      const cleanup = () => {
        clearTimeout(timer);
        core.off('state:update', onStateUpdate);
        core.off('message:complete', onMessageComplete);
        (core as any).dispose?.().catch(() => {});
      };

      const onMessageComplete = (data: MessageCompleteData) => {
        if (data.agentId !== MAIN_AGENT_ID || !data.content.trim()) return;
        this.broadcastReply(group.jid, data.content, group.botToken ?? undefined);
      };

      const onStateUpdate = (data: StateUpdateData) => {
        this.agentEventSink?.notifyAgentState(group.jid, data.state);
        if (data.state === 'idle') {
          cleanup();
          resolve();
        }
      };

      core.on<MessageCompleteData>('message:complete', onMessageComplete);
      core.on<StateUpdateData>('state:update', onStateUpdate);
      core.processUserInput(effectivePrompt);
    });
  }

  // ===== 交互控制：暂停 / 继续 / 终止 =====

  /**
   * 暂停指定群组的 Agent。
   *
   * 三种场景，按优先级判断：
   * A. core 有活跃 processAndWait（activeAborts 有记录）：
   *    调 core.pauseSession() → sema-core 在下一个 tool boundary 暂停，
   *    自动发出 state:update:paused 事件 → 前端收到真实 paused 状态。
   *
   * B. core idle 但 dispatch 有活跃任务（主 agent 在等待子任务结果）：
   *    不需要 pauseSession()（sema-core 本身已 idle）。
   *    → 记入 dispatchPausedJids，手动推送 paused 给前端；
   *      resume 时同样不调 processUserInput，只恢复 dispatch 调度。
   *
   * C. core idle 且无活跃 dispatch（agent 完全空闲）：
   *    → 记入 synthPausedJids，手动推送 paused 给前端（纯 UI 状态）。
   *
   * 三种情况都会：阻止 DispatchBridge 启动新子任务，并 pause 当前在跑的子 agent。
   */
  pauseAgent(jid: string): void {
    const core = this.cores.get(jid);
    if (!core) {
      console.warn(`[AgentPool] pauseAgent: no active agent for ${jid}`);
      return;
    }

    const hasActivePAW = this.activeAborts.has(jid);
    const adminFolder = this.bindings.get(jid)?.folder;
    const hasActiveDispatch = adminFolder && this.dispatchBridge
      ? this.dispatchBridge.hasActiveDispatch(adminFolder)
      : false;

    let pauseMode: 'core-pause' | 'dispatch-pause' | 'synth-pause';
    if (hasActivePAW) {
      // 场景 A：sema-core 会自动发 state:update:paused
      core.pauseSession();
      pauseMode = 'core-pause';
    } else if (hasActiveDispatch) {
      // 场景 B：dispatch 有活跃任务，主 agent 在两次 PAW 之间等待子任务结果
      this.dispatchPausedJids.add(jid);
      this.agentEventSink?.notifyAgentState(jid, 'paused');
      pauseMode = 'dispatch-pause';
    } else {
      // 场景 C：agent 完全空闲，纯 UI 状态暂停
      this.synthPausedJids.add(jid);
      this.agentEventSink?.notifyAgentState(jid, 'paused');
      pauseMode = 'synth-pause';
    }

    // 若此 agent 是 dispatch admin，阻止新子任务启动，并 pause 当前在跑的子 agent
    if (adminFolder && this.dispatchBridge) {
      const childJids = this.dispatchBridge.pauseAdmin(adminFolder);
      const actuallyPaused: string[] = [];
      for (const childJid of childJids) {
        const childCore = this.cores.get(childJid);
        if (childCore) {
          // 子 agent 可能处于 processing 或 idle，pauseSession 对 idle 是 no-op
          // 但 dispatch 任务的下次 processAndWait 会被 DispatchBridge 的 pausedAdmins 拦截
          if (this.activeAborts.has(childJid)) {
            childCore.pauseSession();
            actuallyPaused.push(childJid);
          }
        }
      }
      if (actuallyPaused.length > 0) {
        this.pausedChildrenByAdmin.set(jid, actuallyPaused);
      }
    }

    console.log(`[AgentPool] Paused agent for ${jid} (${pauseMode})`);
  }

  /**
   * 恢复指定群组的 Agent。
   *
   * 三种场景（对应 pauseAgent 的三种情况）：
   * A. 正常暂停（core 在 processing 中被暂停）：
   *    调 processUserInput 继续执行，sema-core 自动发 state:update 事件。
   *
   * B. 调度暂停（dispatchPausedJids）/ C. 合成暂停（synthPausedJids）：
   *    core 本来是 idle，不注入 processUserInput（避免在干净 session 插入多余 user turn）。
   *    - 有追加指令：processUserInput(query)
   *    - 无追加指令且无竞态 PAW：推 idle 给前端
   *    - 无追加指令但 PAW 已在竞态中启动：不推任何状态，
   *      由 bindEvents 的 state:update 自然更新前端。
   */
  resumeAgent(jid: string, query?: string): void {
    const core = this.cores.get(jid);
    if (!core) {
      console.warn(`[AgentPool] resumeAgent: no active agent for ${jid}`);
      return;
    }

    const wasSynthPaused    = this.synthPausedJids.has(jid);
    const wasDispatchPaused = this.dispatchPausedJids.has(jid);
    const wasIdlePaused     = wasSynthPaused || wasDispatchPaused;
    const adminFolder = this.bindings.get(jid)?.folder;

    if (wasIdlePaused) {
      // 场景 B/C：core 本来是 idle，不注入 processUserInput
      this.synthPausedJids.delete(jid);
      this.dispatchPausedJids.delete(jid);
      if (query?.trim()) {
        if (core.hasSessionToolResults()) {
          // 已有 tool 调用历史（任务进行中）：基于内部历史注入新指令 + 辅助提示
          core.processUserInput(
            `${query.trim()}\n\nBased on the work completed so far and the latest instruction above, decide how to continue.`
          );
        } else {
          // 无 tool 调用历史（首条消息或全新 session）：从 DB 重建完整上下文
          // 避免 processUserInput 在空历史上运行导致丢失前序消息
          const binding = this.bindings.get(jid);
          if (binding) {
            const promptBuiltAt = new Date().toISOString();
            const { prompt: dbPrompt, lastMsgTimestamp } = buildPromptForGroup(jid);
            if (dbPrompt) {
              const cursor = lastMsgTimestamp && lastMsgTimestamp > promptBuiltAt
                ? lastMsgTimestamp : promptBuiltAt;
              this.processAndWait(jid, binding, dbPrompt)
                .catch(err => console.error(`[AgentPool] resumeAgent processAndWait error:`, err))
                .finally(() => setLastAgentTimestamp(jid, cursor));
            } else if (!this.activeAborts.has(jid)) {
              this.agentEventSink?.notifyAgentState(jid, 'idle');
            }
          }
        }
      } else if (!this.activeAborts.has(jid)) {
        // 只有确认无竞态 PAW 时才推 idle
        // （GroupQueue 可能在 pause→resume 期间 dequeue 并启动了新 PAW）
        this.agentEventSink?.notifyAgentState(jid, 'idle');
      }
      // 若 activeAborts 已有记录（竞态：PAW 在 pause→resume 之间启动），
      // bindEvents 的 state:update 会自然更新前端状态，无需手动推送。
    } else {
      // 场景 A：正常暂停（core 在 processing 中被暂停），继续 sema-core 执行
      // 如有 active dispatch parents，在 resume prompt 中注入提醒，防止 agent 因
      // checkpoint 1 的 cancel stop 误以为 dispatch 失败而重新分发。
      const basePrompt = query?.trim() || 'Go on.';
      const dispatchContext = adminFolder ? buildDispatchResumeHint(this.dispatchBridge, adminFolder) : null;
      // 若用户附带了新指令且 agent 已有 tool 工作历史，追加辅助提示
      const hint = query?.trim() && core.hasSessionToolResults()
        ? '\n\nBased on the work completed so far and the latest instruction above, decide how to continue.'
        : '';
      const promptWithHint = `${basePrompt}${hint}`;
      const prompt = dispatchContext ? `${promptWithHint}\n\n${dispatchContext}` : promptWithHint;
      core.processUserInput(prompt);
    }

    // 三种情况都恢复 dispatch 调度 + 被暂停的子 agent
    if (adminFolder && this.dispatchBridge) {
      this.dispatchBridge.resumeAdmin(adminFolder);
      const pausedChildren = this.pausedChildrenByAdmin.get(jid) ?? [];
      for (const childJid of pausedChildren) {
        const childCore = this.cores.get(childJid);
        if (childCore) {
          childCore.processUserInput('Go on.');
        }
      }
      this.pausedChildrenByAdmin.delete(jid);
    }

    const resumeMode = wasDispatchPaused ? 'dispatch-resume'
      : wasSynthPaused ? 'synth-resume'
      : `core-resume: "${query ?? 'Go on.'}"`;
    console.log(`[AgentPool] Resumed agent for ${jid} (${resumeMode})`);
  }

  /**
   * 终止指定群组的 Agent 会话，丢弃所有上下文，开始新 session。
   * 1. 通知 DispatchBridge（处理"自身是子 agent"的场景：将对应任务标记为 error）
   * 2. 取消自身作为 admin 的所有 dispatch parents，并 stop 正在执行的子 agent
   * 3. 清空 GroupQueue 中积压的待处理消息
   * 4. 打断挂起的 processAndWait Promise（避免 GroupQueue drain 死锁）
   * 5. 调用 createSession() — 内部自带 abort + clearAllState + 新 sessionId
   */
  async stopAgent(jid: string): Promise<void> {
    // 1. 若此 agent 正在执行某个 dispatch 子任务，将其标记为 error，
    //    避免该任务永久卡在 processing 状态（admin 的 dispatch_task MCP 会等到超时）。
    this.dispatchBridge?.notifyError(jid, 'Agent stopped by user');
    this.dispatchTaskMap.delete(jid);
    this.lastDispatchReplies.delete(jid);

    // 2. 若此 agent 是 admin，取消所有 active/queued parents，并 stop 被 dispatch 的子 agent。
    //    这样：(a) dispatch state 不残留孤立的 active parent 阻塞新 dispatch；
    //          (b) 子 agent 不会在 admin 重置后继续空跑。
    const adminFolder = this.bindings.get(jid)?.folder;
    const childJids = adminFolder
      ? (this.dispatchBridge?.cancelAdminParents(adminFolder) ?? [])
      : [];

    // 3. 清空积压队列，防止 stop 后继续处理旧消息
    this.groupQueue?.clearQueue(jid);

    // 4. 打断 processAndWait（若正在等待），GroupQueue catch error 后因队列已空不会继续
    const abort = this.activeAborts.get(jid);
    if (abort) {
      abort(`[AgentPool] Agent stopped by user: ${jid}`);
    }

    // 5. 重建 session（createSession 内部 abort + clearAllState + idle）
    const core = this.cores.get(jid);
    if (!core) {
      console.warn(`[AgentPool] stopAgent: no active agent for ${jid}`);
      // 仍需 stop 已识别的子 agent
      for (const childJid of childJids) {
        await this.stopAgent(childJid);
      }
      return;
    }
    try {
      await core.createSession();
      // createSession 内部 clearAllState() 后 updateState('idle') 因 idle===idle 不触发事件，
      // 手动通知前端重置到 idle，否则界面永远停留在 processing 状态。
      this.agentEventSink?.notifyAgentState(jid, 'idle');
      console.log(`[AgentPool] Stopped and reset agent for ${jid}`);
    } catch (e) {
      console.error(`[AgentPool] stopAgent createSession failed for ${jid}:`, e);
      this.agentEventSink?.notifyAgentState(jid, 'idle');
    }

    // 清理残留暂停状态
    this.synthPausedJids.delete(jid);
    this.dispatchPausedJids.delete(jid);
    this.pausedChildrenByAdmin.delete(jid);
    this.lastDispatchReplies.delete(jid);
    const binding = this.bindings.get(jid);
    if (this.cachedTodos.has(jid)) {
      this.cachedTodos.delete(jid);
      this.agentEventSink?.notifyAgentTodos?.(jid, binding?.name ?? jid, []);
    }

    // stop 所有因此 admin 发起的 dispatch 子 agent（清队列 + abort + 重建 session）
    for (const childJid of childJids) {
      await this.stopAgent(childJid);
    }
  }

  /** 销毁指定群组的 Agent（注销群组时使用） */
  async destroy(jid: string): Promise<void> {
    // 打断挂起的 processAndWait Promise，避免 GroupQueue drain 死锁
    const abort = this.activeAborts.get(jid);
    if (abort) {
      abort(`[AgentPool] Agent destroyed while processing: ${jid}`);
    }

    // 停止 workspace 文件监听
    const stopWatcher = this.workspaceWatchers.get(jid);
    if (stopWatcher) {
      stopWatcher();
      this.workspaceWatchers.delete(jid);
    }
    this.runtimeWorkDirs.delete(jid);

    // 通知前端 agent 已销毁（state → idle），必须在 cleanupEvents 之前，
    // 否则 bindEvents.onStateUpdate 已被移除，事件无人转发。
    this.agentEventSink?.notifyAgentState(jid, 'idle');

    // 移除 bindEvents + PermissionBridge 注册的持久事件监听器（防止内存泄漏）
    const cleanupEvents = this.eventCleanups.get(jid);
    if (cleanupEvents) {
      cleanupEvents();
      this.eventCleanups.delete(jid);
    }

    // 停止 memory 文件监听
    const binding = this.bindings.get(jid);
    if (binding) {
      try { MemoryManager.getInstance().destroyAgent(binding.folder); } catch { /* not init */ }
    }
    this.bindings.delete(jid);
    this.synthPausedJids.delete(jid);
    this.dispatchPausedJids.delete(jid);

    // 清理 dispatch 相关状态
    // 若此 agent 正在执行 dispatch 任务，主动通知 DispatchBridge 将其标记为 error，
    // 避免任务永久卡在 processing 状态（activeTasks 孤立条目 → parent 永不完成）。
    // notifyError 内部通过 activeAgentTasks 判断是否有有效任务，无则自动跳过。
    this.dispatchBridge?.notifyError(jid, 'Agent destroyed');
    this.lastDispatchReplies.delete(jid);
    this.dispatchTaskMap.delete(jid);
    this.dispatchExecuting.delete(jid);
    this.dispatchWorkspaceOverrides.delete(jid);

    // 清理 todos 缓存并通知前端清空该 agent 的 todos
    if (this.cachedTodos.has(jid)) {
      this.cachedTodos.delete(jid);
      const name = binding?.name ?? jid;
      this.agentEventSink?.notifyAgentTodos?.(jid, name, []);
    }

    const core = this.cores.get(jid);
    if (!core) {
      // 即使 core 不存在，也通知前端重置到 idle，防止气泡残留
      this.agentEventSink?.notifyAgentState(jid, 'idle');
      return;
    }
    this.cores.delete(jid);
    try {
      core.clearWorkingDir();
      await core.dispose();
    } catch {
      // 清理失败不影响流程
    }
    // 通知前端重置到 idle（session:error / destroy 后 state 不会自动推送 idle）
    this.agentEventSink?.notifyAgentState(jid, 'idle');
  }

  /** 销毁所有 Agent（关闭时调用） */
  async destroyAll(): Promise<void> {
    const jids = [...this.cores.keys()];
    await Promise.all(jids.map((jid) => this.destroy(jid)));
    fs.unwatchFile(getSkillsReloadSignalPath());
  }

  // ===== Internal =====

  /**
   * 解析飞书应用凭证：优先从 config.json feishuApps 查找（多应用），
   * 回退到 config.feishu 默认应用（env 变量）。
   */
  private resolveFeishuCredentials(botToken?: string): { appId: string; appSecret: string; domain?: string } | null {
    // 多应用场景：botToken = appId
    if (botToken) {
      const apps = getFeishuApps();
      const app = apps[botToken];
      if (app) {
        return { appId: botToken, appSecret: app.appSecret, domain: app.domain };
      }
    }
    // 回退到默认应用（环境变量）
    if (config.feishu.appId && config.feishu.appSecret) {
      return {
        appId: config.feishu.appId,
        appSecret: config.feishu.appSecret,
        domain: config.feishu.domain,
      };
    }
    console.warn(`[AgentPool] Cannot resolve Feishu credentials for botToken=${botToken}`);
    return null;
  }

  /** 初始化工作区状态文件（首次创建 agent 时写入默认值） */
  private initWorkspaceState(stateFile: string, defaultDir: string): void {
    try {
      // 若已有状态文件，保留（可能是上次 session 切换后的目录）
      if (!fs.existsSync(stateFile)) {
        fs.mkdirSync(path.dirname(stateFile), { recursive: true });
        fs.writeFileSync(stateFile, JSON.stringify({
          currentDir: defaultDir,
          updatedAt: new Date().toISOString(),
        }, null, 2), 'utf8');
      }
    } catch (e) {
      console.warn(`[AgentPool] Could not init workspace state file: ${e}`);
    }
  }

  /**
   * 监听工作区状态文件。
   * workspace-server 写入新路径后，这里调用 core.setWorkingDir() 立即生效。
   */
  private setupWorkspaceWatcher(
    jid: string,
    folder: string,
    stateFile: string,
    core: SemaCore,
  ): void {
    const handler = () => {
      try {
        const raw = fs.readFileSync(stateFile, 'utf8');
        const state = JSON.parse(raw) as { currentDir: string };
        const newDir = state.currentDir;
        if (newDir && newDir !== this.runtimeWorkDirs.get(jid)) {
          this.runtimeWorkDirs.set(jid, newDir);
          core.setWorkingDir(newDir);
          console.log(`[AgentPool] Workspace switched for ${folder}: ${newDir}`);
        }
      } catch {
        // 读取失败忽略（可能文件写入中途）
      }
    };

    // interval=300ms，足够响应，又不至于频繁 IO
    fs.watchFile(stateFile, { interval: 300, persistent: false }, handler);
    this.workspaceWatchers.set(jid, () => fs.unwatchFile(stateFile, handler));
  }

  private bindEvents(core: SemaCore, binding: GroupBinding, cleanupPermission?: () => void): void {
    // 记录本轮最后一条 agent 消息，供 dispatch 任务完成时使用
    let lastReplyContent = '';

    // Agent 完成响应时，将内容发送回频道 + 记录到每日日志
    const onMessageComplete = (data: MessageCompleteData) => {
      if (data.agentId !== MAIN_AGENT_ID) return; // 忽略子 Agent 的事件
      if (!data.content.trim()) return;

      lastReplyContent = data.content;
      this.lastDispatchReplies.set(binding.jid, data.content);

      this.broadcastReply(binding.jid, data.content, binding.botToken ?? undefined);

      // 记录 agent 回复到每日日志（仅文本回复，跳过纯 tool_call）
      this.dailyLogger.append(binding.folder, 'Assistant', data.content);
    };

    // 持久 state:update 监听 → WsGateway（与 processAndWait 临时监听互不干扰）
    const onStateUpdate = (data: StateUpdateData) => {
      this.agentEventSink?.notifyAgentState(binding.jid, data.state);
      if (data.state === 'idle' && this.dispatchExecuting.has(binding.jid)) {
        // dispatch 任务完成：agent 可能只有 tool_use 输出没有纯文本 message:complete，
        // 此时 lastReplyContent 为空，但仍需通知 DispatchBridge 标记任务完成。
        const replyText = lastReplyContent || this.lastDispatchReplies.get(binding.jid) || '';
        const taskId = this.dispatchTaskMap.get(binding.jid);
        if (taskId) {
          this.dispatchBridge?.notifyTaskDone(taskId, replyText);
          // notifyTaskDone → processNextPending → startTask 可能已同步写入下一个 taskId，
          // 只有 dispatchTaskMap 仍指向当前 taskId 时才删除，避免误删下一个任务的 ID
          if (this.dispatchTaskMap.get(binding.jid) === taskId) {
            this.dispatchTaskMap.delete(binding.jid);
          }
        } else {
          // fallback: taskId 未知时走兼容桥接
          this.dispatchBridge?.notifyReply(binding.jid, replyText);
        }
        lastReplyContent = '';
        // 清除 lastDispatchReplies，防止 onCompleted 回调中的 notifyDispatchIfPending
        // 用已消费的旧内容重复通知（会错误标记下一个任务为 done）
        this.lastDispatchReplies.delete(binding.jid);
      }
    };

    // todos:update → WsGateway（转发 TodoWrite 工具写入的任务列表到控制台）
    const onTodosUpdate = (data: TodosUpdateData) => {
      // 缓存完整 todos 快照（StateManager 现在总是发全量）
      this.cachedTodos.set(binding.jid, { agentName: binding.name, todos: data as { content: string; status: string; activeForm?: string }[] });
      this.agentEventSink?.notifyAgentTodos?.(binding.jid, binding.name, data);
    };

    // compact:start → 通知前端进入 compacting 状态（禁用暂停按钮）
    const onCompactStart = (_data: CompactStartData) => {
      this.agentEventSink?.notifyAgentCompacting?.(binding.jid, true);
    };

    // compact:exec → 触发记忆重索引（每日日志由 onMessageComplete 写入，此处仅标记 dirty）
    // 同时通知前端 compacting 结束
    const onCompactExec = (_data: CompactExecData) => {
      this.agentEventSink?.notifyAgentCompacting?.(binding.jid, false);
      try {
        const today = new Date().toISOString().slice(0, 10);
        const changedFile = path.join(config.paths.agentsDir, binding.folder, 'memory', `${today}.md`);
        MemoryManager.getInstance().markDirty(binding.folder, changedFile);
      } catch { /* not init */ }
    };

    // Agent 错误日志
    const onSessionError = (data: SessionErrorData) => {
      console.error(
        `[AgentPool] Session error for ${binding.jid}: [${data.error.code}] ${data.error.message}`
      );
    };

    core.on<MessageCompleteData>('message:complete', onMessageComplete);
    core.on<StateUpdateData>('state:update', onStateUpdate);
    core.on<TodosUpdateData>('todos:update', onTodosUpdate);
    core.on<CompactStartData>('compact:start', onCompactStart);
    core.on<CompactExecData>('compact:exec', onCompactExec);
    core.on<SessionErrorData>('session:error', onSessionError);

    // 保存清理函数，destroy 时移除所有持久监听器（含 PermissionBridge）
    this.eventCleanups.set(binding.jid, () => {
      core.off('message:complete', onMessageComplete);
      core.off('state:update', onStateUpdate);
      core.off('todos:update', onTodosUpdate);
      core.off('compact:start', onCompactStart);
      core.off('compact:exec', onCompactExec);
      core.off('session:error', onSessionError);
      cleanupPermission?.();
    });
  }
}
