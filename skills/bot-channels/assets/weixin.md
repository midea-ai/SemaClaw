# 微信 Channel 绑定指南

> **注意**：微信绑定依赖**用户本人扫描二维码**，无法通过 agent 代劳。本文档仅展示操作方法，请用户自行在终端执行。

---

## 前置条件

微信 Channel 使用 **iLink Bot API**（`ilinkai.weixin.qq.com`），基于企业微信 iLink 协议，**无需预先申请 App ID / App Secret**——凭证在扫码后由服务端自动下发并保存。

---

## 方式一：主账户（.env 配置）

适用于单账户场景，绑定到 `agents/main/`。

**第一步：配置 .env**

```bash
# .env
WECHAT_ENABLED=true

# 可选：自定义绑定到其他 folder（默认 main）
# WECHAT_AGENT_FOLDER=main
```

**第二步：启动并扫码**

```bash
semaclaw start
```

启动后终端会自动展示二维码，用微信扫码确认即完成登录，凭证自动保存到：

```
~/.semaclaw/wechat/accounts/default.json
```

后续重启无需重新扫码（凭证长期有效）。若 session 过期，重启时会再次弹出二维码。

---

## 方式二：额外账户（CLI）

适用于绑定多个微信账户到不同 agent folder。

> **Web UI 不支持新增微信账户**（因为扫码必须在终端完成）。Web UI 仅支持删除。

### 新增

```bash
semaclaw channel wechat add --group <folder> [--name <name>]
```

| 参数 | 必填 | 说明 |
|------|------|------|
| `--group` | ✓ | 绑定的 agent folder（小写字母、数字、连字符，如 `alice`） |
| `--name` | | 显示名称（可选，默认与 folder 相同） |

执行后重启 semaclaw，终端会显示该账户的微信二维码，扫码后凭证自动保存到：

```
~/.semaclaw/wechat/accounts/<folder>.json
```

**示例：**

```bash
# 新增名为 alice 的微信账户
semaclaw channel wechat add --group alice --name "Alice的微信"

# 重启，终端出现二维码后扫码完成绑定
semaclaw start
```

Bot 收到**第一条消息**后，系统自动将 `wx:pending:<folder>` 迁移到真实 JID（`wx:user:<userId>`），无需任何额外操作。

### 查看

```bash
semaclaw channel wechat list     # 微信账户列表
semaclaw channel list            # 所有 channel 汇总
```

### 删除

```bash
semaclaw channel wechat remove --group <folder>
```

会同时删除：
- `~/.semaclaw/wechat/accounts/<folder>.json`（凭证）
- `~/.semaclaw/wechat/sync-buf-<folder>.bin`（消息游标）
- `~/.semaclaw/wechat/context-tokens-<folder>.json`（对话 token 缓存）
- `config.json` 中对应的 group binding

删除后重启 semaclaw 生效。

> **注意**：`remove` 仅对方式二（CLI 添加的账户）有效。方式一（`.env`）的主账户需手动将 `.env` 中 `WECHAT_ENABLED` 改为 `false` 并删除 `~/.semaclaw/wechat/accounts/default.json` 后重启。

---

## Pending 自动绑定说明

微信用户 ID 无法预先知道，因此绑定流程为：

1. CLI 新增后，系统记录 `wx:pending:<folder>`
2. Bot 收到**第一条消息**时，自动迁移到真实 JID（`wx:user:<userId>`）
3. 迁移后 Agent 立即处理该条消息，无需重发

---

## 触发机制

微信 iLink Bot 当前仅支持 **1:1 私聊**，每条消息都会触发 Agent，无需 @Bot。

---

## 常见问题

**Q：启动后没有出现二维码**
→ 确认 `.env` 中 `WECHAT_ENABLED=true`（方式一），或 `config.json` 中有 `wechatAccounts` 条目（方式二）。若凭证文件已存在，说明上次登录仍有效，不需要重新扫码。

**Q：扫码后提示"二维码已过期"**
→ 正常现象，系统会自动刷新（最多刷新 3 次）。若多次过期，检查网络连接后重启。

**Q：收到消息但 Agent 没有回复**
→ 确认日志中是否有 `WeChat pending binding completed`（方式二首次）或 `WeChatChannel connected`。若有 `无 context_token` 提示，说明是旧版本 bug，升级后重启即可。

**Q：session 过期怎么办**
→ 日志出现 `session 已过期，需要重新扫码登录` 时，删除对应的凭证文件后重启：
```bash
# 方式一主账户
rm ~/.semaclaw/wechat/accounts/default.json

# 方式二额外账户（以 alice 为例）
semaclaw channel wechat remove --group alice
semaclaw channel wechat add --group alice --name "Alice的微信"
```

**Q：同一个微信账户能绑定多个 folder 吗**
→ 不支持。每个微信账户（iLink Bot）只能绑定到一个 folder，对应一个 Agent 实例。
