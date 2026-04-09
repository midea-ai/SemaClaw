/**
 * PluginsView — Plugins 全屏子页面
 * 左侧导航栏支持 Skills / Subagents / Hooks 等扩展
 */

import { useState } from 'react';
import { SkillsPanel } from './SkillsPanel';

type NavItem = 'skills' | 'subagents' | 'hooks';

interface Props {
  onGoHome: () => void;
}

const NAV_ITEMS: { id: NavItem; label: string; icon: React.ReactNode; available: boolean }[] = [
  {
    id: 'skills',
    label: 'Skills',
    available: true,
    icon: (
      <svg className="w-4 h-4 flex-shrink-0" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor">
        <path strokeLinecap="round" strokeLinejoin="round" d="M3.75 13.5l10.5-11.25L12 10.5h8.25L9.75 21.75 12 13.5H3.75z" />
      </svg>
    ),
  },
  {
    id: 'subagents',
    label: 'Subagents',
    available: false,
    icon: (
      <svg className="w-4 h-4 flex-shrink-0" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor">
        <path strokeLinecap="round" strokeLinejoin="round" d="M18 18.72a9.094 9.094 0 0 0 3.741-.479 3 3 0 0 0-4.682-2.72m.94 3.198.001.031c0 .225-.012.447-.037.666A11.944 11.944 0 0 1 12 21c-2.17 0-4.207-.576-5.963-1.584A6.062 6.062 0 0 1 6 18.719m12 0a5.971 5.971 0 0 0-.941-3.197m0 0A5.995 5.995 0 0 0 12 12.75a5.995 5.995 0 0 0-5.058 2.772m0 0a3 3 0 0 0-4.681 2.72 8.986 8.986 0 0 0 3.74.477m.94-3.197a5.971 5.971 0 0 0-.94 3.197M15 6.75a3 3 0 1 1-6 0 3 3 0 0 1 6 0Zm6 3a2.25 2.25 0 1 1-4.5 0 2.25 2.25 0 0 1 4.5 0Zm-13.5 0a2.25 2.25 0 1 1-4.5 0 2.25 2.25 0 0 1 4.5 0Z" />
      </svg>
    ),
  },
  {
    id: 'hooks',
    label: 'Hooks',
    available: false,
    icon: (
      <svg className="w-4 h-4 flex-shrink-0" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor">
        <path strokeLinecap="round" strokeLinejoin="round" d="M17.25 6.75 22.5 12l-5.25 5.25m-10.5 0L1.5 12l5.25-5.25m7.5-3-4.5 16.5" />
      </svg>
    ),
  },
];

export default function PluginsView({ onGoHome }: Props) {
  const [activeNav, setActiveNav] = useState<NavItem>('skills');

  return (
    <div className="flex flex-col h-screen bg-white overflow-hidden">
      {/* Top navbar */}
      <header className="flex items-center gap-3 px-4 h-11 border-b border-gray-100 flex-shrink-0 bg-white">
        <button
          onClick={onGoHome}
          title="返回聊天"
          className="flex items-center justify-center w-7 h-7 rounded-lg text-gray-400 hover:text-gray-700 hover:bg-gray-100 transition-colors flex-shrink-0"
        >
          <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" strokeWidth={1.8} stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" d="m2.25 12 8.954-8.955c.44-.439 1.152-.439 1.591 0L21.75 12M4.5 9.75v10.125c0 .621.504 1.125 1.125 1.125H9.75v-4.875c0-.621.504-1.125 1.125-1.125h2.25c.621 0 1.125.504 1.125 1.125V21h4.125c.621 0 1.125-.504 1.125-1.125V9.75M8.25 21h8.25" />
          </svg>
        </button>

        <span className="text-gray-200 select-none">|</span>

        <div className="flex items-center gap-2">
          {/* Puzzle piece icon */}
          <svg className="w-4 h-4 text-violet-500 flex-shrink-0" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" d="M14.25 6.087c0-.355.186-.676.401-.959.221-.29.349-.634.349-1.003 0-1.036-1.007-1.875-2.25-1.875s-2.25.84-2.25 1.875c0 .369.128.713.349 1.003.215.283.401.604.401.959v0a.64.64 0 0 1-.657.643 48.39 48.39 0 0 1-4.163-.3c.186 1.613.293 3.25.315 4.907a.656.656 0 0 1-.658.663v0c-.355 0-.676-.186-.959-.401a1.647 1.647 0 0 0-1.003-.349c-1.036 0-1.875 1.007-1.875 2.25s.84 2.25 1.875 2.25c.369 0 .713-.128 1.003-.349.283-.215.604-.401.959-.401v0c.31 0 .555.26.532.57a48.039 48.039 0 0 1-.642 5.056c1.518.19 3.058.309 4.616.354a.64.64 0 0 0 .657-.643v0c0-.355-.186-.676-.401-.959a1.647 1.647 0 0 1-.349-1.003c0-1.035 1.008-1.875 2.25-1.875 1.243 0 2.25.84 2.25 1.875 0 .369-.128.713-.349 1.003-.215.283-.4.604-.4.959v0c0 .333.277.599.61.58a48.1 48.1 0 0 0 5.427-.63 48.05 48.05 0 0 0 .582-4.717.532.532 0 0 0-.533-.57v0c-.355 0-.676.186-.959.401-.29.221-.634.349-1.003.349-1.035 0-1.875-1.007-1.875-2.25s.84-2.25 1.875-2.25c.37 0 .713.128 1.003.349.283.215.604.401.959.401v0a.656.656 0 0 0 .658-.663 48.422 48.422 0 0 0-.37-5.36c-1.886.342-3.81.574-5.766.689a.578.578 0 0 1-.61-.58v0Z" />
          </svg>
          <span className="text-sm font-semibold text-gray-700">Plugins</span>
        </div>

        <span className="text-gray-200 select-none">/</span>
        <span className="text-xs text-gray-400">
          {NAV_ITEMS.find(n => n.id === activeNav)?.label}
        </span>
      </header>

      {/* Body */}
      <div className="flex flex-1 min-h-0 overflow-hidden">
        {/* Left sidebar nav */}
        <aside className="w-52 flex flex-col border-r border-gray-100 bg-white flex-shrink-0">
          <div className="px-3 py-3 border-b border-gray-100">
            <span className="text-xs font-semibold text-gray-500 tracking-wide uppercase">Plugins</span>
          </div>

          <nav className="flex-1 overflow-y-auto py-2 px-2">
            {NAV_ITEMS.map(item => (
              <button
                key={item.id}
                onClick={() => item.available && setActiveNav(item.id)}
                title={item.available ? item.label : '即将支持'}
                className={`w-full flex items-center gap-2.5 px-3 py-2 rounded-lg text-sm transition-colors mb-0.5 ${
                  !item.available
                    ? 'text-gray-300 cursor-not-allowed'
                    : activeNav === item.id
                    ? 'bg-violet-50 text-violet-700 font-medium'
                    : 'text-gray-600 hover:bg-gray-50 hover:text-gray-800'
                }`}
              >
                <span className={activeNav === item.id && item.available ? 'text-violet-500' : ''}>
                  {item.icon}
                </span>
                <span>{item.label}</span>
                {!item.available && (
                  <span className="ml-auto text-[10px] text-gray-300 font-normal">soon</span>
                )}
              </button>
            ))}
          </nav>
        </aside>

        {/* Main content */}
        <div className="flex-1 flex flex-col overflow-hidden bg-gray-50/30">
          {activeNav === 'skills' && <SkillsPanel />}
        </div>
      </div>
    </div>
  );
}
