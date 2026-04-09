import { useState, useCallback } from 'react';

// ── Types ─────────────────────────────────────────────────────────

export interface Frontmatter {
  created: string;
  updated: string;
  tags: string[];
  source: string;
}

export interface DirNode {
  name: string;
  path: string;
  type: 'dir' | 'file';
  children?: DirNode[];
  frontmatter?: Frontmatter;
}

export interface WikiDoc {
  path: string;
  content: string;
  frontmatter: Frontmatter;
  gitLog: GitCommit[];
}

export interface SearchResult {
  path: string;
  title: string;
  tags: string[];
  updated: string;
}

export interface WikiStats {
  totalFiles: number;
  totalDirs: number;
  byCategory: { dir: string; count: number; lastUpdated: string }[];
  byTag: { tag: string; count: number }[];
  recentFiles: { path: string; title: string; updated: string }[];
}

export interface GitCommit {
  hash: string;
  date: string;
  message: string;
}

export interface TagEntry {
  name: string;
  count: number;
}

// ── API helpers ───────────────────────────────────────────────────

async function apiFetch<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, init);
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`API ${res.status}: ${body.slice(0, 200)}`);
  }
  return res.json() as Promise<T>;
}

// ── useWiki hook ──────────────────────────────────────────────────

export function useWiki() {
  const [tree, setTree] = useState<DirNode[]>([]);
  const [treeLoading, setTreeLoading] = useState(false);
  const [doc, setDoc] = useState<WikiDoc | null>(null);
  const [docLoading, setDocLoading] = useState(false);
  const [searchResults, setSearchResults] = useState<SearchResult[]>([]);
  const [searching, setSearching] = useState(false);
  const [stats, setStats] = useState<WikiStats | null>(null);
  const [tags, setTags] = useState<TagEntry[]>([]);
  const [error, setError] = useState<string | null>(null);

  const fetchTree = useCallback(async () => {
    setTreeLoading(true);
    setError(null);
    try {
      const data = await apiFetch<{ tree: DirNode[] }>('/api/wiki/tree');
      setTree(data.tree);
    } catch (e) {
      setError(String((e as Error).message));
    } finally {
      setTreeLoading(false);
    }
  }, []);

  const fetchDoc = useCallback(async (path: string) => {
    setDocLoading(true);
    setError(null);
    try {
      const data = await apiFetch<WikiDoc>(`/api/wiki/file?path=${encodeURIComponent(path)}`);
      setDoc(data);
    } catch (e) {
      setError(String((e as Error).message));
    } finally {
      setDocLoading(false);
    }
  }, []);

  const saveDoc = useCallback(async (
    path: string,
    content: string,
    opts?: { tags?: string[]; source?: string },
  ): Promise<void> => {
    await apiFetch('/api/wiki/file', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path, content, source: opts?.source ?? 'manual', tags: opts?.tags }),
    });
  }, []);

  const search = useCallback(async (q: string, filterTags?: string[]) => {
    setSearching(true);
    setError(null);
    try {
      const params = new URLSearchParams({ q, limit: '30' });
      if (filterTags?.length) params.set('tags', filterTags.join(','));
      const data = await apiFetch<{ results: SearchResult[] }>(`/api/wiki/search?${params}`);
      setSearchResults(data.results);
    } catch (e) {
      setError(String((e as Error).message));
    } finally {
      setSearching(false);
    }
  }, []);

  const fetchStats = useCallback(async () => {
    try {
      const data = await apiFetch<WikiStats>('/api/wiki/stats');
      setStats(data);
    } catch (e) {
      setError(String((e as Error).message));
    }
  }, []);

  const fetchTags = useCallback(async () => {
    try {
      const data = await apiFetch<{ tags: TagEntry[] }>('/api/wiki/tags');
      setTags(data.tags);
    } catch (e) {
      setError(String((e as Error).message));
    }
  }, []);

  const mkdir = useCallback(async (path: string): Promise<void> => {
    await apiFetch('/api/wiki/mkdir', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path }),
    });
  }, []);

  const deleteDir = useCallback(async (path: string): Promise<void> => {
    await apiFetch(`/api/wiki/dir?path=${encodeURIComponent(path)}`, { method: 'DELETE' });
  }, []);

  return {
    tree, treeLoading,
    doc, docLoading,
    searchResults, searching,
    stats,
    tags,
    error,
    fetchTree,
    fetchDoc,
    saveDoc,
    search,
    fetchStats,
    fetchTags,
    mkdir,
    deleteDir,
    clearDoc: () => setDoc(null),
    clearSearch: () => setSearchResults([]),
    clearError: () => setError(null),
  };
}
