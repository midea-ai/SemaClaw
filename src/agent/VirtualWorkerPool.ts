/**
 * VirtualWorkerPool — 虚拟 agent 临时实例管理
 *
 * 按 PersonaConfig 创建临时 SemaCore 实例，执行 prompt 后销毁。
 * 通过 activeCounts 控制每个 persona 的并行上限。
 * 支持 cancelAll() 强制中止所有运行中的虚拟任务。
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { SemaCore } from 'sema-core';
import type { MessageCompleteData, StateUpdateData, SessionErrorData, TodosUpdateData } from 'sema-core/event';
import type { PersonaConfig } from './PersonaRegistry';
import type { PermissionBridge } from './PermissionBridge';
import type { GroupBinding } from '../types';
import { config } from '../config';
import { readDisabledSkills } from '../skills/disabled.js';
import { expandSkillsDir } from '../skills/expand.js';

export type TodosNotifyFn = (agentJid: string, agentName: string, todos: { content: string; status: string; activeForm?: string }[]) => void;

export interface VirtualRunResult {
  result: string;
  durationMs: number;
}

/** 默认超时 10 分钟 */
const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;
/** createSession 超时 30 秒 */
const CREATE_SESSION_TIMEOUT_MS = 30_000;

/** 虚拟 agent 排除的工具 */
const VIRTUAL_EXCLUDED_TOOLS = ['Task', 'AskUserQuestion'];

/** 所有非 admin 池化工具集 */
const ALL_POOLED_TOOLS = [
  'Bash', 'Glob', 'Grep', 'Read', 'Write', 'Edit',
  'TodoWrite', 'Skill', 'NotebookEdit',
];

let instanceCounter = 0;

function generateInstanceId(personaName: string): string {
  instanceCounter++;
  const ts = Date.now().toString(36);
  return `${personaName}-${ts}-${instanceCounter}`;
}

/** 运行中的虚拟实例，供 cancelAll 使用 */
interface RunningInstance {
  taskId: string;
  personaName: string;
  core: SemaCore;
  abortController: AbortController;
  tempDir: string;
  /** cancelTask 已提前递减 activeCounts，finally 中不再重复递减 */
  countDecrementedEarly: boolean;
  /** PermissionBridge 注册的监听器清理函数 */
  cleanupPermission?: () => void;
}

export class VirtualWorkerPool {
  private activeCounts = new Map<string, number>();
  /** 由外部注入：推送虚拟 agent 的 todos 到 WsGateway */
  private todosNotify: TodosNotifyFn | null = null;
  /** 所有运行中的虚拟实例（按 taskId 索引） */
  private runningInstances = new Map<string, RunningInstance>();
  /** 由外部注入：权限桥接（将虚拟 agent 的权限请求转发到前端） */
  private permissionBridge: PermissionBridge | null = null;
  /** 由外部注入：获取当前是否跳过权限审批（随主 agent 配置） */
  private getSkipPerms: (() => boolean) | null = null;

  setTodosNotify(fn: TodosNotifyFn): void {
    this.todosNotify = fn;
  }

  setPermissionBridge(bridge: PermissionBridge, getSkipPerms: () => boolean): void {
    this.permissionBridge = bridge;
    this.getSkipPerms = getSkipPerms;
  }

  async run(
    persona: PersonaConfig,
    prompt: string,
    workspaceDir: string,
    options?: { timeout?: number; taskId?: string },
  ): Promise<VirtualRunResult> {
    const current = this.activeCounts.get(persona.name) ?? 0;
    if (current >= persona.maxConcurrent) {
      throw new Error(
        `Persona "${persona.name}" has reached max concurrency (${persona.maxConcurrent}). ` +
        `${current} instance(s) currently running.`
      );
    }

    this.activeCounts.set(persona.name, current + 1);
    const startTime = Date.now();
    const instanceId = generateInstanceId(persona.name);
    const tempDir = path.join(os.tmpdir(), `semaclaw-virtual-${instanceId}`);
    const abortController = new AbortController();

    let core: SemaCore | null = null;

    try {
      // Prepare temp agent data dir
      fs.mkdirSync(tempDir, { recursive: true });
      if (persona.systemPrompt) {
        fs.writeFileSync(path.join(tempDir, 'CLAUDE.md'), persona.systemPrompt, 'utf-8');
      }

      // Check abort before expensive operations
      if (abortController.signal.aborted) throw new Error('Cancelled');

      // Resolve tool set
      const useTools = persona.tools
        ? persona.tools.filter(t => !VIRTUAL_EXCLUDED_TOOLS.includes(t))
        : ALL_POOLED_TOOLS.filter(t => !VIRTUAL_EXCLUDED_TOOLS.includes(t));

      // 构建 skillsExtraDirs（与 AgentPool 同源）
      const _disabled = readDisabledSkills();
      const skillsExtraDirs = [
        ...(config.paths.bundledSkillsDir
          ? expandSkillsDir(config.paths.bundledSkillsDir, 'managed', _disabled)
          : []),
        ...expandSkillsDir(path.join(os.homedir(), '.claude', 'skills'), 'user', _disabled),
        ...expandSkillsDir(config.paths.managedSkillsDir, 'managed', _disabled),
        ...expandSkillsDir(path.join(workspaceDir, 'skills'), 'workspace', _disabled),
      ];

      // 权限配置：随主 agent 配置
      const skipPerms = this.getSkipPerms?.() ?? true;

      // Create temporary SemaCore instance (no MCP servers)
      core = new SemaCore({
        instanceId,
        agentDataDir: tempDir,
        workingDir: workspaceDir,
        agentMode: 'Agent',
        useTools,
        logLevel: 'warn',
        skillsExtraDirs,
        skipFileEditPermission: skipPerms,
        skipBashExecPermission: skipPerms,
        skipSkillPermission: skipPerms,
        skipMCPToolPermission: true,
        skipMCPInit: true,
      });

      // createSession with timeout + abort protection
      let sessionTimer: ReturnType<typeof setTimeout> | null = null;
      try {
        await Promise.race([
          core.createSession(`virtual-${instanceId}`),
          new Promise<never>((_, reject) => {
            sessionTimer = setTimeout(() => reject(new Error(`createSession timeout (${CREATE_SESSION_TIMEOUT_MS / 1000}s)`)), CREATE_SESSION_TIMEOUT_MS);
          }),
          new Promise<never>((_, reject) => {
            if (abortController.signal.aborted) reject(new Error('Cancelled'));
            abortController.signal.addEventListener('abort', () => reject(new Error('Cancelled')), { once: true });
          }),
        ]);
      } finally {
        if (sessionTimer) clearTimeout(sessionTimer);
      }

      // 绑定 PermissionBridge（权限请求转发到前端，使用 virtual:{taskId} 作为 jid）
      const taskId = options?.taskId ?? instanceId;
      let cleanupPermission: (() => void) | undefined;
      if (this.permissionBridge && !skipPerms) {
        const virtualJid = `virtual:${taskId}`;
        const virtualBinding: GroupBinding = {
          jid: virtualJid,
          folder: `virtual-${instanceId}`,
          name: persona.name,
          channel: '',
          isAdmin: false,
          requiresTrigger: false,
          allowedTools: null,
          allowedPaths: null,
          allowedWorkDirs: null,
          botToken: null,
          maxMessages: null,
          lastActive: null,
          addedAt: new Date().toISOString(),
        };
        cleanupPermission = this.permissionBridge.bindCore(core, virtualBinding);
      }

      // Register running instance for cancel tracking
      const instance: RunningInstance = { taskId, personaName: persona.name, core, abortController, tempDir, countDecrementedEarly: false, cleanupPermission };
      this.runningInstances.set(taskId, instance);

      // 注册 todos:update 监听，转发到 WsGateway（使用 virtual:{taskId} 作为 jid）
      if (this.todosNotify && options?.taskId) {
        const todoJid = `virtual:${options.taskId}`;
        core.on<TodosUpdateData>('todos:update', (data) => {
          this.todosNotify!(todoJid, persona.name, data as { content: string; status: string; activeForm?: string }[]);
        });
      }

      const timeoutMs = options?.timeout
        ? options.timeout * 1000
        : DEFAULT_TIMEOUT_MS;

      const result = await this.executeAndWait(core, prompt, timeoutMs, abortController.signal);

      // Cleanup core
      try { await core.dispose(); } catch { /* ignore */ }
      core = null;

      return {
        result,
        durationMs: Date.now() - startTime,
      };
    } finally {
      // Unregister running instance
      const taskId = options?.taskId ?? instanceId;
      const inst = this.runningInstances.get(taskId);
      this.runningInstances.delete(taskId);

      // Decrement active count（若 cancelTask 已提前递减则跳过）
      if (!inst?.countDecrementedEarly) {
        const count = this.activeCounts.get(persona.name) ?? 1;
        if (count <= 1) {
          this.activeCounts.delete(persona.name);
        } else {
          this.activeCounts.set(persona.name, count - 1);
        }
      }

      // 清理 PermissionBridge 监听器
      if (inst?.cleanupPermission) {
        try { inst.cleanupPermission(); } catch { /* ignore */ }
      }

      // Dispose core if not already done (error/cancel path)
      if (core) {
        try { await core.dispose(); } catch { /* ignore */ }
      }

      // Remove temp dir
      try {
        fs.rmSync(tempDir, { recursive: true, force: true });
      } catch { /* ignore */ }
    }
  }

  getActiveCount(personaName: string): number {
    return this.activeCounts.get(personaName) ?? 0;
  }

  /**
   * 强制中止指定 taskId 的虚拟任务。
   * cancel 后 run() 的 Promise 会 reject，finally 清理 activeCounts。
   */
  cancelTask(taskId: string): void {
    const instance = this.runningInstances.get(taskId);
    if (!instance) return;
    console.warn(`[VirtualWorkerPool] Cancelling task ${taskId} (persona: ${instance.personaName})`);
    // 立即递减 activeCounts，不等待 finally 的异步清理
    // 防止新一轮 dispatch 被旧计数阻塞
    if (!instance.countDecrementedEarly) {
      instance.countDecrementedEarly = true;
      const count = this.activeCounts.get(instance.personaName) ?? 1;
      if (count <= 1) {
        this.activeCounts.delete(instance.personaName);
      } else {
        this.activeCounts.set(instance.personaName, count - 1);
      }
    }
    instance.abortController.abort();
    // 强制 dispose core（中断正在执行的 API 调用）
    try { instance.core.dispose().catch(() => {}); } catch { /* ignore */ }
  }

  /**
   * 强制中止所有运行中的虚拟任务（admin reset 时调用）。
   */
  cancelAll(): void {
    if (this.runningInstances.size === 0) return;
    console.warn(`[VirtualWorkerPool] Cancelling all ${this.runningInstances.size} running instance(s)`);
    for (const [taskId] of this.runningInstances) {
      this.cancelTask(taskId);
    }
  }

  private executeAndWait(
    core: SemaCore,
    prompt: string,
    timeoutMs: number,
    signal: AbortSignal,
  ): Promise<string> {
    return new Promise<string>((resolve, reject) => {
      let lastReply = '';
      let settled = false;

      // Check if already aborted
      if (signal.aborted) {
        reject(new Error('Cancelled'));
        return;
      }

      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(new Error(`Virtual agent timed out after ${Math.round(timeoutMs / 1000)}s`));
      }, timeoutMs);

      const cleanup = () => {
        clearTimeout(timer);
        signal.removeEventListener('abort', onAbort);
        core.off('state:update', onStateUpdate);
        core.off('message:complete', onMessageComplete);
        core.off('session:error', onSessionError);
      };

      const onAbort = () => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(new Error('Cancelled'));
      };

      signal.addEventListener('abort', onAbort, { once: true });

      const onMessageComplete = (data: MessageCompleteData) => {
        if (data.agentId !== 'main') return;
        const text = data.content?.trim();
        if (text) {
          lastReply = text;
        }
      };

      const onStateUpdate = (data: StateUpdateData) => {
        if (data.state === 'idle' && !settled) {
          settled = true;
          cleanup();
          resolve(lastReply);
        }
      };

      const onSessionError = (data: SessionErrorData) => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(new Error(`Virtual agent session error: ${data.error}`));
      };

      core.on<MessageCompleteData>('message:complete', onMessageComplete);
      core.on<StateUpdateData>('state:update', onStateUpdate);
      core.on<SessionErrorData>('session:error', onSessionError);
      core.processUserInput(prompt);
    });
  }
}
