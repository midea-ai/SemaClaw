/**
 * DailyLogger — 每日记忆日志
 *
 * 职责：
 *   - 记录用户 query 和 agent response 到 memory/YYYY-MM-DD.md
 *   - FIFO 清理，保留最近 50 天
 *
 * 存储路径：agents/{folder}/memory/YYYY-MM-DD.md
 *
 * 格式：
 *   # YYYY-MM-DD
 *
 *   ## HH:MM [User]
 *   <用户输入>
 *
 *   ## HH:MM [Assistant]
 *   <Agent 回复>
 */

import * as fs from 'fs';
import * as path from 'path';
import { config } from '../config';
import { localDateString, localTimeString } from '../util/localTime';

const MAX_DAYS = 50;
const DATE_FILE_RE = /^(\d{4}-\d{2}-\d{2})\.md$/;

export class DailyLogger {
  /**
   * 追加一条记录到今天的日志文件。
   * @param role "User" | "Assistant"
   */
  append(folder: string, role: 'User' | 'Assistant', content: string): void {
    if (!content.trim()) return;

    const memDir = this.memoryDir(folder);
    try {
      fs.mkdirSync(memDir, { recursive: true });

      const now = new Date();
      const today = localDateString(now);
      const time  = localTimeString(now);
      const logFile = path.join(memDir, `${today}.md`);

      let entry = '';
      if (!fs.existsSync(logFile)) {
        entry += `# ${today}\n`;
      }
      entry += `\n## ${time} [${role}]\n\n${content.trim()}\n`;

      fs.appendFileSync(logFile, entry, 'utf8');
      this.cleanup(folder);
    } catch (e) {
      console.warn(`[DailyLogger] Failed to append ${role} entry for ${folder}:`, e);
    }
  }

  /** 扫描 memory/ 目录，删除超出 MAX_DAYS 的旧日志文件 */
  cleanup(folder: string): void {
    const memDir = this.memoryDir(folder);
    try {
      const files = fs.readdirSync(memDir)
        .filter(f => DATE_FILE_RE.test(f))
        .sort();
      if (files.length > MAX_DAYS) {
        const toDelete = files.slice(0, files.length - MAX_DAYS);
        for (const f of toDelete) {
          fs.unlinkSync(path.join(memDir, f));
        }
      }
    } catch {
      // ignore
    }
  }

  private memoryDir(folder: string): string {
    return path.join(config.paths.agentsDir, folder, 'memory');
  }
}
