import { useState, useEffect, useRef } from 'react';

function validateHooksJson(text: string): string | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (e) {
    return `Invalid JSON: ${(e as Error).message}`;
  }
  if (typeof parsed !== 'object' || parsed === null || !('hooks' in parsed)) {
    return 'Root object must have a "hooks" key';
  }
  const hooks = (parsed as Record<string, unknown>).hooks;
  if (typeof hooks !== 'object' || hooks === null || Array.isArray(hooks)) {
    return '"hooks" must be a plain object';
  }
  for (const [event, configs] of Object.entries(hooks as Record<string, unknown>)) {
    if (!Array.isArray(configs)) {
      return `Event "${event}": value must be an array`;
    }
    for (let i = 0; i < configs.length; i++) {
      const cfg = configs[i] as Record<string, unknown>;
      if (!Array.isArray(cfg?.hooks)) {
        return `Event "${event}"[${i}]: each item must have a "hooks" array`;
      }
      for (let j = 0; j < (cfg.hooks as unknown[]).length; j++) {
        const hook = (cfg.hooks as Record<string, unknown>[])[j];
        if (hook.type !== 'command' && hook.type !== 'prompt') {
          return `Event "${event}"[${i}].hooks[${j}]: type must be "command" or "prompt"`;
        }
        if (hook.type === 'command' && !hook.command) {
          return `Event "${event}"[${i}].hooks[${j}]: type "command" requires a "command" field`;
        }
        if (hook.type === 'prompt' && !hook.prompt) {
          return `Event "${event}"[${i}].hooks[${j}]: type "prompt" requires a "prompt" field`;
        }
      }
    }
  }
  return null;
}

// Events that are fully injected in the codebase
const ACTIVE_EVENTS = [
  'UserPromptSubmit',
  'PreToolUse',
  'PostToolUse',
  'PermissionRequest',
  'Stop',
  'SessionStart',
  'PreCompact',
  'PostCompact',
];


const FIELDS: [string, string, boolean][] = [
  ['type', '"command" | "prompt"', true],
  ['command', 'Shell command to run (for type "command")', false],
  ['prompt', 'Prompt text to inject (for type "prompt")', false],
  ['matcher', 'Glob matched against tool name, e.g. "Bash", "Bash,Write", "*" (optional)', false],
  ['if', 'Regex matched against tool_input content (optional)', false],
  ['timeout', 'Max runtime in seconds (default 10)', false],
  ['blocking', 'Block agent if hook fails (default true)', false],
  ['async', 'Fire-and-forget, no waiting (default false)', false],
];

const MINI_EXAMPLE = `{
  "hooks": {
    "PostToolUse": [{
      "matcher": "Bash",
      "hooks": [{
        "type": "command",
        "command": "echo done"
      }]
    }]
  }
}`;

export function HooksPanel() {
  const [text, setText] = useState('');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);
  const [refOpen, setRefOpen] = useState(true);
  const successTimer = useRef<ReturnType<typeof setTimeout>>();

  useEffect(() => {
    fetch('/api/hooks')
      .then(r => r.json())
      .then(data => { setText(JSON.stringify(data, null, 2)); setLoading(false); })
      .catch(() => { setText('{\n  "hooks": {}\n}'); setLoading(false); });
  }, []);

  async function handleSave() {
    setError(null);
    setSuccess(false);
    const validationError = validateHooksJson(text);
    if (validationError) { setError(validationError); return; }
    setSaving(true);
    try {
      const res = await fetch('/api/hooks', {
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
            {/* Events */}
            <div>
              <div className="font-semibold text-gray-700 mb-2">Supported Events</div>
              <div className="flex flex-wrap gap-1">
                {ACTIVE_EVENTS.map(e => (
                  <span key={e} className="font-mono text-[11px] text-violet-700 bg-violet-50 border border-violet-100 rounded px-1.5 py-0.5">{e}</span>
                ))}
              </div>
            </div>

            {/* Example */}
            <div>
              <div className="font-semibold text-gray-700 mb-2">Minimal Example</div>
              <pre className="bg-gray-50 border border-gray-100 rounded-lg p-2.5 text-[10px] text-gray-500 leading-relaxed overflow-x-auto">{MINI_EXAMPLE}</pre>
            </div>

            {/* Fields */}
            <div>
              <div className="font-semibold text-gray-700 mb-2">Hook Fields</div>
              <table className="w-full text-[11px]">
                <tbody>
                  {FIELDS.map(([field, desc, required]) => (
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

            {/* Variables */}
            <div>
              <div className="font-semibold text-gray-700 mb-2">Variables (usable in command / prompt)</div>
              <div className="space-y-1.5 text-[11px]">
                <div>
                  <span className="font-mono text-violet-600">{'${SEMACLAW_ROOT}'}</span>
                  <span className="text-gray-400 ml-2">Global config dir (~/.semaclaw)</span>
                </div>
                <div>
                  <span className="font-mono text-violet-600">{'${AGENT_WORKSPACE}'}</span>
                  <span className="text-gray-400 ml-2">Agent working directory</span>
                </div>
              </div>
              <div className="mt-3 text-[11px] text-gray-400 leading-relaxed">
                <span className="font-semibold text-gray-500">Structure: </span>
                <span className="font-mono">hooks[event] → EventConfig[] → hooks[] → HookDefinition</span>
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
          placeholder={'{\n  "hooks": {}\n}'}
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
