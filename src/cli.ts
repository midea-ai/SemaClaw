#!/usr/bin/env node
/**
 * SemaClaw CLI 入口
 *
 * 用法：
 *   semaclaw                    — 启动 daemon（等同 semaclaw start）
 *   semaclaw start              — 启动 daemon
 *   semaclaw skills <subcommand>
 *   semaclaw clawhub <subcommand>
 */

const subcommand = process.argv[2]

if (!subcommand || subcommand === 'start') {
  // Daemon 模式：直接导入并执行 index.ts
  import('./index.js').catch((err: unknown) => {
    console.error('[semaclaw] Failed to start daemon:', err)
    process.exit(1)
  })
} else if (subcommand === 'skills' || subcommand === 'clawhub' || subcommand === 'wiki' || subcommand === 'channel') {
  runCLI().catch((err: unknown) => {
    console.error(err instanceof Error ? err.message : String(err))
    process.exit(1)
  })
} else {
  console.error(`Unknown command: ${subcommand}`)
  console.error('Usage: semaclaw [start] | semaclaw skills <cmd> | semaclaw clawhub <cmd> | semaclaw wiki <cmd> | semaclaw channel <cmd>')
  process.exit(1)
}

async function runCLI(): Promise<void> {
  const { Command } = await import('commander')

  const program = new Command()
  program
    .name('semaclaw')
    .description('SemaClaw — multi-group AI gateway')
    .allowUnknownOption(false)

  // ============================================================
  // semaclaw skills
  // ============================================================

  const skills = program.command('skills').description('Manage local skills')

  skills
    .command('list')
    .description('List all available skills')
    .option('--verbose', 'Show full details per skill')
    .option('--json', 'Output as JSON')
    .action(async (opts: { verbose?: boolean; json?: boolean }) => {
      const { cmdSkillsList } = await import('./cli/commands/skills.js')
      cmdSkillsList(opts)
    })

  skills
    .command('info <name>')
    .description('Show details for a specific skill')
    .action(async (name: string) => {
      const { cmdSkillsInfo } = await import('./cli/commands/skills.js')
      cmdSkillsInfo(name)
    })

  skills
    .command('check')
    .description('Check skill directories and report status')
    .action(async () => {
      const { cmdSkillsCheck } = await import('./cli/commands/skills.js')
      cmdSkillsCheck()
    })

  skills
    .command('refresh')
    .description('Signal the daemon to reload all agents\' skill registries')
    .action(async () => {
      const { cmdSkillsRefresh } = await import('./cli/commands/skills.js')
      await cmdSkillsRefresh()
    })

  skills
    .command('disable <name>')
    .description('Disable a skill (prevents it from loading for all agents)')
    .action(async (name: string) => {
      const { cmdSkillsDisable } = await import('./cli/commands/skills.js')
      await cmdSkillsDisable(name)
    })

  skills
    .command('enable <name>')
    .description('Re-enable a previously disabled skill')
    .action(async (name: string) => {
      const { cmdSkillsEnable } = await import('./cli/commands/skills.js')
      await cmdSkillsEnable(name)
    })

  // ============================================================
  // semaclaw clawhub
  // ============================================================

  const clawhub = program.command('clawhub').description('ClaWHub skill marketplace')

  clawhub
    .command('search <query>')
    .description('Search skills on ClaWHub')
    .option('--limit <n>', 'Max results', (v: string) => parseInt(v, 10))
    .action(async (query: string, opts: { limit?: number }) => {
      const { cmdClawhubSearch } = await import('./cli/commands/clawhub.js')
      await cmdClawhubSearch(query, opts)
    })

  clawhub
    .command('install <slug>')
    .description('Install a skill from ClaWHub')
    .option('--force', 'Reinstall if already installed')
    .option('--version <v>', 'Install a specific version')
    .option('--group <id>', 'Install into a specific group workspace instead of global managed dir')
    .action(async (slug: string, opts: { force?: boolean; version?: string; group?: string }) => {
      const { cmdClawhubInstall } = await import('./cli/commands/clawhub.js')
      await cmdClawhubInstall(slug, opts)
    })

  clawhub
    .command('update [slug]')
    .description('Update installed skill(s)')
    .option('--all', 'Update all installed skills')
    .option('--force', 'Overwrite even if locally modified')
    .option('--version <v>', 'Pin to a specific version (single slug only)')
    .action(async (slug: string | undefined, opts: { all?: boolean; force?: boolean; version?: string }) => {
      const { cmdClawhubUpdate } = await import('./cli/commands/clawhub.js')
      await cmdClawhubUpdate(slug, opts)
    })

  clawhub
    .command('list')
    .description('List ClaWHub-managed installed skills')
    .action(async () => {
      const { cmdClawhubList } = await import('./cli/commands/clawhub.js')
      await cmdClawhubList()
    })

  clawhub
    .command('uninstall <slug>')
    .description('Uninstall a ClaWHub-managed skill')
    .option('--yes', 'Skip confirmation prompt')
    .action(async (slug: string, opts: { yes?: boolean }) => {
      const { cmdClawhubUninstall } = await import('./cli/commands/clawhub.js')
      await cmdClawhubUninstall(slug, opts)
    })

  clawhub
    .command('login')
    .description('Save a ClaWHub API token (get it at clawhub.ai/settings/tokens)')
    .option('--token <t>', 'Token to save (skip interactive prompt)')
    .action(async (opts: { token?: string }) => {
      const { cmdClawhubLogin } = await import('./cli/commands/clawhub.js')
      await cmdClawhubLogin(opts)
    })

  clawhub
    .command('logout')
    .description('Remove the stored ClaWHub API token')
    .action(async () => {
      const { cmdClawhubLogout } = await import('./cli/commands/clawhub.js')
      await cmdClawhubLogout()
    })

  clawhub
    .command('whoami')
    .description('Show the currently authenticated ClaWHub user')
    .action(async () => {
      const { cmdClawhubWhoami } = await import('./cli/commands/clawhub.js')
      await cmdClawhubWhoami()
    })

  clawhub
    .command('publish <path>')
    .description('Publish a skill directory to ClaWHub (requires login)')
    .option('--dry-run', 'Preview what would be published without uploading')
    .option('--tags <tags>', 'Comma-separated tags (default: latest)', 'latest')
    .option('--registry <url>', 'ClaWHub registry URL (default: https://clawhub.ai)')
    .action(async (skillPath: string, opts: { dryRun?: boolean; tags?: string; registry?: string }) => {
      const { cmdClawhubPublish } = await import('./cli/commands/clawhub.js')
      await cmdClawhubPublish(skillPath, opts)
    })

  // ============================================================
  // semaclaw channel
  // ============================================================

  const channel = program.command('channel').description('Manage bot channel bindings')

  channel
    .command('list')
    .description('List all configured channel bindings across all types')
    .action(async () => {
      const { cmdChannelList } = await import('./cli/commands/channel.js')
      cmdChannelList()
    })

  // ── semaclaw channel telegram ──
  const telegram = channel.command('telegram').description('Manage Telegram bot bindings')

  telegram
    .command('list')
    .description('List extra Telegram bot bindings')
    .action(async () => {
      const { cmdTelegramList } = await import('./cli/commands/channel.js')
      cmdTelegramList()
    })

  telegram
    .command('add')
    .description('Add a Telegram bot binding (writes to ~/.semaclaw/config.json)')
    .requiredOption('--token <token>', 'Bot token (from BotFather)')
    .requiredOption('--user <id>', 'Admin Telegram User ID')
    .requiredOption('--group <folder>', 'Agent folder name (lowercase, e.g. alice)')
    .option('--name <name>', 'Display name for this group')
    .action(async (opts: { token: string; user: string; group: string; name?: string }) => {
      const { cmdTelegramAdd } = await import('./cli/commands/channel.js')
      cmdTelegramAdd(opts)
    })

  telegram
    .command('remove')
    .description('Remove a Telegram bot binding by token')
    .requiredOption('--token <token>', 'Bot token to remove')
    .action(async (opts: { token: string }) => {
      const { cmdTelegramRemove } = await import('./cli/commands/channel.js')
      cmdTelegramRemove(opts)
    })

  // ── semaclaw channel qq ──
  const qq = channel.command('qq').description('Manage QQ app bindings')

  qq
    .command('list')
    .description('List configured QQ app bindings')
    .action(async () => {
      const { cmdQQList } = await import('./cli/commands/channel.js')
      cmdQQList()
    })

  qq
    .command('add')
    .description('Add a QQ app binding (writes to ~/.semaclaw/config.json)')
    .requiredOption('--app-id <id>', 'QQ App ID')
    .requiredOption('--app-secret <secret>', 'QQ App Secret')
    .requiredOption('--group <folder>', 'Agent folder name (lowercase, e.g. qqbot)')
    .option('--name <name>', 'Display name for this group (default: "<folder>(qq)")')
    .option('--sandbox', 'Use QQ sandbox environment')
    .action(async (opts: { appId: string; appSecret: string; group: string; name?: string; sandbox?: boolean }) => {
      const { cmdQQAdd } = await import('./cli/commands/channel.js')
      cmdQQAdd(opts)
    })

  qq
    .command('remove')
    .description('Remove a QQ app binding and its group binding')
    .requiredOption('--app-id <id>', 'QQ App ID to remove')
    .action(async (opts: { appId: string }) => {
      const { cmdQQRemove } = await import('./cli/commands/channel.js')
      cmdQQRemove(opts)
    })

  // ── semaclaw channel feishu ──
  const feishu = channel.command('feishu').description('Manage Feishu app bindings')

  feishu
    .command('list')
    .description('List configured Feishu app bindings')
    .action(async () => {
      const { cmdFeishuList } = await import('./cli/commands/channel.js')
      cmdFeishuList()
    })

  feishu
    .command('add')
    .description('Add a Feishu app binding (writes to ~/.semaclaw/config.json)')
    .requiredOption('--app-id <id>', 'Feishu App ID (e.g. cli_xxx)')
    .requiredOption('--app-secret <secret>', 'Feishu App Secret')
    .requiredOption('--group <folder>', 'Agent folder name (lowercase, e.g. flyclaw)')
    .option('--name <name>', 'Display name for this group')
    .option('--jid <jid>', 'Chat JID (leave blank to auto-bind on first message)')
    .option('--domain <domain>', 'feishu (default) or lark')
    .action(async (opts: { appId: string; appSecret: string; group: string; name?: string; jid?: string; domain?: string }) => {
      const { cmdFeishuAdd } = await import('./cli/commands/channel.js')
      cmdFeishuAdd(opts)
    })

  feishu
    .command('remove')
    .description('Remove a Feishu app binding and its group binding')
    .requiredOption('--app-id <id>', 'Feishu App ID to remove')
    .action(async (opts: { appId: string }) => {
      const { cmdFeishuRemove } = await import('./cli/commands/channel.js')
      cmdFeishuRemove(opts)
    })

  // ── semaclaw channel group ──
  const group = channel.command('group').description('Manage web-only (no channel) group bindings')

  group
    .command('add')
    .description('Register a web-only group (Web UI / dispatch only, no chat channel)')
    .requiredOption('--folder <folder>', 'Agent folder name (lowercase, e.g. myagent)')
    .option('--name <name>', 'Display name (default: folder name)')
    .option('--jid <jid>', 'Custom JID (default: web:<folder>)')
    .action(async (opts: { folder: string; name?: string; jid?: string }) => {
      const { cmdGroupAdd } = await import('./cli/commands/channel.js')
      cmdGroupAdd(opts)
    })

  group
    .command('remove')
    .description('Remove a group binding by folder name (agent directory is preserved)')
    .requiredOption('--folder <folder>', 'Agent folder name to remove')
    .action(async (opts: { folder: string }) => {
      const { cmdGroupRemove } = await import('./cli/commands/channel.js')
      cmdGroupRemove(opts)
    })

  // ── semaclaw channel wechat ──
  const wechat = channel.command('wechat').description('Manage WeChat iLink Bot accounts')

  wechat
    .command('list')
    .description('List configured WeChat accounts')
    .action(async () => {
      const { cmdWechatList } = await import('./cli/commands/channel.js')
      cmdWechatList()
    })

  wechat
    .command('add')
    .description('Add a new WeChat account (QR login on next start)')
    .requiredOption('--group <folder>', 'Agent folder name (e.g. alice)')
    .option('--name <name>', 'Display name for this account')
    .action(async (opts: { group: string; name?: string }) => {
      const { cmdWechatAdd } = await import('./cli/commands/channel.js')
      cmdWechatAdd(opts)
    })

  wechat
    .command('remove')
    .description('Remove a WeChat account and clean up credentials')
    .requiredOption('--group <folder>', 'Agent folder name to remove')
    .action(async (opts: { group: string }) => {
      const { cmdWechatRemove } = await import('./cli/commands/channel.js')
      cmdWechatRemove(opts)
    })

  // ============================================================
  // semaclaw wiki
  // ============================================================

  const wiki = program.command('wiki').description('Manage personal knowledge base')

  wiki
    .command('tree')
    .description('Print wiki directory tree')
    .action(async () => {
      const { cmdWikiTree } = await import('./cli/commands/wiki.js')
      await cmdWikiTree()
    })

  wiki
    .command('save')
    .description('Save a Markdown document from stdin to the wiki')
    .requiredOption('--path <rel>', 'Relative path within wiki (e.g. programming/rust/async.md)')
    .option('--tags <tags>', 'Comma-separated tags (e.g. rust,async)')
    .option('--source <src>', 'Source: agent | manual | url', 'agent')
    .option('--msg <message>', 'Custom git commit message')
    .action(async (opts: { path: string; tags?: string; source?: string; msg?: string }) => {
      const { cmdWikiSave } = await import('./cli/commands/wiki.js')
      await cmdWikiSave(opts)
    })

  wiki
    .command('search <query>')
    .description('Search wiki by title / filename / tags')
    .option('--limit <n>', 'Max results', (v: string) => parseInt(v, 10))
    .option('--tags <tags>', 'Filter by tags (comma-separated)')
    .action(async (query: string, opts: { limit?: number; tags?: string }) => {
      const { cmdWikiSearch } = await import('./cli/commands/wiki.js')
      await cmdWikiSearch(query, opts)
    })

  wiki
    .command('mkdir <path>')
    .description('Create a new directory in the wiki')
    .action(async (dirPath: string) => {
      const { cmdWikiMkdir } = await import('./cli/commands/wiki.js')
      await cmdWikiMkdir(dirPath)
    })

  wiki
    .command('stats')
    .description('Show wiki statistics')
    .action(async () => {
      const { cmdWikiStats } = await import('./cli/commands/wiki.js')
      await cmdWikiStats()
    })

  await program.parseAsync(process.argv)
}
