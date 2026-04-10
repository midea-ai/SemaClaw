/**
 * PersonaRegistry — 虚拟 agent 人设注册表
 *
 * 扫描 ~/.semaclaw/agents/virtual-agents/*.md，解析 frontmatter + 正文，
 * 提供 get(name) / list() 查询。支持 fs.watch 热重载。
 */

import * as fs from 'fs';
import * as path from 'path';

export interface PersonaConfig {
  name: string;
  description: string;
  tools: string[] | null;       // null = 使用默认工具集
  model: string | null;         // 预留字段，暂不生效
  maxConcurrent: number;        // 默认 5
  systemPrompt: string;         // frontmatter 之后的正文
  filePath: string;
}

/** systemPrompt 最大字符数，超出截断 */
const MAX_SYSTEM_PROMPT_LENGTH = 8000;

export class PersonaRegistry {
  private personas = new Map<string, PersonaConfig>();
  private watcher: fs.FSWatcher | null = null;
  private readonly dir: string;

  constructor(virtualAgentsDir: string) {
    this.dir = virtualAgentsDir;
    this.loadAll();
    this.startWatcher();
  }

  get(name: string): PersonaConfig | null {
    return this.personas.get(name) ?? null;
  }

  list(): PersonaConfig[] {
    return Array.from(this.personas.values());
  }

  destroy(): void {
    if (this.watcher) {
      this.watcher.close();
      this.watcher = null;
    }
  }

  // ===== Internal =====

  private loadAll(): void {
    if (!fs.existsSync(this.dir)) {
      console.warn(`[PersonaRegistry] Directory not found, skipping: ${this.dir}`);
      return;
    }

    const files = fs.readdirSync(this.dir).filter(f => f.endsWith('.md'));
    const newMap = new Map<string, PersonaConfig>();

    for (const file of files) {
      const filePath = path.join(this.dir, file);
      try {
        const persona = this.parseFile(filePath);
        if (!persona) continue;

        if (newMap.has(persona.name)) {
          // name 字段重名：回退使用文件名（去 .md 后缀）作为 name
          const fileBaseName = path.basename(file, '.md');
          if (newMap.has(fileBaseName)) {
            console.warn(`[PersonaRegistry] Duplicate name "${persona.name}" and filename "${fileBaseName}" both taken, skipping ${file}`);
            continue;
          }
          console.warn(`[PersonaRegistry] Duplicate name "${persona.name}" in ${file}, falling back to filename "${fileBaseName}"`);
          persona.name = fileBaseName;
        }
        newMap.set(persona.name, persona);
      } catch (e) {
        console.warn(`[PersonaRegistry] Failed to parse ${file}:`, e);
      }
    }

    this.personas = newMap;
    console.warn(`[PersonaRegistry] Loaded ${newMap.size} persona(s): ${Array.from(newMap.keys()).join(', ') || '(none)'}`);
  }

  private parseFile(filePath: string): PersonaConfig | null {
    const raw = fs.readFileSync(filePath, 'utf-8');
    const lines = raw.split('\n');

    // Find frontmatter boundaries (--- ... ---)
    let fmStart = -1;
    let fmEnd = -1;
    for (let i = 0; i < lines.length; i++) {
      if (lines[i].trim() === '---') {
        if (fmStart === -1) {
          fmStart = i;
        } else {
          fmEnd = i;
          break;
        }
      }
    }

    if (fmStart === -1 || fmEnd === -1) {
      console.warn(`[PersonaRegistry] No frontmatter found in ${path.basename(filePath)}`);
      return null;
    }

    // Parse frontmatter key-value pairs
    const fm: Record<string, string> = {};
    for (let i = fmStart + 1; i < fmEnd; i++) {
      const line = lines[i].trim();
      if (!line || line.startsWith('#')) continue;
      const colonIdx = line.indexOf(':');
      if (colonIdx === -1) continue;
      const key = line.slice(0, colonIdx).trim();
      const value = line.slice(colonIdx + 1).trim();
      fm[key] = value;
    }

    // name 字段缺失时回退到文件名
    const fileName = path.basename(filePath, '.md');
    const name = fm['name'] || fileName;
    const description = fm['description'];
    if (!description) {
      console.warn(`[PersonaRegistry] Missing required field "description" in ${path.basename(filePath)}`);
      return null;
    }

    const tools = fm['tools']
      ? fm['tools'].split(',').map(t => t.trim()).filter(Boolean)
      : null;

    const model = fm['model'] || null;

    const maxConcurrent = fm['max_concurrent']
      ? parseInt(fm['max_concurrent'], 10) || 5
      : 5;

    // Everything after second --- is the system prompt, truncate if too long
    let systemPrompt = lines.slice(fmEnd + 1).join('\n').trim();
    if (systemPrompt.length > MAX_SYSTEM_PROMPT_LENGTH) {
      console.warn(`[PersonaRegistry] "${name}" systemPrompt too long (${systemPrompt.length} chars), truncating to ${MAX_SYSTEM_PROMPT_LENGTH}`);
      systemPrompt = systemPrompt.slice(0, MAX_SYSTEM_PROMPT_LENGTH);
    }

    return {
      name,
      description,
      tools,
      model,
      maxConcurrent,
      systemPrompt,
      filePath,
    };
  }

  private startWatcher(): void {
    if (!fs.existsSync(this.dir)) return;

    try {
      this.watcher = fs.watch(this.dir, { persistent: false }, (_eventType, filename) => {
        if (filename && filename.endsWith('.md')) {
          console.warn(`[PersonaRegistry] Detected change in ${filename}, reloading...`);
          this.loadAll();
        }
      });
    } catch (e) {
      console.warn('[PersonaRegistry] fs.watch failed, hot reload disabled:', e);
    }
  }
}
