import { useEffect, useMemo } from 'react';
import type { WorkbenchState, FormMessage } from '../types';
import { StaticRenderer } from './workbench/StaticRenderer';
import { WebRenderer } from './workbench/WebRenderer';
import { BackendRenderer } from './workbench/BackendRenderer';
import { HistoryList } from './workbench/HistoryList';
import { FormCard } from './FormCard';

interface Props {
  /** 当前激活 jid 的工作台状态 */
  state: WorkbenchState | null;
  /** 是否展开（由 App 控制 mutex） */
  expanded: boolean;
  onCollapse: () => void;
  /** 后端代读文件 */
  readFile: (artifactId: string, path: string) => Promise<{ content?: string; error?: string }>;
  /** 关闭 artifact */
  closeArtifact: (artifactId: string) => void;
  /** 切到某 artifact 为 current */
  selectArtifact: (artifactId: string) => void;
  /** 标记已查看（更新 last_active） */
  markViewed: (artifactId: string) => void;
  /** 当前活跃的 dock 表单（surface:'dock'），优先于 artifact 显示 */
  dockForm?: FormMessage | null;
  /** 提交 dock 表单 */
  onResolveForm?: (requestId: string, values: Record<string, unknown>, submitted: boolean) => void;
}

export function Workbench({ state, expanded, onCollapse, readFile, closeArtifact, selectArtifact, markViewed, dockForm, onResolveForm }: Props) {
  const current = state?.current ?? null;
  const history = state?.history ?? [];

  // current 切换时通知后端「已查看」
  useEffect(() => {
    if (expanded && current) markViewed(current.id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [expanded, current?.id]);

  const readFileForCurrent = useMemo(
    () => (path: string) => current ? readFile(current.id, path) : Promise.resolve({ error: 'no_current' }),
    [current?.id, readFile],
  );

  // 收起时不渲染（badge 由 App.tsx 的 DockBadges 渲染）
  if (!expanded) return null;

  return (
    <div className="flex flex-col flex-1 min-w-0 border-l border-gray-100 bg-[#F5F8FB] overflow-hidden">
      {/* Header */}
      <div className="flex items-center justify-between px-3 py-2 border-b border-gray-200 bg-white flex-shrink-0">
        <div className="flex items-center gap-2 min-w-0">
          <span className="text-sm font-semibold text-gray-700 truncate">
            {current ? current.title : dockForm ? dockForm.title : 'Workbench'}
          </span>
          {current && (
            <span className="text-[10px] text-gray-400 font-mono">{current.mode}</span>
          )}
        </div>
        <div className="flex items-center gap-1 flex-shrink-0">
          {current && (
            <button
              onClick={() => closeArtifact(current.id)}
              className="text-gray-400 hover:text-red-500 text-xs px-1.5 py-0.5 rounded hover:bg-gray-100"
              title="Close this workbench"
            >
              ✕ close
            </button>
          )}
          <button
            onClick={onCollapse}
            className="text-gray-400 hover:text-gray-600 text-xs px-1.5 py-0.5 rounded hover:bg-gray-100"
          >
            Hide ▸
          </button>
        </div>
      </div>

      {/* Body */}
      <div className="flex-1 min-h-0 flex flex-col">
        {/* dock 表单优先显示（活跃时在顶部，可滚动） */}
        {dockForm && onResolveForm && (
          <div className={`overflow-y-auto p-3 ${current ? 'border-b border-gray-200 max-h-[55%]' : 'flex-1'}`}>
            <FormCard message={dockForm} onResolve={onResolveForm} variant="dock" />
          </div>
        )}
        {/* artifact 区域（dock 表单存在且无 artifact 时不占位） */}
        <div className="flex-1 min-h-0 overflow-hidden">
          {!current ? (
            dockForm ? null : (
              <div className="flex h-full items-center justify-center text-xs text-gray-400 px-4 text-center">
                暂无内容
              </div>
            )
          ) : current.mode === 'static' ? (
            <StaticRenderer artifact={current} readFile={readFileForCurrent} />
          ) : current.mode === 'web' ? (
            <WebRenderer artifact={current} />
          ) : (
            <BackendRenderer artifact={current} />
          )}
        </div>
      </div>

      {/* History */}
      <HistoryList
        items={history}
        currentId={current?.id ?? null}
        onSelect={selectArtifact}
        onClose={closeArtifact}
      />
    </div>
  );
}
