/**
 * REST client. The access token lives only in memory (never localStorage); the refresh token is an
 * httpOnly cookie the browser sends to /api/auth/refresh. Exchange secrets never pass through here
 * except once, on submission to the server, over HTTPS.
 */
let accessToken: string | null = null;
let refreshing: Promise<boolean> | null = null;
const listeners = new Set<(t: string | null) => void>();

export const tokenStore = {
  get: () => accessToken,
  set(t: string | null) {
    accessToken = t;
    listeners.forEach((l) => l(t));
  },
  subscribe(l: (t: string | null) => void) {
    listeners.add(l);
    return () => listeners.delete(l);
  },
};

export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
    public code?: string,
    public details?: unknown,
  ) {
    super(message);
  }
}

async function refresh(): Promise<boolean> {
  refreshing ??= (async () => {
    try {
      const r = await fetch('/api/auth/refresh', { method: 'POST', credentials: 'include' });
      if (!r.ok) {
        tokenStore.set(null);
        return false;
      }
      const body = await r.json();
      tokenStore.set(body.accessToken);
      return true;
    } catch {
      return false;
    } finally {
      setTimeout(() => (refreshing = null), 0);
    }
  })();
  return refreshing;
}

export async function api<T = unknown>(path: string, opts: { method?: string; body?: unknown; retry?: boolean } = {}): Promise<T> {
  const headers: Record<string, string> = {};
  if (opts.body !== undefined) headers['content-type'] = 'application/json';
  if (accessToken) headers.authorization = `Bearer ${accessToken}`;
  const res = await fetch(`/api${path}`, { method: opts.method ?? 'GET', headers, credentials: 'include', body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined });
  if (res.status === 401 && opts.retry !== false && !path.startsWith('/auth/')) {
    if (await refresh()) return api<T>(path, { ...opts, retry: false });
  }
  const text = await res.text();
  const data = text ? JSON.parse(text) : {};
  if (!res.ok) throw new ApiError(res.status, data?.error?.message ?? res.statusText, data?.error?.code, data?.error?.details);
  return data as T;
}

export const tryRestoreSession = refresh;
