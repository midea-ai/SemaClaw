/**
 * FeishuWiki MCP 服务器进程（飞书渠道群组专用）
 *
 * Agent 调用这些工具管理飞书知识库（Wiki）和文档内容。
 * 通过 stdio 接入 sema-core，子进程独立创建 Lark.Client。
 *
 * 环境变量：
 *   FEISHU_APP_ID     — 飞书应用 App ID
 *   FEISHU_APP_SECRET — 飞书应用 App Secret
 *   FEISHU_DOMAIN     — 'feishu' | 'lark'（默认 feishu）
 *
 * 工具（P0）：
 *   wiki_list_spaces  — 列出可访问的知识空间
 *   wiki_get_space    — 获取知识空间详情
 *   wiki_list_nodes   — 列出知识空间子节点
 *   wiki_get_node     — 获取节点信息
 *   wiki_create_node  — 创建知识空间节点
 *   wiki_search       — 搜索知识库
 *   doc_read_blocks   — 读取文档内容块
 *   doc_write_blocks  — 写入/追加文档内容块
 */

import * as Lark from '@larksuiteoapi/node-sdk';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

// ===== 环境变量 =====

const appId = process.env.FEISHU_APP_ID;
const appSecret = process.env.FEISHU_APP_SECRET;
const domain = process.env.FEISHU_DOMAIN ?? 'feishu';

if (!appId || !appSecret) {
  console.error('[feishu-wiki-server] Missing required env vars: FEISHU_APP_ID, FEISHU_APP_SECRET');
  process.exit(1);
}

// ===== Lark Client =====

function resolveDomain(d: string): Lark.Domain | string {
  if (d === 'lark') return Lark.Domain.Lark;
  if (d === 'feishu') return Lark.Domain.Feishu;
  return d.replace(/\/+$/, '');
}

const client = new Lark.Client({
  appId,
  appSecret,
  appType: Lark.AppType.SelfBuild,
  domain: resolveDomain(domain),
});

// ===== Helpers =====

type TextContent = { type: 'text'; text: string };
const text = (t: string): { content: TextContent[] } => ({
  content: [{ type: 'text' as const, text: t }],
});
const err = (t: string) => ({ ...text(`❌ ${t}`), isError: true as const });

/** 安全调用飞书 API，统一错误处理 */
async function callLark<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (e: any) {
    const msg = e?.response?.data?.msg ?? e?.msg ?? e?.message ?? String(e);
    const code = e?.response?.data?.code ?? e?.code ?? '';
    throw new Error(`Feishu API error${code ? ` (${code})` : ''}: ${msg}`);
  }
}

// ===== MCP 服务器 =====

const server = new McpServer({ name: 'semaclaw-feishu-wiki', version: '1.0.0' });
// Cast to any to avoid TS2589 caused by MCP SDK's deep zod type inference
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const srv = server as any;

// ---------- wiki_list_spaces ----------

srv.registerTool(
  'wiki_list_spaces',
  {
    description: [
      'List wiki spaces (knowledge bases) accessible to the bot.',
      'Returns space_id, name, description, and visibility for each space.',
      'Use page_token for pagination if has_more is true.',
    ].join(' '),
    inputSchema: {
      page_size: z.number().int().min(1).max(50).optional()
        .describe('Number of spaces per page (default 20, max 50)'),
      page_token: z.string().optional()
        .describe('Pagination token from previous response'),
    },
  },
  async ({ page_size, page_token }: { page_size?: number; page_token?: string }) => {
    try {
      const res = await callLark(() =>
        client.wiki.v2.space.list({
          params: {
            page_size: page_size ?? 20,
            ...(page_token ? { page_token } : {}),
          },
        })
      );
      const data = res?.data;
      const items = data?.items ?? [];
      if (items.length === 0 && !page_token) {
        return text('未找到可访问的知识空间。请确认 Bot 已被添加为知识空间成员。');
      }
      const lines = items.map((s: any) =>
        `• **${s.name}** (space_id: \`${s.space_id}\`) — ${s.description || '无描述'} [${s.visibility === 'public' ? '公开' : '私有'}]`
      );
      let result = lines.join('\n');
      if (data?.has_more) {
        result += `\n\n_还有更多结果，使用 page_token: \`${data.page_token}\` 翻页_`;
      }
      return text(result);
    } catch (e: any) {
      return err(e.message);
    }
  }
);

// ---------- wiki_get_space ----------

srv.registerTool(
  'wiki_get_space',
  {
    description: 'Get detailed information about a specific wiki space by space_id.',
    inputSchema: {
      space_id: z.string().describe('The wiki space ID'),
    },
  },
  async ({ space_id }: { space_id: string }) => {
    try {
      const res = await callLark(() =>
        client.wiki.v2.space.get({ path: { space_id } })
      );
      const s = res?.data?.space;
      if (!s) return err('未找到该知识空间');
      return text(JSON.stringify(s, null, 2));
    } catch (e: any) {
      return err(e.message);
    }
  }
);

// ---------- wiki_list_nodes ----------

srv.registerTool(
  'wiki_list_nodes',
  {
    description: [
      'List child nodes of a wiki space or a specific parent node.',
      'Returns node_token, title, obj_type (doc/sheet/...), and has_child for each node.',
      'Omit parent_node_token to list top-level nodes.',
    ].join(' '),
    inputSchema: {
      space_id: z.string().describe('Wiki space ID'),
      parent_node_token: z.string().optional()
        .describe('Parent node token (omit for top-level nodes)'),
      page_size: z.number().int().min(1).max(50).optional()
        .describe('Items per page (default 20, max 50)'),
      page_token: z.string().optional()
        .describe('Pagination token'),
    },
  },
  async ({ space_id, parent_node_token, page_size, page_token }: {
    space_id: string; parent_node_token?: string; page_size?: number; page_token?: string;
  }) => {
    try {
      const res = await callLark(() =>
        client.wiki.v2.spaceNode.list({
          path: { space_id },
          params: {
            page_size: page_size ?? 20,
            ...(parent_node_token ? { parent_node_token } : {}),
            ...(page_token ? { page_token } : {}),
          },
        })
      );
      const data = res?.data;
      const items = data?.items ?? [];
      if (items.length === 0) {
        return text('该节点下没有子节点。');
      }
      const lines = items.map((n: any) =>
        `• ${n.title || '(无标题)'} — type: ${n.obj_type}, node_token: \`${n.node_token}\`, obj_token: \`${n.obj_token}\`${n.has_child ? ' 📁' : ''}`
      );
      let result = lines.join('\n');
      if (data?.has_more) {
        result += `\n\n_更多结果: page_token=\`${data.page_token}\`_`;
      }
      return text(result);
    } catch (e: any) {
      return err(e.message);
    }
  }
);

// ---------- wiki_get_node ----------

srv.registerTool(
  'wiki_get_node',
  {
    description: 'Get information about a specific wiki node by its token.',
    inputSchema: {
      token: z.string().describe('Node token (node_token) of the wiki node'),
    },
  },
  async ({ token }: { token: string }) => {
    try {
      const res = await callLark(() =>
        client.wiki.v2.space.getNode({
          params: { token },
        })
      );
      const node = res?.data?.node;
      if (!node) return err('未找到该节点');
      return text(JSON.stringify(node, null, 2));
    } catch (e: any) {
      return err(e.message);
    }
  }
);

// ---------- wiki_create_node ----------

srv.registerTool(
  'wiki_create_node',
  {
    description: [
      'Create a new node in a wiki space.',
      'obj_type: "doc" (document), "sheet" (spreadsheet), "mindnote" (mindmap), "bitable" (database), "docx" (new doc).',
      'For docx type, use doc_write_blocks afterwards to fill in content.',
      'Returns the created node_token and obj_token.',
    ].join(' '),
    inputSchema: {
      space_id: z.string().describe('Wiki space ID'),
      obj_type: z.enum(['doc', 'sheet', 'mindnote', 'bitable', 'docx'])
        .describe('Type of the node to create'),
      title: z.string().optional().describe('Node title'),
      parent_node_token: z.string().optional()
        .describe('Parent node token (omit to create at top level)'),
    },
  },
  async ({ space_id, obj_type, title, parent_node_token }: {
    space_id: string; obj_type: string; title?: string; parent_node_token?: string;
  }) => {
    try {
      const res = await callLark(() =>
        client.wiki.v2.spaceNode.create({
          path: { space_id },
          data: {
            obj_type: obj_type as any,
            node_type: 'origin' as const,
            ...(title ? { title } : {}),
            ...(parent_node_token ? { parent_node_token } : {}),
          },
        })
      );
      const node = res?.data?.node;
      if (!node) return err('创建节点失败：未返回节点信息');
      return text([
        `✅ 节点已创建`,
        `  node_token: \`${node.node_token}\``,
        `  obj_token: \`${node.obj_token}\``,
        `  type: ${obj_type}`,
        title ? `  title: ${title}` : '',
        '',
        obj_type === 'docx'
          ? '使用 doc_write_blocks 工具写入文档内容（document_id = obj_token）'
          : '',
      ].filter(Boolean).join('\n'));
    } catch (e: any) {
      return err(e.message);
    }
  }
);

// ---------- wiki_search ----------

srv.registerTool(
  'wiki_search',
  {
    description: [
      'Search wiki nodes by keyword. Returns matching nodes with title, space, and tokens.',
      'Only returns nodes visible to the bot.',
    ].join(' '),
    inputSchema: {
      query: z.string().min(1).describe('Search keywords'),
      space_id: z.string().optional()
        .describe('Limit search to a specific wiki space'),
      page_size: z.number().int().min(1).max(50).optional()
        .describe('Results per page (default 20)'),
      page_token: z.string().optional()
        .describe('Pagination token'),
    },
  },
  async ({ query, space_id, page_size, page_token }: {
    query: string; space_id?: string; page_size?: number; page_token?: string;
  }) => {
    try {
      // 使用 wiki node search API
      const res: any = await callLark(() =>
        (client as any).wiki.v1.node.search({
          data: {
            query,
            ...(space_id ? { space_id } : {}),
          },
          params: {
            page_size: page_size ?? 20,
            ...(page_token ? { page_token } : {}),
          },
        })
      );
      const data = res?.data;
      const items = data?.items ?? [];
      if (items.length === 0) {
        return text(`未找到匹配「${query}」的知识库节点。`);
      }
      const lines = items.map((n: any) =>
        `• **${n.title || '(无标题)'}** — space: ${n.space_id}, node_token: \`${n.node_token}\`, type: ${n.obj_type}`
      );
      let result = `搜索「${query}」找到 ${items.length} 个结果：\n\n` + lines.join('\n');
      if (data?.has_more) {
        result += `\n\n_更多结果: page_token=\`${data.page_token}\`_`;
      }
      return text(result);
    } catch (e: any) {
      return err(e.message);
    }
  }
);

// ---------- doc_read_blocks ----------

srv.registerTool(
  'doc_read_blocks',
  {
    description: [
      'Read content blocks of a Feishu document (docx).',
      'Use the document_id (= obj_token from wiki nodes) to fetch all blocks.',
      'Returns block structure with types: page, text, heading, code, ordered/bullet list, etc.',
    ].join(' '),
    inputSchema: {
      document_id: z.string().describe('Document ID (same as obj_token for wiki doc nodes)'),
      page_size: z.number().int().min(1).max(500).optional()
        .describe('Blocks per page (default 100, max 500)'),
      page_token: z.string().optional()
        .describe('Pagination token'),
    },
  },
  async ({ document_id, page_size, page_token }: {
    document_id: string; page_size?: number; page_token?: string;
  }) => {
    try {
      const res: any = await callLark(() =>
        (client as any).docx.v1.documentBlock.list({
          path: { document_id },
          params: {
            page_size: page_size ?? 100,
            ...(page_token ? { page_token } : {}),
          },
        })
      );
      const data = res?.data;
      const items = data?.items ?? [];
      if (items.length === 0) {
        return text('文档为空，没有内容块。');
      }

      // 简化输出：提取关键信息
      const blocks = items.map((b: any) => {
        const base: any = {
          block_id: b.block_id,
          block_type: b.block_type,
          parent_id: b.parent_id,
        };
        // 提取文本内容（适用于 text/heading 等类型）
        const typeKey = Object.keys(b).find(k =>
          k !== 'block_id' && k !== 'block_type' && k !== 'parent_id' && k !== 'children' && typeof b[k] === 'object'
        );
        if (typeKey) {
          base.content = b[typeKey];
        }
        if (b.children?.length) {
          base.children = b.children;
        }
        return base;
      });

      let result = JSON.stringify(blocks, null, 2);
      if (data?.has_more) {
        result += `\n\n_更多块: page_token=\`${data.page_token}\`_`;
      }
      return text(result);
    } catch (e: any) {
      return err(e.message);
    }
  }
);

// ---------- doc_write_blocks ----------

srv.registerTool(
  'doc_write_blocks',
  {
    description: [
      'Write (append) content blocks to a Feishu document.',
      'Inserts blocks as children of the specified parent block.',
      'Use the document root block_id (first block from doc_read_blocks, usually same as document_id) as parent_block_id to append to the end.',
      '',
      'Supported block types and their structure:',
      '  - "text": { elements: [{ text_run: { content: "..." } }] }',
      '  - "heading1" ~ "heading9": same as text structure',
      '  - "code": { elements: [{ text_run: { content: "..." } }], style: { language: 1 } }',
      '  - "bullet": { elements: [{ text_run: { content: "..." } }] }',
      '  - "ordered": { elements: [{ text_run: { content: "..." } }] }',
      '  - "todo": { elements: [{ text_run: { content: "..." } }], style: { done: false } }',
      '  - "divider": {}',
      '',
      'Tip: for simple text writing, just provide blocks with type "text" and content string.',
    ].join('\n'),
    inputSchema: {
      document_id: z.string().describe('Document ID'),
      parent_block_id: z.string().describe('Parent block ID to append children to (use document root block_id for top-level)'),
      blocks: z.array(z.object({
        type: z.string().describe('Block type: text, heading1-heading9, code, bullet, ordered, todo, divider'),
        content: z.string().optional().describe('Text content (shorthand: auto-wrapped into elements structure)'),
        raw: z.any().optional().describe('Raw block body (advanced: provide the full type-specific structure)'),
      })).min(1).max(50).describe('Blocks to insert (1-50 per call)'),
      index: z.number().int().min(0).optional()
        .describe('Insert position among siblings (0 = first, omit = append at end)'),
    },
  },
  async ({ document_id, parent_block_id, blocks, index }: {
    document_id: string;
    parent_block_id: string;
    blocks: Array<{ type: string; content?: string; raw?: any }>;
    index?: number;
  }) => {
    try {
      // 映射 block_type 数值（飞书 API 要求数字枚举）
      const typeMap: Record<string, number> = {
        text: 2,
        heading1: 3, heading2: 4, heading3: 5, heading4: 6,
        heading5: 7, heading6: 8, heading7: 9, heading8: 10, heading9: 11,
        bullet: 12,
        ordered: 13,
        code: 14,
        todo: 17,
        divider: 22,
      };

      const children = blocks.map(b => {
        const blockType = typeMap[b.type];
        if (blockType === undefined) {
          throw new Error(`不支持的 block type: "${b.type}"。支持: ${Object.keys(typeMap).join(', ')}`);
        }

        // divider 无需内容
        if (b.type === 'divider') {
          return { block_type: blockType, divider: {} };
        }

        // 如果有 raw 直接使用
        if (b.raw) {
          return { block_type: blockType, [b.type]: b.raw };
        }

        // shorthand: content → elements
        const textContent = b.content ?? '';
        const elements = [{ text_run: { content: textContent, text_element_style: {} } }];

        const bodyKey = b.type.startsWith('heading') ? b.type : b.type;
        const body: any = { elements };

        // code 默认 PlainText
        if (b.type === 'code') {
          body.style = { language: 1, wrap: true };
        }
        // todo 默认 undone
        if (b.type === 'todo') {
          body.style = { ...(body.style ?? {}), done: false };
        }

        return { block_type: blockType, [bodyKey]: body };
      });

      const res: any = await callLark(() =>
        (client as any).docx.v1.documentBlockChildren.create({
          path: { document_id, block_id: parent_block_id },
          data: {
            children,
            ...(index !== undefined ? { index } : {}),
          },
        })
      );

      const created = res?.data?.children ?? [];
      return text([
        `✅ 成功写入 ${created.length} 个内容块`,
        `  document_id: \`${document_id}\``,
        `  parent_block_id: \`${parent_block_id}\``,
        created.length > 0
          ? `  new block_ids: ${created.map((c: any) => `\`${c.block_id}\``).join(', ')}`
          : '',
      ].filter(Boolean).join('\n'));
    } catch (e: any) {
      return err(e.message);
    }
  }
);

// ===== 启动 =====

(async () => {
  const transport = new StdioServerTransport();
  await server.connect(transport);
})();
