import { useCallback, useEffect, useRef, useState } from 'react';
import type { GroupInfo, ChatMessage, AgentState, WsStatus, PermissionMessage, QuestionMessage, FormMessage, RegisterGroupPayload, UpdateGroupPayload, DispatchParent, AgentTodosEntry, ImageAttachment, WorkbenchArtifact, WorkbenchState, WorkflowDefSummary, WorkflowRun } from '../types';

// ===== workbench 本地持久化（防止页面刷新丢失已 launch 的 UI tab）=====
// 仅前端持久化：daemon 仍存活时刷新页面完全恢复；daemon 重启后旧的 backend
// 服务进程已死，对应 artifact 仍显示但用户需手动关闭。
const WORKBENCH_STORAGE_KEY = 'semaclaw:workbench:v1';

function loadWorkbench(): Record<string, WorkbenchState> {
  try {
    const raw = window.localStorage.getItem(WORKBENCH_STORAGE_KEY);
    if (!raw) return {};
    return JSON.parse(raw) as Record<string, WorkbenchState>;
  } catch {
    return {};
  }
}

function saveWorkbench(state: Record<string, WorkbenchState>): void {
  try {
    window.localStorage.setItem(WORKBENCH_STORAGE_KEY, JSON.stringify(state));
  } catch {
    /* quota / private mode: 静默忽略，刷新不保留即可 */
  }
}

interface WsConfig {
  wsPort: number;
  token: string;
}

export interface WsHook {
  status: WsStatus;
  groups: GroupInfo[];
  messages: Record<string, ChatMessage[]>;
  agentStates: Record<string, AgentState>;
  /** jid → 是否正在压缩上下文（compacting 期间禁用暂停按钮） */
  agentCompacting: Record<string, boolean>;
  subscribed: Set<string>;
  subscribe: (jid: string) => void;
  sendMessage: (jid: string, text: string, attachments?: ImageAttachment[]) => void;
  /** 暂停 agent（发送 agent:control pause） */
  pauseAgent: (jid: string) => void;
  /** 继续 agent，可附加可选指示（发送 agent:control resume） */
  resumeAgent: (jid: string, query?: string) => void;
  /** 终止并重置 agent session（发送 agent:control stop） */
  stopAgent: (jid: string) => void;
  resolvePermission: (requestId: string, optionKey: string) => void;
  resolveQuestion: (requestId: string, answers: Record<number, number | number[]>, otherTexts?: Record<number, string>) => void;
  /** 提交 FormUI 表单（submitted=false 表示跳过） */
  resolveForm: (requestId: string, values: Record<string, unknown>, submitted: boolean) => void;
  /** jid → 当前活跃的 dock 表单（surface:'dock'） */
  formDock: Record<string, FormMessage | null>;
  /** 最新到达的 dock 表单，App 用于触发抢前台展开 workbench */
  formDockLatest: { jid: string; at: number } | null;
  registerGroup: (data: RegisterGroupPayload) => void;
  registerFeishuApp: (appId: string, appSecret: string, domain?: string) => void;
  registerQQApp: (appId: string, appSecret: string, sandbox?: boolean) => void;
  unregisterGroup: (jid: string) => void;
  updateGroup: (jid: string, updates: UpdateGroupPayload) => void;
  dispatchParents: DispatchParent[];
  agentTodos: Record<string, AgentTodosEntry>; // keyed by agentJid
  subscribeAll: () => void;
  // ===== Workbench (LaunchUI) =====
  /** jid → 工作台状态 */
  workbench: Record<string, WorkbenchState>;
  /** 最新到达的 (jid, artifactId)，前端用于触发抢前台 effect */
  workbenchLatest: { jid: string; artifactId: string; at: number } | null;
  /** 通知后端用户切到某工作台前台（更新 last_active） */
  workbenchMarkViewed: (jid: string, artifactId: string) => void;
  /** 关闭工作台（移出历史、杀进程） */
  workbenchClose: (jid: string, artifactId: string) => void;
  /** 请求读取 artifact 文件内容（请求-响应，返回 Promise） */
  workbenchReadFile: (jid: string, artifactId: string, path: string) => Promise<{ content?: string; error?: string }>;
  /** 取 service 类工作台的日志末尾 N 行 */
  workbenchFetchLogs: (jid: string, artifactId: string, tailLines?: number) => Promise<string>;
  /** 把 history 里的 artifact 提到 current（纯前端状态切换） */
  workbenchSetCurrent: (jid: string, artifactId: string) => void;
  // ===== Workflow（全局 dock） =====
  /** 可用 workflow 定义（摘要） */
  workflowDefs: WorkflowDefSummary[];
  /** 所有 run（最新在前） */
  workflowRuns: WorkflowRun[];
  /** 最近一次触发错误（如缺 required input），由 panel 展示后可忽略 */
  workflowError: string | null;
  /** 触发一次 run */
  workflowRun: (name: string, inputs: Record<string, string>) => void;
  /** 取消一次 run */
  workflowCancel: (runId: string) => void;
  /** 无损编辑定义（workflow.guidance / step.guidance / step.timeout），写回 .md */
  workflowEdit: (name: string, patch: { stepId?: string; guidance?: string; timeout?: number; workspace?: string }) => void;
  /** 主动刷新 defs + runs */
  workflowRefresh: () => void;
}

export function useWebSocket(): WsHook {
  const [status, setStatus]           = useState<WsStatus>('connecting');
  const [groups, setGroups]           = useState<GroupInfo[]>([]);
  const [messages, setMessages]       = useState<Record<string, ChatMessage[]>>({});
  const [agentStates, setAgentStates]       = useState<Record<string, AgentState>>({});
  const [agentCompacting, setAgentCompacting] = useState<Record<string, boolean>>({});
  const [subscribed, setSubscribed]   = useState<Set<string>>(new Set());
  const [dispatchParents, setDispatchParents] = useState<DispatchParent[]>([]);
  const [agentTodos, setAgentTodos]           = useState<Record<string, AgentTodosEntry>>({});
  const [workbench, setWorkbench]             = useState<Record<string, WorkbenchState>>(() => loadWorkbench());
  const [workbenchLatest, setWorkbenchLatest] = useState<{ jid: string; artifactId: string; at: number } | null>(null);
  /** jid → 当前活跃的 dock 表单（surface:'dock'），无则 null */
  const [formDock, setFormDock]               = useState<Record<string, FormMessage | null>>({});
  /** 最新到达的 dock 表单（jid + 时间戳），App 用于触发抢前台展开 */
  const [formDockLatest, setFormDockLatest]   = useState<{ jid: string; at: number } | null>(null);
  const [workflowDefs, setWorkflowDefs] = useState<WorkflowDefSummary[]>([]);
  const [workflowRuns, setWorkflowRuns] = useState<WorkflowRun[]>([]);
  const [workflowError, setWorkflowError] = useState<string | null>(null);

  // 把 workbench 状态镜像到 localStorage，刷新页面后从 loadWorkbench() 恢复
  useEffect(() => {
    saveWorkbench(workbench);
  }, [workbench]);

  /** workbench 请求-响应 (read_file / fetch_logs) 的 pending Map */
  const wbPendingRef = useRef<Map<string, (data: { content?: string; error?: string }) => void>>(new Map());

  const wsRef        = useRef<WebSocket | null>(null);
  const configRef    = useRef<WsConfig | null>(null);
  const reconnectRef = useRef<ReturnType<typeof setTimeout>>();
  const retryCountRef = useRef(0);
  const subscribedRef = useRef<Set<string>>(new Set());
  // jid → 全部完成后的延迟清除 timer
  const todosClearTimers = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());

  const addMessage = useCallback((jid: string, msg: ChatMessage) => {
    setMessages(prev => ({ ...prev, [jid]: [...(prev[jid] ?? []), msg] }));
  }, []);

  const updateMessage = useCallback((jid: string, id: string, updater: (m: ChatMessage) => ChatMessage) => {
    setMessages(prev => ({
      ...prev,
      [jid]: (prev[jid] ?? []).map(m => m.id === id ? updater(m) : m),
    }));
  }, []);

  const rawSend = useCallback((data: object) => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify(data));
    }
  }, []);

  const subscribe = useCallback((jid: string) => {
    rawSend({ type: 'subscribe', groupJid: jid });
    subscribedRef.current.add(jid);
    setSubscribed(prev => new Set([...prev, jid]));
  }, [rawSend]);

  // ===== Workflow sends =====
  const workflowRefresh = useCallback(() => {
    rawSend({ type: 'workflow:list' });
    rawSend({ type: 'workflow:runs' });
  }, [rawSend]);

  const workflowRun = useCallback((name: string, inputs: Record<string, string>) => {
    setWorkflowError(null);
    rawSend({ type: 'workflow:run', requestId: `wf-${Date.now()}`, name, inputs });
  }, [rawSend]);

  const workflowCancel = useCallback((runId: string) => {
    rawSend({ type: 'workflow:cancel', runId });
  }, [rawSend]);

  const workflowEdit = useCallback((name: string, patch: { stepId?: string; guidance?: string; timeout?: number; workspace?: string }) => {
    setWorkflowError(null);
    rawSend({ type: 'workflow:edit', requestId: `wfe-${Date.now()}`, name, ...patch });
  }, [rawSend]);

  const sendMessage = useCallback((jid: string, text: string, attachments?: ImageAttachment[]) => {
    addMessage(jid, {
      id:          `local-${Date.now()}`,
      role:        'user',
      text,
      attachments: attachments?.length ? attachments : undefined,
      timestamp:   new Date().toISOString(),
    });
    const wsAttachments = attachments?.length
      ? attachments.map(a => ({ type: 'image', url: a.dataUrl, mimeType: a.mimeType }))
      : undefined;
    rawSend({ type: 'message', groupJid: jid, text, ...(wsAttachments ? { attachments: wsAttachments } : {}) });
  }, [addMessage, rawSend]);

  // Find which jid owns a requestId — scan all message lists
  const findRequestJid = useCallback((requestId: string): string | null => {
    let found: string | null = null;
    setMessages(prev => {
      for (const [jid, msgs] of Object.entries(prev)) {
        if (msgs.some(m => (m.role === 'permission' || m.role === 'question') && (m as PermissionMessage | QuestionMessage).requestId === requestId)) {
          found = jid;
          break;
        }
      }
      return prev; // no change
    });
    return found;
  }, []);

  const resolvePermission = useCallback((requestId: string, optionKey: string) => {
    rawSend({ type: 'permission:response', requestId, optionKey });
    // Update local card to show resolved state
    setMessages(prev => {
      const next = { ...prev };
      for (const [jid, msgs] of Object.entries(prev)) {
        const idx = msgs.findIndex(m => m.role === 'permission' && (m as PermissionMessage).requestId === requestId);
        if (idx >= 0) {
          const perm = msgs[idx] as PermissionMessage;
          const option = perm.options.find(o => o.key === optionKey);
          const updated: PermissionMessage = { ...perm, resolved: option ?? { key: optionKey, label: optionKey } };
          next[jid] = [...msgs.slice(0, idx), updated, ...msgs.slice(idx + 1)];
          break;
        }
      }
      return next;
    });
  }, [rawSend]);

  const resolveQuestion = useCallback((requestId: string, answers: Record<number, number | number[]>, otherTexts?: Record<number, string>) => {
    rawSend({ type: 'question:response', requestId, answers, ...(otherTexts ? { otherTexts } : {}) });
    // Update local card to show resolved state
    setMessages(prev => {
      const next = { ...prev };
      for (const [jid, msgs] of Object.entries(prev)) {
        const idx = msgs.findIndex(m => m.role === 'question' && (m as QuestionMessage).requestId === requestId);
        if (idx >= 0) {
          const q = msgs[idx] as QuestionMessage;
          const updated: QuestionMessage = { ...q, selections: answers, otherTexts, resolved: true };
          next[jid] = [...msgs.slice(0, idx), updated, ...msgs.slice(idx + 1)];
          break;
        }
      }
      return next;
    });
  }, [rawSend]);

  const resolveForm = useCallback((requestId: string, values: Record<string, unknown>, submitted: boolean) => {
    rawSend({ type: 'form:response', requestId, values, submitted });
    // 本地锁定 inline 表单卡片为已解决
    setMessages(prev => {
      const next = { ...prev };
      for (const [jid, msgs] of Object.entries(prev)) {
        const idx = msgs.findIndex(m => m.role === 'form' && (m as FormMessage).requestId === requestId);
        if (idx >= 0) {
          const f = msgs[idx] as FormMessage;
          const updated: FormMessage = { ...f, values, resolved: true };
          next[jid] = [...msgs.slice(0, idx), updated, ...msgs.slice(idx + 1)];
          break;
        }
      }
      return next;
    });
    // dock 表单：提交后移除
    setFormDock(prev => {
      for (const [jid, fm] of Object.entries(prev)) {
        if (fm?.requestId === requestId) return { ...prev, [jid]: null };
      }
      return prev;
    });
  }, [rawSend]);

  const registerGroup = useCallback((data: RegisterGroupPayload) => {
    rawSend({ type: 'register:group', ...data });
  }, [rawSend]);

  const registerFeishuApp = useCallback((appId: string, appSecret: string, domain?: string) => {
    rawSend({ type: 'register:feishu-app', appId, appSecret, ...(domain ? { domain } : {}) });
  }, [rawSend]);

  const registerQQApp = useCallback((appId: string, appSecret: string, sandbox?: boolean) => {
    rawSend({ type: 'register:qq-app', appId, appSecret, ...(sandbox ? { sandbox } : {}) });
  }, [rawSend]);

  const unregisterGroup = useCallback((jid: string) => {
    rawSend({ type: 'unregister:group', jid });
  }, [rawSend]);

  const updateGroup = useCallback((jid: string, updates: UpdateGroupPayload) => {
    rawSend({ type: 'update:group', jid, ...updates });
  }, [rawSend]);

  const pauseAgent = useCallback((jid: string) => {
    rawSend({ type: 'agent:control', groupJid: jid, action: 'pause' });
  }, [rawSend]);

  const resumeAgent = useCallback((jid: string, query?: string) => {
    if (query?.trim()) {
      addMessage(jid, {
        id:        `local-${Date.now()}`,
        role:      'user',
        text:      query.trim(),
        timestamp: new Date().toISOString(),
      });
    }
    rawSend({ type: 'agent:control', groupJid: jid, action: 'resume', ...(query ? { query } : {}) });
  }, [addMessage, rawSend]);

  const stopAgent = useCallback((jid: string) => {
    rawSend({ type: 'agent:control', groupJid: jid, action: 'stop' });
  }, [rawSend]);

  // ===== Workbench send methods =====

  const workbenchMarkViewed = useCallback((jid: string, artifactId: string) => {
    rawSend({ type: 'workbench:viewed', groupJid: jid, artifactId });
  }, [rawSend]);

  const workbenchClose = useCallback((jid: string, artifactId: string) => {
    rawSend({ type: 'workbench:close', groupJid: jid, artifactId });
    // 本地立即移除
    setWorkbench(prev => {
      const cur = prev[jid];
      if (!cur) return prev;
      const isCurrent = cur.current?.id === artifactId;
      return {
        ...prev,
        [jid]: {
          current: isCurrent ? null : cur.current,
          history: cur.history.filter(a => a.id !== artifactId),
        },
      };
    });
  }, [rawSend]);

  const workbenchReadFile = useCallback((jid: string, artifactId: string, path: string): Promise<{ content?: string; error?: string }> => {
    return new Promise((resolve) => {
      const requestId = `wbr-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      // 包一层：若后端报 artifact 已不存在（其他 tab 关掉了 / daemon 重启清掉了），
      // 顺手把本 tab 的 localStorage 状态也 prune 一下，下次刷新就不会再出现
      // 注意：core_not_found 是 transient（resume_session / destroy → 下次 getOrCreate 之间），
      // 不可作为 prune 信号 —— artifact registry 是 process-global 的，下次 core 起来还会回来
      const wrappedResolve = (data: { content?: string; error?: string }) => {
        if (data.error === 'artifact_not_found') {
          setWorkbench(prev => {
            const cur = prev[jid];
            if (!cur) return prev;
            const inState = cur.current?.id === artifactId || cur.history.some(a => a.id === artifactId);
            if (!inState) return prev;
            const isCurrent = cur.current?.id === artifactId;
            return {
              ...prev,
              [jid]: {
                current: isCurrent ? null : cur.current,
                history: cur.history.filter(a => a.id !== artifactId),
              },
            };
          });
        }
        resolve(data);
      };
      wbPendingRef.current.set(requestId, wrappedResolve);
      rawSend({ type: 'workbench:read_file', requestId, groupJid: jid, artifactId, path });
      // 10s 超时
      setTimeout(() => {
        if (wbPendingRef.current.has(requestId)) {
          wbPendingRef.current.delete(requestId);
          resolve({ error: 'timeout' });
        }
      }, 10000);
    });
  }, [rawSend]);

  const workbenchSetCurrent = useCallback((jid: string, artifactId: string) => {
    setWorkbench(prev => {
      const cur = prev[jid];
      if (!cur) return prev;
      if (cur.current?.id === artifactId) return prev;
      const target = cur.history.find(a => a.id === artifactId);
      if (!target) return prev;
      // 把 target 提到 current；原 current 放回 history 顶部
      const newHistory = cur.current
        ? [cur.current, ...cur.history.filter(a => a.id !== artifactId)]
        : cur.history.filter(a => a.id !== artifactId);
      return { ...prev, [jid]: { current: target, history: newHistory } };
    });
  }, []);

  const workbenchFetchLogs = useCallback((jid: string, artifactId: string, tailLines: number = 200): Promise<string> => {
    return new Promise((resolve) => {
      const requestId = `wbl-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      wbPendingRef.current.set(requestId, (data) => resolve(data.content ?? ''));
      rawSend({ type: 'workbench:fetch_logs', requestId, groupJid: jid, artifactId, tailLines });
      setTimeout(() => {
        if (wbPendingRef.current.has(requestId)) {
          wbPendingRef.current.delete(requestId);
          resolve('');
        }
      }, 10000);
    });
  }, [rawSend]);

  const subscribeAll = useCallback(() => {
    setGroups(prev => {
      for (const g of prev) {
        if (!subscribedRef.current.has(g.jid)) {
          rawSend({ type: 'subscribe', groupJid: g.jid });
          subscribedRef.current.add(g.jid);
        }
      }
      return prev;
    });
  }, [rawSend]);

  useEffect(() => {
    let destroyed = false;

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const handleMsg = (raw: MessageEvent) => {
      try {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const msg = JSON.parse(raw.data as string) as Record<string, any>;
        switch (msg.type) {
          case 'auth:ok':
            setStatus('connected');
            retryCountRef.current = 0;
            rawSend({ type: 'list:groups' });
            rawSend({ type: 'workflow:list' });
            rawSend({ type: 'workflow:runs' });
            // Re-subscribe to all previously-subscribed groups after reconnect
            for (const jid of subscribedRef.current) {
              rawSend({ type: 'subscribe', groupJid: jid });
            }
            break;
          case 'groups': {
            const incoming = (msg.groups as GroupInfo[]) ?? [];
            setGroups(incoming);
            // Auto-subscribe to admin groups so requireAdmin checks pass for settings operations
            for (const g of incoming) {
              if (g.isAdmin && !subscribedRef.current.has(g.jid)) {
                rawSend({ type: 'subscribe', groupJid: g.jid });
              }
            }
            break;
          }
          case 'subscribed':
            setSubscribed(prev => new Set([...prev, msg.groupJid as string]));
            break;
          case 'workflow:defs':
            setWorkflowDefs((msg.defs as WorkflowDefSummary[]) ?? []);
            break;
          case 'workflow:runs':
            setWorkflowRuns((msg.runs as WorkflowRun[]) ?? []);
            break;
          case 'workflow:update': {
            const run = msg.run as WorkflowRun | undefined;
            if (run) setWorkflowRuns(prev => {
              const idx = prev.findIndex(r => r.id === run.id);
              if (idx === -1) return [run, ...prev];
              const next = [...prev]; next[idx] = run; return next;
            });
            break;
          }
          case 'workflow:run:started':
            if (msg.error) setWorkflowError(String(msg.error));
            break;
          case 'workflow:edit:response':
            if (msg.error) setWorkflowError(String(msg.error));
            else { rawSend({ type: 'workflow:list' }); }  // 成功 → 重新拉 defs 反映新值
            break;
          case 'chat:history': {
            // 服务端在 subscribe 时回放当前 session 的完整文本历史，
            // 客户端用其作为 messages[jid] 的初始 seed（覆盖之前的内存状态）。
            const jid = msg.groupJid as string;
            const sessionId = msg.sessionId as string;
            const entries = (msg.entries as { role: 'user' | 'assistant'; senderName?: string; text: string; index: number }[]) ?? [];
            const seed: ChatMessage[] = entries.map(e => ({
              id:         `hist-${sessionId}-${e.index}`,
              role:       e.role === 'assistant' ? 'agent' : 'other',
              senderName: e.senderName,
              text:       e.text,
              timestamp:  '',
            }));
            setMessages(prev => ({ ...prev, [jid]: seed }));
            break;
          }
          case 'incoming':
            if (msg.isFromMe) break;
            addMessage(msg.groupJid as string, {
              id:         `in-${Date.now()}-${Math.random()}`,
              role:       'other',
              senderName: msg.senderName as string,
              text:       msg.text as string,
              timestamp:  msg.timestamp as string,
            });
            break;
          case 'agent:reply':
            addMessage(msg.groupJid as string, {
              id:        `agent-${Date.now()}-${Math.random()}`,
              role:      'agent',
              text:      msg.text as string,
              timestamp: new Date().toISOString(),
            });
            // State is managed solely by agent:state events — do not override here.
            // agent:reply can fire for intermediate replies during multi-turn dispatch,
            // and incorrectly setting idle would cause the pause button to disappear.
            break;
          case 'agent:state':
            setAgentStates(prev => ({ ...prev, [msg.groupJid as string]: msg.state as string }));
            // idle 时清掉 compacting 标记（防止 compact 中途 stop 后残留 "Compacting…"）
            if (msg.state === 'idle') {
              setAgentCompacting(prev => ({ ...prev, [msg.groupJid as string]: false }));
            }
            break;
          case 'agent:compacting':
            setAgentCompacting(prev => ({ ...prev, [msg.groupJid as string]: msg.isCompacting as boolean }));
            break;
          case 'permission:request':
            addMessage(msg.groupJid as string, {
              id:        `perm-${msg.requestId as string}`,
              role:      'permission',
              requestId: msg.requestId as string,
              toolName:  msg.toolName as string,
              title:     msg.title as string,
              content:   msg.content as string,
              options:   msg.options as PermissionMessage['options'],
              timestamp: new Date().toISOString(),
            });
            break;
          case 'question:request':
            addMessage(msg.groupJid as string, {
              id:         `q-${msg.requestId as string}`,
              role:       'question',
              requestId:  msg.requestId as string,
              agentId:    msg.agentId as string,
              questions:  msg.questions as QuestionMessage['questions'],
              selections: {},
              resolved:   false,
              timestamp:  new Date().toISOString(),
            });
            break;
          case 'permission:resolved': {
            const rJid = msg.groupJid as string;
            const rId  = msg.requestId as string;
            updateMessage(rJid, `perm-${rId}`, (m) => {
              const perm = m as PermissionMessage;
              if (perm.resolved) return m; // already resolved locally
              const option = perm.options?.find(o => o.key === (msg.optionKey as string));
              return { ...perm, resolved: option ?? { key: msg.optionKey as string, label: msg.optionLabel as string } };
            });
            break;
          }
          case 'question:resolved': {
            const qJid = msg.groupJid as string;
            const qId  = msg.requestId as string;
            updateMessage(qJid, `q-${qId}`, (m) => {
              const q = m as QuestionMessage;
              if (q.resolved) return m; // already resolved locally
              return { ...q, resolved: true };
            });
            break;
          }
          case 'form:request': {
            const fields = (msg.fields as FormMessage['fields']) ?? [];
            // 按 field.default seed 受控值
            const initial: Record<string, unknown> = {};
            for (const f of fields) {
              if (f.type === 'static_text') continue;
              if ('default' in f && f.default !== undefined) initial[f.key] = f.default;
            }
            const fJid = msg.groupJid as string;
            const surface = (msg.surface as FormMessage['surface']) ?? 'inline';
            const formMsg: FormMessage = {
              id:          `f-${msg.requestId as string}`,
              role:        'form',
              requestId:   msg.requestId as string,
              agentId:     msg.agentId as string,
              title:       (msg.title as string) ?? '',
              surface,
              submitLabel: (msg.submitLabel as string) ?? 'Submit',
              fields,
              values:      initial,
              resolved:    false,
              timestamp:   new Date().toISOString(),
            };
            if (surface === 'dock') {
              // dock 表单不进聊天流，单独存 formDock 并触发抢前台
              setFormDock(prev => ({ ...prev, [fJid]: formMsg }));
              setFormDockLatest({ jid: fJid, at: Date.now() });
            } else {
              addMessage(fJid, formMsg);
            }
            break;
          }
          case 'form:resolved': {
            const fJid = msg.groupJid as string;
            const fId  = msg.requestId as string;
            updateMessage(fJid, `f-${fId}`, (m) => {
              const f = m as FormMessage;
              if (f.resolved) return m; // already resolved locally
              return { ...f, resolved: true };
            });
            // dock 表单：解决后从 formDock 移除
            setFormDock(prev => (prev[fJid]?.requestId === fId ? { ...prev, [fJid]: null } : prev));
            break;
          }
          case 'group:registered':
            setGroups(prev => {
              const g = msg.group as GroupInfo;
              return prev.some(x => x.jid === g.jid) ? prev.map(x => x.jid === g.jid ? g : x) : [...prev, g];
            });
            break;
          case 'group:unregistered':
            setGroups(prev => prev.filter(g => g.jid !== (msg.jid as string)));
            break;
          case 'group:updated':
            setGroups(prev => prev.map(g => g.jid === (msg.group as GroupInfo).jid ? msg.group as GroupInfo : g));
            break;
          case 'dispatch:update': {
            const newParents = (msg.parents as DispatchParent[]) ?? [];
            const TERMINAL = ['done', 'error', 'timeout'];
            // 任务卡片进入终态（done / error / timeout）时，清除对应 agent 的 todos
            setDispatchParents(prev => {
              for (const np of newParents) {
                for (const nt of np.tasks) {
                  if (!TERMINAL.includes(nt.status)) continue;
                  const op = prev.find(p => p.id === np.id);
                  const ot = op?.tasks.find(t => t.id === nt.id);
                  if (ot && !TERMINAL.includes(ot.status)) {
                    // 这个任务刚进入终态
                    setAgentTodos(prevTodos => {
                      const next = { ...prevTodos };
                      delete next[nt.agentJid];
                      return next;
                    });
                  }
                }
              }
              return newParents;
            });
            break;
          }
          case 'workbench:new': {
            const wbJid = msg.groupJid as string;
            const artifact = msg.artifact as WorkbenchArtifact;
            setWorkbench(prev => {
              const cur = prev[wbJid] ?? { current: null, history: [] };
              const newHistory = cur.current ? [cur.current, ...cur.history.filter(a => a.id !== cur.current!.id)] : cur.history;
              return {
                ...prev,
                [wbJid]: { current: artifact, history: newHistory.filter(a => a.id !== artifact.id) },
              };
            });
            setWorkbenchLatest({ jid: wbJid, artifactId: artifact.id, at: Date.now() });
            break;
          }
          case 'workbench:service_ready':
          case 'workbench:service_crashed':
          case 'workbench:service_stopped': {
            const wbJid = msg.groupJid as string;
            const aid = msg.artifactId as string;
            const statusUpdate = (a: WorkbenchArtifact): WorkbenchArtifact => {
              if (a.id !== aid || !a.process) return a;
              if (msg.type === 'workbench:service_ready') {
                return { ...a, process: { ...a.process, status: 'running' } };
              }
              if (msg.type === 'workbench:service_crashed') {
                return { ...a, process: { ...a.process, status: 'crashed' } };
              }
              return { ...a, process: { ...a.process, status: 'stopped' } };
            };
            setWorkbench(prev => {
              const cur = prev[wbJid];
              if (!cur) return prev;
              return {
                ...prev,
                [wbJid]: {
                  current: cur.current ? statusUpdate(cur.current) : null,
                  history: cur.history.map(statusUpdate),
                },
              };
            });
            break;
          }
          case 'workbench:read_file:response': {
            const rid = msg.requestId as string;
            const resolver = wbPendingRef.current.get(rid);
            if (resolver) {
              wbPendingRef.current.delete(rid);
              resolver({ content: msg.content as string | undefined, error: msg.error as string | undefined });
            }
            break;
          }
          case 'workbench:fetch_logs:response': {
            const rid = msg.requestId as string;
            const resolver = wbPendingRef.current.get(rid);
            if (resolver) {
              wbPendingRef.current.delete(rid);
              resolver({ content: msg.content as string });
            }
            break;
          }
          case 'agent:todos': {
            const todoJid = msg.agentJid as string;
            const todosArr = msg.todos as AgentTodosEntry['todos'];
            // 取消该 agent 上一次的延迟清除（有新 todos 写入，之前的清除计划作废）
            const prev = todosClearTimers.current.get(todoJid);
            if (prev) { clearTimeout(prev); todosClearTimers.current.delete(todoJid); }
            setAgentTodos(prev => ({
              ...prev,
              [todoJid]: { agentName: msg.agentName as string, todos: todosArr },
            }));
            // 全部完成时延迟 3s 清除（让用户看到完成状态后自动消失）
            if (todosArr.length > 0 && todosArr.every(t => t.status === 'completed')) {
              const t = setTimeout(() => {
                todosClearTimers.current.delete(todoJid);
                setAgentTodos(prev => { const n = { ...prev }; delete n[todoJid]; return n; });
              }, 3000);
              todosClearTimers.current.set(todoJid, t);
            }
            break;
          }
        }
      } catch { /* ignore */ }
    };

    const connect = async () => {
      if (destroyed) return;
      if (!configRef.current) {
        try {
          const res = await fetch('/api/config');
          configRef.current = await res.json() as WsConfig;
        } catch {
          configRef.current = { wsPort: 18789, token: '' };
        }
      }
      setStatus('connecting');
      const { wsPort, token } = configRef.current;
      const ws = new WebSocket(`ws://127.0.0.1:${wsPort}`);
      wsRef.current = ws;
      ws.onopen = () => { if (token) rawSend({ type: 'connect', token }); };
      ws.onmessage = handleMsg;
      ws.onclose = () => {
        if (destroyed) return;
        setStatus('disconnected');
        const delay = Math.min(3000 * 2 ** retryCountRef.current, 15000);
        retryCountRef.current++;
        reconnectRef.current = setTimeout(connect, delay);
      };
    };

    const onFocus = () => {
      if (destroyed) return;
      if (wsRef.current?.readyState === WebSocket.OPEN || wsRef.current?.readyState === WebSocket.CONNECTING) return;
      clearTimeout(reconnectRef.current);
      retryCountRef.current = 0;
      connect();
    };
    const onVisibility = () => { if (document.visibilityState === 'visible') onFocus(); };
    window.addEventListener('focus', onFocus);
    document.addEventListener('visibilitychange', onVisibility);

    connect();

    return () => {
      destroyed = true;
      clearTimeout(reconnectRef.current);
      window.removeEventListener('focus', onFocus);
      document.removeEventListener('visibilitychange', onVisibility);
      wsRef.current?.close();
      // 清除所有待执行的 todos 延迟清除 timer
      for (const t of todosClearTimers.current.values()) clearTimeout(t);
      todosClearTimers.current.clear();
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // suppress unused warning — findRequestJid is available for future use
  void findRequestJid;

  return {
    status, groups, messages, agentStates, agentCompacting, subscribed, subscribe, sendMessage,
    pauseAgent, resumeAgent, stopAgent, resolvePermission, resolveQuestion, resolveForm, formDock, formDockLatest,
    registerGroup, registerFeishuApp, registerQQApp, unregisterGroup, updateGroup,
    dispatchParents, agentTodos, subscribeAll,
    workbench, workbenchLatest, workbenchMarkViewed, workbenchClose, workbenchReadFile, workbenchFetchLogs,
    workbenchSetCurrent,
    workflowDefs, workflowRuns, workflowError, workflowRun, workflowCancel, workflowEdit, workflowRefresh,
  };
}
