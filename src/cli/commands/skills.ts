/**
 * semaclaw skills — 本地 skill 管理命令
 *
 * semaclaw skills list [--eligible] [--verbose] [--json]
 * semaclaw skills info <name>
 * semaclaw skills check
 * semaclaw skills disable <name>
 * semaclaw skills enable <name>
 */

import * as signalModule from '../../clawhub/signal.js'
import {
  readDisabledSkills,
  disableSkill,
  enableSkill,
  isSkillDisabled,
  DISABLED_SKILLS_FILE,
} from '../../skills/disabled.js'
import * as fs from 'node:fs'
import { loadAllLocalSkills, getSourceDefs, scanSource } from '../../skills/scan.js'

// Indirection so tests can replace emitSkillsRefresh without fighting ESM namespace getters
let _emitSkillsRefresh: () => Promise<void> = () => signalModule.emitSkillsRefresh()

/** Override the skills refresh emitter (for testing only) */
export function _setEmitSkillsRefresh(fn: () => Promise<void>): void {
  _emitSkillsRefresh = fn
}

// ============================================================
// 命令实现
// ============================================================

export function cmdSkillsList(options: {
  eligible?: boolean
  verbose?: boolean
  json?: boolean
}): void {
  const skills = loadAllLocalSkills()
  const disabled = readDisabledSkills()

  if (options.json) {
    console.log(JSON.stringify(skills.map(s => ({ ...s, disabled: disabled.has(s.name) })), null, 2))
    return
  }

  if (skills.length === 0) {
    console.log('No skills found.')
    return
  }

  for (let i = 0; i < skills.length; i++) {
    const s = skills[i]
    const version = s.version ? ` v${s.version}` : ''
    const disabledTag = disabled.has(s.name) ? '  [disabled]' : ''
    if (options.verbose) {
      console.log(`- ${s.name}${version}${disabledTag}`)
      console.log(`  source:  ${s.source}`)
      console.log(`  dir:     ${s.dir}`)
      console.log(`  desc:    ${s.description}`)
    } else {
      console.log(`- ${s.name}${version}  [${s.source}]${disabledTag}`)
      if (s.description) console.log(`  ${s.description}`)
    }
    if (i < skills.length - 1) console.log()
  }
}

export function cmdSkillsInfo(name: string): void {
  const skills = loadAllLocalSkills()
  const skill = skills.find(s => s.name === name)

  if (!skill) {
    console.error(`Skill not found: ${name}`)
    process.exit(1)
  }

  const disabled = readDisabledSkills()
  console.log(`Name:        ${skill.name}`)
  console.log(`Version:     ${skill.version ?? '(not set)'}`)
  console.log(`Source:      ${skill.source}`)
  console.log(`Status:      ${disabled.has(skill.name) ? 'disabled' : 'enabled'}`)
  console.log(`Directory:   ${skill.dir}`)
  console.log(`File:        ${skill.filePath}`)
  console.log(`Description: ${skill.description}`)
}

export async function cmdSkillsRefresh(): Promise<void> {
  await _emitSkillsRefresh()
  console.log('✓ Skills refresh signal sent to daemon.')
  console.log('  Running agents will reload their skill registry on next message.')
}

export function cmdSkillsCheck(): void {
  const sources = getSourceDefs()
  const disabled = readDisabledSkills()
  let totalDirs = 0
  let totalSkills = 0

  for (const def of sources) {
    const exists = fs.existsSync(def.dir)
    const skills = exists ? scanSource(def) : []
    totalDirs++
    totalSkills += skills.length
    const status = exists ? `${skills.length} skills` : 'not found'
    console.log(`  [${def.source}] ${def.dir}  →  ${status}`)
  }

  console.log()
  console.log(`Total: ${totalSkills} skill(s) across ${totalDirs} sources`)

  if (disabled.size > 0) {
    console.log()
    console.log(`Disabled (${disabled.size}): ${[...disabled].sort().join(', ')}`)
    console.log(`Config: ${DISABLED_SKILLS_FILE}`)
  }

  // Warn about duplicate names
  const allBySource = sources.flatMap(def => scanSource(def))
  const nameCount = new Map<string, number>()
  for (const s of allBySource) {
    nameCount.set(s.name, (nameCount.get(s.name) ?? 0) + 1)
  }
  const dupes = [...nameCount.entries()].filter(([, c]) => c > 1)
  if (dupes.length > 0) {
    console.log()
    console.log('Duplicate skill names (higher-priority source wins):')
    for (const [name, count] of dupes) {
      console.log(`  ${name}  (${count} sources)`)
    }
  }
}

export async function cmdSkillsDisable(name: string): Promise<void> {
  const skills = loadAllLocalSkills()
  const skill = skills.find(s => s.name === name)
  if (!skill) {
    console.error(`Skill not found: ${name}`)
    console.error(`Run "semaclaw skills list" to see available skills.`)
    process.exit(1)
  }
  if (isSkillDisabled(name)) {
    console.log(`Already disabled: ${name}`)
    return
  }
  disableSkill(name)
  console.log(`Disabled: ${name}  [${skill.source}]`)
  console.log(`Run "semaclaw skills enable ${name}" to re-enable.`)
  await _emitSkillsRefresh()
}

export async function cmdSkillsEnable(name: string): Promise<void> {
  if (!isSkillDisabled(name)) {
    // 可能 skill 不存在，也可能本来就是 enabled
    const skills = loadAllLocalSkills()
    const skill = skills.find(s => s.name === name)
    if (!skill) {
      console.error(`Skill not found: ${name}`)
      console.error(`Run "semaclaw skills list" to see available skills.`)
      process.exit(1)
    }
    console.log(`Already enabled: ${name}`)
    return
  }
  enableSkill(name)
  const skills = loadAllLocalSkills()
  const skill = skills.find(s => s.name === name)
  console.log(`Enabled: ${name}${skill ? `  [${skill.source}]` : ''}`)
  await _emitSkillsRefresh()
}
