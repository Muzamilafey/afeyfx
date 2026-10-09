import { Schema, model } from 'mongoose';

/**
 * A user's connection to one broker account. Owned by exactly one user; every query is scoped to
 * that user. Credentials are AES-256-GCM encrypted (ENCRYPTION_KEY) and never returned by the API.
 *
 * Trading on a connection needs `tradingEnabled`. For a REAL account it additionally needs
 * `liveEnabled` (set only through a protected confirmation) AND the server's
 * LIVE_TRADING_ENABLED=true. A connection never switches between demo and real: if the broker
 * reports a different account type than the one recorded, trading is disabled.
 */
export const CONNECTION_STATUSES = ['PENDING', 'CONNECTED', 'DISCONNECTED', 'ERROR', 'REAUTH_REQUIRED', 'REVOKED'] as const;

const riskLimits = new Schema(
  {
    maxRiskPerTrade: { type: Number, default: 0.005 },
    maxDailyLoss: { type: Number, default: 0.02 },
    maxWeeklyLoss: { type: Number, default: 0.05 },
    maxLeverage: { type: Number, default: 1 },
    maxOpenPositions: { type: Number, default: 3 },
    maxExposurePct: { type: Number, default: 0.2 },
    maxSpreadPct: { type: Number, default: 0.002 },
    maxSlippagePct: { type: Number, default: 0.003 },
    maxQuoteAgeMs: { type: Number, default: 10_000 },
    maxConsecutiveFailures: { type: Number, default: 3 },
    /** Allowed unexplained balance change before trading halts (fraction of balance). */
    balanceChangeTolerancePct: { type: Number, default: 0.01 },
  },
  { _id: false },
);

const brokerConnectionSchema = new Schema(
  {
    user: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    provider: { type: String, enum: ['deriv', 'mt5'], required: true },
    label: { type: String, default: '' },
    /** Broker account identifier (Deriv account_id, MT5 login). Stored in full server-side, masked in the API. */
    accountId: { type: String, default: '' },
    environment: { type: String, enum: ['demo', 'real'], required: true },
    currency: String,
    status: { type: String, enum: CONNECTION_STATUSES, default: 'PENDING', index: true },
    tradingEnabled: { type: Boolean, default: false },
    liveEnabled: { type: Boolean, default: false },
    liveEnabledAt: Date,
    isDefault: { type: Boolean, default: false },
    // Credentials (encrypted)
    accessTokenEnc: String,
    refreshTokenEnc: String,
    tokenType: { type: String, enum: ['oauth', 'pat', 'terminal'] },
    tokenExpiresAt: Date,
    scopes: [String],
    appId: String,
    /** Connections created by the same authorization share (and refresh) its tokens. */
    authGroup: { type: String, index: true },
    /** MT5 bridge: terminal id (public) and HMAC secret (encrypted). */
    terminalId: { type: String, index: { unique: true, sparse: true } },
    terminalSecretEnc: String,
    terminalInfo: Schema.Types.Mixed,
    // Live state
    balance: Number,
    equity: Number,
    margin: Number,
    freeMargin: Number,
    marginLevel: Number,
    leverage: Number,
    lastSyncAt: Date,
    lastHeartbeatAt: Date,
    latencyMs: Number,
    lastError: String,
    lastErrorAt: Date,
    recoveredAt: Date,
    consecutiveFailures: { type: Number, default: 0 },
    /** Per-connection circuit breaker. */
    breaker: { tripped: { type: Boolean, default: false }, reason: String, at: Date },
    riskLimits: { type: riskLimits, default: () => ({}) },
    /** Day/week anchors for drawdown limits (account currency). */
    dayStartEquity: Number,
    dayStartAt: Date,
    weekStartEquity: Number,
    weekStartAt: Date,
    disconnectedAt: Date,
  },
  { timestamps: true },
);
// One connection per broker account per user.
brokerConnectionSchema.index({ user: 1, provider: 1, accountId: 1 }, { unique: true, partialFilterExpression: { accountId: { $type: 'string', $gt: '' } } });

export const BrokerConnectionModel = model('BrokerConnection', brokerConnectionSchema);
export type BrokerConnectionDoc = InstanceType<typeof BrokerConnectionModel>;
