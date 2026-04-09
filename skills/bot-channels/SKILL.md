---
name: bot-channels
description: Bind and manage bot channels (Telegram, WeChat(微信/weixin), Feishu(飞书), QQ) for SemaClaw agents via CLI or Web UI
---

# Bot Channel Management

SemaClaw agents communicate through channels. Each channel requires a bot account on the platform and a binding to an agent folder.

> **Language**: Always respond to the user in the language they used. Translate all guidance from asset files into the user's language when presenting it.

---

## Quick Reference

| Channel  | Provider             | Guide                                    | Credentials                       |
|----------|----------------------|------------------------------------------|-----------------------------------|
| Telegram | Telegram Bot         | [assets/telegram.md](assets/telegram.md) | Bot Token + User ID               |
| WeChat   | iLink Bot API        | [assets/weixin.md](assets/weixin.md)     | QR code scan (no App ID required) |
| Feishu   | Feishu Open Platform | [assets/feishu.md](assets/feishu.md)     | App ID + App Secret               |
| QQ       | QQ Open Platform     | [assets/qq.md](assets/qq.md)             | App ID + App Secret               |

> **When the user explicitly mentions a specific channel (e.g. "Telegram", "Feishu", "WeChat", "QQ"), you MUST read the corresponding asset file (Guide column above) first, then present its full content to the user in their language. Do not summarize — show the complete guide.**

---

## Channel Differences at a Glance

| Channel  | Web UI add? | QR scan? | Pending auto-bind? | CLI add requires restart? |
|----------|-------------|----------|--------------------|---------------------------|
| Telegram | Yes         | No       | No                 | Yes                       |
| WeChat   | No (delete only) | **Yes** | Yes           | Yes                       |
| Feishu   | Yes         | No       | Yes (optional)     | Yes                       |
| QQ       | Yes         | No       | Yes                | Yes                       |

**WeChat**: Extra accounts can only be added via CLI — Web UI does not support adding WeChat accounts because QR scanning must happen in the terminal.

**Feishu**: Requires four setup steps on Feishu Open Platform before binding: create app, configure event subscription (long connection), batch-add permissions, and publish the app.

---

## First-time Setup

When a user asks to set up a channel for the first time, **present all available methods and let the user decide** — do not act on their behalf without confirmation.

### Configuration Methods

| Method   | Best for                        | Restart required? | Where                        |
|----------|---------------------------------|-------------------|------------------------------|
| `.env`   | First / primary Bot             | Yes               | Edit `.env` manually         |
| Web UI   | Adding extra Bots, group binding | No               | Settings → Agents            |
| CLI      | Extra Bots, scripted/batch ops  | Yes               | Terminal                     |

> All channels: CLI add requires a restart to take effect; Web UI add is instant.

### How to Handle a Binding Request

1. **Read the channel's asset file** and present the full guide to the user (translated to their language)
2. Ask whether this is the first Bot or an additional one
3. Recommend the right method:
   - First Bot → `.env` (simplest, no running service needed)
   - Extra Bot → Web UI (no restart, recommended); WeChat must use CLI
4. Only execute CLI commands if the user explicitly asks the agent to do it
5. After setup, remind the user to verify by sending a test message to the Bot

---

## CLI Commands (Agent use only)

> Only run these commands when the user explicitly asks the agent to perform the operation.

```bash
# List all configured channel bindings
semaclaw channel list

# -- Telegram --
semaclaw channel telegram list
semaclaw channel telegram add --token <bot-token> --user <user-id> --group <folder>
semaclaw channel telegram remove --token <bot-token>

# -- WeChat --
# After add: restart semaclaw; a QR code will appear in the terminal for scanning
semaclaw channel wechat list
semaclaw channel wechat add --group <folder> [--name <name>]
semaclaw channel wechat remove --group <folder>

# -- Feishu --
semaclaw channel feishu list
semaclaw channel feishu add --app-id <app-id> --app-secret <app-secret> --group <folder> [--name <name>] [--jid <jid>] [--domain lark]
semaclaw channel feishu remove --app-id <app-id>

# -- QQ --
semaclaw channel qq list
semaclaw channel qq add --app-id <app-id> --app-secret <app-secret> --group <folder> [--name <name>] [--sandbox]
semaclaw channel qq remove --app-id <app-id>
```

---

## When to Trigger This Skill

- User says "help me set up Telegram / Feishu(Lark) / WeChat / QQ"
- User says "add a bot" or "connect a channel"
- User reports a channel is not receiving messages or is disconnected
- User asks "how do I configure Telegram" or "what binding options are available"
- User asks "怎么绑定微信 / QQ / 飞书/ Telegram 账号"
