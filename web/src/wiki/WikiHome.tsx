/**
 * WikiHome — Wiki 首页
 * 展示最近修改 + 标签云，文件数 >100 时切换为搜索优先模式
 */

import { useEffect } from 'react';
import type { WikiStats, TagEntry, DirNode } from '../hooks/useWiki';

interface Props {
  stats: WikiStats | null;
  tags: TagEntry[];
  tree: DirNode[];
  onSelectDoc: (path: string) => void;
  onSearch: (q: string) => void;
  fetchStats: () => void;
  fetchTags: () => void;
}

function relativeTime(iso: string): string {
  if (!iso) return '';
  const diff = Date.now() - new Date(iso).getTime();
  const m = Math.floor(diff / 60000);
  if (m < 1) return '刚刚';
  if (m < 60) return `${m}分钟前`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}小时前`;
  const d = Math.floor(h / 24);
  return `${d}天前`;
}

export function WikiHome({ stats, tags, onSelectDoc, onSearch, fetchStats, fetchTags }: Props) {
  useEffect(() => {
    fetchStats();
    fetchTags();
  }, [fetchStats, fetchTags]);

  const isLarge = (stats?.totalFiles ?? 0) > 100;

  return (
    <div className="flex-1 overflow-y-auto">
      <div className="max-w-3xl mx-auto px-8 py-8">

        {/* Search-first header (when large) */}
        {isLarge && (
          <div className="mb-8">
            <input
              type="text"
              placeholder="搜索知识库..."
              onFocus={() => {/* handled by sidebar */}}
              className="w-full px-4 py-3 text-sm bg-gray-50 rounded-xl border border-gray-200 outline-none focus:ring-2 focus:ring-amber-200 focus:bg-white transition-all"
              onClick={() => onSearch('')}
              readOnly
            />
          </div>
        )}

        {/* Stats overview */}
        {stats && (
          <div className="grid grid-cols-3 gap-4 mb-8">
            <div className="bg-amber-50 rounded-xl p-4 text-center">
              <div className="text-2xl font-bold text-amber-700">{stats.totalFiles}</div>
              <div className="text-xs text-amber-600 mt-0.5">篇文档</div>
            </div>
            <div className="bg-blue-50 rounded-xl p-4 text-center">
              <div className="text-2xl font-bold text-blue-700">{stats.totalDirs}</div>
              <div className="text-xs text-blue-600 mt-0.5">个目录</div>
            </div>
            <div className="bg-green-50 rounded-xl p-4 text-center">
              <div className="text-2xl font-bold text-green-700">{tags.length}</div>
              <div className="text-xs text-green-600 mt-0.5">个标签</div>
            </div>
          </div>
        )}

        <div className="grid grid-cols-2 gap-6">
          {/* Recent files */}
          {stats && stats.recentFiles.length > 0 && (
            <div>
              <h2 className="text-xs font-semibold text-gray-400 uppercase tracking-wide mb-3">最近修改</h2>
              <div className="space-y-1">
                {stats.recentFiles.slice(0, 8).map(f => (
                  <button
                    key={f.path}
                    onClick={() => onSelectDoc(f.path)}
                    className="w-full text-left px-3 py-2.5 rounded-lg hover:bg-gray-50 transition-colors group"
                  >
                    <div className="text-sm text-gray-700 group-hover:text-gray-900 truncate font-medium">{f.title}</div>
                    <div className="flex items-center gap-2 mt-0.5">
                      <span className="text-[11px] text-gray-400 truncate flex-1">{f.path}</span>
                      <span className="text-[11px] text-gray-300 flex-shrink-0">{relativeTime(f.updated)}</span>
                    </div>
                  </button>
                ))}
              </div>
            </div>
          )}

          {/* Tag cloud */}
          {tags.length > 0 && (
            <div>
              <h2 className="text-xs font-semibold text-gray-400 uppercase tracking-wide mb-3">标签</h2>
              <div className="flex flex-wrap gap-2">
                {tags.slice(0, 24).map(t => (
                  <button
                    key={t.name}
                    onClick={() => onSearch(t.name)}
                    className="px-2.5 py-1 bg-gray-100 hover:bg-amber-50 text-gray-600 hover:text-amber-700 rounded-full text-xs transition-colors"
                    title={`${t.count} 篇`}
                  >
                    {t.name}
                    <span className="ml-1 text-gray-400 text-[10px]">{t.count}</span>
                  </button>
                ))}
              </div>

              {/* Category breakdown */}
              {stats && stats.byCategory.length > 0 && (
                <div className="mt-6">
                  <h2 className="text-xs font-semibold text-gray-400 uppercase tracking-wide mb-3">分类</h2>
                  <div className="space-y-2">
                    {stats.byCategory.slice(0, 8).map(cat => {
                      const max = stats.byCategory[0]?.count ?? 1;
                      const pct = Math.round((cat.count / max) * 100);
                      return (
                        <div key={cat.dir}>
                          <div className="flex items-center justify-between text-xs mb-1">
                            <span className="text-gray-600 font-medium">{cat.dir}</span>
                            <span className="text-gray-400">{cat.count}</span>
                          </div>
                          <div className="h-1.5 bg-gray-100 rounded-full overflow-hidden">
                            <div
                              className="h-full bg-amber-300 rounded-full transition-all"
                              style={{ width: `${pct}%` }}
                            />
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </div>
              )}
            </div>
          )}
        </div>

        {/* Empty state */}
        {stats && stats.totalFiles === 0 && (
          <div className="text-center py-16 text-gray-400">
            <svg className="w-12 h-12 mx-auto mb-4 opacity-30" fill="none" viewBox="0 0 24 24" strokeWidth={1} stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" d="M12 6.042A8.967 8.967 0 0 0 6 3.75c-1.052 0-2.062.18-3 .512v14.25A8.987 8.987 0 0 1 6 18c2.305 0 4.408.867 6 2.292m0-14.25a8.966 8.966 0 0 1 6-2.292c1.052 0 2.062.18 3 .512v14.25A8.987 8.987 0 0 0 18 18a8.967 8.967 0 0 0-6 2.292m0-14.25v14.25" />
            </svg>
            <p className="text-sm">知识库还没有内容</p>
            <p className="text-xs mt-1">告诉 Agent「放入 wiki」即可开始积累</p>
          </div>
        )}
      </div>
    </div>
  );
}
