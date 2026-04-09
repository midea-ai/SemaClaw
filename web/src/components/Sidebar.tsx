import type { GroupInfo, AgentState, WsStatus } from '../types';

interface Props {
  groups: GroupInfo[];
  selectedJid: string | null;
  agentStates: Record<string, AgentState>;
  status: WsStatus;
  onSelect: (jid: string) => void;
  onOpenSettings: () => void;
}

const STATUS: Record<WsStatus, { dot: string; label: string }> = {
  connected:    { dot: 'bg-green-400',              label: 'Connected'     },
  connecting:   { dot: 'bg-yellow-400 animate-pulse', label: 'Connecting…'  },
  disconnected: { dot: 'bg-red-400',                label: 'Disconnected'  },
};

function Avatar({ name }: { name: string }) {
  return (
    <div className="w-9 h-9 rounded-full bg-[#5BBFE8] flex items-center justify-center text-white font-semibold text-sm flex-shrink-0 select-none">
      {name.charAt(0).toUpperCase()}
    </div>
  );
}

export function Sidebar({ groups, selectedJid, agentStates, status, onSelect, onOpenSettings }: Props) {
  const { dot, label } = STATUS[status];

  return (
    <aside className="w-64 flex flex-col bg-white border-r border-gray-100 flex-shrink-0">
      {/* Logo + app name */}
      <div className="px-5 py-4 flex items-center gap-3 border-b border-gray-100">
        <img src="/logo.svg" alt="SemaClaw" className="w-8 h-8 flex-shrink-0" />
        <span className="font-bold text-gray-800 text-lg tracking-tight">SemaClaw</span>
      </div>

      {/* Connection status */}
      <div className="px-5 py-2 flex items-center gap-2 border-b border-gray-50">
        <span className={`w-2 h-2 rounded-full flex-shrink-0 ${dot}`} />
        <span className="text-xs text-gray-400">{label}</span>
      </div>

      {/* Group list */}
      <nav className="flex-1 overflow-y-auto py-1 min-h-0">
        {groups.length === 0 ? (
          <p className="px-5 py-4 text-xs text-gray-400 text-center">
            {status === 'connecting' ? 'Loading…' : 'No groups registered'}
          </p>
        ) : (
          groups.map(group => {
            const isSelected   = group.jid === selectedJid;
            const isProcessing = agentStates[group.jid] === 'processing';

            return (
              <button
                key={group.jid}
                onClick={() => onSelect(group.jid)}
                className={`w-full flex items-center gap-3 px-4 py-3 text-left transition-colors border-l-2 ${
                  isSelected
                    ? 'bg-[#EEF7FD] border-[#5BBFE8]'
                    : 'hover:bg-gray-50 border-transparent'
                }`}
              >
                <Avatar name={group.name} />

                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-1.5 mb-0.5">
                    <span className={`text-sm font-medium truncate ${isSelected ? 'text-[#1E6F96]' : 'text-gray-800'}`}>
                      {group.name}
                    </span>
                    {group.isAdmin && (
                      <span className="text-[10px] bg-[#EEF7FD] text-[#3AAAD4] px-1.5 py-0.5 rounded font-medium flex-shrink-0">
                        admin
                      </span>
                    )}
                  </div>
                  <p className="text-[11px] text-gray-400 truncate">{group.folder}</p>
                </div>

                {/* Agent state dot */}
                <span className={`w-2 h-2 rounded-full flex-shrink-0 transition-colors ${
                  isProcessing ? 'bg-yellow-400 animate-pulse' : isSelected ? 'bg-[#5BBFE8]/30' : 'bg-gray-200'
                }`} />
              </button>
            );
          })
        )}
      </nav>

      {/* Bottom icons: Settings + Wiki */}
      <div className="border-t border-gray-100 flex-shrink-0 flex items-center">
        {/* Settings */}
        <button
          onClick={onOpenSettings}
          title="Settings"
          className="flex-1 flex items-center justify-center gap-1.5 px-3 py-3 text-gray-400 hover:text-gray-600 hover:bg-gray-50 transition-colors"
        >
          <svg xmlns="http://www.w3.org/2000/svg" className="w-4 h-4 flex-shrink-0" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" d="M9.594 3.94c.09-.542.56-.94 1.11-.94h2.593c.55 0 1.02.398 1.11.94l.213 1.281c.063.374.313.686.645.87.074.04.147.083.22.127.325.196.72.257 1.075.124l1.217-.456a1.125 1.125 0 0 1 1.37.49l1.296 2.247a1.125 1.125 0 0 1-.26 1.431l-1.003.827c-.293.241-.438.613-.43.992a7.723 7.723 0 0 1 0 .255c-.008.378.137.75.43.991l1.004.827c.424.35.534.955.26 1.43l-1.298 2.247a1.125 1.125 0 0 1-1.369.491l-1.217-.456c-.355-.133-.75-.072-1.076.124a6.47 6.47 0 0 1-.22.128c-.331.183-.581.495-.644.869l-.213 1.281c-.09.543-.56.94-1.11.94h-2.594c-.55 0-1.019-.398-1.11-.94l-.213-1.281c-.062-.374-.312-.686-.644-.87a6.52 6.52 0 0 1-.22-.127c-.325-.196-.72-.257-1.076-.124l-1.217.456a1.125 1.125 0 0 1-1.369-.49l-1.297-2.247a1.125 1.125 0 0 1 .26-1.431l1.004-.827c.292-.24.437-.613.43-.991a6.932 6.932 0 0 1 0-.255c.007-.38-.138-.751-.43-.992l-1.004-.827a1.125 1.125 0 0 1-.26-1.43l1.297-2.247a1.125 1.125 0 0 1 1.37-.491l1.216.456c.356.133.751.072 1.076-.124.072-.044.146-.086.22-.128.332-.183.582-.495.644-.869l.214-1.28Z" />
            <path strokeLinecap="round" strokeLinejoin="round" d="M15 12a3 3 0 1 1-6 0 3 3 0 0 1 6 0Z" />
          </svg>
          <span className="text-xs font-medium">Settings</span>
        </button>

        {/* Plugins — opens in new tab */}
        <a
          href="/plugins"
          target="_blank"
          rel="noopener noreferrer"
          title="Plugins"
          className="flex-1 flex items-center justify-center gap-1.5 px-3 py-3 text-gray-400 hover:text-gray-600 hover:bg-gray-50 transition-colors"
        >
          {/* Puzzle piece icon */}
          <svg className="w-4 h-4 flex-shrink-0" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" d="M14.25 6.087c0-.355.186-.676.401-.959.221-.29.349-.634.349-1.003 0-1.036-1.007-1.875-2.25-1.875s-2.25.84-2.25 1.875c0 .369.128.713.349 1.003.215.283.401.604.401.959v0a.64.64 0 0 1-.657.643 48.39 48.39 0 0 1-4.163-.3c.186 1.613.293 3.25.315 4.907a.656.656 0 0 1-.658.663v0c-.355 0-.676-.186-.959-.401a1.647 1.647 0 0 0-1.003-.349c-1.036 0-1.875 1.007-1.875 2.25s.84 2.25 1.875 2.25c.369 0 .713-.128 1.003-.349.283-.215.604-.401.959-.401v0c.31 0 .555.26.532.57a48.039 48.039 0 0 1-.642 5.056c1.518.19 3.058.309 4.616.354a.64.64 0 0 0 .657-.643v0c0-.355-.186-.676-.401-.959a1.647 1.647 0 0 1-.349-1.003c0-1.035 1.008-1.875 2.25-1.875 1.243 0 2.25.84 2.25 1.875 0 .369-.128.713-.349 1.003-.215.283-.4.604-.4.959v0c0 .333.277.599.61.58a48.1 48.1 0 0 0 5.427-.63 48.05 48.05 0 0 0 .582-4.717.532.532 0 0 0-.533-.57v0c-.355 0-.676.186-.959.401-.29.221-.634.349-1.003.349-1.035 0-1.875-1.007-1.875-2.25s.84-2.25 1.875-2.25c.37 0 .713.128 1.003.349.283.215.604.401.959.401v0a.656.656 0 0 0 .658-.663 48.422 48.422 0 0 0-.37-5.36c-1.886.342-3.81.574-5.766.689a.578.578 0 0 1-.61-.58v0Z" />
          </svg>
          <span className="text-xs font-medium">Plugins</span>
        </a>

        {/* Wiki — opens in new tab */}
        <a
          href="/wiki"
          target="_blank"
          rel="noopener noreferrer"
          title="Wiki 知识库"
          className="flex-1 flex items-center justify-center gap-1.5 px-3 py-3 text-gray-400 hover:text-gray-600 hover:bg-gray-50 transition-colors"
        >
          <svg className="w-4 h-4 flex-shrink-0" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" d="M12 6.042A8.967 8.967 0 0 0 6 3.75c-1.052 0-2.062.18-3 .512v14.25A8.987 8.987 0 0 1 6 18c2.305 0 4.408.867 6 2.292m0-14.25a8.966 8.966 0 0 1 6-2.292c1.052 0 2.062.18 3 .512v14.25A8.987 8.987 0 0 0 18 18a8.967 8.967 0 0 0-6 2.292m0-14.25v14.25" />
          </svg>
          <span className="text-xs font-medium">Wiki</span>
        </a>
      </div>
    </aside>
  );
}
