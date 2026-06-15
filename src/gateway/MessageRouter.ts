/**
 * MessageRouter — 消息路由中枢
 *
 * 职责：
 *   1. 接收来自 IChannel 的 IncomingMessage
 *   2. 查找 GroupBinding（未注册的聊天直接忽略）
 *   3. 持久化消息到 SQLite
 *   4. TriggerChecker 判断是否触发 Agent
 *   5. 构造 prompt（SessionBridge），提交到 GroupQueue
 *
 * 生命周期：
 *   - 由 index.ts 构造，注入 GroupManager + AgentPool + GroupQueue + IChannel[]
 *   - 调用 start() 注册 channel.onMessage handler
 */

import { IncomingMessage, IChannel, GroupBinding } from '../types';
import { GroupManager, ensureWechatAdminGroup } from './GroupManager';
import { shouldTrigger } from './TriggerChecker';
import { AgentPool } from '../agent/AgentPool';
import { GroupQueue } from '../agent/GroupQueue';
import { buildPromptForGroup } from '../agent/SessionBridge';
import { insertMessage, setLastAgentTimestamp } from '../db/db';
import { dispatchCommand, dispatchSessionCommand } from './CommandDispatcher';

/** WsGateway incoming 通知接口（解耦） */
interface IncomingNotifier {
  notifyIncoming(msg: IncomingMessage): void;
}

export class MessageRouter {
  private wsGateway: IncomingNotifier | null = null;
  /** 已发过未注册提示的 JID（每个 JID 运行期间只提示一次） */
  private notifiedJids = new Set<string>();
  private onJidMigratedCb: ((oldJid: string, newBinding: GroupBinding) => void) | null = null;

  constructor(
    private readonly groupManager: GroupManager,
    private readonly agentPool: AgentPool,
    private readonly groupQueue: GroupQueue,
    private readonly channels: IChannel[],
    private readonly wechatAgentFolder: string = 'main',
  ) {}

  setWsGateway(gw: IncomingNotifier): void {
    this.wsGateway = gw;
  }

  /** JID 迁移回调（飞书 pending 绑定完成时通知 WsGateway 更新 Web UI） */
  setOnJidMigrated(cb: (oldJid: string, newBinding: GroupBinding) => void): void {
    this.onJidMigratedCb = cb;
  }

  /**
   * 注册所有 channel 的消息监听。
   * 应在 channel.connect() 之后调用。
   */
  start(): void {
    for (const channel of this.channels) {
      // handleIncoming 现在是 async（dispatchSessionCommand 需要 await）。
      // channel onMessage 不感知 Promise，挂个 .catch 防止 unhandledRejection。
      channel.onMessage((msg) =>
        this.handleIncoming(msg).catch((err) => {
          console.error(`[MessageRouter] handleIncoming failed for ${msg.chatJid}:`, err);
        }),
      );
    }
  }

  // ===== Internal =====

  private async handleIncoming(msg: IncomingMessage): Promise<void> {
    console.log(`[MessageRouter] Incoming msg from ${msg.chatJid} (${msg.chatType}): "${msg.content.slice(0, 60)}"`);

    // 1. 查找已注册的群组绑定
    let group = this.groupManager.get(msg.chatJid);
    if (!group) {
      // 微信频道：优先尝试 pending 绑定迁移（CLI 多 bot 模式），
      // 再 fallback 到 ensureWechatAdminGroup（env-only 单 bot 模式）
      if (msg.chatJid.startsWith('wx:')) {
        if (msg.botToken) {
          group = this.completePendingWechatBinding(msg) ?? null;
        }
        if (!group) {
          ensureWechatAdminGroup(this.groupManager, msg.chatJid, this.wechatAgentFolder);
          group = this.groupManager.get(msg.chatJid);
        }
      }
      // 飞书 pending 绑定：自动完成 JID 迁移，迁移成功后继续处理本条消息
      if (!group && msg.chatJid.startsWith('feishu:')) {
        group = this.completePendingFeishuBinding(msg) ?? null;
      }
      // QQ pending 绑定：自动完成 JID 迁移，迁移成功后继续处理本条消息
      if (!group && msg.chatJid.startsWith('qq:')) {
        group = this.completePendingQQBinding(msg) ?? null;
      }
      if (!group) {
        console.log(`[MessageRouter] No registered group for ${msg.chatJid}, ignoring`);
        this.notifyUnregisteredFeishu(msg);
        return;
      }
    }

    // 2. 持久化消息
    this.storeMessage(msg);

    // 3a. 转发到 WsGateway（订阅了该群组的 Web UI 客户端实时可见）
    this.wsGateway?.notifyIncoming(msg);

    // 3. 触发检查
    if (!shouldTrigger(msg, group)) {
      console.log(`[MessageRouter] Trigger check failed for ${msg.chatJid} (isAdmin=${group.isAdmin}, requiresTrigger=${group.requiresTrigger}, mentionsBotUsername=${msg.mentionsBotUsername})`);
      return;
    }

    // 4a. 会话管理命令（所有 agent 群组可用：list_sessions / resume_session / new_session）
    //     置于 isAdmin 任务命令之前，确保任何 agent 都能管理自己的会话。
    const sessionResult = await dispatchSessionCommand(msg.content, {
      group,
      agentPool: this.agentPool,
    });
    if (sessionResult !== null) {
      console.log(`[MessageRouter] Session command handled for ${msg.chatJid}`);
      this.agentPool.broadcastReply(msg.chatJid, sessionResult, group.botToken ?? undefined);
      return;
    }

    // 4b. isAdmin 群组：任务管理命令（直接执行，不走 Agent）
    if (group.isAdmin) {
      const result = dispatchCommand(msg.content);
      if (result !== null) {
        console.log(`[MessageRouter] Command handled directly for ${msg.chatJid}`);
        this.agentPool.broadcastReply(msg.chatJid, result, group.botToken ?? undefined);
        return;
      }
    }

    console.log(`[MessageRouter] Triggering agent for ${msg.chatJid}`);

    // 5. 更新群组活跃时间
    this.groupManager.touchActive(msg.chatJid);

    // 6. 构建 prompt 并入队
    this.groupQueue.enqueue(msg.chatJid, () =>
      this.runAgent(msg.chatJid, group)
    );
  }

  private async runAgent(jid: string, group: GroupBinding): Promise<void> {
    // 在 build prompt 之前记录时间戳，用于捞取处理期间新到的消息
    const promptBuiltAt = new Date().toISOString();

    // 从 DB 拉取自上次 Agent 响应以来的新消息，格式化为 XML
    const { prompt, lastMsgTimestamp } = buildPromptForGroup(jid);

    if (!prompt) {
      // 没有新消息（极少见，竞态情况）
      console.warn(`[MessageRouter] Empty prompt for ${jid}, skipping`);
      return;
    }

    // 游标取 max(promptBuiltAt, 最后一条已处理消息的timestamp)：
    // - promptBuiltAt 保证处理期间新到的消息（timestamp > promptBuiltAt）下轮能被捞到
    // - lastMsgTimestamp 防止消息的客户端时钟比服务器快导致游标偏早、同一条消息被重复拉取
    const cursor = lastMsgTimestamp && lastMsgTimestamp > promptBuiltAt
      ? lastMsgTimestamp
      : promptBuiltAt;
    try {
      await this.agentPool.processAndWait(jid, group, prompt);
    } catch (err) {
      console.error(`[MessageRouter] Agent error for ${jid}:`, err);
    } finally {
      // 无论成功、失败（权限超时/API报错）还是用户主动 terminate，
      // 都推进游标，防止同一批消息在下轮被重复拉取
      setLastAgentTimestamp(jid, cursor);
    }
  }

  /**
   * DispatchBridge 调用：将 prompt 直接发给目标 agent（不经过 channel/trigger 检查）。
   * onStarted 在队列回调真正开始执行时触发（非入队时）；
   * onCompleted(error) 在执行结束后触发，是任务完成归因的唯一事实来源——
   * 成功时 error 为 undefined，失败（超时/会话错误/被 stop）时携带错误。
   */
  dispatchTask(jid: string, prompt: string, callbacks?: { onStarted?: () => void; onCompleted?: (error?: Error) => void }): void {
    const group = this.groupManager.get(jid);
    if (!group) {
      console.warn(`[MessageRouter] dispatchTask: no group for ${jid}`);
      // 直接报告失败，避免任务永久卡在 processing 直到超时
      callbacks?.onCompleted?.(new Error(`No group bound for agent ${jid}`));
      return;
    }
    this.groupManager.touchActive(jid);
    this.groupQueue.enqueue(jid, async () => {
      callbacks?.onStarted?.();
      let error: Error | undefined;
      try {
        await this.agentPool.processAndWait(jid, group, prompt);
      } catch (err) {
        console.error(`[MessageRouter] dispatchTask agent error for ${jid}:`, err);
        error = err instanceof Error ? err : new Error(String(err));
      }
      callbacks?.onCompleted?.(error);
    });
  }

  /**
   * 尝试完成飞书 pending 绑定（feishu:pending:{appId} → 真实 JID）。
   * 迁移成功返回新 GroupBinding（调用方可继续处理该消息），失败返回 null。
   */
  private completePendingFeishuBinding(msg: IncomingMessage): GroupBinding | undefined {
    const appId = msg.botToken ?? '';
    if (!appId) return undefined;
    const pending = this.groupManager.findPendingFeishuBinding(appId);
    if (!pending) return undefined;

    const oldJid = pending.jid;
    const newBinding = this.groupManager.migrateJid(oldJid, msg.chatJid);
    if (!newBinding) return undefined;

    console.log(`[MessageRouter] Feishu pending binding completed: ${oldJid} → ${msg.chatJid}`);
    // 清理 pending JID 对应的旧 agent（若 Web UI 曾对其发送消息）
    this.agentPool.destroy(oldJid).catch(() => {});
    this.onJidMigratedCb?.(oldJid, newBinding);
    return newBinding;
  }

  /**
   * 尝试完成 QQ pending 绑定（qq:pending:{appId} → 真实 JID）。
   * 迁移成功返回新 GroupBinding（调用方可继续处理该消息），失败返回 undefined。
   */
  private completePendingQQBinding(msg: IncomingMessage): GroupBinding | undefined {
    const appId = msg.botToken ?? '';
    if (!appId) return undefined;
    const pending = this.groupManager.findPendingQQBinding(appId);
    if (!pending) return undefined;

    const oldJid = pending.jid;
    const newBinding = this.groupManager.migrateJid(oldJid, msg.chatJid);
    if (!newBinding) return undefined;

    console.log(`[MessageRouter] QQ pending binding completed: ${oldJid} → ${msg.chatJid}`);
    this.agentPool.destroy(oldJid).catch(() => {});
    this.onJidMigratedCb?.(oldJid, newBinding);
    return newBinding;
  }

  /**
   * 尝试完成微信 pending 绑定（wx:pending:{folder} → 真实 JID）。
   * 迁移成功返回新 GroupBinding，失败返回 undefined。
   */
  private completePendingWechatBinding(msg: IncomingMessage): GroupBinding | undefined {
    const folder = msg.botToken ?? '';
    if (!folder) return undefined;
    const pending = this.groupManager.findPendingWechatBinding(folder);
    if (!pending) return undefined;

    const oldJid = pending.jid;
    const newBinding = this.groupManager.migrateJid(oldJid, msg.chatJid);
    if (!newBinding) return undefined;

    console.log(`[MessageRouter] WeChat pending binding completed: ${oldJid} → ${msg.chatJid}`);
    this.agentPool.destroy(oldJid).catch(() => {});
    this.onJidMigratedCb?.(oldJid, newBinding);
    return newBinding;
  }

  /**
   * 未注册的飞书 JID 且无 pending 绑定时，回复告知 JID（每 JID 只提示一次）。
   */
  private notifyUnregisteredFeishu(msg: IncomingMessage): void {
    if (!msg.chatJid.startsWith('feishu:')) return;
    if (this.notifiedJids.has(msg.chatJid)) return;
    this.notifiedJids.add(msg.chatJid);
    this.agentPool.broadcastReply(
      msg.chatJid,
      `👋 你好！\n\n此会话尚未绑定到 SemaClaw。\n\n你的 JID 为：\`${msg.chatJid}\`\n\n请在 Web 管理界面添加 Agent，并将上面的 JID 填入 Chat JID 字段。`,
      msg.botToken,
    ).catch(() => {});
  }

  private storeMessage(msg: IncomingMessage): void {
    try {
      insertMessage({
        messageId: msg.id,
        chatJid: msg.chatJid,
        senderJid: msg.senderJid,
        senderName: msg.senderName,
        content: msg.content,
        timestamp: msg.timestamp,
        isFromMe: msg.isFromMe,
        isBotReply: false,
        replyToId: null,
        mediaType: null,
      });
    } catch (err) {
      console.error(`[MessageRouter] Failed to store message ${msg.id}:`, err);
    }
  }
}
