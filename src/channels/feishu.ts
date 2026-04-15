/**
 * FeishuChannel — 飞书 Bot 接入，实现 IChannel 接口
 *
 * 多应用支持：
 *   - 每组 appId/appSecret 独立维护一个 Lark.Client + WSClient
 *   - addApp(appId, appSecret, domain?) 运行时注册新应用
 *   - 所有应用共享同一组 message/metadata/callback handler
 *
 * JID 格式：
 *   - 私聊：feishu:user:{open_id}
 *   - 群组：feishu:group:{chat_id}
 *
 * 连接模式：仅 WebSocket（MVP）
 */

import * as Lark from '@larksuiteoapi/node-sdk';
import {
  createFeishuClient,
  createFeishuWSClient,
  createEventDispatcher,
  fetchBotInfo,
  type FeishuDomain,
  type FeishuAppCredentials,
  type FeishuBotInfo,
} from './feishu-client';
import type { IChannel, IncomingMessage, ChatMeta, InlineButton } from '../types';

// ===== Helpers =====

/** 飞书消息 content 是 JSON 字符串，需要 parse */
function parseTextContent(content: string, messageType: string): string {
  try {
    const parsed = JSON.parse(content);

    if (messageType === 'text') {
      return parsed.text ?? '';
    }

    if (messageType === 'post') {
      // 富文本：提取纯文本
      const blocks = parsed?.zh_cn?.content ?? parsed?.en_us?.content ?? parsed?.content ?? [];
      const lines: string[] = [];
      for (const paragraph of blocks) {
        if (!Array.isArray(paragraph)) continue;
        const line = paragraph
          .map((node: { tag?: string; text?: string }) => {
            if (node.tag === 'text') return node.text ?? '';
            if (node.tag === 'a') return (node as any).text ?? (node as any).href ?? '';
            if (node.tag === 'at') return '';
            if (node.tag === 'img') return '[Image]';
            return node.text ?? '';
          })
          .join('');
        if (line.trim()) lines.push(line);
      }
      const title = parsed?.zh_cn?.title ?? parsed?.en_us?.title ?? '';
      return (title ? title + '\n' : '') + lines.join('\n');
    }

    // 其他类型：尝试提取 text 字段
    if (typeof parsed.text === 'string') return parsed.text;
    return content;
  } catch {
    return content;
  }
}

/**
 * 检测 mentions 数组中是否包含指定 bot open_id
 */
function checkBotMention(
  mentions: Array<{ key: string; id: { open_id?: string }; name: string }> | undefined,
  botOpenId: string,
): boolean {
  if (!mentions || !botOpenId) return false;
  return mentions.some((m) => m.id?.open_id === botOpenId);
}

/**
 * 从 mentions 中移除 @bot 占位符
 */
function removeBotMentionPlaceholders(
  text: string,
  mentions: Array<{ key: string; id: { open_id?: string }; name: string }> | undefined,
  botOpenId: string,
): string {
  if (!mentions || !botOpenId) return text;
  let result = text;
  for (const m of mentions) {
    if (m.id?.open_id === botOpenId) {
      result = result.replace(new RegExp(escapeRegExp(m.key), 'g'), '').trim();
    }
  }
  return result;
}

function escapeRegExp(raw: string): string {
  return raw.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** 飞书建议 4000 字符分片 */
const FEISHU_MAX_LEN = 4000;
/** 飞书卡片 markdown 最大长度 */
const FEISHU_CARD_MAX_LEN = 20_000;

/** fetchBotInfo 网络超时，超时后跳过该 app，不阻塞启动流程 */
const APP_INIT_TIMEOUT_MS = 15_000;

function splitMessage(text: string): string[] {
  if (text.length <= FEISHU_MAX_LEN) return [text];

  const parts: string[] = [];
  let remaining = text;

  while (remaining.length > FEISHU_MAX_LEN) {
    const chunk = remaining.slice(0, FEISHU_MAX_LEN);
    const lastNL = chunk.lastIndexOf('\n');
    const splitAt = lastNL > FEISHU_MAX_LEN * 0.5 ? lastNL : FEISHU_MAX_LEN;
    parts.push(remaining.slice(0, splitAt));
    remaining = remaining.slice(splitAt).replace(/^\n/, '');
  }

  if (remaining.length > 0) parts.push(remaining);
  return parts;
}

// ===== 消息去重 =====

const DEDUP_TTL_MS = 30 * 60 * 1000;
const DEDUP_MAX_SIZE = 1000;
const DEDUP_CLEANUP_INTERVAL_MS = 5 * 60 * 1000;
const processedMessageIds = new Map<string, number>();
let lastCleanupTime = Date.now();

function tryRecordMessage(messageId: string, appId: string): boolean {
  const now = Date.now();
  const key = `${appId}:${messageId}`;

  if (now - lastCleanupTime > DEDUP_CLEANUP_INTERVAL_MS) {
    for (const [id, ts] of processedMessageIds) {
      if (now - ts > DEDUP_TTL_MS) processedMessageIds.delete(id);
    }
    lastCleanupTime = now;
  }

  if (processedMessageIds.has(key)) return false;

  if (processedMessageIds.size >= DEDUP_MAX_SIZE) {
    const first = processedMessageIds.keys().next().value!;
    processedMessageIds.delete(first);
  }

  processedMessageIds.set(key, now);
  return true;
}

// ===== 飞书事件类型 =====

interface FeishuMessageEvent {
  sender: {
    sender_id: {
      open_id?: string;
      user_id?: string;
      union_id?: string;
    };
    sender_type?: string;
    tenant_key?: string;
  };
  message: {
    message_id: string;
    root_id?: string;
    parent_id?: string;
    chat_id: string;
    chat_type: 'p2p' | 'group' | 'private';
    create_time?: string;
    message_type: string;
    content: string;
    mentions?: Array<{
      key: string;
      id: { open_id?: string; user_id?: string; union_id?: string };
      name: string;
      tenant_key?: string;
    }>;
  };
}

// ===== FeishuChannel =====

interface AppEntry {
  client: Lark.Client;
  wsClient: Lark.WSClient;
  botInfo: FeishuBotInfo;
  appId: string;
  appSecret: string;
  domain?: FeishuDomain;
}

type CallbackQueryHandler = (callbackData: string, chatJid: string) => string | void;

/** 发送者姓名缓存 */
const senderNameCache = new Map<string, { name: string; expireAt: number }>();
const SENDER_NAME_TTL_MS = 10 * 60 * 1000;

export class FeishuChannel implements IChannel {
  readonly id = 'feishu';

  /** appId → AppEntry */
  private apps = new Map<string, AppEntry>();

  private messageHandlers: Array<(msg: IncomingMessage) => void> = [];
  private metaHandlers: Array<(jid: string, meta: ChatMeta) => void> = [];
  private callbackQueryHandlers: CallbackQueryHandler[] = [];

  private connected = false;

  constructor(
    private readonly defaultAppId: string,
    private readonly defaultAppSecret: string,
    private readonly defaultDomain: FeishuDomain = 'feishu',
  ) {}

  // ===== IChannel =====

  async connect(): Promise<void> {
    if (this.connected) return;
    if (!this.defaultAppId || !this.defaultAppSecret) {
      console.warn('[FeishuChannel] No app credentials configured, Feishu disabled');
      return;
    }
    await this.addApp(this.defaultAppId, this.defaultAppSecret, this.defaultDomain);
  }

  async disconnect(): Promise<void> {
    // WSClient 没有显式 stop 方法，清理引用即可
    this.apps.clear();
    this.connected = false;
    console.log('[FeishuChannel] Disconnected');
  }

  isConnected(): boolean {
    return this.connected;
  }

  onMessage(handler: (msg: IncomingMessage) => void): void {
    this.messageHandlers.push(handler);
  }

  onChatMetadata(handler: (jid: string, meta: ChatMeta) => void): void {
    this.metaHandlers.push(handler);
  }

  ownsJid(chatJid: string): boolean {
    return chatJid.startsWith('feishu:');
  }

  getBotUsername(botToken?: string): string | undefined {
    const appId = botToken ?? this.defaultAppId;
    return this.apps.get(appId)?.botInfo.openId;
  }

  async sendMessage(chatJid: string, text: string, botToken?: string): Promise<void> {
    const entry = this.resolveApp(botToken);
    if (!entry) return;

    const chatId = jidToChatId(chatJid);
    if (!chatId) throw new Error(`Invalid Feishu JID: ${chatJid}`);

    const parts = splitMessage(text);
    for (const part of parts) {
      const content = JSON.stringify({ text: part });
      await entry.client.im.message.create({
        params: { receive_id_type: jidToReceiveIdType(chatJid) },
        data: {
          receive_id: chatId,
          content,
          msg_type: 'text',
        },
      });
    }
  }

  /**
   * 发送带内联按钮的消息（权限交互用）。
   * 使用 interactive card (schema 2.0)。
   */
  async sendWithButtons(
    chatJid: string,
    text: string,
    buttons: InlineButton[],
    botToken?: string,
  ): Promise<void> {
    const entry = this.resolveApp(botToken);
    if (!entry) return;

    const chatId = jidToChatId(chatJid);
    if (!chatId) throw new Error(`Invalid Feishu JID: ${chatJid}`);

    const actions = buttons.map((btn) => ({
      tag: 'button' as const,
      text: { tag: 'plain_text' as const, content: btn.label },
      type: btn.callbackData.includes('refuse') || btn.callbackData.includes('deny') ? 'danger' as const : 'primary' as const,
      value: { action: btn.callbackData },
    }));

    const truncatedText = text.length > FEISHU_CARD_MAX_LEN
      ? text.slice(0, FEISHU_CARD_MAX_LEN) + '\n…(content truncated)'
      : text;

    const card = {
      config: { wide_screen_mode: true },
      elements: [
        { tag: 'markdown', content: truncatedText },
        {
          tag: 'action',
          actions,
        },
      ],
    };

    await entry.client.im.message.create({
      params: { receive_id_type: jidToReceiveIdType(chatJid) },
      data: {
        receive_id: chatId,
        content: JSON.stringify(card),
        msg_type: 'interactive',
      },
    });
  }

  onCallbackQuery(handler: CallbackQueryHandler): void {
    this.callbackQueryHandlers.push(handler);
  }

  /**
   * 发送本地文件。
   * filePath 为绝对路径。
   */
  async sendDocument(
    chatJid: string,
    filePath: string,
    caption?: string,
    botToken?: string,
  ): Promise<void> {
    const entry = this.resolveApp(botToken);
    if (!entry) return;

    const chatId = jidToChatId(chatJid);
    if (!chatId) throw new Error(`Invalid Feishu JID: ${chatJid}`);

    const fs = await import('fs');
    const path = await import('path');
    const fileName = path.basename(filePath);
    const fileStream = fs.createReadStream(filePath);

    // 上传文件
    const uploadRes = await entry.client.im.file.create({
      data: {
        file_type: 'stream',
        file_name: fileName,
        file: fileStream,
      },
    });

    const fileKey = (uploadRes as any)?.data?.file_key;
    if (!fileKey) throw new Error('Failed to upload file to Feishu');

    // 发送文件消息
    await entry.client.im.message.create({
      params: { receive_id_type: jidToReceiveIdType(chatJid) },
      data: {
        receive_id: chatId,
        content: JSON.stringify({ file_key: fileKey }),
        msg_type: 'file',
      },
    });

    // 如果有 caption，单独发一条文本
    if (caption) {
      await this.sendMessage(chatJid, caption, botToken);
    }
  }

  // ===== 多应用管理 =====

  /**
   * 注册并启动一个飞书应用（幂等）。
   */
  async addApp(appId: string, appSecret: string, domain?: FeishuDomain): Promise<boolean> {
    if (!appId || !appSecret) return false;
    if (this.apps.has(appId)) { console.log(`[FeishuChannel] addApp: ${appId} already connected, skip`); return true; }

    console.log(`[FeishuChannel] addApp: starting for ${appId} (domain=${domain ?? 'feishu'})`);
    const creds: FeishuAppCredentials = { appId, appSecret, domain };

    // 1. 创建 REST client
    let client: Lark.Client;
    try {
      client = createFeishuClient(creds);
      console.log(`[FeishuChannel] addApp: REST client created for ${appId}`);
    } catch (err) {
      console.error(`[FeishuChannel] Failed to create client for ${appId}:`, err);
      return false;
    }

    // 2. 获取 bot info（带超时，网络不通时不阻塞启动）
    console.log(`[FeishuChannel] addApp: fetching bot info for ${appId}...`);
    let botInfo: FeishuBotInfo;
    const botInfoPromise = fetchBotInfo(client);
    let botInfoTimeoutId: ReturnType<typeof setTimeout>;
    const botInfoTimeout = new Promise<never>((_, reject) => {
      botInfoTimeoutId = setTimeout(() => reject(new Error(`fetchBotInfo timed out after ${APP_INIT_TIMEOUT_MS / 1000}s`)), APP_INIT_TIMEOUT_MS);
    });
    try {
      botInfo = await Promise.race([botInfoPromise, botInfoTimeout]);
      clearTimeout(botInfoTimeoutId!);
      console.log(`[FeishuChannel] addApp: bot info OK for ${appId} → name="${botInfo.name}" openId=${botInfo.openId}`);
    } catch (err) {
      clearTimeout(botInfoTimeoutId!);
      botInfoPromise.catch(() => {}); // 防止超时后请求完成时产生 unhandled rejection
      console.error(`[FeishuChannel] Failed to fetch bot info for ${appId}:`, err instanceof Error ? err.message : err);
      return false;
    }

    // 3. 创建 EventDispatcher 并注册事件
    const eventDispatcher = createEventDispatcher();

    eventDispatcher.register({
      'im.message.receive_v1': async (data: unknown) => {
        try {
          const event = data as FeishuMessageEvent;
          await this.handleMessage(event, appId);
        } catch (err) {
          console.error(`[FeishuChannel] Error handling message for ${appId}:`, err);
        }
      },
      'im.chat.member.bot.added_v1': async (data: unknown) => {
        try {
          const event = data as { chat_id: string };
          console.log(`[FeishuChannel] Bot ${botInfo.name} added to chat ${event.chat_id}`);
        } catch (err) {
          console.error(`[FeishuChannel] Error handling bot added event:`, err);
        }
      },
      'im.chat.member.bot.deleted_v1': async (data: unknown) => {
        try {
          const event = data as { chat_id: string };
          console.log(`[FeishuChannel] Bot ${botInfo.name} removed from chat ${event.chat_id}`);
        } catch (err) {
          console.error(`[FeishuChannel] Error handling bot removed event:`, err);
        }
      },
    });

    // 注册卡片按钮回调（SDK 已通过 patch-package 支持 card 类型消息）
    eventDispatcher.register({
      'card.action.trigger': async (data: unknown) => {
        try {
          const result = this.handleCardAction(data, appId);
          return result
            ? { toast: { type: 'success' as const, content: result } }
            : { toast: { type: 'success' as const, content: '已处理' } };
        } catch (err) {
          console.error(`[FeishuChannel] Error handling card action:`, err);
          return { toast: { type: 'error' as const, content: '处理失败' } };
        }
      },
    });

    // 4. 创建 WSClient 并建连
    let wsClient: Lark.WSClient;
    try {
      wsClient = createFeishuWSClient(creds);
      wsClient.start({ eventDispatcher });
    } catch (err) {
      console.error(`[FeishuChannel] Failed to start WSClient for ${appId}:`, err);
      return false;
    }

    this.apps.set(appId, { client, wsClient, botInfo, appId, appSecret, domain });
    this.connected = true;
    console.log(`[FeishuChannel] App ${botInfo.name} (${appId}) connected via WebSocket`);
    return true;
  }

  // ===== Internal =====

  private resolveApp(botToken?: string): AppEntry | null {
    if (this.apps.size === 0) return null;
    const appId = botToken ?? this.defaultAppId;
    return this.apps.get(appId) ?? null;
  }

  private async handleMessage(event: FeishuMessageEvent, appId: string): Promise<void> {
    console.log(`[FeishuChannel] handleMessage called for appId=${appId}`);
    const msg = event.message;
    if (!msg) return;

    const messageId = msg.message_id;

    // 去重
    if (!tryRecordMessage(messageId, appId)) return;

    const entry = this.apps.get(appId);
    if (!entry) return;

    const botOpenId = entry.botInfo.openId;

    // 过滤 bot 自身消息
    const senderOpenId = event.sender?.sender_id?.open_id ?? '';
    if (senderOpenId === botOpenId) return;

    // 解析消息内容
    let text = parseTextContent(msg.content, msg.message_type);

    // 仅处理有文本内容的消息
    if (!text.trim()) return;

    const chatType = msg.chat_type;
    const chatId = msg.chat_id;

    // JID
    const jid = chatType === 'p2p'
      ? `feishu:user:${senderOpenId}`
      : `feishu:group:${chatId}`;

    // @bot 检测
    const mentionsBotUsername = checkBotMention(msg.mentions, botOpenId);

    // 移除 @bot 占位符
    text = removeBotMentionPlaceholders(text, msg.mentions, botOpenId);
    if (!text.trim()) return;

    // 解析发送者名称
    const senderName = await this.resolveSenderName(entry.client, senderOpenId);

    const senderJid = `feishu:user:${senderOpenId}`;
    const timestamp = msg.create_time
      ? new Date(parseInt(msg.create_time, 10)).toISOString()
      : new Date().toISOString();

    const incoming: IncomingMessage = {
      id: messageId,
      chatJid: jid,
      senderName,
      senderJid,
      content: text,
      timestamp,
      isFromMe: false,
      chatType: chatType === 'p2p' ? 'private' : 'group',
      mentionsBotUsername,
      botToken: appId,
    };

    // 派发给上层 handler（MessageRouter）
    for (const h of this.messageHandlers) {
      try {
        h(incoming);
      } catch (e) {
        console.error('[FeishuChannel] messageHandler error:', e);
      }
    }

    // 更新 chat metadata
    const meta: ChatMeta = {
      jid,
      title: chatType === 'p2p' ? senderName : undefined,
      type: chatType === 'p2p' ? 'private' : 'group',
    };
    for (const h of this.metaHandlers) {
      try {
        h(jid, meta);
      } catch (e) {
        console.error('[FeishuChannel] metaHandler error:', e);
      }
    }
  }

  /**
   * 处理卡片按钮回调（card.action.trigger）。
   */
  private handleCardAction(data: unknown, _appId: string): string | undefined {
    const action = data as {
      operator?: { open_id?: string };
      action?: { value?: Record<string, string> };
      open_chat_id?: string;
      open_message_id?: string;
      context?: { open_chat_id?: string; open_message_id?: string };
    };

    const value = action?.action?.value;
    if (!value?.action) return undefined;

    const callbackData = value.action;
    // open_chat_id 可能在顶层或 context 里（v2 事件在 context 内）
    const chatId = action.open_chat_id ?? action.context?.open_chat_id;
    if (!chatId) return undefined;

    // 推断 JID（卡片回调不提供 chat_type，用 chatId 前缀推断）
    // open_chat_id 通常是 oc_ 前缀，属于群组
    const jid = chatId.startsWith('ou_')
      ? `feishu:user:${chatId}`
      : `feishu:group:${chatId}`;

    let result: string | undefined;
    for (const h of this.callbackQueryHandlers) {
      try {
        const r = h(callbackData, jid);
        if (typeof r === 'string' && !result) result = r;
      } catch (e) {
        console.error('[FeishuChannel] callbackQueryHandler error:', e);
      }
    }
    return result;
  }

  /**
   * 解析发送者名称（通过 contact API，带缓存）。
   */
  private async resolveSenderName(client: Lark.Client, openId: string): Promise<string> {
    if (!openId) return 'Unknown';

    const now = Date.now();
    const cached = senderNameCache.get(openId);
    if (cached && cached.expireAt > now) return cached.name;

    try {
      const res = await client.contact.user.get({
        path: { user_id: openId },
        params: { user_id_type: 'open_id' },
      });
      const name = (res as any)?.data?.user?.name ?? 'Unknown';
      senderNameCache.set(openId, { name, expireAt: now + SENDER_NAME_TTL_MS });
      return name;
    } catch {
      // 联系人 API 可能无权限，降级用 open_id
      const fallback = openId.slice(0, 8) + '...';
      senderNameCache.set(openId, { name: fallback, expireAt: now + SENDER_NAME_TTL_MS });
      return fallback;
    }
  }
}

// ===== JID 工具函数 =====

function jidToChatId(jid: string): string | null {
  // feishu:user:ou_xxx → 私聊用 open_id 作为 receive_id
  // feishu:group:oc_xxx → 群组用 chat_id
  const m = jid.match(/^feishu:(?:user|group):(.+)$/);
  return m ? m[1] : null;
}

/** 根据 JID 类型返回正确的 receive_id_type */
function jidToReceiveIdType(jid: string): 'open_id' | 'chat_id' {
  return jid.startsWith('feishu:user:') ? 'open_id' : 'chat_id';
}

/**
 * Monkey-patch WSClient 以支持 card 类型消息。
 *
 * SDK 的 handleEventData 只处理 type="event"，忽略 type="card"。
 * 此补丁拦截 communicate 方法，在 card 消息到达时解析 payload，
 * 调用 cardHandler 获取响应（如 toast），然后通过 WS 回传给飞书。
 */
