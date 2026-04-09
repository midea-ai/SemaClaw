/**
 * SendTool MCP 服务器进程（所有群组可用）
 *
 * Agent 调用这些工具主动向用户发送消息或文件。
 * 通过本地 HTTP SendBridge（127.0.0.1:{port}）中继到主进程，
 * 由主进程的 IChannel 实例负责实际发送，channel 无关。
 *
 * 环境变量：
 *   SEMACLAW_SEND_BRIDGE_PORT — SendBridge 监听端口
 *   SEMACLAW_CHAT_JID         — 本群组的 chatJid（默认发送目标）
 *   SEMACLAW_IS_ADMIN         — '1' = 主频道，可跨群发送
 *   SEMACLAW_BOT_TOKEN        — 本群组的 Bot token（null=使用默认）
 *   SEMACLAW_DB_PATH          — SQLite 路径（isAdmin 校验目标群组用）
 *
 * 工具：
 *   send_message — 发送文本（自动分割超长消息）
 *   send_file    — 发送本地文件（document 类型）
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

// ===== 环境变量 =====

const bridgePort = process.env.SEMACLAW_SEND_BRIDGE_PORT;
const ownChatJid = process.env.SEMACLAW_CHAT_JID;
const isAdmin    = process.env.SEMACLAW_IS_ADMIN === '1';
const botToken   = process.env.SEMACLAW_BOT_TOKEN || undefined;
const dbPath     = process.env.SEMACLAW_DB_PATH;

if (!bridgePort || !ownChatJid) {
  console.error('[send-server] Missing required env vars: SEMACLAW_SEND_BRIDGE_PORT, SEMACLAW_CHAT_JID');
  process.exit(1);
}

const BRIDGE_URL = `http://127.0.0.1:${bridgePort}/send`;

// ===== Helpers =====

/** 校验目标 JID 是否合法，返回 null 表示通过，否则返回错误信息 */
function validateTarget(targetJid: string): string | null {
  if (targetJid === ownChatJid) return null;

  if (!isAdmin) {
    return `非 isAdmin 群组只能向自身（${ownChatJid}）发送消息`;
  }

  if (!dbPath) return '缺少 SEMACLAW_DB_PATH，无法校验目标群组';

  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const Database = require('better-sqlite3') as typeof import('better-sqlite3');
    const db = new Database(dbPath, { readonly: true });
    const row = db.prepare('SELECT jid FROM groups WHERE jid = ?').get(targetJid);
    db.close();
    if (!row) return `目标 ${targetJid} 未在注册群组中`;
    return null;
  } catch (e) {
    return `DB 校验失败：${e}`;
  }
}

/** POST 到 SendBridge */
async function postToBridge(payload: object): Promise<void> {
  const res = await fetch(BRIDGE_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    const text = await res.text();
    let errMsg = text;
    try { errMsg = (JSON.parse(text) as { error?: string }).error ?? text; } catch { /* noop */ }
    throw new Error(`SendBridge error (${res.status}): ${errMsg}`);
  }
}

// ===== MCP 服务器 =====

const server = new McpServer({ name: 'semaclaw-send', version: '1.0.0' });
// Cast to any to avoid TS2589 caused by MCP SDK's deep zod type inference (ShapeOutput<ZodRawShape>)
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const srv = server as any;

// send_message
srv.registerTool(
  'send_message',
  {
    description: [
      `Send a text message to the user. Default target: this group (${ownChatJid}).`,
      isAdmin
        ? 'As admin, you can send to any registered group by specifying chat_jid.'
        : 'You can only send to this group.',
      'Long messages are automatically split. Use this to proactively deliver results, summaries, or alerts.',
    ].join(' '),
    inputSchema: {
      text: z.string().min(1).describe('Message text to send'),
      chat_jid: z.string().optional().describe(
        isAdmin
          ? 'Target chat JID (omit to send to this group). Admin can target any registered group.'
          : `Must be own group JID: ${ownChatJid}`
      ),
    },
  },
  async ({ text, chat_jid }: { text: string; chat_jid?: string }) => {
    const targetJid = chat_jid ?? ownChatJid!;
    const err = validateTarget(targetJid);
    if (err) {
      return { content: [{ type: 'text' as const, text: `❌ ${err}` }], isError: true };
    }

    try {
      await postToBridge({ type: 'message', chatJid: targetJid, text, botToken });
      return { content: [{ type: 'text' as const, text: `✅ 消息已发送至 ${targetJid}` }] };
    } catch (e) {
      return { content: [{ type: 'text' as const, text: `❌ 发送失败：${e}` }], isError: true };
    }
  }
);

// send_file
srv.registerTool(
  'send_file',
  {
    description: [
      'Send a local file as a Telegram document.',
      'The file must exist on the local filesystem (absolute path).',
      isAdmin
        ? 'As admin, you can send to any registered group by specifying chat_jid.'
        : 'You can only send to this group.',
    ].join(' '),
    inputSchema: {
      file_path: z.string().describe('Absolute path to the local file'),
      caption:   z.string().optional().describe('Optional caption for the file'),
      chat_jid:  z.string().optional().describe(
        isAdmin
          ? 'Target chat JID (omit to send to this group).'
          : `Must be own group JID: ${ownChatJid}`
      ),
    },
  },
  async ({ file_path, caption, chat_jid }: { file_path: string; caption?: string; chat_jid?: string }) => {
    const targetJid = chat_jid ?? ownChatJid!;
    const err = validateTarget(targetJid);
    if (err) {
      return { content: [{ type: 'text' as const, text: `❌ ${err}` }], isError: true };
    }

    try {
      await postToBridge({ type: 'file', chatJid: targetJid, filePath: file_path, caption, botToken });
      return { content: [{ type: 'text' as const, text: `✅ 文件已发送至 ${targetJid}` }] };
    } catch (e) {
      return { content: [{ type: 'text' as const, text: `❌ 发送失败：${e}` }], isError: true };
    }
  }
);

// ===== 启动 =====

(async () => {
  const transport = new StdioServerTransport();
  await server.connect(transport);
})();
