import { useEffect, useMemo, useState } from 'react';

interface Props {
  /** HTML 文件内容（已通过 WS 后端代读拿到） */
  srcdoc?: string;
  /** 渲染来源路径，仅用于错误展示 */
  sourcePath?: string;
  /** 加载错误信息 */
  error?: string;
}

/**
 * Inject `<base target="_blank">` into the document so that <a href> clicks
 * open in a new tab/window instead of navigating the iframe itself (which,
 * under the same origin as semaclaw's webui, would load the webui inside
 * the iframe → nested chat UI).
 *
 * If a <head> exists, prepend the <base> there; otherwise wrap the doc in
 * a minimal <html><head>...<base>...</head><body>{doc}</body></html>.
 */
function withBaseTarget(html: string): string {
  // Only skip if the doc already declares a <base ... target=...> — a bare
  // `<base href="...">` doesn't change link-target behavior, so we still inject.
  if (/<base\b[^>]*\btarget\s*=/i.test(html)) return html;
  const baseTag = '<base target="_blank">';
  if (/<head\b[^>]*>/i.test(html)) {
    return html.replace(/<head\b[^>]*>/i, (m) => `${m}${baseTag}`);
  }
  if (/<html\b[^>]*>/i.test(html)) {
    return html.replace(/<html\b[^>]*>/i, (m) => `${m}<head>${baseTag}</head>`);
  }
  return `<!doctype html><html><head>${baseTag}</head><body>${html}</body></html>`;
}

export function HtmlIframe({ srcdoc, sourcePath, error }: Props) {
  const prepared = useMemo(() => (srcdoc == null ? undefined : withBaseTarget(srcdoc)), [srcdoc]);
  const [delayed, setDelayed] = useState<string | undefined>(prepared);
  // 切换 artifact 时短暂卸载 iframe，避免 srcdoc 残留
  useEffect(() => {
    setDelayed(undefined);
    const t = setTimeout(() => setDelayed(prepared), 0);
    return () => clearTimeout(t);
  }, [prepared]);

  if (error) {
    return (
      <div className="p-4 text-sm text-red-500">
        <div className="font-semibold mb-1">无法加载 HTML</div>
        <div className="text-xs text-gray-500">{sourcePath}</div>
        <div className="text-xs mt-1">{error}</div>
      </div>
    );
  }

  if (delayed == null) {
    return <div className="p-4 text-xs text-gray-400">Loading…</div>;
  }

  return (
    <iframe
      title={sourcePath ?? 'workbench-html'}
      srcDoc={delayed}
      sandbox="allow-scripts allow-popups allow-popups-to-escape-sandbox"
      className="w-full h-full border-0 bg-white"
    />
  );
}
