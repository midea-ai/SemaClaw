---
name: wiki
description: Save learning/research documents to the personal wiki knowledge base and search existing content
version: 1.1.0
---

# Wiki Knowledge Base Management

The user's personal knowledge base is maintained with the `semaclaw wiki` command.
The wiki directory defaults to `{home}/semaclaw/wiki/` but may be relocated by configuration — `semaclaw wiki tree` prints the actual root path on its first line (`Wiki root: ...`); always use that path when accessing wiki files directly (e.g. `cp`).
The knowledge base is organized by topic folders, with each document as a Markdown file.

## Writing New Documents to Wiki

### Full Workflow

1. **View the directory structure** to understand existing topic categories:
   ```
   semaclaw wiki tree
   ```

2. **Determine the category**:
   - Content belongs to an existing directory → save directly there
   - No suitable directory exists → create a new topic directory under the closest parent:
     ```
     semaclaw wiki mkdir "new/directory/path"
     ```
   - Completely uncertain → stage in `inbox/` and inform the user to categorize later

3. **Save the document** (pipe full Markdown content via heredoc to stdin). Always provide `--type` and `--desc`:
   ```bash
   cat <<'WIKI_EOF' | semaclaw wiki save --path "directory/filename.md" --tags "tag1,tag2" --type "note" --desc "One-line summary of what this document covers"
   # Document Title

   Document content...
   WIKI_EOF
   ```

### Document Metadata (OKF-aligned)

The wiki follows the Open Knowledge Format conventions: every document carries YAML frontmatter that both humans and agents can rely on.

- `--type` (**always provide**): the concept type. Prefer one of: `note`, `paper-note`, `guide`, `runbook`, `reference`, `snippet`. Reuse types already present in the wiki before inventing a new one. **If unsure which type fits, use `note`** — broadly correct beats specific but wrong; never invent a speculative type.
- `--desc` (**always provide**): a one-line description of the document. This is shown in the UI and used by search — write it for someone deciding whether to open the document.
- `--resource` (optional): a URL or wiki-relative path pointing to the original/associated resource — the source article URL, an arXiv link, or a generated artifact (e.g. an HTML report saved alongside the note).

### Example

```bash
# Save an article about Rust async
cat <<'WIKI_EOF' | semaclaw wiki save --path "programming/rust/async-runtime.md" --tags "rust,async,tokio" --type "note" --desc "How Tokio's async runtime schedules tasks, with pitfalls" --resource "https://tokio.rs/tokio/tutorial"
# Rust Async Runtime Explained

## Core Concepts

Tokio is the most popular async runtime for Rust...

## Related

- [Rust ownership basics](../rust/ownership.md)
WIKI_EOF
```

Output JSON: `{"path": "programming/rust/async-runtime.md", "action": "created"}`

## Linking Related Documents (optional)

Documents can link to each other with standard Markdown relative links — the wiki UI resolves them, navigates in place, and shows backlinks on the target document.

Linking is **opportunistic, not required**: add a link only when you already know of (or encountered during this task) a genuinely related document. Do NOT run extra searches just to populate a `## Related` section, and never fabricate weak links — no links is better than noisy links.

When a real relation exists:
- Link inline where the concept is mentioned: `see [ownership](./ownership.md)`, or add a `## Related` section at the end:
  ```markdown
  ## Related

  - [Async runtime explained](../rust/async-runtime.md) — how the scheduler works
  ```
- Link paths are relative to the document's own location (`../rust/async-runtime.md`), or wiki-absolute starting with `/` (`/programming/rust/async-runtime.md`).
- Do NOT use `[[wikilink]]` syntax — only standard Markdown links are supported.

## Organizing Existing Documents

Use this workflow when the user wants to organize, classify, or tidy up documents already on disk into the wiki.

**Critical rules:**
- **Always use `cp` to copy files** — never rewrite or regenerate document content. Rewriting wastes time and risks altering the original.
- Use `mv` **only** when the user explicitly asks to move (e.g. "move it", "don't keep the original").
- **Never** rewrite document body content during organization. Only touch the YAML frontmatter.

### Full Workflow

1. **Read the document title and first ~300 characters** to infer the topic — do not read the entire file.

2. **View the wiki directory structure**:
   ```
   semaclaw wiki tree
   ```

3. **Determine the target category** using the same rules as saving:
   - Matches an existing directory → use it
   - No match → create with `semaclaw wiki mkdir "path"`
   - Uncertain → place in `inbox/`

4. **Copy the file** to the wiki (do not rewrite content). Use the root path printed by `semaclaw wiki tree`:
   ```bash
   cp "/source/path/document.md" "<wiki-root>/category/filename.md"
   # or on Windows: copy "source" "dest"
   ```

5. **Edit the YAML frontmatter** of the copied file to add/update tags and metadata. If no frontmatter exists, prepend it:
   ```markdown
   ---
   tags: [tag1, tag2]
   source: /original/path/document.md
   type: note
   description: One-line summary of the document
   ---
   ```
   Use the Edit tool to make this change — do not regenerate the file. Unknown frontmatter keys already present are preserved by the wiki; do not remove them.

6. **Sync** — after copying files in directly (outside `semaclaw wiki save`), reconcile indexes and git:
   ```bash
   semaclaw wiki sync
   ```


### When to use `mv` instead of `cp`

Only when the user explicitly says "move", "don't keep the original", or similar. Otherwise always default to `cp`.

### Before moving or renaming a wiki document

Other documents may link to it. Check first, and update those links to the new path:

```bash
semaclaw wiki backlinks "old/path.md"
```

## Associating Artifacts (HTML reports, images, PDFs)

Non-markdown artifacts (generated HTML reports, diagrams, PDFs) can live in the wiki directory next to their notes. They do not appear in tree/search/index, but are reachable from documents — the wiki UI opens them read-only in a new tab (HTML is sandboxed) and renders images inline.

1. Copy the artifact into the wiki, next to (or near) its note — use the root path printed by `semaclaw wiki tree`:
   ```bash
   cp "/path/to/report.html" "<wiki-root>/topic/report.html"
   ```
2. Reference it from the note:
   - As the primary associated resource: save with `--resource "./report.html"` (shown as a clickable link under the doc title), or
   - Inline in the body: `[分析报告](./report.html)`, `![架构图](./diagram.png)`
3. Run `semaclaw wiki sync` so the copied artifact gets committed to the wiki's git history.

## Directory Indexes (auto-maintained)

Every wiki directory contains an auto-generated `index.md` listing its subdirectories and documents (with their H1 titles). Rules:

- **Read** `index.md` to navigate a known area cheaply — one file per level instead of a full `wiki tree` scan.
- **Never write or edit** `index.md` — it is regenerated by the system on every save/mkdir; direct saves to it are rejected.
- `index.md` does not appear in tree/search results; it exists purely as a navigation index.

## Searching Existing Knowledge

```bash
# Matches filename / H1 title / tags / description / body text,
# ranked by where the hit is (filename or title > tags > description > body)
semaclaw wiki search "rust async"

# Filter by tags
semaclaw wiki search "" --tags "tokio"
```

## When to Trigger

**Write workflow** — user says:
- "add to wiki", "save to knowledge base", "archive this"
- "save this to wiki", "note it in the knowledge base"

**Organize workflow** — user says:
- "put this xxx file in wiki"
- "file these into the knowledge base"
- "sort these files into the wiki"

**Search workflow** — user says:
- "check my notes on X", "do I have anything in my wiki about X"
- "look up X in my knowledge base", "search my wiki for X"
- "what did I save about X", "have I documented X before"
- "find my notes on X", "pull up what I know about X"

## Filename Conventions
- Concise description of the topic (`async-runtime.md` not `notes-on-async-runtime-learning.md`)
- No more than 40 characters
