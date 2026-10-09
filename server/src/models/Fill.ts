import { Schema, model } from 'mongoose';

const fillSchema = new Schema(
  {
    mode: { type: String, enum: ['PAPER', 'LIVE', 'REAL', 'DEMO'], required: true, immutable: true, index: true },
    order: { type: Schema.Types.ObjectId, ref: 'Order', required: true, index: true },
    exchange: String,
    exchangeTradeId: { type: String },
    symbol: { type: String, required: true },
    side: { type: String, enum: ['buy', 'sell'], required: true },
    price: { type: Number, required: true },
    amount: { type: Number, required: true },
    fee: { type: Number, default: 0 },
    feeCurrency: String,
    slippage: Number,
    timestamp: { type: Date, required: true },
    /** Broker account the execution happened on (user-connected brokers). */
    connection: { type: Schema.Types.ObjectId, ref: 'BrokerConnection', index: true },
  },
  { timestamps: true },
);
fillSchema.index({ exchange: 1, exchangeTradeId: 1, mode: 1 }, { unique: true, sparse: true });

/** Executions (fills) for every mode. Also serves as the OrderExecution record for broker connections. */
export const Fill = model('Fill', fillSchema);
export const OrderExecution = Fill;
