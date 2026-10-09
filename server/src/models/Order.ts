import { Schema, model } from 'mongoose';

/**
 * Orders. `idempotencyKey` (== clientOrderId sent to the exchange) is unique, so a retried
 * request can never create a second order. Status is only updated from verified exchange data.
 */
const orderSchema = new Schema(
  {
    mode: { type: String, enum: ['PAPER', 'LIVE', 'REAL', 'DEMO'], required: true, immutable: true, index: true },
    user: { type: Schema.Types.ObjectId, ref: 'User' },
    idempotencyKey: { type: String, required: true, unique: true },
    exchange: { type: String, required: true },
    exchangeOrderId: { type: String, index: true },
    symbol: { type: String, required: true, index: true },
    side: { type: String, enum: ['buy', 'sell'], required: true },
    type: { type: String, enum: ['market', 'limit', 'stop_loss', 'take_profit', 'trailing_stop'], required: true },
    amount: { type: Number, required: true },
    price: Number,
    stopPrice: Number,
    trailingPct: Number,
    reduceOnly: { type: Boolean, default: false },
    status: {
      type: String,
      enum: ['PENDING', 'SUBMITTED', 'OPEN', 'PARTIALLY_FILLED', 'FILLED', 'CANCELLED', 'REJECTED', 'EXPIRED', 'UNKNOWN'],
      default: 'PENDING',
      index: true,
    },
    filled: { type: Number, default: 0 },
    averagePrice: Number,
    fee: { type: Number, default: 0 },
    feeCurrency: String,
    strategyKey: String,
    signal: { type: Schema.Types.ObjectId, ref: 'Signal' },
    aiAnalysis: { type: Schema.Types.ObjectId, ref: 'AIAnalysis' },
    riskEvaluation: Schema.Types.Mixed,
    position: { type: Schema.Types.ObjectId, ref: 'Position' },
    purpose: { type: String, enum: ['ENTRY', 'EXIT', 'STOP_LOSS', 'TAKE_PROFIT', 'MANUAL', 'EMERGENCY'], default: 'ENTRY' },
    exchangeResponses: { type: [Schema.Types.Mixed], default: [] },
    rejectReason: String,
    /** REAL-account orders: internal fill or the external broker that executed it. */
    broker: String,
    brokerRef: String,
    /** Broker account (user-connected) this record belongs to; null for the system book and internal accounts. */
    connection: { type: Schema.Types.ObjectId, ref: 'BrokerConnection', index: true },
    /** Broker-side order / deal / contract identifiers (verified with the broker). */
    brokerOrderId: String,
    attempts: { type: Number, default: 0 },
    submittedAt: Date,
    lastCheckedAt: Date,
    closedAt: Date,
  },
  { timestamps: true },
);

export const OrderModel = model('Order', orderSchema);
