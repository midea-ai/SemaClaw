import * as path from 'path';
import * as os from 'os';
import * as dotenv from 'dotenv';


dotenv.config();

const home = os.homedir();

const env = (key: string, fallback?: string): string => {
  const val = process.env[key] ?? fallback;
  if (val === undefined) throw new Error(`Missing required env var: ${key}`);
  return val;
};

const envOptional = (key: string, fallback: string): string =>
  process.env[key] ?? fallback;

const envInt = (key: string, fallback: number): number =>
  parseInt(process.env[key] ?? String(fallback), 10);

export const config = {
  telegram: {
    botToken: envOptional('TELEGRAM_BOT_TOKEN', ''),
    /** 主 Bot 绑定的 agent folder（默认 main） */
    agentFolder: envOptional('TELEGRAM_AGENT_FOLDER', 'main'),
  },

  feishu: {
    appId: envOptional('FEISHU_APP_ID', ''),
    appSecret: envOptional('FEISHU_APP_SECRET', ''),
    domain: envOptional('FEISHU_DOMAIN', 'feishu'),
  },

  qq: {
    appId: envOptional('QQ_APP_ID', ''),
    appSecret: envOptional('QQ_APP_SECRET', ''),
    /** true = 沙箱环境（QQ 开放平台测试用） */
    sandbox: envOptional('QQ_SANDBOX', 'false') === 'true',
  },

  wechat: {
    /** true = 启用微信 iLink Bot 频道 */
    enabled: envOptional('WECHAT_ENABLED', 'false') === 'true',
    /** iLink API base URL，通常无需修改 */
    apiBaseUrl: envOptional('WECHAT_API_BASE_URL', 'https://ilinkai.weixin.qq.com'),
    /** 绑定到哪个 agent folder（默认 main） */
    agentFolder: envOptional('WECHAT_AGENT_FOLDER', 'main'),
  },

  admin: {
    telegramUserId: envOptional('ADMIN_TELEGRAM_USER_ID', ''),
    feishuOpenId: envOptional('ADMIN_FEISHU_OPEN_ID', ''),
  },

  agent: {
    maxConcurrent: envInt('MAX_CONCURRENT_AGENTS', 5),
    maxMessagesPerGroup: envInt('MAX_MESSAGES_PER_GROUP', 100),
  },

  scheduler: {
    intervalSec: envInt('SCHEDULER_INTERVAL_SEC', 60),
    /** notify 模式任务：超过此时长（分钟）未发出则丢弃，避免机器重启后发出过期通知 */
    notifyMaxDelayMinutes: envInt('NOTIFY_MAX_DELAY_MINUTES', 30),
  },

  paths: {
    /**
     * ~/.semaclaw/semaclaw.db — 持久化存储（DB、router state 等）
     */
    dbPath: path.resolve(
      envOptional('DB_PATH', path.join(home, '.semaclaw', 'semaclaw.db'))
    ),
    /**
     * ~/semaclaw/agents/{folder}/ — agentDataDir
     * 存放 agent 人格文件（CLAUDE.md/soul）、memory/、.sema/sessions/
     */
    agentsDir: path.resolve(
      envOptional('AGENTS_DIR', path.join(home, 'semaclaw', 'agents'))
    ),
    /**
     * ~/semaclaw/workspace/{folder}/ — 默认工作目录
     * 存放项目相关文档，agent 无明确项目上下文时在此工作
     */
    workspaceDir: path.resolve(
      envOptional('WORKSPACE_DIR', path.join(home, 'semaclaw', 'workspace'))
    ),
    /**
     * ~/.semaclaw/config.json — 全局配置
     * 用户可编辑，存放 allowedWorkDirs 等 per-agent 配置；启动时覆盖 DB 对应字段
     */
    globalConfigPath: path.resolve(
      envOptional('SEMACLAW_CONFIG_PATH', path.join(home, '.semaclaw', 'config.json'))
    ),
    /**
     * ~/.semaclaw/dispatch-state.json — 主 Agent 任务调度状态文件
     * 存放可用 agent 列表 + 待执行/执行中/已完成的 dispatch 任务
     */
    dispatchStatePath: path.resolve(
      envOptional('SEMACLAW_DISPATCH_STATE_PATH', path.join(home, '.semaclaw', 'dispatch-state.json'))
    ),
    /**
     * ~/.semaclaw/managed/skills — ClaWHub 安装的 skills
     * 由 `semaclaw clawhub install` 管理，对所有群组 agent 可见
     */
    managedSkillsDir: path.resolve(
      envOptional('MANAGED_SKILLS_DIR', path.join(home, '.semaclaw', 'managed', 'skills'))
    ),
    /**
     * ~/semaclaw/wiki/ — 个人知识库目录（独立 git repo）
     */
    wikiDir: path.resolve(
      envOptional('WIKI_DIR', path.join(home, 'semaclaw', 'wiki'))
    ),
    /**
     * <packageRoot>/skills — semaclaw 内置 bundled skills
     * 随包分发，优先级最低（用户 skills 可覆盖）。
     * 可通过 SEMACLAW_BUNDLED_SKILLS_DIR env 覆盖（开发/测试用）。
     */
    bundledSkillsDir: (() => {
      const raw = envOptional('SEMACLAW_BUNDLED_SKILLS_DIR', path.join(__dirname, '..', 'skills'))
      return raw.trim() ? path.resolve(raw) : ''
    })(),
  },
  memory: {
    /** Embedding 提供商：none=纯FTS, openai/openrouter/ollama/local=混合搜索 */
    embeddingProvider: envOptional('SEMACLAW_EMBEDDING_PROVIDER', 'none') as 'none' | 'openai' | 'openrouter' | 'ollama' | 'local',
    openaiApiKey: envOptional('SEMACLAW_OPENAI_API_KEY', ''),
    openaiBaseUrl: envOptional('SEMACLAW_OPENAI_BASE_URL', 'https://api.openai.com/v1'),
    openaiModel: envOptional('SEMACLAW_OPENAI_MODEL', 'text-embedding-3-small'),
    openrouterApiKey: envOptional('SEMACLAW_OPENROUTER_API_KEY', ''),
    openrouterBaseUrl: envOptional('SEMACLAW_OPENROUTER_BASE_URL', 'https://openrouter.ai/api/v1'),
    openrouterModel: envOptional('SEMACLAW_OPENROUTER_MODEL', 'openai/text-embedding-3-small'),
    ollamaBaseUrl: envOptional('SEMACLAW_OLLAMA_BASE_URL', 'http://localhost:11434'),
    ollamaModel: envOptional('SEMACLAW_OLLAMA_MODEL', 'nomic-embed-text'),
    localModelPath: envOptional('SEMACLAW_LOCAL_MODEL_PATH', ''),
    localModel: envOptional('SEMACLAW_LOCAL_MODEL', ''),
    /**
     * 向量维度。通常无需手动设置，系统按 provider 自动选择默认值：
     *   openai=1536, openrouter=1536, ollama=1536, local=384
     * 使用非默认模型时需显式设置，例如 text-embedding-3-large=3072。
     */
    embeddingDimensions: envInt('SEMACLAW_EMBEDDING_DIMENSIONS', 0),
    /** 分块大小（token 数） */
    chunkSize: envInt('SEMACLAW_CHUNK_SIZE', 400),
    /** 分块重叠（token 数） */
    chunkOverlap: envInt('SEMACLAW_CHUNK_OVERLAP', 80),
    /** pre-retrieval 最大返回条数（默认 5） */
    searchMaxResults: envInt('SEMACLAW_SEARCH_MAX_RESULTS', 5),
    /** pre-retrieval 最低分数阈值，低于此分数的结果不注入 prompt（默认 0.5） */
    searchMinScore: parseFloat(process.env.SEMACLAW_SEARCH_MIN_SCORE ?? '0.5'),
    /** 是否启用 pre-retrieval 注入（每条消息前自动搜索记忆注入 prompt） */
    preRetrieval: envOptional('SEMACLAW_PRE_RETRIEVAL', 'false') === 'true',
  },
} as const;
