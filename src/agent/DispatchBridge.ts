/**
 * DispatchBridge — 主 Agent 任务调度桥
 *
 * 通过 ~/.semaclaw/dispatch-state.json 协调主进程与 dispatch-server 子进程。
 *
 * 文件结构：
 *   { _seq, agents[], parents[] }
 *   parents[].tasks[] 嵌套在各自 parent 下
 *
 * 任务 ID 格式：
 *   parent: p-YYYYMMDD-{seq:04d}
 *   task:   d-YYYYMMDD-{seq:04d}
 *
 * 主进程职责：
 *   1. 轮询 registered 任务 → 检查 DAG 依赖就绪 → 注入 context → 发给目标 agent
 *   2. 队列回调结束 → notifyTaskDone/notifyTaskError（taskId 由回调闭包捕获）
 *      → 标记 terminal，检查 parent 是否全部完成
 *   3. 超时检测：仅把任务标记为 timeout（让 admin 的 dispatch_task 尽快返回），
 *      不视 agent 为空闲——activeTasks 条目保留，agent 真正跑完后才解除占用并调度后续任务。
 *      cleanup 按 parent 粒度（完成后保留 1h）
 *   4. 同一 admin 同时只允许一个 active parent，多余的排队（queued）
 *   5. parent 完成后自动激活同 admin 下一个 queued parent
 *      激活时读取 admin 当前 workspace state 文件，写入 sharedWorkspace
 *   6. dispatch task 期间子 agent 切换到 sharedWorkspace；任务全部完成后恢复
 */

import * as fs from 'fs';
import * as path from 'path';
import type { GroupBinding } from '../types';
import type { PersonaRegistry } from './PersonaRegistry';
import type { VirtualWorkerPool } from './VirtualWorkerPool';
import { config } from '../config';

// ===== Types =====

export interface DispatchAgent {
  name: string;
  id: string;      // folder
  jid: string;
  channel: string;
}

export type TaskStatus = 'registered' | 'processing' | 'done' | 'error' | 'timeout';

export interface DispatchTask {
  id: string;
  /** 用户指定的任务标签，同 parent 内唯一，用于 dependsOn 引用和 dispatch_task 调用 */
  label: string;
  agentId: string;   // 持久: folder, 虚拟: "persona:code-reviewer"
  agentJid: string;  // 持久: jid,    虚拟: "" (空字符串)
  /** 该任务启动前必须达到 terminal 状态的其他任务的 label 列表 */
  dependsOn: string[];
  status: TaskStatus;
  prompt: string;
  result: string | null;
  createdAt: string;
  startedAt: string | null;
  timeoutSeconds: number;
  timeoutAt: string | null;
  completedAt: string | null;
  /** 是否为虚拟 agent 任务（前端用于区分显示逻辑） */
  isVirtual?: boolean;
  /** 虚拟 agent 的人设名称（如 "code-reviewer"） */
  personaName?: string;
}

export interface DispatchParent {
  id: string;
  /** 发起 dispatch 的 admin agent folder（用于 workspace 读取和排队隔离） */
  adminFolder: string;
  /**
   * 激活时从 admin 当前 workspace state 文件读取的工作目录。
   * 所有子任务执行期间均临时切换到此目录。
   */
  sharedWorkspace: string | null;
  goal: string;
  /** queued: 同 admin 已有 active parent，等待激活；active: 正在运行；done: 已完成 */
  status: 'queued' | 'active' | 'done';
  createdAt: string;
  completedAt: string | null;
  tasks: DispatchTask[];
}

export interface DispatchState {
  _seq: number;
  agents: DispatchAgent[];
  parents: DispatchParent[];
}

const TERMINAL: TaskStatus[] = ['done', 'error', 'timeout'];

/**
 * 子任务实际超时下限（秒）。admin 在 create_parent 里设置的 timeoutSeconds
 * 有时过短，导致任务被过早标记 timeout；此处统一兜底为至少 10 分钟。
 */
export const MIN_TASK_TIMEOUT_SECONDS = 600;

// ===== DispatchBridge =====

export class DispatchBridge {
  /** taskId → jid（主索引：精确追踪每个活跃任务） */
  private activeTasks = new Map<string, string>();
  /** jid → Set<taskId>（辅助索引：快速查询某 agent 名下所有活跃任务） */
  private activeAgentTasks = new Map<string, Set<string>>();
  private pollInterval: ReturnType<typeof setInterval> | null = null;
  private cleanupInterval: ReturnType<typeof setInterval> | null = null;
  /**
   * 心跳定时器：每 2 分钟向所有有 active parent 的 admin agent 发送 activity 信号，
   * 防止 admin agent 的 processAndWait 30 分钟无心跳超时定时器误触发。
   */
  private heartbeatInterval: ReturnType<typeof setInterval> | null = null;
  /** 子任务完成/出错时，通知对应 admin agent 重置超时计时器（由 AgentPool 注入） */
  private onAdminActivity: ((adminFolder: string) => void) | null = null;
  /** WsGateway 注入：dispatch state 变化时推送给 admin 客户端 */
  private wsNotify: ((parents: DispatchParent[]) => void) | null = null;
  /**
   * 当前已暂停的 admin folder 集合。
   * processPending 不会为暂停的 admin 启动新任务。
   */
  private pausedAdmins = new Set<string>();
  /** Phase 2: 虚拟 agent 支持 */
  private personaRegistry: PersonaRegistry | null = null;
  private virtualWorkerPool: VirtualWorkerPool | null = null;

  constructor(
    private readonly statePath: string,
    /**
     * 由 index.ts 注入：设置子 agent 工作目录并将 augmented prompt 发给目标 agent。
     * taskId 由队列回调闭包捕获，任务真正执行完毕时回调 notifyTaskDone/notifyTaskError——
     * 这是任务完成归因的唯一事实来源。
     * workspaceDir 为空字符串时表示不切换（子 agent 保持自身目录）。
     */
    private readonly sendToAgent: (jid: string, taskId: string, prompt: string, workspaceDir: string) => void,
    /** 由 index.ts 注入：dispatch task 全部完成后恢复子 agent 工作目录 */
    private readonly revertWorkspace: (jid: string) => void,
  ) {}

  /** 注入 admin activity 回调（子任务完成/出错时重置 admin agent 超时计时器） */
  setAdminActivityCallback(cb: (adminFolder: string) => void): void {
    this.onAdminActivity = cb;
  }

  setWsNotify(fn: (parents: DispatchParent[]) => void): void {
    this.wsNotify = fn;
  }

  /** 注入虚拟 agent 依赖（Phase 2 DAG 集成） */
  setVirtualWorkerPool(registry: PersonaRegistry, pool: VirtualWorkerPool): void {
    this.personaRegistry = registry;
    this.virtualWorkerPool = pool;
  }

  /** 返回当前所有 parent 供 WsGateway 初始推送 */
  getParents(): DispatchParent[] {
    try { return this.readState().parents; } catch { return []; }
  }

  start(): void {
    // 清理上一轮遗留的 active/queued parent（服务重启后进程内状态全部丢失，无法继续执行）
    this.modifyState(state => {
      const now = new Date().toISOString();
      for (const parent of state.parents) {
        if (parent.status === 'active' || parent.status === 'queued') {
          for (const task of parent.tasks) {
            if (task.status === 'processing' || task.status === 'registered') {
              task.status = 'error';
              task.result = 'Interrupted: service restarted';
              task.completedAt = now;
            }
          }
          parent.status = 'done';
          parent.completedAt = now;
        }
      }
    });
    this.pollInterval     = setInterval(() => this.processPending(), 300);
    this.cleanupInterval  = setInterval(() => this.cleanup(), 10 * 60 * 1000);
    // 每 2 分钟心跳：向所有 active parent 的 admin 发 activity 信号，
    // 防止 admin agent 的 processAndWait 因等待 dispatch_task MCP 调用而 30 分钟无 state:update 触发超时。
    this.heartbeatInterval = setInterval(() => this.heartbeatActiveAdmins(), 2 * 60 * 1000);
    this.cleanup();
    console.log(`[DispatchBridge] Started, state: ${this.statePath}`);
  }

  stop(): void {
    if (this.pollInterval)     clearInterval(this.pollInterval);
    if (this.cleanupInterval)  clearInterval(this.cleanupInterval);
    if (this.heartbeatInterval) clearInterval(this.heartbeatInterval);
  }

  /**
   * 心跳：遍历所有 active parent，对其 admin agent 发送 activity 信号，重置 processAndWait 超时计时器。
   * 解决 dispatch_task MCP 调用长时间阻塞时 sema-core 不发 state:update 导致 admin 误超时的问题。
   */
  private heartbeatActiveAdmins(): void {
    try {
      const state = this.readState();
      const activeAdminFolders = new Set(
        state.parents
          .filter(p => p.status === 'active')
          .map(p => p.adminFolder)
      );
      for (const folder of activeAdminFolders) {
        this.onAdminActivity?.(folder);
      }
    } catch { /* ignore */ }
  }

  // ===== Active task tracking helpers =====

  private addActiveTask(taskId: string, jid: string): void {
    this.activeTasks.set(taskId, jid);
    let set = this.activeAgentTasks.get(jid);
    if (!set) { set = new Set(); this.activeAgentTasks.set(jid, set); }
    set.add(taskId);
  }

  private removeActiveTask(taskId: string): string | undefined {
    const jid = this.activeTasks.get(taskId);
    if (!jid) return undefined;
    this.activeTasks.delete(taskId);
    const set = this.activeAgentTasks.get(jid);
    if (set) {
      set.delete(taskId);
      if (set.size === 0) this.activeAgentTasks.delete(jid);
    }
    return jid;
  }

  /** 某 agent 当前是否还有活跃的 dispatch 任务 */
  hasActiveTasks(jid: string): boolean {
    const set = this.activeAgentTasks.get(jid);
    return !!set && set.size > 0;
  }

  // ===== Task-centric completion notifications =====

  /**
   * 任务完成统一处理（done / error 共用）：
   * 解除 activeTasks 占用 → 写 state（TERMINAL 守卫防止覆盖已 terminal 的状态）→
   * admin activity → 激活下一个 queued parent → 调度后续任务 → workspace 还原检查。
   * 对已 terminal 的任务（如先被标记 timeout / cancel），状态与结果不变，
   * 但仍会解除占用并执行还原检查——这是超时持有 slot 语义下唯一的回收点。
   */
  private completeTask(taskId: string, status: 'done' | 'error', result: string): void {
    const jid = this.removeActiveTask(taskId); // 持久 agent 返回 jid，虚拟 agent 返回 undefined
    const now = new Date().toISOString();
    let taskAdminFolder: string | null = null;
    let completedParentAdminFolder: string | null = null;
    let taskAgentJid: string | null = null;
    this.modifyState(state => {
      for (const parent of state.parents) {
        const task = parent.tasks.find(t => t.id === taskId);
        if (!task) continue;
        if (!task.isVirtual && task.agentJid) taskAgentJid = task.agentJid;
        // 防止已 cancel/timeout 的任务悬空回调覆盖 terminal 状态
        if (TERMINAL.includes(task.status)) break;
        taskAdminFolder = parent.adminFolder;
        task.status      = status;
        task.result      = result;
        task.completedAt = now;
        if (parent.tasks.every(t => TERMINAL.includes(t.status))) {
          parent.status      = 'done';
          parent.completedAt = now;
          completedParentAdminFolder = parent.adminFolder;
        }
        break;
      }
    });
    if (status === 'done') {
      console.log(`[DispatchBridge] Task ${taskId} done${jid ? ` for ${jid}` : ' (virtual)'}`);
    } else {
      console.warn(`[DispatchBridge] Task ${taskId} error${jid ? ` for ${jid}` : ' (virtual)'}: ${result}`);
    }
    if (taskAdminFolder) this.onAdminActivity?.(taskAdminFolder);
    if (completedParentAdminFolder) {
      this.activateNextQueued(completedParentAdminFolder);
    }
    this.processNextPending();
    // jid 为 undefined 时（任务已先被其他路径标记 terminal，activeTasks 无记录）
    // 用 state 里的 agentJid 兜底，确保 agent 真正结束后 workspace/权限一定被还原
    const revertJid = jid ?? taskAgentJid ?? undefined;
    if (revertJid && !this.hasActiveTasks(revertJid)) {
      this.revertWorkspace(revertJid);
    }
  }

  /**
   * 将指定 taskId 的任务标记为 done（task-centric，精准匹配）。
   * 支持持久 agent（activeTasks 有记录）和虚拟 agent（无 jid）。
   */
  notifyTaskDone(taskId: string, text: string): void {
    this.completeTask(taskId, 'done', text);
  }

  /**
   * 将指定 taskId 的任务标记为 error（task-centric，精准匹配）。
   * 支持持久 agent 和虚拟 agent。
   */
  notifyTaskError(taskId: string, errorMessage: string): void {
    this.completeTask(taskId, 'error', errorMessage);
  }

  /**
   * jid 级兜底：Agent 被 stop / destroy 时由 AgentPool 调用（只有 jid）。
   * 释放该 jid 名下【所有】活跃任务条目并标记 error——不按 status 过滤：
   * 已被标记 timeout 的任务其队列回调可能刚被 clearQueue 丢弃，
   * 这里是它解除 activeTasks 占用的唯一机会（否则该 jid 永久无法调度新任务）。
   * 已 terminal 的任务状态不会被覆盖（completeTask 内 TERMINAL 守卫）。
   * 非 dispatch 调用时无记录，直接返回。
   *
   * 重要：清扫过程中 completeTask → processNextPending 可能同步启动同 jid 的
   * 下一个任务（新条目不在本次迭代副本中，不会被本次清扫波及）。因此一次
   * 拆除流程（stop / destroy）只允许调用一次 notifyError——连续两次清扫会把
   * 第一次清扫刚调度的任务误标 error，而其队列回调仍会幽灵执行。
   */
  notifyError(jid: string, errorMessage: string): void {
    const set = this.activeAgentTasks.get(jid);
    if (!set || set.size === 0) return;
    // 先复制：completeTask 内部的 removeActiveTask 会修改原 set
    for (const taskId of [...set]) {
      this.notifyTaskError(taskId, errorMessage);
    }
  }

  /**
   * admin agent stop 时调用：取消该 admin 所有 active/queued parents，
   * 将 processing/registered 子任务标记为 error，阻止后续调度。
   * 返回当前正在执行的子 agent jid 列表，
   * 调用方需同步 stop 这些子 agent 以中止它们的 processAndWait。
   */
  cancelAdminParents(adminFolder: string): string[] {
    const affectedJids: string[] = [];
    const now = new Date().toISOString();
    this.modifyState(state => {
      for (const parent of state.parents) {
        if (parent.adminFolder !== adminFolder) continue;
        if (parent.status !== 'active' && parent.status !== 'queued') continue;
        for (const task of parent.tasks) {
          if (task.status === 'processing') {
            if (task.isVirtual) {
              // 虚拟 agent：通过 VirtualWorkerPool 中止运行中的实例
              this.virtualWorkerPool?.cancelTask(task.id);
            } else {
              affectedJids.push(task.agentJid);
            }
            this.removeActiveTask(task.id);
            task.status = 'error';
            task.result = 'Cancelled: admin agent stopped';
            task.completedAt = now;
          } else if (task.status === 'registered') {
            task.status = 'error';
            task.result = 'Cancelled: admin agent stopped';
            task.completedAt = now;
          }
        }
        parent.status = 'done';
        parent.completedAt = now;
      }
    });
    this.pausedAdmins.delete(adminFolder); // stop 后清除 pause 状态
    if (affectedJids.length > 0) {
      console.log(`[DispatchBridge] cancelAdminParents(${adminFolder}): cancelled tasks for jids: ${affectedJids.join(', ')}`);
    }
    return affectedJids;
  }

  /**
   * admin agent pause 时调用：阻止 processPending 为该 admin 启动新任务。
   * 返回当前正在执行的子 agent jid 列表，
   * 调用方可选择同步 pause 这些子 agent。
   */
  pauseAdmin(adminFolder: string): string[] {
    this.pausedAdmins.add(adminFolder);
    // 收集所有属于该 admin 当前 processing 任务的子 agent jids
    const childJids: string[] = [];
    try {
      const state = this.readState();
      for (const parent of state.parents) {
        if (parent.adminFolder !== adminFolder || parent.status !== 'active') continue;
        for (const task of parent.tasks) {
          if (task.status === 'processing' && task.agentJid && this.activeTasks.has(task.id)) {
            childJids.push(task.agentJid);
          }
        }
      }
    } catch { /* ignore */ }
    console.log(`[DispatchBridge] pauseAdmin(${adminFolder}): blocked scheduling, child jids: [${childJids.join(', ')}]`);
    return childJids;
  }

  /**
   * admin agent resume 时调用：恢复该 admin 的任务调度。
   */
  resumeAdmin(adminFolder: string): void {
    this.pausedAdmins.delete(adminFolder);
    console.log(`[DispatchBridge] resumeAdmin(${adminFolder}): scheduling unblocked`);
  }

  /** 查询指定 admin 是否有活跃（active/queued）的 dispatch parent */
  hasActiveDispatch(adminFolder: string): boolean {
    try {
      const state = this.readState();
      return state.parents.some(p =>
        p.adminFolder === adminFolder && (p.status === 'active' || p.status === 'queued')
      );
    } catch { return false; }
  }

  /**
   * GroupManager 变化时调用，同步 agents 列表到 state 文件。
   */
  updateAgents(groups: GroupBinding[]): void {
    const agents: DispatchAgent[] = groups
      .filter(g => !g.isAdmin)
      .map(g => ({ name: g.name, id: g.folder, jid: g.jid, channel: g.channel }));
    this.modifyState(state => { state.agents = agents; });
  }

  // ===== Internal =====

  private processPending(): void {
    let state: DispatchState;
    try { state = this.readState(); } catch { return; }
    const now = new Date();

    // 超时检测（仅持久 agent 任务；虚拟任务由 VirtualWorkerPool 内部 timeout 管理）
    // 注意：超时只把任务标记为 timeout（让 admin 的 dispatch_task 尽快拿到结果），
    // 不把 agent 视为空闲——agent 实际仍在执行，activeTasks 条目保留，
    // 不调度同 jid 的后续任务、不还原 workspace/权限。
    // agent 真正跑完后，队列回调的 notifyTaskDone/notifyTaskError 会因 TERMINAL 守卫
    // 跳过状态覆盖，但仍会解除占用、调度后续任务并执行还原。
    for (const parent of state.parents) {
      if (parent.status !== 'active') continue;
      for (const task of parent.tasks) {
        if (task.status === 'processing' && !task.isVirtual && task.timeoutAt && new Date(task.timeoutAt) < now) {
          const nowIso = now.toISOString();
          let completedAdminFolder: string | null = null;
          this.modifyState(s => {
            for (const p of s.parents) {
              const t = p.tasks.find(x => x.id === task.id);
              if (!t) continue;
              t.status = 'timeout'; t.completedAt = nowIso;
              if (p.tasks.every(x => TERMINAL.includes(x.status))) {
                p.status = 'done'; p.completedAt = nowIso;
                completedAdminFolder = p.adminFolder;
              }
            }
          });
          console.warn(`[DispatchBridge] Task ${task.id} timed out (agent still busy; slot held until it actually finishes)`);
          if (completedAdminFolder) {
            this.activateNextQueued(completedAdminFolder);
          }
        }
      }
    }

    // 启动 registered 任务
    this.processNextPending();
  }

  /**
   * 扫描所有 active parent 中依赖就绪的 registered 任务并启动。
   * 轮询（processPending）与任务完成（completeTask）两条路径共用。
   */
  private processNextPending(): void {
    try {
      const state = this.readState();
      for (const parent of state.parents) {
        if (parent.status !== 'active') continue;
        if (this.pausedAdmins.has(parent.adminFolder)) continue;
        for (const task of parent.tasks) {
          if (task.status === 'registered' && this.canStartTask(task, parent.tasks)) {
            this.startTask(parent, task);
          }
        }
      }
    } catch { /* ignore */ }
  }

  /**
   * 判断任务是否可以启动：依赖就绪 + 并发约束满足。
   * 持久 agent：同 jid 同时只允许一个 processing。
   * 虚拟 agent：检查 persona 并发上限，不检查 jid。
   */
  private canStartTask(task: DispatchTask, allTasks: DispatchTask[]): boolean {
    if (!this.isReady(task, allTasks)) return false;
    if (task.isVirtual && task.personaName) {
      // 虚拟 agent：检查 persona 并发上限
      const pool = this.virtualWorkerPool;
      const registry = this.personaRegistry;
      if (!pool || !registry) return false;
      const persona = registry.get(task.personaName);
      if (!persona) return false;
      return pool.getActiveCount(task.personaName) < persona.maxConcurrent;
    }
    // 持久 agent：同 jid 同时只允许一个 processing
    return !this.hasActiveTasks(task.agentJid);
  }

  /**
   * 判断任务是否满足启动条件：所有依赖任务均已达到 terminal 状态。
   * continue 策略：error / timeout 同样视为 terminal，不阻塞后续任务。
   */
  private isReady(task: DispatchTask, allTasks: DispatchTask[]): boolean {
    return task.dependsOn.every(depLabel => {
      const dep = allTasks.find(t => t.label === depLabel);
      return dep !== undefined && TERMINAL.includes(dep.status);
    });
  }

  private startTask(parent: DispatchParent, task: DispatchTask): void {
    let ctx = `<parent_goal>${parent.goal}</parent_goal>`;

    // 注入直接前置任务的结果（dependsOn 的所有 task）
    if (task.dependsOn.length > 0) {
      ctx += '\n\n<prerequisites>';
      for (const depLabel of task.dependsOn) {
        const dep = parent.tasks.find(t => t.label === depLabel);
        if (!dep) continue;
        ctx += `\n  <task label="${dep.label}" agent="${dep.agentId}" status="${dep.status}">`;
        ctx += `\n    <prompt>${dep.prompt}</prompt>`;
        if (dep.status === 'done') {
          ctx += dep.result
            ? `\n    <result>${dep.result}</result>`
            : `\n    <result>(task completed but produced no text output — the agent may have only used tools; check workspace for artifacts)</result>`;
        }
        ctx += '\n  </task>';
      }
      ctx += '\n</prerequisites>';
    }

    // 注入同 parent 中其他任务的状态（非 dep、非自身，提供全局感知）
    const others = parent.tasks.filter(
      t => t.id !== task.id && !task.dependsOn.includes(t.label)
    );
    if (others.length > 0) {
      ctx += '\n\n<other_tasks>';
      for (const o of others) {
        if (o.status === 'done') {
          const resultTag = o.result
            ? `\n    <result>${o.result}</result>`
            : `\n    <result>(completed, no text output)</result>`;
          ctx += `\n  <task label="${o.label}" agent="${o.agentId}" status="done">${o.prompt}${resultTag}\n  </task>`;
        } else {
          ctx += `\n  <task label="${o.label}" agent="${o.agentId}" status="${o.status}">${o.prompt}</task>`;
        }
      }
      ctx += '\n</other_tasks>';
    }

    const augmented = `${ctx}\n\n${task.prompt}`;

    const startedAt = new Date().toISOString();
    // 实际超时至少 10 分钟，防止 admin 在 create_parent 里设得过短
    const effectiveTimeoutSeconds = Math.max(task.timeoutSeconds, MIN_TASK_TIMEOUT_SECONDS);
    const timeoutAt = new Date(Date.now() + effectiveTimeoutSeconds * 1000).toISOString();
    this.modifyState(state => {
      for (const p of state.parents) {
        const t = p.tasks.find(x => x.id === task.id);
        if (t) { t.status = 'processing'; t.startedAt = startedAt; t.timeoutAt = timeoutAt; }
      }
    });
    const taskTarget = task.isVirtual ? `persona:${task.personaName}` : task.agentJid;
    console.log(`[DispatchBridge] Starting ${task.id}(${task.label}) → ${taskTarget}: "${task.prompt.slice(0, 50)}"`);

    if (task.isVirtual && task.personaName) {
      // 虚拟 agent 路径：通过 VirtualWorkerPool 非阻塞执行
      const persona = this.personaRegistry?.get(task.personaName);
      if (!persona || !this.virtualWorkerPool) {
        this.notifyTaskError(task.id, `Virtual agent setup error: persona "${task.personaName}" not available`);
        return;
      }
      // 虚拟任务不追踪 activeTasks（无 jid），由 VirtualWorkerPool.activeCounts 管理并发
      this.virtualWorkerPool.run(persona, augmented, parent.sharedWorkspace ?? process.cwd(), {
        timeout: effectiveTimeoutSeconds,
        taskId: task.id,
      })
        .then(r => this.notifyTaskDone(task.id, r.result))
        .catch(e => this.notifyTaskError(task.id, e.message));
    } else {
      // 持久 agent 路径
      this.addActiveTask(task.id, task.agentJid);
      try {
        this.sendToAgent(task.agentJid, task.id, augmented, parent.sharedWorkspace ?? '');
      } catch (err) {
        console.error(`[DispatchBridge] sendToAgent failed for ${task.agentJid}:`, err);
        // completeTask 内部完成 removeActiveTask + 后续调度 + workspace 还原检查
        this.notifyTaskError(task.id, `sendToAgent failed: ${err}`);
      }
    }
  }

  /**
   * 读取 admin agent 当前的工作目录（来自 workspace state 文件）。
   * 文件不存在或读取失败时返回空字符串（子 agent 保持自身目录）。
   */
  private readAdminWorkspace(adminFolder: string): string {
    try {
      const stateFile = path.join(config.paths.configHome, `workspace-state-${adminFolder}.json`);
      const raw = fs.readFileSync(stateFile, 'utf-8');
      return (JSON.parse(raw) as { currentDir?: string }).currentDir ?? '';
    } catch {
      return '';
    }
  }

  /**
   * 当某个 admin 的 active parent 完成时，激活其下一个 queued parent。
   * 激活时读取 admin 当前 workspace 并记录到 sharedWorkspace。
   */
  private activateNextQueued(adminFolder: string): void {
    let activated = false;
    this.modifyState(state => {
      const queued = state.parents
        .filter(p => p.status === 'queued' && p.adminFolder === adminFolder)
        .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
      if (queued.length === 0) return;
      const next = queued[0];
      next.status = 'active';
      next.sharedWorkspace = this.readAdminWorkspace(adminFolder);
      activated = true;
    });
    if (activated) {
      console.log(`[DispatchBridge] Activated next queued parent for admin: ${adminFolder}`);
    }
  }

  /** 清理已完成超过 1h 的 parent（连同子任务） */
  private cleanup(): void {
    const cutoff = Date.now() - 1 * 60 * 60 * 1000;
    this.modifyState(state => {
      state.parents = state.parents.filter(p =>
        !(p.status === 'done' && p.completedAt && new Date(p.completedAt).getTime() < cutoff)
      );
    });
  }

  // ===== File I/O with lock =====

  private readState(): DispatchState {
    try {
      return JSON.parse(fs.readFileSync(this.statePath, 'utf-8')) as DispatchState;
    } catch {
      return { _seq: 0, agents: [], parents: [] };
    }
  }

  private writeState(state: DispatchState): void {
    fs.mkdirSync(path.dirname(this.statePath), { recursive: true });
    fs.writeFileSync(this.statePath, JSON.stringify(state, null, 2), 'utf-8');
  }

  modifyState(fn: (state: DispatchState) => void): void {
    const lockPath = this.statePath + '.lock';
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
      // 50 次抢锁失败：检查锁文件里的 PID 是否还在运行。
      // 若进程已退出（崩溃遗留的 stale lock），才安全地强删后重新抢锁。
      // 若进程仍在运行，说明另一侧正常持锁，跳过本次修改（避免双持锁导致数据损坏）。
      let staleLock = false;
      try {
        const lockPid = parseInt(fs.readFileSync(lockPath, 'utf-8'), 10);
        if (!isNaN(lockPid) && lockPid !== process.pid) {
          try {
            process.kill(lockPid, 0); // signal 0 仅探测进程是否存在，不发送信号
            staleLock = false; // 进程存在，锁有效
          } catch {
            staleLock = true; // 进程不存在，stale lock
          }
        }
      } catch { /* ignore read error */ }

      if (staleLock) {
        try { fs.unlinkSync(lockPath); } catch { /* ignore */ }
        try {
          fs.writeFileSync(lockPath, String(process.pid), { flag: 'wx' });
          locked = true;
        } catch { /* ignore */ }
      }
    }
    if (!locked) {
      console.warn('[DispatchBridge] Failed to acquire state lock, skipping modification');
      return;
    }
    try {
      const state = this.readState();
      fn(state);
      this.writeState(state);
      this.wsNotify?.(state.parents);
    } finally {
      try { fs.unlinkSync(lockPath); } catch { /* ignore */ }
    }
  }
}
