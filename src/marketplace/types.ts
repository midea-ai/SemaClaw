export interface MarketplaceSource {
  id: string;
  name: string;
  type: 'git' | 'local';
  url?: string;          // git only
  branch?: string;       // git only, default 'main'
  localPath: string;     // resolved local filesystem path
  priority: number;      // 1 = highest priority
  enabled: boolean;
  lastSynced: string | null;
  syncError?: string;
}

// Plugin-level toggle state: plugins[name] = true → enabled; absent = disabled (default-off)
// mcpUseTools key: `${pluginName}/${serverName}` → string[] to allowlist tools, null to clear override
export interface MarketplaceSourceItemState {
  plugins: Record<string, boolean>;
  mcpUseTools?: Record<string, string[] | null>;
}

export interface MarketplaceConfig {
  sources: MarketplaceSource[];
}

export interface MarketplaceStateFile {
  [sourceId: string]: MarketplaceSourceItemState;
}

// ── API response types ─────────────────────────────────────────────────────────

export interface MarketplacePluginSkill {
  name: string;
  description: string;
  disabled: boolean; // from disabled-skills.json
}

export interface MarketplacePluginSubagent {
  name: string;
  description: string;
  disabled: boolean; // from disabled-subagents.json
}

export interface MarketplacePluginMCPServer {
  name: string;
  transport: string;
  description?: string;
  useTools: string[] | null; // null = all tools; string[] = allowlist (user override or plugin default)
}

export interface MarketplacePlugin {
  name: string;
  description: string;
  version?: string;
  author?: string;
  keywords?: string[];
  dir: string;
  sourceId: string;
  sourceName: string;
  priority: number;
  enabled: boolean;
  // content summary counts (for collapsed view)
  skillCount: number;
  subagentCount: number;
  hasHooks: boolean;
  mcpServerCount: number;
  // detailed sub-items (for expanded view)
  skills: MarketplacePluginSkill[];
  subagents: MarketplacePluginSubagent[];
  mcpServers: MarketplacePluginMCPServer[];
}

export interface MarketplaceSourceInfo extends MarketplaceSource {
  plugins: MarketplacePlugin[];
}
