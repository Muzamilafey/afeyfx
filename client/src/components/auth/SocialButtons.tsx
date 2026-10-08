import { GitHubIcon, GoogleIcon } from '../BrandIcons';
import type { AuthConfig } from '../../types';

/** "Continue with Google / GitHub" - full-page redirect to the server-side OAuth flow. */
export function SocialButtons({ config, label = 'Continue' }: { config: AuthConfig | null; label?: string }) {
  const google = !!config?.googleRedirectEnabled;
  const github = !!config?.githubEnabled;
  if (!google && !github) return null;
  return (
    <div className="space-y-2.5">
      {google && (
        <a href="/api/auth/google/start" className="flex h-11 w-full items-center justify-center gap-3 rounded-lg border border-slate-700 bg-slate-900 text-sm font-semibold text-slate-100 transition hover:bg-slate-800">
          <GoogleIcon /> {label} with Google
        </a>
      )}
      {github && (
        <a href="/api/auth/github/start" className="flex h-11 w-full items-center justify-center gap-3 rounded-lg bg-[#24292f] text-sm font-semibold text-white transition hover:bg-[#32383f]">
          <GitHubIcon /> {label} with GitHub
        </a>
      )}
      <div className="flex items-center gap-3 py-2 text-xs text-slate-500">
        <span className="h-px flex-1 bg-slate-800" /> or use email <span className="h-px flex-1 bg-slate-800" />
      </div>
    </div>
  );
}
