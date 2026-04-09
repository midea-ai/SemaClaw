# 飞书 Channel 绑定指南

## 前置条件

### 1. 创建飞书自建应用并添加机器人能力

1. 打开 [飞书开放平台](https://open.feishu.cn/app) → **创建企业自建应用**
2. 进入应用 → 左侧菜单 **添加应用能力** → 选择 **机器人**
3. 记录 **App ID** 和 **App Secret**（凭据与基本信息页面）

---

### 2. 配置事件订阅与卡片回调

进入应用 → **事件与回调**：

**事件配置：**
- 订阅方式选择 **「使用长连接接收事件」**
- 点击「添加事件」，搜索并添加：
  - `im.message.receive_v1`（接收消息）
  - `im.chat.member.bot.added_v1`（Bot 被加入群组，可选）

**卡片回调配置：**
- 回调类型选择 **「使用长连接接收回调」**
- 添加回调类型：`card.action.trigger`（权限审批交互按钮用）

---

### 3. 批量添加权限

进入应用 → **权限管理** → 点击右上角「**批量添加**」（JSON 导入）：

```json
{
  "scopes": {
    "tenant": [
      "im:message.p2p_msg:readonly",
      "contact:contact.base:readonly",
      "contact:user.base:readonly",
      "docx:document",
      "docx:document.block:convert",
      "docx:document:create",
      "docx:document:readonly",
      "docx:document:write_only",
      "im:chat:readonly",
      "im:message",
      "im:message.group_at_msg:readonly",
      "im:message:readonly",
      "im:message:send_as_bot",
      "im:resource",
      "wiki:member:create",
      "wiki:member:retrieve",
      "wiki:member:update",
      "wiki:node:copy",
      "wiki:node:create",
      "wiki:node:move",
      "wiki:node:read",
      "wiki:node:retrieve",
      "wiki:node:update",
      "wiki:setting:read",
      "wiki:setting:write_only",
      "wiki:space:read",
      "wiki:space:retrieve",
      "wiki:space:write_only",
      "wiki:wiki",
      "wiki:wiki:readonly"
    ],
    "user": [
      "contact:user.employee_id:readonly",
      "im:chat",
      "im:chat.managers:write_only"
    ]
  }
}

```

> `contact:user.base:readonly` 用于解析消息发送者姓名；如无需显示真实姓名可不加。

---

### 4. 发布应用

**版本管理与发布** → 创建版本 → 提交发布（企业内部应用通常无需审核，直接发布）。

> ⚠️ 事件订阅和权限修改后**必须发布新版本**才能生效。

---

## 方式一：主应用（.env 配置）

适用于第一个 / 最主要的飞书应用，直接写入 `.env`：

```bash
# .env
FEISHU_APP_ID=cli_xxxxxxxxxxxxxxxx
FEISHU_APP_SECRET=xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx

# 可选：lark（国际版）或自定义域名，默认 feishu
# FEISHU_DOMAIN=feishu
```

修改后重启 semaclaw 生效。

---

## 方式二：额外应用（Web UI 或 CLI）

适用于绑定第二个、第三个应用到不同 agent folder，配置写入 `~/.semaclaw/config.json`，**无需重启即时生效**。

### Web UI 配置

打开 Settings → Agents → **新增 Agent**，选择 Channel 为 `Feishu`：

| 字段 | 必填 | 说明 |
|------|------|------|
| 显示名称 | ✓ | Agent 在 UI 中的名称 |
| Agent ID | ✓ | 绑定的 agent folder（小写字母/数字/连字符） |
| App ID | ✓ | 飞书应用的 App ID |
| App Secret | ✓ | 飞书应用的 App Secret |
| Chat JID | | 可留空，第一条消息后自动绑定 |

**Chat JID 说明：**
- 留空 → 存为 `feishu:pending:{appId}`，Bot 收到第一条消息后自动迁移到真实 JID（群组或私聊）
- 手动填写 → 格式为 `feishu:group:oc_xxx`（群组）或 `feishu:user:ou_xxx`（私聊）

> 每个 pending 绑定只能迁移到**一个** JID（第一条消息来自哪里就绑哪里）。若需同时支持群聊和私聊，添加两个绑定即可。

### CLI 配置

```bash
# 新增（JID 留空，自动绑定）
semaclaw channel feishu add \
  --app-id cli_xxxxxxxxxxxxxxxx \
  --app-secret xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx \
  --group mybot \
  --name "我的飞书助手"

# 新增（指定已知 JID，跳过 pending 流程）
semaclaw channel feishu add \
  --app-id cli_xxxxxxxxxxxxxxxx \
  --app-secret xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx \
  --group mybot \
  --jid feishu:group:oc_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx

# 国际版（Lark）
semaclaw channel feishu add \
  --app-id cli_xxxxxxxxxxxxxxxx \
  --app-secret xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx \
  --group mybot \
  --domain lark

# 查看
semaclaw channel feishu list
semaclaw channel list            # 所有 channel 类型汇总

# 删除（同时移除关联的 group binding）
semaclaw channel feishu remove --app-id cli_xxxxxxxxxxxxxxxx
```

| 参数 | 必填 | 说明 |
|------|------|------|
| `--app-id` | ✓ | 飞书应用 App ID |
| `--app-secret` | ✓ | 飞书应用 App Secret |
| `--group` | ✓ | 绑定的 agent folder（小写字母/数字/连字符） |
| `--name` | | 显示名称（可选，默认同 folder） |
| `--jid` | | 指定 Chat JID（可选，留空则 pending 自动绑定） |
| `--domain` | | `feishu`（默认）或 `lark`（国际版） |

> CLI 新增需重启后生效；Web UI 新增无需重启。删除操作两者均同步 config.json。

> **注意**：`remove` 仅对方式二有效。方式一（`.env`）的主应用需手动清空 `.env` 中对应字段后重启。

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

**Q：发消息没有任何反应（无日志）**
→ 检查事件订阅是否选了「长连接」且已添加 `im.message.receive_v1`，发布新版本后再测试。

**Q：Bot 加群有日志，但发消息没日志**
→ `im.message.receive_v1` 未订阅或订阅后未发布新版本。

**Q：群里有多个 Bot，@ 新 Bot 却是旧 Bot 回复**
→ 不同应用的 Bot 应绑定到**不同的群组**，不要把两个 semaclaw Bot 加到同一个群里。

**Q：私聊不通**
→ 确认权限里有 `im:message.p2p_msg:readonly`，且应用已在企业内发布。
