# Telegram Channel 绑定指南

## 前置条件

1. 在 Telegram 中找到 [@BotFather](https://t.me/BotFather)，发送 `/newbot` 创建一个 Bot，获得 **Bot Token**
2. 获取自己的 **Telegram User ID**（可向 [@userinfobot](https://t.me/userinfobot) 发消息获取）

---

## 方式一：主 Bot（.env 配置）

适用于第一个 / 最主要的 Bot 绑定，默认绑定到 `agents/main/`。

```bash
# .env
TELEGRAM_BOT_TOKEN=123456:ABC-your-token
ADMIN_TELEGRAM_USER_ID=987654321

# 可选：自定义绑定到其他 folder（默认 main）
# TELEGRAM_AGENT_FOLDER=main
```

修改后重启 semaclaw 生效。

---

## 方式二：额外 Bot（Web UI 或 CLI）

适用于绑定第二个、第三个 Bot 到不同 agent folder，配置写入 `~/.semaclaw/config.json`，**无需重启即时生效**。

### Web UI 配置

打开 Settings → Agents → **新增 Agent**，选择 Channel 为 `Telegram`：

| 字段 | 必填 | 说明 |
|------|------|------|
| 显示名称 | ✓ | agent 在 UI 中的名称 |
| Agent ID | ✓ | 绑定的 agent folder（小写字母/数字/连字符） |
| Chat ID | ✓ | 对话方的 Telegram ID（用户或群组） |
| 类型 | ✓ | `User`（私聊）或 `Group`（群组） |
| Bot Token | User 类型必填 | 专属 Bot 的 Token；Group 类型可留空使用默认 Bot |

- **User 类型**：Bot Token 必填，绑定写入 config.json，Bot 立即开始 polling
- **Group 类型**：Bot 必须已在群内，Bot Token 可选（空则沿用 `.env` 默认 Bot）

删除时在 agent 卡片点击删除按钮，User 类型绑定会同步从 config.json 移除。

### CLI 配置

```bash
# 新增
semaclaw channel telegram add \
  --token 123456:ABC-your-token \
  --user 987654321 \
  --group alice

# 查看
semaclaw channel telegram list
semaclaw channel list            # 所有 channel 类型汇总

# 删除（需重启生效）
semaclaw channel telegram remove --token 123456:ABC-your-token
```

| 参数 | 必填 | 说明 |
|------|------|------|
| `--token` | ✓ | BotFather 生成的 Bot Token |
| `--user` | ✓ | 管理员的 Telegram User ID |
| `--group` | ✓ | 绑定的 agent folder |
| `--name` | | 显示名称（可选） |

> CLI 新增需重启后生效；Web UI 新增无需重启。删除操作两者均同步 config.json，下次启动不会再加载该 Bot。

> **注意**：`remove` 仅对方式二有效。方式一（`.env`）的主 Bot 需手动清空 `.env` 中的 `TELEGRAM_BOT_TOKEN` 和 `ADMIN_TELEGRAM_USER_ID` 后重启，回退到 Web-only。

---

## 多 Bot 共用同一 folder 的说明

两个 Bot 可以绑定到同一个 folder（同一个 agent），此时：

- 两个 Bot 各自独立 polling Telegram
- 所有消息路由到**同一个 agent instance**，串行处理
- 两边用户的对话历史**共享**（相当于群聊）

建议：除非有明确的"备用号"需求，**每个 folder 只绑一个 Bot**，避免串行阻塞和上下文污染。
