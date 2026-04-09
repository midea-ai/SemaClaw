/**
 * WeChatChannel — iLink Bot API (ilinkai.weixin.qq.com) 接入
 *
 * 底层协议：腾讯微信官方 iLink Bot HTTP API
 * 消息传输：HTTP 长轮询（getUpdates，服务端最长持有 35s）
 * 认证方式：Bearer ilink_bot_token
 *
 * 登录流程：
 *   1. GET /ilink/bot/get_bot_qrcode?bot_type=3 → 获取二维码
 *   2. 用户扫码后 GET /ilink/bot/get_qrcode_status?qrcode=xxx 轮询确认
 *   3. confirmed 时拿到 bot_token + baseurl，存入 ~/.semaclaw/wechat/accounts/
 *
 * JID 格式：wx:user:{ilink_user_id}
 *
 * 注意：iLink Bot 当前仅支持 1:1 私聊，group_id 字段保留但实际为空。
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
// eslint-disable-next-line @typescript-eslint/no-require-imports
const qrterm = require('qrcode-terminal') as { generate: (text: string, opts: { small: boolean }) => void };
import type { IChannel, IncomingMessage, ChatMeta, InlineButton } from '../types';
type CallbackQueryHandler = (callbackData: string, chatJid: string) => string | void;

// ─────────────────────────────────────────────
// iLink 协议常量
// ─────────────────────────────────────────────

const DEFAULT_BASE_URL = 'https://ilinkai.weixin.qq.com';
const DEFAULT_LONG_POLL_TIMEOUT_MS = 35_000;
const DEFAULT_API_TIMEOUT_MS = 15_000;
const QR_LONG_POLL_TIMEOUT_MS = 35_000;
const MAX_QR_REFRESH = 3;
const MAX_CONSECUTIVE_FAILURES = 3;
const BACKOFF_DELAY_MS = 30_000;
const RETRY_DELAY_MS = 2_000;
const SESSION_EXPIRED_ERRCODE = -14;
const MENU_TTL_MS = 5 * 60 * 1000; // 数字菜单等待超时

const MessageType = { USER: 1, BOT: 2 } as const;
const MessageItemType = { TEXT: 1, IMAGE: 2, VOICE: 3, FILE: 4, VIDEO: 5 } as const;
const MessageState = { FINISH: 2 } as const;

// ─────────────────────────────────────────────
// iLink 协议类型
// ─────────────────────────────────────────────

interface MessageItem {
  type?: number;
  text_item?: { text?: string };
  voice_item?: { text?: string };
}

interface WeixinMessage {
  seq?: number;
  message_id?: number;
  from_user_id?: string;
  to_user_id?: string;
  client_id?: string;
  create_time_ms?: number;
  message_type?: number;
  item_list?: MessageItem[];
  context_token?: string;
}

interface GetUpdatesResp {
  ret?: number;
  errcode?: number;
  errmsg?: string;
  msgs?: WeixinMessage[];
  get_updates_buf?: string;
  longpolling_timeout_ms?: number;
}

// ─────────────────────────────────────────────
// 凭证存储
// ─────────────────────────────────────────────

interface WeixinAccountData {
  token: string;
  baseUrl?: string;
  /** 扫码绑定者的 ilink_user_id（即微信用户 ID） */
  userId?: string;
  savedAt: string;
}

function resolveWeixinStateDir(): string {
  return path.join(os.homedir(), '.semaclaw', 'wechat', 'accounts');
}

function resolveAccountPath(accountId: string): string {
  return path.join(resolveWeixinStateDir(), `${accountId}.json`);
}

function loadAccount(accountId: string): WeixinAccountData | null {
  try {
    const p = resolveAccountPath(accountId);
    if (!fs.existsSync(p)) return null;
    return JSON.parse(fs.readFileSync(p, 'utf-8')) as WeixinAccountData;
  } catch {
    return null;
  }
}

function saveAccount(accountId: string, data: WeixinAccountData): void {
  const dir = resolveWeixinStateDir();
  fs.mkdirSync(dir, { recursive: true });
  const p = resolveAccountPath(accountId);
  fs.writeFileSync(p, JSON.stringify(data, null, 2), 'utf-8');
  try { fs.chmodSync(p, 0o600); } catch { /* best-effort */ }
}

// ─────────────────────────────────────────────
// HTTP 工具
// ─────────────────────────────────────────────

function randomWechatUin(): string {
  const uint32 = crypto.randomBytes(4).readUInt32BE(0);
  return Buffer.from(String(uint32), 'utf-8').toString('base64');
}

function ensureSlash(url: string): string {
  return url.endsWith('/') ? url : `${url}/`;
}

async function apiFetch(params: {
  baseUrl: string;
  endpoint: string;
  body: string;
  token?: string;
  timeoutMs: number;
}): Promise<string> {
  const url = new URL(params.endpoint, ensureSlash(params.baseUrl));
  const bodyBytes = Buffer.byteLength(params.body, 'utf-8');
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'Content-Length': String(bodyBytes),
    'AuthorizationType': 'ilink_bot_token',
    'X-WECHAT-UIN': randomWechatUin(),
  };
  if (params.token) {
    headers['Authorization'] = `Bearer ${params.token}`;
  }

  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), params.timeoutMs);
  try {
    const res = await fetch(url.toString(), {
      method: 'POST',
      headers,
      body: params.body,
      signal: ctrl.signal,
    });
    clearTimeout(t);
    const text = await res.text();
    if (!res.ok) throw new Error(`${params.endpoint} ${res.status}: ${text}`);
    return text;
  } catch (err) {
    clearTimeout(t);
    throw err;
  }
}

async function iLinkGetUpdates(opts: {
  baseUrl: string;
  token?: string;
  getUpdatesBuf: string;
  timeoutMs?: number;
}): Promise<GetUpdatesResp> {
  const timeout = opts.timeoutMs ?? DEFAULT_LONG_POLL_TIMEOUT_MS;
  try {
    const raw = await apiFetch({
      baseUrl: opts.baseUrl,
      endpoint: 'ilink/bot/getupdates',
      body: JSON.stringify({ get_updates_buf: opts.getUpdatesBuf }),
      token: opts.token,
      timeoutMs: timeout + 5_000, // 给服务端 timeout 留 5s 缓冲
    });
    return JSON.parse(raw) as GetUpdatesResp;
  } catch (err) {
    if (err instanceof Error && err.name === 'AbortError') {
      return { ret: 0, msgs: [], get_updates_buf: opts.getUpdatesBuf };
    }
    throw err;
  }
}

async function iLinkSendMessage(opts: {
  baseUrl: string;
  token?: string;
  toUserId: string;
  text: string;
  contextToken?: string;
}): Promise<void> {
  const clientId = `semaclaw-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`;
  const body = {
    msg: {
      from_user_id: '',
      to_user_id: opts.toUserId,
      client_id: clientId,
      message_type: MessageType.BOT,
      message_state: MessageState.FINISH,
      item_list: [{ type: MessageItemType.TEXT, text_item: { text: opts.text } }],
      context_token: opts.contextToken,
    },
  };
  await apiFetch({
    baseUrl: opts.baseUrl,
    endpoint: 'ilink/bot/sendmessage',
    body: JSON.stringify(body),
    token: opts.token,
    timeoutMs: DEFAULT_API_TIMEOUT_MS,
  });
}

// ─────────────────────────────────────────────
// QR 登录
// ─────────────────────────────────────────────

async function fetchQRCode(apiBaseUrl: string): Promise<{ qrcode: string; qrcode_img_content: string }> {
  const url = new URL(
    `ilink/bot/get_bot_qrcode?bot_type=3`,
    ensureSlash(apiBaseUrl),
  );
  const res = await fetch(url.toString());
  if (!res.ok) throw new Error(`get_bot_qrcode ${res.status}: ${await res.text()}`);
  return res.json() as Promise<{ qrcode: string; qrcode_img_content: string }>;
}

async function pollQRStatus(apiBaseUrl: string, qrcode: string): Promise<{
  status: 'wait' | 'scaned' | 'confirmed' | 'expired';
  bot_token?: string;
  ilink_bot_id?: string;
  baseurl?: string;
  ilink_user_id?: string;
}> {
  const url = new URL(
    `ilink/bot/get_qrcode_status?qrcode=${encodeURIComponent(qrcode)}`,
    ensureSlash(apiBaseUrl),
  );
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), QR_LONG_POLL_TIMEOUT_MS);
  try {
    const res = await fetch(url.toString(), {
      headers: { 'iLink-App-ClientVersion': '1' },
      signal: ctrl.signal,
    });
    clearTimeout(t);
    const text = await res.text();
    if (!res.ok) throw new Error(`get_qrcode_status ${res.status}: ${text}`);
    return JSON.parse(text);
  } catch (err) {
    clearTimeout(t);
    if (err instanceof Error && err.name === 'AbortError') return { status: 'wait' };
    throw err;
  }
}

/**
 * 执行完整 QR 登录流程，返回登录后的凭证。
 * 二维码 URL 和终端二维码会打印到 stdout。
 */
async function runQrLogin(apiBaseUrl: string): Promise<WeixinAccountData & { accountId: string }> {
  let qrData = await fetchQRCode(apiBaseUrl);
  console.log(`\n[WeChatChannel] 请用微信扫描二维码登录：`);
  qrterm.generate(qrData.qrcode_img_content, { small: true });
  console.log(`  ${qrData.qrcode_img_content}\n`);

  let refreshCount = 0;
  let scannedPrinted = false;

  while (true) {
    const status = await pollQRStatus(apiBaseUrl, qrData.qrcode);

    if (status.status === 'wait') {
      process.stdout.write('.');
      await sleep(1000);
      continue;
    }

    if (status.status === 'scaned') {
      if (!scannedPrinted) {
        process.stdout.write('\n[WeChatChannel] 已扫码，请在微信中确认...\n');
        scannedPrinted = true;
      }
      await sleep(1000);
      continue;
    }

    if (status.status === 'expired') {
      refreshCount++;
      if (refreshCount > MAX_QR_REFRESH) {
        throw new Error('二维码多次过期，请重新启动登录流程');
      }
      process.stdout.write(`\n[WeChatChannel] 二维码过期，正在刷新 (${refreshCount}/${MAX_QR_REFRESH})...\n`);
      qrData = await fetchQRCode(apiBaseUrl);
      qrterm.generate(qrData.qrcode_img_content, { small: true });
      console.log(`  ${qrData.qrcode_img_content}\n`);
      scannedPrinted = false;
      continue;
    }

    if (status.status === 'confirmed') {
      if (!status.ilink_bot_id || !status.bot_token) {
        throw new Error('登录确认但服务端未返回 ilink_bot_id 或 bot_token');
      }
      process.stdout.write('\n[WeChatChannel] 微信登录成功！\n');
      if (status.ilink_user_id) {
        console.log(`[WeChatChannel] 绑定用户: ${status.ilink_user_id}`);
      } else {
        console.warn('[WeChatChannel] 服务端未返回 ilink_user_id，首条消息收到后自动绑定');
      }
      return {
        accountId: status.ilink_bot_id,
        token: status.bot_token,
        baseUrl: status.baseurl || apiBaseUrl,
        userId: status.ilink_user_id,
        savedAt: new Date().toISOString(),
      };
    }

    await sleep(1000);
  }
}

// ─────────────────────────────────────────────
// Markdown → 纯文本（微信不渲染 Markdown）
// ─────────────────────────────────────────────

function markdownToPlain(text: string): string {
  let r = text;
  // 代码块：保留内容，去掉围栏
  r = r.replace(/```[^\n]*\n?([\s\S]*?)```/g, (_, code: string) => code.trim());
  // 图片：整体移除
  r = r.replace(/!\[[^\]]*\]\([^)]*\)/g, '');
  // 链接：只保留显示文字
  r = r.replace(/\[([^\]]+)\]\([^)]*\)/g, '$1');
  // 表格分隔行：移除
  r = r.replace(/^\|[\s:|-]+\|$/gm, '');
  // 表格内容行：把竖线转为空格
  r = r.replace(/^\|(.+)\|$/gm, (_, inner: string) =>
    inner.split('|').map((c) => c.trim()).join('  '),
  );
  // 加粗/斜体：去掉标记
  r = r.replace(/\*\*([^*]+)\*\*/g, '$1');
  r = r.replace(/\*([^*]+)\*/g, '$1');
  r = r.replace(/__([^_]+)__/g, '$1');
  r = r.replace(/_([^_]+)_/g, '$1');
  // 标题：去掉 # 前缀
  r = r.replace(/^#{1,6}\s+/gm, '');
  // 行内代码：去掉反引号
  r = r.replace(/`([^`]+)`/g, '$1');
  return r.trim();
}

// ─────────────────────────────────────────────
// 工具函数
// ─────────────────────────────────────────────

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => { clearTimeout(t); reject(new Error('aborted')); }, { once: true });
  });
}

function extractText(items?: MessageItem[]): string {
  if (!items?.length) return '';
  for (const item of items) {
    if (item.type === MessageItemType.TEXT && item.text_item?.text) {
      return item.text_item.text;
    }
    // 语音转文字
    if (item.type === MessageItemType.VOICE && item.voice_item?.text) {
      return `[语音] ${item.voice_item.text}`;
    }
  }
  // 非文本消息给出简单提示
  const first = items[0];
  const typeLabel: Record<number, string> = {
    [MessageItemType.IMAGE]: '[图片]',
    [MessageItemType.VOICE]: '[语音]',
    [MessageItemType.FILE]: '[文件]',
    [MessageItemType.VIDEO]: '[视频]',
  };
  return typeLabel[first.type ?? 0] ?? '[消息]';
}

// ─────────────────────────────────────────────
// WeChatChannel
// ─────────────────────────────────────────────

export class WeChatChannel implements IChannel {
  readonly id = 'wechat';

  /** 账户标识（对应 config.json wechatAccounts 的 key，默认 'default'） */
  readonly accountId: string = 'default';

  private token: string | undefined;
  private baseUrl: string = DEFAULT_BASE_URL;

  /** userId → 最新 context_token（来自最近一条入站消息，回复时必须携带；磁盘持久化跨重启） */
  private contextTokens = new Map<string, string>();

  /** getUpdates 游标，跨重启从磁盘恢复 */
  private getUpdatesBuf: string = '';

  private abortCtrl: AbortController | null = null;
  private connected = false;

  private messageHandlers: Array<(msg: IncomingMessage) => void> = [];
  private metaHandlers: Array<(jid: string, meta: ChatMeta) => void> = [];
  private callbackQueryHandlers: CallbackQueryHandler[] = [];
  /** chatJid → 待选项队列（数字菜单降级） */
  private pendingMenuQueues = new Map<string, Array<{ options: InlineButton[]; timer: ReturnType<typeof setTimeout> }>>();

  /**
   * @param accountId  账户标识，对应 config.json wechatAccounts 的 key（默认 'default'，兼容旧 env-only 模式）
   * @param apiBaseUrl 允许覆盖默认的 ilinkai.weixin.qq.com（测试用）
   */
  constructor(
    accountId: string = 'default',
    private readonly apiBaseUrl: string = DEFAULT_BASE_URL,
  ) {
    this.accountId = accountId;
  }

  /**
   * 返回扫码绑定者的 JID（wx:user:{ilink_user_id}）。
   * 仅在 connect() 完成且保存了 userId 后有值，否则返回 null。
   */
  getOwnerJid(): string | null {
    const account = loadAccount(this.accountId);
    const userId = account?.userId?.trim();
    return userId ? `wx:user:${userId}` : null;
  }

  // ─── IChannel ───

  async connect(): Promise<void> {
    if (this.connected) return;

    // 尝试从磁盘加载已有凭证
    let account = loadAccount(this.accountId);

    if (!account?.token) {
      // 没有凭证，触发 QR 登录
      console.log('[WeChatChannel] 未找到已保存凭证，开始微信 QR 登录...');
      try {
        const result = await runQrLogin(this.apiBaseUrl);
        // accountId 始终用 'default'，不用 ilink_bot_id 作为文件名
        // 否则重启时用 'default' 找不到文件，会重复触发扫码
        this.token = result.token;
        this.baseUrl = result.baseUrl ?? this.apiBaseUrl;
        saveAccount(this.accountId, {
          token: result.token,
          baseUrl: result.baseUrl,
          userId: result.userId,
          savedAt: result.savedAt,
        });
        account = { token: result.token, baseUrl: result.baseUrl, userId: result.userId, savedAt: result.savedAt };
      } catch (err) {
        throw new Error(`[WeChatChannel] QR 登录失败: ${String(err)}`);
      }
    } else {
      this.token = account.token;
      this.baseUrl = account.baseUrl ?? this.apiBaseUrl;
      console.log(`[WeChatChannel] 已加载凭证 userId=${account.userId ?? '(未知，需重新扫码)'}`);
    }

    // 恢复 getUpdates 游标 + context_token 缓存
    this.getUpdatesBuf = this.loadSyncBuf();
    this.loadContextTokens();

    this.connected = true;
    this.abortCtrl = new AbortController();

    // 在后台启动长轮询，不阻塞 connect() 返回
    this.startPolling(this.abortCtrl.signal).catch((err) => {
      console.error('[WeChatChannel] 轮询意外退出:', err);
      this.connected = false;
    });

    console.log(`[WeChatChannel] 已连接 (accountId=${this.accountId} baseUrl=${this.baseUrl})`);
  }

  async disconnect(): Promise<void> {
    this.abortCtrl?.abort();
    this.abortCtrl = null;
    this.connected = false;
    console.log('[WeChatChannel] 已断开');
  }

  isConnected(): boolean {
    return this.connected;
  }

  ownsJid(chatJid: string): boolean {
    if (!chatJid.startsWith('wx:')) return false;
    // 多实例场景：只认领本实例持有 context_token 的用户 JID，
    // 避免 reply 被路由到错误的 WeChatChannel 实例。
    // 单实例时 contextTokens 是唯一来源，行为不变。
    const userId = jidToUserId(chatJid);
    if (!userId) return false;
    return this.contextTokens.has(userId);
  }

  onMessage(handler: (msg: IncomingMessage) => void): void {
    this.messageHandlers.push(handler);
  }

  onChatMetadata(handler: (jid: string, meta: ChatMeta) => void): void {
    this.metaHandlers.push(handler);
  }

  async sendMessage(chatJid: string, text: string): Promise<void> {
    if (!this.token) throw new Error('[WeChatChannel] 未登录，无法发送消息');
    const userId = jidToUserId(chatJid);
    if (!userId) throw new Error(`[WeChatChannel] 无效 JID: ${chatJid}`);

    const contextToken = this.contextTokens.get(userId);
    if (!contextToken) {
      console.warn(`[WeChatChannel] 无 context_token for userId=${userId}，跳过发送`);
      return;
    }

    const plain = markdownToPlain(text);
    // iLink 单条消息无明确限制，但过长时分段发送（保守取 2000 字）
    const chunks = splitText(plain, 2000);
    for (const chunk of chunks) {
      await iLinkSendMessage({
        baseUrl: this.baseUrl,
        token: this.token,
        toUserId: userId,
        text: chunk,
        contextToken,
      });
    }
  }

  /** 微信无原生按钮，直接降级为数字菜单文本 */
  async sendWithButtons(chatJid: string, text: string, buttons: InlineButton[]): Promise<void> {
    await this._sendTextMenu(chatJid, text, buttons);
  }

  onCallbackQuery(handler: CallbackQueryHandler): void {
    this.callbackQueryHandlers.push(handler);
  }

  /** 将选项格式化为编号文本，入队等待用户数字回复 */
  private async _sendTextMenu(chatJid: string, text: string, buttons: InlineButton[]): Promise<void> {
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
    this.pendingMenuQueues.get(chatJid)!.push({ options: buttons, timer });

    await this.sendMessage(chatJid, fullText);
  }

  /**
   * 尝试将用户消息解释为数字序号回复。
   * 若消费成功返回 true（消息不再往上派发）。
   */
  private tryHandleMenuReply(chatJid: string, content: string): boolean {
    const queue = this.pendingMenuQueues.get(chatJid);
    if (!queue || queue.length === 0) return false;

    const num = parseInt(content.trim(), 10);
    if (isNaN(num) || num < 1 || num > queue[0].options.length) return false;

    const { options, timer } = queue.shift()!;
    clearTimeout(timer);
    if (queue.length === 0) this.pendingMenuQueues.delete(chatJid);

    const selected = options[num - 1];
    let answerText: string | undefined;
    for (const h of this.callbackQueryHandlers) {
      try {
        const ret = h(selected.callbackData, chatJid);
        if (ret && !answerText) answerText = ret;
      } catch (e) { console.error('[WeChatChannel] callbackQueryHandler error:', e); }
    }
    if (answerText) {
      this.sendMessage(chatJid, answerText).catch(() => {});
    }
    return true;
  }

  // ─── 内部：长轮询循环 ───

  private async startPolling(signal: AbortSignal): Promise<void> {
    let nextTimeoutMs = DEFAULT_LONG_POLL_TIMEOUT_MS;
    let consecutiveFailures = 0;

    while (!signal.aborted) {
      try {
        const resp = await iLinkGetUpdates({
          baseUrl: this.baseUrl,
          token: this.token,
          getUpdatesBuf: this.getUpdatesBuf,
          timeoutMs: nextTimeoutMs,
        });

        // 服务端可能下发下次 poll 超时建议
        if (resp.longpolling_timeout_ms && resp.longpolling_timeout_ms > 0) {
          nextTimeoutMs = resp.longpolling_timeout_ms;
        }

        const isApiError =
          (resp.ret !== undefined && resp.ret !== 0) ||
          (resp.errcode !== undefined && resp.errcode !== 0);

        if (isApiError) {
          if (resp.errcode === SESSION_EXPIRED_ERRCODE || resp.ret === SESSION_EXPIRED_ERRCODE) {
            console.error('[WeChatChannel] session 已过期，需要重新扫码登录。请重启服务。');
            this.connected = false;
            return;
          }
          consecutiveFailures++;
          console.error(`[WeChatChannel] getUpdates 错误 ret=${resp.ret} errcode=${resp.errcode} (${consecutiveFailures}/${MAX_CONSECUTIVE_FAILURES})`);
          if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
            consecutiveFailures = 0;
            await sleep(BACKOFF_DELAY_MS, signal);
          } else {
            await sleep(RETRY_DELAY_MS, signal);
          }
          continue;
        }

        consecutiveFailures = 0;

        // 更新并持久化游标
        if (resp.get_updates_buf) {
          this.getUpdatesBuf = resp.get_updates_buf;
          this.saveSyncBuf(resp.get_updates_buf);
        }

        // 处理入站消息
        for (const msg of resp.msgs ?? []) {
          // 只处理用户发来的消息
          if (msg.message_type !== MessageType.USER) continue;
          if (!msg.from_user_id) continue;

          // 缓存 context_token（同时持久化，确保重启后 WebUI 触发的回复也能送达）
          if (msg.context_token) {
            this.contextTokens.set(msg.from_user_id, msg.context_token);
            this.saveContextTokens();
          }

          const text = extractText(msg.item_list);
          const chatJid = userIdToJid(msg.from_user_id);

          // senderName 只取 @ 前面的短 ID，避免 @im.wechat 被 sema-core 解析为文件路径
          const senderName = msg.from_user_id.split('@')[0];

          // 数字菜单降级：优先拦截数字序号回复
          if (this.tryHandleMenuReply(chatJid, text)) continue;

          const incoming: IncomingMessage = {
            id: String(msg.message_id ?? `${msg.from_user_id}-${Date.now()}`),
            chatJid,
            senderJid: chatJid,
            senderName,
            content: text,
            timestamp: msg.create_time_ms
              ? new Date(msg.create_time_ms).toISOString()
              : new Date().toISOString(),
            isFromMe: false,
            chatType: 'private',
            botToken: this.accountId,
          };

          for (const h of this.messageHandlers) {
            try { h(incoming); } catch { /* 防止单个 handler 崩溃影响全局 */ }
          }
        }
      } catch (err) {
        if (signal.aborted) return;
        consecutiveFailures++;
        console.error(`[WeChatChannel] getUpdates 异常 (${consecutiveFailures}/${MAX_CONSECUTIVE_FAILURES}):`, err);
        if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
          consecutiveFailures = 0;
          await sleep(BACKOFF_DELAY_MS, signal).catch(() => {});
        } else {
          await sleep(RETRY_DELAY_MS, signal).catch(() => {});
        }
      }
    }
  }

  // ─── getUpdates 游标持久化 ───

  private syncBufPath(): string {
    return path.join(
      os.homedir(),
      '.semaclaw',
      'wechat',
      `sync-buf-${this.accountId}.bin`,
    );
  }

  private loadSyncBuf(): string {
    try {
      const p = this.syncBufPath();
      if (fs.existsSync(p)) return fs.readFileSync(p, 'utf-8').trim();
    } catch { /* ignore */ }
    return '';
  }

  private saveSyncBuf(buf: string): void {
    try {
      const p = this.syncBufPath();
      fs.mkdirSync(path.dirname(p), { recursive: true });
      fs.writeFileSync(p, buf, 'utf-8');
    } catch { /* best-effort */ }
  }

  // ─── context_token 持久化（跨重启保留，避免 WebUI 触发的回复因无 token 而静默丢失） ───

  private contextTokensPath(): string {
    return path.join(
      os.homedir(),
      '.semaclaw',
      'wechat',
      `context-tokens-${this.accountId}.json`,
    );
  }

  private loadContextTokens(): void {
    try {
      const p = this.contextTokensPath();
      if (!fs.existsSync(p)) return;
      const data = JSON.parse(fs.readFileSync(p, 'utf-8')) as Record<string, string>;
      for (const [userId, token] of Object.entries(data)) {
        this.contextTokens.set(userId, token);
      }
    } catch { /* ignore */ }
  }

  private saveContextTokens(): void {
    try {
      const p = this.contextTokensPath();
      fs.mkdirSync(path.dirname(p), { recursive: true });
      const data = Object.fromEntries(this.contextTokens.entries());
      fs.writeFileSync(p, JSON.stringify(data), 'utf-8');
    } catch { /* best-effort */ }
  }
}

// ─────────────────────────────────────────────
// JID 工具
// ─────────────────────────────────────────────

function userIdToJid(userId: string): string {
  return `wx:user:${userId}`;
}

function jidToUserId(jid: string): string | null {
  const m = jid.match(/^wx:user:(.+)$/);
  return m ? m[1] : null;
}

function splitText(text: string, maxLen: number): string[] {
  if (text.length <= maxLen) return [text];
  const parts: string[] = [];
  let remaining = text;
  while (remaining.length > maxLen) {
    const chunk = remaining.slice(0, maxLen);
    const lastNL = chunk.lastIndexOf('\n');
    const at = lastNL > maxLen * 0.5 ? lastNL : maxLen;
    parts.push(remaining.slice(0, at));
    remaining = remaining.slice(at).replace(/^\n/, '');
  }
  if (remaining.length) parts.push(remaining);
  return parts;
}
