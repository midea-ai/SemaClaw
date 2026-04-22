/**
 * WebSocketGateway — 本地 WebSocket 服务器
 *
 * 为 Web UI / CLI 工具提供实时事件流和双向交互。
 * 监听 127.0.0.1:{port}（默认 18789），不对外暴露。
 *
 * 客户端 → 服务端协议：
 *   { type: 'connect', token?: string }              — 认证（无 GATEWAY_TOKEN 时自动通过）
 *   { type: 'subscribe', groupJid: string }          — 订阅群组事件
 *   { type: 'unsubscribe', groupJid: string }        — 取消订阅
 *   { type: 'message', groupJid: string, text: string } — 向群组发消息（触发 Agent）
 *                                                         admin 客户端特殊命令（不走 Agent）：
 *                                                           list_tasks [folder] / task_logs <id> [n]
 *                                                           pause_task <id> / resume_task <id> / cancel_task <id>
 *                                                           del_task <id> / help
 *   { type: 'list:groups' }                          — 获取已注册群组列表
 *   { type: 'register:group', jid, folder, name, channel?, requiresTrigger?, allowedTools?, allowedWorkDirs?, botToken?, maxMessages? } — 注册/更新群组（admin 专用，同步 config.json）
 *   { type: 'unregister:group', jid }               — 注销群组（admin 专用，同步 config.json）
 *   { type: 'update:group', jid, ...fields }         — 更新群组字段（admin 专用，同步 config.json）
 *   { type: 'list:tasks', groupJid?: string }         — 查询任务列表（不传则返回所有）
 *   { type: 'list:task-logs', taskId: string, limit?: number } — 查询任务执行日志
 *   { type: 'manage:task', taskId: string, action: 'pause'|'resume'|'cancel' } — 管理任务
 *
 * 服务端 → 客户端协议：
 *   { type: 'auth:ok' }
 *   { type: 'auth:error', message: string }
 *   { type: 'subscribed', groupJid: string }
 *   { type: 'groups', groups: GroupInfo[] }
 *   { type: 'group:registered', group: GroupInfo }  — 广播给所有已认证客户端
 *   { type: 'group:unregistered', jid }             — 广播给所有已认证客户端
 *   { type: 'group:updated', group: GroupInfo }      — 广播给所有已认证客户端
 *   { type: 'incoming', groupJid, senderName, text, timestamp, isFromMe }
 *   { type: 'agent:reply', groupJid, text }
 *   { type: 'agent:state', groupJid, state }
 *   { type: 'permission:request', groupJid, requestId, toolName, title, content, options }
 *   { type: 'question:request', groupJid, requestId, agentId, questions }
 *   { type: 'permission:resolved', groupJid, requestId, optionKey, optionLabel }
 *   { type: 'question:resolved', groupJid, requestId, answers }
 *   { type: 'error', message: string }
 *
 * 客户端 → 服务端（权限决策）：
 *   { type: 'permission:response', requestId, optionKey }
 *   { type: 'question:response', requestId, answers: Record<number, number|number[]>, otherTexts?: Record<number,string> }
 */

import { WebSocketServer, WebSocket } from 'ws';
import type { IncomingMessage, ScheduledTask, TaskRunLog, GroupBinding } from '../types';
import { getTasksByGroup, getTaskRunLogs, listAllTasks, updateTaskStatus, getTaskById, advanceTaskNextRun } from '../db/db';
import { computeNextRunOnResume } from '../scheduler/TaskScheduler';
import { dispatchCommand } from './CommandDispatcher';
import type { GroupManager } from './GroupManager';
import { saveFeishuApp, deleteFeishuApp, getFeishuApps, saveQQApp, deleteQQApp, saveTelegramBot, deleteTelegramBot } from './GroupManager';
import type { AgentPool } from '../agent/AgentPool';
import type { GroupQueue } from '../agent/GroupQueue';
import type { TelegramChannel } from '../channels/telegram';
import type { QQChannel } from '../channels/qq';
import type { PermissionPayload, AskQuestionPayload } from '../agent/PermissionBridge';
import type { DispatchParent } from '../agent/DispatchBridge';

// ===== 内部类型 =====

interface WsClient {
  ws: WebSocket;
  authenticated: boolean;
  /** 已订阅任意 isAdmin 群组时为 true，解锁管理类直查命令 */
  isAdmin: boolean;
  subscriptions: Set<string>;
}

type OutboundMsg =
  | { type: 'auth:ok' }
  | { type: 'auth:error'; message: string }
  | { type: 'subscribed'; groupJid: string }
  | { type: 'groups'; groups: GroupInfo[] }
  | { type: 'group:registered'; group: GroupInfo }
  | { type: 'group:unregistered'; jid: string }
  | { type: 'group:updated'; group: GroupInfo }
  | { type: 'tasks'; tasks: ScheduledTask[]; groupJid?: string }
  | { type: 'task-logs'; taskId: string; logs: TaskRunLog[] }
  | { type: 'task:updated'; taskId: string; status: string }
  | { type: 'task:backlog'; taskId: string; chatJid: string; prompt: string; intervalMs: number; overdueMs: number; suggestedIntervalMs: number }
  | { type: 'incoming'; groupJid: string; senderName: string; text: string; timestamp: string; isFromMe: boolean }
  | { type: 'agent:reply'; groupJid: string; text: string }
  | { type: 'agent:state'; groupJid: string; state: string }
  | { type: 'agent:compacting'; groupJid: string; isCompacting: boolean }
  | { type: 'permission:request'; groupJid: string; requestId: string } & PermissionPayload
  | { type: 'question:request'; groupJid: string; requestId: string } & AskQuestionPayload
  | { type: 'permission:resolved'; groupJid: string; requestId: string; optionKey: string; optionLabel: string }
  | { type: 'question:resolved'; groupJid: string; requestId: string; answers: Record<string, string> }
  | { type: 'dispatch:update'; parents: DispatchParent[] }
  | { type: 'agent:todos'; agentJid: string; agentName: string; todos: { content: string; status: string; activeForm?: string }[] }
  | { type: 'feishu-app:registered'; appId: string }
  | { type: 'feishu-app:unregistered'; appId: string }
  | { type: 'feishu-apps'; apps: { appId: string; domain: string }[] }
  | { type: 'qq-app:registered'; appId: string }
  | { type: 'qq-app:unregistered'; appId: string }
  | { type: 'error'; message: string };

interface GroupInfo {
  jid: string;
  folder: string;
  name: string;
  isAdmin: boolean;
  channel: string;
  requiresTrigger: boolean;
  allowedTools: string[] | null;
  allowedWorkDirs: string[] | null;
  botToken: string | null;
  maxMessages: number | null;
}

// ===== 工具函数 =====

function toGroupInfo(g: GroupBinding): GroupInfo {
  return {
    jid: g.jid,
    folder: g.folder,
    name: g.name,
    isAdmin: g.isAdmin,
    channel: g.channel,
    requiresTrigger: g.requiresTrigger,
    allowedTools: g.allowedTools,
    allowedWorkDirs: g.allowedWorkDirs,
    botToken: g.botToken,
    maxMessages: g.maxMessages,
  };
}

// ===== WebSocketGateway =====

export class WebSocketGateway {
  private wss!: WebSocketServer;
  private clients = new Set<WsClient>();
  private readonly token: string | undefined;
  private readonly port: number;
  private telegramChannel: TelegramChannel | null = null;
  private qqChannel: QQChannel | null = null;
  private ensureFeishuChannelFn: (() => Promise<import('../types').IChannel | null>) | null = null;
  private getDispatchParents: (() => DispatchParent[]) | null = null;
  private getAgentTodos: (() => Map<string, { agentName: string; todos: { content: string; status: string; activeForm?: string }[] }>) | null = null;
  /** jid → 最后已知 agent state，subscribe/reconnect 时推送给新客户端 */
  private lastKnownStates = new Map<string, string>();

  constructor(
    private readonly groupManager: GroupManager,
    private readonly agentPool: AgentPool,
    private readonly groupQueue: GroupQueue,
    options?: { port?: number; token?: string },
  ) {
    this.port = options?.port ?? parseInt(process.env.GATEWAY_PORT ?? '18789', 10);
    this.token = options?.token ?? process.env.GATEWAY_TOKEN;
  }

  /** 注入 TelegramChannel，用于运行时注册新 bot token */
  setTelegramChannel(channel: TelegramChannel): void {
    this.telegramChannel = channel;
  }

  /** 注入 QQChannel，用于运行时热注册新 QQ app */
  setQQChannel(channel: QQChannel): void {
    this.qqChannel = channel;
  }

  /** 注入飞书懒建连函数，运行时注册 feishu 群组时按需连接 */
  setEnsureFeishuChannel(fn: () => Promise<import('../types').IChannel | null>): void {
    this.ensureFeishuChannelFn = fn;
  }

  start(): void {
    this.wss = new WebSocketServer({ host: '127.0.0.1', port: this.port });
    this.wss.on('error', (err: NodeJS.ErrnoException) => {
      if (err.code === 'EADDRINUSE') {
        console.error(`[WsGateway] Port ${this.port} already in use, WebSocket gateway disabled`);
      } else {
        console.error(`[WsGateway] Server error:`, err);
      }
    });
    this.wss.on('connection', (ws) => this.handleConnection(ws));
    console.log(`[WsGateway] Listening on 127.0.0.1:${this.port}`);
  }

  stop(): Promise<void> {
    return new Promise((resolve) => {
      for (const client of this.clients) {
        client.ws.terminate();
      }
      this.clients.clear();
      if (this.wss) {
        this.wss.close(() => resolve());
      } else {
        resolve();
      }
    });
  }

  // ===== 事件注入（由外部调用） =====

  /** MessageRouter 收到用户消息时调用 */
  notifyIncoming(msg: IncomingMessage): void {
    this.broadcast(msg.chatJid, {
      type: 'incoming',
      groupJid: msg.chatJid,
      senderName: msg.senderName,
      text: msg.content,
      timestamp: msg.timestamp,
      isFromMe: msg.isFromMe,
    });
  }

  /** AgentPool 中 message:complete 时调用 */
  notifyAgentReply(chatJid: string, text: string): void {
    this.broadcast(chatJid, { type: 'agent:reply', groupJid: chatJid, text });
  }

  /** AgentPool 中 state:update 时调用 */
  notifyAgentState(chatJid: string, state: string): void {
    this.lastKnownStates.set(chatJid, state);
    this.broadcast(chatJid, { type: 'agent:state', groupJid: chatJid, state });
  }

  /** compact:start / compact:exec 时调用，通知前端 compacting 状态变化 */
  notifyAgentCompacting(chatJid: string, isCompacting: boolean): void {
    this.broadcast(chatJid, { type: 'agent:compacting', groupJid: chatJid, isCompacting });
  }

  /** PermissionBridge 权限请求时调用 */
  notifyPermissionRequest(chatJid: string, requestId: string, payload: PermissionPayload): void {
    const msg: OutboundMsg = {
      type: 'permission:request',
      groupJid: chatJid,
      requestId,
      ...payload,
    };
    // 虚拟 agent (virtual:xxx) 没有订阅者，广播给所有 admin 客户端
    if (chatJid.startsWith('virtual:')) {
      this.broadcastToAdmins(msg);
    } else {
      this.broadcast(chatJid, msg);
    }
  }

  /**
   * TaskScheduler 检测到 interval 任务积压时调用。
   * 广播给所有已认证的 admin 客户端（不限订阅）。
   */
  notifyTaskBacklog(taskId: string, chatJid: string, prompt: string, intervalMs: number, overdueMs: number): void {
    const suggestedIntervalMs = intervalMs + overdueMs;
    const msg: OutboundMsg = { type: 'task:backlog', taskId, chatJid, prompt, intervalMs, overdueMs, suggestedIntervalMs };
    this.broadcastToAdmins(msg);
  }

  /** PermissionBridge 问答请求时调用 */
  notifyAskQuestionRequest(chatJid: string, requestId: string, payload: AskQuestionPayload): void {
    this.broadcast(chatJid, {
      type: 'question:request',
      groupJid: chatJid,
      requestId,
      ...payload,
    });
  }

  /** PermissionBridge 权限决策后调用，广播给订阅该群组的所有客户端 */
  notifyPermissionResolved(chatJid: string, requestId: string, optionKey: string, optionLabel: string): void {
    const msg: OutboundMsg = {
      type: 'permission:resolved',
      groupJid: chatJid,
      requestId,
      optionKey,
      optionLabel,
    };
    if (chatJid.startsWith('virtual:')) {
      this.broadcastToAdmins(msg);
    } else {
      this.broadcast(chatJid, msg);
    }
  }

  /** PermissionBridge 问答决策后调用，广播给订阅该群组的所有客户端 */
  notifyAskQuestionResolved(chatJid: string, requestId: string, answers: Record<string, string>): void {
    this.broadcast(chatJid, {
      type: 'question:resolved',
      groupJid: chatJid,
      requestId,
      answers,
    });
  }

  /** DispatchBridge state 变化时调用，推送给所有 admin 客户端 */
  notifyDispatchUpdate(parents: DispatchParent[]): void {
    this.broadcastToAdmins({ type: 'dispatch:update', parents });
  }

  /** AgentPool todos:update 时调用，推送给所有 admin 客户端 */
  notifyAgentTodos(agentJid: string, agentName: string, todos: { content: string; status: string; activeForm?: string }[]): void {
    this.broadcastToAdmins({ type: 'agent:todos', agentJid, agentName, todos });
  }

  /**
   * 飞书 pending 绑定完成时调用：
   * 先广播 group:unregistered 移除旧 pending 条目，再广播 group:registered 添加新条目。
   */
  notifyGroupMigrated(oldJid: string, newBinding: GroupBinding): void {
    this.broadcastToAll({ type: 'group:unregistered', jid: oldJid });
    this.broadcastToAll({ type: 'group:registered', group: toGroupInfo(newBinding) });
  }

  /** 注入 DispatchBridge 当前 parents 获取函数，用于新 admin 客户端连接时初始推送 */
  setDispatchBridgeGetter(fn: () => DispatchParent[]): void {
    this.getDispatchParents = fn;
  }

  /** 注入 AgentPool 当前 todos 获取函数，用于新 admin 客户端连接时初始推送 */
  setAgentTodosGetter(fn: () => Map<string, { agentName: string; todos: { content: string; status: string; activeForm?: string }[] }>): void {
    this.getAgentTodos = fn;
  }

  // ===== 内部实现 =====

  private broadcastToAdmins(msg: OutboundMsg): void {
    const raw = JSON.stringify(msg);
    for (const client of this.clients) {
      if (client.authenticated && client.isAdmin && client.ws.readyState === WebSocket.OPEN) {
        client.ws.send(raw);
      }
    }
  }

  /** 群组注册/更新/删除事件广播给所有已认证客户端 */
  private broadcastToAll(msg: OutboundMsg): void {
    const raw = JSON.stringify(msg);
    for (const client of this.clients) {
      if (client.authenticated && client.ws.readyState === WebSocket.OPEN) {
        client.ws.send(raw);
      }
    }
  }

  private broadcast(groupJid: string, msg: OutboundMsg): void {
    const raw = JSON.stringify(msg);
    for (const client of this.clients) {
      if (client.authenticated && client.subscriptions.has(groupJid)) {
        if (client.ws.readyState === WebSocket.OPEN) {
          client.ws.send(raw);
        }
      }
    }
  }

  private send(client: WsClient, msg: OutboundMsg): void {
    if (client.ws.readyState === WebSocket.OPEN) {
      client.ws.send(JSON.stringify(msg));
    }
  }

  private handleConnection(ws: WebSocket): void {
    const client: WsClient = { ws, authenticated: false, isAdmin: false, subscriptions: new Set() };
    this.clients.add(client);

    ws.on('message', (raw) => {
      try {
        const msg = JSON.parse(raw.toString()) as Record<string, unknown>;
        this.handleMessage(client, msg);
      } catch {
        this.send(client, { type: 'error', message: 'Invalid JSON' });
      }
    });

    ws.on('close', () => this.clients.delete(client));
    ws.on('error', (err) => {
      console.error('[WsGateway] Client error:', err.message);
    });

    // 无 token 配置时自动认证（本地开发）
    if (!this.token) {
      console.warn('[WsGateway] GATEWAY_TOKEN not set — client auto-authenticated. Set GATEWAY_TOKEN in .env for production.');
      client.authenticated = true;
      this.send(client, { type: 'auth:ok' });
    }
  }

  private async handleMessage(client: WsClient, msg: Record<string, unknown>): Promise<void> {
    switch (msg.type) {
      case 'connect': {
        if (this.token && msg.token !== this.token) {
          this.send(client, { type: 'auth:error', message: 'Invalid token' });
          return;
        }
        client.authenticated = true;
        this.send(client, { type: 'auth:ok' });
        return;
      }

      case 'subscribe': {
        if (!this.requireAuth(client)) return;
        const jid = String(msg.groupJid ?? '');
        if (!jid) {
          this.send(client, { type: 'error', message: 'groupJid required' });
          return;
        }
        client.subscriptions.add(jid);
        // 订阅 admin 群组时提升为 admin 客户端，解锁管理类直查命令
        const group = this.groupManager.get(jid);
        if (group?.isAdmin) client.isAdmin = true;
        // 订阅 admin 群组时，推送当前 dispatch state + agent todos 供初始化
        if (group?.isAdmin && this.getDispatchParents) {
          this.send(client, { type: 'dispatch:update', parents: this.getDispatchParents() });
        }
        if (group?.isAdmin && this.getAgentTodos) {
          for (const [agentJid, entry] of this.getAgentTodos()) {
            this.send(client, { type: 'agent:todos', agentJid, agentName: entry.agentName, todos: entry.todos });
          }
        }
        // 推送当前已知 agent state（重连/首次订阅时修正前端 stale state）
        const knownState = this.lastKnownStates.get(jid);
        if (knownState) {
          this.send(client, { type: 'agent:state', groupJid: jid, state: knownState });
        }
        this.send(client, { type: 'subscribed', groupJid: jid });
        return;
      }

      case 'unsubscribe': {
        if (!this.requireAuth(client)) return;
        const jid = String(msg.groupJid ?? '');
        client.subscriptions.delete(jid);
        return;
      }

      case 'list:groups': {
        if (!this.requireAuth(client)) return;
        const groups: GroupInfo[] = this.groupManager.list().map(toGroupInfo);
        this.send(client, { type: 'groups', groups });
        return;
      }

      case 'register:group': {
        if (!this.requireAuth(client)) return;
        if (!this.requireAdmin(client)) return;
        const { folder, name, channel, requiresTrigger, allowedTools, allowedWorkDirs, botToken, maxMessages } = msg as Record<string, unknown>;
        let { jid } = msg as Record<string, unknown>;
        if (!folder || !name) {
          this.send(client, { type: 'error', message: 'folder and name are required' });
          return;
        }
        // 飞书 channel 允许空 JID：存为 feishu:pending:{appId}（首条消息后自动完成绑定）
        if (!jid && channel === 'feishu') {
          const appId = botToken ? String(botToken).trim() : '';
          if (!appId) {
            this.send(client, { type: 'error', message: 'feishu:pending 绑定需要提供 App ID (botToken)' });
            return;
          }
          jid = `feishu:pending:${appId}`;
        }
        // QQ channel 允许空 JID：存为 qq:pending:{appId}（首条消息后自动完成绑定）
        if (!jid && channel === 'qq') {
          const appId = botToken ? String(botToken).trim() : '';
          if (!appId) {
            this.send(client, { type: 'error', message: 'qq:pending 绑定需要提供 App ID (botToken)' });
            return;
          }
          jid = `qq:pending:${appId}`;
        }
        if (!jid) {
          this.send(client, { type: 'error', message: 'jid is required (or leave empty for feishu/qq pending binding)' });
          return;
        }
        try {
          const now = new Date().toISOString();
          let resolvedJid = String(jid);
          const resolvedFolder = String(folder);
          const resolvedName = String(name);
          const resolvedChannel = channel !== undefined ? String(channel) : '';
          const resolvedToken = botToken ? String(botToken) : null;

          // Telegram: await addBot so we can get botUserId for a bot-aware JID
          if (resolvedChannel === 'telegram' && resolvedToken && this.telegramChannel) {
            await this.telegramChannel.addBot(resolvedToken);
            const botUserId = this.telegramChannel.getBotUserId(resolvedToken);
            // Upgrade bare tg:user:{id} → tg:{botUserId}:user:{id}
            const m = resolvedJid.match(/^tg:(user|group):(-?\d+)$/);
            if (m && botUserId) resolvedJid = `tg:${botUserId}:${m[1]}:${m[2]}`;
            // Persist to config.json so the binding survives restart
            const chatIdMatch = resolvedJid.match(/^tg:(?:\d+:)?user:(\d+)$/);
            if (chatIdMatch) {
              saveTelegramBot({ token: resolvedToken, adminUserId: chatIdMatch[1], folder: resolvedFolder, name: resolvedName });
            }
          }

          const existing = this.groupManager.get(resolvedJid);
          const binding = {
            jid: resolvedJid,
            folder: resolvedFolder,
            name: resolvedName,
            channel: resolvedChannel || (existing?.channel ?? ''),
            isAdmin: false as const,
            requiresTrigger: typeof requiresTrigger === 'boolean' ? requiresTrigger : (existing?.requiresTrigger ?? true),
            allowedTools: allowedTools !== undefined ? (allowedTools as string[] | null) : (existing?.allowedTools ?? null),
            allowedPaths: null,
            allowedWorkDirs: allowedWorkDirs !== undefined ? (allowedWorkDirs as string[] | null) : (existing?.allowedWorkDirs ?? null),
            botToken: resolvedToken ?? (existing?.botToken ?? null),
            maxMessages: maxMessages !== undefined ? (maxMessages as number | null) : (existing?.maxMessages ?? null),
            lastActive: existing?.lastActive ?? null,
            addedAt: existing?.addedAt ?? now,
          };
          this.groupManager.register(binding);
          // Telegram group bindings (no dedicated bot token): fire-and-forget addBot with default token
          if (resolvedChannel === 'telegram' && !resolvedToken && binding.botToken && this.telegramChannel) {
            this.telegramChannel.addBot(binding.botToken).catch((err: unknown) =>
              console.error('[WsGateway] Failed to register bot token:', err)
            );
          }
          // Feishu 群组注册时触发懒建连
          if (binding.jid.startsWith('feishu:') && this.ensureFeishuChannelFn) {
            this.ensureFeishuChannelFn().catch((err: unknown) =>
              console.error('[WsGateway] Failed to ensure FeishuChannel:', err)
            );
          }
          const info = toGroupInfo(binding);
          this.broadcastToAll({ type: 'group:registered', group: info });
        } catch (err) {
          this.send(client, { type: 'error', message: `register:group failed: ${err}` });
        }
        return;
      }

      case 'unregister:group': {
        if (!this.requireAuth(client)) return;
        if (!this.requireAdmin(client)) return;
        const jid = String(msg.jid ?? '');
        if (!jid) {
          this.send(client, { type: 'error', message: 'jid required' });
          return;
        }
        const group = this.groupManager.get(jid);
        if (!group) {
          this.send(client, { type: 'error', message: `Group not found: ${jid}` });
          return;
        }
        if (group.isAdmin) {
          this.send(client, { type: 'error', message: 'Cannot unregister admin group' });
          return;
        }
        // Telegram user binding with a dedicated bot token → also remove from config.json
        if (group.channel === 'telegram' && group.botToken && /^tg:(?:\d+:)?user:/.test(group.jid)) {
          deleteTelegramBot(group.botToken);
        }
        // Feishu: if no other group uses this appId, also remove from feishuApps config
        if (group.channel === 'feishu' && group.botToken) {
          const appId = group.botToken;
          const stillUsed = this.groupManager.list().some(
            (g: import('../types').GroupBinding) => g.jid !== jid && g.channel === 'feishu' && g.botToken === appId,
          );
          if (!stillUsed) deleteFeishuApp(appId);
        }
        // QQ: if no other group uses this appId, also remove from qqApps config
        if (group.channel === 'qq' && group.botToken) {
          const appId = group.botToken;
          const stillUsed = this.groupManager.list().some(
            (g: import('../types').GroupBinding) => g.jid !== jid && g.channel === 'qq' && g.botToken === appId,
          );
          if (!stillUsed) deleteQQApp(appId);
        }
        this.groupManager.unregister(jid);
        this.broadcastToAll({ type: 'group:unregistered', jid });
        return;
      }

      case 'update:group': {
        if (!this.requireAuth(client)) return;
        if (!this.requireAdmin(client)) return;
        const jid = String(msg.jid ?? '');
        if (!jid) {
          this.send(client, { type: 'error', message: 'jid required' });
          return;
        }
        try {
          const { name, channel, requiresTrigger, allowedTools, allowedWorkDirs, botToken, maxMessages } = msg as Record<string, unknown>;
          const updates: Record<string, unknown> = {};
          if (name !== undefined) updates.name = String(name);
          if (channel !== undefined) updates.channel = String(channel);
          if (requiresTrigger !== undefined) updates.requiresTrigger = Boolean(requiresTrigger);
          if (allowedTools !== undefined) updates.allowedTools = allowedTools as string[] | null;
          if (allowedWorkDirs !== undefined) updates.allowedWorkDirs = allowedWorkDirs as string[] | null;
          if (botToken !== undefined) updates.botToken = botToken as string | null;
          if (maxMessages !== undefined) updates.maxMessages = maxMessages as number | null;
          const updated = this.groupManager.update(jid, updates);
          this.broadcastToAll({ type: 'group:updated', group: toGroupInfo(updated) });
        } catch (err) {
          this.send(client, { type: 'error', message: `update:group failed: ${err}` });
        }
        return;
      }

      // ===== 飞书应用管理 =====

      case 'register:feishu-app': {
        if (!this.requireAuth(client)) return;
        if (!this.requireAdmin(client)) return;
        const { appId, appSecret, domain } = msg as Record<string, unknown>;
        if (!appId || !appSecret) {
          this.send(client, { type: 'error', message: 'appId and appSecret required' });
          return;
        }
        try {
          saveFeishuApp(String(appId), String(appSecret), domain ? String(domain) : undefined);
          // 运行时注册到 FeishuChannel（如已建连）
          if (this.ensureFeishuChannelFn) {
            const ch = await this.ensureFeishuChannelFn();
            if (ch && 'addApp' in ch) {
              const ok = await (ch as any).addApp(String(appId), String(appSecret), domain ? String(domain) : undefined);
              if (ok === false) {
                this.send(client, { type: 'error', message: `飞书应用 ${appId} 连接失败：凭证无效或网络不通，请检查 App ID / App Secret 是否正确，以及飞书应用是否已发布。` });
                return;
              }
            }
          }
          this.send(client, { type: 'feishu-app:registered', appId: String(appId) });
        } catch (err) {
          this.send(client, { type: 'error', message: `register:feishu-app failed: ${err}` });
        }
        return;
      }

      case 'unregister:feishu-app': {
        if (!this.requireAuth(client)) return;
        if (!this.requireAdmin(client)) return;
        const appId = String((msg as Record<string, unknown>).appId ?? '');
        if (!appId) {
          this.send(client, { type: 'error', message: 'appId required' });
          return;
        }
        try {
          deleteFeishuApp(appId);
          this.send(client, { type: 'feishu-app:unregistered', appId });
        } catch (err) {
          this.send(client, { type: 'error', message: `unregister:feishu-app failed: ${err}` });
        }
        return;
      }

      // ===== QQ 应用管理 =====

      case 'register:qq-app': {
        if (!this.requireAuth(client)) return;
        if (!this.requireAdmin(client)) return;
        const { appId, appSecret, sandbox } = msg as Record<string, unknown>;
        if (!appId || !appSecret) {
          this.send(client, { type: 'error', message: 'appId and appSecret required' });
          return;
        }
        try {
          const sandboxBool = sandbox === true;
          saveQQApp(String(appId), String(appSecret), sandboxBool || undefined);
          // 运行时热注册到 QQChannel（如已建连）
          if (this.qqChannel) {
            this.qqChannel.addApp(String(appId), String(appSecret), sandboxBool);
          }
          this.send(client, { type: 'qq-app:registered', appId: String(appId) });
        } catch (err) {
          this.send(client, { type: 'error', message: `register:qq-app failed: ${err}` });
        }
        return;
      }

      case 'unregister:qq-app': {
        if (!this.requireAuth(client)) return;
        if (!this.requireAdmin(client)) return;
        const appId = String((msg as Record<string, unknown>).appId ?? '');
        if (!appId) {
          this.send(client, { type: 'error', message: 'appId required' });
          return;
        }
        try {
          deleteQQApp(appId);
          this.send(client, { type: 'qq-app:unregistered', appId });
        } catch (err) {
          this.send(client, { type: 'error', message: `unregister:qq-app failed: ${err}` });
        }
        return;
      }

      case 'list:feishu-apps': {
        if (!this.requireAuth(client)) return;
        const apps = getFeishuApps();
        // 不泄露 appSecret，只返回 appId 列表和 domain
        const list = Object.entries(apps).map(([appId, cfg]) => ({
          appId,
          domain: cfg.domain ?? 'feishu',
        }));
        this.send(client, { type: 'feishu-apps', apps: list });
        return;
      }

      case 'message': {
        if (!this.requireAuth(client)) return;
        const groupJid = String(msg.groupJid ?? '');
        const text = String(msg.text ?? '').trim();
        if (!groupJid || !text) {
          this.send(client, { type: 'error', message: 'groupJid and text required' });
          return;
        }
        // 命令拦截：admin 客户端输入匹配的命令格式直接处理，不进 agent
        if (this.tryHandleCommand(client, groupJid, text)) return;
        // pending 绑定尚未完成，拒绝发消息
        if (groupJid.includes(':pending:')) {
          const ch = groupJid.startsWith('qq:') ? 'QQ' : '飞书';
          this.send(client, { type: 'error', message: `${ch} 绑定尚未完成，请先从 ${ch} 发送第一条消息以完成 JID 绑定。` });
          return;
        }
        const group = this.groupManager.get(groupJid);
        if (!group) {
          this.send(client, { type: 'error', message: `Group not found: ${groupJid}` });
          return;
        }
        this.groupQueue.enqueue(groupJid, () =>
          this.agentPool.processAndWait(groupJid, group, text)
        );
        return;
      }

      case 'permission:response': {
        if (!this.requireAuth(client)) return;
        const requestId = String(msg.requestId ?? '');
        const optionKey = String(msg.optionKey ?? '');
        if (!requestId || !optionKey) {
          this.send(client, { type: 'error', message: 'requestId and optionKey required' });
          return;
        }
        this.agentPool.resolvePermission(requestId, optionKey);
        return;
      }

      case 'question:response': {
        if (!this.requireAuth(client)) return;
        const requestId  = String(msg.requestId ?? '');
        const answers    = msg.answers as Record<number, number | number[]>;
        const otherTexts = (msg.otherTexts as Record<number, string>) ?? undefined;
        if (!requestId || !answers) {
          this.send(client, { type: 'error', message: 'requestId and answers required' });
          return;
        }
        this.agentPool.resolveAskQuestionBatch(requestId, answers, otherTexts);
        return;
      }

      case 'list:tasks': {
        if (!this.requireAuth(client)) return;
        if (!this.requireAdmin(client)) return;
        const jid = msg.groupJid ? String(msg.groupJid) : undefined;
        let tasks: ScheduledTask[];
        if (jid) {
          const group = this.groupManager.get(jid);
          if (!group) {
            this.send(client, { type: 'error', message: `Group not found: ${jid}` });
            return;
          }
          tasks = getTasksByGroup(group.folder);
        } else {
          tasks = listAllTasks();
        }
        this.send(client, { type: 'tasks', tasks, groupJid: jid });
        return;
      }

      case 'list:task-logs': {
        if (!this.requireAuth(client)) return;
        if (!this.requireAdmin(client)) return;
        const taskId = String(msg.taskId ?? '');
        if (!taskId) {
          this.send(client, { type: 'error', message: 'taskId required' });
          return;
        }
        const limit = typeof msg.limit === 'number' ? msg.limit : 20;
        const logs = getTaskRunLogs(taskId, limit);
        this.send(client, { type: 'task-logs', taskId, logs });
        return;
      }

      case 'manage:task': {
        if (!this.requireAuth(client)) return;
        if (!this.requireAdmin(client)) return;
        const taskId = String(msg.taskId ?? '');
        const action = String(msg.action ?? '');
        if (!taskId || !action) {
          this.send(client, { type: 'error', message: 'taskId and action required' });
          return;
        }

        // resume 需要同时重置 next_run，避免沿用暂停前已过期的时间导致追赶风暴
        if (action === 'resume') {
          const task = getTaskById(taskId);
          if (!task) {
            this.send(client, { type: 'error', message: `Task not found: ${taskId}` });
            return;
          }
          if (task.scheduleType === 'once') {
            this.send(client, {
              type: 'error',
              message: 'One-time tasks cannot be resumed. Cancel this task and create a new one instead.',
            });
            return;
          }
          advanceTaskNextRun(task.id, computeNextRunOnResume(task), 'active');
          this.send(client, { type: 'task:updated', taskId, status: 'active' });
          return;
        }

        let newStatus: ScheduledTask['status'];
        switch (action) {
          case 'pause':  newStatus = 'paused';    break;
          case 'cancel': newStatus = 'completed'; break;
          default:
            this.send(client, { type: 'error', message: `Unknown action: ${action}` });
            return;
        }
        updateTaskStatus(taskId, newStatus);
        this.send(client, { type: 'task:updated', taskId, status: newStatus });
        return;
      }

      case 'list:dispatch': {
        if (!this.requireAuth(client)) return;
        if (!this.requireAdmin(client)) return;
        const parents = this.getDispatchParents?.() ?? [];
        this.send(client, { type: 'dispatch:update', parents });
        return;
      }

      case 'agent:control': {
        if (!this.requireAuth(client)) return;
        if (!this.requireAdmin(client)) return;
        const groupJid = String(msg.groupJid ?? '');
        const action = String(msg.action ?? '');
        if (!groupJid || !action) {
          this.send(client, { type: 'error', message: 'groupJid and action required' });
          return;
        }
        const group = this.groupManager.get(groupJid);
        if (!group) {
          this.send(client, { type: 'error', message: `Group not found: ${groupJid}` });
          return;
        }
        switch (action) {
          case 'pause':
            this.agentPool.pauseAgent(groupJid);
            break;
          case 'resume': {
            const query = msg.query ? String(msg.query) : undefined;
            this.agentPool.resumeAgent(groupJid, query);
            break;
          }
          case 'stop':
            this.agentPool.stopAgent(groupJid).catch((err) =>
              console.error(`[WsGateway] stopAgent failed for ${groupJid}:`, err)
            );
            break;
          default:
            this.send(client, { type: 'error', message: `Unknown agent:control action: ${action}` });
        }
        return;
      }

      default:
        this.send(client, { type: 'error', message: `Unknown message type: ${msg.type}` });
    }
  }

  // ===== 命令拦截（admin 客户端专用，逻辑由 CommandDispatcher 统一维护） =====

  /** 尝试拦截并处理命令，返回 true 表示已处理（不进 agent） */
  private tryHandleCommand(client: WsClient, groupJid: string, text: string): boolean {
    if (!client.isAdmin) return false;
    const result = dispatchCommand(text);
    if (result === null) return false;
    this.send(client, { type: 'agent:reply', groupJid, text: result });
    return true;
  }

  private requireAuth(client: WsClient): boolean {
    if (!client.authenticated) {
      this.send(client, { type: 'error', message: 'Not authenticated' });
      return false;
    }
    return true;
  }

  private requireAdmin(client: WsClient): boolean {
    if (!client.isAdmin) {
      this.send(client, { type: 'error', message: 'Admin subscription required' });
      return false;
    }
    return true;
  }
}
