/**
 * PermissionBridge — 将 sema-core 的权限请求中继到 Telegram 内联键盘
 *
 * 职责：
 *   1. 监听 `tool:permission:request` → 发送带按钮的消息给用户
 *   2. 监听 `ask:question:request`    → 发送问题+选项给用户
 *   3. 用户点击按钮后，通过 callback_query 将结果回传 sema-core
 *
 * 设计：
 *   - 单例（AgentPool 创建时初始化一次），用 pendingPermissions/pendingAskQuestions
 *     Map（requestId → pending）路由多群组并发请求
 *   - requestId = 8字符随机hex，确保不同群组的请求不冲突
 *   - Agent 无超时（自然暂停等待响应），用户点击后继续
 */

import { randomBytes } from 'crypto';
import { SemaCore } from 'sema-core';
import type {
  ToolPermissionRequestData,
  AskQuestionRequestData,
} from 'sema-core/event';
import type { IChannel, InlineButton } from '../types';
import type { GroupBinding } from '../types';

// ===== 内部类型 =====

interface PendingPermission {
  toolName: string;
  chatJid: string;
  core: SemaCore;
}

interface PendingAskQuestion {
  agentId: string;
  chatJid: string;
  questions: AskQuestionRequestData['questions'];
  /** Telegram 逐问路径：累积的答案（key=问题文本）。Web UI 批量路径不使用此字段。 */
  answers: Record<string, string>;
  /** Telegram 逐问路径：剩余未回答数量，归零时触发 respondToAskQuestion。 */
  pendingCount: number;
  core: SemaCore;
}

// ===== 对外暴露的 payload 类型 =====

/** WsGateway / 外部 sink 收到权限请求时的数据 */
export interface PermissionPayload {
  toolName: string;
  title: string;
  /** 完整内容（未截断），前端可自行决定是否折叠 */
  content: string;
  options: { key: string; label: string }[];
}

/** WsGateway / 外部 sink 收到问答请求时的数据 */
export interface AskQuestionPayload {
  agentId: string;
  questions: AskQuestionRequestData['questions'];
}

// ===== CallbackData 格式 =====
// 权限: "P:{requestId}:{optionKey}"
// 问答: "Q:{requestId}:{questionIndex}:{optionIndex}"
// Telegram callback_data 最大 64 字节，requestId=8chars，optionKey 通常是 agree/refuse/allow 等

const PREFIX_PERM = 'P';
const PREFIX_ASK  = 'Q';

function shortId(): string {
  return randomBytes(4).toString('hex'); // 8 chars
}

// ===== PermissionBridge 配置 =====

export interface PermissionBridgeOptions {
  /**
   * 权限请求 content 字段的最大展示字符数。
   * 超出部分以 "...(N 字符省略)" 替换。
   *
   * - Telegram 等消息平台建议 200（避免超出单条消息限制）
   * - Web UI 可传 Infinity 或不传（展示完整内容，支持展开/收起）
   *
   * 默认：200
   */
  maxContentLength?: number;
}

// ===== PermissionBridge =====

export class PermissionBridge {
  private pendingPermissions  = new Map<string, PendingPermission>();
  private pendingAskQuestions = new Map<string, PendingAskQuestion>();
  private readonly maxContentLength: number;
  /** 活跃回调：权限消息发出或回调收到时通知外部（用于 AgentPool 重置超时计时器） */
  private onActivity?: (chatJid: string) => void;
  /** WS 通知：权限请求发出时 */
  private onPermissionRequestCb?: (chatJid: string, requestId: string, payload: PermissionPayload) => void;
  /** WS 通知：问答请求发出时 */
  private onAskQuestionRequestCb?: (chatJid: string, requestId: string, payload: AskQuestionPayload) => void;
  /** WS 通知：权限请求被决策时（任意端） */
  private onPermissionResolvedCb?: (chatJid: string, requestId: string, optionKey: string, optionLabel: string) => void;
  /** WS 通知：问答请求被决策时（任意端） */
  private onAskQuestionResolvedCb?: (chatJid: string, requestId: string, answers: Record<string, string>) => void;
  private readonly channels: IChannel[];

  constructor(
    channels: IChannel | IChannel[],
    options: PermissionBridgeOptions = {},
  ) {
    this.channels = Array.isArray(channels) ? channels : [channels];
    this.maxContentLength = options.maxContentLength ?? 200;
    // 全局注册一次 callback_query 处理器（每个 channel 各注册一次）
    for (const channel of this.channels) {
      channel.onCallbackQuery?.((callbackData, chatJid) => {
        return this.handleCallback(callbackData, chatJid);
      });
    }
  }

  /** 根据 chatJid 找到负责的 channel */
  private resolveChannel(chatJid: string): IChannel | undefined {
    return this.channels.find((ch) => ch.ownsJid(chatJid));
  }

  /** 注入活跃回调（AgentPool 内部使用，不暴露给外部配置） */
  setActivityCallback(cb: (chatJid: string) => void): void {
    this.onActivity = cb;
  }

  /** 注入权限请求通知（WsGateway 通过 AgentPool.setAgentEventSink 间接设置） */
  onPermissionRequest(fn: (chatJid: string, requestId: string, payload: PermissionPayload) => void): void {
    this.onPermissionRequestCb = fn;
  }

  /** 注入问答请求通知 */
  onAskQuestionRequest(fn: (chatJid: string, requestId: string, payload: AskQuestionPayload) => void): void {
    this.onAskQuestionRequestCb = fn;
  }

  /** 注入权限决策通知（任意端决策后广播给其他端） */
  onPermissionResolved(fn: (chatJid: string, requestId: string, optionKey: string, optionLabel: string) => void): void {
    this.onPermissionResolvedCb = fn;
  }

  /** 注入问答决策通知（任意端决策后广播给其他端） */
  onAskQuestionResolved(fn: (chatJid: string, requestId: string, answers: Record<string, string>) => void): void {
    this.onAskQuestionResolvedCb = fn;
  }

  /**
   * Web UI 侧决策权限请求（"哪边先响应采用哪边"）。
   * 若 requestId 已被 Telegram 消耗则返回 false，否则返回 true。
   */
  resolvePermission(requestId: string, optionKey: string): boolean {
    const pending = this.pendingPermissions.get(requestId);
    if (!pending) return false;
    this.pendingPermissions.delete(requestId);
    this.onActivity?.(pending.chatJid);
    pending.core.respondToToolPermission({ toolName: pending.toolName, selected: optionKey });
    const label = optionKey.charAt(0).toUpperCase() + optionKey.slice(1);
    this.onPermissionResolvedCb?.(pending.chatJid, requestId, optionKey, label);
    return true;
  }

  /**
   * Web UI 侧批量回答问答请求。
   * answers: { [qi]: oi } 单选 | { [qi]: oi[] } 多选，-1 = Other
   * otherTexts: { [qi]: string } Other 选项的自定义文本
   * 若 requestId 已被 Telegram 消耗则返回 false。
   */
  resolveAskQuestionBatch(requestId: string, answers: Record<number, number | number[]>, otherTexts?: Record<number, string>): boolean {
    const pending = this.pendingAskQuestions.get(requestId);
    if (!pending) return false;

    const OTHER_INDEX = -1;
    const resolvedAnswers: Record<string, string> = {};

    for (const [qiStr, selection] of Object.entries(answers)) {
      const qi       = parseInt(qiStr, 10);
      const question = pending.questions[qi];
      if (!question) continue;

      const resolveOption = (oi: number): string => {
        if (oi === OTHER_INDEX) return otherTexts?.[qi] || 'Other';
        return question.options[oi]?.label ?? '';
      };

      if (Array.isArray(selection)) {
        // multiSelect: join labels with comma
        const labels = selection.map(resolveOption).filter(Boolean);
        resolvedAnswers[question.question] = labels.join(',');
      } else {
        resolvedAnswers[question.question] = resolveOption(selection);
      }
    }

    this.pendingAskQuestions.delete(requestId);
    this.onActivity?.(pending.chatJid);
    pending.core.respondToAskQuestion({ agentId: pending.agentId, answers: resolvedAnswers });
    this.onAskQuestionResolvedCb?.(pending.chatJid, requestId, resolvedAnswers);
    return true;
  }

  /**
   * 将指定 SemaCore 的权限事件绑定到此 bridge。
   * AgentPool.getOrCreate() 中为每个 core 调用一次。
   * 返回清理函数，destroy 时调用以移除监听器。
   */
  bindCore(core: SemaCore, binding: GroupBinding): () => void {
    const chatJid = binding.jid;
    const botToken = binding.botToken ?? undefined;

    const onPermissionRequest = (data: ToolPermissionRequestData) => {
      this.handlePermissionRequest(data, core, chatJid, botToken).catch((err) => {
        console.error('[PermissionBridge] handlePermissionRequest error:', err);
      });
    };

    const onAskQuestionRequest = (data: AskQuestionRequestData) => {
      this.handleAskQuestionRequest(data, core, chatJid, botToken).catch((err) => {
        console.error('[PermissionBridge] handleAskQuestionRequest error:', err);
      });
    };

    core.on<ToolPermissionRequestData>('tool:permission:request', onPermissionRequest);
    core.on<AskQuestionRequestData>('ask:question:request', onAskQuestionRequest);

    return () => {
      core.off('tool:permission:request', onPermissionRequest);
      core.off('ask:question:request', onAskQuestionRequest);
    };
  }

  // ===== 权限请求处理 =====

  private async handlePermissionRequest(
    data: ToolPermissionRequestData,
    core: SemaCore,
    chatJid: string,
    botToken?: string,
  ): Promise<void> {
    const requestId = shortId();
    this.pendingPermissions.set(requestId, { toolName: data.toolName, chatJid, core });

    const rawContent = this.formatContent(data.content);

    const contentStr = this.truncateContent(rawContent);

    const text = `🔐 *权限请求*\n\n工具：${data.toolName}\n${data.title}\n\n${contentStr}`;

    const buttons: InlineButton[] = Object.entries(data.options).map(([key, label]) => ({
      label: String(label),
      callbackData: `${PREFIX_PERM}:${requestId}:${key}`,
    }));

    const channel = this.resolveChannel(chatJid);
    if (!chatJid.startsWith('web:') && channel?.sendWithButtons) {
      // Channel 发送失败不应阻止 Web UI 收到通知
      try {
        await channel.sendWithButtons(chatJid, text, buttons, botToken);
      } catch (err) {
        console.warn(`[PermissionBridge] sendWithButtons failed for ${chatJid}, falling through to WS:`, (err as Error).message);
      }
    } else if (!chatJid.startsWith('web:') && !this.onPermissionRequestCb) {
      // 频道不支持按钮 且 无 WS sink → 降级自动拒绝
      const optionLines = buttons.map((b) => `• ${b.label}`).join('\n');
      if (channel) {
        await channel.sendMessage(
          chatJid,
          `${text}\n\n选项：\n${optionLines}\n\n（此频道不支持交互式按钮，请联系管理员配置）`,
          botToken,
        );
      }
      core.respondToToolPermission({ toolName: data.toolName, selected: 'refuse' });
      this.pendingPermissions.delete(requestId);
      return;
    }
    // 如无 sendWithButtons 但有 WS sink：不自动拒绝，等 Web UI 响应

    // 通知 WsGateway（完整未截断内容）
    this.onPermissionRequestCb?.(chatJid, requestId, {
      toolName: data.toolName,
      title:    data.title,
      content:  rawContent,
      options:  Object.entries(data.options).map(([key, label]) => ({ key, label: String(label) })),
    });

    // 权限消息已发出 → 通知 AgentPool 重置超时计时器（agent 正在等用户点击）
    this.onActivity?.(chatJid);
  }

  // ===== 问答请求处理 =====

  private async handleAskQuestionRequest(
    data: AskQuestionRequestData,
    core: SemaCore,
    chatJid: string,
    botToken?: string,
  ): Promise<void> {
    const requestId = shortId();
    this.pendingAskQuestions.set(requestId, {
      agentId: data.agentId,
      chatJid,
      questions: data.questions,
      answers: {},
      pendingCount: data.questions.length,
      core,
    });

    // 逐条发送每个问题到 Channel（如支持按钮，且非 Web-only agent）
    const askChannel = this.resolveChannel(chatJid);
    if (!chatJid.startsWith('web:') && askChannel?.sendWithButtons) {
      try {
        for (let qi = 0; qi < data.questions.length; qi++) {
          const q = data.questions[qi];
          const text = `❓ *${q.header}*\n\n${q.question}`;
          const buttons: InlineButton[] = q.options.map((opt, oi) => ({
            label:        opt.label,
            callbackData: `${PREFIX_ASK}:${requestId}:${qi}:${oi}`,
          }));
          await askChannel.sendWithButtons(chatJid, text, buttons, botToken);
        }
      } catch (err) {
        console.warn(`[PermissionBridge] sendWithButtons failed for ${chatJid}, falling through to WS:`, (err as Error).message);
      }
    }

    // 通知 WsGateway（完整问答结构）
    this.onAskQuestionRequestCb?.(chatJid, requestId, {
      agentId:   data.agentId,
      questions: data.questions,
    });

    // 问答消息已发出 → 通知 AgentPool 重置超时计时器
    this.onActivity?.(chatJid);
  }

  // ===== Callback 路由 =====

  private handleCallback(callbackData: string, _chatJid: string): string | void {
    if (callbackData.startsWith(PREFIX_PERM + ':')) {
      return this.handlePermissionCallback(callbackData);
    } else if (callbackData.startsWith(PREFIX_ASK + ':')) {
      return this.handleAskQuestionCallback(callbackData);
    }
  }

  private handlePermissionCallback(callbackData: string): string | void {
    // P:{requestId}:{optionKey}
    const colonIdx1 = callbackData.indexOf(':');          // after 'P'
    const colonIdx2 = callbackData.indexOf(':', colonIdx1 + 1); // after requestId
    if (colonIdx1 < 0 || colonIdx2 < 0) return;

    const requestId = callbackData.slice(colonIdx1 + 1, colonIdx2);
    const optionKey = callbackData.slice(colonIdx2 + 1);

    const pending = this.pendingPermissions.get(requestId);
    if (!pending) return;
    this.pendingPermissions.delete(requestId);

    // 用户点击按钮 → 通知 AgentPool 重置超时计时器（agent 即将恢复执行）
    this.onActivity?.(pending.chatJid);

    pending.core.respondToToolPermission({
      toolName: pending.toolName,
      selected: optionKey,
    });

    // 返回确认文字，由 TelegramChannel 传给 answerCallbackQuery({ text })
    const optionLabel = optionKey.charAt(0).toUpperCase() + optionKey.slice(1);
    // 广播给 Web UI 等其他端
    this.onPermissionResolvedCb?.(pending.chatJid, requestId, optionKey, optionLabel);
    return `✅ 已选择：${optionLabel}`;
  }

  private handleAskQuestionCallback(callbackData: string): string | void {
    // Q:{requestId}:{qi}:{oi}
    const parts = callbackData.split(':');
    // parts[0]=Q, parts[1]=requestId, parts[2]=qi, parts[3]=oi
    if (parts.length < 4) return;

    const requestId = parts[1];
    const qi = parseInt(parts[2], 10);
    const oi = parseInt(parts[3], 10);

    const pending = this.pendingAskQuestions.get(requestId);
    if (!pending) return;

    const question = pending.questions[qi];
    if (!question) return;

    const option = question.options[oi];
    if (!option) return;

    // 用户点击按钮 → 通知 AgentPool 重置超时计时器
    this.onActivity?.(pending.chatJid);

    // 记录答案（以问题文本为 key）
    pending.answers[question.question] = option.label;
    pending.pendingCount--;

    if (pending.pendingCount <= 0) {
      this.pendingAskQuestions.delete(requestId);
      pending.core.respondToAskQuestion({
        agentId: pending.agentId,
        answers: pending.answers,
      });
      this.onAskQuestionResolvedCb?.(pending.chatJid, requestId, pending.answers);
    }

    return `✅ 已选择：${option.label}`;
  }

  // ===== 工具方法 =====

  /**
   * 将 content 格式化为可读文本。
   *
   * - 字符串：直接返回
   * - 包含 patch[].lines 的对象（文件写入/编辑 diff）：提取 diff 行，比原始 JSON 紧凑
   * - 其他对象：JSON.stringify
   */
  private formatContent(content: string | Record<string, unknown>): string {
    if (typeof content === 'string') return content;

    // 尝试从 patch 结构中提取 diff 行
    if (Array.isArray((content as any).patch)) {
      const lines: string[] = [];
      for (const hunk of (content as any).patch as any[]) {
        if (Array.isArray(hunk.lines)) {
          lines.push(...(hunk.lines as string[]));
        }
      }
      if (lines.length > 0) return lines.join('\n');
    }

    return JSON.stringify(content, null, 2);
  }

  /**
   * 按 maxContentLength 截断内容字符串。
   * 超出部分显示 "...(N 字符省略)" 提示，方便用户知晓内容已被截断。
   *
   * Web UI 实现时可传入 maxContentLength: Infinity 保留完整内容，
   * 配合前端展开/收起组件展示。
   */
  private truncateContent(content: string): string {
    if (content.length <= this.maxContentLength) return content;
    const omitted = content.length - this.maxContentLength;
    return `${content.slice(0, this.maxContentLength)}\n...（${omitted} 字符省略）`;
  }
}
