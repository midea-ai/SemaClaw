/**
 * Subagent (virtual persona) enable/disable 持久化存储
 *
 * 存储路径：~/.semaclaw/disabled-subagents.json
 * 格式：{ "disabled": ["persona-name", ...] }
 *
 * 设计原则：
 * - 按 persona name（frontmatter 的 name 字段）屏蔽
 * - 文件不存在 = 没有任何 persona 被禁用（默认全开）
 */

import * as fs from 'node:fs'
import * as path from 'node:path'
import * as os from 'node:os'

let DISABLED_SUBAGENTS_FILE = path.join(os.homedir(), '.semaclaw', 'disabled-subagents.json')

let _cache: Set<string> | null = null

interface DisabledSubagentsStore {
  disabled: string[]
}

function readStore(): Set<string> {
  if (_cache !== null) return _cache
  try {
    const raw = fs.readFileSync(DISABLED_SUBAGENTS_FILE, 'utf8')
    const parsed = JSON.parse(raw)
    if (Array.isArray(parsed.disabled)) {
      _cache = new Set(parsed.disabled as string[])
      return _cache
    }
  } catch { /* file missing or malformed → treat as empty */ }
  _cache = new Set()
  return _cache
}

function writeStore(store: DisabledSubagentsStore): void {
  const dir = path.dirname(DISABLED_SUBAGENTS_FILE)
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(DISABLED_SUBAGENTS_FILE, JSON.stringify(store, null, 2) + '\n', 'utf8')
}

/** 返回所有被禁用的 persona name 集合（缓存读取） */
export function readDisabledSubagents(): Set<string> {
  return readStore()
}

/** 禁用一个 persona（幂等） */
export function disableSubagent(name: string): void {
  const current = readStore()
  if (!current.has(name)) {
    const list = [...current, name].sort()
    writeStore({ disabled: list })
    _cache = new Set(list)
  }
}

/** 启用一个 persona（幂等） */
export function enableSubagent(name: string): void {
  const current = readStore()
  if (current.has(name)) {
    const list = [...current].filter(n => n !== name)
    writeStore({ disabled: list })
    _cache = new Set(list)
  }
}

/** 判断某个 persona 是否被禁用（缓存读取） */
export function isSubagentDisabled(name: string): boolean {
  return readStore().has(name)
}

/** 使缓存失效，下次读取时重新从磁盘加载 */
export function invalidateDisabledSubagentsCache(): void {
  _cache = null
}
