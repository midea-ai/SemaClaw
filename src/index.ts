/**
 * SemaClaw 主入口
 *
 * 启动序列：
 *   1. 初始化 SQLite
 *   2. 初始化 GroupManager，注册主频道
 *   3. 初始化 TelegramChannel，加载额外 Bot token，connect
 *   4. 构造 sendReply 回调
 *   5. 初始化 AgentPool（注入 sendReply）
 *   6. 初始化 GroupQueue
 *   7. 初始化 MessageRouter，start
 *   8. 初始化 TaskScheduler，start
 *   9. 初始化 WebSocketGateway，start
 *  10. 注册 SIGINT/SIGTERM 优雅关闭
 */

import 'dotenv/config';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

// ===== model.conf 隔离（必须在任何 sema-core 模块加载前执行）=====
// semaclaw 使用独立的 ~/.semaclaw/semaclaw-model.conf，避免与其他基于 sema-code-core
// 的应用（如 sema-code 编辑器）共享 ~/.sema/model.conf 造成互相干扰。
{
  const SEMACLAW_DIR = path.join(os.homedir(), '.semaclaw');
  const semaclawModelConf = path.join(SEMACLAW_DIR, 'semaclaw-model.conf');
  if (!fs.existsSync(semaclawModelConf)) {
    const defaultModelConf = path.join(os.homedir(), '.sema', 'model.conf');
    if (fs.existsSync(defaultModelConf)) {
      fs.mkdirSync(SEMACLAW_DIR, { recursive: true });
      fs.copyFileSync(defaultModelConf, semaclawModelConf);
      console.log('[SemaClaw] Migrated ~/.sema/model.conf → ~/.semaclaw/semaclaw-model.conf');
    }
  }
  // 动态 require 以确保 override 在模块初始化前生效
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { setModelConfigPathOverride } = require('sema-core') as { setModelConfigPathOverride: (p: string) => void };
  setModelConfigPathOverride(semaclawModelConf);
}

import { runSetupIfNeeded } from './setup';
import { initDb } from './db/db';
import { GroupManager, ensureAdminGroup, ensureWechatAdminGroup, syncGroupsFromConfig, getFeishuApps, getQQApps, getWechatAccounts, getTelegramBots, loadLLMConfigs } from './gateway/GroupManager';
import { getModelManager } from 'sema-core';
import { TelegramChannel } from './channels/telegram';
import { FeishuChannel } from './channels/feishu';
import { QQChannel } from './channels/qq';
import { WeChatChannel } from './channels/wechat';
import { AgentPool } from './agent/AgentPool';
import { GroupQueue } from './agent/GroupQueue';
import { MessageRouter } from './gateway/MessageRouter';
import { TaskScheduler } from './scheduler/TaskScheduler';
import { WebSocketGateway } from './gateway/WebSocketGateway';
import { UIServer } from './gateway/UIServer';
import { config } from './config';
import { DispatchBridge } from './agent/DispatchBridge';
import { PersonaRegistry } from './agent/PersonaRegistry';
import { VirtualWorkerPool } from './agent/VirtualWorkerPool';
import { WikiManager } from './wiki/WikiManager';

async function main(): Promise<void> {
  // ===== 0. 启动引导 =====
  await runSetupIfNeeded();

  console.log('[SemaClaw] Starting...');

  // ===== 1. 数据库 + 记忆系统 =====
  const db = initDb();
  console.log(`[SemaClaw] DB initialized: ${config.paths.dbPath}`);

  // 初始化 MemoryManager（记忆索引 + 搜索）
  const { MemoryManager } = await import('./memory/MemoryManager');
  MemoryManager.init(db, {
    agentsDir: config.paths.agentsDir,
    embeddingConfig: {
      provider: config.memory.embeddingProvider,
      openaiApiKey: config.memory.openaiApiKey || undefined,
      openaiBaseUrl: config.memory.openaiBaseUrl || undefined,
    },
    chunkerOptions: {
      chunkSize: config.memory.chunkSize,
      chunkOverlap: config.memory.chunkOverlap,
    },
  });
  console.log(`[SemaClaw] MemoryManager initialized (embedding: ${config.memory.embeddingProvider})`);

  // ===== 2. GroupManager =====
  const groupManager = new GroupManager();
  // ensureAdminGroup 在 TelegramChannel connect 后调用（需要 botUserId）
  const syncResult = syncGroupsFromConfig(groupManager);

  // ===== 2b. LLM config 同步到 sema-core =====
  // config.json 是 semaclaw 的权威来源；有 active config 时直接覆盖 sema-core 的 model 单例
  // 没有时保持 model.conf 原有配置（向后兼容）
  {
    const { configs, activeId } = loadLLMConfigs();
    const activeCfg = activeId ? configs.find(c => c.id === activeId) : configs[0];
    if (activeCfg) {
      try {
        const mm = getModelManager();
        // upsert 所有已保存的 profile，保证 model.conf 与 config.json 一致
        for (const c of configs) {
          await mm.addNewModel({
            provider: c.provider, modelName: c.modelName,
            baseURL: c.baseURL, apiKey: c.apiKey,
            maxTokens: c.maxTokens, contextLength: c.contextLength,
            adapt: c.adapt,
          }, true);
        }
        await mm.switchCurrentModel(`${activeCfg.modelName}[${activeCfg.provider}]`);
        console.log(`[SemaClaw] LLM config synced: ${activeCfg.modelName}[${activeCfg.provider}]`);
      } catch (e) {
        console.warn('[SemaClaw] LLM config sync failed:', e);
      }
    }
  }
  if (syncResult.added + syncResult.updated + syncResult.removed > 0) {
    console.log(`[SemaClaw] Groups synced from config.json: +${syncResult.added} added, ~${syncResult.updated} updated, -${syncResult.removed} removed`);
  }

  // ===== 3. TelegramChannel =====
  const telegramChannel = new TelegramChannel(config.telegram.botToken);

  // 先 connect 主 bot（init 后才能拿到 botUserId）
  try {
    await telegramChannel.connect();
  } catch (err) {
    console.error('[SemaClaw] TelegramChannel connect failed, continuing without Telegram:', err);
  }
  if (telegramChannel.isConnected()) {
    console.log('[SemaClaw] TelegramChannel connected');
  } else {
    console.warn('[SemaClaw] TelegramChannel not connected (token missing or invalid)');
  }

  // 主 bot init 完成后注册 admin group（jid 带上 botUserId）
  const mainBotUserId = telegramChannel.getBotUserId(config.telegram.botToken);
  ensureAdminGroup(groupManager, mainBotUserId);

  // 加载 config.json 中的额外 Telegram Bot 绑定
  const telegramBotConfigs = getTelegramBots();
  for (const botCfg of telegramBotConfigs) {
    await telegramChannel.addBot(botCfg.token);
    const extraBotUserId = telegramChannel.getBotUserId(botCfg.token);
    const botJid = extraBotUserId
      ? `tg:${extraBotUserId}:user:${botCfg.adminUserId}`
      : `tg:user:${botCfg.adminUserId}`;

    // 同 ensureAdminGroup：folder UNIQUE 约束保护 — 若旧 jid 与新 jid 不同则先迁移
    const existingByFolder = groupManager.list().find(g => g.folder === botCfg.folder);
    if (existingByFolder && existingByFolder.jid !== botJid) {
      groupManager.unregister(existingByFolder.jid);
      console.log(`[SemaClaw] Migrated extra bot group: ${existingByFolder.jid} → ${botJid}`);
    }

    const now = new Date().toISOString();
    const existing = groupManager.get(botJid) ?? existingByFolder ?? null;
    groupManager.register({
      jid: botJid,
      folder: botCfg.folder,
      name: botCfg.name ?? existing?.name ?? `${botCfg.folder} (Telegram)`,
      channel: 'telegram',
      isAdmin: botCfg.folder === 'main',
      requiresTrigger: false,
      allowedTools: null,
      allowedPaths: existing?.allowedPaths ?? null,
      allowedWorkDirs: existing?.allowedWorkDirs ?? null,
      botToken: botCfg.token,
      maxMessages: existing?.maxMessages ?? null,
      lastActive: existing?.lastActive ?? null,
      addedAt: existing?.addedAt ?? now,
    });
    console.log(`[SemaClaw] Extra Telegram bot registered: ${botJid} → agents/${botCfg.folder}/`);
  }

  // 加载所有群组已注册的额外 Bot token（addBot 内部已处理空 token 和 init 失败）
  const extraTokens = groupManager.getExtraBotTokens(config.telegram.botToken);
  for (const token of extraTokens) {
    await telegramChannel.addBot(token);
  }

  // ===== 3.5 FeishuChannel =====
  // 凭证齐全即建连（保持 WS 长连接，方便后续绑定群组）
  let feishuChannel: FeishuChannel | null = null;
  const feishuCredentialsReady = !!(config.feishu.appId && config.feishu.appSecret);

  const feishuApps = getFeishuApps();
  const hasAnyFeishu = feishuCredentialsReady || Object.keys(feishuApps).length > 0;
  if (hasAnyFeishu) {
    feishuChannel = new FeishuChannel(
      config.feishu.appId,
      config.feishu.appSecret,
      config.feishu.domain as any,
    );
    // 连接默认应用（凭证不存在时 connect() 内部会 warn + 跳过）
    try {
      await feishuChannel.connect();
    } catch (err) {
      console.error('[SemaClaw] FeishuChannel connect failed, continuing without Feishu:', err);
      feishuChannel = null;
    }
    if (feishuChannel) {
      if (feishuChannel.isConnected()) {
        console.log('[SemaClaw] FeishuChannel connected');
      }
      // 加载额外飞书应用（子 agent 用）— 无论默认应用是否连接成功都执行
      for (const [appId, app] of Object.entries(feishuApps)) {
        await feishuChannel.addApp(appId, app.appSecret, app.domain as any);
      }
      if (Object.keys(feishuApps).length > 0) {
        console.log(`[SemaClaw] Loaded ${Object.keys(feishuApps).length} extra Feishu app(s)`);
      }
    }
  }

  // ===== 3.6 QQChannel =====
  let qqChannel: QQChannel | null = null;
  const qqApps = getQQApps();
  const hasAnyQQ = !!(config.qq.appId && config.qq.appSecret) || Object.keys(qqApps).length > 0;
  if (hasAnyQQ) {
    qqChannel = new QQChannel(config.qq.appId, config.qq.appSecret, config.qq.sandbox);
    try {
      await qqChannel.connect();
    } catch (err) {
      console.error('[SemaClaw] QQChannel connect failed, continuing without QQ:', err);
      qqChannel = null;
    }
    if (qqChannel) {
      if (qqChannel.isConnected()) {
        console.log('[SemaClaw] QQChannel connected');
      }
      // 加载额外 QQ app（子 agent 用）— 无论主 app 是否连接成功都执行
      for (const [appId, app] of Object.entries(qqApps)) {
        qqChannel.addApp(appId, app.appSecret, app.sandbox);
      }
      if (Object.keys(qqApps).length > 0) {
        console.log(`[SemaClaw] Loaded ${Object.keys(qqApps).length} extra QQ app(s)`);
      }
    }
  }

  // ===== 3.7 WeChatChannel =====
  // 支持两种模式：
  //   a) env-only 主 bot（WECHAT_ENABLED=true），accountId='default'，JID 扫码后直接注册
  //   b) CLI 多 bot（config.json wechatAccounts），accountId=folder，JID 通过 pending 迁移
  const wechatChannels: WeChatChannel[] = [];

  async function connectWechatAccount(accountId: string, agentFolder: string): Promise<WeChatChannel | null> {
    const ch = new WeChatChannel(accountId, config.wechat.apiBaseUrl);
    try {
      await ch.connect();
    } catch (err) {
      console.error(`[SemaClaw] WeChatChannel(${accountId}) connect failed:`, err);
      return null;
    }
    if (!ch.isConnected()) return null;
    console.log(`[SemaClaw] WeChatChannel(${accountId}) connected`);
    // env-only 主 bot：扫码后立即绑定真实 JID；CLI bot 则等待首条消息完成 pending 迁移
    if (accountId === 'default') {
      const ownerJid = ch.getOwnerJid();
      if (ownerJid) {
        ensureWechatAdminGroup(groupManager, ownerJid, agentFolder);
      } else {
        console.warn(`[SemaClaw] WeChat(${accountId}): 未找到 ownerJid，将在首条消息到达后自动绑定`);
      }
    }
    return ch;
  }

  // a) env-only 主 bot
  if (config.wechat.enabled) {
    const ch = await connectWechatAccount('default', config.wechat.agentFolder);
    if (ch) wechatChannels.push(ch);
  }

  // b) CLI 多 bot
  const wechatAccountsCfg = getWechatAccounts();
  for (const [folder] of Object.entries(wechatAccountsCfg)) {
    const ch = await connectWechatAccount(folder, folder);
    if (ch) wechatChannels.push(ch);
  }
  if (wechatChannels.length > 0) {
    console.log(`[SemaClaw] ${wechatChannels.length} WeChatChannel(s) active`);
  }

  // ===== 4. channels + sendReply =====
  const channels = ([telegramChannel, feishuChannel, qqChannel] as Array<TelegramChannel | FeishuChannel | QQChannel | WeChatChannel | null>)
    .concat(wechatChannels)
    .filter((ch): ch is TelegramChannel | FeishuChannel | QQChannel | WeChatChannel => ch !== null);

  // 汇总 channel 连接状态
  const connectedChannels = channels.filter(ch => ch.isConnected());
  if (connectedChannels.length === 0) {
    console.warn('[SemaClaw] 所有 channel 均未连接，以 WebUI-only 模式运行。');
    console.warn('[SemaClaw] Agent 仍可通过 WebUI 触发，网络恢复后重启即可重新建连。');
  } else {
    console.log(`[SemaClaw] ${connectedChannels.length} channel(s) connected`);
  }

  /**
   * 懒建连飞书：运行时注册了 feishu 群组时调用。
   * 幂等 — 已连接时直接返回现有实例。
   */
  const ensureFeishuChannel = async (): Promise<FeishuChannel | null> => {
    if (feishuChannel?.isConnected()) return feishuChannel;
    // 无默认凭证但已有 channel 实例（extra apps only），直接返回
    if (feishuChannel) return feishuChannel;
    if (!feishuCredentialsReady) return null;
    feishuChannel = new FeishuChannel(
      config.feishu.appId,
      config.feishu.appSecret,
      config.feishu.domain as any,
    );
    try {
      await feishuChannel.connect();
    } catch (err) {
      console.error('[SemaClaw] FeishuChannel lazy connect failed:', err);
      feishuChannel = null;
      return null;
    }
    if (feishuChannel) {
      // 动态加入 channels 数组（MessageRouter / PermissionBridge 共享引用）
      channels.push(feishuChannel);
      // 加载额外飞书应用
      const feishuApps = getFeishuApps();
      for (const [appId, app] of Object.entries(feishuApps)) {
        await feishuChannel.addApp(appId, app.appSecret, app.domain);
      }
      console.log('[SemaClaw] FeishuChannel lazy connected');
    }
    return feishuChannel;
  };

  const sendReply = async (chatJid: string, text: string, botToken?: string): Promise<void> => {
    const channel = channels.find((ch) => ch.ownsJid(chatJid));
    if (channel) {
      await channel.sendMessage(chatJid, text, botToken);
    }
  };

  // ===== 5. AgentPool =====
  const agentPool = new AgentPool(
    sendReply,
    channels,
  );

  // ===== 6. GroupQueue =====
  const groupQueue = new GroupQueue();

  // ===== 7. MessageRouter =====
  const messageRouter = new MessageRouter(
    groupManager,
    agentPool,
    groupQueue,
    channels,
    config.wechat.agentFolder,
  );
  messageRouter.start();
  console.log('[SemaClaw] MessageRouter started');

  // ===== 8. TaskScheduler =====
  const taskScheduler = new TaskScheduler(agentPool, groupQueue, groupManager);
  taskScheduler.start();

  // ===== 9. DispatchBridge =====
  const dispatchBridge = new DispatchBridge(
    config.paths.dispatchStatePath,
    (jid, taskId, prompt, workspaceDir) => {
      agentPool.setDispatchWorkspace(jid, workspaceDir);
      agentPool.setCurrentDispatchTaskId(jid, taskId);
      messageRouter.dispatchTask(jid, prompt, {
        onStarted: () => agentPool.markDispatchExecuting(jid),
        onCompleted: () => {
          agentPool.notifyDispatchIfPending(jid, taskId);
          agentPool.clearDispatchExecuting(jid);
        },
      });
    },
    (jid) => agentPool.revertDispatchWorkspace(jid),
  );
  dispatchBridge.start();

  // ===== 9.1 虚拟 Agent 注入（Phase 2 DAG 集成）=====
  const personaRegistry = new PersonaRegistry(config.paths.virtualAgentsDir);
  const virtualWorkerPool = new VirtualWorkerPool();
  dispatchBridge.setVirtualWorkerPool(personaRegistry, virtualWorkerPool);

  agentPool.setGroupQueue(groupQueue);
  agentPool.setDispatchBridge(dispatchBridge);
  groupManager.setOnGroupsChanged(() => dispatchBridge.updateAgents(groupManager.list()));
  // 初始化一次 agents 列表
  dispatchBridge.updateAgents(groupManager.list());

  // ===== 11. WebSocket Gateway + UI Server =====
  const wsGateway = new WebSocketGateway(groupManager, agentPool, groupQueue);
  wsGateway.start();
  agentPool.setAgentEventSink(wsGateway);
  dispatchBridge.setWsNotify(parents => wsGateway.notifyDispatchUpdate(parents));
  // 虚拟 agent todos 推送到 WsGateway
  virtualWorkerPool.setTodosNotify((jid, name, todos) => wsGateway.notifyAgentTodos(jid, name, todos));
  wsGateway.setDispatchBridgeGetter(() => dispatchBridge.getParents());
  wsGateway.setAgentTodosGetter(() => agentPool.getAllCachedTodos());
  messageRouter.setWsGateway(wsGateway);
  taskScheduler.setWsGateway(wsGateway);
  wsGateway.setTelegramChannel(telegramChannel);
  wsGateway.setEnsureFeishuChannel(ensureFeishuChannel);
  if (qqChannel) wsGateway.setQQChannel(qqChannel);
  messageRouter.setOnJidMigrated((oldJid, newBinding) => {
    wsGateway.notifyGroupMigrated(oldJid, newBinding);
  });

  const wikiManager = new WikiManager(config.paths.wikiDir);
  await wikiManager.ensureInit();
  console.log(`[SemaClaw] WikiManager initialized: ${config.paths.wikiDir}`);

  const uiServer = new UIServer(agentPool);
  uiServer.setWikiManager(wikiManager);
  await uiServer.start();

  console.log('[SemaClaw] Ready');

  // ===== 10. 优雅关闭 =====
  const shutdown = async (signal: string): Promise<void> => {
    console.log(`\n[SemaClaw] Received ${signal}, shutting down...`);

    taskScheduler.stop();

    try {
      await telegramChannel.disconnect();
    } catch (err) {
      console.error('[SemaClaw] Error disconnecting TelegramChannel:', err);
    }

    if (feishuChannel) {
      try {
        await feishuChannel.disconnect();
      } catch (err) {
        console.error('[SemaClaw] Error disconnecting FeishuChannel:', err);
      }
    }

    if (qqChannel) {
      try {
        await qqChannel.disconnect();
      } catch (err) {
        console.error('[SemaClaw] Error disconnecting QQChannel:', err);
      }
    }

    for (const ch of wechatChannels) {
      try {
        await ch.disconnect();
      } catch (err) {
        console.error(`[SemaClaw] Error disconnecting WeChatChannel(${ch.accountId}):`, err);
      }
    }

    try {
      await agentPool.destroyAll();
    } catch (err) {
      console.error('[SemaClaw] Error destroying AgentPool:', err);
    }

    try {
      await wsGateway.stop();
    } catch (err) {
      console.error('[SemaClaw] Error stopping WsGateway:', err);
    }

    try {
      await uiServer.stop();
    } catch (err) {
      console.error('[SemaClaw] Error stopping UIServer:', err);
    }

    console.log('[SemaClaw] Shutdown complete');
    process.exit(0);
  };

  process.once('SIGINT', () => shutdown('SIGINT'));
  process.once('SIGTERM', () => shutdown('SIGTERM'));
}

main().catch((err) => {
  console.error('[SemaClaw] Fatal error during startup:', err);
  process.exit(1);
});
