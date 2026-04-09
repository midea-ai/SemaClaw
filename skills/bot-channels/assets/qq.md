# QQ Channel 绑定指南

## 前置条件：创建 QQ Bot

> 🦞 **龙虾专用入口**：[https://q.qq.com/qqbot/openclaw/login.html](https://q.qq.com/qqbot/openclaw/login.html)
>
> 扫码登录后创建机器人，记录 **App ID** 和 **App Secret**（即 Client Secret）。

---

## 方式一：主应用（.env 配置）

适用于第一个 / 最主要的 QQ Bot，直接写入 `.env`：

```bash
# .env
QQ_APP_ID=1234567890
QQ_APP_SECRET=xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx

# 可选：沙箱模式（开发测试用，默认 false）
# QQ_SANDBOX=true
```

修改后重启 semaclaw 生效。Bot 收到第一条消息后自动绑定到真实 JID（私聊或群组），无需手动配置。

---

## 方式二：额外应用（Web UI 或 CLI）

适用于绑定第二个、第三个 QQ Bot 到不同 agent folder，配置写入 `~/.semaclaw/config.json`，**无需重启即时生效**。

### Web UI 配置

打开 Settings → Agents → **新增 Agent**，选择 Channel 为 `QQ`：

| 字段 | 必填 | 说明 |
|------|------|------|
| 显示名称 | ✓ | Agent 在 UI 中的名称 |
| Agent ID | ✓ | 绑定的 agent folder（小写字母/数字/连字符） |
| App ID | ✓ | QQ Bot 的 App ID |
| App Secret | ✓ | QQ Bot 的 App Secret |
| 沙箱模式 | | 开发测试时启用，默认关闭 |

> QQ Channel **不支持手动填写 JID**。Bot 收到第一条消息后自动完成绑定（pending → 真实 JID）。

### CLI 配置

```bash
# 新增（JID 自动绑定）
semaclaw channel qq add \
  --app-id 1234567890 \
  --app-secret xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx \
  --group mybot \
  --name "我的QQ机器人"

# 沙箱模式
semaclaw channel qq add \
  --app-id 1234567890 \
  --app-secret xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx \
  --group mybot-sandbox \
  --name "QQ机器人(沙箱)" \
  --sandbox

# 查看
semaclaw channel qq list
semaclaw channel list            # 所有 channel 类型汇总

# 删除（同时移除关联的 group binding）
semaclaw channel qq remove --app-id 1234567890
```

| 参数 | 必填 | 说明 |
|------|------|------|
| `--app-id` | ✓ | QQ Bot App ID |
| `--app-secret` | ✓ | QQ Bot App Secret |
| `--group` | ✓ | 绑定的 agent folder（小写字母/数字/连字符） |
| `--name` | | 显示名称（可选，默认为 `<folder>(qq)`） |
| `--sandbox` | | 启用沙箱模式（可选） |

> CLI 新增需重启后生效；Web UI 新增无需重启。删除操作两者均同步 config.json。

> **注意**：`remove` 仅对方式二有效。方式一（`.env`）的主应用需手动清空 `.env` 中对应字段后重启。

---

## Pending 自动绑定说明

QQ 的 openid 是**每个 App 独立分配**的，无法预先知道。因此绑定流程为：

1. 添加 Bot（CLI / Web UI）后，系统记录 `qq:pending:{appId}`
2. Bot 收到**第一条消息**时，自动将 pending 迁移到真实 JID（如 `qq:user:XXXX` 或 `qq:group:XXXX`）
3. 迁移后 Agent 立即处理该条消息，无需重发

> 每个 pending 绑定只能迁移到**一个** JID（第一条消息来自哪里就绑哪里）。若需同时支持私聊和群组，分别添加两个绑定（使用同一 App ID 下不同 folder）即可。

---

## 触发机制

| 场景 | 默认行为 |
|------|---------|
| 私聊 Bot | 每条消息都触发 Agent |
| 群组（requiresTrigger = true） | 需要 @Bot 才触发 |
| 群组（requiresTrigger = false） | 每条消息都触发 |

Web UI 中可在 Agent 设置里切换 `requiresTrigger`。

---

## 常见问题

**Q：Bot 连接后收不到消息**
→ 确认在 QQ 开放平台已开启 WebSocket 长连接，并正确配置 Bot 权限范围。

**Q：权限/问题审批界面显示数字菜单而非按钮**
→ 正常现象。QQ Bot 的内联按钮（Markdown Keyboard）需要平台额外审批，未开放时自动降级为编号文本菜单，回复序号即可操作。

**Q：沙箱和正式模式的区别**
→ 沙箱模式连接 QQ 测试环境，消息仅在测试账号间流通，不影响线上用户。开发调试时建议使用。

**Q：同一个 QQ Bot 能绑定多个群组吗**
→ 目前每个 App ID 只能绑定到**一个** pending 绑定（即第一条消息决定 JID）。若需服务多个群组，需申请多个 Bot App。

**Q：添加后收到第一条消息但 Agent 没启动**
→ 检查后端日志是否有 `QQ pending binding completed`，若无则确认 Bot 已重启（CLI 方式需重启）且 addApp 连接成功。
