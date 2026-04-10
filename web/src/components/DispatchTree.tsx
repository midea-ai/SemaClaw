import { useEffect, useRef } from 'react';
import type { DispatchParent, DispatchTask } from '../types';

const AGENT_COLORS: Record<string, string> = {
  'web-backend':   '#6366f1',
  'web-frontend':  '#10b981',
  'web-creative':  '#f59e0b',
  'web-qa':        '#ef4444',
};

function agentColor(agentId: string): string {
  if (agentId.startsWith('persona:')) return '#a855f7'; // purple for virtual
  return AGENT_COLORS[agentId] ?? '#8b5cf6';
}

function computeLevels(tasks: DispatchTask[]): DispatchTask[][] {
  const levels: DispatchTask[][] = [];
  const placed = new Set<string>();
  let current = tasks.filter(t => t.dependsOn.length === 0);
  while (current.length > 0) {
    levels.push(current);
    current.forEach(t => placed.add(t.label));
    current = tasks.filter(t => !placed.has(t.label) && t.dependsOn.every(d => placed.has(d)));
  }
  return levels;
}

function statusIcon(status: string): string {
  if (status === 'done') return '✓';
  if (status === 'processing') return '↻';
  if (status === 'error') return '✗';
  if (status === 'timeout') return '⏱';
  return '–';
}

function statusColors(status: string): string {
  if (status === 'done') return 'border-l-green-500 bg-green-50';
  if (status === 'processing') return 'border-l-[#5BBFE8] bg-blue-50';
  if (status === 'error') return 'border-l-red-500 bg-red-50';
  if (status === 'timeout') return 'border-l-orange-500 bg-orange-50';
  return 'border-l-gray-300 bg-white';
}

function statusIconColor(status: string): string {
  if (status === 'done') return 'text-green-600';
  if (status === 'processing') return 'text-[#5BBFE8]';
  if (status === 'error') return 'text-red-500';
  if (status === 'timeout') return 'text-orange-500';
  return 'text-gray-400';
}

interface DispatchTreeProps {
  parents: DispatchParent[];
  onSelectTask?: (task: DispatchTask) => void;
  selectedTaskId?: string;
  /** 主 admin agent 已暂停 — 正在执行的子任务显示暂停图标而非旋转动画 */
  adminPaused?: boolean;
}

export function DispatchTree({ parents, onSelectTask, selectedTaskId, adminPaused }: DispatchTreeProps) {
  const svgRef = useRef<SVGSVGElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  const drawLines = () => {
    const svg = svgRef.current;
    const container = containerRef.current;
    if (!svg || !container) return;
    svg.innerHTML = '';
    const svgRect = svg.getBoundingClientRect();

    parents.filter(p => p.status === 'active').forEach(p => {
      p.tasks.forEach(t => {
        if (!t.dependsOn.length) return;
        const toNode = document.getElementById(`dtask-${p.id}-${t.label}`);
        if (!toNode) return;
        t.dependsOn.forEach(dep => {
          const fromNode = document.getElementById(`dtask-${p.id}-${dep}`);
          if (!fromNode) return;
          const fromRect = fromNode.getBoundingClientRect();
          const toRect = toNode.getBoundingClientRect();
          const sx = fromRect.right - svgRect.left;
          const sy = fromRect.top + fromRect.height / 2 - svgRect.top;
          const ex = toRect.left - svgRect.left;
          const ey = toRect.top + toRect.height / 2 - svgRect.top;
          if (ex <= sx) return;
          const cpX = sx + (ex - sx) / 2;

          const fromDone = fromNode.getAttribute('data-status') === 'done';
          const toDone = t.status === 'done';
          const isActive = t.status === 'processing';
          const color = (fromDone && isActive) ? 'rgba(91,191,232,0.6)'
            : (fromDone && toDone) ? 'rgba(5,150,105,0.35)'
            : 'rgba(0,0,0,0.12)';

          const markerId = `arr-${p.id}-${t.label}-${dep}`;
          const defs = document.createElementNS('http://www.w3.org/2000/svg', 'defs');
          const marker = document.createElementNS('http://www.w3.org/2000/svg', 'marker');
          marker.setAttribute('id', markerId);
          marker.setAttribute('viewBox', '0 0 10 10');
          marker.setAttribute('refX', '8');
          marker.setAttribute('refY', '5');
          marker.setAttribute('markerWidth', '5');
          marker.setAttribute('markerHeight', '5');
          marker.setAttribute('orient', 'auto-start-reverse');
          const arrowPath = document.createElementNS('http://www.w3.org/2000/svg', 'path');
          arrowPath.setAttribute('d', 'M 0 0 L 10 5 L 0 10 z');
          arrowPath.setAttribute('fill', color);
          marker.appendChild(arrowPath);
          defs.appendChild(marker);
          svg.appendChild(defs);

          const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
          path.setAttribute('d', `M ${sx} ${sy} C ${cpX} ${sy}, ${cpX} ${ey}, ${ex} ${ey}`);
          path.setAttribute('fill', 'none');
          path.setAttribute('stroke', color);
          path.setAttribute('stroke-width', '1.5');
          path.setAttribute('marker-end', `url(#${markerId})`);
          svg.appendChild(path);
        });
      });
    });
  };

  useEffect(() => {
    const id = setTimeout(drawLines, 50);
    return () => clearTimeout(id);
  });

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => drawLines());
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const activeParents = parents.filter(p => p.status === 'active');
  const queuedParents = parents.filter(p => p.status === 'queued');

  return (
    <div ref={containerRef} className="relative flex flex-col gap-3">
      <svg ref={svgRef} className="absolute inset-0 w-full h-full pointer-events-none" style={{ zIndex: 10 }} />

      {activeParents.map(p => {
        const doneCount = p.tasks.filter(t => t.status === 'done').length;
        const pct = p.tasks.length > 0 ? Math.round((doneCount / p.tasks.length) * 100) : 0;
        const levels = computeLevels(p.tasks);

        const isParentPaused = adminPaused && p.status === 'active';
        return (
          <div key={p.id} className={`border rounded-lg bg-white p-2.5 relative ${isParentPaused ? 'border-orange-200' : 'border-gray-200'}`} style={{ zIndex: 2 }}>
            <div className="flex items-start justify-between mb-2">
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-1.5 mb-0.5">
                  {isParentPaused ? (
                    <>
                      <span className="w-1.5 h-1.5 rounded-full bg-orange-400 flex-shrink-0" />
                      <span className="text-[10px] font-semibold text-orange-400 uppercase tracking-wide">PAUSED</span>
                    </>
                  ) : (
                    <>
                      <span className="w-1.5 h-1.5 rounded-full bg-green-500 animate-pulse flex-shrink-0" />
                      <span className="text-[10px] font-semibold text-gray-400 uppercase tracking-wide">ACTIVE</span>
                    </>
                  )}
                  <span className="text-[10px] text-gray-300">{p.id}</span>
                </div>
                <p className="text-xs text-gray-600 leading-snug truncate">{p.goal}</p>
              </div>
              <div className="flex items-center gap-1 ml-2 flex-shrink-0">
                <div className="w-16 h-1 bg-gray-100 rounded-full overflow-hidden">
                  <div className="h-full bg-green-500 rounded-full transition-all" style={{ width: `${pct}%` }} />
                </div>
                <span className="text-[10px] text-gray-400">{doneCount}/{p.tasks.length}</span>
              </div>
            </div>

            <div className="flex flex-col gap-1.5">
              {levels.map((lvl, li) => (
                <div key={li} className="flex gap-2 flex-wrap">
                  {lvl.map(t => {
                    const color = agentColor(t.agentId);
                    const isSelected = t.id === selectedTaskId;
                    // processing 任务：admin paused 时显示 ⏸ 而非旋转
                    const isProcessingPaused = isParentPaused && t.status === 'processing';
                    return (
                      <button
                        key={t.label}
                        id={`dtask-${p.id}-${t.label}`}
                        data-status={t.status}
                        onClick={() => onSelectTask?.(t)}
                        className={`text-left border-l-2 rounded px-2 py-1.5 min-w-[110px] max-w-[160px] cursor-pointer transition-all hover:-translate-y-px hover:shadow-sm ${t.isVirtual ? 'border-dashed' : ''} ${isProcessingPaused ? 'border-l-orange-400 bg-orange-50' : statusColors(t.status)} ${isSelected ? 'ring-1 ring-[#5BBFE8]' : ''}`}
                      >
                        <div className="flex items-center justify-between gap-1 mb-0.5">
                          <div className="flex items-center gap-1">
                            <span className={`text-[11px] ${isProcessingPaused ? 'text-orange-400' : statusIconColor(t.status)} ${!isProcessingPaused && t.status === 'processing' ? 'animate-spin inline-block' : ''}`}>
                              {isProcessingPaused ? '⏸' : statusIcon(t.status)}
                            </span>
                            <span className={`text-[11px] font-semibold ${isProcessingPaused ? 'text-orange-400' : statusIconColor(t.status)}`}>
                              {t.label}
                            </span>
                          </div>
                          <span
                            className="text-[9px] px-1 py-0.5 rounded font-medium"
                            style={{ color, background: `${color}22` }}
                          >
                            {t.isVirtual ? (t.personaName ?? t.agentId) : t.agentId.replace('web-', '')}
                          </span>
                        </div>
                        <p className="text-[10px] text-gray-400 leading-snug line-clamp-2">{t.prompt}</p>
                      </button>
                    );
                  })}
                </div>
              ))}
            </div>
          </div>
        );
      })}

      {queuedParents.map(p => (
        <div key={p.id} className="border border-gray-200 rounded-lg bg-gray-50 p-2.5 opacity-50" style={{ zIndex: 2 }}>
          <div className="flex items-center gap-1.5 mb-0.5">
            <span className="text-[10px] font-semibold text-gray-400 uppercase tracking-wide">⏳ QUEUED</span>
            <span className="text-[10px] text-gray-300">{p.id}</span>
          </div>
          <p className="text-xs text-gray-500 leading-snug">{p.goal}</p>
          <p className="text-[10px] text-gray-400 mt-1">{p.tasks.length} tasks pending</p>
        </div>
      ))}
    </div>
  );
}
