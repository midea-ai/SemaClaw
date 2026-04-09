---
name: clawhub
version: 1.1.0
description: Manage ClaWHub skills and local skill registry — search, install, update, uninstall, publish via clawhub, and enable/disable individual skills via the semaclaw CLI.
---

# ClaWHub Skill Marketplace & Local Skill Management

ClaWHub is the skill marketplace for semaclaw. Skills are installed into the managed directory and automatically loaded by all agents.

## Decision Tree

```
User wants to...
├── find a skill          → clawhub search
├── add a skill           → clawhub install
├── upgrade a skill       → clawhub update
├── remove a skill        → clawhub uninstall
├── see what's installed  → clawhub list
├── publish their skill   → clawhub publish (requires login)
├── use a mirror          → set CLAWHUB_REGISTRY env var
├── list all skills       → skills list
├── disable a skill       → skills disable <name>
└── enable a skill        → skills enable <name>
```

## Commands

### search

```bash
semaclaw clawhub search <query> [--limit <n>]
```

- Searches clawhub.ai (or the configured mirror) for matching skills
- `--limit <n>` — max results to return (default: 10)

Examples:
```bash
semaclaw clawhub search git
semaclaw clawhub search "code review" --limit 5
```

---

### install

```bash
semaclaw clawhub install <slug> [--force] [--version <v>] [--group <id>]
```

- Downloads and extracts the skill into the managed skills directory
- Warns if the skill is flagged as suspicious; blocks if flagged as malicious
- `--force` — reinstall even if already installed
- `--version <v>` — pin to a specific version (default: latest)
- `--group <id>` — install into a group workspace (`<workspaceDir>/<id>/skills/`) instead of the global managed dir

Examples:
```bash
semaclaw clawhub install git
semaclaw clawhub install github --version 1.0.0
semaclaw clawhub install git --force
semaclaw clawhub install git --group my-team
```

---

### update

```bash
semaclaw clawhub update [<slug>] [--all] [--force] [--version <v>]
```

- Updates one or all installed skills to their latest version
- Must provide either `<slug>` or `--all`, not both
- `--all` — update every skill in the managed directory
- `--force` — overwrite even if already on the target version
- `--version <v>` — pin to a specific version (single slug only)

Examples:
```bash
semaclaw clawhub update git
semaclaw clawhub update --all
semaclaw clawhub update git --version 1.0.5 --force
```

---

### list

```bash
semaclaw clawhub list
```

Shows all ClaWHub-managed installed skills with their version and install date.

---

### uninstall

```bash
semaclaw clawhub uninstall <slug> [--yes]
```

- Removes the skill directory and its lockfile entry
- Prompts for confirmation unless `--yes` is passed

Examples:
```bash
semaclaw clawhub uninstall git
semaclaw clawhub uninstall git --yes
```

---

### login / logout / whoami

```bash
semaclaw clawhub login [--token <clh_...>]
semaclaw clawhub logout
semaclaw clawhub whoami
```

- `login` — save a ClaWHub API token (required for publish). Get token at https://clawhub.ai/settings/tokens
- `logout` — remove the stored token
- `whoami` — show the currently authenticated user

> These commands require the official clawhub.ai registry. They will fail with a clear error if `CLAWHUB_REGISTRY` points to a mirror.

---

### publish

```bash
semaclaw clawhub publish <path> [--dry-run] [--tags <tags>] [--registry <url>]
```

- Publishes a skill directory to ClaWHub (requires login)
- The directory must contain a `SKILL.md` with `name` and `version` frontmatter fields
- `--dry-run` — preview files and metadata without uploading
- `--tags <tags>` — comma-separated tags (default: `latest`)
- `--registry <url>` — override the target registry (ignores `CLAWHUB_REGISTRY`)

Examples:
```bash
semaclaw clawhub publish ./my-skill
semaclaw clawhub publish ./my-skill --dry-run
semaclaw clawhub publish ./my-skill --tags latest,v2
```

---

## Local Skill Management (`semaclaw skills`)

These commands manage skills from **all sources** (bundled, clawhub-managed, global `~/.sema/skills`, etc.).

### skills list

```bash
semaclaw skills list [--verbose] [--json]
```

Lists all locally available skills with their source, version, and enabled/disabled status.

- `--verbose` — show directory path and full description
- `--json` — output as JSON array (includes `disabled` boolean per skill)

---

### skills info

```bash
semaclaw skills info <name>
```

Shows full details for a single skill: version, source, directory, status (enabled/disabled).

---

### skills check

```bash
semaclaw skills check
```

Scans all skill source directories, reports counts, lists disabled skills, and warns about duplicate names.

---

### skills disable / enable

```bash
semaclaw skills disable <name>
semaclaw skills enable <name>
```

- `disable` — prevents the named skill from loading for **all agents**. The skill stays on disk; it is just excluded from the skill registry at load time.
- `enable` — re-enables a previously disabled skill.
- Changes take effect immediately: the daemon receives a reload signal and all running agents reload their skill registry.
- Disabled list is stored in `~/.semaclaw/disabled-skills.json`.

Examples:
```bash
semaclaw skills disable docx       # stop loading the docx skill
semaclaw skills enable docx        # re-enable it
semaclaw skills list               # check status (shows [disabled] tag)
```

---

### skills refresh

```bash
semaclaw skills refresh
```

Manually signals the daemon to reload the skill registry for all running agents (useful after manually editing skill files).

---

## Mirror Configuration (国内镜像)

Set `CLAWHUB_REGISTRY` to use a mirror for search/install/update:

```bash
export CLAWHUB_REGISTRY=https://lightmake.site
semaclaw clawhub search git
semaclaw clawhub install git
```

Mirror supports: `search` / `install` / `update` / `list` / `uninstall`
Mirror does **not** support: `login` / `whoami` / `publish` (these need clawhub.ai account service)

To make it permanent, add to your shell profile or `.env`:
```bash
CLAWHUB_REGISTRY=https://lightmake.site
```

---

## Workflow: find and install a skill

1. Search for the skill: `semaclaw clawhub search <keyword>`
2. Note the slug from results
3. Install: `semaclaw clawhub install <slug>`
4. Verify: `semaclaw clawhub list`

## Workflow: publish a skill

1. Create a directory with `SKILL.md` containing `name` and `version` fields
2. Login: `semaclaw clawhub login`
3. Dry-run to preview: `semaclaw clawhub publish <path> --dry-run`
4. Publish: `semaclaw clawhub publish <path>`

## SKILL.md frontmatter required fields

```yaml
---
name: my-skill-name
version: 1.0.0
---
```

Optional fields: `slug` (defaults to directory name), `changelog`
