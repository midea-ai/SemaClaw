/**
 * TriggerChecker — 判断是否应该触发 Agent 响应
 *
 * 规则优先级（从高到低）：
 *   1. isFromMe → 永不响应
 *   2. isAdmin 群组 → 无条件响应
 *   3. 私聊 → 无条件响应
 *   4. requiresTrigger=false → 无条件响应
 *   5. 群组/超级群组 → 仅当 mentionsBotUsername=true 时响应
 */

import { IncomingMessage, GroupBinding } from '../types';

export function shouldTrigger(msg: IncomingMessage, group: GroupBinding): boolean {
  // Bot 自己发的消息不处理
  if (msg.isFromMe) return false;

  // 主频道（isAdmin）无条件响应
  if (group.isAdmin) return true;

  // 私聊无条件响应
  if (msg.chatType === 'private') return true;

  // 群组关闭触发词要求时无条件响应
  if (!group.requiresTrigger) return true;

  // 群组/超级群组：仅在被 mention 时响应
  return !!msg.mentionsBotUsername;
}
