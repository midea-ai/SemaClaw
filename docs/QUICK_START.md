# SemaClaw

基于 [sema-code-core](https://github.com/midea-ai/sema-code-core/tree/feature/semaclaw) 构建的多群组 AI Agent 网关，支持 Telegram / 飞书 / QQ 多频道，提供 WebSocket 实时接口与 Web UI。

---

## 目录结构

```
semaclaw/
├── src/
│   ├── index.ts              # 主入口，12 步启动序列
│   ├── config.ts             # 环境变量与路径配置
│   ├── types.ts              # 共享类型定义
│   ├── channels/
│   │   ├── telegram.ts       # Telegram 频道（grammY）
│   │   ├── feishu.ts         # 飞书频道（懒加载）
│   │   └── qq.ts             # QQ 频道（沙盒/正式）
│   ├── gateway/
│   │   ├── GroupManager.ts   # 群组注册、绑定管理
│   │   ├── MessageRouter.ts  # 消息分发、入库、触发 Agent
│   │   ├── TriggerChecker.ts # 触发条件判断（@mention / 私聊 / admin）
│   │   ├── WebSocketGateway.ts # WS 服务器（实时事件 + 双向交互）
│   │   ├── UIServer.ts       # 静态文件服务器（Web UI）
│   │   └── CommandDispatcher.ts
│   ├── agent/
│   │   ├── AgentPool.ts      # Agent 生命周期、pre-retrieval 注入
│   │   ├── GroupQueue.ts     # 每群组消息串行队列
│   │   ├── SessionBridge.ts  # sema-core session 上下文桥接
│   │   ├── PermissionBridge.ts # 工具权限请求路由（Telegram 按钮 + WS）
│   │   ├── SendBridge.ts     # 本地 HTTP IPC（供 send-server MCP 调用）
│   │   └── DispatchBridge.ts # 文件 IPC（DAG 任务调度协调）
│   ├── scheduler/
│   │   └── TaskScheduler.ts  # 定时任务调度（cron/interval/once）
│   ├── mcp/
│   │   ├── mcpHelper.ts      # MCP 配置工厂函数
│   │   ├── admin-server.ts   # AdminTool MCP（群组管理）
│   │   ├── schedule-server.ts # ScheduleTool MCP（任务管理）
│   │   ├── workspace-server.ts # WorkspaceTool MCP（工作目录切换）
│   │   ├── memory-server.ts  # MemoryTool MCP（长期记忆搜索/读取）
│   │   ├── send-server.ts    # SendTool MCP（主动发消息/文件）
│   │   └── dispatch-server.ts # DispatchTool MCP（多 Agent 任务派发）
│   ├── memory/
│   │   ├── MemoryManager.ts  # FTS5 + 向量混合搜索、文件监听、增量索引
│   │   ├── chunker.ts        # 文本分块（chunkSize 400 / overlap 80）
│   │   ├── embedding.ts      # Embedding 抽象（OpenAI / none）
│   │   ├── fts-search.ts     # FTS5 全文检索实现
│   │   ├── memory-schema.ts  # SQLite 建表语句
│   │   └── DailyLogger.ts    # 每日对话日志追加（YYYY-MM-DD.md）
│   ├── wiki/
│   │   └── WikiManager.ts    # Git 驱动的个人知识库管理
│   ├── clawhub/              # ClaWHub 技能市场集成
│   ├── cli/                  # semaclaw CLI（skills / clawhub 子命令）
│   └── db/
│       └── db.ts             # SQLite 操作（better-sqlite3）
├── web/                      # React + Vite Web UI
└── skills/                   # 内置技能（wiki 等）
```

---

## 运行时目录布局

```
~/.semaclaw/
├── semaclaw.db               # SQLite 数据库
├── config.json               # 全局配置（优先级高于 DB）
├── dispatch-state.json       # Dispatch 任务状态（DAG）
└── workspace-state-{folder}.json  # 每个 Agent 的工作目录状态

~/semaclaw/
├── agents/{folder}/          # agentDataDir（固定，不随工作目录切换）
│   ├── SOUL.md             # Agent 人格 / 系统指令（soul）
│   ├── memory/
│   │   ├── MEMORY.md         # 结构化长期记忆（Agent 主动维护）
│   │   └── YYYY-MM-DD.md    # 每日对话日志（系统自动追加，保留 50 天）
│   └── .sema/sessions/       # sema-core session 快照
├── workspace/{folder}/       # workingDir（可运行时切换）
└── wiki/                     # 个人知识库（git 管理）
```

---

## 快速开始

### 1. 安装依赖

**方式 A：普通用户（推荐）**

直接安装即可，`sema-core` 会自动从 GitHub 拉取 `feature/semaclaw` 分支并构建：

```bash
# 安装根项目依赖
npm install

# 构建主项目
npm run build

# 安装并构建 Web 前端（位于 web/ 子目录）
npm run build:web
```

**方式 B：开发者（需要同时调试 sema-code-core）**

如果你需要在本地修改 `sema-code-core` 并实时联调，建议改用本地路径引用：

```bash
# 1. 克隆 sema-code-core 到 semaclaw 的同级目录
git clone -b feature/semaclaw https://github.com/midea-ai/sema-code-core.git

# 2. 编译 sema-code-core
cd sema-code-core
npm install && npm run build

# 3. 在 semaclaw/package.json 中将 sema-core 依赖临时改为本地路径：
#    "sema-core": "file:../sema-code-core"
#    （注意：提交代码前请改回 "github:midea-ai/sema-code-core#feature/semaclaw"）

# 4. 安装 semaclaw 依赖并构建
cd ../semaclaw
npm install
npm run build
npm run build:web
```

### 2. 配置环境变量

复制 `.env.example` 为 `.env`，至少填写：

```env
# Telegram Bot token（从 @BotFather 获取）
TELEGRAM_BOT_TOKEN=123456:ABC...

# 管理员 Telegram 用户 ID（数字）
ADMIN_TELEGRAM_USER_ID=123456789
```

```env
MAX_CONCURRENT_AGENTS=5
MAX_MESSAGES_PER_GROUP=100
SCHEDULER_INTERVAL_SEC=60
NOTIFY_MAX_DELAY_MINUTES=30

# 路径覆盖（默认值见 config.ts）
DB_PATH=~/.semaclaw/semaclaw.db
AGENTS_DIR=~/semaclaw/agents
WORKSPACE_DIR=~/semaclaw/workspace

# WebSocket Gateway
GATEWAY_PORT=18789
GATEWAY_TOKEN=              # 不设则无需认证

# Web UI
GATEWAY_UI_PORT=18788

# 飞书（可选）
FEISHU_APP_ID=
FEISHU_APP_SECRET=

# QQ（可选）
QQ_APP_ID=
QQ_APP_SECRET=
QQ_SANDBOX=false

# 记忆系统 Embedding（可选，默认 none 仅用 FTS5）
SEMACLAW_EMBEDDING_PROVIDER=none   # none | openai | openrouter | ollama | local

# openai
SEMACLAW_OPENAI_MODEL=text-embedding-3-small
OPENAI_API_KEY=

# openrouter
SEMACLAW_OPENROUTER_MODEL=openai/text-embedding-3-small
OPENROUTER_API_KEY=
OPENROUTER_BASE_URL=https://openrouter.ai/api/v1

# ollama（本地服务）
SEMACLAW_OLLAMA_MODEL=nomic-embed-text
OLLAMA_BASE_URL=http://localhost:11434

# local（Transformers.js 纯本地，首次使用自动下载模型，约几百MB）
SEMACLAW_LOCAL_MODEL=Xenova/paraphrase-multilingual-MiniLM-L12-v2
SEMACLAW_LOCAL_MODEL_PATH=   # 留空则缓存到 ~/.cache/transformers

# 搜索调参
SEMACLAW_EMBEDDING_DIMENSIONS=0        # 0=自动，手动指定时填向量维度
SEMACLAW_SEARCH_MAX_RESULTS=5
SEMACLAW_SEARCH_MIN_SCORE=0.5
```

### 3. 启动

```bash
# 开发模式（tsx 热加载）
npm run dev

# 生产构建
npm run build && npm start

# Web UI 开发
npm run dev:web
```

### 4. CLI

```bash
# 开发期间（无需全局安装）
npm run cli -- skills check
npm run cli -- skills list --verbose
npm run cli -- clawhub search "git"
npm run cli -- clawhub install <slug>
npm run cli -- clawhub update --all

# 全局安装后
npm run build && npm link
semaclaw skills list
semaclaw clawhub list
npm unlink semaclaw   # 取消注册
```

---

## 核心概念

### GroupBinding

每个 Telegram/飞书/QQ 群组或私聊映射一条 `GroupBinding` 记录，关键字段：

| 字段 | 说明 |
|------|------|
| `jid` | 标准化聊天 ID，如 `tg:group:-1001234567890` |
| `folder` | agents/ 和 workspace/ 下的子目录名 |
| `isAdmin` | 管理员频道，拥有全工具权限且无需触发词 |
| `allowedTools` | 工具白名单，`null` = 全部允许 |
| `allowedWorkDirs` | 可切换工作目录白名单，`null` = 禁止切换 |
| `botToken` | 指定 Bot token，`null` = 使用全局默认 |

### 消息触发规则（TriggerChecker）

- 私聊：全部响应
- isAdmin 群组：全部响应
- 普通群组：需要 @BotUsername

### Agent 生命周期

每个 `GroupBinding` 对应一个**持久化** SemaCore 实例（懒创建，首条消息时初始化）。消息通过 `GroupQueue` 串行化后由 `AgentPool.processAndWait()` 处理，超时计时器在权限等待期间也会重置（活跃模式）。

---

## 支持的频道

| 频道 | 模块 | 说明 |
|------|------|------|
| Telegram | `channels/telegram.ts` | 多 Bot、内联按钮权限审批、文件发送 |
| 飞书 | `channels/feishu.ts` | WebSocket 长轮询、多应用支持，懒加载 |
| QQ | `channels/qq.ts` | 沙盒/正式环境，原生消息 ID 回复 |

---

## MCP 工具说明

Agent 通过以下 MCP 工具与系统交互，均以子进程 stdio 方式接入：

| MCP Server | 工具 | 权限 | 说明 |
|---|---|---|---|
| `admin-server` | `group_list/add/remove/update` | isAdmin | 管理群组绑定 |
| `schedule-server` | `task_list/add/update/remove` | isAdmin | 管理定时任务 |
| `workspace-server` | `workspace_switch/reset/info` | 内部 | 切换工作目录 |
| `memory-server` | `memory_search/memory_get` | 内部 | 语义搜索 + 精读记忆文件 |
| `send-server` | `send_message/send_file` | 内部 | 主动发消息或文件 |
| `dispatch-server` | `list_agents/create_parent/dispatch_task` | isAdmin | DAG 多 Agent 任务派发 |

内部工具（workspace/memory/send）`skipMCPToolPermission=true`，不弹权限确认。

---

## 记忆系统

### 架构

基于 SQLite FTS5 全文索引 + 可选 OpenAI Embedding 混合搜索，回退链：

```
embedding 混合搜索 → FTS5 全文检索 → 关键词子串匹配
```

### 记忆来源

| 来源 | 路径 | 写入方式 |
|------|------|------|
| 结构化记忆 | `memory/MEMORY.md` | Agent 主动调用 Write/Edit 工具 |
| 每日日志 | `memory/YYYY-MM-DD.md` | DailyLogger 每轮自动追加 |
| Session 快照 | `.sema/sessions/*.json` | sema-core 自动管理 |

### 工作流

1. **自动索引**：`fs.watchFile` 监听文件变化，1.5s 防抖，hash 比对增量更新
2. **Pre-retrieval**：`processAndWait` 前异步搜索，命中内容以 `<memory>` 块注入 prompt
3. **Agent 写入**：Agent 直接用 Write/Edit 工具编辑 MEMORY.md（agentic 风格）

### Embedding Provider 对比

| Provider | 需要什么 | 中文效果 | 适合场景 |
|---|---|---|---|
| `none` | 无 | FTS5 分词 | 轻量部署，无需向量 |
| `openai` | OpenAI API Key | 好 | 生产环境 |
| `openrouter` | OpenRouter Key | 取决于选用模型 | 多模型灵活切换 |
| `ollama` | 本地 Ollama 服务 | 取决于选用模型 | 本地私有部署 |
| `local` | 无（自动下载模型） | 好（多语言模型） | 离线/隐私敏感场景 |

### 配置

```json
{
  "memory": {
    "embeddingProvider": "none",
    "chunkSize": 400,
    "chunkOverlap": 80
  }
}
```

---

## WebSocket 接口

默认 `127.0.0.1:18789`，客户端协议摘要：

```jsonc
// 客户端 → 服务端
{ "type": "connect", "token": "..." }
{ "type": "subscribe", "groupJid": "tg:group:-100123" }
{ "type": "message", "groupJid": "tg:group:-100123", "text": "你好" }
{ "type": "list:groups" }
{ "type": "permission:response", "requestId": "...", "optionKey": "yes" }
{ "type": "question:response", "requestId": "...", "answers": { "0": 1 } }

// 服务端 → 客户端
{ "type": "auth:ok" }
{ "type": "incoming", "groupJid": "...", "text": "..." }
{ "type": "agent:reply", "groupJid": "...", "text": "..." }
{ "type": "agent:state", "groupJid": "...", "state": "thinking" }
{ "type": "permission:request", "requestId": "...", "toolName": "...", "options": [...] }
{ "type": "question:request", "requestId": "...", "question": "...", "options": [...] }
```

---

## 定时任务

通过 `schedule-server` MCP 或 Web UI 创建，`contextMode` 可选：

| 模式 | 说明 |
|------|------|
| `notify` | 直接发消息，不经 Agent（TTL 30 分钟） |
| `isolated` | 独立 Agent 实例，任务完成后销毁 |
| `group` | 复用群组持久 Agent |
| `script` | 执行脚本，输出发到群组 |
| `script-agent` | 执行脚本，输出作为 prompt 传给 Agent |

---

## 多 Agent 任务派发（Dispatch）

isAdmin Agent 可通过 `dispatch-server` MCP 协调多个子 Agent 并行执行任务：

- **DispatchBridge**：文件 IPC（`~/.semaclaw/dispatch-state.json`），lock 文件保护
- **任务结构**：Parent（`p-YYYYMMDD-{seq}`）包含多个子任务（`d-YYYYMMDD-{seq}`），支持 DAG 依赖
- **队列**：每个 admin 同时只有一个 active parent，其余排队
- **工作区共享**：子任务激活时继承 admin Agent 的 workspace 状态

---

## Wiki 知识库

`WikiManager` 提供 git 驱动的个人知识库，存储在 `~/semaclaw/wiki/`：

- YAML frontmatter 管理（created / updated / tags / source）
- 目录树扫描、标签索引、git commit 历史
- 通过内置 `wiki` 技能或 Agent 调用进行读写和搜索

---

## 全局配置文件（可选）

`~/.semaclaw/config.json` 不存在时自动忽略，启动时优先于 DB：

```json
{
  "agents": {
    "main": {
      "allowedWorkDirs": ["/path/to/project-a", "/path/to/project-b"]
    }
  },
  "adminPermissions": {
    "skipAllPermissions": false
  },
  "memory": {
    "embeddingProvider": "none",
    "chunkSize": 400,
    "chunkOverlap": 80
  }
}
```

| 配置项 | 说明 |
|--------|------|
| `allowedWorkDirs` | Agent 可通过 WorkspaceTool 切换的目录白名单，`null` = 禁止切换 |
| `skipAllPermissions` | 主 Agent 执行工具时跳过所有权限审批弹窗 |
| `embeddingProvider` | 记忆向量化引擎，`none` \| `openai` \| `openrouter` \| `ollama` \| `local` |
| `chunkSize` | 分块大小（token 数），默认 400 |
| `chunkOverlap` | 分块重叠，默认 80 |
| `searchMaxResults` | 检索最多返回条数，默认 5 |
| `searchMinScore` | 结果最低分数阈值（0~1），默认 0.5 |

---

## 已知问题

- `sqlite-vec` 加载失败时自动回退 FTS5，无需手动处理。
