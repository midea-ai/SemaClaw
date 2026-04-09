import { useState } from 'react';
import type { AgentTodosEntry } from '../types';

const AGENT_COLORS: Record<string, string> = {
  'web-backend':   '#6366f1',
  'web-frontend':  '#10b981',
  'web-creative':  '#f59e0b',
  'web-qa':        '#ef4444',
};

function agentColor(folder: string): string {
  return AGENT_COLORS[folder] ?? '#8b5cf6';
}

function agentInitials(name: string): string {
  return name.substring(0, 2).toUpperCase();
}

interface AgentTodoPanelProps {
  agentTodos: Record<string, AgentTodosEntry>; // keyed by jid
  groups: { jid: string; folder: string; name: string }[];
}

export function AgentTodoPanel({ agentTodos, groups }: AgentTodoPanelProps) {
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());

  const entries = Object.entries(agentTodos).filter(([, v]) => v.todos.length > 0);
  if (entries.length === 0) return null;

  const toggle = (jid: string) =>
    setCollapsed(prev => {
      const next = new Set(prev);
      next.has(jid) ? next.delete(jid) : next.add(jid);
      return next;
    });

  return (
    <div className="flex flex-col gap-2">
      {entries.map(([jid, entry]) => {
        const group = groups.find(g => g.jid === jid);
        const folder = group?.folder ?? '';
        const color = agentColor(folder);
        const init = agentInitials(entry.agentName);
        const done = entry.todos.filter(t => t.status === 'completed').length;
        const total = entry.todos.length;
        const pct = total > 0 ? Math.round((done / total) * 100) : 0;
        const isOpen = !collapsed.has(jid);

        return (
          <div key={jid} className="border border-gray-100 rounded-lg bg-white overflow-hidden">
            <button
              className="w-full flex items-center gap-2 px-3 py-2 bg-gray-50 hover:bg-gray-100 transition-colors"
              onClick={() => toggle(jid)}
            >
              <div
                className="w-6 h-6 rounded-full flex items-center justify-center text-white text-[10px] font-bold flex-shrink-0"
                style={{ background: color }}
              >
                {init}
              </div>
              <span className="flex-1 text-left text-xs font-semibold text-gray-700">{entry.agentName}</span>
              <div className="flex items-center gap-2 text-[10px] text-gray-400">
                <span className="text-green-600 font-medium">{done}✓</span>
                <span>{total - done - entry.todos.filter(t => t.status === 'in_progress').length}⬜</span>
                <div className="w-12 h-1 bg-gray-200 rounded-full overflow-hidden">
                  <div className="h-full bg-green-500 rounded-full transition-all" style={{ width: `${pct}%` }} />
                </div>
              </div>
              <span className="text-gray-400 text-[10px]">{isOpen ? '▾' : '▸'}</span>
            </button>

            {isOpen && (
              <div className="flex flex-col gap-1 p-2">
                {entry.todos.map((t) => (
                  <div
                    key={t.content}
                    className={`flex items-start gap-2 px-2 py-1.5 rounded text-[11px] border ${
                      t.status === 'completed' ? 'bg-green-50 border-green-100' :
                      t.status === 'in_progress' ? 'bg-blue-50 border-blue-100' :
                      'bg-gray-50 border-gray-100'
                    }`}
                  >
                    <span className={`mt-0.5 flex-shrink-0 ${
                      t.status === 'completed' ? 'text-green-600' :
                      t.status === 'in_progress' ? 'text-blue-500' :
                      'text-gray-400'
                    }`}>
                      {t.status === 'completed' ? '✓' : t.status === 'in_progress' ? '↻' : '–'}
                    </span>
                    <div className="flex-1 min-w-0">
                      <p className={`leading-snug ${t.status === 'completed' ? 'line-through text-gray-400' : 'text-gray-700 font-medium'}`}>
                        {t.content}
                      </p>
                      {t.activeForm && (
                        <p className="text-[10px] text-amber-600 bg-amber-50 px-1.5 py-0.5 rounded mt-0.5 inline-block">
                          {t.activeForm}
                        </p>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
