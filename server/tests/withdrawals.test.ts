import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import * as ccxt from 'ccxt';
import { CcxtAdapter, guardAgainstWithdrawals, FORBIDDEN_METHOD_PATTERN } from '../src/exchanges/CcxtAdapter';
import { BinanceAdapter } from '../src/exchanges/BinanceAdapter';
import { BybitAdapter } from '../src/exchanges/BybitAdapter';
import { CoinbaseAdapter } from '../src/exchanges/CoinbaseAdapter';
import { runLivePreflight } from '../src/execution/LivePreflight';
import { WithdrawalForbiddenError } from '../src/utils/errors';
import { fakeCcxtClient } from './helpers/fakeExchange';

const creds = { apiKey: 'k'.repeat(16), secret: 's'.repeat(16) };

function walk(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(dir, e.name)) : [path.join(dir, e.name)]));
}

describe('withdrawal permissions are never requested or used', () => {
  it('the ExchangeAdapter implementation exposes no withdraw/transfer methods', () => {
    const a = new CcxtAdapter('binance', { testnet: true, credentials: creds, client: fakeCcxtClient() });
    const names = new Set<string>();
    for (let p: object | null = a; p && p !== Object.prototype; p = Object.getPrototypeOf(p)) for (const n of Object.getOwnPropertyNames(p)) names.add(n);
    expect([...names].filter((n) => FORBIDDEN_METHOD_PATTERN.test(n))).toEqual([]);
  });

  it('the underlying client blocks withdraw/transfer methods (unified and implicit) on a real ccxt instance', () => {
    const real = guardAgainstWithdrawals(new ccxt.binance({ apiKey: 'x', secret: 'y' }));
    const r = real as unknown as Record<string, () => unknown>;
    for (const m of ['withdraw', 'transfer', 'sapiPostCapitalWithdrawApply', 'sapiPostAssetTransfer']) {
      expect(typeof r[m]).toBe('function');
      expect(() => r[m]()).toThrow(WithdrawalForbiddenError);
    }
    // Non-withdrawal functionality still works through the guard.
    expect(real.id).toBe('binance');
  });

  it('a fake client withdraw spy is never reachable through the adapter', () => {
    const client = fakeCcxtClient();
    const a = new CcxtAdapter('binance', { testnet: true, credentials: creds, client }) as unknown as { client: Record<string, () => unknown> };
    expect(() => a.client.withdraw()).toThrow(WithdrawalForbiddenError);
    expect(() => a.client.transfer()).toThrow(WithdrawalForbiddenError);
    expect(client.withdraw).not.toHaveBeenCalled();
    expect(client.transfer).not.toHaveBeenCalled();
  });

  // The only exception: the owner's opt-in Deriv funding module (transfers between their OWN Deriv
  // accounts, with a separate payments-scope token and a fresh 2FA code). It never withdraws.
  const FUNDING_MODULE = path.join('brokers', 'deriv', 'DerivFundingService.ts');
  const FUNDING_CALLERS = [path.join('controllers', 'derivController.ts'), path.join('controllers', 'brokerConnectionController.ts')];

  it('no source file calls a withdrawal or transfer endpoint (except the reviewed Deriv funding module)', () => {
    const root = path.join(__dirname, '..', 'src');
    const offenders: string[] = [];
    for (const f of walk(root).filter((x) => x.endsWith('.ts'))) {
      const rel = path.relative(root, f);
      const src = fs.readFileSync(f, 'utf8');
      // method calls like .withdraw( / .transfer( / sapiPostCapitalWithdrawApply(
      const calls = src.match(/\.\s*\w*(withdraw|transfer)\w*\s*\(/gi) ?? [];
      const allowed = rel === FUNDING_MODULE || (FUNDING_CALLERS.includes(rel) && calls.every((c) => /derivFunding\.transfer\(|\.withdrawLink\(/.test(src) && /^\.\s*(transfer|withdrawLink)\s*\($/i.test(c.replace(/\s+/g, ''))));
      if (calls.length && !allowed) offenders.push(rel);
    }
    expect(offenders).toEqual([]);
  });

  it('the funding module is reachable only from its HTTP controllers — never from trading, strategies, AI or bots', () => {
    const root = path.join(__dirname, '..', 'src');
    const importers = walk(root)
      .filter((x) => x.endsWith('.ts') && path.relative(root, x) !== FUNDING_MODULE)
      .filter((x) => /DerivFundingService/.test(fs.readFileSync(x, 'utf8')))
      .map((x) => path.relative(root, x));
    expect(importers.sort()).toEqual([...FUNDING_CALLERS].sort());
    // The funding module itself never sends a withdrawal: cashier is deposit-only (enforced by its socket guard).
    const src = fs.readFileSync(path.join(root, FUNDING_MODULE), 'utf8');
    expect(src).not.toMatch(/cashier:\s*'withdraw'/);
    expect(src).not.toMatch(/paymentagent|p2p_/i);
  });

  it('Binance keys with withdrawals/transfers enabled are flagged', async () => {
    const client = fakeCcxtClient({ sapiGetAccountApiRestrictions: async () => ({ enableReading: true, enableSpotAndMarginTrading: true, enableWithdrawals: true, ipRestrict: true }) });
    const p = await new BinanceAdapter({ testnet: false, credentials: creds, client }).verifyPermissions();
    expect(p.verified).toBe(true);
    expect(p.canWithdraw).toBe(true);
    const ok = fakeCcxtClient({ sapiGetAccountApiRestrictions: async () => ({ enableReading: true, enableSpotAndMarginTrading: true, enableWithdrawals: false, ipRestrict: true }) });
    expect((await new BinanceAdapter({ testnet: false, credentials: creds, client: ok }).verifyPermissions()).canWithdraw).toBe(false);
  });

  it('Bybit and Coinbase withdrawal/transfer permissions are flagged', async () => {
    const bybit = fakeCcxtClient({ privateGetV5UserQueryApi: async () => ({ result: { readOnly: 0, permissions: { Spot: ['SpotTrade'], Wallet: ['AccountTransfer', 'Withdraw'] } } }) });
    expect((await new BybitAdapter({ testnet: false, credentials: creds, client: bybit }).verifyPermissions()).canWithdraw).toBe(true);
    const cb = fakeCcxtClient({ v3PrivateGetBrokerageKeyPermissions: async () => ({ can_view: true, can_trade: true, can_transfer: true }) });
    expect((await new CoinbaseAdapter({ testnet: false, credentials: creds, client: cb }).verifyPermissions()).canWithdraw).toBe(true);
  });

  it('when permissions cannot be verified, the key is treated as withdrawal-capable (fail closed)', async () => {
    const client = fakeCcxtClient({ sapiGetAccountApiRestrictions: async () => { throw new Error('network'); } });
    const p = await new BinanceAdapter({ testnet: false, credentials: creds, client }).verifyPermissions();
    expect(p.verified).toBe(false);
    expect(p.canWithdraw).toBe(true);
  });

  it('live preflight fails if the key can withdraw', async () => {
    const client = fakeCcxtClient({ sapiGetAccountApiRestrictions: async () => ({ enableReading: true, enableSpotAndMarginTrading: true, enableWithdrawals: true }) });
    const r = await runLivePreflight('binance', new BinanceAdapter({ testnet: false, credentials: creds, client }));
    expect(r.passed).toBe(false);
    expect(r.checks.find((c) => c.id === 3)!.passed).toBe(false);
  });
});
