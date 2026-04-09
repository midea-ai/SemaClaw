import { useState } from 'react';
import type { ChatMessage } from '../types';
import { PermissionCard, QuestionCard } from './PermissionCard';

function formatTime(iso: string): string {
  try {
    return new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  } catch { return ''; }
}

function CopyIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <rect x="9" y="9" width="13" height="13" rx="2" ry="2"/>
      <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>
    </svg>
  );
}

function CheckIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
      <polyline points="20 6 9 17 4 12"/>
    </svg>
  );
}

function SaveIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>
      <polyline points="7 10 12 15 17 10"/>
      <line x1="12" y1="15" x2="12" y2="3"/>
    </svg>
  );
}

function AgentBubble({ text, timestamp }: { text: string; timestamp: string }) {
  const [copyState, setCopyState] = useState<'idle' | 'copied'>('idle');
  const [saveState, setSaveState] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle');

  const handleCopy = () => {
    navigator.clipboard.writeText(text).then(() => {
      setCopyState('copied');
      setTimeout(() => setCopyState('idle'), 2000);
    }).catch(() => {/* ignore */});
  };

  const handleSave = async () => {
    if (saveState === 'saving') return;
    setSaveState('saving');
    try {
      await fetch('/api/quicknotes', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text }),
      });
      setSaveState('saved');
      setTimeout(() => setSaveState('idle'), 2000);
    } catch {
      setSaveState('error');
      setTimeout(() => setSaveState('idle'), 2000);
    }
  };

  return (
    <div className="max-w-[72%] group">
      <div className="bg-white text-gray-800 px-4 py-2.5 rounded-2xl rounded-tl-sm text-sm leading-relaxed whitespace-pre-wrap break-words shadow-sm border border-gray-100">
        {text}
      </div>
      <div className="flex items-center mt-1 gap-1">
        <p className="text-[11px] text-gray-400 ml-1 flex-1">{formatTime(timestamp)}</p>
        <div className="flex gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity">
          <button
            onClick={handleCopy}
            title="复制"
            className={`p-1 rounded transition-colors ${
              copyState === 'copied'
                ? 'text-green-500'
                : 'text-gray-400 hover:text-gray-600 hover:bg-gray-100'
            }`}
          >
            {copyState === 'copied' ? <CheckIcon /> : <CopyIcon />}
          </button>
          <button
            onClick={handleSave}
            title={saveState === 'error' ? '保存失败' : '保存为笔记'}
            className={`p-1 rounded transition-colors ${
              saveState === 'saved'   ? 'text-green-500' :
              saveState === 'error'   ? 'text-red-400' :
              saveState === 'saving'  ? 'text-gray-300 cursor-not-allowed' :
              'text-gray-400 hover:text-gray-600 hover:bg-gray-100'
            }`}
          >
            {saveState === 'saved' ? <CheckIcon /> : <SaveIcon />}
          </button>
        </div>
      </div>
    </div>
  );
}

interface MessageBubbleProps {
  message: ChatMessage;
  onResolvePermission: (requestId: string, optionKey: string) => void;
  onResolveQuestion: (requestId: string, answers: Record<number, number | number[]>, otherTexts?: Record<number, string>) => void;
}

export function MessageBubble({ message, onResolvePermission, onResolveQuestion }: MessageBubbleProps) {
  if (message.role === 'permission') {
    return (
      <div className="flex justify-start">
        <PermissionCard message={message} onResolve={onResolvePermission} />
      </div>
    );
  }

  if (message.role === 'question') {
    return (
      <div className="flex justify-start">
        <QuestionCard message={message} onResolve={onResolveQuestion} />
      </div>
    );
  }

  const { role, text, timestamp, senderName } = message;

  if (role === 'user') {
    return (
      <div className="flex justify-end">
        <div className="max-w-[72%]">
          <div className="bg-[#5BBFE8] text-white px-4 py-2.5 rounded-2xl rounded-tr-sm text-sm leading-relaxed whitespace-pre-wrap break-words shadow-sm">
            {text}
          </div>
          <p className="text-[11px] text-gray-400 mt-1 text-right pr-1">{formatTime(timestamp)}</p>
        </div>
      </div>
    );
  }

  const isAgent = role === 'agent';

  return (
    <div className="flex gap-2.5 items-end">
      {/* Avatar */}
      <div className={`w-7 h-7 rounded-full flex items-center justify-center flex-shrink-0 mb-5 text-white text-[10px] font-bold ${
        isAgent ? 'bg-[#5BBFE8]' : 'bg-gray-300'
      }`}>
        {isAgent ? 'AI' : (senderName?.charAt(0).toUpperCase() ?? '?')}
      </div>
      {isAgent ? (
        <AgentBubble text={text} timestamp={timestamp} />
      ) : (
        <div className="max-w-[72%]">
          {senderName && (
            <p className="text-[11px] text-gray-500 mb-1 ml-1">{senderName}</p>
          )}
          <div className="bg-white text-gray-800 px-4 py-2.5 rounded-2xl rounded-tl-sm text-sm leading-relaxed whitespace-pre-wrap break-words shadow-sm border border-gray-100">
            {text}
          </div>
          <p className="text-[11px] text-gray-400 mt-1 ml-1">{formatTime(timestamp)}</p>
        </div>
      )}
    </div>
  );
}

export function TypingIndicator() {
  return (
    <div className="flex gap-2.5 items-end">
      <div className="w-7 h-7 rounded-full bg-[#5BBFE8] flex items-center justify-center flex-shrink-0 mb-5 text-white text-[10px] font-bold">
        AI
      </div>
      <div className="bg-white px-4 py-3 rounded-2xl rounded-tl-sm shadow-sm border border-gray-100">
        <div className="flex gap-1 items-center h-4">
          {[0, 150, 300].map(delay => (
            <span
              key={delay}
              className="w-1.5 h-1.5 rounded-full bg-gray-400 animate-bounce"
              style={{ animationDelay: `${delay}ms` }}
            />
          ))}
        </div>
      </div>
    </div>
  );
}
