/**
 * Skill 目录扫描工具
 *
 * 提供跨 CLI / UIServer / 测试 复用的本地 skill 扫描逻辑。
 * 不依赖任何 CLI 特定模块。
 */

import * as fs from 'node:fs'
import * as path from 'node:path'
import * as os from 'node:os'
import { config } from '../config.js'

export interface SkillEntry {
  name: string
  description: string
  version?: string
  source: string      // 来源标签：bundled / global-compat / global-sema / clawhub-managed
  dir: string         // skill 文件夹绝对路径
  filePath: string    // SKILL.md 路径
}

type SourceDef = { dir: string; source: string }

export function getSourceDefs(): SourceDef[] {
  return [
    ...(config.paths.bundledSkillsDir
      ? [{ dir: config.paths.bundledSkillsDir, source: 'bundled' }]
      : []),
    { dir: path.join(os.homedir(), '.claude', 'skills'), source: 'global-compat' },
    { dir: path.join(os.homedir(), '.sema', 'skills'), source: 'global-sema' },
    { dir: config.paths.managedSkillsDir, source: 'clawhub-managed' },
  ]
}

function findSkillMd(dir: string): string | null {
  for (const name of ['SKILL.md', 'skill.md', 'Skill.md']) {
    const p = path.join(dir, name)
    if (fs.existsSync(p)) return p
  }
  return null
}

function parseFrontmatter(content: string): Record<string, string> {
  const result: Record<string, string> = {}
  if (!content.startsWith('---')) return result
  const end = content.indexOf('\n---', 3)
  if (end === -1) return result
  const fm = content.slice(4, end)
  for (const line of fm.split('\n')) {
    const col = line.indexOf(':')
    if (col === -1) continue
    const key = line.slice(0, col).trim()
    const val = line.slice(col + 1).trim().replace(/^['"]|['"]$/g, '')
    if (key) result[key] = val
  }
  return result
}

export function scanSource(def: SourceDef): SkillEntry[] {
  if (!fs.existsSync(def.dir)) return []
  const entries: SkillEntry[] = []
  try {
    const items = fs.readdirSync(def.dir)
    for (const item of items) {
      if (item.startsWith('.')) continue
      const fullPath = path.join(def.dir, item)
      if (!fs.statSync(fullPath).isDirectory()) continue
      const skillMd = findSkillMd(fullPath)
      if (!skillMd) continue
      try {
        const content = fs.readFileSync(skillMd, 'utf8')
        const fm = parseFrontmatter(content)
        if (!fm.name && !fm.description) continue
        entries.push({
          name: fm.name || item,
          description: fm.description || '',
          version: fm.version,
          source: def.source,
          dir: fullPath,
          filePath: skillMd,
        })
      } catch { continue }
    }
  } catch { /* dir not readable */ }
  return entries
}

/**
 * 扫描所有来源，返回已去重（高优先级覆盖低优先级）的 skill 列表
 */
export function loadAllLocalSkills(): SkillEntry[] {
  const sources = getSourceDefs()
  const map = new Map<string, SkillEntry>()
  for (const def of sources) {
    for (const entry of scanSource(def)) {
      map.set(entry.name, entry) // 后加载的（高优先级）覆盖先加载的
    }
  }
  return [...map.values()].sort((a, b) => a.name.localeCompare(b.name))
}
