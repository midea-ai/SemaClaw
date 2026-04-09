/**
 * SendBridge — 本地 HTTP 服务，供 send-server MCP 子进程调用
 *
 * 解决问题：MCP 子进程无法直接访问主进程的 IChannel 实例。
 * send-server 向 http://127.0.0.1:{port}/send POST 请求，
 * SendBridge 收到后通过注入的回调路由到对应 Channel 发出。
 *
 * 安全：监听 127.0.0.1 loopback，不对外暴露，无需鉴权。
 * 端口：OS 随机分配（port=0），启动后通过 bridge.port 获取。
 */

import * as http from 'http';

/** 发送文本消息的回调（与 AgentPool.SendReply 签名一致） */
export type SendMessageFn = (chatJid: string, text: string, botToken?: string) => Promise<void>;

/** 发送本地文件的回调 */
export type SendFileFn = (chatJid: string, filePath: string, caption?: string, botToken?: string) => Promise<void>;

/** POST /send 的请求体 */
type SendRequest =
  | { type: 'message'; chatJid: string; text: string; botToken?: string }
  | { type: 'file'; chatJid: string; filePath: string; caption?: string; botToken?: string };

export class SendBridge {
  private server: http.Server;
  private _port = 0;

  constructor(
    private readonly sendMessage: SendMessageFn,
    private readonly sendFile: SendFileFn,
  ) {
    this.server = http.createServer((req, res) => {
      this.handleRequest(req, res).catch((err) => {
        console.error('[SendBridge] Unhandled error:', err);
        res.writeHead(500).end(JSON.stringify({ ok: false, error: String(err) }));
      });
    });
  }

  /** 启动服务，监听随机端口 */
  async start(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.server.listen(0, '127.0.0.1', () => {
        const addr = this.server.address();
        if (addr && typeof addr === 'object') {
          this._port = addr.port;
          console.log(`[SendBridge] Listening on 127.0.0.1:${this._port}`);
        }
        resolve();
      });
      this.server.once('error', reject);
    });
  }

  async stop(): Promise<void> {
    return new Promise((resolve) => this.server.close(() => resolve()));
  }

  get port(): number {
    return this._port;
  }

  // ===== Internal =====

  private async handleRequest(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    if (req.method !== 'POST' || req.url !== '/send') {
      res.writeHead(404).end(JSON.stringify({ ok: false, error: 'Not found' }));
      return;
    }

    const body = await readBody(req);
    let payload: SendRequest;
    try {
      payload = JSON.parse(body) as SendRequest;
    } catch {
      res.writeHead(400).end(JSON.stringify({ ok: false, error: 'Invalid JSON' }));
      return;
    }

    try {
      if (payload.type === 'message') {
        await this.sendMessage(payload.chatJid, payload.text, payload.botToken);
      } else if (payload.type === 'file') {
        await this.sendFile(payload.chatJid, payload.filePath, payload.caption, payload.botToken);
      } else {
        res.writeHead(400).end(JSON.stringify({ ok: false, error: 'Unknown type' }));
        return;
      }
      res.writeHead(200).end(JSON.stringify({ ok: true }));
    } catch (err) {
      res.writeHead(500).end(JSON.stringify({ ok: false, error: String(err) }));
    }
  }
}

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}
