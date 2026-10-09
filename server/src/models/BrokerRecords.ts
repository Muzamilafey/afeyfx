import { Schema, model } from 'mongoose';

/** Point-in-time account figures reported by the broker. */
const snapshotSchema = new Schema(
  {
    connection: { type: Schema.Types.ObjectId, ref: 'BrokerConnection', required: true, index: true },
    user: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    balance: Number,
    equity: Number,
    margin: Number,
    freeMargin: Number,
    currency: String,
    openPositions: Number,
    at: { type: Date, default: Date.now },
  },
  { timestamps: false },
);
snapshotSchema.index({ connection: 1, at: -1 });
snapshotSchema.index({ at: 1 }, { expireAfterSeconds: 90 * 86_400 });
export const BrokerAccountSnapshotModel = model('BrokerAccountSnapshot', snapshotSchema);

/** One synchronization / reconciliation run. */
const syncLogSchema = new Schema(
  {
    connection: { type: Schema.Types.ObjectId, ref: 'BrokerConnection', required: true, index: true },
    user: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    kind: { type: String, enum: ['account', 'positions', 'instruments', 'reconcile', 'test'], required: true },
    ok: { type: Boolean, required: true },
    durationMs: Number,
    message: String,
    details: Schema.Types.Mixed,
    at: { type: Date, default: Date.now },
  },
  { timestamps: false },
);
syncLogSchema.index({ connection: 1, at: -1 });
syncLogSchema.index({ at: 1 }, { expireAfterSeconds: 30 * 86_400 });
export const BrokerSyncLogModel = model('BrokerSyncLog', syncLogSchema);

/** Connection and execution log (what the user sees under "View logs"). No secrets. */
const eventSchema = new Schema(
  {
    connection: { type: Schema.Types.ObjectId, ref: 'BrokerConnection', required: true, index: true },
    user: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    type: { type: String, required: true },
    level: { type: String, enum: ['info', 'warn', 'error'], default: 'info' },
    message: String,
    data: Schema.Types.Mixed,
    at: { type: Date, default: Date.now },
  },
  { timestamps: false },
);
eventSchema.index({ connection: 1, at: -1 });
eventSchema.index({ at: 1 }, { expireAfterSeconds: 90 * 86_400 });
export const BrokerEventModel = model('BrokerEvent', eventSchema);

/** Instruments available on a connection, with the broker's trading specification. */
const instrumentSchema = new Schema(
  {
    connection: { type: Schema.Types.ObjectId, ref: 'BrokerConnection', required: true, index: true },
    provider: String,
    brokerSymbol: { type: String, required: true },
    symbol: String,
    name: String,
    category: String,
    tradable: Boolean,
    marketOpen: Boolean,
    spec: Schema.Types.Mixed,
    updatedAt: { type: Date, default: Date.now },
  },
  { timestamps: false },
);
instrumentSchema.index({ connection: 1, brokerSymbol: 1 }, { unique: true });
export const MarketInstrumentModel = model('MarketInstrument', instrumentSchema);

/** Latest quote per connection + instrument (throttled persistence; the live stream is in memory). */
const quoteSchema = new Schema(
  {
    connection: { type: Schema.Types.ObjectId, ref: 'BrokerConnection', required: true },
    brokerSymbol: { type: String, required: true },
    symbol: String,
    bid: Number,
    ask: Number,
    last: Number,
    quoteTime: Date,
    receivedAt: { type: Date, default: Date.now },
  },
  { timestamps: false },
);
quoteSchema.index({ connection: 1, brokerSymbol: 1 }, { unique: true });
export const MarketQuoteModel = model('MarketQuote', quoteSchema);

/**
 * Explicit routing of a strategy's signals to one broker account. Nothing is ever copied to an
 * account without an assignment.
 */
const assignmentSchema = new Schema(
  {
    user: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    connection: { type: Schema.Types.ObjectId, ref: 'BrokerConnection', required: true },
    strategyKey: { type: String, required: true },
    /** Engine symbol → broker symbol, e.g. {"BTC/USDT": "cryBTCUSD"}. Signals for unmapped symbols are skipped. */
    symbolMap: { type: Map, of: String, default: {} },
    product: { type: String, enum: ['cfd', 'multiplier', 'rise_fall'], default: 'cfd' },
    multiplier: Number,
    enabled: { type: Boolean, default: false },
  },
  { timestamps: true },
);
assignmentSchema.index({ connection: 1, strategyKey: 1 }, { unique: true });
export const StrategyAccountAssignmentModel = model('StrategyAccountAssignment', assignmentSchema);

/** Verification record for a provider capability (mocked tests vs a real demo account). */
const capabilitySchema = new Schema(
  {
    provider: { type: String, required: true },
    capability: { type: String, required: true },
    verifiedOn: { type: String, enum: ['demo', 'real'], required: true },
    ok: Boolean,
    connection: { type: Schema.Types.ObjectId, ref: 'BrokerConnection' },
    message: String,
    at: { type: Date, default: Date.now },
  },
  { timestamps: false },
);
capabilitySchema.index({ provider: 1, capability: 1, verifiedOn: 1 }, { unique: true });
export const BrokerCapabilityModel = model('BrokerCapability', capabilitySchema);

/** Pending OAuth authorizations (PKCE verifier + state), short-lived. */
const oauthStateSchema = new Schema(
  {
    state: { type: String, required: true, unique: true },
    user: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    provider: { type: String, required: true },
    codeVerifierEnc: { type: String, required: true },
    /** Binds the callback to the browser that started it (cookie hash). */
    browserBindingHash: { type: String, required: true },
    /** trading = trade-scope connection; funding = separate opt-in payments-scope authorization. */
    purpose: { type: String, enum: ['trading', 'funding'], default: 'trading' },
    expiresAt: { type: Date, required: true },
  },
  { timestamps: false },
);
oauthStateSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });
export const BrokerOAuthStateModel = model('BrokerOAuthState', oauthStateSchema);

/** MT5 bridge commands queued for a terminal, and their execution reports. */
const mt5CommandSchema = new Schema(
  {
    connection: { type: Schema.Types.ObjectId, ref: 'BrokerConnection', required: true, index: true },
    commandId: { type: String, required: true, unique: true },
    type: { type: String, enum: ['order.place', 'order.cancel', 'order.modify', 'position.close'], required: true },
    params: Schema.Types.Mixed,
    status: { type: String, enum: ['QUEUED', 'DELIVERED', 'DONE', 'FAILED', 'EXPIRED'], default: 'QUEUED', index: true },
    deadline: { type: Date, required: true },
    deliveredAt: Date,
    report: Schema.Types.Mixed,
    reportedAt: Date,
  },
  { timestamps: true },
);
export const Mt5CommandModel = model('Mt5Command', mt5CommandSchema);

/** Replay protection for signed terminal requests (nonce seen once within the clock window). */
const nonceSchema = new Schema({ key: { type: String, required: true, unique: true }, expiresAt: { type: Date, required: true } }, { timestamps: false });
nonceSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });
export const BrokerNonceModel = model('BrokerNonce', nonceSchema);
