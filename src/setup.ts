/**
 * setup.ts — 启动时交互式权限配置引导
 *
 * 在 main() 正式启动前调用 runSetupIfNeeded()：
 *   - 首次启动（无权限配置）→ 提示默认策略并询问是否配置
 *   - 已有配置 → 展示当前状态并询问是否重新配置
 *   - 非 TTY 环境（CI / 后台进程）→ 静默跳过
 *   - 2 分钟无操作 → 自动使用当前/默认配置继续启动
 */

import { getAdminPermissionsConfig, saveAdminPermissionsConfig } from './gateway/GroupManager';

const SETUP_TIMEOUT_MS = 2 * 60 * 1000; // 2 分钟

function isFirstTime(cfg: { skipMainAgentPermissions: boolean; skipAllAgentsPermissions: boolean }): boolean {
  // 两个字段都是默认值（false）视为未曾主动配置过
  return !cfg.skipMainAgentPermissions && !cfg.skipAllAgentsPermissions;
}

function describe(cfg: { skipMainAgentPermissions: boolean; skipAllAgentsPermissions: boolean }): string {
  if (cfg.skipAllAgentsPermissions) return '全部 Agent 免审批（含 dispatch 子 Agent）';
  if (cfg.skipMainAgentPermissions) return '主 Agent 免审批，其他 Agent 仍需审批';
  return '所有 Agent 均需权限审批（默认，最安全）';
}

/**
 * 启动一个超时计时器：到时后直接向 stdin emit 'keypress' 事件（name: 'return'），
 * 模拟 Enter 键，使 clack prompt 以 initialValue 解析（通常为 false）。
 *
 * 注意：clack 在 raw mode 下通过 readline.emitKeypressEvents 监听 'keypress'，
 * Enter 对应 { name: 'return' }，直接 emit 比 push('\r') 更可靠。
 */
function createSetupTimeout(): { timedOut: () => boolean; clear: () => void } {
  let _timedOut = false;
  const timer = setTimeout(() => {
    _timedOut = true;
    process.stdin.emit('keypress', '\r', {
      name: 'return',
      sequence: '\r',
      ctrl: false,
      meta: false,
      shift: false,
    });
  }, SETUP_TIMEOUT_MS);
  return {
    timedOut: () => _timedOut,
    clear: () => clearTimeout(timer),
  };
}

export async function runSetupIfNeeded(): Promise<void> {
  // 非交互式环境（后台进程、管道、CI）直接跳过
  if (!process.stdin.isTTY || !process.stdout.isTTY) return;

  const p = await import('@clack/prompts');

  const cfg = getAdminPermissionsConfig();
  const firstTime = isFirstTime(cfg);

  p.intro('SemaClaw');

  const timeout = createSetupTimeout();

  if (firstTime) {
    p.log.warn('未检测到权限配置，默认策略：所有 Agent 均需权限审批。');
    const configure = await p.confirm({
      message: '是否现在配置权限策略？（2 分钟无操作将自动跳过）',
      initialValue: false,
    });
    timeout.clear();
    if (p.isCancel(configure) || !configure) {
      if (timeout.timedOut()) {
        p.log.warn('等待超时，使用默认策略（需审批）。如需更改，请前往 WebUI 设置页。');
      } else {
        p.log.info('跳过配置，使用默认策略（需审批）。');
      }
      p.outro('启动中...');
      return;
    }
  } else {
    p.log.info(`当前权限策略：${describe(cfg)}`);
    const reconfigure = await p.confirm({
      message: '是否重新配置？（2 分钟无操作将自动跳过）',
      initialValue: false,
    });
    timeout.clear();
    if (p.isCancel(reconfigure) || !reconfigure) {
      if (timeout.timedOut()) {
        p.log.warn(`等待超时，继续使用当前策略：${describe(cfg)}。如需更改，请前往 WebUI 设置页。`);
      }
      p.outro('启动中...');
      return;
    }
  }

  // ===== 配置流程 =====
  const choice = await p.select({
    message: '选择权限策略',
    options: [
      {
        value: 'strict',
        label: '所有 Agent 均需审批',
        hint: '最安全，每次工具调用都需确认（默认）',
      },
      {
        value: 'main',
        label: '主 Agent 免审批',
        hint: '主 Agent 无需确认，dispatch 子 Agent 同样免审批，其他 Agent 仍需审批',
      },
      {
        value: 'all',
        label: '全部 Agent 免审批',
        hint: '所有 Agent 均无需确认，适合完全信任的本地环境',
      },
    ],
  });

  if (p.isCancel(choice)) {
    p.log.warn('已取消，保留原有配置。');
    p.outro('启动中...');
    return;
  }

  const next = {
    skipMainAgentPermissions: choice === 'main' || choice === 'all',
    skipAllAgentsPermissions: choice === 'all',
  };

  saveAdminPermissionsConfig(next);
  p.log.success(`已保存：${describe(next)}`);
  p.outro('启动中...');
}
