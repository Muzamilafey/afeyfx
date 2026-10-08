/**
 * Import historical OHLCV candles from the exchange's public API into MongoDB (for backtesting).
 *   npm run import-candles -- BTC/USDT 1h 365
 */
import { connectDb, disconnectDb } from '../config/db';
import { env } from '../config/env';
import { exchangeRegistry } from '../exchanges/registry';
import { CandleStore } from '../marketData/CandleStore';
import { validateCandles } from '../marketData/candleUtils';
import { TIMEFRAMES, TIMEFRAME_MS, type Timeframe } from '../types';

async function main() {
  const [symbol, tf = '1h', daysStr = '180'] = process.argv.slice(2);
  if (!symbol || !(TIMEFRAMES as readonly string[]).includes(tf)) throw new Error('Usage: npm run import-candles -- <SYMBOL> <timeframe> <days>');
  const timeframe = tf as Timeframe;
  await connectDb();
  const adapter = exchangeRegistry.public(env.DEFAULT_EXCHANGE);
  const step = TIMEFRAME_MS[timeframe];
  let since = Date.now() - Number(daysStr) * 86_400_000;
  let total = 0;
  while (since < Date.now() - step) {
    const batch = await adapter.getCandles(symbol, timeframe, since, 1000);
    if (!batch.length) break;
    const { valid, rejected } = validateCandles(batch, timeframe);
    const r = await CandleStore.upsertMany(env.DEFAULT_EXCHANGE, symbol, timeframe, valid, 'IMPORT');
    total += r.upserted;
    const next = batch[batch.length - 1].timestamp + step;
    if (next <= since) break;
    since = next;
    process.stdout.write(`\r${symbol} ${timeframe}: ${total} new candles (rejected ${rejected.length}) up to ${new Date(since).toISOString()}`);
  }
  console.log(`\nDone: ${total} candles inserted.`);
  await exchangeRegistry.closeAll();
  await disconnectDb();
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
