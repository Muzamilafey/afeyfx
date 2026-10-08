import { useEffect, useState } from 'react';
import { api } from '../services/api';
import type { AuthConfig } from '../types';

let cache: AuthConfig | null = null;

export function useAuthConfig() {
  const [cfg, setCfg] = useState<AuthConfig | null>(cache);
  useEffect(() => {
    if (cache) return;
    api<AuthConfig>('/auth/config')
      .then((c) => setCfg((cache = c)))
      .catch(() => setCfg(null));
  }, []);
  return cfg;
}

const ERRORS: Record<string, string> = {
  OAUTH_STATE: 'Sign-in session expired or was tampered with. Please try again.',
  SIGNUP_CLOSED: 'Sign-up is closed. Ask an administrator to create your account.',
  GOOGLE_EMAIL_UNVERIFIED: 'Your Google email address is not verified.',
  GITHUB_EMAIL_UNVERIFIED: 'Your GitHub primary email is not verified. Verify it on GitHub and try again.',
  GITHUB_NO_EMAIL: 'Your GitHub account has no primary email address.',
  GOOGLE_MISMATCH: 'This account is linked to a different Google account.',
  GITHUB_MISMATCH: 'This account is linked to a different GitHub account.',
  GOOGLE_CANCELLED: 'Google sign-in was cancelled.',
  GITHUB_CANCELLED: 'GitHub sign-in was cancelled.',
  GOOGLE_DISABLED: 'Google sign-in is not configured.',
  GITHUB_DISABLED: 'GitHub sign-in is not configured.',
  ACCOUNT_LOCKED: 'Account temporarily locked. Try again later.',
  INVALID_CREDENTIALS: 'This account is disabled.',
};

/** Read and clear an `#error=CODE` fragment left by an OAuth redirect. */
export function takeHashError(): string | null {
  const m = location.hash.match(/error=([A-Z_]+)/);
  if (!m) return null;
  history.replaceState(null, '', location.pathname + location.search);
  return ERRORS[m[1]] ?? 'Sign-in failed. Please try again.';
}
