/**
 * WikiCategories — 分类管理页
 * 树形展示目录，支持新建（不支持删除有文件的目录）
 */

import { useEffect, useState } from 'react';
import type { DirNode } from '../hooks/useWiki';

interface Props {
  tree: DirNode[];
  treeLoading: boolean;
  onRefreshTree: () => void;
  onMkdir: (path: string) => Promise<void>;
  onDeleteDir: (path: string) => Promise<void>;
  onSelectDoc: (path: string) => void;
}

function countFiles(node: DirNode): number {
  if (node.type === 'file') return 1;
  return (node.children ?? []).reduce((s, c) => s + countFiles(c), 0);
}

function countDirs(node: DirNode): number {
  if (node.type === 'file') return 0;
  return 1 + (node.children ?? []).reduce((s, c) => s + countDirs(c), 0);
}

function DirRow({
  node, depth, onMkdir, onDeleteDir, onSelectDoc, onRefresh,
}: {
  node: DirNode;
  depth: number;
  onMkdir: (path: string) => Promise<void>;
  onDeleteDir: (path: string) => Promise<void>;
  onSelectDoc: (path: string) => void;
  onRefresh: () => void;
}) {
  const [open, setOpen] = useState(depth < 2);
  const [addingSubdir, setAddingSubdir] = useState(false);
  const [newName, setNewName] = useState('');
  const [creating, setCreating] = useState(false);
  const [deleting, setDeleting] = useState(false);

  const fileCount = countFiles(node);
  const isEmpty = fileCount === 0 && (node.children ?? []).filter(c => c.type === 'dir' || c.type === 'file').length === 0;
  const indent = depth * 16;

  if (node.type === 'file') {
    const name = node.name.replace(/\.md$/, '');
    return (
      <button
        onClick={() => onSelectDoc(node.path)}
        className="w-full flex items-center gap-2 py-1.5 px-3 text-xs text-gray-500 hover:bg-gray-50 hover:text-gray-700 transition-colors text-left"
        style={{ paddingLeft: `${indent + 12}px` }}
      >
        <svg className="w-3 h-3 flex-shrink-0 text-gray-300" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor">
          <path strokeLinecap="round" strokeLinejoin="round" d="M19.5 14.25v-2.625a3.375 3.375 0 0 0-3.375-3.375h-1.5A1.125 1.125 0 0 1 13.5 7.125v-1.5a3.375 3.375 0 0 0-3.375-3.375H8.25m2.25 0H5.625c-.621 0-1.125.504-1.125 1.125v17.25c0 .621.504 1.125 1.125 1.125h12.75c.621 0 1.125-.504 1.125-1.125V11.25a9 9 0 0 0-9-9Z" />
        </svg>
        <span className="truncate">{name}</span>
      </button>
    );
  }

  const handleCreate = async () => {
    const name = newName.trim().toLowerCase().replace(/\s+/g, '-');
    if (!name) return;
    setCreating(true);
    try {
      await onMkdir(`${node.path}/${name}`);
      setNewName('');
      setAddingSubdir(false);
      onRefresh();
    } finally {
      setCreating(false);
    }
  };

  const handleDelete = async () => {
    if (!isEmpty) return;
    setDeleting(true);
    try {
      await onDeleteDir(node.path);
      onRefresh();
    } finally {
      setDeleting(false);
    }
  };

  return (
    <div>
      {/* Dir row */}
      <div
        className="flex items-center gap-2 py-1.5 px-3 hover:bg-gray-50 group"
        style={{ paddingLeft: `${indent + 8}px` }}
      >
        <button onClick={() => setOpen(o => !o)} className="flex items-center gap-1.5 flex-1 min-w-0 text-left">
          <span className="text-gray-300 text-[10px] w-3">{open ? '▾' : '▸'}</span>
          <svg className="w-4 h-4 flex-shrink-0 text-amber-400" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" d="M2.25 12.75V12A2.25 2.25 0 0 1 4.5 9.75h15A2.25 2.25 0 0 1 21.75 12v.75m-8.69-6.44-2.12-2.12a1.5 1.5 0 0 0-1.061-.44H4.5A2.25 2.25 0 0 0 2.25 6v12a2.25 2.25 0 0 0 2.25 2.25h15A2.25 2.25 0 0 0 21.75 18V9a2.25 2.25 0 0 0-2.25-2.25h-5.379a1.5 1.5 0 0 1-1.06-.44Z" />
          </svg>
          <span className="text-sm font-medium text-gray-700 truncate">{node.name}</span>
          {fileCount > 0 && (
            <span className="text-xs text-gray-400 ml-1">{fileCount} 篇</span>
          )}
        </button>

        {/* Actions (visible on hover) */}
        <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity flex-shrink-0">
          <button
            onClick={() => { setAddingSubdir(a => !a); setNewName(''); }}
            title="新建子目录"
            className="p-1 text-gray-400 hover:text-amber-600 hover:bg-amber-50 rounded transition-colors"
          >
            <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" d="M12 4.5v15m7.5-7.5h-15" />
            </svg>
          </button>
          {isEmpty && (
            <button
              onClick={handleDelete}
              disabled={deleting}
              title="删除空目录"
              className="p-1 text-gray-300 hover:text-red-500 hover:bg-red-50 rounded transition-colors disabled:opacity-30"
            >
              <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" d="m14.74 9-.346 9m-4.788 0L9.26 9m9.968-3.21c.342.052.682.107 1.022.166m-1.022-.165L18.16 19.673a2.25 2.25 0 0 1-2.244 2.077H8.084a2.25 2.25 0 0 1-2.244-2.077L4.772 5.79m14.456 0a48.108 48.108 0 0 0-3.478-.397m-12 .562c.34-.059.68-.114 1.022-.165m0 0a48.11 48.11 0 0 1 3.478-.397m7.5 0v-.916c0-1.18-.91-2.164-2.09-2.201a51.964 51.964 0 0 0-3.32 0c-1.18.037-2.09 1.022-2.09 2.201v.916m7.5 0a48.667 48.667 0 0 0-7.5 0" />
              </svg>
            </button>
          )}
        </div>
      </div>

      {/* Inline new subdir input */}
      {addingSubdir && (
        <div className="flex items-center gap-2 py-1 px-3" style={{ paddingLeft: `${indent + 36}px` }}>
          <input
            type="text"
            value={newName}
            onChange={e => setNewName(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter') handleCreate(); if (e.key === 'Escape') setAddingSubdir(false); }}
            placeholder="目录名 (kebab-case)"
            autoFocus
            className="flex-1 px-2 py-1 text-xs bg-amber-50 rounded border border-amber-200 outline-none focus:ring-1 focus:ring-amber-300"
          />
          <button
            onClick={handleCreate}
            disabled={creating || !newName.trim()}
            className="px-2 py-1 text-xs bg-amber-500 text-white rounded hover:bg-amber-600 disabled:opacity-40 transition-colors"
          >
            {creating ? '...' : '创建'}
          </button>
          <button onClick={() => setAddingSubdir(false)} className="text-gray-400 hover:text-gray-600 text-xs px-1">取消</button>
        </div>
      )}

      {/* Children */}
      {open && node.children && (
        <div>
          {node.children.map(child => (
            <DirRow
              key={child.path}
              node={child}
              depth={depth + 1}
              onMkdir={onMkdir}
              onDeleteDir={onDeleteDir}
              onSelectDoc={onSelectDoc}
              onRefresh={onRefresh}
            />
          ))}
        </div>
      )}
    </div>
  );
}

export function WikiCategories({ tree, treeLoading, onRefreshTree, onMkdir, onDeleteDir, onSelectDoc }: Props) {
  const [addingRoot, setAddingRoot] = useState(false);
  const [rootName, setRootName] = useState('');
  const [creating, setCreating] = useState(false);

  useEffect(() => {
    onRefreshTree();
  }, [onRefreshTree]);

  // Poll for tree changes every 30s
  useEffect(() => {
    const id = setInterval(onRefreshTree, 30000);
    return () => clearInterval(id);
  }, [onRefreshTree]);

  const handleCreateRoot = async () => {
    const name = rootName.trim().toLowerCase().replace(/\s+/g, '-');
    if (!name) return;
    setCreating(true);
    try {
      await onMkdir(name);
      setRootName('');
      setAddingRoot(false);
      onRefreshTree();
    } finally {
      setCreating(false);
    }
  };

  const totalFiles = tree.reduce((s, n) => s + countFiles(n), 0);
  const totalDirs = tree.reduce((s, n) => s + countDirs(n), 0);

  return (
    <div className="flex-1 overflow-y-auto">
      <div className="max-w-2xl mx-auto px-8 py-8">
        {/* Header */}
        <div className="flex items-center justify-between mb-6">
          <div>
            <h1 className="text-base font-semibold text-gray-700">目录管理</h1>
            {!treeLoading && (
              <p className="text-xs text-gray-400 mt-0.5">{totalDirs} 个目录 · {totalFiles} 篇文档</p>
            )}
          </div>
          <button
            onClick={() => { setAddingRoot(a => !a); setRootName(''); }}
            className="flex items-center gap-1.5 px-3 py-1.5 text-xs bg-amber-50 text-amber-700 hover:bg-amber-100 rounded-lg transition-colors"
          >
            <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" d="M12 4.5v15m7.5-7.5h-15" />
            </svg>
            新建根目录
          </button>
        </div>

        {/* New root dir input */}
        {addingRoot && (
          <div className="flex items-center gap-2 mb-4 p-3 bg-amber-50 rounded-lg border border-amber-200">
            <input
              type="text"
              value={rootName}
              onChange={e => setRootName(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter') handleCreateRoot(); if (e.key === 'Escape') setAddingRoot(false); }}
              placeholder="目录名 (kebab-case, 如 programming)"
              autoFocus
              className="flex-1 px-3 py-1.5 text-sm bg-white rounded border border-amber-200 outline-none focus:ring-1 focus:ring-amber-300"
            />
            <button
              onClick={handleCreateRoot}
              disabled={creating || !rootName.trim()}
              className="px-3 py-1.5 text-sm bg-amber-500 text-white rounded hover:bg-amber-600 disabled:opacity-40 transition-colors"
            >
              {creating ? '...' : '创建'}
            </button>
            <button onClick={() => setAddingRoot(false)} className="text-gray-400 hover:text-gray-600 text-sm px-1">取消</button>
          </div>
        )}

        {/* Tree */}
        {treeLoading && <p className="text-sm text-gray-400 py-4">加载中...</p>}
        {!treeLoading && tree.length === 0 && (
          <div className="text-center py-12 text-gray-400 text-sm">
            <p>还没有目录</p>
            <p className="text-xs mt-1">点击"新建根目录"开始</p>
          </div>
        )}
        {!treeLoading && tree.length > 0 && (
          <div className="border border-gray-100 rounded-xl overflow-hidden">
            {tree.map(node => (
              <DirRow
                key={node.path}
                node={node}
                depth={0}
                onMkdir={onMkdir}
                onDeleteDir={onDeleteDir}
                onSelectDoc={onSelectDoc}
                onRefresh={onRefreshTree}
              />
            ))}
          </div>
        )}

        <p className="text-xs text-gray-300 mt-4">
          提示：有文件的目录不可删除。可直接在文件系统中操作文件夹，前端每 30 秒自动刷新。
        </p>
      </div>
    </div>
  );
}
