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

export interface ImageAttachment {
  dataUrl: string;
  mimeType: string;
}

export interface TextMessage {
  id: string;
  role: 'user' | 'agent' | 'other';
  senderName?: string;
  text: string;
  attachments?: ImageAttachment[];
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

// ===== FormUI =====

export interface FormFieldOption {
  label: string;
  value: string;
}

export interface FormTableColumn {
  key: string;
  label: string;
  type?: 'text' | 'number';
}

interface FormFieldBase {
  key: string;
  label: string;
  required?: boolean;
  help?: string;
}

/** 封闭组件目录的 TS 镜像（与 sema-core events/types.ts 的 FormField 对齐） */
export type FormFieldDef =
  | (FormFieldBase & { type: 'text'; placeholder?: string; maxLength?: number; default?: string })
  | (FormFieldBase & { type: 'textarea'; placeholder?: string; maxLength?: number; rows?: number; default?: string })
  | (FormFieldBase & { type: 'number'; min?: number; max?: number; step?: number; default?: number })
  | (FormFieldBase & { type: 'slider'; min: number; max: number; step?: number; default?: number })
  | (FormFieldBase & { type: 'select'; options: FormFieldOption[]; default?: string })
  | (FormFieldBase & { type: 'radio'; options: FormFieldOption[]; default?: string })
  | (FormFieldBase & { type: 'multiselect'; options: FormFieldOption[]; default?: string[] })
  | (FormFieldBase & { type: 'checkbox'; default?: boolean })
  | (FormFieldBase & { type: 'date'; min?: string; max?: string; default?: string })
  | { type: 'static_text'; text: string; variant?: 'heading' | 'body' | 'divider' }
  | (FormFieldBase & { type: 'editable_table'; columns: FormTableColumn[]; rows?: Record<string, string | number>[]; allowAddRow?: boolean });

export interface FormMessage {
  id: string;
  role: 'form';
  requestId: string;
  agentId: string;
  title: string;
  surface: 'inline' | 'dock';
  submitLabel: string;
  fields: FormFieldDef[];
  /** 受控编辑中的当前值（挂载时按 field.default seed） */
  values: Record<string, unknown>;
  resolved: boolean;
  timestamp: string;
}

export type ChatMessage = TextMessage | PermissionMessage | QuestionMessage | FormMessage;

export type AgentState = 'idle' | 'processing' | string;

export type WsStatus = 'connecting' | 'connected' | 'disconnected';

// ===== Dispatch types (multi-agent console) =====

export type TaskStatus = 'registered' | 'processing' | 'done' | 'error' | 'timeout';

export interface DispatchTask {
  id: string;
  label: string;
  agentId: string;   // 持久: folder, 虚拟: "persona:code-reviewer"
  agentJid: string;  // 持久: jid,    虚拟: ""
  dependsOn: string[];
  status: TaskStatus;
  prompt: string;
  result: string | null;
  createdAt: string;
  startedAt: string | null;
  timeoutAt: string;
  completedAt: string | null;
  /** 是否为虚拟 agent 任务 */
  isVirtual?: boolean;
  /** 虚拟 agent 的人设名称 */
  personaName?: string;
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

// ===== Workbench (LaunchUI) =====

export interface WorkbenchFile {
  path: string;
  hash: string;
  extension: 'html' | 'md';
}

export interface WorkbenchProcess {
  pid: number;
  status: 'running' | 'stopped' | 'crashed';
  lastActive: number;
  logPath: string;
}

export interface WorkbenchArtifact {
  id: string;
  instanceId: string;
  agentId: string;
  mode: 'static' | 'web' | 'backend';
  title: string;
  createdAt: number;
  files?: WorkbenchFile[];
  url?: string;
  usage?: string;
  process?: WorkbenchProcess;
}

/** 工作台前端状态：每 groupJid 一份 */
export interface WorkbenchState {
  current: WorkbenchArtifact | null;
  history: WorkbenchArtifact[];  // 不含 current（current 单独存）
}

// ===== Workflow（独立 dock，全局；镜像后端 src/workflow/types.ts） =====

export interface WorkflowDefSummary {
  name: string;
  description?: string;
  stepCount: number;
  inputs: { name: string; required?: boolean; default?: string }[];
  /** workflow 级 guidance（可编辑） */
  guidance?: string;
  /** 自定义 workspace 目录（可编辑；空 = 默认 <dataDir>/<name>/） */
  workspace?: string;
  /** 各 step 的 def 模板原始值（可编辑，非 run 渲染快照） */
  steps: { id: string; kind: 'agent' | 'script'; guidance?: string; timeout?: number }[];
}

export type WfStepStatus = 'pending' | 'running' | 'done' | 'failed' | 'skipped';
export type WorkflowRunStatus = 'running' | 'done' | 'partial-failed' | 'cancelled' | 'interrupted';

export interface WfObserveOutput {
  label: string;
  as: 'inline' | 'artifact';
  content?: string;
  artifactPath?: string;
}

export interface WorkflowStepRun {
  id: string;
  kind: 'agent' | 'script';
  persona?: string;
  dependsOn?: string[];
  status: WfStepStatus;
  result: string;
  error?: string;
  observe?: WfObserveOutput;
  guidanceSnapshot?: string;
  startedAt?: string;
  completedAt?: string;
}

export interface WorkflowRun {
  id: string;
  workflowName: string;
  inputs: Record<string, string>;
  status: WorkflowRunStatus;
  runDir: string;
  steps: WorkflowStepRun[];
  trigger?: string;
  createdAt: string;
  completedAt?: string;
}
