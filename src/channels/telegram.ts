/**
 * TelegramChannel — grammY 接入，实现 IChannel 接口
 *
 * 多 Bot 支持：
 *   - 每个 Bot token 独立维护一个 grammY Bot 实例
 *   - addBot(token) 懒初始化，启动轮询
 *   - 所有 Bot 共享同一组 message/metadata handler
 *
 * JID 格式（bot 感知，支持同一用户对话不同 bot 路由到不同 folder）：
 *   - 私聊：tg:{botUserId}:user:{chatId}
 *   - 群组/超级群组：tg:{botUserId}:group:{chatId}
 *
 * botUserId 由 bot.botInfo.id 自动获取，用户无需手动提供。
 */

import * as fs from 'fs';
import { Bot, Context, InputFile } from 'grammy';
import { InlineKeyboard } from 'grammy';
import type { Message } from 'grammy/types';
import { IChannel, IncomingMessage, ChatMeta, InlineButton } from '../types';

// ===== Helpers =====

function chatIdToJid(chatId: number, chatType: string, botUserId: number): string {
  const suffix = chatType === 'private' ? `user:${chatId}` : `group:${chatId}`;
  return `tg:${botUserId}:${suffix}`;
}

function jidToChatId(jid: string): number | null {
  // 支持新格式 tg:{botId}:user:{id} 和旧格式 tg:user:{id}（兼容已有 DB 记录）
  const m = jid.match(/^tg:(?:\d+:)?(?:user|group):(-?\d+)$/);
  return m ? parseInt(m[1], 10) : null;
}

/**
 * Telegram 单条消息上限。保留少量 buffer 给消息分割逻辑。
 */
const TG_MAX_LEN = 4096;

/** bot.init() 网络超时，超时后跳过该 bot，不阻塞启动流程 */
const BOT_INIT_TIMEOUT_MS = 15_000;

/**
 * 将长文本拆分为 Telegram 允许的多段，尽量在换行处切分。
 */
function splitMessage(text: string): string[] {
  if (text.length <= TG_MAX_LEN) return [text];

  const parts: string[] = [];
  let remaining = text;

  while (remaining.length > TG_MAX_LEN) {
    const chunk = remaining.slice(0, TG_MAX_LEN);
    // 优先在换行处切割（至少占到一半长度时才用）
    const lastNL = chunk.lastIndexOf('\n');
    const splitAt = lastNL > TG_MAX_LEN * 0.5 ? lastNL : TG_MAX_LEN;
    parts.push(remaining.slice(0, splitAt));
    remaining = remaining.slice(splitAt).replace(/^\n/, '');
  }

  if (remaining.length > 0) parts.push(remaining);
  return parts;
}

/**
 * 检测消息是否 mention 了指定 bot username。
 * 优先通过实体（entities）精确检测，其次 fallback 到文本搜索。
 */
function checkMention(msg: Message, botUsername: string): boolean {
  const entities = msg.entities ?? msg.caption_entities ?? [];
  const text = msg.text ?? msg.caption ?? '';
  const lowerBot = `@${botUsername.toLowerCase()}`;

  for (const entity of entities) {
    if (entity.type === 'mention') {
      const mention = text.slice(entity.offset, entity.offset + entity.length);
      if (mention.toLowerCase() === lowerBot) return true;
    }
  }

  // Fallback：纯文本检测（处理 entities 缺失的情况）
  return text.toLowerCase().includes(lowerBot);
}

// ===== TelegramChannel =====

interface BotEntry {
  bot: Bot;
  username: string;
  botUserId: number;
}

type CallbackQueryHandler = (callbackData: string, chatJid: string) => string | void;

export class TelegramChannel implements IChannel {
  readonly id = 'telegram';

  /** token → BotEntry */
  private bots = new Map<string, BotEntry>();

  private messageHandlers: Array<(msg: IncomingMessage) => void> = [];
  private metaHandlers: Array<(jid: string, meta: ChatMeta) => void> = [];
  private callbackQueryHandlers: CallbackQueryHandler[] = [];

  /** typing 定时器：chatJid → IntervalTimer */
  private typingTimers = new Map<string, ReturnType<typeof setInterval>>();

  /** 正在停止中（disconnect 调用），不再自动重试 */
  private stopping = false;

  private connected = false;

  constructor(private readonly defaultToken: string) {}

  // ===== IChannel =====

  async connect(): Promise<void> {
    if (this.connected) return;
    if (!this.defaultToken) {
      console.warn('[TelegramChannel] No bot token configured, Telegram disabled');
      return;
    }
    await this.addBot(this.defaultToken);
    // connected flag 由 addBot() 内部成功初始化后设置，此处不重复设置
  }

  async disconnect(): Promise<void> {
    this.stopping = true;

    // 停止所有 typing timers
    for (const timer of this.typingTimers.values()) clearInterval(timer);
    this.typingTimers.clear();

    // 停止所有 bots
    const stops = [...this.bots.values()].map(({ bot }) =>
      bot.stop().catch(() => {})
    );
    await Promise.all(stops);
    this.bots.clear();
    this.connected = false;
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
    return chatJid.startsWith('tg:');
  }

  getBotUsername(botToken?: string): string | undefined {
    const token = botToken ?? this.defaultToken;
    return this.bots.get(token)?.username;
  }

  /** 获取指定 token 对应 bot 自身的 Telegram User ID（init 后可用） */
  getBotUserId(botToken?: string): number | undefined {
    const token = botToken ?? this.defaultToken;
    return this.bots.get(token)?.botUserId;
  }

  async sendMessage(chatJid: string, text: string, botToken?: string): Promise<void> {
    const entry = this.resolveBot(botToken);
    if (!entry) return;
    const chatId = jidToChatId(chatJid);
    if (chatId === null) throw new Error(`Invalid Telegram JID: ${chatJid}`);

    const parts = splitMessage(text);
    for (const part of parts) {
      await entry.bot.api.sendMessage(chatId, part);
    }
  }

  /**
   * 发送 typing 指示器。
   * active=true：立即发送一次，然后每 4 秒重发（Telegram 5 秒后自动清除）。
   * active=false：停止重发。
   */
  async setTyping(chatJid: string, active: boolean, botToken?: string): Promise<void> {
    const existing = this.typingTimers.get(chatJid);
    if (existing) {
      clearInterval(existing);
      this.typingTimers.delete(chatJid);
    }

    if (!active) return;

    const entry = this.resolveBot(botToken);
    if (!entry) return;
    const chatId = jidToChatId(chatJid);
    if (chatId === null) return;

    const sendTyping = (): void => {
      entry.bot.api.sendChatAction(chatId, 'typing').catch(() => {});
    };

    sendTyping();
    this.typingTimers.set(chatJid, setInterval(sendTyping, 4000));
  }

  /**
   * 发送带内联按钮的消息（权限交互用）。
   * buttons 按行排列，每行一个按钮（简单场景）。
   */
  async sendWithButtons(
    chatJid: string,
    text: string,
    buttons: InlineButton[],
    botToken?: string,
  ): Promise<void> {
    const entry = this.resolveBot(botToken);
    if (!entry) return;
    const chatId = jidToChatId(chatJid);
    if (chatId === null) throw new Error(`Invalid Telegram JID: ${chatJid}`);

    const keyboard = new InlineKeyboard();
    for (const btn of buttons) {
      keyboard.text(btn.label, btn.callbackData).row();
    }

    await entry.bot.api.sendMessage(chatId, text, { reply_markup: keyboard });
  }

  /** 注册内联按钮回调处理器 */
  onCallbackQuery(handler: CallbackQueryHandler): void {
    this.callbackQueryHandlers.push(handler);
  }

  /**
   * 发送本地文件（document 类型）。
   * filePath 为绝对路径。
   */
  async sendDocument(
    chatJid: string,
    filePath: string,
    caption?: string,
    botToken?: string,
  ): Promise<void> {
    const entry = this.resolveBot(botToken);
    if (!entry) return;
    const chatId = jidToChatId(chatJid);
    if (chatId === null) throw new Error(`Invalid Telegram JID: ${chatJid}`);

    const stream = fs.createReadStream(filePath);
    const filename = filePath.split('/').pop() ?? 'file';
    await entry.bot.api.sendDocument(chatId, new InputFile(stream, filename), {
      caption: caption,
    });
  }

  // ===== 多 Bot 管理 =====

  /**
   * 注册并启动一个 Bot（幂等）。
   * 在 connect() 时自动调用 defaultToken；
   * 其他 token 在 GroupManager 加载已注册群组后按需调用。
   */
  async addBot(token: string): Promise<void> {
    if (!token) return;
    if (this.bots.has(token)) return;

    const bot = new Bot(token);

    // botUserId 在 init() 后填入，callback_query handler 通过闭包引用
    let botUserId = 0;

    // 注册消息 handler
    bot.on('message', (ctx) => {
      console.log(`[TelegramChannel] Raw update: chat=${ctx.chat?.id} type=${ctx.chat?.type} text="${(ctx.message?.text ?? '').slice(0, 60)}"`);
      this.handleMessage(ctx, token);
    });

    // 注册 callback_query handler（内联按钮点击）
    bot.on('callback_query:data', (ctx) => {
      const data = ctx.callbackQuery.data;
      const chatId = ctx.callbackQuery.message?.chat?.id;
      const chatType = ctx.callbackQuery.message?.chat?.type;
      let answerText: string | undefined;
      if (data && chatId !== undefined && chatType && botUserId) {
        const jid = chatIdToJid(chatId, chatType, botUserId);
        for (const h of this.callbackQueryHandlers) {
          try {
            const ret = h(data, jid);
            if (ret && !answerText) answerText = ret;
          } catch (e) { console.error('[TelegramChannel] callbackQueryHandler error:', e); }
        }
      }
      // 应答 callback，传入确认文字（Telegram toast）避免 loading 闪烁
      ctx.answerCallbackQuery({ text: answerText }).catch(() => {});
    });

    // 初始化（获取 botInfo）。token 无效或网络不通时记录错误并跳过，不影响其他 bot 或启动流程
    const initPromise = bot.init();
    let initTimeoutId: ReturnType<typeof setTimeout>;
    const initTimeout = new Promise<never>((_, reject) => {
      initTimeoutId = setTimeout(() => reject(new Error(`bot.init() timed out after ${BOT_INIT_TIMEOUT_MS / 1000}s`)), BOT_INIT_TIMEOUT_MS);
    });
    try {
      await Promise.race([initPromise, initTimeout]);
      clearTimeout(initTimeoutId!);
    } catch (err) {
      clearTimeout(initTimeoutId!);
      initPromise.catch(() => {}); // 防止超时后 init 完成时产生 unhandled rejection
      console.error(`[TelegramChannel] Failed to initialize bot:`, err instanceof Error ? err.message : err);
      return;
    }
    const username = bot.botInfo.username;
    botUserId = bot.botInfo.id; // 填入 botUserId，callback_query 闭包同步可见

    this.bots.set(token, { bot, username, botUserId });
    this.connected = true;

    // start() 是长跑 Promise，不 await；异常退出后自动重试
    this.startPollingWithRetry(bot, username);
  }

  /**
   * 启动 polling 并在异常退出后自动重试（指数退避，最大 30s）。
   * disconnect() 设置 stopping=true 时不再重试。
   */
  private startPollingWithRetry(bot: Bot, username: string, attempt = 0): void {
    bot.start({
      onStart: () => {
        console.log(`[TelegramChannel] Bot @${username} started polling`);
        attempt = 0; // 成功启动后重置计数
      },
    }).catch((err: Error) => {
      if (this.stopping) return; // 正在关闭，不重试

      const delay = Math.min(5_000 * 2 ** attempt, 30_000);
      console.error(
        `[TelegramChannel] Bot @${username} polling error (retry in ${delay / 1000}s):`,
        err.message,
      );
      setTimeout(() => {
        if (this.stopping) return;
        this.startPollingWithRetry(bot, username, attempt + 1);
      }, delay);
    });
  }

  // ===== Internal =====

  private resolveBot(botToken?: string): BotEntry | null {
    if (this.bots.size === 0) return null;
    const token = botToken ?? this.defaultToken;
    return this.bots.get(token) ?? null;
  }

  private handleMessage(ctx: Context, token: string): void {
    const msg = ctx.message;
    if (!msg) return;

    // 只处理文本消息（含 caption）
    const content = msg.text ?? msg.caption ?? '';
    if (!content.trim()) return;

    const chat = ctx.chat;
    if (!chat) return;

    const chatType = chat.type; // 'private' | 'group' | 'supergroup' | 'channel'
    if (chatType === 'channel') return; // 不处理频道消息

    const chatId = chat.id;

    // isFromMe：Bot 自己发的消息（一般不会走这里，但以防万一）
    const botUserId = ctx.me?.id ?? this.bots.get(token)?.botUserId ?? 0;
    const jid = chatIdToJid(chatId, chatType, botUserId);

    const from = msg.from;
    const senderName = from
      ? [from.first_name, from.last_name].filter(Boolean).join(' ')
      : 'Unknown';
    const senderJid = from ? `tg:user:${from.id}` : 'tg:user:0';

    const isFromMe = from?.id === botUserId;

    const entry = this.bots.get(token);
    const mentionsBotUsername = entry
      ? checkMention(msg, entry.username)
      : false;

    const incoming: IncomingMessage = {
      id: `${chatId}:${msg.message_id}`,
      chatJid: jid,
      senderName,
      senderJid,
      content,
      timestamp: new Date(msg.date * 1000).toISOString(),
      isFromMe,
      chatType: chatType as 'private' | 'group' | 'supergroup',
      mentionsBotUsername,
      botToken: token,
    };

    // 派发给上层 handler（MessageRouter）
    for (const h of this.messageHandlers) {
      try { h(incoming); } catch (e) { console.error('[TelegramChannel] messageHandler error:', e); }
    }

    // 更新 chat metadata（供 GroupManager 使用）
    const chatTitle = 'title' in chat ? chat.title : senderName;
    const meta: ChatMeta = {
      jid,
      title: chatTitle,
      type: chatType as 'private' | 'group' | 'supergroup',
    };
    for (const h of this.metaHandlers) {
      try { h(jid, meta); } catch (e) { console.error('[TelegramChannel] metaHandler error:', e); }
    }
  }
}
