/**
 * semaclaw channel <subcommand>
 *
 * 用法：
 *   semaclaw channel list                                          — 所有已配置 channel 汇总
 *   semaclaw channel telegram list                                 — 列出额外 Telegram Bot 绑定
 *   semaclaw channel telegram add --token <t> --user <id> --group <folder>
 *   semaclaw channel telegram remove --token <t>
 *   semaclaw channel feishu list                                   — 列出飞书应用绑定
 *   semaclaw channel feishu add --app-id <id> --app-secret <s> --group <folder>
 *   semaclaw channel feishu remove --app-id <id>
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

function getConfigPath(): string {
  return process.env.SEMACLAW_CONFIG_PATH ?? path.join(os.homedir(), '.semaclaw', 'config.json');
}

// 独立读写 config.json，不引入 src/config.ts（避免 dotenv 等副作用）
interface TelegramBotEntry {
  token: string;
  adminUserId: string;
  folder: string;
  name?: string;
}

interface FeishuAppEntry {
  appSecret: string;
  domain?: string;
}

interface QQAppEntry {
  appSecret: string;
  sandbox?: boolean;
}

interface GroupEntry {
  jid: string;
  folder: string;
  name?: string;
  channel: string;
  requiresTrigger: boolean;
  allowedTools: null;
  allowedWorkDirs: null;
  botToken: string | null;
  maxMessages: null;
}

interface WeixinAccountEntry {
  name?: string;
}

interface PartialConfig {
  telegramBots?: TelegramBotEntry[];
  feishuApps?: Record<string, FeishuAppEntry>;
  qqApps?: Record<string, QQAppEntry>;
  wechatAccounts?: Record<string, WeixinAccountEntry>;
  groups?: GroupEntry[];
  [key: string]: unknown;
}

function readConfig(): PartialConfig {
  try {
    return JSON.parse(fs.readFileSync(getConfigPath(), 'utf8')) as PartialConfig;
  } catch {
    return {};
  }
}

function writeConfig(cfg: PartialConfig): void {
  const p = getConfigPath();
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(cfg, null, 2), 'utf8');
}

function validateFolder(group: string): void {
  if (!/^[a-z][a-z0-9_-]*$/.test(group)) {
    console.error('Error: --group must be lowercase letters, digits, hyphens or underscores (e.g. alice, work-bot)');
    process.exit(1);
  }
}

// ── semaclaw channel list ────────────────────────────────────────────
// 所有 channel 类型汇总（后续扩展时在此追加各类型的摘要）

export function cmdChannelList(): void {
  const cfg = readConfig();
  const tgBots = cfg.telegramBots ?? [];
  const feishuApps = cfg.feishuApps ?? {};

  let hasAny = false;

  if (tgBots.length > 0) {
    hasAny = true;
    console.log(`Telegram (${tgBots.length} extra bot(s)):`);
    for (const b of tgBots) {
      console.log(`  [${b.folder}] user=${b.adminUserId} token=${b.token.slice(0, 10)}…${b.name ? ` "${b.name}"` : ''}`);
    }
    console.log();
  }

  const feishuEntries = Object.entries(feishuApps);
  if (feishuEntries.length > 0) {
    hasAny = true;
    console.log(`Feishu (${feishuEntries.length} app(s)):`);
    for (const [appId, app] of feishuEntries) {
      const group = (cfg.groups ?? []).find(g => g.botToken === appId);
      console.log(`  [${group?.folder ?? '—'}] appId=${appId}${app.domain ? ` domain=${app.domain}` : ''}${group?.name ? ` "${group.name}"` : ''}`);
    }
    console.log();
  }

  const qqEntries = Object.entries(cfg.qqApps ?? {});
  if (qqEntries.length > 0) {
    hasAny = true;
    console.log(`QQ (${qqEntries.length} app(s)):`);
    for (const [appId, app] of qqEntries) {
      const group = (cfg.groups ?? []).find(g => g.botToken === appId);
      console.log(`  [${group?.folder ?? '—'}] appId=${appId}${app.sandbox ? ' sandbox=true' : ''}${group?.name ? ` "${group.name}"` : ''}`);
    }
    console.log();
  }

  const wechatEntries = Object.entries(cfg.wechatAccounts ?? {});
  if (wechatEntries.length > 0) {
    hasAny = true;
    console.log(`WeChat (${wechatEntries.length} account(s)):`);
    for (const [folder, acc] of wechatEntries) {
      const group = (cfg.groups ?? []).find(g => g.folder === folder && g.channel === 'wechat');
      const jid = group?.jid ?? '(pending)';
      console.log(`  [${folder}] jid=${jid}${acc.name ? ` "${acc.name}"` : ''}`);
    }
    console.log();
  }

  if (!hasAny) {
    console.log('No extra channel bindings configured.');
    console.log('Primary channels are set via .env (e.g. TELEGRAM_BOT_TOKEN).');
  }
}

// ── semaclaw channel telegram list ──────────────────────────────────

export function cmdTelegramList(): void {
  const bots = readConfig().telegramBots ?? [];
  if (bots.length === 0) {
    console.log('No extra Telegram bots configured.');
    console.log('(Primary bot: TELEGRAM_BOT_TOKEN + ADMIN_TELEGRAM_USER_ID in .env)');
    return;
  }
  console.log(`Extra Telegram bots (${bots.length}):\n`);
  for (const b of bots) {
    console.log(`  folder : ${b.folder}`);
    console.log(`  user   : ${b.adminUserId}`);
    console.log(`  token  : ${b.token.slice(0, 10)}…`);
    if (b.name) console.log(`  name   : ${b.name}`);
    console.log();
  }
}

// ── semaclaw channel telegram add ───────────────────────────────────

export function cmdTelegramAdd(opts: {
  token: string;
  user: string;
  group: string;
  name?: string;
}): void {
  const { token, user, group, name } = opts;
  validateFolder(group);

  const cfg = readConfig();
  const bots = cfg.telegramBots ?? [];

  const existsByToken = bots.find(b => b.token === token);
  if (existsByToken) {
    console.error(`Error: this token is already bound to folder "${existsByToken.folder}".`);
    console.error('Use "semaclaw channel telegram remove --token <token>" first to re-bind.');
    process.exit(1);
  }

  const existsByFolder = bots.find(b => b.folder === group);
  if (existsByFolder) {
    console.error(`Error: folder "${group}" already has a Telegram bot binding (user: ${existsByFolder.adminUserId}).`);
    console.error('Each folder supports one extra Telegram bot. Remove the existing one first.');
    process.exit(1);
  }

  const entry: TelegramBotEntry = { token, adminUserId: user, folder: group };
  if (name) entry.name = name;
  bots.push(entry);
  writeConfig({ ...cfg, telegramBots: bots });

  console.log('✓ Telegram bot added:');
  console.log(`  folder : ${group}`);
  console.log(`  user   : ${user}`);
  console.log(`  token  : ${token.slice(0, 10)}…`);
  if (name) console.log(`  name   : ${name}`);
  console.log();
  console.log('Restart semaclaw to apply.');
}

// ── semaclaw channel telegram remove ────────────────────────────────

export function cmdTelegramRemove(opts: { token: string }): void {
  const cfg = readConfig();
  const bots = cfg.telegramBots ?? [];
  const filtered = bots.filter(b => b.token !== opts.token);

  if (filtered.length === bots.length) {
    console.error('Error: no Telegram binding found with that token.');
    process.exit(1);
  }

  writeConfig({ ...cfg, telegramBots: filtered });
  console.log('✓ Telegram binding removed. Restart semaclaw to apply.');
}

// ── semaclaw channel feishu list ─────────────────────────────────────

export function cmdFeishuList(): void {
  const cfg = readConfig();
  const apps = cfg.feishuApps ?? {};
  const entries = Object.entries(apps);

  if (entries.length === 0) {
    console.log('No extra Feishu apps configured.');
    console.log('(Primary app: FEISHU_APP_ID + FEISHU_APP_SECRET in .env)');
    return;
  }

  console.log(`Extra Feishu apps (${entries.length}):\n`);
  for (const [appId, app] of entries) {
    const group = (cfg.groups ?? []).find(g => g.botToken === appId);
    console.log(`  appId  : ${appId}`);
    if (app.domain) console.log(`  domain : ${app.domain}`);
    if (group) {
      console.log(`  folder : ${group.folder}`);
      console.log(`  jid    : ${group.jid}`);
      if (group.name) console.log(`  name   : ${group.name}`);
    } else {
      console.log(`  folder : (no group binding)`);
    }
    console.log();
  }
}

// ── semaclaw channel feishu add ──────────────────────────────────────

export function cmdFeishuAdd(opts: {
  appId: string;
  appSecret: string;
  group: string;
  name?: string;
  jid?: string;
  domain?: string;
}): void {
  const { appId, appSecret, group, name, domain } = opts;
  validateFolder(group);

  const cfg = readConfig();
  const apps = cfg.feishuApps ?? {};
  const groups = cfg.groups ?? [];

  // 检查 appId 是否已存在
  if (apps[appId]) {
    console.error(`Error: Feishu app "${appId}" is already configured.`);
    console.error('Use "semaclaw channel feishu remove --app-id <id>" first to re-bind.');
    process.exit(1);
  }

  // 检查 folder 是否已被其他 feishu app 占用
  const existsByFolder = groups.find(g => g.folder === group && g.channel === 'feishu');
  if (existsByFolder) {
    console.error(`Error: folder "${group}" already has a Feishu binding (appId: ${existsByFolder.botToken}).`);
    console.error('Remove the existing one first, or choose a different folder name.');
    process.exit(1);
  }

  // 写入 feishuApps
  const appEntry: FeishuAppEntry = { appSecret };
  if (domain) appEntry.domain = domain;
  apps[appId] = appEntry;

  // 构造 group binding（JID 默认 pending，等第一条消息后自动迁移）
  const jid = opts.jid?.trim() || `feishu:pending:${appId}`;
  const groupEntry: GroupEntry = {
    jid,
    folder: group,
    name: name ?? group,
    channel: 'feishu',
    requiresTrigger: true,
    allowedTools: null,
    allowedWorkDirs: null,
    botToken: appId,
    maxMessages: null,
  };

  // 覆盖同 jid 的旧 group（幂等）
  const filteredGroups = groups.filter(g => g.jid !== jid);
  filteredGroups.push(groupEntry);

  writeConfig({ ...cfg, feishuApps: apps, groups: filteredGroups });

  console.log('✓ Feishu app added:');
  console.log(`  appId  : ${appId}`);
  if (domain) console.log(`  domain : ${domain}`);
  console.log(`  folder : ${group}`);
  console.log(`  jid    : ${jid}`);
  if (name) console.log(`  name   : ${name}`);
  if (jid.includes(':pending:')) {
    console.log();
    console.log('  Note: JID is pending. Send the first message from Feishu to auto-bind.');
  }
  console.log();
  console.log('Restart semaclaw to apply.');
}

// ── semaclaw channel feishu remove ───────────────────────────────────

export function cmdFeishuRemove(opts: { appId: string }): void {
  const cfg = readConfig();
  const apps = cfg.feishuApps ?? {};

  if (!apps[opts.appId]) {
    console.error(`Error: no Feishu app found with appId "${opts.appId}".`);
    process.exit(1);
  }

  delete apps[opts.appId];

  // 同时移除关联的 group binding
  const groups = cfg.groups ?? [];
  const filtered = groups.filter(g => g.botToken !== opts.appId);
  const removed = groups.length - filtered.length;

  writeConfig({ ...cfg, feishuApps: apps, groups: filtered });

  console.log(`✓ Feishu app "${opts.appId}" removed.`);
  if (removed > 0) console.log(`  Also removed ${removed} associated group binding(s).`);
  console.log('Restart semaclaw to apply.');
}

// ── semaclaw channel qq list ──────────────────────────────────────────

export function cmdQQList(): void {
  const cfg = readConfig();
  const apps = cfg.qqApps ?? {};
  const entries = Object.entries(apps);

  if (entries.length === 0) {
    console.log('No extra QQ apps configured.');
    console.log('(Primary app: QQ_APP_ID + QQ_APP_SECRET in .env)');
    return;
  }

  console.log(`Extra QQ apps (${entries.length}):\n`);
  for (const [appId, app] of entries) {
    const group = (cfg.groups ?? []).find(g => g.botToken === appId);
    console.log(`  appId  : ${appId}`);
    if (app.sandbox) console.log(`  sandbox: true`);
    if (group) {
      console.log(`  folder : ${group.folder}`);
      console.log(`  jid    : ${group.jid}`);
      if (group.name) console.log(`  name   : ${group.name}`);
    } else {
      console.log(`  folder : (no group binding)`);
    }
    console.log();
  }
}

// ── semaclaw channel qq add ───────────────────────────────────────────

export function cmdQQAdd(opts: {
  appId: string;
  appSecret: string;
  group: string;
  name?: string;
  sandbox?: boolean;
}): void {
  const { appId, appSecret, group, sandbox } = opts;
  validateFolder(group);

  const cfg = readConfig();
  const apps = cfg.qqApps ?? {};
  const groups = cfg.groups ?? [];

  if (apps[appId]) {
    console.error(`Error: QQ app "${appId}" is already configured.`);
    console.error('Use "semaclaw channel qq remove --app-id <id>" first to re-bind.');
    process.exit(1);
  }

  const existsByFolder = groups.find(g => g.folder === group && g.channel === 'qq');
  if (existsByFolder) {
    console.error(`Error: folder "${group}" already has a QQ binding (appId: ${existsByFolder.botToken}).`);
    console.error('Remove the existing one first, or choose a different folder name.');
    process.exit(1);
  }

  const appEntry: QQAppEntry = { appSecret };
  if (sandbox) appEntry.sandbox = true;
  apps[appId] = appEntry;

  // JID 始终为 pending，等第一条消息到达后自动迁移到真实 JID
  const jid = `qq:pending:${appId}`;
  const name = opts.name ?? `${group}(qq)`;
  const groupEntry: GroupEntry = {
    jid,
    folder: group,
    name,
    channel: 'qq',
    requiresTrigger: true,
    allowedTools: null,
    allowedWorkDirs: null,
    botToken: appId,
    maxMessages: null,
  };

  const filteredGroups = groups.filter(g => g.jid !== jid);
  filteredGroups.push(groupEntry);

  writeConfig({ ...cfg, qqApps: apps, groups: filteredGroups });

  console.log('✓ QQ app added:');
  console.log(`  appId  : ${appId}`);
  if (sandbox) console.log(`  sandbox: true`);
  console.log(`  folder : ${group}`);
  console.log(`  name   : ${name}`);
  console.log(`  jid    : ${jid}`);
  console.log();
  console.log('  Note: JID is pending. The first message received will auto-bind to the real JID.');
  console.log();
  console.log('Restart semaclaw to apply.');
}

// ── semaclaw channel qq remove ────────────────────────────────────────

export function cmdQQRemove(opts: { appId: string }): void {
  const cfg = readConfig();
  const apps = cfg.qqApps ?? {};

  if (!apps[opts.appId]) {
    console.error(`Error: no QQ app found with appId "${opts.appId}".`);
    process.exit(1);
  }

  delete apps[opts.appId];

  const groups = cfg.groups ?? [];
  const filtered = groups.filter(g => g.botToken !== opts.appId || g.channel !== 'qq');
  const removed = groups.length - filtered.length;

  writeConfig({ ...cfg, qqApps: apps, groups: filtered });

  console.log(`✓ QQ app "${opts.appId}" removed.`);
  if (removed > 0) console.log(`  Also removed ${removed} associated group binding(s).`);
  console.log('Restart semaclaw to apply.');
}

// ── semaclaw channel wechat list ──────────────────────────────────────

export function cmdWechatList(): void {
  const cfg = readConfig();
  const accounts = cfg.wechatAccounts ?? {};
  const entries = Object.entries(accounts);

  if (entries.length === 0) {
    console.log('No WeChat accounts configured via CLI.');
    console.log('(Primary account: WECHAT_ENABLED=true in .env, credential saved at ~/.semaclaw/wechat/accounts/default.json)');
    return;
  }

  console.log(`WeChat accounts (${entries.length}):\n`);
  for (const [folder, acc] of entries) {
    const group = (cfg.groups ?? []).find(g => g.folder === folder && g.channel === 'wechat');
    console.log(`  folder : ${folder}`);
    if (acc.name) console.log(`  name   : ${acc.name}`);
    console.log(`  jid    : ${group?.jid ?? '(pending — scan QR on next start)'}`);
    console.log();
  }
}

// ── semaclaw channel wechat add ───────────────────────────────────────

export function cmdWechatAdd(opts: {
  group: string;
  name?: string;
}): void {
  const { group, name } = opts;
  validateFolder(group);

  const cfg = readConfig();
  const accounts = cfg.wechatAccounts ?? {};
  const groups = cfg.groups ?? [];

  if (accounts[group]) {
    console.error(`Error: WeChat account for folder "${group}" is already configured.`);
    console.error('Use "semaclaw channel wechat remove --group <folder>" first to re-bind.');
    process.exit(1);
  }

  // 检查 folder 是否已被其他 wechat 账户占用
  const existsByFolder = groups.find(g => g.folder === group && g.channel === 'wechat');
  if (existsByFolder) {
    console.error(`Error: folder "${group}" already has a WeChat binding.`);
    console.error('Remove the existing one first, or choose a different folder name.');
    process.exit(1);
  }

  // 写入 wechatAccounts
  const accEntry: WeixinAccountEntry = {};
  if (name) accEntry.name = name;
  accounts[group] = accEntry;

  // 构造 group binding（JID pending，等扫码后首条消息到达自动迁移）
  const jid = `wx:pending:${group}`;
  const groupEntry: GroupEntry = {
    jid,
    folder: group,
    name: name ?? group,
    channel: 'wechat',
    requiresTrigger: false,
    allowedTools: null,
    allowedWorkDirs: null,
    botToken: group,   // botToken = accountId = folder，用于 pending 绑定路由
    maxMessages: null,
  };

  const filteredGroups = groups.filter(g => g.jid !== jid);
  filteredGroups.push(groupEntry);

  writeConfig({ ...cfg, wechatAccounts: accounts, groups: filteredGroups });

  console.log('✓ WeChat account added:');
  console.log(`  folder : ${group}`);
  if (name) console.log(`  name   : ${name}`);
  console.log(`  jid    : ${jid}`);
  console.log();
  console.log('  Note: Credentials not yet saved. On next "semaclaw start",');
  console.log('        scan the QR code displayed in the terminal to complete login.');
  console.log();
  console.log('Restart semaclaw to apply.');
}

// ── semaclaw channel wechat remove ────────────────────────────────────

export function cmdWechatRemove(opts: { group: string }): void {
  const { group } = opts;
  const cfg = readConfig();
  const accounts = cfg.wechatAccounts ?? {};

  if (!accounts[group]) {
    console.error(`Error: no WeChat account found for folder "${group}".`);
    process.exit(1);
  }

  delete accounts[group];

  // 移除关联的 group binding
  const groups = cfg.groups ?? [];
  const filtered = groups.filter(g => !(g.folder === group && g.channel === 'wechat'));
  const removed = groups.length - filtered.length;

  writeConfig({ ...cfg, wechatAccounts: accounts, groups: filtered });

  // 删除凭证文件和状态文件（best-effort）
  const stateDir = path.join(os.homedir(), '.semaclaw', 'wechat');
  const filesToDelete = [
    path.join(stateDir, 'accounts', `${group}.json`),
    path.join(stateDir, `sync-buf-${group}.bin`),
    path.join(stateDir, `context-tokens-${group}.json`),
  ];
  for (const f of filesToDelete) {
    try { fs.unlinkSync(f); } catch { /* 文件不存在时忽略 */ }
  }

  console.log(`✓ WeChat account "${group}" removed.`);
  if (removed > 0) console.log(`  Also removed ${removed} associated group binding(s).`);
  console.log('  Credential files cleaned up.');
  console.log('Restart semaclaw to apply.');
}

// ── semaclaw channel group add ─────────────────────────────────────────
// Web-only group: no channel binding, accessible via Web UI and dispatch only.

export function cmdGroupAdd(opts: {
  folder: string;
  name?: string;
  jid?: string;
}): void {
  const { folder, name } = opts;
  validateFolder(folder);

  const cfg = readConfig();
  const groups = cfg.groups ?? [];

  const existsByFolder = groups.find(g => g.folder === folder);
  if (existsByFolder) {
    console.error(`Error: folder "${folder}" already has a binding (jid: ${existsByFolder.jid}, channel: ${existsByFolder.channel}).`);
    console.error('Remove the existing binding first.');
    process.exit(1);
  }

  const jid = opts.jid?.trim() || `web:${folder}`;
  const existsByJid = groups.find(g => g.jid === jid);
  if (existsByJid) {
    console.error(`Error: JID "${jid}" is already bound to folder "${existsByJid.folder}".`);
    process.exit(1);
  }

  const groupEntry: GroupEntry = {
    jid,
    folder,
    name: name ?? folder,
    channel: 'web',
    requiresTrigger: false,
    allowedTools: null,
    allowedWorkDirs: null,
    botToken: null,
    maxMessages: null,
  };

  groups.push(groupEntry);
  writeConfig({ ...cfg, groups });

  console.log('✓ Web-only group added:');
  console.log(`  folder : ${folder}`);
  console.log(`  name   : ${groupEntry.name}`);
  console.log(`  jid    : ${jid}`);
  console.log();
  console.log('Restart semaclaw to apply.');
}

// ── semaclaw channel group remove ──────────────────────────────────────

export function cmdGroupRemove(opts: { folder: string }): void {
  const { folder } = opts;
  const cfg = readConfig();
  const groups = cfg.groups ?? [];

  const target = groups.find(g => g.folder === folder);
  if (!target) {
    console.error(`Error: no group binding found for folder "${folder}".`);
    process.exit(1);
  }

  writeConfig({ ...cfg, groups: groups.filter(g => g.folder !== folder) });

  console.log(`✓ Group binding removed: folder="${folder}" jid="${target.jid}"`);
  console.log('  Note: agent directory is preserved. Delete manually if needed.');
  console.log('Restart semaclaw to apply.');
}
