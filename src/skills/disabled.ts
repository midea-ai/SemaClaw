/**
 * Skill enable/disable 持久化存储
 *
 * 存储路径：~/.semaclaw/disabled-skills.json
 * 格式：{ "disabled": ["docx", "pdf", ...] }
 *
 * 设计原则：
 * - 按 skill name（SKILL.md frontmatter 的 name 字段）屏蔽
 * - 适用于所有来源（bundled / clawhub-managed / global）
 * - 文件不存在 = 没有任何 skill 被禁用（默认全开）
 */

import * as fs from 'node:fs'
import * as path from 'node:path'
import * as os from 'node:os'

// Mutable so tests can override the path without affecting production use
let DISABLED_SKILLS_FILE = path.join(os.homedir(), '.semaclaw', 'disabled-skills.json')

// In-memory cache — null means "not yet loaded"
let _cache: Set<string> | null = null

interface DisabledSkillsStore {
  disabled: string[]
}

function readStore(): Set<string> {
  if (_cache !== null) return _cache
  try {
    const raw = fs.readFileSync(DISABLED_SKILLS_FILE, 'utf8')
    const parsed = JSON.parse(raw)
    if (Array.isArray(parsed.disabled)) {
      _cache = new Set(parsed.disabled as string[])
      return _cache
    }
  } catch { /* file missing or malformed → treat as empty */ }
  _cache = new Set()
  return _cache
}

function writeStore(store: DisabledSkillsStore): void {
  const dir = path.dirname(DISABLED_SKILLS_FILE)
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(DISABLED_SKILLS_FILE, JSON.stringify(store, null, 2) + '\n', 'utf8')
}

/** 返回所有被禁用的 skill name 集合（缓存读取） */
export function readDisabledSkills(): Set<string> {
  return readStore()
}

/** 禁用一个 skill（幂等） */
export function disableSkill(name: string): void {
  const current = readStore()
  if (!current.has(name)) {
    const list = [...current, name].sort()
    writeStore({ disabled: list })
    _cache = new Set(list)
  }
}

/** 启用一个 skill（幂等） */
export function enableSkill(name: string): void {
  const current = readStore()
  if (current.has(name)) {
    const list = [...current].filter(n => n !== name)
    writeStore({ disabled: list })
    _cache = new Set(list)
  }
}

/** 判断某个 skill 是否被禁用（缓存读取） */
export function isSkillDisabled(name: string): boolean {
  return readStore().has(name)
}

/** 使缓存失效，下次读取时重新从磁盘加载（供外部文件变更时调用） */
export function invalidateDisabledSkillsCache(): void {
  _cache = null
}

/** Override the storage file path (for testing only) */
export function setDisabledSkillsFile(p: string): void {
  DISABLED_SKILLS_FILE = p
  _cache = null
}

export { DISABLED_SKILLS_FILE }
