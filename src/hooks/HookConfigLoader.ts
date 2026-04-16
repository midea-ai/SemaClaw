import * as fs from 'fs';
import * as path from 'path';

// Hook 类型定义（与 sema-core/hooks/types 对齐，发布后改为 import from 'sema-core'）
interface HookDefinition {
  type: 'command' | 'prompt';
  command?: string;
  prompt?: string;
  timeout?: number;
  blocking?: boolean;
  async?: boolean;
}

interface HookEventConfig {
  matcher?: string;
  hooks: HookDefinition[];
}

export interface HookConfig {
  hooks: Record<string, HookEventConfig[]>;
}

/**
 * 从 JSON 文件加载 hook 配置
 * 文件不存在或解析失败时返回空配置
 */
function loadHookJson(filePath: string): HookConfig | null {
  try {
    if (!fs.existsSync(filePath)) return null;
    const raw = fs.readFileSync(filePath, 'utf-8');
    const parsed = JSON.parse(raw);
    if (parsed?.hooks && typeof parsed.hooks === 'object') {
      return parsed as HookConfig;
    }
    return null;
  } catch (e) {
    console.warn(`[hooks] Failed to load hook config from ${filePath}: ${e}`);
    return null;
  }
}

/**
 * 合并两份 hook 配置（global + workspace）
 * 同事件下合并 EventConfig 数组，不覆盖
 */
function mergeHookConfigs(
  global: HookConfig | null,
  workspace: HookConfig | null,
): HookConfig {
  if (!global && !workspace) return { hooks: {} };
  if (!global) return workspace!;
  if (!workspace) return global;

  const merged: HookConfig = { hooks: { ...global.hooks } };

  for (const [event, configs] of Object.entries(workspace.hooks)) {
    const existing = merged.hooks[event] || [];
    merged.hooks[event] = [...existing, ...configs];
  }

  return merged;
}

/**
 * 解析 hook command/prompt 中的变量
 * 支持: ${SEMACLAW_ROOT}, ${AGENT_WORKSPACE}
 */
function resolveVariablesInConfig(config: HookConfig, env: Record<string, string>): HookConfig {
  const resolved: HookConfig = { hooks: {} };

  for (const [event, configs] of Object.entries(config.hooks)) {
    resolved.hooks[event] = configs.map(eventConfig => ({
      ...eventConfig,
      hooks: eventConfig.hooks.map(hook => ({
        ...hook,
        command: hook.command ? resolveVariables(hook.command, env) : hook.command,
        prompt: hook.prompt ? resolveVariables(hook.prompt, env) : hook.prompt,
      })),
    }));
  }

  return resolved;
}

function resolveVariables(str: string, env: Record<string, string>): string {
  return str.replace(/\$\{(\w+)\}/g, (_, key) => env[key] ?? `\${${key}}`);
}

/**
 * 加载并合并 hook 配置（全局 + workspace）
 *
 * 查找路径:
 *   全局: ~/.semaclaw/hooks.json
 *   Workspace: <workspaceDir>/.semaclaw/hooks.json
 */
export function loadMergedHookConfig(
  globalConfigDir: string,
  workspaceDir?: string,
): HookConfig {
  const globalHooks = loadHookJson(path.join(globalConfigDir, 'hooks.json'));
  const workspaceHooks = workspaceDir
    ? loadHookJson(path.join(workspaceDir, '.semaclaw', 'hooks.json'))
    : null;

  return mergeHookConfigs(globalHooks, workspaceHooks);
}

/**
 * 构建 hook 环境变量
 */
export function resolveHookEnv(
  globalConfigDir: string,
  workspaceDir?: string,
): Record<string, string> {
  return {
    SEMACLAW_ROOT: globalConfigDir,
    AGENT_WORKSPACE: workspaceDir || globalConfigDir,
  };
}

/**
 * 完整的 hook 配置加载流程：加载 → 合并 → 变量解析
 * 返回空 hooks 时返回 undefined（sema-core 不创建 HookManager）
 */
export function loadAndResolveHookConfig(
  globalConfigDir: string,
  workspaceDir?: string,
): { hookConfig: HookConfig | undefined; hookEnv: Record<string, string> } {
  const hookEnv = resolveHookEnv(globalConfigDir, workspaceDir);
  const rawConfig = loadMergedHookConfig(globalConfigDir, workspaceDir);

  if (Object.keys(rawConfig.hooks).length === 0) {
    return { hookConfig: undefined, hookEnv };
  }

  const hookConfig = resolveVariablesInConfig(rawConfig, hookEnv);
  return { hookConfig, hookEnv };
}
