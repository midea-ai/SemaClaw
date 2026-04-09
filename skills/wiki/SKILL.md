---
name: wiki
description: Save learning/research documents to the personal wiki knowledge base and search existing content
version: 1.0.0
---

# Wiki Knowledge Base Management

The user's personal knowledge base is maintained with the `semaclaw wiki` command.
The wiki directory is located at `{home}/semaclaw/wiki/`, where `{home}` is the user's home directory (`~` on macOS/Linux, `%USERPROFILE%` on Windows).
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

3. **Save the document** (pipe full Markdown content via heredoc to stdin):
   ```bash
   cat <<'WIKI_EOF' | semaclaw wiki save --path "directory/filename.md" --tags "tag1,tag2"
   # Document Title

   Document content...
   WIKI_EOF
   ```

### Example

```bash
# Save an article about Rust async
cat <<'WIKI_EOF' | semaclaw wiki save --path "programming/rust/async-runtime.md" --tags "rust,async,tokio"
# Rust Async Runtime Explained

## Core Concepts

Tokio is the most popular async runtime for Rust...
WIKI_EOF
```

Output JSON: `{"path": "programming/rust/async-runtime.md", "action": "created"}`

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

4. **Copy the file** to the wiki (do not rewrite content):
   ```bash
   cp "/source/path/document.md" "{home}/semaclaw/wiki/category/filename.md"
   # or on Windows: copy "source" "dest"
   ```

5. **Edit the YAML frontmatter** of the copied file to add/update tags and metadata. If no frontmatter exists, prepend it:
   ```markdown
   ---
   tags: [tag1, tag2]
   source: /original/path/document.md
   ---
   ```
   Use the Edit tool to make this change — do not regenerate the file.


### When to use `mv` instead of `cp`

Only when the user explicitly says "move", "don't keep the original", or similar. Otherwise always default to `cp`.

## Searching Existing Knowledge

```bash
# Search by title/filename
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
