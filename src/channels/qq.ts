/**
 * QQChannel — QQ 官方群聊 Bot 接入，实现 IChannel 接口
 *
 * 认证流程（新版 OAuth2）：
 *   POST https://bots.qq.com/app/getAppAccessToken { appId, clientSecret }
 *   → access_token → Authorization: QQBot {access_token}
 *
 * 连接方式：WebSocket 长连接（不需要公网 IP）
 *
 * 多 App 支持：类比 FeishuChannel，通过 addApp() 注册额外 QQ Bot。
 * JID 格式不含 appId（openid 跨 app 不重复），botToken 字段存 appId 区分来源。
 *   私聊 JID: qq:user:{user_openid}
 *   群聊 JID: qq:group:{group_openid}
 *
 * 被动回复：收到消息后 5 分钟内发送时携带原始 msg_id，超时则不带（需主动消息权限）。
 */

import WebSocket from 'ws';
import type { IChannel, IncomingMessage, ChatMeta, InlineButton } from '../types';

// ===== 常量 =====

const TOKEN_URL = 'https://bots.qq.com/app/getAppAccessToken';
const API_BASE = 'https://api.sgroup.qq.com';

// GROUP_AND_C2C = 1<<25, INTERACTION = 1<<26, PUBLIC_GUILD_MESSAGES = 1<<30
const INTENTS = (1 << 25) | (1 << 26) | (1 << 30);

const PASSIVE_WINDOW_MS = 4.5 * 60 * 1000; // 4.5 分钟被动回复窗口
const QQ_MAX_LEN = 4000;
const MENU_TTL_MS = 5 * 60 * 1000; // 数字菜单等待超时
/** getAccessToken + 获取 gateway URL 网络超时，超时后跳过，不阻塞启动流程 */
const CONNECT_TIMEOUT_MS = 15_000;

// ===== 工具函数 =====

function splitMessage(text: string): string[] {
  if (text.length <= QQ_MAX_LEN) return [text];
  const parts: string[] = [];
  let remaining = text;
  while (remaining.length > QQ_MAX_LEN) {
    const chunk = remaining.slice(0, QQ_MAX_LEN);
    const lastNL = chunk.lastIndexOf('\n');
    const splitAt = lastNL > QQ_MAX_LEN * 0.5 ? lastNL : QQ_MAX_LEN;
    parts.push(remaining.slice(0, splitAt));
    remaining = remaining.slice(splitAt).replace(/^\n/, '');
  }
  if (remaining.length > 0) parts.push(remaining);
  return parts;
}

// ===== 消息去重（全局，跨 app 共用；openid 跨 app 不重复，msgId 冲突概率极低） =====

const DEDUP_TTL_MS = 30 * 60 * 1000;
const processedMsgIds = new Map<string, number>();

function tryRecordMessage(msgId: string): boolean {
  const now = Date.now();
  for (const [id, ts] of processedMsgIds) {
    if (now - ts > DEDUP_TTL_MS) processedMsgIds.delete(id);
  }
  if (processedMsgIds.has(msgId)) return false;
  processedMsgIds.set(msgId, now);
  return true;
}

// ===== msg_seq（被动回复序号） =====

function nextMsgSeq(): number {
  return (Date.now() % 65536) ^ Math.floor(Math.random() * 65536);
}

// ===== Per-App 状态 =====

interface TokenCache {
  token: string;
  expiresAt: number;
}

interface AppEntry {
  appId: string;
  appSecret: string;
  sandbox: boolean;
  // token 缓存（per-app 独立）
  tokenCache: TokenCache | null;
  tokenFetchPromise: Promise<string> | null;
  // WebSocket 连接状态
  ws: WebSocket | null;
  connected: boolean;
  connecting: boolean;
  stopping: boolean;
  sessionId: string | null;
  lastSeq: number | null;
  heartbeatTimer: ReturnType<typeof setInterval> | null;
  reconnectTimer: ReturnType<typeof setTimeout> | null;
  reconnectAttempts: number;
  /** 平台不支持 keyboard，降级为文字菜单（首次失败后永久跳过 API 尝试） */
  keyboardUnsupported: boolean;
}

function makeAppEntry(appId: string, appSecret: string, sandbox: boolean): AppEntry {
  return {
    appId,
    appSecret,
    sandbox,
    tokenCache: null,
    tokenFetchPromise: null,
    ws: null,
    connected: false,
    connecting: false,
    stopping: false,
    sessionId: null,
    lastSeq: null,
    heartbeatTimer: null,
    reconnectTimer: null,
    reconnectAttempts: 0,
    keyboardUnsupported: false,
  };
}

// ===== Per-App token 获取 & API =====

async function getAccessToken(app: AppEntry): Promise<string> {
  if (app.tokenCache && Date.now() < app.tokenCache.expiresAt - 5 * 60 * 1000) {
    return app.tokenCache.token;
  }
  if (app.tokenFetchPromise) return app.tokenFetchPromise;

  app.tokenFetchPromise = (async () => {
    try {
      const res = await fetch(TOKEN_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ appId: app.appId, clientSecret: app.appSecret }),
      });
      const data = await res.json() as { access_token?: string; expires_in?: number };
      if (!data.access_token) throw new Error(`getAccessToken failed: ${JSON.stringify(data)}`);
      app.tokenCache = { token: data.access_token, expiresAt: Date.now() + (data.expires_in ?? 7200) * 1000 };
      console.log(`[QQChannel:${app.appId}] Access token obtained, expires at ${new Date(app.tokenCache.expiresAt).toISOString()}`);
      return data.access_token;
    } finally {
      app.tokenFetchPromise = null;
    }
  })();

  return app.tokenFetchPromise;
}

async function apiRequest<T = unknown>(
  app: AppEntry,
  method: string,
  path: string,
  body?: unknown,
): Promise<T> {
  const token = await getAccessToken(app);
  const res = await fetch(`${API_BASE}${path}`, {
    method,
    headers: {
      Authorization: `QQBot ${token}`,
      'Content-Type': 'application/json',
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json() as T;
  if (!res.ok) {
    const err = data as { message?: string; code?: number };
    throw new Error(`QQ API error [${path}]: ${err.message ?? JSON.stringify(data)}`);
  }
  return data;
}

// ===== 接口类型 =====

interface PendingReply {
  msgId: string;
  expiresAt: number;
}

interface PendingMenu {
  options: InlineButton[];
  timer: ReturnType<typeof setTimeout>;
  appId: string;
}

type CallbackQueryHandler = (callbackData: string, chatJid: string) => string | void;

// ===== QQChannel =====

export class QQChannel implements IChannel {
  readonly id = 'qq';

  /** appId → AppEntry，所有已注册 app */
  private apps = new Map<string, AppEntry>();
  /** 主 app 的 appId（来自 .env，connect() 时等待的那个） */
  private primaryAppId: string | null = null;

  private messageHandlers: Array<(msg: IncomingMessage) => void> = [];
  private metaHandlers: Array<(jid: string, meta: ChatMeta) => void> = [];
  private callbackQueryHandlers: CallbackQueryHandler[] = [];

  /**
   * jid → 最近收到的 msg_id（被动回复窗口内）。
   * 跨 app 共享：同一 JID 必然属于同一 app，不会冲突。
   */
  private pendingReplies = new Map<string, PendingReply>();

  /**
   * 数字菜单队列：jid → 待用户回复的菜单列表（FIFO）。
   * 跨 app 共享，同 pendingReplies 原因。
   */
  private pendingMenuQueues = new Map<string, PendingMenu[]>();

  constructor(appId: string, appSecret: string, sandbox = false) {
    this.primaryAppId = appId;
    this.apps.set(appId, makeAppEntry(appId, appSecret, sandbox));
  }

  /**
   * 注册额外 QQ Bot app，立即以非阻塞方式发起连接。
   */
  addApp(appId: string, appSecret: string, sandbox = false): void {
    if (this.apps.has(appId)) {
      console.warn(`[QQChannel] addApp: appId ${appId} already registered, skipping`);
      return;
    }
    const entry = makeAppEntry(appId, appSecret, sandbox);
    this.apps.set(appId, entry);
    console.log(`[QQChannel] Registered extra app: ${appId}`);

    // 无论主 app 是否已连接，立即启动额外 app（非阻塞）
    // 注意：_doConnect 在 WebSocket 创建后即 resolve，READY 事件异步到达后才设 connected=true，
    // 因此不能依赖 primary.connected 判断时机。
    this._connectAppWithTimeout(entry).catch((err) => {
      console.error(`[QQChannel:${appId}] Background connect failed:`, err);
    });
  }

  // ===== IChannel =====

  /**
   * 连接主 app（带 15s 超时）。额外 app 通过 addApp() 各自独立连接。
   */
  async connect(): Promise<void> {
    const primaryAppId = this.primaryAppId;
    if (!primaryAppId) {
      console.warn('[QQChannel] No primary app configured, QQ disabled');
      return;
    }
    const primary = this.apps.get(primaryAppId);
    if (!primary) return;
    if (primary.connected) return;

    if (!primary.appId || !primary.appSecret) {
      console.warn('[QQChannel] No credentials configured, QQ disabled');
      return;
    }

    await this._connectAppWithTimeout(primary);
  }

  async disconnect(): Promise<void> {
    for (const app of this.apps.values()) {
      app.stopping = true;
      this._cleanupApp(app);
      app.connected = false;
    }
    console.log('[QQChannel] Disconnected (all apps)');
  }

  isConnected(): boolean {
    const primary = this.primaryAppId ? this.apps.get(this.primaryAppId) : undefined;
    return primary?.connected ?? false;
  }

  onMessage(handler: (msg: IncomingMessage) => void): void {
    this.messageHandlers.push(handler);
  }

  onChatMetadata(handler: (jid: string, meta: ChatMeta) => void): void {
    this.metaHandlers.push(handler);
  }

  ownsJid(chatJid: string): boolean {
    return chatJid.startsWith('qq:');
  }

  async sendMessage(chatJid: string, text: string, botToken?: string): Promise<void> {
    const app = this._resolveApp(botToken, chatJid);
    if (!app) return;

    const parts = splitMessage(text);
    const pending = this.pendingReplies.get(chatJid);
    const msgId = pending && pending.expiresAt > Date.now() ? pending.msgId : undefined;

    for (let i = 0; i < parts.length; i++) {
      const activeMsgId = i === 0 ? msgId : undefined;
      const body: Record<string, unknown> = {
        content: parts[i],
        msg_type: 0,
        msg_seq: nextMsgSeq(),
        ...(activeMsgId ? { msg_id: activeMsgId } : {}),
      };

      try {
        if (chatJid.startsWith('qq:user:')) {
          const openid = chatJid.slice('qq:user:'.length);
          await apiRequest(app, 'POST', `/v2/users/${openid}/messages`, body);
        } else if (chatJid.startsWith('qq:group:')) {
          const groupOpenid = chatJid.slice('qq:group:'.length);
          await apiRequest(app, 'POST', `/v2/groups/${groupOpenid}/messages`, body);
        }
      } catch (err) {
        console.error(`[QQChannel:${app.appId}] Failed to send message to ${chatJid}:`, err);
      }
    }
  }

  /** QQ Bot API 无 typing indicator，空实现 */
  async setTyping(_chatJid: string, _active: boolean): Promise<void> {}

  /**
   * 发送带 QQ 内联按钮的消息（msg_type: 2，markdown + keyboard）。
   * 需要平台 markdown 权限；若 API 返回错误（无权限），降级为数字菜单文本并入队。
   * buttons 按单行排列，每行最多 5 个按钮。
   */
  async sendWithButtons(
    chatJid: string,
    text: string,
    buttons: InlineButton[],
    botToken?: string,
  ): Promise<void> {
    const app = this._resolveApp(botToken, chatJid);
    if (!app) return;

    // 已知该 app 不支持 keyboard，直接走文字菜单
    if (app.keyboardUnsupported) {
      await this._sendTextMenu(chatJid, text, buttons, app);
      return;
    }

    // 构造 QQ keyboard rows（每行最多 5 个按钮）
    const ROW_SIZE = 5;
    const rows: object[] = [];
    for (let i = 0; i < buttons.length; i += ROW_SIZE) {
      const rowBtns = buttons.slice(i, i + ROW_SIZE);
      rows.push({
        buttons: rowBtns.map((b, idx) => ({
          id: String(i + idx + 1),
          render_data: { label: b.label, visited_label: `✅ ${b.label}` },
          action: {
            type: 2, // callback
            permission: { type: 2 }, // all members
            data: b.callbackData,
            reply: false,
            enter: true,
          },
        })),
      });
    }

    const pending = this.pendingReplies.get(chatJid);
    const msgId = pending && pending.expiresAt > Date.now() ? pending.msgId : undefined;

    const body: Record<string, unknown> = {
      msg_type: 2,
      markdown: { content: text },
      keyboard: { content: { rows } },
      msg_seq: nextMsgSeq(),
      ...(msgId ? { msg_id: msgId } : {}),
    };

    try {
      if (chatJid.startsWith('qq:user:')) {
        const openid = chatJid.slice('qq:user:'.length);
        await apiRequest(app, 'POST', `/v2/users/${openid}/messages`, body);
      } else if (chatJid.startsWith('qq:group:')) {
        const groupOpenid = chatJid.slice('qq:group:'.length);
        await apiRequest(app, 'POST', `/v2/groups/${groupOpenid}/messages`, body);
      }
    } catch (err) {
      console.warn(`[QQChannel:${app.appId}] sendWithButtons failed, falling back to text menu permanently:`, (err as Error).message);
      app.keyboardUnsupported = true;
      await this._sendTextMenu(chatJid, text, buttons, app);
    }
  }

  /** 降级方案：将选项格式化为编号文本，入队等待用户数字回复 */
  private async _sendTextMenu(chatJid: string, text: string, buttons: InlineButton[], app: AppEntry): Promise<void> {
    const numbered = buttons.map((b, i) => `${i + 1}. ${b.label}`).join('\n');
    const fullText = `${text}\n\n${numbered}\n\n（请回复序号选择）`;

    if (!this.pendingMenuQueues.has(chatJid)) this.pendingMenuQueues.set(chatJid, []);
    const timer = setTimeout(() => {
      const q = this.pendingMenuQueues.get(chatJid);
      if (q) {
        const idx = q.findIndex((m) => m.timer === timer);
        if (idx >= 0) q.splice(idx, 1);
        if (q.length === 0) this.pendingMenuQueues.delete(chatJid);
      }
    }, MENU_TTL_MS);
    this.pendingMenuQueues.get(chatJid)!.push({ options: buttons, timer, appId: app.appId });

    await this.sendMessage(chatJid, fullText, app.appId);
  }

  /** 注册内联按钮回调处理器 */
  onCallbackQuery(handler: CallbackQueryHandler): void {
    this.callbackQueryHandlers.push(handler);
  }

  // ===== App 路由 =====

  /**
   * 根据 botToken（appId）找对应 AppEntry。
   * - botToken 有值：精确匹配，找不到则返回 null（配置错误，不 fallback，避免主 app 误发）
   * - botToken 为空：使用主 app（无 token 的主动调用场景）
   */
  private _resolveApp(botToken?: string, chatJid?: string): AppEntry | null {
    if (botToken) {
      const app = this.apps.get(botToken);
      if (app) return app;
      console.error(`[QQChannel] Unknown botToken "${botToken}"${chatJid ? ` for ${chatJid}` : ''}, message dropped`);
      return null;
    }
    if (this.primaryAppId) {
      const primary = this.apps.get(this.primaryAppId);
      if (primary) return primary;
    }
    console.warn('[QQChannel] No app available to send message');
    return null;
  }

  // ===== 连接管理（per-app） =====

  private async _connectAppWithTimeout(app: AppEntry): Promise<void> {
    const connectPromise = this._doConnect(app);
    let connectTimeoutId: ReturnType<typeof setTimeout>;
    const connectTimeout = new Promise<never>((_, reject) => {
      connectTimeoutId = setTimeout(
        () => reject(new Error(`QQChannel connect timed out after ${CONNECT_TIMEOUT_MS / 1000}s`)),
        CONNECT_TIMEOUT_MS,
      );
    });
    try {
      await Promise.race([connectPromise, connectTimeout]);
      clearTimeout(connectTimeoutId!);
    } catch (err) {
      clearTimeout(connectTimeoutId!);
      connectPromise.catch(() => {}); // 防止超时后请求完成时产生 unhandled rejection
      throw err;
    }
  }

  private async _doConnect(app: AppEntry): Promise<void> {
    if (app.connected || app.connecting) return;
    app.connecting = true;
    try {
      const token = await getAccessToken(app);
      const gwData = await apiRequest<{ url: string }>(app, 'GET', '/gateway');
      const wsUrl = app.sandbox ? gwData.url.replace('wss://', 'wss://sandbox.') : gwData.url;

      console.log(`[QQChannel:${app.appId}] Connecting to ${wsUrl}`);
      const ws = new WebSocket(wsUrl);
      app.ws = ws;

      ws.on('open', () => {
        app.reconnectAttempts = 0;
        app.connecting = false;
      });

      ws.on('message', (data) => {
        try {
          const payload = JSON.parse(data.toString()) as { op: number; d: unknown; s?: number; t?: string };
          this._handlePayload(app, payload, token);
        } catch (e) {
          if (e instanceof Error && e.message.includes('not open')) return;
          console.error(`[QQChannel:${app.appId}] Failed to parse payload:`, e);
        }
      });

      ws.on('close', (code) => {
        const codeNum = code as number;
        this._cleanupApp(app);
        if (!app.stopping) {
          if (codeNum === 4902) {
            app.sessionId = null;
            app.lastSeq = null;
          }
          this._scheduleReconnect(app);
        }
      });

      ws.on('error', (err) => {
        if (!app.stopping) console.error(`[QQChannel:${app.appId}] WebSocket error:`, err.message);
      });

    } catch (err) {
      app.connecting = false;
      if (!app.stopping) {
        console.error(`[QQChannel:${app.appId}] Connect failed:`, err);
        this._scheduleReconnect(app);
      }
    }
  }

  private _handlePayload(app: AppEntry, payload: { op: number; d: unknown; s?: number; t?: string }, token: string): void {
    const { op, d, s, t } = payload;
    if (s != null) app.lastSeq = s;

    switch (op) {
      case 10: { // Hello
        const helloData = d as { heartbeat_interval: number };
        const wsSend = (msg: object) => {
          if (app.ws?.readyState === WebSocket.OPEN) {
            app.ws.send(JSON.stringify(msg));
          }
        };
        if (app.sessionId && app.lastSeq != null) {
          wsSend({ op: 6, d: { token: `QQBot ${token}`, session_id: app.sessionId, seq: app.lastSeq } });
        } else {
          wsSend({ op: 2, d: { token: `QQBot ${token}`, intents: INTENTS, shard: [0, 1] } });
        }
        if (app.heartbeatTimer) clearInterval(app.heartbeatTimer);
        app.heartbeatTimer = setInterval(() => {
          if (app.ws?.readyState === WebSocket.OPEN) {
            app.ws.send(JSON.stringify({ op: 1, d: app.lastSeq }));
          }
        }, helloData.heartbeat_interval);
        break;
      }

      case 0: { // Dispatch
        if (t === 'READY') {
          const readyData = d as { session_id: string };
          app.sessionId = readyData.session_id;
          app.connected = true;
          if (app.reconnectTimer) { clearTimeout(app.reconnectTimer); app.reconnectTimer = null; }
          console.log(`[QQChannel:${app.appId}] Ready, session: ${app.sessionId}`);
        } else if (t === 'RESUMED') {
          app.connected = true;
          if (app.reconnectTimer) { clearTimeout(app.reconnectTimer); app.reconnectTimer = null; }
          console.log(`[QQChannel:${app.appId}] Session resumed`);
        } else if (t === 'C2C_MESSAGE_CREATE') {
          this._handleC2C(app, d as { id: string; author: { user_openid: string }; content: string; timestamp: string });
        } else if (t === 'GROUP_AT_MESSAGE_CREATE') {
          this._handleGroup(app, d as { id: string; author: { member_openid: string }; group_openid: string; content: string; timestamp: string });
        } else if (t === 'INTERACTION_CREATE') {
          this._handleInteraction(app, d as {
            id: string;
            chat_type: number;
            group_openid?: string;
            group_member_openid?: string;
            user_openid?: string;
            data: { resolved: { button_id?: string; button_data?: string } };
          });
        }
        break;
      }

      case 7: { // Reconnect
        console.log(`[QQChannel:${app.appId}] Server requested reconnect`);
        this._cleanupApp(app);
        this._scheduleReconnect(app);
        break;
      }

      case 9: { // Invalid Session
        console.warn(`[QQChannel:${app.appId}] Invalid session, clearing and reconnecting`);
        app.sessionId = null;
        app.lastSeq = null;
        this._cleanupApp(app);
        this._scheduleReconnect(app);
        break;
      }

      case 11: // Heartbeat ACK
        break;
    }
  }

  private _handleC2C(app: AppEntry, event: { id: string; author: { user_openid: string }; content: string; timestamp: string }): void {
    const msgId = event.id;
    if (!tryRecordMessage(msgId)) return;

    const openid = event.author.user_openid;
    const jid = `qq:user:${openid}`;
    const content = event.content.trim();
    if (!content) return;

    if (this._tryHandleMenuReply(jid, content)) return;

    this.pendingReplies.set(jid, { msgId, expiresAt: Date.now() + PASSIVE_WINDOW_MS });

    const msg: IncomingMessage = {
      id: msgId,
      chatJid: jid,
      senderName: openid.slice(0, 8) + '...',
      senderJid: jid,
      content,
      timestamp: event.timestamp ? new Date(event.timestamp).toISOString() : new Date().toISOString(),
      isFromMe: false,
      chatType: 'private',
      mentionsBotUsername: false,
      nativeMsgId: msgId,
      botToken: app.appId,
    };
    this._dispatch(msg, { jid, type: 'private' });
  }

  private _handleGroup(app: AppEntry, event: { id: string; author: { member_openid: string }; group_openid: string; content: string; timestamp: string }): void {
    const msgId = event.id;
    if (!tryRecordMessage(msgId)) return;

    const memberOpenid = event.author.member_openid;
    const groupOpenid = event.group_openid;
    const jid = `qq:group:${groupOpenid}`;
    const content = event.content.replace(/<@!\d+>/g, '').trim();
    if (!content) return;

    if (this._tryHandleMenuReply(jid, content)) return;

    this.pendingReplies.set(jid, { msgId, expiresAt: Date.now() + PASSIVE_WINDOW_MS });

    const msg: IncomingMessage = {
      id: msgId,
      chatJid: jid,
      senderName: memberOpenid.slice(0, 8) + '...',
      senderJid: `qq:user:${memberOpenid}`,
      content,
      timestamp: event.timestamp ? new Date(event.timestamp).toISOString() : new Date().toISOString(),
      isFromMe: false,
      chatType: 'group',
      mentionsBotUsername: true,
      nativeMsgId: msgId,
      botToken: app.appId,
    };
    this._dispatch(msg, { jid, type: 'group' });
  }

  /**
   * 处理 INTERACTION_CREATE 事件（用户点击按钮）。
   * 路由 button_data 到 callbackQueryHandlers，然后应答交互（避免按钮 loading 闪烁）。
   */
  private _handleInteraction(app: AppEntry, event: {
    id: string;
    chat_type: number; // 0=C2C, 1=group
    group_openid?: string;
    group_member_openid?: string;
    user_openid?: string;
    data: { resolved: { button_id?: string; button_data?: string } };
  }): void {
    const callbackData = event.data?.resolved?.button_data;
    if (!callbackData) return;

    const jid = event.chat_type === 1
      ? `qq:group:${event.group_openid}`
      : `qq:user:${event.user_openid}`;

    let answerText: string | undefined;
    for (const h of this.callbackQueryHandlers) {
      try {
        const ret = h(callbackData, jid);
        if (ret && !answerText) answerText = ret;
      } catch (e) { console.error(`[QQChannel:${app.appId}] callbackQueryHandler error:`, e); }
    }

    // 应答交互（必须调用，否则 QQ 客户端按钮持续 loading）
    apiRequest(app, 'PUT', `/v2/interactions/${event.id}`, { code: 0 })
      .catch((err) => console.warn(`[QQChannel:${app.appId}] acknowledge interaction failed:`, (err as Error).message));

    if (answerText) {
      this.sendMessage(jid, answerText, app.appId).catch(() => {});
    }
  }

  /**
   * 降级数字菜单：尝试将用户消息解释为数字序号回复。
   * 若消费成功返回 true（消息不再往上派发）。
   */
  private _tryHandleMenuReply(jid: string, content: string): boolean {
    const queue = this.pendingMenuQueues.get(jid);
    if (!queue || queue.length === 0) return false;

    const num = parseInt(content.trim(), 10);
    if (isNaN(num) || num < 1 || num > queue[0].options.length) return false;

    const { options, timer, appId } = queue.shift()!;
    clearTimeout(timer);
    if (queue.length === 0) this.pendingMenuQueues.delete(jid);

    const selected = options[num - 1];
    let answerText: string | undefined;
    for (const h of this.callbackQueryHandlers) {
      try {
        const ret = h(selected.callbackData, jid);
        if (ret && !answerText) answerText = ret;
      } catch (e) { console.error('[QQChannel] callbackQueryHandler error:', e); }
    }

    if (answerText) {
      this.sendMessage(jid, answerText, appId).catch(() => {});
    }
    return true;
  }

  private _dispatch(msg: IncomingMessage, meta: ChatMeta): void {
    for (const h of this.messageHandlers) {
      try { h(msg); } catch (e) { console.error('[QQChannel] messageHandler error:', e); }
    }
    for (const h of this.metaHandlers) {
      try { h(meta.jid, meta); } catch (e) { console.error('[QQChannel] metaHandler error:', e); }
    }
  }

  private _cleanupApp(app: AppEntry): void {
    if (app.heartbeatTimer) { clearInterval(app.heartbeatTimer); app.heartbeatTimer = null; }
    if (app.ws) {
      try { app.ws.terminate(); } catch {}
      app.ws = null;
    }
    app.connected = false;
    app.connecting = false;
  }

  private _scheduleReconnect(app: AppEntry): void {
    if (app.stopping) return;
    const delays = [1000, 2000, 5000, 10000, 30000, 60000];
    const delay = delays[Math.min(app.reconnectAttempts, delays.length - 1)];
    app.reconnectAttempts++;
    console.log(`[QQChannel:${app.appId}] Reconnecting in ${delay / 1000}s (attempt ${app.reconnectAttempts})`);
    app.reconnectTimer = setTimeout(() => {
      if (!app.stopping) this._doConnect(app);
    }, delay);
  }
}
