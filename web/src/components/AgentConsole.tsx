import { useState, useMemo, useEffect } from 'react';
import type { AgentState, DispatchParent, DispatchTask, AgentTodosEntry, PermissionMessage, GroupInfo, ChatMessage } from '../types';
import { DispatchTree } from './DispatchTree';
import { AgentTodoPanel } from './AgentTodoPanel';

interface AgentConsoleProps {
  dispatchParents: DispatchParent[];
  agentTodos: Record<string, AgentTodosEntry>;
  messages: Record<string, ChatMessage[]>;
  groups: GroupInfo[];
  agentStates: Record<string, AgentState>;
  resolvePermission: (requestId: string, optionKey: string) => void;
}

const PERM_OPTION_STYLE: Record<string, string> = {
  agree:   'bg-green-50 border-green-200 text-green-700 hover:bg-green-100',
  allow:   'bg-green-50 border-green-200 text-green-700 hover:bg-green-100',
  yes:     'bg-green-50 border-green-200 text-green-700 hover:bg-green-100',
  refuse:  'bg-red-50 border-red-200 text-red-700 hover:bg-red-100',
  deny:    'bg-red-50 border-red-200 text-red-700 hover:bg-red-100',
  no:      'bg-red-50 border-red-200 text-red-700 hover:bg-red-100',
};
const DEFAULT_OPT_STYLE = 'bg-gray-50 border-gray-200 text-gray-700 hover:bg-gray-100';

export function AgentConsole({ dispatchParents, agentTodos, messages, groups, agentStates, resolvePermission }: AgentConsoleProps) {
  const activeParents = dispatchParents.filter(p => p.status === 'active');
  const queuedParents = dispatchParents.filter(p => p.status === 'queued');
  const hasActivity = activeParents.length > 0 || queuedParents.length > 0;

  // 从 active/queued parents 中找到主 admin agent 的状态
  const adminFolder = activeParents[0]?.adminFolder ?? queuedParents[0]?.adminFolder ?? null;
  const adminJid = adminFolder ? (groups.find(g => g.folder === adminFolder)?.jid ?? null) : null;
  const adminState: AgentState = adminJid ? (agentStates[adminJid] ?? 'idle') : 'idle';
  const adminPaused = adminState === 'paused';

  // Start expanded if dispatch is already active on mount; otherwise collapsed
  const [collapsed, setCollapsed] = useState(() => !dispatchParents.some(
    p => p.status === 'active' || p.status === 'queued'
  ));
  const [selectedTask, setSelectedTask] = useState<DispatchTask | null>(null);

  // Pending permissions from ALL agents (scan all message lists)
  const pendingPermissions = useMemo(() => {
    const result: Array<PermissionMessage & { agentJid: string; agentName: string }> = [];
    for (const [jid, msgs] of Object.entries(messages)) {
      const agentName = groups.find(g => g.jid === jid)?.name ?? jid;
      for (const msg of msgs) {
        if (msg.role === 'permission' && !msg.resolved) {
          result.push({ ...(msg as PermissionMessage), agentJid: jid, agentName });
        }
      }
    }
    return result;
  }, [messages, groups]);

  // Auto-expand when dispatch becomes active
  useEffect(() => {
    if (hasActivity) setCollapsed(false);
  }, [hasActivity]);

  // Selected task's agent todos for the detail panel
  const selectedAgentTodos = selectedTask
    ? Object.entries(agentTodos).find(([jid]) => {
        const group = groups.find(g => g.jid === jid);
        return group?.folder === selectedTask.agentId;
      })
    : null;

  const hasTodos = Object.keys(agentTodos).length > 0;

  // Collapsed badge — always visible
  if (collapsed) {
    const totalPending = pendingPermissions.length;
    return (
      <div className="flex flex-col items-center gap-2 w-10 flex-shrink-0 border-l border-gray-100 py-3 bg-white">
        <button
          onClick={() => setCollapsed(false)}
          className="relative flex flex-col items-center gap-1 text-gray-400 hover:text-[#5BBFE8] transition-colors"
          title="Open Agent Console"
        >
          <span className="text-base">⚙</span>
          {totalPending > 0 && (
            <span className="absolute -top-1 -right-1 w-4 h-4 rounded-full bg-amber-500 text-white text-[9px] font-bold flex items-center justify-center">
              {totalPending}
            </span>
          )}
          {hasActivity && (
            <span className="w-1.5 h-1.5 rounded-full bg-green-500 animate-pulse" />
          )}
          {!hasActivity && hasTodos && (
            <span className="w-1.5 h-1.5 rounded-full bg-[#5BBFE8]" />
          )}
        </button>
      </div>
    );
  }

  return (
    <div className="flex flex-col flex-1 min-w-0 border-l border-gray-100 bg-[#F5F8FB] overflow-hidden">
      {/* Header */}
      <div className="flex items-center justify-between px-3 py-2 border-b border-gray-200 bg-white flex-shrink-0">
        <div className="flex items-center gap-2">
          <span className="text-sm font-semibold text-gray-700">Agent Console</span>
          {hasActivity && !adminPaused && (
            <span className="flex items-center gap-1 text-[10px] text-green-600 font-medium">
              <span className="w-1.5 h-1.5 rounded-full bg-green-500 animate-pulse" />
              Live
            </span>
          )}
          {hasActivity && adminPaused && (
            <span className="flex items-center gap-1 text-[10px] text-orange-500 font-medium">
              <span className="w-1.5 h-1.5 rounded-full bg-orange-400" />
              Paused
            </span>
          )}
          {pendingPermissions.length > 0 && (
            <span className="text-[10px] bg-amber-500 text-white px-1.5 py-0.5 rounded-full font-bold">
              {pendingPermissions.length} pending
            </span>
          )}
        </div>
        <button
          onClick={() => setCollapsed(true)}
          className="text-gray-400 hover:text-gray-600 text-xs px-1.5 py-0.5 rounded hover:bg-gray-100"
        >
          Hide ▸
        </button>
      </div>

      <div className="flex flex-1 min-h-0 gap-0">
        {/* Left: DAG + Todos — only render when there's content to show */}
        {(hasActivity || !!selectedTask || hasTodos) && (
        <div className="flex flex-col flex-1 min-w-0 overflow-y-auto">
          {/* Dispatch DAG section */}
          {hasActivity && (
            <div className="flex flex-col">
              <div className="flex items-center gap-2 px-3 py-1.5 border-b border-gray-100 flex-shrink-0">
                <span className="text-[10px] font-semibold text-gray-400 uppercase tracking-wide">Workflow</span>
                <span className="text-[10px] text-gray-300">{activeParents.length} active · {queuedParents.length} queued</span>
                {adminPaused && (
                  <span className="ml-auto text-[10px] text-orange-500 font-medium">⏸ dispatch paused</span>
                )}
              </div>
              <div className="p-2">
                <DispatchTree
                  parents={dispatchParents}
                  onSelectTask={setSelectedTask}
                  selectedTaskId={selectedTask?.id}
                  adminPaused={adminPaused}
                />
              </div>
            </div>
          )}

          {/* Task detail card */}
          {selectedTask && (
            <div className="border-t border-gray-100 px-3 pt-2 pb-1">
              <div className="bg-white border border-gray-100 rounded-lg p-2.5">
                <div className="flex items-start justify-between gap-2 mb-1.5">
                  <div className="flex items-center gap-1.5 min-w-0">
                    <span className={`text-xs font-semibold truncate ${
                      selectedTask.status === 'done' ? 'text-green-600'
                      : selectedTask.status === 'processing' ? 'text-[#5BBFE8]'
                      : selectedTask.status === 'error' ? 'text-red-500'
                      : 'text-gray-500'
                    }`}>{selectedTask.label}</span>
                    <span className={`text-[9px] px-1 py-0.5 rounded font-semibold flex-shrink-0 ${
                      selectedTask.status === 'done' ? 'bg-green-50 text-green-600'
                      : selectedTask.status === 'processing' ? 'bg-blue-50 text-[#5BBFE8]'
                      : selectedTask.status === 'error' ? 'bg-red-50 text-red-500'
                      : 'bg-gray-50 text-gray-400'
                    }`}>{selectedTask.status}</span>
                  </div>
                  <div className="flex items-center gap-1 flex-shrink-0">
                    <span className="text-[9px] px-1.5 py-0.5 rounded font-medium bg-purple-50 text-purple-600">{selectedTask.agentId}</span>
                    <button onClick={() => setSelectedTask(null)} className="text-[10px] text-gray-300 hover:text-gray-500">✕</button>
                  </div>
                </div>
                {selectedTask.dependsOn.length > 0 && (
                  <p className="text-[9px] text-gray-400 mb-1">
                    Deps: <span className="font-mono">{selectedTask.dependsOn.join(', ')}</span>
                  </p>
                )}
                <p className="text-[10px] text-gray-500 leading-snug line-clamp-3">{selectedTask.prompt}</p>
                {selectedTask.result && (
                  <p className="text-[10px] text-gray-400 mt-1 italic line-clamp-2 border-t border-gray-50 pt-1">{selectedTask.result}</p>
                )}
              </div>
            </div>
          )}

          {/* Agent todos */}
          {(selectedTask || Object.keys(agentTodos).length > 0) && (
            <div className="flex flex-col border-t border-gray-100">
              <div className="flex items-center gap-2 px-3 py-1.5 border-b border-gray-100 flex-shrink-0">
                <span className="text-[10px] font-semibold text-gray-400 uppercase tracking-wide">
                  {selectedTask ? `Todos — ${selectedAgentTodos?.[1]?.agentName ?? selectedTask.agentId}` : 'Agent Todos'}
                </span>
              </div>
              <div className="p-2">
                {selectedTask && selectedAgentTodos ? (
                  <AgentTodoPanel
                    agentTodos={{ [selectedAgentTodos[0]]: selectedAgentTodos[1] }}
                    groups={groups}
                  />
                ) : (
                  <AgentTodoPanel agentTodos={agentTodos} groups={groups} />
                )}
              </div>
            </div>
          )}
        </div>
        )}

        {/* Right: Permissions — full-width when no left content */}
        {pendingPermissions.length > 0 && (
          <div className={`${(hasActivity || !!selectedTask || hasTodos) ? 'w-[220px] border-l border-gray-100' : 'flex-1'} flex-shrink-0 flex flex-col min-h-0`}>
            <div className="flex items-center gap-2 px-2 py-1.5 border-b border-gray-100 flex-shrink-0">
              <span className="text-[10px] font-semibold text-gray-400 uppercase tracking-wide">Permissions</span>
              <span className="text-[10px] bg-amber-500 text-white px-1 rounded-full font-bold">{pendingPermissions.length}</span>
            </div>
            <div className="flex flex-col gap-2 p-2 overflow-y-auto flex-1 min-h-0">
              {pendingPermissions.map(perm => (
                <div key={perm.requestId} className="bg-white border border-gray-100 rounded-lg p-2 relative">
                  {/* Left accent bar */}
                  <div className="absolute left-0 top-0 bottom-0 w-0.5 rounded-l-lg bg-[#5BBFE8]" />
                  <div className="pl-1.5">
                    <div className="flex items-start justify-between gap-1 mb-1">
                      <div>
                        <p className="text-[11px] font-semibold text-gray-700 leading-tight">{perm.title}</p>
                        <p className="text-[10px] text-gray-400">{perm.agentName}</p>
                      </div>
                    </div>
                    <p className="font-mono text-[10px] bg-gray-50 rounded px-1.5 py-1 text-gray-600 mb-1.5 break-all border border-gray-100">
                      {perm.content.length > 80 ? perm.content.slice(0, 80) + '…' : perm.content}
                    </p>
                    <div className="flex gap-1">
                      {perm.options.map(opt => (
                        <button
                          key={opt.key}
                          onClick={() => resolvePermission(perm.requestId, opt.key)}
                          className={`flex-1 text-[10px] font-semibold py-1 rounded border transition-colors ${PERM_OPTION_STYLE[opt.key.toLowerCase()] ?? DEFAULT_OPT_STYLE}`}
                        >
                          {opt.label}
                        </button>
                      ))}
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
