/**
 * Skills 热更新信号
 *
 * CLI 在 install/update/uninstall 后（或用户手动执行 `semaclaw skills refresh`）
 * 写入信号文件，daemon 侧的 AgentPool 通过 fs.watchFile 监听并触发 reloadAllSkills()。
 *
 * 信号文件：~/.semaclaw/managed/skills/.clawhub/reload-signal
 */

import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import { config } from '../config.js'

export function getSkillsReloadSignalPath(): string {
  return path.join(config.paths.managedSkillsDir, '.clawhub', 'reload-signal')
}

/**
 * 写入信号文件，通知 daemon 重新加载所有 agent 的 skill 注册表。
 * CLI 进程调用，daemon 进程通过 watchFile 响应。
 */
export async function emitSkillsRefresh(): Promise<void> {
  const signalPath = getSkillsReloadSignalPath()
  await fs.mkdir(path.dirname(signalPath), { recursive: true })
  await fs.writeFile(signalPath, JSON.stringify({ ts: Date.now() }), 'utf8')
}
