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
  include_history?: boolean;
  history_limit?: number;
}

interface HookEventConfig {
  matcher?: string;
  if?: string;
  hooks: HookDefinition[];
}

export interface HookConfig {
  hooks: Record<string, HookEventConfig[]>;
}

// sema-core 支持的合法 hook 事件名
const VALID_HOOK_EVENTS = new Set([
  'UserPromptSubmit',
  'PreToolUse',
  'PostToolUse',
  'PermissionRequest',
  'Stop',
  'SessionStart',
  'PreCompact',
  'PostCompact',
]);

// blocking 但无 timeout 时的兜底超时（秒）
const MARKETPLACE_BLOCKING_DEFAULT_TIMEOUT = 30;

/**
 * 对来自插件市场的 hook 配置做严格校验，过滤无效条目并修补潜在问题。
 *
 * 策略：
 * - 未知事件名 → 整组跳过（warn）
 * - hook 缺少 type / 必填字段 → 该 hook 条目跳过（warn）
 * - blocking=true 且无 timeout → 补 timeout=30 并 warn（而非跳过）
 *
 * 用户自己的 hooks.json 不经过此函数，保留完整控制权。
 */
function validateAndFilterMarketplaceHookConfig(
  config: HookConfig,
  filePath: string,
): HookConfig {
  const tag = `[hooks:marketplace] ${path.basename(path.dirname(filePath))}`;
  const result: HookConfig = { hooks: {} };

  for (const [event, eventConfigs] of Object.entries(config.hooks)) {
    if (!VALID_HOOK_EVENTS.has(event)) {
      console.warn(`${tag} Unknown hook event "${event}", skipping entire group`);
      continue;
    }

    if (!Array.isArray(eventConfigs)) continue;

    const validConfigs: HookEventConfig[] = [];

    for (const eventConfig of eventConfigs) {
      if (!Array.isArray(eventConfig?.hooks)) continue;

      const validHooks: HookDefinition[] = [];

      for (const hook of eventConfig.hooks) {
        if (hook.type !== 'command' && hook.type !== 'prompt') {
          console.warn(`${tag} [${event}] Invalid type "${hook.type as string}", skipping`);
          continue;
        }
        if (hook.type === 'command' && !hook.command) {
          console.warn(`${tag} [${event}] type=command missing "command" field, skipping`);
          continue;
        }
        if (hook.type === 'prompt' && !hook.prompt) {
          console.warn(`${tag} [${event}] type=prompt missing "prompt" field, skipping`);
          continue;
        }

        // blocking=true 但无 timeout：补兜底值，防止 agent 无限卡死
        if (hook.blocking && !hook.timeout) {
          console.warn(
            `${tag} [${event}] blocking=true without timeout, applying default ${MARKETPLACE_BLOCKING_DEFAULT_TIMEOUT}s`
          );
          validHooks.push({ ...hook, timeout: MARKETPLACE_BLOCKING_DEFAULT_TIMEOUT });
          continue;
        }

        validHooks.push(hook);
      }

      if (validHooks.length > 0) {
        validConfigs.push({ ...eventConfig, hooks: validHooks });
      }
    }

    if (validConfigs.length > 0) {
      result.hooks[event] = validConfigs;
    }
  }

  return result;
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
 * 加载并合并 hook 配置（全局 + workspace + 插件市场来源）
 *
 * 查找路径:
 *   全局: ~/.semaclaw/hooks.json
 *   Workspace: <workspaceDir>/.semaclaw/hooks.json
 *   extraFiles: 插件市场各来源的 hooks.json（已按优先级排序）
 */
export function loadMergedHookConfig(
  globalConfigDir: string,
  workspaceDir?: string,
  extraFiles?: string[],
): HookConfig {
  const globalHooks = loadHookJson(path.join(globalConfigDir, 'hooks.json'));
  const workspaceHooks = workspaceDir
    ? loadHookJson(path.join(workspaceDir, '.semaclaw', 'hooks.json'))
    : null;

  let merged = mergeHookConfigs(globalHooks, workspaceHooks);

  // Merge marketplace hook files: load → validate/filter → merge (additive)
  for (const filePath of extraFiles ?? []) {
    const raw = loadHookJson(filePath);
    if (!raw) continue;
    const validated = validateAndFilterMarketplaceHookConfig(raw, filePath);
    if (Object.keys(validated.hooks).length > 0) {
      merged = mergeHookConfigs(merged, validated);
    }
  }

  return merged;
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
  extraFiles?: string[],
): { hookConfig: HookConfig | undefined; hookEnv: Record<string, string> } {
  const hookEnv = resolveHookEnv(globalConfigDir, workspaceDir);
  const rawConfig = loadMergedHookConfig(globalConfigDir, workspaceDir, extraFiles);

  if (Object.keys(rawConfig.hooks).length === 0) {
    return { hookConfig: undefined, hookEnv };
  }

  const hookConfig = resolveVariablesInConfig(rawConfig, hookEnv);
  return { hookConfig, hookEnv };
}
