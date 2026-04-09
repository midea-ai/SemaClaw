/**
 * WikiSidebar — wiki 区内部左侧边栏
 * 包含搜索框 + 目录树 + 底部标签导航
 */

import { useState, useEffect } from 'react';
import type { DirNode, SearchResult } from '../hooks/useWiki';

interface Props {
  tree: DirNode[];
  treeLoading: boolean;
  searchResults: SearchResult[];
  searching: boolean;
  selectedPath: string | null;
  activeView: 'home' | 'doc' | 'stats' | 'categories';
  onSelectDoc: (path: string) => void;
  onSearch: (q: string) => void;
  onClearSearch: () => void;
  onShowStats: () => void;
  onShowCategories: () => void;
  onShowHome: () => void;
}

function FileIcon() {
  return (
    <svg className="w-3.5 h-3.5 flex-shrink-0 text-gray-400" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor">
      <path strokeLinecap="round" strokeLinejoin="round" d="M19.5 14.25v-2.625a3.375 3.375 0 0 0-3.375-3.375h-1.5A1.125 1.125 0 0 1 13.5 7.125v-1.5a3.375 3.375 0 0 0-3.375-3.375H8.25m0 12.75h7.5m-7.5 3H12M10.5 2.25H5.625c-.621 0-1.125.504-1.125 1.125v17.25c0 .621.504 1.125 1.125 1.125h12.75c.621 0 1.125-.504 1.125-1.125V11.25a9 9 0 0 0-9-9Z" />
    </svg>
  );
}

function DirIcon({ open }: { open: boolean }) {
  return (
    <svg className="w-3.5 h-3.5 flex-shrink-0 text-gray-400" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor">
      {open
        ? <path strokeLinecap="round" strokeLinejoin="round" d="M3.75 9.776c.112-.017.227-.026.344-.026h15.812c.117 0 .232.009.344.026m-16.5 0a2.25 2.25 0 0 0-1.883 2.542l.857 6a2.25 2.25 0 0 0 2.227 1.932H19.05a2.25 2.25 0 0 0 2.227-1.932l.857-6a2.25 2.25 0 0 0-1.883-2.542m-16.5 0V6A2.25 2.25 0 0 1 6 3.75h3.879a1.5 1.5 0 0 1 1.06.44l2.122 2.12a1.5 1.5 0 0 0 1.06.44H18A2.25 2.25 0 0 1 20.25 9v.776" />
        : <path strokeLinecap="round" strokeLinejoin="round" d="M2.25 12.75V12A2.25 2.25 0 0 1 4.5 9.75h15A2.25 2.25 0 0 1 21.75 12v.75m-8.69-6.44-2.12-2.12a1.5 1.5 0 0 0-1.061-.44H4.5A2.25 2.25 0 0 0 2.25 6v12a2.25 2.25 0 0 0 2.25 2.25h15A2.25 2.25 0 0 0 21.75 18V9a2.25 2.25 0 0 0-2.25-2.25h-5.379a1.5 1.5 0 0 1-1.06-.44Z" />
      }
    </svg>
  );
}

function TreeNode({
  node, depth, selectedPath, onSelectDoc,
}: {
  node: DirNode;
  depth: number;
  selectedPath: string | null;
  onSelectDoc: (path: string) => void;
}) {
  const [open, setOpen] = useState(depth === 0);
  const indent = depth * 12;

  if (node.type === 'file') {
    const isSelected = node.path === selectedPath;
    const name = node.name.replace(/\.md$/, '');
    return (
      <button
        onClick={() => onSelectDoc(node.path)}
        className={`w-full flex items-center gap-1.5 py-1 px-2 text-left rounded text-xs transition-colors ${
          isSelected ? 'bg-amber-50 text-amber-800' : 'text-gray-600 hover:bg-gray-50 hover:text-gray-800'
        }`}
        style={{ paddingLeft: `${indent + 8}px` }}
        title={node.path}
      >
        <FileIcon />
        <span className="truncate">{name}</span>
      </button>
    );
  }

  const fileCount = countFiles(node);
  return (
    <div>
      <button
        onClick={() => setOpen(o => !o)}
        className="w-full flex items-center gap-1.5 py-1 px-2 text-left rounded text-xs text-gray-700 hover:bg-gray-50 transition-colors"
        style={{ paddingLeft: `${indent + 8}px` }}
      >
        <span className="w-2.5 flex-shrink-0 text-gray-300 text-[10px]">{open ? '▾' : '▸'}</span>
        <DirIcon open={open} />
        <span className="font-medium truncate">{node.name}</span>
        {fileCount > 0 && (
          <span className="ml-auto text-[10px] text-gray-300 flex-shrink-0 pr-1">{fileCount}</span>
        )}
      </button>
      {open && node.children && (
        <div>
          {node.children.map(child => (
            <TreeNode
              key={child.path}
              node={child}
              depth={depth + 1}
              selectedPath={selectedPath}
              onSelectDoc={onSelectDoc}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function countFiles(node: DirNode): number {
  if (node.type === 'file') return 1;
  return (node.children ?? []).reduce((s, c) => s + countFiles(c), 0);
}

export function WikiSidebar({
  tree, treeLoading, searchResults, searching,
  selectedPath, activeView,
  onSelectDoc, onSearch, onClearSearch, onShowStats, onShowCategories, onShowHome,
}: Props) {
  const [query, setQuery] = useState('');

  useEffect(() => {
    if (!query.trim()) { onClearSearch(); return; }
    const t = setTimeout(() => onSearch(query.trim()), 250);
    return () => clearTimeout(t);
  }, [query, onSearch, onClearSearch]);

  const isSearching = query.trim().length > 0;

  return (
    <aside className="w-56 flex flex-col border-r border-gray-100 bg-white flex-shrink-0">
      {/* Header */}
      <div className="px-3 py-3 border-b border-gray-100">
        <button
          onClick={onShowHome}
          className="text-xs font-semibold text-gray-500 hover:text-gray-800 transition-colors tracking-wide uppercase"
        >
          Wiki
        </button>
      </div>

      {/* Search */}
      <div className="px-3 py-2 border-b border-gray-50">
        <div className="relative">
          <svg className="absolute left-2 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-gray-300" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" d="m21 21-5.197-5.197m0 0A7.5 7.5 0 1 0 5.196 5.196a7.5 7.5 0 0 0 10.607 10.607Z" />
          </svg>
          <input
            type="text"
            value={query}
            onChange={e => setQuery(e.target.value)}
            placeholder="搜索..."
            className="w-full pl-7 pr-2 py-1.5 text-xs bg-gray-50 rounded border-0 outline-none focus:bg-white focus:ring-1 focus:ring-amber-200 transition-all placeholder-gray-300"
          />
          {query && (
            <button onClick={() => setQuery('')} className="absolute right-2 top-1/2 -translate-y-1/2 text-gray-300 hover:text-gray-500">
              <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" d="M6 18 18 6M6 6l12 12" />
              </svg>
            </button>
          )}
        </div>
      </div>

      {/* Content: search results OR tree */}
      <div className="flex-1 overflow-y-auto py-1 min-h-0">
        {isSearching ? (
          <div>
            {searching && <p className="px-3 py-2 text-xs text-gray-400">搜索中...</p>}
            {!searching && searchResults.length === 0 && (
              <p className="px-3 py-2 text-xs text-gray-400">无匹配结果</p>
            )}
            {searchResults.map(r => (
              <button
                key={r.path}
                onClick={() => { onSelectDoc(r.path); setQuery(''); }}
                className={`w-full text-left px-3 py-2 hover:bg-gray-50 transition-colors ${r.path === selectedPath ? 'bg-amber-50' : ''}`}
              >
                <div className="text-xs font-medium text-gray-700 truncate">{r.title}</div>
                <div className="text-[10px] text-gray-400 truncate mt-0.5">{r.path}</div>
                {r.tags.length > 0 && (
                  <div className="flex flex-wrap gap-1 mt-1">
                    {r.tags.slice(0, 3).map(t => (
                      <span key={t} className="text-[9px] bg-amber-50 text-amber-600 px-1 rounded">{t}</span>
                    ))}
                  </div>
                )}
              </button>
            ))}
          </div>
        ) : (
          <div>
            {treeLoading && <p className="px-3 py-3 text-xs text-gray-400">加载中...</p>}
            {!treeLoading && tree.length === 0 && (
              <p className="px-3 py-3 text-xs text-gray-400">知识库为空</p>
            )}
            {tree.map(node => (
              <TreeNode
                key={node.path}
                node={node}
                depth={0}
                selectedPath={selectedPath}
                onSelectDoc={onSelectDoc}
              />
            ))}
          </div>
        )}
      </div>

      {/* Bottom nav */}
      <div className="border-t border-gray-100 flex-shrink-0 px-2 py-2 flex gap-1">
        <button
          onClick={onShowStats}
          title="知识分布"
          className={`flex-1 flex items-center justify-center gap-1 py-1.5 rounded text-[11px] transition-colors ${
            activeView === 'stats' ? 'bg-amber-50 text-amber-700' : 'text-gray-400 hover:text-gray-600 hover:bg-gray-50'
          }`}
        >
          <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" d="M3 13.125C3 12.504 3.504 12 4.125 12h2.25c.621 0 1.125.504 1.125 1.125v6.75C7.5 20.496 6.996 21 6.375 21h-2.25A1.125 1.125 0 0 1 3 19.875v-6.75ZM9.75 8.625c0-.621.504-1.125 1.125-1.125h2.25c.621 0 1.125.504 1.125 1.125v11.25c0 .621-.504 1.125-1.125 1.125h-2.25a1.125 1.125 0 0 1-1.125-1.125V8.625ZM16.5 4.125c0-.621.504-1.125 1.125-1.125h2.25C20.496 3 21 3.504 21 4.125v15.75c0 .621-.504 1.125-1.125 1.125h-2.25a1.125 1.125 0 0 1-1.125-1.125V4.125Z" />
          </svg>
          <span>统计</span>
        </button>
        <button
          onClick={onShowCategories}
          title="分类管理"
          className={`flex-1 flex items-center justify-center gap-1 py-1.5 rounded text-[11px] transition-colors ${
            activeView === 'categories' ? 'bg-amber-50 text-amber-700' : 'text-gray-400 hover:text-gray-600 hover:bg-gray-50'
          }`}
        >
          <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" d="M2.25 12.75V12A2.25 2.25 0 0 1 4.5 9.75h15A2.25 2.25 0 0 1 21.75 12v.75m-8.69-6.44-2.12-2.12a1.5 1.5 0 0 0-1.061-.44H4.5A2.25 2.25 0 0 0 2.25 6v12a2.25 2.25 0 0 0 2.25 2.25h15A2.25 2.25 0 0 0 21.75 18V9a2.25 2.25 0 0 0-2.25-2.25h-5.379a1.5 1.5 0 0 1-1.06-.44Z" />
          </svg>
          <span>目录</span>
        </button>
      </div>
    </aside>
  );
}
