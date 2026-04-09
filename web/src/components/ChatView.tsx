import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import type { GroupInfo, ChatMessage, AgentState } from '../types';
import { MessageBubble, TypingIndicator } from './MessageBubble';

interface Props {
  group: GroupInfo;
  messages: ChatMessage[];
  agentState: AgentState;
  /** compact 进行中，暂停按钮禁用，显示 "Compacting…" */
  isCompacting: boolean;
  onSend: (text: string) => void;
  onPause: () => void;
  onResume: (query?: string) => void;
  onStop: () => void;
  onResolvePermission: (requestId: string, optionKey: string) => void;
  onResolveQuestion: (requestId: string, answers: Record<number, number | number[]>, otherTexts?: Record<number, string>) => void;
}

export function ChatView({ group, messages, agentState, isCompacting, onSend, onPause, onResume, onStop, onResolvePermission, onResolveQuestion }: Props) {
  const [input, setInput]           = useState('');
  const [showStopConfirm, setShowStopConfirm] = useState(false);
  const bottomRef                   = useRef<HTMLDivElement>(null);
  const textareaRef                 = useRef<HTMLTextAreaElement>(null);

  const isProcessing = agentState === 'processing';
  const isPaused     = agentState === 'paused';
  const isActive     = isProcessing || isPaused; // agent 有任务在身

  // Auto-scroll to bottom on new messages or typing indicator
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages.length, isProcessing]);

  // ── 发送 / 暂停 / 继续 按钮统一入口 ──
  const handleActionButton = () => {
    if (isProcessing) {
      // 暂停中禁止操作（compacting 时按钮已禁用，此处做双重保护）
      if (isCompacting) return;
      onPause();
      return;
    }
    if (isPaused) {
      const text = input.trim();
      onResume(text || undefined);
      setInput('');
      if (textareaRef.current) textareaRef.current.style.height = 'auto';
      return;
    }
    // idle：普通发送
    const text = input.trim();
    if (!text) return;
    onSend(text);
    setInput('');
    if (textareaRef.current) textareaRef.current.style.height = 'auto';
  };

  const handleKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      if (!isProcessing) handleActionButton();
    }
  };

  // Auto-resize textarea
  const handleInput = () => {
    const el = textareaRef.current;
    if (el) {
      el.style.height = 'auto';
      el.style.height = `${Math.min(el.scrollHeight, 128)}px`;
    }
  };

  // ── 按钮状态计算 ──
  const actionButtonDisabled =
    (agentState === 'idle' && !input.trim()) ||   // idle 无输入不能发送
    (isProcessing && isCompacting);               // compacting 中暂停禁用

  const actionButtonTitle =
    isProcessing
      ? (isCompacting ? 'Compacting context, please wait…' : 'Pause')
      : isPaused
      ? 'Resume'
      : 'Send';

  // ── 状态栏文案 ──
  const statusText =
    isCompacting  ? 'Compacting…'
    : isProcessing ? 'Thinking…'
    : isPaused     ? 'Paused'
    : 'Ready';

  const statusDotClass =
    isProcessing ? 'bg-yellow-400 animate-pulse'
    : isPaused   ? 'bg-orange-400'
    : 'bg-green-400';

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="flex items-center px-6 py-4 bg-white border-b border-gray-100 flex-shrink-0">
        <div>
          <h2 className="font-semibold text-gray-800">{group.name}</h2>
          <p className="text-xs text-gray-400 mt-0.5">{group.folder}</p>
        </div>
        <div className="ml-auto flex items-center gap-3">
          {/* Status indicator */}
          <div className="flex items-center gap-2">
            <span className={`w-2 h-2 rounded-full transition-colors ${statusDotClass}`} />
            <span className="text-xs text-gray-500">{statusText}</span>
          </div>
          {/* Stop / reset button — 始终显示，idle 时用于清空历史上下文 */}
          <button
            onClick={() => setShowStopConfirm(true)}
            className="w-7 h-7 rounded-full text-gray-400 hover:text-red-500 hover:bg-red-50 flex items-center justify-center transition-colors"
            title="Reset session"
            aria-label="Reset session"
          >
            {/* Refresh / reset icon */}
            <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="w-4 h-4">
              <path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8" />
              <path d="M3 3v5h5" />
            </svg>
          </button>
        </div>
      </div>

      {/* Messages */}
      <div className="flex-1 overflow-y-auto px-6 py-5 space-y-4 bg-[#F5F8FB]">
        {messages.length === 0 && !isProcessing && (
          <div className="flex flex-col items-center justify-center h-full gap-3 select-none">
            <img src="/logo.svg" alt="" className="w-12 h-12 opacity-20" />
            <p className="text-sm text-gray-400">Start a conversation</p>
          </div>
        )}
        {messages.map(msg => (
          <MessageBubble
            key={msg.id}
            message={msg}
            onResolvePermission={onResolvePermission}
            onResolveQuestion={onResolveQuestion}
          />
        ))}
        {isProcessing && <TypingIndicator />}
        <div ref={bottomRef} />
      </div>

      {/* Input area */}
      <div className="px-6 py-4 bg-white border-t border-gray-100 flex-shrink-0">
        <div className="flex gap-3 items-end">
          <textarea
            ref={textareaRef}
            className="flex-1 resize-none border border-gray-200 rounded-2xl px-4 py-3 text-sm text-gray-800 placeholder-gray-400 focus:outline-none focus:border-[#5BBFE8] focus:ring-2 focus:ring-[#5BBFE8]/20 transition-all min-h-[44px] max-h-32 disabled:bg-gray-50 disabled:cursor-not-allowed"
            placeholder={isPaused ? 'Add instructions or leave empty to continue…' : 'Message…'}
            rows={1}
            value={input}
            onChange={e => setInput(e.target.value)}
            onKeyDown={handleKeyDown}
            onInput={handleInput}
            disabled={isProcessing}
          />
          {/* Action button：发送 / 暂停 / 继续 */}
          <button
            onClick={handleActionButton}
            disabled={actionButtonDisabled}
            className="w-10 h-10 rounded-full bg-[#5BBFE8] hover:bg-[#3AAAD4] disabled:bg-gray-200 disabled:cursor-not-allowed flex items-center justify-center text-white transition-colors flex-shrink-0"
            aria-label={actionButtonTitle}
            title={actionButtonTitle}
          >
            {isProcessing ? (
              /* 暂停图标 ⏸（两竖线） */
              <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor" className="w-4 h-4">
                <path fillRule="evenodd" d="M6.75 5.25a.75.75 0 0 1 .75-.75H9a.75.75 0 0 1 .75.75v13.5a.75.75 0 0 1-.75.75H7.5a.75.75 0 0 1-.75-.75V5.25zm7.5 0A.75.75 0 0 1 15 4.5h1.5a.75.75 0 0 1 .75.75v13.5a.75.75 0 0 1-.75.75H15a.75.75 0 0 1-.75-.75V5.25z" clipRule="evenodd" />
              </svg>
            ) : isPaused ? (
              /* 继续图标 ▶（三角形） */
              <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor" className="w-4 h-4">
                <path fillRule="evenodd" d="M4.5 5.653c0-1.427 1.529-2.33 2.779-1.643l11.54 6.347c1.295.712 1.295 2.573 0 3.286L7.28 19.99c-1.25.687-2.779-.217-2.779-1.643V5.653z" clipRule="evenodd" />
              </svg>
            ) : (
              /* 发送图标 ▷（纸飞机） */
              <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor" className="w-4 h-4">
                <path d="M3.478 2.405a.75.75 0 00-.926.94l2.432 7.905H13.5a.75.75 0 010 1.5H4.984l-2.432 7.905a.75.75 0 00.926.94 60.519 60.519 0 0018.445-8.986.75.75 0 000-1.218A60.517 60.517 0 003.478 2.405z" />
              </svg>
            )}
          </button>
        </div>
        <p className="text-[11px] text-gray-400 mt-2 ml-1">
          {isPaused
            ? 'Press ▶ to resume · Add instructions above if needed'
            : 'Enter to send · Shift+Enter for new line'}
        </p>
      </div>

      {/* Stop 确认弹窗 */}
      {showStopConfirm && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40">
          <div className="bg-white rounded-2xl shadow-xl p-6 w-80 flex flex-col gap-4">
            <div className="flex items-center gap-3">
              <span className="w-9 h-9 rounded-full bg-red-100 flex items-center justify-center flex-shrink-0">
                <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="w-5 h-5 text-red-500">
                  <path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8" />
                  <path d="M3 3v5h5" />
                </svg>
              </span>
              <h3 className="font-semibold text-gray-800">Reset session?</h3>
            </div>
            <p className="text-sm text-gray-500">
              {isActive
                ? 'Current task will be terminated and all conversation context will be discarded. This cannot be undone.'
                : 'All conversation context will be cleared and a new session will start. This cannot be undone.'}
            </p>
            <div className="flex gap-3 justify-end">
              <button
                onClick={() => setShowStopConfirm(false)}
                className="px-4 py-2 text-sm rounded-xl text-gray-600 hover:bg-gray-100 transition-colors"
              >
                Cancel
              </button>
              <button
                onClick={() => { setShowStopConfirm(false); onStop(); }}
                className="px-4 py-2 text-sm rounded-xl bg-red-500 hover:bg-red-600 text-white transition-colors"
              >
                Terminate
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
