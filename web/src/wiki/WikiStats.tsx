/**
 * WikiStats — 知识权重/分布页
 */

import { useEffect } from 'react';
import type { WikiStats as WikiStatsType, TagEntry } from '../hooks/useWiki';

interface Props {
  stats: WikiStats | null;
  tags: TagEntry[];
  fetchStats: () => void;
  fetchTags: () => void;
}

type WikiStats = WikiStatsType;

export function WikiStats({ stats, tags, fetchStats, fetchTags }: Props) {
  useEffect(() => {
    fetchStats();
    fetchTags();
  }, [fetchStats, fetchTags]);

  if (!stats) {
    return (
      <div className="flex-1 flex items-center justify-center text-sm text-gray-400">加载中...</div>
    );
  }

  const maxCat = Math.max(...stats.byCategory.map(c => c.count), 1);

  return (
    <div className="flex-1 overflow-y-auto">
      <div className="max-w-2xl mx-auto px-8 py-8">
        <h1 className="text-base font-semibold text-gray-700 mb-6">知识分布</h1>

        {/* Summary */}
        <div className="flex gap-4 mb-8 text-sm text-gray-500">
          <span>共 <strong className="text-gray-800">{stats.totalFiles}</strong> 篇</span>
          <span><strong className="text-gray-800">{stats.totalDirs}</strong> 个目录</span>
          <span><strong className="text-gray-800">{tags.length}</strong> 个标签</span>
        </div>

        {/* Category bars */}
        {stats.byCategory.length > 0 && (
          <div className="mb-8">
            <h2 className="text-xs font-semibold text-gray-400 uppercase tracking-wide mb-4">按目录</h2>
            <div className="space-y-3">
              {stats.byCategory.map(cat => {
                const pct = Math.round((cat.count / maxCat) * 100);
                return (
                  <div key={cat.dir}>
                    <div className="flex items-center justify-between text-sm mb-1">
                      <span className="font-medium text-gray-700">{cat.dir}</span>
                      <span className="text-gray-400 text-xs">{cat.count} 篇</span>
                    </div>
                    <div className="h-2 bg-gray-100 rounded-full overflow-hidden">
                      <div
                        className="h-full bg-amber-400 rounded-full transition-all duration-500"
                        style={{ width: `${pct}%` }}
                      />
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        )}

        {/* Tag cloud */}
        {tags.length > 0 && (
          <div>
            <h2 className="text-xs font-semibold text-gray-400 uppercase tracking-wide mb-4">热门标签</h2>
            <div className="flex flex-wrap gap-2">
              {tags.map(t => {
                const size = Math.max(11, Math.min(16, 11 + Math.log(t.count + 1) * 2));
                return (
                  <span
                    key={t.name}
                    className="px-2.5 py-1 bg-gray-100 text-gray-600 rounded-full cursor-default"
                    style={{ fontSize: `${size}px` }}
                    title={`${t.count} 篇`}
                  >
                    {t.name}
                    <span className="ml-1 text-gray-400 text-[10px]">×{t.count}</span>
                  </span>
                );
              })}
            </div>
          </div>
        )}

        {stats.totalFiles === 0 && (
          <div className="text-center py-12 text-gray-400 text-sm">暂无数据</div>
        )}
      </div>
    </div>
  );
}
