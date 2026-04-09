import { useState, useRef, useEffect } from 'react';
import type { PermissionMessage, QuestionMessage } from '../types';

// ===== PermissionCard =====

interface PermissionCardProps {
  message: PermissionMessage;
  onResolve: (requestId: string, optionKey: string) => void;
}

const OPTION_STYLE: Record<string, string> = {
  agree:   'bg-green-50 border-green-200 text-green-700 hover:bg-green-100',
  allow:   'bg-green-50 border-green-200 text-green-700 hover:bg-green-100',
  yes:     'bg-green-50 border-green-200 text-green-700 hover:bg-green-100',
  refuse:  'bg-red-50   border-red-200   text-red-700   hover:bg-red-100',
  deny:    'bg-red-50   border-red-200   text-red-700   hover:bg-red-100',
  no:      'bg-red-50   border-red-200   text-red-700   hover:bg-red-100',
};
const DEFAULT_OPTION_STYLE = 'bg-gray-50 border-gray-200 text-gray-700 hover:bg-gray-100';

export function PermissionCard({ message, onResolve }: PermissionCardProps) {
  const [expanded, setExpanded] = useState(false);
  const isResolved = !!message.resolved;
  const PREVIEW_LEN = 300;
  const isLong = message.content.length > PREVIEW_LEN;

  return (
    <div className={`rounded-2xl border p-4 text-sm transition-opacity ${
      isResolved ? 'opacity-60' : 'bg-white border-[#5BBFE8]/40 shadow-sm'
    } max-w-[80%]`}>
      {/* Header */}
      <div className="flex items-center gap-2 mb-3">
        <span className="text-base">🔐</span>
        <div>
          <p className="font-semibold text-gray-800">{message.title}</p>
          <p className="text-[11px] text-gray-400 font-mono">{message.toolName}</p>
        </div>
        {isResolved && (
          <span className="ml-auto text-[11px] bg-gray-100 text-gray-500 px-2 py-0.5 rounded-full">
            已决策
          </span>
        )}
      </div>

      {/* Content */}
      {message.content && (
        <div className="mb-3 bg-gray-50 rounded-xl p-3 text-xs font-mono text-gray-700 leading-relaxed overflow-hidden">
          <pre className="whitespace-pre-wrap break-words">
            {isLong && !expanded
              ? message.content.slice(0, PREVIEW_LEN) + '…'
              : message.content}
          </pre>
          {isLong && (
            <button
              onClick={() => setExpanded(e => !e)}
              className="mt-1 text-[#5BBFE8] hover:underline text-[11px]"
            >
              {expanded ? '收起' : `展开全部（${message.content.length} 字符）`}
            </button>
          )}
        </div>
      )}

      {/* Resolved state */}
      {isResolved ? (
        <div className="flex items-center gap-2 text-gray-500">
          <span>✅</span>
          <span className="text-sm">已选择：<strong>{message.resolved!.label}</strong></span>
        </div>
      ) : (
        /* Options */
        <div className="flex flex-wrap gap-2">
          {message.options.map(opt => {
            const style = OPTION_STYLE[opt.key.toLowerCase()] ?? DEFAULT_OPTION_STYLE;
            return (
              <button
                key={opt.key}
                onClick={() => onResolve(message.requestId, opt.key)}
                className={`px-4 py-1.5 rounded-xl border text-sm font-medium transition-colors ${style}`}
              >
                {opt.label}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

// ===== QuestionCard =====

const OTHER_INDEX = -1;

interface QuestionCardProps {
  message: QuestionMessage;
  onResolve: (requestId: string, answers: Record<number, number | number[]>, otherTexts?: Record<number, string>) => void;
}

export function QuestionCard({ message, onResolve }: QuestionCardProps) {
  // selections: single → number | null, multi → number[]
  const [selections, setSelections] = useState<Record<number, number | null | number[]>>(() => {
    if (message.resolved) return message.selections;
    const init: Record<number, number | null | number[]> = {};
    message.questions.forEach((q, qi) => {
      init[qi] = q.multiSelect ? [] : null;
    });
    return init;
  });
  const [otherTexts, setOtherTexts] = useState<Record<number, string>>(message.otherTexts ?? {});
  const [editingOther, setEditingOther] = useState<Record<number, boolean>>({});
  const [activeTab, setActiveTab] = useState(0);
  const otherInputRef = useRef<HTMLInputElement>(null);
  const isResolved = message.resolved;
  const isMultiPage = message.questions.length > 1;
  const currentQ = message.questions[activeTab];

  useEffect(() => {
    if (editingOther[activeTab] && otherInputRef.current) {
      otherInputRef.current.focus();
    }
  }, [editingOther, activeTab]);

  const isSelected = (qi: number, oi: number): boolean => {
    const sel = selections[qi];
    const q = message.questions[qi];
    if (q?.multiSelect) return ((sel as number[]) ?? []).includes(oi);
    return sel === oi;
  };

  const handleSelect = (qi: number, oi: number) => {
    if (isResolved) return;
    const q = message.questions[qi];
    setSelections(prev => {
      const next = { ...prev };
      if (q.multiSelect) {
        const arr = ((prev[qi] as number[]) ?? []).slice();
        const idx = arr.indexOf(oi);
        if (idx >= 0) arr.splice(idx, 1);
        else arr.push(oi);
        next[qi] = arr;
      } else {
        next[qi] = prev[qi] === oi ? null : oi;
      }
      return next;
    });
    // If deselecting Other, exit edit mode
    if (oi === OTHER_INDEX && isSelected(qi, OTHER_INDEX)) {
      setEditingOther(prev => ({ ...prev, [qi]: false }));
    }
  };

  const handleOtherClick = (qi: number) => {
    if (isResolved) return;
    const selected = isSelected(qi, OTHER_INDEX);
    if (!selected) {
      handleSelect(qi, OTHER_INDEX);
      setEditingOther(prev => ({ ...prev, [qi]: true }));
    } else if (!editingOther[qi]) {
      setEditingOther(prev => ({ ...prev, [qi]: true }));
    } else {
      // Already editing, clicking again deselects
      handleSelect(qi, OTHER_INDEX);
    }
  };

  const handleOtherKeyDown = (qi: number, e: React.KeyboardEvent) => {
    if (e.nativeEvent.isComposing) return;
    if (e.key === 'Enter' || e.key === 'Escape') {
      e.preventDefault();
      setEditingOther(prev => ({ ...prev, [qi]: false }));
    }
  };

  const isAnswered = (qi: number): boolean => {
    const sel = selections[qi];
    const q = message.questions[qi];
    if (q.multiSelect) return ((sel as number[]) ?? []).length > 0;
    return sel !== null && sel !== undefined;
  };

  const allAnswered = message.questions.every((_, qi) => isAnswered(qi));

  const handleSubmit = () => {
    if (isResolved) return;
    // Build final answers
    const finalSelections: Record<number, number | number[]> = {};
    message.questions.forEach((q, qi) => {
      const sel = selections[qi];
      if (q.multiSelect) {
        finalSelections[qi] = (sel as number[]) ?? [];
      } else {
        finalSelections[qi] = (sel as number) ?? 0;
      }
    });
    const hasOther = Object.keys(otherTexts).length > 0;
    onResolve(message.requestId, finalSelections, hasOther ? otherTexts : undefined);
  };

  const handleSkip = () => {
    if (isResolved) return;
    // Submit empty: all questions get empty selection
    const empty: Record<number, number | number[]> = {};
    message.questions.forEach((q, qi) => {
      empty[qi] = q.multiSelect ? [] : OTHER_INDEX;
    });
    onResolve(message.requestId, empty);
  };

  // Get display text for resolved Other
  const getResolvedLabel = (qi: number, oi: number): string => {
    if (oi === OTHER_INDEX) return otherTexts[qi] || 'Other';
    return message.questions[qi]?.options[oi]?.label ?? '';
  };

  return (
    <div className={`rounded-2xl border p-4 text-sm transition-opacity ${
      isResolved ? 'opacity-60 bg-gray-50' : 'bg-white border-[#5BBFE8]/40 shadow-sm'
    } max-w-[80%]`}>
      {/* Header */}
      <div className="flex items-center gap-2 mb-3">
        <span className="text-base">&#10067;</span>
        <p className="font-semibold text-gray-800">需要您的决策</p>
        {isResolved && (
          <span className="ml-auto text-[11px] bg-gray-100 text-gray-500 px-2 py-0.5 rounded-full">
            已回答
          </span>
        )}
      </div>

      {/* Tabs (multi-question) */}
      {isMultiPage && (
        <div className="flex gap-1 mb-3 border-b border-gray-100 pb-2">
          {message.questions.map((q, ti) => (
            <button
              key={ti}
              onClick={() => setActiveTab(ti)}
              className={`px-3 py-1 rounded-lg text-xs font-medium transition-colors ${
                activeTab === ti
                  ? 'bg-[#5BBFE8] text-white'
                  : 'bg-gray-50 text-gray-500 hover:bg-[#EEF7FD] hover:text-[#5BBFE8]'
              }`}
            >
              {q.header}
            </button>
          ))}
        </div>
      )}

      {/* Current question */}
      {currentQ && (
        <div>
          {!isMultiPage && (
            <p className="text-[11px] font-semibold text-[#5BBFE8] uppercase tracking-wide mb-1">
              {currentQ.header}
            </p>
          )}
          <p className="text-gray-700 mb-3">{currentQ.question}</p>

          <div className="space-y-1.5">
            {/* Regular options */}
            {currentQ.options.map((opt, oi) => {
              const checked = isSelected(activeTab, oi);
              return (
                <button
                  key={oi}
                  onClick={() => handleSelect(activeTab, oi)}
                  disabled={isResolved}
                  className={`w-full flex items-start gap-2.5 px-3 py-2 rounded-xl border text-sm text-left transition-colors ${
                    checked
                      ? 'bg-[#EEF7FD] border-[#5BBFE8] text-gray-800'
                      : 'bg-white border-gray-200 text-gray-700 hover:bg-[#F8FCFE] hover:border-[#5BBFE8]/50'
                  } disabled:cursor-default`}
                >
                  <span className={`mt-0.5 w-4 h-4 rounded-${currentQ.multiSelect ? 'md' : 'full'} border-2 flex items-center justify-center flex-shrink-0 transition-colors ${
                    checked ? 'border-[#5BBFE8] bg-[#5BBFE8]' : 'border-gray-300'
                  }`}>
                    {checked && (
                      <svg className="w-2.5 h-2.5 text-white" fill="currentColor" viewBox="0 0 20 20">
                        <path fillRule="evenodd" d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z" clipRule="evenodd" />
                      </svg>
                    )}
                  </span>
                  <div className="flex-1 min-w-0">
                    <span className="font-medium">{opt.label}</span>
                    {opt.description && (
                      <span className="block text-xs text-gray-400 mt-0.5">{opt.description}</span>
                    )}
                  </div>
                </button>
              );
            })}

            {/* Other option */}
            <button
              onClick={() => handleOtherClick(activeTab)}
              disabled={isResolved}
              className={`w-full flex items-start gap-2.5 px-3 py-2 rounded-xl border text-sm text-left transition-colors ${
                isSelected(activeTab, OTHER_INDEX)
                  ? 'bg-[#EEF7FD] border-[#5BBFE8] text-gray-800'
                  : 'bg-white border-gray-200 text-gray-700 hover:bg-[#F8FCFE] hover:border-[#5BBFE8]/50'
              } disabled:cursor-default`}
            >
              <span className={`mt-0.5 w-4 h-4 rounded-${currentQ.multiSelect ? 'md' : 'full'} border-2 flex items-center justify-center flex-shrink-0 transition-colors ${
                isSelected(activeTab, OTHER_INDEX) ? 'border-[#5BBFE8] bg-[#5BBFE8]' : 'border-gray-300'
              }`}>
                {isSelected(activeTab, OTHER_INDEX) && (
                  <svg className="w-2.5 h-2.5 text-white" fill="currentColor" viewBox="0 0 20 20">
                    <path fillRule="evenodd" d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z" clipRule="evenodd" />
                  </svg>
                )}
              </span>
              <div className="flex-1 min-w-0">
                {isSelected(activeTab, OTHER_INDEX) && editingOther[activeTab] ? (
                  <input
                    ref={otherInputRef}
                    type="text"
                    className="w-full bg-transparent border-none outline-none text-sm text-gray-800 placeholder-gray-400"
                    placeholder="输入自定义内容..."
                    value={otherTexts[activeTab] ?? ''}
                    onChange={e => setOtherTexts(prev => ({ ...prev, [activeTab]: e.target.value }))}
                    onKeyDown={e => { e.stopPropagation(); handleOtherKeyDown(activeTab, e); }}
                    onClick={e => e.stopPropagation()}
                  />
                ) : (
                  <span className="font-medium">
                    {isSelected(activeTab, OTHER_INDEX) && otherTexts[activeTab]
                      ? otherTexts[activeTab]
                      : 'Other'}
                  </span>
                )}
              </div>
            </button>
          </div>
        </div>
      )}

      {/* Action buttons */}
      {!isResolved && (
        <div className="flex gap-2 mt-4">
          <button
            onClick={handleSubmit}
            disabled={!allAnswered}
            className="flex-1 py-2 rounded-xl bg-[#5BBFE8] hover:bg-[#3AAAD4] disabled:bg-gray-200 disabled:cursor-not-allowed text-white text-sm font-medium transition-colors"
          >
            {allAnswered ? '确认提交' : `还需回答 ${message.questions.filter((_, qi) => !isAnswered(qi)).length} 个问题`}
          </button>
          <button
            onClick={handleSkip}
            className="px-4 py-2 rounded-xl border border-gray-200 text-gray-500 text-sm hover:bg-gray-50 transition-colors"
          >
            跳过
          </button>
        </div>
      )}

      {/* Resolved summary */}
      {isResolved && (
        <div className="mt-3 pt-3 border-t border-gray-100">
          {message.questions.map((q, qi) => {
            const sel = message.selections[qi];
            const labels = Array.isArray(sel)
              ? (sel as number[]).map(oi => getResolvedLabel(qi, oi)).join(', ')
              : getResolvedLabel(qi, sel as number);
            return labels ? (
              <p key={qi} className="text-xs text-gray-500">
                <span className="text-[#5BBFE8] font-medium">{q.header}:</span> {labels}
              </p>
            ) : null;
          })}
        </div>
      )}
    </div>
  );
}
