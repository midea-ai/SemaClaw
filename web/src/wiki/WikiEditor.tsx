/**
 * WikiEditor — Markdown 编辑器组件
 *
 * 当前实现：受控 <textarea>，组件化封装，后期替换只改这一个文件。
 */

interface Props {
  content: string;
  onChange: (val: string) => void;
}

export function WikiEditor({ content, onChange }: Props) {
  return (
    <textarea
      value={content}
      onChange={e => onChange(e.target.value)}
      className="w-full h-full resize-none outline-none font-mono text-sm text-gray-800 leading-relaxed p-4 bg-white"
      spellCheck={false}
      placeholder="# 标题&#10;&#10;在此输入 Markdown 内容..."
    />
  );
}
