import { useState, useEffect } from 'react';
import { Sidebar } from './components/Sidebar';
import { ChatView } from './components/ChatView';
import { SettingsPanel } from './components/SettingsPanel';
import { AgentConsole } from './components/AgentConsole';
import { useWebSocket } from './hooks/useWebSocket';

export function App() {
  const [selectedJid, setSelectedJid]   = useState<string | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const ws = useWebSocket();
  const { dispatchParents, agentTodos, subscribeAll } = ws;

  // When dispatch is active, subscribe to all agents to receive their permission/todo events
  useEffect(() => {
    const hasActive = dispatchParents.some(p => p.status === 'active' || p.status === 'queued');
    if (hasActive && ws.groups.length > 0) subscribeAll();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dispatchParents, ws.groups.length]);

  // Auto-select first group when list loads
  useEffect(() => {
    if (!selectedJid && ws.groups.length > 0) {
      const jid = ws.groups[0].jid;
      setSelectedJid(jid);
      if (!ws.subscribed.has(jid)) ws.subscribe(jid);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ws.groups.length]);

  const handleSelect = (jid: string) => {
    setSelectedJid(jid);
    if (!ws.subscribed.has(jid)) ws.subscribe(jid);
  };

  const selectedGroup = ws.groups.find(g => g.jid === selectedJid);

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
            onSend={text => ws.sendMessage(selectedJid!, text)}
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
      />
    </div>
  );
}
