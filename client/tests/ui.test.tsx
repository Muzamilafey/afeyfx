import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { ModeBanner, ModePill } from '../src/components/ModeBanner';
import { ProtectedActionButton } from '../src/components/ProtectedActionButton';
import { fmtPct, fmtSigned, pnlClass, fmtRatio } from '../src/utils/format';
import { passwordChecks } from '../src/components/auth/fields';

const authState = { user: { twoFactorEnabled: true, emailOtpEnabled: true } as Record<string, unknown> };
vi.mock('../src/hooks/useAuth', () => ({ useAuth: () => authState }));

afterEach(() => vi.restoreAllMocks());

describe('mode indicators', () => {
  it('clearly shows PAPER', () => {
    render(<ModeBanner mode="PAPER" />);
    expect(screen.getByText(/PAPER TRADING/)).toBeInTheDocument();
  });
  it('clearly shows LIVE with a real-funds warning', () => {
    render(<ModeBanner mode="LIVE" />);
    expect(screen.getByText(/REAL FUNDS AT RISK/)).toBeInTheDocument();
    render(<ModePill mode="LIVE" />);
    expect(screen.getByText('LIVE')).toBeInTheDocument();
  });
  it('emergency shutdown overrides the banner', () => {
    render(<ModeBanner mode="LIVE" emergency />);
    expect(screen.getByText(/EMERGENCY SHUTDOWN ACTIVE/)).toBeInTheDocument();
  });
});

describe('ProtectedActionButton', () => {
  it('requires a 6-digit 2FA code before submitting and sends it with the request', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('{"ok":true}', { status: 200 }));
    const onDone = vi.fn();
    render(<ProtectedActionButton label="Stop new trades" title="Stop" description="desc" endpoint="/system/emergency/stop-new-trades" onDone={onDone} />);
    fireEvent.click(screen.getByText('Stop new trades'));
    const confirm = screen.getByRole('button', { name: 'Confirm' });
    expect(confirm).toBeDisabled();
    fireEvent.change(screen.getByPlaceholderText('123456'), { target: { value: '12a34' } });
    expect(confirm).toBeDisabled();
    fireEvent.change(screen.getByPlaceholderText('123456'), { target: { value: '123456' } });
    expect(confirm).toBeEnabled();
    fireEvent.click(confirm);
    await waitFor(() => expect(onDone).toHaveBeenCalled());
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('/api/system/emergency/stop-new-trades');
    expect(JSON.parse(init.body as string)).toEqual({ totp: '123456' });
  });

  it('can use an emailed code instead of the authenticator', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('{"ok":true}', { status: 200 }));
    render(<ProtectedActionButton label="Cancel orders" title="Cancel all open orders" description="d" endpoint="/system/emergency/cancel-orders" />);
    fireEvent.click(screen.getByText('Cancel orders'));
    fireEvent.click(screen.getByRole('button', { name: /Email code/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Send code' }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expect(fetchMock.mock.calls[0][0]).toBe('/api/auth/2fa/email/send');
    fireEvent.change(screen.getByPlaceholderText('123456'), { target: { value: '654321' } });
    fireEvent.click(screen.getByRole('button', { name: 'Confirm' }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    const [url, init] = fetchMock.mock.calls[1] as [string, RequestInit];
    expect(url).toBe('/api/system/emergency/cancel-orders');
    expect(JSON.parse(init.body as string)).toEqual({ emailCode: '654321' });
  });

  it('explains how to enable a second factor when none is set up', () => {
    authState.user = { twoFactorEnabled: false, emailOtpEnabled: false };
    render(<ProtectedActionButton label="Shutdown" title="Shutdown" description="d" endpoint="/x" />);
    fireEvent.click(screen.getByText('Shutdown'));
    expect(screen.getByText(/Enable an authenticator app or email codes/)).toBeInTheDocument();
    authState.user = { twoFactorEnabled: true, emailOtpEnabled: true };
  });
});

describe('password rules (match the server)', () => {
  it('requires 12+ chars with upper, lower and a digit', () => {
    expect(passwordChecks('short').every((c) => c.ok)).toBe(false);
    expect(passwordChecks('alllowercase123').every((c) => c.ok)).toBe(false);
    expect(passwordChecks('GoodPassword123').every((c) => c.ok)).toBe(true);
  });
});

describe('formatting', () => {
  it('formats P&L honestly (signs, n/a for undefined ratios)', () => {
    expect(fmtSigned(-12.5)).toBe('-12.50');
    expect(fmtSigned(3)).toBe('+3.00');
    expect(fmtPct(0.0123)).toBe('1.23%');
    expect(fmtRatio(null)).toBe('n/a');
    expect(pnlClass(-1)).toContain('red');
    expect(pnlClass(1)).toContain('emerald');
  });
});

describe('payments & markets UI', () => {
  it('hides Withdrawal and Payments tabs until the admin enables them', async () => {
    const { MemoryRouter } = await import('react-router-dom');
    const features = await import('../src/hooks/useFeatures');
    const { AccountTabs } = await import('../src/components/AccountTabs');
    const base = { email: false, googleSignIn: false, githubSignIn: false, ai: false, telegram: false, news: false, forex: false, deposits: false, payouts: false, realTrading: false, realAccount: false };
    const spy = vi.spyOn(features, 'useFeatures').mockReturnValue({ features: base, loaded: true, reload: async () => undefined });
    const { unmount } = render(<MemoryRouter><AccountTabs /></MemoryRouter>);
    expect(screen.queryByText('Withdrawal')).toBeNull();
    expect(screen.queryByText('Payments')).toBeNull();
    expect(screen.getByText('Trades')).toBeInTheDocument();
    unmount();
    spy.mockReturnValue({ features: { ...base, deposits: true, payouts: true, realAccount: true }, loaded: true, reload: async () => undefined });
    render(<MemoryRouter><AccountTabs /></MemoryRouter>);
    expect(screen.getByText('Withdrawal')).toBeInTheDocument();
    expect(screen.getByText('Payments')).toBeInTheDocument();
  });

  it('draws two flags for forex pairs, a coin for metals and a badge for crypto', async () => {
    const { MarketIcon } = await import('../src/components/MarketIcon');
    const { container: fx } = render(<MarketIcon symbol="EUR/USD" />);
    expect(fx.querySelectorAll('svg')).toHaveLength(2);
    const { container: gold } = render(<MarketIcon symbol="XAU/USD" />);
    expect(gold.textContent).toContain('Au');
    const { container: btc } = render(<MarketIcon symbol="BTC/USDT" />);
    expect(btc.textContent).toBe('BTC');
  });

  it('formats prices with instrument precision', async () => {
    const { fmtPriceDp, fmtUsd } = await import('../src/utils/format');
    expect(fmtPriceDp(1.0862134, 5)).toBe('1.08621');
    expect(fmtPriceDp(155.4567, 3)).toBe('155.457');
    expect(fmtUsd(-12.5)).toBe('-$12.50');
  });
});
