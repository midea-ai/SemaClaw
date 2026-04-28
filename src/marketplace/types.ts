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
export interface MarketplaceSourceItemState {
  plugins: Record<string, boolean>;
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
  // detailed sub-items (for expanded view)
  skills: MarketplacePluginSkill[];
  subagents: MarketplacePluginSubagent[];
}

export interface MarketplaceSourceInfo extends MarketplaceSource {
  plugins: MarketplacePlugin[];
}
