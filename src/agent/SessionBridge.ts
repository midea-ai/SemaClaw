/**
 * SessionBridge — 消息格式转换
 *
 * 职责：
 *   - 从 SQLite 拉取群组最近消息（lastAgentTimestamp 之后）
 *   - 格式化为 Agent 可解析的 XML 字符串作为 processUserInput 的输入
 */

import { StoredMessage } from '../types';
import { getMessages, getLastAgentTimestamp } from '../db/db';

// ===== XML Helpers =====

function escapeXml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// ===== Formatting =====

/**
 * 将 StoredMessage 列表格式化为 XML 字符串。
 * 返回空字符串（而不是空 <messages> 块）当列表为空时。
 */
export function formatMessagesForAgent(messages: StoredMessage[]): string {
  if (messages.length === 0) return '';

  const lines = messages.map((m) => {
    const sender = m.isBotReply ? 'assistant' : escapeXml(m.senderName);
    return `<message sender="${sender}" time="${m.timestamp}">${escapeXml(m.content)}</message>`;
  });

  return `<messages>\n${lines.join('\n')}\n</messages>`;
}

/**
 * 从 DB 拉取指定群组 lastAgentTimestamp 之后的消息，格式化为 Agent 输入。
 *
 * @param chatJid 群组 JID
 * @returns 格式化后的 XML 字符串；如果没有新消息则返回空字符串
 */
export function buildPromptForGroup(chatJid: string): { prompt: string; lastMsgTimestamp: string | undefined } {
  const since = getLastAgentTimestamp(chatJid) ?? undefined;
  const messages = getMessages(chatJid, since);
  const lastMsgTimestamp = messages.length > 0 ? messages[messages.length - 1].timestamp : undefined;
  return { prompt: formatMessagesForAgent(messages), lastMsgTimestamp };
}
