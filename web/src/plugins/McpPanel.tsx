import { useState, useEffect, useRef } from 'react';

function validateMcpJson(text: string): string | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (e) {
    return `Invalid JSON: ${(e as Error).message}`;
  }
  if (typeof parsed !== 'object' || parsed === null || !('mcpServers' in parsed)) {
    return 'Root object must have a "mcpServers" key';
  }
  const servers = (parsed as Record<string, unknown>).mcpServers;
  if (typeof servers !== 'object' || servers === null || Array.isArray(servers)) {
    return '"mcpServers" must be a plain object';
  }
  for (const [name, cfg] of Object.entries(servers as Record<string, unknown>)) {
    if (typeof cfg !== 'object' || cfg === null) {
      return `Server "${name}": config must be an object`;
    }
    const transport = (cfg as Record<string, unknown>).transport;
    if (transport !== 'stdio' && transport !== 'sse' && transport !== 'http') {
      return `Server "${name}": transport must be "stdio", "sse", or "http"`;
    }
    if (transport === 'stdio' && !(cfg as Record<string, unknown>).command) {
      return `Server "${name}": stdio transport requires a "command" field`;
    }
    if ((transport === 'sse' || transport === 'http') && !(cfg as Record<string, unknown>).url) {
      return `Server "${name}": ${transport} transport requires a "url" field`;
    }
  }
  return null;
}

const TRANSPORT_FIELDS: [string, string, boolean][] = [
  ['name', 'Key in mcpServers object (unique identifier)', true],
  ['transport', '"stdio" | "sse" | "http"', true],
  ['description', 'Human-readable description (optional)', false],
  ['enabled', 'Set to false to disable without removing (optional)', false],
  ['useTools', 'Array of tool names to expose; omit for all (optional)', false],
];

const STDIO_FIELDS: [string, string, boolean][] = [
  ['command', 'Executable to run (e.g. "npx", "node")', true],
  ['args', 'Array of arguments (optional)', false],
  ['env', 'Extra environment variables as object (optional)', false],
];

const SSE_FIELDS: [string, string, boolean][] = [
  ['url', 'Server URL (e.g. "http://localhost:3000/sse")', true],
];

const HTTP_FIELDS: [string, string, boolean][] = [
  ['url', 'Server URL (e.g. "http://localhost:3001/mcp")', true],
  ['headers', 'Extra HTTP headers as object (optional)', false],
];

const MINI_EXAMPLE = `{
  "mcpServers": {
    "github": {
      "transport": "stdio",
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-github"],
      "env": { "GITHUB_TOKEN": "ghp_xxx" }
    },
    "my-sse": {
      "transport": "sse",
      "url": "http://localhost:3001/sse"
    },
    "my-http": {
      "transport": "http",
      "url": "http://localhost:3002/mcp",
      "headers": { "Authorization": "Bearer token" }
    }
  }
}`;

export function McpPanel() {
  const [text, setText] = useState('');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);
  const [refOpen, setRefOpen] = useState(true);
  const successTimer = useRef<ReturnType<typeof setTimeout>>();

  useEffect(() => {
    fetch('/api/mcp')
      .then(r => r.json())
      .then(data => { setText(JSON.stringify(data, null, 2)); setLoading(false); })
      .catch(() => { setText('{\n  "mcpServers": {}\n}'); setLoading(false); });
  }, []);

  async function handleSave() {
    setError(null);
    setSuccess(false);
    const validationError = validateMcpJson(text);
    if (validationError) { setError(validationError); return; }
    setSaving(true);
    try {
      const res = await fetch('/api/mcp', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: text,
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
        setError((data as { error?: string }).error ?? `HTTP ${res.status}`);
      } else {
        setSuccess(true);
        clearTimeout(successTimer.current);
        successTimer.current = setTimeout(() => setSuccess(false), 2500);
      }
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="flex flex-col h-full overflow-hidden">
      {/* Reference panel */}
      <div className="border-b border-gray-100 bg-white flex-shrink-0">
        <button
          onClick={() => setRefOpen(o => !o)}
          className="w-full flex items-center gap-2 px-5 py-3 text-left hover:bg-gray-50 transition-colors"
        >
          <svg
            className={`w-3 h-3 text-gray-400 transition-transform flex-shrink-0 ${refOpen ? 'rotate-90' : ''}`}
            fill="none" viewBox="0 0 24 24" strokeWidth={2.5} stroke="currentColor"
          >
            <path strokeLinecap="round" strokeLinejoin="round" d="M8.25 4.5l7.5 7.5-7.5 7.5" />
          </svg>
          <span className="text-xs font-semibold text-gray-500 tracking-wide uppercase">Reference</span>
        </button>

        {refOpen && (
          <div className="px-5 pb-5 grid grid-cols-2 gap-x-10 gap-y-4 text-xs">
            {/* Example */}
            <div>
              <div className="font-semibold text-gray-700 mb-2">Example</div>
              <pre className="bg-gray-50 border border-gray-100 rounded-lg p-2.5 text-[10px] text-gray-500 leading-relaxed overflow-x-auto">{MINI_EXAMPLE}</pre>
            </div>

            {/* Fields */}
            <div className="space-y-3">
              <div>
                <div className="font-semibold text-gray-700 mb-1.5">Common Fields</div>
                <table className="w-full text-[11px]">
                  <tbody>
                    {TRANSPORT_FIELDS.map(([field, desc, required]) => (
                      <tr key={field} className="align-top">
                        <td className="pr-3 py-0.5 font-mono text-violet-600 whitespace-nowrap">
                          {field}{required && <span className="text-red-400 ml-0.5">*</span>}
                        </td>
                        <td className="py-0.5 text-gray-400 leading-relaxed">{desc}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <div>
                <div className="font-semibold text-gray-700 mb-1.5">stdio Fields</div>
                <table className="w-full text-[11px]">
                  <tbody>
                    {STDIO_FIELDS.map(([field, desc, required]) => (
                      <tr key={field} className="align-top">
                        <td className="pr-3 py-0.5 font-mono text-violet-600 whitespace-nowrap">
                          {field}{required && <span className="text-red-400 ml-0.5">*</span>}
                        </td>
                        <td className="py-0.5 text-gray-400 leading-relaxed">{desc}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <div>
                <div className="font-semibold text-gray-700 mb-1.5">sse Fields</div>
                <table className="w-full text-[11px]">
                  <tbody>
                    {SSE_FIELDS.map(([field, desc, required]) => (
                      <tr key={field} className="align-top">
                        <td className="pr-3 py-0.5 font-mono text-violet-600 whitespace-nowrap">
                          {field}{required && <span className="text-red-400 ml-0.5">*</span>}
                        </td>
                        <td className="py-0.5 text-gray-400 leading-relaxed">{desc}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <div>
                <div className="font-semibold text-gray-700 mb-1.5">http Fields</div>
                <table className="w-full text-[11px]">
                  <tbody>
                    {HTTP_FIELDS.map(([field, desc, required]) => (
                      <tr key={field} className="align-top">
                        <td className="pr-3 py-0.5 font-mono text-violet-600 whitespace-nowrap">
                          {field}{required && <span className="text-red-400 ml-0.5">*</span>}
                        </td>
                        <td className="py-0.5 text-gray-400 leading-relaxed">{desc}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <div className="text-[11px] text-gray-400 pt-1 border-t border-gray-50 space-y-0.5">
                <div>Config saved to <span className="font-mono">~/.semaclaw/mcp.json</span> · Changes apply to active agents immediately</div>
                <div className="text-amber-500">Note: <span className="font-mono">headers</span> is only supported for <span className="font-mono">http</span> transport, not <span className="font-mono">sse</span></div>
              </div>
            </div>
          </div>
        )}
      </div>

      {/* JSON editor */}
      <div className="flex-1 min-h-0 p-4 overflow-hidden flex flex-col">
        <textarea
          value={loading ? 'Loading…' : text}
          onChange={e => { setText(e.target.value); setError(null); setSuccess(false); }}
          disabled={loading || saving}
          spellCheck={false}
          className="flex-1 w-full font-mono text-xs text-gray-700 bg-white border border-gray-200 rounded-xl p-4 resize-none focus:outline-none focus:ring-2 focus:ring-violet-300 focus:border-violet-300 disabled:bg-gray-50 disabled:text-gray-400 transition-colors"
          placeholder={'{\n  "mcpServers": {}\n}'}
        />
      </div>

      {/* Footer */}
      <div className="flex-shrink-0 border-t border-gray-100 bg-white px-5 py-3 flex items-center justify-between gap-4">
        <div className="flex-1 min-w-0">
          {error && (
            <div className="flex items-start gap-1.5 text-xs text-red-600">
              <svg className="w-3.5 h-3.5 flex-shrink-0 mt-0.5" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" d="M12 9v3.75m-9.303 3.376c-.866 1.5.217 3.374 1.948 3.374h14.71c1.73 0 2.813-1.874 1.948-3.374L13.949 3.378c-.866-1.5-3.032-1.5-3.898 0L2.697 16.126ZM12 15.75h.007v.008H12v-.008Z" />
              </svg>
              <span>{error}</span>
            </div>
          )}
          {success && (
            <div className="flex items-center gap-1.5 text-xs text-green-600">
              <svg className="w-3.5 h-3.5 flex-shrink-0" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" d="M9 12.75 11.25 15 15 9.75M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0Z" />
              </svg>
              Saved successfully
            </div>
          )}
        </div>
        <button
          onClick={handleSave}
          disabled={loading || saving}
          className="flex items-center gap-1.5 px-4 py-2 bg-violet-600 hover:bg-violet-700 disabled:bg-violet-300 text-white text-xs font-semibold rounded-lg transition-colors flex-shrink-0"
        >
          {saving ? (
            <>
              <svg className="w-3.5 h-3.5 animate-spin" fill="none" viewBox="0 0 24 24">
                <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="3" />
                <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8H4z" />
              </svg>
              Saving…
            </>
          ) : 'Save'}
        </button>
      </div>
    </div>
  );
}
