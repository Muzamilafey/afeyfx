import { useState, type InputHTMLAttributes } from 'react';
import { Eye, EyeOff } from 'lucide-react';

export function Field({ label, id, ...props }: InputHTMLAttributes<HTMLInputElement> & { label: string; id: string }) {
  return (
    <div>
      <label htmlFor={id} className="label">
        {label}
      </label>
      <input id={id} className="input h-11" {...props} />
    </div>
  );
}

export function PasswordField({ label, id, ...props }: InputHTMLAttributes<HTMLInputElement> & { label: string; id: string }) {
  const [show, setShow] = useState(false);
  return (
    <div>
      <label htmlFor={id} className="label">
        {label}
      </label>
      <div className="relative">
        <input id={id} type={show ? 'text' : 'password'} className="input h-11 pr-10" {...props} />
        <button type="button" onClick={() => setShow((s) => !s)} className="absolute top-1/2 right-2 -translate-y-1/2 rounded p-1 text-slate-500 hover:text-slate-200" aria-label={show ? 'Hide password' : 'Show password'}>
          {show ? <EyeOff size={16} /> : <Eye size={16} />}
        </button>
      </div>
    </div>
  );
}

export function passwordChecks(pw: string) {
  return [
    { ok: pw.length >= 12, label: '12+ characters' },
    { ok: /[a-z]/.test(pw) && /[A-Z]/.test(pw), label: 'Upper & lower case' },
    { ok: /\d/.test(pw), label: 'A number' },
  ];
}

export function PasswordStrength({ password }: { password: string }) {
  const checks = passwordChecks(password);
  const score = checks.filter((c) => c.ok).length;
  const color = score === 3 ? 'bg-emerald-500' : score === 2 ? 'bg-amber-500' : 'bg-red-500';
  return (
    <div className="mt-2">
      <div className="flex gap-1">
        {[0, 1, 2].map((i) => (
          <span key={i} className={`h-1 flex-1 rounded ${i < score ? color : 'bg-slate-800'}`} />
        ))}
      </div>
      <div className="mt-1.5 flex flex-wrap gap-x-3 gap-y-1 text-[11px]">
        {checks.map((c) => (
          <span key={c.label} className={c.ok ? 'text-emerald-400' : 'text-slate-500'}>
            {c.ok ? '✓' : '○'} {c.label}
          </span>
        ))}
      </div>
    </div>
  );
}

export function SubmitButton({ busy, children, disabled }: { busy?: boolean; children: React.ReactNode; disabled?: boolean }) {
  return (
    <button type="submit" className="btn-primary h-11 w-full text-sm font-semibold" disabled={busy || disabled}>
      {busy ? <span className="h-4 w-4 animate-spin rounded-full border-2 border-white/40 border-t-white" /> : children}
    </button>
  );
}
