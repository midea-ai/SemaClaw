/**
 * FormBridge — 将 sema-core 的 FormUI 表单请求中继到 Web UI
 *
 * 职责：
 *   1. 监听 `form:request` → 通过 WsGateway 把表单结构推给前端渲染
 *   2. 用户在前端提交后，经 WsGateway → AgentPool.resolveForm → 本类 resolveForm
 *      将结构化 values 回传 sema-core（emit `form:response`）
 *
 * 设计：
 *   - 与 PermissionBridge 同构：单例（AgentPool 创建一次），pendingForms
 *     Map（requestId → pending）路由多群组并发请求，requestId = 8 字符随机 hex
 *   - Agent 无超时（自然暂停等待提交），用户提交后继续
 *   - 富表单无法用 Telegram 内联键盘表达：非 web 频道且无 WS sink 时，降级为
 *     发送只读文本快照 + 用各 field 的 default 自动提交（submitted=false），避免 agent 永久阻塞
 */

import { randomBytes } from 'crypto';
import { SemaCore } from 'sema-core';
import type { FormRequestData, FormField } from 'sema-core/event';
import type { IChannel, GroupBinding } from '../types';

// ===== 内部类型 =====

interface PendingForm {
  agentId: string;
  chatJid: string;
  core: SemaCore;
}

/** WsGateway / 外部 sink 收到表单请求时的数据 */
export interface FormPayload {
  agentId: string;
  title: string;
  surface: 'inline' | 'dock';
  submitLabel: string;
  fields: FormField[];
}

function shortId(): string {
  return randomBytes(4).toString('hex'); // 8 chars
}

/** 用各 field 的 default 组装初始 values（降级自动提交用） */
function buildDefaultValues(fields: FormField[]): Record<string, unknown> {
  const values: Record<string, unknown> = {};
  for (const f of fields) {
    if (f.type === 'static_text') continue;
    if ('default' in f && f.default !== undefined) {
      values[f.key] = f.default;
    }
  }
  return values;
}

/** 把表单渲染成只读文本快照（降级频道用） */
function formatFormSnapshot(payload: FormPayload): string {
  const lines = payload.fields.map((f) => {
    if (f.type === 'static_text') return f.text;
    const def = 'default' in f && f.default !== undefined ? ` (默认: ${JSON.stringify(f.default)})` : '';
    return `• ${f.label}${f.required ? ' *' : ''}${def}`;
  });
  return `📋 *${payload.title}*\n\n${lines.join('\n')}\n\n（此频道不支持交互式表单，已按默认值跳过；请在 Web 端操作）`;
}

// ===== FormBridge =====

export class FormBridge {
  private pendingForms = new Map<string, PendingForm>();
  private onActivity?: (chatJid: string) => void;
  private onFormRequestCb?: (chatJid: string, requestId: string, payload: FormPayload) => void;
  private onFormResolvedCb?: (chatJid: string, requestId: string, values: Record<string, unknown>) => void;
  private readonly channels: IChannel[];

  constructor(channels: IChannel | IChannel[]) {
    this.channels = Array.isArray(channels) ? channels : [channels];
  }

  /** 根据 chatJid 找到负责的 channel */
  private resolveChannel(chatJid: string): IChannel | undefined {
    return this.channels.find((ch) => ch.ownsJid(chatJid));
  }

  /** 注入活跃回调（AgentPool 内部使用，重置超时计时器） */
  setActivityCallback(cb: (chatJid: string) => void): void {
    this.onActivity = cb;
  }

  /** 注入表单请求通知（WsGateway 通过 AgentPool.setAgentEventSink 间接设置） */
  onFormRequest(fn: (chatJid: string, requestId: string, payload: FormPayload) => void): void {
    this.onFormRequestCb = fn;
  }

  /** 注入表单决策通知（提交后广播给其他端） */
  onFormResolved(fn: (chatJid: string, requestId: string, values: Record<string, unknown>) => void): void {
    this.onFormResolvedCb = fn;
  }

  /**
   * Web UI 侧提交表单（由 WsGateway 调用）。
   * 若 requestId 已被消耗则返回 false，否则返回 true。
   */
  resolveForm(requestId: string, values: Record<string, unknown>, submitted: boolean): boolean {
    const pending = this.pendingForms.get(requestId);
    if (!pending) return false;
    this.pendingForms.delete(requestId);
    this.onActivity?.(pending.chatJid);
    pending.core.respondToForm({ agentId: pending.agentId, values, submitted });
    this.onFormResolvedCb?.(pending.chatJid, requestId, values);
    return true;
  }

  /**
   * 将指定 SemaCore 的表单事件绑定到此 bridge。
   * AgentPool.getOrCreateInternal() 中为每个 core 调用一次，返回清理函数。
   */
  bindCore(core: SemaCore, binding: GroupBinding): () => void {
    const chatJid = binding.jid;
    const botToken = binding.botToken ?? undefined;

    const onFormRequest = (data: FormRequestData) => {
      this.handleFormRequest(data, core, chatJid, botToken).catch((err) => {
        console.error('[FormBridge] handleFormRequest error:', err);
      });
    };

    core.on<FormRequestData>('form:request', onFormRequest);

    return () => {
      core.off('form:request', onFormRequest);
    };
  }

  // ===== 表单请求处理 =====

  private async handleFormRequest(
    data: FormRequestData,
    core: SemaCore,
    chatJid: string,
    botToken?: string,
  ): Promise<void> {
    const requestId = shortId();
    this.pendingForms.set(requestId, { agentId: data.agentId, chatJid, core });

    const payload: FormPayload = {
      agentId: data.agentId,
      title: data.title,
      surface: data.surface,
      submitLabel: data.submitLabel,
      fields: data.fields,
    };

    // 非 web 频道且无 WS sink → 降级：发只读快照 + 按默认值自动提交，避免永久阻塞
    if (!chatJid.startsWith('web:') && !this.onFormRequestCb) {
      const channel = this.resolveChannel(chatJid);
      if (channel) {
        try {
          await channel.sendMessage(chatJid, formatFormSnapshot(payload), botToken);
        } catch (err) {
          console.warn(`[FormBridge] sendMessage failed for ${chatJid}:`, (err as Error).message);
        }
      }
      this.pendingForms.delete(requestId);
      core.respondToForm({ agentId: data.agentId, values: buildDefaultValues(data.fields), submitted: false });
      return;
    }

    // 通知 WsGateway（完整表单结构）
    this.onFormRequestCb?.(chatJid, requestId, payload);

    // 表单已推出 → 通知 AgentPool 重置超时计时器（agent 正在等用户提交）
    this.onActivity?.(chatJid);
  }
}
