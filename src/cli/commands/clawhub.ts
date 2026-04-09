/**
 * semaclaw clawhub — ClaWHub 插件市场命令（Phase 1，无需登录）
 *
 * semaclaw clawhub search <query> [--limit N] [--sort newest|downloads|rating]
 * semaclaw clawhub install <slug> [--force] [--version <v>]
 * semaclaw clawhub update [<slug>] [--all] [--force]
 * semaclaw clawhub list
 * semaclaw clawhub uninstall <slug> [--yes]
 * semaclaw clawhub publish <path> [--dry-run] [--registry <url>]
 */

import * as fs from 'node:fs'
import * as fsp from 'node:fs/promises'
import * as path from 'node:path'
import * as readline from 'node:readline/promises'
import { stdin as input, stdout as output } from 'node:process'
import { config } from '../../config.js'
import {
  searchSkills,
  getSkillMeta,
  downloadSkillZip,
  whoami,
  publishSkill,
  DEFAULT_REGISTRY,
} from '../../clawhub/client.js'
import {
  readLockfile,
  writeLockfile,
  readSkillOrigin,
  writeSkillOrigin,
  extractZipToDir,
} from '../../clawhub/lockfile.js'
import { emitSkillsRefresh } from '../../clawhub/signal.js'
import {
  readStoredToken,
  writeStoredToken,
  clearStoredToken,
  getConfigPath,
} from '../../clawhub/auth.js'

// ============================================================
// 工具函数
// ============================================================

function getManagedDir(): string {
  return config.paths.managedSkillsDir
}

/** 读取当前生效的 registry（优先 CLAWHUB_REGISTRY 环境变量） */
function getRegistry(): string {
  return process.env['CLAWHUB_REGISTRY']?.trim() || DEFAULT_REGISTRY
}


async function resolveGroupSkillsDir(group: string): Promise<string> {
  if (!group.trim() || group.includes('/') || group.includes('\\') || group.includes('..')) {
    console.error(`Invalid group id: ${group}`)
    process.exit(1)
  }
  const groupDir = path.join(config.paths.workspaceDir, group)
  try {
    await fsp.access(groupDir)
  } catch {
    console.error(`Group not found: ${groupDir}`)
    console.error('Make sure the workspace folder exists before installing group skills.')
    process.exit(1)
  }
  return path.join(groupDir, 'skills')
}

function isValidSlug(slug: string): boolean {
  return Boolean(slug) && !slug.includes('/') && !slug.includes('\\') && !slug.includes('..')
}

function requireSlug(raw: string): string {
  const slug = raw.trim()
  if (!slug || !isValidSlug(slug)) {
    console.error(`Invalid slug: ${raw}`)
    process.exit(1)
  }
  return slug
}

async function promptConfirm(question: string): Promise<boolean> {
  if (!process.stdin.isTTY) return false
  const rl = readline.createInterface({ input, output })
  try {
    const answer = await rl.question(`${question} [y/N] `)
    return answer.trim().toLowerCase() === 'y'
  } finally {
    rl.close()
  }
}

function formatRelativeTime(ts: number): string {
  const diff = Date.now() - ts
  const days = Math.floor(diff / 86_400_000)
  if (days > 30) return `${Math.floor(days / 30)}mo ago`
  if (days > 0) return `${days}d ago`
  const hours = Math.floor(diff / 3_600_000)
  if (hours > 0) return `${hours}h ago`
  const mins = Math.floor(diff / 60_000)
  return mins > 0 ? `${mins}m ago` : 'just now'
}

// ============================================================
// search
// ============================================================

export async function cmdClawhubSearch(
  query: string,
  options: { limit?: number; sort?: string } = {},
): Promise<void> {
  if (!query.trim()) {
    console.error('Query required')
    process.exit(1)
  }

  process.stdout.write('Searching...\r')
  try {
    const results = await searchSkills(query, { limit: options.limit, registry: getRegistry() })
    process.stdout.write('           \r')

    if (results.length === 0) {
      console.log('No results.')
      return
    }

    for (const r of results) {
      const version = r.version ? ` v${r.version}` : ''
      const age = r.updatedAt ? `  ${formatRelativeTime(r.updatedAt)}` : ''
      const summary = r.summary ? `  ${r.summary.slice(0, 60)}` : ''
      console.log(`${r.slug}${version}${age}${summary}`)
    }
  } catch (err) {
    process.stdout.write('           \r')
    console.error(`Search failed: ${err instanceof Error ? err.message : err}`)
    process.exit(1)
  }
}

// ============================================================
// install
// ============================================================

export async function cmdClawhubInstall(
  slug: string,
  options: { force?: boolean; version?: string; group?: string } = {},
): Promise<void> {
  const trimmed = requireSlug(slug)
  const managedDir = options.group
    ? await resolveGroupSkillsDir(options.group)
    : getManagedDir()
  const target = path.join(managedDir, trimmed)

  if (!options.force && fs.existsSync(target)) {
    console.error(`Already installed: ${target}\nUse --force to reinstall.`)
    process.exit(1)
  }

  process.stdout.write(`Resolving ${trimmed}...\r`)
  try {
    // Fetch metadata + moderation check
    const meta = await getSkillMeta(trimmed, { registry: getRegistry() })

    if (meta.moderation?.isMalwareBlocked) {
      console.error(`Blocked: ${trimmed} is flagged as malicious and cannot be installed.`)
      process.exit(1)
    }

    if (meta.moderation?.isSuspicious && !options.force) {
      process.stdout.write('                              \r')
      console.log(`\n⚠️  Warning: "${trimmed}" is flagged as suspicious.`)
      console.log('   Review the skill code before use.\n')
      const ok = await promptConfirm('Install anyway?')
      if (!ok) {
        console.log('Installation cancelled.')
        return
      }
    }

    const resolvedVersion = options.version ?? meta.latestVersion?.version
    if (!resolvedVersion) {
      console.error(`Could not resolve version for ${trimmed}`)
      process.exit(1)
    }

    process.stdout.write(`Downloading ${trimmed}@${resolvedVersion}...\r`)
    const zipBuf = await downloadSkillZip(trimmed, resolvedVersion, { registry: getRegistry() })

    // Clean and extract
    if (options.force && fs.existsSync(target)) {
      await fsp.rm(target, { recursive: true, force: true })
    }
    await extractZipToDir(new Uint8Array(zipBuf), target)

    await writeSkillOrigin(target, {
      version: 1,
      registry: DEFAULT_REGISTRY,
      slug: trimmed,
      installedVersion: resolvedVersion,
      installedAt: Date.now(),
    })

    const lock = await readLockfile(managedDir)
    lock.skills[trimmed] = { version: resolvedVersion, installedAt: Date.now() }
    await writeLockfile(managedDir, lock)

    process.stdout.write('                                        \r')
    console.log(`✓ Installed ${trimmed}@${resolvedVersion} → ${target}`)
    await emitSkillsRefresh()
  } catch (err) {
    process.stdout.write('                                        \r')
    console.error(`Install failed: ${err instanceof Error ? err.message : err}`)
    process.exit(1)
  }
}

// ============================================================
// update
// ============================================================

export async function cmdClawhubUpdate(
  slugArg: string | undefined,
  options: { all?: boolean; force?: boolean; version?: string } = {},
): Promise<void> {
  if (!slugArg && !options.all) {
    console.error('Provide <slug> or --all')
    process.exit(1)
  }
  if (slugArg && options.all) {
    console.error('Use either <slug> or --all, not both')
    process.exit(1)
  }

  const managedDir = getManagedDir()
  const lock = await readLockfile(managedDir)
  const slugs = slugArg
    ? [requireSlug(slugArg)]
    : Object.keys(lock.skills).filter(isValidSlug)

  if (slugs.length === 0) {
    console.log('No installed skills.')
    return
  }

  for (const slug of slugs) {
    process.stdout.write(`Checking ${slug}...\r`)
    try {
      const meta = await getSkillMeta(slug, { registry: getRegistry() })

      if (meta.moderation?.isMalwareBlocked) {
        console.log(`${slug}: blocked as malicious, skipping`)
        continue
      }

      const latest = meta.latestVersion?.version ?? null
      if (!latest) {
        console.log(`${slug}: not found on registry`)
        continue
      }

      const targetVersion = options.version ?? latest
      const current = lock.skills[slug]?.version

      if (!options.force && current === targetVersion) {
        process.stdout.write('                    \r')
        console.log(`${slug}: up to date (${current})`)
        continue
      }

      const target = path.join(managedDir, slug)
      process.stdout.write(`Updating ${slug} → ${targetVersion}...\r`)
      const zipBuf = await downloadSkillZip(slug, targetVersion, { registry: getRegistry() })
      await fsp.rm(target, { recursive: true, force: true })
      await extractZipToDir(new Uint8Array(zipBuf), target)

      const existingOrigin = await readSkillOrigin(target)
      await writeSkillOrigin(target, {
        version: 1,
        registry: existingOrigin?.registry ?? DEFAULT_REGISTRY,
        slug: existingOrigin?.slug ?? slug,
        installedVersion: targetVersion,
        installedAt: existingOrigin?.installedAt ?? Date.now(),
      })

      lock.skills[slug] = { version: targetVersion, installedAt: Date.now() }
      process.stdout.write('                                        \r')
      console.log(`${slug}: updated → ${targetVersion}`)
    } catch (err) {
      process.stdout.write('                                        \r')
      console.log(`${slug}: failed — ${err instanceof Error ? err.message : err}`)
    }
  }

  await writeLockfile(managedDir, lock)
  await emitSkillsRefresh()
}

// ============================================================
// list
// ============================================================

export async function cmdClawhubList(): Promise<void> {
  const managedDir = getManagedDir()
  const lock = await readLockfile(managedDir)
  const entries = Object.entries(lock.skills)

  if (entries.length === 0) {
    console.log('No ClaWHub skills installed.')
    console.log(`Install dir: ${managedDir}`)
    return
  }

  console.log(`Installed in: ${managedDir}\n`)
  for (const [slug, entry] of (entries as [string, { version: string | null; installedAt: number }][]).sort(([a], [b]) => a.localeCompare(b))) {
    const version = entry.version ?? '(unknown)'
    const date = new Date(entry.installedAt).toISOString().slice(0, 10)
    console.log(`  ${slug}  v${version}  (installed ${date})`)
  }
}

// ============================================================
// uninstall
// ============================================================

export async function cmdClawhubUninstall(
  slug: string,
  options: { yes?: boolean } = {},
): Promise<void> {
  const trimmed = requireSlug(slug)
  const managedDir = getManagedDir()
  const lock = await readLockfile(managedDir)

  if (!lock.skills[trimmed]) {
    console.error(`Not installed: ${trimmed}`)
    process.exit(1)
  }

  if (!options.yes) {
    const ok = await promptConfirm(`Uninstall ${trimmed}?`)
    if (!ok) {
      console.log('Cancelled.')
      return
    }
  }

  const target = path.join(managedDir, trimmed)
  await fsp.rm(target, { recursive: true, force: true })
  delete lock.skills[trimmed]
  await writeLockfile(managedDir, lock)
  await emitSkillsRefresh()
  console.log(`✓ Uninstalled ${trimmed}`)
}

// ============================================================
// login / logout / whoami
// ============================================================

export async function cmdClawhubLogin(options: { token?: string } = {}): Promise<void> {
  let token = options.token?.trim()

  if (!token) {
    console.log('Get your API token at: https://clawhub.ai/settings/tokens')
    console.log()
    if (!process.stdin.isTTY) {
      console.error('Login failed: no --token provided and stdin is not a TTY.')
      process.exit(1)
    }
    const rl = readline.createInterface({ input, output })
    try {
      // Read up to 3 lines to handle tokens with a leading/trailing newline from copy-paste
      let raw = ''
      for (let i = 0; i < 3; i++) {
        raw = (await rl.question(i === 0 ? 'Paste your ClaWHub token: ' : '')).trim()
        if (raw) break
      }
      token = raw
    } finally {
      rl.close()
    }
  }

  if (!token) {
    console.error('Login failed: no token entered.')
    console.error('Tip: use --token flag to avoid interactive prompt:')
    console.error('  semaclaw clawhub login --token clh_...')
    process.exit(1)
  }

  if (!token.startsWith('clh_')) {
    console.error(`Login failed: invalid token format "${token.slice(0, 12)}..." (expected clh_...).`)
    process.exit(1)
  }

  // Save first so subsequent requests can use it immediately
  await writeStoredToken(token)

  // Verify against API (soft: warn on failure, don't roll back)
  process.stdout.write('Verifying token...\r')
  try {
    const user = await whoami({ token })
    process.stdout.write('                  \r')
    const name = user.displayName ?? user.handle ?? '(unknown)'
    console.log(`Login successful. Logged in as ${name}`)
    console.log(`Token saved to: ${getConfigPath()}`)
  } catch (err) {
    process.stdout.write('                  \r')
    const msg = err instanceof Error ? err.message : String(err)
    console.log(`Token saved to: ${getConfigPath()}`)
    console.log(`Note: online verification skipped (${msg})`)
    console.log(`Run "semaclaw clawhub whoami" to verify when rate limit clears.`)
  }
}

export async function cmdClawhubLogout(): Promise<void> {
  const existing = await readStoredToken()
  if (!existing) {
    console.log('Not logged in.')
    return
  }
  await clearStoredToken()
  console.log('Logged out. Token removed.')
}

export async function cmdClawhubWhoami(): Promise<void> {
  const token = await readStoredToken()
  if (!token) {
    console.log('Not logged in. Run: semaclaw clawhub login')
    process.exit(1)
  }

  try {
    const user = await whoami()
    console.log(`Handle:      ${user.handle ?? '(not set)'}`)
    console.log(`DisplayName: ${user.displayName ?? '(not set)'}`)
    console.log(`Registry:    ${DEFAULT_REGISTRY}`)
    console.log(`Config:      ${getConfigPath()}`)
  } catch (err) {
    console.error(`Whoami failed: ${err instanceof Error ? err.message : err}`)
    process.exit(1)
  }
}

// ============================================================
// publish
// ============================================================

export async function cmdClawhubPublish(
  skillPath: string,
  options: { registry?: string; dryRun?: boolean; tags?: string } = {},
): Promise<void> {
  const resolvedPath = path.resolve(skillPath)

  // Check directory exists
  try {
    await fsp.access(resolvedPath)
  } catch {
    console.error(`Error: path not found: ${resolvedPath}`)
    process.exit(1)
  }

  // Read SKILL.md
  const skillMdPath = path.join(resolvedPath, 'SKILL.md')
  let skillMdContent: string
  try {
    skillMdContent = await fsp.readFile(skillMdPath, 'utf8')
  } catch {
    console.error(`Error: SKILL.md not found in ${resolvedPath}`)
    process.exit(1)
  }

  // Parse frontmatter
  const data = parseSimpleFrontmatter(skillMdContent)

  const displayName = data.name ? String(data.name).trim() : ''
  if (!displayName) {
    console.error('Error: SKILL.md is missing the "name" field')
    process.exit(1)
  }

  const version = data.version ? String(data.version).trim() : ''
  if (!version) {
    console.error('Error: SKILL.md is missing the "version" field (required for publish)')
    process.exit(1)
  }

  // slug: explicit frontmatter field, or derived from directory name
  const dirSlug = path.basename(resolvedPath)
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
  const slug: string = data.slug ? String(data.slug).trim() : dirSlug

  const changelog = data.changelog ? String(data.changelog).trim() : ''
  const tags = (options.tags ?? 'latest').split(',').map(t => t.trim()).filter(Boolean)

  console.log(`Skill:       ${displayName}`)
  console.log(`Slug:        ${slug}`)
  console.log(`Version:     ${version}`)
  console.log(`Tags:        ${tags.join(', ')}`)
  if (changelog) console.log(`Changelog:   ${changelog}`)
  console.log()

  // Collect files
  const files = await collectSkillFiles(resolvedPath)
  console.log(`Files:       ${files.length} (${files.map(f => f.name).join(', ')})`)

  if (options.dryRun) {
    console.log('[dry-run] Skipping upload.')
    return
  }

  // Upload
  process.stdout.write('Uploading to ClaWHub...\r')
  try {
    const result = await publishSkill({
      slug,
      displayName,
      version,
      changelog,
      tags,
      files,
      registry: options.registry,
    })
    process.stdout.write('                       \r')
    console.log(`Published:   ${result.slug}@${result.version}`)
    console.log(`View at:     https://clawhub.ai/skills/${result.slug}`)
  } catch (err) {
    process.stdout.write('                       \r')
    console.error(`Publish failed: ${err instanceof Error ? err.message : err}`)
    process.exit(1)
  }
}

async function collectSkillFiles(
  skillDir: string,
): Promise<Array<{ name: string; data: Uint8Array }>> {
  const results: Array<{ name: string; data: Uint8Array }> = []
  await _walkDir(skillDir, skillDir, results)
  return results
}

async function _walkDir(
  baseDir: string,
  currentDir: string,
  out: Array<{ name: string; data: Uint8Array }>,
): Promise<void> {
  const entries = await fsp.readdir(currentDir, { withFileTypes: true })
  for (const entry of entries) {
    if (entry.name === '.clawhub') continue
    const fullPath = path.join(currentDir, entry.name)
    const relPath = path.relative(baseDir, fullPath).replace(/\\/g, '/')
    if (entry.isDirectory()) {
      await _walkDir(baseDir, fullPath, out)
    } else if (entry.isFile()) {
      const data = await fsp.readFile(fullPath)
      out.push({ name: relPath, data: new Uint8Array(data) })
    }
  }
}

// ============================================================
// 工具函数
// ============================================================

/**
 * 解析 SKILL.md 的 YAML frontmatter（--- ... --- 块），返回 key→value 字典。
 * 支持：
 *   key: single line value
 *   key: |
 *     indented
 *     block
 */
function parseSimpleFrontmatter(content: string): Record<string, string> {
  const match = /^---\r?\n([\s\S]*?)\r?\n---/.exec(content)
  if (!match) return {}

  const result: Record<string, string> = {}
  const lines = match[1].split(/\r?\n/)
  let currentKey: string | null = null
  let blockLines: string[] = []
  let inBlock = false

  const flushBlock = () => {
    if (currentKey && inBlock) {
      result[currentKey] = blockLines.join('\n').trimEnd()
    }
    currentKey = null
    blockLines = []
    inBlock = false
  }

  for (const line of lines) {
    if (inBlock) {
      // Block scalar: indented line belongs to current key
      if (/^\s/.test(line)) {
        blockLines.push(line.trim())
        continue
      }
      // Non-indented = end of block
      flushBlock()
    }

    const kvMatch = /^([a-zA-Z][a-zA-Z0-9_-]*):\s*(.*)$/.exec(line)
    if (!kvMatch) continue

    const key = kvMatch[1]
    const val = kvMatch[2].trim()

    if (val === '|' || val === '>') {
      currentKey = key
      blockLines = []
      inBlock = true
    } else {
      result[key] = val
    }
  }

  flushBlock()
  return result
}
