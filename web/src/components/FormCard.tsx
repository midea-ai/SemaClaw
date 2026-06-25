import { useState } from 'react';
import type { FormMessage, FormFieldDef } from '../types';

interface FormCardProps {
  message: FormMessage;
  onResolve: (requestId: string, values: Record<string, unknown>, submitted: boolean) => void;
  /** dock 渲染时去掉聊天气泡的宽度约束 */
  variant?: 'inline' | 'dock';
}

function isEmpty(v: unknown): boolean {
  if (v === undefined || v === null || v === '') return true;
  if (Array.isArray(v)) return v.length === 0;
  return false;
}

const LABEL_CLS = 'block text-[11px] font-semibold text-[#5BBFE8] uppercase tracking-wide mb-1';
const INPUT_CLS =
  'w-full px-3 py-2 rounded-xl border border-gray-200 text-sm text-gray-800 bg-white outline-none focus:border-[#5BBFE8] disabled:bg-gray-50 disabled:text-gray-400 transition-colors';

// ===== 单字段渲染 =====

function Field({
  field,
  value,
  setValue,
  disabled,
}: {
  field: FormFieldDef;
  value: unknown;
  setValue: (v: unknown) => void;
  disabled: boolean;
}) {
  if (field.type === 'static_text') {
    if (field.variant === 'divider') return <hr className="my-3 border-gray-100" />;
    if (field.variant === 'heading')
      return <p className="font-semibold text-gray-800 text-sm mt-2">{field.text}</p>;
    return <p className="text-xs text-gray-500">{field.text}</p>;
  }

  const label = (
    <label className={LABEL_CLS}>
      {field.label}
      {field.required && <span className="text-red-400 ml-0.5">*</span>}
    </label>
  );
  const help = field.help && <p className="text-[11px] text-gray-400 mt-1">{field.help}</p>;

  let control: React.ReactNode = null;

  switch (field.type) {
    case 'text':
      control = (
        <input type="text" className={INPUT_CLS} disabled={disabled} placeholder={field.placeholder}
          maxLength={field.maxLength} value={(value as string) ?? ''}
          onChange={(e) => setValue(e.target.value)} />
      );
      break;
    case 'textarea':
      control = (
        <textarea className={INPUT_CLS} disabled={disabled} placeholder={field.placeholder}
          maxLength={field.maxLength} rows={field.rows ?? 4} value={(value as string) ?? ''}
          onChange={(e) => setValue(e.target.value)} />
      );
      break;
    case 'number':
      control = (
        <input type="number" className={INPUT_CLS} disabled={disabled}
          min={field.min} max={field.max} step={field.step}
          value={value === undefined || value === null ? '' : (value as number)}
          onChange={(e) => setValue(e.target.value === '' ? undefined : Number(e.target.value))} />
      );
      break;
    case 'slider':
      control = (
        <div className="flex items-center gap-3">
          <input type="range" className="flex-1 accent-[#5BBFE8]" disabled={disabled}
            min={field.min} max={field.max} step={field.step ?? 1}
            value={(value as number) ?? field.min}
            onChange={(e) => setValue(Number(e.target.value))} />
          <span className="text-sm font-mono text-gray-700 w-12 text-right">
            {(value as number) ?? field.min}
          </span>
        </div>
      );
      break;
    case 'select':
      control = (
        <select className={INPUT_CLS} disabled={disabled} value={(value as string) ?? ''}
          onChange={(e) => setValue(e.target.value)}>
          <option value="" disabled>请选择…</option>
          {field.options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
        </select>
      );
      break;
    case 'radio':
      control = (
        <div className="space-y-1.5">
          {field.options.map((o) => {
            const checked = value === o.value;
            return (
              <button key={o.value} type="button" disabled={disabled}
                onClick={() => setValue(o.value)}
                className={`w-full flex items-center gap-2.5 px-3 py-2 rounded-xl border text-sm text-left transition-colors ${
                  checked ? 'bg-[#EEF7FD] border-[#5BBFE8] text-gray-800'
                          : 'bg-white border-gray-200 text-gray-700 hover:bg-[#F8FCFE] hover:border-[#5BBFE8]/50'
                } disabled:cursor-default`}>
                <span className={`w-4 h-4 rounded-full border-2 flex-shrink-0 ${checked ? 'border-[#5BBFE8] bg-[#5BBFE8]' : 'border-gray-300'}`} />
                {o.label}
              </button>
            );
          })}
        </div>
      );
      break;
    case 'multiselect': {
      const arr = (value as string[]) ?? [];
      control = (
        <div className="space-y-1.5">
          {field.options.map((o) => {
            const checked = arr.includes(o.value);
            return (
              <button key={o.value} type="button" disabled={disabled}
                onClick={() => setValue(checked ? arr.filter((x) => x !== o.value) : [...arr, o.value])}
                className={`w-full flex items-center gap-2.5 px-3 py-2 rounded-xl border text-sm text-left transition-colors ${
                  checked ? 'bg-[#EEF7FD] border-[#5BBFE8] text-gray-800'
                          : 'bg-white border-gray-200 text-gray-700 hover:bg-[#F8FCFE] hover:border-[#5BBFE8]/50'
                } disabled:cursor-default`}>
                <span className={`w-4 h-4 rounded-md border-2 flex items-center justify-center flex-shrink-0 ${checked ? 'border-[#5BBFE8] bg-[#5BBFE8]' : 'border-gray-300'}`}>
                  {checked && (
                    <svg className="w-2.5 h-2.5 text-white" fill="currentColor" viewBox="0 0 20 20">
                      <path fillRule="evenodd" d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z" clipRule="evenodd" />
                    </svg>
                  )}
                </span>
                {o.label}
              </button>
            );
          })}
        </div>
      );
      break;
    }
    case 'checkbox':
      control = (
        <button type="button" disabled={disabled} onClick={() => setValue(!(value as boolean))}
          className="flex items-center gap-2.5 text-sm text-gray-700 disabled:cursor-default">
          <span className={`w-4 h-4 rounded-md border-2 flex items-center justify-center flex-shrink-0 ${value ? 'border-[#5BBFE8] bg-[#5BBFE8]' : 'border-gray-300'}`}>
            {!!value && (
              <svg className="w-2.5 h-2.5 text-white" fill="currentColor" viewBox="0 0 20 20">
                <path fillRule="evenodd" d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z" clipRule="evenodd" />
              </svg>
            )}
          </span>
          {field.label}
        </button>
      );
      break;
    case 'date':
      control = (
        <input type="date" className={INPUT_CLS} disabled={disabled} min={field.min} max={field.max}
          value={(value as string) ?? ''} onChange={(e) => setValue(e.target.value)} />
      );
      break;
    case 'editable_table': {
      const rows = (value as Record<string, string | number>[]) ?? [];
      const update = (ri: number, ck: string, v: string, ctype?: 'text' | 'number') => {
        const next = rows.map((r, i) => i === ri ? { ...r, [ck]: ctype === 'number' ? Number(v) : v } : r);
        setValue(next);
      };
      control = (
        <div className="border border-gray-200 rounded-xl overflow-hidden">
          <table className="w-full text-xs">
            <thead className="bg-gray-50 text-gray-500">
              <tr>{field.columns.map((c) => <th key={c.key} className="px-2 py-1.5 text-left font-medium">{c.label}</th>)}</tr>
            </thead>
            <tbody>
              {rows.map((r, ri) => (
                <tr key={ri} className="border-t border-gray-100">
                  {field.columns.map((c) => (
                    <td key={c.key} className="px-1 py-1">
                      <input type={c.type === 'number' ? 'number' : 'text'} disabled={disabled}
                        className="w-full px-1.5 py-1 rounded border border-transparent hover:border-gray-200 focus:border-[#5BBFE8] outline-none bg-transparent"
                        value={(r[c.key] as string | number) ?? ''}
                        onChange={(e) => update(ri, c.key, e.target.value, c.type)} />
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
          {field.allowAddRow !== false && !disabled && (
            <button type="button"
              onClick={() => setValue([...rows, Object.fromEntries(field.columns.map((c) => [c.key, c.type === 'number' ? 0 : '']))])}
              className="w-full py-1.5 text-xs text-[#5BBFE8] hover:bg-[#F8FCFE] border-t border-gray-100">
              + 添加一行
            </button>
          )}
        </div>
      );
      break;
    }
  }

  // checkbox 自带 label，不重复渲染
  return (
    <div>
      {field.type !== 'checkbox' && label}
      {control}
      {help}
    </div>
  );
}

// ===== FormCard =====

export function FormCard({ message, onResolve, variant = 'inline' }: FormCardProps) {
  const [values, setValues] = useState<Record<string, unknown>>(() => {
    const init = { ...message.values };
    // editable_table 无 default，用 field.rows 兜底初始化
    for (const f of message.fields) {
      if (f.type === 'editable_table' && init[f.key] === undefined) init[f.key] = f.rows ?? [];
    }
    return init;
  });
  const isResolved = message.resolved;

  const missing = message.fields.filter(
    (f) => f.type !== 'static_text' && f.required && isEmpty(values[(f as { key: string }).key]),
  );
  const canSubmit = missing.length === 0;

  const handleSubmit = () => {
    if (!isResolved && canSubmit) onResolve(message.requestId, values, true);
  };
  const handleSkip = () => {
    if (!isResolved) onResolve(message.requestId, {}, false);
  };

  return (
    <div className={`rounded-2xl border p-4 text-sm transition-opacity ${
      isResolved ? 'opacity-60 bg-gray-50' : 'bg-white border-[#5BBFE8]/40 shadow-sm'
    } ${variant === 'dock' ? 'w-full' : 'max-w-[80%]'}`}>
      {/* Header */}
      <div className="flex items-center gap-2 mb-3">
        <span className="text-base">📋</span>
        <p className="font-semibold text-gray-800">{message.title}</p>
        {isResolved && (
          <span className="ml-auto text-[11px] bg-gray-100 text-gray-500 px-2 py-0.5 rounded-full">已提交</span>
        )}
      </div>

      {/* Fields */}
      <div className="space-y-3">
        {message.fields.map((f, i) => (
          <Field key={f.type === 'static_text' ? `s-${i}` : (f as { key: string }).key}
            field={f}
            value={f.type === 'static_text' ? undefined : values[(f as { key: string }).key]}
            setValue={(v) => f.type !== 'static_text' && setValues((prev) => ({ ...prev, [(f as { key: string }).key]: v }))}
            disabled={isResolved} />
        ))}
      </div>

      {/* Actions */}
      {!isResolved && (
        <div className="flex gap-2 mt-4">
          <button onClick={handleSubmit} disabled={!canSubmit}
            className="flex-1 py-2 rounded-xl bg-[#5BBFE8] hover:bg-[#3AAAD4] disabled:bg-gray-200 disabled:cursor-not-allowed text-white text-sm font-medium transition-colors">
            {canSubmit ? message.submitLabel : `还需填写 ${missing.length} 项`}
          </button>
          <button onClick={handleSkip}
            className="px-4 py-2 rounded-xl border border-gray-200 text-gray-500 text-sm hover:bg-gray-50 transition-colors">
            跳过
          </button>
        </div>
      )}
    </div>
  );
}
