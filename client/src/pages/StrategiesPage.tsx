import { useState } from 'react';
import { Badge, Card, Empty, ErrorText, Modal } from '../components/ui';
import { ProtectedActionButton } from '../components/ProtectedActionButton';
import { useApi } from '../hooks/useApi';
import { useAuth, isAdmin } from '../hooks/useAuth';
import { api } from '../services/api';
import { fmtTime } from '../utils/format';
import type { StrategyDoc } from '../types';

const STAGES = ['RESEARCH', 'BACKTEST', 'OUT_OF_SAMPLE', 'PAPER', 'APPROVED', 'LIVE', 'RETIRED'];
const NEXT: Record<string, string[]> = {
  RESEARCH: ['BACKTEST', 'RETIRED'],
  BACKTEST: ['OUT_OF_SAMPLE', 'RESEARCH', 'RETIRED'],
  OUT_OF_SAMPLE: ['PAPER', 'BACKTEST', 'RETIRED'],
  PAPER: ['APPROVED', 'OUT_OF_SAMPLE', 'RETIRED'],
  APPROVED: ['LIVE', 'PAPER', 'RETIRED'],
  LIVE: ['PAPER', 'RETIRED'],
  RETIRED: ['RESEARCH'],
};

interface Version {
  _id: string;
  version: string;
  params: Record<string, number>;
  source: string;
  status: string;
  rationale?: string;
  createdAt: string;
}

export function StrategiesPage() {
  const { user } = useAuth();
  const admin = isAdmin(user);
  const { data, error, reload } = useApi<{ strategies: StrategyDoc[] }>('/strategies');
  const [edit, setEdit] = useState<StrategyDoc | null>(null);
  const [versionsFor, setVersionsFor] = useState<string | null>(null);
  const versions = useApi<{ versions: Version[] }>(versionsFor ? `/strategies/${versionsFor}/versions` : null, [versionsFor]);
  const [msg, setMsg] = useState<string | null>(null);

  const toggle = async (s: StrategyDoc) => {
    try {
      await api(`/strategies/${s.key}`, { method: 'PATCH', body: { enabled: !s.enabled } });
      await reload();
    } catch (e) {
      setMsg((e as Error).message);
    }
  };

  return (
    <div className="space-y-4">
      <Card title="Strategy lifecycle">
        <div className="flex flex-wrap items-center gap-1 text-xs">
          {STAGES.slice(0, 6).map((s, i) => (
            <span key={s} className="flex items-center gap-1">
              <Badge color={s === 'LIVE' ? 'red' : s === 'APPROVED' ? 'purple' : 'slate'}>{s}</Badge>
              {i < 5 && <span className="text-slate-600">→</span>}
            </span>
          ))}
        </div>
        <p className="mt-2 text-xs text-slate-500">
          Promotion requires evidence: a completed backtest, an out-of-sample walk-forward run, ≥30 paper trades, and explicit human approval (2FA) before LIVE. Changing parameters returns a LIVE strategy to PAPER. Do not enable every strategy at once.
        </p>
      </Card>
      <ErrorText error={error ?? msg} />
      <div className="grid gap-4 lg:grid-cols-2">
        {data?.strategies.map((s) => (
          <Card
            key={s.key}
            title={
              <span className="flex items-center gap-2 normal-case">
                <span className="text-sm font-semibold text-slate-100">{s.name}</span>
                <span className="text-slate-500">v{s.version}</span>
                <Badge color={s.stage === 'LIVE' ? 'red' : s.stage === 'PAPER' ? 'blue' : s.stage === 'APPROVED' ? 'purple' : 'slate'}>{s.stage}</Badge>
                <Badge color={s.enabled ? 'green' : 'slate'}>{s.enabled ? 'ENABLED' : 'DISABLED'}</Badge>
              </span>
            }
            actions={
              admin && (
                <button className={s.enabled ? 'btn-ghost' : 'btn-primary'} onClick={() => void toggle(s)} disabled={!s.enabled && s.stage === 'RESEARCH'} title={!s.enabled && s.stage === 'RESEARCH' ? 'Backtest the strategy before enabling it' : ''}>
                  {s.enabled ? 'Disable' : 'Enable'}
                </button>
              )
            }
          >
            <p className="mb-2 text-sm text-slate-300">{s.description}</p>
            <div className="grid grid-cols-2 gap-2 text-xs">
              <div><span className="text-slate-500">Symbols:</span> {s.symbols.join(', ') || '—'}</div>
              <div><span className="text-slate-500">Timeframes:</span> {s.timeframes.join(', ')}</div>
              <div><span className="text-slate-500">Risk level:</span> {s.riskLevel}</div>
              <div><span className="text-slate-500">AI confirmation:</span> {s.requireAiConfirmation ? 'required' : 'off'}</div>
              <div className="col-span-2"><span className="text-slate-500">Allowed regimes:</span> {s.allowedRegimes.join(', ')}</div>
              <div className="col-span-2"><span className="text-slate-500">Indicators:</span> {s.requiredIndicators.join(', ') || '—'}</div>
              <div className="col-span-2 font-mono text-[11px] break-all text-slate-400">{JSON.stringify(s.params)}</div>
            </div>
            <div className="mt-3 flex flex-wrap gap-2">
              {admin && <button className="btn-ghost text-xs" onClick={() => setEdit(s)}>Edit</button>}
              <button className="btn-ghost text-xs" onClick={() => setVersionsFor(s.key)}>Versions & AI proposals</button>
              {admin && (
                <button
                  className="btn-ghost text-xs"
                  onClick={async () => {
                    try {
                      const r = await api<{ status: string; error?: string }>(`/ai/review/${s.key}`, { method: 'POST' });
                      setMsg(r.status === 'OK' ? 'AI review stored as PROPOSED versions (requires backtest + paper + approval).' : `AI ${r.status}: ${r.error ?? ''}`);
                    } catch (e) {
                      setMsg((e as Error).message);
                    }
                  }}
                >
                  Ask AI to review
                </button>
              )}
              {admin &&
                NEXT[s.stage]?.map((to) => (
                  <ProtectedActionButton
                    key={to}
                    label={`→ ${to}`}
                    className={to === 'LIVE' ? 'btn-danger text-xs' : 'btn-ghost text-xs'}
                    title={`Move ${s.name} to ${to}`}
                    description={to === 'LIVE' ? 'This strategy will be eligible to trade REAL FUNDS when LIVE mode is active. Confirm only after reviewing backtest, out-of-sample and paper results.' : `Change lifecycle stage from ${s.stage} to ${to}.`}
                    endpoint={`/strategies/${s.key}/stage`}
                    body={{ stage: to }}
                    onDone={() => void reload()}
                  />
                ))}
            </div>
          </Card>
        ))}
      </div>
      {!data && !error && <Empty>Loading…</Empty>}

      <EditModal s={edit} onClose={() => setEdit(null)} onSaved={() => void reload()} />
      <Modal open={!!versionsFor} onClose={() => setVersionsFor(null)} title={`Versions · ${versionsFor}`}>
        {versions.data?.versions.length ? (
          <div className="space-y-2">
            {versions.data.versions.map((v) => (
              <div key={v._id} className="rounded border border-slate-800 p-2 text-xs">
                <div className="flex items-center gap-2">
                  <b>{v.version}</b>
                  <Badge color={v.source === 'AI_PROPOSAL' ? 'purple' : 'slate'}>{v.source}</Badge>
                  <Badge color={v.status === 'APPROVED' ? 'green' : v.status === 'REJECTED' ? 'red' : 'amber'}>{v.status}</Badge>
                  <span className="ml-auto text-slate-500">{fmtTime(v.createdAt)}</span>
                </div>
                <div className="mt-1 font-mono text-slate-400">{JSON.stringify(v.params)}</div>
                {v.rationale && <div className="mt-1 whitespace-pre-wrap text-slate-300">{v.rationale}</div>}
                {admin && v.status === 'PROPOSED' && (
                  <div className="mt-2 flex gap-2">
                    {(['APPROVED', 'REJECTED'] as const).map((d) => (
                      <ProtectedActionButton key={d} label={d === 'APPROVED' ? 'Approve for testing' : 'Reject'} className={d === 'APPROVED' ? 'btn-primary text-xs' : 'btn-ghost text-xs'} title={`${d} version ${v.version}`} description="Approving does not deploy anything. Apply the parameters via Edit and they will be re-tested from PAPER." endpoint={`/strategies/${versionsFor}/versions/${v._id}/review`} body={{ decision: d }} onDone={() => void versions.reload()} />
                    ))}
                  </div>
                )}
              </div>
            ))}
          </div>
        ) : (
          <Empty>No versions</Empty>
        )}
      </Modal>
    </div>
  );
}

function EditModal({ s, onClose, onSaved }: { s: StrategyDoc | null; onClose(): void; onSaved(): void }) {
  const [symbols, setSymbols] = useState('');
  const [timeframes, setTimeframes] = useState('');
  const [params, setParams] = useState('');
  const [ai, setAi] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [loadedFor, setLoadedFor] = useState<string | null>(null);
  if (s && loadedFor !== s.key) {
    setLoadedFor(s.key);
    setSymbols(s.symbols.join(','));
    setTimeframes(s.timeframes.join(','));
    setParams(JSON.stringify(s.params, null, 2));
    setAi(s.requireAiConfirmation);
  }
  const save = async () => {
    try {
      const p = JSON.parse(params);
      await api(`/strategies/${s!.key}`, { method: 'PATCH', body: { symbols: symbols.split(',').map((x) => x.trim()).filter(Boolean), timeframes: timeframes.split(',').map((x) => x.trim()).filter(Boolean), params: JSON.stringify(p) === JSON.stringify(s!.params) ? undefined : p, requireAiConfirmation: ai } });
      onSaved();
      onClose();
      setLoadedFor(null);
    } catch (e) {
      setError((e as Error).message);
    }
  };
  return (
    <Modal open={!!s} onClose={() => (onClose(), setLoadedFor(null))} title={`Edit ${s?.name ?? ''}`}>
      <div className="space-y-3">
        <div><label className="label">Symbols (comma separated)</label><input className="input" value={symbols} onChange={(e) => setSymbols(e.target.value)} /></div>
        <div><label className="label">Timeframes</label><input className="input" value={timeframes} onChange={(e) => setTimeframes(e.target.value)} /></div>
        <div><label className="label">Parameters (JSON) — changing these creates a new version and resets stage to PAPER</label><textarea className="input h-40 font-mono text-xs" value={params} onChange={(e) => setParams(e.target.value)} /></div>
        <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={ai} onChange={(e) => setAi(e.target.checked)} /> Require AI confirmation (veto) when AI is enabled</label>
        <ErrorText error={error} />
        <div className="flex justify-end gap-2"><button className="btn-ghost" onClick={onClose}>Cancel</button><button className="btn-primary" onClick={save}>Save</button></div>
      </div>
    </Modal>
  );
}
