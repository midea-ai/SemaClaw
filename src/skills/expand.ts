/**
 * expandSkillsDir — 将一个 skills 父目录展开为各个启用的 skill 子目录列表。
 *
 * 被禁用的 skill（按 SKILL.md frontmatter name 字段匹配）会被过滤掉。
 * 如果没有任何 skill 被禁用，直接返回原始 dir 条目（避免不必要的文件 IO）。
 */

import * as fs from 'node:fs'
import * as path from 'node:path'

export type SkillLocate = 'managed' | 'user' | 'workspace' | 'project'

export function expandSkillsDir(
  dir: string,
  locate: SkillLocate,
  disabled: Set<string>,
): Array<{ dir: string; locate: SkillLocate }> {
  if (disabled.size === 0 || !fs.existsSync(dir)) {
    return [{ dir, locate }]
  }
  try {
    const entries = fs.readdirSync(dir)
    const result: Array<{ dir: string; locate: SkillLocate }> = []
    for (const entry of entries) {
      if (entry.startsWith('.')) continue
      const fullPath = path.join(dir, entry)
      if (!fs.statSync(fullPath).isDirectory()) continue
      // 查找 SKILL.md 并读取 name 字段
      let skillName: string | undefined
      for (const fname of ['SKILL.md', 'skill.md', 'Skill.md']) {
        const mdPath = path.join(fullPath, fname)
        if (fs.existsSync(mdPath)) {
          try {
            const content = fs.readFileSync(mdPath, 'utf8')
            if (content.startsWith('---')) {
              const end = content.indexOf('\n---', 3)
              if (end !== -1) {
                for (const line of content.slice(4, end).split('\n')) {
                  const col = line.indexOf(':')
                  if (col !== -1 && line.slice(0, col).trim() === 'name') {
                    skillName = line.slice(col + 1).trim().replace(/^['"]|['"]$/g, '')
                    break
                  }
                }
              }
            }
          } catch { /* skip */ }
          break
        }
      }
      const name = skillName ?? entry
      if (!disabled.has(name)) {
        result.push({ dir: fullPath, locate })
      }
    }
    return result
  } catch {
    return [{ dir, locate }]
  }
}
