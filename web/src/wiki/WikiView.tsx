/**
 * WikiView — Wiki 全屏子页面
 * 完整替换聊天布局，顶部 navbar 含房子图标返回
 */

import { useEffect, useCallback, useState } from 'react';
import { useWiki } from '../hooks/useWiki';
import { WikiSidebar } from './WikiSidebar';
import { WikiHome } from './WikiHome';
import { WikiDoc } from './WikiDoc';
import { WikiStats } from './WikiStats';
import { WikiCategories } from './WikiCategories';

type InnerView = 'home' | 'doc' | 'stats' | 'categories';

interface Props {
  onGoHome: () => void;
}

export default function WikiView({ onGoHome }: Props) {
  const [innerView, setInnerView] = useState<InnerView>('home');
  const [selectedPath, setSelectedPath] = useState<string | null>(null);

  const wiki = useWiki();

  useEffect(() => {
    wiki.fetchTree();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleSelectDoc = useCallback((path: string) => {
    setSelectedPath(path);
    setInnerView('doc');
  }, []);

  const handleSearch = useCallback((q: string) => {
    wiki.search(q);
  }, [wiki]);

  const handleClearSearch = useCallback(() => {
    wiki.clearSearch();
  }, [wiki]);

  const handleSaveDoc = useCallback(async (path: string, content: string) => {
    await wiki.saveDoc(path, content);
  }, [wiki]);

  const handleRefreshDoc = useCallback((path: string) => {
    wiki.fetchDoc(path);
  }, [wiki]);

  const viewLabel: Record<InnerView, string> = {
    home: '',
    doc: selectedPath ?? '',
    stats: '知识分布',
    categories: '目录管理',
  };

  return (
    <div className="flex flex-col h-screen bg-white overflow-hidden">
      {/* Top navbar */}
      <header className="flex items-center gap-3 px-4 h-11 border-b border-gray-100 flex-shrink-0 bg-white">
        {/* Home button */}
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

        {/* Wiki icon + title */}
        <div className="flex items-center gap-2">
          <svg className="w-4 h-4 text-amber-500 flex-shrink-0" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" d="M12 6.042A8.967 8.967 0 0 0 6 3.75c-1.052 0-2.062.18-3 .512v14.25A8.987 8.987 0 0 1 6 18c2.305 0 4.408.867 6 2.292m0-14.25a8.966 8.966 0 0 1 6-2.292c1.052 0 2.062.18 3 .512v14.25A8.987 8.987 0 0 0 18 18a8.967 8.967 0 0 0-6 2.292m0-14.25v14.25" />
          </svg>
          <span className="text-sm font-semibold text-gray-700">Wiki</span>
        </div>

        {/* Breadcrumb for current sub-view */}
        {viewLabel[innerView] && (
          <>
            <span className="text-gray-200 select-none">/</span>
            <span className="text-xs text-gray-400 truncate max-w-xs">{viewLabel[innerView]}</span>
          </>
        )}
      </header>

      {/* Body */}
      <div className="flex flex-1 min-h-0 overflow-hidden">
        <WikiSidebar
          tree={wiki.tree}
          treeLoading={wiki.treeLoading}
          searchResults={wiki.searchResults}
          searching={wiki.searching}
          selectedPath={selectedPath}
          activeView={innerView}
          onSelectDoc={handleSelectDoc}
          onSearch={handleSearch}
          onClearSearch={handleClearSearch}
          onShowStats={() => setInnerView('stats')}
          onShowCategories={() => setInnerView('categories')}
          onShowHome={() => { setInnerView('home'); setSelectedPath(null); }}
        />

        {/* Main content */}
        <div className="flex-1 flex flex-col overflow-hidden">
          {innerView === 'home' && (
            <WikiHome
              stats={wiki.stats}
              tags={wiki.tags}
              tree={wiki.tree}
              onSelectDoc={handleSelectDoc}
              onSearch={handleSearch}
              fetchStats={wiki.fetchStats}
              fetchTags={wiki.fetchTags}
            />
          )}

          {innerView === 'doc' && selectedPath && (
            <WikiDoc
              path={selectedPath}
              doc={wiki.doc}
              loading={wiki.docLoading}
              onBack={() => { setInnerView('home'); setSelectedPath(null); wiki.clearDoc(); }}
              onLoad={wiki.fetchDoc}
              onSave={handleSaveDoc}
              onRefresh={handleRefreshDoc}
            />
          )}

          {innerView === 'stats' && (
            <WikiStats
              stats={wiki.stats}
              tags={wiki.tags}
              fetchStats={wiki.fetchStats}
              fetchTags={wiki.fetchTags}
            />
          )}

          {innerView === 'categories' && (
            <WikiCategories
              tree={wiki.tree}
              treeLoading={wiki.treeLoading}
              onRefreshTree={wiki.fetchTree}
              onMkdir={wiki.mkdir}
              onDeleteDir={wiki.deleteDir}
              onSelectDoc={handleSelectDoc}
            />
          )}
        </div>
      </div>

      {/* Error toast */}
      {wiki.error && (
        <div className="fixed bottom-4 right-4 bg-red-50 border border-red-200 text-red-700 text-xs px-4 py-2.5 rounded-lg shadow-sm max-w-sm">
          {wiki.error}
          <button onClick={wiki.clearError} className="ml-3 text-red-400 hover:text-red-600">✕</button>
        </div>
      )}
    </div>
  );
}
