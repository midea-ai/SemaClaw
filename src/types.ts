/**
 * SemaClaw 共享类型定义
 */

// ===== Channel Layer =====

export interface IncomingMessage {
  /** 平台消息 ID（用于去重） */
  id: string;
  /** 标准化聊天 ID，格式：tg:user:{userId} | tg:group:{chatId} */
  chatJid: string;
  senderName: string;
  senderJid: string;
  content: string;
  /** ISO 8601 */
  timestamp: string;
  isFromMe: boolean;
  chatType: 'private' | 'group' | 'supergroup';
  /** 消息是否包含对 Bot 的 mention */
  mentionsBotUsername?: boolean;
  /** 接收此消息的 Bot token（多 Bot 场景） */
  botToken?: string;
  /**
   * 平台原始消息 ID（用于被动回复场景，如 QQ Bot 要求携带原始 msg_id）。
   * 仅在需要时由 Channel 填充。
   */
  nativeMsgId?: string;
}

export interface ChatMeta {
  jid: string;
  title?: string;
  type: 'private' | 'group' | 'supergroup';
}

// ===== Inline Button (A1) =====

export interface InlineButton {
  /** 按钮显示文字 */
  label: string;
  /** 回调数据（平台内部用，不显示给用户） */
  callbackData: string;
}

export interface IChannel {
  id: string; // 'telegram' | 'whatsapp'

  connect(): Promise<void>;
  disconnect(): Promise<void>;
  isConnected(): boolean;

  sendMessage(chatJid: string, text: string, botToken?: string): Promise<void>;
  setTyping?(chatJid: string, active: boolean, botToken?: string): Promise<void>;
  ownsJid(chatJid: string): boolean;

  onMessage(handler: (msg: IncomingMessage) => void): void;
  onChatMetadata(handler: (jid: string, meta: ChatMeta) => void): void;

  /** Telegram 专用：获取 bot username（用于触发词检测） */
  getBotUsername?(botToken?: string): string | undefined;

  /**
   * 发送带内联按钮的消息（权限交互用）。
   * 平台不支持时可不实现（optional）。
   */
  sendWithButtons?(
    chatJid: string,
    text: string,
    buttons: InlineButton[],
    botToken?: string,
  ): Promise<void>;

  /**
   * 注册内联按钮回调处理器。
   * callbackData 是 sendWithButtons 里设定的 callbackData。
   */
  onCallbackQuery?(handler: (callbackData: string, chatJid: string) => string | void): void;

  /**
   * 发送文件。
   * platform 不支持时可不实现（optional）。
   */
  sendDocument?(
    chatJid: string,
    filePath: string,
    caption?: string,
    botToken?: string,
  ): Promise<void>;
}

// ===== Gateway Layer =====

/**
 * 群组绑定记录：从 chatJid 到 Agent 工作目录的映射规则
 */
export interface GroupBinding {
  /** 群组/私聊的 chatJid（如 tg:group:-1001234567890） */
  jid: string;
  /** groups/ 下的目录名，仅字母数字连字符 */
  folder: string;
  /** 群组显示名称 */
  name: string;
  /** 通道类型。空字符串表示仅 Web（无 Channel 绑定） */
  channel: string;
  /** 主频道标记，拥有管理权限 */
  isAdmin: boolean;
  /**
   * 是否需要触发词才响应（群组默认 true，私聊默认 false）。
   * isAdmin 群组不受此限制。
   */
  requiresTrigger: boolean;
  /**
   * 工具白名单，null 表示全部允许。
   * isAdmin 默认 ['Read','Glob','Grep']
   */
  allowedTools: string[] | null;
  /**
   * Bash 工具额外路径白名单（读写均校验）。
   * 默认允许 groups/{folder}/ 及子目录。
   */
  allowedPaths: string[] | null;
  /**
   * Agent 可切换的工作目录白名单（WorkspaceTool 使用）。
   * null = 不允许切换，agent 只能在 workspaceDir/{folder}/ 下工作。
   * 列表内的目录免权限切换，列表外的目录需要用户授权。
   */
  allowedWorkDirs: string[] | null;
  /**
   * 绑定的 Bot token（多 Bot 场景）。
   * null 表示使用全局默认 TELEGRAM_BOT_TOKEN。
   */
  botToken: string | null;
  /** 消息保留条数上限，null 表示使用全局 MAX_MESSAGES_PER_GROUP */
  maxMessages: number | null;
  /** 最后一次 Agent 响应时间（ISO 8601） */
  lastActive: string | null;
  addedAt: string;
}

// ===== DB Layer =====

export interface StoredMessage {
  messageId: string;
  chatJid: string;
  senderJid: string;
  senderName: string;
  content: string;
  timestamp: string;
  isFromMe: boolean;
  isBotReply: boolean;
  replyToId: string | null;
  mediaType: string | null;
}

export interface TaskRunLog {
  id: number;
  taskId: string;
  runAt: string;
  durationMs: number | null;
  status: 'success' | 'error';
  result: string | null;
  error: string | null;
}

export interface ScheduledTask {
  id: string;
  groupFolder: string;
  chatJid: string;
  prompt: string;
  scheduleType: 'cron' | 'interval' | 'once';
  scheduleValue: string;
  contextMode: 'isolated' | 'group' | 'notify' | 'script' | 'script-agent';
  /** script / script-agent 模式：要执行的 shell 命令（如 "python3 /path/to/script.py"） */
  scriptCommand: string | null;
  nextRun: string | null;
  lastRun: string | null;
  lastResult: string | null;
  status: 'active' | 'paused' | 'completed' | 'error';
  createdAt: string;
}
