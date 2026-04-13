<p align="center">
  <img src="docs/images/semaclaw-logo.png" alt="SemaClaw logo" width="200" />
</p>

<h1 align="center">SemaClaw</h1>

<p align="center">
  <em>一个通用的开源个人 AI Agent 框架。</em>
</p>

<p align="center">
  <a href="LICENSE"><img src="https://img.shields.io/badge/License-MIT-yellow.svg" alt="License: MIT" /></a>
  <a href="https://nodejs.org"><img src="https://img.shields.io/badge/node-%3E%3D20-brightgreen.svg" alt="Node.js Version" /></a>
  <a href="CONTRIBUTING.md"><img src="https://img.shields.io/badge/PRs-welcome-brightgreen.svg" alt="PRs Welcome" /></a>
</p>

<p align="center">
  <a href="./README.md">English</a> | <strong>简体中文</strong>
</p>

[SemaClaw](https://github.com/midea-ai/SemaClaw) 是一个面向个人 AI Agent 的通用工程，构建在可复用的 Agent 运行时（[sema-code-core](https://github.com/midea-ai/sema-code-core)）之上。它提供了将原始运行时变成一个真正可用的个人 AI 系统所需的全部周边设施 —— 权限管理、记忆系统、定时任务、多 Agent 编排、频道适配、Web UI 等等。它同时也是一个参考实现，是社区评估并改进其底层工程决策的起点。

---

<p align="center">
  <img src="https://github.com/midea-ai/SemaClaw/releases/download/v0.1.1-preview/SemaClaw-demo.GIF" alt="SemaClaw Demo" width="720" />
</p>

*SemaClaw 分析自身源码并自动生成了以上介绍动画 — 基于 [frontend-slides](https://github.com/zarazhangrui/frontend-slides) 和 [remotion](https://github.com/remotion-dev/remotion) skills（前序步骤使用 DeepSeek-Chat，Remotion 动画代码生成使用 Claude Sonnet 4.6）。* [观看完整演示视频](https://midea-ai.github.io/SemaClaw/assets/SemaClaw-demo.mp4)

## 核心亮点

- **三层上下文管理** —— 将工作上下文、长期记忆检索与按 Agent 划分的人格分区统一为同一个一致模型。
- **Human-in-the-Loop 权限审批** —— `PermissionBridge` 是 harness 的原生原语，同时支持高风险工具调用的显式用户授权与 Agent 主动发起的澄清请求。
- **四层插件架构** —— MCP 工具、子 Agent、Skills、Hooks，每一层对应一个明确的工程关注点，构成一个有原则的扩展面。
- **DAG Teams** —— 两阶段混合编排框架：将 LLM 驱动的动态任务分解，与基于持久 Agent 人格的确定性 DAG 执行结合起来。
- **四模式定时任务** —— 纯通知 / 纯脚本 / 纯 Agent / 脚本+Agent 混合，按任务复杂度匹配执行模式，让 token 消耗与推理工作量成正比。
- **Agentic Wiki** —— 将任务输出转化为结构化、可检索的 wiki 条目，与 Agent 记忆共同建立索引，形成一个会持续复利、能反哺未来 Agent 会话的个人知识库。
- **多频道与 Web UI** —— 内置 Telegram、飞书、QQ 适配器，配套 WebSocket Gateway 与 React Web UI。

---

## 快速开始

### 方式 A —— 从 npm 安装（推荐）

```bash
# 1. 全局安装
npm install -g semaclaw

# 2. 启动
semaclaw
```

就这么简单。在浏览器打开 Web UI：**<http://127.0.0.1:18788/>**。

> **首次启动需配置 LLM。** SemaClaw 不内置任何模型。打开 Web UI → **设置 → LLM**，添加一个 provider profile（OpenAI / Anthropic / DeepSeek / Qwen / ……），填写 `baseURL`、`apiKey`、`modelName` 。配置会持久化到 `~/.semaclaw/config.json`，并同步写入 `~/.semaclaw/semaclaw-model.conf`。在至少有一个 active profile 之前，任何调用 LLM 的 Agent 运行都会失败。

如需启用消息频道（Telegram / 飞书 / QQ / 微信），在启动 `semaclaw` 之前，在当前工作目录创建 `.env` 文件即可。完整环境变量列表请参考 [docs/QUICK_START.md](docs/QUICK_START.md)。

### 方式 B —— 从源码构建

```bash
# 1. 克隆
git clone https://github.com/midea-ai/SemaClaw.git
cd SemaClaw

# 2. 安装与构建
npm install
npm run build
npm run build:web

# 3. 配置环境变量（可选）
cp .env.example .env
# 编辑 .env 以启用消息频道（Telegram / 飞书 / QQ / 微信）。
# 如果不配置任何频道，SemaClaw 将以 Web UI 单机模式启动。

# 4. 启动
npm start
```

启动后，在浏览器打开 Web UI：**<http://127.0.0.1:18788/>**，然后进入 **设置 → LLM** 至少添加一个 active 的 provider profile（参见方式 A 中的说明）。

完整使用说明（环境变量、CLI 命令、运行时目录布局、架构细节）请参考 **[docs/QUICK_START.md](docs/QUICK_START.md)**。

---

## 文档

| 文档 | 说明 |
|---|---|
| [快速开始与使用指南](docs/QUICK_START.md) | 安装、配置、CLI 命令、运行时布局、MCP 工具说明 |
| [远程访问指南](docs/REMOTE_ACCESS.md) | 通过反向代理（Nginx / Caddy）安全暴露 Web UI |
| 技术报告 | *即将发布* |
| [贡献指南](CONTRIBUTING.md) | *即将发布* |

---

## 项目结构

```
semaclaw/
├── src/
│   ├── agent/          # Agent 生命周期、bridges、权限路由
│   ├── channels/       # Telegram / 飞书 / QQ 适配器
│   ├── gateway/        # GroupManager、MessageRouter、WebSocket Gateway
│   ├── mcp/            # MCP servers（admin / schedule / memory / dispatch / ...）
│   ├── memory/         # FTS5 + 向量混合搜索、每日日志
│   ├── scheduler/      # Cron / interval / once 调度
│   ├── wiki/           # Git 驱动的个人知识库
│   └── clawhub/        # ClaWHub 技能市场集成
├── web/                # React + Vite Web UI
├── skills/             # 内置技能
└── docs/               # 详细文档
```

---

## 参与贡献

欢迎贡献。SemaClaw 的目的是推动个人 AI Agent 领域的共享工程基础 —— issue、PR、设计讨论都同样有价值。详情请见 [CONTRIBUTING.md](CONTRIBUTING.md) *（即将发布）*。

---

## 开源协议

[MIT](LICENSE) © AIRC Sema Team

---

## 关于 Logo

SemaClaw 的 logo 是一匹背上长着 **Claw 钳形翅膀**的马。设计灵感来自"**以梦为马**"—— 希望这个 AI harness 能承载用户天马行空的想象力，载着他们去任何想去的地方。

名字本身也藏了几层含义：

- **Sema** 取自 *semantic*（语义）的开头，而 *ma* 与中文「**马**」同音；
- **harness** 这个词的本意正是「**马具**」—— 有驾驭约束的意思；
- **Claw**（钳）与中文「**钱**」谐音，所以这匹马背上长着 Claw 翅膀，也藏着一份小小的祝福：**马上有钱** 🐎💰。

愿这个项目能让每一位使用者都既能驰骋想象，也能马到功成。

---

## 致谢

SemaClaw 构建在 [sema-code-core](https://github.com/midea-ai/sema-code-core) 之上 —— 它提供了底层 Agent 运行时。在产品形态上，SemaClaw 也受到了 [OpenClaw](https://github.com/openclaw/openclaw) 的启发，并接入了来自同一项目的 [ClaWHub](https://github.com/openclaw/clawhub) 插件市场。同时感谢本项目所依赖的更广阔的开源生态，包括 [Model Context Protocol](https://modelcontextprotocol.io)、[grammY](https://grammy.dev) 等许多优秀项目。

---

> SemaClaw 的目标不是定义个人 AI Agent 的最终架构 —— 而是推动一个共享的工程基础，让更好的架构能够在它之上被构建出来。
