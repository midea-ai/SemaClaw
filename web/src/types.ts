export interface GroupInfo {
  jid: string;
  folder: string;
  name: string;
  isAdmin: boolean;
  channel: string;
  requiresTrigger: boolean;
  allowedTools: string[] | null;
  allowedWorkDirs: string[] | null;
  botToken: string | null;
  maxMessages: number | null;
}

export interface RegisterGroupPayload {
  jid?: string;  // 飞书 pending 绑定可留空，后端自动生成 feishu:pending:{appId}
  folder: string;
  name: string;
  channel?: 'telegram' | 'feishu' | 'whatsapp' | 'qq';
  requiresTrigger?: boolean;
  allowedWorkDirs?: string[] | null;
  botToken?: string | null;
}

export interface UpdateGroupPayload {
  name?: string;
  requiresTrigger?: boolean;
  allowedWorkDirs?: string[] | null;
  botToken?: string | null;
}

// ===== Message types =====

export interface TextMessage {
  id: string;
  role: 'user' | 'agent' | 'other';
  senderName?: string;
  text: string;
  timestamp: string;
}

export interface PermissionMessage {
  id: string;
  role: 'permission';
  requestId: string;
  toolName: string;
  title: string;
  content: string;
  options: { key: string; label: string }[];
  /** Set when resolved: which option was chosen */
  resolved?: { key: string; label: string };
  timestamp: string;
}

export interface QuestionItem {
  question: string;
  header: string;
  options: { label: string; description?: string }[];
  multiSelect?: boolean;
}

export interface QuestionMessage {
  id: string;
  role: 'question';
  requestId: string;
  agentId: string;
  questions: QuestionItem[];
  /** qi → oi (single) or oi[] (multi), filled as user selects. -1 = Other */
  selections: Record<number, number | number[]>;
  /** qi → user-typed text for "Other" option */
  otherTexts?: Record<number, string>;
  resolved: boolean;
  timestamp: string;
}

export type ChatMessage = TextMessage | PermissionMessage | QuestionMessage;

export type AgentState = 'idle' | 'processing' | string;

export type WsStatus = 'connecting' | 'connected' | 'disconnected';

// ===== Dispatch types (multi-agent console) =====

export type TaskStatus = 'registered' | 'processing' | 'done' | 'error' | 'timeout';

export interface DispatchTask {
  id: string;
  label: string;
  agentId: string;   // folder name (e.g. "web-backend")
  agentJid: string;
  dependsOn: string[];
  status: TaskStatus;
  prompt: string;
  result: string | null;
  createdAt: string;
  startedAt: string | null;
  timeoutAt: string;
  completedAt: string | null;
}

export interface DispatchParent {
  id: string;
  adminFolder: string;
  sharedWorkspace: string | null;
  goal: string;
  status: 'queued' | 'active' | 'done';
  createdAt: string;
  completedAt: string | null;
  tasks: DispatchTask[];
}

export interface AgentTodoItem {
  content: string;
  status: 'pending' | 'in_progress' | 'completed';
  activeForm?: string;
}

export interface AgentTodosEntry {
  agentName: string;
  todos: AgentTodoItem[];
}
