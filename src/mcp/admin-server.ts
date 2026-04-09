/**
 * AdminTool MCP 服务器进程（isAdmin 群组专用）
 *
 * 通过 stdio 接入 sema-core。无群组作用域限制，可管理所有群组和任务。
 *
 * 环境变量：
 *   SEMACLAW_DB_PATH       — DB 文件绝对路径
 *   SEMACLAW_AGENTS_DIR    — ~/semaclaw/agents/ 绝对路径
 *   SEMACLAW_WORKSPACE_DIR — ~/semaclaw/workspace/ 绝对路径
 *
 * 注：
 *   群组注册/注销/更新已移至 CLI（semaclaw channel group add/remove）
 *   list_groups / list_all_tasks / manage_task 已移至 WS Gateway 直查命令
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';

const server = new McpServer({ name: 'semaclaw-admin', version: '1.0.0' });

// (no tools registered — group management moved to CLI)

(async () => {
  const transport = new StdioServerTransport();
  await server.connect(transport);
})();
