import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import rehypeHighlight from 'rehype-highlight';

interface Props {
  content?: string;
  error?: string;
  sourcePath?: string;
}

export function MarkdownView({ content, error, sourcePath }: Props) {
  if (error) {
    return (
      <div className="p-4 text-sm text-red-500">
        <div className="font-semibold mb-1">无法加载 Markdown</div>
        <div className="text-xs text-gray-500">{sourcePath}</div>
        <div className="text-xs mt-1">{error}</div>
      </div>
    );
  }
  if (content == null) {
    return <div className="p-4 text-xs text-gray-400">Loading…</div>;
  }
  return (
    <div className="h-full overflow-auto p-4 prose prose-sm max-w-none prose-headings:font-semibold prose-pre:bg-gray-900 prose-pre:text-gray-100">
      <ReactMarkdown remarkPlugins={[remarkGfm]} rehypePlugins={[rehypeHighlight]}>
        {content}
      </ReactMarkdown>
    </div>
  );
}
