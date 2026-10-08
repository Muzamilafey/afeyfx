import { useEffect, useState } from 'react';
import { ExternalLink, Lock, RotateCcw } from 'lucide-react';
import { Badge, Card } from '../../components/ui';
import { ProtectedActionButton } from '../../components/ProtectedActionButton';
import { useToast } from '../../components/Toaster';
import { useApi } from '../../hooks/useApi';
import { useFeatures } from '../../hooks/useFeatures';
import { api } from '../../services/api';

interface FieldView {
  key: string;
  label: string;
  type: 'string' | 'secret' | 'bool' | 'number' | 'url' | 'enum';
  options?: string[];
  placeholder?: string;
  source: 'admin' | 'env' | 'unset';
  value?: string | number | boolean;
  hint?: string;
  set: boolean;
}
interface GroupView {
  id: string;
  title: string;
  description: string;
  feature: string;
  docsUrl?: string;
  configured: boolean;
  partial: boolean;
  fields: FieldView[];
}
interface View {
  groups: GroupView[];
  envOnly: { key: string; why: string; set: boolean }[];
  callbacks: { google: string; github: string };
}

const TESTABLE = new Set(['email', 'anthropic', 'telegram', 'oanda', 'news', 'google', 'github']);

function GroupCard({ g, callbacks, onSaved }: { g: GroupView; callbacks: View['callbacks']; onSaved(): void }) {
  const toast = useToast();
  const [vals, setVals] = useState<Record<string, string | boolean>>({});
  useEffect(() => {
    setVals(Object.fromEntries(g.fields.map((f) => [f.key, f.type === 'secret' ? '' : f.type === 'bool' ? f.value === true : String(f.value ?? '')])));
  }, [g]);
  const changed = Object.fromEntries(
    g.fields
      .filter((f) => (f.type === 'secret' ? vals[f.key] !== '' : f.type === 'bool' ? vals[f.key] !== (f.value === true) : vals[f.key] !== String(f.value ?? '')))
      .map((f) => [f.key, f.type === 'number' ? String(vals[f.key]) : vals[f.key]]),
  );
  const overridden = g.fields.filter((f) => f.source === 'admin').map((f) => f.key);
  const test = async () => {
    try {
      const r = await api<{ ok: boolean; message: string }>(`/admin/integrations/${g.id}/test`, { method: 'POST' });
      toast(r.ok ? 'success' : 'error', `${g.title}: ${r.ok ? 'OK' : 'failed'}`, r.message);
    } catch (e) {
      toast('error', 'Test failed', (e as Error).message);
    }
  };
  return (
    <Card
      title={g.title}
      actions={<Badge color={g.configured ? 'green' : g.partial ? 'amber' : 'slate'}>{g.configured ? 'Active' : g.partial ? 'Incomplete' : 'Off — hidden'}</Badge>}
    >
      <p className="mb-1 text-xs text-slate-400">{g.description}</p>
      <p className="mb-3 text-[11px] text-slate-500">
        Controls: <b className="text-slate-400">{g.feature}</b>
        {g.docsUrl && (
          <a href={g.docsUrl} target="_blank" rel="noreferrer noopener" className="ml-2 inline-flex items-center gap-1 text-sky-400 hover:underline">
            Get keys <ExternalLink size={11} />
          </a>
        )}
      </p>
      <div className="grid gap-3 sm:grid-cols-2">
        {g.fields.map((f) => (
          <div key={f.key} className={f.type === 'bool' ? 'sm:col-span-2' : ''}>
            {f.type === 'bool' ? (
              <label className="flex cursor-pointer items-center justify-between rounded-lg bg-slate-950 px-3 py-2 ring-1 ring-slate-800">
                <span className="text-sm text-slate-200">{f.label}</span>
                <input type="checkbox" className="h-5 w-5 accent-emerald-500" checked={vals[f.key] === true} onChange={(e) => setVals({ ...vals, [f.key]: e.target.checked })} />
              </label>
            ) : (
              <>
                <label className="label flex items-center justify-between">
                  <span>{f.label}</span>
                  <span className="text-[10px] tracking-wide text-slate-500 uppercase">{f.source === 'admin' ? 'console' : f.source === 'env' ? '.env' : ''}</span>
                </label>
                {f.type === 'enum' ? (
                  <select className="input" value={String(vals[f.key] ?? '')} onChange={(e) => setVals({ ...vals, [f.key]: e.target.value })}>
                    {f.options!.map((o) => (
                      <option key={o}>{o}</option>
                    ))}
                  </select>
                ) : (
                  <input className="input" type={f.type === 'secret' ? 'password' : 'text'} autoComplete="off" placeholder={f.type === 'secret' ? (f.set ? `Saved ${f.hint ?? ''} — blank keeps it` : 'Not set') : f.placeholder} value={String(vals[f.key] ?? '')} onChange={(e) => setVals({ ...vals, [f.key]: e.target.value })} />
                )}
              </>
            )}
          </div>
        ))}
      </div>
      {(g.id === 'google' || g.id === 'github') && (
        <div className="mt-3 rounded-lg bg-slate-950 p-2 text-[11px] text-slate-400 ring-1 ring-slate-800">
          Authorized redirect / callback URL: <code className="text-slate-200">{g.id === 'google' ? callbacks.google : callbacks.github}</code>
        </div>
      )}
      <div className="mt-4 flex flex-wrap items-center justify-end gap-2">
        {overridden.length > 0 && (
          <ProtectedActionButton label={<span className="flex items-center gap-1"><RotateCcw size={13} /> Use .env values</span>} className="btn-ghost text-xs" title={`Reset ${g.title}`} description="Removes the values saved in the console; the server's .env values apply again." endpoint="/admin/integrations" method="PUT" body={{ reset: overridden }} confirmText="Reset" onDone={onSaved} />
        )}
        {TESTABLE.has(g.id) && (
          <button className="btn-ghost text-xs" onClick={() => void test()} disabled={!g.configured && g.id !== 'news'}>
            Test
          </button>
        )}
        <ProtectedActionButton label="Save" className="btn-primary" title={`Save ${g.title}`} description="Secrets are encrypted at rest and never shown again. Changes apply immediately." endpoint="/admin/integrations" method="PUT" body={{ values: changed }} confirmText="Save" disabled={!Object.keys(changed).length} onDone={onSaved} />
      </div>
    </Card>
  );
}

/** Every integration key from .env, editable here. Features stay hidden until their keys are set. */
export function AdminIntegrationsPage() {
  const v = useApi<View>('/admin/integrations');
  const { reload } = useFeatures();
  const toast = useToast();
  if (!v.data) return <div className="p-4 text-slate-500">Loading…</div>;
  const saved = () => {
    void v.reload();
    void reload();
    toast('success', 'Integrations updated');
  };
  return (
    <div className="space-y-4 p-4">
      <div>
        <h1 className="text-xl font-bold text-slate-50">Integrations</h1>
        <p className="text-sm text-slate-400">
          Values saved here override the server's <code>.env</code>. Anything not configured is hidden from traders and admins. M-Pesa is configured under <a href="/admin/payments" className="text-sky-400 underline">Payments</a>, brokers under <a href="/admin/brokers" className="text-sky-400 underline">Brokers</a>, exchange API keys under <a href="/admin/system" className="text-sky-400 underline">System → Exchanges</a> (they must pass the withdrawal-permission check).
        </p>
      </div>
      <div className="grid gap-4 xl:grid-cols-2">
        {v.data.groups.map((g) => (
          <GroupCard key={g.id} g={g} callbacks={v.data!.callbacks} onSaved={saved} />
        ))}
      </div>
      <Card title={<span className="flex items-center gap-2"><Lock size={15} /> Server environment only</span>}>
        <p className="mb-3 text-xs text-slate-400">These protect the platform itself and can only be set in the server's environment.</p>
        <div className="divide-y divide-slate-800 text-sm">
          {v.data.envOnly.map((e) => (
            <div key={e.key} className="flex items-center gap-3 py-2">
              <code className="w-72 shrink-0 text-xs text-slate-200">{e.key}</code>
              <span className="flex-1 text-xs text-slate-400">{e.why}</span>
              <Badge color={e.set ? 'green' : 'slate'}>{e.set ? 'set' : 'default'}</Badge>
            </div>
          ))}
        </div>
      </Card>
    </div>
  );
}
