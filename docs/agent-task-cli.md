# `semaclaw agent-task` — 一次性独立 Agent 任务 CLI

## 用途

在主流程之外，启动一个**完全独立**的 SemaCore 实例执行单条 prompt，到 idle 后销毁并退出。典型场景：

- Hook 脚本在 `UserPromptSubmit` / `PostToolUse` 等事件里触发"反思 / 总结 / 抽取领域知识"子 Agent
- 任意需要"短时无人值守 Agent"的脚本化场景（CI、定时任务等）

设计原则：**通用 CLI，不绑定具体业务用例**。Hook 脚本负责：

1. 触发条件判断
2. 完整 prompt 拼装（任务模板 + 历史 + 已有领域知识，**一次性**塞进 prompt）
3. 调用 `semaclaw agent-task`
4. 解析输出，做去重 / 校验 / 落盘

CLI 自身只关心一件事：**收一个 prompt，跑一次 Agent，把结果吐出来**。

---

## 快速使用

```bash
# 内联 prompt
semaclaw agent-task --prompt "总结下面这段对话的关键决策：..." --output text

# 从文件读 prompt
semaclaw agent-task --prompt-file ./full-prompt.md --output json

# 从 stdin 读 prompt
cat full-prompt.md | semaclaw agent-task --output json
# 或显式：
cat full-prompt.md | semaclaw agent-task --prompt-file - --output json
```

在 hook 脚本里通常这样写（推荐使用 `$SEMACLAW_BIN`，由 semaclaw 主进程注入到 hook env，开发态/生产态都正确指向当前正在运行的入口）：

```bash
#!/usr/bin/env bash
PROMPT_FILE=$(mktemp)
cat > "$PROMPT_FILE" <<EOF
你是一个对话总结助手。请阅读以下对话并输出 JSON …
EOF

RESULT=$("$SEMACLAW_BIN" agent-task \
  --prompt-file "$PROMPT_FILE" \
  --output json \
  --timeout 120000)

rm -f "$PROMPT_FILE"
echo "$RESULT" | jq '.summary'
```

> 路径含空格 / 中文时务必给 `"$SEMACLAW_BIN"` 加引号。

---

## 参数

| Flag | 说明 | 默认 |
|---|---|---|
| `--prompt <text>` | 内联 prompt 文本（优先级最高） | — |
| `--prompt-file <path>` | 从文件读 prompt；传 `-` 表示从 stdin 读 | — |
| *(无 prompt flag)* | 自动从 stdin 读（非 TTY 时） | — |
| `--working-dir <dir>` | Agent 工具的工作目录（文件读写、Bash 执行等） | `process.cwd()` |
| `--agent-data-dir <dir>` | Agent 数据目录（`CLAUDE.md` / `.sema/`） | 同 `--working-dir` |
| `--tools <list>` | 工具白名单，逗号分隔；不传 = 全部工具 | 全部 |
| `--skills-dir <dir>` | 额外 skills 目录，可重复 | — |
| `--output <fmt>` | 输出格式：`text` / `json` / `raw` | `text` |
| `--timeout <ms>` | 超时毫秒数 | `300000`（5 分钟） |
| `--instance-id <id>` | SemaCore 实例 ID，多租户隔离 key | 自动生成 |
| `--system-prompt <text>` | 覆盖 system prompt | sema-core 默认 |

---

## 输出格式

### `--output text`（默认）

打印**最后一条 main agent message** 的内容 + 换行。最常用。

### `--output raw`

打印**所有 main agent message**，按顺序用 `\n---\n` 分隔。需要看完整推理过程时用。

### `--output json`

把最后一条 message 解析为 JSON 后输出（紧凑单行）。解析顺序：

1. 整段直接 `JSON.parse`
2. 抓第一个 ```` ```json ... ``` ```` 代码块
3. 抓第一个 `{...}` 或 `[...]` 子串

三种都失败 → 退出码 `3`，stderr 打印 raw text。

> 想稳定拿到 JSON：在 prompt 里明确要求"只输出一个 JSON 对象，不要任何其他文字"。

---

## 退出码

| Code | 含义 |
|---|---|
| `0` | 成功 |
| `2` | 参数错误（空 prompt、`--output` / `--task` 取值非法等） |
| `3` | `--output json` 但模型输出无法解析为 JSON |
| `124` | 超时（与 `timeout(1)` 一致） |

---

## 默认行为与隔离保证

`agent-task` 启动的 SemaCore 与主进程 / AgentPool 完全隔离：

- **`hooks: undefined`** — 子 Agent 不会再触发 hook，**防递归**
- **`skipMCPInit: true`** — 不自动加载用户 MCP 配置（避免与主进程 MCP 竞争）
- **`skipFileEditPermission` / `skipBashExecPermission` / `skipSkillPermission` / `skipMCPToolPermission` 全部为 `true`** — 一次性无人值守任务，不弹权限确认
- **`SEMACLAW_INTERNAL_AGENT=1`** 写入 `process.env`，子进程继承；主进程 / 其他工具可据此识别"我现在在内部 Agent 里"

> 如果你的 hook 脚本里又会 shell out 出新的 semaclaw 进程，`SEMACLAW_INTERNAL_AGENT=1` 会传下去；脚本里检查一下就能避免无限套娃。

---

## Skills 解析顺序

`agent-task` 自动加载以下 skills 目录（与主进程一致），最后是 `--skills-dir`：

1. 内置 bundled skills（`config.paths.bundledSkillsDir`）
2. `~/.claude/skills`（用户级）
3. Managed skills（`config.paths.managedSkillsDir`）
4. `<workingDir>/skills`（workspace）
5. 所有 `--skills-dir <dir>` 传入的目录

被 disable 的 skills（`readDisabledSkills()`）会被过滤掉。

---

## 与 `AgentPool.runIsolated` 的关系

两者底层**共享同一个** `runOneShot`（`src/agent/IsolatedRunner.ts`）：

- `AgentPool.runIsolated` — 定时任务（schedule）触发，包一层注入 `ScheduleTool` MCP + `broadcastReply` 回写到群
- `semaclaw agent-task` — Hook / 脚本触发，只关心 prompt → 文本/JSON 输出

也就是说，**所有底层 SemaCore 生命周期、超时、dispose 行为完全一致**。差异仅在调用层包装。

---

## 局限 / 已知坑

- **空输出**：如果 main agent 全程只调工具不出文本就 idle，`--output text` 会输出空行，`--output json` 会退出 `3`。Hook 脚本侧自行兜底（推荐：检查 stdout 长度 / 在 prompt 里强制要求最终输出文本）。
- **不能多轮**：`agent-task` 一次只跑一个 prompt，到 idle 即销毁。需要多轮对话请用主流程 / 自己拼 history 进 prompt。
- **MCP 配置**：CLI 当前未暴露 `--mcp <config>`，如需 MCP 工具请在 prompt 里直接调用已有的或扩展 IsolatedRunner。
