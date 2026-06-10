import { useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import remarkBreaks from 'remark-breaks';
import rehypeHighlight from 'rehype-highlight';
import 'highlight.js/styles/github.css';
import type { ChatMessage, TextMessage } from '../types';
import { PermissionCard, QuestionCard } from './PermissionCard';

function formatTime(iso: string): string {
  // 历史回放消息没有持久化时间戳（timestamp 为 ''），new Date('') 不抛异常而是
  // 产生 Invalid Date，toLocaleTimeString 会渲染出 "Invalid Date" 字符串，需显式拦截。
  if (!iso) return '';
  const d = new Date(iso);
  if (isNaN(d.getTime())) return '';
  return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
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
      {/* 仅 agent 消息走 markdown 渲染；用户/群桥接消息保持纯文本，避免输入里的 *、# 被解析。
          remark-breaks 让段落内单换行渲染为 <br>（代码块/表格在 AST 层不受影响）。
          复制按钮仍复制原始 text，与渲染层无关。 */}
      <div className="bg-white text-gray-800 px-4 py-2.5 rounded-2xl rounded-tl-sm text-sm leading-relaxed break-words shadow-sm border border-gray-100 prose prose-sm max-w-none prose-headings:font-semibold prose-headings:my-2 prose-p:my-1.5 prose-ul:my-1.5 prose-ol:my-1.5 prose-li:my-0.5 prose-table:my-2 prose-blockquote:my-2 prose-hr:my-3 prose-pre:my-2 prose-pre:bg-gray-50 prose-pre:text-gray-800 prose-pre:border prose-pre:border-gray-200 prose-code:before:content-none prose-code:after:content-none [&_:not(pre)>code]:bg-gray-100 [&_:not(pre)>code]:px-1 [&_:not(pre)>code]:py-0.5 [&_:not(pre)>code]:rounded [&_:not(pre)>code]:text-[0.85em] [&_:not(pre)>code]:font-normal">
        <ReactMarkdown remarkPlugins={[remarkGfm, remarkBreaks]} rehypePlugins={[rehypeHighlight]}>
          {text}
        </ReactMarkdown>
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
    const attachments = (message as TextMessage).attachments;
    return (
      <div className="flex justify-end">
        <div className="max-w-[72%]">
          {attachments && attachments.length > 0 && (
            <div className="flex flex-wrap gap-1.5 mb-1.5 justify-end">
              {attachments.map((a, i) => (
                <img
                  key={i}
                  src={a.dataUrl}
                  alt=""
                  className="max-w-[200px] max-h-[150px] object-cover rounded-xl shadow-sm border border-[#5BBFE8]/20"
                />
              ))}
            </div>
          )}
          {text && (
            <div className="bg-[#5BBFE8] text-white px-4 py-2.5 rounded-2xl rounded-tr-sm text-sm leading-relaxed whitespace-pre-wrap break-words shadow-sm">
              {text}
            </div>
          )}
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
