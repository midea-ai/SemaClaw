/**
 * Feishu SDK 封装 — 管理 Lark.Client / WSClient / EventDispatcher 的创建
 *
 * 参考：clawdbot-feishu/src/client.ts + probe.ts
 */

import * as Lark from '@larksuiteoapi/node-sdk';

// ===== 类型 =====

export type FeishuDomain = 'feishu' | 'lark' | (string & {});

export interface FeishuAppCredentials {
  appId: string;
  appSecret: string;
  domain?: FeishuDomain;
}

export interface FeishuBotInfo {
  openId: string;
  name: string;
}

// ===== Domain 解析 =====

function resolveDomain(domain: FeishuDomain | undefined): Lark.Domain | string {
  if (domain === 'lark') return Lark.Domain.Lark;
  if (domain === 'feishu' || !domain) return Lark.Domain.Feishu;
  return domain.replace(/\/+$/, '');
}

// ===== Client 缓存 =====

const clientCache = new Map<string, { client: Lark.Client; appId: string; appSecret: string; domain?: FeishuDomain }>();

/**
 * 创建或获取缓存的 Lark.Client（REST API 用）。
 * 以 appId 为缓存 key。
 */
export function createFeishuClient(creds: FeishuAppCredentials): Lark.Client {
  const { appId, appSecret, domain } = creds;
  if (!appId || !appSecret) {
    throw new Error(`Feishu credentials not configured (appId=${appId})`);
  }

  const cached = clientCache.get(appId);
  if (cached && cached.appSecret === appSecret && cached.domain === domain) {
    return cached.client;
  }

  const client = new Lark.Client({
    appId,
    appSecret,
    appType: Lark.AppType.SelfBuild,
    domain: resolveDomain(domain),
  });

  clientCache.set(appId, { client, appId, appSecret, domain });
  return client;
}

/**
 * 创建 Lark.WSClient（不缓存，每次新建连接）。
 */
export function createFeishuWSClient(creds: FeishuAppCredentials): Lark.WSClient {
  const { appId, appSecret, domain } = creds;
  if (!appId || !appSecret) {
    throw new Error(`Feishu credentials not configured (appId=${appId})`);
  }

  const shortId = appId.slice(-8);
  return new Lark.WSClient({
    appId,
    appSecret,
    domain: resolveDomain(domain),
    loggerLevel: Lark.LoggerLevel.debug,
    logger: {
      debug: (...args: unknown[]) => console.debug(`[LarkWS:${shortId}]`, ...args),
      info: (...args: unknown[]) => console.log(`[LarkWS:${shortId}]`, ...args),
      warn: (...args: unknown[]) => console.warn(`[LarkWS:${shortId}]`, ...args),
      error: (...args: unknown[]) => console.error(`[LarkWS:${shortId}]`, ...args),
      trace: (...args: unknown[]) => console.debug(`[LarkWS:${shortId}][trace]`, ...args),
    },
  } as any);
}

/**
 * 创建 EventDispatcher（WS 模式下 encryptKey/verificationToken 可不传）。
 */
export function createEventDispatcher(opts?: {
  encryptKey?: string;
  verificationToken?: string;
}): Lark.EventDispatcher {
  return new Lark.EventDispatcher({
    encryptKey: opts?.encryptKey ?? '',
    verificationToken: opts?.verificationToken ?? '',
  });
}

/**
 * 通过 /bot/v3/info 获取 Bot 的 open_id 和名称。
 */
export async function fetchBotInfo(client: Lark.Client): Promise<FeishuBotInfo> {
  const response = await (client as any).request({
    method: 'GET',
    url: '/open-apis/bot/v3/info',
    data: {},
  });

  const bot = response.bot ?? response.data?.bot;
  if (!bot?.open_id) {
    throw new Error(`Failed to fetch bot info: ${response.msg ?? 'unknown error'}`);
  }

  return {
    openId: bot.open_id,
    name: bot.bot_name ?? 'Feishu Bot',
  };
}
