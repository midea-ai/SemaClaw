/**
 * ClaWHub 本地 token 管理
 *
 * token 存储路径（与 clawhub web 约定兼容）：
 *   macOS:  ~/Library/Application Support/clawhub/config.json
 *   Linux:  ~/.config/clawhub/config.json
 */

import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import * as os from 'node:os'

interface ClawhubLocalConfig {
  token?: string
}

export function getConfigPath(): string {
  if (process.platform === 'darwin') {
    return path.join(os.homedir(), 'Library', 'Application Support', 'clawhub', 'config.json')
  }
  return path.join(os.homedir(), '.config', 'clawhub', 'config.json')
}

export async function readStoredToken(): Promise<string | null> {
  try {
    const content = await fs.readFile(getConfigPath(), 'utf8')
    const cfg = JSON.parse(content) as ClawhubLocalConfig
    return cfg.token?.trim() || null
  } catch {
    return null
  }
}

export async function writeStoredToken(token: string): Promise<void> {
  const configPath = getConfigPath()
  await fs.mkdir(path.dirname(configPath), { recursive: true })
  let existing: ClawhubLocalConfig = {}
  try {
    existing = JSON.parse(await fs.readFile(configPath, 'utf8')) as ClawhubLocalConfig
  } catch { /* ok */ }
  existing.token = token
  await fs.writeFile(configPath, JSON.stringify(existing, null, 2) + '\n', 'utf8')
}

export async function clearStoredToken(): Promise<void> {
  const configPath = getConfigPath()
  try {
    const existing = JSON.parse(await fs.readFile(configPath, 'utf8')) as ClawhubLocalConfig
    delete existing.token
    await fs.writeFile(configPath, JSON.stringify(existing, null, 2) + '\n', 'utf8')
  } catch { /* ok if file not found */ }
}
