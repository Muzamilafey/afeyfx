import { useState, type ReactNode } from 'react';
import { Modal, ErrorText } from './ui';
import { api } from '../services/api';

interface Props {
  label: ReactNode;
  title: string;
  description: ReactNode;
  endpoint: string;
  method?: string;
  className?: string;
  extraFields?: { name: string; label: string; type?: string; placeholder?: string }[];
  body?: Record<string, unknown>;
  confirmText?: string;
  onDone?(result: unknown): void;
  disabled?: boolean;
}

/**
 * A button for protected admin actions: opens a confirmation dialog that requires a fresh 2FA code
 * (and optionally extra fields such as password/confirmation phrase). Each emergency control uses its
 * own instance - they are never combined into one button.
 */
export function ProtectedActionButton({ label, title, description, endpoint, method = 'POST', className = 'btn-danger', extraFields = [], body = {}, confirmText = 'Confirm', onDone, disabled }: Props) {
  const [open, setOpen] = useState(false);
  const [totp, setTotp] = useState('');
  const [fields, setFields] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<string | null>(null);

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      const r = await api(endpoint, { method, body: { ...body, ...fields, totp } });
      setResult('Done');
      onDone?.(r);
      setTimeout(() => {
        setOpen(false);
        setResult(null);
      }, 700);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
      setTotp('');
    }
  };

  return (
    <>
      <button className={className} onClick={() => setOpen(true)} disabled={disabled}>
        {label}
      </button>
      <Modal open={open} onClose={() => setOpen(false)} title={title}>
        <div className="mb-4 text-sm text-slate-300">{description}</div>
        {extraFields.map((f) => (
          <div key={f.name} className="mb-3">
            <label className="label">{f.label}</label>
            <input className="input" type={f.type ?? 'text'} placeholder={f.placeholder} value={fields[f.name] ?? ''} onChange={(e) => setFields({ ...fields, [f.name]: e.target.value })} autoComplete="off" />
          </div>
        ))}
        <div className="mb-4">
          <label className="label">2FA code</label>
          <input className="input tracking-[0.4em]" inputMode="numeric" maxLength={6} value={totp} onChange={(e) => setTotp(e.target.value.replace(/\D/g, ''))} placeholder="123456" autoComplete="one-time-code" />
        </div>
        <ErrorText error={error} />
        {result && <div className="text-sm text-emerald-400">{result}</div>}
        <div className="mt-4 flex justify-end gap-2">
          <button className="btn-ghost" onClick={() => setOpen(false)}>
            Cancel
          </button>
          <button className={className} disabled={busy || totp.length !== 6} onClick={submit}>
            {busy ? 'Working…' : confirmText}
          </button>
        </div>
      </Modal>
    </>
  );
}
