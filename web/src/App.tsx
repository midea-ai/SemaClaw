import { useState, useEffect, useCallback } from 'react';
import { Sidebar } from './components/Sidebar';
import { ChatView } from './components/ChatView';
import { SettingsPanel } from './components/SettingsPanel';
import { AgentConsole } from './components/AgentConsole';
import { Workbench } from './components/Workbench';
import { DockBadges } from './components/DockBadges';
import { useWebSocket } from './hooks/useWebSocket';

type ExpandedDock = 'agent' | 'workbench' | null;

export function App() {
  const [selectedJid, setSelectedJid]   = useState<string | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [expandedDock, setExpandedDock] = useState<ExpandedDock>(null);
  /** 用户手动收起后，本次 workbenchLatest 不再触发抢前台 */
  const [suppressedLatestAt, setSuppressedLatestAt] = useState<number | null>(null);
  const ws = useWebSocket();
  const { dispatchParents, agentTodos, subscribeAll, workbench, workbenchLatest, workbenchReadFile, workbenchClose, workbenchMarkViewed, workbenchSetCurrent } = ws;

  // When dispatch is active, subscribe to all agents to receive their permission/todo events
  useEffect(() => {
    const hasActive = dispatchParents.some(p => p.status === 'active' || p.status === 'queued');
    if (hasActive && ws.groups.length > 0) subscribeAll();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dispatchParents, ws.groups.length]);

  // Auto-select admin (main) group on first load; fall back to first group if missing
  useEffect(() => {
    if (!selectedJid && ws.groups.length > 0) {
      const admin = ws.groups.find(g => g.isAdmin);
      const jid = (admin ?? ws.groups[0]).jid;
      setSelectedJid(jid);
      if (!ws.subscribed.has(jid)) ws.subscribe(jid);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ws.groups.length]);

  // 新工作台到达：抢前台展开 Workbench（除非用户刚手动收起这一条）
  useEffect(() => {
    if (!workbenchLatest) return;
    if (suppressedLatestAt === workbenchLatest.at) return;
    if (workbenchLatest.jid !== selectedJid) return; // 仅当事件所属 jid 是当前选中群组时弹
    setExpandedDock('workbench');
  }, [workbenchLatest, suppressedLatestAt, selectedJid]);

  const handleSelect = (jid: string) => {
    setSelectedJid(jid);
    if (!ws.subscribed.has(jid)) ws.subscribe(jid);
  };

  const selectedGroup = ws.groups.find(g => g.jid === selectedJid);
  const workbenchState = selectedJid ? (workbench[selectedJid] ?? null) : null;

  // Workbench 回调：固定到当前选中 jid
  const wbReadFile = useCallback((artifactId: string, path: string) => {
    if (!selectedJid) return Promise.resolve({ error: 'no_jid' });
    return workbenchReadFile(selectedJid, artifactId, path);
  }, [selectedJid, workbenchReadFile]);

  const wbClose = useCallback((artifactId: string) => {
    if (!selectedJid) return;
    workbenchClose(selectedJid, artifactId);
  }, [selectedJid, workbenchClose]);

  const wbMarkViewed = useCallback((artifactId: string) => {
    if (!selectedJid) return;
    workbenchMarkViewed(selectedJid, artifactId);
  }, [selectedJid, workbenchMarkViewed]);

  const wbSelect = useCallback((artifactId: string) => {
    if (!selectedJid) return;
    // 把 history 里的 artifact 提到 current（纯前端切换，后端不需要变）。
    // markViewed 由 Workbench 内部 useEffect 在 current.id 变化时自动调，这里不重复发。
    workbenchSetCurrent(selectedJid, artifactId);
  }, [selectedJid, workbenchSetCurrent]);

  // ExpandedDock 互斥控制
  const setAgentExpanded = useCallback(() => setExpandedDock('agent'), []);
  const collapseDock = useCallback((which: 'agent' | 'workbench') => {
    setExpandedDock(null);
    if (which === 'workbench' && workbenchLatest) {
      // 抑制本次 latest 的二次抢前台
      setSuppressedLatestAt(workbenchLatest.at);
    }
  }, [workbenchLatest]);

  /** Dock badge toggle：点击 active 收起，点击 inactive 切换 */
  const onToggleDock = useCallback((which: 'agent' | 'workbench') => {
    setExpandedDock(prev => {
      if (prev === which) {
        if (which === 'workbench' && workbenchLatest) {
          setSuppressedLatestAt(workbenchLatest.at);
        }
        return null;
      }
      return which;
    });
  }, [workbenchLatest]);

  return (
    <div className="flex h-screen overflow-hidden bg-white">
      {settingsOpen && (
        <SettingsPanel
          onClose={() => setSettingsOpen(false)}
          groups={ws.groups}
          onRegisterGroup={ws.registerGroup}
          onRegisterFeishuApp={ws.registerFeishuApp}
          onRegisterQQApp={ws.registerQQApp}
          onUnregisterGroup={ws.unregisterGroup}
          onUpdateGroup={ws.updateGroup}
        />
      )}

      <Sidebar
        groups={ws.groups}
        selectedJid={selectedJid}
        agentStates={ws.agentStates}
        status={ws.status}
        onSelect={handleSelect}
        onOpenSettings={() => setSettingsOpen(true)}
      />

      <main className="flex-1 min-w-0">
        {selectedGroup ? (
          <ChatView
            group={selectedGroup}
            messages={ws.messages[selectedJid!] ?? []}
            agentState={ws.agentStates[selectedJid!] ?? 'idle'}
            isCompacting={ws.agentCompacting[selectedJid!] ?? false}
            onSend={(text, attachments) => ws.sendMessage(selectedJid!, text, attachments)}
            onPause={() => ws.pauseAgent(selectedJid!)}
            onResume={(query?: string) => ws.resumeAgent(selectedJid!, query)}
            onStop={() => ws.stopAgent(selectedJid!)}
            onResolvePermission={ws.resolvePermission}
            onResolveQuestion={ws.resolveQuestion}
          />
        ) : (
          <div className="flex h-full items-center justify-center">
            <div className="text-center select-none">
              <img src="/logo.svg" alt="" className="w-16 h-16 mx-auto mb-4 opacity-20" />
              <p className="text-gray-400 text-sm">
                {ws.status === 'connecting' ? 'Connecting to SemaClaw…' : 'Select a group to start'}
              </p>
            </div>
          </div>
        )}
      </main>

      <AgentConsole
        dispatchParents={dispatchParents}
        agentTodos={agentTodos}
        messages={ws.messages}
        groups={ws.groups}
        agentStates={ws.agentStates}
        resolvePermission={ws.resolvePermission}
        expanded={expandedDock === 'agent'}
        onExpand={setAgentExpanded}
        onCollapse={() => collapseDock('agent')}
      />

      <Workbench
        state={workbenchState}
        expanded={expandedDock === 'workbench'}
        onCollapse={() => collapseDock('workbench')}
        readFile={wbReadFile}
        closeArtifact={wbClose}
        selectArtifact={wbSelect}
        markViewed={wbMarkViewed}
      />

      <DockBadges
        expanded={expandedDock}
        onToggle={onToggleDock}
        dispatchParents={dispatchParents}
        agentTodos={agentTodos}
        messages={ws.messages}
        groups={ws.groups}
        workbenchState={workbenchState}
      />
    </div>
  );
}
