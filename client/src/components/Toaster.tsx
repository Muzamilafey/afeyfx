import { createContext, useCallback, useContext, useState, type ReactNode } from 'react';
import { CircleCheck, CircleX, Info } from 'lucide-react';

type Kind = 'success' | 'error' | 'info';
interface Toast {
  id: number;
  kind: Kind;
  title: string;
  text?: string;
}

const Ctx = createContext<(kind: Kind, title: string, text?: string) => void>(() => undefined);

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const push = useCallback((kind: Kind, title: string, text?: string) => {
    const id = Date.now() + Math.random();
    setToasts((t) => [...t.slice(-3), { id, kind, title, text }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), 4500);
  }, []);
  return (
    <Ctx.Provider value={push}>
      {children}
      <div className="pointer-events-none fixed right-4 bottom-4 z-[60] flex w-80 flex-col gap-2" role="status" aria-live="polite">
        {toasts.map((t) => (
          <div key={t.id} className="pointer-events-auto flex gap-3 rounded-xl border border-slate-700 bg-slate-900 p-3 shadow-2xl">
            {t.kind === 'success' ? <CircleCheck className="shrink-0 text-emerald-400" size={20} /> : t.kind === 'error' ? <CircleX className="shrink-0 text-red-400" size={20} /> : <Info className="shrink-0 text-sky-400" size={20} />}
            <div>
              <div className="text-sm font-semibold text-slate-100">{t.title}</div>
              {t.text && <div className="text-xs text-slate-400">{t.text}</div>}
            </div>
          </div>
        ))}
      </div>
    </Ctx.Provider>
  );
}

export const useToast = () => useContext(Ctx);
