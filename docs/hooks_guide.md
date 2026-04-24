# SemaClaw Hooks Guide

Hooks let you intercept and react to agent lifecycle events — running shell scripts or LLM-based checks at key moments without touching the core runtime.

---

## Config Files

Hooks are configured in JSON files loaded once at startup and merged in order (workspace entries appended after global):

| Scope | Path |
|---|---|
| Global | `~/.semaclaw/hooks.json` |
| Per-workspace | `<workingDir>/.semaclaw/hooks.json` |

Edit the global config directly from the Web UI under **Plugins → Hooks**. Changes to `hooks.json` take effect after restarting SemaClaw.

---

## Supported Events

| Event | When it fires | Blocking? |
|---|---|---|
| `UserPromptSubmit` | After user message enters `processQuery`, before first LLM call | No (context injection only) |
| `PreToolUse` | Before each tool executes, before permission check | Yes |
| `PostToolUse` | After each tool completes | No (post-hoc) |
| `PermissionRequest` | When a permission approval request is raised | Yes |
| `Stop` | When agent finishes the current reply | No (post-hoc) |
| `SessionStart` | After a new session is initialized | No |
| `PreCompact` | Before context compaction runs | No (awaited) |
| `PostCompact` | After context compaction finishes | No (post-hoc) |

> **PermissionRequest note:** hooks only fire when SemaClaw actually raises a permission prompt. If `skipBashExecPermission` / `skipFileEditPermission` / etc. are set, those tool categories are auto-approved and skip this event. Use `PreToolUse` for unconditional interception.

---

## Config Format

```jsonc
{
  "hooks": {
    "<EventName>": [
      {
        "matcher": "Bash",           // glob on tool name (optional, default "*")
        "if": "^git (commit|push)",  // regex on tool_input content (optional)
        "hooks": [
          {
            "type": "command",       // "command" or "prompt"
            "command": "python3 ${SEMACLAW_ROOT}/hooks/my-hook.py",
            "timeout": 10,           // seconds (default 10)
            "blocking": true,        // block agent on failure (default true)
            "async": false           // fire-and-forget (default false)
          }
        ]
      }
    ]
  }
}
```

### matcher (glob)

Matched against the tool name for tool events, or the full query text for `UserPromptSubmit`.

| Pattern | Matches |
|---|---|
| `"Bash"` | exactly Bash |
| `"Bash,Write"` | Bash or Write |
| `"Bash*"` | anything starting with Bash |
| `"*"` | everything |
| *(omitted)* | everything (same as `"*"`) |

### if (regex)

Secondary filter on the tool input content. For Bash, it matches against `tool_input.command`; for all other tools, against the JSON-serialized `tool_input`.

```jsonc
"if": "rm -rf"              // contains "rm -rf"
"if": "^git (commit|push)"  // starts with git commit or git push
"if": "\\.(env|key|pem)$"   // ends with .env, .key, or .pem
```

### blocking / async modes

| Config | Behavior | Typical use |
|---|---|---|
| default | Sync, failure blocks agent | Safety checks |
| `"blocking": false` | Sync, failure does not block | Low-latency logging |
| `"blocking": false, "async": true` | Fire-and-forget | Slow audit uploads |

Auto-correction rules applied at config load time:
- `prompt` type forces `async: false` (must wait for LLM response)
- `async: true` forces `blocking: false` (async cannot block)
- Post-hoc events (`Stop`, `PostToolUse`, `PostCompact`, …) ignore `blocked` results — there is nothing left to block

---

## Hook Types

### command

Runs an external script in a subprocess. Cross-platform: `sh -c` on Mac/Linux, `cmd /c` on Windows.

**Protocol:**
- **Input:** event JSON sent to stdin
- **Output:** optional JSON printed to stdout (see below)
- **Exit code:** 0 = success; non-zero = failure (treated as blocked for blocking hooks)

**Stdout JSON** (all fields optional — omit entirely to take no action):

```json
{
  "decision": "approve",
  "reason": "...",
  "abort": false,
  "updatedInput": { },
  "additionalContext": "..."
}
```

| Field | Values | Notes |
|---|---|---|
| `decision` | `"approve"` \| `"reject"` \| `"skip"` | `"skip"` passes through without decision |
| `reason` | string | Returned to the agent when rejected |
| `abort` | boolean | `true` = hard-abort the entire session on reject (default false) |
| `updatedInput` | object | Rewrite the tool input in-place (PreToolUse only) |
| `additionalContext` | string | Inject a message into the conversation context |

**reject behavior:**
- `reject` + `abort: false` (default) → returns `reason` as an error; agent continues and can retry or adapt
- `reject` + `abort: true` → returns error and terminates the session; use for critical safety violations

### prompt

Calls the quick LLM model with a single-shot prompt — no script required. The model receives only the event JSON as context, has no tools, and must return a decision JSON.

```json
{
  "type": "prompt",
  "prompt": "Check if this bash command is safe. Reject only clearly destructive operations.",
  "timeout": 30
}
```

---

## prompt hook vs. command hook — The Boundary

**Counterintuitive point 1: a command hook can inject prompts.**

The `additionalContext` field in the stdout JSON is injected into the agent's conversation context. So a shell script that runs an LLM call and returns `{"additionalContext": "..."}` is effectively a command hook that injects a prompt. Nothing in the protocol prevents this.

**Counterintuitive point 2: a prompt hook is not an agent.**

A prompt hook is an LLM-powered `if` statement. It receives the raw event JSON, produces a single `approve`/`reject`/`skip` decision, and exits. It has:

- No tools
- No conversation history
- No memory
- No multi-step reasoning
- One shot — no retry, no follow-up

If you need actual reasoning with tools (read a file, call an API, check a database), use a `command` hook whose script does that work — or use the `Task` tool to spawn a real virtual agent.

**When to use which:**

| Scenario | Choice |
|---|---|
| "Is this command safe?" — pure semantic judgment | `prompt` |
| "Log this to a file" — no LLM needed | `command` |
| "Check git blame before allowing this edit" — external tool required | `command` |
| "Approve only if the diff touches <100 lines" — local computation | `command` |
| Multi-step reasoning with tools | `Task` tool (virtual agent) |

`command` is strictly more powerful than `prompt` — a script can always call an LLM API. `prompt` exists because writing a script, managing dependencies, and parsing JSON responses is boilerplate that most "ask LLM to judge X" use cases don't need.

---

## Variables

Available in `command` and `prompt` strings. Resolved at config load time, and also passed as environment variables to child processes.

| Variable | Value |
|---|---|
| `${SEMACLAW_ROOT}` | Global config dir (`~/.semaclaw`) |
| `${AGENT_WORKSPACE}` | Agent working directory |

Access from script: `os.environ["AGENT_WORKSPACE"]`

---

## Event Input Reference

All events share these base fields:

```json
{
  "hook_event_name": "PreToolUse",
  "session_id": "abc-123",
  "agent_id": "main",
  "timestamp": "2026-04-17T10:30:00.000Z",
  "cwd": "/path/to/workspace"
}
```

Event-specific fields:

**PreToolUse / PostToolUse**
```json
{
  "tool_name": "Bash",
  "tool_input": { "command": "git status" },
  "tool_response": "..."
}
```
(`tool_response` is only present in `PostToolUse`)

**PermissionRequest**
```json
{
  "tool_name": "Bash",
  "tool_input": { "command": "rm -rf /tmp/x" }
}
```

**PreCompact**
```json
{
  "message_count": 42,
  "context_history": [ ]
}
```

---

## Examples

Place scripts in `~/.semaclaw/hooks/` and reference them with `${SEMACLAW_ROOT}/hooks/<name>.py`.

### 1. Block dangerous shell commands

**`~/.semaclaw/hooks/block-dangerous.py`**

```python
#!/usr/bin/env python3
import sys, json

DANGEROUS_PATTERNS = [
    "rm -rf /",
    "dd if=",
    "mkfs.",
    "> /dev/",
    "chmod -R 777 /",
]

def main():
    data = json.load(sys.stdin)
    command = data.get("tool_input", {}).get("command", "")

    for pattern in DANGEROUS_PATTERNS:
        if pattern in command:
            print(json.dumps({
                "decision": "reject",
                "reason": f"Blocked: command contains '{pattern}'",
                "abort": False,
            }))
            return

    print(json.dumps({"decision": "approve"}))

if __name__ == "__main__":
    main()
```

**`~/.semaclaw/hooks.json`**

```json
{
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "Bash",
        "hooks": [
          {
            "type": "command",
            "command": "python3 ${SEMACLAW_ROOT}/hooks/block-dangerous.py",
            "timeout": 5,
            "blocking": true
          }
        ]
      }
    ]
  }
}
```

---

### 2. Log all tool calls

Records every tool invocation to a per-workspace JSONL file. Non-blocking so it never delays the agent.

**`~/.semaclaw/hooks/tool-logger.py`**

```python
#!/usr/bin/env python3
import sys, json, os
from datetime import datetime, timezone
from pathlib import Path

def main():
    data = json.load(sys.stdin)
    workspace = os.environ.get("AGENT_WORKSPACE", os.getcwd())

    log_dir = Path(workspace) / ".semaclaw" / "hook-logs"
    log_dir.mkdir(parents=True, exist_ok=True)
    log_file = log_dir / "tool-calls.jsonl"

    entry = {
        "ts": datetime.now(timezone.utc).isoformat(),
        "event": data.get("hook_event_name"),
        "tool": data.get("tool_name"),
        "input": data.get("tool_input"),
        "session": data.get("session_id"),
        "agent": data.get("agent_id"),
    }

    with open(log_file, "a", encoding="utf-8") as f:
        f.write(json.dumps(entry, ensure_ascii=False) + "\n")

if __name__ == "__main__":
    main()
```

**Config:**

```json
{
  "hooks": {
    "PostToolUse": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "python3 ${SEMACLAW_ROOT}/hooks/tool-logger.py",
            "timeout": 5,
            "blocking": false
          }
        ]
      }
    ]
  }
}
```

---

### 3. Save conversation history before compaction

Captures the full message list to a JSON file every time auto-compaction is about to run — useful for debugging context loss or auditing long sessions.

**`~/.semaclaw/hooks/compact-logger.py`**

```python
#!/usr/bin/env python3
import sys, json, os
from datetime import datetime, timezone
from pathlib import Path

def main():
    data = json.load(sys.stdin)
    workspace = os.environ.get("AGENT_WORKSPACE", os.getcwd())

    log_dir = Path(workspace) / ".semaclaw" / "hook-logs"
    log_dir.mkdir(parents=True, exist_ok=True)

    ts = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    log_file = log_dir / f"compact-{ts}.json"

    payload = {
        "timestamp": datetime.now(timezone.utc).isoformat(),
        "session_id": data.get("session_id"),
        "agent_id": data.get("agent_id"),
        "message_count": data.get("message_count"),
        "context_history": data.get("context_history", []),
    }

    with open(log_file, "w", encoding="utf-8") as f:
        json.dump(payload, f, ensure_ascii=False, indent=2)

    # Keep only the 10 most recent compaction logs
    logs = sorted(log_dir.glob("compact-*.json"))
    for old in logs[:-10]:
        old.unlink(missing_ok=True)

if __name__ == "__main__":
    main()
```

**Config:**

```json
{
  "hooks": {
    "PreCompact": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "python3 ${SEMACLAW_ROOT}/hooks/compact-logger.py",
            "timeout": 10,
            "blocking": false
          }
        ]
      }
    ]
  }
}
```

---

### 4. Auto-approve permission requests with LLM judgment

Uses a `prompt` hook on `PermissionRequest` to automatically approve or escalate based on semantic understanding of the tool input — no script required.

```json
{
  "hooks": {
    "PermissionRequest": [
      {
        "matcher": "Bash",
        "hooks": [
          {
            "type": "prompt",
            "prompt": "You are a security gate for an AI agent. Review the bash command in tool_input. Approve if it is a routine read, list, git, or build operation. Reject (with a short reason) only if it is clearly destructive or modifies system files outside the workspace. When in doubt, approve.",
            "timeout": 30,
            "blocking": true
          }
        ]
      }
    ]
  }
}
```

---

### 5. Inject context on every user message

Adds a standing instruction to every agent turn without modifying the system prompt.

```json
{
  "hooks": {
    "UserPromptSubmit": [
      {
        "hooks": [
          {
            "type": "prompt",
            "prompt": "Read the user message in tool_input. If it mentions a file path, check whether that path looks relative or absolute and add a short note to additionalContext reminding the agent to confirm the working directory. Otherwise approve with no additionalContext.",
            "timeout": 15,
            "blocking": false
          }
        ]
      }
    ]
  }
}
```

---

### 6. Block git push to protected branches

Uses the `if` field to narrow the hook to only `git push` commands, avoiding unnecessary subprocess overhead on every Bash call.

**`~/.semaclaw/hooks/block-protected-push.py`**

```python
#!/usr/bin/env python3
import sys, json, re

PROTECTED = re.compile(r"\b(main|master|production|release)\b")

def main():
    data = json.load(sys.stdin)
    command = data.get("tool_input", {}).get("command", "")

    if PROTECTED.search(command):
        print(json.dumps({
            "decision": "reject",
            "reason": f"Direct push to a protected branch is not allowed. Use a feature branch and open a PR.",
            "abort": False,
        }))
    else:
        print(json.dumps({"decision": "approve"}))

if __name__ == "__main__":
    main()
```

**Config:**

```json
{
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "Bash",
        "if": "git push",
        "hooks": [
          {
            "type": "command",
            "command": "python3 ${SEMACLAW_ROOT}/hooks/block-protected-push.py",
            "timeout": 5,
            "blocking": true
          }
        ]
      }
    ]
  }
}
```

---

## Combining Multiple Hooks

All hooks matching an event run in parallel (`Promise.allSettled`). Aggregation rules:

- Any blocking hook returning `reject` → the event is blocked
- Non-blocking hook failures are logged but do not affect the agent
- Async hooks (`async: true`) are not included in the aggregation result at all

This means you can safely combine a fast pattern-based `command` check (blocking) with a slow LLM-based `prompt` check (also blocking) and a fire-and-forget audit logger (`async: true`) on the same event — they all run concurrently.

```json
{
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "Bash",
        "hooks": [
          {
            "type": "command",
            "command": "python3 ${SEMACLAW_ROOT}/hooks/block-dangerous.py",
            "timeout": 5,
            "blocking": true
          },
          {
            "type": "prompt",
            "prompt": "Check if this bash command is safe for a developer workstation. Reject only clearly destructive operations.",
            "timeout": 20,
            "blocking": true
          },
          {
            "type": "command",
            "command": "python3 ${SEMACLAW_ROOT}/hooks/tool-logger.py",
            "timeout": 5,
            "blocking": false,
            "async": true
          }
        ]
      }
    ]
  }
}
```
