/**
 * ClaWHub 本地安装状态管理
 *
 * lockfile:   ~/.semaclaw/managed/skills/.clawhub/lock.json
 * origin:     ~/.semaclaw/managed/skills/<slug>/.clawhub/origin.json
 */

import * as fs from 'node:fs/promises'
import * as path from 'node:path'

// ============================================================
// 类型
// ============================================================

export interface LockfileEntry {
  version: string | null
  installedAt: number
}

export interface Lockfile {
  version: 1
  skills: Record<string, LockfileEntry>
}

export interface SkillOrigin {
  version: 1
  registry: string
  slug: string
  installedVersion: string
  installedAt: number
}

// ============================================================
// Lockfile
// ============================================================

const DOT_DIR = '.clawhub'

function lockfilePath(managedSkillsDir: string): string {
  return path.join(managedSkillsDir, DOT_DIR, 'lock.json')
}

export async function readLockfile(managedSkillsDir: string): Promise<Lockfile> {
  try {
    const raw = await fs.readFile(lockfilePath(managedSkillsDir), 'utf8')
    const parsed = JSON.parse(raw) as Partial<Lockfile>
    if (parsed.version !== 1 || !parsed.skills || typeof parsed.skills !== 'object') {
      return { version: 1, skills: {} }
    }
    return parsed as Lockfile
  } catch {
    return { version: 1, skills: {} }
  }
}

export async function writeLockfile(managedSkillsDir: string, lock: Lockfile): Promise<void> {
  const p = lockfilePath(managedSkillsDir)
  await fs.mkdir(path.dirname(p), { recursive: true })
  await fs.writeFile(p, `${JSON.stringify(lock, null, 2)}\n`, 'utf8')
}

// ============================================================
// Skill Origin
// ============================================================

function originPath(skillFolder: string): string {
  return path.join(skillFolder, DOT_DIR, 'origin.json')
}

export async function readSkillOrigin(skillFolder: string): Promise<SkillOrigin | null> {
  try {
    const raw = await fs.readFile(originPath(skillFolder), 'utf8')
    const parsed = JSON.parse(raw) as Partial<SkillOrigin>
    if (
      parsed.version !== 1 ||
      !parsed.registry || !parsed.slug || !parsed.installedVersion ||
      typeof parsed.installedAt !== 'number'
    ) return null
    return parsed as SkillOrigin
  } catch {
    return null
  }
}

export async function writeSkillOrigin(skillFolder: string, origin: SkillOrigin): Promise<void> {
  const p = originPath(skillFolder)
  await fs.mkdir(path.dirname(p), { recursive: true })
  await fs.writeFile(p, `${JSON.stringify(origin, null, 2)}\n`, 'utf8')
}

// ============================================================
// Zip 解压（依赖 fflate）
// ============================================================

export async function extractZipToDir(zipBytes: Uint8Array, targetDir: string): Promise<void> {
  // 动态 import fflate，避免在没有此依赖时崩溃
  const { unzipSync } = await import('fflate')
  const entries = unzipSync(zipBytes)
  await fs.mkdir(targetDir, { recursive: true })
  for (const [rawPath, data] of Object.entries(entries)) {
    const safePath = sanitizeRelPath(rawPath)
    if (!safePath) continue
    const outPath = path.join(targetDir, safePath)
    await fs.mkdir(path.dirname(outPath), { recursive: true })
    await fs.writeFile(outPath, data as Uint8Array)
  }
}

function sanitizeRelPath(p: string): string | null {
  const normalized = p.replace(/^\.\/+/, '').replace(/^\/+/, '')
  if (!normalized || normalized.endsWith('/')) return null
  if (normalized.includes('..') || normalized.includes('\\')) return null
  return normalized
}

// ============================================================
// Zip 打包（publish 用）
// ============================================================

/** 将 skillDir 目录内容打包为 zip，排除 .clawhub/ 元数据子目录 */
export async function zipSkillDir(skillDir: string): Promise<Uint8Array> {
  const { zipSync } = await import('fflate')
  const files: Record<string, Uint8Array> = {}
  await collectDirFiles(skillDir, skillDir, files)
  return zipSync(files)
}

async function collectDirFiles(
  baseDir: string,
  currentDir: string,
  files: Record<string, Uint8Array>,
): Promise<void> {
  const entries = await fs.readdir(currentDir, { withFileTypes: true })
  for (const entry of entries) {
    if (entry.name === '.clawhub') continue
    const fullPath = path.join(currentDir, entry.name)
    const relPath = path.relative(baseDir, fullPath).replace(/\\/g, '/')
    if (entry.isDirectory()) {
      await collectDirFiles(baseDir, fullPath, files)
    } else if (entry.isFile()) {
      const data = await fs.readFile(fullPath)
      files[relPath] = new Uint8Array(data)
    }
  }
}
