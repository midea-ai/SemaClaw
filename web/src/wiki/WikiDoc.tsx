/**
 * WikiDoc — 文档详情页
 * 查看模式（Markdown 渲染）和编辑模式（WikiEditor）切换
 */

import { useEffect, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import rehypeHighlight from 'rehype-highlight';
import 'highlight.js/styles/github.css';
import type { WikiDoc as WikiDocType } from '../hooks/useWiki';
import { WikiEditor } from './WikiEditor';

interface Props {
  path: string;
  doc: WikiDocType | null;
  loading: boolean;
  onBack: () => void;
  onLoad: (path: string) => void;
  onSave: (path: string, content: string) => Promise<void>;
  onRefresh: (path: string) => void;
}

function TagBadge({ tag }: { tag: string }) {
  return (
    <span className="px-2 py-0.5 bg-amber-50 text-amber-700 text-xs rounded-full">{tag}</span>
  );
}

function relativeTime(iso: string): string {
  if (!iso) return '';
  const diff = Date.now() - new Date(iso).getTime();
  const m = Math.floor(diff / 60000);
  if (m < 1) return '刚刚';
  if (m < 60) return `${m}分钟前`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}小时前`;
  return `${Math.floor(h / 24)}天前`;
}

export function WikiDoc({ path, doc, loading, onBack, onLoad, onSave, onRefresh }: Props) {
  const [editing, setEditing] = useState(false);
  const [editContent, setEditContent] = useState('');
  const [saving, setSaving] = useState(false);
  const [showHistory, setShowHistory] = useState(false);

  useEffect(() => {
    onLoad(path);
    setEditing(false);
    setShowHistory(false);
  }, [path, onLoad]);

  const handleEdit = () => {
    if (!doc) return;
    setEditContent(doc.content);
    setEditing(true);
  };

  const handleSave = async () => {
    setSaving(true);
    try {
      await onSave(path, editContent);
      setEditing(false);
      onRefresh(path);
    } finally {
      setSaving(false);
    }
  };

  const handleCancel = () => {
    setEditing(false);
  };

  return (
    <div className="flex-1 flex flex-col overflow-hidden">
      {/* Toolbar */}
      <div className="flex items-center gap-3 px-6 py-3 border-b border-gray-100 flex-shrink-0 bg-white">
        <button
          onClick={onBack}
          className="flex items-center gap-1.5 text-xs text-gray-400 hover:text-gray-700 transition-colors"
        >
          <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" d="M10.5 19.5 3 12m0 0 7.5-7.5M3 12h18" />
          </svg>
          返回
        </button>

        <span className="text-gray-200">|</span>
        <span className="text-xs text-gray-400 truncate flex-1 font-mono">{path}</span>

        {!editing && (
          <button
            onClick={handleEdit}
            className="px-3 py-1.5 text-xs bg-gray-100 hover:bg-gray-200 text-gray-600 rounded-lg transition-colors"
          >
            编辑
          </button>
        )}
        {editing && (
          <div className="flex gap-2">
            <button
              onClick={handleCancel}
              className="px-3 py-1.5 text-xs bg-gray-100 hover:bg-gray-200 text-gray-600 rounded-lg transition-colors"
            >
              取消
            </button>
            <button
              onClick={handleSave}
              disabled={saving}
              className="px-3 py-1.5 text-xs bg-amber-500 hover:bg-amber-600 text-white rounded-lg transition-colors disabled:opacity-50"
            >
              {saving ? '保存中...' : '保存'}
            </button>
          </div>
        )}
      </div>

      {loading && (
        <div className="flex-1 flex items-center justify-center text-sm text-gray-400">加载中...</div>
      )}

      {!loading && doc && !editing && (
        <div className="flex-1 overflow-y-auto">
          <div className="max-w-3xl mx-auto px-8 py-6">
            {/* Meta */}
            {(doc.frontmatter.tags.length > 0 || doc.frontmatter.updated) && (
              <div className="flex items-center gap-3 mb-6 flex-wrap">
                <div className="flex gap-1.5 flex-wrap">
                  {doc.frontmatter.tags.map(t => <TagBadge key={t} tag={t} />)}
                </div>
                {doc.frontmatter.updated && (
                  <span className="text-xs text-gray-400 ml-auto">{relativeTime(doc.frontmatter.updated)}</span>
                )}
              </div>
            )}

            {/* Markdown content */}
            <div className="prose prose-sm max-w-none prose-headings:font-semibold prose-code:text-amber-700 prose-code:bg-amber-50 prose-code:px-1 prose-code:rounded prose-pre:bg-gray-50 prose-pre:border prose-pre:border-gray-200">
              <ReactMarkdown remarkPlugins={[remarkGfm]} rehypePlugins={[rehypeHighlight]}>
                {/* Strip frontmatter from display */}
                {doc.content.startsWith('---')
                  ? doc.content.replace(/^---[\s\S]*?\n---\n?/, '')
                  : doc.content}
              </ReactMarkdown>
            </div>

            {/* History */}
            {doc.gitLog.length > 0 && (
              <div className="mt-8 border-t border-gray-100 pt-4">
                <button
                  onClick={() => setShowHistory(h => !h)}
                  className="text-xs text-gray-400 hover:text-gray-600 transition-colors"
                >
                  {showHistory ? '▾' : '▸'} 历史记录 ({doc.gitLog.length} 条)
                </button>
                {showHistory && (
                  <div className="mt-2 space-y-1">
                    {doc.gitLog.map(c => (
                      <div key={c.hash} className="flex items-center gap-3 text-xs text-gray-400">
                        <span className="font-mono text-[10px] text-gray-300">{c.hash.slice(0, 7)}</span>
                        <span className="flex-1 truncate">{c.message}</span>
                        <span className="flex-shrink-0">{new Date(c.date).toLocaleDateString('zh-CN')}</span>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}
          </div>
        </div>
      )}

      {!loading && doc && editing && (
        <div className="flex-1 flex flex-col overflow-hidden">
          <WikiEditor content={editContent} onChange={setEditContent} />
        </div>
      )}
    </div>
  );
}
