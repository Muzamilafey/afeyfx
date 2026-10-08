import { Schema, model } from 'mongoose';

const fillSchema = new Schema(
  {
    mode: { type: String, enum: ['PAPER', 'LIVE'], required: true, immutable: true, index: true },
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
  },
  { timestamps: true },
);
fillSchema.index({ exchange: 1, exchangeTradeId: 1, mode: 1 }, { unique: true, sparse: true });

export const Fill = model('Fill', fillSchema);
